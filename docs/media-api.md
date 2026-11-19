# Media jobs

An authenticated model client submits one video job, polls its status and downloads the original MP4. An enrolled worker with approved readiness, current media support and free capacity receives the assignment through its subscriber. The client can retrieve the video from the broker for ten minutes after verified storage. All paths use the operator's HTTPS origin.

## Client requests

Send the named model-client key as a Bearer credential. These examples assume `ORIGIN` contains the service origin and `CLIENT_HEADER` is a protected local file containing the authorization header.

```sh
curl --header @"$CLIENT_HEADER" \
  -F 'submission_id=river-001' -F 'image=@river.webp;type=image/webp' \
  -F 'prompt=Move the camera slowly towards the far bank.' \
  "$ORIGIN/api/v1/media/jobs"

curl --header @"$CLIENT_HEADER" --json \
  '{"submission_id":"river-002","prompt":"A watercolor river at dawn. Mist drifts across the water."}' \
  "$ORIGIN/api/v1/media/jobs"

curl --header @"$CLIENT_HEADER" "$ORIGIN/api/v1/media/jobs/$JOB_ID"
curl --fail --header @"$CLIENT_HEADER" --output river.mp4 \
  "$ORIGIN/api/v1/media/jobs/$JOB_ID/artifact"
```

The submission response is HTTP 202 with `job_id`, status, profile and timestamps. Repeating the same submission ID, prompt and image under the same owner returns the original job. Changed inputs under that ID return 409. An approved online media worker must have capacity. The job deadline is 15 minutes from admission.

Multipart accepts one static WebP, PNG or JPEG, up to 8 MiB and 16 million pixels. Prompt text is limited to 4 KiB of UTF-8. JSON prompt-only jobs generate a private still with native Muse and animate it using the same prompt. The worker uses the existing five-second wake hook. On a media wake, Muse follows the authenticated `job-show` action and signals native completion with `media-finish`. The subscriber then streams the bounded original file through the service origin. Each transfer has a 120-second deadline.

Completed status includes `committed_at`, `expires_at` and the measured `artifact` with media type, bytes, SHA-256, duration in seconds, streams, dimensions, frames per second and video frame count. Native video properties depend on the generation. The MP4 limit is 32 MiB. The owner receives 409 while the artifact is pending and 410 at or after expiry. Another client receives 404. Exact retries preserve the original deadline.

## Storage and recovery

Mount the private media volume at `/var/lib/aaa-muse-ai/media` with ownership `10001:10001` and mode `0700`. Mount the same filesystem on every service instance in the pool. Exclude this volume from filesystem snapshots and backups. The operator's reverse proxy must allow the upload sizes and 120-second transfers. The HTTP responses request `Cache-Control: no-store`.

The worker stages each new job in a private `0700` directory under `/tmp` on the Muse VM. Muse writes the generated files, thumbnails and other tool output in that directory. The VM manages their lifetime, so the worker can leave them there after upload. The worker stores the path and assignment progress in its durable journal. If the VM removes an unaccepted upload from `/tmp`, the worker reports the missing file and preserves the assignment for reconciliation. It can confirm an already committed upload from the broker's matching receipt even if the local files are gone. In-flight jobs from earlier releases can finish from their recorded worker state directory.

The service verifies the byte count, SHA-256, actual stream properties and decode, syncs the original file, checks the current worker lease and commits its receipt. An uncertain native generation preserves the assignment hold and requires reconciliation before another generation. The service removes inputs at terminal status and removes the output at expiry, including overdue files discovered on startup. PostgreSQL stores the minimal job receipt. Its status remains available after expiry.

Media inspection uses the Alpine FFmpeg package as separate local processes. The distribution package includes GPL and LGPL components. [Alpine package and source recipe](https://pkgs.alpinelinux.org/package/v3.24/community/x86_64/ffmpeg) · [FFmpeg source and licensing](https://ffmpeg.org/legal.html)

## Management audio trials

`POST /api/v1/admin/media/trials` requires the management credential and a JSON object containing `worker_id`, named client `owner`, `submission_id`, and `profile` (`native_mp3` or `offline_wav`). These profiles default to the size and digest of the two privately verified #50 recordings. For a controlled fixture the operator can bind a specific `fixture_sha256` and `fixture_bytes` at admission. The assigned worker stages the matching synthetic recording at the private path returned by its CLI. Status, authenticated downloads and expiry use the same contract as video. [Original fixture receipts](https://github.com/markhuangai/AaA-muse-ai/issues/50#live-spike-results)

## Diagnosis and live verification

Collect the broker's protected `/api/v1/admin/diagnostics/export?operation_id=JOB_ID` and the worker's `diagnostics-export --operation-id JOB_ID --decode`. Reconstruct the broker export with `decodeExport` from `tools/qualification-evidence.mjs` and check completeness before filtering. Use request IDs to find rejected admissions before a job exists. Follow the authenticated worker, assignment generation, original digest and byte counts, rejected stage and cause, commit time, expiry and cleanup. Raw prompts, source images and artifact bytes are excluded from these captures.

The owner accepted the `0.1.0-rc.15` TLS results and the controlled `/tmp` tests for closing #50 and #51 on merge of the follow-up PR. A TLS run with the revised installed worker remains pending. [Audio and delivery results](https://github.com/markhuangai/AaA-muse-ai/issues/50#issuecomment-6996811354) · [Video and cleanup results](https://github.com/markhuangai/AaA-muse-ai/issues/51#issuecomment-6996811661)

For live verification after deployment, record the exact service and installed worker identities and verify the actual TLS origin and permissions. Submit each of the three input formats and the prompt-only job. For prompt-only, observe both native tool invocations against the same generated still. Independently hash and decode each owning-client download and compare it with the worker output and measured status. Run both audio trials using the original private samples and their recorded hashes. Verify foreign-owner and stale-assignment rejection, an interrupted upload, private worker media placement under `/tmp`, durable receipt reconciliation, and download denial and service deletion across the real ten-minute window. Record any interventions and failures.
