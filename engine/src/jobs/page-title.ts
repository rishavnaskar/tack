const GENERIC = /^(jobs?|careers?|apply|openings?|linkedin|indeed|greenhouse|lever|ashby|workable|home)$/i;

/** A posting page's own data, as BrowserRuntime.jobPosting reads it. */
interface PageJobFacts { ld: string[]; heading: string | null; siteName: string | null; title: string }

/**
 * The company and title a posting page gives itself: its JobPosting data
 * (JSON-LD) first, then its main heading with the site's name. Null when
 * the page names neither, so a stand-in name is never swapped for another.
 */
export function jobFromPageData(data: PageJobFacts | null, url: string): { company: string; title: string } | null {
  if (!data) return null;
  const tidy = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const items: unknown[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, depth + 1); return; }
    items.push(v);
    walk((v as Record<string, unknown>)['@graph'], depth + 1);
  };
  for (const block of data.ld) {
    try { walk(JSON.parse(block), 0); } catch { /* a block that is not JSON says nothing */ }
  }
  const isPosting = (t: unknown): boolean => (Array.isArray(t) ? t : [t]).some((x) => typeof x === 'string' && /^(?:https?:\/\/schema\.org\/)?JobPosting$/i.test(x));
  const posting = items.find((i) => isPosting((i as Record<string, unknown>)['@type'])) as Record<string, unknown> | undefined;
  const org = posting?.hiringOrganization;
  const hiring = posting ? tidy(typeof org === 'string' ? org : (org as Record<string, unknown> | undefined)?.name, 160) : '';
  const named = posting ? tidy(posting.title ?? posting.name, 200) : '';
  if (named && hiring) return { company: hiring, title: named };
  const heading = tidy(data.heading, 200) || named;
  if (!heading) return null;
  if (hiring) return { company: hiring, title: heading };
  const site = tidy(data.siteName, 160);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const fromAddress = companyFromUrl(url);
  // The page's own words first, spelled as it spells them; a name made from the address only when the page names nobody.
  const company = site && !GENERIC.test(site) && site.toLowerCase() !== host ? site
    : companyInTitle(tidy(data.title, 300), heading, host)
      ?? (fromAddress !== UNNAMED_COMPANY ? fromAddress : jobFromPageTitle(data.title, host).company);
  return company && company !== host ? { company, title: heading } : null;
}

/** The employer a page title names: "Job Application for Data Engineer at Quill Books", "Data Engineer | Quill Books | Careers". */
function companyInTitle(title: string, heading: string, host: string): string | null {
  if (!title) return null;
  const at = /\bat\s+([^|–—]+?)\s*(?:[|–—]|$)/i.exec(title)?.[1]?.trim();
  if (at && !GENERIC.test(at) && at.toLowerCase() !== heading.toLowerCase()) return at;
  const named = jobFromPageTitle(title, host).company;
  return named && named !== host && named.toLowerCase() !== heading.toLowerCase() && !GENERIC.test(named) ? named : null;
}

/** What a job's company is called when nothing on its page or in its address names it. */
export const UNNAMED_COMPANY = 'Company not named';

/** The job and company a posting's page title names, e.g. "Engineer | Initech | Jobs". */
export function jobFromPageTitle(raw: string, host: string): { title: string; company: string } {
  const parts = raw.split(/\s+[|–—-]\s+/).map((p) => p.trim()).filter(Boolean);
  const title = parts[0] ?? '';
  const company = parts.slice(1).find((p) => !GENERIC.test(p)) ?? host;
  return { title, company };
}

/** Countries, regions and ways of working: a part of a page title that names one is where the job is, not who offers it. */
const PLACE = /^(?:remote|hybrid|on-?site|in[- ]office|anywhere|worldwide|global|emea|apac|latam|europe|asia|americas|india|united states(?: of america)?|usa|us|uk|united kingdom|england|scotland|canada|germany|france|spain|portugal|netherlands|ireland|italy|poland|sweden|denmark|norway|finland|switzerland|austria|belgium|czechia|romania|greece|israel|uae|united arab emirates|saudi arabia|qatar|singapore|australia|new zealand|japan|china|south korea|taiwan|hong kong|brazil|mexico|argentina|colombia|chile|south africa|nigeria|kenya|egypt|philippines|indonesia|vietnam|malaysia|thailand|pakistan|bangladesh|sri lanka|nepal)$/i;

/** "India", "Bengaluru, Karnataka, India", "Austin, TX", "(Remote)". */
export function looksLikePlace(part: string): boolean {
  const p = part.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (PLACE.test(p)) return true;
  const pieces = p.split(/\s*,\s*/);
  return pieces.length >= 2 && (PLACE.test(pieces[pieces.length - 1]) || /^[A-Z]{2}$/.test(pieces[pieces.length - 1]));
}

/** An address standing where a name would: "ats.rippling.com". */
export const looksLikeHost = (part: string): boolean => /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/?$/i.test(part.trim());

