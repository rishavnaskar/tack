/**
 * What Fanfold may do on each job site, as data.
 *
 * LinkedIn's and Indeed's terms prohibit third-party software submitting
 * applications, so on those the agent finds, screens and fills and the person
 * presses Submit, unless the person has turned submission on for that site
 * themselves, in Fanfold, knowing the site may restrict their account for it.
 * Company career sites run on an ATS have no such clause, so submission there
 * can be automatic within a worker's caps. The decision lives in a table
 * rather than in code so a site that turns hostile can be flipped to
 * `prepare` without a release.
 */

import type { DatabaseSync } from 'node:sqlite';

type SubmitMode = 'auto' | 'prepare' | 'never';
export type DowngradeReason = 'check' | 'limit' | 'rate';

export interface SitePolicy {
  /** Stable key a worker's site list refers to, e.g. "greenhouse". */
  key: string;
  label: string;
  /** Hostnames, exact or with a leading dot for the domain and its subdomains. */
  hosts: string[];
  submit: SubmitMode;
  /** False where the site's terms name browser plugins: worked in the dedicated window only. */
  extensionAllowed: boolean;
  defaultDailyCap: number;
  /** Hours a challenge (CAPTCHA, DataDome, Cloudflare) downgrades the site to prepare. */
  downgradeOnChallengeHours: number;
  notes: string;
  /** Set while a challenge downgrade is in force. */
  downgradedUntil: string | null;
  /** What the site did to cause it: a bot check, its daily limit, or rate-limiting this browser. Null when not recorded. */
  downgradeReason?: DowngradeReason | null;
  /** When the person accepted the site's terms risk to let Fanfold submit there. */
  termsAcceptedAt: string | null;
  version: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS site_policies (
  key              TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  hosts            TEXT NOT NULL,
  submit           TEXT NOT NULL,
  extension_allowed INTEGER NOT NULL DEFAULT 1,
  default_daily_cap INTEGER NOT NULL DEFAULT 0,
  downgrade_hours  INTEGER NOT NULL DEFAULT 24,
  notes            TEXT NOT NULL DEFAULT '',
  downgraded_until TEXT,
  version          INTEGER NOT NULL DEFAULT 1
);
`;

/** The matrix in product/PRD.md §5. */
export const SEED: Array<Omit<SitePolicy, 'downgradedUntil' | 'termsAcceptedAt' | 'version'>> = [
  {
    key: 'greenhouse', label: 'Greenhouse', hosts: ['.greenhouse.io'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 10, downgradeOnChallengeHours: 24,
    notes: 'Company career pages. No candidate-side automation ban; public posting API.',
  },
  {
    key: 'lever', label: 'Lever', hosts: ['.lever.co'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 10, downgradeOnChallengeHours: 24,
    notes: 'Company career pages. No candidate-side automation ban; public posting API.',
  },
  {
    key: 'ashby', label: 'Ashby', hosts: ['.ashbyhq.com'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 10, downgradeOnChallengeHours: 24,
    notes: 'Company career pages. Multi-step forms; public posting API.',
  },
  {
    key: 'workable', label: 'Workable', hosts: ['.workable.com'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 10, downgradeOnChallengeHours: 24,
    notes: 'Company career pages. Public widget JSON.',
  },
  {
    key: 'workday', label: 'Workday', hosts: ['.myworkdayjobs.com', '.myworkdaysite.com'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 6, downgradeOnChallengeHours: 24,
    notes: 'Per-employer accounts and one-time email codes. Free text goes to review.',
  },
  {
    key: 'wellfound', label: 'Wellfound', hosts: ['wellfound.com', '.wellfound.com'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 4, downgradeOnChallengeHours: 24,
    notes: 'Low volume. Terms ban scraping and bandwidth-heavy automation, not a user applying through their own account. Switch to prepare-only here if the site starts challenging.',
  },
  {
    key: 'yc', label: 'YC Work at a Startup', hosts: ['workatastartup.com', '.workatastartup.com'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 3, downgradeOnChallengeHours: 24,
    notes: 'Low volume. Terms ban data mining and scraping, not applying.',
  },
  {
    key: 'naukri', label: 'Naukri', hosts: ['naukri.com', '.naukri.com'], submit: 'auto', extensionAllowed: true,
    defaultDailyCap: 8, downgradeOnChallengeHours: 24,
    notes: 'Applying with your own profile. Recruiter questionnaires go to review.',
  },
  {
    key: 'indeed', label: 'Indeed', hosts: ['indeed.com', '.indeed.com'], submit: 'prepare', extensionAllowed: true,
    defaultDailyCap: 0, downgradeOnChallengeHours: 24,
    notes: 'Terms (A.3.5, D.21) prohibit automated Indeed Apply and agentic submission. Fanfold finds, screens and fills; you press Submit. Postings that redirect to a company site are applied to there.',
  },
  {
    key: 'linkedin', label: 'LinkedIn', hosts: ['linkedin.com', '.linkedin.com'], submit: 'prepare', extensionAllowed: false,
    defaultDailyCap: 0, downgradeOnChallengeHours: 24,
    notes: 'User Agreement §8.2 prohibits plugins and other technology that automate the site. Fanfold finds, screens and fills Easy Apply; you press Submit. Never worked through a browser extension.',
  },
];

/** A cautious default for a site whose terms forbid automation, once the person turns submission on. */
export const LOCKED_SITE_DAILY_CAP = 15;

/** The most the person can set for one site's day. */
const MAX_SITE_DAILY_CAP = 100;

/** Sites the catalog ships as prepare-only because of their terms. */
export const TERMS_LOCKED: ReadonlySet<string> = new Set(SEED.filter((p) => p.submit === 'prepare').map((p) => p.key));

/** The sites as Fanfold ships them, with none of the person's own choices: what is shown before they are in. */
export function catalogue(): SitePolicy[] {
  return SEED.map((s) => ({ ...s, hosts: [...s.hosts], downgradedUntil: null, downgradeReason: null, termsAcceptedAt: null, version: 1 }));
}

export class SitePolicies {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
    const columns = (this.#db.prepare('PRAGMA table_info(site_policies)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('terms_accepted_at')) this.#db.exec('ALTER TABLE site_policies ADD COLUMN terms_accepted_at TEXT');
    if (!columns.includes('downgrade_reason')) this.#db.exec('ALTER TABLE site_policies ADD COLUMN downgrade_reason TEXT');
    this.#seed();
    // A limit of 0 once meant "the default" and was stored as such; it is the shipped number.
    for (const s of SEED) {
      if (s.defaultDailyCap > 0) this.#db.prepare('UPDATE site_policies SET default_daily_cap = ? WHERE key = ? AND default_daily_cap = 0').run(s.defaultDailyCap, s.key);
    }
    // A note written about the owner in the third person is said to them as "your".
    this.#db.prepare("UPDATE site_policies SET notes = replace(notes, 'the user''s own profile', 'your own profile') WHERE notes LIKE '%the user''s own profile%'").run();
  }

  #seed(): void {
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO site_policies
        (key, label, hosts, submit, extension_allowed, default_daily_cap, downgrade_hours, notes)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    for (const s of SEED) {
      insert.run(s.key, s.label, JSON.stringify(s.hosts), s.submit, s.extensionAllowed ? 1 : 0,
        s.defaultDailyCap, s.downgradeOnChallengeHours, s.notes);
    }
  }

  list(): SitePolicy[] {
    return (this.#db.prepare('SELECT * FROM site_policies ORDER BY rowid').all() as Array<Record<string, unknown>>)
      .map(toPolicy);
  }

  get(key: string): SitePolicy | null {
    const row = this.#db.prepare('SELECT * FROM site_policies WHERE key = ?').get(key) as Record<string, unknown> | undefined;
    return row ? toPolicy(row) : null;
  }

  /** The policy for a page, or null for a site the catalog does not know. */
  forUrl(url: string | undefined): SitePolicy | null {
    const host = hostOf(url);
    if (!host) return null;
    return this.list().find((p) => p.hosts.some((h) => matchesHost(host, h))) ?? null;
  }

  /** What submission means on this page right now, downgrades included. */
  submitMode(url: string | undefined, now = new Date()): { mode: SubmitMode; policy: SitePolicy } | null {
    const policy = this.forUrl(url);
    if (!policy) return null;
    const downgraded = policy.downgradedUntil && new Date(policy.downgradedUntil) > now;
    return { mode: downgraded && policy.submit === 'auto' ? 'prepare' : policy.submit, policy };
  }

  /**
   * Change how a site is treated. A site whose own terms prohibit software
   * submitting applications stays locked unless the person accepts that risk
   * themselves: the only caller passing acceptedTerms is the owner-only
   * settings route behind Fanfold's own screen, which no agent's key reaches.
   * Turned on, submission there is gated like anywhere else: approval per
   * application, or a worker's grant within its daily cap.
   */
  setSubmit(key: string, submit: SubmitMode, opts: { acceptedTerms?: boolean; now?: Date } = {}): void {
    const locked = TERMS_LOCKED.has(key);
    if (submit === 'auto' && locked && !opts.acceptedTerms) {
      throw new Error(`${this.get(key)?.label ?? key}'s terms prohibit software submitting applications; only you can turn this on, in Fanfold, after accepting that risk`);
    }
    const accepted = submit === 'auto' && locked ? (opts.now ?? new Date()).toISOString() : null;
    this.#db.prepare(`UPDATE site_policies SET submit = ?, terms_accepted_at = ?, version = version + 1,
      default_daily_cap = CASE WHEN ? AND default_daily_cap = 0 THEN ? ELSE default_daily_cap END WHERE key = ?`)
      .run(submit, accepted, accepted ? 1 : 0, LOCKED_SITE_DAILY_CAP, key);
  }

  /**
   * How many applications a day may be sent on a site without asking. The
   * person's to set, from the same owner-only route as setSubmit. Zero goes
   * back to the site's shipped limit, which is what is stored and shown.
   */
  setDailyCap(key: string, cap: number): void {
    const asked = Math.max(0, Math.min(MAX_SITE_DAILY_CAP, Math.round(cap)));
    const value = asked || shippedDailyCap(key);
    this.#db.prepare('UPDATE site_policies SET default_daily_cap = ?, version = version + 1 WHERE key = ?').run(value, key);
  }

  /** A challenge was seen: the site is prepare-only for its downgrade window, or until a later pause already set. */
  downgrade(key: string, now = new Date(), untilDate?: Date, reason: DowngradeReason = 'check'): string | null {
    const policy = this.get(key);
    if (!policy) return null;
    const wanted = untilDate ?? new Date(now.getTime() + policy.downgradeOnChallengeHours * 3_600_000);
    const held = policy.downgradedUntil && new Date(policy.downgradedUntil) > now ? new Date(policy.downgradedUntil) : null;
    // The pause that lasts longer is the one in force, and its reason with it.
    const keep = held && held > wanted;
    this.#db.prepare('UPDATE site_policies SET downgraded_until = ?, downgrade_reason = ? WHERE key = ?')
      .run((keep ? held : wanted).toISOString(), keep ? policy.downgradeReason ?? null : reason, key);
    return (keep ? held : wanted).toISOString();
  }
}

/** The daily limit a site ships with; for a site whose terms lock submitting, the cautious one used once it is turned on. */
export function shippedDailyCap(key: string): number {
  const seeded = SEED.find((s) => s.key === key)?.defaultDailyCap ?? 0;
  return seeded || (TERMS_LOCKED.has(key) ? LOCKED_SITE_DAILY_CAP : 0);
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

export function matchesHost(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith('.')) return host === p.slice(1) || host.endsWith(p);
  return host === p;
}

function toPolicy(row: Record<string, unknown>): SitePolicy {
  return {
    key: String(row.key),
    label: String(row.label),
    hosts: JSON.parse(String(row.hosts)) as string[],
    submit: String(row.submit) as SubmitMode,
    extensionAllowed: Number(row.extension_allowed) === 1,
    defaultDailyCap: Number(row.default_daily_cap),
    downgradeOnChallengeHours: Number(row.downgrade_hours),
    notes: String(row.notes),
    downgradedUntil: row.downgraded_until === null ? null : String(row.downgraded_until),
    downgradeReason: row.downgrade_reason ? String(row.downgrade_reason) as DowngradeReason : null,
    termsAcceptedAt: row.terms_accepted_at === null || row.terms_accepted_at === undefined ? null : String(row.terms_accepted_at),
    version: Number(row.version),
  };
}
