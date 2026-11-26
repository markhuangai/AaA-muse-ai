package diagnostics

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const MaxRecordBytes = 6 * 1024

type Record struct {
	Type        string    `json:"type"`
	Time        time.Time `json:"time"`
	Event       string    `json:"event"`
	Level       string    `json:"level"`
	InstanceID  string    `json:"instance_id"`
	OperationID string    `json:"operation_id,omitempty"`
	RequestID   string    `json:"request_id,omitempty"`
	CaptureID   string    `json:"capture_id"`
	Chunk       int       `json:"chunk"`
	Chunks      int       `json:"chunks"`
	SHA256      string    `json:"payload_sha256"`
	Data        string    `json:"data_base64"`
}

type Filter struct {
	Since, Until           time.Time
	RequestID, OperationID string
}
type Metadata struct {
	Type          string    `json:"type"`
	Complete      bool      `json:"complete"`
	CreatedAt     time.Time `json:"created_at"`
	SnapshotAt    time.Time `json:"snapshot_at"`
	PrunedThrough time.Time `json:"pruned_through,omitempty"`
	Omissions     []string  `json:"omissions"`
	Captures      int       `json:"captures"`
}
type Snapshot struct {
	Metadata Metadata
	Records  [][]byte
}
type retentionState struct {
	CreatedAt     time.Time `json:"created_at"`
	PrunedThrough time.Time `json:"pruned_through"`
}
type Store struct {
	mu, pruneMu, syncMu sync.Mutex
	files               Files
	dir, instance       string
	now                 func() time.Time
	retention           time.Duration
	maxBytes            int64
	captureSequence     atomic.Uint64
	segmentSequence     uint64
	state               retentionState
	retained            []segment
	retainedBytes       int64
	active              *segmentWriter
	sealed              []*segmentWriter
	lastWritableCheck   time.Time
	failedErr           error
	closed              bool
	closeOnce           sync.Once
	closeErr            error
	maintenance         *maintenance
}

