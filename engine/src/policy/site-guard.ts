/**
 * Around every page an agent opens, MCP session or Fanfold's own run: the
 * site's shared pace before, and whether the site pushed back after. See
 * site-pace.ts and pushback.ts.
 */
import { TERMS_LOCKED, type SitePolicies } from '../jobs/site-policies.ts';
import { pausedMessage, pushbackMessage, readPushback, whenText, type DocumentStatus, type Pushback } from './pushback.ts';
import { siteOf, sitePace, waitedNote, type Site, type SitePace } from './site-pace.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';
import type { Logger } from '../lib/log.ts';

/** What the guard needs: the site catalog, when there is one, and somewhere to say a site pushed back. */
export interface GuardContext {
  app: { sites?: Pick<SitePolicies, 'forUrl' | 'downgrade'> };
  log?: Pick<Logger, 'warn'>;
}

export function siteFor(ctx: GuardContext, url: string): Site | null {
  const policy = ctx.app.sites?.forUrl(url) ?? null;
  return siteOf(url, policy, policy ? TERMS_LOCKED.has(policy.key) : false);
}

/** A page on a site that asked for a pause, refused before anything was opened. */
export class SitePausedError extends Error {
  readonly site: Site;
  readonly pause: { status: number; until: number };
  constructor(site: Site, pause: { status: number; until: number }, now: number) {
    super(pausedMessage(site.label, pause, now));
    this.site = site;
    this.pause = pause;
  }
}

/**
 * Before opening a page: refuse a site that asked for a pause, and take a
 * slot in its pace. Returns a note for the agent when it had to wait.
 */
export async function beforeNavigation(ctx: GuardContext, url: string, pace: SitePace = sitePace): Promise<string> {
  const site = siteFor(ctx, url);
  if (!site) return '';
  const paused = pace.pausedUntil(site);
  if (paused) throw new SitePausedError(site, paused, Date.now());
  return waitedNote(site, await pace.take(site));
}

/**
 * Before an action on a page: refuse a site that asked for a pause, and on a
 * site held to a number of requests a minute, wait for room in it. Returns a
 * note for the agent when it had to wait.
 */
export async function beforeAction(ctx: GuardContext, url: string | undefined, pace: SitePace = sitePace): Promise<string> {
  const site = url ? siteFor(ctx, url) : null;
  if (!site) return '';
  const paused = pace.pausedUntil(site);
  if (paused) throw new SitePausedError(site, paused, Date.now());
  return site.rule.requestsPerMinute ? waitedNote(site, await pace.room(site)) : '';
}

/**
 * After a navigation, or an action that may have caused one: if the site
 * answered the page with 429 (or 503 and a Retry-After), pause it for every
 * session and say which site and until when; null otherwise.
 */
export function pushbackIn(
  ctx: GuardContext, response: DocumentStatus | null, pace: SitePace = sitePace,
): { site: Site; pushback: Pushback; now: number } | null {
  const site = response ? siteFor(ctx, response.url) : null;
  if (!response || !site) return null;
  const now = Date.now();
  const pushback = readPushback(response, now, { locked: site.locked });
  if (!pushback) return null;
  pace.pause(site, pushback.status, pushback.until);
  // Recorded the way a bot check is, so submitting there waits too.
  if (site.locked) ctx.app.sites?.downgrade(site.key, new Date(now), new Date(pushback.until), 'rate');
  ctx.log?.warn('site pushed back', { site: site.key, status: pushback.status, until: new Date(pushback.until).toISOString() });
  return { site, pushback, now };
}

/**
 * Where a navigation ended, when that is a site paused for now: a redirect,
 * a link clicked or a flow replayed can reach one that was never asked for.
 */
export function landedPaused(
  ctx: GuardContext, response: DocumentStatus | null, pace: SitePace = sitePace,
): { site: Site; pause: { status: number; until: number } } | null {
  const site = response ? siteFor(ctx, response.url) : null;
  const pause = site ? pace.pausedUntil(site) : null;
  return site && pause ? { site, pause } : null;
}

/** The page a navigation landed on is on a paused site: what the agent is told, once the browser has left it. */
function landedMessage(label: string, pause: { status: number; until: number }, now: number): string {
  return `Refused: the page this went to is on ${label}, which asked Fanfold to slow down (HTTP ${pause.status}), so pages on ${label} `
    + `are refused until ${whenText(pause.until, now)}. The browser left it and nothing more was done there. Do not go back to it before then.`;
}

/**
 * After a navigation, or an action that may have caused one: what to tell
 * the agent when the site pushed back, or when the page is on a site that is
 * paused, which the browser then leaves; '' otherwise.
 */
export async function afterNavigation(
  ctx: GuardContext, page: Pick<BrowserRuntime, 'documentResponse' | 'goto'>, since: number, pace: SitePace = sitePace,
): Promise<string> {
  const response = page.documentResponse?.(since) ?? null;
  const hit = pushbackIn(ctx, response, pace);
  if (hit) return pushbackMessage(hit.site.label, hit.pushback, hit.now);
  const held = landedPaused(ctx, response, pace);
  if (!held) return '';
  await page.goto('about:blank').catch(() => {});
  return landedMessage(held.site.label, held.pause, Date.now());
}
