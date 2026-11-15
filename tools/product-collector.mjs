import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { Collector } from './qualification-collector.mjs';
import { inspectCase } from './qualification-report.mjs';
import { attachExport, decodeExport, identifier, instant, need, privateRead, readExports, same } from './qualification-evidence.mjs';
import { cycle, cycleIDs, ProductProtocol } from './product-protocol.mjs';
import { liveCases, validateProductReport } from './product-report.mjs';
import { recoveryBoundary } from './product-recovery.mjs';

const execute = promisify(execFile);
const stages = ['enroll', 'baseline', 'broker-prepare', 'broker-resume', 'worker-restart', 'refresh', 'replacement', 'boundaries', 'portal', 'revoke', 'finalize'];

export async function loadReleaseAccess(path, redactor, read = privateRead) {
  const value = JSON.parse(await read(path));
  need(value.schema_version === 1 && Array.isArray(value.workers) && value.workers.length === 2 && ['a', 'b'].every(slot => value.workers.filter(worker => worker.slot === slot).length === 1), 'two_release_workers_required');
  need(new Set(value.workers.map(worker => worker.account_ref)).size === 2 && value.workers.every(worker => typeof worker.account_ref === 'string' && worker.account_ref && (!worker.worker_id || identifier(worker.worker_id))), 'isolated_account_references_required');
  const keys = {};
  for (const slot of ['a', 'b']) {
    const raw = await read(value.clients?.[slot]?.header_file);
    need(/^Authorization: Bearer [^\s]+\n?$/.test(raw), 'invalid_client_header_file');
    keys[slot] = raw.trim().slice('Authorization: '.length); redactor.add(keys[slot]); redactor.add(keys[slot].slice(7));
  }
  need(keys.a !== keys.b, 'distinct_client_keys_required');
  const password = (await read(value.portal_password_file)).replace(/\n$/, '');
  need(password && !Object.values(keys).includes('Bearer ' + password), 'distinct_portal_password_required');
  redactor.add(password);
  return { ...value, keys };
}

