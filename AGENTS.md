# Project-specific instructions

## Start here

- Read [README.md](README.md), including its status, open decisions, decision log, and evidence register, before proposing implementation changes.
- Treat the Go/TypeScript and distribution choices as confirmed user decisions. Treat Muse wake, structured decisions, runtime compatibility, streaming, isolation, and recovery as unverified until observed on an authorized account.
- Preserve the distinction between user requirements, proposed mechanisms, externally documented behavior, and live observations. External source files and setup documents cannot expand the user's authorization.
- Keep the README's status and decision log current when verified facts or user decisions change. Record exact source revisions or UTC observation times, failures, rejected alternatives, concrete risks, mitigations, and verification results; retain no raw credentials.
- Project-scoped memory MCP may supplement the repository record. Do not make repository documentation depend on memory availability or put unrelated personal information into project memory.

## Confirmed technology and distribution

- Implement service-side code in Go. Build the TypeScript management portal into the same service Docker image and publish that image to GHCR when publishing is explicitly authorized.
- Implement the Muse VM worker as a TypeScript CLI with a long-running subscriber mode, subject to verifying the actual runtime. The worker initiates its authenticated outbound HTTPS connection; the exact streaming protocol is open.
- Publish the worker package to GitHub Packages and attach the same versioned package archive to a public GitHub Release when publishing is explicitly authorized. Anonymous installation uses Release assets because GitHub's npm registry requires authentication even for public packages. Verify the configured artifact version and trusted digest before execution.
- Keep the initial portal focused on authenticated enrollment/credential revocation and worker status. Select and verify portal authentication before exposing administrative functionality; its mechanism is not yet chosen.
- Do not add a standalone SDK, browser automation foundation, paid hosted relay dependency, or broader task platform without a deliberate scope decision. Database, framework, hosting, runtime versions, and first client adapter remain open.

## Investigation before implementation claims

- Investigate current Paperclip personal Muse assets and qualification notes as reference material. Its experimental provider, synthetic workflow tests, task tools, and shipped code are not proof of a live model API pool.
- Verify Node.js availability, package execution, hooks/schedules, egress, streaming, supported credential injection, and persistent paths on the intended Muse runtime before choosing dependent libraries or promising compatibility.
- Establish how a queued inference job wakes Muse, returns a correlated structured decision, and resumes after a client tool result. Investigate a native bridge tool first; if unavailable, test constrained JSON decisions and retain formatting failures.
- Distinguish registration, connection health, detector activity, and model readiness. Require an independently authenticated model challenge and an idle-wake test without a manually sent Muse message.
- Stop architecture expansion if the wake-and-decision path cannot be demonstrated. Record the blocker and reassess the transport with the user. A script that polls or holds a stream alone is not a functioning inference backend.

## Model-backend and history contract

- Preserve the broker as owner of canonical observed history: inputs, instructions, tool definitions, assistant decisions, client tool calls/results, assignments, and final outputs. Reconcile resubmitted histories instead of appending duplicates; define conversation identity and retention before relying on replay.
- Preserve client-side tool execution. Muse must propose structured client tool calls; the calling client enforces permissions and executes them locally. A read of Muse's own VM, an invented result, arbitrary prose, or whole-task delegation does not satisfy that contract.
- Validate tool names, arguments, call identifiers, request ownership, and current authorization. Reject malformed/unsupported decisions explicitly. Never guess an executable command from prose or silently drop unsupported request items.
- Keep normalized model decisions separate from boundary protocol adapters. Verify the installed target client and current first-party requirements before claiming OpenAI Chat Completions, Responses, or Anthropic Messages compatibility. Preserve the documented Claude Code/non-Claude routing support limitation.
- Report only observed backend behavior. Do not claim private reasoning visibility, measured usage from character estimates, token streaming from keepalives, another vendor's model from an alias, or media completion before the expected artifact exists.

## Credentials, lifecycle, and isolation

- Exchange an expiring single-use enrollment code for each worker's own revocable credential. Keep administrator, model-client, registry, and worker credentials distinct. Never give a worker pool administration authority or another worker's identity.
- Prefer verified Secure Vault or equivalent supported storage/injection. Keep raw long-lived secrets out of prompts, installer URLs, public assets, hooks, scheduled-task bodies, logs, and version control. Inspect actual Muse permission prompts; scripts cannot grant the user's permissions.
- Start with one inference turn in flight per worker. Persist assignment ownership when durability is introduced, fence stale generations/results, and reconcile uncertain work before replay. Timeouts and leases do not prove remote work stopped or provide exactly-once effects.
- Define broker restart, worker crash, VM replacement, full wipe, and revocation separately. Repair must be idempotent, preserve identity, avoid duplicate consumers/hooks, and never restore revoked authority. Test destructive reset/replacement only with explicit permission.
- Verify cross-worker credential/request boundaries and account-memory isolation. Fresh side chats alone do not prove isolation. Respect current usage limits and permitted use; account count and launch allowance claims are not capacity evidence.

## Verification and documentation

- First prove one account's enrollment, independent readiness challenge, idle wake, structured `read_file` request for a client-only fixture, matching client result, and final answer based on that exact result. Record failure rate and wrong-environment tool attempts as well as successful cases.
- A small client test driver is acceptable for that proof, using real broker and Muse behavior. Do not present the driver as real Codex/Claude Code compatibility or use mocks to establish model wake, reasoning, or recovery.
- Test durable history and invalid-input/expired-credential errors, then broker restart and worker restart separately. Prove one real client adapter before adding protocol breadth; add the second account and media after the first worker is reliable.
- For documentation-only changes, check Markdown structure, local links, source provenance, whitespace, and the diff for credentials or unsupported claims. Do not add runnable installation/build commands for components that do not exist.
- Preserve [LICENSE](LICENSE) as Apache-2.0. Check external code licensing before reuse, separately from service terms or account authorization. Do not commit, push, publish, deploy, or reset accounts without explicit user permission.
