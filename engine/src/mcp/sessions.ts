/**
 * Named browser sessions, so one host can work several pages at once.
 *
 * "main" is the agent's window with the user's sign-ins. A tab session is a
 * second tab in that same browser, sharing those sign-ins. A sandbox session
 * is a separate Chrome on a throwaway profile that knows nothing about the
 * user and is deleted when it closes.
 *
 * Calls on one session run one at a time; calls on different sessions run
 * together. That is the whole of the parallelism: the host issues tool calls
 * side by side and each lands on its own page.
 *
 * A session belongs to the connection that opened it: another agent cannot
 * see, use or close it, and the same name in two connections is two
 * sessions. Only "main" is shared, and a session kept for the user after its
 * agent went, which any agent may pick up by name to finish.
 */
import { randomUUID } from 'node:crypto';
import type { BrowserRuntime, Tab } from '../observe/runtime.ts';
import { isTransportLoss } from '../cdp/loss.ts';
import { displayKeeper } from '../observe/display-wake.ts';
import { MAIN, mainHold, type Owner, type TabLedger } from '../observe/tab-ledger.ts';
import type { Observation } from '../types.ts';
import type { CodeAskRecord } from './code-ask.ts';

export type SessionKind = 'main' | 'tab' | 'sandbox';

export interface Session {
  name: string;
  kind: SessionKind;
  page: BrowserRuntime;
  /** Every session is a run in the store, so its steps are audited like any other. */
  runId: string;
  /** The observation whose refs the host is holding. */
  observation: Observation | null;
  step: number;
  openedAt: string;
  /** Hosts this session has already been briefed on. */
  briefed: Set<string>;
  /** Said once, at the top of the next result. */
  note?: string;
  /** Browser restarts this session has been told about. */
  restartsSeen?: number;
  /** The emailed code the site wants after this session's application Submit, while it wants it. */
  codeAsk?: CodeAskRecord;
  /** When the last code ask ended: a Submit from before then begins no new one. */
  codeAskEnded?: number;
  /** Aborted when the session closes, so nothing waits on its behalf after that. */
  closing: AbortController;
  /** The agent that opened it with session_open: it closes when that agent goes. */
  openedBy?: object;
  /** Addresses this session has shown, so what was asked from it can be told from what other sessions asked. */
  seen?: Set<string>;
  /** The work its tabs belong to in the tab ledger: the session itself, or "main". */
  owner?: Owner;
  /** Since when its page has shown a check that is the user's to do (a box to tick, a puzzle). */
  checkSince?: number;
  /** When its agent last left it waiting on the user: answers that come after that are what an agent must come back for. */
  keptAt?: number;
  /**
   * A Submit-class press the browser did not answer in time: it may or may not
   * have gone, so the same control is not pressed again in the same load of
   * the page until a look taken after it shows neither a confirmation nor an error.
   */
  unsurePress?: { control: string; url: string; loadId: string | null; seen: string | null };
  /** Times in a row the browser did not answer in time on this session's tab. */
  timeouts?: number;
  /** Set while a call runs, when it met a timeout it reported rather than threw. */
  timedOut?: boolean;
  /** The last tab closed under it that its agent has been told about (Page.lostTab). */
  lostTabSeen?: number;
}

/** Something in a session that waits on the user, which keeps it from closing. */
export interface Wait {
  kind: 'approval' | 'question' | 'answered' | 'code' | 'check';
  /** Why it was kept, said to the agent that asked to close it. */
  why: string;
}

export interface SessionsOptions {
  main(): Promise<BrowserRuntime>;
  /** A tab of its own for a session, whose tabs belong to `owner`. */
  openTab(owner?: Owner): Promise<Tab>;
  openSandbox(opts: { visible: boolean; owner?: Owner }): Promise<Tab>;
  /**
   * The tab ledger (tab-ledger.ts): a session's tabs are claimed for it, kept
   * while it waits on the user, stopped when the user stops them, and "main"
   * stays alive while an agent works there.
   */
  ledger?: TabLedger;
  onOpen?(session: Session): void;
  /** Just before a session's pages close, while they can still be read. */
  beforeClose?(session: Session): Promise<void>;
  onClose?(session: Session): void;
  /**
   * A step of this session waits on the user, or is being carried out on their
   * word. Such a session stays open when its agent goes, so the user can still
   * finish it, and "main" is not handed to another agent meanwhile.
   */
  waitsOnUser?(session: Session): boolean;
  /**
   * Whether a tab session's window is still there. False once the browser it
   * was opened in has gone (quit, crashed, replaced): such a session leaves
   * the list and the limit at once. Always there when absent.
   */
  alive?(session: Session): boolean;
  maxTabs?: number;
  maxSandboxes?: number;
}

