import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent } from 'react';
import type { Worker, Qualification, EnrollmentKind } from './worker-api';
import type { WorkersController, WorkersView } from './worker-controller';

export const timestamp = (value: string | null) => value ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'Not observed';
const states: Record<string, string> = { online: 'Online', offline: 'Offline', connecting: 'Connecting', not_observed: 'Not observed', idle: 'Idle', busy: 'Busy', unknown: 'Unknown', unverified: 'Not yet qualified', verified: 'Approved', withdrawn: 'Withdrawn', stale: 'Stale qualification' };
const stateName = (value: string) => states[value] ?? value;

function formatOfflineDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}

function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

function Correlation({ request, operation }: { request: string; operation: string }) {
  return <>{request && <p className="trace">Request <code>{request}</code></p>}{operation && <p className="trace">Operation <code>{operation}</code></p>}</>;
}

function QualificationDetail({ qualification }: { qualification: Qualification }) {
  return <dl className="identity-list qualification-facts">
    <div><dt>Approval action</dt><dd>{qualification.evidence.action}</dd></div>
    <div><dt>Evidence provenance</dt><dd>{qualification.evidence.evidence_kind === 'controlled' ? 'Controlled software evidence' : qualification.evidence.evidence_kind === 'live' ? 'Live trial evidence' : 'Not reported'}</dd></div>
    <div><dt>Recorded at</dt><dd>{timestamp(qualification.created_at)}</dd></div>
    <div><dt>Evidence connection</dt><dd><code>{qualification.connection_id}</code> · generation {qualification.connection_generation}</dd></div>
    <div><dt>Capabilities</dt><dd>{qualification.capabilities.join(', ') || 'None approved'}</dd></div>
    <div><dt>Evidence reference</dt><dd>{qualification.evidence.evidence_reference}</dd></div>
  </dl>;
}

function WorkerNotices({ view }: { view: WorkersView }) {
  return <>
    {view.stale && view.workers && <p className="snapshot-label">Stale snapshot · Refresh before changing worker access.</p>}
    {view.message && <div className="notice" role="status"><p>{view.message}</p><Correlation request={view.requestID} operation={view.operationID} /></div>}
    {view.actionMessage && <div className="notice" role="status"><p>{view.actionMessage}</p><Correlation request={view.actionRequestID} operation={view.actionOperationID} /></div>}
  </>;
}

