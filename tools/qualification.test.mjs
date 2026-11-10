import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Collector } from './qualification-collector.mjs';
import { decodeExport, hash, openEvidence, privateRead, publicOrigin, readExports } from './qualification-evidence.mjs';
import { validateReport } from './qualification-report.mjs';
import { completeFixture, exportFixture, writeFixture } from './qualification-fixtures.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(join(tmpdir(),'aaa-muse-qualification-test-'));
  async function remove(path) {
    for (const entry of await fs.readdir(path,{withFileTypes:true})) {
      const child = join(path,entry.name);
      if (entry.isDirectory()) await remove(child); else await fs.unlink(child);
    }
    await fs.rmdir(path);
  }
  t.after(()=>remove(root));
  return root;
}

test('complete synthetic receipts validate all required behaviors without qualifying live Muse',()=>{
  const {report,evidence} = completeFixture(), result = validateReport(report,evidence);
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.missing,[]);
  assert.ok(result.cases.every(item=>item.failed.length===0));
  assert.equal(result.observed_result,'pass');
  assert.equal(result.verdict,'inconclusive');
});

test('readiness must deliver the independent challenge even when all captures agree',async()=>{
  const {report,evidence,files}=completeFixture(),item=report.cases[0];
  item.turns[0].context.messages=[];item.turns[0].context.history_count=0;
  for(const ref of evidence){
    const raw=exportFixture(ref.events);files.set(ref.file,raw);report.exports.find(entry=>entry.file===ref.file).sha256=hash(raw);
  }
  const decoded=await readExports(report,async name=>files.get(name));
  const result=validateReport(report,decoded);
  assert.notEqual(result.observed_result,'pass');
  assert.ok(result.cases[0].failed.includes('readiness:initial_full_delivery'));
});

test('nominal passes require every context, recovery and unattended receipt',()=>{
  const mutations = [
    r=>{r.cases=r.cases.filter(item=>item.id!=='refresh');},
    r=>{r.observations=r.observations.filter(entry=>entry.kind!=='fresh_conversation');},
    r=>{r.observations=r.observations.filter(entry=>entry.kind!=='model_turn');},
    r=>{r.observations=r.observations.filter(entry=>entry.kind!=='refresh_approval');},
    r=>{r.observations.find(entry=>entry.kind==='refresh_reconnected').consumer_count=2;},
    r=>{r.observations.find(entry=>entry.kind==='refresh_reconnected').key_file_mode='0644';},
    r=>{r.observations.find(entry=>entry.kind==='refresh_reconnected').reenrolled=true;},
    r=>{r.observations.find(entry=>entry.kind==='quiet_window').started_at=r.cases[0].started_at;},
    r=>{r.observations.push({kind:'intervention',time:r.cases[1].started_at});},
    r=>{r.observations.find(entry=>entry.kind==='model_turn' && entry.case_id==='replay').native_conversation_id='original-native';},
    r=>{r.cases.find(item=>item.id==='trial-1').fixture.owner='muse_vm';},
    r=>{r.status_receipt.build.dirty=true;},
    r=>{r.cases.find(item=>item.id==='delta').turns[1].context.base_sha256='d'.repeat(64);},
    r=>{r.cases.find(item=>item.id==='full').turns[1].context.messages=[];},
    r=>{r.cases.find(item=>item.id==='trial-1').kind='readiness';},
    r=>{r.cases.find(item=>item.id==='replay').turns[0].context.messages=[];},
    r=>{r.cases.find(item=>item.id==='replay').turns[0].context.kind='unknown';},
    r=>{const item=r.cases.find(item=>item.id==='replay');item.expected={session:'invented',value:'invented'};item.observed.final_text=JSON.stringify(item.expected);item.observed.messages.at(-1).text=item.observed.final_text;},
  ];
  for (const mutate of mutations) {
    const {report,evidence} = completeFixture(); mutate(report); report.verdict='pass';
    const result=validateReport(report,evidence);
    assert.equal(result.valid,false);
    assert.notEqual(result.observed_result,'pass');
    assert.ok(result.errors.includes('claimed_verdict_not_supported'));
  }
});

