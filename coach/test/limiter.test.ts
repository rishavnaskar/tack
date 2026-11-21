import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const { Budget, laneOf, retryDelayMs, startModelProxy } = await import('../src/limiter.ts');
const { grid } = await import('../src/tile.ts');

// A clock and timer queue the test advances by hand.
function manual() {
  let t = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => { const x = { at: t + ms, fn, live: true }; timers.push(x); return { cancel: () => { x.live = false; } }; },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at;
        next.live = false;
        next.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

test('the budget never sends more than its per-minute limit', async () => {
  const c = manual();
  const b = new Budget({ rpm: () => 3, now: c.now, schedule: c.schedule });
  const got: number[] = [];
  for (let i = 0; i < 7; i++) void b.acquire('x').then(() => got.push(c.now()));
  await c.advance(0);
  assert.equal(got.length, 3);
  await c.advance(59_000);
  assert.equal(got.length, 3);
  await c.advance(2_000);
  assert.equal(got.length, 6);
  await c.advance(60_000);
  assert.equal(got.length, 7);
});

test('lanes take turns: a session with a long queue cannot starve the others', async () => {
  const c = manual();
  const b = new Budget({ rpm: () => 2, now: c.now, schedule: c.schedule });
  const order: string[] = [];
  // Session A asks for six at once, then B and C ask for one each.
  for (let i = 0; i < 6; i++) void b.acquire('tack-a').then(() => order.push('a'));
  void b.acquire('tack-b').then(() => order.push('b'));
  void b.acquire('tack-c').then(() => order.push('c'));
  await c.advance(0);
  await c.advance(61_000);
  await c.advance(61_000);
  assert.deepEqual(order.slice(0, 2), ['a', 'a'], 'the first minute was already A\'s');
  assert.deepEqual(order, ['a', 'a', 'a', 'b', 'c', 'a'], 'B and C each get the next turns, not the end of A\'s backlog');
});

test('a pause from the provider holds every lane, and a waiter whose request went away leaves the queue', async () => {
  const c = manual();
  const waits: number[] = [];
  const b = new Budget({ rpm: () => 10, now: c.now, schedule: c.schedule, onWait: (_l, ms) => waits.push(ms) });
  b.pause(20_000);
  let done = 0;
  void b.acquire('tack-a').then(() => done++);
  const gone = new AbortController();
  const dropped = b.acquire('tack-b', gone.signal).catch((e: Error) => e.message);
  gone.abort();
  assert.equal(await dropped, 'cancelled');
  await c.advance(19_000);
  assert.equal(done, 0);
  await c.advance(2_000);
  assert.equal(done, 1);
  assert.equal(b.queued(), 0);
  assert.ok(waits[0] >= 20_000, 'the wait is reported for the trace');
  assert.ok(b.estimate() >= 0);
});

test('the lane is the session Tack names in the goal', () => {
  assert.equal(laneOf('{"messages":[{"content":"Apply ... Reference for this task: tack-p05-orbitly-ab12."}]}'), 'tack-p05-orbitly-ab12');
  assert.equal(laneOf('{"messages":[]}'), 'engine');
  assert.equal(retryDelayMs(new Headers({ 'retry-after': '7' }), ''), 7000);
  assert.equal(retryDelayMs(new Headers(), '{"error":{"details":[{"retryDelay":"12s"}]}}'), 12_250);
});

test('the pass-through swaps in the real key, refuses strangers, and absorbs one 429 by waiting its turn', async () => {
  let calls = 0;
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls++;
      seen.push(`${req.url} ${req.headers.authorization}`);
      if (calls === 1) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"details":[{"retryDelay":"0.05s"}]}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: body.length > 0 ? 'ok' : 'empty' } }] }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1beta/openai`;
  const proxy = await startModelProxy({ upstream: up, key: 'real-key', budget: new Budget({ rpm: () => 100 }) });
  try {
    const stranger = await fetch(`${proxy.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    assert.equal(stranger.status, 401);
    const res = await fetch(`${proxy.url}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'tack-abc-1234' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content, 'ok');
    assert.equal(calls, 2, 'the 429 was retried inside the pass-through');
    assert.ok(seen.every((s) => s === '/v1beta/openai/chat/completions Bearer real-key'), seen.join('; '));
  } finally {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
});

test('windows go side by side: two across up to four, three across past that', () => {
  const screen = { left: 0, top: 25, width: 1440, height: 875 };
  assert.deepEqual(grid(1, screen), [{ left: 0, top: 25, width: 1440, height: 875 }]);
  assert.deepEqual(grid(2, screen).map((r) => [r.left, r.top, r.width]), [[0, 25, 720], [720, 25, 720]]);
  const five = grid(5, screen);
  assert.equal(five[2].left, 960);
  assert.equal(five[3].top, 25 + 437);
  assert.equal(new Set(grid(3, screen).map((r) => `${r.left},${r.top}`)).size, 3, 'no two windows on the same spot');
});
