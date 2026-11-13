package service

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func responseInput(id, text string) inference.ResponseInput {
	return inference.ResponseInput{Input: inference.RequestInput{Version: 1, SubmissionID: id, Messages: []inference.Item{{Type: "message", Role: "user", Text: text}}, Tools: []inference.Tool{}}, ItemIDs: []string{""}}
}

func submitResponse(t *testing.T, b *Broker, session string, input inference.ResponseInput) inference.RequestView {
	t.Helper()
	v, err := b.SubmitResponse(context.Background(), testHistoryLogger(), "alice", session, input)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestResponsesCanonicalChainingInstructionsAndReplay(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	c := connectNative(t, b, m, logger, "worker-a")
	input := responseInput("response-first", "question")
	instruction := "first only"
	input.Instructions = &instruction
	first := submitResponse(t, b, "responses", input)
	j := nativeDecide(t, b, m, c, first, inference.Item{Type: "final", Text: "first answer"})
	if j.Context.Messages[0].Text != "first only" || j.Context.Messages[1].Text != "question" {
		t.Fatal(j.Context)
	}
	conversation := m.states[first.WorkerID].Conversations[first.ConversationID]
	if conversation.ItemCount != 2 || conversation.Items[0].Item.Text != "question" {
		t.Fatal("instructions entered message history", conversation)
	}
	next := responseInput("response-next", "next")
	next.Input.PreviousResponseID = first.ResponseID
	second := submitResponse(t, b, "", next)
	j = nativeDecide(t, b, m, c, second, inference.Item{Type: "final", Text: "second answer"})
	if len(j.Context.Messages) != 3 || j.Context.Messages[0].Text != "question" || second.SessionID != first.SessionID {
		t.Fatal("instructions leaked or history lost", j.Context)
	}
	again := next
	again.Input.SubmissionID = "response-retry"
	replay := submitResponse(t, b, "", again)
	if replay.ID != second.ID {
		t.Fatal("exact retry duplicated work")
	}
	stale := responseInput("stale", "new suffix")
	stale.Input.PreviousResponseID = first.ResponseID
	_, err := b.SubmitResponse(context.Background(), logger, "alice", "", stale)
	requireInferenceReason(t, err, "stale_response_reference")
	changed := responseInput("changed", "last")
	changed.Input.PreviousResponseID = second.ResponseID
	current := "changed only"
	changed.Instructions = &current
	third := submitResponse(t, b, "", changed)
	j = nativeDecide(t, b, m, c, third, inference.Item{Type: "final", Text: "done"})
	if j.Context.Messages[0].Text != "changed only" || len(j.Context.Messages) != 6 {
		t.Fatal(j.Context)
	}
	data, _ := json.Marshal(m.states[third.WorkerID].Requests[first.ID])
	if !strings.Contains(string(data), "first only") {
		t.Fatal("immutable instruction snapshot lost")
	}
	_, err = b.SubmitResponse(context.Background(), logger, "mallory", "", changed)
	requireInferenceReason(t, err, "history_owner_denied")
	conflict := responseInput("header-conflict", "x")
	conflict.Input.PreviousResponseID = third.ResponseID
	_, err = b.SubmitResponse(context.Background(), logger, "alice", "other", conflict)
	requireInferenceReason(t, err, "session_reference_conflict")
}

func TestResponsesFunctionReplayIDsAndConflictingResults(t *testing.T) {
	for _, chain := range []bool{false, true} {
		t.Run(map[bool]string{false: "full", true: "chain"}[chain], func(t *testing.T) {
			b, m, logger, _ := inferenceFixture()
			c := connectNative(t, b, m, logger, "worker-a")
			input := responseInput("tool-first", "read fixture")
			input.Input.Tools = requestInput("unused").Tools
			first := submitResponse(t, b, "tool-session", input)
			call := inference.Item{Type: "tool_call", CallID: "accepted-exact", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}
			nativeDecide(t, b, m, c, first, call)
			result := inference.Item{Type: "tool_result", CallID: call.CallID, Output: "exact\r\n😀"}
			next := responseInput("tool-result", "")
			next.Input.Messages = []inference.Item{call, result}
			next.ItemIDs = []string{inference.OutputItemID(first.ID, "tool_call"), ""}
			next.Input.Tools = input.Input.Tools
			if chain {
				next.Input.PreviousResponseID = first.ResponseID
			} else {
				next.Input.Messages = append(input.Input.Messages, next.Input.Messages...)
				next.ItemIDs = append([]string{""}, next.ItemIDs...)
			}
			bad := next
			bad.Input.Messages = append([]inference.Item{}, next.Input.Messages...)
			bad.Input.Messages[len(bad.Input.Messages)-1].CallID = "wrong"
			_, err := b.SubmitResponse(context.Background(), logger, "alice", "tool-session", bad)
			requireInferenceReason(t, err, "tool_result_linkage_conflict")
			second := submitResponse(t, b, "tool-session", next)
			job := nativeDecide(t, b, m, c, second, inference.Item{Type: "final", Text: result.Output})
			if len(job.Context.Messages) != 3 || job.Context.Messages[1].CallID != call.CallID || job.Context.Messages[2].Output != result.Output {
				t.Fatal(job.Context)
			}
			conversation := m.states[second.WorkerID].Conversations[second.ConversationID]
			if conversation.ItemCount != 4 {
				t.Fatal("duplicate history", conversation.ItemCount)
			}
			next.Input.SubmissionID = "tool-repeat"
			if submitResponse(t, b, "tool-session", next).ID != second.ID {
				t.Fatal("tool retry duplicated")
			}
		})
	}
}

func TestResponsesItemValidationAndAtomicFailure(t *testing.T) {
	b, m, logger, _ := inferenceFixture()
	c := connectNative(t, b, m, logger, "worker-a")
	first := submitResponse(t, b, "items", responseInput("items-first", "question"))
	nativeDecide(t, b, m, c, first, inference.Item{Type: "final", Text: "answer"})
	for _, kind := range []string{"unknown", "changed", "duplicate", "length", "size", "busy"} {
		t.Run(kind, func(t *testing.T) {
			input := responseInput("item-"+kind, "next")
			input.Input.PreviousResponseID = first.ResponseID
			if kind == "length" {
				input.ItemIDs = nil
			} else if kind == "size" {
				large := strings.Repeat("x", inference.MaxContextBytes)
				input.Instructions = &large
			} else if kind == "busy" {
				pending := submitResponse(t, b, "items", input)
				input.Input.SubmissionID = "busy-new"
				input.Input.Messages[0].Text = "another"
				_, err := b.SubmitResponse(context.Background(), logger, "alice", "items", input)
				requireInferenceReason(t, err, "session_busy")
				_, _ = b.CancelRequest(context.Background(), logger, "alice", pending.ID, pending.SessionID, inference.Cancel{Version: 1, SubmissionID: "cancel-busy"})
				return
			} else {
				input.Input.Messages = []inference.Item{{Type: "message", Role: "assistant", Text: "answer"}, {Type: "message", Role: "user", Text: "next"}}
				input.ItemIDs = []string{inference.OutputItemID(first.ID, "final"), ""}
				if kind == "unknown" {
					input.ItemIDs[0] = "msg_foreign"
				}
				if kind == "changed" {
					input.Input.Messages[0].Text = "changed"
				}
				if kind == "duplicate" {
					input.ItemIDs[1] = input.ItemIDs[0]
				}
			}
			_, err := b.SubmitResponse(context.Background(), logger, "alice", "items", input)
			if err == nil {
				t.Fatal("invalid item admitted")
			}
			if m.states[first.WorkerID].Conversations[first.ConversationID].ItemCount != 2 {
				t.Fatal("failed admission appended history")
			}
		})
	}
}
