/**
 * Composition root.
 *
 * Everything the agent needs, wired once: one SQLite file, one browser, one
 * model client, and the subsystems that share them. Kept separate from the
 * server and the CLI so both drive the same object graph rather than each
 * assembling their own slightly different one.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { Store } from './store/db.ts';
import { access, OPEN, sameAccess, type Access } from './auth/access.ts';
import { Memory } from './memory/memory.ts';
import { Approvals } from './agent/approvals.ts';
import { Workers, type TickOptions } from './workers/worker.ts';
import { WorkerRuns } from './workers/runs.ts';
import { RunPages, parkedPages } from './agent/run-pages.ts';
import { RateGovernor } from './workers/governor.ts';
import { Scheduler } from './workers/scheduler.ts';
import { learnFromRuns } from './agent/learn.ts';
import { googleTools, linkedinTools, type AgentTools } from './agent/tools.ts';
import { GoogleAuth, Gmail, Calendar, checkReachable, type Reachability } from './connectors/google.ts';
import {
  ComposioClient, ComposioGmail, ComposioCalendar, TOOLKITS, scopesFromAccounts, checkComposioReachable, type ConnectedAccount, type ToolkitSlug, ComposioLinkedIn,
} from './connectors/composio.ts';
import { Capabilities } from './policy/capabilities.ts';
import { Objectives } from './agent/objective.ts';
import { Jobs, type ApplicationStatus } from './jobs/jobs.ts';
import { Profile } from './jobs/profile.ts';
import { Questions } from './jobs/questions.ts';
import { SitePolicies } from './jobs/site-policies.ts';
import { gateFromEnv, type PolicyContext } from './policy/engine.ts';
import type { Sensitivity } from './types.ts';
import { SecretStore, type KeyStore } from './connectors/keychain.ts';
import { ModelClient } from './model/client.ts';
import { GEMINI_KEY_SECRET, modelSource, type ModelSource, type ModelSourceKind } from './model/source.ts';
import { launchChrome, connectToChrome, defaultProfileDir, type Launched } from './cdp/launcher.ts';
import { Page } from './observe/page.ts';
import { stateDir } from './daemon/protocol.ts';
import type { BrowserRuntime } from './observe/runtime.ts';
import { ResilientRuntime } from './observe/resilient.ts';
import { MAIN, mainHold, TabLedger, sameOwner, type OwnedTab, type Owner, type TabMode } from './observe/tab-ledger.ts';
import { Janitor } from './observe/janitor.ts';
import { createTargetWithRetry } from './observe/targets.ts';
import { onOwnOriginsChange, ownOrigins } from './policy/navigable.ts';
import type { CdpClient } from './cdp/client.ts';
import { loggerFromEnv, type Logger } from './lib/log.ts';
import { currentRun } from './lib/run-scope.ts';
import { SqliteCheckpointer } from './graph/checkpoint.ts';
import { Delegation } from './agent/delegate.ts';
import type { Delegator } from './agent/delegate-action.ts';
import { runTask, runsGoing, stopRuns, type ModelLike } from './agent/loop.ts';
import { fillProfile, type FillResult } from './jobs/profile-fill.ts';
import { DocumentOwners, notAResume, someoneElse } from './jobs/profile-documents.ts';
import { hasCvSections, importHold, namedLikeACv } from './policy/import-hold.ts';
import { whoseText } from './policy/upload-hold.ts';
import { appearsIn } from './jobs/wording.ts';
import { CareerRecords, careerOf, parseCareer, parseCareerByPattern, sha256, type CareerRecord } from './jobs/career.ts';
import { readerText } from './memory/document-instructions.ts';
import { answerModelHealth, forgetHealth, plainReason } from './model/limiter.ts';
import { QuestionIntents } from './jobs/intents.ts';
import { foldAccentKeys } from './jobs/accent-keys.ts';
import { closeSettled, sweepQuestions, type AnswerDeps, type SweepResult } from './jobs/answerer.ts';
import type { Tab } from './observe/runtime.ts';
import { Submissions } from './jobs/submissions.ts';
import { Teaching } from './agent/teach.ts';
import { guardRun, type RunGuardOptions } from './agent/run-guard.ts';
import { ExtensionBridge, type CreatedTab } from './extension/bridge.ts';
import { SqliteKeyValueStore } from './extension/store.ts';
import { connectViaExtension, extensionDenyHosts } from './extension/connect.ts';

export type BrowserMode = 'dedicated' | 'extension';
/** Where the user asked Fanfold to work: one of the two, or their Chrome when it is there and Fanfold's window when it is not. */
export type BrowserChoice = BrowserMode | 'auto';

/** The browser in use, and in words why it is that one. */
export interface BrowserInUse {
  mode: BrowserMode;
  /** Why their Chrome was not used when Automatic would have used it; null when it was, or was not asked for. */
  fallback: string | null;
  why: string | null;
}

/** Launched by Fanfold, attached to over a port, or the user's own through the extension. */
type AnyBrowser = Launched | { client: unknown; close(): Promise<void>; profileDir: string };

/** A browser beside the main one, with the janitor that tidies it and lets it go when idle. */
interface SideBrowser { mode: BrowserMode; browser: AnyBrowser; janitor: Janitor }

export type AppEvent = { type: string; [key: string]: unknown };

export interface AppOptions {
  apiKey: string;
  dbPath?: string;
  profileDir?: string;
  headless?: boolean;
  /** How long the browser gets to answer one command. Shortened in tests. */
  cdpTimeoutMs?: number;
  /** Attach to a browser already listening on this loopback port instead of launching one. */
  attachPort?: number;
  /** Overrides BROWSER_AGENT_APPROVALS. Mostly for tests. */
  approvalGate?: ReadonlySet<Sensitivity>;
  /** Where structured logs go. Defaults to stderr, configured by FANFOLD_LOG_LEVEL. */
  logger?: Logger;
  /** Port the extension link listens on. Defaults to the well-known one; 0 picks a free port. */
  extensionPort?: number;
  /** What reads an imported document into the profile. Fanfold's own model when it has one; null reads contact details by pattern only. */
  profileModel?: ModelLike | null;
  /**
   * What reads a résumé into a career record, classifies new wordings of
   * questions, checks answers and drafts essays. Defaults to profileModel, so
   * a test that turns one off turns off both.
   */
  answerModel?: ModelLike | null;
  /** Answer waiting questions again after a document comes in, the profile changes, or the user answers something. The served app turns it on. */
  sweeps?: boolean;
  /**
   * How long to wait before reading again a document the model failed to
   * read, one delay per failure in a row. Defaults to 2 s, 10 s and 30 s,
   * then 1, 5 and 30 minutes; a profile reading uses the first three.
   */
  careerRetryMs?: number[];
  /** How long the sweep waits before drafting again after a draft failed, one delay per failure in a row. */
  draftRetryMs?: number[];
  /** Where the master key of saved secrets lives. The macOS Keychain by default; a fake in tests. */
  keychain?: KeyStore;
  /** Tests only: everything works whatever the profile holds and whoever is signed in. The entry points never set it. */
  unlocked?: boolean;
}

/** What a person reads about how Fanfold answers for them. */
export const COPY = {
  /** Why the main page is kept open: the person was shown it. */
  shownToYou: 'Opened for you to look at.',
  whyDedicated: 'You chose Fanfold’s own window.',
  whyExtension: 'You chose your Chrome, and the Fanfold extension is connected.',
  whyAuto: 'Automatic: the Fanfold extension is connected, so Fanfold works in your Chrome.',
  whyAutoFallback: 'Automatic: {reason}, so Fanfold works in its own window.',
  whyAttached: 'Fanfold was started on a browser that was already running.',
  linkDown: 'the link to the extension is not running',
  notPaired: 'the Fanfold extension is not paired yet',
  noChrome: 'Fanfold is set to work in your Chrome, but {reason}. It will not switch to its own window automatically: open Chrome with the Fanfold extension, or choose Automatic or Fanfold’s own window in Settings.',
  chromeGone: 'Your Chrome disconnected while Fanfold was working ({reason}). Fanfold did not move the work to its own window. Once Chrome is back, the Fanfold extension reconnects automatically and the work can continue.',
  noModel: 'Fanfold has no model of its own, so it answers only questions it knows by their wording, from your profile, your saved answers and what it read in your résumé. Set a model key to have new wordings and essays handled too.',
  /** A run still going when Fanfold was closed, as its record and its conversation say. */
  interrupted: 'Fanfold was closed while this was running.',
  interruptedNote: 'Fanfold was closed while it was working on this, so it stopped partway. Anything it already typed into a page may be gone. Ask again to start it over.',
  /** One a crash or a forced quit left running. */
  crashedNote: 'Fanfold stopped unexpectedly while it was working on this, so it didn’t finish. Anything it already typed into a page may be gone. Ask again to start it over.',
};

const CAREER_RETRY_MS = [2_000, 10_000, 30_000, 60_000, 5 * 60_000, 30 * 60_000];
/** A profile reading is tried this many more times in the background; the career reading has the whole list. */
const PROFILE_RETRIES = 3;
const DRAFT_RETRY_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000];
/** How long after a change to the profile the page hears of it, and documents are judged again for a new name: one word for a burst. */
const PROFILE_NOTE_MS = 300;

/** How the model's part of reading one document went. */
export interface Reading {
  /** `model`: the model read it; `patterns`: it failed and patterns read it for now; `kept`: nothing new to read; `none`: no model, or nothing of the owner's to read. */
  by: 'model' | 'patterns' | 'kept' | 'none';
  /** What the provider said when the model failed, in plain words. */
  problem: string | null;
}

/** "Read my documents again" for one document: its profile reading and its career reading. */
export interface DocumentReading { profile: FillResult | null; career: Reading }

/** A burst of changes is answered by one sweep, this long after the last of them. */
const SWEEP_SETTLE_MS = 1_500;
/** More sweeps than this inside the window, none of them asked for by a person, is a loop. */
const SWEEPS_PER_WINDOW = 5;
const SWEEP_WINDOW_MS = 10_000;

/** Scheduled workers that may run side by side, each on a tab of its own. */
const WORKERS_AT_ONCE = 3;

/** How long the user's Chrome has to connect through the extension before it counts as not there. */
const EXTENSION_WAIT_MS = 8_000;

/** How long a worker's grant lasts, in days; its use budget is that many days of its daily cap. */
const GRANT_DAYS = 30;

/** How long shutdown waits for worker runs told to stop. */
const RUNS_STOP_MS = 15_000;

/** An application in one of these waits on the user: its form filled for Review, or sent with an outcome for them to confirm. */
const APPLICATION_WAITS: ReadonlySet<ApplicationStatus> = new Set(['needs_review', 'prepared', 'unconfirmed']);

export class App {
  readonly db: DatabaseSync;
  readonly store: Store;
  readonly memory: Memory;
  readonly approvals: Approvals;
  readonly workers: Workers;
  readonly governor: RateGovernor;
  readonly capabilities: Capabilities;
  readonly objectives: Objectives;
  readonly jobs: Jobs;
  readonly profile: Profile;
  /** Questions only the user can answer, each asked once. */
  readonly questions: Questions;
  /** What Fanfold read of the user's career from each of their documents. */
  readonly careers: CareerRecords;
  /** Whose each document is: the user's, or another person's whose name it carries. */
  readonly owners: DocumentOwners;
  /** What each wording of a question asks, classified once. */
  readonly intents: QuestionIntents;
  readonly sites: SitePolicies;
  readonly secrets: SecretStore;
  readonly model: ModelClient;
  /** Settled once a key the person saved, if there is one, is in use. */
  readonly modelReady: Promise<void>;
  #modelKind: ModelSourceKind;
  #modelHint: string | null = null;
  /** Which resolution of the model source is the newest. */
  #modelTurn = 0;
  readonly log: Logger;
  /** Empty unless BROWSER_AGENT_APPROVALS says otherwise. One copy, so the
   * chat, a manual worker run and the scheduler cannot disagree. */
  readonly approvalGate: ReadonlySet<Sensitivity>;
  /** Tests only: never locked (AppOptions.unlocked). */
  readonly unlocked: boolean;
  #signInRequired = false;
  /** Locked or open, as last said: what a change is measured against. */
  #access: Access = OPEN;
  /** The catch-up was asked for while locked, and runs once Fanfold opens. */
  #catchUpWhenOpen = false;
  #scheduler: Scheduler | null = null;
  #googleAuth: GoogleAuth | null = null;
  #composio: ComposioClient | null = null;

