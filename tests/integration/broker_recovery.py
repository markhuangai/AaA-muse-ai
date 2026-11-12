#!/usr/bin/env python3
import argparse
from datetime import datetime
import http.client
import json
import os
import secrets
import ssl
import time
import urllib.parse

from routing import Routing
from service import require
from worker_tls import TLSFixture


class Recovery(Routing):
    def restart_broker(self, crash=False):
        if crash:
            self.docker("kill", "--signal", "KILL", self.main_service)
        else:
            self.docker("stop", "--time", "5", self.main_service)
        for peer in self.peers:
            if peer.thread.is_alive():
                peer.stop()
        self.docker("start", self.main_service)
        self.origin_url = self.origin(self.main_service)
        self.origins = [self.origin_url]
        self.ready(self.main_service, self.origin_url)

    def fresh_peer(self, worker, qualify=True):
        self.until(lambda: self.status(worker)["connection_status"] == "offline", "old health lease did not expire", timeout=40)
        return self.peer(worker, qualify=qualify)

    def restored(self, request, boundary=None):
        events = self.filtered_events("operation_id", request["id"])
        matches = [e for e in events if e["msg"] == "recovery.restored"]
        require(matches and all(e["transaction_outcome"] == "committed" for e in matches), "restoration lacks committed evidence")
        require(all(e["client_id"] == "fixture-client" and e["conversation_id"] == request["conversation_id"] and e["request_record_id"] == request["id"] for e in matches), "recovery lost owner/operation correlation")
        require(any(e["msg"] == "recovery.detail" and e["level"] == "DEBUG" for e in events), "protected recovery detail absent")
        if boundary:
            require(any(e["msg"] == "recovery.uncertain" and e["last_boundary"] == boundary and e["automatic_replay"] is False and e["corrective_action"] for e in events), "uncertainty cannot be diagnosed from logs")
        return events

    def live_sibling(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        marker = "recovery-private-" + secrets.token_hex(12) + "\r\n" + "context\n" * 1500
        messages = [{"type": "message", "role": "user", "text": marker + self.client + worker["credential"]}]
        request, _ = self.submit(self.input(worker, messages=messages, tools=[]), "healthy-sibling")
        job, _, claim = self.claim(worker, peer, self.experiment(request["id"]))
        sibling, origin, _ = self.launch(self.configuration())
        self.ready(sibling, origin)
        self.origins.append(origin)
        current = self.detail(request)
        require(current["assignment"]["generation"] == job["generation"] and current["assignment"]["held"] and current["request"]["worker_id"] == worker["worker"]["id"], "sibling startup fenced or replaced live work")
        events = self.trace_request(self.admission_headers[request["id"]]["X-Request-Id"], request["id"])
        require(any(e["msg"] == "recovery.restored" for e in events) and len({e["instance_id"] for e in events}) == 2, "request-to-operation trace omitted a participating broker")
        self.restored(request, "claimed_inference")
        detail = next(e for e in events if e["msg"] == "recovery.detail")
        require(marker in json.dumps(detail).replace("\\r", "\r").replace("\\n", "\n") and "[REDACTED]" in json.dumps(detail), "reconstructable recovery context or redaction missing")
        replay, headers = self.checked("/api/v1/worker/jobs/" + job["id"] + "/claim", worker["credential"], "POST", claim)
        require(replay == job, "valid current-lease claim receipt changed")
        self.trace_request(headers["X-Request-Id"], request["id"])
        _, headers, _ = self.decision(worker, peer, job, {"type": "final", "text": "valid current lease"})
        self.trace_request(headers["X-Request-Id"], request["id"])
        self.read_native(request)
        self.docker("stop", "--time", "5", sibling)
        self.origins.remove(origin)
        require(not self.inspect(sibling)["State"]["Running"], "sibling did not stop")
        peer.stop()
        public = self.logs(sibling)
        require(marker not in public and '"msg":"recovery.detail"' not in public, "private DEBUG restoration reached INFO stdout")
        self.assert_private(public)
        self.receipt("recovery.live_sibling_and_valid_lease", request=request["id"], assignment_generation=job["generation"], sibling_preserved=True, chunk_reconstruction=True, redaction=True)

    def queue_and_uncertain_crash(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        busy, _ = self.submit(self.input(worker, tools=[]), "claimed-before-crash")
        job, _, claim = self.claim(worker, peer, self.experiment(busy["id"]))
        queued, _ = self.submit(self.input(worker, tools=[]), "queued-before-crash")
        before = self.detail(queued)
        require(before["assignment"] is None and before["request"]["state"] == "queued" and "context_delivery_started_at" not in before["request"], "busy-worker native queue was prematurely assigned")
        unclaimed = self.create(worker, "unclaimed experiment across crash", tools=False)
        assigned_before = self.detail(unclaimed)
        require(assigned_before["assignment"]["state"] == "queued", "existing queued assignment fixture missing")
        self.restart_broker(crash=True)
        after = self.detail(queued)
        require(after == before, "restart changed safe queued identity, context or pin")
        require(self.detail(unclaimed) == assigned_before, "restart replaced existing unclaimed assignment or delivery")
        self.restored(queued)
        self.restored(busy, "claimed_inference")
        self.native("POST", "/api/v1/requests/" + busy["id"] + "/cancel", {"protocol_version": 1, "submission_id": secrets.token_hex(12)})
        require(self.status(worker)["work_status"] == "busy", "cancellation cleared uncertain inference")
        current = self.fresh_peer(worker, qualify=False)
        require(current.opened["connection_generation"] > peer.opened["connection_generation"] and self.status(worker)["work_status"] == "busy", "reconnect erased hold or reused generation")
        _, headers = self.checked("/api/v1/worker/jobs/" + job["id"] + "/claim", worker["credential"], "POST", claim, want=409)
        evidence = self.trace_request(headers["X-Request-Id"], busy["id"])
        fenced = next(e for e in evidence if e.get("request_id") == headers["X-Request-Id"] and e["msg"] == "lease.fenced")
        require(fenced["reason"] == "stale_connection" and fenced["outcome"] == "rejected" and fenced["evidence"]["expected_generation"] == job["generation"] and fenced["evidence"]["observed_generation"] == job["generation"] and fenced["evidence"]["expected_connection_generation"] == current.opened["connection_generation"] and fenced["evidence"]["observed_connection_generation"] == peer.opened["connection_generation"], "claim fence omitted current/submitted generations")
        _, headers, _ = self.decision(worker, peer, job, {"type": "final", "text": "must not overwrite"}, want=409)
        events = self.trace_request(headers["X-Request-Id"], busy["id"])
        require(any(e["msg"] == "lease.fenced" and e.get("request_id") == headers["X-Request-Id"] and e["evidence"]["observed_generation"] == job["generation"] for e in events), "stale decision omitted submitted assignment generation")
        other = self.new_worker()
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/claim", other["credential"], "POST", claim, want=404)
        current.acknowledge_idle(job)
        safe_job, _, _ = self.claim(worker, current, self.experiment(unclaimed["id"]))
        require(safe_job["id"] == assigned_before["assignment"]["id"] and safe_job["context"] == assigned_before["delivery"], "re-offered unclaimed assignment changed")
        self.decision(worker, current, safe_job, {"type": "final", "text": "unclaimed result"})
        self.qualify_worker(worker, current)
        self.until(lambda: self.detail(queued)["assignment"] is not None, "restored native queue was not dispatched")
        next_job, _, _ = self.claim(worker, current, self.experiment(queued["id"]))
        require(next_job["generation"] > job["generation"] and next_job["context"]["kind"] == "full" and next_job["context"]["messages"] == before["request"]["input"]["messages"] and next_job["context"]["tools"] == before["request"]["input"]["tools"], "restored native queue lost its context/generation")
        self.decision(worker, current, next_job, {"type": "final", "text": "queued result"})
        self.read_native(queued)
        unresolved = self.experiment(busy["id"])
        require(unresolved["state"] == "cancelled" and unresolved["remote_outcome"] == "unknown", "idle acknowledgement changed uncertain outcome")
        current.stop()
        self.receipt("recovery.queue_crash_cancellation_and_fencing", request=busy["id"], queued=queued["id"], claimed_automatic_retries=0, accepted_queued_results=1, owner_scope=True)

    def lost_decision_ack(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        request, _ = self.submit(self.input(worker, tools=[]), "lost-decision-ack")
        job, _, _ = self.claim(worker, peer, self.experiment(request["id"]))
        body = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "connection_id": peer.opened["connection_id"], "connection_generation": peer.opened["connection_generation"], "conversation_id": job["conversation_id"], "generation": job["generation"], "lease_id": job["lease_id"], "context_receipt_id": job["context"]["receipt_id"], "decision": {"type": "final", "text": "committed exact\r\nresult\n"}}
        proxy = TLSFixture(self, self.origin_url)
        try:
            proxy.drop_decision = True
            address = urllib.parse.urlsplit(proxy.origin)
            connection = http.client.HTTPSConnection(address.hostname, address.port, context=ssl.create_default_context(cafile=str(proxy.cert)), timeout=15)
            lost = False
            try:
                connection.request("POST", "/api/v1/worker/jobs/" + job["id"] + "/decisions", body=json.dumps(body), headers={"Authorization": "Bearer " + worker["credential"], "Content-Type": "application/json"})
                connection.getresponse()
            except (OSError, http.client.HTTPException):
                lost = True
            finally:
                connection.close()
            require(lost and proxy.dropped == 1, "committed decision acknowledgement was not actually dropped")
        finally:
            proxy.close()
        before = self.detail(request)
        require(before["request"]["output"] == body["decision"], "dropped acknowledgement did not commit the decision")
        self.restart_broker(crash=True)
        self.restored(request)
        replay, headers = self.checked("/api/v1/worker/jobs/" + job["id"] + "/decisions", worker["credential"], "POST", body)
        require(replay["state"] == "completed" and replay["final_text"] == body["decision"]["text"], "accepted decision was not replayed")
        self.diagnose(headers["X-Request-Id"], "receipt.replayed")
        self.trace_request(headers["X-Request-Id"], request["id"])
        conflicting = {**body, "decision": {"type": "final", "text": "conflicting"}}
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/decisions", worker["credential"], "POST", conflicting, want=409)
        output, _ = self.read_native(request)
        require(output["output"] == body["decision"] and len([e for e in self.timeline(request["conversation_id"]) if e["kind"] == "decision.accepted"]) == 1, "lost acknowledgement duplicated acceptance or changed output")
        self.receipt("recovery.lost_decision_acknowledgement", request=request["id"], response_dropped=True, accepted_once=True, exact_replay=True)

    def tool_wait_and_settled_pin(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        initial = self.input(worker)
        request, _ = self.submit(initial, "tool-wait-recovery")
        call = {"type": "tool_call", "call_id": "recovery-call-" + secrets.token_hex(8), "name": "read_file", "arguments": {"path": "client-only"}}
        self.deliver(worker, peer, request, call)
        self.read_native(request)
        before = self.detail(request)
        peer.stop()
        self.restart_broker()
        events = self.restored(request)
        require(self.detail(request) == before and any(e["msg"] == "recovery.restored" and e["pending_call_id"] == call["call_id"] and e["pinned_worker_id"] == worker["worker"]["id"] for e in events), "tool wait or acknowledged delivery was not restored")
        current = self.peer(worker)
        contents = "client-only-" + secrets.token_hex(20) + "\r\nexact trailing newline\n"
        result = {"type": "tool_result", "call_id": call["call_id"], "output": contents}
        continued = self.input(worker, initial["messages"] + [call, result], previous=request["response_id"])
        wrong = {**continued, "messages": initial["messages"] + [call, {**result, "call_id": "wrong"}]}
        self.submit(wrong, want=409)
        next_request, _ = self.submit(continued)
        job = self.deliver(worker, current, next_request, {"type": "final", "text": contents})
        require(job["context"]["kind"] == "full" and job["context"]["messages"] == continued["messages"], "restarted continuation changed exact full history/tool result")
        final, _ = self.read_native(next_request)
        require(final["output"]["text"] == contents and final["worker_id"] == worker["worker"]["id"], "tool continuation changed bytes or pin")
        canonical = continued["messages"] + [{"type": "message", "role": "assistant", "text": contents}]
        current.stop()
        self.restart_broker()
        current = self.peer(worker)
        later, _ = self.submit(self.input(worker, canonical + [{"type": "message", "role": "user", "text": "next completed-session turn"}], tools=[]), "tool-wait-recovery")
        require(later["conversation_id"] == request["conversation_id"] and later["worker_id"] == worker["worker"]["id"], "settled session lost durable affinity")
        self.deliver(worker, current, later, {"type": "final", "text": "later"})
        self.read_native(later)
        current.stop()
        self.receipt("recovery.native_tool_wait_and_settled_affinity", request=request["id"], call_id=call["call_id"], exact_result=True, full_history=True, pin_preserved=True)

    def incomplete_output(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        request, _ = self.submit(self.input(worker, tools=[]), "output-boundary-recovery")
        self.deliver(worker, peer, request, {"type": "final", "text": "durable output"})
        constraint = "recovery_output_finish"
        self.sql("ALTER TABLE aaa_model_requests ADD CONSTRAINT " + constraint + " CHECK(id <> '" + request["id"] + "' OR data->>'output_completed_at' IS NULL);")
        try:
            _, headers = self.read_native(request)
            self.trace_request(headers["X-Request-Id"], request["id"])
            before = self.detail(request)
            require("output_started_at" in before["request"] and "output_completed_at" not in before["request"], "incomplete-output fixture falsely completed")
        finally:
            self.sql("ALTER TABLE aaa_model_requests DROP CONSTRAINT " + constraint + ";")
        peer.stop()
        self.restart_broker()
        require(self.detail(request) == before, "restart altered accepted output or delivery boundaries")
        self.restored(request, "output_delivery")
        output, _ = self.read_native(request)
        require(output["output"]["text"] == "durable output" and "output_completed_at" in self.detail(request)["request"], "durable output could not be retrieved without inference")
        self.receipt("recovery.incomplete_output_boundary", request=request["id"], retained_output=True, automatic_inference_retries=0, log_only_diagnosis=True)

    def incomplete_context_without_decision(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        request, _ = self.submit(self.input(worker, tools=[]), "context-only-recovery")
        job = self.detail(request)["assignment"]
        constraint = "recovery_context_finish"
        self.sql("ALTER TABLE aaa_model_requests ADD CONSTRAINT " + constraint + " CHECK(id <> '" + request["id"] + "' OR data->>'context_delivery_written_at' IS NULL);")
        try:
            _, headers = self.checked("/api/v1/worker/jobs/" + job["id"], worker["credential"])
            self.trace_request(headers["X-Request-Id"], request["id"])
            before = self.detail(request)
            require(before["request"]["state"] == "queued" and "context_delivery_started_at" in before["request"] and "context_delivery_written_at" not in before["request"] and "output" not in before["request"] and before["assignment"]["claimed_at"] is None, "context-only fixture contains inference or a decision")
        finally:
            self.sql("ALTER TABLE aaa_model_requests DROP CONSTRAINT " + constraint + ";")
        peer.stop()
        self.restart_broker()
        require(self.detail(request) == before, "context-only recovery changed assignment or manufactured output")
        events = self.restored(request, "context_delivery")
        warning = next(e for e in events if e["msg"] == "recovery.uncertain" and e["last_boundary"] == "context_delivery")
        require(warning["reason"] == "delivery_completion_receipt_missing" and warning["decision_available"] is False and "same unclaimed job" in warning["corrective_action"], "context-only diagnosis prescribed a nonexistent decision")
        current = self.peer(worker)
        actual, _, _ = self.claim(worker, current, self.experiment(request["id"]))
        require(actual["id"] == job["id"], "context-only recovery created replacement work")
        self.decision(worker, current, actual, {"type": "final", "text": "context recovered"})
        self.read_native(request)
        current.stop()
        self.receipt("recovery.context_without_decision", request=request["id"], decision_available=False, same_assignment=True, log_only_diagnosis=True)

    def expired_lease_and_failed_startup(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        request, _ = self.submit(self.input(worker, tools=[]), "startup-storage-failure")
        job, _, claim = self.claim(worker, peer, self.experiment(request["id"]))
        self.docker("kill", "--signal", "KILL", self.main_service)
        peer.stop()
        constraint = "recovery_controlled_job_fence"
        self.sql("ALTER TABLE aaa_inference_jobs ADD CONSTRAINT " + constraint + " CHECK(id <> '" + job["id"] + "' OR state <> 'interrupted');")
        expiry = datetime.fromisoformat(job["lease_expires_at"].replace("Z", "+00:00")).timestamp()
        self.until(lambda: time.time() >= expiry, "controlled lease did not expire", timeout=40)
        try:
            self.docker("start", self.main_service)
            require(self.docker("wait", self.main_service, timeout=35).stdout.strip() == "1", "failed reconciliation still served requests")
            logs = self.logs(self.main_service)
            self.assert_private(logs)
            events = [json.loads(line) for line in logs.splitlines() if line.startswith("{")]
            failed = [e for e in events if e.get("msg") == "recovery.failed"][-1]
            require(failed["sqlstate"] == "23514" and failed["transaction_outcome"] == "rolled_back", "startup failure lacks causal storage outcome")
            require(not any(e["msg"] in ("recovery.restored", "server.started") and e["instance_id"] == failed["instance_id"] for e in events), "failed startup falsely restored state or became ready")
        finally:
            self.sql("ALTER TABLE aaa_inference_jobs DROP CONSTRAINT " + constraint + ";")
        self.docker("start", self.main_service)
        self.origin_url = self.origin(self.main_service)
        self.origins = [self.origin_url]
        self.ready(self.main_service, self.origin_url)
        evidence = self.export_operation(failed["operation_id"])
        require(any(e["msg"] == "inference.storage_exchange" and e["level"] == "DEBUG" and constraint in e["detail"] and e["sqlstate"] == "23514" for e in evidence), "original failed startup cannot be diagnosed from retained logs")
        state = self.detail(request)
        require(state["request"]["state"] == "interrupted" and state["assignment"]["held"] and state["assignment"]["generation"] == job["generation"], "expired inference was lost, replayed or released")
        self.restored(request, "claimed_inference")
        _, headers = self.checked("/api/v1/worker/jobs/" + job["id"] + "/claim", worker["credential"], "POST", claim, want=409)
        traced = self.trace_request(headers["X-Request-Id"], request["id"])
        require(any(e["msg"] == "lease.fenced" and e.get("request_id") == headers["X-Request-Id"] and e["reason"] == "stale_connection" for e in traced), "expired claim fence missing from linked trace")
        current = self.peer(worker, qualify=False)
        require(self.status(worker)["work_status"] == "busy", "fresh connection cleared recovered uncertainty")
        current.acknowledge_idle(job)
        current.stop()
        self.receipt("recovery.expired_lease_failed_startup_and_log_diagnosis", request=request["id"], failed_startup=failed["operation_id"], corrective_action="repair the rejecting database constraint and restart; preserve the uncertain assignment until its exact idle acknowledgement", log_only_diagnosis=True, failed_startup_never_ready=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = Recovery(args)
    try:
        h.baseline()
        h.setup()
        h.main_service, h.origin_url, _ = h.launch(h.configuration())
        h.origins = [h.origin_url]
        h.ready(h.main_service, h.origin_url)
        h.live_sibling()
        h.queue_and_uncertain_crash()
        h.lost_decision_ack()
        h.tool_wait_and_settled_pin()
        h.incomplete_output()
        h.incomplete_context_without_decision()
        h.expired_lease_and_failed_startup()
        h.private("results.json", json.dumps({"suite": "broker-recovery", "source_sha": args.source_sha, "synthetic_peer": True, "receipts": h.receipts}))
    finally:
        failures = []
        for peer in h.peers:
            if peer.thread.is_alive():
                try:
                    peer.stop()
                except Exception as error:
                    failures.append(type(error).__name__)
        h.cleanup()
        require(not failures, "recovery peer cleanup failed")


if __name__ == "__main__":
    main()
