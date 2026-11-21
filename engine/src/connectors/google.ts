/**
 * Google connector: OAuth for a desktop app, plus thin Gmail and Calendar
 * clients.
 *
 * Why an API rather than the browser, for these specifically: a connector
 * that talks to an API keeps working while the user's machine is asleep,
 * which is the main thing a local-first agent otherwise gives up. The browser
 * is for the long tail that has no usable API.
 *
 * The flow is the loopback redirect with PKCE, which is what Google specifies
 * for installed apps — no client secret is trusted to the device, and the
 * authorization code cannot be replayed by another local process without the
 * verifier.
 *
 * Scope note: Gmail read and send are RESTRICTED scopes. Using them in a
 * shipped product requires Google's verification and a security assessment,
 * which take weeks. That is a schedule item, not a launch-week task, and it
 * is the reason this file asks for the narrowest scopes that do the job.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { SecretStore } from './keychain.ts';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Scopes, and an honest note about one of them.
 *
 * `gmail.compose` is the narrowest scope Google offers for creating drafts,
 * but it is NOT draft-only: Google documents it as also authorising sending
 * messages and drafts. The boundary is that `Gmail` below has no send method
 * — a property of this code, which a bug or a change could remove, not a
 * property of the token, which cannot be talked out of.
 *
 * Because of that, `gmail.compose` is NOT requested by default. Reading is
 * the base grant; drafting is asked for only when the user turns it on, so
 * the common case holds a token that genuinely cannot send.
 *
 * https://developers.google.com/workspace/gmail/api/auth/scopes
 */
export const SCOPES = {
  /** Read metadata and bodies. Restricted — needs verification. */
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  /** Create drafts. Also permits sending, per Google — see the note above. */
  gmailDraft: 'https://www.googleapis.com/auth/gmail.compose',
  /** Read AND write mail. Not requested here, but a token minted elsewhere
   *  can carry it, and it implies both of the two above. */
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarWrite: 'https://www.googleapis.com/auth/calendar.events',
} as const;

/**
 * Which scopes permit which capability — in ONE place.
 *
 * A broader scope implies the narrower one it contains, which is how Google
 * treats them: `gmail.modify` can read and can draft, `calendar.events` can
 * list. The tool gating and the reachability probe must not disagree about
 * it: a `gmail.modify` token offered `gmail_search` and `gmail_draft` while
 * the probe skipped Gmail as "not granted" would let a broken Gmail beside a
 * working Calendar report a usable account.
 *
 * Anything that decides what a token can do reads this table.
 */
const CAPABILITY_SCOPES = {
  gmailRead: [SCOPES.gmailRead, SCOPES.gmailModify],
  gmailDraft: [SCOPES.gmailDraft, SCOPES.gmailModify],
  calendarRead: [SCOPES.calendarRead, SCOPES.calendarWrite],
} as const;

export type Capability = keyof typeof CAPABILITY_SCOPES;

/** Does this grant permit `capability`? */
export function permits(scopes: ReadonlySet<string> | undefined, capability: Capability): boolean {
  if (!scopes) return true; // unknown grant: the caller is not gating on scopes
  return CAPABILITY_SCOPES[capability].some((scope) => scopes.has(scope));
}

/** What the consent tab says when it closes, and why sign-in failed. */
export const COPY = {
  tabConnected: 'Fanfold is connected to Google. You can close this tab now.',
  tabFailed: 'Google sign in did not finish, so nothing was connected. Reason: {reason} Close this tab and go back to Fanfold.',
  noSecret: 'Google needs this app\'s client secret, but Fanfold does not have one. In Google Cloud, open Clients, open your client, and copy the client secret. Add it to app/.env as GOOGLE_CLIENT_SECRET, restart Fanfold, and try connecting again.',
};

/** Why sign-in failed, in words the person can act on. */
export function plainReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return /client_secret is missing/i.test(message) ? COPY.noSecret : message;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What we ask for unless the user explicitly enables drafting. */
export const DEFAULT_SCOPES: string[] = [SCOPES.gmailRead, SCOPES.calendarRead];

