import type { Application, Posting } from './types.ts';
import { emit } from './trace.ts';

// The only module the routes use to reach ../engine. The work lives in engine-live.ts,
// loaded on first use so a missing or broken engine leaves demo mode running.
// Every call degrades to "not available" and never throws.

const SNAPSHOT = 'running on the bundled snapshot';

export interface MailReply { company: string; at: string; subject: string; kind: 'reply' | 'interview' | 'rejection' | 'other' }

type Live = typeof import('./engine-live.ts');
let loading: Promise<Live | { error: string }> | null = null;

function live(): Promise<Live | { error: string }> {
  loading ??= import('./engine-live.ts').catch((err: unknown) => ({ error: `engine could not load: ${(err as Error).message}` }));
  return loading;
}

// A line inside a run the route already opened, so the trace reads as one story.
function note(run: string, step: string, detail: string): void {
  try { emit({ run, step, detail, status: 'start' }); } catch { /* tracing is best effort */ }
}

export async function available(): Promise<boolean> {
  return (await status()).available;
}

export async function status(): Promise<{ available: boolean; note: string }> {
  try {
    const l = await live();
    if ('error' in l) return { available: false, note: `${l.error}; ${SNAPSHOT}` };
    const s = await l.status();
    return s.available ? s : { available: false, note: `${s.note}; ${SNAPSHOT}` };
  } catch (err) {
    return { available: false, note: `${(err as Error).message}; ${SNAPSHOT}` };
  }
}

export async function harvest(role: string, location: string, count: number): Promise<Posting[]> {
  try {
    const l = await live();
    if ('error' in l) { note('harvest', 'engine', `not available: ${l.error}`); return []; }
    note('harvest', 'engine', `reading public job boards for "${role}" near ${location}`);
    const r = await l.harvest(role, location, count, { trace: { step: (step, detail) => note('harvest', step, detail) } });
    if (!r.ok) { note('harvest', 'engine', `not available: ${r.reason}`); return []; }
    note('harvest', 'engine', `${r.boards.answered} of ${r.boards.tried} boards answered, ${r.scanned} roles scanned, ${r.matched} fit, ${r.postings.length} read in ${(r.ms / 1000).toFixed(1)} s`);
    return r.postings;
  } catch (err) {
    note('harvest', 'engine', `not available: ${(err as Error).message}`);
    return [];
  }
}

export async function applications(): Promise<Partial<Application>[]> {
  try {
    const l = await live();
    if ('error' in l) { note('sync', 'engine', `applications not available: ${l.error}`); return []; }
    const r = l.applications();
    if (!r.ok) { note('sync', 'engine', `applications not available: ${r.reason}`); return []; }
    note('sync', 'engine', `${r.applications.length} applications read from Fanfold, read-only`);
    return r.applications;
  } catch {
    return [];
  }
}

export async function mailReplies(companies: string[]): Promise<MailReply[]> {
  try {
    const l = await live();
    if ('error' in l) { note('sync', 'engine', `mail not available: ${l.error}`); return []; }
    const r = await l.mailReplies(companies);
    if (!r.ok) { note('sync', 'engine', `mail not available: ${r.reason}`); return []; }
    note('sync', 'engine', `${r.replies.length} replies found in Gmail`);
    return r.replies.map(({ company, at, subject, kind }) => ({ company, at, subject, kind }));
  } catch {
    return [];
  }
}

export async function apply(url: string): Promise<{ started: boolean; note: string }> {
  try {
    const l = await live();
    if (!('error' in l)) {
      const r = await l.apply(url);
      if (r.ok) return { started: r.started, note: r.note };
    }
  } catch { /* falls through to the hand-over note */ }
  return { started: false, note: 'Applying runs in Fanfold, where every answer is checked and you approve the submit. Open the posting, apply there or by hand, and log it in the tracker.' };
}

export async function verifyUrl(url: string): Promise<boolean> {
  try {
    const l = await live();
    return 'error' in l ? false : await l.verifyUrl(url);
  } catch {
    return false;
  }
}

/** Résumé text from a PDF, Word, RTF or text file, by the engine's readers. */
export async function resumeText(bytes: Uint8Array, mime?: string): Promise<{ ok: true; text: string; warnings: string[] } | { ok: false; reason: string }> {
  try {
    const l = await live();
    return 'error' in l ? { ok: false, reason: l.error } : l.resumeText(bytes, mime);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
