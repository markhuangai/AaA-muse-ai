#!/usr/bin/env python3
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import urllib.parse

from history import History
from native_cron import utc_stamp
from portal import Portal, source_identity
from service import LABEL, require
from worker_recovery import WorkerRecovery
from worker_setup import Assets
from worker_tls import TLSFixture


class PackedModel:
    def __init__(self, harness, worker):
        self.h, self.worker = harness, worker
        self.stop_event = threading.Event()
        self.seen, self.jobs, self.errors = set(), [], []
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            while not self.stop_event.wait(0.5):
                grant = self.h.tick(self.worker)
                if grant["outcome"] == "idle":
                    continue
                require(grant["outcome"] == "prepare" and grant["job_id"] not in self.seen, "packed checker authorized unexpected or duplicate work")
                job_id = grant["job_id"]
                self.seen.add(job_id)
                self.h.work_definition(self.worker, grant, delay_seconds=1)
                require(self.h.observe(self.worker, "queued", run=False)["outcome"] == "queued", "registered one-shot was not retained")
                shown = self.h.start_work(self.worker)
                require(self.h.observe(self.worker, "running")["outcome"] == "running", "one-shot execution identity was not adopted")
                self.jobs.append(shown)
                messages = shown["context"]["messages"]
                last = messages[-1]
                user = next((message["text"] for message in reversed(messages) if message.get("role") == "user"), "")
                if last["type"] == "tool_result":
                    decision = {"type": "final", "text": last["output"]}
                elif user.startswith("aaa-product:tool:"):
                    path = user.removeprefix("aaa-product:tool:")
                    self.h.command(self.worker, ["test", "!", "-e", path])
                    decision = {"type": "tool_call", "call_id": "product-" + job_id, "name": "read_file", "arguments": {"path": path}}
                elif user.startswith("aaa-product:echo:"):
                    decision = {"type": "final", "text": user.removeprefix("aaa-product:echo:")}
                elif user.startswith("Reply with exactly: "):
                    decision = {"type": "final", "text": user.removeprefix("Reply with exactly: ")}
                elif user.startswith("ready-"):
                    decision = {"type": "final", "text": user}
                else:
                    raise AssertionError("unsupported controlled product input")
                self.h.native_cli(self.worker, "decision-submit", "--job-id", job_id, "--input", "-", input_text=json.dumps(decision))
                require(self.h.tick(self.worker)["outcome"] == "running", "observing checker pulled before native settlement")
                require(self.h.observe(self.worker, "completed")["outcome"] == "settled", "packed native result was not settled")
        except Exception as error:
            self.errors.append(type(error).__name__ + ": " + str(error))

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=15)
        require(not self.thread.is_alive(), "controlled packed-worker model did not stop")
        self.h.private("product-model-" + self.worker["worker"]["id"] + ".json", json.dumps({"jobs": self.jobs, "errors": self.errors}))
        require(not self.errors, "controlled packed-worker model failed; inspect private evidence")


