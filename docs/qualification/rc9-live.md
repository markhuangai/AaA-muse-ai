# Live rc.9 qualification


[PR #46](https://github.com/markhuangai/AaA-muse-ai/pull/46) merged as
`ca3cd57c38acf837b0a4ce3e0e6db8b5f1f808f8` after its required current-head
checks and reviews passed. Main
[CI](https://github.com/markhuangai/AaA-muse-ai/actions/runs/43775088896),
[CodeQL](https://github.com/markhuangai/AaA-muse-ai/actions/runs/43775088895)
and [paired publication](https://github.com/markhuangai/AaA-muse-ai/actions/runs/43775696144)
passed. The public archive and GitHub Packages bytes, source tag, GHCR
manifests/configuration and OCI identities were independently verified for
[rc.9](https://github.com/markhuangai/AaA-muse-ai/releases/tag/v0.1.0-rc.9).
The owner supplied the matching deployed identifiers:

```text
ghcr.io/markhuangai/aaa-muse-ai@sha256:afcd5bc2e0bf4cc4bc9edbcd28c22c84c1d3233cee4f0083e95bce288c3aa685
sha256:2dac62fb6495a2b62f3b81d5b4ce20cb1ce4ed9ee18efc5ea6d63ee2aedf914a
```

Authenticated HTTPS preflight at `2026-11-16T00:03:46.001Z` confirmed that
clean source, rc.9, PostgreSQL readiness and service process
`d288b7ff21ddf94b5ef8367eaebe48d2`. The image's paired worker archive
SHA-256 is
`a114a7780682dae85ae73ff5274e219cea730d8de367f20e48c4959ec26d570a`;
its installer SHA-256 is
`64b47838e35c8d252548a981b5aaf3df4e303d3216931066020a6e37db7b5f6e`.
Both actual installations remain rc.7 with their original identities and
archive SHA-256 `76cfaa6944a5dd72d5e08988e545509c156d83b78a3d13cbf05d2abf1494ba0a`; no automatic upgrade or re-enrollment occurred.

B's real client probe ran at `00:07:21.709Z`–`00:08:01.806Z`, following an
observed quiet window starting `00:05:18.783Z`. Request
`bedbf2c93508d4d84b1d1892b406db93`, operation
`0a5dc33e334c512850c1fd8a755a2672`, job
`ec34e0071ca5a4bd13530a727504dbb5`, completed the exact unpredictable
challenge on connection generation 21. The original approval
`925759177884a4ecceb46259428ac025`, created at
`2026-11-15T21:18:18.544757Z` with generation-18 evidence, and its complete
history remained unchanged. No management approval was submitted. This is
actual post-reconnect client processing, unlike the retained rc.8
`503 no_ready_worker` result. It does not substitute for formal restart or
supported-refresh qualification.

Worker captures show B's `UND_ERR_SOCKET` stream retry at `00:01:33.512Z`,
reconciliation at `00:01:43.633Z` and authenticated connection generation 21
at `00:01:45.241Z`, retaining the same subscriber instance. The originating
socket-close cause remains unavailable. A reconnected as generation 19 at
`00:01:45.001Z`; its deliberate withdrawal remained effective. Native
read-only inspection reported one subscriber per installation, retained
five-second hooks, private state directories and protected credential files.

| B protocol case | Affinity completion (UTC, November 16) | Client tool executions |
| --- | --- | --- |
| `b.chat.json` | `00:16:05.563Z` | 1 |
| `b.chat.sse` | `00:23:01.683Z` | 1 |
| `b.responses.json` | `00:29:20.643Z` | 1 |
| `b.responses.sse` | `00:36:03.213Z` | 1 |

All twelve protocol jobs and the separate resume probe match authenticated
full canonical contexts, exact accepted decisions, independent hook wakes,
native conversation/invocation reports and CLI command IDs. Each protocol
cycle retained its conversation/worker across affinity and resolved an exact
retry to the accepted operation. Passive observations cover both accounts,
with no operator message during any measured quiet/trial window. SSE remains
buffered delivery. The raw captures contain four structured tool proposals;
the native summary's count of three was inaccurate. No account-memory
influence or VM-side fixture read was observable; hidden native context and
an independent full memory audit remain unavailable.

Portal password login, both current embedded setup prompts, renaming with
immutable identities, four current-source request histories and empty browser
credential storage passed. The generated prompts were never installed.
Client A's attempt to continue B's owned Responses reference returned
`404 history_owner_denied`, request `202b005c674eebcc637e792ff64ac568`.

B's installed CLI then attempted one read of A's completed diagnostic job
`5d5e310578480fd73a289971b15eb02e`. It exited 1 with empty stdout and
`404 worker_scope_denied`. Request `58e6d457e944bc6b3e0ee7508eb4f455`
joins two worker captures to seven broker captures: authentication as B,
A's job/operation ownership, scope rejection and the denied HTTP response.
This passed cross-worker rejection and diagnosis from logs alone without
business-table queries. It is separate from inference and stale-result fencing.

| Verified native export | Bytes | Captures | SHA-256 |
| --- | --- | --- | --- |
| B reconnect, probe and cycles | 5,371,262 | 815 | `368b903c023f2a9821a15be0782b9d66cc7a4ed3d42a58552ed0d804890d4cf9` |
| A retained state | 3,705,613 | 485 | `1fedba387889062547cbddeb919ceba6585149176fb68a9f02e6a8f576a3878e` |
| B cross-worker rejection | 3,722 | 2 | `5fddbdc5b3be8bdd135fc32787dbcf79eba7769de7a26c77188851331410d75f` |

Original byte lengths/digests, canonical transfer encoding, every payload
chunk/envelope and decoded-value redaction were verified locally. Fixed-file
administrative transfers occurred after the measured windows and are excluded
from qualification. Earlier reports and failed attempts remain unchanged.
The protected current run is `e3371e9a-eefb-4331-8400-826e28fba1cd`.

Local collector preparation first rejected an image URI where the schema
requires only its digest, before submitting work. A missing quiet-observation
timestamp then stopped the next initialization; it was repaired from the
already retained request timestamp and continuous passive evidence. Two later
quiet windows stopped on visible native activity before submitting their
Responses case. Those interruptions remain retained; the private runner now
requires thirty settled seconds before its unchanged two-minute quiet gate.
Completed or submitted cases were never replayed to repair collector metadata.

A received no new inference trial in this rc.9 continuation. Supported native
inspection still exposed neither an exact refusal notice/code nor a pending
permission card, and found no supported non-destructive VM/runtime refresh
action. No safety check was bypassed or reset invented. A's tool failure,
the two-account matrix, formal broker/worker recovery, supported refresh,
replacement/adverse cases and final revocation remain incomplete. B's retained
approval and current successful work do not turn those missing cases into
passes; issue #18 and full qualification remain inconclusive.

The pre-checkpoint report finalized at `2026-11-16T00:50:15.689Z` with thirteen
of thirty-five required live cases passed and twenty-two missing. Independent
`validate-report` exited 0, with no schema/export errors or B protocol/native
gaps; `--require-complete` correctly exited 1. All current worker exports and
the failed rc.8 probe remain retained separately. A new B tool-wait cycle is
prepared separately for the owner-performed service restart; these baseline
passes do not establish that still-pending recovery case.

The B checkpoint was ready at `00:54:52.501Z`: request
`d93f8c4ab696b4316cac33c4f8171fd5`, operation
`c2c10a6540659941f8826dcf1a808238`, job
`5554503a687abbf2dc8210d32da2c7f3`, accepted call `client-call-1` on
connection generation 21. Its client tool has executed zero times, and both
workers' full approval histories are unchanged. The finalized baseline report
is preserved separately from the in-progress recovery cycle. The owner-performed
service restart and its subsequent validation are recorded below.

## Broker restart and client-tool continuation

The owner reported `docker compose restart service` at
`2026-11-16T01:03:19Z` and confirmed completion. Authenticated HTTPS showed
new ready broker `f22942653b55d07b2006c1674e45fcd8`, with the same build.
Its `recovery.restored` at `01:03:28.012260334Z` identifies the exact original
operation, job, conversation, pinned B worker and pending `client-call-1`.
Both workers' complete approval histories remained unchanged; B was already
online and verified before continuation, with no new approval.

Continuation began at `01:05:16.114Z` and its result/retry checks completed at
`01:06:36.131Z`. Operation `319541ca8cad45f0dbab1c4e25bb0b17`, job
`55539da187be7eb1412ae5a65302ed01`, used B's recovered connection generation
22, ID `30246d33b509bbb1362369ccc4533509`. The client executed its original
fixture tool once. Its exact retry reused that completed operation and output,
without a second model job or client execution. Session, conversation, worker,
accepted call ID and canonical full history remained linked.

The worker export has 1,765,319 original bytes, 242 verified captures and SHA-256
`42919a36e1e778b50b17a4b8c811362e83c43c22d6e0d66e2ecb33a3a61b68bb`.
Both native jobs match exact contexts, decisions, CLI command IDs and separate
native invocation reports. Passive observation covers both accounts throughout
the quiet period, pending-tool wait and continuation: 773 samples per account,
maximum gap 4,407 ms, with zero overlapping operator messages. Native inspection
reported the same subscriber process across the broker restart, retained hook,
protected credential metadata and no reinstall or enrollment.

Strict validation initially rejected the collector's status receipts. Local
report redaction collapsed the already-redacted public client-key map, while
broker captures retained its named entries. The matching before-status capture
also completed after the local preparation timestamp; the resume helper's
later status capture completed after its local continuation timestamp. These
are receipt/ordering limitations, not failed client inference. Their underlying
timing cause was not established.

Original reports remain retained. A private evidence normalizer binds the
snapshots to exact authenticated response bytes with already-redacted values.
It retains original local preparation `00:54:52.501Z` and uses conservative
capture-completion bound `00:54:54.366Z`, still before the owner action. The
after-status snapshot comes from the existing read-only pre-continuation check,
request `61e20df5da5d47f197857505af05d7a5`. No timestamped action, capture,
validation rule, model request or client execution was invented or replayed.
The unchanged validator then passed broker restoration, native/context linkage
and deduplication. Independent report validation exited 0, with fifteen of
thirty-five required cases passed, twenty missing and no schema/export errors.

## Worker restart precondition changed

The scoped B restart control at `01:35:43.230Z` used an exact connection/PID
guard and stopped before signalling: the retained generation was already 23,
ID `5cb11bbd4be8863ddeac57fa4808bfec`, subscriber PID 1726 instead of 1695.
The native receipt reports no restart intent file, no signal and no manual
subscriber/hook launch. Its existing enabled five-second hook was verified.
This spontaneous restart is separate from the owner-performed broker restart
and the still-unexecuted controlled worker-restart case. A separately identified
client probe tests generation 23 before any new approval; no prior case is rerun.

## Terminal worker diagnostics stop

The generation-23 probe began at `01:40:31.041Z`. Its first operation
`b93599581c6765a84d594f6c0c5f66fb`, job
`97d2a6b8198983099cfd29f4209a4add`, returned the exact structured tool call.
The client executed its fixture tool once. Continuation
`425b7a03312141d5ffa5866871c3dc8a`, job
`00d72d3b6391b7b13a14c64f68435938`, returned the exact result at
`01:42:36.673Z`; its exact retry completed at `01:42:39.854Z`, reusing that
operation and job. Both assignments used connection generation 23. Approval
and its complete history remained unchanged. The client receipts passed;
complete native export validation is still pending and this spontaneous event
does not establish the controlled worker-restart case.

The second control message at `01:43:56.491Z` first requested inspection of the
earlier spontaneous restart and retained the same guarded SIGTERM test against
the verified generation-23 baseline. Native inspection reports generation 22
logging `UND_ERR_SOCKET` and stopping, followed by exclusive subscriber PID 1726
at `01:33:13.887Z` and connection generation 23 at `01:33:17.555Z`.
The initiating close/signal cause remains unavailable; the socket code alone
does not identify it.

During that second control, Muse reports a diagnostic export starting at
`01:43:58Z`, then `worker.capture_failed` with `state_lock_timeout` at
`01:44:14.987Z`. It reports terminal `run-stop.json` with cause
`diagnostics_unavailable`, PID 1726 and time `01:44:25.003Z`, followed by failed
hook recovery checks. The control's daemon-lock guard then failed before any
signal or restart intent. The exact terminal-error line and marker were subsequently retrieved through
direct read-only file access. Their original 154/105 bytes and SHA-256
commitments verified locally; B stayed stopped. These native artifacts remain
distinct from the independently authenticated broker observations.

HTTPS subsequently confirmed B offline with no current job, retained approval
and unknown work status. Both probe operations and assignments are completed/
accepted in broker receipts. Muse's claim that the continuation was still
awaiting a decision was stale and is explicitly rejected by those receipts.
No new model job, idle acknowledgement, marker deletion, manual subscriber
launch, hook change, reinstall or enrollment followed the terminal report.

The published rc.7 and worker diagnostic source before this repair both hold the capture
lock across retention, enumeration, every payload read and verification.
Logging waits ten seconds for that lock; its failure is nonretryable and a
background subscriber records a terminal stop. A local test with real private
files and the production subscriber reproduced `diagnostics_unavailable`
while export was deliberately paused. A second test proved concurrent
retention also waited for that read. Both failed before the repair.

The repair freezes retention metadata and filenames while holding the lock,
then reads/verifies only those names outside it. Concurrently removed files
produce `capture_removed_during_export` omissions; later captures never enter
the frozen snapshot. Redaction, chunk/payload validation, protected modes and
fail-closed handling of genuine storage errors remain required. All six
focused diagnostic tests pass, including the real-subscriber regression and
concurrent pruning. Broad local coverage and integration checks also passed,
as recorded below.
The remote failure's reported timing matches this reproduced mechanism; the
earlier spontaneous process exits remain unexplained. B stays stopped with
its terminal evidence preserved until reviewed repair and explicit operator
recovery; these local checks do not qualify live worker recovery or #18.

The retained transition export was copied to a new protected evidence file
and downloaded through Muse's private workspace attachment. Its original
1,698,241 bytes, SHA-256
`2c238a7716a67ab73839d9bce930aae1113dbf234040777413b0a2e27eaf8840`,
172 complete captures and decoded redaction verified locally. It corroborates
the generation-22 stop and generation-23 exclusive subscriber startup. It does
not contain the later probe's full native context/decision evidence, which
remains missing. No stopped worker was started to transport this artifact.

## Local worker-export repair validation

Validation completed by `2026-11-16T02:11:07Z`, against base
`ca3cd57c38acf837b0a4ce3e0e6db8b5f1f808f8` and working-source digest
`171b001cbe2104c7456367bca8c2d01734ba09bb7c3a710e34fdb4d77701a917`,
before these final validation-record edits. The local combined image manifest
digest was
`sha256:0bdf29e538bdfe0e21347a886402d5c98b465739f2a3ddb1ce74ed1f8f4c9942`.
Its paired development worker archive SHA-256 was
`78dfab9f8ed44e5954ffbae5e57ee0d4ab6a99a2737f32de8e92d21011ebe6af`.
No release or live installation was changed by these local checks.

| Unit component | Covered / total statements |
| --- | --- |
| Service | 4,338 / 4,569 |
| Worker | 1,361 / 1,367 |
| Portal | 1,006 / 1,038 |
| CI helpers | 665 / 691 |
| Qualification/build tools | 2,105 / 2,143 |
| Worker build scripts | 89 / 89 |

Both regression tests failed before the repair and all six focused diagnostics
tests passed afterward. Every unit component separately exceeded 90% using
raw counts and the same working-source identity. TypeScript, file-size and
CI-policy checks passed. The combined product flow passed 32 cases in
134,464 ms; the adverse Chat/Responses shard passed in 234,520 ms. Both passed
aggregate source/artifact/case validation. Standalone packed-worker recovery
also passed, preserving identity, uncertain holds and revoked terminal stops.
The harnesses verified cleanup of their owned containers, volumes and networks.

Controlled success does not qualify live Muse. The owner approved committing
the repair, opening a PR and running its review loop; configured AI review, hosted CI and
CodeQL remain required before merge/publication. B's active terminal marker,
credentials, identity and journals remain intact. A reviewed release and
explicit operator handling of B's terminal stop must precede dependent live
worker-recovery and remaining issue #18 cases.