/** Adds the ability to create drafts — and, unavoidably, to send. */
export const DRAFTING_SCOPES: string[] = [...DEFAULT_SCOPES, SCOPES.gmailDraft];

export interface GoogleCredentials {
  clientId: string;
  /** Desktop clients have a secret, but it is not a secret in any real sense
   *  — PKCE is what actually protects the exchange. */
  clientSecret?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
}

export class GoogleAuth {
  #creds: GoogleCredentials;
  #secrets: SecretStore;
  #account: string;

  constructor(creds: GoogleCredentials, secrets: SecretStore, account = 'google') {
    this.#creds = creds;
    this.#secrets = secrets;
    this.#account = account;
  }

  /**
   * Run the consent flow. Opens nothing by itself — it returns the URL for
   * the caller to show, so the user sees where they are being sent.
   */
  async authorize(scopes: string[], onUrl: (url: string) => void): Promise<TokenSet> {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));

    // Captured when the listener binds, not read back from the server later:
    // the handler closes the server before resolving, and `address()` is null
    // once it has, so reading it there would throw on every valid callback. It
    // is also the value that must match the redirect_uri sent in the request,
    // so there should only ever be one copy.
    let redirectUri = '';

    const { code, answer } = await new Promise<{ code: string; answer: (ok: boolean, why?: string) => void }>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(expiry);
        server.close();
        fn();
      };

      // A consent nobody completes should not leave a listener bound forever.
      const expiry = setTimeout(
        () => finish(() => reject(new Error('the consent flow was not completed in time'))),
        5 * 60_000,
      );
      expiry.unref?.();

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404); res.end(); return;
        }

        // VALIDATE BEFORE RESPONDING, and before closing anything.
        //
        // A callback with the wrong state must not be told it worked, nor
        // take the listener down with it: the genuine callback arriving a
        // moment later would hit a refused connection. Anyone who could reach
        // loopback could end a consent flow that way, and the person who
        // clicked "allow" would see a browser error with no explanation.
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'content-type': 'text/html' });
          res.end('<p>This callback did not come from a sign-in this app started. Ignoring it.</p>');
          return; // deliberately still listening for the real one
        }

        const declined = url.searchParams.get('error');
        if (declined) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<p>Sign-in was cancelled. You can close this tab.</p>');
          return finish(() => reject(new Error(`authorization declined: ${declined}`)));
        }

        const received = url.searchParams.get('code');
        if (!received) {
          res.writeHead(400, { 'content-type': 'text/html' });
          res.end('<p>That callback carried no authorization code.</p>');
          return finish(() => reject(new Error('no authorization code in the callback')));
        }

        // The tab is answered only once the code has been exchanged: consent that Google
        // accepts can still fail there, and the person must not be told it worked.
        const answer = (ok: boolean, why = ''): void => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(`<p>${escapeHtml(ok ? COPY.tabConnected : COPY.tabFailed.replace('{reason}', why))}</p>`);
        };
        finish(() => resolve({ code: received, answer }));
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          return finish(() => reject(new Error('could not determine the callback port')));
        }
        redirectUri = `http://127.0.0.1:${address.port}/callback`;
        const params = new URLSearchParams({
          client_id: this.#creds.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: scopes.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        });
        onUrl(`${AUTH_ENDPOINT}?${params}`);
      });
      server.on('error', (err) => finish(() => reject(err)));
    });

    let tokens: TokenSet;
    try {
      tokens = await this.#exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      if (tokens.refreshToken) await this.#secrets.set(`${this.#account}:refresh`, tokens.refreshToken);
    } catch (err) {
      answer(false, plainReason(err));
      throw err;
    }
    answer(true);
    return tokens;
  }

  /** A valid access token, refreshing if necessary. */
  async accessToken(): Promise<string> {
    return (await this.tokenSet()).accessToken;
  }

  /** The current token set, refreshing if it is close to expiry. */
  async tokenSet(): Promise<TokenSet> {
    const cached = await this.#secrets.get(`${this.#account}:access`);
    if (cached) {
      const parsed = JSON.parse(cached) as TokenSet;
      // Refresh a minute early: a token that expires mid-request produces a
      // confusing 401 rather than a clean refresh.
      if (parsed.expiresAt > Date.now() + 60_000) return parsed;
    }

    const refresh = await this.#secrets.get(`${this.#account}:refresh`);
    if (!refresh) throw new Error('not connected to Google — run the authorize flow first');

    return this.#exchange({ grant_type: 'refresh_token', refresh_token: refresh });
  }

  /**
   * What this token is actually allowed to do.
   *
   * Asked of the token rather than inferred from what was requested at
   * consent: the user can decline individual scopes on Google's screen, and a
   * token minted before drafting was enabled does not gain the scope because
   * the app now asks for it. Offering an action the grant does not cover
   * means the agent advertises something Google will refuse.
   */
  async grantedScopes(): Promise<Set<string>> {
    try {
      const tokens = await this.tokenSet();
      return new Set((tokens.scope ?? '').split(/\s+/).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  async disconnect(): Promise<void> {
    this.#secrets.delete(`${this.#account}:access`);
    this.#secrets.delete(`${this.#account}:refresh`);
  }

  async #exchange(body: Record<string, string>): Promise<TokenSet> {
    const params = new URLSearchParams({ client_id: this.#creds.clientId, ...body });
    if (this.#creds.clientSecret) params.set('client_secret', this.#creds.clientSecret);

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json() as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string;
      error?: string; error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new Error(`token exchange failed: ${json.error_description ?? json.error ?? res.status}`);
    }
    // A refresh response often omits `scope`; the grant has not changed, so
    // carry the previous value rather than recording an empty one and
    // concluding the token can do nothing.
    //
    // Only on a refresh. A fresh consent exchange that reports no scope must
    // NOT inherit an older, possibly broader grant — that is precisely the
    // case where the user may have just declined something, and assuming the
    // previous answer would re-grant it silently.
    let scope = json.scope ?? '';
    if (!scope && body.grant_type === 'refresh_token') {
      const previous = await this.#secrets.get(`${this.#account}:access`).catch(() => null);
      if (previous) {
        try {
          scope = (JSON.parse(previous) as TokenSet).scope ?? '';
        } catch { /* unreadable; treat as no known scope */ }
      }
    }

    const tokens: TokenSet = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      scope,
    };
    await this.#secrets.set(`${this.#account}:access`, JSON.stringify(tokens));
    return tokens;
  }
}

/**
 * Refuse anything that could start a new header line.
 *
 * CR and LF are the injection; the other C0 controls have no business in a
 * header either and their presence means the value did not come from
 * somewhere trustworthy.
 */
export function assertHeaderSafe(field: string, value: string): string {
  // eslint-disable-next-line no-control-regex -- finding control characters is the point
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(
      `refusing to build a message: the ${field} value contains a control character, ` +
      'which would create a header of its own',
    );
  }
  if (value.length > 998) {
    // RFC 5322 line limit; a longer value would be folded or truncated by
    // something downstream, and we would not know which.
    throw new Error(`refusing to build a message: the ${field} value is too long for a header`);
  }
  return value;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What the tool layer needs from a mail provider. Two implementations stand
 * behind it — Google's API directly, and Composio — and the tool layer must
 * not care which. Deliberately no `send`: that is the boundary this code
 * keeps whatever the underlying grant permits.
 */
export interface MailReader {
  search(query: string, limit?: number): Promise<MessageSummary[]>;
  createDraft(to: string, subject: string, body: string): Promise<{ id: string }>;
  /** Messages that arrived after a moment, newest first, with their text. For the code a site just emailed. */
  arrivedSince(since: Date, limit?: number): Promise<MessageText[]>;
}

export interface MessageText {
  id: string;
  from: string;
  subject: string;
  /** The body as plain text; the snippet when the body could not be read. */
  text: string;
  at: Date;
}

interface MimePart {
  mimeType?: string;
  /** Set on an attached file, which is not the message's text. */
  filename?: string;
  body?: { data?: string };
  parts?: MimePart[];
}

/** A message's text: its plain part, or its HTML with the tags taken out. */
export function mimeText(part: MimePart | undefined): string {
  const all = (p: MimePart | undefined, type: string): string[] => {
    if (!p || p.filename) return [];
    const own = p.mimeType?.toLowerCase() === type && p.body?.data ? [Buffer.from(p.body.data, 'base64url').toString('utf8')] : [];
    return [...own, ...(p.parts ?? []).flatMap((child) => all(child, type))];
  };
  const plain = all(part, 'text/plain').join('\n').trim();
  if (plain) return plain;
  return htmlText(all(part, 'text/html').join('\n'));
}

/** A numbered character, or nothing for a number no character has. */
const codePoint = (n: number): string => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/** HTML as the text a person reads, one block to a line. */
export function htmlText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&(zwnj|zwj|shy);/gi, '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => codePoint(parseInt(n, 16))).replace(/&#(\d{1,7});/g, (_, n: string) => codePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export interface CalendarReader {
  events(from: Date, to: Date, calendarId?: string): Promise<CalendarEvent[]>;
  freeSlots(from: Date, to: Date, minutes: number, workingHours?: [number, number]): Promise<Array<{ start: Date; end: Date }>>;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export class Gmail {
  #auth: GoogleAuth;
  constructor(auth: GoogleAuth) { this.#auth = auth; }

  async search(query: string, limit = 20): Promise<MessageSummary[]> {
    const list = await this.#get<{ messages?: Array<{ id: string; threadId: string }> }>(
      `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`,
    );
    const out: MessageSummary[] = [];
    for (const m of list.messages ?? []) {
      const full = await this.#get<{
        id: string; threadId: string; snippet: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      }>(`/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const header = (name: string): string =>
        full.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      out.push({
        id: full.id, threadId: full.threadId, snippet: full.snippet,
        from: header('from'), subject: header('subject'), date: header('date'),
      });
    }
    return out;
  }

  async arrivedSince(since: Date, limit = 10): Promise<MessageText[]> {
    const list = await this.#get<{ messages?: Array<{ id: string }> }>(
      `/users/me/messages?q=${encodeURIComponent(`after:${Math.floor(since.getTime() / 1000)}`)}&maxResults=${Math.min(Math.max(limit, 1), 20)}`,
    );
    const out: MessageText[] = [];
    for (const m of list.messages ?? []) {
      let full: {
        id: string; snippet?: string; internalDate?: string;
        payload?: MimePart & { headers?: Array<{ name: string; value: string }> };
      };
      try {
        full = await this.#get(`/users/me/messages/${encodeURIComponent(m.id)}?format=full`);
      } catch (err) {
        // Deleted between the list and the read: the rest of the mailbox still counts.
        if (/^Google API 404\b/.test((err as Error).message)) continue;
        throw err;
      }
      const header = (name: string): string =>
        full.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      const at = new Date(Number(full.internalDate ?? NaN));
      out.push({
        id: full.id, from: header('from'), subject: header('subject'),
        text: (mimeText(full.payload) || full.snippet || '').slice(0, 20_000),
        at: Number.isNaN(at.getTime()) ? new Date(header('date') || 0) : at,
      });
    }
    return out.filter((m) => m.at.getTime() >= since.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  /**
   * Create a draft. There is deliberately no send method on this class.
   *
   * That absence is the boundary. It is NOT the scope: `gmail.compose` also
   * authorises sending, so the token could send if this code asked it to.
   *
   * Headers are built by concatenation, which makes this an injection site: a
   * newline in a recipient or subject becomes a new header, so a To field
   * carrying "\r\nBcc: attacker@evil" would add a real Bcc. Rejected rather
   * than stripped — a newline in an address is never a typo, and silently
   * removing it hides whatever put it there.
   */
  async createDraft(to: string, subject: string, body: string): Promise<{ id: string }> {
    const headers = [
      ['To', assertHeaderSafe('To', to)],
      ['Subject', assertHeaderSafe('Subject', subject)],
      ['Content-Type', 'text/plain; charset=utf-8'],
    ];
    const mime = [...headers.map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n');
    return this.#post<{ id: string }>('/users/me/drafts', {
      message: { raw: Buffer.from(mime, 'utf8').toString('base64url') },
    });
  }

  async #get<T>(path: string): Promise<T> {
    return request<T>('https://gmail.googleapis.com/gmail/v1' + path, await this.#auth.accessToken());
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    return request<T>('https://gmail.googleapis.com/gmail/v1' + path, await this.#auth.accessToken(), body);
  }
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
}

export class Calendar {
  #auth: GoogleAuth;
  constructor(auth: GoogleAuth) { this.#auth = auth; }

  async events(from: Date, to: Date, calendarId = 'primary'): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: from.toISOString(), timeMax: to.toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
    });
    const res = await request<{
      items?: Array<{
        id: string; summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
        attendees?: Array<{ email: string }>;
      }>;
    }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      await this.#auth.accessToken(),
    );
    return (res.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary ?? '(no title)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      attendees: (e.attendees ?? []).map((a) => a.email),
    }));
  }

  /** Free slots of at least `minutes` within working hours. */
  async freeSlots(
    from: Date, to: Date, minutes: number, workingHours: [number, number] = [9, 18],
  ): Promise<Array<{ start: Date; end: Date }>> {
    return computeFreeSlots(await this.events(from, to), from, to, minutes, workingHours);
  }
}

/**
 * Gaps of at least `minutes` inside working hours, given the events that
 * occupy the window. Provider-independent: the arithmetic is the same whether
 * the events came from Google directly or through Composio.
 *
 * Walks the window one day at a time rather than scanning a single flat
 * timeline. A flat scan only offers gaps after the starting instant on the
 * starting day: asked at 19:30 with an empty calendar, the first gap it finds
 * begins outside working hours and it never reaches tomorrow. "No time this
 * week" is a bad answer when the whole week is free.
 */
export function computeFreeSlots(
  events: CalendarEvent[], from: Date, to: Date, minutes: number, workingHours: [number, number] = [9, 18],
): Array<{ start: Date; end: Date }> {
  const [openHour, closeHour] = workingHours;
  const needed = minutes * 60_000;

  const busy = events
    .map((e) => ({ start: new Date(e.start), end: new Date(e.end) }))
    .filter((b) => !Number.isNaN(b.start.getTime()) && !Number.isNaN(b.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: Array<{ start: Date; end: Date }> = [];

  for (const day of daysBetween(from, to)) {
    const open = new Date(day);
    open.setHours(openHour, 0, 0, 0);
    const close = new Date(day);
    close.setHours(closeHour, 0, 0, 0);

    // Never offer a time already past, and never beyond the caller's window.
    let cursor = new Date(Math.max(open.getTime(), from.getTime()));
    const limit = new Date(Math.min(close.getTime(), to.getTime()));
    if (cursor >= limit) continue;

    for (const block of busy) {
      if (block.end <= cursor) continue;
      if (block.start >= limit) break;
      if (block.start.getTime() - cursor.getTime() >= needed) {
        slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + needed) });
      }
      if (block.end > cursor) cursor = new Date(block.end);
      if (cursor >= limit) break;
    }

    if (limit.getTime() - cursor.getTime() >= needed) {
      slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + needed) });
    }
  }
  return slots;
}

/** Each calendar day the window touches, at local midnight. */
function daysBetween(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  // A bounded walk: a caller asking for a decade should not hang.
  for (let i = 0; i < 400 && cursor <= to; i++) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

async function request<T>(url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google API ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface ProbeResult {
  /** The API answered for this account. */
  ok: boolean;
  /** What happened, in a form worth showing a person. */
  detail: string;
  /** No scope covers it, so it was not called at all. */
  skipped?: boolean;
}

export interface Reachability {
  gmail: ProbeResult;
  calendar: ProbeResult;
  checkedAt: string;
}

/**
 * Call each API once, for real.
 *
 * A granted scope is a claim about what a token WOULD permit. It is not
 * evidence that the API answers: the Gmail API may be disabled in the Cloud
 * project, the refresh token may have been revoked from the account's
 * security page, the OAuth client may still be in testing with this user
 * removed, or the project may be over quota. Every one of those presents as a
 * perfectly good scope list and a 401/403 on first use.
 *
 * So the status shown to a user — and the verifier's gate — is this, not the
 * scope string. These are the cheapest reads that prove an account is
 * actually reachable: a Gmail profile, and one calendar list entry.
 */
export async function checkReachable(auth: GoogleAuth, scopes?: Set<string>): Promise<Reachability> {
  const granted = scopes ?? (await auth.grantedScopes().catch(() => new Set<string>()));

  /*
   * What is probed follows what the token ADVERTISES, via the shared table —
   * never a hardcoded scope string. `gmail.modify` reads mail, so it is
   * checked; a compose-only token cannot read mail but can still draft, so
   * its drafts list is what gets checked. Probing an endpoint the grant does
   * not cover would report a perfectly good account as broken.
   */
  const gmailProbe = permits(granted, 'gmailRead')
    ? probe(auth, 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        (r: { emailAddress?: string }) => `answered for ${r.emailAddress ?? 'this account'}`)
    : permits(granted, 'gmailDraft')
      ? probe(auth, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=1',
          (r: { drafts?: unknown[] }) => `answered; drafting is available (${r.drafts?.length ?? 0} draft(s) listed)`)
      : Promise.resolve(notGranted('no Gmail scope granted'));

  const [gmail, calendar] = await Promise.all([
    gmailProbe,
    permits(granted, 'calendarRead')
      ? probe(auth, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
          (r: { items?: Array<{ summary?: string }> }) =>
            `answered with ${r.items?.length ?? 0} calendar(s)`)
      : Promise.resolve(notGranted('no Calendar read scope granted')),
  ]);

  return { gmail, calendar, checkedAt: new Date().toISOString() };
}

function notGranted(detail: string): ProbeResult {
  return { ok: false, detail, skipped: true };
}

async function probe<T>(auth: GoogleAuth, url: string, describe: (r: T) => string): Promise<ProbeResult> {
  try {
    const body = await request<T>(url, await auth.accessToken());
    return { ok: true, detail: describe(body) };
  } catch (err) {
    // Deliberately keeps Google's own message: "Gmail API has not been used
    // in project ... before or it is disabled" is the actual fix, and
    // flattening it to "failed" throws away the only useful part.
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Is the connected account actually usable?
 *
 * The rule, stated once so a gate and a status line cannot disagree about it:
 * **every capability the token advertises must answer.** A scope the user
 * declined was never asked for and does not count against the account; a
 * scope they DID grant that returns 403 is a broken connector, however well
 * the other one works.
 *
 * Asking only that something answered would pass an account whose Gmail
 * returns 403 beside a working Calendar, both granted. That is precisely the
 * state a person needs told about, since the agent will offer `gmail_search`
 * and it will fail on first use.
 */
export function reachabilitySummary(r: Reachability): { usable: boolean; why: string } {
  const probes: Array<[string, ProbeResult]> = [['Gmail', r.gmail], ['Calendar', r.calendar]];
  const attempted = probes.filter(([, p]) => !p.skipped);
  if (!attempted.length) {
    return { usable: false, why: 'no read scope is granted, so nothing could be checked' };
  }
  const broken = attempted.filter(([, p]) => !p.ok);
  if (broken.length) {
    return {
      usable: false,
      why: broken.map(([name, p]) => `${name} is granted but failing: ${p.detail}`).join('; '),
    };
  }
  const skipped = probes.filter(([, p]) => p.skipped).map(([name]) => name);
  return {
    usable: true,
    why: skipped.length
      ? `${attempted.map(([n]) => n).join(' and ')} answered; ${skipped.join(' and ')} not granted`
      : `${attempted.map(([n]) => n).join(' and ')} answered`,
  };
}
