import type { GapMap, GapSkill, Goal, Kit, Level, Plan, PortfolioProject, Posting, Profile } from './types.ts';
import * as store from './store.ts';
import * as llm from './llm.ts';
import { run } from './trace.ts';
import { haveLevel, postingFit } from './gap.ts';
import { canonical, findQuote, skillId } from './skills.ts';
import { guardInvented, tokens } from './interview.ts';
import { joinNames, withArticle, type Ask } from './plan.ts';

type Bullet = Kit['bullets'][number];
type PostingSkill = NonNullable<Posting['skills']>[number];

export class KitError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface KitCtx {
  posting: Posting; profile: Profile; gap?: GapMap; goal?: Goal; plan?: Plan; portfolio?: PortfolioProject[]; now?: Date;
}

export interface KitGap {
  id: string; name: string; level: Exclude<Level, 'strong'>; importance: PostingSkill['importance']; quote: string;
  resume: string[]; bridge?: GapSkill['bridge']; priority: number;
}

const MIN_QUOTE_WORDS = 4;
const MAX_BULLETS = 6;
const MAX_GAPS = 4;

// Evidence Tack writes itself as plan and interview progress raise a skill; true, but not a résumé line.
const COACH_NOTE = /\bin the Tack plan\b|\bin a mock interview\b/i;
const resumeEvidence = (evidence: string[] | undefined) => (evidence ?? []).filter((e) => !COACH_NOTE.test(e));

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const str = (x: unknown): string => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

// Every profile line a bullet may stand on: role bullets and skill evidence (quotes intake checked against the résumé).
export function profileLines(profile: Profile): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = str(s);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  };
  for (const r of profile.experience) r.bullets.forEach(add);
  for (const s of profile.skills) resumeEvidence(s.evidence).forEach(add);
  return out;
}

const roleBullets = (profile: Profile) => profile.experience.flatMap((r) => r.bullets).map(str).filter(Boolean);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The exact profile span a quote points at, case and whitespace aside, or nothing when the profile does not say it.
export function sourceOf(basedOn: string, lines: string[]): { quote: string; line: string } | undefined {
  if (!basedOn || /\.\.\.|…/.test(basedOn) || words(basedOn) < MIN_QUOTE_WORDS) return undefined;
  for (const line of lines) {
    const quote = findQuote(line, basedOn);
    if (quote && words(quote) >= MIN_QUOTE_WORDS) return { quote, line };
  }
  return undefined;
}

const flat = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').trim()} `;

// True when the bullet carries five or more words in a row from a different résumé line:
// two facts stitched into one claim.
export function joinsLines(text: string, line: string, lines: string[]): boolean {
  const own = flat(line);
  const others = lines.filter((l) => l !== line && !own.includes(flat(l))).map(flat);
  const t = flat(text).trim().split(' ');
  for (let i = 0; i + 5 <= t.length; i++) {
    const run = ` ${t.slice(i, i + 5).join(' ')} `;
    if (!own.includes(run) && others.some((o) => o.includes(run))) return true;
  }
  return false;
}

export function guardBullets(raw: unknown[], profile: Profile): { kept: Bullet[]; lines: string[]; dropped: { text: string; basedOn: string; why: string }[] } {
  const all = profileLines(profile);
  const kept: Bullet[] = [];
  const lines: string[] = [];
  const dropped: { text: string; basedOn: string; why: string }[] = [];
  for (const b of raw) {
    const text = str((b as Bullet | undefined)?.text);
    const basedOn = str((b as Bullet | undefined)?.basedOn);
    if (!text) continue;
    const src = sourceOf(basedOn, all);
    if (!src) { dropped.push({ text, basedOn, why: 'source is not in the profile' }); continue; }
    // A rewrite may not add figures its source line does not state.
    if (guardInvented(text, src.line, String(profile.yearsExperience)) !== text) { dropped.push({ text, basedOn, why: 'adds a number' }); continue; }
    if (joinsLines(text, src.line, all)) { dropped.push({ text, basedOn, why: 'joins two résumé lines' }); continue; }
    if (lines.includes(src.line)) { dropped.push({ text, basedOn, why: 'repeats a source' }); continue; }
    kept.push({ text, basedOn: src.quote });
    lines.push(src.line);
  }
  return { kept, lines, dropped };
}

function postingSkills(posting: Posting): PostingSkill[] {
  const by = new Map<string, PostingSkill>();
  for (const s of posting.skills ?? []) {
    const id = s.skillId || skillId(s.name);
    const prev = by.get(id);
    if (!prev || (prev.importance === 'nice' && s.importance === 'must')) by.set(id, { ...s, skillId: id });
  }
  return [...by.values()].sort((a, b) => Number(b.importance === 'must') - Number(a.importance === 'must'));
}

