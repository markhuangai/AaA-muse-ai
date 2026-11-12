#!/usr/bin/env python3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import urllib.parse

from service import require
from worker_setup import WorkerSetup, run


class WorkerRecovery(WorkerSetup):
    def background_refusal(self, worker):
        return self.command(worker, ["bash", "-c", 'umask 077; exec "$@" 2>/home/worker/tmp/refused-background.stderr', "owned-background-refusal", worker["receipt"]["launcher"], "run", "--background", "--state-dir", "/home/worker/.local/state/aaa-muse-worker"], want=1)

    def pid(self, worker):
        return json.loads((worker["state"] / "launch.json").read_text())["pid"]

    def stop(self, worker, signal="TERM"):
        pid = self.pid(worker)
        self.command(worker, ["bash", "-c", 'kill -"$1" "$2"', "owned-worker-stop", signal, str(pid)])
        self.until(lambda: self.docker("exec", worker["container"], "bash", "-c", '! kill -0 "$1" 2>/dev/null', "owned-worker-exit", str(pid), success=False).returncode == 0, "owned worker process did not exit")
        return pid

    def online(self, worker, previous=None):
        path = worker["state"] / "connection.json"
        def healthy():
            if not path.exists():
                return False
            saved = json.loads(path.read_text())
            return saved.get("status") == "online" and saved.get("connection_id") != previous and self.status(worker)["connection_status"] == "online"
        self.until(healthy, "worker did not recover authenticated health", timeout=45)
        return json.loads(path.read_text())

    def events(self, worker, since=None, until=None, operation=None):
        filters = []
        for flag, value in (("--since", since), ("--until", until), ("--operation-id", operation)):
            if value:
                filters.extend([flag, value])
        raw = self.cli(worker, "diagnostics-export", *filters).stdout
        require(all(len(line.encode()) + 1 <= 6144 for line in raw.splitlines()), "worker capture record exceeds its bound")
        metadata, values = self.decode_export(raw.encode())
        require(metadata["complete"] and not metadata["omissions"], "worker recovery export incomplete")
        decoded = self.cli(worker, "diagnostics-export", "--decode", *filters).stdout
        require(json.loads(decoded.splitlines()[0])["complete"], "decoded worker export incomplete")
        emergency = (worker["state"] / "daemon.stderr").read_text()
        self.assert_private(emergency)
        require(not any(json.loads(line).get("level") == "DEBUG" for line in emergency.splitlines()), "DEBUG escaped INFO runtime filtering")
        self.assert_private(json.dumps(values))
        return values

    def wait_job(self, worker, experiment):
        job_id = experiment["current_job_id"]
        self.until(lambda: (worker["state"] / "pending.json").exists() and any(j["job_id"] == job_id and j["state"] == "pending" for j in json.loads((worker["state"] / "pending.json").read_text())["jobs"]), "subscriber did not publish the assigned job")
        return json.loads(self.cli(worker, "job-show", "--job-id", job_id).stdout)

    def startup_outage(self, worker):
        since = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        previous = self.online(worker)
        self.stop(worker)
        with self.proxy.lock:
            self.proxy.allow_statuses = 1
            self.proxy.fail_statuses = 3
        self.hook(worker)
        current = self.online(worker, previous["connection_id"])
        require(not (worker["state"] / "run-stop.json").exists(), "transient startup outage created a terminal marker")
        until = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        events = self.events(worker, since, until)
        retry = [e for e in events if e["msg"] == "worker.stream_retrying" and e.get("phase") == "authentication" and e.get("worker_id") == worker["worker"]["id"] and e.get("command") == "run"]
        require(retry and retry[-1]["http_status"] == 503 and retry[-1]["request_id"] and retry[-1]["delay_ms"] == 1000, "startup failure cannot be diagnosed from logs")
        scope = [e for e in events if e.get("worker_id") == worker["worker"]["id"] and e.get("command") == "run" and e.get("instance_id") == retry[-1]["instance_id"]]
        require(all(datetime.fromisoformat(since) <= datetime.fromisoformat(e["time"].replace("Z", "+00:00")) <= datetime.fromisoformat(until) for e in scope), "startup export crossed its incident interval")
        require(any(e["msg"] == "worker.recovery_reconciled" for e in scope) and any(e["msg"] == "worker.connected" for e in scope), "retrying process did not reconcile and connect")
        require(any(e.get("event") == "fixture.request_rejected" and e.get("request_id") == retry[-1]["request_id"] and not e["forwarded"] for e in self.proxy.events), "fixture failure was mistaken for a forwarded broker operation")
        forwarded = [e for e in scope if e["msg"] == "worker.http_exchange" and e.get("route") == "/api/v1/worker/status" and e.get("http_status") == 200]
        require(forwarded, "recovered process has no successful authenticated broker exchange")
        authenticated, _ = self.diagnose(forwarded[-1]["request_id"], "worker.authenticated")
        require(authenticated["worker_id"] == worker["worker"]["id"], "startup broker join crossed worker identities")
        self.private("startup-recovery-diagnosis.json", json.dumps({"since": since, "until": until, "instance_id": retry[-1]["instance_id"], "fixture_failure_request_id": retry[-1]["request_id"], "broker_request_id": forwarded[-1]["request_id"], "cause": "three fixture-generated 503 replies exhausted startup HTTP attempts without reaching the broker", "corrective_action": "restore the broker route; the subscriber retries without reinstall or enrollment", "events": scope}))
        self.receipt("worker.recovery_startup_outage", request_id=retry[-1]["request_id"], old_generation=previous["connection_generation"], new_generation=current["connection_generation"], log_only_diagnosis=True, terminal_marker=False)

    def crash_and_duplicate(self, worker):
        since = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        previous = self.online(worker)
        first = self.stop(worker, "KILL")
        require((worker["state"] / "daemon.lock").exists(), "abrupt crash did not retain a stale lock")
        self.hook(worker)
        self.online(worker, previous["connection_id"])
        second = self.pid(worker)
        require(first != second, "hook did not replace the crashed process")
        owner = (worker["state"] / "daemon.lock/owner.json").read_bytes()
        launch = (worker["state"] / "launch.json").read_bytes()
        self.background_refusal(worker)
        for _ in range(2):
            self.hook(worker)
        require((worker["state"] / "daemon.lock/owner.json").read_bytes() == owner and (worker["state"] / "launch.json").read_bytes() == launch, "duplicate invocation replaced the owner")
        require(not (worker["state"] / "run-stop.json").exists(), "duplicate invocation poisoned recovery")
        until = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        events = self.events(worker, since, until)
        owners = [e for e in events if e["msg"] == "worker.supervision_started" and e.get("pid") == second and e.get("outcome") == "exclusive_owner" and e.get("worker_id") == worker["worker"]["id"] and e.get("command") == "run"]
        require(len(owners) == 1, "exclusive owner evidence missing or duplicated")
        scope = [e for e in events if e.get("worker_id") == worker["worker"]["id"] and e.get("command") == "run" and e.get("instance_id") == owners[0]["instance_id"]]
        require(scope and all(datetime.fromisoformat(since) <= datetime.fromisoformat(e["time"].replace("Z", "+00:00")) <= datetime.fromisoformat(until) for e in scope), "supervision export crossed its incident interval")
        duplicates = [e for e in events if e["msg"] == "worker.command_failed" and e.get("cause") == "subscriber_already_running" and e.get("worker_id") == worker["worker"]["id"] and e.get("command") == "run"]
        require(duplicates and duplicates[-1]["instance_id"] != owners[0]["instance_id"], "duplicate refusal lacks separate process correlation")
        forwarded = [e for e in scope if e["msg"] == "worker.http_exchange" and e.get("route") == "/api/v1/worker/status" and e.get("http_status") == 200]
        require(forwarded, "new owner has no authenticated broker exchange")
        authenticated, _ = self.diagnose(forwarded[-1]["request_id"], "worker.authenticated")
        require(authenticated["worker_id"] == worker["worker"]["id"], "supervision broker join crossed worker identities")
        self.private("supervision-" + str(second) + "-diagnosis.json", json.dumps({"since": since, "until": until, "instance_id": owners[0]["instance_id"], "duplicate_instance_id": duplicates[-1]["instance_id"], "broker_request_id": forwarded[-1]["request_id"], "cause": "previous process exited abruptly; a new exclusive owner connected and the contender was rejected", "corrective_action": "retain the current consumer and its identity; no reinstall or state deletion", "events": scope}))
        self.receipt("worker.recovery_crash_and_duplicate", one_consumer=True, identity_preserved=True, log_only_diagnosis=True)

    def lost_receipt(self, worker):
        experiment = self.create(worker, "controlled recovery tool request")
        shown = self.wait_job(worker, experiment)
        job_id = shown["job_id"]
        decision = json.dumps({"type": "tool_call", "call_id": "recovery-read", "name": "read_file", "arguments": {"path": "client-only.txt"}})
        self.proxy.decision_captured.clear()
        self.proxy.release_decision.clear()
        self.proxy.pause_decision = True
        command = ["bash", "-c", 'umask 077; printf "%s" "$$" > /home/worker/tmp/decision.pid; exec "$@"', "controlled-decision", worker["receipt"]["launcher"], "decision-submit", "--state-dir", "/home/worker/.local/state/aaa-muse-worker", "--job-id", job_id, "--input", "-"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.command, worker, command, input_text=decision, want=137)
            try:
                require(self.proxy.decision_captured.wait(timeout=10), "broker never accepted the paused decision")
                pid = (worker["home"] / "tmp/decision.pid").read_text()
                self.command(worker, ["bash", "-c", 'kill -KILL "$1"', "owned-decision-stop", pid])
                pending.result(timeout=15)
            finally:
                self.proxy.release_decision.set()
        journals = worker["state"] / "journals"
        pointer = json.loads((journals / ("decision-" + job_id + ".json")).read_text())
        journal_path = journals / ("operation-" + pointer["submission_id"] + ".json")
        original = journal_path.read_bytes()
        require(json.loads(original)["state"] == "pending", "lost acknowledgement did not retain pending evidence")
        self.crash_and_duplicate(worker)
        self.until(lambda: not json.loads((worker["state"] / "pending.json").read_text())["jobs"], "accepted tool request was revived after crash")
        require(journal_path.read_bytes() == original, "recovery rewrote an uncertain submission")
        recovered = [e for e in self.events(worker, operation=experiment["id"]) if e["msg"] == "worker.recovery_reconciled" and e.get("submission_id") == pointer["submission_id"]]
        require(recovered and recovered[-1]["broker_state"] == "accepted" and recovered[-1]["local_state"] == "pending" and not recovered[-1]["automatic_submission"], "logs do not explain accepted broker state versus missing local receipt")
        replay = json.loads(self.cli(worker, "decision-submit", "--job-id", job_id, "--input", "-", input_text=decision).stdout)
        require(replay["submission_id"] == pointer["submission_id"] and replay["experiment"]["state"] == "waiting_for_tool", "retry changed the original tool operation")
        broker = self.export_operation(experiment["id"])
        require(len([e for e in broker if e["msg"] == "decision.accepted"]) == 1 and any(e["msg"] == "receipt.replayed" for e in broker), "broker accepted the tool operation more than once or did not replay its receipt")
        fixture = self.private("client-only.txt", "controlled-client-result\r\nexact\n")
        self.command(worker, ["bash", "-c", 'test ! -e "$1"', "client-fixture-boundary", str(fixture)])
        exact = fixture.read_bytes().decode()
        continued = self.checked("/api/v1/admin/experiments/" + experiment["id"] + "/tool-results", self.admin, "POST", {"protocol_version": 1, "submission_id": "recovery-client-result", "call_id": "recovery-read", "output": exact}, want=202)[0]
        context = self.wait_job(worker, continued)
        require(context["context"]["messages"][-1]["call_id"] == "recovery-read" and context["context"]["messages"][-1]["output"] == exact, "recovery changed client-tool linkage or bytes")
        self.cli(worker, "decision-submit", "--job-id", context["job_id"], "--input", "-", input_text=json.dumps({"type": "final", "text": exact}))
        require(self.experiment(experiment["id"])["final_text"] == exact, "controlled continuation lost the client result")
        self.receipt("worker.recovery_lost_receipt", submission_id=pointer["submission_id"], accepted_once=True, tool_linkage_preserved=True, client_fixture_absent_in_worker=True, log_only_diagnosis=True)

    def broker_restart_hold(self, worker):
        experiment = self.create(worker, "controlled unfinished native assignment", tools=False)
        shown = self.wait_job(worker, experiment)
        previous = self.online(worker)
        self.docker("restart", self.broker)
        self.origin_url = self.origin(self.broker)
        self.proxy.target = urllib.parse.urlsplit(self.origin_url)
        self.ready(self.broker, self.origin_url)
        self.online(worker, previous["connection_id"])
        self.until(lambda: self.status(worker)["current_job"] is not None and self.experiment(experiment["id"])["state"] == "interrupted", "broker restart discarded uncertain work")
        current = self.status(worker)
        require(current["work_status"] == "busy" and current["current_job"]["job_id"] == shown["job_id"], "reconnect released an unresolved busy hold")
        events = self.events(worker)
        require(any(e["msg"] == "worker.recovery_reconciled" and e.get("job_id") == shown["job_id"] and e.get("busy_hold") and e.get("disposition") == "preserve_busy_hold" for e in events), "uncertain hold lacks operator evidence")
        require(not any(e["msg"] == "worker.http_exchange" and e.get("input", {}).get("idle_ack") for e in events if isinstance(e.get("input"), dict)), "recovery invented an idle acknowledgement")
        self.cli(worker, "decision-submit", "--job-id", shown["job_id"], "--ack-idle")
        self.until(lambda: self.status(worker)["work_status"] == "idle" and not json.loads((worker["state"] / "pending.json").read_text())["jobs"], "explicit stopped-work acknowledgement did not finish")
        self.receipt("worker.recovery_broker_restart_hold", job_id=shown["job_id"], hold_preserved=True, explicit_ack_only=True, log_only_diagnosis=True)

    def invalid_state_and_revocation(self, worker):
        self.stop(worker)
        pending = worker["state"] / "pending.json"
        saved = pending.read_bytes()
        pending.write_text('{"jobs":')
        self.cli(worker, "run", want=1)
        require(pending.read_text() == '{"jobs":', "invalid state was silently rewritten")
        events = self.events(worker)
        require(any(e["msg"] == "worker.local_state_invalid" and e.get("entry") == "pending.json" and e.get("input_omitted") for e in events), "invalid local state lacks safe format diagnosis")
        pending.write_bytes(saved)
        self.hook(worker)
        self.online(worker)
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST", {})
        self.until(lambda: (worker["state"] / "run-stop.json").exists(), "revocation did not retain terminal evidence", timeout=40)
        self.until(lambda: not (worker["state"] / "daemon.lock").exists(), "revoked owner did not release its lock")
        marker = (worker["state"] / "run-stop.json").read_bytes()
        self.hook(worker, want=1)
        self.background_refusal(worker)
        require((worker["state"] / "run-stop.json").read_bytes() == marker and (worker["state"] / "credential.key").read_text().strip() == worker["credential"], "restart restored revoked authority or replaced its evidence")
        denied = [e for e in self.events(worker) if e["msg"] == "worker.command_failed" and e.get("cause") == "worker_unauthorized" and e.get("request_id")]
        require(denied, "revoked daemon has no correlated authorization failure")
        self.diagnose(denied[-1]["request_id"], "worker.auth_denied", "worker_revoked")
        self.receipt("worker.recovery_invalid_and_revoked", no_reenrollment=True, invalid_state_preserved=True, terminal_stop_preserved=True)

    def exercise(self):
        worker = self.environment("recovery")
        self.install(worker, self.prompt())
        key = (worker["state"] / "credential.key").read_bytes()
        self.startup_outage(worker)
        self.crash_and_duplicate(worker)
        self.lost_receipt(worker)
        self.broker_restart_hold(worker)
        self.invalid_state_and_revocation(worker)
        require((worker["state"] / "credential.key").read_bytes() == key, "recovery replaced worker identity")
        self.receipt("worker.recovery_identity", worker_id=worker["worker"]["id"], source_sha=self.args.source_sha, package_sha256=self.package["sha256"], muse_qualified=False)


if __name__ == "__main__":
    run(WorkerRecovery, "worker-recovery")
