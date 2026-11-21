/**
 * Work out who an action would actually reach.
 *
 * A recipient-scoped grant is only as good as this function. Taking the first
 * email address anywhere on the page is the failure to avoid: a compose view
 * showing "Suggested contact alice@example.test" above a To field addressed
 * to bob@example.test would match an "Alice only" grant, and the message to
 * Bob would go out unattended.
 *
 * So identity comes only from places that actually determine the destination:
 *
 *   1. A conversation or profile named in the URL path.
 *   2. The VALUE of an addressee control — a field named To, Recipient, Cc,
 *      Bcc. Not its label, not nearby text, not the page body.
 *   3. A level-1 heading that reads like a name, for conversation views that
 *      carry no identifier in the URL. It names someone only at that path.
 *
 * Anything else yields null, and two candidates that disagree also yield
 * null. Null is a safe answer: a recipient-scoped grant refuses to match an
 * unknown recipient, so an undetermined recipient means a person decides.
 */

import type { Observation, ObservedNode } from '../types.ts';
import { unwrapUntrustedForDisplay } from './untrusted.ts';

/** URL shapes that name a person or conversation in the path. */
const PROFILE_PATHS: RegExp[] = [
  /^\/in\/([^/]+)/,                  // linkedin.com/in/<slug>
  /^\/messaging\/thread\/([^/]+)/,
  /^\/messages?\/([^/]+)/,
  /^\/u\/([^/]+)/,
  /^\/users?\/([^/]+)/,
  /^\/profile\/([^/]+)/,
  /^\/@([^/]+)/,
];

/** Controls whose value determines where something is sent. */
const ADDRESSEE_FIELD = /^\s*(to|recipients?|send to|cc|bcc|for)\b/i;

/** Roles that can carry an address. A heading that says "To: x" cannot. */
const ADDRESSEE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox']);

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

const NOT_AN_IDENTITY = /^(new|compose|inbox|sent|drafts|all|index|home)$/i;

export interface RecipientEvidence {
  /** Stable identity, suitable for matching a grant and for dedupe. */
  id: string;
  /** How it was determined, so an audit line can explain itself. */
  from: 'url' | 'addressee-field' | 'heading';
  display: string;
}

export function deriveRecipient(observation: Observation | null): RecipientEvidence | null {
  if (!observation) return null;

  let url: URL;
  try {
    url = new URL(observation.url);
  } catch {
    return null;
  }

  // Both signals are gathered before either is trusted. A path is harder to
  // fake than a field, which settles nothing when the two disagree: a thread
  // at /messages/priya whose To field addresses someone else does not send to
  // Priya, and a Priya-only grant must not cover it.
  const fromUrl = urlIdentity(url);
  const addressed = addresseeValues(observation);

  if (addressed.size > 1) {
    // Several destinations: not covered by a single-recipient grant.
    return null;
  }

  const addressee = addressed.size === 1 ? [...addressed][0] : null;

  if (fromUrl && addressee) {
    // Both present. They have to be the same person, or the destination is
    // genuinely unclear and a person decides.
    if (!corroborates(fromUrl.slug, addressee)) return null;
    return { id: fromUrl.id, from: 'url', display: fromUrl.slug };
  }
  if (fromUrl) return { id: fromUrl.id, from: 'url', display: fromUrl.slug };
  if (addressee) return { id: addressee, from: 'addressee-field', display: addressee };

  // 3. A conversation view that names the other party in its main heading.
  const heading = observation.nodes.find((n) => n.role === 'heading' && n.state.level === 1 && n.name);
  if (heading?.name) {
    const display = unwrapUntrustedForDisplay(heading.name).trim();
    // Page-authored text, so it only counts when it reads like a name rather
    // than a sentence.
    if (display && display.length <= 60 && display.split(/\s+/).length <= 5) {
      // The path is part of it: a heading is only a name within one view.
      // Two postings on one job board share a host and often a title, and
      // without the path the second would read as a second message to the first.
      return { id: `${url.hostname}${url.pathname}/heading:${display.toLowerCase()}`, from: 'heading', display };
    }
  }

  return null;
}

