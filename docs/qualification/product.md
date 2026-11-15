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

The partial-output receipt requires `request_id`, nonempty `operation_ids` and
`worker_ids`, with a matching `request.output_interrupted` and Chat/Responses
stream termination in the broker export. Both events must agree on identity and
attempted/written byte counts; written bytes must be positive. The stream must
have accepted model output and an uncertain or client-aborted outcome. A normal
completion or a failure before any output cannot satisfy this case.

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

## Live rc.7 observation record

After the owner confirmed merge, deployment and both account logins, the
November 15, 2026 live run used paired release `0.1.0-rc.7` at source
`f5b823bbef23476209064cf06fc9780abc0efc1d`. The owner-inspected service reference
was `ghcr.io/markhuangai/aaa-muse-ai@sha256:4800444ecb1ad2de2c6a81cab79f27bf172047f676401a07aa1a266c4c054f4d`;
its image config ID was
`sha256:0a5930f09454140455758a9101107643db0b1b3489566859fad3488ea94a98a5`.
The verified paired worker archive SHA-256 was
`76cfaa6944a5dd72d5e08988e545509c156d83b78a3d13cbf05d2abf1494ba0a`,
and the shipped installer SHA-256 was
`64b47838e35c8d252548a981b5aaf3df4e303d3216931066020a6e37db7b5f6e`.
Authenticated service metadata matched that source and release. These are
deployment observations, separate from the earlier controlled receipts.

| Case | Observed outcome (UTC) |
| --- | --- |
| Portal setup | Password login and both enrollment-prompt cases passed; both retained worker identities connected with rc.7. |
| `baseline-readiness-a` | Quiet from `14:02:30.361` to `14:04:30.738`; exact challenge completed by `14:05:29.918`. Complete broker/worker exports and the native observation passed `inspectCase`. |
| `baseline-tool-a` | Quiet from `14:32:24.030` to `14:34:24.598`; wake emitted at `14:34:30.612`, authenticated context read at `14:34:48.601`, no decision before the 300-second deadline. Broker cancellation at `14:39:26.050` retained unknown remote outcome and a busy hold. No client tool ran. |

The readiness quiet window has 108 passive samples and a maximum observed gap
of 3,069 ms; the tool quiet window has 109 samples and a maximum gap of 3,181 ms.
Neither window showed native activity or a manual intervention. The readiness
chat text appeared after the measured case; its post-case native report was
corroborated by the authenticated exports. This does not expose hidden reasoning
or prove absence of account-memory influence.

For the failed tool job `1ddd315c71695782b05e77d8ec35fbaa` in experiment
`6f74c9584e617edb6970deb5e18ee179`, Muse reported that a prompt-injection check
rejected the `job-show` result before message bodies were consumed or a decision
was formed. The exact safety notice and terminal native inference receipt were
unavailable in supported retained receipts. A completed hook invocation proves
wake emission, not stopped inference; no idle acknowledgement was sent at that
checkpoint. The reported refusal was respected. No dependent Chat/Responses or
recovery trial had started at that checkpoint.

Protected exports were reconstructed with canonical base64, gzip integrity,
byte-count, SHA-256 and capture-chunk verification. Retained worker evidence:

| Export | Bytes | SHA-256 |
| --- | --- | --- |
| A setup completion | 83,450 | `367a18932f540cd1303cfa63afeee6b897c852e89aeb3449d7b6355960a8e9a2` |
| A readiness | 138,852 | `6a506e848d796cb0beea0b6903483d79cb1bad8810571e3e04f1a132c4b5a16c` |
| A failed tool trial | 240,701 | `637c6a857ce86f9acccf4ce93e4f1df9994911aaad199f89ba8355c47d21e53e` |
| B setup completion | 75,839 | `e9004fc4bc86015fbe996a5c238558fc36748d76639130f7f88b84366b71845e` |

An earlier handoff overstated A's setup-export verification. The gap was later
resolved by recovering the original unchanged file in verified segments; the
correction and truncated copies are retained. Large chat responses were
truncated, and damaged segments were retained rather than guessed or silently
repaired. No public diagnostic upload was created.