function WorkerDetail({ worker, controller, view }: { worker: Worker; controller: WorkersController; view: WorkersView }) {
  const [name, setName] = useState(worker.name);
  const [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const disabled = view.stale || !!view.pending;
  const refreshDisabled = view.loading || !!view.pending;
  useEffect(() => { setName(worker.name); }, [worker.id, worker.name]);
  useEffect(() => { if (confirming) dialog.current?.showModal(); }, [confirming]);
  function rename(event: FormEvent) { event.preventDefault(); void controller.mutate('rename', worker.id, name); }
  function cancel() { dialog.current?.close(); setConfirming(false); }
  function revoke(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    cancel();
    void controller.mutate('revoke', worker.id);
  }
  return <section className="worker-detail" aria-label="Worker detail">
    <div className="drawer-heading"><div><h2 id="worker-drawer-title" tabIndex={-1}>{worker.name}</h2><code className="worker-id">{worker.id}</code></div>
      <button type="button" className="drawer-close" aria-label="Close" onClick={() => controller.select('')}>×</button></div>
    <div className="drawer-refresh"><button type="button" aria-disabled={refreshDisabled} onClick={() => {
      if (!refreshDisabled) void controller.refresh();
    }}>{view.loading ? 'Refreshing…' : 'Refresh workers'}</button></div>
    {view.selectedID === worker.id && <WorkerNotices view={view} />}
    <div className="worker-fact-grid">
      <section className="data-panel"><h3>Registration and access</h3>
        <form className="rename-form" onSubmit={rename}><label htmlFor="worker-name">Display name</label><input id="worker-name" value={name} onChange={event => setName(event.target.value)} autoComplete="off" readOnly={disabled} /><button type="submit" aria-disabled={disabled}>{view.pending === 'rename' ? 'Saving…' : 'Save name'}</button></form>
        <p className="field-note">Names may be shared. The immutable worker ID determines identity and access.</p>
        <dl className="identity-list">
          <div><dt>Registered</dt><dd>{timestamp(worker.registered_at)}</dd></div>
          <div><dt>Credential expiry</dt><dd>Valid until revoked</dd></div>
        </dl>
        <button className="danger-action" aria-disabled={disabled} onClick={() => { if (!disabled) setConfirming(true); }}>Revoke worker</button>
      </section>
      <section className="data-panel"><h3>Subscriber connection</h3><dl className="identity-list">
        <div><dt>Subscriber</dt><dd>{stateName(worker.connection_status)}</dd></div>
        <div><dt>Last contact</dt><dd>{timestamp(worker.last_contact_at)}</dd></div>
        <div><dt>Last heartbeat</dt><dd>{timestamp(worker.last_heartbeat_at)}</dd></div>
        <div><dt>Installed version</dt><dd>Not reported</dd></div>
      </dl><p className="field-note">Contact and heartbeat describe authenticated transport. They do not establish model readiness.</p>
      <h4>Reported by Muse during setup</h4>
      <dl className="identity-list">
        <div><dt>Model</dt><dd>{worker.model_report?.model_name ?? 'Not reported'}</dd></div>
        <div><dt>Context window</dt><dd>{worker.model_report?.context_window_tokens
          ? worker.model_report.context_window_tokens.toLocaleString('en-US') + ' tokens' : 'Not reported'}</dd></div>
        <div><dt>Reported at</dt><dd>{timestamp(worker.model_report?.reported_at ?? null)}</dd></div>
      </dl></section>
      <section className="data-panel"><h3>Broker activity</h3><dl className="identity-list">
        <div><dt>Work state</dt><dd>{stateName(worker.work_status)}</dd></div>
        <div><dt>Current assignment</dt><dd>{worker.current_job ? <><code>{worker.current_job.job_id}</code> · generation {worker.current_job.generation}</> : 'None observed'}</dd></div>
        <div><dt>Client-tool waits</dt><dd className="num">{worker.waiting_for_client_tool}</dd></div>
        <div><dt>Background wake</dt><dd>Not independently observed</dd></div>
      </dl><p className="field-note">Busy means the broker retains an assignment. Tool waits depend on the calling client. Offline does not establish whether remote work stopped.</p></section>
      <section className="data-panel"><h3>Inference qualification</h3><p className="qualification-state">{stateName(worker.inference_readiness)}</p>
        {worker.qualification ? <QualificationDetail qualification={worker.qualification} /> : <p>No management-approved evidence is recorded.</p>}
        <p className="field-note">Approval stays with this enrolled worker across authenticated reconnects until withdrawn or revoked. The evidence connection records the original trial. Controlled evidence does not establish live Muse qualification.</p>
        {worker.qualification_history.length > 0 && <details><summary>Qualification history ({worker.qualification_history.length})</summary><ol className="qualification-history">{worker.qualification_history.map(item => <li key={item.id}><QualificationDetail qualification={item} /></li>)}</ol></details>}
      </section>
    </div>
    <dialog ref={dialog} aria-labelledby="revoke-title" aria-describedby="revoke-description" onCancel={event => { event.stopPropagation(); setConfirming(false); }} onClose={() => setConfirming(false)}>
      <h2 id="revoke-title">Revoke this worker?</h2><p className="confirm-identity">{worker.name}<br /><code>{worker.id}</code></p><p id="revoke-description">This blocks access for every copy of this worker credential. Registration and history are retained. Remote activity may remain unknown.</p>
      {view.stale && <p>Cancel and refresh worker state before revoking.</p>}
      <form onSubmit={revoke}><button type="button" autoFocus onClick={cancel}>Cancel</button><button type="submit" className="danger-action" aria-disabled={disabled}>Confirm revocation</button></form>
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
      <p className="field-note">Setup text includes the service image’s verified worker release and supported reconnection instructions. Each generation issues a new enrollment and replaces the text shown here.</p>
      <button className="primary" disabled={!!view.pending} onClick={() => void controller.createEnrollment(kind)}>{view.pending === 'enrollment' ? 'Generating…' : kind === 'prompt' ? 'Generate setup prompt' : 'Generate enrollment code'}</button>
      {view.enrollmentMessage && <p className="field-note" role="status">{view.enrollmentMessage}</p>}
      {enrollment && <div className="enrollment-result"><dl className="identity-list"><div><dt>Enrollment ID</dt><dd><code>{enrollment.enrollment_id}</code></dd></div><div><dt>Expires at</dt><dd>{timestamp(enrollment.expires_at)}</dd></div>
        {enrollment.worker_package && <><div><dt>Recommended installer</dt><dd>{enrollment.worker_package.version}</dd></div><div><dt>Archive SHA-256</dt><dd><code>{enrollment.worker_package.sha256}</code></dd></div></>}
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
  const list = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef<{ pointer: number; released: boolean } | null>(null);
  const lastSelection = useRef<Worker | undefined>(undefined);
  const drawerWorker = selected ?? lastSelection.current;
  useLayoutEffect(() => {
    const dialog = drawer.current!;
    if (selected) {
      lastSelection.current = selected;
      if (!dialog.open) {
        dialog.scrollTop = 0;
        dialog.showModal();
        dialog.querySelector<HTMLElement>('#worker-drawer-title')?.focus({ preventScroll: true });
      }
    } else if (dialog.open) {
      backdropPress.current = null;
      for (const confirmation of dialog.querySelectorAll<HTMLDialogElement>('dialog[open]')) confirmation.close();
      dialog.close();
      const target = opener.current?.isConnected ? opener.current : list.current;
      target?.focus({ preventScroll: true });
    }
  }, [selected]);
  return <main className="workers-page">
    <div className="page-heading"><div><p className="context-label">Worker management</p><h1 tabIndex={-1} ref={list}>Workers</h1><p className="page-purpose">See what the broker observed and manage worker access.</p></div><div className="refresh-control"><span>{view.lastGood === null ? 'No successful refresh yet' : `Last checked ${timestamp(new Date(view.lastGood).toISOString())}`}</span><button onClick={() => void controller.refresh()} disabled={view.loading || !!view.pending}>{view.loading ? 'Refreshing…' : 'Refresh workers'}</button></div></div>
    {!selected && <WorkerNotices view={view} />}
    {!view.actionMessage && view.actionRequestID && view.enrollmentMessage && <Correlation request={view.actionRequestID} operation={view.actionOperationID} />}
    <section className="worker-list" aria-label="Registered workers" aria-busy={view.loading}>
      <p className="scope-note">Subscriber health, broker activity and inference qualification are independent observations. Hidden Muse activity is not observable here.</p>
      {view.workers === null ? <p className="empty-state">{view.loading ? 'Loading registered workers…' : 'Worker information is unavailable. Use Refresh workers to retry.'}</p> : view.workers.length === 0 ? <p className="empty-state">No workers have access. Use enrollment to add a worker.</p> :
        <table className="workers-table"><thead><tr><th scope="col">Worker identity</th><th scope="col">Subscriber</th><th scope="col">Offline for</th><th scope="col">Broker activity</th><th scope="col">Qualification</th></tr></thead><tbody>{view.workers.map(worker => <tr key={worker.id}>
          <td><button className="worker-name" aria-haspopup="dialog" aria-disabled={!!view.pending} onClick={event => {
            if (view.pending) return;
            opener.current = event.currentTarget; controller.select(worker.id);
          }}>{worker.name}</button><code className="worker-id">{worker.id}</code></td>
          <td><span className={`status ${worker.connection_status === 'online' ? 'healthy' : ''}`}>{stateName(worker.connection_status)}</span><span className="row-note">Contact {timestamp(worker.last_contact_at)}</span></td>
          <td className="offline-duration">
            <span className="offline-label" aria-hidden="true">Offline for</span>
            <span className="num">{worker.connection_status === 'online' || worker.offline_for_ms === undefined ? '-' :
              formatOfflineDuration(worker.offline_for_ms + (view.stale ? 0 : Math.max(0, view.offlineClock - worker.receivedAt)))}</span>
          </td>
          <td>{stateName(worker.work_status)}<span className="row-note">{worker.waiting_for_client_tool} client-tool waits</span></td><td>{stateName(worker.inference_readiness)}<span className="row-note">{worker.qualification?.evidence.evidence_kind === 'controlled' ? 'Controlled evidence' : worker.qualification?.evidence.evidence_kind === 'live' ? 'Live trial evidence' : 'No evidence reported'}</span></td>
        </tr>)}</tbody></table>}
    </section>
    <EnrollmentPanel controller={controller} view={view} />
    <dialog ref={drawer} className="worker-drawer" aria-labelledby="worker-drawer-title"
      onCancel={event => { event.preventDefault(); controller.select(''); }}
      onPointerDown={event => {
        if (event.isPrimary) backdropPress.current = event.button === 0 && onBackdrop(event) ? { pointer: event.pointerId, released: false } : null;
      }}
      onPointerUp={event => {
        const press = backdropPress.current;
        if (press?.pointer === event.pointerId) press.released = onBackdrop(event);
      }}
      onPointerCancel={event => {
        if (backdropPress.current?.pointer === event.pointerId) backdropPress.current = null;
      }}
      onClick={event => {
        const press = backdropPress.current;
        backdropPress.current = null;
        if (press?.released && onBackdrop(event)) controller.select('');
      }}>
      {drawerWorker && <WorkerDetail key={drawerWorker.id} worker={drawerWorker} view={view} controller={controller} />}
    </dialog>
  </main>;
}
