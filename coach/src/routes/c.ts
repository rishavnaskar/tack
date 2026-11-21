import { existsSync, readFileSync } from 'node:fs';
import { HttpError, type Router } from '../server.ts';
import * as store from '../store.ts';
import * as engine from '../engine.ts';
import type { Application, Posting, Profile } from '../types.ts';
import {
  detailProblems, getBatch, getDetails, getResume, MAX_PARALLEL, readiness, recentRuns, saveDetails, shotPath, startBatch, BLANK_DETAILS,
} from '../apply.ts';
import { acceptSubmission, renderConfirmation, renderForm, renderMissing, SubmissionError, submissions, summary, SUBMISSION_KIND, type PracticeSubmission } from '../practice.ts';
import { insights, mulberry32, isResponse } from '../tracker.ts';
import { postingFit } from '../gap.ts';

function detailsView() {
  const resume = getResume();
  return {
    details: getDetails() ?? BLANK_DETAILS,
    resume: resume ? { filename: resume.filename, mime: resume.mime, savedAt: resume.savedAt } : null,
    readiness: readiness(),
  };
}

// The same ranking the Tracker shows, so "top N" means the postings the person is looking at.
function topPostings(n: number): Posting[] {
  const apps = store.list<Application>('application');
  const profile = store.get<Profile>('single', 'profile');
  const fitOf = (p: Posting) => p.fit ?? (profile ? (() => { try { return postingFit(profile, p); } catch { return 50; } })() : 50);
  const key = `${new Date().toISOString().slice(0, 10)}|${apps.length}|${apps.filter((a) => isResponse(a.status)).length}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const next = insights(apps, store.list<Posting>('posting'), { fitOf, rng: mulberry32(h >>> 0), limit: n }).next;
  return next.map((x) => store.get<Posting>('posting', x.postingId)).filter((p): p is Posting => !!p).slice(0, n);
}

function launch(postings: Posting[]) {
  if (!postings.length) throw new HttpError(400, 'No postings to apply to.');
  const ready = readiness(postings[0]);
  if (!ready.ready) throw new HttpError(409, ready.reason);
  const running = recentRuns(MAX_PARALLEL * 2).filter((r) => r.status === 'queued' || r.status === 'running');
  const busy = postings.filter((p) => running.some((r) => r.postingId === p.id));
  if (busy.length) throw new HttpError(409, `Already applying to ${busy.map((p) => p.company).join(', ')}.`);
  const { batch, done } = startBatch(postings);
  done.catch((e) => console.error('apply batch:', e));
  const practice = batch.runs.filter((r) => r.target === 'practice').length;
  return {
    started: true, batch,
    note: `${batch.runs.length} application${batch.runs.length === 1 ? '' : 's'} started in parallel${practice ? `, ${practice === batch.runs.length ? 'all' : practice} on Tack's practice form` : ''}.`,
  };
}

export function mount(r: Router): void {
  // ---- application details ----
  r.get('/details', () => detailsView());

  r.put('/details', ({ body }) => {
    const draft = saveDetails(body);
    const problems = detailProblems(draft);
    return { ...detailsView(), problems };
  });

  // ---- applying ----
  r.get('/apply/readiness', ({ query }) => {
    const p = query.get('postingId') ? store.get<Posting>('posting', query.get('postingId')!) : undefined;
    return readiness(p);
  });

  r.post('/apply', ({ body }) => {
    const ids: string[] = Array.isArray(body?.postingIds) ? body.postingIds.map(String) : body?.postingId ? [String(body.postingId)] : [];
    if (!ids.length) throw new HttpError(400, 'send postingId or postingIds');
    if (ids.length > MAX_PARALLEL) throw new HttpError(400, `at most ${MAX_PARALLEL} at once`);
    const postings = ids.map((id) => {
      const p = store.get<Posting>('posting', id);
      if (!p) throw new HttpError(404, `no posting ${id}`);
      return p;
    });
    return launch(postings);
  });

  r.post('/apply/top', ({ body }) => {
    const n = Math.round(Number(body?.n ?? 3));
    if (!Number.isFinite(n) || n < 1 || n > MAX_PARALLEL) throw new HttpError(400, `n must be 1 to ${MAX_PARALLEL}`);
    return launch(topPostings(n));
  });

  r.get('/apply/batches/:id', ({ params }) => {
    const b = getBatch(params.id);
    if (!b) throw new HttpError(404, `no batch ${params.id}`);
    return b;
  });

  r.get('/apply/runs', () => recentRuns());

  r.get('/apply/runs/:id/shot', ({ params, res }) => {
    const file = shotPath(params.id);
    if (!existsSync(file)) throw new HttpError(404, 'no picture for this run');
    const png = readFileSync(file);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'max-age=3600' });
    res.end(png);
    return undefined;
  });

  // ---- mail ----
  r.get('/mail/status', () => engine.mailStatus());

  r.post('/mail/connect', async () => {
    try {
      return await engine.mailConnect();
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });

  r.post('/mail/check', () => engine.mailCheck());

  // ---- the practice application form ----
  r.page?.('/practice/apply/:postingId', ({ params, res }) => {
    const p = store.get<Posting>('posting', params.postingId);
    if (p) return renderForm(p);
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderMissing(`There is no posting ${params.postingId} in Tack.`));
    return undefined;
  });

  r.page?.('/practice/apply/:postingId/submitted/:ref', ({ params }) => {
    const s = store.get<PracticeSubmission>(SUBMISSION_KIND, params.ref);
    if (!s || s.postingId !== params.postingId) return renderMissing('That application reference is not known.');
    return renderConfirmation(s);
  });

  r.post('/practice/apply/:postingId', ({ params, body }) => {
    const p = store.get<Posting>('posting', params.postingId);
    if (!p) throw new HttpError(404, `no posting ${params.postingId}`);
    try {
      const s = acceptSubmission(p, body);
      return { ref: s.ref, next: `/practice/apply/${encodeURIComponent(p.id)}/submitted/${s.ref}` };
    } catch (e) {
      if (e instanceof SubmissionError) throw new HttpError(400, e.message);
      throw e;
    }
  });

  r.get('/practice/submissions', ({ query }) => submissions(query.get('postingId') ?? undefined).map(summary));

  r.get('/practice/submissions/:ref/resume', ({ params, res }) => {
    const s = store.get<PracticeSubmission>(SUBMISSION_KIND, params.ref);
    if (!s) throw new HttpError(404, `no submission ${params.ref}`);
    const bytes = Buffer.from(s.resume.base64, 'base64');
    res.writeHead(200, { 'content-type': s.resume.mime, 'content-length': bytes.length, 'content-disposition': `attachment; filename="${s.resume.filename.replace(/"/g, '')}"` });
    res.end(bytes);
    return undefined;
  });
}
