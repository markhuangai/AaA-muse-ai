import http.client
import http.server
import json
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from collections.abc import MutableMapping, MutableSequence


class LockedList(MutableSequence):
    def __init__(self, lock, values=()):
        self.lock = lock
        self._values = list(values)

    def __getitem__(self, index):
        with self.lock:
            return self._values[index]

    def __setitem__(self, index, value):
        with self.lock:
            self._values[index] = value

    def __delitem__(self, index):
        with self.lock:
            del self._values[index]

    def __len__(self):
        with self.lock:
            return len(self._values)

    def __iter__(self):
        with self.lock:
            return iter(self._values.copy())

    def insert(self, index, value):
        with self.lock:
            self._values.insert(index, value)

    def append(self, value):
        with self.lock:
            self._values.append(value)

    def pop(self, index=-1):
        with self.lock:
            return self._values.pop(index)


class LockedDict(MutableMapping):
    def __init__(self, lock, values=()):
        self.lock = lock
        self._values = {}
        self.update(values)

    def __getitem__(self, key):
        with self.lock:
            return self._values[key]

    def __setitem__(self, key, value):
        with self.lock:
            self._values[key] = LockedList(self.lock, value) if isinstance(value, list) else value

    def __delitem__(self, key):
        with self.lock:
            del self._values[key]

    def __iter__(self):
        with self.lock:
            return iter(self._values.copy())

    def __len__(self):
        with self.lock:
            return len(self._values)


def locked_attribute(name):
    def get(instance):
        with instance.lock:
            return instance.__dict__[name]

    def set_value(instance, value):
        with instance.lock:
            if isinstance(value, dict):
                value = LockedDict(instance.lock, value)
            elif isinstance(value, list):
                value = LockedList(instance.lock, value)
            instance.__dict__[name] = value

    return property(get, set_value)


class ThreadingTLSServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, server_address, handler_class, ssl_context, on_event=None, handshake_timeout=10, io_timeout=45):
        self.ssl_context = ssl_context
        self.on_event = on_event
        self.handshake_timeout = handshake_timeout
        self.io_timeout = io_timeout
        self._client_lock = threading.Lock()
        self._client_sockets = set()
        self._closing = False
        super().__init__(server_address, handler_class)

    def record_error(self, event, error):
        record = {"event": event, "cause": type(error).__name__}
        if self.on_event:
            self.on_event(record)
        else:
            print(json.dumps(record), file=sys.stderr)

    def handle_error(self, request, client_address):
        self.record_error("fixture.client_error", sys.exc_info()[1])

    def process_request_thread(self, request, client_address):
        tls_socket = None
        event = "fixture.tls_handshake_failed"
        try:
            with self._client_lock:
                if self._closing:
                    return
                self._client_sockets.add(request)
                request.settimeout(self.handshake_timeout)
                tls_socket = self.ssl_context.wrap_socket(request, server_side=True, do_handshake_on_connect=False)
                self._client_sockets.discard(request)
                self._client_sockets.add(tls_socket)
            tls_socket.do_handshake()
            tls_socket.settimeout(self.io_timeout)
            event = "fixture.client_error"
            self.finish_request(tls_socket, client_address)
        except Exception as error:
            self.record_error(event, error)
        finally:
            with self._client_lock:
                self._client_sockets.discard(request)
                if tls_socket is not None:
                    self._client_sockets.discard(tls_socket)
            try:
                self.shutdown_request(tls_socket or request)
            except Exception as error:
                self.record_error("fixture.client_error", error)

    def interrupt_clients(self, closing=False):
        with self._client_lock:
            if closing:
                self._closing = True
            sockets = list(self._client_sockets)
        for client in sockets:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                continue


