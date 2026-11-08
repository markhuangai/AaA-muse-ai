export function logEvent(core, level, event, fields = {}) {
  const line = JSON.stringify({ level: level.toUpperCase(), event, ...fields });
  if (core) core[level](line);
  else console.log(level === 'error' ? `::error::${line}` : line);
}

export function reportApiFailure(core, operation, error, fields = {}) {
  logEvent(core, 'error', 'review.api_failed', {
    ...fields,
    operation,
    http_status: Number.isInteger(error?.status) ? error.status : null,
    request_id: error?.response?.headers?.['x-github-request-id'] ?? null,
    cause: error?.status === 403 ? 'permission_or_rate_limit' : 'required_api_operation_failed',
  });
  core.setFailed(`Required ${operation} failed; inspect review.api_failed diagnostics.`);
}
