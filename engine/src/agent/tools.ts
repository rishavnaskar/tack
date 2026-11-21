/**
 * Non-browser actions the agent can take.
 *
 * Connectors let a task answer "does this meeting clash" or "what did they
 * say in their last email" without driving a browser to a webmail client. An
 * API keeps working while the machine is asleep, and is faster and more
 * reliable than a page for the same information.
 *
 * Two properties this interface enforces by shape rather than by check:
 *
 *  - There is NO send, because `Gmail` has no send method. That is a property
 *    of this code, not of the token: `gmail.compose` also authorises sending,
 *    so the grant is broader than what is used. Drafting is only requested
 *    when the user enables it, and the default grant is read-only — which is
 *    the part that genuinely cannot send.
 *
 *  - Everything that comes back is UNTRUSTED. An email body is written by
 *    whoever sent it, which makes an inbox the most direct indirect-injection
 *    surface the agent has — more direct than a web page, because the user
 *    did not choose to visit it. Results are fenced on the way to the model
 *    exactly like page content.
 */

import type { Untrusted } from '../types.ts';
import { markUntrusted } from '../policy/untrusted.ts';
import type { MailReader, CalendarReader, Capability, MessageText } from '../connectors/google.ts';
import { permits } from '../connectors/google.ts';
import { codesIn } from '../connectors/mail-code.ts';

export interface ToolResult {
  ok: boolean;
  /** Rendered for the model. Already marked untrusted; still needs fencing. */
  summary: Untrusted;
  /** Anything the caller wants to record. Never shown to the model raw. */
  detail?: Record<string, unknown>;
  error?: string;
}

export interface AgentTools {
  gmailSearch?(query: string, limit: number): Promise<ToolResult>;
  gmailDraft?(to: string, subject: string, body: string): Promise<ToolResult>;
  calendarEvents?(days: number): Promise<ToolResult>;
  calendarFreeSlots?(days: number, minutes: number): Promise<ToolResult>;
  /**
   * Mail that arrived after a moment, with its text. Fanfold's own code reads
   * this to find a code a site just emailed; it is never offered to a model.
   */
  mailSince?(since: Date, limit: number): Promise<MessageText[]>;
  /** Who the user is on LinkedIn: name, headline, email, profile address. Read-only. */
  linkedinProfile?(): Promise<ToolResult>;
}

export interface GoogleToolsOptions {
  /** Either provider: Google's API directly, or Composio. Same surface, no `send`. */
  gmail?: MailReader;
  calendar?: CalendarReader;
  /**
   * What the token actually grants.
   *
   * Each tool is gated on the scope its API requires, not on whether a client
   * object exists. A read-only token that advertised `gmail_draft` would have
   * the call refused by Google, but the agent and the consent screen would
   * disagree about what it can do, which is its own failure — the agent plans
   * around capabilities it believes it has.
   *
   * Omit to offer everything, which is only appropriate for a test double.
   */
  scopes?: Set<string>;
  /** Cap on how much of a message body reaches the model. */
  maxSnippet?: number;
}

/** A tool call that failed, with the reason the caller is told. */
const failed = (error: string): ToolResult => ({ ok: false, summary: markUntrusted(''), error });

