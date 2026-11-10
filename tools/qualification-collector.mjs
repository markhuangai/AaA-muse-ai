import { randomBytes, randomUUID } from 'node:crypto';
import { attachExport, decodeExport, identifier, instant, need, privateRead, publicOrigin, readExports, same } from './qualification-evidence.mjs';
import { validateReport } from './qualification-report.mjs';

export class Collector {
  constructor({ state, logger, origin, workerID, header, observations, fetcher = fetch, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), random = () => randomBytes(24).toString('hex'), uuid = randomUUID, evidenceKind = 'live' }) {
    this.state = state; this.logger = logger; this.origin = publicOrigin(origin); this.workerID = workerID;
    need(identifier(workerID), 'invalid_worker_id');
    need(/^Authorization: Bearer [^\s]+\n?$/.test(header), 'invalid_management_header_file');
    this.authorization = header.trim().slice('Authorization: '.length);
    this.logger.redactor.add(this.authorization); this.logger.redactor.add(this.authorization.slice('Bearer '.length));
    this.observationPath = observations; this.fetcher = fetcher; this.now = now; this.wait = wait; this.random = random; this.uuid = uuid;
    need(['live','synthetic'].includes(evidenceKind),'invalid_evidence_kind');this.evidenceKind = evidenceKind;
  }
  stamp() { return new Date(this.now()).toISOString(); }
  async log(level, msg, fields = {}) { await this.logger.log(level, msg, {run_id:this.report?.run_id,evidence_kind:this.evidenceKind,...fields}); }
  async save() {
    const value = JSON.stringify(this.logger.redactor.value(this.report), null, 2) + '\n';
    need(Buffer.byteLength(value) <= 16 * 1024 * 1024, 'report_too_large');
    await this.state.write('report.json', value);
  }
  async observe() {
    const source = JSON.parse(await privateRead(this.observationPath));
    need(source.schema_version === 1 && Array.isArray(source.entries) && Array.isArray(source.worker_exports), 'invalid_observation_file');
    for (const entry of source.entries) need(typeof entry.kind === 'string' && instant(entry.time) && typeof entry.source_ref === 'string' && typeof entry.observer === 'string', 'invalid_observation_entry');
    const safe = this.logger.redactor.value(source);
    need(same(safe, source), 'observation_contains_sensitive_material');
    if (this.report) this.report.observations = source.entries;
    return source;
  }
  async api(path, method = 'GET', body, item, timeout = 10000) {
    need(path.startsWith('/api/v1/admin/') && !path.includes('..'), 'management_route_required');
    const input = body === undefined ? undefined : JSON.stringify(body);
    need(input === undefined || Buffer.byteLength(input) <= 1024*1024, 'request_too_large');
    let response, raw;
    try {
      response = await this.fetcher(this.origin + path, {method,headers:{Authorization:this.authorization,...(input ? {'Content-Type':'application/json'}:{})},body:input,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,timeout)))});
      need(Number(response.headers.get('content-length') ?? 0) <= 16*1024*1024, 'response_too_large');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 16*1024*1024) { await reader.cancel(); throw new Error('response_too_large'); }
        chunks.push(Buffer.from(part.value));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      await this.log('ERROR','qualification.exchange_failed',{case_id:item?.id,operation_id:item?.experiment_id,path,method,cause:error.name === 'TimeoutError' ? 'http_deadline' : 'http_exchange_failed'});
      throw new Error('http_exchange_failed');
    }
    await this.log('DEBUG','qualification.http_exchange',{case_id:item?.id,operation_id:item?.experiment_id,conversation_id:item?.conversation_id,worker_id:this.workerID,path,method,input:body ?? null,http_status:response.status,request_id:response.headers.get('x-request-id'),output:raw});
    need(response.ok, `http_${response.status}`);
    return path.includes('/diagnostics/export') ? raw : JSON.parse(raw);
  }
  async initialize() {
    const observations = await this.observe();
    const saved = await this.state.read('report.json');
    if (saved) {
      this.report = JSON.parse(saved);
      need(this.report.worker_id === this.workerID && this.report.origin === this.origin && this.report.evidence_kind === this.evidenceKind, 'run_identity_conflict');
      this.report.observations = observations.entries;
      need(!this.report.cases.some(item => !item.finished_at), 'unfinished_case_requires_evidence_review_new_run');
      return;
    }
    const setup = observations.entries.find(entry => entry.kind === 'setup_ended' && entry.worker_id === this.workerID);
    need(setup && instant(setup.time) && Date.parse(setup.time) <= this.now(), 'setup_must_end_before_qualification');
    const status = await this.api('/api/v1/admin/status');
    const artifact = observations.entries.find(entry => entry.kind === 'artifact_identity');
    need(status.ready === true && status.build?.dirty === false && /^[a-f0-9]{40}$/.test(status.build.revision), 'exact_ready_service_required');
    need(status.configuration?.limits?.max_jobs >= 2 && status.configuration.limits.in_flight_per_worker === 1, 'interleave_requires_two_jobs_one_inference');
    need(artifact?.service_sha === status.build.revision && /^sha256:[a-f0-9]{64}$/.test(artifact.image_digest ?? ''), 'verified_image_identity_required');
    const pin = status.configuration.worker_package;
    need(pin?.version && /^[a-f0-9]{64}$/.test(pin.sha256 ?? ''), 'published_worker_pin_required');
    this.report = {schema_version:1,evidence_kind:this.evidenceKind,run_id:this.uuid(),origin:this.origin,worker_id:this.workerID,started_at:this.stamp(),setup_ended_at:setup.time,settings:{idle_seconds:120,turn_seconds:300},status_receipt:status,source:{service_sha:status.build.revision,image_digest:artifact.image_digest,worker_version:pin.version,worker_sha256:pin.sha256},cases:[],observations:observations.entries,exports:[],context_strategy:{baseline:'full',delta:'inconclusive'},verdict:'inconclusive'};
    await this.save();
    await this.log('INFO','qualification.started',{worker_id:this.workerID,source:this.report.source,effective_settings:this.report.settings});
  }
  async idle() {
    const list = await this.api('/api/v1/admin/workers');
    const worker = list.workers?.find(item => item.id === this.workerID);
    need(worker?.connection_status === 'online' && worker.work_status === 'idle' && !worker.current_job, 'worker_not_confirmed_idle');
  }
  async quiet(id) {
    await this.idle();
    const started = this.now();
    await this.log('INFO','qualification.quiet_started',{case_id:id,started_at:this.stamp(),required_seconds:120});
    await this.wait(120000);
    await this.observe();
    need(!this.report.observations.some(entry => entry.kind === 'intervention' && Date.parse(entry.time) >= started && Date.parse(entry.time) <= this.now()), 'intervention_during_quiet_window');
    await this.idle();
  }
  async begin(id, kind = 'tool', replay) {
    const existing = this.report.cases.find(item => item.id === id);
    if (existing) return existing;
    await this.quiet(id);
    const marker = this.random(), fixtureID = this.uuid();
    const fixture = kind === 'tool' ? {id:fixtureID,owner:'client_driver',path:`client-only-${fixtureID}.txt`,contents:`fixture-${this.random()}\nexact-${this.random()}\n`,created_at:this.stamp()} : undefined;
    if (fixture) await this.state.write(fixture.path, fixture.contents);
    const challenge = kind === 'readiness' ? `ready-${this.random()}` : undefined;
    const expected = replay?.expected ?? {session:marker,value:fixture?.contents};
    const messages = kind === 'replay' ? [...replay.observed.messages,{type:'message',role:'user',text:'Using only the supplied canonical history, repeat the preceding final JSON answer exactly. Do not call a tool again.'}] : [{type:'message',role:'system',text:kind === 'readiness' ? 'Return only the exact challenge from the user through the authenticated worker decision CLI.' : `Client tools execute only on the client. Propose read_file; never read a VM file or invent its result. After the matching client result, return only a JSON object with exactly session and value. session must equal ${marker}; value must equal the exact client result, including newlines.`},{type:'message',role:'user',text:kind === 'readiness' ? challenge : `Read ${fixture.path} using the supplied client read_file tool.`}];
    const tools = kind === 'replay' ? replay.request.tools : kind === 'tool' ? [{name:'read_file',description:'Read the one client-owned qualification fixture.',parameters:{type:'object',properties:{path:{type:'string',enum:[fixture.path]}},required:['path'],additionalProperties:false}}] : [];
    const item = {id,kind,worker_id:this.workerID,session_marker:expected.session,started_at:this.stamp(),fixture,challenge,expected,request:{protocol_version:1,submission_id:this.uuid(),worker_id:this.workerID,messages,tools,timeout_seconds:kind === 'tool' ? 3600 : 300,context_probe:{kind:'full'}},turns:[],last_boundary:'create_pending'};
    this.report.cases.push(item); await this.save();
    const experiment = await this.api('/api/v1/admin/experiments','POST',item.request,item);
    need(experiment.worker_id === this.workerID && identifier(experiment.id) && identifier(experiment.conversation_id), 'experiment_identity_mismatch');
    Object.assign(item,{experiment_id:experiment.id,conversation_id:experiment.conversation_id,initial:experiment,observed:experiment,last_boundary:'job_queued'});
    item.turns.push({job_id:experiment.current_job_id,started_at:item.started_at}); await this.save();
    return item;
  }
  async poll(item, target) {
    const turn = item.turns.at(-1), deadline = Date.parse(turn.started_at)+300000;
    while (this.now() < deadline) {
      let observed;
      try { observed = await this.api(`/api/v1/admin/experiments/${item.experiment_id}`,'GET',undefined,item,deadline-this.now()); }
      catch (error) { if (this.now() >= deadline) return await this.expire(item); throw error; }
      need(observed.id === item.experiment_id && observed.conversation_id === item.conversation_id && observed.worker_id === this.workerID, 'experiment_identity_mismatch');
      item.observed = observed;
      if (this.now() >= deadline) return await this.expire(item);
      if ([target,'completed','interrupted','cancelled'].includes(observed.state)) {
        turn.finished_at = this.stamp(); item.last_boundary = observed.state;
        if (['interrupted','cancelled'].includes(observed.state)) {
          item.failure = 'native_result_interrupted';
          await this.log('WARN','qualification.wake_failed',{case_id:item.id,operation_id:item.experiment_id,conversation_id:item.conversation_id,worker_id:this.workerID,last_boundary:item.last_boundary,elapsed_ms:this.now()-Date.parse(turn.started_at),cause:observed.reason ?? observed.state});
        }
        await this.save(); return observed;
      }
      item.last_boundary = observed.state; await this.save(); await this.wait(1000);
    }
    return await this.expire(item);
  }
  async cancel(item) {
    if (['completed','cancelled','interrupted'].includes(item.observed?.state) || item.cancel_request) return;
    // Cancellation fences this run; it does not acknowledge stopped native inference.
    item.cancel_request = {protocol_version:1,submission_id:this.uuid()}; await this.save();
    try { item.observed = await this.api(`/api/v1/admin/experiments/${item.experiment_id}/cancel`,'POST',item.cancel_request,item); }
    catch (error) {
      if (error.message !== 'http_409') throw error;
      const current = await this.api(`/api/v1/admin/experiments/${item.experiment_id}`,'GET',undefined,item);
      need(['completed','cancelled','interrupted'].includes(current.state),'cancel_outcome_uncertain');
      item.observed = current;
    }
  }
  async expire(item) {
    const turn = item.turns.at(-1);
    turn.finished_at = this.stamp(); item.failure = 'turn_deadline';
    await this.log('WARN','qualification.wake_failed',{case_id:item.id,operation_id:item.experiment_id,conversation_id:item.conversation_id,worker_id:this.workerID,last_boundary:item.last_boundary,elapsed_ms:this.now()-Date.parse(turn.started_at),cause:'turn_deadline'});
    await this.cancel(item);
    await this.save(); return item.observed;
  }
  async result(item) {
    need(!item.failure && Date.parse(item.turns[0].finished_at)-Date.parse(item.turns[0].started_at) < 300000,'expired_or_failed_tool_turn');
    const call = item.observed?.messages?.at(-1);
    need(item.observed?.state === 'waiting_for_tool' && call?.type === 'tool_call' && call.name === 'read_file' && identifier(call.call_id) && same(call.arguments,{path:item.fixture.path}), 'wrong_tool_or_arguments');
    const calls = item.observed.messages.filter(message => message.type === 'tool_call');
    need(calls.length === 1 && !item.tool_result_request, 'duplicate_tool_execution');
    const contents = await this.state.read(item.fixture.path);
    need(contents === item.fixture.contents, 'client_fixture_changed');
    const request = {protocol_version:1,submission_id:this.uuid(),call_id:call.call_id,output:contents,...(item.id === 'delta' ? {context_probe:{kind:'delta',base_receipt_id:item.turns[0].job_id}} : {})};
    item.tool_result_request = request;
    const started = this.stamp(); await this.save();
    const next = await this.api(`/api/v1/admin/experiments/${item.experiment_id}/tool-results`,'POST',request,item);
    need(next.conversation_id === item.conversation_id && next.worker_id === this.workerID && next.current_job_id !== item.turns[0].job_id, 'continuation_identity_mismatch');
    item.turns.push({job_id:next.current_job_id,started_at:started}); item.observed = next; await this.save();
    await this.poll(item,'completed');
  }
  async assessAnswer(item) {
    if (item.observed?.state !== 'completed') return;
    const correct = item.kind === 'readiness' ? item.observed.final_text === item.challenge : same(parseJSON(item.observed.final_text),item.expected);
    if (!correct) {
      item.failure ??= 'wrong_final_result';
      await this.log('DEBUG','qualification.answer_detail',{case_id:item.id,operation_id:item.experiment_id,expected:item.kind === 'readiness' ? item.challenge : item.expected,observed:item.observed.final_text});
      await this.decisionFailure(item,new Error('wrong_final_result'));
    }
  }
  async decisionFailure(item,error) {
    item.failure ??= error.message;
    await this.log('WARN','qualification.decision_failed',{case_id:item.id,operation_id:item.experiment_id,conversation_id:item.conversation_id,worker_id:this.workerID,last_boundary:item.last_boundary,cause:error.message,proposed:item.observed?.messages?.at(-1),fixture_owner:'client_driver',elapsed_ms:this.now()-Date.parse(item.started_at)});
  }
  async finish(item) {
    if (item.finished_at) return;
    item.observed = await this.api(`/api/v1/admin/experiments/${item.experiment_id}`,'GET',undefined,item);
    item.finished_at = this.stamp(); await this.save();
    const raw = await this.api(`/api/v1/admin/diagnostics/export?operation_id=${item.experiment_id}`);
    const ref = await attachExport(this.state,'broker',item.id,raw,this.logger.redactor);
    this.report.exports.push(ref);
    const events = decodeExport(raw).events;
    for (const turn of item.turns) turn.context = events.find(event => event.msg === 'inference.context' && event.job_id === turn.job_id)?.context;
    await this.log('INFO','qualification.case_finished',{case_id:item.id,operation_id:item.experiment_id,conversation_id:item.conversation_id,worker_id:this.workerID,state:item.observed?.state,last_boundary:item.last_boundary,elapsed_ms:this.now()-Date.parse(item.started_at)});
    await this.save();
  }
  async runCase(id, kind = 'tool', replay) {
    if (this.report.cases.some(item => item.id === id)) return;
    const item = await this.begin(id,kind,replay);
    try {
      await this.poll(item,kind === 'tool' ? 'waiting_for_tool' : 'completed');
      if (kind === 'tool' && !item.failure) await this.result(item);
      await this.assessAnswer(item);
    } catch (error) {
      await this.decisionFailure(item,error);
      throw error;
    } finally {
      if (item.failure) await this.cancel(item);
      await this.finish(item);
    }
  }
  async interleave() {
    if (this.report.cases.some(item => ['interleave-a','interleave-b'].includes(item.id))) return;
    const a = await this.begin('interleave-a');
    let b,active=a;
    try {
      await this.poll(a,'waiting_for_tool'); need(!a.failure,'first_session_failed');
      b = await this.begin('interleave-b'); active=b; await this.poll(b,'waiting_for_tool'); need(!b.failure,'second_session_failed');
      active=a; await this.result(a); await this.assessAnswer(a); await this.finish(a);
      active=b; await this.result(b); await this.assessAnswer(b);
    } catch (error) {
      await this.decisionFailure(active,error);
      for (const item of [a,b].filter(Boolean)) {
        item.failure ??= error.message;
        await this.cancel(item);
      }
      throw error;
    } finally { await this.finish(a); if (b) await this.finish(b); }
  }
  async collect(stage = 'all') {
    need(['all','baseline','readiness-repeat','replay','refresh','finalize'].includes(stage),'invalid_collection_stage');
    await this.initialize();
    try {
      if (stage === 'readiness-repeat') {
        const first = this.report.cases.find(item => item.id === 'readiness');
        need(first?.finished_at && (first.observed?.state !== 'completed' || first.observed.final_text !== first.challenge),'failed_readiness_required_for_reproduction');
        await this.runCase('readiness-repeat','readiness');
      }
      if (['all','baseline'].includes(stage)) {
        await this.runCase('readiness','readiness');
        const readiness = this.report.cases.find(item => item.id === 'readiness');
        need(readiness?.observed?.state === 'completed' && readiness.observed.final_text === readiness.challenge,'independent_readiness_failed');
        for (const id of ['trial-1','trial-2','trial-3','full','delta']) await this.runCase(id);
        await this.interleave();
      }
      if (['all','replay'].includes(stage) && !this.report.cases.some(item => item.id === 'replay')) {
        await this.observe();
        const full = this.report.cases.find(item => item.id === 'full');
        need(full?.observed?.state === 'completed' && this.report.observations.some(entry => entry.kind === 'fresh_conversation' && Date.parse(entry.time) > Date.parse(full.finished_at)), 'fresh_native_conversation_observation_required');
        await this.runCase('replay','replay',full);
      }
      if (['all','refresh'].includes(stage) && !this.report.cases.some(item => item.id === 'refresh')) {
        await this.observe();
        need(this.report.cases.some(item => item.id === 'replay') && this.report.observations.some(entry => entry.kind === 'refresh_reconnected'), 'approved_refresh_observation_required');
        await this.runCase('refresh');
      }
    } catch (error) {
      await this.log('ERROR','qualification.evidence_incomplete',{cause:error.message,last_boundary:this.report.cases.at(-1)?.last_boundary ?? 'preflight',outcome:'inconclusive'});
    }
    return await this.finalize();
  }
  async finalize() {
    this.report.evidence_import_failures = [];
    const importFailure = async (source,caseID,error) => {
      const cause = /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : /^[A-Z_]+$/.test(error.code ?? '') ? error.code : error.name;
      const failure = {source,case_id:identifier(caseID)?caseID:'invalid_identity',cause};
      this.report.evidence_import_failures.push(failure);
      await this.log('ERROR','qualification.evidence_incomplete',{...failure,worker_id:this.workerID,capture_complete:false,outcome:'inconclusive'});
    };
    let observations = {worker_exports:[]};
    try { observations = await this.observe(); }
    catch (error) { this.report.observations=[]; await importFailure('observations','all',error); }
    for (const ref of observations.worker_exports) {
      try {
        need(identifier(ref.case_id), 'invalid_worker_export_case');
        const raw = await privateRead(ref.path);
        const attached = await attachExport(this.state,'worker',ref.case_id,raw,this.logger.redactor);
        if (!this.report.exports.some(previous => previous.file === attached.file)) this.report.exports.push(attached);
      } catch (error) { await importFailure('worker',ref?.case_id,error); }
    }
    this.report.finished_at = this.stamp();
    const evidence = await readExports(this.report,name => this.state.read(name));
    const delta = this.report.cases.find(item => item.id === 'delta');
    this.report.context_strategy.delta = delta ? (delta.failure || delta.observed?.state !== 'completed' || !same(parseJSON(delta.observed.final_text),delta.expected) ? 'rejected_candidate' : 'accepted_candidate') : 'inconclusive';
    let result = validateReport(this.report,evidence);
    this.report.verdict = result.verdict;
    result = validateReport(this.report,evidence);
    this.report.assessment = result;
    await this.save();
    if (result.missing.length || !result.valid) await this.log('ERROR','qualification.evidence_incomplete',{missing:result.missing,errors:result.errors,outcome:result.verdict});
    await this.log('INFO','qualification.finished',{verdict:result.verdict,observed_result:result.observed_result,context_strategy:this.report.context_strategy});
    return result;
  }
}

function parseJSON(value) { try { return JSON.parse(value); } catch { return undefined; } }
