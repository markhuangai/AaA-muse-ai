package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/service"
)

type mediaPollResult struct {
	service.MediaPoll
	DownloadURL string `json:"download_url,omitempty"`
}

func publicHTTPSOrigin(host string) (string, bool) {
	origin := "https://" + host
	u, err := url.Parse(origin)
	if err != nil || u.Host != host || u.Hostname() == "" || u.User != nil ||
		strings.ContainsAny(host, "/?#@\\%") || strings.HasSuffix(host, ":") ||
		(strings.Contains(u.Hostname(), ":") && !strings.HasPrefix(host, "[")) {
		return "", false
	}
	if p := u.Port(); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			return "", false
		}
	}
	return origin, true
}

func (h *Handler) pollMedia(ctx context.Context, l *slog.Logger, owner, id, host, kind string) (mediaPollResult, error) {
	origin, ok := publicHTTPSOrigin(host)
	if !ok {
		return mediaPollResult{}, inference.Reject("invalid_host", 400)
	}
	status, token, err := h.Broker.PollMedia(ctx, l, owner, id, kind)
	reply := mediaPollResult{MediaPoll: status}
	if err == nil && token != "" {
		reply.DownloadURL = origin + sharedMediaPrefix + id + "/" + token
	}
	return reply, err
}

func (h *Handler) serveSharedMedia(ctx context.Context, l *slog.Logger, w *response, r *http.Request, id string) error {
	tail := strings.TrimPrefix(r.URL.Path, sharedMediaPrefix)
	_, token, _ := strings.Cut(tail, "/")
	if id == "" || r.URL.RawPath != "" || r.URL.RawQuery != "" || r.ContentLength != 0 || len(r.TransferEncoding) > 0 {
		l.Warn("media.link_rejected", "cause", "download_link_invalid", "outcome", "rejected")
		writeJSON(w, 404, map[string]any{"error": "not_found"})
		return nil
	}
	status, file, err := h.Broker.ReadSharedMedia(ctx, l, id, token)
	if err != nil {
		code, reason, _ := chatFailure(err)
		if code == 404 {
			l.Warn("media.link_rejected", "cause", reason, "outcome", "rejected")
			writeJSON(w, 404, map[string]any{"error": "not_found"})
			return nil
		}
		return err
	}
	filename := "muse.mp4"
	if status.Artifact.MediaType == "audio/wav" {
		filename = "muse.wav"
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Disposition", "attachment; filename="+filename)
	return sendFile(w, file, status.Artifact.MediaType, status.Artifact.Size)
}
