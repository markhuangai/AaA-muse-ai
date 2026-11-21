package service

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/sqlite"
)

func TestSQLiteUpgradeReservationFencesCompetingBrokers(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "broker.sqlite3")
	open := func() *sqlite.Repository {
		repo, err := sqlite.Open(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(repo.Close)
		if err := repo.Bootstrap(ctx); err != nil {
			t.Fatal(err)
		}
		return repo
	}
	first, second := open(), open()
	_, logmem, logger, _ := inferenceFixture()
	var code, key [32]byte
	code[0], key[0] = 1, 2
	if _, err := first.IssueEnrollment(ctx, "enrollment", code, time.Minute); err != nil {
		t.Fatal(err)
	}
	const worker = "worker-a"
	if _, _, err := first.ConsumeEnrollment(ctx, code, worker, key, "Worker A"); err != nil {
		t.Fatal(err)
	}
	broker, sibling := NewBroker(first, rand.Reader, time.Now, nil), NewBroker(second, rand.Reader, time.Now, nil)
	connection := connectInference(t, broker, logmem, logger, worker)
	history := []inference.Qualification{{ID: "archived", WorkerID: worker, ConnectionGeneration: connection.Generation,
		Input: inference.QualificationInput{Action: "withdraw", EvidenceReference: "retained history"}}}
	if err := first.WithinInference(ctx, inference.Ref{WorkerID: worker, UpdateRouting: true}, func(s *inference.State) error {
		s.Routing.Qualifications = history
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	acquire := UpgradeInput{Version: 1, Action: "acquire", OperationID: "prepare"}
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	var reservation inference.UpgradeReservation
	var reserveErr, requestErr error
	var admitted inference.RequestView
	go func() {
		defer wg.Done()
		<-start
		var data json.RawMessage
		data, reserveErr = broker.UpgradeReservation(ctx, logger, worker, acquire)
		if reserveErr == nil {
			reserveErr = json.Unmarshal(data, &reservation)
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		admitted, requestErr = sibling.SubmitRequest(ctx, logger, "alice", "", autoInput("racing-request"))
	}()
	close(start)
	wg.Wait()
	if requestErr != nil {
		t.Fatal(requestErr)
	}
	if reserveErr != nil {
		requireInferenceReason(t, reserveErr, "worker_busy")
		if admitted.WorkerID != worker {
			t.Fatal("reservation refused without a queued assignment", admitted)
		}
	} else {
		if admitted.WorkerID != "" || reservation.Generation != 1 {
			t.Fatal("leased slot was assigned", admitted, reservation)
		}
		data, err := sibling.UpgradeReservation(ctx, logger, worker, acquire)
		if replay := decodeResult[inference.UpgradeReservation](t, data, err); !reflect.DeepEqual(replay, reservation) {
			t.Fatal("acquire replay extended or replaced the lease")
		}
		if err := broker.Disconnect(ctx, logger, worker, connection.ID, connection.Generation); err != nil {
			t.Fatal(err)
		}
		connection = connectInference(t, sibling, logmem, logger, worker)
		_, err = sibling.Create(ctx, logger, inference.Create{Version: 1, SubmissionID: "targeted", WorkerID: worker,
			Messages: []inference.Item{{Type: "message", Role: "user", Text: "targeted"}}, Tools: []inference.Tool{}})
		requireInferenceReason(t, err, "worker_upgrading")
		if _, err := sibling.UpgradeReservation(ctx, logger, worker, UpgradeInput{Version: 1, Action: "release", OperationID: "prepare", Generation: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if err := sibling.Dispatch(ctx, logger); err != nil {
		t.Fatal(err)
	}
	data, err := sibling.Read(ctx, logger, admitted.ID)
	exp := decodeResult[inference.Experiment](t, data, err)
	claim := inference.Claim{Version: 1, SubmissionID: "racing-claim", ConnectionID: connection.ID, ConnectionGeneration: connection.Generation}
	parallel := UpgradeInput{Version: 1, Action: "acquire", OperationID: "while-claiming",
		Generation: reservation.Generation}
	start = make(chan struct{})
	var claimed json.RawMessage
	var claimErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		claimed, claimErr = sibling.Claim(ctx, logger, worker, exp.CurrentJobID, claim)
	}()
	go func() {
		defer wg.Done()
		<-start
		_, reserveErr = broker.UpgradeReservation(ctx, logger, worker, parallel)
	}()
	close(start)
	wg.Wait()
	requireInferenceReason(t, reserveErr, "worker_busy")
	job := decodeResult[inference.Job](t, claimed, claimErr)
	if job.Qualification != nil {
		t.Fatal("new assignment inherited qualification")
	}
	oldJob := history[0]
	if err = second.WithinInference(ctx, inference.Ref{WorkerID: worker, JobID: job.ID}, func(s *inference.State) error {
		s.Jobs[job.ID].Qualification = &oldJob
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	final := submission(job, connection, "racing-final", inference.Item{Type: "final", Text: "pong"})
	data, err = sibling.Decide(ctx, logger, worker, job.ID, final)
	decodeResult[inference.Experiment](t, data, err)
	reopened := NewBroker(open(), rand.Reader, time.Now, nil)
	replay, err := reopened.Decide(ctx, logger, worker, job.ID, final)
	if err != nil || string(replay) != string(data) {
		t.Fatal("reopened broker failed to replay exact receipt", err)
	}
	data, err = reopened.Job(ctx, logger, worker, job.ID)
	old := decodeResult[inference.Job](t, data, err)
	status, err := reopened.Projection(ctx, logger, worker, true)
	if err != nil || old.Qualification == nil || old.Qualification.ID != oldJob.ID ||
		status.InferenceReadiness != "withdrawn" || !reflect.DeepEqual(status.QualificationHistory, history) {
		t.Fatal("legacy assignment or historical qualification lost", err, status)
	}
	expiring := UpgradeInput{Version: 1, Action: "acquire", OperationID: "expires", Generation: status.UpgradeGeneration}
	data, err = reopened.UpgradeReservation(ctx, logger, worker, expiring)
	expires := decodeResult[inference.UpgradeReservation](t, data, err)
	if err := second.WithinInference(ctx, inference.Ref{WorkerID: worker, UpdateRouting: true}, func(s *inference.State) error {
		past := s.Now.Add(-time.Second)
		s.Routing.Upgrade.ExpiresAt = &past
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	_, err = reopened.UpgradeReservation(ctx, logger, worker, UpgradeInput{Version: 1, Action: "renew", OperationID: expiring.OperationID, Generation: expires.Generation})
	requireInferenceReason(t, err, "upgrade_reservation_fenced")
	_, err = reopened.UpgradeReservation(ctx, logger, worker, expiring)
	requireInferenceReason(t, err, "upgrade_reservation_conflict")
	next, err := sibling.SubmitRequest(ctx, logger, "alice", "", autoInput("after-expiry"))
	if err != nil || next.WorkerID != worker {
		t.Fatal("expiry did not release the slot", next, err)
	}
}

func TestUpgradeRejectsUnresolvedToolWorkAndFencesOldOperations(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	ctx := t.Context()
	const worker = "worker-a"
	c := connectInference(t, b, m, logger, worker)
	e := createInference(t, b, logger, worker, "experiment", 300)
	j := claimInference(t, b, logger, c, e, "claim-tool")
	data, err := b.Decide(ctx, logger, worker, j.ID, submission(j, c, "offer-tool", inference.Item{Type: "tool_call",
		CallID: "call", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}))
	decodeResult[inference.Experiment](t, data, err)
	acquire := UpgradeInput{Version: 1, Action: "acquire", OperationID: "first"}
	_, err = b.UpgradeReservation(ctx, logger, worker, acquire)
	requireInferenceReason(t, err, "worker_busy")
	_, err = b.Cancel(ctx, logger, e.ID, inference.Cancel{Version: 1, SubmissionID: "cancel-tool"})
	if err != nil {
		t.Fatal(err)
	}
	data, err = b.UpgradeReservation(ctx, logger, worker, acquire)
	lease := decodeResult[inference.UpgradeReservation](t, data, err)
	m.now = m.now.Add(time.Second)
	data, err = b.UpgradeReservation(ctx, logger, worker, UpgradeInput{Version: 1, Action: "renew", OperationID: "first", Generation: 1})
	renewed := decodeResult[inference.UpgradeReservation](t, data, err)
	if !renewed.ExpiresAt.After(*lease.ExpiresAt) {
		t.Fatal("renewal failed")
	}
	release := UpgradeInput{Version: 1, Action: "release", OperationID: "first", Generation: 1}
	for range 2 {
		data, err = b.UpgradeReservation(ctx, logger, worker, release)
		if decodeResult[inference.UpgradeReservation](t, data, err).ExpiresAt != nil {
			t.Fatal("release retained a current lease")
		}
	}
	_, err = b.UpgradeReservation(ctx, logger, worker, UpgradeInput{Version: 1, Action: "acquire", OperationID: "second", Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = b.UpgradeReservation(ctx, logger, worker, release)
	requireInferenceReason(t, err, "upgrade_reservation_fenced")
	_, err = b.UpgradeReservation(ctx, logger, worker, acquire)
	requireInferenceReason(t, err, "upgrade_reservation_conflict")
	m.states[worker].Revoked = true
	_, err = b.UpgradeReservation(ctx, logger, worker, UpgradeInput{Version: 1, Action: "release", OperationID: "second", Generation: 2})
	requireInferenceReason(t, err, "worker_revoked")
}
