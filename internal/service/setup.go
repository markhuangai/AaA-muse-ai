package service

import (
	"context"
	"errors"
	"log/slog"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/worker"
	"time"
)

var ErrWorkerPackageUnconfigured = errors.New("worker_package_unconfigured")
var ErrSetupOrigin = errors.New("https_origin_required")

type PackagePin = worker.PackagePin

type SetupPrompt struct {
	EnrollmentID  string     `json:"enrollment_id"`
	CreatedAt     time.Time  `json:"created_at"`
	ExpiresAt     time.Time  `json:"expires_at"`
	WorkerPackage PackagePin `json:"worker_package"`
	Prompt        string     `json:"setup_prompt"`
}

type Setup struct {
	workers *Workers
	pin     PackagePin
}

func NewSetup(workers *Workers, pin PackagePin) *Setup {
	return &Setup{workers: workers, pin: pin}
}

func validSetupOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		u.Path != "" || strings.ContainsAny(origin, "?#") || strings.HasSuffix(u.Host, ":") {
		return false
	}
	if strings.HasPrefix(u.Host, "[") {
		address, err := netip.ParseAddr(u.Hostname())
		if err != nil || !address.Is6() || address.Zone() != "" {
			return false
		}
	} else if strings.Contains(u.Hostname(), ":") {
		return false
	}
	if port := u.Port(); port != "" {
		number, err := strconv.Atoi(port)
		return err == nil && number >= 1 && number <= 65535
	}
	return true
}

