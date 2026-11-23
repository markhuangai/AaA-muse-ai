#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import secrets
import subprocess

from history import History
from inference import PullPeer
from service import require


class Routing(History):
    def __init__(self, args):
        super().__init__(args)
        self.requests = []
        self.origins = []
        self.admission_headers = {}

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
        workers = [self.new_worker(), self.new_worker()]
        return [(worker, self.pull_peer(worker)) for worker in workers]

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
            assignments = [e for e in own if e["msg"] in ("job.claimed", "job.work_started", "request.context_delivery_started")]
            require(all(e.get("job_id") and e.get("worker_id") and e.get("generation", 0) > 0 for e in assignments), "native assignment omitted worker/job/generation linkage")
        self.private("routing-trace-" + request_id + ".json", json.dumps({"request_id": request_id, "operation_ids": operations, "events": events}))
        return events

    def diagnose_operation(self, request, event_name, action):
        events = self.trace_request(self.admission_headers[request["id"]]["X-Request-Id"], request["id"])
        matches = [e for e in events if e.get("operation_id") == request["id"] and e["msg"] == event_name]
        require(matches, "operation boundary missing: " + event_name)
        self.private("routing-diagnosis-" + request["id"] + ".json", json.dumps({"cause_event": event_name, "evidence": matches, "corrective_action": action}))
        return events

    def eligibility(self):
        body = self.request_input(tools=True)
        queued, _ = self.submit(body, "eligible")
        require(queued["state"] == "queued" and not queued["worker_id"], "no-worker admission did not queue")
        worker = self.new_worker()
        peer = PullPeer(self, worker)
        path = "/api/v1/admin/workers/" + worker["worker"]["id"] + "/qualifications"
        for key in (worker["credential"], self.client, self.portal):
            self.checked(path, key, "POST", {}, want=401)
        self.checked(path, self.admin, "POST", {}, want=410)
        shown = self.deliver(worker, peer, queued, {"type": "final", "text": "eligible answer"})
        require("qualification" not in shown and not self.status(worker)["qualification_history"], "routing fabricated approval")
        self.silence(worker, 605)
        require(self.worker_projection(worker)[0]["connection_status"] == "offline", "controlled gap did not change presence")
        recovered, _ = self.submit(self.request_input(tools=True), "automatic-recovery")
        self.deliver(worker, peer, recovered, {"type": "final", "text": "automatic recovery answer"})
        require(self.read_native(recovered)[0]["output"]["text"] == "automatic recovery answer", "client work failed after polling resumed")
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST", {})
        self.checked("/api/v1/worker/pull", worker["credential"], "POST", peer.poll_input(), want=401)
        self.receipt("routing.queue_before_enrollment_and_poll_recovery", controlled_peer=True, automatic_client_recovery=True)

    def competing_requests(self):
        (worker_a, peer_a), (worker_b, peer_b) = self.new_pair()
        id_a, id_b = worker_a["worker"]["id"], worker_b["worker"]["id"]
        open_input = self.request_input("open before targeted")
        open_request, _ = self.submit(open_input, "open")
        target_input = {**self.request_input("targeted context"), "worker_id": id_a}
        target, _ = self.submit(target_input, "target", origin=self.origins[1])
        with ThreadPoolExecutor(max_workers=2) as pool:
            targeted = pool.submit(self.claim, worker_a, peer_a, self.experiment(target["id"]), origin=self.origins[0])
            opened = pool.submit(self.claim, worker_b, peer_b, self.experiment(open_request["id"]), origin=self.origins[1])
            target_job, _, _ = targeted.result()
            open_job, _, _ = opened.result()
        require(target_job["context"]["messages"] == target_input["messages"] and open_job["context"]["messages"] == open_input["messages"], "targeted priority or canonical isolation failed")
        foreign = {"protocol_version": 1, "claim_id": target_job["lease_id"], "generation": target_job["generation"], "launch_id": "foreign", "native_job_id": "foreign"}
        self.checked("/api/v1/worker/jobs/" + target_job["id"] + "/start", worker_b["credential"], "POST", foreign, want=404)
        held_probe = peer_a.poll_input()
        blocked, _ = self.checked("/api/v1/worker/pull", worker_a["credential"], "POST", held_probe)
        require(blocked["job"] is None, "new pull granted a second slot")
        peer_a.pulls.append({"sequence": held_probe["sequence"]})
        self.decision(worker_a, peer_a, target_job, {"type": "final", "text": "Targeted answer"})
        self.decision(worker_b, peer_b, open_job, {"type": "final", "text": "Open answer"})
        open_first, _ = self.submit(self.request_input("independent before pin"), "independent")
        canonical = target_input["messages"] + [{"type": "message", "role": "assistant", "text": "Targeted answer"}, {"type": "message", "role": "user", "text": "next"}]
        pinned, _ = self.submit({**self.request_input(), "messages": canonical}, "target")
        require(pinned["worker_id"] == id_a, "completed conversation lost its pin")
        independent = self.deliver(worker_b, peer_b, open_first, {"type": "final", "text": "Independent response"})
        require(independent["worker_id"] == id_b and peer_b.poll(self.origins[1]) is None, "open work was blocked or another worker's pin escaped")
        self.checked("/api/v1/admin/workers/" + id_a, self.admin, "PATCH", {"name": "renamed without moving identity"})
        job = self.deliver(worker_a, peer_a, pinned, {"type": "final", "text": "Pinned answer"})
        require(job["context"]["messages"] == canonical, "pinned continuation lost full canonical history")
        wrong = {**self.request_input(), "worker_id": id_b, "messages": canonical + [{"type": "message", "role": "assistant", "text": "Pinned answer"}, {"type": "message", "role": "user", "text": "conflict"}]}
        _, headers = self.submit(wrong, "target", want=409)
        events = self.trace_request(headers["X-Request-Id"])
        require(any(event["msg"] == "dispatch.pin_conflict" for event in events), "pin conflict evidence missing")
        self.diagnose_operation(pinned, "job.work_started", "retain the existing worker pin and follow its claim")
        self.read_native(target, key=self.other_client, want=404)
        self.receipt("routing.concurrent_workers_fifo_and_persistent_pins", worker_count=2, broker_processes=2, contexts_isolated=True)

    def queue_without_global_cap(self):
        (worker, _), _ = self.new_pair()
        requests = []
        for i in range(10):
            body = self.request_input("capacity-" + str(i))
            if i == 9:
                body["worker_id"] = worker["worker"]["id"]
            requests.append(self.submit(body, "capacity-" + str(i))[0])
        require(all(not r["worker_id"] and r["state"] == "queued" for r in requests), "admission granted work without a pull")
        original = self.detail(requests[-1])["request"]["input"]
        require(not requests[-1]["worker_id"] and "worker_id" in original, "constrained queue fixture was not unassigned")
        for origin in self.origins:
            replay, _ = self.submit(original, "capacity-9", origin=origin)
            require(replay["id"] == requests[-1]["id"], "constrained retry through another broker changed identity")
        cancelled = requests[-1]
        self.native("POST", "/api/v1/requests/" + cancelled["id"] + "/cancel", {"protocol_version": 1, "submission_id": secrets.token_hex(12)})
        deadline, _ = self.submit(self.request_input("deadline", timeout=1), "deadline")
        self.until(lambda: self.read_native(deadline)[0]["state"] == "interrupted", "unassigned request never expired", timeout=8)
        observed = self.read_native(deadline)[0]
        require(observed["reason"] == "deadline_exceeded", "unassigned deadline reason missing")
        events = self.diagnose_operation(deadline, "job.deadline_exceeded", "the queue deadline expired before a worker pulled; inspect scheduler and compatibility evidence")
        require(any(e["msg"] == "job.deadline_exceeded" and e.get("operation_id") == deadline["id"] for e in events), "deadline final disposition missing")
        self.receipt("routing.queue_retry_cancel_and_deadline", admitted=10, deadline_from_admission=True)

    def session_races(self):
        self.new_pair()
        bodies = [self.request_input("race-" + str(i)) for i in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.api("/api/v1/requests", self.client, "POST", bodies[i], origin=self.origins[i % 2], headers={"X-Muse-Session-Id": "race"}), range(8)))
        require([r[0] for r in results].count(202) == 1 and [r[0] for r in results].count(409) == 7, "session races did not serialize")
        self.requests.append(json.loads(next(r[2] for r in results if r[0] == 202)))
        self.receipt("routing.same_session_race", admitted=1, rejected=7)

    def adverse_diagnostics(self):
        (worker, peer), _ = self.new_pair()
        self.reject_writes("routing_test_failure", "aaa_model_requests", "NEW.client_id='fixture-client'", "INSERT")
        retry_body = self.request_input("storage failure")
        try:
            _, headers = self.submit(retry_body, "storage", want=503)
        finally:
            self.sql("DROP TRIGGER routing_test_failure;")
        events = self.trace_request(headers["X-Request-Id"])
        failures = [e for e in events if e.get("request_id") == headers["X-Request-Id"] and e["msg"] == "inference.operation_failed"]
        details = [e for e in events if e.get("request_id") == headers["X-Request-Id"] and e["msg"] == "inference.storage_exchange"]
        require(len(failures) == 1 and failures[0]["level"] == "ERROR" and failures[0]["sqlite_code"] == "1811" and failures[0]["transaction_outcome"] == "rolled_back", "routing storage failure lacks causal rollback evidence")
        require(len(details) == 1 and "routing_test_failure" in details[0]["detail"], "protected storage cause missing")
        self.private("routing-storage-diagnosis.json", json.dumps({"cause": "routing_test_failure", "sqlite_code": "1811", "transaction_outcome": "rolled_back", "corrective_action": "repair the failing storage constraint, then retry the original submission"}))
        admitted, _ = self.submit(retry_body, "storage")
        self.deliver(worker, peer, admitted, {"type": "final", "text": "one successful admission"})
        self.read_native(admitted)
        large, _ = self.submit(self.request_input("large private context " + "x" * 18000 + self.admin), "large-context")
        large_job, _, _ = self.claim(worker, peer, self.experiment(large["id"]))
        exports = self.trace_request(self.admission_headers[large["id"]]["X-Request-Id"], large["id"])
        inputs = [e for e in exports if e.get("operation_id") == large["id"] and e["msg"] == "inference.context"]
        require(inputs and "x" * 18000 in json.dumps(inputs) and self.admin not in json.dumps(inputs), "chunk reconstruction omitted admitted context or exposed a credential")
        self.decision(worker, peer, large_job, {"type": "final", "text": "large context accepted"})
        self.checked("/api/v1/worker/upgrade-reservation", worker["credential"], "POST", {}, want=404)
        for container in (self.main_service, self.secondary):
            operational = self.logs(container)
            require('"level":"DEBUG"' not in operational, "DEBUG leaked to INFO operational output")
            self.assert_private(operational)
        self.receipt("routing.storage_rollback_and_claim_capture", sqlite_code="1811", protected_debug=True, chunk_reconstruction=True)

    def offline_boundaries(self):
        for boundary in ("safe", "revoked", "granted", "started", "tool-wait"):
            (worker, peer), (replacement, replacement_peer) = self.new_pair()
            initial = self.request_input("initial " + boundary, tools=boundary == "tool-wait", timeout=1800)
            request, _ = self.submit(initial, "offline-" + boundary)
            call = {"type": "tool_call", "call_id": "accepted-call", "name": "read_file", "arguments": {"path": "client-only"}}
            decision = call if boundary == "tool-wait" else {"type": "final", "text": "completed before silence"}
            first = call if boundary == "tool-wait" else {"type": "message", "role": "assistant", "text": decision["text"]}
            self.deliver(worker, peer, request, decision)
            suffix = {"type": "tool_result", "call_id": "accepted-call", "output": "exact accepted client result"} if boundary == "tool-wait" else {"type": "message", "role": "user", "text": "next turn"}
            next_input = {**self.request_input(timeout=1800), "messages": initial["messages"] + [first, suffix]}
            if boundary == "revoked":
                worker_id = worker["worker"]["id"]
                self.checked("/api/v1/admin/workers/" + worker_id + "/revoke", self.admin, "POST")
                self.silence(worker, 605)
                self.submit({**next_input, "submission_id": secrets.token_hex(12), "worker_id": worker_id}, request["session_id"], want=409)
                self.checked("/api/v1/worker/pull", worker["credential"], "POST", peer.poll_input(), want=401)
                pending, _ = self.submit(next_input, request["session_id"])
                job = self.deliver(replacement, replacement_peer, pending, {"type": "final", "text": "history on live replacement"})
                adopted, _ = self.read_native(pending)
                require(job["context"]["messages"] == next_input["messages"] and adopted["conversation_id"] == request["conversation_id"] and
                        adopted["worker_id"] == replacement["worker"]["id"], "revoked offline pin lost its safe continuation or canonical history")
                events = self.diagnose_operation(pending, "dispatch.reassigned", "the revoked offline worker cannot resume this session")
                moved = next(event for event in events if event["msg"] == "dispatch.reassigned")
                require(moved["expected_worker_id"] == worker_id and moved["observed_worker_id"] == replacement["worker"]["id"] and
                        moved["claim_id"] == job["lease_id"] and moved["job_id"] == job["id"] and moved["operation_id"] == pending["id"] and
                        moved["reason"] == "offline_before_claim_and_context" and moved["context_delivery_started"] is False,
                        "broker evidence could not identify the safe replacement of the revoked pin")
                self.receipt("routing.offline_revoked_pin_replacement", full_history=True, revoked_authority_preserved=True)
                continue
            if boundary == "safe":
                self.silence(worker, 605)
            pending, _ = self.submit(next_input, request["session_id"])
            old = self.experiment(pending["id"])
            if boundary == "safe":
                self.until(lambda: self.experiment(pending["id"])["current_job_id"] != old["current_job_id"], "safe pin was not released", timeout=15)
                replacement_job = self.deliver(replacement, replacement_peer, pending, {"type": "final", "text": "full history replay"})
                moved, _ = self.read_native(pending)
                require(moved["worker_id"] == replacement["worker"]["id"] and moved["conversation_id"] == request["conversation_id"], "safe replacement lost the owned session")
                require(replacement_job["id"] != old["current_job_id"] and replacement_job["context"]["messages"] == next_input["messages"], "safe movement did not fence the prior job or retain full history")
                self.diagnose_operation(pending, "dispatch.pin_released", "the old queued pin was released before any grant")
            else:
                if boundary == "granted":
                    require(peer.poll()["job_id"] == old["current_job_id"], "wrong protected grant")
                elif boundary == "started":
                    claimed, _, _ = self.claim(worker, peer, old)
                self.silence(worker, 605)
                require(replacement_peer.poll() is None, "another worker polled a protected claim or tool pin")
                current, _ = self.read_native(pending)
                require(current["worker_id"] == worker["worker"]["id"], "protected work moved when worker was silent")
                if boundary == "started":
                    self.cancel(pending["id"])
                    self.decision(worker, peer, claimed, {"type": "final", "text": "late"}, want=409)
                    require(self.worker_projection(worker)[0]["work_status"] == "busy", "cancellation released an uncertain execution")
                    peer.settle(claimed, "cancelled")
            self.receipt("routing.offline_" + boundary, full_history=True, controlled_peer=True)

    def weekly_usage(self):
        (_, peer_a), (_, peer_b) = self.new_pair()
        for percent_a, percent_b, highest in ((80, 33, peer_b), (25, 91, peer_a)):
            require(peer_a.poll_usage(percent_a, self.origins[0]) is None, "idle sample took a stray job")
            require(peer_b.poll_usage(percent_b, self.origins[1]) is None, "idle sample took a stray job")
            submitted, _ = self.submit(self.request_input(), "quota-" + str(percent_a))
            first = peer_a if highest is peer_b else peer_b
            first_index = int(first is peer_b)
            highest_index = 1 - first_index
            percentages = [percent_a, percent_b]
            require(first.poll_usage(percentages[first_index], self.origins[first_index]) is None,
                    "the first, lower-allowance poll claimed instead of waiting")
            denied_id = first.pulls[-1]["request_id"]
            grant = highest.poll_usage(percentages[highest_index], self.origins[highest_index])
            require(grant is not None and grant["operation_id"] == submitted["id"], "the highest remaining allowance did not win")
            selected = highest.worker
            job, _, _ = highest.begin(grant, origin=self.origins[highest_index])
            self.decision(selected, highest, job, {"type": "final", "text": "allowed worker finished"})
            events = self.filtered_events("operation_id", submitted["id"])
            deferred, = [event for event in events if event["msg"] == "dispatch.weekly_usage_deferred"]
            claimed, = [event for event in events if event["msg"] == "job.claimed"]
            require(deferred["request_id"] == denied_id and deferred["worker_id"] == first.worker["worker"]["id"] and
                    deferred["preferred_worker_id"] == claimed["worker_id"] == selected["worker"]["id"] and
                    deferred["job_id"] == claimed["job_id"] and deferred["instance_id"] != claimed["instance_id"] and
                    deferred["preferred_used_percent"] == percentages[highest_index] and deferred["level"] == "DEBUG",
                    "protected logs did not explain the cross-broker quota choice")
        self.receipt("routing.weekly_allowance_two_brokers", lower_reporter_first=True, ranking_reversed=True, linked_protected_logs=True)


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
        h.queue_without_global_cap()
        h.session_races()
        h.adverse_diagnostics()
        h.offline_boundaries()
        h.weekly_usage()
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
