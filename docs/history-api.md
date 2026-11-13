# Native requests and canonical history

The [OpenAI Chat Completions subset](#openai-chat-completions) below adapts this canonical contract for general clients. Native endpoints retain their existing wire format.

This API exercises the broker's normalized text/tool contract. It is not an OpenAI adapter or a live Muse qualification receipt. The November 11, 2026 issue #8 and #9 approvals permit canonical history and capability-routing engineering with controlled software tests and live testing deferred; release qualification remains inconclusive.

## Broker restart recovery

The November 12, 2026 issue #10 approval permits controlled broker-recovery engineering and tests. It grants no live Muse trial or release qualification. Startup reconciles durable work in a PostgreSQL transaction before serving. A failed read or commit stops startup; no successful restoration is reported before commit. Schema version 5 is unchanged.

Recovery restores queued and claimed work, held assignments, pending client-tool waits, and incomplete context/output delivery records. It preserves canonical history, accepted decisions, call IDs, client/session ownership, pins, and assignment/connection generation counters. Settled history and submission receipts remain in PostgreSQL and are read on demand. Recovery selects no replacement worker; existing routing eligibility and pre-delivery rules continue after startup.

A process restart does not prove another broker or remote inference stopped. The existing 30-second health window and persisted lease/deadline remain authoritative. A matching decision can reconcile while its assignment is still current and unexpired. Expiry or cancellation fences future acceptance but retains the uncertain busy hold. Reconnection and ordinary heartbeats never release that hold. The worker's exact idle acknowledgement releases capacity while leaving the interrupted or cancelled request's remote outcome unknown. Never regenerate uncertain inference or re-execute an accepted client tool automatically.

An identical accepted decision, authenticated under its original principal and submission identity, replays its durable result even after lease expiry. Conflicting output under that identity returns `409 submission_conflict`. A claim receipt only replays while the original job, generations, connection, lease, health and deadline still authorize it; otherwise it returns the existing `409 stale_assignment` or `409 stale_connection`. An old claim receipt cannot renew authority. Revocation and owner/worker boundaries remain enforced.

`recovery.started` INFO begins the startup operation. Committed `recovery.restored` INFO records state, pin, call and delivery boundaries plus a summary of durable receipts/conversations. Protected `recovery.detail` DEBUG captures relevant context, outputs and assignment snapshots. `recovery.uncertain` WARN names the last unresolved boundary, held state and corrective action. `lease.fenced` WARN explains stale claim/result rejection with expected/observed generations; other authorization rejections retain `lease.rejected`. `receipt.replayed` INFO explains exact committed-submission replay. `recovery.failed` ERROR and protected `inference.storage_exchange` DEBUG identify storage causes and transaction outcomes. INFO stdout excludes private context; DEBUG remains credential-redacted and captured at the INFO runtime setting.

Collect `/api/v1/admin/diagnostics/export?request_id=<HTTP_REQUEST_ID>`, then `?operation_id=<NATIVE_REQUEST_ID>` or the startup operation ID from Docker logs. Collect each participating broker's retained diagnostic volume and decode through `decodeExport` in `tools/qualification-evidence.mjs`. Require complete metadata, no omissions, and valid reconstructable chunks/digests. Filter decoded records by owner, conversation, job, instance and connection generation to follow the operation across restart. A failed startup's protected captures remain available from its retained volume after successful restart. No business-table query or process attachment is needed to diagnose the failure.

For a busy hold, inspect the last boundary and await a current correlated decision or the exact idle acknowledgement after fencing; reconnection is not evidence that inference stopped. Incomplete-delivery warnings distinguish `context_delivery` from `output_delivery`, identify `delivery_completion_receipt_missing`, and state whether a durable decision exists. For unclaimed context-only delivery, verify worker health/readiness and retrieve the same queued job. For incomplete output delivery, retrieve the stored decision without regenerating it. For a failed reconciliation, repair the causal database problem and restart while preserving volumes and uncertainty. Missing/expired captures are explicitly incomplete, not a diagnosis. Retention stays seven days or 128 MiB, with chunks at most 6 KiB and admitted API bodies at most 1 MiB.

`make test-broker-recovery` runs the real service, HTTP/SSE transport and PostgreSQL with controlled peers. It covers healthy sibling startup, valid leases, queue and tool-wait restarts, abrupt crash, lost acknowledgement, stale claims/results, exact history and pins, incomplete delivery, failed-startup diagnosis, protected capture and ownership-verified cleanup. The same target runs in `CI / service`; these receipts prove software behavior only.

## Submit and continue

Authenticate with a configured `client-keys` bearer credential. Its YAML entry name identifies the owner; rotating the value under the same name retains ownership, while renaming the entry creates a different principal. Management, portal, and worker credentials cannot authorize native requests.

`POST /api/v1/requests` accepts this shape:

```json
{
  "protocol_version": 1,
  "submission_id": "caller-retry-identity",
  "messages": [{"type": "message", "role": "user", "text": "A question"}],
  "tools": [],
  "timeout_seconds": 300
}
```

Send `X-Muse-Session-Id` to continue an identified session. Session IDs are 1–100 ASCII letters, digits, underscores or hyphens; empty, repeated and malformed headers fail. The same string under different client owners identifies independent conversations. Without a session header or an owned `previous_response_id`, every new submission creates an independent session. The response returns the effective session in the same header.

Omit `worker_id` for automatic selection. An optional explicit worker is a selection constraint and must be eligible; it cannot bypass an existing healthy session pin.

Admission returns HTTP 202 with `id`, `conversation_id`, `session_id`, `worker_id`, `response_id`, `state`, and `created_at`. It contains no model output. An unassigned new session returns `worker_id: ""` and has no inference job until dispatch; a queued established session retains its known target worker. Queue deadlines start at admission, including capacity wait. Read and cancel work through the same native request endpoints before assignment. Poll `GET /api/v1/requests/{id}` for the state and accepted `output`. Each request completes with one `final` or `tool_call` decision. A tool proposal leaves the conversation awaiting that exact call's client result; the caller applies its permissions and executes the tool locally.

Submit the next complete history, including the observed assistant message or tool call and the matching `tool_result`, using a fresh submission ID. Message items have `type`, `role` (`system`, `developer`, `user`, or `assistant`), and exact `text`; tool calls have `type`, `call_id`, `name`, and object `arguments`; tool results have `type`, `call_id`, and exact string `output`. Tool definitions use `name`, optional `description`, and JSON Schema object `parameters`. A final decision becomes an assistant message in canonical history. Text, line endings, numeric argument values and call IDs are preserved.

An optional `previous_response_id` resolves an owned, completed decision to its session. If a session header is also present, both must agree. This reference does not enable delta input: native requests always supply full history. Historical calls retain their original tool definitions; later requests may change their current tool set. Worker IDs remain pinned across completed requests, and a different explicit worker produces a conflict. A healthy busy pin waits rather than moving to another idle worker. After confirmed offline status, automatic routing may move only a safe next turn following a final answer, with no unresolved tool outcome, before claim or context delivery. It fences the old queued assignment and replays full canonical history. Interrupted, uncertain and tool-wait reassignment remains outside this ticket and belongs to #21.

`POST /api/v1/requests/{id}/cancel` accepts `protocol_version` and `submission_id`, cancels unfinished work, and retains history. A supplied session must match before cancellation. Cancellation of claimed inference retains the worker's busy hold until its matching idle acknowledgement; it does not prove remote inference stopped. Completed requests cannot be cancelled.

## Replays and errors

Exact retries use the same submission ID and original correlation fields. Changing those inputs under the same ID returns 409. An identified request whose normalized input exactly matches an admitted request returns that existing request without appending history or creating work. Uncorrelated requests with different submission IDs stay independent.

Other shortened/conflicting prefixes, unmatched/reused tool calls or results, and simultaneous new turns in the same session fail explicitly. Native requests do not queue overlapping session turns. Foreign and unknown request/response identifiers both return 404. Invalid/unsupported input returns 400, context/body overflow returns 413, `queue_full` capacity exhaustion returns 429, `no_ready_worker` returns 503 when no permitted qualified online target exists, and storage unavailability returns 503. Online transport does not establish model readiness.

Bodies and complete delivered contexts remain bounded at 1 MiB. Reaching that bound fails instead of trimming history. Canonical history, request snapshots and events have no automatic expiry or deletion API; storage grows with accepted work and operators must plan database capacity. Diagnostic retention is separate.

## Management inspection

Management credentials authorize:

- `GET /api/v1/admin/conversations` and `GET /api/v1/admin/conversations/{id}`.
- `GET /api/v1/admin/requests` and `GET /api/v1/admin/requests/{id}`; the list optionally filters by `conversation_id`.
- `GET /api/v1/admin/conversations/{id}/timeline`.

Lists and timelines return `items` and optional `next_cursor`. Use `limit` (default 50, maximum 100) and the returned opaque `cursor`; list order uses immutable creation time and ID, while timelines use increasing sequence. Cursors are bound to their query and conversation filter. Unknown, repeated, malformed or unsupported query parameters fail. Timeline pages also stay below 2 MiB and provide a continuation cursor when that byte limit is reached.

Request detail includes immutable admitted input, response correlation, current assignment and its exact delivered context, observed output, and boundary timestamps. Canonical items have stable IDs and `client_provided` or `server_observed` provenance. Timelines retain instructions/messages, tool definitions, assignments, generations, decisions, client-tool linkage and errors.

Existing experiments remain available through their original API and appear as `legacy` management records. Their retained item/job snapshots are read-only, have `provenance: unavailable`, and use unknown event times where original evidence does not establish them. They are never assigned to a model client or silently imported into a client session.

## Diagnostics and recovery

The existing logger emits INFO operational boundaries and WARN/ERROR failures, with DEBUG exchanges always captured privately after credential redaction. Capture retention remains seven days or 128 MiB, with reconstructable records no larger than 6 KiB. Missing, expired or pruned captures are explicit.

Collect `/api/v1/admin/diagnostics/export?request_id=HTTP_REQUEST_ID` with a protected management header file. Decode it with `decodeExport` from `tools/qualification-evidence.mjs`; require complete metadata, chunk counts and digests. Read the request/operation ID from those events, then collect `?operation_id=NATIVE_REQUEST_ID`. Filter the reconstructed events by the owner, conversation, request, job and generation fields to follow asynchronous exchanges. No business-table query or process attachment is required for diagnosis.

| Evidence | Interpretation and corrective action |
| --- | --- |
| `history.reconciled` INFO | Matched/appended ranges, owner/session and replay reason identify exactly what was admitted. |
| `history.conflict` WARN plus protected input/exchange | Compare the identified mismatch or call linkage; resend the owned full history rather than guessing a prefix. |
| `history.owner_denied` WARN | Requested identity is absent or outside the authenticated owner; use the correct client credential without probing another owner's records. |
| `inference.storage_exchange` DEBUG and `inference.operation_failed` ERROR | Read SQLSTATE, causal detail, transaction outcome, attempt and duration; repair the write failure before retrying the same submission. |
| `job.deadline_exceeded` ERROR | The correlated last boundary and deadline show the stall; an unanswered job is not proof of its internal Muse cause. |
| `request.context_delivery_*` / `request.output_*` | Start markers precede writes; completion means the server wrote the complete response, not that the client received it. Interrupted writes or failed boundary persistence retain uncertainty. Never infer that an exposed tool call can safely be regenerated. |

Schema 5 preserves migrations 1–4 and their checksums, existing identities, history and delivery snapshots. It adds durable qualification/dispatch metadata and permits a native request or conversation to await its first worker. Existing workers start unqualified. An older binary rejects schema 5. Recover through a forward fix that retains the schema and history; do not drop tables or run a destructive downgrade.

`make test-history` runs the real service/PostgreSQL/SSE software scenarios with controlled worker decisions, including log-only diagnosis and cleanup. Those results do not qualify live Muse wake, reasoning, account-memory isolation, refresh recovery, or client compatibility.

## Qualification and dispatch

Management-only `POST /api/v1/admin/workers/{id}/qualifications` records idempotent commands. Approval uses:

```json
{
  "protocol_version": 1,
  "submission_id": "approval-retry-identity",
  "action": "approve",
  "evidence_kind": "controlled",
  "evidence_reference": "Exact protected trial receipt or observation reference",
  "readiness_experiment_id": "completed-management-readiness-experiment",
  "tool_experiment_id": "completed-management-client-tool-experiment"
}
```

The reference is nonempty and at most 1,024 UTF-8 bytes. `evidence_kind` is `controlled` or `live`; it describes the operator's evidence, not a broker-certified live PoC verdict. The broker checks accepted authenticated worker decisions, ownership, current connection generation, an exact challenge echo, and an optional complete client-tool call/result/final chain. Omit the tool experiment for text-only capability. Management attests independent unattended conditions and semantic correctness; the broker cannot independently observe those external facts. Heartbeats, aliases and worker self-report never establish inference readiness or vendor identity.

A withdrawal supplies `protocol_version`, `submission_id`, `action: "withdraw"` and `evidence_reference`. It stops new native dispatch/offers/claims while preserving qualification history, existing assignment snapshots, and any already-claimed outcome. It does not cancel remote inference or revoke the worker credential. Worker/client/portal credentials cannot approve or withdraw qualification. Management experiments retain explicit-worker access to establish evidence and still obey health, admission, lease and single-held-turn rules.

Worker management/status records separately expose connection status, work status, waiting client-tool count, `inference_readiness` (`unverified`, `verified`, `stale` or `withdrawn`), latest `qualification`, and `qualification_history`. `verified` means evidence was approved for this connection generation; inspect its provenance. Every reconnection invalidates previous readiness and requires new trials/approval. Historical evidence is retained.

Dispatch orders queued requests by creation time and stable ID, skips blocked pins, and selects available eligible workers by least recent dispatch with stable worker-ID ties. Text is always required; supplied tools or historical tool items also require `function_tools`. One worker holds at most one inference turn. `limits.max-jobs` bounds all nonterminal work globally and defaults to 1; raise it to permit multiple workers or queued requests. `timeout_seconds` defaults to 300 and accepts 1–3600 seconds. Same-session overlaps still return `409 session_busy`; callers continue after the current decision using full canonical history.

Use the existing protected export route first with `?request_id=HTTP_REQUEST_ID`, then with `?operation_id=NATIVE_REQUEST_ID`. Reconstruct through `decodeExport` from `tools/qualification-evidence.mjs`; require complete metadata and validated chunks/digests. Filter by owner, conversation, job and connection generation across broker exports. `dispatch.queued` and `dispatch.assigned` INFO include queue timing, candidates, selection reasons and qualification provenance. `dispatch.rejected` WARN distinguishes eligibility from capacity; record fresh matching verification for readiness/capability failures, or reduce admitted work/raise the documented bound for capacity failures. `dispatch.pin_conflict` WARN identifies conflicting selections; use the owned session and its pinned worker. `dispatch.reassigned` INFO records the old/new identities and safe pre-claim/pre-context boundary. Existing deadline/outcome and causal storage events identify stalls and rollback. No business-table query or process attachment is needed for diagnosis.

`make test-routing` exercises competing real HTTP/PostgreSQL/SSE software paths through two broker processes, qualification provenance, queue limits, owner/session isolation, pinning and safe/unsafe offline boundaries, with protected diagnostic reconstruction and resource-cleanup receipts. Controlled peers never qualify live Muse behavior. No live probe scheduler or PoC/release configuration selector is provided.

## OpenAI Chat Completions

The November 12, 2026 issue #13 engineering approval permits this adapter and controlled software validation. Live Muse qualification remains inconclusive. The implementation follows the [official Chat Completions contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and the OpenAI JS SDK 7.53.0 types inspected on November 12, 2026; it supports the subset below.

### Connection and ownership

Configure the client with base URL `https://YOUR_PUBLIC_ORIGIN/v1`, bearer authentication using a distinct named `client-keys` entry, and model `muse-pool-text`. Environment references in YAML must exist inside the service container; arbitrary variables from the operator's `.env` are not automatically forwarded by Compose. Management keys, portal passwords and worker credentials cannot authenticate these endpoints.

`GET /v1/models` returns that one alias, owned by `aaa-muse-ai`. Listing the alias makes no inference-readiness claim and does not identify another vendor's model. `POST /v1/chat/completions` waits for one canonical broker decision. Responses include `X-Request-Id` and, after admission, `X-Muse-Session-Id`.

Supply a stable `X-Muse-Session-Id` and resend full history, including returned assistant messages and exact client-tool results, for continuation. The broker owns observed history, retains it without automatic deletion, rejects conflicting prefixes, serializes turns and preserves healthy worker pins. The same session string belongs to different conversations under different named client keys. Without correlation, each HTTP submission is independent; similar text does not establish identity. Exact full-history replays within an identified session return the previously accepted decision and completion ID. No additional client idempotency header is supported.

CLIProxyAPI and cc-switch are prospective gateway consumers. A gateway must preserve the stable session header for cross-request affinity. Neither gateway nor Codex/Claude Code is certified by these controlled protocol tests. A separate forwarding SDK is not required.

### Supported request subset

| Input | Support |
|---|---|
| `model`, `messages` | Required; exact model alias and nonempty text history |
| Message roles | `system`, `developer`, `user`, `assistant`, `tool`; strings or nonempty arrays of `{type:"text",text:STRING}` content, joined in order |
| `tools` | Optional function definitions with name, optional description, object `parameters` schema, and optional `strict:false`; multiple definitions are allowed |
| Assistant `tool_calls` | One function call per assistant message, with ID, function name, and a JSON-object arguments string; assistant text accompanying a call is preserved |
| Tool results | `role:"tool"`, exact `tool_call_id`, text content; the client enforces permission and executes the tool locally |
| Default controls | `stream:false` or `true`, `n:1`, `parallel_tool_calls:false`, `tool_choice:"auto"`; `"none"` is accepted only with no tools |

Assistant call content may be absent, null or empty. Plain assistant messages require text. Returned `refusal:null` may be replayed; non-null refusals are unsupported. Function names, identifiers, object schemas, local references and argument validation follow the native contract. External schema resources are forbidden. Previously accepted calls retain their linkage even when the current tool-definition snapshot changes.

Unknown fields, participant names, media, custom/hosted tools, legacy function fields, strict generation, forced/required tool choice, parallel calls, multiple choices, generation parameters, storage parameters and streaming usage options are rejected. Fields are never silently discarded. HTTP bodies and normalized canonical context each have a 1-MiB limit. The client decides its own tool permissions; neither the broker nor Muse executes proposed client tools.

### JSON, buffered SSE and failures

Non-streaming completions use `object:"chat.completion"`, one choice at index zero, an assistant message and finish reason `stop` or `tool_calls`. Function arguments remain a JSON string. Unknown usage is omitted; token counts are not estimated.

With `stream:true`, the service buffers until the broker accepts a decision, then emits `data:` frames containing `chat.completion.chunk` objects: assistant role, content or indexed function-call delta, an empty delta with the finish reason, and `data: [DONE]`. IDs, creation time and model stay constant across frames. This is buffered protocol streaming; it exposes no incremental Muse tokens or private reasoning. No model-output frame is sent while waiting.

The native turn budget is 300 seconds. Chat adjusts its response deadline independently of other routes' 30-second default and applies a five-second deadline to response writes. Set client and reverse-proxy waiting timeouts above 305 seconds plus network margin. There is no Chat body parameter to extend the turn deadline.

Before response headers, errors use `{error:{message,type,param,code}}`: `400` invalid/unsupported input, `401` incorrect credential authority, `404` unknown model, `409` history/linkage/session conflict, `429` queue capacity, `503` unavailable or interrupted work, and `504` native deadline. Wrong methods return `405`, oversized bodies `413`. Errors identify the applicable parameter where available. An interrupted write after headers closes the response; it does not emit a successful finish or `[DONE]`.

Cancellation attempts the existing owned cancellation under a bounded cleanup context. An already accepted decision remains accepted. Claimed work retains an uncertain busy hold until its exact idle acknowledgement. Existing eligible session continuations may reroute only before claim and context delivery, using full history. This adapter adds no retry of claimed inference or accepted tool effects. A server-write completion receipt is not proof that the client received the response.

### Verification and diagnosis

`make test-chat` runs real HTTP/PostgreSQL/broker paths with authenticated controlled peers, the pinned OpenAI JS SDK and raw SSE assertions. It includes client-only fixture tools, owner/session isolation, strict errors, delayed output, cancellation, deadlines, recovery boundaries and protected log reconstruction. Deadline tests advance only disposable fixture records; there is no production test-mode flag. Unit checks separately exercise failed writes/flushes against real handler/broker logic and protected captures.

The reusable `tools/openai-conformance.mjs` accepts `--base-url`, `--fixture`, and `--receipt`; its model-client key comes only from `MUSE_CHAT_CLIENT_KEY`. It runs text/tool cycles in JSON and SSE through both SDK and raw HTTP. It executes only `read_file` for the exact permitted local fixture, checks the exact returned result, and fails on malformed streams, wrong outputs or missing required cases. Run it against an explicitly authorized backend; `make test-chat` supplies an isolated controlled backend automatically. Its receipt never qualifies live Muse.

At the normal INFO level, `chat.request_admitted` records effective waiting/write settings and correlation. `chat.request_rejected` WARN records unsupported parameter/schema paths; `chat.history_conflict` WARN records linkage failures. `chat.stream_terminated` or `chat.request_terminated` records the last event, cause, last observed job disposition, output acceptance, byte counts, timing and outcome. Completion and context cancellation are INFO; required-operation failures and uncertain delivery are ERROR. Existing dispatch, deadline and storage events supply assignment generations, busy holds and causal dependency evidence.

DEBUG records retain admitted Chat input, normalized input, accepted decisions and actual attempted encoded frames privately after redaction. INFO stdout excludes these payloads. Capture remains bounded to seven days or 128 MiB, with records no larger than 6 KiB and explicit omissions.

Collect `/api/v1/admin/diagnostics/export?request_id=HTTP_REQUEST_ID` with a protected management header file, reconstruct using `decodeExport` from `tools/qualification-evidence.mjs`, and require complete metadata and valid chunks/digests. Then export each linked `operation_id`, filtering by client, session, conversation, worker/job and generation across broker instances. Unsupported input requires correcting the named parameter; conflicts require restoring exact owned history/tool linkage; uncertain inference requires retaining its hold; a failed storage boundary requires repairing its recorded cause and reading/replaying the accepted output. No business-table query or process attachment is needed for diagnosis.

`CI / openai` retains only safe source/image identity, case, SDK and cleanup summaries for seven days. Private fixture directories and model payloads are not uploaded. These integration receipts do not contribute to unit statement coverage.

## OpenAI Responses

Use the same `/v1` base URL, named model-client Bearer key and `muse-pool-text` alias as Chat. `POST /v1/responses` implements a text/function subset using Responses items and events. The [official function-calling guide](https://developers.openai.com/api/docs/guides/function-calling), [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses), and installed OpenAI JS SDK 7.53.0 are the protocol references inspected on November 13, 2026. This subset does not certify Codex, Claude Code, CLIProxyAPI or cc-switch.

### Inputs and owned continuation

| Field | Supported behavior |
|---|---|
| `model`, `input` | Exact alias required; input is a string or nonempty item array |
| Message items | `type:"message"` or easy messages, roles `system`, `developer`, `user`, `assistant`; string content or ordered `input_text` parts; assistant replay also accepts `output_text` with empty annotations |
| Function items | `function_call` with exact `call_id`, name and JSON-object arguments string; `function_call_output` with the exact call ID and string output |
| `instructions`, `tools` | Request-scoped instructions, optional flattened function definitions (`type`, `name`, optional description, object parameters, optional `strict:false`); omitted tools mean no active definitions |
| Controls | `stream:false` or `true`, `parallel_tool_calls:false`, `tool_choice:"auto"`; `"none"` only when tools are empty; optional owned `previous_response_id` |

Top-level instructions are stored separately from canonical message items. Only the current request's instructions are prepended to its full worker context. Omitted/null instructions activate none from earlier requests; an explicit empty string remains empty. Explicit system/developer messages in input remain canonical history. Old requests keep their instruction and tool snapshots unchanged. Effective context, including active instructions and tools, must fit 1 MiB; HTTP bodies have the same bound. History is never trimmed to fit.

Without a previous response reference, use `X-Muse-Session-Id` and resend the complete canonical item history with new input. Without either stable reference, each request is independent. For chaining, send an owned `previous_response_id` and new items, usually a function-call output or user message. The broker expands this into full canonical history before delivery; it does not introduce delta delivery to Muse. The service returns `X-Muse-Session-Id` and `X-Request-Id`. When the session header is also supplied it must agree with the response reference.

New turns require the latest completed response of that owned session. There is no branching. Exact repeated requests are reconciled before stale-reference rejection and return their existing response and item IDs; changing JSON versus SSE does not create a new turn. Replayed server output IDs must belong to the canonical conversation and match their accepted contents. Unknown and foreign response references have the same `404` outcome. Conflicting session, stale new continuation, changed item or call/result linkage produces `409`. Concurrent turns serialize through the existing PostgreSQL transaction.

Clients execute their own tools under their own permissions. The broker returns one proposed function call per decision and retains its `call_id` exactly. Accepted results are not re-executed during replacement or replay. Previously accepted calls keep their linkage when current tool definitions change.

Unsupported fields and items are rejected explicitly, including reasoning items, media, custom/hosted tools, forced/required tool choices, parallel execution, strict-generation promises, sampling settings, and storage/state options such as `store`, `background` and `conversation`. Omission of a storage option does not disable the broker's durable history: its existing retention contract still applies. Completed output messages/function calls may be replayed with their IDs and `status:"completed"`; incomplete items and nonempty annotations are unsupported.

### JSON, lifecycle events and delivery failures

JSON output has `object:"response"`, the durable `resp_` ID, creation time, model alias, completed status and one output item. Text uses an assistant message containing `output_text`; a proposed function call uses separate item and call IDs with arguments encoded as a JSON string. Usage is `null` because the backend does not report measured token usage.

SSE is buffered until the broker observes a terminal outcome. No lifecycle or model-output event is emitted while waiting. Each frame has matching `event:` and JSON `type`, with consecutive `sequence_number` values starting at zero:

1. `response.created`, then `response.in_progress`.
2. `response.output_item.added` with an in-progress item.
3. For text: content-part added, output-text delta/done, content-part done. For a function: function-call-arguments delta/done.
4. `response.output_item.done`, then `response.completed` carrying the complete response.

An admitted terminal backend failure emits created/in-progress followed by `response.failed` with its causal error and no fabricated output. Pre-admission errors and failures before a safe lifecycle exposure boundary use OpenAI-shaped HTTP errors. Responses has no Chat `[DONE]` sentinel. A write interruption closes the stream without claiming successful completion or appending a JSON fallback. The logs record the last attempted and fully written sequence; a server write receipt does not prove client receipt.

The 300-second native turn budget and five-second write bounds apply. Configure client/reverse-proxy waiting timeouts above 305 seconds plus margin. Client cancellation attempts owned cancellation while retaining already accepted decisions and uncertain remote busy holds.

Healthy session pins persist through answers and tool waits. Existing eligible continuations may move from an offline worker only before claim and context delivery, after a completed final answer and without an unresolved tool outcome. Replacement receives full history with accepted call/result IDs. Claimed inference is not retried. An emitted stream is never automatically restarted; an explicit exact client retry may replay its accepted decision.

Responses metadata is additive in existing request JSON. Existing records without it retain native behavior; no SQL migration or worker protocol change is required. A route rollback must retain the metadata reader/context projector and canonical records. An older writer is not certified to preserve newly introduced metadata; do not erase records or run a destructive downgrade.

### Verification and log-only diagnosis

`make test-responses` reuses the broker/PostgreSQL/SSE harness and `tools/openai-conformance.mjs --protocol responses`. The existing Chat invocation remains unchanged. The runner still takes `--base-url`, `--fixture`, and `--receipt`, and obtains its model-client credential only from `MUSE_CHAT_CLIENT_KEY`. SDK/raw HTTP and JSON/SSE cases execute only the exact permitted local `read_file` fixture and check its exact result, full replay, chained continuation, and retry identity.

The controlled integration target covers reference ownership, serialization, instruction replacement/omission, restart persistence, healthy pinning, eligible replacement, tool conflicts, deadlines, cancellation, claimed-worker failure, storage boundaries and interrupted delivery. These are software checks, not live inference qualification. Unit tests exercise actual normalizers, services, encoders, handlers and stream consumers separately from integration coverage.

At the normal INFO runtime setting, `responses.request_admitted` identifies effective wait/write settings and operation correlation. Admission emits `responses.reference_rejected` WARN for reference/ownership failures and `responses.item_conflict` WARN for history/linkage conflicts. Protected `history.conflict_detail` retains the corresponding expected/observed items. `responses.request_rejected` WARN identifies unsupported fields and schema paths. `responses.stream_terminated` or `responses.request_terminated` records state, cause, output acceptance, last attempted/completed sequence, bytes, timing, attempt and final disposition. Completion and cancellation use INFO; failed required operations and uncertain delivery use ERROR. Existing job/dispatch/storage records provide generations, fences, busy holds, decisions and causal dependency evidence.

DEBUG captures admitted and normalized input, active instruction/tool metadata, accepted decisions, delivered worker context and each attempted encoded frame privately after credential redaction. INFO stdout excludes these payloads. Existing 6-KiB reconstructable chunks, seven-day/128-MiB retention and explicit omission reporting apply.

Collect each participating broker's `/api/v1/admin/diagnostics/export?request_id=HTTP_REQUEST_ID` using the protected management header file. Decode using `decodeExport` from `tools/qualification-evidence.mjs`; require complete metadata and valid chunks/digests. Export linked `operation_id` values and filter by authenticated owner, conversation/session, worker/job, generation and revision. Reference failures require the latest owned ID and agreeing session; item conflicts require restoring exact accepted history/results. Retain uncertain holds after claimed loss, and repair the recorded storage cause before replaying accepted output. This procedure needs no business-table query or runtime attachment.

`CI / openai` runs both protocol matrices on the exact source head. It retains `.artifacts/ci/openai/receipt.json` for Chat and `responses-receipt.json` for Responses, containing only safe source/image identity, SDK/case results, diagnostic conclusions and resource-cleanup proof for seven days. Private fixtures, raw captures and credentials are not uploaded, and integration receipts never contribute to unit coverage.
