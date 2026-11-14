package service

import "regexp"

var portalHistoryCursor = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)

func (r PortalReport) validHistoryReport() bool {
	if r.WorkerID != "" || !oneOf(r.QueryKind, "requests", "request", "timeline", "cancel", "workers") || len(r.Cursor) > 1024 || !portalHistoryCursor.MatchString(r.Cursor) ||
		(r.ConversationID != "" && !portalIdentifier.MatchString(r.ConversationID)) || (r.RequestRecordID != "" && !portalIdentifier.MatchString(r.RequestRecordID)) ||
		r.RequestSequence < 1 || r.RequestSequence > 9007199254740991 || r.AcceptedSequence < 0 || r.AcceptedSequence > 9007199254740991 ||
		r.LatestSequence < r.RequestSequence || r.LatestSequence < r.AcceptedSequence || r.LatestSequence > 9007199254740991 || r.SessionGeneration < 0 || r.SessionGeneration > 9007199254740991 ||
		r.QueryGeneration < 0 || r.QueryGeneration > 9007199254740991 || r.SelectionGeneration < 0 || r.SelectionGeneration > 9007199254740991 {
		return false
	}
	if r.Event == "portal.render_failed" {
		return r.Cause == "render_exception" && r.Expected == "rendered" && r.Observed == "failed"
	}
	if r.Expected != "fresh" || r.Observed != "stale" {
		return false
	}
	if r.Event == "portal.cancel_result" {
		return r.QueryKind == "cancel" && r.RequestRecordID != "" && oneOf(r.Cause, "request_failed", "request_timeout", "invalid_response")
	}
	return r.Event == "portal.history_load_failed" && oneOf(r.Cause, "request_failed", "request_timeout", "service_unavailable", "stale_data", "obsolete_response", "invalid_response")
}
