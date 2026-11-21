import type { Application, GapMap, Goal, InterviewSession, Plan, Progress, TrackerInsights } from './types.ts';
import { addDays, allTasks, currentWeek, daysBetween, localDate, weekOf } from './plan.ts';

export interface ProgressInput {
  plan?: Plan; gap?: GapMap; readiness: { at: string; value: number }[]; sessions: InterviewSession[];
  applications?: Application[]; now: Date;
  start?: Record<string, number>; // `have` per skill when the plan was built
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Hours the plan expected to be done by today: past weeks in full plus the elapsed share of this one.
export function expectedHours(plan: Plan, today: string): number {
  const raw = weekOf(plan, today);
  if (raw <= 0) return 0;
  let sum = 0;
  for (const w of plan.weeks) {
    const load = w.tasks.reduce((a, t) => a + (t.status === 'skipped' ? 0 : t.hours), 0);
    if (w.index < raw) sum += load;
    else if (w.index === raw) sum += load * Math.min(1, (daysBetween(w.startDate, today) + 1) / 7);
  }
  return round1(sum);
}

export function activityDays(input: Pick<ProgressInput, 'plan' | 'sessions' | 'applications'>): Set<string> {
  const days = new Set<string>();
  const add = (iso?: string) => { if (iso) days.add(localDate(new Date(iso))); };
  for (const t of input.plan ? allTasks(input.plan) : []) if (t.status === 'done') add(t.doneAt);
  for (const s of input.sessions) for (const t of s.turns) add(t.at);
  for (const a of input.applications ?? []) add(a.appliedAt);
  return days;
}

// Consecutive active days ending today, or yesterday if nothing has happened yet today.
export function streak(days: Set<string>, today: string): number {
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

export function computeProgress(input: ProgressInput): Progress {
  const today = localDate(input.now);
  const tasks = input.plan ? allTasks(input.plan).filter((t) => t.status !== 'skipped') : [];
  const done = tasks.filter((t) => t.status === 'done');
  const hoursDone = round1(done.reduce((a, t) => a + t.hours, 0));
  const hoursPlanned = round1(tasks.reduce((a, t) => a + t.hours, 0));
  let readiness = [...input.readiness].sort((a, b) => a.at.localeCompare(b.at));
  if (!readiness.length && input.gap) readiness = [{ at: input.gap.generatedAt, value: input.gap.readiness }];
  const interviewAvg = input.sessions
    .filter((s) => s.finishedAt && s.score != null)
    .map((s) => ({ at: s.finishedAt!, value: s.score! }))
    .sort((a, b) => a.at.localeCompare(b.at));
  // closed through the plan or interviews, not skills the résumé already covered
  const skillsClosed = input.gap && input.start
    ? input.gap.skills.filter((s) => s.status === 'closed' && (input.start![s.id] ?? s.need) < s.need).length
    : 0;
  const expected = input.plan ? expectedHours(input.plan, today) : 0;
  const onTrack = !input.plan || hoursDone >= expected * 0.8 - 0.5;
  let note: string;
  if (!input.plan) note = 'Build a plan to start tracking progress.';
  else if (weekOf(input.plan, today) === 0) note = `The plan starts on ${dayName(input.plan.weeks[0]?.startDate)}.`;
  else if (hoursDone >= expected) note = `Ahead of plan: ${hoursDone}h done against ${expected}h expected by today.`;
  else if (onTrack) note = `${hoursDone}h done against ${expected}h expected by today, within the 20% the plan allows.`;
  else note = `Behind by ${round1(expected - hoursDone)}h: replan to roll late tasks forward and rebalance the weeks.`;
  return {
    readiness, hoursDone, hoursPlanned, tasksDone: done.length, tasksTotal: tasks.length, skillsClosed,
    interviewAvg, streakDays: streak(activityDays(input), today), onTrack, note,
  };
}

export interface Brief { headline: string; items: { kind: string; text: string; action?: string }[] }

export interface BriefInput {
  plan?: Plan; gap?: GapMap; goal?: Goal; progress: Progress; sessions: InterviewSession[];
  insights?: TrackerInsights; now: Date;
}

// Today's three things, in order of what moves readiness most.
export function brief(input: BriefInput): Brief {
  const today = localDate(input.now);
  const items: Brief['items'] = [];
  const { plan, progress } = input;
  if (!input.gap) {
    return { headline: 'Start by mapping the gap.', items: [{ kind: 'setup', text: 'Load a résumé and a target role, then build the gap map from live postings.', action: 'Open Start' }] };
  }
  if (!plan) {
    return {
      headline: `Readiness ${Math.round(input.gap.readiness)}. Next: turn the gap into a plan.`,
      items: [{ kind: 'setup', text: `Build a ${input.goal?.weeks ?? 12}-week plan from the ${input.gap.skills.filter((s) => s.status !== 'closed').length} open skills.`, action: 'Build plan' }],
    };
  }
  const cur = currentWeek(plan, today);
  const week = plan.weeks[cur - 1];
  const late = plan.weeks.filter((w) => w.index < cur).flatMap((w) => w.tasks.filter((t) => t.status === 'todo'));
  const next = late[0] ?? week?.tasks.find((t) => t.status === 'todo');
  if (!progress.onTrack && late.length >= 2) {
    items.push({ kind: 'replan', text: `${late.length} tasks from earlier weeks are still open. Replan to roll them forward and rebalance the weeks.`, action: 'Replan' });
  }
  if (next) items.push({ kind: 'task', text: `${next.title} (${next.hours}h)`, action: 'Open plan' });

  const lastSession = [...input.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const daysSince = lastSession ? daysBetween(lastSession.startedAt, today) : Infinity;
  if (!lastSession || daysSince >= 7 || (lastSession.score ?? 100) < 60) {
    const why = !lastSession ? 'You have not done one yet.' : lastSession.score != null && lastSession.score < 60 ? `The last one scored ${lastSession.score}.` : `The last one was ${daysSince} days ago.`;
    items.push({ kind: 'interview', text: `Run a five-question mock interview. ${why}`, action: 'Start interview' });
  } else if (week && week.checkpoint.passed === undefined && daysBetween(week.startDate, today) >= 4) {
    items.push({ kind: 'checkpoint', text: `Week ${week.index} checkpoint: ${week.checkpoint.description}`, action: 'Mark checkpoint' });
  }

  const top = input.insights?.next[0];
  if (top) items.push({ kind: 'apply', text: `Apply to ${top.title} at ${top.company}: fit ${top.fit}, reply chance ${Math.round(top.responseChance * 100)}%.`, action: 'Apply' });

  const theme = week ? `Week ${cur} of ${plan.weeks.length}: ${week.theme}.` : '';
  const pace = progress.onTrack ? 'On track.' : 'Behind plan.';
  return { headline: `${theme} Readiness ${Math.round(input.gap.readiness)}. ${pace}`.trim(), items: items.slice(0, 3) };
}

function dayName(iso: string | undefined): string {
  const d = iso ? new Date(`${iso}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return iso ?? 'the first Monday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
