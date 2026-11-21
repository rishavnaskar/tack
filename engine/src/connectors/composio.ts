/**
 * Connectors through Composio.
 *
 * Composio holds the OAuth relationship — its own Google Cloud project, its
 * own consent screens, its own token refresh — and exposes each account as a
 * "connected account" against which named tools are executed. For a
 * single-user local product that removes the two things that made the direct
 * Google path expensive to ship: creating and verifying an OAuth client for
 * restricted Gmail scopes, and keeping refresh tokens on the device.
 *
 * What does NOT change is the boundary this code keeps. The mail reader here
 * has no `send`, exactly like the direct one, however much the underlying
 * grant would permit; the tool layer gates each action on what the account's
 * scopes actually cover; and "connected" is never taken as "working" — a
 * connection is checked by executing a real read against it.
 *
 * Plain fetch against the documented REST surface (v3.1), not the SDK, so the
 * project keeps its zero-dependency footprint and every request it makes is
 * visible in this file.
 *
 *   POST /api/v3.1/auth_configs                 create a Composio-managed auth config
 *   GET  /api/v3.1/auth_configs                 find one for a toolkit
 *   POST /api/v3.1/connected_accounts/link      start consent: redirect_url + connected_account_id
 *   GET  /api/v3.1/connected_accounts            list, filtered by user and toolkit
 *   GET  /api/v3.1/connected_accounts/{id}       status, requested_scopes
 *   DELETE /api/v3.1/connected_accounts/{id}     disconnect
 *   POST /api/v3.1/tools/execute/{slug}          run one tool against one account
 */

import {
  SCOPES, permits, assertHeaderSafe, computeFreeSlots,
  htmlText, mimeText,
  type MailReader, type CalendarReader, type MessageSummary, type MessageText, type CalendarEvent,
  type Reachability, type ProbeResult,
} from './google.ts';

const COMPOSIO_BASE = 'https://backend.composio.dev';

/** The toolkits this product uses, by Composio's slugs. */
export const TOOLKITS = {
  gmail: 'gmail',
  calendar: 'googlecalendar',
  linkedin: 'linkedin',
} as const;
export type ToolkitSlug = (typeof TOOLKITS)[keyof typeof TOOLKITS];

export type ConnectionStatus = 'INITIALIZING' | 'INITIATED' | 'ACTIVE' | 'EXPIRED' | 'FAILED' | 'INACTIVE' | string;

export interface ConnectedAccount {
  id: string;
  status: ConnectionStatus;
  toolkit: ToolkitSlug;
  /** OAuth scopes requested at the most recent initiation. May be empty. */
  requestedScopes: string[];
  createdAt: string | null;
}

export interface ComposioOptions {
  apiKey: string;
  /**
   * The user these accounts belong to, as Composio knows them. One local
   * install is one user; this is a stable string, not a secret.
   */
  userId: string;
  /** Pre-created auth config ids, by toolkit. Otherwise one is created. */
  authConfigIds?: Partial<Record<ToolkitSlug, string>>;
  /** Another address for Composio's API: a proxy, or a stand-in for tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ComposioError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ComposioError';
    this.status = status;
  }
}

export class ComposioClient {
  #apiKey: string;
  #userId: string;
  #authConfigIds: Partial<Record<ToolkitSlug, string>>;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #base: string;

  constructor(opts: ComposioOptions) {
    if (!opts.apiKey) throw new Error('Composio requires an API key');
    this.#apiKey = opts.apiKey;
    this.#userId = opts.userId;
    this.#authConfigIds = { ...(opts.authConfigIds ?? {}) };
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#base = opts.baseUrl || COMPOSIO_BASE;
  }

  get userId(): string {
    return this.#userId;
  }

  /**
   * The auth config a toolkit's connections hang off. Looked up first, so a
   * dashboard-created one is reused; created as Composio-managed otherwise.
   */
  async authConfigFor(toolkit: ToolkitSlug): Promise<string> {
    const pinned = this.#authConfigIds[toolkit];
    if (pinned) return pinned;

    const listed = await this.#request<{ items?: Array<{ id: string; toolkit?: { slug?: string } }> }>(
      'GET', '/api/v3.1/auth_configs', undefined, { toolkit_slug: toolkit },
    );
    const existing = (listed.items ?? []).find((a) => a.toolkit?.slug?.toLowerCase() === toolkit);
    if (existing?.id) {
      this.#authConfigIds[toolkit] = existing.id;
      return existing.id;
    }

