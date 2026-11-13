import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Worker, Qualification, EnrollmentKind } from './worker-api';
import type { WorkersController, WorkersView } from './worker-controller';

export const timestamp = (value: string | null) => value ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'Not observed';
const states: Record<string, string> = { online: 'Online', offline: 'Offline', connecting: 'Connecting', not_observed: 'Not observed', idle: 'Idle', busy: 'Busy', unknown: 'Unknown', unverified: 'Not yet qualified', verified: 'Approved', withdrawn: 'Withdrawn', stale: 'Stale qualification' };
const stateName = (value: string) => states[value] ?? value;

function Correlation({ request, operation }: { request: string; operation: string }) {
  return <>{request && <p className="trace">Request <code>{request}</code></p>}{operation && <p className="trace">Operation <code>{operation}</code></p>}</>;
}

function QualificationDetail({ qualification }: { qualification: Qualification }) {
  return <dl className="identity-list qualification-facts">
    <div><dt>Approval action</dt><dd>{qualification.evidence.action}</dd></div>
    <div><dt>Evidence provenance</dt><dd>{qualification.evidence.evidence_kind === 'controlled' ? 'Controlled software evidence' : qualification.evidence.evidence_kind === 'live' ? 'Live trial evidence' : 'Not reported'}</dd></div>
    <div><dt>Recorded at</dt><dd>{timestamp(qualification.created_at)}</dd></div>
    <div><dt>Connection</dt><dd><code>{qualification.connection_id}</code> · generation {qualification.connection_generation}</dd></div>
    <div><dt>Capabilities</dt><dd>{qualification.capabilities.join(', ') || 'None approved'}</dd></div>
    <div><dt>Evidence reference</dt><dd>{qualification.evidence.evidence_reference}</dd></div>
  </dl>;
}

