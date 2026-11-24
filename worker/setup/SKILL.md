---
name: aaa-muse-worker
description: Complete broker claims in finite native runonce Muse executions.
---

# Scoped model backend

Worker: @WORKER@. Broker: @ORIGIN@. CLI: `@LAUNCHER@`. Private state: `@STATE@`.

The owning goal runs one visible native one-minute checker. Use its saved action, not a managed hook, background network process or manual duplicate poll. A checker can finish while its work remains queued or running. Read the exact native job and run; do not infer a stop from tick status, elapsed time, an absent listing or a PID alone.

1. In the finite work run, follow the saved action to read back its one-shot definition and running execution. Send the exact scheduler records to the claim-bound `cron-start` command. Work only after the helper authorizes the start. The checker handles pickup and observation.
2. Use the entire authenticated context. Submit only one strict JSON decision, either `{"type":"final","text":"answer"}` or a `tool_call` with a new call ID, a supplied tool name and its validated arguments. The calling client executes that tool under its permissions. Do not run the tool on this VM, invent results or derive commands from prose. Preserve correlated tool IDs and use the actual client result in the next turn.
3. For media, use only the authorized private job directory. For still-then-animate, generate the actual WebP and pass it with the motion brief to the native video tool. For reference animation, use the verified input. Generate or convert the actual authorized audio to WAV if required. Place the original verified output at the returned path. Run foreground work to completion without reserving a producer. For work that must outlive the native run, follow the exact guard in its work definition. When `cron-producer-intent` returns `producer_command`, use that argument array followed by the executable and its arguments. The executable must stay alive until all of its work finishes.
4. Submit text with `decision-submit --job-id ID --input -`. Submit the finished original media with `media-finish --job-id ID`. Retain the local output and journal on uncertainty. The helper replays the exact operation; never re-execute inference or an accepted client tool on a lost reply.
5. Return a short safe outcome and correlation ID. Never put request contents, credentials or filenames in future scheduled prompts or summaries. Export private evidence with `diagnostics-export --since ... --until ... --decode`. Scheduler status, local helper outcome and authoritative broker receipt are different records.

The owner grants real native and VM permissions. Unsupported refreshes, replacement VMs, live pickup latency and crash recovery are not qualified by installation or synthetic tests.
