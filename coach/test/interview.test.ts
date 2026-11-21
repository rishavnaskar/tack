import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GapMap, GapSkill, InterviewQuestion, InterviewSession, InterviewTurn, RubricScore } from '../src/types.ts';
import {
  CRITERIA, fallbackQuestions, guardInvented, heuristicJudge, judge, judgeSystem, latestFinishedScore, makeQuestions, overallScore,
  recordTurn, sessionScore, skillEffects, verbatimQuote,
} from '../src/interview.ts';
import type { Ask } from '../src/plan.ts';

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

const Q: InterviewQuestion = { id: 'q1', kind: 'behavioural', text: 'Tell me about a time you used data to change a decision.', skillIds: ['experimentation'] };
const ANSWER = 'At my last job the checkout service timed out under load. I pulled two weeks of traces and showed p95 latency was 1,800 ms on the payment call. I proposed caching the tax lookup instead of adding servers, because it was cheaper. After the change p95 dropped to 400 ms and failed checkouts fell by 30%.';

const scores = (...s: number[]): RubricScore[] => CRITERIA.map((c, i) => ({ criterion: c, score: s[i], why: 'w' }));

test('overall is the mean rubric score on a 0-100 scale', () => {
  assert.equal(overallScore(scores(5, 5, 5, 5, 5)), 100);
  assert.equal(overallScore(scores(3, 3, 3, 3, 3)), 60);
  assert.equal(overallScore(scores(4, 3, 3, 2, 4)), 64);
  assert.equal(overallScore(scores(9, 0, 3, 3, 3)), 60, 'scores are clamped to 1-5');
});

test('quotes must be the candidate\'s own words', () => {
  assert.equal(verbatimQuote('p95 dropped to 400 ms', ANSWER), 'p95 dropped to 400 ms');
  assert.equal(verbatimQuote('"I PROPOSED caching the tax lookup"', ANSWER), 'I proposed caching the tax lookup');
  // a paraphrase snaps to the matching sentence
  assert.equal(verbatimQuote('proposed caching tax lookup rather than servers', ANSWER), 'I proposed caching the tax lookup instead of adding servers, because it was cheaper.');
  assert.equal(verbatimQuote('we launched a mobile app in Brazil', ANSWER), undefined);
});

test('the stronger answer may not invent numbers', () => {
  const better = 'p95 fell from 1,800 ms to 400 ms, saving 25% of infra cost and lifting conversion 12%.';
  assert.equal(guardInvented(better, ANSWER), 'p95 fell from 1,800 ms to 400 ms, saving [number] of infra cost and lifting conversion [number].');
  // digits inside words are not numbers, and numbers the question gave are allowed
  assert.equal(guardInvented('A D2C brand at 9 percent activation grew 3x in Q3.', ANSWER, 'Only 9 percent of brands turn it on.'), 'A D2C brand at 9 percent activation grew [number] in Q3.');
});

test('the heuristic judge rewards structure, numbers and reasoning', () => {
  const strong = heuristicJudge({ question: Q, answer: ANSWER, targetRole: 'AI Product Manager', skills: GAP.skills });
  const weak = heuristicJudge({ question: Q, answer: 'I like data and I think it is important for decisions.', targetRole: 'AI Product Manager', skills: GAP.skills });
  assert.deepEqual(strong.scores.map((s) => s.criterion), [...CRITERIA]);
  assert.ok(strong.overall > weak.overall, `${strong.overall} vs ${weak.overall}`);
  assert.ok(strong.scores[3].score >= 4, 'evidence');
  for (const s of strong.scores) if (s.quote) assert.ok(ANSWER.replace(/\s+/g, ' ').includes(s.quote.replace(/…$/, '')), s.quote);
  assert.ok(weak.fixes.length > 0);
  assert.ok(strong.followUp);
  assert.ok(!/\d/.test(guardInvented(strong.betterAnswer, ANSWER).replace(/1,800|400|30|95/g, '')));
});

