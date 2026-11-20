import { isAbsolute, join } from 'node:path';
import { digest, Redactor } from './diagnostics.js';
import { cause, Failure, requireValue } from './errors.js';
import { encode, identifier, integer, object, parse, text, type ObjectValue } from './json.js';
import { State } from './state.js';

export const watchdogSettings = {
  health_window_ms: 30_000,
  stale_after_ms: 120_000,
  launch_observation_ms: 30_000,
  recheck_delay_ms: 1000,
  max_launch_attempts: 2,
  schedule_seconds: 300,
  timeout_seconds: 300,
};

export async function readObject(state: State, entry: string): Promise<ObjectValue | undefined> {
  const raw = await state.read(entry);
  return raw === undefined ? undefined : object(parse(raw));
}

export function installedPaths(root: string, home: string, workerID: string) {
  const directory = 'aaa-muse-worker-' + workerID;
  return {
    bin: join(root, 'bin'),
    launcher: join(root, 'bin', 'aaa-muse-worker'),
    hookDirectory: join(home, 'hooks', 'scripts', directory),
    skillDirectory: join(home, 'workspace', 'skills', directory),
  };
}

function age(now: number, at: number | null): number | null {
  return at !== null && Number.isFinite(at) && now >= at ? now - at : null;
}

export async function readOwnership(state: State) {
  const owner = await state.lockOwner('daemon');
  const launch = await readObject(state, 'launch.json');
  const launchPID = launch ? integer(launch.pid) : null;
  requireValue(launchPID === null || launchPID > 0, 'subscriber_owner_ambiguous');
  const ownerAlive = owner ? state.sys.alive(owner.pid) : false;
  const launchAlive = launchPID === null ? false : launchPID === owner?.pid ? ownerAlive : state.sys.alive(launchPID);
  const live = ownerAlive === true && owner?.pid === launchPID;
  const absent = ownerAlive === false && launchAlive === false;
  return {
    status: live ? 'live' as const : absent ? 'absent' as const : 'ambiguous' as const,
    owner: live ? owner : undefined,
    lock_pid: owner?.pid ?? null,
    launch_pid: launchPID,
    lock_pid_alive: ownerAlive ?? null,
    launch_pid_alive: launchAlive ?? null,
    launchStarted: launch?.started_at == null ? null : integer(launch.started_at),
  };
}

export async function readSubscriber(state: State) {
  const { owner, launchStarted, status, ...ownership } = await readOwnership(state);
  const current = await readObject(state, 'connection.json');
  const ack = current?.last_acknowledged ? object(current.last_acknowledged) : undefined;
  const heartbeat = ack?.at ?? current?.last_heartbeat_at;
  const now = state.sys.now();
  const heartbeatAge = typeof heartbeat === 'string' ? age(now, Date.parse(heartbeat)) : null;
  const owned = !!owner && current?.subscriber_owner === owner.owner && integer(current?.subscriber_pid) === owner.pid;
  const id = typeof current?.connection_id === 'string' ? identifier(current.connection_id) : null;
  const generation = current?.connection_generation == null ? null : integer(current.connection_generation);
  const currentAck = owned && id !== null && generation !== null && !!ack && ack.connection_id === id && integer(ack.connection_generation) === generation && heartbeatAge !== null;
  const stateSince = owned ? integer(current?.subscriber_started_at) : launchStarted;
  return {
    ...ownership, owner_state: status,
    pid: owner?.pid ?? null,
    connection_id: id,
    connection_generation: generation,
    connection_status: status === 'absent' ? 'offline' : !owned ? 'unobserved' : currentAck && current?.status === 'online'
      ? heartbeatAge < watchdogSettings.health_window_ms ? 'online' : 'expired'
      : current?.status === 'offline' ? 'offline' : 'connecting',
    heartbeat_evidence: currentAck ? 'current' : heartbeatAge !== null ? 'historical' : 'unobserved',
    last_heartbeat_at: typeof heartbeat === 'string' ? heartbeat : null,
    heartbeat_age_ms: heartbeatAge,
    unacknowledged_ms: (owned ? heartbeatAge : null) ?? age(now, stateSince),
    heartbeat_request_id: typeof ack?.request_id === 'string' ? ack.request_id : null,
  };
}

const pollEntry = 'hook-poll.json';

export async function beginHookPoll(state: State) {
  const previous = await readObject(state, pollEntry);
  const now = state.sys.now();
  const previousAttempt = previous ? integer(previous.last_attempt_at) : null;
  const gapAge = age(now, previousAttempt);
  const gap = gapAge !== null && gapAge > watchdogSettings.stale_after_ms
    ? { from: previousAttempt, to: now, duration_ms: gapAge } : undefined;
  const count = previous ? integer(previous.gap_count) : 0;
  const poll = { ...previous, last_attempt_at: now, gap_count: count + Number(!!gap), last_gap: gap ?? previous?.last_gap ?? null };
  await state.write(pollEntry, encode(poll));
  return { poll, gap };
}