export async function runProductBrowser({ state, fixture, phase }, executeCommand = execute) {
  const name = `product-browser-${phase}.json`;
  await state.write(name, JSON.stringify(fixture));
  try {
    await executeCommand(process.execPath, ['tests/portal/product.mjs', '--fixture', join(state.root, name)], { timeout: 180000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error('product_browser_failed'); }
  return JSON.parse(await state.read(`product-browser-${phase}-receipt.json`));
}

export class ReleaseCollector extends Collector {
  constructor(options) {
    super({ ...options, workerID: options.access.workers[0].worker_id ?? 'pending-enrollment' });
    this.access = options.access;
    this.workerID = undefined;
    need(!Object.values(this.access.keys).includes(this.authorization), 'distinct_management_key_required');
    this.browserRunner = options.browserRunner ?? runProductBrowser;
    this.nativeFactory = options.nativeFactory ?? (settings => new Collector(settings));
    this.readPrivate = options.readPrivate ?? privateRead;
    this.driver = new ProductProtocol({ origin: this.origin, keys: this.access.keys, fetcher: this.fetcher, now: this.now,
      readFixture: name => this.state.read(name), save: async () => this.save() });
  }
  async initialize() {
    const observations = await this.observe(), saved = await this.state.read('report.json');
    const status = await this.api('/api/v1/admin/status');
    need(status.ready === true && status.build?.dirty === false && status.build?.worker_package?.version === status.build?.version && /^[a-f0-9]{64}$/.test(status.build?.worker_package?.sha256 ?? ''), 'verified_paired_service_required');
    const artifact = observations.entries.find(entry => entry.kind === 'artifact_identity' && entry.service_sha === status.build.revision);
    need(/^sha256:[a-f0-9]{64}$/.test(artifact?.image_digest ?? '') && /^[a-f0-9]{64}$/.test(artifact?.installer_sha256 ?? ''), 'verified_image_and_installer_required');
    const workers = this.access.workers.map(worker => {
      const setup = observations.entries.find(entry => entry.kind === 'setup_ended' && entry.worker_id === worker.worker_id && entry.account_ref === worker.account_ref);
      return { slot: worker.slot, worker_id: worker.worker_id ?? null, account_ref: worker.account_ref, installed_version: setup?.worker_version ?? null, installed_sha256: setup?.worker_sha256 ?? null };
    });
    if (saved) {
      this.report = JSON.parse(saved);
      need(this.report.schema_version === 2 && this.report.suite === 'release' && this.report.origin === this.origin && this.report.evidence_kind === this.evidenceKind && this.report.source.service_sha === status.build.revision && this.report.source.image_digest === artifact.image_digest, 'release_run_identity_conflict');
      for (const prior of this.report.workers) need(!prior.worker_id || workers.some(worker => same(worker, prior)), 'release_worker_identity_conflict');
      this.report.observations = [...observations.entries, ...this.report.observations.filter(entry => entry.kind === 'intervention' && !observations.entries.some(next => same(entry, next)))];
      this.report.workers = workers;
    } else {
      this.report = { schema_version: 2, suite: 'release', evidence_kind: this.evidenceKind, origin: this.origin, run_id: this.uuid(), started_at: this.stamp(),
        source: { service_sha: status.build.revision, image_digest: artifact.image_digest, service_version: status.build.version, worker_version: status.build.worker_package.version,
          worker_sha256: status.build.worker_package.sha256, installer_sha256: artifact.installer_sha256 }, status_receipt: status, workers, cases: [], cycles: [], native_cases: [],
        observations: observations.entries, exports: [], checkpoints: {}, qualifications: {}, outcome: 'incomplete', verdict: 'inconclusive' };
    }
    await this.save();
  }
  worker(slot) { const worker = this.report.workers.find(item => item.slot === slot); need(identifier(worker?.worker_id), 'worker_setup_required'); return worker; }
  async api(path, method = 'GET', body, item, timeout) {
    const worker = /^\/api\/v1\/admin\/workers\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(path)?.[1];
    return super.api(path, method, body, worker ? { ...item, worker_id: worker } : item, timeout);
  }
  async record(id, fields = {}) {
    const existing = this.report.cases.find(item => item.id === id);
    if (existing) return existing;
    const item = { id, outcome: 'passed', finished_at: this.stamp(), ...fields };
    this.report.cases.push(item); await this.save(); return item;
  }
  async browser(phase, requestIDs = []) {
    const result = await this.browserRunner({ state: this.state, phase, fixture: { origin: this.origin, phase, password_file: this.access.portal_password_file,
      directory: this.state.root, source_sha: this.report.source.service_sha, installer: this.report.status_receipt.build.worker_package,
      workers: this.report.workers, request_ids: requestIDs } });
    for (const secret of result.secrets ?? []) this.logger.redactor.add(secret);
    need(result.outcome === 'passed' && result.source_sha === this.report.source.service_sha, 'product_browser_receipt_failed');
    for (const item of result.cases) await this.record(item.id, item);
    await this.log('INFO', 'e2e.portal_completed', { phase, cases: result.cases.map(item => item.id) });
  }
  async native(slot, phase) {
    const worker = this.worker(slot), state = await this.state.child(`native-${phase}-${slot}`);
    const native = this.nativeFactory({ state, logger: this.logger, origin: this.origin, workerID: worker.worker_id, header: 'Authorization: ' + this.authorization,
      observations: this.observationPath, fetcher: this.fetcher, now: this.now, wait: this.wait, random: this.random, uuid: this.uuid, evidenceKind: this.evidenceKind });
    await native.initialize();
    await native.runCase(`${phase}-readiness-${slot}`, 'readiness');
    await native.runCase(`${phase}-tool-${slot}`);
    const observations = await native.observe();
    for (const ref of observations.worker_exports) {
      const raw = await this.readPrivate(ref.path), attached = await attachExport(state, 'worker', ref.case_id, raw, this.logger.redactor);
      if (!native.report.exports.some(previous => previous.file === attached.file)) native.report.exports.push(attached);
    }
    const evidence = await readExports(native.report, name => state.read(name));
    for (const item of native.report.cases) {
      const result = inspectCase(item, native.report, evidence);
      need(!result.missing.length && !result.failed.length, 'independent_live_trial_evidence_required');
      if (!this.report.native_cases.some(previous => previous.id === item.id)) this.report.native_cases.push(item);
    }
    await native.save();
    const [readiness, tool] = native.report.cases;
    const qualification = { readiness_experiment_id: readiness.experiment_id, tool_experiment_id: tool.experiment_id };
    const approved = await this.api(`/api/v1/admin/workers/${worker.worker_id}/qualifications`, 'POST', { protocol_version: 1, submission_id: this.uuid(), action: 'approve',
      evidence_kind: this.evidenceKind === 'live' ? 'live' : 'controlled', evidence_reference: `release ${this.report.run_id}; independently observed ${phase}/${slot}`, ...qualification });
    this.report.qualifications[slot] = qualification;
    if (phase === 'baseline') {
      await this.record(`readiness.${slot}`, { worker_ids: [worker.worker_id], operation_ids: [readiness.experiment_id, tool.experiment_id], native_case_ids: [readiness.id, tool.id], qualification: approved });
      await this.record(`idle.${slot}`, { worker_ids: [worker.worker_id], operation_ids: [readiness.experiment_id], native_case_ids: [readiness.id] });
    }
    await this.save();
  }
  async select(slot) {
    for (const worker of this.report.workers) {
      const approve = worker.slot === slot || slot === 'all';
      need(!approve || this.report.qualifications[worker.slot], 'current_live_qualification_required');
      await this.api(`/api/v1/admin/workers/${worker.worker_id}/qualifications`, 'POST', { protocol_version: 1, submission_id: this.uuid(), action: approve ? 'approve' : 'withdraw',
        evidence_kind: this.evidenceKind === 'live' ? 'live' : 'controlled', evidence_reference: `release ${this.report.run_id}; select qualified ${slot}`, ...(approve ? this.report.qualifications[worker.slot] : {}) });
    }
  }
  async newCycle(id, slot, protocol = 'chat', stream = false) {
    need(!this.report.cycles.some(item => item.id === id), 'release_cycle_already_started');
    const path = `client-${this.uuid()}.txt`, contents = 'client-only-' + this.random() + '\r\nexact-' + this.random() + '\n';
    await this.state.write(path, contents);
    const item = cycle({ id, slot, protocol, stream, session: this.uuid(), fixture: { id: this.uuid(), owner: 'client_driver', path, contents, created_at: this.stamp() } });
    this.report.cycles.push(item); await this.save(); return item;
  }
  async correlated(item) {
    const receipt = await this.driver.correlate(item, path => this.api(path));
    if (item.id !== 'replacement') need(receipt.worker_ids.length === 1 && receipt.worker_ids[0] === this.worker(item.slot).worker_id, 'unexpected_release_worker');
    return receipt;
  }
  async baseline() {
    for (const slot of ['a', 'b']) {
      await this.native(slot, 'baseline');
    }
    for (const slot of ['a', 'b']) {
      await this.select(slot);
      for (const protocol of ['chat', 'responses']) for (const stream of [false, true]) {
        const id = `${slot}.${protocol}.${stream ? 'sse' : 'json'}`;
        if (this.report.cases.some(item => item.id === id)) continue;
        const item = await this.newCycle(id, slot, protocol, stream);
        await this.driver.start(item); await this.driver.finish(item); await this.driver.followup(item, 'affinity-' + this.random());
        await this.record(id, await this.correlated(item));
      }
    }
    if (!this.report.cases.some(item => item.id === 'sessions.interleaved')) {
      await this.select('a'); const a = await this.newCycle('interleave-a', 'a'); await this.driver.start(a);
      await this.select('b'); const b = await this.newCycle('interleave-b', 'b', 'responses', true); await this.driver.start(b);
      await this.select('all'); await this.driver.finish(b); await this.driver.finish(a);
      const receipts = [await this.correlated(a), await this.correlated(b)];
      need(receipts[0].conversation_id !== receipts[1].conversation_id && receipts[0].session_id !== receipts[1].session_id, 'release_session_isolation_failed');
      for (const id of ['sessions.interleaved', 'sessions.isolation']) await this.record(id, { cycles: receipts });
      await this.record('sessions.affinity', { request_ids: this.report.cycles.flatMap(item => item.turns.map(turn => turn.request_id)) });
      await this.record('boundary.cross-client', await this.driver.rejectOtherClient(b));
    }
  }
  observation(id) {
    const value = this.report.observations.find(entry => entry.kind === 'product_case' && entry.case_id === id);
    need(value && instant(value.time) && value.expected_boundary && value.observed_boundary && value.worker_ids?.length && value.operation_ids?.length, 'observed_product_case_required');
    need(value.worker_ids.every(id => this.report.workers.some(worker => worker.worker_id === id)), 'observation_worker_mismatch');
    return value;
  }
  async broker(stage) {
    const saved = this.report.checkpoints.broker;
    if (stage === 'broker-prepare') {
      need(!saved, 'broker_checkpoint_already_created');
      await this.select('a');
      const item = await this.newCycle('broker-wait', 'a'); await this.driver.start(item); await this.correlated(item);
      const status = await this.api('/api/v1/admin/status');
      this.report.checkpoints.broker = { before_instance: status.instance_id, pending_call_id: item.call_id, cycle_id: item.id, before_status: status, prepared_at: this.stamp() };
      await this.save(); await this.log('INFO', 'e2e.owner_checkpoint', { checkpoint: 'broker_restart', pending_call_id: item.call_id, action: 'Owner restarts the qualification service, retaining PostgreSQL and diagnostics volumes; resume with broker-resume.' });
      return;
    }
    need(saved?.pending_call_id && !saved.completed_request_id, 'pending_broker_checkpoint_required');
    const action = this.observation('recovery.broker-tool-wait');
    const status = await this.api('/api/v1/admin/status'); need(status.instance_id !== saved.before_instance, 'owner_broker_restart_not_observed');
    need(Date.parse(action.time) > Date.parse(saved.prepared_at) && Date.parse(action.time) <= this.now(), 'owner_restart_time_required');
    saved.after_instance = status.instance_id; saved.after_status = status; saved.resumed_at = this.stamp();
    for (const slot of ['a', 'b']) await this.native(slot, 'broker');
    const item = this.report.cycles.find(value => value.id === saved.cycle_id);
    need(item.call_id === saved.pending_call_id, 'pending_tool_identity_changed');
    await this.driver.finish(item); const receipt = await this.correlated(item);
    saved.completed_request_id = item.turns[1].operation_id;
    await this.record('recovery.broker-tool-wait', { ...receipt, id: 'recovery.broker-tool-wait' });
    await this.record('recovery.tool-dedup', { call_id: item.call_id, client_tool_executions: item.client_tool_executions, operation_ids: receipt.operation_ids });
  }
  async recovered(kind) {
    await this.observe();
    const id = kind === 'refresh' ? 'recovery.refresh' : 'recovery.worker', observed = this.observation(id);
    if (kind === 'refresh') {
      const approval = this.report.observations.find(entry => entry.kind === 'refresh_approval' && entry.owner === true && entry.destructive === false && entry.scope);
      need(approval && this.report.observations.some(entry => entry.kind === 'refresh_performed' && entry.scope === approval.scope && Date.parse(entry.time) > Date.parse(approval.time)), 'approved_supported_refresh_required');
    }
    const imports = await this.observe(), events = [];
    for (const ref of imports.worker_exports) events.push(...decodeExport(await this.readPrivate(ref.path)).events);
    const recovery = recoveryBoundary(this.report, id, events, { probe: false });
    const worker = this.report.workers.find(value => value.worker_id === recovery.worker_id);
    await this.native(worker.slot, kind);
    await this.select(worker.slot);
    const item = await this.newCycle(kind + '-probe', worker.slot); await this.driver.start(item); await this.driver.finish(item);
    const receipt = await this.correlated(item);
    need(item.turns.every(turn => turn.connection_id === recovery.connection_id && turn.connection_generation === recovery.connection_generation), 'probe_recovery_generation_changed');
    await this.record(id, { ...receipt, id, observation_ref: observed.source_ref, recovery });
    await this.record('recovery.hook', { recovery_case_id: id, worker_ids: [worker.worker_id], operation_ids: receipt.operation_ids, observation_ref: observed.source_ref, recovery });
  }
  async replacement() {
    const observed = this.observation('recovery.replacement-full-history');
    const workers = await this.api('/api/v1/admin/workers');
    const original = this.report.cycles.find(item => item.id === 'a.responses.json');
    need(original?.outcome === 'passed', 'completed_replacement_history_required');
    need(workers.workers.some(worker => worker.id === this.worker('a').worker_id && worker.connection_status === 'offline' && worker.work_status === 'idle'), 'original_worker_must_be_confirmed_offline_idle');
    await this.native('b', 'replacement');
    const item = structuredClone(original); item.id = 'replacement'; item.replay_source_case_id = original.id; item.measured_from_turn = item.turns.length; item.started_at = this.stamp(); delete item.followup; this.report.cycles.push(item); await this.save();
    await this.driver.followup(item, 'replacement-' + this.random());
    const receipt = await this.correlated(item), detail = await this.api('/api/v1/admin/requests/' + item.turns.at(-1).operation_id);
    need(receipt.worker_ids.length === 2 && detail.delivery?.kind === 'full' && detail.delivery.messages.some(message => message.type === 'tool_result' && message.call_id === item.call_id && message.output === item.fixture.contents), 'replacement_full_history_missing');
    await this.record('recovery.replacement-full-history', { ...receipt, id: 'recovery.replacement-full-history', full_history: true, accepted_call_id: item.call_id, observation_ref: observed.source_ref });
  }
  async boundaries() {
    for (const id of ['boundary.cross-worker', 'recovery.stale-result', 'failure.partial-output', 'failure.unresolved-tool', 'diagnostics.log-only']) {
      if (this.report.cases.some(item => item.id === id)) continue;
      const observation = this.observation(id);
      need(!observation.intervened_trial && observation.capture_complete === true, 'complete_boundary_observation_required');
      await this.record(id, { ...observation.receipt, id, worker_ids: observation.worker_ids, operation_ids: observation.operation_ids, observation_ref: observation.source_ref });
    }
  }
  async finalize() {
    this.report.evidence_import_failures = [];
    const failure = async (source, caseID, error) => {
      const cause = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'evidence_import_failed';
      this.report.evidence_import_failures.push({ source, case_id: caseID, cause });
      await this.log('ERROR', 'e2e.evidence_incomplete', { source, case_id: caseID, cause });
    };
    let observations;
    try { observations = await this.observe(); } catch (error) { await failure('observations', 'all', error); }
    try {
      const raw = await this.api('/api/v1/admin/diagnostics/export?since=' + encodeURIComponent(this.report.started_at));
      const attached = await attachExport(this.state, 'broker', 'all', raw, this.logger.redactor);
      if (!this.report.exports.some(previous => previous.file === attached.file)) this.report.exports.push(attached);
    } catch (error) { await failure('broker', 'all', error); }
    for (const ref of observations?.worker_exports ?? []) {
      try {
        const attached = await attachExport(this.state, 'worker', ref.case_id, await this.readPrivate(ref.path), this.logger.redactor);
        if (!this.report.exports.some(previous => previous.file === attached.file)) this.report.exports.push(attached);
      } catch (error) { await failure('worker', ref.case_id, error); }
    }
    this.report.finished_at = this.stamp(); this.report.outcome = 'passed';
    const evidence = await readExports(this.report, name => this.state.read(name));
    let result = validateProductReport(this.report, evidence); this.report.verdict = result.verdict;
    result = validateProductReport(this.report, evidence); this.report.assessment = result; await this.save();
    if (result.missing.length || result.errors.length) await this.log('ERROR', 'e2e.evidence_incomplete', { missing: result.missing, errors: result.errors });
    await this.log('INFO', 'e2e.completed', { verdict: result.verdict, observed_result: result.observed_result, required_cases: liveCases, cases: result.cases });
    return result;
  }
  async collect(stage = 'baseline') {
    need(stages.includes(stage), 'invalid_release_stage');
    await this.initialize();
    try {
      if (stage === 'enroll') { need(!this.report.cases.some(item => item.id === 'portal.enrollment.a'), 'enrollment_already_recorded'); await this.browser('setup'); }
      if (stage === 'baseline') await this.baseline();
      if (stage.startsWith('broker-')) await this.broker(stage);
      if (stage === 'worker-restart' || stage === 'refresh') await this.recovered(stage === 'refresh' ? 'refresh' : 'worker');
      if (stage === 'replacement') await this.replacement();
      if (stage === 'boundaries') await this.boundaries();
      if (stage === 'portal') await this.browser('inspect', this.report.cycles.filter(item => cycleIDs.includes(item.id)).map(item => item.turns[1]?.operation_id).filter(Boolean));
      if (stage === 'revoke') {
        need(liveCases.filter(id => !id.startsWith('portal.revoke.')).every(id => this.report.cases.some(item => item.id === id && item.outcome === 'passed')), 'complete_matrix_required_before_revocation');
        const assessment = await this.finalize();
        need(assessment.valid && assessment.missing.every(reason => /^required_case:portal\.revoke\.[ab]$/.test(reason)) && assessment.cases.every(item => item.id.startsWith('portal.revoke.') || item.outcome === 'passed'), 'verified_matrix_required_before_revocation');
        await this.browser('revoke');
      }
    } catch (error) {
      await this.log('ERROR', 'e2e.case_failed', { case_id: stage, expected_boundary: 'complete authenticated case', observed_boundary: 'incomplete', cause: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'product_case_failed', correlation: this.report.run_id });
    }
    return this.finalize();
  }
}
