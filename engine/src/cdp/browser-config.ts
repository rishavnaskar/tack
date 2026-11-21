/** One browser selection for the app, daemon, benchmarks and tests. */
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { stateDir } from '../daemon/protocol.ts';

/** Where Chrome usually is, per OS. A configured path or BA_CHROME_PATH wins. */
const SYSTEM_CHROME =
  process.platform === 'win32'
    ? join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome';

export function browserConfigPath(): string {
  return join(stateDir(), 'browser.json');
}

export async function validateChromeExecutable(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('Chrome executable must be an absolute path to a browser binary');
  }
  await access(path, constants.X_OK).catch(() => {
    throw new Error(`Chrome executable is missing or not executable: ${path}. Run npm run browser -- --path /absolute/path/to/Chrome`);
  });
  if (!(await stat(path)).isFile()) throw new Error(`Chrome executable is a directory, not a binary: ${path}`);
  return path;
}

export async function resolveChromeExecutable(opts: {
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
} = {}): Promise<string> {
  const override = opts.executablePath ?? (opts.env ?? process.env).BA_CHROME_PATH;
  if (override !== undefined) return validateChromeExecutable(override);
  const configPath = opts.configPath ?? browserConfigPath();
  let config: string;
  try {
    config = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return validateChromeExecutable(SYSTEM_CHROME);
  }
  let value: unknown;
  try { value = JSON.parse(config); }
  catch { throw new Error(`Invalid browser configuration: ${configPath}`); }
  // Never silently fall back to a different browser after a configured binary
  // disappears. It may reopen an incompatible profile or the conflicting app.
  return validateChromeExecutable((value as { executablePath?: unknown } | null)?.executablePath);
}
