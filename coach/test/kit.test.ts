import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kit, Posting } from '../src/types.ts';
import type { Ask } from '../src/plan.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-kit-'));
const { demoProfile, snapshotPostings } = await import('../src/demo/load.ts');
const { computeGap } = await import('../src/gap.ts');
const { draftKit, fallbackKit, gapsFor, guardBullets, kitText, profileLines, rankedBullets, sourceOf } = await import('../src/kit.ts');

const profile = demoProfile();
const postings = snapshotPostings(new Date('2026-11-21T10:00:00Z'));
const gap = computeGap(profile, postings);
const byId = (id: string) => postings.find((p) => p.id === id)!;
const lines = profileLines(profile);
const inProfile = (s: string) => lines.some((l) => l.toLowerCase().replace(/\s+/g, ' ').includes(s.toLowerCase().replace(/\s+/g, ' ')));

const growth: Posting = {
  id: 'x1', title: 'Growth Product Manager', company: 'Example Co', location: 'Bengaluru', url: 'https://jobs.example/x1', source: 'test',
  text: 'Run experiments. Write SQL. Work with finance.', harvestedAt: '2026-11-21T00:00:00Z', live: false,
  skills: [
    { skillId: 'experimentation', name: 'Experimentation', importance: 'must', quote: 'Run experiments' },
    { skillId: 'sql', name: 'SQL', importance: 'must', quote: 'Write SQL' },
    { skillId: 'stakeholder-management', name: 'Stakeholder management', importance: 'nice', quote: 'Work with finance' },
    { skillId: 'pricing', name: 'Pricing', importance: 'nice', quote: 'Own pricing' },
  ],
};

test('a bullet survives only when its source is really in the profile', () => {
  const { kept, dropped } = guardBullets([
    // case and spacing differ from the résumé: still the same words
    { text: 'Shipped the experiment service behind checkout A/B tests', basedOn: 'built the   FEATURE flag and experiment assignment service' },
    { text: 'Led a team of eight product managers', basedOn: 'led a team of eight product managers across three squads' },
    { text: 'Owned the roadmap', basedOn: 'the rollout plan' },
    { text: 'Ran payouts', basedOn: 'Own the merchant settlement … two partner banks' },
    { text: 'Cut failed payouts by 90% for 20,000 merchants', basedOn: 'cut failed payouts from 1.9% to 0.4%' },
  ], profile);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].basedOn, 'Built the feature flag and experiment assignment service', 'basedOn is rewritten to the exact résumé span');
  assert.ok(inProfile(kept[0].basedOn));
  assert.deepEqual(dropped.map((d) => d.why), ['source is not in the profile', 'source is not in the profile', 'source is not in the profile', 'adds a number']);
});

test('a bullet that stitches two résumé lines together is dropped', () => {
  const { kept, dropped } = guardBullets([
    { text: 'Built Python tooling for catalogue quality checks and compared three prompt formats for summarising incident timelines', basedOn: 'Built internal tooling in Python for catalogue quality checks' },
    // words from elsewhere in the same line are fine
    { text: 'Sat in on seller support calls and turned the top complaints into a prioritised fix list', basedOn: 'turned the top complaints into a prioritised fix list for the sprint' },
  ], profile);
  assert.deepEqual(dropped.map((d) => d.why), ['joins two résumé lines']);
  assert.equal(kept.length, 1);
  assert.match(kept[0].text, /^Sat in on seller support calls/);
});

test('sourceOf reads skill evidence too, and never matches across lines', () => {
  assert.ok(sourceOf('a weekend RAG prototype that answers on-call questions', lines));
  assert.ok(sourceOf('compared three prompt formats for summarising incident timelines', lines));
  assert.equal(sourceOf('handling 2 million orders a month. Moved the catalogue sync', lines), undefined);
});

test('the fallback reorders résumé bullets by overlap and keeps them word for word', () => {
  const bullets = rankedBullets(profile, growth);
  assert.ok(bullets.length >= 3 && bullets.length <= 5);
  for (const b of bullets) {
    assert.equal(b.text, b.basedOn);
    assert.ok(inProfile(b.basedOn), b.basedOn);
  }
  // musts first: the experiment service and the daily SQL line answer both must-haves
  const top = bullets.slice(0, 2).map((b) => b.text);
  assert.ok(top.some((t) => t.startsWith('Built the feature flag and experiment assignment service')), top.join(' | '));
  assert.ok(top.some((t) => t.startsWith('Write SQL daily')), top.join(' | '));
  assert.ok(!bullets.some((b) => b.text.startsWith('Mentor two engineers')), 'unrelated bullets are left out');
});

test('the fallback kit covers every section from stored facts only', () => {
  const kit = fallbackKit({ posting: byId('p01-kestrelledger'), profile, gap, now: new Date('2026-11-21T10:00:00Z') });
  assert.equal(kit.postingId, 'p01-kestrelledger');
  assert.ok(kit.fit >= 0 && kit.fit <= 100);
  assert.ok(kit.headline.startsWith('Senior Backend Engineer, 5 years'));
  for (const b of kit.bullets) assert.ok(inProfile(b.basedOn), b.basedOn);
  assert.match(kit.coverNote, /^Hello Kestrel Ledger team,/);
  assert.match(kit.coverNote, /Avery Quinn$/);
  assert.ok(kit.talkingPoints.length >= 2);
  assert.ok(kit.questionsToAsk.length >= 3);
  // gaps are the posting's asks the gap map has as missing or partial, never a strong one
  const asked = new Set(byId('p01-kestrelledger').skills!.map((s) => s.skillId));
  const weak = new Set(gap.skills.filter((s) => s.level !== 'strong' && asked.has(s.id)).map((s) => s.name));
  assert.ok(kit.gapsToAddress.length > 0 && kit.gapsToAddress.length <= 4);
  for (const g of kit.gapsToAddress) {
    assert.ok(weak.has(g.skill), g.skill);
    assert.ok(g.howToFrame.length > 20);
  }
  assert.ok(!kit.gapsToAddress.some((g) => g.skill === 'SQL'));
});

