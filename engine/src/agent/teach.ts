/**
 * Teaching by showing.
 *
 * The user does a task once in the browser while Fanfold watches. What they
 * did becomes a flow: the same steps, named by what each was done to, with
 * the things they typed turned into blanks to be filled in next time. The
 * flow is then replayed the way every learned flow is: step by step, with
 * each action still judged by the policy engine and a check at the end that
 * it arrived where the user did.
 *
 * A flow the user demonstrated is put to use at once. Their own
 * demonstration is the evidence that it works, and a flow that stops working
 * is set aside by the same rule as any other.
 */
import { validateSkill } from '../eval/gate.ts';
import type { Memory, SkillStep } from '../memory/memory.ts';
import type { RecordedEvent } from '../observe/recorder.ts';
import type { Tab } from '../observe/runtime.ts';
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { hostOf } from './actions.ts';

export interface CompiledFlow {
  domain: string;
  steps: SkillStep[];
  /** The blanks, in the order they were filled. */
  params: string[];
  /** What each blank held when it was demonstrated. */
  examples: Record<string, string>;
  /** Things the user did that a flow cannot carry, in words. */
  notes: string[];
}

const slug = (name: string): string =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'value';

/** A page load this soon after a click or Enter was caused by it, not typed into the address bar. */
const CAUSED_WITHIN_MS = 4_000;

/** Turn what was watched into steps. Pure: the same events give the same flow. */
export function compileFlow(events: RecordedEvent[], final: { url: string; heading?: string | null }): CompiledFlow {
  const steps: SkillStep[] = [];
  const params: string[] = [];
  const examples: Record<string, string> = {};
  const notes: string[] = [];
  const paramFor = new Map<string, string>();
  let domain = '';
  let lastTrigger = -Infinity;

  for (const event of events) {
    if (event.kind === 'loaded') {
      if (!/^https?:/.test(event.url)) continue;
      if (!steps.length) {
        domain = hostOf(event.url);
        steps.push({ act: 'goto', url: event.url });
      } else if (event.t - lastTrigger > CAUSED_WITHIN_MS) {
        steps.push({ act: 'goto', url: event.url });
      }
      continue;
    }
    if (!steps.length) continue;

    if (event.kind === 'secret') {
      if (notes.some((n) => n.startsWith(`"${event.name}" is a password field`))) continue;
      notes.push(`"${event.name}" is a password field. Fanfold does not record or replay passwords: sign in yourself before running this flow.`);
      continue;
    }
    if (event.kind === 'upload') {
      notes.push(`A file was attached to "${event.name}". A flow does not carry files: the agent attaches one of your imported files when it runs.`);
      continue;
    }
    if (event.kind === 'press') {
      steps.push({ act: 'press', key: event.key });
      lastTrigger = event.t;
      continue;
    }

    const target = { role: event.role, name: event.name };
    const previous = steps[steps.length - 1];
    const sameTarget = previous.target?.role === target.role && previous.target?.name === target.name;

    if (event.kind === 'fill') {
      const key = `${target.role}|${target.name}`;
      let param = paramFor.get(key);
      if (!param) {
        param = slug(target.name);
        for (let n = 2; params.includes(param); n++) param = `${slug(target.name)}_${n}`;
        paramFor.set(key, param);
        params.push(param);
      }
      examples[param] = event.value;
      // Typing, then pressing Enter, reports the same field twice. It is one step.
      if (sameTarget && previous.act === 'fill') continue;
      steps.push({ act: 'fill', target, value: `{{${param}}}` });
      continue;
    }
    if (event.kind === 'select') {
      if (sameTarget && previous.act === 'select') previous.value = event.value;
      else steps.push({ act: 'select', target, value: event.value });
      continue;
    }
    // A box ticked and unticked again is back where it started.
    if ((event.kind === 'check' || event.kind === 'uncheck') && sameTarget
      && (previous.act === 'check' || previous.act === 'uncheck')) {
      steps.pop();
      if (previous.act === event.kind) steps.push({ act: event.kind, target });
      continue;
    }
    steps.push({ act: event.kind, target });
    if (event.kind === 'click') lastTrigger = event.t;
  }

  if (steps.length) {
    // Where the user ended up is what a replay must reach: the same page,
    // and its heading when it had one.
    let pattern = final.url;
    try {
      const u = new URL(final.url);
      pattern = `${u.origin}${u.pathname}*`;
    } catch { /* kept as given */ }
    // A heading that repeats what was typed would only match this one demonstration.
    const typed = Object.values(examples).filter((v) => v.trim().length >= 3).map((v) => v.toLowerCase());
    const heading = final.heading && !typed.some((v) => final.heading!.toLowerCase().includes(v)) ? final.heading : null;
    const checkpoint = heading
      ? { role: 'heading', name: heading, urlPattern: pattern }
      : { role: 'heading', minCount: 0, urlPattern: pattern };
    steps[steps.length - 1] = { ...steps[steps.length - 1], checkpoint };
  }
  return { domain, steps, params, examples, notes };
}

