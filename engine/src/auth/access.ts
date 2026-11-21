/**
 * Whether Fanfold is open to use, or open only to look around.
 *
 * Open once the person is signed in (always, with sign-in off) and has given
 * their name and email themselves: typed, or said in an answer. A name read
 * from a document they uploaded does not count until they save it. Until then every page shows, nothing of theirs is
 * shown, and nothing that starts work or changes data runs. One rule, read by
 * the HTTP routes, the MCP tools and the scheduler alike.
 */
import type { Profile } from '../jobs/profile.ts';
import { isSignedIn, type Settings } from './account.ts';

export type LockReason = 'signed-out' | 'no-name-email';

export interface Access {
  locked: boolean;
  reason: LockReason | null;
}

export const OPEN: Access = Object.freeze({ locked: false, reason: null });

/** Every refusal while locked has this status and this machine code. */
export const LOCKED_STATUS = 403;
export const LOCKED_CODE = 'locked';

/** What the person reads: one sentence for each reason. */
export const COPY: Record<LockReason, string> = {
  'signed-out': 'Sign in to use Fanfold. Until then you can look around, and nothing of yours is shown.',
  'no-name-email': 'Add your name and email to start using Fanfold. Until then you can look around.',
};

export interface Lockable {
  store: Settings;
  profile: Pick<Profile, 'fact'>;
  /** Sign-in is on in this Fanfold. */
  signInRequired: boolean;
  /** Tests only: never locked. */
  unlocked: boolean;
}

/** The person gave both themselves; what setup calls signed up. */
export function gaveNameAndEmail(profile: Pick<Profile, 'fact'>): boolean {
  return !!profile.fact('name')?.confirmed && !!profile.fact('email')?.confirmed;
}

export function access(app: Lockable): Access {
  if (app.unlocked) return OPEN;
  if (app.signInRequired && !isSignedIn(app.store)) return { locked: true, reason: 'signed-out' };
  if (!gaveNameAndEmail(app.profile)) return { locked: true, reason: 'no-name-email' };
  return OPEN;
}

export function sameAccess(a: Access, b: Access): boolean {
  return a.locked === b.locked && a.reason === b.reason;
}

/** The answer to anything that may not run while locked. */
export function refusal(a: Access): { error: string; code: typeof LOCKED_CODE; reason: LockReason } {
  const reason = a.reason ?? 'signed-out';
  return { error: COPY[reason], code: LOCKED_CODE, reason };
}

/** What the page and a host read about it: whether it is locked, why, and the sentence that says so. */
export function accessView(a: Access): { locked: boolean; reason: LockReason | null; sentence: string | null } {
  return { locked: a.locked, reason: a.reason, sentence: a.reason ? COPY[a.reason] : null };
}
