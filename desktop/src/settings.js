// The model key lives in <userData>/.env, in the same KEY=value format the
// coach reads, so a user can also edit it by hand.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const KEY_NAME = 'GEMINI_API_KEY';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(LINE);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v) out[m[1]] = v;
  }
  return out;
}

/** Sets or, with an empty value, removes the key line. Other lines are kept as they are. */
export function writeKey(file, value) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const kept = lines.filter((line) => line.match(LINE)?.[1] !== KEY_NAME);
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  if (value) kept.push(`${KEY_NAME}=${value}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
  chmodSync(file, 0o600);
}
