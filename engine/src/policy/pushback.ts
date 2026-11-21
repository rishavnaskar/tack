/**
 * A site saying "slow down", and how long to stay away.
 *
 * HTTP 429 is a site rate-limiting this browser; a 503 that carries
 * Retry-After is a site saying when to come back. Either way the answer is to
 * stop working that site for the time it asked, or for a cautious default
 * when it did not say. Never a retry: retrying is what got the 429.
 */

export interface DocumentStatus {
  url: string;
  status: number;
  retryAfter: string | null;
}

export interface Pushback {
  status: number;
  /** When the site may be worked again, ms since the epoch. */
  until: number;
  /** Whether the wait came from the site's own Retry-After. */
  fromSite: boolean;
}

/** How long to stay away when a 429 says nothing about it. A short wait invites the next 429. */
export const DEFAULT_PUSHBACK_MS = { locked: 15 * 60_000, other: 5 * 60_000 } as const;
/** A Retry-After shorter than this still means slow down, across every session at once. */
const MIN_WAIT_MS = 30_000;
/** Longer than this is a typo or a block, not a wait: the person decides what happens next. */
const MAX_WAIT_MS = 24 * 3_600_000;

/** Retry-After as delay-seconds or an HTTP date, in ms from now; null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function readPushback(response: DocumentStatus | null, now: number, opts: { locked?: boolean } = {}): Pushback | null {
  if (!response) return null;
  const asked = retryAfterMs(response.retryAfter, now);
  if (response.status === 503 && asked === null) return null;
  if (response.status !== 429 && response.status !== 503) return null;
  const wait = asked ?? (opts.locked ? DEFAULT_PUSHBACK_MS.locked : DEFAULT_PUSHBACK_MS.other);
  return { status: response.status, until: now + Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, wait)), fromSite: asked !== null };
}

/** "14:05 UTC (in 15 min)": a time the agent and the person can both read. */
export function whenText(until: number, now: number): string {
  const at = new Date(until).toISOString().slice(11, 16);
  const seconds = Math.max(1, Math.ceil((until - now) / 1_000));
  const left = seconds < 120 ? `${seconds} s` : seconds < 7_200 ? `${Math.ceil(seconds / 60)} min` : `${Math.round(seconds / 3_600)} h`;
  return `${at} UTC (in ${left})`;
}

export function pushbackMessage(site: string, pushback: Pushback, now: number): string {
  const said = pushback.status === 429 ? 'HTTP 429 (Too Many Requests)' : 'HTTP 503 with Retry-After';
  const source = pushback.fromSite ? 'the wait the site asked for' : 'the site gave no time, so this is Fanfold\'s default wait';
  return `${site} answered ${said}: it is rate-limiting this browser. Stop working on ${site} now, in every session, and do not retry: `
    + `Fanfold refuses pages on ${site} until ${whenText(pushback.until, now)}; ${source}. `
    + 'Tell the user, and carry on with other sites meanwhile. Do not look for a way around it.';
}

export function pausedMessage(site: string, pause: { status: number; until: number }, now: number): string {
  return `Not opened: ${site} asked Fanfold to slow down (HTTP ${pause.status}), so pages on ${site} are refused until ${whenText(pause.until, now)}. `
    + 'Do not retry before then. Work on other sites meanwhile, or tell the user.';
}
