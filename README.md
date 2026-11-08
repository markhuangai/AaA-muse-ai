# AaA-muse-ai

Agent as API from muse.ai: a planned self-hosted broker that makes independently enrolled personal Muse agents available as model backends.

The broker owns the conversation record. Muse proposes answers or client tool calls; the calling application executes its own tools under its own permissions. Whole-task delegation may be useful later, but it does not replace this model-backend goal.

## Status

**Discovery only, as of November 8, 2026.** This repository contains project documentation and an Apache-2.0 license. No broker, worker, portal, installer, package, or container image has been implemented or published by this project.

No live Muse account has been connected or tested, no worker has been installed, and no account credentials have been collected. Model wake, structured decisions, client tool continuation, streaming transport, isolation, and recovery remain unverified on the intended accounts. There are no installation commands yet.

The [evidence register](#evidence-register) separates the supplied investigation handoff from sources rechecked in this session. Read [AGENTS.md](AGENTS.md) before contributing.

## Confirmed decisions

| Component | Technology | Intended distribution |
| --- | --- | --- |
| Broker and service APIs | Go | Docker image in `ghcr.io` |
| Management portal | TypeScript, built and served with the Go service | Included in the same service image |
| Muse VM worker CLI | TypeScript, subject to runtime verification | GitHub Packages npm package and the same versioned package archive as a public GitHub Release asset |
| Client integrations | Model protocol adapters at the broker boundary | Part of the service; no standalone client SDK is planned |

The worker CLI's long-running mode is a worker daemon: it initiates an authenticated outbound subscription stream, receives inference jobs, and submits correlated decisions and results. The service issues its connection authority. The exact stream protocol and Muse credential injection mechanism are not selected.

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

The desired delivery transport is a subscription stream from the service to the worker, over a connection initiated by the worker. Result submission must also be authenticated and correlated; whether it shares that transport remains open. An HTTP registration, heartbeat, detector check, or connected stream does not prove that Muse has started an inference.

### Responsibilities

- **Broker:** authenticate callers, reconcile incoming history, retain observed instructions and tool definitions, assign inference turns, record decisions and tool results, and expose supported model protocols.
- **Worker:** enroll with its own identity, receive scoped assignments, invoke a verified Muse wake mechanism, return decisions and artifacts, and recover only through supported runtime mechanisms.
- **Portal:** provide authenticated operator access to enrollment, credential revocation, and worker status. Show connection/detector health separately from independent model readiness. Portal authentication is still to be selected.
- **Calling client:** define its available tools, enforce local permissions, execute approved tools, and return results with the matching call identifiers.

### Conversation and tool loop

1. The client sends instructions, conversation context, and definitions of tools it can execute. The broker records or reconciles the observed input and assigns an inference turn.
2. Muse returns a final answer or a structured intent containing the client tool's name, arguments, and call identifier. Client tools have a decision-only contract: Muse must request their execution by the client.
3. The broker validates ownership, tool name, arguments, and call linkage, then returns the supported protocol representation. Unknown tools or malformed decisions produce explicit errors; a bounded correction attempt may be investigated.
4. The client applies its permissions, executes the tool locally, and sends back the result. The broker records it and supplies the necessary context for Muse's next inference turn.
5. Continue until a final answer, explicit error, cancellation, or deadline. Record each observed turn once, including its assignment and tool linkage.

A file read inside Muse's VM cannot substitute for reading the client's repository. Do not infer executable commands from arbitrary prose, invent tool results, or use Muse's native shell, browser, or connected apps as substitutes for client tools.

The broker's record covers what it observes, not Muse's private reasoning, hidden context, or unobserved activity. Clients may resend full histories, so naive appending would duplicate turns. Conversation identity, reconciliation policy, and retention remain open. A new side chat does not prove isolation from account-wide memory; routing to a different worker must not silently change the effective capabilities or personalization.

## Enrollment, credentials, and distribution

The intended enrollment is manual once per account, followed by supported automatic rejoining:

1. An authenticated operator obtains a service-generated setup instruction containing an expiring, single-use enrollment code bound to the private pool.
2. The operator pastes it into Muse. Muse downloads the versioned worker package or installer from public GitHub Release assets and verifies the artifact against the configured version and trusted digest before execution.
3. The user approves the actual Muse connection prompts. The worker exchanges the enrollment code for its own scoped, revocable credential through a verified secure storage and injection mechanism.
4. The worker records nonsecret identity and configuration, installs only supported detection and recovery mechanisms, and establishes its outbound subscription to the service.
5. The broker sends an independent model challenge. Only an authenticated, correlated Muse inference response establishes model readiness; registration or polling alone does not.

Muse's Secure Vault or an equivalent supported facility is preferred for long-lived worker authority. Its ability to authenticate the intended TypeScript client and streaming connection must be verified. Paperclip demonstrates relevant Vault-backed OAuth concepts, not a proven credential design for this project. [S3] [S4]

Worker credentials must permit only the worker's own connection/renewal, scoped job claims, heartbeats, and result submissions. Keep administrator credentials, client API credentials, package publication credentials, and each worker identity separate. Worker A must not claim or submit worker B's assignments.

Keep raw long-lived credentials out of prompts, URLs, public assets, hooks, scheduled-task bodies, logs, and version control. The temporary enrollment code is bootstrap authority, not a durable recovery credential. Reconnect or repair must not recreate revoked authority. Inspect the actual hostname approval scope; installation text cannot approve permissions on the user's behalf.

The future release process should publish the worker package to GitHub Packages and attach the same packed artifact to a public GitHub Release, recording its version and digest. Build the TypeScript portal into the Go service's release image and publish that combined image to GHCR. Package names, release automation, and supported runtime versions remain unselected; no artifacts are currently available.

## Planned capability boundaries

No client protocol is implemented or certified yet. Keep normalized decisions inside the broker and protocol translation at its boundary.

| Target | Interface to investigate | Required proof |
| --- | --- | --- |
| General model clients and gateways | OpenAI Chat Completions | Message history, structured tool calls and results, finish reasons, and valid supported streaming |
| Codex | OpenAI Responses | Input items, function/custom tools, call correlation, cancellation behavior, and complete lifecycle events |
| Claude Code | Anthropic Messages | `tool_use`/`tool_result`, stop behavior, and correct streaming sequences |
| Images and video | Capability endpoints or asynchronous jobs | Durable completion status, actual artifacts, authorized downloads, retention, and explicit unsupported parameters |

The first real client adapter is still to be selected. The handoff identified Responses as the Codex custom-provider interface; recheck the installed client and official documentation before applying configuration examples. Function-call support alone does not establish support for Codex custom tools. [S12]

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

Repair must be idempotent and must not install duplicate consumers or hooks, allocate another identity, or revive revoked credentials. Investigate an installation lock, worker generations, leases, and stale-result rejection when implementing recovery. Reconcile in-flight work before replay: a timeout does not prove that remote inference or media generation stopped. Remote cancellation remains best effort until demonstrated otherwise; fencing cannot guarantee exactly-once remote effects.

Use dedicated accounts for isolation experiments. Separate side chats alone are insufficient evidence against account-wide memory contamination. Preserve worker/request ownership, respect quotas and revocation, and do not rotate accounts to bypass limits. Source-code licenses, hosting cost, and permission to pool or re-expose Muse are separate questions.

## Investigation sequence and first acceptance test

1. **Revalidate the runtime.** Inspect current Paperclip assets and available Muse hooks, Node.js/runtime support, credential injection, persistent paths, and egress behavior. Prefer investigating a native bridge tool; otherwise test constrained JSON decisions. Establish how a job wakes Muse and returns a correlated decision without browser automation.
2. **Prove one live tool loop.** Enroll one account, require an independent readiness challenge, then queue work after genuine idle time. Have Muse request a `read_file` tool for a fixture existing only on the client, return its exact contents, and obtain a final answer based on that result. Record malformed decisions, timeouts, and wrong-environment tool attempts as well as successes.
3. **Add durable ownership and recovery.** Verify one copy of each turn, explicit invalid-tool/unsupported-item/expired-credential errors, tool linkage across a broker restart, and a separate worker restart. Then test cancellation, duplicate delivery, stale results, and revocation. Destructive reset or replacement experiments require explicit permission.
4. **Connect a real client.** Select one protocol adapter and test the installed client through a real tool cycle before expanding protocol coverage. A gateway may translate messages but cannot supply a missing Muse decision mechanism.
5. **Expand only after the proof.** Enroll a second account and verify no credential, assignment, or conversation crosstalk. Then investigate image/video generation, delayed artifacts, retention, and observed capacity.

A small test driver may execute the client-only fixture read during the first proof. It must use the real broker and Muse behavior and must not be presented as Codex or Claude Code compatibility. Mocks can test deterministic parsing, but cannot prove that Muse wakes or reasons.

The first milestone passes only when enrollment, the independent challenge, idle wake without a manual Muse message, the structured client tool call, and the final answer are observed. If the wake/decision mechanism cannot be demonstrated, record the blocker and reassess transport with the user before expanding implementation.

### Open decisions

- Whether the actual Muse VM supports the TypeScript worker's runtime, outbound stream, credential injection, and a native decision tool; if not, what change to the proposed mechanism is justified by evidence.
- Which bootstrap state, credentials, hooks, and permissions survive each supported failure or reset, and how repair remains idempotent without reviving revoked authority.
- Which client adapter comes first, how conversation identity/history reconciliation works, and which tool types and capabilities can be represented faithfully.
- Database, retention policy, frontend framework, portal authentication, stream protocol, hosting origin, package names, runtime versions, and initial account/capacity targets.
- Actual account isolation, effective model routing, current permitted use and limits, and supported media behavior; no numeric allowance is established for capacity planning.

## Decision log

This log starts with the November 8, 2026 handoff and the decisions approved in this session. A design decision is not evidence of working software. Extend it with the question, source/live observation, exact revision or observation timestamp, decision, concrete failure mode, mitigation, and verification result. Preserve failed experiments and reasons for rejecting alternatives; redact account identifiers and retain no raw credentials.

| Date / question | Source and decision | Failure mode and mitigation | Verification result |
| --- | --- | --- | --- |
| 2026-11-08 / service and portal stack | User requirements and approved plan (S1): Go broker plus TypeScript portal, released together in a GHCR Docker image | Portal and service versions could drift; build and release them together and verify the combined image when implemented | Decision confirmed; no implementation or build |
| 2026-11-08 / worker delivery and inference | S1 and Paperclip at `eb7c7b083a4f` (S3): TypeScript worker CLI with outbound subscription; require a separate model readiness challenge | A live subscription may never wake Muse; prove independent inference after idle and keep connection health separate from readiness | Paperclip document rechecked; this project's runtime, stream, and wake path untested |
| 2026-11-08 / anonymous worker installation | S1 and GitHub npm documentation (S17): publish to GitHub Packages and attach the same pinned package as a public Release asset | Public npm packages still require GitHub authentication; install from public Release assets, verify a trusted digest, and keep GitHub credentials out of Muse | Registry authentication requirement rechecked; release/install path unimplemented |
| 2026-11-08 / worker connection authority | S1, with S3 as reference: single-use enrollment code exchanged for a separate revocable worker credential | A leaked master key or repair task could grant cross-worker access or restore revoked authority; use scoped identities, verified secure storage, and persistent revocation | Design requirement only; credential mechanism unselected and untested |
| 2026-11-08 / backend contract and state ownership | S1: broker owns observed canonical history; Muse proposes structured client tool calls | Muse might read its VM instead of the client's file or duplicate resubmitted history; validate tool linkage, use a client-only fixture, and define reconciliation before durable replay | No live tool loop or history/recovery test performed |

## Evidence register

The original handoff reports public inspection on November 8, 2026. Except for the sources explicitly marked **rechecked**, entries below preserve that dated report rather than claim independent verification in this session. Repository activity is not a maintenance or service guarantee. Revalidate revisions, licenses, terms, and live behavior before depending on them.

| ID | Source | Recorded evidence and limits |
| --- | --- | --- |
| S1 | User's investigation handoff, subsequent clarifications, and approved documentation plan, November 8, 2026 | Authority for project intent and the Go/TypeScript, combined-image, worker CLI, enrollment, and public Release distribution decisions; supersedes earlier unselected language/distribution choices |
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
