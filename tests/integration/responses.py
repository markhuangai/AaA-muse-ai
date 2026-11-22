#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
import platform
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import threading
import time
import urllib.parse

from chat import Chat
from service import require


class Responses(Chat):
    def body(self, text, stream=False, **fields):
        return {"model": "muse-ai", "input": text, "stream": stream, **fields}

    def response(self, body, session=None, **options):
        return self.chat(body, session, path="/v1/responses", **options)

    def value(self, result, failed=False):
        status, headers, raw = result
        require(status == 200, "Responses failed with HTTP " + str(status))
        if headers["Content-Type"].startswith("text/event-stream"):
            events = []
            for frame in raw.decode().split("\n\n"):
                if not frame.strip():
                    continue
                lines = frame.splitlines()
                types = [line[7:] for line in lines if line.startswith("event: ")]
                data = [line[6:] for line in lines if line.startswith("data: ")]
                require(len(types) == 1 and len(data) == 1 and data[0] != "[DONE]", "invalid Responses SSE framing")
                event = json.loads(data[0])
                require(event["type"] == types[0] and event["sequence_number"] == len(events), "Responses event order or sequence changed")
                events.append(event)
            require([e["type"] for e in events[:2]] == ["response.created", "response.in_progress"], "Responses lifecycle start missing")
            require(events[-1]["type"] == ("response.failed" if failed else "response.completed"), "Responses terminal event missing")
            return events[-1]["response"]
        require(not failed, "expected failed lifecycle stream")
        return json.loads(raw)

    def text(self, result):
        return self.value(result)["output"][0]["content"][0]["text"]

    def queue_expiry_without_polls(self):
        body = {"protocol_version": 1, "submission_id": "queue-expiry-without-polls", "timeout_seconds": 2,
                "messages": [{"type": "message", "role": "user", "text": "Unclaimed controlled request"}], "tools": []}
        admitted, _ = self.native("POST", "/api/v1/requests", body, want=202)
        require(admitted["state"] == "queued", "admission required an available worker")

        def swept():
            events, _ = self.collect_chat_logs("operation_id", admitted["id"])
            return any(event["msg"] == "job.deadline_exceeded" and event["operation"] == "sweep" and
                       not event["busy_hold"] for event in events)

        self.until(swept, "background sweep did not expire unclaimed work without worker contact", timeout=8)
        terminal, _ = self.native("GET", "/api/v1/requests/" + admitted["id"], origin=self.origins[1])
        require(terminal["state"] == "interrupted" and terminal["reason"] == "deadline_exceeded",
                "unclaimed work had the wrong terminal outcome")
        assignment = self.detail_id(admitted["id"])["assignment"]
        require(not assignment["held"] and assignment["claimed_at"] is None, "unobserved work acquired a claim")
        self.receipt("responses.queue_expiry_without_polls", brokers=2, eligible_workers=0,
                     request_deadline_seconds=2, cause=terminal["reason"])

    def sqlite_concurrency(self, secondary):
        for index in range(24):
            marker = f"sqlite-history-prefill-{index}"
            value, _ = self.answer(self.chat(self.chat_body("aaa-chat:text:" + marker), marker, origin=self.origins[index % 2]))
            require(value == marker, "history prefill did not complete through a real worker claim")
        history_watermark = int(self.sql("SELECT count(*) FROM aaa_model_requests;").strip())
        require(history_watermark >= 24, "poll sampling started before history was populated")
        since = datetime.now(timezone.utc)
        watermark = time.monotonic()

        def idle_after_watermark():
            seen = set()
            for bot in self.bots:
                with bot.condition:
                    require(not bot.errors and bot.thread.is_alive(), "a controlled worker failed during history prefill")
                    seen.update(pull["origin"] for pull in bot.pulls if pull["started"] >= watermark and not pull["claimed"])
            return seen == set(self.origins)

        self.until(idle_after_watermark, "both brokers must serve empty pulls on populated history before the mixed workload")
        before = time.monotonic()
        expires = before + 180
        gate = threading.Barrier(11, timeout=10)
        stop = threading.Event()

        def client(lane):
            gate.wait()
            completed = []
            for turn in range(3):
                remaining = expires - time.monotonic()
                require(remaining > 0, "SQLite concurrency exceeded the three-minute budget")
                marker = f"sqlite-mixed-{lane}-{turn}"
                prompt = "aaa-chat:delay:5:" + marker
                options = {"origin": self.origins[(lane + turn // 2) % 2], "timeout": remaining}
                started = time.monotonic()
                if (lane + turn) % 2:
                    result = self.response(self.body(prompt), marker, **options)
                    value = self.text(result)
                else:
                    result = self.chat(self.chat_body(prompt), marker, **options)
                    value, _ = self.answer(result)
                require(value == marker, "concurrent request received the wrong worker output")
                completed.append((result[1]["X-Request-Id"], round((time.monotonic() - started) * 1000)))
            return completed

        def history_reader():
            count = 0
            while not stop.wait(1):
                value, _ = self.checked("/api/v1/admin/requests?limit=5", self.admin, origin=self.origins[count % 2])
                require(isinstance(value["items"], list), "history read lost its bounded result")
                count += 1
            return count

        with ThreadPoolExecutor(max_workers=11) as workers:
            clients = [workers.submit(client, lane) for lane in range(10)]
            reader = workers.submit(history_reader)
            gate.wait()
            try:
                calls = dict(call for future in clients
                             for call in future.result(timeout=max(0.1, expires - time.monotonic())))
            finally:
                stop.set()
            reads = reader.result(timeout=max(0.1, expires - time.monotonic()))
        finished = time.monotonic()
        until = datetime.now(timezone.utc)
        require(finished < expires and finished - before >= 60 and len(calls) == 30 and reads > 0,
                "mixed workload did not complete with sustained overlapping storage traffic")

        poll_samples = []
        for bot in self.bots:
            with bot.condition:
                active = [pull for pull in bot.pulls if watermark <= pull["started"] and pull["at"] <= finished]
                require(any(pull["claimed"] for pull in active) and not bot.errors and bot.thread.is_alive(),
                        "a controlled worker did not claim real work")
                poll_samples.extend(active)
        idle_pulls = [pull["duration_ms"] for pull in poll_samples if not pull["claimed"]]
        claimed_pulls = [pull["duration_ms"] for pull in poll_samples if pull["claimed"]]
        require(idle_pulls and len(claimed_pulls) == 30, "incomplete idle and claimed pull measurements")
        require(self.sql("SELECT count(*) FROM aaa_worker_polls;").strip() == "2", "latest poll receipts grew with the number of pulls")

        events = [json.loads(line) for container in (self.main_service, secondary)
                  for line in self.logs(container).splitlines() if line.startswith("{")]
        window = [event for event in events if since <= datetime.fromisoformat(event["time"]) <= until]
        errors = [event for event in window if (event["msg"] == "request.completed" and event["status"] >= 400)
                  or event.get("cause") == "database_busy" or event["msg"] == "worker.pull_failed"]
        require(not errors, "normal concurrent traffic logged a lock failure or HTTP error")
        pulls_by_id = {item["request_id"]: item for item in poll_samples}
        require(len(pulls_by_id) == len(poll_samples), "pull requests lacked distinct correlation IDs")
        timings = {}
        query = urllib.parse.urlencode({"since": since.isoformat(), "until": until.isoformat()})
        for index, origin in enumerate(self.origins):
            status, _, raw = self.api("/api/v1/admin/diagnostics/export?" + query, self.admin, origin=origin)
            require(status == 200, "concurrent pull timing export unavailable")
            metadata, captured = self.decode_export(raw)
            require(metadata["complete"], "concurrent pull timing capture was incomplete")
            self.assert_private(raw.decode())
            self.private(f"sqlite-concurrency-{index}.ndjson", raw.decode())
            kinds = set()
            for event in captured:
                identity = event.get("request_id")
                if event["msg"] != "worker.pull_timing" or identity not in pulls_by_id:
                    continue
                sample = pulls_by_id[identity]
                require(identity not in timings and sample["origin"] == origin and event["sequence"] == sample["sequence"] and
                        event["replayed"] is False and event["queue_lookup_us"] >= 0 and event["transaction_acquire_us"] >= 0,
                        "sampled poll did not match one fresh indexed transaction on its serving broker")
                kinds.add(sample["claimed"])
                timings[identity] = event
            require(kinds == {False, True}, "a broker lacks correlated empty and claimed pulls on populated history")
        require(timings.keys() == pulls_by_id.keys() and len({event["instance_id"] for event in timings.values()}) == 2,
                "poll timings do not correlate with both broker instances")
        admissions = [event for event in events if event["msg"] == "history.reconciled"
                      and event.get("request_id") in calls and event.get("operation") == "request_create"]
        request_ids = {event["request_record_id"] for event in admissions}
        require(len(admissions) == len(request_ids) == 30 and len({event["instance_id"] for event in admissions}) == 2,
                "concurrent admission did not complete once on both brokers")
        completed = [event for event in events if event["msg"] == "request.completed" and event.get("request_id") in calls]
        require(len(completed) == 30 and all(event["status"] == 200 for event in completed),
                "concurrent outputs lacked one successful HTTP completion each")
        marks = [(datetime.fromisoformat(event["time"]), delta) for group, delta in ((admissions, 1), (completed, -1)) for event in group]
        active = peak = 0
        for _, delta in sorted(marks):
            active += delta
            peak = max(peak, active)
        require(peak == 10 and active == 0, "ten accepted requests did not overlap on the real brokers")

        def observations(name):
            return [event for event in events if event["msg"] == name and event.get("operation_id") in request_ids]

        claims, decisions, queue = (observations(name) for name in ("job.claimed", "decision.accepted", "dispatch.queued"))
        require(all(len(items) == 30 and {event["operation_id"] for event in items} == request_ids for items in (claims, decisions, queue))
                and len({event["worker_id"] for event in claims}) == 2 and {event["job_id"] for event in claims} == {event["job_id"] for event in decisions},
                "claims, decisions or queue assignments were duplicated, missing, or limited to one worker")
        require({event["request_id"] for event in claims} == {sample["request_id"] for sample in poll_samples if sample["claimed"]},
                "measured grants did not match the 30 workload claims")
        by_request = {event["operation_id"]: event for event in claims}
        windows = {}
        for identity in request_ids:
            self.until(lambda: not self.detail_id(identity)["assignment"]["held"], "worker did not settle accepted work")
            detail = self.detail_id(identity)
            job, request = detail["assignment"], detail["request"]
            require(job["id"] == by_request[identity]["job_id"] and not job["held"] and request["state"] == "completed",
                    "accepted decision left a held or mismatched assignment")
            windows.setdefault(job["worker_id"], []).append(
                (datetime.fromisoformat(job["claimed_at"]), datetime.fromisoformat(request["decision_accepted_at"])))
        for entries in windows.values():
            spans = sorted(entries)
            require(all(left[1] <= right[0] for left, right in zip(spans, spans[1:])), "a worker held simultaneous jobs")
        require(time.monotonic() < expires, "concurrency evidence exceeded the three-minute case budget")

        def p95(values):
            return sorted(values)[(95 * len(values) + 99) // 100 - 1]

        self.receipt("responses.sqlite_concurrent_read_write", brokers=2, online_workers=2, overlapping_requests=peak,
                     completed=len(calls), samples_per_timing=len(calls), successful_history_reads=reads,
                     duration_ms=round(1000 * (finished - before)),
                     completed_per_second=round(len(calls) / (finished - before), 3),
                     admission_p95_ms=p95([item["duration_ms"] for item in admissions]),
                     populated_history_watermark=history_watermark, idle_pull_samples=len(idle_pulls), claimed_pull_samples=len(claimed_pulls),
                     idle_pull_p95_ms=p95(idle_pulls), claimed_pull_p95_ms=p95(claimed_pulls),
                     transaction_acquire_p95_us=p95([item["transaction_acquire_us"] for item in timings.values()]),
                     indexed_lookup_p95_us=p95([item["queue_lookup_us"] for item in timings.values()]), client_p95_ms=p95(list(calls.values())),
                     sqlite_busy_errors=0, host_platform=platform.system(), host_arch=platform.machine(),
                     docker_version=self.docker("version", "--format", "{{.Server.Version}}").stdout.strip())

    def response_aliases(self):
        body = self.body("aaa-chat:text:compatible")
        session = "responses-model-aliases"
        first = self.value(self.response(body, session))
        for model in ("muse-ai", "muse-pool-text"):
            for stream in (False, True):
                replay = self.value(self.response({**body, "model": model, "stream": stream}, session))
                require(replay == {**first, "model": model}, "Responses replay changed the model or accepted output")
        self.receipt("responses.model_aliases", exact_replay=True)

    def diagnose_response(self, request_id, event_name, reason):
        selected, sources = [], []
        def captured():
            events, found = self.collect_chat_logs("request_id", request_id)
            selected[:] = events
            sources[:] = found
            return any(e["msg"] == event_name for e in events) and any(e["msg"] == "request.completed" for e in events)
        self.until(captured, "Responses final diagnostic capture missing")
        operations = {e["operation_id"] for e in selected if e.get("operation_id")}
        for operation in operations:
            events, found = self.collect_chat_logs("operation_id", operation)
            selected.extend(events)
            sources.extend(found)
        matches = [e for e in selected if e["msg"] == event_name and e.get("request_id") == request_id]
        require(matches and matches[0].get("reason", matches[0].get("cause")) == reason, "Responses logs identify the wrong cause")
        event = matches[0]
        if event_name != "auth.denied":
            require(event.get("client_id") in ("fixture-client", "other-client"), "Responses diagnostic owner missing")
        action = None
        if event_name == "auth.denied":
            require(event["expected_role"] == "client" and event["observed_role"] != "client", "credential authority cause missing")
            action = "supply a model-client credential instead of observed role " + event["observed_role"]
        elif event_name == "request.rejected":
            if reason == "body_too_large":
                require(event["max_bytes"] == 1048576, "admission size bound missing")
                action = "reduce the body below the recorded 1048576-byte bound"
            else:
                require(reason == "method_not_allowed" and event["observed_method"] != event["expected_method"], "method mismatch evidence missing")
                action = "send method " + event["expected_method"]
        elif event_name == "responses.request_rejected":
            if event.get("parameter"):
                action = "correct unsupported or malformed parameter " + event["parameter"]
            else:
                require(any(e["msg"] == "request.admitted" and e["body_bytes"] > 0 for e in selected), "malformed input boundary missing")
                action = "correct JSON encoding for the recorded parse rejection " + event["reason"]
        elif event_name == "responses.reference_rejected":
            require(event.get("requested_response_id") or event.get("evidence", {}).get("requested_item_id"), "rejected reference linkage missing")
            if reason == "session_reference_conflict":
                require(event["evidence"]["expected_session_id"] != event["evidence"]["observed_session_id"], "session conflict lacks both values")
                action = "use matching owned session " + event["evidence"]["expected_session_id"]
            elif reason == "stale_response_reference":
                require(event["evidence"]["current_request_id"], "current linear request missing")
                action = "continue from the completed response of current request " + event["evidence"]["current_request_id"]
            else:
                action = "use a response or replay item owned by the authenticated client"
        if event_name == "responses.item_conflict":
            detail = next(e for e in selected if e["msg"] == "history.conflict_detail" and e["reason"] == reason)
            evidence = detail["evidence"]
            if reason == "session_busy":
                require(evidence["observed_state"] in ("queued", "inference") and evidence["current_request_id"], "busy session lacks state/linkage evidence")
                action = "await current request " + evidence["current_request_id"] + " before continuing the linear session"
            elif "expected_call_id" in evidence:
                require(evidence["expected_call_id"] != evidence["observed_call_id"], "call mismatch not proved")
                action = "return the accepted client result for call " + evidence["expected_call_id"]
            elif "expected_item" in evidence:
                require(evidence["expected_item"] != evidence["observed_item"] and isinstance(evidence["position"], int), "item mismatch not proved")
                action = "restore the recorded accepted item at position " + str(evidence["position"])
            else:
                require(evidence["expected_history"] != evidence["observed_history"], "history mismatch not proved")
                action = "resend complete canonical history with the recorded accepted prefix"
        if event_name.endswith("terminated"):
            require(all(key in event for key in ("attempted_sequence", "completed_sequence", "last_event", "state", "output_accepted", "outcome", "duration_ms", "attempt")), "stream diagnosis lacks its last boundary")
            if event["output_accepted"]:
                require(any(e["msg"] == "responses.accepted_decision" and e["decision"] is not None for e in selected), "accepted decision missing from capture")
            if reason == "output_boundary_failed":
                storage = next(e for e in selected if e["msg"] == "inference.storage_exchange" and e["sqlite_code"] == "1811" and "responses_output_fixture" in e["detail"])
                require(storage["transaction_outcome"] == "rolled_back" and event["attempted_sequence"] == -1, "failed exposure boundary not proved")
                action = "repair the recorded storage constraint (SQLite result code " + storage["sqlite_code"] + ") and replay accepted output"
            elif event["output_accepted"]:
                interrupted = next(e for e in selected if e["msg"] == "request.output_interrupted" and e.get("request_id") == request_id)
                require(interrupted["cause"] and any(e["msg"] == "request.output_started" for e in selected), "accepted write interruption boundary missing")
                require(event["completed_sequence"] < event["attempted_sequence"] and not any(e["msg"] == "responses.encoded_output" and e["event"] == "response.completed" and e.get("request_id") == request_id for e in selected), "stream completion was already exposed")
                action = "replay accepted response " + event["response_id"] + " without repeating inference or client tools"
            else:
                uncertain = next(e for e in selected if e["msg"] == "recovery.uncertain" and e.get("busy_hold") and e.get("last_boundary") == "claimed_inference")
                claimed = next(e for e in selected if e["msg"] == "job.claimed" and e["job_id"] == uncertain["job_id"])
                causal = next(e for e in selected if e["msg"] in ("job.interrupted", "job.deadline_exceeded", "experiment.cancelled") and e["job_id"] == uncertain["job_id"] and e.get("busy_hold"))
                require(uncertain["automatic_replay"] is False and uncertain["remote_outcome"] == "unknown" and
                        claimed["generation"] == uncertain["generation"] > 0 and claimed["claim_id"] == uncertain["claim_id"],
                        "uncertain native claim identity or no-retry proof missing")
                require(causal["reason"] == ("operator_cancelled" if reason == "request_context_cancelled" else reason), "terminal cause differs from assignment cause")
                action = uncertain["corrective_action"]
                require(action, "uncertain operation lacks logged corrective action")
        require(action is not None, "unsupported log-only diagnostic conclusion")
        self.private("responses-diagnosis-" + request_id + ".json", json.dumps({"cause": reason, "action": action, "events": selected}))
        self.receipt("responses.log_only_diagnosis", request_id=request_id, event=event_name, cause=reason, corrective_action=action, sources=sources, related_operations=len(operations))
        return selected

    def matrix(self):
        fixture = self.private("responses-client-only.txt", "exact-client-" + secrets.token_hex(16) + "\r\n😀\n")
        receipt = self.root / "responses-conformance.json"
        command = ["node", "tools/openai-conformance.mjs", "--protocol", "responses", "--base-url", self.origin_url + "/v1", "--fixture", str(fixture), "--receipt", str(receipt)]
        result = subprocess.run(command, env={**os.environ, "MUSE_CHAT_CLIENT_KEY": self.client}, capture_output=True, text=True, timeout=180)
        self.private("responses-runner.log", result.stdout + result.stderr)
        require(result.returncode == 0, "Responses SDK/raw conformance failed; inspect private runner evidence")
        proof = json.loads(receipt.read_text())
        require(proof["sdk_version"] == "7.53.0" and not proof["qualifies_live_muse"], "Responses runner receipt has wrong provenance")
        for case in proof["receipts"]:
            for rejection in case.get("rejections", []):
                self.diagnose_response(rejection["request_id"], "responses.request_rejected", rejection["code"])
            self.receipt("responses." + case.pop("case"), **case)

    def boundaries(self):
        for field, value in (("store", False), ("background", True), ("conversation", "foreign"), ("parallel_tool_calls", True), ("temperature", 0), ("tools", [{"type": "web_search"}])):
            status, headers, raw = self.response(self.body("x", **{field: value}))
            require(status == 400 and isinstance(json.loads(raw)["error"], dict), "unsupported Responses field was admitted")
            self.diagnose_response(headers["X-Request-Id"], "responses.request_rejected", json.loads(raw)["error"]["code"])
        for input_value in ([{"type": "reasoning"}], [{"role": "user", "content": [{"type": "input_image", "image_url": "https://invalid.test"}]}]):
            result = self.response(self.body(input_value))
            require(result[0] == 400, "unsupported item silently dropped")
            self.diagnose_response(result[1]["X-Request-Id"], "responses.request_rejected", json.loads(result[2])["error"]["code"])
        for key in ("", self.admin):
            result = self.response(self.body("x"), key=key)
            require(result[0] == 401, "Responses accepted incorrect credential authority")
            self.diagnose_response(result[1]["X-Request-Id"], "auth.denied", "role_not_permitted")
        malformed = self.response(self.body("x"), raw=b"{")
        require(malformed[0] == 400, "invalid JSON admitted")
        self.diagnose_response(malformed[1]["X-Request-Id"], "responses.request_rejected", json.loads(malformed[2])["error"]["code"])
        large = self.response(self.body("x" * (1024 * 1024)))
        require(large[0] == 413, "oversized Responses body admitted")
        self.diagnose_response(large[1]["X-Request-Id"], "request.rejected", "body_too_large")
        method = self.api("/v1/responses", self.client)
        require(method[0] == 405, "Responses accepted wrong method")
        self.diagnose_response(method[1]["X-Request-Id"], "request.rejected", "method_not_allowed")
        self.receipt("responses.strict_boundaries")

    def references_and_instructions(self, other_origin):
        first_result = self.response(self.body("aaa-chat:echo:first", instructions="first-private-instruction"), "responses-linear")
        first = self.value(first_result)
        bot, job = self.job_for("aaa-chat:echo:first")
        require(job["context"]["messages"][0]["text"] == "first-private-instruction", "initial instructions absent")
        second_body = self.body("aaa-chat:echo:second", instructions="replacement-private-instruction", previous_response_id=first["id"])
        second = self.value(self.response(second_body, origin=other_origin))
        second_bot, second_job = self.job_for("aaa-chat:echo:second")
        messages = second_job["context"]["messages"]
        require(second_bot.worker["worker"]["id"] == bot.worker["worker"]["id"] and len(messages) == 4 and messages[0]["text"] == "replacement-private-instruction" and all(m.get("text") != "first-private-instruction" for m in messages), "pin or request-scoped instructions changed")
        third_body = self.body("aaa-chat:echo:third", previous_response_id=second["id"])
        third_result = self.response(third_body)
        third = self.value(third_result)
        _, third_job = self.job_for("aaa-chat:echo:third")
        require(len(third_job["context"]["messages"]) == 5 and third_job["context"]["messages"][0]["text"] == "aaa-chat:echo:first", "omitted instructions reactivated old values")
        replay = self.value(self.response(second_body, origin=other_origin))
        require(replay["id"] == second["id"] and replay["output"] == second["output"], "older exact retry was rejected or regenerated")
        for fields, session, key, status, cause in (
            ({"previous_response_id": first["id"]}, None, None, 409, "stale_response_reference"),
            ({"previous_response_id": third["id"]}, "wrong-session", None, 409, "session_reference_conflict"),
            ({"previous_response_id": third["id"]}, None, self.other_client, 404, "history_owner_denied"),
            ({"previous_response_id": "resp_unknown"}, None, self.other_client, 404, "history_owner_denied"),
        ):
            result = self.response(self.body("aaa-chat:echo:denied", **fields), session, key=key)
            require(result[0] == status and json.loads(result[2])["error"]["code"] == cause, "wrong reference rejection")
            self.diagnose_response(result[1]["X-Request-Id"], "responses.reference_rejected", cause)
        other = self.value(self.response(self.body("aaa-chat:echo:other-owner"), "responses-linear", key=self.other_client))
        require(other["id"] != third["id"], "same session string crossed owners")
        item = json.loads(json.dumps(third["output"][0]))
        item["content"][0]["text"] = "changed accepted answer"
        conflict = self.response(self.body([item, {"role": "user", "content": "aaa-chat:echo:new"}], previous_response_id=third["id"]))
        require(conflict[0] == 409, "changed accepted output item admitted")
        self.diagnose_response(conflict[1]["X-Request-Id"], "responses.item_conflict", "response_item_conflict")
        empty = self.value(self.response(self.body("aaa-chat:echo:empty", instructions="", previous_response_id=third["id"])))
        _, empty_job = self.job_for("aaa-chat:echo:empty")
        require(empty["instructions"] == "" and empty_job["context"]["messages"][0]["text"] == "", "explicit empty instructions changed")
        self.last = empty
        self.receipt("responses.owned_linear_instructions_and_pin", immutable_snapshots=True, header_reference_agreement=True)

    def concurrent_admission(self, other_origin):
        first = self.value(self.response(self.body("aaa-chat:echo:race-base"), "responses-race"))
        body = self.body("aaa-chat:echo:race-identical", previous_response_id=first["id"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda origin: self.response(body, origin=origin), (self.origin_url, other_origin)))
        values = [self.value(result) for result in results]
        require(values[0]["id"] == values[1]["id"], "two brokers duplicated exact chained admission")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda index: self.response(self.body("aaa-chat:echo:race-" + str(index), previous_response_id=values[0]["id"]), origin=self.origin_url if index == 0 else other_origin), range(2)))
        require(sorted(result[0] for result in results) == [200, 409], "competing continuations were not serialized")
        rejected = next(result for result in results if result[0] == 409)
        reason = json.loads(rejected[2])["error"]["code"]
        name = "responses.reference_rejected" if reason == "stale_response_reference" else "responses.item_conflict"
        self.diagnose_response(rejected[1]["X-Request-Id"], name, reason)
        self.receipt("responses.two_broker_serialization", exact_request_ids=1, conflicting_turns_accepted=1)

    def tool_conflicts_and_replacement(self):
        fixture = self.private("replacement-client-only.txt", "client-result-" + secrets.token_hex(12) + "\r\n😀")
        tools = [{"type": "function", "name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}}]
        original = [{"role": "user", "content": "aaa-chat:tool:" + str(fixture)}]
        first = self.value(self.response(self.body(original, tools=tools), "responses-replacement"))
        bot, first_job = self.job_for(original[0]["content"])
        call = first["output"][0]
        require(call["type"] == "function_call" and json.loads(call["arguments"])["path"] == str(fixture), "wrong proposed client fixture tool")
        wrong = {"type": "function_call_output", "call_id": "wrong-call", "output": "wrong"}
        denied = self.response(self.body([wrong], tools=tools, previous_response_id=first["id"]))
        require(denied[0] == 409, "wrong tool result linkage admitted")
        self.diagnose_response(denied[1]["X-Request-Id"], "responses.item_conflict", "tool_result_linkage_conflict")
        result = {"type": "function_call_output", "call_id": call["call_id"], "output": fixture.read_bytes().decode()}
        completed = self.value(self.response(self.body([result], tools=tools, previous_response_id=first["id"])))
        require(completed["output"][0]["content"][0]["text"] == result["output"], "client result changed")
        changed = {**result, "output": "conflicting result"}
        conflict = self.response(self.body(original + [call, changed, completed["output"][0], {"role": "user", "content": "new"}], tools=tools), "responses-replacement")
        require(conflict[0] == 409, "conflicting accepted result admitted")
        self.diagnose_response(conflict[1]["X-Request-Id"], "responses.item_conflict", "history_prefix_conflict")
        for candidate in self.bots:
            require(candidate.thread.is_alive() and not candidate.errors, "replacement requires healthy fixture peers")
        bot.stop()
        worker_id = bot.worker["worker"]["id"]
        elapsed = int((datetime.now(timezone.utc) - timedelta(minutes=10, seconds=1)).timestamp() * 1_000_000)
        self.sql(f"UPDATE aaa_workers SET last_contact_at={elapsed} WHERE id='{worker_id}';")
        replacement = self.response(self.body("aaa-chat:echo:replacement-complete", previous_response_id=completed["id"]))
        require(self.text(replacement) == "replacement-complete", "eligible replacement failed")
        replacement_bot, job = self.job_for("aaa-chat:echo:replacement-complete")
        require(replacement_bot.worker["worker"]["id"] != bot.worker["worker"]["id"], "offline worker pin did not move")
        messages = job["context"]["messages"]
        require(len(messages) == 5 and messages[1]["call_id"] == call["call_id"] and messages[2]["output"] == result["output"], "replacement lost full history or accepted tool IDs")
        events, _ = self.collect_chat_logs("request_id", replacement[1]["X-Request-Id"])
        operations = {e["operation_id"] for e in events if e.get("operation_id")}
        for operation in operations:
            more, _ = self.collect_chat_logs("operation_id", operation)
            events.extend(more)
        require(any(e["msg"] == "dispatch.pin_released" for e in events) and any(e["msg"] == "inference.context" and e["context"]["messages"] == messages for e in events), "replacement cannot be reconstructed from logs")
        reassigned = next(e for e in events if e["msg"] == "dispatch.pin_released")
        require(reassigned["previous_worker_id"] == worker_id and reassigned["prior_job_id"] != job["id"] and reassigned["reason"] == "offline_before_claim_and_context", "replacement cause missing")
        self.receipt("responses.log_only_diagnosis", request_id=replacement[1]["X-Request-Id"], event="dispatch.pin_released", cause=reassigned["reason"], corrective_action="continue the logged full-history replacement without executing accepted tools again")
        self.receipt("responses.safe_replacement_full_history", client_tool_executions=1, accepted_call_id=call["call_id"], full_context_items=len(messages))

    def deadline_abort_and_storage(self):
        marker = "aaa-chat:hold:responses-deadline"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.response, self.body(marker, True), "responses-deadline")
            bot, job = self.job_for(marker)
            expired = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            self.expire_job(job, expired)
            result = pending.result(timeout=12)
        require(self.value(result, failed=True)["error"]["code"] == "deadline_exceeded", "admitted deadline lacked failure lifecycle")
        self.diagnose_response(result[1]["X-Request-Id"], "responses.stream_terminated", "deadline_exceeded")
        require(self.detail_id(job["experiment_id"])["assignment"]["held"], "deadline freed uncertain remote inference")
        bot.settle(job)
        self.until(lambda: self.status(bot.worker)["work_status"] == "idle", "deadline hold was not acknowledged")
        target = urllib.parse.urlsplit(self.origin_url)
        connection = socket.create_connection((target.hostname, target.port), timeout=10)
        marker = "aaa-chat:hold:responses-abort"
        data = json.dumps(self.body(marker, True)).encode()
        connection.sendall(("POST /v1/responses HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer " + self.client + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(data)) + "\r\nX-Muse-Session-Id: responses-abort\r\n\r\n").encode() + data)
        bot, job = self.job_for(marker)
        connection.shutdown(socket.SHUT_RDWR)
        connection.close()
        terminal = []
        def aborted():
            events, _ = self.collect_chat_logs("operation_id", job["experiment_id"])
            terminal[:] = [e for e in events if e["msg"] == "responses.stream_terminated"]
            return bool(terminal)
        self.until(aborted, "Responses client-abort evidence missing")
        require(terminal[0]["level"] == "INFO" and self.detail_id(job["experiment_id"])["assignment"]["held"], "abort lost severity or uncertainty")
        self.diagnose_response(terminal[0]["request_id"], "responses.stream_terminated", "request_context_cancelled")
        bot.settle(job)
        self.until(lambda: self.status(bot.worker)["work_status"] == "idle", "abort hold was not acknowledged")
        marker = "aaa-chat:hold:responses-storage"
        body = self.body(marker, True)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.response, body, "responses-storage")
            bot, job = self.job_for(marker)
            self.reject_writes("responses_output_fixture", "aaa_model_requests", "NEW.id='" + job["experiment_id"] + "' AND json_extract(CAST(NEW.data AS TEXT),'$.output_started_at') IS NOT NULL")
            bot.submit(job, {"type": "final", "text": "retained-storage-answer"})
            result = pending.result(timeout=12)
        require(result[0] == 503 and not result[1]["Content-Type"].startswith("text/event-stream"), "failed exposure boundary emitted lifecycle")
        self.diagnose_response(result[1]["X-Request-Id"], "responses.stream_terminated", "output_boundary_failed")
        self.sql("DROP TRIGGER responses_output_fixture;")
        require(self.text(self.response(body, "responses-storage")) == "retained-storage-answer", "storage retry lost accepted output")
        self.receipt("responses.deadline_abort_storage", uncertain_holds_retained=True, no_inference_retry=True)

    def interrupted_delivery(self):
        marker = "aaa-chat:hold:responses-partial"
        body = self.body(marker, True)
        data = json.dumps(body).encode()
        target = urllib.parse.urlsplit(self.origin_url)
        connection = socket.create_connection((target.hostname, target.port), timeout=15)
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        connection.sendall(("POST /v1/responses HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer " + self.client + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(data)) + "\r\nX-Muse-Session-Id: responses-partial\r\n\r\n").encode() + data)
        bot, job = self.job_for(marker)
        received, failures = [], []
        def interrupt():
            wire = b""
            try:
                while b"event: response.output_item.added" not in wire:
                    part = connection.recv(1024)
                    require(part and len(wire) < 32768, "initial Responses item event missing")
                    wire += part
                received.append(wire)
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except Exception as error:
                failures.append(type(error).__name__)
            finally:
                connection.close()
        reader = threading.Thread(target=interrupt, daemon=True)
        reader.start()
        output = "x" * (768 * 1024)
        bot.submit(job, {"type": "final", "text": output})
        reader.join(timeout=20)
        require(not reader.is_alive() and received and not failures and b"event: response.completed" not in received[0], "partial Responses delivery fixture failed")
        terminal = []
        def terminated():
            events, _ = self.collect_chat_logs("operation_id", job["experiment_id"])
            terminal[:] = [e for e in events if e["msg"] == "responses.stream_terminated"]
            return bool(terminal)
        self.until(terminated, "partial Responses stream termination missing")
        event = terminal[0]
        require(event["cause"] in ("request_context_cancelled", "response_write_failed") and event["output_accepted"] and event["completed_sequence"] < 8, "partial stream claimed completion")
        self.diagnose_response(event["request_id"], "responses.stream_terminated", event["cause"])
        require(self.text(self.response(body, "responses-partial")) == output, "partial delivery replay changed accepted output")
        require(sum(j["experiment_id"] == job["experiment_id"] for b in self.bots for j in b.jobs) == 1, "partial delivery restarted inference")
        self.receipt("responses.partial_delivery_accepted_replay", last_sequence=event["completed_sequence"], inference_executions=1)

    def restart_and_worker_loss(self):
        for bot in self.bots:
            if bot.thread.is_alive():
                bot.stop()
        self.docker("restart", self.main_service)
        self.origin_url = self.origin(self.main_service)
        self.origins[0] = self.origin_url
        self.ready(self.main_service, self.origin_url)
        for bot in self.bots:
            bot.start()
        next_result = self.response(self.body("aaa-chat:echo:after-restart", instructions="after-restart-only", previous_response_id=self.last["id"]))
        require(self.text(next_result) == "after-restart", "restart lost owned response reference")
        bot, job = self.job_for("aaa-chat:echo:after-restart")
        require(job["context"]["messages"][0]["text"] == "after-restart-only" and any(m.get("text") == "aaa-chat:echo:first" for m in job["context"]["messages"]), "restart lost instruction projection or canonical history")
        marker = "aaa-chat:hold:responses-worker-loss"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.response, self.body(marker, True), "responses-worker-loss")
            bot, job = self.job_for(marker)
            bot.stop()
            self.expire_job(job, (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat())
            result = pending.result(timeout=12)
        failed = self.value(result, failed=True)
        require(failed["error"]["code"] == "deadline_exceeded" and self.detail_id(job["experiment_id"])["assignment"]["held"], "worker loss hid uncertainty")
        self.diagnose_response(result[1]["X-Request-Id"], "responses.stream_terminated", "deadline_exceeded")
        require(sum(j["experiment_id"] == job["experiment_id"] for b in self.bots for j in b.jobs) == 1, "claimed worker loss retried inference")
        self.receipt("responses.restart_and_claimed_failure", durable_reference=True, uncertain_hold=True, no_automatic_retry=True)

    def capture_and_delay(self):
        private = "fixture-client-detail-" + self.client + "\r\n😀"
        result = self.response(self.body("aaa-chat:echo:" + private, True, instructions="private-instruction-" + self.portal), "responses-capture")
        require(self.text(result) == private, "redaction changed public model output")
        events, _ = self.collect_chat_logs("request_id", result[1]["X-Request-Id"])
        for name in ("responses.input", "responses.normalized_input", "responses.accepted_decision", "responses.encoded_output"):
            require(any(e["msg"] == name and e["level"] == "DEBUG" and "[REDACTED]" in json.dumps(e) for e in events), "complete redacted Responses capture missing " + name)
        output = self.logs(self.main_service)
        require("fixture-client-detail-" not in output and '"msg":"responses.encoded_output"' not in output, "private DEBUG payload reached INFO")
        started = time.monotonic()
        require(self.text(self.response(self.body("aaa-chat:delay:31:waited-beyond-default"), "responses-delay", timeout=45)) == "waited-beyond-default" and time.monotonic() - started >= 30, "Responses retained default 30-second write timeout")
        self.receipt("responses.protected_capture_and_wait", complete_capture=True, info_filter_verified=True, waited_beyond_30_seconds=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = Responses(args)
    outcome = "failed"
    try:
        h.baseline()
        h.setup()
        h.main_service, h.origin_url, _ = h.launch(h.configuration())
        h.ready(h.main_service, h.origin_url)
        secondary, other_origin, _ = h.launch(h.configuration())
        h.ready(secondary, other_origin)
        h.origins = [h.origin_url, other_origin]
        h.queue_expiry_without_polls()
        for _ in range(2):
            h.new_bot()
        h.sqlite_concurrency(secondary)
        h.matrix()
        h.boundaries()
        h.response_aliases()
        h.references_and_instructions(other_origin)
        h.concurrent_admission(other_origin)
        h.capture_and_delay()
        h.tool_conflicts_and_replacement()
        h.deadline_abort_and_storage()
        h.interrupted_delivery()
        h.restart_and_worker_loss()
        outcome = "passed"
    finally:
        failures = []
        for bot in h.bots:
            if bot.thread.is_alive():
                try:
                    bot.stop()
                except Exception as error:
                    failures.append(type(error).__name__)
        for peer in h.peers:
            try:
                peer.stop()
                if peer.errors:
                    failures.append("SSEPeerError")
            except Exception as error:
                failures.append(type(error).__name__)
        h.cleanup()
        source = subprocess.run(["node", "--input-type=module", "-e", "import {inspectSource} from './tools/source-inventory.mjs'; console.log(JSON.stringify(inspectSource().identity));"], capture_output=True, text=True, timeout=15)
        require(source.returncode == 0, "Responses source receipt missing")
        safe = {"suite": "openai-responses", "outcome": outcome, "source": json.loads(source.stdout), "sdk_version": "7.53.0", "controlled_peer": True, "qualifies_live_muse": False, "receipts": h.receipts, "cleanup": json.loads((h.root / "cleanup.json").read_text()), "peer_cleanup_failures": failures}
        h.assert_private(json.dumps(safe))
        target = Path(".artifacts/ci/openai")
        target.mkdir(parents=True, exist_ok=True)
        (target / "responses-receipt.json").write_text(json.dumps(safe, indent=2) + "\n")
        require(not failures, "Responses peer cleanup failed")


if __name__ == "__main__":
    main()