test('gapsFor puts musts first and frames bridges honestly', () => {
  const gaps = gapsFor({ posting: byId('p01-kestrelledger'), profile, gap });
  const firstNice = gaps.findIndex((g) => g.importance === 'nice');
  if (firstNice >= 0) assert.ok(gaps.slice(firstNice).every((g) => g.importance === 'nice'));
  const kit = fallbackKit({ posting: byId('p01-kestrelledger'), profile, gap });
  const evalGap = kit.gapsToAddress.find((g) => g.skill === gap.skills.find((s) => s.id === 'llm-evaluation')!.name);
  assert.ok(evalGap, 'model evaluation is a gap for this posting');
  assert.match(evalGap!.howToFrame, /new to you/);
});

test('model output is kept only where it traces to the profile', async () => {
  const ask = (async () => ({
    headline: 'Payments engineer moving into AI product, strong on SQL and experiments',
    bullets: [
      { text: 'Built the experiment assignment service the growth team uses to run checkout A/B tests', basedOn: 'Built the feature flag and experiment assignment service the growth team uses' },
      { text: 'Launched an AI copilot used by 3,000 accountants', basedOn: 'launched an AI copilot for accountants' },
      { text: 'Investigate payout failures with daily SQL on Postgres and BigQuery', basedOn: 'Write SQL daily against Postgres and BigQuery' },
    ],
    coverNote: 'I moved 10,000 crore last year. '.repeat(10),
    talkingPoints: ['Evaluation: I own a 3,000 invoice test set', 'SQL: daily against Postgres and BigQuery', 'Experiments: built the assignment service'],
    gaps: [{ skill: 'LLM evaluation', howToFrame: 'Name it as new, then point to the contract tests for partner APIs.' }, { skill: 'Cooking', howToFrame: 'x' }],
    questionsToAsk: ['How is the extraction test set maintained?', 'Who signs off a prompt change?'],
  })) as Ask;
  const ctx = { posting: byId('p01-kestrelledger'), profile, gap };
  const out = await draftKit(ctx, ask);
  assert.equal(out.by, 'model');
  assert.equal(out.offered, 3);
  assert.equal(out.dropped, 1);
  assert.ok(out.kit.bullets.length >= 3, 'topped up to three from the résumé');
  assert.ok(!out.kit.bullets.some((b) => /copilot/i.test(b.text)));
  for (const b of out.kit.bullets) assert.ok(inProfile(b.basedOn), b.basedOn);
  assert.equal(new Set(out.kit.bullets.map((b) => b.basedOn)).size, out.kit.bullets.length);
  assert.match(out.kit.coverNote, /^Hello Kestrel Ledger team,/, 'a cover note with invented figures falls back');
  // "3,000" is in the posting text, so that talking point stands
  assert.equal(out.kit.talkingPoints.length, 3);
  assert.deepEqual(out.kit.gapsToAddress.map((g) => g.skill), gapsFor(ctx).map((g) => g.name), 'gap skills come from the gap map, not the model');
  assert.equal(out.kit.gapsToAddress.find((g) => g.skill === 'LLM evaluation')?.howToFrame, 'Name it as new, then point to the contract tests for partner APIs.');
});

test('a failing model leaves the fallback kit and the error', async () => {
  const ask = (async () => { throw new Error('quota'); }) as Ask;
  const out = await draftKit({ posting: growth, profile, gap }, ask);
  assert.equal(out.by, 'rules');
  assert.equal(out.error, 'quota');
  assert.deepEqual(out.kit.bullets, rankedBullets(profile, growth));
  const noModel = await draftKit({ posting: growth, profile, gap }, null);
  assert.equal(noModel.by, 'rules');
  assert.equal(noModel.error, undefined);
});

test('kitText shows every bullet with its source', () => {
  const kit: Kit = fallbackKit({ posting: growth, profile, gap });
  kit.bullets[0] = { text: 'Rewritten line', basedOn: 'Write SQL daily against Postgres and BigQuery' };
  const text = kitText(kit, growth);
  assert.match(text, /^Application kit: Growth Product Manager at Example Co/);
  assert.match(text, /- Rewritten line\n  from your résumé: "Write SQL daily against Postgres and BigQuery"/);
  assert.match(text, /word for word/);
  assert.match(text, /Questions to ask/);
});

test('progress notes Tack wrote itself are not résumé lines', () => {
  const p = structuredClone(profile);
  p.skills.push({ id: 'prd-writing', name: 'PRD writing', level: 3, evidence: ['Completed the PRD writing work in the Tack plan and passed the week 4 checkpoint'] });
  assert.equal(sourceOf('Completed the PRD writing work in the Tack plan', profileLines(p)), undefined);
  assert.ok(!rankedBullets(p, growth).some((b) => /Tack plan/.test(b.basedOn)));
});
