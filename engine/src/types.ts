/**
 * Core types for the browser agent.
 *
 * Two invariants are encoded here rather than left to convention, because a
 * slip in either is a correctness bug, not a style one:
 *
 *  1. Element refs are LEASES, not handles. A ref is only meaningful together
 *     with the `pageStateId` of the observation that produced it. Acting with a
 *     stale state id must fail locally, before a click can land on the wrong
 *     element. See CONVERGENCE.md §2.3.
 *
 *  2. Page-derived text is UNTRUSTED. It is branded so it cannot be spliced
 *     into a model prompt by accident; it has to pass through `fence()` in
 *     src/policy/untrusted.ts. See CONVERGENCE.md §2.1.
 */

/** Opaque id for one observation of one document. Refs are scoped to it. */
export type PageStateId = string & { readonly __brand: 'PageStateId' };

/** An element reference, e.g. "e12". Only valid within its PageStateId. */
export type Ref = string & { readonly __brand: 'Ref' };

/** Text that originated from a web page. Never interpolate directly. */
export type Untrusted = string & { readonly __brand: 'Untrusted' };

export type Role = string;

/**
 * What a control structurally DOES, as opposed to what it is called.
 *
 * The policy engine cannot classify an action from an accessible name: a
 * button reading "Submit" might run a search or send a message, and an
 * unnamed icon button says nothing at all. These facts are the difference
 * between a query and a write, and only the page can supply them.
 */
export interface ActionEvidence {
  /** Raw href, truncated. */
  href?: string;
  scheme?: string;
  destOrigin?: string;
  sameOrigin?: boolean;
  /** href is "#", empty, or javascript: — a scripted handler, not a navigation. */
  scripted?: boolean;
  inputType?: string;
  isSubmit?: boolean;
  inForm?: boolean;
  formMethod?: string;
  formActionOrigin?: string;
  formSameOrigin?: boolean;
  formLabel?: string;
  /** This element is document.activeElement right now. */
  focused?: boolean;
  /** Sits inside a rich-text or textarea composer. */
  inEditable?: boolean;
  editable?: boolean;
  /** What kind of input the control takes. Absent for buttons, links and the like. */
  control?: 'text' | 'select' | 'checkbox' | 'radio' | 'file';
  /** Which form of its document the control belongs to, so two forms posting alike are told apart. */
  formIndex?: number;
  /** For a radio button, checkbox or file input, the question its group asks. Untrusted. */
  group?: string;
  /** The group's question is marked required. */
  groupRequired?: boolean;
  /** Carries aria-expanded — a disclosure, not a write. */
  disclosure?: boolean;
  opensMenu?: boolean;
}

export interface ObservedNode {
  ref: Ref | null;
  role: Role;
  /** Computed accessible name. Untrusted — authored by the page. */
  name: Untrusted | null;
  /** Current value for inputs. Untrusted. */
  value: Untrusted | null;
  /** Visible text for content nodes. Untrusted. */
  text: Untrusted | null;
  depth: number;
  state: NodeState;
  /** Present for actuating controls. Consumed by the policy engine. */
  evidence?: ActionEvidence;
  /** A native dropdown's choices, in order. Untrusted. */
  options?: Untrusted[];
}

export interface NodeState {
  disabled?: boolean;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  /** A toggle button's aria-pressed: an answer chosen among Yes/No buttons. */
  pressed?: boolean;
  /** The message the form shows against this field. Untrusted. */
  error?: string;
  selected?: boolean;
  required?: boolean;
  invalid?: boolean;
  level?: number;
  /** True when the node is inside an iframe or shadow root we descended into. */
  nested?: boolean;
  /** Which frame it came from. 'nested' alone cannot tell two frames apart. */
  frame?: string;
  /** The job a result card or job link is about, as the site numbers it. */
  job?: string;
}

