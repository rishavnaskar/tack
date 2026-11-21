import type {
  Application,
  AppStatus,
  GapMap,
  GapSkill,
  Goal,
  InterviewSession,
  Kit,
  Plan,
  PlanTask,
  PlanWeek,
  PortfolioProject,
  Posting,
  Profile,
  Progress,
  Segment,
  TrackerInsights,
} from '../types';
import { BRIDGES, COMPANIES, FAMILY_WEIGHTS, LOCATIONS, MISSIONS, SKILLS, TITLES, type Family } from './catalog';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date) => d.toISOString();
const day = (s: string, add = 0) => {
  const d = new Date(`${s}T09:00:00Z`);
  d.setUTCDate(d.getUTCDate() + add);
  return d;
};
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export const TODAY = '2026-11-21';
export const PLAN_START = '2026-11-02';

export const RESUME_TEXT = `Avery Quinn
Backend engineer, payments. Bengaluru.

Five years building backend services in Go and Python at two fintech companies.

Vellum Payments, Senior Backend Engineer, 2023 to now
- Designed and shipped the public payments API used by 1,200 merchants, versioned across three releases
- Led the redesign of the settlement pipeline from nightly batch to event-driven, cutting reconciliation time from 9 hours to 40 minutes
- Rolled out the new retry logic behind a feature flag and compared recovery rates between cohorts for two weeks
- Built an internal prototype that answers support questions from runbooks using retrieval and a hosted model`;

export function demoProfile(source: Profile['source'] = 'demo'): Profile {
  return {
    name: 'Avery Quinn',
    headline: 'Backend engineer moving into AI product management',
    currentRole: 'Senior Backend Engineer, Payments',
    yearsExperience: 5,
    summary:
      'Five years building payment systems in Go and Python. Shipped a public API used by 1,200 merchants, rebuilt settlement to run in near real time, and built an internal retrieval prototype for support. Wants to own outcomes, not just services.',
    source,
    skills: [
      {
        id: 'technical-fluency',
        name: 'Technical fluency',
        level: 5,
        evidence: ['Five years building backend services in Go and Python at two fintech companies'],
      },
      {
        id: 'api-design',
        name: 'API design',
        level: 5,
        evidence: ['Designed and shipped the public payments API used by 1,200 merchants, versioned across three releases'],
      },
      {
        id: 'system-design',
        name: 'System design',
        level: 4,
        evidence: [
          'Led the redesign of the settlement pipeline from nightly batch to event-driven, cutting reconciliation time from 9 hours to 40 minutes',
        ],
      },
      {
        id: 'sql',
        name: 'SQL',
        level: 4,
        evidence: ['Wrote the SQL behind the weekly merchant health report read by the leadership team'],
      },
      {
        id: 'data-analysis',
        name: 'Data analysis',
        level: 3,
        evidence: ['Analysed six months of failed-payment logs to find the three retry rules that recovered 4% of declined volume'],
      },
      {
        id: 'written-communication',
        name: 'Written communication',
        level: 4,
        evidence: ['Wrote design docs and launch notes for every major change; two became team templates'],
      },
      {
        id: 'stakeholder-management',
        name: 'Stakeholder management',
        level: 3,
        evidence: ['Ran fortnightly reviews with finance and support on settlement changes'],
      },
      {
        id: 'experimentation',
        name: 'Experimentation',
        level: 2,
        evidence: ['Rolled out the new retry logic behind a feature flag and compared recovery rates between cohorts for two weeks'],
      },
      {
        id: 'llm-integration',
        name: 'LLM product integration',
        level: 2,
        evidence: ['Built an internal prototype that answers support questions from runbooks using retrieval and a hosted model'],
      },
      {
        id: 'prompt-design',
        name: 'Prompt design',
        level: 2,
        evidence: ['Tuned prompts for the runbook assistant against 60 real support questions'],
      },
      {
        id: 'model-evaluation',
        name: 'Model evaluation',
        level: 1,
        evidence: ['Kept a spreadsheet of 60 graded support answers to check the runbook assistant before each change'],
      },
      {
        id: 'cross-functional',
        name: 'Cross-functional leadership',
        level: 2,
        evidence: ['Coordinated a five-team launch of instant refunds across payments, risk, support and finance'],
      },
      {
        id: 'prioritisation',
        name: 'Prioritisation',
        level: 2,
        evidence: ['Owned the on-call backlog and ranked fixes by merchant impact each sprint'],
      },
      {
        id: 'product-metrics',
        name: 'Product metrics',
        level: 2,
        evidence: ['Defined the success metrics for instant refunds with the product manager'],
      },
      {
        id: 'prd-writing',
        name: 'Writing specs',
        level: 2,
        evidence: ['Wrote design docs and launch notes for every major change; two became team templates'],
      },
      {
        id: 'ml-fundamentals',
        name: 'ML fundamentals',
        level: 1,
        evidence: ['Completed an online course in machine learning foundations in 2025'],
      },
    ],
    experience: [
      {
        title: 'Senior Backend Engineer, Payments',
        company: 'Vellum Payments',
        start: '2023-04',
        end: 'present',
        bullets: [
          'Designed and shipped the public payments API used by 1,200 merchants, versioned across three releases',
          'Led the redesign of the settlement pipeline from nightly batch to event-driven, cutting reconciliation time from 9 hours to 40 minutes',
          'Built an internal prototype that answers support questions from runbooks using retrieval and a hosted model',
        ],
      },
      {
        title: 'Backend Engineer',
        company: 'Copperfield Credit',
        start: '2021-06',
        end: '2023-03',
        bullets: [
          'Analysed six months of failed-payment logs to find the three retry rules that recovered 4% of declined volume',
          'Wrote the SQL behind the weekly merchant health report read by the leadership team',
        ],
      },
    ],
    education: ['B.Tech, Computer Science, 2021'],
    projects: ['Runbook assistant (internal)', 'Settlement pipeline rebuild'],
  };
}

export function demoGoal(): Goal {
  return {
    targetRole: 'AI Product Manager',
    location: 'Bengaluru',
    remote: true,
    hoursPerWeek: 10,
    weeks: 12,
    startDate: PLAN_START,
    notes: 'Prefer scaleups. Open to platform PM roles.',
  };
}

