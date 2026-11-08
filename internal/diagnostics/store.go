package diagnostics

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"sync"
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
	mu            sync.Mutex
	files         Files
	dir, instance string
	now           func() time.Time
	retention     time.Duration
	maxBytes      int64
	sequence      uint64
	state         retentionState
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
	if err = s.saveState(); err != nil {
		return nil, err
	}
	if err = s.prune(); err != nil {
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
	return s.files.Rename(p+".tmp", p)
}
func (s *Store) saveState() error {
	b, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	return s.atomic("retention.json", b)
}

func (s *Store) Write(payload []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.sequence++
	id := fmt.Sprintf("%020d-%s-%020d", s.now().UnixNano(), s.instance, s.sequence)
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
	if err := s.atomic("capture-"+id+".ndjson", output.Bytes()); err != nil {
		return 0, err
	}
	if err := s.prune(); err != nil {
		return 0, err
	}
	return len(payload), nil
}

func (s *Store) captures() ([]fs.DirEntry, error) {
	entries, err := s.files.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	var captures []fs.DirEntry
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "capture-") && strings.HasSuffix(e.Name(), ".ndjson") {
			if !e.Type().IsRegular() {
				return nil, errors.New("capture_file_invalid")
			}
			captures = append(captures, e)
		}
	}
	sort.Slice(captures, func(i, j int) bool { return captures[i].Name() < captures[j].Name() })
	return captures, nil
}

func (s *Store) prune() error {
	entries, err := s.captures()
	if err != nil {
		return err
	}
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			return err
		}
		total += info.Size()
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			return err
		}
		b, err := s.files.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			return err
		}
		line, _, _ := bytes.Cut(b, []byte("\n"))
		var r Record
		if json.Unmarshal(line, &r) != nil {
			return errors.New("capture_file_invalid")
		}
		if total <= s.maxBytes && !r.Time.Before(s.now().Add(-s.retention)) {
			continue
		}
		if r.Time.After(s.state.PrunedThrough) {
			s.state.PrunedThrough = r.Time
		}
		if err = s.saveState(); err != nil {
			return err
		}
		if err = s.files.Remove(filepath.Join(s.dir, e.Name())); err != nil {
			return err
		}
		total -= info.Size()
	}
	return nil
}

func (s *Store) Snapshot(filter Filter) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.prune(); err != nil {
		return Snapshot{}, err
	}
	result := Snapshot{Metadata: Metadata{Type: "export", Complete: true, CreatedAt: s.state.CreatedAt, SnapshotAt: s.now().UTC(), PrunedThrough: s.state.PrunedThrough, Omissions: []string{}}}
	missing := func(reason string) {
		result.Metadata.Complete = false
		result.Metadata.Omissions = append(result.Metadata.Omissions, reason)
	}
	if (!filter.Since.IsZero() && filter.Since.Before(s.state.CreatedAt)) || (!filter.Until.IsZero() && filter.Until.Before(s.state.CreatedAt)) {
		missing("requested_interval_precedes_capture")
	}
	if filter.Since.After(result.Metadata.SnapshotAt) || filter.Until.After(result.Metadata.SnapshotAt) {
		missing("requested_interval_extends_after_snapshot")
	}
	if !s.state.PrunedThrough.IsZero() && (filter.Since.IsZero() || !filter.Since.After(s.state.PrunedThrough)) {
		result.Metadata.Complete = false
		result.Metadata.Omissions = append(result.Metadata.Omissions, "expired_or_capacity_pruned_evidence")
	}
	entries, err := s.captures()
	if err != nil {
		return Snapshot{}, err
	}
	for _, e := range entries {
		b, err := s.files.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			return Snapshot{}, err
		}
		records, err := validateCapture(b)
		if err != nil {
			result.Metadata.Complete = false
			result.Metadata.Omissions = append(result.Metadata.Omissions, "incomplete_capture:"+e.Name())
			continue
		}
		r := records[0]
		if (!filter.Since.IsZero() && r.Time.Before(filter.Since)) || (!filter.Until.IsZero() && r.Time.After(filter.Until)) || (filter.RequestID != "" && r.RequestID != filter.RequestID) || (filter.OperationID != "" && r.OperationID != filter.OperationID) {
			continue
		}
		result.Records = append(result.Records, b)
		result.Metadata.Captures++
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
