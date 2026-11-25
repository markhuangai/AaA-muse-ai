"""Exercise the shipped Compose storage layout on an isolated Docker project."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess

from service import DIAGNOSTICS, LABEL, SQLITE_STATE, require


CONFIG = "/etc/aaa-muse-ai"
MEDIA = "/var/lib/aaa-muse-ai/media"
STATE_BIND = "sqlite"
MEDIA_BIND = "media"
BASE = Path("compose.yaml").resolve()
NAMED = Path("compose.named-volumes.yaml").resolve()

TEST_OVERRIDE = """services:
  service:
    image: ${MUSE_TEST_IMAGE}
    restart: "no"
    ports: !override ["127.0.0.1:0:8080"]
"""

LEGACY = """services:
  service:
    image: ${MUSE_TEST_IMAGE}
    ports: ["127.0.0.1:0:8080"]
    volumes:
      - ./config:/etc/aaa-muse-ai
      - sqlite:/var/lib/aaa-muse-ai/state
      - diagnostics:/var/lib/aaa-muse-ai/diagnostics
      - media:/var/lib/aaa-muse-ai/media
volumes:
  sqlite:
  diagnostics:
  media:
"""


class ComposeProject:
    def __init__(self, harness, label):
        self.h = harness
        self.name = harness.owner + "-" + label
        self.dir = harness.root.resolve() / label
        self.dir.mkdir()
        (self.dir / "config").mkdir(mode=0o700)
        self.config = self.dir / "config" / "config.yaml"
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("COMPOSE_", "MUSE_"))
        }
        self.env.update(MUSE_TEST_IMAGE=harness.args.image)
        override = self.dir / "test-override.yaml"
        override.write_text(TEST_OVERRIDE)
        self.files = (BASE, override)
        self.cleanup_files = self.files

    def compose(self, *args, files=None, overrides=None, success=True):
        command = ["docker", "compose", "--env-file", "/dev/null", "--project-directory", str(self.dir), "-p", self.name]
        for path in self.files if files is None else files:
            command.extend(("-f", str(path)))
        env = self.env | (overrides or {})
        result = subprocess.run(command + list(args), env=env, capture_output=True, text=True, timeout=75)
        if success != (result.returncode == 0):
            self.h.assert_private(result.stdout + result.stderr)
            self.h.private(self.dir.name + "-compose-error.txt", result.stdout + result.stderr)
            raise AssertionError("Compose result differed for " + " ".join(args))
        return result

    def running_service(self, files=None):
        identity = self.compose("ps", "--quiet", "service", files=files).stdout.strip()
        require(identity, "Compose service is missing")
        settings = self.h.inspect(identity)["NetworkSettings"]
        if os.environ.get("MUSE_TEST_DIRECT_NETWORK") == "true":
            network = settings["Networks"][self.name + "_default"]
            origin = "http://" + network["IPAddress"] + ":8080"
        else:
            origin = "http://127.0.0.1:" + settings["Ports"]["8080/tcp"][0]["HostPort"]
        self.h.ready(identity, origin)
        return identity, origin

    def logs(self, event, reason=None, files=None):
        result = self.compose("logs", "--no-log-prefix", "service", files=files)
        output = result.stdout + result.stderr
        self.h.assert_private(output)
        records = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
        matches = [e for e in records if e.get("msg") == event and (reason is None or e.get("reason") == reason)]
        require(matches, "expected startup event is absent from Compose logs: " + str((event, reason)))
        result = matches[-1]
        require(result["revision"] == self.h.args.source_sha and result.get("operation_id"), "startup diagnosis lacks provenance")
        return result

    def unused(self):
        label = "label=com.docker.compose.project=" + self.name
        return not any(self.h.docker(*command, "--filter", label).stdout.strip() for command in (
            ("ps", "-aq"), ("network", "ls", "-q"), ("volume", "ls", "-q"),
        ))


@contextmanager
def project(h, label):
    p = ComposeProject(h, label)
    require(p.unused(), "fixture Compose project already exists")
    try:
        yield p
    finally:
        p.compose("down", "--volumes", "--remove-orphans", files=p.cleanup_files)
        require(p.unused(), "fixture Compose resources remain")
        h.receipt("compose.cleanup", project=label)


def json_request(h, origin, route, key=None, data=None, headers=None):
    return h.request(origin, route, key, "POST", None if data is None else json.dumps(data).encode(),
                     {"Content-Type": "application/json", **(headers or {})})


def config_read_failures(h, config):
    private_selector = "path-canary-" + secrets.token_hex(12)
    directory = config.parent.parent / "not-a-file"
    directory.mkdir()
    directory.chmod(0o755)
    for name, target, reason, arguments, selector in (
        ("yml", CONFIG + "/config.yml", "not_found", (), CONFIG + "/config.yaml"),
        ("denied", "/" + private_selector, "permission_denied", ("-config", "/" + private_selector), "custom"),
        ("directory", CONFIG + "/config.yaml", "is_directory", (), CONFIG + "/config.yaml"),
    ):
        source = directory if name == "directory" else config
        uid = 10001 if os.getuid() != 10001 else 10002
        identity = h.remember("containers", h.docker(
            "create", "--label", LABEL + "=" + h.owner, "--user", f"{uid}:10001", "--mount",
            f"type=bind,source={source},target={target},readonly", h.args.image, *arguments).stdout.strip())
        result = h.docker("start", "--attach", identity, success=False, timeout=15)
        output = result.stdout + result.stderr
        h.assert_private(output, (private_selector,))
        require(result.returncode == 1, "config read did not stop in the broker")
        event = json.loads(output)
        require(event["msg"] == "config.rejected" and event["reason"] == "read_failed" and event["read_cause"] == reason
                and event["config_path"] == selector and event["level"] == "ERROR" and event["operation_id"]
                and event["revision"] == h.args.source_sha, "config read failure is not diagnosable")
        h.receipt("compose.direct_config_" + name, reason=reason)


def check_compose_defaults(p):
    spec = json.loads(p.compose("config", "--format", "json", files=(BASE,)).stdout)
    require(set(spec["services"]) == {"service"}, "Compose must contain one service")
    broker = spec["services"]["service"]
    require(broker["image"] == "ghcr.io/markhuangai/aaa-muse-ai:latest" and broker["command"] == ["serve"]
            and broker["user"] == "0:0" and not broker.get("depends_on"), "unexpected startup invocation")
    require(set(broker["cap_drop"]) == {"ALL"} and set(broker["cap_add"]) ==
            {"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"}
            and broker["security_opt"] == ["no-new-privileges:true"], "Compose bootstrap has the wrong capabilities")
    ports = [(port.get("host_ip"), str(port["published"]), port["target"]) for port in broker["ports"]]
    require(ports == [(None, "8080", 8080)] and not broker.get("environment"), "unexpected default ports or environment")
    sources = {CONFIG: "config", SQLITE_STATE: STATE_BIND, MEDIA: MEDIA_BIND}
    binds = [m for m in broker["volumes"] if m["type"] == "bind"]
    require({m["target"]: m["source"] for m in binds} == {t: str(p.dir / source) for t, source in sources.items()}
            and all(m.get("bind", {}).get("create_host_path", True) for m in binds), "Compose must create missing host bind sources")
    require("diagnostics" in spec["volumes"] and
            any(m["type"] == "volume" and m["source"] == "diagnostics" and m["target"] == DIAGNOSTICS
                for m in broker["volumes"]), "Compose lost the diagnostics volume")


def rejected_start(p, reason, files=None):
    p.compose("up", "-d", "--force-recreate", "service", files=files)
    identity = p.compose("ps", "--all", "--quiet", "service", files=files).stdout.strip()
    require(identity and p.h.docker("wait", identity, timeout=15).stdout.strip() == "1",
            "mount failure did not stop the broker")
    require('"msg":"db.connected"' not in p.h.logs(identity), "broker opened SQLite after a mount failure")
    record = p.logs("mounts.prepare_failed", reason, files=files)
    require(record["level"] == "ERROR" and record["outcome"] == "stopped" and record.get("corrective_action")
            and record.get("cause") == reason and "expected" in record and "observed" in record,
            "mount rejection lacks a diagnostic cause or corrective action")
    return record


def missing_config(h):
    with project(h, "missing") as p:
        p.config.parent.rmdir()
        check_compose_defaults(p)
        record = rejected_start(p, "not_found")
        require(record["stage"] == "open_config" and record["target"] == CONFIG + "/config.yaml",
                "missing YAML diagnosis must identify the required path")
        for name in ("config", STATE_BIND, MEDIA_BIND):
            require(stat.S_IMODE((p.dir / name).stat().st_mode) == 0o700, "empty source was not created privately")
        stopped = p.compose("ps", "--all", "--quiet", "service").stdout.strip()
        h.run_tools("sh", "-ec", 'test ! -e "$1/config.yaml" && test ! -e "$2/broker.sqlite3" && test "$(stat -c %a "$3")" = 700',
                    "fixture", CONFIG, SQLITE_STATE, DIAGNOSTICS, options=("--volumes-from", stopped))
        h.receipt("compose.missing_config", automatic_sources=True, database_initialized=False)


def unsafe_mounts(p):
    h = p.h
    (p.dir / MEDIA_BIND).mkdir()
    wrong = p.config.with_suffix(".yml")
    p.config.rename(wrong)
    try:
        for link, reason in ((os.symlink, "symlink"), (os.link, "multiple_links")):
            link(wrong, p.config)
            failure = rejected_start(p, reason)
            require(failure["target"] == CONFIG + "/config.yaml", "unsafe config lacks the required path")
            p.config.unlink()
    finally:
        wrong.rename(p.config)

    nested = p.dir / MEDIA_BIND / "nested"
    nested.mkdir(parents=True)
    link = nested / "alias"
    link.symlink_to(p.config)
    record = rejected_start(p, "symlink")
    require(record["target"] == MEDIA + "/nested/alias", "nested rejection did not identify the failing entry")
    link.unlink()
    nested.rmdir()
    config_mode = stat.S_IMODE(p.config.stat().st_mode)
    source = p.dir / "fixture-source"
    source.mkdir()
    outside = source / "outside"
    outside.write_text("untouched")
    os.chmod(outside, 0o644)
    override = p.dir / "unsafe.yaml"
    override.write_text(json.dumps({"services": {"service": {"volumes": [
        {"type": "bind", "source": str(source), "target": MEDIA + "/nested"}]}}}))
    rejected_start(p, "nested_mount", (*p.files, override))
    require(outside.read_text() == "untouched" and stat.S_IMODE(outside.stat().st_mode) == 0o644,
            "a nested mount changed another source's data or mode")
    if nested.exists():
        nested.rmdir()
    override.write_text(json.dumps({"services": {"service": {"volumes": [
        {"type": "bind", "source": str(p.config.parent), "target": CONFIG, "read_only": True}]}}}))
    failure = rejected_start(p, "read_only", (*p.files, override))
    require(failure["target"] == CONFIG and failure["stage"] == "inspect_filesystem"
            and failure["observed"]["mode"] == "0700", "read-only mount cannot be diagnosed from Compose logs")
    require(stat.S_IMODE(p.config.stat().st_mode) == config_mode, "failed validation changed config metadata")
    h.receipt("compose.fail_before_database", unsafe_yaml=True, nested_mount=True, read_only=True)


def fresh_install(h):
    owner = f"{os.getuid()}:{os.getgid()}"
    require(os.getuid() > 0 and os.getgid() > 0, "the Compose host-edit check requires an unprivileged account")
    with project(h, "host") as p:
        sample = Path("config.example.yaml").read_text()
        p.config.write_text(sample.replace('key: ""', f"key: {json.dumps(h.admin)}")
                            .replace('password: ""', f"password: {json.dumps(h.portal)}")
                            .replace("client-keys: {}", "client-keys:\n  fixture-client: " + h.client))
        config_read_failures(h, p.config)
        p.config.chmod(0o644)
        unsafe_mounts(p)
        for path in (p.dir / STATE_BIND, p.dir / MEDIA_BIND):
            if path.exists():
                path.rmdir()
        p.compose("up", "-d", "--force-recreate", "service")
        identity, origin = p.running_service()
        h.assert_serving_identity(identity, owner, no_new_privileges=True)
        event = p.logs("mounts.prepared")
        require(event["level"] == "INFO" and event["owner_source"] == "config_file" and event["metadata_repairs"] > 0,
                "successful setup lacks its owner selection and repairs")
        require(h.request(origin, "/api/v1/admin/status", h.admin)[0] == 200, "supplied management key failed")
        require(h.request(origin, "/v1/models", h.client)[0] == 200, "supplied model-client key failed")
        prompt = "controlled media storage"
        code, _, reply = json_request(h, origin, "/api/v1/media/jobs", h.client,
                                      {"submission_id": secrets.token_hex(16), "prompt": prompt})
        job = json.loads(reply)
        require(code == 202 and job["status"] == "queued" and
                (p.dir / MEDIA_BIND / job["job_id"] / "prompt").read_text() == prompt,
                "media did not retain its exact input in the fresh namespace while workers were absent")
        code, _, reply = json_request(h, origin, "/api/v1/portal/login", data={"password": h.portal})
        require(code == 200, "supplied portal password failed")
        session, key = json.loads(reply)["session_token"], "test-compose-key-" + secrets.token_hex(24)
        inode = p.config.stat().st_ino
        require(json_request(h, origin, "/api/v1/portal/client-keys", session, {"name": "via-portal", "key": key})[0] == 201,
                "portal could not save into the Compose configuration directory")
        require(p.config.stat().st_ino != inode, "portal did not atomically replace config.yaml")
        for name in ("config", STATE_BIND, MEDIA_BIND):
            require(stat.S_IMODE((p.dir / name).stat().st_mode) == 0o700, "host directory is not private")
        for path in (p.config, *(p.dir / STATE_BIND).glob("broker.sqlite3*")):
            info = path.stat()
            require((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (os.getuid(), os.getgid(), 0o600),
                    "host config or SQLite file has the wrong owner or mode")
        host_key = "test-host-edit-" + secrets.token_hex(24)
        with p.config.open("r+") as f:
            config = f.read().replace("client-keys:\n", f"client-keys:\n  via-host: {host_key}\n", 1)
            f.seek(0)
            f.write(config)
            f.truncate()
        require(h.request(origin, "/v1/models", host_key)[0] == 200, "broker did not accept the host creator's edit")
        h.assert_private(h.logs(identity), (session, key, host_key))
        p.compose("stop", "service")
        db = p.dir / STATE_BIND / "broker.sqlite3"
        db.chmod(0o644)
        prompt_file = p.dir / MEDIA_BIND / job["job_id"] / "prompt"
        prompt_file.chmod(0o644)
        p.compose("up", "-d", "--force-recreate", "service")
        replacement, new_origin = p.running_service()
        require(stat.S_IMODE(db.stat().st_mode) == stat.S_IMODE(prompt_file.stat().st_mode) == 0o600,
                "restart did not repair populated bind storage")
        require(replacement != identity, "recreate reused the old broker")
        for credential in (h.client, key, host_key):
            require(h.request(new_origin, "/v1/models", credential)[0] == 200, "configuration was lost on recreation")
        code, _, reply = h.request(new_origin, "/api/v1/media/jobs/" + job["job_id"], h.client)
        require(code == 200 and json.loads(reply)["job_id"] == job["job_id"]
                and (p.dir / MEDIA_BIND / job["job_id"] / "prompt").read_text() == prompt,
                "SQLite job or media prompt was lost on recreation")
        h.assert_private(h.logs(replacement), (session, key, host_key))
        h.receipt("compose.host_creator", uid=os.getuid(), gid=os.getgid(), atomic_save=True, recreated=True, database=True, media=True)


def simultaneous_brokers(h):
    with project(h, "concurrent") as first, project(h, "sibling") as sibling:
        first.config.write_text(json.dumps(h.configuration()))
        shared = {CONFIG: first.config.parent, SQLITE_STATE: first.dir / STATE_BIND, MEDIA: first.dir / MEDIA_BIND}
        overlay = sibling.dir / "sharing.yaml"

        def share_config(include_config):
            overlay.write_text(json.dumps({"services": {"service": {"volumes": [
                {"type": "bind", "source": str(path), "target": target, "bind": {"create_host_path": True}}
                for target, path in shared.items() if include_config or target != CONFIG]}}}))

        share_config(True)
        files = (*sibling.files, overlay)
        first.compose("up", "-d", "service")
        sibling.compose("up", "-d", "service", files=files)
        _, origin = first.running_service()
        _, sibling_origin = sibling.running_service(files=files)
        require(h.request(origin, "/v1/models", h.client)[0] == h.request(sibling_origin, "/v1/models", h.client)[0] == 200,
                "brokers with an identical owner did not share state")
        sibling.compose("stop", "service", files=files)
        share_config(False)
        sibling.config.write_text(json.dumps(h.configuration()))
        other = 10001 if os.getuid() != 10001 else 10002
        mount = "type=bind,source=" + str(sibling.config.parent) + ",target=/fixture"
        h.run_tools("chown", f"{other}:{other}", "/fixture/config.yaml", options=("--mount", mount))
        try:
            failure = rejected_start(sibling, "mounts_in_use", files)
            require(failure["stage"] == "lock_state" and failure["target"] == SQLITE_STATE,
                    "active broker did not block an ownership handoff")
            require((first.dir / STATE_BIND).stat().st_uid == os.getuid()
                    and h.request(origin, "/v1/models", h.client)[0] == 200, "handoff disrupted a running sibling")
        finally:
            h.run_tools("chown", f"{os.getuid()}:{os.getgid()}", "/fixture/config.yaml", options=("--mount", mount))
        h.receipt("compose.concurrent_boot", siblings=2, active_handoff_rejected=True)


def named_upgrade(h):
    with project(h, "named") as p:
        legacy = p.dir / "legacy.yaml"
        helper = """
  prepare-mounts:
    image: ${MUSE_TEST_IMAGE}
    user: "0:0"
    command: [prepare-mounts, '10001:10001']
    volumes:
      - ./config:/etc/aaa-muse-ai
      - sqlite:/var/lib/aaa-muse-ai/state
      - diagnostics:/var/lib/aaa-muse-ai/diagnostics
      - media:/var/lib/aaa-muse-ai/media
