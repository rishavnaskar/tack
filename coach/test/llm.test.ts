import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tack-llm-'));
Object.assign(process.env, {
  TACK_STATE_DIR: dir,
  TACK_MODEL_KEY: 'test-key',
  TACK_MODEL_URL: 'http://model.test/v1/chat/completions',
  TACK_MODEL_FAST: 'test-fast',
  TACK_MODEL_BACKOFF_MS: '1',
  TACK_MODEL_RPM: '1000',
});
const { json, repairJson, conform, configured, modelName, LlmError } = await import('../src/llm.ts');
const { subscribe } = await import('../src/trace.ts');

type Call = { url: string; body: any };
let calls: Call[] = [];
let replies: (() => Response)[] = [];

function reply(content: string, status = 200, headers: Record<string, string> = {}) {
  return () => new Response(status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : content, { status, headers });
}

globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
  const next = replies.shift();
  if (!next) throw new Error('unexpected fetch');
  return next();
}) as typeof fetch;

beforeEach(() => { calls = []; replies = []; });

const schema = {
  type: 'object',
  properties: { role: { type: 'string' }, overlap: { type: 'integer' }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
  required: ['role', 'overlap'],
};

test('configured and model name come from env', () => {
  assert.equal(configured(), true);
  assert.equal(modelName(), 'test-fast');
});

test('repairJson handles fences, prose, trailing commas and truncation', () => {
  assert.deepEqual(repairJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(repairJson('Here you go: {"a": [1, 2,],} thanks'), { a: [1, 2] });
  assert.deepEqual(repairJson('{"items": [{"n": 1}, {"n": 2}, {"n": 3, "text": "cut off here'), { items: [{ n: 1 }, { n: 2 }] });
  assert.deepEqual(repairJson('{"a": {"b": [1, 2'), { a: { b: [1, 2] } });
  assert.throws(() => repairJson('no json at all'));
});

test('conform coerces harmless mismatches and reports real ones', () => {
  const errors: string[] = [];
  const v = conform({ role: 'PM', overlap: '72.4', tags: ['A', 'b'] }, schema, '$', errors) as any;
  assert.deepEqual(errors, []);
  assert.deepEqual(v, { role: 'PM', overlap: 72, tags: ['a', 'b'] });
  const bad: string[] = [];
  conform({ overlap: 'lots', tags: ['z'] }, schema, '$', bad);
  assert.equal(bad.length, 3);
});

test('a successful call is cached on disk and the second call skips the network', async () => {
  const events: string[] = [];
  const off = subscribe((e) => events.push(`${e.step}:${e.detail}`));
  replies.push(reply('{"role": "Technical PM", "overlap": 70}'));
  const opts = { task: 'roles', system: 'sys', prompt: 'cache me', schema };
  assert.deepEqual(await json(opts), { role: 'Technical PM', overlap: 70 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'test-fast');
  assert.equal(calls[0].body.response_format.type, 'json_schema');
  assert.deepEqual(calls[0].body.response_format.json_schema.schema, schema);
  assert.deepEqual(await json(opts), { role: 'Technical PM', overlap: 70 });
  assert.equal(calls.length, 1);
  assert.equal(readdirSync(join(dir, 'llm-cache')).length, 1);
  assert.ok(events.some((e) => e === 'roles:test-fast cached'));
  off();
});

test('429 and 5xx are retried with backoff', async () => {
  replies.push(reply('{"error": "rate"}', 429, { 'retry-after': '0' }), reply('oops', 503), reply('{"role": "PM", "overlap": 1}'));
  assert.deepEqual(await json({ task: 't', system: 's', prompt: 'retry me', schema }), { role: 'PM', overlap: 1 });
  assert.equal(calls.length, 3);
});

test('a reply that fails the schema gets one corrective round trip', async () => {
  replies.push(reply('{"role": "PM"}'), reply('{"role": "PM", "overlap": 55}'));
  assert.deepEqual(await json({ task: 't', system: 's', prompt: 'fix me', schema }), { role: 'PM', overlap: 55 });
  assert.equal(calls.length, 2);
  const followUp = calls[1].body.messages.at(-1).content as string;
  assert.match(followUp, /overlap is required/);
});

test('client errors are not retried and surface as LlmError', async () => {
  replies.push(reply('bad request', 401));
  await assert.rejects(json({ task: 't', system: 's', prompt: 'fail me', schema }), (err: unknown) => err instanceof LlmError && err.status === 401);
  assert.equal(calls.length, 1);
});

test('PDF input is sent as a file part, then as a data URL if the first form is rejected', async () => {
  replies.push(reply('unsupported part', 400), reply('{"role": "PM", "overlap": 3}'));
  const out = await json({ task: 't', system: 's', prompt: 'read the pdf', schema, pdfBase64: 'JVBERi0=' });
  assert.deepEqual(out, { role: 'PM', overlap: 3 });
  assert.equal(calls[0].body.messages[1].content[1].type, 'file');
  assert.equal(calls[1].body.messages[1].content[1].type, 'image_url');
});

// Last in this file: the refusal below leaves the shared budget paused for a minute.
test('with a wait cap, a long refusal fails at once, and later calls fail before queueing', async () => {
  process.env.TACK_MODEL_MAX_WAIT_MS = '5000';
  try {
    const t0 = Date.now();
    replies.push(reply('{"error": "quota"}', 429, { 'retry-after': '3600' }));
    await assert.rejects(json({ task: 't', system: 's', prompt: 'quota one', schema }), (err: unknown) => err instanceof LlmError && err.status === 429 && /asks to wait 3600 s/.test(err.message));
    await assert.rejects(json({ task: 't', system: 's', prompt: 'quota two', schema }), (err: unknown) => err instanceof LlmError && err.status === 429 && /rate limited for another 3\d{3} s/.test(err.message));
    assert.equal(calls.length, 1);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    delete process.env.TACK_MODEL_MAX_WAIT_MS;
  }
});
