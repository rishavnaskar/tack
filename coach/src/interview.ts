import type { GapMap, GapSkill, Goal, InterviewQuestion, InterviewSession, InterviewTurn, Posting, Profile, RubricScore } from './types.ts';
import { withArticle, type Ask } from './plan.ts';

export type SessionKind = InterviewSession['kind'];
type QKind = InterviewQuestion['kind'];

export const CRITERIA = ['Structure', 'Relevance to the role', 'Depth', 'Evidence and metrics', 'Clarity'] as const;

export const ANCHORS: Record<(typeof CRITERIA)[number], string[]> = {
  Structure: [
    'No discernible order; the point is hard to find.',
    'Some order, but context, actions and outcome are mixed together.',
    'A recognisable shape (situation, action, result or claim, reasons, conclusion) with gaps or a buried lead.',
    'Clear shape, leads with the answer, each part in its place.',
    'Tight, signposted structure; the listener always knows where they are and the close lands the point.',
  ],
  'Relevance to the role': [
    'Does not answer the question or has nothing to do with the target role.',
    'Touches the question but stays on the old job with no link to the target role.',
    'Answers the question; the link to the target role is implied, not stated.',
    'Answers directly and shows the thinking the target role needs (users, trade-offs, outcomes).',
    'Answers directly, frames everything in the target role\'s terms and anticipates what the interviewer cares about.',
  ],
  Depth: [
    'Surface claims only, no reasoning.',
    'Names what was done but not why, or what else was considered.',
    'Explains the main reasoning; alternatives or risks are thin.',
    'Explains reasoning, alternatives considered and the trade-off chosen.',
    'Shows second-order thinking: risks, what would change the decision, what was learned.',
  ],
  'Evidence and metrics': [
    'No evidence at all.',
    'Vague evidence ("it went well", "users liked it").',
    'One concrete fact or number, or evidence that is not tied to the outcome.',
    'Specific numbers or observations tied to the outcome.',
    'Baseline and result, how it was measured, and an honest note on attribution.',
  ],
  Clarity: [
    'Hard to follow; jargon or rambling hides the meaning.',
    'Understandable with effort; long sentences or filler.',
    'Clear enough, with some filler, hedging or unexplained jargon.',
    'Plain, concise language a non-specialist could follow.',
    'Crisp and memorable; every sentence earns its place.',
  ],
};

const STOP = new Set('the a an and or but of to in on for with at by from as is are was were be been it this that these those you your i we our my me us they them he she his her its not no so if then than into about how what why when where which who would could should will can do did does have has had just very really also more most some any one two'.split(' '));

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9'-]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

