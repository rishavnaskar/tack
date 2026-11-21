import type { AppStatus, Application, Segment } from '../../api/types';

export const STATUSES: AppStatus[] = ['applied', 'viewed', 'reply', 'interview', 'offer', 'rejected', 'ghosted'];

export const STATUS_LABEL: Record<AppStatus, string> = {
  applied: 'Applied',
  viewed: 'Viewed',
  reply: 'Reply',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  ghosted: 'Ghosted',
};

export const STATUS_HINT: Record<AppStatus, string> = {
  applied: 'Sent, waiting to hear back',
  viewed: 'Viewed by someone',
  reply: 'A person replied',
  interview: 'Interviewing',
  offer: 'Got an offer',
  rejected: 'Not selected',
  ghosted: 'No reply for 14 days',
};

export const isResponse = (s: AppStatus) => s === 'reply' || s === 'interview' || s === 'offer';

const DAY = 86_400_000;
export const daysSince = (at: string, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(at)) / DAY));

// The coach sends camelCase dimension keys; the mock sends labels. Both map here.
const DIMS: { key: string; label: string; match: string[] }[] = [
  { key: 'roleFamily', label: 'Role family', match: ['rolefamily', 'role family'] },
  { key: 'seniority', label: 'Seniority', match: ['seniority'] },
  { key: 'companySize', label: 'Company size', match: ['companysize', 'company size', 'size'] },
  { key: 'source', label: 'Source', match: ['source'] },
  { key: 'fitBand', label: 'Fit band', match: ['fitband', 'fit band', 'fit'] },
];

export function dimOf(dimension: string) {
  const d = dimension.toLowerCase().replace(/[_-]/g, '');
  return DIMS.find((x) => x.match.includes(d) || x.match.includes(dimension.toLowerCase())) ?? { key: dimension, label: humanise(dimension), match: [] };
}

export function humanise(v: string) {
  const s = String(v ?? '').replace(/[-_]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
}

const SIZE: Record<string, string> = { startup: 'Startup', scaleup: 'Scaleup', enterprise: 'Enterprise' };
const FIT: Record<string, string> = { high: 'High fit', medium: 'Middle fit', low: 'Low fit' };

export function segmentValue(dimension: string, value: string) {
  const key = dimOf(dimension).key;
  if (key === 'companySize') return SIZE[value] ?? humanise(value);
  if (key === 'fitBand') return FIT[value] ?? humanise(value);
  return humanise(value);
}

export const segKey = (s: Pick<Segment, 'dimension' | 'value'>) => `${dimOf(s.dimension).key}|${s.value}`;

export function groupSegments(segments: Segment[]) {
  const groups = new Map<string, { key: string; label: string; rows: Segment[] }>();
  for (const s of segments) {
    const d = dimOf(s.dimension);
    const g = groups.get(d.key) ?? { key: d.key, label: d.label, rows: [] };
    g.rows.push(s);
    groups.set(d.key, g);
  }
  const order = DIMS.map((d) => d.key);
  const fitOrder = ['high', 'medium', 'low'];
  return [...groups.values()]
    .map((g) => ({
      ...g,
      rows:
        g.key === 'fitBand' && g.rows.every((r) => fitOrder.includes(r.value))
          ? [...g.rows].sort((a, b) => fitOrder.indexOf(a.value) - fitOrder.indexOf(b.value))
          : [...g.rows].sort((a, b) => b.rate - a.rate || b.sent - a.sent),
    }))
    .sort((a, b) => (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)));
}

/** A segment that clearly replies more: well above average on enough evidence. */
export const isWinner = (s: Segment) => s.lift >= 1.3 && s.confidence !== 'low' && s.responses > 0;

/** The coach sends 0-1; older fixtures sent a whole percent. */
export const chance = (x: number) => (x > 1 ? x / 100 : x);

export const pctOf = (x: number) => `${Math.round(x * 100)}%`;

export function byStatus(apps: Application[]) {
  const m = new Map<AppStatus, Application[]>(STATUSES.map((s) => [s, []]));
  for (const a of apps) (m.get(a.status) ?? m.get('applied'))!.push(a);
  for (const list of m.values()) list.sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
  return m;
}
