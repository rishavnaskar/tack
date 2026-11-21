/**
 * Local HTTP API and chat UI host.
 *
 * Binds loopback only and requires a token on every request. This process can
 * drive a browser that is signed into the user's accounts, so it is not
 * something to expose on a routable interface, and the bind address is not a
 * configuration option.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { markOwnOrigin, unmarkOwnOrigin } from '../policy/navigable.ts';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeBudget, within, type App } from '../app.ts';
import { runTask, type AgentEvent, type RunResult } from '../agent/loop.ts';
import { resolveContinuation, titleFrom, type ConversationTurn } from '../agent/conversation.ts';
import { writeReport } from '../agent/report.ts';
import { performApproved } from '../agent/approvals.ts';
import { anotherAlive } from './instance.ts';
import type { Logger } from '../lib/log.ts';
import { HttpError, readBody, sendJson } from './http.ts';
import * as Bodies from './bodies.ts';
import type { RouteContext } from './routes/context.ts';
import { handleJobRoutes, workersWithCounts, settingsView, attentionView, questionGroups, todayCounts, workedOut, judged } from './routes/jobs.ts';
import { handleAnswerRoutes } from './routes/answers.ts';
import { handleSiteProfileRoutes } from './routes/site-profiles.ts';
import { GoogleConnector } from './routes/connectors.ts';
import { handleDocumentRoutes } from './routes/documents.ts';
import { handleRunRoutes } from './routes/runs.ts';
import { handleCapabilityRoutes } from './routes/capabilities.ts';
import { ApplicationActions } from './routes/applications.ts';
import { spendToday, unfinishedView, withSuggestions } from './state.ts';
import { UNTITLED_CONVERSATION } from '../store/db.ts';
import { serveBrand, serveFont, serveLocked, serveOpened, serveUi } from './static.ts';
import { health } from './health.ts';
import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { createFanfoldMcp, type FanfoldMcp, type FanfoldMcpOptions } from '../mcp/fanfold.ts';
import { catalogue } from '../jobs/site-policies.ts';
import { setupState, SNOOZE_SETTING, type SetupState } from '../jobs/setup.ts';
import { codeAskApplication } from '../mcp/code-ask.ts';
import { McpHttp } from '../mcp/http.ts';
import { handleConnectRoutes } from './routes/connect.ts';
import { handleModelRoutes } from './routes/model.ts';
import { authSummary, handleAuthRoutes, type AuthDeps } from './routes/auth.ts';
import { FIREBASE, type AuthOptions } from '../auth/config.ts';
import { TokenVerifier } from '../auth/verify.ts';
import { isSignedIn } from '../auth/account.ts';
import { access, accessView, LOCKED_STATUS, refusal, type Access } from '../auth/access.ts';
import { verdict } from './gate.ts';
import { connectView } from './routes/connect.ts';
import { modelView } from './routes/model.ts';
import { sitesView } from './routes/site-profiles.ts';
import { profileView } from './routes/jobs.ts';
import { APPLICATION_STATUSES } from '../jobs/jobs.ts';
import { countryChoices } from '../jobs/work-rights.ts';

export interface ApiOptions {
  app: App;
  token?: string;
  /** Settings for the tools offered to other agents over MCP. */
  mcp?: Pick<FanfoldMcpOptions, 'approvalsVia' | 'openSandbox' | 'fetchImpl'> & {
    /** Open the review queue in the user's browser when a host's action needs them. */
    openReviewOnApproval?: boolean;
  };
  /**
   * A file to keep a link to Review in, for a person with no other way to it.
   * It is the key-free link, which only makes Fanfold open Review in the
   * person's own browser: the file sits on disk where other programs can read it.
   */
  reviewLinkFile?: string;
  /** How a page is put in front of the person. The system's own opener by default. */
  openUrl?: (url: string) => void;
  /** What checks a Gemini key with Google. The real fetch by default; tests never reach Google. */
  modelFetch?: typeof fetch;
  /** Signing in to Fanfold. Off when absent: only the entry points turn it on. */
  auth?: AuthOptions;
}

interface Client {
  id: string;
  res: ServerResponse;
}

/** What the page still hears while Fanfold is locked: that something changed, with nothing of the person's in it. */
const LOCKED_EVENTS: ReadonlySet<string> = new Set([
  'access_changed', 'auth_changed', 'setup_changed', 'profile_changed',
  'browser_started', 'browser_closed', 'browser_mode', 'extension_changed',
]);

/** What the person reads. */
const COPY = {
  leftOpen: 'Still running when Fanfold last closed, and stopped when it reopened.',
};

/** Put a page in front of the person with the system's own opener. */
function openWithSystem(target: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin' ? ['/usr/bin/open', [target]]
    : ['xdg-open', [target]];
  execFile(command, args, () => { /* the queue is still there if this fails */ });
}

/** Why a reject came too late, in the words the person reads. */
/** Every status counted, and none of them anything. */
function emptyFunnel(): Record<string, number> {
  return { ...Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])), total: 0 };
}

function tooLateToReject(status: string): string {
  if (status === 'consumed') return 'It was already sent, so it cannot be rejected now.';
  if (status === 'performing') return 'It is being sent right now, so it cannot be rejected.';
  if (status === 'approved') return 'It was already approved.';
  return 'It is no longer waiting: it expired or its window was closed, and nothing was sent.';
}

export class ApiServer {
  #app: App;
  #server: Server | null = null;
  #token: string;
  #agentToken: string;
  readonly #reviewLinkFile: string | null;
  #clients = new Map<string, Client>();
  #activeRun: { runId: string; goal: string; abort: AbortController } | null = null;
  /**
   * The thread the user is in. One at a time, because there is one person and
   * one chat box; the database holds as many as they like.
   */
  #conversationId: string | null = null;
  /** The thread the run going on now belongs to, which another tab may not be showing. */
  #runConversationId: string | null = null;
  /** Why the browser is not up, when it was tried and would not start. */
  #browserError: string | null = null;

