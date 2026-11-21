import * as store from '../store.ts';
import { PREREQS } from '../skills.ts';
import { computeGap } from '../gap.ts';
import type {
  Application, AppStatus, GapMap, Goal, InterviewQuestion, InterviewSession, InterviewTurn, Plan, Posting, Profile, RubricScore,
} from '../types.ts';
import {
  addDays, buildPlan, currentWeek, daysBetween, localDate, setCheckpoint, setTaskStatus, skillMoves, startLevels, withRaises,
  type Raise,
} from '../plan.ts';
import { fallbackProjects, pickProjects } from '../portfolio.ts';
import { CRITERIA, overallScore, recordTurn, skillEffects, verbatimQuote } from '../interview.ts';
import { applyInterviewEffects, syncSkills } from '../routes/b.ts';

const DAY = 86_400_000;

// Local wall-clock time on a YYYY-MM-DD date, as an ISO instant.
function at(date: string, hh: number, mm = 0): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

function daysAgo(now: Date, n: number, hh = 10, mm = 0): string {
  return at(addDays(localDate(now), -n), hh, mm);
}

// ---- plan ----------------------------------------------------------------------

// Past weeks done except one late task in the last of them; this week a little over half done,
// on the days leading up to today so the streak is live.
function progressPlan(plan: Plan, today: string): Plan {
  const cur = currentWeek(plan, today);
  let p = plan;
  for (const w of plan.weeks) {
    if (w.index > cur) break;
    if (w.index < cur) {
      const learning = w.tasks.filter((t) => t.kind === 'learn' || t.kind === 'practice');
      const late = w.index === cur - 1 ? learning[learning.length - 1]?.id : undefined;
      w.tasks.forEach((t, i) => {
        if (t.id !== late) p = setTaskStatus(p, t.id, 'done', at(addDays(w.startDate, Math.min(i, 5)), 20, 15 + i * 7))!;
      });
      p = setCheckpoint(p, w.index, true)!;
      continue;
    }
    const elapsed = daysBetween(w.startDate, today);
    const n = Math.min(elapsed, w.tasks.length - 1, Math.ceil(w.tasks.length / 2) + 1);
    w.tasks.slice(0, n).forEach((t, i) => {
      p = setTaskStatus(p, t.id, 'done', at(addDays(today, i - n), 20, 30))!;
    });
  }
  return p;
}

// The plan as it stood at a moment: tasks done by then, checkpoints passed by the end of their week.
function planAsOf(plan: Plan, when: string): Plan {
  const p = structuredClone(plan);
  for (const w of p.weeks) {
    for (const t of w.tasks) if (t.status === 'done' && t.doneAt! > when) { t.status = 'todo'; delete t.doneAt; }
    if (w.checkpoint.passed !== undefined && at(addDays(w.startDate, 6), 21) > when) delete w.checkpoint.passed;
  }
  return p;
}

// ---- interviews -------------------------------------------------------------------

type Score = [number, string, string]; // score, why, quote

interface Authored {
  q: Omit<InterviewQuestion, 'id' | 'skillIds'> & { skills: string[] };
  answer: string; scores: Score[]; strengths: string[]; fixes: string[]; better: string; followUp: string;
}

function pickSkill(gap: GapMap, wanted: string[]): string[] {
  for (const id of wanted) if (gap.skills.some((s) => s.id === id)) return [id];
  const open = gap.skills.filter((s) => s.status !== 'closed').sort((a, b) => b.priority - a.priority)[0];
  return open ? [open.id] : [];
}

function session(gap: GapMap, id: string, kind: InterviewSession['kind'], startedAt: string, items: Authored[], postingId?: string): InterviewSession {
  const questions: InterviewQuestion[] = items.map((it, i) => ({
    id: `q${i + 1}`, kind: it.q.kind, text: it.q.text, skillIds: pickSkill(gap, it.q.skills),
    ...(it.q.fromPosting ? { fromPosting: it.q.fromPosting } : {}),
  }));
  let s: InterviewSession = { id, kind, ...(postingId ? { postingId } : {}), questions, turns: [], startedAt };
  items.forEach((it, i) => {
    const scores: RubricScore[] = it.scores.map(([score, why, quote], j) => {
      const q = verbatimQuote(quote, it.answer);
      return { criterion: CRITERIA[j], score, why, ...(q ? { quote: q } : {}) };
    });
    const turn: InterviewTurn = {
      questionId: `q${i + 1}`, answer: it.answer, scores, overall: overallScore(scores),
      strengths: it.strengths, fixes: it.fixes, betterAnswer: it.better, followUp: it.followUp,
      at: new Date(Date.parse(startedAt) + (i + 1) * 6 * 60_000).toISOString(),
    };
    s = recordTurn(s, turn);
  });
  return s;
}

