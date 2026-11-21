import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application, MailMessage } from '../src/types.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-replies-'));
const {
  applyMessages, checkReplies, classify, gmailQuery, keywordKind, matchApplication, nextStatus, parseGmailResults, sampleMailbox, searchSample, senderName,
} = await import('../src/replies.ts');
const { loadDemo } = await import('../src/demo/load.ts');
const { insights } = await import('../src/tracker.ts');
const store = await import('../src/store.ts');

const NOW = new Date('2026-11-21T12:00:00Z');

test('the keyword fallback sorts every sample message the way a person would', () => {
  const want: Record<string, string> = {
    m01: 'interview', m02: 'auto-ack', m03: 'rejected', m04: 'reply', m05: 'rejected', m06: 'interview',
    m07: 'offer', m08: 'reply', m09: 'rejected', m10: 'auto-ack', m11: 'unrelated', m12: 'auto-ack',
  };
  const box = sampleMailbox(NOW);
  assert.equal(box.length, 12);
  for (const m of box) assert.equal(keywordKind(m), want[m.id.replace('sample-', '')], `${m.id}: ${m.subject}`);
});

test('keyword fallback: a rejection that thanks you is still a rejection, a newsletter about interviews is not an invite', () => {
  assert.equal(keywordKind({ from: 'a@b.example', subject: 'Thank you for applying', snippet: 'Unfortunately we will not be moving forward.' }), 'rejected');
  assert.equal(keywordKind({ from: 'digest@x.example', subject: 'Interview tips', snippet: 'Our weekly digest. Unsubscribe here.' }), 'unrelated');
  assert.equal(keywordKind({ from: 'no-reply@x.example', subject: 'Your application', snippet: 'We will be in touch.' }), 'auto-ack');
  assert.equal(keywordKind({ from: 'Sam <sam@x.example>', subject: 'Quick question', snippet: 'Could you share your notice period?' }), 'reply');
});

test('status moves go forward only, and an auto-acknowledgement never moves one', () => {
  assert.equal(nextStatus('applied', 'reply'), 'reply');
  assert.equal(nextStatus('ghosted', 'reply'), 'reply');
  assert.equal(nextStatus('viewed', 'interview'), 'interview');
  assert.equal(nextStatus('reply', 'interview'), 'interview');
  assert.equal(nextStatus('interview', 'reply'), undefined);
  assert.equal(nextStatus('interview', 'rejected'), 'rejected');
  assert.equal(nextStatus('interview', 'offer'), 'offer');
  assert.equal(nextStatus('offer', 'rejected'), undefined);
  assert.equal(nextStatus('rejected', 'interview'), undefined);
  for (const s of ['applied', 'viewed', 'reply', 'ghosted'] as const) {
    assert.equal(nextStatus(s, 'auto-ack'), undefined);
    assert.equal(nextStatus(s, 'unrelated'), undefined);
  }
});

function app(id: string, company: string, status: Application['status'], appliedAt: string): Application {
  return {
    id, title: 'PM', company, url: '', roleFamily: 'core', seniority: 'mid', companySize: 'scaleup', source: 'job-board', fit: 50,
    appliedAt, status, lastEventAt: appliedAt, events: [{ at: appliedAt, kind: 'applied', note: 'sent' }], origin: 'manual',
  };
}
const msg = (id: string, company: string, at: string, subject: string): MailMessage => ({ id, company, at, from: `Recruiter <r@${company.toLowerCase()}.example>`, subject, snippet: '' });

test('messages apply oldest first: an acknowledgement then a rejection ends rejected, with both on the timeline', () => {
  const a = app('a', 'Fernhill', 'viewed', '2026-11-10T09:00:00Z');
  const { changes, touched } = applyMessages([a], [
    { m: msg('2', 'Fernhill', '2026-11-20T09:00:00Z', 'Your application'), kind: 'rejected' },
    { m: msg('1', 'Fernhill', '2026-11-15T09:00:00Z', 'We received your application'), kind: 'auto-ack' },
  ]);
  assert.equal(a.status, 'rejected');
  assert.deepEqual(changes.map((c) => [c.from, c.to, c.subject]), [['viewed', 'rejected', 'Your application']]);
  assert.deepEqual(a.events.map((e) => e.kind), ['applied', 'auto-ack', 'rejected']);
  assert.equal(touched.length, 1);
  assert.equal(a.lastEventAt, '2026-11-20T09:00:00Z');
});

test('an acknowledgement alone leaves the status and the last-heard date alone; unrelated mail leaves no trace', () => {
  const a = app('a', 'Riverstone', 'applied', '2026-11-17T09:00:00Z');
  const { changes } = applyMessages([a], [
    { m: msg('1', 'Riverstone', '2026-11-17T10:00:00Z', 'Thanks for applying'), kind: 'auto-ack' },
    { m: msg('2', 'Riverstone', '2026-11-19T10:00:00Z', 'Weekly digest'), kind: 'unrelated' },
  ]);
  assert.equal(a.status, 'applied');
  assert.equal(changes.length, 0);
  assert.equal(a.lastEventAt, '2026-11-17T09:00:00Z');
  assert.deepEqual(a.events.map((e) => e.kind), ['applied', 'auto-ack']);
});

