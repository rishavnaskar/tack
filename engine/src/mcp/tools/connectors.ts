/** The user's connected accounts: mail and calendar, read through their own grant. */
import { runConnectorAction } from '../../agent/connector-actions.ts';
import { fenceBlock } from '../../policy/untrusted.ts';
import type { AgentAction, AgentActionKind, ConnectorArgs } from '../../agent/prompt.ts';
import type { Tool } from '../protocol.ts';
import type { FanfoldContext } from '../context.ts';

export function connectorTools(ctx: FanfoldContext): Tool[] {
  const run = async (kind: AgentActionKind, connector: ConnectorArgs): Promise<string> => {
    const action: AgentAction = { kind, reason: 'chosen by the host', connector };
    const outcome = await runConnectorAction(ctx.connectors.current, action);
    if (!outcome.ok) throw new Error(outcome.error);
    // Mail and calendar text is written by other people, like a web page.
    return fenceBlock(outcome.summary, `connector:${kind}`);
  };

  const status: Tool = {
    name: 'connectors',
    title: 'Which accounts are connected',
    description: 'Whether the user has connected Gmail, Google Calendar and LinkedIn to Fanfold, and what each can do. Connecting is done by the user in Fanfold.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => {
      const tools = await ctx.connectors.reload();
      const lines = [
        `Gmail search: ${tools.gmailSearch ? 'connected' : 'not connected'}`,
        `Gmail drafts: ${tools.gmailDraft ? 'connected (drafts only; Fanfold never sends mail)' : 'not connected'}`,
        `Calendar: ${tools.calendarEvents ? 'connected' : 'not connected'}`,
        `LinkedIn profile: ${tools.linkedinProfile ? 'connected (who they are; nothing is posted or sent)' : 'not connected'}`,
      ];
      if (!tools.gmailSearch && !tools.calendarEvents && !tools.linkedinProfile) {
        lines.push('The user connects accounts in Fanfold\'s Settings, under Connectors. Until then, use the browser.');
      } else {
        // A host lists tools once, when it connects: one connected since then is not in its list, but answers by name.
        const names = ([['gmailSearch', 'gmail_search'], ['gmailDraft', 'gmail_draft'], ['calendarEvents', 'calendar_events'],
          ['calendarFreeSlots', 'calendar_free_slots'], ['linkedinProfile', 'linkedin_profile']] as const)
          .filter(([key]) => tools[key] !== undefined).map(([, name]) => name);
        lines.push(`Call these by name: ${names.join(', ')}. They work even if your app listed Fanfold's tools before the account was connected.`);
      }
      return lines.join('\n');
    },
  };

  const gmailSearch: Tool = {
    name: 'gmail_search',
    title: 'Search the user\'s Gmail',
    description: 'Find messages in the user\'s Gmail using Gmail\'s own search syntax, e.g. "from:greenhouse newer_than:14d". Read-only.',
    inputSchema: {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
    },
    annotations: { readOnlyHint: true },
    available: () => ctx.connectors.current.gmailSearch !== undefined,
    run: (args) => run('gmail_search', { query: String(args.query) }),
  };

  const gmailDraft: Tool = {
    name: 'gmail_draft',
    title: 'Save a draft in the user\'s Gmail',
    description: 'Write a draft into the user\'s Gmail for them to read and send themselves. Nothing is sent.',
    inputSchema: {
      type: 'object', required: ['to', 'subject', 'body'], additionalProperties: false,
      properties: {
        to: { type: 'string', minLength: 3, maxLength: 320 },
        subject: { type: 'string', maxLength: 300 },
        body: { type: 'string', minLength: 1, maxLength: 20000 },
      },
    },
    available: () => ctx.connectors.current.gmailDraft !== undefined,
    run: (args) => run('gmail_draft', { to: String(args.to), subject: String(args.subject), body: String(args.body) }),
  };

  const events: Tool = {
    name: 'calendar_events',
    title: 'The user\'s upcoming calendar',
    description: 'Events on the user\'s calendar over the next days. Read-only.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 1, maximum: 60, description: 'Default 7.' } },
    },
    annotations: { readOnlyHint: true },
    available: () => ctx.connectors.current.calendarEvents !== undefined,
    run: (args) => run('calendar_events', { days: typeof args.days === 'number' ? args.days : 7 }),
  };

  const free: Tool = {
    name: 'calendar_free_slots',
    title: 'When the user is free',
    description: 'Gaps in the user\'s calendar long enough for a meeting, for proposing interview times.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 7.' },
        minutes: { type: 'integer', minimum: 15, maximum: 240, description: 'Length needed. Default 30.' },
      },
    },
    annotations: { readOnlyHint: true },
    available: () => ctx.connectors.current.calendarFreeSlots !== undefined,
    run: (args) => run('calendar_free_slots', {
      days: typeof args.days === 'number' ? args.days : 7,
      minutes: typeof args.minutes === 'number' ? args.minutes : 30,
    }),
  };

  const linkedin: Tool = {
    name: 'linkedin_profile',
    title: 'The user\'s LinkedIn profile',
    description: 'Who the user is on LinkedIn: name, headline, email and profile address, from their own connected account. Read-only. Looking for roles and applying on LinkedIn happen in the browser.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
    available: () => ctx.connectors.current.linkedinProfile !== undefined,
    run: () => run('linkedin_profile', {}),
  };

  return [status, gmailSearch, gmailDraft, events, free, linkedin];
}
