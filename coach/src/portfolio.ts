import type { GapMap, GapSkill, Goal, Plan, PortfolioProject, Posting, Profile } from './types.ts';
import { joinNames, withArticle, type Ask } from './plan.ts';

export interface ProjectSeed {
  id: string; skillIds: string[]; weeks: number[]; postingQuotes: PortfolioProject['postingQuotes'];
}

// Projects follow the plan's project blocks; each must cover at least two open skills.
export function pickProjects(plan: Plan | undefined, gap: GapMap, postings: Posting[]): ProjectSeed[] {
  const open = gap.skills.filter((s) => s.status !== 'closed').sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const openIds = new Set(open.map((s) => s.id));
  const groups: { skillIds: string[]; weeks: number[] }[] = [];
  for (const w of plan?.weeks ?? []) {
    for (const t of w.tasks) {
      if (t.kind !== 'project' || t.status === 'skipped') continue;
      const key = [...t.skillIds].sort().join(',');
      const g = groups.find((x) => [...x.skillIds].sort().join(',') === key && !x.weeks.includes(w.index));
      if (g) g.weeks.push(w.index);
      else groups.push({ skillIds: [...t.skillIds], weeks: [w.index] });
    }
  }
  const W = plan?.weeks.length || 12;
  while (groups.length < 3) {
    const f = [0.25, 0.5, 0.75][groups.length];
    const s = Math.max(1, Math.round(W * f));
    groups.push({ skillIds: [], weeks: [s, Math.min(W, s + 1)].filter((x, i, a) => a.indexOf(x) === i) });
  }
  const used = new Set<string>();
  return groups.slice(0, 3).map((g, i) => {
    const ids = g.skillIds.filter((id) => openIds.has(id));
    for (const s of open) if (ids.length < 2 && !ids.includes(s.id) && !used.has(s.id)) ids.push(s.id);
    for (const s of open) if (ids.length < 2 && !ids.includes(s.id)) ids.push(s.id);
    // closed plan skills still belong to the project, after the open ones
    for (const id of g.skillIds) if (!ids.includes(id) && ids.length < 4) ids.push(id);
    ids.forEach((id) => used.add(id));
    return { id: `p${i + 1}`, skillIds: ids, weeks: g.weeks.sort((a, b) => a - b), postingQuotes: quotesFor(ids, postings) };
  });
}

export function quotesFor(skillIds: string[], postings: Posting[], max = 3): PortfolioProject['postingQuotes'] {
  const want = new Set(skillIds);
  const cands: { company: string; quote: string; must: boolean; fit: number }[] = [];
  for (const p of postings) for (const s of p.skills ?? []) {
    if (want.has(s.skillId) && s.quote?.trim()) cands.push({ company: p.company, quote: s.quote.trim(), must: s.importance === 'must', fit: p.fit ?? 0 });
  }
  cands.sort((a, b) => Number(b.must) - Number(a.must) || b.fit - a.fit || a.company.localeCompare(b.company));
  const out: PortfolioProject['postingQuotes'] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c.company)) continue;
    seen.add(c.company);
    out.push({ company: c.company, quote: c.quote });
    if (out.length >= max) break;
  }
  return out;
}

interface Template {
  keys: string[];
  title: string; pitch: (names: string) => string; brief: (names: string, role: string) => string;
  milestones: string[]; deliverables: string[]; reviewerSees: string;
}

