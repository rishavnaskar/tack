// The autopilot's steps against the real app, and the scheduler that runs it, retries the apply
// queue and reads replies every few hours while Tack is running.

import * as store from './store.ts';
import { isHosted } from './hosted.ts';
import * as engine from './engine.ts';
import * as queue from './apply-queue.ts';
import * as llm from './llm.ts';
import { buildGap, postingFit } from './gap.ts';
import { insights, isResponse, markGhosted, mulberry32 } from './tracker.ts';
import { buildKit, cachedKit } from './kit.ts';
import { activeBatches, applyNow, closeOrphanRuns, getConsent, getDetails, getResume, isDemo, isDryRun, runDue } from './apply.ts';
import { localDate, replan } from './plan.ts';
import { computeProgress } from './progress.ts';
import { latestFinishedScore } from './interview.ts';
import { snapshotPostings } from './demo/load.ts';
import { syncSkills } from './routes/b.ts';
import {
  choosePicks, compileReport, createAutopilot, getSettings, HARD_CAP, inQuiet, listRuns, nextRunAt, readinessOf, replanReason,
  type Autopilot, type StepFns,
} from './autopilot.ts';
import type { Application, GapMap, Goal, InterviewSession, Plan, Posting, Profile } from './types.ts';

const MAIL_LAST = 'mail-last-check';

