# Control portal

Open the operator's public service origin and sign in using `control-portal.password` from the mounted YAML configuration. The existing `${ENVIRONMENT_VARIABLE}` reference mechanism also applies to this password. It must differ from management and model-client keys.

The portal shows resolved effective YAML with credentials redacted, the service/build identity, database health and the software interfaces implemented by that build. The Workers page lists registrations and supports display-name changes, single-use enrollment/setup generation and confirmed revocation through existing management APIs. Requests shows recorded inference history, conversation timelines and confirmed cancellation. Configuration remains read-only. Service readiness does not establish inference readiness.

## Session boundary

Login exchanges the password for a cryptographically random bearer session with an absolute thirty-minute lifetime. Only its digest and nonsecret metadata are retained in service memory. The browser holds the credential in memory, outside rendered state; it uses no local storage, session storage, cookies, IndexedDB, Cache API or service worker for authentication. Reload requires a fresh login. Server expiry, logout and restart invalidate session authority.

If logout cannot reach the service, the browser clears its credential and explicitly says server sign-out was not confirmed. The unreachable server session can remain valid until its original expiry. No credential is retained for an automatic retry.

Sessions authorize existing management APIs without giving the browser the automation management key. They cannot call model-client or worker APIs. Conversely, raw portal passwords, model-client keys and worker credentials do not authorize portal management requests. The automation key remains valid for its existing management endpoints.

Sessions are local to one broker process. An origin backed by multiple broker instances needs operator-managed affinity. A restart requires login again; sessions are not persisted or replicated through PostgreSQL.

Failed logins are bounded to five per transport peer per minute and sixty globally per minute. Forwarded address headers are ignored. The peer table and active session table each hold at most 1,024 records; expired entries are pruned and capacity exhaustion is rejected. Throttling returns HTTP 429 with `Retry-After`; a full session table returns 503 without evicting valid sessions.

## HTTP interfaces

| Method and path | Behavior |
|---|---|
| `POST /api/v1/portal/login` | JSON `password`; returns `session_token` and `expires_at` |
| `POST /api/v1/portal/logout` | Invalidates the authenticated portal session |
| `GET /api/v1/portal/settings` | Returns redacted effective YAML, public origin, build/instance identity, service/database health, schema version and implemented capabilities |
| `POST /api/v1/portal/events` | Accepts authenticated, allowlisted browser reports |

Go serves the compiled React assets at `/`, `/settings`, `/workers`, `/requests` and `/assets/*` on the existing HTTP port. Navigation and browser back/forward retain the in-memory session; reloading requires login. Unknown API paths and missing assets retain errors. Production has no Node server, CORS middleware, bundled reverse proxy or certificate management. The operator's Traefik, Nginx or other proxy owns routing and TLS. The CSP permits only same-origin resources; fonts are bundled with their OFL-1.1 license notices in the image.

The browser uses ten-second request deadlines, refreshes every thirty seconds while visible, and marks snapshots stale after sixty seconds without a successful refresh. Failed refreshes retain the last snapshot with an explicit error and Retry action. Logout and new login generations fence delayed responses. Build mismatches require a reload and fresh login.

## Worker management

Worker detail comes from the existing `GET /api/v1/admin/workers` projection, selected by immutable worker ID. Names may be shared. Renaming uses `PATCH /api/v1/admin/workers/{id}` and displays the actual accepted name or safe validation error. It does not change identity, authority or assignments.

Connection state, authenticated last contact, heartbeat, broker activity, current assignment and client-tool waits are separate observations. A retained busy assignment can coexist with an offline subscriber. Hidden Muse activity is not observable. Readiness is shown with its recorded qualification, connection generation, capabilities and controlled/live provenance. Controlled approval does not establish live Muse qualification. Installed worker version is `Not reported`; independent background wake is `Not independently observed` because current APIs supply neither fact.