export const ROLE_SUGGESTIONS = [
  { role: 'AI Product Manager', overlap: 58, why: 'Your retrieval prototype and API work cover the technical half of most postings.' },
  { role: 'Technical Product Manager', overlap: 74, why: 'System design and API ownership are the core asks, and you have shipped both.' },
  { role: 'Platform Product Manager', overlap: 69, why: 'Internal platform roles want engineers who think about developer experience.' },
  { role: 'Solutions Engineer, AI', overlap: 81, why: 'Closest to your current work; less of a pivot, faster to land.' },
  { role: 'Growth Product Manager', overlap: 44, why: 'Your feature-flag rollout is a start, but growth roles lean on experiments daily.' },
];

const FAMILY_MIX: [Family, number][] = [
  ['AI product', 16],
  ['Platform product', 7],
  ['Growth product', 7],
  ['Technical product', 6],
  ['Data product', 4],
];

function seniorityOf(title: string) {
  if (/associate/i.test(title)) return 'Associate';
  if (/lead|group/i.test(title)) return 'Lead';
  if (/senior/i.test(title)) return 'Senior';
  return 'Mid';
}

const SALARY: Record<string, string> = {
  Associate: '₹16–24 LPA',
  Mid: '₹26–38 LPA',
  Senior: '₹40–55 LPA',
  Lead: '₹55–72 LPA',
};

export function buildPostings(profile: Profile | undefined, seed = 7): Posting[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out: Posting[] = [];
  let n = 0;
  for (const [family, count] of FAMILY_MIX) {
    for (let k = 0; k < count; k++) {
      n++;
      const company = COMPANIES[(n * 7 + k * 3) % COMPANIES.length];
      const title = TITLES[family][(k + n) % TITLES[family].length];
      const seniority = seniorityOf(title);
      const location = LOCATIONS[(n * 5) % LOCATIONS.length];
      const weights = FAMILY_WEIGHTS[family];
      const chosen: { id: string; w: number }[] = [];
      for (const [id, w] of Object.entries(weights)) if (r() < w) chosen.push({ id, w });
      chosen.sort((a, b) => b.w - a.w);
      while (chosen.length < 5) {
        const extra = Object.entries(weights).find(([id]) => !chosen.some((c) => c.id === id));
        if (!extra) break;
        chosen.push({ id: extra[0], w: extra[1] });
      }
      const skills = chosen.slice(0, 9).map(({ id, w }) => {
        const s = SKILLS.find((x) => x.id === id)!;
        const importance: 'must' | 'nice' = r() < 0.3 + 0.55 * w ? 'must' : 'nice';
        return { skillId: s.id, name: s.name, importance, quote: s.quotes[Math.floor(r() * 3)] };
      });
      const must = skills.filter((s) => s.importance === 'must');
      const nice = skills.filter((s) => s.importance === 'nice');
      const doList = must.slice(0, Math.ceil(must.length / 2));
      const lookList = must.slice(doList.length);
      const teamSize = 4 + Math.floor(r() * 6);
      const remoteNote = location.startsWith('Remote') ? '' : r() < 0.4 ? ', with two office days a week' : '';
      const salary = r() < 0.7 ? SALARY[seniority] : undefined;
      const text = [
        `${company.name} ${company.blurb}`,
        `We are hiring a ${title} to ${pick(MISSIONS[family])}. You will work with a team of ${teamSize} engineers, a designer and a data scientist, and report to the ${seniority === 'Lead' ? 'VP of Product' : 'Head of Product'}.`,
        `What you will do\n${doList.map((s) => `- ${s.quote}`).join('\n')}`,
        lookList.length ? `What we look for\n${lookList.map((s) => `- ${s.quote}`).join('\n')}` : '',
        nice.length ? `Nice to have\n${nice.map((s) => `- ${s.quote}`).join('\n')}` : '',
        `This role is based in ${location}${remoteNote}.${salary ? ` Salary range: ${salary}.` : ''}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const posted = day(TODAY, -(1 + Math.floor(r() * 24)));
      out.push({
        id: `p${String(n).padStart(2, '0')}`,
        title,
        company: company.name,
        location,
        url: `https://jobs.${company.host}/roles/${slug(title)}-${n}`,
        source: r() < 0.6 ? 'careers page' : 'job board',
        postedAt: iso(posted),
        salary,
        text,
        harvestedAt: `${TODAY}T08:${String(10 + (n % 40)).padStart(2, '0')}:00.000Z`,
        live: false,
        roleFamily: family,
        seniority,
        companySize: company.size,
        skills,
        fit: profile ? postingFit(skills, profile) : undefined,
      });
    }
  }
  return out;
}

function haveOf(profile: Profile, id: string) {
  return profile.skills.find((s) => s.id === id)?.level ?? 0;
}

function postingFit(skills: NonNullable<Posting['skills']>, profile: Profile) {
  let num = 0;
  let den = 0;
  for (const s of skills) {
    const w = s.importance === 'must' ? 1 : 0.5;
    const need = s.importance === 'must' ? 4 : 3;
    num += w * Math.min(haveOf(profile, s.skillId) / need, 1);
    den += w;
  }
  return den ? Math.round(100 * (num / den)) : 0;
}