const TEMPLATES: Template[] = [
  {
    keys: ['llm-evaluation', 'prompt-engineering', 'responsible-ai', 'ai-cost-latency', 'llm-fundamentals'],
    title: 'Ship-or-not scorecard for an LLM support assistant',
    pitch: (n) => `An evaluation set and scorecard that decides whether a support assistant is ready to launch, built around ${n}.`,
    brief: (n, role) => `Pick a public product's help centre. Write 50 real-looking customer questions with expected answers, including ten that should be refused or escalated. Run two prompt versions of an assistant over the set, score each answer for correctness, tone and safety, and set pass thresholds before you look at the results. Close with the call ${role} would make: ship, ship behind a flag, or hold, and what it would take to change the call. This shows ${n} as working judgement, not vocabulary.`,
    milestones: ['Golden set of 50 questions with expected answers', 'Two prompt versions scored against the set', 'Ship decision memo and scorecard'],
    deliverables: ['Golden set (CSV) with expected answers and refusal cases', 'Scorecard with thresholds set before the run', 'Two-page decision memo: ship, flag or hold'],
    reviewerSees: 'You can define what good means for a model feature, measure it honestly and make a launch call from the numbers.',
  },
  {
    keys: ['experimentation', 'product-analytics', 'metrics-definition', 'sql'],
    title: 'Experiment readout on a public product dataset',
    pitch: (n) => `A full experiment write-up from hypothesis to decision, practising ${n} on real data.`,
    brief: (n, role) => `Take a public e-commerce or app-usage dataset. Define a north-star metric and two guardrails, then frame one change as an A/B test: hypothesis, unit of randomisation, sample size and stopping rule. Simulate or slice the data to produce a result, write the SQL, and draft the readout ${role} would send: what happened, how sure we are, and the decision. It turns ${n} into something a hiring manager can read in five minutes.`,
    milestones: ['Metric tree and experiment design doc', 'SQL analysis and result charts', 'One-page readout with the decision'],
    deliverables: ['Metric tree with north star and guardrails', 'Experiment design with sample size and stopping rule', 'SQL notebook and a one-page readout'],
    reviewerSees: 'You can choose the right metric, design a fair test and say what the result means without overclaiming.',
  },
  {
    keys: ['product-discovery', 'user-research', 'prd-writing', 'product-strategy'],
    title: 'From five user interviews to an AI feature PRD',
    pitch: (n) => `A discovery-to-spec case study that shows ${n} end to end.`,
    brief: (n, role) => `Choose a workflow people find tedious (expense reports, meeting notes, support triage). Interview five people who do it, synthesise what you heard into one problem statement with evidence, and size the opportunity. Write the PRD ${role} would hand to engineering: users, jobs, success metrics, model behaviour and failure handling, what is out of scope, and launch criteria. Include the interview notes so a reviewer can trace each requirement back to a quote.`,
    milestones: ['Five interviews done and synthesised', 'Problem statement and opportunity sizing', 'PRD with success metrics and launch criteria'],
    deliverables: ['Interview notes and synthesis board', 'Problem statement with evidence', 'PRD with metrics, failure handling and scope'],
    reviewerSees: 'You start from users rather than technology and can write a spec an engineering team could build from.',
  },
  {
    keys: ['rag', 'ai-agents', 'apis', 'system-design', 'technical-fluency', 'ml-fundamentals', 'fine-tuning'],
    title: 'Retrieval prototype with the PM spec beside it',
    pitch: (n) => `A small working prototype plus the product spec that explains its trade-offs in ${n}.`,
    brief: (n, role) => `Build a minimal retrieval assistant over a public documentation set. Keep the code small; the point is the product thinking around it. Document chunking and model choices as trade-offs between quality, latency and cost, measure answer quality on twenty questions, and write the spec ${role} would own: who it is for, what it must never do, how you would know it is working. Your engineering background is the bridge here; the spec is what proves the move to product.`,
    milestones: ['Working prototype over a public doc set', 'Quality, latency and cost measured on 20 questions', 'Spec with trade-offs and success criteria'],
    deliverables: ['Prototype repository with a short README', 'Measurement table: quality, latency, cost per answer', 'Product spec with trade-offs and guardrails'],
    reviewerSees: 'You understand how model features are built and can turn technical trade-offs into product decisions.',
  },
  {
    keys: ['roadmapping', 'prioritization', 'stakeholder-management', 'go-to-market', 'pricing', 'cross-functional-leadership'],
    title: 'Six-month roadmap and launch plan for a developer API',
    pitch: (n) => `A roadmap, prioritisation and launch plan that shows ${n} on a realistic product.`,
    brief: (n, role) => `Pick a public developer API you know from engineering work. Gather twenty requests from its forums or changelog, score them with a stated framework, and turn the top ones into a six-month roadmap with the reasoning for what is cut. Plan the launch of the first item: audience, pricing or packaging change if any, docs, and the metric that says it landed. Write the stakeholder update ${role} would send to engineering, sales and support.`,
    milestones: ['Request inventory and prioritisation scores', 'Six-month roadmap with cut list', 'Launch plan and stakeholder update'],
    deliverables: ['Scored request inventory', 'Roadmap with explicit trade-offs', 'Launch plan and a stakeholder update email'],
    reviewerSees: 'You can say no with reasons, sequence work and bring several teams along.',
  },
];

function generic(names: string): Template {
  return {
    keys: [],
    title: `${names}: a worked case study`,
    pitch: () => `A case study that shows ${names} applied to a real product problem.`,
    brief: (_n, role) => `Pick a product you use and a problem it has. Apply ${names} to it the way ${role} would, write down the decision you would make and why, and back it with whatever evidence you can gather in public: reviews, changelogs, usage data, five short user conversations.`,
    milestones: ['Problem chosen and evidence gathered', 'Analysis and decision drafted', 'Write-up published'],
    deliverables: ['Evidence log', 'Decision write-up', 'Five-minute walkthrough recording'],
    reviewerSees: `You can apply ${names} to a real problem and explain your reasoning.`,
  };
}

