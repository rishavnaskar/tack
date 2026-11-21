import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'tack-mcp-'));
process.env.TACK_STATE_DIR = dir;
const { loadDemo, demoProfile } = await import('../src/demo/load.ts');
await loadDemo();

// No model key and no engine: every answer comes from the store and the built-in rules.
const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../bin/mcp.ts', import.meta.url))], {
  env: { ...process.env, TACK_STATE_DIR: dir, TACK_ENGINE: 'off', TACK_MODEL_KEY: '', GEMINI_API_KEY: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
after(() => { child.stdin.end(); child.kill(); });

const waiting = new Map<number, (msg: any) => void>();
createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  waiting.get(msg.id)?.(msg);
  waiting.delete(msg.id);
});

let seq = 0;
function request(method: string, params?: object): Promise<any> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}; stderr: ${stderr}`)), 20_000);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
  });
}

test('initialize, tools/list and two tool calls over stdio', async () => {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'tack');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await request('tools/list');
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, ['tack_state', 'tack_gap', 'tack_plan_week', 'tack_complete_task', 'tack_next_applications',
    'tack_prepare_application', 'tack_interview_question', 'tack_interview_answer']);
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description && t.title, t.name);
  }

  const gap = await request('tools/call', { name: 'tack_gap', arguments: { limit: 3 } });
  assert.equal(gap.result.isError, false);
  const gapText: string = gap.result.content[0].text;
  assert.match(gapText, /^Readiness \d+\/100 from 40 postings\. Top 3 open skills by priority:/);
  assert.equal((gapText.match(/^\d\. /gm) ?? []).length, 3);

  const kit = await request('tools/call', { name: 'tack_prepare_application', arguments: { postingId: 'p05-orbitly' } });
  assert.equal(kit.result.isError, false);
  const kitText: string = kit.result.content[0].text;
  assert.match(kitText, /^Application kit: .+ at Orbitly \(fit \d+\)/);
  for (const head of ['Headline', 'Résumé bullets', 'Cover note', 'Talking points', 'Gaps to address', 'Questions to ask']) {
    assert.ok(kitText.includes(`\n${head}\n`), head);
  }
  // Without a model every bullet is a profile line, at most capitalised.
  const profile = demoProfile();
  const own = [...profile.experience.flatMap((r) => r.bullets), ...profile.skills.flatMap((s) => s.evidence)].map((l) => l.toLowerCase());
  const bullets = [...kitText.matchAll(/^- (.+)\n {2}from your résumé(?:, word for word|: "(.+)")$/gm)].map((m) => m[2] ?? m[1]);
  assert.ok(bullets.length >= 3, kitText);
  for (const b of bullets) assert.ok(own.includes(b.toLowerCase()), b);
});

test('older protocol versions are answered in kind, errors stay inside the result', async () => {
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  const list = await request('tools/list');
  assert.equal(list.result.tools[0].title, undefined);
  assert.deepEqual(await request('ping'), { jsonrpc: '2.0', id: seq, result: {} });

  const bad = await request('tools/call', { name: 'tack_complete_task', arguments: { taskId: 'nope' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /No task nope/);
  assert.equal((await request('tools/call', { name: 'tack_nothing' })).error.code, -32602);
  assert.equal((await request('resources/list')).error.code, -32601);
});
