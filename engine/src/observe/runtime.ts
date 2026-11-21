/**
 * The browser abstraction.
 *
 * The orchestrator talks to this, never to CDP. Two reasons, both from the
 * plan and both load-bearing:
 *
 *  1. The driver choice should be settled by measurement, not by argument.
 *    Keeping the seam here means a second backend can be benchmarked against
 *    the first on the same tasks rather than compared on paper.
 *
 *  2. A browser is a slow, stateful, flaky dependency. With the seam, the loop
 *    can be tested against a deterministic fake — approval gating, failure
 *    recovery, duplicate suppression — none of which should need a real Chrome
 *    to verify.
 */

import type { Observation, ActionRequest, ActionResult } from '../types.ts';
import type { RecordedEvent } from './recorder.ts';
import type { FrameState } from './frames.ts';
import type { DocumentResponse } from './requests.ts';
import type { Owner } from './tab-ledger.ts';
import type { IndicatorState } from './indicator.ts';

export interface ObserveOptions {
  interactive?: boolean;
  viewportOnly?: boolean;
}

/** An independent tab, for reading several pages at once. */
export interface Tab {
  page: BrowserRuntime;
  /** Detaches and closes the tab. Safe to call twice. */
  close(): Promise<void>;
  /** The work this tab belongs to (tab-ledger.ts), when the browser keeps a ledger. */
  owner?: Owner;
}

export interface BrowserRuntime {
  /** Navigate and wait for the document to be usable. */
  goto(url: string, timeoutMs?: number): Promise<void>;
  /** One structural observation. Mints a fresh page state id. */
  observe(options?: ObserveOptions): Promise<Observation>;
  /** Perform one action. Never throws for expected failures — see ActionResult. */
  act(request: ActionRequest): Promise<ActionResult>;
  /** PNG bytes. Used for verification, not as the primary observation. */
  screenshot(): Promise<Buffer>;
  /** The most recent observation, or null if the page has navigated since. */
  readonly lastObservation: Observation | null;
  /**
   * A second tab in the same browser with its own session, so pages can be
   * read in parallel; with `window`, in a window of its own so it never sits
   * behind another tab. Optional: a runtime that cannot do this simply does
   * not offer it, and the fan-out falls back to reading one page at a time.
   */
  openTab?(opts?: { window?: boolean; owner?: Owner }): Promise<Tab>;
  /** The work this page's tabs belong to, when the browser keeps a ledger. */
  readonly owner?: Owner | null;
  /** Show "Fanfold is working here" (or waiting, or paused) in the page, or take it down with null. */
  indicate?(state: IndicatorState | null): Promise<void>;
  /** Bring this page in front of the person, without changing it. */
  focus?(): Promise<void>;
  /** Close the tabs this page's own pages opened and come back to its first tab. Returns how many closed. */
  closeOpened?(): Promise<number>;
  /**
   * Leave the tab as it is, kept for the person until `keep.until`, and go on
   * in a new tab of the same work. False when there is no tab to leave.
   */
  leaveTab?(keep: { until: Date; why: string }): Promise<boolean>;
  /**
   * Report what a person does on this page until the returned function is
   * called. For teaching a flow by showing it.
   */
  record?(onEvent: (event: RecordedEvent) => void): Promise<() => Promise<void>>;
  /** Whether the browser is still drawing this page; see frames.ts. */
  drawing?(): Promise<FrameState>;
  /** How the site answered the main document loaded at or after `since` (ms since the epoch). */
  documentResponse?(since?: number): DocumentResponse | null;
  /** Which load of its tab this page is on: it changes with every document the tab loads. */
  readonly loadId?: string;
  /** What the page itself says about the job it shows (page-title.ts reads it). Read-only; untrusted page text. */
  jobPosting?(): Promise<PageJobData>;
}

/** A posting page's own job data: its JSON-LD blocks as written, its main heading, its site's name and its title. */
export interface PageJobData {
  ld: string[];
  heading: string | null;
  siteName: string | null;
  title: string;
}