function ownSkill(profile: Profile, id: string) {
  return profile.skills.find((s) => (s.id || skillId(s.name)) === id);
}

// How much a résumé line speaks to what the posting asks for: its evidence first, shared words second.
export function relevance(line: string, posting: Posting, profile: Profile): number {
  const lt = new Set(tokens(line));
  let score = 0;
  for (const s of postingSkills(posting)) {
    const w = s.importance === 'must' ? 2 : 1;
    const own = resumeEvidence(ownSkill(profile, s.skillId)?.evidence);
    if (own.length) {
      if (own.some((e) => findQuote(line, e))) score += w;
      continue;
    }
    const hits = new Set(tokens(`${s.name} ${s.quote}`).filter((t) => lt.has(t))).size;
    if (hits >= 2) score += w / 4;
  }
  return score;
}

// The fallback keeps résumé lines word for word and only reorders them by fit to the posting.
// Evidence that sits outside every role bullet (a side project, say) counts as a line of its own.
export function rankedBullets(profile: Profile, posting: Posting, skip: string[] = []): Bullet[] {
  const bullets = roleBullets(profile);
  const loose = profile.skills.flatMap((s) => resumeEvidence(s.evidence)).map(str)
    .filter((e, i, all) => e && all.indexOf(e) === i && !bullets.some((b) => findQuote(b, e)));
  const lines = [...bullets, ...loose].filter((l) => !skip.includes(l));
  const scored = lines.map((line, i) => ({ line, i, score: relevance(line, posting, profile) }));
  const hits = scored.filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score || a.i - b.i);
  const rest = scored.filter((x) => x.score < 0.5);
  const pick = hits.slice(0, 5);
  for (const x of rest) if (pick.length < 3) pick.push(x);
  return pick.map((x) => ({ text: capital(x.line), basedOn: x.line }));
}

function strengths(ctx: KitCtx) {
  return postingSkills(ctx.posting)
    .map((s) => ({ s, have: haveLevel(ctx.profile, s.skillId), evidence: resumeEvidence(ownSkill(ctx.profile, s.skillId)?.evidence) }))
    .filter((x) => x.have > 0 && x.evidence.length)
    .sort((a, b) => Number(b.s.importance === 'must') - Number(a.s.importance === 'must') || b.have - a.have);
}

// The longest evidence, or the whole résumé line around a short one so it reads on its own.
function fullLine(profile: Profile, evidence: string[]): string {
  const e = [...evidence].sort((a, b) => words(b) - words(a))[0] ?? '';
  if (words(e) >= 8 && !/^[a-z]/.test(e)) return e;
  return roleBullets(profile).find((l) => findQuote(l, e)) ?? capital(e);
}

const nameOf = (ctx: KitCtx, id: string, fallback: string) => ctx.gap?.skills.find((g) => g.id === id)?.name ?? (canonical(id).name || fallback);

// Skills this posting asks for that the gap map has as missing or partial.
export function gapsFor(ctx: KitCtx): KitGap[] {
  const out: KitGap[] = [];
  for (const s of postingSkills(ctx.posting)) {
    const g = ctx.gap?.skills.find((x) => x.id === s.skillId);
    const have = haveLevel(ctx.profile, s.skillId);
    const level: Level = g ? g.level : have === 0 ? 'missing' : have < (s.importance === 'must' ? 4 : 3) ? 'partial' : 'strong';
    if (level === 'strong') continue;
    out.push({
      id: s.skillId, name: g?.name ?? s.name, level, importance: s.importance, quote: s.quote,
      resume: resumeEvidence(g?.evidence.resume ?? ownSkill(ctx.profile, s.skillId)?.evidence), bridge: g?.bridge, priority: g?.priority ?? 0,
    });
  }
  return out
    .sort((a, b) => Number(b.importance === 'must') - Number(a.importance === 'must') || b.priority - a.priority)
    .slice(0, MAX_GAPS);
}

// Where the person is already working on a skill: the plan week and the portfolio project.
function underway(ctx: KitCtx, id: string): string[] {
  const out: string[] = [];
  const week = ctx.plan?.weeks.find((w) => w.tasks.some((t) => t.skillIds.includes(id) && t.status !== 'skipped'));
  if (week) out.push(`week ${week.index} of your plan`);
  const project = ctx.portfolio?.find((p) => p.skillIds.includes(id));
  if (project) out.push(`the "${project.title}" portfolio project`);
  return out;
}