export function sentences(s: string): string[] {
  return s.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map((x) => x.trim()).filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

// A quote must be the candidate's own words. Return it if verbatim, else the closest sentence, else nothing.
export function verbatimQuote(quote: string | undefined, answer: string): string | undefined {
  if (!answer.trim()) return;
  const q = norm((quote ?? '').replace(/^["'\s.…]+|["'\s…]+$/g, ''));
  const a = norm(answer);
  if (q.length >= 3) {
    const i = a.indexOf(q);
    if (i >= 0) return answer.replace(/\s+/g, ' ').trim().slice(i, i + q.length);
  }
  if (!q) return;
  const qt = new Set(tokens(q));
  if (!qt.size) return;
  let best: string | undefined;
  let bestScore = 0;
  for (const s of sentences(answer)) {
    const st = tokens(s);
    const hit = st.filter((w) => qt.has(w)).length;
    const score = hit / Math.max(qt.size, 1);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 0.5 ? trimQuote(best!) : undefined;
}

function trimQuote(s: string, max = 30): string {
  const words = s.split(/\s+/);
  return words.length > max ? words.slice(0, max).join(' ') + '…' : s;
}

// A stronger answer may restructure but not add facts: numbers that neither the candidate nor
// the question gave become a placeholder. Digits inside words (B2B, D2C, Q3) are not numbers.
const NUMBER = /(?<![\w])\d[\d,.]*(\s?(%|percent|x|k|m|million|hours?|days?|weeks?|months?))?(?![A-Za-z0-9])/gi;

export function guardInvented(better: string, answer: string, given = ''): string {
  const said = new Set(([...`${answer} ${given}`.matchAll(NUMBER)]).map((m) => (m[0].match(/\d[\d,.]*/)?.[0] ?? '').replace(/,/g, '').replace(/\.$/, '')));
  return better.replace(NUMBER, (m) => {
    const core = (m.match(/\d[\d,.]*/)?.[0] ?? '').replace(/,/g, '').replace(/\.$/, '');
    return said.has(core) ? m : '[number]';
  });
}

const WEIGHTS = [1, 1, 1, 1, 1];

export function overallScore(scores: RubricScore[]): number {
  if (!scores.length) return 0;
  let sum = 0, wsum = 0;
  scores.forEach((s, i) => { const w = WEIGHTS[i] ?? 1; sum += clampScore(s.score) * w; wsum += w; });
  return Math.round((sum / wsum) * 20);
}

function clampScore(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 1;
}

// ---- questions ---------------------------------------------------------------

interface Template { kind: QKind; hints: string[]; text: (c: { company: string; role: string; skill: string }) => string }

const BANK: Template[] = [
  { kind: 'behavioural', hints: ['stakeholder', 'influence', 'communication', 'leadership'], text: () => 'Tell me about a time you had to change a decision you did not own. Who did you need to convince, and what moved them?' },
  { kind: 'behavioural', hints: ['prioriti', 'roadmap', 'strategy'], text: () => 'Describe a project where scope had to be cut late. How did you decide what to drop, and how did you tell people?' },
  { kind: 'behavioural', hints: ['data', 'analytic', 'sql', 'metric', 'experiment'], text: () => 'Tell me about a time you used data to change someone\'s mind. What was the data and what changed afterwards?' },
  { kind: 'behavioural', hints: ['user', 'research', 'discovery', 'customer'], text: () => 'Tell me about a time you found out what users actually needed was different from what was asked for.' },
  { kind: 'behavioural', hints: ['ownership', 'execution', 'delivery', 'agile'], text: () => 'Walk me through something you owned that went wrong. What did you do in the first week after, and what would you do differently?' },
  { kind: 'technical', hints: ['evaluation', 'eval', 'llm', 'quality'], text: ({ skill }) => `How would you decide whether an LLM feature is good enough to ship? Which ${skill.toLowerCase().includes('eval') ? 'evaluation set, metrics and thresholds' : 'metrics, data and thresholds'} would you use?` },
  { kind: 'technical', hints: ['rag', 'retrieval', 'llm-fundamentals', 'ml-fundamentals', 'fine-tuning'], text: () => 'Explain retrieval-augmented generation to an engineer and then to a sales lead. Which trade-offs would you raise with each?' },
  { kind: 'technical', hints: ['responsible', 'safety', 'guardrail', 'risk', 'trust'], text: () => 'How would you decide what an AI feature must never do, and how would you test for it before launch?' },
  { kind: 'technical', hints: ['agent', 'tool calling', 'automation'], text: () => 'An AI agent completes 80% of tasks but sometimes takes a wrong action. How would you decide what it is allowed to do on its own?' },
  { kind: 'technical', hints: ['experiment', 'a/b', 'testing'], text: () => 'How would you set up an A/B test for a new ranking model, and what would make you stop it early?' },
  { kind: 'technical', hints: ['cost', 'latency', 'infra', 'platform', 'apis', 'system'], text: () => 'A model-backed feature costs too much per request. How would you halve the cost without users noticing a drop in quality?' },
  { kind: 'technical', hints: ['spec', 'prd', 'requirement', 'writing'], text: () => 'What goes into a spec for an AI feature that would not be in a spec for an ordinary feature?' },
  { kind: 'case', hints: ['strategy', 'vision', 'discovery', 'go-to-market'], text: ({ company }) => `${company} wants to add an AI assistant to its product. How do you decide whether to build it, and what ships first?` },
  { kind: 'case', hints: ['metric', 'analytic', 'growth', 'funnel'], text: () => 'Weekly activation fell 12% the week after a release. Walk me through how you would find the cause.' },
  { kind: 'case', hints: ['evaluation', 'support', 'agent', 'quality'], text: ({ company }) => `Design the success metrics for an AI support agent at ${company}. What would you put on the dashboard on day one?` },
  { kind: 'case', hints: ['prioriti', 'roadmap', 'stakeholder'], text: ({ role }) => `You join as ${role} and three teams each want the model team's next quarter. How do you decide?` },
  { kind: 'case', hints: ['cost', 'latency', 'pricing', 'metric'], text: () => "An AI feature's weekly model cost doubled while usage grew 20%. What do you look at first, and what would you change?" },
  { kind: 'case', hints: ['fine-tuning', 'b2b', 'pricing', 'stakeholder'], text: ({ company }) => `A large customer of ${company} asks for a model tuned on their own data. How do you decide whether to say yes?` },
];

const PLAN_KINDS: Record<SessionKind, QKind[]> = {
  behavioural: ['behavioural', 'behavioural', 'behavioural', 'behavioural', 'behavioural'],
  technical: ['technical', 'technical', 'technical', 'technical', 'technical'],
  case: ['case', 'case', 'case', 'case', 'case'],
  mixed: ['behavioural', 'technical', 'case', 'behavioural', 'technical'],
};

export interface QuestionCtx {
  kind: SessionKind; gap?: GapMap; postings: Posting[]; posting?: Posting; goal?: Goal; profile?: Profile;
}

export function focusSkills(gap?: GapMap, posting?: Posting): GapSkill[] {
  const skills = gap?.skills ?? [];
  const open = skills.filter((s) => s.status !== 'closed').sort((a, b) => b.priority - a.priority);
  if (posting?.skills?.length) {
    const ids = new Set(posting.skills.map((s) => s.skillId));
    const hit = open.filter((s) => ids.has(s.id));
    return [...hit, ...open.filter((s) => !ids.has(s.id))].slice(0, 6);
  }
  return open.slice(0, 6);
}

// hints are in order of preference: the first hint that names a skill wins
function matchSkill(hints: string[], skills: GapSkill[]): GapSkill | undefined {
  for (const h of hints) {
    const hit = skills.find((s) => `${s.id} ${s.name}`.toLowerCase().includes(h));
    if (hit) return hit;
  }
}

export function fallbackQuestions(ctx: QuestionCtx): InterviewQuestion[] {
  const skills = focusSkills(ctx.gap, ctx.posting);
  const open = (ctx.gap?.skills ?? []).filter((s) => s.status !== 'closed').sort((a, b) => b.priority - a.priority);
  const all = [...skills, ...open, ...(ctx.gap?.skills ?? [])];
  const role = ctx.goal?.targetRole || 'a product manager';
  const company = ctx.posting?.company || ctx.postings[0]?.company || 'A mid-size software company';
  const used = new Set<Template>();
  return PLAN_KINDS[ctx.kind].map((kind, i) => {
    const pool = BANK.filter((t) => t.kind === kind && !used.has(t));
    // rotate through the focus skills; a question is only tagged with a skill it actually tests
    const want = skills[i % Math.max(skills.length, 1)];
    const t = pool.find((x) => want && matchSkill(x.hints, [want])) ?? pool.find((x) => matchSkill(x.hints, skills))
      ?? pool.find((x) => matchSkill(x.hints, open)) ?? pool[0] ?? BANK.find((x) => x.kind === kind)!;
    used.add(t);
    const skill = matchSkill(t.hints, all);
    return {
      id: `q${i + 1}`, kind, text: t.text({ company, role, skill: skill?.name ?? '' }),
      skillIds: skill ? [skill.id] : [],
      ...(ctx.posting && kind !== 'behavioural' ? { fromPosting: ctx.posting.id } : {}),
    };
  });
}

const Q_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['behavioural', 'technical', 'case'] },
          text: { type: 'string' },
          skillIds: { type: 'array', items: { type: 'string' } },
          fromPosting: { type: 'string' },
        },
        required: ['kind', 'text', 'skillIds'],
      },
    },
  },
  required: ['questions'],
};

