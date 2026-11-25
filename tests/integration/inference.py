#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import threading
import time
import urllib.parse

from native_cron import usage_header
from service import require
from worker_auth import WorkerAuth


class Peer:
    def __init__(self, harness, worker, reply=True, headers=None):
        self.harness, self.worker, self.reply = harness, worker, reply
        self.headers = headers or {}
        self.condition = threading.Condition()
        self.events, self.errors, self.replies = [], [], []
        self.idle_ack = None
        self.stopping = False
        self.connection = None
        self.socket = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()
        self.opened = self.wait("connection.opened")
        if self.reply:
            self.harness.until(lambda: self.harness.status(self.worker)["connection_status"] == "online", "worker never answered initial health challenge")
        return self

    def run(self):
        try:
            origin = urllib.parse.urlsplit(self.harness.origin_url)
            self.connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=45)
            self.connection.request("GET", "/api/v1/worker/events", headers={**self.headers, "Authorization": "Bearer " + self.worker["credential"]})
            response = self.connection.getresponse()
            require(response.status == 200, "SSE subscription rejected")
            self.request_id = response.getheader("X-Request-Id")
            self.socket = self.connection.sock
            event_type, event_id, data = None, None, None
            while not self.stopping:
                line = response.readline()
                if not line:
                    break
                line = line.decode().rstrip("\r\n")
                if line.startswith("event: "):
                    event_type = line[7:]
                elif line.startswith("id: "):
                    event_id = line[4:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                elif line == "" and data is not None:
                    with self.condition:
                        self.events.append({"type": event_type, "id": event_id, "data": data, "at": time.monotonic()})
                        self.condition.notify_all()
                    if event_type == "health.challenge" and self.reply:
                        payload = {"protocol_version": 1, "connection_id": data["connection_id"], "connection_generation": data["connection_generation"], "challenge_id": data["challenge_id"]}
                        with self.condition:
                            ack = self.idle_ack
                        if ack is not None:
                            payload["idle_ack"] = ack
                        status, _, _ = self.harness.api("/api/v1/worker/heartbeat", self.worker["credential"], "POST", payload)
                        with self.condition:
                            self.replies.append({"status": status, "at": time.monotonic()})
                            if status == 200 and ack is not None and self.idle_ack == ack:
                                self.idle_ack = None
                            self.condition.notify_all()
                        require(status == 200, "health reply was rejected")
                    event_type, event_id, data = None, None, None
            response.close()
        except Exception as error:
            if not self.stopping:
                with self.condition:
                    self.errors.append(type(error).__name__ + ": " + str(error))
                    self.condition.notify_all()
        finally:
            if self.connection is not None:
                self.connection.close()

    def wait(self, kind, predicate=lambda value: True, timeout=15):
        deadline = time.monotonic() + timeout
        with self.condition:
            while time.monotonic() < deadline:
                for event in reversed(self.events):
                    if event["type"] == kind and predicate(event["data"]):
                        return event["data"]
                require(not self.errors, "SSE peer failed; see private peer evidence")
                self.condition.wait(min(0.2, max(0, deadline - time.monotonic())))
        raise AssertionError("SSE event timed out: " + kind)

    def acknowledge_idle(self, job):
        with self.condition:
            self.idle_ack = {"job_id": job["id"], "generation": job["generation"], "lease_id": job["lease_id"]}
        self.harness.until(lambda: self.harness.status(self.worker)["work_status"] == "idle", "matching idle acknowledgement did not release worker", timeout=15)

    def stop(self):
        self.stopping = True
        if self.socket is not None:
            try:
                self.socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.thread.join(timeout=6)
        require(not self.thread.is_alive(), "SSE peer did not stop")
        self.harness.private("peer-" + self.worker["worker"]["id"] + "-" + str(self.opened["connection_generation"]) + ".json", json.dumps({"events": self.events, "replies": self.replies, "errors": self.errors}))


class PullPeer:
    def __init__(self, harness, worker):
        self.h, self.worker = harness, worker
        self.checker = "controlled-" + worker["worker"]["id"]
        self.condition = threading.Condition()
        self.pulls, self.jobs = [], []
        self.active = None
        self.invocation = None

    def poll_input(self, *, media_jobs=False, prompt_wav=False):
        sequence = len(self.pulls) + 1
        scheduled = datetime.now(timezone.utc)
        if self.pulls:
            previous = datetime.fromisoformat(self.pulls[-1]["scheduled_at"])
            deadline = time.monotonic() + 5
            while scheduled <= previous:
                require(time.monotonic() < deadline, "controlled poll clock did not advance")
                time.sleep(0.02)
                scheduled = datetime.now(timezone.utc)
        stamp = scheduled.isoformat().replace("+00:00", "Z")
        return {"protocol_version": 1, "sequence": sequence, "checker_job_id": self.checker,
                "checker_run_id": f"tick-{sequence}", "scheduled_at": stamp, "entered_at": stamp,
                "media_jobs": media_jobs, "prompt_wav": prompt_wav}

    def poll(self, origin=None, *, media_jobs=False, prompt_wav=False, payload=None, headers=None):
        require(self.active is None, "controlled peer attempted a work pull while busy")
        payload = payload or self.poll_input(media_jobs=media_jobs, prompt_wav=prompt_wav)
        sequence = payload["sequence"]
        started = time.monotonic()
        value, headers = self.h.checked("/api/v1/worker/pull", self.worker["credential"], "POST", payload, origin=origin, headers=headers)
        grant = value["job"]
        with self.condition:
            observed = time.monotonic()
            self.pulls.append({"at": observed, "started": started, "origin": origin or self.h.origin_url,
                               "sequence": sequence, "scheduled_at": payload["scheduled_at"], "duration_ms": round((observed - started) * 1000, 3),
                               "claimed": grant is not None, "request_id": headers["X-Request-Id"]})
            if grant is not None:
                self.active = grant["job_id"]
                self.invocation = payload["checker_run_id"]
            self.condition.notify_all()
        return grant

    def poll_usage(self, used_percent, origin=None):
        payload = self.poll_input()
        return self.poll(origin, payload=payload, headers=usage_header(used_percent, payload["scheduled_at"]))

    def start_input(self, grant):
        require(self.active == grant["job_id"], "controlled peer tried to start an unowned grant")
        return {"protocol_version": 1, "claim_id": grant["claim_id"], "generation": grant["generation"],
                "launch_id": "launch-" + grant["job_id"], "native_job_id": self.checker,
                "verification": {"reference": grant["claim_id"], "native_job_id": self.checker,
                                 "native_run_id": "event-hook-" + self.invocation, "status": "running"}}

    def begin(self, grant, origin=None):
        start = self.start_input(grant)
        path = "/api/v1/worker/jobs/" + grant["job_id"]
        job, headers = self.h.checked(path + "/start", self.worker["credential"], "POST", start, origin=origin)
        with self.condition:
            self.jobs.append(job)
            self.condition.notify_all()
        return job, headers, start

    def submit(self, job, decision, submission=None, want=200, changes=None):
        body = {"protocol_version": 1, "submission_id": submission or secrets.token_hex(12),
                "connection_id": "", "connection_generation": 0, "conversation_id": job["conversation_id"],
                "generation": job["generation"], "lease_id": job["lease_id"],
                "context_receipt_id": job["context"]["receipt_id"], "decision": decision, **(changes or {})}
        path = "/api/v1/worker/jobs/" + job["id"] + "/decisions"
        value, headers = self.h.checked(path, self.worker["credential"], "POST", body, want=want)
        if want == 200 and self.active == job["id"]:
            self.settle(job, "accepted")
        return value, headers, body

    def settlement_input(self, job):
        return {"protocol_version": 1, "submission_id": "settle-" + job["id"], "claim_id": job["lease_id"],
                "generation": job["generation"], "launch_id": job["launch_id"], "native_job_id": job["native_job_id"],
                "native_run_id": "event-hook-" + self.invocation, "reason": "execution_confirmed_stopped", "verified_start": True}

    def settle(self, job, expected=None):
        path = "/api/v1/worker/jobs/" + job["id"] + "/interrupt"
        receipt, _ = self.h.checked(path, self.worker["credential"], "POST", self.settlement_input(job))
        require(receipt["job_id"] == job["id"] and receipt["claim_id"] == job["lease_id"] and
                receipt["state"] in ([expected] if expected else ["cancelled", "interrupted"]), "controlled peer did not reconcile its claim")
        with self.condition:
            require(self.active == job["id"], "controlled peer cleared the wrong local claim")
            self.active = None


class Inference(WorkerAuth):
    def __init__(self, args):
        super().__init__(args)
        self.peers = []

    def until(self, condition, message, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.1)
        raise AssertionError(message)

    def checked(self, path, key=None, method="GET", data=None, want=200, origin=None, headers=None):
        status, headers, body = self.api(path, key, method, data, origin=origin, headers=headers)
        require(status == want, "unexpected HTTP status for " + method + " " + path + ": " + str(status))
        return json.loads(body), headers

    def new_worker(self):
        status, _, worker = self.enroll(self.issue())
        require(status == 201, "worker registration failed")
        return worker

    def peer(self, worker, reply=True, headers=None):
        peer = Peer(self, worker, reply, headers)
        self.peers.append(peer)
        return peer.start()

    def pull_peer(self, worker):
        peer = PullPeer(self, worker)
        require(peer.poll() is None, "controlled worker was not initially idle")
        return peer

    def status(self, worker):
        return self.checked("/api/v1/worker/status", worker["credential"])[0]

    def worker_projection(self, worker, origin=None):
        workers, headers = self.checked("/api/v1/admin/workers", self.admin, origin=origin)
        return next(item for item in workers["workers"] if item["id"] == worker["worker"]["id"]), headers

    def silence(self, worker, seconds):
        worker_id = worker["worker"]["id"]
        self.sql(f"UPDATE aaa_workers SET last_contact_at=CAST(unixepoch('subsec')*1000000 AS INTEGER)-{seconds * 1_000_000} WHERE id='{worker_id}';")

    def offline_diagnosis(self, worker, peer, reason):
        projected, headers = self.worker_projection(worker)
        require("offline_for_ms" not in self.status(worker), "worker status exposed the management duration")
        event, _ = self.diagnose(headers["X-Request-Id"], "request.exchange")
        events = self.export_operation(peer.opened["connection_id"])
        self.assert_private(json.dumps(events))
        transition, = [e for e in events if e["msg"] == "worker.connection_changed" and e.get("reason") == reason]
        stdout = self.logs(self.main_service)
        self.assert_private(stdout)
        require(transition["level"] == "INFO" and transition["transaction_outcome"] == "committed"
                and transition["worker_id"] == worker["worker"]["id"]
                and transition["connection_id"] == peer.opened["connection_id"]
                and transition["connection_generation"] == peer.opened["connection_generation"], "offline diagnosis lost its connection or committed outcome")
        require(any(e.get("connection_id") == transition["connection_id"] and e.get("reason") == reason and e.get("msg") == "worker.connection_changed"
                    for e in map(json.loads, stdout.splitlines())), "offline transition is missing at INFO")
        require('"msg":"request.exchange"' not in stdout, "protected DEBUG exchanges escaped INFO filtering")
        exchange = json.loads(event["response"])
        from_log = next(item for item in exchange["workers"] if item["id"] == transition["worker_id"])
        require(from_log == projected and from_log["connection_status"] == "offline" and event["level"] == "DEBUG", "captured list did not reproduce the offline projection")
        start = datetime.fromisoformat(transition["offline_since"])
        observed = datetime.fromisoformat(transition["observed_at"])
        expected = (datetime.fromisoformat(transition["last_heartbeat_at"] or transition["opened_at"]) + timedelta(seconds=30)
                    if reason == "health_reply_expired" else observed)
        sample = start + timedelta(milliseconds=from_log["offline_for_ms"])
        require(start == expected and start <= observed and observed - timedelta(milliseconds=1) <= sample <= datetime.fromisoformat(event["time"]),
                "effective outage boundary or logged elapsed value is incorrect")
        self.receipt("worker.offline_log_only_diagnosis", worker_id=transition["worker_id"], connection_generation=transition["connection_generation"],
                     reason=reason, offline_since=transition["offline_since"], request_id=headers["X-Request-Id"], capture_complete=True,
                     corrective_action="Restore the worker subscriber and wait for an accepted heartbeat.", business_table_queries=False)

    def create(self, worker, marker, tools=True, timeout=300, messages=None, submission=None, want=201):
        request = {"protocol_version": 1, "submission_id": submission or secrets.token_hex(12), "worker_id": worker["worker"]["id"], "messages": messages or [{"type": "message", "role": "system", "text": "Keep exact client tool linkage."}, {"type": "message", "role": "user", "text": marker}], "tools": [{"name": "read_file", "parameters": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "$defs": {"path": {"type": "string"}}, "properties": {"path": {"$ref": "#/$defs/path"}, "scale": {"type": "number", "maximum": 1e20}}, "required": ["path"], "additionalProperties": False}}] if tools else [], "timeout_seconds": timeout}
        return self.checked("/api/v1/admin/experiments", self.admin, "POST", request, want=want)[0]

    def experiment(self, identity):
        return self.checked("/api/v1/admin/experiments/" + identity, self.admin)[0]

    def claim(self, worker, peer, experiment, submission=None, want=200, origin=None):
        if isinstance(peer, PullPeer):
            require(submission is None and want == 200, "native claim replay must use the exact pull request")
            grant = peer.poll(origin)
            require(grant is not None and grant["job_id"] == experiment["current_job_id"], "controlled pull did not choose the expected job")
            return peer.begin(grant, origin)
        body = {"protocol_version": 1, "submission_id": submission or secrets.token_hex(12), "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"]}
        value, headers = self.checked("/api/v1/worker/jobs/" + experiment["current_job_id"] + "/claim", worker["credential"], "POST", body, want=want, origin=origin)
        return value, headers, body

    def decision(self, worker, peer, job, decision, submission=None, want=200, changes=None):
        if isinstance(peer, PullPeer):
            require(worker["worker"]["id"] == peer.worker["worker"]["id"], "use explicit HTTP for a foreign credential test")
            return peer.submit(job, decision, submission, want, changes)
        body = {"protocol_version": 1, "submission_id": submission or secrets.token_hex(12), "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"], "conversation_id": job["conversation_id"], "generation": job["generation"], "lease_id": job["lease_id"], "context_receipt_id": job["context"]["receipt_id"], "decision": decision}
        body.update(changes or {})
        value, headers = self.checked("/api/v1/worker/jobs/" + job["id"] + "/decisions", worker["credential"], "POST", body, want=want)
        return value, headers, body

    def cancel(self, identity):
        return self.checked("/api/v1/admin/experiments/" + identity + "/cancel", self.admin, "POST", {"protocol_version": 1, "submission_id": secrets.token_hex(12)})

    def export_operation(self, identity):
        status, _, body = self.api("/api/v1/admin/diagnostics/export?operation_id=" + identity, self.admin)
        require(status == 200, "operation export unavailable")
        metadata, events = self.decode_export(body)
        require(metadata["complete"] and events, "operation evidence incomplete")
        require(all(e["operation_id"] == identity for e in events), "operation correlation crossed boundaries")
        self.assert_private(json.dumps(events))
        self.private("operation-" + identity + ".json", json.dumps({"metadata": metadata, "events": events}))
        return events

    def tool_loop(self, worker, peer):
        fixture = self.private("client-only.txt", "client-fixture-" + secrets.token_hex(24) + "\nexact second line\n")
        a = self.create(worker, "Read the client-only fixture")
        j, _, _ = self.claim(worker, peer, a)
        require(j["context"]["kind"] == "full" and len(j["context"]["messages"]) == 2, "initial context not full")
        tool = {"type": "tool_call", "call_id": "client-" + secrets.token_hex(8), "name": "read_file", "arguments": {"path": str(fixture), "scale": 1e19}}
        self.decision(worker, peer, j, {**tool, "name": "unknown"}, want=400)
        _, headers, _ = self.decision(worker, peer, j, {**tool, "arguments": {"path": 7}}, want=400)
        event, _ = self.diagnose(headers["X-Request-Id"], "decision.rejected", "invalid_tool_arguments")
        require(event["evidence"]["schema_error"] and event["conversation_id"] == a["conversation_id"], "schema/owner diagnosis missing")
        locations = event["evidence"]["schema_validation"]["errors"]
        require(any(location["instanceLocation"] == "/path" and location.get("AbsoluteKeywordLocation", "").endswith("#/$defs/path/type") for location in locations), "schema reference/instance locations missing")
        waiting, _, accepted = self.decision(worker, peer, j, tool)
        require(waiting["state"] == "waiting_for_tool" and self.status(worker)["work_status"] == "idle", "tool wait holds inference slot")

        b = self.create(worker, "independent-session-B", tools=False)
        bj, _, _ = self.claim(worker, peer, b)
        require(bj["conversation_id"] != j["conversation_id"] and "client-only" not in json.dumps(bj["context"]["messages"]), "sessions mixed context")
        self.decision(worker, peer, bj, {"type": "final", "text": "session-B-only"})

        result = fixture.read_text()
        request = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": tool["call_id"], "output": result}
        self.checked("/api/v1/admin/experiments/" + a["id"] + "/tool-results", self.admin, "POST",
                     {**request, "context_probe": {"kind": "delta", "base_receipt_id": j["context"]["receipt_id"]}}, want=409)
        continuation, _ = self.checked("/api/v1/admin/experiments/" + a["id"] + "/tool-results", self.admin, "POST", request, want=202)
        next_job, _, _ = self.claim(worker, peer, continuation)
        context = next_job["context"]
        require(context["kind"] == "full" and context["base_prefix"] == 0 and context["messages"] ==
                j["context"]["messages"] + [tool, {"type": "tool_result", "call_id": tool["call_id"], "output": result}], "continuation omitted or duplicated canonical history")
        delivered_result = context["messages"][-1]["output"]
        final, _, final_request = self.decision(worker, peer, next_job, {"type": "final", "text": delivered_result})
        require(final["final_text"] == result and len(final["messages"]) == 5, "final answer/history did not preserve exact client result")
        self.checked("/api/v1/worker/jobs/" + j["id"] + "/decisions", worker["credential"], "POST", accepted)
        self.checked("/api/v1/worker/jobs/" + next_job["id"] + "/decisions", worker["credential"], "POST", final_request)
        self.checked("/api/v1/admin/experiments/" + a["id"] + "/tool-results", self.admin, "POST", request, want=202)
        self.checked("/api/v1/admin/experiments/" + a["id"] + "/tool-results", self.admin, "POST", {**request, "output": "conflicting"}, want=409)
        require(self.sql("SELECT count(*) FROM aaa_inference_history WHERE experiment_id='" + a["id"] + "';") == "5", "history duplicated accepted retries")

        replay = self.create(worker, "fresh replay", messages=final["messages"])
        replay_job, _, _ = self.claim(worker, peer, replay)
        require(replay_job["context"]["kind"] == "full" and replay_job["context"]["messages"] == final["messages"] and replay_job["conversation_id"] != a["conversation_id"], "fresh conversation did not receive complete canonical replay")
        self.decision(worker, peer, replay_job, {"type": "final", "text": result})
        events = self.export_operation(a["id"])
        contexts = [e for e in events if e["msg"] == "inference.context" and e.get("claim_id")]
        require(len(contexts) == 2 and contexts[-1]["context"]["messages"] == context["messages"], "private capture did not retain exact delivered context")
        require(any(e["msg"] == "inference.exchange" and e["level"] == "DEBUG" for e in events), "DEBUG exchanges missing at INFO runtime")
        self.receipt("inference.client_tool_interleave_full_replay", experiment=a["id"], session=a["conversation_id"], history_items=5, client_tool_executions=1, synthetic_peer=True)
        self.accepted_retry = (worker, next_job, final_request, a["id"])

    def concurrency_and_scope(self, worker, other, peer, second_origin):
        experiment = self.create(worker, "same-poll replay and start race", tools=False)
        job_id = experiment["current_job_id"]
        poll = peer.poll_input()
        path = "/api/v1/worker/pull"
        with ThreadPoolExecutor(max_workers=8) as pool:
            granted = pool.submit(peer.poll, payload=poll)
            replays = [pool.submit(self.checked, path, worker["credential"], "POST", poll, origin=second_origin if index % 2 else self.origin_url)
                       for index in range(7)]
            grant = granted.result()
            require(grant["job_id"] == job_id and all(replay.result()[0]["job"] == grant for replay in replays), "sibling brokers replayed different grants")
        require(PullPeer(self, other).poll() is None, "foreign worker pulled explicitly targeted work")
        route = "/api/v1/worker/jobs/" + job_id
        start = peer.start_input(grant)
        self.checked(route + "/start", other["credential"], "POST", start, want=404)
        with ThreadPoolExecutor(max_workers=8) as pool:
            attempts = [pool.submit(self.api, route + "/start", worker["credential"], "POST", start,
                                    origin=second_origin if index % 2 else self.origin_url) for index in range(8)]
            replies = [attempt.result() for attempt in attempts]
        require(sorted(status for status, _, _ in replies) == [200] + [409] * 7, "duplicate handlers received execution authority")
        job = json.loads(next(body for status, _, body in replies if status == 200))
        require(job["lease_id"] == grant["claim_id"] and job["native_job_id"] == start["native_job_id"], "authorized brief lost its claim binding")
        _, headers, stale = self.decision(worker, peer, job, {"type": "final", "text": "stale"}, want=409, changes={"generation": job["generation"] + 1})
        evidence, _ = self.diagnose(headers["X-Request-Id"], "lease.fenced", "stale_assignment")
        require(evidence["evidence"]["expected_generation"] == job["generation"], "stale generation diagnosis missing")
        self.checked(route + "/decisions", other["credential"], "POST", {**stale, "generation": job["generation"]}, want=404)
        self.decision(worker, peer, job, {"type": "final", "text": "one accepted result"})
        self.receipt("inference.atomic_claim_and_scope", simultaneous_pulls=8, starts=8, authorized=1, other_worker_denied=True)

    def cancellation_and_deadline(self, worker, peer):
        experiment = self.create(worker, "cancel while computing", tools=False)
        job, _, _ = self.claim(worker, peer, experiment)
        cancelled, _ = self.cancel(experiment["id"])
        require(cancelled["state"] == "cancelled" and cancelled["remote_outcome"] == "unknown", "cancellation hid uncertain native work")
        following = self.create(worker, "queued behind cancelled work", tools=False)
        require(self.experiment(following["id"])["state"] == "queued" and self.status(worker)["work_status"] == "busy", "cancelled claim released the slot")
        self.decision(worker, peer, job, {"type": "final", "text": "late cancelled answer"}, want=409)
        peer.settle(job, "cancelled")
        next_job, _, _ = self.claim(worker, peer, following)
        self.decision(worker, peer, next_job, {"type": "final", "text": "next work after verified stop"})
        events = self.export_operation(experiment["id"])
        require(any(event["msg"] == "experiment.cancelled" and event["busy_hold"] for event in events) and
                any(event["msg"] == "job.work_settled" and not event["busy_hold"] for event in events), "cancellation and stop diagnosis incomplete")

        expired = self.create(worker, "short deadline", tools=False, timeout=2)
        expiry_job, _, _ = self.claim(worker, peer, expired)
        self.until(lambda: self.experiment(expired["id"])["state"] == "interrupted", "deadline did not fence active work")
        self.decision(worker, peer, expiry_job, {"type": "final", "text": "too late"}, want=409)
        require(self.status(worker)["work_status"] == "busy", "deadline discarded unconfirmed remote work")
        peer.settle(expiry_job, "interrupted")
        failures = [event for event in self.export_operation(expired["id"]) if event["msg"] == "job.deadline_exceeded"]
        require(len(failures) == 1 and failures[0]["level"] == "ERROR" and failures[0]["remote_outcome"] == "unknown" and failures[0]["claimed_at"],
                "deadline diagnosis omitted actual claim evidence")
        accepted = self.create(worker, "accepted receipt valid after deadline", tools=False, timeout=3)
        accepted_job, _, _ = self.claim(worker, peer, accepted)
        completed, _, submission = self.decision(worker, peer, accepted_job, {"type": "final", "text": "accepted once"})
        expires = datetime.fromisoformat(accepted_job["deadline_at"].replace("Z", "+00:00")).timestamp()
        self.until(lambda: time.time() >= expires, "test did not cross the original job deadline", timeout=5)
        replay, _ = self.checked("/api/v1/worker/jobs/" + accepted_job["id"] + "/decisions", worker["credential"], "POST", submission)
        require(replay == completed and len(self.experiment(accepted["id"])["messages"]) == 3, "accepted replay after deadline mutated history")
        self.receipt("inference.cancellation_deadline_and_exact_replay", original_receipt_preserved=True, late_new_results_fenced=True, automatic_retries=0)

    def revocation_races(self):
        for operation in ("start", "decisions"):
            worker = self.new_worker()
            peer = self.pull_peer(worker)
            experiment = self.create(worker, "revocation wins after authentication", tools=False)
            grant = peer.poll()
            job_id = grant["job_id"]
            submission = "revoke-race-" + secrets.token_hex(8)
            if operation == "start":
                request = peer.start_input(grant)
            else:
                job, _, _ = peer.begin(grant)
                request = {"protocol_version": 1, "submission_id": submission, "connection_id": "", "connection_generation": 0,
                           "conversation_id": job["conversation_id"], "generation": job["generation"], "lease_id": job["lease_id"],
                           "context_receipt_id": job["context"]["receipt_id"], "decision": {"type": "final", "text": "must not be accepted"}}
            origin = urllib.parse.urlsplit(self.origin_url)
            body = json.dumps(request).encode()
            connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=5)
            try:
                connection.putrequest("POST", "/api/v1/worker/hook/jobs/" + job_id + "/" + operation)
                connection.putheader("Authorization", "Bearer " + worker["credential"])
                for name, value in self.worker_pair_headers().items():
                    connection.putheader(name, value)
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Content-Length", str(len(body)))
                connection.putheader("Expect", "100-continue")
                connection.endheaders()
                with connection.sock.makefile("rb") as interim:
                    require(interim.readline() == b"HTTP/1.1 100 Continue\r\n" and interim.readline() == b"\r\n", "worker preflight did not precede body delivery")
                self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST")
                connection.send(body)
                with connection.getresponse() as response:
                    require(response.status == 401, "request authenticated before revocation bypassed durable authority")
                    request_id = response.headers["X-Request-Id"]
                    response.read()
            finally:
                connection.close()
            self.checked("/api/v1/worker/pull", worker["credential"], "POST", peer.poll_input(), want=401)
            event, _ = self.diagnose(request_id, "lease.rejected", "worker_revoked")
            require(event["conversation_id"] == experiment["conversation_id"] and len(self.experiment(experiment["id"])["messages"]) == 2,
                    "revocation race committed work or lost operation context")
            self.receipt("inference.revocation_after_authentication", operation=operation, accepted_receipts=0, history_items=2)

    def restart(self, worker, peer, service):
        experiment = self.create(worker, "tool linkage across broker restart")
        job, _, _ = self.claim(worker, peer, experiment)
        call_id = "restart-call-" + secrets.token_hex(8)
        self.decision(worker, peer, job, {"type": "tool_call", "call_id": call_id, "name": "read_file", "arguments": {"path": "client-only"}})
        self.docker("restart", service)
        self.origin_url = self.origin(service)
        self.ready(service, self.origin_url)
        result = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": call_id, "output": "post-restart exact result"}
        continuation, _ = self.checked("/api/v1/admin/experiments/" + experiment["id"] + "/tool-results", self.admin, "POST", result, want=202)
        next_job, _, _ = self.claim(worker, peer, continuation)
        require(next_job["context"]["kind"] == "full" and next_job["context"]["messages"][-1]["call_id"] == call_id, "restart lost context or tool linkage")
        self.decision(worker, peer, next_job, {"type": "final", "text": next_job["context"]["messages"][-1]["output"]})
        require(len(self.experiment(experiment["id"])["messages"]) == 5, "restart duplicated history")
        self.receipt("inference.restart_tool_wait", experiment=experiment["id"], call_id=call_id, full_replay=True)

    def boundary_and_failure_evidence(self, worker, peer):
        for raw in (b'{}', b'null', b'{"protocol_version":1,"protocol_version":1}', b'{} {}', b'{"messages":[{"type":"image"}]}'):
            require(self.api("/api/v1/admin/experiments", self.admin, "POST", raw=raw)[0] == 400, "malformed protocol accepted")
        require(self.api("/api/v1/admin/experiments", self.admin, "POST", raw=b'x' * (1024 * 1024 + 1))[0] == 413, "body ceiling ignored")
        large = self.create(worker, "x" * 600000)
        large_job, _, _ = self.claim(worker, peer, large)
        self.decision(worker, peer, large_job, {"type": "tool_call", "call_id": "overflow-call", "name": "read_file", "arguments": {"path": "client"}})
        result_path = "/api/v1/admin/experiments/" + large["id"] + "/tool-results"
        self.checked(result_path, self.admin, "POST", {"protocol_version": 1, "submission_id": "overflow", "call_id": "overflow-call", "output": "y" * 600000}, want=413)
        require(len(self.experiment(large["id"])["messages"]) == 3, "context overflow partially appended history")
        continued, _ = self.checked(result_path, self.admin, "POST", {"protocol_version": 1, "submission_id": "bounded", "call_id": "overflow-call", "output": "small"}, want=202)
        bounded_job, _, _ = self.claim(worker, peer, continued)
        self.decision(worker, peer, bounded_job, {"type": "final", "text": "bounded"})
        self.export_operation(large["id"])
        held = [self.create(worker, "admission-" + str(i), tools=False) for i in range(10)]
        for e in held:
            self.cancel(e["id"])
        secrets_in_input = "credential echoes " + worker["credential"] + " and " + self.admin
        e = self.create(worker, secrets_in_input, tools=False)
        job, _, _ = self.claim(worker, peer, e)
        self.decision(worker, peer, job, {"type": "final", "text": "done"})
        self.export_operation(e["id"])
        logs = self.logs(self.main_service)
        require('"msg":"inference.exchange"' not in logs, "DEBUG exchanges reached INFO stdout")
        self.assert_private(logs)
        with self.storage_fault("aaa_experiments"):
            status, headers, _ = self.api("/api/v1/admin/experiments/" + e["id"], self.admin)
            event, _ = self.diagnose(headers["X-Request-Id"], "inference.operation_failed")
            require(status == 503 and event["sqlite_code"] == "1" and event["transaction_outcome"] == "rolled_back",
                    "dependency failure lacked causal SQLite outcome")
        self.ready(self.main_service, self.origin_url)
        self.receipt("inference.bounds_redaction_storage_failure", admitted_jobs=10, body_bytes=1048576, log_only_diagnosis=True)

    def key_redaction_and_persistence_failure(self, worker, peer):
        status, headers, _ = self.api("/api/v1/admin/experiments", self.admin, "POST", {worker["credential"]: "unsupported-field-evidence"})
        require(status == 400, "secret-bearing unsupported field accepted")
        event, _ = self.diagnose(headers["X-Request-Id"], "request.inference_input")
        require(event["input"] == {"[REDACTED]": "unsupported-field-evidence"}, "unsupported field-key evidence lost")
        properties = {worker["credential"]: {"type": "string"}, self.admin: {"type": "number"}}
        request = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "worker_id": worker["worker"]["id"], "messages": [{"type": "message", "role": "user", "text": "nested key redaction"}], "tools": [{"name": "read_file", "parameters": {"type": "object", "properties": properties, "additionalProperties": False}}]}
        e, _ = self.checked("/api/v1/admin/experiments", self.admin, "POST", request, want=201)
        job, _, _ = self.claim(worker, peer, e)
        self.decision(worker, peer, job, {"type": "tool_call", "call_id": "redacted-keys", "name": "read_file", "arguments": {worker["credential"]: "client-evidence", self.admin: 9007199254740993}})
        events = self.export_operation(e["id"])
        exchanges = [event for event in events if event["msg"] == "inference.exchange" and event["operation"] == "decision"]
        arguments = exchanges[0]["input"]["decision"]["arguments"]
        require(len(arguments) == 2 and set(arguments.values()) == {"client-evidence", 9007199254740993}, "redaction overwrote argument evidence or rounded numbers")
        self.cancel(e["id"])
        failure = self.create(worker, "persistence failure after pull reservation", tools=False)
        poll = peer.poll_input()
        condition = "NEW.worker_id='" + worker["worker"]["id"] + "' AND NEW.sequence=" + str(poll["sequence"])
        self.reject_writes("inference_test_poll", "aaa_worker_polls", condition, "UPDATE")
        try:
            _, headers = self.checked("/api/v1/worker/pull", worker["credential"], "POST", poll, want=503)
        finally:
            self.sql("DROP TRIGGER inference_test_poll;")
        event, _ = self.diagnose(headers["X-Request-Id"], "worker.pull_failed")
        require(event["level"] == "ERROR" and event["sqlite_code"] == "1811" and event["transaction_outcome"] == "rolled_back" and
                event["job_id"] == failure["current_job_id"] and event["sequence"] == poll["sequence"], "poll persistence failure lost its cause or reservation")
        require(self.experiment(failure["id"])["state"] == "queued" and self.status(worker)["work_status"] == "idle", "failed persistence left a claimed turn")
        grant = peer.poll(payload=poll)
        require(grant["job_id"] == failure["current_job_id"], "rolled back sequence committed a grant")
        job, _, _ = peer.begin(grant)
        self.decision(worker, peer, job, {"type": "final", "text": "accepted after rollback"})
        self.receipt("inference.object_key_redaction_and_persistence_failure", log_only_diagnosis=True, rollback_verified=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = Inference(args)
    try:
        h.baseline()
        h.setup()
        config = h.configuration()
        service, h.origin_url, _ = h.launch(config)
        h.main_service = service
        h.ready(service, h.origin_url)
        secondary, second_origin, _ = h.launch(config)
        h.ready(secondary, second_origin)
        a, b = h.new_worker(), h.new_worker()
        peer = h.pull_peer(a)
        h.tool_loop(a, peer)
        h.concurrency_and_scope(a, b, peer, second_origin)
        h.docker("stop", "--time", "5", secondary)
        require(not h.inspect(secondary)["State"]["Running"], "secondary broker still emits asynchronous diagnostics")
        h.cancellation_and_deadline(a, peer)
        h.restart(a, peer, service)
        h.revocation_races()
        final_worker = h.new_worker()
        final_peer = h.pull_peer(final_worker)
        h.key_redaction_and_persistence_failure(final_worker, final_peer)
        h.boundary_and_failure_evidence(final_worker, final_peer)
        h.private("results.json", json.dumps({"suite": "inference", "source_sha": args.source_sha, "synthetic_peer": True, "receipts": h.receipts}))
    finally:
        peer_failures = []
        for peer in h.peers:
            if peer.thread.is_alive():
                try:
                    peer.stop()
                except Exception as error:
                    peer_failures.append(str(error))
        h.cleanup()
        require(not peer_failures, "peer cleanup failed")


if __name__ == "__main__":
    main()