export function frameGap(g: KitGap, ctx: KitCtx): string {
  const doing = underway(ctx, g.id);
  const tail = doing.length ? ` Then point to ${joinNames(doing)}.` : '';
  const start = g.level === 'partial' && g.resume[0] ? `You have a start ("${g.resume[0]}"). Say where that experience stops` : '';
  if (g.bridge) return `${start || 'Say it is new to you'}, then bridge from ${lower(g.bridge.from)}: ${g.bridge.note}${tail}`;
  if (start) return `${start}.${tail || ' Then say how you would take it further.'}`;
  return `Say plainly that you have not done ${lower(g.name)} in a job yet.${tail || ' Then talk through how you would approach it in the first months.'}`;
}

function fallbackQuestions(ctx: KitCtx, gaps: KitGap[]): string[] {
  const out: string[] = [];
  const top = gaps.find((g) => g.importance === 'must' && g.quote) ?? gaps[0];
  if (top?.quote) out.push(`You mention "${top.quote}". How does the team do that today, and what would you want this hire to change first?`);
  if (postingSkills(ctx.posting).some((s) => /llm-evaluation|ai-agents|rag|responsible-ai/.test(s.skillId))) {
    out.push('How do you decide a model change is good enough to ship, and who makes that call?');
  }
  out.push('What would a strong first 90 days look like in this role?');
  out.push('How do product and engineering split decisions here, and where do they disagree most?');
  return out.slice(0, 4);
}

export function fallbackKit(ctx: KitCtx): Kit {
  const { posting: p, profile } = ctx;
  const bullets = rankedBullets(profile, p);
  const strong = strengths(ctx);
  const gaps = gapsFor(ctx);
  const names = strong.slice(0, 3).map((x) => lower(nameOf(ctx, x.s.skillId, x.s.name)));
  const years = profile.yearsExperience ? `${profile.yearsExperience} years` : '';
  const who = [profile.currentRole || profile.headline, years].filter(Boolean).join(', ');
  const headline = names.length ? `${who} · strongest here: ${joinNames(names)}` : who || profile.headline;

  const missingMust = gaps.filter((g) => g.importance === 'must').map((g) => lower(g.name));
  const doing = gaps.flatMap((g) => underway(ctx, g.id)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 2);
  const coverNote = [
    `Hello ${p.company} team,`,
    `I would like to apply for the ${p.title} role. I am ${withArticle(profile.currentRole || 'professional')}${years ? ` with ${years} of experience` : ''}${names.length ? `, and the ${names.length > 1 ? 'parts of my work closest to what you describe are' : 'part of my work closest to what you describe is'} ${joinNames(names)}` : ''}.`,
    ['Most relevant from my résumé:', ...bullets.slice(0, 2).map((b) => `- ${sentence(b.text)}`)].join('\n'),
    missingMust.length
      ? `Your posting also asks for ${joinNames(missingMust.slice(0, 3))}. I have not done ${missingMust.length > 1 ? 'these' : 'this'} in a job yet${doing.length ? `, and I am working on ${missingMust.length > 1 ? 'them' : 'it'} now through ${joinNames(doing)}` : ''}.`
      : '',
    'I would welcome a conversation about how this background fits the role.',
    profile.name,
  ].filter(Boolean).join('\n\n');

  const talkingPoints = strong.slice(0, 4).map((x) =>
    `They ask for ${lower(nameOf(ctx, x.s.skillId, x.s.name))} ("${x.s.quote}"). Point to: ${sentence(fullLine(profile, x.evidence))}`);
  for (const g of gaps) {
    if (talkingPoints.length >= 4) break;
    if (g.bridge) talkingPoints.push(`For ${lower(g.name)}, bridge from ${lower(g.bridge.from)}: ${g.bridge.note}`);
  }
  if (talkingPoints.length < 2 && profile.summary) talkingPoints.push(`Why this move: ${profile.summary}`);

  return {
    postingId: p.id, generatedAt: (ctx.now ?? new Date()).toISOString(), fit: fitOf(ctx), headline, bullets, coverNote, talkingPoints,
    gapsToAddress: gaps.map((g) => ({ skill: g.name, howToFrame: frameGap(g, ctx) })), questionsToAsk: fallbackQuestions(ctx, gaps),
  };
}