export async function makeQuestions(ctx: QuestionCtx, ask: Ask | null): Promise<{ questions: InterviewQuestion[]; worded: boolean; error?: string }> {
  const fallback = fallbackQuestions(ctx);
  if (!ask) return { questions: fallback, worded: false };
  const skills = focusSkills(ctx.gap, ctx.posting);
  const postings = ctx.posting ? [ctx.posting] : [...ctx.postings].sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0)).slice(0, 3);
  const kinds = PLAN_KINDS[ctx.kind];
  const prompt = [
    `Target role: ${ctx.goal?.targetRole ?? 'product manager'}.`,
    ctx.profile ? `Candidate: ${ctx.profile.currentRole}, ${ctx.profile.yearsExperience} years. ${ctx.profile.summary}` : '',
    `Write exactly 5 questions with these kinds in order: ${kinds.join(', ')}.`,
    'Skills the candidate is weakest on (use these ids in skillIds):',
    ...skills.map((s) => `- ${s.id}: ${s.name}`),
    'Postings (use the id in fromPosting when a question comes from one):',
    ...postings.map((p) => `- ${p.id}: ${p.title} at ${p.company}. ${p.text.replace(/\s+/g, ' ').slice(0, 900)}`),
  ].filter(Boolean).join('\n');
  const system = `You are a hiring manager interviewing a career changer for the target role.
Write questions a real interviewer at these companies would ask, grounded in the posting text and aimed at the candidate's weakest skills.
Behavioural questions ask for a specific past situation. Technical questions test the role's working knowledge. Case questions pose a concrete product problem at the posting's company.
One question per item, under 45 words, no preamble, no numbering.`;
  try {
    const out = await ask<{ questions: { kind: string; text: string; skillIds: string[]; fromPosting?: string }[] }>(
      { task: 'interview.questions', system, prompt, schema: Q_SCHEMA, tier: 'fast' });
    const known = new Set(skills.map((s) => s.id));
    const postingIds = new Set(postings.map((p) => p.id));
    const got = (out?.questions ?? []).filter((q) => typeof q?.text === 'string' && q.text.trim().length > 10);
    const questions = kinds.map((kind, i): InterviewQuestion => {
      const q = got[i];
      if (!q) return fallback[i];
      const ids = (Array.isArray(q.skillIds) ? q.skillIds : []).filter((id) => known.has(id));
      return {
        id: `q${i + 1}`,
        kind: ctx.kind === 'mixed' && ['behavioural', 'technical', 'case'].includes(q.kind) ? (q.kind as QKind) : kind,
        text: q.text.replace(/\s+/g, ' ').trim(),
        skillIds: ids.length ? ids.slice(0, 3) : fallback[i].skillIds,
        ...(q.fromPosting && postingIds.has(q.fromPosting) ? { fromPosting: q.fromPosting } : {}),
      };
    });
    return { questions, worded: got.length > 0 };
  } catch (e) {
    return { questions: fallback, worded: false, error: (e as Error).message };
  }
}

