import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GapMap, Posting, Profile } from '../src/types.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-gap-'));
const { cleanSkills, computeGap, needLevel, postingFit, priorityOf, salaryNote, recompute, raiseHave } = await import('../src/gap.ts');
const store = await import('../src/store.ts');

const profile: Profile = {
  name: 'Test Person', headline: '', currentRole: 'Engineer', yearsExperience: 5, summary: '',
  skills: [
    { id: 'sql', name: 'SQL', level: 4, evidence: ['Write SQL daily'] },
    { id: 'experimentation', name: 'Experimentation', level: 2, evidence: ['ran A/B tests'] },
    { id: 'testing', name: 'Testing and quality', level: 4, evidence: ['raised test coverage'] },
  ],
  experience: [], education: [], projects: [], source: 'text',
};

function posting(id: string, skills: [string, 'must' | 'nice'][], extra: Partial<Posting> = {}): Posting {
  return {
    id, title: 'AI PM', company: `Co ${id}`, location: 'Bengaluru', url: `https://${id}.example`, source: 'job-board',
    text: '', harvestedAt: '2026-11-21T00:00:00.000Z', live: false,
    skills: skills.map(([skillId, importance]) => ({ skillId, name: skillId, importance, quote: `${skillId} quote` })),
    ...extra,
  };
}

// 4 postings: sql in all (3 must), evals in 2 (both must), experimentation in 1 (nice).
const postings = [
  posting('a', [['sql', 'must'], ['llm-evaluation', 'must']], { salary: '₹30–40 LPA', seniority: 'mid' }),
  posting('b', [['sql', 'must'], ['llm-evaluation', 'must'], ['experimentation', 'nice']], { salary: '₹20–30 LPA', seniority: 'senior' }),
  posting('c', [['sql', 'nice']], { location: 'Remote (India)', salary: '₹40 LPA' }),
  posting('d', [['sql', 'must'], ['sql', 'nice']]),
];

test('need grows with must share and demand, clamped to 1-5', () => {
  assert.equal(needLevel(1, 1), 5);
  assert.equal(needLevel(0.05, 0), 2);
  assert.equal(needLevel(0.5, 1), 4);
  assert.ok(needLevel(0, 0) >= 1);
});

test('priority follows the spec formula', () => {
  // round(100 * demand * (need - have) / 5 * (0.6 + 0.4 * mustShare))
  assert.equal(priorityOf(0.5, 4, 0, 1), Math.round(100 * 0.5 * 4 / 5 * 1));
  assert.equal(priorityOf(0.78, 4, 0, 0.68), Math.round(100 * 0.78 * 4 / 5 * (0.6 + 0.4 * 0.68)));
  assert.equal(priorityOf(0.4, 3, 5, 1), 0);
});

test('demand, mustShare, have, level and readiness', () => {
  const gap = computeGap(profile, postings, undefined, new Date('2026-11-21T00:00:00Z'));
  const by = new Map(gap.skills.map((s) => [s.id, s]));
  const sql = by.get('sql')!;
  assert.equal(sql.demand, 1);
  assert.equal(sql.mustShare, 0.75); // d counts once, as must
  assert.equal(sql.need, needLevel(1, 0.75));
  assert.equal(sql.have, 4);
  assert.equal(sql.level, 'strong');
  assert.equal(sql.status, 'closed');

  const evals = by.get('llm-evaluation')!;
  assert.equal(evals.demand, 0.5);
  assert.equal(evals.mustShare, 1);
  assert.equal(evals.have, 0);
  assert.equal(evals.level, 'missing');
  assert.equal(evals.bridge?.from, 'Testing and quality');
  assert.equal(evals.priority, priorityOf(0.5, evals.need, 0, 1));
  assert.equal(evals.evidence.postings.length, 2);

  const exp = by.get('experimentation')!;
  assert.equal(exp.level, exp.have >= exp.need ? 'strong' : 'partial');

  const expected = gap.skills.reduce((t, s) => t + s.demand * Math.min(s.have / s.need, 1), 0) / gap.skills.reduce((t, s) => t + s.demand, 0);
  assert.equal(gap.readiness, Math.round(expected * 100));
  assert.equal(gap.postingCount, 4);
  assert.equal(gap.skills[0].id, 'llm-evaluation'); // highest priority first
  assert.deepEqual(gap.market.locations[0], { name: 'Bengaluru', count: 3 });
  assert.match(gap.summary, /4 postings/);
});

