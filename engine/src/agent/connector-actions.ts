/**
 * Connector actions: Gmail and Calendar, reached through an API rather than a page.
 */

import type { AgentAction } from './prompt.ts';
import type { AgentTools, ToolResult } from './tools.ts';

type ConnectorOutcome = { ok: true; summary: string } | { ok: false; error: string };

/** A tool's result as the loop takes it, with `fallback` for a failure that gave no reason. */
function outcome(r: ToolResult, fallback: string): ConnectorOutcome {
  return r.ok ? { ok: true, summary: String(r.summary) } : { ok: false, error: r.error ?? fallback };
}

/**
 * Run one connector action.
 *
 * A connector that is not configured fails as unavailable rather than
 * throwing: the model should learn it cannot use that route and pick another,
 * not have the run collapse.
 */
export async function runConnectorAction(
  tools: AgentTools | undefined,
  action: AgentAction,
): Promise<ConnectorOutcome> {
  const args = action.connector ?? {};
  const unavailable = (name: string): { ok: false; error: string } => ({
    ok: false,
    error: `${name} is not connected. Set it up in the UI, or use the browser instead.`,
  });

  switch (action.kind) {
    case 'gmail_search':
      if (!tools?.gmailSearch) return unavailable('Gmail');
      return outcome(await tools.gmailSearch(args.query ?? action.value ?? '', 10), 'gmail search failed');
    case 'gmail_draft':
      if (!tools?.gmailDraft) return unavailable('Gmail');
      return outcome(await tools.gmailDraft(args.to ?? '', args.subject ?? '', args.body ?? ''), 'could not save the draft');
    case 'calendar_events':
      if (!tools?.calendarEvents) return unavailable('Calendar');
      return outcome(await tools.calendarEvents(args.days ?? 7), 'calendar read failed');
    case 'calendar_free_slots':
      if (!tools?.calendarFreeSlots) return unavailable('Calendar');
      return outcome(await tools.calendarFreeSlots(args.days ?? 7, args.minutes ?? 30), 'calendar read failed');
    case 'linkedin_profile':
      if (!tools?.linkedinProfile) return unavailable('LinkedIn');
      return outcome(await tools.linkedinProfile(), 'could not read the LinkedIn profile');
    default:
      return { ok: false, error: `${action.kind} is not a connector action` };
  }
}
