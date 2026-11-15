package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

func TestWorkerCompatibilityRejectsBeforeEnrollmentAndRetainsCode(t *testing.T) {
	h, store, out, _ := workerHTTPFixture(t)
	code := issueHTTP(t, h)
	h.Service = service.New(nil, config.Defaults(), service.Build{Version: "1.2.0", WorkerPackage: service.PairedWorker("1.2.0", strings.Repeat("a", 64))}, "instance", h.Now, h.Logger)
	request := func(versions []string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"enrollment_code": code})
		r := httptest.NewRequest("POST", "/api/v1/worker/enroll", strings.NewReader(string(body)))
		for _, version := range versions {
			r.Header.Add(service.WorkerVersionHeader, version)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, versions := range [][]string{nil, {"2.0.0"}, {"bad"}, {""}, {"1.0.0", "1.1.0"}} {
		w := request(versions)
		if w.Code != 426 && w.Code != 400 {
			t.Fatal("invalid worker enrolled", versions, w.Code)
		}
		if len(store.records) != 0 {
			t.Fatal("incompatible enrollment consumed authority")
		}
	}
	if w := request([]string{"1.9.0"}); w.Code != 201 || w.Header().Get(service.ServiceVersionHeader) != "1.2.0" || len(store.records) != 1 {
		t.Fatal("compatible older service rejected newer worker", w.Code)
	}
	if !strings.Contains(out.String(), "worker.update_required") || strings.Contains(out.String(), code) {
		t.Fatal("compatibility diagnosis missing or secret exposed")
	}
	code = issueHTTP(t, h)
	h.Service = service.New(nil, config.Defaults(), service.Build{Version: "0.1.0-rc.7"}, "instance", h.Now, h.Logger)
	if request(nil).Code != 201 {
		t.Fatal("legacy major-zero handshake rejected")
	}
	code = issueHTTP(t, h)
	if request([]string{"0.0.1"}).Code != 201 {
		t.Fatal("same major older worker rejected")
	}
}

func TestSubscriptionAndClaimCompatibilityPreservesAuthorityAndReceipts(t *testing.T) {
	for _, versions := range [][2]string{{"1.2.0", "1.0.0"}, {"1.0.0", "1.9.0"}} {
		t.Run(versions[0]+"_"+versions[1], func(t *testing.T) {
			h, store, worker, key := inferenceHTTPFixture(t)
			h.Service = service.New(nil, config.Defaults(), service.Build{Version: versions[0], WorkerPackage: service.PairedWorker(versions[0], strings.Repeat("a", 64))}, "instance", h.Now, h.Logger)
			request := func(method, path, version string, input any) *httptest.ResponseRecorder {
				data, _ := json.Marshal(input)
				r := httptest.NewRequest(method, path, bytes.NewReader(data))
				if method == "GET" {
					r.Body = http.NoBody
				}
				r.Header.Set("Authorization", "Bearer "+key)
				r.Header.Set(service.WorkerVersionHeader, version)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				return w
			}
			if request("GET", "/api/v1/worker/events", "2.0.0", nil).Code != 426 || len(store.states) != 0 {
				t.Fatal("incompatible subscription changed connection authority")
			}
			status := request("GET", "/api/v1/worker/status", versions[1], nil)
			var own map[string]any
			if status.Code != 200 || json.Unmarshal(status.Body.Bytes(), &own) != nil || own["worker_package"].(map[string]any)["version"] != versions[0] {
				t.Fatal("status lacks actionable paired release identity")
			}
			server := httptest.NewServer(h)
			r, _ := http.NewRequest("GET", server.URL+"/api/v1/worker/events", nil)
			r.Header.Set("Authorization", "Bearer "+key)
			r.Header.Set(service.WorkerVersionHeader, versions[1])
			response, err := (&http.Client{Timeout: 3 * time.Second}).Do(r)
			if err != nil {
				server.Close()
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			server.Close()
			if err != nil || response.StatusCode != 200 || !bytes.Contains(body, []byte("event: connection.opened")) || store.states[worker.ID].Connection.Generation != 1 {
				t.Fatal("compatible subscription failed", err)
			}
			connection := onlineHTTP(t, h, worker.ID)
			experiment := apiJSON(t, h, "POST", "/api/v1/admin/experiments", "admin-private-sentinel", map[string]any{"protocol_version": 1, "submission_id": "compat-create", "worker_id": worker.ID, "messages": []any{map[string]any{"type": "message", "role": "user", "text": "compatibility fixture"}}, "tools": []any{}}, 201)
			job := experiment["current_job_id"].(string)
			claim := map[string]any{"protocol_version": 1, "submission_id": "compat-claim", "connection_id": connection.ID, "connection_generation": connection.Generation}
			before, _ := json.Marshal(store.states[worker.ID])
			if request("POST", "/api/v1/worker/jobs/"+job+"/claim", "2.0.0", claim).Code != 426 {
				t.Fatal("incompatible claim accepted")
			}
			after, _ := json.Marshal(store.states[worker.ID])
			if !bytes.Equal(before, after) {
				t.Fatal("rejected claim changed assignment state")
			}
			if response := request("POST", "/api/v1/worker/jobs/"+job+"/claim", versions[1], claim); response.Code != 200 {
				t.Fatal("compatible claim rejected", response.Body.String())
			}
			before, _ = json.Marshal(store.states[worker.ID])
			if request("GET", "/api/v1/worker/events", "2.0.0", nil).Code != 426 {
				t.Fatal("incompatible reconnect accepted")
			}
			after, _ = json.Marshal(store.states[worker.ID])
			if !bytes.Equal(before, after) || !store.states[worker.ID].Jobs[job].Held {
				t.Fatal("rejected reconnect changed busy hold or generation")
			}
			j := store.states[worker.ID].Jobs[job]
			decision := map[string]any{"protocol_version": 1, "submission_id": "compat-decision", "connection_id": connection.ID, "connection_generation": connection.Generation, "conversation_id": j.ConversationID, "generation": j.Generation, "lease_id": j.LeaseID, "context_receipt_id": j.Context.ReceiptID, "decision": map[string]any{"type": "final", "text": "preserved accepted receipt"}}
			accepted := request("POST", "/api/v1/worker/jobs/"+job+"/decisions", versions[1], decision)
			h.Service = service.New(nil, config.Defaults(), service.Build{Version: "2.0.0"}, "instance", h.Now, h.Logger)
			replayed := request("POST", "/api/v1/worker/jobs/"+job+"/decisions", versions[1], decision)
			if accepted.Code != 200 || replayed.Code != 200 || accepted.Body.String() != replayed.Body.String() {
				t.Fatal("major change blocked accepted receipt reconciliation")
			}
		})
	}
}
