import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.TACK_UI_DIR = mkdtempSync(join(tmpdir(), 'tack-ui-missing-'));
const { createApp, HttpError } = await import('../src/server.ts');

const app = createApp();
app.router.get('/things/:id', ({ params, query }) => ({ id: params.id, q: query.get('q') }));
app.router.post('/api/things', ({ body }) => ({ got: body }));
app.router.get('/boom', () => { throw new HttpError(409, 'already there'); });
app.router.get('/crash', () => { throw new Error('bug'); });
app.router.put('/empty', () => undefined);
await app.listen(0);
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => app.close());

test('routes match :params and both path styles', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/things/a%20b?q=1`)).json(), { id: 'a b', q: '1' });
  const res = await fetch(`${base}/api/things`, { method: 'POST', body: JSON.stringify({ x: 1 }), headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await res.json(), { got: { x: 1 } });
});

test('errors come back as {error} with the right status', async () => {
  const conflict = await fetch(`${base}/api/boom`);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'already there' });
  const original = console.error;
  console.error = () => {};
  const crash = await fetch(`${base}/api/crash`);
  console.error = original;
  assert.equal(crash.status, 500);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/things`)).status, 405);
  const bad = await fetch(`${base}/api/things`, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/empty`, { method: 'PUT' })).status, 204);
});

test('without a built UI, / answers with a one-line message', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /UI is not built/);
});
