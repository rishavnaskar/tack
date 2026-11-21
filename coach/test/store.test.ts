import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-store-'));
const store = await import('../src/store.ts');

test('put and get round-trip JSON documents', () => {
  store.put('single', 'goal', { targetRole: 'AI Product Manager', weeks: 12 });
  assert.deepEqual(store.get('single', 'goal'), { targetRole: 'AI Product Manager', weeks: 12 });
  assert.equal(store.get('single', 'missing'), undefined);
});

test('list keeps insertion order across updates', () => {
  store.put('posting', 'b', { id: 'b' });
  store.put('posting', 'a', { id: 'a' });
  store.put('posting', 'c', { id: 'c' });
  store.put('posting', 'b', { id: 'b', fit: 40 });
  assert.deepEqual(store.list<{ id: string }>('posting').map((p) => p.id), ['b', 'a', 'c']);
  assert.equal(store.get<{ fit: number }>('posting', 'b')?.fit, 40);
});

test('kinds are separate and del removes one document', () => {
  store.put('application', 'b', { id: 'other kind' });
  store.del('posting', 'a');
  assert.deepEqual(store.list<{ id: string }>('posting').map((p) => p.id), ['b', 'c']);
  assert.equal(store.list('application').length, 1);
});

test('clear empties every kind', () => {
  store.clear();
  assert.equal(store.list('posting').length, 0);
  assert.equal(store.get('single', 'goal'), undefined);
});
