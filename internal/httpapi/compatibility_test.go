package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
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

func TestPullAndStartCompatibilityPreservesAuthorityAndReceipts(t *testing.T) {
	for _, versions := range [][2]string{{"1.2.0", "1.0.0"}, {"1.0.0", "1.9.0"}} {
		t.Run(versions[0]+"_"+versions[1], func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			handler := pullHTTP(t, filepath.Join(root, "broker.sqlite3"))
			handler.Service = service.New(nil, config.Defaults(), service.Build{Version: versions[0], WorkerPackage: service.PairedWorker(versions[0], strings.Repeat("a", 64))}, "instance", handler.Now, handler.Logger)
			key := enrollNative(t, handler)
			queued, err := handler.Broker.SubmitRequest(t.Context(), handler.Logger, "client", "compatibility-session", inference.RequestInput{
				Version: 1, SubmissionID: "compat-request", Messages: []inference.Item{{Type: "message", Role: "user", Text: "compatibility fixture"}}, Tools: []inference.Tool{},
			})
			if err != nil {
				t.Fatal(err)
			}
			stamp := time.Now().UTC()
			input := inference.Pull{Version: 1, Sequence: 1, Checker: "compat-checker", Occurrence: "compat-tick", ScheduledAt: stamp, EnteredAt: stamp}
			const pull = "/api/v1/worker/pull"
			for _, version := range []string{"", "0.9.0", "2.0.0"} {
				nativeResponse(t, nativePostVersion(handler, pull, key, version, input), 426, nil)
			}
			var granted inference.PullResult
			nativeResponse(t, nativePostVersion(handler, pull, key, versions[1], input), 200, &granted)
			if granted.Job == nil || granted.Job.OperationID != queued.ID {
				t.Fatal("rejected pull changed claim or poll sequence")
			}
			jobPath := "/api/v1/worker/jobs/" + granted.Job.JobID
			start := inference.WorkStart{Version: 1, ClaimID: granted.Job.ClaimID, Generation: granted.Job.Generation, LaunchID: "compat-launch", NativeJob: "compat-native"}
			nativeResponse(t, nativePostVersion(handler, jobPath+"/start", key, "0.9.0", start), 426, nil)
			var brief inference.Job
			nativeResponse(t, nativePostVersion(handler, jobPath+"/start", key, versions[1], start), 200, &brief)
			decision := inference.Submit{Claim: inference.Claim{Version: 1, SubmissionID: "compat-decision"}, ConversationID: brief.ConversationID, Generation: brief.Generation,
				LeaseID: brief.LeaseID, ContextReceiptID: brief.Context.ReceiptID, Decision: inference.Item{Type: "final", Text: "preserved accepted receipt"}}
			accepted := nativePostVersion(handler, jobPath+"/decisions", key, versions[1], decision)
			nativeResponse(t, accepted, 200, nil)
			handler.Service = service.New(nil, config.Defaults(), service.Build{Version: "2.0.0"}, "instance", handler.Now, handler.Logger)
			replayed := nativePostVersion(handler, jobPath+"/decisions", key, versions[1], decision)
			nativeResponse(t, replayed, 200, nil)
			if !bytes.Equal(accepted.Body.Bytes(), replayed.Body.Bytes()) {
				t.Fatal("major change altered an accepted receipt")
			}
		})
	}
}