test('wrong client values, duplicate histories and mismatched calls cannot pass',()=>{
  for (const change of [
    item=>{item.observed.messages.at(-2).call_id='foreign-call';},
    item=>{item.observed.messages.at(-2).output='invented-result';},
    item=>{item.observed.messages.at(-3).name='run_shell';},
    item=>{item.observed.messages.at(-3).arguments.path='vm-file';},
    item=>{item.observed.messages.push(item.observed.messages.at(-1));},
    item=>{item.observed.final_text=JSON.stringify({session:'another-session',value:item.fixture.contents});},
    item=>{item.turns[1].finished_at=new Date(Date.parse(item.turns[1].started_at)+300001).toISOString();},
  ]) {
    const {report,evidence}=completeFixture(); change(report.cases.find(item=>item.id==='trial-1'));
    assert.notEqual(validateReport(report,evidence).observed_result,'pass');
  }
});

test('a rejected delta candidate does not invalidate complete full-history evidence',()=>{
  const {report,evidence}=completeFixture();
  const delta=report.cases.find(item=>item.id==='delta');delta.observed.final_text='wrong delta result';delta.observed.messages.at(-1).text='wrong delta result';
  report.context_strategy.delta='rejected_candidate';
  const result=validateReport(report,evidence);
  assert.equal(result.observed_result,'pass');
  assert.equal(result.verdict,'inconclusive');
  assert.ok(result.cases.find(item=>item.id==='delta').failed.length);
});

test('conclusive failure requires reproducible complete evidence; missing access is inconclusive',()=>{
  const {report,evidence}=completeFixture();
  report.cases[1].observed.final_text='wrong-result-1';report.cases[1].observed.messages.at(-1).text='wrong-result-1';
  assert.equal(validateReport(report,evidence).observed_result,'inconclusive');
  report.cases[2].observed.final_text='wrong-result-2';report.cases[2].observed.messages.at(-1).text='wrong-result-2';
  assert.equal(validateReport(report,evidence).observed_result,'fail');
  const missing=evidence.filter(entry=>entry.source!=='worker');
  assert.equal(validateReport(report,missing).observed_result,'inconclusive');
});

test('two independent failed readiness challenges can conclude failure before downstream cases',()=>{
  const {report,evidence}=completeFixture(['readiness','readiness-repeat']);
  for(const item of report.cases){item.observed.final_text='incorrect challenge reply';item.observed.messages.at(-1).text=item.observed.final_text;}
  assert.equal(validateReport(report,evidence).observed_result,'fail');
  report.cases[1].challenge=report.cases[0].challenge;
  assert.ok(validateReport(report,evidence).errors.includes('readiness_reproduction_not_independent'));
});

test('unsubmitted client results are missing evidence rather than model failures',()=>{
  const {report,evidence}=completeFixture();
  for(const item of report.cases.slice(1,3)){
    item.observed.state='cancelled';item.observed.messages=item.observed.messages.slice(0,item.request.messages.length+1);delete item.observed.final_text;delete item.tool_result_request;item.turns=item.turns.slice(0,1);
  }
  const result=validateReport(report,evidence);
  assert.equal(result.observed_result,'inconclusive');assert.ok(result.missing.includes('trial-1:client_result_not_supplied'));
});

test('negative native observations never qualify a completed case',()=>{
  const {report,evidence}=completeFixture(),item=report.cases[0];
  report.observations=report.observations.filter(entry=>!(entry.kind==='model_turn' && entry.case_id===item.id));
  for(const turn of item.turns)report.observations.push({kind:'no_model_turn',time:turn.finished_at,observer:'synthetic-observer',source_ref:'synthetic-continuous-recording',case_id:item.id,job_id:turn.job_id,started_at:turn.started_at,ended_at:turn.finished_at,last_boundary:item.last_boundary});
  const worker=evidence.find(ref=>ref.source==='worker'&&ref.case_id===item.id);worker.events=[];
  const result=validateReport(report,evidence);
  assert.notEqual(result.observed_result,'pass');
  assert.ok(result.cases[0].failed.includes('readiness:contradictory_native_observation'));
  assert.ok(result.cases[0].missing.includes('readiness:native_model_turn'));
});

