package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Redactor struct{ secrets []string }

var workerSecrets = regexp.MustCompile(`muse_(?:enroll|worker)_[A-Za-z0-9_-]{43}`)

func RedactWorkerSecrets(value string) string {
	return (&Redactor{}).text(value)
}

func NewRedactor(secrets []string) *Redactor {
	values := append([]string{}, secrets...)
	for _, secret := range secrets {
		encoded, _ := json.Marshal(secret)
		escaped := string(encoded[1 : len(encoded)-1])
		if escaped != secret {
			values = append(values, escaped)
		}
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	return &Redactor{secrets: values}
}
func (r *Redactor) text(value string) string {
	var spans [][]int
	for offset := 0; offset < len(value); {
		match := workerSecrets.FindStringIndex(value[offset:])
		if match == nil {
			break
		}
		start := offset + match[0]
		spans = append(spans, []int{start, offset + match[1]})
		offset = start + 1
	}
	for _, secret := range r.secrets {
		if secret == "" {
			continue
		}
		for offset := 0; offset < len(value); {
			index := strings.Index(value[offset:], secret)
			if index < 0 {
				break
			}
			start := offset + index
			spans = append(spans, []int{start, start + len(secret)})
			offset = start + 1
		}
	}
	if len(spans) == 0 {
		return value
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i][0] < spans[j][0] })
	var out strings.Builder
	offset := 0
	for i := 0; i < len(spans); {
		start, end := spans[i][0], spans[i][1]
		i++
		for i < len(spans) && spans[i][0] <= end {
			end = max(end, spans[i][1])
			i++
		}
		out.WriteString(value[offset:start])
		out.WriteString("[REDACTED]")
		offset = end
	}
	out.WriteString(value[offset:])
	return out.String()
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
		var masked []string
		for k, x := range v {
			if r.text(k) == k {
				out[k] = r.value(k, x)
			} else {
				masked = append(masked, k)
			}
		}
		sort.Strings(masked)
		for _, k := range masked {
			base := r.text(k)
			key := base
			for suffix := 2; ; suffix++ {
				if _, exists := out[key]; !exists {
					break
				}
				key = base + "#" + strconv.Itoa(suffix)
			}
			out[key] = r.value(k, v[k])
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
		return slog.String(r.text(a.Key), "[UNENCODABLE]")
	}
	var plain any
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.UseNumber()
	if decoder.Decode(&plain) != nil {
		return slog.String(r.text(a.Key), "[UNENCODABLE]")
	}
	return slog.Any(r.text(a.Key), r.value(a.Key, plain))
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