// ---- judging ---------------------------------------------------------------

export interface JudgeCtx { question: InterviewQuestion; answer: string; targetRole: string; posting?: Posting; skills?: GapSkill[] }

const NUM = /(\d[\d,.]*\s?(%|percent|x\b|ms\b|k\b|hours?|days?|weeks?|months?|people|users|customers)?)|(\b(two|three|four|five|six|seven|eight|nine|ten|twice|half|doubled|tripled)\b)/gi;
const HAS_NUM = new RegExp(NUM.source, 'i');
const MARKERS = ['situation', 'the context', 'my role', 'first', 'then', 'next', 'after that', 'finally', 'as a result', 'the result', 'in the end', 'because', 'so we', 'so i', 'what i learned', 'looking back', 'outcome', 'i decided', 'trade-off', 'instead'];
const DEPTH = ['because', 'trade-off', 'tradeoff', 'instead', 'considered', 'risk', 'alternative', 'why', 'decided', 'learned', 'would change', 'cost'];

export function heuristicJudge(ctx: JudgeCtx): Omit<InterviewTurn, 'at'> {
  const answer = ctx.answer.replace(/\s+/g, ' ').trim();
  const lower = answer.toLowerCase();
  const sents = sentences(answer);
  const words = answer.split(/\s+/).filter(Boolean).length;
  const nums = (answer.match(NUM) ?? []).length;
  const markers = MARKERS.filter((m) => lower.includes(m)).length;
  const depthHits = DEPTH.filter((m) => lower.includes(m)).length;
  const skillNames = (ctx.skills ?? []).filter((s) => ctx.question.skillIds.includes(s.id)).map((s) => s.name);
  const qt = new Set([...tokens(ctx.question.text), ...tokens(skillNames.join(' ')), ...tokens(ctx.targetRole)]);
  const at = new Set(tokens(answer));
  const overlap = qt.size ? [...qt].filter((w) => at.has(w)).length / qt.size : 0;
  const avgLen = words / Math.max(sents.length, 1);

  const structure = words < 25 ? 1 : clampScore(1 + Math.min(4, markers * 0.8 + (sents.length >= 4 ? 1 : 0)));
  const relevance = words < 15 ? 1 : clampScore(1 + overlap * 8);
  const depth = clampScore((words < 40 ? 1 : words < 90 ? 2 : words < 170 ? 3 : 4) + (depthHits >= 3 ? 1 : 0));
  const evidence = clampScore(1 + Math.min(4, nums));
  const clarity = words < 15 ? 2 : clampScore(avgLen <= 22 ? 5 : avgLen <= 28 ? 4 : avgLen <= 36 ? 3 : 2);

  const withNum = sents.find((s) => HAS_NUM.test(s));
  const longest = [...sents].sort((a, b) => b.length - a.length)[0];
  const relevant = [...sents].sort((a, b) => tokens(b).filter((w) => qt.has(w)).length - tokens(a).filter((w) => qt.has(w)).length)[0];
  const q = (s?: string) => (s ? trimQuote(s, 24) : undefined);

  const scores: RubricScore[] = [
    { criterion: 'Structure', score: structure, why: structure >= 4 ? 'The answer moves in a clear order from context to outcome.' : structure >= 3 ? 'There is a shape, but the outcome is not clearly separated from the actions.' : 'Context, actions and result are mixed together, so the point is hard to find.', quote: q(sents[0]) },
    { criterion: 'Relevance to the role', score: relevance, why: relevance >= 4 ? 'It answers the question directly in terms the role cares about.' : relevance >= 3 ? 'It answers the question, but the link to the target role is left implied.' : 'Most of the answer does not address what was asked.', quote: q(relevant) },
    { criterion: 'Depth', score: depth, why: depth >= 4 ? 'It explains the reasoning and the trade-off chosen.' : depth >= 3 ? 'It explains the main reasoning but not what else was considered.' : 'It says what happened but not why.', quote: q(longest) },
    { criterion: 'Evidence and metrics', score: evidence, why: evidence >= 4 ? 'Specific numbers back up the outcome.' : evidence >= 2 ? 'There is some concrete detail, but no baseline and result.' : 'There is no number or observable result.', quote: q(withNum) },
    { criterion: 'Clarity', score: clarity, why: clarity >= 4 ? 'Plain, concise sentences that are easy to follow.' : clarity >= 3 ? 'Mostly clear, with some long sentences.' : 'Long or very short sentences make it hard to follow.', quote: q(sents[sents.length - 1]) },
  ];
  for (const s of scores) if (!s.quote) delete s.quote;
  return finishTurn(ctx, scores, {
    strengths: scores.filter((s) => s.score >= 4).map((s) => STRENGTH[s.criterion]),
    fixes: scores.filter((s) => s.score <= 3).sort((a, b) => a.score - b.score).slice(0, 3).map((s) => FIX[s.criterion]),
    betterAnswer: restructure(answer),
    followUp: followUpFor(scores, ctx),
  });
}

