/**
 * Only ordinary web navigation, plus about:blank.
 *
 * `file:` would turn a navigation into a local file read and `javascript:`
 * into script execution in whatever page is loaded. Neither is something a
 * navigation should be able to reach — and it matters most where the address
 * came off a page rather than from the user, as a fan-out's do.
 */
import type { BrowserRuntime } from '../observe/runtime.ts';

const NAVIGABLE_SCHEMES = new Set(['http:', 'https:', 'about:']);

export function assertNavigable(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (!NAVIGABLE_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `refusing to navigate to a ${parsed.protocol} URL. Only http, https and about: are permitted.`,
    );
  }
  if (parsed.protocol === 'about:' && parsed.pathname !== 'blank') {
    throw new Error('the only about: URL permitted is about:blank');
  }
  if (isFanfoldPage(url)) throw new Error('that is Fanfold\'s own window, which only the person uses');
}

/**
 * Fanfold's own window is the person's: its address carries their key, and
 * its buttons approve what agents asked for. No agent opens it, switches to
 * it, reads it or acts in it, whichever browser it happens to be open in.
 */
const OWN_ORIGINS = new Set<string>();
/** Bumped whenever the set changes, so a page knows to block again. */
let ownVersion = 0;

/** Told whenever the set changes: the extension in the user's Chrome keeps out of these pages too. */
const ownListeners = new Set<() => void>();

export function markOwnOrigin(port: number): void {
  OWN_ORIGINS.add(`http://127.0.0.1:${port}`);
  OWN_ORIGINS.add(`http://localhost:${port}`);
  OWN_ORIGINS.add(`http://[::1]:${port}`);
  ownVersion++;
  ownChanged();
}

export function unmarkOwnOrigin(port: number): void {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) OWN_ORIGINS.delete(`http://${host}:${port}`);
  ownVersion++;
  ownChanged();
}

/** Every origin of Fanfold's own, such as "http://127.0.0.1:4318". */
export function ownOrigins(): string[] {
  return [...OWN_ORIGINS];
}

export function onOwnOriginsChange(fn: () => void): () => void {
  ownListeners.add(fn);
  return () => { ownListeners.delete(fn); };
}

function ownChanged(): void {
  for (const fn of [...ownListeners]) {
    try { fn(); } catch { /* a listener's failure is its own */ }
  }
}

/**
 * Every address of Fanfold's own, as patterns a page that agents drive is
 * kept from loading anything at.
 */
export function ownOriginBlock(): { version: number; urls: string[] } {
  return { version: ownVersion, urls: [...OWN_ORIGINS].map((origin) => `${origin}/*`) };
}

export function isFanfoldPage(url: string | undefined): boolean {
  if (!url || OWN_ORIGINS.size === 0) return false;
  try {
    return OWN_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * Fanfold's window, this one's or another Fanfold's on this machine (one
 * started on another port or with another state): an address on this machine
 * that answers with Fanfold's own page. Only this Fanfold's ports are known
 * in advance; another's is known by the page it serves.
 */
export function fanfoldWindow(observation: { url: string; title?: unknown } | null | undefined): boolean {
  if (!observation) return false;
  if (isFanfoldPage(observation.url)) return true;
  let host = '';
  try { host = new URL(observation.url).hostname; } catch { return false; }
  const local = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  return local && String(observation.title ?? '').trim() === 'Fanfold';
}

/**
 * A page that went to Fanfold's own window by itself, through a redirect or a
 * refresh, is taken off it before anything of it is shown, and the caller is
 * told why.
 */
export async function leaveOwnWindow(page: { goto(url: string): Promise<void> }): Promise<never> {
  await page.goto('about:blank').catch(() => {});
  throw new Error('the page went to Fanfold\'s own window, which only the person uses, so Fanfold left it. Open another address.');
}

/** The same address with its key blanked, for anywhere it might be shown. */
export function withoutKey(url: string): string {
  return isFanfoldPage(url) ? url.replace(/([?&](?:t|token)=)[^&#]*/g, '$1…') : url;
}

/** The page as the agent sees it, which never shows Fanfold's own window, wherever a redirect took it. */
export function shielded(page: BrowserRuntime): BrowserRuntime {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === 'observe') {
        return async (...args: Parameters<BrowserRuntime['observe']>) => {
          const seen = await target.observe(...args);
          if (fanfoldWindow(seen)) await leaveOwnWindow(target);
          return seen;
        };
      }
      if (prop === 'openTab' && target.openTab) {
        return async (...args: Parameters<NonNullable<BrowserRuntime['openTab']>>) => {
          const tab = await target.openTab!(...args);
          return { page: shielded(tab.page), close: () => tab.close() };
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
