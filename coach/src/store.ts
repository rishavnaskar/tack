import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Defaults to <repo>/state so the server, scripts and the desktop shell agree whatever the cwd.
export function stateDir(): string {
  const dir = process.env.TACK_STATE_DIR;
  return dir ? resolve(dir) : join(ROOT, 'state');
}

let db: DatabaseSync | undefined;
let stmts: Record<'get' | 'put' | 'list' | 'del' | 'clear', StatementSync> | undefined;

function open() {
  if (stmts) return stmts;
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'tack.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
  `);
  stmts = {
    get: db.prepare('SELECT json FROM docs WHERE kind = ? AND id = ?'),
    // Upsert keeps the original rowid, so list() stays in insertion order.
    put: db.prepare(`INSERT INTO docs (kind, id, json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`),
    list: db.prepare('SELECT json FROM docs WHERE kind = ? ORDER BY rowid'),
    del: db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?'),
    clear: db.prepare('DELETE FROM docs'),
  };
  return stmts;
}

export function get<T>(kind: string, id: string): T | undefined {
  const row = open().get.get(kind, id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as T) : undefined;
}

export function put(kind: string, id: string, value: unknown): void {
  open().put.run(kind, id, JSON.stringify(value), new Date().toISOString());
}

export function list<T>(kind: string): T[] {
  const rows = open().list.all(kind) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as T);
}

export function del(kind: string, id: string): void {
  open().del.run(kind, id);
}

export function clear(): void {
  open().clear.run();
}
