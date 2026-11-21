import { inflateSync } from 'node:zlib';
import type { Profile, ProfileSkill, Role } from './types.ts';
import { configured, json, LlmError } from './llm.ts';
import { canonical, catalogNames, findQuote } from './skills.ts';
import { run } from './trace.ts';
import * as engine from './engine.ts';

const MAX_TEXT = 30_000;

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    headline: { type: 'string' },
    currentRole: { type: 'string' },
    yearsExperience: { type: 'number' },
    summary: { type: 'string' },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          level: { type: 'integer' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'level', 'evidence'],
      },
    },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          company: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'company', 'start', 'end', 'bullets'],
      },
    },
    education: { type: 'array', items: { type: 'string' } },
    projects: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'headline', 'currentRole', 'yearsExperience', 'summary', 'skills', 'experience', 'education', 'projects'],
};

const PROFILE_SYSTEM = `You turn a résumé into a structured profile for a career coach.
Rules:
- Use only what the résumé says. Do not infer skills it does not show.
- Each skill needs 1 to 3 evidence strings copied word for word from the résumé (a phrase or clause, 4 to 25 words). A skill without such a quote must be left out.
- level is 1 to 5: 1 mentioned or brief exposure, 2 used occasionally, 3 used regularly in a job, 4 owned or led significant work with it, 5 deep expertise over several years.
- Prefer these skill names when they fit: ${catalogNames().join(', ')}. Otherwise use a short common name.
- List 8 to 20 skills. Include transferable ones (stakeholder work, experimentation, writing) when the résumé shows them.
- headline: one line in the person's own voice, e.g. "Backend engineer, payments, 5 years".
- summary: two sentences, plain and factual. If the résumé says what kind of role they want next, keep that in the summary.
- yearsExperience: total professional years as a number.
- Dates as written in the résumé, "Present" for current roles.`;

export interface ResumeInput { text?: string; pdfBase64?: string; filename?: string }
type RawProfile = Omit<Profile, 'skills' | 'source'> & { skills: { name: string; level: number; evidence: string[] }[] };

export async function parseResume(input: ResumeInput): Promise<Profile> {
  const t = run('intake');
  try {
    let text = (input.text ?? '').trim();
    let raw: RawProfile;
    let source: Profile['source'] = 'text';
    if (!text && input.pdfBase64) {
      source = 'pdf';
      const pdf = Buffer.from(input.pdfBase64, 'base64');
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new InputError('that file is not a PDF');
      // The engine's reader handles embedded fonts and non-Latin glyphs; the stream scan is the fallback.
      const read = await engine.resumeText(pdf, 'application/pdf');
      const local = pdfText(pdf);
      text = read.ok && read.text.length >= Math.min(200, local.length) ? read.text : local;
      t.step('pdf', `${input.filename ?? 'resume.pdf'}, ${Math.round(pdf.length / 1024)} KB, ${text.length} characters of text found locally`);
      try {
        t.step('read', 'sending the PDF to the model');
        raw = await json<RawProfile>({ task: 'intake.resume', system: PROFILE_SYSTEM, prompt: 'Build the profile from the attached résumé PDF.', schema: PROFILE_SCHEMA, pdfBase64: input.pdfBase64, filename: input.filename });
      } catch (err) {
        if (!(err instanceof LlmError) || err.status !== 400) throw err;
        if (text.length < 200) throw new InputError('the model endpoint would not take the PDF and no text could be extracted from it; paste the résumé text instead');
        t.step('read', 'model endpoint rejected the PDF; using text extracted from the PDF streams instead');
        raw = await fromText(text);
      }
    } else {
      if (text.length < 200) throw new InputError('résumé text is too short; paste the whole résumé');
      t.step('read', `${text.length} characters of résumé text`);
      raw = await fromText(text);
    }
    const profile = finishProfile(raw, text, source);
    t.ok(`${profile.skills.length} skills with evidence, ${profile.experience.length} roles`);
    return profile;
  } catch (err) {
    t.fail((err as Error).message);
    throw err;
  }
}

export class InputError extends Error {}

