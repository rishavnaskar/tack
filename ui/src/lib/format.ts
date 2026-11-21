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

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