export function buildGap(postings: Posting[], profile: Profile): GapMap {
  const total = postings.length || 1;
  const skills: GapSkill[] = [];
  for (const s of SKILLS) {
    const asks = postings.filter((p) => p.skills?.some((x) => x.skillId === s.id));
    if (!asks.length) continue;
    const musts = asks.filter((p) => p.skills!.find((x) => x.skillId === s.id)!.importance === 'must');
    const demand = asks.length / total;
    const mustShare = musts.length / asks.length;
    const need = Math.max(1, Math.min(5, Math.round(1.6 + 2.2 * mustShare + 1.6 * demand)));
    const have = haveOf(profile, s.id);
    const ratio = have / need;
    const level = ratio >= 0.9 ? 'strong' : have > 0 && ratio >= 0.4 ? 'partial' : 'missing';
    const seen = new Set<string>();
    const quoteUses = new Map<string, number>();
    const postingQuotes: GapSkill['evidence']['postings'] = [];
    for (const limit of [1, 2]) {
      for (const p of [...musts, ...asks]) {
        const quote = p.skills!.find((x) => x.skillId === s.id)!.quote;
        if (seen.has(p.company) || postingQuotes.length >= 5 || (quoteUses.get(quote) ?? 0) >= limit) continue;
        seen.add(p.company);
        quoteUses.set(quote, (quoteUses.get(quote) ?? 0) + 1);
        postingQuotes.push({ postingId: p.id, company: p.company, quote });
      }
    }
    const priority = Math.max(0, Math.round((100 * demand * (need - have)) / 5 * (0.6 + 0.4 * mustShare)));
    skills.push({
      id: s.id,
      name: s.name,
      category: s.category,
      demand: Math.round(demand * 1000) / 1000,
      mustShare: Math.round(mustShare * 1000) / 1000,
      level,
      have,
      need,
      evidence: { resume: profile.skills.find((x) => x.id === s.id)?.evidence ?? [], postings: postingQuotes },
      bridge: level !== 'strong' ? BRIDGES[s.id] : undefined,
      priority,
      status: level === 'strong' ? 'closed' : 'open',
    });
  }
  skills.sort((a, b) => b.priority - a.priority);
  skills.slice(0, 2).forEach((s) => (s.status = 'learning'));

  let wsum = 0;
  let cov = 0;
  for (const s of skills) {
    wsum += s.demand;
    cov += s.demand * Math.min(s.have / s.need, 1);
  }
  const readiness = Math.round((100 * cov) / (wsum || 1));

  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    xs.forEach((x) => m.set(x, (m.get(x) ?? 0) + 1));
    return [...m.entries()].map(([name, c]) => ({ name, count: c })).sort((a, b) => b.count - a.count);
  };

  const top = skills.filter((s) => s.level !== 'strong').slice(0, 3);
  const strong = skills.filter((s) => s.level === 'strong').sort((a, b) => b.demand - a.demand).slice(0, 3);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lower = (n: string) => (/^[A-Z]{2,}/.test(n) ? n : n.toLowerCase());
  const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const summary = `${profile.name.split(' ')[0]} already covers the engineering side of these postings: ${and(
    strong.map((s) => lower(s.name)),
  )} each come with a shipped result on the résumé. The gap is product craft and AI quality. ${and(
    top.map((s) => `${lower(s.name)} (${pct(s.demand)} of postings)`),
  ).replace(/^./, (c) => c.toUpperCase())} carry the most weight and have little or no evidence yet. Closing those three would lift readiness by about ${Math.round(
    top.reduce((a, s) => a + (s.demand * (s.need - s.have)) / s.need, 0) * (100 / (wsum || 1)),
  )} points.`;

  return {
    postingCount: postings.length,
    generatedAt: `${TODAY}T08:52:00.000Z`,
    readiness,
    skills,
    summary,
    market: {
      topCompanies: count(postings.map((p) => p.company)).slice(0, 6),
      locations: count(postings.map((p) => p.location)),
      seniority: count(postings.map((p) => p.seniority ?? 'Mid')),
      salaryNote: 'Posted ranges run from ₹16 to ₹72 LPA. Mid-level AI PM roles in Bengaluru mostly sit between ₹26 and ₹38 LPA.',
    },
  };
}

const searchLink = (q: string) => ({ title: `Search: ${q}`, url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, verified: false });

