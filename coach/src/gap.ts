import type { GapMap, GapSkill, Level, Posting, Profile } from './types.ts';
import * as store from './store.ts';
import { json } from './llm.ts';
import { BRIDGES, canonical, catalogNames, findQuote, skillId } from './skills.ts';
import { run, type Run } from './trace.ts';

type PostingSkill = NonNullable<Posting['skills']>[number];

const BATCH = 5;
const MAX_TEXT = 6000;

// Level 1-5 the profile shows for a skill, 0 when there is no evidence.
export function haveLevel(profile: Profile, id: string): number {
  let best = 0;
  for (const s of profile.skills) {
    if ((s.id || skillId(s.name)) === id) best = Math.max(best, Math.max(0, Math.min(5, Math.round(s.level))));
  }
  return best;
}

function levelOf(have: number, need: number): Level {
  if (have >= need) return 'strong';
  return have > 0 ? 'partial' : 'missing';
}

// need: 1.5 baseline, up to +1.5 when postings list it as a must, up to +1.5 for wide demand.
// A must-have in every posting needs 5; an occasional nice-to-have needs 2.
export function needLevel(demand: number, mustShare: number): number {
  return Math.max(1, Math.min(5, Math.round(1.5 + 1.5 * mustShare + 1.5 * demand)));
}

export function priorityOf(demand: number, need: number, have: number, mustShare: number): number {
  return Math.round(100 * demand * Math.max(0, need - have) / 5 * (0.6 + 0.4 * mustShare));
}

// Same coverage maths as the gap, for one posting: musts need 4 and weigh 1, nice-to-haves need 3 and weigh 0.5.
export function postingFit(profile: Profile, posting: Posting): number {
  const seen = new Map<string, PostingSkill['importance']>();
  for (const s of posting.skills ?? []) {
    const id = s.skillId || skillId(s.name);
    if (seen.get(id) !== 'must') seen.set(id, s.importance);
  }
  let num = 0;
  let den = 0;
  for (const [id, importance] of seen) {
    const need = importance === 'must' ? 4 : 3;
    const w = importance === 'must' ? 1 : 0.5;
    num += w * Math.min(haveLevel(profile, id) / need, 1);
    den += w;
  }
  return den ? Math.round((100 * num) / den) : 0;
}

function bridgeFor(profile: Profile, id: string): GapSkill['bridge'] {
  const b = BRIDGES[id];
  if (!b) return undefined;
  const from = b.from
    .map((f) => ({ f, level: haveLevel(profile, f) }))
    .filter((x) => x.level >= 3)
    .sort((a, b2) => b2.level - a.level)[0];
  return from ? { from: canonical(from.f).name, note: b.note } : undefined;
}

