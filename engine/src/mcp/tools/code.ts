/**
 * The code an application form emailed the user.
 *
 * The form is filled and Submit is pressed, and then the site wants a code it
 * sent to the applicant's inbox. An agent that closes the session there has
 * thrown the application away. This tool finishes it: with the user's mail
 * connected Fanfold reads the code and types it, and without it the agent is
 * told how to get the code from the user and to keep the page open meanwhile.
 * It works only during this session's code ask (code-ask.ts), which begins
 * with the session's own application Submit: a code asked for with nothing
 * like that before it is for signing in, and the user's.
 */
import { codeEntry, forAccount, isCodeField, mailRefused, UsedCodes, waitForCode, type CodeMail, type RecentMail } from '../../connectors/mail-code.ts';
import { TOOLKITS } from '../../connectors/composio.ts';
import { fence, unwrapUntrustedForDisplay } from '../../policy/untrusted.ts';
import { hostOf } from '../../jobs/site-policies.ts';
import { displayKeeper, ensureDrawing } from '../../observe/display-wake.ts';
import { beforeAction } from '../../policy/site-guard.ts';
import { reportGoverned } from '../approval.ts';
import type { AgentAction } from '../../agent/prompt.ts';
import type { Observation, Untrusted } from '../../types.ts';
import type { Tool } from '../protocol.ts';
import type { Session } from '../sessions.ts';
import { SESSION_ARG, sessionFor, snapshot, type FanfoldContext } from '../context.ts';
import { CODE_ASK_MS, followCodeAsk, hideCodes } from '../code-ask.ts';
import { govern, withNotes } from './browser.ts';

/** How long one call watches the mailbox. Kept short: a host may run none of its other calls to Fanfold until this one returns. */
const WAIT_MS = 20_000;
const CODE = /^[A-Za-z0-9]{4,12}$/;

