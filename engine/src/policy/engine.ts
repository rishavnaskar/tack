/**
 * The policy engine.
 *
 * Runs OUTSIDE the model, on every action, before it reaches the browser.
 *
 * It classifies FAIL-CLOSED. Looking for outbound vocabulary in the
 * accessible name and otherwise allowing misses what most of the web looks
 * like: a button named "Submit", an unnamed icon button, and Enter in a text
 * field would all read as harmless and go straight through, and a run would
 * click a generic Submit with no approval and report success.
 *
 * So the burden of proof is inverted. An actuating control is allowed without
 * approval only when something structural establishes it is a read, a
 * navigation, or a change confined to this page. Otherwise it needs a person,
 * or a capability grant narrow enough that someone was willing to give it in
 * advance. A name is evidence when it is there; it is never the only evidence,
 * and its absence is not reassurance.
 */

import { CHALLENGE_REFUSAL, isChallengeControl } from './challenge.ts';
import { humanOnly } from './human-only.ts';
import { fanfoldWindow, isFanfoldPage } from './navigable.ts';
import type { AgentAction } from '../agent/prompt.ts';
import type { ObservedNode, Observation, ActionEvidence, Sensitivity } from '../types.ts';
import { fence, unwrapUntrustedForDisplay } from './untrusted.ts';
import { ancestors, nameOf, sameForm, seamAfter } from './structure.ts';
import type { Capabilities, Capability } from './capabilities.ts';
import { TERMS_LOCKED, type SitePolicies } from '../jobs/site-policies.ts';

export type Decision =
  | { allow: true; sensitivity: Sensitivity; why: string; capability?: Capability }
  | { allow: false; sensitivity: Sensitivity; requiresApproval: boolean; why: string;
      /** The site's terms make this the user's click: fill, then hand over. Not a grant question. */
      prepare?: boolean;
      /** The run's own hold (PolicyContext.review) stopped it, not the gate: nothing that stands in for the person lifts it. */
      ownHold?: boolean };

/** Controls that submit a job application, on any site. */
const APPLY_NAME = /\b(submit application|submit your application|apply now|easy apply|apply|submit)\b/i;

/**
 * Buttons that begin an application rather than send one, by their whole
 * name: "Apply", "Apply now", "Easy Apply to …", "Apply on company website".
 * On a site known to open a form they open or scroll to it; nothing reaches
 * anyone until the form's own last button. "Apply to all 25 jobs" is not one.
 */
const START_NAME = new RegExp('^(easy apply( to .+)?'
  + '|apply( now| today| here| online| manually)?'
  + '|apply (for|to) (this|the) (job|role|position|opening|vacancy)'
  + '|apply( to .+)? on (the )?(company|employer)[\'’]?s? (website|site)'
  + '|apply with (linkedin|indeed)'
  + '|start (my |your |an )?application)$', 'i');

/**
 * A job in LinkedIn's results list. Its name ends with the site's own "Easy Apply" badge,
 * but clicking it only shows the job: it is not an Apply button.
 *
 * The name is partly the employer's words, and a button named "Follow <company>" ends
 * the same way once the company calls itself "Acme · Easy Apply". So the card is known
 * by its shape as well: a button outside any form or dialog, on a list page, holding
 * its own "Dismiss <title> job" button.
 */
const LISTED_JOB = /\S.{12,}\s·\sEasy Apply$/i;
const LISTING_PATH = /^\/jobs\/(search|search-results|collections)(\/|$)/;
const DISMISS_JOB = /^Dismiss \S.* job$/i;
function isListedJob(action: AgentAction, node: ObservedNode, obs: Observation): boolean {
  const ev = node.evidence ?? {};
  const name = nameOf(node);
  if (action.kind !== 'click' || node.role !== 'button' || ev.inForm || ev.isSubmit) return false;
  if (!LISTED_JOB.test(name)) return false;
  // Employers and people write most of the name: one that reaches someone or cannot be undone is that, badge or not.
  const words = name.replace(/\s·\sEasy Apply$/i, '');
  if (ledByVerb(name) || IRREVERSIBLE_NAME.test(words) || OUTBOUND_NAME.test(words)) return false;
  try {
    if (!LISTING_PATH.test(new URL(obs.url).pathname)) return false;
  } catch {
    return false;
  }
  if (ancestors(obs, node).some((n) => n.role === 'dialog' || n.role === 'alertdialog')) return false;
  // Inside it: read off the depths, stopping where a short view was joined to the whole page.
  const at = obs.nodes.indexOf(node);
  const end = seamAfter(obs, at);
  for (let i = at + 1; i < end && obs.nodes[i].depth > node.depth && obs.nodes[i].depth <= obs.nodes[i - 1].depth + 1; i++) {
    const inner = obs.nodes[i];
    if (inner.role === 'button' && DISMISS_JOB.test(nameOf(inner))) return true;
  }
  return false;
}

/** Sites where "Apply" sends the saved profile in one click, with no form in between. */
const ONE_CLICK_APPLY: ReadonlySet<string> = new Set(['naukri']);

/** Sentences a person reads on an approval card. */
const COPY = {
  /** An Apply button on a posting off the catalog, with nothing of the application on the page yet. */
  startsOffCatalog: 'opens this job\'s application, or on some sites sends it at once: this is not a site known to open a form first',
} as const;

