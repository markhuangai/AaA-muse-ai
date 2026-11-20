import { cause, Failure } from './errors.js';
import { inspectHealth, readObject, readSubscriber, watchdogSettings } from './health.js';
import { encode, integer, type ObjectValue } from './json.js';
import type { Setup } from './setup.js';

type Observation = Awaited<ReturnType<typeof inspectHealth>>['view'];
type Subscriber = Observation['subscriber'];

function recoveryBlock(observed: Observation) {
  const unavailable = observed.required_paths.filter(path => path.status !== 'present');
  if (unavailable.length) return { cause: 'required_paths_unavailable', paths: unavailable.map(path => ({ role: path.role, status: path.status })),
    corrective_action: 'Inspect and restore the reported private installation paths under owner control.' };
  if (observed.terminal_stop) return { cause: 'subscriber_terminal_stop', corrective_action: 'Inspect the saved terminal outcome before taking operator action.' };
  if (observed.subscriber.owner_state === 'ambiguous') return { cause: 'subscriber_owner_ambiguous', corrective_action: 'Inspect the launch and daemon ownership evidence.' };
  return undefined;
}

function hookProblem(hook: Observation['hook']) {
  if (hook.attempt_age_ms === null || hook.completion_age_ms === null) return 'hook_poll_unobserved';
  if (hook.attempt_age_ms > watchdogSettings.stale_after_ms) return 'hook_poll_stale';
  if (hook.completion_age_ms > watchdogSettings.stale_after_ms) return 'hook_completion_stale';
  return null;
}

function heartbeatStalled(subscriber: Subscriber) {
  return subscriber.connection_status !== 'online' &&
    (subscriber.unacknowledged_ms === null || subscriber.unacknowledged_ms > watchdogSettings.stale_after_ms);
}

function heartbeatSince(subscriber: Subscriber, since: number) {
  return subscriber.connection_status === 'online' && subscriber.last_heartbeat_at !== null && Date.parse(subscriber.last_heartbeat_at) >= since;
}

export async function checkWatchdog(setup: Setup, signal: AbortSignal): Promise<ObjectValue | undefined> {
  const { state } = setup;
  const { logger } = setup.worker;
  let release;
  try { release = await state.lock('watchdog', false); }
  catch (error) {
    if (error instanceof Failure && error.code === 'subscriber_already_running' && error.fields.lock === 'watchdog') {
      await logger.log('DEBUG', 'watchdog.overlap', { outcome: 'existing_tick' });
      return;
    }
    throw error;
  }
  try {
    return await runTick(setup, signal);
  } finally { await release(); }
}

