# AaA-muse-ai

A self-hosted broker that connects model clients to a Muse worker through outbound HTTPS/SSE. Muse proposes answers and client tool calls; the calling client applies its permissions, executes its tools, and returns their results.

## Status

One-account testing demonstrated background wake, authenticated replies, six basic client-tool trials, full-history continuation, fresh-conversation replay, and automatic hook-based subscriber reconnection. A later weather question completed through the same service and client-tool loop.

**Full qualification remains inconclusive:** interleaving failed in both runs, and the exact supported-refresh scope and formal recovery case remain incomplete. Full history is the baseline; the tested delta candidate is rejected. A passing live receipt still gates release work. Detailed [findings and receipts are in #7](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6784686856), with [reconnection](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6785064072) and [weather-demo](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6785270949) updates.

The experiment API and worker exist. The [native request API](docs/history-api.md) adds named-client canonical conversations, one decision per request, and management timelines. The [OpenAI Chat Completions subset](docs/history-api.md#openai-chat-completions) and [Responses subset](docs/history-api.md#openai-responses) provide text and client function tools with JSON or buffered SSE responses. Responses adds typed items and linear owned response continuation. The [control portal](docs/portal.md) adds password login, read-only settings, worker management and request histories/cancellation in the same image and origin. Decisions and evidence are recorded in this repository and GitHub; project memory may supplement them.

The November 11, 2026 CI decision accepts the completed PoC investigation as the prerequisite for engineering gates in [#20](https://github.com/markhuangai/AaA-muse-ai/issues/20), while retaining the inconclusive qualification result. [Contributor checks](AGENTS.md#contributor-ci-checks) cover independent unit coverage, source-file limits, workflow budgets, and packaged integrations.

The separate November 11 [#8 approval](https://github.com/markhuangai/AaA-muse-ai/issues/8) permits canonical-history logic and controlled HTTP/PostgreSQL tests now, with live testing deferred. Existing qualification remains inconclusive; this exception does not establish live session isolation or release readiness.

The November 11 [#9 approval](https://github.com/markhuangai/AaA-muse-ai/issues/9) separately permits automatic capability routing and controlled software validation. Native requests can omit the worker ID, wait in a bounded queue, and retain a healthy session pin across answers. Management records authenticated qualification trials with explicit controlled/live provenance; reconnecting requires fresh evidence and approval. These software mechanisms do not resolve the failed interleaving or incomplete refresh qualification, and no live trial is authorized by this engineering change. See the [native API contract](docs/history-api.md).

The November 12 [#10 approval](https://github.com/markhuangai/AaA-muse-ai/issues/10) permits broker-recovery engineering and controlled validation. Startup reconciles PostgreSQL work before serving, preserves accepted decisions and tool waits, and retains uncertain claimed work under the existing 30-second health leases. A healthy sibling broker is preserved. The [recovery contract](docs/history-api.md#broker-restart-recovery) distinguishes receipt replay from renewed claim authority. This engineering exception grants no live Muse trial or release qualification.

The November 12 [#11 decision](https://github.com/markhuangai/AaA-muse-ai/issues/11) reaffirms the durable worker credentials approved in [#3 on November 9](https://github.com/markhuangai/AaA-muse-ai/issues/3), already implemented at source revision `c798f48dd2adabe704294cf2ceb929486feeac69`. It replaces #11's proposed credential expiry and renewal with documentation and controlled validation of the existing lifecycle, independently of #21. Live qualification and release requirements remain unchanged.

The November 12 [#12 approval](https://github.com/markhuangai/AaA-muse-ai/issues/12), based on `18e9317b76c506e5f33a31dc1e7a93b42c77123d`, permits worker-recovery engineering and controlled software validation. The development worker retries temporary startup and reconnect failures, reconciles existing evidence before resubscribing, and limits terminal-stop recording to the daemon owner. A healthy installation needs no repair or reinstall. No repair command, automatic inference retry, live trial, or publication is authorized; the published prerelease pin and inconclusive live qualification remain unchanged. See the [worker recovery contract](worker/README.md#installation-detector-and-recovery).

The November 12 [#13 approval](https://github.com/markhuangai/AaA-muse-ai/issues/13), based on `fdc0e3121ead3d4e024291f94deeaeda7b18ef93`, permits Chat-adapter engineering and controlled SDK/HTTP/PostgreSQL validation. It preserves existing pre-claim/pre-context rerouting and uncertain claimed busy holds, adds no inference retry, and grants no live trial or release publication. Controlled peers do not resolve the inconclusive live qualification. `make test-chat` and `CI / openai` retain the supported-subset and diagnostic evidence separately from unit coverage.

The November 13 [#14 approval](https://github.com/markhuangai/AaA-muse-ai/issues/14), based on `173770da918aca4921fb2ca83b6e2ef9b14c4941`, permits Responses engineering and controlled validation. Instructions apply to their individual request; prior values remain in durable request snapshots. Owned response chains remain linear, preserve healthy worker pins, and use only existing conservative replacement boundaries. `make test-responses` extends the shared runner; its separate safe receipt is retained alongside Chat by `CI / openai`. This decision retains the inconclusive live verdict and passing-live release gate, and authorizes no live trial, broader inference retry, deployment or release publication.

Responses validation passed at `2026-11-13T04:24:26Z` (54 receipts after refreshing the restart fixture). Earlier runs passed Chat (34 receipts) and the native inference, history, routing and broker-recovery regressions. Both protocol runners use OpenAI JS SDK 7.53.0. The local Docker port-forwarding path timed out during TCP connection setup; the passing runs used the existing direct-container-network harness option. Each suite verified removal of its three containers, three volumes and network. Hosted CI retains its normal transport and separate safe protocol receipts; these controlled results do not qualify live Muse.

The November 13 [#15 approval](https://github.com/markhuangai/AaA-muse-ai/issues/15), based on `e2fb302c7846db8e8c424f33b8a7d00c2d22523b`, permits portal engineering and controlled browser/API/image validation before further live qualification. Portal sessions are limited to the service process, expire after thirty minutes without renewal, and are never persisted by the browser. This exception preserves the inconclusive live verdict and passing-live release gate; it grants no live trial, deployment, publication or merge. Codex, the configured AI reviewer, CI and CodeQL are required; CodeRabbit is excluded for this delivery. Controlled receipts do not qualify Muse inference.

Controlled portal validation passed at `2026-11-13T13:58:01Z`: 24 receipts and nine login/settings/error screenshots at 1440, 768 and 390 pixels. The approved-base working-source digest was `346fe74085c332ff6793adc671877782256c22eb2defd1d7cc5ffbc3daddc5f8`; the tested combined image was `sha256:117224eaee903055849a13a4206771c02e293035fbb07ff1430c29aafef572e7`. Authentication boundaries, redaction, process-local invalidation and log-only diagnosis passed. The suite verified removal of its three containers, three volumes and network. See [validation limits and corrected failures](docs/portal.md#controlled-validation); hosted final-head review remains a separate delivery gate.

The November 13 [#16 approval](https://github.com/markhuangai/AaA-muse-ai/issues/16), based on `e6d987e6cbcc6275eac8a5e5126677ca6dbaa6dd`, permits worker-management portal engineering and controlled browser/API/PostgreSQL validation. The portal uses the existing list, rename, enrollment, pinned-setup and revocation APIs. Enrollment remains single-use for fifteen minutes; worker credentials remain valid until revoked. Subscriber health, activity and qualification provenance are independent facts. Installed version and independent background wake are explicitly unknown where the APIs do not report them. This exception preserves the inconclusive live verdict and passing-live release gate; it authorizes no live trial, telemetry expansion, deployment, release publication or merge. Codex, configured AI review, all CI and CodeQL are required; CodeRabbit is excluded for #16.

Controlled worker-portal validation passed at `2026-11-13T18:57:20Z` after the independent plan audit returned conformant: 41 receipts and thirteen credential-free screenshots at 1440, 768 and 390 pixels. The approved-base working-source digest was `d4c730d113e988de641141f14b10cb635c0cfbe5c48745f5fb9be657c072476a`; the combined image was `sha256:1ef4455142fc2e024a3ad581dd1ffbe748af52d46a9c3b6b863b8421a1f96b9f`. Rename persistence, enrollment single use and expiry, confirmed revocation, response ordering, outage recovery and log-only diagnosis passed. The suite verified removal of its two containers, two volumes and network. Complete unit coverage and the portal-shell, service, worker-auth and image regressions passed by `2026-11-13T19:01:48Z`. See [validation details](docs/portal.md#controlled-validation); hosted final-head checks and reviews remain separate delivery gates.

The November 13 [#17 approval](https://github.com/markhuangai/AaA-muse-ai/issues/17), based on `2af17b04033fce89706771f96f2580acc6c2c7ca`, permits request-history portal engineering and controlled browser/API/PostgreSQL validation before further live qualification. Requests uses bounded management history queries and conservative cancellation, including unassigned requests. Current agent names are labeled current beside immutable worker IDs. The inconclusive live verdict and passing-live release gate remain; no live trial, broader inference retry, tool execution, deployment, publication or merge is authorized. Codex, configured AI review, CI and CodeQL are required; CodeRabbit is excluded for #17.

Controlled request-history validation passed at `2026-11-13T22:17:06Z` after the independent plan audit returned conformant on round three: 43 safe receipts and thirteen screenshots at 1440, 768 and 390 pixels. Its approved-base working-source digest was `2d558d9d22df4d205240da4b74fd15a61f6e42479abfd8fe494943bc765c2a14`; the combined image was `sha256:ba2a04fbc5c6f5f893b920e772196030b8e504c5b21b8ffdf398d9e3a431954f`. Native/legacy content, tool linkage, instructions, paging, replacement boundaries, cancellation races/uncertainty, expiry, response fencing and log-only diagnosis passed. The suite verified removal of two containers, two volumes and its network. All six unit components separately exceeded 90% raw statement coverage. These controlled results do not qualify live Muse; final-head CI and required reviews remain separate delivery gates.

The November 14 [#42 approval](https://github.com/markhuangai/AaA-muse-ai/issues/42), based on `67785e24f5cb30b95c58e767792ee1cc99f405d3`, permits query-only fixes for NUL-containing management histories and the linked recovery/current-job metadata reads. Fixed metadata uses a temporary parsing copy; retained payloads remain original JSON, including NUL, literal escapes and large numbers. Schema, admission, cursors, fencing, accepted receipts and uncertain busy holds remain unchanged. Codex, complete configured AI review, all CI and CodeQL are required; CodeRabbit is excluded. The owner’s follow-up assigns the remaining Docker-dependent checks to existing PR CI; those checks remain required for completion. Deployment, VNC, live qualification, merge and release publication are deferred, and the passing-live release gate remains.

Controlled NUL-history validation passed in [CI](https://github.com/markhuangai/AaA-muse-ai/actions/runs/43610017152) by `2026-11-14T15:29:48Z` for source `2298bc3ba4ea9b23bb479f9ccb33c10831f66184`, working-source digest `9ab0ddc31e203605e249dadf646c0073868e46ab0c1fe1803a110a33700eed3a`. The portal history suite passed 51 safe receipts, including native/legacy NUL and literal-escape fidelity at 1440, 768 and 390 pixels, malformed-projection diagnosis and cleanup of its two containers, two volumes and network. Its combined image was `sha256:30c78be4247b89f200e12b0c690d559d10e42ca90d582bd822a2ee1ec0cee0fb`. Native history and broker-recovery checks passed, including NUL output receipt replay, accepted tool linkage and uncertain holds; all six unit components separately exceeded 90% raw statement coverage. These controlled results do not qualify live Muse. Final-head CI and required reviews remain separate [PR #43](https://github.com/markhuangai/AaA-muse-ai/pull/43) gates.

The November 14, 2026 owner-approved prerequisite replaces operator package pins with image-owned paired-release metadata, requires equal full service/worker release versions and same-major connection compatibility, and leaves worker upgrades manual. It also permits a single raw database password shared through Compose, with URL construction inside Go. Engineering and controlled validation precede issue #18; the inconclusive live verdict and passing-live gate remain. No publication, merge, deployment or live qualification has been performed by this change.

The same owner-approved plan adds [the combined product runner and staged two-account release matrix](docs/qualification/product.md) for [#18](https://github.com/markhuangai/AaA-muse-ai/issues/18). The prerequisite’s round-six independent audit was conformant at base `b095988e02abb31e1eca97873f9900d88caa1180`. Its service/PostgreSQL, archived `0.1.0-rc.6` worker, current packed worker, installer/recovery and portal-worker browser checks passed by `2026-11-14T22:34:10Z`, using local combined-image ID `sha256:0ca01bdd25e469f7fd3524244e85be3394e681a9bd05f08d4e9949e3d4c28d6d`. An initial browser run failed because the required Playwright Chromium was absent; installing that exact runtime resolved the environment failure. The local direct-container-network option was used; every harness verified its owned container/volume/network cleanup. These prerequisite receipts precede the #18 source changes, do not establish a final same-source validation, and do not qualify live Muse. The new deployment/configuration, authorized account logins and required live evidence remain outstanding.

The owner’s follow-up defers live Muse execution until they confirm the PR is merged and the updated service is deployed. The two private VNC sessions remain available for owner login. Local controlled validation and read-only reviews may continue; neither changes the inconclusive live verdict.

Controlled #18 product validation passed at `2026-11-15T00:29:09Z` for approved base `b095988e02abb31e1eca97873f9900d88caa1180`, working-source digest `43f80f0255b25a21ddb9a5294d94d9a4c84683b53915f7c2c79e69adb4f62d83`: 32 combined portal/installer/packed-worker cases and the adverse Chat/Responses shard. Both shards used identical worker bytes and passed aggregate validation; all six unit components separately exceeded 90% raw statement coverage. The standalone service, native/history/routing/recovery, worker and portal regressions also passed. See the [controlled validation record](docs/qualification/product.md#controlled-validation-record) for artifact identities, corrected failures and limits. Required final-head CI, configured AI review, CodeQL and live Muse evidence remain separate gates; #18 is incomplete.

## Run the service

Requires Docker and Docker Compose. Copy the [example configuration](config.example.yaml):

```sh
cp config.example.yaml config.yaml
```

Create a private `.env` with real values:

```dotenv
MUSE_SERVICE_IMAGE=ghcr.io/markhuangai/aaa-muse-ai@sha256:<verified-paired-release-digest>
MUSE_PUBLIC_URL=https://muse.example.com
POSTGRES_PASSWORD=<database-password>
MUSE_MANAGEMENT_KEY=<management-key>
MUSE_PORTAL_PASSWORD=<distinct-portal-password>
MUSE_CLIENT_KEY_A=<first-model-client-key>
MUSE_CLIENT_KEY_B=<second-model-client-key>
```

Use `compose.yaml` in a separate qualification directory. Its default HTTP binding is `127.0.0.1:8081`; the operator owns reverse-proxy routing and TLS. The example config fixes the database host, user and name and uses the same `POSTGRES_PASSWORD` as PostgreSQL. Go escapes the password; no second URL-encoded secret or `MUSE_DATABASE_URL` setting is needed. Existing complete database URLs remain supported. Do not combine a URL password with `database.password`.

The service and worker are released together with the same full version and source SHA. Same-major workers may connect regardless of minor or patch differences. A different major reports `update_required`; the worker logs manual operator action and never updates itself. Product versions are independent of the existing `protocol_version: 1` wire field. Legacy handshakes without product metadata remain supported only by major-zero services and do not establish an exact installed version.

Worker installation metadata comes from the service image, never `config.yaml`. Setup prompts still verify the exact archive version and trusted SHA-256 before executing code. Read [paired release and manual upgrade](docs/releases.md) before changing versions. Existing `worker-v0.1.0-rc.N` releases remain unchanged; new paired releases use `vVERSION` and include a `product-release.json` receipt. A partial publication is not a complete pair.

The published image recorded before this change does not implement the new configuration. Use the immutable digest of the verified prerequisite build when available; no replacement release is published by this documentation change.

After selecting that verified image:

```sh
docker compose config --quiet
docker compose up -d
```

Compose mounts `config.yaml` read-only. The service runs as UID/GID `10001:10001`, so that user must be able to read the mount. Put your own Traefik, Nginx or other HTTPS reverse proxy in front of the single HTTP port; configure `MUSE_PUBLIC_URL` as its HTTPS origin and allow at least 330 seconds for inference responses. No bundled proxy or TLS management is provided.

If `management.key` is empty, startup prints an automatically generated management key once. Keep it local in a protected header file containing `Authorization: Bearer <management-key>` under a `0700` directory, with file mode `0600`. Never send that key to Muse. Liveness is `GET /healthz`; readiness is `GET /readyz`.

## Worker registration

A registration code expires after fifteen minutes and can be used once. Successful enrollment exchanges it for the worker's own credential, which has no automatic expiry. The worker reuses its protected credential and identity across reconnects and worker, service, or database restarts; it does not need a fresh setup code each time.

Management can revoke a registration through `POST /api/v1/admin/workers/{id}/revoke`. Revocation rejects every copy of that credential while retaining registration and history records. Removing local worker state only loses that installation's copy; the server cannot recover it from its stored hash. See [reconnect and removal](worker/README.md#registration-reconnect-and-removal) before replacing or retiring an installation. Registration and connection health remain separate from independently verified inference readiness.

## One-message Muse setup

`POST /api/v1/admin/setup-prompts` generates the complete installation message: configured origin, pinned worker release, setup ID and a fresh enrollment code. Sign in to the portal and open **Workers** to generate and copy the same complete text, or explicitly select code-only enrollment. Generated authority is kept only in memory and cleared on expiry, replacement, session end or leaving Workers. The portal cannot confirm whether a code has already been used.

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
- [Portal sessions, settings and diagnostics](docs/portal.md)
- [Qualification procedure](docs/qualification/README.md)
- [Contributor instructions](AGENTS.md)

Licensed under [Apache-2.0](LICENSE).
