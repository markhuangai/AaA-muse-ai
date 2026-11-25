#!/usr/bin/env python3
import argparse
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import threading
import tarfile
import time
import urllib.parse
import urllib.request

from inference import Inference
from native_cron import utc_stamp
from portal import source_identity
from service import LABEL, require
from worker_setup import WorkerSetup
from worker_tls import TLSFixture

STOCK = "ghcr.io/markhuangai/aaa-muse-ai@sha256:2bf7b945914881dd5e989cac135bc94273090b4f97d431984d3ee697d7783467"
STOCK_SHA = "86af219e72b7ac44ce19c41ca7557277d299132d49de2f1dab9240c6834baf14"
ARCHIVED_1_1 = "ghcr.io/markhuangai/aaa-muse-ai@sha256:ba41ab48c3a1d346140af03327a4e684e855d1b8b352b65cd0b266ee4622e172"
ARCHIVED_1_1_SHA = "9cb8c77e7c0825f19e6c12ea4e8f36f2b20556ff559bae20848b3e618029fd66"
RC, NEXT, STABLE = "1.2.0-rc.2", "1.2.0-rc.10", "1.2.0"
PUBLISHED = "1.1.1-rc.1"
PUBLISHED_IMAGE = "ghcr.io/markhuangai/aaa-muse-ai@sha256:abcd447e82d93ae50673a14f448dc61718f4dc8bccd36dc7efab6bf66a738f66"
PUBLISHED_SHA = "b75b6be0788e453315c6681bba90f25e205f5ab43c226bf214d5cd431ee9eb5b"
BROKEN = "1.2.0-rc.1"


class Releases:
    def __init__(self, h, archives):
        self.public = h.root.resolve() / "public-fixture"
        self.public.mkdir(mode=0o700)
        shutil.copyfile(h.proxy.cert, self.public / "ca.pem")
        self.archives = archives
        self.mode = ""
        self.received = threading.Event()
        self.release = threading.Event()
        self.requests = []
        self.fail_over = None
        fixture = self

        class Download(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                version = self.path.lstrip("/")
                fixture.requests.append({"version": version, "authorization": bool(self.headers.get("Authorization"))})
                if fixture.mode == "paused":
                    fixture.received.set()
                    if not fixture.release.wait(24):
                        self.send_error(504)
                        return
                if fixture.fail_over:
                    h.proxy.target = urllib.parse.urlsplit(fixture.fail_over)
                if fixture.mode == "missing" or version not in fixture.archives:
                    self.send_error(404)
                    return
                body = b"corrupted pair" if fixture.mode == "corrupt" else Path(fixture.archives[version]).read_bytes()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Download)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(h.proxy.cert), str(h.root.resolve() / "tls-key.pem"))
        self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        shim = self.public / "bin"
        shim.mkdir(mode=0o755)
        (shim / "curl").write_text("""#!/usr/bin/env bash
set -euo pipefail
args=("$@")
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    https://github.com/markhuangai/AaA-muse-ai/releases/download/v*)
      release=${args[$i]#*/download/v}; release=${release%%/*}
      args[$i]="https://localhost:AAA_ASSET_PORT/$release" ;;
  esac
done
exec /usr/bin/curl "${args[@]}"
""".replace("AAA_ASSET_PORT", str(self.server.server_port)))
        (shim / "curl").chmod(0o755)

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