    const created = await this.#request<{ auth_config?: { id?: string } }>('POST', '/api/v3.1/auth_configs', {
      toolkit: { slug: toolkit },
      auth_config: { type: 'use_composio_managed_auth', credentials: {}, restrict_to_following_tools: [] },
    });
    const id = created.auth_config?.id;
    if (!id) throw new ComposioError(`Composio created an auth config for ${toolkit} but returned no id`, null);
    this.#authConfigIds[toolkit] = id;
    return id;
  }

  /** Begin consent for one toolkit. The person is sent to `redirectUrl`. */
  async startConnection(toolkit: ToolkitSlug): Promise<{ redirectUrl: string; connectedAccountId: string }> {
    const authConfigId = await this.authConfigFor(toolkit);
    const res = await this.#request<{ redirect_url?: string; connected_account_id?: string }>(
      'POST', '/api/v3.1/connected_accounts/link', { auth_config_id: authConfigId, user_id: this.#userId },
    );
    if (!res.redirect_url || !res.connected_account_id) {
      throw new ComposioError(`Composio returned no consent link for ${toolkit}`, null);
    }
    return { redirectUrl: res.redirect_url, connectedAccountId: res.connected_account_id };
  }

  async account(id: string): Promise<ConnectedAccount> {
    const res = await this.#request<RawAccount>('GET', `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);
    return toAccount(res);
  }

  /** Every account of this user for a toolkit, newest first. */
  async accounts(toolkit?: ToolkitSlug): Promise<ConnectedAccount[]> {
    const query: Record<string, string> = { user_ids: this.#userId };
    if (toolkit) query.toolkit_slugs = toolkit;
    const res = await this.#request<{ items?: RawAccount[] }>('GET', '/api/v3.1/connected_accounts', undefined, query);
    return (res.items ?? [])
      .map(toAccount)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }

  /** The account the agent should use for a toolkit: the newest ACTIVE one. */
  async activeAccount(toolkit: ToolkitSlug): Promise<ConnectedAccount | null> {
    return (await this.accounts(toolkit)).find((a) => a.status === 'ACTIVE') ?? null;
  }

  /**
   * Wait for a consent the person is completing in their browser.
   *
   * Composio's redirect lands on its own page, not on this app, so the only
   * way to learn the outcome is to ask. Polled every two seconds, bounded,
   * and abortable — a consent nobody completes must not wait forever.
   */
  async waitUntilActive(
    id: string, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<ConnectedAccount> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const interval = opts.intervalMs ?? 2_000;
    for (;;) {
      if (opts.signal?.aborted) throw new ComposioError('consent was cancelled', null);
      const account = await this.account(id);
      if (account.status === 'ACTIVE') return account;
      if (account.status === 'FAILED' || account.status === 'EXPIRED' || account.status === 'INACTIVE') {
        throw new ComposioError(`the connection ended as ${account.status}`, null);
      }
      if (Date.now() >= deadline) throw new ComposioError('the consent flow was not completed in time', null);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async disconnect(id: string): Promise<void> {
    await this.#request('DELETE', `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);
  }

  /** Execute one tool against one account and return its data, or throw its error. */
  async execute<T = Record<string, unknown>>(
    slug: string, connectedAccountId: string, args: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.#request<{ successful?: boolean; data?: T; error?: unknown }>(
      'POST', `/api/v3.1/tools/execute/${encodeURIComponent(slug)}`,
      { connected_account_id: connectedAccountId, user_id: this.#userId, arguments: args },
    );
    if (res.successful === false || (res.error !== null && res.error !== undefined)) {
      throw new ComposioError(`${slug} failed: ${describeError(res.error)}`, null);
    }
    return (res.data ?? {}) as T;
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.#base);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await this.#fetch(url, {
      method,
      headers: {
        'x-api-key': this.#apiKey,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    if (!res.ok) {
      const err = (parsed as { error?: unknown }).error ?? parsed;
      throw new ComposioError(`Composio API ${res.status}: ${describeError(err).slice(0, 300)}`, res.status);
    }
    return parsed as T;
  }
}

/** What LinkedIn's own API says about the signed-in member. It is not much, by LinkedIn's design. */
export interface LinkedInProfile {
  name: string | null;
  email: string | null;
  headline: string | null;
  /** Their public profile address, when LinkedIn gives a handle for it. */
  url: string | null;
}

const first = (...values: unknown[]): string | null => {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
  return null;
};

/**
 * The user's own LinkedIn profile, through their Composio connection.
 *
 * This reads who the member is and nothing else. LinkedIn's API offers a
 * member no access to job search, applications or messages, so those stay in
 * the browser, under the site's terms: Fanfold fills, the user submits.
 */
export class ComposioLinkedIn {
  #client: ComposioClient;
  #accountId: string;

  constructor(client: ComposioClient, accountId: string) {
    this.#client = client;
    this.#accountId = accountId;
  }

  async profile(): Promise<LinkedInProfile> {
    const raw = await this.#client.execute<Record<string, unknown>>('LINKEDIN_GET_MY_INFO', this.#accountId, {});
    // The shape differs by LinkedIn API version; every known spelling is tried.
    const data = (raw.response_dict ?? raw.data ?? raw) as Record<string, unknown>;
    const given = first(data.given_name, data.localizedFirstName, data.firstName);
    const family = first(data.family_name, data.localizedLastName, data.lastName);
    const handle = first(data.vanityName, data.vanity_name);
    return {
      name: first(data.name, [given, family].filter(Boolean).join(' ')),
      email: first(data.email, data.emailAddress),
      headline: first(data.headline, data.localizedHeadline),
      url: handle ? `https://www.linkedin.com/in/${handle}` : first(data.profile_url, data.publicProfileUrl),
    };
  }
}

interface RawAccount {
  id?: string;
  status?: string;
  toolkit?: { slug?: string };
  requested_scopes?: string[];
  created_at?: string;
}

function toAccount(raw: RawAccount): ConnectedAccount {
  return {
    id: String(raw.id ?? ''),
    status: String(raw.status ?? 'UNKNOWN'),
    toolkit: String(raw.toolkit?.slug ?? '').toLowerCase() as ToolkitSlug,
    requestedScopes: Array.isArray(raw.requested_scopes) ? raw.requested_scopes.map(String) : [],
    createdAt: raw.created_at ? String(raw.created_at) : null,
  };
}

function describeError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err;
  const e = err as { message?: string; suggested_fix?: string; raw?: string };
  return [e.message, e.suggested_fix].filter(Boolean).join(' — ') || e.raw || JSON.stringify(err).slice(0, 200);
}

/**
 * Broad Google scopes that Composio-managed auth commonly requests, and
 * which imply the narrower capabilities this product gates on.
 */
const FULL_MAIL = 'https://mail.google.com/';
const FULL_CALENDAR = 'https://www.googleapis.com/auth/calendar';

/**
 * What a set of connected accounts lets the agent do, expressed in the same
 * scope vocabulary the tool layer already gates on.
 *
 * Fail-closed where the evidence is thin: an ACTIVE Gmail account whose
 * requested scopes are not reported gets READ only. Drafting — the one
 * capability that also means the grant can send — is offered only when a
 * scope that permits it is actually listed.
 */
export function scopesFromAccounts(accounts: ConnectedAccount[]): Set<string> {
  const scopes = new Set<string>();
  for (const a of accounts) {
    if (a.status !== 'ACTIVE') continue;
    const granted = new Set(a.requestedScopes);
    if (a.toolkit === TOOLKITS.gmail) {
      scopes.add(SCOPES.gmailRead);
      if (granted.has(FULL_MAIL) || permits(granted, 'gmailDraft')) scopes.add(SCOPES.gmailDraft);
    }
    if (a.toolkit === TOOLKITS.calendar) {
      scopes.add(SCOPES.calendarRead);
      if (granted.has(FULL_CALENDAR) || granted.has(SCOPES.calendarWrite)) scopes.add(SCOPES.calendarWrite);
    }
  }
  return scopes;
}

interface FetchedMessage {
  messageId?: string; id?: string; threadId?: string; subject?: string;
  from?: string; sender?: string; internalDate?: string | number; date?: string; messageTimestamp?: string;
  snippet?: string; preview?: { body?: string; subject?: string }; messageText?: string;
  payload?: Parameters<typeof mimeText>[0];
}

/** Milliseconds since 1970 from a count of them or a date written out; NaN for neither. */
const when = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v.trim()) return NaN;
  return /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
};

