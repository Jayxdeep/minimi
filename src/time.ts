/** Time helpers shared by the planner and the recall layer. */

export const MAX_PAST_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5 years
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000; // 1 day

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const FALLBACK_TZ = 'UTC';

export function isValidTimezone(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/** Never let an invalid client timezone crash a turn. */
export function safeTimezone(candidate: unknown): string {
  return isValidTimezone(candidate) ? candidate : FALLBACK_TZ;
}

/**
 * "Wednesday 2026-11-18 13:00 GMT+01:00" — unambiguous for a model that must
 * reason about "last Tuesday" without doing timezone math on its own.
 */
export function formatLocalNow(now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const offset = parts.timeZoneName ?? '';
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${offset}`.trim();
}

/**
 * Deterministic guardrail for model-produced ranges ("AI proposes, code
 * disposes"). Returns null for unparseable, inverted, or implausible ranges.
 */
export function clampRange(
  range: readonly [string, string],
  now: Date,
): [string, string] | null {
  const start = Date.parse(range[0]);
  const end = Date.parse(range[1]);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return null;
  }

  const floor = now.getTime() - MAX_PAST_MS;
  const ceiling = now.getTime() + MAX_FUTURE_MS;

  if (end < floor || start > ceiling) return null;

  return [
    new Date(Math.max(start, floor)).toISOString(),
    new Date(Math.min(end, ceiling)).toISOString(),
  ];
}