func Open(files Files, dir, instance string, now func() time.Time, retention time.Duration, maxBytes int64) (*Store, error) {
	if err := files.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := files.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return nil, errors.New("capture_directory_invalid")
	}
	if err = files.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	s := &Store{files: files, dir: dir, instance: instance, now: now, retention: retention, maxBytes: maxBytes, state: retentionState{CreatedAt: now().UTC()}}
	b, err := files.ReadFile(filepath.Join(dir, "retention.json"))
	if err == nil {
		if err = json.Unmarshal(b, &s.state); err != nil {
			return nil, errors.New("capture_state_invalid")
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if errors.Is(err, fs.ErrNotExist) {
		if err = s.saveState(s.state); err != nil {
			return nil, err
		}
	}
	if err = s.loadSegments(); err != nil {
		return nil, err
	}
	if _, err = s.prune(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) atomic(name string, b []byte) error {
	p := filepath.Join(s.dir, name)
	if err := s.files.WriteFile(p+".tmp", b, 0600); err != nil {
		return err
	}
	if err := s.files.Chmod(p+".tmp", 0600); err != nil {
		return err
	}
	if err := s.files.Rename(p+".tmp", p); err != nil {
		return err
	}
	return s.syncDirectory()
}
func (s *Store) saveState(state retentionState) error {
	b, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return s.atomic("retention.json", b)
}

func (s *Store) Write(payload []byte) (int, error) {
	var event struct {
		Time        time.Time `json:"time"`
		Message     string    `json:"msg"`
		Level       string    `json:"level"`
		InstanceID  string    `json:"instance_id"`
		OperationID string    `json:"operation_id"`
		RequestID   string    `json:"request_id"`
	}
	if err := json.Unmarshal(payload, &event); err != nil {
		return 0, errors.New("capture_event_invalid")
	}
	id := fmt.Sprintf("%020d-%s-%020d", s.now().UnixNano(), s.instance, s.captureSequence.Add(1))
	h := sha256.Sum256(payload)
	count := (len(payload) + 2047) / 2048
	var output bytes.Buffer
	for i := 0; i < count; i++ {
		end := min((i+1)*2048, len(payload))
		r := Record{Type: "event", Time: event.Time, Event: event.Message, Level: event.Level, InstanceID: event.InstanceID, OperationID: event.OperationID, RequestID: event.RequestID, CaptureID: id, Chunk: i, Chunks: count, SHA256: hex.EncodeToString(h[:]), Data: base64.StdEncoding.EncodeToString(payload[i*2048 : end])}
		b, err := json.Marshal(r)
		if err != nil {
			return 0, err
		}
		if len(b)+1 > MaxRecordBytes {
			return 0, errors.New("capture_metadata_too_large")
		}
		output.Write(b)
		output.WriteByte('\n')
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, fs.ErrClosed
	}
	if s.failedErr != nil {
		return 0, s.failedErr
	}
	if err := s.appendCapture(event.Time, output.Bytes()); err != nil {
		s.failedErr = err
		return 0, err
	}
	return len(payload), nil
}

func (s *Store) snapshotEntries() (Metadata, []segment, bool) {
	s.pruneMu.Lock()
	defer s.pruneMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC()
	cutoff := now.Add(-s.retention)
	if s.retainedBytes > s.maxBytes || (len(s.retained) != 0 && s.retained[0].maxTime.Before(cutoff)) ||
		(s.active != nil && s.active.maxTime.Before(cutoff)) {
		return Metadata{}, nil, false
	}
	metadata := Metadata{Type: "export", Complete: true, CreatedAt: s.state.CreatedAt, SnapshotAt: now, PrunedThrough: s.state.PrunedThrough, Omissions: []string{}}
	entries := append([]segment(nil), s.retained...)
	if s.active != nil {
		entries = append(entries, s.active.segment)
	}
	return metadata, entries, true
}

func (s *Store) Snapshot(filter Filter) (Snapshot, error) {
	var metadata Metadata
	var entries []segment
	for {
		if err := s.pruneForSnapshot(); err != nil {
			return Snapshot{}, err
		}
		var ready bool
		metadata, entries, ready = s.snapshotEntries()
		if ready {
			break
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })
	result := Snapshot{Metadata: metadata}
	missing := func(reason string) {
		result.Metadata.Complete = false
		result.Metadata.Omissions = append(result.Metadata.Omissions, reason)
	}
	if (!filter.Since.IsZero() && filter.Since.Before(metadata.CreatedAt)) || (!filter.Until.IsZero() && filter.Until.Before(metadata.CreatedAt)) {
		missing("requested_interval_precedes_capture")
	}
	if filter.Since.After(result.Metadata.SnapshotAt) || filter.Until.After(result.Metadata.SnapshotAt) {
		missing("requested_interval_extends_after_snapshot")
	}
	if !metadata.PrunedThrough.IsZero() && (filter.Since.IsZero() || !filter.Since.After(metadata.PrunedThrough)) {
		result.Metadata.Complete = false
		result.Metadata.Omissions = append(result.Metadata.Omissions, "expired_or_capacity_pruned_evidence")
	}
	for _, entry := range entries {
		file, err := s.files.OpenRead(filepath.Join(s.dir, entry.name))
		if errors.Is(err, fs.ErrNotExist) {
			missing("capture_removed_during_export:" + entry.name)
			continue
		}
		if err != nil {
			return Snapshot{}, err
		}
		incomplete, err := streamCaptures(io.LimitReader(file, entry.size), func(r Record, capture []byte) {
			if (!filter.Since.IsZero() && r.Time.Before(filter.Since)) || (!filter.Until.IsZero() && r.Time.After(filter.Until)) || (filter.RequestID != "" && r.RequestID != filter.RequestID) || (filter.OperationID != "" && r.OperationID != filter.OperationID) {
				return
			}
			result.Records = append(result.Records, capture)
			result.Metadata.Captures++
		})
		err = errors.Join(err, file.Close())
		if err != nil {
			return Snapshot{}, err
		}
		if incomplete {
			missing("incomplete_capture:" + entry.name)
		}
	}
	if result.Metadata.Captures == 0 && (filter.RequestID != "" || filter.OperationID != "") {
		missing("requested_identity_not_captured_in_interval")
	}
	return result, nil
}

func validateCapture(b []byte) ([]Record, error) {
	var records []Record
	var payload bytes.Buffer
	for _, line := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
		var r Record
		if len(line)+1 > MaxRecordBytes || json.Unmarshal(line, &r) != nil || r.Chunk != len(records) || r.Type != "event" {
			return nil, errors.New("invalid_chunk")
		}
		if len(records) > 0 && (r.CaptureID != records[0].CaptureID || r.Chunks != records[0].Chunks || r.SHA256 != records[0].SHA256) {
			return nil, errors.New("inconsistent_chunks")
		}
		decoded, err := base64.StdEncoding.DecodeString(r.Data)
		if err != nil {
			return nil, err
		}
		payload.Write(decoded)
		records = append(records, r)
	}
	if len(records) == 0 || records[0].Chunks != len(records) {
		return nil, errors.New("missing_chunks")
	}
	h := sha256.Sum256(payload.Bytes())
	if hex.EncodeToString(h[:]) != records[0].SHA256 {
		return nil, errors.New("payload_mismatch")
	}
	return records, nil
}

func (r *Redactor) WorkerCapture(capture string, decoded bool) (string, error) {
	if decoded {
		safe, err := r.JSON(json.RawMessage(capture))
		if err != nil {
			return "", err
		}
		return string(safe) + "\n", nil
	}
	records, err := validateCapture([]byte(capture))
	if err != nil {
		return "", err
	}
	var payload bytes.Buffer
	for _, record := range records {
		part, err := base64.StdEncoding.DecodeString(record.Data)
		if err != nil {
			return "", err
		}
		payload.Write(part)
	}
	safe, err := r.JSON(payload.Bytes())
	if err != nil {
		return "", err
	}
	header := records[0]
	header.Event, header.InstanceID, header.CaptureID = r.Text(header.Event), r.Text(header.InstanceID), r.Text(header.CaptureID)
	header.OperationID, header.RequestID = r.Text(header.OperationID), r.Text(header.RequestID)
	header.Chunks = (len(safe) + 2047) / 2048
	sum := sha256.Sum256(safe)
	header.SHA256 = hex.EncodeToString(sum[:])
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	for i := range header.Chunks {
		header.Chunk = i
		header.Data = base64.StdEncoding.EncodeToString(safe[i*2048 : min((i+1)*2048, len(safe))])
		before := output.Len()
		if err := encoder.Encode(header); err != nil {
			return "", err
		}
		if output.Len()-before > MaxRecordBytes {
			return "", errors.New("capture_metadata_too_large")
		}
	}
	return output.String(), nil
}
