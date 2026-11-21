/**
 * Waiting for a page that draws itself after it loads.
 *
 * Application systems are single-page apps: the load event fires on an empty
 * shell, and the form arrives a second or three later, after the requests
 * that fetch it, often redrawn once more as the framework takes over the
 * server's markup. A snapshot taken at load shows nothing to fill, and refs
 * taken before that redraw point at elements about to be thrown away.
 *
 * So after a navigation the page is given until its elements have not changed
 * for a moment and nothing it asked for is still on its way, longer while it
 * has almost no text or says it is loading, and never more than a few
 * seconds. A page that is already drawn passes in about a third of a second.
 */

const POLL_MS = 100;
/** Unchanged polls in a row before a drawn page counts as still. */
const STILL_POLLS = 3;
/** The same for a page with almost no text yet, or one that says it is loading: an app shell still fetching its content. */
const STILL_POLLS_WHEN_BARE = 15;
const BARE_TEXT = 40;

// [elements, finished requests, text length, says it is loading]
const PROBE = `(() => {
  if (document.readyState === 'loading') return null;
  const text = document.body ? document.body.innerText.trim() : '';
  return [
    document.getElementsByTagName('*').length,
    performance.getEntriesByType('resource').length,
    text.length,
    /(^|\\n)\\s*loading\\s*(\\.{0,3}|\\u2026)\\s*(\\n|$)/i.test(text) || !!document.querySelector('[aria-busy="true"]'),
  ];
})()`;

interface AwaitContentOptions {
  maxMs?: number;
  /** True while the page still has requests on their way that draw it. */
  busy?: () => boolean;
}

export async function awaitContent(
  evaluate: (expression: string) => Promise<[number, number, number, boolean] | null>,
  opts: AwaitContentOptions = {},
): Promise<void> {
  const deadline = Date.now() + (opts.maxMs ?? 5_000);
  let last = '';
  let still = 0;
  while (Date.now() < deadline) {
    let now: [number, number, number, boolean] | null;
    try {
      now = await evaluate(PROBE);
    } catch {
      return; // a page that cannot be asked is not one to wait on
    }
    if (now !== null && !Array.isArray(now)) return;
    const key = now ? `${now[0]}:${now[1]}` : '';
    if (now && key === last && !opts.busy?.()) {
      still++;
      if (still >= (now[2] < BARE_TEXT || now[3] ? STILL_POLLS_WHEN_BARE : STILL_POLLS)) return;
    } else {
      still = 0;
    }
    last = key;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** What settling after an action reads off the page. */
interface SettlingPage {
  /** Requests started at or after `since` that are still on their way. */
  pending(since: number): number;
  /** A navigation is in flight, or has just been released and not started yet. */
  navigating(): boolean;
  evaluate(expression: string): Promise<unknown>;
}

/** The longest an action's page is waited on to settle. */
const SETTLE_MS = 2_000;
/** A request the action started (a dialog's content, the next step of a form) is waited for a little longer than the page is. */
const SETTLE_FETCH_MS = 4_000;

/**
 * Wait for the page to be worth observing again.
 *
 * We poll a cheap in-page readiness signal instead of sleeping a fixed
 * interval: most actions settle in a few milliseconds and should not pay a
 * 500ms tax, while a navigation needs longer than any constant we'd pick.
 */
export async function settleAfterAction(page: SettlingPage, since: number): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  const fetchDeadline = Date.now() + SETTLE_FETCH_MS;
  let stable = 0;
  let last = -1;
  for (;;) {
    const fetching = page.pending(since) > 0;
    if (Date.now() >= (fetching ? fetchDeadline : deadline)) return;
    if (fetching) {
      stable = 0;
      last = -1;
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    /*
     * Do not touch the page while it is navigating.
     *
     * Evaluating during the unload window is not harmless: with a
     * beforeunload guard on the page it triggers a SECOND beforeunload, and
     * answering that one derails the commit — the navigation starts and
     * never lands. Traced directly: left alone, one dialog fires and the
     * page navigates; polled, two fire and it does not.
     *
     * So while a navigation is in flight — or has just been released by an
     * accepted beforeunload and has not started yet — settling means
     * waiting, not asking.
     */
    if (page.navigating()) {
      stable = 0;
      last = -1;
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    let count: number;
    try {
      count = await page.evaluate('document.readyState === "complete" ? document.querySelectorAll("*").length : -1') as number;
    } catch {
      // Mid-navigation the execution context is destroyed; that is expected.
      count = -1;
    }
    if (count >= 0 && count === last) {
      if (++stable >= 2) return;
    } else {
      stable = 0;
    }
    last = count;
    await new Promise((r) => setTimeout(r, 40));
  }
}