const WEEK_THEMES: { theme: string; skills: string[]; tasks: [PlanTask['kind'], string, number, string?][]; checkpoint: [string, string] }[] = [
  {
    theme: 'How AI products are judged',
    skills: ['model-evaluation', 'llm-integration'],
    tasks: [
      ['learn', 'Read three public eval write-ups and note how each defines quality', 3, 'LLM evaluation case studies'],
      ['practice', 'Turn the 60 graded support answers into a rubric with five criteria', 3],
      ['project', 'Score the runbook assistant against the rubric and write up the misses', 3],
      ['interview', 'Practise: "How would you know your AI feature is good enough to ship?"', 1],
    ],
    checkpoint: ['Eval rubric reviewed', 'A five-criterion rubric with anchored scores, applied to 30 answers.'],
  },
  {
    theme: 'Discovery before building',
    skills: ['product-discovery', 'user-research'],
    tasks: [
      ['learn', 'Work through a continuous discovery primer and its interview guide', 2, 'continuous discovery habits interview guide'],
      ['practice', 'Interview four merchants about refund disputes', 4],
      ['project', 'Write an opportunity map from the interviews', 3],
      ['apply', 'Send two applications to scaleup platform roles', 1],
    ],
    checkpoint: ['Opportunity map shared', 'Four interviews synthesised into one map with the top three problems ranked.'],
  },
  {
    theme: 'Experiments with a decision rule',
    skills: ['experimentation', 'product-metrics'],
    tasks: [
      ['learn', 'Study A/B test design: power, guardrails and peeking', 3, 'A/B test design guardrail metrics'],
      ['practice', 'Rewrite the retry-logic rollout as a pre-registered experiment', 2],
      ['project', 'Build a metrics tree for the refund flow', 3],
      ['interview', 'Practise one metrics case out loud and record it', 1],
      ['apply', 'Send two applications to growth roles', 1],
    ],
    checkpoint: ['Experiment brief passes review', 'Hypothesis, primary metric, guardrail and stopping rule written down.'],
  },
  {
    theme: 'Specs people can build from',
    skills: ['prd-writing', 'prioritisation'],
    tasks: [
      ['learn', 'Read five strong PRDs and mark what each leaves out', 2, 'product requirements document examples'],
      ['project', 'Write a one-page PRD for a refund copilot', 4],
      ['practice', 'Rank a 20-item backlog with RICE and defend the top five', 2],
      ['interview', 'Practise a prioritisation question with a peer', 2],
    ],
    checkpoint: ['PRD reviewed by a PM', 'A working PM reads the PRD and could plan a sprint from it.'],
  },
  {
    theme: 'Prompting and its limits',
    skills: ['prompt-design', 'llm-integration'],
    tasks: [
      ['learn', 'Study prompt patterns, guardrails and fallbacks', 2, 'prompt engineering guardrails fallbacks'],
      ['project', 'Build the refund copilot prototype with retrieval over policy docs', 5],
      ['practice', 'Run the eval rubric on the prototype and fix the worst two failure types', 3],
    ],
    checkpoint: ['Prototype beats baseline', 'Copilot scores higher than the runbook assistant on the rubric.'],
  },
  {
    theme: 'Roadmaps and strategy',
    skills: ['roadmapping', 'stakeholder-management'],
    tasks: [
      ['learn', 'Read two product strategy memos and one roadmap teardown', 2, 'product strategy memo example'],
      ['project', 'Draft a six-month roadmap for the refund copilot', 3],
      ['practice', 'Present the roadmap to two engineers and log their objections', 2],
      ['apply', 'Send three applications from the apply-next list', 2],
      ['interview', 'Run a mock behavioural interview on influence without authority', 1],
    ],
    checkpoint: ['Roadmap survives review', 'Objections answered in writing; scope cut where it should be.'],
  },
  {
    theme: 'Responsible AI in practice',
    skills: ['responsible-ai', 'ml-fundamentals'],
    tasks: [
      ['learn', 'Read a model card guide and a published AI risk framework', 3, 'model card guide AI risk framework'],
      ['project', 'Write a risk review for the copilot: misuse, privacy, bias', 3],
      ['learn', 'Refresh precision, recall and ranking metrics with small exercises', 3, 'precision recall ranking metrics exercises'],
      ['interview', 'Practise: "What could go wrong with this AI feature?"', 1],
    ],
    checkpoint: ['Risk review complete', 'Each risk has an owner, a mitigation and a metric.'],
  },
  {
    theme: 'Go-to-market and pricing',
    skills: ['go-to-market', 'pricing'],
    tasks: [
      ['learn', 'Study usage-based pricing for AI features', 2, 'usage based pricing AI features'],
      ['project', 'Model inference cost per merchant for the copilot', 3],
      ['practice', 'Write the launch note, FAQ and sales one-pager', 3],
      ['apply', 'Send three applications to AI product roles', 2],
    ],
    checkpoint: ['Launch kit ready', 'Pricing assumption, cost model and launch note in one folder.'],
  },
  {
    theme: 'Portfolio polish',
    skills: ['written-communication', 'product-metrics'],
    tasks: [
      ['project', 'Write the copilot case study with before and after numbers', 4],
      ['project', 'Record a five-minute walkthrough of the prototype', 2],
      ['interview', 'Two mock interviews: one technical, one case', 3],
      ['apply', 'Update the résumé headline and send two applications', 1],
    ],
    checkpoint: ['Case study published', 'A reviewer can follow the problem, the bet and the result in five minutes.'],
  },
  {
    theme: 'Interview loop rehearsal',
    skills: ['cross-functional', 'stakeholder-management'],
    tasks: [
      ['interview', 'Full mock loop: product sense, execution, behavioural', 4],
      ['practice', 'Rewrite the three weakest answers from the mock loop', 2],
      ['apply', 'Send four applications ranked by response chance', 3],
      ['learn', 'Read the engineering blogs of the top three target companies', 1],
    ],
    checkpoint: ['Mock loop average above 70', 'Scores from the last three sessions average 70 or higher.'],
  },
  {
    theme: 'Second project',
    skills: ['experimentation', 'data-analysis'],
    tasks: [
      ['project', 'Run the pricing experiment teardown on a public product', 5],
      ['practice', 'Turn the teardown into a two-page memo', 2],
      ['apply', 'Send three applications', 2],
      ['interview', 'Practise a metrics case on the teardown', 1],
    ],
    checkpoint: ['Teardown memo shared', 'Memo with a recommendation and the data behind it.'],
  },
  {
    theme: 'Close and negotiate',
    skills: ['go-to-market', 'written-communication'],
    tasks: [
      ['interview', 'Prepare stories for the final round with numbers for each', 3],
      ['learn', 'Read up on offer negotiation for product roles', 1, 'product manager offer negotiation'],
      ['apply', 'Follow up on every open application', 2],
      ['practice', 'Write a 30-60-90 day plan for the most likely offer', 4],
    ],
    checkpoint: ['Ready for offers', 'Stories, plan and negotiation notes ready for the final rounds.'],
  },
];

export function buildPlan(goal: Goal): Plan {
  const weeks: PlanWeek[] = WEEK_THEMES.slice(0, goal.weeks).map((w, i) => {
    const start = day(goal.startDate, i * 7);
    const tasks: PlanTask[] = w.tasks.map(([kind, title, hours, q], j) => {
      const id = `w${i + 1}t${j + 1}`;
      const done = i < 2 || (i === 2 && j < 2);
      return {
        id,
        title,
        kind,
        skillIds: w.skills,
        hours,
        resource: q ? searchLink(q) : undefined,
        status: done ? 'done' : 'todo',
        doneAt: done ? iso(day(goal.startDate, i * 7 + 1 + j)) : undefined,
      };
    });
    return {
      index: i + 1,
      startDate: start.toISOString().slice(0, 10),
      theme: w.theme,
      skillIds: w.skills,
      hours: tasks.reduce((a, t) => a + t.hours, 0),
      tasks,
      checkpoint: { title: w.checkpoint[0], description: w.checkpoint[1], passed: i < 2 ? true : undefined },
    };
  });
  return {
    version: 2,
    createdAt: `${PLAN_START}T07:30:00.000Z`,
    weeks,
    changes: [
      {
        at: '2026-11-16T07:00:00.000Z',
        reason: 'Week 2 ran over by three hours',
        summary: 'Moved the merchant interviews synthesis into week 3 and trimmed one reading task so week 3 stays at 10 hours.',
        moved: ['w2t3', 'w3t1'],
      },
    ],
  };
}

