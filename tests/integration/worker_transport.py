#!/usr/bin/env python3
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
from urllib.parse import urlsplit
import urllib.request

from inference import Inference
from native_cron import NativeCronFixture, utc_stamp
from service import LABEL, require
from worker_tls import TLSFixture

NODE_IMAGE = "node:24.22.2-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4"


class WorkerTransport(NativeCronFixture, Inference):
    def __init__(self, args):
        super().__init__(args)
        receipt = json.loads(Path(args.package_receipt).read_text())
        archive = Path(receipt["archive"])
        require(hashlib.sha256(archive.read_bytes()).hexdigest() == receipt["sha256"], "worker package archive changed")
        require(receipt["source"]["source_sha"] == args.source_sha and receipt["source"]["source_dirty"] == (args.source_dirty == "true"), "worker package source identity differs")
        self.package = archive.parent / "unpacked" / "package"
        self.package_receipt = receipt

    def native_cli(self, worker, *command, input_text=None, want=0):
        state = worker["state"]
        state.mkdir(mode=0o700, exist_ok=True)
        identity = self.docker("create", "-i", "--label", LABEL + "=" + self.owner, "--network", "host", "--read-only",
                               "--user", str(os.getuid()) + ":" + str(os.getgid()), "-e", "HOME=/state",
                               "--mount", "type=bind,source=" + str(worker.get("package", self.package).resolve()) + ",target=/opt/worker,readonly",
                               "--mount", "type=bind,source=" + str(state.resolve()) + ",target=/state",
                               "--mount", "type=bind,source=" + str(self.proxy.cert) + ",target=/opt/ca.pem,readonly",
                               "-e", "NODE_EXTRA_CA_CERTS=/opt/ca.pem", NODE_IMAGE,
                               "node", "/opt/worker/dist/main.js", command[0], "--state-dir", "/state", *command[1:]).stdout.strip()
        self.remember("containers", identity)
        result = self.docker("start", "-ai", identity, input_text=input_text, success=False, timeout=60)
        self.private(identity[:12] + ".stdout", result.stdout)
        self.private(identity[:12] + ".stderr", result.stderr)
        self.assert_private(result.stdout + result.stderr)
        require(self.inspect(identity)["State"]["ExitCode"] == want, "worker command failed: " + command[0] + "; see private receipts")
        return result.stdout

    def cli_worker(self, suffix, registration=None):
        worker = {"state": self.root.resolve() / ("worker-" + suffix)}
        enrollment = registration or self.issue()
        args = ("setup", "--origin", self.proxy.origin, "--code-stdin", "--install-dir", "/state/install",
                "--setup-id", enrollment["enrollment_id"])
        input_text = enrollment["enrollment_code"] + "\n"
        response = json.loads(self.native_cli(worker, *args, input_text=input_text))
        credential = (worker["state"] / "credential.key").read_text().strip()
        self.secrets.append(credential)
        worker.update({"worker": {"id": response["worker_id"]}, "credential": credential})
        require(response["cron_registration"] == "pending" and self.status(worker)["connection_status"] == "not_observed",
                "install was reported as an observed tick")
        require(worker["state"].stat().st_mode & 0o777 == 0o700 and (worker["state"] / "credential.key").stat().st_mode & 0o777 == 0o600,
                "worker credential storage is not protected")
        repeated = json.loads(self.native_cli(worker, *args, input_text=input_text))
        require(repeated["identity_preserved"] and repeated["worker_id"] == response["worker_id"] and
                (worker["state"] / "credential.key").read_text().strip() == credential, "retry replaced the installed worker")
        self.checker(worker)
        return worker

    def legacy_release(self):
        url = "https://github.com/markhuangai/AaA-muse-ai/releases/download/worker-v0.1.0-rc.6/markhuangai-aaa-muse-worker-0.1.0-rc.6.tgz"
        with urllib.request.urlopen(url, timeout=120) as response:
            archive = response.read(1024 * 1024)
        expected = "2c29f4cfee3b58148ce4ec614ef6ada5e11a4b3e5de44109916c9cc3f81d959f"
        require(hashlib.sha256(archive).hexdigest() == expected, "legacy release bytes changed")
        directory = self.root.resolve() / "legacy-release"
        directory.mkdir(mode=0o700)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
            require(all(item.name.startswith("package/") and ".." not in Path(item.name).parts and not item.issym() and not item.islnk() for item in package.getmembers()), "legacy package archive paths unsafe")
            package.extractall(directory, filter="data")
        legacy = {"package": directory / "package", "state": self.root.resolve() / "legacy-worker"}
        enrollment = self.issue()
        self.native_cli(legacy, "configure", "--origin", self.proxy.origin)
        self.native_cli(legacy, "enroll", "--code-stdin", input_text=enrollment["enrollment_code"] + "\n", want=1)
        require(not (legacy["state"] / "credential.key").exists(), "mixed major gained a worker credential")
        self.receipt("worker.archived_major_zero_rejected", archive_sha256=expected, new_authority=False)
        return enrollment

    def decoded(self, worker, operation=None, since=None, until=None):
        args = ["diagnostics-export"]
        for flag, value in (("--operation-id", operation), ("--since", since), ("--until", until)):
            if value is not None:
                args.extend([flag, value])
        raw = self.native_cli(worker, *args)
        metadata, events = self.decode_export(raw.encode())
        require(metadata["complete"] and events, "worker diagnostic evidence is incomplete")
        self.assert_private(json.dumps(events))
        values = [json.loads(line) for line in self.native_cli(worker, *args, "--decode").splitlines()]
        require(values[0]["complete"] and values[0]["captures"] == len(values) - 1, "worker decoder/export disagrees")
        return events

    def submit_cli(self, worker, job_id, decision, want=0):
        raw = self.native_cli(worker, "decision-submit", "--job-id", job_id, "--input", "-", input_text=json.dumps(decision), want=want)
        return json.loads(raw) if want == 0 else None

    def decode_protected(self, raw):
        code = ("import {readFileSync} from 'node:fs'; import {decodeExport} from './tools/qualification-evidence.mjs';"
                "process.stdout.write(JSON.stringify(decodeExport(readFileSync(0, 'utf8')).events));")
        result = subprocess.run(["node", "--input-type=module", "-e", code], input=raw, capture_output=True, timeout=20)
        require(result.returncode == 0, "production decoder rejected a protected pull capture")
        self.assert_private(result.stdout.decode())
        return json.loads(result.stdout)

    def broker_evidence(self, origin, key, identity, *, absent=False):
        status, _, body = self.request(origin, "/api/v1/admin/diagnostics/export?" + key + "=" + identity, self.admin)
        require(status == 200, "protected broker export missing")
        if absent:
            self.assert_private(body.decode())
            records = body.splitlines()
            require(len(records) == 1, "request appeared on both broker exports")
            metadata = json.loads(records[0])
            require(metadata["type"] == "export" and not metadata["complete"] and metadata["captures"] == 0 and
                    metadata["omissions"] == ["requested_identity_not_captured_in_interval"],
                    "sibling export did not distinguish absent identity from missing capture data")
            return []
        events = self.decode_protected(body)
        require(all(event[key] == identity for event in events), "protected broker export mixed identities")
        return events

    @contextmanager
    def delay_indexed_lookup(self):
        original = self.sql("SELECT sql FROM sqlite_schema WHERE name='aaa_pull_levels' AND type='view';")
        require(original.startswith("CREATE VIEW aaa_pull_levels AS"), "indexed lookup view fixture missing")
        self.sql("""BEGIN IMMEDIATE; DROP VIEW aaa_pull_levels;
            CREATE VIEW aaa_pull_levels AS WITH RECURSIVE
                levels(shift) AS (VALUES(0) UNION ALL SELECT shift+1 FROM levels WHERE shift<63),
                fixture_work(step) AS (VALUES(0) UNION ALL SELECT step+1 FROM fixture_work WHERE step<400000)
            SELECT shift FROM levels WHERE (SELECT sum(step) FROM fixture_work)=80000200000;
            COMMIT;""")
        try:
            yield
        finally:
            self.sql("BEGIN IMMEDIATE; DROP VIEW aaa_pull_levels; " + original + "; COMMIT;")

    def joined_pull_diagnosis(self, sibling):
        worker = self.cli_worker("pull-timing")
        experiment = self.create(worker, "controlled pull lock across sibling brokers", tools=False)
        since = utc_stamp()
        scheduled = utc_stamp(datetime.now(timezone.utc) - timedelta(seconds=15))
        with self.writer_lock():
            self.tick(worker, want=1, input_override={"scheduled_at": scheduled})
        first = worker["last_tick"]
        target = self.proxy.target
        self.proxy.target = urlsplit(sibling)
        try:
            with self.delay_indexed_lookup():
                grant = self.claim_work(worker, experiment["current_job_id"])
            second = worker["last_tick"]
            self.start_work(worker)
            self.submit_cli(worker, grant["job_id"], {"type": "final", "text": "confirmed after writer release"})
            require(self.observe(worker, "completed")["outcome"] == "settled", "replayed pull did not settle")
        finally:
            self.proxy.target = target
        until = utc_stamp()
        local = self.decoded(worker, since=since, until=until)
        raw = self.native_cli(worker, "diagnostics-export", "--since", since, "--until", until)
        require(self.decode_protected(raw.encode()) == local, "worker export decoders disagreed")
        exchanges = [event for event in local if event["msg"] == "worker.http_exchange" and event["route"] == "/api/v1/worker/pull"]
        require(len(exchanges) == 2 and len({event["request_id"] for event in exchanges}) == 2, "lost SQLite acquisition did not make one exact retry")
        failed, succeeded = sorted(exchanges, key=lambda event: -event["http_status"])
        require((failed["http_status"], succeeded["http_status"]) == (503, 200) and failed["input"] == succeeded["input"] and
                failed["sequence"] == succeeded["sequence"] == 1 and failed["checker_run_id"] == first["checker_run_id"] and
                succeeded["checker_run_id"] == second["checker_run_id"] and succeeded["pull_run_id"] == first["checker_run_id"],
                "checker entry, original poll and HTTP retry identities were not distinguishable")
        for exchange, origin in ((failed, self.origin_url), (succeeded, sibling)):
            events = self.broker_evidence(origin, "request_id", exchange["request_id"])
            other = sibling if origin == self.origin_url else self.origin_url
            self.broker_evidence(other, "request_id", exchange["request_id"], absent=True)
            timing = next(event for event in events if event["msg"] == "worker.pull_timing")
            require(timing["sequence"] == exchange["sequence"] and timing["checker_run_id"] == exchange["pull_run_id"], "broker timing did not link to the original poll")
            scheduled_at = datetime.fromisoformat(timing["scheduled_at"])
            entered_at = datetime.fromisoformat(timing["entered_at"])
            require((entered_at - scheduled_at).total_seconds() >= 15, "scheduler delay was not independent of HTTP acquisition")
            if exchange is failed:
                fault = next(event for event in events if event["msg"] == "worker.pull_failed")
                require(fault["reason"] == "database_busy" and fault["phase"] == "begin" and fault["transaction_outcome"] == "not_started" and
                        timing["transaction_acquire_us"] >= 1800000 and timing["queue_lookup_us"] == 0, "lock failure was reported as queue lookup latency")
            else:
                lookup = timing["queue_lookup_us"]
                require(lookup >= 50000 and lookup > 2 * timing["transaction_acquire_us"] and timing["duration_ms"] * 1000 + 1000 >= lookup and
                        not timing["replayed"] and
                        any(event["msg"] == "job.claimed" and event["claim_id"] == grant["claim_id"] for event in events),
                        "injected query work was not attributed to the indexed lookup instead of scheduler entry or acquisition")
        operation = experiment["id"]
        submitted = self.broker_evidence(self.origin_url, "operation_id", operation)
        finished = self.broker_evidence(sibling, "operation_id", operation)
        require(submitted and [event["claim_id"] for event in finished if event["msg"] == "job.work_settled"] == [grant["claim_id"]],
                "protected broker logs did not reconstruct admission and one terminal receipt")
        self.receipt("worker.pull_delay_causal_evidence", brokers=2, scheduled_delay_measured=True, sqlite_lock="not_started",
                     indexed_lookup_measured=True, attempts=2, claims=1, transport="loopback_https")

    def exact_pull(self, worker):
        pull_path = "/api/v1/worker/pull"
        delayed = utc_stamp(datetime.now(timezone.utc) - timedelta(seconds=61))
        require(self.tick(worker, input_override={"scheduled_at": delayed})["outcome"] == "coalesced", "late occurrence was not coalesced")
        self.proxy.lose_worker_replies[pull_path] = 1
        self.tick(worker, want=1)
        first = worker["last_tick"]
        outcome = self.tick(worker)
        require(outcome["outcome"] == "idle" and outcome["sequence"] == 1 and outcome["pull_run_id"] == first["checker_run_id"],
                "lost empty pull acknowledgement changed the poll identity")
        require(self.cron_json(worker, "cron-check", first)["outcome"] == "coalesced", "an older tick re-polled")
        events = self.decoded(worker)
        pulls = [event for event in events if event.get("route") == pull_path and event["msg"] == "worker.http_exchange"]
        require(len(pulls) == 1 and pulls[0]["input"]["checker_run_id"] == first["checker_run_id"], "idle pull replay did not retain its occurrence")
        diagnostic, _ = self.diagnose(pulls[0]["request_id"], "worker.pull_timing")
        require(diagnostic["replayed"] and diagnostic["sequence"] == 1 and diagnostic["queue_lookup_us"] == 0, "broker processed a replay like new work")
        self.receipt("worker.exact_empty_poll_replay", sequence=outcome["sequence"], protected_evidence=True)

    def finite_tool_loop(self, worker):
        fixture = self.private("client-only-fixture.txt", "client-only exact bytes\nsecond line\n")
        experiment = self.create(worker, "Read the private client fixture")
        job_id = experiment["current_job_id"]
        grant = self.claim_work(worker, job_id)
        work = worker["work"]["definition"]
        require(self.observe(worker, "queued", matches=[])["outcome"] == "recovery_pending", "missing listing was treated as non-delivery")
        duplicated = {**work, "status": "queued"}
        require(self.observe(worker, "queued", matches=[duplicated, {**duplicated, "native_job_id": "foreign-once"}])["outcome"] == "recovery_pending",
                "ambiguous listing selected a work execution")
        original_occurrence = worker["last_tick"]["checker_run_id"]
        require(self.tick(worker)["outcome"] == "recovery_pending", "uncertain registration lost its claim")
        intervening_occurrence = worker["last_tick"]["checker_run_id"]
        require(self.observe(worker, "unobservable", matches=[])["outcome"] == "recovery_pending", "zero-match checker released the hold")
        require(self.tick(worker)["outcome"] == "recovery_pending", "next checker did not retain the hold")
        observing_occurrence = worker["last_tick"]["checker_run_id"]
        require(len({original_occurrence, intervening_occurrence, observing_occurrence}) == 3, "test did not enter distinct observing occurrences")
        run = {"native_job_id": work["native_job_id"], "status": "failed"}
        for foreign in (work["native_job_id"], worker["checker"], original_occurrence, intervening_occurrence, observing_occurrence):
            mistaken = {**work, "status": "failed", "execution": {**run, "native_run_id": foreign}}
            require(self.observe(worker, "failed", matches=[mistaken])["outcome"] == "recovery_pending" and
                    self.status(worker)["work_status"] == "busy", "a definition or checker ID was accepted as a terminal execution")
        for mistaken in ({**work, "status": "failed", "native_run_id": "unlinked-run"},
                         {**work, "status": "failed", "execution": {**run, "native_job_id": "foreign-once", "native_run_id": "foreign-run"}}):
            require(self.observe(worker, "failed", matches=[mistaken])["outcome"] == "recovery_pending" and
                    self.status(worker)["work_status"] == "busy", "an unlinked or foreign execution released the claim")
        before = self.status(worker)["last_poll_at"]
        require(self.observe(worker, "queued", run=False)["outcome"] == "queued" and self.tick(worker)["outcome"] == "queued", "unstarted native job did not hold the claim")
        brief = self.start_work(worker)
        self.start_work(worker, want=1)
        require(brief["context"]["kind"] == "full" and len(brief["context"]["messages"]) == 2, "native work brief lost canonical context")
        require(self.observe(worker, "running")["outcome"] == "running" and self.tick(worker)["outcome"] == "running" and
                self.status(worker)["last_poll_at"] == before, "busy helper performed a work pull")
        tool = {"type": "tool_call", "call_id": "controlled-client-call", "name": "read_file", "arguments": {"path": str(fixture)}}
        decision = self.submit_cli(worker, job_id, tool)
        require(decision["outcome"] == "accepted" and decision["claim_id"] == grant["claim_id"], "tool decision did not reconcile to the claim")
        require(self.experiment(experiment["id"])["state"] == "waiting_for_tool" and self.status(worker)["work_status"] == "busy",
                "broker released the slot before native stop despite an accepted tool decision")
        require(self.observe(worker, "completed", run=False)["outcome"] == "recovery_pending" and
                self.status(worker)["work_status"] == "busy", "job-only terminal status reused a previously observed run ID")
        require(self.observe(worker, "completed")["outcome"] == "settled", "completed tool generation did not settle")
        continuation, _ = self.checked("/api/v1/admin/experiments/" + experiment["id"] + "/tool-results", self.admin, "POST",
                                       {"protocol_version": 1, "submission_id": "controlled-tool-result", "call_id": tool["call_id"], "output": fixture.read_text()}, want=202)
        followup = continuation["current_job_id"]
        self.claim_work(worker, followup)
        second = self.start_work(worker)
        require(second["context"]["messages"][-1]["output"] == fixture.read_text(), "client result did not reach canonical context")
        self.proxy.lose_worker_replies["/api/v1/worker/jobs/" + followup + "/interrupt"] = 1
        self.submit_cli(worker, followup, {"type": "final", "text": fixture.read_text()})
        self.observe(worker, "completed", want=1)
        require((worker["state"] / "cron-claim.json").is_file(), "lost settlement prematurely cleared local work")
        require(self.tick(worker)["outcome"] == "settled", "exact settlement replay needed another native lookup")
        require(self.experiment(experiment["id"])["final_text"] == fixture.read_text(), "recovery changed the client answer")
        events = self.export_operation(experiment["id"])
        require(len([event for event in events if event["msg"] == "decision.accepted"]) == 2, "tool or final decision duplicated")
        self.receipt("worker.finite_tool_and_final", occurrences_distinct=True, busy_pulls=0, model_fixture="controlled")

    def start_before_registration_reply(self, worker):
        experiment = self.create(worker, "finite work starts before its registration acknowledgement", tools=False)
        job_id = experiment["current_job_id"]
        grant = self.claim_work(worker, job_id)
        self.start_work(worker)
        self.start_work(worker, want=1)
        require(self.observe(worker, "running", matches=[])["outcome"] == "recovery_pending",
                "a lost registration reply authorized another launch after work had started")
        require(self.observe(worker, "running")["outcome"] == "running", "lookup could not adopt the already-started native job")
        self.submit_cli(worker, job_id, {"type": "final", "text": "one authorized result"})
        require(self.observe(worker, "completed")["outcome"] == "settled", "early work did not settle")
        events = self.export_operation(experiment["id"])
        started = [event for event in events if event["msg"] == "job.work_started"]
        require(len(started) == 1 and started[0]["claim_id"] == grant["claim_id"] and
                self.experiment(experiment["id"])["final_text"] == "one authorized result", "registration race duplicated or lost authorization")
        self.receipt("worker.start_before_registration_reply", native_scheduler="controlled", executions=1)

    def invalid_saved_result(self, worker):
        experiment = self.create(worker, "reuse of an accepted call ID must fail without stranding the slot")
        first = experiment["current_job_id"]
        self.claim_work(worker, first)
        self.start_work(worker)
        tool = {"type": "tool_call", "call_id": "single-client-call", "name": "read_file", "arguments": {"path": "client-only"}}
        self.submit_cli(worker, first, tool)
        require(self.observe(worker, "completed")["outcome"] == "settled", "initial tool decision did not settle")
        continuation, _ = self.checked("/api/v1/admin/experiments/" + experiment["id"] + "/tool-results", self.admin, "POST",
                                       {"protocol_version": 1, "submission_id": "client-result-once", "call_id": tool["call_id"], "output": "client-verified"}, want=202)
        followup = continuation["current_job_id"]
        self.claim_work(worker, followup)
        self.start_work(worker)
        self.submit_cli(worker, followup, tool, want=1)
        require(self.status(worker)["work_status"] == "busy", "rejected output released an unobserved execution")
        require(self.observe(worker, "failed")["outcome"] == "settled", "confirmed stop could not settle a definitively invalid result")
        events = self.export_operation(experiment["id"])
        require(self.experiment(experiment["id"])["state"] == "interrupted" and
                sum(event["msg"] == "decision.accepted" for event in events) == 1 and
                sum(event["msg"] == "job.work_settled" and event["job_id"] == followup for event in events) == 1,
                "invalid result retried the client tool or committed multiple terminal receipts")
        self.receipt("worker.invalid_saved_decision", client_tools_repeated=0, terminal_receipts=1)

    def ambiguous_start(self, worker, committed):
        marker = "lost start acknowledgement after commit" if committed else "lost start request before delivery"
        experiment = self.create(worker, marker, tools=False)
        job_id = experiment["current_job_id"]
        grant = self.claim_work(worker, job_id)
        route = "/api/v1/worker/jobs/" + job_id + "/start"
        if committed:
            self.proxy.lose_worker_replies[route] = 1
        else:
            self.proxy.worker_route_failures[route] = ["disconnect"]
        self.start_work(worker, want=1)
        self.start_work(worker, want=1)
        require(self.tick(worker)["outcome"] == "recovery_pending", "uncertain start was granted a second launch")
        require(self.observe(worker, "failed")["outcome"] == "settled" and self.experiment(experiment["id"])["state"] == "interrupted",
                "confirmed native failure did not reconcile the uncertain start")
        events = self.export_operation(experiment["id"])
        started = [event for event in events if event["msg"] == "job.work_started"]
        require(len(started) == int(committed) and (not started or started[0]["claim_id"] == grant["claim_id"]), "start ambiguity was not reconstructed from broker evidence")
        self.receipt("worker.start_reply_ambiguity", committed=committed, start_events=len(started), retry_exposed_brief=False)

    def cancel_before_start(self, worker):
        experiment = self.create(worker, "cancel before a native work turn", tools=False)
        self.claim_work(worker, experiment["current_job_id"])
        self.cancel(experiment["id"])
        self.start_work(worker, want=1)
        require(self.status(worker)["work_status"] == "busy" and self.observe(worker, "failed")["outcome"] == "settled",
                "client cancellation did not preserve the uncertain native hold")
        require(self.experiment(experiment["id"])["state"] == "cancelled" and self.tick(worker)["outcome"] == "idle", "settlement changed cancellation or suppressed the next idle pull")
        self.receipt("worker.late_start_after_cancellation", exposed_brief=False, slot_released_after_native_stop=True)

    def expire_before_start(self, worker):
        experiment = self.create(worker, "deadline passes before native work begins", tools=False, timeout=7)
        job_id = experiment["current_job_id"]
        grant = self.claim_work(worker, job_id)
        expires = datetime.fromisoformat(grant["deadline_at"].replace("Z", "+00:00"))
        self.until(lambda: datetime.now(timezone.utc) >= expires, "original deadline was not reached", timeout=12)
        self.start_work(worker, want=1)
        require(self.status(worker)["work_status"] == "busy" and self.observe(worker, "failed")["outcome"] == "settled",
                "expired start released the slot without confirming the native stop")
        events = self.export_operation(experiment["id"])
        require(not any(event["msg"] == "job.work_started" for event in events) and self.experiment(experiment["id"])["state"] == "interrupted",
                "expired work was authorized")
        self.receipt("worker.late_start_after_deadline", exposed_brief=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    parser.add_argument("--package-receipt", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    harness = WorkerTransport(args)
    proxy = None
    try:
        harness.baseline()
        harness.setup()
        harness.main_service, harness.origin_url, _ = harness.launch(harness.configuration())
        harness.ready(harness.main_service, harness.origin_url)
        sibling, sibling_origin, _ = harness.launch(harness.configuration())
        harness.ready(sibling, sibling_origin)
        proxy = harness.proxy = TLSFixture(harness, harness.origin_url)
        worker = harness.cli_worker("primary", harness.legacy_release())
        node = json.loads(harness.docker("image", "inspect", NODE_IMAGE).stdout)[0]
        harness.receipt("worker.runtime_identity", node_image=NODE_IMAGE, image_id=node["Id"], package_sha256=harness.package_receipt["sha256"], source_sha=args.source_sha, source_dirty=args.source_dirty)
        harness.exact_pull(worker)
        harness.joined_pull_diagnosis(sibling_origin)
        harness.finite_tool_loop(worker)
        harness.start_before_registration_reply(worker)
        harness.invalid_saved_result(worker)
        harness.ambiguous_start(worker, committed=False)
        harness.ambiguous_start(worker, committed=True)
        harness.cancel_before_start(worker)
        harness.expire_before_start(worker)
        harness.private("results.json", json.dumps({"suite": "worker-transport", "native_scheduler": "controlled", "transport": "loopback_https", "source_sha": args.source_sha, "package_sha256": harness.package_receipt["sha256"], "receipts": harness.receipts}))
    finally:
        if proxy:
            proxy.close()
        harness.cleanup()


if __name__ == "__main__":
    main()
