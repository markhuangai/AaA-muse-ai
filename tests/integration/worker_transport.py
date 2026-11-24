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
RC2_BROKER = "ghcr.io/markhuangai/aaa-muse-ai@sha256:59afbc0a6d8d917c435e74410ca517cfd47ff3c1171a64f8c23f12f2113bf858"


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
        usage_mount = []
        if "subscription_path" in worker:
            usage_mount = ["--mount", "type=bind,source=" + str(worker["subscription_path"]) + ",target=/opt/subscription,readonly",
                           "-e", "PATH=/opt/subscription:/usr/local/bin:/usr/bin:/bin"]
        identity = self.docker("create", "-i", "--label", LABEL + "=" + self.owner, "--network", "host", "--read-only",
                               "--user", str(os.getuid()) + ":" + str(os.getgid()), "-e", "HOME=/state",
                               "--mount", "type=bind,source=" + str(worker.get("package", self.package).resolve()) + ",target=/opt/worker,readonly",
                               "--mount", "type=bind,source=" + str(state.resolve()) + ",target=/state",
                               "--mount", "type=bind,source=" + str(self.proxy.cert) + ",target=/opt/ca.pem,readonly",
                               "-e", "NODE_EXTRA_CA_CERTS=/opt/ca.pem", *usage_mount, NODE_IMAGE,
                               "node", "/opt/worker/dist/main.js", command[0], "--state-dir", "/state", *command[1:]).stdout.strip()
        self.remember("containers", identity)
        result = self.docker("start", "-ai", identity, input_text=input_text, success=False, timeout=60)
        self.private(identity[:12] + ".stdout", result.stdout)
        self.private(identity[:12] + ".stderr", result.stderr)
        self.assert_private(result.stdout + result.stderr)
        require(self.inspect(identity)["State"]["ExitCode"] == want, "worker command failed: " + command[0] + "; see private receipts")
        return result.stdout

    def cli_worker(self, suffix, registration=None, package=None):
        worker = {"state": self.root.resolve() / ("worker-" + suffix)}
        if package:
            worker["package"] = package
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

    def weekly_usage_check(self, sibling):
        worker = self.cli_worker("weekly-usage")
        checker = (worker["state"] / "cron-installation.json").read_bytes()
        directory = self.root.resolve() / "subscription-status-fixture"
        directory.mkdir(mode=0o700)
        worker["subscription_path"] = directory
        command = directory / "subscription-status"

        def status_script(lines):
            command.write_text("#!/bin/sh\n" + lines)
            command.chmod(0o700)

        status_script("test \"$#\" = 1 && test \"$1\" = status || exit 1\nprintf '%s\\n' 'Usage: 33.25% of free weekly limit.' 'Additional tokens: 89% used (provider-private)'\n")
        require(self.tick(worker)["outcome"] == "idle", "weekly allowance changed an idle check outcome")
        before = self.worker_projection(worker)[0]
        require(before["weekly_usage"]["used_percent"] == 33.25 and not before["weekly_usage"]["stale"], "broker did not receive the packed helper's reading")

        job = self.create(worker, "Held native work during weekly check", tools=False)
        grant = self.tick(worker)
        require(grant["outcome"] == "prepare" and grant["job_id"] == job["current_job_id"], "work pickup with weekly usage failed")
        claimed = self.worker_projection(worker)[0]
        target = self.proxy.target
        self.proxy.target = urlsplit(sibling)
        try:
            status_script("printf '%s\\n' 'Usage: 100% of free weekly limit.'\n")
            busy = self.tick(worker)
            after = self.worker_projection(worker, origin=sibling)[0]
            require(busy["outcome"] == "prepare" and after["weekly_usage"]["used_percent"] == 100 and
                    after["last_poll_at"] == claimed["last_poll_at"] and after["current_claim"] == claimed["current_claim"],
                    "busy check failed to report usage separately from the work poll and claim")

            status_script("trap '' TERM\nexec /bin/sleep 20\n")
            start = datetime.now(timezone.utc)
            degraded = self.tick(worker)
            require(degraded["outcome"] == "prepare" and (datetime.now(timezone.utc) - start).total_seconds() < 12,
                    "hanging status command blocked an existing busy check")
            require(self.worker_projection(worker)[0]["weekly_usage"] == after["weekly_usage"], "failed status command refreshed a reading")
        finally:
            self.proxy.target = target
        decoded = self.native_cli(worker, "diagnostics-export", "--decode")
        envelope, *records = [json.loads(raw) for raw in decoded.splitlines()]
        require(envelope["complete"] and not envelope["omissions"], "weekly usage worker export was incomplete")
        reading = next(record for record in records if record.get("msg") == "cron.weekly_usage_read" and
                       record["checker_run_id"] == busy["checker_run_id"])
        warning = next(record for record in records if record.get("msg") == "cron.weekly_usage_unavailable" and
                       record["reason"] == "subscription_status_timeout")
        log = next(record for record in records if record.get("msg") == "worker.http_exchange" and
                   record.get("checker_run_id") == warning["checker_run_id"] and record["route"].endswith("/presence"))
        require(reading["weekly_usage"]["used_percent"] == 100 and reading["level"] == "DEBUG" and
                warning["job_id"] == log["job_id"] == claimed["current_claim"]["job_id"] and warning["level"] == "WARN" and
                log["http_status"] == 200 and warning["timeout_ms"] == 2000 and warning["worker_id"] == worker["worker"]["id"] and
                "provider-private" not in decoded and (worker["state"] / "cron-installation.json").read_bytes() == checker,
                "protected worker evidence did not explain the timed-out reading and successful check-in")
        worker_id = worker["worker"]["id"]
        identities = set()
        for tick, origin, other in ((grant, self.origin_url, sibling), (busy, sibling, self.origin_url), (degraded, sibling, self.origin_url)):
            occurrence = tick["checker_run_id"]
            exchange, = [event for event in records if event["msg"] == "worker.http_exchange" and event.get("checker_run_id") == occurrence]
            self.broker_evidence(other, "request_id", exchange["request_id"], absent=True)
            broker = self.broker_evidence(origin, "request_id", exchange["request_id"])
            outcome_name = "job.claimed" if tick is grant else "worker.presence_observed"
            outcome, = [event for event in broker if event["msg"] == outcome_name]
            identities.add(outcome["instance_id"])
            require(exchange["http_status"] == 200 and outcome["checker_run_id"] == occurrence and
                    outcome["worker_id"] == worker_id == exchange["worker_id"] and
                    outcome["job_id"] == grant["job_id"] and outcome["operation_id"] == job["id"],
                    "protected broker records did not join the packed checker to the same job")
            reports = [event for event in broker if event["msg"] == "worker.weekly_usage_observed"]
            if tick is degraded:
                require(not reports and outcome["recorded"] and warning["checker_run_id"] == occurrence,
                        "failed collection did not reach the same broker check-in without a report")
                continue
            report, = reports
            sample = exchange["weekly_usage"]
            require(report["weekly_usage"]["used_percent"] == sample["used_percent"] and report["reason"] == "recorded" and
                    datetime.fromisoformat(report["weekly_usage"]["observed_at"]) == datetime.fromisoformat(sample["observed_at"]) and
                    report["level"] == "DEBUG", "broker observation did not match the packed checker's normalized sample")
            if tick is grant:
                routing, = [event for event in broker if event["msg"] == "dispatch.weekly_usage_decision"]
                require(routing["job_id"] == grant["job_id"] and routing["reason"] == "targeted_job" and
                        routing["effective_usage"]["used_percent"] == sample["used_percent"], "broker did not log the claim's quota decision")
        require(len(identities) == 2, "the usage and presence traces did not cover two brokers")
        self.receipt("worker.weekly_usage", original_checker=True, busy_report=True, command_timeout=True, linked_private_diagnostics=True, brokers=2)

    def legacy_native_hold(self):
        version = "1.0.0-rc.1"
        archive_name = "markhuangai-aaa-muse-worker-" + version + ".tgz"
        url = "https://github.com/markhuangai/AaA-muse-ai/releases/download/v" + version + "/" + archive_name
        with urllib.request.urlopen(url, timeout=120) as response:
            archive = response.read(1024 * 1024)
        digest = "2f2d1051d541dcc32c0a882727b8e8844125fdc5249f88e1bdd912905dd3595b"
        require(hashlib.sha256(archive).hexdigest() == digest, "reported-release fixture differs from the published archive")
        source = "d0956a0dbea074e848790fc9ae007802c9e1746a"
        directory = self.root.resolve() / "legacy-native-release"
        directory.mkdir(mode=0o700)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
            require(all(item.name.startswith("package/") and (item.isfile() or item.isdir()) and ".." not in Path(item.name).parts
                        for item in package.getmembers()), "legacy native archive paths unsafe")
            package.extractall(directory, filter="data")
        build = json.loads((directory / "package/dist/build.json").read_text())
        require(build["source_sha"] == source and build["package_version"] == version and not build["source_dirty"], "legacy native artifact provenance differs")
        worker = self.cli_worker("legacy-native", package=directory / "package")
        checker = (worker["state"] / "cron-installation.json").read_bytes()
        experiment = self.create(worker, "accepted reply with an unused legacy reservation", tools=False)
        job_id = experiment["current_job_id"]
        grant = self.claim_work(worker, job_id)
        self.start_work(worker)
        launch = grant["launch_id"]
        intent = json.loads(self.native_cli(worker, "cron-producer-intent", "--launch-id", launch))
        native = worker["work"]["definition"]
        parent, execution = native["native_job_id"], "controlled-execution-" + job_id
        require(self.observe(worker, "running")["outcome"] == "running", "legacy helper did not bind the real execution fixture")
        require(self.submit_cli(worker, job_id, {"type": "final", "text": "already accepted"})["outcome"] == "accepted", "legacy worker could not deliver to newer 1.x broker")
        claimed = self.worker_projection(worker)[0]
        require(self.tick(worker)["outcome"] == "running" and self.worker_projection(worker)[0]["last_contact_at"] == claimed["last_contact_at"],
                "legacy checker unexpectedly contacted the newer broker while busy")
        before = utc_stamp()
        worker.pop("package")
        active = self.tick(worker)
        require(active["history_lookup"]["native_job_id"] == parent and active["history_lookup"]["native_run_id"] == execution and
                active["lookup"] == {key: value for key, value in native.items() if key != "native_job_id"} and
                (worker["state"] / "cron-installation.json").read_bytes() == checker, "new helper changed the archived checker or work definition")
        evidence = {"native_job_id": parent, "native_run_id": execution, "status": "succeeded"}
        completed = {**native, "status": "completed"}
        require(self.observe(worker, "completed", matches=[completed], execution=evidence)["cause"] == "producer_launch_unobservable",
                "rc.1 execution shape did not reach the separate legacy producer guard")
        held = self.tick(worker)
        require(held["cause"] == "producer_launch_unobservable" and held["producer_id"] == intent["producer_id"] and held["lookup"] is None,
                "restart did not preserve the terminal proof and unresolved legacy intent")
        view = self.worker_projection(worker)[0]
        require(view["last_poll_at"] == claimed["last_poll_at"] and view["last_contact_at"] > claimed["last_contact_at"] and
                view["work_status"] == "busy" and view["claim_stage"] == "terminal_receipt" and view["busy_reason"] == held["cause"],
                "busy contact and accepted receipt were not independently visible")
        after = utc_stamp()
        observed = [event for event in self.decoded(worker, since=before, until=after) if event.get("operation_id") == experiment["id"]]
        pending = next(event for event in observed if event["msg"] == "cron.recovery_pending")
        terminal = next(event for event in observed if event["msg"] == "cron.native_observation" and event["outcome"] == "confirmed_stopped")
        require(pending["level"] == "WARN" and pending["producer_id"] == intent["producer_id"] and terminal["level"] == "INFO" and
                terminal["native_run_id"] == execution and terminal["evidence_source"] == "definition_and_execution", "worker logs cannot identify the hold")
        contact = [event for event in observed if event["msg"] == "cron.presence_observed" and event["hold_reason"] == held["cause"]]
        require(len(contact) == 1 and contact[0]["level"] == "DEBUG", "worker did not make exactly one busy check-in for the retained hold")
        broker = self.broker_evidence(self.origin_url, "request_id", contact[0]["request_id"])
        accepted = next(event for event in broker if event["msg"] == "worker.presence_observed")
        require(accepted["checker_run_id"] == held["checker_run_id"] and accepted["worker_id"] == worker["worker"]["id"] and
                accepted["claim_id"] == grant["claim_id"] and accepted["hold_reason"] == held["cause"] and accepted["recorded"],
                "broker evidence cannot reconstruct the held claim check-in")
        self.receipt("worker.legacy_native_hold_with_busy_presence", archived_sha256=digest, accepted=True, held=True, protected_evidence=True)

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

    def native_start_version_orders(self):
        # rc.2 shares the current schema but decodes the original strict JSON bodies.
        self.docker("pull", RC2_BROKER, timeout=120)
        original_image, original_target = self.args.image, self.proxy.target
        self.args.image = RC2_BROKER
        try:
            archived, origin, _ = self.launch(self.configuration())
            self.ready(archived, origin)
        finally:
            self.args.image = original_image
        try:
            self.proxy.target = urlsplit(origin)
            worker = self.cli_worker("native-start-mixed")
            legacy = self.create(worker, "fixed helper on rc.2", tools=False)
            grant = self.claim_work(worker, legacy["current_job_id"])
            require(not grant["claim_id"].startswith("verified-"), "old broker unexpectedly opted into proof")
            self.start_work(worker, self_report="unrelated-checker-occurrence", want=1)
            self.start_work(worker)
            self.submit_cli(worker, grant["job_id"], {"type": "final", "text": "same major legacy wire"})
            require(self.observe(worker, "completed")["outcome"] == "settled", "old broker could not settle verified local work")

            self.proxy.target = original_target
            experiment = self.create(worker, "verified pickup with an archived replay", tools=False)
            self.proxy.lose_worker_replies["/api/v1/worker/pull"] = 1
            self.tick(worker, want=1)
            original_tick = worker["last_tick"]
            self.proxy.target = urlsplit(origin)
            grant = self.tick(worker)
            require(grant["outcome"] == "prepare" and grant["job_id"] == experiment["current_job_id"] and
                    grant["claim_id"].startswith("verified-") and grant["pull_run_id"] == original_tick["checker_run_id"],
                    "old broker replay lost the granted contract")
            work = self.work_definition(worker, grant)
            job = grant["job_id"]
            run = "controlled-execution-" + job
            route = "/api/v1/worker/jobs/" + job
            start = {"protocol_version": 1, "claim_id": grant["claim_id"], "generation": grant["generation"],
                     "launch_id": grant["launch_id"], "native_job_id": work["native_job_id"]}
            proof = {"reference": grant["claim_id"], "native_job_id": work["native_job_id"], "native_run_id": run, "status": "running"}
            self.checked(route + "/start", worker["credential"], "POST", {**start, "verification": proof}, want=400, origin=origin)
            _, rejected_headers = self.checked(route + "/start", worker["credential"], "POST", {**start, "verification": {**proof, "native_run_id": original_tick["checker_run_id"]}},
                                               want=409)
            event = next(event for event in self.broker_evidence(self.origin_url, "request_id", rejected_headers["X-Request-Id"])
                         if event.get("reason") == "native_start_proof_mismatch" and event.get("msg") == "lease.rejected")
            require(event["level"] == "WARN" and event["job_id"] == job and
                    event["evidence"]["expected_reference"] == grant["claim_id"] and
                    event["evidence"]["observed_native_run_id"] == original_tick["checker_run_id"],
                    "broker refusal logs did not identify the unexpected checker occurrence")
            self.proxy.target = original_target
            self.start_work(worker)
            self.submit_cli(worker, job, {"type": "final", "text": "same pickup after archive replay"})
            self.proxy.target = urlsplit(origin)
            busy = self.tick(worker)
            require(busy["outcome"] == "recovery_pending" and busy["history_lookup"]["native_run_id"] == run,
                    "the verified run was missing from the busy checker's history lookup")
            legacy_presence = self.broker_evidence(origin, "operation_id", grant["operation_id"])
            require(any(event["msg"] == "worker.presence_observed" and event["claim_id"] == grant["claim_id"] for event in legacy_presence),
                    "archived broker never recorded the busy presence")
            settlement = {**start, "submission_id": "marked-legacy-stop", "native_run_id": run,
                          "reason": "execution_confirmed_stopped", "verified_start": True}
            self.checked(route + "/interrupt", worker["credential"], "POST", settlement, want=400, origin=origin)
            self.proxy.target = original_target
            for changed in ({"native_job_id": "unrelated-job"}, {"native_run_id": "unrelated-run"}):
                wrong = {**settlement, **changed}
                _, headers = self.checked(route + "/interrupt", worker["credential"], "POST", wrong, want=409)
                record = next(event for event in self.broker_evidence(self.origin_url, "request_id", headers["X-Request-Id"])
                              if event.get("reason") == "native_settlement_proof_mismatch" and event.get("msg") == "lease.rejected")
                evidence = record["evidence"]
                require(record["level"] == "WARN" and evidence["expected_native_job_id"] == work["native_job_id"] and
                        evidence["expected_native_run_id"] == run and evidence["observed_native_job_id"] == wrong["native_job_id"] and
                        evidence["observed_native_run_id"] == wrong["native_run_id"] and self.status(worker)["work_status"] == "busy",
                        "settlement refusal lost the identity diagnostics or cleared a live hold")
            require(self.observe(worker, "completed")["outcome"] == "settled" and self.status(worker)["work_status"] == "idle",
                    "old broker presence erased the recorded run")
            self.receipt("worker.native_start_after_archived_grant_replay", image=RC2_BROKER, wire_compatible=True, identity_preserved=True)
        finally:
            self.proxy.target = original_target

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
        experiment = self.create(worker, "deadline passes before native work begins", tools=False, timeout=20)
        job_id = experiment["current_job_id"]
        grant = self.claim_work(worker, job_id)
        expires = datetime.fromisoformat(grant["deadline_at"].replace("Z", "+00:00"))
        self.until(lambda: datetime.now(timezone.utc) >= expires, "original deadline was not reached", timeout=25)
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
        harness.legacy_native_hold()
        harness.start_before_registration_reply(worker)
        harness.invalid_saved_result(worker)
        harness.ambiguous_start(worker, committed=False)
        harness.ambiguous_start(worker, committed=True)
        harness.cancel_before_start(worker)
        harness.expire_before_start(worker)
        harness.weekly_usage_check(sibling_origin)
        harness.native_start_version_orders()
        harness.private("results.json", json.dumps({"suite": "worker-transport", "native_scheduler": "controlled", "transport": "loopback_https", "source_sha": args.source_sha, "package_sha256": harness.package_receipt["sha256"], "receipts": harness.receipts}))
    finally:
        if proxy:
            proxy.close()
        harness.cleanup()


if __name__ == "__main__":
    main()