export function buildPortfolio(): PortfolioProject[] {
  return [
    {
      id: 'refund-copilot',
      title: 'Refund copilot for support agents',
      pitch: 'An assistant that drafts refund decisions from policy and order history, with an eval rubric that decides when it is good enough to ship.',
      skillIds: ['llm-integration', 'model-evaluation', 'prompt-design', 'product-metrics'],
      brief:
        'Support agents spend four minutes per refund ticket checking policy. Build a copilot that drafts the decision and cites the policy line. Ship it behind a rubric: five criteria, 60 graded answers, a pass bar agreed with support leads.',
      milestones: [
        { title: 'Rubric and baseline', week: 1 },
        { title: 'Prototype with retrieval', week: 5 },
        { title: 'Risk review', week: 7 },
        { title: 'Case study and walkthrough', week: 9 },
      ],
      deliverables: ['Eval rubric and graded set', 'Working prototype', 'One-page PRD', 'Case study with numbers'],
      reviewerSees: 'A PM who can define quality for an AI feature before building it, then prove it with numbers.',
      postingQuotes: [
        { company: 'Tessellate', quote: 'Define evaluation sets and quality bars for model outputs before launch' },
        { company: 'Cinder Labs', quote: 'Ship features built on large language models, from prototype to production' },
      ],
      status: 'building',
    },
    {
      id: 'pricing-teardown',
      title: 'Pricing experiment teardown',
      pitch: 'A public teardown of how an AI writing tool prices usage, with a proposed experiment and the metrics to judge it.',
      skillIds: ['experimentation', 'pricing', 'data-analysis'],
      brief:
        'Pick a public AI product with usage-based pricing. Reverse-engineer its packaging, estimate inference cost per user, and design one pricing experiment with a hypothesis, guardrails and a stopping rule.',
      milestones: [
        { title: 'Cost model', week: 8 },
        { title: 'Experiment design', week: 11 },
        { title: 'Memo published', week: 11 },
      ],
      deliverables: ['Cost model spreadsheet', 'Experiment brief', 'Two-page memo'],
      reviewerSees: 'Commercial judgement and the discipline to test a pricing idea before rolling it out.',
      postingQuotes: [
        { company: 'Mintleaf Finance', quote: 'Work on packaging and pricing for usage-based AI features' },
        { company: 'Kestrel Pay', quote: 'Design and read A/B tests with clear hypotheses and guardrail metrics' },
      ],
      status: 'idea',
    },
    {
      id: 'merchant-discovery',
      title: 'Discovery sprint: merchant disputes',
      pitch: 'Four merchant interviews turned into an opportunity map and a ranked problem list.',
      skillIds: ['product-discovery', 'user-research', 'prd-writing'],
      brief:
        'Interview four merchants about refund disputes. Synthesise into an opportunity map, rank the top three problems by frequency and cost, and write a one-page PRD for the strongest one.',
      milestones: [
        { title: 'Interview guide', week: 2 },
        { title: 'Opportunity map', week: 2 },
        { title: 'PRD', week: 4 },
      ],
      deliverables: ['Interview guide', 'Opportunity map', 'One-page PRD'],
      reviewerSees: 'Someone who starts from the customer problem, not the solution.',
      postingQuotes: [
        { company: 'Loomwork', quote: 'Run discovery with customers and turn what you learn into clear problem statements' },
        { company: 'Orbit Learning', quote: 'Talk to users every week and bring their words back to the team' },
      ],
      status: 'shipped',
    },
  ];
}

const CRITERIA = ['Structure', 'Relevance to the role', 'Depth', 'Evidence and metrics', 'Clarity'];

export function buildInterviews(): InterviewSession[] {
  const s1: InterviewSession = {
    id: 'iv-1',
    kind: 'behavioural',
    startedAt: '2026-11-08T15:00:00.000Z',
    finishedAt: '2026-11-08T15:40:00.000Z',
    score: 56,
    questions: [
      { id: 'q1', kind: 'behavioural', text: 'Tell me about a time you changed what a team built because of something a customer said.', skillIds: ['product-discovery'] },
      { id: 'q2', kind: 'behavioural', text: 'Describe a launch where you had to align teams that did not report to you.', skillIds: ['cross-functional', 'stakeholder-management'] },
      { id: 'q3', kind: 'behavioural', text: 'Tell me about a decision you made with incomplete data.', skillIds: ['prioritisation'] },
      { id: 'q4', kind: 'behavioural', text: 'When did you say no to a senior stakeholder, and how did it go?', skillIds: ['stakeholder-management'] },
      { id: 'q5', kind: 'behavioural', text: 'What is the most useful piece of feedback you have received?', skillIds: ['written-communication'] },
    ],
    turns: [],
  };
  s1.turns = [
    {
      questionId: 'q2',
      answer:
        'For instant refunds I coordinated payments, risk, support and finance. I set up a weekly sync and a shared doc. We launched on time and refunds went from three days to under a minute.',
      scores: CRITERIA.map((c, i) => ({
        criterion: c,
        score: [3, 4, 2, 4, 3][i],
        why: [
          'Clear start and end, but the middle skips how conflicts were resolved.',
          'Cross-team launches are central to the platform PM roles you target.',
          'Says what you set up, not what was hard or what you decided.',
          'The three-days-to-a-minute result lands well.',
          'Short and easy to follow.',
        ][i],
        quote: ['I set up a weekly sync and a shared doc', 'payments, risk, support and finance', 'I set up a weekly sync', 'from three days to under a minute', undefined][i],
      })),
      overall: 62,
      strengths: ['Concrete outcome with a number', 'Names every team involved'],
      fixes: ['Name one disagreement and how you settled it', 'Say what you owned versus what the PM owned'],
      betterAnswer:
        'For instant refunds I was the engineering lead across payments, risk, support and finance. Risk wanted a manual review step that would have added a day. I pulled six months of refund data, showed that 92% of refunds were under ₹2,000 with near-zero fraud, and we agreed on auto-approval below that line. We launched on time and refunds went from three days to under a minute.',
      followUp: 'What would you have done if risk had still said no?',
      at: '2026-11-08T15:18:00.000Z',
    },
  ];

  const s2: InterviewSession = {
    id: 'iv-2',
    kind: 'mixed',
    postingId: 'p03',
    startedAt: '2026-11-17T16:00:00.000Z',
    finishedAt: '2026-11-17T16:45:00.000Z',
    score: 68,
    questions: [
      { id: 'q1', kind: 'technical', text: 'How would you decide whether a support copilot is good enough to launch?', skillIds: ['model-evaluation'], fromPosting: 'p03' },
      { id: 'q2', kind: 'case', text: 'Our AI assistant has high usage but flat retention. What do you look at first?', skillIds: ['product-metrics', 'data-analysis'], fromPosting: 'p03' },
      { id: 'q3', kind: 'behavioural', text: 'Tell me about a time an experiment surprised you.', skillIds: ['experimentation'] },
      { id: 'q4', kind: 'technical', text: 'Walk me through how retrieval-augmented generation fails in production.', skillIds: ['llm-integration'] },
      { id: 'q5', kind: 'case', text: 'How would you price an AI feature whose cost grows with usage?', skillIds: ['pricing'] },
    ],
    turns: [
      {
        questionId: 'q1',
        answer:
          'I would build a graded set of real questions, score answers on accuracy, tone and whether they cite the source, and agree a pass bar with support leads. I did a small version of this with 60 runbook questions.',
        scores: CRITERIA.map((c, i) => ({
          criterion: c,
          score: [4, 5, 3, 3, 4][i],
          why: [
            'Moves from method to bar to proof in order.',
            'Exactly what the posting asks for.',
            'Does not mention human review or regression over time.',
            'The 60-question set helps; a pass rate would help more.',
            'Plain and direct.',
          ][i],
          quote: ['build a graded set of real questions', 'agree a pass bar with support leads', undefined, '60 runbook questions', undefined][i],
        })),
        overall: 74,
        strengths: ['Grounded in work you have done', 'Involves the people who own the outcome'],
        fixes: ['Add how you would catch regressions after launch', 'Give the pass rate you reached'],
        betterAnswer:
          'I would start from real tickets: a graded set of a few hundred questions, scored on accuracy, tone and whether the answer cites its source. Support leads set the pass bar with me. After launch, a weekly sample goes to human review so we catch regressions. I ran a small version on 60 runbook questions and used it to block two prompt changes that looked better but scored worse.',
        followUp: 'Who decides the pass bar if support and legal disagree?',
        at: '2026-11-17T16:12:00.000Z',
      },
    ],
  };
  return [s2, s1];
}