function chooseTemplate(skills: GapSkill[], used: Set<Template>): Template | undefined {
  let best: Template | undefined;
  let bestScore = 0;
  for (const t of TEMPLATES) {
    if (used.has(t)) continue;
    const score = skills.reduce((a, s, i) => a + (t.keys.includes(s.id) ? 3 - Math.min(i, 2) * 0.5 : 0), 0);
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

export function fallbackProjects(seeds: ProjectSeed[], gap: GapMap, goal?: Goal): PortfolioProject[] {
  const byId = new Map(gap.skills.map((s) => [s.id, s]));
  const used = new Set<Template>();
  const role = goal?.targetRole || 'product manager';
  return seeds.map((seed) => {
    const skills = seed.skillIds.map((id) => byId.get(id)).filter((s): s is GapSkill => !!s);
    const names = joinNames(skills.slice(0, 3).map((s) => s.name)) || 'the target skills';
    const t = chooseTemplate(skills, used) ?? generic(names);
    used.add(t);
    return {
      id: seed.id, title: t.title, pitch: t.pitch(names), skillIds: seed.skillIds, brief: t.brief(names, withArticle(role)),
      milestones: milestoneWeeks(seed.weeks, t.milestones),
      deliverables: t.deliverables, reviewerSees: t.reviewerSees, postingQuotes: seed.postingQuotes, status: 'idea',
    };
  });
}

function milestoneWeeks(weeks: number[], titles: string[]): PortfolioProject['milestones'] {
  const first = weeks[0] ?? 1;
  const last = weeks[weeks.length - 1] ?? first;
  const at = [first, last, Math.max(last, first + 1)];
  return titles.slice(0, 3).map((title, i) => ({ title, week: at[i] }));
}

const SCHEMA = {
  type: 'object',
  properties: {
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          pitch: { type: 'string' },
          brief: { type: 'string' },
          milestones: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, week: { type: 'integer' } }, required: ['title', 'week'] } },
          deliverables: { type: 'array', items: { type: 'string' } },
          reviewerSees: { type: 'string' },
        },
        required: ['id', 'title', 'pitch', 'brief', 'milestones', 'deliverables', 'reviewerSees'],
      },
    },
  },
  required: ['projects'],
};

export async function buildPortfolio(
  ctx: { plan?: Plan; gap: GapMap; postings: Posting[]; goal?: Goal; profile?: Profile },
  ask: Ask | null,
): Promise<{ projects: PortfolioProject[]; worded: boolean; error?: string }> {
  const seeds = pickProjects(ctx.plan, ctx.gap, ctx.postings);
  const fallback = fallbackProjects(seeds, ctx.gap, ctx.goal);
  if (!ask) return { projects: fallback, worded: false };
  const byId = new Map(ctx.gap.skills.map((s) => [s.id, s]));
  const p = ctx.profile;
  const prompt = [
    `Target role: ${ctx.goal?.targetRole ?? 'product manager'}.`,
    p ? `Person: ${p.currentRole}, ${p.yearsExperience} years. ${p.summary}` : '',
    p?.projects.length ? `Things they have built: ${p.projects.join('; ')}` : '',
    'Write one portfolio project for each slot. Keep the ids. Milestone weeks must be within the slot weeks or one week after.',
    ...seeds.map((s) => JSON.stringify({
      id: s.id, weeks: s.weeks, skills: s.skillIds.map((id) => byId.get(id)?.name ?? id),
      postingAsks: s.postingQuotes.map((q) => `${q.company}: "${q.quote}"`),
    })),
  ].filter(Boolean).join('\n');
  const system = `You design portfolio projects for people moving into a new role.
Each project must be doable alone in the given weeks at a few hours a week, use only public data or tools, and produce artefacts a hiring manager can open in five minutes.
It must exercise all the listed skills and answer what the quoted postings ask for. Build on the person's existing background where it helps.
title under 70 characters; pitch one sentence; brief 80 to 140 words, concrete steps; exactly 3 milestones; 3 deliverables; reviewerSees one sentence on what a hiring manager learns about the person.
Plain language, no hype, no emojis.`;
  try {
    const out = await ask<{ projects: { id: string; title: string; pitch: string; brief: string; milestones: { title: string; week: number }[]; deliverables: string[]; reviewerSees: string }[] }>(
      { task: 'portfolio.briefs', system, prompt, schema: SCHEMA, tier: 'smart' });
    let worded = false;
    const projects = fallback.map((f, i) => {
      const seed = seeds[i];
      const m = (out?.projects ?? []).find((x) => x?.id === f.id) ?? out?.projects?.[i];
      if (!m || !str(m.title) || !str(m.brief)) return f;
      worded = true;
      const allowed = new Set([...seed.weeks, (seed.weeks[seed.weeks.length - 1] ?? 1) + 1]);
      const milestones = (Array.isArray(m.milestones) ? m.milestones : [])
        .filter((x) => str(x?.title))
        .slice(0, 4)
        .map((x, j) => ({ title: str(x.title)!, week: allowed.has(Number(x.week)) ? Number(x.week) : f.milestones[Math.min(j, f.milestones.length - 1)].week }));
      const deliverables = (Array.isArray(m.deliverables) ? m.deliverables : []).map(str).filter((x): x is string => !!x).slice(0, 5);
      return {
        ...f,
        title: str(m.title)!, pitch: str(m.pitch) ?? f.pitch, brief: str(m.brief)!,
        milestones: milestones.length ? milestones : f.milestones,
        deliverables: deliverables.length ? deliverables : f.deliverables,
        reviewerSees: str(m.reviewerSees) ?? f.reviewerSees,
      };
    });
    return { projects, worded };
  } catch (e) {
    return { projects: fallback, worded: false, error: (e as Error).message };
  }
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() ? x.replace(/\s+/g, ' ').trim() : undefined;
}