test('model judgments are checked: fixed criteria, verbatim quotes, no invented facts', async () => {
  const ask: Ask = async <T>() => ({
    scores: [
      { criterion: 'structure', score: 4, why: 'Clear order.', quote: 'I pulled two weeks of traces' },
      { criterion: 'Relevance to the role', score: 3, why: 'Engineering framing.', quote: 'something the candidate never said' },
      { criterion: 'Depth', score: 7, why: 'Trade-off named.', quote: 'because it was cheaper' },
      { criterion: 'Evidence and metrics', score: 5, why: 'Before and after.', quote: 'p95 dropped to 400 ms' },
    ],
    strengths: ['Numbers'], fixes: ['Say who decided'], betterAnswer: 'Checkout failures fell 30% and revenue rose 8%.', followUp: 'Who signed off?',
  }) as T;
  const { turn, judged } = await judge({ question: Q, answer: ANSWER, targetRole: 'AI Product Manager' }, ask);
  assert.equal(judged, 'model');
  assert.deepEqual(turn.scores.map((s) => s.criterion), [...CRITERIA]);
  assert.equal(turn.scores[0].quote, 'I pulled two weeks of traces');
  assert.equal(turn.scores[1].quote, undefined);
  assert.equal(turn.scores[2].score, 5);
  assert.equal(turn.betterAnswer, 'Checkout failures fell 30% and revenue rose [number].');
  assert.equal(turn.followUp, 'Who signed off?');
  assert.equal(turn.overall, overallScore(turn.scores));
  const down: Ask = async () => { throw new Error('429'); };
  const fb = await judge({ question: Q, answer: ANSWER, targetRole: 'AI Product Manager' }, down);
  assert.equal(fb.judged, 'heuristic');
  assert.equal(fb.turn.scores.length, 5);
});

test('the judge prompt carries all five anchored criteria', () => {
  const sys = judgeSystem('AI Product Manager');
  for (const c of CRITERIA) assert.ok(sys.includes(`${c}:`));
  assert.ok(sys.includes('5 = ') && sys.includes('1 = '));
  assert.match(sys, /word for word/);
});

test('fallback questions follow the session kind and target open skills', async () => {
  const mixed = fallbackQuestions({ kind: 'mixed', gap: GAP, postings: [] });
  assert.deepEqual(mixed.map((q) => q.kind), ['behavioural', 'technical', 'case', 'behavioural', 'technical']);
  assert.equal(new Set(mixed.map((q) => q.text)).size, 5);
  const open = new Set(GAP.skills.filter((s) => s.status !== 'closed').map((s) => s.id));
  assert.ok(mixed.every((q) => q.skillIds.every((id) => open.has(id))));
  const tech = await makeQuestions({ kind: 'technical', gap: GAP, postings: [] }, null);
  assert.equal(tech.questions.length, 5);
  assert.ok(tech.questions.every((q) => q.kind === 'technical'));
  // tags follow what the question tests, not the rotation
  const ship = tech.questions.find((q) => q.text.includes('good enough to ship'))!;
  assert.deepEqual(ship.skillIds, ['llm-evaluation']);
  const ab = tech.questions.find((q) => q.text.includes('A/B test'));
  if (ab) assert.deepEqual(ab.skillIds, ['experimentation']);
});

function turn(questionId: string, s: number[], at: string): InterviewTurn {
  const sc = scores(...s);
  return { questionId, answer: 'a', scores: sc, overall: overallScore(sc), strengths: [], fixes: [], betterAnswer: '', at };
}

test('a session finishes when every question is answered, and strong skills get a boost', () => {
  const questions: InterviewQuestion[] = [
    { id: 'q1', kind: 'technical', text: 'a', skillIds: ['llm-evaluation'] },
    { id: 'q2', kind: 'technical', text: 'b', skillIds: ['llm-evaluation', 'experimentation'] },
    { id: 'q3', kind: 'case', text: 'c', skillIds: ['experimentation'] },
  ];
  let s: InterviewSession = { id: 's', kind: 'mixed', questions, turns: [], startedAt: '2026-11-01T10:00:00Z' };
  s = recordTurn(s, turn('q1', [5, 5, 4, 5, 5], '2026-11-01T10:05:00Z'));
  s = recordTurn(s, turn('q2', [4, 5, 4, 5, 4], '2026-11-01T10:10:00Z'));
  assert.equal(s.finishedAt, undefined);
  s = recordTurn(s, turn('q3', [2, 3, 2, 1, 3], '2026-11-01T10:15:00Z'));
  assert.equal(s.finishedAt, '2026-11-01T10:15:00Z');
  assert.equal(s.score, sessionScore(s));
  assert.equal(s.score, Math.round((96 + 88 + 44) / 3));
  assert.deepEqual(skillEffects(s), { 'llm-evaluation': 1 });
  // re-answering replaces the turn rather than adding one
  s = recordTurn(s, turn('q3', [5, 5, 5, 5, 5], '2026-11-01T10:20:00Z'));
  assert.equal(s.turns.length, 3);
  assert.equal(s.finishedAt, '2026-11-01T10:15:00Z');
  assert.equal(latestFinishedScore([s, { ...s, id: 't', finishedAt: '2026-10-01T00:00:00Z', score: 10 }]), s.score);
});