  #log: Logger;
  #ctx: RouteContext;
  #google: GoogleConnector;
  /** The same capabilities as tools, for an agent that brings its own model. */
  readonly mcp: FanfoldMcp;
  #mcpHttp: McpHttp;
  #reviewShownAt = 0;
  /** When each key-free link last opened its page. */
  readonly #linkOpenedAt = new Map<string, number>();
  readonly #applications: ApplicationActions;
  readonly #openUrl: (url: string) => void;
  readonly #modelFetch: typeof fetch;
  readonly #auth: AuthDeps;
  #unsubscribe: () => void;

  constructor(opts: ApiOptions) {
    this.#app = opts.app;
    this.#log = opts.app.log.child({ component: 'api' });
    this.#ctx = { app: this.#app, emit: (e) => this.#emit(e), log: this.#log };
    this.#google = new GoogleConnector(this.#ctx);
    this.#applications = new ApplicationActions(this.#ctx);
    this.#token = opts.token ?? randomUUID().replace(/-/g, '');
    this.#agentToken = randomUUID().replace(/-/g, '');
    this.#reviewLinkFile = opts.reviewLinkFile ?? null;
    this.#modelFetch = opts.modelFetch ?? fetch;
    const firebase = opts.auth?.firebase ?? FIREBASE;
    this.#auth = {
      enabled: opts.auth?.enabled === true, firebase,
      verifier: new TokenVerifier({ projectId: firebase.projectId, fetchImpl: opts.auth?.fetchImpl, now: opts.auth?.now }),
    };
    this.#openUrl = opts.openUrl ?? openWithSystem;
    // Signed out is locked only where sign-in is on.
    this.#app.signInRequired = this.#auth.enabled;
    this.mcp = createFanfoldMcp({
      app: this.#app, log: this.#log,
      emit: (e) => this.#emit(e as { type: string }),
      showReview: opts.mcp?.openReviewOnApproval ? () => this.#showReview() : undefined,
      reviewLink: () => (this.address ? `http://127.0.0.1:${this.address.port}/review` : null),
      setupLink: () => this.#setupLink(),
      signedOut: () => this.#auth.enabled && !isSignedIn(this.#app.store),
      signinLink: () => (this.address ? `http://127.0.0.1:${this.address.port}/signin` : null),
      approvalsVia: opts.mcp?.approvalsVia, openSandbox: opts.mcp?.openSandbox, fetchImpl: opts.mcp?.fetchImpl,
    });
    this.#mcpHttp = new McpHttp(this.mcp.server);
    // Worker runs and submissions happen outside any request; this is how the page hears of them.
    this.#unsubscribe = this.#app.onEvent((e) => {
      // The chat works in the main page, and only this server holds its stop: the user stopping Fanfold there stops it.
      if (e.type === 'tab_stopped' && (e.owner as { kind?: string } | undefined)?.kind === 'main') this.#activeRun?.abort.abort();
      // Locked (signed out, or the name and email taken away): the chat's task stops too.
      if (e.type === 'access_changed' && e.locked === true) this.#activeRun?.abort.abort();
      this.#emit(e);
    });
  }

  get token(): string {
    return this.#token;
  }

  /**
   * The key an outside agent gets. It reaches /mcp and nothing else, so the
   * agent that asked for an approval can never give it, change a site's
   * rules, or read the person's data through the app's own API.
   */
  get agentToken(): string {
    return this.#agentToken;
  }

  /** Where this server is actually listening. Loopback, by construction. */
  get address(): { address: string; port: number } | null {
    const addr = this.#server?.address();
    if (!addr || typeof addr === 'string') return null;
    return { address: addr.address, port: addr.port };
  }

  async listen(port = 0): Promise<{ url: string; port: number }> {
    // A request that throws past its handler answers 500; it must never end the process.
    this.#server = createServer((req, res) => void this.#handle(req, res).catch((err: unknown) => {
      this.#log.error('a request failed outside its handler', { err, path: req.url?.split('?')[0] });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(port, '127.0.0.1', resolve);
    });
    const addr = this.#server!.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no address');
    markOwnOrigin(addr.port);
    // The rule that expires a previous start's approvals: with no other Fanfold alive, nothing owns its runs either.
    if (!(await anotherAlive())) this.#closeLeftovers();
    await this.#writeReviewLink(addr.port);
    return { url: `http://127.0.0.1:${addr.port}/?t=${this.#token}`, port: addr.port };
  }

  /**
   * The key-free Review link, for the person to open. Nothing that reads the
   * file can trade it for the key: following it only makes Fanfold open
   * Review in the person's own browser.
   */
  async #writeReviewLink(port: number): Promise<void> {
    if (!this.#reviewLinkFile) return;
    await writeFile(this.#reviewLinkFile, `http://127.0.0.1:${port}/review\n`, { mode: 0o600 }).catch(() => {});
    await chmod(this.#reviewLinkFile, 0o600).catch(() => {});
  }

  /** Close what a previous start left running. Actions it attempted stay listed until the owner says whether they went. */
  #closeLeftovers(): void {
    const runs = this.#app.tidyStaleRuns(this.#activeRun?.runId ?? null);
    const live = new Set(this.#app.activeWorkerRuns().map((r) => r.workerRunId));
    let workerRuns = 0;
    for (const r of this.#app.workers.staleRuns()) {
      if (live.has(String(r.id))) continue;
      this.#app.workers.closeRun(String(r.id), 'failed', COPY.leftOpen, (r.run_id as string | null) ?? undefined, (r.cost_usd as number | null) ?? undefined);
      workerRuns++;
    }
    const claims = this.#app.lapseLeftClaims();
    if (claims) this.#log.info('let go of claims a previous start held on queued jobs', { claims });
    if (runs || workerRuns) {
      this.#log.info('closed runs a previous start left open', { runs, workerRuns });
      this.#emit({ type: 'runs_tidied', closed: runs + workerRuns });
    }
  }

  /** `by`: when closing the agents' sessions must give up, as a browser that stopped answering would hold it for ever. */
  async close(by = Date.now() + closeBudget.politeMs): Promise<void> {
    const port = this.address?.port;
    if (port) unmarkOwnOrigin(port);
    this.#unsubscribe();
    this.#mcpHttp.close();
    await within(by - Date.now(), this.mcp.close());
    for (const c of this.#clients.values()) c.res.end();
    this.#clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
      // close() waits for every connection to end by itself, and a browser
      // or a client that never read its last answer keeps one open for as
      // long as it likes. Shutting down must not depend on them.
      this.#server.closeAllConnections();
    });
  }

  /** Bring the review queue to the person. Rate-limited: one window, not one per approval. */
  #showReview(): void {
    const address = this.address;
    if (!address || Date.now() - this.#reviewShownAt < 60_000) return;
    this.#reviewShownAt = Date.now();
    this.#openUrl(`http://127.0.0.1:${address.port}/?t=${this.#token}#review`);
  }

  /**
   * The Review, Setup or sign-in link was followed. The page is opened from
   * here, so the link holds no key and nothing in the answer does either:
   * whoever fetches it gets a tab opened on this computer and a page saying so.
   */
  #openFromLink(req: IncomingMessage, res: ServerResponse, page: 'review' | 'setup' | 'signin'): void {
    // A link clicked in a terminal or typed in arrives with no site of its own; a web page's request does not.
    const from = String(req.headers['sec-fetch-site'] ?? 'none');
    if (from !== 'none' && from !== 'same-origin') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('open this link yourself; a web page cannot');
      return;
    }
    const address = this.address;
    // Followed again straight after, the page already opened is the one to use: the answer says so rather than claiming a new tab.
    const now = !!address && Date.now() - (this.#linkOpenedAt.get(page) ?? 0) >= 5_000;
    if (address && now) {
      this.#linkOpenedAt.set(page, Date.now());
      // Sign-in from a host's link ends by sending the person back to it.
      this.#openUrl(`http://127.0.0.1:${address.port}/?t=${this.#token}#${page === 'signin' ? 'welcome/claude' : page}`);
    }
    serveOpened(res, page, now);
  }

  /** The key-free link that opens setup, for a host to give the person. */
  #setupLink(): string | null {
    return this.address ? `http://127.0.0.1:${this.address.port}/setup` : null;
  }

  /** Where the person is with setup, with the link that opens it. */
  #setup(): SetupState {
    const state = setupState({
      profile: this.#app.profile, memory: this.#app.memory, modelConfigured: this.#app.modelConfigured,
      snoozedUntil: this.#app.store.setting<string | null>(SNOOZE_SETTING, null),
    });
    return { ...state, link: this.#setupLink() };
  }

  #caller(req: IncomingMessage, url: URL): 'owner' | 'agent' | null {
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const provided = url.searchParams.get('t') ?? req.headers['x-agent-token'] ?? bearer;
    if (typeof provided !== 'string') return null;
    // Digests, not the strings: equal in length whatever was sent, so a key
    // in another script cannot make the comparison throw and end the process.
    const digest = (v: string): Buffer => createHash('sha256').update(v).digest();
    const same = (key: string): boolean => timingSafeEqual(digest(provided), digest(key));
    if (same(this.#token)) return 'owner';
    return same(this.#agentToken) ? 'agent' : null;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // A web page that points its own hostname at 127.0.0.1 reaches this port
    // with its name in Host. Only the loopback names this server listens as count.
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden host');
      return;
    }

    // Before the token check, and only this. A stylesheet cannot carry the
    // token into a url() request, and an OFL font file is not a secret: it
    // reveals nothing about the user, their accounts or this process. The
    // allow-list above is what keeps that true.
    if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
      return await serveFont(res, url.pathname.slice('/fonts/'.length));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/brand/')) {
      return await serveBrand(res, url.pathname.slice('/brand/'.length));
    }
    // Browsers ask for these at the root without being told to.
    if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg')) {
      return await serveBrand(res, url.pathname.slice(1));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const { code, body } = health(
        { started: this.#app.browserStarted, failed: this.#browserError !== null },
        process.uptime(),
      );
      return sendJson(res, body, code);
    }

    if (req.method === 'GET' && url.pathname === '/review') return this.#openFromLink(req, res, 'review');
    if (req.method === 'GET' && url.pathname === '/setup') return this.#openFromLink(req, res, 'setup');
    if (req.method === 'GET' && url.pathname === '/signin') return this.#openFromLink(req, res, 'signin');

    const caller = this.#caller(req, url);
    if (!caller) {
      // A person's browser, at any address of the app's: the page that says where the link is, or that this one's key is old.
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/mcp' && (req.headers.accept ?? '').includes('text/html')) {
        return serveLocked(res, { expired: url.searchParams.has('t') });
      }
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    if (caller === 'agent' && url.pathname !== '/mcp') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('an agent key only reaches /mcp');
      return;
    }
    // A form on another site posting here with a stolen link must not change
    // anything: the browser says where a request came from, and a plain form
    // cannot send JSON.
    if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname.startsWith('/api/')) {
      const site = String(req.headers['sec-fetch-site'] ?? '');
      const type = String(req.headers['content-type'] ?? '');
      if ((site && site !== 'same-origin' && site !== 'none') || (type && !/^application\/json\b/i.test(type))) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('cross-site request refused');
        return;
      }
    }

    try {
      if (url.pathname === '/mcp') {
        // A page in a browser must not be able to drive this, token or not.
        const origin = req.headers.origin;
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden origin');
          return;
        }
        return await this.#mcpHttp.handle(req, res);
      }
      // Locked: one check for every route, by its group (gate.ts). Anything not listed there is refused.
      const now = access(this.#app);
      const gate = verdict(now, req.method, url);
      if (gate === 'refuse') return sendJson(res, refusal(now), LOCKED_STATUS);
      if (gate === 'state') return sendJson(res, this.#lockedState(now));
      if (gate === 'empty') return sendJson(res, await this.#lockedAnswer(url, now));
      if (url.pathname === '/' && req.method === 'GET') return await serveUi(res);
      if (url.pathname === '/api/stream' && req.method === 'GET') return this.#stream(res);
      if (url.pathname === '/api/state' && req.method === 'GET') {
        // A connector that is down must not take the whole state with it.
        await this.#google.refresh().catch((err: unknown) => this.#log.warn('could not refresh the connected accounts', { err }));
        // Each tab names the thread it shows; the server's own choice is only for a tab that shows none yet.
        return sendJson(res, await this.#state(url.searchParams.get('conversation')));
      }
      if (url.pathname === '/api/task' && req.method === 'POST') return await this.#startTask(req, res);
      if (url.pathname === '/api/conversations' && req.method === 'POST') return this.#newConversation(res);
      if (url.pathname === '/api/conversations' && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim();
        return sendJson(res, { conversations: q ? this.#app.store.searchConversations(q) : this.#app.store.conversations(80) });
      }
      const conv = url.pathname.match(/^\/api\/conversations\/([\w-]+)$/);
      if (conv && req.method === 'GET') return this.#openConversation(res, conv[1]);
      if (conv && req.method === 'PATCH') {
        const body = await readBody(req, Bodies.RenameConversation);
        const ok = this.#app.store.renameConversation(conv[1], body.title ?? '');
        if (!ok) return sendJson(res, { error: 'Give it a title.' }, 400);
        this.#emit({ type: 'conversation_changed', conversationId: conv[1] });
        return sendJson(res, { ok: true });
      }
      if (conv && req.method === 'DELETE') {
        if (this.#activeRun && this.#runConversationId === conv[1]) {
          return sendJson(res, { error: 'A task is still running in this conversation. Stop it or let it finish, then delete it.' }, 409);
        }
        const ok = this.#app.store.deleteConversation(conv[1]);
        if (!ok) return sendJson(res, { error: 'That conversation is already gone.' }, 404);
        if (this.#conversationId === conv[1]) this.#conversationId = null;
        this.#emit({ type: 'conversation_changed', conversationId: null });
        return sendJson(res, { deleted: true });
      }
      if (url.pathname === '/api/cancel' && req.method === 'POST') return this.#cancel(res);
      if (url.pathname === '/api/runs/abandon-stale' && req.method === 'POST') {
        const closed = this.#app.tidyStaleRuns(this.#activeRun?.runId ?? null);
        this.#emit({ type: 'runs_tidied', closed });
        return sendJson(res, { closed });
      }

      const approve = url.pathname.match(/^\/api\/approvals\/([\w-]+)\/(approve|reject)$/);
      if (approve && req.method === 'POST') return await this.#answerApproval(req, res, approve[1], approve[2] as 'approve' | 'reject');

      if (await handleRunRoutes(this.#ctx, req, res, url)) return;
      if (await handleDocumentRoutes(this.#ctx, req, res, url)) return;
      if (await handleCapabilityRoutes(this.#ctx, req, res, url)) return;
      if (await this.#applications.handle(req, res, url)) return;
      if (await handleJobRoutes(this.#ctx, req, res, url)) return;
      if (await handleAnswerRoutes(this.#ctx, req, res, url)) return;
      if (await handleSiteProfileRoutes(this.#ctx, req, res, url)) return;
      if (await handleConnectRoutes(this.#ctx, req, res, url, { mcp: this.mcp, port: () => this.address?.port ?? null, agentToken: this.#agentToken })) return;
      if (await handleModelRoutes(this.#ctx, req, res, url, this.#modelFetch)) return;
      if (await handleAuthRoutes(this.#ctx, req, res, url, this.#auth)) return;

      if (url.pathname === '/api/setup' && req.method === 'GET') return sendJson(res, this.#setup());
      if (url.pathname === '/api/setup/snooze' && req.method === 'POST') {
        const body = await readBody(req, Bodies.SetupSnooze);
        const hours = Math.min(168, Math.max(1, body.hours ?? 24));
        this.#app.store.setSetting(SNOOZE_SETTING, new Date(Date.now() + hours * 3_600_000).toISOString());
        this.#emit({ type: 'setup_changed' });
        return sendJson(res, this.#setup());
      }
      if (await this.#google.handle(req, res, url)) return;

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      if (err instanceof HttpError) {
        // Close after answering: the client may still be mid-write.
        res.writeHead(err.status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      this.#log.error('request failed', { method: req.method, path: url.pathname, err });
      sendJson(res, { error: (err as Error).message }, 500);
    }
  }

  async #state(asked: string | null = null): Promise<Record<string, unknown>> {
    const runs = this.#app.store.raw
      // tool_calls: counted as the chat counts them under an answer, so the two never disagree.
      .prepare(`SELECT id, goal, status, started_at, ended_at, steps, cost_usd, result, error, conversation_id,
        (SELECT COUNT(*) FROM steps s WHERE s.run_id = runs.id AND s.action IS NOT NULL AND json_valid(s.action)
          AND COALESCE(json_extract(s.action, '$.kind'), '') NOT IN ('done', 'ask_user', '')) AS tool_calls
        FROM runs ORDER BY started_at DESC LIMIT 20`)
      .all();
    // The thread the UI should be showing. Sent with every state refresh so
    // a reloaded page comes back to the conversation rather than to an empty
    // log, with no transcript held only in the browser's scrollback.
    const shown = asked ? this.#app.store.conversation(asked) : undefined;
    const current = shown
      ?? (this.#conversationId ? this.#app.store.conversation(this.#conversationId) : undefined)
      ?? this.#app.store.latestConversation();
    const conversation = current
      ? {
          id: String(current.id),
          title: String(current.title),
          goal: current.goal ?? null,
          messages: this.#app.store.thread(String(current.id), 200),
          objectives: this.#collections(String(current.id)),
        }
      : null;
    // A tab that asked for its own thread leaves the others where they are.
    if (conversation && !shown) this.#conversationId = conversation.id;
    const open = this.#app.questions.list('open', 500);
    const { groups, places } = questionGroups(this.#ctx, open);
    const { signedUp, complete, required, missing, snoozedUntil } = this.#setup();

    return {
      browserStarted: this.#app.browserStarted,
      browserError: this.#browserError,
      approvalGate: [...this.#app.approvalGate],
      activeRun: this.#activeRun ? { runId: this.#activeRun.runId, goal: this.#activeRun.goal, conversationId: this.#runConversationId } : null,
      conversation,
      conversations: this.#app.store.conversations(80),
      approvals: this.#app.approvals.pending(),
      workers: workersWithCounts(this.#ctx),
      proposals: conversation ? this.#app.workers.proposedIn(conversation.id) : [],
      today: this.#app.jobs.today(),
      todayCounts: todayCounts(this.#ctx),
      attention: attentionView(this.#ctx, groups),
      spend: spendToday(this.#ctx),
      funnel: this.#app.jobs.funnel(),
      review: judged(this.#ctx, this.#app.jobs.list({ status: ['needs_review', 'prepared', 'queued', 'unconfirmed'], limit: 50 })),
      questions: {
        open: await withSuggestions(this.#ctx, open, places),
        declined: this.#app.questions.list('declined'),
        groups,
        workedOut: workedOut(this.#ctx),
      },
      fills: this.#applications.fills(),
      profile: this.#app.profile.completeness(),
      setup: { signedUp, complete, required, missing, snoozedUntil },
      auth: authSummary(this.#ctx, this.#auth),
      settings: settingsView(this.#ctx),
      sites: this.#app.sites.list(),
      runs,
      unfinished: unfinishedView(this.#ctx),
      spendUsd: this.#app.model.totalCostUsd(),
      modelConfigured: this.#app.modelConfigured,
      headless: this.#app.headless,
      modelRefused: this.#app.model.refusal?.message ?? null,
      answerModelProblem: this.#app.answerModelProblem,
      schedulerOn: this.#app.scheduler?.isRunning ?? false,
      learningOn: Boolean(this.#app.scheduler?.isRunning),
      // Each says whose name it carries when it is somebody else's, as the Profile page shows it.
      documents: this.#app.memory.listDocuments({ includeHeld: true }).map((d) => ({ ...d, otherName: this.#app.owners.otherName(d.id) })),
      capabilities: this.#app.capabilities.list(),
      lessons: {
        active: this.#app.memory.lessonsByStatus('active').length,
        proposed: this.#app.memory.lessonsByStatus('proposed').length,
        unproven: this.#app.memory.lessonsByStatus('unproven').length,
        rejected: this.#app.memory.lessonsByStatus('rejected').length,
      },
      connectors: { google: this.#google.view() },
      access: accessView(access(this.#app)),
    };
  }

  /**
   * The app state while Fanfold is locked: every part the page reads, in its
   * usual shape, holding nothing of the person's. What says how Fanfold itself
   * is set up stays, and a signed-in person's setup says where it stands.
   */
  #lockedState(now: Access): Record<string, unknown> {
    const setup = this.#lockedSetup(now);
    const google = this.#google.view();
    const configured = google.configured === true;
    return {
      browserStarted: this.#app.browserStarted,
      browserError: this.#browserError,
      approvalGate: [...this.#app.approvalGate],
      activeRun: null,
      conversation: null,
      conversations: [],
      approvals: [],
      workers: [],
      proposals: [],
      today: { applied: 0, review: 0, skipped: 0, unconfirmed: 0 },
      todayCounts: { applied: 0, skipped: 0 },
      attention: { questions: 0, approvals: 0, applications: 0, submitting: 0, started: 0, files: 0, unconfirmedActions: 0, total: 0 },
      spend: { todayUsd: null, unknown: false },
      funnel: emptyFunnel(),
      review: [],
      questions: { open: [], declined: [], groups: [], workedOut: [] },
      fills: {},
      profile: { filled: 0, total: this.#app.profile.completeness().total },
      setup: { signedUp: setup.signedUp, complete: setup.complete, required: setup.required, missing: setup.missing, snoozedUntil: setup.snoozedUntil },
      auth: authSummary(this.#ctx, this.#auth),
      settings: settingsView(this.#ctx),
      sites: [],
      runs: [],
      unfinished: { staleRuns: 0, staleWorkerRuns: 0, unsettledEffects: [] },
      spendUsd: 0,
      modelConfigured: this.#app.modelConfigured,
      headless: this.#app.headless,
      modelRefused: this.#app.model.refusal?.message ?? null,
      answerModelProblem: this.#app.answerModelProblem,
      schedulerOn: this.#app.scheduler?.isRunning ?? false,
      learningOn: Boolean(this.#app.scheduler?.isRunning),
      documents: [],
      capabilities: [],
      lessons: { active: 0, proposed: 0, unproven: 0, rejected: 0 },
      connectors: {
        google: {
          ...google, accounts: [], accountsError: null, toolkits: [], connected: false, pending: false, error: null,
          checking: false, checkError: null, usableByTheAgent: false, actions: [], grantedScopes: [], canDraft: false,
          reachable: null, usable: null, status: { state: configured ? 'not_connected' : 'not_configured', reason: null, at: null },
        },
      },
      access: accessView(now),
    };
  }

  /** Setup while locked: a signed-in person's own, as setup shows it; signed out, every item still to do. */
  #lockedSetup(now: Access): SetupState {
    const setup = this.#setup();
    if (now.reason === 'no-name-email') return setup;
    const items = setup.items.map((i) => ({ ...i, done: false, value: null, unconfirmed: false }));
    const required = items.filter((i) => i.required);
    return {
      ...setup, items, signedUp: false, complete: false, resume: null, snoozedUntil: null,
      required: { done: 0, total: required.length }, missing: required.map((i) => i.label),
    };
  }

  /** A read of the person's data while Fanfold is locked: its usual shape, holding nothing. */
  async #lockedAnswer(url: URL, now: Access): Promise<unknown> {
    switch (url.pathname) {
      case '/api/setup': return this.#lockedSetup(now);
      case '/api/model': return { ...modelView(this.#ctx), hint: null };
      case '/api/profile': {
        const view = await profileView(this.#ctx);
        // Signed in, what setup saved stays: the facts and the files. Never the saved answers or what Fanfold worked out.
        if (now.reason === 'no-name-email') return { ...view, answers: [], derived: [] };
        const { total } = this.#app.profile.completeness();
        // Where they may work: the choices setup offers stay, in the order that names no country of theirs first.
        const rights = view.rights as Record<string, unknown> | undefined;
        return {
          facts: [], fields: view.fields, completeness: { filled: 0, total }, counts: { total, filled: 0, confirmed: 0, proposed: 0 },
          suggestions: {}, answers: [], derived: [], documents: [], career: null,
          ...(rights ? { rights: { ...rights, entries: [], elsewhere: null, earlierSponsorship: null, countries: countryChoices(null) } } : {}),
        };
      }
      case '/api/conversations': return { conversations: [] };
      case '/api/workers': return { workers: [] };
      case '/api/applications': return { applications: [], funnel: emptyFunnel() };
      // The sites as shipped: nothing the person chose, learned or ran.
      case '/api/sites': return { sites: catalogue() };
      case '/api/playbooks': return { sites: catalogue().map((site) => ({ ...site, lessons: [], skills: [], runs: 0, successes: 0 })), counts: { active: 0, proposed: 0, unproven: 0, rejected: 0, shadow: 0 }, flows: [], derivedCases: 0, contribute: false };
      case '/api/profile/sites': {
        const view = sitesView(this.#ctx) as { sites: Array<Record<string, unknown>> };
        return { sites: view.sites.map((s) => ({ ...s, last: null, reading: false, signedIn: 'unknown' })), linkedinExport: null };
      }
      case '/api/connect': {
        const view = connectView(this.#ctx, { mcp: this.mcp, port: () => this.address?.port ?? null, agentToken: this.#agentToken });
        return { ...view, agentToken: null, sessions: [], waitingPages: 0 };
      }
      case '/api/teach': return { active: false, startedAt: null, url: null, steps: [], notes: [] };
      case '/api/tabs': return { tabs: [] };
      default: return {};
    }
  }

  #stream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const id = randomUUID();
    this.#clients.set(id, { id, res });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    keepAlive.unref?.();
    res.on('close', () => {
      clearInterval(keepAlive);
      this.#clients.delete(id);
    });
  }

  #emit(event: AgentEvent | { type: string; [k: string]: unknown }): void {
    // Locked, the page hears only that something changed, never what a run or a worker did.
    if (!LOCKED_EVENTS.has(event.type) && access(this.#app).locked) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of this.#clients.values()) c.res.write(payload);
  }

  /**
   * The thread the user is in, creating one if this is the first message.
   *
   * Resolved from the database rather than held only in memory, so restarting
   * the server does not silently start a new conversation while the UI still
   * shows the old one.
   */
  #currentConversation(title: string): string {
    if (this.#conversationId && this.#app.store.conversation(this.#conversationId)) {
      return this.#conversationId;
    }
    const latest = this.#app.store.latestConversation();
    this.#conversationId = latest
      ? String(latest.id)
      : this.#app.store.openConversation(titleFrom(title));
    return this.#conversationId;
  }

  #newConversation(res: ServerResponse): void {
    this.#conversationId = this.#app.store.reuseEmptyConversation() ?? this.#app.store.openConversation(UNTITLED_CONVERSATION);
    this.#emit({ type: 'conversation_changed', conversationId: this.#conversationId });
    sendJson(res, { id: this.#conversationId });
  }

  #openConversation(res: ServerResponse, id: string): void {
    const row = this.#app.store.conversation(id);
    if (!row) return sendJson(res, { error: 'That conversation is already gone.' }, 404);
    this.#conversationId = id;
    sendJson(res, { ...row, messages: this.#app.store.thread(id, 200), objectives: this.#collections(id) });
  }

  /** What a thread has collected, newest first, with counts. */
  #collections(conversationId: string): Array<Record<string, unknown>> {
    return this.#app.objectives.forConversation(conversationId)
      .map((o) => ({ ...o, found: this.#app.objectives.count(o.id) }))
      .filter((o) => (o.found as number) > 0 || o.status === 'active');
  }

  /**
   * Bring the browser up without being asked.
   *
   * Called by the server binary once it is listening — never from the
   * constructor, because creating an ApiServer in a test must not launch
   * Chrome.
   *
   * Nothing here can fail the session: the agent opens a browser lazily the
   * moment a task needs one, so this is a head start, not a precondition. A
   * failure is recorded and announced rather than thrown, because the one
   * thing worse than a slow first task is a server that would not start.
   */
  async openBrowser(): Promise<void> {
    try {
      await this.#app.startBrowser();
      this.#browserError = null;
      this.#emit({ type: 'browser_started' });
    } catch (err) {
      const message = (err as Error).message;
      this.#browserError = message;
      // Kept in state as well as emitted: this usually finishes before any
      // page has opened the event stream, and an error nobody was connected
      // to hear is an error nobody hears.
      this.#emit({ type: 'browser_error', message });
      this.#log.error('could not open the browser', { component: 'browser', err });
    }
  }

  /**
   * One run of a task. Called again, unchanged, while the objective is unmet
   * and the last leg was still finding things.
   */
  async #runLeg(a: {
    goal: string; thread: ConversationTurn[]; conversationId: string;
    abort: AbortController; body: { maxSteps?: number }; runId: string;
  }): Promise<RunResult> {
    return await runTask({
      goal: a.goal,
      conversation: a.thread,
      conversationId: a.conversationId,
      // A thunk only while there is no browser: a task that needs just a
      // connector never opens Chrome. Once one is open the run starts from the
      // page it is on, or an answer to "shall I submit?" finds the form it
      // filled gone, navigates back to it, and starts again on an empty one.
      page: this.#app.browserStarted && !this.#browserError ? await this.#app.startBrowser() : () => this.#app.startBrowser(),
      // The same composition the scheduler and a worker run use, so the same
      // task behaves the same however it was started.
      ...(await this.#app.runContext()),
      policy: this.#app.policy(),
      maxSteps: a.body.maxSteps ?? 25,
      onEvent: (e) => {
        if (e.type === 'run_started') {
          this.#activeRun = { runId: e.runId, goal: a.goal, abort: a.abort };
          this.#app.currentRunId = e.runId;
        }
        // The chat works in Fanfold's main page, so that is where what it asked for is carried out.
        if (e.type === 'approval_required' && this.#activeRun && this.#app.browserStarted) this.#app.bindRun(this.#activeRun.runId, this.#app.page);
        // Named, so a tab showing another thread draws none of it in that thread.
        this.#emit({ ...e, conversationId: a.conversationId });
      },
      signal: a.abort.signal,
    });
  }

  async #startTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#activeRun) return sendJson(res, { error: 'a run is already in progress' }, 409);

    // Claim the slot BEFORE the first await, and the first await is reading
    // the body. A check and a claim that straddle one are not a lock: two
    // submissions a few milliseconds apart would both pass the check and both
    // start a run, against one browser.
    const abort = new AbortController();
    const runId = randomUUID();
    this.#activeRun = { runId, goal: '', abort };

    let goal: string;
    let conversationId: string;
    let thread;
    let continuation;
    let body: { goal?: string; maxSteps?: number; conversationId?: string };
    let message: string;
    const store = this.#app.store;
    try {
      body = await readBody(req, Bodies.Task);
      message = (body.goal ?? '').trim();
      if (!message) {
        this.#activeRun = null;
        return sendJson(res, { error: 'goal is required' }, 400);
      }

      conversationId = body.conversationId && store.conversation(body.conversationId)
        ? body.conversationId
        : this.#currentConversation(message);
      this.#conversationId = conversationId;

      // What IS this message? A reply to something the agent asked, or a new
      // task? The distinction decides the goal the run carries: read wrong,
      // "Yes I am signed in" becomes a goal with no task in it.
      continuation = await resolveContinuation({
        message,
        pending: store.pendingQuestion(conversationId),
        activeGoal: store.conversationGoal(conversationId),
        model: this.#app.model,
        signal: abort.signal,
      });

      store.appendMessage({ conversationId, role: 'user', text: message });
      if (continuation.kind === 'task') {
        store.setConversationGoal(conversationId, continuation.goal);
        // A thread opened with New is named by its first request, as one opened by typing is.
        store.titleConversation(conversationId, titleFrom(message));
      }
      goal = continuation.goal;

      // The thread as the model will see it, INCLUDING the message just
      // sent: on a resumed task the goal is the old one, so the newest turn
      // is the only place the answer appears.
      thread = store.thread(conversationId, 20);
    } catch (err) {
      // Includes the 413 that readJson throws for an oversized body, which
      // #handle answers. Releasing the slot on the way out is the point.
      this.#activeRun = null;
      throw err;
    }

    this.#activeRun = { runId, goal, abort };
    this.#runConversationId = conversationId;
    this.#emit({
      type: 'message', conversationId, role: 'user', text: message,
      continuation: continuation.kind, goal, why: continuation.why,
    });
    sendJson(res, { started: true, goal, conversationId, continuation: continuation.kind });

    // The run continues after the response: the client watches /api/stream.
    void (async () => {
      try {
        // A collecting task rarely fits in one run's steps. While it is still
        // banking rows it has not seen before, the next run picks up the same
        // objective and carries on; a run that adds nothing new stops instead
        // of looping. Nobody has to type "keep going".
        let result;
        do {
          result = await this.#runLeg({ goal, thread, conversationId, abort, body, runId });
        } while (result.status === 'continuing' && !abort.signal.aborted);
        // The agent's own turn joins the thread. `awaiting` is the bit that
        // matters next time: it marks this as a question the agent stopped
        // on, so whatever the user types next is read as the answer to it
        // rather than as a task that arrived out of nowhere.
        store.appendMessage({
          conversationId, role: 'agent', text: result.message,
          runId: result.runId, awaiting: result.status === 'awaiting_approval',
        });
        const report = await this.#writeReport(result);
        this.#logRun(result, conversationId);
        this.#emit({ type: 'run_complete', conversationId, report, ...result });
      } catch (err) {
        this.#log.error('run failed', { runId, conversationId, err });
        const message = (err as Error).message;
        store.appendMessage({ conversationId, role: 'agent', text: message, runId });
        this.#emit({ type: 'run_error', conversationId, message });
      } finally {
        this.#activeRun = null;
        this.#runConversationId = null;
        this.#app.currentRunId = null;
      }
    })();
  }

  /** One line per finished task, with the numbers that explain its cost. */
  #logRun(result: RunResult, conversationId: string): void {
    const level = result.status === 'failed' ? 'warn' : 'info';
    this.#log[level]('run finished', {
      runId: result.runId, conversationId, status: result.status, steps: result.steps, costUsd: result.costUsd,
      ...(result.progress ? { found: result.progress.found, target: result.progress.objective.targetCount } : {}),
    });
  }

  #cancel(res: ServerResponse): void {
    if (!this.#activeRun) return sendJson(res, { error: 'nothing running' }, 400);
    this.#activeRun.abort.abort();
    sendJson(res, { cancelled: true });
  }

  async #answerApproval(
    req: IncomingMessage, res: ServerResponse, id: string, verdict: 'approve' | 'reject',
  ): Promise<void> {
    const body = await readBody(req, Bodies.Approval);

    if (verdict === 'reject') {
      if (!this.#app.approvals.reject(id, body.note)) {
        // Too late to say no: it went, or is going, and the person must not be told it was stopped.
        const was = this.#app.approvals.get(id);
        if (!was) return sendJson(res, { error: 'no such approval' }, 404);
        if (was.status !== 'rejected') return sendJson(res, { error: tooLateToReject(was.status) }, 409);
        return sendJson(res, { ok: true });
      }
      const thread = this.#threadOfApproval(id);
      const note = 'You rejected the action that was waiting for approval. Nothing was done.';
      this.#noteInThread(note, thread);
      this.#emit({ type: 'approval_answered', id, verdict, conversationId: thread, note });
      // The tab kept for it has nothing more to wait for.
      this.#app.settleKeeps();
      return sendJson(res, { ok: true });
    }

    this.#app.approvals.approve(id, body.editedContent, body.note);
    const asked = this.#app.approvals.get(id);
    // Carried out on the page it was asked on, and nowhere else: with that window closed, nothing is pressed.
    const page = asked ? this.#app.pageForRun(asked.runId) : null;
    const outcome = await performApproved(this.#app.approvals, page, id, {
      // So an approved upload can turn its document id back into a file,
      // and an approved contact is checked against and recorded in the same
      // identity table the loop uses — one person, one message.
      documents: this.#app.memory,
      memory: this.#app.memory,
      sites: this.#app.sites,
      jobs: this.#app.jobs,
      // A Submit on the page of a code the site emailed finishes the application the code is for.
      application: asked ? codeAskApplication(this.mcp.sessions.list(), asked.runId, asked.url) : null,
    });
    const thread = this.#threadOfApproval(id);
    const note = outcome.performed
      ? 'You approved it, and Fanfold did it.'
      : outcome.reason === 'unknown'
        ? `You approved it and it was pressed, but ${outcome.detail}`
        : `You approved it, but it was not carried out: ${outcome.detail ?? 'no reason given'}`;
    this.#noteInThread(note, thread);
    this.#emit({ type: 'approval_answered', id, verdict, outcome, conversationId: thread, note });
    sendJson(res, outcome);
  }

  /** The chat thread whose run asked for an approval; null for one asked by a fill, a worker or an agent. */
  #threadOfApproval(id: string): string | null {
    const runId = this.#app.approvals.get(id)?.runId;
    const thread = runId ? this.#app.store.getRun(runId)?.conversation_id : null;
    return typeof thread === 'string' && this.#app.store.conversation(thread) ? thread : null;
  }

  /**
   * Put a finished collection on disk.
   *
   * Only once the target was actually met: a half-collected list written to
   * the artifacts directory is a file someone will later mistake for the
   * answer.
   */
  async #writeReport(result: RunResult): Promise<{ objectiveId: string; name: string; rows: number } | null> {
    const progress = result.progress;
    if (!progress?.satisfied || progress.objective.targetCount === null) return null;
    try {
      const findings = this.#app.objectives.findings(progress.objective.id);
      const written = await writeReport(progress.objective, findings);
      this.#app.objectives.setReport(progress.objective.id, written.name);
      return { objectiveId: progress.objective.id, name: written.name, rows: written.rows };
    } catch (err) {
      this.#log.error('could not write the report', { objectiveId: progress.objective.id, err });
      return null;
    }
  }

  /**
   * Record something that happened outside the chat box in the thread.
   *
   * Approving a card is part of the conversation even though it was a button.
   * It also settles the question: the agent's last word is no longer one it
   * is waiting on, so the next thing typed is read as a new task rather than
   * as an answer to something already dealt with.
   */
  #noteInThread(text: string, conversationId: string | null): void {
    // An approval asked outside the chat belongs to no thread: written into whichever was open, it read as a reply to nothing.
    if (!conversationId) return;
    this.#app.store.appendMessage({
      conversationId, role: 'agent', text, awaiting: false,
    });
  }
}
