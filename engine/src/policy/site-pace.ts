/**
 * One pace per site, shared by every session.
 *
 * Five agents in five windows are one browser to the site, on one account:
 * twenty-five job pages in a minute between them is what got LinkedIn to
 * answer 429. Each navigation to a site takes a slot here first, and a slot
 * that is too far off is refused rather than waited for, so no call stalls
 * for long. A site that pushed back is paused for every session alike.
 *
 * This is backing off, nothing else: pages are opened the same way, only less
 * often.
 */

export interface PaceRule {
  /** Sustained spacing between pages on the site, across all sessions. */
  intervalMs: number;
  /** Pages that may go at once before the spacing applies. */
  burst: number;
  /** The longest one call waits for its slot; beyond it the call is refused. */
  maxWaitMs: number;
  /**
   * The most requests Fanfold sends the site in any minute, all sessions
   * together. A page's own fetches count, so clicking through a list is paced
   * as well as opening pages.
   */
  requestsPerMinute?: number;
}

/**
 * LinkedIn's limit was measured on 2026-11-14 with job pages opened at an
 * even, rising rate: it answered 429 to every request at once when the
 * browser had sent it about 2,000 in a minute (25 job pages, 80 requests
 * each), and was still refusing a minute later. It counts requests, not
 * pages, so that is what is held here, to half of what it refused.
 *
 * Other terms-locked sites (Indeed) at about what a person reading postings
 * does, ten pages a minute; other job boards at thirty; anything else at
 * sixty, which only a fan-out of one site ever reaches.
 */
export const PACE: Readonly<Record<'linkedin' | 'locked' | 'catalog' | 'other', PaceRule>> = {
  linkedin: { intervalMs: 4_000, burst: 2, maxWaitMs: 20_000, requestsPerMinute: 1_000 },
  locked: { intervalMs: 6_000, burst: 2, maxWaitMs: 20_000 },
  catalog: { intervalMs: 2_000, burst: 4, maxWaitMs: 20_000 },
  other: { intervalMs: 1_000, burst: 6, maxWaitMs: 15_000 },
};

export interface Site {
  /** Shared key: the catalog's key, or the host for a site it does not know. */
  key: string;
  /** How it is named to the agent. */
  label: string;
  /** The registered domain its requests are counted under. */
  domain: string;
  locked: boolean;
  /** Pages on this machine (fixtures, dev servers) are never paced. */
  local: boolean;
  rule: PaceRule;
}

const LOCAL = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

export function isLocalHost(hostname: string): boolean {
  return LOCAL.test(hostname);
}

/** Second-level labels under a country's domain that are not themselves a site: example.co.uk, example.com.au. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nic', 'mil', 'ltd', 'plc', 'sch', 'nhs', 'gen', 'biz', 'info']);

/**
 * The part of a host that one owner registers: careers.example.com and
 * example.com are one site, as are jobs.example.co.uk and example.co.uk. A
 * close reading of the public suffix list, without the list.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (isLocalHost(host) || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const [second, top] = labels.slice(-2);
  return labels.slice(top.length === 2 && SECOND_LEVEL.has(second) ? -3 : -2).join('.');
}

/** The site a URL belongs to. `catalog` is the site policy the URL matches, if any. */
export function siteOf(url: string, catalog?: { key: string; label: string } | null, locked = false): Site | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const site = registrableDomain(parsed.hostname);
  if (catalog) {
    const rule = catalog.key === 'linkedin' ? PACE.linkedin : locked ? PACE.locked : PACE.catalog;
    return { key: catalog.key, label: catalog.label, domain: site, locked, local: false, rule };
  }
  const key = parsed.port ? `${site}:${parsed.port}` : site;
  return { key, label: key, domain: site, locked: false, local: isLocalHost(parsed.hostname.replace(/\.+$/, '')), rule: PACE.other };
}

export class PaceRefusal extends Error {}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

export class SitePace {
  readonly #clock: Clock;
  /** Per site, when the next slot falls due if nobody else asks (the GCRA's theoretical arrival time). */
  readonly #due = new Map<string, number>();
  readonly #paused = new Map<string, { status: number; until: number }>();
  /** Per counted domain, the requests sent in each of the last sixty seconds. */
  readonly #sent = new Map<string, Map<number, number>>();

  constructor(clock: Clock = realClock) {
    this.#clock = clock;
  }

  pause(site: Site, status: number, until: number): void {
    const held = this.#paused.get(site.key);
    if (!held || held.until < until) this.#paused.set(site.key, { status, until });
  }