const BASELINE: Authored[] = [
  {
    q: { kind: 'behavioural', text: 'Tell me about a time you had to change a decision you did not own. Who did you need to convince, and what moved them?', skills: ['stakeholder-management'] },
    answer: 'At Ledgerline the finance team owned the nightly reconciliation batch and did not want to change it because month-end reports depended on it. I thought it was the reason failed payouts sat unnoticed for up to a day. I ran a weekly sync with finance, operations and the two partner banks and kept a decision log so nobody had to remember what we agreed. What moved finance was a list of every payout that failed silently in one month. We agreed to run the old and new flows side by side for a month, and then we switched.',
    scores: [
      [4, 'Clear arc from the disagreement to the switch.', 'We agreed to run the old and new flows side by side for a month'],
      [3, 'Shows influence without authority, but never says what the business gained.', 'I thought it was the reason failed payouts sat unnoticed for up to a day.'],
      [3, 'Names what persuaded finance, not what else was considered.', 'What moved finance was a list of every payout that failed silently in one month.'],
      [2, 'The list is concrete, but there is no number for the outcome.', 'a list of every payout that failed silently'],
      [4, 'Plain and easy to follow.', 'kept a decision log so nobody had to remember what we agreed'],
    ],
    strengths: ['Shows influence without authority across finance, operations and two banks.', 'The side-by-side run is a concrete, low-risk way to win agreement.'],
    fixes: ['Say what changed for merchants and the business after the switch, with a number.', 'Name the option finance preferred and why you did not take it.', 'Open with the result in one sentence before the story.'],
    better: 'I got finance to replace a nightly reconciliation batch they owned. Their concern was month-end reporting; mine was that failed payouts sat unnoticed for up to a day. I set up a weekly sync with finance, operations and the two partner banks and kept a decision log. What changed their mind was a list of every payout that failed silently in one month. We ran the old and new flows side by side for a month and then switched. [Add the result, for example the change in failed payouts after the switch.]',
    followUp: 'What happened to failed payouts after the switch, and how did you measure it?',
  },
  {
    q: { kind: 'behavioural', text: 'Tell me about a time you found out what users actually needed was different from what was asked for.', skills: ['user-research', 'product-discovery'] },
    answer: 'During the returns launch at Cartwheel I sat in on seller support calls. The ticket said sellers wanted a bulk returns upload. On the calls it was clear the real problem was that they could not see why a return was stuck. I turned the top complaints into a prioritised fix list for the sprint. We built a status page first and the bulk upload later.',
    scores: [
      [3, 'There is a before and after, but no explicit outcome.', 'We built a status page first and the bulk upload later.'],
      [4, 'Directly about finding the real user need, which is core product work.', 'the real problem was that they could not see why a return was stuck'],
      [2, 'Does not say how many calls or how the fix list was ranked.', 'I turned the top complaints into a prioritised fix list for the sprint.'],
      [1, 'No numbers on calls, complaints or impact.', 'I sat in on seller support calls'],
      [4, 'Short, clear sentences.', 'The ticket said sellers wanted a bulk returns upload.'],
    ],
    strengths: ['Strong instinct: you went to the calls instead of trusting the ticket.', 'The gap between what was asked and what was needed is clear.'],
    fixes: ['Say how many calls you joined and how you ranked the complaints.', 'Give a result: fewer tickets, faster resolution, seller feedback.', 'Explain why the status page went first.'],
    better: 'The ticket asked for a bulk returns upload. I sat in on seller support calls during the returns launch at Cartwheel, and the real problem was different: sellers could not see why a return was stuck. I turned the top complaints into a prioritised fix list for the sprint, so we built a status page first and the bulk upload later. [Add how many calls, how you ranked the list, and what changed for sellers.]',
    followUp: 'How did you decide the status page mattered more than the bulk upload?',
  },
  {
    q: { kind: 'behavioural', text: 'Describe a project where scope had to be cut late. How did you decide what to drop, and how did you tell people?', skills: ['prioritization', 'roadmapping'] },
    answer: 'When we moved catalogue sync to Kafka we were running late, so we cut some things. We dropped the admin screen and kept the core pipeline because that was what fixed stock mismatches. I told the team in standup and updated the RFC. It worked out and mismatches went down a lot.',
    scores: [
      [2, 'Jumps from the cut to the outcome without the decision in between.', 'we were running late, so we cut some things'],
      [3, 'Answers the question, but as an engineer trimming a backlog rather than a PM making a trade-off.', 'We dropped the admin screen and kept the core pipeline'],
      [2, 'One reason given; no alternatives and no cost of the cut.', 'because that was what fixed stock mismatches'],
      [2, '"A lot" is not evidence, and your résumé has a real number for this.', 'mismatches went down a lot'],
      [3, 'Clear but vague ("some things").', 'It worked out'],
    ],
    strengths: ['Kept the part that delivered the outcome, which is the right instinct.'],
    fixes: ['Name everything you cut and the rule you used.', 'Use the real number for the outcome instead of "a lot".', 'Say who outside the team needed to know and how they took it.'],
    better: 'On the move of catalogue sync to Kafka we were running late and had to cut scope. I kept the core pipeline, because that was what fixed stock mismatches, and dropped the admin screen. I told the team in standup and updated the RFC. [Name what else was cut and why.] Mismatches went down [by how much].',
    followUp: 'Who missed the admin screen, and how did you handle that?',
  },
  {
    q: { kind: 'behavioural', text: "Tell me about a time you used data to change someone's mind. What was the data and what changed afterwards?", skills: ['experimentation', 'metrics-definition'] },
    answer: 'I built the experiment assignment service the growth team uses for checkout A/B tests. One test showed a new checkout layout winning after three days and the PM wanted to ship it. I pointed out that the sample was mostly returning users and asked the analyst to split the result. For new users the layout was slightly worse. We kept the test running another week and the final result was flat, so we did not ship.',
    scores: [
      [4, 'Clear situation, action and outcome.', 'We kept the test running another week'],
      [4, 'Shows the experimentation judgement an AI PM needs.', 'the sample was mostly returning users'],
      [3, 'A good catch on the sample, but nothing on how the team changed its stopping rule.', 'asked the analyst to split the result'],
      [3, 'The timings are concrete; effect sizes are missing.', 'winning after three days'],
      [4, 'Easy to follow.', 'the final result was flat, so we did not ship'],
    ],
    strengths: ['A real example of stopping a bad ship decision with data.', 'Shows you understand segment effects and calling a test too early.'],
    fixes: ['Give the effect sizes: how much it was winning, how much worse for new users.', 'Say what changed in how the team ran tests afterwards.'],
    better: 'A checkout layout test looked like a win after three days and the PM wanted to ship. I had built the assignment service, so I checked who was in the sample: mostly returning users. I asked the analyst to split the result, and for new users the layout was slightly worse. We kept the test running another week; the final result was flat, so we did not ship. [Add the effect sizes and what the team changed about stopping tests early.]',
    followUp: 'What rule would you set so the team does not call a test after three days again?',
  },
  {
    q: { kind: 'behavioural', text: 'Walk me through something you owned that went wrong. What did you do in the first week after, and what would you do differently?', skills: ['cross-functional-leadership', 'stakeholder-management'] },
    answer: 'We had an incident where payouts were delayed. It was a config issue. I fixed it and we wrote a postmortem. Next time I would add more alerts.',
    scores: [
      [2, 'Four facts in a row, not a story.', 'It was a config issue.'],
      [2, 'Stays on the technical fix; nothing about merchants or the team.', 'I fixed it and we wrote a postmortem.'],
      [1, 'No cause, no trade-off, no lesson beyond alerts.', 'Next time I would add more alerts.'],
      [1, 'No scale, duration or impact.', 'payouts were delayed'],
      [3, 'Clear, but too thin to judge.', 'We had an incident where payouts were delayed.'],
    ],
    strengths: ['Honest and to the point.'],
    fixes: ['Tell it fully: what broke, who was hurt, what you did hour by hour.', 'Say what you changed in process, not only in alerts.', 'Quantify the impact: how many merchants, for how long.'],
    better: 'We had an incident where payouts were delayed because of a config issue. I fixed it and we wrote a postmortem. [Add how many merchants were affected and for how long, what you told them, what the postmortem found, and the process change beyond more alerts.]',
    followUp: 'How many merchants were affected, and what did you tell them?',
  },
];