test('a message goes to the latest application sent before it arrived', () => {
  const old = app('old', 'Acme', 'rejected', '2026-09-01T09:00:00Z');
  const recent = app('new', 'Acme', 'applied', '2026-11-01T09:00:00Z');
  assert.equal(matchApplication([old, recent], 'acme', '2026-11-05T00:00:00Z')?.id, 'new');
  assert.equal(matchApplication([old, recent], 'Acme', '2026-10-01T00:00:00Z')?.id, 'old');
});

test('the model is used when it answers and the keyword rules cover what it leaves out or when it fails', async () => {
  const ms = [msg('1', 'Acme', '2026-11-20T09:00:00Z', 'Interview next week'), msg('2', 'Acme', '2026-11-20T10:00:00Z', 'Unfortunately not')];
  const partial = await classify(ms, (async () => ({ items: [{ id: '1', kind: 'reply' }] })) as never);
  assert.equal(partial.by, 'model');
  assert.equal(partial.kinds.get('1'), 'reply');
  assert.equal(partial.kinds.get('2'), 'rejected');
  const failed = await classify(ms, (async () => { throw new Error('503'); }) as never);
  assert.equal(failed.by, 'rules');
  assert.equal(failed.error, '503');
  assert.equal(failed.kinds.get('1'), 'interview');
});

test('Gmail search results are read from the engine\'s lines, one query per company over 60 days', () => {
  assert.equal(gmailQuery('Acme "Labs"'), '"Acme Labs" newer_than:60d -from:me');
  const text = [
    '1. from Neha <neha@acme.example> — Interview: PM role (Thu, 20 Nov 2026 11:24:00 +0530)',
    '   We would like to set up a call.',
    '2. from Jobs <no-reply@acme.example> — Thanks for applying (Mon, 17 Nov 2026 08:00:00 +0530)',
    '   We received your application.',
  ].join('\n');
  const out = parseGmailResults(text, 'Acme');
  assert.equal(out.length, 2);
  assert.equal(out[0].subject, 'Interview: PM role');
  assert.equal(out[0].snippet, 'We would like to set up a call.');
  assert.equal(out[0].at, '2026-11-20T05:54:00.000Z');
  assert.equal(senderName(out[0].from), 'Neha');
  assert.notEqual(out[0].id, out[1].id);
});

test('the sample search finds a company by name within the last 60 days only', () => {
  const box = sampleMailbox(NOW);
  assert.deepEqual(searchSample(box, 'Fernhill Learning', NOW).map((m) => m.id).sort(), ['sample-m02', 'sample-m03']);
  assert.ok(searchSample(box, 'Lumen Freight', NOW).some((m) => m.id === 'sample-m11'), 'the newsletter names Lumen Freight');
  assert.deepEqual(searchSample(box, 'Nobody Inc', NOW), []);
});

test('Check replies on the demo person moves statuses, logs the subjects, and the insights relearn', async () => {
  await loadDemo();
  const before = insights(store.list<Application>('application'), []).overall;
  const searched: string[] = [];
  const box = sampleMailbox();
  const res = await checkReplies({ source: 'sample', ask: null, concurrency: 4, search: async (c) => { searched.push(c); return searchSample(box, c); } });
  assert.equal(res.source, 'sample');
  assert.equal(res.by, 'rules');
  assert.ok(searched.length >= 10, `searched ${searched.length} companies`);
  const by = new Map(res.changes.map((c) => [c.company, c]));
  assert.equal(by.get('Cobalt Metrics')?.to, 'interview');
  assert.equal(by.get('Quarry Labs')?.to, 'offer');
  assert.equal(by.get('Fernhill Learning')?.to, 'rejected');
  assert.equal(by.get('Hearth Home Finance')?.from, 'ghosted');
  assert.equal(by.get('Hearth Home Finance')?.to, 'reply');
  assert.ok(!by.has('Riverstone Payments'), 'an acknowledgement is not a change');
  assert.ok(!by.has('Sundial Logistics'));
  assert.equal(res.classified.unrelated, 1);
  const lumen = store.list<Application>('application').find((a) => a.company === 'Lumen Freight')!;
  assert.equal(lumen.status, 'interview');
  assert.ok(lumen.events.some((e) => e.note === 'Lumen Freight: next steps – platform team interview'));
  const after = insights(store.list<Application>('application'), []).overall;
  assert.ok(after.responses > before.responses, `${before.responses} -> ${after.responses}`);
  // Nothing new the second time.
  const again = await checkReplies({ source: 'sample', ask: null, search: async (c) => searchSample(box, c) });
  assert.equal(again.messages, 0);
  assert.equal(again.changes.length, 0);
});

test('searches run in parallel up to the limit', async () => {
  await loadDemo();
  let live = 0;
  let peak = 0;
  await checkReplies({
    source: 'sample', ask: null, concurrency: 4,
    search: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; return []; },
  });
  assert.equal(peak, 4);
});
