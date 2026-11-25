package inference

import (
	"context"
	"strings"
)

const VerifiedClaimPrefix = "verified-"
const HookClaimPrefix = "hook-"

func VerifiedClaim(id string) bool {
	return strings.HasPrefix(id, VerifiedClaimPrefix)
}

func HookClaim(id string) bool { return strings.HasPrefix(id, HookClaimPrefix) }

type HookPair struct {
	Version string `json:"version"`
	Digest  string `json:"sha256"`
}

type hookPairKey struct{}

func WithHookPair(ctx context.Context, pair HookPair) context.Context {
	return context.WithValue(ctx, hookPairKey{}, pair)
}

func PairedHook(ctx context.Context) (HookPair, bool) {
	pair, ok := ctx.Value(hookPairKey{}).(HookPair)
	return pair, ok
}

func RequireHookPair(receipt *NativeWorkReceipt, pair HookPair) error {
	if receipt == nil || receipt.Mode != "hook" {
		return Reject("hook_claim_required", 409)
	}
	if receipt.Pair != pair {
		return Reject("native_start_pair_mismatch", 409, "expected_pair", receipt.Pair, "observed_pair", pair,
			"corrective_action", "Resume the held claim on its original paired release before upgrading.")
	}
	return nil
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
	Mode       string            `json:"mode,omitempty"`
	Pair       HookPair          `json:"pair,omitzero"`
	Invocation string            `json:"wake_invocation_id,omitempty"`
}

func (r NativeWorkReceipt) WakeInvocation() string {
	if r.Invocation != "" {
		return r.Invocation
	}
	return r.Occurrence
}

func (r NativeWorkReceipt) WakeRun() string { return "event-hook-" + r.WakeInvocation() }

func (r NativeWorkReceipt) IsChecker(id string, presence *BusyPresence) bool {
	return id != "" && (id == r.Checker || id == r.Occurrence || (presence != nil && id == presence.Occurrence))
}
