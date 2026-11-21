#!/usr/bin/env node
/** Configure a dedicated Chrome binary without touching cookies or profiles. */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserConfigPath, resolveChromeExecutable, validateChromeExecutable } from '../src/cdp/browser-config.ts';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--path')) {
  throw new Error('Usage: npm run browser [-- --path /absolute/path/to/Chrome]');
}
if (args[0] === '--path') {
  const executablePath = await validateChromeExecutable(args[1]);
  const target = browserConfigPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ executablePath }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Saved: ${target}`);
}
console.log(`Chrome: ${await resolveChromeExecutable()}`);
if (process.env.BA_CHROME_PATH !== undefined) console.log('BA_CHROME_PATH overrides the saved selection.');
console.log('Selection applies to start, daemon, diagnose, bench and browser tests. Restart an already-running agent to apply it.');