/**
 * Whether a card's reason is an Apply button that, as far as the page showed,
 * only begins an application: on a posting off the catalog, with no form of
 * the application on the page yet. The person's standing yes to their own
 * applications covers it (jobs/standing-approval.ts).
 */
export function startsApplication(why: string): boolean {
  return why.includes(COPY.startsOffCatalog);
}

/** Words of a box that searches or filters, not a question an application asks. */
const SEARCH_FIELD = /\b(search|find|keywords?|filter)\b/i;

/**
 * A posting with nothing of an application on it yet: no résumé to attach and
 * no field to answer, beyond a search box. An Apply button here can only begin
 * the application, or send a profile the site already holds; it is not the
 * last button of a form whose answers were left unread.
 */
function nothingToApplyWith(obs: Observation | null): boolean {
  if (!obs || looksLikeApplication(obs)) return false;
  return !obs.nodes.some((n) => {
    const ev = n.evidence;
    if (ev?.control !== 'text' && ev?.control !== 'select' && ev?.control !== 'file') return false;
    return n.role !== 'searchbox' && !(ev.inForm && ev.formMethod === 'get') && !SEARCH_FIELD.test(nameOf(n));
  });
}

/** The last button of the application itself, which an opt-in on LinkedIn or Indeed covers. */
const APPLICATION_SUBMIT = /^(submit( your| my)? application|submit|send( my)? application|apply)$/i;

/** The last button of an application, when it is not called "Submit". */
const FINISH_NAME = /\b(finish|complete|send)\b/i;

/** What marks a page as an application form: words for it in its title or address, or the main heading. Matched with accents set aside ("Résumé"). */
const APPLICATION_WORDS = /\b(apply|application|applying|candidate|resume|cv)\b/i;

/** Words with their accents set aside, so "Résumé" reads as "Resume" to a pattern. */
export const unaccented = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '');

/**
 * A button that signs in, or asks for a code or link to sign in with: "Sign
 * in", "Email me a sign-in code", "Send me a code". It is the user's account,
 * not their application, however much the page around it speaks of applying.
 */
const SIGNS_IN = /\b(sign(ing)?[- ]?in|log(ging)?[- ]?in|(e-?mail|send|text) me (a |an |the |my )?((sign|log)[- ]?in |login |one[- ]time |verification |security |access )?(code|link|passcode))\b/i;

/** A page titled or headed as a sign-in, with no résumé to send: its buttons sign in. */
function signInPage(obs: Observation | null): boolean {
  if (!obs || obs.nodes.some((n) => n.evidence?.control === 'file')) return false;
  const heading = obs.nodes.find((n) => n.role === 'heading' && n.state.level === 1);
  return /\b(sign|log)[- ]?in\b/i.test(`${unwrapUntrustedForDisplay(obs.title)} ${heading?.name ? unwrapUntrustedForDisplay(heading.name) : ''}`);
}

