#!/usr/bin/env python3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import urllib.parse

from native_cron import utc_stamp
from service import require
from worker_setup import WorkerSetup, run


class WorkerTransport(WorkerSetup):
    def usage_script(self, percent):
        program = self.assets.public / "bin" / "subscription-status"
        program.write_text(f'''#!/bin/sh
[ "$#" = 1 ] && [ "$1" = status ] || exit 1
printf '%s\n' 'Usage: {percent}% of free weekly limit.' 'Weekly limit resets Nov 29 at 7:49 AM EST.'
''')
        program.chmod(0o755)

    def usage(self, worker):
        return self.worker_projection(worker)[0]["weekly_usage"]

    def weekly_report(self, worker, since, origin, route, percent):
        events = self.worker_capture(worker, "--since", since, "--until", utc_stamp())
        sent = next(event for event in events if event["msg"] == "worker.http_exchange" and
                    event["route"].endswith(route) and event.get("weekly_usage", {}).get("used_percent") == percent)
        sample = sent["weekly_usage"]
        require(datetime.fromisoformat(sample["observed_at"]) >= datetime.fromisoformat(sent["input"]["scheduled_at"]),
                "detector submitted a sample from before its occurrence")
        remote = self.report_evidence("request_id", sent["request_id"], origin)
        report = next(event for event in remote if event["msg"] == "worker.weekly_usage_observed")
        require(report["reason"] == "recorded" and report["weekly_usage"]["used_percent"] == percent and
                datetime.fromisoformat(report["weekly_usage"]["observed_at"]) == datetime.fromisoformat(sample["observed_at"]),
                "worker and broker log exports could not be joined for the weekly sample")

    def terminal_before_start(self, worker, expire):
        experiment = self.create(worker, "no brief after the terminal boundary", tools=False, timeout=12 if expire else 300)
        grant = self.claim_work(worker, experiment["current_job_id"])
        if expire:
            deadline = datetime.fromisoformat(grant["deadline_at"])
            self.until(lambda: datetime.now(timezone.utc) >= deadline, "the claim did not reach its deadline", timeout=15)
        else:
            self.cancel(experiment["id"])
        self.start_work(worker, want=1)
        require(self.status(worker)["work_status"] == "busy" and self.tick(worker)["outcome"] == "settled",
                "terminal pre-start refusal did not settle the original claim")
        outcomes = self.export_operation(experiment["id"])
        require(not any(event["msg"] == "job.work_started" for event in outcomes) and
                self.experiment(experiment["id"])["state"] == ("interrupted" if expire else "cancelled"),
                "pre-start refusal exposed a brief or changed the terminal outcome")
        self.receipt("worker.terminal_before_start", expired=expire, brief_exposed=False, matching_receipt=True)

    def lost_start(self):
        worker = self.environment("lost-start")
        self.install(worker, self.prompt())
        self.checker(worker)
        experiment = self.create(worker, "lost start receipt leaves a busy hold", tools=False)
        job = experiment["current_job_id"]
        grant = self.claim_work(worker, job)
        self.proxy.lose_worker_replies["/api/v1/worker/jobs/" + job + "/start"] = 1
        self.start_work(worker, want=1)
        self.start_work(worker, want=1)
        self.abort(worker, want=1)
        require(self.tick(worker)["outcome"] == "claim_active" and self.status(worker)["current_claim"]["claim_id"] == grant["claim_id"],
                "uncertain start released or replaced the claim")
        starts = [event for event in self.export_operation(experiment["id"]) if event["msg"] == "job.work_started"]
        require(len(starts) == 1 and starts[0]["claim_id"] == grant["claim_id"], "start reply loss exposed another brief")
        self.receipt("worker.start_reply_held", starts=1, second_brief=False, hold_retained=True)

    def remote_operations(self, worker):
        doctor = self.worker_control(worker, "ops", {"protocol_version": 1, "submission_id": "controlled-doctor", "kind": "doctor"})
        require(self.tick(worker)["outcome"] == "worker_op_settled", "doctor emitted a wake or failed to settle")
        doctor = self.worker_control(worker, "ops/" + doctor["id"])
        require(doctor["state"] == "succeeded" and doctor["result"]["state_permissions"] == "verified" and
                int(doctor["result"]["available_bytes"]) > 0, "doctor did not inspect the packed worker")
        since = utc_stamp()
        scope = "Bearer ControlledBearerCanary1234567890"
        dense = ('"' + chr(92) + "<>&") * 25000
        for index in range(4):
            prompt = "Return the controlled output fixture"
            task = self.worker_control(worker, "agent-tasks", {"protocol_version": 1, "submission_id": f"transport-task-{index}", "prompt": prompt})
            _, brief = self.start_agent_task(worker, task)
            require(brief["prompt"] == prompt, "task input changed before authorized delivery")
            raw = self.native_cli(worker, "hook-task-finish", "--task-id", task["id"], "--input", "-",
                                  input_text=json.dumps({"result_text": dense + scope, "summary": "controlled output"}))
            require(json.loads(raw)["outcome"] == "accepted", "bounded task result was rejected")
            detail = self.worker_control(worker, "agent-tasks/" + task["id"])
            require(detail["held"] and detail["result"]["result_text"].endswith("[REDACTED]"), "result leaked a credential or released the hold")
            require(self.tick(worker)["outcome"] == "background_task_settled", "the accepted task result did not settle")
        params = {"since": since, "decode": True}
        request = {"protocol_version": 1, "submission_id": "bounded-output-one", "kind": "diagnostics_export", "params": params}
        submitted = self.worker_control(worker, "ops", request)
        require(self.tick(worker)["outcome"] == "worker_op_settled", "bounded export failed or woke Muse")
        detail = self.worker_control(worker, "ops/" + submitted["id"])
        result = detail["result"]
        require(detail["state"] == "succeeded" and detail["result_bytes"] <= 512 * 1024 and result["truncated"] and
                not result["complete"] and result["next_cursor"] and result["omissions"], "dense JSON export lost its bound or honest cursor")
        self.assert_private(json.dumps(result), extra=(scope,))
        second = self.worker_control(worker, "ops", {**request, "submission_id": "bounded-output-two",
                                                        "params": {**params, "cursor": result["next_cursor"]}})
        require(self.tick(worker)["outcome"] == "worker_op_settled", "continuation failed")
        continuation = self.worker_control(worker, "ops/" + second["id"])
        require(continuation["state"] == "succeeded" and continuation["result"]["output"] != result["output"], "continuation repeated the prior page")
        evidence = self.export_operation(submitted["id"])
        exchange = next(record for record in evidence if record.get("msg") == "worker_op.exchange" and record.get("input_omitted"))
        read = next(record for record in evidence if record.get("response_capture") == "worker_op_result_omitted")
        require(exchange["truncated"] and exchange["result_bytes"] <= 512 * 1024 and "input" not in exchange and not read["response"],
                "diagnostics output amplified protected capture")
        self.receipt("worker.typed_operations_and_bounded_diagnostics", doctor=True, task_count=4, redacted=True, paginated=True, capture_complete=True)

    def exercise(self):
        worker = self.environment("transport-hook")
        self.install(worker, self.prompt())
        self.checker(worker)
        sibling, origin, _ = self.launch(self.configuration())
        self.ready(sibling, origin)
        begin = utc_stamp()
        self.usage_script(33.25)
        require(self.tick(worker)["outcome"] == "idle", "quiet detector did not perform an idle pull")
        first_usage = self.usage(worker)
        require(first_usage["used_percent"] == 33.25, "first pickup did not sample weekly use")
        self.usage_script(71)
        require(self.tick(worker)["outcome"] == "idle" and self.usage(worker) == first_usage,
                "detector sampled again before 45 seconds")
        self.weekly_report(worker, begin, self.origin_url, "/pull", 33.25)
        request = self.create(worker, "controlled packed detector tool continuation")
        grant = self.claim_work(worker, request["current_job_id"])
        self.start_work(worker, self_report="event-hook:foreign", want=1)
        require(self.status(worker)["claim_stage"] == "pending_native_start", "wrong invocation consumed the start")
        brief = self.start_work(worker)
        self.start_work(worker, want=1)
        poll = self.status(worker)["last_poll_at"]
        require(self.tick(worker)["outcome"] == "claim_active" and self.status(worker)["last_poll_at"] == poll,
                "busy tick picked up another assignment")
        observed = datetime.fromisoformat(first_usage["observed_at"])
        self.until(lambda: (datetime.now(timezone.utc) - observed).total_seconds() >= 45,
                   "45-second weekly sample boundary did not elapse", timeout=48)
        self.proxy.target = urllib.parse.urlsplit(origin)
        try:
            require(self.tick(worker)["outcome"] == "claim_active" and self.status(worker)["last_poll_at"] == poll and
                    self.usage(worker)["used_percent"] == 71, "busy detector did not refresh usage on the sibling")
            self.weekly_report(worker, begin, origin, "/presence", 71)
        finally:
            self.proxy.target = urllib.parse.urlsplit(self.origin_url)
        with ThreadPoolExecutor(max_workers=2) as pool:
            tasks = [pool.submit(self.hook, worker, invocation="overlap-a"), pool.submit(self.hook, worker, invocation="overlap-b")]
            actions = [json.loads(task.result().stdout)["action"] for task in tasks]
        require(actions == ["silent", "silent"], "overlapping busy hook ticks emitted work")
        tool = {"type": "tool_call", "call_id": "controlled-call", "name": "read_file", "arguments": {"path": "/client-only"}}
        self.native_cli(worker, "decision-submit", "--job-id", brief["job_id"], "--input", "-", input_text=json.dumps(tool))
        require(self.tick(worker)["outcome"] == "settled", "accepted tool call did not settle on a silent tick")
        self.usage_script(19)
        followup, _ = self.checked("/api/v1/admin/experiments/" + request["id"] + "/tool-results", self.admin, "POST",
                                   {"protocol_version": 1, "submission_id": "client-tool", "call_id": "controlled-call", "output": "exact client fixture"}, want=202)
        self.claim_work(worker, followup["current_job_id"])
        require(self.usage(worker)["used_percent"] == 19, "pickup after settlement did not sample weekly usage")
        self.weekly_report(worker, begin, self.origin_url, "/pull", 19)
        received = self.start_work(worker)
        require(received["context"]["messages"][-1]["output"] == "exact client fixture", "canonical client tool result changed")
        self.native_cli(worker, "decision-submit", "--job-id", received["job_id"], "--input", "-",
                        input_text=json.dumps({"type": "final", "text": "exact client fixture"}))
        require(self.tick(worker)["outcome"] == "settled" and self.experiment(request["id"])["final_text"] == "exact client fixture",
                "hook continuation lost its final result")
        cleanup = self.create(worker, "clean scoped abort", tools=False)
        self.claim_work(worker, cleanup["current_job_id"])
        self.start_work(worker)
        self.abort(worker)
        require(self.tick(worker)["outcome"] == "settled", "hook abort did not settle the held slot")
        self.terminal_before_start(worker, expire=False)
        self.terminal_before_start(worker, expire=True)
        self.lost_start()
        status, _, raw = self.api("/api/v1/admin/diagnostics/export?operation_id=" + request["id"], self.admin)
        self.assert_private(raw.decode())
        meta, remote = self.decode_export(raw)
        local = [json.loads(line) for line in self.native_cli(worker, "diagnostics-export", "--operation-id", request["id"], "--decode").splitlines()]
        rejected = next(e for e in local if e.get("cause") == "hook_run_mismatch")
        starts = [e for e in local if e.get("msg") == "hook.work_started"]
        require(status == 200 and meta["complete"] and local[0]["complete"] and rejected["level"] == "WARN" and
                rejected["claim_id"] == grant["claim_id"] and rejected["expected_run_id"] != rejected["observed_run_id"] and
                len(starts) == 2 and all(any(e.get("request_id") == start["request_id"] and e["msg"] == "job.work_started"
                    for e in remote) for start in starts), "protected captures could not reconstruct the wrong invocation and two authorized turns")
        self.receipt("worker.hook_transport_and_tool_loop", wake_count=2, refusals=2, busy_work_pulls=0, capture_complete=True)
        self.remote_operations(worker)


if __name__ == "__main__":
    run(WorkerTransport, "worker-transport")
