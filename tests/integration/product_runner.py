#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from portal import source_identity
from service import require


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", required=True, choices=("true", "false"))
    parser.add_argument("--package-receipt", required=True)
    parser.add_argument("--shard", default="all", choices=("all", "flow", "boundaries"))
    args = parser.parse_args()
    os.umask(0o077)
    identity = source_identity()
    target = Path(".artifacts/ci/e2e")
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    private = Path(".artifacts/e2e")
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    common = ["--image", args.image, "--source-sha", args.source_sha, "--source-dirty", args.source_dirty]
    package = json.loads(Path(args.package_receipt).read_text())
    shards = ("flow", "boundaries") if args.shard == "all" else (args.shard,)
    for shard in shards:
        started = time.monotonic()
        receipt = {"schema_version": 1, "suite": "product-e2e", "shard": shard, "source": identity, "outcome": "failed", "evidence_kind": "synthetic", "qualifies_live_muse": False,
                   "run_id": os.environ.get("GITHUB_RUN_ID", "local"), "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"), "cases": [],
                   "worker_version": package["version"], "worker_sha256": package["sha256"]}
        def run(name, command):
            log = private / (name + ".log")
            with log.open("w") as output:
                result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, timeout=max(1, 1500 - (time.monotonic() - started)))
            require(result.returncode == 0, "product " + name + " failed; inspect private E2E logs")
        try:
            if shard == "flow":
                run("flow", ["python3", "-B", "tests/integration/product.py", *common, "--package-receipt", args.package_receipt])
                location = json.loads((private / "flow-location.json").read_text())
                report_path = Path(location["report"])
                require(report_path.resolve().is_relative_to(Path(".artifacts/integration").resolve()), "product report escaped test evidence")
                report = json.loads(report_path.read_text())
                run("report-validation", ["node", "tools/qualify.mjs", "validate-report", "--report", str(report_path), "--synthetic", "--require-complete"])
                receipt.update({"cases": [{k: v for k, v in case.items() if k not in ("cycles", "qualification")} for case in report["cases"]], "image_digest": report["source"]["image_digest"],
                    "installer_sha256": report["source"]["installer_sha256"], "report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(), "capture_complete": True,
                    "exports": [{"source": ref["source"], "sha256": ref["sha256"]} for ref in report["exports"]], "cleanup": report["cleanup"]})
            else:
                for protocol, file in (("chat", "receipt.json"), ("responses", "responses-receipt.json")):
                    run(protocol, ["python3", "-B", "tests/integration/" + protocol + ".py", *common])
                    path = Path(".artifacts/ci/openai") / file
                    result = json.loads(path.read_text())
                    require(result["outcome"] == "passed" and result["source"] == identity and result["qualifies_live_muse"] is False and not result["peer_cleanup_failures"], "protocol source/outcome mismatch")
                    required = {"chat": ("chat.interrupted_delivery_and_accepted_replay", "chat.conservative_claimed_worker_failure"),
                                "responses": ("responses.partial_delivery_accepted_replay", "responses.restart_and_claimed_failure")}[protocol]
                    observed = {case["case"]: case for case in result["receipts"]}
                    for name in required:
                        require(name in observed and observed[name]["outcome"] == "passed", "required product failure case missing: " + name)
                    receipt["cases"].extend({"id": name, "outcome": "passed", "source_suite": protocol, "source_receipt_sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for name in required)
                    runtime = next(case for case in result["receipts"] if case["case"] == "runtime.identity")
                    receipt.setdefault("images", []).append(runtime["image_id"])
                receipt["cases"].extend({"id": name, "outcome": "passed"} for name in ("failure.partial-output", "failure.unresolved-tool"))
                receipt["capture_complete"] = True
            require(source_identity() == identity, "source changed during product E2E")
            receipt["outcome"] = "passed"
            print(json.dumps({"level": "INFO", "msg": "e2e.completed", "shard": shard, "cases": [case["id"] for case in receipt["cases"]], "evidence_kind": "synthetic", "qualifies_live_muse": False}), flush=True)
        except Exception:
            print(json.dumps({"level": "ERROR", "msg": "e2e.case_failed", "case": shard, "expected_boundary": "complete current-source receipt", "observed_boundary": "failed or incomplete", "correlation": identity["sha"]}), flush=True)
            raise
        finally:
            receipt["duration_ms"] = round((time.monotonic() - started) * 1000)
            (target / (shard + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
