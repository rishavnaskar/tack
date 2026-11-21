import type { AppState, GapMap, Goal, Posting, Profile, ProfileSkill } from '../types.ts';
import { HttpError, openSse, type Router } from '../server.ts';
import * as store from '../store.ts';
import * as engine from '../engine.ts';
import { configured, modelName } from '../llm.ts';
import { recent, run, subscribe } from '../trace.ts';
import { InputError, parseResume, suggestRoles } from '../intake.ts';
import { buildGap, postingFit, recompute } from '../gap.ts';
import { canonical, skillId } from '../skills.ts';
import { loadDemo, snapshotPostings } from '../demo/load.ts';
import { isDemo, saveResume } from '../apply.ts';
import { isHosted } from '../hosted.ts';

export async function state(): Promise<AppState> {
  const eng = await engine.status();
  const stored = store.get<'demo' | 'live'>('single', 'mode');
  // Mode says what the data on screen is: live postings make it live, the bundled sample does not.
  const postings = store.list<Posting>('posting');
  const fromData = postings.length ? (postings.some((p) => p.live) ? 'live' : 'demo') : undefined;
  return {
    mode: stored ?? fromData ?? (eng.available ? 'live' : 'demo'),
    engine: eng,
    model: { configured: configured(), name: modelName() },
    profile: store.get<Profile>('single', 'profile'),
    goal: store.get<Goal>('single', 'goal'),
    counts: {
      postings: postings.length,
      applications: store.list('application').length,
      interviews: store.list('interview').length,
    },
    has: {
      gap: Boolean(store.get('single', 'gap')),
      plan: Boolean(store.get('single', 'plan')),
      portfolio: store.list('portfolio').length > 0,
    },
  };
}

function refreshGapIfAny(): void {
  if (!store.get('single', 'gap')) return;
  try { recompute(); } catch { /* nothing to recompute against yet */ }
}

function text(v: unknown, field: string, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  return v.trim();
}

