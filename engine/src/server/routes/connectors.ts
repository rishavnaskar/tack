/**
 * Gmail and Calendar: what is connected, what the agent may do with it, and
 * starting consent. Composio is preferred when configured; a direct Google
 * OAuth client is the fallback.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context.ts';
import { readBody, sendJson } from '../http.ts';
import * as Bodies from '../bodies.ts';
import { GoogleAuth, plainReason, DEFAULT_SCOPES, DRAFTING_SCOPES, reachabilitySummary, type Reachability } from '../../connectors/google.ts';
import { availableTools } from '../../agent/tools.ts';
import { TOOLKITS, type ConnectedAccount, type ToolkitSlug } from '../../connectors/composio.ts';

/** One connected account per toolkit, with Composio's own status word. */
type AccountsByToolkit = Partial<Record<ToolkitSlug, { id: string; status: string }>>;

/** A consent started from the card: waiting on the person, or why it did not finish. */
interface ToolkitFlow { pending: boolean; error: string | null }

/**
 * The one status the card shows for the connection, worked out here so two
 * lines from different moments (a check that passed an hour ago, the
 * provider not answering now) never stand side by side.
 */
export type ConnectorState = 'not_configured' | 'down' | 'waiting' | 'not_connected' | 'no_token' | 'checking' | 'check_failed' | 'unchecked' | 'working' | 'refused';
export interface ConnectorStatus { state: ConnectorState; reason: string | null; at: string | null }

export class GoogleConnector {
  #ctx: RouteContext;
  #googleConnected = false;
  /** A sign-in the person has not finished yet, and why the last one failed. */
  #googlePending = false;
  #googleError: string | null = null;
  #googleUsable = false;
  #googleTools: string[] = [];
  #googleGranted: string[] = [];
  /** Last real API call, if one has been made. Never inferred from scopes. */
  #googleReachable: Reachability | null = null;
  /** Composio connected accounts, by toolkit, as of the last refresh. */
  #composioAccounts: AccountsByToolkit = {};
  /** Why Composio could not be asked for the accounts, so a failure does not read as "not connected". */
  #accountsError: string | null = null;
  #toolkits: Partial<Record<ToolkitSlug, ToolkitFlow>> = {};
  #checking = false;
  #checkError: string | null = null;
  /** When the last check failed, so a check that passed after it is not hidden by it, nor it by an older pass. */
  #checkErrorAt: string | null = null;
  /** The one check run by itself for a connection nobody has checked yet. */
  #autoChecked = false;

  constructor(ctx: RouteContext) {
    this.#ctx = ctx;
  }

