package diagnostics

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

const pruneBatchSize = 2000

type segment struct {
	name             string
	minTime, maxTime time.Time
	size             int64
}

type segmentWriter struct {
	segment
	file       AppendFile
	syncedSize int64
}

func segmentCap(maxBytes int64) int64 {
	if maxBytes <= 64<<10 {
		return max(1, maxBytes/8)
	}
	return min(max(maxBytes/64, 4096), 2<<20)
}

func (s *Store) appendCapture(eventTime time.Time, data []byte) error {
	size := int64(len(data))
	limit := segmentCap(s.maxBytes)
	if s.active != nil && (eventTime.Before(s.active.maxTime) || s.active.size+size > limit) {
		s.sealActive()
	}
	now := time.Now()
	if s.active == nil || now.Sub(s.lastWritableCheck) >= 100*time.Millisecond {
		if err := s.files.CheckDirWritable(s.dir); err != nil {
			return err
		}
		s.lastWritableCheck = now
	}
	if s.active == nil {
		s.segmentSequence++
		name := fmt.Sprintf("segment-%020d-%s-%020d.ndjson", s.now().UnixNano(), s.instance, s.segmentSequence)
		file, err := s.files.CreateAppend(filepath.Join(s.dir, name))
		if err != nil {
			return err
		}
		s.active = &segmentWriter{segment: segment{name: name, minTime: eventTime}, file: file}
	}
	written, err := s.active.file.Write(data)
	s.active.size += int64(written)
	s.active.maxTime = eventTime
	s.retainedBytes += int64(written)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if s.active.size >= limit {
		s.sealActive()
	}
	return err
}

func (s *Store) sealActive() {
	sealed := s.active
	if sealed == nil {
		return
	}
	s.active = nil
	s.sealed = append(s.sealed, sealed)
	index := sort.Search(len(s.retained), func(index int) bool { return s.retained[index].maxTime.After(sealed.maxTime) })
	s.retained = slices.Insert(s.retained, index, sealed.segment)
	if m := s.maintenance; m != nil {
		select {
		case m.rotate <- struct{}{}:
		default:
		}
	}
}

func (s *Store) syncDirectory() error {
	dir, err := s.files.OpenRead(s.dir)
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}

func managedCapture(name string) bool {
	return strings.HasSuffix(name, ".ndjson") && (strings.HasPrefix(name, "capture-") || strings.HasPrefix(name, "segment-"))
}

func (s *Store) loadSegments() error {
	entries, err := s.files.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !managedCapture(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("capture_file_invalid")
		}
		name := filepath.Join(s.dir, entry.Name())
		legacy := strings.HasPrefix(entry.Name(), "capture-")
		if !legacy && info.Size() == 0 {
			if err := s.files.Remove(name); err != nil {
				return err
			}
			continue
		}
		file, err := s.files.OpenRead(name)
		if err != nil {
			return err
		}
		bounds, err := segmentBounds(file, info.Size(), legacy)
		if err = errors.Join(err, file.Close()); err != nil {
			return err
		}
		bounds.name = entry.Name()
		s.retained = append(s.retained, bounds)
		s.retainedBytes += bounds.size
	}
	sort.SliceStable(s.retained, func(i, j int) bool { return s.retained[i].maxTime.Before(s.retained[j].maxTime) })
	return nil
}

func recordHeader(line []byte) (Record, bool) {
	var header Record
	valid := len(line) <= MaxRecordBytes && json.Unmarshal(line, &header) == nil && header.Type == "event"
	return header, valid
}

func segmentBounds(file interface {
	io.Reader
	io.ReaderAt
}, size int64, legacy bool) (segment, error) {
	first, err := bufio.NewReaderSize(file, MaxRecordBytes).ReadSlice('\n')
	if err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, bufio.ErrBufferFull) {
			return segment{}, errors.New("capture_file_invalid")
		}
		return segment{}, err
	}
	header, valid := recordHeader(first)
	if !valid || header.Chunk != 0 {
		return segment{}, errors.New("capture_file_invalid")
	}
	bounds := segment{minTime: header.Time, maxTime: header.Time, size: size}
	if legacy || size <= int64(len(first)) {
		return bounds, nil
	}
	tail := make([]byte, min(size, 2*MaxRecordBytes))
	if _, err := file.ReadAt(tail, size-int64(len(tail))); err != nil {
		return segment{}, err
	}
	if int64(len(tail)) < size {
		_, tail, _ = bytes.Cut(tail, []byte("\n"))
	}
	if end := bytes.LastIndexByte(tail, '\n'); end >= 0 {
		for line := range bytes.SplitSeq(tail[:end+1], []byte("\n")) {
			if header, valid := recordHeader(line); valid && header.Time.After(bounds.maxTime) {
				bounds.maxTime = header.Time
			}
		}
	}
	return bounds, nil
}

func streamCaptures(source io.Reader, emit func(Record, []byte)) (bool, error) {
	reader := bufio.NewReaderSize(source, MaxRecordBytes)
	var capture []byte
	var header Record
	incomplete, started := false, false
	for {
		line, err := reader.ReadSlice('\n')
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, bufio.ErrBufferFull) {
				return false, err
			}
			if !started {
				return false, errors.New("capture_file_invalid")
			}
			return incomplete || len(line) > 0 || len(capture) > 0, nil
		}
		record, valid := recordHeader(line)
		if !valid || (!started && record.Chunk != 0) {
			if !started {
				return false, errors.New("capture_file_invalid")
			}
			return true, nil
		}
		started = true
		if record.Chunk == 0 {
			incomplete = incomplete || len(capture) != 0
			capture, header = nil, record
		} else if len(capture) == 0 {
			incomplete = true
			continue
		}
		capture = append(capture, line...)
		if record.Chunk == header.Chunks-1 {
			if _, err := validateCapture(capture); err != nil {
				incomplete = true
			} else {
				emit(header, capture)
			}
			capture = nil
		}
	}
}

