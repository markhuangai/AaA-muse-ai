from datetime import datetime, timedelta, timezone
import json
import time

from service import require


def utc_stamp(value=None):
    return (value or datetime.now(timezone.utc)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class NativeCronFixture:
    def cron_json(self, worker, command, data, want=0):
        result = self.native_cli(worker, command, "--input", "-", input_text=json.dumps(data), want=want)
        return json.loads(result) if want == 0 else None

    def checker(self, worker):
        goal = "controlled-goal-" + worker["worker"]["id"]
        frozen = json.loads(self.native_cli(worker, "cron-describe", "--goal-id", goal))
        require(frozen["every"] == "1m" and frozen["kind"] == "agent" and frozen["enabled"] and frozen["goal_id"] == goal,
                "the artifact did not specify one visible minute agent cron")
        self.cron_json(worker, "cron-authorize-registration", {"goal_id": goal, "complete": True, "matches": []})
        self.cron_json(worker, "cron-authorize-registration", {"goal_id": goal, "complete": True, "matches": []}, want=1)
        actual = {**frozen, "native_job_id": "controlled-check-" + worker["worker"]["id"]}
        self.cron_json(worker, "cron-confirm", {"matches": [{**actual, "every": "2m"}]}, want=1)
        result = self.cron_json(worker, "cron-confirm", {"matches": [actual]})
        require(result["checker_job_id"] == actual["native_job_id"] and result["outcome"] == "registered", "checker read-back was not retained")
        require(self.cron_json(worker, "cron-confirm", {"matches": [actual]}) == result, "checker retry changed the registration")
        worker.update({"checker": actual["native_job_id"], "tick_number": 0})

    def tick(self, worker, *, want=0, input_override=None):
        worker["tick_number"] += 1
        stamp = datetime.now(timezone.utc)
        previous = worker.get("tick_stamp")
        if previous is not None and utc_stamp(previous) >= utc_stamp(stamp):
            time.sleep(0.002)
            stamp = datetime.now(timezone.utc)
        worker["tick_stamp"] = stamp
        tick = {"checker_job_id": worker["checker"], "checker_run_id": "controlled-tick-" + str(worker["tick_number"]),
                "scheduled_at": utc_stamp(stamp), **(input_override or {})}
        worker["last_tick"] = tick
        return self.cron_json(worker, "cron-check", tick, want)

    def work_definition(self, worker, grant, *, delay_seconds=5):
        bound = {"claim_id": grant["claim_id"], "launch_id": grant["launch_id"]}
        due = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
        registration = self.cron_json(worker, "cron-prepare", {**bound, "due_at": utc_stamp(due)})
        require(registration["outcome"] == "register" and registration["work"]["reference"] == bound["launch_id"],
                "native launch was not authorized for this claim")
        work = {**registration["work"], "native_job_id": "controlled-once-" + grant["job_id"]}
        worker["work"] = {"definition": work, "due": due, "grant": grant}
        return work

    def observe(self, worker, status, *, want=0, matches=None, run=True, never_started=False, execution=None):
        work = worker["work"]
        grant = work["grant"]
        match = {**work["definition"], "status": status}
        if run:
            match["execution"] = {"native_job_id": work["definition"]["native_job_id"],
                                  "native_run_id": "controlled-execution-" + grant["job_id"], "status": status}
        if never_started:
            match["execution_never_started"] = True
        tick = worker["last_tick"]
        evidence = {"execution": execution} if execution is not None else {}
        return self.cron_json(worker, "cron-observe", {"claim_id": grant["claim_id"], "launch_id": grant["launch_id"],
            "checker_job_id": tick["checker_job_id"], "checker_run_id": tick["checker_run_id"],
            "observed_at": utc_stamp(), "matches": [match] if matches is None else matches, **evidence}, want)

    def start_work(self, worker, *, want=0):
        work = worker["work"]
        self.until(lambda: datetime.now(timezone.utc) >= work["due"], "controlled one-shot did not reach its due time", timeout=10)
        result = self.native_cli(worker, "cron-start", "--launch-id", work["grant"]["launch_id"],
                                 "--native-job-id", work["definition"]["native_job_id"], want=want)
        if want != 0:
            require(not result, "rejected work handler exposed an executable brief")
            return None
        brief = json.loads(result)
        require(brief["outcome"] == "authorized" and brief["job_id"] == work["grant"]["job_id"], "finite work brief was not authorized")
        return brief

    def claim_work(self, worker, job_id):
        grant = self.tick(worker)
        require(grant["outcome"] == "prepare" and grant["job_id"] == job_id, "controlled tick did not pull the expected job")
        self.work_definition(worker, grant)
        return grant