async function runTick(setup: Setup, signal: AbortSignal): Promise<ObjectValue | undefined> {
  const { state } = setup;
  const { logger } = setup.worker;
  const started = state.sys.now();
  const inspect = () => inspectHealth(state, setup.io.home);
  const before = await inspect();
  Object.assign(logger.base, { worker_id: before.view.worker_id, setup_id: before.view.setup_id,
    operation_id: logger.instance, watchdog_settings: watchdogSettings });
  const prior = await readObject(state, 'watchdog-notice.json');
  let after = before;
  let attempts = 0;
  let lastFailure: unknown;
  let blocked = recoveryBlock(before.view);
  let restored = false;

  if (!blocked && before.view.subscriber.owner_state === 'absent') {
    while (attempts < watchdogSettings.max_launch_attempts && !signal.aborted) {
      attempts++;
      const attemptAt = state.sys.now();
      lastFailure = undefined;
      try {
        await setup.ensureRunning(attempts);
        for (let elapsed = 0; elapsed < watchdogSettings.launch_observation_ms && !signal.aborted; elapsed += 1000) {
          const subscriber = await readSubscriber(state);
          if (heartbeatSince(subscriber, attemptAt) || subscriber.owner_state !== 'live') break;
          await state.sys.wait(1000);
        }
      } catch (error) {
        lastFailure = error;
      }
      after = await inspect();
      blocked = recoveryBlock(after.view);
      const subscriber = after.view.subscriber;
      restored = !blocked && heartbeatSince(subscriber, attemptAt) &&
        (subscriber.connection_id !== before.view.subscriber.connection_id || subscriber.connection_generation !== before.view.subscriber.connection_generation);
      const retryable = lastFailure instanceof Failure && lastFailure.retryable && subscriber.owner_state === 'absent';
      await logger.log(retryable ? 'WARN' : 'DEBUG', 'watchdog.launch_attempt', { attempt: attempts, attempt_at: attemptAt,
        duration_ms: state.sys.now() - attemptAt, before: before.view.subscriber, observed: subscriber,
        ...(lastFailure instanceof Failure ? { error: lastFailure.fields } : {}),
        cause: lastFailure ? cause(lastFailure) : null, outcome: restored ? 'heartbeat_confirmed' : 'heartbeat_unconfirmed', retryable });
      if (blocked || restored || !retryable) break;
    }
  } else if (!blocked && (hookProblem(before.view.hook) || heartbeatStalled(before.view.subscriber)) && !signal.aborted) {
    await state.sys.wait(watchdogSettings.recheck_delay_ms);
    after = await inspect();
    blocked = recoveryBlock(after.view);
  }

  const observed = after.view;
  const subscriber = observed.subscriber;
  const diagnostics = { settings: watchdogSettings, worker_id: observed.worker_id, setup_id: observed.setup_id,
    installed_version: observed.installed_version, subscriber, hook: observed.hook, attempts, duration_ms: state.sys.now() - started };
  await logger.log('DEBUG', 'watchdog.observed', { ...diagnostics, before: before.view, observed,
    observed_jobs: after.action.jobs, outcome: signal.aborted ? 'aborted' : 'evaluated' });
  if (signal.aborted) return;

  const notices: ObjectValue[] = [];
  const hookIssue = hookProblem(observed.hook);
  const priorGap = prior?.gap_count === undefined ? 0 : integer(prior.gap_count);
  const resumedGap = observed.hook.gap_count > priorGap;
  if (resumedGap) {
    notices.push({ kind: 'hook_gap', gaps: observed.hook.gap_count - priorGap, last_gap: observed.hook.last_gap });
  }
  if (hookIssue && hookIssue !== prior?.hook_issue) {
    notices.push({ kind: 'hook_stalled', cause: hookIssue });
    await logger.log('WARN', 'watchdog.hook_stalled', { ...diagnostics, cause: hookIssue, outcome: 'hook_unconfirmed',
      corrective_action: 'Inspect the native hook registration and the last genuine poll.' });
  } else if (!hookIssue && (prior?.hook_issue || resumedGap)) {
    notices.push({ kind: 'hook_recovered', last_completed_at: observed.hook.last_completed_at });
    await logger.log('INFO', 'watchdog.hook_recovered', { ...diagnostics, outcome: 'genuine_poll_completed' });
  }

  const failedRecovery = !restored && attempts > 0;
  const problem = blocked?.cause ?? (failedRecovery ? lastFailure ? cause(lastFailure) : 'subscriber_recovery_unconfirmed'
    : subscriber.owner_state === 'absent' ? 'subscriber_absent' : heartbeatStalled(subscriber) ? 'heartbeat_unconfirmed' : null);
  const problemKey = blocked?.paths ? encode([problem, blocked.paths]) : problem;
  const priorProblemAt = prior?.subscriber_problem_at == null ? null : integer(prior.subscriber_problem_at);
  const recovered = !problem && (restored || (priorProblemAt !== null && heartbeatSince(subscriber, priorProblemAt)));
  if (recovered) {
    notices.push({ kind: 'subscriber_recovered', pid: subscriber.pid, connection_generation: subscriber.connection_generation });
    await logger.log('INFO', 'watchdog.subscriber_recovered', { ...diagnostics, request_id: subscriber.heartbeat_request_id, outcome: 'heartbeat_confirmed' });
  } else if (problem) {
    const action = blocked?.corrective_action ?? (subscriber.owner_state === 'live'
      ? 'Keep the live subscriber and inspect its reconnect and broker heartbeat evidence.'
      : 'Inspect the failed recovery and broker reachability before correcting the installation.');
    if (problemKey !== prior?.subscriber_issue) notices.push({ kind: 'subscriber_still_down', cause: problem, ...(blocked?.paths ? { paths: blocked.paths } : {}) });
    if (problemKey !== prior?.subscriber_issue || attempts > 0) {
      await logger.log(blocked || failedRecovery ? 'ERROR' : 'WARN', blocked || failedRecovery ? 'watchdog.recovery_failed' : 'watchdog.subscriber_stalled',
        { ...diagnostics, ...(lastFailure instanceof Failure ? lastFailure.fields : {}), cause: problem, corrective_action: action,
          required_paths: observed.required_paths, terminal_stop: observed.terminal_stop, outcome: blocked ? 'blocked' : failedRecovery ? 'exhausted' : 'observe_only' });
    }
  }

  if (observed.actionable_jobs > 0 && after.action.fingerprint !== prior?.jobs_fingerprint) {
    notices.push({ kind: 'actionable_work', count: observed.actionable_jobs });
    await logger.log('INFO', 'watchdog.actionable_work', { ...diagnostics, actionable_jobs: observed.actionable_jobs, outcome: 'hook_retains_wake_authority' });
  }

  const next = { hook_issue: hookIssue, gap_count: observed.hook.gap_count,
    subscriber_issue: problemKey ?? (recovered ? null : prior?.subscriber_issue ?? null),
    subscriber_problem_at: problemKey ? problemKey === prior?.subscriber_issue ? priorProblemAt : started : recovered ? null : priorProblemAt,
    jobs_fingerprint: after.action.fingerprint };
  if (!prior || encode(next) !== encode(prior)) await state.write('watchdog-notice.json', encode(next));
  if (notices.length) return { worker_id: observed.worker_id, checked_at: observed.observed_at, notice_id: logger.instance, notices };
  return undefined;
}
