/**
 * Load settings from .env files without overriding the environment.
 *
 * Two places are read, nearest first: app/.env, then the repository root's
 * .env (which is also what docker compose reads). A variable already set in
 * the environment wins over both, and a missing file is not an error.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = [new URL('../../.env', import.meta.url), new URL('../../../.env', import.meta.url)];

export function loadEnv(files: URL[] = CANDIDATES): string[] {
  const loaded: string[] = [];
  for (const url of files) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) continue;
    process.loadEnvFile(path);
    loaded.push(path);
  }
  return loaded;
}
