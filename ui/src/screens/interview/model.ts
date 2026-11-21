import type { GapSkill, InterviewQuestion, InterviewSession, InterviewTurn, Posting } from '../../api/types';

export type SessionKind = InterviewSession['kind'];

export const CRITERIA = ['Structure', 'Relevance to the role', 'Depth', 'Evidence and metrics', 'Clarity'] as const;

// The 1, 3 and 5 anchors the judge scores against (same wording as coach/src/interview.ts).
export const ANCHORS: Record<(typeof CRITERIA)[number], [string, string, string]> = {
  Structure: [
    'Hard to follow, with no clear point.',
    'A recognisable shape (situation, action, result or claim, reasons, conclusion) with gaps or a buried lead.',
    'Clear and easy to follow, ending with a strong conclusion.',
  ],
  'Relevance to the role': [
    'Does not answer the question or fit the target role.',
    'Answers the question, but the connection to the role is not clear.',
    "Answers directly, fits the target role, and addresses what the interviewer cares about.",
  ],
  Depth: [
    'Surface claims only, with no reasoning.',
    'Explains the main reasoning, but overlooks other options or risks.',
    'Shows deeper thinking: covers risks, lessons learned, and trade-offs.',
  ],
  'Evidence and metrics': [
    'No evidence at all.',
    'Mentions a fact or number, but does not connect it to the result.',
    'Clear starting point, measurable results, and an honest note on what you owned.',
  ],
  Clarity: [
    'Hard to follow, with too much jargon or rambling.',
    'Mostly clear, with some filler words or jargon.',
    'Crisp and memorable, with every sentence adding value.',
  ],
};

export const KINDS: { id: SessionKind; label: string; line: string; mix: string }[] = [
  { id: 'behavioural', label: 'Behavioural', line: 'Times you led, disagreed, cut scope, and owned a mistake.', mix: '5 behavioural' },
  { id: 'technical', label: 'Technical', line: 'Model quality, retrieval, cost, and the trade-offs behind them.', mix: '5 technical' },
  { id: 'case', label: 'Case', line: 'An open product problem, worked through out loud.', mix: '5 case' },
  { id: 'mixed', label: 'Mixed', line: 'Closest to a real interview: a little of everything.', mix: '2 behavioural, 2 technical, 1 case' },
];

export const kindLabel = (k: string) => KINDS.find((x) => x.id === k)?.label ?? k.charAt(0).toUpperCase() + k.slice(1);

export function prettySkill(id: string) {
  const s = id.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function skillName(id: string, skills?: GapSkill[]) {
  return skills?.find((s) => s.id === id)?.name ?? prettySkill(id);
}

export function turnFor(session: InterviewSession, questionId: string): InterviewTurn | undefined {
  return session.turns.find((t) => t.questionId === questionId);
}

export function isDone(session: InterviewSession) {
  return !!session.finishedAt || (session.questions.length > 0 && session.questions.every((q) => turnFor(session, q.id)));
}

export function sessionScore(session: InterviewSession): number | undefined {
  if (session.score !== undefined && session.score !== null) return session.score;
  if (!session.turns.length) return undefined;
  return Math.round(session.turns.reduce((a, t) => a + t.overall, 0) / session.turns.length);
}

export function firstOpen(session: InterviewSession) {
  const i = session.questions.findIndex((q) => !turnFor(session, q.id));
  return i < 0 ? 0 : i;
}

export function verdict(overall: number) {
  if (overall >= 85) return 'Strong. This would work well in a real interview.';
  if (overall >= 70) return 'Solid. A tweak or two away from strong.';
  if (overall >= 55) return 'Getting there. The fixes below matter.';
  return 'Needs work. Start with your lowest score.';
}

export function scoreFor(turn: InterviewTurn, criterion: string, index: number) {
  const key = criterion.toLowerCase();
  return turn.scores.find((s) => s.criterion.toLowerCase() === key) ?? turn.scores[index];
}

/** Mean score per criterion across the answered questions, 1-5. */
export function criterionAverages(turns: InterviewTurn[]) {
  return CRITERIA.map((c, i) => {
    const xs = turns.map((t) => scoreFor(t, c, i)?.score).filter((x): x is number => typeof x === 'number');
    return { criterion: c, avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, n: xs.length };
  });
}

/** Per probed skill: mean rubric score of its questions. Above 4 raises the skill a level. */
export function skillResults(session: InterviewSession) {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const t of session.turns) {
    const q = session.questions.find((x) => x.id === t.questionId);
    if (!q || !t.scores.length) continue;
    const mean = t.scores.reduce((a, s) => a + s.score, 0) / t.scores.length;
    for (const id of q.skillIds) {
      const a = acc.get(id) ?? { sum: 0, n: 0 };
      a.sum += mean;
      a.n++;
      acc.set(id, a);
    }
  }
  return [...acc.entries()].map(([id, a]) => ({ id, avg: a.sum / a.n, moved: a.sum / a.n > 4 })).sort((a, b) => b.avg - a.avg);
}

export function postingLabel(postings: Posting[] | undefined, id?: string) {
  if (!id) return undefined;
  const p = postings?.find((x) => x.id === id);
  return p ? { company: p.company, title: p.title } : undefined;
}

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/*
 * Finds each quote inside the answer (case and whitespace insensitive) and returns the
 * answer cut into runs, each run tagged with the criteria whose quote covers it.
 */
export function highlightRuns(answer: string, quotes: (string | undefined)[]) {
  let norm = '';
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < answer.length; i++) {
    const ch = answer[i];
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      lastSpace = true;
      norm += ' ';
    } else {
      lastSpace = false;
      norm += ch
        .toLowerCase()
        .replace(/[‘’]/, "'")
        .replace(/[“”]/, '"');
    }
    map.push(i);
  }
  const found: boolean[] = [];
  const ranges: { start: number; end: number; c: number }[] = [];
  quotes.forEach((q, c) => {
    const needle = (q ?? '')
      .replace(/^["'\s.…]+|["'\s…]+$/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"');
    const at = needle.length >= 3 ? norm.indexOf(needle) : -1;
    found[c] = at >= 0;
    if (at >= 0) ranges.push({ start: map[at], end: map[at + needle.length - 1] + 1, c });
  });
  const cuts = new Set<number>([0, answer.length]);
  ranges.forEach((r) => {
    cuts.add(r.start);
    cuts.add(r.end);
  });
  const points = [...cuts].sort((a, b) => a - b);
  const runs: { text: string; criteria: number[] }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    if (a === b) continue;
    runs.push({ text: answer.slice(a, b), criteria: ranges.filter((r) => r.start <= a && r.end >= b).map((r) => r.c) });
  }
  return { runs, found };
}

/** Splits a stronger answer into text and [placeholder] parts. */
export function placeholderParts(text: string) {
  return text.split(/(\[[^\]]{1,80}\])/g).filter(Boolean).map((part) => ({ part, hole: /^\[[^\]]+\]$/.test(part) }));
}

export function questionKindLabel(k: InterviewQuestion['kind']) {
  return kindLabel(k);
}
