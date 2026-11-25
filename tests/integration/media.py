"""Controlled artifact delivery using the production broker, SQLite and installed packed worker."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import urllib.parse
import json
import os
import secrets
import stat
import struct
import subprocess
import time
from datetime import datetime
from pathlib import Path

from media_mcp import MCPMedia
from product import Product
from service import LABEL, require
from worker_setup import run


def sha(data):
    return hashlib.sha256(data).hexdigest()


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def multipart(fields, image, kind):
    boundary = "aaa-" + secrets.token_hex(16)
    pieces = []
    for k, v in fields.items():
        pieces.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n').encode())
    pieces += [(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="source"\r\nContent-Type: {kind}\r\n\r\n').encode(),
               image, f'\r\n--{boundary}--\r\n'.encode()]
    return b''.join(pieces), {"Content-Type": "multipart/form-data; boundary=" + boundary}


class MediaFlow(MCPMedia, Product):
    def decode_export(self, body):
        script = ('import {readFileSync} from "node:fs"; import {decodeExport} from "./tools/qualification-evidence.mjs"; '
                  'process.stdout.write(JSON.stringify(decodeExport(readFileSync(0, "utf8"))));')
        result = subprocess.run(["node", "--input-type=module", "-e", script], input=body,
                                capture_output=True, timeout=30)
        require(result.returncode == 0, "shared diagnostic decoder rejected media evidence")
        self.assert_private(result.stdout.decode())
        decoded = json.loads(result.stdout)
        return decoded["metadata"], decoded["events"]

    def launch(self, *args, **kwargs):
        if not hasattr(self, "media_volume"):
            self.media_volume = self.volume("media")
            self.media_fixture = self.remember("containers", self.docker("run", "-d", "--label", LABEL + "=" + self.owner,
                "-v", self.media_volume + ":/var/lib/aaa-muse-ai/media", self.tools, "sleep", "86400").stdout.strip())
        return super().launch(*args, **kwargs, media_volume=self.media_volume)

    def render(self, ext, *args):
        path = "/tmp/controlled-" + secrets.token_hex(8) + "." + ext
        self.docker("exec", self.media_fixture, "ffmpeg", "-nostdin", "-v", "error", *args, "-threads", "1", "-y", path)
        return subprocess.run(["docker", "exec", self.media_fixture, "cat", path], check=True, capture_output=True, timeout=30).stdout

    def inputs(self):
        stills = {kind: self.render(ext, "-f", "lavfi", "-i", "color=c=blue:s=64x48", "-frames:v", "1")
                  for kind, ext in (("image/webp", "webp"), ("image/png", "png"), ("image/jpeg", "jpg"))}
        video = self.render("mp4", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=8", "-t", "1", "-c:v", "libx264")
        self.sentinel = ("controlled-binary-" + secrets.token_hex(12)).encode()
        private = (self.sentinel * 250000)[:3900000]
        video += struct.pack(">I4s", 8 + len(private), b"free") + private
        audios = {profile: self.render(ext, "-f", "lavfi", "-i", "sine=frequency=400:duration=0.25", "-c:a", codec)
                  for profile, ext, codec in (("native_mp3", "mp3", "libmp3lame"), ("offline_wav", "wav", "pcm_s16le"))}
        return stills, video, audios

    def worker_media_directory(self, worker, identity, shown):
        directory = Path(shown["output_dir"])
        require(directory.parent == Path("/tmp") and directory.name.startswith("aaa-muse-media-" + identity + "-")
                and Path(shown["output_path"]).parent == directory, "worker media paths are not in the job's system temp directory")
        hosted = worker["home"] / "tmp" / directory.name
        info = hosted.lstat()
        require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid(),
                "worker media directory is not private")
        progress = worker["state"] / "media" / identity / "progress.json"
        require(json.loads(progress.read_text())["temporary_directory"] == str(directory), "durable journal lost the temporary directory")
        return hosted, progress

    def exercise(self):
        self.sibling, self.sibling_origin, _ = self.launch()
        self.ready(self.sibling, self.sibling_origin)
        self.mcp_preflight()
        self.mcp_timeout_contract()
        worker = self.environment("media", mount_system_tmp=True)
        worker["slot"] = "media"
        self.install(worker, self.prompt())
        self.checker(worker)
        self.mcp_text(worker)
        foreign = self.new_worker()
        stills, video, audios = self.inputs()
        prompt = "private-motion-" + secrets.token_hex(20)
        jobs, links = [], {}
        verified_video = None
        for case, image in [*stills.items(), ("prompt_video", None), *audios.items()]:
            motion = "\ufeff" + prompt if case == "prompt_video" else prompt
            fields = {"prompt": motion, "submission_id": secrets.token_hex(16)}
            route = "/api/v1/media/jobs"
            key = self.client
            if case in audios:
                raw, headers, key, route = None, None, self.admin, "/api/v1/admin/media/trials"
                fields = {"submission_id": fields["submission_id"], "profile": case, "owner": "fixture-client",
                          "worker_id": worker["worker"]["id"], "fixture_sha256": sha(image), "fixture_bytes": len(image)}
            elif image:
                fields["timeout_seconds"] = 1800
                raw, headers = multipart(fields, image, case)
            else:
                raw, headers = None, None

            def submit():
                status, _, data = self.api(route, key, "POST", fields, raw=raw, headers=headers)
                require(status == 202, f"{case} admission failed with {status}")
                return json.loads(data)["job_id"]

            if case == "prompt_video":
                identity = self.mcp_call("generate_video", fields)["job_id"]
                pending = self.mcp_call("download_video", {"job_id": identity})
                require(pending.get("retry_after_seconds") == 60 and "download_url" not in pending,
                        "pending video produced a URL")
            else:
                identity = submit()
            require(submit() == identity, "exact retry created a second job")
            url = "/api/v1/media/jobs/" + identity
            grant = self.claim_work(worker, identity)
            if verified_video is not None:
                require(grant["claim_id"] != verified_video and self.status(worker)["current_claim"]["job_id"] == identity,
                        "the worker never pulled another job after the verified video")
                self.add("media.pickup_after_verified_video")
                verified_video = None
            if case == "prompt_video":
                bad_id = "checker-coalesced-run-21a1f1d3"
                self.start_work(worker, self_report=bad_id, want=1)
                require(self.status(worker)["claim_stage"] == "pending_native_start",
                        "misreported checker occurrence disclosed a brief")
            shown = self.start_work(worker)
            spool, progress = self.worker_media_directory(worker, identity, shown)
            output = spool / Path(shown["output_path"]).name
            expected = audios.get(case, video)
            if case in stills:
                require(shown["action"] == "animate_reference" and (spool / Path(shown["reference_path"]).name).read_bytes() == image, "staged reference differs")
            elif case in audios:
                require(shown["action"] == "stage_verified_audio_fixture" and shown["fixture_sha256"] == sha(expected), "unbound audio trial")
                require(self.api(route, self.client, "POST", fields)[0] == 401, "client created an audio trial")
                login = self.checked("/api/v1/portal/login", None, "POST", {"password": self.portal})[0]
                require(self.api(route, login["session_token"], "POST", fields)[0] == 401, "portal authority created an audio trial")
            else:
                require(shown["action"] == "generate_still_then_animate", "missing native two-step action")
                (spool / Path(shown["generated_still_path"]).name).write_bytes(stills["image/webp"])
            if case not in audios:
                require(shown["prompt"] == motion, "motion text changed")
                (spool / "native-thumbnail.webp").write_bytes(stills["image/webp"])
            self.start_work(worker, want=1)
            require(self.api(url, self.other_client)[0] == self.api(url + "/artifact", self.other_client)[0] == 404, "foreign owner read media")
            require(self.api(url + "/artifact", self.client)[0] == 409, "uncommitted artifact downloadable")
            settled = None
            if not jobs:
                delivered_puts, settled = self.adverse_upload(worker, foreign, identity, expected, output)
            else:
                if case == "image/png":
                    extra = (32 << 20) - len(expected)
                    expected += struct.pack(">I4s", extra, b"free") + bytes(extra - 8)
                    self.proxy.slow_media = True
                started = time.monotonic()
                output.write_bytes(expected)
                self.cli(worker, "media-finish", "--job-id", identity)
            self.until(lambda: self.api(url + "/artifact", self.client)[0] == 200, "automatic upload missing", timeout=45)
            if case == "image/png":
                require(time.monotonic() - started >= 11 and len(expected) == 32 << 20 and not self.proxy.slow_media, "slow maximum-size transfer was not exercised")
                self.add("media.slow_maximum_upload", bytes=len(expected))
            if case == "prompt_video":
                links[identity] = self.ready_link(identity, "video", expected)
                self.add("mcp.prompt_video_delivery")
            status = self.checked(url, self.client)[0]
            expected_timeout = 1800 if case in stills else 900
            require(timestamp(status["deadline_at"]) - timestamp(status["created_at"]) == expected_timeout,
                    "stored media deadline differs from submission plus timeout")
            if case in audios:
                require("download_url" not in status, "management trial became shareable")
            properties = status["artifact"]
            kind = "audio/mpeg" if case == "native_mp3" else "audio/wav" if case in audios else "video/mp4"
            require(properties == {"sha256": sha(expected), "size": len(expected), "media_type": kind},
                    "new receipt did not describe the relayed payload")
            require(self.api(url + "/artifact", self.client)[2] == expected and self.api(url + "/artifact", self.other_client)[0] == 404, "owner download integrity or isolation failed")
            if case == "prompt_video":
                execution = {"native_run_id": worker["work"]["native_run_id"]}
                settled = self.tick(worker)
                require(self.proxy.media_puts["/api/v1/worker/jobs/" + identity + "/artifact"] == 1,
                        "foreground media was uploaded again during recovery from run history")
                self.add("media.foreground_video_settled_from_bound_run_history", uploads=1)
                self.verified_video_diagnosis(worker, grant, bad_id, execution)
                verified_video = grant["claim_id"]
            elif settled is None:
                settled = self.tick(worker)
            require(settled["outcome"] == "settled" and not progress.exists(), "worker did not reconcile the confirmed upload")
            if not jobs:
                require(self.proxy.media_puts["/api/v1/worker/jobs/" + identity + "/artifact"] == delivered_puts,
                        "lost acknowledgement recovery sent a second PUT instead of probing the accepted receipt")
            require(sha(output.read_bytes()) == properties["sha256"], "worker did not leave acknowledged media to the system temp lifecycle")
            if case not in audios:
                require((spool / "native-thumbnail.webp").read_bytes() == stills["image/webp"],
                        "worker did not leave native tool files to the system temp lifecycle")
            self.docker("exec", self.media_fixture, "test", "!", "-e", "/var/lib/aaa-muse-ai/media/" + identity + "/prompt")
            self.docker("exec", self.media_fixture, "test", "!", "-e", "/var/lib/aaa-muse-ai/media/" + identity + "/image")
            require(submit() == identity and self.checked(url, self.client)[0]["expires_at"] == status["expires_at"], "retry extended expiry")
            end = timestamp(status["expires_at"])
            require(abs(end - timestamp(status["committed_at"]) - 600) < 0.001, "download lifetime changed")
            jobs.append((identity, end))
            self.add("media." + case, artifact_sha256=sha(expected), bytes=len(expected))
        self.legacy_receipt(jobs[1][0])
        self.limits(stills, prompt)
        self.diagnosis(worker, jobs[0][0], prompt, video)
        mcp_jobs = self.mcp_generated_wav(worker)
        for identity, expires_at, path, _ in mcp_jobs:
            jobs.append((identity, timestamp(expires_at)))
            links[identity] = path
        self.mcp_text(worker, mcp_jobs[-1][2])
        self.cancel_during_upload(worker, video, prompt)
        self.expire(jobs, links)

    def legacy_receipt(self, identity):
        require(len(identity) == 32 and all(char in "0123456789abcdef" for char in identity), "invalid fixture job identity")
        self.sql("UPDATE aaa_inference_jobs SET data = CAST(json_set(CAST(data AS TEXT), "
                 "'$.media.artifact.duration', 1.0, '$.media.artifact.width', 64, '$.media.artifact.height', 48, "
                 "'$.media.artifact.fps', 8, '$.media.artifact.video_frames', 8, "
                 "'$.media.artifact.streams', json('[{\"type\":\"video\",\"codec\":\"h264\"}]')) AS BLOB) "
                 f"WHERE id = '{identity}';")
        artifact = self.checked("/api/v1/media/jobs/" + identity, self.client)[0]["artifact"]
        require((artifact["width"], artifact["height"], artifact["fps"], artifact["video_frames"], artifact["duration"]) ==
                (64, 48, 8, 8, 1.0) and artifact["streams"] == [{"type": "video", "codec": "h264"}],
                "new broker discarded the older measured receipt")
        self.add("media.historical_receipt", dimensions=True, streams=True)

    def reject_digest(self, worker, identity, expected, fence):
        mismatch = sha(expected + b"x")
        headers = {**fence, "X-Muse-Artifact-Sha256": mismatch, "Content-Type": "video/mp4"}
        route = "/api/v1/worker/jobs/" + identity + "/artifact"
        status, reply, body = self.api(route, worker["credential"], "PUT", raw=expected, headers=headers)
        require(status == 422 and json.loads(body)["error"] == "artifact_digest_mismatch",
                "complete upload with incorrect digest was accepted")
        require(self.api("/api/v1/media/jobs/" + identity + "/artifact", self.client)[0] == 409,
                "mismatched bytes were published")
        leftovers = self.docker("exec", self.media_fixture, "find", "/var/lib/aaa-muse-ai/media", "-maxdepth", "1",
                                "-name", ".upload-" + identity + "-*").stdout
        require(not leftovers.strip(), "temporary bytes survived the rejection")
        status, _, raw = self.api("/api/v1/admin/diagnostics/export?operation_id=" + identity, self.admin)
        meta, events = self.decode_export(raw)
        failure = next((event for event in events if event.get("request_id") == reply["X-Request-Id"]
                        and event["msg"] == "media.rejected"), None)
        require(status == 200 and meta["complete"] and failure and failure["level"] == "WARN"
                and failure["operation_id"] == identity and failure["cause"] == "artifact_digest_mismatch"
                and failure["evidence"] == {"stage": "receive", "expected_sha256": mismatch,
                    "observed_sha256": sha(expected), "expected_bytes": len(expected),
                    "observed_bytes": len(expected), "partial_cleanup": "removed"},
                "digest rejection could not be reconstructed from the protected logs")
        self.add("media.digest_rejection", request_id=reply["X-Request-Id"], operation_ids=[identity])

    def adverse_upload(self, worker, foreign, identity, expected, output):
        current = worker["work"]["grant"]
        base = "/api/v1/worker/jobs/" + identity
        fence = {"X-Muse-Generation": str(current["generation"]), "X-Muse-Lease-Id": current["claim_id"]}
        self.checked("/api/v1/media/jobs/" + identity, self.client)
        require(self.api(base + "/media/image", foreign["credential"], headers=fence)[0] == 404, "foreign worker staged source")
        bad = {**fence, "X-Muse-Generation": str(current["generation"] + 1), "X-Muse-Artifact-Sha256": sha(expected), "Content-Type": "video/mp4"}
        status, _, refusal = self.api(base + "/artifact", worker["credential"], "PUT", raw=expected[:128], headers=bad)
        require(status == 409 and json.loads(refusal)["error"] == "stale_assignment", "stale worker published result")
        self.reject_digest(worker, identity, expected, fence)
        with output.open("wb") as oversized:
            oversized.truncate((32 << 20) + 1)
        self.cli(worker, "media-finish", "--job-id", identity, want=1)
        origin = urllib.parse.urlsplit(self.origin_url)
        connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=5)
        try:
            connection.putrequest("PUT", base.replace("/worker/", "/worker/hook/", 1) + "/artifact")
            for k,v in {**self.worker_pair_headers(), **bad, **fence, "Authorization": "Bearer " + worker["credential"],
                        "Content-Length": str(output.stat().st_size)}.items():
                connection.putheader(k,v)
            connection.endheaders()
            response = connection.getresponse()
            require(response.status == 413 and json.loads(response.read())["error"] == "media_too_large", "over-limit artifact accepted by HTTP")
        finally:
            connection.close()
        require(output.stat().st_size == (32 << 20) + 1 and self.api("/api/v1/media/jobs/" + identity + "/artifact", self.client)[0] == 409, "oversized upload was published or worker file erased")
        self.proxy.interrupt_media = True
        output.write_bytes(expected)
        self.cli(worker, "media-finish", "--job-id", identity, want=1)
        require(self.proxy.media_interrupted.wait(35) and output.read_bytes() == expected, "worker lost interrupted upload")
        require(self.api("/api/v1/media/jobs/" + identity + "/artifact", self.client)[0] == 409, "partial upload published")
        self.proxy.lose_media_ack = True
        self.proxy.interrupt_media = False
        route = base + "/artifact"
        self.proxy.media_release.clear()
        self.proxy.media_finished.clear()
        self.proxy.media_pause_path = route
        before_puts = self.proxy.media_puts.get(route, 0)
        before_poll = self.status(worker)["last_poll_at"]
        with ThreadPoolExecutor(max_workers=1) as worker_thread:
            transfer = worker_thread.submit(self.cli, worker, "media-finish", "--job-id", identity, want=1)
            try:
                self.wait_upload_started(identity)
                busy = self.tick(worker)
                require(busy["outcome"] == "claim_active" and busy["cause"] == "result_delivery_active", "checker did not return while the original uploader was active")
                require(self.tick(worker)["outcome"] == "claim_active", "hook released the surviving uploader")
                require(not transfer.done() and self.proxy.media_puts[route] == before_puts + 1 and self.status(worker)["last_poll_at"] == before_poll,
                        "busy check blocked, duplicated the upload, or performed a pull")
            finally:
                self.proxy.media_release.set()
            transfer.result()
        self.proxy.media_pause_path = None
        require(self.proxy.media_ack_lost.wait(35), "committed acknowledgement loss missed")
        recovered = self.tick(worker)
        require(recovered["outcome"] == "settled" and self.api("/api/v1/media/jobs/" + identity + "/artifact", self.client)[2] == expected,
                "saved upload did not reconcile the exact bytes without granting new work")
        self.add("media.interruption_and_fencing", busy_pull_count=0, competing_upload_count=0)
        return before_puts + 1, recovered

    def wait_upload_started(self, identity):
        self.until(lambda: bool(self.docker("exec", self.media_fixture, "find", "/var/lib/aaa-muse-ai/media", "-maxdepth", "1", "-name", ".upload-" + identity + "-*").stdout.strip()),
                   "transfer never passed broker preflight", timeout=35)

    def limits(self, stills, prompt):
        path = "/api/v1/media/jobs"
        fields = {"submission_id": secrets.token_hex(16), "prompt": prompt}
        require(self.api(path, self.client, "POST", {**fields, "prompt": "x" * 4097})[0] == 413, "prompt limit missed")
        raw, headers = multipart(fields, stills["image/png"] + bytes(8 << 20), "image/png")
        require(self.api(path, self.client, "POST", raw=raw, headers=headers)[0] == 413, "image byte limit missed")
        large = self.render("png", "-f", "lavfi", "-i", "color=c=white:s=4100x4000", "-frames:v", "1")
        raw, headers = multipart(fields, large, "image/png")
        require(self.api(path, self.client, "POST", raw=raw, headers=headers)[0] == 422, "image pixel limit missed")
        for invalid in ("", "0", "-1", "3601", "1.5", "null", "true"):
            raw, headers = multipart({**fields, "timeout_seconds": invalid}, stills["image/png"], "image/png")
            require(self.api(path, self.client, "POST", raw=raw, headers=headers)[0] == 400, "multipart accepted an invalid timeout")
        self.add("media.admission_limits")

    def cancel_during_upload(self, worker, expected, prompt):
        identity = self.checked("/api/v1/media/jobs", self.client, "POST", {"prompt": prompt, "submission_id": secrets.token_hex(16)}, want=202)[0]["job_id"]
        self.claim_work(worker, identity)
        shown = self.start_work(worker)
        spool, _ = self.worker_media_directory(worker, identity, shown)
        output = spool / Path(shown["output_path"]).name
        output.write_bytes(expected)
        self.proxy.media_release.clear()
        self.proxy.media_finished.clear()
        self.proxy.media_pause_path = "/api/v1/worker/jobs/" + identity + "/artifact"
        with ThreadPoolExecutor(max_workers=1) as worker_thread:
            transfer = worker_thread.submit(self.cli, worker, "media-finish", "--job-id", identity, want=1)
            try:
                self.wait_upload_started(identity)
                self.checked("/api/v1/admin/experiments/" + identity + "/cancel", self.admin, "POST", {"protocol_version": 1, "submission_id": secrets.token_hex(16)})
            finally:
                self.proxy.media_release.set()
            transfer.result()
        require(self.proxy.media_finished.wait(25) and self.proxy.media_status == 409, "commit-time fence missed cancellation")
        status = self.checked("/api/v1/worker/status", worker["credential"])[0]
        require(status["claim_stage"] == "recovery_pending" and status["current_claim"]["job_id"] == identity and
                output.read_bytes() == expected, "lost uncertain hold or local output")
        require(self.api("/api/v1/media/jobs/" + identity + "/artifact", self.client)[0] == 409, "cancelled stream published")
        cancelled = self.mcp_call("download_video", {"job_id": identity})
        require(cancelled["status"] == "cancelled" and cancelled.get("reason") and
                "download_url" not in cancelled and "retry_after_seconds" not in cancelled,
                "terminal cancellation did not end MCP polling")
        _, events = self.decode_export(self.api("/api/v1/admin/diagnostics/export?operation_id=" + identity, self.admin)[2])
        require(any(e["msg"] == "lease.fenced" and e.get("evidence", {}).get("busy_hold") is True for e in events), "missing commit-time fence diagnosis")
        self.proxy.media_pause_path = None
        self.abort(worker)
        require(self.tick(worker)["outcome"] == "settled" and output.read_bytes() == expected, "fenced upload did not settle after verified stop")
        self.add("media.cancel_during_upload")

    def diagnosis(self, worker, identity, prompt, original):
        status, _, raw = self.api("/api/v1/admin/diagnostics/export?operation_id=" + identity, self.admin)
        meta, events = self.decode_export(raw)
        require(status == 200 and meta["complete"] and not meta["omissions"], "broker evidence incomplete")
        boundaries = {e["msg"]: e for e in events if e["msg"] in ("media.submitted", "job.claimed", "job.work_started", "media.committed")}
        submission = boundaries["media.submitted"]
        require(len(boundaries) == 4 and all(e["level"] == "INFO" and e["job_id"] == identity and
                e["deadline_at"] == submission["deadline_at"] for e in boundaries.values()) and
                submission["timeout_seconds"] == 1800 and submission["client_id"] == "fixture-client" and
                timestamp(submission["deadline_at"]) - timestamp(submission["created_at"]) == 1800,
                "submission, claim, start and commit did not reconstruct the same media deadline")
        logs = self.logs(self.broker)
        require('"level":"DEBUG"' not in logs and all(f'"msg":"{name}"' in logs for name in boundaries),
                "INFO output omitted media progress or exposed protected DEBUG evidence")
        committed = next(e for e in events if e["msg"] == "media.committed")
        require(committed["artifact"]["size"] > 3_000_000 and any(e["msg"] == "lease.fenced" or e.get("cause") == "stale_assignment" for e in events), "fence and commit cannot be diagnosed")
        interrupted = next(e for e in events if e["msg"] == "media.rejected" and e.get("cause") == "artifact_transfer_interrupted")
        evidence = interrupted["evidence"]
        half = original[:len(original) // 2]
        require(evidence["expected_bytes"] == len(original) and evidence["observed_bytes"] == len(half)
                and evidence["expected_sha256"] == sha(original) and evidence["observed_sha256"] == sha(half)
                and evidence["stage"] == "receive" and evidence["partial_cleanup"] == "removed" and interrupted.get("request_id")
                and interrupted["level"] == "ERROR",
                "interrupted transfer cannot be reconstructed from broker diagnostics")
        worker_log = self.cli(worker, "diagnostics-export", "--operation-id", identity, "--decode").stdout
        require("worker.media_upload_confirmed" in worker_log and "worker.media_transfer_pending" in worker_log, "missing worker diagnosis")
        for capture in [json.dumps(events), worker_log]:
            require(prompt not in capture and self.sentinel.decode() not in capture, "raw media content retained")
        self.add("media.private_diagnostics")

    def expire(self, jobs, links):
        last, deadline = jobs[-1]
        url = "/api/v1/media/jobs/" + last + "/artifact"
        require(self.api(url, self.client)[0] == 200, "file unavailable before expiry")
        path = links[last]
        self.docker("stop", "-t", "2", self.sibling)
        self.docker("start", self.sibling)
        self.sibling_origin = self.origin(self.sibling)
        self.ready(self.sibling, self.sibling_origin)
        require(self.api(path, origin=self.sibling_origin)[0] == 200, "restart lost the published token")
        directory = "/var/lib/aaa-muse-ai/media/" + last
        # Hold the file on disk while the application crosses its receipt expiry.
        self.docker("exec", self.media_fixture, "chmod", "0500", directory)
        try:
            time.sleep(max(0, deadline - time.time() + 0.1))
            self.docker("exec", self.media_fixture, "test", "-f", directory + "/artifact")
            code, headers, _ = self.proxy_exchange(path)
            require(code == self.api(path, origin=self.sibling_origin)[0] == 404,
                    "an expired link was served while the file remained on disk")
            self.mcp_rejection(headers["X-Request-Id"], "media.link_rejected", "artifact_expired", last)
            expired = self.mcp_call("download_wav", {"job_id": last})
            require(expired["status"] == "expired" and "download_url" not in expired, "expired job retained a download URL")
        finally:
            self.docker("stop", "-t", "2", self.sibling)
            self.docker("exec", self.media_fixture, "chmod", "0700", directory)
        self.docker("stop", "-t", "2", self.broker)
        self.docker("start", self.broker)
        self.origin_url = self.origin(self.broker)
        self.proxy.target = urllib.parse.urlsplit(self.origin_url)
        self.ready(self.broker, self.origin_url)
        for path in links.values():
            require(self.proxy_exchange(path)[0] == 404, "expired or deleted artifacts remained downloadable after restart")
        for identity, _ in jobs:
            route = "/api/v1/media/jobs/" + identity
            require(self.api(route + "/artifact", self.client)[0] == 410 and self.api(route, self.client)[0] == 200, "restart lost receipt or served expired media")
            self.docker("exec", self.media_fixture, "test", "!", "-e", "/var/lib/aaa-muse-ai/media/" + identity)
        self.add("media.expiry_across_restart", window_seconds=600)
        self.add("mcp.expiry_before_cleanup", brokers=2)

    def verified_video_diagnosis(self, worker, grant, bad_id, execution):
        operation = grant["operation_id"]
        worker_raw = self.native_cli(worker, "diagnostics-export", "--operation-id", operation, "--decode")
        self.assert_private(worker_raw)
        metadata, *local = [json.loads(line) for line in worker_raw.splitlines()]
        require(metadata["complete"] and not metadata["omissions"], "worker verification evidence is incomplete")
        rejected = next(event for event in local if event.get("cause") == "hook_run_mismatch")
        started = [event for event in local if event.get("msg") == "hook.work_started"]
        settled = [event for event in local if event.get("msg") == "cron.work_settled"]
        require(rejected["level"] == "WARN" and rejected["claim_id"] == grant["claim_id"] and
                len(started) == len(settled) == 1 and started[0]["level"] == settled[0]["level"] == "INFO",
                "logs did not identify the refused execution and single accepted start")
        for name, event in (("job.work_started", started[0]), ("job.work_settled", settled[0])):
            status, _, body = self.api("/api/v1/admin/diagnostics/export?request_id=" + event["request_id"], self.admin)
            envelope, events = self.decode_export(body)
            require(status == 200 and envelope["complete"] and not envelope["omissions"], "broker verification evidence is incomplete")
            remote = next(value for value in events if value.get("msg") == name)
            require(all(remote[key] == event[key] for key in ("claim_id", "launch_id", "native_job_id", "native_run_id")) and
                    remote["native_run_id"] == execution["native_run_id"], "protected exports could not join verified start to settlement")
        self.add("media.native_start_identity_verified", rejected_without_brief=True, protected_evidence=True)


if __name__ == "__main__":
    harness = run(MediaFlow, "media")
    receipt = Path(".artifacts/ci/media/receipt.json")
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({"source_sha": harness.args.source_sha, "package_sha256": harness.package["sha256"],
                                  "cases": harness.product_cases, "cleanup": json.loads((harness.root / "cleanup.json").read_text()),
                                  "evidence_kind": "controlled", "outcome": "passed"}, indent=2))
