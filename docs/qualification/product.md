# Product qualification (#18)

The product runner links the compiled portal, real service/PostgreSQL containers,
shipped setup prompt, verified archive/installer and installed subscriber. Its
controlled model process calls the installed CLI; it cannot read client fixtures
from the worker container. Eight Chat/Responses JSON/SSE tool cycles retain exact
call IDs, client results, owned retry identities and later session affinity.
Concurrent identified sessions, portal rename/history/revocation and recovery
use those installations. Controlled results never establish live Muse behavior.

## Software checks

After the independent conformant audit, install locked dependencies and the
pinned Playwright browser, then run:

```sh
make test-product-e2e
node tools/product-ci.mjs .artifacts/ci/e2e
```

`PRODUCT_E2E_SHARD=flow` runs the linked product flow. `boundaries` reuses the
existing real-container Chat/Responses assertions for partial delivery,
accepted-output replay and conservative claimed-work failures. Each CI shard
has a thirty-minute job and a twenty-five-minute runner budget. `CI / e2e`
requires both shards from the current source/run/attempt and the identical
paired worker archive. Missing, cancelled, timed-out or incomplete shards fail.

The full private flow report and reconstructable exports stay under the local
test evidence directory. Validation reopens their bytes, checks chunk/digest
completeness and links client receipts to authenticated broker/worker contexts.
Only safe `.artifacts/ci/e2e/*.json` receipts are uploaded for seven days. Unit
coverage is collected separately. Failed runs and their private logs remain
available for diagnosis; cleanup removes only resources with the harness label.

## Private live inputs

Use a separate qualification stack with [compose.yaml](../../compose.yaml) and
[config.example.yaml](../../config.example.yaml). The owner supplies a verified
paired-release image digest and the new HTTPS origin. The previously published
service does not implement this configuration. The reverse proxy must allow at
least 330 seconds for inference responses. The runner uses HTTPS and exports;
there is no SSH dependency or deployment command in it.

The two browser sessions use private port forwarding of `6080` and `6081`:

1. Open `http://localhost:6080/vnc.html?autoconnect=true&resize=scale` for account A.
2. Open `http://localhost:6081/vnc.html?autoconnect=true&resize=scale` for account B.
3. Log in to separate authorized Muse accounts and leave setup to the agreed flow.

These addresses require the owner's private forwarding. Do not forward Chrome
debugging ports `9222`/`9223`. Browser input during login belongs to the owner.
No cookies, login credentials or unrelated conversations belong in reports.

Keep access files and evidence outside the checkout, directories `0700` and
files `0600`, owned by the invoking user. The access file contains paths and
nonsecret identities:

```json
{
  "schema_version": 1,
  "workers": [
    {"slot": "a", "worker_id": "<actual-worker-a>", "account_ref": "authorized-account-a"},
    {"slot": "b", "worker_id": "<actual-worker-b>", "account_ref": "authorized-account-b"}
  ],
  "clients": {
    "a": {"header_file": "/private/qualification/client-a.header"},
    "b": {"header_file": "/private/qualification/client-b.header"}
  },
  "portal_password_file": "/private/qualification/portal-password"
}
```

Each header file contains `Authorization: Bearer <its-own-key>` with an optional
trailing newline. Supply the management header separately. The portal password
file contains only the password. All four credentials must be distinct. No
durable worker credential is supplied to this collector.

For `enroll`, omit unknown `worker_id` fields. The real portal generates two
single-use setup prompts in protected local browser evidence. Install each
prompt on its intended Muse account, approve actual permission cards and record
the authenticated IDs before updating access. The runner never guesses worker
identity or re-enrolls a retained installation.

