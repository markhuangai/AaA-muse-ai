package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpRoute = "/mcp"

type mcpExchangeKey struct{}

type mcpExchange struct {
	request context.Context
	logger  *slog.Logger
	owner   string
	host    string
	mu      sync.Mutex
	outputs []string
}

type mcpPrompt struct {
	Prompt     string `json:"prompt" jsonschema:"The prompt to send to Muse"`
	Submission string `json:"submission_id" jsonschema:"A caller-chosen retry ID. Reuse it for the same submission."`
}

type mcpJob struct {
	ID string `json:"job_id" jsonschema:"The job ID returned when media generation was submitted"`
}

type mcpAnswer struct {
	Text      string `json:"text"`
	RequestID string `json:"request_id"`
}

type mcpMediaResult struct {
	ID                string `json:"job_id"`
	State             string `json:"status"`
	RetryAfterSeconds int    `json:"retry_after_seconds,omitempty"`
	Reason            string `json:"reason,omitempty"`
	DownloadURL       string `json:"download_url,omitempty"`
	ExpiresAt         string `json:"expires_at,omitempty"`
}

func (h *Handler) InitMCP() {
	h.mcpHandler = h.newMCPHandler()
}

func (h *Handler) newMCPHandler() http.Handler {
	version := "dev"
	if h.Service != nil {
		version = h.Service.Build().Version
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "aaa-muse-ai", Version: version}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "ask_muse", Description: "Send an independent text prompt to Muse and wait for the answer."}, h.askMuse)
	mcp.AddTool(server, &mcp.Tool{Name: "generate_wav", Description: "Submit a prompt for a WAV. Poll download_wav with the job ID every 60 seconds."}, h.generateMCPMedia("wav"))
	mcp.AddTool(server, &mcp.Tool{Name: "generate_video", Description: "Submit a prompt for an MP4. Poll download_video with the job ID every 60 seconds."}, h.generateMCPMedia("mp4"))
	mcp.AddTool(server, &mcp.Tool{Name: "download_wav", Description: "Check a WAV job and get its temporary download link once ready."}, h.downloadMCPMedia("audio/wav"))
	mcp.AddTool(server, &mcp.Tool{Name: "download_video", Description: "Check an MP4 job and get its temporary download link once ready."}, h.downloadMCPMedia("video/mp4"))
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true, PropagateRequestCancellation: true, MaxRequestBodyBytes: MaxBodyBytes,
	})
}

func (h *Handler) serveMCP(w *response, r *http.Request, logger *slog.Logger, owner string) {
	origin, ok := publicHTTPSOrigin(r.Host)
	if !ok || r.URL.RawQuery != "" {
		logger.Warn("mcp.request_rejected", "cause", "invalid_endpoint")
		inferenceError(w, inference.Reject("invalid_endpoint", 400))
		return
	}
	if origins := r.Header.Values("Origin"); len(origins) != 0 && (len(origins) != 1 || !strings.EqualFold(origins[0], origin)) {
		logger.Warn("mcp.request_rejected", "cause", "invalid_origin")
		inferenceError(w, inference.Reject("invalid_origin", 403))
		return
	}
	if h.Broker == nil {
		inferenceError(w, errors.New("broker_unavailable"))
		return
	}
	select {
	case <-h.Failed:
		inferenceError(w, errors.New("diagnostics_unavailable"))
		return
	default:
	}
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(h.Now().Add(320 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		logger.Error("mcp.transport_failed", "cause", "write_deadline_unavailable", "error", err)
		inferenceError(w, err)
		return
	}
	exchange := &mcpExchange{request: r.Context(), logger: logger, owner: owner, host: r.Host}
	request := r.Clone(context.WithValue(r.Context(), mcpExchangeKey{}, exchange))
	request.Header.Del("Authorization")
	handler := h.mcpHandler
	if handler == nil {
		handler = h.newMCPHandler()
	}
	handler.ServeHTTP(w, request)
	h.finishMCPOutput(w, controller, exchange)
}

func startMCPTool(ctx context.Context) (*mcpExchange, context.Context, func()) {
	exchange := ctx.Value(mcpExchangeKey{}).(*mcpExchange)
	// Older Streamable HTTP versions can disconnect without cancelling the SDK tool context.
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(exchange.request, cancel)
	return exchange, bounded, func() { stop(); cancel() }
}

func mcpFailure(l *slog.Logger, err error) error {
	var rejected *inference.Rejection
	if errors.As(err, &rejected) {
		level := slog.LevelWarn
		if rejected.Code >= 500 && rejected.Reason != "no_ready_worker" {
			level = slog.LevelError
		}
		l.Log(context.Background(), level, "mcp.tool_rejected", "cause", rejected.Reason, "status", rejected.Code,
			"evidence", rejected.Fields, "outcome", "rejected")
		return errors.New(rejected.Reason)
	}
	l.Error("mcp.tool_failed", "cause", err.Error(), "outcome", "failed")
	return errors.New("service_unavailable")
}

func (h *Handler) askMuse(ctx context.Context, _ *mcp.CallToolRequest, input mcpPrompt) (*mcp.CallToolResult, mcpAnswer, error) {
	exchange, ctx, cleanup := startMCPTool(ctx)
	defer cleanup()
	l := exchange.logger.With("tool", "ask_muse")
	if strings.TrimSpace(input.Prompt) == "" {
		return nil, mcpAnswer{}, mcpFailure(l, inference.Reject("invalid_prompt", 400))
	}
	admitted, err := h.Broker.SubmitRequest(ctx, l, exchange.owner, "", inference.RequestInput{
		Version: inference.Version, SubmissionID: input.Submission, TimeoutSeconds: 300,
		Messages: []inference.Item{{Type: "message", Role: "user", Text: input.Prompt}}, Tools: []inference.Tool{},
	})
	if err != nil {
		return nil, mcpAnswer{}, mcpFailure(l, err)
	}
	l = l.With("operation_id", admitted.ID, "request_record_id", admitted.ID, "conversation_id", admitted.ConversationID, "session_id", admitted.SessionID)
	l.Info("mcp.text_admitted", "state", admitted.State, "timeout_seconds", 300, "write_timeout_seconds", 5, "outcome", "waiting")
	admitted, err = h.Broker.AwaitRequest(ctx, l, exchange.owner, admitted)
	if err != nil {
		if ctx.Err() != nil {
			cancelled, cancelErr := h.Broker.CancelChat(ctx, l, exchange.owner, admitted)
			if cancelErr != nil {
				l.Error("mcp.text_cancel_failed", "cause", cancelErr.Error(), "observed_state", admitted.State, "outcome", "uncertain")
			} else {
				l.Info("mcp.text_cancelled", "cause", "request_context_cancelled", "observed_state", cancelled.State, "output_accepted", cancelled.Output != nil)
			}
			return nil, mcpAnswer{}, errors.New("request_context_cancelled")
		}
		return nil, mcpAnswer{}, mcpFailure(l, err)
	}
	if admitted.Output.Type != "final" {
		return nil, mcpAnswer{}, mcpFailure(l, errors.New("unexpected_text_decision"))
	}
	if err = h.Broker.OutputBoundary(ctx, l, exchange.owner, admitted.ID, false, 0, 0, ""); err != nil {
		return nil, mcpAnswer{}, mcpFailure(l, err)
	}
	exchange.mu.Lock()
	exchange.outputs = append(exchange.outputs, admitted.ID)
	exchange.mu.Unlock()
	answer := mcpAnswer{Text: admitted.Output.Text, RequestID: admitted.ID}
	l.Debug("mcp.text_result", "output", answer)
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: answer.Text}}}, answer, nil
}