class TLSFixture:
    target = locked_attribute("target")
    drop_decision = locked_attribute("drop_decision")
    interrupt_media = locked_attribute("interrupt_media")
    slow_media = locked_attribute("slow_media")
    media_pause_path = locked_attribute("media_pause_path")
    media_puts = locked_attribute("media_puts")
    media_status = locked_attribute("media_status")
    lose_media_ack = locked_attribute("lose_media_ack")
    lose_mcp_reply = locked_attribute("lose_mcp_reply")
    dropped = locked_attribute("dropped")
    expire_heartbeat = locked_attribute("expire_heartbeat")
    delayed_heartbeat = locked_attribute("delayed_heartbeat")
    fail_claims = locked_attribute("fail_claims")
    failed_claims = locked_attribute("failed_claims")
    allow_statuses = locked_attribute("allow_statuses")
    fail_statuses = locked_attribute("fail_statuses")
    worker_route_failures = locked_attribute("worker_route_failures")
    lose_worker_replies = locked_attribute("lose_worker_replies")
    enrollment_accepted = locked_attribute("enrollment_accepted")
    observe_staged_credential = locked_attribute("observe_staged_credential")
    drop_enrollment_requests = locked_attribute("drop_enrollment_requests")
    drop_enrollment_replies = locked_attribute("drop_enrollment_replies")
    pause_decision = locked_attribute("pause_decision")
    delay_context_job = locked_attribute("delay_context_job")
    pause_claim = locked_attribute("pause_claim")
    decision_sizes = locked_attribute("decision_sizes")
    events = locked_attribute("events")
    worker_requests = locked_attribute("worker_requests")

    def __init__(self, harness, target, name="tls"):
        self.harness = harness
        self.lock = threading.RLock()
        self.target = urllib.parse.urlsplit(target)
        self.connections = []
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
            protocol_version = "HTTP/1.1"

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
                self.close_connection = True
                path = urllib.parse.urlsplit(self.path).path.replace("/api/v1/worker/hook/", "/api/v1/worker/", 1)
                route = "/downloads/{id}/{token}" if path.startswith("/downloads/") else path
                lengths = self.headers.get_all("Content-Length", [])
                try:
                    if len(lengths) > 1 or (lengths and (not lengths[0].isascii() or not lengths[0].isdigit())):
                        raise ValueError
                    content_length = int(lengths[0]) if lengths else 0
                    if content_length > sys.maxsize:
                        raise ValueError
                except (ValueError, OverflowError):
                    fixture.events.append({"event": "fixture.invalid_content_length"})
                    self.send_error(400)
                    return
                if route in ("/mcp", "/downloads/{id}/{token}") and self.headers.get("Host") != urllib.parse.urlsplit(fixture.origin).netloc:
                    with fixture.lock:
                        fixture.events.append({"event": "fixture.host_rejected", "route": route, "forwarded": False})
                    self.send_response(403)
                    self.send_header("Content-Length", "0")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    return
                with fixture.lock:
                    target = fixture.target
                    connection = http.client.HTTPConnection(target.hostname, target.port, timeout=325 if route == "/mcp" else 45)
                    fixture.connections.append(connection)
                try:
                    body = self.rfile.read(content_length)
                    with fixture.lock:
                        enrollment_faults = bool(fixture.drop_enrollment_requests or fixture.drop_enrollment_replies or fixture.observe_staged_credential)
                    phase = json.loads(body).get("phase") if path == "/api/v1/worker/enroll" and body and enrollment_faults else None
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
                        reject = path.endswith("/claim") and fixture.fail_claims > 0
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
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    if reject:
                        with fixture.lock:
                            fixture.events.append({"event": "fixture.request_rejected", "route": route, "request_id": self.headers.get("X-Request-Id", "fixture-unavailable"), "status": 503, "forwarded": False})
                        payload = b'{"error":"fixture_unavailable"}'
                        self.send_response(503)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.send_header("X-Request-Id", self.headers.get("X-Request-Id", "fixture-unavailable"))
                        self.send_header("Connection", "close")
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
                    with fixture.lock:
                        if self.command == "PUT" and path.endswith("/artifact"):
                            fixture.media_puts[path] = fixture.media_puts.get(path, 0) + 1
                        interrupt_media = self.command == "PUT" and fixture.interrupt_media
                        pause = self.command == "PUT" and path == fixture.media_pause_path
                        slow_media = self.command == "PUT" and fixture.slow_media
                        if slow_media and not pause and not interrupt_media:
                            fixture.slow_media = False
                    if interrupt_media:
                        headers["Content-Length"] = str(len(body))
                        connection.request("PUT", self.path, body=body[:len(body) // 2], headers=headers)
                        connection.sock.shutdown(socket.SHUT_WR)
                        connection.getresponse().read()
                        fixture.media_interrupted.set()
                        self.send_error(503)
                        return
                    if self.command == "PUT" and (slow_media or pause):
                        split = max(1, len(body) // 2)
                        headers["Content-Length"] = str(len(body))
                        connection.request("PUT", self.path, body=body[:split], headers=headers)
                        if pause:
                            if not fixture.media_release.wait(timeout=35):
                                raise TimeoutError("media precommit checkpoint expired")
                        else:
                            time.sleep(11)
                        connection.send(body[split:])
                    else:
                        connection.request(self.command, self.path, body=body or None, headers=headers)
                    response = connection.getresponse()
                    if pause:
                        fixture.media_status = response.status
                        fixture.media_finished.set()
                    streaming = path == "/api/v1/worker/events" and response.status == 200
                    bodyless = response.status < 200 or response.status in (204, 304)
                    if not streaming:
                        payload = b"" if bodyless else response.read()
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
                        with fixture.lock:
                            drop_mcp = (route == "/mcp" and fixture.lose_mcp_reply and response.status == 200 and
                                        json.loads(body).get("params", {}).get("name") == "ask_muse")
                            if drop_mcp:
                                fixture.lose_mcp_reply = False
                            drop_media_ack = self.command == "PUT" and fixture.lose_media_ack and response.status == 200
                            if drop_media_ack:
                                fixture.lose_media_ack = False
                        if drop_mcp:
                            fixture.mcp_reply_lost.set()
                            self.connection.shutdown(socket.SHUT_RDWR)
                            return
                        if drop_media_ack:
                            fixture.media_ack_lost.set()
                            self.connection.shutdown(socket.SHUT_RDWR)
                            return
                        with fixture.lock:
                            paused_claim = fixture.pause_claim and path.endswith('/claim') and response.status == 200
                            if paused_claim:
                                fixture.pause_claim = False
                            if path.endswith('/decisions') and response.status == 200:
                                fixture.decision_sizes.append(len(payload))
                            paused_decision = fixture.pause_decision and path.endswith('/decisions') and response.status == 200
                            if paused_decision:
                                fixture.pause_decision = False
                            delayed_context = self.command == "GET" and fixture.delay_context_job is not None and path == "/api/v1/worker/jobs/" + fixture.delay_context_job
                            if delayed_context:
                                fixture.delay_context_job = None
                            drop = fixture.drop_decision and path.endswith("/decisions") and response.status == 200
                            if drop:
                                fixture.drop_decision = False
                                fixture.dropped += 1
                        if delayed_context:
                            fixture.context_captured.set()
                            fixture.release_context.wait(timeout=8)
                        with fixture.lock:
                            enrollment_accepted = fixture.enrollment_accepted
                        if path == "/api/v1/worker/enroll" and response.status == 201 and enrollment_accepted is not None:
                            worker = json.loads(payload).get("worker")
                            if worker:
                                enrollment_accepted(worker["id"])
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
                    if not streaming and not bodyless:
                        self.send_header("Content-Length", str(len(payload)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    if streaming:
                        while True:
                            line = response.readline()
                            if not line:
                                break
                            self.wfile.write(line)
                            self.wfile.flush()
                    elif not bodyless:
                        self.wfile.write(payload)
                except (OSError, http.client.HTTPException) as error:
                    with fixture.lock:
                        fixture.events.append({"event": "fixture.connection_closed", "cause": type(error).__name__, "route": route})
                finally:
                    connection.close()
                    with fixture.lock:
                        fixture.connections.remove(connection)
                    self.close_connection = True

        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.cert), str(key))
        self.server = ThreadingTLSServer(("127.0.0.1", 0), Handler, context, on_event=self.events.append)
        self.origin = "https://localhost:" + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def interrupt(self):
        self.server.interrupt_clients()
        with self.lock:
            sockets = [connection.sock for connection in self.connections]
        for sock in sockets:
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    continue

    def close(self):
        self.server.interrupt_clients(closing=True)
        self.media_release.set()
        self.release_decision.set()
        self.release_claim.set()
        self.release_context.set()
        self.server.shutdown()
        self.interrupt()
        self.server.server_close()
        self.thread.join(timeout=5)
        with self.lock:
            events = list(self.events)
        self.harness.private("tls-fixture-events.json", json.dumps(events))
