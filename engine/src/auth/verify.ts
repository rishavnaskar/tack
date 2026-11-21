/**
 * Checking a Firebase ID token, with node:crypto and nothing else.
 *
 * The rules are Firebase's own ("Verify ID tokens using a third-party JWT
 * library"): RS256, signed by one of Google's published keys named by `kid`,
 * for this project (`aud`, `iss`), not expired, not issued in the future,
 * and naming a user (`sub`). The keys are fetched once and kept for as long
 * as Google's answer says.
 */
import { X509Certificate, verify as verifySignature, type KeyObject } from 'node:crypto';

export const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** A clock a little ahead of Google's must not turn a fresh sign-in away. */
const LEEWAY_S = 60;
const FETCH_TIMEOUT_MS = 10_000;

/** What the person reads when a sign-in is not accepted. */
export const COPY = {
  invalid: 'Fanfold could not confirm this sign-in. Sign in again.',
  expired: 'This sign-in has expired. Sign in again.',
  unreachable: 'Fanfold could not reach Google to check this sign-in. Nothing was saved; try again in a minute.',
};

export type TokenProblem =
  | 'malformed' | 'algorithm' | 'expired' | 'future' | 'audience' | 'issuer' | 'subject' | 'unknown_key' | 'signature' | 'unreachable';

export class TokenError extends Error {
  readonly problem: TokenProblem;
  constructor(problem: TokenProblem) {
    super(problem === 'expired' ? COPY.expired : problem === 'unreachable' ? COPY.unreachable : COPY.invalid);
    this.name = 'TokenError';
    this.problem = problem;
  }
}

/** Who signed in, as the token says. */
export interface VerifiedToken {
  uid: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  photo: string | null;
  /** Firebase's `sign_in_provider`: `google.com`, `phone`, `password`. */
  provider: string;
  authTime: number;
}

interface Certs { keys: Map<string, KeyObject>; until: number }

export class TokenVerifier {
  readonly #projectId: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #certs: Certs | null = null;
  #loading: Promise<Certs> | null = null;

  constructor(opts: { projectId: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.#projectId = opts.projectId;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  async verify(token: string): Promise<VerifiedToken> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p))) throw new TokenError('malformed');
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (header.alg !== 'RS256') throw new TokenError('algorithm');
    if (typeof header.kid !== 'string' || !header.kid) throw new TokenError('unknown_key');

    const now = this.#now() / 1000;
    if (!isTime(claims.exp) || claims.exp <= now) throw new TokenError('expired');
    for (const at of [claims.iat, claims.auth_time]) {
      if (!isTime(at)) throw new TokenError('malformed');
      if (at > now + LEEWAY_S) throw new TokenError('future');
    }
    if (claims.aud !== this.#projectId) throw new TokenError('audience');
    if (claims.iss !== `https://securetoken.google.com/${this.#projectId}`) throw new TokenError('issuer');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new TokenError('subject');

    const key = await this.#key(header.kid);
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verifySignature('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) throw new TokenError('signature');

    const firebase = (claims.firebase ?? {}) as Record<string, unknown>;
    const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const picture = text(claims.picture, 2_000);
    return {
      uid: claims.sub,
      name: text(claims.name, 200),
      email: text(claims.email, 320),
      emailVerified: claims.email_verified === true,
      phone: text(claims.phone_number, 40),
      // Only a picture served over https is kept: the page shows it as an image.
      photo: picture && /^https:\/\//i.test(picture) ? picture : null,
      provider: text(firebase.sign_in_provider, 40) ?? 'unknown',
      authTime: claims.auth_time as number,
    };
  }

  /** The key a token names. An unknown one sends for Google's list again, once: the keys rotate. */
  async #key(kid: string): Promise<KeyObject> {
    const fresh = !this.#certs || this.#certs.until <= this.#now();
    let certs = fresh ? await this.#load() : this.#certs!;
    if (!certs.keys.has(kid) && !fresh) certs = await this.#load();
    const key = certs.keys.get(kid);
    if (!key) throw new TokenError('unknown_key');
    return key;
  }

  #load(): Promise<Certs> {
    this.#loading ??= this.#fetchCerts().finally(() => { this.#loading = null; });
    return this.#loading;
  }

  async #fetchCerts(): Promise<Certs> {
    let res: Response;
    let body: unknown;
    try {
      res = await this.#fetch(CERTS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch {
      throw new TokenError('unreachable');
    }
    const keys = new Map<string, KeyObject>();
    for (const [kid, pem] of Object.entries((body ?? {}) as Record<string, unknown>)) {
      if (typeof pem !== 'string') continue;
      try {
        keys.set(kid, new X509Certificate(pem).publicKey);
      } catch { /* one unreadable certificate does not spoil the rest */ }
    }
    const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 0);
    this.#certs = { keys, until: this.#now() + maxAge * 1000 };
    return this.#certs;
  }
}

function decode(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* falls through */ }
  throw new TokenError('malformed');
}

function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