Two collection defects were also observed. Resuming with a newly verified
installed version conflicts with the collector's prior unknown installation
metadata; the original report was retained before filling only B's verified
version/digest. Separately, `finalize` returned `invalid_json` while logging the
full broker response. At `14:57:39.928Z`, a 14,541,004-byte broker export with
9,272 captures decoded completely, but the production lossless parser rejected
its valid JSON logging wrapper; standard `JSON.parse` accepted the same wrapper.
The raw export SHA-256 is
`892256879244ce4a082d31423cea85087309c099c4b39ab4de673da2a9293a93`.
A smaller 3,095,779-byte export passed both parsers. This is a collector
failure, separate from Muse's reported refusal; no production fix is claimed.

Setup also required correcting newly owned directories that inherited setgid;
old credentials, journals and installations were preserved. The accidental
local OS reboot and restoration of signed-in browser profiles do not qualify a
supported Muse VM refresh. Full raw evidence and intervention records remain
outside the checkout under protected permissions. No secrets belong in this
record. The live verdict remains inconclusive and #18 remains incomplete.

### Continued live run, November 15

After the owner delegated continued test operation, retained native reports
identified the older refused turns as terminal. A scoped idle acknowledgement
at `15:58:50.280Z`, corroborated by broker idle status at `15:59:00.549Z`, cleared
that hold without resuming the cancelled inference or executing its client
tool. The original failure and acknowledgement records remain separate from
the fresh trials.

Fresh account-B readiness and tool trials completed at `16:11:36.325Z` and
`16:21:28.223Z`; both passed `inspectCase` at `16:54:37.135Z`. Account-A's fresh
readiness and tool trials completed at `16:53:16.361Z` and `17:04:29.760Z`;
both passed at `17:14:34.260Z`. Each fresh trial has an independently observed
two-minute quiet window, exact authenticated contexts and native wake/turn
linkage. These qualifications applied to the then-current connections.

All eight protocol cycles subsequently completed their client assertions and
request correlation. Each proposed the permitted client `read_file`, consumed
the exact CRLF-containing client result, returned the same accepted response
on an exact retry, and answered a later affinity marker on the same worker and
conversation. Each cycle executed its client tool once. The times below are
the client receipts' final affinity completions, in UTC:

| Protocol | Account A | Account B |
| --- | --- | --- |
| Chat JSON | `17:22:01.767Z` | `17:04:55.584Z` |
| Chat buffered SSE | `17:26:59.019Z` | `17:10:30.156Z` |
| Responses JSON | `17:30:00.123Z` | `17:14:15.717Z` |
| Responses buffered SSE | `17:35:47.301Z` | `17:18:35.125Z` |

Complete worker exports match all 24 unique model jobs to their exact client
histories, tool definitions and native wakes. Exact client retries created no
additional model job. Observations expose CLI command IDs and native hook
invocations, not hidden reasoning or a separate internal model-run identity.
No account-memory influence or wrong-environment client-tool execution was
observable in those receipts; a complete independent VM audit is unavailable.

Strict final validation additionally flags `b.chat.sse`, `b.responses.json`,
`a.chat.json`, `a.chat.sse` and `a.responses.json` as intervened: the operator
sent evidence-collection messages in the other account while their measured
windows were open. The validator conservatively treats those overlaps as
interventions. Their client assertions and exact native receipts remain valid
observations, but they do not qualify as unattended passes. Only `b.chat.json`,
`b.responses.sse` and `a.responses.sse` have uninterrupted measurement windows.
The gate was not relaxed; further unattended measurements need separate runs
after connection stability is restored, with operator messages outside all
measured windows. Original reports and every intervention remain retained.

| Verified export | Bytes | SHA-256 |
| --- | --- | --- |
| B fresh baseline | 512,555 | `6da7325370a9e02a5d57686a71a72d02d6b8be8c50bdffcd38fc0ef1d413adb1` |
| A fresh baseline | 695,616 | `9294fd73c4ff5b09abc65e29df4a153285c2fea5f04da8d434605565640a7462` |
| B protocol cycles | 1,926,095 | `e6bebbd4e75eb1c488ebf77b6c8ad9be4a0127813b418f333bde460da6d0f200` |
| A protocol cycles | 3,180,789 | `d702974ca282a8c09d147f8c1720053a62882a75e2933f804b5a2e6e6b1d466a` |

