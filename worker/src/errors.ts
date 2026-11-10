export class Failure extends Error {
  constructor(public code: string, public fields: Record<string, unknown> = {}, public retryable = false) {
    super(code);
  }
}

export function cause(error: unknown): string {
  if (error instanceof Failure) return error.code;
  const e = error as { code?: string; cause?: { code?: string } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'operation_failed';
}

export function requireValue(condition: unknown, code: string, fields: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw new Failure(code, fields);
}
