/** What Fanfold has learned about a site, and a way to add to it. */
import { screenLesson } from '../../memory/screen.ts';
import { lessonFingerprint } from '../../memory/memory.ts';
import { replaySkill } from '../../agent/replay.ts';
import { RunGuard, RunHalt } from '../../agent/run-guard.ts';
import { hostOf } from '../../agent/actions.ts';
import { assertNavigable } from '../../policy/navigable.ts';
import type { Tool } from '../protocol.ts';
import { SESSION_ARG, sessionFor, siteBrief, snapshot, type FanfoldContext } from '../context.ts';

export function siteTools(ctx: FanfoldContext): Tool[] {
  const notes: Tool = {
    name: 'site_notes',
    title: 'What Fanfold knows about a site',
    description:
      'Notes from earlier sessions on a site: how its forms behave, what trips people up, its terms for automated applications, and flows that can be replayed. '
      + 'Read these before working on a site you have notes for.',
    inputSchema: {
      type: 'object', required: ['url'], additionalProperties: false,
      properties: { url: { type: 'string', maxLength: 4000, description: 'Any address on the site.' } },
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      if (!/^https?:\/\//i.test(String(args.url))) throw new Error('that is not a web address: notes are kept for http and https sites');
      return siteBrief(ctx, String(args.url), { notes: 60 }) || `Fanfold has no notes on ${hostOf(String(args.url))} yet.`;
    },
  };

  const learn: Tool = {
    name: 'site_learn',
    title: 'Remember something about a site',
    description:
      'Save one thing you worked out about how a site behaves, so the next session does not have to rediscover it: '
      + '"the location field only accepts a choice from its dropdown", "the Next button stays disabled until the résumé finishes uploading". '
      + 'One fact per note, about the site itself. Notes cannot change what needs the user\'s approval. '
      + 'Each site\'s notes are also kept as a file the user can read and edit.',
    inputSchema: {
      type: 'object', required: ['url', 'when', 'note'], additionalProperties: false,
      properties: {
        url: { type: 'string', maxLength: 4000, description: 'An address on the site the note is about.' },
        when: { type: 'string', minLength: 3, maxLength: 200, description: 'The situation it applies to, e.g. "filling the application form".' },
        note: { type: 'string', minLength: 10, maxLength: 400, description: 'What is true about the site, and what to do about it.' },
      },
    },
    run: async (args) => {
      const host = hostOf(String(args.url));
      if (host === '*' || !/^https?:\/\//i.test(String(args.url))) throw new Error('that is not a web address');
      const when = String(args.when).trim();
      const note = String(args.note).trim();
      const screen = screenLesson(`${when} ${note}`);
      if (!screen.promoted) {
        throw new Error('not saved: a note describes how a site behaves. It cannot say anything about approvals, safeguards, sign-in details or bot checks, '
          + 'give orders to the agents that read it, nor tell an agent to read a code from the user\'s mail: browser_code does that.');
      }
      ctx.app.memory.knowledge?.sync(host);
      const known = ctx.app.memory.lessonWithFingerprint(lessonFingerprint(host, '*', when, note));
      if (known?.retired || known?.status === 'rejected') return `not saved: the same note about ${host} was removed or rejected before.`;
      if (known) return `already known about ${host}`;
      ctx.app.memory.addLesson({ domain: host, taskType: '*', trigger: when, lesson: note, confidence: 0.5 });
      return `saved for ${host}. It will be shown, marked unverified, to later sessions on that site.`;
    },
  };

  const run: Tool = {
    name: 'skill_run',
    title: 'Replay a known flow',
    description:
      'Run a flow Fanfold has already learned on a site, step by step, without choosing each action yourself. '
      + 'The flows available on a site are listed in its notes. Stops where a step needs the user.',
    inputSchema: {
      type: 'object', required: ['skill'], additionalProperties: false,
      properties: {
        skill: { type: 'string', maxLength: 200, description: 'The flow id from the site notes.' },
        params: { type: 'object', properties: {}, description: 'Values for the parameters the flow needs, by name.' },
        session: SESSION_ARG,
      },
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    run: async (args, call) => {
      const skill = ctx.app.memory.getSkill(String(args.skill));
      if (!skill || skill.status !== 'active') throw new Error(`no active flow with id ${JSON.stringify(args.skill)}`);
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries((args.params ?? {}) as Record<string, unknown>)) params[k] = String(v);
      const session = await sessionFor(ctx, args, call);
      return ctx.sessions.exclusive(session, async () => {
        // Each page the flow goes to is held to the sites' pace and pauses, like any other.
        const guard = new RunGuard({ sites: ctx.app.sites, log: ctx.log });
        const replayed = await replaySkill({ skill, params, page: guard.wrap(session.page), memory: ctx.app.memory, policy: ctx.app.policy(null) })
          .catch((err: unknown) => {
            if (!(err instanceof RunHalt)) throw err;
            return { ok: false, stepsRun: 0, ms: 0, failure: { index: -1, reason: err.message } } as Awaited<ReturnType<typeof replaySkill>>;
          });
        const halt = guard.halted();
        const result = halt && replayed.ok ? { ...replayed, ok: false, failure: { index: replayed.stepsRun - 1, reason: halt } } : replayed;
        ctx.app.store.recordStep({
          runId: session.runId, idx: session.step++, action: JSON.stringify({ kind: 'skill', value: skill.id }),
          sensitivity: 'WRITE_SELF', allowed: true, outcome: result.ok ? 'ok' : 'failed',
          failure: result.failure?.reason ?? result.needsApproval?.why, actMs: result.ms,
        });
        const page = await snapshot(ctx, session);
        if (result.ok) return `ran ${skill.id}: ${result.stepsRun} step(s) in ${result.ms}ms.\n${page}`;
        if (result.needsApproval) {
          return `${skill.id} stopped at step ${result.needsApproval.index + 1}, which needs the user: ${result.needsApproval.why}\n`
            + `Carry on from here with browser_act; that step will ask them.\n${page}`;
        }
        const index = result.failure?.index ?? 0;
        const where = index < 0 ? 'could not start' : `failed at step ${index + 1}`;
        return {
          isError: true,
          text: `${skill.id} ${where}: ${result.failure?.reason ?? 'unknown'}. Carry on by hand from here.\n${page}`,
        };
      });
    },
  };

  const teachStart: Tool = {
    name: 'teach_start',
    title: 'Let the user show how something is done',
    description:
      'Open a tab for the user and watch what they do in it, so the same steps can be repeated later. '
      + 'Use it when the user says they will show you, or when a site needs a routine only they know. '
      + 'Tell the user to do the task in the Fanfold tab, then call teach_stop. Passwords are never recorded.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { url: { type: 'string', maxLength: 2000, description: 'Where the user should start.' } },
    },
    run: async (args) => {
      const url = typeof args.url === 'string' && args.url ? args.url : undefined;
      if (url) assertNavigable(url);
      if (ctx.app.headless) throw new Error('Fanfold has no visible window, so nobody can show it a task. Open it with a window (without --headless) to teach it one.');
      await ctx.app.teaching.start({ url });
      return 'Watching. A tab is open and in front for the user: ask them to do the task there, start to finish, then call teach_stop with a name for it.';
    },
  };

  const teachStop: Tool = {
    name: 'teach_stop',
    title: 'Save what the user showed',
    description:
      'Stop watching and save what the user did as a flow for that site, under the name given. '
      + 'What they typed becomes blanks to fill in next time. Run it later with skill_run.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 80, description: 'A short name for the flow, e.g. "search roles".' },
        discard: { type: 'boolean', description: 'Throw away what was seen instead of saving it.' },
      },
    },
    run: async (args) => {
      const outcome = await ctx.app.teaching.stop({ save: args.discard !== true, name: typeof args.name === 'string' ? args.name : undefined });
      if (!outcome.saved) return { isError: outcome.why !== 'discarded', text: outcome.why === 'discarded' ? 'Discarded.' : `Not saved: ${outcome.why}` };
      return [
        `Saved as ${outcome.skillId}: ${outcome.steps} step(s) on ${outcome.domain}.`,
        outcome.params.length ? `It needs: ${outcome.params.join(', ')}.` : 'It needs no values.',
        ...outcome.notes,
        'Run it with skill_run.',
      ].join('\n');
    },
  };

  return [notes, learn, run, teachStart, teachStop];
}
