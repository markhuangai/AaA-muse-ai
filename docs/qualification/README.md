# Muse PoC qualification procedure

For issue #18's combined software runner, two-account protocol matrix and owner
restart checkpoints, see [product qualification](product.md). Historical PoC
reports remain schema one; product reports use schema two.

This tooling prepares issue [#7](https://github.com/markhuangai/AaA-muse-ai/issues/7).
The preparation PR uses `Refs #7`; it does not close the investigation. No live
Muse qualification report is shipped. Synthetic fixtures prove software behavior
only. A passing live report, not this CI job, gates release work.

## Before live collection

Wait for human merge of the tooling PR and owner authorization of the live run.
The owner deploys an exact published image behind their HTTPS reverse proxy,
verifies its embedded paired worker metadata, and supplies a management
header file containing `Authorization: Bearer <key>`. Keep that file in a `0700`
directory with mode `0600`, outside this checkout. Never paste its contents into
chat, a shell command, a URL, or a report. No registry or durable worker key is
needed by the client driver.

Allow at least 330 seconds for inference responses in the reverse proxy. The
service image owns the installer version/digest; operator YAML has no package
pin. An installed worker can have another compatible version. Record its actual
CLI version and verified archive digest independently of the image's installer
recommendation; connection health or an absent legacy version header proves
neither exact installed version nor live readiness.

Keep `limits.in-flight-per-worker` at 1 so the worker runs one inference at a time.
Two sessions can wait for client tools concurrently. When testing a release that still
reports a global job cap, set its cap to at least two. Use one reserved account without unrelated messages,
browser input, or scheduled work during measured windows. Provide a working
authenticated browser/VNC session for setup and passive observation. Browser
automation is not the inference transport.

Generate the existing management setup prompt, install the pinned T05 package,
and approve actual permission cards. Verify runtime, protected state/key-file
modes, one enabled five-second hook, and exactly one subscriber. End the setup
turn before queuing the readiness challenge. The observer records the boundary;
the driver never installs, refreshes, submits worker decisions, or acknowledges
native inference as stopped.

Build the existing helpers locally, after the preparation's conformant audit:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build --workspace worker
node --test tools/qualification.test.mjs
```

## Private observation input

Use one protected JSON file with `schema_version: 1`, an `entries` array, and a
`worker_exports` array. Keep it and the evidence directory outside the checkout.
Every observation has `kind`, an observed UTC `time`, `observer`, and `source_ref`
pointing to an actual passive recording, screenshot, permission card, or exported
tool observation. A checked box or invented source reference is not live proof.
Do not include credentials, cookies, setup-prompt codes, unrelated conversations,
or secret-bearing screenshots. Retain redacted observations with their provenance.

Required entries use these additional fields:

| Kind | Fields and meaning |
| --- | --- |
| `artifact_identity` | `service_sha`, immutable `image_digest`; independently inspect the deployed image. The authenticated service status must identify the same clean source. |
| `setup_ended` | `worker_id`, `hook_id`, `consumer_count: 1`, `interval_seconds: 5`, `state_mode: "0700"`, `key_file_mode: "0600"`, nonempty `actual_permissions`; `time` is the end of setup. New collections also require `worker_version` from the actual installed CLI and `worker_sha256` from verified installed-archive provenance, including when using a legacy service. Retain that evidence with runtime and registration observations. These fields identify the installation, not the service's recommended package. |
| `quiet_window` | `case_id`, `started_at`, `ended_at`, `exclusive: true`; observe at least 120 seconds ending at the case's `started_at`. Use actual collector timestamps and passive observation, not retrospective assumptions. |
| `model_turn` | `case_id`, `job_id`, observed `native_conversation_id` or the background execution proof below, `effective_instructions` as canonical system/developer items (including a delta's inherited base), and nonempty `account_memory_observation`. State what was observable; do not claim private reasoning or hidden instructions. |
| `no_model_turn` | `case_id`, `job_id`, `started_at`, `ended_at`, `last_boundary`; continuous passive coverage of the complete failed turn, matching its recorded boundaries. Retain detector and worker exports even if no native turn occurs. |
| `intervention` | The exact activity, actor, scope and time, including messages, clicks, approvals or manual worker commands. Entries invalidate overlapping quiet/trial windows. Do not erase them for a pass. |
| `fresh_conversation` | Observed `native_conversation_id`; create the fresh native conversation after the `full` case and before replay. A new broker experiment ID alone is insufficient. |
| `refresh_approval` | `owner: true`, exact supported `scope`, `destructive: false`; the owner's explicit approval precedes the action. |
| `refresh_performed` | The same `scope` and actual action time; no reset, wipe, reinstall, re-enrollment, or manual message. |
| `refresh_reconnected` | Retained `worker_id`, `hook_id`, `consumer_count: 1`, protected modes, `reinstalled: false`, `reenrolled: false`, `manual_message: false`; observe automatic recovery before the refresh probe. |

A native background agent can have no conversation. Record
`native_conversation_id: null`, its actual `native_invocation_id`, `worker_id`,
`context_command_id` and `decision_command_id`, plus `native_execution`:

```json
{
  "kind": "background_agent",
  "run_id": "event-hook:<actual-invocation-uuid>",
  "agent_id": "<actual-agent-uuid>",
  "status": "completed_notified",
  "agent_status": "shutdown",
  "session_id": null,
  "source_ref": "/private/native-execution-records.json",
  "commands": ["<job-show receipt object>", "<decision-submit receipt object>"]
}
```

Each command receipt contains `action`, `agent_id`, `job_id`, the captured worker
`command_id`, native `call_id`, positive distinct `tool_call_item_id` and
`tool_output_item_id`, and the observed booleans `call_names_job_id`,
`output_success` and `worker_command_id_matches_captured`, all true. These values
must come from actual native tool-call/output joins, linked to the deciding
agent, not inferred from the wake text or broker state. Worker exports must
contain the matching context read, complete decision input equal to the broker's
accepted decision, and accepted worker receipt.
Keep the raw operational source records; do not read private reasoning to build
these receipts. A hook's delivery thread is not its deciding conversation.

Observed terminal run values are `completed_notified` and `completed_noop`;
observed finished agent values are `shutdown` and `completed`. Retain the actual
values. Native notification outcomes do not establish a worker decision without
the complete command/capture chain. The exposed native schema does not enumerate
these lifecycle values; these accepted values come from retained operational
observations, not a claim about every possible Muse lifecycle state.

This proof establishes the background turn only. Delta-base continuity and
fresh-conversation replay still require observed real conversation IDs.
Historical reports remain unchanged. Validation checks recorded links and does
not authenticate the observer's claims or provide native Muse attestation.

`worker_exports` contains `{ "case_id": "all", "path": "/absolute/private/export.ndjson" }`
or one export per case. Export through the installed CLI's existing protected
capture, using `diagnostics-export` **without** `--decode`; retain the metadata
and reconstructable chunks. Do not send a manual Muse message to export during
a measured window. Collect afterward through authorized access; record any
intervention and begin a new quiet period before another trial.

Previously recorded interventions remain in the report across imports and
restarts, even if they are removed from the observation input file.

The collector cannot authenticate an observer's honesty or inspect hidden Muse
state. An operator must verify the referenced observations. Report validation
checks linked recorded evidence and refuses missing evidence; it is not native
Muse attestation.

## Collect in stages

Set `ORIGIN`, `WORKER_ID`, `ADMIN_HEADER_FILE`, `EVIDENCE_DIR`, and `OBSERVATIONS`
to nonsecret origin/IDs or absolute private paths. The evidence directory must
be `0700`; its files are `0600`. The header's value must not be an environment
variable. Run from the merged checkout:

```sh
node tools/qualify.mjs collect --suite poc \
  --origin "$ORIGIN" --worker-id "$WORKER_ID" \
  --admin-header-file "$ADMIN_HEADER_FILE" --evidence-dir "$EVIDENCE_DIR" \
  --observations "$OBSERVATIONS" --stage baseline
```

The baseline requires an independent readiness challenge, three tool trials,
full-history continuation, a correlated delta candidate, and interleaved A/B
sessions. Every case waits at least 120 seconds; the observer must also establish
absence of manual input throughout each measured turn. Each turn has a local
five-minute deadline. Tool experiments have a longer broker lifetime to permit
interleaved client-tool waits; the driver enforces the per-turn limit and fences
an overdue experiment without claiming native inference stopped.

Each fixture is created after setup only in private client storage. Muse sees
its logical name, never its random contents until it requests the supplied
`read_file` and the driver posts the linked result. Final JSON must contain
exactly `session` and `value`, with the expected session marker and exact file
contents including newlines. No shell command or arbitrary path executes.
Interleaving runs A to tool wait, B to tool wait, A to final, then B to final.

After baseline, record a genuinely fresh native conversation outside measured
windows, update observations, then repeat the command with `--stage replay`.
Replay delivers the complete canonical `full` history with preserved tool IDs
and requests its exact final value without re-executing the tool.

After replay, inspect the supported refresh action and obtain explicit owner
approval of its exact scope. Perform it outside trial windows. Observe installed
hook recovery, retained identity/state/task, exactly one consumer and no manual
message. Add observations, then run `--stage refresh` for a new unattended tool
probe. Unsupported or unavailable refresh evidence makes that case inconclusive;
never substitute a browser reload for an unobserved runtime-recovery claim.

The default `--stage all` attempts these stages in order and stops when a required
native gate is unavailable. Update passive observation/export inputs and use
`--stage finalize` to reassess without queuing work. Completed or failed cases
are never rerun in the same directory. If a broker export failed after the case
outcome was saved, finalization resumes that read-only export and context import
while preserving the original trial timestamps. A crash with uncertain side effects
requires evidence review and a new run; the driver refuses automatic replay.
Accepted client tools are never re-executed. Preserve the old directory.

If independent readiness fails, use `--stage readiness-repeat` only for one new
challenge after another observed quiet period and confirmed idle worker state.
This is a separate experiment with a new challenge and identity, not a replay of
the failed assignment. Keep complete observations and exports for both attempts.
An unresolved held assignment blocks this reproduction; never acknowledge it as
stopped merely to continue. Two complete observed failures may conclude failure
without inventing results for downstream cases that could not run.

## Inspect and validate

```sh
node tools/qualify.mjs diagnostics --evidence-dir "$EVIDENCE_DIR"
node tools/qualify.mjs validate-report --report "$EVIDENCE_DIR/report.json"
```

`report.json` holds exact admitted requests, fixtures, canonical outcomes, turn
timings, source receipts, intervention/observation ledger and export digests.
Adjacent NDJSON exports contain complete redacted broker and worker evidence.
Validation reopens those exports and verifies their metadata, chunk bounds,
ordering, envelope and payload digests before using their contents.

Collector exit codes are `0` for pass, `1` for failure/invalid input, and `2` for
inconclusive. `validate-report` exits `0` for a structurally valid, truthfully
labelled report, including an inconclusive one; inspect its verdict separately.
It rejects a nominal pass unsupported by the evidence. Missing access is not a
conclusive failure. Two complete observations of the same required failure
boundary can establish reproducible failure; an isolated failure remains
inconclusive. A failed delta candidate may be explicitly rejected while full
history passes. A missing delta experiment still leaves the investigation
incomplete. Synthetic reports always have qualification verdict `inconclusive`,
even when their software `observed_result` exercises the passing branch.

Qualification uses the worker's existing logger/capture implementation: INFO
operational JSON on stderr and protected DEBUG detail always captured. Retention
is seven days or 128 MiB, records at most 6 KiB. Export promptly; omissions,
corruption or expired evidence are explicit and cannot qualify a pass. Keep
exports and failed runs as investigation evidence, outside disposable cleanup.

| Failure | Event / level | Log-only diagnosis |
| --- | --- | --- |
| No native result by deadline | `qualification.wake_failed`, WARN | Join case/operation/conversation/worker IDs, elapsed time and last observed boundary. Distinguish `setup.wake_emitted`, `worker.context`, authenticated decision submission, broker `decision.accepted`, and final answer. Silence does not identify an internal Muse cause. |
| Wrong tool or result | `qualification.decision_failed`, WARN | Inspect proposed decision, issued client-only path, exact result and call ID in protected exchanges; do not execute a guessed command. |
| Missing observation/export | `qualification.evidence_incomplete`, ERROR | Read named missing receipts and omissions; obtain authorized evidence or retain an inconclusive outcome. |

Broker exports use `GET /api/v1/admin/diagnostics/export?operation_id=EXPERIMENT_ID&since=CREATED_AT`
with the protected management header and the broker's recorded experiment creation
time. Unrelated older pruning does not invalidate current evidence; pruning within
the measured interval still makes the capture incomplete. Worker exports use the existing installed
CLI. Check completeness before filtering by operation/request/conversation/job
IDs. No business-table queries or runtime-memory inspection are needed.

Publish only reviewed redacted observations and receipts. Do not automatically
upload this private directory. Keep source revisions, UTC times, actual refresh
scope, failures, interventions, full/delta decision and limitations in the final
report. A conclusive failure describes this tested mechanism; it does not prove
all Muse integrations impossible. Inconclusive reports leave issue #7 open;
only a live pass permits release work.


The live replacement collector accepts the production offline projection only
with `work_status: unknown`, explicit null current assignment and zero client-tool
waits. The replacement must already be online, idle and verified with no pending
work. An offline worker is never relabeled idle. Correlation queries only the
new continuation; retained original turns remain immutable when older diagnostic
captures have expired. The complete replayed messages and tools must match the
client transcript, including the already accepted tool result. Neither this
collector correction nor a controlled pass qualifies live replacement.