test('one-off skills are dropped once there are 10 or more postings', () => {
  const many = Array.from({ length: 10 }, (_, i) => posting(`p${i}`, i === 0 ? [['sql', 'must'], ['pricing', 'nice']] : [['sql', 'must']]));
  const gap = computeGap(profile, many);
  assert.ok(gap.skills.some((s) => s.id === 'sql'));
  assert.ok(!gap.skills.some((s) => s.id === 'pricing'));
});

test('learning status carries over until the skill is closed', () => {
  const prev = computeGap(profile, postings);
  prev.skills.find((s) => s.id === 'llm-evaluation')!.status = 'learning';
  const next = computeGap(profile, postings, prev);
  assert.equal(next.skills.find((s) => s.id === 'llm-evaluation')!.status, 'learning');
  const raised = { ...profile, skills: [...profile.skills, { id: 'llm-evaluation', name: 'LLM evaluation', level: 5, evidence: ['x'] }] };
  assert.equal(computeGap(raised, postings, prev).skills.find((s) => s.id === 'llm-evaluation')!.status, 'closed');
});

test('posting fit uses the same coverage maths per posting', () => {
  // a: sql must (4/4 -> 1), evals must (0) -> 50
  assert.equal(postingFit(profile, postings[0]), 50);
  // b: sql must 1, evals must 0, experimentation nice 2/3 * 0.5 weight
  assert.equal(postingFit(profile, postings[1]), Math.round(100 * (1 + 0 + 0.5 * (2 / 3)) / 2.5));
  assert.equal(postingFit(profile, posting('e', [])), 0);
});

test('cleanSkills keeps only verbatim quotes, canonical ids and the strongest importance', () => {
  const text = 'You will run A/B tests every week. Strong SQL is a must. Bonus: pricing experience.';
  const out = cleanSkills(text, [
    { name: 'A/B testing', importance: 'nice', quote: 'run A/B tests every week' },
    { name: 'Experimentation', importance: 'must', quote: 'run a/b tests every week.' },
    { name: 'SQL', importance: 'must', quote: 'Strong SQL is a must' },
    { name: 'Pricing', importance: 'nice', quote: 'deep pricing expertise' },
  ]);
  assert.deepEqual(out.map((s) => [s.skillId, s.importance]), [['experimentation', 'must'], ['sql', 'must']]);
  assert.equal(out[0].quote, 'run A/B tests every week');
});

test('salary note reads LPA bands', () => {
  assert.match(salaryNote(postings), /3 of 4 postings list pay\. Median band ₹30–40 LPA/);
  assert.match(salaryNote(postings.slice(3)), /Few postings list pay/);
});

test('recompute writes the gap, posting fits and readiness points from the store', () => {
  store.clear();
  store.put('single', 'profile', profile);
  for (const p of postings) store.put('posting', p.id, p);
  const gap = recompute();
  assert.deepEqual(store.get<GapMap>('single', 'gap')?.readiness, gap.readiness);
  assert.equal(store.get<Posting>('posting', 'a')?.fit, 50);
  assert.equal(store.list('readiness').length, 1);
  recompute();
  assert.equal(store.list('readiness').length, 1, 'unchanged readiness adds no point');

  const after = raiseHave('llm-evaluation', 4, 'Mock interview: scored 4.5 on eval questions')!;
  assert.ok(after.readiness > gap.readiness);
  assert.equal(store.list('readiness').length, 2);
  const skill = after.skills.find((s) => s.id === 'llm-evaluation')!;
  assert.deepEqual(skill.evidence.resume, ['Mock interview: scored 4.5 on eval questions']);
});
