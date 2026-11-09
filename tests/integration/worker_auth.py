#!/usr/bin/env python3
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import json
import os
import select
import subprocess
import time

from service import Harness, require


class WorkerAuth(Harness):
    def __init__(self, args):
        super().__init__(args)
        self.secrets = []
        self.origin_url = None

    def assert_private(self, value, extra=()):
        super().assert_private(value, (*self.secrets, *extra))

    def api(self, path, key=None, method="GET", data=None, origin=None, raw=None, headers=None):
        body = raw if raw is not None else None if data is None else json.dumps(data, ensure_ascii=False).encode()
        return self.request(origin or self.origin_url, path, key, method, body, {"Content-Type": "application/json", **(headers or {})})

    def issue(self):
        code, headers, body = self.api("/api/v1/admin/enrollments", self.admin, "POST")
        require(code == 201, "registration code issuance failed")
        value = json.loads(body)
        self.secrets.append(value["enrollment_code"])
        from datetime import datetime
        require((datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00")) - datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))).total_seconds() == 900, "registration window is not 15 minutes")
        self.diagnose(headers["X-Request-Id"], "enrollment.issued")
        return value

    def enroll(self, enrollment, origin=None):
        status, headers, body = self.api("/api/v1/worker/enroll", method="POST", data={"enrollment_code": enrollment["enrollment_code"]}, origin=origin)
        value = json.loads(body)
        if status == 201:
            self.secrets.append(value["credential"])
        return status, headers, value

    def diagnose(self, request_id, event_name, reason=None):
        status, _, body = self.api("/api/v1/admin/diagnostics/export?request_id=" + request_id, self.admin)
        require(status == 200, "management export unavailable")
        metadata, events = self.decode_export(body)
        self.assert_private(json.dumps(events, ensure_ascii=False))
        self.private("diagnosis-" + request_id + ".json", json.dumps({"request_id": request_id, "expected_event": event_name, "expected_cause": reason, "events": events}, ensure_ascii=False))
        require(metadata["complete"] and events, "operation capture incomplete")
        require(all(e["request_id"] == request_id for e in events), "operation export mixed request identities")
        matched = [e for e in events if e["msg"] == event_name]
        require(len(matched) == 1, "required diagnostic event missing or duplicated: " + event_name)
        event = matched[0]
        if reason is not None:
            require(event.get("reason", event.get("cause")) == reason, "log-only cause differs")
        require(any(e["msg"] == "request.exchange" and e["level"] == "DEBUG" for e in events), "DEBUG exchanges not captured at INFO runtime level")
        require(any(e["msg"] == "request.completed" for e in events), "final outcome missing")
        return event, events

    @contextmanager
    def enrollment_lock(self, enrollment_id):
        process = subprocess.Popen(["docker", "exec", "-i", self.db, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "aaa_muse"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write("BEGIN; SELECT id FROM aaa_worker_enrollments WHERE id='" + enrollment_id + "' FOR UPDATE;\n\\echo LOCKED\n")
            process.stdin.flush()
            require(select.select([process.stdout], [], [], 5)[0], "row lock did not become ready")
            require(process.stdout.readline().strip() == enrollment_id and process.stdout.readline().strip() == "LOCKED", "wrong enrollment locked")
            yield
        finally:
            try:
                process.communicate("ROLLBACK;\n", timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise RuntimeError("enrollment lock did not stop")
            require(process.returncode == 0, "row-lock barrier failed")

    def rejection_cases(self, other_origin):
        expired = self.issue()
        self.sql("UPDATE aaa_worker_enrollments SET created_at=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE id='" + expired["enrollment_id"] + "';")
        status, headers, _ = self.enroll(expired)
        require(status == 410, "expired code accepted")
        event, _ = self.diagnose(headers["X-Request-Id"], "enrollment.rejected", "enrollment_expired")
        require(event["enrollment"]["enrollment_id"] == expired["enrollment_id"] and event["transaction_outcome"] == "rolled_back", "expiry evidence lacks identity/atomic outcome")
        require(self.api("/api/v1/worker/enroll", method="POST", data={"enrollment_code": "invalid"})[0] == 400, "malformed code accepted")

        racing = self.issue()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.enroll(racing, self.origin_url if i % 2 == 0 else other_origin), range(8)))
        require([r[0] for r in results].count(201) == 1 and [r[0] for r in results].count(409) == 7, "concurrent redemption issued multiple identities or hid failures")
        winner = next(r[2] for r in results if r[0] == 201)
        _, headers, _ = self.enroll(racing)
        event, _ = self.diagnose(headers["X-Request-Id"], "enrollment.rejected", "enrollment_used")
        require(event["worker_id"] == winner["worker"]["id"] and event["transaction_outcome"] == "rolled_back", "reuse diagnosis lost original assignment")
        require(self.sql("SELECT count(*) FROM aaa_workers;") == "1", "failed/duplicate redemption left worker rows")

        waiting = self.issue()
        self.sql("UPDATE aaa_worker_enrollments SET created_at=clock_timestamp()-interval '1 minute', expires_at=clock_timestamp()+interval '1 second' WHERE id='" + waiting["enrollment_id"] + "';")
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.enrollment_lock(waiting["enrollment_id"]):
                result = pool.submit(self.enroll, waiting)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if int(self.sql("SELECT count(*) FROM pg_stat_activity WHERE datname='aaa_muse' AND application_name <> 'psql' AND wait_event_type='Lock';")):
                        break
                    time.sleep(0.02)
                else:
                    raise AssertionError("redemption did not actually wait for the row lock")
                remaining = float(self.sql("SELECT extract(epoch FROM expires_at-clock_timestamp()) FROM aaa_worker_enrollments WHERE id='" + waiting["enrollment_id"] + "';"))
                require(remaining > 0, "expiry fixture elapsed before the request waited")
                time.sleep(remaining + 0.1)
            status, headers, _ = result.result(timeout=6)
        require(status == 410, "expiry was evaluated before waiting for the row lock")
        self.diagnose(headers["X-Request-Id"], "enrollment.rejected", "enrollment_expired")
        self.receipt("enrollment.single_use_expiry_and_race", attempts=8, issued=1, rejected_reuse=7, expiry_after_lock=True)
        return winner

    def functional_workers(self, first):
        enrolled = [first]
        for _ in range(3):
            registration = self.issue()
            status, _, value = self.enroll(registration)
            require(status == 201, "implicit worker-count cap prevented enrollment")
            stored = self.sql("SELECT encode(code_hash,'hex') FROM aaa_worker_enrollments WHERE id='" + registration["enrollment_id"] + "';")
            require(stored == hashlib.sha256(registration["enrollment_code"].encode()).hexdigest(), "registration code not stored as a hash")
            enrolled.append(value)
        a, b = enrolled[:2]
        for value in enrolled:
            record, key = value["worker"], value["credential"]
            require(record["connection_status"] == "not_observed" and record["inference_readiness"] == "unverified" and record["last_contact_at"], "registration invented liveness/readiness")
            require("idle" not in record and "busy" not in record and "current_assignment" not in record, "unimplemented work facts advertised")
            stored = self.sql("SELECT encode(credential_hash,'hex') FROM aaa_workers WHERE id='" + record["id"] + "';")
            require(stored == hashlib.sha256(key.encode()).hexdigest(), "reconnect credential not stored as a hash")
        status, _, body = self.api("/api/v1/admin/workers", self.admin)
        require(status == 200 and len(json.loads(body)["workers"]) == 4, "list lost workers")
        self.assert_private(body.decode())
        a_id, b_id = a["worker"]["id"], b["worker"]["id"]
        status, _, body = self.api("/api/v1/worker/status", a["credential"], headers={"X-Worker-Id": b_id})
        require(status == 200 and json.loads(body)["id"] == a_id, "supplied worker ID overrode identity")
        require(self.api("/api/v1/worker/status?worker_id=" + b_id, a["credential"])[0] == 400, "worker-ID query accepted")
        for path, method in (("/api/v1/admin/workers/" + b_id, "PATCH"), ("/api/v1/admin/workers/" + b_id + "/revoke", "POST")):
            status, headers, _ = self.api(path, a["credential"], method, {"name": "not permitted"})
            require(status == 401, "worker obtained cross-worker authority")
            event, _ = self.diagnose(headers["X-Request-Id"], "worker.scope_denied", "role_not_permitted")
            require(event["authenticated_worker_id"] == a_id and event["requested_worker_id"] == b_id, "scope denial lost both identities")
        for key in (None, self.client, self.portal, a["credential"]):
            for route, method in (("/api/v1/admin/enrollments", "POST"), ("/api/v1/admin/workers", "GET")):
                status, headers, _ = self.api(route, key, method)
                require(status == 401, "non-management worker administration accepted")
                event, _ = self.diagnose(headers["X-Request-Id"], "worker.auth_denied", "role_not_permitted")
                require(event["expected_role"] == "management" and event["observed_role"] != "management", "wrong-role diagnostic lacks authority context")
        status, headers, _ = self.api("/api/v1/admin/workers/" + a_id + "/revoke", a["credential"], "POST")
        require(status == 401, "worker self-revocation used management authority")
        self.diagnose(headers["X-Request-Id"], "worker.auth_denied", "role_not_permitted")
        for key in (None, self.admin, self.client, self.portal):
            require(self.api("/api/v1/worker/status", key)[0] == 401, "wrong role obtained worker status")
        self.receipt("workers.unlimited_registration_and_scope", workers=4, id_override_rejected=True)
        return a, b

    def names_and_boundaries(self, a, b):
        path = "/api/v1/admin/workers/" + a["worker"]["id"]
        for name in ("A", "😀" * 100, "　 名称  "):
            status, _, body = self.api(path, self.admin, "PATCH", {"name": name})
            require(status == 200 and json.loads(body)["name"] == name.strip(), "valid Unicode name not persisted/trimmed")
        for name in ("", "   ", "😀" * 101, "bad\nname", "\tname", "bad\x00name"):
            require(self.api(path, self.admin, "PATCH", {"name": name})[0] == 400, "invalid name accepted")
        for raw in (b'{}', b'null', b'[]', b'{', b'{"name":null}', b'{"name":"a","name":"b"}', b'{"name":"a"} {}', b'{"other":"private-unadmitted-fixture"}', b'{"name":"\xff"}'):
            require(self.api(path, self.admin, "PATCH", raw=raw)[0] == 400, "unsupported JSON accepted")
        require(self.api(path, self.admin, "PATCH", raw=b"x" * (1024 * 1024 + 1))[0] == 413, "oversized request accepted")
        for value in (a, b):
            require(self.api("/api/v1/admin/workers/" + value["worker"]["id"], self.admin, "PATCH", {"name": "shared display name"})[0] == 200, "nonunique name rejected")
            status, _, body = self.api("/api/v1/worker/status", value["credential"])
            require(status == 200 and json.loads(body)["id"] == value["worker"]["id"] and json.loads(body)["name"] == "shared display name", "rename changed authority")
        echoed_secrets = [a["credential"], self.issue()["enrollment_code"]]
        for secret in echoed_secrets:
            status, _, response = self.api(path, self.admin, "PATCH", {"name": "echo " + secret})
            require(status == 200 and secret not in response.decode(), "rename returned issued secret")
            for route, key in (("/api/v1/admin/workers", self.admin), ("/api/v1/worker/status", a["credential"])):
                status, _, response = self.api(route, key)
                require(status == 200 and secret not in response.decode() and "echo [REDACTED]" in response.decode(), "ordinary worker response disclosed issued secret")
        _, _, exported = self.api("/api/v1/admin/diagnostics/export", self.admin)
        _, events = self.decode_export(exported)
        self.assert_private(json.dumps(events))
        require("private-unadmitted-fixture" not in json.dumps(events), "invalid JSON bypassed credential protection")
        self.api(path, self.admin, "PATCH", {"name": "persistent agent name"})
        self.api("/api/v1/admin/workers/" + b["worker"]["id"], self.admin, "PATCH", {"name": "echo " + b["credential"]})
        self.receipt("workers.rename_and_strict_boundaries", unicode_limit=100, nonunique=True, body_limit=1048576)

    def restart_and_revoke(self, containers, a, b):
        a_id = a["worker"]["id"]
        self.sql("UPDATE aaa_workers SET registered_at=clock_timestamp()-interval '2 days' WHERE id='" + a_id + "';")
        require(self.api("/api/v1/worker/status", a["credential"])[0] == 200, "credential acquired an automatic lifetime")
        status, headers, body = self.api("/api/v1/admin/workers/" + a_id + "/revoke", self.admin, "POST")
        require(status == 200, "revocation failed")
        revoked_at = json.loads(body)["revoked_at"]
        event, _ = self.diagnose(headers["X-Request-Id"], "worker.revoke_exchange")
        require(event["before"]["revoked_at"] is None and event["after"]["revoked_at"] == revoked_at, "initial revocation before/after evidence missing")
        _, headers, body = self.api("/api/v1/admin/workers/" + a_id + "/revoke", self.admin, "POST")
        require(json.loads(body)["revoked_at"] == revoked_at, "repeated revocation changed original time")
        event, _ = self.diagnose(headers["X-Request-Id"], "worker.revoke_exchange")
        require(event["before"]["revoked_at"] == revoked_at and event["after"]["revoked_at"] == revoked_at, "repeated revocation prior state missing")
        status, headers, _ = self.api("/api/v1/worker/status", a["credential"])
        require(status == 401, "revoked credential authorized")
        self.diagnose(headers["X-Request-Id"], "worker.auth_denied", "worker_revoked")
        self.api("/api/v1/admin/workers/" + a_id, self.admin, "PATCH", {"name": "revoked renamed agent"})
        for container in containers:
            self.docker("restart", container)
            self.ready(container, self.origin(container))
        self.origin_url = self.origin(containers[0])
        require(self.api("/api/v1/worker/status", a["credential"])[0] == 401, "restart/rename revived revoked authority")
        status, _, body = self.api("/api/v1/worker/status", b["credential"])
        require(status == 200 and json.loads(body)["name"] == "echo [REDACTED]" and b["credential"] not in body.decode(), "restart invalidated reconnect credential or exposed its display-name echo")
        _, _, body = self.api("/api/v1/admin/workers", self.admin)
        record = next(w for w in json.loads(body)["workers"] if w["id"] == a_id)
        require(record["name"] == "revoked renamed agent" and record["revoked_at"] == revoked_at, "restart lost identity/name/revocation")
        self.docker("stop", self.db)
        status, headers, _ = self.api("/api/v1/worker/status", b["credential"])
        require(status == 503, "database loss misreported as credential rejection")
        event, _ = self.diagnose(headers["X-Request-Id"], "worker.operation_failed", "database_unavailable")
        require(event["attempt"] == 1 and event["transaction_outcome"] == "not_started" and event["duration_ms"] >= 0, "database diagnosis lacks attempts/timing/outcome")
        self.docker("start", self.db)
        self.ready(containers[0], self.origin_url)
        require(self.api("/api/v1/worker/status", a["credential"])[0] == 401 and self.api("/api/v1/worker/status", b["credential"])[0] == 200, "database restart lost scoped authority")
        _, _, body = self.api("/api/v1/admin/diagnostics/export", self.admin)
        metadata, events = self.decode_export(body)
        require(metadata["complete"], "full feature capture incomplete")
        self.assert_private(json.dumps(events))
        for container in containers:
            logs = self.logs(container)
            self.assert_private(logs)
            require('"level":"DEBUG"' not in logs, "DEBUG reached INFO stdout")
        self.receipt("workers.durable_revocation_reconnect_and_diagnosis", service_restart=True, database_restart=True, credential_lifetime="until_revoked", corrective_action="restore PostgreSQL availability")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-dirty", choices=("true", "false"), required=True)
    args = parser.parse_args()
    args.suite = "worker-auth"
    os.umask(0o077)
    h = WorkerAuth(args)
    try:
        h.baseline()
        h.setup()
        first, h.origin_url, _ = h.launch()
        h.ready(first, h.origin_url)
        second, other, _ = h.launch()
        h.ready(second, other)
        winner = h.rejection_cases(other)
        a, b = h.functional_workers(winner)
        h.names_and_boundaries(a, b)
        h.restart_and_revoke([first, second], a, b)
        h.private("results.json", json.dumps({"suite": args.suite, "source_sha": args.source_sha, "receipts": h.receipts}))
    finally:
        h.cleanup()


if __name__ == "__main__":
    main()
