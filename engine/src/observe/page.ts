/**
 * Page controller: one CDP session against one tab.
 *
 * Owns the serializer lifecycle, the observation → ref-lease contract, and
 * action dispatch. Actions go through the Input domain (real, trusted input
 * events) rather than element.click(), because a synthetic JS click skips
 * hit-testing and will happily "click" an element covered by a modal.
 */

import { randomUUID } from 'node:crypto';
import { exclusiveInput, type InputAside } from './input-lock.ts';
import { startRecording, type RecordedEvent } from './recorder.ts';
import { join } from 'node:path';
import { stateDir } from '../daemon/protocol.ts';
import { CdpClient } from '../cdp/client.ts';
import { markUntrusted, markUntrustedOrNull } from '../policy/untrusted.ts';
import { ownOriginBlock, withoutKey } from '../policy/navigable.ts';
import { awaitContent, settleAfterAction } from './settle.ts';
import { Requests, type DocumentResponse } from './requests.ts';
import { frameState, ProbeWorld, type FrameState } from './frames.ts';
import { isTransportLoss } from '../cdp/loss.ts';
import { dispatchOnTarget, pressKey, scroll, setFileInputFiles, type InputPort } from './input.ts';
import { answerDialog } from './dialogs.ts';
import { DownloadTracker } from './downloads.ts';
import { ActionFailureError, isSessionGone, classify } from './page-errors.ts';
import { claimTarget, createTargetWithRetry, familyOf, isBrowserOwnPage, OpenedTabs, ownedElsewhere, releaseTargets, type TargetLineage, type WindowBounds, windowPlace } from './targets.ts';
import { SERIALIZER_SOURCE, SERIALIZER_VERSION, type RawObservation, type ResolveResult } from './serializer.ts';
import { janitorOf } from './janitor.ts';
import type { Owner } from './tab-ledger.ts';
import { Indicator, INDICATOR_WORLD, type IndicatorState } from './indicator.ts';
import { currentRun } from '../lib/run-scope.ts';
import type { BrowserRuntime, ObserveOptions, PageJobData, Tab } from './runtime.ts';
import type {
  Observation, ObservedNode, PageStateId, Ref, ActionRequest, ActionResult,
  DialogEvent, TabInfo,
} from '../types.ts';

interface PageOptions {
  /**
   * A person's view of Fanfold's own window, such as a test or a screenshot
   * of it. Every other page, which is to say every page an agent drives, is
   * kept off Fanfold's own address.
   */
  ownWindow?: boolean;
  /**
   * The work this page's tabs belong to (tab-ledger.ts). In a browser a
   * janitor looks after, the tab is claimed for it, shows "Fanfold is working
   * here", and is closed when that work ends.
   */
  owner?: Owner | null;
}

/** Windows opened for sessions, per browser, so each new one steps clear of the last. */
const openWindows = new WeakMap<object, number>();
/** A tab closed under a page: where it was, and whether the page went back to the tab it started in or on in a new blank one. */
export interface LostTab { id: number; url: string | null; back: boolean }
/** Numbers each LostTab, across pages, so one is told about once. */
let tabsLost = 0;
/** Kinds that bring the tab forward and send it input. */
const NEEDS_FOREGROUND = new Set(['press', 'scroll', 'click', 'hover', 'fill', 'type', 'select', 'check', 'uncheck']);

export class Page implements BrowserRuntime {
  #client: CdpClient;
  #sessionId: string;
  #targetId: string;
  /** The tab it was attached to, before any switchTab. */
  #home: string;
  readonly #owner: Owner | null;
  /** This page is a person's view of Fanfold's own window, as in tests of it: its address is not blocked. */
  readonly #ownWindow: boolean;
  #scriptId: string | null = null;
  #lastObservation: Observation | null = null;
  #navigationCount = 0;
  #refHigh = 0;
  #requests: Requests | null = null;

  /** #send, for the helpers that name the reply they expect. */
  readonly #sendAs = <T>(method: string, params?: Record<string, unknown>): Promise<T> => this.#send(method, params ?? {}) as Promise<T>;

