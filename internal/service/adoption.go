package service

import (
	"log/slog"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
	"github.com/markhuangai/AaA-muse-ai/internal/worker"
)

func AdoptionPrompt(logger *slog.Logger, origin, workerID string, target *worker.UpdateTarget) (string, error) {
	if !validSetupOrigin(origin) {
		return "", ErrSetupOrigin
	}
	if target == nil {
		return "", ErrWorkerPackageUnconfigured
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	prompt := strings.NewReplacer("@ORIGIN@", quote(origin), "@URL@", quote(target.URL),
		"@VERSION@", quote(target.Version), "@SHA@", quote(target.SHA256), "@WORKER@", quote(workerID)).Replace(adoptionInstruction)
	logger.Info("worker.update_prompt_created", "worker_id", workerID, "origin", origin, "target", target, "outcome", "issued")
	return prompt, nil
}

const adoptionInstruction = `Authorize this already enrolled AaA Muse worker to install the exact package paired with its authenticated broker when idle. Review the actual shell and HTTPS permissions for this and future paired releases. Keep the existing worker identity, private state and scheduled checker. Use the same VM user that installed it. If work or a pull is still pending, let the existing checker reconcile it and retry this prompt later. Preserve the private receipt if the command fails. Never create a second checker or enrollment.

Run this Bash command with tracing disabled. It checks the authenticated pin through the existing launcher and downloads the archive without credentials.

` + "```bash\n" + `set +x
set -euo pipefail
umask 077
origin=@ORIGIN@
worker=@WORKER@
url=@URL@
version=@VERSION@
expected=@SHA@
root="${XDG_DATA_HOME:-$HOME/.local/share}/aaa-muse-worker-v1"
launcher="$root/bin/aaa-muse-worker"
work=$(mktemp -d "${TMPDIR:-/tmp}/aaa-muse-adopt.XXXXXXXX")
status="$work/status.json"
receipt="$work/bootstrap.ndjson"
: > "$receipt"
"$launcher" status > "$status"
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 45 "$url" --output "$work/worker.tgz"
observed=$(sha256sum "$work/worker.tgz"); observed=${observed%% *}
if [[ "$observed" != "$expected" ]]; then
  printf '%s\n' '{"level":"ERROR","msg":"worker.update_verification_failed","cause":"archive_digest_mismatch"}' | tee -a "$receipt" >&2
  exit 1
fi
tar -xzf "$work/worker.tgz" --no-same-owner --no-same-permissions -C "$work" package/setup/install.sh
bash "$work/package/setup/install.sh" "$work/worker.tgz" "$version" "$expected" "$origin" "$worker" "$receipt" --adopt
` + "```\n" + `
Wait for the existing one-minute checker to report the paired version. “Awaiting confirmation” means the broker has yet to see that pickup.
`

func AdoptionError(err error) error {
	if err == ErrSetupOrigin {
		return inference.Reject(err.Error(), 400)
	}
	return inference.Reject(err.Error(), 503)
}
