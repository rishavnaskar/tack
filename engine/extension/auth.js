/**
 * The extension's half of the handshake in Fanfold's pairing.ts.
 *
 * Fanfold proves itself first. Whatever answers on the port is asked for an
 * HMAC over a fresh nonce and the port number, keyed by something only the
 * user's Fanfold has: the pairing code just typed, or the hash of the token
 * issued earlier. Until that proof checks out the extension sends no secret
 * and takes no command, because a loopback port can be taken by any local
 * process and this extension does what the other end of the socket says.
 */

/** Must match PAIR_ITERATIONS in pairing.ts; fixed here so a peer cannot ask for fewer. */
const PAIR_ITERATIONS = 200_000;

const utf8 = new TextEncoder();

function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function newNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(18)));
}

/** "ABCD-EFGH" or "ABCD-EFGH@51234": the code, and the port when Fanfold is on an unusual one. */
export function parsePairingCode(text) {
  const [code, port] = String(text ?? '').trim().split('@');
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const number = port === undefined ? null : Number(port);
  if (normalized.length !== 8) return null;
  if (number !== null && !(Number.isInteger(number) && number > 0 && number < 65536)) return null;
  return { code: normalized, port: number };
}

function hmacKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function keyFromToken(token) {
  return hmacKey(await crypto.subtle.digest('SHA-256', utf8.encode(token)));
}

export async function keyFromCode(code, nonce, salt) {
  const base = await crypto.subtle.importKey('raw', utf8.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8.encode(`${nonce}|${salt}`), iterations: PAIR_ITERATIONS },
    base,
    256,
  );
  return hmacKey(bits);
}

export async function proofOf(key, side, port, nonce, salt) {
  return base64url(await crypto.subtle.sign('HMAC', key, utf8.encode(`fanfold-${side}|${port}|${nonce}|${salt}`)));
}

/** Compared without stopping at the first difference. */
export function sameProof(presented, expected) {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