const STRENGTH: Record<string, string> = {
  Structure: 'Easy to follow from context to outcome.',
  'Relevance to the role': 'Answers the question that was asked, in the role\'s terms.',
  Depth: 'Shows the reasoning behind the decision.',
  'Evidence and metrics': 'Backs the outcome with numbers.',
  Clarity: 'Plain and concise.',
};
const FIX: Record<string, string> = {
  Structure: 'Lead with the answer in one sentence, then situation, what you did, and the result.',
  'Relevance to the role': 'Name the user or business problem and say what you would do as the PM, not only as the engineer.',
  Depth: 'Say what else you considered and why you chose this path.',
  'Evidence and metrics': 'Give a before and after number, and how you measured it.',
  Clarity: 'Cut filler and split long sentences; one idea per sentence.',
};

function followUpFor(scores: RubricScore[], ctx: JudgeCtx): string {
  const weakest = [...scores].sort((a, b) => a.score - b.score)[0]?.criterion;
  switch (weakest) {
    case 'Evidence and metrics': return 'What number told you it worked, and what was it before?';
    case 'Depth': return 'What other option did you seriously consider, and why did you reject it?';
    case 'Relevance to the role': return `If you were the ${ctx.targetRole} on that team, what would you have done differently?`;
    case 'Structure': return 'In one sentence, what was the outcome?';
    default: return 'What would you do differently if you ran it again?';
  }
}

