from base64 import urlsafe_b64encode
from datetime import datetime, timezone
import json

from service import require


def utc_stamp(value=None):
    return (value or datetime.now(timezone.utc)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def usage_header(used_percent, observed_at):
    reading = json.dumps({"used_percent": used_percent, "observed_at": observed_at, "reset_label": "Nov 29 at 7:49 AM EST"})
    return {"X-Muse-Worker-Weekly-Usage": urlsafe_b64encode(reading.encode()).decode().rstrip("=")}


class ManagedHookFixture:
    def registration(self, worker, command, data, want=0):
        result = self.native_cli(worker, command, "--input", "-", input_text=json.dumps(data), want=want)
        return json.loads(result) if want == 0 else None

    def checker(self, worker):
        goal = "controlled-goal-" + worker["worker"]["id"]
        saved = json.loads(self.native_cli(worker, "hook-describe", "--goal-id", goal))
        hook, watchdog = saved["hook"], saved["watchdog"]
        require(hook["poll_interval_secs"] == 15 and hook["script_timeout_secs"] == 120 and hook["enabled"] and
                watchdog["every"] == "5m" and watchdog["kind"] == "agent" and watchdog["enabled"],
                "packed worker described the wrong native registrations")
        listing = {"goal_id": goal, "complete": True, "hooks": [], "watchdogs": []}
        require(self.registration(worker, "hook-authorize-registration", {**listing, "target": "hook"})["add_hook"],
                "fresh hook was not authorized")
        self.registration(worker, "hook-authorize-registration", {**listing, "target": "hook"}, want=1)
        worker.update({"checker": hook["id"], "tick_number": 0})
        disabled = {**hook, "enabled": False}
        hook_action = self.registration(worker, "hook-authorize-registration", {**listing, "target": "hook", "hooks": [disabled]})
        require(hook_action["enable_hook"] and not hook_action["add_hook"], "partial hook setup did not preserve its registration")
        listing["hooks"] = [hook]
        requests_before = self.proxy.worker_requests
        first = self.tick(worker)
        require(first["outcome"] == "registration_unverified", "unconfirmed hook attempted a work pull")
        before = {path.name: path.read_bytes() for path in worker["state"].glob("*.json")}
        dry = json.loads(self.hook(worker, dry=True).stdout)
        require(dry["action"] == "silent" and "Dry run" in dry["reason"] and self.proxy.worker_requests == requests_before and
                before == {path.name: path.read_bytes() for path in worker["state"].glob("*.json")},
                "dry run modified private worker state")
        require(self.registration(worker, "hook-authorize-registration", {**listing, "target": "watchdog"})["add_watchdog"],
                "resumed hook setup could not authorize its first watchdog")
        actual = {**watchdog, "native_job_id": "controlled-watchdog-" + worker["worker"]["id"]}
        verified = {**listing, "watchdogs": [actual], "dry_run": "silent"}
        hourly = {**verified, "watchdogs": [{**actual, "every": "1h"}]}
        self.registration(worker, "hook-authorize-registration", {**hourly, "target": "watchdog"}, want=1)
        self.registration(worker, "hook-confirm", hourly, want=1)
        result = self.registration(worker, "hook-confirm", verified)
        require(result["outcome"] == "registered" and result["hook_id"] == hook["id"] and
                result["watchdog_job_id"] == actual["native_job_id"], "exact readback did not establish both identities")
        require(self.registration(worker, "hook-confirm", verified) == result, "repeated readback changed registration")
        return result

    def tick(self, worker, *, want=0):
        worker["tick_number"] += 1
        invocation = "controlled-tick-" + str(worker["tick_number"])
        worker["last_tick"] = {"checker_run_id": invocation, "checker_job_id": worker["checker"]}
        result = self.hook(worker, invocation=invocation, want=want)
        if want != 0:
            require(not result.stdout, "failed tick emitted a native action")
            return None
        emitted = json.loads(result.stdout)
        if emitted["action"] == "wake":
            payload = emitted["payload"]
            current = json.loads((worker["state"] / "cron-claim.json").read_text())
            require(current["claim_id"] == payload["claim_id"] and current["wake_invocation_id"] == invocation and
                    payload["expected_run_id"] == "event-hook:" + invocation,
                    "packed detector emitted a wake for a different claim or invocation")
            grant = {"outcome": "prepare", **payload, "pull_run_id": current["pull_run_id"],
                     "generation": current["generation"], "operation_id": current["operation_id"],
                     "claimed_at": current["claimed_at"], "deadline_at": current["deadline_at"]}
            worker["work"] = {"grant": grant, "native_job_id": worker["checker"], "native_run_id": "event-hook-" + invocation,
                              "run_id": "event-hook:" + invocation}
            return grant
        require(emitted["action"] == "silent" and emitted.get("payload") is None, "a quiet tick emitted work")
        outcome = {"work_settled": "settled"}.get(emitted["reason"], emitted["reason"])
        result = {"outcome": outcome}
        if outcome == "claim_active":
            result["cause"] = self.status(worker).get("busy_reason")
        return result

    def start_work(self, worker, *, want=0, self_report=None):
        work = worker["work"]
        raw = self.native_cli(worker, "hook-start", "--launch-id", work["grant"]["launch_id"],
                              "--run-id", self_report or work["run_id"], want=want)
        if want != 0:
            require(not raw, "rejected start exposed a brief")
            return None
        brief = json.loads(raw)
        require(brief["outcome"] == "authorized" and brief["job_id"] == work["grant"]["job_id"], "wake brief was not authorized")
        return brief

    def abort(self, worker, *, want=0, launch=None, run=None):
        work = worker["work"]
        result = self.native_cli(worker, "hook-abort", "--launch-id", launch or work["grant"]["launch_id"],
                                 "--run-id", run or work["run_id"], "--reason", "execution_failed", want=want)
        if want == 0:
            require(json.loads(result)["outcome"] == "abort_saved", "clean abort did not record its terminal evidence")

    def claim_work(self, worker, job_id):
        grant = self.tick(worker)
        require(grant["outcome"] == "prepare" and grant["job_id"] == job_id, "detector did not wake for the queued job")
        return grant