func (h *Handler) finishMCPOutput(w *response, controller *http.ResponseController, exchange *mcpExchange) {
	exchange.mu.Lock()
	outputs := exchange.outputs
	exchange.mu.Unlock()
	if len(outputs) == 0 {
		return
	}
	cause := ""
	switch {
	case w.writeErr != nil:
		cause = w.writeErr.Error()
	case w.written == 0 || w.code != http.StatusOK:
		cause = "mcp_response_not_written"
	default:
		if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
			w.writeErr = err
			cause = err.Error()
		}
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(exchange.request), 5*time.Second)
	defer cancel()
	for _, id := range outputs {
		if err := h.Broker.OutputBoundary(ctx, exchange.logger, exchange.owner, id, true, w.attempted, w.written, cause); err != nil {
			w.boundaryFailed = true
			exchange.logger.Error("mcp.output_completion_uncertain", "operation_id", id, "cause", err.Error(), "outcome", "uncertain")
		}
	}
}

func (h *Handler) generateMCPMedia(format string) mcp.ToolHandlerFor[mcpPrompt, mcpMediaResult] {
	return func(ctx context.Context, request *mcp.CallToolRequest, input mcpPrompt) (*mcp.CallToolResult, mcpMediaResult, error) {
		exchange, ctx, cleanup := startMCPTool(ctx)
		defer cleanup()
		l := exchange.logger.With("tool", request.Params.Name, "format", format)
		if h.Broker.Media == nil {
			return nil, mcpMediaResult{}, mcpFailure(l, errors.New("media_store_unavailable"))
		}
		data, err := h.Broker.SubmitPromptMedia(ctx, l, exchange.owner, input.Submission, format, input.Prompt)
		if err != nil {
			return nil, mcpMediaResult{}, mcpFailure(l, err)
		}
		var job mcpMediaResult
		if err = json.Unmarshal(data, &job); err != nil {
			return nil, mcpMediaResult{}, mcpFailure(l, err)
		}
		job.RetryAfterSeconds = 60
		return nil, job, nil
	}
}

func (h *Handler) downloadMCPMedia(kind string) mcp.ToolHandlerFor[mcpJob, mcpMediaResult] {
	return func(ctx context.Context, request *mcp.CallToolRequest, input mcpJob) (*mcp.CallToolResult, mcpMediaResult, error) {
		exchange, ctx, cleanup := startMCPTool(ctx)
		defer cleanup()
		l := exchange.logger.With("tool", request.Params.Name, "media_type", kind)
		if !workerIDPattern.MatchString(input.ID) {
			return nil, mcpMediaResult{}, mcpFailure(l, inference.Reject("invalid_job_id", 400))
		}
		l = l.With("job_id", input.ID, "operation_id", input.ID)
		if h.Broker.Media == nil {
			return nil, mcpMediaResult{}, mcpFailure(l, errors.New("media_store_unavailable"))
		}
		status, err := h.pollMedia(ctx, l, exchange.owner, input.ID, exchange.host, kind)
		if err != nil {
			return nil, mcpMediaResult{}, mcpFailure(l, err)
		}
		result := mcpMediaResult{ID: status.ID, State: status.State, Reason: status.Reason,
			RetryAfterSeconds: status.RetryAfterSeconds, DownloadURL: status.DownloadURL}
		if status.Expired {
			result.State, result.Reason = "expired", "artifact_expired"
		}
		if status.ExpiresAt != nil {
			result.ExpiresAt = status.ExpiresAt.Format(time.RFC3339Nano)
		}
		return nil, result, nil
	}
}
