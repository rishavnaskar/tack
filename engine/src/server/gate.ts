/**
 * What each route does while Fanfold is locked (auth/access.ts), decided here
 * for every route at once, by the group it belongs to. A route not listed is
 * refused, so a new one stays locked until it is added on purpose.
 */
import type { Access } from '../auth/access.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * `open`: the page, its event stream and signing in, the same locked or not.
 * `state`: the app state, in its usual shape and holding nothing of the person's.
 * `setup`: how a signed-in person adds their name and email, which works fully
 *   then; signed out, a read of it holds nothing and a change is refused.
 * `empty`: the person's data, in its usual shape and holding nothing.
 */
export type Group = 'open' | 'state' | 'setup' | 'empty';

export interface LockedRoute {
  method: Method;
  path: string | RegExp;
  group: Group;
  /** A setup route that also serves other pages: it runs while locked only when setup sent it (`?from=setup`). */
  fromSetup?: boolean;
}

export const LOCKED_ROUTES: readonly LockedRoute[] = [
  { method: 'GET', path: '/', group: 'open' },
  { method: 'GET', path: '/api/stream', group: 'open' },
  { method: 'GET', path: '/api/auth', group: 'open' },
  { method: 'POST', path: '/api/auth/session', group: 'open' },
  { method: 'POST', path: '/api/auth/signout', group: 'open' },
  // Whether the Fanfold extension is linked: nothing about the person.
  { method: 'GET', path: '/api/extension', group: 'open' },
  { method: 'GET', path: '/api/state', group: 'state' },
  { method: 'GET', path: '/api/setup', group: 'setup' },
  { method: 'POST', path: '/api/setup/snooze', group: 'setup' },
  { method: 'PUT', path: '/api/profile', group: 'setup' },
  // Where the person may work, as setup's work step saves it.
  { method: 'PUT', path: '/api/profile/rights', group: 'setup' },
  { method: 'POST', path: '/api/profile/extract', group: 'setup' },
  { method: 'POST', path: '/api/documents', group: 'setup', fromSetup: true },
  { method: 'POST', path: /^\/api\/documents\/[\w-]+\/mine$/, group: 'setup', fromSetup: true },
  { method: 'POST', path: '/api/profile/linkedin-export', group: 'setup', fromSetup: true },
  { method: 'GET', path: '/api/model', group: 'setup' },
  { method: 'PUT', path: '/api/model/key', group: 'setup' },
  // Signed in, only what setup saved: the facts and the files, never the answers or what was worked out.
  { method: 'GET', path: '/api/profile', group: 'empty' },
  { method: 'GET', path: '/api/conversations', group: 'empty' },
  { method: 'GET', path: '/api/workers', group: 'empty' },
  { method: 'GET', path: '/api/applications', group: 'empty' },
  { method: 'GET', path: '/api/sites', group: 'empty' },
  { method: 'GET', path: '/api/playbooks', group: 'empty' },
  { method: 'GET', path: '/api/profile/sites', group: 'empty' },
  { method: 'GET', path: '/api/connect', group: 'empty' },
  { method: 'GET', path: '/api/teach', group: 'empty' },
  { method: 'GET', path: '/api/tabs', group: 'empty' },
];

export function lockedRoute(method: string | undefined, pathname: string): LockedRoute | null {
  return LOCKED_ROUTES.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === pathname : r.path.test(pathname))) ?? null;
}

/** What one request does while Fanfold is locked: runs as usual, gets the state or an empty answer, or is refused. */
export type Verdict = 'run' | 'state' | 'empty' | 'refuse';

export function verdict(a: Access, method: string | undefined, url: URL): Verdict {
  if (!a.locked) return 'run';
  const route = lockedRoute(method, url.pathname);
  if (!route) return 'refuse';
  if (route.group === 'open') return 'run';
  if (route.group === 'state') return 'state';
  if (route.group === 'setup' && a.reason === 'no-name-email' && (!route.fromSetup || url.searchParams.get('from') === 'setup')) return 'run';
  return route.method === 'GET' ? 'empty' : 'refuse';
}