function town(location: string): string {
  if (/remote/i.test(location)) return 'Remote';
  return location.split(/[,(/·|-]/)[0].trim() || 'Unspecified';
}

function counts(values: string[], top: number): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, top);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function salaryNote(postings: Posting[]): string {
  const lows: number[] = [];
  const highs: number[] = [];
  for (const p of postings) {
    const m = p.salary?.match(/(\d+(?:\.\d+)?)\s*(?:[-–to]+\s*(\d+(?:\.\d+)?))?\s*(?:LPA|lakh)/i);
    if (!m) continue;
    lows.push(Number(m[1]));
    highs.push(Number(m[2] ?? m[1]));
  }
  if (lows.length < 3) return 'Few postings list pay. Ask for the band in the first recruiter call.';
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `${lows.length} of ${postings.length} postings list pay. Median band ₹${fmt(median(lows))}–${fmt(median(highs))} LPA, from ₹${fmt(Math.min(...lows))} to ₹${fmt(Math.max(...highs))} LPA.`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function names(skills: GapSkill[]): string {
  const n = skills.map((s) => s.name);
  if (n.length <= 1) return n.join('');
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

function summarise(skills: GapSkill[], postingCount: number, readiness: number): string {
  const byDemand = [...skills].sort((a, b) => b.demand - a.demand);
  const top = byDemand.slice(0, 3).map((s) => `${s.name} (${pct(s.demand)})`).join(', ');
  const strong = byDemand.filter((s) => s.level === 'strong').slice(0, 3);
  const gaps = skills.filter((s) => s.level !== 'strong').slice(0, 3);
  const parts = [`Across ${postingCount} postings the most requested skills are ${top}.`];
  if (strong.length) parts.push(`You already cover ${names(strong)}.`);
  if (gaps.length) parts.push(`The biggest gaps, weighted by demand, are ${names(gaps)}.`);
  parts.push(`Readiness is ${readiness} of 100.`);
  return parts.join(' ');
}

// Pure: profile + postings (with extracted skills) to a gap map. `prev` carries over 'learning' status.
export function computeGap(profile: Profile, postings: Posting[], prev?: GapMap, now = new Date()): GapMap {
  const considered = postings.filter((p) => p.skills?.length);
  const n = considered.length;
  const agg = new Map<string, { name: string; count: number; must: number; quotes: GapSkill['evidence']['postings'] }>();
  for (const p of considered) {
    const mine = new Map<string, PostingSkill & { id: string }>();
    for (const s of p.skills!) {
      const id = s.skillId || skillId(s.name);
      const had = mine.get(id);
      if (!had || (had.importance !== 'must' && s.importance === 'must')) mine.set(id, { ...s, id });
    }
    for (const s of mine.values()) {
      const a = agg.get(s.id) ?? { name: s.name, count: 0, must: 0, quotes: [] };
      a.count++;
      if (s.importance === 'must') a.must++;
      if (s.quote) a.quotes.push({ postingId: p.id, company: p.company, quote: s.quote });
      agg.set(s.id, a);
    }
  }

  // Ignore one-off mentions once there are enough postings to tell signal from noise.
  const minCount = n >= 10 ? 2 : 1;
  const prevStatus = new Map(prev?.skills.map((s) => [s.id, s.status]) ?? []);
  const skills: GapSkill[] = [];
  for (const [id, a] of agg) {
    if (a.count < minCount) continue;
    const c = canonical(id);
    const known = c.id === id;
    const demand = a.count / n;
    const mustShare = a.count ? a.must / a.count : 0;
    const need = needLevel(demand, mustShare);
    const have = haveLevel(profile, id);
    const level = levelOf(have, need);
    const resume = profile.skills.filter((s) => (s.id || skillId(s.name)) === id).flatMap((s) => s.evidence).slice(0, 4);
    const status: GapSkill['status'] = have >= need ? 'closed' : prevStatus.get(id) === 'learning' ? 'learning' : 'open';
    skills.push({
      id,
      name: known ? c.name : a.name,
      category: c.category,
      demand: round2(demand),
      mustShare: round2(mustShare),
      level, have, need,
      evidence: { resume, postings: a.quotes.slice(0, 12) },
      bridge: level === 'strong' ? undefined : bridgeFor(profile, id),
      priority: priorityOf(demand, need, have, mustShare),
      status,
    });
  }
  skills.sort((x, y) => y.priority - x.priority || y.demand - x.demand || x.name.localeCompare(y.name));

  const weight = skills.reduce((t, s) => t + s.demand, 0);
  const covered = skills.reduce((t, s) => t + s.demand * Math.min(s.have / s.need, 1), 0);
  const readiness = weight ? Math.round((100 * covered) / weight) : 0;

  return {
    postingCount: n,
    generatedAt: now.toISOString(),
    readiness,
    skills,
    summary: n ? summarise(skills, n, readiness) : 'No postings with extracted skills yet.',
    market: {
      topCompanies: counts(postings.map((p) => p.company), 8),
      locations: counts(postings.map((p) => town(p.location)), 8),
      seniority: counts(postings.map((p) => p.seniority || 'unspecified'), 6),
      salaryNote: salaryNote(postings),
    },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function addReadinessPoint(value: number, always: boolean): void {
  const points = store.list<{ at: string; value: number }>('readiness').sort((a, b) => a.at.localeCompare(b.at));
  const last = points[points.length - 1];
  if (!always && last && last.value === value) return;
  // Points are keyed by time; keep them strictly increasing so two in one millisecond both survive.
  const now = Date.now();
  const at = new Date(last && Date.parse(last.at) >= now ? Date.parse(last.at) + 1 : now).toISOString();
  store.put('readiness', at, { at, value });
}

// Recomputes the gap from what is stored: no model calls. Use after `have` levels change.
export function recompute(): GapMap {
  return refresh(false);
}

function refresh(alwaysPoint: boolean): GapMap {
  const profile = store.get<Profile>('single', 'profile');
  if (!profile) throw new Error('no profile yet');
  const postings = store.list<Posting>('posting');
  if (!postings.some((p) => p.skills?.length)) throw new Error('no postings with extracted skills yet');
  const prev = store.get<GapMap>('single', 'gap');
  const gap = computeGap(profile, postings, prev);
  for (const p of postings) {
    if (!p.skills?.length) continue;
    const fit = postingFit(profile, p);
    if (p.fit !== fit) store.put('posting', p.id, { ...p, fit });
  }
  store.put('single', 'gap', gap);
  addReadinessPoint(gap.readiness, alwaysPoint);
  return gap;
}

// Raises a skill in the profile (interview scores, passed checkpoints) and refreshes the gap.
export function raiseHave(id: string, level: number, evidence: string): GapMap | undefined {
  const profile = store.get<Profile>('single', 'profile');
  if (!profile) return undefined;
  const sid = skillId(id);
  const existing = profile.skills.find((s) => (s.id || skillId(s.name)) === sid);
  const lvl = Math.max(1, Math.min(5, Math.round(level)));
  if (existing) {
    existing.level = Math.max(existing.level, lvl);
    if (evidence && !existing.evidence.includes(evidence)) existing.evidence = [...existing.evidence, evidence].slice(-5);
  } else {
    profile.skills.push({ id: sid, name: canonical(sid).name, level: lvl, evidence: evidence ? [evidence] : [] });
  }
  store.put('single', 'profile', profile);
  return store.get('single', 'gap') ? recompute() : undefined;
}

export function setStatus(id: string, status: GapSkill['status']): GapMap | undefined {
  const gap = store.get<GapMap>('single', 'gap');
  const skill = gap?.skills.find((s) => s.id === id);
  if (!gap || !skill) return undefined;
  skill.status = status;
  store.put('single', 'gap', gap);
  return gap;
}

const ROLE_FAMILIES = ['platform', 'growth', 'agents', 'analytics', 'generalist'];
const SENIORITY = ['associate', 'mid', 'senior', 'lead'];

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    postings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          roleFamily: { type: 'string', enum: ROLE_FAMILIES },
          seniority: { type: 'string', enum: SENIORITY },
          companySize: { type: 'string', enum: ['startup', 'scaleup', 'enterprise'] },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                importance: { type: 'string', enum: ['must', 'nice'] },
                quote: { type: 'string' },
              },
              required: ['name', 'importance', 'quote'],
            },
          },
        },
        required: ['id', 'skills'],
      },
    },
  },
  required: ['postings'],
};

