import type { GapMap, GapSkill, Goal, Plan, PlanTask, PlanWeek, Profile } from './types.ts';

export type Raise = Record<string, { level: number; evidence: string }>;

export type Ask = <T>(opts: { task: string; system: string; prompt: string; schema: object; tier?: 'fast' | 'smart' }) => Promise<T>;
export type Prereqs = Record<string, string[]>;
// each skill's `have` when the plan was built
export type StartLevels = Record<string, number>;

const DAY = 86_400_000;
const MAX_SKILLS = 10;

export const half = (n: number) => Math.round(n * 2) / 2;
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function addDays(date: string, n: number): string {
  const d = new Date(date.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10) + 'T00:00:00Z') - Date.parse(a.slice(0, 10) + 'T00:00:00Z')) / DAY);
}

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function mondayOf(date: string): string {
  const dow = new Date(date.slice(0, 10) + 'T00:00:00Z').getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

// 1-based week containing `today`, unclamped: 0 before the start, > weeks after the end
export function weekOf(plan: Plan, today: string): number {
  if (!plan.weeks.length) return 0;
  const d = daysBetween(plan.weeks[0].startDate, today);
  return d < 0 ? 0 : Math.floor(d / 7) + 1;
}

export function currentWeek(plan: Plan, today: string): number {
  return clamp(weekOf(plan, today), 1, Math.max(1, plan.weeks.length));
}

export function allTasks(plan: Plan): PlanTask[] {
  return plan.weeks.flatMap((w) => w.tasks);
}

export function findTask(plan: Plan, id: string): { week: PlanWeek; task: PlanTask } | undefined {
  for (const week of plan.weeks) {
    const task = week.tasks.find((t) => t.id === id);
    if (task) return { week, task };
  }
}

export function wantHours(s: GapSkill): number {
  const gap = Math.max(0, s.need - s.have);
  return clamp(half(2 + gap * 3 * (0.7 + 0.6 * (s.mustShare || 0))), 3, 14);
}

// Highest priority first, but never before a prerequisite that is also in the plan. A
// prerequisite is as urgent as the most urgent skill waiting on it.
export function orderSkills(skills: GapSkill[], prereqs: Prereqs = {}): GapSkill[] {
  const eff = new Map(skills.map((s) => [s.id, s.priority]));
  for (let pass = 0; pass < skills.length; pass++) {
    let changed = false;
    for (const s of skills) for (const p of prereqs[s.id] ?? []) {
      if (eff.has(p) && eff.get(p)! < eff.get(s.id)!) { eff.set(p, eff.get(s.id)!); changed = true; }
    }
    if (!changed) break;
  }
  const pending = [...skills].sort((a, b) => eff.get(b.id)! - eff.get(a.id)! || b.priority - a.priority || a.id.localeCompare(b.id));
  const inPlan = new Set(pending.map((s) => s.id));
  const placed = new Set<string>();
  const out: GapSkill[] = [];
  while (pending.length) {
    let i = pending.findIndex((s) => (prereqs[s.id] ?? []).every((p) => !inPlan.has(p) || placed.has(p)));
    if (i < 0) i = 0;
    const [s] = pending.splice(i, 1);
    placed.add(s.id);
    out.push(s);
  }
  return out;
}

export interface Reserved { kind: 'project' | 'interview' | 'apply'; hours: number; project?: number }

// Fixed weekly blocks: portfolio projects, interview practice and application batches.
export function reservedFor(weeks: number, hpw: number): Reserved[][] {
  const out: Reserved[][] = Array.from({ length: weeks }, () => []);
  const ih = half(clamp(hpw * 0.15, 1, 2));
  const ah = half(clamp(hpw * 0.1, 0.5, 2));
  const ph = half(clamp(hpw * 0.3, 1, 4));
  const span = weeks >= 8 ? 2 : 1;
  [0.25, 0.5, 0.75].forEach((f, p) => {
    const s = clamp(Math.round(weeks * f), 1, weeks);
    for (let w = s; w < s + span && w <= weeks; w++) out[w - 1].push({ kind: 'project', hours: ph, project: p + 1 });
  });
  const interviewStart = weeks >= 4 ? Math.max(2, Math.round(weeks / 3)) : weeks;
  const applyStart = clamp(Math.round(weeks / 2), 1, weeks);
  for (let w = 1; w <= weeks; w++) {
    if (w >= interviewStart) out[w - 1].push({ kind: 'interview', hours: ih });
    if (w >= applyStart) out[w - 1].push({ kind: 'apply', hours: w >= weeks - 1 ? half(ah * 2) : ah });
  }
  // learning keeps at least 40% of every week
  for (const list of out) {
    const total = list.reduce((a, r) => a + r.hours, 0);
    if (total > hpw * 0.6) {
      const f = (hpw * 0.6) / total;
      for (const r of list) r.hours = Math.max(0.5, half(r.hours * f));
    }
  }
  return out;
}

function splitHours(h: number): number[] {
  const parts = Math.ceil(h / 3 - 1e-9);
  if (parts <= 1) return [h];
  const each = half(h / parts);
  const out = Array(parts - 1).fill(each);
  out.push(round1(h - each * (parts - 1)));
  return out;
}

function namesOf(ids: string[], byId: Map<string, GapSkill>): string[] {
  return ids.map((id) => byId.get(id)?.name ?? id);
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/** "an AI Product Manager", "a Product Manager": by sound, so acronyms go by their first letter. */
export function withArticle(noun: string): string {
  const w = noun.trim();
  const first = w.split(/\s+/)[0] ?? '';
  const acronym = first.length > 1 && /^[A-Z]+$/.test(first);
  const vowel = acronym ? /^[AEFHILMNORSX]/.test(first) : /^[aeiou]/i.test(w) && !/^(uni|use|usu|eu|one)/i.test(w);
  return `${vowel ? 'an' : 'a'} ${w}`;
}

const LEARN = [
  (n: string) => `Study ${n}: core ideas, vocabulary and how product teams use it`,
  (n: string) => `Work through two real case studies of ${n} and note what decided the outcome`,
  (n: string) => `Go deeper on ${n}: the trade-offs and the common mistakes`,
];
const PRACTICE = [
  (n: string) => `Apply ${n} to a product you use and write a one-page note`,
  (n: string) => `Redo a past engineering decision through the lens of ${n} and share it for feedback`,
  (n: string) => `Practise ${n} on a small dataset or spec and time-box the write-up`,
];

export function fallbackTitle(t: PlanTask, byId: Map<string, GapSkill>, part = 0, project = 0): string {
  const names = joinNames(namesOf(t.skillIds, byId));
  switch (t.kind) {
    case 'learn': return LEARN[part % LEARN.length](names);
    case 'practice': return PRACTICE[part % PRACTICE.length](names);
    case 'project': return `${project ? `Portfolio project ${project}` : 'Portfolio project'}: build the ${names || 'next'} part and write it up`;
    case 'interview': return names ? `Mock interview on ${names}, then rewrite your weakest answer` : 'Mock interview, then rewrite your weakest answer';
    case 'apply': return t.hours >= 2 ? 'Send five tailored applications to high-fit postings' : 'Send three tailored applications to high-fit postings';
  }
}

export function searchResource(query: string): NonNullable<PlanTask['resource']> {
  return { title: `Search: ${query}`, url: 'https://www.google.com/search?q=' + encodeURIComponent(query), verified: false };
}

function fallbackCheckpoint(w: PlanWeek, byId: Map<string, GapSkill>): PlanWeek['checkpoint'] {
  const names = joinNames(namesOf(w.skillIds, byId));
  const hasProject = w.tasks.some((t) => t.kind === 'project');
  const description = names
    ? `Explain ${names} in five minutes without notes, and show one artefact from this week${hasProject ? ' plus the project milestone' : ''}.`
    : hasProject ? 'Show the project milestone to someone who has not seen it and get one piece of feedback.'
    : 'Finish the interview and application tasks and log what you learned.';
  return { title: `Week ${w.index} checkpoint`, description };
}

function fallbackTheme(w: PlanWeek, byId: Map<string, GapSkill>): string {
  const names = namesOf(w.skillIds, byId);
  if (names.length) return joinNames(names.slice(0, 2));
  if (w.tasks.some((t) => t.kind === 'project')) return 'Portfolio build';
  return 'Interview practice and applications';
}

export interface BuildInput { gap: GapMap; goal: Goal; prereqs?: Prereqs; now?: string; startDate?: string }

// Deterministic allocation: code owns ids, hours and dates; wording is filled in later.
export function buildPlan(input: BuildInput): Plan {
  const { gap, goal } = input;
  const W = Math.max(1, Math.round(goal.weeks || 12));
  const H = Math.max(1, goal.hoursPerWeek || 10);
  const start = (input.startDate || goal.startDate || new Date().toISOString()).slice(0, 10);
  const byId = new Map(gap.skills.map((s) => [s.id, s]));
  const reserved = reservedFor(W, H);
  const cap = reserved.map((r) => H - r.reduce((a, x) => a + x.hours, 0));
  const totalCap = cap.reduce((a, b) => a + b, 0);

  let picked = gap.skills
    .filter((s) => s.status !== 'closed' && s.have < s.need)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, MAX_SKILLS);
  const want = new Map(picked.map((s) => [s.id, wantHours(s)]));
  const sumWant = [...want.values()].reduce((a, b) => a + b, 0) || 1;
  const factor = clamp(totalCap / sumWant, 0.5, 1.5);
  const hours = new Map(picked.map((s) => [s.id, Math.max(2, half(want.get(s.id)! * factor))]));
  const sum = () => picked.reduce((a, s) => a + hours.get(s.id)!, 0);
  while (sum() > totalCap && picked.length > 2) picked = picked.slice(0, -1);
  const ordered = orderSkills(picked, input.prereqs);

  // pour each skill's hours into weeks in order: learn first, then practice
  type Chunk = { week: number; skillId: string; kind: 'learn' | 'practice'; hours: number };
  const chunks: Chunk[] = [];
  const left = [...cap];
  let w = 0;
  for (const s of ordered) {
    const h = hours.get(s.id)!;
    const learnH = Math.max(0.5, half(h * 0.6));
    for (const [kind, amount0] of [['learn', learnH], ['practice', h - learnH]] as const) {
      let amount = amount0;
      while (amount > 0.01 && w < W) {
        if (left[w] < 0.5) { w++; continue; }
        const take = Math.min(amount, half(left[w]) || left[w]);
        const last = chunks[chunks.length - 1];
        if (last && last.week === w + 1 && last.skillId === s.id && last.kind === kind) last.hours += take;
        else chunks.push({ week: w + 1, skillId: s.id, kind, hours: take });
        left[w] -= take;
        amount = round1(amount - take);
      }
    }
  }

  const weeks: PlanWeek[] = [];
  const usedByProjects = new Set<string>();
  const projectSkillIds = new Map<number, string[]>();
  const partCount = new Map<string, number>();
  for (let i = 1; i <= W; i++) {
    const tasks: PlanTask[] = [];
    let n = 0;
    const add = (t: Omit<PlanTask, 'id' | 'status' | 'title'>, title = '') => {
      const task: PlanTask = { id: `w${i}-${++n}`, title, status: 'todo', ...t };
      tasks.push(task);
      return task;
    };
    for (const c of chunks.filter((c) => c.week === i)) {
      for (const h of splitHours(round1(c.hours))) {
        const key = c.skillId + c.kind;
        const part = partCount.get(key) ?? 0;
        partCount.set(key, part + 1);
        const t = add({ kind: c.kind, skillIds: [c.skillId], hours: h });
        t.title = fallbackTitle(t, byId, part);
        if (c.kind === 'learn') t.resource = searchResource(`${byId.get(c.skillId)?.name ?? c.skillId} for product managers`);
      }
    }
    for (const r of reserved[i - 1]) {
      let skillIds: string[] = [];
      if (r.kind === 'project') {
        skillIds = projectSkillIds.get(r.project!) ?? projectSkills(chunks, i + 1, ordered, usedByProjects);
        projectSkillIds.set(r.project!, skillIds);
      } else if (r.kind === 'interview') {
        skillIds = [...new Set(chunks.filter((c) => c.week <= i).map((c) => c.skillId))].slice(-2);
      }
      const t = add({ kind: r.kind, skillIds, hours: r.hours });
      t.title = fallbackTitle(t, byId, 0, r.project);
    }
    // spare capacity goes to review of what was just learned
    const spare = half(H - tasks.reduce((a, t) => a + t.hours, 0));
    if (spare >= 1 && chunks.length) {
      const recent = [...new Set(chunks.filter((c) => c.week <= i).map((c) => c.skillId))].slice(-2);
      if (recent.length) {
        const t = add({ kind: 'practice', skillIds: recent, hours: spare });
        t.id = `w${i}-review`;
        t.title = `Review ${joinNames(namesOf(recent, byId))}: redo the hardest exercise from memory`;
      }
    }
    const week: PlanWeek = {
      index: i,
      startDate: addDays(start, (i - 1) * 7),
      theme: '',
      skillIds: [...new Set(tasks.filter((t) => t.kind === 'learn' || t.kind === 'practice').flatMap((t) => t.skillIds))],
      hours: round1(tasks.reduce((a, t) => a + t.hours, 0)),
      tasks,
      checkpoint: { title: '', description: '' },
    };
    week.theme = fallbackTheme(week, byId);
    week.checkpoint = fallbackCheckpoint(week, byId);
    weeks.push(week);
  }
  return { version: 1, createdAt: input.now ?? new Date().toISOString(), weeks, changes: [] };
}

function projectSkills(chunks: { week: number; skillId: string }[], week: number, ordered: GapSkill[], used: Set<string>): string[] {
  const pri = new Map(ordered.map((s) => [s.id, s.priority]));
  const lastWeek = new Map<string, number>();
  for (const c of chunks) if (c.week <= week) lastWeek.set(c.skillId, Math.max(lastWeek.get(c.skillId) ?? 0, c.week));
  let cands = [...lastWeek.keys()].sort((a, b) => lastWeek.get(b)! - lastWeek.get(a)! || pri.get(b)! - pri.get(a)!);
  if (cands.length < 2) cands = [...new Set([...cands, ...ordered.map((s) => s.id)])];
  const fresh = cands.filter((id) => !used.has(id));
  const pick = [...fresh.slice(0, 3)];
  for (const id of cands) if (pick.length < 2 && !pick.includes(id)) pick.push(id);
  for (const id of pick) used.add(id);
  return pick;
}

// ---- wording -------------------------------------------------------------

interface Wording {
  weeks: { index: number; theme: string; checkpointTitle: string; checkpointDescription: string;
    tasks: { id: string; title: string; resourceQuery?: string; resourceUrl?: string }[] }[];
}

const WORDING_SCHEMA = {
  type: 'object',
  properties: {
    weeks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          theme: { type: 'string' },
          checkpointTitle: { type: 'string' },
          checkpointDescription: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                resourceQuery: { type: 'string' },
                resourceUrl: { type: 'string' },
              },
              required: ['id', 'title'],
            },
          },
        },
        required: ['index', 'theme', 'checkpointTitle', 'checkpointDescription', 'tasks'],
      },
    },
  },
  required: ['weeks'],
};

