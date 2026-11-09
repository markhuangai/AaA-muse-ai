# AaA-muse-ai

Agent as API from muse.ai: a planned self-hosted broker that makes independently enrolled personal Muse agents available as model backends.

The broker owns the conversation record. Muse proposes answers or client tool calls; the calling application executes its own tools under its own permissions. Whole-task delegation may be useful later, but it does not replace this model-backend goal.

## Status

**Worker identities locally verified, as of November 9, 2026.** Issue #3 adds registration, persistent scoped reconnect credentials, management renaming, and durable revocation. Independent audit and required local checks passed; current-head remote CI/review receipts belong to the delivery PR linked from issue #3. [S24] The Go/PostgreSQL service foundation from issue #2 merged through [PR #23][S22] at `2d54b90ef7f816ff21b78cd6d8dfda7f256fd659`. CI bootstrap [PR #22](https://github.com/markhuangai/AaA-muse-ai/pull/22) merged at `68312d8f326472dd203933e8c6416a9a8b1f08b5`; its initial live workflow receipt is S20. The [feature issues](https://github.com/markhuangai/AaA-muse-ai/issues) cover an MVP PoC followed by v0.1.0. No inference broker, worker CLI, portal, installer, or versioned release is available yet. GHCR publication and candidate dispatch remain unverified until observed.

No live Muse account has been connected or tested, no worker has been installed, and no account credentials have been collected. Model wake, structured decisions, client tool continuation, streaming transport, isolation, and recovery remain unverified on the intended accounts. Service startup below does not qualify Muse inference.

