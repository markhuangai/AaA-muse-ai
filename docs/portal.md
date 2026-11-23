# Control portal

Open the operator's public service origin and sign in using `control-portal.password` from the mounted YAML configuration. The existing `${ENVIRONMENT_VARIABLE}` reference mechanism also applies to this password. It must differ from management and model-client keys.

Settings shows redacted effective YAML, service and build identity, database health, and named client keys. The Workers page manages registrations and enrollment. Requests shows recorded inference history, conversation timelines, and cancellation. Service readiness describes the broker and database. Verify inference readiness separately.

## Session boundary

The browser uses a host-only Secure, HttpOnly, SameSite=Strict session cookie. With **Remember me** unchecked, reloads and new tabs stay signed in for the browser session. With it checked, sign-in also survives closing the browser and restarting the broker. The broker renews the remembered cookie during use at most once per day with a maximum lifetime of 400 days per issuance. Browser cookie retention and session restore settings affect what survives closing the browser.

**Sign out** revokes the shared grant for this browser and clears private views in open tabs when confirmed. If confirmation is lost, the portal hides private content and offers **Retry sign-out**. A session check during a service outage offers a retry. A denied session opens sign-in.

Sessions authorize existing management APIs without giving the browser the automation management key. They cannot call model-client or worker APIs. Conversely, raw portal passwords, model-client keys and worker credentials do not authorize portal management requests. The automation key remains valid for its existing management endpoints.

SQLite holds browser-grant digests and a salted password verifier. Restart the brokers with the same updated configuration to rotate the portal password and invalidate every browser grant. An old broker generation rejects browser session operations. Coordinated upgrades apply migration 002 and retain existing state. Back up the database before upgrading and stop older broker processes before opening the schema with the new binary. A rollback to a schema-001 binary needs its compatible pre-upgrade backup.

Failed logins are bounded to five per transport peer per minute and sixty per broker per minute. The broker uses the transport address. Throttling returns HTTP 429 with `Retry-After`. The shared store supports 1,024 browser grants. It reclaims expired remembered grants and confirmed sign-outs. A browser that discards its cookie can leave a grant behind. A full store returns 503 and retains current grants. Sign out another browser or rotate the portal password to recover capacity.

## HTTP interfaces

| Method and path | Behavior |
|---|---|
| `POST /api/v1/portal/login` | JSON `password` and boolean `remember_me` set a browser cookie and return `{"authenticated":true}`. Omitting `remember_me` returns the existing process-local, thirty-minute `session_token` and `expires_at`. |
| `GET /api/v1/portal/session` | Checks current authority with a non-cacheable response. Returns `{"authenticated":true}`, 401 for denied authority, or 503 for an unavailable session store. |
| `POST /api/v1/portal/logout` | Revokes browser or bearer authority. Cookie sign-out can be retried after an uncertain response. |
| `GET /api/v1/portal/settings` | Returns redacted effective YAML, `client_key_names`, build and instance identity, service and database health, schema version and implemented capabilities |
| `POST /api/v1/portal/client-keys` | Takes JSON `{name, key}` and returns HTTP 201 with `{name}` after saving to `config.yaml`. Requires an active portal session. |
| `POST /api/v1/portal/events` | Accepts authenticated, allowlisted browser reports |

Go serves the compiled React assets at `/`, `/settings`, `/workers`, `/requests` and `/assets/*` on the existing HTTP port. Keep the portal and API on one HTTPS origin through the operator's reverse proxy. Browser writes require same-origin requests and `X-Portal-Operation-Id`. An explicit Authorization header takes precedence over the cookie. The CSP permits same-origin resources. Fonts are bundled with their OFL-1.1 license notices.

The browser uses ten-second request deadlines, refreshes every thirty seconds while visible, and marks snapshots stale after sixty seconds without a successful refresh. Failed refreshes retain the last snapshot with an explicit error and Retry action. Logout and new login generations fence delayed responses. Reload the portal for a build mismatch.

