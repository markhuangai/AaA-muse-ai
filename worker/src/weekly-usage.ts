import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encode, type ObjectValue } from './json.js';

export const weeklyUsageHeader = 'X-Muse-Worker-Weekly-Usage';
export const weeklyUsageTimeoutMs = 2_000;
export const weeklyUsageMaxBytes = 8 * 1024;
const run = promisify(execFile);
const usageLine = /^Usage: (100(?:\.0+)?|[0-9]{1,2}(?:\.[0-9]{1,9})?)% of (?:free )?weekly limit\.$/;
const resetLine = /^Weekly limit resets ((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12][0-9]|3[01]) at (?:[1-9]|1[0-2]):[0-5][0-9] [AP]M (?:UTC|GMT|[ECMP][SD]T))\.?$/;

type Reading = { used_percent: number; reset_label?: string };

export function parseWeeklyUsage(output: string): Reading | undefined {
  const lines = output.split(/\r?\n/).map(line => line.trim());
  const usage = lines.filter(line => line.startsWith('Usage:'));
  const value = usage.length === 1 ? usageLine.exec(usage[0])?.[1] : undefined;
  if (value === undefined) return;
  const resets = lines.filter(line => line.startsWith('Weekly limit resets '));
  const reset = resets.length === 1 ? resetLine.exec(resets[0])?.[1] : undefined;
  return { used_percent: Number(value), ...(reset ? { reset_label: reset } : {}) };
}

export async function readWeeklyUsage(): Promise<{ reading: Reading } | { reason: string }> {
  try {
    const { stdout } = await run('subscription-status', ['status'], {
      timeout: weeklyUsageTimeoutMs, killSignal: 'SIGKILL', maxBuffer: weeklyUsageMaxBytes,
    });
    const reading = parseWeeklyUsage(stdout);
    return reading ? { reading } : { reason: 'unrecognized_weekly_usage' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    const reason = failure.code === 'ENOENT' ? 'subscription_status_missing' :
      failure.code === 'EACCES' || failure.code === 'EPERM' ? 'subscription_status_denied' :
      failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'subscription_status_output_limit' :
      failure.killed ? 'subscription_status_timeout' : 'subscription_status_failed';
    return { reason };
  }
}

export function weeklyUsageHeaders(reading?: ObjectValue): Record<string, string> {
  if (!reading) return {};
  return { [weeklyUsageHeader]: Buffer.from(encode(reading)).toString('base64url') };
}