function num(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be a number from ${min} to ${max}.`);
  return n;
}

function nextMonday(from = new Date()): string {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function cleanProfile(body: any): Profile {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'profile must be an object');
  const strs = (v: unknown, field: string) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new HttpError(400, `${field} must be a list.`);
    return v.map((x) => String(x).trim()).filter(Boolean);
  };
  if (body.skills !== undefined && !Array.isArray(body.skills)) throw new HttpError(400, 'skills must be an array');
  const skills: ProfileSkill[] = (body.skills ?? []).map((s: any, i: number) => {
    const name = text(s?.name, `skills[${i}].name`, true);
    const id = typeof s.id === 'string' && s.id ? skillId(s.id) : skillId(name);
    return { id, name: s.id ? name : canonical(name).name, level: num(s.level, `skills[${i}].level`, 0, 5, 1), evidence: strs(s.evidence, `skills[${i}].evidence`) };
  });
  if (body.experience !== undefined && !Array.isArray(body.experience)) throw new HttpError(400, 'experience must be an array');
  return {
    name: text(body.name, 'name', true),
    headline: text(body.headline, 'headline'),
    currentRole: text(body.currentRole, 'currentRole'),
    yearsExperience: num(body.yearsExperience, 'yearsExperience', 0, 60, 0),
    summary: text(body.summary, 'summary'),
    skills,
    experience: (body.experience ?? []).map((r: any, i: number) => ({
      title: text(r?.title, `experience[${i}].title`), company: text(r?.company, `experience[${i}].company`),
      start: text(r?.start, `experience[${i}].start`), end: text(r?.end, `experience[${i}].end`), bullets: strs(r?.bullets, `experience[${i}].bullets`),
    })),
    education: strs(body.education, 'education'),
    projects: strs(body.projects, 'projects'),
    source: body.source === 'pdf' || body.source === 'demo' ? body.source : 'text',
  };
}

function cleanGoal(body: any): Goal {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'goal must be an object');
  const targetRole = text(body.targetRole, 'targetRole', true);
  if (!targetRole) throw new HttpError(400, 'targetRole is required');
  const startDate = text(body.startDate, 'startDate') || nextMonday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(startDate))) throw new HttpError(400, 'startDate must be YYYY-MM-DD');
  return {
    targetRole,
    location: text(body.location, 'location'),
    remote: Boolean(body.remote),
    hoursPerWeek: num(body.hoursPerWeek, 'hoursPerWeek', 1, 80, 10),
    weeks: Math.round(num(body.weeks, 'weeks', 1, 52, 12)),
    startDate,
    notes: text(body.notes, 'notes'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mount(r: Router): void {
  r.get('/state', () => state());

  r.post('/demo/load', async () => {
    await loadDemo();
    return state();
  });

  r.post('/reset', () => {
    store.clear();
    return state();
  });

  r.post('/profile/resume', async ({ body }) => {
    const hasText = typeof body?.text === 'string' && body.text.trim();
    const hasPdf = typeof body?.pdfBase64 === 'string' && body.pdfBase64.length > 0;
    if (!hasText && !hasPdf) throw new HttpError(400, 'send {text} or {pdfBase64, filename}');
    if (!configured()) throw new HttpError(503, 'no model key configured; résumé reading needs the model (or load the demo person)');
    let profile: Profile;
    try {
      profile = await parseResume({ text: hasText ? body.text : undefined, pdfBase64: hasPdf ? body.pdfBase64.replace(/^data:[^,]*,/, '') : undefined, filename: body.filename });
    } catch (err) {
      if (err instanceof InputError) throw new HttpError(400, err.message);
      throw err;
    }
    store.put('single', 'profile', profile);
    // The file itself is kept for applying: it is what gets uploaded to a form.
    saveResume(hasPdf
      ? { filename: typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : 'resume.pdf', mime: 'application/pdf', base64: body.pdfBase64.replace(/^data:[^,]*,/, '') }
      : { filename: 'resume.txt', mime: 'text/plain', text: body.text });
    // A real résumé replaces the demo person; mode now follows the engine.
    store.del('single', 'mode');
    refreshGapIfAny();
    return profile;
  });

  r.put('/profile', ({ body }) => {
    const profile = cleanProfile(body);
    store.put('single', 'profile', profile);
    refreshGapIfAny();
    return profile;
  });

  r.put('/goal', ({ body }) => {
    const goal = cleanGoal(body);
    store.put('single', 'goal', goal);
    return goal;
  });

  r.post('/roles/suggest', async () => {
    const profile = store.get<Profile>('single', 'profile');
    if (!profile) throw new HttpError(400, 'add a résumé first');
    return suggestRoles(profile, store.get<Goal>('single', 'goal')?.targetRole);
  });

  r.post('/postings/harvest', async ({ body }) => {
    const count = Math.round(num(body?.count, 'count', 1, 100, 40));
    const goal = store.get<Goal>('single', 'goal');
    const profile = store.get<Profile>('single', 'profile');
    const role = goal?.targetRole || 'AI Product Manager';
    const location = goal?.remote ? `${goal.location || 'India'} or remote` : goal?.location || 'Bengaluru';
    const t = run('harvest');
    t.step('search', `${role} in ${location}, up to ${count}`);
    let postings: Posting[] = [];
    let live = false;
    if (await engine.available()) {
      postings = await engine.harvest(role, location, count);
      live = postings.length > 0;
      if (!live) t.step('engine', 'engine returned nothing; falling back to the bundled snapshot');
    } else {
      t.step('engine', 'browser engine not attached; reading the bundled snapshot');
    }
    // Sample postings are only ever the demo person's; a real person gets live ones or a plain reason.
    // The web preview applies to nothing, so there the sample stands in when the boards cannot be read.
    if (!live && !isDemo() && !isHosted()) {
      t.fail('no live postings could be read');
      throw new HttpError(503, (await engine.status()).available
        ? `No jobs match "${role}" right now. Try a broader role.`
        : 'Cannot reach job boards right now. Check your connection and try again.');
    }
    if (!live) postings = snapshotPostings().slice(0, count);
    else {
      // A live market replaces the bundled snapshot rather than mixing with it.
      for (const old of store.list<Posting>('posting')) if (!old.live) store.del('posting', old.id);
      store.del('single', 'mode');
    }
    const pace = Number(process.env.TACK_HARVEST_PACE_MS ?? 35);
    for (const p of postings) {
      const prev = store.get<Posting>('posting', p.id);
      const next: Posting = { ...p, skills: p.skills ?? prev?.skills };
      if (profile && next.skills?.length) next.fit = postingFit(profile, next);
      store.put('posting', next.id, next);
      t.step('read', `${next.company}: ${next.title}${next.fit != null ? `, fit ${next.fit}` : ''}`);
      if (pace > 0 && !live) await sleep(pace);
    }
    t.ok(`${postings.length} postings ${live ? 'harvested live' : 'from the snapshot'}`);
    const ids = new Set(postings.map((p) => p.id));
    return { postings: store.list<Posting>('posting').filter((p) => ids.has(p.id)), live };
  });

  r.get('/postings', () => store.list<Posting>('posting'));

  r.post('/gap/build', async () => {
    if (!store.get('single', 'profile')) throw new HttpError(400, 'add a résumé first');
    if (!store.list('posting').length) throw new HttpError(400, 'harvest postings first');
    try {
      return await buildGap();
    } catch (err) {
      if (/^no (profile|postings)/.test((err as Error).message)) throw new HttpError(400, (err as Error).message);
      if (/extraction failed/.test((err as Error).message)) throw new HttpError(502, (err as Error).message);
      throw err;
    }
  });

  r.get('/gap', () => {
    const gap = store.get<GapMap>('single', 'gap');
    if (!gap) throw new HttpError(404, 'no gap map yet');
    return gap;
  });

  r.get('/events', ({ req, res, query }) => {
    let off = () => {};
    const send = openSse(res, () => off());
    const since = query.get('since') ?? (req.headers['last-event-id'] as string | undefined);
    for (const ev of recent()) if (!since || ev.id > since) send(ev, ev.id);
    off = subscribe((ev) => send(ev, ev.id));
    return undefined;
  });
}
