/**
 * Secret storage.
 *
 * OAuth refresh tokens are long-lived credentials for the user's mail and
 * calendar. Keeping them as plaintext in the agent's SQLite file would mean
 * any process that can read one file can read the user's mail — including a
 * backup, a sync folder, or a crash report that scoops up the database.
 *
 * The design here works around a real constraint. macOS `security` takes the
 * password as a command-line argument, and arguments are visible to any
 * process the user can run. So exactly ONE secret goes through argv: a
 * randomly generated master key, written once at setup. Everything else is
 * encrypted with that key (AES-256-GCM) and stored in SQLite. Reading the
 * master key back uses `find-generic-password -w`, which exposes nothing.
 *
 * The result: one brief exposure at first run instead of one per token, and
 * the database on its own is useless without the Keychain entry.
 */

import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const SERVICE_PREFIX = 'browser-agent';

/** Where the master key lives. The macOS Keychain in the product; a fake in tests. */
export interface KeyStore {
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  delete(account: string): Promise<void>;
}

export class Keychain implements KeyStore {
  #service: string;

  constructor(namespace = 'default') {
    this.#service = `${SERVICE_PREFIX}.${namespace}`;
  }

  async set(account: string, secret: string): Promise<void> {
    // -U updates in place rather than failing when the item already exists.
    await run(['add-generic-password', '-a', account, '-s', this.#service, '-U', '-w', secret]);
  }

  async get(account: string): Promise<string | null> {
    try {
      const out = await run(['find-generic-password', '-a', account, '-s', this.#service, '-w']);
      return out.replace(/\n$/, '');
    } catch {
      return null; // Not found is the ordinary case, not an error.
    }
  }

  async delete(account: string): Promise<void> {
    await run(['delete-generic-password', '-a', account, '-s', this.#service]).catch(() => {});
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Encrypted secrets in SQLite, keyed by a master key in the Keychain.
 */
export class SecretStore {
  #db: DatabaseSync;
  #keychain: KeyStore;
  #key: Buffer | null = null;
  #account: string;

  constructor(db: DatabaseSync, keychain: KeyStore = new Keychain('master'), account = 'master-key') {
    this.#db = db;
    this.#db.exec(SCHEMA);
    this.#keychain = keychain;
    this.#account = account;
  }

  async #masterKey(): Promise<Buffer> {
    if (this.#key) return this.#key;
    const existing = await this.#keychain.get(this.#account);
    if (existing) {
      this.#key = Buffer.from(existing, 'base64');
      if (this.#key.length === 32) return this.#key;
      // A malformed key is not something to silently replace: doing so would
      // quietly orphan every secret already encrypted with the real one.
      throw new Error('the master key in the Keychain is not 32 bytes; refusing to guess');
    }
    const key = randomBytes(32);
    await this.#keychain.set(this.#account, key.toString('base64'));
    this.#key = key;
    return key;
  }

  async set(name: string, value: string): Promise<void> {
    const key = await this.#masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.#db.prepare(
      'INSERT INTO secrets (name, iv, tag, ciphertext, updated_at) VALUES (?,?,?,?,?) ' +
      'ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ' +
      'ciphertext = excluded.ciphertext, updated_at = excluded.updated_at',
    ).run(name, iv, cipher.getAuthTag(), ciphertext, new Date().toISOString());
  }

  async get(name: string): Promise<string | null> {
    const row = this.#db.prepare('SELECT iv, tag, ciphertext FROM secrets WHERE name = ?').get(name) as
      { iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array } | undefined;
    if (!row) return null;

    const key = await this.#masterKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv));
    decipher.setAuthTag(Buffer.from(row.tag));
    try {
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString('utf8');
    } catch {
      // A failed tag check means the value was altered. Returning null would
      // present tampering as an ordinary cache miss.
      throw new Error(`secret "${name}" failed its integrity check — it has been modified`);
    }
  }

  delete(name: string): void {
    this.#db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  names(): string[] {
    return (this.#db.prepare('SELECT name FROM secrets ORDER BY name').all() as Array<{ name: string }>)
      .map((r) => r.name);
  }
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });
}
