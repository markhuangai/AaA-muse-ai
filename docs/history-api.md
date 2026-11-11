# Native requests and canonical history

This API exercises the broker's normalized text/tool contract. It is not an OpenAI adapter or a live Muse qualification receipt. The November 11, 2026 issue #8 approval permits this engineering work with live testing deferred; release qualification remains inconclusive.

## Submit and continue

Authenticate with a configured `client-keys` bearer credential. Its YAML entry name identifies the owner; rotating the value under the same name retains ownership, while renaming the entry creates a different principal. Management, portal, and worker credentials cannot authorize native requests.

`POST /api/v1/requests` accepts this shape:

```json
{
  "protocol_version": 1,
  "submission_id": "caller-retry-identity",
  "worker_id": "opaque-worker-id",
  "messages": [{"type": "message", "role": "user", "text": "A question"}],
  "tools": [],
  "timeout_seconds": 300
}
```

Send `X-Muse-Session-Id` to continue an identified session. Session IDs are 1–100 ASCII letters, digits, underscores or hyphens; empty, repeated and malformed headers fail. The same string under different client owners identifies independent conversations. Without a session header or an owned `previous_response_id`, every new submission creates an independent session. The response returns the effective session in the same header.

Admission returns HTTP 202 with `id`, `conversation_id`, `session_id`, `worker_id`, `response_id`, `state`, and `created_at`. It contains no model output. Poll `GET /api/v1/requests/{id}` for the state and accepted `output`. Each request completes with one `final` or `tool_call` decision. A tool proposal leaves the conversation awaiting that exact call's client result; the caller applies its permissions and executes the tool locally.

Submit the next complete history, including the observed assistant message or tool call and the matching `tool_result`, using a fresh submission ID. Message items have `type`, `role` (`system`, `developer`, `user`, or `assistant`), and exact `text`; tool calls have `type`, `call_id`, `name`, and object `arguments`; tool results have `type`, `call_id`, and exact string `output`. Tool definitions use `name`, optional `description`, and JSON Schema object `parameters`. A final decision becomes an assistant message in canonical history. Text, line endings, numeric argument values and call IDs are preserved.

An optional `previous_response_id` resolves an owned, completed decision to its session. If a session header is also present, both must agree. This reference does not enable delta input: native requests always supply full history. Historical calls retain their original tool definitions; later requests may change their current tool set. Worker IDs remain pinned across completed requests, and a different explicit worker produces a conflict. Automatic selection and failover belong to later tickets.

`POST /api/v1/requests/{id}/cancel` accepts `protocol_version` and `submission_id`, cancels unfinished work, and retains history. A supplied session must match before cancellation. Cancellation of claimed inference retains the worker's busy hold until its matching idle acknowledgement; it does not prove remote inference stopped. Completed requests cannot be cancelled.

## Replays and errors

Exact retries use the same submission ID and original correlation fields. Changing those inputs under the same ID returns 409. An identified request whose normalized input exactly matches an admitted request returns that existing request without appending history or creating work. Uncorrelated requests with different submission IDs stay independent.

Other shortened/conflicting prefixes, unmatched/reused tool calls or results, and simultaneous new turns in the same session fail explicitly. Native requests do not queue overlapping session turns. Foreign and unknown request/response identifiers both return 404. Invalid/unsupported input returns 400, context/body overflow returns 413, capacity exhaustion returns 429, and storage unavailability returns 503. Online transport does not establish model readiness.

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

Schema 4 is additive and preserves migrations 1–3 and legacy records. An older binary rejects schema 4. Recover through a forward fix that retains the schema and history; do not drop tables or run a destructive downgrade.

`make test-history` runs the real service/PostgreSQL/SSE software scenarios with controlled worker decisions, including log-only diagnosis and cleanup. Those results do not qualify live Muse wake, reasoning, account-memory isolation, refresh recovery, or client compatibility.