**Appearance** defaults to System and follows live operating system changes. Choose Light or Dark to save an override in this browser. The portal reduces motion when requested by the operating system.

## Client keys

In **Settings → Client keys**, enter a name and a key or click **Generate** to create a random `aaa_muse_ai_` key. You can copy the generated value before Save. Save clears the draft and displays the saved name. Read the value afterward from the protected `config.yaml` on the host.

The broker preserves comments, key order, and environment references when it appends a new mapping entry. Brokers sharing the file refresh client keys before processing the next request. Edit the file to rotate a value under its existing name or remove a key. The entry name owns the client's request history. Restart the broker after changing other settings.

Duplicate names and credentials return HTTP 409. When the save outcome is uncertain, inspect the saved names or host configuration before submitting again. A read-only or inaccessible directory prevents saving and leaves the existing configuration active.

## Worker management

Selecting a worker opens a right-hand drawer and keeps the list in place. Edit the display name in the first card, **Registration and access**. Dismiss the drawer with the **×** button, Escape, or a click or tap on the backdrop. The list uses `GET /api/v1/admin/workers` and selects by immutable worker ID. Names may be shared. Renaming uses `PATCH /api/v1/admin/workers/{id}` and displays the accepted name or validation error.

Before the first authenticated work poll, the drawer shows **Never seen**. After contact, **Recent contact** lasts under one minute, **Quiet** starts at one minute and **Offline** starts at ten minutes of total silence, using broker time. A normal one-minute cron with jitter can show Quiet. **Offline for** counts time beyond the ten-minute threshold. A stale snapshot preserves the last broker sample.

Archived model reports describe the original setup turn, not current worker availability or readiness. The broker applies its configured request limits.

Last service contact, last authenticated work poll, claim age, claim deadline and native start are separate observations. A busy checker reports contact for its existing claim, so **Recent contact** can appear alongside **Busy** and a last reported hold. The Workers page retains the last work poll while the slot is held. Busy check-ins use their own broker timestamp. Claim authorization, deadlines and pre-claim routing use the existing broker rules.

`POST /api/v1/admin/setup-prompts` takes `{"origin":"https://host:8443"}` and creates a fifteen-minute single-use enrollment with pinned installation and native cron read-back instructions. The browser supplies its current HTTPS origin. Use `POST /api/v1/admin/enrollments` for code-only enrollment. Expiry, session end, and leaving Workers clear the current text and copy control. Clipboard denial leaves selectable text, and the broker enforces single use and expiry.

Revocation uses a confirmation dialog naming the worker and immutable ID, then `POST /api/v1/admin/workers/{id}/revoke`. A confirmed revoke or fresh list response removes the worker from the Workers list and closes the drawer. The broker rejects every copy of the revoked worker credential. Registration and request history retain the worker identity. Remote execution may remain uncertain.

Worker polling and freshness are independent from settings. Session generations and request sequences fence late responses, including reads started before a mutation. Stale snapshots disable rename/revoke and retain the last observations. Failed or lost mutation responses remain explicitly unconfirmed; no mutation is retried automatically. Refresh reconciles current server values.

## Request history and cancellation

**Media job** shows the recorded owner, profile and broker-observed progress. A claim reserves the worker. A start acknowledgement appears when the worker records it with the broker. The detail shows the submission deadline and any pending worker settlement alongside the terminal status. The media timeline includes the retained assignment snapshot.

Open **Requests** at `/requests`. Request pages contain up to fifty rows ordered by creation time and immutable ID. Filter by conversation ID, or open one exact request ID. Previous, next and first controls reuse the management API's opaque cursors; changing the filter starts a new page sequence. Older request pages remain anchored under polling. Explicit refresh reloads the current page without changing its filter, selection or scroll position.

Detail shows the immutable request, conversation, client/session, response, worker and job identifiers; current worker names are labeled **Current name**. Names describe the registration now and never rewrite historical identity. The snapshot includes admitted messages and client tool results, tool definitions, accepted decisions/final output, request-scoped Responses instructions, assignment/connection generations, context kind/base receipt and observed timing. Expand the complete snapshot or recorded context for all retained content. JSON numbers retain their admitted values. Content is selectable text; markup and tool names are never executed.