  /** "Fanfold is working here", drawn in the tab this page drives (indicator.ts). */
  readonly #indicator = new Indicator({
    send: this.#sendAs,
    evaluate: (expression: string) => this.#indicatorWorld.evaluate(expression, null, `${this.#sessionId}:${this.#navigationCount}`),
  });

  readonly #indicatorWorld = new ProbeWorld(this.#sendAs, INDICATOR_WORLD);

  /** Where the frame probe runs (frames.ts). */
  readonly #probe = new ProbeWorld(this.#sendAs);

  /** Where downloads go, and which have not been reported yet. */
  #downloads = new DownloadTracker();

  /** Tabs opened from this page by its own actions (targets.ts). */
  readonly #opened = new OpenedTabs();

  /** Trusted input into whichever session this page is driving now. */
  #input: InputPort = {
    send: (method, params) => this.#send(method, params ?? {}),
    evaluate: (expression) => this.#evaluate(expression),
  };

  /** Page/dialog listeners, wired once per client rather than per #init. */
  #listenersWired = false;

  /** How to take this page's listeners off the shared client again, once it is closed. */
  readonly #offs: Array<() => unknown> = [];

  /** Frames seen in this page's tabs. */
  readonly #frames = new Set<string>();

  /** The tab went away; the next observation re-attaches to a live one. */
  #sessionGone = false;

  /** A target can still exist while its renderer cannot execute anything. */
  #rendererCrashed = false;

  /** The last tab closed under this page, for whoever drives it to be told. */
  #lostTab: LostTab | null = null;

  /** Main frame id, so loading events from subframes are not mistaken for it. */
  #mainFrameId: string | null = null;

  /** The main frame is between frameStartedLoading and frameStoppedLoading. */
  #navInFlight = false;

  /** A navigation has been released but may not have started yet. */
  #navExpectedUntil = 0;

  /** Where this page last was, so a replacement tab can be put back there. */
  #lastUrl: string | null = null;

  /** A JavaScript dialog is showing right now (opening seen, closed not yet). */
  #dialogOpen = false;

  /** Between our own Page.navigate and its load: a beforeunload now is ours to accept. */
  #navigatingByCommand = false;

  /** Which set of Fanfold's own addresses this tab was last told to block. */
  #blockedVersion = -1;

  /** A request of this tab to Fanfold's own address was stopped since the last navigation began. */
  #stoppedOwn = false;

  /** The last link navigation the page asked for, and when. */
  #requestedNavigation: { url: string; at: number } | null = null;

  /** How many beforeunload guards have been accepted, ever. */
  #dialogsAnswered = 0;

  /** Tab ids seen in the previous observation, to mark new ones as opened. */
  #knownTabs = new Set<string>();

  /** Answered dialog not yet reported in an observation. */
  #pendingDialog: DialogEvent | null = null;

  private constructor(client: CdpClient, sessionId: string, targetId: string, opts: PageOptions) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#targetId = claimTarget(targetId, this);
    this.#home = targetId;
    this.#ownWindow = opts.ownWindow ?? false;
    this.#owner = opts.owner ?? null;
  }

  static async attach(client: CdpClient, targetId: string, opts: PageOptions = {}): Promise<Page> {
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(client, sessionId, targetId, opts);
    await page.#init();
    const janitor = page.#owner ? janitorOf(client) : null;
    if (janitor && page.#owner) {
      if (!janitor.ledger.get(targetId)) janitor.claim(targetId, page.#owner);
      await page.indicate('working');
    }
    return page;
  }

  /**
   * Attach to the first existing page target, or create one.
   *
   * Creation is retried once. Chrome can refuse a tab transiently — under
   * memory pressure, or while it is still finishing startup — with
   * `Failed to open a new tab`, and a browser that is otherwise healthy then
   * looks unusable. Between attempts we re-check for an existing page, since
   * the tab Chrome was busy opening may have arrived on its own.
   */
  static async first(client: CdpClient, opts: PageOptions = {}): Promise<Page> {
    const janitor = opts.owner ? janitorOf(client) : null;
    const findPage = async (): Promise<string | null> => {
      const { targetInfos } = await client.send<{
        targetInfos: Array<{ targetId: string; type: string; url: string }>;
      }>('Target.getTargets');
      if (!janitor) return targetInfos.find((t) => t.type === 'page')?.targetId ?? null;
      // A ledger in charge: only a blank tab nobody owns is taken over (the one
      // Chrome starts with), and never one in the user's own Chrome, where a
      // tab nobody owns is the user's.
      if (janitor.mode === 'extension') return null;
      return targetInfos.find((t) => t.type === 'page' && t.url === 'about:blank' && !janitor.ledger.get(t.targetId))?.targetId ?? null;
    };

    const existing = await findPage();
    if (existing) return Page.attach(client, existing, opts);

    // Only target CREATION is retried, and only for the transient Chrome
    // refusal. Wrapping the attach in the same try would open a second tab
    // whenever a CDP session failed to establish — a retry for a problem
    // retrying cannot fix.
    const targetId = await createTargetWithRetry(client, { owner: opts.owner });
    return Page.attach(client, targetId, opts);
  }

  /** The work this page's tabs belong to, when a ledger keeps track. */
  get owner(): Owner | null {
    return this.#owner;
  }

  get lostTab(): LostTab | null {
    return this.#lostTab;
  }

  async indicate(state: IndicatorState | null): Promise<void> {
    if (state) await this.#indicator.set(state);
    else await this.#indicator.clear();
  }

  /** The owner has ended or was stopped by the user: this page may not open a tab for it again. */
  #ownerGone(): boolean {
    const janitor = this.#owner ? janitorOf(this.#client) : null;
    return !!janitor && !!this.#owner && (janitor.ledger.stopped(this.#owner) || !janitor.ledger.alive(this.#owner));
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get targetId(): string {
    return this.#targetId;
  }

  get lastObservation(): Observation | null {
    return this.#lastObservation;
  }

  get loadId(): string {
    return `${this.#targetId}:${this.#navigationCount}`;
  }

  /**
   * Every open tab, newest information first-hand from the browser.
   *
   * Asked of `Target.getTargets` each time rather than tracked from events:
   * tabs are opened and closed by the page, by the user, and by other tabs,
   * and a cached list is wrong exactly when it matters.
   */
  async tabs(): Promise<TabInfo[]> {
    const { targetInfos } = await this.#client.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string; title?: string; openerId?: string }>;
    }>('Target.getTargets');
    return targetInfos
      .filter((t) => t.type === 'page' && (t.targetId === this.#targetId || (!isBrowserOwnPage(t.url) && !ownedElsewhere(t.targetId, this, targetInfos))))
      .map((t) => ({
        id: t.targetId,
        url: t.url,
        title: markUntrusted(t.title ?? ''),
        current: t.targetId === this.#targetId,
        opened: !this.#knownTabs.has(t.targetId) && this.#knownTabs.size > 0,
      }));
  }

  /**
   * Move this page's attention to another tab.
   *
   * Re-attaches in place rather than handing back a new object, so every
   * holder of this Page — the loop, the runtime, the scheduler — follows
   * along instead of half of them continuing to drive an abandoned tab.
   */
  async switchTab(targetId: string): Promise<void> {
    if (targetId === this.#targetId) return;
    const { targetInfos } = await this.#client.send<{
      targetInfos: Array<{ targetId: string; type: string; url?: string; openerId?: string }>;
    }>('Target.getTargets');
    const found = targetInfos.find((t) => t.targetId === targetId && t.type === 'page' && !isBrowserOwnPage(t.url ?? '') && !ownedElsewhere(targetId, this, targetInfos));
    if (!found) throw new ActionFailureError('NOT_ACTIONABLE', `no open tab has the id ${targetId}: use one of the tab ids the snapshot lists`);

    const previous = this.#sessionId;
    const { sessionId } = await this.#client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId, flatten: true,
    });
    // The tab left behind no longer says Fanfold works in it.
    const shown = this.#indicator.state;
    if (shown) await this.#indicator.clear().catch(() => {});
    this.#sessionId = sessionId;
    this.#targetId = claimTarget(targetId, this);
    this.#scriptId = null;
    const janitor = this.#owner ? janitorOf(this.#client) : null;
    // A tab of Fanfold's own browser that nobody owns becomes this work's; in the user's Chrome it stays theirs.
    if (janitor && this.#owner && janitor.mode !== 'extension' && !janitor.ledger.get(targetId)) janitor.claim(targetId, this.#owner, found.url ?? undefined);
    // Refs belong to the old document. Dropping the observation makes every
    // one of them fail locally rather than resolving against a page they
    // never came from. The same goes for a dialog or a load in progress.
    this.#lastObservation = null;
    this.#dialogOpen = false;
    this.#navInFlight = false;
    this.#navExpectedUntil = 0;
    // Bring it to the front. Input goes to the tab as a window, and a
    // background tab is throttled: clicks can be dropped and timers slowed,
    // which shows up later as a link that reported a successful click and
    // never navigated.
    await this.#client.send('Target.activateTarget', { targetId }).catch(() => {});
    await this.#init();
    if (shown) await this.#indicator.set(shown);
    // Only after the new session works. Detaching first would leave nothing
    // attached if the new attach failed.
    this.#sessionGone = false;
    this.#rendererCrashed = false;
    this.#lastUrl = found.url ?? null;
    await this.#client.send('Target.detachFromTarget', { sessionId: previous }).catch(() => {});
  }

  /**
   * Fanfold's own addresses are closed to this tab. A site that redirects
   * there would otherwise reach Fanfold as if the person had typed the
   * address (Chrome says a navigation Fanfold started comes from no site) and
   * could make it open Review on their screen. It is set on this tab alone,
   * so Fanfold's own window, if it is open in the same Chrome, is untouched.
   */
  async #blockOwnOrigins(): Promise<void> {
    const { version, urls } = ownOriginBlock();
    if (this.#ownWindow || version === this.#blockedVersion) return;
    const first = this.#blockedVersion === -1;
    this.#blockedVersion = version;
    // Only requests to these addresses are held, and each is failed at once (see #wireListeners).
    // With none, interception is off: Fetch.enable with no patterns would hold every request.
    const sent = urls.length
      ? this.#send('Fetch.enable', { patterns: urls.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) })
      : first ? Promise.resolve() : this.#send('Fetch.disable');
    await sent.catch(() => {});
  }

  /** Downloads land in the agent's own state directory; see downloads.ts. */
  async #enableDownloads(): Promise<void> {
    await this.#downloads.enable(this.#client, join(stateDir(), 'downloads'), (frameId) => frameId === this.#targetId || this.#frames.has(frameId));
  }

  async #init(): Promise<void> {
    await this.#send('Page.enable');
    await this.#send('Runtime.enable');
    await this.#send('DOM.enable');
    // Several sessions take turns at the front. Without this, bringing one
    // forward blurs the field another is typing in, and a typeahead closes
    // its list on blur before its suggestion can be picked.
    await this.#send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    this.#requests ??= new Requests(this.#client, () => this.#sessionId, () => this.#targetId);
    this.#requests.reset();
    await this.#send('Network.enable').catch(() => {});

    // Runs before any page script on every future document, including
    // same-document history navigations and iframes.
    const { identifier } = await this.#send<{ identifier: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: SERIALIZER_SOURCE, runImmediately: true },
    );
    this.#scriptId = identifier;

    this.#wireListeners();
    this.#blockedVersion = -1;
    await this.#blockOwnOrigins();
    await this.#enableDownloads();

    // The current document predates addScriptToEvaluateOnNewDocument.
    await this.#ensureSerializer();
  }

  /**
   * Client-level event listeners, attached exactly once.
   *
   * These are on the CLIENT, not the session, and #init runs again on every
   * tab switch — so without the guard a switch would leave two of each, and
   * every navigation would be counted twice by handlers that both match the
   * now-current session.
   */
  /** A client event this page listens to for as long as it is open. */
  #on(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): void {
    this.#offs.push(this.#client.on(event, handler));
  }

  #wireListeners(): void {
    if (this.#listenersWired) return;
    this.#listenersWired = true;

    // A request to Fanfold's own address from this tab never leaves it; see #blockOwnOrigins.
    this.#on('Fetch.requestPaused', (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      this.#stoppedOwn = true;
      void this.#send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });

    const lost = (crashed = false): void => {
      this.#sessionGone = true;
      this.#rendererCrashed ||= crashed;
      this.#lastObservation = null;
      this.#indicator.pause();
    };
    this.#on('Inspector.targetCrashed', (_params, sessionId) => {
      if (sessionId === this.#sessionId) lost(true);
    });
    this.#on('Target.targetCrashed', (params) => {
      if (params.targetId === this.#targetId) lost(true);
    });
    this.#on('Inspector.detached', (params, sessionId) => {
      if (sessionId === this.#sessionId) lost(params.reason === 'Render process gone.');
    });
    this.#on('Target.detachedFromTarget', (params) => {
      if (params.sessionId === this.#sessionId) lost();
    });

    // A dialog blocks the page until it is answered; see dialogs.ts for how
    // each kind is answered and why.
    this.#on('Page.javascriptDialogClosed', (_params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      this.#dialogOpen = false;
    });

    this.#on('Page.javascriptDialogOpening', (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      this.#dialogOpen = true;
      const event = answerDialog(params, this.#navigatingByCommand);
      const { type } = event;
      const accept = event.answer === 'accepted';
      this.#pendingDialog = event;
      if (type === 'beforeunload') {
        this.#dialogsAnswered++;
        // Accepting releases a navigation that has not started yet, and
        // settling must wait for it. Dismissing means nothing will land on
        // its own — the recovery should run at once.
        this.#navExpectedUntil = accept ? Date.now() + 1_500 : 0;
      }
      // Fire-and-forget: the page is blocked until this lands, so it must not
      // wait on anything, and a failure here is nothing the caller can fix.
      void this.#send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
    });

    this.#on('Page.frameRequestedNavigation', (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      if (this.#mainFrameId && params.frameId !== this.#mainFrameId) return;
      // Only a link. A form post or a scripted navigation must never be
      // re-issued — replaying those is how something gets submitted twice.
      if (params.reason !== 'anchorClick') return;
      this.#requestedNavigation = { url: String(params.url ?? ''), at: Date.now() };
    });

    this.#on('Page.frameStartedLoading', (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      if (!this.#mainFrameId || params.frameId === this.#mainFrameId) this.#navInFlight = true;
    });
    this.#on('Page.frameStoppedLoading', (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      if (!this.#mainFrameId || params.frameId === this.#mainFrameId) this.#navInFlight = false;
    });

    this.#on('Page.frameNavigated', (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      const frame = params.frame as { parentId?: string; id?: string } | undefined;
      // The frames of this tab: a download one of them starts is this page's to report.
      if (frame?.id) this.#frames.add(frame.id);
      if (frame && !frame.parentId) {
        this.#mainFrameId = frame.id ?? this.#mainFrameId;
        // A dialog cannot survive the document it belongs to. If the closed
        // event was never seen — the tab was replaced, or the dialog went
        // down with the old document — this is where the flag comes back,
        // instead of refusing every later navigation as "a dialog is open".
        this.#dialogOpen = false;
        this.#navigationCount++;
        // Refs from before a navigation are dead. Dropping the observation
        // here means a stale ref fails on the Node side too, not only in
        // the page, so we never round-trip a doomed action.
        this.#lastObservation = null;
      }
    });

  }

  async #send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return await this.#client.send<T>(method, params, this.#sessionId);
    } catch (err) {
      /*
       * The TAB died, not the browser.
       *
       * A renderer crash ("Aw, Snap!"), a tab closed by script or by the
       * user, a target discarded under memory pressure — the browser process
       * is fine and the transport is fine, so nothing above reconnects, and
       * every later command would fail with the same CDP error forever. This
       * is recoverable: attach to another page target and carry on.
       *
       * The failed command is deliberately NOT retried. Some of them are
       * input, and a click that is replayed after the session comes back is
       * a click that may happen twice. The document is gone either way, so
       * this reports a lost navigation and lets the caller re-observe.
       */
      if (isTransportLoss((err as Error)?.message ?? '')) throw err;
      if (isSessionGone(err) || this.#sessionGone) {
        this.#sessionGone = true;
        this.#lastObservation = null;
        throw new ActionFailureError(
          'TAB_LOST',
          `the tab this page was driving is gone (${(err as Error).message})`,
        );
      }
      throw err;
    }
  }

  /**
   * Attach to a live tab after the previous one disappeared.
   *
   * Prefers an existing page over opening one: after a renderer crash Chrome
   * usually still has the tab, and reusing it keeps whatever the session had.
   */
  async #reattach(): Promise<void> {
    const { targetInfos } = await this.#client.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    }>('Target.getTargets');
    const usable = targetInfos.filter((t) => t.type === 'page');
    // Recover the same tab or create one. Never navigate an unrelated tab
    // merely because it happened to be first in Target.getTargets.
    let target = usable.find((t) => t.targetId === this.#targetId);
    // Work that has ended, or that the user stopped, gets no new tab: that is what stopping it means.
    if (!target && this.#ownerGone()) {
      throw new ActionFailureError('TAB_LOST', 'the tab this page was driving is gone, and the work it belonged to has ended or was stopped by the user');
    }
    // A tab that was closed, by its page or by the person, is not opened again
    // behind their back: the work goes back to the tab it started in, or on in
    // a new blank one, and `lostTab` says so.
    const closed = target ? null : { url: this.#lastUrl };
    if (closed) {
      target = this.#targetId !== this.#home ? usable.find((t) => t.targetId === this.#home) : undefined;
      this.#lastUrl = target?.url ?? null;
      this.#rendererCrashed = false;
    }
    const targetId = target?.targetId ?? await createTargetWithRetry(this.#client, { owner: this.#owner });

    const previousSession = this.#sessionId;
    const { sessionId } = await this.#client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId, flatten: true,
    });
    this.#sessionId = sessionId;
    this.#targetId = claimTarget(targetId, this);
    this.#scriptId = null;
    this.#lastObservation = null;
    // A dialog, a navigation in flight, an expected navigation: all belonged
    // to the tab that is gone. Carrying them over would gate the new tab on
    // events it will never see.
    this.#dialogOpen = false;
    this.#navInFlight = false;
    this.#navExpectedUntil = 0;
    if (this.#rendererCrashed) {
      // Attaching to an Aw-Snap target does not revive its renderer.
      // Runtime.enable/evaluate can then wait forever. A browser-initiated
      // navigation recreates the renderer before we inject or evaluate JS.
      // Page.enable is renderer-bound too: navigate before enabling domains.
      const url = this.#lastUrl ?? target?.url ?? 'about:blank';
      const result = await this.#send<{ errorText?: string }>('Page.navigate', { url });
      if (result.errorText) throw new Error(`renderer recovery navigation failed: ${result.errorText}`);
    }
    await this.#init();
    await this.#indicator.reattached();

    /*
     * Put the new tab back where the old one was.
     *
     * A tab that dies takes its document with it, and the replacement opens
     * blank. Without this the agent would re-observe an empty page and have
     * to work out for itself that it had been somewhere — the resilient
     * runtime already does exactly this after a relaunch, and a tab dying is
     * the same loss one level down.
     */
    if (this.#lastUrl) {
      const here = await this.#send<{ frameTree?: { frame?: { url?: string } } }>('Page.getFrameTree')
        .catch(() => ({} as { frameTree?: { frame?: { url?: string } } }));
      const current = here.frameTree?.frame?.url ?? '';
      if (current !== this.#lastUrl && (current === '' || current.startsWith('about:'))) {
        await this.#gotoOnce(this.#lastUrl, 15_000).catch(() => { /* the caller will see a blank page and re-navigate */ });
      }
    }
    // Cleared LAST, once there is really a working session. Cleared on the
    // way in, a reattach that failed partway would leave the page believing
    // it had recovered, and the next call would go straight back to the dead
    // session instead of trying again.
    if (closed) this.#lostTab = { id: ++tabsLost, url: closed.url, back: !!target };
    this.#sessionGone = false;
    this.#rendererCrashed = false;
    if (previousSession !== this.#sessionId) {
      await this.#client.send('Target.detachFromTarget', { sessionId: previousSession }).catch(() => {});
    }
  }

  async #evaluate<T>(expression: string): Promise<T> {
    const res = await this.#send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // The page is untrusted, but this expression is ours; user gesture is
      // needed for things like programmatic focus on some elements.
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page evaluation failed: ${d.exception?.description ?? d.text}`);
    }
    return res.result.value as T;
  }

  /** Re-inject if the document replaced our globals (navigation, or a hostile page). */
  async #ensureSerializer(): Promise<void> {
    const present = await this.#evaluate<boolean>(
      `typeof window.__ba === "object" && window.__ba !== null && window.__ba.version === ${SERIALIZER_VERSION}`,
    );
    if (!present) await this.#evaluate<unknown>(SERIALIZER_SOURCE);
  }

  // ------------------------------------------------------------ navigation

  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    await this.#noteTabs(false);
    try {
      await this.#goto(url, timeoutMs);
    } finally {
      await this.#noteTabs(true);
    }
  }

  async #goto(url: string, timeoutMs: number): Promise<void> {
    if (this.#sessionGone) await this.#reattach();
    try {
      await this.#gotoOnce(url, timeoutMs);
    } catch (err) {
      // The tab can also die DURING the navigation — reported at
      // Page.navigate, or later at serializer injection. Navigating is the
      // caller's own explicit intent and dispatches no input, so doing it
      // once on a live tab is safe where retrying a click would not be.
      if (!this.#sessionGone) throw err;
      await this.#reattach();
      await this.#gotoOnce(url, timeoutMs);
    }
  }

  /**
   * Wait until Chrome is not in the middle of something that a new command
   * would collide with: no dialog showing, no navigation in flight, and no
   * navigation just released by an accepted guard and not yet started.
   *
   * Chromium hard-CHECKs when a navigation is started under an open
   * beforeunload dialog. A guarded link's recovery that re-issues
   * Page.navigate while the guard's second dialog is still being answered
   * takes a healthy Chrome down with it, on every run from an ordinary
   * Terminal. So nothing here starts a navigation into a dialog.
   */
  async #quiescent(maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!this.#dialogOpen && !this.#navInFlight && Date.now() >= this.#navExpectedUntil) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return !this.#dialogOpen;
  }

  /**
   * Follow a link whose guard the page raised and we dismissed.
   *
   * The navigation is re-issued as OUR OWN Page.navigate. If the guard fires
   * again for that, it is accepted — a browser-initiated navigation is the
   * path Chrome handles well, the same as a person typing a URL and clicking
   * Leave — and the page moves on.
   *
   * Nothing is evaluated in the old document first. Standing the guard down
   * with `window.onbeforeunload = null` before navigating ended, on a healthy
   * machine, 330ms after a perfectly successful navigation, with "Render
   * process gone" and Chrome exiting 0; runs where the guard stayed and was
   * accepted on our navigation stayed alive. So the page is left alone, and
   * Chrome is asked to leave it the way a person would.
   */
  async #completeGuardedNavigation(url: string, navBefore: number): Promise<void> {
    for (let attempt = 0; attempt < 2 && this.#navigationCount === navBefore; attempt++) {
      // Wait for the dismissed dialog to be gone and nothing to be loading.
      // Navigating while a dialog is open is a hard-CHECK in Chromium.
      if (!(await this.#quiescent(2_000))) return;
      if (this.#navigationCount !== navBefore) return;
      await this.goto(url).catch((err) => {
        // A browser that went away during the recovery is reported as
        // exactly that. Swallowing it would turn a lost browser into a
        // click that quietly did nothing.
        if (isTransportLoss((err as Error)?.message ?? '')) throw err;
      });
    }
  }

  async #gotoOnce(url: string, timeoutMs: number): Promise<void> {
    // Never into an open dialog — see #quiescent. A dialog nobody answers
    // would hold this for the whole window, so the wait is bounded, and a
    // still-open dialog after it is refused rather than navigated through.
    if (!(await this.#quiescent(3_000))) {
      throw new Error(`navigation to ${url} refused: a JavaScript dialog is still open`);
    }
    /*
     * Stop whatever is still loading before starting something new.
     *
     * A navigation that nobody is waiting for any more is not a navigation
     * that stopped: abandoning the wait does not abandon the work. The
     * orphan then aborts the next one with net::ERR_ABORTED, so a single slow
     * page makes every page after it look unreachable — measured across ten
     * real sites, where one timeout turned the following six into failures on
     * two different machines.
     */
    if (this.#navInFlight && !this.#dialogOpen) {
      await this.#send('Page.stopLoading').catch(() => {});
      this.#navInFlight = false;
    }

    await this.#blockOwnOrigins();
    this.#stoppedOwn = false;
    const loaded = this.#waitForLoad(timeoutMs);
    const navStarted = Date.now();
    this.#navigatingByCommand = true;
    try {
      const res = await this.#send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url });
      if (res.errorText && this.#stoppedOwn) {
        // Off the error page too, whose Reload would only ask for the same address again.
        await this.#send('Page.navigate', { url: 'about:blank' }).catch(() => {});
        throw new Error('the page went to Fanfold\'s own window, which only the person uses, and was stopped before it got there. Open another address.');
      }
      if (res.errorText) throw new Error(`navigation to ${url} failed: ${res.errorText}`);
      this.#lastUrl = url;
      // No loader means the document did not change: only the fragment did.
      // No load event is coming, and waiting for one would cost the whole timeout.
      if (!res.loaderId) loaded.cancel();
      await loaded.done;
    } finally {
      // A navigation that was refused never loads. Left running, its timer
      // would hold the process open for the whole timeout.
      loaded.cancel();
      this.#navigatingByCommand = false;
    }
    await awaitContent((e) => this.#evaluate(e), { busy: () => (this.#requests?.pending(navStarted) ?? 0) > 0 });
    await this.#ensureSerializer();
  }

  #waitForLoad(timeoutMs: number): { done: Promise<void>; cancel(): void } {
    let cancel: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        off();
        // A load event that never fires is common on pages with long-polling
        // connections. The document is usually usable well before that, so a
        // timeout here is a soft signal, not an error.
        resolve();
      }, timeoutMs);
      const off = this.#client.on('Page.loadEventFired', (_params, sessionId) => {
        if (sessionId !== this.#sessionId) return;
        clearTimeout(timer);
        off();
        resolve();
      });
      cancel = () => { clearTimeout(timer); off(); resolve(); };
    });
    return { done, cancel };
  }

  // ----------------------------------------------------------- observation

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    // A tab that died leaves this page driving a session that no longer
    // exists. Observing is where it gets picked up: it is what a caller does
    // after any failure, and — unlike acting — it dispatches no input, so
    // discovering the loss mid-observation can simply be retried once on a
    // live tab rather than handed back as an error the caller must handle.
    if (this.#sessionGone) await this.#reattach();
    try {
      return await this.#observeOnce(options);
    } catch (err) {
      if (!this.#sessionGone) throw err;
      await this.#reattach();
      return await this.#observeOnce(options);
    }
  }

  async #observeOnce(options: ObserveOptions): Promise<Observation> {
    const started = Date.now();
    await this.#ensureSerializer();
    const raw = await this.#evaluate<RawObservation>(
      `window.__ba.observe(${JSON.stringify({
        interactive: options.interactive ?? false,
        viewportOnly: options.viewportOnly ?? false,
        refBase: this.#refHigh,
      })})`,
    );
    this.#refHigh = Math.max(this.#refHigh, raw.refHigh ?? 0);

    const nodes: ObservedNode[] = raw.nodes.map((n) => ({
      ref: n.ref as Ref | null,
      role: n.role,
      name: markUntrustedOrNull(n.name),
      value: markUntrustedOrNull(n.value),
      // A frame's text is its address, which may be Fanfold's own and carry the key.
      text: markUntrustedOrNull(n.role === 'frame' && n.text ? withoutKey(n.text) : n.text),
      depth: n.depth,
      state: n.state,
      evidence: n.evidence,
      ...(n.options ? { options: n.options.map(markUntrusted) } : {}),
    }));

    const observation: Observation = {
      pageStateId: raw.stateId as PageStateId,
      url: raw.url,
      title: markUntrusted(raw.title),
      nodes,
      walkMs: raw.walkMs,
      totalMs: Date.now() - started,
      truncated: raw.truncated,
      truncationReason: raw.truncationReason ?? null,
      ...(raw.ready && raw.ready !== 'complete' ? { loading: true } : {}),
      frames: raw.frames ?? 0,
      // Reported once, on the first observation after it was answered. It is
      // a thing that happened, not a property of the page, so it does not
      // persist into every later observation.
      dialog: this.#pendingDialog,
    };
    this.#pendingDialog = null;
    this.#lastUrl = observation.url;

    // Only when there is something to say. One tab is the normal case and
    // costs nothing to leave out; several is the case a model has to know
    // about, because the page it is looking at may not be where its last
    // click landed.
    const tabs = await this.tabs().catch(() => [] as TabInfo[]);
    if (tabs.length > 1) observation.tabs = tabs;
    this.#knownTabs = new Set(tabs.map((t) => t.id));

    // Reported once, like a dialog: a download is an event, not a property of
    // the page. Ones still in flight stay on the list until they settle.
    const downloads = this.#downloads.drain();
    if (downloads.length) {
      observation.downloads = downloads;
    }

    this.#lastObservation = observation;
    return observation;
  }

  // --------------------------------------------------------------- actions

  async act(req: ActionRequest): Promise<ActionResult> {
    await this.#noteTabs(false);
    try {
      return await this.#act(req);
    } finally {
      await this.#noteTabs(true);
    }
  }

  async #act(req: ActionRequest): Promise<ActionResult> {
    const started = Date.now();
    const navBefore = this.#navigationCount;
    try {
      const dialogsBefore = this.#dialogsAnswered;
      const requestedBefore = this.#requestedNavigation;
      const done = NEEDS_FOREGROUND.has(req.kind)
        ? await exclusiveInput(this.#client, (release, aside) => this.#dispatch(req, release, aside))
        : await this.#dispatch(req);
      // Let a navigation or re-render that the action triggered settle enough
      // to be observable, without paying a fixed sleep on every action.
      await settleAfterAction({
        pending: (since) => this.#requests?.pending(since) ?? 0,
        navigating: () => this.#navInFlight || Date.now() < this.#navExpectedUntil,
        evaluate: (expression) => this.#evaluate(expression),
      }, started);

      /*
       * A guarded link that was approved and then went nowhere.
       *
       * Chrome sometimes re-runs beforeunload at the moment the navigation
       * commits, and answering that second one leaves the navigation
       * abandoned: the guard was accepted, loading started, and no
       * frameNavigated ever arrives. Traced repeatedly — one dialog navigates,
       * two do not.
       *
       * The intent is not in doubt here: the page asked to follow a LINK and
       * the guard was answered yes. So the navigation is completed rather
       * than left as a click that reported success and did nothing. Strictly
       * anchor clicks: a form submission or a scripted navigation is never
       * re-issued, because replaying one can submit something twice.
       */
      const guardAnswered = this.#dialogsAnswered > dialogsBefore;
      const request = this.#requestedNavigation;
      if (
        guardAnswered && this.#navigationCount === navBefore
        && request && request !== requestedBefore && request.url
      ) {
        await this.#completeGuardedNavigation(request.url, navBefore);
      }

      return {
        ok: true,
        navigated: this.#navigationCount > navBefore,
        ms: Date.now() - started,
        // What was done when it is more than was asked: the option a list was answered with.
        ...(done ? { detail: done } : {}),
      };
    } catch (err) {
      const failure = classify(err);
      return {
        ok: false,
        failure,
        detail: (err as Error).message,
        navigated: this.#navigationCount > navBefore,
        ms: Date.now() - started,
      };
    }
  }

  /**
   * Bring this tab to the front, immediately before input is dispatched.
   *
   * Input is delivered to a tab as a window, and a BACKGROUND tab drops it:
   * the click is accepted by the protocol, no handler runs, and the action
   * reports a clean success with nothing changed. Any page that opens a
   * second tab backgrounds the first, so after one `target="_blank"` link the
   * agent could no longer click anything on the page it came from — measured
   * as three clicks producing no navigation event at all.
   *
   * A failure here is NOT swallowed. Dispatching anyway is how a click that
   * went nowhere gets reported as success. But a transport failure is passed
   * through unchanged: the browser going away must stay TRANSPORT_LOST so
   * that the layers above reconnect, rather than being relabelled as a tab
   * that would not come forward.
   */
  async #foreground(): Promise<void> {
    try {
      await this.#client.send('Target.activateTarget', { targetId: this.#targetId });
    } catch (err) {
      if (isTransportLoss((err as Error)?.message ?? '')) throw err;
      throw new ActionFailureError(
        'NOT_ACTIONABLE',
        `could not bring the tab to the front, so input may not reach it: ${(err as Error).message}`,
      );
    }
  }

  async #dispatch(req: ActionRequest, inputDone?: () => void, aside?: InputAside): Promise<string | void> {
    switch (req.kind) {
      case 'goto':
        if (!req.url) throw new Error('goto requires a url');
        await this.goto(req.url);
        return;
      case 'press':
        if (!req.key) throw new Error('press requires a key');
        await this.#foreground();
        await pressKey(this.#input, req.key);
        return;
      case 'scroll':
        await this.#foreground();
        await scroll(this.#input, req.amount ?? 500, req.ref);
        return;
      case 'switchTab':
        if (!req.value) throw new Error('switchTab requires the tab id');
        await this.switchTab(req.value);
        return;
      case 'upload': {
        const files = (req.files ?? []).filter(Boolean);
        if (!files.length) throw new Error('upload requires at least one file path');
        await setFileInputFiles(this.#input, req, files, this.#lastObservation?.pageStateId);
        return;
      }
      case 'click':
      case 'hover':
      case 'fill':
      case 'type':
      case 'select':
      case 'check':
      case 'uncheck': {
        // Resolution FIRST, activation second. The lease and drift checks are
        // local, cost nothing, and say something more useful than "the tab
        // would not come forward" — a stale ref should be reported as a stale
        // ref even when the browser is also on fire.
        const target = await this.#resolveTarget(req);
        await this.#foreground();
        // Another tab may have come to the front while this one waited aside: it comes forward again before more input.
        const inputAside = aside
          ? async <W>(wait: () => Promise<W>): Promise<W> => {
            const result = await aside(wait);
            await this.#foreground();
            return result;
          }
          : undefined;
        return await dispatchOnTarget({ ...this.#input, inputDone, inputAside }, req, target);
      }
      default: {
        const never: never = req.kind;
        throw new Error(`unsupported action: ${String(never)}`);
      }
    }
  }

  /**
   * Validate the ref lease and get geometry in one round trip.
   *
   * This is where the lease rule is enforced: the stateId must still be the
   * live one, the element must still be attached, and its role and accessible
   * name must match what we observed. A re-render that replaced the element
   * fails as TARGET_DRIFT instead of clicking whatever now occupies that slot.
   */
  async #resolveTarget(req: ActionRequest): Promise<Extract<ResolveResult, { ok: true }>> {
    if (!req.ref) throw new ActionFailureError('UNKNOWN_REF', `${req.kind} requires a ref`);
    if (!req.pageStateId) {
      throw new ActionFailureError('STALE_STATE', `${req.kind} requires the pageStateId the ref came from`);
    }
    if (!this.#lastObservation) {
      throw new ActionFailureError('STALE_STATE', 'no live observation — the page navigated since it was taken');
    }
    if (this.#lastObservation.pageStateId !== req.pageStateId) {
      throw new ActionFailureError(
        'STALE_STATE',
        `ref is from observation ${req.pageStateId}, current is ${this.#lastObservation.pageStateId}`,
      );
    }

    // Resolution, scroll and geometry happen in ONE page round trip, in
    // top-level coordinates — see absoluteBox() in the serializer.
    const expr = `window.__ba
      ? window.__ba.describe(${JSON.stringify(req.pageStateId)}, ${JSON.stringify(req.ref)})
      : { ok: false, failure: 'STALE_STATE', detail: 'serializer gone — document replaced' }`;

    const result = await this.#evaluate<ResolveResult>(expr);
    if (!result.ok) throw new ActionFailureError(result.failure, result.detail);
    return result;
  }

  async screenshot(): Promise<Buffer> {
    // The indicator is Fanfold's, not the page's: a model looking at the capture must not see it.
    const { data } = await this.#indicator.hidden(() => this.#send<{ data: string }>('Page.captureScreenshot', { format: 'png' }));
    return Buffer.from(data, 'base64');
  }

  /**
   * Whether Chrome still draws this page (frames.ts), asked in a world of
   * Fanfold's own with no user gesture, so the page's scripts can neither
   * answer for it nor use it.
   */
  drawing(): Promise<FrameState> {
    return frameState((e) => this.#probe.evaluate(e, this.#mainFrameId, `${this.#sessionId}:${this.#navigationCount}`));
  }

  /** How the site answered since `since` (requests.ts). */
  documentResponse(since = 0): DocumentResponse | null { return this.#requests?.document(since) ?? null; }

  /** The job data the page carries for itself: JSON-LD blocks, the first heading, the site's name. Reads only; what it returns is the page's text. */
  async jobPosting(): Promise<PageJobData> {
    const data = await this.#evaluate<PageJobData | null>(`(() => {
      const meta = (n) => { const m = document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]'); return m ? (m.getAttribute('content') || '').trim().slice(0, 200) || null : null; };
      const h1 = document.querySelector('h1');
      return {
        ld: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10).map((s) => String(s.textContent || '').slice(0, 60000)),
        heading: h1 ? String(h1.innerText || h1.textContent || '').trim().slice(0, 300) || null : null,
        siteName: meta('og:site_name') || meta('application-name'),
        title: String(document.title || '').slice(0, 300),
      };
    })()`);
    // A page can make its own globals return anything: only the shape is trusted, never the words.
    const text = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    return {
      ld: Array.isArray(data?.ld) ? data.ld.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
      heading: text(data?.heading, 300), siteName: text(data?.siteName, 200), title: text(data?.title, 300) ?? '',
    };
  }

  /** Report what a person does on this page until the returned function is called (recorder.ts). */
  async record(onEvent: (event: RecordedEvent) => void): Promise<() => Promise<void>> {
    await this.#ensureSerializer();
    return startRecording({
      send: (method, params) => this.#send(method, params),
      evaluate: (expression) => this.#evaluate<unknown>(expression),
      onBinding: (handler) => this.#client.on('Runtime.bindingCalled', (params, sessionId) => {
        if (sessionId === this.#sessionId) handler(params);
      }),
    }, onEvent);
  }

  /** Put this tab in front, for a person who is about to use it. */
  async focus(): Promise<void> {
    await this.#foreground();
  }

  /**
   * Close the tabs its pages opened ("Apply on company website" opens one),
   * and come back to the tab it started in. Left open, they pile up in front
   * of the next agent as tabs it never opened.
   */
  async closeOpened(): Promise<number> {
    const pages = await this.#noteTabs(false);
    const home = pages.some((t) => t.targetId === this.#home) ? this.#home : this.#targetId;
    // Only what this tab's own actions opened, however deep: another session's
    // popups are its own, and a tab the person opened, from here or not, is theirs.
    const family = familyOf(home, pages, (targetId) => !ownedElsewhere(targetId, this) && this.#opened.opened(targetId));
    if (this.#targetId !== home && family.has(this.#targetId)) await this.switchTab(home);
    family.delete(home);
    family.delete(this.#targetId);
    for (const targetId of family) await this.#client.send('Target.closeTarget', { targetId }).catch(() => {});
    return family.size;
  }

  /** Look at the tabs opened from this page: before an action, after one (`done`), or before closing them. */
  async #noteTabs(done: boolean): Promise<TargetLineage[]> {
    const { targetInfos } = await this.#client.send<{ targetInfos: Array<TargetLineage & { type: string }> }>('Target.getTargets')
      .catch(() => ({ targetInfos: [] as Array<TargetLineage & { type: string }> }));
    const pages = targetInfos.filter((t) => t.type === 'page');
    const home = pages.some((t) => t.targetId === this.#home) ? this.#home : this.#targetId;
    if (done) this.#opened.acted();
    this.#opened.note([...familyOf(home, pages)].filter((id) => id !== home), done);
    return pages;
  }

  /**
   * A fresh tab with its own CDP session.
   *
   * Its own session is the point: two Pages sharing one would interleave
   * their requests and each would see the other's page. Closing removes the
   * tab as well as detaching, or a fan-out would leave a window full of them.
   *
   * With a ledger, the tab belongs to `owner`, or to the run this is called
   * from, or to the tab itself: it is that work's until closed, and what its
   * pages open is that work's too. Closing it ends the work's hold on it, and
   * the user stopping the work closes it.
   */
  async openTab(opts: { window?: boolean; owner?: Owner } = {}): Promise<Tab> {
    const ledger = janitorOf(this.#client)?.ledger ?? null;
    const owner: Owner | null = opts.owner ?? (ledger ? { kind: 'run', id: currentRun() ?? randomUUID() } : null);
    let closed = false;
    let page: Page | null = null;
    let targetId: string | null = null;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await page?.close().catch(() => {});
      // A tab the ledger let go of is no longer Fanfold's to close (the user took it back).
      if (targetId && (!ledger || ledger.get(targetId))) await this.#client.send('Target.closeTarget', { targetId }).catch(() => {});
      end?.();
    };
    // Alive before the tab exists, so no sweep finds it owned by nothing.
    const end = ledger && owner ? ledger.begin(owner, opts.owner ? undefined : close) : null;
    try {
      targetId = await createTargetWithRetry(this.#client, { window: opts.window ? await this.#nextWindow() : undefined, owner });
      page = await Page.attach(this.#client, targetId, { ownWindow: this.#ownWindow, owner });
    } catch (err) {
      await close();
      throw err;
    }
    return { page, close, ...(owner ? { owner } : {}) };
  }

  /**
   * Leave this tab as it is, for the person, and carry on in a new tab of the
   * same work: a check a site put up for the person stays where they can
   * finish it, and nothing more is done in it. With a ledger, the tab left is
   * kept for them until `keep.until`.
   */
  async leaveTab(keep: { until: Date; why: string }): Promise<boolean> {
    const left = this.#targetId;
    const targetId = await createTargetWithRetry(this.#client, { owner: this.#owner });
    await this.switchTab(targetId);
    // What this page opens from now on, and where closeOpened comes back to, is the new tab's.
    this.#home = targetId;
    const ledger = this.#owner ? janitorOf(this.#client)?.ledger : null;
    if (ledger?.get(left)) ledger.keep(left, keep.until, keep.why);
    return true;
  }

  /** Where a session's own window goes: see windowPlace. */
  async #nextWindow(): Promise<WindowBounds | true> {
    const at = await this.#evaluate<{ x: number; y: number; w: number; h: number; sx: number; sy: number; sw: number; sh: number }>(
      '({ x: screenX, y: screenY, w: outerWidth, h: outerHeight, sx: screen.availLeft, sy: screen.availTop, sw: screen.availWidth, sh: screen.availHeight })',
    ).catch(() => null);
    const n = openWindows.get(this.#client) ?? 0;
    openWindows.set(this.#client, n + 1);
    if (!at || !at.w || !at.h) return true;
    const screen = at.sw > 0 && at.sh > 0 ? { left: at.sx || 0, top: at.sy || 0, width: at.sw, height: at.sh } : null;
    return windowPlace(n, screen, { left: at.x, top: at.y, width: at.w, height: at.h });
  }

  async close(): Promise<void> {
    if (this.#indicator.state) await this.#indicator.clear().catch(() => {});
    else this.#indicator.dispose();
    if (this.#scriptId) {
      await this.#send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.#scriptId }).catch(() => {});
    }
    const { targetInfos } = await this.#client.send<{ targetInfos: TargetLineage[] }>('Target.getTargets').catch(() => ({ targetInfos: [] }));
    await this.#client.send('Target.detachFromTarget', { sessionId: this.#sessionId }).catch(() => {});
    releaseTargets(this, this.#home, targetInfos);
    // The client is shared and outlives this page: nothing of it keeps calling a page that is gone.
    for (const off of this.#offs.splice(0)) off();
    this.#requests?.dispose();
    this.#downloads.dispose();
  }
}