func (s *Store) pruneBatch() ([]segment, retentionState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.now().Add(-s.retention)
	if s.active != nil && (s.active.maxTime.Before(cutoff) || (s.retainedBytes > s.maxBytes &&
		(len(s.retained) == 0 || s.active.maxTime.Before(s.retained[len(s.retained)-1].maxTime)))) {
		s.sealActive()
	}
	state, remaining := s.state, s.retainedBytes
	for index, oldest := range s.retained {
		if remaining <= s.maxBytes && !oldest.maxTime.Before(cutoff) {
			return slices.Clone(s.retained[:index]), state, false
		}
		if index == pruneBatchSize {
			return slices.Clone(s.retained[:index]), state, true
		}
		remaining -= oldest.size
		if oldest.maxTime.After(state.PrunedThrough) {
			state.PrunedThrough = oldest.maxTime
		}
	}
	return slices.Clone(s.retained), state, false
}

func (s *Store) prune() (bool, error) {
	s.pruneMu.Lock()
	defer s.pruneMu.Unlock()
	victims, state, more := s.pruneBatch()
	if len(victims) == 0 {
		return false, nil
	}
	if err := s.saveState(state); err != nil {
		return false, err
	}
	removed := make(map[string]bool, len(victims))
	var removeErr error
	for _, old := range victims {
		if err := s.files.Remove(filepath.Join(s.dir, old.name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			removeErr = err
			break
		}
		removed[old.name] = true
	}
	s.mu.Lock()
	s.state = state
	s.retained = slices.DeleteFunc(s.retained, func(old segment) bool {
		if removed[old.name] {
			s.retainedBytes -= old.size
			return true
		}
		return false
	})
	s.mu.Unlock()
	return more, removeErr
}

type maintenance struct {
	stop, done chan struct{}
	rotate     chan struct{}
	prune      chan chan error
}

func (s *Store) StartMaintenance(interval time.Duration, onFailure func(error)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.maintenance != nil {
		return
	}
	m := &maintenance{stop: make(chan struct{}), done: make(chan struct{}), rotate: make(chan struct{}, 1), prune: make(chan chan error)}
	s.maintenance = m
	go s.maintain(m, interval, onFailure)
}

func (s *Store) maintain(m *maintenance, interval time.Duration, onFailure func(error)) {
	defer close(m.done)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		var err error
		select {
		case <-m.stop:
			return
		case result := <-m.prune:
			_, err = s.prune()
			result <- err
		case <-m.rotate:
			err = s.flush(false)
		case <-ticker.C:
			if err = s.files.CheckDirWritable(s.dir); err == nil {
				err = s.Flush()
			}
			if err == nil {
				_, err = s.prune()
			}
		}
		s.mu.Lock()
		if s.failedErr == nil {
			s.failedErr = err
		}
		err = s.failedErr
		s.mu.Unlock()
		if err != nil {
			onFailure(err)
			return
		}
	}
}

func (s *Store) pruneForSnapshot() error {
	s.mu.Lock()
	m, closed, failed := s.maintenance, s.closed, s.failedErr
	s.mu.Unlock()
	if closed {
		return fs.ErrClosed
	}
	if failed != nil {
		return failed
	}
	if m == nil {
		_, err := s.prune()
		return err
	}
	result := make(chan error, 1)
	select {
	case m.prune <- result:
		return <-result
	case <-m.done:
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.failedErr != nil {
			return s.failedErr
		}
		return fs.ErrClosed
	}
}

func (s *Store) Flush() error { return s.flush(true) }

func (s *Store) flush(includeActive bool) error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	s.mu.Lock()
	sealed := s.sealed
	s.sealed = nil
	active := s.active
	var offset int64
	if active != nil {
		offset = active.size
	}
	s.mu.Unlock()
	var err error
	dirDirty := false
	for _, writer := range sealed {
		if writer.syncedSize != writer.size {
			err = errors.Join(err, writer.file.Sync())
			dirDirty = dirDirty || writer.syncedSize == 0
		}
		err = errors.Join(err, writer.file.Close())
	}
	if includeActive && active != nil && offset != active.syncedSize {
		if syncErr := active.file.Sync(); syncErr != nil {
			err = errors.Join(err, syncErr)
		} else {
			dirDirty = dirDirty || active.syncedSize == 0
			active.syncedSize = offset
		}
	}
	if dirDirty {
		err = errors.Join(err, s.syncDirectory())
	}
	return err
}

func (s *Store) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		m := s.maintenance
		s.mu.Unlock()
		if m != nil {
			close(m.stop)
			<-m.done
		}
		s.mu.Lock()
		s.sealActive()
		failure := s.failedErr
		s.mu.Unlock()
		s.closeErr = errors.Join(failure, s.Flush())
		for {
			more, err := s.prune()
			s.closeErr = errors.Join(s.closeErr, err)
			if err != nil || !more {
				break
			}
		}
	})
	return s.closeErr
}
