# AaA-muse-ai

A self-hosted broker that connects model clients to a Muse worker through outbound HTTPS/SSE. Muse proposes answers and client tool calls; the calling client applies its permissions, executes its tools, and returns their results.

## Status

One-account testing demonstrated background wake, authenticated replies, six basic client-tool trials, full-history continuation, fresh-conversation replay, and automatic hook-based subscriber reconnection. A later weather question completed through the same service and client-tool loop.

**Full qualification remains inconclusive:** interleaving failed in both runs, and the exact supported-refresh scope and formal recovery case remain incomplete. Full history is the baseline; the tested delta candidate is rejected. A passing live receipt still gates release work. Detailed [findings and receipts are in #7](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6784686856), with [reconnection](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6785064072) and [weather-demo](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6785270949) updates.

The experiment API and worker exist. The [native request API](docs/history-api.md) adds named-client canonical conversations, one decision per request, and management timelines. The management portal and OpenAI-compatible client endpoints are planned. Decision and evidence history is maintained in project memory.

The November 11, 2026 CI decision accepts the completed PoC investigation as the prerequisite for engineering gates in [#20](https://github.com/markhuangai/AaA-muse-ai/issues/20), while retaining the inconclusive qualification result. [Contributor checks](AGENTS.md#contributor-ci-checks) cover independent unit coverage, source-file limits, workflow budgets, and packaged integrations.

The separate November 11 [#8 approval](https://github.com/markhuangai/AaA-muse-ai/issues/8) permits canonical-history logic and controlled HTTP/PostgreSQL tests now, with live testing deferred. Existing qualification remains inconclusive; this exception does not establish live session isolation or release readiness.

The November 11 [#9 approval](https://github.com/markhuangai/AaA-muse-ai/issues/9) separately permits automatic capability routing and controlled software validation. Native requests can omit the worker ID, wait in a bounded queue, and retain a healthy session pin across answers. Management records authenticated qualification trials with explicit controlled/live provenance; reconnecting requires fresh evidence and approval. These software mechanisms do not resolve the failed interleaving or incomplete refresh qualification, and no live trial is authorized by this engineering change. See the [native API contract](docs/history-api.md).

The November 12 [#10 approval](https://github.com/markhuangai/AaA-muse-ai/issues/10) permits broker-recovery engineering and controlled validation. Startup reconciles PostgreSQL work before serving, preserves accepted decisions and tool waits, and retains uncertain claimed work under the existing 30-second health leases. A healthy sibling broker is preserved. The [recovery contract](docs/history-api.md#broker-restart-recovery) distinguishes receipt replay from renewed claim authority. This engineering exception grants no live Muse trial or release qualification.

The November 12 [#11 decision](https://github.com/markhuangai/AaA-muse-ai/issues/11) reaffirms the durable worker credentials approved in [#3 on November 9](https://github.com/markhuangai/AaA-muse-ai/issues/3), already implemented at source revision `c798f48dd2adabe704294cf2ceb929486feeac69`. It replaces #11's proposed credential expiry and renewal with documentation and controlled validation of the existing lifecycle, independently of #21. Live qualification and release requirements remain unchanged.

The November 12 [#12 approval](https://github.com/markhuangai/AaA-muse-ai/issues/12), based on `18e9317b76c506e5f33a31dc1e7a93b42c77123d`, permits worker-recovery engineering and controlled software validation. The development worker retries temporary startup and reconnect failures, reconciles existing evidence before resubscribing, and limits terminal-stop recording to the daemon owner. A healthy installation needs no repair or reinstall. No repair command, automatic inference retry, live trial, or publication is authorized; the published prerelease pin and inconclusive live qualification remain unchanged. See the [worker recovery contract](worker/README.md#installation-detector-and-recovery).

## Run the service

Requires Docker and Docker Compose. Copy the [example configuration](config.example.yaml):

```sh
cp config.example.yaml config.yaml
```

Create a private `.env` with real values:

```dotenv
MUSE_HTTP_PORT=8080
MUSE_PUBLIC_URL=https://muse.example.com
POSTGRES_PASSWORD=<database-password>
MUSE_DATABASE_URL=postgres://aaa_muse:<URL-encoded-database-password>@database:5432/aaa_muse?sslmode=disable
MUSE_PORTAL_PASSWORD=<distinct-portal-password>
```

The database passwords must match; URL-encode the one in `MUSE_DATABASE_URL`. The portal password is required configuration even though its UI is not implemented. Configure the worker package pin in `config.yaml`; this is the tested prerelease:

```yaml
worker-package:
  version: "0.1.0-rc.0"
  sha256: "240163c49cc30f9ac8b0906e8047b9c7bfb10756ca045b7d71e7977c2f566e77"
```

Verify the [published worker release](https://github.com/markhuangai/AaA-muse-ai/releases/tag/worker-v0.1.0-rc.0) before using its pin. Both pin fields are required to generate setup prompts. Keep deployment credentials out of Git.

Start the configured service:

```sh
docker compose up --build -d
```

Compose mounts `config.yaml` read-only. The service runs as UID/GID `10001:10001`, so that user must be able to read the mount. Put your own Traefik, Nginx or other HTTPS reverse proxy in front of the single HTTP port; configure `MUSE_PUBLIC_URL` as its HTTPS origin. No bundled proxy or TLS management is provided.

If `management.key` is empty, startup prints an automatically generated management key once. Keep it local in a protected header file containing `Authorization: Bearer <management-key>` under a `0700` directory, with file mode `0600`. Never send that key to Muse. Liveness is `GET /healthz`; readiness is `GET /readyz`.

## Worker registration

A registration code expires after fifteen minutes and can be used once. Successful enrollment exchanges it for the worker's own credential, which has no automatic expiry. The worker reuses its protected credential and identity across reconnects and worker, service, or database restarts; it does not need a fresh setup code each time.

Management can revoke a registration through `POST /api/v1/admin/workers/{id}/revoke`. Revocation rejects every copy of that credential while retaining registration and history records. Removing local worker state only loses that installation's copy; the server cannot recover it from its stored hash. See [reconnect and removal](worker/README.md#registration-reconnect-and-removal) before replacing or retiring an installation. Registration and connection health remain separate from independently verified inference readiness.

## One-message Muse setup

`POST /api/v1/admin/setup-prompts` already generates the complete installation message: configured origin, pinned worker release, setup ID and a fresh enrollment code. A future portal can reuse this generator and offer the whole message to copy; no portal is implemented yet.

Set `ORIGIN` to your HTTPS service origin and `ADMIN_HEADER_FILE` to the protected header file. Generate a prompt into a private file:

```sh
umask 077
SETUP_PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/aaa-muse-setup-prompt.XXXXXXXX.json")
curl -fsS --request POST --header @"$ADMIN_HEADER_FILE" \
  "$ORIGIN/api/v1/admin/setup-prompts" --output "$SETUP_PROMPT_FILE"
```

Copy the response's entire `setup_prompt` value into Muse as **one message**. Each enrollment code expires after fifteen minutes and can enroll once. Reuse the template with a fresh generated prompt, not an old code. Keep the response private; never include the management key, portal password, model-client key or registry credentials in the Muse message. Existing healthy installations retain their enrolled identity.

The reference below is a placeholder-only copy of the current [generator template](internal/service/setup.go). Use service-generated text for actual installation so its pins and shell quoting stay authoritative. `SETUP_ID` is the response's `enrollment_id`; the worker fields come from `worker_package`. The generator fills in the origin and enrollment code inside `setup_prompt`.

<details>
<summary>Complete installation-message template</summary>

````markdown
Install the scoped AaA Muse worker for the HTTPS origin below, using exactly these pinned public bytes. This authorizes model answers and structured client-tool proposals for this broker's authenticated assignments; it grants no pool administration or client-tool execution authority.

Use your actual shell, site and hook permissions. Present permission cards to the owner and read their actual scope. If a capability or permission is missing or refused, stop and report the actual result; do not bypass it, rewrite the verified package, or invent a native inference API. No GitHub token or manual owner VM shell is needed. Keep the enrollment code private: it is single-use authority expiring 15 minutes after issuance. Never put a durable worker credential in a prompt, URL, hook, task or log.

Run this Bash bootstrap with tracing disabled. Retain its private evidence directory on failure:

```bash
set +x
set -euo pipefail
umask 077
origin='<SERVICE_HTTPS_ORIGIN>'
url='<WORKER_RELEASE_URL>'
version='<WORKER_VERSION>'
expected='<WORKER_SHA256>'
setup_id='<SETUP_ID>'
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
<SINGLE_USE_ENROLLMENT_CODE>
AAA_MUSE_ENROLLMENT
```

Read the installer receipt. Verify its authenticated worker ID and retain the exact hook and skill paths. Call hooks.list with include_disabled:true. Reuse the single enabled hook with this exact script_path and five-second schedule; do not add another. If the existing hook is disabled, conflicting or cannot use five-second checks, report the actual unsupported boundary and stop. Otherwise call the supported hooks.add with this script_path and no script arguments, request five-second checks, and verify the actual registration and interval. The hook includes the supported-refresh recovery candidate; never invent a scheduler or assume its persistence. Stop on missing HATCH_HOOK_RUNTIME or unsupported wake/silent functions. Dry runs must remain side-effect free.

Verify the worker-specific SKILL.md at the returned path, discoverable through muse.skill_search in later conversations. It records only nonsecret scope and mechanics. Model jobs must be read with job-show and answered with decision-submit using the exact job and receipt linkage. Propose client tools as structured JSON; the calling client executes them locally. Do not execute them on this VM or invent results. Connection health, detector emission and model readiness are separate facts.

End this installation turn now. Do not read or answer an inference-readiness challenge during setup. A later independent background wake must prove that behavior. Live Muse permission behavior, five-second wake cadence, persistent paths and supported-refresh reconnection remain unverified until the owner's separate issue #7 trial. Full wipes, account resets and revoked identities are outside recovery authority.
````

</details>

Setup must leave one subscriber, one enabled five-second native hook, and a protected credential file (`0600`) under a private state directory (`0700`). Verify the native hook dry run and enabled state through supported tools. Approve actual permission cards where required; the message cannot grant permissions. End setup before an independent background inference challenge.

Recovery starts only a provably absent subscriber using retained state. The subscriber retries transient connection failures. This does not establish survival of a wipe or independently check connectivity while a process stays alive.

**Observed installation limitation:** worker `0.1.0-rc.0` required manual repair of new worker-specific directories that inherited setgid (`2700` rather than `0700`). Skill search also missed the installed skill, so its exact returned path was verified and used. These findings are recorded in #7; this README update does not fix the installer or change the generated prompt.

## Reference

- [Worker CLI, state, permissions and diagnostics](worker/README.md)
- [Qualification procedure](docs/qualification/README.md)
- [Contributor instructions](AGENTS.md)

Licensed under [Apache-2.0](LICENSE).
