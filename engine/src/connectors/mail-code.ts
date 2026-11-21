/**
 * The code a site emailed, found in the user's own mailbox.
 *
 * Some application forms send a short code to the applicant's address and
 * want it typed back before they take the application. With the user's mail
 * connected, Fanfold reads that one message and types the code itself, so
 * the application goes through without the person leaving what they are doing.
 *
 * What keeps this narrow:
 *  - It runs only when the page in front of the session is asking for a code
 *    it says it emailed, after that session's own application Submit.
 *    Sign-in, account and password pages never count.
 *  - Only mail that arrived after that Submit is looked at, only a message
 *    from the site or its application system is used, and a code that went
 *    into one form is never typed into another.
 *  - The code goes from the message to the field. It is not returned to the
 *    agent, which is told where it came from and nothing more.
 */
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { registrableDomain } from '../policy/site-pace.ts';
import type { Observation, ObservedNode, Ref } from '../types.ts';

/** One message, as much of it as finding a code needs. */
export interface CodeMail {
  id: string;
  from: string;
  subject: string;
  /** The body as text, or the snippet when the body could not be read. */
  text: string;
  /** When it arrived. */
  at: Date;
}

/** A page asking for the code it emailed. */
export interface CodeAsk {
  /** The field the code goes in. */
  ref: Ref;
  /** How many characters the page says the code has. */
  length: number | null;
  /** The words that gave it away, for the message to the user. */
  evidence: string;
  /** When the page splits the code into one box per character: the boxes, in order. */
  boxes?: Ref[];
}

const words = (node: ObservedNode): string =>
  [node.name, node.text].filter(Boolean).map((t) => unwrapUntrustedForDisplay(t!)).join(' ');