/**
 * How often a window kept for the user is checked, to close it once nothing
 * in it waits on them; and how long one kept for an answer stays after the
 * answer comes, for an agent to come back and finish its form. Shortened in tests.
 */
export const keptWindows = { checkMs: 5_000, limitMs: 12 * 60 * 60_000 };

const APPROVAL_WAITS = 'an approval waits on the user, and Fanfold presses it on this page the moment they approve it';

/** What an agent is told about "main" and about sessions the user stopped. */
export const COPY = {
  answeredWaits: 'the user has answered what its form asked, and the form stays filled for the agent sent back to finish it',
  mainHeldApproval: 'the main window is holding an application that waits for the user\'s approval, and it is not yours to use. ',
  mainHeldOther: 'the main window is holding a page that waits on the user ({why}), and it is not yours to use. ',
  mainHeldHow: 'Leave out "session" to get a window of your own, or open one with session_open.',
  mainHeldNoteApproval: 'Note: the main window is holding an application that waits for the user\'s approval, so you have a window of your own, "{name}". ',
  mainHeldNoteOther: 'Note: the main window is holding a page that waits on the user ({why}), so you have a window of your own, "{name}". ',
  mainHeldNoteRest: 'Leave "main" alone until the user has answered. This window shares the user\'s sign-ins and closes when you disconnect.',
  stopped: 'the user stopped Fanfold in this session\'s window, or took its tab back, so the session "{name}" was closed. Fanfold does not open that page again. '
    + 'Tell the user what was left unfinished; open a new session only if they ask you to carry on.',
  mainStopped: 'Note: the user stopped Fanfold in the main window, so what you were doing there was stopped and this is a new, blank page. '
    + 'Do not go back to that work unless the user asks you to.',
  checkWaits: 'its page shows a bot check that is the user\'s to do (Fanfold does not do these), and the form stays filled for when they have done it',
  unhealthy: 'This tab is unhealthy: the browser did not answer here twice in a row. Do not press anything more in it. '
    + 'Tell the user, and work in a new session; close this one with session_close once nothing in it waits on the user.',
  windowClosed: 'the window of session "{name}" was closed: Fanfold\'s browser quit or was restarted, so the session ended and anything typed in it is gone. '
    + 'Open it again with session_open (name "{name}") and start that page again; tell the user if a form there has to be filled again.',
  ownReopened: 'Note: Fanfold\'s browser closed since you last looked, so your window "{name}" was opened again{where}. Anything typed into it before is gone: check every field.',
  mainName: '"main" is the window with the user\'s sign-ins, and it is always open: leave out "session" to work in it, or open a session with another name.',
  nameTaken: 'a session named "{name}" is already open in this connection. Pass "session": "{name}" to the browser tools to use it, close it with session_close first, or pick another name.',
  nameKept: 'a session named "{name}" is kept open for the user ({why}). To finish it, pass "session": "{name}" to the browser tools; it is yours from then on. Pick another name for anything else.',
  limitMine: '{open} {kind} sessions are already open, which is the limit for every agent connected to Fanfold together, not for each. {mine} of them are yours: close one with session_close first.',
  limitOthers: '{open} {kind} sessions are already open, which is the limit for every agent connected to Fanfold together, not for each, and none of them is yours. '
    + 'Wait for the other agents to close theirs, then try again.',
};

/** The browser did not answer a command in time. */
export function isTimeout(err: unknown): boolean {
  return /CDP timeout|timed out waiting for/i.test((err as Error)?.message ?? '');
}

/** A call on this session met a timeout it reports in its result rather than throws: counted like a thrown one. */
export function noteTimeout(session: Session): void {
  session.timedOut = true;
  session.timeouts = (session.timeouts ?? 0) + 1;
}

