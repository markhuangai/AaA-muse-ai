#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time

from service import require
from worker_auth import WorkerAuth


class Portal(WorkerAuth):
    def decode_export(self, body):
        require(len(body) <= 128 * 1024 * 1024 + 65536, "diagnostic export exceeds its retention bound")
        script = 'import {readFileSync} from "node:fs"; import {decodeExport} from "./tools/qualification-evidence.mjs"; process.stdout.write(JSON.stringify(decodeExport(readFileSync(0,"utf8"))));'
        result = subprocess.run(["node", "--input-type=module", "-e", script], input=body.decode("utf8"),
                                capture_output=True, text=True, timeout=30)
        require(result.returncode == 0, "shared diagnostic decoder rejected portal evidence")
        self.assert_private(result.stdout)
        decoded = json.loads(result.stdout)
        return decoded["metadata"], decoded["events"]

    def configuration(self, generated=False):
        config = super().configuration(generated)
        config["client-keys"]['<img src=x onerror="window.__unsafe=1">'] = "unsafe-display-client-sentinel"
        for index in range(180):
            config["client-keys"]["configuration-display-fixture-" + str(index)] = "private-config-client-" + str(index)
        return config

    def login(self, origin=None):
        status, headers, body = self.api("/api/v1/portal/login", method="POST", data={"password": self.portal}, origin=origin)
        require(status == 200, "portal login failed")
        session = json.loads(body)
        self.secrets.append(session["session_token"])
        require(re.fullmatch(r"muse_portal_[A-Za-z0-9_-]{43}", session["session_token"]), "wrong session credential format")
        return session, headers

    def boundaries(self):
        session, _ = self.login()
        token = session["session_token"]
        for key in (None, self.portal, self.client, self.admin):
            require(self.api("/api/v1/portal/settings", key)[0] == 401, "non-session credential accessed portal settings")
        require(self.api("/api/v1/admin/status", token)[0] == 200, "portal session lacks management scope")
        require(self.api("/v1/models", token)[0] == 401, "portal session crossed into model-client authority")
        require(self.api("/api/v1/worker/status", token)[0] == 401, "portal session crossed into worker authority")
        enrollment = self.issue()
        status, _, worker = self.enroll(enrollment)
        require(status == 201, "controlled worker enrollment failed")
        worker_key = worker["credential"]
        require(self.api("/api/v1/portal/settings", worker_key)[0] == 401, "worker credential accessed portal settings")
        for key in (self.admin, self.client, worker_key):
            require(self.api("/api/v1/portal/login", method="POST", data={"password": key})[0] == 401, "another credential class logged in")
        status, headers, body = self.api("/api/v1/portal/settings", token, headers={"X-Portal-Operation-Id": "portal-settings-boundary"})
        value = json.loads(body)
        require(status == 200 and value["ready"] and value["build"]["revision"] == self.args.source_sha, "wrong settings identity")
        require("control-portal:" in value["effective_yaml"] and "[REDACTED]" in value["effective_yaml"], "effective YAML redaction missing")
        require("<img src=x" in value["effective_yaml"] and len(body) > 6144, "unsafe text or chunked payload fixture missing")
        self.assert_private(body.decode())
        _, events = self.diagnose(headers["X-Request-Id"], "portal.settings_detail")
        details = next(e for e in events if e["msg"] == "portal.settings_detail")
        require(details["settings"]["effective_yaml"] == value["effective_yaml"], "captured configuration cannot be reconstructed exactly")
        for route in ("/api/v1/missing", "/api/v1/portal/missing", "/v1/missing", "/assets/missing.js", "/.env", "/assets/source.js.map"):
            status, headers, body = self.api(route)
            require(status == 404 and "text/html" not in headers.get("Content-Type", ""), "frontend concealed an API or asset error")
            if route == "/assets/missing.js":
                event, _ = self.diagnose(headers["X-Request-Id"], "portal.assets_unavailable", "filesystem_path_missing")
                require(event["level"] == "ERROR" and event["revision"] == self.args.source_sha and event["component"] == "shell" and event["asset_path"] == "assets/missing.js", "asset diagnosis lacks build, severity or safe identity")
                require(event["expected_state"] == "available" and event["observed_state"] == "unavailable", "asset diagnosis lacks state comparison")
                self.receipt("portal.log_only_asset_diagnosis", request_id=headers["X-Request-Id"], cause=event["cause"], asset_path=event["asset_path"],
                             corrective_action="Correct the public asset path or rebuild the matching combined image.")
        require(self.api("/api/v1/portal/logout", token, "POST")[0] == 204, "logout failed")
        require(self.api("/api/v1/portal/settings", token)[0] == 401, "logout retained authority")
        self.receipt("portal.credential_and_configuration_boundaries", large_configuration=True, server_expiry_validation="production_handler_injected_clock")

    def process_scope_and_degradation(self, sibling_origin):
        session, _ = self.login()
        require(self.api("/api/v1/portal/settings", session["session_token"], origin=sibling_origin)[0] == 401, "sessions were persisted or shared across service processes")
        second, _ = self.login(sibling_origin)
        require(self.api("/api/v1/admin/status", second["session_token"], origin=sibling_origin)[0] == 200, "sibling session failed")
        self.docker("stop", "--time", "1", self.db)
        try:
            status, headers, body = self.api("/api/v1/portal/settings", session["session_token"])
            value = json.loads(body)
            require(status == 200 and value["ready"] is False, "database outage concealed")
            event, _ = self.diagnose(headers["X-Request-Id"], "portal.state_stale", value["database"])
            require(event["expected_state"] == "ready" and event["observed_state"] == "unavailable", "outage evidence lacks expected/observed state")
            self.receipt("portal.log_only_database_diagnosis", request_id=headers["X-Request-Id"], cause=event["cause"], corrective_action="Restore the PostgreSQL service, then refresh settings.")
        finally:
            self.docker("start", self.db)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if self.docker("exec", self.db, "pg_isready", "-U", "postgres", success=False).returncode == 0:
                    break
                time.sleep(0.2)
            else:
                raise AssertionError("controlled PostgreSQL restart did not recover")
        self.ready(self.main_service, self.origin_url)
        self.receipt("portal.process_local_sessions", sibling_isolation=True, postgres_recovered=True)

    def browser(self):
        fixture = self.private("browser-fixture.json", json.dumps({"origin": self.origin_url, "password": self.portal,
            "source_sha": self.args.source_sha, "container": self.main_service, "owner": self.owner, "directory": str(self.root.resolve())}))
        result = subprocess.run(["node", "tests/portal/browser.mjs", "--fixture", str(fixture)], capture_output=True, text=True, timeout=600)
        self.private("browser-runner.log", result.stdout + result.stderr)
        secrets_path = self.root / "browser-session-secrets.json"
        if secrets_path.exists():
            self.secrets.extend(json.loads(secrets_path.read_text()))
        require(result.returncode == 0, "built-image browser checks failed; inspect private browser evidence")
        browser = json.loads((self.root / "browser-receipt.json").read_text())
        require(browser["source_sha"] == self.args.source_sha and browser["outcome"] == "passed", "browser source receipt mismatch")
        for item in browser["diagnostics"]:
            status, _, body = self.api("/api/v1/admin/diagnostics/export?operation_id=" + item["operation_id"], self.admin)
            require(status == 200, "browser operation export unavailable")
            metadata, events = self.decode_export(body)
            require(metadata["complete"] and not metadata["omissions"], "browser diagnostic capture incomplete")
            self.assert_private(json.dumps(events))
            matched = [e for e in events if e["msg"] == item["event"] and e.get("client_report") is True]
            require(matched, "client-reported browser failure not captured")
            event = matched[0]
            require(event["cause"] == item["cause"] and event["client_build"] == self.args.source_sha and event["portal_session_id"], "browser diagnostic correlation incomplete")
            require(event["level"] == ("ERROR" if item["event"] == "portal.render_failed" else "WARN"), "browser report severity flattened")
            self.receipt("portal.log_only_browser_diagnosis", operation_id=item["operation_id"], event=item["event"], cause=event["cause"],
                         corrective_action="Reload the affected portal build." if item["event"] == "portal.render_failed" else "Restore the connection and retry Refresh.")
        safe = Path(".artifacts/ci/portal/screens")
        safe.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in browser["screenshots"]:
            require(re.fullmatch(r"(login|settings|error)-(1440|768|390)\.png", name), "unexpected screenshot path")
            shutil.copyfile(self.root / name, safe / name)
        self.receipts.extend(browser["cases"])

    def final_diagnostics(self):
        wrong = "wrong-password-final-canary"
        self.secrets.append(wrong)
        status, headers, _ = self.api("/api/v1/portal/login", method="POST", data={"password": wrong}, headers={"X-Portal-Operation-Id": "portal-wrong-password"})
        require(status == 401, "wrong password accepted")
        event, _ = self.diagnose(headers["X-Request-Id"], "portal.auth_failed", "wrong_password")
        require(event["component"] == "login" and event["level"] == "WARN" and event["attempt"] >= 1, "login diagnosis lacks attempt/component")
        self.receipt("portal.log_only_auth_diagnosis", request_id=headers["X-Request-Id"], cause=event["cause"], corrective_action="Use the configured portal password; do not use another credential class.")
        for index in range(4):
            require(self.api("/api/v1/portal/login", method="POST", data={"password": wrong}, headers={"X-Forwarded-For": "198.51.100." + str(index)})[0] == 401, "login limit changed")
        status, headers, _ = self.api("/api/v1/portal/login", method="POST", data={"password": self.portal}, headers={"X-Forwarded-For": "203.0.113.1"})
        require(status == 429 and int(headers["Retry-After"]) > 0, "forwarded address bypassed failed-login bound")
        _, events = self.diagnose(headers["X-Request-Id"], "portal.auth_failed", "login_throttled")
        require(any(e["retry_after_seconds"] > 0 for e in events if e["msg"] == "portal.auth_failed"), "throttle lacks corrective delay")
        status, _, body = self.api("/api/v1/admin/diagnostics/export", self.admin)
        require(status == 200, "final protected capture unavailable")
        metadata, events = self.decode_export(body)
        require(metadata["complete"] and not metadata["omissions"], "final capture incomplete")
        self.assert_private(json.dumps(events))
        logs = self.logs(self.main_service)
        self.assert_private(logs)
        require('"msg":"portal.settings_detail"' not in logs and '"msg":"portal.browser_report"' not in logs, "DEBUG values escaped INFO filtering")
        require(any(e["msg"] == "request.exchange" and e["response_capture"] == "credentials_omitted" for e in events), "login credential omission not recorded")
        self.receipt("portal.capture_protection", complete=True, info_filter=True, credential_scan=True)


