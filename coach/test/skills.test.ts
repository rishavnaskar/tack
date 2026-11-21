import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGES, CATALOG, PREREQS, canonical, findQuote, skillId } from '../src/skills.ts';

test('aliases resolve to canonical ids', () => {
  const cases: [string, string][] = [
    ['A/B testing', 'experimentation'],
    ['a/b tests', 'experimentation'],
    ['LLM evals', 'llm-evaluation'],
    ['LLM evaluation frameworks', 'llm-evaluation'],
    ['Retrieval (RAG)', 'rag'],
    ['Retrieval-augmented generation', 'rag'],
    ['Product requirements documents', 'prd-writing'],
    ['PRDs', 'prd-writing'],
    ['user interviews', 'user-research'],
    ['REST APIs', 'apis'],
    ['Go-to-market', 'go-to-market'],
    ['GTM', 'go-to-market'],
    ['Monetisation', 'pricing'],
    ['SQL and Python', 'sql'],
    ['Stakeholders', 'stakeholder-management'],
  ];
  for (const [name, id] of cases) assert.equal(skillId(name), id, name);
});

test('canonical ids map to themselves', () => {
  for (const s of CATALOG) {
    assert.equal(skillId(s.id), s.id);
    assert.equal(skillId(s.name), s.id);
    assert.deepEqual(canonical(s.id), { id: s.id, name: s.name, category: s.category });
  }
});

test('generic single words are not matched inside unrelated phrases', () => {
  assert.notEqual(skillId('Computer vision'), 'product-strategy');
  assert.equal(skillId('Computer vision'), 'computer-vision');
});

test('unknown skills get a slug and a guessed category', () => {
  assert.deepEqual(canonical('speech recognition models'), { id: 'speech-recognition-models', name: 'Speech recognition models', category: 'ai' });
  assert.equal(canonical('Warehouse operations').id, 'warehouse-operations');
});

test('PREREQS and BRIDGES only reference known skills and have no cycles', () => {
  const ids = new Set(CATALOG.map((s) => s.id));
  for (const [k, v] of Object.entries(PREREQS)) {
    assert.ok(ids.has(k), k);
    for (const p of v) assert.ok(ids.has(p), `${k} -> ${p}`);
  }
  for (const [k, v] of Object.entries(BRIDGES)) {
    assert.ok(ids.has(k), k);
    for (const f of v.from) assert.ok(ids.has(f), `${k} <- ${f}`);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return;
    assert.notEqual(state.get(id), 'visiting', `cycle: ${[...path, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const p of PREREQS[id] ?? []) visit(p, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of Object.keys(PREREQS)) visit(id, []);
});

test('ids are unique in the catalog', () => {
  assert.equal(new Set(CATALOG.map((s) => s.id)).size, CATALOG.length);
});

test('findQuote returns the exact span and tolerates case, spacing and typographic quotes', () => {
  const text = 'You will own the  evaluation suite:\n8,000 real transcripts. We don’t ship without it.';
  assert.equal(findQuote(text, 'own the evaluation suite'), 'own the  evaluation suite');
  assert.equal(findQuote(text, 'Evaluation Suite: 8,000 real transcripts.'), 'evaluation suite:\n8,000 real transcripts');
  assert.equal(findQuote(text, "We don't ship without it"), 'We don’t ship without it');
  assert.equal(findQuote(text, '"own the evaluation suite ... 8,000 real transcripts"'), 'own the  evaluation suite');
  assert.equal(findQuote(text, 'own the model registry'), undefined);
  assert.equal(findQuote(text, 'a'), undefined);
});
