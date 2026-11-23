#!/usr/bin/env python3
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import threading
import urllib.parse
import urllib.request

from inference import Inference
from native_cron import NativeCronFixture
from service import LABEL, require
from worker_tls import TLSFixture

NODE_URL = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz"
NODE_SHA = "48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75"


class Assets:
    def __init__(self, harness, archive):
        self.public = harness.root / "public-fixture"
        self.public.mkdir(mode=0o700)
        shutil.copyfile(archive, self.public / "worker.tgz")
        shutil.copyfile(Path(archive).parent / "unpacked/package/setup/install.sh", self.public / "install.sh")
        shutil.copyfile(harness.proxy.cert, self.public / "ca.pem")
        node = self.public / "node.tar.xz"
        urllib.request.urlretrieve(NODE_URL, node)
        require(hashlib.sha256(node.read_bytes()).hexdigest() == NODE_SHA, "test fallback runtime archive digest differs")
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                return

            def do_GET(self):
                name = "node.tar.xz" if self.path == "/node" else "worker.tgz"
                body = (fixture.public / name).read_bytes()
                if self.path in ("/bad-worker", "/bad-node"):
                    body = b"corrupted artifact"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(harness.proxy.cert), str(harness.root.resolve() / "tls-key.pem"))
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        origin = "https://localhost:" + str(self.server.server_port)
        # Replace the downloader boundary only: shipped scripts still use real curl, TLS and archive bytes.
        shim = self.public / "bin"
        shim.mkdir(mode=0o755)
        script = '#!/usr/bin/env bash\nset -euo pipefail\nargs=("$@")\n'
        script += 'for i in "${!args[@]}"; do\n'
        script += 'case "${args[$i]}" in\nhttps://github.com/markhuangai/AaA-muse-ai/releases/download/*) args[$i]="' + origin + '/${FIXTURE_BAD_WORKER:+bad-}worker" ;;\n'
        script += NODE_URL + ') args[$i]="' + origin + '/${FIXTURE_BAD_NODE:+bad-}node" ;;\nesac\ndone\n'
        script += 'exec /usr/bin/curl "${args[@]}"\n'
        (shim / "curl").write_text(script)
        (shim / "curl").chmod(0o755)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class WorkerSetup(NativeCronFixture, Inference):
    def __init__(self, args):
        super().__init__(args)
        self.package = json.loads(Path(args.package_receipt).read_text())
        require(self.package["source"]["source_sha"] == args.source_sha, "setup package source differs")
        require(self.package["source"]["source_dirty"] == (args.source_dirty == "true"), "setup package dirty state differs")
        require(hashlib.sha256(Path(self.package["archive"]).read_bytes()).hexdigest() == self.package["sha256"], "setup archive changed")
        self.fixture_image = "aaa-muse-worker-setup:" + self.owner
        self.fixture_image_created = False

    def environment(self, name, *, mount_system_tmp=False):
        home = self.root.resolve() / ("home-" + name)
        home.mkdir(mode=0o700)
        temp_mount = []
        if mount_system_tmp:
            temp = home / "tmp"
            temp.mkdir(mode=0o700)
            temp_mount = ["--mount", "type=bind,source=" + str(temp) + ",target=/tmp"]
        identity = self.remember("containers", self.docker("run", "-d", "--init", "--read-only", "--label", LABEL + "=" + self.owner,
            "--network", "host", "--user", str(os.getuid()) + ":" + str(os.getgid()),
            "--mount", "type=bind,source=" + str(home) + ",target=/home/worker",
            "--mount", "type=bind,source=" + str(self.assets.public.resolve()) + ",target=/fixture,readonly",
            *temp_mount,
            "-e", "HOME=/home/worker", "-e", "TMPDIR=/home/worker/tmp", "-e", "CURL_CA_BUNDLE=/fixture/ca.pem",
            "-e", "NODE_EXTRA_CA_CERTS=/fixture/ca.pem", self.fixture_image, "bash", "-c", "mkdir -m 700 -p /home/worker/tmp; exec sleep infinity").stdout.strip())
        return {"container": identity, "home": home, "state": home / ".local/state/aaa-muse-worker-v1"}

    def command(self, environment, args, input_text=None, want=0, extra=()):
        result = self.docker("exec", "-i", *extra, environment["container"], *args, input_text=input_text, success=False, timeout=180)
        self.private("command-" + str(len(self.receipts)) + "-" + str(len(list(self.root.glob('command-*')))) + ".stderr", result.stderr)
        if result.returncode != want:
            self.private("failed-command.stdout", result.stdout)
        require(result.returncode == want, "real setup command failed; inspect private stderr")
        self.assert_private(result.stdout + result.stderr)
        return result

    def prompt(self):
        result, headers = self.checked("/api/v1/admin/setup-prompts", self.admin, "POST", {"origin": self.proxy.origin}, want=201)
        code = re.search(r"muse_enroll_[A-Za-z0-9_-]{43}", result["setup_prompt"])[0]
        self.secrets.append(code)
        require(result["worker_package"]["sha256"] == self.package["sha256"] and result["worker_package"]["version"] == self.package["version"], "setup prompt lost configured artifact identity")
        self.diagnose(headers["X-Request-Id"], "setup.prompt_created")
        return result

    def install(self, environment, prompt, fallback=False, corrupt=False, bad_node=False, want=0, state_home=None):
        script = prompt["setup_prompt"].split("```bash\n", 1)[1].split("```", 1)[0]
        path = "/fixture/bin:/usr/bin:/bin" if fallback else "/fixture/bin:/usr/local/bin:/usr/bin:/bin"
        extra = ["-e", "PATH=" + path]
        if state_home is not None:
            extra += ["-e", "XDG_STATE_HOME=" + state_home]
        if corrupt:
            extra += ["-e", "FIXTURE_BAD_WORKER=1"]
        if bad_node:
            extra += ["-e", "FIXTURE_BAD_NODE=1"]
        result = self.docker("exec", "-i", *extra, environment["container"], "bash", input_text=script, success=False, timeout=240)
        self.private("install-" + prompt["enrollment_id"] + ".stderr", result.stderr)
        require(result.returncode == want, "shipped bootstrap/installer failed; inspect private receipt")
        if want == 0:
            environment["receipt"] = json.loads(result.stdout.strip().splitlines()[-1])
            environment["worker"] = {"id": environment["receipt"]["worker_id"]}
            environment["credential"] = (environment["state"] / "credential.key").read_text().strip()
            self.secrets.append(environment["credential"])
        self.assert_private(result.stdout + result.stderr)
        return result

    def report_evidence(self, filter_name, identity, origin=None):
        status, _, body = self.api("/api/v1/admin/diagnostics/export?" + filter_name + "=" + identity, self.admin, origin=origin)
        require(status == 200, "model report broker export unavailable")
        saved = self.private("setup-report-" + identity + "-" + filter_name + ".ndjson", body.decode())
        decoder = ("import {readFileSync} from 'node:fs'; import {decodeExport} from './tools/qualification-evidence.mjs';"
                   "const result=decodeExport(readFileSync(process.argv[1],'utf8'));"
                   "if (!result.metadata.complete || result.metadata.omissions.length) process.exit(1);"
                   "console.log(JSON.stringify(result.events));")
        result = subprocess.run(["node", "--input-type=module", "-e", decoder, str(saved)], capture_output=True, text=True, timeout=15)
        require(result.returncode == 0, "model report broker export is incomplete")
        self.assert_private(result.stdout)
        return json.loads(result.stdout)

    def diagnose_rejected_report(self, records, setup_id, worker_id):
        rejection = next(e for e in records if e.get("msg") == "setup.model_report_rejected" and e["setup_id"] == setup_id)
        require(rejection["level"] == "WARN" and rejection["cause"] == "model_name_contains_credential"
                and rejection["worker_id"] == worker_id, "installer log could not identify the rejected report and setup")
        opened = next(e for e in records if e.get("msg") == "worker.sse_event" and e.get("event_type") == "connection.opened"
                      and e.get("setup_id") == setup_id and e.get("worker_id") == worker_id)
        request_id = opened["request_id"]
        connection = opened["payload"]
        connection_id, generation = connection["connection_id"], connection["connection_generation"]
        request_events = self.report_evidence("request_id", request_id)
        broker = next(e for e in request_events if e["msg"] == "worker.model_report")
        require(broker["request_id"] == request_id and broker["worker_id"] == worker_id and broker["connection_id"] == connection_id
                and broker["connection_generation"] == generation and broker["outcome"] == "not_reported",
                "broker report outcome does not match the authenticated worker connection")
        operation_events = self.report_evidence("operation_id", broker["operation_id"])
        require(broker in operation_events and any(e["msg"] == "worker.connection_changed" and e.get("connection_id") == connection_id
                and e.get("connection_generation") == generation and e.get("worker_id") == worker_id for e in operation_events),
                "linked broker operation lost the report outcome or connection evidence")
        self.receipt("setup.model_report_credential_rejected", capture_complete=True, setup_id=setup_id, worker_id=worker_id,
                     request_id=request_id, operation_id=broker["operation_id"], connection_id=connection_id, generation=generation,
                     cause=rejection["cause"], corrective_action="Remove the credential from the optional setup report.")

    def cli(self, environment, *args, input_text=None, want=0):
        return self.command(environment, [environment["receipt"]["launcher"], *args], input_text=input_text, want=want)

    def native_cli(self, worker, *args, input_text=None, want=0):
        return self.cli(worker, *args, input_text=input_text, want=want).stdout

    def hook(self, environment, dry=False, want=0):
        runtime = environment["home"] / "runtime.sh"
        if not runtime.exists():
            runtime.write_text('wake(){ printf \'{"action":"wake"}\\n\'; }; silent(){ printf \'{"action":"silent"}\\n\'; };\n')
            runtime.chmod(0o600)
        extra = ["-e", "HATCH_HOOK_RUNTIME=/home/worker/runtime.sh"]
        if dry:
            extra += ["-e", "HATCH_HOOK_DRY_RUN=1"]
        return self.command(environment, ["bash", environment["receipt"]["hook_path"]], extra=extra, want=want)

    def prepare_setgid_fixture(self, env, prompt):
        home = env["home"]
        parents = {home / ".local": 0o2770, home / ".local/share": 0o2700, home / ".local/state": 0o2700,
                   home / "workspace/skills": 0o2700}
        for path, mode in parents.items():
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(mode)
        leaf = home / ".local/share/aaa-muse-worker-v1"
        uid = os.getuid()

        def refused(reason, mode, owner):
            previous = set((home / "tmp").glob("aaa-muse-setup.*"))
            self.install(env, prompt, want=1)
            created, = set((home / "tmp").glob("aaa-muse-setup.*")) - previous
            capture = (created / "bootstrap.ndjson").read_text()
            self.assert_private(capture)
            events = [json.loads(line) for line in capture.splitlines()]
            require(any(e.get("msg") == "setup.runtime_unsupported" and e["level"] == "ERROR" and
                        e["stage"] == "installer" and e["execution_started"] is False and
                        e["setup_id"] == prompt["enrollment_id"] and e["capability"] == "install_directory" and
                        e["expected_state"] == f"mode_700_uid_{uid}" and e["observed_state"] == f"mode_{mode:o}_uid_{owner}" and
                        e["cause"] == reason for e in events), "installer refusal could not be diagnosed from private receipt")
            require(not (env["state"] / "credential.key").exists() and
                    self.checked("/api/v1/admin/workers", self.admin)[0]["workers"] == [], "directory refusal enrolled a worker")
            require(leaf.lstat().st_mode & 0o7777 == mode and leaf.lstat().st_uid == owner, "refusal changed the directory entry")

        leaf.mkdir(mode=0o700)
        marker = leaf / ".retained"
        marker.write_text("existing installation")
        refused("directory_not_empty", 0o2700, uid)
        require(marker.read_text() == "existing installation", "populated setgid directory was modified")
        marker.unlink()
        leaf.chmod(0o750)
        refused("unsafe_directory_mode", 0o750, uid)
        leaf.rmdir()
        sibling = home / "other-worker"
        sibling.mkdir()
        sibling.chmod(0o2700)
        leaf.symlink_to("../../other-worker")
        refused("wrong_directory_type", 0o777, uid)
        require(leaf.resolve() == sibling and sibling.stat().st_mode & 0o7777 == 0o2700, "installer modified a link target")
        leaf.unlink()
        leaf.mkdir(mode=0o700)
        other_uid = 65534 if uid != 65534 else 65533
        container_path = "/home/worker/.local/share/aaa-muse-worker-v1"
        try:
            self.docker("exec", "--user", "0:0", env["container"], "chown", str(other_uid), container_path)
            refused("wrong_directory_owner", leaf.stat().st_mode & 0o7777, other_uid)
        finally:
            self.docker("exec", "--user", "0:0", env["container"], "chown", str(uid), container_path)
        leaf.chmod(0o2700)
        self.receipt("setup.unsafe_directory_refusals", populated=True, broader_mode=True, link=True, foreign_owner=True,
                     private_receipts_verified=True, stopped_before_enrollment=True)
        return parents

    def asset_directory_recovery(self):
        worker = self.environment("asset-directory-recovery")
        prompt = self.prompt()
        skills = worker["home"] / "workspace/skills"
        skills.mkdir(parents=True, mode=0o700)
        observed = {}

        def block_asset(worker_id):
            leaf = skills / ("aaa-muse-worker-" + worker_id)
            leaf.mkdir(mode=0o700)
            (leaf / ".retained").write_text("operator fixture")
            leaf.chmod(0o2700)
            observed.update(worker_id=worker_id, leaf=leaf)

        self.proxy.enrollment_accepted = block_asset
        try:
            result = self.install(worker, prompt, want=1)
        finally:
            self.proxy.enrollment_accepted = None
        require(observed and not (worker["state"] / "installation.json").exists(), "incomplete assets authorized a checker")
        credential = (worker["state"] / "credential.key").read_text().strip()
        self.secrets.append(credential)
        self.assert_private(result.stderr)
        require(self.checked("/api/v1/worker/status", credential)[0]["id"] == observed["worker_id"], "late failure lost its authenticated worker")
        marker = observed["leaf"] / ".retained"
        require(marker.read_text() == "operator fixture", "directory refusal changed existing contents")
        marker.unlink()
        self.install(worker, prompt)
        require(worker["receipt"]["identity_preserved"] and worker["credential"] == credential and worker["worker"]["id"] == observed["worker_id"],
                "retry enrolled a replacement after a skill directory refusal")
        records = [json.loads(line) for line in self.native_cli(worker, "diagnostics-export", "--decode").splitlines()]
        require(records[0]["complete"] and any(e.get("msg") == "worker.state_unsafe" and e.get("capability") == "skill_directory" and
                e.get("worker_id") == observed["worker_id"] and e.get("cause") == "directory_not_empty" for e in records),
                "protected setup export did not explain the skill refusal")
        self.receipt("setup.asset_directory_recovery", identity_preserved=True, failure_held_before_native_registration=True)

    def exercise(self):
        status, _, _ = self.api("/api/v1/admin/setup-prompts", self.client, "POST", {})
        require(status == 401, "client authority generated setup prompt")
        worker = self.environment("primary", mount_system_tmp=True)
        initial = self.prompt()
        prompt = initial["setup_prompt"]
        require(all(fragment in prompt for fragment in ("Request the actual permissions", "including disabled jobs", 'every: "1m"',
                    "execution.kind=agent", "After a write or uncertain reply", "Setup is incomplete", "one finite native agent runonce")),
                    "broker prompt lost the native checker read-back contract")
        parents = self.prepare_setgid_fixture(worker, initial)
        legacy = worker["home"] / ".local/state/aaa-muse-worker"
        legacy.mkdir(mode=0o700)
        legacy_marker = legacy / "operator-fixture"
        legacy_marker.write_text("retained major zero state")
        self.install(worker, initial)
        require(worker["receipt"]["cron_registration"] == "pending" and self.status(worker)["connection_status"] == "not_observed", "setup falsely claimed a scheduled execution")
        require(worker["state"].stat().st_mode & 0o7777 == 0o700 and (worker["state"] / "credential.key").stat().st_mode & 0o7777 == 0o600,
                "installer did not enforce private state permissions")
        for path, mode in parents.items():
            require(path.stat().st_mode & 0o7777 == mode, "installer changed a parent mode")
        require(legacy_marker.read_text() == "retained major zero state", "fresh setup altered a major-zero installation")
        self.checker(worker)
        registration = (worker["state"] / "cron-installation.json").read_bytes()
        self.install(worker, initial)
        require(worker["receipt"]["identity_preserved"] and (worker["state"] / "cron-installation.json").read_bytes() == registration, "install retry changed checker or worker")
        require(self.tick(worker)["outcome"] == "idle", "installed checker did not perform an empty authenticated pull")
        workers, _ = self.checked("/api/v1/admin/workers", self.admin)
        require(len(workers["workers"]) == 1 and workers["workers"][0]["id"] == worker["worker"]["id"], "setup retry consumed another enrollment")
        require(not (worker["state"] / "launch.json").exists() and not (worker["home"] / "hooks").exists(), "native install left a daemon or hook")
        key = worker["state"] / "credential.key"
        key.chmod(0o644)
        try:
            self.cli(worker, "doctor", want=1)
        finally:
            key.chmod(0o600)
        evidence = [json.loads(line) for line in self.native_cli(worker, "diagnostics-export", "--decode").splitlines()]
        require(evidence[0]["complete"] and any(e.get("msg") == "setup.native_checker_verified" and e.get("checker_job_id") == worker["checker"] for e in evidence) and
                any(e.get("msg") == "worker.state_unsafe" and e.get("expected_mode") == "600" and e.get("observed_mode") == "644" for e in evidence),
                "protected setup evidence did not prove read-back or unsafe mode")
        self.receipt("setup.native_checker_install", interval="1m", protected_state=True, same_registration_on_retry=True, scheduler_fixture="controlled")

        corrupt = self.environment("corrupt")
        result = self.install(corrupt, self.prompt(), corrupt=True, want=1)
        records = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{')]
        require(not (corrupt["state"] / "credential.key").exists() and any(e.get("msg") == "setup.digest_mismatch" and
                e["expected_digest"] != e["observed_digest"] and not e["execution_started"] for e in records), "archive corruption was not refused before enrollment")
        capture_failure = self.environment("capture-failure")
        prompt = self.prompt()
        script = prompt["setup_prompt"].split("```bash\n", 1)[1].split("```", 1)[0]
        result = self.command(capture_failure, ["bash"], input_text="trap '' XFSZ\nulimit -f 0\n" + script, want=1)
        records = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{')]
        require(any(e.get("cause") == "receipt_append_failed" and e.get("stage") == "bootstrap" and e.get("protected_capture_unavailable") for e in records),
                "bootstrap append failure has no independent emergency diagnostic")
        setup_id = '8' * 32
        script = 'receipt=/home/worker/tmp/write-failure.ndjson\n: > "$receipt"\nchmod 600 "$receipt"\ntrap \'\' XFSZ\nulimit -f 0\n'
        script += 'bash /fixture/install.sh /fixture/worker.tgz ' + self.package["version"] + ' ' + self.package["sha256"] + ' ' + self.proxy.origin + ' ' + setup_id + ' "$receipt"\n'
        result = self.command(capture_failure, ["bash"], input_text=script, want=1)
        records = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{')]
        require(any(e.get("cause") == "receipt_append_failed" and e.get("stage") == "installer" and e.get("protected_capture_unavailable") for e in records),
                "installer append failure has no independent emergency diagnostic")
        self.receipt("setup.capture_append_failures", bootstrap_and_installer=True, stopped_before_execution=True)

        fallback = self.environment("fallback")
        self.install(fallback, self.prompt(), fallback=True)
        nodes = list((fallback["home"] / ".local/share/aaa-muse-worker-v1/runtime").glob("node.*/node"))
        require(len(nodes) == 1 and nodes[0].is_file() and self.command(fallback, ["/home/worker/" + str(nodes[0].relative_to(fallback["home"])), "--version"]).stdout.strip() == "v24.22.2",
                "downloaded runtime did not execute at the pinned version")
        bad_node = self.environment("bad-node")
        result = self.install(bad_node, self.prompt(), fallback=True, bad_node=True, want=1)
        require('"stage":"node"' in result.stderr and '"execution_started":false' in result.stderr and not (bad_node["state"] / "credential.key").exists(),
                "invalid runtime bytes were not rejected before enrollment")
        self.receipt("setup.corruption_and_pinned_node", node_sha256=NODE_SHA, fallback_executed=True, corrupted_node_rejected=True)
        self.asset_directory_recovery()


def run(harness_type=WorkerSetup, suite="worker-setup"):
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    parser.add_argument("--package-receipt", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = harness_type(args)
    proxy = assets = None
    try:
        h.baseline()
        h.setup()
        proxy = h.proxy = TLSFixture(h, "http://127.0.0.1:1")
        config = h.configuration()
        config["limits"] = {"in-flight-per-worker": 1}
        h.broker, h.origin_url, _ = h.launch(config)
        proxy.target = urllib.parse.urlsplit(h.origin_url)
        h.ready(h.resources["containers"][-1], h.origin_url)
        assets = h.assets = Assets(h, h.package["archive"])
        h.docker("build", "--label", LABEL + "=" + h.owner, "-f", "tests/integration/worker-setup.Dockerfile", "-t", h.fixture_image, ".", timeout=240)
        h.fixture_image_created = True
        h.exercise()
        h.private("results.json", json.dumps({"suite": suite, "source_sha": args.source_sha, "package_sha256": h.package["sha256"], "muse_qualified": False, "receipts": h.receipts}))
    finally:
        if assets:
            assets.close()
        if proxy:
            proxy.release_decision.set()
            proxy.close()
        h.cleanup()
        if h.fixture_image_created:
            info = json.loads(h.docker("image", "inspect", h.fixture_image).stdout)[0]
            require(info["Config"]["Labels"][LABEL] == h.owner, "fixture image owner changed")
            h.docker("image", "rm", h.fixture_image)
            require(h.docker("image", "inspect", h.fixture_image, success=False).returncode != 0, "fixture image cleanup unproven")
            h.private("setup-image-cleanup.json", json.dumps({"removed": h.fixture_image, "image_id": info["Id"], "owner": h.owner}))

    return h


if __name__ == "__main__":
    run()