`POST /api/v1/admin/setup-prompts` creates one fifteen-minute single-use enrollment with complete pinned installation/reconnection text. The explicit code-only alternative uses `POST /api/v1/admin/enrollments` and creates its own enrollment. No code is parsed from a prompt in the product. Replacing an output clears the previous text; it does not revoke an earlier code. Expiry, session end and leaving Workers clear the current text and copy control. Clipboard denial leaves selectable text for manual copying. The portal cannot confirm consumption and does not persist enrollment authority. Previously copied text is outside the portal's control; the server enforces single use and expiry.

Revocation uses a native confirmation dialog naming the worker and immutable ID, then `POST /api/v1/admin/workers/{id}/revoke`. The server result is shown without optimistic authority changes. Every copy of the credential is rejected after confirmed revocation; registration and history remain. The portal does not claim that remote execution stopped. Worker credentials have no automatic expiry and are never displayed here.

Worker polling and freshness are independent from settings. Session generations and request sequences fence late responses, including reads started before a mutation. Stale snapshots disable rename/revoke and retain the last observations. Failed or lost mutation responses remain explicitly unconfirmed; no mutation is retried automatically. Refresh reconciles current server values.

## Request history and cancellation

Open **Requests** at `/requests`. Request pages contain up to fifty rows ordered by creation time and immutable ID. Filter by conversation ID, or open one exact request ID. Previous, next and first controls reuse the management API's opaque cursors; changing the filter starts a new page sequence. Older request pages remain anchored under polling. Explicit refresh reloads the current page without changing its filter, selection or scroll position.

Detail shows the immutable request, conversation, client/session, response, worker and job identifiers; current worker names are labeled **Current name**. Names describe the registration now and never rewrite historical identity. The snapshot includes admitted messages and client tool results, tool definitions, accepted decisions/final output, request-scoped Responses instructions, assignment/connection generations, context kind/base receipt and observed timing. Expand the complete snapshot or recorded context for all retained content. JSON numbers retain their admitted values. Content is selectable text; markup and tool names are never executed.

The conversation timeline pages through at most fifty chronological events within the existing 2-MiB page limit. It marks the selected request and preserves unknown event kinds and full event details. Related request links open their own snapshots. Assignment events retain old/new worker and job IDs, generations, replacement reasons and full-history boundaries. Legacy records explicitly mark missing provenance, native identity and event times. Server write observations do not prove remote consumption; neither the portal nor recorded history exposes private Muse reasoning.

Current views poll every thirty seconds while visible. Timeline pages with a continuation cursor remain anchored; the last page can refresh for new events. Sixty seconds without a successful read marks a snapshot stale. Cancellation is disabled for stale, pending or terminal detail. Logout and expiry clear all history; query, selection, session generations and read sequences fence superseded responses.

**Cancel request** opens a native confirmation naming the immutable request ID. Confirming sends one fresh submission ID to the existing management cancellation endpoint, including for unassigned requests. The portal displays the returned state and remote outcome. A claimed request can remain remotely uncertain with a retained busy hold; the worker's exact idle acknowledgement releases capacity without inventing a stopped outcome. Accepted decisions, client tool IDs/results and history remain durable. Cancellation never executes a tool or grants inference replay authority. A lost response is explicitly unconfirmed; refresh reconciles current state before another deliberate action. No mutation is retried automatically.

## History diagnostics

`portal.history_load_failed` WARN records rejected queries, missing records and dependency failures; authenticated browser reports add bounded cursor/filter identifiers, query/selection/session generations, requested/accepted/latest sequences and last-good time for deadlines, staleness and discarded responses. Protected `history.query_input` and `history.query_exchange` retain relevant queries and full responses; existing storage ERROR events and protected causal detail identify PostgreSQL failures.

`portal.cancel_result` INFO records the committed state, reason, remote outcome and busy hold. Rejected cancellation emits WARN and joins existing transaction/rejection evidence. An authenticated browser uncertainty report is labeled `client_report`; it cannot assert successful cancellation. `portal.render_failed` ERROR joins the source history HTTP request and portal build. Browser reports contain no messages, instructions, tools, arbitrary exceptions or credentials.

