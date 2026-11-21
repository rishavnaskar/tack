/**
 * Recognising that the browser, not the page, is what went wrong.
 *
 * One predicate, shared by everything that has to tell the difference. Two
 * lists would let the layers disagree: if the page took a closed transport
 * for an ordinary CDP error while the resilient wrapper looked for browser
 * loss, a browser that died during an action would never be reconnected, and
 * every action after it would fail for a reason nothing was watching for.
 *
 * Kept deliberately narrow. A timeout, a destroyed execution context and a
 * protocol error are ordinary automation failures that say something about
 * the page or this code; calling them browser loss would wave real defects
 * away as bad luck with the environment.
 */

const TRANSPORT_LOST =
  /CDP client closed|CDP connection closed|transport closed|browser is gone|Chrome exited|socket hang up|WebSocket is not open|ECONNRESET/i;

export function isTransportLoss(err: unknown): boolean {
  const message = typeof err === 'string' ? err : (err as Error)?.message ?? '';
  return TRANSPORT_LOST.test(message);
}

/** The browser did not answer a command in time: the page, or the whole browser, has stopped answering. */
export function isNoAnswer(err: unknown): boolean {
  const message = typeof err === 'string' ? err : (err as Error)?.message ?? '';
  return /CDP timeout|timed out waiting for/i.test(message);
}
