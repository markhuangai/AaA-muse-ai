# Muse worker CLI

The worker receives broker assignments and carries structured decisions. It answers transport-health challenges; it never invents a model answer, answers an inference-readiness challenge automatically, or executes client tools. Issue #6 supplies installation and candidate hook/recovery assets; live Muse qualification belongs to issue #7.

Build with Node 24.22.2 and TypeScript 7.0.2. Compiled JavaScript targets Node 22.12.0 or newer on a POSIX filesystem. The actual Muse runtime remains unverified. The package is `@markhuangai/aaa-muse-worker`, version `0.1.0-dev.0`; development builds keep this version. Post-merge issue #6 publication stamps matching package/CLI versions as `0.1.0-rc.N`; no worker publication is qualified before its live workflow receipt.

From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build --workspace worker
npm run check --workspace worker
npm test --workspace worker
make worker-package
make test-worker-transport
make test-worker-setup
```

The last check requires Docker, Python 3, and OpenSSL. It runs the packed CLI in pinned Node containers through a private trusted TLS fixture to the real Go/PostgreSQL broker. Decisions are supplied by the test driver. Its client fixture is absent from worker containers. These are software checks, not Muse inference evidence.

## Commands

Invoke `node worker/dist/main.js` from a source build, or `aaa-muse-worker` from an installed package. Every command accepts `--state-dir /absolute/path`, `--help`, and `--version`. The default is `$XDG_STATE_HOME/aaa-muse-worker`, or `$HOME/.local/state/aaa-muse-worker` when XDG state is unset.

| Command | Behavior |
| --- | --- |
| `setup --origin HTTPS_ORIGIN --code-stdin --install-dir ABSOLUTE_PATH --setup-id ID` | Verified installer entry: preserve enrollment, install scoped assets and start one subscriber |
| `hook-check` | Internal managed-hook check and guarded recovery; never a model answer |
| `configure --origin https://muse.example.com` | Save an HTTPS origin, with no credentials, path, query, or fragment |
| `enroll --code-stdin` | Read the single-use code from stdin; save the returned worker key without printing it |
| `run` | Hold one authenticated SSE subscription, answer health challenges, claim jobs, and publish cues |
| `status` / `doctor` | Read authenticated status; doctor also reports verified local permissions and explicit unverified Muse capabilities |
| `job-show --job-id ID` | Fetch that worker's immutable context and identity/receipt metadata |
| `decision-submit --job-id ID --input FILE` | Submit one strict JSON decision; `--input -` reads stdin |
| `decision-submit --job-id ID --ack-idle` | Explicitly confirm that this cancelled/interrupted assignment finished or stopped |
| `diagnostics-export` | Export protected logs with completeness metadata and verified chunks; `--decode` reconstructs events |

Pass bootstrap authority through stdin from an approved private input source. Do not put credentials in command arguments, URLs, prompts, hook bodies, or logs. Configuration rejects a changed origin once enrolled; use a separate state directory for a different origin. Repeating enrollment preserves a healthy identity. Revocation never triggers automatic re-enrollment.

An enrollment response can be lost after its single-use code is consumed. A pending enrollment record without a saved key is an explicit uncertain outcome. Use management records/request IDs to find and revoke any orphaned identity before starting a new enrollment with a fresh code and separate state directory. The CLI does not recover plaintext credentials or silently redeem again.

## Context and decisions

`pending.json` contains protocol version, worker/conversation/job identity, assignment generation, context receipt/kind/base, deadline, and progress for work needing attention. It contains no key, lease, or context text. Per-job cues remain in `cues/`; accepted tool decisions leave the inference slot free while the client supplies its tool result. Distinct conversations are never combined in an implicit global context.

Read the context with `job-show`, then submit exactly one of:

```json
{"type":"final","text":"answer"}
```

```json
{"type":"tool_call","call_id":"client-call-1","name":"read_file","arguments":{"path":"client-only.txt"}}
```

Duplicate keys, trailing input, unknown fields, invalid IDs, unsupported decisions and unknown tools fail explicitly. The broker validates tool arguments against its authoritative schema. JSON number text is retained, including integers larger than JavaScript's exact Number range. The worker never derives commands from prose or calls `read_file` itself.

Full context is the normal baseline. Delta context is carried only when the broker supplies a qualification probe with its explicit base receipt. A stale delta after reconnect is rejected; cancel that experiment and create a full-context replacement explicitly. The CLI does not invent a new context base or automatically retry inference.

Requests are bounded to 10 seconds and three attempts, with a 1 MiB request ceiling and a 3 MiB response ceiling that includes duplicated final text and broker metadata. Immutable journal bodies and submission IDs are saved before mutations and reused across retries, including after restart. A received receipt describes an accepted operation, not a fresh assignment. Claimed work is checked against current broker state before exposure as actionable work. Cancellation or expiry during that check retains its exact stopped assignment for explicit acknowledgement while health continues.

The subscriber retries transient stream failures with delays capped at 30 seconds. Revocation, invalid protocol, unsafe state and credential/TLS failures stop it explicitly. Only one daemon may own a state directory. Live or ambiguous owners are rejected; stale owners may be recovered only when their process is provably dead. An abandoned recovery guard fails closed and requires operator inspection.

Cancellation, a deadline, or disconnect fences late results but does not prove that Muse stopped. The broker retains the busy hold. Send `--ack-idle` only after that exact assignment has finished/stopped. The CLI queues its job/generation/lease tuple for a fresh health challenge; output distinguishes `queued` from `confirmed`. Ordinary heartbeats and restarts never supply this acknowledgement automatically.