Collect complete protected exports using each displayed portal operation ID and HTTP request ID, then the native request operation ID, using the commands below with `operation_id=ID` or `request_id=HTTP_ID`. Verify chunks, digests and absence of omissions. Invalid cursors require the matching filter's first page; missing records require a recorded identifier; a storage failure requires restoring the dependency before refreshing. A completion race requires inspecting the accepted output. An unconfirmed cancellation requires a fresh read while preserving uncertainty. A discarded response requires retaining the newer selection. These conclusions come from logs without business-table queries or process attachment.

## Worker diagnostics

`portal.worker_action` INFO records authenticated portal enrollment/setup, rename and revocation requests with action/resource IDs, portal session, backend request/operation IDs, actual HTTP status, timing and HTTP completion outcome. Existing domain events retain transaction outcomes; HTTP completion alone does not mean a mutation committed. `portal.worker_state_stale` WARN is an authenticated client report with request/accepted sequences, generation, last-good time, safe cause and related backend request ID where a response was received. The endpoint does not accept client assertions of successful actions. Enrollment text/codes and arbitrary exceptions are excluded from browser telemetry.

Collect the protected export by the operation ID and associated request IDs shown in the UI. Use the decoder and completeness checks below to join client ordering evidence with server request exchanges, worker rejections and storage causes. Invalid names require correcting the submitted name; a PostgreSQL outage requires restoring the database and refreshing; obsolete responses require retaining the newer accepted state. Unconfirmed mutations require reading the actual state before another deliberate action. These conclusions require no business-table queries or process attachment.

## Diagnostics

Runtime output defaults to INFO JSON. The existing protected capture always retains DEBUG detail independently of stdout filtering, using reconstructable chunks no larger than 6 KiB, seven-day retention and a 128-MiB maximum. Login capture explicitly omits password and session output; credentials are never diagnostic payloads. Redacted settings can be reconstructed from protected DEBUG evidence.

`portal.auth_failed` WARN identifies rejected passwords, throttling and invalid/expired sessions. Session lifecycle INFO events identify issuance, logout and expiry through a nonsecret session identifier. `portal.state_stale` WARN identifies database degradation or a browser-reported refresh failure. `portal.render_failed` ERROR is a client report, not proof of a server exception. `portal.assets_unavailable` ERROR identifies an unreadable compiled asset and its safe filesystem cause.

Browser reports contain only allowlisted event, component, cause, expected/observed state, build, correlation, timing, attempt, last-good time and omission fields. They do not carry arbitrary exception messages, stacks, URLs or payloads. They are labeled `client_report` and are limited to 4 KiB, twenty per session per minute and 120 globally per minute. A disconnected browser retains at most twenty reports in memory and reports omitted counts, saturated at one million; session end clears its queue. Reports lost with the browser or an expired session cannot be recovered from the service.

The error panel shows a request ID when a response was received, plus an operation ID. Use the management key in a protected header file, never as a command-line credential:

```sh
curl -fsS --header @"$ADMIN_HEADER_FILE" \
  "$ORIGIN/api/v1/admin/diagnostics/export?operation_id=$OPERATION_ID" \
  --output "$EXPORT"
```

