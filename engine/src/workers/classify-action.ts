/**
 * Name the platform and the kind of activity an action represents.
 *
 * The rate governor counts things; this is what decides what is being
 * counted. Both halves matter: the platform, so limits are per-site rather
 * than global, and the activity, so "sent an invite" and "opened a profile"
 * are not the same quantity — which is the whole basis of the
 * outreach-to-ordinary ratio.
 *
 * Derived from the action and the control, never from the model's narration.
 */

import type { AgentAction } from '../agent/prompt.ts';
import type { Observation, Sensitivity } from '../types.ts';
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';

/** Outbound activities, most specific first — order decides ties. */
const OUTBOUND: Array<[RegExp, string]> = [
  [/\b(easy apply|apply now|submit application|apply|submit)\b/i, 'apply'],
  [/\b(connect|invite|add contact|follow)\b/i, 'invite'],
  [/\b(send|message|reply|dm)\b/i, 'message'],
  [/\b(comment|respond)\b/i, 'comment'],
  [/\b(post|publish|tweet|share)\b/i, 'post'],
  [/\b(endorse|recommend|like|react)\b/i, 'react'],
];

/** Ordinary activity — the denominator of the ratio. */
const ORDINARY: Array<[RegExp, string]> = [
  [/\b(search|find|filter|sort)\b/i, 'search'],
  [/\b(next|previous|more|load more|page)\b/i, 'paginate'],
  [/\b(open|view|expand|details|profile)\b/i, 'read'],
];

export interface ActivityLabel {
  platform: string;
  action: string;
  /** True when this should be counted against outbound limits. */
  outbound: boolean;
}

export function labelActivity(
  action: AgentAction,
  observation: Observation | null,
  sensitivity: Sensitivity,
): ActivityLabel {
  const platform = hostOf(observation?.url) || 'unknown';

  if (action.kind === 'done' || action.kind === 'ask_user') {
    return { platform, action: 'noop', outbound: false };
  }
  if (action.kind === 'goto' || action.kind === 'scroll' || action.kind === 'hover') {
    return { platform, action: 'read', outbound: false };
  }
  if (action.kind === 'fill' || action.kind === 'type') {
    return { platform, action: 'compose', outbound: false };
  }

  const node = action.ref && observation
    ? observation.nodes.find((n) => n.ref === action.ref!.replace(/^@/, ''))
    : undefined;
  const name = node?.name ? unwrapUntrustedForDisplay(node.name) : '';

  for (const [pattern, label] of OUTBOUND) {
    if (pattern.test(name)) return { platform, action: label, outbound: true };
  }

  // A sensitivity that needed permission is outbound even when the control's
  // name says nothing — an unnamed Send button still sends.
  if (sensitivity === 'CONTACT_EXTERNAL' || sensitivity === 'IRREVERSIBLE') {
    return { platform, action: 'outbound', outbound: true };
  }
  if (sensitivity === 'AMBIGUOUS_WRITE') {
    return { platform, action: 'unclassified_write', outbound: true };
  }

  for (const [pattern, label] of ORDINARY) {
    if (pattern.test(name)) return { platform, action: label, outbound: false };
  }
  return { platform, action: 'interact', outbound: false };
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}
