"""Exercise the shipped Compose storage layout on an isolated Docker project."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess

from service import SQLITE_STATE, require


CONFIG = "/etc/aaa-muse-ai"
MEDIA = "/var/lib/aaa-muse-ai/media"
DIAGNOSTICS = "/var/lib/aaa-muse-ai/diagnostics"
STATE_BIND = "sqlite-v1"
MEDIA_BIND = "media-v1"
BASE = Path("compose.yaml").resolve()
NAMED = Path("compose.named-volumes.yaml").resolve()

LEGACY = """services:
  service:
    image: ${MUSE_SERVICE_IMAGE}
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
    def __init__(self, harness, label, user):
        self.h = harness
        self.name = harness.owner + "-" + label
        self.dir = harness.root.resolve() / label
        self.dir.mkdir()
        (self.dir / "config").mkdir()
        self.config = self.dir / "config" / "config.yaml"
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("COMPOSE_", "MUSE_"))
        }
        self.env.update(MUSE_SERVICE_IMAGE=harness.args.image, MUSE_HTTP_PORT="0",
                        MUSE_MANAGEMENT_KEY=harness.admin, MUSE_PORTAL_PASSWORD=harness.portal,
                        MUSE_SERVICE_USER=user)
        self.cleanup_file = BASE

    def compose(self, *args, files=(BASE,), overrides=None, success=True):
        command = ["docker", "compose", "--env-file", "/dev/null", "--project-directory", str(self.dir), "-p", self.name]
        for path in files:
            command.extend(("-f", str(path)))
        env = self.env | (overrides or {})
        result = subprocess.run(command + list(args), env=env, capture_output=True, text=True, timeout=75)
        if success != (result.returncode == 0):
            self.h.assert_private(result.stdout + result.stderr)
            self.h.private(self.dir.name + "-compose-error.txt", result.stdout + result.stderr)
            raise AssertionError("Compose result differed for " + " ".join(args))
        return result

    def running_service(self, files=(BASE,)):
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

    def logs(self, service, reason, extra=()):
        result = self.compose("logs", "--no-log-prefix", service)
        output = result.stdout + result.stderr
        self.h.assert_private(output, extra)
        records = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
        matches = [e for e in records if e.get("reason") == reason]
        require(matches, "expected startup reason is absent from Compose logs: " + reason)
        result = matches[-1]
        require(result["revision"] == self.h.args.source_sha and result.get("operation_id"), "startup diagnosis lacks provenance")
        return result

    def unused(self):
        label = "label=com.docker.compose.project=" + self.name
        return not any(self.h.docker(*command, "--filter", label).stdout.strip() for command in (
            ("ps", "-aq"), ("network", "ls", "-q"), ("volume", "ls", "-q"),
        ))


@contextmanager
def project(h, label, user):
    p = ComposeProject(h, label, user)
    require(p.unused(), "fixture Compose project already exists")
    try:
        yield p
    finally:
        p.compose("down", "--volumes", "--remove-orphans", files=(p.cleanup_file,))
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
        result = h.docker("run", "--rm", "--user", f"{uid}:10001", "--mount",
                          f"type=bind,source={source},target={target},readonly", h.args.image, *arguments, success=False)
        output = result.stdout + result.stderr
        h.assert_private(output, (private_selector,))
        require(result.returncode == 1, "config read did not stop in the broker")
        event = json.loads(output)
        require(event["msg"] == "config.rejected" and event["reason"] == "read_failed" and event["read_cause"] == reason
                and event["config_path"] == selector and event["level"] == "ERROR" and event["operation_id"]
                and event["revision"] == h.args.source_sha, "config read failure is not diagnosable")
        h.receipt("compose.direct_config_" + name, reason=reason)


def check_missing_bind_sources(p):
    services = json.loads(p.compose("config", "--format", "json").stdout)["services"]
    for name in ("prepare-mounts", "service"):
        binds = [m for m in services[name]["volumes"] if m["type"] == "bind"]
        require({m["target"] for m in binds} == {CONFIG, SQLITE_STATE, MEDIA}
                and all(m["bind"]["create_host_path"] is False for m in binds), "Compose allows host source creation")
    platform = p.h.docker("info", "--format", "{{.OperatingSystem}}").stdout.strip()
    if platform == "Docker Desktop":
        # The Desktop file-sharing layer can create sources before the engine applies the bind flags.
        p.h.receipt("compose.bind_declarations", engine=platform, missing_source_runtime="not_exercised")
        return
    p.compose("up", "-d", "service", success=False)
    require(not (p.dir / STATE_BIND).exists() and not (p.dir / MEDIA_BIND).exists(), "Compose created missing host sources")
    p.h.receipt("compose.bind_declarations", missing_source_runtime="rejected")


