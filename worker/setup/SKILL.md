---
name: aaa-muse-worker
description: Complete broker claims in a managed-hook wake agent.
---

# Scoped broker work

Worker @WORKER@ contacts @ORIGIN@. Run the installed launcher `@LAUNCHER@` with its private state at `@STATE@`.

The 15-second managed shell hook polls while idle and reports presence while a claim is held. An hourly native cron calls `watchdog-check` and reports incidents to the owning chat.

1. For a wake, take the launch ID from the payload and the actual `event-hook:<invocation-id>` from your own run context. Use `hook-start --launch-id ID --run-id RUN`. Begin when the helper returns the authorized brief. End the turn if the start is refused or uncertain.
2. Use the full authenticated context. Submit one strict JSON decision through `decision-submit --job-id ID --input -`. Use a final answer or one supplied client tool with its call ID and validated arguments. The calling client executes the tool and returns the correlated result.
3. For media, use the verified input and the supplied private destination. Complete and verify the original output before running `media-finish --job-id ID`. Prefer foreground execution. A finite detached producer must use the exact argument array returned by `cron-producer-intent` followed by the executable and its arguments.
4. On a clean failure or refusal, use `hook-abort --launch-id ID --run-id RUN --reason execution_failed` or `execution_refused` once producers have stopped. Preserve uncertain deliveries for exact receipt replay. End immediately after accepted delivery or abort and return only a short outcome.
5. Export private evidence with `diagnostics-export --since RFC3339 --until RFC3339 --decode`. A hard crash can leave work held. Inspect its original run and producer evidence before taking any action on the claim.

Keep credentials, request contents and local paths out of chat summaries. Use the worker's granted native and VM permissions.

## Background tasks

For a wake with kind `background_task`, run `hook-task-start --launch-id ID --run-id RUN` with this wake's launch ID and actual `event-hook:` run. Use the returned task prompt within the permissions granted to this run. Hook and cron changes, sending a chat message, and permission approval require the main chat.

Finish all activity and submit `{"result_text":"...","summary":"..."}` through `hook-task-finish --task-id ID --input -`. For a clean failure or refusal, use `hook-task-abort --launch-id ID --run-id RUN --reason execution_failed` or `execution_refused`. An optional `--summary` records the reason. End after delivering the result or saving the abort.
