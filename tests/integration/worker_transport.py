#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import time

from inference import Inference
from service import LABEL, require
from worker_tls import TLSFixture

NODE_IMAGE = "node:24.22.2-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4"


class WorkerTransport(Inference):
    def __init__(self, args):
        super().__init__(args)
        receipt = json.loads(Path(args.package_receipt).read_text())
        archive = Path(receipt["archive"])
        require(hashlib.sha256(archive.read_bytes()).hexdigest() == receipt["sha256"], "worker package archive changed")
        require(receipt["source"]["source_sha"] == args.source_sha and receipt["source"]["source_dirty"] == (args.source_dirty == "true"), "worker package source identity differs")
        self.package = archive.parent / "unpacked" / "package"
        self.package_receipt = receipt
        self.processes = []

    def container(self, state, command):
        state.mkdir(mode=0o700, exist_ok=True)
        identity = self.docker("create", "-i", "--label", LABEL + "=" + self.owner, "--network", "host", "--read-only",
                               "--user", str(os.getuid()) + ":" + str(os.getgid()),
                               "--mount", "type=bind,source=" + str(self.package.resolve()) + ",target=/opt/worker,readonly",
                               "--mount", "type=bind,source=" + str(state.resolve()) + ",target=/state",
                               "--mount", "type=bind,source=" + str(self.proxy.cert) + ",target=/opt/ca.pem,readonly",
                               "-e", "NODE_EXTRA_CA_CERTS=/opt/ca.pem", NODE_IMAGE,
                               "node", "/opt/worker/dist/main.js", command[0], "--state-dir", "/state", *command[1:]).stdout.strip()
        return self.remember("containers", identity)

    def command(self, worker, *command, input_text=None, want=0):
        identity = self.container(worker["state"], command)
        result = self.docker("start", "-ai", identity, input_text=input_text, success=False, timeout=60)
        self.private(identity[:12] + ".stdout", result.stdout)
        self.private(identity[:12] + ".stderr", result.stderr)
        self.assert_private(result.stdout + result.stderr)
        require(self.inspect(identity)["State"]["ExitCode"] == want, "worker command failed: " + command[0] + "; see private receipts")
        return result.stdout

    def cli_worker(self, suffix):
        worker = {"state": self.root.resolve() / ("worker-" + suffix)}
        self.command(worker, "configure", "--origin", self.proxy.origin)
        registration = self.issue()
        response = json.loads(self.command(worker, "enroll", "--code-stdin", input_text=registration["enrollment_code"] + "\n"))
        credential = (worker["state"] / "credential.key").read_text().strip()
        self.secrets.append(credential)
        worker.update({"worker": {"id": response["worker_id"]}, "credential": credential})
        require((worker["state"].stat().st_mode & 0o777) == 0o700 and ((worker["state"] / "credential.key").stat().st_mode & 0o777) == 0o600, "worker credential storage is not protected")
        self.command(worker, "enroll", "--code-stdin", input_text=registration["enrollment_code"] + "\n")
        require((worker["state"] / "credential.key").read_text().strip() == credential, "repeated enrollment replaced healthy identity")
        return worker

    def start(self, worker):
        connection_file = worker["state"] / "connection.json"
        previous = json.loads(connection_file.read_text()).get("connection_id") if connection_file.exists() else None
        identity = self.container(worker["state"], ["run"])
        self.docker("start", identity)
        worker["daemon"] = identity
        self.processes.append(identity)
        def healthy():
            if not connection_file.exists():
                return False
            connection = json.loads(connection_file.read_text())
            return bool(connection.get("connection_id")) and connection["connection_id"] != previous and connection.get("status") == "online" and bool(connection.get("last_heartbeat_at")) and self.status(worker)["connection_status"] == "online"
        self.until(healthy, "replacement CLI never established its own healthy SSE", timeout=30)
        return identity

    def wait_job(self, worker, experiment):
        job_id = experiment["current_job_id"]
        def pending():
            path = worker["state"] / "pending.json"
            if not path.exists():
                return False
            return any(j["job_id"] == job_id and j["state"] == "pending" for j in json.loads(path.read_text())["jobs"])
        self.until(pending, "real subscriber did not expose claimed context", timeout=25)
        return json.loads(self.command(worker, "job-show", "--job-id", job_id))

    def submit_cli(self, worker, job_id, decision, want=0):
        raw = self.command(worker, "decision-submit", "--job-id", job_id, "--input", "-", input_text=json.dumps(decision), want=want)
        return json.loads(raw) if want == 0 else None

    def decoded(self, worker, operation=None):
        args = ["diagnostics-export"]
        if operation:
            args.extend(["--operation-id", operation])
        raw = self.command(worker, *args)
        metadata, events = self.decode_export(raw.encode())
        require(metadata["complete"] and events, "worker diagnostic evidence is incomplete")
        self.assert_private(json.dumps(events))
        decoded = self.command(worker, *args, "--decode")
        values = [json.loads(line) for line in decoded.splitlines()]
        require(values[0]["complete"] and values[0]["captures"] == len(values) - 1, "worker decoder/export disagrees")
        return events

    def long_health(self, worker):
        from datetime import datetime
        initial = json.loads((worker["state"] / "connection.json").read_text())
        connection_id = initial["connection_id"]
        first = datetime.fromisoformat(initial["last_heartbeat_at"].replace("Z", "+00:00")).timestamp()
        def past_window():
            current = json.loads((worker["state"] / "connection.json").read_text())
            require(current["connection_id"] == connection_id, "subscription changed during long-health proof")
            latest = datetime.fromisoformat(current["last_heartbeat_at"].replace("Z", "+00:00")).timestamp()
            return latest - first > 31
        self.until(past_window, "one authenticated subscription did not remain healthy beyond 30 seconds", timeout=55)
        require(self.status(worker)["connection_status"] == "online", "long-health subscription is not online")
        events = self.decoded(worker)
        challenges = [e for e in events if e["msg"] == "worker.sse_event" and e["event_type"] == "health.challenge" and e["payload"]["connection_id"] == connection_id]
        replies = [e for e in events if e["msg"] == "worker.http_exchange" and e["route"].endswith("/heartbeat") and e["input"]["connection_id"] == connection_id and e["http_status"] == 200 and e["output"]["connection_status"] == "online"]
        require(len(challenges) >= 4 and len(replies) >= 4, "same-connection challenge/reply evidence incomplete")
        times = [datetime.fromisoformat(e["time"].replace("Z", "+00:00")).timestamp() for e in replies]
        require(max(times) - min(times) > 30, "health evidence did not span 30 seconds on the identified connection")
        self.long_health_proven = True
        self.receipt("worker.same_connection_long_health", connection_id=connection_id, observed_seconds=max(times) - min(times), successful_heartbeats=len(replies))

    def tool_loop(self, worker):
        fixture = self.private("client-only.txt", "exact-client-" + secrets.token_hex(24) + "\nsecond line\n")
        probe = self.docker("exec", worker["daemon"], "sh", "-ec", 'test ! -e "$1"', "fixture-probe", str(fixture))
        require(probe.returncode == 0, "client fixture entered worker filesystem")
        a = self.create(worker, "request-A-" + "complete-context-λ" * 2000)
        aj = self.wait_job(worker, a)
        require(aj["context"]["kind"] == "full" and aj["conversation_id"] == a["conversation_id"], "CLI context identity differs")
        require(not any(e.get("msg") == "worker.decision_input" for e in self.decoded(worker, a["id"])), "daemon fabricated a model decision")
        invalid = {"type": "tool_call", "call_id": "client-call", "name": "read_file", "arguments": {"path": 7}}
        self.submit_cli(worker, a["current_job_id"], invalid, want=1)
        tool = {**invalid, "arguments": {"path": str(fixture), "scale": 9007199254740993}}
        self.proxy.drop_decision = True
        accepted = self.submit_cli(worker, a["current_job_id"], tool)
        require(accepted["experiment"]["state"] == "waiting_for_tool" and self.proxy.dropped == 1, "accepted response loss was not exercised")
        repeated = self.submit_cli(worker, a["current_job_id"], tool)
        require(repeated["submission_id"] == accepted["submission_id"], "CLI retry changed accepted operation identity")
        require(len(self.experiment(a["id"])["messages"]) == 3, "decision retry duplicated canonical history")
        b = self.create(worker, "independent-session-B", tools=False)
        bj = self.wait_job(worker, b)
        require(bj["conversation_id"] != aj["conversation_id"] and "request-A" not in json.dumps(bj["context"]), "CLI interleaved sessions mixed context")
        self.submit_cli(worker, b["current_job_id"], {"type": "final", "text": "B-only"})
        result = fixture.read_text()
        resumed, _ = self.checked("/api/v1/admin/experiments/" + a["id"] + "/tool-results", self.admin, "POST", {"protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": "client-call", "output": result, "context_probe": {"kind": "delta", "base_receipt_id": a["current_job_id"]}}, want=202)
        next_job = self.wait_job(worker, resumed)
        require(next_job["context"]["kind"] == "delta" and next_job["context"]["base_receipt_id"] == a["current_job_id"], "CLI lost delta base receipt")
        require(next_job["context"]["messages"][-1]["output"] == result, "CLI delta dropped exact tool result")
        self.submit_cli(worker, resumed["current_job_id"], {"type": "final", "text": result})
        final = self.experiment(a["id"])
        require(final["final_text"] == result and len(final["messages"]) == 5, "client result/final linkage differs")
        events = self.decoded(worker, a["id"])
        rejected = [e for e in events if e["msg"] == "worker.decision_rejected"]
        require(rejected and rejected[0]["reason"] == "invalid_tool_arguments" and rejected[0]["request_id"], "worker logs cannot diagnose rejected arguments")
        exchanges = [e for e in events if e["msg"] == "worker.http_exchange" and (e.get("input") or {}).get("decision", {}).get("arguments", {}).get("scale") == 9007199254740993]
        require(exchanges and any(e["msg"] == "worker.http_retrying" for e in events), "lost response/number fidelity not diagnosable")
        require(any(e["msg"] == "worker.context" and len(e["context"]["messages"][1]["text"]) > 6144 for e in events if e.get("context", {}).get("kind") == "full"), "large admitted context was omitted")
        broker_events = self.export_operation(a["id"])
        require(any(e.get("request_id") == rejected[0]["request_id"] and e["msg"] == "decision.rejected" for e in broker_events), "worker/broker request correlation differs")
        self.receipt("worker.tool_loop_interleaving_delta_and_lost_response", package_sha256=self.package_receipt["sha256"], canonical_messages=5, log_only_diagnosis=True, client_fixture_absent_in_worker=True, exact_large_integer=True)

    def claim_rejection_recovery(self, worker):
        self.proxy.fail_claims = 3
        e = self.create(worker, "recover an unsent claim", tools=False)
        self.wait_job(worker, e)
        failed = self.proxy.failed_claims
        require(len(failed) == 3 and len({json.dumps(v, sort_keys=True) for v in failed}) == 1, "unsent claim attempts changed identity or reached the broker")
        events = self.decoded(worker, e["id"])
        refusal = [v for v in events if v["msg"] == "worker.http_exchange" and v["route"].endswith("/claim") and v["http_status"] == 409 and v["output"].get("error") == "stale_connection"]
        retries = [v for v in events if v["msg"] == "worker.claim_retrying"]
        accepted = [v for v in events if v["msg"] == "worker.operation_accepted" and v.get("operation") == "claim"]
        require(refusal and retries and accepted, "claim recovery cannot be reconstructed from worker logs")
        require(retries[-1]["previous_submission_id"] == failed[0]["submission_id"] and accepted[-1]["submission_id"] != failed[0]["submission_id"], "fresh claim did not follow definitive rejection of its original journal")
        broker = self.export_operation(e["id"])
        require(len([v for v in broker if v["msg"] == "job.claimed"]) == 1, "claim recovery acquired more than one assignment")
        self.diagnose(refusal[-1]["request_id"], "lease.rejected", "stale_connection")
        self.submit_cli(worker, e["current_job_id"], {"type": "final", "text": "claimed once"})
        self.receipt("worker.unsent_claim_rejected_then_replaced", request_id=refusal[-1]["request_id"], unsent_attempts=3, accepted_assignments=1, log_only_diagnosis=True)

    def delayed_context_after_decision(self, worker):
        e = self.create(worker, "delayed context after accepted final", tools=False)
        job_id = e["current_job_id"]
        self.wait_job(worker, e)
        self.proxy.delay_context_job = job_id
        self.proxy.context_captured.clear()
        self.proxy.release_context.clear()
        showing = self.container(worker["state"], ["job-show", "--job-id", job_id])
        self.docker("start", showing)
        try:
            require(self.proxy.context_captured.wait(timeout=5), "context response was not captured before acceptance")
            self.submit_cli(worker, job_id, {"type": "final", "text": "completed before the old context"})
            require(not json.loads((worker["state"] / "pending.json").read_text())["jobs"], "accepted final did not clear pending work")
        finally:
            self.proxy.release_context.set()
        self.until(lambda: not self.inspect(showing)["State"]["Running"], "delayed context command did not finish")
        require(self.inspect(showing)["State"]["ExitCode"] == 0, "delayed context command failed")
        output = self.logs(showing)
        self.assert_private(output)
        self.private("delayed-context-output.log", output)
        require(not json.loads((worker["state"] / "pending.json").read_text())["jobs"], "old claimed response revived an accepted decision")
        events = self.decoded(worker, e["id"])
        require(any(v["msg"] == "worker.job_progress" and v.get("progress") == "broker_already_accepted_decision" and v["state"] == "completed" and v["observed_state"] == "claimed" and v["observed_held"] for v in events), "logs cannot reconstruct the accepted decision versus old claimed snapshot")
        accepted = [v for v in events if v["msg"] == "worker.operation_accepted" and v.get("operation") == "decision"]
        self.diagnose(accepted[-1]["request_id"], "decision.accepted")
        self.receipt("worker.accepted_decision_survives_delayed_context", request_id=accepted[-1]["request_id"], pending_jobs=0, log_only_diagnosis=True)

    def cancellation_reconnect(self, worker):
        e = self.create(worker, "stopped worker assignment", tools=False)
        self.wait_job(worker, e)
        old_connection = json.loads((worker["state"] / "connection.json").read_text())["connection_id"]
        self.proxy.interrupt()
        self.until(lambda: json.loads((worker["state"] / "connection.json").read_text()).get("connection_id") != old_connection and self.status(worker)["connection_status"] == "online", "subscriber did not reconnect", timeout=35)
        self.until(lambda: self.experiment(e["id"])["state"] == "interrupted", "disconnect failed to fence old assignment")
        require(self.status(worker)["work_status"] == "busy", "reconnect silently acknowledged unfinished inference")
        self.submit_cli(worker, e["current_job_id"], {"type": "final", "text": "stale"}, want=1)
        ack = json.loads(self.command(worker, "decision-submit", "--job-id", e["current_job_id"], "--ack-idle"))
        require(ack["acknowledgement"] == "queued", "explicit acknowledgement not queued")
        self.until(lambda: self.status(worker)["work_status"] == "idle", "fresh challenge did not confirm idle acknowledgement", timeout=20)
        final = self.create(worker, "full context after reconnect", tools=False)
        self.wait_job(worker, final)
        self.cancel(final["id"])
        self.until(lambda: self.status(worker)["work_status"] == "busy", "cancellation lost hold")
        self.command(worker, "decision-submit", "--job-id", final["current_job_id"], "--ack-idle")
        self.until(lambda: self.status(worker)["work_status"] == "idle", "cancelled work did not release after explicit ack", timeout=20)
        self.docker("stop", "--time", "5", worker["daemon"])
        credential = worker["credential"]
        self.start(worker)
        require((worker["state"] / "credential.key").read_text().strip() == credential, "worker process restart replaced identity")
        doctor = json.loads(self.command(worker, "doctor"))
        require(doctor["inference_readiness"] == "unverified" and doctor["worker"]["id"] == worker["worker"]["id"], "doctor invented model readiness or changed identity")
        events = self.decoded(worker)
        require(any(e["msg"] == "worker.stream_retrying" and e["last_event_id"] and e["delay_ms"] <= 30000 for e in events), "stream interruption lacks retry evidence")
        require(any(e["msg"] == "worker.idle_confirmed" for e in events), "explicit acknowledgement lacks broker outcome")
        self.receipt("worker.disconnect_fencing_explicit_ack_and_restart", identity_preserved=True, no_automatic_inference_retry=True)

    def offline_ack_reconnect(self, worker):
        e = self.create(worker, "queued acknowledgement before restart", tools=False)
        job_id = e["current_job_id"]
        self.wait_job(worker, e)
        self.docker("stop", "--time", "5", worker["daemon"])
        self.until(lambda: self.experiment(e["id"])["state"] == "interrupted", "stopped daemon did not fence the assignment")
        queued = json.loads(self.command(worker, "decision-submit", "--job-id", job_id, "--ack-idle"))
        require(queued["acknowledgement"] == "queued", "stopped daemon did not retain queued acknowledgement")
        self.start(worker)
        first = json.loads((worker["state"] / "connection.json").read_text())["last_heartbeat_at"]
        self.until(lambda: json.loads((worker["state"] / "connection.json").read_text())["last_heartbeat_at"] > first, "buffered cancellation was not followed by another health boundary", timeout=20)
        require(json.loads((worker["state"] / "acks" / (job_id + ".json")).read_text())["state"] == "confirmed", "reconnected daemon did not confirm the queued acknowledgement")
        require(self.status(worker)["work_status"] == "idle", "confirmed assignment still holds the worker")
        require(not json.loads((worker["state"] / "pending.json").read_text())["jobs"], "buffered cancellation revived confirmed idle work")
        self.command(worker, "job-show", "--job-id", job_id)
        require(not json.loads((worker["state"] / "pending.json").read_text())["jobs"], "context read revived confirmed idle work")
        events = self.decoded(worker, e["id"])
        accepted = [v for v in events if v["msg"] == "worker.idle_confirmed" and v.get("job_id") == job_id]
        preserved = [v for v in events if v["msg"] == "worker.job_progress" and v.get("job_id") == job_id and v.get("progress") == "broker_already_confirmed_idle"]
        require(accepted and len(preserved) >= 2 and all(v["state"] == "ack_confirmed" and not v["acknowledgement_required"] for v in preserved), "logs cannot reconstruct confirmation followed by preserved cancellation/context cues")
        self.diagnose(accepted[0]["request_id"], "worker.idle_confirmed")
        self.receipt("worker.offline_queued_ack_survives_buffered_cancel_and_show", request_id=accepted[0]["request_id"], pending_jobs=0, acknowledgement="confirmed", log_only_diagnosis=True)

    def expired_heartbeat(self, worker):
        prior = json.loads((worker["state"] / "connection.json").read_text())
        self.proxy.expire_heartbeat = True
        def recovered():
            current = json.loads((worker["state"] / "connection.json").read_text())
            return current.get("connection_id") != prior["connection_id"] and current.get("status") == "online" and self.status(worker)["connection_status"] == "online"
        self.until(recovered, "expired heartbeat did not establish a fresh healthy subscription", timeout=55)
        events = self.decoded(worker)
        refused = [e for e in events if e["msg"] == "worker.http_exchange" and e["route"].endswith("/heartbeat") and e["http_status"] == 409 and e["input"]["connection_id"] == prior["connection_id"] and e["output"].get("error") == "stale_connection"]
        require(refused, "real broker never rejected the delayed heartbeat as stale")
        failure = refused[-1]
        retry = [e for e in events if e["msg"] == "worker.stream_retrying" and e.get("request_id") == failure["request_id"] and e.get("reason") == "stale_connection"]
        require(retry and retry[-1]["last_event_id"] and retry[-1]["delay_ms"] <= 30000, "stale heartbeat lacks correlated reconnect evidence")
        healthy = [e for e in events if e["msg"] == "worker.http_exchange" and e["route"].endswith("/heartbeat") and e["http_status"] == 200 and e["input"]["connection_generation"] > prior["connection_generation"]]
        require(healthy, "fresh connection never answered an authenticated health challenge")
        self.diagnose(failure["request_id"], "lease.rejected", "stale_connection")
        require((worker["state"] / "credential.key").read_text().strip() == worker["credential"], "heartbeat recovery replaced worker identity")
        self.receipt("worker.expired_heartbeat_reconnect", request_id=failure["request_id"], old_generation=prior["connection_generation"], new_generation=healthy[-1]["input"]["connection_generation"], log_only_diagnosis=True, identity_preserved=True)

    def scope_permissions_and_health(self, worker):
        foreign = self.cli_worker("foreign")
        self.start(foreign)
        e = self.create(worker, "scope probe", tools=False)
        self.wait_job(worker, e)
        self.command(foreign, "job-show", "--job-id", e["current_job_id"], want=1)
        self.cancel(e["id"])
        self.command(worker, "decision-submit", "--job-id", e["current_job_id"], "--ack-idle")
        self.until(lambda: self.status(worker)["work_status"] == "idle", "scope probe hold not released", timeout=20)
        key = worker["state"] / "credential.key"
        key.chmod(0o644)
        self.command(worker, "doctor", want=1)
        key.chmod(0o600)
        errors = self.command(worker, "diagnostics-export", "--decode")
        require(any(json.loads(line).get("msg") == "worker.state_unsafe" and json.loads(line).get("expected_mode") == "600" and json.loads(line).get("observed_mode") == "644" for line in errors.splitlines()), "unsafe permissions cannot be diagnosed from collected logs")
        self.checked("/api/v1/admin/workers/" + foreign["worker"]["id"] + "/revoke", self.admin, "POST")
        self.until(lambda: not self.inspect(foreign["daemon"])["State"]["Running"], "revoked subscriber did not stop", timeout=35)
        require(self.inspect(foreign["daemon"])["State"]["ExitCode"] != 0, "revoked subscriber reported success")
        events = self.decoded(worker)
        require(self.long_health_proven, "same-subscription long-health proof is missing")
        require(self.status(worker)["inference_readiness"] == "unverified", "health established fake readiness")
        for identity in self.processes:
            logs = self.logs(identity)
            self.assert_private(logs)
            require('"level":"DEBUG"' not in logs, "DEBUG detail escaped INFO stderr filtering")
        self.receipt("worker.scope_permissions_revocation_and_long_health", same_connection_health_proven=True, permissions="0700/0600", log_only_diagnosis=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    parser.add_argument("--package-receipt", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = WorkerTransport(args)
    proxy = None
    try:
        h.baseline()
        h.setup()
        config = h.configuration()
        config["limits"] = {"max-jobs": 8, "in-flight-per-worker": 1}
        _, h.origin_url, _ = h.launch(config)
        h.ready(h.resources["containers"][-1], h.origin_url)
        proxy = h.proxy = TLSFixture(h, h.origin_url)
        worker = h.cli_worker("primary")
        h.start(worker)
        node = json.loads(h.docker("image", "inspect", NODE_IMAGE).stdout)[0]
        h.receipt("worker.runtime_identity", node_image=NODE_IMAGE, image_id=node["Id"], package_sha256=h.package_receipt["sha256"], source_sha=args.source_sha, source_dirty=args.source_dirty)
        h.command(worker, "run", want=1)
        h.long_health(worker)
        h.tool_loop(worker)
        h.claim_rejection_recovery(worker)
        h.delayed_context_after_decision(worker)
        h.expired_heartbeat(worker)
        h.cancellation_reconnect(worker)
        h.offline_ack_reconnect(worker)
        h.scope_permissions_and_health(worker)
        h.private("results.json", json.dumps({"suite": "worker-transport", "synthetic_decisions": True, "source_sha": args.source_sha, "package_sha256": h.package_receipt["sha256"], "receipts": h.receipts}))
    finally:
        if proxy:
            proxy.close()
        h.cleanup()


if __name__ == "__main__":
    main()
