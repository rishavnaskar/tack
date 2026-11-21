import type { Application, AppStatus, Posting, Segment, TrackerInsights } from './types.ts';

export type Rng = () => number;

const DAY = 86_400_000;
export const GHOST_DAYS = 14;
export const DIMENSIONS = ['roleFamily', 'seniority', 'companySize', 'source', 'fitBand'] as const;
type Dim = (typeof DIMENSIONS)[number];

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia and Tsang
function gamma(k: number, rng: Rng): number {
  if (k < 1) return gamma(k + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(a: number, b: number, rng: Rng): number {
  const x = gamma(a, rng), y = gamma(b, rng);
  return x / (x + y);
}

export const isResponse = (s: AppStatus) => s === 'reply' || s === 'interview' || s === 'offer';

export interface FitCuts { low: number; high: number }
export const DEFAULT_CUTS: FitCuts = { low: 50, high: 70 };

// Bands are tertiles of the person's own application fits: a career changer's fits sit low
// across the board, and fixed 50/70 cut-offs would put everything in one band.
export function fitCuts(fits: number[]): FitCuts {
  if (fits.length < 6) return DEFAULT_CUTS;
  const s = [...fits].map((f) => Math.round(f)).sort((a, b) => a - b);
  const low = s[Math.floor(s.length / 3)];
  const high = Math.max(low + 1, s[Math.floor((2 * s.length) / 3)]);
  return { low, high };
}

export function fitBand(fit: number, cuts: FitCuts = DEFAULT_CUTS): 'high' | 'medium' | 'low' {
  return fit >= cuts.high ? 'high' : fit >= cuts.low ? 'medium' : 'low';
}

export function confidence(n: number): Segment['confidence'] {
  return n < 5 ? 'low' : n < 12 ? 'medium' : 'high';
}

function valueOf(a: Pick<Application, 'roleFamily' | 'seniority' | 'companySize' | 'source' | 'fit'>, dim: Dim, cuts: FitCuts): string {
  if (dim === 'fitBand') return fitBand(a.fit, cuts);
  return String(a[dim] || 'unknown');
}

// Applied more than 14 days ago with nothing heard since.
export function markGhosted(apps: Application[], now: Date): Application[] {
  const changed: Application[] = [];
  const cutoff = now.getTime() - GHOST_DAYS * DAY;
  for (const a of apps) {
    if (a.status !== 'applied') continue;
    // An automatic acknowledgement is not hearing back.
    const heard = a.events.some((e) => e.kind !== 'applied' && e.kind !== 'auto-ack' && e.kind !== 'mail');
    if (heard || Date.parse(a.appliedAt) > cutoff) continue;
    const at = new Date(Date.parse(a.appliedAt) + GHOST_DAYS * DAY).toISOString();
    a.status = 'ghosted';
    a.lastEventAt = at;
    a.events.push({ at, kind: 'ghosted', note: `No reply ${GHOST_DAYS} days after applying` });
    changed.push(a);
  }
  return changed;
}

const posteriorMean = (r: number, n: number) => (1 + r) / (2 + n);

// rate is the raw share that replied; lift compares Beta(1,1) posterior means
export function segments(apps: Application[]): { overall: TrackerInsights['overall']; segments: Segment[]; cuts: FitCuts } {
  const cuts = fitCuts(apps.map((a) => a.fit));
  const n = apps.length;
  const r = apps.filter((a) => isResponse(a.status)).length;
  const overallMean = posteriorMean(r, n);
  const out: Segment[] = [];
  for (const dim of DIMENSIONS) {
    const groups = new Map<string, { sent: number; responses: number }>();
    for (const a of apps) {
      const v = valueOf(a, dim, cuts);
      const g = groups.get(v) ?? { sent: 0, responses: 0 };
      g.sent++;
      if (isResponse(a.status)) g.responses++;
      groups.set(v, g);
    }
    for (const [value, g] of groups) {
      out.push({
        dimension: dim, value, sent: g.sent, responses: g.responses,
        rate: round(g.responses / g.sent, 3),
        lift: round(posteriorMean(g.responses, g.sent) / overallMean, 2),
        confidence: confidence(g.sent),
      });
    }
  }
  out.sort((a, b) => DIMENSIONS.indexOf(a.dimension as Dim) - DIMENSIONS.indexOf(b.dimension as Dim) || b.lift - a.lift || b.sent - a.sent);
  return { overall: { sent: n, responses: r, rate: n ? round(r / n, 3) : 0 }, segments: out, cuts };
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (n: number) => `${Math.round(n * 100)}%`;

const SIZE_NAMES: Record<string, string> = { startup: 'startups', scaleup: 'scaleups', enterprise: 'enterprises' };
const SOURCE_NAMES: Record<string, string> = {
  'company-site': 'company sites', 'job-board': 'job boards', 'startup-board': 'startup boards', referral: 'referrals',
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable', linkedin: 'LinkedIn',
};

export function segmentLabel(s: Pick<Segment, 'dimension' | 'value'>): string {
  switch (s.dimension) {
    case 'roleFamily': return `${s.value} roles`;
    case 'seniority': return `${s.value}-level roles`;
    case 'companySize': return SIZE_NAMES[s.value] ?? `${s.value} companies`;
    case 'source': return `applications through ${SOURCE_NAMES[s.value] ?? s.value.replace(/-/g, ' ')}`;
    case 'fitBand': return `${s.value}-fit postings`;
    default: return `${s.dimension} ${s.value}`;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Plain sentences written by code from the strongest and weakest segments.
export function lessons(apps: Application[], overall: TrackerInsights['overall'], segs: Segment[], cuts: FitCuts = DEFAULT_CUTS): string[] {
  const out: string[] = [];
  if (!overall.sent) return ['No applications yet. Send a first batch of five to high-fit postings so there is something to learn from.'];
  const usable = segs.filter((s) => s.sent >= 3 && s.dimension !== 'fitBand');
  const CONF = { high: 2, medium: 1, low: 0 };
  // the strongest and weakest segment of each dimension, surest first
  const best = (pick: (s: Segment) => boolean, better: (a: Segment, b: Segment) => number) => {
    const per = new Map<string, Segment>();
    for (const s of usable.filter(pick)) {
      const cur = per.get(s.dimension);
      if (!cur || better(s, cur) < 0) per.set(s.dimension, s);
    }
    return [...per.values()].sort((a, b) => CONF[b.confidence] - CONF[a.confidence] || better(a, b));
  };
  const top = best((s) => s.lift >= 1.25 && s.responses > 0, (a, b) => b.lift - a.lift || b.sent - a.sent).slice(0, 3);
  const bottom = best((s) => s.lift <= 0.8, (a, b) => a.lift - b.lift || b.sent - a.sent).slice(0, 2);
  const caveat = (s: Segment) => (s.confidence === 'low' ? ' Small sample, so treat it as a hint.' : '');
  for (const s of top) {
    out.push(`${cap(segmentLabel(s))} replied ${s.responses} times out of ${s.sent} (${pct(s.rate)}), ${s.lift.toFixed(1)}x your average.${caveat(s)}`);
  }
  for (const s of bottom) {
    out.push(`${cap(segmentLabel(s))} replied ${s.responses} out of ${s.sent} (${pct(s.rate)}), ${s.lift.toFixed(1)}x your average: send fewer of these or change the pitch.${caveat(s)}`);
  }
  const hi = segs.find((s) => s.dimension === 'fitBand' && s.value === 'high');
  const lo = segs.find((s) => s.dimension === 'fitBand' && s.value === 'low');
  if (hi && lo && hi.rate > lo.rate) {
    out.push(`Your highest-fit applications (fit ${cuts.high} and up) replied ${pct(hi.rate)} of the time against ${pct(lo.rate)} for the lowest (under ${cuts.low}); applying below ${cuts.low} mostly costs time.`);
  }
  const fam = top.find((s) => s.dimension === 'roleFamily');
  const size = top.find((s) => s.dimension === 'companySize');
  if (fam && size) out.push(`Next batch: favour ${fam.value} roles at ${SIZE_NAMES[size.value] ?? size.value}.`);
  const ghosted = apps.filter((a) => a.status === 'ghosted').length;
  if (ghosted) out.push(`${ghosted} application${ghosted > 1 ? 's have' : ' has'} had no answer for more than ${GHOST_DAYS} days; follow up once, then let ${ghosted > 1 ? 'them' : 'it'} go.`);
  if (overall.sent < 12) out.push(`Only ${overall.sent} application${overall.sent > 1 ? 's' : ''} so far; these patterns firm up after about 12.`);
  if (!top.length && !bottom.length && overall.sent >= 5) out.push(`Replies are even across the kinds of roles you have tried (${pct(overall.rate)} overall); keep the mix until a pattern shows.`);
  return out;
}

export function appliedKeys(apps: Application[]): { ids: Set<string>; urls: Set<string>; names: Set<string> } {
  return {
    ids: new Set(apps.map((a) => a.postingId).filter((x): x is string => !!x)),
    urls: new Set(apps.map((a) => a.url).filter(Boolean)),
    names: new Set(apps.map((a) => `${a.company}|${a.title}`.toLowerCase())),
  };
}

export interface NextOpts { rng?: Rng; fitOf?: (p: Posting) => number; limit?: number; cuts?: FitCuts }

// Thompson sampling over the segment posteriors, blended with fit.
export function nextPostings(postings: Posting[], apps: Application[], segs: Segment[], overall: TrackerInsights['overall'], opts: NextOpts = {}): TrackerInsights['next'] {
  const rng = opts.rng ?? Math.random;
  const keys = appliedKeys(apps);
  const byKey = new Map(segs.map((s) => [`${s.dimension}|${s.value}`, s]));
  const mean = posteriorMean(overall.responses, overall.sent);
  // With few applications the samples are mostly noise, so fit leads until there is data to learn from.
  const learn = 0.6 * Math.min(1, overall.sent / 12);
  const scored = postings
    .filter((p) => !keys.ids.has(p.id) && !keys.urls.has(p.url) && !keys.names.has(`${p.company}|${p.title}`.toLowerCase()))
    .map((p) => {
      const fit = Math.round(p.fit ?? opts.fitOf?.(p) ?? 50);
      const values: Record<Dim, string> = {
        roleFamily: p.roleFamily || 'unknown', seniority: p.seniority || 'unknown',
        companySize: p.companySize || 'unknown', source: p.source || 'unknown', fitBand: fitBand(fit, opts.cuts),
      };
      let sample = 0, expected = 0;
      const notes: { seg: Segment }[] = [];
      for (const dim of DIMENSIONS) {
        const seg = byKey.get(`${dim}|${values[dim]}`);
        // unseen segment: a weak prior centred on the overall rate
        const a = seg ? 1 + seg.responses : 1 + mean * 2;
        const b = seg ? 1 + seg.sent - seg.responses : 1 + (1 - mean) * 2;
        sample += sampleBeta(a, b, rng);
        expected += a / (a + b);
        if (seg) notes.push({ seg });
      }
      sample /= DIMENSIONS.length;
      expected /= DIMENSIONS.length;
      const score = (1 - learn) * (fit / 100) + learn * Math.min(1, sample / Math.max(0.05, 2 * mean));
      return { p, fit, score, expected, why: whyFor(fit, notes.map((n) => n.seg)) };
    })
    .sort((a, b) => b.score - a.score || b.fit - a.fit || a.p.id.localeCompare(b.p.id))
    .slice(0, opts.limit ?? 8);
  return scored.map(({ p, fit, expected, why }) => ({
    postingId: p.id, title: p.title, company: p.company, url: p.url, fit, responseChance: round(expected, 2), why,
  }));
}

function whyFor(fit: number, segs: Segment[]): string {
  const good = segs.filter((s) => s.dimension !== 'fitBand' && s.lift >= 1.15 && s.sent >= 2).sort((a, b) => b.lift - a.lift).slice(0, 2);
  const bad = segs.filter((s) => s.dimension !== 'fitBand' && s.lift <= 0.8 && s.sent >= 3).sort((a, b) => a.lift - b.lift)[0];
  const parts = good.map((s) => `${segmentLabel(s)} reply ${s.lift.toFixed(1)}x your average`);
  if (!good.length && !segs.some((s) => s.dimension !== 'fitBand')) parts.push('no replies to learn from for this kind of role yet, so it is worth a test');
  if (bad) parts.push(`but ${segmentLabel(bad)} reply less (${bad.lift.toFixed(1)}x)`);
  parts.push(`fit ${fit}`);
  return cap(parts.join('; ')) + '.';
}

export function insights(apps: Application[], postings: Posting[], opts: NextOpts = {}): TrackerInsights {
  const { overall, segments: segs, cuts } = segments(apps);
  return { overall, segments: segs, lessons: lessons(apps, overall, segs, cuts), next: nextPostings(postings, apps, segs, overall, { cuts, ...opts }) };
}

// ---- engine sync mapping ---------------------------------------------------

const STATUS_WORDS: [RegExp, AppStatus][] = [
  [/offer/i, 'offer'], [/interview|schedule|call|chat|meet/i, 'interview'], [/reject|unfortunately|not (moving|proceed)|other candidates|declin/i, 'rejected'],
  [/view|seen|open/i, 'viewed'], [/repl|respon|answer|thank/i, 'reply'],
];

export function statusFrom(text: string): AppStatus | undefined {
  for (const [re, s] of STATUS_WORDS) if (re.test(text)) return s;
}

const RANK: Record<AppStatus, number> = { applied: 0, ghosted: 0, viewed: 1, reply: 2, rejected: 3, interview: 4, offer: 5 };

// Moves an application forward on a new event; never backwards.
export function applyEvent(app: Application, ev: { at: string; kind: string; note: string }, status?: AppStatus): boolean {
  if (app.events.some((e) => e.at === ev.at && e.kind === ev.kind && e.note === ev.note)) return false;
  app.events.push(ev);
  app.events.sort((a, b) => a.at.localeCompare(b.at));
  if (ev.at > app.lastEventAt) app.lastEventAt = ev.at;
  if (status && (RANK[status] > RANK[app.status] || app.status === 'ghosted')) app.status = status;
  return true;
}
