package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/auth"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/media"
)

func TestMediaHTTP(t *testing.T) {
	h, db, w, key := inferenceHTTPFixture(t)
	h.Broker.Media = media.New(t.TempDir())
	h.Broker.Media.Inspect = func(_ context.Context, path, kind string) (inference.MediaProperties, error) {
		_, err := os.Stat(path)
		return inference.MediaProperties{MediaType: kind, Width: 64, Height: 48, Duration: 1, VideoFrames: 24}, err
	}
	const client = "client-private-sentinel"
	const admin = "admin-private-sentinel"
	req := func(method, path, principal, kind string, body []byte, headers map[string]string, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+principal)
		r.Header.Set("Content-Type", kind)
		for k, v := range headers {
			if k == "Host" {
				r.Host = v
			} else {
				r.Header.Set(k, v)
			}
		}
		out := httptest.NewRecorder()
		h.ServeHTTP(out, r)
		if out.Code != status {
			t.Fatalf("%s %s got %d expected %d: %s", method, path, out.Code, status, out.Body.String())
		}
		return out
	}
	for _, pair := range []struct {
		body string
		code int
	}{{"{}", 400}, {`{"prompt":"x","submission_id":"ok","bad":true}`, 400}, {`{"prompt":"   ","submission_id":"ok"}`, 400}, {`{"prompt":"` + strings.Repeat("m", 4097) + `","submission_id":"ok"}`, 413}} {
		req("POST", mediaJobs, client, "application/json", []byte(pair.body), nil, pair.code)
	}
	for _, format := range []string{"null", "1", `"ogg"`} {
		body := `{"prompt":"sound","submission_id":"valid","format":` + format + "}"
		req("POST", mediaJobs, client, "application/json", []byte(body), nil, 400)
	}
	req("POST", mediaJobs, client, "text/plain", nil, nil, 415)
	req("POST", mediaJobs+"?other", client, "application/json", nil, nil, 400)
	input := []byte(`{"prompt":"private-media-user-text","submission_id":"user-job"}`)
	req("POST", mediaJobs, admin, "application/json", input, nil, 401)
	created := req("POST", mediaJobs, client, "application/json", input, nil, 202)
	var row struct {
		ID string `json:"job_id"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	if replay := req("POST", mediaJobs, client, "application/json", input, nil, 202); replay.Body.String() != created.Body.String() {
		t.Fatal("submission replay changed")
	}
	req("POST", mediaJobs, client, "application/json", bytes.ReplaceAll(input, []byte("user-text"), []byte("changed")), nil, 409)
	url := mediaJobs + "/" + row.ID
	req("GET", url, client, "", nil, nil, 200)
	req("GET", url+"/artifact", client, "", nil, nil, 409)
	workerRoute := "/api/v1/worker/jobs/" + row.ID
	job := pullAndStartHTTP(t, h, db, key, true)
	if job.ID != row.ID {
		t.Fatal("wrong media assignment")
	}
	headers := map[string]string{"X-Muse-Generation": strconv.FormatInt(job.Generation, 10), "X-Muse-Lease-Id": job.LeaseID}
	if actual := req("GET", workerRoute+"/media/prompt", key, "", nil, headers, 200); actual.Body.String() != "private-media-user-text" {
		t.Fatal("wrong prompt")
	}
	req("GET", workerRoute+"/media/image", key, "", nil, headers, 404)
	payload := []byte("private-byte-sentinel")
	digest := sha256.Sum256(payload)
	req("PUT", workerRoute+"/artifact", key, "video/mp4", payload, headers, 400)
	headers["X-Muse-Artifact-Sha256"] = hex.EncodeToString(digest[:])
	req("PUT", workerRoute+"/artifact", key, "audio/wav", payload, headers, 415)
	req("PUT", workerRoute+"/artifact", key, "video/mp4", payload, headers, 200)
	req("PUT", workerRoute+"/artifact", key, "video/mp4", payload, headers, 200)
	download := req("GET", url+"/artifact", client, "", nil, nil, 200)
	if !bytes.Equal(download.Body.Bytes(), payload) || download.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unprotected or changed artifact")
	}
	req("GET", url, client, "", nil, map[string]string{"Host": "example.com:65536"}, 400)
	owned := req("GET", url, client, "", nil, map[string]string{"Host": "broker.example:8443", "X-Forwarded-Host": "untrusted.invalid"}, 200)
	var link mediaPollResult
	if err := json.Unmarshal(owned.Body.Bytes(), &link); err != nil {
		t.Fatal(err)
	}
	publicLink, err := neturl.Parse(link.DownloadURL)
	if err != nil || publicLink.Scheme != "https" || publicLink.Host != "broker.example:8443" {
		t.Fatal("status did not use the accepted HTTPS authority")
	}
	token := filepath.Base(publicLink.Path)
	if !auth.ValidToken(token, auth.DownloadPrefix) {
		t.Fatal("invalid share credential")
	}
	out := req("GET", publicLink.Path, "", "", nil, nil, 200)
	if out.Header().Get("Content-Disposition") != "attachment; filename=muse.mp4" ||
		out.Header().Get("Referrer-Policy") != "no-referrer" || !bytes.Equal(out.Body.Bytes(), payload) {
		t.Fatal("anonymous download differed from verified artifact")
	}
	badToken := auth.DownloadPrefix + strings.Repeat("A", 43)
	for _, path := range []string{sharedMediaPrefix + "invalid", strings.ReplaceAll(publicLink.Path, token, badToken),
		sharedMediaPrefix + strings.Repeat("a", 32) + "/" + badToken, publicLink.Path + "?unused"} {
		denied := req("GET", path, "", "", nil, nil, 404)
		if denied.Body.String() != "{\"error\":\"not_found\"}\n" {
			t.Fatal("public denial leaked its internal reason")
		}
	}
	saved := db.states[w.ID].Jobs[row.ID]
	past := time.Now().Add(-time.Second)
	saved.Media.ExpiresAt = &past
	req("GET", url+"/artifact", client, "", nil, nil, 410)
	req("GET", publicLink.Path, "", "", nil, nil, 404)
	future := time.Now().Add(time.Minute)
	saved.Media.ExpiresAt = &future
	if err = os.Remove(filepath.Join(h.Broker.Media.Dir, row.ID, "artifact")); err != nil {
		t.Fatal(err)
	}
	req("GET", publicLink.Path, "", "", nil, nil, 404)
	req("GET", url, client, "", nil, nil, 404)
	if err = os.WriteFile(filepath.Join(h.Broker.Media.Dir, row.ID, "download-token"), []byte("truncated"), 0600); err != nil {
		t.Fatal(err)
	}
	req("GET", publicLink.Path, "", "", nil, nil, 503)
	req("POST", mediaTrials, client, "application/json", nil, nil, 401)
	req("POST", mediaTrials, admin, "application/json", []byte("{}"), nil, 400)
	trial, _ := json.Marshal(map[string]string{"worker_id": w.ID, "owner": "client", "profile": "native_mp3", "submission_id": "trial"})
	req("POST", mediaTrials, admin, "application/json", trial, nil, 202)
	if strings.Contains(db.output.String(), "private-media-user-text") || strings.Contains(db.output.String(), string(payload)) {
		t.Fatal("raw media captured")
	}
}

func TestMediaMultipartBoundary(t *testing.T) {
	store := media.New(t.TempDir())
	store.Inspect = func(context.Context, string, string) (inference.MediaProperties, error) {
		return inference.MediaProperties{}, nil
	}
	for _, kind := range []string{"valid", "duplicate", "missing", "unsupported", "unknown"} {
		var b bytes.Buffer
		w := multipart.NewWriter(&b)
		w.WriteField("prompt", "motion")
		w.WriteField("submission_id", "image1")
		if kind == "duplicate" {
			w.WriteField("prompt", "other")
		}
		if kind == "unknown" {
			w.WriteField("profile", "native_mp3")
		}
		if kind != "missing" {
			p, err := w.CreateFormFile("image", "a.png")
			if err != nil {
				t.Fatal(err)
			}
			data := "\x89PNG\r\n\x1a\nimage"
			if kind == "unsupported" {
				data = "gif"
			}
			io.WriteString(p, data)
		}
		w.Close()
		r := httptest.NewRequest("POST", mediaJobs, &b)
		r.Header.Set("Content-Type", w.FormDataContentType())
		stage, err := store.Begin()
		if err != nil {
			t.Fatal(err)
		}
		in, err := readMediaRequest(r.Context(), r, store, stage)
		stage.Close()
		if kind == "valid" && (err != nil || in.Submission != "image1" || stage.Record.InputType != "image/png") || kind != "valid" && err == nil {
			t.Fatal(kind, in, err)
		}
	}
}