interface AppSeed {
  company: string;
  title: string;
  family: string;
  seniority: string;
  size: 'startup' | 'scaleup' | 'enterprise';
  source: string;
  fit: number;
  daysAgo: number;
  status: AppStatus;
}

const APP_SEEDS: AppSeed[] = [
  { company: 'Kestrel Pay', title: 'Product Manager, Growth', family: 'Growth product', seniority: 'Mid', size: 'scaleup', source: 'careers page', fit: 71, daysAgo: 30, status: 'interview' },
  { company: 'Stackfield', title: 'Product Manager, Developer Platform', family: 'Platform product', seniority: 'Mid', size: 'scaleup', source: 'referral', fit: 82, daysAgo: 28, status: 'offer' },
  { company: 'Loomwork', title: 'Growth Product Manager', family: 'Growth product', seniority: 'Mid', size: 'scaleup', source: 'job board', fit: 64, daysAgo: 26, status: 'reply' },
  { company: 'Mintleaf Finance', title: 'Platform Product Manager', family: 'Platform product', seniority: 'Mid', size: 'scaleup', source: 'careers page', fit: 77, daysAgo: 24, status: 'interview' },
  { company: 'Orbit Learning', title: 'Senior Product Manager, Activation', family: 'Growth product', seniority: 'Senior', size: 'scaleup', source: 'careers page', fit: 58, daysAgo: 21, status: 'reply' },
  { company: 'Redwood Mobility', title: 'Product Manager, Internal Tools', family: 'Platform product', seniority: 'Mid', size: 'scaleup', source: 'job board', fit: 74, daysAgo: 12, status: 'viewed' },
  { company: 'Copperline Media', title: 'Product Manager, Monetisation', family: 'Growth product', seniority: 'Mid', size: 'scaleup', source: 'job board', fit: 55, daysAgo: 6, status: 'applied' },
  { company: 'Halcyon Travel', title: 'Senior Product Manager, AI Platform', family: 'Platform product', seniority: 'Senior', size: 'scaleup', source: 'careers page', fit: 69, daysAgo: 18, status: 'rejected' },
  { company: 'Tessellate', title: 'AI Product Manager', family: 'AI product', seniority: 'Mid', size: 'startup', source: 'careers page', fit: 61, daysAgo: 27, status: 'reply' },
  { company: 'Cinder Labs', title: 'Product Manager, AI Agents', family: 'AI product', seniority: 'Mid', size: 'startup', source: 'job board', fit: 57, daysAgo: 25, status: 'ghosted' },
  { company: 'Quillmark', title: 'Associate Product Manager, AI', family: 'AI product', seniority: 'Associate', size: 'startup', source: 'careers page', fit: 66, daysAgo: 20, status: 'interview' },
  { company: 'Parallax Data', title: 'Data Product Manager', family: 'Data product', seniority: 'Mid', size: 'startup', source: 'job board', fit: 52, daysAgo: 16, status: 'rejected' },
  { company: 'Ember Analytics', title: 'Product Manager, Generative AI', family: 'AI product', seniority: 'Mid', size: 'startup', source: 'careers page', fit: 59, daysAgo: 9, status: 'viewed' },
  { company: 'Wren Studio', title: 'AI Product Manager', family: 'AI product', seniority: 'Mid', size: 'startup', source: 'job board', fit: 54, daysAgo: 4, status: 'applied' },
  { company: 'Monsoon Commerce', title: 'Senior Product Manager, AI Assistant', family: 'AI product', seniority: 'Senior', size: 'enterprise', source: 'job board', fit: 48, daysAgo: 33, status: 'ghosted' },
  { company: 'Arcadia Telecom', title: 'Product Manager, Data and Insights', family: 'Data product', seniority: 'Mid', size: 'enterprise', source: 'job board', fit: 44, daysAgo: 31, status: 'ghosted' },
  { company: 'Fernhill Bank', title: 'AI Product Manager', family: 'AI product', seniority: 'Mid', size: 'enterprise', source: 'careers page', fit: 56, daysAgo: 29, status: 'rejected' },
  { company: 'Polar Assurance', title: 'Lead Product Manager, Applied AI', family: 'AI product', seniority: 'Lead', size: 'enterprise', source: 'job board', fit: 41, daysAgo: 23, status: 'ghosted' },
  { company: 'Bayleaf Retail', title: 'Product Manager, Search and Ranking', family: 'Data product', seniority: 'Mid', size: 'enterprise', source: 'job board', fit: 47, daysAgo: 19, status: 'rejected' },
  { company: 'Brightline Logistics', title: 'Technical Product Manager', family: 'Technical product', seniority: 'Mid', size: 'enterprise', source: 'referral', fit: 73, daysAgo: 15, status: 'reply' },
  { company: 'Juniper Grid', title: 'Product Manager, Generative AI', family: 'AI product', seniority: 'Mid', size: 'enterprise', source: 'job board', fit: 50, daysAgo: 8, status: 'viewed' },
  { company: 'Saffron Health', title: 'Technical Product Manager, ML Platform', family: 'Technical product', seniority: 'Mid', size: 'scaleup', source: 'careers page', fit: 68, daysAgo: 22, status: 'reply' },
  { company: 'Ridgeway Systems', title: 'Senior Technical Product Manager, APIs', family: 'Technical product', seniority: 'Senior', size: 'enterprise', source: 'job board', fit: 72, daysAgo: 17, status: 'ghosted' },
  { company: 'Saffron Health', title: 'AI Product Manager', family: 'AI product', seniority: 'Mid', size: 'scaleup', source: 'job board', fit: 63, daysAgo: 3, status: 'applied' },
];

