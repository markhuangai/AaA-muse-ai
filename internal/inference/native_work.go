package inference

import "strings"

const VerifiedClaimPrefix = "verified-"

func VerifiedClaim(id string) bool {
	return strings.HasPrefix(id, VerifiedClaimPrefix)
}

type NativeStartProof struct {
	Reference string `json:"reference"`
	NativeJob string `json:"native_job_id"`
	NativeRun string `json:"native_run_id"`
	Status    string `json:"status"`
}

type NativeWorkReceipt struct {
	Checker    string            `json:"checker_job_id"`
	Occurrence string            `json:"checker_run_id"`
	Start      *NativeStartProof `json:"start,omitempty"`
}

func (r NativeWorkReceipt) IsChecker(id string, presence *BusyPresence) bool {
	return id != "" && (id == r.Checker || id == r.Occurrence || (presence != nil && id == presence.Occurrence))
}
