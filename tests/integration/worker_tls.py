import http.client
import http.server
import json
import socket
import ssl
import subprocess
import threading
import time
import urllib.parse


class TLSFixture:
    def __init__(self, harness, target, name="tls"):
        self.harness = harness
        self.target = urllib.parse.urlsplit(target)
        self.connections = []
        self.lock = threading.Lock()
        self.drop_decision = False
        self.interrupt_media = False
        self.media_interrupted = threading.Event()
        self.slow_media = False
        self.media_pause_path = None
        self.media_puts = {}
        self.media_release = threading.Event()
        self.media_finished = threading.Event()
        self.media_status = None
        self.lose_media_ack = False
        self.lose_mcp_reply = False
        self.mcp_reply_lost = threading.Event()
        self.media_ack_lost = threading.Event()
        self.dropped = 0
        self.expire_heartbeat = False
        self.delayed_heartbeat = None
        self.fail_claims = 0
        self.failed_claims = []
        self.allow_statuses = 0
        self.fail_statuses = 0
        self.worker_route_failures = {}
        self.lose_worker_replies = {}
        self.enrollment_accepted = None
        self.observe_staged_credential = None
        self.drop_enrollment_requests = {}
        self.drop_enrollment_replies = {}
        self.pause_decision = False
        self.decision_captured = threading.Event()
        self.release_decision = threading.Event()
        self.delay_context_job = None
        self.context_captured = threading.Event()
        self.release_context = threading.Event()
        self.pause_claim = False
        self.claim_captured = threading.Event()
        self.release_claim = threading.Event()
        self.decision_sizes = []
        self.events = []
        self.worker_requests = 0
        self.cert = harness.root.resolve() / (name + "-cert.pem")
        key = harness.root.resolve() / (name + "-key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
                        "-keyout", str(key), "-out", str(self.cert)], check=True, capture_output=True, timeout=20)
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                return

            def do_GET(self):
                self.forward()

            def do_PUT(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def do_PATCH(self):
                self.forward()

            def forward(self):
                path = urllib.parse.urlsplit(self.path).path.replace("/api/v1/worker/hook/", "/api/v1/worker/", 1)
                route = "/downloads/{id}/{token}" if path.startswith("/downloads/") else path
                if route in ("/mcp", "/downloads/{id}/{token}") and self.headers.get("Host") != urllib.parse.urlsplit(fixture.origin).netloc:
                    with fixture.lock:
                        fixture.events.append({"event": "fixture.host_rejected", "route": route, "forwarded": False})
                    self.send_response(403)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                connection = http.client.HTTPConnection(fixture.target.hostname, fixture.target.port, timeout=325 if route == "/mcp" else 45)
                with fixture.lock:
                    fixture.connections.append(connection)
                try:
                    body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    phase = json.loads(body).get("phase") if path == "/api/v1/worker/enroll" and body and (
                        fixture.drop_enrollment_requests or fixture.drop_enrollment_replies or fixture.observe_staged_credential) else None
                    operation = self.headers.get("X-Muse-Enrollment-Operation")
                    with fixture.lock:
                        if path.startswith("/api/v1/worker/"):
                            fixture.worker_requests += 1
                        if phase and fixture.drop_enrollment_requests.get(phase, 0) > 0:
                            fixture.drop_enrollment_requests[phase] -= 1
                            fixture.events.append({"event": "fixture.enrollment_request_lost", "phase": phase, "operation_id": operation})
                            self.connection.shutdown(socket.SHUT_RDWR)
                            return
                        failures = fixture.worker_route_failures.get(path)
                        injected = failures.pop(0) if failures else None
                        reject = self.path.endswith("/claim") and fixture.fail_claims > 0
                        if reject:
                            fixture.fail_claims -= 1
                            fixture.failed_claims.append(json.loads(body))
                        if path == "/api/v1/worker/status":
                            if fixture.allow_statuses:
                                fixture.allow_statuses -= 1
                            elif fixture.fail_statuses:
                                fixture.fail_statuses -= 1
                                reject = True
                    if injected == "disconnect":
                        self.connection.shutdown(socket.SHUT_RDWR)
                        return
                    if injected == 404:
                        request_id = self.headers.get("X-Request-Id", "fixture-route-404")
                        with fixture.lock:
                            fixture.events.append({"event": "fixture.request_rejected", "route": path, "request_id": request_id, "status": 404, "forwarded": False})
                        payload = b"404 page not found\n"
                        self.send_response(404)
                        self.send_header("Content-Type", "text/plain")
                        self.send_header("Content-Length", str(len(payload)))
                        self.send_header("X-Request-Id", request_id)
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    if reject:
                        with fixture.lock:
                            fixture.events.append({"event": "fixture.request_rejected", "route": self.path, "request_id": self.headers.get("X-Request-Id", "fixture-unavailable"), "status": 503, "forwarded": False})
                        payload = b'{"error":"fixture_unavailable"}'
                        self.send_response(503)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.send_header("X-Request-Id", self.headers.get("X-Request-Id", "fixture-unavailable"))
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    if self.path == "/api/v1/worker/heartbeat":
                        identity = json.loads(body)["connection_id"]
                        with fixture.lock:
                            if fixture.expire_heartbeat:
                                fixture.expire_heartbeat = False
                                fixture.delayed_heartbeat = (identity, time.monotonic() + 25)
                            delayed = fixture.delayed_heartbeat
                        if delayed and delayed[0] == identity:
                            # Expire liveness while leaving time for the final HTTP attempt to receive the broker's refusal.
                            time.sleep(max(0, delayed[1] - time.monotonic()))
                    headers = {key: self.headers[key] for key in ("Authorization", "Content-Type", "Cookie", "Host", "Origin", "Sec-Fetch-Site",
                               "Accept", "MCP-Protocol-Version", "MCP-Method", "MCP-Name", "Mcp-Session-Id",
                               "Forwarded", "X-Forwarded-Host",
                               "X-Request-Id", "X-Portal-Operation-Id", "X-Muse-Enrollment-Operation", "X-Muse-Enrollment-Attempt",
                               "X-Muse-Worker-Version", "X-Muse-Worker-Updater", "X-Muse-Worker-SHA256", "X-Muse-Interruption",
                               "X-Muse-Worker-Start-Proof", "X-Muse-Worker-Hook-Proof", "X-Muse-Worker-Agent-Tasks",
                               "X-Muse-Worker-Model-Report", "X-Muse-Worker-Weekly-Usage", "X-Muse-Media-Jobs", "X-Muse-Prompt-Wav",
                               "X-Muse-Artifact-Sha256", "X-Muse-Artifact-Size", "X-Muse-Connection-Id", "X-Muse-Connection-Generation",
                               "X-Muse-Generation", "X-Muse-Lease-Id") if key in self.headers}
                    if self.command == "PUT" and path.endswith("/artifact"):
                        with fixture.lock:
                            fixture.media_puts[path] = fixture.media_puts.get(path, 0) + 1
                    if self.command == "PUT" and fixture.interrupt_media:
                        headers["Content-Length"] = str(len(body))
                        connection.request("PUT", self.path, body=body[:len(body) // 2], headers=headers)
                        connection.sock.shutdown(socket.SHUT_WR)
                        connection.getresponse().read()
                        fixture.media_interrupted.set()
                        self.send_error(503)
                        return
                    pause = self.command == "PUT" and path == fixture.media_pause_path
                    if self.command == "PUT" and (fixture.slow_media or pause):
                        split = max(1, len(body) // 2)
                        headers["Content-Length"] = str(len(body))
                        connection.request("PUT", self.path, body=body[:split], headers=headers)
                        if pause:
                            if not fixture.media_release.wait(timeout=35):
                                raise TimeoutError("media precommit checkpoint expired")
                        else:
                            fixture.slow_media = False
                            time.sleep(11)
                        connection.send(body[split:])
                    else:
                        connection.request(self.command, self.path, body=body or None, headers=headers)
                    response = connection.getresponse()
                    if pause:
                        fixture.media_status = response.status
                        fixture.media_finished.set()
                    streaming = self.path == "/api/v1/worker/events" and response.status == 200
                    if not streaming:
                        payload = response.read()
                        if phase and response.status == 201:
                            with fixture.lock:
                                if phase == "prepare" and fixture.observe_staged_credential:
                                    fixture.observe_staged_credential(json.loads(payload)["credential"])
                                if fixture.drop_enrollment_replies.get(phase, 0) > 0:
                                    fixture.drop_enrollment_replies[phase] -= 1
                                    fixture.events.append({"event": "fixture.enrollment_reply_lost", "phase": phase, "operation_id": operation,
                                                           "request_id": response.getheader("X-Request-Id")})
                                    self.connection.shutdown(socket.SHUT_RDWR)
                                    return
                        if self.command == "POST" and path.startswith("/api/v1/worker/") and response.status == 200:
                            with fixture.lock:
                                remaining = fixture.lose_worker_replies.get(path, 0)
                                drop_worker_reply = remaining > 0
                                if drop_worker_reply:
                                    fixture.lose_worker_replies[path] = remaining - 1
                                    fixture.events.append({"event": "fixture.worker_reply_lost", "route": path,
                                                           "request_id": response.getheader("X-Request-Id"), "status": response.status})
                            if drop_worker_reply:
                                self.connection.shutdown(socket.SHUT_RDWR)
                                self.close_connection = True
                                return
                        if route == "/mcp" and fixture.lose_mcp_reply and response.status == 200:
                            params = json.loads(body).get("params", {})
                            if params.get("name") == "ask_muse":
                                fixture.lose_mcp_reply = False
                                fixture.mcp_reply_lost.set()
                                self.connection.shutdown(socket.SHUT_RDWR)
                                self.close_connection = True
                                return
                        if self.command == "PUT" and fixture.lose_media_ack and response.status == 200:
                            fixture.lose_media_ack = False
                            fixture.media_ack_lost.set()
                            self.connection.shutdown(socket.SHUT_RDWR)
                            self.close_connection = True
                            return
                        with fixture.lock:
                            paused_claim = fixture.pause_claim and self.path.endswith('/claim') and response.status == 200
                            if paused_claim:
                                fixture.pause_claim = False
                            if self.path.endswith('/decisions') and response.status == 200:
                                fixture.decision_sizes.append(len(payload))
                            paused_decision = fixture.pause_decision and self.path.endswith('/decisions') and response.status == 200
                            if paused_decision:
                                fixture.pause_decision = False
                            delayed_context = self.command == "GET" and fixture.delay_context_job is not None and self.path == "/api/v1/worker/jobs/" + fixture.delay_context_job
                            if delayed_context:
                                fixture.delay_context_job = None
                            drop = fixture.drop_decision and self.path.endswith("/decisions") and response.status == 200
                            if drop:
                                fixture.drop_decision = False
                                fixture.dropped += 1
                        if delayed_context:
                            fixture.context_captured.set()
                            fixture.release_context.wait(timeout=8)
                        if path == "/api/v1/worker/enroll" and response.status == 201 and fixture.enrollment_accepted is not None:
                            worker = json.loads(payload).get("worker")
                            if worker:
                                fixture.enrollment_accepted(worker["id"])
                        if paused_claim:
                            fixture.claim_captured.set()
                            fixture.release_claim.wait(timeout=8)
                        if paused_decision:
                            fixture.harness.private("paused-decision-request.json", body.decode())
                            fixture.decision_captured.set()
                            fixture.release_decision.wait(timeout=30)
                        if drop:
                            fixture.harness.private("lost-decision-request.json", body.decode())
                            self.connection.shutdown(socket.SHUT_RDWR)
                            self.close_connection = True
                            return
                    self.send_response(response.status)
                    for key in ("Content-Type", "X-Request-Id", "X-Muse-Service-Version", "X-Muse-Paired-Worker-SHA256", "Cache-Control", "Content-Security-Policy",
                                "Referrer-Policy", "X-Content-Type-Options", "WWW-Authenticate", "Retry-After", "Allow", "Set-Cookie",
                                "Content-Disposition", "Mcp-Session-Id"):
                        for value in response.headers.get_all(key, []):
                            self.send_header(key, value)
                    if not streaming:
                        self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    if streaming:
                        while True:
                            line = response.readline()
                            if not line:
                                break
                            self.wfile.write(line)
                            self.wfile.flush()
                    else:
                        self.wfile.write(payload)
                except (OSError, http.client.HTTPException) as error:
                    with fixture.lock:
                        fixture.events.append({"event": "fixture.connection_closed", "cause": type(error).__name__, "route": route})
                finally:
                    connection.close()
                    with fixture.lock:
                        fixture.connections.remove(connection)
                    self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.cert), str(key))
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "https://localhost:" + str(self.server.server_port)

    def interrupt(self):
        with self.lock:
            for connection in self.connections:
                if connection.sock:
                    try:
                        connection.sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        continue

    def close(self):
        self.interrupt()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.harness.private("tls-fixture-events.json", __import__("json").dumps(self.events))
