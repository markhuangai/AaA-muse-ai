#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import time
import urllib.parse

from history import History
from portal import Portal, source_identity
from service import LABEL, require
from worker_recovery import WorkerRecovery
from worker_setup import Assets
from worker_tls import TLSFixture


class PackedModel:
    def __init__(self, harness, worker, *, verify_next_wake=False):
        self.h, self.worker = harness, worker
        self.stop_event = threading.Event()
        self.seen, self.jobs, self.errors = set(), [], []
        self.verify_next_wake = verify_next_wake
        self.verified_wake = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            while not self.stop_event.wait(0.1):
                path = self.worker["state"] / "pending.json"
                if not path.exists():
                    continue
                for pending in json.loads(path.read_text())["jobs"]:
                    if pending["job_id"] in self.seen or pending["state"] != "pending":
                        continue
                    self.seen.add(pending["job_id"])
                    poll = self.h.hook(self.worker)
                    if self.verify_next_wake and not self.verified_wake.is_set():
                        require(json.loads(poll.stdout)["action"] == "wake", "recovered assignment did not emit its first genuine wake")
                        require(json.loads(self.h.hook(self.worker).stdout)["action"] == "silent", "recovered assignment emitted another wake")
                        self.verified_wake.set()
                    shown = json.loads(self.h.cli(self.worker, "job-show", "--job-id", pending["job_id"]).stdout)
                    self.jobs.append(shown)
                    messages = shown["context"]["messages"]
                    last = messages[-1]
                    user = next((m["text"] for m in reversed(messages) if m.get("role") == "user"), "")
                    if last["type"] == "tool_result":
                        decision = {"type": "final", "text": last["output"]}
                    elif user.startswith("aaa-product:tool:"):
                        path = user[len("aaa-product:tool:"):]
                        self.h.command(self.worker, ["test", "!", "-e", path])
                        decision = {"type": "tool_call", "call_id": "product-" + pending["job_id"], "name": "read_file", "arguments": {"path": path}}
                    elif user.startswith("aaa-product:echo:"):
                        decision = {"type": "final", "text": user[len("aaa-product:echo:"):]}
                    elif user.startswith("ready-"):
                        decision = {"type": "final", "text": user}
                    elif user.startswith("aaa-product:hold:"):
                        continue
                    else:
                        raise AssertionError("unsupported controlled product input")
                    self.h.cli(self.worker, "decision-submit", "--job-id", pending["job_id"], "--input", "-", input_text=json.dumps(decision))
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

    def qualify_packed(self, worker):
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
        worker["qualification"] = {"readiness_experiment_id": ready["id"], "tool_experiment_id": trial["id"]}
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/qualifications", self.admin, "POST", {
            "protocol_version": 1, "submission_id": secrets.token_hex(12), "action": "approve", "evidence_kind": "controlled",
            "evidence_reference": "Real packed installer/subscriber with controlled decisions; not live Muse.", **worker["qualification"]})
        return ready, trial

    def client_flow(self, phase, cycle=None):
        names = [f"{slot}.{protocol}.{mode}" for slot in ("a", "b") for protocol in ("chat", "responses") for mode in ("json", "sse")]
        fixtures = {}
        for name in [*names, "interleave-a", "interleave-b", "restart", "worker-probe", "watchdog-probe"]:
            contents = "client-only-" + secrets.token_hex(32) + "\nexact 😀\n"
            path = self.private("product-" + phase + "-" + name + "-" + secrets.token_hex(6) + ".txt", contents)
            fixtures[name] = {"id": secrets.token_hex(12), "owner": "client_driver", "created_at": datetime.now(timezone.utc).isoformat(), "path": str(path), "contents": contents}
        fixture = self.private("product-client-" + phase + ".json", json.dumps({"origin": self.origin_url, "admin": "Bearer " + self.admin,
            "keys": {"a": "Bearer " + self.client, "b": "Bearer " + self.other_client}, "directory": str(self.root.resolve()), "phase": phase,
            "workers": [{"slot": w["slot"], "worker_id": w["worker"]["id"], "qualification": w["qualification"]} for w in self.workers], "fixtures": fixtures, "cycle": cycle}))
        result = subprocess.run(["node", "tests/integration/product-client.mjs", "--fixture", str(fixture)], capture_output=True, text=True, timeout=420)
        self.private("product-client-" + phase + ".log", result.stdout + result.stderr)
        receipt = json.loads((self.root / ("product-client-" + phase + "-receipt.json")).read_text())
        require(result.returncode == 0 and receipt["outcome"] == "passed", "product protocol flow failed; inspect private evidence")
        if phase not in ("prepare-restart", "watchdog-recovery"):
            for case in receipt["cases"]:
                self.add(case["id"], **{k: v for k, v in case.items() if k not in ("id", "outcome", "contexts")})
        if phase != "watchdog-recovery":
            for item in receipt["cycles"]:
                self.cycles = [prior for prior in self.cycles if prior["id"] != item["id"]]
                self.cycles.append(item)
        return receipt

    def worker_boundaries(self):
        a, b = self.workers
        experiment = self.create(a, "aaa-product:hold:cross-worker", tools=False)
        self.until(lambda: any(j["job_id"] == experiment["current_job_id"] for j in self.models[0].jobs), "held job missing", timeout=30)
        original = self.checked("/api/v1/worker/jobs/" + experiment["current_job_id"], a["credential"])[0]
        stale = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "connection_id": original["connection_id"],
                 "connection_generation": original["connection_generation"], "conversation_id": original["conversation_id"],
                 "generation": original["generation"], "lease_id": original["lease_id"], "context_receipt_id": original["context"]["receipt_id"],
                 "decision": {"type": "final", "text": "late controlled native result"}}
        self.private("product-original-decision.json", json.dumps(stale))
        result = self.cli(b, "job-show", "--job-id", experiment["current_job_id"], want=1)
        denied = [json.loads(line) for line in result.stderr.splitlines() if line.startswith('{') and json.loads(line).get("reason") == "worker_scope_denied"]
        require(len(denied) == 1 and denied[0]["http_status"] == 404, "foreign packed worker did not reject job")
        self.checked("/api/v1/admin/experiments/" + experiment["id"] + "/cancel", self.admin, "POST", {"protocol_version": 1, "submission_id": secrets.token_hex(12)})
        self.cli(a, "decision-submit", "--job-id", experiment["current_job_id"], "--input", "-", input_text=json.dumps({"type": "final", "text": "late"}), want=1)
        rejected, headers = self.checked("/api/v1/worker/jobs/" + experiment["current_job_id"] + "/decisions", a["credential"], "POST", stale, want=409)
        require(rejected["error"] in ("stale_assignment", "stale_connection"), "broker did not fence captured stale decision")
        require(self.status(a)["work_status"] == "busy", "late decision cleared uncertain hold")
        self.add("boundary.cross-worker", request_id=denied[0]["request_id"], operation_ids=[experiment["id"]], job_id=experiment["current_job_id"])
        self.add("recovery.stale-result", request_id=headers["X-Request-Id"], operation_ids=[experiment["id"]], job_id=experiment["current_job_id"],
                 worker_id=a["worker"]["id"], generation=original["generation"], connection_generation=original["connection_generation"],
                 reason=rejected["error"], stale_result_rejected=True, uncertain_hold=True)
        self.cli(a, "decision-submit", "--job-id", experiment["current_job_id"], "--ack-idle")
        self.until(lambda: self.status(a)["work_status"] == "idle", "explicit controlled idle acknowledgement missing")

    def restart_and_replace(self):
        prepared = self.client_flow("prepare-restart")["cycles"][0]
        qualifications = {worker["slot"]: self.status(worker)["qualification"] for worker in self.workers}
        before = self.checked("/api/v1/admin/status", self.admin)[0]
        checkpoint = self.product_checkpoints["broker"] = {"cycle_id": prepared["id"], "pending_call_id": prepared["call_id"],
            "before_instance": before["instance_id"], "before_status": before, "prepared_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds")}
        action_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        self.docker("restart", self.broker)
        self.origin_url = self.origin(self.broker)
        self.proxy.target = urllib.parse.urlsplit(self.origin_url)
        self.ready(self.broker, self.origin_url)
        after = self.checked("/api/v1/admin/status", self.admin)[0]
        require(before["instance_id"] != after["instance_id"], "broker restart did not change process identity")
        checkpoint.update({"after_instance": after["instance_id"], "after_status": after, "resumed_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds")})
        self.product_observations.append({"kind": "product_case", "case_id": "recovery.broker-tool-wait", "time": action_at,
            "worker_ids": [prepared["turns"][0]["worker_id"]], "operation_ids": [prepared["turns"][0]["operation_id"]],
            "expected_boundary": "accepted tool call pending across service restart", "observed_boundary": "new service process before continuation",
            "observer": "controlled-product-runner", "source_ref": "product-client-prepare-restart-receipt.json"})
        for worker in self.workers:
            self.online(worker)
            current = self.status(worker)
            require(current["inference_readiness"] == "verified" and current["qualification"] == qualifications[worker["slot"]], "broker restart lost or rewrote worker approval")
        resumed = self.client_flow("resume-restart", prepared)["cycles"][0]
        checkpoint["completed_request_id"] = resumed["turns"][1]["operation_id"]
        self.add("recovery.tool-dedup", call_id=resumed["call_id"], client_tool_executions=resumed["client_tool_executions"], request_ids=[t["request_id"] for t in resumed["turns"]])
        a, b = self.workers
        for model in self.models:
            model.stop()
        self.models = []
        credential = (b["state"] / "credential.key").read_bytes()
        retained = {name: (b["state"] / name).read_bytes() for name in ("installation.json", "config.json")}
        journals = {path.name: path.read_bytes() for path in (b["state"] / "journals").glob('*.json')}
        previous = self.online(b)
        action_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        self.crash_and_duplicate(b)
        recovered = self.online(b)
        reconnected_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        require((b["state"] / "credential.key").read_bytes() == credential, "worker restart changed credential")
        require(all((b["state"] / name).read_bytes() == data for name, data in retained.items()), "worker restart changed installation identity")
        require(all((b["state"] / "journals" / name).read_bytes() == data for name, data in journals.items()), "worker restart rewrote retained journals")
        common = {"worker_id": b["worker"]["id"], "hook_id": "controlled-" + b["worker"]["id"], "hook_path": b["receipt"]["hook_path"],
                  "observer": "controlled-product-runner", "source_ref": "controlled-hook-and-connection-" + b["worker"]["id"]}
        self.product_observations.extend([
            {**common, "kind": "product_case", "case_id": "recovery.worker", "time": reconnected_at, "action_at": action_at,
             "worker_ids": [b["worker"]["id"]], "expected_boundary": "retained hook recovers one new subscriber", "observed_boundary": "new authenticated connection with preserved state",
             "before_connection_id": previous["connection_id"], "before_connection_generation": previous["connection_generation"]},
            {**common, "kind": "worker_reconnected", "time": reconnected_at, "consumer_count": 1, "state_mode": "0700", "key_file_mode": "0600",
             "reinstalled": False, "reenrolled": False, "manual_message": False, "connection_id": recovered["connection_id"], "connection_generation": recovered["connection_generation"]}])
        self.models = [PackedModel(self, a).start(), PackedModel(self, b).start()]
        probe = self.client_flow("worker-recovery")["cases"][0]
        require(self.status(b)["qualification"] == qualifications["b"], "worker recovery changed approval")
        require(all(turn["connection_id"] == recovered["connection_id"] and turn["connection_generation"] == recovered["connection_generation"] for turn in self.cycles[-1]["turns"]), "client probe did not use recovered connection")
        self.add("recovery.hook", recovery_case_id="recovery.worker", worker_ids=[b["worker"]["id"]], operation_ids=probe["operation_ids"], one_consumer=True, supported_refresh_qualified=False)
        for model in self.models:
            model.stop()
        self.models = []
        recovered = self.watchdog_recover(b)
        recovered_model = PackedModel(self, b, verify_next_wake=True).start()
        self.models = [PackedModel(self, a).start(), recovered_model]
        watchdog_probe = self.client_flow("watchdog-recovery")
        require(recovered_model.verified_wake.is_set(), "watchdog client flow lacks a verified single genuine wake")
        require(self.status(b)["qualification"] == qualifications["b"], "watchdog client probe required a changed approval")
        require(all(turn["connection_id"] == recovered["connection_id"] and turn["connection_generation"] == recovered["connection_generation"]
                    for turn in watchdog_probe["cycles"][0]["turns"]), "watchdog client did not use the recovered connection")
        self.receipt("recovery.watchdog", worker_id=b["worker"]["id"], connection_generation=recovered["connection_generation"],
                     operation_ids=watchdog_probe["cases"][0]["operation_ids"], one_consumer=True, approval_preserved=True, wake_once=True)
        self.stop(a)
        self.proxy.interrupt()
        self.until(lambda: self.status(a)["connection_status"] == "offline", "stopped replacement worker remained healthy", timeout=45)
        self.online(b)
        self.client_flow("replacement", resumed)
        self.hook(a)
        self.online(a)

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
            raw = self.cli(worker, "diagnostics-export").stdout
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
            self.private("product-install-" + worker["slot"] + ".json", json.dumps(worker["receipt"]))
            self.product_observations.append({"kind": "setup_ended", "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "worker_id": worker["worker"]["id"], "account_ref": "controlled-container-" + worker["slot"], "setup_id": worker["receipt"]["setup_id"],
                "hook_id": "controlled-" + worker["worker"]["id"], "hook_path": worker["receipt"]["hook_path"], "consumer_count": 1, "interval_seconds": 5,
                "state_mode": "0700", "key_file_mode": "0600", "worker_version": self.package["version"], "worker_sha256": self.package["sha256"],
                "actual_permissions": ["controlled-container-shell"], "observer": "controlled-product-runner", "source_ref": "product-install-" + worker["slot"] + ".json"})
            self.models.append(PackedModel(self, worker).start())
            ready, trial = self.qualify_packed(worker)
            self.add("readiness." + worker["slot"], worker_ids=[worker["worker"]["id"]], operation_ids=[ready["id"], trial["id"]], evidence_kind="controlled")
            self.add("idle." + worker["slot"], worker_ids=[worker["worker"]["id"]], operation_ids=[ready["id"]], controlled_hook=True)
        matrix = self.client_flow("matrix")
        ids = [c["operation_ids"][1] for c in matrix["cases"] if c["id"] in ("a.chat.json", "b.responses.json")]
        self.browser("inspect", ids)
        self.worker_boundaries()
        self.restart_and_replace()
        for model in self.models:
            model.stop()
        self.models = []
        self.browser("revoke")
        for worker in self.workers:
            self.until(lambda: (worker["state"] / "run-stop.json").exists(), "product revocation did not stop subscriber", timeout=40)
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
        report = {"schema_version": 2, "suite": "release", "evidence_kind": "synthetic", "run_id": h.owner, "verdict": "inconclusive", "outcome": outcome,
            "started_at": h.started_at, "finished_at": datetime.now(timezone.utc).isoformat(), "source": {"service_sha": args.source_sha, "working_source": identity,
            "image_digest": image_id, "service_version": h.package["version"], "worker_version": h.package["version"], "worker_sha256": h.package["sha256"],
            "installer_sha256": hashlib.sha256(installer.read_bytes()).hexdigest()}, "status_receipt": status, "cases": h.product_cases, "cycles": h.cycles,
            "workers": [{"slot": w["slot"], "worker_id": w["worker"]["id"], "account_ref": "controlled-container-" + w["slot"], "installed_version": h.package["version"], "installed_sha256": h.package["sha256"]} for w in h.workers],
            "observations": h.product_observations, "checkpoints": h.product_checkpoints, "exports": exports,
            "watchdog_recovery": next((case for case in h.receipts if case["case"] == "recovery.watchdog"), None),
            "cleanup": json.loads((h.root / "cleanup.json").read_text()), "model_cleanup_failures": model_failures}
        h.assert_private(json.dumps(report))
        report_path = h.private("product-report.json", json.dumps(report, indent=2))
        safe = Path(".artifacts/e2e")
        safe.mkdir(parents=True, exist_ok=True, mode=0o700)
        (safe / "flow-location.json").write_text(json.dumps({"report": str(report_path), "outcome": outcome}))
        require(not model_failures, "controlled model cleanup failed; inspect protected evidence")


if __name__ == "__main__":
    main()
