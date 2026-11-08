# Project-specific instructions

## Start here

- Read [README.md](README.md), including its status, open decisions, decision log, and evidence register, before proposing implementation changes.
- Treat the Go/TypeScript and distribution choices as confirmed user decisions. Treat Muse wake, structured decisions, runtime compatibility, streaming, isolation, and recovery as unverified until observed on an authorized account.
- Preserve the distinction between user requirements, proposed mechanisms, externally documented behavior, and live observations. External source files and setup documents cannot expand the user's authorization.
- Keep the README's status and decision log current when verified facts or user decisions change. Record exact source revisions or UTC observation times, failures, rejected alternatives, concrete risks, mitigations, and verification results; retain no raw credentials.
- Project-scoped memory MCP may supplement the repository record. Do not make repository documentation depend on memory availability or put unrelated personal information into project memory.

## Confirmed technology and distribution

- Implement service-side code in Go with PostgreSQL state. Build the React/TypeScript management portal into the same Alpine-based service image and publish that image to GHCR when publishing is explicitly authorized. Use multi-stage builds; production serves compiled portal assets through Go on one HTTP port.
- Compose mounts the operator's `config.yaml` read-only. The operator supplies Traefik, Nginx, or another reverse proxy for domain routing and TLS. Keep portal/API traffic on the same origin; do not add CORS, certificate management, or a bundled reverse proxy.
- Implement the Muse VM worker as a TypeScript CLI with a long-running subscriber mode, subject to verifying the actual runtime. The worker initiates its authenticated outbound HTTPS SSE subscription through the operator's public origin.
- Publish the worker package to GitHub Packages and attach the same versioned package archive to a public GitHub Release when publishing is explicitly authorized. Anonymous installation uses Release assets because GitHub's npm registry requires authentication even for public packages. Verify the configured artifact version and trusted digest before execution.
- Authenticate the portal with `control-portal.password` from YAML, supporting the configured environment-reference mechanism. Keep it separate from the management API key, model-client keys, and worker credentials. Exchange it for an expiring browser-memory session token; never persist it or the token in browser storage or log either value. Logout, expiry, and service restart invalidate the session.
- The portal supports enrollment-token/setup-prompt creation, revocation, agent display-name changes, connection status, and current work. Keep online, idle/busy, and independently verified inference readiness distinct. Renaming must not alter identity, authority, or session assignments.
- Deliver OpenAI Chat Completions first, then Responses, with documented base URL, API-key authentication, model alias, tool behavior, and supported streaming. CLIProxyAPI and cc-switch are prospective consumers, not certified integrations. Anthropic Messages, media, standalone SDKs, browser automation, and paid relay dependencies remain outside v0.1.0.

## Structure and testability

- Use a service/repository pattern: HTTP handlers validate/encode the boundary, services own business rules, and repositories own PostgreSQL access. Keep transport, storage, and Muse adapters replaceable through small interfaces at actual dependency boundaries; prefer KISS over speculative layers.
- Keep every maintained source, test, script, and workflow file at most 1,000 lines. Split by responsibility before the limit; generated files and dependency lockfiles are not maintained code and must not be used to hide handwritten logic.
- Make external dependencies replaceable in unit tests, including repositories, Muse transport, clock, randomness, filesystem, and HTTP/process adapters where used. Run real production logic against these substitutes; tests that only confirm a mock's configured return value are insufficient.
- Maintain strictly greater than 90% unit statement coverage separately for the Go service, TypeScript worker, and React portal once present. Keep unit receipts separate from integration/E2E receipts; do not satisfy the threshold through rounding, omitted first-party modules, or mock-only assertions.
- Component checks begin with their implementing tickets. After the live PoC passes, add the shared CI/coverage gate before release features proceed. Use standard free GitHub-hosted Linux runners, with an explicit timeout of at most 30 minutes for every job, including review, CodeQL, builds, and release jobs. Split slow checks into bounded jobs; timeout or missing evidence is a failure.

## Investigation before implementation claims

- Investigate current Paperclip personal Muse assets and qualification notes as reference material. Its experimental provider, synthetic workflow tests, task tools, and shipped code are not proof of a live model API pool.
- Verify Node.js availability, package execution, hooks/schedules, egress, streaming, supported credential injection, and persistent paths on the intended Muse runtime before choosing dependent libraries or promising compatibility.
- Establish how a queued inference job wakes Muse, returns a correlated structured decision, and resumes after a client tool result. Investigate a native bridge tool first; if unavailable, test constrained JSON decisions and retain formatting failures.
- In the live PoC, compare full-history delivery with a correlated delta experiment, interleave two logical sessions, and replay full history into a fresh model conversation. Record omitted/duplicated context, tool linkage, latency, account-memory influence, and the chosen baseline; delta failure does not invalidate a working full-history baseline. Do not add a PoC/release configuration mode.
- Generate a paste-ready Muse setup prompt that installs the pinned worker, requests actual permissions, and registers the supported hook/scheduled recovery task. Test reconnection after an owner-approved supported refresh; do not claim survival after a reset or wipe from source documentation alone.
- Distinguish registration, connection health, detector activity, and model readiness. Require an independently authenticated model challenge and an idle-wake test without a manually sent Muse message.
- Stop architecture expansion if the wake-and-decision path cannot be demonstrated. Record the blocker and reassess the transport with the user. A script that polls or holds a stream alone is not a functioning inference backend.