The [evidence register](#evidence-register) separates the supplied investigation handoff from sources rechecked in this session. Read [AGENTS.md](AGENTS.md) before contributing.

## Run the service

Docker and Docker Compose are required; host Go is unnecessary. Copy [config.example.yaml](config.example.yaml) to `config.yaml`. Create a private `.env` with real replacements for these placeholders:

```dotenv
MUSE_HTTP_PORT=8080
MUSE_PUBLIC_URL=https://muse.example.com
POSTGRES_PASSWORD=<database-password>
MUSE_DATABASE_URL=postgres://aaa_muse:<URL-encoded-database-password>@database:5432/aaa_muse?sslmode=disable
MUSE_PORTAL_PASSWORD=<distinct-portal-password>
```

The database password in the URL must match `POSTGRES_PASSWORD`, with URL encoding where needed. These files are ignored by Git. Compose forwards the example's environment references; forward any additional references explicitly in your Compose configuration. Configuration changes apply on restart. Unknown/duplicate fields, multiple documents, unsupported aliases, unresolved or empty required references, invalid settings, Bearer keys containing whitespace or HTTP control bytes, and reused credential values are rejected without printing their contents. Rejections identify a numeric source location and a schema-safe field path; unknown field names and client labels are masked.

```sh
docker compose up --build -d
docker compose logs --no-color service
```

The service runs as UID/GID `10001:10001`; its mounted YAML must be readable by that user. The example uses environment references so no credentials need to be embedded in its readable YAML. Keep any YAML containing literal credentials protected while granting that UID access. Compose mounts it read-only at `/etc/aaa-muse-ai/config.yaml`. Override the path with `--config` when invoking the binary directly.

An empty `management.key` generates a 256-bit key, printed once as `MANAGEMENT_KEY=...` after successful startup. That key changes on each process restart and is excluded from structured logs, protected captures, status, and exports. Treat access to container stdout as credential access. To keep a configured key, set `management.key: "${MUSE_MANAGEMENT_KEY}"` and supply that environment variable. The required portal password is separate and is never generated or printed. Portal login and client model routes are not implemented here.

The default HTTP port is `8080`. `GET /healthz` reports process liveness. `GET /readyz` returns `200` only when the database is available and schema bootstrap completed, otherwise `503`. Database loss after startup does not disable liveness, authenticated status, or diagnostic export. Startup connection attempts are limited to three, including PostgreSQL `cannot_connect_now` (`57P03`); schema/checksum incompatibility stops startup immediately. Embedded migrations use a transaction and advisory lock and never run destructive down migrations.

Save `Authorization: Bearer <management-key>` in a protected `0600` header file outside the checkout. Set `ADMIN_HEADER_FILE` to that file and `ORIGIN` to the service origin:

```sh
curl -fsS --header @"$ADMIN_HEADER_FILE" "$ORIGIN/api/v1/admin/status"
curl -fsS --header @"$ADMIN_HEADER_FILE" "$ORIGIN/api/v1/admin/diagnostics/export?request_id=$REQUEST_ID"
```

Status includes source revision/dirty state, uptime, schema/readiness, and redacted effective settings. It makes no Muse-readiness claim. Management routes reject client, portal, and worker credentials. Health/status/export routes accept GET without a body; the shared body ceiling is 1 MiB. Unknown query parameters and unsupported methods fail explicitly.

The operator supplies HTTPS domain routing and TLS through Traefik, Nginx, or another proxy. The service listens on plain HTTP behind that proxy, exposes one port, and has no CORS middleware, certificate management, or bundled proxy. Its configured public URL must be an HTTPS origin.

### Worker registration and reconnect credentials

Remove `limits.max-workers` from existing YAML before upgrading. The strict loader rejects that obsolete setting; there is no worker-count cap. `limits.max-jobs` and `in-flight-per-worker` remain separate settings for future job admission. Connection/liveness-based eligibility belongs to issue #4.

| Request | Required authority | Response |
| --- | --- | --- |
| `POST /api/v1/admin/enrollments` | Management Bearer key | `enrollment_id`, `enrollment_code`, `created_at`, `expires_at` |
| `POST /api/v1/worker/enroll` with only `enrollment_code` | Single-use registration code | `worker` record and `credential` |
| `GET /api/v1/admin/workers` | Management Bearer key | `workers`, including revoked identities |
| `GET /api/v1/worker/status` | Worker Bearer credential | The authenticated worker's record |
| `PATCH /api/v1/admin/workers/{id}` with only `name` | Management Bearer key | Updated worker record |
| `POST /api/v1/admin/workers/{id}/revoke` | Management Bearer key | Revoked worker record; repeated revocation retains its original timestamp |

Creation and revocation accept an empty body or `{}`. Enrollment and rename require one JSON object, reject unknown/duplicate fields and trailing input, and accept no worker-identity override. Invalid, expired, and consumed codes return `400`, `410`, and `409` respectively. Invalid/revoked credentials and wrong roles return `401`; missing management-targeted workers return `404`; storage/entropy failures return `503`. Mutation requests retain the 1 MiB ceiling.

A registration code expires after exactly 15 minutes and is consumed atomically with worker creation. Concurrent attempts produce at most one worker. The separate 256-bit reconnect credential has no automatic expiry; service and database restarts preserve it. Every authenticated request checks durable revocation. Only hashes are stored in the credential/code columns. Losing an issuance response does not make its code reusable: use management records and diagnostic request IDs to identify/revoke an orphaned worker, then issue a fresh code. No plaintext credential-recovery or renewal endpoint exists.

Worker records expose `id`, `name`, `registered_at`, nullable `revoked_at` and `last_contact_at`, `connection_status: "not_observed"`, and `inference_readiness: "unverified"`. A successful authenticated contact updates last contact, without establishing a live subscription or inference capability. Work/assignment fields await issue #4. Worker status always derives identity from its credential; a supplied ID cannot grant another worker's authority.

The default name is `Worker ` plus eight ID characters. Management renames trim surrounding whitespace and require 1–100 Unicode code points with no control characters. Names can repeat and do not change identity, credentials, or revocation. Issued-secret-shaped text in a display name is masked in worker responses as well as diagnostics, including after restart; ordinary names are unchanged. Keep names free of secrets. Codes and credentials are returned only by their issuance responses; store those responses privately, outside the checkout. The future worker CLI's protected key-file behavior remains unimplemented and unqualified.

Schema v2 adds identity/enrollment tables without changing migration 001. Startup validates contiguous applied versions and their checksums, then applies missing migrations under the existing lock and transaction. Old v1 binaries reject a v2 database; preserve data and deploy a forward fix rather than attempting destructive down migrations.

### Runtime diagnostics

INFO JSON events go to container stdout; DEBUG detail is always retained in the protected diagnostic volume for authenticated export and the future portal. Compose bounds stdout logs to three 10 MiB files. Protected capture defaults to seven days or 128 MiB, whichever limit is reached first; directory/file permissions are `0700`/`0600`. The retention period may be reduced to 1–7 days and capacity to 6 KiB–128 MiB through YAML. Credentials are redacted before capture.

Export uses NDJSON: a metadata line followed by event chunks. Filter with RFC3339 `since`/`until`, `request_id`, or `operation_id`. Each record is at most 6 KiB. Group by `capture_id`, order by `chunk`, decode `data_base64`, concatenate, and verify `payload_sha256` to reconstruct the complete redacted JSON event. The metadata reports capture count and incomplete, expired, capacity-pruned, or unmatched identity evidence, plus requested intervals outside capture coverage. Export records a snapshot reference and outcome rather than recapturing its own response.

Use the response's `X-Request-Id` to reconstruct an operation from export alone. `auth.denied` identifies expected/observed roles; `readiness.changed` identifies database degradation/recovery; startup database events include the target, attempts, timing, safe cause, and terminal outcome. Startup failures remain available through `docker compose logs --no-color service`; they do not require a working HTTP process. Capture-write failure emits `diagnostics.capture_failed` on stderr and stops the service. Repair the reported storage permission/capacity problem before restarting.

Response exchanges retain attempted output and distinguish attempted/written byte counts. An observable client-write error emits `request.write_failed` and marks the outcome `interrupted`; a status code alone does not prove that the client received the response. Detailed causes remain in the protected DEBUG capture.

Enrollment diagnostics include known enrollment/worker IDs, expiry, transaction outcome, effective 900-second lifetime, source/schema identity, timings, and attempts. `enrollment.rejected` distinguishes invalid, expired, and consumed codes; `worker.scope_denied` identifies authenticated/requested identities; `worker.auth_denied` explains rejected authority; `worker.operation_failed` and protected `worker.storage_exchange` retain causal storage evidence. Successful issuance, enrollment, rename, and revocation record their outcomes. Dynamic code/credential-shaped strings remain redacted even when echoed in names or JSON responses and after restart. Use the response request ID and authenticated export above; reconstruct the event chunks before filtering. Business-table queries are unnecessary for diagnosis.

### Builds and validation

The image pins Go 1.27.3, Alpine 3.24, and the CA bundle from its pinned Go builder. Compose pins PostgreSQL 18.6 and mounts its version-18 storage at `/var/lib/postgresql`. The Go module pins pgx 5.11.0 (MIT) and Go YAML 3.0.6 (MIT/Apache); their transitive dependencies are locked in `go.sum`. No external application code is copied.

```sh
make check-service
make test-service-unit
make test-service
make test-worker-auth
make smoke-image
```

Checks use Docker; integration scripts require Python 3. Unit coverage is separate from integration and must exceed 90% of raw statements across every first-party Go package. Test resources carry unique ownership labels and disposable volumes; cleanup verifies ownership and retains receipts under ignored `.artifacts/`. Do not delete deployment volumes when cleaning tests. Ordinary `docker compose down` retains deployment data; the operator decides its retention.

`CI / service` checks formatting/builds, unit coverage/races, and real HTTP/PostgreSQL behavior, including worker enrollment, revocation, and diagnosis. `CI / image` exercises packaged startup and diagnostic failures. Existing workflow-policy, CodeQL (including Go), and marked AI-review checks remain required. Issues #2 and #3 additionally require Codex on every head and ignore CodeRabbit by direct user decision.

The default-branch candidate workflow accepts an exact SHA already on main or the current head of a unique same-repository non-draft PR to main, checks actor permission, tests the image, fences the source again, and exports a one-day archive with source/tree, archive SHA-256, and image-config digest receipts. It has no package-write permission. Candidate dispatch is not yet live-qualified.

After human merge, successful exact-main CI can trigger GHCR publication of `ghcr.io/markhuangai/aaa-muse-ai:sha-<commit>`. Publication rebuilds and smoke-tests its own image, refuses conflicting existing source-SHA content, and records the immutable registry digest; consumers should pin that digest. No mutable `latest` tag or versioned product release is added. The publication workflow remains unverified until its first authorized post-merge observation.

## Confirmed decisions

| Component | Technology | Intended distribution |
| --- | --- | --- |
| Broker and service APIs | Go, PostgreSQL state, service/repository pattern | Alpine-based Docker image in `ghcr.io` |
| Management portal | React/TypeScript, built and served with the Go service | Included in the same service image and HTTP port |
| Muse VM worker CLI | TypeScript, subject to runtime verification | GitHub Packages npm package and the same versioned package archive as a public GitHub Release asset |
| Client integrations | Model protocol adapters at the broker boundary | Part of the service; no standalone client SDK is planned |

The worker CLI's long-running mode is a worker daemon: it initiates an authenticated outbound HTTPS SSE subscription, receives inference jobs, and submits correlated decisions through authenticated HTTP. The service issues its connection authority. SSE is the planned transport; actual Muse streaming, wake, and credential handling still require live qualification.

GitHub Packages remains the npm publication destination. Anonymous worker installation will download the public Release asset. GitHub's npm registry requires authentication even for public packages; a broker-issued worker token does not authorize registry downloads. [S17]

The first pool is private and centrally coordinated. Start with one account and one inference turn in flight per worker. Public marketplaces, anonymous enrollment, billing, peer-to-peer coordination, and a separate SDK are outside the initial scope. Browser automation and a paid hosted relay are reference or fallback subjects, not the selected foundation.

## Intended architecture

```text
Codex / Claude Code / other model clients
                   |
          Client protocol adapters
                   |
    Go broker + canonical conversation store
                   |                         |
        Job queue + worker registry    Management portal
                   |                    (TypeScript)
       Authenticated outbound HTTPS
       initiated by the VM worker
                   |
       TypeScript worker CLI in Muse VM
                   |
       Muse wake and decision mechanism
                  (unproven)
```

The desired delivery transport is an SSE subscription from the service to the worker, over a connection initiated by the worker, with separate authenticated HTTP decision submission. An HTTP registration, heartbeat, detector check, or connected stream does not prove that Muse has started an inference.

### Deployment and control portal

Build Go and the React portal in separate build stages, then ship the Go executable and compiled assets together in one Alpine-based runtime image. The service listens on one configured HTTP port. Compose mounts the operator's `config.yaml` read-only and gives PostgreSQL its own volume. There is one running-service configuration and no PoC/release mode selector.

The operator supplies Traefik, Nginx, or another reverse proxy to bind a domain and terminate TLS. Portal and API share an origin; CORS middleware, certificate provisioning, and a bundled proxy are outside the service. Worker enrollment uses the configured public HTTPS origin through that proxy.

Set `control-portal.password` in YAML, optionally through an environment reference. The password authenticates portal login and is exchanged for an expiring token held only in browser memory. Logout, expiry, or service restart invalidates that session. Neither value belongs in browser storage, URLs, or logs. The existing management API key remains separate for automation; model clients and workers have their own scoped credentials.

The portal shows agent names and IDs, online/offline status, last contact, current work, and model-readiness evidence as distinct facts. Operators can rename agents, issue short-lived enrollment tokens, copy a complete setup prompt, and revoke worker authority. Names are display metadata; renaming does not create a new identity or alter an assignment.

### Responsibilities

- **Broker:** authenticate callers, reconcile incoming history, retain observed instructions and tool definitions, assign inference turns, record decisions and tool results, and expose supported model protocols.
- **Worker:** enroll with its own identity, receive scoped assignments, invoke a verified Muse wake mechanism, return decisions and artifacts, and recover only through supported runtime mechanisms.
- **Portal:** authenticate with the configured password and provide enrollment/setup prompts, credential revocation, agent renaming, and worker status. Show online and idle/busy state separately from independent model readiness.
- **Calling client:** define its available tools, enforce local permissions, execute approved tools, and return results with the matching call identifiers.

### Conversation and tool loop

1. The client sends instructions, conversation context, and definitions of tools it can execute. The broker records or reconciles the observed input and assigns an inference turn.
2. Muse returns a final answer or a structured intent containing the client tool's name, arguments, and call identifier. Client tools have a decision-only contract: Muse must request their execution by the client.
3. The broker validates ownership, tool name, arguments, and call linkage, then returns the supported protocol representation. Unknown tools or malformed decisions produce explicit errors; a bounded correction attempt may be investigated.
4. The client applies its permissions, executes the tool locally, and sends back the result. The broker records it and supplies the necessary context for Muse's next inference turn.
5. Continue until a final answer, explicit error, cancellation, or deadline. Record each observed turn once, including its assignment and tool linkage.

A file read inside Muse's VM cannot substitute for reading the client's repository. Do not infer executable commands from arbitrary prose, invent tool results, or use Muse's native shell, browser, or connected apps as substitutes for client tools.

The broker's record covers what it observes, not Muse's private reasoning, hidden context, or unobserved activity. Clients may resend full histories, so naive appending would duplicate turns. An explicit client-owned `X-Muse-Session-Id`, or an owned Responses reference, identifies a session. Uncorrelated requests create independent records; the service does not infer identity from text similarity. Pin identified sessions across turns to one worker, serialize their turns, and keep simultaneous sessions isolated.

Full canonical history is the initial context baseline. The live PoC compares it with delta delivery, tests interleaved sessions, and replays history into a fresh model conversation. Delta support remains an experiment until its context-base and tool-linkage behavior is demonstrated. A new side chat does not prove isolation from account-wide memory; rerouting must record the changed account/capabilities and their limits.

When a worker fails, bounded failover fences its old assignment before dispatching the same logical session and full history to another eligible worker. Preserve accepted tool calls/results and their exact identifiers. Retry transparently only before the failed turn has delivered output or a tool call and when no client-tool outcome is unresolved. Otherwise report interruption or uncertainty. The old Muse inference may still run; fencing rejects its late output and cannot guarantee exactly-once remote inference. If the broker itself is unavailable, its durable state must recover first.

## Enrollment, credentials, and distribution

The intended enrollment is manual once per account, followed by supported automatic rejoining:

1. An authenticated operator obtains a service-generated setup instruction containing an expiring, single-use enrollment code bound to the private pool.
2. The operator pastes it into Muse. Muse downloads the versioned worker package or installer from public GitHub Release assets and verifies the artifact against the configured version and trusted digest before execution.
3. The user approves the actual Muse connection prompts. The worker exchanges the enrollment code for its own scoped, revocable credential, stores it in a `0600` key file under a `0700` state directory, and updates that state atomically. Verify the runtime's permission and persistence guarantees.
4. The worker records nonsecret identity and configuration, registers the supported hook/scheduled recovery task, and establishes its outbound subscription to the service. The prompt asks Muse to configure automatic reconnection after a supported refresh; whether that task and its credentials survive must be tested.
5. The broker sends an independent model challenge. Only an authenticated, correlated Muse inference response establishes model readiness; registration or polling alone does not.

The selected worker design uses protected key-file storage. Muse's Secure Vault or an equivalent supported injection facility may be investigated, but its ability to authenticate the intended TypeScript client and streaming connection is unverified. Paperclip demonstrates relevant Vault-backed OAuth concepts, not proof that this project's chosen transport can use them. [S3] [S4]

Worker credentials must permit only the worker's own connection/renewal, scoped job claims, heartbeats, and result submissions. Keep administrator credentials, client API credentials, package publication credentials, and each worker identity separate. Worker A must not claim or submit worker B's assignments.

Keep raw long-lived credentials out of prompts, URLs, public assets, hooks, scheduled-task bodies, logs, and version control. The temporary enrollment code is bootstrap authority, not a durable recovery credential. Reconnect or repair must not recreate revoked authority. Inspect the actual hostname approval scope; installation text cannot approve permissions on the user's behalf.

The release plan publishes `@markhuangai/aaa-muse-worker` to GitHub Packages and attaches the same packed artifact to a public GitHub Release, recording its version and digest. Build the React/TypeScript portal into the Go service's Alpine-based release image and publish that combined image to GHCR. Exact runtime/artifact identities and publication checks belong to the feature issues; no artifacts are currently available.

## Planned capability boundaries

No client protocol is implemented or certified yet. Keep normalized decisions inside the broker and protocol translation at its boundary.

| Target | Interface to investigate | Required proof |
| --- | --- | --- |
| General model clients and gateways | OpenAI Chat Completions | Message history, structured tool calls and results, finish reasons, and valid supported streaming |
| Codex | OpenAI Responses | Input items, function/custom tools, call correlation, cancellation behavior, and complete lifecycle events |
| Claude Code | Anthropic Messages | `tool_use`/`tool_result`, stop behavior, and correct streaming sequences |
| Images and video | Capability endpoints or asynchronous jobs | Durable completion status, actual artifacts, authorized downloads, retention, and explicit unsupported parameters |

OpenAI Chat Completions is the first adapter, followed by Responses. Document the base URL, API-key authentication, `muse-pool-text` alias, supported tool subset, and streaming behavior so gateways such as CLIProxyAPI or cc-switch can be evaluated later. Neither gateway integration is certified. The handoff identified Responses as the Codex custom-provider interface; recheck the installed client and official documentation before applying configuration examples. Function-call support alone does not establish support for Codex custom tools. [S12]

The handoff also records Anthropic's stated lack of support for routing Claude Code to non-Claude models through a gateway. Any technical interoperability experiment must retain that support caveat and be tested against the actual client. [S13]

Do not advertise token streaming unless incremental backend output is observed. Keepalives are transport activity, not model progress. Report unknown Muse usage honestly; character-based estimates are not measured token usage. Model aliases must describe actual routing capabilities rather than claim another vendor's model.

Media may complete after an initial text response. A future media job must wait for the expected artifact and retain durable status. Test formats, reference inputs, downloads, cancellation, and timeouts against real outputs before advertising compatibility.

## Risk

- A connected worker may never wake Muse or may return prose instead of a valid tool decision. Require an independent challenge, idle-wake test, and client-only tool fixture before claiming a working backend.
- Installation or dispatch could expose credentials or another conversation. Use public pinned Release assets, separate scoped identities, ownership checks, and dedicated-account isolation tests.
- A nominally compatible endpoint could omit required tool history, streaming events, or delayed media. Keep capability claims unverified until tested against the actual client and output; reject unsupported requests explicitly.

### Recovery and isolation

| Failure | Intended behavior | Evidence required |
| --- | --- | --- |
| Broker restart | Restore durable identity, history, jobs, and assignment state; reconcile pending work | A pending tool call retains its linkage after restart |
| Worker process crash | Restart through a supported supervisor or hook; fence the old process | Reconnection does not duplicate accepted work or accept stale results |
| VM/container replacement | Repair from verified persistent nonsecret bootstrap state, if available | Observe exactly which files, credentials, hooks, and permissions survive |
| Full wipe or revoked identity | Re-enroll unless independently preserved, authorized recovery state exists | No automatic-recovery claim when identity or recovery authority is gone |

Repair must be idempotent and must not install duplicate consumers or hooks, allocate another identity, or revive revoked credentials. Use an installation lock, worker generations, leases, and stale-result rejection. Reconcile in-flight work before the bounded failover described above: a timeout does not prove that remote inference stopped. Remote cancellation remains best effort until demonstrated otherwise; fencing cannot guarantee exactly-once remote effects. Supported refresh recovery needs an observed receipt; full wipes remain a separate boundary.

Use dedicated accounts for isolation experiments. Separate side chats alone are insufficient evidence against account-wide memory contamination. Preserve worker/request ownership, respect quotas and revocation, and do not rotate accounts to bypass limits. Source-code licenses, hosting cost, and permission to pool or re-expose Muse are separate questions.

## Investigation sequence and first acceptance test

1. **Revalidate the runtime.** Inspect current Paperclip assets and available Muse hooks, Node.js/runtime support, credential injection, persistent paths, and egress behavior. Prefer investigating a native bridge tool; otherwise test constrained JSON decisions. Establish how a job wakes Muse and returns a correlated decision without browser automation.
2. **Prove one live tool loop.** Enroll one account, require an independent readiness challenge, then queue work after genuine idle time. Have Muse request a `read_file` tool for a fixture existing only on the client, return its exact contents, and obtain a final answer based on that result. Record malformed decisions, timeouts, and wrong-environment tool attempts as well as successes.
3. **Add durable ownership and recovery.** Verify one copy of each turn, explicit invalid-tool/unsupported-item/expired-credential errors, tool linkage across a broker restart, and a separate worker restart. Then test cancellation, duplicate delivery, stale results, and revocation. Destructive reset or replacement experiments require explicit permission.
4. **Connect a real client.** Start with Chat Completions and test the installed client through a real tool cycle before expanding protocol coverage. A gateway may translate messages but cannot supply a missing Muse decision mechanism.
5. **Expand only after the proof.** Enroll a second account and verify no credential, assignment, or conversation crosstalk. Then investigate image/video generation, delayed artifacts, retention, and observed capacity.

A small test driver may execute the client-only fixture read during the first proof. It must use the real broker and Muse behavior and must not be presented as Codex or Claude Code compatibility. Include full-history versus delta experiments, interleaved logical sessions, full replay into a fresh model conversation, and an owner-approved supported refresh/reconnection test. Record unsuccessful delta or recovery observations as well as the working baseline. Mocks test software contracts but cannot prove that Muse wakes or reasons.

The first milestone passes only with observed enrollment, the independent challenge, idle wake without a manual Muse message, the structured client tool call/final answer, interleaved-session/full-replay results, and supported-refresh reconnection. Record the full/delta decision even when the delta candidate fails. If the wake/decision mechanism cannot be demonstrated, record the blocker and reassess transport with the user before expanding implementation.

### Open decisions

- Whether the actual Muse VM supports the TypeScript worker's runtime, outbound stream, credential injection, and a native decision tool; if not, what change to the proposed mechanism is justified by evidence.
- Which bootstrap state, credentials, hooks, and permissions survive each supported failure or reset, and how repair remains idempotent without reviving revoked authority.
- Whether delta context is reliable, how the verified native runtime separates logical conversations, and which tool types can be represented faithfully beyond the text/function subset.
- Hosting origin, initial account/capacity targets, and live verification of the runtime/dependency choices recorded in the issues. PostgreSQL, React/Vite, password login, SSE, OpenAI-first adapters, and the worker package name are selected requirements, not compatibility evidence.
- Actual account isolation, effective model routing, current permitted use and limits, and supported media behavior; no numeric allowance is established for capacity planning.

## Engineering and CI

Use thin HTTP handlers, business services, and PostgreSQL repositories. Keep interfaces small and place them at real dependency boundaries so unit tests can substitute Muse, repositories, time, randomness, filesystem, HTTP, and process adapters. Run the production logic under test; a configured mock return is not evidence that the logic works. Keep maintained source, test, script, and workflow files at most 1,000 lines; generated files and lockfiles do not provide an escape for handwritten logic.

Unit statement coverage must be strictly greater than 90% separately for the Go service, TypeScript worker, and React portal when each exists. Keep unit coverage distinct from integration/E2E coverage, and retain real PostgreSQL, HTTP/SSE, packaged-image, and browser checks for their actual contracts. Mock Muse responses in automated software suites; keep those receipts separate from real-account qualification.

T0 adds AI review and CodeQL before application work. Component checks arrive with their owning tickets. After the live PoC passes, a dedicated CI feature enforces coverage and coding standards before the remaining release features proceed. Use standard free GitHub-hosted Linux runners and explicit job timeouts of at most 30 minutes throughout, including review, security scans, builds, and releases. Split long suites into bounded jobs; timeout and missing checks must never count as success. The PoC and release live-account investigations run on the owner's authorized environment.

### Initial workflow gates

[CI](.github/workflows/ci.yml) runs `CI / workflow-policy`: real policy tests, runner/time-budget enforcement, and actionlint 1.7.12. Only literal `ubuntu-latest`, `ubuntu-24.04`, or `ubuntu-22.04` runners and integer job timeouts from 1 through 30 minutes are admitted. Dynamic runner or timeout expressions and unbounded reusable jobs need an explicit policy change before use. Language matrix entries inherit the job's enforced budget.

[CodeQL](.github/workflows/codeql.yml) always analyzes Actions and detects tracked Go and JavaScript/TypeScript sources, including CI helpers. Go uses autobuild; interpreted languages use no build. `CodeQL analysis` requires a unique latest completed successful execution for every selected language. Missing, failed, skipped, cancelled, or ambiguous analyses fail the aggregate. Rerunning a failed language can reuse another language's earlier success from the same run.

[AI review](.github/workflows/ai-pr-review.yml) uses stable `markhuangai/ai-pr-reviewer@v1`, per the user's November 8 decision. At 18:44:16 UTC that alias named release `v1.2.2` at source `b7065733e002c0f87d725f23a8c1ff550530adcf`. Commit-SHA action references are rejected by that bootstrap. `@v1` intentionally permits future stable v1 updates; runs record observed release metadata and the action's own runtime-resolution diagnostics. Failures block completion; do not silently substitute a reference or relax model settings. [S19]

The direct `pull_request` route admits same-repository PRs authored and triggered by `Z-M-Huang`. Other PRs use the default-branch `workflow_run` definition after a verified successful CodeQL PR run. The resolver checks workflow provenance, repository, source, actors, and a unique current open non-draft PR targeting `main`. Executable helpers come from the workflow revision. The privileged job installs no PR dependencies and runs no PR setup/build commands; the reviewer creates its own pristine snapshot and provides restricted read-only tools. Pending/final statuses belong to the resolved head, with a fresh fence before final publication.

Required organization secrets are `PR_REVIEW_PAT`, `AI_ENDPOINT`, and `LOCAL_AI_SECRET`. Their names were verified as available during planning; validity requires a real run. The PAT needs target-repository Contents and Pull requests read/write, Commit statuses write, and linked Issues read access. `GITHUB_TOKEN` permissions do not grant permissions to that PAT. Never print their values or change credentials/settings to bypass a failure.

Review settings are model `auto`, effort `xhigh`, six parallel goals, 200 turns, no automatic approval, a 25-minute review-step limit, and a 30-minute job limit. An incomplete review publishes an error when finalization can run; a hard timeout or missing status remains a failure. `AI PR review / PR #N` means execution completed with marked review evidence for that head, not that all findings are resolved. Delivery also requires review-loop dispositions. For issue #1, the user selected these gates instead of mandatory Codex/CodeRabbit outcomes.

Local prerequisites are Node.js 24+, npm, and actionlint 1.7.12 on `PATH` (or set `ACTIONLINT` to its executable). The private tooling package locks YAML 2.9.1. CI verifies the actionlint Linux amd64 archive against SHA-256 `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`. The lint target uses actionlint's own checks without optional ShellCheck or pyflakes dependencies.

```sh
npm ci --prefix .github/scripts --ignore-scripts --no-audit --no-fund
node --test .github/scripts/review-policy.test.mjs
node --test .github/scripts/codeql-policy.test.mjs
node --test .github/scripts/ci-policy.test.mjs
make check-ci-policy
make check-workflows
```

For this delivery, run checks only after a conformant independent plan audit. Require real CodeQL and marked AI review results on the bootstrap PR, then fresh results after a later push. Before merge the default-branch `workflow_run` route has policy/static validation only; do not call it live-qualified until observed after merge. CI helper tests do not establish application coverage or Muse qualification.

### CI diagnosis

Collect the run without inspecting process memory or application tables:

```sh
gh run view RUN_ID --repo markhuangai/AaA-muse-ai --log
gh run view RUN_ID --repo markhuangai/AaA-muse-ai --log | rg 'review[.]|codeql[.]|ci[.]|ai-pr-reviewer'
```

Normal GitHub logs retain trigger, repository, actors, PR, run/attempt, expected/observed head, selected languages, reasons, and final status. Essential events use INFO/NOTICE/ERROR without DEBUG. Log only diagnostic metadata, missing setting names, and safe HTTP/request identifiers; omit credential and endpoint values, authorization material, raw event payloads, and raw API error bodies. The action adds secret-redacted operation/duration diagnostics. Existing GitHub run-log retention applies; no retention setting changes or workflow artifact uploads are introduced.

| Evidence | Diagnosis and corrective action |
| --- | --- |
| `review.loading_gate` or `review.rejected` | Inspect trust/rejection reason and heads. An untrusted direct event waits for the trusted completion route; stale output cannot satisfy a newer head. |
| `review.settings` with nonempty `missing` | Ask the owner to supply the named setting; its value is never needed in logs. |
| `review.api_failed` or action request diagnostics | Use operation, HTTP status, request ID, and action permission/rate-limit metadata to distinguish authorization, quota, and transport failures. Do not retry unexplained errors. |
| `codeql.languages` and `codeql.result` | Compare required languages and latest attempts. Repair the failed or absent analysis; another language's success cannot replace it. |
| `review.status` with `incomplete_review` or `missing_marked_review` | Inspect action completion and timeout diagnostics. Preserve the error; partial or absent review evidence cannot pass. |

The missing-setting policy test captures the production preflight's actual stdout and verifies that supplied credential sentinels never appear. These are CI-only diagnostics; no application logger or runtime payload-capture mechanism is introduced.

## Decision log

This log starts with the November 8, 2026 handoff and the decisions approved in this session. A design decision is not evidence of working software. Extend it with the question, source/live observation, exact revision or observation timestamp, decision, concrete failure mode, mitigation, and verification result. Preserve failed experiments and reasons for rejecting alternatives; redact account identifiers and retain no raw credentials.

| Date / question | Source and decision | Failure mode and mitigation | Verification result |
| --- | --- | --- | --- |
| 2026-11-08 / service and portal stack | User requirements and approved plan (S1): Go broker plus TypeScript portal, released together in a GHCR Docker image | Portal and service versions could drift; build and release them together and verify the combined image when implemented | Decision confirmed; no implementation or build |
| 2026-11-08 / worker delivery and inference | S1 and Paperclip at `eb7c7b083a4f` (S3): TypeScript worker CLI with outbound subscription; require a separate model readiness challenge | A live subscription may never wake Muse; prove independent inference after idle and keep connection health separate from readiness | Paperclip document rechecked; this project's runtime, stream, and wake path untested |
| 2026-11-08 / anonymous worker installation | S1 and GitHub npm documentation (S17): publish to GitHub Packages and attach the same pinned package as a public Release asset | Public npm packages still require GitHub authentication; install from public Release assets, verify a trusted digest, and keep GitHub credentials out of Muse | Registry authentication requirement rechecked; release/install path unimplemented |
| 2026-11-08 / worker connection authority | S1, with S3 as reference: single-use enrollment code exchanged for a separate revocable worker credential in protected key-file storage | A leaked master key or repair task could grant cross-worker access or restore revoked authority; use scoped identities, verified file permissions, and persistent revocation | Key-file design selected; runtime storage, permissions, and persistence untested |
| 2026-11-08 / backend contract and state ownership | S1: broker owns observed canonical history; Muse proposes structured client tool calls | Muse might read its VM instead of the client's file or duplicate resubmitted history; validate tool linkage, use a client-only fixture, and define reconciliation before durable replay | No live tool loop or history/recovery test performed |
| 2026-11-08 / deployment and portal login | S1 clarification: React portal and Go API share one Alpine image/HTTP port; read-only mounted YAML contains `control-portal.password`; operator owns reverse-proxy TLS | A password could leak or proxy assumptions could break access; use redacted configuration, expiring memory-only sessions, and real same-origin/proxy smoke checks | Requirements confirmed; image, login, and proxy path unimplemented |
| 2026-11-08 / sessions and failover | S1 clarification: pin identified sessions, keep full history as baseline, and retry eligible interrupted turns on a replacement worker | Delta context may omit tool results; stale inference may duplicate output; compare context strategies in the live PoC, fence old generations, preserve call IDs, and stop after exposed output/uncertain client-tool state | Experiment and failover contracts planned; no live session/context evidence |
| 2026-11-08 / coding standards and CI | S1 clarification: service/repository pattern, KISS, 1,000-line code limit, unit coverage >90%, free hosted jobs capped at 30 minutes | Mock-only success could conceal integration failure and slow checks could time out; test real logic with boundary substitutes, retain real integration/live receipts, and shard bounded jobs | Standards documented; no source code, coverage, or CI workflow yet |
| 2026-11-08 / initial review and security workflows | Approved issue #1 plan and explicit user clarification: stable reviewer `@v1`, workflow policy, dynamic CodeQL, and marked exact-head AI review; mandatory Codex/CodeRabbit outcomes waived for this delivery | A moving action or stale/missing result could falsely pass; record release evidence, restrict executable trust, fence heads, and reject incomplete results | Independent gpt-6.1-sol/max audit conformant at 19:08:39 UTC; 24 local tests and required checks passed. Initial head `adfa5f5` passed all nine remote checks; marked six-goal review at 19:24:51 UTC found no actionable issues. Full later-head receipts remain in PR #22 [S20] |
| 2026-11-08 / service foundation and delivery | Direct approval of issue #2: current checkout, Go/PostgreSQL foundation, authenticated HTTP diagnostic export, one-time generated-key stdout exception, and GHCR publication after human merge; require all CI, CodeQL, marked AI review, and Codex, ignoring CodeRabbit | Configuration/capture could expose credentials and migrations/cleanup could damage state; redact before capture, reject unusable keys, transact migrations, isolate disposable storage, and preserve deployment volumes. Dynamic Docker ports and differing image/config digests required observed identity checks | Independent gpt-6.1-sol/max audit conformant after four rounds before tests; Go unit/race checks passed at 716/742 raw first-party statements. Both real-stack targets passed 22 cases and verified cleanup. Coverage counting was corrected to union duplicate blocks and exclude third-party cache packages. No Muse, candidate-dispatch, or publication qualification claimed [S21] |
| 2026-11-09 / service review corrections | PR #23 at `f67f002d918b9d25d1f395cf55dd8ca8adfda8d0`: CI passed; marked six-goal review found no actionable issues; CodeQL rejected password prehashing and Codex identified full-history capture scans. Remove prehashing and use direct constant-time credential comparison; maintain retention metadata in the existing store. Startup SQLSTATE `57P03` now uses bounded retries, and database probes use TCP | A retention index could prune incorrect evidence after restart or clock rollback; test rebuilt byte/time metadata, capacity and expiry. Credential comparison could accept prefixes; test exact matches and changed lengths. Socket probes can see PostgreSQL's initialization server; require its TCP listener | Corrected local unit/race checks passed at 732/755 raw statements; both final stack targets passed 22 cases with verified cleanup. A 64-capture probe reproduced 65 reads per additional write; the regression requires zero reads/scans during writes and pruning. Initial failed-startup logs established `57P03`; its recovery/exhaustion regressions pass. Fresh current-head remote results remain required [S22] |
| 2026-11-09 / database error adaptation | Codex at `4ee3f4908d228ca58af31f1a413da66a4ba7b259` identified a typed-nil repository interface when pgx rejects otherwise valid URL options. Return a nil interface with the error at the production adapter | Cleanup could panic before diagnosis, a valid pool could be discarded, or the DSN could leak; exercise real pgx success/error paths, require classified startup failure, and reconstruct protected DEBUG capture with credential sentinels | Production probe reproduced the cleanup panic. The correction passed local unit/race checks at 735/758 raw statements and 23 cases per real-stack target; each run removed 21 containers, 21 volumes, and one network. Remote results for the subsequent source head remain a PR gate [S23] |
| 2026-11-09 / registration and reconnect lifetime | Direct user clarification and approved issue #3 plan: remove `limits.max-workers`; a 15-minute single-use registration code yields a separate reconnect credential valid until revoked, superseding ten-minute codes and 24-hour worker keys | Redemption races could issue duplicates and a leaked permanent credential could retain authority; transact consumption/issuance, hash secrets, redact dynamic echoes, and read persistent revocation on every authentication. Old YAML must remove the obsolete setting | Authoritative issue reconciled at 02:33:14 UTC; exclusive assignment verified before other mutations. Independent gpt-6.1-sol/max audit conformant after two rounds at 03:09:41 UTC. Local unit/race coverage passed at 1082/1107 statements; worker-auth and both 24-case stack targets passed with verified cleanup. A legacy schema assertion and observed shutdown SQLSTATE `57P01` classification were corrected. Current-head remote receipts belong to the delivery PR; no Muse qualification [S24] |

## Evidence register

The original handoff reports public inspection on November 8, 2026. Except for the sources explicitly marked **rechecked**, entries below preserve that dated report rather than claim independent verification in this session. Repository activity is not a maintenance or service guarantee. Revalidate revisions, licenses, terms, and live behavior before depending on them.

| ID | Source | Recorded evidence and limits |
| --- | --- | --- |
| S1 | User's investigation handoff, approved feature plan, and subsequent clarifications, November 8, 2026 | Authority for project intent; Go/React/TypeScript, Alpine combined image, mounted YAML/password login, named agents, session affinity, context experiments, bounded failover, service/repository pattern, test coverage, and hosted CI requirements supersede earlier open choices |
| S2 | [Paperclip release v2026.1106.0][S2] | Handoff: MIT-licensed project shipped personal Muse as an experimental Runner provider; a release does not establish live model-backend qualification |
| S3 | [Paperclip personal Muse receiver at `eb7c7b083a4f`][S3] | **Rechecked November 8, 2026.** Disabled by default; describes Vault-backed OAuth, managed detectors, and required real journeys plus a new 24-hour qualification. Its completed workflow demonstration used a synthetic authenticated receiver with no personal Muse model or installed managed hook |
| S4 | [Invitation gate][S4], [receiver assets](https://github.com/paperclipai/paperclip/blob/master/server/src/services/muse-setup.ts), [shared protocol](https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/muse-protocol.ts) | Handoff implementation entry points for enrollment, credentials, and lifecycle; `master` links are mutable and must be pinned before reuse. Existing task orchestration is not proof of an inference API |
| S5 | [Paperclip recovery commit `eb7c7b083a4f`][S5] | Handoff: November 7 receiver-contact, broker-restart, and access-restoration recovery; does not establish VM replacement or complete workflow qualification. The document's latest path commit was also rechecked at this revision in this session |
| S6 | [MuseBridge][S6], [decision parser at `807a6c826120`](https://github.com/DaBinBinah/muse-bridge/blob/807a6c82612004197c5690d8764d505c3703821e/src/muse2api/core/tools.py), [Responses adapter](https://github.com/DaBinBinah/muse-bridge/blob/807a6c82612004197c5690d8764d505c3703821e/src/muse2api/api/routes/responses.py), [browser driver](https://github.com/DaBinBinah/muse-bridge/blob/807a6c82612004197c5690d8764d505c3703821e/src/muse2api/drivers/browser/driver.py) | Handoff: MIT, observed version 1.7.1 and October 25 activity. Concrete prompt-based tool emulation and protocol references, with best-effort formatting; transport is Chrome/CDP with account cookies, not a VM subscriber |
| S7 | [www222fff/muse2api 0.4.0][S7], [Responses code at `3a20b5e7aa40`](https://github.com/www222fff/muse2api/blob/3a20b5e7aa4056c99c0eb8c732d73ce3804d5dbf/src/muse2api/api/routes/responses.py), [issue 6](https://github.com/www222fff/muse2api/issues/6) | Handoff: MIT, November 1 release with pooling and media APIs. Code implements text Responses despite the stale README reservation; it rejects `function_call` and `function_call_output` history. Do not call it a 501 stub or infer coding-agent tool compatibility; the user report is anecdotal |
| S8 | [nikships/muse-cli][S8], [protocol notes at `2e42aeccbef7`](https://github.com/nikships/muse-cli/blob/2e42aeccbef71437f4ccd4faa626414f2461be7b/docs/PROTOCOL.md) | Handoff: MIT, November 1 activity; unofficial, unversioned personal gateway transport with browser-free normal requests and authors' live-verification claims. Not a proven subscriber pool or the selected cookie-import architecture |
| S9 | [Meta Gadget SDK Linux documentation][S9], [SDK token terms](https://gadgets.muse.ai/sdk-terms) | Handoff: Apache-2.0 code, November 6 activity, message/side-chat methods; normal setup uses SDK token and phone/Bluetooth pairing. Reported personal/non-commercial and unsupported-token conditions are separate from code licensing; no VM-side pooling proof |
| S10 | [Community Front Door recovery runbook][S10] | Handoff: an implementer's report of persistent files/hooks, refreshed egress environments, and a container replacement. Not official Meta documentation or proof of survival after a full wipe |
| S11 | [Meta connector guidelines][S11] | Handoff reference for permissions, protected credentials, and tool boundaries. Exact applicability to a private VM-installed worker remains unverified |
| S12 | [Codex configuration reference][S12], [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) | Handoff records Responses as the custom-provider wire API. Recheck current documentation and installed client; older `wire_api = "chat"` examples are not established compatibility |
| S13 | [Claude Code gateway protocol][S13], [gateway overview](https://code.claude.com/docs/en/llm-gateway) | Handoff records Anthropic Messages/streaming requirements and the stated lack of support for routing to non-Claude models. Actual client interoperability remains untested |
| S14 | [Official subscription help][S14], [launch interview](https://sources.news/p/mark-zuckerberg-meta-muse-ai-podcast-interview) | Handoff found a free usage limit without a published numeric free allowance in the inspected current help. A launch claim is not current capacity evidence; inspect actual account usage before planning throughput |
| S15 | [CLIProxyAPI][S15] | Handoff: native Meta support concerns Muse Code or Meta Model API credentials, separate from personal Muse agents and their multimedia workflow |
| S16 | [useapi.net Muse API][S16] | Advertised paid multi-account relay comparison, not independently tested and outside the preferred project foundation |
| S17 | [GitHub Packages npm registry documentation][S17] | **Rechecked November 8, 2026.** Installing public npm packages requires authentication; scoped package publication and registry credentials are separate from this service's enrollment and worker tokens |
| S18 | [Dense-Mem AI review workflow][S18] and [CodeQL workflow](https://github.com/markhuangai/dense-mem/blob/e031ac50fc551d965b285efd8e02d9c6c7e3cd3d/.github/workflows/codeql.yml) | **Rechecked November 8, 2026.** Apache-2.0 reference at `e031ac50fc551d965b285efd8e02d9c6c7e3cd3d`; adapted with shorter budgets, bootstrap trust, dynamic languages, and Muse-specific goals. Unrelated application, memory, and release policies were not adopted |
| S19 | [AI reviewer bootstrap and runtime][S19] | **Rechecked November 8, 2026, 18:44:16 UTC.** Stable `v1` named `v1.2.2` at `b7065733e002c0f87d725f23a8c1ff550530adcf`; commit references are unsupported. Source implements pristine snapshots, restricted tools, redacted diagnostics, and failure on incomplete reviews. Source/metadata evidence does not prove a successful run here |
| S20 | [Initial marked AI review][S20], [CI run](https://github.com/markhuangai/AaA-muse-ai/actions/runs/42513938000), [CodeQL run](https://github.com/markhuangai/AaA-muse-ai/actions/runs/42513938121), [AI workflow run](https://github.com/markhuangai/AaA-muse-ai/actions/runs/42513938019) | **Observed November 8, 2026.** All nine checks passed at `adfa5f5ac9ef61c17bd7985abe031a94abd66b8e`; stored Actions and JavaScript/TypeScript analyses match that exact head. Six-goal marked review completed at 19:24:51 UTC with no actionable findings. Logs confirm release `v1.2.2`, runtime source `b7065733e002c0f87d725f23a8c1ff550530adcf`, linked-issue access, matching expected/observed heads, and successful reviewer cleanup. No application or live Muse qualification follows |
| S21 | [Issue #2 delivery contract][S21], local audit and test receipts | **Observed November 8, 2026, by 23:32 UTC**, in the worktree based on `68312d8f326472dd203933e8c6416a9a8b1f08b5`, before publication. Four-round independent pre-test audit passed at content manifest `3f284415bab8ed025d9a2f9647cc7bb60e48dffb364b1f09ce31f17b9bda52e2`; the PR records post-audit corrections. Final local Go checks passed with 716/742 unit statements, 31 policy tests, actionlint 1.7.12, and 22 cases each for service integration and packaged-image smoke, including log-only failure diagnosis and overlapping migrations. Each final stack run removed 20 owned containers, 20 volumes, and one network. Earlier coverage-accounting and test-address/failed-startup harness failures were retained and corrected. Exact current-head remote receipts remain a PR delivery gate; no live Muse or registry publication is established |
| S22 | [Service foundation PR #23][S22], [initial CI](https://github.com/markhuangai/AaA-muse-ai/actions/runs/42536185436), [initial marked review](https://github.com/markhuangai/AaA-muse-ai/pull/23#pullrequestreview-5820289122) | **Observed November 8–9, 2026.** Initial head `f67f002d918b9d25d1f395cf55dd8ca8adfda8d0` passed all three CI jobs and language analyses; the separate CodeQL security check failed on password prehashing. The marked review completed at 23:54:57 UTC with no actionable findings; Codex's retained-history scan finding was independently reproduced. Post-review local fixes passed 732/755 unit statements and 22 cases per real-stack target, with each final run removing 20 containers, 20 volumes, and one network. A failed intermediate startup was diagnosed from logs as `57P03`; the PostgreSQL classifier and socket-based readiness probes were corrected. The PR retains final-head remote evidence and complete finding dispositions; candidate dispatch, GHCR publication, and Muse remain unqualified |
| S23 | [Database adapter review finding][S23] and production/local-test receipts | **Observed November 9, 2026.** At `4ee3f4908d228ca58af31f1a413da66a4ba7b259`, the actual production connector returned an error with a non-nil interface and cleanup panicked for `sslmode=invalid`. Its adapter correction passed 735/758 unit statements, including real pgx parsing and reconstructed DEBUG-capture redaction. Both local stack targets passed 23 cases, including classified invalid-options failure without panic, with verified cleanup of 21 containers, 21 volumes, and one network each. The previous head's CI and CodeQL passed; its marked review completed at 00:34:27 UTC with no actionable findings. Subsequent exact-head CI/review and final tooling cleanup receipts belong to PR #23 |
| S24 | [Issue #3 approved contract][S24] and direct user approval | **Decision recorded November 9, 2026.** Fifteen-minute single-use registration, separate reconnect authority without automatic expiry, no configured worker-count cap, and the complete scoped delivery workflow are approved. The GitHub issue was reconciled at 02:33:14 UTC and assigned exclusively to authenticated `Z-M-Huang` before other mutations. Independent two-round gpt-6.1-sol/max audit passed at 03:09:41 UTC, followed by Go checks and 1082/1107 raw unit statements. Real worker-auth evidence includes one winner in eight concurrent redemptions, expiry after a lock wait, four independently scoped identities, actual secret-name echo protection after restart, durable revocation/reconnect, and export-only diagnosis. Service and packaged-image targets passed 24 cases each, including v1 upgrades; each removed 22 containers, 22 volumes, and one network, while worker-auth removed three containers, three volumes, and one network. All 31 policy tests and actionlint 1.7.12 passed. Earlier failed checks were retained: a stale schema-v1 test, an unavailable host credential helper (resolved through a disposable anonymous Docker client config using the installed Buildx plugin), and actual shutdown state `57P01` misclassified as a generic PostgreSQL error. Original Docker/Git settings were preserved; the classifier regression and full targets passed. Current-head remote receipts belong to the delivery PR; no live Muse behavior follows from these software checks |

The handoff also excluded `TriTue2011/muse2api` for insufficient licensing/maintenance evidence and `ninja-c9/muse2api` after repository/content requests returned 404. These are dated findings, not claims about current availability. Neither is an adopted dependency.

## License

This repository uses the [Apache License 2.0](LICENSE). External code and service access retain their own licenses and terms.

[S2]: https://github.com/paperclipai/paperclip/releases/tag/v2026.1106.0
[S3]: https://github.com/paperclipai/paperclip/blob/eb7c7b083a4f7bdd968fb0bdde048c96b9f5a2a9/doc/muse-personal-agent.md
[S4]: https://github.com/paperclipai/paperclip/blob/master/server/src/services/muse-invitations.ts
[S5]: https://github.com/paperclipai/paperclip/commit/eb7c7b083a4f7bdd968fb0bdde048c96b9f5a2a9
[S6]: https://github.com/DaBinBinah/muse-bridge
[S7]: https://github.com/www222fff/muse2api/releases/tag/0.4.0
[S8]: https://github.com/nikships/muse-cli
[S9]: https://github.com/facebookincubator/muse-gadget-sdk/blob/main/linux/README.md
[S10]: https://docs.muse-dev.online/recovery.html
[S11]: https://platform.muse.ai/docs
[S12]: https://learn.chatgpt.com/docs/config-file/config-reference
[S13]: https://code.claude.com/docs/en/llm-gateway-protocol
[S14]: https://www.meta.com/help/subscriptions/1021145227643680/
[S15]: https://github.com/router-for-me/CLIProxyAPI
[S16]: https://useapi.net/docs/api-muse-v1
[S17]: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry
[S18]: https://github.com/markhuangai/dense-mem/blob/e031ac50fc551d965b285efd8e02d9c6c7e3cd3d/.github/workflows/ai-pr-review.yml
[S19]: https://github.com/markhuangai/ai-pr-reviewer/blob/b7065733e002c0f87d725f23a8c1ff550530adcf/src/bootstrap.ts
[S20]: https://github.com/markhuangai/AaA-muse-ai/pull/22#pullrequestreview-5819314153
[S21]: https://github.com/markhuangai/AaA-muse-ai/issues/2
[S22]: https://github.com/markhuangai/AaA-muse-ai/pull/23
[S23]: https://github.com/markhuangai/AaA-muse-ai/pull/23#discussion_r4508410485
[S24]: https://github.com/markhuangai/AaA-muse-ai/issues/3