async function eachLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function dailyRng(apps: Application[], now: Date) {
  const key = `${localDate(now)}|${apps.length}|${apps.filter((a) => isResponse(a.status)).length}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return mulberry32(h >>> 0);
}

const brief = (p: Pick<Posting, 'company' | 'title'>) => ({ company: p.company, title: p.title });

export function currentReadiness() {
  return readinessOf({
    profile: store.get<Profile>('single', 'profile'), goal: store.get<Goal>('single', 'goal'), details: getDetails(),
    resume: !!getResume(), model: llm.configured(), consent: getConsent().on, demo: isDemo(),
  });
}

export const liveSteps: StepFns = {
  async harvest(ctx) {
    const goal = store.get<Goal>('single', 'goal');
    const profile = store.get<Profile>('single', 'profile');
    const before = store.list<Posting>('posting');
    const known = new Set(before.map((p) => p.id));
    let fresh: Posting[];
    let live = false;
    if (isDemo()) {
      fresh = snapshotPostings();
    } else {
      if (!goal?.targetRole) throw new Error('No target role to search for.');
      if (!(await engine.available())) throw new Error('The public job boards are not reachable right now, so nothing was read.');
      const location = goal.remote ? `${goal.location || 'India'} or remote` : goal.location;
      ctx.note(`${goal.targetRole} in ${location || 'any place'}, up to 40`);
      fresh = await engine.harvest(goal.targetRole, location, 40);
      if (!fresh.length) throw new Error(`No open roles fit "${goal.targetRole}" on the job boards right now.`);
      live = true;
      // A live market replaces any sample postings; a real person never applies to those.
      for (const old of before) if (!old.live) store.del('posting', old.id);
    }
    for (const p of fresh) {
      const prev = store.get<Posting>('posting', p.id);
      const next: Posting = { ...p, skills: p.skills ?? prev?.skills };
      delete next.closedAt;
      if (profile && next.skills?.length) { try { next.fit = postingFit(profile, next); } catch { /* keep */ } }
      store.put('posting', next.id, next);
    }
    const ids = new Set(fresh.map((p) => p.id));
    const added = fresh.filter((p) => !known.has(p.id));
    const gone = before.filter((p) => p.live && !ids.has(p.id) && !p.closedAt);
    const closed: Posting[] = [];
    // Out of the top forty is not closed: only a posting whose page no longer answers is.
    await eachLimit(gone, 6, async (p) => {
      if (await engine.verifyUrl(p.url)) return;
      store.put('posting', p.id, { ...p, closedAt: ctx.now().toISOString() });
      closed.push(p);
    });
    const note = `${fresh.length} postings ${live ? 'from live job boards' : 'from the sample set'}: ${added.length} new, ${closed.length} closed`;
    return { note, data: { postings: fresh.length, live, note, fresh: added.slice(0, 25).map(brief), closed: closed.map(brief) } };
  },

  async gap() {
    const prev = store.get<GapMap>('single', 'gap');
    const gap = await buildGap();
    return {
      note: `readiness ${gap.readiness}${prev && prev.readiness !== gap.readiness ? ` (was ${prev.readiness})` : ''}, ${gap.skills.length} skills from ${gap.postingCount} postings`,
      data: { before: prev?.readiness, after: gap.readiness },
    };
  },

  async rank(ctx) {
    const now = ctx.now();
    const apps = store.list<Application>('application');
    for (const a of markGhosted(apps, now)) store.put('application', a.id, a);
    const profile = store.get<Profile>('single', 'profile');
    const postings = store.list<Posting>('posting').filter((p) => !p.closedAt && (isDemo() || p.live));
    const fitOf = (p: Posting) => p.fit ?? (profile ? (() => { try { return postingFit(profile, p); } catch { return 50; } })() : 50);
    const next = insights(apps, postings, { fitOf, rng: dailyRng(apps, now), limit: 60 }).next;
    const cap = Math.min(ctx.settings.dailyCap, HARD_CAP);
    const left = Math.max(0, cap - queue.sentToday(now));
    if (!left) return { note: `today's cap of ${cap} is reached`, data: { picks: [], considered: next.length, left } };
    const picks = choosePicks(next, new Map(postings.map((p) => [p.id, p])), ctx.settings, left);
    return {
      note: picks.length ? `picked ${picks.length} of ${next.length}: ${picks.map((p) => `${p.company} (fit ${p.fit})`).join(', ')}` : `none of ${next.length} unapplied postings clears fit ${ctx.settings.minFit} and the exclusions`,
      data: { picks, considered: next.length, left },
    };
  },

  async kits(ctx) {
    const picks = ctx.data.rank?.picks ?? [];
    if (!picks.length) return { note: 'nothing picked', skipped: true, data: { built: 0 } };
    let built = 0;
    let cached = 0;
    const failed: string[] = [];
    await eachLimit(picks as { postingId: string; company: string }[], 2, async (p) => {
      if (cachedKit(p.postingId)) { cached++; return; }
      try { await buildKit(p.postingId); built++; } catch (e) { failed.push(`${p.company}: ${(e as Error).message.slice(0, 80)}`); }
    });
    return { note: `${built} written, ${cached} already ready${failed.length ? `; ${failed.length} failed (${failed.join('; ')})` : ''}`, data: { built, cached, failed } };
  },

  async apply(ctx) {
    const picks: { postingId: string; why: string }[] = ctx.data.rank?.picks ?? [];
    if (!picks.length) return { note: 'nothing to apply to', skipped: true, data: { jobs: [] } };
    const postings = picks.map((p) => store.get<Posting>('posting', p.postingId)).filter((p): p is Posting => !!p && !p.closedAt);
    const why = new Map(picks.map((p) => [p.postingId, p.why]));
    if (ctx.settings.needsApproval) {
      const { added, skipped } = queue.enqueue(postings, { source: 'autopilot', autopilotRunId: ctx.run.id, state: 'awaiting-approval', why });
      return { note: `${added.length} waiting for your yes under Autopilot${skipped.length ? `; ${skipped.length} left out (${skipped.map((s) => s.why).join('; ')})` : ''}`, data: { jobs: added.map((j) => j.id), skipped } };
    }
    const r = applyNow(postings, { source: 'autopilot', autopilotRunId: ctx.run.id, why });
    if (r.skipped.length) ctx.note(`left out: ${r.skipped.map((s) => `${s.company} (${s.why})`).join('; ')}`);
    const batch = await r.done;
    const jobs = queue.allJobs().filter((j) => j.autopilotRunId === ctx.run.id);
    return {
      note: batch?.note ?? 'nothing new to apply to',
      data: { batchId: batch?.id, jobs: jobs.map((j) => ({ id: j.id, postingId: j.postingId, state: j.state })), skipped: r.skipped },
    };
  },

  async mail(ctx) {
    const status = await engine.mailStatus();
    if (!status.connected) return { note: `not read: ${status.note}`, skipped: true, data: null };
    const result = await engine.checkMail((s, d) => ctx.note(`${s}: ${d}`));
    store.put('single', MAIL_LAST, { at: ctx.now().toISOString(), note: result.note });
    return { note: `${result.source === 'sample' ? 'sample mailbox: ' : ''}${result.note}`, data: { result } };
  },

  async replan(ctx) {
    const plan = store.get<Plan>('single', 'plan');
    const goal = store.get<Goal>('single', 'goal');
    if (!plan || !goal) return { note: 'no plan yet', skipped: true, data: { changed: false, summary: 'no plan yet' } };
    const now = ctx.now();
    const sessions = store.list<InterviewSession>('interview');
    const progress = computeProgress({
      plan, gap: store.get<GapMap>('single', 'gap'), readiness: store.list('readiness'), sessions,
      applications: store.list<Application>('application'), now, start: store.get('skillbase', 'start'),
    });
    const since = plan.changes.at(-1)?.at ?? plan.createdAt;
    const avg = latestFinishedScore(sessions.filter((s) => s.finishedAt && s.finishedAt > since));
    const invites = (ctx.data.mail?.result?.changes ?? []).filter((c: { to: string }) => c.to === 'interview').length;
    const why = replanReason({ onTrack: progress.onTrack, interviewAvg: avg, invites });
    if (!why) return { note: 'on track; the plan stays as it is', data: { changed: false, summary: 'on track, no change' } };
    const next = replan({ plan, goal, today: localDate(now), gap: store.get<GapMap>('single', 'gap'), reason: why, interviewAvg: avg });
    store.put('single', 'plan', next);
    syncSkills(next);
    const change = next.changes.at(-1)!;
    return { note: `plan v${next.version}: ${change.summary}`, data: { changed: true, summary: `${why.replace(/^Autopilot: /, '')}. ${change.summary}`, version: next.version } };
  },

  async report(ctx) {
    const r = compileReport(ctx.data, ctx.run.steps, queue.allJobs());
    return { note: r.summary, data: r };
  },
};

