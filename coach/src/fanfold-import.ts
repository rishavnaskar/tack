// Import from Fanfold: the person's checked profile, their own saved answers and their résumé,
// read from a Fanfold state directory without changing it, written into Tack's profile, its
// application details, the facts Tack gives its engine, and its remembered answers.
// Nothing goes to the model: the profile is built from Fanfold's career record, whose quotes
// are lines of the same résumé file.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as store from './store.ts';
import { finishProfile } from './intake.ts';
import { ENGINE_FACTS, saveDetails, saveResume } from './apply.ts';
import { remember } from './apply-queue.ts';
import type { ApplicationDetails, Profile } from './types.ts';

/** Fanfold's own facts, which Tack's engine (a Fanfold) takes under the same names. */
const FACT_FIELDS = [
  'name', 'email', 'phone', 'location', 'alsoOpenTo', 'workAuthorisation', 'sponsorship', 'noticePeriod', 'earliestStart',
  'currentSalary', 'salaryExpectation', 'yearsExperience', 'linkedin', 'github', 'portfolio', 'eeoPreference',
] as const;

export class ImportError extends Error {}

export function defaultFanfoldDir(): string {
  const set = process.env.TACK_FANFOLD_STATE?.trim();
  if (set) return resolve(set.replace(/^~(?=\/)/, homedir()));
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'browser-agent')
    : join(homedir(), '.local', 'share', 'browser-agent');
}

interface Ym { y: number; m?: number }
interface CareerRole { employer?: string; title?: string; start?: Ym | null; end?: Ym | 'present' | null; quote?: string; skills?: { name?: string; quote?: string }[] }
interface CareerRecord {
  roles?: CareerRole[];
  education?: { institution?: string; degree?: string; field?: string; start?: Ym | null; end?: Ym | 'present' | null }[];
  skills?: { name?: string; quote?: string }[];
}