def fresh_install(h):
    owner = f"{os.getuid()}:{os.getgid()}"
    require(os.getuid() > 0 and os.getgid() > 0, "the Compose host-edit check requires an unprivileged account")
    with project(h, "host", owner) as p:
        sample = Path("config.example.yaml").read_text()
        p.config.write_text(sample.replace("client-keys: {}", "client-keys:\n  fixture-client: " + h.client))
        p.compose("up", "-d", "service", overrides={"MUSE_SERVICE_USER": ""}, success=False)
        check_missing_bind_sources(p)
        for name in (STATE_BIND, MEDIA_BIND):
            (p.dir / name).mkdir(mode=0o755)
            (p.dir / name).chmod(0o755)

        config_read_failures(h, p.config)
        wrong = p.config.with_suffix(".yml")
        p.config.rename(wrong)
        p.compose("up", "-d", "service", success=False)
        event = p.logs("prepare-mounts", "not_found")
        require(event["msg"] == "mounts.prepare_failed" and event["target"] == CONFIG + "/config.yaml"
                and event["level"] == "ERROR" and event["outcome"] == "stopped", "wrong YAML failure lacks a corrective path")

        for link, reason in ((os.symlink, "symlink"), (os.link, "multiple_links")):
            link(wrong, p.config)
            p.compose("up", "-d", "service", success=False)
            event = p.logs("prepare-mounts", reason)
            require(event["target"] == CONFIG + "/config.yaml" and event["observed"]["uid"] == os.getuid(),
                    "unsafe YAML reason or observed owner missing")
            p.config.unlink()
        wrong.rename(p.config)
        nested = p.dir / MEDIA_BIND / "nested"
        nested.mkdir()
        link = nested / "link"
        link.symlink_to(p.config)
        p.compose("up", "-d", "service", success=False)
        event = p.logs("prepare-mounts", "symlink")
        require(event["target"] == MEDIA and event["stage"] == "validate_entries"
                and stat.S_IMODE((p.dir / STATE_BIND).stat().st_mode) == 0o755,
                "nested symlink did not stop preparation before mode changes")
        link.unlink()
        nested.rmdir()
        p.compose("up", "-d", "service", overrides={"MUSE_SERVICE_USER": "0:10001"}, success=False)
        p.logs("prepare-mounts", "invalid_service_user")
        mount = f"type=bind,source={p.dir / STATE_BIND},target=/fixture"
        h.docker("run", "--rm", "--user", "0:0", "--mount", mount, "--entrypoint", "/bin/sh", h.args.image,
                 "-ec", 'touch /fixture/retained; chown 0:0 /fixture')
        try:
            p.compose("up", "-d", "service", success=False)
            event = p.logs("prepare-mounts", "populated_directory_owner_mismatch")
            require(event["target"] == SQLITE_STATE and event["observed"]["uid"] == 0
                    and event["expected"]["uid"] == os.getuid(), "incompatible data ownership is not diagnosable")
            require((p.dir / STATE_BIND / "retained").exists() and (p.dir / STATE_BIND).stat().st_uid == 0,
                    "failed preparation changed populated storage")
        finally:
            h.docker("run", "--rm", "--user", "0:0", "--mount", mount, "--entrypoint", "/bin/sh", h.args.image,
                     "-ec", 'chown "$1" /fixture; unlink /fixture/retained', "restore-fixture", owner)
        require(not (p.dir / STATE_BIND / "broker.sqlite3").exists(), "broker started before mount validation")
        h.receipt("compose.fail_before_database", unsafe_yaml=True, invalid_identity=True)

        p.config.chmod(0o644)
        p.compose("up", "-d", "service")
        identity, origin = p.running_service()
        event = p.logs("prepare-mounts", "ready")
        require(event["msg"] == "mounts.prepared" and event["level"] == "INFO"
                and event["expected"] == {"uid": os.getuid(), "gid": os.getgid(), "mode": "0600"}
                and event["observed"]["mode"] == "0644", "preparation receipt lost observed permissions")
        require(h.docker("exec", identity, "sh", "-ec", 'printf "%s:%s" "$(id -u)" "$(id -g)"').stdout == owner,
                "broker does not run as the host creator")
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
        p.compose("up", "-d", "--force-recreate", "service")
        replacement, new_origin = p.running_service()
        require(replacement != identity, "recreate reused the old broker")
        for credential in (h.client, key, host_key):
            require(h.request(new_origin, "/v1/models", credential)[0] == 200, "configuration was lost on recreation")
        h.assert_private(h.logs(replacement), (session, key, host_key))
        h.receipt("compose.host_creator", uid=os.getuid(), gid=os.getgid(), atomic_save=True, recreated=True, media_write=True)