const EVENT_NOTES: Partial<Record<AppStatus, string>> = {
  viewed: 'Application viewed by the recruiter',
  reply: 'Recruiter replied asking for a call',
  interview: 'First round booked with the hiring manager',
  offer: 'Offer received; details by email',
  rejected: 'Polite no after screening',
  ghosted: 'No response after 14 days',
};

export function buildApplications(): Application[] {
  return APP_SEEDS.map((s, i) => {
    const applied = day(TODAY, -s.daysAgo);
    const company = COMPANIES.find((c) => c.name === s.company)!;
    const events: Application['events'] = [{ at: iso(applied), kind: 'applied', note: `Applied through the ${s.source}` }];
    let last = applied;
    const chain: AppStatus[] =
      s.status === 'offer' ? ['viewed', 'reply', 'interview', 'offer'] : s.status === 'interview' ? ['viewed', 'reply', 'interview'] : s.status === 'reply' ? ['viewed', 'reply'] : s.status === 'applied' ? [] : s.status === 'ghosted' ? ['ghosted'] : [s.status];
    chain.forEach((st, k) => {
      last = day(applied.toISOString().slice(0, 10), st === 'ghosted' ? 15 : 2 + k * 3);
      events.push({ at: iso(last), kind: st, note: EVENT_NOTES[st] ?? st });
    });
    return {
      id: `a${String(i + 1).padStart(2, '0')}`,
      title: s.title,
      company: s.company,
      url: `https://jobs.${company.host}/roles/${slug(s.title)}`,
      roleFamily: s.family,
      seniority: s.seniority,
      companySize: s.size,
      source: s.source,
      fit: s.fit,
      appliedAt: iso(applied),
      status: s.status,
      lastEventAt: iso(last),
      events,
      origin: 'demo',
    };
  });
}

const RESPONDED: AppStatus[] = ['reply', 'interview', 'offer'];

export function computeInsights(apps: Application[], postings: Posting[]): TrackerInsights {
  const sent = apps.length;
  const responses = apps.filter((a) => RESPONDED.includes(a.status)).length;
  const overallMean = (responses + 1) / (sent + 2);
  const band = (fit: number) => (fit >= 70 ? '70 and up' : fit >= 55 ? '55 to 69' : 'Under 55');
  const dims: [string, (a: Application) => string][] = [
    ['Role family', (a) => a.roleFamily],
    ['Company size', (a) => a.companySize],
    ['Seniority', (a) => a.seniority],
    ['Source', (a) => a.source],
    ['Fit band', (a) => band(a.fit)],
  ];
  const segments: Segment[] = [];
  for (const [dimension, key] of dims) {
    const groups = new Map<string, Application[]>();
    apps.forEach((a) => groups.set(key(a), [...(groups.get(key(a)) ?? []), a]));
    for (const [value, list] of groups) {
      const r = list.filter((a) => RESPONDED.includes(a.status)).length;
      const mean = (r + 1) / (list.length + 2);
      segments.push({
        dimension,
        value,
        sent: list.length,
        responses: r,
        rate: Math.round(mean * 1000) / 1000,
        lift: Math.round((mean / overallMean) * 100) / 100,
        confidence: list.length < 5 ? 'low' : list.length < 12 ? 'medium' : 'high',
      });
    }
  }
  segments.sort((a, b) => b.lift - a.lift);
  const solid = segments.filter((s) => s.sent >= 4);
  const best = solid[0];
  const worst = solid[solid.length - 1];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lessons = [
    best && `${best.value} roles (${best.dimension.toLowerCase()}) reply at about ${pct(best.rate)}, ${best.lift.toFixed(1)} times your overall rate.`,
    worst && `${worst.value} roles have replied ${worst.responses} time${worst.responses === 1 ? '' : 's'} in ${worst.sent} applications. Send fewer of these until the gap map improves.`,
    'Referrals replied 2 of 2 times. Ask for one at each of the next three companies.',
  ].filter(Boolean) as string[];

  const applied = new Set(apps.map((a) => `${a.company}|${a.title}`));
  const rateOf = (dimension: string, value?: string) => segments.find((s) => s.dimension === dimension && s.value === value)?.rate ?? overallMean;
  const next = postings
    .filter((p) => !applied.has(`${p.company}|${p.title}`))
    .map((p) => {
      const chance = (rateOf('Company size', p.companySize) + rateOf('Role family', p.roleFamily)) / 2;
      return { p, chance, score: 0.55 * chance + 0.45 * ((p.fit ?? 50) / 100) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ p, chance }) => ({
      postingId: p.id,
      title: p.title,
      company: p.company,
      url: p.url,
      fit: p.fit ?? 50,
      responseChance: Math.round(chance * 100),
      why: `${p.companySize === 'scaleup' ? 'Scaleup' : p.companySize === 'startup' ? 'Startup' : 'Enterprise'} ${p.roleFamily?.toLowerCase()} roles reply at ${pct(chance)}; fit ${p.fit}.`,
    }));

  return { overall: { sent, responses, rate: Math.round((responses / (sent || 1)) * 1000) / 1000 }, segments, lessons, next };
}