class Product(WorkerRecovery, History):
    decode_export = Portal.decode_export

    def __init__(self, args):
        super().__init__(args)
        self.product_cases, self.models, self.workers, self.cycles, self.product_observations = [], [], [], [], []
        self.product_checkpoints = {}
        self.started_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")

    def command(self, environment, args, input_text=None, want=0, extra=()):
        result = self.docker("exec", "-i", *extra, environment["container"], *args, input_text=input_text, success=False, timeout=180)
        name = "product-command-" + secrets.token_hex(12)
        self.private(name + ".stderr", result.stderr)
        if result.returncode != want:
            self.private(name + ".stdout", result.stdout)
        require(result.returncode == want, "packed product command failed; inspect private evidence")
        self.assert_private(result.stdout + result.stderr)
        return result

    def add(self, identity, **fields):
        require(identity not in [c["id"] for c in self.product_cases], "duplicate product case")
        self.product_cases.append({"id": identity, "outcome": "passed", "finished_at": datetime.now(timezone.utc).isoformat(), **fields})
        self.receipt(identity, **fields)

    def browser(self, phase, request_ids=()):
        pin = self.checked("/api/v1/admin/status", self.admin)[0]["build"]["worker_package"]
        origin = self.proxy.origin if phase == "setup" else self.origin_url
        fixture = self.private("product-browser-" + phase + ".json", json.dumps({"origin": origin, "password": self.portal,
            "source_sha": self.args.source_sha, "directory": str(self.root.resolve()), "phase": phase, "installer": pin,
            "workers": [{"slot": w["slot"], "worker_id": w["worker"]["id"]} for w in self.workers], "request_ids": list(request_ids)}))
        result = subprocess.run(["node", "tests/portal/product.mjs", "--fixture", str(fixture)], capture_output=True, text=True, timeout=180)
        self.private("product-browser-" + phase + ".log", result.stdout + result.stderr)
        receipt = json.loads((self.root / ("product-browser-" + phase + "-receipt.json")).read_text())
        self.secrets.extend(receipt["secrets"])
        require(result.returncode == 0 and receipt["outcome"] == "passed", "product browser flow failed; inspect private evidence")
        for case in receipt["cases"]:
            if case["id"] != "portal.login" or not any(c["id"] == "portal.login" for c in self.product_cases):
                self.add(case.pop("id"), **{k: v for k, v in case.items() if k != "outcome"})
        return receipt

    def native_trials(self, worker):
        challenge = "ready-" + secrets.token_hex(24)
        ready = self.create(worker, challenge, tools=False, messages=[{"type": "message", "role": "user", "text": challenge}])
        self.until(lambda: self.experiment(ready["id"])["state"] == "completed", "packed readiness did not complete", timeout=30)
        require(self.experiment(ready["id"])["final_text"] == challenge, "packed readiness result differs")
        fixture = self.private("product-qualification-" + worker["slot"] + ".txt", "client-only-" + secrets.token_hex(24) + "\r\nexact\n")
        trial = self.create(worker, "aaa-product:tool:" + str(fixture))
        self.until(lambda: self.experiment(trial["id"])["state"] == "waiting_for_tool", "packed qualification tool missing", timeout=30)
        call = self.experiment(trial["id"])["messages"][-1]
        self.checked("/api/v1/admin/experiments/" + trial["id"] + "/tool-results", self.admin, "POST", {
            "protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": call["call_id"], "output": fixture.read_bytes().decode()}, want=202)
        self.until(lambda: self.experiment(trial["id"])["state"] == "completed", "packed qualification final missing", timeout=30)
        return ready, trial

    def client_flow(self, phase, cycle=None):
        names = [f"{slot}.{protocol}.{mode}" for slot in ("a", "b") for protocol in ("chat", "responses") for mode in ("json", "sse")]
        fixtures = {}
        for name in [*names, "interleave-a", "interleave-b", "restart", "worker-probe"]:
            contents = "client-only-" + secrets.token_hex(32) + "\nexact 😀\n"
            path = self.private("product-" + phase + "-" + name + "-" + secrets.token_hex(6) + ".txt", contents)
            fixtures[name] = {"id": secrets.token_hex(12), "owner": "client_driver", "created_at": datetime.now(timezone.utc).isoformat(), "path": str(path), "contents": contents}
        fixture = self.private("product-client-" + phase + ".json", json.dumps({"origin": self.origin_url, "admin": "Bearer " + self.admin,
            "keys": {"a": "Bearer " + self.client, "b": "Bearer " + self.other_client}, "directory": str(self.root.resolve()), "phase": phase,
            "workers": [{"slot": w["slot"], "worker_id": w["worker"]["id"]} for w in self.workers], "fixtures": fixtures, "cycle": cycle}))
        result = subprocess.run(["node", "tests/integration/product-client.mjs", "--fixture", str(fixture)], capture_output=True, text=True, timeout=420)
        self.private("product-client-" + phase + ".log", result.stdout + result.stderr)
        receipt = json.loads((self.root / ("product-client-" + phase + "-receipt.json")).read_text())
        require(result.returncode == 0 and receipt["outcome"] == "passed", "product protocol flow failed; inspect private evidence")
        if phase != "prepare-restart":
            for case in receipt["cases"]:
                self.add(case["id"], **{k: v for k, v in case.items() if k not in ("id", "outcome", "contexts")})
        for item in receipt["cycles"]:
            self.cycles = [prior for prior in self.cycles if prior["id"] != item["id"]]
            self.cycles.append(item)
        return receipt

    def stop_models(self):
        for model in self.models:
            model.stop()
        self.models = []

    def worker_boundaries(self):
        self.stop_models()
        worker, other = self.workers
        held = self.create(worker, "held native cross-worker fixture", tools=False)
        grant = self.claim_work(worker, held["current_job_id"])
        brief = self.start_work(worker)
        work = worker["work"]["definition"]
        job_id = grant["job_id"]
        start = {"protocol_version": 1, "claim_id": grant["claim_id"], "generation": grant["generation"],
                 "launch_id": grant["launch_id"], "native_job_id": work["native_job_id"]}
        denied, headers = self.checked("/api/v1/worker/jobs/" + job_id + "/start", other["credential"], "POST", start, want=404)
        require(denied["error"] == "worker_scope_denied", "foreign worker acquired native start authority")
        self.add("boundary.cross-worker", request_id=headers["X-Request-Id"], operation_ids=[held["id"]], job_id=job_id)
        self.cancel(held["id"])
        decision = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "connection_id": "", "connection_generation": 0,
                    "conversation_id": held["conversation_id"], "generation": grant["generation"], "lease_id": grant["claim_id"],
                    "context_receipt_id": brief["context"]["receipt_id"], "decision": {"type": "final", "text": "late controlled native result"}}
        rejected, headers = self.checked("/api/v1/worker/jobs/" + job_id + "/decisions", worker["credential"], "POST", decision, want=409)
        require(rejected["error"] == "stale_assignment" and self.worker_projection(worker)[0]["work_status"] == "busy", "late decision escaped its fence or released the hold")
        self.add("recovery.stale-result", request_id=headers["X-Request-Id"], operation_ids=[held["id"]], job_id=job_id,
                 worker_id=worker["worker"]["id"], generation=grant["generation"], claim_id=grant["claim_id"], reason=rejected["error"])
        self.tick(worker)
        require(self.observe(worker, "failed")["outcome"] == "settled", "verified stop did not settle cancellation")
        self.models = [PackedModel(self, item).start() for item in self.workers]

    def restart_and_replace(self):
        prepared = self.client_flow("prepare-restart")["cycles"][0]
        self.stop_models()
        before = self.checked("/api/v1/admin/status", self.admin)[0]
        self.docker("restart", self.broker)
        self.origin_url = self.origin(self.broker)
        self.proxy.target = urllib.parse.urlsplit(self.origin_url)
        self.ready(self.broker, self.origin_url)
        after = self.checked("/api/v1/admin/status", self.admin)[0]
        require(before["instance_id"] != after["instance_id"], "broker restart did not change process identity")
        worker_a, worker_b = self.workers
        self.models = [PackedModel(self, item).start() for item in self.workers]
        resumed = self.client_flow("resume-restart", prepared)["cycles"][0]
        self.product_checkpoints["broker"] = {"before_instance": before["instance_id"], "after_instance": after["instance_id"],
            "pending_call_id": prepared["call_id"], "completed_request_id": resumed["turns"][1]["operation_id"]}
        self.add("recovery.tool-dedup", call_id=resumed["call_id"], client_tool_executions=resumed["client_tool_executions"], request_ids=[turn["request_id"] for turn in resumed["turns"]])
        self.stop_models()
        retained = {name: (worker_b["state"] / name).read_bytes() for name in ("installation.json", "cron-installation.json", "config.json", "credential.key")}
        self.save_during_reply_loss(worker_b)
        require(all((worker_b["state"] / name).read_bytes() == value for name, value in retained.items()), "worker restart changed installation or credential")
        self.models = [PackedModel(self, worker_b).start()]
        probe = self.client_flow("worker-recovery")["cases"][0]
        require(not self.worker_projection(worker_b)[0]["qualification_history"], "native recovery fabricated approval")
        self.add("recovery.native-checker", worker_ids=[worker_b["worker"]["id"]], checker_job_id=worker_b["checker"],
                 operation_ids=probe["operation_ids"], credential_preserved=True, exact_settlement_replayed=True)
        self.silence(worker_a, 605)
        require(self.worker_projection(worker_a)[0]["connection_status"] == "offline", "controlled replacement did not reach the offline boundary")
        self.client_flow("replacement", resumed)
        self.models.append(PackedModel(self, worker_a).start())

    def exports(self):
        exports = []
        status, _, raw = self.api("/api/v1/admin/diagnostics/export", self.admin)
        require(status == 200, "product broker export unavailable")
        self.assert_private(raw.decode())
        broker = self.private("product-broker.ndjson", raw.decode())
        metadata, events = self.decode_export(raw)
        require(metadata["complete"] and events, "product broker export incomplete")
        exports.append({"source": "broker", "case_id": "all", "file": broker.name, "sha256": hashlib.sha256(raw).hexdigest()})
        rejected = [event for event in events if event["msg"] in ("lease.rejected", "lease.fenced")]
        require(rejected, "product rejection cannot be diagnosed from collected logs")
        self.add("diagnostics.log-only", cause=rejected[0]["reason"], request_id=rejected[0]["request_id"], business_table_queries=False, capture_complete=True)
        for worker in self.workers:
            raw = self.native_cli(worker, "diagnostics-export", "--until", utc_stamp())
            self.assert_private(raw)
            path = self.private("product-worker-" + worker["slot"] + ".ndjson", raw)
            metadata, worker_events = self.decode_export(raw.encode())
            require(metadata["complete"] and any(e.get("package_version") == self.package["version"] for e in worker_events), "product installed identity/capture missing")
            exports.append({"source": "worker", "case_id": "all", "worker_id": worker["worker"]["id"], "file": path.name, "sha256": hashlib.sha256(raw.encode()).hexdigest()})
        return exports

    def exercise(self):
        prompts = self.browser("setup")["prompts"]
        for prompt in prompts:
            worker = self.environment("product-" + prompt["slot"])
            worker["slot"] = prompt["slot"]
            self.install(worker, prompt)
            self.workers.append(worker)
            self.checker(worker)
            self.private("product-install-" + worker["slot"] + ".json", json.dumps(worker["receipt"]))
            self.product_observations.append({"kind": "setup_ended", "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "worker_id": worker["worker"]["id"], "account_ref": "controlled-container-" + worker["slot"], "setup_id": worker["receipt"]["setup_id"],
                "checker_job_id": worker["checker"], "recurring_count": 1, "interval_seconds": 60,
                "state_mode": "0700", "key_file_mode": "0600", "worker_version": self.package["version"], "worker_sha256": self.package["sha256"],
                "actual_permissions": ["controlled-container-shell"], "observer": "controlled-product-runner", "source_ref": "product-install-" + worker["slot"] + ".json"})
            require(self.tick(worker)["outcome"] == "idle", "fresh checker did not observe idle")
            self.models.append(PackedModel(self, worker).start())
            ready, trial = self.native_trials(worker)
            self.add("readiness." + worker["slot"], worker_ids=[worker["worker"]["id"]], operation_ids=[ready["id"], trial["id"]], evidence_kind="controlled")
            self.add("idle." + worker["slot"], worker_ids=[worker["worker"]["id"]], operation_ids=[ready["id"]], checker_job_id=worker["checker"], controlled_native_checker=True)
        matrix = self.client_flow("matrix")
        ids = [c["operation_ids"][1] for c in matrix["cases"] if c["id"] in ("a.chat.json", "b.responses.json")]
        self.browser("inspect", ids)
        self.worker_boundaries()
        self.restart_and_replace()
        self.stop_models()
        self.browser("revoke")
        for worker in self.workers:
            self.tick(worker, want=1)
            require(not (worker["state"] / "cron-claim.json").exists(), "revoked product checker obtained a grant")
            require(self.api("/api/v1/worker/status", worker["credential"])[0] == 401, "revoked product worker retained authority")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    parser.add_argument("--package-receipt", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = Product(args)
    identity = source_identity()
    outcome, exports, status, image_id = "failed", [], {}, None
    proxy = assets = None
    try:
        h.baseline()
        image_id = h.inspect(args.image)["Id"]
        h.setup()
        proxy = h.proxy = TLSFixture(h, "http://127.0.0.1:1")
        h.broker, h.origin_url, _ = h.launch()
        proxy.target = urllib.parse.urlsplit(h.origin_url)
        h.ready(h.broker, h.origin_url)
        status = h.checked("/api/v1/admin/status", h.admin)[0]
        require(status["build"]["worker_package"]["sha256"] == h.package["sha256"], "combined image/package pair differs")
        assets = h.assets = Assets(h, h.package["archive"])
        h.docker("build", "--label", LABEL + "=" + h.owner, "-f", "tests/integration/worker-setup.Dockerfile", "-t", h.fixture_image, ".", timeout=240)
        h.fixture_image_created = True
        h.exercise()
        exports = h.exports()
        require(source_identity() == identity, "source changed during product validation")
        outcome = "passed"
    except Exception as error:
        h.private("product-failure.txt", str(error))
        print(json.dumps({"level": "ERROR", "msg": "e2e.case_failed", "case": h.product_cases[-1]["id"] if h.product_cases else "preflight", "expected": "combined flow passed", "observed": "failed", "correlation": h.owner}), flush=True)
        raise
    finally:
        model_failures = []
        for model in h.models:
            try:
                model.stop()
            except Exception as error:
                model_failures.append(type(error).__name__)
        if assets:
            assets.close()
        if proxy:
            proxy.release_decision.set()
            proxy.close()
        h.cleanup()
        if h.fixture_image_created:
            info = h.inspect(h.fixture_image)
            require(info["Config"]["Labels"][LABEL] == h.owner, "product fixture image owner changed")
            h.docker("image", "rm", h.fixture_image)
        installer = Path(h.package["archive"]).parent / "unpacked/package/setup/install.sh"
        report = {"schema_version": 1, "suite": "native-pull-product", "evidence_kind": "synthetic", "run_id": h.owner, "qualifies_live_muse": False, "outcome": outcome,
            "started_at": h.started_at, "finished_at": datetime.now(timezone.utc).isoformat(), "source": {"service_sha": args.source_sha, "working_source": identity,
            "image_digest": image_id, "service_version": h.package["version"], "worker_version": h.package["version"], "worker_sha256": h.package["sha256"],
            "installer_sha256": hashlib.sha256(installer.read_bytes()).hexdigest()}, "status_receipt": status, "cases": h.product_cases, "cycles": h.cycles,
            "workers": [{"slot": w["slot"], "worker_id": w["worker"]["id"], "checker_job_id": w["checker"], "installed_version": h.package["version"], "installed_sha256": h.package["sha256"]} for w in h.workers],
            "observations": h.product_observations, "checkpoints": h.product_checkpoints, "exports": exports,
            "cleanup": json.loads((h.root / "cleanup.json").read_text()), "model_cleanup_failures": model_failures}
        h.assert_private(json.dumps(report))
        report_path = h.private("product-report.json", json.dumps(report, indent=2))
        safe = Path(".artifacts/e2e")
        safe.mkdir(parents=True, exist_ok=True, mode=0o700)
        (safe / "flow-location.json").write_text(json.dumps({"report": str(report_path), "outcome": outcome}))
        require(not model_failures, "controlled model cleanup failed; inspect protected evidence")


if __name__ == "__main__":
    main()
