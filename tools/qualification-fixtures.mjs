import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, need } from './qualification-evidence.mjs';
import { requiredCases } from './qualification-report.mjs';

export function exportFixture(events) {
  const rows = [];
  for (const [index,event] of events.entries()) {
    const payload = Buffer.from(JSON.stringify(event)), chunks = Math.ceil(payload.length/2048);
    for (let chunk = 0; chunk < chunks; chunk++) rows.push({type:'event',capture_id:`synthetic-${index}`,time:event.time,event:event.msg,level:event.level,operation_id:event.operation_id,request_id:event.request_id,chunk,chunks,payload_sha256:hash(payload),data_base64:payload.subarray(chunk*2048,(chunk+1)*2048).toString('base64')});
  }
  return [JSON.stringify({type:'export',complete:true,captures:events.length,omissions:[]}),...rows.map(row=>JSON.stringify(row))].join('\n')+'\n';
}

export function completeFixture(caseIDs = requiredCases) {
  const t = seconds => new Date(Date.UTC(2026,0,1)+seconds*1000).toISOString();
  const observation = (kind,seconds,fields={}) => ({kind,time:t(seconds),observer:'synthetic-test-observer',source_ref:`synthetic-observation-${kind}-${seconds}`,...fields});
  const report = {schema_version:1,evidence_kind:'synthetic',run_id:'synthetic-run',worker_id:'worker-1',started_at:t(1),finished_at:t(3000),setup_ended_at:t(0),settings:{idle_seconds:120,turn_seconds:300},source:{service_sha:'a'.repeat(40),image_digest:'sha256:'+'b'.repeat(64),worker_version:'0.1.0-rc.0',worker_sha256:'c'.repeat(64)},cases:[],observations:[observation('setup_ended',0,{worker_id:'worker-1',hook_id:'hook-1',consumer_count:1,interval_seconds:5,state_mode:'0700',key_file_mode:'0600',actual_permissions:['synthetic-shell','synthetic-hook']})],exports:[],context_strategy:{baseline:'full',delta:'accepted_candidate'},verdict:'inconclusive'};
  const evidence = [], files = new Map();
  report.status_receipt = {ready:true,build:{revision:report.source.service_sha,dirty:false},configuration:{worker_package:{version:report.source.worker_version,sha256:report.source.worker_sha256}}};
  const add = (source,id,events) => {
    const file = `${source}-${id}.ndjson`,raw = exportFixture(events);
    files.set(file,raw); const ref = {source,case_id:id,file,sha256:hash(raw)};
    report.exports.push(ref); evidence.push({...ref,events,metadata:{type:'export',complete:true,captures:events.length,omissions:[]}});
  };
  for (const [index,id] of caseIDs.entries()) {
    let start = 130+index*200;
    if (id === 'interleave-a') start = 1400;
    if (id === 'interleave-b') start = 1530;
    if (id === 'replay') start = 2100;
    if (id === 'refresh') start = 2700;
    const kind = id.startsWith('readiness') ? 'readiness' : id === 'replay' ? 'replay' : 'tool';
    const fixture = kind === 'tool' ? {id:`fixture-${id}`,owner:'client_driver',path:`client-only-${id}.txt`,contents:`unpredictable-synthetic-value-${id}\n`,created_at:t(start)} : undefined;
    const expected = id === 'replay' ? report.cases.find(item=>item.id==='full').expected : {session:`session-${id}`,value:fixture?.contents};
    const challenge = kind === 'readiness' ? `readiness-challenge-${id}` : undefined;
    const messages = id === 'replay' ? [...report.cases.find(item=>item.id==='full').observed.messages,{type:'message',role:'user',text:'Repeat the previous final exactly.'}] : [{type:'message',role:'system',text:`Only client tools; session session-${id}.`},{type:'message',role:'user',text:fixture?.path ?? challenge}];
    const request = {protocol_version:1,submission_id:`create-${id}`,worker_id:'worker-1',messages,tools:fixture ? [{name:'read_file',parameters:{type:'object'}}] : []};
    if (id === 'replay') request.tools = report.cases.find(item=>item.id==='full').request.tools;
    const base = {id:`experiment-${id}`,conversation_id:`conversation-${id}`,worker_id:'worker-1',current_job_id:`job-${id}-1`,messages,state:'queued'};
    const finalText = kind === 'readiness' ? challenge : JSON.stringify(expected);
    const call = {type:'tool_call',call_id:`call-${id}`,name:'read_file',arguments:{path:fixture?.path}};
    const result = {type:'tool_result',call_id:call.call_id,output:fixture?.contents};
    const appended = fixture ? [call,result,{type:'message',role:'assistant',text:finalText}] : [{type:'message',role:'assistant',text:finalText}];
    const firstContext = {receipt_id:base.current_job_id,kind:'full',base_prefix:0,history_count:messages.length,canonical_sha256:hash(JSON.stringify(messages)),messages,tools:request.tools};
    const secondMessages = id === 'delta' ? [call,result] : [...messages,call,result];
    const secondContext = {receipt_id:`job-${id}-2`,kind:id==='delta'?'delta':'full',base_prefix:id==='delta'?messages.length:0,history_count:messages.length+2,canonical_sha256:hash(JSON.stringify([...messages,call,result])),messages:secondMessages,tools:request.tools,...(id==='delta'?{base_receipt_id:firstContext.receipt_id,base_sha256:firstContext.canonical_sha256}:{})};
    const secondStart = id === 'interleave-a' ? 1540 : id === 'interleave-b' ? 1550 : start+2;
    const end = fixture ? secondStart+1 : start+1;
    const turns = [{job_id:firstContext.receipt_id,started_at:t(start),finished_at:t(start+1),context:firstContext},...(fixture?[{job_id:secondContext.receipt_id,started_at:t(secondStart),finished_at:t(end),context:secondContext}]:[])];
    const item = {id,kind,worker_id:'worker-1',experiment_id:base.id,conversation_id:base.conversation_id,started_at:t(start),finished_at:t(end),session_marker:expected.session,fixture,expected,challenge,request,initial:base,observed:{...base,state:'completed',messages:[...messages,...appended],final_text:finalText},turns,last_boundary:'completed'};
    if (fixture) item.tool_result_request = {protocol_version:1,submission_id:`result-${id}`,call_id:call.call_id,output:fixture.contents,...(id==='delta'?{context_probe:{kind:'delta',base_receipt_id:firstContext.receipt_id}}:{})};
    report.cases.push(item);
    report.observations.push(observation('quiet_window',start,{case_id:id,started_at:t(start-120),ended_at:t(start),exclusive:true}));
    const b = [],w = [];
    for (const [turnIndex,turn] of turns.entries()) {
      const common = {time:turn.started_at,level:'DEBUG',operation_id:item.experiment_id,conversation_id:item.conversation_id,worker_id:item.worker_id,job_id:turn.job_id};
      b.push({...common,msg:'inference.context',context:turn.context,canonical_messages:turnIndex ? [...messages,call,result]:messages});
      b.push({...common,time:turn.finished_at,level:'INFO',msg:'decision.accepted',decision_type:fixture && turnIndex===0?'tool_call':'final',call_id:fixture && turnIndex===0?call.call_id:''});
      w.push({...common,msg:'worker.context',context:turn.context});
      w.push({...common,level:'INFO',msg:'setup.wake_emitted',jobs:[{job_id:turn.job_id,conversation_id:item.conversation_id}]});
      report.observations.push(observation('model_turn',Date.parse(turn.finished_at)/1000-Date.UTC(2026,0,1)/1000,{case_id:id,job_id:turn.job_id,native_conversation_id:id==='replay'?'fresh-native':'original-native',account_memory_observation:'Synthetic fixture; no account was accessed.',effective_instructions:messages.filter(message=>['system','developer'].includes(message.role))}));
    }
    b.push({time:t(end),level:'DEBUG',msg:'inference.exchange',operation:'read',operation_id:item.experiment_id,conversation_id:item.conversation_id,worker_id:item.worker_id,output:item.observed});
    add('broker',id,b); add('worker',id,w);
  }
  report.observations.push(observation('fresh_conversation',1900,{native_conversation_id:'fresh-native'}));
  report.observations.push(observation('refresh_approval',2400,{owner:true,scope:'synthetic supported runtime refresh',destructive:false}));
  report.observations.push(observation('refresh_performed',2410,{scope:'synthetic supported runtime refresh'}));
  report.observations.push(observation('refresh_reconnected',2420,{worker_id:report.worker_id,hook_id:'hook-1',consumer_count:1,state_mode:'0700',key_file_mode:'0600',reinstalled:false,reenrolled:false,manual_message:false}));
  add('worker','all',[{time:t(2415),level:'INFO',msg:'setup.subscriber_started',worker_id:report.worker_id}]);
  return {report,evidence,files};
}

export async function writeFixture(directory, invalid = false) {
  const {report,files} = completeFixture();
  if (invalid) { report.verdict = 'pass'; report.cases = report.cases.filter(item=>item.id!=='refresh'); }
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  for (const [name,raw] of files) await fs.writeFile(resolve(directory,name),raw,{mode:0o600});
  // Invalid fixtures stay synthetic; a nominal pass is deliberately unsupported.
  report.evidence_kind = 'synthetic';
  await fs.writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  need(process.argv[2] && process.argv.length <= 4 && (!process.argv[3] || process.argv[3] === '--invalid'),'usage_fixture_directory_optional_invalid');
  await writeFixture(resolve(process.argv[2]),process.argv[3] === '--invalid');
}
