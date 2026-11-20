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
from worker_tls import TLSFixture


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
        with self.storage_fault("aaa_schema_migrations"):
            status, headers, body = self.api("/api/v1/portal/settings", session["session_token"])
            value = json.loads(body)
            require(status == 200 and value["ready"] is False, "database outage concealed")
            event, _ = self.diagnose(headers["X-Request-Id"], "portal.state_stale", value["database"])
            require(event["expected_state"] == "ready" and event["observed_state"] == "unavailable", "outage evidence lacks expected/observed state")
            self.receipt("portal.log_only_database_diagnosis", request_id=headers["X-Request-Id"], cause=event["cause"], corrective_action="Restore the SQLite schema ledger, then refresh settings.")
        self.ready(self.main_service, self.origin_url)
        self.receipt("portal.process_local_sessions", sibling_isolation=True, sqlite_recovered=True)

    def browser_login(self, origin=None, password=None, operation="browser-issue"):
        origin = origin or self.origin_url
        status, headers, body = self.api("/api/v1/portal/login", method="POST", origin=origin,
                                         data={"password": password or self.portal, "remember_me": True},
                                         headers={"Origin": origin, "X-Portal-Operation-Id": operation})
        require(status == 200 and json.loads(body) == {"authenticated": True}, "browser login failed")
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        require(re.fullmatch(r"__Host-muse_portal=muse_portal_[A-Za-z0-9_-]{43}", cookie), "browser cookie missing")
        self.secrets.append(cookie.split("=", 1)[1])
        return {"Cookie": cookie, "Origin": origin}

    def browser_session_storage(self, sibling_origin):
        route = "/api/v1/portal/session"
        browser = self.browser_login()
        require(self.api(route, origin=sibling_origin, headers=browser)[0] == 200, "browser authority is broker-local")
        for key in (self.client, self.admin, "controlled-invalid-authorization"):
            require(self.api(route, key, headers=browser)[0] == 401, "explicit Authorization fell back to ambient cookie")
        workers = json.loads(self.api("/api/v1/admin/workers", headers=browser)[2])["workers"]
        worker = workers[0]
        foreign = {**browser, "Origin": "https://independent-origin.invalid", "Sec-Fetch-Site": "same-site",
                   "X-Portal-Operation-Id": "browser-rejected-origin"}
        for path, method, data in (
                ("/api/v1/portal/login", "POST", {"password": self.portal, "remember_me": False}),
                ("/api/v1/portal/logout", "POST", None),
                ("/api/v1/admin/workers/" + worker["id"], "PATCH", {"name": "Cross-origin change"})):
            status, headers, _ = self.api(path, method=method, data=data, headers=foreign)
            require(status == 403 and headers.get("Set-Cookie") is None, "cross-origin browser write was admitted")
        after = json.loads(self.api("/api/v1/admin/workers", headers=browser)[2])["workers"]
        require(any(item["id"] == worker["id"] and item["name"] == worker["name"] for item in after), "rejected write changed worker state")
        require(self.api(route, headers=browser)[0] == 200, "rejected browser write changed session state")
        require(self.api("/api/v1/portal/logout", method="POST", origin=sibling_origin,
                         headers={**browser, "Origin": sibling_origin, "X-Portal-Operation-Id": "browser-shared-logout"})[0] == 204,
                "sibling did not revoke browser authority")
        code, headers, _ = self.api(route, headers={**browser, "X-Portal-Operation-Id": "browser-denied-after-logout"})
        require(code == 401, "browser retained authority after confirmed sign-out")
        event, _ = self.diagnose(headers["X-Request-Id"], "portal.auth_failed", "invalid_session")
        require(event["level"] == "WARN" and event["portal_session_id"] and event["expected_state"] == "authenticated" and
                event["observed_state"] == "unauthenticated", "session denial lacks a safe cause or correlation")
        self.receipt("portal.cookie_authority_shared_and_revocable", request_id=headers["X-Request-Id"], same_host_brokers=2)

    def session_store_diagnosis(self, operation, request_id):
        code, _, body = self.api("/api/v1/admin/diagnostics/export?operation_id=" + operation, self.admin)
        require(code == 200, "protected session export unavailable")
        metadata, events = self.decode_export(body)
        require(metadata["complete"] and not metadata["omissions"], "session failure export incomplete")
        failure = next(event for event in events if event["msg"] == "portal.session_store_failed")
        detail = next(event for event in events if event["msg"] == "portal.session_store_detail")
        require(failure["request_id"] == request_id == detail["request_id"] and failure["instance_id"] and
                failure["portal_session_id"] and failure["level"] == "ERROR" and failure["stage"] == "authenticate" and failure["cause"] == "sqlite_error",
                "session failure lacks cause or correlation")
        require(detail["level"] == "DEBUG" and "no such table: aaa_portal_grants" in detail["detail"], "dependency detail did not identify the missing session table")
        logs = self.logs(self.main_service)
        self.assert_private(logs)
        require(any(event.get("msg") == "portal.session_store_failed" and event.get("operation_id") == operation
                    for event in map(json.loads, logs.splitlines())) and "portal.session_store_detail" not in logs, "session failure or INFO filtering missing")
        self.receipt("portal.cookie_log_only_store_failure", operation_id=operation, request_id=request_id,
                     corrective_action="Restore the SQLite portal grant table, then retry session restoration.")

    def browser_password_rotation(self):
        route = "/api/v1/portal/session"
        old = self.browser_login(operation="password-rotation-before")
        password = "controlled rotated portal password "
        self.secrets.append(password)
        config = self.configuration()
        config["control-portal"]["password"] = password
        rotated, origin, _ = self.launch(config=config)
        self.ready(rotated, origin)
        stale_operation = "password-rotation-fenced-broker"
        status, headers, _ = self.api(route, headers={**old, "X-Portal-Operation-Id": stale_operation})
        require(status == 503, "stale-password broker retained authority")
        event, _ = self.diagnose(headers["X-Request-Id"], "portal.session_generation_stale", "portal_password_generation_changed")
        require(event["level"] == "WARN" and event["operation_id"] == stale_operation and event["portal_session_id"] and event["instance_id"] and
                event["observed_state"] == "stale_generation", "stale-generation fence lacks WARN evidence and safe correlation")
        require(self.api(route, origin=origin, headers=old)[0] == 401, "password rotation retained a browser grant")
        middle = self.browser_login(origin=origin, password=password, operation="password-rotation-middle")
        reused, origin, _ = self.launch()
        self.ready(reused, origin)
        require(self.api(route, origin=origin, headers=old)[0] == 401 and self.api(route, origin=origin, headers=middle)[0] == 401,
                "reusing the earlier password revived a browser grant")
        for container in (rotated, reused):
            self.assert_private(self.logs(container))
        self.receipt("portal.password_rotation_invalidates_browser_grants", old_broker_fenced=True, former_password_reuse_checked=True)

    def browser(self, key_origins):
        fixture = self.private("browser-fixture.json", json.dumps({"origin": self.origin_url, "password": self.portal,
            "key_origins": key_origins, "source_sha": self.args.source_sha, "container": self.main_service, "database": self.db, "owner": self.owner, "directory": str(self.root.resolve())}))
        result = subprocess.run(["node", "tests/portal/browser.mjs", "--fixture", str(fixture)], capture_output=True, text=True, timeout=600)
        self.private("browser-runner.log", result.stdout + result.stderr)
        secrets_path = self.root / "browser-session-secrets.json"
        if secrets_path.exists():
            self.secrets.extend(json.loads(secrets_path.read_text()))
        require(result.returncode == 0, "built-image browser checks failed; inspect private browser evidence")
        browser = json.loads((self.root / "browser-receipt.json").read_text())
        require(browser["source_sha"] == self.args.source_sha and browser["outcome"] == "passed", "browser source receipt mismatch")
        for item in browser["session_store_diagnostics"]:
            self.session_store_diagnosis(item["operation_id"], item["request_id"])
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
            require(re.fullmatch(r"(login(?:-dark)?|settings(?:-dark)?|error|client-keys)-(1440|768|390)\.png", name), "unexpected screenshot path")
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

    def client_keys(self):
        failure_key = "readonly-save-canary"
        self.secrets.append(failure_key)
        session, _ = self.login()
        operation = "read-only-key-save"
        route = "/api/v1/portal/client-keys"
        status, headers, body = self.api(route, session["session_token"], "POST", {"name": "Read-only mount", "key": failure_key},
                                         headers={"X-Portal-Operation-Id": operation})
        require(status == 503 and json.loads(body) == {"error": "client_key_save_failed"}, "read-only file reported a successful key write")
        event, evidence = self.diagnose(headers["X-Request-Id"], "client_key.persist_failed")
        require(event["level"] == "ERROR" and event["outcome"] == "failed" and event["operation_id"] == operation and
                event["stage"] == "create_temporary" and event["cause"] in ("read-only file system", "permission denied"),
                "log evidence cannot distinguish the write failure")
        require(any(item.get("msg") == "request.completed" and item["status"] == 503 for item in evidence), "write failure lost HTTP correlation")
        require(any(item.get("msg") == "client_key.persist_failed" and item.get("operation_id") == operation
                    for item in map(json.loads, self.logs(self.main_service).splitlines())), "write failure absent at INFO runtime level")
        require(self.api("/v1/models", failure_key)[0] == 401, "failed save enabled the client")
        self.receipt("portal.log_only_config_write_failure", request_id=headers["X-Request-Id"], cause=event["cause"],
                     corrective_action="Mount the configuration directory writable by the service UID.")

        directory = self.root.resolve() / "shared-config"
        directory.mkdir(mode=0o700)
        (directory / "config.yaml").write_text("".join(("# shared broker configuration\n", json.dumps(super().configuration()))))
        mount = "type=bind,source=" + str(directory) + ",target=/fixture"
        def set_owner(owner):
            self.docker("run", "--rm", "--user", "0:0", "--entrypoint", "/bin/sh", "--mount", mount, self.args.image,
                        "-ec", "chmod 700 /fixture; chmod 600 /fixture/config.yaml; chown " + owner + " /fixture /fixture/config.yaml")
        proxies = []
        set_owner("10001:10001")
        try:
            brokers = [self.launch(config_directory=directory) for _ in range(2)]
            for index, (container, origin, _) in enumerate(brokers):
                self.ready(container, origin)
                proxies.append(TLSFixture(self, origin, "client-keys-tls-" + str(index)))
            self.browser([proxy.origin for proxy in proxies])
            keys = json.loads((self.root / "browser-client-key-secrets.json").read_text())
            self.secrets.extend(item["key"] for item in keys)
            require(len(keys) == 4, "browser did not save all named clients")
            first, origin, _ = brokers[0]
            self.docker("restart", first)
            origin = self.origin(first)
            brokers[0] = (first, origin, brokers[0][2])
            self.ready(first, origin)
            raw = self.docker("exec", "--user", "0:0", first, "cat", "/etc/aaa-muse-ai/config.yaml").stdout
            require(raw.startswith("# shared broker configuration"), "YAML comment was lost")
            require(self.docker("exec", first, "stat", "-c", "%a", "/etc/aaa-muse-ai/config.yaml").stdout.strip() == "600", "file mode changed")
            for item in keys:
                require(item["name"] in raw and item["key"] in raw, "persisted config lacks the authored entry")
                require(self.api("/v1/models", item["key"], origin=origin)[0] == 200, "created key was lost after restart")
            for container, origin, _ in brokers:
                status, _, capture = self.api("/api/v1/admin/diagnostics/export", self.admin, origin=origin)
                require(status == 200, "shared broker diagnostic export failed")
                metadata, events = self.decode_export(capture)
                require(metadata["complete"] and not metadata["omissions"], "shared broker diagnostic export incomplete")
                self.assert_private(self.logs(container))
                self.assert_private(json.dumps(events))
            self.receipt("portal.shared_client_keys", broker_count=2, restart_persisted=True, key_values_private=True)
        finally:
            for proxy in proxies:
                proxy.close()
            set_owner(str(os.getuid()) + ":" + str(os.getgid()))


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
        if os.environ.get("MUSE_TEST_DIRECT_NETWORK") == "true":
            h.main_service, h.origin_url, _ = h.launch()
        else:
            # The browser reuses the published URL after restarting this container.
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            h.main_service, h.origin_url, _ = h.launch(port_binding=f"127.0.0.1:{port}:8080")
        h.ready(h.main_service, h.origin_url)
        sibling, sibling_origin, _ = h.launch()
        h.ready(sibling, sibling_origin)
        h.boundaries()
        h.process_scope_and_degradation(sibling_origin)
        h.browser_session_storage(sibling_origin)
        h.client_keys()
        h.browser_password_rotation()
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
