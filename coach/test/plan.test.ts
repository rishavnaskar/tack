import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GapMap, GapSkill, Goal, Plan } from '../src/types.ts';
import {
  addDays, allTasks, buildPlan, orderSkills, replan, setCheckpoint, setTaskStatus, skillMoves, startLevels, toIcs, wordPlan,
  type Ask,
} from '../src/plan.ts';

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

const prereqs = { 'llm-evaluation': ['llm-fundamentals'] };

test('every week fits the hours budget and dates step by seven days', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  assert.equal(plan.weeks.length, 12);
  for (const w of plan.weeks) {
    assert.ok(w.hours <= GOAL.hoursPerWeek + 1e-9, `week ${w.index} has ${w.hours}h`);
    assert.equal(w.startDate, addDays(GOAL.startDate, (w.index - 1) * 7));
    assert.ok(w.checkpoint.title && w.checkpoint.description);
    for (const t of w.tasks) assert.ok(t.title.length > 5 && t.hours > 0);
  }
  const ids = allTasks(plan).map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'task ids are unique');
});

test('closed skills are not planned and prerequisites come first', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const learn = allTasks(plan).filter((t) => t.kind === 'learn');
  assert.ok(!learn.some((t) => t.skillIds.includes('sql')));
  const first = (id: string) => plan.weeks.find((w) => w.tasks.some((t) => t.kind === 'learn' && t.skillIds.includes(id)))!.index;
  const firstTask = (id: string) => allTasks(plan).findIndex((t) => t.kind === 'learn' && t.skillIds.includes(id));
  assert.ok(firstTask('llm-fundamentals') < firstTask('llm-evaluation'));
  assert.ok(first('llm-fundamentals') <= first('llm-evaluation'));
  // llm-fundamentals inherits llm-evaluation's urgency, so both come before experimentation
  assert.deepEqual(orderSkills(GAP.skills.slice(0, 3), prereqs).map((s) => s.id), ['llm-fundamentals', 'llm-evaluation', 'experimentation']);
});

test('interview practice, application batches and three projects are scheduled', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const kinds = (k: string) => allTasks(plan).filter((t) => t.kind === k);
  assert.ok(kinds('interview').length >= 6);
  assert.ok(kinds('apply').length >= 5);
  const projects = kinds('project');
  assert.equal(projects.length, 6);
  for (const p of projects) assert.ok(p.skillIds.length >= 2);
  const learnWithResource = kinds('learn').filter((t) => t.resource);
  assert.ok(learnWithResource.length > 0 && learnWithResource.every((t) => t.resource!.url.startsWith('https://') && !t.resource!.verified));
});

test('the allocation is deterministic', () => {
  const a = buildPlan({ gap: GAP, goal: GOAL, prereqs, now: 'x' });
  const b = buildPlan({ gap: GAP, goal: GOAL, prereqs, now: 'x' });
  assert.deepEqual(a, b);
});

test('model wording keeps ids and hours, and a failing model leaves the fallback', async () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const first = plan.weeks[0].tasks[0];
  const ask: Ask = async <T>() => ({ weeks: [{ index: 1, theme: 'Model basics', checkpointTitle: 'Explain it', checkpointDescription: 'Explain tokens.', tasks: [{ id: first.id, title: 'Read the tokenizer chapter', resourceQuery: 'tokenizer explained' }, { id: 'bogus', title: 'x' }] }] }) as T;
  const out = await wordPlan(plan, { gap: GAP, goal: GOAL }, ask);
  assert.equal(out.worded, true);
  assert.equal(out.plan.weeks[0].theme, 'Model basics');
  assert.equal(out.plan.weeks[0].tasks[0].title, 'Read the tokenizer chapter');
  assert.equal(out.plan.weeks[0].tasks[0].hours, first.hours);
  assert.equal(out.plan.weeks[0].tasks[0].id, first.id);
  const broken: Ask = async () => { throw new Error('down'); };
  const fb = await wordPlan(plan, { gap: GAP, goal: GOAL }, broken);
  assert.equal(fb.worded, false);
  assert.deepEqual(fb.plan, plan);
});

