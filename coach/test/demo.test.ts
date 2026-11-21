import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GapMap, Goal, Posting, Profile } from '../src/types.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-demo-'));
const { demoGoal, demoProfile, demoResumeText, loadDemo, snapshotPostings } = await import('../src/demo/load.ts');
const { CATALOG } = await import('../src/skills.ts');
const { computeGap } = await import('../src/gap.ts');
const store = await import('../src/store.ts');

const known = new Set(CATALOG.map((s) => s.id));
const postings = snapshotPostings(new Date('2026-11-21T10:00:00Z'));

test('40 postings with unique ids on .example hosts', () => {
  assert.equal(postings.length, 40);
  assert.equal(new Set(postings.map((p) => p.id)).size, 40);
  assert.equal(new Set(postings.map((p) => p.company)).size, 40);
  for (const p of postings) {
    assert.match(new URL(p.url).hostname, /\.example$/, p.id);
    assert.equal(p.live, false);
    assert.ok(['startup', 'scaleup', 'enterprise'].includes(p.companySize!), p.id);
    assert.ok(['associate', 'mid', 'senior', 'lead'].includes(p.seniority!), p.id);
    assert.ok(['platform', 'growth', 'agents', 'analytics', 'generalist'].includes(p.roleFamily!), p.id);
  }
});

test('posting text is 200 to 350 words', () => {
  for (const p of postings) {
    const words = p.text.split(/\s+/).length;
    assert.ok(words >= 200 && words <= 350, `${p.id} has ${words} words`);
  }
});

test('every posting has 6 to 10 canonical skills and every quote is verbatim', () => {
  for (const p of postings) {
    assert.ok(p.skills!.length >= 6 && p.skills!.length <= 10, `${p.id} has ${p.skills!.length} skills`);
    assert.equal(new Set(p.skills!.map((s) => s.skillId)).size, p.skills!.length, `${p.id} repeats a skill`);
    for (const s of p.skills!) {
      assert.ok(known.has(s.skillId), `${p.id}: ${s.skillId} is not in the catalog`);
      assert.ok(['must', 'nice'].includes(s.importance));
      assert.ok(p.text.includes(s.quote), `${p.id}: quote for ${s.skillId} is not in the text: ${s.quote}`);
    }
  }
});

test('listed salaries appear in the posting text', () => {
  for (const p of postings) if (p.salary) assert.ok(p.text.includes(p.salary), p.id);
});

test('the demo profile quotes the demo résumé verbatim', () => {
  const resume = demoResumeText();
  const profile = demoProfile();
  assert.equal(profile.name, 'Avery Quinn');
  assert.equal(profile.source, 'demo');
  for (const s of profile.skills) {
    assert.ok(known.has(s.id), s.id);
    assert.ok(s.level >= 1 && s.level <= 5);
    assert.ok(s.evidence.length > 0, s.id);
    for (const e of s.evidence) assert.ok(resume.includes(e), `${s.id}: ${e}`);
  }
  const ids = new Set(profile.skills.map((s) => s.id));
  for (const gap of ['product-discovery', 'prd-writing', 'llm-evaluation', 'roadmapping', 'pricing', 'user-research']) assert.ok(!ids.has(gap), gap);
  for (const overlap of ['sql', 'apis', 'experimentation', 'stakeholder-management']) assert.ok(ids.has(overlap), overlap);
});

test('the demo goal starts on a Monday two weeks back', () => {
  const goal = demoGoal(new Date('2026-11-21T10:00:00Z'));
  assert.equal(goal.startDate, '2026-11-02');
  assert.equal(new Date(goal.startDate).getUTCDay(), 1);
  assert.equal(goal.hoursPerWeek, 10);
  assert.equal(goal.weeks, 12);
});

test('loadDemo fills the store without a model call', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('no network in demo load'); }) as typeof fetch;
  try {
    store.put('application', 'stale', { id: 'stale' });
    await loadDemo();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(store.get<'demo'>('single', 'mode'), 'demo');
  assert.equal(store.get<Profile>('single', 'profile')?.name, 'Avery Quinn');
  assert.equal(store.get<Goal>('single', 'goal')?.targetRole, 'AI Product Manager');
  const stored = store.list<Posting>('posting');
  assert.equal(stored.length, 40);
  assert.ok(stored.every((p) => typeof p.fit === 'number'));
  const gap = store.get<GapMap>('single', 'gap')!;
  assert.equal(gap.postingCount, 40);
  // seed-b (when present) moves the person two weeks into the plan, so only loose bounds here.
  assert.ok(gap.readiness > 15 && gap.readiness < 80, `readiness ${gap.readiness}`);
  const byDemand = [...gap.skills].sort((a, b) => b.demand - a.demand).slice(0, 3).map((s) => s.id);
  assert.equal(byDemand[0], 'llm-evaluation');

  assert.ok(store.list('readiness').length >= 1);
  assert.equal(store.get('application', 'stale'), undefined);
});

test('before any progress the snapshot shows real overlap and clear PM gaps', () => {
  const gap = computeGap(demoProfile(), postings);
  const top = gap.skills.slice(0, 4).map((s) => s.id);
  assert.ok(top.includes('llm-evaluation') && top.includes('product-discovery'), top.join(','));
  const level = (id: string) => gap.skills.find((s) => s.id === id)?.level;
  for (const id of ['product-discovery', 'prd-writing', 'llm-evaluation', 'roadmapping', 'pricing', 'user-research']) assert.equal(level(id), 'missing', id);
  for (const id of ['sql', 'apis']) assert.equal(level(id), 'strong', id);
  for (const id of ['experimentation', 'stakeholder-management']) assert.equal(level(id), 'partial', id);
  assert.ok(gap.readiness > 20 && gap.readiness < 45, `readiness ${gap.readiness}`);
});
