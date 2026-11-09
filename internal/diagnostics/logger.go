package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Redactor struct{ secrets []string }

func NewRedactor(secrets []string) *Redactor {
	values := append([]string{}, secrets...)
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	return &Redactor{secrets: values}
}
func (r *Redactor) text(value string) string {
	for _, secret := range r.secrets {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[REDACTED]")
		}
	}
	return value
}
func (r *Redactor) value(key string, value any) any {
	lower := strings.ToLower(key)
	for _, sensitive := range []string{"password", "authorization", "cookie", "secret", "token", "credential", "enrollment_code"} {
		if strings.Contains(lower, sensitive) {
			return "[REDACTED]"
		}
	}
	if lower == "key" || lower == "api_key" || lower == "client_keys" {
		return "[REDACTED]"
	}
	switch v := value.(type) {
	case string:
		return r.text(v)
	case map[string]any:
		out := map[string]any{}
		for k, x := range v {
			out[k] = r.value(k, x)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = r.value("", x)
		}
		return out
	default:
		return v
	}
}
func (r *Redactor) Replace(_ []string, a slog.Attr) slog.Attr {
	if a.Key == slog.TimeKey || a.Key == slog.LevelKey || a.Key == slog.MessageKey {
		return a
	}
	value := a.Value.Resolve().Any()
	b, err := json.Marshal(value)
	if err != nil {
		return slog.String(a.Key, "[UNENCODABLE]")
	}
	var plain any
	if json.Unmarshal(b, &plain) != nil {
		return slog.String(a.Key, "[UNENCODABLE]")
	}
	return slog.Any(a.Key, r.value(a.Key, plain))
}

type handler struct {
	stdout, capture slog.Handler
	failed          func(error)
	once            *sync.Once
	now             func() time.Time
}

func NewLogger(stdout io.Writer, store io.Writer, level slog.Level, redactor *Redactor, now func() time.Time, failed func(error)) *slog.Logger {
	return slog.New(&handler{stdout: slog.NewJSONHandler(stdout, &slog.HandlerOptions{Level: level, ReplaceAttr: redactor.Replace}), capture: slog.NewJSONHandler(store, &slog.HandlerOptions{Level: slog.LevelDebug, ReplaceAttr: redactor.Replace}), failed: failed, once: &sync.Once{}, now: now})
}
func (h *handler) Enabled(_ context.Context, level slog.Level) bool { return level >= slog.LevelDebug }
func (h *handler) Handle(ctx context.Context, r slog.Record) error {
	r.Time = h.now().UTC()
	if err := h.capture.Handle(ctx, r); err != nil {
		h.once.Do(func() { h.failed(err) })
		return err
	}
	if h.stdout.Enabled(ctx, r.Level) {
		if err := h.stdout.Handle(ctx, r); err != nil {
			h.once.Do(func() { h.failed(err) })
			return err
		}
	}
	return nil
}
func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &handler{stdout: h.stdout.WithAttrs(attrs), capture: h.capture.WithAttrs(attrs), failed: h.failed, once: h.once, now: h.now}
}
func (h *handler) WithGroup(name string) slog.Handler {
	return &handler{stdout: h.stdout.WithGroup(name), capture: h.capture.WithGroup(name), failed: h.failed, once: h.once, now: h.now}
}

func Cause(err error) string {
	if errors.Is(err, fs.ErrPermission) {
		return "filesystem_permission_denied"
	}
	if errors.Is(err, syscall.ENOSPC) {
		return "filesystem_capacity_exhausted"
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "filesystem_path_missing"
	}
	return "capture_io_failed"
}
