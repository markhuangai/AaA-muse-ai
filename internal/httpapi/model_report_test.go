package httpapi

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
)

func TestHistoricalModelReportParserRejectsUnsupportedAndPrivateFields(t *testing.T) {
	h, _, _, _ := inferenceHTTPFixture(t)
	const reported = "2026-11-18T01:02:03Z"
	const fixtureName = "Controlled Muse"
	encodedAt := func(at, fragment string) string {
		return base64.RawURLEncoding.EncodeToString([]byte("{\"reported_at\":\"" + at + "\"," + fragment + "}"))
	}
	encoded := func(fragment string) string { return encodedAt(reported, fragment) }
	fields := "\"model_name\":\"" + fixtureName + "\",\"context_window_tokens\":350000"
	valid := encoded(fields)
	knownCredential := "client-private-sentinel"
	for _, tc := range []struct {
		values []string
		cause  string
		ok     bool
	}{
		{values: []string{valid}, ok: true},
		{values: []string{encodedAt("2026-11-18T02:02:03+01:00", fields)}, ok: true},
		{},
		{values: []string{valid, valid}, cause: "invalid_model_report_header"},
		{values: []string{strings.Repeat("a", 700)}, cause: "invalid_model_report_header"},
		{values: []string{"!invalid"}, cause: "invalid_model_report_encoding"},
		{values: []string{encodedAt("9999-12-31T23:59:59-01:00", fields)}, cause: "invalid_reported_at"},
		{values: []string{encoded("\"model_name\":\"x\",\"extra\":true")}, cause: "unsupported_field_spelling"},
		{values: []string{encoded("\"model_name\":null")}, cause: "incomplete_model_report"},
		{values: []string{encoded("\"model_name\":\"\\n\"")}, cause: "invalid_model_name"},
		{values: []string{encoded("\"model_name\":\"x\",\"context_window_tokens\":0")}, cause: "invalid_context_window"},
		{values: []string{encoded("\"model_name\":\"name " + knownCredential + "\"")}, cause: "model_name_contains_credential"},
	} {
		headers := make(http.Header)
		for _, value := range tc.values {
			headers.Add(modelReportHeader, value)
		}
		report, err := h.readModelReport(headers)
		if (report != nil) != tc.ok || (err == nil) != (tc.cause == "") {
			t.Fatalf("unexpected report availability or reason for %q", tc.cause)
		}
		if report != nil && (report.ReportedAt.Format("2006-01-02T15:04:05Z07:00") != reported || report.ModelName == nil ||
			*report.ModelName != fixtureName || report.ContextWindowTokens == nil || *report.ContextWindowTokens != 350000) {
			t.Fatal("model report snapshot changed")
		}
		if err != nil && (err.Error() != tc.cause || strings.Contains(err.Error(), knownCredential)) {
			t.Fatalf("wrong or unsafe rejection for %s", tc.cause)
		}
	}
}
