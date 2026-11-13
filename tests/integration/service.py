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

POSTGRES = "postgres:18.6-alpine@sha256:123b17998ccaf47e53b502e8c6a1e79afd8f579c6f3eec83c563da026f957395"
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
        self.database_password = "test-database-" + secrets.token_hex(24)
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
        volume = self.volume("database")
        env = self.private("postgres.env", "POSTGRES_DB=aaa_muse\nPOSTGRES_PASSWORD=" + self.database_password + "\n")
        self.db = self.remember("containers", self.docker("run", "-d", "--label", LABEL + "=" + self.owner,
                                 "--network", self.network, "--network-alias", "db", "--env-file", str(env),
                                 "-v", volume + ":/var/lib/postgresql", POSTGRES).stdout.strip())
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.docker("exec", self.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "aaa_muse", success=False).returncode == 0:
                return
            time.sleep(0.2)
        raise RuntimeError("PostgreSQL did not become ready")

    def configuration(self, generated=False):
        return {"server": {"listen": "0.0.0.0:8080", "public-url": "https://muse.example.test"},
                "database": {"url": "postgres://postgres:" + self.database_password + "@db:5432/aaa_muse?sslmode=disable"},
                "management": {"key": "" if generated else self.admin},
                "control-portal": {"password": self.portal},
                "client-keys": {"fixture-client": self.client},
                "diagnostics": {"level": "info", "directory": "/var/lib/aaa-muse-ai/diagnostics"}}

    def launch(self, config=None, raw=None, diagnostic_volume=None, expect_startup=True, port_binding="127.0.0.1::8080"):
        index = len(self.resources["containers"])
        path = self.private("config-" + str(index) + ".yaml", raw if raw is not None else json.dumps(config or self.configuration()))
        # The bind source is inside a private directory; the container needs read access to its mounted file.
        path.chmod(0o644)
        volume = diagnostic_volume or self.volume("diagnostics-" + str(index))
        identity = self.remember("containers", self.docker("run", "-d", "--label", LABEL + "=" + self.owner,
                                  "--network", self.network, "-p", port_binding,
                                  "--mount", "type=bind,source=" + str(path) + ",target=/etc/aaa-muse-ai/config.yaml,readonly",
                                  "-v", volume + ":/var/lib/aaa-muse-ai/diagnostics", self.args.image).stdout.strip())
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

    def sql(self, sql):
        return self.docker("exec", "-i", self.db, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "aaa_muse", "-At", input_text=sql).stdout.strip()

    @contextmanager
    def migration_table_lock(self):
        process = subprocess.Popen(["docker", "exec", "-i", self.db, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "aaa_muse"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write("BEGIN; LOCK TABLE aaa_schema_migrations IN ACCESS EXCLUSIVE MODE;\n\\echo LOCKED\n")
            process.stdin.flush()
            readable, _, _ = select.select([process.stdout], [], [], 5)
            require(bool(readable) and process.stdout.readline().strip() == "LOCKED", "migration barrier did not acquire its table lock")
            yield
        finally:
            try:
                process.communicate("ROLLBACK;\n", timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise RuntimeError("migration barrier session did not stop")
            require(process.returncode == 0, "migration barrier did not release cleanly")

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
        for secret in (self.admin, self.portal, self.client, self.database_password, *extra):
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
        first, origin, volume = self.launch()
        self.ready(first, origin)
        with self.migration_table_lock():
            second, second_origin, _ = self.launch()
            self.docker("restart", first)
            origin = self.origin(first)
            deadline = time.monotonic() + 8
            waiters = 0
            while time.monotonic() < deadline:
                waiters = int(self.sql("SELECT count(*) FROM pg_stat_activity WHERE datname='aaa_muse' AND application_name <> 'psql' AND wait_event_type='Lock';"))
                if waiters >= 2:
                    break
                time.sleep(0.05)
            require(waiters >= 2, "two service bootstraps did not overlap at the real migration barrier")
        self.ready(first, origin)
        self.ready(second, second_origin)
        require(self.sql("SELECT count(*) FROM aaa_schema_migrations;") == "5", "concurrent migration duplicated schema versions")
        self.receipt("migration.concurrent_bootstrap", blocked_instances=waiters, schema_versions=5)
        info = self.inspect(first)
        config_mount = next(mount for mount in info["Mounts"] if mount["Destination"] == "/etc/aaa-muse-ai/config.yaml")
        require(config_mount["RW"] is False, "configuration mount is writable")
        code, headers, body = self.request(origin, "/api/v1/admin/status", self.admin)
        require(code == 200 and not any(name.lower().startswith("access-control-") for name in headers), "status or proxy boundary failed")
        status = json.loads(body)
        require(status["schema_version"] == 5 and status["ready"], "wrong status schema/readiness")
        require(status["build"]["revision"] == self.args.source_sha, "HTTP source identity mismatch")
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
        self.docker("restart", first)
        origin = self.origin(first)
        self.ready(first, origin)
        require(self.sql("SELECT value FROM test_persistence;") == "retained", "service restart lost deployment state")
        require(self.request(origin, "/api/v1/admin/status", self.admin)[0] == 200, "configured credential changed on restart")
        self.docker("stop", self.db)
        require(self.request(origin, "/healthz")[0] == 200, "database loss broke liveness")
        code, down_headers, _ = self.request(origin, "/readyz")
        require(code == 503, "database loss hidden from readiness")
        require(self.request(origin, "/api/v1/admin/diagnostics/export", self.admin)[0] == 200, "database loss disabled diagnostics")
        self.docker("start", self.db)
        recovery_id = self.ready(first, origin)
        for request_id, expected_ready, expected_status in ((down_headers["X-Request-Id"], False, 503), (recovery_id, True, 200)):
            _, _, body = self.request(origin, "/api/v1/admin/diagnostics/export?request_id=" + request_id, self.admin)
            metadata, events = self.decode_export(body)
            changes = [event for event in events if event["msg"] == "readiness.changed"]
            probes = [event for event in events if event["msg"] == "db.probe"]
            outcomes = [event for event in events if event["msg"] == "request.completed"]
            require(metadata["complete"] and len(changes) == 1 and changes[0]["ready"] is expected_ready and changes[0]["previous_ready"] is not expected_ready, "logs do not explain readiness transition")
            require(changes[0]["schema_version"] == 5 and changes[0]["database_host"] == "db:5432" and bool(changes[0]["cause"]), "readiness evidence lacks expected state, target or cause")
            require(len(probes) == 1 and probes[0]["duration_ms"] >= 0 and len(outcomes) == 1 and outcomes[0]["status"] == expected_status, "readiness diagnosis lacks timing or final outcome")
            self.assert_private(json.dumps(events))
        self.receipt("readiness.log_only_diagnosis", degradation_request=down_headers["X-Request-Id"], recovery_request=recovery_id, corrective_action="restore PostgreSQL availability")
        require(self.sql("SELECT value FROM test_persistence;") == "retained", "database restart lost persisted state")
        self.assert_private(self.logs(first))
        self.receipt("service.state_and_boundaries", schema_versions=5, database_recovery=True, readonly_config=True, http_ports=1)
        return first, origin, volume

    def migration_upgrade(self):
        for old_version in (1, 2, 3, 4):
            database = "aaa_muse_legacy_" + str(old_version)
            self.sql("CREATE DATABASE " + database + ";")
            scripts = [Path("internal/postgres/migrations/001_initial.sql"), Path("internal/postgres/migrations/002_worker_identities.sql"), Path("internal/postgres/migrations/003_inference.sql"), Path("internal/postgres/migrations/004_canonical_history.sql")]
            checksums = [hashlib.sha256(path.read_bytes()).hexdigest() for path in scripts]
            fixture = ""
            for i in range(old_version):
                fixture += scripts[i].read_text() + "INSERT INTO aaa_schema_migrations(version, checksum) VALUES (" + str(i + 1) + ", '" + checksums[i] + "');"
            fixture += "CREATE TABLE upgrade_marker(value TEXT); INSERT INTO upgrade_marker VALUES ('preserved');"
            worker_id, revoked_id = secrets.token_hex(16), secrets.token_hex(16)
            credential, revoked_key = "muse_worker_" + secrets.token_urlsafe(32), "muse_worker_" + secrets.token_urlsafe(32)
            credential_hash = hashlib.sha256(credential.encode()).hexdigest()
            if old_version >= 2:
                fixture += "INSERT INTO aaa_workers(id,name,credential_hash,registered_at,revoked_at) VALUES ('" + worker_id + "','preserved worker',decode('" + credential_hash + "','hex'),CURRENT_TIMESTAMP,NULL),('" + revoked_id + "','revoked worker',decode('" + hashlib.sha256(revoked_key.encode()).hexdigest() + "','hex'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);"
            if old_version >= 3:
                legacy_id, conversation_id = secrets.token_hex(16), secrets.token_hex(16)
                legacy = {"id": legacy_id, "conversation_id": conversation_id, "worker_id": worker_id, "state": "completed", "current_job_id": "", "created_at": "2026-11-10T00:00:00Z", "deadline_at": "2026-11-10T00:05:00Z", "tools": [], "messages": None, "final_text": "legacy\n", "remote_outcome": "decision_observed"}
                item = {"type": "message", "role": "assistant", "text": "legacy\n"}
                fixture += "INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,data) VALUES ('" + legacy_id + "','" + worker_id + "','completed','2026-11-10T00:05:00Z','" + json.dumps(legacy).replace("'", "''") + "');"
                fixture += "INSERT INTO aaa_inference_history(experiment_id,sequence,data) VALUES ('" + legacy_id + "',0,'" + json.dumps(item).replace("'", "''") + "');"
            if old_version == 4:
                native_id, native_conversation, job_id = secrets.token_hex(16), secrets.token_hex(16), secrets.token_hex(16)
                timestamp = "2026-11-11T00:00:00Z"
                item = {"type": "message", "role": "user", "text": "preserved canonical input\r\n"}
                tool = {"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}
                call = {"type": "tool_call", "call_id": "retained-call", "name": "read_file", "arguments": {"path": "client-only"}}
                result = {"type": "tool_result", "call_id": "retained-call", "output": "preserved output\r\n"}
                messages = [item, call, result]
                canonical = messages + [{"type": "message", "role": "assistant", "text": result["output"]}]
                context = {"receipt_id": job_id, "kind": "full", "base_prefix": 0, "history_count": len(messages), "canonical_sha256": hashlib.sha256(json.dumps({"messages": messages, "tools": [tool]}, separators=(",", ":")).encode()).hexdigest(), "messages": messages, "tools": [tool]}
                job = {"protocol_version": 1, "id": job_id, "experiment_id": native_id, "conversation_id": native_conversation, "worker_id": worker_id, "state": "accepted", "created_at": timestamp, "deadline_at": "2026-11-11T00:05:00Z", "claimed_at": timestamp, "lease_expires_at": "2026-11-11T00:00:30Z", "generation": 7, "lease_id": secrets.token_hex(16), "held": False, "connection_id": secrets.token_hex(16), "connection_generation": 2, "context": {key: value for key, value in context.items() if key not in ("messages", "tools")}}
                native = {"id": native_id, "conversation_id": native_conversation, "worker_id": worker_id, "state": "completed", "current_job_id": job_id, "created_at": timestamp, "deadline_at": job["deadline_at"], "tools": [tool], "messages": None, "final_text": result["output"], "remote_outcome": "decision_observed"}
                request = {"id": native_id, "conversation_id": native_conversation, "client_id": "fixture-client", "session_id": "retained-session", "worker_id": worker_id, "response_id": "resp_retained", "created_at": timestamp, "state": "completed", "replay_hash": "retained", "input": {"protocol_version": 1, "submission_id": "retained", "worker_id": worker_id, "messages": messages, "tools": [tool]}, "canonical_end": len(canonical), "input_count": len(messages), "output": {"type": "final", "text": result["output"]}}
                conversation = {"id": native_conversation, "client_id": "fixture-client", "session_id": "retained-session", "worker_id": worker_id, "created_at": timestamp, "current_request_id": native_id, "pending_call_id": "", "item_count": len(canonical), "event_count": 0}
                histories = [{"id": secrets.token_hex(16), "sequence": index, "request_id": native_id, "source": "client_provided" if index < len(messages) else "server_observed", "time": timestamp, "item": value} for index, value in enumerate(canonical)]
                encode = lambda value: json.dumps(value).replace("'", "''")
                fixture += "INSERT INTO aaa_experiments VALUES ('" + native_id + "','" + worker_id + "','completed','" + timestamp + "','" + encode(native) + "');"
                fixture += "INSERT INTO aaa_conversations VALUES ('" + native_conversation + "','fixture-client','retained-session','" + worker_id + "','" + timestamp + "','','" + encode(conversation) + "');"
                fixture += "INSERT INTO aaa_model_requests VALUES ('" + native_id + "','" + native_conversation + "','fixture-client','resp_retained','" + timestamp + "','retained','" + encode(request) + "');"
                for history in histories:
                    fixture += "INSERT INTO aaa_conversation_items VALUES ('" + native_conversation + "'," + str(history["sequence"]) + ",'" + history["id"] + "','" + native_id + "','" + encode(history) + "');"
                fixture += "INSERT INTO aaa_inference_jobs VALUES ('" + job_id + "','" + worker_id + "','" + native_id + "','accepted',false,'" + encode(job) + "','" + encode(context) + "');"

            self.docker("exec", "-i", self.db, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, input_text=fixture)
            config = self.configuration()
            config["database"]["url"] = config["database"]["url"].replace("/aaa_muse?", "/" + database + "?")
            container, origin, _ = self.launch(config)
            self.ready(container, origin)
            _, _, body = self.request(origin, "/api/v1/admin/status", self.admin)
            require(json.loads(body)["schema_version"] == 5, "legacy database did not upgrade")
            state = self.docker("exec", self.db, "psql", "-X", "-U", "postgres", "-d", database, "-Atc", "SELECT value FROM upgrade_marker; SELECT checksum FROM aaa_schema_migrations WHERE version=1; SELECT count(*) FROM aaa_schema_migrations;").stdout.splitlines()
            require(state == ["preserved", checksums[0], "5"], "upgrade changed old data/checksum or duplicated migrations")
            if old_version >= 3:
                status, _, body = self.request(origin, "/api/v1/admin/requests/" + legacy_id, self.admin)
                observed = json.loads(body)
                require(status == 200 and observed["kind"] == "legacy" and observed["provenance"] == "unavailable" and observed["history"] == [{"type": "message", "role": "assistant", "text": "legacy\n"}], "schema-3 history/provenance changed during upgrade")
            if old_version == 4:
                status, _, body = self.request(origin, "/api/v1/admin/requests/" + native_id, self.admin)
                observed = json.loads(body)
                require(status == 200 and observed["request"]["input"] == request["input"] and observed["request"]["output"] == request["output"], "schema-4 request snapshot changed")
                require(observed["assignment"] == job and observed["delivery"] == context, "schema-4 assignment or delivered context changed")
                retained = self.docker("exec", self.db, "psql", "-X", "-U", "postgres", "-d", database, "-Atc", "SELECT data FROM aaa_conversation_items WHERE conversation_id='" + native_conversation + "' ORDER BY sequence; SELECT checksum FROM aaa_schema_migrations WHERE version=4; SELECT context::text FROM aaa_inference_jobs WHERE id='" + job_id + "';").stdout.splitlines()
                require([json.loads(value) for value in retained[:len(histories)]] == histories and retained[len(histories)] == checksums[3], "schema-4 canonical history or checksum changed")
                require(retained[-1].encode() == json.dumps(context).encode(), "schema-4 delivered context bytes changed")

            if old_version >= 2:
                status, _, body = self.request(origin, "/api/v1/worker/status", credential)
                require(status == 200 and json.loads(body)["id"] == worker_id, "v2 scoped identity lost during upgrade")
                require(self.request(origin, "/api/v1/worker/status", revoked_key)[0] == 401, "upgrade restored revoked authority")
                retained = self.docker("exec", self.db, "psql", "-X", "-U", "postgres", "-d", database, "-Atc", "SELECT checksum FROM aaa_schema_migrations WHERE version=2; SELECT encode(credential_hash,'hex') FROM aaa_workers WHERE id='" + worker_id + "';").stdout.splitlines()
                require(retained == [checksums[1], credential_hash], "v2 checksum or worker credential changed")
            self.receipt("migration.v" + str(old_version) + "_upgrade", preserved_checksum=checksums[old_version - 1], schema_version=5)

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

    def startup_failure(self, case, config=None, raw=None, expected="config.rejected"):
        container, _, _ = self.launch(config=config, raw=raw, expect_startup=False)
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
        invalid_options = self.configuration()
        invalid_options["database"]["url"] = invalid_options["database"]["url"].replace("sslmode=disable", "sslmode=invalid")
        result, events = self.startup_failure("database.invalid_options", config=invalid_options, expected="db.connect_failed")
        require(result["cause"] == "database_configuration_invalid" and result["attempt"] == 1, "invalid database options lack a safe immediate diagnosis")
        require(not any(event["msg"] == "db.retry_scheduled" for event in events), "invalid database options were retried")
        unavailable = self.configuration()
        unavailable["database"]["url"] = unavailable["database"]["url"].replace("@db:", "@missing-db:")
        result, events = self.startup_failure("database.unavailable", config=unavailable, expected="db.connect_failed")
        retries = [event for event in events if event["msg"] == "db.retry_scheduled"]
        require(result["attempt"] == 3 and result["cause"] == "database_unavailable", "database startup attempts/cause are not diagnosable")
        require(result["database_host"] == "missing-db:5432" and result["database_name"] == "/aaa_muse" and result["duration_ms"] >= 0, "database diagnosis lacks target or timing")
        require([event["attempt"] for event in retries] == [1, 2] and [event["delay_ms"] for event in retries] == [1000, 2000], "database retry evidence incomplete")
        require(all(event["operation_id"] == result["operation_id"] for event in retries), "startup retry correlation lost")

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
        self.sql("UPDATE aaa_schema_migrations SET checksum='deliberately-invalid-test-checksum' WHERE version=2;")
        result, _ = self.startup_failure("migration.checksum_rejected", expected="db.migration_failed")
        require(result["cause"] == "migration_checksum_mismatch" and len(result["expected"]) == 64 and result["observed"] == "deliberately-invalid-test-checksum", "migration diagnosis lacks expected/observed checksum")
        checksum = hashlib.sha256(Path("internal/postgres/migrations/002_worker_identities.sql").read_bytes()).hexdigest()
        self.sql("UPDATE aaa_schema_migrations SET checksum='" + checksum + "' WHERE version=2; UPDATE aaa_schema_migrations SET version=6 WHERE version=5;")
        result, _ = self.startup_failure("migration.newer_schema_rejected", expected="db.migration_failed")
        require(result["cause"] == "schema_version_incompatible" and result["expected"] == "5" and result["observed"] == "6" and result["attempt"] == 1, "migration version diagnosis is incomplete or retried")
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
        harness.setup()
        harness.migration_upgrade()
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
