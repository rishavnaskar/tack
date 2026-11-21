// Session lifecycle in hosted mode: lazy files, idle close, 24 h expiry, the cap, the model budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env.TACK_HOSTED = '1';
process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-sessions-'));
process.env.TACK_MAX_SESSIONS = '3';
process.env.TACK_BUDGET_SESSION_HOUR = '2';
process.env.TACK_BUDGET_SESSION_DAY = '3';
process.env.TACK_BUDGET_GLOBAL_HOUR = '5';
const hosted = await import('../src/hosted.ts');
const store = await import('../src/store.ts');
const trace = await import('../src/trace.ts');

function request(cookie?: string): { req: IncomingMessage; res: ServerResponse; cookies: string[] } {
  const cookies: string[] = [];
  const req = { headers: cookie ? { cookie } : {}, socket: { remoteAddress: '203.0.113.9' } } as unknown as IncomingMessage;
  const res = { appendHeader: (_: string, v: string) => { cookies.push(v); } } as unknown as ServerResponse;
  return { req, res, cookies };
}

function visit(now: number, cookie?: string) {
  const r = request(cookie);
  const v = hosted.visitorFor(r.req, r.res, '203.0.113.9', false, now);
  return { v, cookie: r.cookies[0]?.split(';')[0] ?? cookie };
}

const fileOf = (key: string) => join(store.sessionsDir(), `${key}.db`);

test('a session gets its file on the first write, not on reads', () => {
  hosted.resetForTests();
  const { v } = visit(Date.now());
  hosted.runAs(v, () => {
    assert.equal(store.get('single', 'profile'), undefined);
    assert.deepEqual(store.list('posting'), []);
  });
  assert.equal(existsSync(fileOf(v.key)), false);
  hosted.runAs(v, () => store.put('single', 'goal', { targetRole: 'x' }));
  assert.equal(existsSync(fileOf(v.key)), true);
  assert.equal(v.hasData, true);
});

test('the store and the trace refuse to work outside a session', () => {
  assert.throws(() => store.get('single', 'profile'), /outside a visitor session/);
  assert.throws(() => store.put('single', 'profile', {}), /outside a visitor session/);
  assert.deepEqual(trace.recent(), []);
  trace.emit({ run: 'stray', step: 'x', detail: 'nobody', status: 'ok' });
  const { v } = visit(Date.now());
  hosted.runAs(v, () => assert.deepEqual(trace.recent(), []));
});

test('the same signed cookie finds the same session; a tampered one does not', () => {
  hosted.resetForTests();
  const now = Date.now();
  const first = visit(now);
  const again = visit(now + 1000, first.cookie);
  assert.equal(again.v, first.v);
  const tampered = `${first.cookie!.slice(0, -2)}xx`;
  assert.notEqual(visit(now + 2000, tampered).v, first.v);
});

test('idle databases close, and sessions idle for 24 hours are deleted with their file and trace', () => {
  hosted.resetForTests();
  const now = Date.now();
  const { v } = visit(now);
  hosted.runAs(v, () => {
    store.put('single', 'profile', { name: 'Kept' });
    trace.emit({ run: 'mine', step: 'x', detail: '', status: 'ok' });
  });
  assert.equal(store.openSessions() >= 1, true);
  hosted.sweep(now + 11 * 60_000);
  assert.equal(store.openSessions(), 0);
  assert.equal(existsSync(fileOf(v.key)), true);
  // Reopened lazily with its data intact.
  hosted.runAs(v, () => assert.deepEqual(store.get('single', 'profile'), { name: 'Kept' }));
  hosted.sweep(now + 25 * 3_600_000);
  assert.equal(existsSync(fileOf(v.key)), false);
  assert.equal(hosted.sessionCount(), 0);
  assert.equal(v.dropped, true);
});

test('past the cap the oldest idle session is evicted, empty ones first, busy ones never', () => {
  hosted.resetForTests();
  const now = Date.now();
  const a = visit(now).v;
  hosted.runAs(a, () => store.put('single', 'goal', { n: 'a' }));
  const b = visit(now + 1).v;
  hosted.runAs(b, () => store.put('single', 'goal', { n: 'b' }));
  const empty = visit(now + 2).v;
  // Fourth visitor: the empty session goes before either one with data.
  const d = visit(now + 3).v;
  hosted.runAs(d, () => store.put('single', 'goal', { n: 'd' }));
  assert.equal(empty.dropped, true);
  assert.equal(a.dropped, false);
  // Fifth: a is busy, so b (the oldest idle one with data) goes.
  a.inflight = 1;
  visit(now + 4);
  assert.equal(b.dropped, true);
  assert.equal(existsSync(fileOf(b.key)), false);
  assert.equal(existsSync(fileOf(a.key)), true);
  a.inflight = 0;
});

test('the model budget counts per session and for the whole preview', () => {
  hosted.resetForTests();
  const now = Date.now();
  const one = visit(now).v;
  const two = visit(now).v;
  hosted.runAs(one, () => {
    hosted.chargeModelCall(now);
    hosted.chargeModelCall(now + 1);
    assert.throws(() => hosted.chargeModelCall(now + 2), (e: any) => e instanceof hosted.BudgetError && e.scope === 'session' && /hourly limit/.test(e.message));
    assert.ok(hosted.budgetHit());
    // An hour later the hourly allowance is back, then the daily one runs out.
    hosted.chargeModelCall(now + 3_600_001);
    assert.throws(() => hosted.chargeModelCall(now + 3_600_002), /daily limit/);
  });
  hosted.resetForTests();
  // Five calls an hour for the whole preview, two per visitor: the third visitor's second call is refused.
  const later = now + 10 * 3_600_000;
  const [x, y, z] = [visit(later).v, visit(later).v, visit(later).v];
  hosted.runAs(x, () => { hosted.chargeModelCall(later); hosted.chargeModelCall(later + 1); });
  hosted.runAs(y, () => { hosted.chargeModelCall(later + 2); hosted.chargeModelCall(later + 3); });
  hosted.runAs(z, () => {
    hosted.chargeModelCall(later + 4);
    assert.throws(() => hosted.chargeModelCall(later + 5), (e: any) => e.scope === 'preview' && /has reached its (hourly|daily) limit/.test(e.message));
  });
  void two;
});