The [PoC observation format](README.md#private-observation-input) is retained.
For product runs, each `setup_ended` also identifies `account_ref`, installer
`setup_id`, native `hook_id`, retained `hook_path`, observed `worker_version`
and verified `worker_sha256`. `artifact_identity` also records
`installer_sha256`, the SHA-256 of the shipped `setup/install.sh` in the verified
archive. These are observed artifact identities, separate from the service's
recommended installer. Historical schema-one reports retain their original
interpretation; new collection never infers an installed version from a pin.

Every model turn needs its actual job/worker/case IDs, native conversation ID,
effective observable instructions and account-memory observation. Quiet windows
need continuous passive observation for at least 120 seconds; no manual message
may wake the measured inference. Preserve every intervention and its time.
Export worker diagnostics without `--decode` after measured windows. Supply all
exports through the observation file's `worker_exports` array. Missing native
observations, omissions or expired captures leave qualification inconclusive.

## Live stages and owner checkpoints

Use the same private evidence directory throughout a run:

```sh
node tools/qualify.mjs collect --suite release \
  --origin "$ORIGIN" --access-file "$ACCESS_FILE" \
  --admin-header-file "$ADMIN_HEADER_FILE" \
  --observations "$OBSERVATIONS" --evidence-dir "$EVIDENCE_DIR" \
  --stage baseline
```

The stages are deliberately resumable at external actions, rather than treating
a shell subscriber as proof of a working Muse backend:

| Stage | Action and required evidence |
| --- | --- |
| `enroll` | Real portal password login and two setup prompts; run once before account setup. |
| `baseline` | Independently observed readiness and client-tool trial for each worker, management approval for the current connection, eight protocol cycles, later affinity, interleaving and cross-client rejection. Native observation IDs start `baseline-readiness-a`, `baseline-tool-a`, and the corresponding `b` names. |
| `broker-prepare` | Stops with an accepted pending client-tool call, before executing its result. Retains the service process identity, call ID and source exports. |
| `broker-resume` | Owner restarts only the qualification service while retaining PostgreSQL/diagnostics volumes. Record `product_case` for `recovery.broker-tool-wait`. The runner verifies a new service process, requalifies reconnected workers through new `broker-*` trials, and supplies the original result exactly once. |
| `worker-restart` | Record the scoped supported worker restart. New `worker-*` readiness/tool trials and a client probe must preserve worker identity and one subscriber. No reinstall or state deletion. |
| `refresh` | Owner approves the exact supported non-destructive refresh scope, performs it, and observes the retained hook/task recovering without a manual Muse message. New `refresh-*` trials and a probe verify the recovered connection. A browser reload alone cannot establish this. |
| `replacement` | After a completed final answer with no pending tool, stop only worker A's identified subscriber. Record `recovery.replacement-full-history`. The runner requires A offline/idle, qualifies B, then continues the owned Responses session with full history and original accepted tool linkage. |
| `boundaries` | Import observed cross-worker rejection, old-generation rejection, partial-output and unresolved-work cases plus log-only diagnosis. Each needs exact operation/worker IDs and complete exports from the actual induced action. A declaration without causal broker evidence cannot pass. |
| `portal` | Real password login, rename preserving immutable IDs, and request-history reads for the matrix's actual requests. |
| `revoke` | Final confirmed portal revocation of only the two test workers; preceding required case receipts must exist. |
| `finalize` | Read-only reimport/revalidation; never queues inference or repeats client tools. |

Native refresh/restart/negative-boundary observations use `kind: "product_case"`,
`case_id`, exact `worker_ids`/`operation_ids`, `expected_boundary`,
`observed_boundary`, `capture_complete: true`, and the standard observed UTC
time/observer/source reference. Optional `receipt` carries exact nonsecret
request IDs, stale-result outcomes and diagnosis fields. Report actual actions,
including deliberate worker commands and client disconnects. Never fabricate
the supported-refresh path, replay an accepted client tool, or acknowledge
uncertain native work as stopped just to continue the run. The collector does
not install, reset, wipe or remotely restart a worker for these observations.

Recovery additionally requires `action_at`, retained `hook_id`/`hook_path`,
`before_connection_id` and `before_connection_generation` on the scoped action.
Record `worker_reconnected` or `refresh_reconnected` for that exact worker/hook,
with the new `connection_id`/`connection_generation`, actual UTC time, protected
modes, one subscriber, and `reinstalled`, `reenrolled`, `manual_message` all
false. Refresh approval/performed observations identify that same worker/hook;
the performed time equals `action_at`. Worker exports must show the post-action
subscriber PID, its exclusive supervisor and authenticated new connection before
the reconnection observation. The probe must use that recovered generation.
Initial installation startup cannot satisfy recovery.

Broker restart validation joins the pending cycle's accepted call and operation,
the owner's scoped action, authenticated status snapshots from two different
service processes, that operation's restored pending call, and its continuation.
The original worker/session and exactly one client execution must survive; the
exact retry must resolve to the same completed operation. Generic startup or
summary restoration events cannot satisfy the tool-wait case.

Stale-output receipts require the actual rejected HTTP `request_id`, `job_id`,
`worker_id`, assignment `generation` and `connection_generation`. Validation
requires a decision-operation `lease.fenced` with `stale_assignment` or
`stale_connection` and those submitted generations. A local CLI refusal or an
earlier foreign-worker read rejection does not establish server-side fencing.

A crash after a client execution intent has been saved is explicitly uncertain;
the runner refuses to execute that tool automatically again. Preserve evidence
and inspect the accepted broker receipt. No completed or failed case is silently
rerun in the same evidence directory. Broker/worker outages do not expand the
existing conservative inference-retry authority.

## Reports and diagnosis

```sh
node tools/qualify.mjs validate-report --report "$EVIDENCE_DIR/report.json"
node tools/qualify.mjs diagnostics --evidence-dir "$EVIDENCE_DIR"
```

Schema-two product reports record exact source/image/archive/installer identities,
installed versions, per-case protocol and assignment identities, interventions,
checkpoint state and complete export digests. Schema-one PoC reports remain
readable. `--require-complete` additionally requires every named software/live
case to pass. `--synthetic` refuses live-labelled input and can never establish
live qualification. Collector exit codes retain `0` pass, `1` failure/invalid,
`2` inconclusive. Truthfully incomplete reports remain readable without the
completion flag; unsupported nominal passes fail validation.

`e2e.case_failed` is ERROR with the expected/observed boundary and correlation;
`e2e.evidence_incomplete` is ERROR with missing receipts. `e2e.completed` is INFO
and accounts for every required case, including missing cases. Reconstruct the
induced rejected worker operation from protected exports and its request/job/
operation IDs, without business-table queries or runtime-memory inspection.
Keep failed observations and correction history. Missing live cases keep #18
incomplete and the passing-live release gate in force.

## Controlled validation record

The full product target and aggregate passed by `2026-11-15T00:29:09Z` at base
`b095988e02abb31e1eca97873f9900d88caa1180`, working-source SHA-256
`43f80f0255b25a21ddb9a5294d94d9a4c84683b53915f7c2c79e69adb4f62d83`.
The local combined-image ID was
`sha256:9692e7cd3637f876178f1781ef6c4158a0d0c3325b1baa86d4359c7a9b9fe45a`;
both shards used worker `0.1.0-dev.0`, archive SHA-256
`24d281a244f38807c3037dc0adee5a53416d880d24a3f92db3c42663441853d8`.
These are local development identities, not published deployment digests.

The linked flow passed all 32 required cases in 177,315 ms, including strict
reconstruction of the retained broker and worker exports. The boundary shard
passed in 239,557 ms. Its Chat/Responses suites proved partial-delivery replay,
durable references and conservative uncertain claimed work. All six unit
components separately passed the coverage policy from raw statement counts:

| Component | Covered / total |
| --- | --- |
| Go service | 4,327 / 4,559 |
| TypeScript worker | 1,356 / 1,362 |
| CI helpers | 665 / 691 |
| Qualification/tools | 2,061 / 2,099 |
| Worker build scripts | 89 / 89 |
| React portal | 1,006 / 1,038 |

The round-seven independent plan audit was conformant. Local Spec review had
no remaining findings; Standards review found no hard violations. Service,
authentication, native inference/history/routing/broker recovery, image startup,
current and archived worker transport, installer/worker recovery and all three
portal browser suites also passed. The local direct-container-network option
was used. Each harness verified cleanup of its owned resources.

Initial controlled runs exposed a credential/helper name collision, incorrect
readiness-challenge matching, JSON/SSE optional-null comparison and a requested
export interval preceding capture startup. The independent audit also caught
an unbound variable in the new retry assertion before execution. The portal
logout regression exposed concurrent denied reads cancelling one another;
its check now observes either first denial. Corrected runs passed without
relaxing canonical output, identity, completeness or session assertions.
Failed private reports and logs remain retained separately. Raw exports are
now protected and retained before strict decoding, so later decode failures
remain diagnosable.

These receipts do not qualify live Muse or authorize publication/deployment.
Final-head hosted checks and configured reviews remain outstanding. Live
execution waits for the owner's merge and updated-deployment confirmation;
missing live evidence keeps #18 incomplete. Documentation records these
observed runs; subsequent source-bound receipts must bind any later edits.
