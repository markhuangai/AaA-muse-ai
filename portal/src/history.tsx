import { Component, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { HistoryController, HistoryRead, HistoryView, HistoryResource } from './history-controller';
import type { HistoryPage, RequestDetail, RequestSummary, TimelineEntry } from './history-api';
import { browserCopy } from './worker-controller';
import { object } from './worker-api';
import { timestamp } from './workers';

const text = (value: unknown) => typeof value === 'string' ? value : '';
const recordedTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? timestamp(value) : 'Not observed';
const json = (value: unknown) => JSON.stringify(value ?? null, null, 2);

export function Identifier({ label, value, copy = browserCopy }: { label: string; value: string; copy?: (value: string) => Promise<void> }) {
  const [message, setMessage] = useState('');
  if (!value) return <span className="muted">Not recorded</span>;
  return <span className="history-identifier"><code>{value}</code><button className="text-action" aria-label={`Copy ${label}`} onClick={() => {
    void copy(value).then(() => setMessage('Copied.'), () => setMessage('Copy failed. Select the identifier to copy it.'));
  }}>Copy</button>{message && <span role="status" className="row-note">{message}</span>}</span>;
}
function Correlation({ requestID, operationID }: { requestID: string; operationID: string }) {
  return <div className="history-correlation">{requestID && <p className="trace">HTTP request <Identifier label="HTTP request ID" value={requestID} /></p>}{operationID && <p className="trace">Portal operation <Identifier label="portal operation ID" value={operationID} /></p>}</div>;
}
function ReadNotice({ read }: { read: HistoryRead<unknown> }) {
  return <>{read.stale && read.value && <p className="snapshot-label">Retained history snapshot · Refresh before cancelling.</p>}{read.message && <div className="notice" role="status"><p>{read.message}</p><Correlation requestID={read.requestID} operationID={read.operationID} /></div>}</>;
}
function Paging({ read, label, next, previous, first }: { read: HistoryRead<HistoryPage<unknown>>; label: string; next: () => void; previous: () => void; first: () => void }) {
  return <nav className="history-paging" aria-label={`${label} pagination`}><span>{read.value?.items.length ?? 0} records · page {read.back.length + 1}{read.value?.next_cursor ? ' · more available' : ''}</span><div><button onClick={first} disabled={read.loading || !read.back.length}>First {label.toLowerCase()} page</button><button onClick={previous} disabled={read.loading || !read.back.length}>Previous {label.toLowerCase()} page</button><button onClick={next} disabled={read.loading || !read.value?.next_cursor}>Next {label.toLowerCase()} page</button></div></nav>;
}
function CurrentName({ id, view }: { id: string | null; view: HistoryView }) {
  const worker = view.workers?.find(value => value.id === id);
  return <span className="row-note">Current name{view.namesStale ? ' (stale)' : ''}: {id ? worker?.name ?? 'Unavailable' : 'Unassigned'}</span>;
}
export class HistoryBoundary extends Component<{ controller: HistoryController; resource: HistoryResource; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.controller.renderFailed(this.props.resource); }
  render() {
    if (!this.state.failed) return this.props.children;
    const read = this.props.controller.snapshot()[this.props.resource];
    return <div className="notice" role="alert"><p>This history view could not be rendered. Reload the portal and sign in again.</p><Correlation requestID={read.requestID} operationID={read.operationID} /></div>;
  }
}
function AssignmentWorkers({ entry, view }: { entry: TimelineEntry; view: HistoryView }) {
  const details = entry.details;
  if (!details) return null;
  const assignment = object(details.assignment) ? details.assignment : null;
  const ids = [...new Set([details.worker_id, details.expected_worker_id, details.observed_worker_id, assignment?.worker_id].filter((id): id is string => typeof id === 'string' && !!id))];
  return <>{ids.map(id => <p className="trace" key={id}>{id === details.expected_worker_id ? 'Previous worker' : id === details.observed_worker_id ? 'Selected worker' : 'Recorded worker'} <Identifier label="recorded worker ID" value={id} /><CurrentName id={id} view={view} /></p>)}</>;
}
function RequestList({ controller, view, select }: { controller: HistoryController; view: HistoryView; select: (id: string) => void }) {
  const [conversation, setConversation] = useState(view.conversation), [requestID, setRequestID] = useState('');
  const submitFilter = (event: FormEvent) => { event.preventDefault(); void controller.filter(conversation); };
  const lookup = (event: FormEvent) => { event.preventDefault(); select(requestID.trim()); };
  const read = view.list;
  return <section aria-label="Recorded requests" className="history-list" aria-busy={read.loading}>
    <div className="history-filters"><form onSubmit={submitFilter}><label htmlFor="conversation-filter">Conversation ID</label><div className="joined-controls"><input id="conversation-filter" value={conversation} onChange={event => setConversation(event.target.value)} autoComplete="off" disabled={view.pending} /><button type="submit" disabled={view.pending}>Apply filter</button></div></form><form onSubmit={lookup}><label htmlFor="request-lookup">Exact request ID</label><div className="joined-controls"><input id="request-lookup" value={requestID} onChange={event => setRequestID(event.target.value)} autoComplete="off" disabled={view.pending} /><button type="submit" disabled={view.pending || !requestID.trim()}>Open request</button></div></form></div>
    <ReadNotice read={read} />
    {read.cursor && <p className="field-note">Older request page. New arrivals do not move this page; use First requests page to see them.</p>}
    {read.value === null ? <p className="empty-state">{read.loading ? 'Loading recorded requests…' : 'Request history is unavailable. Use Refresh history to retry.'}</p> : !read.value.items.length ? <p className="empty-state">No recorded requests match this conversation. Clear the filter or wait for a model client to submit work.</p> : <table className="requests-table"><thead><tr><th scope="col">Request / session</th><th scope="col">Recorded state</th><th scope="col">Assigned worker</th><th scope="col" className="num">Created UTC</th></tr></thead><tbody>{read.value.items.map((request: RequestSummary) => <tr key={request.id}>
      <td><button className="text-action request-link" onClick={() => select(request.id)} disabled={view.pending}><code>{request.id}</code></button><span className="row-note">Session <code>{request.session_id || 'Not recorded'}</code></span><span className="row-note">Client {request.client_id ?? 'Not recorded'} · {request.kind}</span></td>
      <td>{request.state}{request.reason && <span className="row-note">{request.reason}</span>}</td><td><code className="worker-id">{request.worker_id || 'Unassigned'}</code><CurrentName id={request.worker_id} view={view} /></td><td className="num">{timestamp(request.created_at)}</td>
    </tr>)}</tbody></table>}
    <Paging read={read} label="Requests" next={() => void controller.page('list', 'next')} previous={() => void controller.page('list', 'previous')} first={() => void controller.page('list', 'first')} />
  </section>;
}
export function ReplayBoundary({ detail }: { detail: RequestDetail }) {
  const request = detail.request, assignment = detail.assignment;
  const output = object(request.output) ? request.output : null;
  const explanation = output?.type === 'tool_call' ? 'A client tool call was accepted. Only the calling client executes it and returns its matching result; this portal never re-executes it.' :
    request.output_started_at ? 'Output exposure was recorded. Automatic inference replay is not permitted.' :
    request.context_delivery_started_at || assignment?.claimed_at || assignment?.held ? 'Context exposure or claimed inference was recorded. Preserve the original assignment and any uncertain busy hold; automatic replay is not permitted.' :
    request.reassign_allowed === true ? 'Replacement is limited to the existing offline-before-claim-and-context boundary, using full canonical history.' :
    detail.kind === 'legacy' ? 'Legacy records do not establish the native session replacement contract.' : 'No safe prior final-answer boundary was recorded. Automatic replacement is not permitted.';
  return <p className="field-note">{explanation}</p>;
}
function Snapshot({ detail, view }: { detail: RequestDetail; view: HistoryView }) {
  const request = detail.request, execution = detail.execution;
  const input = object(request.input) ? request.input : request;
  const response = object(request.response_metadata) ? request.response_metadata : null;
  const delivery = detail.delivery, assignment = detail.assignment;
  return <>
    <section className="data-panel history-summary" aria-labelledby="request-state"><h3 id="request-state">Recorded outcome</h3><dl className="identity-list">
      <div><dt>State</dt><dd>{execution.state}</dd></div><div><dt>Reason</dt><dd>{execution.reason || 'None recorded'}</dd></div><div><dt>Remote outcome</dt><dd>{execution.remote_outcome}</dd></div>
      <div><dt>Busy hold</dt><dd>{assignment ? assignment.held === true ? 'Retained; remote execution may continue' : 'No retained hold recorded' : 'No assignment recorded'}</dd></div>
      <div><dt>Worker ID</dt><dd><Identifier label="worker ID" value={execution.worker_id || ''} /><CurrentName id={execution.worker_id} view={view} /></dd></div>
      <div><dt>Session ID</dt><dd><Identifier label="session ID" value={text(request.session_id)} /></dd></div><div><dt>Conversation ID</dt><dd><Identifier label="conversation ID" value={request.conversation_id} /></dd></div>
      <div><dt>Client owner</dt><dd>{text(request.client_id) || 'Not recorded'}</dd></div><div><dt>Response ID</dt><dd><Identifier label="response ID" value={text(request.response_id)} /></dd></div>
    </dl><ReplayBoundary detail={detail} /></section>
    <section className="data-panel history-summary" aria-labelledby="request-delivery"><h3 id="request-delivery">Assignment and delivery</h3><dl className="identity-list">
      <div><dt>Job / attempt ID</dt><dd><Identifier label="job ID" value={execution.current_job_id} /></dd></div><div><dt>Assignment generation</dt><dd>{typeof assignment?.generation === 'number' ? assignment.generation : 'Not recorded'}</dd></div><div><dt>Connection generation</dt><dd>{typeof assignment?.connection_generation === 'number' ? assignment.connection_generation : 'Not recorded'}</dd></div>
      <div><dt>Context kind</dt><dd>{text(delivery?.kind) || 'Not prepared'}</dd></div><div><dt>Context receipt</dt><dd><Identifier label="context receipt" value={text(delivery?.receipt_id)} /></dd></div><div><dt>Base receipt</dt><dd><Identifier label="base receipt" value={text(delivery?.base_receipt_id)} /></dd></div>
      <div><dt>Created</dt><dd>{recordedTime(execution.created_at)}</dd></div><div><dt>Deadline</dt><dd>{recordedTime(execution.deadline_at)}</dd></div><div><dt>Context write started</dt><dd>{recordedTime(request.context_delivery_started_at)}</dd></div><div><dt>Context write finished</dt><dd>{recordedTime(request.context_delivery_written_at)}</dd></div><div><dt>Decision accepted</dt><dd>{recordedTime(request.decision_accepted_at)}</dd></div><div><dt>Output write started</dt><dd>{recordedTime(request.output_started_at)}</dd></div><div><dt>Output write finished</dt><dd>{recordedTime(request.output_completed_at)}</dd></div>
    </dl><p className="field-note">{delivery?.kind === 'full' ? 'Full canonical history was prepared for this assignment. ' : ''}Server write observations do not prove remote consumption. Attempt IDs and generations are recorded values, not a global retry counter.</p></section>
    <section className="data-panel history-content" aria-labelledby="request-input"><h3 id="request-input">Observed request content</h3>
      {response && <details open><summary>Instructions for this request only</summary><pre>{response.instructions === null ? 'No request-scoped instructions' : json(response.instructions)}</pre></details>}
      <details open><summary>Input messages and client results</summary><pre>{json(input.messages)}</pre></details><details><summary>Tool definitions</summary><pre>{json(input.tools)}</pre></details>
      <details open><summary>Accepted decision / final output</summary><pre>{json(request.output ?? request.final_text)}</pre></details>
      <details><summary>Complete recorded request snapshot</summary><pre>{json(request)}</pre></details><details><summary>Recorded assignment and prepared context</summary><pre>{json({ assignment, delivery })}</pre></details>
      <p className="field-note">Client-supplied messages, worker-proposed decisions and service transitions are separate observations. Hidden Muse reasoning is not observable.</p>
    </section>
  </>;
}
function Timeline({ controller, view }: { controller: HistoryController; view: HistoryView }) {
  const read = view.timeline;
  return <section className="data-panel history-timeline" aria-labelledby="timeline-title" aria-busy={read.loading}><h3 id="timeline-title">Conversation timeline</h3><p className="field-note">Chronological service records across this conversation. The selected request is marked. Earlier pages stay anchored while new events arrive.</p><ReadNotice read={read} />
    {read.value === null ? <p className="empty-state">{read.loading ? 'Loading conversation timeline…' : 'Timeline unavailable. Refresh to retry.'}</p> : !read.value.items.length ? <p className="empty-state">No timeline records are available.</p> : <ol className="timeline-events">{read.value.items.map((entry: TimelineEntry) => <li key={entry.sequence} className={entry.request_id === view.selectedID ? 'selected-request-event' : undefined}>
      <div className="event-heading"><strong>{entry.kind}</strong><span className="num">{entry.time ? timestamp(entry.time) : 'Time not recorded'}</span></div><p className="row-note">Sequence {entry.sequence} · {entry.level || 'Level not recorded'} · {entry.request_id === view.selectedID ? 'Selected request' : 'Related request'}</p>
      {entry.request_id && <p className="trace">Request <Identifier label="timeline request ID" value={entry.request_id} />{' '}{entry.request_id !== view.selectedID && <button className="text-action" onClick={() => void controller.select(entry.request_id!)}>Open related request</button>}</p>}
      {entry.provenance === 'unavailable' && <p className="field-note">Legacy provenance is unavailable; this is a retained snapshot.</p>}
      <AssignmentWorkers entry={entry} view={view} />
      {entry.item && <><p className="row-note">{entry.item.source === 'client_provided' ? 'Client-provided context' : entry.item.source === 'server_observed' ? 'Decision accepted by the service' : 'Recorded item; source not established'}</p><pre>{json(entry.item)}</pre></>}
      {entry.details && <details open={entry.kind === 'dispatch.reassigned' || entry.kind === 'portal.cancel_result'}><summary>Recorded event details</summary><pre>{json(entry.details)}</pre></details>}
    </li>)}</ol>}
    <Paging read={read} label="Timeline" next={() => void controller.page('timeline', 'next')} previous={() => void controller.page('timeline', 'previous')} first={() => void controller.page('timeline', 'first')} />
  </section>;
}
function Detail({ controller, view, back }: { controller: HistoryController; view: HistoryView; back: () => void }) {
  const [confirming, setConfirming] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, [view.selectedID]);
  useEffect(() => { if (confirming) dialog.current?.showModal(); }, [confirming]);
  function close() { dialog.current?.close(); setConfirming(''); }
  const read = view.detail, detail = read.value;
  const disabled = !controller.canCancel();
  return <section className="request-detail" aria-label="Request detail"><button className="text-action" onClick={back} disabled={view.pending}>All requests</button>
    <div className="detail-heading"><div><h2 tabIndex={-1} ref={title}>Request detail</h2><Identifier label="request ID" value={view.selectedID} /></div><button className="danger-action" disabled={disabled} onClick={() => setConfirming(view.selectedID)}>{view.pending ? 'Cancelling…' : 'Cancel request'}</button></div>
    <ReadNotice read={read} /><Correlation requestID={read.requestID} operationID={read.operationID} />
    {detail ? <>{detail.kind === 'legacy' && <p className="snapshot-label">Legacy request · Native session identity and historical provenance may be unavailable.</p>}<HistoryBoundary controller={controller} resource="detail"><div className="history-fact-grid"><Snapshot detail={detail} view={view} /></div></HistoryBoundary><HistoryBoundary controller={controller} resource="timeline"><Timeline controller={controller} view={view} /></HistoryBoundary></> : <p className="empty-state">{read.loading ? 'Loading request detail…' : 'No request detail is available.'}</p>}
    <dialog ref={dialog} aria-labelledby="cancel-request-title" aria-describedby="cancel-request-description" onCancel={() => setConfirming('')} onClose={() => setConfirming('')}><h2 id="cancel-request-title">Cancel this request?</h2><p className="confirm-identity"><code>{confirming}</code></p><p id="cancel-request-description">The broker fences future acceptance for cancellable work. Remote stopping is best effort and may remain unknown. Accepted client tools and retained history are preserved.</p><form onSubmit={event => { event.preventDefault(); const id = confirming; close(); void controller.cancel(id); }}><button type="button" autoFocus onClick={close}>Keep request</button><button type="submit" className="danger-action" disabled={disabled}>Confirm cancellation</button></form></dialog>
  </section>;
}
export function Requests({ controller }: { controller: HistoryController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const listScroll = useRef(0), listTitle = useRef<HTMLHeadingElement>(null);
  const read = view.selectedID ? view.detail : view.list;
  function select(id: string) { listScroll.current = window.scrollY; void controller.select(id); }
  function back() { void controller.select(''); requestAnimationFrame(() => { listTitle.current?.focus({ preventScroll: true }); window.scrollTo(0, listScroll.current); }); }
  return <main className="requests-page"><div className="page-heading"><div><p className="context-label">Observed inference</p><h1 tabIndex={-1} ref={listTitle}>Requests</h1><p className="page-purpose">Follow recorded context, client tools and actual outcomes.</p></div><div className="refresh-control"><span>{read.lastGood === null ? 'No successful refresh yet' : `Last checked ${timestamp(new Date(read.lastGood).toISOString())}`}</span><button onClick={() => void controller.refresh()} disabled={view.pending}>Refresh history</button></div></div>
    {view.actionMessage && <div className="notice" role="status"><p>{view.actionMessage}</p><Correlation requestID={view.actionRequestID} operationID={view.actionOperationID} /></div>}
    {view.namesStale && <p className="field-note">Current display names are unavailable or stale. Immutable recorded worker IDs remain authoritative.</p>}
    {view.selectedID ? <Detail key={view.selectedID} controller={controller} view={view} back={back} /> : <HistoryBoundary controller={controller} resource="list"><RequestList controller={controller} view={view} select={select} /></HistoryBoundary>}
  </main>;
}
