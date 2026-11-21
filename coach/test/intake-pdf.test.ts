import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, {
  TACK_STATE_DIR: mkdtempSync(join(tmpdir(), 'tack-intake-')),
  TACK_MODEL_KEY: 'test-key',
  TACK_MODEL_URL: 'http://model.test/v1/chat/completions',
  TACK_MODEL_BACKOFF_MS: '1',
  TACK_MODEL_RPM: '1000',
  TACK_ENGINE: 'off',
});
const { parseResume } = await import('../src/intake.ts');
const { subscribe } = await import('../src/trace.ts');

const lines = [
  'Avery Quinn, Backend Engineer, Bengaluru',
  'Designed the public Payouts API used by 60 merchant integrations',
  'Write SQL daily against Postgres to investigate payout failures',
  'Built the experiment assignment service for checkout A/B tests',
  'Led the reconciliation rewrite across finance and operations teams',
];
const ops = ['BT', '72 720 Td', ...lines.flatMap((l, i) => [i ? '0 -14 Td' : '', `(${l}) Tj`]).filter(Boolean), 'ET'].join('\n');
const pdf = Buffer.from(`%PDF-1.4\n<< /Length ${ops.length} >>\nstream\n${ops}\nendstream\n%%EOF\n`, 'latin1');

test('when the endpoint rejects the PDF, intake falls back to extracted text and says so', async () => {
  const bodies: any[] = [];
  const replies = [
    new Response('file parts not supported', { status: 400 }),
    new Response('image_url pdf not supported', { status: 400 }),
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      name: 'Avery Quinn', headline: 'Backend engineer', currentRole: 'Backend Engineer', yearsExperience: 5, summary: 'x',
      skills: [
        { name: 'APIs', level: 5, evidence: ['Designed the public Payouts API used by 60 merchant integrations'] },
        { name: 'SQL', level: 4, evidence: ['Write SQL daily against Postgres'] },
        { name: 'Kubernetes', level: 4, evidence: ['Ran the Kubernetes platform'] },
      ],
      experience: [], education: [], projects: [],
    }) } }] }), { status: 200 }),
  ];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return replies.shift()!;
  }) as typeof fetch;
  const steps: string[] = [];
  const off = subscribe((e) => { if (e.run === 'intake') steps.push(e.detail); });

  const profile = await parseResume({ pdfBase64: pdf.toString('base64'), filename: 'cv.pdf' });
  off();
  assert.equal(bodies.length, 3);
  assert.equal(typeof bodies[2].messages[1].content, 'string');
  assert.match(bodies[2].messages[1].content, /Write SQL daily against Postgres/);
  assert.ok(steps.some((d) => /rejected the PDF; using text extracted/.test(d)), steps.join(' | '));
  assert.equal(profile.source, 'pdf');
  assert.deepEqual(profile.skills.map((s) => s.id), ['apis', 'sql']);
});

test('text that is not a PDF is refused before any model call', async () => {
  globalThis.fetch = (() => { throw new Error('should not be called'); }) as typeof fetch;
  await assert.rejects(parseResume({ pdfBase64: Buffer.from('hello').toString('base64') }), /not a PDF/);
});
