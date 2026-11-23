#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import threading
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
RC, STABLE, NEXT = "1.0.1-rc.8", "1.0.1", "2.0.0"


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
        copied = self.root / "major-fixture"
        for name in ("worker", "portal", "internal", "cmd"):
            shutil.copytree(root / name, copied / name, ignore=shutil.ignore_patterns("dist", "node_modules"))
        for name in ("Dockerfile", ".dockerignore", "go.mod", "go.sum", "package.json", "package-lock.json"):
            shutil.copyfile(root / name, copied / name)
        for version, from_majors in ((RC, ""), (STABLE, ""), ("2.0.1", ""), (NEXT, "1")):
            context = root if version in (RC, STABLE) else copied
            if context == copied:
                manifest = context / "worker/package.json"
                metadata = json.loads(manifest.read_text())
                metadata["version"] = version
                metadata["aaa_muse_update"]["from_majors"] = from_majors
                manifest.write_text(json.dumps(metadata))
            env = {**os.environ, "WORKER_RELEASE_VERSION": version}
            worker = context / "worker"
            with (self.root / ("build-" + version + ".log")).open("w") as log:
                subprocess.run(["npm", "run", "build"], cwd=worker, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=80)
                subprocess.run(["node", "scripts/package.mjs"], cwd=worker, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
            receipt = json.loads((context / ".artifacts/worker-package/latest.json").read_text())
            require(receipt["source"]["source_sha"] == self.args.source_sha and receipt["version"] == version, "packed release source mismatch")
            releases[version] = {**receipt, "image": self.build_image(context, version, receipt["sha256"])}
        stock = self.root.resolve() / "stock-1.0.0.tgz"
        url = "https://github.com/markhuangai/AaA-muse-ai/releases/download/v1.0.0/markhuangai-aaa-muse-worker-1.0.0.tgz"
        with urllib.request.urlopen(url, timeout=40) as stream:
            stock.write_bytes(stream.read(4 * 1024 * 1024))
        require(hashlib.sha256(stock.read_bytes()).hexdigest() == STOCK_SHA, "historical archive identity mismatch")
        self.docker("pull", STOCK, timeout=120)
        self.identities["1.0.0"] = {"image_id": STOCK.split("@")[1], "worker_sha256": STOCK_SHA, "version": "1.0.0"}
        releases["1.0.0"] = {"image": STOCK, "sha256": STOCK_SHA, "version": "1.0.0", "archive": str(stock)}
        return releases

    def paired(self, version, primary=True):
        self.args.image = self.releases[version]["image"]
        self.package = self.releases[version]
        instance, address, _ = self.launch()
        self.ready(instance, address)
        if primary:
            self.broker, self.origin_url, self.worker_version = instance, address, None
            self.proxy.target = urllib.parse.urlsplit(address)
        return instance, address

    def stop(self, instance):
        self.docker("stop", "-t", "5", instance)

    def allow_pair(self, version):
        previous = self.broker
        self.stop(previous)
        self.paired(version)
        time.sleep(30.5)

    def native_cli(self, worker, *args, input_text=None, want=0):
        entry = worker.get("weekly_usage_fixture_worker", [worker["receipt"]["launcher"]])
        return self.command(worker, [*entry, *args], input_text=input_text, want=want,
                            extra=("-e", "PATH=/fixture/bin:/usr/local/bin:/usr/bin:/bin")).stdout

    def check_weekly_wire_compatibility(self, worker):
        source = Path(self.releases[RC]["archive"]).parent / "unpacked" / "package"
        helper = self.assets.public / "usage-worker"
        shutil.copytree(source, helper)
        command = self.assets.public / "bin" / "subscription-status"
        command.write_text(r"""#!/bin/sh
test "$#" = 1 && test "$1" = status || exit 1
printf '%s\n' 'Usage: 33% of free weekly limit.' 'Weekly limit resets Nov 29 at 7:49 AM EST' 'Additional tokens: 89% used (provider-private)'
""")
        command.chmod(0o755)
        worker["weekly_usage_fixture_worker"] = ["node", "/fixture/usage-worker/dist/main.js"]
        try:
            check = self.tick(worker)
            require(check["outcome"] == "idle", "the stock broker rejected the new helper's usage contact")
            decoded = self.native_cli(worker, "diagnostics-export", "--decode")
            records = [json.loads(line) for line in decoded.splitlines()]
            require(any(record.get("msg") == "worker.http_exchange" and record.get("http_status") == 200 and
                        record.get("checker_run_id") == check["checker_run_id"] and record.get("weekly_usage", {}).get("used_percent") == 33
                        for record in records),
                    "the new package did not include its normalized reading in the contacted check")
            require("provider-private" not in decoded, "private command output entered worker captures")
        finally:
            worker.pop("weekly_usage_fixture_worker")
        self.receipt("worker_updates.weekly_usage_new_helper_old_broker", stock_image=STOCK, worker_version=RC)

    def record_update(self, worker, expected, version=None):
        update = self.status(worker)["worker_update"]
        require(update.get("state") == expected and (version is None or update["version"] == version), "unexpected worker update projection: " + str(update.get("state")))
        return update

    def job(self, worker, marker, *, fail=False):
        experiment = self.create(worker, marker, tools=False, timeout=300)
        self.claim_work(worker, experiment["current_job_id"])
        self.start_work(worker)
        if fail:
            self.observe(worker, "failed")
        else:
            result = self.native_cli(worker, "decision-submit", "--job-id", experiment["current_job_id"], "--input", "-",
                                     input_text=json.dumps({"type": "final", "text": marker}))
            require(json.loads(result)["outcome"] == "accepted", "real work after version switch was not accepted")
            self.observe(worker, "succeeded")
        return self.experiment(experiment["id"])

    def browser(self, worker, interruptions, never, stage="Updating", failure=""):
        fixture = self.private("version-browser.json", json.dumps({
            "origin": self.proxy.origin, "password": self.portal, "worker": worker["worker"]["id"],
            "interruptions": [{"reason": item["reason_message"], "task": item["id"]} for item in interruptions],
            "directory": str(self.root.resolve()), "never": never, "stage": stage, "failure": failure,
        }))
        with (self.root / "version-browser.log").open("w") as log:
            subprocess.run(["node", "tests/portal/worker-updates.mjs", str(fixture)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=70)

    def replay_settlement(self, worker, first, changed, expected):
        saved = json.loads((worker["state"] / "cron-last-receipt.json").read_text())
        body = {"protocol_version": 1, "submission_id": saved["settlement_id"], "claim_id": saved["claim_id"],
                "generation": saved["generation"], "launch_id": saved["launch_id"], "native_job_id": saved["native_job_id"],
                "native_run_id": saved["native_run_id"], "reason": "execution_confirmed_stopped"}
        path = "/api/v1/worker/jobs/" + saved["job_id"] + "/interrupt"
        for metadata in (first, changed):
            status, _, raw = self.api(path, worker["credential"], "POST", body, headers={"X-Muse-Interruption": metadata})
            require(status == 200 and json.loads(raw) == saved["receipt"] and json.loads(raw)["state"] == expected,
                    "optional metadata changed an already committed settlement receipt")

    def exercise(self):
        self.setup()
        self.releases = self.packages()
        self.proxy = TLSFixture(self, "http://127.0.0.1:1")
        self.assets = Releases(self, {key: value["archive"] for key, value in self.releases.items()})
        self.docker("build", "--label", LABEL + "=" + self.owner, "-f", "tests/integration/worker-setup.Dockerfile", "-t", self.fixture_image, ".", timeout=240)
        self.images.append(self.fixture_image)
        self.paired("1.0.0")
        worker = self.environment("stock", mount_system_tmp=True)
        self.install(worker, self.prompt())
        self.checker(worker)
        checker = (worker["state"] / "cron-installation.json").read_bytes()
        require(self.job(worker, "stock job")["state"] == "completed", "historical worker fixture could not serve real work")
        self.check_weekly_wire_compatibility(worker)
        historical = self.job(worker, "historical failed", fail=True)
        unspecified = self.job(worker, "historical with missing reason", fail=True)
        self.sql("UPDATE aaa_experiments SET data=CAST(json_remove(CAST(data AS TEXT),'$.reason') AS BLOB) WHERE id='" + unspecified["id"] + "'")

        self.stop(self.broker)
        self.paired(RC)
        require(self.tick(worker)["outcome"] == "idle", "legacy worker lost its regular poll")
        require("weekly_usage" not in self.worker_projection(worker)[0], "legacy helper fabricated a weekly report")
        self.record_update(worker, "adoption_required", "1.0.0")
        update, _ = self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/update-prompt", self.admin, "POST", {"origin": self.proxy.origin})
        shell = update["update_prompt"].split("```bash\n", 1)[1].split("```", 1)[0]
        result = self.command(worker, ["bash"], input_text=shell, extra=("-e", "PATH=/fixture/bin:/usr/local/bin:/usr/bin:/bin"))
        require(json.loads(result.stdout)["outcome"] == "update_awaiting_confirmation", "stock adoption did not switch the launcher")
        self.tick(worker)
        self.record_update(worker, "confirmed", RC)
        require((worker["state"] / "cron-installation.json").read_bytes() == checker and
                (worker["state"] / "credential.key").read_text().strip() == worker["credential"], "adoption changed scheduler or credential")
        usage = self.worker_projection(worker)[0]["weekly_usage"]
        require(usage["used_percent"] == 33 and not usage["stale"] and usage["reset_label"] == "Nov 29 at 7:49 AM EST",
                "the original checker did not report normalized usage after adoption")
        self.receipt("worker_updates.stock_adopted", version=RC, original_checker_reports_usage=True)

        historical = self.experiment(historical["id"])
        unspecified = self.experiment(unspecified["id"])
        require("confirmed that the native run stopped" in historical["reason_message"] and
                unspecified["reason_message"] == "No interruption reason was recorded.", "historical interruption fallback was lost")
        never = self.new_worker()["worker"]["id"]
        interrupted = self.job(worker, "native failed", fail=True)
        self.replay_settlement(worker, "failed", "completed", "interrupted")
        require(self.experiment(interrupted["id"])["reason_message"] == interrupted["reason_message"], "replay rewrote the first cause")
        require(interrupted["reason"] == "execution_confirmed_stopped" and "native run failed" in interrupted["reason_message"], "verified interruption was not exposed")
        queued = self.create(worker, "expired queued task", tools=False, timeout=1)
        self.until(lambda: self.experiment(queued["id"])["state"] == "interrupted", "deadline did not interrupt queued request")
        require("before a worker claimed" in self.experiment(queued["id"])["reason_message"], "lost queue deadline detail")
        lost_media, _ = self.checked("/api/v1/media/jobs", self.client, "POST", {"prompt": "Missing file fixture", "submission_id": "missing-file"}, want=202)
        self.claim_work(worker, lost_media["job_id"])
        self.start_work(worker)
        self.observe(worker, "succeeded")
        missing, _ = self.checked("/api/v1/media/jobs/" + lost_media["job_id"], self.client)
        require(missing["status"] == "interrupted" and "could not find" in missing["reason_message"], "missing generated media lost its cause")
        expiry = self.create(worker, "deadline during run", tools=False, timeout=300)
        self.claim_work(worker, expiry["current_job_id"])
        self.start_work(worker)
        self.expire_job({"id": expiry["current_job_id"], "experiment_id": expiry["id"]}, "2000-01-01T00:00:00Z")
        before = self.experiment(expiry["id"])
        self.observe(worker, "failed")
        self.replay_settlement(worker, "failed", "completed", "interrupted")
        require("native run started" in before["reason_message"] and self.experiment(expiry["id"])["reason_message"] == before["reason_message"],
                "late settlement replaced the first timeout")
        causes = [interrupted, self.experiment(queued["id"]), {"id": lost_media["job_id"], "reason_message": missing["reason_message"]}, historical, unspecified]
        self.receipt("interruption.worker_deadline_media_and_historical_replay")

        rc_broker = self.broker
        self.paired(STABLE)
        require(self.tick(worker)["outcome"] == "idle", "conflicting live brokers started an update")
        self.record_update(worker, "deferred", RC)
        held = self.create(worker, "held during broker change", tools=False, timeout=300)
        self.claim_work(worker, held["current_job_id"])
        self.start_work(worker)
        self.stop(rc_broker)
        time.sleep(30.5)
        downloads = len(self.assets.requests)
        require(self.tick(worker)["outcome"] in ("running", "queued", "recovery_pending") and len(self.assets.requests) == downloads,
                "a held native claim downloaded an update")
        require(self.status(worker)["current_claim"]["job_id"] == held["current_job_id"], "update released held work")
        self.native_cli(worker, "decision-submit", "--job-id", held["current_job_id"], "--input", "-",
                        input_text='{"type":"final","text":"held result"}')
        self.observe(worker, "succeeded")
        require(self.experiment(held["id"])["state"] == "completed", "previous release could not settle held work")
        primary_address = self.origin_url
        spare, spare_address = self.paired(STABLE, primary=False)
        self.assets.mode = "missing"
        self.assets.fail_over = spare_address
        failed = self.tick(worker)
        self.assets.fail_over = None
        self.proxy.target = urllib.parse.urlsplit(primary_address)
        require(failed["outcome"] == "update_failed" and failed["cause"] == "archive_unavailable", "unavailable release was not reported")
        status = self.record_update(worker, "failed", RC)
        require(status.get("retry_at") and self.job(worker, "during backoff")["state"] == "completed", "verified old bundle did not serve during backoff")
        self.diagnosis(worker, status["id"], "archive_unavailable", primary_address, spare_address)
        self.browser(worker, causes, never, stage="Update failed", failure="The paired archive is unavailable.")
        self.receipt("worker_updates.missing_archive_backoff")

        self.sql("UPDATE aaa_worker_updates SET data=CAST(json_set(CAST(data AS TEXT),'$.retry_at','2000-01-01T00:00:00Z') AS BLOB)")
        self.assets.mode = "paused"
        with ThreadPoolExecutor(1) as pool:
            upgrading = pool.submit(self.tick, worker, want=137)
            try:
                require(self.assets.received.wait(10), "download checkpoint was not reached")
                updating = self.record_update(worker, "downloading", RC)
                owner = json.loads((worker["state"] / "cron.lock/owner.json").read_text())
                self.command(worker, ["bash", "-c", 'kill -KILL "$1"', "crash-fixture", str(owner["pid"])])
            finally:
                self.assets.release.set()
            upgrading.result(timeout=30)
        self.browser(worker, causes, never)
        self.stop(self.broker)
        self.paired(STABLE)
        self.stop(spare)
        require(self.record_update(worker, "downloading", RC)["id"] == updating["id"],
                "broker restart lost the active update")
        self.assets.mode = ""
        require(self.tick(worker)["outcome"] == "update_awaiting_confirmation", "the actual updater did not resume its staged switch")
        self.proxy.lose_worker_replies["/api/v1/worker/update"] = 1
        self.tick(worker, want=1)
        self.record_update(worker, "awaiting_confirmation", RC)
        self.tick(worker)
        self.record_update(worker, "confirmed", STABLE)
        require(self.job(worker, "stable job")["state"] == "completed", "confirmed version cannot pick up work")
        self.replay_settlement(worker, "completed", "failed", "accepted")
        self.receipt("worker_updates.stable_and_recovery", version=STABLE)

        self.allow_pair(RC)
        require(self.tick(worker)["outcome"] == "update_awaiting_confirmation", "paired rollback was not installed")
        self.tick(worker)
        self.record_update(worker, "confirmed", RC)
        self.receipt("worker_updates.rollback_verified", version=RC)

        self.allow_pair(STABLE)
        self.assets.mode = "corrupt"
        failure = self.tick(worker)
        require(failure["outcome"] == "update_failed" and failure["cause"] == "archive_digest_mismatch", "corrupt archive could proceed")
        self.diagnosis(worker, self.record_update(worker, "failed", RC)["id"], "archive_digest_mismatch")
        self.assets.mode = ""

        self.allow_pair("2.0.1")
        require(self.tick(worker)["outcome"] == "idle", "undeclared major migration acted on the worker")
        self.record_update(worker, "migration_required", RC)
        self.allow_pair(NEXT)
        require(self.tick(worker)["outcome"] == "update_awaiting_confirmation", "declared migration did not install paired bytes")
        self.tick(worker)
        self.record_update(worker, "confirmed", NEXT)
        require(self.job(worker, "new major job")["state"] == "completed", "compatible newer major did not serve real work")
        require(not any(request["authorization"] for request in self.assets.requests), "worker credential reached public releases")
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST")
        self.tick(worker, want=1)
        require(self.experiment(interrupted["id"])["reason_message"] == interrupted["reason_message"],
                "rollback or migration changed the first interruption reason")
        self.receipt("worker_updates.cross_major_and_revocation", version=NEXT, anonymous_downloads=len(self.assets.requests))

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
