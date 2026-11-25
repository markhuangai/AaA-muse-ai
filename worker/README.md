# AaA Muse worker

The major-1 managed shell hook checks for work over HTTPS every 15 seconds. It wakes a Muse agent for a claim and reports busy presence on later ticks. One hourly native agent cron runs the watchdog.

## Installation, detector and recovery

1. Open **Workers → Enroll a worker** in the HTTPS portal. Paste the pinned prompt into the main Muse chat for the goal that owns the worker. Review the actual native hook, cron, shell and site permissions.
2. Verify the authenticated worker ID. Read back the exact enabled 15-second hook, its 120-second script timeout and silent dry run, and one enabled hourly agent watchdog. Resume incomplete setup with the same worker and its saved registration intent.
3. Use the worker-specific paths under `~/.local/share/aaa-muse-worker-hook-v1` and `~/.local/state/aaa-muse-worker-hook-v1`, or the corresponding XDG paths. The detector and skill are installed in worker-ID-scoped directories. The credential file is private. [Deployment and cutover](../docs/deployment.md)
4. During the first cutover, keep the original worker's credential and cron until its claims are drained and the new registration is verified. The owner then retires the identified previous schedule and revokes that worker. [Paired releases](../docs/releases.md#automatic-worker-updates)

The wake agent uses `hook-start` with its own `event-hook:<invocation-id>` and the claim's launch ID. It executes the returned brief and submits a decision or media output. `hook-abort` records a clean early stop. The broker checks the bound invocation alongside the worker identity, generation and release. After a lost pull reply, a later tick can rebind the same claim when the journal proves the first tick never attempted a wake.

If a wake, start, output delivery or producer remains uncertain, the slot stays held. A matching receipt and stopped local delivery/producer processes permit settlement. The watchdog reports stale ticks, overdue uncertain claims and update failures. For a missing hook, inspect the registered hook from the main Muse chat and verify its next authenticated tick.

## Updates

The installed archive and the broker must match for enrollment and all work traffic. During version skew an idle managed worker can verify and install a newer 1.x archive pinned by the running brokers. The launcher switches atomically and the worker confirms the running version on its next authenticated pull. Drain work and update attempts before changing the broker version. [Release rules](../docs/releases.md#automatic-worker-updates)

## Diagnostics

Use `diagnostics-export --state-dir /absolute/path --since RFC3339 --until RFC3339 --decode`. Join worker, hook, wake invocation, original poll, claim, launch and submission IDs. Join request or operation IDs with the management-authenticated `/api/v1/admin/diagnostics/export` on each participating broker. Check capture completeness and keep the raw exports private. INFO shows claim, binding and settlement. WARN records refusals and stalls. Protected DEBUG includes the bounded exchanges.

Contact becomes Quiet at one minute and Offline at ten minutes. The November 25 owner probes cover available hook tools, the runtime command, and scheduling during a wake. Token savings, live end-to-end pickup, watchdog alerts and VM replacement recovery still need live measurement. [Project history](../docs/project-history.md#managed-hook-worker)
