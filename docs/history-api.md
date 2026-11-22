# Native requests and canonical history

The [OpenAI Chat Completions subset](#openai-chat-completions) below adapts this canonical contract for general clients. Native endpoints retain their existing wire format.

This API exercises the broker's normalized text/tool contract. It is not an OpenAI adapter or a live Muse qualification receipt. The November 11, 2026 issue #8 and #9 approvals permit canonical history and capability-routing engineering with controlled software tests and live testing deferred; release qualification remains inconclusive.

## Broker restart recovery

The November 12, 2026 issue #10 approval permits controlled broker-recovery engineering and tests. It grants no live Muse trial or release qualification. Startup reconciles durable work in a SQLite write transaction before serving. A failed read or commit stops startup. Restoration is logged after commit.

Recovery restores queued and claimed work, held assignments, pending client-tool waits, and incomplete context/output delivery records. It preserves canonical history, accepted decisions, call IDs, client/session ownership, pins, and assignment/connection generation counters. Settled history and submission receipts remain in SQLite and are read on demand. Recovery selects no replacement worker; existing routing eligibility and pre-delivery rules continue after startup.

A process restart does not prove another broker or remote inference stopped. The stored claim and submission-based deadline remain authoritative, independent of contact age. A matching decision can reconcile while its claim is current and unexpired. Expiry or cancellation fences future acceptance without releasing the hold. Only settled work with a broker receipt releases the slot. Never regenerate uncertain inference or re-execute an accepted client tool automatically.

An identical accepted decision, authenticated under its original principal and submission identity, replays its durable result even after expiry. Conflicting output under that identity returns `409 submission_conflict`. An exact pull retry returns its saved grant or empty result. A saved grant cannot authorize work by itself: the start handler verifies the current claim, revocation, cancellation and deadline. Revocation and owner/worker boundaries remain enforced.

`recovery.started` INFO begins the startup operation. Committed `recovery.restored` INFO records state, pin, call and delivery boundaries plus a summary of durable receipts/conversations. Protected `recovery.detail` DEBUG captures relevant context, outputs and assignment snapshots. `recovery.uncertain` WARN names the last unresolved boundary, held state and corrective action. `lease.fenced` WARN explains stale claim/result rejection with expected/observed generations; other authorization rejections retain `lease.rejected`. `receipt.replayed` INFO explains exact committed-submission replay. `recovery.failed` ERROR and protected `inference.storage_exchange` DEBUG identify storage causes and transaction outcomes. INFO stdout excludes private context; DEBUG remains credential-redacted and captured at the INFO runtime setting.

Collect `/api/v1/admin/diagnostics/export?request_id=<HTTP_REQUEST_ID>`, then `?operation_id=<NATIVE_REQUEST_ID>` or the startup operation ID from Docker logs. Collect each participating broker's retained diagnostic volume and decode through `decodeExport` in `tools/qualification-evidence.mjs`. Require complete metadata, no omissions, and valid reconstructable chunks/digests. Filter decoded records by owner, conversation, job, instance and connection generation to follow the operation across restart. A failed startup's protected captures remain available from its retained volume after successful restart. No business-table query or process attachment is needed to diagnose the failure.

For a busy hold, inspect the last boundary and await a current correlated decision or the exact idle acknowledgement after fencing; reconnection is not evidence that inference stopped. Incomplete-delivery warnings distinguish `context_delivery` from `output_delivery`, identify `delivery_completion_receipt_missing`, and state whether a durable decision exists. For unclaimed context-only delivery, verify worker health/readiness and retrieve the same queued job. For incomplete output delivery, retrieve the stored decision without regenerating it. For a failed reconciliation, repair the causal database problem and restart while preserving volumes and uncertainty. Missing/expired captures are explicitly incomplete, not a diagnosis. Retention stays seven days or 128 MiB, with chunks at most 6 KiB and admitted API bodies at most 1 MiB.

`make test-broker-recovery` runs the real service, HTTP/SSE transport and SQLite with controlled peers. It covers healthy sibling startup, valid leases, queue and tool-wait restarts, abrupt crash, lost acknowledgement, stale claims/results, exact history and pins, incomplete delivery, failed-startup diagnosis, protected capture and ownership-verified cleanup. The same target runs in `CI / service`; these receipts prove software behavior only.

### Controlled idle footprint comparison

1. Use the verified `v0.2.1-rc.0` image whose paired receipt identifies PostgreSQL base `46e9ac8373980eba1c344a100b35e85e4a3e9a63`. Obtain both its Compose manifest and example YAML with `git show` at that commit. Use the current repository's Compose manifest and YAML with the SQLite image built from the source under test. Record each source SHA and immutable image ID. [PostgreSQL release receipt](https://github.com/markhuangai/AaA-muse-ai/releases/download/v0.2.1-rc.0/product-release.json)
2. On one Docker host, place the manifests and protected configuration in two disposable directories with unique Compose project names and fresh storage. Follow the storage setup for the source being measured. Use fixture credentials and a local port distinct from existing installations. Run `docker compose config --services` and `docker compose up -d` for each project. Measure the stacks sequentially. Require HTTP 200 and `ready: true` from `GET /readyz`, then leave that stack idle for ten seconds. [SQLite Compose storage](deployment.md#fresh-install)
3. Use `docker compose ps --quiet` to enumerate just that stack's running application containers. Take three `docker stats --no-stream --format '{{.MemUsage}}' <container-ids>` snapshots. Sum container memory for each snapshot and record the samples, median, container count, Docker server version and platform. A credential-free receipt also records source/image identities and the observed schema version. Verify ownership and remove only the disposable projects' containers, volumes, networks and host directories.

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

Other shortened/conflicting prefixes, unmatched/reused tool calls or results, and simultaneous new turns in the same session fail explicitly. Native requests do not queue overlapping session turns. Foreign and unknown request/response identifiers both return 404. Invalid/unsupported input returns 400, context/body overflow returns 413, `no_ready_worker` returns 503 when no permitted online target exists, and storage unavailability returns 503. Online transport does not establish model readiness.

Bodies and complete delivered contexts remain bounded at 1 MiB. Reaching that bound fails instead of trimming history. Canonical history, request snapshots and events have no automatic expiry or deletion API; storage grows with accepted work and operators must plan database capacity. Diagnostic retention is separate.

## Management inspection

Management credentials authorize:

- `GET /api/v1/admin/conversations` and `GET /api/v1/admin/conversations/{id}`.
- `GET /api/v1/admin/requests` and `GET /api/v1/admin/requests/{id}`; the list optionally filters by `conversation_id`.
- `GET /api/v1/admin/conversations/{id}/timeline`.

Lists and timelines return `items` and optional `next_cursor`. Use `limit` (default 50, maximum 100) and the returned opaque `cursor`; list order uses immutable creation time and ID, while timelines use increasing sequence. Cursors are bound to their query and conversation filter. Unknown, repeated, malformed or unsupported query parameters fail. Timeline pages also stay below 2 MiB and provide a continuation cursor when that byte limit is reached.

Request detail includes immutable admitted input, response correlation, current assignment and its exact delivered context, observed output, and boundary timestamps. Canonical items have stable IDs and `client_provided` or `server_observed` provenance. Timelines retain instructions/messages, tool definitions, assignments, generations, decisions, client-tool linkage and errors.

Request detail retains `kind`, `request`, `assignment`, `delivery` and legacy history/provenance, and adds `execution`: `id`, `worker_id`, `state`, `reason`, `remote_outcome`, `created_at`, `deadline_at` and `current_job_id`. Execution reflects the durable experiment state, including an unassigned request with no current job. Assignment and delivery remain recorded snapshots, not proof of remote consumption. Current display names are resolved separately by immutable worker ID.

Portal sessions can read these management projections through [Requests](portal.md#request-history-and-cancellation). The portal uses fifty-row/event pages, the existing conversation filter and exact request lookup. `POST /api/v1/admin/experiments/{id}/cancel` accepts `protocol_version: 1` and a fresh `submission_id` for assigned or unassigned work. It retains accepted receipts, tool linkage and uncertain busy holds; completed work is rejected. No new cancellation endpoint or replay authority is introduced.

Media submissions appear as `kind: "media"` in requests and conversations. The projection uses the current job and includes its recorded `owner`, `profile` and `started_at` when available. The `media_job_snapshot` timeline entry retains the job and context with `time: null`. Native text requests, including MCP `ask_muse`, continue to use the native projection. [Media jobs](media-api.md)

Other retained experiments appear as `legacy` management records and remain available through their original API. Their item and job snapshots have `provenance: unavailable` and retain unknown event times.

Admitted text may contain NUL. Management lists, request/conversation detail and timelines retain that content, distinguish it from a literal `\\u0000`, and preserve numeric JSON values. Indexed scalar columns carry lookup and recovery metadata. Go composes projections from the original JSON without evaluating payloads as SQLite expressions.

## Diagnostics and recovery

The existing logger emits INFO operational boundaries and WARN/ERROR failures, with DEBUG exchanges always captured privately after credential redaction. Capture retention remains seven days or 128 MiB, with reconstructable records no larger than 6 KiB. Missing, expired or pruned captures are explicit.

Collect `/api/v1/admin/diagnostics/export?request_id=HTTP_REQUEST_ID` with a protected management header file. Decode it with `decodeExport` from `tools/qualification-evidence.mjs`; require complete metadata, chunk counts and digests. Read the request/operation ID from those events, then collect `?operation_id=NATIVE_REQUEST_ID`. Filter the reconstructed events by the owner, conversation, request, job and generation fields to follow asynchronous exchanges. No business-table query or process attachment is required for diagnosis.

| Evidence | Interpretation and corrective action |
| --- | --- |
| `history.reconciled` INFO | Matched/appended ranges, owner/session and replay reason identify exactly what was admitted. |
| `history.conflict` WARN plus protected input/exchange | Compare the identified mismatch or call linkage; resend the owned full history rather than guessing a prefix. |
| `history.owner_denied` WARN | Requested identity is absent or outside the authenticated owner; use the correct client credential without probing another owner's records. |
| `history.query_completed` INFO plus `history.query_exchange` / `request.exchange` DEBUG | Reconstruct the exact query and original NUL-containing output, including tool linkage and literal escapes, from the protected export. |
| `history.operation_failed` ERROR plus `history.storage_exchange` DEBUG | `history_projection_invalid` identifies malformed native event metadata; causal detail identifies its field. SQLite failures retain the extended SQLite result code and phase when available. Inspect revision, query, duration, attempt and transaction outcome; correct the projection or restore the dependency, then retry reading while preserving original records. |
| `inference.storage_exchange` DEBUG and `inference.operation_failed` ERROR | Read the SQLite result code, phase, causal detail, transaction outcome, attempt and duration. Repair the write failure before retrying the same submission. |
| `job.deadline_exceeded` ERROR | The correlated last boundary and deadline show the stall; an unanswered job is not proof of its internal Muse cause. |
| `request.context_delivery_*` / `request.output_*` | Start markers precede writes; completion means the server wrote the complete response, not that the client received it. Interrupted writes or failed boundary persistence retain uncertainty. Never infer that an exposed tool call can safely be regenerated. |

The SQLite schema starts at version 1 with a checksummed ledger. It supports pending requests or conversations without an assigned worker. Foreign keys and partial unique indexes enforce relationships, one held inference turn per worker, and one pending turn per experiment. SQLite WAL permits snapshots during writes on the same host. State transitions use a short immediate transaction with full synchronization and a two-second busy timeout.

`make test-history` runs the real service/SQLite/SSE software scenarios with controlled worker decisions, including log-only diagnosis and cleanup. Those results do not qualify live Muse wake, reasoning, account-memory isolation, refresh recovery, or client compatibility.

## Worker dispatch

Valid text and tool requests queue even when no worker is idle. An enrolled worker with a free slot makes an authenticated `POST /api/v1/worker/pull`. An eligible targeted or pinned job takes priority over open jobs; each group uses creation time and a stable ID. Media also requires the advertised format support. An unstarted queued job occupies no slot. A held claim, including an accepted result awaiting native settlement, does.

The retired management `POST /api/v1/admin/workers/{id}/qualifications` returns `410 qualification_retired` after authorization. The v1 status fields `inference_readiness`, `qualification`, and `qualification_history` describe recorded historical evidence. Archived withdrawals describe past decisions. Revocation blocks access for all copies of a worker credential. Management may still run explicit-worker experiments to observe actual wake and model behavior.

Workers retain their enrolled identity and protected state across broker and helper restarts. Busy or unobservable workers do not acquire new claims. Keep a session pinned except at the bounded, offline pre-delivery boundary after a completed final turn and with no explicit target or unresolved client tool call. Same-session overlaps still return `409 session_busy`.

Use the protected export route with `?request_id=HTTP_REQUEST_ID`, then `?operation_id=NATIVE_REQUEST_ID`. Reconstruct each export with `decodeExport` from `tools/qualification-evidence.mjs` and verify completeness and chunk digests. Join `dispatch.queued`, `job.claimed`, `job.work_started`, and `job.work_settled` by job and claim ID. Use the persisted poll sequence and occurrence to distinguish a retry from new work; `worker.pull_timing` separates transaction acquisition from queue lookup. [Worker diagnostics](../worker/README.md#recovery-and-diagnosis)

`make test-routing` exercises competing HTTP, SQLite and SSE paths through two broker processes, queue limits, owner and session isolation, pinning, and offline boundaries with controlled peers.

## OpenAI Chat Completions

The November 12, 2026 issue #13 engineering approval permits this adapter and controlled software validation. Live Muse qualification remains inconclusive. The implementation follows the [official Chat Completions contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and the OpenAI JS SDK 7.53.0 types inspected on November 12, 2026; it supports the subset below.

### Connection and ownership

Configure the client with base URL `https://YOUR_PUBLIC_ORIGIN/v1`, bearer authentication using a distinct named `client-keys` entry, and model `muse-ai`. Environment references in YAML must exist inside the service container. Compose forwards the variables declared in its service environment. Use the resolved model-client key.

`GET /v1/models` lists `muse-ai`, owned by `aaa-muse-ai`. Chat Completions and Responses also accept `muse-pool-text` for existing clients and echo the requested alias. The alias identifies the broker route. `POST /v1/chat/completions` waits for one canonical broker decision. Responses include `X-Request-Id` and, after admission, `X-Muse-Session-Id`.

`X-Muse-Session-Id` is optional. To keep the same broker session, send a stable value per conversation and resend full history, including returned assistant messages and exact client-tool results. The broker reconciles exact retries, rejects conflicting prefixes, serializes turns and preserves healthy worker pins. A request without a session header starts a new Chat session. The same session string under different named client keys identifies separate conversations.

### CLIProxyAPI

Add the following provider to your CLIProxyAPI v8 configuration. Put the broker’s model-client key in the provider. Use your CPA client key when calling CPA. [CPA v8 configuration](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.77/config.example.yaml)

```yaml
api-keys:
  openai-compatibility:
    - name: aaa-muse-ai
      base-url: https://YOUR_PUBLIC_ORIGIN/v1
      request-retry: 0
      keys:
        - api-key: "<broker model-client key>"
      models:
        - name: muse-ai
          alias: muse-ai
```

Use a normal Chat request to check JSON through CPA with `stream:false` or buffered SSE with `stream:true`. `CPA_CLIENT_KEY` is an existing CPA client key. Change the origin and port to match your CPA listener.

```sh
curl --fail-with-body --no-buffer --max-time 330 \
  -H "Authorization: Bearer $CPA_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"muse-ai","messages":[{"role":"user","content":"Say hello."}],"stream":true}' \
  http://127.0.0.1:8317/v1/chat/completions
```

CPA’s built-in Test sends a generation limit, which the broker rejects. The Chat request above uses the supported subset. For optional worker affinity across CPA requests, forward the caller’s session header. A fixed header would put every request using the same broker key into one session. [CPA Test request](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/706c7c6f3308c1b0cceb880eec092be911bf8a80/src/features/providers/sheets/forms/useConnectivityTest.ts#L261-L275)

### Supported request subset

| Input | Support |
|---|---|
| `stream_options` | Optional on streaming Chat requests. Accepts an object with boolean `include_usage`. Null options act like omission. |
| `model`, `messages` | Required; exact model alias and nonempty text history |
| Message roles | `system`, `developer`, `user`, `assistant`, `tool`; strings or nonempty arrays of `{type:"text",text:STRING}` content, joined in order |
| `tools` | Optional function definitions with name, optional description, object `parameters` schema, and optional `strict:false`; multiple definitions are allowed |
| Assistant `tool_calls` | One function call per assistant message, with ID, function name, and a JSON-object arguments string; assistant text accompanying a call is preserved |
| Tool results | `role:"tool"`, exact `tool_call_id`, text content; the client enforces permission and executes the tool locally |
| Default controls | `stream:false` or `true`, `n:1`, `parallel_tool_calls:false`, `tool_choice:"auto"`; `"none"` is accepted only with no tools |

Assistant call content may be absent, null or empty. Plain assistant messages require text. Returned `refusal:null` may be replayed; non-null refusals are unsupported. Function names, identifiers, object schemas, local references and argument validation follow the native contract. External schema resources are forbidden. Previously accepted calls retain their linkage even when the current tool-definition snapshot changes.

`max_tokens`, `max_completion_tokens`, and `temperature` return `400 unsupported_parameter` with the field name. Other unsupported generation options, storage settings, media, hosted tools, participant names, strict generation, forced tool choice, parallel calls, and multiple choices are also rejected. HTTP bodies and normalized canonical context each have a 1-MiB limit. The client executes proposed tools under its own permissions.

### JSON, buffered SSE and failures

Non-streaming completions use `object:"chat.completion"`, one choice at index zero, an assistant message and finish reason `stop` or `tool_calls`. Function arguments remain a JSON string. Unknown usage is omitted; token counts are not estimated.

With `stream:true`, the service buffers until the broker accepts a decision. It emits the assistant role, content or indexed function-call delta, an empty delta with the finish reason, and `data: [DONE]`. IDs, creation time and model stay constant across frames. When `stream_options.include_usage` is true, each JSON chunk has `usage: null`. Muse supplies no measured token totals, so there is no usage summary chunk.

The native turn budget is 300 seconds. Chat adjusts its response deadline independently of other routes' 30-second default and applies a five-second deadline to response writes. Set client and reverse-proxy waiting timeouts above 305 seconds plus network margin. There is no Chat body parameter to extend the turn deadline.

Before response headers, errors use `{error:{message,type,param,code}}`: `400` invalid/unsupported input, `401` incorrect credential authority, `404` unknown model, `409` history/linkage/session conflict, `429` queue capacity, `503` unavailable or interrupted work, and `504` native deadline. Wrong methods return `405`, oversized bodies `413`. Errors identify the applicable parameter where available. An interrupted write after headers closes the response; it does not emit a successful finish or `[DONE]`.

Cancellation attempts the existing owned cancellation under a bounded cleanup context. An already accepted decision remains accepted. Claimed work retains an uncertain busy hold until its exact idle acknowledgement. Existing eligible session continuations may reroute only before claim and context delivery, using full history. This adapter adds no retry of claimed inference or accepted tool effects. A server-write completion receipt is not proof that the client received the response.

### Verification and diagnosis

`make test-chat` runs real HTTP/SQLite/broker paths with authenticated controlled peers, the pinned OpenAI JS SDK and raw SSE assertions. It includes client-only fixture tools, owner/session isolation, strict errors, delayed output, cancellation, deadlines, recovery boundaries and protected log reconstruction. Deadline tests advance only disposable fixture records; there is no production test-mode flag. Unit checks separately exercise failed writes/flushes against real handler/broker logic and protected captures.

The reusable `tools/openai-conformance.mjs` accepts `--base-url`, `--fixture`, and `--receipt`; its model-client key comes only from `MUSE_CHAT_CLIENT_KEY`. It runs text/tool cycles in JSON and SSE through both SDK and raw HTTP. It executes only `read_file` for the exact permitted local fixture, checks the exact returned result, and fails on malformed streams, wrong outputs or missing required cases. Run it against an explicitly authorized backend; `make test-chat` supplies an isolated controlled backend automatically. Its receipt never qualifies live Muse.

At the normal INFO level, `chat.request_admitted` records effective waiting/write settings and correlation. `chat.request_rejected` WARN records unsupported parameter/schema paths; `chat.history_conflict` WARN records linkage failures. `chat.stream_terminated` or `chat.request_terminated` records the last event, cause, last observed job disposition, output acceptance, byte counts, timing and outcome. Completion and context cancellation are INFO; required-operation failures and uncertain delivery are ERROR. Existing dispatch, deadline and storage events supply assignment generations, busy holds and causal dependency evidence.

DEBUG records retain admitted Chat input, normalized input, accepted decisions and actual attempted encoded frames privately after redaction. INFO stdout excludes these payloads. Capture remains bounded to seven days or 128 MiB, with records no larger than 6 KiB and explicit omissions.

Collect `/api/v1/admin/diagnostics/export?request_id=HTTP_REQUEST_ID` with a protected management header file, reconstruct using `decodeExport` from `tools/qualification-evidence.mjs`, and require complete metadata and valid chunks/digests. Then export each linked `operation_id`, filtering by client, session, conversation, worker/job and generation across broker instances. Unsupported input requires correcting the named parameter; conflicts require restoring exact owned history/tool linkage; uncertain inference requires retaining its hold; a failed storage boundary requires repairing its recorded cause and reading/replaying the accepted output. No business-table query or process attachment is needed for diagnosis.

`CI / openai` retains only safe source/image identity, case, SDK and cleanup summaries for seven days. Private fixture directories and model payloads are not uploaded. These integration receipts do not contribute to unit statement coverage.

## OpenAI Responses

Use the same `/v1` base URL, named model-client Bearer key and `muse-ai` alias as Chat. `POST /v1/responses` implements a text/function subset using Responses items and events. The [official function-calling guide](https://developers.openai.com/api/docs/guides/function-calling), [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses), and installed OpenAI JS SDK 7.53.0 are the protocol references inspected on November 13, 2026. This subset does not certify Codex, Claude Code, CLIProxyAPI or cc-switch.

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

New turns require the latest completed response of that owned session. There is no branching. Exact repeated requests are reconciled before stale-reference rejection and return their existing response and item IDs; changing JSON versus SSE does not create a new turn. Replayed server output IDs must belong to the canonical conversation and match their accepted contents. Unknown and foreign response references have the same `404` outcome. Conflicting session, stale new continuation, changed item or call/result linkage produces `409`. Concurrent turns serialize through the existing SQLite transaction.

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

`make test-responses` reuses the broker/SQLite/SSE harness and `tools/openai-conformance.mjs --protocol responses`. The existing Chat invocation remains unchanged. The runner still takes `--base-url`, `--fixture`, and `--receipt`, and obtains its model-client credential only from `MUSE_CHAT_CLIENT_KEY`. SDK/raw HTTP and JSON/SSE cases execute only the exact permitted local `read_file` fixture and check its exact result, full replay, chained continuation, and retry identity.

The same suite runs ten synchronized clients through two brokers on one SQLite file, with two controlled workers answering after five seconds, request history reads once per second, and actual worker heartbeats. The safe Responses receipt records sample counts, completed requests per second, broker admission and claim p95, queue and client latency, and the longest heartbeat gap for the measured host and workload.

Read `db.connected` and `readiness.changed` from `docker compose logs service`. For a busy startup, `db.retry_scheduled` includes cause, SQLite code, attempt and delay. For a failed open or schema check, `db.connect_failed` or `db.migration_failed` identifies the file, phase and expected or observed settings. Release an identified writer lock, restore private state-directory access, or restore a verified SQLite backup according to the recorded cause. After recovery, filter the authenticated protected export by the startup `operation_id`. For an affected request, export first by `request_id` and then its linked `operation_id`. The `decodeExport` decoder validates capture and digest completeness. SQLite exchanges include code, phase, elapsed time and transaction outcome. Preserve uncertain work when the commit outcome cannot be confirmed.

The controlled integration target covers reference ownership, serialization, instruction replacement/omission, restart persistence, healthy pinning, eligible replacement, tool conflicts, deadlines, cancellation, claimed-worker failure, storage boundaries and interrupted delivery. These are software checks, not live inference qualification. Unit tests exercise actual normalizers, services, encoders, handlers and stream consumers separately from integration coverage.

At the normal INFO runtime setting, `responses.request_admitted` identifies effective wait/write settings and operation correlation. Admission emits `responses.reference_rejected` WARN for reference/ownership failures and `responses.item_conflict` WARN for history/linkage conflicts. Protected `history.conflict_detail` retains the corresponding expected/observed items. `responses.request_rejected` WARN identifies unsupported fields and schema paths. `responses.stream_terminated` or `responses.request_terminated` records state, cause, output acceptance, last attempted/completed sequence, bytes, timing, attempt and final disposition. Completion and cancellation use INFO; failed required operations and uncertain delivery use ERROR. Existing job/dispatch/storage records provide generations, fences, busy holds, decisions and causal dependency evidence.

DEBUG captures admitted and normalized input, active instruction/tool metadata, accepted decisions, delivered worker context and each attempted encoded frame privately after credential redaction. INFO stdout excludes these payloads. Existing 6-KiB reconstructable chunks, seven-day/128-MiB retention and explicit omission reporting apply.

Collect each participating broker's `/api/v1/admin/diagnostics/export?request_id=HTTP_REQUEST_ID` using the protected management header file. Decode using `decodeExport` from `tools/qualification-evidence.mjs`; require complete metadata and valid chunks/digests. Export linked `operation_id` values and filter by authenticated owner, conversation/session, worker/job, generation and revision. Reference failures require the latest owned ID and agreeing session; item conflicts require restoring exact accepted history/results. Retain uncertain holds after claimed loss, and repair the recorded storage cause before replaying accepted output. This procedure needs no business-table query or runtime attachment.

`CI / openai` runs both protocol matrices on the exact source head. It retains `.artifacts/ci/openai/receipt.json` for Chat and `responses-receipt.json` for Responses, containing only safe source/image identity, SDK/case results, diagnostic conclusions and resource-cleanup proof for seven days. Private fixtures, raw captures and credentials are not uploaded, and integration receipts never contribute to unit coverage.