// PDF text often breaks lines inside words ("integ\nrations"); match with all whitespace and
// soft hyphens ignored and keep the model's spacing. Returns undefined when the words are not there.
export function wrappedQuote(text: string, quote: string | undefined): string | undefined {
  const q = quote?.trim().replace(/^["'“‘\s-]+|["'”’\s.,;:]+$/g, '');
  if (!q || q.length < 12) return undefined;
  const squash = (t: string) => t.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/-\s*\n/g, '').replace(/\s+/g, '');
  return squash(text).includes(squash(q)) ? q.replace(/\s+/g, ' ') : undefined;
}

function fromText(text: string): Promise<RawProfile> {
  return json<RawProfile>({ task: 'intake.resume', system: PROFILE_SYSTEM, prompt: `Résumé:\n\n${text.slice(0, MAX_TEXT)}`, schema: PROFILE_SCHEMA });
}

// Canonical skill ids, quotes checked against the source text, duplicates merged.
// When there is no text to check against (image-only PDF) quotes are kept as given.
export function finishProfile(raw: RawProfile, sourceText: string, source: Profile['source']): Profile {
  const check = sourceText.trim().length >= 200;
  const skills = new Map<string, ProfileSkill>();
  for (const s of raw.skills ?? []) {
    if (!s?.name) continue;
    // PDF line breaks are layout, not content.
    const tidy = (q: string | undefined) => (source === 'pdf' ? q?.replace(/\s+/g, ' ') : q);
    const evidence = (s.evidence ?? [])
      .map((q) => tidy(check ? findQuote(sourceText, q) ?? (source === 'pdf' ? wrappedQuote(sourceText, q) : undefined) : q?.trim()))
      .filter((q): q is string => Boolean(q && q.length >= 3));
    if (!evidence.length) continue;
    const c = canonical(s.name);
    const level = Math.max(1, Math.min(5, Math.round(Number(s.level) || 1)));
    const had = skills.get(c.id);
    if (had) {
      had.level = Math.max(had.level, level);
      for (const e of evidence) if (!had.evidence.includes(e) && had.evidence.length < 3) had.evidence.push(e);
    } else {
      skills.set(c.id, { id: c.id, name: c.name, level, evidence: [...new Set(evidence)].slice(0, 3) });
    }
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const experience: Role[] = (raw.experience ?? []).map((r) => ({
    title: str(r.title), company: str(r.company), start: str(r.start), end: str(r.end), bullets: list(r.bullets),
  })).filter((r) => r.title || r.company);
  return {
    name: str(raw.name) || 'You',
    headline: str(raw.headline),
    currentRole: str(raw.currentRole) || experience[0]?.title || '',
    yearsExperience: Math.max(0, Math.round((Number(raw.yearsExperience) || 0) * 10) / 10),
    summary: str(raw.summary),
    skills: [...skills.values()].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)),
    experience,
    education: list(raw.education),
    projects: list(raw.projects),
    source,
  };
}

// Best-effort text from a PDF: inflate content streams and read the strings in Tj/TJ operators.
// Works for most PDFs exported from editors with standard fonts; not for scans or CID-only fonts.
export function pdfText(pdf: Buffer): string {
  const src = pdf.toString('latin1');
  const out: string[] = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    let data = pdf.subarray(start, end);
    if (/\/FlateDecode/.test(m[1])) {
      try { data = inflateSync(data); } catch {
        try { data = inflateSync(data.subarray(0, data.length - 2)); } catch { continue; }
      }
    } else if (/\/Filter/.test(m[1])) continue;
    const chunk = contentText(data.toString('latin1'));
    if (chunk.trim()) out.push(chunk);
    re.lastIndex = end;
  }
  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[e] ?? '';
  });
}

function contentText(cs: string): string {
  if (!/\bBT\b/.test(cs)) return '';
  let text = '';
  // Tokens: literal strings, TJ arrays, and the operators that move to a new line.
  const tok = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|\b(?:T\*|Td|TD|Tm|ET)\b/g;
  let m: RegExpExecArray | null;
  while ((m = tok.exec(cs))) {
    const t = m[0];
    if (t.startsWith('(')) {
      const close = t.lastIndexOf(')');
      if (t.slice(close + 1).trim() !== 'Tj' && !text.endsWith('\n')) text += '\n';
      text += unescapePdf(t.slice(1, close));
    } else if (t.startsWith('[')) {
      const inner = m[1] ?? '';
      const parts = inner.match(/\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?/g) ?? [];
      for (const p of parts) {
        if (p.startsWith('(')) text += unescapePdf(p.slice(1, -1));
        else if (Number(p) < -200) text += ' ';
      }
    } else if (!text.endsWith('\n')) {
      text += '\n';
    }
  }
  return text;
}