The conversation timeline pages through at most fifty chronological events within the existing 2-MiB page limit. It marks the selected request and preserves unknown event kinds and full event details. Related request links open their own snapshots. Assignment events retain old/new worker and job IDs, generations, replacement reasons and full-history boundaries. Legacy records explicitly mark missing provenance, native identity and event times. Server write observations do not prove remote consumption; neither the portal nor recorded history exposes private Muse reasoning.

Current views poll every thirty seconds while visible. Timeline pages with a continuation cursor remain anchored. The last page can refresh for new events. Sixty seconds without a successful read marks a snapshot stale. Cancellation is disabled for stale, pending or terminal detail. Session loss clears the browser's history view. Query, selection, session generations and read sequences fence superseded responses.

**Cancel request** opens a native confirmation naming the immutable request ID. Confirming sends one fresh submission ID to the existing management cancellation endpoint, including for unassigned requests. The portal displays the returned state and remote outcome. A claimed request can remain remotely uncertain with a retained busy hold; the worker's exact idle acknowledgement releases capacity without inventing a stopped outcome. Accepted decisions, client tool IDs/results and history remain durable. Cancellation never executes a tool or grants inference replay authority. A lost response is explicitly unconfirmed; refresh reconciles current state before another deliberate action. No mutation is retried automatically.

Rows and request details explain interrupted tasks using the first recorded
terminal reason. The explanation can distinguish a queued deadline, an authorized
native run that failed, and a missing media file. The original reason code remains
in the API. Historical detail is limited to the evidence recorded at the time.

## History diagnostics

`portal.history_load_failed` WARN records rejected queries, missing records and dependency failures; authenticated browser reports add bounded cursor/filter identifiers, query/selection/session generations, requested/accepted/latest sequences and last-good time for deadlines, staleness and discarded responses. Protected `history.query_input` and `history.query_exchange` retain relevant queries and full responses; existing storage ERROR events and protected causal detail identify SQLite failures.

`portal.cancel_result` INFO records the committed state, reason, remote outcome and busy hold. Rejected cancellation emits WARN and joins existing transaction/rejection evidence. An authenticated browser uncertainty report is labeled `client_report`; it cannot assert successful cancellation. `portal.render_failed` ERROR joins the source history HTTP request and portal build. Browser reports contain no messages, instructions, tools, arbitrary exceptions or credentials.

Collect complete protected exports using each displayed portal operation ID and HTTP request ID, then the native request operation ID, using the commands below with `operation_id=ID` or `request_id=HTTP_ID`. Verify chunks, digests and absence of omissions. Invalid cursors require the matching filter's first page; missing records require a recorded identifier; a storage failure requires restoring the dependency before refreshing. A completion race requires inspecting the accepted output. An unconfirmed cancellation requires a fresh read while preserving uncertainty. A discarded response requires retaining the newer selection. These conclusions come from logs without business-table queries or process attachment.

The Workers list and drawer show the last authenticated version, the paired
target and the last update state. **Update available** means the broker offered
the package. **Updating** means the worker acquired an update reservation.
**Awaiting confirmation** means the worker reported a switch and the broker has
yet to see a fresh pickup from the target package. The drawer shows the failure
reason, retry time when available and the operation ID used for exports.

## Worker diagnostics

`portal.worker_action` INFO records authenticated portal enrollment/setup, rename and revocation requests with action/resource IDs, portal session, backend request/operation IDs, actual HTTP status, timing and HTTP completion outcome. Existing domain events retain transaction outcomes; HTTP completion alone does not mean a mutation committed. `portal.worker_state_stale` WARN is an authenticated client report with request/accepted sequences, generation, last-good time, safe cause and related backend request ID where a response was received. The endpoint does not accept client assertions of successful actions. Enrollment text/codes and arbitrary exceptions are excluded from browser telemetry.