test('report failure labels cannot override successful authenticated receipts',()=>{
  const {report,evidence}=completeFixture();report.cases[1].failure='wrong_environment';report.cases[2].failure='wrong_environment';
  assert.equal(validateReport(report,evidence).observed_result,'pass');
});

test('duplicate call IDs are rejected by the real verdict logic',()=>{
  const {report,evidence}=completeFixture(),item=report.cases[1];
  const call=item.observed.messages.find(message=>message.type==='tool_call');
  item.observed.messages.splice(item.request.messages.length+1,0,{...call});
  const result=validateReport(report,evidence);
  assert.ok(result.errors.includes('duplicate_call_id'));
  assert.ok(result.cases.find(entry=>entry.id===item.id).failed.includes(`${item.id}:tool_linkage`));
});

test('fresh native conversation and interleaved session boundaries are independently checked',()=>{
  const {report,evidence}=completeFixture();
  const b=report.cases.find(item=>item.id==='interleave-b'); b.conversation_id=report.cases.find(item=>item.id==='interleave-a').conversation_id;
  assert.ok(validateReport(report,evidence).errors.includes('sessions_not_interleaved'));
  const {report:r,evidence:e}=completeFixture(); r.cases.find(item=>item.id==='replay').request.messages=[];
  assert.ok(validateReport(r,e).cases.find(item=>item.id==='replay').failed.includes('replay:canonical_replay'));
});

test('report validator rejects malformed structure instead of accepting or crashing',()=>{
  for (const value of [null,{},[],{schema_version:1}, {...completeFixture().report,cases:[null]}]) assert.equal(validateReport(value).valid,false);
});

test('capture reconstruction detects missing, duplicate, corrupt and oversized chunks',async()=>{
  const raw=exportFixture([{time:'2026-01-01T00:00:00.000Z',level:'DEBUG',msg:'large.exchange',operation_id:'op',text:'context-'.repeat(1000)}]);
  assert.equal(decodeExport(raw).events[0].text,'context-'.repeat(1000));
  const rows=raw.trim().split('\n');
  for (const broken of [rows.slice(0,-1).join('\n'),[...rows,rows[1]].join('\n'),raw.replace('"complete":true','"complete":false'),raw.replace('"captures":1','"captures":2')]) assert.throws(()=>decodeExport(broken));
  const row=JSON.parse(rows[1]); row.data_base64=Buffer.from('changed').toString('base64');
  assert.throws(()=>decodeExport([rows[0],JSON.stringify(row),...rows.slice(2)].join('\n')),/capture_digest_mismatch/);
  row.data_base64='x'.repeat(7000);assert.throws(()=>decodeExport([rows[0],JSON.stringify(row)].join('\n')),/capture_chunk_too_large/);
  const {report,files}=completeFixture();
  const evidence=await readExports(report,async name=>files.get(name)+' ');
  assert.ok(evidence.every(item=>item.error==='export_digest_mismatch'));
});

test('CLI validates explicit synthetic positive and negative fixtures without a live-pass claim',async t=>{
  const root=await temporary(t),good=join(root,'good'),bad=join(root,'bad');
  await writeFixture(good);await writeFixture(bad,true);
  const positive=spawnSync(process.execPath,['tools/qualify.mjs','validate-report','--report',join(good,'report.json'),'--synthetic'],{encoding:'utf8'});
  assert.equal(positive.status,0,positive.stderr);
  assert.equal(JSON.parse(positive.stdout).verdict,'inconclusive');
  assert.equal(JSON.parse(positive.stdout).observed_result,'pass');
  const negative=spawnSync(process.execPath,['tools/qualify.mjs','validate-report','--report',join(bad,'report.json'),'--synthetic'],{encoding:'utf8'});
  assert.equal(negative.status,1);
  assert.ok(JSON.parse(negative.stdout).errors.includes('claimed_verdict_not_supported'));
});