/** Mail through Composio. No `send`, on purpose — see the module note. */
export class ComposioGmail implements MailReader {
  #client: ComposioClient;
  #accountId: string;
  constructor(client: ComposioClient, connectedAccountId: string) {
    this.#client = client;
    this.#accountId = connectedAccountId;
  }

  async search(query: string, limit = 20): Promise<MessageSummary[]> {
    const data = await this.#client.execute<{ messages?: FetchedMessage[] }>(
      'GMAIL_FETCH_EMAILS', this.#accountId,
      { query, max_results: Math.min(Math.max(limit, 1), 50), user_id: 'me', include_payload: false },
    );
    return (data.messages ?? []).map((m) => ({
      id: String(m.messageId ?? m.id ?? ''),
      threadId: String(m.threadId ?? ''),
      from: String(m.from ?? m.sender ?? ''),
      subject: String(m.subject ?? m.preview?.subject ?? ''),
      snippet: String(m.snippet ?? m.preview?.body ?? m.messageText ?? '').slice(0, 500),
      date: m.internalDate !== undefined && m.internalDate !== null
        ? new Date(Number(m.internalDate)).toISOString()
        : String(m.date ?? ''),
    }));
  }

  async arrivedSince(since: Date, limit = 10): Promise<MessageText[]> {
    const data = await this.#client.execute<{ messages?: FetchedMessage[] }>(
      'GMAIL_FETCH_EMAILS', this.#accountId,
      {
        query: `after:${Math.floor(since.getTime() / 1000)}`, max_results: Math.min(Math.max(limit, 1), 20),
        user_id: 'me', include_payload: true, verbose: true,
      },
    );
    // The shape is not confirmed against the live service, so anything that is not a list of messages is no messages.
    const messages = Array.isArray(data.messages) ? data.messages.filter((m) => m !== null && typeof m === 'object') : [];
    return messages.map((m) => {
      const stamp = [m.internalDate, m.messageTimestamp, m.date].map(when).find((t) => t > 0) ?? NaN;
      const body = String(m.messageText ?? '') || mimeText(m.payload) || String(m.snippet ?? m.preview?.body ?? '');
      return {
        id: String(m.messageId ?? m.id ?? ''),
        from: String(m.from ?? m.sender ?? ''),
        subject: String(m.subject ?? m.preview?.subject ?? ''),
        // Composio hands some bodies over as HTML.
        text: (/<[a-z][\s\S]*>/i.test(body) ? htmlText(body) : body).slice(0, 20_000),
        at: new Date(Number.isNaN(stamp) ? 0 : stamp),
      };
    }).filter((m) => m.at.getTime() >= since.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  async createDraft(to: string, subject: string, body: string): Promise<{ id: string }> {
    // The same refusal as the direct client: a control character in To or
    // Subject would become a header of its own.
    assertHeaderSafe('To', to);
    assertHeaderSafe('Subject', subject);
    const data = await this.#client.execute<{ draft_id?: string; id?: string; draft?: { id?: string } }>(
      'GMAIL_CREATE_EMAIL_DRAFT', this.#accountId,
      { recipient_email: to, subject, body, is_html: false, user_id: 'me' },
    );
    return { id: String(data.draft_id ?? data.id ?? data.draft?.id ?? '') };
  }
}

