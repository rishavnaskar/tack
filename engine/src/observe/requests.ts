/**
 * The page's own requests still on their way.
 *
 * A click on "Easy Apply" opens a dialog at once and fills it a second or
 * three later, from a request the click started; an application form arrives
 * after the shell that asks for it. The element count says nothing about a
 * request in flight, so a snapshot taken when the count went still showed an
 * empty dialog. What the page is still fetching does say it.
 *
 * Only what draws the page counts: documents, scripts and the page's own
 * fetches. Images, fonts and media load for long after there is something to
 * read. A request open for longer than LONG_POLL_MS is taken for a long poll
 * or a stream and no longer waited on.
 */
import type { CdpClient } from '../cdp/client.ts';
import type { DocumentStatus } from '../policy/pushback.ts';
import { registrableDomain, sitePace } from '../policy/site-pace.ts';

/** How the site answered the page's own document: its status says whether the site pushed back. */
export interface DocumentResponse extends DocumentStatus {
  at: number;
}

const COUNTED = new Set(['Document', 'Script', 'XHR', 'Fetch']);
const LONG_POLL_MS = 3_000;
/**
 * A site that has had enough answers 429 to everything the page asks for at
 * once, while the page itself stays up: LinkedIn refused 27 requests in one
 * second. This many from the page's own site inside the window is that; one
 * stray 429 from one endpoint is not.
 */
const REFUSED_ENOUGH = 3;
const REFUSED_WINDOW_MS = 10_000;

function hostOf(url: unknown): string {
  try { return new URL(String(url)).hostname; } catch { return ''; }
}

function retryAfterOf(headers: Array<[string, string]>): string | null {
  return headers.find(([name]) => name.toLowerCase() === 'retry-after')?.[1] ?? null;
}

export class Requests {
  readonly #open = new Map<string, number>();
  readonly #offs: Array<() => unknown> = [];
  #document: DocumentResponse | null = null;
  #refusedAt: number[] = [];
  #refusal: DocumentResponse | null = null;

  /** `frame` is the main frame's id, so a page's iframes do not speak for it. */
  constructor(client: CdpClient, session: () => string, frame: () => string | null = () => null) {
    this.#offs.push(client.on('Network.requestWillBeSent', (params, sessionId) => {
      if (sessionId !== session() || !COUNTED.has(String(params.type))) return;
      this.#open.set(String(params.requestId), Date.now());
      const host = hostOf((params.request as { url?: string } | undefined)?.url);
      if (host) sitePace.sent(host);
    }));
    const done = (params: Record<string, unknown>, sessionId?: string): void => {
      if (sessionId !== session()) return;
      this.#open.delete(String(params.requestId));
    };
    this.#offs.push(client.on('Network.loadingFinished', done), client.on('Network.loadingFailed', done));
    // A navigation's own request has the loader's id. Its response arrives
    // even when Chrome then shows its own error page for an empty 429.
    this.#offs.push(client.on('Network.responseReceived', (params, sessionId) => {
      if (sessionId !== session()) return;
      const response = params.response as { url?: string; status?: number; headers?: Record<string, string> } | undefined;
      const headers = Object.entries(response?.headers ?? {});
      if (params.type === 'XHR' || params.type === 'Fetch') {
        if (response?.status === 429) this.#refused(hostOf(response.url), headers);
        return;
      }
      if (params.type !== 'Document' || params.requestId !== params.loaderId) return;
      const main = frame();
      if (main && params.frameId !== main) return;
      this.#document = {
        url: String(response?.url ?? ''),
        status: Number(response?.status ?? 0),
        retryAfter: retryAfterOf(headers),
        at: Date.now(),
      };
    }));
  }

  /** Stop listening: the page these were for is closed. */
  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
    this.#open.clear();
  }

  /** One of the page's own requests answered 429 by the page's own site. */
  #refused(host: string, headers: Array<[string, string]>): void {
    const page = this.#document;
    if (!page || !host || registrableDomain(host) !== registrableDomain(hostOf(page.url))) return;
    const now = Date.now();
    this.#refusedAt = [...this.#refusedAt.filter((at) => now - at <= REFUSED_WINDOW_MS), now];
    if (this.#refusedAt.length < REFUSED_ENOUGH || (this.#refusal && now - this.#refusal.at <= REFUSED_WINDOW_MS)) return;
    this.#refusal = { url: page.url, status: 429, retryAfter: retryAfterOf(headers), at: now };
  }

  /**
   * How the site answered the page at or after `since`: the main document's
   * response, or, when that was fine, a 429 standing for a run of the page's
   * own requests the site refused.
   */
  document(since = 0): DocumentResponse | null {
    const document = this.#document && this.#document.at >= since ? this.#document : null;
    if (document && (document.status === 429 || document.status === 503)) return document;
    return this.#refusal && this.#refusal.at >= since ? this.#refusal : document;
  }

  /** Requests started at or after `since` that are drawing the page now. */
  pending(since = 0): number {
    const now = Date.now();
    let n = 0;
    for (const [id, at] of this.#open) {
      if (now - at > LONG_POLL_MS) this.#open.delete(id);
      else if (at >= since) n++;
    }
    return n;
  }

  /** A new document forgets the old one's requests. */
  reset(): void {
    this.#open.clear();
  }
}
