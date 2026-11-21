import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Application, AppStatus, Posting } from '../src/types.ts';
import {
  applyEvent, confidence, fitBand, fitCuts, insights, lessons, markGhosted, mulberry32, nextPostings, sampleBeta, segments,
} from '../src/tracker.ts';

let n = 0;
function app(roleFamily: string, companySize: string, fit: number, status: AppStatus, daysAgo = 20): Application {
  const appliedAt = new Date(Date.parse('2026-11-21T00:00:00Z') - daysAgo * 86_400_000).toISOString();
  return {
    id: `a${++n}`, title: `${roleFamily} PM`, company: `Co${n}`, url: `https://co${n}.example/job`, roleFamily, seniority: 'mid',
    companySize, source: 'careers page', fit, appliedAt, status, lastEventAt: appliedAt,
    events: [{ at: appliedAt, kind: 'applied', note: '' }, ...(status === 'applied' ? [] : [{ at: appliedAt, kind: status, note: '' }])], origin: 'demo',
  };
}

const APPS: Application[] = [
  app('growth', 'scaleup', 82, 'reply'), app('growth', 'scaleup', 78, 'interview'), app('growth', 'scaleup', 74, 'reply'),
  app('growth', 'scaleup', 71, 'rejected'), app('platform', 'scaleup', 80, 'interview'), app('platform', 'scaleup', 66, 'ghosted'),
  app('generalist', 'enterprise', 45, 'ghosted'), app('generalist', 'enterprise', 52, 'rejected'), app('generalist', 'enterprise', 40, 'ghosted'),
  app('generalist', 'enterprise', 48, 'rejected'), app('generalist', 'enterprise', 58, 'reply'), app('ai', 'startup', 69, 'rejected'),
];

test('beta sampling with a seeded source is reproducible and centred on the mean', () => {
  const a = mulberry32(7), b = mulberry32(7);
  const xs = Array.from({ length: 4000 }, () => sampleBeta(3, 7, a));
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => sampleBeta(3, 7, b)));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.3) < 0.02, `mean ${mean}`);
  assert.ok(xs.every((x) => x > 0 && x < 1));
});

test('segments use reply, interview and offer as responses and lift from posterior means', () => {
  const { overall, segments: segs } = segments(APPS);
  assert.deepEqual(overall, { sent: 12, responses: 5, rate: 0.417 });
  const growth = segs.find((s) => s.dimension === 'roleFamily' && s.value === 'growth')!;
  assert.equal(growth.sent, 4);
  assert.equal(growth.responses, 3);
  assert.equal(growth.rate, 0.75);
  // (1+3)/(2+4) over (1+5)/(2+12)
  assert.equal(growth.lift, Math.round(((4 / 6) / (6 / 14)) * 100) / 100);
  assert.equal(growth.confidence, 'low');
  const ent = segs.find((s) => s.dimension === 'companySize' && s.value === 'enterprise')!;
  assert.equal(ent.confidence, 'medium');
  assert.ok(ent.lift < 1);
  assert.equal(confidence(4), 'low');
  assert.equal(confidence(11), 'medium');
  assert.equal(confidence(12), 'high');
  assert.equal(fitBand(70), 'high');
  assert.equal(fitBand(50), 'medium');
  assert.equal(fitBand(49), 'low');
});

test('fit bands are tertiles of the application fits, with fixed cut-offs for small samples', () => {
  assert.deepEqual(fitCuts([10, 20, 30]), { low: 50, high: 70 });
  assert.deepEqual(fitCuts([15, 18, 21, 24, 28, 31, 39, 42, 56]), { low: 24, high: 39 });
  assert.deepEqual(fitCuts([30, 30, 30, 30, 30, 30]), { low: 30, high: 31 });
  const { cuts, segments: segs } = segments(APPS);
  assert.deepEqual(cuts, { low: 58, high: 74 });
  const bands = segs.filter((s) => s.dimension === 'fitBand');
  assert.equal(bands.reduce((a, s) => a + s.sent, 0), APPS.length);
});

test('lessons are code-written sentences about the strongest and weakest segments', () => {
  const { overall, segments: segs, cuts } = segments(APPS);
  const ls = lessons(APPS, overall, segs, cuts);
  assert.ok(ls.some((l) => /^Scaleups replied 4 times out of 6/.test(l)), ls.join('\n'));
  assert.ok(ls.some((l) => /^Enterprises replied 1 out of 5/.test(l) || /^Generalist roles replied 1 out of 5/.test(l)), ls.join('\n'));
  assert.ok(ls.some((l) => l.startsWith('Your top fits (74 and up)')), ls.join('\n'));
  assert.ok(ls.some((l) => /no reply for over 14 days/.test(l)));
  assert.deepEqual(lessons([], { sent: 0, responses: 0, rate: 0 }, []).length, 1);
});

