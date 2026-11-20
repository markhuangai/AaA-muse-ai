# AaA-muse-ai

A self-hosted broker that connects model clients to a Muse worker through outbound HTTPS/SSE. Muse proposes answers and client tool calls; the calling client applies its permissions, executes its tools, and returns their results.

## Status

On November 20, the owner reported two pre-enrollment directory refusals on `v0.2.1-rc.1` and two working installations. A controlled Linux run verified the published worker archive `941dafadfd6c544390dc9c98e178c81b0fe5d31422e57b752de7db067a0bbd5f` at source `4aa70503705ba162f946443e5e3da973720091e8`. Under a setgid parent the installer refused mode `2700`. Clearing setgid on the two empty worker directories let the same archive reach worker setup. The fixture used no enrollment code.

The owner approved a paired prompt and installer fix for the XDG, hook and skill directories. The helper verifies the directory identity, owner and contents before clearing setgid. A post-enrollment refusal requires the saved worker identity on retry. The delivery requires the independent plan audit, all CI, CodeQL, Codex and complete configured AI review, with a CodeRabbit exemption for this PR. [Worker setup and recovery](worker/README.md#installation-detector-and-recovery)

Controlled validation passed by `2026-11-20T13:58:43Z` at working-source digest `8e42fe5c5b3c2588d346b0b1c60d2e09a05b34f51a4b96b5993c339babed9636` before this note. The independent audit was conformant on its first pass. The packed setup and recovery suites recorded 15 and 10 passing cases with worker archive `d8cb6a7507b3c63dea8b55179fcdfab0141c8350598f2c91a1f76b4ea37e172a`. Private receipts identified all four pre-enrollment refusal cases and both post-enrollment asset failures. The recovered worker authenticated with its saved credential. All six unit coverage gates passed. Live recovery of the two reported instances has not been verified.

The November 20 owner decision at `46e9ac8373980eba1c344a100b35e85e4a3e9a63` replaces PostgreSQL with embedded SQLite on one host. The SQLite deployment starts with fresh data. Concurrent broker processes share a local file and preserve accepted decisions, worker fencing, and unsettled holds across restarts. The delivery requires the independent plan audit, all CI, CodeQL, Codex, and complete configured AI review. The owner exempted CodeRabbit for this change. [Operation and cutover](#sqlite-state-and-cutover)

Controlled SQLite validation passed by `2026-11-20T01:29:40Z` using working-source digest `3fbb9cd2932c02ed18383248e3bfc05faf53f19c7b39846f067ec9bef6e41f7a` before this note and broker image `sha256:a8a7d5fd760fb0bcf9cbab29eb9506ea8e9d5af2de4faffd3f8cc04dd83120d3`. The round-two independent audit was conformant. All six unit coverage gates, both product shards, the browser and worker suites, real media expiry, and controlled release verification passed. In a disposable Compose stack, a held SQLite writer left history readable. The blocked write returned SQLite code 5 after 2,009 ms. A forced statement failure returned code 1811 and rolled back. Protected exports identified both causes and the successful startup retry. [Storage and recovery diagnostics](docs/history-api.md#broker-restart-recovery)

On a Linux x86_64 Docker 29.1.3 host, ten overlapping clients submitted 30 mixed Chat and Responses requests through two brokers sharing SQLite. Two controlled workers each took five seconds per job. All requests completed in 94.492 seconds (0.317 per second), with 88 successful history reads, zero lock failures, and a maximum heartbeat gap of 10.125 seconds. P95 across 30 samples per timing was 128 ms for broker admission, 42 ms for claim, 29.015 s for queue wait, and 33.152 s for client latency. The median of three ready, idle measurements on the same host was 8.02 MiB across one SQLite container and 65.17 MiB across two PostgreSQL containers at `v0.2.1-rc.0`. [Footprint comparison](docs/history-api.md#controlled-idle-footprint-comparison)

The owner approved browser-origin setup prompts, named client-key creation in `config.yaml`, and removal of the global job cap at `cfcb83da92ecfc910fee1a07ac100b76e9abe562`. The portal displays generated values before Save and lists names afterward. Shared configuration needs a writable directory for atomic replacement. One worker still runs one inference job at a time. [Control portal](docs/portal.md)

Controlled validation passed by `2026-11-19T21:04:39Z` at working-source digest `218de390e5822eeae48e0fc6557bd1172d8fe62e843f20880d436d097afef848` before this note, using the broker image `sha256:b190fa3daa43895b167bfbbc0a0c1047b5454b157aa501154688afa8eb8be1a4`. Chromium verified two HTTPS origins, immediate key authentication on both brokers, and persistence across restart. The protected export identified a read-only mount's failed write. Routing admitted ten jobs while each worker retained one assignment. Both product shards and all six unit coverage gates passed. [Portal diagnostics](docs/portal.md#diagnostics) · [Routing](docs/history-api.md#qualification-and-dispatch)

Hosted CI and Codex passed for the first PR head, `d1b9de7552d931c785d30bed1c2611c0e80ea134`. CodeQL flagged the in-memory portal password digest at the changed constructor. The follow-up uses a constant-time byte comparison with the configured secret and checks exact matching for long passwords and passwords containing spaces. The configured AI reviewer timed out at `2026-11-19T21:48:47Z` after completing one of six goals. [CI](https://github.com/markhuangai/AaA-muse-ai/actions/runs/44615733791) · [CodeQL alert](https://github.com/markhuangai/AaA-muse-ai/security/code-scanning/10) · [AI review](https://github.com/markhuangai/AaA-muse-ai/actions/runs/44615733840)

At `2026-11-18T03:07:27Z`, the owner-requested media investigation verified that the Muse login page rendered through the private noVNC portal. Chromium's sandbox failed in the development container and passed in a dedicated browser container. The earlier VNC handshake succeeded while the desktop stayed black. Disabling MIT-SHM for the virtual display and using `x11vnc -noshm` restored rendering with the Chromium sandbox active.

By `2026-11-18T03:43:44Z`, the one-account Muse media spike verified five private chat downloads. Native video produced the requested scene at 720p for ten seconds with audio. FFmpeg normalization produced a four-second silent 640×360 version, and a separate procedural renderer met the exact scene constraints. Native TTS MP3 and offline FFmpeg/libflite WAV both matched the requested transcript under independent speech recognition. One scoped echo destination returned HTTP 402 via Node and timed out via curl. A second returned exact Node HTTPS echoes for 16,384 and 787,707 synthetic bytes after one-time approvals. The proposed post-v0.1.0 API uses the tested producers and requires an enrolled worker-to-client round trip on the actual broker origin. [Media spike receipts](https://github.com/markhuangai/AaA-muse-ai/issues/50) · [Proposed implementation](https://github.com/markhuangai/AaA-muse-ai/issues/51)

By `2026-11-18T04:11:27Z`, the style comparison had verified eight ten-second H.264 MP4s by SHA-256, full decode, and sampled frames. Five native text-to-video scenes covered documentary coast, a person shaping clay, cel cartoon, watercolor, and simulated clay stop motion. The matched alternatives used local Python/Pillow plus FFmpeg, a Muse-generated still plus deterministic FFmpeg zoom, and native video with an ordered image-and-text prompt. The reference-based output measured 1248×704 and the other seven measured 1280×720. Native text-to-video files reached 11,048,283 bytes. The earlier HTTPS echo reached 787,707 bytes, and enrolled-worker delivery at the observed media sizes remains unverified. Artifacts and frame previews are in the private local cache.

By `2026-11-18T12:19:05Z`, a second native image-to-video trial using the same 2048×1152 WebP requested five seconds, 640×360, 12 fps, 60 frames and silence through the text prompt. The SHA-256-verified download decoded as ten seconds of 1248×704 H.264 at 24 fps, 240 video frames and AAC audio with nonzero signal. Muse reported that `media.generate_video` requires ordered `prompt` entries of kind `image` or `text` and exposes optional `name`, `output_dir` and `resume_from_snapshot_id`, with no typed technical output settings. Both image-based runs produced the same measured profile. Other source aspect ratios, formats and continuation behavior remain unverified.

The owner selected native image-to-video for the post-v0.1.0 endpoint. The `2026-11-18T13:57:33Z` issue update records an uploaded still and motion prompt as inputs and the original MP4 with its measured properties as output. The delivery gate requires a real enrolled worker to stage the assigned input and deliver the original artifact through the actual broker origin to the owning client. [Settings and live probe](https://github.com/markhuangai/AaA-muse-ai/issues/50#native-image-to-video-settings) · [Native image-to-video jobs API](https://github.com/markhuangai/AaA-muse-ai/issues/51)

The `2026-11-18T18:53:51Z` issue update records the owner's delivery decision for the proposed endpoint. The enrolled Muse worker automatically uploads the original MP4 over outbound HTTPS. The owning client's 10-minute download window starts when the service verifies and durably stores the file, and job status reports the deadline. The worker keeps its job-local MP4 until the service confirms storage, then deletes it. The service blocks new downloads at expiry and removes its stored copy, including expired files found on restart. [Artifact delivery and expiry](https://github.com/markhuangai/AaA-muse-ai/issues/51#how)

The owner-approved OpenAI compatibility work advertises `muse-ai` while accepting the existing alias, supports CPA’s streamed usage request with unknown totals, and carries a dated model and context-window report from Muse setup to the Workers view. The report describes the setup turn. The passing-live release gate remains in effect. See the [OpenAI and CPA configuration](docs/history-api.md#openai-chat-completions).

The November 18 owner approval at base `aa0d226904667b7f63d6f3becb1139d8f4a15297` combined #50 and #51 in one PR. The media API accepts a static WebP, PNG or JPEG with a prompt, or just a prompt for native still generation followed by native video. The worker uploads the original MP4 and reconciles durable acceptance. The service stores files on a shared private volume, removes inputs at terminal status and deletes the MP4 ten minutes after verified storage. Management can assign private MP3 and WAV delivery trials. [Media jobs, limits and downloads](docs/media-api.md)

Controlled media validation passed by `2026-11-18T20:34:21Z` at working-source digest `db4506493a61f479d9162d572c2f74488f8c9d8a86c1e331ccf1e54e348b6ad0` before this note, with packed-worker SHA-256 `35070c7bbfdba29490a56c1fa12c293ba87c1acfbfc82cdd54ffac99800d3724`. Twelve cases covered the four video input paths, both controlled audio trials, a slow 32 MiB upload, loss of acknowledgment, cancellation during transfer, and physical deletion across a real ten-minute expiry and broker restart. The independent plan audit passed on round two. A worker fault test exposed a reference file surviving a failed journal write. Recording preparation before staging now lets terminal cleanup remove it. All six unit components exceeded 90%, both product E2E shards passed, and controlled release verification passed. [Live acceptance](https://github.com/markhuangai/AaA-muse-ai/issues/50#remaining-acceptance)

By `2026-11-19T01:24:54Z`, the owner-deployed TLS service and the same enrolled worker on `0.1.0-rc.15` at `d8928fd63be53720012cdb3d689549d9d8ff8fbc` delivered the four native MP4 cases and the original MP3 and WAV. All six artifacts expired after ten minutes, and the service logged each deletion. A subscriber socket failure interrupted the first JPEG job before native generation. The hook reconciled the busy hold and the next job passed with the retained qualification. Stale and foreign-owner requests were rejected. An assisted streaming abort preserved the full local file for upload on the same assignment. Broker receipt of the partial body remains unverified. Worker cleanup left tool-named MP4s for WebP, PNG and prompt-only, and left sidecars for all four videos. Manual cleanup removed the confirmed test files. [Audio and delivery results](https://github.com/markhuangai/AaA-muse-ai/issues/50#issuecomment-6996811354) · [Video and cleanup results](https://github.com/markhuangai/AaA-muse-ai/issues/51#issuecomment-6996811661)

The November 19 owner update assigns worker media retention to the VM's `/tmp` lifecycle. New jobs use a private directory there for their media and tool output. The durable journal lets the worker reconcile a committed upload after temporary file loss and preserve an unknown outcome. By `2026-11-19T01:56:58Z`, an isolated native capability probe generated a 544,138-byte WebP and animated it into a 3,882,432-byte MP4 with sidecars in the same private `/tmp` directory. [Worker storage and recovery](docs/media-api.md#storage-and-recovery)

By `2026-11-19T02:19:15Z`, the controlled `/tmp` follow-up passed all 12 `make test-media` cases, including expiry across a real ten-minute window and broker restart. All six unit components exceeded 90% statement coverage, and the independent plan audit passed. The tests used worktree digest `3a860a42f8d664b9713b91037b313f6ac355703078221905ee476175f9985768` before this note and packed-worker SHA-256 `2dcea0f3b3e4240d72f1364ecc735f8735ea5b0fb0d918fe8226957882dab979`.

On November 19, the owner accepted the existing live and controlled results for closing #50 and #51 when the `/tmp` follow-up PR merges. End-to-end TLS verification with the revised installed worker remains pending.

On November 17 the owner accepted rc.11 functional testing and closed [#18](https://github.com/markhuangai/AaA-muse-ai/issues/18#issuecomment-6947082016). Its final record retains 68 complete exports, 30/35 formal cases and an inconclusive qualification verdict, including unavailable supported-refresh evidence. Both test registrations were permanently revoked. These findings supersede the earlier incomplete-task notes below. The formal live result remains inconclusive.

[PR #49](https://github.com/markhuangai/AaA-muse-ai/pull/49) delivered immutable final-version candidate preparation. Its published [`v0.1.0` prerelease](https://github.com/markhuangai/AaA-muse-ai/releases/tag/v0.1.0) reserves the npm version and has a complete publication receipt. On November 19 the owner revised [#19](https://github.com/markhuangai/AaA-muse-ai/issues/19) at `4c50c4bc9bd254625a7c9aac212fc738a068a405`. Eligible merges still publish paired RCs automatically. The new stable workflow accepts the latest complete paired tag and the requested final version, then verifies, builds, and publishes the pair in one administrator dispatch. That dispatch replaces the former live-receipt and confirmation inputs. Stable publication records `live_qualification: not_established`. The first verified stable promotion remains pending. [Paired releases](docs/releases.md#publish-stable-from-a-paired-prerelease)

At `2026-11-19T13:53:47Z`, the dispatch of `v0.1.0-rc.17` to `0.2.0` at `5bb6d5f62b52ab4e4381770a43545f56f0d5f925` failed after verifying both worker downloads. Docker's containerd image store rejected the config digest as a local image ID. The original bundle reproduced the failure locally and tagged successfully by its restored image name. The publisher checks the restored config digest before using that name. GHCR had no `0.2.0` image and GitHub kept `v0.2.0` as a prerelease. Recovery uses the original run's bundle, retained through `2026-11-26T13:53:05Z`, and requires the selected RC to remain current. [Publish job](https://github.com/markhuangai/AaA-muse-ai/actions/runs/44537608690/job/135608197018)

Controlled #19 validation passed by `2026-11-17T13:33:43.347Z` at base `bc4ce9c10620b74f203bc719c3eb1f38535719ee`, working-source digest `54797456389952f6765e3f26e6342f112d56ea1e49c255a614da4fb77a74e748` before this note: the actual final-version image smoke check, 22 release/qualification cases, actual-logger failure diagnosis, and all six independent unit-coverage gates above 90%. File-size, workflow policy/actionlint and documentation checks passed. The independent plan audit was conformant on round three; subsequent changes corrected a test's expected rejection and moved `runner.temp` into step-level environment configuration. Local Docker attempts first failed on an unavailable Desktop credential helper and then a missing Buildx discovery path; the passing run used the same daemon with a temporary anonymous client configuration and the existing plugin, preserving operator settings. Hosted current-head CI, Codex, complete configured AI review and CodeQL remain required. The controlled results cover the older release workflow and provide no live Muse qualification.

The November 16 rc.10 continuation at service/worker source
`caed10795c063178902aee2d4cf402a704fa4875` exposed a collector limitation: native
hook agents report run/agent identities with no conversation record. The candidate
[background execution proof](docs/qualification/README.md#private-observation-input)
requires actual native command receipts linked to authenticated worker captures
and leaves conversation IDs null. It preserves historical reports and the
stricter conversation requirements for delta/replay. This collector change passed controlled validation and awaits hosted review;
it does not establish a passing live verdict. The [rc.10 continuation record](docs/qualification/rc10-live.md)
retains the observed passes, failures and evidence gaps. Issue #18 remains incomplete.

The same collector repair handles redacted management-status maps and server
response logs written after client receipt. Broker proof still requires the
authenticated old/new process identities, a status recorded before the owner's
restart, the exact restored pending call and one resumed client-tool execution.

One-account testing demonstrated background wake, authenticated replies, six basic client-tool trials, full-history continuation, fresh-conversation replay, and automatic hook-based subscriber reconnection. A later weather question completed through the same service and client-tool loop.

**Full qualification remains inconclusive:** interleaving failed in both runs, and the exact supported-refresh scope and formal recovery case remain incomplete. Full history is the baseline; the tested delta candidate is rejected. A passing live receipt still gates release work. Detailed [findings and receipts are in #7](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6784686856), with [reconnection](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6785064072) and [weather-demo](https://github.com/markhuangai/AaA-muse-ai/issues/7#issuecomment-6785270949) updates.

The owner-authorized November 15 rc.7 product run completed the client assertions for all eight Chat/Responses JSON/buffered-SSE tool cycles, with matching native wakes and canonical contexts, exact result/retry checks, later affinity and one client-tool execution per cycle. Strict validation flags five cycles as intervened because operator messages in the other account overlapped their measured windows; only three currently qualify as unattended runs. Cross-worker context access was rejected, and portal login/renaming preserved worker IDs. The earlier account-A timeout and reported refusal remain retained. A later service interruption caused expired health replies, reconnects and HTTP timeouts. Both fresh connection-readiness trials then ended with `worker_disconnected` and an unknown remote outcome; new model submissions stopped. Portal-history, interleaving and formal recovery evidence remain incomplete. The [live observation record](docs/qualification/product.md#live-rc7-observation-record) records the receipts and local collector fixes. Full qualification and issue #18 remain incomplete.

The owner also reported a container-local health timeout. Local tests reproduced diagnostics export reads blocking synchronous request logging and per-deletion retention metadata writes amplifying capacity pruning. The repair releases the store lock before capture reads/verification, reports files removed during export as incomplete evidence, and persists one conservative watermark before deleting a pruning batch. These mechanisms are verified locally; their contribution to the remote outage remains unconfirmed. The repair passed review and was published in [rc.8](https://github.com/markhuangai/AaA-muse-ai/releases/tag/v0.1.0-rc.8), which the owner deployed.

The [rc.8 live run](docs/qualification/product.md#live-rc8-observation-record) verified the deployed image and clean source `ed5d4d78d30566414b90912c58dbcf72655c8e78`, retaining the compatible rc.7 worker installations. Both fresh readiness challenges passed, but A's tool trial timed out after an authenticated context read, without a tool proposal. Muse reports a native refusal; its exact notice is unavailable. B passed strict readiness/tool validation and all four unattended Chat/Responses JSON/buffered-SSE cycles, including exact contexts, decisions, client results, retries and affinity. Portal setup/rename/history and cross-client/cross-worker rejection checks passed. Final report validation at `2026-11-15T21:33:28Z` found no schema or export errors, with 16 of 35 live cases passed; twelve health/readiness probes during exports all returned 200, taking at most 777 ms. A remains unqualified for function-tool routing. The two-account matrix, formal recovery, supported refresh and final revocation remain incomplete, so #18 and full live qualification remain inconclusive.

The post-run check at `21:38:02Z` found both workers online and idle, with the same broker process. B had logged `UND_ERR_SOCKET`, stopped, and automatically started a new subscriber on connection generation 19 after the tested generation 18. Deployed rc.8 marked its prior approval stale. A real client request at `22:05:32Z` then returned `503 no_ready_worker`, with `readiness_stale` despite online/idle status and available capacity. The initiating socket close and old-process stop causes are unavailable. B's earlier verified passes remain observations of generation 18; this spontaneous restart does not satisfy a formal recovery or refresh case.

The owner's November 15 correction retains capability approval for the same enrolled worker across authenticated reconnects. Initial proof, explicit withdrawal, revocation, connection/assignment fencing and uncertain busy holds remain required. Recovery uses the existing durable credential without re-enrollment, new token exchange or management reapproval. The correction also removes recovery-test requalification that masked the failed behavior. Deployed rc.8 still had the defect at that checkpoint. A fresh retry passed readiness but again timed out before any tool proposal, after the owner-authorized lifting of an earlier operator pause. The [continuation record](docs/qualification/product.md#automatic-recovery-correction-and-a-retry) preserves both failures and evidence limits.

Controlled recovery validation passed by `2026-11-15T22:56:24Z`: the combined product flow passed 32 cases and the adverse shard passed, reusing 34 Chat and 54 Responses receipts. Complete exports show no qualification mutation for the recovered worker during either broker or worker recovery. Routing, broker recovery, packed-worker recovery and portal-worker browser regressions passed; all six unit components separately exceeded 90% raw statement coverage. These controlled passes do not establish live recovery or resolve A's tool failure. Final-head CI, Codex, configured AI review and CodeQL remain required.

[PR #46](https://github.com/markhuangai/AaA-muse-ai/pull/46) subsequently passed the required reviews/checks, merged as `ca3cd57c38acf837b0a4ce3e0e6db8b5f1f808f8`, and was published in rc.9. The owner deployed its verified image. At `2026-11-16T00:08:01.806Z`, a real B client request completed on connection generation 21 under its original generation-18 approval, without reapproval. All four B Chat/Responses JSON/buffered-SSE cycles then passed through `00:36:03.213Z`, including exact client results, retries, affinity and one client-tool execution each. Complete worker/broker exports and native observations verify all thirteen model jobs; no operator message overlapped their measured windows. Portal login/setup/rename/history, cross-client/cross-worker rejection and diagnosis from logs alone also passed. Both installed workers remain rc.7. A remains withdrawn, its exact reported refusal notice is unavailable, and no supported runtime-refresh action was exposed. Formal recovery and the remaining two-account cases still gate #18; see the [rc.9 observation record](docs/qualification/product.md#live-rc9-observation-record).

The owner's `2026-11-16T01:03:19Z` service restart subsequently passed B's formal broker tool-wait continuation and tool-deduplication checks. The new broker restored the exact pending call; B continued on connection generation 22 under unchanged approval, with one client execution and an exact retry of the completed operation. Complete native/broker exports and passive observations passed independent validation after documented collector receipt corrections. The report has fifteen of thirty-five required cases passed. A later worker-restart control stopped before signalling because B had already restarted spontaneously onto generation 23; its cause and real client processing are being checked separately. Worker/refresh, two-account and remaining adverse cases still keep #18 incomplete. See the [recovery evidence and collector limitations](docs/qualification/rc9-live.md#broker-restart-and-client-tool-continuation).

The generation-23 client probe subsequently completed its tool/result/retry assertions, confirmed by broker receipts. At `2026-11-16T01:44:25.003Z`, B entered a terminal `diagnostics_unavailable` stop during a native diagnostic read; neither scoped restart control sent a signal. Source inspection and a failing local regression reproduce export reads holding the worker capture lock long enough to make required subscriber logging terminal. The local repair freezes export metadata/filenames under the lock and performs payload reads and verification outside it, reporting concurrent removal honestly. All six unit components exceed 90% coverage, and both combined product shards plus standalone packed-worker recovery passed locally. Required PR review and hosted checks remain pending. B's terminal marker and identity remain preserved, with no automatic restart, upgrade or re-enrollment. Formal worker/refresh qualification and #18 remain incomplete; see the [terminal-stop investigation](docs/qualification/rc9-live.md#terminal-worker-diagnostics-stop).

The rc.10 live large-output attempt subsequently hit a worker `state_lock_timeout` during required logging, before accepted output. Its terminal marker and unknown broker busy hold remain preserved. A local regression reproduces per-deletion retention metadata syncs exhausting concurrent subscriber logging; the repair persists a conservative batch watermark before deletion, matching the existing service pattern. Fault checks preserve captures before failed persistence and honest omissions after partial deletion. The precise live lock holder remains unobserved, and this repair does not qualify live recovery. See the [capacity-pruning record](docs/qualification/product.md#worker-capacity-pruning-regression).

The experiment API and worker exist. The [native request API](docs/history-api.md) adds named-client canonical conversations, one decision per request, and management timelines. The [OpenAI Chat Completions subset](docs/history-api.md#openai-chat-completions) and [Responses subset](docs/history-api.md#openai-responses) provide text and client function tools with JSON or buffered SSE responses. Responses adds typed items and linear owned response continuation. The [control portal](docs/portal.md) adds password login, read-only settings, worker management and request histories/cancellation in the same image and origin. Decisions and evidence are recorded in this repository and GitHub; project memory may supplement them.

The November 11, 2026 CI decision accepts the completed PoC investigation as the prerequisite for engineering gates in [#20](https://github.com/markhuangai/AaA-muse-ai/issues/20), while retaining the inconclusive qualification result. [Contributor checks](AGENTS.md#contributor-ci-checks) cover independent unit coverage, source-file limits, workflow budgets, and packaged integrations.

The separate November 11 [#8 approval](https://github.com/markhuangai/AaA-muse-ai/issues/8) permits canonical-history logic and controlled HTTP/PostgreSQL tests now, with live testing deferred. Existing qualification remains inconclusive; this exception does not establish live session isolation or release readiness.

The November 11 [#9 approval](https://github.com/markhuangai/AaA-muse-ai/issues/9) separately permits automatic capability routing and controlled software validation. Native requests can omit the worker ID, wait in a bounded queue, and retain a healthy session pin across answers. Management records authenticated qualification trials with explicit controlled/live provenance. The November 15 owner correction retains the latest approval across authenticated reconnects instead of requiring per-connection reapproval. These software mechanisms do not resolve the failed interleaving or incomplete refresh qualification, and #9 alone authorizes no live trial. See the [native API contract](docs/history-api.md).

The November 12 [#10 approval](https://github.com/markhuangai/AaA-muse-ai/issues/10) permits broker-recovery engineering and controlled validation. Startup reconciles PostgreSQL work before serving, preserves accepted decisions and tool waits, and retains uncertain claimed work under the existing 30-second health leases. A healthy sibling broker is preserved. The [recovery contract](docs/history-api.md#broker-restart-recovery) distinguishes receipt replay from renewed claim authority. This engineering exception grants no live Muse trial or release qualification.

The November 12 [#11 decision](https://github.com/markhuangai/AaA-muse-ai/issues/11) reaffirms the durable worker credentials approved in [#3 on November 9](https://github.com/markhuangai/AaA-muse-ai/issues/3), already implemented at source revision `c798f48dd2adabe704294cf2ceb929486feeac69`. It replaces #11's proposed credential expiry and renewal with documentation and controlled validation of the existing lifecycle, independently of #21. Live qualification and release requirements remain unchanged.

The November 12 [#12 approval](https://github.com/markhuangai/AaA-muse-ai/issues/12), based on `18e9317b76c506e5f33a31dc1e7a93b42c77123d`, permits worker-recovery engineering and controlled software validation. The development worker retries temporary startup and reconnect failures, reconciles existing evidence before resubscribing, and limits terminal-stop recording to the daemon owner. A healthy installation needs no repair or reinstall. No repair command, automatic inference retry, live trial, or publication is authorized; the published prerelease pin and inconclusive live qualification remain unchanged. See the [worker recovery contract](worker/README.md#installation-detector-and-recovery).

The November 12 [#13 approval](https://github.com/markhuangai/AaA-muse-ai/issues/13), based on `fdc0e3121ead3d4e024291f94deeaeda7b18ef93`, permits Chat-adapter engineering and controlled SDK/HTTP/PostgreSQL validation. It preserves existing pre-claim/pre-context rerouting and uncertain claimed busy holds, adds no inference retry, and grants no live trial or release publication. Controlled peers do not resolve the inconclusive live qualification. `make test-chat` and `CI / openai` retain the supported-subset and diagnostic evidence separately from unit coverage.

The November 13 [#14 approval](https://github.com/markhuangai/AaA-muse-ai/issues/14), based on `173770da918aca4921fb2ca83b6e2ef9b14c4941`, permits Responses engineering and controlled validation. Instructions apply to their individual request; prior values remain in durable request snapshots. Owned response chains remain linear, preserve healthy worker pins, and use only existing conservative replacement boundaries. `make test-responses` extends the shared runner; its separate safe receipt is retained alongside Chat by `CI / openai`. This decision retains the inconclusive live verdict and passing-live release gate, and authorizes no live trial, broader inference retry, deployment or release publication.

Responses validation passed at `2026-11-13T04:24:26Z` (54 receipts after refreshing the restart fixture). Earlier runs passed Chat (34 receipts) and the native inference, history, routing and broker-recovery regressions. Both protocol runners use OpenAI JS SDK 7.53.0. The local Docker port-forwarding path timed out during TCP connection setup; the passing runs used the existing direct-container-network harness option. Each suite verified removal of its three containers, three volumes and network. Hosted CI retains its normal transport and separate safe protocol receipts; these controlled results do not qualify live Muse.

The November 13 [#15 approval](https://github.com/markhuangai/AaA-muse-ai/issues/15), based on `e2fb302c7846db8e8c424f33b8a7d00c2d22523b`, permits portal engineering and controlled browser/API/image validation before further live qualification. Portal sessions are limited to the service process, expire after thirty minutes without renewal, and are never persisted by the browser. This exception preserves the inconclusive live verdict and passing-live release gate; it grants no live trial, deployment, publication or merge. Codex, the configured AI reviewer, CI and CodeQL are required; CodeRabbit is excluded for this delivery. Controlled receipts do not qualify Muse inference.

Controlled portal validation passed at `2026-11-13T13:58:01Z`: 24 receipts and nine login/settings/error screenshots at 1440, 768 and 390 pixels. The approved-base working-source digest was `346fe74085c332ff6793adc671877782256c22eb2defd1d7cc5ffbc3daddc5f8`; the tested combined image was `sha256:117224eaee903055849a13a4206771c02e293035fbb07ff1430c29aafef572e7`. Authentication boundaries, redaction, process-local invalidation and log-only diagnosis passed. The suite verified removal of its three containers, three volumes and network. See [validation limits and corrected failures](docs/portal.md#controlled-validation); hosted final-head review remains a separate delivery gate.

The November 13 [#16 approval](https://github.com/markhuangai/AaA-muse-ai/issues/16), based on `e6d987e6cbcc6275eac8a5e5126677ca6dbaa6dd`, permits worker-management portal engineering and controlled browser/API/PostgreSQL validation. The portal uses the existing list, rename, enrollment, pinned-setup and revocation APIs. Enrollment remains single-use for fifteen minutes; worker credentials remain valid until revoked. Subscriber health, activity and qualification provenance are independent facts. Installed version and independent background wake are explicitly unknown where the APIs do not report them. This exception preserves the inconclusive live verdict and passing-live release gate; it authorizes no live trial, telemetry expansion, deployment, release publication or merge. Codex, configured AI review, all CI and CodeQL are required; CodeRabbit is excluded for #16.

Controlled worker-portal validation passed at `2026-11-13T18:57:20Z` after the independent plan audit returned conformant: 41 receipts and thirteen credential-free screenshots at 1440, 768 and 390 pixels. The approved-base working-source digest was `d4c730d113e988de641141f14b10cb635c0cfbe5c48745f5fb9be657c072476a`; the combined image was `sha256:1ef4455142fc2e024a3ad581dd1ffbe748af52d46a9c3b6b863b8421a1f96b9f`. Rename persistence, enrollment single use and expiry, confirmed revocation, response ordering, outage recovery and log-only diagnosis passed. The suite verified removal of its two containers, two volumes and network. Complete unit coverage and the portal-shell, service, worker-auth and image regressions passed by `2026-11-13T19:01:48Z`. See [validation details](docs/portal.md#controlled-validation); hosted final-head checks and reviews remain separate delivery gates.

The November 13 [#17 approval](https://github.com/markhuangai/AaA-muse-ai/issues/17), based on `2af17b04033fce89706771f96f2580acc6c2c7ca`, permits request-history portal engineering and controlled browser/API/PostgreSQL validation before further live qualification. Requests uses bounded management history queries and conservative cancellation, including unassigned requests. Current agent names are labeled current beside immutable worker IDs. The inconclusive live verdict and passing-live release gate remain; no live trial, broader inference retry, tool execution, deployment, publication or merge is authorized. Codex, configured AI review, CI and CodeQL are required; CodeRabbit is excluded for #17.

Controlled request-history validation passed at `2026-11-13T22:17:06Z` after the independent plan audit returned conformant on round three: 43 safe receipts and thirteen screenshots at 1440, 768 and 390 pixels. Its approved-base working-source digest was `2d558d9d22df4d205240da4b74fd15a61f6e42479abfd8fe494943bc765c2a14`; the combined image was `sha256:ba2a04fbc5c6f5f893b920e772196030b8e504c5b21b8ffdf398d9e3a431954f`. Native/legacy content, tool linkage, instructions, paging, replacement boundaries, cancellation races/uncertainty, expiry, response fencing and log-only diagnosis passed. The suite verified removal of two containers, two volumes and its network. All six unit components separately exceeded 90% raw statement coverage. These controlled results do not qualify live Muse; final-head CI and required reviews remain separate delivery gates.

The November 14 [#42 approval](https://github.com/markhuangai/AaA-muse-ai/issues/42), based on `67785e24f5cb30b95c58e767792ee1cc99f405d3`, permits query-only fixes for NUL-containing management histories and the linked recovery/current-job metadata reads. Fixed metadata uses a temporary parsing copy; retained payloads remain original JSON, including NUL, literal escapes and large numbers. Schema, admission, cursors, fencing, accepted receipts and uncertain busy holds remain unchanged. Codex, complete configured AI review, all CI and CodeQL are required; CodeRabbit is excluded. The owner’s follow-up assigns the remaining Docker-dependent checks to existing PR CI; those checks remain required for completion. Deployment, VNC, live qualification, merge and release publication are deferred, and the passing-live release gate remains.

Controlled NUL-history validation passed in [CI](https://github.com/markhuangai/AaA-muse-ai/actions/runs/43610017152) by `2026-11-14T15:29:48Z` for source `2298bc3ba4ea9b23bb479f9ccb33c10831f66184`, working-source digest `9ab0ddc31e203605e249dadf646c0073868e46ab0c1fe1803a110a33700eed3a`. The portal history suite passed 51 safe receipts, including native/legacy NUL and literal-escape fidelity at 1440, 768 and 390 pixels, malformed-projection diagnosis and cleanup of its two containers, two volumes and network. Its combined image was `sha256:30c78be4247b89f200e12b0c690d559d10e42ca90d582bd822a2ee1ec0cee0fb`. Native history and broker-recovery checks passed, including NUL output receipt replay, accepted tool linkage and uncertain holds; all six unit components separately exceeded 90% raw statement coverage. These controlled results do not qualify live Muse. Final-head CI and required reviews remain separate [PR #43](https://github.com/markhuangai/AaA-muse-ai/pull/43) gates.

The November 14, 2026 owner-approved prerequisite replaces operator package pins with image-owned paired-release metadata, requires equal full service/worker release versions and same-major connection compatibility, and leaves worker upgrades manual. It also permits a single raw database password shared through Compose, with URL construction inside Go. Engineering and controlled validation precede issue #18; the inconclusive live verdict and passing-live gate remain. No publication, merge, deployment or live qualification has been performed by this change.

The same owner-approved plan adds [the combined product runner and staged two-account release matrix](docs/qualification/product.md) for [#18](https://github.com/markhuangai/AaA-muse-ai/issues/18). The prerequisite’s round-six independent audit was conformant at base `b095988e02abb31e1eca97873f9900d88caa1180`. Its service/PostgreSQL, archived `0.1.0-rc.6` worker, current packed worker, installer/recovery and portal-worker browser checks passed by `2026-11-14T22:34:10Z`, using local combined-image ID `sha256:0ca01bdd25e469f7fd3524244e85be3394e681a9bd05f08d4e9949e3d4c28d6d`. An initial browser run failed because the required Playwright Chromium was absent; installing that exact runtime resolved the environment failure. The local direct-container-network option was used; every harness verified its owned container/volume/network cleanup. These prerequisite receipts precede the #18 source changes, do not establish a final same-source validation, and do not qualify live Muse. The new deployment/configuration, authorized account logins and required live evidence remain outstanding.

The owner’s follow-up defers live Muse execution until they confirm the PR is merged and the updated service is deployed. The two private VNC sessions remain available for owner login. Local controlled validation and read-only reviews may continue; neither changes the inconclusive live verdict.

Controlled #18 product validation passed at `2026-11-15T00:29:09Z` for approved base `b095988e02abb31e1eca97873f9900d88caa1180`, working-source digest `43f80f0255b25a21ddb9a5294d94d9a4c84683b53915f7c2c79e69adb4f62d83`: 32 combined portal/installer/packed-worker cases and the adverse Chat/Responses shard. Both shards used identical worker bytes and passed aggregate validation; all six unit components separately exceeded 90% raw statement coverage. The standalone service, native/history/routing/recovery, worker and portal regressions also passed. See the [controlled validation record](docs/qualification/product.md#controlled-validation-record) for artifact identities, corrected failures and limits. Required final-head CI, configured AI review, CodeQL and live Muse evidence remain separate gates; #18 is incomplete.

## Run the service

Requires Docker and Docker Compose. Copy the [example configuration](config.example.yaml):

```sh
sudo install -d -m 0700 -o 10001 -g 10001 ./config
sudo install -m 0600 -o 10001 -g 10001 config.example.yaml ./config/config.yaml
```

Create a private `.env` with real values:

```dotenv
MUSE_SERVICE_IMAGE=ghcr.io/markhuangai/aaa-muse-ai@sha256:<verified-paired-release-digest>
MUSE_MANAGEMENT_KEY=<management-key>
MUSE_PORTAL_PASSWORD=<distinct-portal-password>
```

Use `compose.yaml` in a dedicated project directory with local Docker volumes. Its default HTTP binding is `127.0.0.1:8081`. The operator owns reverse-proxy routing and TLS. The service initializes SQLite on a new named `sqlite` volume and bootstraps it before accepting traffic.

The service and worker are released together with the same full version and source SHA. Same-major workers may connect regardless of minor or patch differences. A different major reports `update_required`; the worker logs manual operator action and never updates itself. Product versions are independent of the existing `protocol_version: 1` wire field. Legacy handshakes without product metadata remain supported only by major-zero services and do not establish an exact installed version.

Worker installation metadata comes from the service image, never `config.yaml`. Setup prompts still verify the exact archive version and trusted SHA-256 before executing code. Read [paired release and manual upgrade](docs/releases.md) before changing versions. Existing `worker-v0.1.0-rc.N` releases remain unchanged; new paired releases use `vVERSION` and include a `product-release.json` receipt. A partial publication is not a complete pair.

After selecting that verified image:

```sh
docker compose config --quiet
docker compose up -d
```

Compose mounts `./config` at `/etc/aaa-muse-ai`. The service uses the writable directory to replace `config.yaml` atomically. When upgrading, use the existing `config.yaml` as the source of the `install` command above and keep the environment values it references, including any configured `MUSE_CLIENT_KEY_A` and `MUSE_CLIENT_KEY_B`. Select an image that supports the new mount layout before starting Compose. You can remove the obsolete `server.public-url` and `limits.max-jobs` entries and the `MUSE_PUBLIC_URL` variable. Open the portal through your HTTPS reverse proxy and allow at least 330 seconds for inference responses.

Create keys in **Settings → Client keys**. Copy a generated value before saving or read a saved value directly from the protected host file. Read the configuration directory with the service UID or administrator authority. Brokers sharing that directory pick up the new client keys on their next request.

If `management.key` is empty, startup prints an automatically generated management key once. Keep it local in a protected header file containing `Authorization: Bearer <management-key>` under a `0700` directory, with file mode `0600`. Never send that key to Muse. Liveness is `GET /healthz`; readiness is `GET /readyz`.

### SQLite state and cutover

The `sqlite` volume mounts `/var/lib/aaa-muse-ai/state`. Keep `broker.sqlite3` and its WAL and shared-memory sidecars together on a local Linux filesystem. Same-host sibling brokers can use the same state directory. All processes must use the same volume and SQLite version. Back up SQLite by stopping all brokers using that volume and copying the complete private state directory. Keep operator config and protected diagnostics separately. Media has its own expiry lifecycle and stays outside database backups.

For the one-time fresh start from a PostgreSQL deployment:

1. Stop submitting work. Let expiring media drain, and save any still-needed worker journal evidence in its protected state directory.
2. Inspect the old Compose project's database container and its mount at `/var/lib/postgresql`. Match the exact database volume to the old project's Compose labels before removing anything. Stop the old service and PostgreSQL container, remove that container, then remove only the verified PostgreSQL volume. The new broker will start without the old registrations, approvals, history and pending jobs.
3. Remove the `database` block from the protected `config.yaml` and remove `POSTGRES_PASSWORD` from the Compose environment. Keep the operator configuration and existing diagnostics volume. Start the verified SQLite image with a new `sqlite` state volume and drained media storage.
4. For a returning worker, retire its old hook and stop its subscriber. Keep the old private directory with its journals. Set a fresh private absolute `XDG_STATE_HOME` when running the original installer with a new single-use enrollment code. Register its returned hook and obtain initial capability approval.

An older config still containing `database` is rejected before any database file is opened. Native worker restart and broker restart within SQLite both retain the new registrations.

## Worker registration

A registration code expires after fifteen minutes and can be used once. Successful enrollment exchanges it for the worker's own credential, which has no automatic expiry. The worker reuses its protected credential and identity across reconnects and worker, service, or database restarts; it does not need a fresh setup code each time.

Management can revoke a registration through `POST /api/v1/admin/workers/{id}/revoke`. Revocation rejects every copy of that credential while retaining registration and history records. Removing local worker state only loses that installation's copy; the server cannot recover it from its stored hash. See [reconnect and removal](worker/README.md#registration-reconnect-and-removal) before replacing or retiring an installation. Registration and connection health remain separate from independently verified inference readiness.

## One-message Muse setup

`POST /api/v1/admin/setup-prompts` takes an HTTPS `origin` and generates the complete installation message with the pinned worker release, setup ID and fresh enrollment code. Sign in over HTTPS and open **Workers** to generate a prompt for the browser’s current origin or select code-only enrollment. The portal keeps enrollment text in memory and clears it on expiry, replacement, session end or leaving Workers.

Set `ORIGIN` to your HTTPS service origin and `ADMIN_HEADER_FILE` to the protected header file. Generate a prompt into a private file:

```sh
umask 077
SETUP_PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/aaa-muse-setup-prompt.XXXXXXXX.json")
curl -fsS --request POST --header @"$ADMIN_HEADER_FILE" \
  --json "$(jq -nc --arg origin "$ORIGIN" '{origin: $origin}')" \
  "$ORIGIN/api/v1/admin/setup-prompts" --output "$SETUP_PROMPT_FILE"
```

Copy the response's entire `setup_prompt` value into Muse as **one message**. Each enrollment code expires after fifteen minutes and can enroll once. Reuse the template with a fresh generated prompt, not an old code. Keep the response private; never include the management key, portal password, model-client key or registry credentials in the Muse message. Existing healthy installations retain their enrolled identity.

The reference below is a placeholder-only copy of the current [generator template](internal/service/setup.go). Use service-generated text for actual installation so its pins and shell quoting stay authoritative. `SETUP_ID` is the response's `enrollment_id`; the worker fields come from `worker_package`. The generator fills in the origin and enrollment code inside `setup_prompt`.

<details>
<summary>Complete installation-message template</summary>

````markdown
Install the scoped AaA Muse worker for the HTTPS origin below, using exactly these pinned public bytes. This authorizes native media generation and scoped artifact delivery, model answers and structured client-tool proposals for this broker's authenticated assignments; it grants no pool administration or client-tool execution authority.

Use your actual shell, site and hook permissions. Present permission cards to the owner and read their actual scope. If a capability or permission is missing or refused, stop and report the actual result; do not bypass it, rewrite the verified package, or invent a native inference API. No GitHub token or manual owner VM shell is needed. Keep the enrollment code private: it is single-use authority expiring 15 minutes after issuance. Never put a durable worker credential in a prompt, URL, hook, task or log.

Before running the bootstrap, check the model name and total context window your Muse setup status reports. Replace only the {} line below with one JSON object containing the available model_name (string) and context_window_tokens (positive integer). Omit unavailable values. Leave {} when neither value is known. Keep quota, current usage and credentials out of this report. Use JSON string escaping and keep the report on one line. This report describes the setup turn.

Run as the same user throughout. The verified installer creates private worker directories at 0700. It clears inherited setgid only on a real, empty 2700 worker directory owned by this user. Shared parent permissions stay under their owner's control. On a directory refusal, preserve the private receipt and report its stage, directory role, cause and observed mode. If hook or skill preparation fails after enrollment, preserve the credential and state. Resume with the verified installer at the same origin and state directory only after correcting the reported cause and confirming the saved worker identity. An uncertain identity needs owner inspection.

Run this Bash bootstrap with tracing disabled. Retain its private evidence directory on failure:

```bash
set +x
set -euo pipefail
umask 077
origin='<SERVICE_HTTPS_ORIGIN>'
url='<WORKER_RELEASE_URL>'
version='<WORKER_VERSION>'
expected='<WORKER_SHA256>'
setup_id='<SETUP_ID>'
if ! work=$(mktemp -d "${TMPDIR:-/tmp}/aaa-muse-setup.XXXXXXXX"); then
  printf '%s\n' '{"level":"ERROR","msg":"setup.bootstrap_capture_failed","cause":"private_directory_unavailable","protected_capture_unavailable":true}' >&2
  exit 1
fi
receipt="$work/bootstrap.ndjson"
if ! { : > "$receipt" && chmod 600 "$receipt"; }; then
  printf '%s\n' '{"level":"ERROR","msg":"setup.bootstrap_capture_failed","cause":"private_receipt_unavailable","protected_capture_unavailable":true}' >&2
  exit 1
fi
event() {
  local line
  line=$(printf '{"level":"%s","msg":"%s","setup_id":"%s","operation_id":"%s","stage":"bootstrap","package_version":"%s","expected_digest":"%s","observed_digest":"%s","execution_started":false}' "$1" "$2" "$setup_id" "$setup_id" "$version" "$expected" "${observed:-}")
  if ! printf '%s\n' "$line" >> "$receipt"; then
    trap - ERR
    printf '{"level":"ERROR","msg":"setup.bootstrap_capture_failed","setup_id":"%s","stage":"bootstrap","cause":"receipt_append_failed","protected_capture_unavailable":true,"execution_started":false}\n' "$setup_id" >&2
    exit 1
  fi
  printf '%s\n' "$line" >&2
}
trap 'event ERROR setup.bootstrap_failed' ERR
event INFO setup.bootstrap_started
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 "$url" --output "$work/worker.tgz"
observed=$(sha256sum "$work/worker.tgz"); observed=${observed%% *}
if [[ "$observed" != "$expected" ]]; then event ERROR setup.digest_mismatch; exit 1; fi
actual_version=$(tar -xOzf "$work/worker.tgz" package/package.json | sed -nE 's/^  "version": "([A-Za-z0-9.+-]+)",?$/\1/p')
actual_name=$(tar -xOzf "$work/worker.tgz" package/package.json | sed -nE 's/^  "name": "([@A-Za-z0-9/_-]+)",?$/\1/p')
if [[ "$actual_version" != "$version" || "$actual_name" != '@markhuangai/aaa-muse-worker' ]]; then event ERROR setup.package_mismatch; exit 1; fi
event INFO setup.archive_verified
tar -xzf "$work/worker.tgz" --no-same-owner --no-same-permissions -C "$work" package/setup/install.sh
bash "$work/package/setup/install.sh" "$work/worker.tgz" "$version" "$expected" "$origin" "$setup_id" "$receipt" <<'AAA_MUSE_ENROLLMENT'
<SINGLE_USE_ENROLLMENT_CODE>
{}
AAA_MUSE_ENROLLMENT
```

Read the installer receipt. Verify its authenticated worker ID and retain the exact hook and skill paths. Call hooks.list with include_disabled:true. Reuse the single enabled hook with this exact script_path and five-second schedule; do not add another. If the existing hook is disabled, conflicting or cannot use five-second checks, report the actual unsupported boundary and stop. Otherwise call the supported hooks.add with this script_path and no script arguments, request five-second checks, and verify the actual registration and interval. The hook includes the supported-refresh recovery candidate; never invent a scheduler or assume its persistence. Stop on missing HATCH_HOOK_RUNTIME or unsupported wake/silent functions. Dry runs must remain side-effect free.

Verify the worker-specific SKILL.md at the returned path, discoverable through muse.skill_search in later conversations. It records only nonsecret scope and mechanics. Read model jobs with job-show. Complete authenticated media actions with media-finish. Use decision-submit for text decisions with the exact job and receipt linkage. Propose client tools as structured JSON; the calling client executes them locally. Do not execute them on this VM or invent results. Connection health, detector emission and model readiness are separate facts.

End this installation turn now. Do not read or answer an inference-readiness challenge during setup. A later independent background wake must prove that behavior. Live Muse permission behavior, five-second wake cadence, persistent paths and supported-refresh reconnection remain unverified until the owner's separate issue #7 trial. Full wipes, account resets and revoked identities are outside recovery authority.
````

</details>

Setup must leave one subscriber, one enabled five-second native hook, and a protected credential file (`0600`) under a private state directory (`0700`). Verify the native hook dry run and enabled state through supported tools. Approve actual permission cards where required; the message cannot grant permissions. End setup before an independent background inference challenge.

Recovery starts only a provably absent subscriber using retained state. The subscriber retries transient connection failures. This does not establish survival of a wipe or independently check connectivity while a process stays alive.

Worker `0.1.0-rc.0` required manual repair of new worker-specific directories that inherited setgid. Skill search also missed the installed skill, so its exact returned path was verified and used. [Historical observations in #7](https://github.com/markhuangai/AaA-muse-ai/issues/7)

## Reference

- [Worker CLI, state, permissions and diagnostics](worker/README.md)
- [Portal sessions, settings and diagnostics](docs/portal.md)
- [Qualification procedure](docs/qualification/README.md)
- [Contributor instructions](AGENTS.md)

Licensed under [Apache-2.0](LICENSE).
