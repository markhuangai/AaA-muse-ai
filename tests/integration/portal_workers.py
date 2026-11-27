#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.parse

from history import History
from native_cron import utc_stamp
from portal import Portal, source_identity
from service import require
from worker_tls import TLSFixture


class PortalWorkers(Portal, History):
    def redact_safe(self, value):
        text = str(value)
        known = (self.admin, self.portal, self.client, *self.secrets)
        for secret in sorted((item for item in known if isinstance(item, str) and item), key=len, reverse=True):
            text = text.replace(secret, "[REDACTED]")
        text = re.sub(r"__Host-muse_portal\s*=\s*[^\s;,\"']+", "__Host-muse_portal=[REDACTED]", text, flags=re.IGNORECASE)
        text = re.sub(r"\bBearer\s+[^\s;,\"']+", "Bearer [REDACTED]", text, flags=re.IGNORECASE)
        return re.sub(r"\b(?:muse|aaa_muse_ai)_[A-Za-z0-9_-]+", "[REDACTED]", text, flags=re.IGNORECASE)

    def browser_json(self, name):
        try:
            with (self.root / name).open(encoding="utf8") as stream:
                data = stream.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                return None
            return json.loads(data)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError, RecursionError):
            return None

    def safe_browser_path(self, value):
        segments = {"api", "v1", "admin", "portal", "worker", "workers", "hook", "settings", "login", "logout", "events",
                    "status", "readyz", "enroll", "enrollments", "setup-prompts", "agent-tasks", "pull", "revoke", "start", "result", "interrupt"}
        try:
            path = urllib.parse.urlsplit(value).path if isinstance(value, str) else ""
        except ValueError:
            path = ""
        if not path.startswith("/"):
            return "/{omitted}"
        if path.startswith("/assets/"):
            return "/assets/{asset}"
        parts = (part if not part or part in segments or re.fullmatch(r"[a-f0-9]{32}", part) else "{omitted}" for part in path.split("/"))
        return self.redact_safe("/".join(parts))[:240]

    def browser_events(self, events):
        if not isinstance(events, list):
            return []
        result = []
        for event in events[-10:]:
            if not isinstance(event, dict) or event.get("kind") not in ("response", "requestfailed", "pageerror"):
                continue
            item = {"kind": event["kind"]}
            if event["kind"] != "pageerror":
                method = event.get("method")
                item["method"] = method if method in ("GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD") else "OTHER"
                item["path"] = self.safe_browser_path(event.get("path"))
            status = event.get("status")
            if type(status) is int and 100 <= status <= 599:
                item["status"] = status
            error = event.get("error")
            if isinstance(error, str) and re.fullmatch(r"(?:net::ERR_[A-Z0-9_]+|request_failed|Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError)", error):
                item["error"] = self.redact_safe(error)[:100]
            request_id = event.get("request_id")
            if isinstance(request_id, str) and re.fullmatch(r"[a-f0-9]{32}", request_id):
                item["request_id"] = self.redact_safe(request_id)
            result.append(item)
        return result

    def tls_events(self):
        with self.browser_proxy.lock:
            events = list(self.browser_proxy.events[-20:])
        result = []
        for event in events:
            if not isinstance(event, dict) or not isinstance(event.get("event"), str) or not re.fullmatch(r"fixture\.[a-z_]+", event["event"]):
                continue
            item = {"event": self.redact_safe(event["event"])[:100]}
            cause = event.get("cause")
            if isinstance(cause, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", cause):
                item["cause"] = self.redact_safe(cause)
            if "route" in event:
                item["route"] = self.safe_browser_path(event["route"])
            if event.get("phase") in ("prepare", "activate"):
                item["phase"] = event["phase"]
            if type(event.get("status")) is int and 100 <= event["status"] <= 599:
                item["status"] = event["status"]
            if type(event.get("forwarded")) is bool:
                item["forwarded"] = event["forwarded"]
            request_id = event.get("request_id")
            if isinstance(request_id, str) and re.fullmatch(r"[a-f0-9]{32}", request_id):
                item["request_id"] = self.redact_safe(request_id)
            result.append(item)
        return result

    def browser_failure(self, phase, returncode, stage, error_name, secrets_available, browser):
        progress = self.browser_json("worker-browser-progress-" + phase + ".json")
        progress = progress if isinstance(progress, dict) else {}
        failure = browser.get("failure") if isinstance(browser, dict) else None
        if not isinstance(failure, dict):
            failure = self.browser_json("worker-browser-failure-" + phase + ".json")
        detail = failure if isinstance(failure, dict) else progress
        messages = {"TimeoutExpired": "Worker browser exceeded its 300-second process deadline.",
                    "AssertionError": "Worker browser failed during offline timer coordination.",
                    "OSError": "Worker browser process could not be started or monitored."}
        summary = {"phase": phase, "returncode": returncode, "step": stage, "error_name": error_name,
                   "message": messages.get(error_name, "Worker browser failed; diagnostic details unavailable."), "stack_head": [], "passed_cases": [],
                   "recent_events": [], "tls_fixture_events": []}
        if error_name != "BrowserProcessError":
            summary["monitor_stage"] = stage
            summary["monitor_error"] = error_name
        if secrets_available:
            step = detail.get("step")
            if isinstance(step, str) and re.fullmatch(r"[A-Za-z0-9_./-]{1,100}", step):
                summary["step"] = self.redact_safe(step)
            name = detail.get("error_name")
            if name in ("Error", "AssertionError", "TimeoutError", "TypeError", "ReferenceError", "SyntaxError", "RangeError"):
                summary["error_name"] = name
            message = detail.get("message")
            if isinstance(message, str):
                message = self.redact_safe(message)
                operation = r"(?:(?:page|browser|browserContext|locator)\.(?:goto|click|fill|close|launch|newContext|newPage|screenshot|waitForResponse|evaluate|press|route|unroute)|toBeVisible|toBeEnabled|toBeFocused|toHaveText|toContainText|toHaveCount|toEqual|toBe)"
                cause = r"(?:Timeout \d{1,8}ms exceeded|net::ERR_[A-Z0-9_]{1,80})"
                canary_message = "Controlled diagnostics canary: [REDACTED] [REDACTED] [REDACTED] Bearer [REDACTED] __Host-[REDACTED]=[REDACTED]"
                if re.fullmatch(r"Browser operation failed(?:: (?:" + operation + "|" + cause + r")){0,2}", message) or (
                        os.environ.get("PORTAL_WORKERS_DIAGNOSTIC_CANARY") and message == canary_message):
                    summary["message"] = message[:500]
            stack = detail.get("stack_head")
            if isinstance(stack, list):
                summary["stack_head"] = [self.redact_safe(line) for line in stack[:10] if isinstance(line, str) and
                                         re.fullmatch(r"tests/portal/workers\.mjs:\d{1,7}:\d{1,5}", line)]
            cases = detail.get("passed_cases")
            if isinstance(cases, list):
                summary["passed_cases"] = [self.redact_safe(case) for case in cases[-100:] if isinstance(case, str) and
                                            re.fullmatch(r"portal\.[a-z_]{1,100}", case)]
            summary["recent_events"] = self.browser_events(detail.get("recent_events"))
            summary["tls_fixture_events"] = self.tls_events()
        encoded = json.dumps(summary, ensure_ascii=True)
        try:
            self.assert_private(encoded)
        except AssertionError:
            summary = {"phase": phase, "returncode": returncode, "step": stage, "error_name": error_name,
                       "message": "Worker browser failed; diagnostic details withheld by privacy check.", "stack_head": [],
                       "passed_cases": [], "recent_events": [], "tls_fixture_events": []}
            encoded = json.dumps(summary, ensure_ascii=True)
            self.assert_private(encoded)
        self.worker_failure = summary
        print(encoded, file=sys.stderr, flush=True)

    def named_worker(self, name):
        worker = self.new_worker()
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"], self.admin, "PATCH", {"name": name})
        return worker

    def activity_fixtures(self):
        offline = self.named_worker('Archive <img src=x onerror="window.__unsafe=1">')
        never = self.named_worker("Unstarted native cron")
        transport = self.named_worker("Studio native cron")
        quiet = self.named_worker("Delayed native cron")
        require(self.pull_peer(offline).poll_usage(71) is None, "offline quota fixture claimed work")
        require(self.pull_peer(transport).poll_usage(33) is None, "current quota fixture claimed work")
        self.sql("UPDATE aaa_worker_weekly_usage SET observed_at=observed_at-180000000 WHERE worker_id='" + offline["worker"]["id"] + "';")
        self.pull_peer(quiet)
        self.silence(offline, 605)
        self.silence(quiet, 65)
        require(self.worker_projection(never)[0]["connection_status"] == "not_observed", "enrollment invented an authenticated work poll")
        require(self.worker_projection(offline)[0]["connection_status"] == "offline", "silent worker did not become offline")
        require(self.worker_projection(quiet)[0]["connection_status"] == "quiet", "late idle checker did not become quiet")
        require(self.worker_projection(transport)[0]["inference_readiness"] == "unverified", "work poll fabricated readiness")
        busy = self.named_worker("Research native cron")
        busy_peer = self.pull_peer(busy)
        experiment = self.create(busy, "Controlled held assignment", tools=False, timeout=1800)
        job, _, _ = self.claim(busy, busy_peer, experiment)
        self.silence(busy, 605)
        busy_view, _ = self.worker_projection(busy)
        require(busy_view["connection_status"] == "offline" and busy_view["work_status"] == "busy", "controlled silent claim was not offline")
        self.checked("/api/v1/worker/jobs/" + job["id"] + "/presence", busy["credential"], "POST", {
            "protocol_version": 1, "claim_id": job["lease_id"], "generation": job["generation"],
            "checker_job_id": "portal-checker", "checker_run_id": "portal-busy-check", "scheduled_at": utc_stamp(),
            "hold_reason": "producer_launch_unobservable",
        })
        present, _ = self.worker_projection(busy)
        require(present["connection_status"] == "recent" and present["last_poll_at"] == busy_view["last_poll_at"] and present["work_status"] == "busy",
                "busy contact did not preserve the separate assignment and last poll")
        waiting = self.named_worker("Client-tool native cron")
        waiting_peer = self.pull_peer(waiting)
        request, _ = self.submit(self.input(waiting, timeout=1800), "portal-controlled-tool-wait")
        self.deliver(waiting, waiting_peer, request, {"type": "tool_call", "call_id": "portal-client-read", "name": "read_file", "arguments": {"path": "client-only-controlled-fixture.txt"}})
        self.read_native(request)
        require(self.status(waiting)["waiting_for_client_tool"] == 1, "controlled tool wait was not observed")
        self.receipt("portal.workers_controlled_activity", poll_is_not_qualification=True, live_qualification=False)
        return {"offline_id": offline["worker"]["id"], "transport_id": transport["worker"]["id"],
                "busy_id": busy["worker"]["id"], "busy_job_id": job["id"], "waiting_id": waiting["worker"]["id"],
                "never_id": never["worker"]["id"], "quiet_id": quiet["worker"]["id"]}

    def expiry_and_role_boundaries(self):
        expired = self.issue()
        self.sql("UPDATE aaa_worker_enrollments SET created_at=CAST(unixepoch('subsec')*1000000 AS INTEGER)-7200000000, expires_at=CAST(unixepoch('subsec')*1000000 AS INTEGER)-3600000000 WHERE id='" + expired["enrollment_id"] + "';")
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
        canary = os.environ.get("PORTAL_WORKERS_DIAGNOSTIC_CANARY")
        if canary:
            self.secrets.append(canary)
        if phase == "actions":
            reconnecting = self.named_worker("Offline timer fixture")
            timer = self.pull_peer(reconnecting)
            self.silence(reconnecting, 605)
            require(self.worker_projection(reconnecting)[0]["connection_status"] == "offline", "timer fixture did not become offline")
            workers = {**workers, "reconnect_id": reconnecting["worker"]["id"]}
        fixture = self.private("worker-browser-" + phase + ".json", json.dumps({"origin": self.origin_url, "browser_origin": self.browser_proxy.origin, "password": self.portal,
            "source_sha": self.args.source_sha, "container": self.main_service, "database": self.db, "owner": self.owner,
            "directory": str(self.root.resolve()), "phase": phase, "workers": workers, "pin": self.checked("/api/v1/admin/status", self.admin)[0]["build"]["worker_package"]}))
        process, stage, monitor_error = None, "browser/start", None
        try:
            with subprocess.Popen(["node", "tests/portal/workers.mjs", "--fixture", str(fixture)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as process:
                try:
                    if phase == "actions":
                        stage = "browser/offline-poll"
                        signal = self.root / "worker-browser-resume-poll"
                        self.until(lambda: signal.exists() or process.poll() is not None, "browser did not reach the offline timer check", timeout=300)
                        if signal.exists():
                            require(timer.poll() is None, "offline timer fixture unexpectedly claimed work")
                            self.private("worker-browser-poll-ready", "")
                    stage = "browser/wait"
                    process.wait(timeout=300)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
        except subprocess.TimeoutExpired:
            monitor_error = "TimeoutExpired"
        except OSError:
            monitor_error = "OSError"
        except AssertionError:
            monitor_error = "AssertionError"
        except Exception as error:
            monitor_error = type(error).__name__ if type(error).__module__ == "builtins" else "BrowserProcessError"
        known = self.browser_json("worker-browser-secrets-" + phase + ".json")
        secrets_available = isinstance(known, list) and all(isinstance(secret, str) and secret for secret in known)
        if secrets_available:
            self.secrets.extend(known)
        browser = self.browser_json("worker-browser-receipt-" + phase + ".json")
        valid_browser = (isinstance(browser, dict) and browser.get("outcome") == "passed" and browser.get("source_sha") == self.args.source_sha and
                         all(isinstance(browser.get(field), list) for field in ("diagnostics", "screenshots", "cases")))
        if monitor_error or process is None or process.returncode != 0 or not secrets_available or not valid_browser:
            self.browser_failure(phase, process.returncode if process else None, stage, monitor_error or "BrowserProcessError", secrets_available, browser)
            raise AssertionError("worker browser conformance failed; see redacted diagnostic summary") from None
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
                           "invalid_response": "Refresh the worker activity and correlate the request before submitting again.",
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
            require(re.fullmatch(r"workers-(empty|list|detail(?:-dark)?|revoke|error|remote)-(1440|768|390)\.png", name), "unsafe worker screenshot name")
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
            require(event["cause"] in ("database_unavailable", "database_operation_failed", "sqlite_error"), "unexpected dependency cause needs investigation")
            cause, transaction = event["cause"], event["transaction_outcome"]
            action = "Restore the SQLite table identified by the protected storage detail, then refresh worker reads."
        elif diagnostic["event"] == "portal.auth_failed":
            require(status == 401 and event["cause"] in ("invalid_session", "session_expired") and event["expected_state"] == "authenticated" and event["observed_state"] == "unauthenticated", "denied-session cause cannot be reconstructed")
            require(completion[0]["role"] == "unauthenticated" and not any(item["msg"] == "request.admitted" for item in requested), "denied request reached an admitted operation")
            selected = self.operation_events(diagnostic["operation_id"])
            require(any(item["msg"] == "portal.auth_failed" and item["request_id"] == diagnostic["request_id"] and
                        item["instance_id"] and item["portal_session_id"] for item in selected), "displayed session diagnosis did not correlate")
            cause = event["cause"]
            action = "Sign in again using the portal password; do not use worker or client credentials."
        else:
            field = "revoked_at" if diagnostic["event"] == "worker.revoked" else "name"
            exchange = "worker.revoke_exchange" if field == "revoked_at" else "worker.rename_exchange"
            require(diagnostic["event"] in ("worker.renamed", "worker.revoked") and diagnostic.get("client_unconfirmed") and status == 200 and
                    event["transaction_outcome"] == "committed", "response-loss scenario lacks a backend commit")
            exchanges = [item for item in requested if item["msg"] == exchange]
            require(len(exchanges) == 1 and exchanges[0]["before"]["id"] == exchanges[0]["after"]["id"] and
                    exchanges[0]["before"].get(field) != exchanges[0]["after"].get(field), "committed response-loss state exchange missing")
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
    proxy = None
    try:
        h.baseline()
        image_id = h.inspect(args.image)["Id"]
        h.setup()
        h.main_service, h.origin_url, _ = h.launch()
        h.ready(h.main_service, h.origin_url)
        proxy = h.browser_proxy = TLSFixture(h, h.origin_url)
        h.worker_browser("empty", {})
        h.expiry_and_role_boundaries()
        workers = h.activity_fixtures()
        h.worker_browser("actions", workers)
        h.capture_protection()
        require(source_identity() == identity, "source changed during worker browser validation")
        outcome = "passed"
    finally:
        try:
            if proxy:
                proxy.close()
            for peer in h.peers:
                if peer.thread.is_alive():
                    peer.stop()
            h.cleanup()
        except Exception:
            outcome = "failed"
            raise
        finally:
            cleanup = h.browser_json("cleanup.json")
            missing_cleanup = not isinstance(cleanup, dict)
            if missing_cleanup:
                cleanup = {"failures": [{"cause": "cleanup_receipt_unavailable"}]}
                outcome = "failed"
            receipt = {"suite": "portal-workers", "outcome": outcome, "source_sha": args.source_sha, "source_dirty": args.source_dirty,
                       "working_source": identity, "image_id": image_id, "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
                       "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"), "cases": h.receipts, "cleanup": cleanup}
            if outcome == "failed" and getattr(h, "worker_failure", None):
                receipt["failure"] = h.worker_failure
            h.assert_private(json.dumps(receipt))
            (safe / "workers-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            if missing_cleanup and sys.exc_info()[0] is None:
                raise AssertionError("worker browser cleanup evidence unavailable")


if __name__ == "__main__":
    main()
