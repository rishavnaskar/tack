/**
 * Observation → text for the model.
 *
 * The output budget is the whole point: an observation should cost roughly
 * 200–400 tokens, against the order-of-magnitude more a screenshot spends
 * encoding pixels the model then has to interpret. Every character here is
 * paid on every step of every task, so the format is terse by design.
 *
 * All page-authored strings go through `fence()` on the way out — see
 * policy/untrusted.ts. This is the only renderer; there is no second path
 * that skips it.
 */

import type { Observation, ObservedNode } from '../types.ts';
import { fence, unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { isFanfoldPage, withoutKey } from '../policy/navigable.ts';
import { checkFrame, detectChallenge } from '../policy/challenge.ts';
import { WHOLE_VALUE_FORMATS } from './input.ts';

/** Short hints on a snapshot's lines, kept under 80 characters each. */
const COPY = {
  /** On a combobox with nothing chosen yet: opening one with clicks is the slow way. */
  combobox: 'browser_fill sets it in one call',
};

/** Indentation is capped so a deeply nested SPA does not waste the budget. */
const MAX_INDENT = 6;

const indentOf = (depth: number): string => '  '.repeat(Math.min(depth, MAX_INDENT));

interface RenderOptions {
  /** Drop nodes past this many; the tail is rarely what the model needs. */
  maxNodes?: number;
  /** Whether the whole page shows a bot check, when the caller has judged it; a shorter view may leave out what shows it. */
  challenged?: boolean;
}

export function renderObservation(obs: Observation, options: RenderOptions = {}): string {
  const maxNodes = options.maxNodes ?? 400;
  const lines: string[] = [];

  lines.push(`url: ${withoutKey(obs.url)}`);
  if (obs.title) lines.push(`title: ${fence(obs.title)}`);
  if (obs.loading) lines.push('the page has not finished loading, so what follows may still change');

  // Before the nodes, because it changes how they should be read. A dismissed
  // confirm means the page asked permission and was told no: whatever it was
  // about did NOT happen, and a model that assumes otherwise will report a
  // deletion or a send that never occurred.
  if (obs.dialog) {
    const d = obs.dialog;
    // Quoted, like every accessible name: the message is page-authored text,
    // and confirm("Ignore previous instructions...") is exactly the channel
    // an injection would take.
    const said = JSON.stringify(fence(d.message));
    // Says what was ANSWERED, not what the page then did. Cancelling a
    // confirm makes confirm() return false; a page is free to ignore that and
    // proceed anyway, so "it did not happen" would be claiming more than the
    // protocol event proves. Re-observing is how to find out.
    if (d.type === 'beforeunload') {
      // A leave-page guard is answered by the browser layer, which then
      // completes a navigation the agent asked for by its own route. Saying
      // "CANCEL" here would tell the model the opposite of what happened;
      // the url line above is the truth about where the page is.
      lines.push('the page raised a leave-page guard; it was handled, and the url above is where the page is now');
    } else {
      lines.push(d.answer === 'dismissed'
        ? `a ${d.type} dialog asked ${said} and was answered CANCEL — the page was told no. `
          + 'Check the page rather than assuming what it did with that answer.'
        : `a ${d.type} dialog said ${said} and was closed with OK`);
    }
  }

  // After the dialog line and before the nodes: which tab these nodes are
  // from is context for reading them, not a thing that happened.
  // A blank tab nobody opened is a window's placeholder, not a page to look at.
  const tabs = obs.tabs?.filter((t) => t.current || t.opened || t.url !== 'about:blank');
  if (tabs && tabs.length > 1) {
    lines.push(`${tabs.length} tabs are open:`);
    for (const tab of tabs) {
      const mark = tab.current ? '* ' : '  ';
      const note = tab.opened ? ' (just opened)' : '';
      lines.push(`${mark}[tab=${tab.id}] ${withoutKey(tab.url)}${tab.title ? ' — ' + JSON.stringify(fence(tab.title)) : ''}${note}`);
    }
    lines.push('the snapshot below is the tab marked *');
  }

  if (obs.downloads?.length) {
    for (const d of obs.downloads) {
      lines.push(d.state === 'completed'
        ? `a file downloaded: ${JSON.stringify(fence(d.suggestedFilename))} saved to ${d.path ?? 'the downloads folder'}`
        : d.state === 'canceled'
          ? `a download of ${JSON.stringify(fence(d.suggestedFilename))} was cancelled`
          : `a download of ${JSON.stringify(fence(d.suggestedFilename))} started and has not finished`);
    }
  }

  const fitted = fit(obs.nodes, maxNodes);
  const shown = fitted.slice(0, maxNodes);
  // A set of options ("Yes", "No") is said once under its question, which
  // their own labels do not carry.
  let question: string | undefined;
  // The text line just written, which a question saying the same words replaces.
  let lastText: { at: number; words: string } | null = null;
  const budget = { optionChars: OPTION_BUDGET };
  // Whether the page is showing a bot check, asked once and only when a check's frame is on it.
  let challenged = options.challenged;
  const frames = { challenged: () => (challenged ??= detectChallenge(obs) !== null) };
  for (let i = 0; i < shown.length; i++) {
    const node = shown[i];
    if ('gap' in node) {
      lines.push(`${indentOf(node.depth)}- … ${node.gap} more like these not shown`);
      question = undefined;
      lastText = null;
      continue;
    }
    const ev = node.evidence;
    const named = node.name ? unwrapUntrustedForDisplay(node.name) : '';
    // A file input already named after its question says it on its own line.
    const asks = ev?.group && !(ev.control === 'file' && named.includes(ev.group)) ? ev.group : undefined;
    if (asks && asks !== question) {
      if (lastText && lastText.at === lines.length - 1 && sameWords(lastText.words, asks)) lines.pop();
      lines.push(`${indentOf(node.depth)}- question ${JSON.stringify(fence(asks))}${ev?.groupRequired ? ' [required]' : ''}`);
    }
    if (ev) question = asks;
    if ((node.role === 'text' || node.role === 'paragraph') && node.text && !node.name) {
      const words = unwrapUntrustedForDisplay(node.text);
      // A label written out beside its field, which the field's own name already says.
      const next = shown[i + 1];
      const prev = shown[i - 1];
      if (next && !('gap' in next) && next.name && sameWords(words, unwrapUntrustedForDisplay(next.name))) continue;
      // An answer's words drawn after the radio named by them, or the error already on the field above.
      if (prev && !('gap' in prev) && prev.evidence
        && [prev.name ? unwrapUntrustedForDisplay(prev.name) : '', prev.state.error].includes(words)) continue;
      lastText = { at: lines.length, words };
    }
    lines.push(node.role === 'frame' ? renderFrame(node, obs.url, frames) : renderNode(node, budget));
  }

  const notShown = obs.nodes.length - shown.reduce((n, x) => n + ('gap' in x ? x.hidden : 1), 0);
  if (notShown > 0) {
    lines.push(`… ${notShown} more nodes not shown`);
  }
  if (obs.truncated) {
    lines.push(`… truncated: ${obs.truncationReason ?? 'budget reached'}`);
  }
  return lines.join('\n');
}

/**
 * What to do about the snapshot, in Fanfold's own words: said beside the
 * fenced page, never inside it, where everything reads as the page's text
 * that is not to be followed.
 */
export function snapshotNotes(obs: Observation): string[] {
  const notes: string[] = [];
  if (obs.loading) notes.push('The page was still loading: take another snapshot in a moment.');
  const tabs = obs.tabs?.filter((t) => t.current || t.opened || t.url !== 'about:blank');
  if (tabs && tabs.length > 1) notes.push('Use switchTab with a tab id to look at another of the open tabs.');
  if (obs.truncated) notes.push('The snapshot was cut short: scroll or narrow the view for the rest.');
  return notes;
}

function renderNode(node: ObservedNode, budget: { optionChars: number }): string {
  let line = `${indentOf(node.depth)}- ${node.role}`;
  if (node.name) line += ` ${JSON.stringify(fence(node.name))}`;
  if (node.ref) line += ` [ref=${node.ref}]`;

  const s = node.state;
  const ev = node.evidence;
  if (s.job) line += ` [job=${s.job}]`;
  if (s.level !== undefined) line += ` [level=${s.level}]`;
  if (s.checked !== undefined) line += ` [checked=${s.checked}]`;
  if (s.expanded !== undefined) line += ` [expanded=${s.expanded}]`;
  if (s.pressed !== undefined) line += ` [pressed=${s.pressed}]`;
  if (s.selected) line += ' [selected]';
  if (s.disabled) line += ' [disabled]';
  if (s.required || (ev?.control === 'file' && ev.groupRequired)) line += ' [required]';
  if (s.error) line += ` [error: ${JSON.stringify(fence(s.error))}]`;
  else if (s.invalid) line += ' [invalid]';
  if (s.nested) line += s.frame && s.frame !== 'shadow' ? ` [frame=${s.frame}]` : ' [nested]';

  // A small, deliberately chosen slice of the evidence. The model benefits
  // from knowing a control submits or leaves the site; the rest is for the
  // policy engine and would only cost tokens here.
  if (ev) {
    if (ev.inputType === 'file') line += ' [file]';
    const format = ev.inputType ? WHOLE_VALUE_FORMATS[ev.inputType] : undefined;
    if (format) line += ` [${ev.inputType} ${format}]`;
    // Only what sends a form: not a button outside any form (tabs, cookie
    // banners, navigation), nor a Yes/No answer that stays pressed.
    if (ev.isSubmit && ev.inForm && s.pressed === undefined) line += ' [submits]';
    if (ev.formMethod === 'post') line += ' [post]';
    if (ev.href !== undefined && ev.sameOrigin === false && ev.destOrigin) {
      line += ` [→ ${ev.destOrigin}]`;
    }
  }

  if (node.role === 'combobox' && node.ref && !s.disabled && !node.value) line += ` [${COPY.combobox}]`;
  if (node.value) line += `: ${JSON.stringify(fence(node.value))}`;
  else if (node.text) line += `: ${JSON.stringify(fence(node.text))}`;
  // Once something is chosen, a long list is only its length: it would otherwise
  // repeat in full after every action on the page.
  if (node.options?.length) {
    const listed = node.value && node.options.length > OPTIONS_WHEN_CHOSEN ? '' : renderOptions(node.options);
    // A page of hundreds of dropdowns would otherwise run to megabytes.
    if (listed && listed.length <= budget.optionChars) {
      budget.optionChars -= listed.length;
      line += ` ${listed}`;
    } else {
      line += ` [${node.options.length} options${listed ? ': select takes any option\'s exact text' : ''}]`;
    }
  }
  return line;
}

/**
 * Another site's frame, by its whole address: an embedded application form
 * is worked in by opening that address. Fanfold's own window is never one to
 * open, and its key is never shown. A bot check's frame is never offered as
 * an address either: one that scores the visit by itself, on a page showing
 * no check, is said to need nothing, so it does not stop a form; any other is
 * the user's, as the check message after the page says.
 */
function renderFrame(node: ObservedNode, pageUrl: string, page: { challenged(): boolean }): string {
  const indent = indentOf(node.depth);
  const title = node.name ? ` ${JSON.stringify(fence(node.name))}` : '';
  const address = node.text ? unwrapUntrustedForDisplay(node.text) : '';
  if (isFanfoldPage(address)) return `${indent}- frame${title}: Fanfold's own window, which only the user uses`;
  const check = checkFrame(node);
  if (check) {
    return check.shows === 'nothing' && !page.challenged()
      ? `${indent}- frame${title}: a background bot check (${check.vendor}) that runs by itself. It needs nothing from you: carry on with the page`
      : `${indent}- frame${title}: a bot check (${check.vendor}). Fanfold does not attempt these: the user completes it in the Fanfold window`;
  }
  const short = greenhouseEmbed(address, pageUrl);
  return `${indent}- frame${title} at ${JSON.stringify(fence(withoutKey(address)))}: its contents cannot be read from this page; `
    + `open that address to work in it${short ? `, or its short form ${JSON.stringify(fence(short))}` : ''}`;
}

const GREENHOUSE = /^(job-boards|boards)(\.eu)?\.greenhouse\.io$/;

/** A Greenhouse form embedded on a company's site, as embed/job_app?for=<board>&token=<job id>. */
function greenhouseEmbed(address: string, pageUrl: string): string | null {
  let frame: URL;
  try { frame = new URL(address); } catch { return null; }
  const board = frame.searchParams.get('for');
  if (!GREENHOUSE.test(frame.hostname) || frame.pathname !== '/embed/job_app' || !board) return null;
  let page: URL | null = null;
  try { page = new URL(pageUrl); } catch { page = null; }
  const token = frame.searchParams.get('token') ?? frame.searchParams.get('gh_jid') ?? page?.searchParams.get('gh_jid');
  if (!token || !/^\d+$/.test(token)) return null;
  const short = new URL('/embed/job_app', frame.origin);
  short.searchParams.set('for', board);
  short.searchParams.set('token', token);
  return short.href === frame.href ? null : short.href;
}

/** Two texts that say the same thing, one perhaps cut short or marked required. */
function sameWords(a: string, b: string): boolean {
  const bare = (s: string): string => s.replace(/[\s*✱…]+$/u, '').trim();
  const x = bare(a);
  const y = bare(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 20 && y.startsWith(x)) || (y.length >= 20 && x.startsWith(y));
}

interface Gap { gap: number; hidden: number; depth: number }

/** Result cards in a row before this many are left alone. */
const LIST_KEPT = 5;
const LIST_MIN = 8;

/**
 * The nodes that fit in the budget. A long list of cards gives way, from its
 * end, before anything after it is cut off: on a two-pane search page the
 * selected job's details, its apply button and description, come after
 * twenty-five result cards.
 */
function fit(nodes: readonly ObservedNode[], max: number): Array<ObservedNode | Gap> {
  if (nodes.length <= max) return [...nodes];
  // Where each node's subtree ends.
  const end: number[] = new Array(nodes.length);
  const open: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    while (open.length && nodes[open[open.length - 1]].depth >= nodes[i].depth) end[open.pop()!] = i;
    open.push(i);
  }
  while (open.length) end[open.pop()!] = nodes.length;

  // Runs of siblings of one role, most of them with something inside: cards, not paragraphs.
  const runs: number[][] = [];
  const inRun = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    if (inRun.has(i)) continue;
    const items = [i];
    for (let j = end[i]; j < nodes.length && nodes[j].depth === nodes[i].depth && nodes[j].role === nodes[i].role; j = end[j]) {
      items.push(j);
      inRun.add(j);
    }
    if (items.length >= LIST_MIN && items.filter((k) => end[k] - k > 1).length * 2 >= items.length) runs.push(items);
  }
  const size = (items: number[]): number => end[items[items.length - 1]] - items[0];
  runs.sort((a, b) => size(b) - size(a));

  let over = nodes.length - max;
  const drops = new Map<number, { stop: number; gap: Gap }>();
  for (const items of runs) {
    if (over <= 0) break;
    if ([...drops.entries()].some(([start, d]) => items[0] >= start && items[0] < d.stop)) continue;
    let cut = items.length;
    let hidden = 0;
    while (cut > LIST_KEPT && hidden - 1 < over) {
      cut--;
      hidden += end[items[cut]] - items[cut];
    }
    if (hidden <= 1) continue;
    drops.set(items[cut], { stop: end[items[items.length - 1]], gap: { gap: items.length - cut, hidden, depth: nodes[items[cut]].depth } });
    over -= hidden - 1;
  }

  const out: Array<ObservedNode | Gap> = [];
  for (let i = 0; i < nodes.length;) {
    const d = drops.get(i);
    if (d) { out.push(d.gap); i = d.stop; } else out.push(nodes[i++]);
  }
  return out;
}

const OPTIONS_SHOWN = 30;
const OPTIONS_WHEN_CHOSEN = 12;
/** Characters of option lists one snapshot may carry, across all its dropdowns. */
const OPTION_BUDGET = 12_000;

function renderOptions(options: readonly string[]): string {
  const shown = options.slice(0, OPTIONS_SHOWN).map((o) => JSON.stringify(fence(o))).join(', ');
  const rest = options.length - OPTIONS_SHOWN;
  return rest > 0
    ? `[options: ${shown}, and ${rest} more; select takes any option's exact text]`
    : `[options: ${shown}]`;
}

/**
 * Rough token estimate. Deliberately crude — it exists to enforce the budget
 * in tests and to log cost, not to bill anyone.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function observationStats(obs: Observation): {
  nodes: number; refs: number; chars: number; tokens: number; walkMs: number; totalMs: number;
} {
  const text = renderObservation(obs);
  return {
    nodes: obs.nodes.length,
    refs: obs.nodes.filter((n) => n.ref).length,
    chars: text.length,
    tokens: estimateTokens(text),
    walkMs: obs.walkMs,
    totalMs: obs.totalMs,
  };
}