  pausedUntil(site: Site): { status: number; until: number } | null {
    const held = this.#paused.get(site.key);
    if (!held) return null;
    if (held.until > this.#clock.now()) return held;
    this.#paused.delete(site.key);
    return null;
  }

  /** A request a page sent. Counted only for a site held to a number of requests a minute. */
  sent(hostname: string): void {
    const counts = this.#sent.get(registrableDomain(hostname));
    if (!counts) return;
    const second = Math.floor(this.#clock.now() / 1_000);
    counts.set(second, (counts.get(second) ?? 0) + 1);
    if (counts.size > 90) for (const s of counts.keys()) if (s <= second - 60) counts.delete(s);
  }

  /** Requests sent to the site in the last minute, by every session. */
  sentLately(site: Site): number {
    const floor = Math.floor(this.#clock.now() / 1_000) - 60;
    let n = 0;
    for (const [second, count] of this.#sent.get(site.domain) ?? []) if (second > floor) n += count;
    return n;
  }

  /** How long until the site's last minute holds fewer requests than it is allowed; 0 when it does now. */
  #room(site: Site, now: number): number {
    const budget = site.rule.requestsPerMinute;
    if (!budget) return 0;
    const counts = this.#sent.get(site.domain);
    if (!counts) {
      this.#sent.set(site.domain, new Map());
      return 0;
    }
    const floor = Math.floor(now / 1_000) - 60;
    const live = [...counts].filter(([second]) => second > floor).sort((a, b) => a[0] - b[0]);
    let total = live.reduce((n, [, count]) => n + count, 0);
    for (const [second, count] of live) {
      if (total < budget) break;
      total -= count;
      if (total < budget) return Math.max(0, (second + 61) * 1_000 - now);
    }
    return 0;
  }

  #full(site: Site, wait: number): PaceRefusal {
    return new PaceRefusal(
      `Not done yet: Fanfold has sent ${site.label} as many requests in the last minute as it allows itself `
      + `(${site.rule.requestsPerMinute}, all sessions together; ${site.label} refuses everything for a while when it is sent too many). `
      + `Try again in ${Math.ceil(wait / 1_000)} s, or do something else meanwhile.`,
    );
  }

  /**
   * Take the next slot for a page on this site. Resolves with how long it
   * waited; throws PaceRefusal, taking nothing, when that would be longer
   * than the rule allows.
   */
  async take(site: Site): Promise<number> {
    if (site.local) return 0;
    const { intervalMs, burst, maxWaitMs } = site.rule;
    const now = this.#clock.now();
    const due = Math.max(this.#due.get(site.key) ?? now, now);
    const spaced = Math.max(0, due - (burst - 1) * intervalMs - now);
    const room = this.#room(site, now);
    const wait = Math.max(spaced, room);
    if (wait > maxWaitMs) {
      if (room > spaced) throw this.#full(site, wait);
      throw new PaceRefusal(
        `Not opened yet: other sessions already hold ${site.label}'s next ${Math.round(maxWaitMs / 1_000)} s of pages. `
        + `Fanfold keeps ${site.label} to one page every ${Math.round(intervalMs / 1_000)} s across all sessions. `
        + `Try this one again in ${Math.ceil(wait / 1_000)} s, or do something else meanwhile.`,
      );
    }
    this.#due.set(site.key, Math.max(due, now + room) + intervalMs);
    if (wait > 0) await this.#clock.sleep(wait);
    return wait;
  }

  /**
   * Before an action on a page of this site: wait for room in its minute of
   * requests, as take does, without taking a page's slot.
   */
  async room(site: Site): Promise<number> {
    if (site.local) return 0;
    const wait = this.#room(site, this.#clock.now());
    if (wait > site.rule.maxWaitMs) throw this.#full(site, wait);
    if (wait > 0) await this.#clock.sleep(wait);
    return wait;
  }
}

export function waitedNote(site: Site, waitedMs: number): string {
  if (waitedMs < 500) return '';
  const budget = site.rule.requestsPerMinute ? ` and ${site.rule.requestsPerMinute} requests a minute` : '';
  return `Note: waited ${Math.round(waitedMs / 1_000)} s first, to keep to ${site.label}'s pace `
    + `(one page every ${Math.round(site.rule.intervalMs / 1_000)} s${budget} across all sessions).`;
}

/** The one every session shares. */
export const sitePace = new SitePace();
