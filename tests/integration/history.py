#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import secrets
import subprocess
import urllib.parse

from inference import Inference
from service import require


class History(Inference):
    def __init__(self, args):
        super().__init__(args)
        self.other_client = "test-other-client-" + secrets.token_hex(24)
        self.secrets.append(self.other_client)

    def configuration(self, generated=False):
        config = super().configuration(generated)
        config["client-keys"]["other-client"] = self.other_client
        config["limits"] = {"max-jobs": 16, "in-flight-per-worker": 1}
        return config

    def peer(self, worker, reply=True, qualify=True):
        peer = super().peer(worker, reply)
        if reply and qualify:
            self.qualify_worker(worker, peer)
        return peer

    def qualify_worker(self, worker, peer, tools=True):
        challenge = "ready-" + secrets.token_hex(24)
        ready = self.create(worker, challenge, tools=False, messages=[{"type": "message", "role": "user", "text": challenge}])
        job, _, _ = self.claim(worker, peer, ready)
        self.decision(worker, peer, job, {"type": "final", "text": challenge})
        body = {"protocol_version": 1, "submission_id": secrets.token_hex(12), "action": "approve", "evidence_kind": "controlled",
                "evidence_reference": "controlled authenticated software peer; not a live Muse qualification", "readiness_experiment_id": ready["id"]}
        if tools:
            contents = "client-only-" + secrets.token_hex(24) + "\r\nexact\n"
            fixture = self.private("qualification-client-" + secrets.token_hex(6) + ".txt", contents)
            trial = self.create(worker, "Read the client-only fixture")
            job, _, _ = self.claim(worker, peer, trial)
            call_id = "call-" + secrets.token_hex(12)
            self.decision(worker, peer, job, {"type": "tool_call", "call_id": call_id, "name": "read_file", "arguments": {"path": str(fixture)}})
            continuation, _ = self.checked("/api/v1/admin/experiments/" + trial["id"] + "/tool-results", self.admin, "POST",
                                           {"protocol_version": 1, "submission_id": secrets.token_hex(12), "call_id": call_id, "output": fixture.read_bytes().decode()}, want=202)
            job, _, _ = self.claim(worker, peer, continuation)
            self.decision(worker, peer, job, {"type": "final", "text": contents})
            body["tool_experiment_id"] = trial["id"]
        approval, _ = self.checked("/api/v1/admin/workers/" + worker["worker"]["id"] + "/qualifications", self.admin, "POST", body)
        require(approval["evidence"]["evidence_kind"] == "controlled" and approval["connection_generation"] == peer.opened["connection_generation"], "qualification provenance or generation lost")
        return approval, body

    def retained_export(self, filter_name, identity):
        status, _, raw = self.api("/api/v1/admin/diagnostics/export?" + filter_name + "=" + identity, self.admin)
        require(status == 200, "diagnostic export unavailable")
        label = filter_name + "-" + identity + "-" + secrets.token_hex(4)
        path = self.private(label + ".ndjson", raw.decode())
        script = "import {readFileSync} from 'node:fs'; import {decodeExport} from './tools/qualification-evidence.mjs'; const result=decodeExport(readFileSync(process.argv[1],'utf8')); console.log(JSON.stringify({complete:result.metadata.complete,events:result.events.length}));"
        decoded = subprocess.run(["node", "--input-type=module", "-e", script, str(path)], capture_output=True, text=True, timeout=20)
        if decoded.returncode:
            self.private(label + "-decoder-error.txt", decoded.stderr)
        require(decoded.returncode == 0 and json.loads(decoded.stdout)["complete"], "production decodeExport rejected diagnostic capture")
        metadata, events = self.decode_export(raw)
        require(metadata["complete"] and events, "diagnostic evidence incomplete")
        require(all(event.get(filter_name) == identity for event in events), "diagnostic export crossed its filter")
        self.assert_private(json.dumps(events))
        self.private(label + ".json", json.dumps({"metadata": metadata, "events": events}))
        return events

    def export_operation(self, identity):
        return self.retained_export("operation_id", identity)

    def diagnose_history(self, request_id, event_name, reason=None):
        requested = self.retained_export("request_id", request_id)
        require(any(event["msg"] == "request.exchange" and event["level"] == "DEBUG" for event in requested), "request exchange missing from protected capture")
        require(any(event["msg"] == "request.completed" for event in requested), "request outcome missing")
        operation_ids = {event["operation_id"] for event in requested if event.get("operation_id")}
        combined = list(requested)
        for identity in sorted(operation_ids):
            combined.extend(self.export_operation(identity))
        unique = {json.dumps(event, sort_keys=True): event for event in combined}
        events = list(unique.values())
        matches = [event for event in requested if event["msg"] == event_name]
        if not matches:
            matches = [event for event in events if event["msg"] == event_name]
        require(len(matches) == 1, "required diagnostic event missing or ambiguous: " + event_name)
        event = matches[0]
        cause = event.get("reason", event.get("cause"))
        if reason is not None:
            require(cause == reason, "diagnostic cause differs")
        actions = {"tool_result_linkage_conflict": "return the exact result for the expected accepted call",
                   "history_prefix_conflict": "resend the owned full history without changing its prefix",
                   "history_shortened_or_no_new_input": "resend the complete owned history and new input",
                   "history_owner_denied": "use the correct client credential; do not probe another owner",
                   "submission_conflict": "retry with the original submission correlation",
                   "deadline_exceeded": "inspect the last worker boundary; retain uncertainty and await the matching idle acknowledgement"}
        if event_name == "inference.operation_failed":
            detail = next((entry for entry in events if entry.get("request_id") == request_id and entry["msg"] == "inference.storage_exchange"), None)
            require(detail is not None and detail["sqlstate"] == "23514" and detail["transaction_outcome"] == "rolled_back" and "history_output_" in detail["detail"], "storage cause cannot be reconstructed from logs")
            action = "repair the rejecting database constraint; preserve any exposed decision and retry reading without regenerating"
        else:
            action = actions.get(cause)
            require(action is not None, "diagnostic corrective action is undefined")
        if event_name == "job.deadline_exceeded":
            require(any(entry["msg"] == "job.claimed" for entry in events), "deadline last assignment boundary missing")
        self.private("diagnosis-" + request_id + ".json", json.dumps({"cause": cause, "corrective_action": action, "operation_ids": sorted(operation_ids), "operation_not_admitted": not operation_ids, "events": events}))
        self.receipt("history.diagnostic_reconstruction", request_id=request_id, related_operations=len(operation_ids), expected_event=event_name, cause=cause, corrective_action=action)
        return event, events

    def native(self, method, path, body=None, session=None, key=None, want=200, origin=None):
        headers = {} if session is None else {"X-Muse-Session-Id": session}
        status, response_headers, raw = self.api(path, self.client if key is None else key, method, body, origin=origin, headers=headers)
        require(status == want, "native HTTP status differs: " + method + " " + path + " " + str(status))
        return json.loads(raw), response_headers

    def input(self, worker, messages=None, tools=None, submission=None, previous=None, timeout=300):
        value = {"protocol_version": 1, "submission_id": submission or secrets.token_hex(12), "worker_id": worker["worker"]["id"],
                 "messages": messages if messages is not None else [{"type": "message", "role": "system", "text": "Preserve exact client values.\r\n"}, {"type": "message", "role": "user", "text": "Read the client-only fixture"}],
                 "tools": tools if tools is not None else [{"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "number": {"type": "integer"}}, "required": ["path"], "additionalProperties": False}}],
                 "timeout_seconds": timeout}
        if previous is not None:
            value["previous_response_id"] = previous
        return value

    def submit(self, body, session=None, key=None, want=202, origin=None):
        return self.native("POST", "/api/v1/requests", body, session, key, want, origin)

    def read_native(self, request, key=None, session=None, want=200):
        return self.native("GET", "/api/v1/requests/" + request["id"], session=session, key=key, want=want)

    def detail(self, request):
        return self.checked("/api/v1/admin/requests/" + request["id"], self.admin)[0]

    def deliver(self, worker, peer, request, decision):
        experiment = self.experiment(request["id"])
        job, _, _ = self.claim(worker, peer, experiment)
        self.decision(worker, peer, job, decision)
        return job

    def timeline(self, conversation, limit=100):
        items, cursor = [], None
        while True:
            query = {"limit": limit}
            if cursor:
                query["cursor"] = cursor
            page, _ = self.checked("/api/v1/admin/conversations/" + conversation + "/timeline?" + urllib.parse.urlencode(query), self.admin)
            items.extend(page["items"])
            cursor = page.get("next_cursor")
            if not cursor:
                break
        require(len({item["sequence"] for item in items}) == len(items), "timeline pagination duplicated sequences")
        return items

    def tool_history(self, worker, peer):
        fixture_value = "client-only-" + secrets.token_hex(24) + "\r\nsecond line\n"
        fixture = self.private("history-client-only.txt", fixture_value)
        initial = self.input(worker)
        initial["messages"][0]["text"] = "history-only-private-" + secrets.token_hex(12) + "\r\n"
        a, headers = self.submit(initial, "session-A")
        require(headers["X-Muse-Session-Id"] == "session-A" and "output" not in a, "admission exposed output or lost session")
        tool = {"type": "tool_call", "call_id": "call-" + secrets.token_hex(10), "name": "read_file", "arguments": {"path": str(fixture), "number": 9007199254740993}}
        original_job = self.deliver(worker, peer, a, tool)
        observed, _ = self.read_native(a)
        require(observed["state"] == "completed" and observed["output"] == tool, "tool decision or integer changed")
        require(self.status(worker)["work_status"] == "idle" and self.status(worker)["waiting_for_client_tool"] == 1, "native tool wait confused with busy inference")
        b_messages = [{"type": "message", "role": "user", "text": "interleaved-B-only-" + secrets.token_hex(12)}]
        b, _ = self.submit(self.input(worker, b_messages, tools=[]), "interleaved-B")
        b_job = self.deliver(worker, peer, b, {"type": "final", "text": "B-only-answer"})
        self.read_native(b)
        require(b_job["context"]["messages"] == b_messages, "A history crossed into interleaved B delivery")
        replay, _ = self.submit({**initial, "submission_id": secrets.token_hex(12)}, "session-A")
        require(replay["id"] == a["id"], "semantic request replay created work")
        exact, _ = self.submit(initial, "session-A")
        require(exact["id"] == a["id"], "submission receipt did not replay")
        wrong = self.input(worker, initial["messages"] + [tool, {"type": "tool_result", "call_id": "wrong", "output": "wrong"}], tools=[])
        _, bad_headers = self.submit(wrong, "session-A", want=409)
        event, events = self.diagnose_history(bad_headers["X-Request-Id"], "history.conflict", "tool_result_linkage_conflict")
        require(event["evidence"]["expected_call_id"] == tool["call_id"] and any(e["msg"] == "history.input" for e in events), "linkage cause/input unavailable in logs")
        result = {"type": "tool_result", "call_id": tool["call_id"], "output": fixture.read_bytes().decode()}
        continued_input = self.input(worker, initial["messages"] + [tool, result], tools=[], previous=a["response_id"])
        continued, headers = self.submit(continued_input)
        require(continued["conversation_id"] == a["conversation_id"] and headers["X-Muse-Session-Id"] == "session-A", "response continuation lost owned session")
        job = self.deliver(worker, peer, continued, {"type": "final", "text": fixture_value})
        require(job["context"]["messages"] == continued_input["messages"] and job["context"]["tools"] == [], "full context or current tool snapshot changed")
        require(b_messages[0]["text"] not in json.dumps(job["context"]), "B history crossed into A continuation")
        final, _ = self.read_native(continued)
        require(final["output"]["text"] == fixture_value, "exact result bytes changed")
        self.checked("/api/v1/worker/jobs/" + original_job["id"], worker["credential"])
        original = self.detail(a)
        require(original["delivery"]["messages"] == initial["messages"] and original["delivery"]["tools"] == initial["tools"], "old delivery snapshot rewritten")
        canonical = continued_input["messages"] + [{"type": "message", "role": "assistant", "text": fixture_value}]
        conflicting = self.input(worker, [*canonical, {"type": "message", "role": "user", "text": "next"}], tools=[])
        conflicting["messages"][0] = {"type": "message", "role": "system", "text": "changed prefix"}
        _, conflict_headers = self.submit(conflicting, "session-A", want=409)
        _, conflict_events = self.diagnose_history(conflict_headers["X-Request-Id"], "history.conflict", "history_prefix_conflict")
        require(any(event["msg"] == "history.conflict_detail" and "history-only-private-" in json.dumps(event) for event in conflict_events), "protected expected/observed history missing")
        next_input = self.input(worker, canonical + [{"type": "message", "role": "user", "text": "A later turn"}], tools=[])
        later, _ = self.submit(next_input, "session-A")
        self.deliver(worker, peer, later, {"type": "final", "text": "later-answer"})
        self.read_native(later)
        canonical += [{"type": "message", "role": "user", "text": "A later turn"}, {"type": "message", "role": "assistant", "text": "later-answer"}]
        events = self.timeline(a["conversation_id"], 2)
        items = [e["item"] for e in events if e.get("item") is not None]
        require([item["item"] for item in items] == canonical and len({item["id"] for item in items}) == len(canonical), "canonical timeline lost/duplicated items")
        require([item["source"] for item in items] == ["client_provided", "client_provided", "server_observed", "client_provided", "server_observed", "client_provided", "server_observed"], "canonical provenance incorrect")
        require(any(e["kind"] == "history.tools" for e in events) and any(e["kind"] == "job.claimed" and e["details"]["generation"] > 0 for e in events), "timeline lost tool snapshot or assignment")
        b_items = [event["item"]["item"] for event in self.timeline(b["conversation_id"], 1) if event.get("item") is not None]
        require(b_items == b_messages + [{"type": "message", "role": "assistant", "text": "B-only-answer"}] and tool["call_id"] not in json.dumps(b_items), "interleaved B timeline crossed A tool linkage")
        detail = self.detail(continued)["request"]
        for field in ("context_delivery_started_at", "context_delivery_written_at", "decision_accepted_at", "output_started_at", "output_completed_at"):
            require(field in detail, "missing durable request boundary: " + field)
        self.export_operation(continued["id"])
        self.receipt("history.exact_tool_loop_replay_snapshots", conversation=a["conversation_id"], canonical_items=len(items), client_tool_executions=1, synthetic_peer=True)
        return a, initial, canonical

    def owners_and_invalid_inputs(self, worker, peer, first, initial):
        self.read_native(first, key=self.other_client, want=404)
        self.native("GET", "/api/v1/requests/" + secrets.token_hex(16), key=self.other_client, want=404)
        foreign = self.input(worker, previous=first["response_id"])
        _, headers = self.submit(foreign, key=self.other_client, want=404)
        event, events = self.diagnose_history(headers["X-Request-Id"], "history.owner_denied", "history_owner_denied")
        require(event["client_id"] == "other-client" and "expected_history" not in json.dumps(events), "owner denial leaked another history")
        self.submit(foreign, "different-session", want=409)
        second, _ = self.submit(self.input(worker, tools=[]), "session-A", key=self.other_client)
        require(second["conversation_id"] != first["conversation_id"], "identical session strings crossed clients")
        self.deliver(worker, peer, second, {"type": "final", "text": "other-owner"})
        no_header = self.input(worker, tools=[])
        a, headers = self.submit(no_header)
        repeat, repeated_headers = self.submit(no_header)
        b, _ = self.submit({**no_header, "submission_id": secrets.token_hex(12)})
        require(repeat["id"] == a["id"] and repeated_headers["X-Muse-Session-Id"] == headers["X-Muse-Session-Id"], "uncorrelated exact retry changed identity")
        require(a["conversation_id"] != b["conversation_id"], "text similarity joined uncorrelated requests")
        self.submit(initial, "changed-submission-correlation", want=409)
        self.native("POST", "/api/v1/requests/" + a["id"] + "/cancel", {"protocol_version": 1, "submission_id": "wrong-header"}, "wrong", want=409)
        read, _ = self.read_native(a)
        require(read["state"] == "queued", "wrong session header cancelled request")
        for request in (a, b):
            cancellation = {"protocol_version": 1, "submission_id": "cancel-" + request["id"]}
            self.native("POST", "/api/v1/requests/" + request["id"] + "/cancel", cancellation)
            _, changed_headers = self.native("POST", "/api/v1/requests/" + request["id"] + "/cancel", cancellation, session=request["session_id"], want=409)
            self.diagnose_history(changed_headers["X-Request-Id"], "history.conflict", "submission_conflict")
        for session in ("", "contains spaces", "x" * 101):
            self.submit(self.input(worker), session, want=400)
        self.submit({**self.input(worker), "context_probe": {"kind": "delta"}}, want=400)
        oversized = self.input(worker, [{"type": "message", "role": "user", "text": "x" * 1048576}], tools=[])
        self.submit(oversized, want=413)
        for path in ("/api/v1/admin/requests", "/api/v1/admin/conversations", "/api/v1/admin/conversations/" + first["conversation_id"] + "/timeline"):
            self.native("GET", path, want=401)
        self.receipt("history.owner_reference_and_input_boundaries", stable_session=first["conversation_id"], independent_uncorrelated=True)

    def competing_turns(self, worker, second_origin):
        bodies = [self.input(worker, [{"type": "message", "role": "user", "text": "competing-" + str(i)}], tools=[]) for i in range(8)]
        def attempt(i):
            return self.api("/api/v1/requests", self.client, "POST", bodies[i], origin=self.origin_url if i % 2 == 0 else second_origin, headers={"X-Muse-Session-Id": "race-session"})
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(attempt, range(8)))
        require([value[0] for value in results].count(202) == 1 and [value[0] for value in results].count(409) == 7, "competing session turns were not serialized")
        winner = json.loads(next(value[2] for value in results if value[0] == 202))
        self.native("POST", "/api/v1/requests/" + winner["id"] + "/cancel", {"protocol_version": 1, "submission_id": "cancel-race"})
        replay_body = self.input(worker, tools=[])
        def retry(i):
            return self.api("/api/v1/requests", self.client, "POST", replay_body, origin=self.origin_url if i % 2 == 0 else second_origin, headers={"X-Muse-Session-Id": "retry-session"})
        with ThreadPoolExecutor(max_workers=8) as pool:
            retries = list(pool.map(retry, range(8)))
        require(all(value[0] == 202 for value in retries) and len({json.loads(value[2])["id"] for value in retries}) == 1, "exact retries created multiple requests")
        request = json.loads(retries[0][2])
        self.native("POST", "/api/v1/requests/" + request["id"] + "/cancel", {"protocol_version": 1, "submission_id": "cancel-retries"})
        self.receipt("history.concurrent_admission_and_retries", service_instances=2, competing_turns=8, accepted_turns=1, exact_retries=8)

    def pagination_and_legacy(self, worker, peer):
        legacy = self.create(worker, "legacy inspection", tools=False)
        page, _ = self.checked("/api/v1/admin/requests?conversation_id=" + legacy["conversation_id"], self.admin)
        require(page["items"][0]["kind"] == "legacy", "legacy experiment assigned native ownership")
        legacy_events = self.timeline(legacy["conversation_id"], 1)
        require(all(e["provenance"] == "unavailable" and e["time"] is None for e in legacy_events), "legacy provenance or event times invented")
        self.cancel(legacy["id"])
        seen, cursor = set(), None
        while True:
            path = "/api/v1/admin/conversations?limit=1" + ("&cursor=" + urllib.parse.quote(cursor) if cursor else "")
            page, _ = self.checked(path, self.admin)
            for item in page["items"]:
                require(item["id"] not in seen, "conversation page repeated item")
                seen.add(item["id"])
            cursor = page.get("next_cursor")
            if not cursor:
                break
        for query in ("limit=0", "limit=101", "limit=x", "limit=1&limit=2", "cursor=bad", "unknown=1", "conversation_id=bad%20id"):
            self.checked("/api/v1/admin/requests?" + query, self.admin, want=400)
        canonical = []
        for i in range(3):
            canonical.append({"type": "message", "role": "user", "text": "large tools " + str(i)})
            tools = [{"name": "read_file", "description": "x" * 710000, "parameters": {"type": "object"}}]
            request, _ = self.submit(self.input(worker, canonical, tools), "large-tool-snapshots")
            self.deliver(worker, peer, request, {"type": "final", "text": "ok"})
            canonical.append({"type": "message", "role": "assistant", "text": "ok"})
        status, _, raw = self.api("/api/v1/admin/conversations/" + request["conversation_id"] + "/timeline?limit=100", self.admin)
        require(status == 200 and len(raw) <= 2 * 1024 * 1024 and json.loads(raw).get("next_cursor"), "timeline byte bound not enforced")
        all_events = self.timeline(request["conversation_id"])
        require(sum(e["kind"] == "history.tools" for e in all_events) == 3, "byte pagination omitted snapshots")
        self.receipt("history.pagination_legacy_and_byte_bounds", conversations=len(seen), timeline_limit_bytes=2097152, provenance_unknown_explicit=True)

    def persistence_and_output_failures(self, worker, peer):
        request, _ = self.submit(self.input(worker, tools=[]), "boundary-fault")
        self.deliver(worker, peer, request, {"type": "final", "text": "safe output"})
        constraint = "history_output_start_test"
        self.sql("ALTER TABLE aaa_model_requests ADD CONSTRAINT " + constraint + " CHECK(id <> '" + request["id"] + "' OR data->>'output_started_at' IS NULL);")
        _, headers = self.read_native(request, want=503)
        event, events = self.diagnose_history(headers["X-Request-Id"], "inference.operation_failed")
        require(event["sqlstate"] == "23514" and event["transaction_outcome"] == "rolled_back", "output-start storage failure cause unavailable")
        require(any(e["msg"] == "inference.storage_exchange" and constraint in e["detail"] for e in events), "causal constraint missing from protected exchange")
        self.sql("ALTER TABLE aaa_model_requests DROP CONSTRAINT " + constraint + ";")
        constraint = "history_output_finish_test"
        self.sql("ALTER TABLE aaa_model_requests ADD CONSTRAINT " + constraint + " CHECK(id <> '" + request["id"] + "' OR data->>'output_completed_at' IS NULL);")
        output, headers = self.read_native(request)
        require(output["output"]["text"] == "safe output", "accepted output lost after completion-marker failure")
        _, events = self.diagnose_history(headers["X-Request-Id"], "inference.operation_failed")
        require(any(e["msg"] == "request.completed" and e["outcome"] == "uncertain" for e in events), "post-output persistence uncertainty hidden")
        detail = self.detail(request)["request"]
        require("output_started_at" in detail and "output_completed_at" not in detail, "failed completion falsely marked done")
        self.sql("ALTER TABLE aaa_model_requests DROP CONSTRAINT " + constraint + ";")
        self.read_native(request)
        conflict = self.input(worker, [{"type": "message", "role": "user", "text": "changed prefix"}], tools=[])
        _, headers = self.submit(conflict, "boundary-fault", want=409)
        self.diagnose_history(headers["X-Request-Id"], "history.conflict")
        protected = self.input(worker, [{"type": "message", "role": "user", "text": " ".join((self.admin, self.portal, self.client, worker["credential"]))}], tools=[])
        secret_request, _ = self.submit(protected, "protected-capture")
        self.deliver(worker, peer, secret_request, {"type": "final", "text": "no credentials"})
        events = self.export_operation(secret_request["id"])
        require(any(e["msg"] == "inference.context" and "[REDACTED]" in json.dumps(e) for e in events), "native context credential redaction not proved")
        logs = self.logs(self.main_service)
        require('"msg":"history.input"' not in logs and '"msg":"inference.exchange"' not in logs, "protected DEBUG detail reached INFO output")
        require("history-only-private-" not in logs, "private conflict content reached runtime logs")
        self.assert_private(logs)
        self.receipt("history.real_output_persistence_failures", sqlstate="23514", rollback_verified=True, output_uncertainty_recorded=True, log_only_diagnosis=True, corrective_action="repair rejecting database constraint; preserve exposed decision and retry reading rather than regenerating")

    def deadline_and_restart(self, worker, peer, first, initial, canonical):
        pending, _ = self.submit(self.input(worker, tools=[], timeout=2), "deadline")
        experiment = self.experiment(pending["id"])
        job, _, _ = self.claim(worker, peer, experiment)
        deadline_headers = []
        def interrupted():
            value, headers = self.read_native(pending)
            deadline_headers[:] = [headers]
            return value["state"] == "interrupted"
        self.until(interrupted, "native request deadline did not terminate", timeout=6)
        _, events = self.diagnose_history(deadline_headers[0]["X-Request-Id"], "job.deadline_exceeded", "deadline_exceeded")
        require(any(e["msg"] == "job.deadline_exceeded" and e["generation"] == job["generation"] and e["client_id"] == "fixture-client" for e in events), "deadline cause/assignment/owner unavailable")
        peer.acknowledge_idle(job)
        peer.stop()
        self.until(lambda: self.status(worker)["connection_status"] == "offline", "subscriber did not close")
        self.docker("stop", "--time", "5", self.main_service)
        self.docker("start", self.main_service)
        self.origin_url = self.origin(self.main_service)
        self.ready(self.main_service, self.origin_url)
        peer = self.peer(worker)
        replay, _ = self.submit({**initial, "submission_id": secrets.token_hex(12)}, "session-A")
        require(replay["id"] == first["id"], "broker restart lost replay ownership")
        followup = self.input(worker, canonical + [{"type": "message", "role": "user", "text": "After restart"}], tools=[])
        request, _ = self.submit(followup, "session-A")
        require(request["conversation_id"] == first["conversation_id"], "broker restart lost canonical identity")
        job = self.deliver(worker, peer, request, {"type": "final", "text": "retained"})
        require(job["context"]["messages"] == followup["messages"], "restart omitted or duplicated canonical context")
        self.read_native(request)
        self.receipt("history.deadline_and_restart", retained_conversation=first["conversation_id"], history_replayed=True, synthetic_peer=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    h = History(args)
    try:
        h.baseline()
        h.setup()
        config = h.configuration()
        h.main_service, h.origin_url, _ = h.launch(config)
        h.ready(h.main_service, h.origin_url)
        secondary, second_origin, _ = h.launch(config)
        h.ready(secondary, second_origin)
        worker = h.new_worker()
        peer = h.peer(worker)
        first, initial, canonical = h.tool_history(worker, peer)
        h.owners_and_invalid_inputs(worker, peer, first, initial)
        h.competing_turns(worker, second_origin)
        h.docker("stop", "--time", "5", secondary)
        require(not h.inspect(secondary)["State"]["Running"], "secondary broker still emits asynchronous diagnostics")
        h.pagination_and_legacy(worker, peer)
        h.persistence_and_output_failures(worker, peer)
        h.deadline_and_restart(worker, peer, first, initial, canonical)
        h.private("results.json", json.dumps({"suite": "history", "source_sha": args.source_sha, "synthetic_peer": True, "receipts": h.receipts}))
    finally:
        failures = []
        for peer in h.peers:
            if peer.thread.is_alive():
                try:
                    peer.stop()
                except Exception as error:
                    failures.append(str(error))
        h.cleanup()
        require(not failures, "history peer cleanup failed")


if __name__ == "__main__":
    main()
