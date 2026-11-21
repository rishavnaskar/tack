import type { GapMap, Plan, PlanChange, PlanTask, PlanWeek } from '../../api/types';

const DAY = 86_400_000;

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const hrs = (n: number) => `${round1(n)} h`;

export function localToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const utc = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);

export function daysBetween(a: string, b: string) {
  return Math.round((utc(b) - utc(a)) / DAY);
}

export function addDays(date: string, n: number) {
  return new Date(utc(date) + n * DAY).toISOString().slice(0, 10);
}

/** 1-based week holding today: 0 before the plan starts, weeks + 1 once it has ended. */
export function weekOfToday(plan: Plan, today = localToday()) {
  if (!plan.weeks.length) return 0;
  const d = daysBetween(plan.weeks[0].startDate, today);
  if (d < 0) return 0;
  return Math.min(plan.weeks.length + 1, Math.floor(d / 7) + 1);
}

export function currentWeek(plan: Plan, today = localToday()) {
  return Math.min(Math.max(1, weekOfToday(plan, today)), Math.max(1, plan.weeks.length));
}

/** Planned hours leave out skipped tasks, the same way the coach counts them. */
export function weekLoad(w: PlanWeek) {
  let planned = 0;
  let done = 0;
  for (const t of w.tasks) {
    if (t.status === 'skipped') continue;
    planned += t.hours;
    if (t.status === 'done') done += t.hours;
  }
  return { planned: round1(planned), done: round1(done) };
}

const dm = (date: string, withMonth = true) =>
  new Date(utc(date)).toLocaleDateString('en-GB', withMonth ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { day: 'numeric', timeZone: 'UTC' });

/** "16–22 Nov", or "30 Nov – 6 Dec" across a month. */
export function weekSpan(startDate: string) {
  const end = addDays(startDate, 6);
  return startDate.slice(5, 7) === end.slice(5, 7) ? `${dm(startDate, false)}–${dm(end)}` : `${dm(startDate)} – ${dm(end)}`;
}

export function dayLabel(date: string) {
  return new Date(utc(date)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function skillNamer(gap?: GapMap | null) {
  const names = new Map((gap?.skills ?? []).map((s) => [s.id, s.name]));
  return (id: string) => names.get(id) ?? id.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function changesNewestFirst(plan: Plan): PlanChange[] {
  return [...plan.changes].sort((a, b) => b.at.localeCompare(a.at));
}

/** Version a change produced: the newest change made the current version. */
export function versionOf(plan: Plan, change: PlanChange) {
  const order = changesNewestFirst(plan);
  return plan.version - order.indexOf(change);
}

export function findTask(plan: Plan, id: string): { week: PlanWeek; task: PlanTask } | undefined {
  for (const week of plan.weeks) {
    const task = week.tasks.find((t) => t.id === id);
    if (task) return { week, task };
  }
}

export function withTaskStatus(plan: Plan, id: string, status: PlanTask['status']): Plan {
  return {
    ...plan,
    weeks: plan.weeks.map((w) =>
      w.tasks.some((t) => t.id === id)
        ? {
            ...w,
            tasks: w.tasks.map((t) =>
              t.id === id ? { ...t, status, doneAt: status === 'done' ? new Date().toISOString() : undefined } : t,
            ),
          }
        : w,
    ),
  };
}

export function withCheckpoint(plan: Plan, index: number, passed: boolean): Plan {
  return { ...plan, weeks: plan.weeks.map((w) => (w.index === index ? { ...w, checkpoint: { ...w.checkpoint, passed } } : w)) };
}

export interface Move {
  text: string;
  from?: number;
  to?: number;
}

const curly = (s: string) => s.replace(/"([^"]+)"/g, '“$1”');

/**
 * A moved item is either a task id or a sentence from the coach such as
 * `"Task" and "Task": week 1 to week 3`. Both read as one line with week tags.
 */
export function readMove(plan: Plan, item: string): Move {
  const hit = findTask(plan, item);
  if (hit) return { text: hit.task.title, to: hit.week.index };
  const m = item.match(/^(.*?):\s*week (\d+) to week (\d+)\.?$/i);
  if (m) return { text: curly(m[1]), from: Number(m[2]), to: Number(m[3]) };
  const many = item.match(/^(\d+ tasks) from week (\d+) to week (\d+),?\s*(.*)$/i);
  if (many) return { text: curly(`${many[1]}${many[4] ? `, ${many[4]}` : ''}`), from: Number(many[2]), to: Number(many[3]) };
  return { text: curly(item) };
}
