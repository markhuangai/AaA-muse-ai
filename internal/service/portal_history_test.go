package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func TestPortalCancelUnassignedAndClaimedPreservesSiblingAndUncertainty(t *testing.T) {
	b, m, logger, logs := inferenceFixture()
	connection := connectNative(t, b, m, logger, "worker-a")
	first := admitted(t, b, "alice", "held-session", autoInput("held-first"))
	job := nativeJob(t, b, m, connection, first)
	queued := admitted(t, b, "alice", "queued-session", autoInput("queued-first"))
	if queued.WorkerID != "" {
		t.Fatal("fixture did not enter an unassigned queue")
	}
	input := inference.Cancel{Version: 1, SubmissionID: "portal-cancel-queued"}
	data, err := b.Cancel(context.Background(), logger, queued.ID, input)
	cancelled := decodeResult[inference.Experiment](t, data, err)
	if cancelled.State != "cancelled" || cancelled.RemoteOutcome != "not_started" || m.states[""].Requests[queued.ID].State != "cancelled" || !m.states[first.WorkerID].Jobs[job.ID].Held {
		t.Fatal("queued cancellation lost state or disturbed the held sibling")
	}
	again, err := b.Cancel(context.Background(), logger, queued.ID, input)
	if err != nil || string(again) != string(data) {
		t.Fatal("cancellation receipt was not replayed")
	}
	data, err = b.Cancel(context.Background(), logger, first.ID, inference.Cancel{Version: 1, SubmissionID: "portal-cancel-held"})
	cancelled = decodeResult[inference.Experiment](t, data, err)
	if cancelled.RemoteOutcome != "unknown" || !m.states[first.WorkerID].Jobs[job.ID].Held {
		t.Fatal("claimed cancellation invented remote stopping")
	}
	_, err = b.Decide(context.Background(), logger, first.WorkerID, job.ID, submission(job, connection, "late-decision", inference.Item{Type: "final", Text: "late"}))
	requireInferenceReason(t, err, "stale_assignment")
	ack := &inference.Assignment{JobID: job.ID, Generation: job.Generation, LeaseID: job.LeaseID}
	m.now = m.now.Add(11 * time.Second)
	heartbeatInference(t, b, logger, connection, first.WorkerID, ack)
	if m.states[first.WorkerID].Jobs[job.ID].Held || m.states[first.WorkerID].Experiments[first.ID].RemoteOutcome != "unknown" {
		t.Fatal("idle acknowledgement changed uncertainty or failed to release capacity")
	}
	if !strings.Contains(logs.String(), "portal.cancel_result") || !strings.Contains(logs.String(), `"busy_hold":true`) || !strings.Contains(logs.String(), `"observed_state":"cancelled"`) {
		t.Fatal("cancellation lacks actual state and busy-hold evidence")
	}
}

func TestPortalHistoryReportContractRejectsActionAssertionsAndUnboundedMetadata(t *testing.T) {
	base := PortalReport{Event: "portal.history_load_failed", Build: "development", Component: "history", Cause: "obsolete_response", OperationID: "history-operation", RequestID: "http-request", QueryKind: "requests", Cursor: "cursor", ConversationID: "conversation", RequestRecordID: "request", Expected: "fresh", Observed: "stale", Attempt: 1, RequestSequence: 2, AcceptedSequence: 3, LatestSequence: 3, SessionGeneration: 1}
	if !base.valid() {
		t.Fatal("valid history ordering report rejected")
	}
	for _, mutate := range []func(*PortalReport){
		func(r *PortalReport) { r.Cursor = strings.Repeat("a", 1025) },
		func(r *PortalReport) { r.Cursor = "bad cursor" },
		func(r *PortalReport) { r.ConversationID = "bad id" },
		func(r *PortalReport) { r.RequestRecordID = "bad id" },
		func(r *PortalReport) { r.QueryKind = "unsupported" },
		func(r *PortalReport) { r.WorkerID = strings.Repeat("a", 32) },
		func(r *PortalReport) { r.RequestSequence = 0 },
		func(r *PortalReport) { r.AcceptedSequence = -1 },
		func(r *PortalReport) { r.LatestSequence = 1 },
		func(r *PortalReport) { r.SessionGeneration = -1 },
		func(r *PortalReport) { r.QueryGeneration = -1 },
		func(r *PortalReport) { r.SelectionGeneration = -1 },
		func(r *PortalReport) { r.Event = "portal.worker_action" },
		func(r *PortalReport) { r.Cause = "success" },
		func(r *PortalReport) { r.Component = "settings" },
		func(r *PortalReport) { r.Expected = "authenticated" },
	} {
		invalid := base
		mutate(&invalid)
		if invalid.valid() {
			t.Fatal("invalid history report admitted", invalid)
		}
	}
	base.Event, base.QueryKind, base.Cause = "portal.cancel_result", "cancel", "request_failed"
	if !base.valid() {
		t.Fatal("unconfirmed cancellation report rejected")
	}
	base.Observed = "cancelled"
	if base.valid() {
		t.Fatal("browser asserted a successful cancellation")
	}
	base.Event, base.Expected, base.Observed, base.Cause = "portal.render_failed", "rendered", "failed", "render_exception"
	if !base.valid() {
		t.Fatal("history render report rejected")
	}
}
