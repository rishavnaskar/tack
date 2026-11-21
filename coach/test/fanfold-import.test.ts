import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-import-'));
const store = await import('../src/store.ts');
const imp = await import('../src/fanfold-import.ts');
const apply = await import('../src/apply.ts');
const queue = await import('../src/apply-queue.ts');

// An invented person; none of this is anyone's real data.
const RESUME = [
  'MIRA CASTELL',
  'Pune, India | mira.castell@mail.example',
  'EXPERIENCE',
  'Lumen Labs\tJan 2024 – Present',
  'Applied AI Engineer\tPune, India',
  '• Built a retrieval service in Python that answers support questions from 40k help articles.',
  '• Shipped an evaluation harness for LLM prompts used by four product teams.',
  'Northwind\tJun 2021 – Dec 2023',
  'Backend Engineer\tPune, India',
  '• Ran PostgreSQL migrations for a payments ledger without downtime.',
].join('\n');

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanfold-fixture-'));
  const docDir = join(dir, 'documents', 'doc-1');
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, 'Mira_Castell_CV.pdf'), Buffer.from('%PDF-1.4\n% invented fixture\n'));
  const db = new DatabaseSync(join(dir, 'agent.db'));
  db.exec(`
    CREATE TABLE profile_facts (field TEXT PRIMARY KEY, value TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, source TEXT, basis TEXT);
    CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, question_norm TEXT NOT NULL UNIQUE, answer TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'you', used_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, job_id TEXT, updated_at TEXT, intent_key TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_path TEXT, file_path TEXT, file_sha256 TEXT, mime TEXT, added_at TEXT NOT NULL, bytes INTEGER, imported_by TEXT, held_why TEXT, trusted INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'file', ignored_lines INTEGER);
    CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, token_estimate INTEGER NOT NULL);
    CREATE TABLE career_records (document_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, record TEXT NOT NULL, model TEXT, built_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const fact = db.prepare('INSERT INTO profile_facts (field, value, confirmed, updated_at, source) VALUES (?, ?, ?, ?, ?)');
  for (const [k, v, c] of [
    ['name', 'Mira Castell', 1], ['email', 'mira.castell@mail.example', 1], ['phone', '+91 90000 11111', 1], ['location', 'Pune, India', 1],
    ['linkedin', 'linkedin.com/in/mira-castell-example', 1], ['noticePeriod', '30 days', 1], ['yearsExperience', '4', 1],
    ['github', 'github.com/mira-example', 1], ['salaryExpectation', '40 LPA', 0], ['favouriteColour', 'teal', 1],
  ] as const) fact.run(k, v, c, '2026-11-01T00:00:00Z', 'you');
  const ans = db.prepare('INSERT INTO answers (question, question_norm, answer, source, created_at) VALUES (?, ?, ?, ?, ?)');
  ans.run('Will you now or in the future require visa sponsorship?', 'sponsorship', 'No', 'you', '2026-11-01T00:00:00Z');
  ans.run('Are you legally authorized to work in India?', 'authorized india', 'Yes', 'agent', '2026-11-01T00:00:00Z');
  ans.run('What is your expected CTC?', 'expected ctc', '45', 'review', '2026-11-01T00:00:00Z');
  db.prepare('INSERT INTO documents (id, title, file_path, mime, added_at) VALUES (?, ?, ?, ?, ?)')
    .run('doc-1', 'Mira_Castell_CV.pdf', join(docDir, 'Mira_Castell_CV.pdf'), 'application/pdf', '2026-11-01T00:00:00Z');
  db.prepare('INSERT INTO chunks (id, document_id, idx, text, token_estimate) VALUES (?, ?, ?, ?, ?)').run('c1', 'doc-1', 0, RESUME, 100);
  const record = {
    roles: [
      { employer: 'Lumen Labs', title: 'Applied AI Engineer', start: { y: 2024, m: 1 }, end: 'present', skills: [] },
      { employer: 'Northwind', title: 'Backend Engineer', start: { y: 2021, m: 6 }, end: { y: 2023, m: 12 }, skills: [{ name: 'postgresql', quote: 'Ran PostgreSQL migrations for a payments ledger without downtime' }] },
    ],
    education: [{ institution: 'Example Institute', degree: 'B.E.', field: 'Computer Engineering', start: { y: 2017 }, end: { y: 2021 } }],
    skills: [
      { name: 'python', quote: 'Built a retrieval service in Python that answers support questions' },
      { name: 'llm evaluation', quote: 'Shipped an evaluation harness for LLM prompts used by four product teams' },
      { name: 'kubernetes', quote: 'Operated Kubernetes clusters across three regions' },
    ],
  };
  db.prepare('INSERT INTO career_records (document_id, sha256, record, built_at) VALUES (?, ?, ?, ?)').run('doc-1', 'x', JSON.stringify(record), '2026-11-01T00:00:00Z');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('profile.resumeDocumentId', 'doc-1');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('profile.workRights', JSON.stringify({
    entries: [
      { country: 'India', status: 'other', note: 'Authorised to work in India', confirmed: false, source: 'earlier' },
      { country: 'Germany', status: 'visa', note: 'Blue Card', confirmed: false, source: 'agent' },
    ],
  }));
  db.close();
  return dir;
}

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('reads confirmed facts and the person\'s own answers, and leaves the Fanfold database as it was', () => {
  const dir = fixture();
  const before = sha(join(dir, 'agent.db'));
  const data = imp.readFanfold(dir);
  assert.equal(data.facts.name, 'Mira Castell');
  assert.equal(data.facts.salaryExpectation, undefined, 'an unconfirmed fact is not imported');
  assert.equal(data.facts.favouriteColour, undefined, 'a field Tack has no use for is not imported');
  assert.deepEqual(data.answers.map((a) => a.answer), ['No']);
  assert.equal(data.unchecked, 2, 'answers an agent wrote or that wait for review are left out');
  assert.ok(data.resume?.bytes.subarray(0, 5).toString() === '%PDF-');
  assert.equal(sha(join(dir, 'agent.db')), before);
});

test('maps to Tack: details, work authorisation in the person\'s words, skills only with quotes the résumé holds', () => {
  const t = imp.toTack(imp.readFanfold(fixture()));
  assert.equal(t.details.fullName, 'Mira Castell');
  assert.equal(t.details.city, 'Pune, India');
  assert.equal(t.details.linkedin, 'https://linkedin.com/in/mira-castell-example');
  assert.equal(t.details.workAuthorisation, 'India: Authorised to work in India', 'an agent\'s entry is not used');
  assert.equal(t.details.noticePeriod, '30 days');
  assert.equal(t.profile.currentRole, 'Applied AI Engineer');
  assert.equal(t.profile.yearsExperience, 4);
  assert.deepEqual(t.profile.experience.map((r) => `${r.company} ${r.start}-${r.end}`), ['Lumen Labs Jan 2024-Present', 'Northwind Jun 2021-Dec 2023']);
  const ids = t.profile.skills.map((s) => s.name.toLowerCase());
  assert.ok(ids.some((n) => n.includes('python')));
  assert.ok(t.profile.skills.some((s) => s.evidence.some((e) => e.includes('PostgreSQL migrations'))), 'a role\'s own skill quote counts');
  assert.ok(!ids.some((n) => n.includes('kubernetes')), 'a quote not in the résumé drops its skill');
  assert.match(t.profile.education[0], /B\.E\. in Computer Engineering, Example Institute \(2017–2021\)/);
  assert.equal(t.facts.github, 'github.com/mira-example');
  assert.equal(t.facts.workAuthorisation, 'India: Authorised to work in India');
  assert.ok(t.resume?.base64);
  assert.deepEqual(t.warnings, []);
});

test('with no work authorisation of the person\'s own, it stays blank and says so', () => {
  const data = imp.readFanfold(fixture());
  data.workRights = data.workRights.filter((r) => r.source === 'agent');
  const t = imp.toTack(data);
  assert.equal(t.details.workAuthorisation, '');
  assert.ok(t.warnings.some((w) => /work authorisation/.test(w)));
});

test('import writes the profile, details, résumé, engine facts and answers into Tack, and reports no values', async () => {
  store.clear();
  store.put('single', 'mode', 'demo');
  const s = await imp.importFanfold(fixture());
  assert.equal(apply.getDetails()?.email, 'mira.castell@mail.example');
  assert.equal(store.get<{ name: string }>('single', 'profile')?.name, 'Mira Castell');
  assert.equal(apply.getResume()?.filename, 'Mira_Castell_CV.pdf');
  assert.equal(store.get<Record<string, string>>('single', apply.ENGINE_FACTS)?.noticePeriod, '30 days');
  assert.deepEqual(queue.rememberedAnswers().map((a) => a.answer), ['No']);
  assert.equal(store.get('single', 'mode'), undefined, 'the demo mode is left behind');
  assert.equal(apply.readiness().ready, true);
  const printed = JSON.stringify(s);
  for (const secret of ['mira.castell@mail.example', '90000', 'Pune']) assert.ok(!printed.includes(secret), `summary leaks ${secret}`);
});

test('a directory with no Fanfold database is a plain error', () => {
  assert.throws(() => imp.readFanfold(mkdtempSync(join(tmpdir(), 'empty-'))), imp.ImportError);
});