  /** Answer a connector route. False means "not mine". */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/api/connectors/google/check' && req.method === 'POST') {
      try {
        const reachable = await this.check();
        sendJson(res, reachable ?? { error: 'not configured' });
      } catch {
        sendJson(res, { error: this.#checkError }, 502);
      }
      return true;
    }
    if (url.pathname === '/api/connectors/linkedin/import' && req.method === 'POST') {
      // Who they are on LinkedIn becomes proposed profile facts. Nothing is
      // confirmed here: the user checks each one on the Profile page.
      const tools = await this.#ctx.app.tools();
      if (!tools.linkedinProfile) {
        sendJson(res, { error: 'LinkedIn is not connected' }, 409);
        return true;
      }
      const read = await tools.linkedinProfile();
      if (!read.ok) {
        sendJson(res, { error: read.error ?? 'could not read the LinkedIn profile' }, 502);
        return true;
      }
      const detail = (read.detail ?? {}) as { name?: string | null; email?: string | null; url?: string | null };
      const proposed: Record<string, string> = {};
      const have = new Set(this.#ctx.app.profile.facts().filter((f) => f.confirmed).map((f) => f.field));
      if (detail.name && !have.has('name')) proposed.name = detail.name;
      if (detail.email && !have.has('email')) proposed.email = detail.email;
      if (detail.url && !have.has('linkedin')) proposed.linkedin = detail.url;
      if (Object.keys(proposed).length) this.#ctx.app.profile.set(proposed, { confirmed: false });
      this.#ctx.emit({ type: 'profile_changed' });
      sendJson(res, { proposed });
      return true;
    }
    if (url.pathname === '/api/connectors/google/start' && req.method === 'POST') {
      const body = await readBody(req, Bodies.ConnectorStart);
      await this.start(res, Boolean(body.allowDrafting), body.toolkit);
      return true;
    }
    return false;
  }

  /** What the UI shows about the connection. */
  view(): Record<string, unknown> {
    return {
      provider: this.#ctx.app.connectorProvider(),
      configured: this.#ctx.app.connectorProvider() !== null,
      // Composio only: one connected account per toolkit, with its
      // status straight from Composio. Refreshed with the rest of the
      // connector state.
      accounts: this.#composioAccounts,
      accountsError: this.#accountsError,
      toolkits: this.#toolkits,
      connected: this.#googleConnected,
      pending: this.#googlePending,
      error: this.#googleError,
      checking: this.#checking,
      checkError: this.#checkError,
      usableByTheAgent: this.#googleUsable,
      // What the agent can actually do, derived from the token rather
      // than from what was asked for at consent.
      actions: this.#googleTools,
      grantedScopes: this.#googleGranted,
      canDraft: this.#googleTools.includes('gmail_draft'),
      // Whether the APIs have actually answered. Null means nobody has
      // asked yet — which is NOT the same as working, and the UI says so
      // rather than presenting a scope list as a working connection.
      reachable: this.#googleReachable,
      // The one line the card shows; the fields above are its detail.
      status: this.status(),
      // The same rule the verifier gates on, computed in one place so a
      // green status and an open gate cannot disagree about the account.
      usable: this.#googleReachable ? reachabilitySummary(this.#googleReachable) : null,
      scopes: DEFAULT_SCOPES,
      // Stated because it is not obvious and matters: gmail.compose is
      // the narrowest scope for creating drafts and also permits sending.
      draftingAlsoPermitsSending: true,
    };
  }

  /**
   * Where the connection stands, in one word, with the reason and when it was
   * found. The provider not answering now outranks anything checked before
   * it; a check that failed after one that passed outranks the pass.
   */
  status(): ConnectorStatus {
    const at = new Date().toISOString();
    if (this.#ctx.app.connectorProvider() === null) return { state: 'not_configured', reason: null, at: null };
    if (this.#accountsError) return { state: 'down', reason: this.#accountsError, at };
    if (!this.#googleUsable) {
      if (this.#googlePending) return { state: 'waiting', reason: null, at: null };
      return { state: this.#googleConnected ? 'no_token' : 'not_connected', reason: this.#googleError, at: null };
    }
    if (this.#checking) return { state: 'checking', reason: null, at: null };
    const r = this.#googleReachable;
    if (this.#checkError && (!r || (this.#checkErrorAt ?? '') >= r.checkedAt)) return { state: 'check_failed', reason: this.#checkError, at: this.#checkErrorAt };
    if (!r) return { state: 'unchecked', reason: null, at: null };
    const summary = reachabilitySummary(r);
    return { state: summary.usable ? 'working' : 'refused', reason: summary.why, at: r.checkedAt };
  }

  /** Refreshed alongside state so the UI can say whether the agent can use it. */
  async refresh(): Promise<void> {
    if (this.#ctx.app.connectorProvider() === 'composio') {
      let accounts: ConnectedAccount[];
      try {
        accounts = await this.#ctx.app.composioAccounts();
        this.#accountsError = null;
      } catch (err) {
        // What was known before stands; the card says Composio did not answer.
        this.#accountsError = plainReason(err);
        throw err;
      }
      const byToolkit: AccountsByToolkit = {};
      for (const a of accounts) {
        // Newest first from the client; the first seen per toolkit wins.
        if (!byToolkit[a.toolkit]) byToolkit[a.toolkit] = { id: a.id, status: a.status };
      }
      this.#composioAccounts = byToolkit;
      this.#googleConnected = accounts.some((a) => a.status === 'ACTIVE' && a.toolkit !== TOOLKITS.linkedin);
    }
    const tools = await this.#ctx.app.tools();
    this.#googleTools = availableTools(tools);
    this.#googleGranted = await this.#ctx.app.googleScopes();
    this.#googleUsable = this.#googleTools.length > 0;
    if (this.#googleUsable) this.#googleConnected = true;
    // A connection made before this start has never been called: call it once, so the card says whether it works.
    if (this.#googleUsable && !this.#googleReachable && !this.#autoChecked && !this.#checking) {
      this.#autoChecked = true;
      const done = (): void => this.#ctx.emit({ type: 'connector_checked', connector: 'google' });
      void this.check().then(done, done);
    }
  }

  /** Call Google for real and keep the outcome, a failure included, for the card to show. */
  async check(): Promise<Reachability | null> {
    this.#checking = true;
    try {
      this.#googleReachable = await this.#ctx.app.checkGoogle();
      this.#checkError = null;
      this.#checkErrorAt = null;
      return this.#googleReachable;
    } catch (err) {
      this.#checkError = plainReason(err);
      this.#checkErrorAt = new Date().toISOString();
      this.#ctx.log.warn('could not check the Google connection', { reason: this.#checkError });
      throw err;
    } finally {
      this.#checking = false;
    }
  }

  async start(res: ServerResponse, allowDrafting: boolean, toolkit?: string): Promise<void> {
    if (this.#ctx.app.connectorProvider() === 'composio') return this.#composioStart(res, toolkit);

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return sendJson(res, {
        error: 'Google is not configured. Create an OAuth client of type "Desktop app" in Google Cloud ' +
          'and set GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET) in .env, then restart.',
      }, 400);
    }
    const auth = new GoogleAuth(
      { clientId, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
      this.#ctx.app.secrets,
    );
    /*
     * Two things finish at different times, and they are kept apart.
     *
     * The HTTP response carries the consent URL and can be sent as soon as
     * there is one. The authorisation itself finishes minutes later, when the
     * person approves it, declines it, or walks away — and whichever of those
     * happens has to reach them.
     *
     * Funnelled through one promise resolved by the URL callback, a DECLINED
     * consent would call reject() on a promise that had already settled: a
     * no-op. No connector_error would go out, and the UI would sit there as
     * though the flow were still in progress. Declining is the most ordinary
     * thing a person can do on that screen.
     */
    let responded = false;
    this.#googleError = null;
    const sendConsentUrl = (consentUrl: string): void => {
      responded = true;
      this.#googlePending = true;
      sendJson(res, { consentUrl });
    };

    const flow = auth
      // Reading by default. Drafting is asked for only when the user turns it
      // on, because the scope that creates drafts also permits sending — so
      // the common case holds a token that cannot send.
      .authorize(allowDrafting ? DRAFTING_SCOPES : DEFAULT_SCOPES, sendConsentUrl)
      .then(async () => {
        this.#googlePending = false;
        this.#googleConnected = true;
        // Prove it works now, while the person is still here to fix it. A
        // connector that consents cleanly and then 403s on the first real
        // task is the worst time to find out the API was never enabled in
        // the Cloud project.
        await this.check().catch(() => null);
        this.#ctx.emit({ type: 'connector_connected', connector: 'google' });
      })
      .catch((err: Error) => {
        // Reaches the user either way: as an event if they already have the
        // consent URL, as an HTTP error if the flow died before there was
        // one to give them.
        this.#googlePending = false;
        this.#googleError = plainReason(err);
        this.#ctx.log.warn('Google sign-in failed', { reason: err.message });
        if (responded) {
          this.#ctx.emit({ type: 'connector_error', connector: 'google', message: this.#googleError });
        } else {
          sendJson(res, { error: `could not start Google sign-in: ${err.message}` }, 502);
          responded = true;
        }
      });

    // Return once the URL is out, or once the flow has failed without one.
    // Not awaiting the whole flow: that would hold the request open for as
    // long as the person takes to decide, which can be minutes.
    await Promise.race([
      new Promise<void>((resolve) => {
        const poll = setInterval(() => { if (responded) { clearInterval(poll); resolve(); } }, 10);
        poll.unref?.();
      }),
      flow,
    ]);
  }

  /**
   * Consent through Composio, one toolkit at a time.
   *
   * Composio's redirect lands on its own page rather than back here, so the
   * outcome is learned by asking: the account is polled until ACTIVE, or
   * until it ends as FAILED/EXPIRED, or until five minutes pass. Whichever
   * happens is emitted, because a person who declined must not be left with
   * a UI that looks like it is still waiting. The HTTP response goes out as
   * soon as there is a link to give them.
   */
  async #composioStart(res: ServerResponse, toolkit?: string): Promise<void> {
    const slug = (toolkit === TOOLKITS.calendar ? TOOLKITS.calendar
      : toolkit === TOOLKITS.linkedin ? TOOLKITS.linkedin : TOOLKITS.gmail) as ToolkitSlug;
    // Kept per toolkit, like the direct flow's pending and error, so the card shows where each one stands.
    const flow: ToolkitFlow = { pending: false, error: null };
    this.#toolkits[slug] = flow;
    let started: { redirectUrl: string; connectedAccountId: string };
    try {
      started = await this.#ctx.app.startComposioConnection(slug);
    } catch (err) {
      flow.error = plainReason(err);
      return sendJson(res, { error: `could not start ${slug} sign-in through Composio: ${(err as Error).message}` }, 502);
    }
    flow.pending = true;
    sendJson(res, { consentUrl: started.redirectUrl, toolkit: slug, connectedAccountId: started.connectedAccountId });

    void this.#ctx.app.composio!.waitUntilActive(started.connectedAccountId)
      .then(async () => {
        flow.pending = false;
        await this.refresh().catch(() => {});
        // Prove it works now, while the person is still here to fix it.
        if (slug !== TOOLKITS.linkedin) await this.check().catch(() => null);
        this.#ctx.emit({ type: 'connector_connected', connector: 'google', toolkit: slug });
      })
      .catch((err: Error) => {
        flow.pending = false;
        flow.error = plainReason(err);
        this.#ctx.emit({ type: 'connector_error', connector: 'google', toolkit: slug, message: err.message });
      });
  }
}
