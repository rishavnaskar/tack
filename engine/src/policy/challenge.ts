/**
 * Recognising a bot check, so that it is handed to the person.
 *
 * A CAPTCHA or an "are you human" page is a site asking for a human. Fanfold
 * does not answer for one: it does not solve, click through or route around
 * these. What it does is notice, stop, and say so, and treat the site as
 * prepare-only for a while.
 */
import { unwrapUntrustedForDisplay } from './untrusted.ts';
import { ancestors } from './structure.ts';
import { DEFAULT_PUSHBACK_MS } from './pushback.ts';
import type { Observation, ObservedNode } from '../types.ts';

export interface Challenge {
  /** A whole page that stands in the way, or a check embedded in a page that is otherwise usable. */
  kind: 'interstitial' | 'embedded';
  /**
   * What the site wants: proof of a person (a bot check), a sign-in, a
   * pause because its daily limit is reached, or a pause because it is
   * rate-limiting this browser. Each is the person's to handle.
   */
  reason?: 'check' | 'signin' | 'limit' | 'rate';
  /** The words that gave it away, for the message to the user. */
  evidence: string;
}

const TITLE = /^(just a moment|attention required|security check|verify you are human|are you a robot|access denied|human verification|one more step)\b/i;

const CONTROL = /\b(i['’]?m not a robot|verify (that )?you(['’]re| are) (a )?human|press (and|&) hold|complete the (security|captcha) check|solve (the|this) (puzzle|captcha)|select all (images|squares) (with|containing)|unusual traffic from your (computer|network)|checking (if the site connection is secure|your browser))\b/i;

/**
 * A check served in a frame from another site, which the page cannot see
 * into. DataDome's frame is only ever a block; the others also sit invisibly
 * on ordinary forms, so they count only on a page with almost nothing else.
 */
const CHECK_FRAME = /\b(captcha-delivery\.com|datadome|challenges\.cloudflare\.com|hcaptcha\.com|recaptcha|arkoselabs\.com|funcaptcha)\b/i;
const BLOCK_FRAME = /\b(captcha-delivery\.com|datadome)\b/i;

/** A page with this few controls and a challenge on it is nothing but the challenge. */
const INTERSTITIAL_CONTROLS = 6;

const words = (node: ObservedNode): string =>
  [node.name, node.text].filter(Boolean).map((t) => unwrapUntrustedForDisplay(t!)).join(' ');

/** True for the control or text of a bot check. Nothing acts on one of these. */
export function isChallengeControl(node: ObservedNode): boolean {
  return CONTROL.test(words(node));
}

/**
 * A frame of one of the checks that sit on ordinary forms, and what it shows
 * a person: nothing (it scores the visit by itself), a box to tick, or a
 * picture puzzle. Told from the frame's own address: reCAPTCHA draws its
 * checkbox at size=normal or compact and its puzzle in a frame that is only
 * drawn while it shows; hCaptcha names the frame in its address. Turnstile
 * on a form runs by itself.
 */
export interface CheckFrame {
  vendor: 'reCAPTCHA' | 'hCaptcha' | 'Cloudflare Turnstile';
  shows: 'nothing' | 'checkbox' | 'puzzle';
}