/** A page saying the code it was given is no good. */
const TURNED_AWAY = /\b(incorrect|invalid|wrong|expired|not valid|no longer valid|(did|does)\s?n[o'’]?t match)\b/i;
const said = (t: Untrusted | null | undefined): string => (t ? unwrapUntrustedForDisplay(t) : '');

/** Everything on the page that speaks against a code, a field's own error included. */
const refusals = (observation: Observation): string[] => observation.nodes
  .map((n) => [said(n.name), said(n.text), n.state.error ?? ''].filter(Boolean).join(' '))
  .filter((t) => TURNED_AWAY.test(t));

/** The code still sits in its field (or its boxes, in order), and the field is not marked wrong. */
const stillIn = (observation: Observation, refs: string[], code: string): boolean => {
  const fields = refs.map((ref) => observation.nodes.find((n) => n.ref === ref));
  return fields.every((n) => n && !n.state.invalid)
    && fields.map((n) => said(n?.value)).join('').replace(/[\s-]/g, '').toUpperCase() === code.toUpperCase();
};

export function codeTool(ctx: FanfoldContext): Tool {
  /** Every message and code already typed into a form, by any session: none goes into a second one. */
  const used = new UsedCodes();

  const keep = (session: Session): string =>
    `Keep session "${session.name}" open on this page: the code only works here, and closing it loses the application.`;

  /** What to do when Fanfold cannot enter the code itself. `ownMail` only when Fanfold has no mail connection at all. */
  const handOver = (session: Session, why: string, ownMail = false): { text: string; isError: true } => ({
    text: [
      `Not entered: ${why}`,
      keep(session),
      ...(ownMail ? ['If you have a tool of your own that reads the user\'s mail, find the newest message from this site, take the code from it, and call browser_code again with it as "code". Otherwise:'] : []),
      'Ask the user for the code the site emailed them, then call browser_code again with it as "code". A sub-agent cannot ask: return to your parent with this session\'s name and say a code is needed.',
      `The user can also type it into the page themselves, in the Fanfold window for session "${session.name}".`,
      ...(ownMail ? ['Once the user connects their mail in Fanfold\'s Settings, under Connectors, Fanfold enters these codes by itself.'] : []),
    ].join('\n'),
    isError: true,
  });

  const closedText = (session: Session): { text: string; isError: true } => ({
    text: `Not entered: session "${session.name}" was closed while Fanfold waited for the code, so the application was not finished. `
      + 'Fanfold\'s ledger lists it as needing the user, since the site still wanted its code. Tell the user.',
    isError: true,
  });

  /** A Gmail connection the mail service lists with none of it active: its state, such as EXPIRED. */
  const mailState = async (): Promise<string | null> => {
    const gmail = (await ctx.app.composioAccounts().catch(() => [])).filter((a) => a.toolkit === TOOLKITS.gmail);
    return gmail.length && !gmail.some((a) => a.status === 'ACTIVE') ? gmail[0]!.status : null;
  };

  return {
    name: 'browser_code',
    title: 'Enter the code a site emailed the user',
    description:
      'When an application form says it emailed a code and shows a field for it, call this instead of stopping. '
      + 'It works only after this session\'s own Submit of the application: a code asked for without one is for signing in, and the user\'s. '
      + 'With the user\'s mail connected to Fanfold, it finds the code in the message the site sent after that Submit and types it into the field; the code is not shown to you. '
      + 'Without that, it says how to get the code; pass it as "code" once you have it. '
      + 'Afterwards press the form\'s Submit as usual. Never close the session while a code is awaited. '
      + 'Sign-in, two-step and text-message codes are the user\'s to enter.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        code: { type: 'string', minLength: 4, maxLength: 12, description: 'The code, once you have it the way browser_code said to get it. Leave out to let Fanfold read it from the user\'s connected mail.' },
        ref: { type: 'string', maxLength: 32, description: 'The code field. Leave out and Fanfold finds it.' },
        session: SESSION_ARG,
      },
    },
    run: async (args, call) => {
      const session = await sessionFor(ctx, args, call);
      return ctx.sessions.exclusive(session, async () => {
        // Closed while this call waited its turn: its page is gone.
        if (session.closing.signal.aborted) return closedText(session);
        const drawn = await ensureDrawing(session.page, displayKeeper);
        const observation = await session.page.observe();
        session.observation = observation;
        const record = followCodeAsk(ctx.app, session, observation);
        const entry = codeEntry(observation);
        if (!entry || forAccount(observation)) {
          return {
            text: 'This page is not asking for a code it emailed for an application, so nothing was entered. '
              + 'A code for signing in, for two-step verification or sent by text message is the user\'s to enter, in the Fanfold window.',
            isError: true,
          };
        }
        if (!record) {
          return {
            text: `Not entered: this page asks for a code, but no application Submit from session "${session.name}" on this site came before it, `
              + 'so it is not a code for an application; it is most likely for signing in, which is the user\'s. '
              + `Ask the user to type it into the page themselves, in the Fanfold window for session "${session.name}", and keep the session open meanwhile.`,
            isError: true,
          };
        }
        // Whoever found the code, it goes only into the field that takes it, never one the agent could read it back from.
        const ref = typeof args.ref === 'string' && args.ref ? args.ref : entry.ref;
        const target = observation.nodes.find((n) => n.ref === ref);
        if (ref !== entry.ref && !(target && isCodeField(target))) {
          return { text: `${ref} is not the field for the emailed code, so nothing was entered. Leave out "ref" and Fanfold uses ${entry.ref}.`, isError: true };
        }
        // The length the page gave when it first asked: a page that turned a code away may not say it again.
        const length = record.length ?? entry.boxes?.length ?? null;

        // Waiting for a newer message needs Fanfold to read the mail; without that, a newer code comes from the user.
        const again = (): string => (ctx.app.store.setting('mailCodes', true) && ctx.connectors.current.mailSince
          ? 'call browser_code again and it will wait for a newer one.'
          : 'ask the user for the newest code the site sent and call browser_code again with it.');

        const enter = async (code: string, from: string, mail?: CodeMail): Promise<{ text: string; isError?: boolean }> => {
          // One box per character: each gets its own, in order, rather than the whole code in the first.
          const boxes = entry.boxes ?? [];
          if (boxes.length && boxes.length !== code.length) {
            return { text: hideCodes(record, `Not entered: the page splits the code into ${boxes.length} boxes, and this code has ${code.length} characters. Ask the user to type it into the page in the Fanfold window for session "${session.name}".`), isError: true };
          }
          const paced = await beforeAction(ctx, observation.url);
          for (const [box, value] of boxes.length ? boxes.map((b, i) => [b, code[i]!] as const) : [[ref, code] as const]) {
            const action: AgentAction = { kind: 'fill', ref: box, value, reason: 'the code the site emailed' };
            const governed = await govern(ctx, session, action);
            if (governed.status !== 'ok') {
              const report = governed.status === 'failed'
                ? { text: `FAILED ${governed.failure}: ${governed.detail || 'the field could not be used'}.` }
                : await reportGoverned(ctx, session, call, action, governed, null);
              return { text: hideCodes(record, withNotes(drawn, paced, report.text)), isError: true };
            }
          }
          used.add(code, ...(mail ? [mail.id] : []));
          record.entered = { code, url: observation.url, refusals: refusals(observation) };
          // The field now shows the code, and so does the page read back.
          const page = await snapshot(ctx, session, { interactive: true, maxNodes: 60 });
          return {
            text: hideCodes(record, withNotes(drawn, paced, `Entered ${from}. Now press the form's Submit. `
              + `If the site says the code is wrong or expired, ${again()}`, page)),
          };
        };

        const given = typeof args.code === 'string' ? args.code.replace(/[\s-]/g, '') : '';
        if (given) {
          if (!CODE.test(given) || (length !== null && given.length !== length)) {
            return { text: `That is not the code this page wants${length ? `: it asks for ${length} characters` : ''}. Nothing was entered.`, isError: true };
          }
          return enter(given, 'the code you passed');
        }

        // Typed already and nothing new on the page speaks against it: what is left is the form's Submit, not more mail.
        const before = record.entered;
        if (before && before.url === observation.url && stillIn(observation, entry.boxes?.length ? entry.boxes : [ref], before.code)
          && refusals(observation).every((r) => before.refusals.includes(r))) {
          const page = await snapshot(ctx, session, { interactive: true, maxNodes: 60 });
          return {
            text: hideCodes(record, withNotes(drawn, 'Already entered: the code is in its field on this page, and the page has not turned it away. '
              + 'Press the form\'s Submit now, without waiting for another message. '
              + `If the site then says the code is wrong or expired, ${again()}`, page)),
          };
        }

        if (!ctx.app.store.setting('mailCodes', true)) {
          return handOver(session, 'the user chose to enter these codes themselves, so Fanfold does not read their mail for them.');
        }
        const tools = ctx.connectors.current.mailSince ? ctx.connectors.current : await ctx.connectors.reload();
        if (!tools.mailSince) return handOver(session, 'the user\'s mail is not connected to Fanfold.', true);

        call.progress('waiting for the site\'s message');
        // A connection the mail service now lists as expired or failed refuses every read: found out at the first failure, not after the whole wait.
        let checked = false;
        const recent: RecentMail = async (since, limit) => {
          try {
            return await tools.mailSince!(since, limit);
          } catch (err) {
            const state = !checked && !mailRefused(err) ? await mailState() : null;
            checked = true;
            throw state ? new Error(`the Gmail connection is ${state}`) : err;
          }
        };
        // Applications other sessions are waiting on codes for: a message naming one of them is that one's.
        const others = ctx.sessions.list()
          .filter((s) => s !== session && s.codeAsk && Date.now() - s.codeAsk.since.getTime() <= CODE_ASK_MS)
          .map((s) => s.codeAsk!.company).filter(Boolean);
        let found: Awaited<ReturnType<typeof waitForCode>>;
        try {
          found = await waitForCode(recent, {
            url: observation.url, company: record.company || undefined, board: record.board || undefined, others,
            since: record.since, length, used,
          }, { signal: AbortSignal.any([call.signal, session.closing.signal]), timeoutMs: waits.timeoutMs ?? WAIT_MS, intervalMs: waits.intervalMs });
        } catch (err) {
          ctx.log.warn('reading mail for a code failed', { err });
          const said = (err as Error).message.slice(0, 160);
          return handOver(session, mailRefused(err)
            ? `the user's mailbox refused Fanfold's request (${said}): it is no longer connected, or its access was withdrawn.`
            : `the user's mail could not be read (${said}).`);
        }
        if (session.closing.signal.aborted) return closedText(session);
        if (call.signal.aborted) return { text: 'Cancelled: nothing was entered.', isError: true };

        const site = hostOf(observation.url);
        if (!found || 'unreadable' in found) {
          const what = !found
            ? `no message from ${site} has arrived in the user's mail since the application was submitted.`
            : `${found.unreadable} message${found.unreadable === 1 ? '' : 's'} from ${site} arrived since the application was submitted, and Fanfold could not read a code from ${found.unreadable === 1 ? 'it' : 'them'}.`;
          // Mail can take a minute: one more look before the user is asked.
          if (++record.misses < 2) {
            return {
              text: [`Not entered yet: ${what}`, keep(session),
                'Call browser_code again in about 30 seconds. It looks at all mail since the Submit, so a message that arrives meanwhile is not missed. Work on other jobs in between.',
              ].join('\n'),
              isError: true,
            };
          }
          return handOver(session, what);
        }
        if (found.code === null) {
          return handOver(session, `${found.several} different codes arrived from ${site} or its application system since this application was submitted, and Fanfold could not tell which one is this application's.`);
        }
        record.hidden.add(found.code);
        record.misses = 0;
        ctx.emit({ type: 'code_entered', session: session.name, site });
        return enter(found.code, `the code from the message "${fence(found.mail.subject).slice(0, 120)}", which arrived at ${found.mail.at.toISOString().slice(11, 16)} UTC. The code itself stays with Fanfold`, found.mail);
      });
    },
  };
}

/** How long the mailbox is watched. Replaced in tests. */
export const waits: { timeoutMs?: number; intervalMs?: number } = {};