// Reorders the candidate's own sentences; adds nothing they did not say.
export function restructure(answer: string): string {
  const s = sentences(answer);
  if (s.length < 3) return s.length ? `${s.join(' ')} [Add what you did, why, and the measurable result.]` : '';
  const isResult = (x: string) => /result|outcome|in the end|went from|dropped|grew|increased|reduced|cut|saved|improved|so we|%/i.test(x);
  const results = s.filter(isResult);
  const rest = s.filter((x) => !isResult(x));
  const context = rest.slice(0, 1);
  const actions = rest.slice(1);
  const parts = [
    `Context: ${context.join(' ')}`,
    actions.length ? `What I did: ${actions.join(' ')}` : '',
    results.length ? `Result: ${results.join(' ')}` : 'Result: [state the measurable result you saw].',
  ].filter(Boolean);
  return parts.join('\n');
}

function finishTurn(ctx: JudgeCtx, scores: RubricScore[], rest: { strengths: string[]; fixes: string[]; betterAnswer: string; followUp?: string }): Omit<InterviewTurn, 'at'> {
  return {
    questionId: ctx.question.id,
    answer: ctx.answer,
    scores,
    overall: overallScore(scores),
    strengths: rest.strengths.slice(0, 3),
    fixes: rest.fixes.slice(0, 3),
    betterAnswer: rest.betterAnswer,
    ...(rest.followUp ? { followUp: rest.followUp } : {}),
  };
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string', enum: [...CRITERIA] },
          score: { type: 'integer', minimum: 1, maximum: 5 },
          why: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['criterion', 'score', 'why', 'quote'],
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
    betterAnswer: { type: 'string' },
    followUp: { type: 'string' },
  },
  required: ['scores', 'strengths', 'fixes', 'betterAnswer', 'followUp'],
};

export function judgeSystem(targetRole: string): string {
  const rubric = CRITERIA.map((c) => `${c}:\n` + ANCHORS[c].map((d, i) => `  ${i + 1} = ${d}`).join('\n')).join('\n');
  return `You are a demanding but fair interview coach preparing a career changer for ${withArticle(targetRole)} interview.
Score the answer on exactly these five criteria, each an integer from 1 to 5, using the anchors below. Score what is on the page, not what the candidate might have meant. Most first attempts land at 2 or 3; give 5 only when the anchor is fully met.

${rubric}

Rules:
- For every criterion give "why" (one sentence, specific to this answer) and "quote": a short span copied word for word from the candidate's answer that shows the reason. Never paraphrase inside "quote".
- strengths: up to 3 short points. fixes: up to 3 concrete changes, most important first.
- betterAnswer: rewrite the answer to score higher, in the first person, under 180 words. Use only facts, names and numbers the candidate stated. You may reorder, tighten and make the reasoning explicit. Where a number or result is missing, write a placeholder such as [number] or [result] instead of inventing one.
- followUp: the single probing question a sharp interviewer would ask next.
Plain language, no emojis.`;
}

