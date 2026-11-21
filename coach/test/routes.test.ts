import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-routes-'));
process.env.TACK_UI_DIR = mkdtempSync(join(tmpdir(), 'tack-ui-missing-'));
process.env.TACK_SCHEDULER = 'off';
process.env.TACK_ENGINE = 'off';
const { createApp } = await import('../src/server.ts');
const store = await import('../src/store.ts');
const { loadDemo } = await import('../src/demo/load.ts');
const app = createApp();
for (const r of ['a', 'b', 'c', 'd']) (await import(`../src/routes/${r}.ts`)).mount(app.router);
await app.listen(0);
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => app.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, json, text };
};

test('the practice form is there for the demo person and nowhere else', async () => {
  await loadDemo();
  assert.equal((await call('GET', '/practice/apply/p05-orbitly')).status, 200);
  assert.equal((await call('GET', '/api/practice/submissions')).status, 200);
  // A real résumé replaces the demo person.
  const profile = store.get<{ source: string }>('single', 'profile')!;
  store.put('single', 'profile', { ...profile, source: 'pdf' });
  store.del('single', 'mode');
  assert.equal((await call('GET', '/practice/apply/p05-orbitly')).status, 404);
  assert.equal((await call('POST', '/api/practice/apply/p05-orbitly', { name: 'x' })).status, 404);
  assert.equal((await call('GET', '/api/practice/submissions')).status, 404);
  const sample = await call('POST', '/api/apply', { postingIds: ['p05-orbitly'] });
  assert.equal(sample.status, 409, 'a sample posting is never applied to for a real person');
  assert.match(sample.json.error, /not a real opening/);
  const harvest = await call('POST', '/api/postings/harvest', { count: 5 });
  assert.equal(harvest.status, 503, 'no sample postings for a real person');
  store.put('single', 'profile', profile);
  store.put('single', 'mode', 'demo');
});

test('logging an application takes only web addresses and bounded text', async () => {
  assert.equal((await call('POST', '/api/applications', { title: 'PM', company: 'Acme', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', '/api/applications', { title: 'x'.repeat(201), company: 'Acme' })).status, 400);
  assert.equal((await call('POST', '/api/applications', { title: 'PM', company: 42 })).status, 400);
  const ok = await call('POST', '/api/applications', { title: 'PM', company: 'Acme', url: 'https://jobs.example/pm' });
  assert.equal(ok.status, 200);
  assert.equal((await call('PATCH', `/api/applications/${ok.json.id}`, { status: 'reply', note: 'n'.repeat(501) })).status, 400);
  assert.equal((await call('PATCH', `/api/applications/${ok.json.id}`, { status: 'reply', note: 'They wrote back' })).status, 200);
  assert.equal((await call('POST', '/api/plan/replan', { reason: 'r'.repeat(301) })).status, 400);
});

test('autopilot settings are checked, consent is the person\'s switch, and nothing runs in hosted mode', async () => {
  const bad = await call('PUT', '/api/autopilot/settings', { dailyCap: 40 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /1 to 15/);
  const good = await call('PUT', '/api/autopilot/settings', { dailyCap: 4, minFit: 55, excludeCompanies: 'Acme\nBolt' });
  assert.equal(good.status, 200);
  assert.deepEqual(good.json.settings.excludeCompanies, ['Acme', 'Bolt']);
  assert.equal(good.json.settings.needsApproval, false);
  const off = await call('PUT', '/api/consent', { on: false });
  assert.equal(off.json.consent.on, false);
  assert.match(off.json.readiness.reason, /practice form|Submit/);
  assert.equal((await call('PUT', '/api/consent', { on: 'yes' })).status, 400);
  await call('PUT', '/api/consent', { on: true });
  process.env.TACK_HOSTED = '1';
  try {
    assert.equal((await call('POST', '/api/autopilot/run')).status, 409);
    assert.equal((await call('PUT', '/api/autopilot/settings', { on: true })).status, 409);
  } finally {
    delete process.env.TACK_HOSTED;
  }
});

test('a person with nothing set up is told exactly what is missing and cannot switch the autopilot on', async () => {
  store.clear();
  const s = await call('GET', '/api/autopilot');
  assert.equal(s.json.readiness.ready, false);
  assert.deepEqual(s.json.readiness.missing.map((m: { key: string }) => m.key).slice(0, 4), ['profile', 'goal', 'details', 'resume']);
  const on = await call('PUT', '/api/autopilot/settings', { on: true });
  assert.equal(on.status, 409);
  assert.match(on.json.error, /résumé/);
  assert.equal((await call('POST', '/api/autopilot/run')).status, 409);
});