function mock(company: string, postingId?: string): Authored[] {
  return [
    {
      q: { kind: 'behavioural', text: 'Tell me about a time you had to bring several teams to one decision. How did you get there?', skills: ['stakeholder-management'] },
      answer: 'The reconciliation rewrite at Ledgerline touched finance, operations and two partner banks, and each wanted a different cut-over date. I started a weekly sync and a shared decision log, so every decision had an owner and a date. When the banks pushed back on the timeline, I proposed running the old and new flows side by side for a month, which took the risk off them. Finance signed off once they saw the silent failures list from one month. After the switch, failed payouts dropped from 1.9% to 0.4%, and the decision log became the template the team uses for cross-team work.',
      scores: [
        [5, 'Sets up the conflict, walks through the moves and lands on the result.', 'After the switch, failed payouts dropped from 1.9% to 0.4%'],
        [4, 'Exactly the alignment work a platform PM does; could name who benefited.', 'each wanted a different cut-over date'],
        [4, 'Explains why the parallel run worked: it took the risk off the banks.', 'which took the risk off them'],
        [4, 'Before and after numbers on the outcome.', 'failed payouts dropped from 1.9% to 0.4%'],
        [5, 'Crisp; every sentence moves the story.', 'every decision had an owner and a date'],
      ],
      strengths: ['Clear structure from conflict to outcome.', 'The parallel run shows you can lower risk for others to get a yes.', 'Real numbers on the result.'],
      fixes: ['Say what 0.4% meant for merchants, for example fewer support tickets or faster settlement.'],
      better: 'On the reconciliation rewrite at Ledgerline, finance, operations and two partner banks each wanted a different cut-over date. I set up a weekly sync and a shared decision log so every decision had an owner and a date. When the banks pushed back, I proposed running the old and new flows side by side for a month, which took the risk off them; finance signed off once they saw the silent failures list from one month. After the switch, failed payouts dropped from 1.9% to 0.4%, and the decision log became the template the team uses for cross-team work. [Add what that meant for merchants.]',
      followUp: 'If one bank had still refused, what would you have done?',
    },
    {
      q: { kind: 'technical', text: 'How would you decide whether an LLM feature is good enough to ship? Which evaluation set, metrics and thresholds would you use?', skills: ['llm-evaluation'], ...(postingId ? { fromPosting: postingId } : {}) },
      answer: 'I would start with a set of real questions from users, maybe a few hundred, with the answers we expect. Then I would measure accuracy and also check for bad answers like hallucinations. For Runbook Buddy I asked 12 engineers to rate answers, which was useful but slow. I think the threshold depends on the use case. For an internal tool you can ship earlier than for something customers see.',
      scores: [
        [3, 'A reasonable order, but the threshold question is left open.', 'I think the threshold depends on the use case.'],
        [4, 'On point for an AI platform role.', 'a set of real questions from users'],
        [3, 'Names hallucinations but not how to score them or what each kind of error costs.', 'check for bad answers like hallucinations'],
        [2, 'Mentions 12 raters but gives no result from that test.', 'I asked 12 engineers to rate answers'],
        [4, 'Clear and plain.', 'For an internal tool you can ship earlier than for something customers see.'],
      ],
      strengths: ['Starts from real user questions, not synthetic ones.', 'Uses your own prototype as evidence.'],
      fixes: ['Commit to a threshold and say what would change it.', 'Separate error types (wrong, unsafe, unhelpful) and weigh them differently.', "Say what the 12 engineers' ratings showed."],
      better: "I would build an evaluation set from real user questions, a few hundred, each with the answer we expect, and score accuracy while separately flagging bad answers such as hallucinations. When I built Runbook Buddy I had 12 engineers rate answers; it was useful but slow. The ship threshold depends on who sees it: an internal tool can ship earlier than a customer-facing one. [State the threshold you would set for each, and what the 12 engineers' ratings showed.]",
      followUp: 'What accuracy would you need before customers see it, and why that number?',
    },
    {
      q: { kind: 'case', text: `${company} wants to add an AI assistant for its operations team. How do you decide whether to build it, and what ships first?`, skills: ['product-discovery'], ...(postingId ? { fromPosting: postingId } : {}) },
      answer: 'First I would talk to the operations team to find out where they lose time. If most of it is answering the same questions from runbooks, an assistant makes sense; if it is waiting on other systems, it does not. I would ship a narrow version first that answers questions from existing runbooks, like Runbook Buddy, and measure how often people use it and whether answers are right. If usage is low after a few weeks I would stop.',
      scores: [
        [4, 'A clear decision path: discover, decide, ship narrow, measure.', 'I would ship a narrow version first'],
        [4, "Grounded in the operations team's time, which is the right lens.", 'find out where they lose time'],
        [3, 'A good build-or-not test; the success metric and stop rule are vague.', 'If usage is low after a few weeks I would stop.'],
        [2, 'No numbers for the opportunity or the bar to keep going.', 'measure how often people use it and whether answers are right'],
        [4, 'Easy to follow.', 'if it is waiting on other systems, it does not'],
      ],
      strengths: ['A real build-or-not test before any building.', 'A narrow first version tied to content that already exists.'],
      fixes: ['Size the opportunity: hours lost per week and how many people.', 'Define "low usage" and "right answers" as numbers before launch.'],
      better: 'I would start by finding out where the operations team loses time. If most of it goes on answering the same questions from runbooks, an assistant makes sense; if it is waiting on other systems, it does not. The first version would be narrow: answer questions from the existing runbooks, as Runbook Buddy did, and measure how often people use it and whether the answers are right. If usage is low after a few weeks, I would stop. [Set the usage and accuracy bars as numbers up front.]',
      followUp: 'What usage number after four weeks would make you keep going?',
    },
    {
      q: { kind: 'behavioural', text: 'Tell me about a time you learned something from users that changed your plan.', skills: ['user-research', 'product-discovery'] },
      answer: 'For Runbook Buddy I assumed engineers wanted long, complete answers. When I asked 12 engineers to try it, most of them wanted the exact command and a link to the runbook, not a summary. I changed the prompt to put the command first. People used it more after that, although I did not measure it properly.',
      scores: [
        [4, 'Assumption, test, change, result: a clean arc.', 'I assumed engineers wanted long, complete answers'],
        [4, 'Exactly the learning loop the role needs.', 'most of them wanted the exact command and a link to the runbook'],
        [3, 'Says what changed, not why the first assumption was wrong.', 'I changed the prompt to put the command first'],
        [2, 'Honest that usage was not measured, which leaves no evidence.', 'I did not measure it properly'],
        [4, 'Short and clear.', 'not a summary'],
      ],
      strengths: ['You tested an assumption with real users and changed course.', 'Candid about what you did not measure.'],
      fixes: ['Say what you would measure next time, and the result you would expect.', 'Explain why you first assumed long answers.'],
      better: 'With Runbook Buddy I assumed engineers wanted long, complete answers. When 12 engineers tried it, most wanted the exact command and a link to the runbook, not a summary, so I changed the prompt to put the command first. People used it more afterwards, although I did not measure it properly. [Name the metric you would track next time.]',
      followUp: 'How would you measure "used it more" if you ran it again?',
    },
    {
      q: { kind: 'technical', text: 'What would you put on the dashboard for an AI support agent on day one, and which number would you watch most closely?', skills: ['metrics-definition', 'product-analytics'] },
      answer: 'I would put volume of conversations, how many were resolved without a human, how many were escalated, and customer satisfaction. I would also track cost per conversation. The number I would watch most is resolution rate, but I would pair it with satisfaction because an agent can close tickets without really helping.',
      scores: [
        [3, 'A list, then the key metric; fine for a short answer.', 'The number I would watch most is resolution rate'],
        [4, 'The right metrics for a support agent.', 'how many were resolved without a human'],
        [3, 'A good guardrail pairing; nothing on how resolution is defined or gamed.', 'an agent can close tickets without really helping'],
        [1, 'No targets or baselines.', 'customer satisfaction'],
        [4, 'Clear.', 'I would also track cost per conversation.'],
      ],
      strengths: ['Pairs the headline metric with a guardrail.', 'Includes cost, which many candidates forget.'],
      fixes: ['Define "resolved" so it cannot be gamed.', 'Give a baseline and a target for the main number.'],
      better: 'Day one: conversation volume, share resolved without a human, share escalated, customer satisfaction and cost per conversation. The number I would watch most is resolution rate, paired with satisfaction, because an agent can close tickets without really helping. [Add how you define "resolved" and the baseline you compare against.]',
      followUp: 'How would you define "resolved" so the agent cannot game it?',
    },
  ];
}

