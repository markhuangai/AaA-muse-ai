package httpapi

import (
	"encoding/base64"
	"log/slog"
	"net/http"
	"regexp"

	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

const weeklyUsageHeader = "X-Muse-Worker-Weekly-Usage"
const maxWeeklyUsageBytes = 256

var resetLabel = regexp.MustCompile(`^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12][0-9]|3[01]) at ([1-9]|1[0-2]):[0-5][0-9] [AP]M (UTC|GMT|[ECMP][SD]T)$`)

func readWeeklyUsage(headers http.Header, logger *slog.Logger) *worker.WeeklyUsage {
	values := headers.Values(weeklyUsageHeader)
	if len(values) == 0 {
		return nil
	}
	var reading worker.WeeklyUsage
	if len(values) == 1 && len(values[0]) <= base64.RawURLEncoding.EncodedLen(maxWeeklyUsageBytes) {
		body, err := base64.RawURLEncoding.Strict().DecodeString(values[0])
		if err == nil && decodeInferenceInput(body, &reading, "used_percent", "observed_at") == nil &&
			reading.UsedPercent >= 0 && reading.UsedPercent <= 100 && !reading.ObservedAt.IsZero() &&
			(reading.ResetLabel == "" || resetLabel.MatchString(reading.ResetLabel)) {
			reading.ObservedAt = reading.ObservedAt.UTC()
			return &reading
		}
	}
	logger.Warn("worker.weekly_usage_rejected", "reason", "invalid_weekly_usage_header")
	return nil
}
