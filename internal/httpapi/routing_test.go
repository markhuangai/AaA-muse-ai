package httpapi

import (
	"net/http"
	"testing"
)

func TestRetiredQualificationAndAutomaticAdmission(t *testing.T) {
	h, store, w, key := inferenceHTTPFixture(t)
	path := "/api/v1/admin/workers/" + w.ID + "/qualifications"
	for _, credential := range []string{key, "client-private-sentinel", "portal-private-sentinel", ""} {
		apiJSON(t, h, http.MethodPost, path, credential, nil, 401)
	}
	apiJSON(t, h, http.MethodGet, path, "admin-private-sentinel", nil, 405)
	retired := apiJSON(t, h, http.MethodPost, path, "admin-private-sentinel", map[string]any{"action": "approve"}, 410)
	if retired["error"] != "qualification_retired" {
		t.Fatal(retired)
	}
	input := nativeHTTPInput(w.ID)
	input.WorkerID = ""
	v, _ := nativeHTTP(t, h, http.MethodPost, "/api/v1/requests", "auto", input, 202)
	job := pullAndStartHTTP(t, h, store, key, false)
	status := apiJSON(t, h, http.MethodGet, "/api/v1/worker/status", key, nil, 200)
	if v.WorkerID != "" || job.WorkerID != w.ID || job.ExperimentID != v.ID || status["inference_readiness"] != "unverified" || len(status["qualification_history"].([]any)) != 0 {
		t.Fatal("automatic route required or fabricated approval", v, status)
	}
}