Startup reconciles the broker's current assignment and persisted actionable cues, including when the broker is idle. This repairs interrupted cue publication after an accepted decision. A delayed context read cannot revive an exact assignment with an accepted decision or confirmed explicit idle acknowledgement; other assignments and uncertain stopped work retain their cues.

## Protected state and diagnostics

The state directory must be owned by the current user with mode `0700`; files must be owned regular files with mode `0600`. Symlinked entries and multiply linked files are rejected. Updates use exclusive temporary files, file synchronization, atomic rename, and directory synchronization. Keep the complete protected state when replacing a package: the key is in `credential.key`, and operation journals retain request bodies and accepted/uncertain outcomes. Do not delete a journal to retry an uncertain operation.

INFO, WARN, and ERROR JSON events go to stderr. DEBUG detail is always captured in `diagnostics/` after redaction. Retention is seven days or 128 MiB. Exports use the service's NDJSON metadata/chunk format, with records at most 6 KiB, Base64 payload chunks, and SHA-256 integrity. Missing, corrupt, expired, or capacity-pruned evidence is explicit. Large context/decision exchanges are reconstructed rather than truncated. Authentication fields and known/token-shaped secrets are masked, including overlapping secrets and object keys. Payload numbers retain their text.

Collect an experiment timeline without business-table queries or process inspection:

```sh
aaa-muse-worker diagnostics-export \
  --state-dir "$STATE_DIR" --operation-id "$EXPERIMENT_ID" --decode
```

Also available: `--request-id`, `--since`, and `--until` with RFC3339 times. Check the first metadata record's `complete` and `omissions`, then inspect events. `worker.decision_rejected` and `worker.http_exchange` identify rejected input, broker cause, request ID, and outcome; use that request ID in the broker's authenticated diagnostics export. `worker.stream_retrying` records connection, last event, causal code, attempts and delay. Progress events identify the last context/decision boundary, deadline and elapsed time without inventing an internal Muse cause.

`worker.state_unsafe` reports expected/observed permissions, ownership/type, and the stopped operation. Repair the identified private state before restarting. If the directory cannot safely open, stderr records that protected capture is unavailable. A required capture-write failure emits `worker.capture_failed` and stops the operation; repair its storage cause before restarting. Exports record their outcome without recapturing their own response.

Unit coverage receipts under `.artifacts/unit/worker` list every production module and raw covered/total statements; the ratio must be strictly above 90%. Broker/image integration receipts stay separate. Packed archives and source/runtime/digest receipts are under `.artifacts/worker-package`; isolated integration resources and cleanup receipts use the existing unique test-owner labels. None of these private artifacts belongs in Git or a public handoff.

## Installation, detector and recovery

Use the broker's management-authenticated setup-prompt endpoint after configuring the exact published version and digest. Paste its complete result into Muse and approve only the actual permissions it requests. The bootstrap verifies the archive before executing package code; Node fallback verifies the pinned Linux x64 archive before executing that runtime. An unavailable platform, tool or permission stops setup explicitly. No npm registry credentials enter the VM.

The installer returns exact launcher, hook and skill paths. Register one no-argument managed hook with five-second checks after listing enabled and disabled hooks. Reuse an existing exact enabled registration. Disabled/conflicting registrations or unsupported cadence require an operator report rather than another hook. The generated skill is discoverable in later conversations and limits authority to authenticated model decisions; the client executes its tools. End setup before an independent readiness challenge.

Previous bundles and private credentials/journals remain intact. One daemon owns the state directory. Managed checks may restart only a provably absent subscriber, preserving the worker's identity. A terminal `run-stop.json`, ambiguous ownership, revoked key, unsafe state, or uncertain enrollment blocks recovery and needs operator diagnosis. Do not delete journals or silently re-enroll. Running-version changes and automatic upgrades are outside this installation path. Full wipes, account resets and live refresh persistence remain outside the software receipt.

Unchanged actionable cues emit one wake per assignment/state change. Native emission failure leaves the cue eligible; successful emission does not prove inference started. Inspect the deadline, last emitted cue, subsequent job progress and broker outcome when work stalls. No model retry or stopped-assignment acknowledgement is invented by the detector. Managed dry runs stop before worker state access, network, filesystem writes or subscriber launch.

Before verified Node is available, bootstrap records contain only bounded nonsecret metadata in a private `0700` temporary directory and `0600` receipt. Preserve that directory on failure. Successful setup imports the receipt into the existing protected capture. Installer failures include stage, expected/observed artifact digest or capability, setup correlation and execution status. Required evidence-write failure stops installation. Background stderr is a private bounded 64 KiB emergency sink; the existing diagnostic capture retains complete redacted events and explicitly reports retention omissions.

Collect a setup timeline with `diagnostics-export --decode`, check the first export record's completeness/omissions, and filter events by `setup_id`. Use worker/operation/request IDs to join recovered processes and broker exports. `setup.digest_mismatch`, `setup.runtime_unsupported`, `setup.recovery_blocked`, `setup.cue_observed` and `setup.wake_emitted` distinguish artifact refusal, capability refusal, ownership/authorization stops and emitted but unconfirmed work. Setup and transport health always retain `inference_readiness: unverified` until independent live qualification.

Automatic publication after human merge uses immutable `worker-v0.1.0-rc.N` tags. It packs one archive, tests it on the build and minimum runtimes, and compares registry and anonymous public Release bytes. `worker-release.json` provides source/version/digest pins. Existing-byte conflicts fail; publication does not overwrite tags or assets. Its first live receipt, actual Muse permissions, native wake and supported-refresh recovery must be observed separately before issue #7 passes.