function doneThrough(plan: Plan, week: number): Plan {
  let p = plan;
  for (const w of plan.weeks) if (w.index <= week) for (const t of w.tasks) p = setTaskStatus(p, t.id, 'done', `${w.startDate}T18:00:00.000Z`)!;
  return p;
}

test('ticking tasks moves skills to learning; passed checkpoints raise have; completion reaches need', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const start = startLevels(GAP);
  const first = plan.weeks[0].tasks.find((t) => t.kind === 'learn')!;
  const id = first.skillIds[0];
  const s0 = GAP.skills.find((s) => s.id === id)!;

  const one = setTaskStatus(plan, first.id, 'done', '2026-10-27T10:00:00Z')!;
  let moves = skillMoves(GAP, one, start);
  assert.equal(moves.status[id], 'learning');
  assert.equal(moves.raise[id], undefined, 'no raise before a checkpoint passes');

  const lastWeek = Math.max(...plan.weeks.filter((w) => w.tasks.some((t) => (t.kind === 'learn' || t.kind === 'practice') && t.skillIds.includes(id))).map((w) => w.index));
  let all = doneThrough(plan, lastWeek);
  assert.equal(skillMoves(GAP, all, start).raise[id], undefined, 'done but no checkpoint yet');
  all = setCheckpoint(all, 1, true)!;
  moves = skillMoves(GAP, all, start);
  if (lastWeek > 1) {
    assert.ok(moves.raise[id].level > s0.have && moves.raise[id].level < s0.need, 'partial credit for week 1');
    assert.match(moves.raise[id].evidence, /checkpoints passed/);
  }
  for (let w = 1; w <= lastWeek; w++) all = setCheckpoint(all, w, true)!;
  moves = skillMoves(GAP, all, start);
  assert.equal(moves.raise[id].level, s0.need);
  assert.match(moves.raise[id].evidence, new RegExp(`passed the week ${lastWeek} checkpoint`));

  // a failed last checkpoint holds the skill short of need
  const failed = setCheckpoint(all, lastWeek, false)!;
  assert.ok((skillMoves(GAP, failed, start).raise[id]?.level ?? 0) < s0.need);

  // un-ticking everything sends a learning skill back to open, and never lowers have
  const learning: GapMap = { ...GAP, skills: GAP.skills.map((s) => (s.id === id ? { ...s, status: 'learning' } : s)) };
  const back = skillMoves(learning, plan, start);
  assert.equal(back.status[id], 'open');
  assert.equal(back.raise[id], undefined);
  // closed skills keep their status
  assert.equal(skillMoves(GAP, one, start).status['sql'], undefined);
});