export async function finishHookPoll(state: State, poll: Awaited<ReturnType<typeof beginHookPoll>>['poll']) {
  const subscriber = await readSubscriber(state);
  await state.write(pollEntry, encode({ ...poll, last_completed_at: state.sys.now(), last_observation: {
    pid: subscriber.pid, heartbeat_at: subscriber.last_heartbeat_at, heartbeat_evidence: subscriber.heartbeat_evidence,
    connection_id: subscriber.connection_id, connection_generation: subscriber.connection_generation,
  } }));
}

export async function readPoll(state: State) {
  const poll = await readObject(state, pollEntry);
  const attempted = poll ? integer(poll.last_attempt_at) : null;
  const completed = poll?.last_completed_at == null ? null : integer(poll.last_completed_at);
  return {
    last_attempt_at: attempted, attempt_age_ms: age(state.sys.now(), attempted),
    last_completed_at: completed, completion_age_ms: age(state.sys.now(), completed),
    gap_count: poll ? integer(poll.gap_count) : 0,
    last_gap: poll?.last_gap ?? null,
    last_observation: poll?.last_observation ?? null,
  };
}

export async function readActionable(state: State, workerID: string) {
  const saved = await readObject(state, 'pending.json');
  requireValue(!saved || saved.worker_id === workerID, 'pending_worker_mismatch');
  const cue = saved ?? { jobs: [] };
  requireValue(Array.isArray(cue.jobs), 'invalid_pending_cues');
  const jobs = cue.jobs.map(object).filter(job => job.needs_attention === true);
  const fingerprint = digest(encode(jobs.map(job => ({ job_id: job.job_id, generation: job.generation, context_receipt_id: job.context_receipt_id, state: job.state }))));
  return { cue, jobs, fingerprint };
}

export async function inspectHealth(state: State, home: string) {
  const installed = await readObject(state, 'installation.json');
  requireValue(installed, 'worker_setup_required', { entry: 'installation.json' });
  const workerID = identifier(installed.worker_id);
  const root = text(installed.root);
  const node = text(installed.node);
  const entry = text(installed.entry);
  requireValue([root, node, entry].every(isAbsolute), 'absolute_install_paths_required');
  const paths = installedPaths(root, home, workerID);

  async function checkPath(role: string, path: string, kind: 'directory' | 'private' | 'executable' | 'runtime' | 'bundle') {
    try {
      if (kind === 'runtime' || kind === 'bundle') {
        const info = kind === 'runtime' ? await state.io.stat(path) : await state.io.lstat(path);
        requireValue(info.isFile() && (kind === 'bundle' || (info.mode & 0o111) !== 0), 'unexpected_file_type');
      } else {
        await state.check(path, kind === 'directory', kind === 'executable' ? 0o700 : 0o600);
      }
      return { role, status: 'present' as const };
    } catch (error) {
      return { role, status: cause(error) === 'ENOENT' ? 'missing' as const : 'unsafe' as const, cause: cause(error),
        detail: error instanceof Failure ? error.fields : undefined };
    }
  }

  const requiredPaths = await Promise.all([
    checkPath('state', state.root, 'directory'),
    checkPath('installation', root, 'directory'),
    checkPath('launcher_directory', paths.bin, 'directory'),
    checkPath('launcher', paths.launcher, 'executable'),
    checkPath('node', node, 'runtime'),
    checkPath('bundle_entry', entry, 'bundle'),
    checkPath('diagnostics', state.path('diagnostics'), 'directory'),
    checkPath('credential', state.path('credential.key'), 'private'),
    checkPath('hook_directory', paths.hookDirectory, 'directory'),
    checkPath('hook', join(paths.hookDirectory, 'detector.sh'), 'executable'),
    checkPath('skill_directory', paths.skillDirectory, 'directory'),
    checkPath('skill', join(paths.skillDirectory, 'SKILL.md'), 'private'),
  ]);
  const subscriber = await readSubscriber(state);
  const hook = await readPoll(state);
  const action = await readActionable(state, workerID);
  const terminal = await readObject(state, 'run-stop.json');
  return {
    view: { worker_id: workerID, setup_id: identifier(installed.setup_id), installed_version: text(installed.package_version),
      observed_at: state.sys.now(), settings: watchdogSettings, required_paths: requiredPaths,
      subscriber, hook, terminal_stop: terminal && new Redactor().value(terminal), actionable_jobs: action.jobs.length, inference_readiness: 'unverified' },
    action,
  };
}
