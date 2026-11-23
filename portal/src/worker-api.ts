interface ModelReport {
  model_name?: string;
  context_window_tokens?: number;
  reported_at: string;
}

interface WeeklyUsage {
  used_percent: number;
  observed_at: string;
  reset_label?: string;
  stale: boolean;
}

export interface WorkerUpdate {
  version?: string;
  contract?: string;
  state?: string;
  target?: { version: string };
  reason?: string;
  retry_at?: string;
  id?: string;
}

export interface Worker {
  id: string;
  name: string;
  registered_at: string;
  revoked_at: string | null;
  last_contact_at: string | null;
  connection_status: string;
  offline_for_ms?: number;
  work_status: string;
  current_job: { job_id: string; generation: number } | null;
  waiting_for_client_tool: number;
  last_heartbeat_at: string | null;
  last_poll_at?: string | null;
  current_claim?: { job_id: string; claim_id: string; claimed_at: string; deadline_at: string } | null;
  claim_age_ms?: number;
  claim_stage?: string;
  busy_reason?: string;
  claim_started_at?: string;
  model_report?: ModelReport;
  worker_update?: WorkerUpdate;
  weekly_usage?: WeeklyUsage;
}

export interface Enrollment {
  enrollment_id: string;
  created_at: string;
  expires_at: string;
  enrollment_code?: string;
  setup_prompt?: string;
  worker_package?: { version: string; sha256: string; url: string };
}

export type EnrollmentKind = 'prompt' | 'code';
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalDate = (value: unknown) => value === null || date(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

function modelReport(value: unknown): value is ModelReport {
  return object(value) && date(value.reported_at) &&
    (value.model_name !== undefined || value.context_window_tokens !== undefined) &&
    (value.model_name === undefined || typeof value.model_name === 'string' && value.model_name.trim().length > 0) &&
    (value.context_window_tokens === undefined || integer(value.context_window_tokens) && Number(value.context_window_tokens) > 0);
}

function isWorkerUpdate(value: unknown): value is WorkerUpdate {
  return object(value) && [value.version, value.contract, value.state, value.reason, value.id].every(field => field === undefined || typeof field === 'string') &&
    (value.retry_at === undefined || date(value.retry_at)) &&
    (value.target === undefined || (object(value.target) && typeof value.target.version === 'string'));
}

function isWeeklyUsage(value: unknown): value is WeeklyUsage {
  return object(value) && typeof value.used_percent === 'number' && value.used_percent >= 0 && value.used_percent <= 100 &&
    date(value.observed_at) && typeof value.stale === 'boolean' &&
    (value.reset_label === undefined || typeof value.reset_label === 'string' && value.reset_label.length <= 48);
}

export function isWorker(value: unknown): value is Worker {
  return object(value) && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id) && typeof value.name === 'string' &&
    date(value.registered_at) && optionalDate(value.revoked_at) && optionalDate(value.last_contact_at) &&
    typeof value.connection_status === 'string' && (value.offline_for_ms === undefined || integer(value.offline_for_ms)) &&
    typeof value.work_status === 'string' &&
    (value.current_job === null || (object(value.current_job) && typeof value.current_job.job_id === 'string' && integer(value.current_job.generation))) &&
    integer(value.waiting_for_client_tool) && optionalDate(value.last_heartbeat_at) &&
    (value.last_poll_at === undefined || optionalDate(value.last_poll_at)) &&
    (value.current_claim === undefined || value.current_claim === null || (object(value.current_claim) && typeof value.current_claim.job_id === 'string' &&
      typeof value.current_claim.claim_id === 'string' && date(value.current_claim.claimed_at) && date(value.current_claim.deadline_at))) &&
    (value.claim_age_ms === undefined || integer(value.claim_age_ms)) && (value.claim_stage === undefined || typeof value.claim_stage === 'string') &&
    (value.busy_reason === undefined || typeof value.busy_reason === 'string') &&
    (value.claim_started_at === undefined || date(value.claim_started_at)) &&
    (value.model_report === undefined || modelReport(value.model_report)) &&
    (value.worker_update === undefined || isWorkerUpdate(value.worker_update)) &&
    (value.weekly_usage === undefined || isWeeklyUsage(value.weekly_usage));
}

export function isEnrollment(value: unknown, kind: EnrollmentKind): value is Enrollment {
  if (!object(value) || typeof value.enrollment_id !== 'string' || !/^[a-f0-9]{32}$/.test(value.enrollment_id) ||
    !date(value.created_at) || !date(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.created_at)) return false;
  if (kind === 'code') return typeof value.enrollment_code === 'string' && /^muse_enroll_[A-Za-z0-9_-]{43}$/.test(value.enrollment_code);
  return typeof value.setup_prompt === 'string' && value.setup_prompt.length > 0 && object(value.worker_package) &&
    typeof value.worker_package.version === 'string' && typeof value.worker_package.url === 'string' &&
    typeof value.worker_package.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.worker_package.sha256);
}
