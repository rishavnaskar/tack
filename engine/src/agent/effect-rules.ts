/** Which actions can have an effect, and which failures prove they did not. */
import type { Sensitivity } from '../types.ts';

/** Actions that can cause an effect outside this machine. */
export const ACTUATING = new Set(['click', 'press', 'check', 'uncheck', 'select']);

/**
 * Failures decided BEFORE any input reached the page.
 *
 * The lease was stale, the ref was unknown, the element had changed identity
 * or could not be acted on — all determined by resolving the target, before
 * anything is dispatched. These provably had no effect.
 *
 * Every other failure is potentially-dispatched. TIMEOUT, NAVIGATION_LOST, TAB_LOST,
 * CDP_ERROR and TRANSPORT_LOST are deliberately absent: by the time any of
 * them is reported, the click may already have landed.
 */
export const NO_EFFECT_FAILURES = new Set(['STALE_STATE', 'UNKNOWN_REF', 'TARGET_DRIFT', 'NOT_ACTIONABLE']);

/** Sensitivities where an uncertain outcome may have reached beyond this page. */
export const REACHES_OUTSIDE = new Set<Sensitivity>(['CONTACT_EXTERNAL', 'IRREVERSIBLE', 'AMBIGUOUS_WRITE']);

/** Sensitivities worth paying a fresh observation to re-check. */
export const NEEDS_REASSERT = new Set<Sensitivity>(['CONTACT_EXTERNAL', 'IRREVERSIBLE']);