const WORDING_SYSTEM = `You write week-by-week plans for people changing careers.
You receive a fixed plan skeleton. Never change ids, hours, weeks or skills; only write words.
- Task titles: one concrete action under 100 characters, starting with a verb, naming the skill, sized to the hours given.
- Learn tasks: also give resourceQuery, a short search phrase for a free, well-known resource on exactly that topic. Give resourceUrl only for a page you are certain exists.
- Project tasks: the step of a portfolio project that a hiring manager for the target role would want to see.
- Interview tasks: a mock interview focused on the listed skills. Apply tasks: a batch of tailored applications.
- Theme: 2 to 6 words. Checkpoint: an observable test the person can clearly pass or fail at the end of the week.
Plain language, no hype, no emojis.`;

export async function wordPlan(
  plan: Plan,
  ctx: { gap: GapMap; goal: Goal; profile?: Profile; verify?: (url: string) => Promise<boolean> },
  ask: Ask | null,
): Promise<{ plan: Plan; worded: boolean; error?: string }> {
  if (!ask) return { plan, worded: false };
  const byId = new Map(ctx.gap.skills.map((s) => [s.id, s]));
  const skeleton = plan.weeks.map((w) => ({
    index: w.index,
    skills: namesOf(w.skillIds, byId),
    tasks: w.tasks.map((t) => ({ id: t.id, kind: t.kind, hours: t.hours, skills: namesOf(t.skillIds, byId) })),
  }));
  const p = ctx.profile;
  const prompt = [
    `Target role: ${ctx.goal.targetRole} in ${ctx.goal.location}${ctx.goal.remote ? ' (remote ok)' : ''}.`,
    p ? `Person: ${p.currentRole}, ${p.yearsExperience} years. ${p.summary}` : '',
    `Budget: ${ctx.goal.hoursPerWeek} hours a week for ${plan.weeks.length} weeks.`,
    'Skeleton:',
    JSON.stringify(skeleton),
  ].filter(Boolean).join('\n');
  try {
    const out = await ask<Wording>({ task: 'plan.wording', system: WORDING_SYSTEM, prompt, schema: WORDING_SCHEMA, tier: 'smart' });
    const next = structuredClone(plan);
    let verifiedBudget = 8;
    const checks: { task: PlanTask; url: string; title: string }[] = [];
    for (const ww of out?.weeks ?? []) {
      const week = next.weeks.find((w) => w.index === ww.index);
      if (!week) continue;
      if (clean(ww.theme, 60)) week.theme = clean(ww.theme, 60)!;
      if (clean(ww.checkpointTitle, 90)) week.checkpoint.title = clean(ww.checkpointTitle, 90)!;
      if (clean(ww.checkpointDescription, 400)) week.checkpoint.description = clean(ww.checkpointDescription, 400)!;
      for (const wt of ww.tasks ?? []) {
        const task = week.tasks.find((t) => t.id === wt.id);
        if (!task) continue;
        const title = clean(wt.title, 140);
        if (title) task.title = title;
        if (task.kind !== 'learn') continue;
        const query = clean(wt.resourceQuery, 120);
        if (query) task.resource = searchResource(query);
        if (wt.resourceUrl && /^https:\/\//.test(wt.resourceUrl) && ctx.verify && verifiedBudget-- > 0) {
          checks.push({ task, url: wt.resourceUrl, title: query || task.title });
        }
      }
    }
    // Link checks run side by side; one at a time they could hold the plan for a minute.
    await Promise.all(checks.map(async (c) => {
      if (await ctx.verify!(c.url).catch(() => false)) c.task.resource = { title: c.title, url: c.url, verified: true };
    }));
    return { plan: next, worded: true };
  } catch (e) {
    return { plan, worded: false, error: (e as Error).message };
  }
}