const EXTRACT_SYSTEM = `You read job postings and list the skills each one asks for.
For every posting return 6 to 10 skills. Prefer these names when they fit: ${catalogNames().join(', ')}.
importance is "must" when the posting requires it and "nice" when it is a plus, bonus or preferred.
quote must be copied exactly from that posting's text, 4 to 25 words, the phrase that shows the skill is wanted.
Never invent a quote. Skip generic traits like "passion" or "ownership".
roleFamily: platform (internal AI or developer platforms), growth (activation, conversion, retention), agents (agent or copilot products), analytics (ML, data or insight products), generalist (everything else).
seniority from the title and years asked: associate, mid, senior or lead. companySize: startup (under ~150 people), scaleup, or enterprise.`;

type Extracted = { postings: { id: string; roleFamily?: string; seniority?: string; companySize?: Posting['companySize']; skills: { name: string; importance: 'must' | 'nice'; quote: string }[] }[] };

// Verified, canonical, de-duplicated skills for one posting from raw model output.
export function cleanSkills(text: string, raw: { name: string; importance: string; quote: string }[]): PostingSkill[] {
  const out = new Map<string, PostingSkill>();
  for (const r of raw) {
    if (!r?.name || !r.quote) continue;
    const quote = findQuote(text, r.quote);
    if (!quote) continue;
    const c = canonical(r.name);
    const importance = r.importance === 'must' ? 'must' : 'nice';
    const had = out.get(c.id);
    if (had && (had.importance === 'must' || importance === 'nice')) continue;
    out.set(c.id, { skillId: c.id, name: c.name, importance, quote });
  }
  return [...out.values()].slice(0, 10);
}