export function googleTools(opts: GoogleToolsOptions): AgentTools {
  const maxSnippet = opts.maxSnippet ?? 300;
  const tools: AgentTools = {};

  // Which scopes imply which capability is decided by CAPABILITY_SCOPES, not
  // spelled out again here. Two copies of the rule drift apart: one accepting
  // gmail.modify as read while the reachability probe does not advertises
  // Gmail tools that were never checked, and a broken Gmail still reports a
  // usable account.
  const granted = (capability: Capability): boolean => permits(opts.scopes, capability);

  if (opts.gmail && granted('gmailRead')) {
    tools.gmailSearch = async (query, limit) => {
      try {
        const messages = await opts.gmail!.search(query, Math.min(limit || 10, 25));
        if (!messages.length) {
          return { ok: true, summary: markUntrusted('No messages matched.') };
        }
        const lines = messages.map((m, i) => {
          // A code a site emailed is Fanfold's to type into its form (browser_code), never a model's to read.
          const codes = codesIn(`${m.subject}\n${m.snippet}`);
          const hide = (text: string): string => codes.reduce((t, code) => t.split(code).join('[a code: use browser_code]'), text);
          return `${i + 1}. from ${m.from} — ${hide(m.subject)} (${m.date})\n   ${hide(m.snippet).slice(0, maxSnippet)}`;
        });
        return {
          ok: true,
          summary: markUntrusted(lines.join('\n')),
          detail: { ids: messages.map((m) => m.id) },
        };
      } catch (err) {
        return failed((err as Error).message);
      }
    };
    tools.mailSince = (since, limit) => opts.gmail!.arrivedSince(since, limit);
  }

  if (opts.gmail && granted('gmailDraft')) {
    tools.gmailDraft = async (to, subject, body) => {
      if (!to.trim() || !body.trim()) {
        return failed('a draft needs a recipient and a body');
      }
      try {
        const draft = await opts.gmail!.createDraft(to, subject, body);
        return {
          ok: true,
          // Deliberately explicit: the agent should not report this as sent,
          // and neither should its summary to the user.
          summary: markUntrusted(`Draft saved to ${to} — "${subject}". It has NOT been sent.`),
          detail: { draftId: draft.id, to, subject },
        };
      } catch (err) {
        return failed((err as Error).message);
      }
    };
  }

  if (opts.calendar && granted('calendarRead')) {
    tools.calendarEvents = async (days) => {
      const window = clampDays(days);
      try {
        const events = await opts.calendar!.events(new Date(), addDays(window));
        if (!events.length) return { ok: true, summary: markUntrusted(`Nothing in the next ${window} days.`) };
        const lines = events.map(
          (e) => `${e.start} – ${e.end}  ${e.summary}${e.attendees.length ? ` (${e.attendees.length} attendees)` : ''}`,
        );
        return { ok: true, summary: markUntrusted(lines.join('\n')), detail: { count: events.length } };
      } catch (err) {
        return failed((err as Error).message);
      }
    };

    tools.calendarFreeSlots = async (days, minutes) => {
      const window = clampDays(days);
      const length = Math.min(Math.max(minutes || 30, 15), 480);
      try {
        const slots = await opts.calendar!.freeSlots(new Date(), addDays(window), length);
        if (!slots.length) {
          return { ok: true, summary: markUntrusted(`No ${length}-minute gaps in the next ${window} days.`) };
        }
        const lines = slots.slice(0, 10).map((s) => `${s.start.toISOString()} – ${s.end.toISOString()}`);
        return { ok: true, summary: markUntrusted(lines.join('\n')), detail: { count: slots.length } };
      } catch (err) {
        return failed((err as Error).message);
      }
    };
  }

  return tools;
}

/** The LinkedIn tool, over anything that can produce the member's profile. */
export function linkedinTools(source: { profile(): Promise<{ name: string | null; email: string | null; headline: string | null; url: string | null }> }): AgentTools {
  return {
    linkedinProfile: async () => {
      try {
        const p = await source.profile();
        const lines = [
          p.name ? `Name: ${p.name}` : null, p.headline ? `Headline: ${p.headline}` : null,
          p.email ? `Email: ${p.email}` : null, p.url ? `Profile: ${p.url}` : null,
        ].filter((l): l is string => l !== null);
        if (!lines.length) return failed('LinkedIn returned no profile details for this account');
        return { ok: true, summary: markUntrusted(lines.join('\n')), detail: { ...p } };
      } catch (err) {
        return failed((err as Error).message);
      }
    },
  };
}

function clampDays(days: number): number {
  return Math.min(Math.max(Math.round(days) || 7, 1), 60);
}

function addDays(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

/** Which tools are actually available, for the prompt to list. */
export function availableTools(tools: AgentTools | undefined): string[] {
  if (!tools) return [];
  const names: string[] = [];
  if (tools.gmailSearch) names.push('gmail_search');
  if (tools.gmailDraft) names.push('gmail_draft');
  if (tools.calendarEvents) names.push('calendar_events');
  if (tools.calendarFreeSlots) names.push('calendar_free_slots');
  if (tools.linkedinProfile) names.push('linkedin_profile');
  return names;
}
