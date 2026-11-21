/**
 * Small pure helpers the loop uses to translate between what the model chose
 * and what the browser is asked to do.
 */

import type { AgentAction } from './prompt.ts';
import { CONNECTOR_KINDS, RECORD_KINDS } from './prompt.ts';
import { markUntrusted } from '../policy/untrusted.ts';
import type { ActionRequest, Observation, PageStateId, Ref } from '../types.ts';

/** A collected row's own address, resolved against the page it came from. */
export function rowUrl(href: string | undefined, base: string): string {
  if (!href) return '';
  try {
    const u = new URL(href, base);
    return /^https?:$/.test(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
}

export function toActionRequest(action: AgentAction, pageStateId: PageStateId): ActionRequest {
  return {
    kind: action.kind as ActionRequest['kind'],
    ref: action.ref ? (action.ref.replace(/^@/, '') as Ref) : undefined,
    pageStateId,
    value: action.value || undefined,
    key: action.key || undefined,
    url: action.kind === 'goto' ? action.value : undefined,
    amount: action.amount || undefined,
  };
}

export function describeTarget(obs: Observation, ref: string | undefined): string {
  if (!ref) return obs.url;
  const node = obs.nodes.find((n) => n.ref === ref.replace(/^@/, ''));
  return node ? `${obs.url}#${node.role}:${node.name ?? ref}` : `${obs.url}#${ref}`;
}

export function describeAction(a: AgentAction): string {
  const parts: string[] = [a.kind];
  if (a.ref) parts.push(a.ref);
  if (a.value) parts.push(JSON.stringify(a.value.slice(0, 60)));
  if (a.key) parts.push(a.key);
  if (a.amount) parts.push(String(a.amount));
  return parts.join(' ');
}

export function hostOf(url: string): string {
  try {
    // "www.linkedin.com." is the same site: a trailing dot must not slip past a rule.
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '*';
  }
}

/**
 * Find the same control on a newer observation.
 *
 * Refs are leases, so an action authorised against one observation cannot use
 * its ref against another. The control is re-identified by role and
 * accessible name, and ambiguity resolves to nothing: two matching controls
 * means the page is no longer specific enough to act on safely.
 */
export function relocate(from: Observation, to: Observation, ref: string): Ref | null {
  const original = from.nodes.find((n) => n.ref === ref.replace(/^@/, ''));
  if (!original) return null;
  const matches = to.nodes.filter(
    (n) => n.role === original.role && (n.name ?? null) === (original.name ?? null) && n.ref,
  );
  return matches.length === 1 ? (matches[0].ref as Ref) : null;
}

/**
 * What the model sees before a browser exists.
 *
 * An explicit empty page rather than a missing one, so the prompt shape does
 * not change and the model can tell the difference between "nothing is open"
 * and "this page has nothing on it".
 */
export function noBrowserObservation(): Observation {
  return {
    pageStateId: 'no-browser' as PageStateId,
    url: 'about:blank',
    title: markUntrusted('(no browser open)'),
    nodes: [],
    walkMs: 0,
    totalMs: 0,
    truncated: false,
    truncationReason: null,
    frames: 0,
  };
}

/** Actions that cannot proceed without a page to act on. */
export function needsBrowser(kind: string): boolean {
  if (CONNECTOR_KINDS.has(kind) || RECORD_KINDS.has(kind)) return false;
  return kind !== 'done' && kind !== 'ask_user' && kind !== 'delegate';
}