interface RawEvent {
  id?: string; summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string }>;
}

export class ComposioCalendar implements CalendarReader {
  #client: ComposioClient;
  #accountId: string;
  constructor(client: ComposioClient, connectedAccountId: string) {
    this.#client = client;
    this.#accountId = connectedAccountId;
  }

  async events(from: Date, to: Date, calendarId = 'primary'): Promise<CalendarEvent[]> {
    const data = await this.#client.execute<{ items?: RawEvent[] }>(
      'GOOGLECALENDAR_EVENTS_LIST', this.#accountId,
      { calendarId, timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 50 },
    );
    return (data.items ?? []).map((e) => ({
      id: String(e.id ?? ''),
      summary: String(e.summary ?? '(no title)'),
      start: String(e.start?.dateTime ?? e.start?.date ?? ''),
      end: String(e.end?.dateTime ?? e.end?.date ?? ''),
      attendees: (e.attendees ?? []).map((a) => String(a.email ?? '')).filter(Boolean),
    }));
  }

  async freeSlots(
    from: Date, to: Date, minutes: number, workingHours: [number, number] = [9, 18],
  ): Promise<Array<{ start: Date; end: Date }>> {
    return computeFreeSlots(await this.events(from, to), from, to, minutes, workingHours);
  }
}

