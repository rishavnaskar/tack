/**
 * What a worker was set up to do, put where it takes effect.
 *
 * A worker's settings are a mandate, an autonomy level, caps and documents.
 * Saving them is not the same as honouring them. The words go to the agent as
 * a brief; the limits are enforced here in code, where no page and no model
 * can argue with them.
 */
import type { AgentAction } from '../agent/prompt.ts';
import type { Jobs } from '../jobs/jobs.ts';
import type { Profile } from '../jobs/profile.ts';
import type { SitePolicies } from '../jobs/site-policies.ts';
import type { Memory } from '../memory/memory.ts';
import type { ReviewHold } from '../policy/engine.ts';
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import type { Observation } from '../types.ts';
import type { WorkerDef } from './worker.ts';

/** Text this long in a field is an answer someone wrote, not a name or a number. */
const FREE_TEXT_LENGTH = 60;

export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

const list = (label: string, values: string[] | undefined): string | null =>
  (values?.length ? `${label}: ${values.join(', ')}` : null);

export function workerBrief(
  worker: WorkerDef,
  deps: { sites?: SitePolicies; memory?: Memory; remainingToday: number | null },
): string {
  const m = worker.mandate;
  const lines: string[] = ['YOUR MANDATE FOR THIS RUN'];

  const looking = [
    list('Roles', m.roles), list('Seniority', m.seniority), list('Locations', m.locations),
    list('Work arrangement', m.remote),
    m.salaryFloor ? `Salary floor: ${m.salaryFloor}. Skip a role that states a range below it.` : null,
    m.postingAgeDays ? `Only postings from the last ${m.postingAgeDays} day(s).` : null,
    list('Never apply to', m.exclusions),
  ].filter((l): l is string => l !== null);
  if (looking.length) lines.push(...looking);

  const sites = worker.sites.filter((s) => s.enabled);
  if (sites.length) {
    lines.push('Sites to use, and what is allowed on each:');
    for (const s of sites) {
      const policy = deps.sites?.get(s.site);
      const label = policy?.label ?? s.site;
      const mode = policy?.submit === 'prepare' ? 'fill the form, then leave Submit to the user and record it as prepared'
        : policy?.submit === 'never' ? 'look only; do not apply here'
        : s.dailyCap ? `apply, at most ${s.dailyCap} today` : 'apply';
      lines.push(`- ${label}: ${mode}`);
    }
    lines.push('Do not look for roles on any other site.');
  }

  if (deps.remainingToday !== null) {
    lines.push(deps.remainingToday > 0
      ? `You may submit at most ${deps.remainingToday} more application(s) today. After that, record further matches as found.`
      : 'The daily cap is already reached: submit nothing. Record matches as found.');
  }

  lines.push(worker.autonomy === 'review_all'
    ? 'Autonomy: review everything. Fill each application, record it as needs_review with every answer, and do not submit.'
    : worker.autonomy === 'auto_known'
      ? 'Autonomy: submit only when every answer comes from the profile or the saved answers. '
        + 'If a form needs an answer you would have to write yourself, record it as needs_review with your draft and do not submit.'
      : 'Autonomy: submit applications within the caps. Draft answers only from what the profile and documents say.');

  const resume = worker.documents.resumeId
    ? deps.memory?.uploadableDocument(worker.documents.resumeId) ?? null
    : null;
  if (resume) lines.push(`Résumé to attach: ${resume.title} (upload with value ${resume.id}).`);
  lines.push(worker.documents.coverLetterPolicy === 'always' ? 'Cover letter: include one on every application that accepts it.'
    : worker.documents.coverLetterPolicy === 'never' ? 'Cover letter: never include one. Leave an optional field empty; skip a role that requires one.'
    : 'Cover letter: only where the form requires one.');

  lines.push(
    'Work in two passes. First find the roles that fit and record each as found or skipped with the reason. '
    + 'Then apply to the ones that fit: with more than one, hand them out with delegate, one task per role, so they run side by side.',
    // A run's last message is not kept in the user's list of applications: what is not recorded is lost.
    'Every role you look at goes into the ledger with record_application before you finish, with its url: one that fits as found (or as what you did with it), '
    + 'one that does not as skipped with the reason. Naming a role only in your final message does not record it.',
    // A board search with every word of the mandate in it finds nothing; the postings say where they are.
    'Search a board with ats_jobs by one or two words of the role (such as "backend"), not by place or by every word of the mandate, '
    + 'then judge each posting\'s own location against the mandate.',
  );
  return lines.join('\n');
}

/** Free text sitting in the form that matches nothing the user has said. */
export function unapprovedFreeText(observation: Observation, profile: Profile | undefined): string | null {
  const known = new Set<string>();
  const normal = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (profile) {
    // The user's own words only: an agent's saved answer or a proposed fact is not something they said.
    for (const a of profile.userAnswers(500)) known.add(normal(a.answer));
    for (const f of profile.facts().filter((x) => x.usable)) known.add(normal(f.value));
  }
  for (const node of observation.nodes) {
    if (node.role !== 'textbox' || !node.value) continue;
    const value = unwrapUntrustedForDisplay(node.value);
    if (value.trim().length < FREE_TEXT_LENGTH) continue;
    if (!known.has(normal(value))) return value.trim();
  }
  return null;
}

/**
 * The checks a worker's settings add to a submission, beyond the site
 * catalog and the grant: the daily total, and under "known flows only" the
 * rule that free text waits for the user.
 */
export function reviewFor(
  worker: WorkerDef,
  deps: { jobs?: Jobs; profile?: Profile; now?: () => Date },
): (action: AgentAction, observation: Observation) => ReviewHold | null {
  return (_action, observation) => {
    const cap = worker.caps.dailyTotal;
    if (deps.jobs && cap > 0) {
      const used = deps.jobs.submittedSince(worker.id, startOfDay((deps.now ?? (() => new Date()))()));
      if (used >= cap) return { refuse: true, why: `daily cap reached: ${used}/${cap} applications today for ${worker.name}` };
    }
    if (worker.autonomy === 'auto_known') {
      const text = unapprovedFreeText(observation, deps.profile);
      if (text) {
        return {
          refuse: false,
          why: `this form carries an answer you have not approved ("${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"). `
            + `${worker.name} submits on its own only when every answer is one of yours.`,
        };
      }
    }
    return null;
  };
}
