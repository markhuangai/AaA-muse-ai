#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone
import json

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
        require(self.tick(worker)["outcome"] == "recovery_pending" and self.status(worker)["last_poll_at"] == last_poll,
                "restart forgot the native hold or performed a work pull")
        self.proxy.lose_worker_replies["/api/v1/worker/jobs/" + job_id + "/interrupt"] = 1
        observing = worker["last_tick"]["checker_run_id"]
        self.observe(worker, "completed", want=1)
        require((worker["state"] / "cron-claim.json").exists(), "ambiguous settlement cleared private state")
        require(self.tick(worker)["outcome"] == "settled" and self.status(worker)["last_poll_at"] == last_poll,
                "saved operation required native status again or pulled before reconciliation")
        final = json.loads((worker["state"] / "cron-last-receipt.json").read_text())
        require(final["receipt"]["state"] == "accepted" and final["claim_id"] == grant["claim_id"], "terminal replay did not preserve prior acceptance")
        captures = self.events(worker, since=begin, until=utc_stamp(), operation=experiment["id"])
        settled = [value for value in captures if value["msg"] == "cron.work_settled"]
        require(len(settled) == 1 and settled[0]["native_run_id"] == "controlled-execution-" + job_id and
                settled[0]["claim_id"] == grant["claim_id"], "protected receipt did not identify the reconciled execution")
        broker = self.export_operation(experiment["id"])
        require(sum(value["msg"] == "decision.accepted" for value in broker) == 1 and sum(value["msg"] == "job.work_settled" for value in broker) == 1,
                "the broker committed an accepted operation more than once")
        local = settled[0]
        committed = next(value for value in broker if value["msg"] == "job.work_settled")
        require(all(committed.get(key) == local.get(key) and local.get(key) for key in
                    ("worker_id", "operation_id", "job_id", "claim_id", "launch_id", "native_job_id", "native_run_id")) and
                local["checker_job_id"] == worker["checker"] and local["pull_run_id"] == grant["pull_run_id"] and
                local["observing_checker_run_id"] == observing and local["settling_checker_run_id"] == worker["last_tick"]["checker_run_id"] and
                local["observing_checker_run_id"] != local["pull_run_id"],
                "decoded exports could not join the claiming occurrence, later observation and broker settlement")
        self.receipt("worker.saved_result_after_restart", accepted_replayed=True, settlement_reply_replayed=True, native_scheduler="controlled")

    def surviving_producer(self, worker):
        experiment = self.create(worker, "finite producer survives native agent termination", tools=False)
        brief = self.wait_job(worker, experiment)
        grant = worker["work"]["grant"]
        old_definition = worker["work"]["definition"]
        launch_id, job_id = grant["launch_id"], brief["job_id"]
        intent = json.loads(self.native_cli(worker, "cron-producer-intent", "--launch-id", launch_id))
        producer_args = ("cron-producer", "--launch-id", launch_id, "--producer-id", intent["producer_id"], "--pid")
        self.native_cli(worker, *producer_args, "2147483647", want=1)
        require(self.observe(worker, "unobservable")["outcome"] == "recovery_pending", "inaccessible native execution was treated as stopped")
        require(self.observe(worker, "failed")["outcome"] == "recovery_pending", "untracked producer intent was treated as stopped")
        pid = self.command(worker, ["bash", "-c", "sleep 120 </dev/null >/dev/null 2>&1 & printf '%s\n' \"$!\""]).stdout.strip()
        try:
            self.native_cli(worker, *producer_args, pid)
            before = self.status(worker)["last_poll_at"]
            require(self.tick(worker)["outcome"] == "recovery_pending" and self.observe(worker, "failed")["outcome"] == "recovery_pending",
                    "stopped native agent released a live finite process")
            self.cancel(experiment["id"])
            require(self.status(worker)["work_status"] == "busy" and self.observe(worker, "failed")["outcome"] == "recovery_pending" and self.status(worker)["last_poll_at"] == before,
                    "cancellation released the surviving producer or caused a work pull")
        finally:
            self.command(worker, ["bash", "-c", 'kill -TERM "$1"', "controlled-producer-stop", pid])
        self.until(lambda: self.docker("exec", worker["container"], "bash", "-c", '! kill -0 "$1" 2>/dev/null', "controlled-producer-exit", pid, success=False).returncode == 0,
                   "owned producer did not terminate")
        require(self.observe(worker, "failed")["outcome"] == "settled", "confirmed stop did not reconcile to the prior cancellation")
        require(self.experiment(experiment["id"])["state"] == "cancelled" and self.status(worker)["work_status"] == "idle", "settlement lost cancellation or left the slot held")
        followup = self.create(worker, "only settled work allows the next pull", tools=False)
        self.claim_work(worker, followup["current_job_id"])
        latest = worker["last_tick"]
        self.cron_json(worker, "cron-observe", {"claim_id": grant["claim_id"], "launch_id": launch_id,
                       "checker_job_id": latest["checker_job_id"], "checker_run_id": latest["checker_run_id"], "observed_at": utc_stamp(),
                       "matches": [{**old_definition, "status": "failed", "execution": {
                           "native_job_id": old_definition["native_job_id"], "status": "failed",
                           "native_run_id": "controlled-execution-" + job_id}}]}, want=1)
        require(self.status(worker)["current_claim"]["job_id"] == followup["current_job_id"], "late observation closed another claim")
        self.start_work(worker)
        require(self.observe(worker, "failed")["outcome"] == "settled" and self.experiment(followup["id"])["state"] == "interrupted",
                "confirmed failure without a result did not record an interruption")
        records = self.events(worker, operation=experiment["id"])
        require(any(value["msg"] == "cron.native_observation" and value.get("native_status") == "failed" and
                    value.get("outcome") == "confirmed_stopped" and value.get("native_run_id") == "controlled-execution-" + job_id and
                    value.get("claim_id") == grant["claim_id"] for value in records), "exports omitted the verified native failure")
        registered = next(value for value in records if value["msg"] == "cron.producer_registered")
        require(registered["producer"]["pid"] == int(pid) and registered["producer"]["producer_id"] == intent["producer_id"] and registered["job_id"] == job_id,
                "producer registration lost process or claim identity")
        self.receipt("worker.native_stop_with_surviving_producer", genuine_process=True, busy_pulls=0, late_observation_rejected=True)

    def lost_pull(self, worker):
        request = self.create(worker, "a lost grant must be picked up by its exact poll", tools=False)
        route = "/api/v1/worker/pull"
        self.proxy.lose_worker_replies[route] = 1
        self.tick(worker, want=1)
        prior = worker["last_tick"]["checker_run_id"]
        claim = self.tick(worker)
        require(claim["outcome"] == "prepare" and claim["pull_run_id"] == prior and claim["job_id"] == request["current_job_id"], "grant replay chose new work")
        self.work_definition(worker, claim)
        self.cancel(request["id"])
        require(self.observe(worker, "cancelled", run=False, never_started=True)["outcome"] == "settled", "verified unstarted run did not settle")
        self.receipt("worker.exact_grant_replay_after_lost_pull", replayed_occurrence=prior, terminal_never_started=True)

    def exercise(self):
        worker = self.environment("recovery")
        self.install(worker, self.prompt())
        self.checker(worker)
        identity = worker["credential"]
        self.save_during_reply_loss(worker)
        self.surviving_producer(worker)
        self.lost_pull(worker)
        require((worker["state"] / "credential.key").read_text().strip() == identity, "recovery replaced enrolled authority")
        self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/revoke", self.admin, "POST")
        self.tick(worker, want=1)
        require(not (worker["state"] / "cron-claim.json").exists(), "revoked worker acquired new authority")
        self.receipt("worker.revoked_pull_rejected", new_claim=False)


if __name__ == "__main__":
    run(WorkerRecovery, "worker-recovery")
