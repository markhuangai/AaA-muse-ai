import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent } from 'react';
import type { Worker, EnrollmentKind } from './worker-api';
import type { WorkersController, WorkersView } from './worker-controller';

export const timestamp = (value: string | null) => value ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'Not observed';
const states: Record<string, string> = { recent: 'Recent contact', quiet: 'Quiet', offline: 'Offline', not_observed: 'Never seen', idle: 'Idle', busy: 'Busy', unknown: 'Unknown', pending_native_start: 'Pending native start', started: 'Execution started', terminal_receipt: 'Result accepted; awaiting settlement', recovery_pending: 'Recovery pending' };
const stateName = (value: string) => states[value] ?? value;
const busyReasons = new Map([
  ['native_observation_pending', 'Waiting for native run evidence'],
  ['result_delivery_active', 'Result delivery in progress'],
  ['result_delivery_unobservable', 'Result delivery status unavailable'],
  ['producer_launch_unobservable', 'Background process launch unverified'],
  ['producer_still_active_or_unobservable', 'Waiting for the background process to stop'],
]);

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
      <section className="data-panel"><h3>Broker contact</h3><dl className="identity-list">
        <div><dt>Contact status</dt><dd>{stateName(worker.connection_status)}</dd></div>
        <div><dt>Last contact</dt><dd>{timestamp(worker.last_contact_at)}</dd></div>
        <div><dt>Last work poll</dt><dd>{timestamp(worker.last_poll_at ?? null)}</dd></div>
        <div><dt>Installed version</dt><dd>Not reported</dd></div>
      </dl><p className="field-note">Contact becomes Quiet after one minute and Offline after ten. A scheduled tick can run late.</p>
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
        {worker.current_claim && <>
          <div><dt>Claim ID</dt><dd><code>{worker.current_claim.claim_id}</code></dd></div>
          <div><dt>Last observed stage</dt><dd>{stateName(worker.claim_stage ?? 'unknown')}</dd></div>
          {worker.busy_reason && busyReasons.has(worker.busy_reason) && <div><dt>Last reported hold</dt><dd>{busyReasons.get(worker.busy_reason)}</dd></div>}
          <div><dt>Claimed at</dt><dd>{timestamp(worker.current_claim.claimed_at)}</dd></div>
          <div><dt>Deadline</dt><dd>{timestamp(worker.current_claim.deadline_at)}</dd></div>
          <div><dt>Started at</dt><dd>{timestamp(worker.claim_started_at ?? null)}</dd></div>
        </>}
        <div><dt>Client-tool waits</dt><dd className="num">{worker.waiting_for_client_tool}</dd></div>
        <div><dt>Background wake</dt><dd>Not independently observed</dd></div>
      </dl><p className="field-note">Busy workers do not pull. The broker cannot see local run observations in real time. Offline does not release the claim or prove the work stopped.</p></section>
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
      <p className="scope-note">Workers pull queued jobs on scheduled checks when their slots are free.</p>
      {view.workers === null ? <p className="empty-state">{view.loading ? 'Loading registered workers…' : 'Worker information is unavailable. Use Refresh workers to retry.'}</p> : view.workers.length === 0 ? <p className="empty-state">No workers have access. Use enrollment to add a worker.</p> :
        <table className="workers-table"><thead><tr><th scope="col">Worker identity</th><th scope="col">Broker contact</th><th scope="col">Offline for</th><th scope="col">Broker activity</th></tr></thead><tbody>{view.workers.map(worker => <tr key={worker.id}>
          <td><button className="worker-name" aria-haspopup="dialog" aria-disabled={!!view.pending} onClick={event => {
            if (view.pending) return;
            opener.current = event.currentTarget; controller.select(worker.id);
          }}>{worker.name}</button><code className="worker-id">{worker.id}</code></td>
          <td><span className={`status ${worker.connection_status === 'recent' ? 'healthy' : ''}`}>{stateName(worker.connection_status)}</span><span className="row-note">Contact {timestamp(worker.last_contact_at)}</span></td>
          <td className="offline-duration">
            <span className="offline-label" aria-hidden="true">Offline for</span>
            <span className="num">{worker.connection_status !== 'offline' || worker.offline_for_ms === undefined ? '-' :
              formatOfflineDuration(worker.offline_for_ms + (view.stale ? 0 : Math.max(0, view.offlineClock - worker.receivedAt)))}</span>
          </td>
          <td>{stateName(worker.work_status)}
            {worker.current_claim && worker.busy_reason && busyReasons.has(worker.busy_reason) &&
              <span className="row-note">{busyReasons.get(worker.busy_reason)}</span>}
            <span className="row-note">{worker.waiting_for_client_tool} client-tool waits</span>
          </td>
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