function clean(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// ---- task and checkpoint updates ----------------------------------------

export function setTaskStatus(plan: Plan, id: string, status: PlanTask['status'], at: string): Plan | undefined {
  const next = structuredClone(plan);
  const hit = findTask(next, id);
  if (!hit) return;
  const was = hit.task.status;
  hit.task.status = status;
  if (status === 'done') hit.task.doneAt = was === 'done' && hit.task.doneAt ? hit.task.doneAt : at;
  else delete hit.task.doneAt;
  return next;
}

export function setCheckpoint(plan: Plan, week: number, passed: boolean | undefined): Plan | undefined {
  const next = structuredClone(plan);
  const w = next.weeks.find((x) => x.index === week);
  if (!w) return;
  if (passed === undefined) delete w.checkpoint.passed;
  else w.checkpoint.passed = passed;
  return next;
}

export function startLevels(gap: GapMap): StartLevels {
  const out: StartLevels = {};
  for (const s of gap.skills) out[s.id] = s.have;
  return out;
}

export interface SkillProgress { total: number; done: number; credited: number; lastWeek: number }

// Learn and practice hours per skill; `credited` only counts weeks whose checkpoint passed.
export function skillProgress(plan: Plan): Map<string, SkillProgress> {
  const out = new Map<string, SkillProgress>();
  for (const w of plan.weeks) for (const t of w.tasks) {
    if ((t.kind !== 'learn' && t.kind !== 'practice') || t.status === 'skipped') continue;
    for (const id of t.skillIds) {
      const p = out.get(id) ?? { total: 0, done: 0, credited: 0, lastWeek: 0 };
      p.total += t.hours;
      if (t.status === 'done') {
        p.done += t.hours;
        if (w.checkpoint.passed === true) p.credited += t.hours;
      }
      p.lastWeek = Math.max(p.lastWeek, w.index);
      out.set(id, p);
    }
  }
  return out;
}

export interface SkillMoves {
  status: Record<string, 'open' | 'learning'>;
  raise: Record<string, { level: number; evidence: string }>;
}

// Ticking tasks moves a skill between open and learning. Passed checkpoints raise `have`
// pro rata toward `need`; all tasks done with the last checkpoint passed reaches `need`,
// which closes the skill. Raises only go up: un-ticking a task does not lower a level.
export function skillMoves(gap: GapMap, plan: Plan, start: StartLevels): SkillMoves {
  const prog = skillProgress(plan);
  const out: SkillMoves = { status: {}, raise: {} };
  for (const s of gap.skills) {
    const p = prog.get(s.id);
    if (!p || p.total <= 0) continue;
    if (s.status !== 'closed') {
      const want = p.done > 0 ? 'learning' : 'open';
      if (want !== s.status) out.status[s.id] = want;
    }
    const last = plan.weeks.find((w) => w.index === p.lastWeek);
    const complete = p.done >= p.total - 1e-9 && last?.checkpoint.passed === true;
    const from = Math.min(start[s.id] ?? s.have, s.have);
    const target = complete ? s.need : from + Math.round(Math.max(0, s.need - from) * (p.credited / p.total) * 0.8);
    const level = clamp(Math.round(target), 0, 5);
    if (level > s.have) {
      out.raise[s.id] = {
        level,
        evidence: complete
          ? `Completed the ${s.name} work in the Tack plan and passed the week ${p.lastWeek} checkpoint`
          : `Working through ${s.name} in the Tack plan, with checkpoints passed`,
      };
    }
  }
  return out;
}

// Same rule as gap.raiseHave, applied to a copy: levels only go up, and when the evidence
// list is full the first four (résumé) quotes are kept.
export function withRaises(profile: Profile, raise: Raise, names: Map<string, string> = new Map(), idOf: (name: string) => string = (n) => n): { profile: Profile; changed: boolean } {
  const next = structuredClone(profile);
  let changed = false;
  for (const [id, r] of Object.entries(raise)) {
    const level = clamp(Math.round(r.level), 1, 5);
    const existing = next.skills.find((s) => (s.id || idOf(s.name)) === id);
    if (!existing) {
      next.skills.push({ id, name: names.get(id) ?? id, level, evidence: [r.evidence] });
      changed = true;
      continue;
    }
    if (level > existing.level) { existing.level = level; changed = true; }
    if (!existing.evidence.includes(r.evidence)) {
      existing.evidence = existing.evidence.length >= 5 ? [...existing.evidence.slice(0, 4), r.evidence] : [...existing.evidence, r.evidence];
      changed = true;
    }
  }
  return { profile: next, changed };
}

// ---- replan ----------------------------------------------------------------

export interface ReplanInput {
  plan: Plan; goal: Goal; today: string; gap?: GapMap; reason?: string;
  interviewAvg?: number | null; now?: string;
}

const PROTECTED = /^(repair|drill)-/;
const isReview = (t: PlanTask) => t.id.endsWith('-review');

export function replan(input: ReplanInput): Plan {
  const plan = structuredClone(input.plan);
  const W = plan.weeks.length;
  const H = Math.max(1, input.goal.hoursPerWeek || 10);
  const cur = currentWeek(plan, input.today);
  const version = plan.version + 1;
  const byId = new Map((input.gap?.skills ?? []).map((s) => [s.id, s]));
  const closed = new Set((input.gap?.skills ?? []).filter((s) => s.status === 'closed').map((s) => s.id));
  const origin = new Map<string, number>();
  for (const w of plan.weeks) for (const t of w.tasks) origin.set(t.id, w.index);
  const notes: string[] = [];
  const parts: string[] = [];

  let freed = 0;
  for (const w of plan.weeks) for (const t of w.tasks) {
    if (t.status !== 'todo' || (t.kind !== 'learn' && t.kind !== 'practice')) continue;
    if (!t.skillIds.length || !t.skillIds.every((id) => closed.has(id))) continue;
    t.status = 'skipped';
    freed += t.hours;
    notes.push(`Skipped "${t.title}" (week ${w.index}): ${joinNames(namesOf(t.skillIds, byId))} is already closed`);
  }
  if (freed) parts.push(`freed ${round1(freed)}h from closed skills`);

  const target = plan.weeks[cur - 1];
  const rolled: PlanTask[] = [];
  for (const w of plan.weeks) {
    if (w.index >= cur) continue;
    const late = w.tasks.filter((t) => t.status === 'todo');
    if (!late.length) continue;
    w.tasks = w.tasks.filter((t) => t.status !== 'todo');
    rolled.push(...late);
  }
  if (rolled.length) {
    target.tasks.splice(firstTodo(target), 0, ...rolled);
    parts.push(`rolled ${rolled.length} late task${rolled.length > 1 ? 's' : ''} from before week ${cur} forward`);
  }

  for (const w of plan.weeks) {
    if (w.index > cur || w.checkpoint.passed !== false) continue;
    const id = `repair-w${w.index}`;
    if (origin.has(id)) continue;
    const dest = plan.weeks[(w.index < cur ? cur : Math.min(cur + 1, W)) - 1];
    const names = joinNames(namesOf(w.skillIds, byId));
    const task: PlanTask = {
      id, kind: 'practice', skillIds: [...w.skillIds], hours: half(clamp(H * 0.2, 1, 3)), status: 'todo',
      title: names ? `Repair block: rework ${names} and retake the week ${w.index} checkpoint` : `Repair block: retake the week ${w.index} checkpoint`,
    };
    dest.tasks.splice(firstTodo(dest), 0, task);
    notes.push(`Added "${task.title}" to week ${dest.index}`);
    parts.push(`added a repair block for the failed week ${w.index} checkpoint`);
  }

  if (input.interviewAvg != null && input.interviewAvg < 50) {
    const pending = allTasks(plan).some((t) => t.id.startsWith('drill-') && t.status === 'todo');
    if (!pending) {
      const recent = [...new Set(plan.weeks.slice(0, cur).flatMap((w) => w.skillIds))].slice(-2);
      const task: PlanTask = {
        id: `drill-v${version}`, kind: 'interview', skillIds: recent, hours: half(clamp(H * 0.15, 1, 2)), status: 'todo',
        title: 'Interview drill: rewrite your two weakest answers with a clear structure and one number each, then answer them again',
      };
      target.tasks.splice(firstTodo(target), 0, task);
      notes.push(`Added "${task.title}" to week ${cur}`);
      parts.push(`added interview practice because the last session averaged ${Math.round(input.interviewAvg)}`);
    }
  }

  const pri = (t: PlanTask) => (isReview(t) ? -1 : Math.max(0, ...t.skillIds.map((id) => byId.get(id)?.priority ?? 0)));
  rebalance(plan, cur, H, origin);
  // a fixed end date: what still does not fit is the lowest-priority learning at the tail
  const dropped = dropOverflow(plan, cur, H, pri);
  const bySkill = new Map<string, PlanTask[]>();
  for (const t of dropped) {
    const key = joinNames(namesOf(t.skillIds, byId)) || 'other';
    bySkill.set(key, [...(bySkill.get(key) ?? []), t]);
  }
  for (const [names, ts] of bySkill) {
    notes.push(ts.length === 1
      ? `Dropped "${ts[0].title}": no room left before the end date`
      : `Dropped ${ts.length} ${names} tasks (${round1(ts.reduce((a, t) => a + t.hours, 0))}h): no room left before the end date`);
  }
  if (dropped.length) parts.push(`dropped ${dropped.length} low-priority task${dropped.length > 1 ? 's' : ''} (${round1(dropped.reduce((a, t) => a + t.hours, 0))}h) that no longer fit`);

  const shifts = new Map<string, PlanTask[]>();
  let shifted = 0;
  for (const w of plan.weeks) for (const t of w.tasks) {
    const from = origin.get(t.id);
    if (from === undefined || from === w.index || t.status === 'skipped') continue;
    const key = `${from}>${w.index}`;
    shifts.set(key, [...(shifts.get(key) ?? []), t]);
    if (!rolled.includes(t) || w.index !== cur) shifted++;
  }
  const moved = [...shifts.entries()]
    .sort(([a], [b]) => Number(a.split('>')[0]) - Number(b.split('>')[0]) || Number(a.split('>')[1]) - Number(b.split('>')[1]))
    .map(([key, tasks]) => {
      const [from, to] = key.split('>');
      const titles = tasks.map((t) => `"${t.title}"`);
      return tasks.length <= 2
        ? `${titles.join(' and ')}: week ${from} to week ${to}`
        : `${tasks.length} tasks from week ${from} to week ${to}, including ${titles.slice(0, 2).join(' and ')}`;
    });
  moved.push(...notes);
  if (shifted) parts.push(`moved ${shifted} other task${shifted > 1 ? 's' : ''} later to keep weeks within ${H}h`);
  const over = round1(load(plan.weeks[W - 1]) - H);
  if (over > 0.01) parts.push(`week ${W} is still ${over}h over budget`);

  for (const w of plan.weeks) {
    w.skillIds = [...new Set(w.tasks.filter((t) => (t.kind === 'learn' || t.kind === 'practice') && t.status !== 'skipped').flatMap((t) => t.skillIds))];
    w.hours = load(w);
    if (!w.tasks.length) w.theme = 'Buffer week';
  }

  const summary = parts.length
    ? cap1(parts.join('; ')) + '.'
    : 'Nothing needed to move; the plan already fits the budget.';
  plan.version = version;
  plan.changes.push({ at: input.now ?? new Date().toISOString(), reason: input.reason?.trim() || 'Weekly replan', summary, moved });
  return plan;
}

function cap1(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function load(w: PlanWeek): number {
  return round1(w.tasks.reduce((a, t) => a + (t.status === 'skipped' ? 0 : t.hours), 0));
}

function firstTodo(w: PlanWeek): number {
  const i = w.tasks.findIndex((t) => t.status === 'todo');
  return i < 0 ? w.tasks.length : i;
}

// learning moves first; project blocks and the weekly interview and application slots stay put longest
const MOVE_RANK: Record<PlanTask['kind'], number> = { learn: 0, practice: 0, project: 1, apply: 2, interview: 3 };

const movable = (t: PlanTask) => t.status === 'todo' && !PROTECTED.test(t.id);
const isLearning = (t: PlanTask) => t.kind === 'learn' || t.kind === 'practice';

// The last task in sequence among the most movable kind, so order within the plan holds.
function pickMovable(w: PlanWeek, fromEnd: boolean): number {
  let best = -1;
  for (let i = 0; i < w.tasks.length; i++) {
    const t = w.tasks[i];
    if (!movable(t)) continue;
    if (best < 0) { best = i; continue; }
    const rb = MOVE_RANK[w.tasks[best].kind], rt = MOVE_RANK[t.kind];
    if (rt < rb || (rt === rb && fromEnd)) best = i;
  }
  return best;
}

function rebalance(plan: Plan, cur: number, H: number, origin: Map<string, number>): void {
  const W = plan.weeks.length;
  const ids = new Set(allTasks(plan).map((t) => t.id));
  const shift = (from: PlanWeek, to: PlanWeek, i: number, front: boolean) => {
    const [t] = from.tasks.splice(i, 1);
    if (front) to.tasks.splice(firstTodo(to), 0, t);
    else to.tasks.push(t);
  };
  for (let i = cur; i < W; i++) {
    const w = plan.weeks[i - 1];
    while (load(w) > H + 0.01) {
      const j = pickMovable(w, true);
      if (j < 0) break;
      const t = w.tasks[j];
      const over = round1(load(w) - H);
      // only part of a learning task spills over: move that part and keep the rest here
      if (isLearning(t) && t.hours - over >= 0.5 && over >= 0.5) {
        let n = 1;
        const base = t.id.replace(/-c\d+$/, '');
        while (ids.has(`${base}-c${n}`)) n++;
        const rest: PlanTask = { ...t, id: `${base}-c${n}`, hours: over, title: t.title.endsWith('(continued)') ? t.title : `${t.title} (continued)` };
        if (rest.resource) delete rest.resource;
        ids.add(rest.id);
        origin.set(rest.id, origin.get(t.id) ?? w.index);
        t.hours = round1(t.hours - over);
        const next = plan.weeks[i];
        next.tasks.splice(firstTodo(next), 0, rest);
        continue;
      }
      shift(w, plan.weeks[i], j, true);
    }
  }
  // the last week has nowhere to go: back-fill earlier weeks with room
  const last = plan.weeks[W - 1];
  for (let i = W - 1; i >= cur && load(last) > H + 0.01; i--) {
    const w = plan.weeks[i - 1];
    let j = pickMovable(last, false);
    while (j >= 0 && load(last) > H + 0.01 && load(w) + last.tasks[j].hours <= H + 0.01) {
      shift(last, w, j, false);
      j = pickMovable(last, false);
    }
  }
  // freed hours pull the next learning tasks forward (future weeks only, the current one is under way)
  for (let i = cur + 1; i < W; i++) {
    const w = plan.weeks[i - 1];
    for (let k = i + 1; k <= W; k++) {
      const src = plan.weeks[k - 1];
      let j = src.tasks.findIndex((t) => movable(t) && isLearning(t));
      while (j >= 0 && load(w) + src.tasks[j].hours <= H + 0.01) {
        shift(src, w, j, false);
        j = src.tasks.findIndex((t) => movable(t) && isLearning(t));
      }
      if (j >= 0) break;
    }
  }
}

function dropOverflow(plan: Plan, cur: number, H: number, pri: (t: PlanTask) => number): PlanTask[] {
  const last = plan.weeks[plan.weeks.length - 1];
  const out: PlanTask[] = [];
  if (last.index < cur) return out;
  while (load(last) > H + 0.01) {
    const cands = last.tasks.filter((t) => t.status === 'todo' && !PROTECTED.test(t.id) && (t.kind === 'learn' || t.kind === 'practice'));
    if (!cands.length) break;
    const t = cands.reduce((a, b) => (pri(b) < pri(a) || (pri(b) === pri(a) && b.kind === 'practice' && a.kind === 'learn') ? b : a));
    t.status = 'skipped';
    out.push(t);
  }
  return out;
}

// ---- calendar ----------------------------------------------------------------

function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function toIcs(plan: Plan, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const day = (d: string) => d.replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tack//Pivot plan//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Tack plan'];
  const event = (uid: string, date: string, summary: string, description: string) => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@tack.example`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${day(addDays(date, 1))}`,
      fold(`SUMMARY:${icsText(summary)}`), fold(`DESCRIPTION:${icsText(description)}`), 'END:VEVENT');
  };
  for (const w of plan.weeks) {
    w.tasks.forEach((t, i) => {
      if (t.status === 'skipped') return;
      const desc = [`Week ${w.index}: ${w.theme}`, `${t.hours}h, ${t.kind}`, t.resource ? `Resource: ${t.resource.url}` : '']
        .filter(Boolean).join('\n');
      event(`${t.id}-v${plan.version}`, addDays(w.startDate, i % 6), `${t.status === 'done' ? '[done] ' : ''}${t.title}`, desc);
    });
    event(`checkpoint-w${w.index}-v${plan.version}`, addDays(w.startDate, 6), `Checkpoint: ${w.checkpoint.title}`, w.checkpoint.description);
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