/** Words a job title has and a company name seldom does. */
const ROLE = /\b(?:engineer\w*|developer|programmer|architect|manager|lead|director|analyst|scientist|designer|consultant|intern|head|officer|specialist|administrator|sre|devops|principal|associate|vp|coordinator|researcher|technician|fde|swe|recruiter|writer|editor|accountant|executive)\b/i;
/** A requisition number: "[T500-30699]", "R-104233". What carries one is part of the title. */
const REQUISITION = /\[[^\]]*\d[^\]]*\]|\b[A-Z]{0,3}-?\d{4,}\b/;

/**
 * Company and title from the page an application was sent from, when its
 * title names them. A part that names a place or a host is neither; a
 * company the title does not name comes from the address, never as a bare
 * host name.
 */
export function jobFromTitle(pageTitle: string | null, url: string): { company: string; title: string } {
  const named = (title: string, company: string) => ({ title: title.trim().slice(0, 200), company: company.trim().slice(0, 160) });
  const fromUrl = (title: string) => named(title || 'Application', companyFromUrl(url));
  const t = (pageTitle ?? '').replace(/^\(\d+\)\s*/, '')
    .replace(/^\s*(job application for|application for|apply( now)?( for| to)?)\s*[:\-–—]?\s*/i, '').trim();
  // "Title | Company | LinkedIn": a job title may itself hold a dash, so bars come first.
  const bars = t.split(/\s+\|\s+/).filter((p) => p.trim() && !looksLikePlace(p) && !looksLikeHost(p));
  const at = /^(.+)\s+at\s+(.+)$/i.exec(bars[0] ?? '');
  if (bars.length >= 3 || (bars.length === 2 && !at)) return named(bars[0], bars[1]);
  if (at) return looksLikePlace(at[2]) || looksLikeHost(at[2]) ? fromUrl(at[1]) : named(at[1], at[2]);
  const parts = (bars[0] ?? '').split(/\s+[–—-]\s+|\s+[·•]\s+/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => !looksLikePlace(p) && !looksLikeHost(p));
  if (kept.length < 2) return fromUrl(kept[0] ?? '');
  // "Title – Company" as written; once a place or a host is dropped, the part that reads as a role is the title.
  const title = kept.length === parts.length ? kept[0] : kept.find((p) => ROLE.test(p)) ?? kept[0];
  const company = kept.find((p) => p !== title)!;
  // "AI Engineer - Full Stack Development [T500-30699]": the second half is more of the title.
  if (REQUISITION.test(company)) return fromUrl(kept.join(' - '));
  // "Globex – Platform Engineer": written the other way round.
  return ROLE.test(company) && !ROLE.test(title) ? named(company, title) : named(title, company);
}

/** True for the stand-in names a job gets before its page has been read. */
export function isPlaceholderJob(job: { company: string; title: string }, host: string, url?: string): boolean {
  return job.title === 'Posting' || job.title === 'Application' || job.company === host || job.company === UNNAMED_COMPANY
    || (!!url && job.company === companyFromUrl(url));
}

/** Applicant-tracking hosts whose first path segment is the company's board, and those that give each company a host of its own. */
const BOARD_IN_PATH = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|rippling\.com|smartrecruiters\.com|jobvite\.com)$/;
const BOARD_IN_HOST = /^([\w-]+)\.(?:[\w-]+\.)?(?:myworkdayjobs\.com|myworkdaysite\.com|keka\.com|teamtailor\.com|breezy\.hr|recruitee\.com|bamboohr\.com|darwinbox\.in|zohorecruit\.com|freshteam\.com)$/;
/** Job boards and aggregators: their name is never the employer's. */
const BOARDS = /(?:^|\.)(?:linkedin|indeed|naukri|glassdoor|wellfound|angel|instahyre|monster|foundit|iimjobs|hirist|cutshort|ziprecruiter|dice|seek|stepstone|xing|google|bing)\.\w+$/;
const NOT_A_NAME = /^(?:www\d?|careers?|jobs?|apply|boards?|job-boards|talent|hire|hiring|work|join|recruiting|ats|app|localhost|example|test)$/i;

const titled = (slug: string): string => slug.replace(/[-_]+/g, ' ').trim().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * The company an address names: the board in an applicant-tracking system's
 * address ("ats.rippling.com/aerospike/..." is Aerospike), or the name of
 * the company's own domain ("careers.globex.example" is Globex). Never a
 * host name, and never a job board's own name.
 */
export function companyFromUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return UNNAMED_COMPANY; }
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':') || BOARDS.test(host)) return UNNAMED_COMPANY;
  const inHost = BOARD_IN_HOST.exec(host)?.[1];
  if (inHost) return titled(inHost);
  if (BOARD_IN_PATH.test(host)) {
    const slug = u.pathname.split('/').filter(Boolean)[0];
    return slug && /^[a-z0-9][\w-]{0,63}$/i.test(slug) && !NOT_A_NAME.test(slug) ? titled(slug) : UNNAMED_COMPANY;
  }
  const labels = host.split('.');
  // "acme.co.uk": the name sits before a two-part ending.
  const ending = labels.length >= 3 && /^(?:co|com|org|net|ac|gov|edu)$/.test(labels[labels.length - 2]) ? 2 : 1;
  const name = labels[labels.length - ending - 1];
  return name && !NOT_A_NAME.test(name) ? titled(name) : UNNAMED_COMPANY;
}