The final A cycle's first correlation export failed strict completeness because
the request-only query implicitly included already-pruned November 10 history.
Its November 15 data remained retained. The local correlator now bounds exports
using the authenticated service response's creation time. Strict re-reading
recovered the existing four HTTP receipts without submitting inference or
executing the client tool again. The failed export, report snapshot and
correction record remain preserved. Tests exercise actual capture retention for
both protocols, including rejection when current evidence is pruned.

The other local collector fixes retain large raw exports separately from
bounded exchange logs, fill previously unknown installed metadata without
changing established identity, and collect whole runs in contiguous five-minute
intervals. At `17:43:45.600Z`, all 97 tooling unit tests passed with raw statement
coverage `2,095 / 2,133`; the tested working-source digest was
`d2d3fb3b4742241a0b66465fd8a3dd12c18dec691784f6daa7b2e0d662a1b4f8`,
before this documentation update. File-size, CI-policy and whitespace checks
also passed. These are uncommitted local tooling fixes; the deployed service
and installed worker remain the verified rc.7 artifacts.

At `17:25:17.606924303Z`, the actual B CLI's attempt to read a completed A job
was rejected by the server with `404 worker_scope_denied`, request
`5cee6cedc20d85e85f401605d735201b`. No context was returned. Complete broker and
worker exports identify the authenticated B principal and targeted A job; the
cause was reconstructed through HTTPS and logs without business-table queries.
The worker export has 29 captures, 147,323 bytes, SHA-256
`1411b5c3a8a464d694fa247c90485e4413ac00a4022274f229b3cf2caa10f484`.

Portal login and both renames passed, preserving immutable IDs. The combined
browser's history check failed its five-second wait for `Conversation timeline`.
A separate read-only diagnosis subsequently rendered that request and timeline
with HTTP 200, no page errors and no alerts. An eight-request follow-up was
interrupted during navigation by the later service outage. A later read-only
audit rendered two actual request histories in 4,387 and 3,772 ms, with 41
timeline records each, before stalling; its session-owned headless browser was
stopped and the partial receipts retained. The initial browser failure remains
retained; full portal-history verification is still pending.

During the later interruption, three independent HTTPS reads completed TLS in
about 35 ms but received no HTTP response within 30 seconds. Health subsequently
returned 200 in 473 ms. The broker instance remained
`65e3b2ff5ec7ce996163e438bacc0f32`; this was not an observed broker restart.
Complete broker exports for `17:49–18:00Z` show cancelled database operations,
`transaction_outcome: not_started`, expired worker health replies and repeated
reconnections. A status snapshot at `17:57:20.029Z` showed both workers offline;
by `18:09:39.858Z` both were online and idle. The cause of the stall remains
unresolved, and health alone does not establish inference readiness.

The A diagnostic transfer illustrates why timeout is uncertain: the native CLI
reported a connectivity failure, but the complete broker export proves its
decision committed at `17:52:45.041838205Z`, request
`24b649680f12b786ddf26bc6c76dd374`. The original artifact was reconstructed
from that accepted decision and verified against its earlier size/digest,
including all 702 captures. No replacement administrative job, inference replay
or repeated client-tool execution was needed. Diagnostic byte transfers remain
excluded from model qualification.

Both workers' current connections require new qualification after the
reconnections. Fresh observed quiet windows began at `18:12:04.534Z` for A and
`18:12:05.431Z` for B. The resulting readiness trials were interrupted:

| Account | Experiment | Observed interruption |
| --- | --- | --- |
| A | `5b3193b03adcc69f26e0589f0c8159fc` | `18:14:39.174Z`, `worker_disconnected`, remote outcome `unknown` |
| B | `9992552039d8968510d9c7967821ff54` | `18:14:43.609Z`, `worker_disconnected`, remote outcome `unknown` |

No client tool ran in either readiness trial. New model submissions stopped;
no idle acknowledgement, state deletion, hook disabling or reinstallation was
used to clear their uncertain outcomes. The disconnect cause must be diagnosed
and the resulting connections independently qualified before dependent work.
Interleaving, confirmed broker/worker recovery, replacement, remaining adverse
boundaries and final revocation have not passed.
The runtime inquiry and visible Settings controls exposed no named supported
non-destructive VM refresh action; no refresh was performed or inferred from
browser reload or a spontaneous replacement. Full qualification remains
inconclusive and #18 remains incomplete.