Collect the protected export by the operation ID and associated request IDs shown in the UI. Use the decoder and completeness checks below to join client ordering evidence with server request exchanges, worker rejections and storage causes. Invalid names require correcting the submitted name; an unreadable SQLite database requires restoring the database and refreshing; obsolete responses require retaining the newer accepted state. Unconfirmed mutations require reading the actual state before another deliberate action. These conclusions require no business-table queries or process attachment.

For an unexpected offline duration, compare the last contact and last poll in the protected worker-list exchange with the checker’s scheduled and actual entry times in the private worker export. Use the worker’s pull request ID to inspect `worker.pull_timing`, including database acquisition and queue lookup. For busy work, join `cron.presence_observed` or `cron.presence_unavailable` to the broker exchange by request ID. Join `cron.native_observation`, `cron.recovery_pending` and `job.work_settled` by operation, claim and native run. A producer hold names the unresolved reservation or process. Preserve the accepted result and the private log export when a hold remains. For a stale snapshot, use `portal.worker_state_stale` and the related failed read before refreshing.

For an update problem, export the operation from the worker with
`diagnostics-export --operation-id ID --decode` and from each participating
broker using the command below. Join `worker.update_started`,
`worker.update_verification_failed` and `worker.update_fallback` by operation
and request ID. A missing archive calls for checking the exact paired release
asset. A digest mismatch calls for comparing the observed digest to the image's
trusted pin. For an interrupted task, use its request operation to retrieve
`job.interrupted` or `job.deadline_exceeded` and the original stage and evidence.

## Diagnostics

Runtime output defaults to INFO JSON. The existing protected capture always retains DEBUG detail independently of stdout filtering, using reconstructable chunks no larger than 6 KiB, seven-day retention and a 128-MiB maximum. Login capture explicitly omits password and session output; credentials are never diagnostic payloads. Redacted settings can be reconstructed from protected DEBUG evidence.

Filter by the request or operation ID displayed after a key save. `client_key.created` at INFO records the saved name. `client_key.rejected` at WARN distinguishes invalid input from conflicts. `client_key.persist_failed` and `client_key.reload_failed` at ERROR record the failing stage and cause. A directory permission error calls for correcting the mount and ownership. A directory sync failure after replacement calls for inspecting the host file to reconcile the uncertain save. Key values are omitted from capture. `setup.prompt_created` records the accepted HTTPS origin at INFO, and `setup.origin_rejected` records a safe cause at WARN before enrollment starts.

`portal.auth_failed` at WARN identifies rejected passwords, throttling, cross-origin requests, denied sessions and capacity. INFO lifecycle events identify issuance, renewal, and sign-out with a safe session ID. `portal.session_generation_stale` at WARN identifies a broker that needs to restart with the current password configuration. `portal.session_store_failed` at ERROR identifies the failing stage and cause. Use the protected DEBUG detail to restore the SQLite dependency before retrying. `portal.state_stale` at WARN reports a stale snapshot. `portal.render_failed` at ERROR identifies a client rendering failure. `portal.assets_unavailable` at ERROR identifies an unreadable asset.

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

The decoder rejects missing chunks, digest mismatches, incomplete captures and omissions. Join server and client-reported events by operation ID, request ID, instance and portal-session identifier. A wrong password calls for the portal password, a throttle includes its retry delay, database degradation calls for restoring the SQLite database, and asset failures call for correcting the combined image. This diagnosis requires no process attachment or business-table queries.

## Controlled validation

The November 13, 2026 local run used Playwright 1.65.0 Chromium against the combined image. Initial browser validation exposed native `fetch` receiver binding and Docker's changing ephemeral host port on restart; the default adapter now binds its receiver and only the restart fixture pins a selected host port. Final configuration review also reproduced invalid YAML when a client name matched a credential; scalar redaction now precedes encoding and preserves colliding redacted names with suffixes. Production-logic regressions cover exact, multiline and quoted passwords. The final browser run passed after these corrections; no shortened server TTL or time-control endpoint was introduced.

