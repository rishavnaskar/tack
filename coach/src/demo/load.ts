import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Goal, Posting, Profile } from '../types.ts';
import * as store from '../store.ts';
import { recompute } from '../gap.ts';
import { run } from '../trace.ts';

// Dates in the snapshot are relative to this moment and get shifted to "now" on load.
const SNAPSHOT_AT = Date.parse('2026-11-21T04:30:00.000Z');
const DAY = 86_400_000;

function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')) as T;
}

function shift(iso: string | undefined, days: number): string | undefined {
  if (!iso) return iso;
  const d = new Date(Date.parse(iso) + days * DAY);
  return iso.length === 10 ? d.toISOString().slice(0, 10) : d.toISOString();
}

function mondayOnOrBefore(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
  return out;
}

export function demoResumeText(): string {
  return readFileSync(new URL('./resume.txt', import.meta.url), 'utf8');
}

export function demoProfile(): Profile {
  return read<Profile>('profile.json');
}

export function demoGoal(now = new Date()): Goal {
  const goal = read<Goal>('goal.json');
  // The demo person is two weeks into the plan.
  const start = mondayOnOrBefore(now);
  start.setUTCDate(start.getUTCDate() - 14);
  return { ...goal, startDate: start.toISOString().slice(0, 10) };
}

export function snapshotPostings(now = new Date()): Posting[] {
  const days = Math.max(0, Math.floor((now.getTime() - SNAPSHOT_AT) / DAY));
  return read<Posting[]>('postings.json').map((p) => ({
    ...p,
    postedAt: shift(p.postedAt, days),
    harvestedAt: shift(p.harvestedAt, days) ?? now.toISOString(),
    live: false,
  }));
}

export async function loadDemo(): Promise<void> {
  const t = run('demo');
  store.clear();
  store.put('single', 'mode', 'demo');
  store.put('single', 'profile', demoProfile());
  store.put('single', 'goal', demoGoal());
  const postings = snapshotPostings();
  for (const p of postings) store.put('posting', p.id, p);
  t.step('snapshot', `Avery Quinn, ${postings.length} postings`);
  const gap = recompute();
  t.step('gap', `readiness ${gap.readiness} across ${gap.skills.length} skills`);

  const seedB = new URL('./seed-b.ts', import.meta.url);
  if (existsSync(fileURLToPath(seedB))) {
    const mod = await import(seedB.href);
    if (typeof mod.seed === 'function') {
      await mod.seed();
      t.step('seed', 'plan, portfolio, interviews and applications');
    }
  }
  t.ok('demo loaded');
}
