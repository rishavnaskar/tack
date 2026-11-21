/**
 * How a failure inside the page controller is named.
 */

import { isTransportLoss } from '../cdp/loss.ts';
import type { ActionFailure } from '../types.ts';

export class ActionFailureError extends Error {
  readonly failure: ActionFailure;
  constructor(failure: ActionFailure, detail: string) {
    super(detail);
    this.name = 'ActionFailureError';
    this.failure = failure;
  }
}

/**
 * The session is gone, but the transport is not.
 *
 * Kept apart from transport loss on purpose: reconnecting the whole browser
 * would throw away every other tab for a problem confined to one.
 */
export function isSessionGone(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return /Session with given id not found|No session with given id/i.test(msg);
}

export function classify(err: unknown): ActionFailure {
  if (err instanceof ActionFailureError) return err.failure;
  const msg = (err as Error)?.message ?? '';
  // Checked first: as CDP_ERROR a closed transport would be indistinguishable
  // from a protocol refusal, and nothing downstream could reconnect on it or
  // report it honestly.
  if (isTransportLoss(msg)) return 'TRANSPORT_LOST';
  if (/timeout/i.test(msg)) return 'TIMEOUT';
  if (/context was destroyed|execution context/i.test(msg)) return 'NAVIGATION_LOST';
  return 'CDP_ERROR';
}