  #browser: AnyBrowser | null = null;
  #page: Page | null = null;
  #runtime: ResilientRuntime | null = null;
  #starting: Promise<BrowserRuntime> | null = null;
  #opts: AppOptions;
  /** Which tabs Fanfold opened and for what; what closes them when that ends (observe/tab-ledger.ts). */
  readonly tabs: TabLedger;
  #janitor: Janitor | null = null;
  /** A browser being opened, so two first uses open one. */
  #ensuring: Promise<AnyBrowser> | null = null;
  /** A browser being let go, which still holds its profile until it has quit. */
  #letting: Promise<void> | null = null;
  /** Runs that worked in the main page: it stays while one is still going or waits on the user. */
  readonly #mainRuns = new Set<string>();
  /** When a task of the app's own last worked in the main page: the chat comes back to it, as an agent does. */
  #mainRunUsed = 0;
  #shuttingDown = false;
  readonly #pages: RunPages;
  readonly #bootedAt = new Date().toISOString();
  readonly #runs: WorkerRuns;
  readonly #listeners = new Set<(event: AppEvent) => void>();
  #submissions: Submissions | null = null;
  #teaching: Teaching | null = null;
  /** The link to the Fanfold extension in the user's own Chrome. Not listening until started. */
  readonly extension: ExtensionBridge;
  /** Which browser is in use right now, and why it is that one. */
  #browserInUse: BrowserInUse | null = null;
  /** Why the kind of browser asked for could not be opened, the last time one was needed; null once one opens. */
  #browserProblem: string | null = null;
  /** The user's Chrome went away while work was going on in it: the next browser is that Chrome again, or none. */
  #sticky: BrowserMode | null = null;
  /** A second browser, for a worker that asked for the other kind than the one in use. */
  #side: SideBrowser | null = null;
  #sideOpening: Promise<SideBrowser> | null = null;
  /** What the main page last showed: "working", or "waiting" while an approval asked in it waits. */
  #mainShown: { page: unknown; state: 'working' | 'waiting' } | null = null;
  #mainWatch: NodeJS.Timeout | null = null;
  #inUseTimer: NodeJS.Timeout | null = null;
  readonly #offOwnOrigins: () => void;
  readonly #delegations = new Map<string, Delegation>();
  /** Where multi-agent runs save their position, so a pause or a restart does not lose it. */
  readonly checkpoints: SqliteCheckpointer;