// Adjacent roles. Overlap is the share of a role's core skills the profile already shows.
const ADJACENT: { role: string; core: string[] }[] = [
  { role: 'AI Product Manager', core: ['product-discovery', 'prd-writing', 'llm-evaluation', 'stakeholder-management', 'experimentation', 'sql', 'apis', 'llm-fundamentals'] },
  { role: 'Technical Product Manager', core: ['apis', 'system-design', 'stakeholder-management', 'prd-writing', 'roadmapping', 'agile-delivery'] },
  { role: 'Platform Product Manager', core: ['apis', 'system-design', 'technical-writing', 'stakeholder-management', 'roadmapping', 'metrics-definition'] },
  { role: 'Solutions Architect', core: ['system-design', 'apis', 'cloud-infrastructure', 'communication', 'stakeholder-management'] },
  { role: 'Developer Advocate', core: ['apis', 'communication', 'technical-writing', 'python', 'go-to-market'] },
  { role: 'Engineering Manager', core: ['mentoring', 'agile-delivery', 'system-design', 'stakeholder-management', 'cross-functional-leadership'] },
  { role: 'Data Product Manager', core: ['sql', 'data-pipelines', 'product-analytics', 'metrics-definition', 'prd-writing'] },
  { role: 'Applied AI Engineer', core: ['python', 'llm-fundamentals', 'rag', 'prompt-engineering', 'llm-evaluation', 'apis'] },
  { role: 'Product Analyst', core: ['sql', 'product-analytics', 'experimentation', 'metrics-definition', 'communication'] },
];

export type RoleSuggestion = { role: string; overlap: number; why: string };

export function adjacentRoles(profile: Profile, limit = 5): RoleSuggestion[] {
  const level = new Map(profile.skills.map((s) => [s.id, s.level]));
  return ADJACENT.map(({ role, core }) => {
    const score = core.reduce((t, id) => t + Math.min(level.get(id) ?? 0, 3) / 3, 0) / core.length;
    const have = core.filter((id) => (level.get(id) ?? 0) >= 2).map((id) => canonical(id).name);
    const miss = core.filter((id) => !level.has(id)).map((id) => canonical(id).name);
    const why = [
      have.length ? `You bring ${have.slice(0, 3).join(', ')}.` : 'Little direct overlap yet.',
      miss.length ? `To close: ${miss.slice(0, 3).join(', ')}.` : 'Most core skills are already on your résumé.',
    ].join(' ');
    return { role, overlap: Math.round(score * 100), why };
  }).sort((a, b) => b.overlap - a.overlap).slice(0, limit);
}

const ROLES_SCHEMA = {
  type: 'object',
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: { role: { type: 'string' }, overlap: { type: 'integer' }, why: { type: 'string' } },
        required: ['role', 'overlap', 'why'],
      },
    },
  },
  required: ['roles'],
};

export async function suggestRoles(profile: Profile, interest = ''): Promise<{ roles: RoleSuggestion[] }> {
  if (!configured()) return { roles: adjacentRoles(profile) };
  const t = run('roles');
  try {
    const skills = profile.skills.map((s) => `${s.name} (${s.level}/5)`).join(', ');
    const recent = profile.experience.slice(0, 3).map((r) => `${r.title} at ${r.company}`).join('; ');
    const res = await json<{ roles: RoleSuggestion[] }>({
      task: 'intake.roles',
      system: 'You are a career coach. Suggest realistic adjacent roles a person could pivot into within 3 to 6 months, given their current skills. overlap is 0-100: the share of the target role\'s core skills they already have. why is one or two plain sentences naming the overlapping skills and the main gap. No hype.',
      prompt: `Current role: ${profile.currentRole}, ${profile.yearsExperience} years.\nSummary: ${profile.summary}\nRecent roles: ${recent}\nSkills: ${skills}${interest ? `\nConsidering: ${interest}` : ''}\n\nSuggest 5 roles, best fit first. Respect what the summary says they want to move towards.`,
      schema: ROLES_SCHEMA,
    });
    const roles = res.roles
      .filter((r) => r.role && r.why)
      .map((r) => ({ role: r.role.trim(), overlap: Math.max(0, Math.min(100, Math.round(r.overlap))), why: r.why.trim() }))
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 6);
    t.ok(roles.map((r) => r.role).join(', '));
    return { roles: roles.length ? roles : adjacentRoles(profile) };
  } catch (err) {
    t.fail(`${(err as Error).message.slice(0, 160)}; using the built-in role table`);
    return { roles: adjacentRoles(profile) };
  }
}
