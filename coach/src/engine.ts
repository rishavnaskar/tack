import type { Application, MailMessage, MailStatus, Posting, SyncResult } from './types.ts';
import { emit } from './trace.ts';
import * as llm from './llm.ts';
import { ensureEngine, info as engineInfo, type EngineHandle } from './engine-proc.ts';
import { McpClient, ownerCall, unfence } from './engine-client.ts';
import { checkReplies, gmailQuery, parseGmailResults, sampleMailbox, searchSample } from './replies.ts';
import { getDetails, isDemo, syncEngineProfile } from './apply.ts';

// The only module the routes use to reach ../engine. The work lives in engine-live.ts,
// loaded on first use so a missing or broken engine leaves demo mode running.
// Every call degrades to "not available" and never throws.

const SNAPSHOT = 'running on the bundled snapshot';


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

// ------------------------------------------------------------ mail

/** The demo person, or TACK_MAIL=sample, reads the bundled sample mailbox and never anyone's real mail. */
export function sampleMail(): boolean {
  return process.env.TACK_MAIL === 'sample' || isDemo();
}

const SAMPLE_NOTE = '12 sample messages from the demo companies. No real mail is read.';

async function withMcp<T>(h: EngineHandle, fn: (mcp: McpClient) => Promise<T>): Promise<T> {
  const mcp = await new McpClient(h).connect();
  try { return await fn(mcp); } finally { await mcp.close(); }
}

/** Fanfold stays locked until it has a name and email, so Tack gives it the person's before asking for mail. */
async function unlock(h: EngineHandle): Promise<string | null> {
  if (h.mode === 'attach') return null;
  const d = getDetails();
  if (!d?.fullName || !d.email) return 'Add your name and email under Application details on Start first: the engine needs them before it can connect Gmail.';
  await syncEngineProfile(h, () => {}, { identityOnly: true });
  return null;
}

export async function mailStatus(): Promise<MailStatus> {
  const engine = engineInfo().mode;
  if (sampleMail()) return { source: 'sample', connected: true, label: 'Sample mailbox', note: SAMPLE_NOTE, canConnect: false, engine };
  if (process.env.TACK_ENGINE === 'off') return { source: 'none', connected: false, label: 'Mail off', note: 'The engine is turned off by TACK_ENGINE=off.', canConnect: false, engine: 'off' };
  try {
    const h = await ensureEngine();
    const blocked = await unlock(h);
    if (blocked) return { source: 'none', connected: false, label: 'Gmail not connected', note: blocked, canConnect: false, engine: h.mode };
    const text = await withMcp(h, async (mcp) => (await mcp.call('connectors', {})).text);
    // A Fanfold with sign-in on answers nothing until its owner signs in there.
    if (/not signed in to Fanfold/i.test(text)) {
      return { source: 'none', connected: false, label: 'Fanfold is locked', note: unfence(text).replace(/^The user is/, 'You are').replace(/Ask them to open/, 'Open').replace(/ in their browser/, '').replace(/, then call the tool again\.?/, ', then check again.'), canConnect: false, engine: h.mode };
    }
    const connected = /Gmail search: connected/.test(text);
    const canConnect = h.mode === 'own' && !!process.env.GOOGLE_CLIENT_ID;
    return {
      source: connected ? 'gmail' : 'none', connected, engine: h.mode, canConnect: !connected && canConnect,
      label: connected ? 'Gmail connected' : 'Gmail not connected',
      note: connected ? `Read-only search through ${h.mode === 'own' ? 'Tack\'s engine' : 'your running Fanfold'}; only sender, subject and snippet are kept.`
        : h.mode === 'attach' ? 'Connect Gmail in Fanfold itself; Tack uses that connection.'
          : canConnect ? 'Connect Gmail to read replies. Access is read-only.' : 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Gmail.',
    };
  } catch (e) {
    return { source: 'none', connected: false, label: 'Mail not available', note: (e as Error).message, canConnect: false, engine };
  }
}

/** Starts Google's consent in the engine and returns the address the person opens. */
export async function mailConnect(): Promise<{ url: string }> {
  if (sampleMail()) throw new Error('The demo person reads the sample mailbox; there is nothing to connect.');
  const h = await ensureEngine();
  if (h.mode === 'attach') throw new Error('Tack is using your running Fanfold; connect Gmail there.');
  const blocked = await unlock(h);
  if (blocked) throw new Error(blocked);
  const r = await ownerCall<{ consentUrl?: string; error?: string }>(h, 'POST', '/api/connectors/google/start', {});
  if (!r.consentUrl) throw new Error(r.error ?? 'Google did not give a sign-in address.');
  return { url: r.consentUrl };
}

/** Checks the connection once the person has finished in Google's window. */
export async function mailCheck(): Promise<MailStatus> {
  const h = await ensureEngine();
  if (h.mode === 'own') await ownerCall(h, 'POST', '/api/connectors/google/check', {}).catch(() => null);
  return mailStatus();
}

const hashMs = (s: string, lo: number, hi: number) => {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return lo + ((x >>> 0) % (hi - lo + 1));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Searches mail for every open application in parallel, classifies what is new and moves statuses. */
export async function checkMail(step: (s: string, d: string) => void): Promise<SyncResult> {
  const ask = llm.configured() ? (llm.json as Parameters<typeof checkReplies>[0]['ask']) : null;
  const concurrency = Number(process.env.TACK_MAIL_CONCURRENCY) || 4;
  if (sampleMail()) {
    const box = sampleMailbox();
    // The sample answers at a search's pace, so the parallel searches read as they would against Gmail.
    const pace = Number(process.env.TACK_SAMPLE_MAIL_PACE_MS ?? 350);
    step('mail', `sample mailbox: ${box.length} messages, searching ${concurrency} companies at a time`);
    return checkReplies({ source: 'sample', ask, concurrency, step, search: async (c) => { if (pace > 0) await sleep(hashMs(c, pace / 2, pace * 1.5)); return searchSample(box, c); } });
  }
  const status = await mailStatus();
  if (!status.connected) {
    return { added: 0, updated: 0, note: status.note, source: 'none', searched: 0, messages: 0, classified: {}, by: 'none', changes: [], ms: 0 };
  }
  const h = await ensureEngine();
  step('mail', `Gmail through ${h.mode === 'own' ? 'Tack\'s engine' : 'your running Fanfold'}, ${concurrency} searches at a time`);
  return withMcp(h, (mcp) => checkReplies({
    source: 'gmail', ask, concurrency, step,
    search: async (company): Promise<MailMessage[]> => {
      const r = await mcp.call('gmail_search', { query: gmailQuery(company) });
      if (r.isError) throw new Error(r.text.slice(0, 200));
      return parseGmailResults(unfence(r.text), company);
    },
  }));
}
