/**
 * What Fanfold itself knows about working a site well, shown to any agent the
 * first time it lands there. Written here rather than learned from pages, so
 * it is guidance, not page data.
 */
import { hostOf, matchesHost } from './site-policies.ts';

export interface SearchFilters {
  keywords: string;
  location?: string;
  /** LinkedIn's id for a place; signed-in search ignores a location given only as text. */
  geoId?: string;
  easyApply?: boolean;
  postedWithin?: 'day' | 'week' | 'month';
  workplace?: Array<'onsite' | 'remote' | 'hybrid'>;
  experience?: Array<'internship' | 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive'>;
  newest?: boolean;
  page?: number;
}

const POSTED = { day: 'r86400', week: 'r604800', month: 'r2592000' } as const;
const WORKPLACE = { onsite: '1', remote: '2', hybrid: '3' } as const;
const EXPERIENCE = { internship: '1', entry: '2', associate: '3', 'mid-senior': '4', director: '5', executive: '6' } as const;

/**
 * LinkedIn's ids for places people search most. Signed in, LinkedIn drops a
 * location given only as text and shows its own default region instead.
 */
const GEO_IDS: Readonly<Record<string, string>> = {
  bengaluru: '105214831', bangalore: '105214831', india: '102713980',
  'united kingdom': '101165590', uk: '101165590', 'united states': '103644278', usa: '103644278', us: '103644278',
  worldwide: '92000000',
};

function geoIdFor(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const first = location.toLowerCase().split(',')[0].trim();
  return GEO_IDS[first] ?? GEO_IDS[location.toLowerCase().trim()];
}

/** A LinkedIn jobs search address: its own filters, paged 25 at a time. */
export function linkedinSearchUrl(f: SearchFilters): string {
  if (!f.keywords.trim()) throw new Error('give some keywords to search for');
  const q = new URLSearchParams({ keywords: f.keywords.trim() });
  if (f.location?.trim()) q.set('location', f.location.trim());
  const geo = f.geoId && /^\d+$/.test(f.geoId) ? f.geoId : geoIdFor(f.location);
  if (geo) q.set('geoId', geo);
  if (f.easyApply) q.set('f_AL', 'true');
  if (f.postedWithin) q.set('f_TPR', POSTED[f.postedWithin]);
  if (f.workplace?.length) q.set('f_WT', f.workplace.map((w) => WORKPLACE[w]).join(','));
  if (f.experience?.length) q.set('f_E', f.experience.map((e) => EXPERIENCE[e]).join(','));
  if (f.newest) q.set('sortBy', 'DD');
  if (f.page && f.page > 1) q.set('start', String((f.page - 1) * 25));
  return `https://www.linkedin.com/jobs/search/?${q.toString()}`;
}

const FILTER_NAMES: Record<string, string> = {
  geoId: 'the location', f_AL: 'Easy Apply only', f_TPR: 'how recently posted', f_WT: 'workplace',
  f_E: 'experience', sortBy: 'newest first', start: 'the page',
};
const ADDED_NAMES: Record<string, string> = {
  f_SAL: 'a salary filter', f_C: 'a company filter', f_JT: 'a job type filter', f_I: 'an industry filter',
  f_F: 'a job function filter', f_PP: 'a city filter', f_CR: 'a country filter',
};

/**
 * What LinkedIn did with the filters asked for. Its newer search drops some of
 * them without a word, and adds ones of its own from the account (a salary
 * floor, say), so the results are not always the search that was asked for.
 */
export function searchFiltersReport(asked: string, landed: string): string {
  let want: URLSearchParams;
  let at: URL;
  try {
    want = new URL(asked).searchParams;
    at = new URL(landed);
  } catch {
    return '';
  }
  if (!/linkedin\.com$/.test(at.hostname) || !/\/jobs\//.test(at.pathname)) return '';
  const got = at.searchParams;
  const dropped = Object.keys(FILTER_NAMES).filter((k) => want.has(k) && got.get(k) !== want.get(k)).map((k) => FILTER_NAMES[k]);
  const added = [...new Set([...got.keys()].filter((k) => !want.has(k) && ADDED_NAMES[k]).map((k) => ADDED_NAMES[k]))];
  const lines: string[] = [];
  if (dropped.length) {
    lines.push(`LinkedIn did not keep ${dropped.join(', ')}: these results are not filtered by ${dropped.length > 1 ? 'them' : 'it'}. Check each job against it before applying.`);
  }
  if (added.length) {
    lines.push(`LinkedIn added ${added.join(', ')} of its own, probably from the user's account: some jobs may be left out.`);
  }
  return lines.join('\n');
}

const LINKEDIN = [
  'Search by address rather than by typing into the page: job_search builds one with LinkedIn\'s own filters (Easy Apply only, posted within, on-site/remote/hybrid, experience, newest first), 25 jobs a page.',
  'job_search returns every job on its page as a row with the posting\'s address, scrolling the list itself; on a results page opened another way, the list scrolls inside its own pane: scroll with the ref of a job card in it to load the rest of the cards.',
  '"Easy Apply to …" opens the application in a dialog; nothing is sent until "Submit application". Move through it with "Continue to next step" and "Review your application".',
  'Fill each step from the user\'s profile, saved answers and files. A typeahead such as "Location (city)" needs one of its suggestions clicked; a number question wants a whole number.',
  'On the résumé step choose the card whose file is the résumé the user meant, or upload that file. Never keep a preselected card you have not checked.',
  'On the review step untick "Follow <company>" unless the user wants to follow it, and read every answer back before going on.',
  'A question with no answer in the profile, saved answers or résumé (salary, years with a skill, anything about the user) goes to job_ask, with every other unknown question on the step in the same call; a sub-agent calls it itself. Never guess; when job_ask says an answer is waiting, follow its guidance.',
  'A video, an assessment, or a document other than the CV is the user\'s: ask them, and do not guess.',
  '"Apply … on company website" opens the employer\'s own site in a new tab: switch to it and apply there. Back on LinkedIn, answer "Did you apply?" with Yes only if that site confirmed the application.',
  'If LinkedIn shows a security check, asks you to sign in, or says its daily limit is reached, stop and tell the user. Never look for a way around these.',
  'Saving a job, dismissing one from the list, following or unfollowing a company all change the user\'s own LinkedIn: do them only when the user asked.',
];

/** Guidance for the site at this address, if Fanfold has any. */
export function siteGuide(url: string): string[] {
  const host = hostOf(url);
  if (matchesHost(host, '.linkedin.com') || host === 'linkedin.com') return LINKEDIN;
  return [];
}
