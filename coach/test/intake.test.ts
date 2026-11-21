import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { adjacentRoles, finishProfile, pdfText } from '../src/intake.ts';
import { demoProfile } from '../src/demo/load.ts';

function tinyPdf(lines: string[], compress: boolean): Buffer {
  const ops = ['BT', '/F1 11 Tf', '72 720 Td', ...lines.flatMap((l, i) => [i ? '0 -14 Td' : '', `(${l.replace(/([()\\])/g, '\\$1')}) Tj`]).filter(Boolean), 'ET'].join('\n');
  const data = compress ? deflateSync(Buffer.from(ops, 'latin1')) : Buffer.from(ops, 'latin1');
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1');
  return Buffer.concat([head, data, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
}

test('pdfText reads plain and deflated content streams', () => {
  const lines = ['Avery Quinn', 'Senior Backend Engineer (payments)', 'Write SQL daily against Postgres'];
  for (const compress of [false, true]) {
    const text = pdfText(tinyPdf(lines, compress));
    for (const l of lines) assert.ok(text.includes(l), `${compress}: ${l} in ${JSON.stringify(text)}`);
  }
});

test('pdfText reads TJ arrays with kerning gaps', () => {
  const ops = 'BT\n[(Built ) -120 (the) -300 (API)] TJ\nET';
  const pdf = Buffer.from(`%PDF-1.4\n<< /Length ${ops.length} >>\nstream\n${ops}\nendstream\n`, 'latin1');
  assert.equal(pdfText(pdf), 'Built the API');
});

test('finishProfile keeps only skills with verbatim evidence and merges duplicates', () => {
  const resume = 'Backend engineer. Designed the public Payouts API used by 60 merchants. Ran checkout A/B tests with the growth team. '.repeat(3);
  const profile = finishProfile({
    name: ' Avery ', headline: 'Engineer', currentRole: '', yearsExperience: 5.04, summary: 's',
    skills: [
      { name: 'REST APIs', level: 4, evidence: ['Designed the public Payouts API'] },
      { name: 'API design', level: 5, evidence: ['designed the public payouts api used by 60 merchants'] },
      { name: 'A/B testing', level: 2, evidence: ['Ran checkout A/B tests'] },
      { name: 'Product discovery', level: 3, evidence: ['Led discovery for a new product line'] },
      { name: 'Leadership', level: 3, evidence: [] },
    ],
    experience: [{ title: 'Backend Engineer', company: 'Ledgerline', start: '2023', end: 'Present', bullets: ['x'] }],
    education: [], projects: [],
  }, resume, 'text');
  assert.equal(profile.name, 'Avery');
  assert.equal(profile.currentRole, 'Backend Engineer');
  assert.equal(profile.yearsExperience, 5);
  assert.deepEqual(profile.skills.map((s) => [s.id, s.level]), [['apis', 5], ['experimentation', 2]]);
  assert.equal(profile.skills[0].evidence.length, 2);
  assert.ok(profile.skills[0].evidence.every((e) => resume.includes(e)));
});

test('adjacent roles rank by overlap with the profile', () => {
  const roles = adjacentRoles(demoProfile());
  assert.equal(roles.length, 5);
  for (let i = 1; i < roles.length; i++) assert.ok(roles[i - 1].overlap >= roles[i].overlap);
  assert.ok(roles.every((r) => r.overlap >= 0 && r.overlap <= 100 && r.why.length > 10));
  assert.ok(roles[0].overlap > 50);
});
