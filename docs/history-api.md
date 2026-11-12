# Native requests and canonical history

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
