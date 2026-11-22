#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import http.client
import json
import os
import secrets
import ssl
import threading
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
        self.docker("start", self.main_service)
        self.origin_url = self.origin(self.main_service)
        self.origins = [self.origin_url]
        self.ready(self.main_service, self.origin_url)

    def offline_duration_across_brokers(self):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        self.silence(worker, 605)
        before = self.worker_projection(worker)[0]["offline_for_ms"]
        sibling, origin, _ = self.launch(self.configuration())
        self.ready(sibling, origin)
        try:
            self.restart_broker()
            after = self.worker_projection(worker)[0]
            other = self.worker_projection(worker, origin=origin)[0]
            require(after["connection_status"] == other["connection_status"] == "offline"
                    and other["offline_for_ms"] >= after["offline_for_ms"] >= before, "offline duration was reset across brokers or restart")
            require(peer.poll(origin) is None, "resumed idle poll granted unexpected work")
            recovered, _ = self.worker_projection(worker, origin=origin)
            require(recovered["connection_status"] == "recent" and "offline_for_ms" not in recovered, "sibling did not observe resumed polls")
        finally:
            self.docker("stop", "--time", "5", sibling)
        self.receipt("recovery.offline_duration_across_brokers", restart_preserved=True, sibling_observed_poll=True)

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
        peer = self.pull_peer(worker)
        marker = "recovery-private-" + secrets.token_hex(12) + "\x00 literal\\u0000\r\n" + "context\n" * 1500
        messages = [{"type": "message", "role": "user", "text": marker + self.client + worker["credential"]}]
        request, _ = self.submit(self.input(worker, messages=messages, tools=[]), "healthy-sibling")
        poll = peer.poll_input()
        grant = peer.poll(payload=poll)
        job, _, start = peer.begin(grant)
        sibling, origin, _ = self.launch(self.configuration())
        self.ready(sibling, origin)
        self.origins.append(origin)
        current = self.detail(request)
        require(current["assignment"]["generation"] == job["generation"] and current["assignment"]["held"] and current["request"]["worker_id"] == worker["worker"]["id"], "sibling startup fenced or replaced live work")
        events = self.trace_request(self.admission_headers[request["id"]]["X-Request-Id"], request["id"])
        require(any(e["msg"] == "recovery.restored" for e in events) and len({e["instance_id"] for e in events}) == 2, "request-to-operation trace omitted a participating broker")
        self.restored(request, "claimed_inference")
        detail = next(e for e in events if e["msg"] == "recovery.detail")
        require(detail["request"]["input"]["messages"][0]["text"].startswith(marker) and "[REDACTED]" in json.dumps(detail), "reconstructable recovery context or redaction missing")
        replay, headers = self.checked("/api/v1/worker/pull", worker["credential"], "POST", poll, origin=origin)
        require(replay["job"] == grant, "valid pull receipt changed across brokers")
        self.trace_request(headers["X-Request-Id"], request["id"])
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/start", worker["credential"], "POST", start, want=409, origin=origin)
        _, headers, _ = self.decision(worker, peer, job, {"type": "final", "text": "valid current claim"})
        self.trace_request(headers["X-Request-Id"], request["id"])
        self.read_native(request)
        self.docker("stop", "--time", "5", sibling)
        self.origins.remove(origin)
        require(not self.inspect(sibling)["State"]["Running"], "sibling did not stop")
        public = self.logs(sibling)
        require(marker not in public and '"msg":"recovery.detail"' not in public, "private DEBUG restoration reached INFO stdout")
        self.assert_private(public)
        self.receipt("recovery.live_sibling_and_valid_claim", request=request["id"], assignment_generation=job["generation"], sibling_preserved=True, chunk_reconstruction=True, redaction=True)

    def queue_and_uncertain_crash(self):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        busy, _ = self.submit(self.input(worker, messages=[{"type": "message", "role": "user", "text": "held\x00 literal\\u0000"}], tools=[]), "claimed-before-crash")
        job, _, start = self.claim(worker, peer, self.experiment(busy["id"]))
        queued, _ = self.submit(self.input(worker, tools=[]), "queued-before-crash")
        before = self.detail(queued)
        require(before["request"]["state"] == "queued" and not before["assignment"]["held"] and "context_delivery_started_at" not in before["request"], "queued job was prematurely granted")
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
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/start", worker["credential"], "POST", start, want=409)
        _, headers, _ = self.decision(worker, peer, job, {"type": "final", "text": "must not overwrite"}, want=409)
        events = self.trace_request(headers["X-Request-Id"], busy["id"])
        require(any(e["msg"] == "lease.fenced" and e.get("request_id") == headers["X-Request-Id"] and e["evidence"]["observed_generation"] == job["generation"] for e in events), "stale decision omitted submitted assignment generation")
        other = self.new_worker()
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/start", other["credential"], "POST", start, want=404)
        require(self.experiment(busy["id"])["remote_outcome"] == "unknown", "cancellation invented a native outcome")
        peer.settle(job, "cancelled")
        next_job, _, _ = self.claim(worker, peer, self.experiment(queued["id"]))
        require(next_job["lease_id"] != job["lease_id"] and next_job["context"]["kind"] == "full" and next_job["context"]["messages"] == before["request"]["input"]["messages"], "restored queue lost its canonical context or claim fence")
        self.decision(worker, peer, next_job, {"type": "final", "text": "queued result"})
        safe_job, _, _ = self.claim(worker, peer, self.experiment(unclaimed["id"]))
        require(safe_job["id"] == assigned_before["assignment"]["id"] and safe_job["context"] == assigned_before["delivery"], "re-offered unclaimed job changed")
        self.decision(worker, peer, safe_job, {"type": "final", "text": "unclaimed result"})
        self.read_native(queued)
        unresolved = self.experiment(busy["id"])
        require(unresolved["state"] == "cancelled" and unresolved["remote_outcome"] == "execution_confirmed_stopped", "exact settlement lost cancellation or observed stop")
        self.receipt("recovery.queue_crash_cancellation_and_fencing", request=busy["id"], queued=queued["id"], claimed_automatic_retries=0, accepted_queued_results=1, owner_scope=True)

    def lost_decision_ack(self):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        request, _ = self.submit(self.input(worker, tools=[]), "lost-decision-ack")
        job, _, _ = self.claim(worker, peer, self.experiment(request["id"]))
        body = self.decision_body(job, "committed exact\x00 literal\\u0000\r\nresult\n")
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
        peer.settle(job, "accepted")
        self.receipt("recovery.lost_decision_acknowledgement", request=request["id"], response_dropped=True, accepted_once=True, exact_replay=True, nul_output=True)

    def decision_body(self, job, text):
        return {"protocol_version": 1, "submission_id": secrets.token_hex(12), "connection_id": "", "connection_generation": 0,
                "conversation_id": job["conversation_id"], "generation": job["generation"], "lease_id": job["lease_id"],
                "context_receipt_id": job["context"]["receipt_id"], "decision": {"type": "final", "text": text}}

    def racing_terminal_submissions(self):
        sibling, origin, _ = self.launch(self.configuration())
        self.ready(sibling, origin)
        self.origins.append(origin)
        try:
            worker = self.new_worker()
            peer = self.pull_peer(worker)
            request, _ = self.submit(self.input(worker, tools=[]), "terminal-race")
            job, _, start = self.claim(worker, peer, self.experiment(request["id"]))
            result = self.decision_body(job, "race answer")
            stop = {**start, "submission_id": "verified-stop", "native_run_id": "race-execution", "reason": "execution_confirmed_stopped"}
            path = "/api/v1/worker/jobs/" + job["id"]
            ready = threading.Barrier(2, timeout=10)

            def send(suffix, body, server):
                ready.wait()
                return self.api(path + suffix, worker["credential"], "POST", body, origin=server)

            with ThreadPoolExecutor(max_workers=2) as pool:
                decision = pool.submit(send, "/decisions", result, self.origin_url)
                interruption = pool.submit(send, "/interrupt", stop, origin)
                result_status, result_headers, result_bytes = decision.result()
                stop_status, stop_headers, stop_bytes = interruption.result()
            require(stop_status == 200 and result_status in (200, 409), "race did not produce a committed terminal outcome")
            terminal = json.loads(stop_bytes)
            require(terminal["job_id"] == job["id"] and terminal["claim_id"] == job["lease_id"], "race settled a different claim")
            stop_replay = self.api(path + "/interrupt", worker["credential"], "POST", stop, origin=self.origin_url)
            result_replay = self.api(path + "/decisions", worker["credential"], "POST", result, origin=origin)
            require(stop_replay[0] == 200 and stop_replay[2] == stop_bytes and result_replay[0] == result_status and result_replay[2] == result_bytes, "cross-broker retry changed the receipt")
            view, _ = self.read_native(request)
            if result_status == 200:
                require(terminal["state"] == "accepted" and terminal["accepted"] == json.loads(result_bytes) and view["output"] == result["decision"], "interruption overwrote the earlier accepted result")
            else:
                require(terminal["state"] == "interrupted" and view["state"] == "interrupted" and not view.get("output"), "late result escaped the interruption fence")
            evidence = self.trace_request(result_headers["X-Request-Id"], request["id"])
            evidence += self.trace_request(stop_headers["X-Request-Id"], request["id"])
            require(any(event["msg"] == "job.work_settled" and event["claim_id"] == job["lease_id"] and event["native_run_id"] == "race-execution" for event in evidence), "logs do not identify the settled native execution")
            self.receipt("recovery.decision_interruption_race", exact_replay=True, state=terminal["state"], broker_processes=2)
        finally:
            self.docker("stop", "--time", "5", sibling)
            self.origins.remove(origin)

    def tool_wait_and_settled_pin(self):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        initial = self.input(worker)
        initial["messages"][0]["text"] += "\x00 literal\\u0000"
        request, _ = self.submit(initial, "tool-wait-recovery")
        call = {"type": "tool_call", "call_id": "recovery-call-" + secrets.token_hex(8), "name": "read_file", "arguments": {"path": "client-only"}}
        self.deliver(worker, peer, request, call)
        self.read_native(request)
        before = self.detail(request)
        self.restart_broker()
        events = self.restored(request)
        require(self.detail(request) == before and any(e["msg"] == "recovery.restored" and e["pending_call_id"] == call["call_id"] and e["pinned_worker_id"] == worker["worker"]["id"] for e in events), "tool wait or acknowledged delivery was not restored")
        contents = "client-only-" + secrets.token_hex(20) + "\x00 literal\\u0000\r\nexact trailing newline\n"
        result = {"type": "tool_result", "call_id": call["call_id"], "output": contents}
        continued = self.input(worker, initial["messages"] + [call, result], previous=request["response_id"])
        wrong = {**continued, "messages": initial["messages"] + [call, {**result, "call_id": "wrong"}]}
        self.submit(wrong, want=409)
        next_request, _ = self.submit(continued)
        job = self.deliver(worker, peer, next_request, {"type": "final", "text": contents})
        require(job["context"]["kind"] == "full" and job["context"]["messages"] == continued["messages"], "restarted continuation changed exact full history/tool result")
        final, _ = self.read_native(next_request)
        require(final["output"]["text"] == contents and final["worker_id"] == worker["worker"]["id"], "tool continuation changed bytes or pin")
        canonical = continued["messages"] + [{"type": "message", "role": "assistant", "text": contents}]
        self.restart_broker()
        later, _ = self.submit(self.input(worker, canonical + [{"type": "message", "role": "user", "text": "next completed-session turn"}], tools=[]), "tool-wait-recovery")
        require(later["conversation_id"] == request["conversation_id"] and later["worker_id"] == worker["worker"]["id"], "settled session lost durable affinity")
        self.deliver(worker, peer, later, {"type": "final", "text": "later"})
        self.read_native(later)
        self.receipt("recovery.native_tool_wait_and_settled_affinity", request=request["id"], call_id=call["call_id"], exact_result=True, full_history=True, pin_preserved=True, nul_input_and_result=True)

    def incomplete_output(self):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        request, _ = self.submit(self.input(worker, tools=[]), "output-boundary-recovery")
        output_text = "durable output\x00 literal\\u0000"
        self.deliver(worker, peer, request, {"type": "final", "text": output_text})
        constraint = "recovery_output_finish"
        self.reject_writes(constraint, "aaa_model_requests", "NEW.id='" + request["id"] + "' AND json_extract(CAST(NEW.data AS TEXT),'$.output_completed_at') IS NOT NULL")
        try:
            _, headers = self.read_native(request)
            self.trace_request(headers["X-Request-Id"], request["id"])
            before = self.detail(request)
            require("output_started_at" in before["request"] and "output_completed_at" not in before["request"], "incomplete-output fixture falsely completed")
        finally:
            self.sql("DROP TRIGGER " + constraint + ";")
        self.restart_broker()
        require(self.detail(request) == before, "restart altered accepted output or delivery boundaries")
        self.restored(request, "output_delivery")
        output, _ = self.read_native(request)
        require(output["output"]["text"] == output_text and "output_completed_at" in self.detail(request)["request"], "durable output could not be retrieved without inference")
        self.receipt("recovery.incomplete_output_boundary", request=request["id"], retained_output=True, automatic_inference_retries=0, log_only_diagnosis=True, nul_output=True)

    def incomplete_context_without_decision(self):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        request, _ = self.submit(self.input(worker, messages=[{"type": "message", "role": "user", "text": "context\x00 literal\\u0000"}], tools=[]), "context-only-recovery")
        constraint = "recovery_context_finish"
        self.reject_writes(constraint, "aaa_model_requests", "NEW.id='" + request["id"] + "' AND json_extract(CAST(NEW.data AS TEXT),'$.context_delivery_written_at') IS NOT NULL")
        try:
            job, headers, start = self.claim(worker, peer, self.experiment(request["id"]))
            self.trace_request(headers["X-Request-Id"], request["id"])
            before = self.detail(request)
            require(before["request"]["state"] == "inference" and "context_delivery_started_at" in before["request"] and "context_delivery_written_at" not in before["request"] and "output" not in before["request"] and before["assignment"]["held"], "start response fixture did not retain an uncertain brief delivery")
        finally:
            self.sql("DROP TRIGGER " + constraint + ";")
        self.restart_broker()
        require(self.detail(request) == before, "context-only recovery changed assignment or manufactured output")
        events = self.restored(request, "context_delivery")
        warning = next(e for e in events if e["msg"] == "recovery.uncertain" and e["last_boundary"] == "context_delivery")
        require(warning["reason"] == "delivery_completion_receipt_missing" and warning["decision_available"] is False and "exact native execution" in warning["corrective_action"], "start delivery diagnosis did not hold the native claim")
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/start", worker["credential"], "POST", start, want=409)
        self.decision(worker, peer, job, {"type": "final", "text": "context recovered"})
        self.read_native(request)
        self.receipt("recovery.context_without_decision", request=request["id"], decision_available=False, same_assignment=True, log_only_diagnosis=True)

    def expired_claim_and_failed_startup(self):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        request, _ = self.submit(self.input(worker, messages=[{"type": "message", "role": "user", "text": "startup\x00 literal\\u0000"}], tools=[], timeout=8), "startup-storage-failure")
        job, _, start = self.claim(worker, peer, self.experiment(request["id"]))
        self.docker("kill", "--signal", "KILL", self.main_service)
        constraint = "recovery_controlled_job_fence"
        self.reject_writes(constraint, "aaa_inference_jobs", "NEW.id='" + job["id"] + "' AND NEW.state='interrupted'")
        expiry = datetime.fromisoformat(job["deadline_at"].replace("Z", "+00:00")).timestamp()
        self.until(lambda: time.time() >= expiry, "controlled claim did not reach its deadline", timeout=15)
        try:
            self.docker("start", self.main_service)
            require(self.docker("wait", self.main_service, timeout=35).stdout.strip() == "1", "failed reconciliation still served requests")
            logs = self.logs(self.main_service)
            self.assert_private(logs)
            events = [json.loads(line) for line in logs.splitlines() if line.startswith("{")]
            failed = [e for e in events if e.get("msg") == "recovery.failed"][-1]
            require(failed["sqlite_code"] == "1811" and failed["transaction_outcome"] == "rolled_back", "startup failure lacks causal storage outcome")
            require(not any(e["msg"] in ("recovery.restored", "server.started") and e["instance_id"] == failed["instance_id"] for e in events), "failed startup falsely restored state or became ready")
        finally:
            self.sql("DROP TRIGGER " + constraint + ";")
        self.docker("start", self.main_service)
        self.origin_url = self.origin(self.main_service)
        self.origins = [self.origin_url]
        self.ready(self.main_service, self.origin_url)
        evidence = self.export_operation(failed["operation_id"])
        require(any(e["msg"] == "inference.storage_exchange" and e["level"] == "DEBUG" and constraint in e["detail"] and e["sqlite_code"] == "1811" for e in evidence), "original failed startup cannot be diagnosed from retained logs")
        state = self.detail(request)
        require(state["request"]["state"] == "interrupted" and state["assignment"]["held"] and state["assignment"]["generation"] == job["generation"], "expired inference was lost, replayed or released")
        self.restored(request, "claimed_inference")
        _, headers = self.checked("/api/v1/worker/jobs/" + job["id"] + "/start", worker["credential"], "POST", start, want=409)
        traced = self.trace_request(headers["X-Request-Id"], request["id"])
        require(any(e["msg"] == "lease.fenced" and e.get("request_id") == headers["X-Request-Id"] and e["reason"] == "stale_assignment" for e in traced), "expired claim fence missing from linked trace")
        require(self.worker_projection(worker)[0]["work_status"] == "busy", "expiry cleared recovered uncertainty")
        peer.settle(job, "interrupted")
        self.receipt("recovery.expired_claim_failed_startup_and_log_diagnosis", request=request["id"], failed_startup=failed["operation_id"], corrective_action="repair the rejecting database constraint and restart; settle only after observing the exact execution and its producers", log_only_diagnosis=True, failed_startup_never_ready=True)


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
        h.offline_duration_across_brokers()
        h.queue_and_uncertain_crash()
        h.lost_decision_ack()
        h.racing_terminal_submissions()
        h.tool_wait_and_settled_pin()
        h.incomplete_output()
        h.incomplete_context_without_decision()
        h.expired_claim_and_failed_startup()
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