function fitOf(ctx: KitCtx): number {
  if (typeof ctx.posting.fit === 'number') return ctx.posting.fit;
  try { return postingFit(ctx.profile, ctx.posting); } catch { return 0; }
}

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    bullets: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, basedOn: { type: 'string' } }, required: ['text', 'basedOn'] } },
    coverNote: { type: 'string' },
    talkingPoints: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'object', properties: { skill: { type: 'string' }, howToFrame: { type: 'string' } }, required: ['skill', 'howToFrame'] } },
    questionsToAsk: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'bullets', 'coverNote', 'talkingPoints', 'gaps', 'questionsToAsk'],
};

const SYSTEM = `You tailor a résumé to one job posting. Use only facts from the numbered résumé lines.
- bullets: 4 to 6. Each rewrites one résumé line so it speaks to this posting: lead with what they care about, under 30 words.
- basedOn: copy a run of at least six words from that same résumé line, character for character. No ellipses, no joining two lines.
- Never add a number, tool, employer, title or result the line does not state, and never claim more than the line says.
- headline: one line under 14 words for the top of the résumé, without the person's name.
- coverNote: 120 to 180 words in 3 or 4 short paragraphs separated by blank lines, first person, plain and specific, facts only from the résumé lines. Open with "Hello <company> team,". Say honestly which asks are new. End with the person's name on its own line. No hype, no emojis.
- talkingPoints: 3 to 5, each pairs something the posting asks for with a résumé fact.
- gaps: one entry per listed gap with the same skill name; howToFrame is one or two honest sentences: name the gap, then the nearest real experience or the work underway.
- questionsToAsk: 3 or 4 questions about this posting a strong candidate would ask.`;

function prompt(ctx: KitCtx, lines: string[], gaps: KitGap[]): string {
  const { posting: p, profile } = ctx;
  const roleOf = new Map<string, string>();
  for (const r of profile.experience) for (const b of r.bullets) roleOf.set(str(b), `${r.title}, ${r.company}`);
  return [
    ctx.goal?.targetRole ? `Target role: ${ctx.goal.targetRole}.` : '',
    `Posting: ${p.title} at ${p.company} (${p.location}).`,
    'What they ask for:',
    ...postingSkills(p).map((s) => `- [${s.importance}] ${s.name}: "${s.quote}"`),
    `Posting text:\n${p.text.slice(0, 3500)}`,
    '',
    `Person: ${profile.name}, ${profile.currentRole}, ${profile.yearsExperience} years. ${profile.headline}`,
    'Résumé lines:',
    ...lines.map((l, i) => `${i + 1}. ${roleOf.has(l) ? `[${roleOf.get(l)}] ` : ''}${l}`),
    '',
    gaps.length ? 'Gaps to address (asked for here, not yet shown on the résumé):' : 'No gaps to address.',
    ...gaps.map((g) => {
      const doing = underway(ctx, g.id);
      return `- ${g.name} (${g.level}${g.resume[0] ? `; nearest experience: "${g.resume[0]}"` : ''}${g.bridge ? `; bridge from ${g.bridge.from}: ${g.bridge.note}` : ''}${doing.length ? `; underway: ${doing.join(', ')}` : ''})`;
    }),
  ].filter((x) => x !== '').join('\n');
}

interface Drafted { headline: string; bullets: Bullet[]; coverNote: string; talkingPoints: string[]; gaps: { skill: string; howToFrame: string }[]; questionsToAsk: string[] }

