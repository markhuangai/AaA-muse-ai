package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func hookPath(path string) string {
	if tail, ok := strings.CutPrefix(path, workerPrefix); ok {
		return hookWorkerPrefix + tail
	}
	return path
}

func pairedRequest(h *Handler, method, path string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, hookPath(path), body)
	if strings.HasPrefix(path, workerPrefix) {
		b := h.Service.Build()
		r.Header.Set(service.WorkerVersionHeader, b.Version)
		r.Header.Set(service.WorkerUpdaterHeader, worker.UpdateContract)
		r.Header.Set(service.WorkerDigestHeader, b.WorkerPackage.SHA256)
		if path == workerPullRoute {
			r.Header.Set("X-Muse-Worker-Hook-Proof", "1")
		}
	}
	return r
}

// Keep the actual pickup identity for tests that exercise adjacent work and receipt behavior.
var testPullIdentity sync.Map

func rememberTestPull(result *httptest.ResponseRecorder, input any) {
	pull, ok := input.(inference.Pull)
	if !ok || result.Code != 200 {
		return
	}
	var reply inference.PullResult
	if json.Unmarshal(result.Body.Bytes(), &reply) == nil && reply.Job != nil {
		testPullIdentity.Store(reply.Job.ClaimID, pull)
	}
}

func pairedWorkInput(input any) any {
	switch value := input.(type) {
	case inference.WorkStart:
		return pairedTestStart(value)
	case inference.Interruption:
		return pairedTestStop(value)
	default:
		return input
	}
}

func pairedTestStart(start inference.WorkStart) inference.WorkStart {
	actual, ok := testPullIdentity.Load(start.ClaimID)
	if !ok || start.Verification != nil {
		return start
	}
	pull := actual.(inference.Pull)
	start.NativeJob = pull.Checker
	start.Verification = &inference.NativeStartProof{Reference: start.ClaimID, NativeJob: pull.Checker,
		NativeRun: "event-hook-" + pull.Occurrence, Status: "running"}
	return start
}

func pairedTestStop(stop inference.Interruption) inference.Interruption {
	actual, ok := testPullIdentity.Load(stop.ClaimID)
	if !ok || stop.VerifiedStart {
		return stop
	}
	stop.VerifiedStart = true
	if stop.Reason != "execution_confirmed_stopped" || (stop.NativeJob == stop.NativeRun && stop.NativeJob != "") {
		return stop
	}
	pull := actual.(inference.Pull)
	stop.NativeJob, stop.NativeRun = pull.Checker, "event-hook-"+pull.Occurrence
	return stop
}