def named_upgrade(h):
    with project(h, "named", "10001:10001") as p:
        p.cleanup_file = p.dir / "legacy.yaml"
        p.cleanup_file.write_text(LEGACY)
        p.config.write_text(json.dumps(h.configuration()))
        mount = f"type=bind,source={p.config.parent},target=/fixture"

        def config_owner(user):
            h.docker("run", "--rm", "--user", "0:0", "--mount", mount, "--entrypoint", "/bin/sh", h.args.image,
                     "-ec", 'chown "$1" /fixture /fixture/config.yaml', "legacy-config", user)

        try:
            config_owner("10001:10001")
            p.compose("up", "-d", "service", files=(p.cleanup_file,))
            old, origin = p.running_service(files=(p.cleanup_file,))
            old_mounts = {m["Destination"]: m for m in h.inspect(old)["Mounts"]}
            p.env.update(MUSE_SQLITE_VOLUME=old_mounts[SQLITE_STATE]["Name"], MUSE_MEDIA_VOLUME=old_mounts[MEDIA]["Name"])
            code, headers, reply = json_request(h, origin, "/api/v1/admin/enrollments", h.admin)
            require(code == 201, "legacy database did not issue an enrollment")
            enrollment = json.loads(reply)["enrollment_code"]
            worker_version = {"X-Muse-Worker-Version": headers["X-Muse-Service-Version"]}
            code, event_headers, reply = json_request(h, origin, "/api/v1/worker/enroll",
                                                      data={"enrollment_code": enrollment}, headers=worker_version)
            require(code == 201, f"legacy database did not store the worker (HTTP {code})")
            worker_key = json.loads(reply)["credential"]
            h.docker("exec", old, "sh", "-ec", "umask 077\nprintf retained > /var/lib/aaa-muse-ai/media/upgrade-fixture")
            p.compose("stop", "service", files=(p.cleanup_file,))

            files = (BASE, NAMED)
            result = p.compose("up", "-d", "service", files=files,
                               overrides={"MUSE_SQLITE_VOLUME": p.env["MUSE_SQLITE_VOLUME"] + "-missing"}, success=False)
            require("external" in result.stderr and "not found" in result.stderr, "invalid external volume did not fail closed")
            p.compose("up", "-d", "service", files=files)
            new, new_origin = p.running_service(files=files)
            require(new != old, "upgrade did not recreate the service")
            for service in ("prepare-mounts", "service"):
                identity = p.compose("ps", "--all", "--quiet", service, files=files).stdout.strip()
                mounts = {m["Destination"]: m for m in h.inspect(identity)["Mounts"]}
                for path in (SQLITE_STATE, MEDIA, DIAGNOSTICS):
                    require(mounts[path]["Name"] == old_mounts[path]["Name"], "upgrade opened a different volume")
            require(h.request(new_origin, "/api/v1/worker/status", worker_key)[0] == 200, "worker identity was lost")
            require(h.docker("exec", new, "cat", MEDIA + "/upgrade-fixture").stdout == "retained", "media did not survive upgrade")
            route = "/api/v1/admin/diagnostics/export?request_id=" + event_headers["X-Request-Id"]
            code, _, reply = h.request(new_origin, route, h.admin)
            require(code == 200, "old diagnostic evidence could not be read")
            metadata, records = h.decode_export(reply)
            require(metadata["complete"] and records, "enrollment diagnostic evidence was lost")
            h.assert_private(json.dumps(records), (enrollment, worker_key))
            h.receipt("compose.named_upgrade", database=True, media=True, diagnostics=True)
        finally:
            config_owner(f"{os.getuid()}:{os.getgid()}")


def smoke_compose(h):
    fresh_install(h)
    named_upgrade(h)
