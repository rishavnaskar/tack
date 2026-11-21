/**
 * Public job-board APIs: discovery without a browser.
 *
 * Greenhouse, Lever, Ashby and Workable publish every company's open roles
 * as keyless JSON. Reading them is faster than driving the careers page and
 * is the legitimate route the boards themselves offer. Submission is still
 * browser-only; this is for finding, not applying.
 */

type Ats = 'greenhouse' | 'lever' | 'ashby' | 'workable';

interface AtsPosting {
  title: string;
  location: string;
  /** Team or department, where the board says. */
  department: string;
  url: string;
  postedAt: string | null;
  ats: Ats;
  board: string;
}

const BOARD = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_POSTINGS = 40;

export async function fetchPostings(
  ats: string, board: string, query = '',
  fetchImpl: typeof fetch = fetch,
  offset = 0,
): Promise<{ ok: true; postings: AtsPosting[]; total: number; offset: number } | { ok: false; error: string }> {
  const slug = board.trim();
  if (!BOARD.test(slug)) return { ok: false, error: `"${board}" is not a board slug` };
  const endpoint = endpointFor(ats as Ats, slug);
  if (!endpoint) return { ok: false, error: `${ats} is not one of greenhouse, lever, ashby, workable` };

  let body: unknown;
  try {
    const res = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { ok: false, error: `${ats} has no board called "${slug}"` };
    if (!res.ok) return { ok: false, error: `${ats} answered HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { ok: false, error: `could not reach ${ats}: ${(err as Error).message}` };
  }

  // Newest first: a board of 800 roles listed alphabetically shows forty of
  // the same title and nothing posted this week.
  const all = parse(ats as Ats, slug, body)
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
  // Every word of the query, wherever it falls: "backend india" finds "Senior Backend Engineer" in "Bengaluru, India".
  const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = needles.length
    ? all.filter((p) => { const hay = `${p.title} ${p.location} ${p.department}`.toLowerCase(); return needles.every((w) => hay.includes(w)); })
    : all;
  const from = Math.max(0, Math.min(offset, matched.length));
  return { ok: true, postings: matched.slice(from, from + MAX_POSTINGS), total: matched.length, offset: from };
}

function endpointFor(ats: Ats, board: string): string | null {
  switch (ats) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=false`;
    case 'lever': return `https://api.lever.co/v0/postings/${board}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${board}`;
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${board}`;
    default: return null;
  }
}

type Rec = Record<string, unknown>;
// Boards publish titles with stray tabs and doubled spaces; a title is compared and shown, so it is tidied once here.
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function parse(ats: Ats, board: string, body: unknown): AtsPosting[] {
  const b = (body ?? {}) as Rec;
  switch (ats) {
    case 'greenhouse':
      return ((b.jobs as Rec[]) ?? []).map((j) => ({
        title: str(j.title), location: str((j.location as Rec)?.name), url: str(j.absolute_url),
        department: ((j.departments as Rec[] | undefined) ?? []).map((d) => str(d.name)).filter(Boolean).join(', '),
        postedAt: str(j.first_published) || str(j.updated_at) || null, ats, board,
      }));
    case 'lever':
      return ((Array.isArray(body) ? body : []) as Rec[]).map((j) => ({
        title: str(j.text), location: str((j.categories as Rec)?.location), url: str(j.hostedUrl),
        department: str((j.categories as Rec)?.team) || str((j.categories as Rec)?.department),
        postedAt: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : null, ats, board,
      }));
    case 'ashby':
      return ((b.jobs as Rec[]) ?? []).map((j) => ({
        title: str(j.title), location: str(j.location), url: str(j.jobUrl) || str(j.applyUrl),
        department: str(j.department) || str(j.team),
        postedAt: str(j.publishedAt) || null, ats, board,
      }));
    case 'workable':
      return ((b.jobs as Rec[]) ?? []).map((j) => ({
        title: str(j.title), location: [str(j.city), str(j.country)].filter(Boolean).join(', '),
        department: str(j.department),
        url: str(j.url) || str(j.shortlink), postedAt: str(j.published_on) || null, ats, board,
      }));
    default:
      return [];
  }
}

/** One line per posting, for the model. Page-authored text, so the caller fences it. */
export function renderPostings(r: { postings: AtsPosting[]; total: number; offset?: number }, ats: string, board: string): string {
  if (!r.postings.length) return `${ats}/${board}: no open roles matched.`;
  const from = r.offset ?? 0;
  const lines = r.postings.map((p, i) => [
    `${from + i + 1}. ${p.title}`, p.location || 'location not given', p.department,
    p.postedAt ? `posted ${p.postedAt.slice(0, 10)}` : '', p.url,
  ].filter(Boolean).join(' — '));
  const after = from + r.postings.length;
  const more = r.total > after ? `\n(${r.total - after} more: call again with offset ${after}, or narrow the query)` : '';
  return `${ats}/${board}: ${r.total} open role(s), newest first${from ? `, from ${from + 1}` : ''}\n${lines.join('\n')}${more}`;
}

// ------------------------------------------------------- one posting

interface PostingText { title: string; company: string; location: string; text: string; url: string; ats: Ats }

/** The board and id a posting's address names on a board with a public API, or null: then it is read in a browser. */
export function atsPostingOf(url: string): { ats: Ats; board: string; id: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const board = seg[0] ?? '';
  if (!BOARD.test(board)) return null;
  if (/(?:^|\.)greenhouse\.io$/.test(host)) {
    const i = seg.indexOf('jobs');
    return i > 0 && /^\d+$/.test(seg[i + 1] ?? '') ? { ats: 'greenhouse', board, id: seg[i + 1] } : null;
  }
  if (/(?:^|\.)lever\.co$/.test(host)) return /^[0-9a-f-]{20,}$/i.test(seg[1] ?? '') ? { ats: 'lever', board, id: seg[1].toLowerCase() } : null;
  if (/(?:^|\.)ashbyhq\.com$/.test(host)) return /^[0-9a-f-]{20,}$/i.test(seg[1] ?? '') ? { ats: 'ashby', board, id: seg[1].toLowerCase() } : null;
  if (/(?:^|\.)workable\.com$/.test(host)) {
    const i = seg.indexOf('j');
    return i > 0 && seg[i + 1] ? { ats: 'workable', board, id: seg[i + 1].toUpperCase() } : null;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e: string) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
  }
  return ENTITIES[e.toLowerCase()] ?? all;
});

/** A board's HTML (Greenhouse sends it escaped) as lines of text. */
export function htmlText(html: string): string {
  return decode(decode(html)
    .replace(/<(?:br|\/p|\/h\d|\/div|\/ul|\/ol|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One posting's text, straight from its board's public API: no browser, no
 * sign-in. The text is the board's, so whoever uses it fences it.
 */
export async function fetchPosting(url: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; posting: PostingText } | { ok: false; error: string }> {
  const at = atsPostingOf(url);
  if (!at) return { ok: false, error: 'not a posting on a board with a public API' };
  const endpoint = at.ats === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${at.board}/jobs/${at.id}`
    : at.ats === 'lever' ? `https://api.lever.co/v0/postings/${at.board}/${at.id}`
    : at.ats === 'ashby' ? `https://api.ashbyhq.com/posting-api/job-board/${at.board}?includeCompensation=false`
    : `https://apply.workable.com/api/v1/widget/accounts/${at.board}?details=true`;
  let body: Rec;
  try {
    const res = await fetchImpl(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { ok: false, error: `${at.ats} has no such posting` };
    if (!res.ok) return { ok: false, error: `${at.ats} answered HTTP ${res.status}` };
    body = (await res.json()) as Rec;
  } catch (err) {
    return { ok: false, error: `could not reach ${at.ats}: ${(err as Error).message}` };
  }
  const company = at.board.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const done = (title: string, location: string, text: string): { ok: true; posting: PostingText } | { ok: false; error: string } =>
    (title ? { ok: true, posting: { title, company, location, text: text.slice(0, 40_000), url, ats: at.ats } } : { ok: false, error: `${at.ats} gave no posting at that address` });
  switch (at.ats) {
    case 'greenhouse':
      return done(str(body.title), str((body.location as Rec)?.name), htmlText(String(body.content ?? '')));
    case 'lever': {
      const lists = ((body.lists as Rec[] | undefined) ?? []).map((l) => `${str(l.text)}\n${htmlText(String(l.content ?? ''))}`).join('\n\n');
      return done(str(body.text), str((body.categories as Rec)?.location), [String(body.descriptionPlain ?? ''), lists, String(body.additionalPlain ?? '')].filter(Boolean).join('\n\n'));
    }
    case 'ashby': {
      const job = ((body.jobs as Rec[] | undefined) ?? []).find((j) => str(j.id).toLowerCase() === at.id || str(j.jobUrl).toLowerCase().includes(at.id));
      return job ? done(str(job.title), str(job.location), String(job.descriptionPlain ?? '') || htmlText(String(job.descriptionHtml ?? ''))) : { ok: false, error: 'ashby lists no open posting with that id' };
    }
    case 'workable': {
      const job = ((body.jobs as Rec[] | undefined) ?? []).find((j) => str(j.shortcode).toUpperCase() === at.id);
      return job ? done(str(job.title), [str(job.city), str(job.country)].filter(Boolean).join(', '), htmlText([job.description, job.requirements].map((x) => String(x ?? '')).join('\n')))
        : { ok: false, error: 'workable lists no open posting with that code' };
    }
  }
}
