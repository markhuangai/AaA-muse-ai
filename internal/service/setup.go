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
	logger.Info("setup.prompt_created", "setup_id", e.ID, "operation_id", e.ID, "enrollment_id", e.ID, "origin", origin, "worker_package", pin, "expires_at", e.ExpiresAt, "outcome", "issued", "inference_readiness", "unverified")
	return result, nil
}

const setupInstruction = `I authorize you to run the verified AaA worker launcher and finish setup in this goal during this turn. Use the permissions already granted to register or reuse one visible one-minute checker and verify the saved job. If Muse requires another approval, show me the specific request.

Install the scoped AaA Muse worker for the HTTPS origin below, using exactly these pinned public bytes. This authorizes native media generation and scoped artifact delivery, model answers and structured client-tool proposals for this broker's authenticated assignments; it grants no pool administration or client-tool execution authority.

Use your actual shell, site and native scheduler permissions. Read the actual scope of each permission card Muse presents. If a capability or permission is missing or refused, stop and report the actual result; do not bypass it, rewrite the verified package, or invent a native inference API. No GitHub token or manual owner VM shell is needed. Keep the enrollment code private: it is single-use authority expiring 15 minutes after issuance. Never put a durable worker credential in a prompt, URL, task or log.

I authorize this goal to download and install future verified worker packages paired with this broker after its current work has settled. Review the site and shell permissions for those updates.

Before using the code, inspect this goal's native scheduled jobs, including disabled jobs. Request the actual permissions to run the local helper, use the HTTPS origin, and register, inspect and run a visible one-minute native agent cron and finite native agent runonce jobs owned by this goal. Use only tools advertised by this Muse runtime. Stop before enrollment on missing permission or a conflicting registration. Do not disable or reuse this account's major-0 schedule, hook, installation or credentials.

Run as the same user throughout. The verified installer uses separate major-1 paths and private state. On a directory refusal, preserve the private receipt and report its stage and directory role. Resume a registration-only failure with the same authenticated worker and saved installation. If setup still stops after a network interruption, retry this exact prompt with the same private state directory. If the worker reports enrollment_uncertain for older state without a staged credential, preserve it for owner inspection.

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
Verify the installer receipt, authenticated worker ID and skill. A successful installer result with cron_registration: pending means native registration is the next step. Continue with the enrolled worker in this turn. Invoke the exact launcher with cron-describe --goal-id and this goal's actual ID. List native schedules again, including disabled jobs. Reuse one exact enabled match by goal, name, every: "1m", execution.kind=agent and exact prompt. Only on a complete listing with definitive absence, invoke cron-authorize-registration --input - with the actual goal_id, complete: true and matches: []. Create one job only if the helper returns register. Preserve any conflicting or ambiguous match. After a write or uncertain reply, reread the native jobs; verify the saved goal, job ID, enabled state, interval and exact action before invoking cron-confirm --input - with JSON matches containing the verified definition and native_job_id. Setup is incomplete until this read-back succeeds. When cron-confirm returns registered, report the checker job ID. Do not create a second recurring job, background client, hook or private scheduler.

The recurring agent turn calls the installed helper once. Do not process model work in this turn: hand off each new claim to one finite native agent runonce, using the earliest supported absolute UTC due time inside the existing deadline. Keep run identities, helper outcomes and authoritative broker receipts distinct. Scheduler success does not prove pickup or completion. Return only a short safe outcome; keep credentials, request contents and file paths out of recurring and one-time run summaries.

End this installation turn before attempting work. Leave the first work check to the scheduler. Do not claim first unattended execution, model readiness, production HTTPS pickup, refresh survival or VM-loss recovery without exact live observations. Full wipes, account resets and production deployments need separate owner authorization.
`
