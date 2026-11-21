/**
 * Deciding that the two ends of the socket are the user's Fanfold and the
 * user's own copy of the extension.
 *
 * The listener is on loopback, which every local process can reach, and the
 * Origin header only proves a browser sent it. So the extension has to show
 * something only the user could have given it: first a short code they read
 * off Fanfold and typed into the extension, afterwards the long token that
 * code was exchanged for. Only a SHA-256 of the token is kept here, so a copy
 * of the database cannot be replayed to Fanfold as the extension.
 *
 * It runs both ways, because the dangerous direction is the other one: the
 * extension obeys whatever answers on the port, and a port on loopback can be
 * taken by another local process before Fanfold starts. So Fanfold proves
 * itself FIRST, with an HMAC over the extension's nonce, and the extension
 * reveals nothing and accepts no command until that checks out. The proof
 * also covers the port number. A process that took the well-known port and
 * relays to the real Fanfold on the next one forwards a proof made for the
 * wrong port, and it cannot be listening on the right one while Fanfold is.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { RawMessage } from '../cdp/transport.ts';
import type { KeyValueStore } from './store.ts';

const KEY_TOKEN_HASH = 'extension.token_sha256';
const KEY_ORIGIN = 'extension.origin';
const KEY_PAIRED_AT = 'extension.paired_at';

/** No I, L, O, 0 or 1: the code is read off one screen and typed into another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
export const CODE_TTL_MS = 5 * 60_000;
/** Handshakes a single code survives without one succeeding. */
export const CODE_MAX_ATTEMPTS = 5;
/** Failed sign-ins of any kind tolerated per window before all are refused. */
export const FAILURE_LIMIT = 10;
export const FAILURE_WINDOW_MS = 60_000;
/**
 * The code is forty bits, and a proof made from it is something to test
 * guesses against offline. Stretching makes each guess cost this many hashes,
 * which puts the search far outside the five minutes a code lives.
 */
export const PAIR_ITERATIONS = 200_000;

export type RefusalReason =
  | 'bad-code' | 'code-expired' | 'not-pairing'
  | 'bad-token' | 'not-paired' | 'origin-mismatch'
  | 'rate-limited' | 'protocol';

export type AuthOutcome =
  | { ok: true; token?: string }
  | { ok: false; reason: RefusalReason; message: string };

/** What Fanfold sends back to a hello, and how the reply to it is judged. */
export type Challenge =
  | { ok: true; message: RawMessage; answer(auth: RawMessage, origin: string): AuthOutcome }
  | { ok: false; reason: RefusalReason; message: string };

const MESSAGES: Record<RefusalReason, string> = {
  'bad-code': 'That pairing code is not right.',
  'code-expired': 'That pairing code has expired. Ask Fanfold for a new one.',
  'not-pairing': 'Fanfold is not waiting for a pairing code. Start pairing in Fanfold first.',
  'bad-token': 'Fanfold no longer recognises this extension. Pair it again.',
  'not-paired': 'Fanfold is not paired with any extension. Pair it from Fanfold.',
  'origin-mismatch': 'This is not the extension Fanfold was paired with. Pair it again.',
  'rate-limited': 'Too many failed attempts. Wait a minute and try again.',
  protocol: 'This extension and this Fanfold speak different versions. Update both.',
};

