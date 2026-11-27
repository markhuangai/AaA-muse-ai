import contextlib
import http.server
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portal_workers import PortalWorkers
from worker_tls import TLSFixture


class DiagnosticHarness(PortalWorkers):
    def __init__(self, root):
        self.root = Path(root)
        self.admin = "diagnostic-admin-secret"
        self.portal = "diagnostic-portal-secret"
        self.client = "diagnostic-client-secret"
        self.secrets = []
        self.args = SimpleNamespace(source_sha="a" * 40, source_dirty="true")
        self.receipts = []
        self.origin_url = "http://127.0.0.1:1"
        self.browser_proxy = SimpleNamespace(origin="https://localhost:1", lock=threading.Lock(), events=[])
        self.main_service = "controlled"
        self.db = "controlled"
        self.owner = "controlled"

    def checked(self, *_args):
        return [{"build": {"worker_package": {"version": "1.0.0", "sha256": "a" * 64}}}]


class PortalWorkerDiagnosticsTest(unittest.TestCase):
    def saved_failure(self, harness, directory):
        harness.private("cleanup.json", json.dumps({"failures": []}))
        safe = Path(directory) / "safe"
        safe.mkdir()
        self.assertFalse(harness.write_worker_receipt(safe, {"sha": "a" * 40}, "failed", "controlled"))
        return json.loads((safe / "workers-receipt.json").read_text())["failure"]

    def test_preinitialization_failure_is_classified_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = DiagnosticHarness(directory)
            preload = Path(directory) / "preload.cjs"
            preload.write_text(
                "process.stderr.write('x'.repeat(40000) + '\\n' + process.env.PORTAL_WORKERS_DIAGNOSTIC_CANARY + "
                "' muse_worker_REGEXCANARY aaa_muse_ai_REGEXCANARY Bearer BEARERCANARY __Host-muse_portal=COOKIECANARY\\n');\n"
                "require('aaa-muse-deliberately-missing-preinit-module');\n"
            )
            canary = "literal-diagnostic-canary-secret"
            output = io.StringIO()
            environment = {"NODE_OPTIONS": "--require=" + str(preload), "PORTAL_WORKERS_DIAGNOSTIC_CANARY": canary}
            with patch.dict(os.environ, environment), contextlib.redirect_stderr(output):
                with self.assertRaisesRegex(AssertionError, "worker browser conformance failed"):
                    harness.worker_browser("empty", {})
            failure = harness.worker_failure
            self.assertEqual(failure["step"], "browser/startup")
            self.assertEqual(failure["child_cause"], "MODULE_NOT_FOUND")
            self.assertTrue(failure["child_output_truncated"])
            self.assertNotEqual(failure["returncode"], 0)
            safe_output = output.getvalue() + json.dumps(self.saved_failure(harness, directory))
            harness.assert_private(safe_output)
            for secret in (canary, "REGEXCANARY", "BEARERCANARY", "COOKIECANARY"):
                self.assertNotIn(secret, safe_output)

    def test_direct_http_failure_is_recorded_without_credentials(self):
        request_id = "0123456789abcdef" * 2
        canary = "literal-diagnostic-http-secret"

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.server.observed = (urllib.parse.urlsplit(self.path).path, self.headers.get("Authorization") == "Bearer " + canary)
                body = b'{"error":"muse_worker_REGEXCANARY"}'
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Request-Id", request_id)
                self.end_headers()
                self.wfile.write(body)

        with tempfile.TemporaryDirectory() as directory, http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            thread.start()
            try:
                harness = DiagnosticHarness(directory)
                harness.origin_url = "http://127.0.0.1:" + str(server.server_port)
                output = io.StringIO()
                environment = {"NODE_OPTIONS": "", "PORTAL_WORKERS_DIAGNOSTIC_CANARY": canary, "PORTAL_WORKERS_DIAGNOSTIC_HTTP": "1"}
                with patch.dict(os.environ, environment), contextlib.redirect_stderr(output):
                    with self.assertRaisesRegex(AssertionError, "worker browser conformance failed"):
                        harness.worker_browser("empty", {})
                failure = self.saved_failure(harness, directory)
                self.assertEqual(server.observed, ("/api/v1/worker/pull", True))
                self.assertEqual(failure["step"], "diagnostics/direct-http")
                self.assertIn({"kind": "response", "method": "POST", "path": "/api/v1/worker/pull", "status": 503,
                               "request_id": request_id}, failure["recent_events"])
                safe_output = output.getvalue() + json.dumps(failure)
                harness.assert_private(safe_output)
                self.assertNotIn(canary, safe_output)
                self.assertNotIn("REGEXCANARY", safe_output)
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def test_secret_exception_and_real_tls_failure_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = DiagnosticHarness(directory)
            proxy = TLSFixture(harness, harness.origin_url, name="diagnostic-tls")
            harness.browser_proxy = proxy
            try:
                socket.create_connection(("127.0.0.1", proxy.server.server_port), timeout=5).close()
                deadline = time.monotonic() + 5
                while not any(event.get("event") == "fixture.tls_handshake_failed" for event in proxy.events):
                    self.assertLess(time.monotonic(), deadline, "TLS handshake failure was not recorded")
                    time.sleep(0.01)
                canary = "literal-secret-exception-canary"
                output = io.StringIO()
                environment = {"NODE_OPTIONS": "", "PORTAL_WORKERS_DIAGNOSTIC_CANARY": canary, "PORTAL_WORKERS_DIAGNOSTIC_HTTP": "0"}
                with patch.dict(os.environ, environment), contextlib.redirect_stderr(output):
                    with self.assertRaisesRegex(AssertionError, "worker browser conformance failed"):
                        harness.worker_browser("empty", {})
                failure = self.saved_failure(harness, directory)
                self.assertEqual(failure["diagnostic_cause"], "diagnostic_canary")
                self.assertIn("[REDACTED]", failure["message"])
                self.assertTrue(any(event.get("event") == "fixture.tls_handshake_failed" and event.get("cause")
                                    for event in failure["tls_fixture_events"]))
                safe_output = output.getvalue() + json.dumps(failure)
                harness.assert_private(safe_output)
                for secret in (canary, "DIAGNOSTICREGEXCANARY", "DIAGNOSTICBEARERCANARY", "DIAGNOSTICCOOKIECANARY"):
                    self.assertNotIn(secret, safe_output)
            finally:
                proxy.close()

    def test_missing_browser_is_classified_without_exposing_path(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = DiagnosticHarness(directory)
            output = io.StringIO()
            environment = {"NODE_OPTIONS": "", "PORTAL_WORKERS_DIAGNOSTIC_CANARY": "", "PORTAL_WORKERS_DIAGNOSTIC_HTTP": "",
                           "PLAYWRIGHT_BROWSERS_PATH": str(Path(directory) / harness.portal)}
            with patch.dict(os.environ, environment), contextlib.redirect_stderr(output):
                with self.assertRaisesRegex(AssertionError, "worker browser conformance failed"):
                    harness.worker_browser("empty", {})
            failure = self.saved_failure(harness, directory)
            self.assertEqual(failure["step"], "browser/launch")
            self.assertEqual(failure["diagnostic_cause"], "browser_executable_missing")
            harness.assert_private(output.getvalue() + json.dumps(failure))


if __name__ == "__main__":
    unittest.main()
