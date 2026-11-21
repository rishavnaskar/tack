import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GapMap, GapSkill, Goal, InterviewSession, Plan } from '../src/types.ts';
import { addDays, allTasks, buildPlan, setTaskStatus } from '../src/plan.ts';
import { brief, computeProgress, expectedHours, streak } from '../src/progress.ts';

function skill(id: string, priority: number, have: number, need: number, mustShare = 0.5): GapSkill {
  return {
    id, name: id.replace(/-/g, ' '), category: 'product', demand: 0.5, mustShare, level: have >= need ? 'strong' : have > 0 ? 'partial' : 'missing',
    have, need, evidence: { resume: [], postings: [] }, priority, status: have >= need ? 'closed' : 'open',
  };
}

const GAP: GapMap = {
  postingCount: 40, generatedAt: '2026-10-26T00:00:00.000Z', readiness: 40, summary: '',
  market: { topCompanies: [], locations: [], seniority: [], salaryNote: '' },
  skills: [
    skill('llm-evaluation', 80, 0, 4, 0.8),
    skill('llm-fundamentals', 60, 1, 4, 0.6),
    skill('experimentation', 70, 1, 4, 0.5),
    skill('product-discovery', 55, 0, 3, 0.4),
    skill('prd-writing', 45, 1, 3, 0.3),
    skill('stakeholder-management', 30, 2, 4, 0.2),
    skill('sql', 10, 4, 3, 0.2),
  ],
};
const GOAL: Goal = { targetRole: 'AI Product Manager', location: 'Bengaluru', remote: false, hoursPerWeek: 10, weeks: 12, startDate: '2026-10-26', notes: '' };

const at = (d: string) => `${d}T12:00:00`;

function planWithDone(days: string[]): Plan {
  let plan = buildPlan({ gap: GAP, goal: GOAL });
  const tasks = allTasks(plan);
  days.forEach((d, i) => { plan = setTaskStatus(plan, tasks[i].id, 'done', new Date(at(d)).toISOString())!; });
  return plan;
}

test('streak counts consecutive active days ending today or yesterday', () => {
  const days = new Set(['2026-11-18', '2026-11-19', '2026-11-20']);
  assert.equal(streak(days, '2026-11-20'), 3);
  assert.equal(streak(days, '2026-11-21'), 3, 'today not done yet keeps the streak');
  assert.equal(streak(days, '2026-11-22'), 0);
});

test('expected hours count past weeks fully and the current week pro rata', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL });
  assert.equal(expectedHours(plan, addDays(GOAL.startDate, -1)), 0);
  const w1 = plan.weeks[0].hours;
  assert.equal(expectedHours(plan, addDays(GOAL.startDate, 6)), w1);
  const mid = expectedHours(plan, addDays(GOAL.startDate, 10));
  assert.ok(mid > w1 && mid < w1 + plan.weeks[1].hours);
});

test('progress sums hours and tasks, and flags falling behind', () => {
  const plan = planWithDone(['2026-10-26', '2026-10-27', '2026-10-28']);
  const done = allTasks(plan).slice(0, 3).reduce((a, t) => a + t.hours, 0);
  const sessions: InterviewSession[] = [{ id: 's', kind: 'mixed', questions: [], turns: [], startedAt: '2026-11-01T10:00:00Z', finishedAt: '2026-11-01T10:30:00Z', score: 62 }];
  const early = computeProgress({ plan, gap: GAP, readiness: [], sessions, now: new Date(at('2026-10-28')) });
  assert.equal(early.hoursDone, Math.round(done * 10) / 10);
  assert.equal(early.tasksDone, 3);
  assert.equal(early.tasksTotal, allTasks(plan).length);
  assert.equal(early.onTrack, true);
  assert.equal(early.streakDays, 3);
  assert.deepEqual(early.readiness, [{ at: GAP.generatedAt, value: GAP.readiness }]);
  assert.deepEqual(early.interviewAvg, [{ at: '2026-11-01T10:30:00Z', value: 62 }]);
  const late = computeProgress({ plan, gap: GAP, readiness: [], sessions, now: new Date(at('2026-11-20')) });
  assert.equal(late.onTrack, false);
  assert.match(late.note, /Behind by/);
  assert.equal(late.streakDays, 0);
  assert.equal(late.skillsClosed, 0);
  const closedGap: GapMap = { ...GAP, skills: GAP.skills.map((s) => (s.id === 'prd-writing' ? { ...s, have: 3, status: 'closed' } : s)) };
  const start = Object.fromEntries(GAP.skills.map((s) => [s.id, s.have]));
  // sql was strong from the start and does not count; prd-writing closed through the plan does
  assert.equal(computeProgress({ plan, gap: closedGap, readiness: [], sessions, now: new Date(at('2026-11-20')), start }).skillsClosed, 1);
});

test('the brief gives at most three things, led by the next task', () => {
  const plan = planWithDone(['2026-10-26']);
  const now = new Date(at('2026-10-27'));
  const progress = computeProgress({ plan, gap: GAP, readiness: [], sessions: [], now });
  const out = brief({
    plan, gap: GAP, goal: GOAL, progress, sessions: [], now,
    insights: { overall: { sent: 0, responses: 0, rate: 0 }, segments: [], lessons: [], next: [{ postingId: 'p', title: 'AI PM', company: 'Acme', url: '', fit: 81, responseChance: 0.34, why: '' }] },
  });
  assert.ok(out.items.length <= 3 && out.items.length >= 2);
  assert.equal(out.items[0].kind, 'task');
  assert.ok(out.items[0].text.includes(allTasks(plan)[1].title));
  assert.ok(out.items.some((i) => i.kind === 'interview'));
  assert.ok(out.items.some((i) => i.kind === 'apply' && i.text.includes('34%')));
  assert.match(out.headline, /^Week 1 of 12/);
  assert.equal(brief({ progress, sessions: [], now }).items[0].kind, 'setup');
});