export function refusal(reason: RefusalReason): { ok: false; reason: RefusalReason; message: string } {
  return { ok: false, reason, message: MESSAGES[reason] };
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The key both ends derive from a pairing code. Exported for a test's stand-in extension. */
export function pairingKey(code: string, nonce: string, salt: string): Buffer {
  return pbkdf2Sync(normalizeCode(code), `${nonce}|${salt}`, PAIR_ITERATIONS, 32, 'sha256');
}

/** The key both ends derive from the token: its SHA-256, which is all Fanfold keeps. */
export function tokenKey(token: string): Buffer {
  return sha256(token);
}

export function proofOf(key: Buffer, side: 'bridge' | 'extension', port: number, nonce: string, salt: string): string {
  return createHmac('sha256', key).update(`fanfold-${side}|${port}|${nonce}|${salt}`).digest('base64url');
}

function sameProof(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Pairing {
  #store: KeyValueStore;
  #now: () => number;
  #pending: { code: string; expiresAt: number; attempts: number } | null = null;
  #failures: number[] = [];

  constructor(store: KeyValueStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  get paired(): boolean {
    return this.#store.get(KEY_TOKEN_HASH) !== null;
  }

  /** When the code on offer stops working, or null when none is. */
  get pendingExpiresAt(): string | null {
    if (!this.#pending || this.#pending.expiresAt <= this.#now()) return null;
    return new Date(this.#pending.expiresAt).toISOString();
  }

  /** A fresh code. Any earlier one stops working: only the newest was shown to the user. */
  begin(): { code: string; expiresAt: string } {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = this.#now() + CODE_TTL_MS;
    this.#pending = { code, expiresAt, attempts: 0 };
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  cancel(): void {
    this.#pending = null;
  }

  unpair(): void {
    this.#pending = null;
    for (const key of [KEY_TOKEN_HASH, KEY_ORIGIN, KEY_PAIRED_AT]) this.#store.delete(key);
  }

  /** Answer a hello: prove who Fanfold is, and say how the extension must prove itself. */
  challenge(hello: RawMessage, port: number): Challenge {
    const nonce = hello.nonce;
    if (typeof nonce !== 'string' || !/^[\w-]{16,128}$/.test(nonce)) return refusal('protocol');
    if (this.#lockedOut()) return refusal('rate-limited');
    const salt = randomBytes(16).toString('base64url');
    const key = hello.mode === 'pair' ? this.#codeKey(nonce, salt) : this.#storedKey();
    if (!Buffer.isBuffer(key)) return key;
    const message = { bridge: 'challenge', salt, proof: proofOf(key, 'bridge', port, nonce, salt) };
    return hello.mode === 'pair'
      ? { ok: true, message, answer: (auth, origin) => this.#redeem(auth, origin, proofOf(key, 'extension', port, nonce, salt)) }
      : { ok: true, message, answer: (auth, origin) => this.#verify(auth, origin) };
  }

  #storedKey(): Buffer | Challenge {
    const stored = this.#store.get(KEY_TOKEN_HASH);
    return stored ? Buffer.from(stored, 'hex') : this.#failed('not-paired');
  }

  #codeKey(nonce: string, salt: string): Buffer | Challenge {
    const pending = this.#pending;
    if (!pending) return this.#failed('not-pairing');
    if (pending.expiresAt <= this.#now()) {
      this.#pending = null;
      return this.#failed('code-expired');
    }
    // Counted when the proof is handed out, not when the reply is wrong: an
    // extension that was given the wrong code hangs up without replying, and
    // so does anything collecting proofs to guess against.
    if (++pending.attempts > CODE_MAX_ATTEMPTS) {
      this.#pending = null;
      return this.#failed('not-pairing');
    }
    return pairingKey(pending.code, nonce, salt);
  }

  #redeem(auth: RawMessage, origin: string, expected: string): AuthOutcome {
    const pending = this.#pending;
    if (!pending || pending.expiresAt <= this.#now()) return this.#failed('code-expired');
    if (!sameProof(auth.proof, expected)) return this.#failed('bad-code');
    this.#pending = null;
    const token = randomBytes(32).toString('base64url');
    this.#store.set(KEY_TOKEN_HASH, tokenKey(token).toString('hex'));
    this.#store.set(KEY_ORIGIN, origin);
    this.#store.set(KEY_PAIRED_AT, new Date(this.#now()).toISOString());
    return { ok: true, token };
  }

  #verify(auth: RawMessage, origin: string): AuthOutcome {
    const stored = this.#store.get(KEY_TOKEN_HASH);
    if (!stored) return this.#failed('not-paired');
    const presented = tokenKey(String(auth.token ?? ''));
    const expected = Buffer.from(stored, 'hex');
    if (expected.length !== presented.length || !timingSafeEqual(presented, expected)) {
      return this.#failed('bad-token');
    }
    // The token is bound to the extension it was issued to. An unpacked
    // extension that is moved gets a new id and loses its storage with it,
    // so this never refuses the legitimate one.
    if (this.#store.get(KEY_ORIGIN) !== origin) return this.#failed('origin-mismatch');
    return { ok: true };
  }

  #lockedOut(): boolean {
    const cutoff = this.#now() - FAILURE_WINDOW_MS;
    this.#failures = this.#failures.filter((at) => at > cutoff);
    return this.#failures.length >= FAILURE_LIMIT;
  }

  #failed(reason: RefusalReason): { ok: false; reason: RefusalReason; message: string } {
    this.#failures.push(this.#now());
    return refusal(reason);
  }
}