/**
 * Call each connected account for real.
 *
 * "ACTIVE" is Composio's word for the OAuth handshake having finished. It is
 * not evidence that Gmail answers for this account today — the same gap as a
 * scope list, and closed the same way: with the cheapest real read each API
 * has. Reported in the shape the direct connector uses, so the verifier and
 * the UI apply one rule to both providers.
 */
export async function checkComposioReachable(
  client: ComposioClient, accounts: ConnectedAccount[],
): Promise<Reachability> {
  const gmail = accounts.find((a) => a.toolkit === TOOLKITS.gmail && a.status === 'ACTIVE');
  const calendar = accounts.find((a) => a.toolkit === TOOLKITS.calendar && a.status === 'ACTIVE');

  const [g, c] = await Promise.all([
    gmail
      ? probe(() => client.execute<{ emailAddress?: string }>('GMAIL_GET_PROFILE', gmail.id, { user_id: 'me' })
          .then((r) => `answered for ${r.emailAddress ?? 'this account'}`))
      : Promise.resolve<ProbeResult>({ ok: false, skipped: true, detail: 'no Gmail account connected' }),
    calendar
      ? probe(() => client.execute<{ items?: unknown[] }>('GOOGLECALENDAR_LIST_CALENDARS', calendar.id, { max_results: 1 })
          .then((r) => `answered with ${r.items?.length ?? 0} calendar(s)`))
      : Promise.resolve<ProbeResult>({ ok: false, skipped: true, detail: 'no Calendar account connected' }),
  ]);
  return { gmail: g, calendar: c, checkedAt: new Date().toISOString() };
}

async function probe(run: () => Promise<string>): Promise<ProbeResult> {
  try {
    return { ok: true, detail: await run() };
  } catch (err) {
    // Composio's own message is kept: it usually names the fix.
    return { ok: false, detail: (err as Error).message };
  }
}