function WorkerDetail({ worker, controller, view, back }: { worker: Worker; controller: WorkersController; view: WorkersView; back: () => void }) {
  const [name, setName] = useState(worker.name);
  const [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const disabled = view.stale || !!view.pending;
  useEffect(() => { setName(worker.name); }, [worker.id, worker.name]);
  useEffect(() => { title.current?.focus(); }, [worker.id]);
  useEffect(() => { if (confirming) dialog.current?.showModal(); }, [confirming]);
  function rename(event: FormEvent) { event.preventDefault(); void controller.mutate('rename', worker.id, name); }
  function cancel() { dialog.current?.close(); setConfirming(false); }
  function revoke(event: FormEvent) { event.preventDefault(); cancel(); void controller.mutate('revoke', worker.id); }
  return <section className="worker-detail" aria-label="Worker detail">
    <button className="text-action" onClick={back} disabled={!!view.pending}>All workers</button>
    <div className="detail-heading"><div><h2 tabIndex={-1} ref={title}>{worker.name}</h2><code className="worker-id">{worker.id}</code></div><span>{worker.revoked_at ? 'Revoked registration' : 'Registered worker'}</span></div>
    <div className="worker-fact-grid">
      <section className="data-panel"><h3>Subscriber connection</h3><dl className="identity-list">
        <div><dt>Subscriber</dt><dd>{stateName(worker.connection_status)}</dd></div>
        <div><dt>Last contact</dt><dd>{timestamp(worker.last_contact_at)}</dd></div>
        <div><dt>Last heartbeat</dt><dd>{timestamp(worker.last_heartbeat_at)}</dd></div>
        <div><dt>Installed version</dt><dd>Not reported</dd></div>
      </dl><p className="field-note">Contact and heartbeat describe authenticated transport. They do not establish model readiness.</p></section>
      <section className="data-panel"><h3>Broker activity</h3><dl className="identity-list">
        <div><dt>Work state</dt><dd>{stateName(worker.work_status)}</dd></div>
        <div><dt>Current assignment</dt><dd>{worker.current_job ? <><code>{worker.current_job.job_id}</code> · generation {worker.current_job.generation}</> : 'None observed'}</dd></div>
        <div><dt>Client-tool waits</dt><dd className="num">{worker.waiting_for_client_tool}</dd></div>
        <div><dt>Background wake</dt><dd>Not independently observed</dd></div>
      </dl><p className="field-note">Busy means the broker retains an assignment. Tool waits depend on the calling client. Offline does not establish whether remote work stopped.</p></section>
      <section className="data-panel"><h3>Inference qualification</h3><p className="qualification-state">{stateName(worker.inference_readiness)}</p>
        {worker.qualification ? <QualificationDetail qualification={worker.qualification} /> : <p>No management-approved evidence is recorded.</p>}
        <p className="field-note">Controlled evidence proves software behavior. It does not establish live Muse qualification. Reconnecting requires fresh approval for the new connection generation.</p>
        {worker.qualification_history.length > 0 && <details><summary>Qualification history ({worker.qualification_history.length})</summary><ol className="qualification-history">{worker.qualification_history.map(item => <li key={item.id}><QualificationDetail qualification={item} /></li>)}</ol></details>}
      </section>
      <section className="data-panel"><h3>Registration and access</h3><dl className="identity-list">
        <div><dt>Registered</dt><dd>{timestamp(worker.registered_at)}</dd></div>
        <div><dt>Revoked</dt><dd>{worker.revoked_at ? timestamp(worker.revoked_at) : 'No'}</dd></div>
        <div><dt>Credential expiry</dt><dd>{worker.revoked_at ? 'Access revoked' : 'No automatic expiry; valid until revoked'}</dd></div>
      </dl><form className="rename-form" onSubmit={rename}><label htmlFor="worker-name">Display name</label><input id="worker-name" value={name} onChange={event => setName(event.target.value)} autoComplete="off" disabled={disabled} /><button type="submit" disabled={disabled}>{view.pending === 'rename' ? 'Saving…' : 'Save name'}</button></form>
        <p className="field-note">Names may be shared. The immutable worker ID determines identity and access.</p>
        <button className="danger-action" disabled={disabled || !!worker.revoked_at} onClick={() => setConfirming(true)}>{worker.revoked_at ? 'Access revoked' : 'Revoke worker'}</button>
      </section>
    </div>
    <dialog ref={dialog} aria-labelledby="revoke-title" aria-describedby="revoke-description" onCancel={() => setConfirming(false)} onClose={() => setConfirming(false)}>
      <h2 id="revoke-title">Revoke this worker?</h2><p className="confirm-identity">{worker.name}<br /><code>{worker.id}</code></p><p id="revoke-description">This blocks access for every copy of this worker credential. Registration and history are retained. Remote activity may remain unknown.</p>
      {view.stale && <p>Cancel and refresh worker state before revoking.</p>}
      <form onSubmit={revoke}><button type="button" autoFocus onClick={cancel}>Cancel</button><button type="submit" className="danger-action" disabled={disabled}>Confirm revocation</button></form>
    </dialog>
  </section>;
}

function EnrollmentPanel({ controller, view }: { controller: WorkersController; view: WorkersView }) {
  const [kind, setKind] = useState<EnrollmentKind>('prompt');
  const text = useRef<HTMLTextAreaElement>(null);
  const enrollment = view.enrollment;
  return <section className="enrollment-panel" aria-labelledby="enrollment-title">
    <div className="section-intro"><h2 id="enrollment-title">Enroll a worker</h2><p>Generate a private, single-use enrollment. Existing installations reconnect using their retained identity.</p></div>
    <div className="data-panel"><label htmlFor="enrollment-kind">Enrollment format</label><select id="enrollment-kind" value={kind} onChange={event => setKind(event.target.value as EnrollmentKind)} disabled={!!view.pending}>
      <option value="prompt">Complete Muse setup prompt</option><option value="code">Enrollment code only</option></select>
      <p className="field-note">Setup text includes the configured package pin and supported reconnection instructions. Each generation issues a new enrollment and replaces the text shown here.</p>
      <button className="primary" disabled={!!view.pending} onClick={() => void controller.createEnrollment(kind)}>{view.pending === 'enrollment' ? 'Generating…' : kind === 'prompt' ? 'Generate setup prompt' : 'Generate enrollment code'}</button>
      {view.enrollmentMessage && <p className="field-note" role="status">{view.enrollmentMessage}</p>}
      {enrollment && <div className="enrollment-result"><dl className="identity-list"><div><dt>Enrollment ID</dt><dd><code>{enrollment.enrollment_id}</code></dd></div><div><dt>Expires at</dt><dd>{timestamp(enrollment.expires_at)}</dd></div>
        {enrollment.worker_package && <><div><dt>Package pin</dt><dd>{enrollment.worker_package.version}</dd></div><div><dt>Archive SHA-256</dt><dd><code>{enrollment.worker_package.sha256}</code></dd></div></>}
      </dl><p className="field-note">Use once before expiry. This portal cannot confirm whether the code has already been used. Keep the copied text private.</p>
        <div className="copy-controls"><button onClick={() => void controller.copyEnrollment()}>Copy {view.enrollmentKind === 'prompt' ? 'complete prompt' : 'enrollment code'}</button><button onClick={() => { text.current?.focus(); text.current?.select(); }}>Select text</button></div>
        <label className="sr-only" htmlFor="enrollment-text">{view.enrollmentKind === 'prompt' ? 'Complete setup prompt' : 'Single-use enrollment code'}</label>
        <textarea id="enrollment-text" ref={text} data-sensitive="enrollment" readOnly spellCheck={false} autoComplete="off" value={enrollment.setup_prompt ?? enrollment.enrollment_code ?? ''} rows={view.enrollmentKind === 'prompt' ? 12 : 3} />
      </div>}
    </div>
  </section>;
}

export function Workers({ controller }: { controller: WorkersController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const selected = view.workers?.find(worker => worker.id === view.selectedID);
  const scroll = useRef(0);
  const list = useRef<HTMLHeadingElement>(null);
  function select(id: string) { scroll.current = window.scrollY; controller.select(id); }
  function back() { controller.select(''); requestAnimationFrame(() => { list.current?.focus({ preventScroll: true }); window.scrollTo(0, scroll.current); }); }
  return <main className="workers-page">
    <div className="page-heading"><div><p className="context-label">Worker management</p><h1 tabIndex={-1} ref={list}>Workers</h1><p className="page-purpose">See what the broker observed and manage worker access.</p></div><div className="refresh-control"><span>{view.lastGood === null ? 'No successful refresh yet' : `Last checked ${timestamp(new Date(view.lastGood).toISOString())}`}</span><button onClick={() => void controller.refresh()} disabled={view.loading || !!view.pending}>{view.loading ? 'Refreshing…' : 'Refresh workers'}</button></div></div>
    {view.stale && view.workers && <p className="snapshot-label">Stale snapshot · Refresh before changing worker access.</p>}
    {view.message && <div className="notice" role="status"><p>{view.message}</p><Correlation request={view.requestID} operation={view.operationID} /></div>}
    {view.actionMessage && <div className="notice" role="status"><p>{view.actionMessage}</p><Correlation request={view.actionRequestID} operation={view.actionOperationID} /></div>}
    {!view.actionMessage && view.actionRequestID && view.enrollmentMessage && <Correlation request={view.actionRequestID} operation={view.actionOperationID} />}
    {selected ? <WorkerDetail key={selected.id} worker={selected} controller={controller} view={view} back={back} /> : <section className="worker-list" aria-label="Registered workers" aria-busy={view.loading}>
      <p className="scope-note">Subscriber health, broker activity and inference qualification are independent observations. Hidden Muse activity is not observable here.</p>
      {view.workers === null ? <p className="empty-state">{view.loading ? 'Loading registered workers…' : 'Worker information is unavailable. Use Refresh workers to retry.'}</p> : view.workers.length === 0 ? <p className="empty-state">No workers are registered. Generate setup text below to enroll the first worker.</p> :
        <table className="workers-table"><thead><tr><th scope="col">Worker identity</th><th scope="col">Subscriber</th><th scope="col">Broker activity</th><th scope="col">Qualification</th></tr></thead><tbody>{view.workers.map(worker => <tr key={worker.id}>
          <td><button className="worker-name" onClick={() => select(worker.id)} disabled={!!view.pending}>{worker.name}</button><code className="worker-id">{worker.id}</code>{worker.revoked_at && <span className="row-note">Access revoked</span>}</td>
          <td><span className={`status ${worker.connection_status === 'online' && !worker.revoked_at ? 'healthy' : ''}`}>{stateName(worker.connection_status)}</span><span className="row-note">Contact {timestamp(worker.last_contact_at)}</span></td>
          <td>{stateName(worker.work_status)}<span className="row-note">{worker.waiting_for_client_tool} client-tool waits</span></td><td>{stateName(worker.inference_readiness)}<span className="row-note">{worker.qualification?.evidence.evidence_kind === 'controlled' ? 'Controlled evidence' : worker.qualification?.evidence.evidence_kind === 'live' ? 'Live trial evidence' : 'No evidence reported'}</span></td>
        </tr>)}</tbody></table>}
    </section>}
    <EnrollmentPanel controller={controller} view={view} />
  </main>;
}
