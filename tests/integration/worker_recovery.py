#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone
import json
import time

from native_cron import utc_stamp
from service import require
from worker_setup import WorkerSetup, run


class WorkerRecovery(WorkerSetup):
    def events(self, worker, since=None, until=None, operation=None):
        filters = []
        for flag, value in (("--since", since), ("--until", until), ("--operation-id", operation)):
            if value:
                filters.extend([flag, value])
        raw = self.native_cli(worker, "diagnostics-export", *filters)
        require(all(len(line.encode()) + 1 <= 6144 for line in raw.splitlines()), "worker capture record exceeds its bound")
        metadata, values = self.decode_export(raw.encode())
        require(metadata["complete"] and not metadata["omissions"], "worker recovery export incomplete")
        decoded = self.native_cli(worker, "diagnostics-export", "--decode", *filters)
        exported = json.loads(decoded.splitlines()[0])
        require(exported["complete"] and exported["captures"] == len(values), "decoded worker export did not match the protected captures")
        self.assert_private(json.dumps(values))
        return values

    def wait_job(self, worker, experiment):
        self.claim_work(worker, experiment["current_job_id"])
        return self.start_work(worker)

    def save_during_reply_loss(self, worker):
        begin = utc_stamp()
        experiment = self.create(worker, "recover exact saved answer after process restart", tools=False)
        brief = self.wait_job(worker, experiment)
        job_id = brief["job_id"]
        grant = worker["work"]["grant"]
        route = "/api/v1/worker/jobs/" + job_id + "/decisions"
        self.proxy.lose_worker_replies[route] = 3
        answer = "finite worker exact bytes\nsecond line\n"
        self.native_cli(worker, "decision-submit", "--job-id", job_id, "--input", "-",
                        input_text=json.dumps({"type": "final", "text": answer}), want=1)
        require(self.experiment(experiment["id"])["final_text"] == answer and self.status(worker)["work_status"] == "busy",
                "loss of an accepted reply changed the broker result or released the native hold")
        require(self.proxy.lose_worker_replies[route] == 0, "not all delivery replies were lost")
        self.docker("restart", worker["container"], timeout=40)
        last_poll = self.status(worker)["last_poll_at"]
        self.proxy.lose_worker_replies["/api/v1/worker/jobs/" + job_id + "/interrupt"] = 1
        self.tick(worker, want=1)
        require((worker["state"] / "cron-claim.json").exists(), "lost settlement cleared private state")
        require(self.tick(worker)["outcome"] == "settled" and self.status(worker)["last_poll_at"] == last_poll,
                "retry did not reconcile the same settlement")
        final = json.loads((worker["state"] / "cron-last-receipt.json").read_text())
        require(final["receipt"]["state"] == "accepted" and final["claim_id"] == grant["claim_id"], "terminal replay changed prior acceptance")
        captures = self.events(worker, since=begin, until=utc_stamp(), operation=experiment["id"])
        settled = [value for value in captures if value["msg"] == "cron.work_settled"]
        require(len(settled) == 1 and settled[0]["native_run_id"] == worker["work"]["native_run_id"],
                "protected worker receipt lost the wake identity")
        broker = self.export_operation(experiment["id"])
        require(sum(value["msg"] == "decision.accepted" for value in broker) == 1 and sum(value["msg"] == "job.work_settled" for value in broker) == 1,
                "the broker committed an accepted operation more than once")
        committed = next(value for value in broker if value["msg"] == "job.work_settled")
        require(all(committed.get(key) == settled[0].get(key) for key in
                    ("worker_id", "operation_id", "job_id", "claim_id", "launch_id", "native_job_id", "native_run_id")),
                "protected worker and broker settlement records could not be joined")
        self.receipt("worker.saved_result_after_restart", accepted_replayed=True, settlement_reply_replayed=True)

    def surviving_producer(self, worker):
        experiment = self.create(worker, "guarded producer survives after cancellation", tools=False)
        brief = self.wait_job(worker, experiment)
        launch = worker["work"]["grant"]["launch_id"]
        run_id = worker["work"]["run_id"]
        intent = json.loads(self.native_cli(worker, "cron-producer-intent", "--launch-id", launch))
        idle = json.loads(self.native_cli(worker, "cron-producer-intent", "--launch-id", launch))
        marker = "/home/worker/producer-started"
        pid = self.command(worker, ["bash", "-c", 'set -eu; "$@" </dev/null >/dev/null 2>&1 & printf "%s\n" "$!"',
                                    "guarded", *intent["producer_command"], "sh", "-c", 'printf "%s" "$$" > "$1"; exec sleep 120',
                                    "producer", marker]).stdout.strip()
        try:
            marker_file = worker["home"] / "producer-started"
            self.until(lambda: marker_file.exists() and marker_file.read_text() == pid, "packed guard did not bind the running producer")
            self.cancel(experiment["id"])
            self.abort(worker, want=1)
            held = self.tick(worker)
            require(held["outcome"] == "claim_active" and held["cause"] == "producer_still_active_or_unobservable",
                    "guarded producer did not retain the busy slot")
        finally:
            self.command(worker, ["bash", "-c", 'kill -TERM "$1"', "producer-stop", pid])
        self.until(lambda: self.docker("exec", worker["container"], "bash", "-c", '! kill -0 "$1" 2>/dev/null', "done", pid, success=False).returncode == 0,
                   "owned producer did not terminate")
        self.abort(worker)
        self.command(worker, [*idle["producer_command"], "touch", "/home/worker/late-launch"], want=1)
        require(not (worker["home"] / "late-launch").exists() and self.tick(worker)["outcome"] == "settled",
                "a delayed guarded launch escaped the abort fence")
        followup = self.create(worker, "settled worker is available again", tools=False)
        self.claim_work(worker, followup["current_job_id"])
        self.abort(worker, launch=launch, run=run_id, want=1)
        require(self.status(worker)["current_claim"]["job_id"] == followup["current_job_id"], "late abort modified new work")
        self.start_work(worker)
        self.abort(worker)
        require(self.tick(worker)["outcome"] == "settled", "clean abort did not settle")
        self.receipt("worker.guarded_producer_hold", genuine_process=True, late_abort_rejected=True, stale_producer_fenced=True,
                     settlement_job=brief["job_id"])

    def lost_pull(self, worker):
        request = self.create(worker, "a lost grant must be bound to the actual wake", tools=False)
        self.proxy.lose_worker_replies["/api/v1/worker/pull"] = 1
        self.tick(worker, want=1)
        prior = worker["last_tick"]["checker_run_id"]
        bind = "/api/v1/worker/jobs/" + request["current_job_id"] + "/bind"
        self.proxy.lose_worker_replies[bind] = 1
        self.tick(worker, want=1)
        intermediate = worker["last_tick"]["checker_run_id"]
        claim = self.claim_work(worker, request["current_job_id"])
        require(claim["pull_run_id"] == prior and worker["work"]["run_id"] != "event-hook:" + intermediate, "wake reused an earlier invocation")
        self.start_work(worker, self_report="event-hook:" + prior, want=1)
        brief = self.start_work(worker)
        self.abort(worker)
        require(self.tick(worker)["outcome"] == "settled", "rebound claim could not settle")
        events = self.export_operation(request["id"])
        require(sum(e["msg"] == "job.claimed" and not e["replayed"] for e in events) == 1 and
                sum(e["msg"] == "job.hook_bound" for e in events) == 2 and
                sum(e["msg"] == "job.work_started" for e in events) == 1, "recovery duplicated the claim or exposed two briefs")
        self.receipt("worker.exact_grant_replay_after_lost_pull", replayed_occurrence=prior, claim_id=claim["claim_id"], job_id=brief["job_id"])

    def watchdog_behaviors(self, worker):
        path = worker["state"] / "hook-tick-health.json"
        before = json.loads(path.read_text())
        stale = utc_stamp(datetime.now(timezone.utc) - timedelta(minutes=6))
        path.write_text(json.dumps({**before, "boot_id": "previous-boot", "last_tick_at": stale, "last_success_at": stale}))
        check = lambda: json.loads(self.native_cli(worker, "watchdog-check"))
        first = check()
        require(first["notify"] and first["boot_changed"] and first["incidents"][0]["kind"] == "hook_tick_stale", "watchdog did not identify VM reset")
        require(not check()["notify"] and self.tick(worker)["outcome"] == "idle", "watchdog repeated an unchanged incident")
        recovered = check()
        require(recovered["notify"] and recovered["outcome"] == "recovered" and not check()["notify"], "watchdog recovery was not deduplicated")
        self.receipt("worker.watchdog_recovery", stale_hook=True, boot_change=True, recovery=True)

    def uncertain_wake(self):
        worker = self.environment("uncertain-wake")
        self.install(worker, self.prompt())
        self.checker(worker)
        task = self.create(worker, "unobservable hook turn", tools=False)
        runtime = worker["home"] / "runtime.sh"
        with runtime.open("a") as script:
            script.write("\nwake() { printf '%s\\n' \"$2\" >> /home/worker/wake-delivered; exit 71; }\n")
        self.tick(worker, want=1)
        path = worker["state"] / "cron-claim.json"
        grant = json.loads(path.read_text())
        emitted = (worker["home"] / "wake-delivered").read_text().splitlines()
        require(len(emitted) == 1 and json.loads(emitted[0])["claim_id"] == grant["claim_id"] and grant["wake_attempted_at"],
                "lost native wake acknowledgement did not leave a durable emission intent")
        stale = utc_stamp(datetime.now(timezone.utc) - timedelta(minutes=6))
        path.write_text(json.dumps({**json.loads(path.read_text()), "deadline_at": stale}))
        pending = self.tick(worker)
        require(pending["outcome"] == "claim_active" and self.status(worker)["current_claim"]["claim_id"] == grant["claim_id"],
                "hard crash was treated as a settled execution")
        notice = json.loads(self.native_cli(worker, "watchdog-check"))
        require(notice["notify"] and any(e["kind"] == "claim_deadline_exceeded" for e in notice["incidents"]), "watchdog missed held claim")
        require(self.tick(worker)["outcome"] == "claim_active" and (worker["home"] / "wake-delivered").read_text().splitlines() == emitted,
                "later tick emitted another wake after uncertainty")
        self.receipt("worker.uncertain_wake", busy_hold=True, duplicate_wakes=0)

    def remote_replay(self, worker):
        op = self.worker_control(worker, "ops", {"protocol_version": 1, "submission_id": "recovery-doctor", "kind": "doctor"})
        op_result = "/api/v1/worker/ops/" + op["id"] + "/result"
        self.proxy.lose_worker_replies[op_result] = 1
        self.tick(worker, want=1)
        pending = json.loads((worker["state"] / "hook-op.json").read_text())["pending_result"]
        require(self.worker_control(worker, "ops/" + op["id"])["state"] == "succeeded", "lost doctor reply lost its accepted result")
        require(self.tick(worker)["outcome"] == "worker_op_settled", "doctor result did not replay from the journal")
        require(any(event["msg"] == "receipt.replayed" and event["submission_id"] == pending["submission_id"]
                    for event in self.export_operation(op["id"])), "broker export did not prove exact doctor replay")

        task = self.worker_control(worker, "agent-tasks", {"protocol_version": 1, "submission_id": "recovery-task", "prompt": "Check the scoped fixture"})
        self.proxy.lose_worker_replies["/api/v1/worker/pull"] = 1
        self.tick(worker, want=1)
        self.proxy.lose_worker_replies["/api/v1/worker/agent-tasks/" + task["id"] + "/bind"] = 1
        self.tick(worker, want=1)
        wake, _ = self.start_agent_task(worker, task)
        self.proxy.lose_worker_replies["/api/v1/worker/agent-tasks/" + task["id"] + "/result"] = 1
        self.native_cli(worker, "hook-task-abort", "--launch-id", wake["launch_id"], "--run-id", wake["expected_run_id"],
                        "--reason", "execution_refused", "--summary", "Approval is needed", want=1)
        detail = self.worker_control(worker, "agent-tasks/" + task["id"])
        require(detail["state"] == "refused" and detail["held"] and detail["result"]["summary"] == "Approval is needed",
                "started refusal lost its result or released its hold")
        require(self.tick(worker)["outcome"] == "background_task_settled", "started refusal failed to settle after replay")
        events = self.export_operation(task["id"])
        require(sum(event["msg"] == "agent_task.result_accepted" for event in events) == 1 and
                any(event["msg"] == "receipt.replayed" for event in events) and
                any(event["msg"] == "agent_task.hook_bound" for event in events), "broker export did not reconstruct task binding, replay and abort")
        self.receipt("worker.remote_operations_replay", doctor_replayed=True, task_rebound=True, task_refusal_settled=True, capture_complete=True)

    def expired_background_task(self, worker):
        task = self.worker_control(worker, "agent-tasks", {"protocol_version": 1, "submission_id": "overdue-background",
                                                          "prompt": "Retain the current slot", "timeout_seconds": 30})
        wake, _ = self.start_agent_task(worker, task)
        self.docker("restart", self.broker, timeout=35)
        self.ready(self.broker, self.origin_url)
        queued = self.worker_control(worker, "ops", {"protocol_version": 1, "submission_id": "wait-for-background", "kind": "doctor"})
        require(self.tick(worker)["outcome"] == "background_task_active" and self.worker_control(worker, "ops/" + queued["id"])["state"] == "queued",
                "broker restart admitted a second lane while the task held its slot")
        deadline = datetime.fromisoformat(task["deadline_at"].replace("Z", "+00:00"))
        time.sleep(max(0, (deadline - datetime.now(timezone.utc)).total_seconds()) + 1.25)
        notice = json.loads(self.native_cli(worker, "watchdog-check"))
        require(any(incident["kind"] == "task_deadline_exceeded" and incident["task_id"] == task["id"] for incident in notice["incidents"]),
                "overdue task did not appear on the hourly watchdog")
        detail = self.worker_control(worker, "agent-tasks/" + task["id"])
        require(detail["state"] == "interrupted" and detail["held"], "deadline discarded the uncertain slot")
        reply = self.native_cli(worker, "hook-task-abort", "--launch-id", wake["launch_id"], "--run-id", wake["expected_run_id"],
                                "--reason", "execution_failed", "--summary", "Controlled stop after deadline")
        require(json.loads(reply)["outcome"] == "settlement_saved", "late stop lacked a correlated settlement")
        require(self.tick(worker)["outcome"] == "background_task_settled" and self.tick(worker)["outcome"] == "worker_op_settled",
                "settlement did not permit the next lane")
        records = self.export_operation(task["id"])
        require(any(event["msg"] == "agent_task.deadline_exceeded" and event["busy_hold"] and event["level"] == "ERROR" for event in records),
                "overdue hold was not diagnosable from the protected export")
        self.receipt("worker.overdue_task_across_broker_restart", watchdog=True, busy_hold=True, capture_complete=True)

    def exercise(self):
        worker = self.environment("recovery")
        self.install(worker, self.prompt())
        self.checker(worker)
        identity = worker["credential"]
        self.save_during_reply_loss(worker)
        self.surviving_producer(worker)
        self.lost_pull(worker)
        self.watchdog_behaviors(worker)
        self.remote_replay(worker)
        self.expired_background_task(worker)
        self.uncertain_wake()
        require((worker["state"] / "credential.key").read_text().strip() == identity, "recovery replaced enrolled authority")
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST")
        self.tick(worker, want=1)
        require(not (worker["state"] / "cron-claim.json").exists(), "revoked worker acquired new authority")
        self.receipt("worker.revoked_pull_rejected", new_claim=False)


if __name__ == "__main__":
    run(WorkerRecovery, "worker-recovery")