/** The line a result carries once this session's tab has failed to answer twice in a row. */
export function unhealthyNote(session: Session): string {
  return (session.timeouts ?? 0) >= 2 ? COPY.unhealthy : '';
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** "InCommon" or "Acme Corp" is what an agent names a session after; it means incommon and acme-corp. */
export function sessionName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 32);
}

export class Sessions {
  readonly #opts: SessionsOptions;
  /** By key: "main", or the connection that opened it and its name (see #key). */
  readonly #sessions = new Map<string, Session>();
  readonly #keys = new WeakMap<Session, string>();
  /** Names claimed by an open still under way, so parallel calls cannot take the same one or pass the limit together. */
  readonly #claimed = new Map<string, { kind: SessionKind; name: string }>();
  readonly #closers = new Map<Session, () => Promise<void>>();
  readonly #tails = new Map<Session, Promise<unknown>>();
  #opening: Promise<Session> | null = null;
  /** Which agent is working in "main", and each other agent's own session. */
  #mainHolder: object | null = null;
  /** Asks the ledger again once the holder's calls have stopped for long enough, so "main" goes then and not a sweep later. */
  #holdTimer: NodeJS.Timeout | null = null;
  readonly #own = new Map<object, Promise<Session>>();
  readonly #lastCall = new Map<object, number>();
  /** Agents that have disconnected. */
  readonly #ended = new WeakSet<object>();
  /** A number per connection, which keeps one agent's session names apart from another's. */
  readonly #agents = new WeakMap<object, number>();
  #nextAgent = 1;
  /**
   * Windows kept while something in them waits on the user: their agent has
   * gone, or asked to close them. `answered` is when the last answer they were
   * kept for came, while an agent may still be on its way back to use it.
   */
  readonly #kept = new Map<Session, { why: string }>();
  #keptTimer: NodeJS.Timeout | null = null;
  /** What else a session may wait on the user for, beyond an approval: told by the tools that ask. */
  readonly #waitChecks: Array<(session: Session) => Wait[]> = [];
  /** How each session stops being stoppable from outside, once it is closed. */
  readonly #unstops = new Map<Session, () => void>();
  /** Sessions the user stopped, by key, so the agent that comes back to one is told why it is gone. */
  readonly #stoppedByUser = new Set<string>();
  /** Sessions whose window went with the browser, by key, so the agent that comes back to one is told why it is gone. */
  readonly #gone = new Set<string>();

  constructor(opts: SessionsOptions) {
    this.#opts = opts;
    // "main" is not closed while an agent works in it or something there waits on the user.
    opts.ledger?.hold(MAIN, () => this.#mainNeeded());
  }

  #mainNeeded(): boolean {
    const main = this.#sessions.get('main');
    if (!main) return false;
    const holder = this.#mainHolder;
    if (holder && !this.#ended.has(holder) && Date.now() - (this.#lastCall.get(holder) ?? 0) <= mainHold.idleMs) return true;
    return this.waitsOf(main).length > 0;
  }

  /** Where a session is filed: "main" for everyone, any other name under the connection that opened it. */
  #key(name: string, by?: object): string {
    if (name === 'main') return 'main';
    if (!by) return `/${name}`;
    let n = this.#agents.get(by);
    if (!n) this.#agents.set(by, n = this.#nextAgent++);
    return `${n}/${name}`;
  }