test('CLI masks credential-shaped text in invalid report diagnostics',async t=>{
  const root=await temporary(t);await writeFixture(root);
  const path=join(root,'report.json'),report=JSON.parse(await fs.readFile(path,'utf8'));
  const canary='muse_worker_'+'A'.repeat(43);
  report.cases.push({...report.cases[1],id:canary});
  await fs.writeFile(path,JSON.stringify(report));
  const result=spawnSync(process.execPath,['tools/qualify.mjs','validate-report','--report',path,'--synthetic'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.ok(!result.stdout.includes(canary));assert.ok(result.stdout.includes('[REDACTED]'));
});

test('private inputs and HTTPS origin prevent credential exposure or redirects',async t=>{
  const root=await temporary(t),file=join(root,'header');
  await fs.writeFile(file,'Authorization: Bearer synthetic-private-key\n',{mode:0o600});
  assert.equal(await privateRead(file),'Authorization: Bearer synthetic-private-key\n');
  await fs.chmod(file,0o644);await assert.rejects(privateRead(file),/private_file_unsafe/);
  await fs.chmod(file,0o600);await fs.symlink(file,join(root,'link'));await assert.rejects(privateRead(join(root,'link')),/private_file_unsafe/);
  for(const origin of ['http://broker.test','https://user:password@broker.test','https://broker.test/path','https://broker.test?key=x']) assert.throws(()=>publicOrigin(origin));
  assert.equal(publicOrigin('https://broker.test/'),'https://broker.test');
});

async function harness(t,{mode='normal'}={}) {
  const root=await temporary(t);let clock=Date.UTC(2026,0,2),sequence=0;
  const logs=[],requests=[],experiments=new Map();
  const observations=join(root,'observations.json'),workerExports=[];
  const entries=[{kind:'setup_ended',time:new Date(clock-1000).toISOString(),worker_id:'worker-1',observer:'synthetic',source_ref:'synthetic-setup'}, {kind:'artifact_identity',time:new Date(clock-1000).toISOString(),observer:'synthetic',source_ref:'synthetic-image',service_sha:'a'.repeat(40),image_digest:'sha256:'+'b'.repeat(64)}];
  const writeObservations=()=>fs.writeFile(observations,JSON.stringify({schema_version:1,entries,worker_exports:workerExports}),{mode:0o600});
  await writeObservations();
  const stamp=()=>new Date(clock).toISOString();
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=text?JSON.parse(text):undefined;
    requests.push({path:req.url,method:req.method,body,authorization:req.headers.authorization});
    res.setHeader('Content-Type','application/json');res.setHeader('X-Request-Id',`request-${++sequence}`);
    if(req.url==='/api/v1/admin/status')return res.end(JSON.stringify({ready:true,echo:req.headers.authorization,build:{revision:'a'.repeat(40),dirty:false},configuration:{worker_package:{version:'0.1.0-rc.0',sha256:'c'.repeat(64)},limits:{max_jobs:2,in_flight_per_worker:1}}}));
    if(req.url==='/api/v1/admin/workers')return res.end(JSON.stringify({workers:[{id:'worker-1',connection_status:'online',work_status:'idle',current_job:null}]}));
    if(req.url==='/api/v1/admin/experiments'){
      if(body.messages.some(message=>message.type==='tool_call'&&!body.tools.some(tool=>tool.name===message.name))){res.statusCode=400;return res.end('{"error":"unknown_tool"}');}
      const id=`exp-${sequence}`,job=`job-${sequence}`;
      const context={receipt_id:job,kind:'full',base_prefix:0,history_count:body.messages.length,canonical_sha256:hash(JSON.stringify(body.messages)),messages:body.messages,tools:body.tools};
      const exp={id,worker_id:'worker-1',conversation_id:`conv-${sequence}`,current_job_id:job,messages:body.messages,state:'queued'};
      experiments.set(id,{exp,body,contexts:[{time:stamp(),level:'DEBUG',msg:'inference.context',job_id:job,operation_id:id,worker_id:'worker-1',conversation_id:exp.conversation_id,context}],polls:0});
      return res.end(JSON.stringify(exp));
    }
    if(req.url.startsWith('/api/v1/admin/diagnostics/export?')){
      const id=new URL(req.url,'http://fixture').searchParams.get('operation_id'),saved=experiments.get(id);
      return res.end(exportFixture([...saved.contexts,{time:stamp(),level:'DEBUG',msg:'inference.exchange',operation:'read',operation_id:id,conversation_id:saved.exp.conversation_id,worker_id:'worker-1',output:saved.exp}]));
    }
    const [,id,action]=req.url.match(/^\/api\/v1\/admin\/experiments\/([^/]+)(?:\/(.*))?$/)??[];
    const saved=experiments.get(id);if(!saved){res.statusCode=404;return res.end('{}');}
    if(action==='cancel'){saved.exp={...saved.exp,state:'cancelled'};return res.end(JSON.stringify(saved.exp));}
    if(action==='tool-results'){
      const previous=saved.contexts[0].context,call=saved.exp.messages.at(-1);
      const result={type:'tool_result',call_id:body.call_id,output:body.output};
      saved.exp={...saved.exp,state:'completed',current_job_id:`${previous.receipt_id}-continuation`,messages:[...saved.exp.messages,result]};
      const marker=/session must equal ([a-f0-9]+)/.exec(saved.body.messages[0].text)?.[1];
      const answer=mode==='wrong-final'?'wrong-final-result':JSON.stringify({session:marker,value:body.output});
      saved.exp.final_text=answer;saved.exp.messages.push({type:'message',role:'assistant',text:answer});
      const context={receipt_id:saved.exp.current_job_id,kind:body.context_probe?'delta':'full',base_prefix:body.context_probe?previous.history_count:0,history_count:previous.history_count+2,canonical_sha256:hash(answer),messages:body.context_probe?[call,result]:[...saved.body.messages,call,result],tools:saved.body.tools,...(body.context_probe?{base_receipt_id:previous.receipt_id,base_sha256:previous.canonical_sha256}:{})};
      saved.contexts.push({time:stamp(),level:'DEBUG',msg:'inference.context',job_id:context.receipt_id,operation_id:id,conversation_id:saved.exp.conversation_id,worker_id:'worker-1',context});
      return res.end(JSON.stringify(saved.exp));
    }
    saved.polls++;
    if(mode==='late')clock+=300001;
    if(mode==='early-interruption'){saved.exp={...saved.exp,state:'interrupted',reason:'lease_expired'};return res.end(JSON.stringify(saved.exp));}
    if(mode!=='timeout'&&saved.exp.state==='queued'){
      if(mode==='no-tool' || !saved.body.tools.length || saved.body.messages.at(-1).text.startsWith('Using only the supplied canonical history')){
        const answer=saved.body.tools.length?saved.body.messages.at(-2).text:saved.body.messages.at(-1).text;
        saved.exp={...saved.exp,state:'completed',final_text:answer,messages:[...saved.exp.messages,{type:'message',role:'assistant',text:answer}]};
      }
      else {const call={type:'tool_call',call_id:'synthetic-call',name:mode==='wrong-tool'?'shell':'read_file',arguments:{path:saved.body.tools[0].parameters.properties.path.enum[0]}};saved.exp={...saved.exp,state:'waiting_for_tool',messages:[...saved.exp.messages,call,...(mode==='duplicate-call'?[{...call}]:[])]};}
    }
    return res.end(JSON.stringify(saved.exp));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const realOrigin=`http://127.0.0.1:${server.address().port}`;
  const evidence=await openEvidence(join(root,'evidence'),{now:()=>clock,stderr:line=>logs.push(line)});
  const collector=new Collector({...evidence,evidenceKind:'synthetic',origin:'https://broker.test',workerID:'worker-1',header:'Authorization: Bearer synthetic-private-key\n',observations,now:()=>clock,wait:async ms=>{clock+=ms;},random:()=>String(++sequence).padStart(48,'a'),uuid:()=>`operation-${++sequence}`,fetcher:(url,options)=>fetch(realOrigin+new URL(url).pathname+new URL(url).search,options)});
  return {collector,evidence,requests,logs,experiments,root,entries,workerExports,writeObservations,advance:ms=>{clock+=ms;},stamp};
}

test('collector exercises real HTTP client-tool continuation and never posts worker decisions',async t=>{
  const h=await harness(t);await h.collector.initialize();await h.collector.runCase('trial-1');
  const item=h.collector.report.cases[0];
  assert.equal(item.turns.length,2);
  assert.equal(h.collector.report.evidence_kind,'synthetic');
  assert.equal(item.tool_result_request.output,item.fixture.contents);
  assert.equal(item.observed.state,'completed');
  assert.equal(h.requests.filter(req=>req.path.endsWith('/tool-results')).length,1);
  assert.ok(h.requests.every(req=>req.path.startsWith('/api/v1/admin/')));
  assert.ok(h.requests.every(req=>req.authorization==='Bearer synthetic-private-key'));
  assert.equal(item.turns[1].context.kind,'full');
  assert.ok(item.turns[1].context.messages.some(message=>message.type==='tool_result'&&message.output===item.fixture.contents));
  await assert.rejects(h.collector.result(item),/wrong_tool_or_arguments/);
  const before=h.requests.length;await h.collector.runCase('trial-1');assert.equal(h.requests.length,before);
});

test('collector refuses wrong environment tools, retains evidence and cancels only its experiment',async t=>{
  const h=await harness(t,{mode:'wrong-tool'});await h.collector.initialize();
  await assert.rejects(h.collector.runCase('trial-1'),/wrong_tool_or_arguments/);
  assert.equal(h.requests.filter(req=>req.path.endsWith('/tool-results')).length,0);
  assert.equal(h.requests.filter(req=>req.path.endsWith('/cancel')).length,1);
  assert.ok(h.collector.report.cases[0].finished_at);
  assert.ok(h.logs.some(line=>JSON.parse(line).msg==='qualification.decision_failed'));
});

test('collector bounds a stalled turn, captures causal diagnostics and never acknowledges native idle',async t=>{
  const h=await harness(t,{mode:'timeout'});await h.collector.initialize();await h.collector.runCase('readiness','readiness');
  const item=h.collector.report.cases[0];
  assert.equal(Date.parse(item.turns[0].finished_at)-Date.parse(item.turns[0].started_at),300000);
  assert.equal(item.failure,'turn_deadline');assert.equal(item.observed.state,'cancelled');
  assert.ok(h.logs.some(line=>JSON.parse(line).msg==='qualification.wake_failed'));
  assert.ok(h.requests.every(req=>!req.path.includes('heartbeat')));
  const decoded=decodeExport(await h.evidence.capture.export({},false));
  const failed=decoded.events.find(event=>event.msg==='qualification.wake_failed');
  assert.equal(failed.last_boundary,'queued');assert.equal(failed.elapsed_ms,300000);
  assert.ok(decoded.events.some(event=>event.msg==='qualification.http_exchange'&&event.level==='DEBUG'));
  assert.ok(!h.logs.some(line=>JSON.parse(line).level==='DEBUG'));
  assert.ok(!JSON.stringify(decoded).includes('synthetic-private-key'));
  assert.ok(JSON.stringify(decoded).includes('[REDACTED]'));
  assert.ok(!(await h.evidence.state.read('report.json')).includes('synthetic-private-key'));
});

test('collector resumes without replaying accepted work and rejects unfinished side effects',async t=>{
  const h=await harness(t);await h.collector.initialize();await h.collector.runCase('readiness','readiness');
  const count=h.requests.length;await h.collector.initialize();await h.collector.runCase('readiness','readiness');assert.equal(h.requests.length,count);
  h.collector.report.cases.push({id:'trial-1',last_boundary:'create_pending'});await h.collector.save();
  await assert.rejects(h.collector.initialize(),/unfinished_case_requires_evidence_review_new_run/);
});

test('replay preserves admissible canonical tools and never re-executes the client fixture',async t=>{
  const h=await harness(t);await h.collector.initialize();await h.collector.runCase('full');
  const original=h.collector.report.cases[0],count=h.requests.filter(req=>req.path.endsWith('/tool-results')).length;
  await h.collector.runCase('replay','replay',original);
  const replay=h.collector.report.cases[1];
  assert.deepEqual(replay.request.tools,original.request.tools);
  assert.deepEqual(replay.request.messages.slice(0,-1),original.observed.messages);
  assert.equal(replay.observed.state,'completed');assert.equal(replay.observed.final_text,original.observed.final_text);
  assert.equal(h.requests.filter(req=>req.path.endsWith('/tool-results')).length,count);
});

test('duplicate waiting receipts and duplicate call history cannot execute another tool',async t=>{
  const h=await harness(t);await h.collector.initialize();await h.collector.runCase('trial-1');
  const item=h.collector.report.cases[0],call=item.observed.messages.find(message=>message.type==='tool_call');
  h.experiments.get(item.experiment_id).exp={...item.observed,state:'waiting_for_tool',messages:[...item.request.messages,call]};
  item.observed=await h.collector.api(`/api/v1/admin/experiments/${item.experiment_id}`);
  const count=h.requests.filter(req=>req.path.endsWith('/tool-results')).length;
  await assert.rejects(h.collector.result(item),/duplicate_tool_execution/);
  assert.equal(h.requests.filter(req=>req.path.endsWith('/tool-results')).length,count);
  const duplicate=await harness(t,{mode:'duplicate-call'});await duplicate.collector.initialize();
  await assert.rejects(duplicate.collector.runCase('trial-1'),/duplicate_tool_execution/);
  assert.equal(duplicate.requests.filter(req=>req.path.endsWith('/tool-results')).length,0);
});

test('a response crossing the deadline cannot execute a fixture or submit a continuation',async t=>{
  const h=await harness(t,{mode:'late'});await h.collector.initialize();await h.collector.runCase('trial-1');
  assert.equal(h.collector.report.cases[0].failure,'turn_deadline');
  assert.equal(h.requests.filter(req=>req.path.endsWith('/tool-results')).length,0);
  assert.equal(h.requests.filter(req=>req.path.endsWith('/cancel')).length,1);
  assert.ok(h.logs.some(line=>JSON.parse(line).msg==='qualification.wake_failed'));
});

test('early interruption and a wrong completed answer emit complete protected diagnosis',async t=>{
  for(const mode of ['early-interruption','wrong-final']){
    const h=await harness(t,{mode});await h.collector.initialize();await h.collector.runCase('trial-1');
    const events=decodeExport(await h.evidence.capture.export({},false)).events;
    const event=events.find(entry=>entry.msg===(mode==='wrong-final'?'qualification.decision_failed':'qualification.wake_failed'));
    assert.equal(event.level,'WARN');assert.equal(event.case_id,'trial-1');assert.ok(event.operation_id);assert.ok(event.conversation_id);assert.ok(event.last_boundary);assert.equal(typeof event.elapsed_ms,'number');
    if(mode==='wrong-final')assert.ok(events.some(entry=>entry.msg==='qualification.answer_detail'&&entry.observed==='wrong-final-result'));
  }
});

test('interleaved final without its client tool emits the required warning and submits no result',async t=>{
  const h=await harness(t,{mode:'no-tool'});await h.collector.initialize();
  await assert.rejects(h.collector.interleave(),/wrong_tool_or_arguments/);
  assert.equal(h.requests.filter(req=>req.path.endsWith('/tool-results')).length,0);
  const events=decodeExport(await h.evidence.capture.export({},false)).events;
  const event=events.find(entry=>entry.msg==='qualification.decision_failed');
  assert.equal(event.level,'WARN');assert.equal(event.case_id,'interleave-a');assert.equal(event.cause,'wrong_tool_or_arguments');assert.ok(event.proposed);assert.ok(event.conversation_id);assert.ok(event.last_boundary);assert.equal(typeof event.elapsed_ms,'number');
});

test('missing and incomplete worker exports retain an incomplete assessment and protected causal evidence',async t=>{
  for(const mode of ['missing','incomplete']){
    const h=await harness(t);await h.collector.initialize();
    const file=join(h.root,'worker-export.ndjson');
    if(mode==='incomplete')await fs.writeFile(file,exportFixture([]).replace('"complete":true','"complete":false'),{mode:0o600});
    h.workerExports.push({case_id:'all',path:file});await h.writeObservations();
    const result=await h.collector.finalize();
    assert.equal(result.verdict,'inconclusive');assert.equal(result.observed_result,'inconclusive');
    assert.ok(result.missing.some(reason=>reason.startsWith('evidence_import_failed:worker:all:')));
    const saved=JSON.parse(await h.evidence.state.read('report.json'));assert.equal(saved.evidence_import_failures.length,1);
    const events=decodeExport(await h.evidence.capture.export({},false)).events;
    assert.ok(events.some(entry=>entry.msg==='qualification.evidence_incomplete'&&entry.level==='ERROR'&&entry.source==='worker'&&entry.capture_complete===false&&entry.cause===(mode==='missing'?'ENOENT':'capture_incomplete')));
  }
});

test('collector records correlated delta bases and truly interleaves two sessions',async t=>{
  const h=await harness(t);await h.collector.initialize();await h.collector.runCase('delta');
  const delta=h.collector.report.cases[0];assert.equal(delta.tool_result_request.context_probe.base_receipt_id,delta.turns[0].job_id);
  assert.equal(delta.turns[1].context.kind,'delta');
  await h.collector.interleave();
  const a=h.collector.report.cases.find(item=>item.id==='interleave-a'),b=h.collector.report.cases.find(item=>item.id==='interleave-b');
  assert.notEqual(a.conversation_id,b.conversation_id);
  assert.ok(Date.parse(a.turns[0].finished_at)<=Date.parse(b.started_at));
  assert.ok(Date.parse(b.turns[0].finished_at)<=Date.parse(a.turns[1].started_at));
});

test('missing native gates and exports leave a truthful inconclusive partial report',async t=>{
  const h=await harness(t);const result=await h.collector.collect('replay');
  assert.equal(result.verdict,'inconclusive');assert.equal(result.observed_result,'inconclusive');assert.equal(result.valid,true);
  assert.equal(h.requests.filter(req=>req.method==='POST').length,0);
  assert.ok(h.logs.some(line=>JSON.parse(line).msg==='qualification.evidence_incomplete'));
  const saved=JSON.parse(await h.evidence.state.read('report.json'));assert.equal(saved.verdict,'inconclusive');
});

test('explicit readiness reproduction uses a new challenge and never replays the failed assignment',async t=>{
  const h=await harness(t,{mode:'early-interruption'});await h.collector.initialize();await h.collector.runCase('readiness','readiness');
  await h.collector.collect('readiness-repeat');
  const [first,repeat]=h.collector.report.cases;
  assert.equal(repeat.id,'readiness-repeat');assert.notEqual(first.challenge,repeat.challenge);assert.notEqual(first.experiment_id,repeat.experiment_id);
  const count=h.requests.filter(req=>req.method==='POST').length;await h.collector.collect('readiness-repeat');assert.equal(h.requests.filter(req=>req.method==='POST').length,count);
});

test('interventions and changed client fixtures stop execution without fabricating a result',async t=>{
  const h=await harness(t);await h.collector.initialize();
  h.entries.push({kind:'intervention',time:new Date(Date.parse(h.stamp())+60000).toISOString(),observer:'synthetic',source_ref:'synthetic-manual-click'});await h.writeObservations();
  await assert.rejects(h.collector.begin('trial-1'),/intervention_during_quiet_window/);
  h.entries.pop();await h.writeObservations();
  const item=await h.collector.begin('trial-1');await h.collector.poll(item,'waiting_for_tool');
  await h.evidence.state.write(item.fixture.path,'changed-client-fixture');
  await assert.rejects(h.collector.result(item),/client_fixture_changed/);
  assert.equal(h.requests.filter(req=>req.path.endsWith('/tool-results')).length,0);
});