The final checkpoint at `18:24:16.255Z` reimported the protected broker/worker
exports and validated the report with no schema or export errors. Its verdict
is `inconclusive`, including the five intervened cycles and missing live cases.
Independent `validate-report --require-complete` correctly exited 1. Markdown
fences, 25 local documentation links, whitespace and the diff's local-secret
scan passed. No full live pass, publication or deployment follows from these
partial receipts.

### Local diagnostics contention investigation

The owner subsequently reported that the container-local
`http://127.0.0.1:8080/healthz` check also failed. Public health later returned
200 again, taking 348 ms in the read-only observation. A server resource snapshot
showed 2.35% service CPU and 377.6 MiB memory against 15.48 GiB available, with
cumulative block I/O of 452 MB read and 1.66 GB written. This snapshot does not
measure storage latency during a stall or establish its root cause.

At source `f5b823bbef23476209064cf06fc9780abc0efc1d`, diagnostics exports held
the capture-store mutex while reading and validating every retained capture.
Request logging uses that same mutex synchronously, including the admission of
health checks and worker traffic. A local reproduction using the actual HTTP
handler, logger, store and OS files held one capture read open: health could not
finish during the hold and completed after release, taking 530 ms over the
deliberate 500 ms hold. A separate 10,000-capture fixture confirmed that a
single-request export read all 10,000 files. These are controlled reproductions,
not a captured stack trace from the remote stall.

The capacity fixture wrote a 176,326-character payload into a full retained
store. The original code removed 143 captures and performed 144 durable writes,
because each deletion rewrote and synced retention metadata. With a deliberate
1 ms delay per durable write, that operation took 755 ms locally. The local
repair retained the same 143 deletions with two durable writes and took 23.5 ms
in the repeated fixture. These measurements demonstrate write amplification;
they do not predict remote inference latency.

The repair keeps capture-file reads and chunk/digest verification outside the
store mutex after freezing the export's entries and metadata. A file removed
during that interval makes the export explicitly incomplete. Each pruning batch
persists its full conservative watermark before any deletion, so interruption
cannot report lost evidence as complete. Capture writes, directory enumeration,
redaction, required durability and fail-closed I/O errors remain in place. Slow
storage can still delay synchronous writes; the full live outage is unresolved.

Three regressions failed before the repair: blocked health, repeated durable
metadata writes, and a missing whole-batch watermark on interrupted deletion.
All now pass, alongside a concurrent-pruning test that verifies honest export
omissions. At `2026-11-15T18:48:53.617Z`, all six unit components passed with
strictly more than 90% raw statement coverage: service `4,339 / 4,571`, worker
`1,358 / 1,364`, portal `1,006 / 1,038`, CI helpers `665 / 691`, tools
`2,095 / 2,133`, and worker build scripts `89 / 89`. The tested working-source
digest was `0232dc34d89eafd38b1be28030a6e1d6e8a164b9fc46b35ae8cdec17909625d5`,
before this documentation update. Go formatting/vet/build, file-size and CI
policy checks passed. Real service/PostgreSQL and broker-recovery regressions
also passed and verified cleanup of their owned resources, using local image
`sha256:26bcd8e7096db47f0e9e9f2de7342357b4eb69b8b25c1f2fa301990a36a43565`
and the existing direct-container-network option.

The packed-worker transport suite also passed against that image, including
the retained rc.6 archive, more than 31 seconds of same-connection health,
receipt replay above 2 MiB, generation fencing, reconnect, revocation and
protected state. Its current development archive SHA-256 was
`789f8f564fe86dcd4c179c6b3dc6b45c8bd8da64d892a9af1865b6e4bb24de26`;
cleanup verified removal of 90 owned containers, two volumes and one network.
These controlled results do not qualify live Muse.

No live model job was submitted during this investigation. Both unknown native
outcomes and all prior evidence remain retained. The repair needs current-head
review/checks and an owner-deployed replacement before it can be evaluated
against the remote stall; full live qualification and #18 remain incomplete.