From a repository checkout with built worker diagnostic helpers, decode and verify the export:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {decodeExport} from "./tools/qualification-evidence.mjs"; for (const event of decodeExport(readFileSync(process.argv[1], "utf8")).events) console.log(JSON.stringify(event));' "$EXPORT"
```

The decoder rejects missing chunks, digest mismatches, incomplete captures and omissions. Join server and client-reported events by operation ID, request ID, instance and portal-session identifier. A wrong password calls for the portal password, a throttle includes its retry delay, database degradation calls for restoring PostgreSQL, and asset failures call for correcting the combined image. This diagnosis requires no process attachment or business-table queries.

## Controlled validation

The November 13, 2026 local run used Playwright 1.65.0 Chromium against the combined image. Initial browser validation exposed native `fetch` receiver binding and Docker's changing ephemeral host port on restart; the default adapter now binds its receiver and only the restart fixture pins a selected host port. Final configuration review also reproduced invalid YAML when a client name matched a credential; scalar redaction now precedes encoding and preserves colliding redacted names with suffixes. Production-logic regressions cover exact, multiline and quoted passwords. The final browser run passed after these corrections; no shortened server TTL or time-control endpoint was introduced.

`make test-portal-shell` runs production HTTP expiry logic with an injected clock and Playwright against the built Alpine image and real PostgreSQL. It checks desktop/tablet/phone views, credential boundaries, reload/logout/restart, unsafe display text, outages, delayed responses, deadline/expiry behavior and actual diagnostic capture. The browser clock does not assert that the production server's thirty-minute lifetime elapsed.

The #16 worker suite passed at `2026-11-13T18:57:20Z`, producing 41 safe receipts and thirteen screenshots at 1440, 768 and 390 pixels. It exercised accepted Unicode names without identity/assignment changes, the unchanged pinned setup prompt and code-only alternative, actual clipboard success and denial, enrollment redemption/reuse, keyboard confirmation/cancellation and revoked-credential rejection. Controlled peers exercised offline, idle, busy, client-tool waits and qualification provenance. Separate cases covered browser expiry, real API expiry with a disposable fixture, delayed reads, a committed mutation whose response was lost, logout, deadlines, PostgreSQL outage/recovery and invalid-session denial. Complete protected exports joined browser outcomes to backend causes and transaction results without business-table queries. Stdout, protected evidence and browser reports passed credential-canary scans and capture-completeness assertions. Its safe receipt is `.artifacts/ci/portal/workers-receipt.json`; private fixtures and credential-bearing traces are excluded.

Initial #16 validation exposed test-only query ambiguity and jsdom's missing native-dialog methods; scoped queries and a replaceable dialog adapter corrected those tests while Chromium retained real modal checks. The design probe now measures active native modal bounds, occlusion and focus, with the underlying page inspected separately. Detail panels retain their natural height. A real browser race also exposed worker actions before activation when settings were delayed; worker activation now follows authentication immediately, independently of settings, with a delayed-settings regression. The final complete unit run passed with portal statement coverage of 574/588 (97.61%); portal-shell, service, worker-auth and image regressions passed by `2026-11-13T19:01:48Z`. These local receipts bind the approved base, working-source digest and image recorded in the README; hosted checks must verify the final committed head separately.

`make test-portal-history` exercises the actual combined image, HTTP/PostgreSQL, controlled peers and Chromium at 1440, 768 and 390 pixels. Its cases cover native/legacy content, tool linkage, request-scoped instructions, equal-time/concurrent pagination, replacement boundaries, renamed agents, cancellation races/lost responses, expiry, safe text rendering, stale response fencing and log-only diagnosis. Its safe receipt is `.artifacts/ci/portal/history-receipt.json`; integration evidence never contributes to unit coverage. The full run passed at `2026-11-13T22:17:06Z` with 43 safe receipts and thirteen screenshots; the README records its exact source digest and image identity.

Initial #17 checks found an unsupported Go regexp quantifier, ambiguous test queries and a logout timing regression; the cursor now uses an explicit length bound, test queries target their intended panel, and logout waits for abandonment reports only when history reads are pending. Docker host forwarding again dropped a TCP connection, so local validation used the existing direct-network option. Current Chromium requires a trusted origin for UUID/clipboard APIs; the shared test adapter maps localhost directly to each harness-owned container, including intercepted Node fetches, while hosted validation retains its normal transport. Controlled browser checks also corrected route-removal races and waited for a successful refresh before advancing the clock. No production transport, lifetime or recovery authority changed.

`npm run test:unit --workspace portal` exercises the real React rendering, state, API adapter and report queue with replaceable I/O boundaries. Raw statement coverage for every portal production module is recorded under `.artifacts/unit/portal/coverage-final.json`; the existing unit runner binds it to source identity and requires strictly greater than 90% coverage independently of other components. Integration receipts never contribute to that threshold.

`CI / portal` depends on successful unit shards, then requires the shell, worker and history browser/image suites. Their safe receipts and credential-free screenshots are retained for seven days; private fixtures, raw session responses, traces and HAR files are not uploaded. All controlled results are software evidence. The live Muse verdict remains inconclusive and a passing live receipt still gates release.