export function checkFrame(node: ObservedNode): CheckFrame | null {
  const address = node.role === 'frame' && node.text ? /https?:\/\/[^\s"]+/i.exec(unwrapUntrustedForDisplay(node.text))?.[0] : undefined;
  if (!address) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (/(^|\.)(google\.com|recaptcha\.net)$/.test(host) && url.pathname.includes('/recaptcha/')) {
    if (/\/bframe\b/.test(url.pathname)) return { vendor: 'reCAPTCHA', shows: 'puzzle' };
    return { vendor: 'reCAPTCHA', shows: /^(normal|compact)$/i.test(url.searchParams.get('size') ?? '') ? 'checkbox' : 'nothing' };
  }
  if (/(^|\.)hcaptcha\.com$/.test(host)) {
    const frame = new URLSearchParams(url.hash.slice(1)).get('frame') ?? '';
    return { vendor: 'hCaptcha', shows: frame === 'challenge' ? 'puzzle' : frame === 'checkbox' ? 'checkbox' : 'nothing' };
  }
  if (host === 'challenges.cloudflare.com') return { vendor: 'Cloudflare Turnstile', shows: 'nothing' };
  return null;
}

/** Pages a site shows instead of itself: its security check, or its sign-in wall. */
const CHECK_URL = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/checkpoint\//i;
const SIGNIN_URL = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/(login|uas\/login|authwall)\b/i;
const CHECK_TEXT = /\b(quick security check|make sure it['’]s really you|security verification)\b/i;
const SIGNIN_TEXT = /\b(your session has expired|sign in to continue|please sign in again|sign in to (?:view|see) (?:more )?(?:jobs|results))\b/i;
/** Chrome's own page for an empty 429, and the stock server page. Where the response itself was seen, site-guard.ts reads its status. */
const RATE_TEXT = /\b(http error 429|429 too many requests)\b/i;
const LIMIT_TEXT = /\b(you['’]ve reached (the|your) (daily )?(easy apply |application )?limit|(easy apply|application) limit (for today|reached)|limit daily submissions|try applying again tomorrow|apply again tomorrow)\b/i;

/** Where a site speaks for itself, rather than a posting's prose: a message box or a dialog. */
const OWN_VOICE = new Set(['alert', 'alertdialog', 'dialog', 'status']);
const LINKEDIN_URL = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\//i;

export function detectChallenge(observation: Observation | null): Challenge | null {
  if (!observation) return null;
  const title = unwrapUntrustedForDisplay(observation.title);
  const controls = observation.nodes.filter((n) => n.ref).length;
  // These words count where the site is speaking: on LinkedIn, whose own
  // phrases they are, on a page with almost nothing else on it, or in a
  // message box. A posting that says "security verification" or
  // "sign in to continue" in its description is still a posting.
  const anywhere = LINKEDIN_URL.test(observation.url) || controls <= INTERSTITIAL_CONTROLS;
  const said = (re: RegExp): ObservedNode | undefined => observation.nodes.find((n) => re.test(words(n))
    && (anywhere || OWN_VOICE.has(n.role) || ancestors(observation, n).some((a) => OWN_VOICE.has(a.role))));

  if (CHECK_URL.test(observation.url)) return { kind: 'interstitial', reason: 'check', evidence: `the security check at ${new URL(observation.url).pathname}` };
  const limit = said(LIMIT_TEXT);
  if (limit) return { kind: 'interstitial', reason: 'limit', evidence: words(limit).slice(0, 120) };
  const rate = said(RATE_TEXT);
  if (rate || (controls <= INTERSTITIAL_CONTROLS && RATE_TEXT.test(title))) {
    return { kind: 'interstitial', reason: 'rate', evidence: (rate ? words(rate) : title).slice(0, 120) };
  }
  if (SIGNIN_URL.test(observation.url)) return { kind: 'interstitial', reason: 'signin', evidence: `the sign-in page at ${new URL(observation.url).pathname}` };
  const expired = said(SIGNIN_TEXT);
  if (expired) return { kind: 'interstitial', reason: 'signin', evidence: words(expired).slice(0, 120) };
  const check = said(CHECK_TEXT);
  if (check || (anywhere && CHECK_TEXT.test(title))) return { kind: 'interstitial', reason: 'check', evidence: (check ? words(check) : title).slice(0, 120) };

  const frame = observation.nodes.find((n) => n.role === 'frame' && CHECK_FRAME.test(words(n)));
  if (frame && (BLOCK_FRAME.test(words(frame)) || controls <= INTERSTITIAL_CONTROLS)) {
    return { kind: 'interstitial', reason: 'check', evidence: words(frame).slice(0, 120) };
  }
  const node = observation.nodes.find(isChallengeControl);
  const others = observation.nodes.filter((n) => n.ref && !isChallengeControl(n)).length;
  // A title alone ("Just a moment…", "Access denied") is a check only on a page with little else on it.
  if (!node && !(TITLE.test(title) && others <= INTERSTITIAL_CONTROLS)) {
    // A box to tick or a puzzle drawn on a form is the person's, however much else the page holds.
    const asking = observation.nodes.map(checkFrame).find((f) => f && f.shows !== 'nothing');
    return asking ? { kind: 'embedded', reason: 'check', evidence: `${asking.vendor} ${asking.shows}` } : null;
  }

  const evidence = (node ? words(node) : title).slice(0, 120);
  return { kind: !node || others <= INTERSTITIAL_CONTROLS ? 'interstitial' : 'embedded', reason: 'check', evidence };
}

export const CHALLENGE_REFUSAL =
  'that is a bot check. Fanfold does not complete those: ask the user to do it themselves in the Fanfold window.';

/** What to tell an agent about a page the site put in its own place. */
export function challengeMessage(challenge: Challenge, host: string): string {
  switch (challenge.reason) {
    case 'signin':
      return `${host} wants a sign-in ("${challenge.evidence}"). Fanfold never signs in or types a password: `
        + 'ask the user to sign in themselves in the Fanfold window, then carry on from the same job.';
    case 'rate':
      return `${host} is rate-limiting this browser ("${challenge.evidence}"). Stop working on ${host} now, in every session, and do not retry: `
        + `leave it for at least ${Math.round(DEFAULT_PUSHBACK_MS.locked / 60_000)} minutes, tell the user, and carry on with other sites meanwhile. Do not look for a way around it.`;
    case 'limit':
      return `${host} says its daily limit is reached ("${challenge.evidence}"). Stop applying on ${host} until tomorrow `
        + '(it resets around midnight UTC) and tell the user; applications on company sites can go on. Do not look for a way around it.';
    default:
      return `${host} is showing a bot check ("${challenge.evidence}"). Fanfold does not attempt these and does not look for a way around them: `
        + 'ask the user to complete it themselves in the Fanfold window, then carry on.';
  }
}

/** The same, said to the person in the chat: what the site wants of them, and what to do next. */
export function challengeNotice(challenge: Challenge, host: string): string {
  switch (challenge.reason) {
    case 'signin':
      return `${host} wants you to sign in. Fanfold never signs in or types a password for you. `
        + 'Sign in yourself in the Fanfold window, then tell me to carry on.';
    case 'rate':
      return `${host} is limiting how often this browser can use it, so Fanfold stopped working there and won’t go back for at least `
        + `${Math.round(DEFAULT_PUSHBACK_MS.locked / 60_000)} minutes. Nothing else was done. Try again after that.`;
    case 'limit':
      return `${host} says you’ve reached its daily limit, so Fanfold won’t apply there again until tomorrow. `
        + 'Applications on company sites can go on.';
    default:
      return `${host} is showing a check to make sure you’re a person. Fanfold doesn’t do these checks. `
        + 'Finish it yourself in the Fanfold window, then tell me to carry on.';
  }
}

/** Until when a site is paused after this: a limit lasts to the next UTC midnight, with an hour's margin; rate-limiting a while. */
export function pausedUntil(challenge: Challenge, now = new Date()): Date | null {
  if (challenge.reason === 'rate') return new Date(now.getTime() + DEFAULT_PUSHBACK_MS.locked);
  if (challenge.reason !== 'limit') return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 1));
}
