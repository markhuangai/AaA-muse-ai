#!/usr/bin/env python3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import re
import secrets
import urllib.parse
import urllib.request

from service import require
from worker_setup import WorkerSetup, run


class WorkerRecovery(WorkerSetup):
    def upgrade(self, worker, mode, want=0):
        # Run the published prompt's shell entry with an independently verified archive.
        self.command(worker, ["bash", "-c", 'umask 077; tar -xOzf /fixture/worker.tgz package/setup/upgrade-enrolled.sh > "$HOME/tmp/upgrade-enrolled.sh"'])
        return self.command(worker, ["bash", "/home/worker/tmp/upgrade-enrolled.sh", mode, "/fixture/worker.tgz",
                                     "/home/worker/.local/state/aaa-muse-worker"], want=want)

    def archived_install(self, version, checksum):
        archive = self.assets.public / ("worker-" + version + ".tgz")
        url = "https://github.com/markhuangai/AaA-muse-ai/releases/download/v" + version + "/markhuangai-aaa-muse-worker-" + version + ".tgz"
        with urllib.request.urlopen(url, timeout=90) as response:
            archive.write_bytes(response.read())
        require(hashlib.sha256(archive.read_bytes()).hexdigest() == checksum, "legacy upgrade artifact differs")
        worker = self.environment("upgrade-" + version)
        prompt = self.prompt()
        code = re.search(r"muse_enroll_[A-Za-z0-9_-]{43}", prompt["setup_prompt"])[0]
        argv = ["bash", "-c", 'umask 077; tar -xOzf "$1" package/setup/install.sh > "$HOME/tmp/old-install.sh"; '
                ': > "$HOME/tmp/old-bootstrap.ndjson"; exec bash "$HOME/tmp/old-install.sh" "$@" "$HOME/tmp/old-bootstrap.ndjson"',
                "legacy-upgrade-bootstrap", "/fixture/" + archive.name, version, checksum, self.proxy.origin, prompt["enrollment_id"]]
        old = self.command(worker, argv, input_text=code + '\n{"model_name":"Retained worker model"}\n')
        worker["receipt"] = json.loads(old.stdout.strip().splitlines()[-1])
        worker["worker"] = {"id": worker["receipt"]["worker_id"]}
        worker["credential"] = (worker["state"] / "credential.key").read_text().strip()
        self.secrets.append(worker["credential"])
        return worker

    def hook_only_upgrade(self):
        worker = self.archived_install("0.2.0", "efa77e92a16a1fa8009e555af33bcc49ac583c941cde7f2ed231b4552c4ae874")
        started = self.online(worker)
        old_hook = worker["receipt"]["hook_path"]
        require("watchdog" not in worker["receipt"], "legacy hook-only fixture unexpectedly includes a watchdog")
        self.upgrade(worker, "prepare")
        upgraded = json.loads(self.upgrade(worker, "apply").stdout)
        current = self.online(worker, started["connection_id"])
        require(upgraded["hook_path"] == old_hook and current["connection_generation"] > started["connection_generation"]
                and upgraded["watchdog"]["id"] == "aaa-muse-worker-watchdog" and upgraded["watchdog"]["interval_seconds"] == 300,
                "hook-only upgrade did not preserve the hook or provide one watchdog action")
        worker["receipt"] = upgraded
        self.hook(worker)
        require(not self.command(worker, ["bash", "-c", upgraded["watchdog"]["command"]]).stdout, "upgraded watchdog not healthy")
        self.receipt("worker.upgrade_hook_only", verified_hook_path=True, watchdog_receipt=True, native_registration="unverified")
        self.stop(worker)

    def legacy_upgrade(self):
        version = "0.3.0"
        checksum = "70600449bf130a4c27e6f2e3ff1d58ad7dbae0c97baaa73b54ab1a67f9e62e6b"
        worker = self.archived_install(version, checksum)
        key = (worker["state"] / "credential.key").read_bytes()
        started = self.online(worker)
        old_pid = self.pid(worker)
        old_installation = json.loads((worker["state"] / "installation.json").read_text())
        queued = self.create(worker, "busy upgrade check", tools=False)
        shown = self.wait_job(worker, queued)
        deferred = self.upgrade(worker, "prepare", want=1)
        require("upgrade_worker_busy" in deferred.stderr and self.pid(worker) == old_pid, "upgrade disturbed an active job")
        self.cli(worker, "decision-submit", "--job-id", shown["job_id"], "--input", "-", input_text='{"type":"final","text":"done"}')
        self.until(lambda: self.status(worker)["work_status"] == "idle", "released legacy work stayed busy")
        lease = json.loads(self.upgrade(worker, "prepare").stdout)
        require(lease["outcome"] == "reserved" and self.status(worker)["work_status"] == "upgrading", "upgrade did not reserve the worker slot")
        self.upgrade(worker, "cancel")
        require(self.pid(worker) == old_pid and self.status(worker)["work_status"] == "idle", "cancel did not restore capacity")
        with self.proxy.lock:
            self.proxy.worker_route_failures["/api/v1/worker/status"] = ["disconnect", 404]
        self.proxy.interrupt()
        marker_path = worker["state"] / "run-stop.json"
        self.until(marker_path.exists, "archived worker did not produce the historical 404 latch", timeout=45)
        self.until(lambda: self.status(worker)["connection_status"] == "offline", "old connection still authorized work", timeout=45)
        marker = marker_path.read_bytes()
        require(json.loads(marker)["cause"] == "broker_rejected", "legacy latch was not created by the reported failure")
        history = {entry.name: entry.read_bytes() for entry in (worker["state"] / "journals").glob("*.json")}
        self.upgrade(worker, "prepare")
        self.upgrade(worker, "prepare")
        upgraded = json.loads(self.upgrade(worker, "apply").stdout)
        after = self.online(worker, started["connection_id"])
        require(upgraded["outcome"] == "upgraded" and upgraded["package_version"] == self.package["version"] and
                upgraded["watchdog"]["timeout_seconds"] == 300 and upgraded["hook_path"] == worker["receipt"]["hook_path"] and
                len(list((worker["state"]).glob("run-stop.*.archived.json"))) == 1 and not marker_path.exists(), "upgrade lost receipt or stop history")
        archive_path, = worker["state"].glob("run-stop.*.archived.json")
        installed = json.loads((worker["state"] / "installation.json").read_text())
        require(archive_path.read_bytes() == marker and installed["model_report"] == old_installation["model_report"] and
                installed["setup_id"] == old_installation["setup_id"] and (worker["state"] / "credential.key").read_bytes() == key and
                {entry.name: entry.read_bytes() for entry in (worker["state"] / "journals").glob("*.json")} == history,
                "upgrade changed identity, journals or preserved stop evidence")
        pid = self.pid(worker)
        repeated = json.loads(self.upgrade(worker, "prepare").stdout)
        require(repeated["outcome"] == "already_current" and self.pid(worker) == pid, "repeat interrupted a healthy upgrade")
        events = self.events(worker)
        saved, = [event for event in events if event["msg"] == "worker.upgrade_stop_archived"]
        require(any(event["msg"] == "worker.http_exchange" and event.get("request_id") == saved["request_id"] and
                    event.get("response_validation_cause") == "invalid_json" for event in events), "archive cannot be diagnosed from protected logs")
        acceptance, _ = self.diagnose(upgraded["request_id"], "worker.authenticated")
        require(acceptance["worker_id"] == worker["worker"]["id"], "upgrade heartbeat evidence joined another worker")
        with self.proxy.lock:
            self.proxy.worker_route_failures["/api/v1/worker/status"] = ["disconnect", 404, 404]
            self.proxy.worker_route_failures["/api/v1/worker/events"] = [404]
            self.proxy.worker_route_failures["/api/v1/worker/heartbeat"] = [404]
        since = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        self.proxy.interrupt()
        recovered = self.online(worker, after["connection_id"])
        require(self.pid(worker) == pid and not marker_path.exists(), "fixed subscriber stopped during the same outage")
        events = self.events(worker, since, datetime.now(timezone.utc).isoformat(timespec="milliseconds"))
        retries = {e.get("route"): e for e in events if e["msg"] == "worker.stream_retrying" and e.get("http_status") == 404}
        require(set(retries) == {"/api/v1/worker/status", "/api/v1/worker/events", "/api/v1/worker/heartbeat"} and
                recovered["connection_generation"] > retries["/api/v1/worker/heartbeat"]["connection_generation"] and
                any(e["msg"] == "worker.stream_recovered" and e["connection_generation"] == recovered["connection_generation"] for e in events),
                "cannot reconstruct the outage and fresh heartbeat from worker logs")
        body = {"protocol_version": 1, "worker_id": worker["worker"]["id"], "submission_id": secrets.token_hex(16),
                "messages": [{"type": "message", "role": "user", "text": "Reply pong"}], "tools": []}
        client, _ = self.checked("/api/v1/requests", self.client, "POST", body, want=202)
        job = self.wait_job(worker, self.experiment(client["id"]))
        self.cli(worker, "decision-submit", "--job-id", job["job_id"], "--input", "-", input_text='{"type":"final","text":"pong"}')
        answer, _ = self.checked("/api/v1/requests/" + client["id"], self.client)
        require(answer["output"]["text"] == "pong" and job["connection_generation"] == recovered["connection_generation"],
                "real client work did not use the recovered worker")
        self.receipt("worker.legacy_outage_upgrade", previous_version=version, prior_digest=checksum, generation=recovered["connection_generation"],
                     dispatched_without_qualification=True, archived_original=True, one_consumer=True, log_only_diagnosis=True)
        self.stop(worker)

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

    def watchdog_recover(self, worker):
        since = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        old = self.online(worker)
        credential = (worker["state"] / "credential.key").read_bytes()
        poll = worker["state"] / "hook-poll.json"
        previous_poll = poll.read_bytes() if poll.exists() else None
        first = self.stop(worker, "KILL")
        command = ["bash", "-c", worker["receipt"]["watchdog"]["command"]]
        with ThreadPoolExecutor(max_workers=2) as pool:
            runs = list(pool.map(lambda _: self.command(worker, command), range(2)))
        current = self.online(worker, old["connection_id"])
        pid = self.pid(worker)
        require(pid != first and current["connection_generation"] > old["connection_generation"], "watchdog kept the old subscriber or generation")
        require((worker["state"] / "credential.key").read_bytes() == credential, "watchdog changed the credential")
        require((poll.read_bytes() if poll.exists() else None) == previous_poll, "watchdog advanced the genuine hook poll")
        reports = [n for run in runs if run.stdout for n in json.loads(run.stdout)["notices"] if n["kind"] == "subscriber_recovered"]
        require(reports == [{"kind": "subscriber_recovered", "pid": pid, "connection_generation": current["connection_generation"]}],
                "missing or duplicate acknowledged recovery notice")
        lines = [json.loads(line) for run in runs for line in run.stderr.splitlines()]
        require(not any(line["level"] == "DEBUG" for line in lines), "watchdog leaked private DEBUG output to the scheduler sink")
        recovered, = [e for e in lines if e["msg"] == "watchdog.subscriber_recovered"]
        require(recovered["level"] == "INFO" and recovered["attempts"] == 1 and recovered["worker_id"] == worker["worker"]["id"]
                and recovered["subscriber"]["heartbeat_evidence"] == "current" and recovered["request_id"], "INFO lacks recovery proof")
        until = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        events = self.events(worker, since, until)
        owners = [e for e in events if e["msg"] == "worker.supervision_started" and e.get("worker_id") == worker["worker"]["id"]]
        require(len(owners) == 1 and owners[0]["pid"] == pid, "watchdog did not recover exactly one subscriber")
        detail = next(e for e in events if e["msg"] == "watchdog.observed" and e.get("instance_id") == recovered["instance_id"])
        require(detail["level"] == "DEBUG" and detail["before"]["subscriber"]["owner_state"] == "absent" and
                detail["before"]["subscriber"]["launch_pid"] == first and detail["observed"]["subscriber"]["connection_id"] == current["connection_id"],
                "watchdog logs cannot explain the old and recovered owners")
        accepted, _ = self.diagnose(recovered["request_id"], "worker.health_reply")
        require(accepted["worker_id"] == worker["worker"]["id"] and accepted["connection_id"] == current["connection_id"] and
                accepted["connection_generation"] == current["connection_generation"], "watchdog receipt did not join the authenticated heartbeat")
        self.receipt("worker.watchdog_recovery", one_consumer=True, log_only_diagnosis=True,
                     worker_id=worker["worker"]["id"], connection_generation=current["connection_generation"], request_id=recovered["request_id"])
        return current

    def watchdog_live_stall(self, worker):
        now = datetime.now(timezone.utc)
        current = self.online(worker)
        pid = self.pid(worker)
        self.command(worker, ["bash", "-c", 'kill -STOP "$1"', "owned-worker-fixture", str(pid)])
        try:
            path = worker["state"] / "connection.json"
            saved = json.loads(path.read_text())
            stale = datetime.fromtimestamp(now.timestamp() - 121, timezone.utc).isoformat()
            saved["last_heartbeat_at"] = saved["last_acknowledged"]["at"] = stale
            path.write_text(json.dumps(saved))
            first = self.cli(worker, "watchdog-check")
            repeat = self.cli(worker, "watchdog-check")
            require(any(n.get("cause") == "heartbeat_unconfirmed" for n in json.loads(first.stdout)["notices"]), "live stale heartbeat was not reported")
            require(not repeat.stdout and self.pid(worker) == pid and self.command(worker, ["bash", "-c", 'kill -0 "$1"', "owned-worker-fixture", str(pid)]),
                    "live stall duplicated a notice or replaced the process")
            events = [json.loads(line) for line in first.stderr.splitlines()]
            stalled, = [e for e in events if e["msg"] == "watchdog.subscriber_stalled"]
            require(stalled["level"] == "WARN" and stalled["subscriber"]["connection_id"] == current["connection_id"] and
                    stalled["subscriber"]["heartbeat_age_ms"] > 120000 and stalled["attempts"] == 0 and stalled["corrective_action"],
                    "live stall lacks operator evidence at normal verbosity")
        finally:
            self.command(worker, ["bash", "-c", 'kill -CONT "$1"', "owned-worker-fixture", str(pid)])
        self.online(worker)
        self.receipt("worker.watchdog_live_stall", live_owner_preserved=True, repeated_notice_suppressed=True)

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
        launch = (worker["state"] / "launch.json").read_bytes()
        notice = json.loads(self.cli(worker, "watchdog-check").stdout)
        require(any(n.get("cause") == "subscriber_terminal_stop" for n in notice["notices"]) and
                (worker["state"] / "launch.json").read_bytes() == launch, "watchdog crossed a terminal stop")
        self.hook(worker, want=1)
        self.background_refusal(worker)
        require((worker["state"] / "run-stop.json").read_bytes() == marker and (worker["state"] / "credential.key").read_text().strip() == worker["credential"], "restart restored revoked authority or replaced its evidence")
        denied = [e for e in self.events(worker) if e["msg"] == "worker.command_failed" and e.get("cause") == "worker_unauthorized" and e.get("request_id")]
        require(denied, "revoked daemon has no correlated authorization failure")
        self.diagnose(denied[-1]["request_id"], ("worker.auth_denied", "lease.rejected"), "worker_revoked")
        self.upgrade(worker, "prepare", want=1)
        require((worker["state"] / "run-stop.json").read_bytes() == marker, "upgrade crossed a genuine terminal stop")
        self.receipt("worker.recovery_invalid_and_revoked", no_reenrollment=True, invalid_state_preserved=True, terminal_stop_preserved=True)

    def exercise(self):
        self.legacy_upgrade()
        self.hook_only_upgrade()
        worker = self.environment("recovery")
        self.install(worker, self.prompt())
        key = (worker["state"] / "credential.key").read_bytes()
        self.startup_outage(worker)
        self.crash_and_duplicate(worker)
        self.watchdog_recover(worker)
        self.watchdog_live_stall(worker)
        self.lost_receipt(worker)
        self.broker_restart_hold(worker)
        self.invalid_state_and_revocation(worker)
        require((worker["state"] / "credential.key").read_bytes() == key, "recovery replaced worker identity")
        self.receipt("worker.recovery_identity", worker_id=worker["worker"]["id"], source_sha=self.args.source_sha, package_sha256=self.package["sha256"], muse_qualified=False)


if __name__ == "__main__":
    run(WorkerRecovery, "worker-recovery")