func (s *Setup) Create(ctx context.Context, logger *slog.Logger, origin string) (SetupPrompt, error) {
	if !validSetupOrigin(origin) {
		logger.Warn("setup.origin_rejected", "cause", ErrSetupOrigin.Error(), "origin_bytes", len(origin), "outcome", "not_started")
		return SetupPrompt{}, ErrSetupOrigin
	}
	if _, valid := ReleaseMajor(s.pin.Version); !valid || !archiveDigest.MatchString(s.pin.SHA256) {
		logger.Error("setup.package_unconfigured", "cause", ErrWorkerPackageUnconfigured.Error(), "outcome", "not_started")
		return SetupPrompt{}, ErrWorkerPackageUnconfigured
	}
	e, code, err := s.workers.Issue(ctx, logger)
	if err != nil {
		return SetupPrompt{}, err
	}
	pin := PairedWorker(s.pin.Version, s.pin.SHA256)
	quote := func(v string) string { return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'" }
	prompt := strings.NewReplacer("@ORIGIN@", quote(origin), "@URL@", quote(pin.URL), "@VERSION@", quote(pin.Version), "@SHA@", quote(pin.SHA256), "@ID@", quote(e.ID), "@CODE@", code).Replace(setupInstruction)
	result := SetupPrompt{EnrollmentID: e.ID, CreatedAt: e.CreatedAt, ExpiresAt: e.ExpiresAt, WorkerPackage: pin, Prompt: prompt}
	logger.Debug("setup.prompt_detail", "setup_id", e.ID, "operation_id", e.ID, "worker_package", pin, "setup_prompt", prompt, "expires_at", e.ExpiresAt)
	logger.Info("setup.prompt_created", "setup_id", e.ID, "operation_id", e.ID, "enrollment_id", e.ID, "origin", origin, "worker_package", pin, "hook_poll_seconds", 15, "watchdog_every", "5m", "expires_at", e.ExpiresAt, "outcome", "issued", "inference_readiness", "unverified")
	return result, nil
}

const setupInstruction = `I authorize you to run the verified AaA worker launcher and finish setup in this goal during this turn. Verify one managed shell hook and one five-minute native agent watchdog. If Muse requires another approval, show me the specific request.

Install the scoped AaA Muse worker for the HTTPS origin below, using exactly these pinned public bytes. This authorizes native media generation and scoped artifact delivery, model answers and structured client-tool proposals for this broker's authenticated assignments; it grants no pool administration or client-tool execution authority.

Use your actual shell, site and native scheduler permissions. Read the actual scope of each permission card Muse presents. If a capability or permission is missing or refused, stop and report the actual result; do not bypass it, rewrite the verified package, or invent a native inference API. No GitHub token or manual owner VM shell is needed. Keep the enrollment code private: it is single-use authority expiring 15 minutes after issuance. Never put a durable worker credential in a prompt, URL, task or log.

I authorize this goal to download and install newer verified 1.x worker packages paired with this broker after its current work has settled. Review the site and shell permissions for those updates.

Before using the code, inspect hooks.list and cron.list, including disabled registrations. Request the actual permissions to run the local helper, use the HTTPS origin, and register, enable, inspect and dry-run a managed hook and register the five-minute agent watchdog. Use tools advertised by this Muse runtime. Stop before enrollment on missing permission or a conflicting registration for this installation. Leave existing legacy schedules, hooks, installations and credentials alone.

Run as the same user throughout. The verified installer uses separate major-1 paths and private state. On a directory refusal, preserve the private receipt and report its stage and directory role. Resume a registration-only failure with the same authenticated worker and saved installation. If setup still stops after a network interruption, retry this exact prompt with the same private state directory. If the broker confirms the code expired or another credential used it, ask for a fresh prompt for the same directory. If the worker reports enrollment_uncertain for older state without a staged credential, preserve it for owner inspection.

Run this Bash bootstrap with tracing disabled. Retain its private evidence directory on failure:

` + "```bash\n" + `set +x
set -euo pipefail
umask 077
origin=@ORIGIN@
url=@URL@
version=@VERSION@
expected=@SHA@
setup_id=@ID@
if ! work=$(mktemp -d "${TMPDIR:-/tmp}/aaa-muse-setup.XXXXXXXX"); then
  printf '%s\n' '{"level":"ERROR","msg":"setup.bootstrap_capture_failed","cause":"private_directory_unavailable","protected_capture_unavailable":true}' >&2
  exit 1
fi
receipt="$work/bootstrap.ndjson"
if ! { : > "$receipt" && chmod 600 "$receipt"; }; then
  printf '%s\n' '{"level":"ERROR","msg":"setup.bootstrap_capture_failed","cause":"private_receipt_unavailable","protected_capture_unavailable":true}' >&2
  exit 1
fi
event() {
  local line
  line=$(printf '{"level":"%s","msg":"%s","setup_id":"%s","operation_id":"%s","stage":"bootstrap","package_version":"%s","expected_digest":"%s","observed_digest":"%s","execution_started":false}' "$1" "$2" "$setup_id" "$setup_id" "$version" "$expected" "${observed:-}")
  if ! printf '%s\n' "$line" >> "$receipt"; then
    trap - ERR
    printf '{"level":"ERROR","msg":"setup.bootstrap_capture_failed","setup_id":"%s","stage":"bootstrap","cause":"receipt_append_failed","protected_capture_unavailable":true,"execution_started":false}\n' "$setup_id" >&2
    exit 1
  fi
  printf '%s\n' "$line" >&2
}
trap 'event ERROR setup.bootstrap_failed' ERR
event INFO setup.bootstrap_started
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 "$url" --output "$work/worker.tgz"
observed=$(sha256sum "$work/worker.tgz"); observed=${observed%% *}
if [[ "$observed" != "$expected" ]]; then event ERROR setup.digest_mismatch; exit 1; fi
actual_version=$(tar -xOzf "$work/worker.tgz" package/package.json | sed -nE 's/^  "version": "([A-Za-z0-9.+-]+)",?$/\1/p')
actual_name=$(tar -xOzf "$work/worker.tgz" package/package.json | sed -nE 's/^  "name": "([@A-Za-z0-9/_-]+)",?$/\1/p')
if [[ "$actual_version" != "$version" || "$actual_name" != '@markhuangai/aaa-muse-worker' ]]; then event ERROR setup.package_mismatch; exit 1; fi
event INFO setup.archive_verified
tar -xzf "$work/worker.tgz" --no-same-owner --no-same-permissions -C "$work" package/setup/install.sh
bash "$work/package/setup/install.sh" "$work/worker.tgz" "$version" "$expected" "$origin" "$setup_id" "$receipt" <<'AAA_MUSE_ENROLLMENT'
@CODE@
AAA_MUSE_ENROLLMENT
` + "```\n" + `
Verify the installer receipt, authenticated worker ID and skill. Use the installed launcher with hook-describe --goal-id and this goal's actual ID. It returns the exact hook and watchdog definitions. Read hooks.list and cron.list again, including disabled registrations, then inspect all matches for the returned hook ID and watchdog name in this goal.

Authorize each registration separately with hook-authorize-registration --input -. Pass the goal_id, complete: true, target: "hook" or "watchdog", and arrays of matching hooks and watchdogs. Normalize each native record to the definition's fields and include native_job_id from the actual watchdog record. Empty arrays require a complete listing that proves absence. Reuse exact matches. If add_hook is true use hooks.add with the exact path and prompt, poll_interval_secs: 15, and script_timeout_secs: 120. Use hooks.enable if requested, then hooks.dry_run and require a silent result. Re-read both listings before authorizing the watchdog. If add_watchdog is true use cron.add with the returned name and prompt, every: "5m", execution.kind: agent, enabled: true. After a write or uncertain reply, read the actual records before retrying. An ambiguous absence requires operator inspection.

Call hook-confirm --input - with goal_id, complete: true, dry_run: "silent" and the exact enabled hook and watchdog readbacks in hooks and watchdogs. Report their IDs only after the helper returns registered. A normal shell tick wakes an agent only when it has a broker claim. The five-minute watchdog checks local evidence and reports incidents to the owning chat.

End this installation turn before attempting work. Leave the first work check to the scheduler. Do not claim first unattended execution, model readiness, production HTTPS pickup, refresh survival or VM-loss recovery without exact live observations. Full wipes, account resets and production deployments need separate owner authorization.

Exact hook-confirm readback verifies the background task prompt. The hook can wake an agent for an authorized inference, media, or background task claim.
`
