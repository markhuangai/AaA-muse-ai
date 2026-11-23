"""MCP contract checks against the packed worker and shared media broker."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import http.client
import json
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from inference import PullPeer
from service import require


class MCPMedia:
    def mcp_call(self, name="", args=None, key=None, offline=False):
        fixture = {"endpoint": self.proxy.origin + "/mcp", "cert": str(self.proxy.cert),
                   "key": self.client if key is None else key, "tool": name, "arguments": args or {}}
        result = subprocess.run([".artifacts/integration-tools/mcp-client"], input=json.dumps(fixture),
                                capture_output=True, text=True, timeout=75)
        if offline:
            require(result.returncode == 1, "transport did not observe the lost MCP reply")
            return None
        if result.returncode:
            self.private("mcp-exchange-failed.txt", result.stderr)
        require(result.returncode == 0, "MCP SDK call failed")
        exchange = json.loads(result.stdout)
        response = exchange["result"]
        if not name:
            return response["tools"]
        result = {"error": response["content"][0]["text"]} if response.get("isError") else response["structuredContent"]
        return {**result, "_request_id": exchange["request_id"]}

    def proxy_exchange(self, path, *, key=None, data=None, headers=None):
        request_headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **(headers or {})}
        if key:
            request_headers["Authorization"] = "Bearer " + key
        request = urllib.request.Request(self.proxy.origin + path, headers=request_headers,
                                         data=None if data is None else json.dumps(data).encode())
        try:
            response = urllib.request.urlopen(request, context=ssl.create_default_context(cafile=self.proxy.cert), timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    @staticmethod
    def link_path(link):
        return urllib.parse.urlsplit(link).path

    def ready_link(self, identity, kind, body):
        route = "/api/v1/media/jobs/" + identity
        with ThreadPoolExecutor(max_workers=2) as clients:
            pending = clients.submit(self.mcp_call, "download_" + kind, {"job_id": identity})
            netloc = urllib.parse.urlsplit(self.proxy.origin).netloc
            status = self.api(route, self.client, origin=self.sibling_origin, headers={"Host": netloc, "X-Forwarded-Host": "ignored.invalid"})
            polled = pending.result()
        require(status[0] == 200, "sibling could not poll owned media")
        rest = json.loads(status[2])
        link = polled.get("download_url", "")
        require(link == rest.get("download_url") and polled["expires_at"] == rest["expires_at"] and
                link.startswith(self.proxy.origin + "/downloads/" + identity + "/"), "cross-broker ready link or origin differs")
        path = self.link_path(link)
        require(re.fullmatch(r"/downloads/[0-9a-f]{32}/muse_download_[A-Za-z0-9_-]{43}", path), "incorrect link credential shape")
        self.secrets.append(path.rsplit("/", 1)[-1])
        code, headers, actual = self.proxy_exchange(path)
        require(code == 200 and actual == body and headers["Cache-Control"] == "no-store"
                and headers["Content-Disposition"].endswith(".wav" if kind == "wav" else ".mp4"),
                "anonymous TLS download changed bytes or headers")
        require(self.api(path, origin=self.sibling_origin)[2] == body, "sibling could not open the link")
        other = ("A" if path[-4] != "A" else "B")
        altered = path[:-4] + other + path[-3:]
        self.secrets.append(altered.rsplit("/", 1)[-1])
        for bad in (altered, path + "?extra=1"):
            code, headers, _ = self.proxy_exchange(bad)
            require(code == 404, "invalid link became usable")
            self.mcp_rejection(headers["X-Request-Id"], "media.link_rejected", "download_link_invalid", identity)
        foreign = self.mcp_call("download_" + kind, {"job_id": identity}, key=self.other_client)
        require(foreign.get("error") == "media_not_found", "second owner received download access")
        self.mcp_rejection(foreign["_request_id"], "mcp.tool_rejected", "media_not_found", identity, "other-client")
        other_kind = "wav" if kind == "video" else "video"
        wrong = self.mcp_call("download_" + other_kind, {"job_id": identity})
        require(wrong.get("error") == "media_not_found", "wrong media tool exposed a link")
        event = self.mcp_rejection(wrong["_request_id"], "mcp.tool_rejected", "media_not_found", identity, "fixture-client")
        require(event["evidence"]["expected_type"] != ("video/mp4" if kind == "video" else "audio/wav"),
                "wrong-format diagnosis lost the expected type")
        return path

    def mcp_preflight(self):
        tools = {tool["name"]: tool for tool in self.mcp_call()}
        require(set(tools) == {"ask_muse", "generate_wav", "generate_video", "download_wav", "download_video"},
                "MCP discovery exposed the wrong tools")
        for name, tool in tools.items():
            schema = tool["inputSchema"]
            timeout = schema.get("properties", {}).get("timeout_seconds")
            if name in ("generate_video", "generate_wav"):
                require(timeout is not None and timeout["type"] == "integer" and timeout["default"] == 900 and
                        timeout["minimum"] == 1 and timeout["maximum"] == 3600 and "timeout_seconds" not in schema["required"],
                        "MCP generation discovery lost the optional timeout bounds")
                require("deadline_at" in tool["outputSchema"]["properties"], "MCP generation discovery omitted the deadline")
            else:
                require(timeout is None, "unrelated MCP tool advertised a media timeout")
        # The explicit older protocol handshake also checks the wire cache policy.
        initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                      "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                                 "clientInfo": {"name": "controlled-media", "version": "1"}}}
        for key in (None, self.admin, self.portal):
            status, headers, _ = self.proxy_exchange("/mcp", key=key, data=initialize)
            require(status == 401, "non-client authority connected to MCP")
            self.mcp_rejection(headers["X-Request-Id"], "auth.denied", "role_not_permitted")
        status, headers, _ = self.proxy_exchange("/mcp", key=self.client, data=initialize, headers={"Origin": self.proxy.origin})
        require(status == 200 and headers["Cache-Control"] == "no-store" and headers.get("Mcp-Session-Id") is None,
                "MCP handshake was cached or created a sticky session")
        status, headers, _ = self.proxy_exchange("/mcp", key=self.client, data=initialize, headers={"Origin": "https://untrusted.invalid"})
        require(status == 403, "cross-origin MCP was accepted")
        self.mcp_rejection(headers["X-Request-Id"], "mcp.request_rejected", "invalid_origin", owner="fixture-client")
        status, headers, _ = self.proxy_exchange("/mcp", key=self.client, data=initialize, headers={"Host": "untrusted.invalid"})
        require(status == 403 and headers.get("X-Request-Id") is None and
                {"event": "fixture.host_rejected", "route": "/mcp", "forwarded": False} in self.proxy.events,
                "proxy failed to reject and record an unconfigured host")
        video_only = PullPeer(self, self.new_worker())
        result = self.mcp_call("generate_wav", {"prompt": "controlled WAV", "submission_id": secrets.token_hex(16)})
        require(result.get("status") == "queued" and video_only.poll(media_jobs=True) is None,
                "media admission required presence or granted a WAV to a video-only worker")
        self.checked("/api/v1/admin/experiments/" + result["job_id"] + "/cancel", self.admin, "POST",
                     {"protocol_version": 1, "submission_id": secrets.token_hex(16)})
        self.add("mcp.discovery_authority_and_worker_capability")

    def mcp_timeout_contract(self):
        route = "/api/v1/media/jobs"
        fields = {"prompt": "private-media-timeout-" + secrets.token_hex(16), "submission_id": secrets.token_hex(16)}
        for seconds in (0, -1, 3601, 1.5, None, True, "60", {"seconds": 60}):
            args = {**fields, "timeout_seconds": seconds}
            result = self.mcp_call("generate_video", args)
            require(result.get("error") == "invalid_media_timeout", "MCP accepted an invalid timeout")
            event = self.mcp_rejection(result["_request_id"], "mcp.tool_rejected", "invalid_media_timeout", owner="fixture-client")
            require(event["evidence"] == {"field": "timeout_seconds", "minimum": 1, "maximum": 3600},
                    "MCP rejection omitted the applicable timeout policy")
            status, headers, body = self.api(route, self.client, "POST", args)
            require(status == 400 and json.loads(body)["error"] == "invalid_media_timeout", "JSON accepted an invalid timeout")
            self.mcp_rejection(headers["X-Request-Id"], "media.rejected", "invalid_media_timeout", owner="fixture-client")

        for seconds in (1, 3600):
            args = {**fields, "submission_id": secrets.token_hex(16), "timeout_seconds": seconds}
            job = self.mcp_call("generate_video", args)
            status = self.checked(route, self.client, "POST", args, want=202, origin=self.sibling_origin)[0]
            identity = job["job_id"]
            deadline = status["deadline_at"]
            require(status["job_id"] == identity and job["deadline_at"] == deadline and
                    (datetime.fromisoformat(deadline) - datetime.fromisoformat(status["created_at"])).total_seconds() == seconds,
                    "cross-broker HTTP and MCP retries changed the submitted deadline")
            require(self.mcp_call("download_video", {"job_id": identity})["deadline_at"] == deadline, "MCP polling changed the deadline")
            require(self.api(route, self.client, "POST", {**args, "timeout_seconds": 900}, origin=self.sibling_origin)[0] == 409,
                    "a changed media timeout reused an existing submission")
            if seconds == 1:
                def expired():
                    view = self.checked(route + "/" + identity, self.client)[0]
                    return view["status"] == "interrupted" and view.get("reason") == "deadline_exceeded"

                self.until(expired, "queued media did not expire under its one-second deadline", timeout=10)

                def expiry_captured():
                    events = self.mcp_diagnostic("operation_id", identity, self.origin_url)
                    events.extend(self.mcp_diagnostic("operation_id", identity, self.sibling_origin))
                    expiry = next((event for event in events if event["msg"] == "job.deadline_exceeded"), None)
                    if expiry is None:
                        return False
                    require(expiry["level"] == "ERROR" and expiry["reason"] == "deadline_exceeded" and
                            expiry["deadline_at"] == deadline and expiry["busy_hold"] is False,
                            "the protected expiry record did not explain the queued deadline failure")
                    return True

                # The committing broker records the event after the shared state becomes visible.
                self.until(expiry_captured, "neither broker exported the queued media expiry", timeout=10)
            else:
                self.cancel(identity)
        self.add("media.timeout_bounds_cross_transport_and_diagnostics")

    def mcp_generated_wav(self, worker):
        jobs = []
        for frequency in (385, 526):
            fields = {"prompt": "private-audio-brief-" + secrets.token_hex(16) + f" tone at {frequency} Hz",
                      "submission_id": secrets.token_hex(16)}
            if frequency == 526:
                fields["timeout_seconds"] = 1800
            job = self.mcp_call("generate_wav", fields)
            identity = job["job_id"]
            status = self.checked("/api/v1/media/jobs", self.client, "POST", {**fields, "format": "wav"}, want=202,
                                  origin=self.sibling_origin)[0]
            require(status["job_id"] == identity and job["status"] == "queued" and job["deadline_at"] == status["deadline_at"] and
                    (datetime.fromisoformat(status["deadline_at"]) - datetime.fromisoformat(status["created_at"])).total_seconds() ==
                    fields.get("timeout_seconds", 900), "cross-interface WAV retry changed the job or deadline")
            changed = self.mcp_call("generate_video", fields)
            require(changed.get("error") == "submission_conflict", "changed-format submission did not conflict")
            self.mcp_rejection(changed["_request_id"], "mcp.tool_rejected", "submission_conflict", owner="fixture-client")
            pending = self.mcp_call("download_wav", {"job_id": identity})
            require(pending.get("retry_after_seconds") == 60 and "download_url" not in pending and
                    pending["deadline_at"] == job["deadline_at"], "pending audio changed the deadline or exposed a URL")
            self.claim_work(worker, identity)
            shown = self.start_work(worker)
            spool, progress = self.worker_media_directory(worker, identity, shown)
            output = spool / Path(shown["output_path"]).name
            require(shown["action"] == "generate_wav_from_prompt" and shown["prompt"] == fields["prompt"]
                    and output.name == "result.wav" and "fixture_sha256" not in shown, "Muse did not receive the caller's generation brief")
            if not jobs:
                self.reject_malformed_wav(worker, identity)
            expected = self.render("wav", "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration=0.25", "-c:a", "pcm_s16le")
            output.write_bytes(expected)
            self.cli(worker, "media-finish", "--job-id", identity)
            require(self.observe(worker, "completed")["outcome"] == "settled" and not progress.exists(), "WAV acknowledgement did not settle the native claim")
            path = self.ready_link(identity, "wav", expected)
            view = self.checked("/api/v1/media/jobs/" + identity, self.client)[0]
            digest = hashlib.sha256(expected).hexdigest()
            require(view["artifact"]["sha256"] == digest and view["artifact"]["media_type"] == "audio/wav",
                    "verified WAV receipt differs")
            capture = self.mcp_diagnostic("operation_id", identity, self.origin_url)
            require(any(e["msg"] == "media.committed" and e["artifact"]["sha256"] == digest for e in capture)
                    and fields["prompt"] not in json.dumps(capture), "missing WAV receipt evidence or raw prompt retained")
            jobs.append((identity, view["expires_at"], path, digest))
        require(jobs[0][3] != jobs[1][3], "distinct prompts produced identical controlled WAV bytes")
        self.add("mcp.prompt_wav_delivery", artifacts=len(jobs))
        return jobs

    def reject_malformed_wav(self, worker, identity):
        route = "/api/v1/worker/jobs/" + identity
        assigned = worker["work"]["grant"]
        require(assigned["job_id"] == identity, "malformed upload fixture lost its native claim")
        bad = b"controlled bytes without a WAV container"
        headers = {"X-Muse-Generation": str(assigned["generation"]), "X-Muse-Lease-Id": assigned["claim_id"],
                   "X-Muse-Artifact-Sha256": hashlib.sha256(bad).hexdigest(), "Content-Type": "audio/wav"}
        status, reply, _ = self.proxy_exchange_bytes(route + "/artifact", worker["credential"], bad, headers)
        require(status == 422, "non-WAV bytes published as WAV")
        events = self.mcp_diagnostic("request_id", reply["X-Request-Id"], self.origin_url)
        failure = next((e for e in events if e["msg"] == "media.rejected" and e.get("cause") == "invalid_media_format"), None)
        require(failure and failure["level"] == "WARN" and failure["operation_id"] == identity
                and failure["worker_id"] == worker["worker"]["id"] and failure["evidence"]["stage"] == "inspect",
                "malformed WAV could not be diagnosed from the transfer logs")
        self.mcp_diagnostic("operation_id", identity, self.origin_url)
        worker_logs = self.cli(worker, "diagnostics-export", "--operation-id", identity, "--decode").stdout
        require("worker.media_prepared" in worker_logs, "worker omitted the failed WAV assignment from its export")
        self.assert_private(worker_logs)

    def proxy_exchange_bytes(self, path, key, body, headers):
        endpoint = urllib.parse.urlsplit(self.proxy.origin)
        connection = http.client.HTTPSConnection(endpoint.hostname, endpoint.port,
            context=ssl.create_default_context(cafile=self.proxy.cert), timeout=15)
        try:
            connection.request("PUT", path, body, {**headers, "Authorization": "Bearer " + key})
            result = connection.getresponse()
            return result.status, result.headers, result.read()
        finally:
            connection.close()

    def mcp_diagnostic(self, selector, identity, origin):
        status, _, body = self.api("/api/v1/admin/diagnostics/export?" + selector + "=" + identity, self.admin, origin=origin)
        metadata, events = self.decode_export(body)
        require(status == 200 and metadata["complete"] and not metadata["omissions"], "incomplete MCP diagnostic capture")
        return events

    def mcp_rejection(self, request_id, name, cause, operation=None, owner=None):
        events = self.mcp_diagnostic("request_id", request_id, self.origin_url)
        event = next((e for e in events if e["msg"] == name and e.get("cause", e.get("reason")) == cause), None)
        require(event is not None and event["level"] == "WARN" and event["request_id"] == request_id,
                "rejected MCP boundary omitted its cause from the protected export")
        if owner:
            require(event["client_id"] == owner, "rejected MCP boundary omitted its owner")
        if operation:
            require(event["operation_id"] == operation and
                    any(e.get("job_id") == operation for e in self.mcp_diagnostic("operation_id", operation, self.origin_url)),
                    "rejected MCP boundary lost its job correlation")
        return event

    def mcp_text(self, worker, secret_path=None):
        prompt = "controlled text echo" if secret_path else "Connection check. Reply with exactly: pong"
        fields = {"prompt": prompt, "submission_id": secrets.token_hex(16)}
        final_text = prompt + " " + secret_path.rsplit("/", 1)[-1] if secret_path else "pong"
        self.proxy.lose_mcp_reply = bool(secret_path)
        require(not self.status(worker)["qualification_history"], "MCP regression assumes a fresh unqualified worker")
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=1) as client:
            pending = client.submit(self.mcp_call, "ask_muse", fields, offline=bool(secret_path))
            grants = []

            def pulled():
                grant = self.tick(worker)
                if grant["outcome"] == "prepare":
                    grants.append(grant)
                    return True
                require(grant["outcome"] == "idle", "MCP controlled checker was not available")
                return False

            self.until(pulled, "MCP text work did not reach the packed worker", timeout=15)
            grant, = grants
            identity = grant["job_id"]
            self.work_definition(worker, grant)
            view = self.start_work(worker)
            request_id = view["operation_id"]
            require(view["context"]["messages"] == [{"type": "message", "role": "user", "text": fields["prompt"]}]
                    and view["context"]["tools"] == [], "MCP text changed the prompt or enabled host tools")
            if secret_path:
                time.sleep(max(0, 32 - (time.monotonic() - started)))
            self.cli(worker, "decision-submit", "--job-id", identity, "--input", "-",
                     input_text=json.dumps({"type": "final", "text": final_text}))
            require(self.observe(worker, "completed")["outcome"] == "settled", "MCP text worker did not settle its native claim")
            first = pending.result()
        if secret_path:
            require(self.proxy.mcp_reply_lost.is_set(), "five-minute MCP route failed before the ordinary write timeout")
        else:
            require(first["text"] == "pong" and first["request_id"] == request_id, "first call did not complete on a fresh worker")
        answer = self.mcp_call("ask_muse", fields)
        require(answer["request_id"] == request_id and answer["text"] == final_text, "lost reply re-executed or changed the accepted answer")
        http_events = self.mcp_diagnostic("request_id", answer["_request_id"], self.origin_url)
        require(any(e.get("operation_id") == request_id and e["msg"] == "mcp.text_admitted" for e in http_events),
                "text replay omitted its original operation correlation")
        evidence = self.mcp_diagnostic("operation_id", request_id, self.origin_url)
        names = {item["msg"] for item in evidence if item["level"] == "INFO"}
        require({"decision.accepted", "request.output_started", "request.output_completed"} <= names
                and sum(e["msg"] == "job.claimed" for e in evidence) == 1, "MCP text delivery boundary or exact replay is missing")
        self.assert_private(self.logs(self.broker))
        self.assert_private(self.logs(self.sibling))
        self.assert_private(self.cli(worker, "diagnostics-export", "--operation-id", request_id, "--decode").stdout)
        if secret_path:
            self.add("mcp.delayed_text_and_lost_reply", delay_seconds=32)
        else:
            self.add("mcp.first_text_without_qualification", one_claim=True, replay_preserved=True)