class Updates(WorkerSetup):
    def __init__(self, args):
        Inference.__init__(self, args)
        self.fixture_image = self.owner + ":worker"
        self.images = []
        self.identities = {}
        self.assets = self.proxy = None

    def build_image(self, context, version, digest):
        name = self.owner + ":" + version
        self.docker("build", "--provenance=false", "--label", LABEL + "=" + self.owner,
                    "--build-arg", "SOURCE_SHA=" + self.args.source_sha, "--build-arg", "SOURCE_DIRTY=" + self.args.source_dirty,
                    "--build-arg", "PRODUCT_VERSION=" + version, "--build-arg", "WORKER_SHA256=" + digest,
                    "-t", name, str(context), timeout=420)
        self.images.append(name)
        info = json.loads(self.docker("image", "inspect", name).stdout)[0]
        self.identities[version] = {"image_id": info["Id"], "worker_sha256": digest, "version": version}
        return name

    def packages(self):
        releases = {}
        root = Path.cwd()
        for version in (BROKEN, RC, NEXT, STABLE):
            env = {**os.environ, "WORKER_RELEASE_VERSION": version}
            worker = root / "worker"
            with (self.root / ("build-" + version + ".log")).open("w") as log:
                subprocess.run(["npm", "run", "build"], cwd=worker, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=80)
                subprocess.run(["node", "scripts/package.mjs"], cwd=worker, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
            receipt = json.loads((root / ".artifacts/worker-package/latest.json").read_text())
            require(receipt["source"]["source_sha"] == self.args.source_sha and receipt["version"] == version, "packed release source mismatch")
            if version == BROKEN:
                archive = self.invalid_hook_archive(receipt["archive"])
                receipt = {**receipt, "archive": str(archive), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
            releases[version] = {**receipt, "image": self.build_image(root, version, receipt["sha256"])}
        published = (("1.0.0", STOCK, STOCK_SHA), ("1.1.0", ARCHIVED_1_1, ARCHIVED_1_1_SHA), (PUBLISHED, PUBLISHED_IMAGE, PUBLISHED_SHA))
        for version, image, digest in published:
            archive = self.root.resolve() / ("published-" + version + ".tgz")
            url = "https://github.com/markhuangai/AaA-muse-ai/releases/download/v" + version + "/markhuangai-aaa-muse-worker-" + version + ".tgz"
            with urllib.request.urlopen(url, timeout=40) as stream:
                archive.write_bytes(stream.read(4 * 1024 * 1024))
            require(hashlib.sha256(archive.read_bytes()).hexdigest() == digest, "historical archive identity mismatch")
            self.docker("pull", image, timeout=120)
            self.identities[version] = {"image_id": image.split("@")[1], "worker_sha256": digest, "version": version}
            releases[version] = {"image": image, "sha256": digest, "version": version, "archive": str(archive)}
        return releases

    def invalid_hook_archive(self, source):
        result = self.root.resolve() / "invalid-hook-worker.tgz"
        with tarfile.open(source, "r:gz") as original, tarfile.open(result, "w:gz") as changed:
            for member in original:
                stream = original.extractfile(member) if member.isfile() else None
                if member.name == "package/setup/hook.sh":
                    payload = stream.read() + b"\nif (then\n"
                    member.size = len(payload)
                    stream = io.BytesIO(payload)
                changed.addfile(member, stream)
        return result

    def paired(self, version, primary=True, state_volume=None):
        self.args.image = self.releases[version]["image"]
        instance, address, _ = self.launch(state_volume=state_volume)
        self.ready(instance, address)
        self.worker_pairs.pop(address, None)
        if primary:
            self.package = self.releases[version]
            self.broker, self.origin_url = instance, address
            self.worker_pairs.pop(self.proxy.origin, None)
            self.proxy.target = urllib.parse.urlsplit(address)
        return instance, address

    def stop(self, instance):
        self.docker("stop", "-t", "5", instance)

    def allow_pair(self, version):
        previous = self.broker
        self.stop(previous)
        self.paired(version)
        time.sleep(30.5)

    def record_update(self, worker, expected, version=None):
        update = self.status(worker)["worker_update"]
        require(update.get("state") == expected and (version is None or update["version"] == version), "unexpected worker update projection: " + str(update.get("state")))
        return update

    def job(self, worker, marker, *, fail=False):
        experiment = self.create(worker, marker, tools=False, timeout=300)
        self.claim_work(worker, experiment["current_job_id"])
        self.start_work(worker)
        if fail:
            self.abort(worker)
        else:
            result = self.native_cli(worker, "decision-submit", "--job-id", experiment["current_job_id"], "--input", "-",
                                     input_text=json.dumps({"type": "final", "text": marker}))
            require(json.loads(result)["outcome"] == "accepted", "real work after version switch was not accepted")
        require(self.tick(worker)["outcome"] == "settled", "same pair did not settle its job")
        return self.experiment(experiment["id"])

    def browser(self, worker, interruptions, never, stage="Updating", failure=""):
        fixture = self.private("version-browser.json", json.dumps({
            "origin": self.proxy.origin, "password": self.portal, "worker": worker["worker"]["id"],
            "interruptions": [{"reason": item["reason_message"], "task": item["id"]} for item in interruptions],
            "directory": str(self.root.resolve()), "never": never, "stage": stage, "failure": failure,
        }))
        with (self.root / "version-browser.log").open("w") as log:
            subprocess.run(["node", "tests/portal/worker-updates.mjs", str(fixture)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=70)

    def legacy_install(self, version):
        self.paired(version)
        legacy = self.environment("legacy-" + version)
        legacy["state"] = legacy["home"] / ".local/state/aaa-muse-worker-v1"
        self.install(legacy, self.prompt())
        goal = "archived-" + legacy["worker"]["id"]
        checker = json.loads(self.native_cli(legacy, "cron-describe", "--goal-id", goal))
        expected = {**checker, "native_job_id": "legacy-checker-" + version.replace(".", "-")}
        for command, body in (("cron-authorize-registration", {"goal_id": goal, "complete": True, "matches": []}),
                              ("cron-confirm", {"matches": [expected]})):
            self.native_cli(legacy, command, "--input", "-", input_text=json.dumps(body))
        legacy["checker"] = expected["native_job_id"]
        self.legacy_tick(legacy, "before-switch")
        self.stop(self.broker)
        return legacy

    def legacy_tick(self, legacy, invocation):
        raw = self.native_cli(legacy, "cron-check", "--input", "-", input_text=json.dumps({
            "checker_job_id": legacy["checker"], "checker_run_id": invocation, "scheduled_at": utc_stamp()}))
        require(json.loads(raw)["outcome"] == "idle", "archived worker did not finish its poll quietly")

    def enrollment_boundary(self, next_origin, headers):
        registration = self.issue()
        data = {"enrollment_code": registration["enrollment_code"], "phase": "prepare"}
        route = "/api/v1/worker/enroll"
        self.checked(route, None, "POST", data, want=426, origin=next_origin, headers=headers)
        staged, _ = self.checked(route, None, "POST", data, want=201)
        key = staged["credential"]
        self.secrets.append(key)
        activation = {**data, "phase": "activate"}
        self.checked(route, key, "POST", activation, want=426, origin=next_origin, headers=headers)
        self.checked("/api/v1/worker/status", key, want=401)
        self.checked(route, key, "POST", activation, want=201)
        self.receipt("worker_updates.exact_enrollment", prepare_refused=True, activate_refused=True, original_code_preserved=True)

    def work_boundary(self, worker, next_origin, headers):
        begin = utc_stamp()
        current = self.origin_url
        experiment = self.create(worker, "work cannot migrate between broker releases", tools=False)
        task = experiment["id"]
        grant = self.claim_work(worker, experiment["current_job_id"])
        brief = self.start_work(worker)
        route = "/api/v1/worker/jobs/" + brief["job_id"]
        key = worker["credential"]
        local = self.worker_capture(worker, "--since", begin, "--until", utc_stamp())
        pull = next(event["input"] for event in local if event["msg"] == "worker.http_exchange" and
                    event["route"] == "/api/v1/worker/hook/pull" and (event["output"].get("job") or {}).get("operation_id") == task)
        self.checked("/api/v1/worker/pull", key, "POST", pull, want=426, origin=next_origin, headers=headers)

        work = worker["work"]
        start = {"protocol_version": 1, "claim_id": grant["claim_id"], "generation": grant["generation"],
                 "launch_id": grant["launch_id"], "native_job_id": work["native_job_id"],
                 "verification": {"reference": grant["claim_id"], "native_job_id": work["native_job_id"],
                                  "native_run_id": work["native_run_id"], "status": "running"}}
        requests = (("POST", "/bind"), ("POST", "/start"), ("POST", "/presence"), ("POST", "/interrupt"),
                    ("GET", "/media/prompt"), ("GET", "/media/image"), ("GET", "/media/receipt"), ("PUT", "/artifact"))
        for method, path in requests:
            status, _, raw = self.api(route + path, key, method, start if method == "POST" else None, origin=next_origin,
                                      headers=headers, raw=b"controlled binary" if method == "PUT" else None)
            require(status == 426 and json.loads(raw)["error"] == "update_required", "mismatched job route acquired authority")

        decision = json.dumps({"type": "final", "text": "same claim after returning to its pair"})
        self.proxy.target = urllib.parse.urlsplit(next_origin)
        try:
            self.native_cli(worker, "decision-submit", "--job-id", brief["job_id"], "--input", "-", input_text=decision, want=1)
            require(self.status(worker)["current_claim"]["claim_id"] == grant["claim_id"] and
                    self.experiment(task)["state"] == "inference", "refusal changed claim or result state")
        finally:
            self.proxy.target = urllib.parse.urlsplit(current)
        require(self.tick(worker)["outcome"] == "settled" and self.experiment(task)["state"] == "completed",
                "restoring the original pair did not reconcile the pending decision")

        local = self.worker_capture(worker, "--since", begin, "--until", utc_stamp())
        local = [event for event in local if event.get("operation_id") == task]
        refusal = next(event for event in local if event.get("msg") == "worker.decision_rejected")
        accepted = next(event for event in local if event.get("msg") == "worker.operation_accepted")
        remote = self.report_evidence("request_id", refusal["request_id"], next_origin)
        rejected = next(event for event in remote if event["msg"] == "worker.update_required")
        original = self.report_evidence("operation_id", task, current)
        require(rejected["level"] == refusal["level"] == "WARN" and rejected["expected_digest"] == refusal["observed_digest"] and
                rejected["observed_digest"] == refusal["expected_digest"] and rejected["service_version"] == refusal["service_version"] and
                rejected["corrective_action"] and refusal["corrective_action"] and
                [event["request_id"] for event in original if event["msg"] == "decision.accepted"] == [accepted["request_id"]] and
                sum(event["msg"] == "job.work_started" for event in original) == 1,
                "worker and both brokers could not reconstruct the refused and reconciled operation")
        self.receipt("worker_updates.claim_preserved_across_pairs", operation_id=task, rejected_routes=len(requests) + 2,
                     capture_complete=True, accepted_once=True)

    def held_update(self, next_origin, headers):
        worker = self.new_worker()
        peer = self.pull_peer(worker)
        experiment = self.create(worker, "held work prevents an update", tools=False)
        grant = peer.poll()
        require(grant["job_id"] == experiment["current_job_id"], "held update fixture did not acquire work")
        result, _ = self.checked("/api/v1/worker/pull", worker["credential"], "POST", peer.poll_input(),
                                 origin=next_origin, headers=headers)
        require(result == {"job": None} and self.status(worker)["current_claim"]["claim_id"] == grant["claim_id"],
                "held worker received an update or changed work")
        brief, _, _ = peer.begin(grant)
        peer.settle(brief)
        self.receipt("worker_updates.held_update_refused", same_claim=True)

    def mixed_pairs(self, worker):
        other, next_origin = self.paired(NEXT, primary=False)
        current = self.origin_url
        headers = self.worker_pair_headers()
        try:
            self.enrollment_boundary(next_origin, headers)
            self.work_boundary(worker, next_origin, headers)
            self.held_update(next_origin, headers)
            self.proxy.target = urllib.parse.urlsplit(next_origin)
            require(self.tick(worker)["outcome"] == "idle", "mixed release pins offered an update")
            status = self.record_update(worker, "deferred", RC)
            require(status["reason"] == "mixed_broker_releases", "mixed release refusal lost its cause")
        finally:
            self.proxy.target = urllib.parse.urlsplit(current)
            self.stop(other)
        self.receipt("worker_updates.mixed_release_pins", update_deferred=True, archived_workers_unchanged=True)

    def published_install(self):
        self.paired(PUBLISHED)
        worker = self.environment("published-first-hop")
        self.install(worker, self.prompt())
        goal = "controlled-goal-" + worker["worker"]["id"]
        definition = json.loads(self.native_cli(worker, "hook-describe", "--goal-id", goal))
        hook, watchdog = definition["hook"], definition["watchdog"]
        require(watchdog["every"] == "1h", "published worker did not retain its hourly watchdog")
        worker.update({"checker": hook["id"], "tick_number": 0})
        dry_run = json.loads(self.hook(worker, dry=True).stdout)
        require(dry_run["action"] == "silent", "published hook dry run was not silent")
        readback = {"goal_id": goal, "complete": True, "dry_run": "silent", "hooks": [hook],
                    "watchdogs": [{**watchdog, "native_job_id": "controlled-published-watchdog"}]}
        require(self.registration(worker, "hook-confirm", readback)["outcome"] == "registered",
                "published worker could not verify its native registration")
        require(self.tick(worker)["outcome"] == "idle", "published worker could not authenticate")
        record = json.loads((worker["state"] / "installation.json").read_text())
        require("skill_path" not in record, "published fixture was not the original installation")
        return worker

    def published_first_hop(self, worker):
        credential = worker["credential"]
        paths = [worker["home"] / "hooks/scripts" / worker["checker"] / "detector.sh",
                 worker["home"] / "workspace/skills" / worker["checker"] / "SKILL.md",
                 worker["home"] / ".local/share/aaa-muse-worker-hook-v1/bin/aaa-muse-worker"]
        before = [path.read_bytes() for path in paths]
        require(self.tick(worker)["outcome"] == "update_failed" and before == [path.read_bytes() for path in paths],
                "published updater activated a pinned archive with an invalid shell template")
        self.record_update(worker, "failed", PUBLISHED)
        self.allow_pair(RC)
        paths[1].parent.chmod(0o500)
        try:
            require(self.tick(worker)["outcome"] == "update_failed" and before == [path.read_bytes() for path in paths],
                    "published updater activated with an unwritable skill directory")
        finally:
            paths[1].parent.chmod(0o700)
        failed = self.record_update(worker, "failed", PUBLISHED)
        require(failed["retry_at"], "directory failure did not establish backoff")
        self.assets.mode = "corrupt"
        try:
            first = self.worker_control(worker, "ops", {"protocol_version": 1, "submission_id": "legacy-retry-backoff", "kind": "retry_update"})
            require(self.tick(worker)["outcome"] == "update_failed", "retry did not bypass the scheduled backoff")
            details = self.worker_control(worker, "ops/" + first["id"])
            require(details["state"] == "failed" and details["reason"] == "archive_digest_mismatch", "failed retry did not settle atomically")
        finally:
            self.assets.mode = ""
        second = self.worker_control(worker, "ops", {"protocol_version": 1, "submission_id": "legacy-retry-manual", "kind": "retry_update"})
        require(self.tick(worker)["outcome"] == "update_awaiting_confirmation", "retry did not bypass nil RetryAt")
        self.tick(worker)
        self.record_update(worker, "confirmed", RC)
        done = self.worker_control(worker, "ops/" + second["id"])
        require(done["state"] == "succeeded" and not done["held"], "fresh paired pull did not settle the bound retry")
        installation = json.loads((worker["state"] / "installation.json").read_text())
        for key, path, mode in (("detector_sha256", paths[0], 0o700), ("skill_sha256", paths[1], 0o600)):
            require(installation[key] == hashlib.sha256(path.read_bytes()).hexdigest() and path.stat().st_mode & 0o777 == mode,
                    "first-hop asset digest or mode differs")
        require("skill_path" in installation and credential == (worker["state"] / "credential.key").read_text().strip(),
                "first-hop update changed authority or omitted the skill path")
        old = json.loads((worker["state"] / "hook-expected.json").read_text())
        registered = json.loads((worker["state"] / "hook-installation.json").read_text())
        self.worker_control(worker, "agent-tasks", {"protocol_version": 1, "submission_id": "before-hook-v2", "prompt": "Controlled prompt"}, want=409)
        update = json.loads(self.native_cli(worker, "hook-upgrade-describe", "--worker-id", worker["worker"]["id"], "--goal-id", old["goal_id"]))
        require(update["watchdog"] == old["watchdog"], "hook prompt upgrade changed the published watchdog definition")
        observed = lambda expected: {"goal_id": expected["goal_id"], "complete": True, "dry_run": "silent", "hooks": [expected["hook"]],
                                    "watchdogs": [{**expected["watchdog"], "native_job_id": registered["watchdog_job_id"]}]}
        self.registration(worker, "hook-confirm", observed(old), want=1)
        self.registration(worker, "hook-confirm", observed(update))
        self.tick(worker)
        require(self.worker_projection(worker)[0]["agent_tasks_ready"], "confirmed prompt did not enable the paired task capability")
        self.receipt("worker_updates.published_first_hop", archived=PUBLISHED, malformed_hook_refused=True, unwritable_untouched=True,
                     retry_backoff_bypassed=True, retry_nil_bypassed=True, skill_path_backfilled=True, same_worker=True)

    def exercise(self):
        self.setup()
        self.releases = self.packages()
        self.proxy = TLSFixture(self, "http://127.0.0.1:1")
        self.assets = Releases(self, {key: value["archive"] for key, value in self.releases.items()})
        self.docker("build", "--label", LABEL + "=" + self.owner, "-f", "tests/integration/worker-setup.Dockerfile", "-t", self.fixture_image, ".", timeout=240)
        self.images.append(self.fixture_image)
        legacy = [self.legacy_install(version) for version in ("1.0.0", "1.1.0")]
        published = self.published_install()
        self.allow_pair(BROKEN)
        self.published_first_hop(published)
        worker = self.environment("managed")
        self.install(worker, self.prompt())
        self.checker(worker)
        original = worker["credential"]
        self.until(lambda: self.tick(worker)["outcome"] == "idle", "managed hook did not make authenticated contact")
        for old in legacy:
            self.legacy_tick(old, "after-switch")
            projected, _ = self.worker_projection(old)
            require(projected["worker_update"]["state"] == "migration_required" and projected["current_claim"] is None,
                    "archived worker received job authority or no migration status")
        never = self.new_worker()
        self.browser(legacy[0], [], never["worker"]["id"], stage="Migration required")

        modern, current_origin = self.broker, self.origin_url
        self.args.image = self.releases["1.1.0"]["image"]
        incompatible, _, _ = self.launch(expect_startup=False)
        require(self.docker("wait", incompatible, timeout=30).stdout.strip() != "0" and
                "schema_version_incompatible" in self.logs(incompatible), "schema-five broker accepted schema six")
        archived, old_origin = self.paired("1.1.0", primary=False, state_volume=self.volume("archived-schema-five"))
        queued = self.create(worker, "archived broker cannot commit a hook pull", tools=False)
        self.proxy.target = urllib.parse.urlsplit(old_origin)
        try:
            refused = self.hook(worker, invocation="archived-refused", want=1)
            require("hook_broker_unavailable" in refused.stderr, "archived broker did not give the actionable refusal")
        finally:
            self.proxy.target = urllib.parse.urlsplit(current_origin)
            self.stop(archived)
        self.claim_work(worker, queued["current_job_id"])
        self.start_work(worker)
        self.abort(worker)
        require(self.tick(worker)["outcome"] == "settled", "archived peer reserved or duplicated the queued work")
        self.receipt("worker_updates.archived_pairs_refused", releases=["1.0.0", "1.1.0"], held_claims_drained=True)

        self.broker = modern
        self.mixed_pairs(worker)
        next_worker = self.environment("forward-rc")
        self.install(next_worker, self.prompt())
        self.checker(next_worker)
        missing_worker = self.environment("missing-archive")
        self.install(missing_worker, self.prompt())
        self.checker(missing_worker)
        self.allow_pair(NEXT)
        self.assets.mode = "missing"
        require(self.tick(missing_worker)["outcome"] == "update_failed", "missing archive did not preserve the old launcher")
        missing = self.record_update(missing_worker, "failed", RC)
        require(missing["reason"] == "archive_unavailable" and self.native_cli(missing_worker, "--version").strip() == RC,
                "missing archive changed the running pair")
        self.diagnosis(missing_worker, missing["id"], "archive_unavailable")
        self.assets.mode = ""
        require(self.tick(next_worker)["outcome"] == "update_awaiting_confirmation", "strictly newer RC was not staged")
        self.tick(next_worker)
        self.record_update(next_worker, "confirmed", NEXT)
        self.receipt("worker_updates.forward_rc_order", previous=RC, installed=NEXT)
        self.assets.mode = "corrupt"
        failure = self.tick(worker)
        require(failure["outcome"] == "update_failed", "corrupt archive did not stop silent activation")
        update = self.record_update(worker, "failed", RC)
        self.diagnosis(worker, update["id"], "archive_digest_mismatch")
        require(self.tick(worker)["outcome"] == "idle", "failed update received job authority")
        notice = json.loads(self.native_cli(worker, "watchdog-check"))
        require(notice["notify"] and any(item["kind"] == "update_failed" for item in notice["incidents"]),
                "hourly watchdog lost the failed update after idle contact")
        require(not json.loads(self.native_cli(worker, "watchdog-check"))["notify"], "watchdog repeated a failed update notice")

        self.allow_pair(STABLE)
        # The old journal was closed by a failed attempt, so the explicit retry can clear broker suppression.
        retry = self.worker_control(worker, "ops", {"protocol_version": 1, "submission_id": "newer-worker-retry", "kind": "retry_update"})
        self.assets.mode = ""
        require(self.tick(worker)["outcome"] == "update_awaiting_confirmation", "forward idle switch did not activate the verified pair")
        self.proxy.lose_worker_replies["/api/v1/worker/update"] = 1
        self.tick(worker, want=1)
        self.tick(worker)
        self.record_update(worker, "confirmed", STABLE)
        require(self.worker_control(worker, "ops/" + retry["id"])["state"] == "succeeded", "newer retry did not wait for paired pull")
        require(worker["credential"] == original and (worker["state"] / "credential.key").read_text().strip() == original,
                "auto-update replaced the worker identity")
        recovered = json.loads(self.native_cli(worker, "watchdog-check"))
        require(recovered["notify"] and recovered["outcome"] == "recovered", "watchdog missed update recovery")
        require(self.job(worker, "stable paired job")["state"] == "completed", "confirmed pair could not serve a job")
        self.receipt("worker_updates.forward_confirmation", launch_identity_preserved=True, verified_candidate=True, watchdog_recovered=True)

        self.allow_pair(RC)
        require(self.tick(worker)["outcome"] == "idle" and self.record_update(worker, "deferred", STABLE)["reason"] == "update_requires_newer_pair",
                "older broker target was installed or granted work")
        require(self.native_cli(worker, "--version").strip() == STABLE, "worker downgraded its own launcher")
        self.receipt("worker_updates.older_target_refused", installed=STABLE, deployed=RC)

    def diagnosis(self, worker, operation, expected, primary=None, fallback=None):
        decoded = self.native_cli(worker, "diagnostics-export", "--operation-id", operation, "--decode")
        envelope, *records = [json.loads(line) for line in decoded.splitlines() if line]
        require(envelope["complete"] and not envelope["omissions"], "worker operation export was incomplete")
        local = next(record for record in records if record.get("msg") == "worker.update_verification_failed")
        fallback_local = next(record for record in records if record.get("msg") == "worker.update_fallback")
        peers = self.report_evidence("operation_id", operation, primary)
        begin = next(record for record in peers if record.get("msg") == "worker.update_state_changed" and record["stage"] == "begin")
        remote = self.report_evidence("operation_id", operation, fallback) if fallback else peers
        failure = next(record for record in remote if record.get("msg") == "worker.update_fallback")
        require(local["level"] == "ERROR" and local["reason"] == expected and failure["level"] == "WARN" and failure["cause"] == expected,
                "protected logs omitted the verification and fallback causes")
        require(local["expected_digest"] == failure["expected_digest"] == begin["expected_digest"] and
                local["from_version"] == failure["reported_version"] and local["target_version"] == failure["target_version"] and
                local["worker_id"] == failure["worker_id"] and local["attempt"] == failure["attempt"] == begin["attempt"] and
                local["duration_ms"] >= 0 and failure["duration_ms"] >= 0 and local["stage"] == "download_and_verification" and
                failure["stage"] == "failed" and local["corrective_action"] and failure["corrective_action"] and
                fallback_local["observed_digest"] == failure["observed_digest"],
                "protected logs could not reconstruct version, digest, attempt, stage, timing and corrective action")
        if fallback:
            require(begin["instance_id"] != failure["instance_id"] and "HTTPS" in failure["corrective_action"], "cross-broker retry evidence was incomplete")
        if expected == "archive_digest_mismatch":
            require(len(local["observed_digest"]) == 64 and local["observed_digest"] != local["expected_digest"],
                    "verification failure omitted the observed archive digest")
        self.receipt("worker_updates.log_only", cause=expected, two_brokers=bool(fallback), capture_complete=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", required=True)
    options = parser.parse_args()
    os.umask(0o077)
    h = Updates(options)
    source = source_identity()
    start = time.monotonic()
    outcome = "failed"
    try:
        h.exercise()
        require(source == source_identity(), "source changed while running update acceptance")
        outcome = "passed"
    finally:
        if h.assets:
            h.assets.close()
        if h.proxy:
            h.proxy.close()
        h.cleanup()
        for image in h.images:
            info = json.loads(h.docker("image", "inspect", image).stdout)[0]
            require(info["Config"]["Labels"][LABEL] == h.owner, "suite image ownership changed")
            h.docker("image", "rm", image)
            require(h.docker("image", "inspect", image, success=False).returncode != 0, "fixture image cleanup unverified")
        target = Path(".artifacts/ci/worker-updates")
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        receipt = {"outcome": outcome, "source": source, "images": h.identities, "cases": h.receipts,
                   "environment": "controlled", "qualifies_live_muse": False, "elapsed_ms": round((time.monotonic() - start)*1000),
                   "cleanup": {"containers": len(h.resources["containers"]), "volumes": len(h.resources["volumes"]),
                               "networks": len(h.resources["networks"]), "images": len(h.images)}}
        (target / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
