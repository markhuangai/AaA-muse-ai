package httpapi

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"unicode"

	"github.com/markhuangai/AaA-muse-ai/internal/diagnostics"
	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const modelReportHeader = "X-Muse-Worker-Model-Report"
const maxModelReportBytes = 512

func (h *Handler) readModelReport(headers http.Header) (*inference.ModelReport, error) {
	values := headers.Values(modelReportHeader)
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) != 1 || len(values[0]) > base64.RawURLEncoding.EncodedLen(maxModelReportBytes) {
		return nil, errors.New("invalid_model_report_header")
	}
	body, err := base64.RawURLEncoding.Strict().DecodeString(values[0])
	if err != nil {
		return nil, errors.New("invalid_model_report_encoding")
	}
	var report inference.ModelReport
	if err = inference.Decode(body, &report); err != nil {
		return nil, err
	}
	if report.ReportedAt.IsZero() || (report.ModelName == nil && report.ContextWindowTokens == nil) {
		return nil, errors.New("incomplete_model_report")
	}
	if report.ModelName != nil {
		name := *report.ModelName
		if strings.TrimSpace(name) == "" || len(name) > 128 || strings.ContainsFunc(name, unicode.IsControl) {
			return nil, errors.New("invalid_model_name")
		}
		redact := diagnostics.RedactWorkerSecrets
		if h.Redactor != nil {
			redact = h.Redactor.Text
		}
		if redact(name) != name {
			return nil, errors.New("model_name_contains_credential")
		}
	}
	if report.ContextWindowTokens != nil && (*report.ContextWindowTokens < 1 || *report.ContextWindowTokens > 1<<53-1) {
		return nil, errors.New("invalid_context_window")
	}
	report.ReportedAt = report.ReportedAt.UTC()
	return &report, nil
}