export async function judge(ctx: JudgeCtx, ask: Ask | null): Promise<{ turn: Omit<InterviewTurn, 'at'>; judged: 'model' | 'heuristic'; error?: string }> {
  const fallback = heuristicJudge(ctx);
  if (!ask || !ctx.answer.trim()) return { turn: fallback, judged: 'heuristic' };
  const skillNames = (ctx.skills ?? []).filter((s) => ctx.question.skillIds.includes(s.id)).map((s) => s.name);
  const prompt = [
    `Question (${ctx.question.kind}): ${ctx.question.text}`,
    skillNames.length ? `Skills it tests: ${skillNames.join(', ')}` : '',
    ctx.posting ? `Posting: ${ctx.posting.title} at ${ctx.posting.company}. ${ctx.posting.text.replace(/\s+/g, ' ').slice(0, 700)}` : '',
    'Candidate answer:',
    '"""',
    ctx.answer.trim(),
    '"""',
  ].filter(Boolean).join('\n');
  try {
    const out = await ask<{ scores: RubricScore[]; strengths: string[]; fixes: string[]; betterAnswer: string; followUp: string }>(
      { task: 'interview.judge', system: judgeSystem(ctx.targetRole), prompt, schema: JUDGE_SCHEMA, tier: 'smart' });
    const byName = new Map((out?.scores ?? []).map((s) => [String(s.criterion).toLowerCase().trim(), s]));
    let fromModel = 0;
    const scores: RubricScore[] = CRITERIA.map((c, i) => {
      const s = byName.get(c.toLowerCase()) ?? [...byName.entries()].find(([k]) => k.startsWith(c.toLowerCase().split(' ')[0]))?.[1];
      if (!s) return fallback.scores[i];
      fromModel++;
      const quote = verbatimQuote(s.quote, ctx.answer);
      return { criterion: c, score: clampScore(s.score), why: String(s.why ?? '').trim() || fallback.scores[i].why, ...(quote ? { quote } : {}) };
    });
    if (!fromModel) throw new Error('judge returned no usable scores');
    const strings = (a: unknown) => (Array.isArray(a) ? a : []).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
    const better = typeof out.betterAnswer === 'string' && out.betterAnswer.trim() ? guardInvented(out.betterAnswer.trim(), ctx.answer, ctx.question.text) : fallback.betterAnswer;
    return {
      turn: finishTurn(ctx, scores, {
        strengths: strings(out.strengths).length ? strings(out.strengths) : fallback.strengths,
        fixes: strings(out.fixes).length ? strings(out.fixes) : fallback.fixes,
        betterAnswer: better,
        followUp: typeof out.followUp === 'string' && out.followUp.trim() ? out.followUp.trim() : fallback.followUp,
      }),
      judged: 'model',
    };
  } catch (e) {
    return { turn: fallback, judged: 'heuristic', error: (e as Error).message };
  }
}

// ---- session maths -----------------------------------------------------------

export function recordTurn(session: InterviewSession, turn: InterviewTurn): InterviewSession {
  const next = structuredClone(session);
  const i = next.turns.findIndex((t) => t.questionId === turn.questionId);
  if (i >= 0) next.turns[i] = turn;
  else next.turns.push(turn);
  const answered = new Set(next.turns.map((t) => t.questionId));
  if (next.questions.every((q) => answered.has(q.id))) {
    next.finishedAt ??= turn.at;
    next.score = sessionScore(next);
  }
  return next;
}

export function sessionScore(session: InterviewSession): number | undefined {
  if (!session.turns.length) return;
  return Math.round(session.turns.reduce((a, t) => a + t.overall, 0) / session.turns.length);
}

// Average rubric score per skill across the session; above 4 raises `have` by one level.
export function skillEffects(session: InterviewSession, step = 1): Record<string, number> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const t of session.turns) {
    const q = session.questions.find((x) => x.id === t.questionId);
    if (!q || !t.scores.length) continue;
    const mean = t.scores.reduce((a, s) => a + s.score, 0) / t.scores.length;
    for (const id of q.skillIds) {
      const a = acc.get(id) ?? { sum: 0, n: 0 };
      a.sum += mean; a.n++;
      acc.set(id, a);
    }
  }
  const out: Record<string, number> = {};
  for (const [id, a] of acc) if (a.sum / a.n > 4) out[id] = step;
  return out;
}

export function latestFinishedScore(sessions: InterviewSession[]): number | null {
  const done = sessions.filter((s) => s.finishedAt && s.score != null).sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!));
  return done.length ? done[done.length - 1].score! : null;
}
