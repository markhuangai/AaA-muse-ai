package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/postgres"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

type workerMemory struct {
	mu          sync.Mutex
	now         time.Time
	enrollments map[[32]byte]worker.Enrollment
	workers     map[string]worker.Record
	credentials map[[32]byte]string
	fail        error
}

func newWorkerMemory() *workerMemory {
	return &workerMemory{now: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC), enrollments: map[[32]byte]worker.Enrollment{}, workers: map[string]worker.Record{}, credentials: map[[32]byte]string{}}
}
func (m *workerMemory) IssueEnrollment(_ context.Context, id string, hash [32]byte, ttl time.Duration) (worker.Enrollment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return worker.Enrollment{}, m.fail
	}
	e := worker.Enrollment{ID: id, CreatedAt: m.now, ExpiresAt: m.now.Add(ttl)}
	m.enrollments[hash] = e
	return e, nil
}
func (m *workerMemory) ConsumeEnrollment(_ context.Context, code [32]byte, id string, key [32]byte, name string) (worker.Record, worker.Enrollment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return worker.Record{}, worker.Enrollment{}, m.fail
	}
	e, ok := m.enrollments[code]
	reason := ""
	if !ok {
		reason = "enrollment_invalid"
	} else if e.ConsumedAt != nil {
		reason = "enrollment_used"
	} else if !m.now.Before(e.ExpiresAt) {
		reason = "enrollment_expired"
	}
	if reason != "" {
		return worker.Record{}, e, &worker.Rejection{Reason: reason, Enrollment: e, WorkerID: e.WorkerID, Outcome: "rolled_back"}
	}
	at := m.now
	w := worker.Record{ID: id, Name: name, RegisteredAt: at, LastContactAt: &at}
	e.ConsumedAt, e.WorkerID = &at, id
	m.enrollments[code], m.workers[id], m.credentials[key] = e, w, id
	return w, e, nil
}
func (m *workerMemory) AuthenticateWorker(_ context.Context, key [32]byte) (worker.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return worker.Record{}, m.fail
	}
	w, ok := m.workers[m.credentials[key]]
	if !ok {
		return w, &worker.Rejection{Reason: "invalid_worker_credential"}
	}
	if w.RevokedAt != nil {
		return w, &worker.Rejection{Reason: "worker_revoked", WorkerID: w.ID}
	}
	at := m.now
	w.LastContactAt = &at
	m.workers[w.ID] = w
	return w, nil
}
func (m *workerMemory) Workers(context.Context) ([]worker.Record, error) {
	if m.fail != nil {
		return nil, m.fail
	}
	result := []worker.Record{}
	for _, w := range m.workers {
		result = append(result, w)
	}
	return result, nil
}
func (m *workerMemory) RenameWorker(_ context.Context, id, name string) (worker.Record, worker.Record, error) {
	if m.fail != nil {
		return worker.Record{}, worker.Record{}, m.fail
	}
	before, ok := m.workers[id]
	if !ok {
		return before, before, &worker.Rejection{Reason: "worker_not_found"}
	}
	after := before
	after.Name = name
	m.workers[id] = after
	return before, after, nil
}
func (m *workerMemory) RevokeWorker(_ context.Context, id string) (worker.Record, worker.Record, error) {
	if m.fail != nil {
		return worker.Record{}, worker.Record{}, m.fail
	}
	w, ok := m.workers[id]
	if !ok {
		return w, w, &worker.Rejection{Reason: "worker_not_found"}
	}
	before := w
	if w.RevokedAt == nil {
		at := m.now
		w.RevokedAt = &at
		m.workers[id] = w
	}
	return before, w, nil
}

func workerFixture() (*Workers, *workerMemory, *slog.Logger, *bytes.Buffer) {
	m := newWorkerMemory()
	var out bytes.Buffer
	c := config.Defaults()
	c.Management.Key = "management-fixture"
	c.Portal.Password = "portal-fixture"
	return NewWorkers(m, auth.New(c), rand.Reader, func() time.Time { return m.now }), m, slog.New(slog.NewJSONHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug})), &out
}