  /** Still the one filed under its key: not closed, dropped or handed to another agent since. */
  #registered(session: Session): boolean {
    const key = this.#keys.get(session);
    return key !== undefined && this.#sessions.get(key) === session;
  }

  #alive(session: Session): boolean {
    return session.kind !== 'tab' || (this.#opts.alive?.(session) ?? true);
  }

  /** Sessions whose window went with the browser leave the list and the limit now, not when next called. */
  #reap(): void {
    if (!this.#opts.alive) return;
    for (const session of [...this.#sessions.values()]) if (!this.#alive(session)) this.#drop(session);
  }

  /**
   * A session whose window has already gone with its browser. Nothing on the
   * page can be read or closed any more; its run, its approvals and its claim
   * on the tab ledger end as they would on an ordinary close.
   */
  #drop(session: Session): void {
    const key = this.#keys.get(session);
    if (!key || this.#sessions.get(key) !== session || session.kind === 'main') return;
    this.#sessions.delete(key);
    if (this.#gone.size >= 200) this.#gone.clear();
    this.#gone.add(key);
    this.#tails.delete(session);
    this.#kept.delete(session);
    if (session.owner) this.#opts.ledger?.unkeepOwner(session.owner);
    this.#unstops.get(session)?.();
    this.#unstops.delete(session);
    session.closing.abort();
    const closer = this.#closers.get(session);
    this.#closers.delete(session);
    void closer?.().catch(() => {});
    this.#opts.onClose?.(session);
  }

  /** Whether this agent may see and use a session: "main", its own, one nobody opened, or one kept for the user after its agent went. */
  #visible(session: Session, caller?: object): boolean {
    if (!caller || session.kind === 'main' || !session.openedBy || session.openedBy === caller) return true;
    return this.#ended.has(session.openedBy) && this.#kept.has(session);
  }

  /** The session this agent means by the name, if it may use one. Opens nothing. Its own comes before one it may pick up. */
  find(name: string, caller?: object): Session | null {
    name = sessionName(name) || name;
    this.#reap();
    const named = [...this.#sessions.values()].filter((s) => s.name === name && this.#visible(s, caller));
    return named.find((s) => s.openedBy === caller) ?? named.find((s) => !s.openedBy) ?? named[0] ?? null;
  }

  /** An existing session. "main" is created the first time it is asked for. */
  async get(name = 'main', caller?: object): Promise<Session> {
    name = sessionName(name) || name;
    const existing = this.find(name, caller);
    if (existing) return existing;
    if (name !== 'main') {
      const key = this.#key(name, caller);
      if (this.#stoppedByUser.has(key)) throw new Error(COPY.stopped.replace('{name}', name));
      if (this.#gone.has(key)) throw new Error(COPY.windowClosed.replaceAll('{name}', name));
      throw new Error(`no session named ${JSON.stringify(name)}. Open one with session_open, or use "main".`);
    }
    // Two first calls arriving together must not start two browsers.
    this.#opening ??= (async () => {
      try {
        return this.#register('main', 'main', await this.#opts.main(), async () => {}, randomUUID(), MAIN);
      } finally {
        this.#opening = null;
      }
    })();
    return await this.#opening;
  }

  /**
   * Where an agent works when it names no session. Two agents connected at
   * once (two Claude Code windows, say) must not drive one page between them,
   * each navigating away from the other's work: the first works in "main",
   * and any other gets a window of its own until it disconnects. A window of
   * its own that went with the browser is opened again, as "main" is.
   */
  async forCaller(caller: object): Promise<Session> {
    const now = Date.now();
    this.#called(caller, now);
    this.#reap();
    let lost: Session | null = null;
    const own = this.#own.get(caller);
    if (own) {
      const session = await own.catch(() => null);
      if (session && this.#registered(session)) return session;
      this.#own.delete(caller);
      if (session && this.#gone.has(this.#keys.get(session) ?? '')) lost = session;
    }
    const holder = this.#mainHolder;
    if (this.#mainFreeFor(caller, now)) {
      this.#takeMain(caller);
      return this.get('main');
    }
    // Nobody is working there: what keeps it is something waiting on the user.
    const heldForUser = !holder || now - (this.#lastCall.get(holder) ?? 0) > mainHold.idleMs;
    const main = this.#sessions.get('main');
    const waits = heldForUser && main ? this.waitsOf(main) : [];
    // Claimed before the open is awaited, so a second call from the same
    // agent waits for this window instead of opening another.
    const name = lost && !this.#taken(lost.name) ? lost.name : this.#freeName('agent');
    const opening = this.open({ name, by: caller }).then(async (session) => {
      if (lost) {
        const was = lost.observation?.url ?? '';
        const back = /^https?:/i.test(was);
        if (back) await session.page.goto(was).catch(() => {});
        session.note = COPY.ownReopened.replace('{name}', session.name).replace('{where}', back ? ' at the page it was on' : '');
        return session;
      }
      session.note = heldForUser
        ? (waits.length && !waits.some((w) => w.kind === 'approval')
          ? COPY.mainHeldNoteOther.replace('{why}', waits.map((w) => w.why).join('; ')).replace('{name}', session.name)
          : COPY.mainHeldNoteApproval.replace('{name}', session.name)) + COPY.mainHeldNoteRest
        : `Note: another agent is working in the main window, so this one has a window of its own, "${session.name}". `
          + 'It shares the user\'s sign-ins and closes when you disconnect.';
      return session;
    });
    this.#own.set(caller, opening);
    try {
      return await opening;
    } catch (err) {
      this.#own.delete(caller);
      throw err;
    }
  }

  /** The session forCaller would give this caller, if it exists yet. Opens nothing and takes nothing. */
  async heldBy(caller: object): Promise<Session | null> {
    this.#reap();
    const own = await this.#own.get(caller)?.catch(() => null);
    if (own && this.#registered(own)) return own;
    return this.#mainFreeFor(caller, Date.now()) ? this.#sessions.get('main') ?? null : null;
  }

  /**
   * A session asked for by name. "main" is refused to an agent other than
   * the one working there while something asked in it waits on the user:
   * going on in it would take the form the user is about to approve off the
   * page. Any other name is the caller's own session, or one kept for the
   * user after its agent went, which becomes the caller's.
   */
  async named(name: string, caller?: object): Promise<Session> {
    const isMain = (sessionName(name) || name) === 'main';
    const main = isMain ? this.#sessions.get('main') : undefined;
    const waits = caller && main && this.#mainHolder !== caller ? this.waitsOf(main) : [];
    if (waits.length) {
      throw new Error((waits.some((w) => w.kind === 'approval')
        ? COPY.mainHeldApproval
        : COPY.mainHeldOther.replace('{why}', waits.map((w) => w.why).join('; '))) + COPY.mainHeldHow);
    }
    if (caller) {
      const now = Date.now();
      this.#called(caller, now);
      // Naming "main" is working there: it is this agent's while nobody else's.
      if (isMain && this.#mainFreeFor(caller, now)) this.#takeMain(caller);
    }
    const session = await this.get(name, caller);
    // An agent came back to a window kept for the user: it is that agent's again, to finish and close.
    if (caller && this.#kept.delete(session)) {
      if (session.openedBy !== caller) this.#rekey(session, caller);
      session.openedBy = caller;
      delete session.keptAt;
      this.#unmarkKept(session);
    }
    return session;
  }

  /** Filed under another agent's name now: one picking up a window kept for the user. */
  #rekey(session: Session, by: object): void {
    const was = this.#keys.get(session);
    const key = this.#key(session.name, by);
    if (!was || was === key || this.#sessions.has(key)) return;
    this.#sessions.delete(was);
    this.#sessions.set(key, session);
    this.#keys.set(session, key);
  }

  /** Something more a session can wait on the user for than an approval, such as a question asked from it. */
  alsoWaitsOn(check: (session: Session) => Wait[]): void {
    this.#waitChecks.push(check);
  }

  /** Everything in this session that waits on the user now. */
  waitsOf(session: Session): Wait[] {
    const waits: Wait[] = this.#opts.waitsOnUser?.(session) ? [{ kind: 'approval', why: APPROVAL_WAITS }] : [];
    for (const check of this.#waitChecks) {
      try {
        waits.push(...check(session));
      } catch {
        // A check that cannot be made (the store closing under it) keeps nothing open, as before there were checks.
      }
    }
    return waits;
  }

  /**
   * Close a session, unless something in it waits on the user: then it is
   * kept, and closed once nothing does. Says what kept it.
   */
  async closeUnlessWaiting(name: string, caller?: object): Promise<{ closed: boolean; kept: Wait[] }> {
    const session = this.find(name, caller);
    if (!session) return { closed: false, kept: [] };
    if (session.kind === 'main') return { closed: await this.#close(session), kept: [] };
    const waits = this.waitsOf(session);
    if (!waits.length) return { closed: await this.#close(session), kept: [] };
    this.#keep(session, waits);
    return { closed: false, kept: waits };
  }

  /** Whether this session is being kept for the user, to close by itself. */
  isKept(session: Session): boolean {
    return this.#kept.has(session);
  }

  /** Nobody else is working in "main", and nothing asked there waits on the user: an approval, a question or an emailed code. */
  #mainFreeFor(caller: object, now: number): boolean {
    const holder = this.#mainHolder;
    if (holder === caller) return true;
    if (holder && now - (this.#lastCall.get(holder) ?? 0) <= mainHold.idleMs) return false;
    const main = this.#sessions.get('main');
    return !(main && this.waitsOf(main).length);
  }

  /** "main" is this agent's now. When the window passes to a new agent, that one has not been told about its sites yet. */
  #takeMain(caller: object): void {
    if (this.#mainHolder && this.#mainHolder !== caller) this.#sessions.get('main')?.briefed.clear();
    this.#mainHolder = caller;
    this.#armHold();
  }

  /** A call from this agent: the one working in "main" keeps it for another while. */
  #called(caller: object, now: number): void {
    if (this.#ended.has(caller)) return;
    this.#lastCall.set(caller, now);
    if (this.#mainHolder === caller) this.#armHold();
  }

  #armHold(): void {
    const { ledger } = this.#opts;
    if (!ledger) return;
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      ledger.recheck(MAIN);
    }, mainHold.idleMs + 20);
    this.#holdTimer.unref();
  }

  /** Whether this agent has disconnected. */
  ended(caller: object): boolean {
    return this.#ended.has(caller);
  }

  /** An agent disconnected: give up "main" and close the windows that were its own. */
  release(caller: object): void {
    this.#ended.add(caller);
    const main = this.#sessions.get('main');
    if (this.#mainHolder === caller && main) {
      // The tabs its pages opened go with it, so the next agent finds only its own window.
      void this.exclusive(main, async () => {
        await main.page.closeOpened?.();
        main.observation = null;
      }).catch(() => {});
    }
    if (this.#mainHolder === caller) this.#mainHolder = null;
    this.#lastCall.delete(caller);
    // Its tab goes now, not when the next sweep comes round, unless something in it waits on the user.
    this.#opts.ledger?.recheck(MAIN);
    const own = this.#own.get(caller);
    this.#own.delete(caller);
    const left = new Set<Session>();
    const leave = (session: Session): void => {
      if (left.has(session) || !this.#registered(session)) return;
      left.add(session);
      const waits = this.waitsOf(session);
      if (waits.length) this.#keep(session, waits);
      else void this.#close(session).catch(() => {});
    };
    void own?.then(leave).catch(() => {});
    for (const session of [...this.#sessions.values()]) if (session.openedBy === caller) leave(session);
  }

  /**
   * Kept for the user until nothing in it waits on them any more: every
   * question asked from it answered or declined, its approval answered. Then
   * it closes like any other, since no agent comes back to a session it
   * closed. What it says it waits for is kept true as the waits change.
   */
  #keep(session: Session, waits: Wait[]): void {
    const why = waits.map((w) => w.why).join('; ');
    if (!this.#kept.has(session)) {
      session.keptAt = Date.now();
      this.#markKept(session, waits);
    }
    this.#kept.set(session, { why });
    this.#keptTimer ??= setInterval(() => this.#checkKept(), keptWindows.checkMs);
    this.#keptTimer.unref();
  }

  /** Close what no longer waits on the user, and say again what still does. */
  #checkKept(): void {
    for (const [kept, held] of this.#kept) {
      if (!this.#registered(kept)) {
        this.#kept.delete(kept);
        continue;
      }
      const waits = this.waitsOf(kept);
      if (!waits.length) {
        this.#kept.delete(kept);
        void this.#close(kept).catch(() => {});
        continue;
      }
      const why = waits.map((w) => w.why).join('; ');
      if (why !== held.why && kept.owner) {
        held.why = why;
        // Once only the agent's return is awaited, the page no longer says it waits for the user.
        void kept.page.indicate?.(waits.every((w) => w.kind === 'answered') ? 'working' : 'waiting').catch(() => {});
        const ledger = this.#opts.ledger;
        const until = ledger?.ownedBy(kept.owner).find((t) => t.keepUntil)?.keepUntil;
        if (ledger && until) ledger.keepOwner(kept.owner, until, why, ledger.keepRule(kept.owner) ?? undefined);
      }
    }
    if (!this.#kept.size) this.#stopKeeping();
  }

  /** Look at kept sessions now, as after an answer or a rejected approval, rather than at the next check. */
  recheckKept(): void {
    if (this.#kept.size) this.#checkKept();
  }

  #stopKeeping(): void {
    if (this.#keptTimer) clearInterval(this.#keptTimer);
    this.#keptTimer = null;
    this.#kept.clear();
  }

  /**
   * The ledger hears the window is kept, and the page says Fanfold waits for
   * the user. Whether it still waits is this class's own rule (the timer
   * above); the ledger only closes it if that runs past the limit.
   */
  #markKept(session: Session, waits: Wait[]): void {
    const { ledger } = this.#opts;
    if (ledger && session.owner) {
      ledger.keepOwner(session.owner, new Date(Date.now() + keptWindows.limitMs), waits.map((w) => w.why).join('; '), {
        // Asked at the moment, so no view says it waits once it does not.
        waits: () => this.#kept.has(session) && this.waitsOf(session).length > 0,
        expire: () => {
          this.#kept.delete(session);
          return this.#close(session).then(() => {});
        },
      });
    }
    void session.page.indicate?.('waiting').catch(() => {});
  }

  #unmarkKept(session: Session): void {
    if (session.owner) this.#opts.ledger?.unkeepOwner(session.owner);
    void session.page.indicate?.('working').catch(() => {});
  }

  /** A name in use by any session, or claimed by one opening: a default name is never one another agent's window shows. */
  #taken(name: string): boolean {
    return [...this.#sessions.values()].some((s) => s.name === name) || [...this.#claimed.values()].some((c) => c.name === name);
  }

  async open(opts: { name?: string; sandbox?: boolean; visible?: boolean; by?: object } = {}): Promise<Session> {
    const kind: SessionKind = opts.sandbox ? 'sandbox' : 'tab';
    this.#reap();
    const name = opts.name !== undefined ? sessionName(opts.name) : this.#freeName(kind);
    if (!NAME.test(name)) throw new Error('a session name is lowercase letters, digits, "-" or "_", at most 32 long');
    if (name === 'main') throw new Error(COPY.mainName);
    const key = this.#key(name, opts.by);
    if (this.#sessions.has(key) || this.#claimed.has(key)) throw new Error(COPY.nameTaken.replaceAll('{name}', name));
    // One kept for the user after its agent went is finished under its own name, not shadowed by a new one.
    const kept = this.find(name, opts.by);
    if (kept) {
      throw new Error(this.#kept.has(kept)
        ? COPY.nameKept.replaceAll('{name}', name).replace('{why}', this.#kept.get(kept)!.why)
        : COPY.nameTaken.replaceAll('{name}', name));
    }

    const limit = kind === 'sandbox' ? (this.#opts.maxSandboxes ?? 3) : (this.#opts.maxTabs ?? 8);
    const sessions = [...this.#sessions.values()].filter((s) => s.kind === kind);
    const open = sessions.length + [...this.#claimed.values()].filter((c) => c.kind === kind).length;
    if (open >= limit) {
      const mine = opts.by ? sessions.filter((s) => s.openedBy === opts.by).length : open;
      throw new Error((mine ? COPY.limitMine : COPY.limitOthers)
        .replace('{open}', String(open)).replace('{kind}', kind).replace('{mine}', String(mine)));
    }

    // Claimed before the first await: the checks above and the registration
    // below are otherwise far enough apart for a dozen parallel calls to
    // pass the same checks and leave tabs nobody can close.
    this.#claimed.set(key, { kind, name });
    const runId = randomUUID();
    const owner: Owner = { kind: kind === 'sandbox' ? 'sandbox' : 'session', id: runId };
    try {
      const tab = kind === 'sandbox'
        ? await this.#opts.openSandbox({ visible: opts.visible ?? false, owner })
        : await this.#opts.openTab(owner);
      return this.#register(name, kind, tab.page, () => tab.close(), runId, owner, opts.by);
    } finally {
      this.#claimed.delete(key);
    }
  }

  /** Close the session this agent means by the name. False when it has none by that name. */
  async close(name: string, caller?: object): Promise<boolean> {
    const session = this.find(name, caller);
    return session ? await this.#close(session) : false;
  }

  async #close(session: Session): Promise<boolean> {
    if (!this.#registered(session)) return false;
    if (session.kind === 'main') throw new Error('the main session stays open for as long as Fanfold runs');
    // Read while the page is still there: what is on it can decide how the work is recorded.
    await this.#opts.beforeClose?.(session).catch(() => {});
    const key = this.#keys.get(session);
    if (!key || this.#sessions.get(key) !== session) return false;
    this.#sessions.delete(key);
    this.#tails.delete(session);
    this.#kept.delete(session);
    if (session.owner) this.#opts.ledger?.unkeepOwner(session.owner);
    this.#unstops.get(session)?.();
    this.#unstops.delete(session);
    session.closing.abort();
    // The tabs its pages opened go with it, or they turn up in the next session's tab list.
    await session.page.closeOpened?.().catch(() => 0);
    await this.#closers.get(session)?.().catch(() => {});
    this.#closers.delete(session);
    this.#opts.onClose?.(session);
    return true;
  }

  /** Every open session, or those this agent may see. */
  list(caller?: object): Session[] {
    this.#reap();
    return [...this.#sessions.values()].filter((s) => this.#visible(s, caller));
  }

  /**
   * Run one thing at a time on a session, in arrival order. Counts the times
   * in a row the browser did not answer in time there: a call that worked
   * starts the count again, and from the second a thrown one says the tab is unhealthy.
   * A window that went with its browser ends its session, and the call says so.
   */
  exclusive<T>(session: Session, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(session) ?? Promise.resolve();
    const counted = async (): Promise<T> => {
      if (!this.#alive(session) && this.#registered(session)) {
        this.#drop(session);
        throw new Error(COPY.windowClosed.replaceAll('{name}', session.name));
      }
      session.timedOut = false;
      try {
        const out = await work();
        if (!session.timedOut) session.timeouts = 0;
        return out;
      } catch (err) {
        if (session.kind !== 'main' && isTransportLoss(err) && (!this.#alive(session) || /CDP (client|connection) closed/i.test((err as Error).message))) {
          this.#drop(session);
          throw new Error(COPY.windowClosed.replaceAll('{name}', session.name));
        }
        if (!isTimeout(err)) throw err;
        if (!session.timedOut) noteTimeout(session);
        throw (session.timeouts ?? 0) >= 2 ? new Error(`${(err as Error).message}. ${COPY.unhealthy}`) : err;
      } finally {
        session.timedOut = false;
      }
    };
    const next = previous.then(counted, counted);
    this.#tails.set(session, next.catch(() => {}));
    return next;
  }

  async closeAll(): Promise<void> {
    // Nothing is working any more, so the display may sleep again.
    displayKeeper.release();
    this.#stopKeeping();
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#tails.clear();
    await Promise.all(sessions.map(async (session) => {
      this.#unstops.get(session)?.();
      this.#unstops.delete(session);
      if (session.kind !== 'main') await this.#opts.beforeClose?.(session).catch(() => {});
      session.closing.abort();
      if (session.kind !== 'main') await session.page.closeOpened?.().catch(() => 0);
      await this.#closers.get(session)?.().catch(() => {});
      this.#opts.onClose?.(session);
    }));
    this.#closers.clear();
  }

  #register(name: string, kind: SessionKind, page: BrowserRuntime, close: () => Promise<void>, runId: string, owner: Owner, by?: object): Session {
    const key = this.#key(name, by);
    this.#stoppedByUser.delete(key);
    this.#gone.delete(key);
    const session: Session = {
      name, kind, page, runId, observation: null, step: 0,
      openedAt: new Date().toISOString(), briefed: new Set(), closing: new AbortController(), owner,
      // A tab closed under the page before this session had it is not this session's news.
      lostTabSeen: (page as { lostTab?: { id: number } | null }).lostTab?.id ?? 0,
      ...(by ? { openedBy: by } : {}),
    };
    this.#sessions.set(key, session);
    this.#keys.set(session, key);
    this.#closers.set(session, close);
    // The user stopping Fanfold in one of its tabs ends the session; in "main", the agent working there lets go of it.
    const stop = kind === 'main'
      ? () => {
        this.#mainHolder = null;
        session.observation = null;
        session.note = COPY.mainStopped;
      }
      : () => {
        this.#stoppedByUser.add(this.#keys.get(session) ?? key);
        return this.#close(session);
      };
    const unstop = this.#opts.ledger?.onStop(owner, stop);
    if (unstop) this.#unstops.set(session, unstop);
    this.#opts.onOpen?.(session);
    return session;
  }

  #freeName(kind: string): string {
    for (let n = 1; ; n++) {
      const name = `${kind}-${n}`;
      if (!this.#taken(name)) return name;
    }
  }
}