/** The page saying it sent something to an inbox. */
const SENT = /\b(code|passcode|pin)\b[^.]{0,60}\b(sent|emailed|e-mailed|mailed)\b[^.]{0,40}\b(to|your (e-?mail|inbox))\b|\b(sent|emailed|e-mailed)\b[^.]{0,60}\b(code|passcode|pin)\b|\bcheck your (e-?mail|inbox)\b[^.]{0,60}\b(code|passcode|pin)\b|\benter the\b[^.]{0,30}\bcode\b[^.]{0,40}\b(e-?mail|inbox)\b/i;
/** A field that takes such a code. */
const FIELD = /\b(security|verification|confirmation|one[- ]time|access|e-?mail)\s+(code|pin|passcode)\b|^\W*(enter )?(the )?(code|otp|passcode)\W*$/i;
/** Codes that belong to an account, not to an application: those stay the person's. "sign-in", "signin", "signed in" too. */
const ACCOUNT = /\b(sign(ing|ed)?[- ]?(in|up)|log(ging|ged)?[- ]?in|two[- ](factor|step)|2[- ]?step|multi[- ]?factor|mfa|2fa|authenticator|password|magic link|account|regist(er|ration)|verify your (identity|phone|number)|text message|sms)\b/i;
/** A sign-in or account address: accounts.example, /login, /signup and the like. */
const ACCOUNT_URL = /^(accounts?|login|signin|auth|sso|id|identity)\.|\/(log-?in|sign-?in|sign-?up|register|registration|auth|oauth2?|sso|mfa|2fa|account|accounts|[a-z-]*password)(\/|$)/i;
/** The page saying where it sent the code: an inbox, not a phone. */
const TO_INBOX = /\be-?mail|\binbox\b|@/i;
const TO_PHONE = /\b(phone|mobile|cell|whats ?app|texted)\b/i;
const LENGTH = /\b(\d{1,2}|four|five|six|seven|eight|nine|ten)[- ]?(?:digit|character|letter)s?\b/i;
const NUMBERS: Record<string, number> = { four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** One box of several, one character each: "digit 1 of 6". */
const BOX = /\b(digit|character|char|box)\s*\d+\b|\b\d+\s*of\s*\d+\b/i;
const numbered = (text: string): string => text.toLowerCase().replace(/\d+/g, '#');

/** What a field that takes an emailed code is called: "Security code", "Verification code". */
export function isCodeLabel(label: string): boolean {
  return FIELD.test(label) && !ACCOUNT.test(label);
}

/** A text field that takes an emailed code, by what it is called. */
export function isCodeField(node: ObservedNode): boolean {
  return Boolean(node.ref) && node.evidence?.control === 'text' && node.evidence.inputType !== 'password'
    && !node.state.disabled && isCodeLabel(words(node));
}

/** A field that is part of the code's entry, filled or not, whether or not it can still be typed into. */
export function partOfCode(node: ObservedNode): boolean {
  return node.evidence?.control === 'text' && node.evidence.inputType !== 'password' && isCodeLabel(words(node));
}

function entryOf(observation: Observation): { field: ObservedNode; boxes: Ref[] } | null {
  const field = observation.nodes.find(isCodeField);
  if (!field) return null;
  const label = words(field);
  const boxes = BOX.test(label)
    ? observation.nodes.filter((n) => isCodeField(n) && numbered(words(n)) === numbered(label)).map((n) => n.ref!)
    : [];
  return { field, boxes: boxes.length > 1 ? boxes : [] };
}

/** Where a code goes on the page: its field, and its boxes in order when it is split one character to a box. */
export function codeEntry(observation: Observation | null): { ref: Ref; boxes?: Ref[] } | null {
  const entry = observation ? entryOf(observation) : null;
  return entry ? { ref: entry.field.ref!, ...(entry.boxes.length ? { boxes: entry.boxes } : {}) } : null;
}

/**
 * A page about an account rather than an application: a password box, or a
 * title, heading, address or "we sent you a code" that speaks of signing in,
 * signing up, two-step verification and the like.
 */
export function forAccount(observation: Observation): boolean {
  if (observation.nodes.some((n) => n.evidence?.inputType === 'password')) return true;
  // Headings name the page as much as its title does: "Sign in", "Create your account".
  const said = [unwrapUntrustedForDisplay(observation.title)];
  for (const node of observation.nodes) {
    const text = words(node);
    if (node.role === 'heading' || SENT.test(text)) said.push(text);
  }
  if (said.some((t) => ACCOUNT.test(t))) return true;
  try {
    const url = new URL(observation.url);
    return ACCOUNT_URL.test(url.hostname) || ACCOUNT_URL.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * What the page asks for, when it asks for a code it emailed. Null on a
 * sign-in or account page, on a page with a password box, and where the code
 * came by text message.
 */
export function emailedCodeAsk(observation: Observation | null): CodeAsk | null {
  if (!observation || forAccount(observation)) return null;
  const said = observation.nodes.map(words).find((t) => SENT.test(t));
  const entry = entryOf(observation);
  if (!said || !entry) return null;
  // A code that went to a phone, or whose destination the page never says, is not one Fanfold can read.
  if (!TO_INBOX.test(said) || TO_PHONE.test(said)) return null;
  const { field, boxes } = entry;
  const length = LENGTH.exec(said) ?? LENGTH.exec(words(field));
  const n = length ? NUMBERS[length[1]!.toLowerCase()] ?? Number(length[1]) : boxes.length || null;
  return {
    ref: field.ref!, length: n !== null && n >= 4 && n <= 12 ? n : null, evidence: said.slice(0, 160),
    ...(boxes.length ? { boxes } : {}),
  };
}

const TOKEN = String.raw`[A-Za-z0-9]{4,12}`;
/** Not the start of something longer: a word, an address, a domain. */
const END = String.raw`(?![A-Za-z0-9@]|\.[A-Za-z0-9])`;
/** Quotes, brackets and bold around a code, as plain-text versions of HTML mail write it. */
const WRAP = String.raw`["'“‘(\[*]*`;
/** A zip code, a promo code, a job's reference code: none is the one the page wants. */
const OTHER = String.raw`(?<!\b(?:zip|postal|post|country|area|promo|promotional|discount|coupon|voucher|gift|referral|employee|job|requisition|reference|dress|source|tracking|qr|bar)[\s-])`;
const CUE = String.raw`${OTHER}\b(?:code|passcode|otp|pin)\b`;
/** "…code: X", "…code is X", "X is your … code": a cue on either side of the code. */
const CUED = [
  new RegExp(String.raw`${CUE}[^\n:]{0,80}:\s*${WRAP}(${TOKEN})${END}`, 'gi'),
  new RegExp(String.raw`${CUE} is:?\s+${WRAP}(${TOKEN})${END}`, 'gi'),
  new RegExp(String.raw`(?<![A-Za-z0-9@.])(${TOKEN})\s+is your\b[^.\n]{0,40}${CUE}`, 'gi'),
];
const MENTIONS = new RegExp(CUE, 'i');
const hasDigit = (s: string): boolean => /\d/.test(s);
const looksLikeYear = (s: string): boolean => /^(19|20)\d\d$/.test(s);

/**
 * The code in a message, or null. With the length the page gave, only a token
 * of that length counts. A plain word is never a code: a code has a digit, or
 * mixes in capitals at the length the page named, right after "code:" or
 * "code is", or right before "is your … code". Without that length, a token
 * with no digit could be any word.
 */
export function extractCode(text: string, length: number | null = null): string | null {
  const capitals = (token: string): number => token.replace(/[^A-Z]/g, '').length;
  const fits = (token: string, cued = false): boolean =>
    (length === null || token.length === length) && !looksLikeYear(token)
    && (hasDigit(token) || (cued && length !== null && capitals(token) >= 2));
  // Invisible characters split a code in two, and quoted lines are an older message's.
  const lines = text.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]|\u034f/g, '').split(/\r?\n/).filter((line) => !/^\s*>/.test(line));
  const body = lines.join('\n');
  for (const cue of CUED) {
    for (const m of body.matchAll(cue)) if (fits(m[1]!, true)) return m[1]!;
  }
  // No cue beside it: a token alone on its line, the way these messages set a
  // code apart, once the message has said it is giving a code.
  let mentioned = false;
  for (const line of lines) {
    const token = line.trim().replace(/^["'“‘([*]+|["'”’)\]*.]+$/g, '');
    if (mentioned && new RegExp(`^${TOKEN}$`).test(token) && fits(token)) return token;
    mentioned ||= MENTIONS.test(line);
  }
  return null;
}

/** A message that reads like one carrying a code to verify or sign in with. */
const CODE_MAIL = /\b(verification|security|confirmation|one[- ]time|access|sign[- ]?in|log[- ]?in|login)\s+(code|pin|passcode)\b|\b(otp|passcode)\b/i;

/**
 * The codes in a message that reads like a verification-code mail, as
 * extractCode would take them at any length a page might ask for, so a code
 * of letters alone is found too. For keeping them out of what a model reads.
 */
export function codesIn(text: string): string[] {
  if (!CODE_MAIL.test(text)) return [];
  const codes: string[] = [];
  let rest = text;
  for (let i = 0; i < 5; i++) {
    const code = [null, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => extractCode(rest, n)).find((c) => c !== null);
    if (!code) break;
    codes.push(code);
    rest = rest.split(code).join(' ');
  }
  return codes;
}

/** Mail systems application sites send from, by the site they belong to. */
const SENDERS: Array<{ site: RegExp; mail: RegExp }> = [
  { site: /(^|\.)greenhouse\.io$/, mail: /(^|\.)(greenhouse\.io|greenhouse-mail\.io)$/ },
  { site: /(^|\.)lever\.co$/, mail: /(^|\.)lever\.co$/ },
  { site: /(^|\.)ashbyhq\.com$/, mail: /(^|\.)ashbyhq\.com$/ },
  { site: /(^|\.)workable\.com$/, mail: /(^|\.)workable(mail)?\.com$/ },
  { site: /(^|\.)smartrecruiters\.com$/, mail: /(^|\.)smartrecruiters(mail)?\.com$/ },
  { site: /(^|\.)myworkdayjobs\.com$/, mail: /(^|\.)(myworkday|workday)\.com$/ },
  { site: /(^|\.)icims\.com$/, mail: /(^|\.)icims\.com$/ },
  { site: /(^|\.)jobvite\.com$/, mail: /(^|\.)jobvite\.com$/ },
  { site: /(^|\.)bamboohr\.com$/, mail: /(^|\.)bamboohr\.com$/ },
  { site: /(^|\.)breezy\.hr$/, mail: /(^|\.)breezy\.hr$/ },
  { site: /(^|\.)recruitee\.com$/, mail: /(^|\.)recruitee\.com$/ },
  { site: /(^|\.)teamtailor\.com$/, mail: /(^|\.)teamtailor(-mail)?\.com$/ },
];

/** The sending address's host. The display name is the sender's to write, so an address inside it counts for nothing. */
const addressHost = (from: string): string => {
  const address = /<([^<>]*)>\s*$/.exec(from)?.[1] ?? from;
  return (/@([a-z0-9.-]+)\s*$/i.exec(address)?.[1] ?? '').toLowerCase();
};
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** "Acme Corp, Inc." is written "Acme" in its own mail. */
const companyName = (s: string): string => norm(s).replace(/( (inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|bv))+$/, '');

export interface CodeSearch {
  /** The page asking. */
  url: string;
  /** The company applied to, when known. */
  company?: string;
  /** The board's name in the application's address, such as "spauldingridge". */
  board?: string;
  /** Companies other applications are waiting on codes from: a message that names one of them, and not this one, is that one's. */
  others?: string[];
  /** Nothing that arrived before this is the code. */
  since: Date;
  length: number | null;
  /** Message ids and codes already typed into a form, by any session. */
  used?: { has(key: string): boolean };
}

export interface CodeFound {
  code: string;
  mail: CodeMail;
}

/** Several codes arrived, and nothing says which is this form's. */
export interface CodeUnclear {
  code: null;
  several: number;
}

/** Mail from the site arrived, and no code that fits could be read from it. */
export interface CodeUnread {
  code: null;
  unreadable: number;
}

/** A code goes into one form only, whichever session typed it. Forgotten after this long, when it has expired anyway. */
const USED_FOR_MS = 30 * 60_000;

/** The messages and codes already typed into a form, shared by every session. */
export class UsedCodes {
  readonly #at = new Map<string, number>();

  add(...keys: string[]): void {
    const now = Date.now();
    for (const [key, at] of this.#at) if (now - at > USED_FOR_MS) this.#at.delete(key);
    for (const key of keys) this.#at.set(key, now);
  }

  has(key: string): boolean {
    const at = this.#at.get(key);
    return at !== undefined && Date.now() - at <= USED_FOR_MS;
  }
}

const squash = (s: string): string => norm(s).replace(/ /g, '');

/**
 * The board an application system's page belongs to, from its address:
 * job-boards.greenhouse.io/acme, boards.greenhouse.io/embed/job_app?for=acme,
 * jobs.lever.co/acme, acme.wd5.myworkdayjobs.com. Empty off those systems.
 */
export function boardOf(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  if (!SENDERS.some((s) => s.site.test(host))) return '';
  const labels = host.split('.');
  const own = labels.length > 2 ? labels[0]!.replace(/^(careers|jobs)-/, '') : '';
  if (own && !/^(www|jobs|job-boards|boards|apply|careers|hire|app|eu|us)$/.test(own)) return own;
  const segment = decodeURIComponent(u.pathname.split('/')[1] ?? '');
  return u.searchParams.get('for') ?? (segment === 'embed' ? '' : segment);
}

/**
 * The newest message that is this site's code, or why there is none. A
 * message counts only by its real sender: the page's own domain, or an
 * application system's mail domain. From a system, it has to name the company
 * (or the board) whenever that is known, since two applications through one
 * system can be waiting on codes at once. From the site's own domain, the
 * company decides only when it has to: one code is taken as it is, and of
 * several different ones only one that names the company is. When nothing is
 * known and several systems' codes are waiting, which is this form's cannot
 * be told, and none is picked.
 */
export function pickCode(mails: CodeMail[], search: CodeSearch): CodeFound | CodeUnclear | CodeUnread | null {
  let host = '';
  try { host = new URL(search.url).hostname.toLowerCase(); } catch { /* no site to match */ }
  const site = host ? registrableDomain(host) : '';
  const shared = SENDERS.some((s) => s.site.test(host));
  const company = search.company ? companyName(search.company) : '';
  const board = squash(search.board ?? '');
  const hinted = company !== '' || board !== '';
  const said = (mail: CodeMail): string => `${mail.subject} ${mail.text} ${mail.from}`;
  // Whole words: "Meta" is not named by "Metabase", nor "Box" by "inbox".
  const calls = (mail: CodeMail, name: string): boolean => name.length >= 3 && ` ${norm(said(mail))} `.includes(` ${name} `);
  // A board name is written without spaces: "spauldingridge" is "Spaulding Ridge".
  const names = (mail: CodeMail): boolean => calls(mail, company) || (board.length >= 3 && squash(said(mail)).includes(board));
  const others = (search.others ?? []).map(companyName).filter((c) => c !== company);

  const found: Array<CodeFound & { system: boolean; named: boolean }> = [];
  let unreadable = 0;
  const newestFirst = [...mails].sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const mail of newestFirst) {
    // A message without a readable time is not known to be newer than the ask.
    if (!(mail.at.getTime() >= search.since.getTime()) || search.used?.has(mail.id)) continue;
    const sender = addressHost(mail.from);
    if (!sender) continue;
    const fromSite = site !== '' && !shared && registrableDomain(sender) === site;
    const system = SENDERS.some((s) => s.mail.test(sender));
    if (!fromSite && !(system && (!hinted || names(mail)))) continue;
    const named = hinted && names(mail);
    if (!named && others.some((other) => calls(mail, other))) continue;
    const code = extractCode(`${mail.subject}\n${mail.text}`, search.length);
    if (!code) unreadable++;
    else if (!search.used?.has(code)) found.push({ code, mail, system: !fromSite, named });
  }
  if (!found.length) return unreadable ? { code: null, unreadable } : null;
  const distinct = (list: typeof found): number => new Set(list.map((f) => f.code)).size;
  let pool = found;
  const own = found.filter((f) => !f.system);
  if (hinted && distinct(own) > 1) {
    pool = found.filter((f) => f.named);
    if (!pool.length) return { code: null, several: distinct(own) };
  }
  const first = pool[0]!;
  if (!hinted && first.system) {
    const codes = distinct(found.filter((f) => f.system));
    if (codes > 1) return { code: null, several: codes };
  }
  return { code: first.code, mail: first.mail };
}

/** Where recent mail comes from. Either connector provides it. */
export type RecentMail = (since: Date, limit: number) => Promise<CodeMail[]>;

/** What a mailbox says when the grant behind it is gone, inside a reply that otherwise looks fine. */
const AUTH_GONE = /\bunauthenticated\b|\bunauthori[sz]ed\b|\binvalid (authentication|credentials)\b|\binvalid_grant\b|\b(expired or revoked|been revoked)\b|\b(account|connection)\b[^.]{0,30}\b(not active|inactive|expired|failed|revoked)\b/i;

/**
 * The mailbox turned the request away: a 401 or 403, or a reply that says the
 * grant is gone. It is not connected, or its access was withdrawn.
 */
export function mailRefused(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  const message = String((err as Error | null)?.message ?? '');
  return status === 401 || status === 403 || /\bAPI (401|403)\b/.test(message) || AUTH_GONE.test(message);
}

/**
 * Wait for the code to arrive. Mail takes a few seconds, so the mailbox is
 * read again until the code is there or the wait runs out. One failed read (a
 * rate limit, a moment's outage) does not end the wait; the error is thrown
 * only when no read succeeded at all. A mailbox that refuses the request ends
 * the wait at once: asking again will not change its answer. Mail from the
 * site with no code in it is reported only once the wait is over, since the
 * message with the code may still be on its way.
 */
export async function waitForCode(
  recent: RecentMail, search: CodeSearch,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<CodeFound | CodeUnclear | CodeUnread | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  const interval = opts.intervalMs ?? 3_000;
  let read = false;
  let failure: unknown = null;
  let unread: CodeUnread | null = null;
  const stopped = new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
  for (;;) {
    // Cancelled while waiting: nothing is read, and nothing gets typed for a call no one awaits.
    if (opts.signal?.aborted) return null;
    let mails: CodeMail[] | null = null;
    try {
      mails = await recent(search.since, 10);
      read = true;
    } catch (err) {
      if (mailRefused(err)) throw err;
      failure = err;
    }
    const found = mails ? pickCode(mails, search) : null;
    // Several codes and nothing to tell them apart: more mail will not settle it.
    if (found && (found.code !== null || 'several' in found)) return found;
    if (found) unread = found;
    if (Date.now() + interval > deadline || opts.signal?.aborted) {
      if (!read && failure) throw failure;
      return opts.signal?.aborted ? null : unread;
    }
    // A cancelled wait ends now, not at the next read.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([new Promise((r) => { timer = setTimeout(r, interval); }), stopped]);
    clearTimeout(timer);
  }
}
