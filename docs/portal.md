# Control portal

Open the operator's public service origin and sign in using `control-portal.password` from the mounted YAML configuration. The existing `${ENVIRONMENT_VARIABLE}` reference mechanism also applies to this password. It must differ from management and model-client keys.

The portal shows resolved effective YAML with credentials redacted, the service/build identity, database health and the software interfaces implemented by that build. It does not edit configuration or provide enrollment and worker-management controls. Service readiness does not establish inference readiness.

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

Go serves the compiled React assets at `/`, `/settings` and `/assets/*` on the existing HTTP port. Unknown API paths and missing assets retain errors. Production has no Node server, CORS middleware, bundled reverse proxy or certificate management. The operator's Traefik, Nginx or other proxy owns routing and TLS. The CSP permits only same-origin resources; fonts are bundled with their OFL-1.1 license notices in the image.

The browser uses ten-second request deadlines, refreshes every thirty seconds while visible, and marks snapshots stale after sixty seconds without a successful refresh. Failed refreshes retain the last snapshot with an explicit error and Retry action. Logout and new login generations fence delayed responses. Build mismatches require a reload and fresh login.

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

`npm run test:unit --workspace portal` exercises the real React rendering, state, API adapter and report queue with replaceable I/O boundaries. Raw statement coverage for every portal production module is recorded under `.artifacts/unit/portal/coverage-final.json`; the existing unit runner binds it to source identity and requires strictly greater than 90% coverage independently of other components. Integration receipts never contribute to that threshold.

`CI / portal` depends on successful unit shards, then requires the real browser/image suite. Its safe receipt and credential-free screenshots are retained for seven days; private fixtures, raw session responses, traces and HAR files are not uploaded. All controlled results are software evidence. The live Muse verdict remains inconclusive and a passing live receipt still gates release.