/** Names that mean "this sends something to another person". */
const OUTBOUND_NAME =
  /\b(send|reply|post|publish|comment|tweet|share|invite|connect|follow|message|submit application|apply now|easy apply|request|endorse|recommend|(i['’]?m|i am) interested|apply (to|for) (all|every|\d+)|(bulk|quick|one[- ]click|1[- ]click) apply)\b/i;

/**
 * A name that starts with what the control does to someone or something else:
 * "Follow Acme", "Message Jordan", "Invite … to connect", "Delete saved
 * search". Applying is not counted here; LinkedIn marks a selected card "Selected, ".
 */
function ledByVerb(name: string): boolean {
  const lead = name.replace(/^[^\p{L}\p{N}]+/u, '').replace(/^selected,[^\p{L}\p{N}]*/iu, '');
  return [OUTBOUND_NAME, IRREVERSIBLE_NAME].some((re) => {
    const m = re.exec(lead);
    return !!m && m.index === 0 && !APPLY_NAME.test(m[0]);
  });
}

/** Unticking one of these only ever sends less. */
const SENDS_LESS = /\b(follow|subscribe|newsletter|updates|notify|notifications|marketing|emails?|alerts?|texts?|sms|share|contact)\b/i;

/** A tick box worded as the applicant's own statement or answer, sent with the form and shown on its card. */
const STATEMENT = /^\W*(i|i['’]m|i['’]ve|i['’]d|i am|i have|i would|i agree|yes|no|by (checking|ticking|clicking|selecting))\b|\?/i;

const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

const SEVERITY: readonly Sensitivity[] = ['READ', 'WRITE_SELF', 'AMBIGUOUS_WRITE', 'CONTACT_EXTERNAL', 'IRREVERSIBLE'];

/** Names that mean money, or a state change that cannot be walked back. */
const IRREVERSIBLE_NAME =
  /\b(pay|buy|purchase|checkout|place order|confirm order|subscribe|upgrade|delete|remove|deactivate|close account|withdraw|transfer|unfriend|block|report)\b/i;

/**
 * Names that positively indicate reading, filtering, or moving around.
 *
 * This list only ever *lowers* a classification, and only alongside
 * structural evidence — a button named "Search" inside a POST form is still
 * ambiguous, because the name is the page's claim and the method is a fact.
 */
const NAVIGATIONAL_NAME =
  /^(search|find|filter|sort|apply filters?|next|previous|prev|back|forward|more|show more|load more|see more|view|open|expand|collapse|close|dismiss|cancel|clear|reset|refresh|reload|go|page \d+|skip|menu|settings|profile|home|log ?in|sign ?in)$/i;

const ACTUATING_KINDS = new Set(['click', 'press', 'check', 'uncheck', 'select']);

export interface PolicyContext {
  /**
   * Sensitivities that still stop for a person. Empty by default: the agent
   * acts. Classification still runs and is still recorded either way — see
   * gateFromEnv().
   */
  gate?: ReadonlySet<Sensitivity>;
  /** Domains the user has told us are their own, e.g. their mail or calendar. */
  ownDomains?: string[];
  /** Live capability grants. */
  capabilities?: Capabilities;
  /** Which worker is asking, so a grant can be scoped to one. */
  workerId?: string | null;
  /** Identity being acted on, when known, for recipient-scoped grants. */
  recipient?: string | null;
  /** The job-site catalog. On a known site, submitting an application is judged by its terms. */
  sites?: SitePolicies;
  /**
   * Extra checks on anything that reaches another person, set by whoever
   * started the run: a worker's daily total, or its rule that free text waits
   * for the user. Asked before the gate and before any grant, so neither an
   * empty gate nor a broad grant skips it.
   */
  review?: (action: AgentAction, observation: Observation) => ReviewHold | null;
  /** True while the browser being driven is the user's own Chrome, through the extension. */
  viaExtension?: () => boolean;
}

/**
 * Why a page may not be worked through the user's own Chrome, or null.
 *
 * Some sites' terms name browser extensions specifically. Those are worked in
 * Fanfold's own window only, whoever is asking and whatever is granted.
 */
export function extensionRefusal(ctx: PolicyContext, url: string | undefined): string | null {
  if (!ctx.viaExtension?.() || !ctx.sites || !url) return null;
  const site = ctx.sites.forUrl(url);
  if (!site || site.extensionAllowed) return null;
  return `${site.label}'s terms rule out automation from a browser extension, so Fanfold does not work on it inside your Chrome. `
    + 'Switch to the Fanfold window under Browser & sign-ins to use it there.';
}

export interface ReviewHold {
  /** True: not allowed at all. False: allowed once a person approves. */
  refuse: boolean;
  why: string;
}

export function classify(
  action: AgentAction,
  observation: Observation | null,
  ctx: PolicyContext = {},
): Sensitivity {
  return classifyWithReason(action, observation, ctx).sensitivity;
}

export function classifyWithReason(
  action: AgentAction,
  observation: Observation | null,
  ctx: PolicyContext = {},
): { sensitivity: Sensitivity; why: string } {
  // Terminals and pure reads.
  if (action.kind === 'done' || action.kind === 'ask_user') {
    return { sensitivity: 'READ', why: 'ends the run' };
  }

  // Connector actions. Classified here rather than by the connector itself,
  // so the rule is the same one everything else passes through.
  if (action.kind === 'gmail_search' || action.kind === 'calendar_events' || action.kind === 'calendar_free_slots'
    || action.kind === 'linkedin_profile') {
    return { sensitivity: 'READ', why: `${action.kind} reads the user's own account` };
  }
  if (action.kind === 'gmail_draft') {
    // A draft is not a send, and cannot become one: the connector holds the
    // compose scope and has no send method. The capability is the boundary,
    // not this classification.
    return { sensitivity: 'WRITE_SELF', why: 'saves a draft in the user\'s own mailbox; it cannot send' };
  }
  if (action.kind === 'scroll' || action.kind === 'hover') {
    return { sensitivity: 'READ', why: 'does not actuate anything' };
  }
  if (action.kind === 'goto') {
    return { sensitivity: 'READ', why: 'navigation' };
  }
  // Navigations and reads in throwaway tabs. It has no way to actuate.
  if (action.kind === 'fanout') {
    return { sensitivity: 'READ', why: 'opens pages and reads them' };
  }
  // Starts agents of its own. Each of their actions passes this engine itself.
  if (action.kind === 'delegate') {
    return { sensitivity: 'READ', why: 'hands tasks to sub-agents, whose actions are judged one by one' };
  }
  // Looking at a tab that is already open. It actuates nothing; whatever the
  // tab contains still has to pass this engine before anything is done to it.
  if (action.kind === 'switchTab') {
    return { sensitivity: 'READ', why: 'moves attention to an already-open tab' };
  }
  /*
   * Attaching a file is NOT the same as typing into a field, even though both
   * populate a control. A file input can post the moment its value changes —
   * plenty of sites upload a resume on selection with no further click — so
   * there is no structural evidence that the file stays on the machine. It
   * fails closed, like everything else that might leave.
   */
  if (action.kind === 'upload') {
    return {
      sensitivity: 'AMBIGUOUS_WRITE',
      why: 'attaches one of the user\'s documents; a file input can upload as soon as it changes',
    };
  }

  // Typing changes only local state until something actuates.
  if (action.kind === 'fill' || action.kind === 'type') {
    return { sensitivity: 'WRITE_SELF', why: 'edits a field without submitting it' };
  }

  if (!ACTUATING_KINDS.has(action.kind)) {
    return { sensitivity: 'WRITE_SELF', why: `${action.kind} does not actuate` };
  }

  // From here on the action can cause something to happen.
  if (action.kind === 'press') {
    return classifyKeypress(action, observation, ctx);
  }

  const node = action.ref && observation ? findNode(observation, action.ref) : null;
  if (!node) {
    // We cannot see what is being actuated. That is precisely when guessing
    // is worst.
    return {
      sensitivity: 'AMBIGUOUS_WRITE',
      why: 'the target is not in the current observation, so what it does is unknown',
    };
  }

  const name = node.name ? unwrapUntrustedForDisplay(node.name) : '';
  const ev = node.evidence ?? {};
  const own = isOwnDomain(observation?.url, ctx.ownDomains);

  // A disabled control cannot actuate, so asking a person to approve clicking
  // one is a pointless interruption. The browser layer rejects it as
  // NOT_ACTIONABLE a moment later, and the serializer treats a disabled
  // element that becomes enabled between observation and action as drift — so
  // this cannot be used to slip an action past the check.
  if (node.state?.disabled) {
    return { sensitivity: 'WRITE_SELF', why: `${name ? `"${name}"` : `the ${node.role}`} is disabled and cannot actuate` };
  }

  const site = ctx.sites?.forUrl(observation?.url);

  // A tick box is not a submit, so the names of submit buttons say nothing
  // about it. What it is called still can: a switch that deletes an account or
  // shares a profile may act the moment it flips, form or no form. A box
  // worded as the applicant's own statement goes with the form it sits in.
  // A click on one is the tick or untick it makes.
  const tick = tickOf(action, node);
  if (tick) {
    const what = `${tick === 'check' ? 'ticks' : 'unticks'} "${name}"`;
    const sentWithForm = (ev.inForm || !!site || looksLikeApplication(observation)) && STATEMENT.test(name);
    if (!(tick === 'uncheck' && SENDS_LESS.test(name)) && !sentWithForm) {
      if (IRREVERSIBLE_NAME.test(name)) return { sensitivity: 'IRREVERSIBLE', why: `${what}, which reads as something that cannot be undone` };
      if (OUTBOUND_NAME.test(name) && !own) return { sensitivity: 'CONTACT_EXTERNAL', why: `${what}, which reaches someone else` };
    }
    return { sensitivity: 'WRITE_SELF', why: `${what}, which sends nothing by itself` };
  }

  // Something that cannot be undone is judged that first, whatever badge the page added to its name.
  if (name && ledByVerb(name) && IRREVERSIBLE_NAME.test(name)) {
    return { sensitivity: 'IRREVERSIBLE', why: `"${name}" reads as an action that cannot be undone` };
  }

  if (site?.key === 'linkedin' && observation && isListedJob(action, node, observation)) {
    return { sensitivity: 'READ', why: `"${name}" is a job in the results list; clicking it shows the job` };
  }

  // Only a site known to open a form gets the benefit of the doubt for its
  // Apply button: on a board that applies in one click, or one Fanfold does
  // not know, the same button can send the profile at once.
  if (START_NAME.test(name) && !ev.inForm) {
    if (site ? !ONE_CLICK_APPLY.has(site.key) : opensElsewhere(node, observation, ctx.sites)) {
      return { sensitivity: 'WRITE_SELF', why: `"${name}" opens the application form; nothing is sent until the form's own last button` };
    }
    if (!site) {
      return nothingToApplyWith(observation)
        ? { sensitivity: 'CONTACT_EXTERNAL', why: `"${name}" ${COPY.startsOffCatalog}` }
        : { sensitivity: 'CONTACT_EXTERNAL', why: `"${name}" may send an application at once: this is not a site known to open a form first` };
    }
  }

  // Signing in is not applying: such a button is judged as what it is below,
  // so it never goes out as an application, nor is filed as one.
  const signsIn = SIGNS_IN.test(name) || signInPage(observation);

  // On a job site the catalog knows, a control that submits an application
  // is outbound whatever it is called: a bare "Submit" at the end of a
  // Greenhouse form reaches a recruiter exactly as "Submit application" does.
  if (site && !signsIn && (APPLY_NAME.test(name) || (ev.isSubmit && ev.inForm && ev.formMethod !== 'get'))) {
    return { sensitivity: 'CONTACT_EXTERNAL', why: `${name ? `"${name}"` : 'this control'} submits an application on ${site.label}` };
  }

  // Off the catalog an application is recognised by the page itself: one that
  // takes a résumé, or is titled as an application and has fields to fill.
  // Its last button is often a bare "Submit" or "Finish" run by script,
  // outside any form, and it reaches a recruiter all the same.
  if (!own && !signsIn && looksLikeApplication(observation)
    && (APPLY_NAME.test(name) || FINISH_NAME.test(name) || (ev.isSubmit && ev.inForm && ev.formMethod !== 'get'))) {
    return { sensitivity: 'CONTACT_EXTERNAL', why: `${name ? `"${name}"` : 'this control'} submits a job application` };
  }

  // Irreversible is decided on the name, because nothing structural
  // distinguishes "Delete account" from "Save". A false positive here costs
  // one approval; a false negative cannot be undone.
  if (name && IRREVERSIBLE_NAME.test(name)) {
    return { sensitivity: 'IRREVERSIBLE', why: `"${name}" reads as an action that cannot be undone` };
  }

  if (name && OUTBOUND_NAME.test(name)) {
    return own
      ? { sensitivity: 'WRITE_SELF', why: `"${name}" acts within your own ${hostOf(observation?.url)}` }
      : { sensitivity: 'CONTACT_EXTERNAL', why: `"${name}" sends something to someone else` };
  }

  // Positive evidence that this is safe.
  const safe = safetyEvidence(node.role, name, ev, own ? hostOf(observation?.url) || 'site' : null);
  if (safe) return { sensitivity: safe.sensitivity, why: safe.why };

  // Nothing established what this does.
  return {
    sensitivity: 'AMBIGUOUS_WRITE',
    why: describeAmbiguity(node.role, name, ev),
  };
}

/**
 * Establish, positively, that actuating this control is a read or a
 * self-scoped change. Returns null when nothing does.
 */
function safetyEvidence(
  role: string,
  name: string,
  ev: ActionEvidence,
  /** The user's own site this is on, by its host; null when it is not theirs. */
  own: string | null,
): { sensitivity: Sensitivity; why: string } | null {
  // A real link is a GET navigation. Where it goes does not make it a write.
  if (role === 'link' && !ev.scripted && ev.scheme && /^https?$/.test(ev.scheme)) {
    return { sensitivity: 'READ', why: `navigates to ${ev.destOrigin ?? 'another page'}` };
  }

  // A GET form is a query by definition: the browser puts the fields in the
  // URL and fetches a page. That is a search, not a write.
  if (ev.inForm && ev.formMethod === 'get') {
    return { sensitivity: 'WRITE_SELF', why: 'submits a GET form, which is a query rather than a write' };
  }

  // A disclosure toggle opens or closes part of the page.
  if (ev.disclosure) return { sensitivity: 'WRITE_SELF', why: 'expands or collapses a section' };
  if (ev.opensMenu) return { sensitivity: 'WRITE_SELF', why: 'opens a menu' };

  // A control outside any form, with a name that plainly describes moving
  // around or filtering. Both halves are required: the name alone is the
  // page's claim about itself.
  if (!ev.inForm && !ev.isSubmit && name && NAVIGATIONAL_NAME.test(name.trim())) {
    return { sensitivity: 'WRITE_SELF', why: `"${name}" is a navigation or filter control outside any form` };
  }

  // Filter checkboxes and radios that do not submit anything.
  if ((role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'combobox' || role === 'listbox')
      && !ev.isSubmit && ev.formMethod !== 'post') {
    return { sensitivity: 'WRITE_SELF', why: `changes a ${role} without submitting a form` };
  }

  // Tabs and options move between views.
  if (role === 'tab' || role === 'option' || role === 'treeitem') {
    return { sensitivity: 'WRITE_SELF', why: `selects a ${role}` };
  }

  // On the user's own site, a named control that is not outbound and not
  // irreversible is a change to their own data.
  if (own && name) {
    return { sensitivity: 'WRITE_SELF', why: `"${name}" acts within your own account on ${own}` };
  }

  return null;
}

function describeAmbiguity(role: string, name: string, ev: ActionEvidence): string {
  const label = name ? `"${name}"` : `an unnamed ${role}`;
  if (ev.isSubmit && ev.formMethod === 'post') {
    return `${label} submits a POST form, which may send or publish something`;
  }
  if (ev.isSubmit) return `${label} submits a form and nothing establishes what that form does`;
  if (!name) return `${label} gives no indication of what it does`;
  return `${label} actuates something and nothing establishes it is a read or a change to this page only`;
}

/**
 * Enter and Space are how most composers send.
 *
 * Judged on ACTUAL focus, not on whether a composer exists somewhere on the
 * page. Looking for any message-like textbox in the snapshot would treat
 * Enter anywhere on a messaging site as sending, and Enter in an unnamed
 * field as harmless: wrong in opposite directions.
 */
function classifyKeypress(
  action: AgentAction,
  observation: Observation | null,
  ctx: PolicyContext,
): { sensitivity: Sensitivity; why: string } {
  const raw = action.key ?? '';
  const key = keyName(raw);
  if (!pressActivates(raw)) return { sensitivity: 'WRITE_SELF', why: `${key || 'key'} does not submit` };

  // A page that takes applications, including one that embeds a job site's
  // form in a frame Fanfold cannot read into.
  const applying = !!(ctx.sites?.forUrl(observation?.url) || looksLikeApplication(observation) || embedsApplication(observation, ctx.sites));
  const focused = observation?.nodes.find((n) => n.evidence?.focused);
  if (!focused) {
    // Focus inside a frame from another site, or a closed shadow root, is
    // never seen, and a Submit there is pressed by Space all the same.
    return applying
      ? { sensitivity: 'CONTACT_EXTERNAL', why: `${key} goes to whatever has focus, which cannot be seen on this page, and the page takes applications` }
      : { sensitivity: 'AMBIGUOUS_WRITE', why: `${key} with nothing focused could actuate whatever the page has focused` };
  }

  const ev = focused.evidence ?? {};
  const name = nameOf(focused);
  const enter = !/space/i.test(key);
  const field = ev.control === 'text' || ev.control === 'select' || ev.control === 'file' || ev.editable || ev.inEditable
    || focused.role === 'textbox' || focused.role === 'searchbox' || focused.role === 'combobox';
  // Enter or Space on a focused control presses it: judged as that click,
  // which on a tick box is the tick. Enter in a box submits its form instead.
  if (focused.ref && !field && !(isToggle(focused) && enter)) {
    const pressed = classifyWithReason({ kind: 'click', ref: focused.ref, reason: action.reason }, observation, ctx);
    return { sensitivity: pressed.sensitivity, why: `${key} presses it: ${pressed.why}` };
  }

  // Enter in a field submits its form the way its own submit button would,
  // so it is judged as that button: the most outbound of them, when the form
  // cannot be told apart. Otherwise Enter would be a way past every rule the
  // button itself is held to. On a page that takes applications this holds
  // for a form with no method too, which the page reports as GET.
  if (ev.inForm && !ev.editable && (applying || ev.formMethod !== 'get')) {
    const verdicts = (observation?.nodes ?? [])
      .filter((n) => n.ref && n !== focused && n.evidence?.isSubmit && sameForm(n, focused))
      .map((n) => classifyWithReason({ kind: 'click', ref: n.ref!, reason: action.reason }, observation, ctx));
    if (verdicts.length) {
      const pressed = verdicts.reduce((a, b) => (SEVERITY.indexOf(b.sensitivity) > SEVERITY.indexOf(a.sensitivity) ? b : a));
      return { sensitivity: pressed.sensitivity, why: `${key} submits the form: ${pressed.why}` };
    }
    const search = ev.formMethod === 'get' && (focused.role === 'searchbox' || ev.formLabel === '' || /search|find|filter/i.test(ev.formLabel ?? ''));
    if (applying && !search) return { sensitivity: 'CONTACT_EXTERNAL', why: `${key} submits a job application` };
  }

  // A GET search box: Enter runs the query.
  if (ev.inForm && ev.formMethod === 'get') {
    return { sensitivity: 'WRITE_SELF', why: `${key} runs a GET form, which is a query` };
  }
  if (ev.editable || ev.inEditable) {
    return {
      sensitivity: 'AMBIGUOUS_WRITE',
      why: `${key} in a composer${name ? ` ("${name}")` : ''} commonly sends it`,
    };
  }
  if (ev.inForm) {
    return { sensitivity: 'AMBIGUOUS_WRITE', why: `${key} submits the form this field belongs to` };
  }
  if (applying) return { sensitivity: 'AMBIGUOUS_WRITE', why: `${key} on a page that takes applications may be acted on by the page` };
  return { sensitivity: 'WRITE_SELF', why: `${key} in a field that submits nothing` };
}

/** A key as it should be read back: " " is Space and a carriage return is Enter. */
function keyName(key: string): string {
  return key.replace(/ /g, 'Space').replace(/[\r\n]/g, 'Enter').trim();
}

/** Keys that press a focused control or submit a field's form: Enter and Space by any name, or as the character itself. */
export function pressActivates(key: string | undefined): boolean {
  const k = key ?? '';
  const last = k.length > 1 && k.includes('+') ? k.slice(k.lastIndexOf('+') + 1) : k;
  return /^(enter|return|numpadenter|space|spacebar)$/i.test(last.trim()) || (last.length > 0 && /^\s+$/.test(last));
}

export const COOKIE_REFUSAL = 'that accepts cookies for the user, which is theirs to allow. Close the banner with the choice that allows the least '
  + '("Reject all", "Only necessary", "Decline"), or leave it and carry on; if nothing else clears it, ask the user.';

/** "Accept all", "Allow cookies", "OK" on a cookie banner: the choice that allows the most. */
const COOKIE_ACCEPT = /^(?:accept|allow|agree|i agree|i accept|ok|okay|got it|consent)(?:\s+(?:all|everything))?(?:\s+cookies)?(?:\s+(?:and|&)\s+(?:continue|close))?$|\b(?:accept|allow)\s+(?:all\s+)?cookies\b/i;
const COOKIES = /\bcookies?\b/i;

function acceptsCookies(observation: Observation, node: ObservedNode): boolean {
  if (node.role !== 'button' && node.role !== 'link') return false;
  const name = nameOf(node).trim();
  if (!COOKIE_ACCEPT.test(name)) return false;
  if (COOKIES.test(name)) return true;
  const at = observation.nodes.indexOf(node);
  const near = [...ancestors(observation, node), ...observation.nodes.slice(Math.max(0, at - 8), at + 8)];
  return near.some((n) => COOKIES.test(`${nameOf(n)} ${n.text ? unwrapUntrustedForDisplay(n.text) : ''}`));
}

export function decide(
  action: AgentAction,
  observation: Observation | null,
  ctx: PolicyContext = {},
): Decision {
  const { sensitivity, why } = classifyWithReason(action, observation, ctx);

  const endsRun = action.kind === 'done' || action.kind === 'ask_user';
  if (!endsRun && (fanfoldWindow(observation) || (action.kind === 'goto' && isFanfoldPage(action.value)))) {
    return { allow: false, sensitivity, requiresApproval: false, why: 'that is Fanfold\'s own window, which only the person uses' };
  }
  const refusal = endsRun ? null : extensionRefusal(ctx, action.kind === 'goto' ? action.value : observation?.url);
  if (refusal) {
    return { allow: false, sensitivity, requiresApproval: false, why: refusal };
  }

  // A bot check is the site asking for a person. Nothing acts on one,
  // whatever is granted and whoever is asking.
  const target = action.ref && observation ? findNode(observation, action.ref) : null;
  const focused = action.kind === 'press' && pressActivates(action.key) ? observation?.nodes.find((n) => n.evidence?.focused) : undefined;
  if ((target && isChallengeControl(target)) || (focused && isChallengeControl(focused))) {
    return { allow: false, sensitivity, requiresApproval: false, why: CHALLENGE_REFUSAL };
  }
  // Cookies beyond what a site needs are the person's to allow: clearing a banner takes the choice that allows least.
  if (target && observation && acceptsCookies(observation, target)) {
    return { allow: false, sensitivity, requiresApproval: false, why: COOKIE_REFUSAL };
  }

  if (sensitivity === 'READ' || sensitivity === 'WRITE_SELF') {
    return { allow: true, sensitivity, why };
  }

  // A video to record or a test to take is the person's to do, on any site
  // and under any setting: filled and handed over, never sent without it.
  if (sensitivity === 'CONTACT_EXTERNAL' && !tickOf(action, target) && (ctx.sites?.forUrl(observation?.url) || looksLikeApplication(observation))) {
    const submit = action.ref && observation ? target : observation?.nodes.find((n) => n.evidence?.focused);
    const theirs = humanOnly(observation, submit);
    if (theirs) {
      return {
        allow: false, sensitivity, requiresApproval: true, prepare: true,
        why: `this application asks for ${theirs.what} (${JSON.stringify(fence(theirs.evidence))}), which only you can do. `
          + 'Everything else is filled in; do that part and press Submit yourself',
      };
    }
  }

  // Site terms come before the gate and before any grant. On LinkedIn and
  // Indeed the submit is the user's click unless they turned submission on
  // there themselves; no grant or lesson can. The run fills the form, then
  // hands over. Following, connecting and messaging there are not
  // applications: they are refused by name, never handed over as a Submit.
  if (sensitivity === 'CONTACT_EXTERNAL' && ctx.sites && observation?.url) {
    const posture = ctx.sites.submitMode(observation.url);
    const label = posture?.policy.label ?? '';
    const locked = !!posture && TERMS_LOCKED.has(posture.policy.key);
    const submit = action.kind === 'click' && submitsTheApplication(observation, target);
    const applying = submit || action.kind === 'press'
      || (!!target && !tickOf(action, target) && APPLY_NAME.test(nameOf(target)) && !ledByVerb(nameOf(target)));
    if (locked && !applying) {
      return {
        allow: false, sensitivity, requiresApproval: false,
        why: `${doing(action, target)} reaches other people on ${label}, which Fanfold does not do there. It was not done`
          + (posture?.mode === 'auto' ? '. The application\'s own Submit is still clicked as usual and waits for the user\'s approval' : ''),
      };
    }
    if (posture?.mode === 'prepare') {
      return {
        allow: false, sensitivity, requiresApproval: true, prepare: true,
        why: `${label}'s terms prohibit software submitting applications. Everything is filled in; you press Submit.`,
      };
    }
    // Turned on by the person, such a site lets Fanfold submit applications,
    // and only from the application's own last button.
    if (posture?.mode === 'auto' && locked && !submit) {
      return {
        allow: false, sensitivity, requiresApproval: false,
        why: `${doing(action, target)} is not the application's own Submit, the only thing the user turned on for ${label}. It was not done: `
          + 'click the application\'s Submit button, which waits for the user\'s approval',
      };
    }
    if (posture?.mode === 'never') {
      return { allow: false, sensitivity, requiresApproval: false, why: `applying on ${posture.policy.label} is switched off in the site catalog` };
    }
  }

  if ((sensitivity === 'CONTACT_EXTERNAL' || sensitivity === 'IRREVERSIBLE') && ctx.review && observation) {
    const hold = ctx.review(action, observation);
    if (hold) return { allow: false, sensitivity, requiresApproval: !hold.refuse, why: hold.why, ownHold: true };
  }

  // Before grants: spending a grant's limited budget on something that needs
  // no permission would burn it for nothing. What replaces this gate is the
  // prompt, which has the model put anything outbound to the user in chat.
  if (!ctx.gate?.has(sensitivity)) {
    return { allow: true, sensitivity, why: `${why} — ${sensitivity} does not wait for approval here` };
  }

  // A grant can cover it — but only one narrow enough that someone chose to
  // give it in advance for this site, this class of action, and this caller.
  if (ctx.capabilities && observation?.url) {
    const check = ctx.capabilities.check({
      workerId: ctx.workerId ?? null,
      url: observation.url,
      sensitivity,
      actionKind: action.kind,
      recipient: ctx.recipient ?? null,
    });
    if (check.granted) {
      return {
        allow: true, sensitivity, capability: check.capability,
        why: `${why} — covered by the grant "${check.capability.label}"`,
      };
    }
  }

  return { allow: false, sensitivity, requiresApproval: true, why: `${why}. Needs your approval.` };
}

/** Every sensitivity that can be gated. READ and WRITE_SELF never are. */
export const GATEABLE: readonly Sensitivity[] = ['AMBIGUOUS_WRITE', 'CONTACT_EXTERNAL', 'IRREVERSIBLE'];

/** What waits for a person when nothing says otherwise: a submission, or something that cannot be undone. */
export const DEFAULT_GATE: readonly Sensitivity[] = ['CONTACT_EXTERNAL', 'IRREVERSIBLE'];

/**
 * BROWSER_AGENT_APPROVALS: unset is the default gate above, "none" is fully
 * autonomous, "all" gates unclassified writes too, or name sensitivities. An
 * unrecognised name throws, so a typo in a safety setting cannot read as "off".
 *
 * Reading and navigating are never gated: the default stops only what reaches
 * another person or cannot be taken back, which the prompt already tells the
 * model to put to the user first. A worker turned on with autonomy holds a
 * grant that covers it on the sites it was given.
 */
export function gateFromEnv(spec = process.env.BROWSER_AGENT_APPROVALS): ReadonlySet<Sensitivity> {
  const raw = (spec ?? '').trim();
  if (!raw) return new Set(DEFAULT_GATE);
  if (raw.toLowerCase() === 'none') return new Set();
  if (raw.toLowerCase() === 'all') return new Set(GATEABLE);
  const wanted = raw.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  const unknown = wanted.filter((x) => !(GATEABLE as readonly string[]).includes(x));
  if (unknown.length) {
    throw new Error(
      `BROWSER_AGENT_APPROVALS does not understand ${unknown.join(', ')}. ` +
      `Use "none", "all", or a comma-separated list of: ${GATEABLE.join(', ')}.`,
    );
  }
  return new Set(wanted as Sensitivity[]);
}

/** A form that takes a résumé, or a page titled as an application with fields to fill. */
function looksLikeApplication(obs: Observation | null): boolean {
  if (!obs) return false;
  if (obs.nodes.some((n) => n.evidence?.control === 'file')) return true;
  const heading = obs.nodes.find((n) => n.role === 'heading' && n.state.level === 1);
  const said = [obs.url, unwrapUntrustedForDisplay(obs.title), heading?.name ? unwrapUntrustedForDisplay(heading.name) : '']
    .join(' ').replace(/[-_/.]/g, ' ');
  return APPLICATION_WORDS.test(unaccented(said)) && obs.nodes.some((n) => n.evidence?.control === 'text');
}

const isToggle = (node: ObservedNode): boolean =>
  !node.evidence?.isSubmit && (node.evidence?.control === 'checkbox' || node.evidence?.control === 'radio' || TOGGLE_ROLES.has(node.role));

/** What an action does to a tick box, a click included: it ticks an unticked one and unticks a ticked one. */
function tickOf(action: AgentAction, node: ObservedNode | null): 'check' | 'uncheck' | null {
  if (!node || !isToggle(node)) return null;
  if (action.kind === 'check' || action.kind === 'uncheck') return action.kind;
  if (action.kind === 'click') return node.state.checked === true ? 'uncheck' : 'check';
  return null;
}

/** The action in words, for a reason that names what was refused. */
function doing(action: AgentAction, node: ObservedNode | null): string {
  if (action.kind === 'press') return `pressing ${keyName(action.key ?? '')}`;
  const name = nameOf(node ?? undefined);
  const what = name ? `"${name}"` : node ? `the ${node.role}` : 'the page';
  const tick = tickOf(action, node);
  if (tick) return `${tick === 'check' ? 'ticking' : 'unticking'} ${what}`;
  if (action.kind === 'select') return `choosing an option in ${what}`;
  return `clicking ${what}`;
}

/**
 * An Apply that only shows where the application is: it opens a section or a
 * dialog of this page, jumps within it, or links to a site known to open a
 * form first.
 */
function opensElsewhere(node: ObservedNode, obs: Observation | null, sites: SitePolicies | undefined): boolean {
  const ev = node.evidence ?? {};
  if (ev.disclosure || ev.opensMenu) return true;
  if (node.role !== 'link' || ev.scripted || !ev.href || !/^https?$/.test(ev.scheme ?? '')) return false;
  try {
    const dest = new URL(ev.href, obs?.url);
    const here = obs?.url ? new URL(obs.url) : null;
    if (here && dest.origin === here.origin && dest.pathname === here.pathname && dest.search === here.search) return true;
    const site = sites?.forUrl(dest.href);
    return !!site && !ONE_CLICK_APPLY.has(site.key);
  } catch {
    return false;
  }
}

/**
 * The application's own last button, inside the application: LinkedIn's Easy
 * Apply dialog, or a page of the site's apply flow. A Submit in a report,
 * feedback or survey dialog is not one.
 */
function submitsTheApplication(obs: Observation, node: ObservedNode | null): boolean {
  if (!node || !APPLICATION_SUBMIT.test(nameOf(node).trim())) return false;
  const isDialog = (n: ObservedNode): boolean => n.role === 'dialog' || n.role === 'alertdialog';
  const applies = (n: ObservedNode): boolean => /\b(apply|application)\b/i.test(nameOf(n));
  const dialog = ancestors(obs, node).find(isDialog);
  if (dialog) return applies(dialog);
  // A short view merged with the whole page loses the nesting; an open dialog still decides.
  const open = obs.nodes.filter(isDialog);
  if (open.length) return open.every(applies);
  return /apply/i.test(obs.url);
}

/** What a frame from another site on this page is: an embedded application form when it comes from a job site. */
function embedsApplication(obs: Observation | null, sites: SitePolicies | undefined): boolean {
  if (!obs || !sites) return false;
  return obs.nodes.some((n) => n.role === 'frame' && [n.name, n.text].filter(Boolean)
    .some((t) => (unwrapUntrustedForDisplay(t!).match(/https?:\/\/[^\s/:]+/g) ?? []).some((origin) => sites.forUrl(origin))));
}

function findNode(obs: Observation, ref: string): ObservedNode | null {
  const clean = ref.replace(/^@/, '');
  return obs.nodes.find((n) => n.ref === clean) ?? null;
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isOwnDomain(url: string | undefined, ownDomains: string[] | undefined): boolean {
  if (!url || !ownDomains?.length) return false;
  const host = hostOf(url);
  if (!host) return false;
  return ownDomains.some((d) => host === d || host.endsWith(`.${d}`));
}
