#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import secrets
import subprocess

from history import History
from service import require


class Routing(History):
    def __init__(self, args):
        super().__init__(args)
        self.requests = []
        self.origins = []
        self.admission_headers = {}

    def configuration(self, generated=False):
        config = super().configuration(generated)
        config["limits"]["max-jobs"] = 8
        return config

    def request_input(self, text=None, tools=False, timeout=300):
        body = self.input({"worker": {"id": "unused"}}, messages=[{"type": "message", "role": "user", "text": text or secrets.token_hex(20)}],
                          tools=None if tools else [], timeout=timeout)
        body.pop("worker_id")
        return body

    def submit(self, *args, **kwargs):
        result, headers = super().submit(*args, **kwargs)
        if "id" in result:
            self.requests.append(result)
            self.admission_headers.setdefault(result["id"], headers)
        return result, headers

    def new_pair(self):
        for request in self.requests:
            current, _ = self.read_native(request)
            if current["state"] not in ("completed", "cancelled", "interrupted"):
                self.native("POST", "/api/v1/requests/" + request["id"] + "/cancel", {"protocol_version": 1, "submission_id": secrets.token_hex(12)})
        self.requests = []
        for peer in self.peers:
            if peer.thread.is_alive():
                peer.stop()
        workers = [self.new_worker(), self.new_worker()]
        return [(worker, self.peer(worker)) for worker in workers]

    def assigned(self, request):
        self.until(lambda: self.detail(request)["assignment"] is not None, "queued native request was not assigned", timeout=15)
        return self.read_native(request)[0]

    def filtered_events(self, name, identity):
        events = []
        for index, origin in enumerate(self.origins):
            status, _, raw = self.api("/api/v1/admin/diagnostics/export?" + name + "=" + identity, self.admin, origin=origin)
            require(status == 200, "filtered broker export failed")
            path = self.private("routing-" + name + "-" + identity + "-" + str(index) + "-" + secrets.token_hex(4) + ".ndjson", raw.decode())
            metadata, selected = self.decode_export(raw)
            if not selected:
                require(metadata["captures"] == 0 and metadata["complete"] is False and metadata["omissions"] == ["requested_identity_not_captured_in_interval"] and len(raw.splitlines()) == 1, "absent broker identity was confused with incomplete evidence")
                continue
            require(metadata["complete"] and metadata["omissions"] == [] and all(e.get(name) == identity for e in selected), "filtered export has omissions or crossed identities")
            code = "import {readFileSync} from 'node:fs'; import {decodeExport} from './tools/qualification-evidence.mjs'; decodeExport(readFileSync(process.argv[1],'utf8'));"
            decoded = subprocess.run(["node", "--input-type=module", "-e", code, str(path)], capture_output=True, text=True, timeout=20)
            require(decoded.returncode == 0, "production decoder rejected filtered chunks/digests")
            self.assert_private(json.dumps(selected))
            events.extend(selected)
        require(events, "identity absent from both broker captures")
        return events

    def trace_request(self, request_id, expected_operation=None):
        requested = self.filtered_events("request_id", request_id)
        operations = sorted({e["operation_id"] for e in requested if e.get("operation_id")})
        if expected_operation:
            require(expected_operation in operations, "HTTP request lost its operation linkage")
        events = list(requested)
        for operation in operations:
            events.extend(self.filtered_events("operation_id", operation))
        events = list({json.dumps(e, sort_keys=True): e for e in events}.values())
        own = [e for e in events if expected_operation and e.get("operation_id") == expected_operation]
        if own:
            owners = {e["client_id"] for e in own if e.get("client_id")}
            conversations = {e["conversation_id"] for e in own if e.get("conversation_id")}
            require(owners == {"fixture-client"} and len(conversations) == 1, "async operation crossed owner/conversation correlation")
            assignments = [e for e in own if e["msg"] in ("dispatch.assigned", "job.claimed", "request.context_delivery_started")]
            require(all(e.get("job_id") and e.get("worker_id") and e.get("connection_generation", 0) > 0 and "generation" in e for e in assignments), "async assignment omitted worker/job/generation linkage")
        self.private("routing-trace-" + request_id + ".json", json.dumps({"request_id": request_id, "operation_ids": operations, "events": events}))
        return events

    def diagnose_dispatch(self, request_id, event, reason):
        events = self.trace_request(request_id)
        matched = [value for value in events if value.get("request_id") == request_id and value["msg"] == event]
        require(len(matched) == 1 and matched[0]["reason"] == reason and matched[0]["level"] == "WARN", "routing failure is not diagnosable from logs")
        require(any(value.get("request_id") == request_id and value["msg"] == "inference.exchange" and value["level"] == "DEBUG" for value in events), "protected rejected input missing")
        evidence = matched[0]["evidence"]
        if reason == "no_ready_worker":
            require(evidence["candidates"] and all(c["eligibility_reason"] for c in evidence["candidates"]), "rejection omitted causal eligibility exclusions")
        action = "record fresh matching qualification" if reason == "no_ready_worker" else "reduce admitted work or raise the documented max-jobs bound"
        self.private("routing-diagnosis-" + request_id + ".json", json.dumps({"cause": reason, "evidence": matched, "corrective_action": action}))

    def diagnose_operation(self, request, event_name, action):
        events = self.trace_request(self.admission_headers[request["id"]]["X-Request-Id"], request["id"])
        matches = [e for e in events if e.get("operation_id") == request["id"] and e["msg"] == event_name]
        require(matches, "operation boundary missing: " + event_name)
        self.private("routing-diagnosis-" + request["id"] + ".json", json.dumps({"cause_event": event_name, "evidence": matches, "corrective_action": action}))
        return events

    def eligibility(self):
        worker = self.new_worker()
        peer = self.peer(worker, qualify=False)
        _, headers = self.submit(self.request_input(), want=503)
        self.diagnose_dispatch(headers["X-Request-Id"], "dispatch.rejected", "no_ready_worker")
        self.qualify_worker(worker, peer, tools=False)
        _, headers = self.submit(self.request_input(tools=True), want=503)
        self.diagnose_dispatch(headers["X-Request-Id"], "dispatch.rejected", "no_ready_worker")
        approval, body = self.qualify_worker(worker, peer)
        path = "/api/v1/admin/workers/" + worker["worker"]["id"] + "/qualifications"
        for key in (worker["credential"], self.client, self.portal):
            self.checked(path, key, "POST", body, want=401)
        replay, _ = self.checked(path, self.admin, "POST", body)
        require(replay["id"] == approval["id"], "qualification retry added authority")
        self.checked(path, self.admin, "POST", {**body, "evidence_reference": "conflicting"}, want=409)
        other = self.new_worker()
        other_peer = self.peer(other, qualify=False)
        other_path = "/api/v1/admin/workers/" + other["worker"]["id"] + "/qualifications"
        self.checked(other_path, self.admin, "POST", body, want=409)
        request, _ = self.submit(self.request_input(), "eligible")
        self.deliver(worker, peer, request, {"type": "final", "text": "eligible answer"})
        self.read_native(request)
        peer.stop()
        replacement = self.peer(worker, qualify=False)
        require(self.status(worker)["inference_readiness"] == "stale", "reconnection retained readiness")
        self.submit(self.request_input(), want=503)
        self.checked(path, self.admin, "POST", {**body, "submission_id": secrets.token_hex(12)}, want=409)
        self.qualify_worker(worker, replacement)
        withdrawal = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "action": "withdraw", "evidence_reference": "controlled withdrawal"}
        self.checked(path, self.admin, "POST", withdrawal)
        self.checked(other_path, self.admin, "POST", withdrawal, want=409)
        require(self.status(other)["inference_readiness"] == "unverified", "cross-worker withdrawal falsely changed authority")
        self.submit(self.request_input(), want=503)
        replacement.stop()
        other_peer.stop()
        self.receipt("routing.eligibility_provenance_and_reconnect", heartbeat_is_not_readiness=True, synthetic_peer=True)

    def competing_requests(self):
        pair = self.new_pair()
        by_id = {worker["worker"]["id"]: (worker, peer) for worker, peer in pair}
        a_input, b_input = self.request_input("A-only"), self.request_input("B-only")
        with ThreadPoolExecutor(max_workers=2) as pool:
            admitted = list(pool.map(lambda entry: self.submit(entry[0], entry[1], origin=entry[2]), [(a_input, "A", self.origins[0]), (b_input, "B", self.origins[1])]))
        a, b = admitted[0][0], admitted[1][0]
        require(a["worker_id"] != b["worker_id"], "idle workers not distributed")
        aw, ap = by_id[a["worker_id"]]
        bw, bp = by_id[b["worker_id"]]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda entry: self.claim(*entry), [(aw, ap, self.experiment(a["id"])), (bw, bp, self.experiment(b["id"]))]))
        aj, bj = results[0][0], results[1][0]
        require(aj["context"]["messages"] == a_input["messages"] and bj["context"]["messages"] == b_input["messages"], "contexts crossed sessions")
        require(aj["qualification"]["evidence"]["evidence_kind"] == "controlled", "assignment qualification omitted")
        self.checked("/api/v1/worker/jobs/" + aj["id"], bw["credential"], want=404)
        self.claim(aw, ap, self.experiment(a["id"]), want=409)
        c_body = {**self.request_input("C-only"), "worker_id": a["worker_id"]}
        c, _ = self.submit(c_body, "C")
        d, _ = self.submit(self.request_input("D-only"), "D")
        require(not c["worker_id"] and not d["worker_id"] and self.detail(c)["assignment"] is None, "busy workers received early assignments")
        conversation, _ = self.checked("/api/v1/admin/conversations/" + c["conversation_id"], self.admin)
        require(conversation["worker_id"] is None, "explicit constraint became an unassigned conversation identity")
        waiting = self.diagnose_operation(c, "dispatch.queued", "wait for the selected worker capacity; do not move an established pin")
        queued = next(e for e in waiting if e["msg"] == "dispatch.queued" and e.get("operation_id") == c["id"])
        selected = next(candidate for candidate in queued["candidates"] if candidate["worker_id"] == a["worker_id"])
        require(selected["exclusion_reason"] == "worker_capacity" and not selected["capacity_available"] and selected["reservations"], "stall lacks causal reservation evidence")
        self.decision(aw, ap, aj, {"type": "final", "text": "A-only answer"})
        assigned_c = self.assigned(c)
        require(assigned_c["worker_id"] == aw["worker"]["id"] and not self.read_native(d)[0]["worker_id"], "FIFO or one-worker reservation failed")
        self.decision(bw, bp, bj, {"type": "final", "text": "B-only answer"})
        assigned_d = self.assigned(d)
        require(assigned_d["worker_id"] == bw["worker"]["id"], "independent worker failed to progress")
        self.deliver(aw, ap, assigned_c, {"type": "final", "text": "C-only answer"})
        self.deliver(bw, bp, assigned_d, {"type": "final", "text": "D-only answer"})
        for expected in (a["worker_id"], b["worker_id"]):
            balanced, _ = self.submit(self.request_input("least-recent"), "balance-" + secrets.token_hex(6))
            require(balanced["worker_id"] == expected, "least-recent choice failed with both workers available")
            selected_worker, selected_peer = by_id[balanced["worker_id"]]
            self.deliver(selected_worker, selected_peer, balanced, {"type": "final", "text": "balanced"})
            trace = self.diagnose_operation(balanced, "dispatch.assigned", "selection follows the recorded dispatch timestamps")
            evidence = next(e for e in trace if e["msg"] == "dispatch.assigned" and e.get("operation_id") == balanced["id"])
            require(all("last_dispatched_at" in candidate and candidate["capacity_available"] for candidate in evidence["candidates"] if not candidate["eligibility_reason"]), "selection ordering/capacity inputs absent")
        busy, _ = self.submit({**self.request_input("other work on pinned worker"), "worker_id": a["worker_id"]}, "busy-pin")
        busy_job, _, _ = self.claim(aw, ap, self.experiment(busy["id"]))
        canonical = a_input["messages"] + [{"type": "message", "role": "assistant", "text": "A-only answer"}, {"type": "message", "role": "user", "text": "A next"}]
        followup = {**self.request_input(), "messages": canonical}
        pinned, _ = self.submit(followup, "A")
        require(pinned["worker_id"] == a["worker_id"], "completed session lost its healthy pin")
        require(self.detail(pinned)["assignment"] is None, "busy established pin was assigned early")
        independent, _ = self.submit(self.request_input("independent beyond blocked pin"), "beyond-blocked")
        require(independent["worker_id"] == b["worker_id"], "older blocked pin starved independent session")
        self.deliver(bw, bp, independent, {"type": "final", "text": "independent completed"})
        self.decision(aw, ap, busy_job, {"type": "final", "text": "worker freed"})
        self.assigned(pinned)
        self.checked("/api/v1/admin/workers/" + a["worker_id"], self.admin, "PATCH", {"name": "renamed without moving identity"})
        self.deliver(aw, ap, pinned, {"type": "final", "text": "A next answer"})
        wrong = {**self.request_input(), "worker_id": b["worker_id"], "messages": canonical + [{"type": "message", "role": "assistant", "text": "A next answer"}, {"type": "message", "role": "user", "text": "conflict"}]}
        _, headers = self.submit(wrong, "A", want=409)
        events = self.trace_request(headers["X-Request-Id"])
        require(any(e["msg"] == "dispatch.pin_conflict" and e.get("request_id") == headers["X-Request-Id"] for e in events), "pin conflict evidence missing")
        self.private("routing-pin-diagnosis.json", json.dumps({"cause": "session_worker_conflict", "corrective_action": "retain the owned healthy pin or start a new independent session"}))
        self.read_native(a, key=self.other_client, want=404)
        self.receipt("routing.concurrent_workers_fifo_and_persistent_pins", worker_count=2, broker_processes=2, contexts_isolated=True)

    def queue_limits(self):
        self.new_pair()
        requests = []
        for i in range(8):
            body = self.request_input("capacity-" + str(i))
            if i == 7:
                body["worker_id"] = requests[0]["worker_id"]
            requests.append(self.submit(body, "capacity-" + str(i))[0])
        _, headers = self.submit(self.request_input(), "over-capacity", want=429)
        self.diagnose_dispatch(headers["X-Request-Id"], "dispatch.rejected", "queue_full")
        original = self.detail(requests[-1])["request"]["input"]
        require(not requests[-1]["worker_id"] and "worker_id" in original, "constrained queue fixture was not unassigned")
        for origin in self.origins:
            replay, _ = self.submit(original, "capacity-7", origin=origin)
            require(replay["id"] == requests[-1]["id"], "full queue blocked constrained retry through another broker")
        cancelled = requests[-1]
        self.native("POST", "/api/v1/requests/" + cancelled["id"] + "/cancel", {"protocol_version": 1, "submission_id": secrets.token_hex(12)})
        deadline, _ = self.submit(self.request_input("deadline", timeout=1), "deadline")
        self.until(lambda: self.read_native(deadline)[0]["state"] == "interrupted", "unassigned request never expired", timeout=8)
        observed = self.read_native(deadline)[0]
        require(observed["reason"] == "deadline_exceeded", "unassigned deadline reason missing")
        events = self.diagnose_operation(deadline, "job.deadline_exceeded", "deadline expired in the queue; inspect recorded reservations before a fresh admission")
        require(any(e["msg"] == "job.deadline_exceeded" and e.get("operation_id") == deadline["id"] for e in events), "deadline final disposition missing")
        self.receipt("routing.bounded_queue_retry_cancel_and_deadline", capacity=8, deadline_from_admission=True)

    def session_races(self):
        self.new_pair()
        bodies = [self.request_input("race-" + str(i)) for i in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.api("/api/v1/requests", self.client, "POST", bodies[i], origin=self.origins[i % 2], headers={"X-Muse-Session-Id": "race"}), range(8)))
        require([r[0] for r in results].count(202) == 1 and [r[0] for r in results].count(409) == 7, "session races did not serialize")
        self.requests.append(json.loads(next(r[2] for r in results if r[0] == 202)))
        self.receipt("routing.same_session_race", admitted=1, rejected=7)

    def adverse_diagnostics(self):
        pair = self.new_pair()
        by_id = {worker["worker"]["id"]: (worker, peer) for worker, peer in pair}
        self.sql("ALTER TABLE aaa_model_requests ADD CONSTRAINT routing_test_failure CHECK (client_id <> 'fixture-client') NOT VALID;")
        retry_body = self.request_input("storage failure")
        try:
            _, headers = self.submit(retry_body, "storage", want=503)
        finally:
            self.sql("ALTER TABLE aaa_model_requests DROP CONSTRAINT routing_test_failure;")
        events = self.trace_request(headers["X-Request-Id"])
        failures = [e for e in events if e.get("request_id") == headers["X-Request-Id"] and e["msg"] == "inference.operation_failed"]
        details = [e for e in events if e.get("request_id") == headers["X-Request-Id"] and e["msg"] == "inference.storage_exchange"]
        require(len(failures) == 1 and failures[0]["level"] == "ERROR" and failures[0]["sqlstate"] == "23514" and failures[0]["transaction_outcome"] == "rolled_back", "routing storage failure lacks causal rollback evidence")
        require(len(details) == 1 and "routing_test_failure" in details[0]["detail"], "protected storage cause missing")
        self.private("routing-storage-diagnosis.json", json.dumps({"cause": "routing_test_failure", "sqlstate": "23514", "transaction_outcome": "rolled_back", "corrective_action": "repair the failing storage constraint, then retry the original submission"}))
        admitted, _ = self.submit(retry_body, "storage")
        worker, peer = by_id[admitted["worker_id"]]
        self.deliver(worker, peer, admitted, {"type": "final", "text": "one successful admission"})
        self.read_native(admitted)
        large, _ = self.submit(self.request_input("large private context " + "x" * 18000 + self.admin), "large-context")
        exports = self.trace_request(self.admission_headers[large["id"]]["X-Request-Id"], large["id"])
        inputs = [e for e in exports if e.get("operation_id") == large["id"] and e["msg"] == "inference.context"]
        require(inputs and "x" * 18000 in json.dumps(inputs) and self.admin not in json.dumps(inputs), "chunk reconstruction omitted admitted context or exposed a credential")
        worker, peer = by_id[large["worker_id"]]
        path = "/api/v1/admin/workers/" + large["worker_id"] + "/qualifications"
        self.checked(path, self.admin, "POST", {"protocol_version": 1, "submission_id": secrets.token_hex(12), "action": "withdraw", "evidence_reference": "stop queued dispatch"})
        self.claim(worker, peer, self.experiment(large["id"]), want=503)
        self.checked("/api/v1/worker/jobs/" + self.experiment(large["id"])["current_job_id"], worker["credential"], want=503)
        for container in (self.main_service, self.secondary):
            operational = self.logs(container)
            require('"level":"DEBUG"' not in operational, "DEBUG leaked to INFO operational output")
            self.assert_private(operational)
        self.receipt("routing.storage_rollback_capture_and_withdrawal", sqlstate="23514", protected_debug=True, chunk_reconstruction=True)

    def offline_boundaries(self):
        for boundary in ("first-turn", "safe", "context", "claimed", "tool-wait"):
            pair = self.new_pair()
            by_id = {worker["worker"]["id"]: (worker, peer) for worker, peer in pair}
            initial = self.request_input("initial", tools=boundary == "tool-wait")
            request, _ = self.submit(initial, "offline-" + boundary)
            worker, peer = by_id[request["worker_id"]]
            if boundary == "first-turn":
                old = self.experiment(request["id"])
                peer.stop()
                current, _ = self.read_native(request)
                require(current["worker_id"] == request["worker_id"] and self.detail(request)["assignment"]["id"] == old["current_job_id"], "first assignment moved without a prior final answer")
                trace = self.diagnose_operation(request, "dispatch.queued", "initial assignment has no safe prior final; await its worker or deadline without reassignment")
                require(any(e["msg"] == "dispatch.queued" and e.get("prior_decision_type") == "none" and e.get("reassign_allowed") is False for e in trace), "first-turn hold lacks its decision reason")
                self.receipt("routing.offline_first_turn", reassigned=False, synthetic_peer=True)
                continue
            call = {"type": "tool_call", "call_id": "accepted-call", "name": "read_file", "arguments": {"path": "client-only"}}
            first = call if boundary == "tool-wait" else {"type": "message", "role": "assistant", "text": "completed before offline"}
            decision = call if boundary == "tool-wait" else {"type": "final", "text": "completed before offline"}
            self.deliver(worker, peer, request, decision)
            self.read_native(request)
            suffix = {"type": "tool_result", "call_id": "accepted-call", "output": "exact accepted client result"} if boundary == "tool-wait" else {"type": "message", "role": "user", "text": "next turn"}
            next_input = {**self.request_input(), "messages": initial["messages"] + [first, suffix]}
            pending, _ = self.submit(next_input, request["session_id"])
            old = self.experiment(pending["id"])
            if boundary == "context":
                self.checked("/api/v1/worker/jobs/" + old["current_job_id"], worker["credential"])
            if boundary == "claimed":
                claimed, _, _ = self.claim(worker, peer, old)
            if boundary == "safe":
                peer.reply = False
                self.until(lambda: self.status(worker)["connection_status"] == "offline", "health reply window did not mark worker offline", timeout=40)
            else:
                peer.stop()
            if boundary == "safe":
                self.until(lambda: self.read_native(pending)[0]["worker_id"] != worker["worker"]["id"], "safe offline assignment was not moved", timeout=15)
                moved = self.read_native(pending)[0]
                require(moved["worker_id"] != worker["worker"]["id"] and moved["conversation_id"] == request["conversation_id"], "safe offline pin did not move")
                replacement, replacement_peer = by_id[moved["worker_id"]]
                new_job = self.detail(moved)["assignment"]
                require(new_job["id"] != old["current_job_id"], "old queued assignment not fenced")
                self.checked("/api/v1/worker/jobs/" + old["current_job_id"], worker["credential"], want=409)
                self.deliver(replacement, replacement_peer, moved, {"type": "final", "text": "full history replay"})
                require(self.detail(moved)["delivery"]["messages"] == next_input["messages"], "safe movement changed full history")
            else:
                current, _ = self.read_native(pending)
                require(current["worker_id"] == worker["worker"]["id"], "unsafe assignment moved")
                if boundary == "claimed":
                    require(current["state"] == "interrupted" and self.status(worker)["work_status"] == "busy", "uncertain inference lost busy hold")
                    self.decision(worker, peer, claimed, {"type": "final", "text": "late"}, want=409)
            event = {"safe": "dispatch.reassigned", "context": "request.context_delivery_started", "claimed": "job.interrupted", "tool-wait": "dispatch.queued"}[boundary]
            action = {"safe": "old queued assignment was fenced; continue the full-history replacement", "context": "context was exposed; await the original worker or deadline without automatic replay", "claimed": "retain uncertainty and busy hold until the exact idle acknowledgement; recovery belongs to issue 21", "tool-wait": "retain the original tool-session worker; never execute the accepted client tool again"}[boundary]
            events = self.diagnose_operation(pending, event, action)
            if boundary == "claimed":
                require(any(e["msg"] == "job.interrupted" and e.get("remote_outcome") == "unknown" and e.get("busy_hold") for e in events), "uncertain cause/hold cannot be reconstructed")
            if boundary == "safe":
                require(any(e["msg"] == "dispatch.reassigned" and e.get("operation_id") == pending["id"] for e in events), "reassignment reason missing")
            self.receipt("routing.offline_" + boundary, full_history=True, synthetic_peer=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = Routing(args)
    try:
        source = subprocess.check_output(["node", "--input-type=module", "-e", "import {inspectSource} from './tools/source-inventory.mjs'; console.log(JSON.stringify(inspectSource().identity))"], text=True)
        h.baseline()
        h.setup()
        config = h.configuration()
        h.main_service, h.origin_url, _ = h.launch(config)
        h.ready(h.main_service, h.origin_url)
        second, second_origin, _ = h.launch(config)
        h.ready(second, second_origin)
        h.secondary = second
        h.origins = [h.origin_url, second_origin]
        h.eligibility()
        h.competing_requests()
        h.queue_limits()
        h.session_races()
        h.adverse_diagnostics()
        h.offline_boundaries()
        h.private("results.json", json.dumps({"suite": "routing", "source": json.loads(source), "receipts": h.receipts, "synthetic_peer": True, "live_qualification": "not_established"}))
    finally:
        failures = []
        for peer in h.peers:
            if peer.thread.is_alive():
                try:
                    peer.stop()
                except Exception as error:
                    failures.append(type(error).__name__)
        h.cleanup()
        require(not failures, "routing peer cleanup failed")


if __name__ == "__main__":
    main()
