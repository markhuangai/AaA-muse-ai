package httpapi

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestPortalWorkerActionsUseManagementLogicAndProtectedDiagnostics(t *testing.T) {
	h, repository, out, store := workerHTTPFixture(t)
	h.Portal = service.NewPortal(h.Authority, rand.Reader, h.Now)
	h.Setup = service.NewSetup(h.Workers, "https://example.test", config.WorkerPackage{Version: "0.1.0-rc.0", SHA256: strings.Repeat("a", 64)})
	session := portalLogin(t, h)
	operation := map[string]string{"X-Portal-Operation-Id": "portal-workers-operation"}
	issued := portalHTTP(h, "POST", "/api/v1/admin/enrollments", session.Token, "", operation)
	var enrollment struct {
		Code string `json:"enrollment_code"`
	}
	if issued.Code != 201 || json.Unmarshal(issued.Body.Bytes(), &enrollment) != nil {
		t.Fatal("portal enrollment failed")
	}
	worker, key := enrollHTTP(t, h, enrollment.Code)
	path := "/api/v1/admin/workers/" + worker.ID
	accepted := portalHTTP(h, "PATCH", path, session.Token, `{"name":"  Studio 名称  "}`, operation)
	var renamed workerView
	if accepted.Code != 200 || json.Unmarshal(accepted.Body.Bytes(), &renamed) != nil || renamed.ID != worker.ID || renamed.Name != "Studio 名称" {
		t.Fatal("portal did not receive the actual accepted name and identity")
	}
	if portalHTTP(h, "PATCH", path, session.Token, `{"name":"   "}`, operation).Code != 400 {
		t.Fatal("portal bypassed worker-name validation")
	}
	if portalHTTP(h, "POST", "/api/v1/admin/setup-prompts", session.Token, "", operation).Code != 201 {
		t.Fatal("portal setup generation failed")
	}
	if portalHTTP(h, "POST", path+"/revoke", session.Token, "", operation).Code != 200 || portalHTTP(h, "GET", "/api/v1/worker/status", key, "", nil).Code != 401 {
		t.Fatal("portal revocation did not revoke worker authority")
	}
	if len(repository.records) != 1 || repository.records[worker.ID].Name != renamed.Name {
		t.Fatal("portal action recreated or removed identity")
	}
	repository.fail = errors.New("controlled database unavailable")
	failed := portalHTTP(h, "POST", "/api/v1/admin/enrollments", session.Token, "", operation)
	if failed.Code != 503 {
		t.Fatal("portal concealed action failure")
	}
	actions := map[string]int{}
	for _, event := range capturedHTTP(t, store) {
		if event["msg"] != "portal.worker_action" {
			continue
		}
		actions[event["action"].(string)]++
		if event["level"] != "INFO" || event["portal_session_id"] == "" || event["operation_id"] != "portal-workers-operation" || event["request_id"] == "" || event["status"] == nil || event["duration_ms"] == nil {
			t.Fatal("portal action lacks actual result or correlation")
		}
		if event["resource"] == "worker" && event["resource_id"] != worker.ID {
			t.Fatal("action lost immutable worker identity")
		}
	}
	if actions["enrollment.issue"] != 2 || actions["worker.rename"] != 2 || actions["worker.revoke"] != 1 || actions["setup.create"] != 1 {
		t.Fatal("portal actions are missing or duplicated")
	}
	for _, secret := range []string{session.Token, enrollment.Code, key} {
		if strings.Contains(out.String(), secret) {
			t.Fatal("portal action telemetry exposed authority")
		}
	}
}

func TestPortalWorkerReportsValidateOrderingWithoutAcceptingActionAssertions(t *testing.T) {
	h, _, _, store := portalHTTPFixture(t)
	session := portalLogin(t, h)
	report := service.PortalReport{Event: "portal.worker_state_stale", Component: "workers", Build: "development", Cause: "obsolete_response", RequestID: "old-backend-request", OperationID: "worker-order-operation", Expected: "fresh", Observed: "stale", Attempt: 1, RequestSequence: 2, AcceptedSequence: 3, LatestSequence: 3, SessionGeneration: 1, WorkerID: strings.Repeat("a", 32)}
	body, _ := json.Marshal(report)
	if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, string(body), nil).Code != 204 {
		t.Fatal("worker ordering report rejected")
	}
	for _, mutate := range []func(*service.PortalReport){
		func(r *service.PortalReport) { r.Event = "portal.worker_action" },
		func(r *service.PortalReport) { r.Component = "settings" },
		func(r *service.PortalReport) { r.WorkerID = "invalid" },
		func(r *service.PortalReport) { r.RequestSequence = 0 },
		func(r *service.PortalReport) { r.AcceptedSequence = -1 },
		func(r *service.PortalReport) { r.LatestSequence = 1 },
		func(r *service.PortalReport) { r.SessionGeneration = -1 },
		func(r *service.PortalReport) { r.Cause = "render_exception" },
		func(r *service.PortalReport) { r.Expected = "authenticated" },
		func(r *service.PortalReport) {
			r.Event = "portal.state_stale"
			r.Component = "settings"
			r.Cause = "request_failed"
		},
	} {
		invalid := report
		mutate(&invalid)
		body, _ = json.Marshal(invalid)
		if portalHTTP(h, "POST", "/api/v1/portal/events", session.Token, string(body), nil).Code != 400 {
			t.Fatal("invalid worker report admitted")
		}
	}
	found := false
	for _, event := range capturedHTTP(t, store) {
		if event["msg"] == "portal.worker_state_stale" {
			found = event["level"] == "WARN" && event["client_report"] == true && event["related_request_id"] == report.RequestID && event["request_sequence"] != nil && event["accepted_sequence"] != nil && event["session_generation"] != nil
		}
	}
	if !found {
		t.Fatal("worker ordering cannot be reconstructed from logs")
	}
	if action, resource := portalWorkerAction("/api/v1/admin/workers"); action != "" || resource != "" {
		t.Fatal("read invented an action")
	}
}
