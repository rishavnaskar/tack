/**
 * Where the bridge keeps the little it has to remember across restarts.
 *
 * An interface rather than a table of its own so the bridge can be tested
 * without a database, and so the app decides where pairing lives.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export class MemoryKeyValueStore implements KeyValueStore {
  #values = new Map<string, string>();

  get(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.#values.set(key, value);
  }

  delete(key: string): void {
    this.#values.delete(key);
  }
}

/** The app's own SQLite file, so pairing is backed up and reset with everything else. */
export class SqliteKeyValueStore implements KeyValueStore {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec('CREATE TABLE IF NOT EXISTS extension_bridge (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  get(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM extension_bridge WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.#db.prepare(
      'INSERT INTO extension_bridge (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  delete(key: string): void {
    this.#db.prepare('DELETE FROM extension_bridge WHERE key = ?').run(key);
  }
}
