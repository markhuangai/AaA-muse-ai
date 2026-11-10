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
    def __init__(self, harness, target):
        self.harness = harness
        self.target = urllib.parse.urlsplit(target)
        self.connections = []
        self.lock = threading.Lock()
        self.drop_decision = False
        self.dropped = 0
        self.expire_heartbeat = False
        self.delayed_heartbeat = None
        self.events = []
        self.cert = harness.root.resolve() / "tls-cert.pem"
        key = harness.root.resolve() / "tls-key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
                        "-keyout", str(key), "-out", str(self.cert)], check=True, capture_output=True, timeout=20)
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                return

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def forward(self):
                connection = http.client.HTTPConnection(fixture.target.hostname, fixture.target.port, timeout=45)
                with fixture.lock:
                    fixture.connections.append(connection)
                try:
                    body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
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
                    headers = {key: self.headers[key] for key in ("Authorization", "Content-Type", "X-Request-Id") if key in self.headers}
                    connection.request(self.command, self.path, body=body or None, headers=headers)
                    response = connection.getresponse()
                    streaming = self.path == "/api/v1/worker/events" and response.status == 200
                    if not streaming:
                        payload = response.read()
                        with fixture.lock:
                            drop = fixture.drop_decision and self.path.endswith("/decisions") and response.status == 200
                            if drop:
                                fixture.drop_decision = False
                                fixture.dropped += 1
                        if drop:
                            fixture.harness.private("lost-decision-request.json", body.decode())
                            self.connection.shutdown(socket.SHUT_RDWR)
                            self.close_connection = True
                            return
                    self.send_response(response.status)
                    for key in ("Content-Type", "X-Request-Id"):
                        if response.getheader(key):
                            self.send_header(key, response.getheader(key))
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
                        fixture.events.append({"event": "fixture.connection_closed", "cause": type(error).__name__, "route": self.path})
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
