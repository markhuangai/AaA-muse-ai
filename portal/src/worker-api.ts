export interface Qualification {
  id: string;
  created_at: string;
  connection_id: string;
  connection_generation: number;
  capabilities: string[];
  evidence: { action: string; evidence_kind?: string; evidence_reference: string };
}

export interface Worker {
  id: string;
  name: string;
  registered_at: string;
  revoked_at: string | null;
  last_contact_at: string | null;
  connection_status: string;
  work_status: string;
  current_job: { job_id: string; generation: number } | null;
  waiting_for_client_tool: number;
  last_heartbeat_at: string | null;
  inference_readiness: string;
  qualification?: Qualification | null;
  qualification_history: Qualification[];
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
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');

function qualification(value: unknown): value is Qualification {
  return object(value) && typeof value.id === 'string' && date(value.created_at) && typeof value.connection_id === 'string' &&
    integer(value.connection_generation) && strings(value.capabilities) && object(value.evidence) &&
    typeof value.evidence.action === 'string' && typeof value.evidence.evidence_reference === 'string' &&
    (value.evidence.evidence_kind === undefined || typeof value.evidence.evidence_kind === 'string');
}

export function isWorker(value: unknown): value is Worker {
  return object(value) && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id) && typeof value.name === 'string' &&
    date(value.registered_at) && optionalDate(value.revoked_at) && optionalDate(value.last_contact_at) &&
    typeof value.connection_status === 'string' && typeof value.work_status === 'string' &&
    (value.current_job === null || (object(value.current_job) && typeof value.current_job.job_id === 'string' && integer(value.current_job.generation))) &&
    integer(value.waiting_for_client_tool) && optionalDate(value.last_heartbeat_at) && typeof value.inference_readiness === 'string' &&
    (value.qualification == null || qualification(value.qualification)) &&
    Array.isArray(value.qualification_history) && value.qualification_history.every(qualification);
}

export function isEnrollment(value: unknown, kind: EnrollmentKind): value is Enrollment {
  if (!object(value) || typeof value.enrollment_id !== 'string' || !/^[a-f0-9]{32}$/.test(value.enrollment_id) ||
    !date(value.created_at) || !date(value.expires_at) || Date.parse(value.expires_at) <= Date.parse(value.created_at)) return false;
  if (kind === 'code') return typeof value.enrollment_code === 'string' && /^muse_enroll_[A-Za-z0-9_-]{43}$/.test(value.enrollment_code);
  return typeof value.setup_prompt === 'string' && value.setup_prompt.length > 0 && object(value.worker_package) &&
    typeof value.worker_package.version === 'string' && typeof value.worker_package.url === 'string' &&
    typeof value.worker_package.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.worker_package.sha256);
}