test('ghosted means applied more than 14 days ago with no event since', () => {
  const fresh = app('growth', 'scaleup', 80, 'applied', 5);
  const old = app('growth', 'scaleup', 80, 'applied', 20);
  const heard = app('growth', 'scaleup', 80, 'applied', 20);
  heard.events.push({ at: heard.appliedAt, kind: 'viewed', note: '' });
  const changed = markGhosted([fresh, old, heard], new Date('2026-11-21T00:00:00Z'));
  assert.deepEqual(changed.map((a) => a.id), [old.id]);
  assert.equal(old.status, 'ghosted');
  assert.equal(fresh.status, 'applied');
  assert.equal(heard.status, 'applied');
});

function posting(id: string, roleFamily: string, companySize: Posting['companySize'], fit: number): Posting {
  return { id, title: `${roleFamily} PM`, company: `P${id}`, location: 'Bengaluru', url: `https://${id}.example`, source: 'careers page', text: '', harvestedAt: '', live: false, roleFamily, seniority: 'mid', companySize, fit };
}

test('next ranks unapplied postings by Thompson sampling blended with fit', () => {
  const postings = [
    posting('g1', 'growth', 'scaleup', 75), posting('e1', 'generalist', 'enterprise', 75), posting('e2', 'generalist', 'enterprise', 60),
    { ...posting('dup', 'growth', 'scaleup', 90), id: 'dup', url: APPS[0].url },
  ];
  const { overall, segments: segs } = segments(APPS);
  const wins = { g1: 0, e1: 0 };
  for (let seed = 1; seed <= 200; seed++) {
    const next = nextPostings(postings, APPS, segs, overall, { rng: mulberry32(seed) });
    assert.ok(!next.some((x) => x.postingId === 'dup'), 'already applied by url');
    if (next[0].postingId === 'g1') wins.g1++;
    if (next[0].postingId === 'e1') wins.e1++;
  }
  assert.ok(wins.g1 > wins.e1 * 3, JSON.stringify(wins));
  const a = nextPostings(postings, APPS, segs, overall, { rng: mulberry32(3) });
  const b = nextPostings(postings, APPS, segs, overall, { rng: mulberry32(3) });
  assert.deepEqual(a, b);
  const g1 = a.find((x) => x.postingId === 'g1')!;
  const e1 = a.find((x) => x.postingId === 'e1')!;
  assert.ok(g1.responseChance > e1.responseChance);
  assert.match(g1.why, /reply [\d.]+x your average/);
});

test('insights bundle overall, segments, lessons and next', () => {
  const out = insights(APPS, [posting('x', 'growth', 'scaleup', 80)], { rng: mulberry32(1) });
  assert.equal(out.overall.sent, 12);
  assert.ok(out.segments.length > 5);
  assert.ok(out.lessons.length > 0);
  assert.equal(out.next.length, 1);
});

test('engine events move an application forward, never back, and are not duplicated', () => {
  const a = app('growth', 'scaleup', 80, 'interview');
  assert.equal(applyEvent(a, { at: '2026-11-20T00:00:00Z', kind: 'reply', note: 'Thanks' }, 'reply'), true);
  assert.equal(a.status, 'interview');
  assert.equal(applyEvent(a, { at: '2026-11-20T00:00:00Z', kind: 'reply', note: 'Thanks' }, 'reply'), false);
  assert.equal(applyEvent(a, { at: '2026-11-21T00:00:00Z', kind: 'offer', note: 'Offer' }, 'offer'), true);
  assert.equal(a.status, 'offer');
  assert.equal(a.lastEventAt, '2026-11-21T00:00:00Z');
});

test('with no applications yet, fit decides the apply-next order', () => {
  const postings = [posting('lo', 'growth', 'scaleup', 23), posting('hi', 'generalist', 'enterprise', 61), posting('mid', 'platform', 'startup', 40)];
  const { overall, segments: segs } = segments([]);
  for (let seed = 1; seed <= 20; seed++) {
    const next = nextPostings(postings, [], segs, overall, { rng: mulberry32(seed) });
    assert.deepEqual(next.map((n) => n.postingId), ['hi', 'mid', 'lo']);
  }
});