// ---- applications -------------------------------------------------------------

interface AppSpec {
  posting?: string; title: string; company: string; family: string; size: string; seniority: string; source: string; fit: number;
  ago: number; outcome: AppStatus; steps?: [number, string, string][]; // days after applying, kind, note
}

const R = 'reply', I = 'interview', V = 'viewed', X = 'rejected';

// Growth and platform roles at scaleups get answers; generalist roles at enterprises mostly do not.
const APPS: AppSpec[] = [
  { title: 'Growth Product Manager', company: 'Tamarind Commerce', family: 'growth', size: 'scaleup', seniority: 'mid', source: 'job-board', fit: 46, ago: 41, outcome: 'interview', steps: [[5, R, 'Recruiter asked for a 20-minute screen'], [9, I, 'Hiring manager interview on the activation funnel']] },
  { title: 'Product Manager, Enterprise Workflows', company: 'Ironbridge Systems', family: 'generalist', size: 'enterprise', seniority: 'mid', source: 'job-board', fit: 24, ago: 40, outcome: 'ghosted' },
  { title: 'Platform Product Manager, ML Infrastructure', company: 'Northwind Compute', family: 'platform', size: 'scaleup', seniority: 'senior', source: 'company-site', fit: 48, ago: 38, outcome: 'ghosted', steps: [[3, V, 'Application viewed on the careers portal']] },
  { title: 'Product Manager', company: 'Sterling Assurance', family: 'generalist', size: 'enterprise', seniority: 'senior', source: 'job-board', fit: 22, ago: 37, outcome: 'rejected', steps: [[12, X, 'Moving ahead with candidates who have prior PM experience']] },
  { title: 'AI Product Manager', company: 'Lattice Health', family: 'agents', size: 'startup', seniority: 'mid', source: 'startup-board', fit: 30, ago: 35, outcome: 'ghosted' },
  { title: 'Growth Product Manager, Learning', company: 'Brindle Learning', family: 'growth', size: 'scaleup', seniority: 'mid', source: 'company-site', fit: 42, ago: 34, outcome: 'reply', steps: [[2, V, 'Application viewed'], [6, R, 'Recruiter replied; asked for a take-home on onboarding']] },
  { title: 'Product Manager, Digital Channels', company: 'Coastal Federal', family: 'generalist', size: 'enterprise', seniority: 'mid', source: 'job-board', fit: 19, ago: 32, outcome: 'ghosted' },
  { title: 'Product Manager, Developer Platform', company: 'Quarry Labs', family: 'platform', size: 'scaleup', seniority: 'mid', source: 'company-site', fit: 51, ago: 30, outcome: 'interview', steps: [[3, R, 'Engineering manager replied after seeing the Payouts API docs'], [8, I, 'Panel interview: API product case']] },
  { title: 'Associate Product Manager', company: 'Meridian Insurance Group', family: 'generalist', size: 'enterprise', seniority: 'associate', source: 'job-board', fit: 28, ago: 28, outcome: 'reply', steps: [[10, R, 'HR asked for notice period and salary expectations']] },
  { title: 'Product Manager, Analytics', company: 'Driftwood Data', family: 'analytics', size: 'startup', seniority: 'mid', source: 'startup-board', fit: 38, ago: 26, outcome: 'reply', steps: [[4, R, 'Founder replied asking for a call next week']] },
  { title: 'Product Manager, Core Banking', company: 'Harbor National', family: 'generalist', size: 'enterprise', seniority: 'mid', source: 'job-board', fit: 17, ago: 24, outcome: 'ghosted' },
  { title: 'Product Manager, Conversational AI', company: 'Saffron Mobility', family: 'agents', size: 'scaleup', seniority: 'mid', source: 'company-site', fit: 33, ago: 21, outcome: 'rejected', steps: [[9, X, 'Role filled internally']] },
  { posting: 'p35-hearthfinance', title: '', company: '', family: 'generalist', size: 'enterprise', seniority: 'senior', source: 'job-board', fit: 32, ago: 20, outcome: 'ghosted' },
  { posting: 'p19-meridiantel', title: '', company: '', family: 'generalist', size: 'enterprise', seniority: 'mid', source: 'job-board', fit: 24, ago: 19, outcome: 'rejected', steps: [[9, X, 'Automated rejection after résumé screen']] },
  { posting: 'p12-helixretail', title: '', company: '', family: 'generalist', size: 'enterprise', seniority: 'mid', source: 'job-board', fit: 21, ago: 17, outcome: 'ghosted' },
  { posting: 'p26-sundiallogistics', title: '', company: '', family: 'generalist', size: 'enterprise', seniority: 'mid', source: 'job-board', fit: 21, ago: 16, outcome: 'ghosted' },
  { posting: 'p06-tessellatecloud', title: '', company: '', family: 'generalist', size: 'enterprise', seniority: 'senior', source: 'company-site', fit: 18, ago: 14, outcome: 'rejected', steps: [[8, X, 'Looking for someone with enterprise PM experience']] },
  { posting: 'p22-banyancloud', title: '', company: '', family: 'platform', size: 'enterprise', seniority: 'senior', source: 'company-site', fit: 30, ago: 12, outcome: 'viewed', steps: [[4, V, 'Application viewed']] },
  { posting: 'p04-vistaarbank', title: '', company: '', family: 'generalist', size: 'enterprise', seniority: 'mid', source: 'job-board', fit: 15, ago: 11, outcome: 'applied' },
  { posting: 'p13-cobaltmetrics', title: '', company: '', family: 'analytics', size: 'scaleup', seniority: 'mid', source: 'company-site', fit: 43, ago: 7, outcome: 'viewed', steps: [[2, V, 'Application viewed']] },
  { posting: 'p09-fernhill', title: '', company: '', family: 'growth', size: 'scaleup', seniority: 'mid', source: 'job-board', fit: 31, ago: 6, outcome: 'viewed', steps: [[1, V, 'Application viewed']] },
  { posting: 'p02-lumenfreight', title: '', company: '', family: 'platform', size: 'scaleup', seniority: 'senior', source: 'company-site', fit: 39, ago: 5, outcome: 'reply', steps: [[3, R, 'Recruiter replied: platform team wants a call']] },
  { posting: 'p32-monsoongames', title: '', company: '', family: 'growth', size: 'scaleup', seniority: 'mid', source: 'company-site', fit: 56, ago: 5, outcome: 'interview', steps: [[2, R, 'Hiring manager replied the next morning'], [4, I, 'First interview booked for Monday']] },
  { posting: 'p10-riverstonepay', title: '', company: '', family: 'analytics', size: 'scaleup', seniority: 'senior', source: 'company-site', fit: 64, ago: 4, outcome: 'reply', steps: [[3, R, 'Recruiter replied: payments background is a plus']] },
];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildApplications(now: Date, postings: Posting[]): Application[] {
  const byId = new Map(postings.map((p) => [p.id, p]));
  return APPS.map((spec, i) => {
    const p = spec.posting ? byId.get(spec.posting) : undefined;
    const title = p?.title ?? (spec.title || 'Product Manager');
    const company = p?.company ?? (spec.company || `Company ${i + 1}`);
    // an application cannot predate its posting
    const ago = p?.postedAt ? Math.min(spec.ago, Math.max(1, daysBetween(p.postedAt, localDate(now)) - 1)) : spec.ago;
    const appliedAt = daysAgo(now, ago, 9 + (i % 9), (i * 13) % 60);
    const events: Application['events'] = [{ at: appliedAt, kind: 'applied', note: p ? 'Applied on the careers page with a tailored résumé' : 'Applied with a tailored résumé' }];
    for (const [d, kind, note] of spec.steps ?? []) {
      if (d >= ago) continue;
      events.push({ at: new Date(Date.parse(appliedAt) + d * DAY + 3 * 3_600_000).toISOString(), kind, note });
    }
    if (spec.outcome === 'ghosted' && ago > 14) events.push({ at: new Date(Date.parse(appliedAt) + 14 * DAY).toISOString(), kind: 'ghosted', note: 'No reply 14 days after applying' });
    const last = events[events.length - 1];
    const kinds = new Set(events.map((e) => e.kind));
    const status: AppStatus = kinds.has(spec.outcome) ? spec.outcome : kinds.has('viewed') ? 'viewed' : 'applied';
    return {
      id: `app-${String(i + 1).padStart(2, '0')}-${slug(company)}`,
      ...(p ? { postingId: p.id } : {}),
      title, company,
      url: p?.url ?? `https://careers.${slug(company).replace(/-/g, '')}.example/jobs/${slug(title)}`,
      roleFamily: p?.roleFamily ?? spec.family, seniority: p?.seniority ?? spec.seniority,
      companySize: p?.companySize ?? spec.size, source: p?.source ?? spec.source,
      fit: Math.round(p?.fit ?? spec.fit),
      appliedAt, status, lastEventAt: last.at, events, origin: 'demo',
    };
  });
}

