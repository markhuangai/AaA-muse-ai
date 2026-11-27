import concurrent.futures
import contextlib
import hashlib
import http.client
import http.server
import io
import json
from pathlib import Path
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

from .worker_tls import TLSFixture


class Harness:
    def __init__(self, root):
        self.root = Path(root)
        self.records = {}
        self.lock = threading.Lock()

    def private(self, name, contents):
        with self.lock:
            self.records[name] = contents


class Upstream(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def __init__(self):
        super().__init__(("127.0.0.1", 0), UpstreamHandler)
        self.hold_release = threading.Event()
        self.race_release = threading.Event()
        self.sse_release = threading.Event()
        self.mcp_release = threading.Event()
        self.mcp_started = threading.Event()
        self.condition = threading.Condition()
        self.waiting = 0
        self.calls = 0
        self.errors = []

    def handle_error(self, request, client_address):
        with self.condition:
            self.errors.append(type(sys.exc_info()[1]).__name__)


class UpstreamHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        return

    def reply(self, status, body=b"ok"):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if status not in (204, 304):
            self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        with self.server.condition:
            self.server.calls += 1
        if path in ("/hold", "/race"):
            with self.server.condition:
                self.server.waiting += 1
                self.server.condition.notify_all()
            release = self.server.hold_release if path == "/hold" else self.server.race_release
            if not release.wait(10):
                raise TimeoutError("upstream release not signaled")
        if path in ("/no-content", "/not-modified"):
            self.reply(204 if path == "/no-content" else 304)
        elif path.endswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"data: first\n\n")
            self.wfile.flush()
            if not self.server.sse_release.wait(10):
                raise TimeoutError("SSE release not signaled")
            self.wfile.write(b"data: second\n\n")
            self.close_connection = True
        else:
            self.reply(200)

    def do_POST(self):
        self.receive()

    def do_PUT(self):
        self.receive()

    def receive(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        with self.server.condition:
            self.server.calls += 1
        if urllib.parse.urlsplit(self.path).path == "/mcp":
            self.server.mcp_started.set()
            if not self.server.mcp_release.wait(10):
                raise TimeoutError("MCP release not signaled")
        payload = hashlib.sha256(body).hexdigest().encode() if self.command == "PUT" else b"ok"
        self.reply(200, payload)


class TLSFixtureTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.upstream = Upstream()
        self.upstream_thread = threading.Thread(target=self.upstream.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.upstream_thread.start()
        self.addCleanup(self.close_upstream)
        self.harness = Harness(self.directory.name)
        self.fixture = TLSFixture(self.harness, "http://127.0.0.1:" + str(self.upstream.server_port))
        self.addCleanup(self.close_fixture)
        self.context = ssl.create_default_context(cafile=str(self.fixture.cert))
        self.port = self.fixture.server.server_port

    def close_upstream(self):
        self.upstream.hold_release.set()
        self.upstream.race_release.set()
        self.upstream.sse_release.set()
        self.upstream.mcp_release.set()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.upstream_thread.join(timeout=5)

    def close_fixture(self):
        if self.fixture is not None:
            fixture, self.fixture = self.fixture, None
            fixture.close()

    def connection(self, timeout=10):
        return http.client.HTTPSConnection("localhost", self.port, context=self.context, timeout=timeout)

    def request(self, path, method="GET", body=None, headers=None):
        with contextlib.closing(self.connection()) as connection:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()

    def wait_for(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail("timed out waiting for fixture state")
            time.sleep(0.01)

    def test_idle_connections_and_forty_concurrent_requests(self):
        sockets = []
        self.addCleanup(lambda: [client.close() for client in sockets])
        for _ in range(5):
            sockets.append(socket.create_connection(("127.0.0.1", self.port), timeout=10))
        for _ in range(5):
            raw = socket.create_connection(("127.0.0.1", self.port), timeout=10)
            sockets.append(self.context.wrap_socket(raw, server_hostname="localhost"))

        def all_clients_tracked():
            with self.fixture.server._client_lock:
                return len(self.fixture.server._client_sockets) >= 10

        self.wait_for(all_clients_tracked)
        barrier = threading.Barrier(40, timeout=20)

        def fetch(_):
            barrier.wait()
            return self.request("/ok")

        with concurrent.futures.ThreadPoolExecutor(max_workers=40) as pool:
            results = list(pool.map(fetch, range(40)))
        self.assertEqual(len(results), 40)
        for status, headers, body in results:
            self.assertEqual((status, body), (200, b"ok"))
            self.assertEqual(headers.get("Connection"), "close")
        started = time.monotonic()
        self.close_fixture()
        self.assertLess(time.monotonic() - started, 2)

    def test_malformed_content_length_is_private_and_not_forwarded(self):
        canary = b"private-header-canary"
        captured = io.StringIO()
        invalid_headers = [b"Content-Length: " + canary, b"Content-Length: -1", b"Content-Length: " + b"9" * 5000,
                           b"Content-Length: 1\r\nContent-Length: 2"]
        with contextlib.redirect_stderr(captured):
            for header in invalid_headers:
                raw = socket.create_connection(("127.0.0.1", self.port), timeout=10)
                with self.context.wrap_socket(raw, server_hostname="localhost") as client:
                    client.sendall(b"POST /invalid HTTP/1.1\r\nHost: localhost\r\n" + header + b"\r\n\r\n")
                    response = http.client.HTTPResponse(client)
                    response.begin()
                    payload = response.read()
                    self.assertEqual(response.version, 11)
                    self.assertEqual(response.status, 400)
                    self.assertEqual(response.getheader("Connection"), "close")
                    self.assertNotIn(canary, payload)
                    self.assertNotIn(canary.decode(), repr(response.getheaders()))
            self.wait_for(lambda: sum(event.get("event") == "fixture.invalid_content_length" for event in self.fixture.events) == 4)
        self.assertEqual(self.upstream.calls, 0)
        self.assertNotIn(canary.decode(), captured.getvalue())
        self.assertNotIn("Traceback", captured.getvalue())
        self.assertNotIn(canary.decode(), json.dumps(list(self.fixture.events)))

    def test_unexpected_handler_error_does_not_log_request_data(self):
        self.fixture.drop_enrollment_requests["prepare"] = 1
        canary = "private-body-canary"
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            with self.assertRaises((OSError, http.client.HTTPException)):
                self.request("/api/v1/worker/enroll", "POST", canary.encode())
            self.wait_for(lambda: any(event.get("cause") == "JSONDecodeError" for event in self.fixture.events))
        self.assertNotIn(canary, captured.getvalue())
        self.assertNotIn("Traceback", captured.getvalue())
        self.assertNotIn(canary, json.dumps(list(self.fixture.events)))

    def test_bodyless_responses_and_normalized_sse_stream(self):
        for path, expected in (("/no-content", 204), ("/not-modified", 304)):
            status, headers, body = self.request(path)
            self.assertEqual((status, body), (expected, b""))
            self.assertNotIn("Content-Length", headers)
            self.assertEqual(headers.get("Connection"), "close")
        with contextlib.closing(self.connection()) as connection:
            connection.request("GET", "/api/v1/worker/hook/events?since=1")
            response = connection.getresponse()
            self.assertEqual(response.version, 11)
            self.assertEqual(response.status, 200)
            self.assertIsNone(response.getheader("Content-Length"))
            self.assertEqual(response.getheader("Connection"), "close")
            self.assertEqual(response.readline(), b"data: first\n")
            self.assertEqual(response.readline(), b"\n")
            self.upstream.sse_release.set()
            self.assertEqual(response.read(), b"data: second\n\n")

    def test_mcp_keeps_long_upstream_timeout(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(self.request, "/mcp", "POST", b"{}")
            try:
                self.assertTrue(self.upstream.mcp_started.wait(5))
                with self.fixture.lock:
                    connections = list(self.fixture.connections)
                self.assertEqual(len(connections), 1)
                self.assertEqual(connections[0].timeout, 325)
                self.assertEqual(connections[0].sock.gettimeout(), 325)
            finally:
                self.upstream.mcp_release.set()
            self.assertEqual(request.result(timeout=10)[0], 200)

    def test_32_mib_upload_is_forwarded_without_truncation(self):
        body = b"x" * (32 << 20)
        path = "/api/v1/worker/jobs/example/artifact"
        status, headers, payload = self.request(path, "PUT", body)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Connection"), "close")
        self.assertEqual(payload.decode(), hashlib.sha256(body).hexdigest())
        self.assertEqual(self.fixture.media_puts[path], 1)

    def test_faults_and_handshake_failure_use_safe_metadata(self):
        status, headers, _ = self.request("/mcp", headers={"Host": "wrong.invalid"})
        self.assertEqual(status, 403)
        self.assertEqual(headers.get("Connection"), "close")
        self.fixture.worker_route_failures["/api/v1/worker/status"] = [404, "disconnect"]
        status, headers, _ = self.request("/api/v1/worker/status")
        self.assertEqual(status, 404)
        self.assertEqual(headers.get("Connection"), "close")
        with self.assertRaises((OSError, http.client.HTTPException)):
            self.request("/api/v1/worker/status")
        self.fixture.fail_claims = 1
        status, headers, _ = self.request("/api/v1/worker/claim?private=canary", "POST", b"{}")
        self.assertEqual(status, 503)
        self.assertEqual(headers.get("Connection"), "close")
        rejections = [event for event in self.fixture.events if event.get("status") == 503]
        self.assertEqual(rejections[0]["route"], "/api/v1/worker/claim")
        self.assertNotIn("private=canary", json.dumps(rejections))
        self.fixture.drop_decision = True
        with self.assertRaises((OSError, http.client.HTTPException)):
            self.request("/api/v1/worker/jobs/example/decisions", "POST", b"{}")
        self.assertEqual(self.fixture.dropped, 1)
        self.assertIn("lost-decision-request.json", self.harness.records)
        raw = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        raw.close()
        self.wait_for(lambda: any(event.get("event") == "fixture.tls_handshake_failed" for event in self.fixture.events))
        for event in self.fixture.events:
            if event.get("event") == "fixture.tls_handshake_failed":
                self.assertEqual(set(event), {"event", "cause"})

    def test_concurrent_fault_consumption_is_atomic(self):
        path = "/api/v1/worker/pull"
        self.fixture.lose_worker_replies[path] = 20

        def fetch(_):
            try:
                return self.request(path, "POST", b"{}")[0]
            except (OSError, http.client.HTTPException):
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            results = list(pool.map(fetch, range(40)))
        self.assertEqual(results.count(None), 20)
        self.assertEqual(results.count(200), 20)
        self.assertEqual(self.fixture.lose_worker_replies[path], 0)

    def test_target_change_does_not_move_an_active_request(self):
        secondary = Upstream()
        thread = threading.Thread(target=secondary.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                request = pool.submit(self.request, "/hold")
                try:
                    with self.upstream.condition:
                        self.assertTrue(self.upstream.condition.wait_for(lambda: self.upstream.waiting == 1, timeout=10))
                    self.fixture.target = urllib.parse.urlsplit("http://127.0.0.1:" + str(secondary.server_port))
                    self.assertEqual(self.request("/ok")[0], 200)
                    self.assertEqual(secondary.calls, 1)
                finally:
                    self.upstream.hold_release.set()
                self.assertEqual(request.result(timeout=10)[0], 200)
            self.assertEqual(self.upstream.calls, 1)
        finally:
            secondary.shutdown()
            secondary.server_close()
            thread.join(timeout=5)

    def test_lost_worker_mcp_and_media_replies(self):
        path = "/api/v1/worker/pull"
        self.fixture.lose_worker_replies[path] = 1
        with self.assertRaises((OSError, http.client.HTTPException)):
            self.request(path, "POST", b"{}")
        self.assertEqual(self.fixture.lose_worker_replies[path], 0)
        self.fixture.lose_mcp_reply = True
        self.upstream.mcp_release.set()
        with self.assertRaises((OSError, http.client.HTTPException)):
            self.request("/mcp", "POST", b'{"params":{"name":"ask_muse"}}')
        self.assertTrue(self.fixture.mcp_reply_lost.is_set())
        self.fixture.lose_media_ack = True
        with self.assertRaises((OSError, http.client.HTTPException)):
            self.request("/api/v1/worker/jobs/example/artifact", "PUT", b"sample")
        self.assertTrue(self.fixture.media_ack_lost.is_set())

    def test_active_requests_close_without_socket_race_or_tracebacks(self):
        captured = io.StringIO()

        def fetch(path):
            try:
                return self.request(path)
            except (OSError, http.client.HTTPException):
                return None

        with contextlib.redirect_stderr(captured), concurrent.futures.ThreadPoolExecutor(max_workers=13) as pool:
            futures = [pool.submit(fetch, "/hold")]
            futures.extend(pool.submit(fetch, "/race") for _ in range(12))
            try:
                with self.upstream.condition:
                    self.assertTrue(self.upstream.condition.wait_for(lambda: self.upstream.waiting == 13, timeout=10))
                fixture = self.fixture
                self.upstream.race_release.set()
                started = time.monotonic()
                self.close_fixture()
                self.assertLess(time.monotonic() - started, 2)
                self.assertTrue(fixture.media_release.is_set())
                self.assertTrue(fixture.release_claim.is_set())
                self.assertTrue(fixture.release_decision.is_set())
                self.assertTrue(fixture.release_context.is_set())
                for future in futures:
                    future.result(timeout=10)
            finally:
                self.upstream.hold_release.set()
                self.upstream.race_release.set()
        self.assertNotIn("Traceback", captured.getvalue())
        self.assertNotIn("AttributeError", captured.getvalue())
        self.assertFalse(any(event.get("cause") == "AttributeError" for event in fixture.events))

    def test_teardown_releases_a_paused_claim(self):
        self.fixture.pause_claim = True

        def claim():
            try:
                return self.request("/api/v1/worker/claim", "POST", b"{}")
            except (OSError, http.client.HTTPException):
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            request = pool.submit(claim)
            self.assertTrue(self.fixture.claim_captured.wait(5))
            fixture = self.fixture
            self.close_fixture()
            self.assertTrue(fixture.release_claim.is_set())
            request.result(timeout=10)


if __name__ == "__main__":
    unittest.main()