export async function extractSkills(postings: Posting[], trace?: Run): Promise<Posting[]> {
  const batches: Posting[][] = [];
  for (let i = 0; i < postings.length; i += BATCH) batches.push(postings.slice(i, i + BATCH));
  const done: Posting[] = [];
  let failures = 0;
  await Promise.all(batches.map(async (batch, bi) => {
    const label = `postings ${bi * BATCH + 1}-${bi * BATCH + batch.length} of ${postings.length}`;
    trace?.step('extract', `reading ${label}`);
    const prompt = batch.map((p) => `### id: ${p.id}\nTitle: ${p.title}\nCompany: ${p.company}\nLocation: ${p.location}\n\n${p.text.slice(0, MAX_TEXT)}`).join('\n\n');
    try {
      const res = await json<Extracted>({ task: 'gap.extract', system: EXTRACT_SYSTEM, prompt, schema: EXTRACT_SCHEMA });
      for (const p of batch) {
        const got = res.postings.find((x) => x.id === p.id) ?? res.postings[batch.indexOf(p)];
        if (!got) continue;
        const skills = cleanSkills(p.text, got.skills ?? []);
        if (!skills.length) continue;
        const next: Posting = {
          ...p,
          skills,
          roleFamily: p.roleFamily ?? (ROLE_FAMILIES.includes(got.roleFamily ?? '') ? got.roleFamily : undefined),
          seniority: p.seniority ?? (SENIORITY.includes(got.seniority ?? '') ? got.seniority : undefined),
          companySize: p.companySize ?? got.companySize,
        };
        store.put('posting', p.id, next);
        done.push(next);
        trace?.step('skills', `${p.company}: ${skills.map((s) => s.name).join(', ')}`);
      }
    } catch (err) {
      failures++;
      trace?.step('extract', `${label} failed: ${(err as Error).message.slice(0, 160)}`);
    }
  }));
  if (failures === batches.length && batches.length) throw new Error('skill extraction failed for every batch');
  return done;
}

// Full build: extracts skills for postings that lack them, then recomputes and stores the gap.
export async function buildGap(): Promise<GapMap> {
  const t = run('gap');
  try {
    const profile = store.get<Profile>('single', 'profile');
    if (!profile) throw new Error('no profile yet');
    const postings = store.list<Posting>('posting');
    if (!postings.length) throw new Error('no postings yet');
    const todo = postings.filter((p) => !p.skills?.length);
    t.step('postings', `${postings.length} postings, ${todo.length} need skill extraction`);
    if (todo.length) await extractSkills(todo, t);
    t.step('maths', 'demand, need, have, priority and readiness');
    const gap = refresh(true);
    t.ok(`readiness ${gap.readiness}, ${gap.skills.length} skills from ${gap.postingCount} postings`);
    return gap;
  } catch (err) {
    t.fail((err as Error).message);
    throw err;
  }
}