/** What a Fanfold directory holds that Tack can use, as read. */
export interface FanfoldData {
  facts: Record<string, string>;
  /** Answers the person gave Fanfold themselves. */
  answers: { question: string; answer: string }[];
  /** How many saved answers were left out because an agent or a guess wrote them. */
  unchecked: number;
  workRights: { country: string; note: string; status: string; confirmed: boolean; source: string }[];
  resume?: { title: string; mime: string; bytes: Buffer; text: string };
  career?: CareerRecord;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Reads a Fanfold state directory. The database is opened read-only; nothing in the directory changes. */
export function readFanfold(dir: string): FanfoldData {
  const file = join(dir, 'agent.db');
  if (!existsSync(file)) throw new ImportError(`no Fanfold database in ${dir}`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    const facts: Record<string, string> = {};
    if (has('profile_facts')) {
      for (const r of db.prepare('SELECT field, value FROM profile_facts WHERE confirmed = 1').all() as { field: string; value: string }[]) {
        if ((FACT_FIELDS as readonly string[]).includes(r.field) && str(r.value)) facts[r.field] = str(r.value);
      }
    }
    const answers: FanfoldData['answers'] = [];
    let unchecked = 0;
    if (has('answers')) {
      for (const r of db.prepare('SELECT question, answer, source FROM answers ORDER BY id').all() as { question: string; answer: string; source: string }[]) {
        if (r.source === 'you' && str(r.question) && str(r.answer)) answers.push({ question: str(r.question), answer: str(r.answer) });
        else unchecked++;
      }
    }
    const setting = (key: string) => (has('settings') ? (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value : undefined);
    const workRights: FanfoldData['workRights'] = [];
    try {
      const rights = JSON.parse(setting('profile.workRights') ?? '{}') as { entries?: Record<string, unknown>[] };
      for (const e of rights.entries ?? []) {
        workRights.push({ country: str(e.country), note: str(e.note), status: str(e.status), confirmed: e.confirmed === true, source: str(e.source) });
      }
    } catch { /* no work rights recorded */ }
    let resume: FanfoldData['resume'];
    let career: CareerRecord | undefined;
    if (has('documents')) {
      const docs = db.prepare('SELECT id, title, file_path, mime, added_at FROM documents ORDER BY added_at DESC').all() as { id: string; title: string; file_path: string | null; mime: string | null; added_at: string }[];
      const chosen = str(setting('profile.resumeDocumentId'));
      const doc = docs.find((d) => d.id === chosen) ?? docs.find((d) => /résumé|resume|\bcv\b/i.test(d.title)) ?? docs[0];
      if (doc?.file_path) {
        const path = isAbsolute(doc.file_path) ? doc.file_path : join(dir, doc.file_path);
        if (existsSync(path)) {
          const text = has('chunks')
            ? (db.prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY idx').all(doc.id) as { text: string }[]).map((c) => c.text).join('\n')
            : '';
          resume = { title: doc.title, mime: doc.mime || 'application/pdf', bytes: readFileSync(path), text };
        }
        if (has('career_records')) {
          const row = db.prepare('SELECT record FROM career_records WHERE document_id = ?').get(doc.id) as { record: string } | undefined;
          try { career = row ? JSON.parse(row.record) as CareerRecord : undefined; } catch { career = undefined; }
        }
      }
    }
    return { facts, answers, unchecked, workRights, resume, career };
  } finally {
    db.close();
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (v: Ym | 'present' | null | undefined) => (v === 'present' ? 'Present' : v?.y ? `${v.m ? `${MONTHS[v.m - 1]} ` : ''}${v.y}` : '');

/** Work authorisation in the person's own words: entries they confirmed or wrote themselves, never an agent's. */
export function workAuthorisationOf(rights: FanfoldData['workRights']): string {
  return rights.filter((r) => r.country && (r.confirmed || r.source === 'you' || r.source === 'earlier') && (r.note || r.status))
    .map((r) => `${r.country}: ${r.note || r.status}`).join('; ');
}

export interface TackImport {
  details: ApplicationDetails;
  profile: Profile;
  facts: Record<string, string>;
  answers: { question: string; answer: string }[];
  resume?: { filename: string; mime: string; base64: string };
  warnings: string[];
}

/** Fanfold's data in Tack's shapes. Pure, so it is tested without a database. */
export function toTack(data: FanfoldData, resumeText = data.resume?.text ?? ''): TackImport {
  const f = data.facts;
  const warnings: string[] = [];
  const workAuthorisation = f.workAuthorisation || workAuthorisationOf(data.workRights);
  const details: ApplicationDetails = {
    fullName: f.name ?? '', email: f.email ?? '', phone: f.phone ?? '', city: f.location ?? '', linkedin: f.linkedin ?? '',
    workAuthorisation, noticePeriod: f.noticePeriod ?? '',
  };
  if (details.linkedin && !/^https?:\/\//i.test(details.linkedin)) details.linkedin = `https://${details.linkedin.replace(/^\/+/, '')}`;
  const career = data.career ?? {};
  const roles = (career.roles ?? []).filter((r) => str(r.title) || str(r.employer));
  // Each quote is a résumé line Fanfold checked; finishProfile checks it again against the text here.
  const byName = new Map<string, string[]>();
  for (const s of [...(career.skills ?? []), ...roles.flatMap((r) => r.skills ?? [])]) {
    const name = str(s.name);
    const quote = str(s.quote);
    if (!name || !quote) continue;
    const list = byName.get(name.toLowerCase()) ?? [];
    if (!list.includes(quote)) list.push(quote);
    byName.set(name.toLowerCase(), list);
  }
  const years = Number(f.yearsExperience?.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
  const current = roles.find((r) => r.end === 'present') ?? roles[0];
  const education = (career.education ?? []).map((e) => {
    const what = [str(e.degree), str(e.field)].filter(Boolean).join(' in ');
    const span = [when(e.start), when(e.end)].filter(Boolean).join('–');
    return [what, str(e.institution)].filter(Boolean).join(', ') + (span ? ` (${span})` : '');
  }).filter(Boolean);
  const profile = finishProfile({
    name: f.name ?? '',
    headline: current ? [str(current.title), str(current.employer)].filter(Boolean).join(' at ') : '',
    currentRole: str(current?.title),
    yearsExperience: years,
    summary: '',
    // Fanfold keeps no level: a skill shown once is a working skill, more lines show more of it.
    skills: [...byName.entries()].map(([name, evidence]) => ({ name, level: Math.min(5, 2 + evidence.length), evidence })),
    experience: roles.map((r) => ({ title: str(r.title), company: str(r.employer), start: when(r.start), end: when(r.end), bullets: [] })),
    education,
    projects: [],
  }, resumeText, 'pdf');
  if (!profile.skills.length) warnings.push('no skill in the career record could be matched to the résumé text');
  if (!details.workAuthorisation) warnings.push('no work authorisation the person confirmed; forms that ask will wait for them');
  if (f.name && resumeText && !resumeText.toLowerCase().replace(/\s+/g, ' ').includes(f.name.toLowerCase())) {
    warnings.push('the résumé does not carry the profile\'s name');
  }
  const resume = data.resume ? { filename: data.resume.title, mime: data.resume.mime, base64: data.resume.bytes.toString('base64') } : undefined;
  if (!resume) warnings.push('no résumé file found');
  const facts = Object.fromEntries(Object.entries({ ...f, ...(workAuthorisation ? { workAuthorisation } : {}) }).filter(([, v]) => v));
  return { details, profile, facts, answers: data.answers, resume, warnings };
}

export interface ImportSummary {
  details: string[]; skills: number; roles: number; answers: number; leftOut: number; facts: string[]; resume: string | null; warnings: string[];
}

/** Reads the Fanfold directory and writes what it holds into Tack. Returns counts and field names, never values. */
export async function importFanfold(dir = defaultFanfoldDir(), opts: { resumeText?: (bytes: Buffer, mime: string) => Promise<string> } = {}): Promise<ImportSummary> {
  const data = readFanfold(dir);
  let text = data.resume?.text ?? '';
  if (data.resume && opts.resumeText) {
    // The file's own text, read the way Tack reads an upload, beats Fanfold's overlapping chunks.
    try { text = (await opts.resumeText(data.resume.bytes, data.resume.mime)) || text; } catch { /* keep the chunks */ }
  }
  const t = toTack(data, text);
  saveDetails(t.details);
  store.put('single', 'profile', t.profile);
  if (t.resume) saveResume(t.resume);
  store.put('single', ENGINE_FACTS, t.facts);
  for (const a of t.answers) remember(a.question, a.answer);
  // A real person's data replaces the demo person; the mode follows the engine again.
  store.del('single', 'mode');
  return {
    details: Object.entries(t.details).filter(([k, v]) => k !== 'updatedAt' && v).map(([k]) => k),
    skills: t.profile.skills.length, roles: t.profile.experience.length, answers: t.answers.length, leftOut: data.unchecked,
    facts: Object.keys(t.facts), resume: t.resume?.filename ?? null, warnings: t.warnings,
  };
}
