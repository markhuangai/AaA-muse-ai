#!/usr/bin/env python3
import argparse
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import select
import subprocess
import time
import urllib.error
import urllib.request
import urllib.parse

SQLITE_STATE = "/var/lib/aaa-muse-ai/state"
SQLITE_FILE = SQLITE_STATE + "/broker.sqlite3"
SQLITE_FIXTURE_SETTINGS = "PRAGMA foreign_keys=ON;\nPRAGMA synchronous=FULL;\n"
LABEL = "io.aaa-muse.test-owner"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Harness:
    def __init__(self, args):
        self.args = args
        self.owner = "aaa-muse-test-" + secrets.token_hex(6)
        self.root = Path(".artifacts/integration") / self.owner
        self.root.mkdir(parents=True, mode=0o700)
        self.resources = {"containers": [], "volumes": [], "networks": []}
        self.receipts = []
        self.admin = "test-admin-" + secrets.token_hex(24)
        self.portal = "test-portal-" + secrets.token_hex(24)
        self.client = "test-client-" + secrets.token_hex(24)
        self.network = None
        self.db = None

    def private(self, name, data):
        path = self.root / name
        path.write_text(data)
        path.chmod(0o600)
        return path.resolve()

    def docker(self, *args, input_text=None, success=True, timeout=90):
        result = subprocess.run(["docker", *args], input=input_text, capture_output=True,
                                text=True, timeout=timeout)
        if success and result.returncode:
            self.private("last-docker-error.txt", result.stderr)
            raise RuntimeError("Docker operation failed: " + args[0])
        return result

    def remember(self, kind, identity):
        self.resources[kind].append(identity)
        self.private("resources.json", json.dumps({"owner": self.owner, **self.resources}))
        return identity

    def volume(self, suffix):
        name = self.owner + "-" + suffix
        identity = self.docker("volume", "create", "--label", LABEL + "=" + self.owner, name).stdout.strip()
        return self.remember("volumes", identity)

    def inspect(self, identity):
        return json.loads(self.docker("inspect", identity).stdout)[0]

    def origin(self, identity):
        settings = self.inspect(identity)["NetworkSettings"]
        ports = settings["Ports"]
        require(set(ports) == {"8080/tcp"}, "service must expose one HTTP port")
        direct = os.environ.get("MUSE_TEST_DIRECT_NETWORK", "false")
        require(direct in ("false", "true"), "invalid direct-network test setting")
        if direct == "true":
            # Docker Desktop forwarding can drop SYNs even when the service network remains healthy.
            networks = list(settings["Networks"].values())
            require(len(networks) == 1 and networks[0]["NetworkID"] == self.network and networks[0]["IPAddress"], "direct transport requires the harness-owned network")
            self.receipt("transport.direct_container_network", container=identity, network=self.network)
            return "http://" + networks[0]["IPAddress"] + ":8080"
        return "http://127.0.0.1:" + ports["8080/tcp"][0]["HostPort"]

    def logs(self, container):
        result = self.docker("logs", container)
        value = result.stdout + result.stderr
        self.private(container[:12] + ".logs", value)
        return value

    def receipt(self, case, **fields):
        value = {"case": case, "outcome": "passed", **fields}
        self.receipts.append(value)
        print(json.dumps(value), flush=True)

    def setup(self):
        self.network = self.remember("networks", self.docker("network", "create", "--label", LABEL + "=" + self.owner, self.owner).stdout.strip())
        self.state_volume = self.volume("sqlite")
        tools = os.environ.get("SERVICE_TOOLS_IMAGE", "aaa-muse-sqlite-tools:" + self.args.source_sha)
        self.docker("build", "--target", "tools", "-t", tools, ".", timeout=240)
        self.db = self.remember("containers", self.docker(
            "run", "-d", "--label", LABEL + "=" + self.owner, "-v", self.state_volume + ":" + SQLITE_STATE,
            "--entrypoint", "sh", tools, "-ec",
            'chmod 700 "$1"; chown 10001:10001 "$1"; install -m 600 -o 10001 -g 10001 /dev/null "$2"; exec sleep 86400',
            "sqlite-fixture", SQLITE_STATE, SQLITE_FILE).stdout.strip())
        version = self.sql("SELECT sqlite_version();")
        parts = version.split(".")
        require(len(parts) == 3 and all(part.isdigit() for part in parts) and tuple(map(int, parts)) >= (3, 51, 3), "test CLI lacks the patched SQLite version")

    def configuration(self, generated=False):
        return {"server": {"listen": "0.0.0.0:8080"},
                "management": {"key": "" if generated else self.admin},
                "control-portal": {"password": self.portal},
                "client-keys": {"fixture-client": self.client},
                "diagnostics": {"level": "info", "directory": "/var/lib/aaa-muse-ai/diagnostics"}}

    def launch(self, config=None, raw=None, diagnostic_volume=None, expect_startup=True, port_binding="127.0.0.1::8080", environment=(), media_volume=None, config_directory=None, state_volume=None, state_readonly=False):
        index = len(self.resources["containers"])
        if config_directory is None:
            path = self.private("config-" + str(index) + ".yaml", raw if raw is not None else json.dumps(config or self.configuration()))
            # The bind source is inside a private directory; the container needs read access to its mounted file.
            path.chmod(0o644)
            config_mount = "type=bind,source=" + str(path) + ",target=/etc/aaa-muse-ai/config.yaml,readonly"
        else:
            config_mount = "type=bind,source=" + str(config_directory) + ",target=/etc/aaa-muse-ai"
        volume = diagnostic_volume or self.volume("diagnostics-" + str(index))
        identity = self.remember("containers", self.docker("run", "-d", "--label", LABEL + "=" + self.owner,
                                  "--network", self.network, "-p", port_binding,
                                  *[argument for name in environment for argument in ("--env", name)],
                                  "--mount", config_mount,
                                  "-v", (state_volume or self.state_volume) + ":" + SQLITE_STATE + (":ro" if state_readonly else ""),
                                  "-v", volume + ":/var/lib/aaa-muse-ai/diagnostics",
                                  *(["-v", media_volume + ":/var/lib/aaa-muse-ai/media"] if media_volume else []), self.args.image).stdout.strip())
        return identity, self.origin(identity) if expect_startup else None, volume

    def request(self, origin, path, key=None, method="GET", body=None, extra_headers=None):
        headers = {"Origin": "https://operator.example.test"}
        headers.update(extra_headers or {})
        if key is not None:
            headers["Authorization"] = "Bearer " + key
        request = urllib.request.Request(origin + path, headers=headers, data=body, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=8)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def ready(self, container, origin):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                code, headers, _ = self.request(origin, "/readyz")
                if code == 200:
                    return headers["X-Request-Id"]
            except (OSError, urllib.error.URLError):
                pass
            if not self.inspect(container)["State"]["Running"]:
                self.logs(container)
                raise RuntimeError("Service exited before readiness")
            time.sleep(0.1)
        raise RuntimeError("Service readiness timed out")

    def sqlite_command(self):
        return ["docker", "exec", "-i", "--user", "10001:10001", self.db, "sqlite3", "-bail", "-batch",
                "-noheader", "-cmd", ".timeout 4000", SQLITE_FILE]

    def sql(self, sql):
        result = subprocess.run(self.sqlite_command(), input=SQLITE_FIXTURE_SETTINGS + sql + "\n", capture_output=True, text=True, timeout=8)
        if result.returncode:
            self.private("sqlite-fixture-error.txt", result.stderr)
            raise RuntimeError("SQLite fixture statement failed: " + result.stderr.strip())
        return result.stdout.strip()

    @contextmanager
    def writer_lock(self, before=""):
        process = subprocess.Popen(self.sqlite_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write(SQLITE_FIXTURE_SETTINGS + "BEGIN IMMEDIATE;\n" + before + "\n.shell echo LOCKED\n")
            process.stdin.flush()
            readable, _, _ = select.select([process.stdout], [], [], 5)
            require(bool(readable) and process.stdout.readline().strip() == "LOCKED", "SQLite writer barrier was not acquired")
            yield
        finally:
            try:
                _, stderr = process.communicate("ROLLBACK;\n", timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise RuntimeError("SQLite writer barrier did not release")
            require(process.returncode == 0, "SQLite writer barrier failed: " + stderr.strip())

    @contextmanager
    def storage_fault(self, *tables):
        hide = "; ".join("ALTER TABLE " + table + " RENAME TO hidden_" + table for table in tables)
        restore = "; ".join("ALTER TABLE hidden_" + table + " RENAME TO " + table for table in reversed(tables))
        self.sql("BEGIN IMMEDIATE; " + hide + "; COMMIT;")
        try:
            yield
        finally:
            self.sql("BEGIN IMMEDIATE; " + restore + "; COMMIT;")

    def reject_writes(self, name, table, condition, operation="UPDATE"):
        self.sql(f"CREATE TRIGGER {name} BEFORE {operation} ON {table} WHEN {condition} "
                 f"BEGIN SELECT RAISE(ABORT, '{name}: controlled SQLite write failure'); END;")

    def expire_job(self, job, timestamp):
        expiration = """
            UPDATE aaa_experiments SET deadline_at=0,
              data=CAST(json_set(CAST(data AS TEXT),'$.deadline_at','{}') AS BLOB) WHERE id='{}';
            UPDATE aaa_inference_jobs SET data=CAST(json_set(CAST(data AS TEXT),'$.deadline_at','{}') AS BLOB) WHERE id='{}';
        """.format(timestamp, job["experiment_id"], timestamp, job["id"])
        self.sql("BEGIN IMMEDIATE;" + expiration + "COMMIT;")

    def decode_export(self, body):
        lines = body.splitlines()
        require(bool(lines), "empty diagnostic export")
        metadata = json.loads(lines[0])
        require(metadata["type"] == "export", "missing export metadata")
        captures = {}
        for line in lines[1:]:
            require(len(line) + 1 <= 6144, "oversized diagnostic record")
            record = json.loads(line)
            captures.setdefault(record["capture_id"], []).append(record)
        events = []
        for records in captures.values():
            require(len(records) == records[0]["chunks"], "missing diagnostic chunks")
            require([record["chunk"] for record in records] == list(range(len(records))), "wrong chunk order")
            payload = b"".join(base64.b64decode(record["data_base64"], validate=True) for record in records)
            require(hashlib.sha256(payload).hexdigest() == records[0]["payload_sha256"], "capture digest mismatch")
            events.append(json.loads(payload))
        require(metadata["captures"] == len(events), "incorrect capture count")
        return metadata, events

    def assert_private(self, value, extra=()):
        for secret in (self.admin, self.portal, self.client, *extra):
            require(secret not in value, "credential exposed outside its allowed output")

    def baseline(self):
        info = json.loads(self.docker("image", "inspect", self.args.image).stdout)[0]
        require(info["Config"]["User"] == "10001:10001", "runtime process is not the expected non-root user")
        labels = info["Config"]["Labels"]
        require(labels["org.opencontainers.image.revision"] == self.args.source_sha, "image source SHA mismatch")
        require(labels["io.aaa-muse.source-dirty"] == self.args.source_dirty, "image source state mismatch")
        self.docker("run", "--rm", "--entrypoint", "/bin/sh", self.args.image,
                    "-ec", 'test "$(id -u)" = 10001; test -s /etc/ssl/certs/ca-certificates.crt')
        self.receipt("runtime.identity", source_sha=self.args.source_sha, source_dirty=self.args.source_dirty, image_id=info["Id"])

    def functional(self):
        with self.writer_lock():
            first, origin, volume = self.launch()
            second, sibling_origin, _ = self.launch()
            require(self.inspect(first)["State"]["Running"] and self.inspect(second)["State"]["Running"], "simultaneous bootstrap did not launch both processes")
            time.sleep(0.25)
            require("db.connected" not in self.logs(first) + self.logs(second), "bootstrap crossed the held writer barrier")
        self.ready(first, origin)
        self.ready(second, sibling_origin)
        require(self.sql("SELECT count(*) FROM aaa_schema_migrations;") == "2", "concurrent bootstrap did not apply both migrations")
        require(self.sql("PRAGMA journal_mode;") == "wal", "SQLite WAL was not enabled")
        for file in (SQLITE_FILE, SQLITE_FILE + "-wal", SQLITE_FILE + "-shm"):
            require(self.docker("exec", self.db, "stat", "-c", "%a:%u", file).stdout.strip() == "600:10001", "SQLite state file permissions are open")
        require(self.docker("exec", self.db, "stat", "-c", "%a:%u", SQLITE_STATE).stdout.strip() == "700:10001", "SQLite state directory permissions are open")
        self.receipt("migration.concurrent_bootstrap", broker_processes=2, schema_versions=2)
        info = self.inspect(first)
        config_mount = next(mount for mount in info["Mounts"] if mount["Destination"] == "/etc/aaa-muse-ai/config.yaml")
        require(config_mount["RW"] is False, "configuration mount is writable")
        code, headers, body = self.request(origin, "/api/v1/admin/status", self.admin)
        require(code == 200 and not any(name.lower().startswith("access-control-") for name in headers), "status or proxy boundary failed")
        status = json.loads(body)
        require(status["schema_version"] == 2 and status["ready"], "wrong status schema/readiness")
        require(status["build"]["revision"] == self.args.source_sha, "HTTP source identity mismatch")
        package_receipt = json.loads(Path(".artifacts/worker-package/latest.json").read_text())
        require(status["build"]["version"] == package_receipt["version"] and status["build"]["worker_package"]["version"] == package_receipt["version"] and status["build"]["worker_package"]["sha256"] == package_receipt["sha256"], "paired image metadata differs from the tested worker bytes")
        require("worker_package" not in status["configuration"], "worker release metadata remains operator configuration")
        self.assert_private(body.decode())
        denied = None
        for key in (None, "incorrect-test-key", self.client, self.portal):
            code, headers, _ = self.request(origin, "/api/v1/admin/status", key)
            require(code == 401, "non-management credential authorized admin access")
            if key == self.client:
                denied = headers["X-Request-Id"]
        code, _, body = self.request(origin, "/api/v1/admin/diagnostics/export?request_id=" + denied, self.admin)
        require(code == 200, "authenticated export failed")
        metadata, events = self.decode_export(body)
        require(metadata["complete"], "fresh capture unexpectedly incomplete")
        denial = [event for event in events if event["msg"] == "auth.denied"]
        require(len(denial) == 1 and denial[0]["observed_role"] == "client" and denial[0]["expected_role"] == "management", "logs alone do not identify credential-role denial")
        require(all(event["request_id"] == denied for event in events), "export mixed request identities")
        self.assert_private(json.dumps(events))
        self.private("diagnosis.json", json.dumps({"request_id": denied, "cause": "client credential cannot authorize management route", "corrective_action": "use management credential", "events": events}))
        self.receipt("auth.log_only_diagnosis", request_id=denied, diagnostic_events=len(events))
        for query in ("request_id=unknown-request", "operation_id=unknown-operation", "since=2000-01-01T00:00:00Z", "until=2099-01-01T00:00:00Z"):
            code, _, body = self.request(origin, "/api/v1/admin/diagnostics/export?" + query, self.admin)
            metadata, _ = self.decode_export(body)
            require(code == 200 and not metadata["complete"] and metadata["omissions"], "export hid missing identity or uncovered interval")
        require(self.request(origin, "/healthz", body=b"x" * (1024 * 1024 + 1))[0] == 413, "oversized body accepted")
        require(self.request(origin, "/healthz", body=b"unsupported")[0] == 400, "GET body accepted")
        require(self.request(origin, "/healthz", method="POST")[0] == 405, "unsupported method accepted")
        require(self.request(origin, "/api/v1/admin/diagnostics/export?unknown=1", self.admin)[0] == 400, "unknown filter accepted")
        self.sql("CREATE TABLE test_persistence (value TEXT); INSERT INTO test_persistence VALUES ('retained');")
        self.docker("stop", first)
        first, origin, _ = self.launch(diagnostic_volume=volume)
        self.ready(first, origin)
        require(self.sql("SELECT value FROM test_persistence;") == "retained", "container replacement lost persisted state")
        require(self.request(origin, "/api/v1/admin/status", self.admin)[0] == 200, "configured credential changed on replacement")
        with self.storage_fault("aaa_schema_migrations"):
            require(self.request(origin, "/healthz")[0] == 200, "database loss broke liveness")
            code, down_headers, _ = self.request(origin, "/readyz")
            require(code == 503, "database loss hidden from readiness")
            require(self.request(origin, "/api/v1/admin/diagnostics/export", self.admin)[0] == 200, "database loss disabled diagnostics")
        recovery_id = self.ready(first, origin)
        for request_id, expected_ready, expected_status in ((down_headers["X-Request-Id"], False, 503), (recovery_id, True, 200)):
            _, _, body = self.request(origin, "/api/v1/admin/diagnostics/export?request_id=" + request_id, self.admin)
            metadata, events = self.decode_export(body)
            changes = [event for event in events if event["msg"] == "readiness.changed"]
            probes = [event for event in events if event["msg"] == "db.probe"]
            outcomes = [event for event in events if event["msg"] == "request.completed"]
            require(metadata["complete"] and len(changes) == 1 and changes[0]["ready"] is expected_ready and changes[0]["previous_ready"] is not expected_ready, "logs do not explain readiness transition")
            require(changes[0]["schema_version"] == 2 and changes[0]["database_file"] == "broker.sqlite3" and bool(changes[0]["cause"]), "readiness evidence lacks expected state, target or cause")
            require(len(probes) == 1 and probes[0]["duration_ms"] >= 0 and len(outcomes) == 1 and outcomes[0]["status"] == expected_status, "readiness diagnosis lacks timing or final outcome")
            self.assert_private(json.dumps(events))
        with self.writer_lock():
            require(self.request(origin, "/readyz")[0] == 200, "WAL read probe waited for an unrelated writer")
            require(self.request(origin, "/api/v1/admin/requests?limit=1", self.admin)[0] == 200, "history could not read with an active writer")
            locked, locked_headers, _ = self.request(origin, "/api/v1/admin/enrollments", self.admin, method="POST")
            require(locked == 503, "write crossed its bounded SQLite writer wait")
        _, _, export = self.request(origin, "/api/v1/admin/diagnostics/export?request_id=" + locked_headers["X-Request-Id"], self.admin)
        metadata, warehouse = self.decode_export(export)
        cause = next(event for event in warehouse if event["msg"] == "worker.operation_failed")
        require(metadata["complete"] and cause["level"] == "ERROR" and cause["cause"] == "database_busy"
                and cause["sqlite_code"] == "5" and cause["phase"] == "begin" and cause["transaction_outcome"] == "not_started"
                and cause["duration_ms"] >= 1900, "lock timeout omitted causal evidence or its measured wait")
        self.assert_private(json.dumps(warehouse))
        self.receipt("storage.writer_timeout_read_snapshot", lock_code=5, concurrent_read=True,
                     corrective_action="release the SQLite writer before repeating the enrollment request")
        self.receipt("readiness.log_only_diagnosis", degradation_request=down_headers["X-Request-Id"], recovery_request=recovery_id, corrective_action="restore the SQLite schema ledger")
        require(self.sql("SELECT value FROM test_persistence;") == "retained", "SQLite fault or recovery changed persisted state")
        self.assert_private(self.logs(first))
        self.receipt("service.state_and_boundaries", schema_versions=2, database_recovery=True, readonly_config=True, http_ports=1)
        return first, origin, volume

    def generated_key(self):
        container, origin, _ = self.launch(self.configuration(generated=True))
        self.ready(container, origin)
        logs = self.logs(container)
        key_lines = [line for line in logs.splitlines() if line.startswith("MANAGEMENT_KEY=")]
        require(len(key_lines) == 1, "generated key not printed exactly once")
        key = key_lines[0].split("=", 1)[1]
        require(len(base64.urlsafe_b64decode(key + "=")) == 32 and logs.count(key) == 1, "generated key entropy/output contract failed")
        require(self.request(origin, "/api/v1/admin/status", key)[0] == 200, "generated key cannot authenticate")
        code, _, body = self.request(origin, "/api/v1/admin/diagnostics/export", key)
        require(code == 200, "generated-key export failed")
        _, events = self.decode_export(body)
        self.assert_private(json.dumps(events), (key,))
        self.docker("restart", container)
        origin = self.origin(container)
        self.ready(container, origin)
        keys = [line.split("=", 1)[1] for line in self.logs(container).splitlines() if line.startswith("MANAGEMENT_KEY=")]
        require(len(keys) == 2 and keys[0] != keys[1], "restart did not generate its own key once")
        require(self.request(origin, "/api/v1/admin/status", key)[0] == 401, "old generated key survived process restart")
        self.receipt("credentials.generated_and_restart", key_bits=256, once_per_process=True)

    def startup_failure(self, case, config=None, raw=None, expected="config.rejected", **launch_options):
        container, _, _ = self.launch(config=config, raw=raw, expect_startup=False, **launch_options)
        result = self.docker("wait", container, timeout=35)
        require(result.stdout.strip() == "1", "invalid startup did not fail closed")
        logs = self.logs(container)
        self.assert_private(logs)
        require("MANAGEMENT_KEY=" not in logs, "failed startup disclosed generated credential")
        events = [json.loads(line) for line in logs.splitlines() if line.startswith("{")]
        terminal = [event for event in events if event.get("msg") == expected]
        require(bool(terminal) and terminal[-1].get("operation_id"), "startup failure lacks correlated terminal evidence")
        require(terminal[-1].get("outcome") in ("stopped", "startup_stopped"), "startup failure lacks final outcome")
        if expected == "config.rejected":
            require(bool(terminal[-1].get("field")) and bool(terminal[-1].get("reason")), "configuration diagnosis lacks safe field or reason")
            require(terminal[-1].get("line", 0) > 0 and terminal[-1].get("column", 0) > 0, "configuration diagnosis lacks original source location")
        self.receipt(case, event=expected)
        return terminal[-1], events

    def adverse(self):
        config = self.configuration()
        result, _ = self.startup_failure("config.invalid_yaml", raw="control-portal:\n  password: " + self.portal + "\nbroken: [")
        require(result["reason"] == "invalid_yaml", "malformed YAML cause was lost")
        result, _ = self.startup_failure("config.unresolved_environment", raw=json.dumps(config).replace(self.portal, "${ABSENT_PORTAL}"))
        require(result["field"] == "control-portal.password" and result["reason"] == "unresolved_environment_reference", "unresolved-reference diagnosis does not identify field and cause")
        unknown = self.configuration()
        unknown["unsupported"] = self.portal
        result, _ = self.startup_failure("config.unknown_field", config=unknown)
        require(result["field"] == "<unknown>" and result["reason"] == "unknown_field", "unknown field not safely identified")
        result, _ = self.startup_failure("config.duplicate_field", raw=json.dumps(config)[:-1] + ',"management":{"key":"unused-fixture"}}')
        require(result["field"] == "management" and result["reason"] == "duplicate_field", "duplicate field not identified")
        self.startup_failure("config.multiple_documents", raw=json.dumps(config) + "\n---\n{}")
        reused = self.configuration()
        reused["control-portal"]["password"] = self.admin
        self.startup_failure("config.reused_authority", config=reused)
        missing = self.configuration()
        missing["control-portal"]["password"] = ""
        self.startup_failure("config.portal_required", config=missing)
        whitespace = self.configuration()
        whitespace["management"]["key"] = "admin unusable fixture"
        result, _ = self.startup_failure("config.unusable_management_key", config=whitespace)
        require(result["field"] == "management.key" and result["reason"] == "bearer_key_contains_whitespace", "unusable management key was not rejected safely")
        for name, byte in (("nul", "\x00"), ("del", "\x7f")):
            invalid = self.configuration()
            invalid["management"]["key"] = "admin" + byte + "key"
            result, _ = self.startup_failure("config.http_control_" + name, config=invalid)
            require(result["field"] == "management.key" and result["reason"] == "bearer_key_contains_control_bytes", "HTTP-invalid control byte lacks safe startup rejection")
        inaccessible = self.configuration()
        inaccessible["diagnostics"]["directory"] = "/root/inaccessible"
        result, _ = self.startup_failure("capture.permissions", config=inaccessible, expected="diagnostics.capture_failed")
        require(result["cause"] == "filesystem_permission_denied", "capture failure lacks corrective cause")
        old = json.dumps(config)[:-1] + ',"database":{"url":"postgres://old:obsolete-fixture@db/broker","password":"${ABSENT_OLD_DB}"}}'
        result, events = self.startup_failure("config.legacy_database", raw=old)
        require(result["field"] == "database" and result["reason"] == "legacy_database_configuration_remove_section", "legacy database configuration lacked removal guidance")
        self.assert_private(json.dumps(events), ("obsolete-fixture",))
        result, events = self.startup_failure("database.unwritable_directory", expected="db.connect_failed", state_readonly=True)
        require(result["cause"] == "database_file_unavailable" and result["attempt"] == 1 and result["phase"] == "open", "unwritable SQLite directory lacked actionable diagnosis")
        require(not any(event["msg"] == "db.retry_scheduled" for event in events), "unwritable directory was retried")
        with self.writer_lock():
            container, origin, volume = self.launch()
            end = time.monotonic() + 7
            while "db.retry_scheduled" not in self.logs(container) and time.monotonic() < end:
                time.sleep(0.1)
            require("db.retry_scheduled" in self.logs(container), "startup writer contention did not log its bounded retry")
        request = self.ready(container, origin)
        public = [json.loads(line) for line in self.logs(container).splitlines() if line.startswith("{")]
        retry = next(event for event in public if event["msg"] == "db.retry_scheduled")
        require(retry["level"] == "WARN" and retry["cause"] == "database_busy" and retry["phase"] == "begin" and retry["sqlite_code"] == "5", "writer retry omitted SQLite cause")
        _, _, body = self.request(origin, "/api/v1/admin/diagnostics/export?operation_id=" + retry["operation_id"], self.admin)
        metadata, events = self.decode_export(body)
        require(metadata["complete"] and any(event["msg"] == "db.exchange_failed" and event["transaction_outcome"] == "not_started" for event in events)
                and any(event["msg"] == "db.connected" for event in events), "protected startup trace did not explain lock release and retry")
        self.assert_private(json.dumps(events))
        self.receipt("database.lock_retry", readiness_request=request, corrective_action="release the SQLite writer and retry startup")

    def capture_completeness(self):
        config = self.configuration()
        config["client-keys"].update({"long-fixture-client-name-" + str(i): "test-client-extra-" + str(i) for i in range(180)})
        container, origin, _ = self.launch(config)
        self.ready(container, origin)
        code, headers, status = self.request(origin, "/api/v1/admin/status", self.admin)
        require(code == 200 and len(status) > 6144, "large response fixture was not exercised")
        code, _, body = self.request(origin, "/api/v1/admin/diagnostics/export?request_id=" + headers["X-Request-Id"], self.admin)
        require(code == 200, "large response export failed")
        metadata, events = self.decode_export(body)
        exchanges = [event for event in events if event["msg"] == "request.exchange"]
        require(metadata["complete"] and len(exchanges) == 1 and exchanges[0]["response"].encode() == status, "chunk reconstruction omitted or changed admitted output")
        self.assert_private(json.dumps(events))
        small = self.configuration()
        small["diagnostics"]["max-bytes"] = 6144
        retained, retained_origin, _ = self.launch(small)
        self.ready(retained, retained_origin)
        for _ in range(12):
            self.request(retained_origin, "/api/v1/admin/status", self.admin)
        _, _, body = self.request(retained_origin, "/api/v1/admin/diagnostics/export", self.admin)
        metadata, _ = self.decode_export(body)
        require(not metadata["complete"] and metadata["omissions"], "capacity eviction was reported as complete")
        self.receipt("capture.reconstruction_and_retention", exact_output_bytes=len(status), max_chunk_bytes=6144, omissions_reported=True)

    def migration_rejection(self):
        self.sql("UPDATE aaa_schema_migrations SET checksum='deliberately-invalid-test-checksum' WHERE version=1;")
        result, _ = self.startup_failure("migration.checksum_rejected", expected="db.migration_failed")
        require(result["cause"] == "migration_checksum_mismatch" and len(result["expected"]) == 64 and result["observed"] == "deliberately-invalid-test-checksum", "migration diagnosis lacks expected/observed checksum")
        checksum = hashlib.sha256(Path("internal/sqlite/migrations/001_schema.sql").read_bytes()).hexdigest()
        self.sql("UPDATE aaa_schema_migrations SET checksum='" + checksum + "' WHERE version=1; UPDATE aaa_schema_migrations SET version=3 WHERE version=2;")
        result, _ = self.startup_failure("migration.newer_schema_rejected", expected="db.migration_failed")
        require(result["cause"] == "schema_version_incompatible" and result["expected"] == "2" and result["observed"] == "3" and result["attempt"] == 1, "migration version diagnosis is incomplete or retried")
        require(self.sql("SELECT value FROM test_persistence;") == "retained", "rejected migration removed existing data")

    def capture_failure_stops(self, container, origin):
        self.docker("exec", container, "chmod", "0500", "/var/lib/aaa-muse-ai/diagnostics")
        try:
            self.request(origin, "/healthz")
        except (OSError, urllib.error.URLError):
            pass
        require(self.docker("wait", container, timeout=15).stdout.strip() == "1", "capture failure left service operating")
        logs = self.logs(container)
        self.assert_private(logs)
        require('"msg":"diagnostics.capture_failed"' in logs and "filesystem_permission_denied" in logs, "capture failure not diagnosable from logs")
        self.receipt("capture.runtime_failure_stops_service", corrective_action="restore diagnostic-volume write permission and restart")

    def cleanup(self):
        failures = []
        for kind in ("containers", "networks", "volumes"):
            for identity in reversed(self.resources[kind]):
                command = ("inspect", identity) if kind == "containers" else (kind[:-1], "inspect", identity)
                result = self.docker(*command, success=False)
                if result.returncode:
                    failures.append({"kind": kind, "identity": identity, "cause": "ownership_unverified"})
                    continue
                info = json.loads(result.stdout)[0]
                labels = info["Config"].get("Labels", {}) if kind == "containers" else info.get("Labels", {})
                if labels.get(LABEL) != self.owner:
                    failures.append({"kind": kind, "identity": identity, "cause": "owner_mismatch"})
                    continue
                if kind == "containers":
                    if info["State"]["Running"]:
                        self.docker("stop", "--time", "5", identity)
                    self.logs(identity)
                    self.docker("rm", identity)
                else:
                    self.docker(kind[:-1], "rm", identity)
        receipt = {"owner": self.owner, "removed": self.resources, "failures": failures}
        self.private("cleanup.json", json.dumps(receipt))
        require(not failures, "test resource cleanup could not be verified")
        print(json.dumps({"case": "cleanup", "outcome": "passed", "containers": len(self.resources["containers"]), "volumes": len(self.resources["volumes"]), "networks": len(self.resources["networks"])}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--suite", choices=("service", "image"), required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    harness = Harness(args)
    try:
        harness.baseline()
        if args.suite == "image":
            from compose_smoke import smoke_compose
            smoke_compose(harness)
        harness.setup()
        service, origin, _ = harness.functional()
        harness.generated_key()
        harness.adverse()
        harness.capture_completeness()
        harness.migration_rejection()
        harness.capture_failure_stops(service, origin)
        harness.private("results.json", json.dumps({"suite": args.suite, "source_sha": args.source_sha, "receipts": harness.receipts}))
    finally:
        harness.cleanup()


if __name__ == "__main__":
    main()
