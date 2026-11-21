export function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function ago(at?: string, now = Date.now()) {
  if (!at) return '';
  const t = Date.parse(at);
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, Math.round((now - t) / 86400000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} weeks ago`;
}

/** "3d ago", "5w ago", "4mo ago": for places with room for a few characters. */
export function agoShort(at?: string, now = Date.now()) {
  if (!at) return '';
  const t = Date.parse(at);
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, Math.round((now - t) / 86400000));
  if (days === 0) return 'today';
  if (days < 14) return `${days}d ago`;
  if (days < 63) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function pct(x: number, digits = 0) {
  return `${(x * 100).toFixed(digits)}%`;
}

export function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export function shortDate(at: string) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const sizeLabel: Record<string, string> = {
  startup: 'Startup',
  scaleup: 'Scaleup',
  enterprise: 'Enterprise',
};

export function countBy<T>(xs: T[], key: (x: T) => string | undefined) {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = key(x);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

const CITIES: [RegExp, string][] = [
  [/\b(bengaluru|bangalore|blr)\b/i, 'Bengaluru'],
  [/\b(gurugram|gurgaon)\b/i, 'Gurugram'],
  [/\b(mumbai|bombay)\b/i, 'Mumbai'],
  [/\b(new delhi|delhi)\b/i, 'Delhi'],
  [/\b(chennai|madras)\b/i, 'Chennai'],
  [/\b(kolkata|calcutta)\b/i, 'Kolkata'],
];

/** One name per place, so "Bangalore, Karnataka" and "Bengaluru" count together. */
export function cityOf(location: string) {
  if (/remote/i.test(location)) return 'Remote';
  const known = CITIES.find(([re]) => re.test(location));
  if (known) return known[1];
  return location.replace(/^(hybrid|onsite|on-site|in office)\b( in)?\s*/i, '').split(/[,(/·|]| - /)[0].trim() || undefined;
}

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
