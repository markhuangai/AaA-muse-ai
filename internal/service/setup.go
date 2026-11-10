package service

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
)

var ErrWorkerPackageUnconfigured = errors.New("worker_package_unconfigured")

type PackagePin struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	URL     string `json:"url"`
}

type SetupPrompt struct {
	EnrollmentID  string     `json:"enrollment_id"`
	CreatedAt     time.Time  `json:"created_at"`
	ExpiresAt     time.Time  `json:"expires_at"`
	WorkerPackage PackagePin `json:"worker_package"`
	Prompt        string     `json:"setup_prompt"`
}

type Setup struct {
	workers *Workers
	origin  string
	pin     config.WorkerPackage
}

func NewSetup(workers *Workers, origin string, pin config.WorkerPackage) *Setup {
	return &Setup{workers: workers, origin: strings.TrimSuffix(origin, "/"), pin: pin}
}

func (s *Setup) Create(ctx context.Context, logger *slog.Logger) (SetupPrompt, error) {
	if s.pin.Version == "" || s.pin.SHA256 == "" {
		logger.Error("setup.package_unconfigured", "cause", ErrWorkerPackageUnconfigured.Error(), "outcome", "not_started")
		return SetupPrompt{}, ErrWorkerPackageUnconfigured
	}
	e, code, err := s.workers.Issue(ctx, logger)
	if err != nil {
		return SetupPrompt{}, err
	}
	pin := PackagePin{Name: "@markhuangai/aaa-muse-worker", Version: s.pin.Version, SHA256: s.pin.SHA256,
		URL: "https://github.com/markhuangai/AaA-muse-ai/releases/download/worker-v" + s.pin.Version + "/markhuangai-aaa-muse-worker-" + s.pin.Version + ".tgz"}
	quote := func(v string) string { return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'" }
	prompt := strings.NewReplacer("@ORIGIN@", quote(s.origin), "@URL@", quote(pin.URL), "@VERSION@", quote(pin.Version), "@SHA@", quote(pin.SHA256), "@ID@", quote(e.ID), "@CODE@", code).Replace(setupInstruction)
	result := SetupPrompt{EnrollmentID: e.ID, CreatedAt: e.CreatedAt, ExpiresAt: e.ExpiresAt, WorkerPackage: pin, Prompt: prompt}
	logger.Debug("setup.prompt_detail", "setup_id", e.ID, "operation_id", e.ID, "worker_package", pin, "setup_prompt", prompt, "expires_at", e.ExpiresAt)
	logger.Info("setup.prompt_created", "setup_id", e.ID, "operation_id", e.ID, "enrollment_id", e.ID, "worker_package", pin, "expires_at", e.ExpiresAt, "outcome", "issued", "inference_readiness", "unverified")
	return result, nil
}

const setupInstruction = `Install the scoped AaA Muse worker for the HTTPS origin below, using exactly these pinned public bytes. This authorizes model answers and structured client-tool proposals for this broker's authenticated assignments; it grants no pool administration or client-tool execution authority.

Use your actual shell, site and hook permissions. Present permission cards to the owner and read their actual scope. If a capability or permission is missing or refused, stop and report the actual result; do not bypass it, rewrite the verified package, or invent a native inference API. No GitHub token or manual owner VM shell is needed. Keep the enrollment code private: it is single-use authority expiring 15 minutes after issuance. Never put a durable worker credential in a prompt, URL, hook, task or log.

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
Read the installer receipt. Verify its authenticated worker ID and retain the exact hook and skill paths. Call hooks.list with include_disabled:true. Reuse the single enabled hook with this exact script_path and five-second schedule; do not add another. If the existing hook is disabled, conflicting or cannot use five-second checks, report the actual unsupported boundary and stop. Otherwise call the supported hooks.add with this script_path and no script arguments, request five-second checks, and verify the actual registration and interval. The hook includes the supported-refresh recovery candidate; never invent a scheduler or assume its persistence. Stop on missing HATCH_HOOK_RUNTIME or unsupported wake/silent functions. Dry runs must remain side-effect free.

Verify the worker-specific SKILL.md at the returned path, discoverable through muse.skill_search in later conversations. It records only nonsecret scope and mechanics. Model jobs must be read with job-show and answered with decision-submit using the exact job and receipt linkage. Propose client tools as structured JSON; the calling client executes them locally. Do not execute them on this VM or invent results. Connection health, detector emission and model readiness are separate facts.

End this installation turn now. Do not read or answer an inference-readiness challenge during setup. A later independent background wake must prove that behavior. Live Muse permission behavior, five-second wake cadence, persistent paths and supported-refresh reconnection remain unverified until the owner's separate issue #7 trial. Full wipes, account resets and revoked identities are outside recovery authority.
`
