package httpapi

import (
	"net/http"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestRetiredQualificationAndAutomaticAdmission(t *testing.T) {
	h, _, w, key := inferenceHTTPFixture(t)
	onlineHTTP(t, h, w.ID)
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
	status := apiJSON(t, h, http.MethodGet, "/api/v1/worker/status", key, nil, 200)
	if v.WorkerID != w.ID || status["inference_readiness"] != "unverified" || len(status["qualification_history"].([]any)) != 0 {
		t.Fatal("automatic route required or fabricated approval", v, status)
	}
}

func TestWorkerUpgradeReservationHTTPAuthority(t *testing.T) {
	h, _, w, key := inferenceHTTPFixture(t)
	onlineHTTP(t, h, w.ID)
	input := service.UpgradeInput{Version: 1, Action: "acquire", OperationID: "upgrade"}
	for _, forbidden := range []string{"admin-private-sentinel", "client-private-sentinel", ""} {
		apiJSON(t, h, http.MethodPost, workerUpgradeRoute, forbidden, input, 401)
	}
	apiJSON(t, h, http.MethodPost, workerUpgradeRoute, key, map[string]any{"protocol_version": 1}, 400)
	apiJSON(t, h, http.MethodPost, workerUpgradeRoute, key, map[string]any{"protocol_version": 1, "generation": 0, "action": "acquire", "operation_id": "upgrade", "worker_id": w.ID}, 400)
	reply := apiJSON(t, h, http.MethodPost, workerUpgradeRoute, key, input, 200)
	status := apiJSON(t, h, http.MethodGet, "/api/v1/worker/status", key, nil, 200)
	if reply["generation"] != status["upgrade_reservation_generation"] || status["work_status"] != "upgrading" {
		t.Fatal("lease not reflected in status", reply, status)
	}
	input.Generation, input.Action = 1, "release"
	apiJSON(t, h, http.MethodPost, workerUpgradeRoute, key, input, 200)
	status = apiJSON(t, h, http.MethodGet, "/api/v1/worker/status", key, nil, 200)
	if status["work_status"] != "idle" {
		t.Fatal(status)
	}
}