def source_identity():
    script = "import {inspectSource} from './tools/source-inventory.mjs'; console.log(JSON.stringify(inspectSource().identity))"
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script], text=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", required=True, choices=("true", "false"))
    args = parser.parse_args()
    os.umask(0o077)
    h = Portal(args)
    identity = source_identity()
    safe = Path(".artifacts/ci/portal")
    safe.mkdir(parents=True, exist_ok=True, mode=0o700)
    outcome = "failed"
    image_id = None
    try:
        h.baseline()
        image_id = h.inspect(args.image)["Id"]
        h.docker("run", "--rm", "--entrypoint", "/bin/sh", args.image, "-ec",
                 '. /etc/os-release; test "$ID" = alpine; test -s /usr/share/aaa-muse-ai/portal/index.html; test -s /usr/share/aaa-muse-ai/licenses/geist-OFL.txt; test -s /usr/share/aaa-muse-ai/licenses/geist-mono-OFL.txt; test ! -e /usr/bin/node')
        h.setup()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        h.main_service, h.origin_url, _ = h.launch(port_binding=f"127.0.0.1:{port}:8080")
        h.ready(h.main_service, h.origin_url)
        sibling, sibling_origin, _ = h.launch()
        h.ready(sibling, sibling_origin)
        h.boundaries()
        h.process_scope_and_degradation(sibling_origin)
        h.browser()
        h.final_diagnostics()
        require(source_identity() == identity, "source changed during browser validation")
        outcome = "passed"
    finally:
        h.cleanup()
        cleanup = json.loads((h.root / "cleanup.json").read_text())
        receipt = {"suite": "portal", "outcome": outcome, "source_sha": args.source_sha, "source_dirty": args.source_dirty,
                   "working_source": identity, "image_id": image_id, "run_id": os.environ.get("GITHUB_RUN_ID", "local"),
                   "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"), "cases": h.receipts, "cleanup": cleanup}
        h.assert_private(json.dumps(receipt))
        (safe / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
