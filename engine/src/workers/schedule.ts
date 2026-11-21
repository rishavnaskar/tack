/**
 * Worker scheduling.
 *
 * The semantics here are the ones a scheduled agent learns the hard way:
 *
 *  - A missed slot is NOT a debt. If the machine was asleep at 12:30, the
 *    12:30 run does not happen at 14:00 and it does not happen twice at
 *    20:30. Queuing missed work means a laptop opened after a weekend fires
 *    a burst of outbound activity, which is both bad behaviour and exactly
 *    the pattern that gets an account restricted.
 *
 *  - A late run within the grace window is still worth doing. Opening the
 *    laptop twenty minutes late should not skip the day.
 *
 *  - Jitter spreads load. It exists so that many users' workers do not fire
 *    on the same second, not so that any individual worker looks human.
 */

export interface WorkerSchedule {
  /** Local times in HH:MM, in `timezone`. */
  times: string[];
  /** Weekdays the slots fall on, 0 = Sunday … 6 = Saturday. Omitted means every day. */
  days?: number[];
  /** IANA zone, e.g. "Asia/Kolkata". */
  timezone: string;
  /** Random spread applied to each slot, in minutes. Load, not disguise. */
  jitterMinutes?: number;
  /** How late a run may start and still be worth doing, in minutes. */
  graceMinutes?: number;
  /**
   * Prefer the cheaper model pricing window when the task is not time
   * sensitive. DeepSeek charges half price outside 01:00–04:00 and
   * 06:00–10:00 UTC on weekdays, so a worker with no deadline can shift and
   * halve its model cost for no behavioural change.
   */
  preferOffPeak?: boolean;
}

const DAY_MS = 86_400_000;

/** How late a run may start when the schedule does not say. */
const DEFAULT_GRACE_MINUTES = 90;

export interface Slot {
  /** When this slot was due. */
  due: Date;
  /** When it should actually fire, after jitter. */
  fireAt: Date;
  label: string;
}

/** Peak pricing: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. */
export function isPeakPricing(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** Wall-clock fields of `at` in `timezone`. */
export function zonedParts(at: Date, timezone: string): {
  year: number; month: number; day: number; hour: number; minute: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) if (p.type !== 'literal') parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    // Intl renders midnight as 24 in some locales/zones.
    hour: Number(parts.hour) % 24, minute: Number(parts.minute),
  };
}

/**
 * The UTC instant for a given wall-clock time in a zone.
 *
 * Solved by iteration rather than arithmetic: offsets change with DST, and a
 * fixed-offset calculation silently drifts by an hour twice a year.
 */
export function zonedTimeToUtc(
  timezone: string,
  y: number, mo: number, d: number, h: number, mi: number,
): Date {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(new Date(guess), timezone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    const drift = target - actual;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

function parseTime(hhmm: string): { hour: number; minute: number } {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`invalid schedule time: ${hhmm}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid schedule time: ${hhmm}`);
  return { hour, minute };
}

/** Deterministic jitter, so a slot's fire time does not move between calls. */
function jitterFor(due: Date, minutes: number): number {
  if (!minutes) return 0;
  let hash = 2166136261;
  for (const ch of due.toISOString()) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const unit = ((hash >>> 0) % 10_000) / 10_000;
  return Math.round(unit * minutes * 60_000);
}

/** Every slot due in [from, to), in order. */
export function slotsBetween(schedule: WorkerSchedule, from: Date, to: Date): Slot[] {
  const slots: Slot[] = [];
  const days = schedule.days?.length ? new Set(schedule.days) : null;
  for (let t = from.getTime() - DAY_MS; t <= to.getTime() + DAY_MS; t += DAY_MS) {
    const { year, month, day } = zonedParts(new Date(t), schedule.timezone);
    if (days && !days.has(weekdayOf(schedule.timezone, year, month, day))) continue;
    for (const hhmm of schedule.times) {
      const { hour, minute } = parseTime(hhmm);
      const due = zonedTimeToUtc(schedule.timezone, year, month, day, hour, minute);
      if (due < from || due >= to) continue;
      if (slots.some((s) => s.due.getTime() === due.getTime())) continue;
      slots.push({
        due,
        fireAt: new Date(due.getTime() + jitterFor(due, schedule.jitterMinutes ?? 0)),
        label: `${hhmm} ${schedule.timezone}`,
      });
    }
  }
  return slots.sort((a, b) => a.due.getTime() - b.due.getTime());
}

/** Day of week of a civil date in a zone, 0 = Sunday. */
function weekdayOf(timezone: string, y: number, mo: number, d: number): number {
  const noon = zonedTimeToUtc(timezone, y, mo, d, 12, 0);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(noon);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

function nextSlot(schedule: WorkerSchedule, after: Date): Slot | null {
  const horizon = new Date(after.getTime() + 8 * DAY_MS);
  return slotsBetween(schedule, new Date(after.getTime() + 1), horizon)[0] ?? null;
}

export type SlotDecision =
  | { action: 'run'; slot: Slot; lateMinutes: number }
  | { action: 'skip'; slot: Slot; why: string }
  | { action: 'wait'; until: Date };

/**
 * Decide what to do about the slots between `lastCheck` and `now`.
 *
 * At most ONE run comes out of this, whatever happened while the machine was
 * off. If three slots were missed over a weekend, the most recent one inside
 * the grace window runs and the rest are skipped with a reason.
 */
export function decideSlot(
  schedule: WorkerSchedule,
  lastCheck: Date,
  now: Date,
  lastRunDue?: Date,
): SlotDecision {
  const graceMinutes = schedule.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const grace = graceMinutes * 60_000;
  const owed = slotsBetween(schedule, lastCheck, now)
    .filter((s) => !lastRunDue || s.due.getTime() > lastRunDue.getTime());
  const due = owed.filter((s) => s.fireAt <= now);

  if (!due.length) {
    // Its time has come and its jittered moment has not: that is the wait.
    if (owed.length) return { action: 'wait', until: owed[0].fireAt };
    const next = nextSlot(schedule, now);
    return next ? { action: 'wait', until: next.fireAt } : { action: 'wait', until: new Date(now.getTime() + 3_600_000) };
  }

  const newest = due[due.length - 1];
  const lateMs = now.getTime() - newest.fireAt.getTime();

  if (lateMs > grace) {
    return {
      action: 'skip',
      slot: newest,
      why: `${Math.round(lateMs / 60_000)} minutes late, past the ${graceMinutes}-minute grace window — a skipped slot is not a debt`,
    };
  }
  return { action: 'run', slot: newest, lateMinutes: Math.round(lateMs / 60_000) };
}

/**
 * How far a check at `now` has really looked at the schedule.
 *
 * Not past a slot whose time has come but whose jittered moment has not.
 * Moving the watermark to `now` on every pass would put a slot due at 09:00
 * with four minutes of jitter behind it by 09:00:30, and it would never run:
 * with five minutes of jitter and a thirty-second tick, most slots would be lost.
 */
export function checkedUpTo(schedule: WorkerSchedule, lastCheck: Date, now: Date, lastRunDue?: Date): Date {
  const pending = slotsBetween(schedule, lastCheck, now)
    .find((s) => s.fireAt > now && (!lastRunDue || s.due.getTime() > lastRunDue.getTime()));
  return pending ? pending.due : now;
}
