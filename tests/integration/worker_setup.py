#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import threading
import urllib.parse
import urllib.request

from inference import Inference
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


class WorkerSetup(Inference):
    def __init__(self, args):
        super().__init__(args)
        self.package = json.loads(Path(args.package_receipt).read_text())
        require(self.package["source"]["source_sha"] == args.source_sha, "setup package source differs")
        require(self.package["source"]["source_dirty"] == (args.source_dirty == "true"), "setup package dirty state differs")
        require(hashlib.sha256(Path(self.package["archive"]).read_bytes()).hexdigest() == self.package["sha256"], "setup archive changed")
        self.fixture_image = "aaa-muse-worker-setup:" + self.owner
        self.fixture_image_created = False

    def environment(self, name):
        home = self.root.resolve() / ("home-" + name)
        home.mkdir(mode=0o700)
        identity = self.remember("containers", self.docker("run", "-d", "--read-only", "--label", LABEL + "=" + self.owner,
            "--network", "host", "--user", str(os.getuid()) + ":" + str(os.getgid()),
            "--mount", "type=bind,source=" + str(home) + ",target=/home/worker",
            "--mount", "type=bind,source=" + str(self.assets.public.resolve()) + ",target=/fixture,readonly",
            "-e", "HOME=/home/worker", "-e", "TMPDIR=/home/worker/tmp", "-e", "CURL_CA_BUNDLE=/fixture/ca.pem",
            "-e", "NODE_EXTRA_CA_CERTS=/fixture/ca.pem", self.fixture_image, "bash", "-c", "mkdir -m 700 -p /home/worker/tmp; exec sleep infinity").stdout.strip())
        return {"container": identity, "home": home, "state": home / ".local/state/aaa-muse-worker"}

    def command(self, environment, args, input_text=None, want=0, extra=()):
        result = self.docker("exec", "-i", *extra, environment["container"], *args, input_text=input_text, success=False, timeout=180)
        self.private("command-" + str(len(self.receipts)) + "-" + str(len(list(self.root.glob('command-*')))) + ".stderr", result.stderr)
        if result.returncode != want:
            self.private("failed-command.stdout", result.stdout)
        require(result.returncode == want, "real setup command failed; inspect private stderr")
        self.assert_private(result.stdout + result.stderr)
        return result

    def prompt(self):
        result, headers = self.checked("/api/v1/admin/setup-prompts", self.admin, "POST", {}, want=201)
        code = re.search(r"muse_enroll_[A-Za-z0-9_-]{43}", result["setup_prompt"])[0]
        self.secrets.append(code)
        require(result["worker_package"]["sha256"] == self.package["sha256"] and result["worker_package"]["version"] == self.package["version"], "setup prompt lost configured artifact identity")
        self.diagnose(headers["X-Request-Id"], "setup.prompt_created")
        return result

    def install(self, environment, prompt, fallback=False, corrupt=False, bad_node=False, want=0):
        script = prompt["setup_prompt"].split("```bash\n", 1)[1].split("```", 1)[0]
        path = "/fixture/bin:/usr/bin:/bin" if fallback else "/fixture/bin:/usr/local/bin:/usr/bin:/bin"
        extra = ["-e", "PATH=" + path]
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
            self.until(lambda: self.status(environment)["connection_status"] == "online", "installed subscriber did not become online", timeout=30)
        self.assert_private(result.stdout + result.stderr)
        return result

    def cli(self, environment, *args, input_text=None, want=0):
        return self.command(environment, [environment["receipt"]["launcher"], args[0], "--state-dir", "/home/worker/.local/state/aaa-muse-worker", *args[1:]], input_text=input_text, want=want)

    def hook(self, environment, dry=False, want=0):
        runtime = environment["home"] / "runtime.sh"
        if not runtime.exists():
            runtime.write_text('wake(){ printf \'{"action":"wake"}\\n\'; }; silent(){ printf \'{"action":"silent"}\\n\'; };\n')
            runtime.chmod(0o600)
        extra = ["-e", "HATCH_HOOK_RUNTIME=/home/worker/runtime.sh"]
        if dry:
            extra += ["-e", "HATCH_HOOK_DRY_RUN=1"]
        return self.command(environment, ["bash", environment["receipt"]["hook_path"]], extra=extra, want=want)

    def exercise(self):
        status, _, _ = self.api("/api/v1/admin/setup-prompts", self.client, "POST", {})
        require(status == 401, "client authority generated setup prompt")
        primary = self.environment("primary")
        initial = self.prompt()
        self.install(primary, initial)
        first_id = primary["worker"]["id"]
        first_pid = json.loads((primary["state"] / "launch.json").read_text())["pid"]
        for path, mode in [(primary["state"], 0o700), (primary["state"] / "credential.key", 0o600)]:
            require(path.stat().st_mode & 0o777 == mode, "installed credential permissions differ")
        repeated = [self.prompt(), self.prompt()]
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda prompt: self.install(dict(primary), prompt), repeated))
        require(json.loads((primary["state"] / "launch.json").read_text())["pid"] == first_pid, "repeat install duplicated subscriber")
        workers = self.checked("/api/v1/admin/workers", self.admin)[0]["workers"]
        require(len(workers) == 1 and workers[0]["id"] == first_id, "repeat install allocated another identity")
        self.receipt("setup.fresh_repeat_concurrent", worker_id=first_id, package_sha256=self.package["sha256"], one_consumer=True)

        self.hook(primary, dry=True)
        require(json.loads(self.hook(primary).stdout)["action"] == "silent", "idle hook woke model")
        experiment = self.create(primary, "synthetic setup detector cue", tools=False)
        self.until(lambda: (primary["state"] / "pending.json").exists() and bool(json.loads((primary["state"] / "pending.json").read_text())["jobs"]), "subscriber did not publish setup cue")
        require(json.loads(self.hook(primary).stdout)["action"] == "wake", "actionable cue did not emit native wake")
        require(json.loads(self.hook(primary).stdout)["action"] == "silent", "unchanged cue emitted duplicate wake")
        self.cli(primary, "job-show", "--job-id", experiment["current_job_id"])
        require(json.loads(self.hook(primary).stdout)["action"] == "silent", "context read emitted a duplicate wake for unchanged assignment")
        self.cli(primary, "decision-submit", "--job-id", experiment["current_job_id"], "--input", "-", input_text=json.dumps({"type": "final", "text": "synthetic fixture answer"}))
        self.receipt("setup.shipped_hook", real_runtime_functions=True, deduplicated=True, synthetic_model_decision=True)

        self.command(primary, ["bash", "-c", 'kill -TERM "$1"', "setup-recovery-test", str(first_pid)])
        self.until(lambda: not (primary["state"] / "daemon.lock").exists(), "owned subscriber did not stop")
        self.hook(primary)
        second_pid = json.loads((primary["state"] / "launch.json").read_text())["pid"]
        require(second_pid != first_pid and (primary["state"] / "credential.key").read_text().strip() == primary["credential"], "recovery changed identity or failed to restart")
        self.until(lambda: self.status(primary)["connection_status"] == "online", "recovered subscriber not online")
        key = primary["state"] / "credential.key"
        key.chmod(0o644)
        self.cli(primary, "doctor", want=1)
        key.chmod(0o600)
        exported = self.cli(primary, "diagnostics-export", "--decode").stdout
        records = [json.loads(line) for line in exported.splitlines()]
        require(records[0]["complete"], "setup diagnostic capture incomplete")
        require(any(e.get("msg") == "setup.wake_emitted" and e.get("setup_id") for e in records), "wake evidence missing")
        require(any(e.get("msg") == "setup.assets" and e.get("level") == "DEBUG" and "client-tool" in e.get("skill", "") for e in records), "complete protected assets absent")
        require(any(e.get("msg") == "worker.state_unsafe" and e.get("expected_mode") == "600" and e.get("observed_mode") == "644" for e in records), "unsafe state is not diagnosable from logs")
        self.private("setup-diagnosis.json", json.dumps({"cause": "credential mode 0644; repair to 0600", "events": records}))
        self.receipt("setup.recovery_and_log_only_diagnosis", identity_preserved=True, muse_refresh_qualified=False)

        corrupt = self.environment("corrupt")
        result = self.install(corrupt, self.prompt(), corrupt=True, want=1)
        events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{')]
        require(any(e.get("msg") == "setup.digest_mismatch" and e["expected_digest"] != e["observed_digest"] and not e["execution_started"] for e in events), "corruption not diagnosed before execution")
        require(not (corrupt["state"] / "credential.key").exists(), "corrupt package executed enrollment")
        capture_failure = self.environment("capture-failure")
        prompt = self.prompt()
        script = prompt["setup_prompt"].split("```bash\n", 1)[1].split("```", 1)[0]
        result = self.command(capture_failure, ["bash"], input_text="trap '' XFSZ\nulimit -f 0\n" + script, want=1)
        events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{')]
        require(any(e.get("cause") == "receipt_append_failed" and e.get("stage") == "bootstrap" and e.get("protected_capture_unavailable") for e in events), "bootstrap append failure has no independent emergency diagnostic")
        setup_id = '8' * 32
        script = 'receipt=/home/worker/tmp/write-failure.ndjson\n: > "$receipt"\nchmod 600 "$receipt"\ntrap \'\' XFSZ\nulimit -f 0\n'
        script += 'bash /fixture/install.sh /fixture/worker.tgz ' + self.package["version"] + ' ' + self.package["sha256"] + ' ' + self.proxy.origin + ' ' + setup_id + ' "$receipt"\n'
        result = self.command(capture_failure, ["bash"], input_text=script, want=1)
        events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{')]
        require(any(e.get("cause") == "receipt_append_failed" and e.get("stage") == "installer" and e.get("protected_capture_unavailable") for e in events), "installer append failure has no independent emergency diagnostic")
        self.receipt("setup.capture_append_failures", bootstrap_and_installer=True, stopped_before_execution=True)
        fallback = self.environment("fallback")
        self.install(fallback, self.prompt(), fallback=True)
        node = json.loads((fallback["state"] / "installation.json").read_text())["node"]
        require(node.startswith('/home/worker/.local/share/aaa-muse-worker/runtime/'), "fallback used preinstalled Node")
        require(self.command(fallback, [node, "--version"]).stdout.strip() == "v24.22.2", "downloaded Node did not execute at exact pinned version")
        bad_node = self.environment("bad-node")
        result = self.install(bad_node, self.prompt(), fallback=True, bad_node=True, want=1)
        require('"stage":"node"' in result.stderr and '"execution_started":false' in result.stderr, "bad Node archive ran before verification")
        require(not (bad_node["state"] / "credential.key").exists(), "bad runtime enrolled a worker")
        self.receipt("setup.corruption_and_pinned_node", node_sha256=NODE_SHA, fallback_executed=True, corrupted_node_rejected=True)

        self.checked("/api/v1/admin/workers/" + first_id + "/revoke", self.admin, "POST")
        self.until(lambda: (primary["state"] / "run-stop.json").exists(), "revoked subscriber did not retain terminal outcome", timeout=35)
        self.hook(primary, want=1)
        self.install(primary, self.prompt(), want=1)
        workers = self.checked("/api/v1/admin/workers", self.admin)[0]["workers"]
        require(len(workers) == 2, "revoked setup silently enrolled another identity")
        self.receipt("setup.revocation_boundary", no_reenrollment=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    parser.add_argument("--package-receipt", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = WorkerSetup(args)
    proxy = assets = None
    try:
        h.baseline()
        h.setup()
        proxy = h.proxy = TLSFixture(h, "http://127.0.0.1:1")
        config = h.configuration()
        config["server"]["public-url"] = proxy.origin
        config["worker-package"] = {"version": h.package["version"], "sha256": h.package["sha256"]}
        config["limits"] = {"max-jobs": 8, "in-flight-per-worker": 1}
        _, h.origin_url, _ = h.launch(config)
        proxy.target = urllib.parse.urlsplit(h.origin_url)
        h.ready(h.resources["containers"][-1], h.origin_url)
        assets = h.assets = Assets(h, h.package["archive"])
        h.docker("build", "--label", LABEL + "=" + h.owner, "-f", "tests/integration/worker-setup.Dockerfile", "-t", h.fixture_image, ".", timeout=240)
        h.fixture_image_created = True
        h.exercise()
        h.private("results.json", json.dumps({"suite": "worker-setup", "source_sha": args.source_sha, "package_sha256": h.package["sha256"], "muse_qualified": False, "receipts": h.receipts}))
    finally:
        if assets:
            assets.close()
        if proxy:
            proxy.close()
        h.cleanup()
        if h.fixture_image_created:
            info = json.loads(h.docker("image", "inspect", h.fixture_image).stdout)[0]
            require(info["Config"]["Labels"][LABEL] == h.owner, "fixture image owner changed")
            h.docker("image", "rm", h.fixture_image)
            require(h.docker("image", "inspect", h.fixture_image, success=False).returncode != 0, "fixture image cleanup unproven")
            h.private("setup-image-cleanup.json", json.dumps({"removed": h.fixture_image, "image_id": info["Id"], "owner": h.owner}))


if __name__ == "__main__":
    main()