// ---- seed ------------------------------------------------------------------------

export async function seed(): Promise<void> {
  const gap0 = store.get<GapMap>('single', 'gap');
  const goal = store.get<Goal>('single', 'goal');
  const profile0 = store.get<Profile>('single', 'profile');
  if (!gap0 || !goal || !profile0) return;
  const postings = store.list<Posting>('posting');
  const now = new Date();
  const today = localDate(now);

  const start = startLevels(gap0);
  store.put('skillbase', 'start', start);
  const built = buildPlan({ gap: gap0, goal, prereqs: PREREQS, now: at(addDays(goal.startDate, -1), 18) });
  const plan = progressPlan(built, today);
  store.put('single', 'plan', plan);

  const lumen = postings.find((p) => p.id === 'p02-lumenfreight') ?? postings.find((p) => p.roleFamily === 'platform' && p.companySize === 'scaleup');
  const s1Start = at(addDays(goal.startDate, -1), 10, 30);
  const s2Start = at(addDays(today, -6), 19, 0);
  const sessions = [
    session(gap0, 'iv-demo-1', 'behavioural', s1Start, BASELINE),
    session(gap0, 'iv-demo-2', 'mixed', s2Start, mock(lumen?.company ?? 'A logistics scaleup', lumen?.id), lumen?.id),
  ];
  for (const s of sessions) store.put('interview', s.id, s);

  // replay readiness at past moments with the same rules, then apply the real changes
  const names = new Map(gap0.skills.map((s) => [s.id, s.name]));
  const interviewRaise = (upTo: string): Raise => {
    const out: Raise = {};
    for (const s of sessions) {
      if (!s.finishedAt || s.finishedAt > upTo) continue;
      for (const [id, delta] of Object.entries(skillEffects(s))) {
        const g = gap0.skills.find((x) => x.id === id);
        if (g && g.have < g.need) out[id] = { level: Math.min(g.need, g.have + delta), evidence: `Scored above 4 of 5 on ${g.name} questions in a mock interview` };
      }
    }
    return out;
  };
  const readinessAt = (when: string): number => {
    const moves = skillMoves(gap0, planAsOf(plan, when), start);
    const p1 = withRaises(profile0, interviewRaise(when), names).profile;
    const p2 = withRaises(p1, moves.raise, names).profile;
    return computeGap(p2, postings, gap0).readiness;
  };
  applyInterviewEffects(sessions[0]);
  applyInterviewEffects(sessions[1]);
  const gap = syncSkills(plan) ?? gap0;

  // history replaces the points written while seeding
  for (const r of store.list<{ at: string }>('readiness')) store.del('readiness', r.at);
  const moments = [at(addDays(goal.startDate, -1), 18)];
  for (const w of plan.weeks) if (w.checkpoint.passed === true) moments.push(at(addDays(w.startDate, 6), 21));
  for (const s of sessions) if (s.finishedAt && s.finishedAt > moments[0]) moments.push(s.finishedAt);
  const nowIso = now.toISOString();
  for (const m of [...new Set(moments)].sort()) {
    if (m >= nowIso) continue;
    store.put('readiness', m, { at: m, value: m === moments[0] ? gap0.readiness : readinessAt(m) });
  }
  store.put('readiness', nowIso, { at: nowIso, value: gap.readiness });

  const projects = fallbackProjects(pickProjects(plan, gap, postings), gap, goal);
  const cur = currentWeek(plan, today);
  for (const p of projects) {
    const first = p.milestones[0]?.week ?? 99;
    p.status = first <= cur ? 'building' : 'idea';
    store.put('portfolio', p.id, p);
  }

  for (const a of buildApplications(now, postings)) store.put('application', a.id, a);
}
