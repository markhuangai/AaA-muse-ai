#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess

from chat import DecisionPeer
from portal import Portal, source_identity
from routing import Routing
from service import require


class PortalHistory(Portal, Routing):
    def native_timeline(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        original_name = "Archive agent before rename"
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"], self.admin, "PATCH", {"name": original_name})
        payload = '<img src=x onerror="window.__unsafe=1"> Exact request text\r\n' + "admitted-history-" * 600
        self.history_payload = payload
        first_input = self.input(worker, messages=[{"type": "message", "role": "system", "text": "Keep exact client tool linkage."}, {"type": "message", "role": "user", "text": payload}], timeout=1800)
        first, _ = self.submit(first_input, "portal-history-session")
        fixture = self.private("portal-history-client-only.txt", "Client-only exact result\r\nsecond line\n")
        call = {"type": "tool_call", "call_id": "portal-history-client-call", "name": "read_file", "arguments": {"path": fixture.name, "number": 9007199254740993}}
        self.deliver(worker, peer, first, call)
        self.read_native(first)
        result = {"type": "tool_result", "call_id": call["call_id"], "output": fixture.read_bytes().decode()}
        messages = first_input["messages"] + [call, result]
        continued, _ = self.submit(self.input(worker, messages=messages, timeout=1800), first["session_id"])
        self.deliver(worker, peer, continued, {"type": "final", "text": result["output"]})
        self.read_native(continued)
        messages += [{"type": "message", "role": "assistant", "text": result["output"]}]
        last = continued
        for index in range(5):
            messages += [{"type": "message", "role": "user", "text": "Later observed turn " + str(index)}]
            last, _ = self.submit(self.input(worker, messages=messages, tools=[], timeout=1800), first["session_id"])
            answer = "Observed final " + str(index)
            self.deliver(worker, peer, last, {"type": "final", "text": answer})
            self.read_native(last)
            messages += [{"type": "message", "role": "assistant", "text": answer}]
        events = self.timeline(first["conversation_id"], 50)
        require(len(events) > 50, "timeline fixture does not cross the actual page bound")
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"], self.admin, "PATCH", {"name": "Renamed archive agent"})
        bot = DecisionPeer(self, worker, peer).start()
        try:
            response, _ = self.checked("/v1/responses", self.client, "POST", {"model": "muse-pool-text", "input": "aaa-chat:text:Request-scoped answer", "instructions": "Instructions only for this Responses request"})
            require(response["status"] == "completed" and len(bot.jobs) == 1, "controlled Responses request did not complete")
            response_request = bot.jobs[0]["experiment_id"]
        finally:
            bot.stop()
        require(self.detail(first)["execution"]["state"] == "completed", "execution projection lost native state")
        self.receipt("portal.history_native_tool_linkage", canonical_items=len(messages), timeline_events=len(events), client_tool_executions=1, renamed_identity_preserved=True, request_scoped_instructions=True, live_qualification=False)
        return {"first": first, "continued": continued, "last": last, "worker_id": worker["worker"]["id"], "response_request_id": response_request, "call_id": call["call_id"], "exact_result": result["output"]}

    def seed_legacy_pages(self, worker_id):
        self.sql("""INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,data)
          SELECT md5('portal-history-page-'||g), '%s', 'completed', '2026-11-13T00:30:00Z',
          json_build_object('id',md5('portal-history-page-'||g),'conversation_id',md5('portal-history-conversation-'||g),
          'worker_id','%s','state','completed','created_at','2026-11-13T00:00:00Z','deadline_at','2026-11-13T00:30:00Z',
          'current_job_id','','messages',json_build_array(json_build_object('type','message','role','user','text','Retained legacy fixture')),
          'tools',json_build_array(),'final_text','Retained legacy answer','remote_outcome','decision_observed')
          FROM generate_series(1,55) AS g;""" % (worker_id, worker_id))
        identity = self.sql("SELECT md5('portal-history-page-1');")
        self.sql("INSERT INTO aaa_inference_history(experiment_id,sequence,data) VALUES ('" + identity + "',0,'{\"type\":\"message\",\"role\":\"user\",\"text\":\"Retained legacy fixture\"}');")
        seen, cursor = [], ""
        while True:
            value, _ = self.checked("/api/v1/admin/requests?limit=50" + ("&cursor=" + cursor if cursor else ""), self.admin)
            seen.extend(item["id"] for item in value["items"])
            cursor = value.get("next_cursor")
            if not cursor:
                break
        require(len(seen) >= 55 and len(set(seen)) == len(seen), "equal-time keyset pages lost or duplicated history")
        require(self.detail({"id": identity})["kind"] == "legacy", "legacy request fixture lost its provenance")
        self.receipt("portal.history_equal_timestamp_database_pages", records=len(seen), imported_legacy_fixtures=55)
        return identity

    def routing_fixtures(self):
        result = {}
        for boundary in ("safe", "context", "claimed", "tool-wait"):
            pair = self.new_pair()
            by_id = {worker["worker"]["id"]: (worker, peer) for worker, peer in pair}
            initial = self.request_input("Initial " + boundary, tools=boundary == "tool-wait", timeout=1800)
            request, _ = self.submit(initial, "portal-boundary-" + boundary)
            worker, peer = by_id[request["worker_id"]]
            decision = {"type": "tool_call", "call_id": "retained-boundary-call", "name": "read_file", "arguments": {"path": "client-only.txt"}} if boundary == "tool-wait" else {"type": "final", "text": "Prior final answer"}
            self.deliver(worker, peer, request, decision)
            self.read_native(request)
            canonical = initial["messages"] + [decision if boundary == "tool-wait" else {"type": "message", "role": "assistant", "text": decision["text"]}]
            suffix = {"type": "tool_result", "call_id": decision["call_id"], "output": "Accepted client result"} if boundary == "tool-wait" else {"type": "message", "role": "user", "text": "Next turn"}
            pending, _ = self.submit({**self.request_input(timeout=1800), "messages": canonical + [suffix]}, request["session_id"])
            old = self.experiment(pending["id"])
            if boundary == "context":
                self.checked("/api/v1/worker/jobs/" + old["current_job_id"], worker["credential"])
            if boundary == "claimed":
                self.claim(worker, peer, old)
            if boundary == "safe":
                peer.reply = False
                self.until(lambda: self.status(worker)["connection_status"] == "offline", "worker health did not expire", timeout=40)
                self.until(lambda: self.read_native(pending)[0]["worker_id"] != worker["worker"]["id"], "safe reassignment did not occur", timeout=15)
                moved, _ = self.read_native(pending)
                replacement, replacement_peer = by_id[moved["worker_id"]]
                self.checked("/api/v1/admin/workers/" + worker["worker"]["id"], self.admin, "PATCH", {"name": "Previous worker renamed now"})
                self.checked("/api/v1/admin/workers/" + replacement["worker"]["id"], self.admin, "PATCH", {"name": "Replacement worker renamed now"})
                self.deliver(replacement, replacement_peer, moved, {"type": "final", "text": "Full-history replacement"})
                self.read_native(moved)
                require(self.detail(moved)["delivery"]["messages"] == canonical + [suffix], "safe replacement did not retain full context")
            else:
                peer.stop()
                current, _ = self.read_native(pending)
                require(current["worker_id"] == worker["worker"]["id"], "exposed request was replaced")
            result[boundary] = pending["id"]
        self.receipt("portal.history_recorded_replacement_boundaries", full_history_replayed=True, claim_context_tool_fences=True, inference_retry_added=False)
        return result

    def cancellation_fixtures(self):
        self.new_pair()
        for peer in self.peers:
            if peer.thread.is_alive():
                peer.stop()
        worker = self.new_worker()
        peer = self.peer(worker)
        held, _ = self.submit(self.input(worker, tools=[], timeout=1800), "portal-held")
        held_job = self.deliver_claim(worker, peer, held)
        queued, _ = self.submit(self.input(worker, tools=[], timeout=1800), "portal-unassigned-proof")
        require(queued["worker_id"] == "", "unassigned cancellation fixture was already assigned")
        session, _ = self.login()
        for request in (queued, held):
            value, headers = self.checked("/api/v1/admin/experiments/" + request["id"] + "/cancel", session["session_token"], "POST", {"protocol_version": 1, "submission_id": secrets.token_hex(12)})
            require(value["state"] == "cancelled", "portal cancellation did not fence acceptance")
            diagnosis = self.diagnose_request(headers["X-Request-Id"])
            require(diagnosis["transaction_outcome"] == "committed", "cancellation lacks committed evidence")
        self.decision(worker, peer, held_job, {"type": "final", "text": "Rejected late decision"}, want=409)
        require(self.status(worker)["work_status"] == "busy", "cancel discarded uncertain busy hold")
        peer.acknowledge_idle(held_job)
        require(self.detail(held)["execution"]["remote_outcome"] == "unknown", "idle acknowledgement invented remote outcome")
        blocker, _ = self.submit(self.input(worker, tools=[], timeout=1800), "portal-browser-blocker")
        self.deliver_claim(worker, peer, blocker)
        cancellable = [self.submit(self.input(worker, tools=[], timeout=1800), "portal-browser-queued-" + str(i))[0] for i in range(6)]
        race_worker = self.new_worker()
        race_peer = self.peer(race_worker)
        race, _ = self.submit(self.input(race_worker, tools=[], timeout=1800), "portal-race")
        job = self.experiment(race["id"])["current_job_id"]
        self.receipt("portal.history_cancellation_authority", unassigned=True, held_uncertainty=True, late_decision_rejected=True, exact_idle_ack=True)
        return {"queued": cancellable, "held": blocker, "race": race, "race_control": {"credential": race_worker["credential"], "job_id": job, **race_peer.opened}}

    def deliver_claim(self, worker, peer, request):
        return self.claim(worker, peer, self.experiment(request["id"]))[0]

    def diagnose_request(self, identity):
        events = self.retained_export("request_id", identity)
        completed = [event for event in events if event["msg"] == "request.completed"]
        require(len(completed) == 1, "HTTP completion missing from diagnostic export")
        status = completed[0]["status"]
        storage = [event for event in events if event["msg"] in ("history.storage_exchange", "inference.storage_exchange")]
        cancel = [event for event in events if event["msg"] == "portal.cancel_result" and not event.get("client_report")]
        failed = [event for event in events if event["msg"] == "portal.history_load_failed" and not event.get("client_report")]
        transaction, cause, action = "not_started", "", ""
        if storage:
            require(status == 503 and storage[0].get("detail"), "storage failure lacks actual causal detail")
            cause, transaction = storage[0]["cause"], storage[0]["transaction_outcome"]
            action = "Restore the PostgreSQL dependency identified by the protected causal detail, then refresh."
        elif cancel:
            event = cancel[0]
            native = self.retained_export("operation_id", event["operation_id"])
            require(event["operation_id"] == event.get("request_record_id", event.get("experiment_id")), "cancel lacks native request correlation")
            require(any(item["msg"] == "inference.exchange" and item.get("experiment_id") == event["operation_id"] for item in native), "native cancellation exchange missing")
            assignments = [item for item in native if item["msg"] == "job.queued"]
            decisions = [item for item in native if item["msg"] == "decision.accepted"]
            remote, busy = event["remote_outcome"], event["busy_hold"]
            require(remote in ("not_started", "unknown", "decision_observed") and isinstance(busy, bool), "cancel remote outcome or busy hold missing")
            if event.get("job_id"):
                require(assignments and any(item.get("job_id") == event["job_id"] for item in assignments), "cancel assignment cannot be reconstructed")
            require(event["requested_state"] == "cancelled" and event["portal_session_id"], "cancel result lacks authenticated state evidence")
            if status == 200:
                require(event["transaction_outcome"] == "committed" and event["observed_state"] in ("cancelled", "interrupted"), "successful HTTP cancel lacks actual commit/state")
                cause, transaction = event["reason"], event["transaction_outcome"]
                action = "Retain recorded state and uncertainty; never infer remote stopping or resubmit inference."
            else:
                require(status == 409 and event["observed_state"] == "completed", "completion-race diagnosis lacks the winning state")
                cause, transaction = event["cause"], event["transaction_outcome"]
                require(transaction == "rolled_back" and remote == "decision_observed" and not busy and decisions, "completion race lacks rejected transaction or accepted decision evidence")
                require(any(item["msg"] == "inference.exchange" and isinstance(item.get("input"), dict) and item["input"].get("decision", {}).get("type") == "final" for item in native), "winning final decision exchange missing")
                action = "Inspect the already accepted output; do not cancel or regenerate the completed request."
        elif failed:
            cause = failed[0]["cause"]
            require(status in (400, 404) and any(event["msg"] == "history.query_input" for event in events), "history query cause/input missing")
            action = "Return to the first page with the matching conversation filter." if cause == "invalid_cursor" else "Use a recorded request identifier."
        else:
            auth = [event for event in events if event["msg"] == "portal.auth_failed"]
            require(status == 401 and auth, "unsupported history diagnostic outcome")
            cause, action = auth[0]["cause"], "Sign in again with the portal password."
        require(cause and action, "log-only diagnosis could not determine a corrective action")
        self.receipt("portal.history_log_only_diagnosis", request_id=identity, cause=cause, http_status=status, transaction_outcome=transaction, remote_outcome=remote if cancel else None, busy_hold=busy if cancel else None, native_operation_followed=bool(cancel), corrective_action=action, business_table_queries=False, capture_complete=True)
        return {"cause": cause, "transaction_outcome": transaction}

    def browser(self, phase, fixtures):
        path = self.private("history-browser-" + phase + ".json", json.dumps({"origin": self.origin_url, "password": self.portal, "source_sha": self.args.source_sha,
            "directory": str(self.root.resolve()), "container": self.main_service, "database": self.db, "owner": self.owner, "phase": phase, "fixtures": fixtures}))
        result = subprocess.run(["node", "tests/portal/history.mjs", "--fixture", str(path)], capture_output=True, text=True, timeout=600)
        known = self.root / ("history-browser-secrets-" + phase + ".json")
        if known.exists():
            self.secrets.extend(json.loads(known.read_text()))
        log = re.sub(r"muse_(?:worker|portal|enroll)_[A-Za-z0-9_-]{43}", "[REDACTED]", result.stdout + result.stderr)
        for secret in (self.admin, self.portal, self.client, self.database_password, *self.secrets):
            log = log.replace(secret, "[REDACTED]")
        self.private("history-browser-" + phase + ".log", log)
        require(result.returncode == 0, "history browser conformance failed; inspect private history-browser evidence")
        receipt = json.loads((self.root / ("history-browser-receipt-" + phase + ".json")).read_text())
        require(receipt["outcome"] == "passed" and receipt["source_sha"] == self.args.source_sha, "browser history identity/result mismatch")
        for diagnosis in receipt["diagnostics"]:
            if diagnosis.get("request_id"):
                self.diagnose_request(diagnosis["request_id"])
            if diagnosis.get("operation_id"):
                events = self.retained_export("operation_id", diagnosis["operation_id"])
                reports = [event for event in events if event.get("client_report") and event["msg"] == diagnosis["event"]]
                require(reports and reports[0]["cause"] == diagnosis["cause"] and reports[0]["portal_session_id"], "client history report missing or uncorrelated")
                report = reports[0]
                require(report["level"] == ("ERROR" if diagnosis["event"] == "portal.render_failed" else "WARN"), "history severity filtering changed")
                require(all(key in report for key in ("query_kind", "cursor", "request_sequence", "accepted_sequence", "latest_sequence", "session_generation", "query_generation", "selection_generation", "client_build", "last_good_at")), "history query/ordering/build detail omitted")
                if diagnosis.get("committed_request_id"):
                    backend = self.retained_export("request_id", diagnosis["committed_request_id"])
                    committed = [event for event in backend if event["msg"] == "portal.cancel_result" and event.get("transaction_outcome") == "committed"]
                    require(committed, "response-loss evidence lacks an actual cancellation commit")
                    self.diagnose_request(diagnosis["committed_request_id"])
                    native = self.retained_export("operation_id", committed[0]["operation_id"])
                    require(any(event.get("request_id") == diagnosis["committed_request_id"] for event in native), "native result is not joined to the lost response")
                    require(any(event.get("portal_operation_id") == diagnosis["operation_id"] for event in backend), "browser uncertainty does not join the backend commit")
                    action = "Read current request state before another deliberate action; never replay the unconfirmed cancellation automatically."
                elif report["cause"] == "obsolete_response":
                    require(report["latest_sequence"] > report["request_sequence"], "obsolete history lacks a newer query sequence")
                    require(report["related_request_id"] or any(event["msg"] == "history.query_exchange" for event in events), "abandoned read lacks its authenticated server exchange")
                    action = "Retain the newer accepted query/selection and discard the superseded response."
                elif report["cause"] == "render_exception" or report["cause"] == "invalid_response":
                    action = "Reload the matching portal build and inspect the recorded source response."
                else:
                    action = "Restore connectivity or the logged dependency, then refresh the retained snapshot."
                self.receipt("portal.history_browser_log_only_diagnosis", cause=report["cause"], event=diagnosis["event"], operation_id=diagnosis["operation_id"], corrective_action=action, business_table_queries=False, capture_complete=True)
        safe = Path(".artifacts/ci/portal/screens")
        safe.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in receipt["screenshots"]:
            require(re.fullmatch(r"history-(empty|list|detail|cancel|error)-(1440|768|390)\.png", name), "unsafe history screenshot path")
            shutil.copyfile(self.root / name, safe / name)
        self.receipts.extend(receipt["cases"])

    def final_evidence(self):
        session, _ = self.login()
        for route in ("/api/v1/admin/requests?cursor=invalid", "/api/v1/admin/requests/" + "f" * 32):
            status, headers, _ = self.api(route, session["session_token"])
            require(status in (400, 404), "invalid history lookup admitted")
            self.diagnose_request(headers["X-Request-Id"])
        status, _, raw = self.api("/api/v1/admin/diagnostics/export", self.admin)
        require(status == 200, "final history capture missing")
        metadata, events = self.decode_export(raw)
        require(metadata["complete"] and not metadata["omissions"], "history capture incomplete")
        self.assert_private(json.dumps(events))
        logs = self.logs(self.main_service)
        self.assert_private(logs)
        require('"level":"DEBUG"' not in logs and "admitted-history-" not in logs, "history detail escaped protected capture")
        require(any(event["msg"] == "history.query_exchange" and "admitted-history-" in json.dumps(event) for event in events), "full admitted history was replaced with hashes or omitted")
        outputs = [event["output"] for event in events if event["msg"] == "history.query_exchange" and isinstance(event.get("output"), dict) and isinstance(event["output"].get("request"), dict)]
        require(any(output["request"].get("input", {}).get("messages", [{}, {}])[1].get("text") == self.history_payload for output in outputs if len(output["request"].get("input", {}).get("messages", [])) >= 2), "protected capture did not reconstruct the exact admitted large input")
        self.receipt("portal.history_capture_protection", info_filter=True, complete=True, credential_scan=True, max_chunk_bytes=6144, live_qualification=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", required=True, choices=("true", "false"))
    args = parser.parse_args()
    os.umask(0o077)
    h = PortalHistory(args)
    identity = source_identity()
    safe = Path(".artifacts/ci/portal")
    safe.mkdir(parents=True, exist_ok=True, mode=0o700)
    outcome, image_id = "failed", None
    try:
        h.baseline()
        image_id = h.inspect(args.image)["Id"]
        h.setup()
        h.main_service, h.origin_url, _ = h.launch()
        h.ready(h.main_service, h.origin_url)
        h.browser("empty", {})
        native = h.native_timeline()
        legacy = h.seed_legacy_pages(native["worker_id"])
        boundaries = h.routing_fixtures()
        cancellation = h.cancellation_fixtures()
        h.browser("history", {"native": native, "legacy": legacy, "boundaries": boundaries, "cancellation": cancellation})
        h.final_evidence()
        require(source_identity() == identity, "source changed during history validation")
        outcome = "passed"
    finally:
        failures = []
        for peer in h.peers:
            if peer.thread.is_alive():
                try:
                    peer.stop()
                except Exception as error:
                    failures.append(type(error).__name__)
        h.cleanup()
        receipt = {"suite": "portal-history", "outcome": outcome, "source_sha": args.source_sha, "source_dirty": args.source_dirty,
                   "working_source": identity, "image_id": image_id, "run_id": os.environ.get("GITHUB_RUN_ID", "local"), "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"),
                   "cases": h.receipts, "cleanup": json.loads((h.root / "cleanup.json").read_text()), "peer_cleanup_failures": failures}
        h.assert_private(json.dumps(receipt))
        (safe / "history-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        require(not failures, "history peer cleanup failed")


if __name__ == "__main__":
    main()