  private constructor(opts: AppOptions, db: DatabaseSync) {
    this.#opts = opts;
    this.db = db;
    this.store = new Store(db);
    this.memory = new Memory(db);
    this.approvals = new Approvals(db);
    this.workers = new Workers(db);
    this.governor = new RateGovernor(db);
    this.capabilities = new Capabilities(db);
    this.objectives = new Objectives(db);
    this.jobs = new Jobs(db);
    this.profile = new Profile(db);
    this.questions = new Questions(db, this.profile);
    this.careers = new CareerRecords(db);
    this.owners = new DocumentOwners(db);
    this.intents = new QuestionIntents(db);
    this.sites = new SitePolicies(db);
    this.approvalGate = opts.approvalGate ?? gateFromEnv();
    this.log = opts.logger ?? loggerFromEnv();
    for (const merged of this.jobs.repaired) this.log.info('merged a submit recorded as a second job into the job its run claimed', { ...merged });
    if (this.profile.rights.migrated.length) this.log.info('moved work authorisation and sponsorship sentences into choices', { moved: this.profile.rights.migrated });
    try {
      const folded = foldAccentKeys(db);
      for (const m of folded?.merged ?? []) this.log.info('merged two saved question rows whose keys differed only in accents', { table: m.table, key: m.key, kept: m.kept, dropped: m.dropped });
      if (folded && Object.values(folded.moved).some(Boolean)) this.log.info('moved question keys to their accent-folded form', folded.moved);
    } catch (err) {
      this.log.warn('could not move question keys to their accent-folded form; it is tried again on the next start', { err });
    }
    this.secrets = new SecretStore(db, opts.keychain);
    this.checkpoints = new SqliteCheckpointer(db);
    this.tabs = new TabLedger(db);
    this.#pages = new RunPages({ ledger: this.tabs, waits: (runId, key) => this.#runWaits(runId, key) });
    // "main" is created on first use and kept only while something uses it.
    this.tabs.hold(MAIN, () => this.#mainAlive());
    this.tabs.on((event) => {
      if (event.type === 'released' && sameOwner(event.owner, MAIN)) this.#mainClosed();
    });
    this.#runs = new WorkerRuns({
      workers: this.workers, log: this.log,
      context: (workerId) => this.workerContext(workerId),
      emit: (event) => this.emit(event),
    });
    this.extension = new ExtensionBridge({
      store: new SqliteKeyValueStore(db),
      denyHosts: extensionDenyHosts(this.sites.list()),
      ownOrigins: ownOrigins(),
      logger: this.log,
      port: opts.extensionPort,
    });
    let linked = false;
    this.extension.onChange((status) => {
      this.emit({ type: 'extension_changed', status });
      if (linked && !status.connected) this.#extensionGone();
      linked = status.connected;
    });
    // Fanfold's own pages are off limits in the user's Chrome too, wherever its server listens.
    this.#offOwnOrigins = onOwnOriginsChange(() => this.extension.setOwnOrigins(ownOrigins()));
    // Each time the extension connects it says which tabs it opened: what no work of this Fanfold wants is closed.
    this.extension.onCreated((tabs) => void this.#reconcile(tabs).catch((err: unknown) => {
      this.log.warn('could not tidy the tabs Fanfold left in your Chrome', { component: 'extension-bridge', err });
    }));
    this.extension.onStop((request) => void ('all' in request ? this.stopEverything() : this.#stopFromChrome(request.targetId)).catch(() => {}));
    // The extension's popup lists the tabs Fanfold is using in the user's Chrome, and its badge counts them.
    this.tabs.on(() => this.#inUseSoon());
    this.model = new ModelClient({
      apiKey: opts.apiKey,
      // Every model call lands in the ledger. Usage that is not recorded
      // cannot be billed, capped, or explained to the person paying for it.
      onUsage: (e) => this.store.recordUsage(currentRun() ?? this.currentRunId, e),
    });
    this.#modelKind = opts.apiKey.trim() || process.env.FANFOLD_MODEL_URL?.trim() ? 'env' : 'none';
    this.modelReady = this.#resolveModel(true);
    // What a document an agent added proposed before such a document proposed nothing.
    this.profile.dropProposalsFrom(this.memory.listDocuments({ includeHeld: true }).filter((d) => !d.trusted).map((d) => d.id));
    if (opts.sweeps) this.profile.onChange(() => this.#sweepSoon());
    this.unlocked = opts.unlocked === true;
    this.#access = access(this);
    // A name or an email saved, or taken away, can lock or open Fanfold.
    this.profile.onChange(() => this.recheckAccess());
    this.#judgedName = this.#savedName();
    this.profile.onChange(() => this.#profileMoved());
    // A question only sent or skipped jobs were asking leaves the open list as soon as the last of them goes.
    this.jobs.onChange((a) => {
      // A page kept for an application that no longer waits goes now, rather than at the next sweep.
      if (!APPLICATION_WAITS.has(a.status) && this.#pages.pageForKey(a.id)) this.settleKeeps();
      if (!['applied', 'unconfirmed', 'skipped'].includes(a.status)) return;
      const ids = closeSettled({ questions: this.questions, jobs: this.jobs });
      if (ids.length) this.emit({ type: 'question_closed', ids });
    });
  }

  /** Set by the loop so usage events attach to the run that caused them. */
  currentRunId: string | null = null;

  static create(opts: AppOptions): App {
    const dbPath = opts.dbPath ?? defaultDbPath();
    if (dbPath !== ':memory:') {
      // The profile, saved answers and approval history are the person's alone.
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      try { chmodSync(stateDir(), 0o700); } catch { /* not ours to change */ }
    }
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    if (dbPath !== ':memory:') {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try { if (existsSync(file)) chmodSync(file, 0o600); } catch { /* not ours to change */ }
      }
    }
    return new App(opts, db);
  }

  /** A browser is running right now. It starts when something needs one and closes once nothing has for a while. */
  get browserStarted(): boolean {
    return !!this.#browser && !(this.#browser.client as CdpClient).closed;
  }

  /**
   * Start (or attach to) the browser. Idempotent.
   *
   * Wrapped in a ResilientRuntime: browsers get quit, updated and crashed,
   * and losing one should not destroy a long run when the profile — and so
   * every signed-in session — is still on disk.
   */
  startBrowser(): Promise<BrowserRuntime> {
    // Callers arriving while the first start is still proving the browser wait for that proof.
    this.#starting ??= this.#startBrowser().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #startBrowser(): Promise<BrowserRuntime> {
    if (this.#runtime) return this.#runtime;

    this.#runtime = new ResilientRuntime({
      create: async () => {
        // Let go of the page from before: lost with its browser, or closed when nothing used it.
        await this.#page?.close().catch(() => {});
        this.#page = null;
        const browser = await this.#ensureBrowser();
        this.tabs.revive(MAIN);
        this.#page = await Page.first(browser.client as never, { owner: MAIN });
        this.emit({ type: 'browser_mode', ...this.browserInUse });
        this.#watchMain();
        return this.#page;
      },
      onUse: (runId) => {
        if (runId) {
          this.#mainRuns.add(runId);
          this.#mainRunUsed = Date.now();
        }
        this.#janitor?.touch();
      },
      /*
       * Counted for the life of this App, which is a whole session — hours,
       * not one task. An agent that relaunches its browser a few times across
       * a working day and then refuses to try again is not resilient, it is
       * merely patient. The ceiling exists so a browser that cannot start at
       * all fails loudly instead of spinning.
       */
      maxReconnects: 25,
      onReconnect: (n, why) => {
        this.log.warn('browser lost; restarted', { component: 'browser', attempt: n, why });
      },
    });

    /*
     * Prove the browser is actually usable before handing it back.
     *
     * On a machine where Chrome exits shortly after its handshake, a runtime
     * handed back unproven has a client that is already closed, and the first
     * real action comes back TRANSPORT_LOST in 0ms with nothing attempted.
     *
     * The resilient runtime relaunches on that loss, so asking twice is
     * enough to turn "born dead" into "born again"; if the second attempt
     * also fails the browser is genuinely unusable and the caller should hear
     * about it rather than discover it mid-task.
     */
    try {
      await this.#runtime.observe();
    } catch (first) {
      // The browser asked for is not there (the user's Chrome, say): that is the whole story, not a browser that would not start.
      if (this.#browserProblem) throw new Error(this.#browserProblem);
      try {
        await this.#runtime.observe();
      } catch {
        throw new Error(
          `the browser started but was not usable: ${(first as Error).message}. ` +
          'Run "npm run diagnose -- launch" to see what Chrome did.',
        );
      }
    }
    return this.#runtime;
  }

  get page(): BrowserRuntime {
    if (!this.#runtime) throw new Error('browser not started — call startBrowser() first');
    return this.#runtime;
  }

  /**
   * The browser to open the main page in: the running one, or a new one with a
   * janitor that first clears whatever an earlier session left in it.
   */
  #ensureBrowser(): Promise<AnyBrowser> {
    this.#ensuring ??= this.#openOrReuse().finally(() => { this.#ensuring = null; });
    return this.#ensuring;
  }

  async #openOrReuse(): Promise<AnyBrowser> {
    const current = this.#browser;
    if (current && !(current.client as CdpClient).closed) {
      // The main page is being made again in a browser that is still there: its old tab is stale.
      await this.#closeMainTabs(current.client as CdpClient);
      return current;
    }
    this.#janitor?.stop();
    this.#janitor = null;
    await current?.close().catch(() => {});
    this.#browser = null;
    // One let go when idle may still be quitting, holding the profile a new one needs.
    await this.#letting;
    // Work that was going on in the user's Chrome when it went away stays there: it waits for that Chrome, never another browser.
    const sticky = this.#sticky && this.#workInProgress(this.#sticky) ? this.#sticky : null;
    if (!sticky) this.#sticky = null;
    const browser = await this.#openBrowser(sticky);
    this.#sticky = null;
    this.#browser = browser;
    const mode: TabMode = this.browserInUse.mode;
    const janitor = new Janitor({
      client: browser.client as CdpClient, ledger: this.tabs, mode, log: this.log,
      // A browser Fanfold attached to over a port is someone else's: what Fanfold did not open there is left alone.
      ...(this.#opts.attachPort ? { foreign: true } : {}),
      busy: () => this.#runtime?.busy ?? false,
      onIdle: () => this.#closeIdle(browser),
    });
    this.#janitor = janitor;
    if (mode === 'extension') this.#wireExtension(browser.client as CdpClient, janitor);
    await janitor.start();
    // The main page is about to be made again: one left from a connection to the user's Chrome that was lost is stale.
    await this.#closeMainTabs(browser.client as CdpClient);
    this.emit({ type: 'browser_started' });
    return browser;
  }

  async #closeMainTabs(client: CdpClient): Promise<void> {
    for (const tab of this.tabs.ownedBy(MAIN)) {
      await client.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      this.tabs.release(tab.targetId);
    }
  }

  /** Something of this browser's is still being worked on, or still waits on the user. */
  #workInProgress(mode: BrowserMode): boolean {
    const now = Date.now();
    if (this.#browserInUse?.mode === mode && this.#runtime?.busy) return true;
    return this.tabs.all(mode).some((tab) => this.tabs.alive(tab.owner) || (tab.keepUntil !== null && Date.parse(tab.keepUntil) > now));
  }

  /**
   * What the extension says about the tabs in the user's Chrome: a tab one of
   * Fanfold's opened belongs to the same work, and a tab the user took back
   * (dragged out, ungrouped, closed) ends the work it belonged to without
   * Fanfold opening it again.
   */
  #wireExtension(client: CdpClient, janitor: Janitor): void {
    client.on('Fanfold.tabOpened', (params) => {
      const targetId = String(params.targetId ?? '');
      const ref = {
        targetId, mode: 'extension' as const,
        chromeTabId: Number.isInteger(params.tabId) ? params.tabId as number : null,
        windowId: Number.isInteger(params.windowId) ? params.windowId as number : null,
        url: typeof params.url === 'string' ? params.url : null,
      };
      const row = this.tabs.get(targetId);
      if (row) this.tabs.claim(ref, row.owner);
      else if (typeof params.openerId === 'string') janitor.noteOpened(ref, params.openerId);
    });
    client.on('Fanfold.tabReleased', (params) => void this.#tabReleased(params).catch((err: unknown) => {
      this.log.warn('could not stop the work of a tab the user took back', { component: 'browser', err });
    }));
  }

  async #tabReleased(params: Record<string, unknown>): Promise<void> {
    const targetId = String(params.targetId ?? '');
    const row = this.tabs.get(targetId);
    if (!row || row.mode !== 'extension' || params.byUser !== true) return;
    // A popup that closed is most often its page closing it, a sign-in window done with: it is let go and the work goes on.
    if ((params.reason === 'closed' || params.reason === 'target_closed') && row.openerTargetId) {
      this.tabs.release(targetId);
      return;
    }
    this.log.info('the user took a tab back from Fanfold', { component: 'browser', owner: row.owner.kind, reason: params.reason });
    await this.stopTab(targetId, { tookBack: true });
  }

  /** The extension's link went down. Work in the user's Chrome waits for it to come back rather than moving. */
  #extensionGone(): void {
    if (this.#shuttingDown) return;
    const inUse = this.#browserInUse?.mode === 'extension' && !!this.#browser;
    if (!inUse && this.#side?.mode !== 'extension') return;
    if (this.#workInProgress('extension')) {
      this.#sticky = 'extension';
      this.log.warn('your Chrome went away while Fanfold was working in it; that work waits for it', { component: 'browser' });
    }
    if (inUse) this.emit({ type: 'browser_closed', reason: 'chrome-gone' });
  }

  /**
   * Each time the extension connects it reports the tabs it opened for
   * Fanfold. Rows for tabs it no longer has are dropped (a row after a
   * Chrome restart would name some other tab), and a tab no work of this
   * Fanfold wants (a crash left it, or its work ended while Chrome was away)
   * is closed, unless it is kept because it waits on the user.
   */
  async #reconcile(tabs: CreatedTab[]): Promise<void> {
    const now = Date.now();
    const reported = new Set(tabs.map((t) => t.targetId));
    for (const row of this.tabs.all('extension')) if (!reported.has(row.targetId)) this.tabs.release(row.targetId);
    const doomed: string[] = [];
    for (const tab of tabs) {
      const row = this.tabs.get(tab.targetId);
      if (!row) {
        doomed.push(tab.targetId);
        continue;
      }
      this.tabs.claim({
        targetId: tab.targetId, mode: 'extension', chromeTabId: Number(tab.targetId.slice('tab-'.length)),
        windowId: tab.windowId, url: tab.url || null,
      }, row.owner, tab.openerId);
      const kept = row.keepUntil !== null && Date.parse(row.keepUntil) > now;
      if (!kept && !this.tabs.alive(row.owner)) doomed.push(tab.targetId);
    }
    if (!doomed.length) return;
    this.log.info('closing tabs Fanfold left in your Chrome', { component: 'extension-bridge', count: doomed.length });
    await this.extension.closeTabs(doomed);
    for (const id of doomed) this.tabs.release(id);
  }

  #inUseSoon(): void {
    if (this.#inUseTimer || this.#shuttingDown) return;
    this.#inUseTimer = setTimeout(() => {
      this.#inUseTimer = null;
      if (this.#shuttingDown) return;
      this.extension.publishInUse(this.tabs.all('extension').map((tab) => ({
        targetId: tab.targetId, url: tab.url ?? '', owner: tab.owner.kind, waiting: tab.keepUntil !== null,
      })));
    }, 100);
    this.#inUseTimer.unref();
  }

  /** "Stop Fanfold here" in the extension's popup: only a tab of Fanfold's in the user's Chrome. */
  async #stopFromChrome(targetId: string): Promise<void> {
    if (this.tabs.get(targetId)?.mode !== 'extension') return;
    await this.stopTab(targetId);
  }

  /** The main page says "waiting" while an approval asked in it waits on the user, and "working" otherwise. */
  #watchMain(): void {
    if (this.#mainWatch) return;
    this.#mainWatch = setInterval(() => void this.#showMainState(), 2_000);
    this.#mainWatch.unref();
  }

  async #showMainState(): Promise<void> {
    const runtime = this.#runtime;
    const page = this.#page;
    if (!runtime?.open || !page || this.#shuttingDown) return;
    // What held "main" can lapse without anyone saying so (a run ended, an agent stopped calling): its tab goes now.
    this.tabs.recheck(MAIN);
    const state = this.#mainWaits() ? 'waiting' : 'working';
    const shown = this.#mainShown?.page === page ? this.#mainShown.state : 'working';
    this.#mainShown = { page, state };
    if (shown !== state) await runtime.indicate(state).catch(() => {});
  }

  #mainWaits(): boolean {
    try {
      return this.approvals.pending().some((a) => this.#mainRuns.has(a.runId) || this.#pages.pageFor(a.runId) === this.#runtime)
        || [...this.#mainRuns].some((runId) => this.#mainAsks(runId));
    } catch {
      return false;
    }
  }

  /**
   * A run in the main page stopped to ask the user something, and it is still
   * the last word: its thread has nothing after the question (or, with no
   * thread, nothing has worked in "main" since). For as long as a kept page is kept.
   */
  #mainAsks(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run || !this.#askedUser(runId)) return false;
    const ended = Date.parse(String(run.ended_at ?? ''));
    if (!(Date.now() - ended < parkedPages.limitMs)) return false;
    if (!run.conversation_id) return this.#mainRunUsed <= ended;
    const [last] = this.store.thread(String(run.conversation_id), 1);
    return !!last && last.awaiting && last.runId === runId;
  }

  /**
   * Whether "main" is still needed: in use, kept by a run that is going or
   * waits on the user, or worked in by one of the app's own tasks within the
   * hold (the agent working there holds it the same way, in mcp/sessions.ts).
   * Nothing else keeps it: after that the only clock is the browser's.
   */
  #mainAlive(): boolean {
    const runtime = this.#runtime;
    if (!runtime || this.#shuttingDown) return false;
    if (runtime.busy || Date.now() - this.#mainRunUsed < mainHold.idleMs || this.#mainWaits()) return true;
    let needed = false;
    for (const runId of this.#mainRuns) {
      const status = this.store.getRun(runId)?.status;
      if (status === 'running' || this.#approvalWaits(runId) || this.#mainAsks(runId)) needed = true;
      else this.#mainRuns.delete(runId);
    }
    return needed;
  }

  /** The main page's tab was closed because nothing needed it: the next use opens a new one. */
  #mainClosed(): void {
    if (this.tabs.ownedBy(MAIN).length || this.tabs.alive(MAIN)) return;
    const page = this.#runtime?.suspend();
    if (!page) return;
    if (page === this.#page) this.#page = null;
    void (page as Page).close?.().catch(() => {});
  }

  /** Approved and not yet carried out counts too: the page must still be there when the press comes. */
  #approvalWaits(runId: string): boolean {
    try {
      return this.approvals.forRun(runId).some((a) => a.status === 'pending' || a.status === 'performing'
        || (a.status === 'approved' && !a.outcome));
    } catch {
      return false;
    }
  }

  /** The run stopped to ask the user something (a question, a bot check) rather than for an approval, which #approvalWaits answers for. */
  #askedUser(runId: string): boolean {
    return this.store.getRun(runId)?.status === 'awaiting_approval' && !this.approvals.forRun(runId).length;
  }

  /**
   * Whether what a run left on a kept page still waits on the user. A page
   * kept for an application waits while the application does, and goes once
   * it is sent or skipped; otherwise it waits on the run's approval, or on
   * the question it stopped to ask.
   */
  #runWaits(runId: string, key: string | null): boolean {
    try {
      const application = key ? this.jobs.application(key) : null;
      if (application?.status === 'applied' || application?.status === 'skipped') return false;
      if (application && APPLICATION_WAITS.has(application.status)) return true;
      if (application?.status === 'queued' && this.#submitting(application.id)) return true;
      return this.#approvalWaits(runId) || this.#askedUser(runId);
    } catch {
      return false;
    }
  }

  /** Approved in Review and waiting its turn to be sent, which continues on its kept page. */
  #submitting(applicationId: string): boolean {
    const queue = this.#submissions?.status();
    return !!queue && (queue.waiting.includes(applicationId) || queue.running.includes(applicationId));
  }

  /** The application's form waits on the user: filled and waiting in Review, or sent with an outcome for them to confirm. */
  applicationWaits(applicationId: string): boolean {
    const status = this.jobs.application(applicationId)?.status;
    return !!status && APPLICATION_WAITS.has(status);
  }

  /** Nothing has used the browser for the idle window and no tab of Fanfold's is open in it: let it go. */
  async #closeIdle(browser: AnyBrowser): Promise<void> {
    if (this.#browser !== browser || this.#ensuring || this.#shuttingDown) return;
    const mode: TabMode = this.browserInUse.mode;
    const runtime = this.#runtime;
    if (runtime?.busy || this.tabs.all(mode).length) {
      this.#janitor?.touch();
      return;
    }
    const page = runtime?.open ? runtime.suspend() : null;
    if (runtime?.open && !page) {
      this.#janitor?.touch();
      return;
    }
    // Let go at once, before anything is awaited, so the next use opens a new browser instead of this one.
    this.#page = null;
    this.#janitor?.stop();
    this.#janitor = null;
    this.#browser = null;
    this.tabs.forget(mode);
    const letting = (async () => {
      await (page as Page | null)?.close?.().catch(() => {});
      await browser.close().catch(() => {});
    })();
    this.#letting = letting;
    await letting;
    if (this.#letting === letting) this.#letting = null;
    this.log.info('closed the browser: nothing used it', { component: 'browser', mode });
    this.emit({ type: 'browser_closed', reason: 'idle' });
  }

  /** Every page open in the running browser, Fanfold's or not; none when no browser runs. */
  async browserPages(): Promise<Array<{ targetId: string; url: string }>> {
    if (!this.browserStarted) return [];
    const { targetInfos } = await (this.#browser!.client as CdpClient)
      .send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets')
      .catch(() => ({ targetInfos: [] }));
    return targetInfos.filter((t) => t.type === 'page').map(({ targetId, url }) => ({ targetId, url }));
  }

  /** The tabs Fanfold has open for its work right now. */
  tabsInUse(): OwnedTab[] {
    const mode = this.browserStarted ? this.browserInUse.mode : null;
    const side = this.#side && !(this.#side.browser.client as CdpClient).closed ? this.#side.mode : null;
    let over = false;
    const tabs = this.tabs.all().filter((tab) => tab.mode === 'sandbox' || tab.mode === mode || tab.mode === side).map((tab) => {
      if (!tab.keepUntil || this.#stillWaits(tab)) return tab;
      // What it was kept for is over (answered, declined, rejected): it says nothing more, and goes at once.
      over = true;
      return { ...tab, keepUntil: null, keepWhy: null };
    });
    if (over) this.settleKeeps();
    return tabs;
  }

  #stillWaits(tab: OwnedTab): boolean {
    if (!tab.keepUntil || Date.parse(tab.keepUntil) <= Date.now()) return false;
    const rule = this.tabs.keepRule(tab.owner);
    try {
      return rule ? rule.waits() : true;
    } catch {
      return false;
    }
  }

  /** Something kept tabs wait on was answered: they are looked at now rather than at the next sweep. */
  settleKeeps(): void {
    if (this.#settling) return;
    this.#settling = (async () => {
      for (const fn of this.#keepWatchers) {
        try { fn(); } catch { /* one watcher failing does not stop the sweep */ }
      }
      await this.#janitor?.sweep('settled').catch(() => {});
      await this.#side?.janitor.sweep('settled').catch(() => {});
    })().finally(() => { this.#settling = null; });
  }

  #settling: Promise<void> | null = null;
  readonly #keepWatchers = new Set<() => void>();

  /** Who else keeps tabs for the user (the agents' sessions), told when what they wait on may have been answered. */
  onKeepsChanged(fn: () => void): () => void {
    this.#keepWatchers.add(fn);
    return () => this.#keepWatchers.delete(fn);
  }

  /**
   * The user stopped Fanfold in one tab: the work it belongs to ends (a
   * session closes, a run's tab closes and its page may not open another).
   * With `tookBack`, the user took the tab itself back (dragged it out of
   * Fanfold's group, say): it is let go first, so ending the work leaves it
   * where it is. Returns that work, or null for a tab that is not Fanfold's.
   */
  async stopTab(targetId: string, opts: { tookBack?: boolean } = {}): Promise<Owner | null> {
    const owner = this.tabs.ownerOf(targetId);
    if (!owner) return null;
    if (opts.tookBack) this.tabs.release(targetId);
    await this.tabs.stopOwner(owner);
    if (sameOwner(owner, MAIN)) await this.#stopMain();
    await this.#janitor?.sweep('stopped');
    await this.#side?.janitor.sweep('stopped');
    this.emit({ type: 'tab_stopped', owner, targetId, ...(opts.tookBack ? { tookBack: true } : {}) });
    return owner;
  }

  /** The user stopped everything: every worker and every piece of work with a tab open. */
  async stopEverything(): Promise<number> {
    this.stopWorker();
    const owners = new Map<string, Owner>();
    for (const tab of this.tabs.all()) owners.set(`${tab.owner.kind}:${tab.owner.id}`, tab.owner);
    for (const owner of owners.values()) {
      await this.tabs.stopOwner(owner);
      if (sameOwner(owner, MAIN)) await this.#stopMain();
      this.emit({ type: 'tab_stopped', owner });
    }
    await this.#janitor?.sweep('stopped');
    return owners.size;
  }

  /** "main" was stopped: its tab closes now, and the next task starts in a new one. */
  async #stopMain(): Promise<void> {
    const page = this.#runtime?.suspend();
    if (page === this.#page) this.#page = null;
    await (page as Page | null)?.close?.().catch(() => {});
  }

  /** Keep the main page open for the person who was just shown it, for `ms`. */
  keepMain(ms: number, why: string = COPY.shownToYou): void {
    this.tabs.keepOwner(MAIN, new Date(Date.now() + ms), why);
  }

  /**
   * The browser for a choice: Fanfold's own window; the user's Chrome, and
   * nothing else, when they chose it (or when work was going on in it); or,
   * on Automatic, their Chrome when the extension is paired and connects
   * within 8 s and Fanfold's window otherwise. Why is kept so it can be said.
   */
  async #openBrowser(sticky: BrowserMode | null = null): Promise<AnyBrowser> {
    if (this.#opts.attachPort) {
      this.#browserInUse = { mode: 'dedicated', fallback: null, why: COPY.whyAttached };
      return connectToChrome({ port: this.#opts.attachPort });
    }
    const choice: BrowserChoice = sticky ?? this.browserMode;
    const side = this.#side;
    // A browser of this kind is already open for a worker: it becomes the main one, rather than a second on the same profile or link.
    if (side && side.mode === (choice === 'auto' ? 'extension' : choice) && !(side.browser.client as CdpClient).closed) {
      this.#side = null;
      side.janitor.stop();
      this.#browserInUse = side.mode === 'extension'
        ? { mode: 'extension', fallback: null, why: choice === 'auto' ? COPY.whyAuto : COPY.whyExtension }
        : { mode: 'dedicated', fallback: null, why: COPY.whyDedicated };
      this.#browserProblem = null;
      return side.browser;
    }
    let fallback: string | null = null;
    if (choice !== 'dedicated') {
      try {
        const browser = await this.#connectExtension();
        this.#browserInUse = { mode: 'extension', fallback: null, why: choice === 'auto' ? COPY.whyAuto : COPY.whyExtension };
        this.#browserProblem = null;
        return browser;
      } catch (err) {
        fallback = (err as Error).message.replace(/\.$/, '');
      }
      if (choice === 'extension') {
        const message = (sticky ? COPY.chromeGone : COPY.noChrome).replace('{reason}', fallback);
        this.#browserProblem = message;
        this.log.warn('your Chrome is not there, and Fanfold does not move to its own window by itself', { component: 'browser', why: fallback });
        throw new Error(message);
      }
      this.log.warn('using the Fanfold window instead of your Chrome', { component: 'browser', why: fallback });
    }
    this.#browserInUse = {
      mode: 'dedicated', fallback,
      why: fallback ? COPY.whyAutoFallback.replace('{reason}', fallback) : COPY.whyDedicated,
    };
    this.#browserProblem = null;
    return this.#launchDedicated();
  }

  /** The user's Chrome through the extension. Throws, with the reason in words, when it is not there within 8 s. */
  async #connectExtension(): Promise<AnyBrowser> {
    const status = this.extension.status();
    if (!status.listening) throw new Error(COPY.linkDown);
    if (!status.paired) throw new Error(COPY.notPaired);
    // What Fanfold opened in their Chrome closes with it; their own tabs never do.
    return connectViaExtension(this.extension, { waitMs: EXTENSION_WAIT_MS, closeTabsOnClose: true });
  }

  #launchDedicated(): Promise<AnyBrowser> {
    return launchChrome({
      profileDir: this.#opts.profileDir ?? defaultProfileDir(),
      headless: this.#opts.headless ?? false,
      ...(this.#opts.cdpTimeoutMs ? { timeoutMs: this.#opts.cdpTimeoutMs } : {}),
    });
  }

  /** Where the user asked Fanfold to work. */
  get browserMode(): BrowserChoice {
    const chosen = this.store.setting<string>('browserMode', 'dedicated');
    return chosen === 'extension' || chosen === 'auto' ? chosen : 'dedicated';
  }

  /** Where it is working, and why there. */
  get browserInUse(): BrowserInUse {
    return this.#browserInUse ?? { mode: 'dedicated', fallback: null, why: null };
  }

  /** Why the browser asked for could not be opened the last time one was needed, or null. */
  get browserProblem(): string | null {
    return this.#browserProblem;
  }

  /**
   * Change where Fanfold works. The browser in use is let go, and the next
   * thing that needs one opens the right kind. Their Chrome is never closed.
   */
  async setBrowserMode(mode: BrowserChoice): Promise<void> {
    // Choosing the mode already chosen still counts when Fanfold fell back from
    // it (the extension was not there at start, and is now).
    const inUse = this.#browserInUse;
    const workingThere = mode === 'auto' ? !inUse?.fallback : (inUse?.mode ?? mode) === mode;
    if (mode === this.browserMode && workingThere) return;
    this.store.setSetting('browserMode', mode);
    this.#browserProblem = null;
    this.#sticky = null;
    const previous: TabMode = this.browserInUse.mode;
    this.#runtime?.suspend();
    this.#janitor?.stop();
    this.#janitor = null;
    await this.#page?.close().catch(() => {});
    await this.#browser?.close().catch(() => {});
    this.tabs.forget(previous);
    this.#page = null;
    this.#browser = null;
    this.#browserInUse = null;
    this.emit({ type: 'browser_mode', wanted: mode });
  }

  /** Start listening for the extension. A port in use is reported, not fatal. */
  async startExtensionBridge(): Promise<number | null> {
    try {
      return await this.extension.start();
    } catch (err) {
      this.log.warn('could not listen for the extension', { component: 'extension-bridge', err });
      return null;
    }
  }

  /** True when Fanfold's Chrome has no window: nobody can watch it, or show it anything. */
  get headless(): boolean {
    return this.#opts.headless ?? false;
  }

  /** Whether this process can call a model of its own. A host that brings its own needs none. */
  get modelConfigured(): boolean {
    return this.model.configured;
  }

  /** Where Fanfold's own model comes from, and the last four characters of a key the person saved (never the key). */
  get modelSource(): { source: ModelSourceKind; hint: string | null } {
    return { source: this.#modelKind, hint: this.#modelHint };
  }

  /** Keep the person's own Gemini key and use it from now on, with no restart. Alpha only: goes when plans arrive. */
  async saveModelKey(key: string): Promise<void> {
    await this.secrets.set(GEMINI_KEY_SECRET, key);
    await this.#resolveModel();
    this.emit({ type: 'setup_changed' });
  }

  /** Forget the person's own key: what .env configures is used again, or nothing. */
  async removeModelKey(): Promise<void> {
    this.secrets.delete(GEMINI_KEY_SECRET);
    await this.#resolveModel();
    this.emit({ type: 'setup_changed' });
  }

  /** Put the model source in use. At start only a saved key changes anything: .env is what the client was made with. */
  async #resolveModel(starting = false): Promise<void> {
    const turn = ++this.#modelTurn;
    let source: ModelSource;
    try {
      source = await modelSource({ secrets: this.secrets, envKey: this.#opts.apiKey });
    } catch (err) {
      // A Keychain that will not open leaves what .env configures in use.
      this.log.warn('could not read the saved model key', { err });
      source = await modelSource({ secrets: { get: async () => null }, envKey: this.#opts.apiKey });
    }
    // A later save or removal has the last word.
    if (turn !== this.#modelTurn) return;
    this.#modelKind = source.kind;
    this.#modelHint = source.kind === 'yours' ? source.apiKey.slice(-4) : null;
    if (starting && source.kind !== 'yours') return;
    this.model.use(source);
    forgetHealth(this.model);
  }

  /** Tie a run to the page it is working on. Returns how to untie it. */
  bindRun(runId: string, page: BrowserRuntime): () => void {
    return this.#pages.bind(runId, page);
  }

  /** The page a run works on, or null when it is gone, such as a session window that was closed. */
  pageForRun(runId: string): BrowserRuntime | null {
    return this.#pages.pageFor(runId);
  }

  /** Keep a run's page open for the person who has to come back to it; with `applicationId`, as that application's one page. */
  parkRun(runId: string, tab: Tab, applicationId?: string): void {
    this.#pages.park(runId, tab, applicationId ? { key: applicationId } : {});
  }

  /** The page kept for an application, handed to a run that continues on it; null when none is kept. */
  takeApplicationPage(applicationId: string): Tab | null {
    return this.#pages.take(applicationId);
  }

  /** The page kept for an application, or null. */
  applicationPage(applicationId: string): BrowserRuntime | null {
    return this.#pages.pageForKey(applicationId);
  }

  parkedRuns(): string[] {
    return this.#pages.parked();
  }

  releaseRun(runId: string): Promise<void> {
    return this.#pages.release(runId);
  }

  /**
   * Sub-agents in parallel, each a run composed like every other. They are
   * given no delegator of their own, so the fan-out is one level deep.
   */
  delegator(policy: PolicyContext = this.policy()): Delegator {
    return async (a) => {
      let delegation = this.#delegations.get(a.threadId);
      if (!delegation) {
        delegation = new Delegation({
          openPage: async () => {
            // The sub-task's first page is opened before its run, under the same pace and pauses.
            const tab = await this.openTab();
            return { page: guardRun(tab.page, { sites: this.sites, log: this.log }), close: () => tab.close() };
          },
          run: async (r) => runTask({
            ...(await this.runContext()), delegate: undefined,
            // The lead model wrote this goal: a value in it is not the user's word.
            goal: r.goal, goalFromUser: false, page: r.page, conversation: r.conversation, signal: r.signal, onEvent: r.onEvent,
            policy, maxSteps: 30,
          }),
          bindRun: (runId, page) => this.bindRun(runId, page),
          park: (runId, tab, key) => this.#pages.park(runId, tab, key ? { key } : {}),
          take: (key) => this.#pages.take(key),
          checkpointer: this.checkpoints,
        });
        this.#delegations.set(a.threadId, delegation);
      }
      const outcome = await delegation.run(a);
      if (outcome.status !== 'needs_answer') this.#delegations.delete(a.threadId);
      return outcome;
    };
  }

  /**
   * Everything a run needs, assembled in ONE place.
   *
   * There are three entry points — the chat, a manually triggered worker, and
   * the scheduler. Composed separately, one that left out memory, the
   * governor or capabilities would make the same task behave differently
   * depending on how it was started: a chat that cannot see an imported
   * résumé, or a manual worker run that escapes the limits a scheduled one obeys.
   */
  async runContext(): Promise<{
    model: ModelClient; store: Store; memory: Memory; approvals: Approvals;
    governor: RateGovernor; capabilities: Capabilities; tools: AgentTools;
    objectives: Objectives; jobs: Jobs; profile: Profile; sites: SitePolicies; workers: Workers;
    delegate: Delegator; guard: RunGuardOptions;
    answering: { questions: Questions; intents: QuestionIntents; careers: CareerRecords; model: ModelLike | null };
    resume: () => { id: string; title: string } | null;
  }> {
    return {
      model: this.model,
      store: this.store,
      memory: this.memory,
      approvals: this.approvals,
      governor: this.governor,
      capabilities: this.capabilities,
      objectives: this.objectives,
      jobs: this.jobs,
      profile: this.profile,
      sites: this.sites,
      workers: this.workers,
      tools: await this.tools(),
      delegate: this.delegator(),
      // A site that pushes back on a run is logged as it is for an MCP session.
      guard: { log: this.log },
      answering: { questions: this.questions, intents: this.intents, careers: this.careers, model: this.answerModel },
      // The one document that is the résumé: what an application's résumé field is given.
      resume: () => this.resumeDocument(),
    };
  }

  /** The policy context every run is judged against. One place, like runContext(). */
  policy(workerId?: string | null): PolicyContext {
    return {
      capabilities: this.capabilities, gate: this.approvalGate, workerId: workerId ?? null, sites: this.sites,
      viaExtension: () => this.browserInUse.mode === 'extension',
    };
  }

  /**
   * Turn a worker on. The user does this, never the agent.
   *
   * Autonomy becomes a grant: scoped to this worker, to the hosts of the
   * sites it was given where the catalog allows automatic submission, to
   * CONTACT_EXTERNAL, for thirty days, with a use budget of a month of its
   * daily cap. Review-everything workers get no grant and stop at Review.
   * Sites the catalog marks prepare-only never appear in the grant, so no
   * autonomy level reaches a Submit on LinkedIn or Indeed.
   */
  enableWorker(id: string): { worker: ReturnType<Workers['get']>; grantId: string | null } {
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`no such worker: ${id}`);
    for (const cap of this.capabilities.list()) {
      if (cap.workerId === id) this.capabilities.revoke(cap.id, 'worker settings changed');
    }
    let grantId: string | null = null;
    if (worker.autonomy !== 'review_all') {
      const domains = worker.sites
        .filter((s) => s.enabled)
        .flatMap((s) => this.sites.get(s.site)?.submit === 'auto' ? this.sites.get(s.site)!.hosts : []);
      if (domains.length) {
        grantId = this.capabilities.grant({
          label: `worker:${worker.name}`, workerId: id, domains,
          sensitivities: ['CONTACT_EXTERNAL'], actionKinds: ['click', 'press'],
          maxUses: Math.max(1, worker.caps.dailyTotal) * GRANT_DAYS,
          expiresAt: new Date(Date.now() + GRANT_DAYS * 86_400_000).toISOString(),
        }).id;
      }
    }
    this.workers.setStatus(id, 'active', null);
    return { worker: this.workers.get(id), grantId };
  }

  /** Pause a worker: the scheduler skips it and its grant is revoked. */
  pauseWorker(id: string, reason = 'paused by you'): void {
    for (const cap of this.capabilities.list()) if (cap.workerId === id) this.capabilities.revoke(cap.id, reason);
    this.workers.setStatus(id, 'paused', reason);
  }

  removeWorker(id: string): boolean {
    for (const cap of this.capabilities.list(true)) if (cap.workerId === id && !cap.revokedAt) this.capabilities.revoke(cap.id, 'worker deleted');
    return this.workers.remove(id);
  }

  /**
   * Which connector provider is configured.
   *
   * Composio is preferred when its key is present: it holds the OAuth
   * relationship (its own Google project, consent screens and token refresh),
   * which removes the restricted-scope verification and on-device refresh
   * tokens that made the direct path expensive to ship. The direct Google
   * path remains for anyone who set up their own OAuth client.
   */
  connectorProvider(): 'composio' | 'google' | null {
    if (process.env.COMPOSIO_API_KEY) return 'composio';
    if (process.env.GOOGLE_CLIENT_ID) return 'google';
    return null;
  }

  /** The Composio client, when configured. One local install is one Composio user. */
  get composio(): ComposioClient | null {
    if (!process.env.COMPOSIO_API_KEY) return null;
    this.#composio ??= new ComposioClient({
      apiKey: process.env.COMPOSIO_API_KEY,
      userId: process.env.COMPOSIO_USER_ID ?? 'browser-agent-local',
      baseUrl: process.env.COMPOSIO_BASE_URL || undefined,
      authConfigIds: {
        [TOOLKITS.gmail]: process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID || undefined,
        [TOOLKITS.calendar]: process.env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID || undefined,
        [TOOLKITS.linkedin]: process.env.COMPOSIO_LINKEDIN_AUTH_CONFIG_ID || undefined,
      },
    });
    return this.#composio;
  }

  /** Composio accounts for this user across both toolkits, newest first. */
  async composioAccounts(): Promise<ConnectedAccount[]> {
    const client = this.composio;
    if (!client) return [];
    const [gmail, calendar, linkedin] = await Promise.all([
      client.accounts(TOOLKITS.gmail), client.accounts(TOOLKITS.calendar),
      // An account that cannot list one toolkit still has the others.
      client.accounts(TOOLKITS.linkedin).catch(() => []),
    ]);
    return [...gmail, ...calendar, ...linkedin];
  }

  /** Start consent for one toolkit through Composio. */
  async startComposioConnection(toolkit: ToolkitSlug): Promise<{ redirectUrl: string; connectedAccountId: string }> {
    const client = this.composio;
    if (!client) throw new Error('Composio is not configured — set COMPOSIO_API_KEY in .env');
    return client.startConnection(toolkit);
  }

  /** The direct Google path's OAuth client, made once; null when no client id is configured. */
  #google(): GoogleAuth | null {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return null;
    this.#googleAuth ??= new GoogleAuth({ clientId, clientSecret: process.env.GOOGLE_CLIENT_SECRET }, this.secrets);
    return this.#googleAuth;
  }

  /**
   * Connector actions the agent may use right now.
   *
   * Resolved per run rather than cached, so connecting or disconnecting an
   * account takes effect on the next task instead of on the next restart.
   * Returns nothing when Google is unconfigured or not yet authorised, and
   * the loop then refuses those actions as unavailable rather than failing
   * as though the browser broke.
   */
  async tools(): Promise<AgentTools> {
    if (this.connectorProvider() === 'composio') {
      const client = this.composio!;
      const accounts = await this.composioAccounts();
      const gmail = accounts.find((a) => a.toolkit === TOOLKITS.gmail && a.status === 'ACTIVE');
      const calendar = accounts.find((a) => a.toolkit === TOOLKITS.calendar && a.status === 'ACTIVE');
      const linkedin = accounts.find((a) => a.toolkit === TOOLKITS.linkedin && a.status === 'ACTIVE');
      return {
        ...(gmail || calendar ? googleTools({
          gmail: gmail ? new ComposioGmail(client, gmail.id) : undefined,
          calendar: calendar ? new ComposioCalendar(client, calendar.id) : undefined,
          // Gated on what the accounts' scopes cover, fail-closed on drafting.
          scopes: scopesFromAccounts(accounts),
        }) : {}),
        ...(linkedin ? linkedinTools(new ComposioLinkedIn(client, linkedin.id)) : {}),
      };
    }

    const google = this.#google();
    if (!google) return {};
    // Gated on what the token actually grants, not on whether one exists. A
    // user can decline individual scopes on Google's consent screen, and a
    // token minted before drafting was enabled does not acquire the scope
    // because the app now asks for it.
    const scopes = await google.grantedScopes();
    if (!scopes.size) return {}; // configured but not connected, or no usable grant

    return googleTools({
      gmail: new Gmail(google),
      calendar: new Calendar(google),
      scopes,
    });
  }

  /** What the connected Google account currently permits. */
  async googleScopes(): Promise<string[]> {
    if (this.connectorProvider() === 'composio') return [...scopesFromAccounts(await this.composioAccounts())];
    const google = this.#google();
    return google ? [...(await google.grantedScopes())] : [];
  }

  /**
   * Call Google for real and report what happened.
   *
   * Separate from `googleScopes()` on purpose: a scope list says what a token
   * would permit, and this says whether the API actually answers. They
   * disagree whenever the API is disabled in the Cloud project, the grant was
   * revoked from the account, or the client is still in testing. Costs two
   * cheap reads, so it is called on demand rather than on every status poll.
   */
  async checkGoogle(): Promise<Reachability | null> {
    if (this.connectorProvider() === 'composio') {
      return checkComposioReachable(this.composio!, await this.composioAccounts());
    }
    const google = this.#google();
    return google ? await checkReachable(google) : null;
  }

  /**
   * Start the loop that makes scheduled workers actually recur.
   *
   * Holds a database lease, so a second process — another window, a CLI, a
   * daemon restarted before the old one exited — stands down rather than
   * running every slot twice.
   */
  startScheduler(opts: {
    intervalMs?: number;
    learnEveryMs?: number;
    onRun?: (s: unknown) => void;
    onLearned?: (r: unknown) => void;
  } = {}): Scheduler {
    if (this.#scheduler) return this.#scheduler;
    this.#scheduler = new Scheduler({
      db: this.db,
      workers: this.workers,
      intervalMs: opts.intervalMs ?? 30_000,
      // Each worker's run opens a tab of its own, so due workers need not queue behind each other.
      concurrency: WORKERS_AT_ONCE,
      onRun: (summary) => {
        this.log.info('worker run finished', {
          component: 'scheduler', workerId: summary.workerId, workerRunId: summary.workerRunId, runId: summary.runId,
          status: summary.status, steps: summary.steps, costUsd: summary.costUsd,
        });
        opts.onRun?.(summary);
      },
      onError: (workerId, err) => this.log.error('worker failed', { component: 'scheduler', workerId, err }),
      // Six hours by default. Reflection costs a baseline plus a full eval
      // suite per candidate, so it is a scheduled job rather than something
      // that happens while a user waits — but it does have to happen without
      // anyone pressing a button.
      learnEveryMs: opts.learnEveryMs ?? 6 * 60 * 60 * 1000,
      learn: (signal) => learnFromRuns({ model: this.model, store: this.store, memory: this.memory, signal }),
      onLearned: (r) => opts.onLearned?.(r),
      context: (workerId) => this.workerContext(workerId),
      // Nothing runs by itself while Fanfold is locked.
      held: () => this.locked,
    });
    this.#scheduler.start();
    return this.#scheduler;
  }

  get scheduler(): Scheduler | null {
    return this.#scheduler;
  }

  /**
   * Everything one worker run needs, the same for a scheduled run and one
   * started by hand: a tab of its own, sub-agents held to the worker's
   * policy, a way to stop it, and its steps published as they happen.
   */
  async workerContext(workerId: string): Promise<Omit<TickOptions, 'workers' | 'workerId' | 'now'>> {
    let mode: BrowserMode | null = null;
    return {
      ...(await this.runContext()),
      gate: this.approvalGate,
      // A thunk, not the getter: on a fresh app `page` throws until the
      // browser exists, and a pass that only records a skip needs none.
      page: () => this.startBrowser(),
      openTab: async () => {
        const opened = await this.#workerTab(workerId);
        mode = opened.mode;
        return opened.tab;
      },
      viaExtension: () => mode === 'extension',
      park: (runId, tab) => this.parkRun(runId, tab),
      delegatorFor: (policy) => this.delegator(policy),
      control: this.#runs.control(workerId),
      onEvent: (event) => this.emit({ type: 'worker_step', workerId, event }),
    };
  }

  /**
   * A tab for a worker's run, in the browser its settings ask for: Fanfold's
   * window, the user's Chrome, or on Automatic their Chrome when it is there.
   * A worker on a site whose terms rule the extension out keeps to Fanfold's
   * window on Automatic. The app's own browser is used when it is that kind;
   * otherwise a second browser of that kind is opened, and let go once no
   * worker has used it for the idle window.
   */
  async #workerTab(workerId: string): Promise<{ tab: Tab; mode: BrowserMode }> {
    const worker = this.workers.get(workerId);
    let want: BrowserChoice = worker?.browserMode ?? 'auto';
    if (want === 'auto' && worker?.sites.some((s) => s.enabled && this.sites.get(s.site)?.extensionAllowed === false)) want = 'dedicated';
    if (want !== 'auto') return this.#tabIn(want);
    const running = this.browserStarted ? this.browserInUse.mode : null;
    if (running === 'extension' || (running === null && this.browserMode === 'auto')) return this.#mainTab();
    try {
      return await this.#tabIn('extension');
    } catch {
      return await this.#tabIn('dedicated');
    }
  }

  async #tabIn(mode: BrowserMode): Promise<{ tab: Tab; mode: BrowserMode }> {
    const running = this.browserStarted ? this.browserInUse.mode : null;
    if (running === mode || (running === null && this.browserMode === mode)) return this.#mainTab();
    return { tab: await this.#sideTab(mode), mode };
  }

  async #mainTab(): Promise<{ tab: Tab; mode: BrowserMode }> {
    const tab = await this.openTab();
    return { tab, mode: this.browserInUse.mode };
  }

  /** A new tab of its own in the app's browser, which is started first when it is not running. */
  async openTab(): Promise<Tab> {
    const page = await this.startBrowser();
    if (!page.openTab) throw new Error('this browser cannot open more tabs');
    return page.openTab();
  }

  /** A tab in the second browser, owned by the run it is opened for, as Page.openTab does it. */
  async #sideTab(mode: BrowserMode): Promise<Tab> {
    const side = await this.#ensureSide(mode);
    const client = side.browser.client as CdpClient;
    const owner: Owner = { kind: 'run', id: currentRun() ?? randomUUID() };
    let page: Page | null = null;
    let targetId: string | null = null;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await page?.close().catch(() => {});
      // A tab the ledger let go of is no longer Fanfold's to close (the user took it back).
      if (targetId && this.tabs.get(targetId)) await client.send('Target.closeTarget', { targetId }).catch(() => {});
      end();
    };
    const end = this.tabs.begin(owner, close);
    try {
      targetId = await createTargetWithRetry(client, { owner });
      page = await Page.attach(client, targetId, { owner });
    } catch (err) {
      await close();
      throw err;
    }
    side.janitor.touch();
    return { page, close, owner };
  }

  #ensureSide(mode: BrowserMode): Promise<SideBrowser> {
    const current = this.#side;
    if (current && current.mode === mode && !(current.browser.client as CdpClient).closed) return Promise.resolve(current);
    this.#sideOpening ??= (async () => {
      if (current) await this.#closeSide(current);
      // The main browser may be quitting, still holding the profile.
      await this.#letting;
      const browser = mode === 'extension' ? await this.#connectExtension() : await this.#launchDedicated();
      const client = browser.client as CdpClient;
      const side = { mode, browser } as SideBrowser;
      side.janitor = new Janitor({ client, ledger: this.tabs, mode, log: this.log, onIdle: () => this.#closeSide(side) });
      if (mode === 'extension') this.#wireExtension(client, side.janitor);
      await side.janitor.start();
      this.#side = side;
      return side;
    })().finally(() => { this.#sideOpening = null; });
    return this.#sideOpening.then((side) => (side.mode === mode ? side : this.#ensureSide(mode)));
  }

  async #closeSide(side: SideBrowser): Promise<void> {
    if (this.#side === side) this.#side = null;
    side.janitor.stop();
    await side.browser.close().catch(() => {});
  }

  /** Run a worker now, in the background. One that is not turned on runs dry. */
  runWorkerNow(workerId: string): { started: boolean; why?: string } {
    return this.#runs.start(workerId);
  }

  activeWorkerRuns(): Array<{ workerId: string; workerRunId: string | null }> {
    return this.#runs.active();
  }

  /** Stop what a worker is doing right now. Returns how many runs were told to stop. */
  stopWorker(workerId?: string): number {
    return this.#runs.stop(workerId);
  }

  /** Teaching a flow by showing it once. */
  get teaching(): Teaching {
    this.#teaching ??= new Teaching({
      openTab: () => this.openTab(),
      memory: this.memory,
      emit: (event) => this.emit(event),
    });
    return this.#teaching;
  }

  /** Applications approved in Review, on their way out. */
  get submissions(): Submissions {
    this.#submissions ??= new Submissions(this);
    return this.#submissions;
  }

  /** What reads documents into the profile: Fanfold's own model when it has one, else patterns alone. */
  get profileModel(): ModelLike | null {
    if (this.#opts.profileModel !== undefined) return this.#opts.profileModel;
    return this.modelConfigured ? this.model : null;
  }

  /** What reads résumés into career records, classifies wordings, checks answers and drafts essays; null when Fanfold has no model. */
  get answerModel(): ModelLike | null {
    if (this.#opts.answerModel !== undefined) return this.#opts.answerModel;
    return this.profileModel;
  }

  /** Everything the answerer reads, for one call. */
  answerDeps(signal?: AbortSignal): AnswerDeps {
    return {
      profile: this.profile, jobs: this.jobs, memory: this.memory, intents: this.intents, careers: this.careers,
      model: this.answerModel, log: this.log, signal, draftFailed: () => this.#draftAgainLater(),
    };
  }

  #draftTimer: NodeJS.Timeout | null = null;
  #draftTries = 0;

  /**
   * A draft the model failed to write is tried again by the sweep, a little
   * later each time it fails again, so a provider that is down for a while is
   * not called every few seconds. A sweep that drafts without failing starts over.
   */
  #draftAgainLater(): void {
    if (this.#closing || this.#draftTimer) return;
    const delays = this.#opts.draftRetryMs ?? DRAFT_RETRY_MS;
    const wait = delays[Math.min(this.#draftTries, delays.length - 1)];
    this.#draftTries++;
    this.#draftTimer = setTimeout(() => {
      this.#draftTimer = null;
      const tries = this.#draftTries;
      void this.resolveQuestions().then(() => { if (this.#draftTries === tries && !this.#draftTimer) this.#draftTries = 0; });
    }, wait);
    this.#draftTimer.unref?.();
  }

  /** The career read from every document the owner gave or said is theirs, merged; null when none has been read. */
  async career(): Promise<CareerRecord | null> {
    return careerOf({ memory: this.memory, careers: this.careers });
  }

  readonly #filling = new Set<Promise<unknown>>();

  /**
   * Read a document the user gave into their profile and their career
   * record. It never throws, so an import never fails for it; the page hears
   * when the profile changed.
   */
  fillProfileFrom(documentId: string): Promise<FillResult | null> {
    return this.#readDocument(documentId).profile;
  }

  /** Both readings of one document, once each has finished: what "Read my documents again" reports. */
  async readDocument(documentId: string): Promise<DocumentReading> {
    const r = this.#readDocument(documentId);
    return { profile: await r.profile, career: await r.career };
  }

  #readDocument(documentId: string): { profile: Promise<FillResult | null>; career: Promise<Reading> } {
    // Whose it is comes first: somebody else's résumé is read into nothing of the user's.
    const run = this.judgeDocument(documentId).catch(() => null).then(() => this.#readProfile(documentId));
    const read = run.then(() => this.#readCareer(documentId));
    // The page hears once both readings of a document are done, so "adding it to your profile" can say it has.
    void read.then((r) => this.emit({ type: 'document_read', id: documentId, by: r.by, problem: r.problem }));
    for (const p of [run, read]) {
      this.#filling.add(p);
      void p.finally(() => this.#filling.delete(p));
    }
    return { profile: run, career: read };
  }

  /**
   * Whose a document is, judged from its text and the name on the profile.
   * A file an agent added waits while it is not plainly the user's; once it
   * names them (the name may have been saved since) it is theirs, with no
   * button to press. A résumé headed with another person's name is kept out
   * of the user's facts and career until they say it is theirs anyway. Never
   * throws for a document that is gone.
   */
  async judgeDocument(documentId: string): Promise<'gone' | 'held' | 'theirs' | 'someone_else'> {
    const doc = this.memory.listDocuments({ includeHeld: true }).find((d) => d.id === documentId);
    if (!doc) { this.owners.forget(documentId); return 'gone'; }
    const name = this.#savedName();
    const whole = doc.chunks ? await this.memory.documentText(documentId, { includeHeld: true }) : null;
    const text = whole ? readerText(whole).text : '';
    if (doc.held) {
      const why = text ? importHold(name, doc.title, text) : doc.held;
      if (why !== null) {
        if (why !== doc.held) this.memory.holdDocument(documentId, why);
        return 'held';
      }
      if (this.memory.releaseDocument(documentId)) {
        this.memory.trustDocument(documentId);
        this.emit({ type: 'document_allowed', id: documentId });
      }
    } else if (!doc.trusted && text && whoseText(name, text.slice(0, 3000)).startsWith('names ')) {
      // Only an agent's file is not the owner's from the start: one that names the user is theirs, allowed or never held.
      this.memory.trustDocument(documentId);
      this.emit({ type: 'document_allowed', id: documentId });
    }
    const other = this.owners.mineAnyway(documentId) ? null : someoneElse(name, doc.title, text);
    const was = this.owners.otherName(documentId);
    this.owners.judged(documentId, other);
    if (other && other !== was) {
      // What was read from it before it was known to be someone else's goes.
      if (this.careers.get(documentId)) { this.careers.delete(documentId); this.#sweepSoon(); }
      this.profile.dropDocumentFacts(documentId);
      if (this.profile.resumeId() === documentId) this.profile.setResume(null);
    }
    // The first of the user's own files that reads as a résumé is the résumé, however it came: setup, Profile or an agent.
    const chosen = this.profile.resumeId();
    const resumeLike = (namedLikeACv(doc.title) && !/cover/i.test(doc.title)) || hasCvSections(text);
    if (!other && (chosen === null || (chosen === undefined && !this.resumeDocument())) && resumeLike && this.memory.documentTrusted(documentId)) {
      this.profile.setResume(documentId);
    }
    return other ? 'someone_else' : 'theirs';
  }

  /** The user says a document is theirs, whatever name it carries: what it says about them may answer applications. False when there is none. */
  mineAnyway(documentId: string): boolean {
    if (!this.memory.trustDocument(documentId)) return false;
    this.owners.setMineAnyway(documentId);
    this.emit({ type: 'document_allowed', id: documentId });
    void this.fillProfileFrom(documentId);
    return true;
  }

  /** The document that is the user's résumé, when one is. */
  resumeDocument(): { id: string; title: string } | null {
    const docs = this.memory.listDocuments();
    const chosen = this.profile.resumeId();
    const d = chosen !== undefined ? docs.find((x) => x.id === chosen && x.trusted)
      : docs.filter((x) => x.chunks > 0 && x.trusted).sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0];
    return d ? { id: d.id, title: d.title } : null;
  }

  /**
   * A document is removed, with what was read from it. A fact it gave that
   * another of the user's documents states word for word is credited to that
   * one and stays ready to use. What named it as the résumé follows
   * `replacedBy`: a worker's settings and an application not sent yet now
   * name the new résumé, or none; one already sent keeps the old file's name.
   */
  async removeDocument(documentId: string, replacedBy: { id: string; title: string } | null = null): Promise<void> {
    const title = this.memory.listDocuments({ includeHeld: true }).find((d) => d.id === documentId)?.title ?? '';
    const texts: Array<{ id: string; title: string; text: string }> = [];
    for (const d of this.memory.listDocuments()) {
      if (d.id === documentId || !d.trusted || !d.chunks || this.owners.otherName(d.id)) continue;
      const t = await this.memory.documentText(d.id).catch(() => null);
      if (t) texts.push({ id: d.id, title: d.title, text: readerText(t).text });
    }
    this.memory.deleteDocument(documentId);
    // What was read from it goes with it: its career record answers nothing once the document is gone.
    this.careers.delete(documentId);
    this.owners.forget(documentId);
    if (this.profile.resumeId() === documentId) this.profile.setResume(null);
    this.profile.forgetDocument(documentId, (_field, value) => {
      const d = texts.find((x) => appearsIn(value, x.text));
      return d ? { documentId: d.id, title: d.title } : null;
    });
    // Nothing is left naming a file that is gone: a worker or a waiting application would otherwise fail on it.
    if (this.jobs.documentGone(documentId, title, replacedBy)) this.emit({ type: 'application_changed' });
    let workers = 0;
    for (const w of this.workers.list()) {
      if (w.documents.resumeId !== documentId) continue;
      this.workers.update(w.id, { documents: { ...w.documents, resumeId: replacedBy?.id ?? null } });
      workers++;
    }
    if (workers) this.emit({ type: 'worker_changed' });
    this.emit({ type: 'document_removed', id: documentId });
    this.#sweepSoon();
  }

  /** The user's name as forms may use it: a proposal read from a document that is gone is nobody's word. */
  #savedName(): string | undefined {
    const f = this.profile.fact('name');
    return f?.usable ? f.value : undefined;
  }

  /** The name the documents were last judged against. */
  #judgedName: string | undefined;
  #rejudgeTimer: NodeJS.Timeout | null = null;
  #profileNoteTimer: NodeJS.Timeout | null = null;
  /** When the page was last told the profile changed, so a change it was already told of is not said twice. */
  #profileToldAt = 0;

  /**
   * The profile changed, perhaps by an agent's hand: the page hears of it. A
   * new name means every document is judged again against it, files held for
   * want of one included.
   */
  #profileMoved(): void {
    if (!this.#profileNoteTimer) {
      this.#profileNoteTimer = setTimeout(() => {
        this.#profileNoteTimer = null;
        if (!this.#closing && Date.now() - this.#profileToldAt > PROFILE_NOTE_MS) this.emit({ type: 'profile_changed' });
      }, PROFILE_NOTE_MS);
      this.#profileNoteTimer.unref?.();
    }
    const name = this.#savedName();
    if (name === this.#judgedName) return;
    this.#judgedName = name;
    if (this.#rejudgeTimer) clearTimeout(this.#rejudgeTimer);
    this.#rejudgeTimer = setTimeout(() => { this.#rejudgeTimer = null; void this.#rejudgeAll(); }, PROFILE_NOTE_MS);
    this.#rejudgeTimer.unref?.();
  }

  /** Every document judged again; one that became the user's is read into the profile. Never throws. */
  async #rejudgeAll(): Promise<void> {
    if (this.#closing) return;
    for (const d of this.memory.listDocuments({ includeHeld: true })) {
      try {
        const was = { trusted: d.trusted, other: this.owners.otherName(d.id) };
        const now = await this.judgeDocument(d.id);
        const trusted = this.memory.documentTrusted(d.id);
        if (now === 'theirs' && trusted && (!was.trusted || was.other)) void this.fillProfileFrom(d.id);
      } catch (err) {
        this.log.warn('could not judge again whose a document is', { err, documentId: d.id });
      }
    }
  }

  #readProfile(documentId: string, retry = false): Promise<FillResult | null> {
    return fillProfile({ memory: this.memory, profile: this.profile, model: this.profileModel, log: this.log, owners: this.owners }, documentId)
      .then((r) => {
        if (r.usable.length || r.proposed.length) this.emit({ type: 'profile_changed' });
        if (r.model === 'failed') this.#profileAgainLater(documentId);
        else if (!retry) this.#profileRetries.delete(documentId);
        return r;
      })
      .catch((err: unknown) => {
        this.log.warn('could not read a document into the profile', { err, documentId });
        return null;
      });
  }

  /** Profile readings the model failed, with how many background tries each has had. */
  readonly #profileRetries = new Map<string, { tries: number; timer: NodeJS.Timeout | null }>();

  /** A profile reading the model failed is tried again a few times in the background; what patterns found serves meanwhile. */
  #profileAgainLater(documentId: string): void {
    const delays = (this.#opts.careerRetryMs ?? CAREER_RETRY_MS).slice(0, PROFILE_RETRIES);
    const state = this.#profileRetries.get(documentId) ?? { tries: 0, timer: null };
    this.#profileRetries.set(documentId, state);
    if (this.#closing || state.timer || state.tries >= delays.length) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      state.tries++;
      void this.#readProfile(documentId, true);
    }, delays[state.tries]);
    state.timer.unref?.();
  }

  /**
   * Read one document into a career record, once per version of its text: by
   * the answer model when there is one, by pattern otherwise or when the
   * model fails. Never throws. A document that is not the owner's own, or
   * that is gone, has its record dropped. True when a record was written.
   */
  async readCareerFrom(documentId: string): Promise<boolean> {
    return (await this.#readCareer(documentId)).wrote;
  }

  async #readCareer(documentId: string, retry = false): Promise<Reading & { wrote: boolean }> {
    try {
      const doc = this.memory.listDocuments().find((d) => d.id === documentId);
      const whole = doc?.trusted ? await this.memory.documentText(documentId) : null;
      // Neither reader sees a line that gives a reader orders; the owner sees how many there were.
      const read = whole ? readerText(whole) : null;
      if (read && doc && read.ignored !== doc.ignoredLines) this.memory.noteIgnoredLines(documentId, read.ignored);
      const text = read?.text ?? null;
      // Somebody else's résumé, or a file with no work history and no contact details (a shopping list), is no career of the user's.
      const career = !!doc && !!text?.trim() && !this.owners.otherName(documentId)
        && (doc.kind !== 'file' || namedLikeACv(doc.title) || !notAResume(text!));
      if (!doc || !text?.trim() || !career) {
        if (this.careers.get(documentId)) { this.careers.delete(documentId); this.#sweepSoon(); this.emit({ type: 'profile_changed' }); }
        return { by: 'none', problem: null, wrote: false };
      }
      const sum = sha256(text);
      const kept = this.careers.get(documentId);
      const model = this.answerModel;
      // A LinkedIn export's record is built in code from its columns when it is imported; no reading of its text is better.
      if (kept && doc.kind === 'export') return { by: 'kept', problem: null, wrote: false };
      // A record read by pattern is read again once a model can read it better.
      if (kept?.sha256 === sum && (kept.model || !model)) return { by: 'kept', problem: null, wrote: false };
      let record: CareerRecord | null = null;
      let by: string | null = null;
      let problem: string | null = null;
      let again = true;
      if (model) {
        try {
          record = await parseCareer(model, { id: documentId, title: doc.title, text });
          by = 'answer';
        } catch (err) {
          this.log.warn('could not read a document into a career record; reading it by pattern', { err, documentId });
          problem = plainReason(err);
          // A reply cut off at its token limit is cut off again on the same call, and each try is paid for.
          const e = err as { retryable?: unknown; status?: unknown };
          again = !(e.retryable === false && e.status === null);
        }
      }
      if (record) this.#stopRereads(documentId);
      else if (model && again) this.#readAgainLater(documentId, retry);
      const reading: Reading = { by: record ? 'model' : model ? 'patterns' : 'none', problem };
      // The pattern's record of this same text is already kept: a failed try leaves it as it is, and asks for no sweep.
      if (!record && kept?.sha256 === sum && !kept.model) return { ...reading, wrote: false };
      record ??= parseCareerByPattern({ id: documentId, text });
      this.careers.put(documentId, sum, record, by);
      this.#sweepSoon();
      // An open Profile page shows the career and what it works out (the years) without a reload.
      this.emit({ type: 'profile_changed' });
      return { ...reading, wrote: true };
    } catch (err) {
      this.log.warn('could not read a career record', { err, documentId });
      return { by: 'none', problem: null, wrote: false };
    }
  }

  /** Documents whose reading by the model failed: how many tries in the background each has had, and the next one. */
  readonly #rereads = new Map<string, { tries: number; timer: NodeJS.Timeout | null }>();

  /**
   * A reading the model failed is kept by pattern for now, and the model reads
   * the document again: at 2, 10 and 30 s, then 1, 5 and 30 minutes, each
   * after the last try failed. The first that succeeds replaces the
   * pattern's record and the rest are called off. A reading asked for again
   * after the tries ran out starts them over.
   */
  #readAgainLater(documentId: string, retry: boolean): void {
    if (this.#closing) return;
    const delays = this.#opts.careerRetryMs ?? CAREER_RETRY_MS;
    let state = this.#rereads.get(documentId);
    if (state && !retry && !state.timer && state.tries >= delays.length) state = undefined;
    if (!state) this.#rereads.set(documentId, state = { tries: 0, timer: null });
    if (state.timer || state.tries >= delays.length) return;
    const s = state;
    s.timer = setTimeout(() => {
      s.timer = null;
      s.tries++;
      void this.#readCareer(documentId, true);
    }, delays[s.tries]);
    s.timer.unref?.();
  }

  #stopRereads(documentId: string): void {
    const state = this.#rereads.get(documentId);
    if (state?.timer) clearTimeout(state.timer);
    this.#rereads.delete(documentId);
  }

  /**
   * Once after a start, in the background: every document of the owner's
   * that has no career record yet is read (as after an upgrade, when the
   * record is new), and so is every one only patterns read when there is a
   * model now, since a restart forgets the retries; then waiting questions
   * are answered again in one sweep. A LinkedIn export's record is built in
   * code and never read again. Nothing waits on it; it never throws.
   */
  catchUp(): Promise<void> {
    // Nothing runs by itself while Fanfold is locked: this waits until it opens.
    if (!this.#catchingUp && this.locked) {
      this.#catchUpWhenOpen = true;
      return Promise.resolve();
    }
    this.#catchingUp ??= (async () => {
      try {
        // Whose each document is, judged once against the name the profile has now: a profile from before this was judged has its say too.
        for (const d of this.memory.listDocuments({ includeHeld: true })) {
          if (this.#closing) return;
          await this.judgeDocument(d.id).catch(() => null);
        }
        // A worker left naming a file removed before files were followed holds none, rather than an id that leads nowhere.
        const kept = new Set(this.memory.listDocuments({ includeHeld: true }).map((d) => d.id));
        for (const w of this.workers.list()) {
          if (w.documents.resumeId && !kept.has(w.documents.resumeId)) this.workers.update(w.id, { documents: { ...w.documents, resumeId: null } });
        }
        if (this.profile.resumeId() === undefined) {
          // Before one document was chosen as the résumé, the newest of the user's that reads as one was taken as it: it still is.
          let resume: string | null = null;
          for (const d of this.memory.listDocuments().filter((x) => x.trusted && x.chunks > 0 && !this.owners.otherName(x.id))) {
            const text = await this.memory.documentText(d.id).catch(() => null);
            if (text && !notAResume(readerText(text).text)) { resume = d.id; break; }
          }
          this.profile.setResume(resume);
        }
        const model = this.answerModel;
        const unread = this.memory.listDocuments().filter((d) => {
          if (!d.trusted || d.chunks <= 0) return false;
          const kept = this.careers.get(d.id);
          return !kept || (!!model && !kept.model && d.kind !== 'export');
        });
        if (unread.length) this.log.info('reading documents that have no career record yet, or only one patterns read', { documents: unread.length });
        this.#holdSweeps = true;
        for (const d of unread) {
          if (this.#closing) return;
          await this.#readCareer(d.id);
        }
      } catch (err) {
        this.log.warn('could not read the documents that have no career record yet', { err });
      } finally {
        this.#holdSweeps = false;
      }
      if (this.#closing || !this.questions.list('open', 1).length) return;
      if (this.#sweepTimer) { clearTimeout(this.#sweepTimer); this.#sweepTimer = null; }
      await this.resolveQuestions();
    })();
    return this.#catchingUp;
  }

  #catchingUp: Promise<void> | null = null;
  /** While the catch-up reads documents, the sweep each reading would ask for waits for its one sweep at the end. */
  #holdSweeps = false;

  #sweeping: Promise<SweepResult | null> | null = null;
  #sweepAgain = false;
  #sweepTimer: NodeJS.Timeout | null = null;
  /** When recent sweeps started, so a run of them back to back is noticed and stopped. */
  #sweepStarts: number[] = [];
  #closing = false;

  /** Soon after a change, and once for a burst of them. */
  #sweepSoon(): void {
    if (!this.#opts.sweeps || this.#holdSweeps) return;
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = setTimeout(() => { this.#sweepTimer = null; this.#sweepByItself(); }, SWEEP_SETTLE_MS);
    this.#sweepTimer.unref?.();
  }

  /**
   * A sweep nobody asked for just now. More than five inside ten seconds
   * means something keeps asking for one; it is said once and not obeyed.
   */
  #sweepByItself(): void {
    if (this.#closing || this.locked) return;
    const now = Date.now();
    this.#sweepStarts = this.#sweepStarts.filter((t) => now - t < SWEEP_WINDOW_MS);
    if (this.#sweepStarts.length > SWEEPS_PER_WINDOW) {
      this.log.warn('sweeps ran back to back; not starting another by itself', { sweeps: this.#sweepStarts.length, withinMs: SWEEP_WINDOW_MS });
      return;
    }
    void this.resolveQuestions();
  }

  /**
   * Answer every question still waiting for the user again, with what Fanfold
   * holds now. One at a time: a call while one runs is handed the running
   * sweep, and at most one more runs after it, once the event loop has had
   * its turn. Never throws; null when it failed.
   */
  resolveQuestions(): Promise<SweepResult | null> {
    if (this.#sweeping) {
      this.#sweepAgain = true;
      return this.#sweeping;
    }
    this.#sweepAgain = false;
    this.#sweepStarts.push(Date.now());
    // A sweep whose model calls fail does not ask for another: only a form's own failed draft is tried again later.
    const run = sweepQuestions({ ...this.answerDeps(), draftFailed: undefined, questions: this.questions })
      .then((r) => {
        this.log.info('answered waiting questions again', { looked: r.looked, answered: r.answered.length, drafted: r.drafted.length, closed: r.closed.length });
        if (r.answered.length) this.emit({ type: 'question_answered', ids: r.answered, by: 'fanfold' });
        if (r.drafted.length) this.emit({ type: 'question_asked', ids: r.drafted, fresh: 0 });
        return r;
      })
      .catch((err: unknown) => {
        this.log.warn('could not answer waiting questions again', { err });
        return null;
      })
      .finally(() => {
        this.#sweeping = null;
        if (!this.#sweepAgain) return;
        this.#sweepAgain = false;
        // setImmediate, not a promise: a sweep that never waits on I/O would otherwise run the next one before any timer or request.
        setImmediate(() => this.#sweepByItself());
      });
    this.#sweeping = run;
    return run;
  }

  /** Why Fanfold's own model cannot answer for the user, in words a person can act on; null when it can. */
  get answerModelProblem(): string | null {
    if (this.#opts.answerModel === null || (this.#opts.answerModel === undefined && this.#opts.profileModel === null)) return null;
    if (!this.answerModel) return COPY.noModel;
    // A refused key first; then a model that failed two of its last five calls, until it next answers.
    return this.model.refusal?.message ?? answerModelHealth(this.answerModel);
  }

  /** Every profile fill and career reading started so far has finished. */
  async profileFilled(): Promise<void> {
    while (this.#filling.size) await Promise.all([...this.#filling]);
  }

  /** Sign-in is on in this Fanfold: the server that turned it on says so. Off until then, as in every test. */
  get signInRequired(): boolean {
    return this.#signInRequired;
  }

  set signInRequired(on: boolean) {
    this.#signInRequired = on;
    this.recheckAccess();
  }

  /** Whether Fanfold is open to use now, or only to look around (auth/access.ts). */
  accessNow(): Access {
    return access(this);
  }

  get locked(): boolean {
    return access(this).locked;
  }

  /**
   * Say when Fanfold locks or opens. Locking stops the workers that are
   * running; opening lets what waited for it run: the catch-up and a sweep.
   */
  recheckAccess(): Access {
    const now = access(this);
    if (sameAccess(now, this.#access)) return now;
    this.#access = now;
    this.emit({ type: 'access_changed', locked: now.locked, reason: now.reason });
    if (now.locked) {
      this.stopWorker();
      return now;
    }
    if (this.#catchUpWhenOpen) {
      this.#catchUpWhenOpen = false;
      void this.catchUp();
    } else this.#sweepSoon();
    return now;
  }

  /** Subscribe to what the app does outside a request: worker runs, submissions. */
  onEvent(listener: (event: AppEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  emit(event: AppEvent): void {
    if (event.type === 'profile_changed') this.#profileToldAt = Date.now();
    for (const listener of this.#listeners) {
      try { listener(event); } catch (err) { this.log.warn('an event listener threw', { err }); }
    }
  }

  /** Close out what a crash left open. Runs started since this process did are still going. */
  tidyStaleRuns(except?: string | null): number {
    // The conversation a run was answering says it never finished, rather than ending on the question.
    for (const run of this.store.staleRuns(this.#bootedAt)) {
      if (run.id === except || run.status !== 'running' || !run.conversation_id) continue;
      this.store.appendMessage({ conversationId: String(run.conversation_id), role: 'agent', text: COPY.crashedNote, runId: String(run.id), awaiting: false });
    }
    return this.store.abandonStaleRuns(except, this.#bootedAt);
  }

  /**
   * Runs still going as Fanfold closes stop with it: each is recorded as
   * stopped, and its conversation says so, rather than being taken for a
   * crash at the next start.
   */
  #interruptRuns(): void {
    for (const run of this.store.staleRuns()) {
      this.store.closeRun(String(run.id), 'failed', undefined, COPY.interrupted);
      if (run.conversation_id) this.store.appendMessage({ conversationId: String(run.conversation_id), role: 'agent', text: COPY.interruptedNote, runId: String(run.id), awaiting: false });
    }
  }

  /** Claims on queued jobs a previous start held: nothing holds them now. Returns how many lapsed. */
  lapseLeftClaims(): number {
    return this.jobs.lapseClaimsFrom(this.#bootedAt);
  }

  /**
   * Approvals a Fanfold that has since closed left waiting. The page each one
   * was asked on is gone, so there is nothing left to approve. One it was in
   * the middle of carrying out may or may not have gone, and says so.
   */
  expireOrphanedApprovals(): number {
    const booted = new Date(this.#bootedAt);
    return this.approvals.expireOlderThan(booted) + this.approvals.resolveStranded(booted);
  }

  /** Runs and effects a crash left in doubt. Surfacing these is their purpose. */
  unfinishedBusiness(): { staleRuns: number; unsettledEffects: Array<Record<string, unknown>>; staleWorkerRuns: number } {
    return {
      staleRuns: this.store.staleRuns(this.#bootedAt).length,
      unsettledEffects: this.store.unsettledEffects(),
      staleWorkerRuns: this.workers.staleRuns().length,
    };
  }

  /**
   * Shut down in an order that leaves nothing open: running work is stopped
   * and waited for, every owner ends, the janitor closes what they held, the
   * extension is told to close what Fanfold opened in the user's Chrome while
   * its link is still up, and Fanfold's own Chrome is asked to quit. `by` is
   * when the tidy steps that talk to the browser must give up (shared with
   * the server's own close).
   */
  async close(by = Date.now() + closeBudget.politeMs + RUNS_STOP_MS): Promise<void> {
    this.#closing = true;
    this.#stopRetries();
    this.#scheduler?.stop();
    this.#scheduler = null;
    this.stopWorker();
    // A chat task or an agent's run going now ends saying Fanfold was closed, before its browser goes from under it.
    stopRuns(this.store, COPY.interruptedNote);
    await this.#runsStopped(Math.min(RUNS_STOP_MS, Math.max(0, by - Date.now())));
    const politeBy = Math.min(by, Date.now() + closeBudget.politeMs);
    const mode: TabMode = this.browserInUse.mode;
    const side = this.#side;
    // Tidy closing talks to the browser, and a browser that stopped answering
    // would hold every step for its full timeout: it gets a few seconds, then
    // the browser is closed however far it got.
    const tidy = (async () => {
      await this.#teaching?.close().catch(() => {});
      await Promise.all([...this.#delegations.values()].map((d) => d.close().catch(() => {})));
      this.#delegations.clear();
      await this.#pages.closeAll().catch(() => {});
      this.#stopWatching();
      this.#offOwnOrigins();
      this.tabs.endAll();
      await this.#janitor?.sweep('shutdown', { force: true }).catch(() => {});
      this.#janitor?.stop();
      this.#janitor = null;
      await this.#sideOpening?.catch(() => null);
      this.#side = null;
      if (side) {
        await side.janitor.sweep('shutdown', { force: true }).catch(() => {});
        await this.#closeSide(side);
        this.tabs.forget(side.mode);
      }
      await this.#page?.close().catch(() => {});
    })();
    await within(politeBy - Date.now(), tidy);
    this.#stopWatching();
    // Out of time or not, Fanfold's own addresses stop being watched and every owner has ended.
    this.#offOwnOrigins();
    this.tabs.endAll();
    this.#janitor?.stop();
    this.#janitor = null;
    if (this.#side) await this.#side.browser.close().catch(() => {});
    this.#side = null;
    // Before the link stops: the release that closes Fanfold's tabs in the user's Chrome travels over it.
    await this.#browser?.close().catch(() => {});
    await this.#letting;
    if (this.#browser) this.tabs.forget(mode);
    await this.extension.stop().catch(() => {});
    this.#page = null;
    this.#browser = null;
    this.#runtime = null;
    // Tidy steps still going when time ran out end with the browser they talk to: the database waits for them, not the reverse.
    await within(TIDY_AFTER_MS, tidy);
    try { this.#interruptRuns(); } catch (err) { this.log.warn('could not record the runs Fanfold closed on', { err }); }
    this.store.close();
    this.db.close();
  }

  /** Nothing is swept, drafted or read again once the app is closing. */
  #stopRetries(): void {
    if (this.#sweepTimer) clearTimeout(this.#sweepTimer);
    if (this.#draftTimer) clearTimeout(this.#draftTimer);
    this.#sweepTimer = this.#draftTimer = null;
    if (this.#rejudgeTimer) clearTimeout(this.#rejudgeTimer);
    if (this.#profileNoteTimer) clearTimeout(this.#profileNoteTimer);
    this.#rejudgeTimer = this.#profileNoteTimer = null;
    for (const state of [...this.#rereads.values(), ...this.#profileRetries.values()]) if (state.timer) clearTimeout(state.timer);
    this.#rereads.clear();
    this.#profileRetries.clear();
  }

  /** The main page's state and the tabs in use stop being watched. */
  #stopWatching(): void {
    this.#shuttingDown = true;
    if (this.#mainWatch) clearInterval(this.#mainWatch);
    if (this.#inUseTimer) clearTimeout(this.#inUseTimer);
    this.#mainWatch = this.#inUseTimer = null;
  }

  /** Kill the browsers Fanfold started, now, with every process they started: for a shutdown that has run out of time. */
  killBrowser(): void {
    for (const browser of [this.#browser, this.#side?.browser]) {
      if (browser && 'kill' in browser && typeof browser.kill === 'function') browser.kill();
    }
  }

  /** Worker runs told to stop have stopped, or the wait is over. */
  async #runsStopped(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while ((this.#runs.active().length || runsGoing(this.store)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
}

/** How long, once the browser is closed, the tidy steps it cut short have to end before the database closes. */
const TIDY_AFTER_MS = 2_000;

/** How long shutdown waits on a browser for the tidy steps before it closes the browser anyway. Shortened in tests. */
export const closeBudget = { politeMs: 5_000 };

/** `work`, or nothing once `ms` have passed: the work is left to finish or fail on its own. */
export async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); })]);
  clearTimeout(timer);
}

export function defaultDbPath(): string {
  return join(stateDir(), 'agent.db');
}