test('replan rolls late tasks forward and records what moved', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const today = addDays(GOAL.startDate, 15); // week 3
  const next = replan({ plan, goal: GOAL, today, gap: GAP, now: 'now', reason: 'Missed two weeks' });
  assert.equal(next.version, 2);
  assert.equal(next.weeks[0].tasks.filter((t) => t.status === 'todo').length, 0);
  assert.equal(next.weeks[1].tasks.filter((t) => t.status === 'todo').length, 0);
  const change = next.changes[0];
  assert.equal(change.reason, 'Missed two weeks');
  assert.match(change.summary, /rolled 8 late tasks from before week 3 forward/i);
  assert.ok(change.moved.some((m) => m.includes('week 1 to week 3')));
  for (const w of next.weeks.slice(2)) assert.ok(w.hours <= GOAL.hoursPerWeek + 1e-9, `week ${w.index} ${w.hours}h`);
  // nothing is deleted: overflow is marked skipped, and split tasks keep their hours
  const hours = (p: Plan) => Math.round(allTasks(p).reduce((a, t) => a + t.hours, 0) * 10) / 10;
  assert.equal(hours(next), hours(plan));
  const ids = new Set(allTasks(next).map((t) => t.id));
  assert.ok(allTasks(plan).every((t) => ids.has(t.id)));
  // learning order holds: each skill's learn tasks still come before its practice tasks
  const seq = allTasks(next).filter((t) => t.status === 'todo' && (t.kind === 'learn' || t.kind === 'practice') && t.skillIds.length === 1);
  for (const id of new Set(seq.map((t) => t.skillIds[0]))) {
    const kinds = seq.filter((t) => t.skillIds[0] === id).map((t) => t.kind).join(',');
    assert.ok(!/practice,learn/.test(kinds), `${id}: ${kinds}`);
  }
  // the plan was full, so the lowest-priority tail is dropped rather than overloading week 12
  assert.match(change.summary, /dropped \d+ low-priority tasks?/);
  const dropped = allTasks(next).filter((t) => t.status === 'skipped');
  assert.ok(dropped.length > 0);
  assert.ok(change.moved.some((m) => m.startsWith('Dropped ')));
  assert.ok(change.moved.length < 25, `${change.moved.length} lines`);
  assert.ok(!dropped.some((t) => t.skillIds.includes('llm-evaluation') && t.kind === 'learn'), 'top-priority learning survives');
});

test('a closed skill frees its remaining hours', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const gap: GapMap = { ...GAP, skills: GAP.skills.map((s) => (s.id === 'prd-writing' ? { ...s, status: 'closed', have: 3 } : s)) };
  const next = replan({ plan, goal: GOAL, today: GOAL.startDate, gap, now: 'now' });
  const prd = allTasks(next).filter((t) => (t.kind === 'learn' || t.kind === 'practice') && t.skillIds.length === 1 && t.skillIds[0] === 'prd-writing');
  assert.ok(prd.length > 0 && prd.every((t) => t.status === 'skipped'));
  assert.match(next.changes[0].summary, /freed [\d.]+h from closed skills/i);
});

test('a failed checkpoint adds one repair block, and a weak interview adds a drill', () => {
  let plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  plan = doneThrough(plan, 2);
  plan = setCheckpoint(plan, 2, false)!;
  const today = addDays(GOAL.startDate, 15);
  const next = replan({ plan, goal: GOAL, today, gap: GAP, interviewAvg: 42, now: 'now' });
  const repair = allTasks(next).filter((t) => t.id === 'repair-w2');
  assert.equal(repair.length, 1);
  assert.ok(next.weeks[2].tasks.some((t) => t.id === 'repair-w2'));
  assert.ok(allTasks(next).some((t) => t.id.startsWith('drill-') && t.kind === 'interview'));
  const again = replan({ plan: next, goal: GOAL, today, gap: GAP, interviewAvg: 42, now: 'later' });
  assert.equal(allTasks(again).filter((t) => t.id.startsWith('repair-w2')).length, 1, 'no second repair block');
  assert.equal(allTasks(again).filter((t) => t.id.startsWith('drill-')).length, 1, 'no second drill while one is pending');
  assert.equal(again.version, 3);
});

test('replan with nothing to do says so', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const next = replan({ plan, goal: GOAL, today: GOAL.startDate, gap: GAP, now: 'now' });
  assert.match(next.changes[0].summary, /Nothing needed to move/);
  assert.deepEqual(next.weeks.map((w) => w.tasks.map((t) => t.id)), plan.weeks.map((w) => w.tasks.map((t) => t.id)));
});

test('calendar export is valid iCalendar with folded lines', () => {
  const plan = buildPlan({ gap: GAP, goal: GOAL, prereqs });
  const ics = toIcs(plan, new Date('2026-11-21T10:00:00Z'));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  const events = ics.match(/BEGIN:VEVENT/g)!.length;
  assert.equal(events, allTasks(plan).length + plan.weeks.length);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.match(ics, /DTSTART;VALUE=DATE:20261026/);
});