"""
        legacy.write_text(LEGACY.replace("services:\n", "services:" + helper, 1).replace(
            '    ports: ["127.0.0.1:0:8080"]', '''    ports: ["127.0.0.1:0:8080"]
    depends_on:
      prepare-mounts:
        condition: service_completed_successfully'''))
        p.cleanup_files = (legacy,)
        p.config.write_text(json.dumps(h.configuration()))
        mount = f"type=bind,source={p.config.parent},target=/fixture"

        def config_owner(user):
            h.run_tools("chown", user, "/fixture", "/fixture/config.yaml", options=("--mount", mount))

        owner = f"{os.getuid()}:{os.getgid()}"
        try:
            config_owner("10001:10001")
            p.compose("up", "-d", "service", files=p.cleanup_files)
            old, origin = p.running_service(files=p.cleanup_files)
            old_mounts = {m["Destination"]: m for m in h.inspect(old)["Mounts"]}
            p.env.update(MUSE_SQLITE_VOLUME=old_mounts[SQLITE_STATE]["Name"], MUSE_MEDIA_VOLUME=old_mounts[MEDIA]["Name"])
            code, _, reply = json_request(h, origin, "/api/v1/admin/enrollments", h.admin)
            require(code == 201, "old Compose broker did not issue an enrollment")
            enrollment = json.loads(reply)["enrollment_code"]
            _, headers, _ = h.request(origin, "/api/v1/worker/hook/status")
            pair = {"X-Muse-Worker-Version": headers["X-Muse-Service-Version"],
                    "X-Muse-Worker-Updater": "managed-hook-v1",
                    "X-Muse-Worker-SHA256": headers["X-Muse-Paired-Worker-SHA256"]}
            enroll = "/api/v1/worker/hook/enroll"
            code, event_headers, reply = json_request(h, origin, enroll, data={"enrollment_code": enrollment, "phase": "prepare"}, headers=pair)
            require(code == 201, f"old Compose broker did not prepare the worker (HTTP {code})")
            worker_key = json.loads(reply)["credential"]
            code, _, _ = json_request(h, origin, enroll, worker_key, {"enrollment_code": enrollment, "phase": "activate"}, headers=pair)
            require(code == 201, f"old Compose broker did not activate the worker (HTTP {code})")
            prompt = "retained named volume input"
            code, _, body = json_request(h, origin, "/api/v1/media/jobs", h.client,
                                         {"submission_id": secrets.token_hex(16), "prompt": prompt})
            require(code == 202, "old Compose broker did not store the job")
            job = json.loads(body)["job_id"]
            p.compose("stop", "service", files=p.cleanup_files)
            newer = owner if owner != "10001:10001" else "10002:10002"
            config_owner(newer)
            h.run_tools("chmod", "0644", SQLITE_STATE + "/broker.sqlite3", options=("--volumes-from", old))

            files = (*p.files, NAMED)
            result = p.compose("up", "-d", "service", files=files,
                               overrides={"MUSE_SQLITE_VOLUME": p.env["MUSE_SQLITE_VOLUME"] + "-missing"}, success=False)
            require("external" in result.stderr and "not found" in result.stderr, "invalid external volume did not fail closed")
            p.compose("up", "-d", "service", files=files)
            new, new_origin = p.running_service(files=files)
            require(new != old, "upgrade did not recreate the service")
            h.assert_serving_identity(new, newer, no_new_privileges=True)
            mounts = {m["Destination"]: m for m in h.inspect(new)["Mounts"]}
            for path in (SQLITE_STATE, MEDIA, DIAGNOSTICS):
                require(mounts[path]["Name"] == old_mounts[path]["Name"], "upgrade opened a different volume")
            require(h.request(new_origin, "/api/v1/worker/status", worker_key)[0] == 200, "worker identity was lost")
            require(h.request(new_origin, "/api/v1/media/jobs/" + job, h.client)[0] == 200, "stored media job was lost")
            require(h.run_tools("cat", MEDIA + "/" + job + "/prompt", options=("--volumes-from", new)).stdout == prompt,
                    "media did not survive upgrade")
            expected_uid, expected_gid = newer.split(":")
            require(h.run_tools("stat", "-c", "%a:%u:%g", SQLITE_STATE + "/broker.sqlite3", options=("--volumes-from", new)).stdout.strip()
                    == f"600:{expected_uid}:{expected_gid}", "populated SQLite file was not repaired to its YAML owner")
            route = "/api/v1/admin/diagnostics/export?request_id=" + event_headers["X-Request-Id"]
            code, _, reply = h.request(new_origin, route, h.admin)
            require(code == 200, "old diagnostic evidence could not be read")
            metadata, records = h.decode_export(reply)
            require(metadata["complete"] and records, "enrollment diagnostic evidence was lost")
            h.assert_private(json.dumps(records), (enrollment, worker_key))
            h.receipt("compose.named_upgrade", database=True, media=True, diagnostics=True, mixed_owners=True, old_compose=True)
        finally:
            config_owner(owner)


def smoke_compose(h):
    missing_config(h)
    fresh_install(h)
    simultaneous_brokers(h)
    named_upgrade(h)
