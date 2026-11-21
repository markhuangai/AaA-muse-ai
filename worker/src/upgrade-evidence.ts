import { digest } from './diagnostics.js';
import { requireValue } from './errors.js';
import { readObject, readOwnership } from './health.js';
import { integer, object, parse, text, type ObjectValue } from './json.js';
import type { Setup } from './setup.js';
import type { Transport } from './transport.js';

const evidenceWindow = 30_000;

export async function oldOutage(setup: Setup, installed: ObjectValue): Promise<{ raw: string; archive: string; requestID: string } | undefined> {
  const { state, worker } = setup;
  const raw = await state.read('run-stop.json');
  if (raw === undefined) return undefined;
  const marker = object(parse(raw));
  const ownership = await readOwnership(state);
  const pid = integer(marker.pid);
  const stopped = integer(marker.stopped_at);
  const launched = ownership.launchStarted;
  requireValue(marker.cause === 'broker_rejected' && marker.requires_operator_action === true && pid > 0 &&
    ownership.status === 'absent' && ownership.launch_pid === pid && launched !== null && launched <= stopped && stopped <= state.sys.now(),
    'upgrade_terminal_stop_requires_operator', { marker_cause: marker.cause, pid, stopped_at: stopped });

  async function events(since: number, until: number): Promise<ObjectValue[]> {
    const lines = (await worker.logger.capture.export({ since: new Date(since).toISOString(), until: new Date(until).toISOString() }, true)).trimEnd().split('\n');
    const [meta, ...rows] = lines.map(line => object(parse(line)));
    requireValue(meta.complete === true, 'upgrade_outage_evidence_incomplete', { omissions: meta.omissions, pid, stopped_at: stopped });
    return rows;
  }
  const starts = (await events(launched, Math.min(stopped, launched + evidenceWindow))).filter(e =>
    e.msg === 'worker.supervision_started' && e.background === true && e.worker_id === installed.worker_id &&
    e.setup_id === installed.setup_id && integer(e.pid) === pid);
  requireValue(starts.length === 1, 'upgrade_outage_process_unconfirmed', { pid, stopped_at: stopped });
  const tail = await events(Math.max(launched, stopped - evidenceWindow), Math.min(state.sys.now(), stopped + evidenceWindow));
  const process = tail.filter(e => e.instance_id === starts[0].instance_id);
  const errors = process.filter(e => e.msg === 'worker.command_failed' && e.stopped_operation === 'run' && Date.parse(text(e.time)) >= stopped);
  const matches = process.filter(e => e.msg === 'worker.http_exchange' && e.route === '/api/v1/worker/status' &&
    e.method === 'GET' && e.endpoint === installed.origin && e.response_validation_cause === 'invalid_json' &&
    integer(e.http_status) === 404 && Date.parse(text(e.time)) <= stopped && e.request_id === errors[0]?.request_id);
  requireValue(errors.length === 1 && errors[0].cause === 'broker_rejected' && errors[0].response_validation_cause === 'invalid_json' &&
    integer(errors[0].http_status) === 404 && matches.length === 1 && typeof matches[0].request_id === 'string' && matches[0].request_id,
    'upgrade_outage_request_unconfirmed', { pid, stopped_at: stopped });
  return { raw, requestID: text(matches[0].request_id), archive: 'run-stop.' + digest(Buffer.from(raw)) + '.archived.json' };
}

export async function checkLocalWork(setup: Setup, transport: Transport): Promise<void> {
  const { state, worker } = setup;
  const pending = await readObject(state, 'pending.json');
  if (pending) requireValue(pending.worker_id === worker.config.worker_id && Array.isArray(pending.jobs) && pending.jobs.length === 0,
    'upgrade_local_work_unresolved');
  const acks = await state.child('acks');
  for (const name of (await acks.list()).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name))) {
    const ack = await readObject(acks, name);
    requireValue(ack?.state === 'confirmed', 'upgrade_local_work_unresolved', { job_id: ack?.job_id });
  }
  const journals = await state.child('journals');
  await journals.withLock('journal', async () => {
    for (const name of (await journals.list()).filter(name => /^operation-[A-Za-z0-9_-]+\.json$/.test(name))) {
      const entry = await readObject(journals, name);
      requireValue(entry && entry.worker_id === worker.config.worker_id && entry.origin === transport.endpoint, 'upgrade_local_work_unresolved');
      if (entry.state === 'accepted' || entry.state === 'rejected') continue;
      requireValue(entry.state === 'pending' || entry.state === 'uncertain', 'upgrade_local_work_unresolved');
      const job = await worker.getJob(transport, text(entry.job_id));
      requireValue(job.held === false && ['accepted', 'cancelled', 'interrupted'].includes(text(job.state)),
        'upgrade_local_work_unresolved', { job_id: job.id, job_state: job.state });
    }
  });
}
