#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import http.client
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

from history import History
from service import require


class DecisionPeer:
    def __init__(self, harness, worker, peer):
        self.h, self.worker, self.peer = harness, worker, peer
        self.stopped = threading.Event()
        self.jobs, self.errors = [], []
        self.seen = {e["data"].get("job_id") for e in peer.events}
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def run(self):
        try:
            while not self.stopped.wait(0.02):
                with self.peer.condition:
                    pending = [e["data"] for e in self.peer.events if e["type"] == "job.available" and e["data"]["job_id"] not in self.seen]
                for available in pending:
                    identity = available["job_id"]
                    self.seen.add(identity)
                    experiment = self.h.experiment(available["experiment_id"])
                    job, _, _ = self.h.claim(self.worker, self.peer, experiment)
                    self.jobs.append(job)
                    messages = job["context"]["messages"]
                    last = messages[-1]
                    user = next((m["text"] for m in reversed(messages) if m.get("role") == "user"), "")
                    if last["type"] == "tool_result":
                        decision = {"type": "final", "text": last["output"]}
                    elif user.startswith("aaa-chat:hold:"):
                        continue
                    elif user.startswith("aaa-chat:tool:"):
                        decision = {"type": "tool_call", "call_id": "call-" + job["id"], "name": "read_file", "arguments": {"path": user[len("aaa-chat:tool:"):]}}
                    elif user.startswith("aaa-chat:delay:"):
                        delay, text = user[len("aaa-chat:delay:"):].split(":", 1)
                        if self.stopped.wait(float(delay)):
                            return
                        decision = {"type": "final", "text": text}
                    elif user.startswith("aaa-chat:echo:"):
                        decision = {"type": "final", "text": user[len("aaa-chat:echo:"):]}
                    else:
                        require(user.startswith("aaa-chat:text:"), "controlled peer received an unsupported test request")
                        decision = {"type": "final", "text": user[len("aaa-chat:text:"):]}
                    self.h.decision(self.worker, self.peer, job, decision)
        except Exception as error:
            self.errors.append(type(error).__name__ + ": " + str(error))

    def stop(self):
        self.stopped.set()
        self.thread.join(timeout=6)
        require(not self.thread.is_alive(), "controlled decision peer did not stop")
        self.h.private("chat-peer-" + self.worker["worker"]["id"] + ".json", json.dumps({"jobs": self.jobs, "errors": self.errors}))
        require(not self.errors, "controlled decision peer failed; inspect private evidence")