func TestWorkerLifecycleAndNames(t *testing.T) {
	s, m, log, out := workerFixture()
	ctx := context.Background()
	e, code, err := s.Issue(ctx, log)
	if err != nil || e.ExpiresAt.Sub(e.CreatedAt) != 15*time.Minute || !auth.ValidToken(code, auth.EnrollmentPrefix) {
		t.Fatal("registration window/entropy failed")
	}
	w, consumed, key, err := s.Enroll(ctx, log, code)
	if err != nil || consumed.WorkerID != w.ID || consumed.ConsumedAt == nil || w.Name != "Worker "+w.ID[:8] || !auth.ValidToken(key, auth.WorkerPrefix) {
		t.Fatal("enrollment failed")
	}
	if m.credentials[auth.Digest(key)] != w.ID {
		t.Fatal("credential hash did not bind identity")
	}
	if _, _, _, err = s.Enroll(ctx, log, code); err == nil {
		t.Fatal("reused code accepted")
	}
	m.now = m.now.Add(365 * 24 * time.Hour)
	s = NewWorkers(m, s.authority, rand.Reader, s.now)
	if got, err := s.Authenticate(ctx, log, key); err != nil || got.ID != w.ID || !got.LastContactAt.Equal(m.now) {
		t.Fatal("credential expired or identity changed")
	}
	for _, name := range []string{"", "   ", "bad\nname", "\tname", strings.Repeat("😀", 101), string([]byte{0xff})} {
		if _, err := s.Rename(ctx, log, w.ID, name); err == nil {
			t.Fatal("invalid name accepted")
		}
	}
	for _, name := range []string{"A", strings.Repeat("😀", 100), "  名称　"} {
		got, err := s.Rename(ctx, log, w.ID, name)
		if err != nil || got.Name != strings.TrimSpace(name) || got.ID != w.ID || m.credentials[auth.Digest(key)] != w.ID {
			t.Fatal("rename altered identity or rejected valid Unicode")
		}
	}
	for i := 0; i < 4; i++ {
		_, code, err := s.Issue(ctx, log)
		if err != nil {
			t.Fatal(err)
		}
		other, _, _, err := s.Enroll(ctx, log, code)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.Rename(ctx, log, other.ID, "名称"); err != nil {
			t.Fatal(err)
		}
	}
	all, err := s.List(ctx, log)
	if err != nil || len(all) != 5 {
		t.Fatal("implicit worker cap or lost records")
	}
	revoked, err := s.Revoke(ctx, log, w.ID)
	if err != nil || revoked.RevokedAt == nil {
		t.Fatal("revocation not persisted")
	}
	m.now = m.now.Add(time.Hour)
	again, err := s.Revoke(ctx, log, w.ID)
	if err != nil || !again.RevokedAt.Equal(*revoked.RevokedAt) {
		t.Fatal("revocation not idempotent")
	}
	if _, err = s.Rename(ctx, log, w.ID, "renamed after revoke"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Authenticate(ctx, log, key); err == nil {
		t.Fatal("rename restored revoked authority")
	}
	if strings.Contains(out.String(), key) || strings.Contains(out.String(), code) || !strings.Contains(out.String(), "enrollment.rejected") {
		t.Fatal("service leaked bootstrap authority or omitted denial")
	}
}

func TestWorkerRejectionsAndDependencyFailures(t *testing.T) {
	s, m, log, out := workerFixture()
	ctx := context.Background()
	e, code, _ := s.Issue(ctx, log)
	m.now = e.ExpiresAt
	for _, value := range []string{"bad", auth.WorkerPrefix + strings.Repeat("A", 43), code} {
		_, _, secret, err := s.Enroll(ctx, log, value)
		if err == nil || secret != "" {
			t.Fatal("invalid/expired registration issued authority")
		}
	}
	unknown := auth.EnrollmentPrefix + strings.Repeat("A", 43)
	if _, _, _, err := s.Enroll(ctx, log, unknown); err == nil {
		t.Fatal("unknown code accepted")
	}
	if _, err := s.Authenticate(ctx, log, "bad"); err == nil {
		t.Fatal("malformed credential accepted")
	}
	if _, err := s.Authenticate(ctx, log, auth.WorkerPrefix+strings.Repeat("A", 43)); err == nil {
		t.Fatal("unknown credential accepted")
	}
	if _, err := s.Rename(ctx, log, "missing", "valid"); err == nil {
		t.Fatal("renamed missing worker")
	}
	if _, err := s.Revoke(ctx, log, "missing"); err == nil {
		t.Fatal("revoked missing worker")
	}
	m.fail = &postgres.Failure{Reason: "database_unavailable", SQLState: "57P03", Outcome: "uncertain"}
	if _, secret, err := s.Issue(ctx, log); err == nil || secret != "" {
		t.Fatal("failed issue exposed authority")
	}
	if _, _, secret, err := s.Enroll(ctx, log, code); err == nil || secret != "" {
		t.Fatal("failed transaction exposed credential")
	}
	if _, err := s.Authenticate(ctx, log, auth.WorkerPrefix+strings.Repeat("A", 43)); err == nil {
		t.Fatal("failed auth accepted")
	}
	if _, err := s.List(ctx, log); err == nil {
		t.Fatal("failed list accepted")
	}
	if _, err := s.Rename(ctx, log, "id", "valid"); err == nil {
		t.Fatal("failed rename accepted")
	}
	if _, err := s.Revoke(ctx, log, "id"); err == nil {
		t.Fatal("failed revocation accepted")
	}
	if !strings.Contains(out.String(), "worker.operation_failed") || !strings.Contains(out.String(), "uncertain") || !strings.Contains(out.String(), "57P03") {
		t.Fatal("dependency cause/outcome missing")
	}
}

func TestWorkerEntropyAndRoleCollisions(t *testing.T) {
	for _, data := range [][]byte{nil, make([]byte, 16)} {
		s, _, log, _ := workerFixture()
		s.random = bytes.NewReader(data)
		if _, secret, err := s.Issue(context.Background(), log); err == nil || secret != "" {
			t.Fatal("entropy failure ignored")
		}
		s.random = bytes.NewReader(data)
		if _, _, key, err := s.Enroll(context.Background(), log, auth.EnrollmentPrefix+strings.Repeat("A", 43)); err == nil || key != "" {
			t.Fatal("credential entropy failure ignored")
		}
	}
	s, _, log, _ := workerFixture()
	c := config.Defaults()
	c.Management.Key = config.Secret(auth.EnrollmentPrefix + strings.Repeat("A", 43))
	c.Portal.Password = "portal"
	s.authority = auth.New(c)
	s.random = bytes.NewReader(make([]byte, 48))
	if _, _, err := s.Issue(context.Background(), log); err == nil {
		t.Fatal("generated code reused management authority")
	}
	s, m, log, _ := workerFixture()
	m.fail = errors.New("dependency failed")
	if _, _, err := s.Issue(context.Background(), log); err == nil {
		t.Fatal("unclassified dependency error hidden")
	}
}
