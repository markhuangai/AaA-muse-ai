#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import select
import subprocess
import threading
import time
import urllib.parse

from service import require
from worker_auth import WorkerAuth


class Peer:
    def __init__(self, harness, worker, reply=True):
        self.harness, self.worker, self.reply = harness, worker, reply
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
            self.connection.request("GET", "/api/v1/worker/events", headers={"Authorization": "Bearer " + self.worker["credential"]})
            response = self.connection.getresponse()
            require(response.status == 200, "SSE subscription rejected")
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

    def checked(self, path, key=None, method="GET", data=None, want=200, origin=None):
        status, headers, body = self.api(path, key, method, data, origin=origin)
        require(status == want, "unexpected HTTP status for " + method + " " + path + ": " + str(status))
        return json.loads(body), headers

    def new_worker(self):
        status, _, worker = self.enroll(self.issue())
        require(status == 201, "worker registration failed")
        return worker

    def peer(self, worker, reply=True):
        peer = Peer(self, worker, reply)
        self.peers.append(peer)
        return peer.start()

    def status(self, worker):
        return self.checked("/api/v1/worker/status", worker["credential"])[0]

    def create(self, worker, marker, tools=True, timeout=300, messages=None, submission=None, want=201):
        request = {"protocol_version": 1, "submission_id": submission or secrets.token_hex(12), "worker_id": worker["worker"]["id"], "messages": messages or [{"type": "message", "role": "system", "text": "Keep exact client tool linkage."}, {"type": "message", "role": "user", "text": marker}], "tools": [{"name": "read_file", "parameters": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "$defs": {"path": {"type": "string"}}, "properties": {"path": {"$ref": "#/$defs/path"}, "scale": {"type": "number", "maximum": 1e20}}, "required": ["path"], "additionalProperties": False}}] if tools else [], "timeout_seconds": timeout}
        return self.checked("/api/v1/admin/experiments", self.admin, "POST", request, want=want)[0]

    def experiment(self, identity):
        return self.checked("/api/v1/admin/experiments/" + identity, self.admin)[0]

    def claim(self, worker, peer, experiment, submission=None, want=200, origin=None):
        body = {"protocol_version": 1, "submission_id": submission or secrets.token_hex(12), "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"]}
        value, headers = self.checked("/api/v1/worker/jobs/" + experiment["current_job_id"] + "/claim", worker["credential"], "POST", body, want=want, origin=origin)
        return value, headers, body

    def decision(self, worker, peer, job, decision, submission=None, want=200, changes=None):
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
        peer.wait("job.available", lambda data: data["job_id"] == a["current_job_id"])
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
        request = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": tool["call_id"], "output": result, "context_probe": {"kind": "delta", "base_receipt_id": j["context"]["receipt_id"]}}
        self.checked("/api/v1/admin/experiments/" + a["id"] + "/tool-results", self.admin, "POST", {**request, "context_probe": {"kind": "delta", "base_receipt_id": bj["id"]}}, want=409)
        continuation, _ = self.checked("/api/v1/admin/experiments/" + a["id"] + "/tool-results", self.admin, "POST", request, want=202)
        next_job, _, _ = self.claim(worker, peer, continuation)
        context = next_job["context"]
        require(context["kind"] == "delta" and context["base_prefix"] == 2 and context["base_sha256"] == j["context"]["canonical_sha256"], "delta base receipt differs")
        require(context["messages"] == [tool, {"type": "tool_result", "call_id": tool["call_id"], "output": result}], "delta omitted/duplicated tool items")
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
        contexts = [e for e in events if e["msg"] == "inference.context"]
        require(len(contexts) == 2 and contexts[-1]["context"]["messages"] == context["messages"], "private capture did not retain exact delivered context")
        require(any(e["msg"] == "inference.exchange" and e["level"] == "DEBUG" for e in events), "DEBUG exchanges missing at INFO runtime")
        self.receipt("inference.client_tool_interleave_delta_replay", experiment=a["id"], session=a["conversation_id"], history_items=5, client_tool_executions=1, synthetic_peer=True)
        self.accepted_retry = (worker, next_job, final_request, a["id"])

    def concurrency_and_scope(self, worker, other, peer, second_origin):
        e = self.create(worker, "concurrent claim", tools=False)
        def claim(i):
            body = {"protocol_version": 1, "submission_id": "race-" + secrets.token_hex(8), "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"]}
            status, _, value = self.api("/api/v1/worker/jobs/" + e["current_job_id"] + "/claim", worker["credential"], "POST", body, origin=self.origin_url if i % 2 == 0 else second_origin)
            return status, json.loads(value), body
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(claim, range(8)))
        require([r[0] for r in results].count(200) == 1 and [r[0] for r in results].count(409) == 7, "claim race admitted multiple inference turns")
        _, job, request = next(r for r in results if r[0] == 200)
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/claim", worker["credential"], "POST", request)
        for path, method, data in (("/api/v1/worker/jobs/" + job["id"], "GET", None), ("/api/v1/worker/jobs/" + job["id"] + "/claim", "POST", request)):
            self.checked(path, other["credential"], method, data, want=404)
        _, headers, _ = self.decision(other, peer, job, {"type": "final", "text": "foreign"}, want=404)
        self.diagnose(headers["X-Request-Id"], "lease.rejected", "worker_scope_denied")
        operation = self.export_operation(e["id"])
        foreign = [event for event in operation if event["msg"] == "lease.rejected" and event.get("reason") == "worker_scope_denied"]
        require(len(foreign) >= 2 and all(event["conversation_id"] == job["conversation_id"] and event["job_id"] == job["id"] and event["generation"] == job["generation"] for event in foreign), "experiment export omitted foreign assignment evidence")
        self.checked("/api/v1/worker/heartbeat", other["credential"], "POST", {"protocol_version": 1, "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"], "challenge_id": "foreign"}, want=409)
        _, headers, _ = self.decision(worker, peer, job, {"type": "final", "text": "stale"}, want=409, changes={"generation": job["generation"] + 1})
        evidence, _ = self.diagnose(headers["X-Request-Id"], "lease.fenced", "stale_assignment")
        require(evidence["evidence"]["expected_generation"] == job["generation"], "stale generation diagnosis missing")
        self.decision(worker, peer, job, {"type": "final", "text": "one accepted result"})
        self.receipt("inference.atomic_claim_and_scope", attempts=8, accepted=1, other_worker_denied=True)

    def cancellation_and_deadline(self, worker, peer):
        e = self.create(worker, "cancel while computing", tools=False)
        job, _, _ = self.claim(worker, peer, e)
        cancelled, _ = self.cancel(e["id"])
        require(cancelled["state"] == "cancelled" and cancelled["remote_outcome"] == "unknown", "cancellation waited for remote work or hid uncertainty")
        second = self.create(worker, "queued behind cancelled work", tools=False)
        self.claim(worker, peer, second, want=409)
        replies = len(peer.replies)
        self.until(lambda: len(peer.replies) > replies, "next health check missing", timeout=15)
        require(self.status(worker)["work_status"] == "busy", "health reply released cancelled job")
        self.decision(worker, peer, job, {"type": "final", "text": "late cancelled answer"}, want=409)
        peer.wait("job.cancelled", lambda data: data["job_id"] == job["id"])
        peer.acknowledge_idle(job)
        next_job, _, _ = self.claim(worker, peer, second)
        self.decision(worker, peer, next_job, {"type": "final", "text": "next work after idle"})
        events = self.export_operation(e["id"])
        require(any(x["msg"] == "experiment.cancelled" and x["busy_hold"] for x in events) and any(x["msg"] == "worker.idle_confirmed" for x in events), "cancellation/idle timeline incomplete")

        expired = self.create(worker, "short deadline", tools=False, timeout=2)
        exp_job, _, _ = self.claim(worker, peer, expired)
        self.until(lambda: self.experiment(expired["id"])["state"] == "interrupted", "deadline did not interrupt turn")
        self.decision(worker, peer, exp_job, {"type": "final", "text": "too late"}, want=409)
        events = self.export_operation(expired["id"])
        failures = [x for x in events if x["msg"] == "job.deadline_exceeded"]
        require(len(failures) == 1 and failures[0]["level"] == "ERROR" and failures[0]["remote_outcome"] == "unknown" and failures[0]["claimed_at"], "deadline diagnosis incomplete")
        peer.acknowledge_idle(exp_job)
        self.receipt("inference.cancellation_deadline_idle_hold", cancelled=e["id"], expired=expired["id"], automatic_retries=0)

    @contextmanager
    def submission_barrier(self, principal, submission):
        lock_name = (principal + ":" + submission).replace("'", "''")
        process = subprocess.Popen(["docker", "exec", "-i", self.db, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "aaa_muse"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('" + lock_name + "',0));\n\\echo LOCKED\n")
            process.stdin.flush()
            require(select.select([process.stdout], [], [], 5)[0], "submission barrier did not start")
            require(process.stdout.readline().strip() == "" and process.stdout.readline().strip() == "LOCKED", "submission barrier did not acquire the lock")
            yield
        finally:
            try:
                process.communicate("ROLLBACK;\n", timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise RuntimeError("submission barrier did not stop")
            require(process.returncode == 0, "submission barrier failed")

    def revocation_races(self):
        for operation in ("claim", "decisions"):
            worker = self.new_worker()
            peer = self.peer(worker)
            experiment = self.create(worker, "revocation wins after authentication", tools=False)
            submission = "revoke-race-" + secrets.token_hex(8)
            request = {"protocol_version": 1, "submission_id": submission, "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"]}
            if operation == "decisions":
                job, _, _ = self.claim(worker, peer, experiment)
                request.update({"conversation_id": job["conversation_id"], "generation": job["generation"], "lease_id": job["lease_id"], "context_receipt_id": job["context"]["receipt_id"], "decision": {"type": "final", "text": "must not be accepted"}})
            route = "/api/v1/worker/jobs/" + experiment["current_job_id"] + "/" + operation
            with ThreadPoolExecutor(max_workers=1) as pool:
                with self.submission_barrier("worker:" + worker["worker"]["id"], submission):
                    response = pool.submit(self.api, route, worker["credential"], "POST", request)
                    self.until(lambda: int(self.sql("SELECT count(*) FROM pg_stat_activity WHERE datname='aaa_muse' AND application_name <> 'psql' AND wait_event='advisory';")) >= 1, "authenticated request did not wait at the mutation barrier", timeout=3)
                    self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST")
                status, headers, _ = response.result(timeout=7)
            require(status == 401, "request authenticated before revocation bypassed durable authority")
            count = self.sql("SELECT count(*) FROM aaa_inference_receipts WHERE principal='worker:" + worker["worker"]["id"] + "' AND submission_id='" + submission + "'; SELECT count(*) FROM aaa_inference_history WHERE experiment_id='" + experiment["id"] + "';").splitlines()
            require(count == ["0", "2"], "revocation race committed a receipt or appended history")
            event, _ = self.diagnose(headers["X-Request-Id"], "lease.rejected", "worker_revoked")
            require(event["conversation_id"] == experiment["conversation_id"], "revocation race lost operation context")
            peer.stop()
            self.receipt("inference.revocation_after_authentication", operation=operation, accepted_receipts=0, history_items=2)

    def restart(self, worker, peer, service):
        e = self.create(worker, "tool linkage across broker restart")
        job, _, _ = self.claim(worker, peer, e)
        call_id = "restart-call-" + secrets.token_hex(8)
        self.decision(worker, peer, job, {"type": "tool_call", "call_id": call_id, "name": "read_file", "arguments": {"path": "client-only"}})
        peer.stop()
        self.docker("restart", service)
        self.origin_url = self.origin(service)
        self.ready(service, self.origin_url)
        new_peer = self.peer(worker)
        require(new_peer.opened["connection_generation"] > peer.opened["connection_generation"], "restart reused connection generation")
        self.checked("/api/v1/worker/heartbeat", worker["credential"], "POST", {"protocol_version": 1, "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"], "challenge_id": "old"}, want=409)
        result = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": call_id, "output": "post-restart exact result"}
        next_e, _ = self.checked("/api/v1/admin/experiments/" + e["id"] + "/tool-results", self.admin, "POST", result, want=202)
        next_job, _, _ = self.claim(worker, new_peer, next_e)
        require(next_job["context"]["kind"] == "full" and next_job["context"]["messages"][-1]["call_id"] == call_id, "restart lost full context/tool linkage")
        self.decision(worker, new_peer, next_job, {"type": "final", "text": next_job["context"]["messages"][-1]["output"]})
        require(len(self.experiment(e["id"])["messages"]) == 5, "restart duplicated history")
        self.receipt("inference.restart_tool_wait", experiment=e["id"], call_id=call_id, full_replay=True)
        return new_peer

    def disconnect_and_revoke(self, worker, peer):
        e = self.create(worker, "claimed disconnect", tools=False)
        job, _, _ = self.claim(worker, peer, e)
        peer.stop()
        self.until(lambda: self.experiment(e["id"])["state"] == "interrupted", "disconnect did not fence claimed work")
        self.create(worker, "offline rejected", want=409)
        reconnect = self.peer(worker)
        require(self.status(worker)["work_status"] == "busy", "reconnect erased uncertain busy hold")
        self.decision(worker, peer, job, {"type": "final", "text": "old connection late result"}, want=409)
        reconnect.acknowledge_idle(job)
        next_e = self.create(worker, "revoked active subscriber", tools=False)
        next_job, _, _ = self.claim(worker, reconnect, next_e)
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST")
        self.decision(worker, reconnect, next_job, {"type": "final", "text": "revoked"}, want=401)
        self.until(lambda: self.experiment(next_e["id"])["state"] == "interrupted", "revocation left claimed inference active")
        reconnect.stop()
        self.receipt("inference.disconnect_reconnect_revocation", busy_hold_preserved=True, stale_output_rejected=True)

    def queued_context_reconnect(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        for kind in ("delta", "full"):
            e = self.create(worker, "queued " + kind + " context across reconnect")
            job, _, _ = self.claim(worker, peer, e)
            call_id = "reconnect-" + kind
            self.decision(worker, peer, job, {"type": "tool_call", "call_id": call_id, "name": "read_file", "arguments": {"path": "client-only"}})
            probe = {"kind": kind}
            if kind == "delta":
                probe["base_receipt_id"] = job["id"]
            continuation, _ = self.checked("/api/v1/admin/experiments/" + e["id"] + "/tool-results", self.admin, "POST", {"protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": call_id, "output": "exact reconnect result", "context_probe": probe}, want=202)
            queued, _ = self.checked("/api/v1/worker/jobs/" + continuation["current_job_id"], worker["credential"])
            old_generation = peer.opened["connection_generation"]
            peer.stop()
            peer = self.peer(worker)
            require(peer.opened["connection_generation"] > old_generation, "reconnect reused generation")
            claimed, headers, request = self.claim(worker, peer, continuation, want=409 if kind == "delta" else 200)
            if kind == "delta":
                event, _ = self.diagnose(headers["X-Request-Id"], "lease.rejected", "context_base_connection_changed")
                require(event["evidence"]["expected_connection_generation"] == old_generation and event["evidence"]["observed_connection_generation"] == peer.opened["connection_generation"], "delta rejection lost base/current connection evidence")
                stored, _ = self.checked("/api/v1/worker/jobs/" + queued["id"], worker["credential"])
                require(stored == queued and self.status(worker)["work_status"] == "idle" and len(self.experiment(e["id"])["messages"]) == 4, "rejected delta claim mutated retained delivery/history or busy hold")
                self.cancel(e["id"])
            else:
                require(claimed["context"]["kind"] == "full" and len(claimed["context"]["messages"]) == 4 and claimed["context"]["messages"][-1]["output"] == "exact reconnect result", "full continuation lost canonical context after reconnect")
                self.decision(worker, peer, claimed, {"type": "final", "text": claimed["context"]["messages"][-1]["output"]})
        peer.stop()
        self.receipt("inference.queued_context_reconnect", delta_claim_status=409, full_claim_status=200, rejected_delivery_unchanged=True)

    def missing_health_and_bounds(self, worker):
        peer = self.peer(worker, reply=False)
        self.until(lambda: self.status(worker)["connection_status"] == "offline", "missing health replies did not mark offline", timeout=35)
        self.create(worker, "offline", want=409)
        events = self.export_operation(peer.opened["connection_id"])
        require(any(e["msg"] == "worker.connection_changed" and e.get("reason") == "health_reply_expired" for e in events), "health timeout diagnosis missing")
        peer.stop()
        self.receipt("inference.health_timeout", interval_seconds=10, response_window_seconds=30)

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
        held = [self.create(worker, "admission-" + str(i), tools=False) for i in range(8)]
        self.create(worker, "queue-full", tools=False, want=429)
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
        self.docker("stop", self.db)
        _, headers, _ = self.api("/api/v1/admin/experiments/" + e["id"], self.admin)
        event, _ = self.diagnose(headers["X-Request-Id"], "inference.operation_failed")
        require(event["cause"] and event["transaction_outcome"], "dependency failure lacked cause/outcome")
        self.docker("start", self.db)
        self.ready(self.main_service, self.origin_url)
        self.receipt("inference.bounds_redaction_storage_failure", max_jobs=8, body_bytes=1048576, log_only_diagnosis=True)

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
        failure = self.create(worker, "persistence failure after claim callback", tools=False)
        submission = "persistence-fault-" + secrets.token_hex(8)
        self.sql("CREATE FUNCTION inference_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.submission_id='" + submission + "' THEN RAISE EXCEPTION 'controlled inference persistence failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER inference_test_receipt BEFORE INSERT ON aaa_inference_receipts FOR EACH ROW EXECUTE FUNCTION inference_test_fail_receipt();")
        try:
            _, headers, _ = self.claim(worker, peer, failure, submission=submission, want=503)
        finally:
            self.sql("DROP TRIGGER inference_test_receipt ON aaa_inference_receipts; DROP FUNCTION inference_test_fail_receipt();")
        events = self.export_operation(failure["id"])
        failed = [event for event in events if event.get("request_id") == headers["X-Request-Id"] and event["msg"] in ("inference.storage_exchange", "inference.operation_failed")]
        require(len(failed) == 2 and {event["level"] for event in failed} == {"ERROR", "DEBUG"}, "experiment export omitted persistence failure")
        require(all(event["sqlstate"] == "23514" and event["transaction_outcome"] == "rolled_back" and event["conversation_id"] == failure["conversation_id"] and event["job_id"] == failure["current_job_id"] for event in failed), "persistence failure lost cause/transaction/correlation")
        require(self.experiment(failure["id"])["state"] == "queued" and self.status(worker)["work_status"] == "idle", "failed persistence left a claimed turn")
        self.cancel(failure["id"])
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
        config["limits"] = {"max-jobs": 8, "in-flight-per-worker": 1}
        service, h.origin_url, _ = h.launch(config)
        h.main_service = service
        h.ready(service, h.origin_url)
        secondary, second_origin, _ = h.launch(config)
        h.ready(secondary, second_origin)
        a, b, unresponsive = h.new_worker(), h.new_worker(), h.new_worker()
        peer = h.peer(a)
        h.tool_loop(a, peer)
        h.concurrency_and_scope(a, b, peer, second_origin)
        h.docker("stop", "--time", "5", secondary)
        require(not h.inspect(secondary)["State"]["Running"], "secondary broker still emits asynchronous diagnostics")
        h.cancellation_and_deadline(a, peer)
        opened_at = next(event["at"] for event in peer.events if event["type"] == "connection.opened")
        h.until(lambda: any(event["type"] == "health.challenge" and event["at"] - opened_at > 30 for event in peer.events), "no SSE frame observed after the global write deadline", timeout=45)
        h.until(lambda: len(peer.replies) >= 4, "health replies missing", timeout=15)
        from datetime import datetime
        issued = [datetime.fromisoformat(event["data"]["issued_at"].replace("Z", "+00:00")).timestamp() for event in peer.events if event["type"] == "health.challenge"]
        require(issued[3] - issued[0] >= 28 and not peer.errors, "health challenges did not use ten-second cadence")
        intervals = [issued[i + 1] - issued[i] for i in range(3)]
        reply_intervals = [peer.replies[i + 1]["at"] - peer.replies[i]["at"] for i in range(3)]
        require(all(9 <= interval <= 15 for interval in intervals), "observed health cadence differs from ten seconds")
        require(h.status(a)["connection_status"] == "online", "long-lived stream disconnected")
        late_frame = next(event for event in peer.events if event["type"] == "health.challenge" and event["at"] - opened_at > 30)
        h.receipt("inference.long_stream", replies=len(peer.replies), observed_seconds=late_frame["at"] - opened_at, intervals_seconds=intervals, reply_completion_intervals_seconds=reply_intervals)
        from datetime import datetime
        retry_worker, retry_job, retry_body, retry_experiment = h.accepted_retry
        expiry = datetime.fromisoformat(retry_job["lease_expires_at"].replace("Z", "+00:00")).timestamp()
        h.until(lambda: time.time() >= expiry, "accepted receipt lease did not expire", timeout=35)
        h.checked("/api/v1/worker/jobs/" + retry_job["id"] + "/decisions", retry_worker["credential"], "POST", retry_body)
        require(len(h.experiment(retry_experiment)["messages"]) == 5, "accepted retry after lease expiry duplicated history")
        h.receipt("inference.accepted_receipt_after_expiry", original_job=retry_job["id"], history_items=5)
        peer = h.restart(a, peer, service)
        h.disconnect_and_revoke(a, peer)
        h.queued_context_reconnect()
        h.revocation_races()
        h.missing_health_and_bounds(unresponsive)
        final_worker = h.new_worker()
        final_peer = h.peer(final_worker)
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
