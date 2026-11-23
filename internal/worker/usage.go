package worker

import "time"

const WeeklyUsageFreshness = 2 * time.Minute

type WeeklyUsage struct {
	UsedPercent float64   `json:"used_percent"`
	ObservedAt  time.Time `json:"observed_at"`
	ResetLabel  string    `json:"reset_label,omitempty"`
}

func (u *WeeklyUsage) Fresh(now time.Time) bool {
	return u != nil && !u.ObservedAt.After(now) && u.ObservedAt.After(now.Add(-WeeklyUsageFreshness))
}

type WeeklyUsageView struct {
	WeeklyUsage
	Stale bool `json:"stale"`
}
