import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { browserCopy } from './worker-controller';
import { object, type Worker } from './worker-api';
import { isActive, type ControlItem, type ControlLane, type DiagnosticFilters } from './worker-remote-api';
import type { WorkerRemoteController } from './worker-remote-controller';

const kinds = { doctor: 'Doctor', diagnostics_export: 'Diagnostics export', retry_update: 'Update retry' };
const taskLimits = 'The Muse run can use its granted tools. Hook and cron changes, chat.send, and permission approvals require the main chat.';
const promptLimit = 32 * 1024;
const initialFilters = (): DiagnosticFilters => ({ decode: true });
const emptyTask = () => ({ prompt: '', title: '', timeout: '300' });

interface ConfirmationState {
  heading: string;
  description: string;
  label: string;
  opener: HTMLElement | null;
  invoke(): void;
}

function Confirmation({ worker, state, disabled, close }: { worker: Worker; state: ConfirmationState; disabled: boolean; close(): void }) {
  const element = useRef<HTMLDialogElement>(null);
  const titleID = useId();
  const descID = useId();
  useLayoutEffect(() => {
    const dialog = element.current;
    const opener = state.opener;
    dialog?.showModal();
    dialog?.querySelector('button')?.focus({ preventScroll: true });
    return () => {
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={element} aria-labelledby={titleID} aria-describedby={descID} onCancel={event => {
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <h2 id={titleID}>{state.heading}</h2>
    <p className="confirm-identity">{worker.name}<br /><code>{worker.id}</code></p>
    <p id={descID}>{state.description}</p>
    <form onSubmit={event => { event.preventDefault(); if (!disabled) state.invoke(); }}>
      <button type="button" autoFocus onClick={close}>Cancel</button>
      <button type="submit" disabled={disabled}>{state.label}</button>
    </form>
  </dialog>;
}

function outputText(item: ControlItem) {
  const value = item.result;
  if (value === undefined || value === null) return '';
  if (object(value) && Array.isArray(value.output) && value.output.every(record => typeof record === 'string')) {
    return value.output.join('');
  }
  if (object(value) && typeof value.result_text === 'string') {
    return [value.result_text, value.summary].filter(text => typeof text === 'string' && text.length > 0).join('\n\n');
  }
  return JSON.stringify(value, null, 2);
}

function outputDownload(id: string, output: string) {
  const url = URL.createObjectURL(new Blob([output], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `worker-diagnostics-${id}.ndjson`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RemoteOutput({ item, children }: { item: ControlItem; children?: ReactNode }) {
  const result = outputText(item);
  const region = useRef<HTMLPreElement>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const diagnostics = item.kind === 'diagnostics_export';
  const truncated = object(item.result) && item.result.truncated === true;
  const complete = object(item.result) && item.result.complete === true;
  return <div className="worker-remote-output">
    <div className="worker-remote-item-heading"><strong>{item.kind ? kinds[item.kind] : item.title || 'Background task'}</strong><span>{statusName(item)}</span></div>
    {item.reason && <p className="field-note">{item.reason_message || item.reason}</p>}
    {item.prompt && <><h4>Submitted prompt</h4><pre tabIndex={0} aria-label="Submitted prompt">{item.prompt}</pre></>}
    {diagnostics && item.result !== undefined && <p className="field-note">{truncated ? 'Truncated' : complete ? 'Complete' : 'Incomplete'}
      {object(item.result) && Array.isArray(item.result.omissions) && item.result.omissions.length > 0 && <> · {item.result.omissions.join(', ')}</>}</p>}
    {result && <>
      <pre ref={region} tabIndex={0} aria-label="Worker output">{result}</pre>
      <div className="copy-controls">
        <button type="button" onClick={async () => {
          try { await browserCopy(result); setCopyMessage('Copied.'); }
          catch {
            if (region.current) {
              const range = document.createRange();
              range.selectNodeContents(region.current);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
              region.current.focus();
            }
            setCopyMessage('Clipboard unavailable. Copy the selected text.');
          }
        }}>Copy output</button>
        {diagnostics && <button type="button" onClick={() => outputDownload(item.id, result)}>Download</button>}
      </div>
      {copyMessage && <p className="field-note" role="status">{copyMessage}</p>}
    </>}
    {children}
  </div>;
}

function statusName(item: ControlItem) {
  const status = item.state[0].toUpperCase() + item.state.slice(1);
  return item.held && !['claimed', 'running'].includes(item.state) ? status + ' · awaiting settlement' : status;
}

function RemoteList({ lane, items, detail, controller, disabled, askCancel, children }: {
  lane: ControlLane; items: ControlItem[]; detail: ControlItem | null; controller: WorkerRemoteController;
  disabled: boolean; askCancel(item: ControlItem): void; children?: ReactNode;
}) {
  return <>
    <h4>{lane === 'ops' ? 'Recent operations' : 'Recent tasks'}</h4>
    {items.length === 0 ? <p className="field-note">Nothing queued yet.</p> : <ul className="worker-remote-list">{items.map(item => <li key={item.id}>
      <button type="button" aria-pressed={detail?.id === item.id} onClick={() => void controller.detail(lane, item.id)}>
        <strong>{item.kind ? kinds[item.kind] : item.title || 'Background task'}</strong>
        <span>{statusName(item)}</span>
        <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
      </button>
      {isActive(item) && ['queued', 'claimed', 'running'].includes(item.state) &&
        <button type="button" disabled={disabled} onClick={() => askCancel(item)}>Cancel {lane === 'ops' ? 'operation' : 'task'}</button>}
    </li>)}</ul>}
    {detail && <RemoteOutput key={detail.id} item={detail}>{children}</RemoteOutput>}
  </>;
}

export function WorkerRemoteSections({ worker, controller, stale }: { worker: Worker; controller: WorkerRemoteController; stale: boolean }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [filters, setFilters] = useState(initialFilters);
  const [dates, setDates] = useState({ since: '', until: '' });
  const [task, setTask] = useState(emptyTask);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [promptCopy, setPromptCopy] = useState('');
  const promptArea = useRef<HTMLTextAreaElement>(null);
  const byteCount = new TextEncoder().encode(task.prompt).length;
  const timeout = Number(task.timeout);
  const disabled = stale || view.workerID !== worker.id || view.stale || view.pending || view.uncertain;
  const allowOps = !disabled && worker.worker_ops_ready;
  const allowTasks = !disabled && worker.agent_tasks_ready;
  const update = worker.worker_update;
  const allowRetry = !disabled && (update?.state === 'failed' ||
    (update?.state === 'deferred' && ['mixed_broker_releases', 'release_digest_conflict'].includes(update.reason ?? ''))) &&
    !view.items.ops.some(item => item.kind === 'retry_update' && isActive(item));
  const validTask = byteCount > 0 && byteCount <= promptLimit && !task.prompt.includes('\0') &&
    Array.from(task.title).length <= 120 && !/\p{Cc}/u.test(task.title) && Number.isInteger(timeout) && timeout >= 30 && timeout <= 3600;
  const validFilters = (!filters.operation_id || /^[A-Za-z0-9_-]{1,100}$/.test(filters.operation_id)) &&
    (!filters.request_id || /^[A-Za-z0-9_-]{1,100}$/.test(filters.request_id)) && (!dates.since || !dates.until || dates.since <= dates.until);
  const opDetail = view.details.ops;
  const cursor = opDetail && object(opDetail.result) && opDetail.result.truncated === true && typeof opDetail.result.next_cursor === 'string' ?
    opDetail.result.next_cursor : '';
  const go = () => setConfirmation(null);

  function exportDiagnostics(parameters: DiagnosticFilters) {
    return controller.mutate('ops', { kind: 'diagnostics_export', params: parameters });
  }

  function submitDiagnostics(event: FormEvent) {
    event.preventDefault();
    if (!allowOps || !validFilters) return;
    const selected = {
      decode: filters.decode, operation_id: filters.operation_id || undefined, request_id: filters.request_id || undefined,
      since: dates.since ? new Date(dates.since).toISOString() : undefined, until: dates.until ? new Date(dates.until).toISOString() : undefined,
    };
    void exportDiagnostics(selected);
  }

  function submitTask(event: FormEvent) {
    event.preventDefault();
    if (!allowTasks || !validTask) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation({ heading: 'Queue this background task?', description: taskLimits, label: 'Confirm task', opener, invoke: () => {
      go();
      void controller.mutate('agent-tasks', { prompt: task.prompt, title: task.title || undefined, timeout_seconds: timeout })
        .then(ok => { if (ok) setTask(emptyTask()); });
    } });
  }

  function askCancel(lane: ControlLane, item: ControlItem) {
    const name = lane === 'ops' && item.kind ? kinds[item.kind] : item.title || 'Background task';
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation({ heading: lane === 'ops' ? 'Cancel this operation?' : 'Cancel this background task?',
      description: `${name} (${item.id}). Active work keeps its slot until the broker confirms settlement.`,
      label: 'Confirm cancellation', opener, invoke: () => { go(); void controller.mutate(lane, {}, item.id); } });
  }

  return <>
    <section className="data-panel worker-remote-panel"><h3>Worker operations</h3>
      <div className="worker-remote-actions">
        <button type="button" disabled={!allowOps} onClick={() => void controller.mutate('ops', { kind: 'doctor' })}>Run doctor</button>
        <button type="button" disabled={!allowRetry} onClick={() => void controller.mutate('ops', { kind: 'retry_update' })}>Retry update</button>
        <button type="button" disabled={view.loading || view.pending} onClick={() => void controller.refresh(true)}>{view.loading ? 'Refreshing…' : 'Refresh remote activity'}</button>
      </div>
      {view.message && <p className="field-note" role="status">{view.message}{view.requestID && <> Request <code>{view.requestID}</code>.</>}</p>}
      {view.stale && !view.loading && <p className="field-note">Refresh remote activity before making changes.</p>}
      {!worker.worker_ops_ready && <p className="field-note">Doctor and diagnostics require the paired worker release.</p>}
      <details className="worker-export"><summary>Export diagnostics</summary>
        <form className="worker-remote-form" onSubmit={submitDiagnostics}>
          <label>Operation ID<input value={filters.operation_id ?? ''} onChange={event => setFilters({ ...filters, operation_id: event.target.value })} /></label>
          <label>Request ID<input value={filters.request_id ?? ''} onChange={event => setFilters({ ...filters, request_id: event.target.value })} /></label>
          <label>Since<input type="datetime-local" value={dates.since} onChange={event => setDates({ ...dates, since: event.target.value })} /></label>
          <label>Until<input type="datetime-local" value={dates.until} onChange={event => setDates({ ...dates, until: event.target.value })} /></label>
          <label className="worker-export-decode"><input type="checkbox" checked={filters.decode} onChange={event => setFilters({ ...filters, decode: event.target.checked })} /> Decode records</label>
          <button type="submit" disabled={!allowOps || !validFilters}>Queue export</button>
        </form>
      </details>
      <RemoteList lane="ops" items={view.items.ops} detail={opDetail} controller={controller} disabled={disabled}
        askCancel={item => askCancel('ops', item)}>
        {cursor && opDetail && <button type="button" disabled={!allowOps} onClick={() =>
          void exportDiagnostics({ decode: true, ...opDetail.claim?.params, cursor })}>Export next page</button>}
      </RemoteList>
    </section>
    <section className="data-panel worker-remote-panel"><h3>Background agent tasks</h3>
      <p className="field-note">{worker.agent_tasks_ready ? 'Ready' : worker.prompt_contract === 'managed-hook-prompt-v2' ?
        'Waiting for the paired release' : 'Hook prompt update required'}</p>
      {!worker.agent_tasks_ready && worker.prompt_contract !== 'managed-hook-prompt-v2' && <>
        <button type="button" onClick={() => { setPromptCopy(''); void controller.hookPrompt(); }}>Show hook upgrade prompt</button>
        {view.upgradeMessage && <p role="status" className="field-note">{view.upgradeMessage}</p>}
        {view.upgradePrompt && <div className="worker-remote-form">
          <label htmlFor="worker-hook-prompt-instructions">Main chat upgrade prompt</label>
          <textarea ref={promptArea} id="worker-hook-prompt-instructions" readOnly value={view.upgradePrompt} />
          <button type="button" onClick={async () => {
            try { await browserCopy(view.upgradePrompt); setPromptCopy('Copied.'); }
            catch { promptArea.current?.select(); setPromptCopy('Clipboard unavailable. Copy the selected prompt.'); }
          }}>Copy upgrade prompt</button>
          {promptCopy && <p role="status" className="field-note">{promptCopy}</p>}
        </div>}
      </>}
      <form className="worker-remote-form" onSubmit={submitTask}>
        <label>Task prompt<textarea rows={5} value={task.prompt} onChange={event => setTask({ ...task, prompt: event.target.value })} /></label>
        <span className="field-note worker-prompt-count">{byteCount.toLocaleString()} / 32,768 UTF-8 bytes</span>
        <label>Title (optional)<input value={task.title} onChange={event => setTask({ ...task, title: event.target.value })} /></label>
        <label>Timeout (seconds)<input type="number" min={30} max={3600} required value={task.timeout} onChange={event => setTask({ ...task, timeout: event.target.value })} /></label>
        <button type="submit" className="primary" disabled={!allowTasks || !validTask}>Review task</button>
      </form>
      <RemoteList lane="agent-tasks" items={view.items['agent-tasks']} detail={view.details['agent-tasks']} controller={controller} disabled={disabled}
        askCancel={item => askCancel('agent-tasks', item)} />
    </section>
    {confirmation && <Confirmation state={confirmation} worker={worker} disabled={disabled || (confirmation.label === 'Confirm task' && !allowTasks)} close={go} />}
  </>;
}
