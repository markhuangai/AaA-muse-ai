# Muse worker CLI

The major-1 worker is a finite TypeScript helper for an enrolled Muse goal. One visible native `agent` cron at `every: "1m"` checks for work. The checker pulls only when idle and hands each claim to a separate native `runonce` agent job. There is no managed hook, service process, or persistent broker connection. Muse proposes answers and tool calls; only the calling client executes client tools.

## Install and verify

1. Use the control portal on the broker’s HTTPS origin to generate an enrollment prompt for the verified paired major-1 worker archive. Paste it into the owning Muse goal. Review the actual site, shell, and scheduler permissions before enrolling. Build targets Node.js 22.12.0 or newer on a POSIX filesystem. See [deployment](../docs/deployment.md) and [paired releases](../docs/releases.md).
2. Verify the installer receipt and read back the same goal ID, checker job ID, enabled state, one-minute interval, and exact action. If registration was uncertain, inspect the goal’s active and disabled native jobs. Adopt a single exact match; do not create another checker because a reply or listing is missing.
3. Keep the same worker ID and private state across restarts. The default path is `$XDG_STATE_HOME/aaa-muse-worker-v1`, falling back to `$HOME/.local/state/aaa-muse-worker-v1`. The state directory is `0700` and `credential.key` is `0600`. Enrollment codes are private, single-use, and valid for fifteen minutes; the long-lived worker credential never goes in a prompt, URL, or argument. Do not reuse a major-0 installation, store, schedule, or key for this cutover.

The installed launcher passes the correct state directory. Source builds can use `node worker/dist/main.js` with `--state-dir /absolute/path`.

| Command | Use |
| --- | --- |
| `cron-describe --goal-id ID` | Read the expected checker definition before registration. |
| `cron-authorize-registration --input FILE` / `cron-confirm --input FILE` | Save the initial registration intent and then confirm the exact read-back. Use `-` for standard input. |
| `cron-check --input FILE` / `cron-prepare --input FILE` | Process an actual occurrence; persist launch intent before registering a finite work job. |
| `cron-start --launch-id ID --native-job-id ID` | Verify authority before showing the work brief. Do not do work on a rejected or uncertain start. |
| `cron-producer-intent --launch-id ID` | Reserve a producer only for a finite VM-local process that must outlive the work agent. Run the returned `producer_command` with the executable and its arguments. |
| `cron-producer --launch-id ID --producer-id ID --pid PID` | Bind an exact PID using a work definition issued before the guarded wrapper. An unobservable legacy reservation keeps the slot held. |
| `decision-submit --job-id ID --input FILE` / `media-finish --job-id ID` | Submit a validated decision or the original media bytes. Preserve the saved operation and file after a lost reply. |
| `cron-observe --input FILE` | Reconcile the exact native job and execution after a real checker occurrence. |
| `status` / `doctor` / `diagnostics-export` | Inspect broker observations or export protected evidence. |

## Paired updates

New installations receive automatic updates through the existing one-minute
checker. For an existing major-1 installation, paste the **Enable automatic
updates** prompt from its Workers drawer into the same Muse goal. Use the same
VM user and keep the existing checker, worker credential and state directory.
Wait for an authenticated pickup to confirm the version you see in the portal.

The helper verifies the paired archive before replacing the launcher and retains
the previous bundle during recovery. It pauses new work during an uncertain
switch. If it can verify the previous compatible bundle, it resumes work there
during transient retry backoff. [Paired versions and rollback](../docs/releases.md#automatic-worker-updates)

## Recovery and diagnosis

The paired helper uses the native `subscription-status status` command during each fresh idle pull or busy check-in. The checker sends the weekly percentage, observation time and any recognized reset label through its authenticated HTTPS request. A failed read leaves the check running. Diagnose `cron.weekly_usage_unavailable` in the private export and join it to the check-in by checker run ID. The broker rejects expired samples for routing, and a retry of a pending pull carries its original observation.

A checker can finish while a one-time job is still queued or active. Use native run identity and observable producer identity, not a green checker run, an absent listing, elapsed time, or PID alone. Unknown status retains the claim. A cancelled or expired job cannot start or accept a new result. A previously accepted receipt can still reconcile; the broker releases an accepted claim only after the worker confirms the old work stopped. Revoking the worker blocks the credential and does not prove native work stopped.

A check never retries a file upload while the original result helper is active. The helper records its process identity alongside the exact saved result. Once native work and its producers have stopped, recovery checks for an accepted media receipt before sending file bytes again. Unknown delivery identity keeps the hold.

When Muse removes a one-shot definition, look up history scoped to the job identified by `history_lookup`. Pass `matches: []` and the exact `execution` containing `native_job_id`, `native_run_id` and `status`. The helper accepts terminal history for a previously matched job and run, including Muse’s `succeeded` status. A verified stop is durable across checker invocations. An accepted result stays held until the helper can account for its delivery process and producers.

Foreground work has no producer reservation. For work that outlives the agent, the packaged wrapper records its own PID, boot ID and start time before replacing itself with the executable. An unused reservation from that guard expires when the helper verifies terminal execution. Older unbound intents keep the slot held. A native summary that says work ran in the foreground does not provide a process record.

Use `diagnostics-export --state-dir /absolute/path --since RFC3339 --until RFC3339 --decode`. Join worker, checker occurrence, work job and execution, poll sequence, job/claim, producer, and receipt by their distinct identifiers. Join HTTP request IDs and operation IDs to the management-authenticated `/api/v1/admin/diagnostics/export` filters from every participating broker. Decode with `tools/qualification-evidence.mjs` and check omissions before interpreting the chronology. Keep raw exports and journal files private.

In the [portal](../docs/portal.md#worker-management), Never seen means there is no authenticated poll. Quiet begins at one minute without authenticated contact, and Offline at ten minutes. The busy checker reports contact for its held claim without pulling another job. Join `cron.presence_observed` or `cron.presence_unavailable` with the broker request ID. `cron.recovery_pending` gives the hold reason and producer ID when applicable. Use a time-window export to include early input refusals that lack an operation ID.

## Evidence limits

The November 21, 2026 trials measured one account with local synthetic work. Native cron rejected a ten-second recurrence; a long foreground checker coalesced a scheduled occurrence. Separate one-time work and a recurring checker ran concurrently. See [trial evidence and limits](../docs/project-history.md#native-muse-cron). These trials do not qualify the installed paired worker, public HTTPS pickup, live inference, or VM-loss recovery.
