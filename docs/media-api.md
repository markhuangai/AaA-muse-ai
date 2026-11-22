# Media jobs

An authenticated model client submits a video or generated WAV job, polls its status and downloads the original artifact. Jobs queue until an enrolled worker with a free slot and the requested format capability pulls them. The client can retrieve the file for ten minutes after verified storage. All paths use the operator's HTTPS origin.

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

JSON accepts an optional `format` of `mp4` or `wav`. The default is `mp4`. For a WAV submit `{"submission_id":"audio-001","format":"wav","prompt":"Make a short recording introducing the trail guide."}`. Muse receives the brief and chooses an available producer. The installed worker must advertise support for prompt-to-WAV jobs.

The submission response is HTTP 202 with `job_id`, status, profile and timestamps. Repeating the same submission ID, prompt and image under the same owner returns the original job. Changed inputs under that ID return 409. The broker stages the inputs even if no compatible slot is currently free. The job deadline is 15 minutes from admission; a quiet or offline badge does not shorten it.

Multipart accepts one static WebP, PNG or JPEG, up to 8 MiB and 16 million pixels. Prompt text is limited to 4 KiB of UTF-8. JSON prompt-only jobs generate a private still with native Muse and animate it using the same prompt. The one-minute checker hands a pulled claim to a separate native work run. `cron-start` verifies the claim before revealing the private brief. After generation, `media-finish` streams the bounded original file through the service origin. Each transfer has a 120-second deadline.

Completed status includes `committed_at`, `expires_at` and the measured `artifact`. The receipt records media type, bytes, SHA-256, duration and streams. Video also includes its measured dimensions, frame rate and frame count. Artifacts are limited to 32 MiB. Pending status includes `retry_after_seconds: 60`. The existing authenticated artifact route returns 409 while pending and 410 at or after expiry. Unknown jobs and another client's jobs return 404. Exact retries preserve the original deadline.

An owning status poll for a generated WAV or MP4 includes `download_url` once the file is verified and available. Anyone holding that URL can fetch that file using HTTPS GET until `expires_at`. The URL is a secret. Treat it as private like the media it grants access to. Repeated polls through the same hostname and across broker restarts produce the same URL within the window. The link returns 404 if invalid, expired or missing.

## MCP tools

Configure an MCP client that supports Streamable HTTP and custom request headers. Set the URL to `https://<broker>/mcp` and send `Authorization: Bearer <client-key>` on every request. Store the key in the client's protected configuration. Allow at least 330 seconds for text tool calls in both the client and reverse proxy.

| Tool | Input | Result |
| --- | --- | --- |
| `ask_muse` | `prompt`, `submission_id` | One independent Muse answer in the call, with `text` and `request_id` |
| `generate_wav` | `prompt`, `submission_id` | A new prompt-to-WAV job ID |
| `generate_video` | `prompt`, `submission_id` | A new MP4 job ID using Muse's still generation and animation |
| `download_wav` | `job_id` | WAV job state and ready download URL |
| `download_video` | `job_id` | MP4 job state and ready download URL |

Poll the matching download tool every 60 seconds while it returns `retry_after_seconds: 60`. Once the result includes `download_url` and `expires_at`, fetch the URL directly. Stop polling when a terminal result returns a `reason`. Reuse the original `submission_id` to recover a lost reply. A repeat of the same media submission through MCP or HTTP returns the original job. A changed format or prompt under the same ID conflicts.

Configure the HTTPS proxy to allowlist its public hostnames and pass the accepted public `Host` to the broker. Links use that hostname and port. Scope access logging for `/downloads/` to a route label without the path or disable it for that route. Keep request and response bodies out of proxy logging. If the client sends `Origin`, use the broker's public HTTPS origin. [Deployment guide](deployment.md#fresh-install)


## Storage and recovery

Mount private media storage at `/var/lib/aaa-muse-ai/media` with the service's numeric UID and GID and mode `0700`. Mount the same filesystem on every service instance in the pool. Exclude media storage from filesystem snapshots and backups. The operator's reverse proxy must allow the upload sizes and 120-second transfers. The HTTP responses request `Cache-Control: no-store`. [Storage setup](deployment.md#fresh-install)

The worker stages each new job in a private `0700` directory under `/tmp` on the Muse VM. Muse writes the generated files, thumbnails and other tool output in that directory. The VM manages their lifetime, so the worker can leave them there after upload. The worker stores the path and claim progress in its durable journal. If the VM removes an unaccepted upload, the worker retains the hold until it can verify termination and reconcile. A broker-confirmed receipt can settle an already committed upload even if the local files are gone. Major-0 jobs stay with their original installation; they do not move to a fresh major-1 store.

The service verifies the byte count, SHA-256, actual stream properties and decode, syncs the original file, checks the current worker lease and commits its receipt. An uncertain native generation preserves the assignment hold and requires reconciliation before another generation. The service removes inputs at terminal status and removes the output and its share credential at expiry, including overdue files discovered on startup. SQLite stores the minimal job receipt. Its status remains available after expiry.

Media inspection uses the Alpine FFmpeg package as separate local processes. The distribution package includes GPL and LGPL components. [Alpine package and source recipe](https://pkgs.alpinelinux.org/package/v3.24/community/x86_64/ffmpeg) · [FFmpeg source and licensing](https://ffmpeg.org/legal.html)

## Management audio trials

`POST /api/v1/admin/media/trials` requires the management credential and a JSON object containing `worker_id`, named client `owner`, `submission_id`, and `profile` (`native_mp3` or `offline_wav`). These profiles default to the size and digest of the two privately verified #50 recordings. For a controlled fixture the operator can bind a specific `fixture_sha256` and `fixture_bytes` at admission. The assigned worker stages the matching synthetic recording at the private path returned by its CLI. Status, authenticated downloads and expiry use the same contract as video. [Original fixture receipts](https://github.com/markhuangai/AaA-muse-ai/issues/50#live-spike-results)

## Diagnosis and live verification

Collect the broker's protected `/api/v1/admin/diagnostics/export?operation_id=JOB_ID` and the worker's `diagnostics-export --operation-id JOB_ID --decode`. Reconstruct the broker export with `decodeExport` from `tools/qualification-evidence.mjs` and check completeness before filtering. Use request IDs to find rejected admissions before a job exists. Follow the authenticated worker, assignment generation, original digest and byte counts, rejected stage and cause, commit time, expiry and cleanup. The `media.link_ready`, `media.link_opened` and `media.link_rejected` events identify link outcomes without storing the credential. Media captures omit raw prompts, source images and artifact bytes. MCP text exchanges use the existing private redacted history diagnostics.

The owner accepted the `0.1.0-rc.15` TLS results and the controlled `/tmp` tests for closing #50 and #51 on merge of the follow-up PR. A TLS run with the revised installed worker remains pending. [Audio and delivery results](https://github.com/markhuangai/AaA-muse-ai/issues/50#issuecomment-6996811354) · [Video and cleanup results](https://github.com/markhuangai/AaA-muse-ai/issues/51#issuecomment-6996811661)

For live verification after deployment, record the exact service and installed worker identities and verify the actual TLS origin and permissions. Submit each of the three input formats and the prompt-only job. For prompt-only, observe both native tool invocations against the same generated still. Independently hash and decode each owning-client download and compare it with the worker output and measured status. Run both audio trials using the original private samples and their recorded hashes. Verify foreign-owner and stale-assignment rejection, an interrupted upload, private worker media placement under `/tmp`, durable receipt reconciliation, and download denial and service deletion across the real ten-minute window. Record any interventions and failures.
