/**
 * Who is signed in to Fanfold on this computer. One computer holds one set of
 * data, and whoever signs in uses it.
 *
 * Only who they are is kept, in settings: never a token. Signing out forgets
 * nothing but the fact of being signed in.
 */
import type { Profile, ProfileFields } from '../jobs/profile.ts';
import type { VerifiedToken } from './verify.ts';

export const ACCOUNT_SETTING = 'auth.account';
export const SIGNED_IN_SETTING = 'auth.signedIn';

export interface Account {
  uid: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  photo: string | null;
  /** Firebase's sign-in provider: `google.com`, `phone` or `password`. */
  provider: string;
  signedInAt: string;
}

export interface Settings {
  setting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
}

export function accountOf(store: Settings): Account | null {
  const a = store.setting<Account | null>(ACCOUNT_SETTING, null);
  return a && typeof a === 'object' && typeof a.uid === 'string' ? a : null;
}

export function isSignedIn(store: Settings): boolean {
  return store.setting<boolean>(SIGNED_IN_SETTING, false) === true && accountOf(store) !== null;
}

/**
 * Remember who signed in. The first time this account signs in here, what it
 * says about the person fills the profile where the profile has nothing usable:
 * the name, the email once Google has verified it, the phone number they
 * signed in with. What was filled is returned.
 */
export function signIn(deps: { store: Settings; profile: Pick<Profile, 'fact' | 'set'> }, token: VerifiedToken, at = new Date()): ProfileFields {
  const before = accountOf(deps.store);
  const account: Account = {
    uid: token.uid, name: token.name, email: token.email, phone: token.phone, photo: token.photo,
    provider: token.provider, signedInAt: at.toISOString(),
  };
  deps.store.setSetting(ACCOUNT_SETTING, account);
  deps.store.setSetting(SIGNED_IN_SETTING, true);
  if (before?.uid === token.uid) return {};

  const offered: ProfileFields = {
    ...(token.name ? { name: token.name } : {}),
    ...(token.email && token.emailVerified ? { email: token.email } : {}),
    ...(token.phone && token.provider === 'phone' ? { phone: token.phone } : {}),
  };
  const fill: ProfileFields = {};
  for (const [field, value] of Object.entries(offered) as Array<[keyof ProfileFields, string]>) {
    if (!deps.profile.fact(field)?.usable) fill[field] = value;
  }
  if (Object.keys(fill).length) deps.profile.set(fill, { confirmed: true });
  return fill;
}

export function signOut(store: Settings): void {
  store.setSetting(SIGNED_IN_SETTING, false);
}