export interface TeachingStatus {
  active: boolean;
  startedAt: string | null;
  url: string | null;
  /** What has been seen so far, as the steps it would become. */
  steps: SkillStep[];
  notes: string[];
}

export type TeachOutcome =
  | { saved: false; why: string }
  | { saved: true; skillId: string; domain: string; steps: number; params: string[]; notes: string[] };

export interface TeachingDeps {
  /** A tab for the user to work in, brought to the front. */
  openTab(): Promise<Tab>;
  memory: Memory;
  emit(event: { type: string; [key: string]: unknown }): void;
}

export class Teaching {
  readonly #deps: TeachingDeps;
  #session: { tab: Tab; stop(): Promise<void>; events: RecordedEvent[]; startedAt: string; url: string | null } | null = null;

  constructor(deps: TeachingDeps) {
    this.#deps = deps;
  }

  status(): TeachingStatus {
    const s = this.#session;
    if (!s) return { active: false, startedAt: null, url: null, steps: [], notes: [] };
    const flow = compileFlow(s.events, { url: s.url ?? '' });
    return { active: true, startedAt: s.startedAt, url: s.url, steps: flow.steps, notes: flow.notes };
  }

  /** Open a tab for the user and start watching it. */
  async start(opts: { url?: string } = {}): Promise<TeachingStatus> {
    if (this.#session) throw new Error('a flow is already being taught; save or discard it first');
    const tab = await this.#deps.openTab();
    if (!tab.page.record) {
      await tab.close().catch(() => {});
      throw new Error('this browser cannot be watched');
    }
    const events: RecordedEvent[] = [];
    const session = { tab, events, startedAt: new Date().toISOString(), url: null as string | null, stop: async () => {} };
    try {
      session.stop = await tab.page.record((event) => {
        events.push(event);
        if (event.kind === 'loaded') session.url = event.url;
        this.#deps.emit({ type: 'teach_step', steps: this.status().steps.length });
      });
      if (opts.url) await tab.page.goto(opts.url);
      await tab.page.focus?.();
    } catch (err) {
      await session.stop().catch(() => {});
      await tab.close().catch(() => {});
      throw err;
    }
    this.#session = session;
    this.#deps.emit({ type: 'teach_changed', active: true });
    return this.status();
  }

  /** Stop watching. With a name, what was seen is saved as a flow for the site it was on. */
  async stop(opts: { save: boolean; name?: string }): Promise<TeachOutcome> {
    const session = this.#session;
    if (!session) return { saved: false, why: 'nothing is being taught' };
    this.#session = null;
    const final: { url: string; heading: string | null } = { url: session.url ?? '', heading: null };
    try {
      const observation = await session.tab.page.observe();
      final.url = observation.url;
      const heading = observation.nodes.find((n) => n.role === 'heading' && n.name);
      final.heading = heading?.name ? unwrapUntrustedForDisplay(heading.name).slice(0, 80) : null;
    } catch { /* the tab was closed by hand; the last address seen stands */ }
    await session.stop().catch(() => {});
    await session.tab.close().catch(() => {});
    this.#deps.emit({ type: 'teach_changed', active: false });

    if (!opts.save) return { saved: false, why: 'discarded' };
    const flow = compileFlow(session.events, final);
    if (flow.steps.length < 2) return { saved: false, why: 'nothing was done on the page, so there is no flow to save' };
    const intent = slug(opts.name ?? '');
    if (!opts.name?.trim() || intent === 'value') return { saved: false, why: 'a flow needs a name' };

    const skillId = this.#deps.memory.proposeSkill({
      domain: flow.domain, intent, params: flow.params, steps: flow.steps, inducedFrom: 'demonstration',
    });
    const check = validateSkill(this.#deps.memory.getSkill(skillId)!);
    if (!check.promoted) {
      this.#deps.memory.setSkillStatus(skillId, 'retired');
      return { saved: false, why: check.why };
    }
    this.#deps.memory.setSkillStatus(skillId, 'active', { evalPassed: true });
    return { saved: true, skillId, domain: flow.domain, steps: flow.steps.length, params: flow.params, notes: flow.notes };
  }

  async close(): Promise<void> {
    if (this.#session) await this.stop({ save: false });
  }
}