class Chat(History):
    def __init__(self, args):
        super().__init__(args)
        self.bots = []

    def new_bot(self):
        worker = self.new_worker()
        peer = self.peer(worker)
        bot = DecisionPeer(self, worker, peer).start()
        self.bots.append(bot)
        return bot

    def chat_body(self, text, stream=False, **fields):
        return {"model": "muse-pool-text", "messages": [{"role": "user", "content": text}], "stream": stream, **fields}

    def chat(self, body, session=None, key=None, origin=None, raw=None, timeout=45):
        target = urllib.parse.urlsplit(origin or self.origin_url)
        connection = http.client.HTTPConnection(target.hostname, target.port, timeout=timeout)
        headers = {"Content-Type": "application/json", "Authorization": "Bearer " + (self.client if key is None else key)}
        if session is not None:
            headers["X-Muse-Session-Id"] = session
        data = raw if raw is not None else json.dumps(body).encode()
        try:
            connection.request("POST", "/v1/chat/completions", data, headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def answer(self, result):
        status, headers, body = result
        require(status == 200, "Chat did not return success: " + str(status))
        if headers["Content-Type"].startswith("text/event-stream"):
            events = [line[6:] for line in body.decode().splitlines() if line.startswith("data: ")]
            require(events[-1] == "[DONE]", "Chat SSE did not terminate")
            values = [json.loads(line) for line in events[:-1]]
            return "".join(v["choices"][0]["delta"].get("content", "") for v in values), values[0]["id"]
        value = json.loads(body)
        return value["choices"][0]["message"]["content"], value["id"]

    def job_for(self, marker):
        selected = []
        def found():
            for bot in self.bots:
                require(not bot.errors, "controlled peer failed")
                for job in bot.jobs:
                    if any(m.get("text") == marker for m in job["context"]["messages"]):
                        selected[:] = [bot, job]
                        return True
            return False
        self.until(found, "Chat request was not claimed", timeout=15)
        return selected

    def detail_id(self, identity):
        return self.checked("/api/v1/admin/requests/" + identity, self.admin)[0]

    def collect_chat_logs(self, filter_name, identity):
        events, sources = [], []
        for index, origin in enumerate(self.origins):
            status, _, raw = self.api("/api/v1/admin/diagnostics/export?" + filter_name + "=" + identity, self.admin, origin=origin)
            require(status == 200, "Chat diagnostic export unavailable")
            metadata, decoded = self.decode_export(raw)
            if not decoded and metadata["omissions"] == ["requested_identity_not_captured_in_interval"]:
                sources.append({"broker": index, "filter": filter_name, "state": "not_observed"})
                continue
            require(metadata["complete"] and decoded, "Chat diagnostic capture incomplete")
            self.assert_private(json.dumps(decoded))
            retained = self.private("chat-export-" + secrets.token_hex(8) + ".ndjson", raw.decode())
            script = "import {readFileSync} from 'node:fs';import {decodeExport} from './tools/qualification-evidence.mjs';const r=decodeExport(readFileSync(process.argv[1],'utf8'));if(!r.metadata.complete)process.exit(1);"
            checked = subprocess.run(["node", "--input-type=module", "-e", script, str(retained)], capture_output=True, text=True, timeout=15)
            require(checked.returncode == 0, "production diagnostic decoder rejected Chat capture")
            sources.append({"broker": index, "filter": filter_name, "state": "complete", "captures": len(decoded)})
            events.extend(decoded)
        require(events, "Chat operation was not observed on any broker")
        return events, sources

    def diagnose_chat(self, request_id, event, cause):
        selected = []
        sources = []
        def finished():
            events, captured = self.collect_chat_logs("request_id", request_id)
            selected[:] = events
            sources[:] = captured
            return any(e["msg"] == event for e in events) and any(e["msg"] == "request.completed" for e in events)
        self.until(finished, "Chat diagnostic outcome was not captured")
        operations = {e["operation_id"] for e in selected if e.get("operation_id")}
        for identity in operations:
            events, captured = self.collect_chat_logs("operation_id", identity)
            selected.extend(events)
            sources.extend(captured)
        matches = [e for e in selected if e["msg"] == event and e.get("request_id") == request_id]
        require(matches, "required Chat failure event missing")
        observed = matches[0]
        require(observed.get("reason", observed.get("cause")) == cause, "Chat logs identify the wrong cause")
        require(observed.get("client_id") == "fixture-client", "Chat diagnostic owner correlation lost")
        evidence = {}
        if cause == "unsupported_parameter":
            require(observed.get("parameter"), "rejection lacks parameter evidence")
            evidence["parameter"] = observed["parameter"]
            action = "remove unsupported parameter " + observed["parameter"]
        elif cause in ("history_prefix_conflict", "tool_result_linkage_conflict"):
            detail = next(e for e in selected if e["msg"] == "history.conflict_detail" and e["reason"] == cause)
            fields = detail["evidence"]
            if cause == "history_prefix_conflict":
                require("position" in fields and "expected_item" in fields and "observed_item" in fields and fields["expected_item"] != fields["observed_item"], "history diagnosis lacks expected/observed prefix")
                evidence["conflicting_position"] = fields["position"]
                action = "resend complete owned history with its observed prefix unchanged"
            else:
                require(fields.get("expected_call_id") and fields.get("observed_call_id") and fields["expected_call_id"] != fields["observed_call_id"], "tool diagnosis lacks exact expected/observed linkage")
                evidence.update({"expected_call_id": fields["expected_call_id"], "observed_call_id": fields["observed_call_id"]})
                action = "return the client result for expected call " + fields["expected_call_id"]
        elif cause == "output_boundary_failed":
            storage = next(e for e in selected if e["msg"] == "inference.operation_failed" and e.get("sqlstate") == "23514")
            detail = next(e for e in selected if e["msg"] == "inference.storage_exchange" and e.get("sqlstate") == "23514")
            require(storage["transaction_outcome"] == "rolled_back" and "chat_output_start_fixture" in detail["detail"] and observed["output_accepted"], "storage diagnosis lacks the causal constraint, rollback or accepted decision")
            evidence.update({"sqlstate": storage["sqlstate"], "transaction_outcome": storage["transaction_outcome"], "output_accepted": True})
            action = "repair the recorded PostgreSQL constraint, then replay the accepted completion in the same session"
        elif cause in ("deadline_exceeded", "worker_disconnected", "request_context_cancelled", "response_write_failed"):
            if observed["output_accepted"]:
                interruption = next(e for e in selected if e["msg"] == "request.output_interrupted")
                accepted = next(e for e in selected if e["msg"] == "decision.accepted")
                require(interruption["cause"] and interruption["outcome"] == "uncertain" and accepted["job_id"] and observed["last_event"] == "role", "delivery diagnosis lacks accepted decision or interrupted write boundary")
                evidence.update({"job_id": accepted["job_id"], "generation": accepted["generation"], "output_accepted": True, "last_event": observed["last_event"], "delivery_outcome": interruption["outcome"]})
                action = "replay the accepted completion in the same session; do not regenerate inference"
            else:
                held = next(e for e in selected if e["msg"] == "recovery.uncertain" and e["reason"] in (cause, "operator_cancelled"))
                require(held["busy_hold"] and held["remote_outcome"] == "unknown" and held["job_id"] and held["worker_id"] and held["generation"] > 0 and held["connection_generation"] > 0 and held["deadline_at"], "uncertain-work diagnosis lacks held assignment authority")
                if cause == "deadline_exceeded":
                    require(any(e["msg"] == "job.deadline_exceeded" and e["job_id"] == held["job_id"] for e in selected), "deadline cause is not in the operation logs")
                evidence.update({"job_id": held["job_id"], "worker_id": held["worker_id"], "generation": held["generation"], "connection_generation": held["connection_generation"], "busy_hold": True, "remote_outcome": "unknown"})
                action = held["corrective_action"]
        else:
            raise AssertionError("unsupported diagnostic conclusion")
        self.private("chat-diagnosis-" + request_id + ".json", json.dumps({"cause": cause, "corrective_action": action, "events": selected}))
        self.receipt("chat.diagnosis." + cause + "." + request_id, request_id=request_id, operation_ids=sorted(operations), client_id=observed["client_id"], cause=cause, corrective_action=action, captures_complete=True, capture_sources=sources, evidence=evidence)
        return selected

    def sdk_matrix(self):
        fixture = self.private("chat-client-only.txt", "client-only-" + secrets.token_hex(32) + "\r\nexact 😀\n")
        receipt = self.root / "sdk-conformance.json"
        result = subprocess.run(["node", "tools/openai-conformance.mjs", "--base-url", self.origin_url + "/v1", "--fixture", str(fixture), "--receipt", str(receipt)],
                                env={**os.environ, "MUSE_CHAT_CLIENT_KEY": self.client}, capture_output=True, text=True, timeout=180)
        self.private("chat-runner.log", result.stdout + result.stderr)
        require(result.returncode == 0, "OpenAI conformance runner failed; inspect private runner log")
        value = json.loads(receipt.read_text())
        require(value["sdk_version"] == "7.53.0" and len(value["receipts"]) == 9 and not value["qualifies_live_muse"], "SDK receipt incomplete")
        self.assert_private(json.dumps(value))
        for case in value["receipts"]:
            self.receipt(case["case"], **{k: v for k, v in case.items() if k not in ("case", "outcome")})

    def boundaries(self):
        worker = self.bots[0].worker
        for key in ("", self.admin, self.portal, worker["credential"]):
            status, _, raw = self.chat(self.chat_body("x"), key=key)
            require(status == 401 and json.loads(raw)["error"]["type"] == "authentication_error", "wrong authority admitted to Chat")
        bad = [self.chat_body("x", **{name: value}) for name, value in (("temperature", 1), ("store", False), ("n", 2), ("parallel_tool_calls", True), ("tool_choice", "required"), ("stream_options", {"include_usage": True}), ("response_format", {"type": "json_object"}))]
        bad += [self.chat_body("x", messages=[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.test/image"}}]}]),
                self.chat_body("x", tools=[{"type": "custom", "custom": {"name": "f"}}]),
                self.chat_body("x", tools=[{"type": "function", "function": {"name": "f", "parameters": {"$ref": "https://example.test/schema"}}}]),
                self.chat_body("x", messages=[{"role": "assistant", "content": None, "tool_calls": [{}, {}]}])]
        for body in bad:
            for stream in (False, True):
                body["stream"] = stream
                status, headers, raw = self.chat(body)
                error = json.loads(raw)["error"]
                require(status == 400 and error["param"] and error["type"] == "invalid_request_error", "unsupported option silently accepted")
        status, headers, _ = self.chat(bad[0])
        self.diagnose_chat(headers["X-Request-Id"], "chat.request_rejected", "unsupported_parameter")
        for raw, status in ((b'{"model":"muse-pool-text","model":"other"}', 400), (b'{"model":"muse-pool-text","messages":[{"role":"user","content":"x","content":"y"}]}', 400), (b'\xff', 400), (b'x' * 1048577, 413)):
            observed, _, body = self.chat(None, raw=raw)
            require(observed == status and isinstance(json.loads(body)["error"], dict), "invalid body escaped OpenAI error handling")
        for path, method, body, status in (("/v1/models", "POST", b"{}", 405), ("/v1/models", "GET", b"x", 400), ("/v1/models?unknown=1", "GET", None, 400)):
            observed, _, raw = self.request(self.origin_url, path, self.client, method, body)
            require(observed == status and isinstance(json.loads(raw)["error"], dict), "early boundary returned native error shape")
        self.receipt("chat.authentication_and_strict_subset", rejected_cases=len(bad) * 2 + 11, body_limit=1048576)

    def sessions(self, second_origin):
        session = "chat-owned-session"
        initial = self.chat_body("aaa-chat:text:owner-A-only")
        first = self.chat(initial, session)
        answer, identity = self.answer(first)
        require(answer == "owner-A-only", "wrong owner A answer")
        a = self.detail_id(identity.removeprefix("chatcmpl-"))["request"]
        followup = self.chat_body("unused", messages=initial["messages"] + [{"role": "assistant", "content": answer}, {"role": "user", "content": "aaa-chat:text:A-next"}])
        later = self.chat(followup, session, origin=second_origin)
        text, later_id = self.answer(later)
        b = self.detail_id(later_id.removeprefix("chatcmpl-"))["request"]
        require(text == "A-next" and a["conversation_id"] == b["conversation_id"] and a["worker_id"] == b["worker_id"], "session lost history, correlation or healthy worker pin")
        with ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(lambda key: self.chat(initial, session, key=key), [self.client, self.other_client]))
        require(self.answer(values[0])[1] == identity, "exact owned replay created another decision")
        other_id = self.answer(values[1])[1].removeprefix("chatcmpl-")
        require(self.detail_id(other_id)["request"]["conversation_id"] != a["conversation_id"], "same session string crossed owners")
        wrong = {**followup, "messages": [{"role": "user", "content": "changed prefix"}] + followup["messages"][1:] + [{"role": "assistant", "content": text}, {"role": "user", "content": "aaa-chat:text:conflict-next"}]}
        status, headers, _ = self.chat(wrong, session)
        require(status == 409, "conflicting full history admitted")
        self.diagnose_chat(headers["X-Request-Id"], "chat.history_conflict", "history_prefix_conflict")
        uncorrelated = [self.chat(self.chat_body("aaa-chat:text:independent")) for _ in range(2)]
        require(uncorrelated[0][1]["X-Muse-Session-Id"] != uncorrelated[1][1]["X-Muse-Session-Id"], "uncorrelated requests were joined by text")
        marker = "aaa-chat:hold:serialization"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.chat, self.chat_body(marker), "serialized")
            bot, job = self.job_for(marker)
            status, _, _ = self.chat(self.chat_body("different"), "serialized", origin=second_origin)
            require(status == 409, "overlapping session turn admitted")
            self.decision(bot.worker, bot.peer, job, {"type": "final", "text": "one turn"})
            self.answer(pending.result(timeout=10))
        self.receipt("chat.owned_affinity_serialization_and_independence", broker_processes=2, distinct_owners=True, healthy_pin_preserved=True)

    def simultaneous_sessions(self, second_origin):
        fixtures = [self.private("parallel-" + label + ".txt", label + "-private-" + secrets.token_hex(24) + "\r\n") for label in ("A", "B")]
        bodies = []
        for index, label in enumerate(("A", "B")):
            tools = [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string", "const": str(fixtures[index])}}, "required": ["path"], "additionalProperties": False}}}]
            bodies.append(self.chat_body("unused", tools=tools, messages=[{"role": "system", "content": "parallel-owner-" + label}, {"role": "user", "content": "aaa-chat:hold:parallel-" + label}]))
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(self.chat, body, "parallel-" + label, origin=origin) for body, label, origin in zip(bodies, ("A", "B"), (self.origin_url, second_origin))]
            assignments = [self.job_for("aaa-chat:hold:parallel-" + label) for label in ("A", "B")]
            require(assignments[0][1]["worker_id"] != assignments[1][1]["worker_id"], "simultaneous sessions did not use independent workers")
            for index, (bot, job) in enumerate(assignments):
                other = "B" if index == 0 else "A"
                require("parallel-owner-" + other not in json.dumps(job["context"]), "simultaneous initial context crossed sessions")
                self.decision(bot.worker, bot.peer, job, {"type": "tool_call", "call_id": "parallel-call-" + str(index), "name": "read_file", "arguments": {"path": str(fixtures[index])}})
            first = [future.result(timeout=12) for future in pending]
        messages = [json.loads(result[2])["choices"][0]["message"] for result in first]
        results = [path.read_bytes().decode() for path in fixtures]
        continuations = []
        for index in range(2):
            continuations.append({**bodies[index], "stream": True, "messages": bodies[index]["messages"] + [messages[index], {"role": "tool", "tool_call_id": messages[index]["tool_calls"][0]["id"], "content": results[index]}]})
        wrong = {**continuations[0], "messages": continuations[0]["messages"][:-1] + [{"role": "tool", "tool_call_id": messages[1]["tool_calls"][0]["id"], "content": results[1]}]}
        status, headers, _ = self.chat(wrong, "parallel-A")
        require(status == 409, "simultaneous session accepted the other session's tool result")
        self.diagnose_chat(headers["X-Request-Id"], "chat.history_conflict", "tool_result_linkage_conflict")
        with ThreadPoolExecutor(max_workers=2) as pool:
            completed = list(pool.map(lambda entry: self.chat(entry[0], entry[1]), zip(continuations, ("parallel-A", "parallel-B"))))
        for index, completed_result in enumerate(completed):
            require(self.answer(completed_result)[0] == results[index], "simultaneous session returned another result")
            conversation = assignments[index][1]["conversation_id"]
            jobs = [job for bot in self.bots for job in bot.jobs if job["conversation_id"] == conversation]
            require(len(jobs) == 2 and jobs[0]["worker_id"] == jobs[1]["worker_id"], "simultaneous continuation duplicated inference or lost affinity")
            context = jobs[-1]["context"]["messages"]
            require(context[-2]["call_id"] == messages[index]["tool_calls"][0]["id"] and context[-1]["output"] == results[index], "delivered continuation lost exact call/result linkage")
            require(results[1 - index] not in json.dumps(context) and messages[1 - index]["tool_calls"][0]["id"] not in json.dumps(context), "simultaneous canonical histories mixed")
        self.receipt("chat.simultaneous_sessions_and_tool_linkage", sessions=2, workers=2, client_tool_executions=2, isolated_contexts=True)

    def linkage_and_capture(self):
        tools = [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}}}]
        badcall = {"role": "assistant", "content": None, "tool_calls": [{"id": "call-test", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":7}"}}]}
        for stream in (False, True):
            invalid = self.chat_body("unused", stream, tools=tools, messages=[badcall, {"role": "tool", "tool_call_id": "call-test", "content": "x"}])
            status, _, raw = self.chat(invalid)
            require(status == 400 and json.loads(raw)["error"]["code"] == "invalid_tool_arguments", "invalid argument schema accepted")
            badcall["tool_calls"][0]["function"]["arguments"] = '{"path":"client-only"}'
            invalid["messages"][1]["tool_call_id"] = "foreign-call"
            status, headers, raw = self.chat(invalid)
            require(status == 409 and json.loads(raw)["error"]["code"] == "tool_result_linkage_conflict", "foreign tool result linked")
            self.diagnose_chat(headers["X-Request-Id"], "chat.history_conflict", "tool_result_linkage_conflict")
            badcall["tool_calls"][0]["function"]["arguments"] = '{"path":7}'
        secret_text = " ".join([self.admin, self.portal, self.client, self.other_client, self.bots[0].worker["credential"]])
        result = self.chat(self.chat_body("aaa-chat:echo:" + secret_text, True), "redaction")
        require(self.answer(result)[0] == secret_text, "model output changed while redacting diagnostics")
        events = self.retained_export("request_id", result[1]["X-Request-Id"])
        for name in ("chat.input", "chat.normalized_input", "chat.accepted_decision", "chat.encoded_output"):
            require(any(e["msg"] == name and "[REDACTED]" in json.dumps(e) for e in events), "protected complete diagnostic missing: " + name)
        output = self.logs(self.main_service)
        self.assert_private(output)
        require('"msg":"chat.encoded_output"' not in output and '"msg":"chat.normalized_input"' not in output, "DEBUG content reached INFO stdout")
        self.receipt("chat.schema_linkage_and_protected_capture", debug_at_info=True, full_input_output_capture=True, credential_protection=True)

    def long_responses(self):
        for stream in (False, True):
            start = time.monotonic()
            result = self.chat(self.chat_body("aaa-chat:delay:31:delayed-answer", stream), "delayed-" + str(stream))
            require(self.answer(result)[0] == "delayed-answer" and time.monotonic() - start >= 31, "default 30-second write timeout broke Chat")
        self.receipt("chat.response_after_default_write_timeout", delay_seconds=31, both_stream_settings=True)

    def abort_and_deadline(self):
        for stream in (False, True):
            marker = "aaa-chat:hold:abort-" + str(stream)
            target = urllib.parse.urlsplit(self.origin_url)
            connection = socket.create_connection((target.hostname, target.port), timeout=10)
            body = json.dumps(self.chat_body(marker, stream)).encode()
            connection.sendall(("POST /v1/chat/completions HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer " + self.client + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)) + "\r\nX-Muse-Session-Id: abort-" + str(stream) + "\r\n\r\n").encode() + body)
            bot, job = self.job_for(marker)
            connection.shutdown(socket.SHUT_RDWR)
            connection.close()
            self.until(lambda: self.detail_id(job["experiment_id"])["request"]["state"] == "cancelled", "client abort did not cancel owned work")
            detail = self.detail_id(job["experiment_id"])
            require(detail["assignment"]["held"], "client disconnect falsely freed remote inference")
            terminal = []
            def terminated():
                events, _ = self.collect_chat_logs("operation_id", job["experiment_id"])
                terminal[:] = [e for e in events if e["msg"] == ("chat.stream_terminated" if stream else "chat.request_terminated")]
                return bool(terminal)
            self.until(terminated, "abort termination evidence missing")
            require(terminal[0]["level"] == "INFO", "client abort has wrong diagnostic level")
            self.diagnose_chat(terminal[0]["request_id"], terminal[0]["msg"], "request_context_cancelled")
            bot.peer.acknowledge_idle(job)
            marker = "aaa-chat:hold:deadline-" + str(stream)
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.chat, self.chat_body(marker, stream), "deadline-" + str(stream))
                bot, job = self.job_for(marker)
                expired = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
                self.sql("BEGIN; UPDATE aaa_experiments SET deadline_at='" + expired + "', data=jsonb_set(data::jsonb,'{deadline_at}',to_jsonb('" + expired + "'::text))::json WHERE id='" + job["experiment_id"] + "'; UPDATE aaa_inference_jobs SET data=jsonb_set(data::jsonb,'{deadline_at}',to_jsonb('" + expired + "'::text))::json WHERE id='" + job["id"] + "'; COMMIT;")
                status, headers, raw = pending.result(timeout=12)
            require(status == 504 and json.loads(raw)["error"]["code"] == "deadline_exceeded", "deadline did not produce explicit OpenAI error")
            self.diagnose_chat(headers["X-Request-Id"], "chat.stream_terminated" if stream else "chat.request_terminated", "deadline_exceeded")
            require(self.detail_id(job["experiment_id"])["assignment"]["held"], "deadline dropped uncertain busy hold")
            bot.peer.acknowledge_idle(job)
        self.receipt("chat.abort_and_native_deadline", both_stream_settings=True, fixture_deadline_advanced=True, uncertain_holds_preserved=True)

    def output_boundary_fault(self):
        for stream in (False, True):
            marker = "aaa-chat:hold:boundary-" + str(stream)
            body = self.chat_body(marker, stream)
            session = "boundary-" + str(stream)
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.chat, body, session)
                bot, job = self.job_for(marker)
                constraint = "chat_output_start_fixture"
                self.sql("ALTER TABLE aaa_model_requests ADD CONSTRAINT " + constraint + " CHECK(id <> '" + job["experiment_id"] + "' OR data->>'output_started_at' IS NULL);")
                self.decision(bot.worker, bot.peer, job, {"type": "final", "text": "retained accepted answer"})
                status, headers, raw = pending.result(timeout=12)
            require(status == 503 and isinstance(json.loads(raw)["error"], dict), "failed boundary exposed output")
            events = self.diagnose_chat(headers["X-Request-Id"], "chat.stream_terminated" if stream else "chat.request_terminated", "output_boundary_failed")
            require(any(e["msg"] == "inference.storage_exchange" and constraint in e["detail"] for e in events), "logs lack causal storage detail")
            self.sql("ALTER TABLE aaa_model_requests DROP CONSTRAINT " + constraint + ";")
            replay = self.chat(body, session)
            require(self.answer(replay)[0] == "retained accepted answer" and self.answer(replay)[1] == "chatcmpl-" + job["experiment_id"], "boundary retry regenerated accepted work")
        self.receipt("chat.output_boundary_failure_and_exact_replay", sqlstate="23514", log_only_diagnosis=True, no_inference_retry=True)

    def interrupted_delivery(self):
        marker = "aaa-chat:hold:interrupted-delivery"
        body = self.chat_body(marker, True)
        data = json.dumps(body).encode()
        target = urllib.parse.urlsplit(self.origin_url)
        connection = socket.create_connection((target.hostname, target.port), timeout=15)
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        headers = "POST /v1/chat/completions HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer " + self.client + "\r\nContent-Type: application/json\r\nContent-Length: " + str(len(data)) + "\r\nX-Muse-Session-Id: interrupted-delivery\r\n\r\n"
        connection.sendall(headers.encode() + data)
        bot, job = self.job_for(marker)
        received, failures = [], []
        ready = threading.Event()
        def interrupt():
            wire = b""
            try:
                ready.set()
                while b'"role":"assistant"' not in wire:
                    part = connection.recv(1024)
                    require(part and len(wire) < 16384, "role frame missing before controlled delivery interruption")
                    wire += part
                received.append(wire)
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except Exception as error:
                failures.append(type(error).__name__)
            finally:
                connection.close()
        reader = threading.Thread(target=interrupt, daemon=True)
        reader.start()
        require(ready.wait(2), "delivery interruption reader did not start")
        output = "x" * (768 * 1024)
        self.decision(bot.worker, bot.peer, job, {"type": "final", "text": output})
        reader.join(timeout=20)
        require(not reader.is_alive() and received and not failures, "controlled delivery interruption failed")
        require(b"[DONE]" not in received[0], "interruption happened after successful stream termination")
        terminal = []
        def terminated():
            events, _ = self.collect_chat_logs("operation_id", job["experiment_id"])
            terminal[:] = [e for e in events if e["msg"] == "chat.stream_terminated"]
            return bool(terminal)
        self.until(terminated, "interrupted delivery termination missing")
        require(terminal[0]["cause"] in ("request_context_cancelled", "response_write_failed") and terminal[0]["output_accepted"] and terminal[0]["last_event"] == "role", "accepted delivery interruption not observed")
        self.diagnose_chat(terminal[0]["request_id"], "chat.stream_terminated", terminal[0]["cause"])
        saved = self.detail_id(job["experiment_id"])["request"]
        require(saved["state"] == "completed" and "output_started_at" in saved and "output_completed_at" not in saved, "failed delivery claimed completion or discarded decision")
        replay = self.chat(body, "interrupted-delivery")
        require(self.answer(replay) == (output, "chatcmpl-" + job["experiment_id"]), "interrupted delivery did not replay accepted output")
        require(sum(j["experiment_id"] == job["experiment_id"] for b in self.bots for j in b.jobs) == 1, "interrupted delivery regenerated inference")
        self.receipt("chat.interrupted_delivery_and_accepted_replay", payload_bytes=len(output), last_event="role", output_delivery_uncertain=True, inference_executions=1)

    def disconnected_worker(self):
        marker = "aaa-chat:hold:worker-loss"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.chat, self.chat_body(marker, True), "lost-worker")
            bot, job = self.job_for(marker)
            bot.stop()
            bot.peer.stop()
            status, headers, raw = pending.result(timeout=12)
        require(status == 503 and json.loads(raw)["error"]["code"] == "worker_disconnected", "worker loss was hidden or retried")
        self.diagnose_chat(headers["X-Request-Id"], "chat.stream_terminated", "worker_disconnected")
        detail = self.detail_id(job["experiment_id"])
        require(detail["request"]["state"] == "interrupted" and detail["assignment"]["held"], "worker loss erased uncertainty")
        require(sum(j["experiment_id"] == job["experiment_id"] for b in self.bots for j in b.jobs) == 1, "worker loss launched overlapping inference")
        self.receipt("chat.conservative_claimed_worker_failure", no_automatic_retry=True, busy_hold_retained=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = Chat(args)
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
        h.sdk_matrix()
        h.boundaries()
        h.sessions(other_origin)
        h.simultaneous_sessions(other_origin)
        h.linkage_and_capture()
        h.long_responses()
        h.abort_and_deadline()
        h.output_boundary_fault()
        h.disconnected_worker()
        h.interrupted_delivery()
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
            if peer.thread.is_alive():
                try:
                    peer.stop()
                except Exception as error:
                    failures.append(type(error).__name__)
        h.cleanup()
        source = subprocess.run(["node", "--input-type=module", "-e", "import {inspectSource} from './tools/source-inventory.mjs'; console.log(JSON.stringify(inspectSource().identity));"], capture_output=True, text=True, timeout=15)
        require(source.returncode == 0, "Chat source receipt missing")
        safe = {"suite": "openai-chat", "outcome": outcome, "source": json.loads(source.stdout), "sdk_version": "7.53.0", "controlled_peer": True, "qualifies_live_muse": False, "receipts": h.receipts, "cleanup": json.loads((h.root / "cleanup.json").read_text()), "peer_cleanup_failures": failures}
        h.assert_private(json.dumps(safe))
        target = Path(".artifacts/ci/openai")
        target.mkdir(parents=True, exist_ok=True)
        (target / "receipt.json").write_text(json.dumps(safe, indent=2) + "\n")
        require(not failures, "Chat peer cleanup failed")


if __name__ == "__main__":
    main()
