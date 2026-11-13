#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
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
        return {"model": "muse-pool-text", "input": text, "stream": stream, **fields}

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
                storage = next(e for e in selected if e["msg"] == "inference.storage_exchange" and e["sqlstate"] == "23514" and "responses_output_fixture" in e["detail"])
                require(storage["transaction_outcome"] == "rolled_back" and event["attempted_sequence"] == -1, "failed exposure boundary not proved")
                action = "repair the recorded storage constraint (SQLSTATE " + storage["sqlstate"] + ") and replay accepted output"
            elif event["output_accepted"]:
                interrupted = next(e for e in selected if e["msg"] == "request.output_interrupted" and e.get("request_id") == request_id)
                require(interrupted["cause"] and any(e["msg"] == "request.output_started" for e in selected), "accepted write interruption boundary missing")
                require(event["completed_sequence"] < event["attempted_sequence"] and not any(e["msg"] == "responses.encoded_output" and e["event"] == "response.completed" and e.get("request_id") == request_id for e in selected), "stream completion was already exposed")
                action = "replay accepted response " + event["response_id"] + " without repeating inference or client tools"
            else:
                uncertain = next(e for e in selected if e["msg"] == "recovery.uncertain" and e.get("busy_hold") and e.get("last_boundary") == "claimed_inference")
                claimed = next(e for e in selected if e["msg"] == "job.claimed" and e["job_id"] == uncertain["job_id"])
                causal = next(e for e in selected if e["msg"] in ("job.interrupted", "job.deadline_exceeded", "experiment.cancelled") and e["job_id"] == uncertain["job_id"] and e.get("busy_hold"))
                require(uncertain["automatic_replay"] is False and uncertain["remote_outcome"] == "unknown" and claimed["generation"] == uncertain["generation"] > 0 and claimed["connection_generation"] == uncertain["connection_generation"] > 0, "uncertain assignment generation or no-retry proof missing")
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
            require(candidate.peer.thread.is_alive() and not candidate.peer.errors, "replacement requires healthy fixture peers: " + json.dumps(candidate.peer.errors))
        bot.stop()
        bot.peer.stop()
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
        require(any(e["msg"] == "dispatch.reassigned" for e in events) and any(e["msg"] == "inference.context" and e["context"]["messages"] == messages for e in events), "replacement cannot be reconstructed from logs")
        reassigned = next(e for e in events if e["msg"] == "dispatch.reassigned")
        require(reassigned["expected_worker_id"] != reassigned["observed_worker_id"] and reassigned["reason"] == "offline_before_claim_and_context", "replacement cause missing")
        self.receipt("responses.log_only_diagnosis", request_id=replacement[1]["X-Request-Id"], event="dispatch.reassigned", cause=reassigned["reason"], corrective_action="continue the logged full-history replacement without executing accepted tools again")
        self.receipt("responses.safe_replacement_full_history", client_tool_executions=1, accepted_call_id=call["call_id"], full_context_items=len(messages))

    def deadline_abort_and_storage(self):
        marker = "aaa-chat:hold:responses-deadline"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.response, self.body(marker, True), "responses-deadline")
            bot, job = self.job_for(marker)
            expired = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            self.sql("BEGIN; UPDATE aaa_experiments SET deadline_at='" + expired + "', data=jsonb_set(data::jsonb,'{deadline_at}',to_jsonb('" + expired + "'::text))::json WHERE id='" + job["experiment_id"] + "'; UPDATE aaa_inference_jobs SET data=jsonb_set(data::jsonb,'{deadline_at}',to_jsonb('" + expired + "'::text))::json WHERE id='" + job["id"] + "'; COMMIT;")
            result = pending.result(timeout=12)
        require(self.value(result, failed=True)["error"]["code"] == "deadline_exceeded", "admitted deadline lacked failure lifecycle")
        self.diagnose_response(result[1]["X-Request-Id"], "responses.stream_terminated", "deadline_exceeded")
        require(self.detail_id(job["experiment_id"])["assignment"]["held"], "deadline freed uncertain remote inference")
        bot.peer.acknowledge_idle(job)
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
        bot.peer.acknowledge_idle(job)
        self.until(lambda: self.status(bot.worker)["work_status"] == "idle", "abort hold was not acknowledged")
        marker = "aaa-chat:hold:responses-storage"
        body = self.body(marker, True)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.response, body, "responses-storage")
            bot, job = self.job_for(marker)
            self.sql("ALTER TABLE aaa_model_requests ADD CONSTRAINT responses_output_fixture CHECK(id <> '" + job["experiment_id"] + "' OR data->>'output_started_at' IS NULL);")
            self.decision(bot.worker, bot.peer, job, {"type": "final", "text": "retained-storage-answer"})
            result = pending.result(timeout=12)
        require(result[0] == 503 and not result[1]["Content-Type"].startswith("text/event-stream"), "failed exposure boundary emitted lifecycle")
        self.diagnose_response(result[1]["X-Request-Id"], "responses.stream_terminated", "output_boundary_failed")
        self.sql("ALTER TABLE aaa_model_requests DROP CONSTRAINT responses_output_fixture;")
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
        self.decision(bot.worker, bot.peer, job, {"type": "final", "text": output})
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
            if bot.peer.thread.is_alive():
                bot.peer.stop()
        self.docker("restart", self.main_service)
        self.ready(self.main_service, self.origin_url)
        self.new_bot()
        next_result = self.response(self.body("aaa-chat:echo:after-restart", instructions="after-restart-only", previous_response_id=self.last["id"]))
        require(self.text(next_result) == "after-restart", "restart lost owned response reference")
        bot, job = self.job_for("aaa-chat:echo:after-restart")
        require(job["context"]["messages"][0]["text"] == "after-restart-only" and any(m.get("text") == "aaa-chat:echo:first" for m in job["context"]["messages"]), "restart lost instruction projection or canonical history")
        marker = "aaa-chat:hold:responses-worker-loss"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.response, self.body(marker, True), "responses-worker-loss")
            bot, job = self.job_for(marker)
            bot.stop()
            bot.peer.stop()
            result = pending.result(timeout=12)
        failed = self.value(result, failed=True)
        require(failed["error"]["code"] == "worker_disconnected" and self.detail_id(job["experiment_id"])["assignment"]["held"], "worker loss hid uncertainty")
        self.diagnose_response(result[1]["X-Request-Id"], "responses.stream_terminated", "worker_disconnected")
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
        for _ in range(2):
            h.new_bot()
        h.matrix()
        h.boundaries()
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
