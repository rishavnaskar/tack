import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentVisitor, isHosted, limits, onDrop, onTick } from './hosted.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Defaults to <repo>/state so the server, scripts and the desktop shell agree whatever the cwd.
// Hosted mode defaults to /tmp/tack, which a container can always write.
export function stateDir(): string {
  const dir = process.env.TACK_STATE_DIR;
  if (dir) return resolve(dir);
  return isHosted() ? '/tmp/tack' : join(ROOT, 'state');
}

type Stmts = Record<'get' | 'put' | 'list' | 'del' | 'clear', StatementSync>;
interface Handle { db: DatabaseSync; stmts: Stmts; used: number }

function openFile(file: string, pragmas: string): Handle {
  const db = new DatabaseSync(file);
  db.exec(`
    ${pragmas}
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
  `);
  return {
    db,
    used: Date.now(),
    stmts: {
      get: db.prepare('SELECT json FROM docs WHERE kind = ? AND id = ?'),
      // Upsert keeps the original rowid, so list() stays in insertion order.
      put: db.prepare(`INSERT INTO docs (kind, id, json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`),
      list: db.prepare('SELECT json FROM docs WHERE kind = ? ORDER BY rowid'),
      del: db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?'),
      clear: db.prepare('DELETE FROM docs'),
    },
  };
}

// ---------------------------------------------------------------- one person (desktop, local)

let single: Handle | undefined;

function local(): Handle {
  if (single) return single;
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  single = openFile(join(dir, 'tack.db'), 'PRAGMA journal_mode = WAL;');
  return single;
}

// ---------------------------------------------------------------- one file per visitor (hosted)

const MAX_OPEN = 128;
const pool = new Map<string, Handle>();

export function sessionsDir(): string {
  return join(stateDir(), 'sessions');
}

const fileOf = (key: string) => join(sessionsDir(), `${key}.db`);

function close(key: string): void {
  const h = pool.get(key);
  if (!h) return;
  pool.delete(key);
  try { h.db.close(); } catch { /* already closed */ }
}

function remove(key: string): void {
  close(key);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${fileOf(key)}${suffix}`, { force: true });
}

// A visitor's file is created on the first write; reads before that see an empty store.
function scoped(create: boolean): Handle | null {
  const v = currentVisitor();
  // Fail closed: in hosted mode nothing reads or writes outside a visitor's session.
  if (!v) throw new Error('store used outside a visitor session');
  if (v.dropped) throw new Error('this session has ended');
  let h = pool.get(v.key);
  if (!h) {
    const file = fileOf(v.key);
    if (!create && !existsSync(file)) return null;
    if (pool.size >= MAX_OPEN) {
      const oldest = [...pool.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest) close(oldest[0]);
    }
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    h = openFile(file, 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    pool.set(v.key, h);
    v.hasData = true;
  }
  h.used = Date.now();
  return h;
}

function handle(create: boolean): Handle | null {
  return isHosted() ? scoped(create) : local();
}

onDrop((key) => remove(key));
onTick((now) => {
  const idle = limits().idleCloseMs;
  for (const [key, h] of [...pool.entries()]) if (now - h.used > idle) close(key);
});

/** Session files already on disk (a restart with a kept state dir): their keys and last change. */
export function sessionFiles(): { key: string; at: number }[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: { key: string; at: number }[] = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^([0-9a-f]{32})\.db$/);
    if (!m) continue;
    let at = statSync(join(dir, name)).mtimeMs;
    for (const extra of ['-wal']) {
      const f = join(dir, `${name}${extra}`);
      if (existsSync(f)) at = Math.max(at, statSync(f).mtimeMs);
    }
    out.push({ key: m[1], at });
  }
  return out;
}

/** Deletes a session's file outright; used for files older than the session lifetime at start. */
export function removeSession(key: string): void {
  if (/^[0-9a-f]{32}$/.test(key)) remove(key);
}

export function openSessions(): number {
  return pool.size;
}

/** Closes every open database: on shutdown. */
export function closeAll(): void {
  for (const key of [...pool.keys()]) close(key);
  if (single) {
    try { single.db.close(); } catch { /* already closed */ }
    single = undefined;
  }
}

// ---------------------------------------------------------------- the API every module uses

export function get<T>(kind: string, id: string): T | undefined {
  const h = handle(false);
  const row = h?.stmts.get.get(kind, id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as T) : undefined;
}

export function put(kind: string, id: string, value: unknown): void {
  handle(true)!.stmts.put.run(kind, id, JSON.stringify(value), new Date().toISOString());
}

export function list<T>(kind: string): T[] {
  const h = handle(false);
  if (!h) return [];
  const rows = h.stmts.list.all(kind) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as T);
}

export function del(kind: string, id: string): void {
  handle(false)?.stmts.del.run(kind, id);
}

export function clear(): void {
  handle(false)?.stmts.clear.run();
}
