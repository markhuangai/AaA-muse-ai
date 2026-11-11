package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func TestQualificationHTTPAuthorityAndAutomaticAdmission(t *testing.T) {
	h, m, w, key := inferenceHTTPFixture(t)
	c := onlineHTTP(t, h, w.ID)
	input := nativeHTTPInput(w.ID)
	input.WorkerID = ""
	input.Tools = []inference.Tool{}
	nativeHTTP(t, h, "POST", "/api/v1/requests", "", input, 503)
	data, err := h.Broker.Create(context.Background(), h.Logger, inference.Create{Version: 1, SubmissionID: "ready", WorkerID: w.ID, Messages: []inference.Item{{Type: "message", Role: "user", Text: "independent-random-challenge"}}, Tools: []inference.Tool{}})
	if err != nil {
		t.Fatal(err)
	}
	var e inference.Experiment
	if err = json.Unmarshal(data, &e); err != nil {
		t.Fatal(err)
	}
	claim := apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+e.CurrentJobID+"/claim", key, inference.Claim{Version: 1, SubmissionID: "ready-claim", ConnectionID: c.ID, ConnectionGeneration: c.Generation}, 200)
	job := m.states[w.ID].Jobs[e.CurrentJobID]
	apiJSON(t, h, "POST", "/api/v1/worker/jobs/"+job.ID+"/decisions", key, inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: "ready-answer", ConnectionID: c.ID, ConnectionGeneration: c.Generation}, ConversationID: job.ConversationID, Generation: job.Generation, LeaseID: claim["lease_id"].(string), ContextReceiptID: job.Context.ReceiptID, Decision: inference.Item{Type: "final", Text: "independent-random-challenge"}}, 200)
	path := "/api/v1/admin/workers/" + w.ID + "/qualifications"
	q := inference.QualificationInput{Version: 1, SubmissionID: "approval", Action: "approve", EvidenceKind: "controlled", EvidenceReference: "controlled software; not live qualification", ReadinessExperimentID: e.ID}
	for _, credential := range []string{key, "client-private-sentinel", "portal-private-sentinel", ""} {
		apiJSON(t, h, http.MethodPost, path, credential, q, 401)
	}
	apiJSON(t, h, http.MethodGet, path, "admin-private-sentinel", nil, 405)
	apiJSON(t, h, http.MethodPost, path, "admin-private-sentinel", map[string]any{"protocol_version": 1}, 400)
	result := apiJSON(t, h, http.MethodPost, path, "admin-private-sentinel", q, 200)
	if result["evidence"].(map[string]any)["evidence_kind"] != "controlled" {
		t.Fatal("evidence provenance omitted")
	}
	apiJSON(t, h, http.MethodPost, path, "admin-private-sentinel", q, 200)
	status := apiJSON(t, h, http.MethodGet, "/api/v1/worker/status", key, nil, 200)
	if status["inference_readiness"] != "verified" {
		t.Fatal("broker readiness not projected")
	}
	v, _ := nativeHTTP(t, h, http.MethodPost, "/api/v1/requests", "auto", input, 202)
	if v.WorkerID != w.ID {
		t.Fatal("automatic route missing")
	}
	apiJSON(t, h, http.MethodPost, path, "admin-private-sentinel", inference.QualificationInput{Version: 1, SubmissionID: "withdraw", Action: "withdraw", EvidenceReference: "withdraw approval"}, 200)
	input.SubmissionID = "new"
	nativeHTTP(t, h, http.MethodPost, "/api/v1/requests", "new", input, 503)
	h.Broker = nil
	apiJSON(t, h, http.MethodPost, path, "admin-private-sentinel", q, 503)
}