export interface Observation {
  /** The document had not finished loading when observed: what follows may still change. */
  loading?: boolean;
  pageStateId: PageStateId;
  url: string;
  title: Untrusted;
  /** Flat, depth-annotated node list. Rendered to text by renderObservation(). */
  nodes: ObservedNode[];
  /** How long the in-page walk took, ms. Budget: < 150ms. */
  walkMs: number;
  /** Total round-trip including CDP, ms. */
  totalMs: number;
  truncated: boolean;
  /**
   * Where a short view stops and what it borrowed from the whole page begins.
   * Depths do not carry across it: nothing before contains anything after.
   */
  seam?: number;
  /** Which budget ran out, so a caller can narrow the right thing. */
  truncationReason?: string | null;
  /** Same-origin frames descended into. */
  frames?: number;
  /**
   * A JavaScript dialog that opened since the last observation, and what was
   * answered. Present only when one actually appeared.
   */
  dialog?: DialogEvent | null;
  /**
   * Other open tabs, when there is more than one.
   *
   * Included because a click on `target="_blank"` reports success and leaves
   * the page looking untouched: the result is in a tab nobody mentioned. A
   * model that cannot see the new tab concludes the click did nothing and
   * clicks again, opening another.
   */
  tabs?: TabInfo[];
  /**
   * Files the page downloaded since the last observation.
   *
   * Without this a download is the quietest kind of success: the click works,
   * the page does not change, and the file the user asked for is on disk with
   * nobody aware of it.
   */
  downloads?: DownloadEvent[];
}

export interface DownloadEvent {
  /** Filename the page suggested. Page-authored, so untrusted. */
  suggestedFilename: Untrusted;
  url: string;
  /** Where it was actually written, once it finished. */
  path?: string;
  state: 'started' | 'completed' | 'canceled';
  at: string;
}

export interface TabInfo {
  id: string;
  url: string;
  /** Page-authored. Untrusted, like any other page text. */
  title: Untrusted;
  /** True for the tab this observation came from. */
  current: boolean;
  /** Appeared since the previous observation. */
  opened?: boolean;
}

/**
 * A native `alert` / `confirm` / `prompt` / `beforeunload`, and the answer
 * given to it.
 *
 * These have to be answered by whoever is driving the browser: while one is
 * open the page is blocked, and a driver that never answers hangs the tab.
 * The answer is a decision with consequences, so it is reported rather than
 * hidden — a dismissed confirm means whatever the page was asking about did
 * NOT happen.
 */
export interface DialogEvent {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** The page's own words. Untrusted, like any other page text. */
  message: Untrusted;
  answer: 'accepted' | 'dismissed';
  at: string;
}

export type ActionKind =
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'hover'
  | 'scroll'
  | 'goto'
  /** Move attention to another open tab. `value` is its TabInfo.id. */
  | 'switchTab'
  /** Attach files to a file input. See `files`. */
  | 'upload';

export interface ActionRequest {
  kind: ActionKind;
  /** Required for element-targeted actions. */
  ref?: Ref;
  /** Lease: the observation this ref came from. */
  pageStateId?: PageStateId;
  value?: string;
  key?: string;
  url?: string;
  /** Pixels, for scroll. */
  amount?: number;
  /**
   * Absolute filesystem paths, for `upload`.
   *
   * Separate from `value` so it can never be filled in from a model's free
   * text: the loop resolves a document the user imported into a path, and
   * nothing else can reach this field.
   */
  files?: string[];
}

export type Sensitivity =
  | 'READ'
  | 'WRITE_SELF'
  /** Actuating, and nothing establishes it is safe. Fails closed. */
  | 'AMBIGUOUS_WRITE'
  | 'CONTACT_EXTERNAL'
  | 'IRREVERSIBLE';

export type ActionFailure =
  | 'STALE_STATE'      // pageStateId no longer current — page navigated or re-observed
  | 'UNKNOWN_REF'      // ref not in the current observation's map
  | 'TARGET_DRIFT'     // element still exists but its role/name changed since observation
  | 'NOT_ACTIONABLE'   // detached, hidden, disabled, or zero-size
  | 'NAVIGATION_LOST'  // document replaced mid-action
  /**
   * The TAB went away — its CDP session no longer exists — while the browser
   * and the transport are fine. A renderer crash, a target discarded under
   * memory pressure, a tab closed by script. Distinct from NAVIGATION_LOST
   * because no document navigated, and from TRANSPORT_LOST because nothing
   * needs relaunching: the page re-attaches to a live tab on its next
   * observation. Potentially dispatched, like both of those.
   */
  | 'TAB_LOST'
  | 'TIMEOUT'          // the page did not respond in time — a page problem
  | 'CDP_ERROR'        // the protocol refused the command — usually our bug
  /**
   * The browser or its transport went away.
   *
   * Distinct from CDP_ERROR because everything downstream needs to tell them
   * apart: the resilient runtime reconnects on this and not on the others,
   * and a test report that files a protocol error as a lost browser waves a
   * real defect away as environment trouble.
   */
  | 'TRANSPORT_LOST';

export interface ActionResult {
  ok: boolean;
  failure?: ActionFailure;
  detail?: string;
  /** True when the action caused a document-level navigation. */
  navigated: boolean;
  ms: number;
}
