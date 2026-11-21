/**
 * Signing in to Fanfold. Firebase only answers "who is this": everything the
 * person keeps stays on this computer, and Fanfold remembers who signed in
 * without the network.
 *
 * Off unless an entry point turns it on, so a test, or anything else that
 * builds a server without saying, behaves as it always did.
 */

/** The Firebase project. Public identifiers that any page using it carries, not secrets. */
export const FIREBASE = Object.freeze({
  projectId: 'fanfold-app',
  appId: '1:85784968938:web:0d02b41c7a533e13342193',
  apiKey: '',
  authDomain: 'fanfold-app.firebaseapp.com',
  messagingSenderId: '85784968938',
});

export type FirebaseConfig = typeof FIREBASE;

export interface AuthOptions {
  enabled: boolean;
  /** What fetches Google's public certificates. The real fetch by default; tests never reach Google. */
  fetchImpl?: typeof fetch;
  /** Whose tokens are accepted, and the config the page signs in with. FIREBASE by default. */
  firebase?: FirebaseConfig;
  /** The clock tokens are checked against, in ms. */
  now?: () => number;
}

/** What the entry points turn on: sign-in, unless FANFOLD_AUTH=off. */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthOptions {
  return { enabled: enabled(env) };
}

export function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FANFOLD_AUTH ?? '').trim().toLowerCase() !== 'off';
}