`make test-portal-shell` runs production HTTP expiry logic with an injected clock and Playwright against the built Alpine image and real SQLite. It checks desktop/tablet/phone views, credential boundaries, reload/logout/restart, unsafe display text, outages, delayed responses, deadline/expiry behavior and actual diagnostic capture. The browser clock does not assert that the production server's thirty-minute lifetime elapsed.

The #16 worker suite passed at `2026-11-13T18:57:20Z`, producing 41 safe receipts and thirteen screenshots at 1440, 768 and 390 pixels. It exercised accepted Unicode names without identity/assignment changes, the unchanged pinned setup prompt and code-only alternative, actual clipboard success and denial, enrollment redemption/reuse, keyboard confirmation/cancellation and revoked-credential rejection. Controlled peers exercised offline, idle, busy, client-tool waits and qualification provenance. Separate cases covered browser expiry, real API expiry with a disposable fixture, delayed reads, a committed mutation whose response was lost, logout, deadlines, PostgreSQL outage/recovery and invalid-session denial. Complete protected exports joined browser outcomes to backend causes and transaction results without business-table queries. Stdout, protected evidence and browser reports passed credential-canary scans and capture-completeness assertions. Its safe receipt is `.artifacts/ci/portal/workers-receipt.json`; private fixtures and credential-bearing traces are excluded.

Initial #16 validation exposed test-only query ambiguity and jsdom's missing native-dialog methods; scoped queries and a replaceable dialog adapter corrected those tests while Chromium retained real modal checks. The design probe now measures active native modal bounds, occlusion and focus, with the underlying page inspected separately. Detail panels retain their natural height. A real browser race also exposed worker actions before activation when settings were delayed; worker activation now follows authentication immediately, independently of settings, with a delayed-settings regression. The final complete unit run passed with portal statement coverage of 574/588 (97.61%); portal-shell, service, worker-auth and image regressions passed by `2026-11-13T19:01:48Z`. These local receipts bind the approved base, working-source digest and image recorded in the [project history](project-history.md); hosted checks must verify the final committed head separately.

`make test-portal-history` exercises the actual combined image, HTTP/SQLite, controlled peers and Chromium at 1440, 768 and 390 pixels. Its cases cover native/legacy content, tool linkage, request-scoped instructions, equal-time/concurrent pagination, replacement boundaries, renamed agents, cancellation races/lost responses, expiry, safe text rendering, stale response fencing and log-only diagnosis. Its safe receipt is `.artifacts/ci/portal/history-receipt.json`; integration evidence never contributes to unit coverage. The full run passed at `2026-11-13T22:17:06Z` with 43 safe receipts and thirteen screenshots; Its exact source digest and image identity are in the project history. [Validation evidence](project-history.md)

Initial #17 checks found an unsupported Go regexp quantifier, ambiguous test queries and a logout timing regression; the cursor now uses an explicit length bound, test queries target their intended panel, and logout waits for abandonment reports only when history reads are pending. Docker host forwarding again dropped a TCP connection, so local validation used the existing direct-network option. Current Chromium requires a trusted origin for UUID/clipboard APIs; the shared test adapter maps localhost directly to each harness-owned container, including intercepted Node fetches, while hosted validation retains its normal transport. Controlled browser checks also corrected route-removal races and waited for a successful refresh before advancing the clock. No production transport, lifetime or recovery authority changed.

`npm run test:unit --workspace portal` exercises the real React rendering, state, API adapter and report queue with replaceable I/O boundaries. Raw statement coverage for every portal production module is recorded under `.artifacts/unit/portal/coverage-final.json`; the existing unit runner binds it to source identity and requires strictly greater than 90% coverage independently of other components. Integration receipts never contribute to that threshold.

`CI / portal` depends on successful unit shards, then requires the shell, worker and history browser/image suites. Their safe receipts and credential-free screenshots are retained for seven days; private fixtures, raw session responses, traces and HAR files are not uploaded. All controlled results are software evidence. The live Muse verdict remains inconclusive and a passing live receipt still gates release.
