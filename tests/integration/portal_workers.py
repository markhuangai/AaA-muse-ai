#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from history import History
from portal import Portal, source_identity
from service import require


class PortalWorkers(Portal, History):
    def configuration(self, generated=False):
        config = super().configuration(generated)
        config["worker-package"] = {"version": "0.1.0-rc.0", "sha256": "240163c49cc30f9ac8b0906e8047b9c7bfb10756ca045b7d71e7977c2f566e77"}
        return config

    def named_worker(self, name):
        worker = self.new_worker()
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"], self.admin, "PATCH", {"name": name})
        return worker

    def activity_fixtures(self):
        offline = self.named_worker('Archive <img src=x onerror="window.__unsafe=1">')
        offline_peer = self.peer(offline, qualify=False)
        offline_peer.stop()
        self.until(lambda: self.status(offline)["connection_status"] == "offline", "closed subscriber did not become offline")
        transport = self.named_worker("Studio subscriber")
        self.peer(transport, qualify=False)
        busy = self.named_worker("Research subscriber")
        busy_peer = self.peer(busy, qualify=False)
        self.qualify_worker(busy, busy_peer, tools=False)
        experiment = self.create(busy, "Controlled held assignment", tools=False, timeout=1800)
        job, _, _ = self.claim(busy, busy_peer, experiment)
        waiting = self.named_worker("Client-tool subscriber")
        waiting_peer = self.peer(waiting)
        request, _ = self.submit(self.input(waiting, timeout=1800), "portal-controlled-tool-wait")
        self.deliver(waiting, waiting_peer, request, {"type": "tool_call", "call_id": "portal-client-read", "name": "read_file", "arguments": {"path": "client-only-controlled-fixture.txt"}})
        self.read_native(request)
        require(self.status(waiting)["waiting_for_client_tool"] == 1, "controlled tool wait was not observed")
        stale = self.named_worker("Reconnected subscriber")
        previous = self.peer(stale, qualify=False)
        self.qualify_worker(stale, previous, tools=False)
        previous.stop()
        self.peer(stale, qualify=False)
        require(self.status(stale)["inference_readiness"] == "stale", "reconnection did not stale qualification")
        self.receipt("portal.workers_controlled_activity", heartbeat_is_not_readiness=True, live_qualification=False)
        return {"offline_id": offline["worker"]["id"], "transport_id": transport["worker"]["id"],
                "busy_id": busy["worker"]["id"], "busy_job_id": job["id"], "waiting_id": waiting["worker"]["id"], "stale_id": stale["worker"]["id"]}

    def expiry_and_role_boundaries(self):
        expired = self.issue()
        self.sql("UPDATE aaa_worker_enrollments SET created_at=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE id='" + expired["enrollment_id"] + "';")
        status, headers, _ = self.enroll(expired)
        require(status == 410, "server accepted expired enrollment authority")
        event, _ = self.diagnose(headers["X-Request-Id"], "enrollment.rejected", "enrollment_expired")
        require(event["enrollment"]["enrollment_id"] == expired["enrollment_id"], "expiry diagnosis lost enrollment identity")
        self.receipt("portal.worker_server_expiry", validation="real_API_disposable_expiry_fixture", request_id=headers["X-Request-Id"], corrective_action="Generate a fresh single-use enrollment.")
        for key in (None, self.portal, self.client):
            for route, method in (("/api/v1/admin/workers", "GET"), ("/api/v1/admin/enrollments", "POST"), ("/api/v1/admin/setup-prompts", "POST")):
                require(self.api(route, key, method)[0] == 401, "non-session credential reached worker management")
        require(self.api("/workers")[0] == 200, "worker shell route is absent")
        require(self.api("/workers/missing")[0] == 404, "worker shell fallback became unrestricted")
        self.receipt("portal.worker_role_and_shell_boundaries")

    def worker_browser(self, phase, workers):
        fixture = self.private("worker-browser-" + phase + ".json", json.dumps({"origin": self.origin_url, "password": self.portal,
            "source_sha": self.args.source_sha, "container": self.main_service, "database": self.db, "owner": self.owner,
            "directory": str(self.root.resolve()), "phase": phase, "workers": workers, "pin": self.configuration()["worker-package"]}))
        result = subprocess.run(["node", "tests/portal/workers.mjs", "--fixture", str(fixture)], capture_output=True, text=True, timeout=600)
        self.private("worker-browser-" + phase + ".log", result.stdout + result.stderr)
        secret_path = self.root / ("worker-browser-secrets-" + phase + ".json")
        if secret_path.exists():
            self.secrets.extend(json.loads(secret_path.read_text()))
        require(result.returncode == 0, "worker browser conformance failed; inspect private worker-browser evidence")
        browser = json.loads((self.root / ("worker-browser-receipt-" + phase + ".json")).read_text())
        require(browser["outcome"] == "passed" and browser["source_sha"] == self.args.source_sha, "worker browser source/result mismatch")
        for diagnostic in browser["diagnostics"]:
            if diagnostic.get("request_id"):
                diagnosis = self.backend_diagnosis(diagnostic)
            else:
                events = self.operation_events(diagnostic["operation_id"])
                matched = [item for item in events if item["msg"] == "portal.worker_state_stale" and item.get("client_report") is True]
                require(matched, "worker stale evidence missing")
                event = matched[0]
                require(event["level"] == "WARN" and event["cause"] == diagnostic["cause"] and event["client_build"] == self.args.source_sha and event["portal_session_id"], "worker report correlation/severity missing")
                require(all(field in event for field in ("request_sequence", "accepted_sequence", "latest_sequence", "session_generation", "last_good_at")), "worker report ordering/state evidence omitted")
                if event["cause"] == "obsolete_response":
                    require(event["latest_sequence"] > event["request_sequence"] and event["related_request_id"], "discarded response lacks newer-state/backend evidence")
                actions = {"obsolete_response": "Retain the newer worker state and discard the superseded response.",
                           "stale_data": "Refresh the stale worker snapshot before changing access.",
                           "request_failed": "Read current server values before another deliberate action; restore browser connectivity if needed.",
                           "request_timeout": "Restore browser connectivity and refresh the read; retain any unconfirmed mutation outcome.",
                           "service_unavailable": "Use the correlated backend dependency failure to restore the service, then refresh."}
                diagnosis = {"cause": event["cause"], "corrective_action": actions[event["cause"]], "operation_id": event["operation_id"], "related_request_id": event["related_request_id"]}
                backend = [item for item in events if item["msg"] == "worker.operation_failed"]
                if backend:
                    diagnosis["backend_cause"] = backend[0]["cause"]
                    diagnosis["transaction_outcome"] = backend[0]["transaction_outcome"]
            self.receipt("portal.worker_log_only_diagnosis", event=diagnostic["event"], **diagnosis, business_table_queries=False, capture_complete=True)
        safe = Path(".artifacts/ci/portal/screens")
        safe.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in browser["screenshots"]:
            require(re.fullmatch(r"workers-(empty|list|detail|revoke|error)-(1440|768|390)\.png", name), "unsafe worker screenshot name")
            shutil.copyfile(self.root / name, safe / name)
        self.receipts.extend(browser["cases"])

    def operation_events(self, operation):
        status, _, raw = self.api("/api/v1/admin/diagnostics/export?operation_id=" + operation, self.admin)
        require(status == 200, "worker operation capture unavailable")
        metadata, events = self.decode_export(raw)
        require(metadata["complete"] and not metadata["omissions"] and events, "worker operation capture incomplete")
        require(all(item.get("operation_id") == operation for item in events), "worker operation capture crossed its filter")
        self.assert_private(json.dumps(events))
        return events

    def backend_diagnosis(self, diagnostic):
        event, requested = self.diagnose(diagnostic["request_id"], diagnostic["event"])
        require(event["level"] in ("INFO", "WARN", "ERROR"), "backend diagnostic severity missing")
        completion = [item for item in requested if item["msg"] == "request.completed"]
        require(len(completion) == 1, "backend request completion is missing or ambiguous")
        status = completion[0]["status"]
        transaction, cause = "not_started", ""
        if diagnostic["event"] == "portal.worker_action":
            require(event["portal_session_id"] and event["status"] == diagnostic["status"] == status and event["resource_id"], "action diagnostic lost actual server result")
            if status == 400:
                rejected = [item for item in requested if item["msg"] == "worker.rejected"]
                require(len(rejected) == 1 and rejected[0]["reason"] == "invalid_worker_name" and rejected[0]["transaction_outcome"] == "not_started", "rejected-name cause cannot be reconstructed")
                cause, transaction = rejected[0]["reason"], rejected[0]["transaction_outcome"]
                action = "Submit 1–100 Unicode characters without control characters; surrounding spaces are trimmed."
            else:
                committed = [item for item in requested if item["msg"] in ("enrollment.issued", "worker.renamed", "worker.revoked") and item.get("transaction_outcome") == "committed"]
                require(status in (200, 201) and len(committed) == 1, "successful action lacks its actual domain commit")
                cause, transaction = committed[0]["msg"], committed[0]["transaction_outcome"]
                action = "Use the confirmed resource result; retain its immutable identity and history."
        elif diagnostic["event"] == "worker.operation_failed":
            storage = [item for item in requested if item["msg"] == "worker.storage_exchange"]
            require(status == 503 and len(storage) == 1 and storage[0].get("detail") and storage[0]["cause"] == event["cause"] and storage[0]["transaction_outcome"] == event["transaction_outcome"], "dependency cause or transaction outcome cannot be reconstructed")
            require(event["cause"] in ("database_unavailable", "database_operation_failed", "postgres_error"), "unexpected dependency cause needs investigation")
            cause, transaction = event["cause"], event["transaction_outcome"]
            action = "Restore the PostgreSQL dependency identified by the protected storage detail, then refresh worker reads."
        elif diagnostic["event"] == "portal.auth_failed":
            require(status == 401 and event["cause"] in ("invalid_session", "session_expired") and event["expected_state"] == "authenticated" and event["observed_state"] == "unauthenticated", "denied-session cause cannot be reconstructed")
            require(completion[0]["role"] == "unauthenticated" and not any(item["msg"] == "request.admitted" for item in requested), "denied request reached an admitted operation")
            cause = event["cause"]
            action = "Sign in again using the portal password; do not use worker or client credentials."
        else:
            require(diagnostic["event"] == "worker.renamed" and diagnostic.get("client_unconfirmed") and status == 200 and event["transaction_outcome"] == "committed", "response-loss scenario lacks a backend commit")
            exchanges = [item for item in requested if item["msg"] == "worker.rename_exchange"]
            require(len(exchanges) == 1 and exchanges[0]["before"]["id"] == exchanges[0]["after"]["id"] and exchanges[0]["before"]["name"] != exchanges[0]["after"]["name"], "committed response-loss state exchange missing")
            joined = self.operation_events(event["operation_id"])
            require(any(item["msg"] == "portal.worker_state_stale" and item.get("client_report") is True and item["cause"] == "request_failed" for item in joined), "backend commit was not joined to the browser's unconfirmed result")
            cause, transaction = "backend_committed_client_unconfirmed", event["transaction_outcome"]
            action = "Refresh the authoritative worker state before another deliberate mutation; do not replay the unconfirmed action automatically."
        require(cause and transaction, "diagnostic cause or transaction outcome omitted")
        return {"request_id": diagnostic["request_id"], "cause": cause, "http_status": status, "transaction_outcome": transaction, "corrective_action": action}

    def capture_protection(self):
        status, _, raw = self.api("/api/v1/admin/diagnostics/export", self.admin)
        require(status == 200, "final worker capture unavailable")
        metadata, events = self.decode_export(raw)
        require(metadata["complete"] and not metadata["omissions"], "final worker capture incomplete")
        self.assert_private(json.dumps(events))
        logs = self.logs(self.main_service)
        self.assert_private(logs)
        require('"msg":"request.exchange"' not in logs and '"msg":"portal.browser_report"' not in logs, "protected DEBUG escaped INFO filtering")
        require(any(event["msg"] == "setup.prompt_detail" and "[REDACTED]" in event["setup_prompt"] for event in events), "redacted complete setup capture missing")
        self.receipt("portal.worker_capture_protection", complete=True, credential_scan=True, info_filter=True, max_chunk_bytes=6144, live_qualification=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", required=True, choices=("true", "false"))
    args = parser.parse_args()
    os.umask(0o077)
    h = PortalWorkers(args)
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
        h.worker_browser("empty", {})
        h.expiry_and_role_boundaries()
        workers = h.activity_fixtures()
        h.worker_browser("actions", workers)
        h.capture_protection()
        require(source_identity() == identity, "source changed during worker browser validation")
        outcome = "passed"
    finally:
        for peer in h.peers:
            if peer.thread.is_alive():
                peer.stop()
        h.cleanup()
        cleanup = json.loads((h.root / "cleanup.json").read_text())
        receipt = {"suite": "portal-workers", "outcome": outcome, "source_sha": args.source_sha, "source_dirty": args.source_dirty,
                   "working_source": identity, "image_id": image_id, "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
                   "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"), "cases": h.receipts, "cleanup": cleanup}
        h.assert_private(json.dumps(receipt))
        (safe / "workers-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