export function computeProgress(plan: Plan | undefined, gap: GapMap | undefined, interviews: InterviewSession[]): Progress {
  const tasks = plan?.weeks.flatMap((w) => w.tasks) ?? [];
  const done = tasks.filter((t) => t.status === 'done');
  const r = gap?.readiness ?? 0;
  const readiness = gap
    ? [
        { at: '2026-11-02T09:00:00.000Z', value: Math.max(0, r - 9) },
        { at: '2026-11-06T09:00:00.000Z', value: Math.max(0, r - 7) },
        { at: '2026-11-10T09:00:00.000Z', value: Math.max(0, r - 5) },
        { at: '2026-11-14T09:00:00.000Z', value: Math.max(0, r - 2) },
        { at: `${TODAY}T09:00:00.000Z`, value: r },
      ]
    : [];
  const hoursDone = done.reduce((a, t) => a + t.hours, 0);
  const hoursPlanned = tasks.reduce((a, t) => a + t.hours, 0);
  const expected = plan ? Math.min(hoursPlanned, Math.ceil(((Date.parse(TODAY) - Date.parse(PLAN_START)) / 86400000 / 7) * 10)) : 0;
  return {
    readiness,
    hoursDone,
    hoursPlanned,
    tasksDone: done.length,
    tasksTotal: tasks.length,
    skillsClosed: gap?.skills.filter((s) => s.status === 'closed').length ?? 0,
    interviewAvg: interviews
      .filter((s) => s.score !== undefined)
      .map((s) => ({ at: s.finishedAt ?? s.startedAt, value: s.score! }))
      .sort((a, b) => a.at.localeCompare(b.at)),
    streakDays: plan ? 4 : 0,
    onTrack: hoursDone >= expected - 3,
    note: plan
      ? hoursDone >= expected - 3
        ? `On pace: ${hoursDone} of ${expected} expected hours by week 3.`
        : `Behind by ${expected - hoursDone} hours. A replan would spread them over the next two weeks.`
      : 'No plan yet.',
  };
}

export function buildBrief(plan: Plan | undefined, insights: TrackerInsights | undefined) {
  const nextTask = plan?.weeks.flatMap((w) => w.tasks).find((t) => t.status === 'todo');
  const nextApp = insights?.next[0];
  const items: { kind: string; text: string; action?: string }[] = [];
  if (nextTask) items.push({ kind: 'task', text: `${nextTask.title} (${nextTask.hours} h)`, action: 'Open plan' });
  if (nextApp) items.push({ kind: 'apply', text: `Apply to ${nextApp.company}, ${nextApp.title}. ${nextApp.why}`, action: 'Apply' });
  items.push({ kind: 'interview', text: 'Practise one technical question on model evaluation.', action: 'Start interview' });
  return { headline: plan ? 'Week 3: experiments with a decision rule' : 'Start by reading the market', items };
}

/* application kit: résumé lines reordered by the posting's skills, one tailored line per top match */

export function buildKit(posting: Posting, profile: Profile, gap: GapMap | undefined): Kit {
  const asks = posting.skills ?? [];
  const lines = [...profile.experience.flatMap((r) => r.bullets), ...profile.projects];
  const own = new Map(profile.skills.map((s) => [s.id, s]));
  const score = (line: string) =>
    asks.reduce((a, s) => a + ((own.get(s.skillId)?.evidence ?? []).some((e) => line.includes(e) || e.includes(line)) ? (s.importance === 'must' ? 2 : 1) : 0), 0);
  const ranked = lines.map((line, i) => ({ line, i, n: score(line) })).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 5);
  const bullets = ranked.map(({ line }, i) => {
    if (i > 1) return { text: line, basedOn: line };
    const words = line.split(/\s+/);
    const basedOn = words.slice(0, Math.min(words.length, 12)).join(' ');
    const ask = asks.find((s) => s.importance === 'must' && own.has(s.skillId))?.name.toLowerCase() ?? 'the work this team does';
    return { text: i === 0 ? `${line.replace(/\.$/, '')}, the same muscle as ${ask} here.` : line.replace(/^Wrote/, 'Wrote and owned'), basedOn };
  });
  const strong = asks.filter((s) => (own.get(s.skillId)?.level ?? 0) >= 3);
  const weak = asks
    .map((s) => ({ s, g: gap?.skills.find((x) => x.id === s.skillId) }))
    .filter(({ s, g }) => (g ? g.level !== 'strong' : (own.get(s.skillId)?.level ?? 0) < 3))
    .slice(0, 4);
  const names = strong.slice(0, 3).map((s) => s.name.toLowerCase());
  return {
    postingId: posting.id,
    generatedAt: new Date().toISOString(),
    fit: posting.fit ?? 60,
    headline: `${profile.currentRole}, ${profile.yearsExperience} years · strongest here: ${names.join(', ') || 'technical depth'}`,
    bullets,
    coverNote: [
      `Hello ${posting.company} team,`,
      `I would like to apply for the ${posting.title} role. I am a ${profile.currentRole} with ${profile.yearsExperience} years of experience, and the parts of my work closest to what you describe are ${names.join(', ') || 'the technical side'}.`,
      ['Most relevant from my résumé:', ...bullets.slice(0, 2).map((b) => `- ${b.basedOn}`)].join('\n'),
      weak.length ? `Your posting also asks for ${weak.map(({ s }) => s.name.toLowerCase()).join(', ')}. I have not done these in a job yet, and I am working on them now through my plan.` : '',
      'I would welcome a conversation about how this background fits the role.',
      profile.name,
    ].filter(Boolean).join('\n\n'),
    talkingPoints: strong.slice(0, 4).map((s) => `They ask for ${s.name.toLowerCase()} ("${s.quote}"). Point to: ${own.get(s.skillId)?.evidence[0] ?? ''}`),
    gapsToAddress: weak.map(({ s, g }) => ({
      skill: g?.name ?? s.name,
      howToFrame: g?.bridge ? `Say it is new to you, then bridge from ${g.bridge.from.toLowerCase()}: ${g.bridge.note}` : `Say plainly that you have not done ${s.name.toLowerCase()} in a job yet, then point to week 4 of your plan.`,
    })),
    questionsToAsk: [
      ...(weak[0] ? [`You mention "${weak[0].s.quote}". How does the team do that today, and what would you want this hire to change first?`] : []),
      'How do you decide a model change is good enough to ship, and who makes that call?',
      'What would a strong first 90 days look like in this role?',
    ],
  };
}