let ap: Autopilot | null = null;

export function autopilot(): Autopilot {
  ap ??= createAutopilot({ steps: liveSteps });
  return ap;
}

export interface MailClock { at: string; note: string }

export function mailClock(): { last?: MailClock; next?: string } {
  const s = getSettings();
  const last = store.get<MailClock>('single', MAIL_LAST);
  if (!s.mailEveryHours) return { last };
  const next = last ? new Date(Date.parse(last.at) + s.mailEveryHours * 3_600_000).toISOString() : undefined;
  return { last, next };
}

let mailBusy = false;
let dueBusy = false;

/** One look at the clock: a scheduled run, queue retries, a mail check, each when its time has come. */
export async function tick(now = new Date()): Promise<string[]> {
  const did: string[] = [];
  const s = getSettings();
  const a = autopilot();
  const ready = currentReadiness().ready;
  const quiet = inQuiet(now, s.quietHours);
  // A run a crashed process left is picked up once its lock has gone quiet.
  if (!a.running() && a.recover()) did.push('resume');
  if (s.on && ready && !a.running() && !quiet) {
    const at = nextRunAt(s, listRuns(1)[0], now);
    if (at && now >= at && !activeBatches().length) {
      try { a.start('schedule', { dryRun: isDryRun() }).done.catch(() => {}); did.push('autopilot'); } catch { /* another run holds the lock */ }
    }
  }
  if (ready && !quiet && !a.running() && !dueBusy && !activeBatches().length && queue.dueJobs(now, 1).length) {
    dueBusy = true;
    const r = runDue({ now });
    did.push('retries');
    void r.done.catch(() => null).finally(() => { dueBusy = false; });
  }
  const mail = mailClock();
  const mailDue = s.mailEveryHours > 0 && (!mail.last || Date.parse(mail.next!) <= now.getTime());
  const connected = engine.sampleMail() || store.get<boolean>('single', 'mail-connected') === true;
  if (mailDue && connected && store.get('single', 'profile') && !a.running() && !mailBusy) {
    mailBusy = true;
    did.push('mail');
    void engine.checkMail(() => {}).then((r) => store.put('single', MAIL_LAST, { at: new Date().toISOString(), note: r.note }))
      .catch((e: Error) => store.put('single', MAIL_LAST, { at: new Date().toISOString(), note: `failed: ${e.message.slice(0, 160)}` }))
      .finally(() => { mailBusy = false; });
  }
  return did;
}

let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the clock once per process: picks up a run a crash left, then looks every 30 seconds.
 * Never in hosted mode, where the store belongs to a request's session and nothing may run on a timer.
 */
export function startScheduler(everyMs = Number(process.env.TACK_TICK_MS) || 30_000): void {
  if (ticker || process.env.TACK_SCHEDULER === 'off' || isHosted()) return;
  queue.recoverInterrupted();
  closeOrphanRuns();
  autopilot().recover()?.done.catch(() => {});
  ticker = setInterval(() => { void tick().catch(() => {}); }, everyMs);
  ticker.unref?.();
}

export function stopScheduler(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