export async function draftKit(ctx: KitCtx, ask: Ask | null): Promise<{ kit: Kit; by: 'model' | 'rules'; offered: number; dropped: number; error?: string }> {
  const base = fallbackKit(ctx);
  if (!ask) return { kit: base, by: 'rules', offered: base.bullets.length, dropped: 0 };
  const lines = profileLines(ctx.profile);
  const gaps = gapsFor(ctx);
  let out: Drafted;
  try {
    out = await ask<Drafted>({ task: 'kit.tailor', system: SYSTEM, prompt: prompt(ctx, lines, gaps), schema: SCHEMA, tier: 'smart' });
  } catch (e) {
    return { kit: base, by: 'rules', offered: base.bullets.length, dropped: 0, error: (e as Error).message };
  }
  const raw = Array.isArray(out?.bullets) ? out.bullets : [];
  const guard = guardBullets(raw, ctx.profile);
  const bullets = guard.kept.slice(0, MAX_BULLETS);
  // Too few survived: top up with the résumé's own lines, best fit first.
  if (bullets.length < 3) bullets.push(...rankedBullets(ctx.profile, ctx.posting, guard.lines).slice(0, 3 - bullets.length));

  // Prose may only use figures the résumé or the posting state.
  const facts = [...lines, ctx.profile.summary, ctx.profile.headline, String(ctx.profile.yearsExperience), ctx.posting.text, ctx.posting.salary ?? '',
    ...gaps.flatMap((g) => underway(ctx, g.id))].join('\n');
  const honest = (s: string) => !!s && guardInvented(s, facts) === s;
  const headline = honest(str(out.headline)) ? str(out.headline) : base.headline;
  const note = typeof out.coverNote === 'string' ? out.coverNote.trim() : '';
  const coverNote = honest(note) && words(note) >= 40 ? note : base.coverNote;
  const points = (Array.isArray(out.talkingPoints) ? out.talkingPoints : []).map(str).filter(honest).slice(0, 5);
  const framed = new Map((Array.isArray(out.gaps) ? out.gaps : []).map((g) => [str(g?.skill).toLowerCase(), str(g?.howToFrame)]));
  const questions = (Array.isArray(out.questionsToAsk) ? out.questionsToAsk : []).map(str).filter(Boolean).slice(0, 5);

  const kit: Kit = {
    ...base,
    headline,
    bullets,
    coverNote,
    talkingPoints: points.length >= 2 ? points : base.talkingPoints,
    gapsToAddress: gaps.map((g) => {
      const f = framed.get(g.name.toLowerCase()) ?? framed.get(g.id);
      return { skill: g.name, howToFrame: f && honest(f) ? f : frameGap(g, ctx) };
    }),
    questionsToAsk: questions.length >= 2 ? questions : base.questionsToAsk,
  };
  return { kit, by: 'model', offered: raw.length, dropped: guard.dropped.length };
}

export function cachedKit(postingId: string): Kit | undefined {
  return store.get<Kit>('kit', postingId);
}

export async function buildKit(postingId: string, opts: { fresh?: boolean; ask?: Ask | null } = {}): Promise<Kit> {
  if (!opts.fresh) {
    const cached = cachedKit(postingId);
    if (cached) return cached;
  }
  const posting = store.get<Posting>('posting', postingId);
  if (!posting) throw new KitError(404, `No posting ${postingId}`);
  const profile = store.get<Profile>('single', 'profile');
  if (!profile) throw new KitError(409, 'Add a résumé before preparing an application.');
  const ctx: KitCtx = {
    posting, profile, gap: store.get<GapMap>('single', 'gap'), goal: store.get<Goal>('single', 'goal'),
    plan: store.get<Plan>('single', 'plan'), portfolio: store.list<PortfolioProject>('portfolio'),
  };
  const ask = opts.ask !== undefined ? opts.ask : llm.configured() ? (llm.json as Ask) : null;
  const t = run('kit');
  try {
    t.step('read', `${posting.title} at ${posting.company}: ${postingSkills(posting).length} skills against ${profileLines(profile).length} résumé lines`);
    t.step('draft', ask ? 'tailoring bullets, cover note and talking points' : 'model not configured, reordering your own bullets by fit');
    const out = await draftKit(ctx, ask);
    if (out.error) t.step('draft', `model failed, kept your own bullets: ${out.error.slice(0, 160)}`);
    if (out.by === 'model') {
      t.step('guard', `${out.offered - out.dropped} of ${out.offered} bullets trace to a résumé line${out.dropped ? `; dropped ${out.dropped}` : ''}`);
    }
    store.put('kit', postingId, out.kit);
    t.ok(`${posting.company}: ${out.kit.bullets.length} bullets, ${out.kit.gapsToAddress.length} gaps to address`);
    return out.kit;
  } catch (e) {
    t.fail((e as Error).message);
    throw e;
  }
}

// Plain text of a kit, for copying and for MCP hosts.
export function kitText(kit: Kit, posting?: Pick<Posting, 'title' | 'company' | 'url'>): string {
  const out: string[] = [];
  if (posting) out.push(`Application kit: ${posting.title} at ${posting.company} (fit ${kit.fit})`, posting.url, '');
  out.push('Headline', kit.headline, '', 'Résumé bullets');
  for (const b of kit.bullets) {
    out.push(`- ${b.text}`);
    out.push(b.basedOn === b.text ? '  from your résumé, word for word' : `  from your résumé: "${b.basedOn}"`);
  }
  out.push('', 'Cover note', kit.coverNote, '', 'Talking points', ...kit.talkingPoints.map((x) => `- ${x}`));
  if (kit.gapsToAddress.length) out.push('', 'Gaps to address', ...kit.gapsToAddress.map((g) => `- ${g.skill}: ${g.howToFrame}`));
  out.push('', 'Questions to ask', ...kit.questionsToAsk.map((q) => `- ${q}`));
  return out.join('\n');
}
