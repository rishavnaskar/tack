// Autopilot, the apply queue and its "needs you" list, standing consent, and Gmail disconnect.

import { HttpError, type Router } from '../server.ts';
import * as engine from '../engine.ts';
import * as queue from '../apply-queue.ts';
import { activeBatches, CONSENT_LABEL, getConsent, isDemo, isDryRun, readiness, recentRuns, runDue, setConsent } from '../apply.ts';
import {
  BusyError, getRun, getSettings, listRuns, nextRunAt, saveSettings, SettingsError, STEPS, validateSettings, type AutopilotRun,
} from '../autopilot.ts';
import { autopilot, currentReadiness, hosted, mailClock, startScheduler } from '../autopilot-steps.ts';
import { recent } from '../trace.ts';
import { sharedBudget } from '../limiter.ts';

const brief = (r: AutopilotRun) => ({
  id: r.id, trigger: r.trigger, startedAt: r.startedAt, endedAt: r.endedAt, ms: r.ms, status: r.status, resumes: r.resumes, dryRun: r.dryRun,
  summary: r.report?.summary, steps: r.steps.map((s) => ({ name: s.name, label: s.label, status: s.status, ms: s.ms, note: s.note })),
});

function status() {
  const settings = getSettings();
  const runs = listRuns(20);
  const runningId = autopilot().running();
  const now = new Date();
  return {
    settings,
    steps: STEPS,
    readiness: currentReadiness(),
    demo: isDemo(),
    dryRun: isDryRun(),
    hosted: hosted(),
    consent: { ...getConsent(), label: CONSENT_LABEL },
    running: runningId ? brief(getRun(runningId) ?? runs[0]) : null,
    nextRunAt: runningId ? null : nextRunAt(settings, runs[0], now)?.toISOString() ?? null,
    lastRun: runs.find((r) => r.id !== runningId) ? brief(runs.find((r) => r.id !== runningId)!) : null,
    runs: runs.map(brief),
    queue: queue.summary(now),
    needsYou: queue.needsYou(),
    remembered: queue.rememberedAnswers(),
    applying: activeBatches().length > 0,
    mail: mailClock(),
    model: sharedBudget().stats(),
  };
}

function queueError(e: unknown): never {
  if (e instanceof queue.QueueError) throw new HttpError(e.status, e.message);
  throw e;
}

export function mount(r: Router): void {
  startScheduler();

  r.get('/autopilot', () => status());

  r.put('/autopilot/settings', ({ body }) => {
    if (hosted() && body?.on === true) throw new HttpError(409, 'The autopilot runs only in the desktop app, where it can keep running between visits.');
    let next;
    try {
      next = validateSettings(body, getSettings());
    } catch (e) {
      if (e instanceof SettingsError) throw new HttpError(400, e.message);
      throw e;
    }
    if (next.on && !getSettings().on) {
      const ready = currentReadiness();
      if (!ready.ready) throw new HttpError(409, `Before the autopilot can run: ${ready.missing.map((m) => `${m.label} (${m.where})`).join('; ')}.`);
    }
    saveSettings(next);
    return status();
  });

  r.post('/autopilot/run', () => {
    if (hosted()) throw new HttpError(409, 'The autopilot runs only in the desktop app, where it can keep running between visits.');
    const ready = currentReadiness();
    if (!ready.ready) throw new HttpError(409, `Before the autopilot can run: ${ready.missing.map((m) => `${m.label} (${m.where})`).join('; ')}.`);
    if (activeBatches().length) throw new HttpError(409, 'Applications are being sent right now; run again when they finish.');
    try {
      const { run, done } = autopilot().start('manual', { dryRun: isDryRun() });
      done.catch((e) => console.error('autopilot run:', e));
      return { started: true, run: brief(run) };
    } catch (e) {
      if (e instanceof BusyError) throw new HttpError(409, e.message);
      throw e;
    }
  });

  r.get('/autopilot/runs', () => listRuns(30).map(brief));

  r.get('/autopilot/runs/:id', ({ params }) => {
    const run = getRun(params.id);
    if (!run) throw new HttpError(404, `no run ${params.id}`);
    return { ...run, trace: run.id === autopilot().running() ? recent(80).filter((e) => e.run === 'autopilot' || e.run === 'apply' || e.run.startsWith('apply ') || e.run === 'model' || e.run === 'gap' || e.run === 'harvest' || e.run === 'sync') : [] };
  });

  // ---- the queue and what needs the person ----
  r.get('/queue', () => queue.allJobs().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100));

  r.post('/queue/:id/answer', ({ params, body }) => {
    try {
      const out = queue.answerJob(params.id, typeof body?.answer === 'string' ? body.answer : '');
      return out;
    } catch (e) { return queueError(e); }
  });

  r.post('/queue/:id/retry', ({ params }) => {
    try {
      const job = queue.retryJob(params.id);
      if (!hosted() && !activeBatches().length) runDue().done.catch(() => null);
      return job;
    } catch (e) { return queueError(e); }
  });

  r.post('/queue/:id/approve', ({ params }) => {
    const job = queue.getJob(params.id);
    if (!job) throw new HttpError(404, `no job ${params.id}`);
    if (job.state !== 'awaiting-approval') throw new HttpError(409, `this job is ${job.state}`);
    try {
      const next = queue.retryJob(params.id);
      if (!hosted() && !activeBatches().length) runDue().done.catch(() => null);
      return next;
    } catch (e) { return queueError(e); }
  });

  r.post('/queue/:id/skip', ({ params }) => {
    try { return queue.skipJob(params.id); } catch (e) { return queueError(e); }
  });

  r.delete('/answers/:id', ({ params }) => {
    queue.forget(params.id);
    return { ok: true };
  });

  // ---- standing consent ----
  r.put('/consent', ({ body }) => {
    if (typeof body?.on !== 'boolean') throw new HttpError(400, 'send {on: true} or {on: false}');
    const c = setConsent(body.on);
    // Jobs stopped only for want of consent go again once it is given.
    if (c.on) for (const j of queue.needsYou()) if (j.reason === 'consent-needed') { try { queue.retryJob(j.id); } catch { /* stays as it is */ } }
    return { consent: { ...c, label: CONSENT_LABEL }, readiness: readiness() };
  });

  // ---- mail ----
  r.post('/mail/disconnect', async () => {
    try {
      return await engine.mailDisconnect();
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });

  // ---- dry runs, kept apart from real applications ----
  r.get('/apply/dry-runs', () => recentRuns(200).filter((x) => x.dryRun).map((x) => ({
    id: x.id, company: x.company, title: x.title, url: x.url, status: x.status, ms: x.ms, inspection: x.inspection, confirmation: x.confirmation, reason: x.reason, startedAt: x.startedAt,
  })));
}