function urlIdentity(url: URL): { id: string; slug: string } | null {
  for (const pattern of PROFILE_PATHS) {
    const m = pattern.exec(url.pathname);
    if (!m?.[1]) continue;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (!slug || slug.length > 120 || NOT_AN_IDENTITY.test(slug)) return null;
    return { id: `${url.hostname}/${slug}`, slug };
  }
  return null;
}

function addresseeValues(observation: Observation): Set<string> {
  const addressed = new Set<string>();
  for (const node of observation.nodes) {
    if (!isAddresseeControl(node)) continue;
    const value = node.value ? unwrapUntrustedForDisplay(node.value) : '';
    if (!value.trim()) continue;
    const emails = value.match(EMAIL) ?? [];
    for (const email of emails) addressed.add(email.toLowerCase());
    if (!emails.length) {
      // Some clients show a resolved contact name rather than an address.
      const display = value.trim();
      if (display && display.length <= 80) addressed.add(display.toLowerCase());
    }
  }
  return addressed;
}

/**
 * Do a URL slug and an addressee value name the SAME person?
 *
 * Whole-identity agreement, not a shared token. Accepting any overlap would
 * let /messages/priya-sharma corroborate priya.patel@example.test on the
 * strength of a first name, and a Priya-Sharma-only grant authorise a message
 * to Priya Patel. A first name is not an identity, and "some of this name
 * appears in that one" is not evidence that they are the same person.
 *
 * So the comparable tokens have to match exactly, in both directions. What is
 * dropped before comparing is only material that carries no identity:
 * opaque ids and numeric suffixes, which real profile URLs append
 * (`/in/priya-sharma-9a8b7c61`) and which would otherwise force an approval
 * on every legitimate send.
 *
 * "priya-sharma" agrees with "priya.sharma@example.test" and with
 * "Priya Sharma". It does not agree with "priya.patel@example.test", and a
 * bare "priya" does not agree with "Priya Sharma" either — a shorter name is
 * not a subset of a longer one, it is a different amount of information, and
 * the cost of being wrong here is a message to the wrong person against the
 * cost of one approval.
 */
function corroborates(slug: string, addressee: string): boolean {
  const a = identityTokens(slug);
  const b = identityTokens(addressee);
  if (!a.size || !b.size) return false;
  if (a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/** Name-bearing tokens only: opaque ids and numbers identify nothing. */
function identityTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/@.*$/, ' ')            // compare the local part of an address
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
      .filter((t) => !/^\d+$/.test(t))
      .filter((t) => !(/\d/.test(t) && t.length >= 6)),
  );
}

function isAddresseeControl(node: ObservedNode): boolean {
  if (!ADDRESSEE_ROLES.has(node.role)) return false;
  const name = node.name ? unwrapUntrustedForDisplay(node.name) : '';
  return ADDRESSEE_FIELD.test(name);
}

/**
 * Has the destination changed since it was authorised?
 *
 * Called immediately before an outbound action, against a fresh observation.
 * A page that swaps the recipient between the decision and the click is the
 * whole reason a grant is checked against an identity rather than a domain.
 */
export function recipientChanged(
  authorised: string | null,
  current: RecipientEvidence | null,
): { changed: true; why: string } | { changed: false } {
  const now = current?.id ?? null;
  if (authorised === now) return { changed: false };
  return {
    changed: true,
    why:
      `the recipient changed between the check and the action: authorised for ` +
      `${authorised ?? '(none)'}, the page now addresses ${now ?? '(none determinable)'}`,
  };
}

/** Readable time for a person, from a stored ISO timestamp. */
export function whenSaid(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Why a second send to the same recipient waits. The recipient may be a
 * person or a posting named by its heading, so it says what happened, not who.
 */
export function repeatContactWhy(display: string, contactedAt: string): string {
  return `something was already sent to ${display} on ${whenSaid(contactedAt)}. Sending to them again needs you, whatever else is granted`;
}