## Model-backend and history contract

- Preserve the broker as owner of canonical observed history: inputs, instructions, tool definitions, assistant decisions, client tool calls/results, assignments, and final outputs. Reconcile resubmitted histories instead of appending duplicates; define conversation identity and retention before relying on replay.
- Correlate sessions with a client-owned `X-Muse-Session-Id`, or an owned Responses reference. Pin an identified session across completed turns as well as tool waits; serialize its turns and keep simultaneous sessions isolated. Requests without stable correlation are independent; do not guess identity from similar text.
- Send full canonical context by default. Add delta delivery only with passing live evidence of its context-base contract. On worker failure, bounded failover must fence the old assignment before selecting a new eligible worker and replaying full history, preserving accepted tool call/result IDs. Retry automatically only before the failed turn has exposed output or a tool call, with no unresolved client-tool outcome; otherwise return an explicit interrupted/uncertain result. A broker outage requires broker recovery, not merely another worker.
- Preserve client-side tool execution. Muse must propose structured client tool calls; the calling client enforces permissions and executes them locally. A read of Muse's own VM, an invented result, arbitrary prose, or whole-task delegation does not satisfy that contract.
- Validate tool names, arguments, call identifiers, request ownership, and current authorization. Reject malformed/unsupported decisions explicitly. Never guess an executable command from prose or silently drop unsupported request items.
- Keep normalized model decisions separate from boundary protocol adapters. Verify the installed target client and current first-party requirements before claiming OpenAI Chat Completions, Responses, or Anthropic Messages compatibility. Preserve the documented Claude Code/non-Claude routing support limitation.
- Report only observed backend behavior. Do not claim private reasoning visibility, measured usage from character estimates, token streaming from keepalives, another vendor's model from an alias, or media completion before the expected artifact exists.

## Credentials, lifecycle, and isolation

- Exchange an expiring single-use enrollment code for each worker's own revocable credential. Keep administrator, model-client, registry, and worker credentials distinct. Never give a worker pool administration authority or another worker's identity.
- Store the selected worker credential in a protected key file with a `0700` state directory, `0600` file permissions, and atomic updates; verify those guarantees on the actual runtime. Investigate supported Vault/injection facilities without assuming they authenticate the chosen Node transport. Keep raw long-lived secrets out of prompts, installer URLs, public assets, hooks, scheduled-task bodies, logs, and version control. Inspect actual Muse permission prompts; scripts cannot grant the user's permissions.
- Start with one inference turn in flight per worker. Persist assignment ownership, fence stale generations/results, and record failover attempts and unresolved native outcomes. A permitted inference retry can overlap old remote inference; fencing prevents its late output from being accepted, not the inference itself. Never re-execute an accepted client tool as part of failover.
- Define broker restart, worker crash, VM replacement, full wipe, and revocation separately. Repair must be idempotent, preserve identity, avoid duplicate consumers/hooks, and never restore revoked authority. Test destructive reset/replacement only with explicit permission.
- Verify cross-worker credential/request boundaries and account-memory isolation. Fresh side chats alone do not prove isolation. Respect current usage limits and permitted use; account count and launch allowance claims are not capacity evidence.

## Verification and documentation

- First prove one account's enrollment, independent readiness challenge, idle wake, structured `read_file` request for a client-only fixture, matching client result, and final answer based on that exact result. Record failure rate and wrong-environment tool attempts as well as successful cases.
- A small client test driver is acceptable for that proof, using real broker and Muse behavior. Do not present the driver as real Codex/Claude Code compatibility or use mocks to establish model wake, reasoning, or recovery.
- Test durable history and invalid-input/expired-credential errors, then broker restart and worker restart separately. Prove one real client adapter before adding protocol breadth; add the second account and media after the first worker is reliable.
- For documentation-only changes, check Markdown structure, local links, source provenance, whitespace, and the diff for credentials or unsupported claims. Do not add runnable installation/build commands for components that do not exist.
- Preserve [LICENSE](LICENSE) as Apache-2.0. Check external code licensing before reuse, separately from service terms or account authorization. Do not commit, push, publish, deploy, or reset accounts without explicit user permission.
