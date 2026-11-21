// Tack's own Fanfold process: started on first use of mail or apply, stopped with the coach.
// With TACK_FANFOLD_STATE set, an already running Fanfold is used instead (MCP only).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './store.ts';

const ENGINE_DIR = fileURLToPath(new URL('../../engine/', import.meta.url));
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export interface EngineHandle {
  mode: 'own' | 'attach';
  base: string;
  port: number;
  /** Reaches /api. Only known for an engine Tack started itself. */
  ownerToken: string | null;
  /** Reaches /mcp only. */
  agentToken: string;
  stateDir: string;
  pid: number;
  startedAt: string;
}

export interface EngineInfo { running: boolean; mode: 'own' | 'attach' | 'off'; port?: number; stateDir: string; note: string }

let child: ChildProcess | null = null;
let current: Promise<EngineHandle> | null = null;
let handle: EngineHandle | null = null;
let lastError = '';

export function engineStateDir(): string {
  return join(stateDir(), 'engine');
}

export function attachDir(): string | null {
  const dir = process.env.TACK_FANFOLD_STATE?.trim();
  return dir ? resolve(dir.replace(/^~(?=\/)/, process.env.HOME ?? '~')) : null;
}

export function info(): EngineInfo {
  const attach = attachDir();
  if (handle) return { running: true, mode: handle.mode, port: handle.port, stateDir: handle.stateDir, note: handle.mode === 'attach' ? 'using a running Fanfold' : 'Tack\'s own engine is running' };
  return { running: false, mode: attach ? 'attach' : 'off', stateDir: attach ?? engineStateDir(), note: lastError || 'starts on first use of mail or apply' };
}

/** OpenAI-compatible base URL: Fanfold appends /chat/completions itself. */
export function modelBase(url = process.env.TACK_MODEL_URL): string {
  return (url?.trim() || GEMINI_BASE).replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
}

/** The environment the engine child runs with: its own state, no sign-in, Tack's model, approvals from TACK_APPROVALS. */
export function childEnv(dir: string, src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const model = src.TACK_ENGINE_MODEL || src.TACK_MODEL_SMART || src.TACK_MODEL_FAST || DEFAULT_MODEL;
  const env: NodeJS.ProcessEnv = {
    PATH: src.PATH, HOME: src.HOME, USER: src.USER, TMPDIR: src.TMPDIR, LANG: src.LANG,
    BROWSER_AGENT_STATE_DIR: dir,
    FANFOLD_AUTH: 'off',
    FANFOLD_EXTENSION_PORT: src.TACK_EXTENSION_PORT || '47611',
    FANFOLD_LOG_LEVEL: src.TACK_ENGINE_LOG || 'warn',
    FANFOLD_MODEL_URL: modelBase(src.TACK_MODEL_URL),
    FANFOLD_MODEL_KEY: src.TACK_MODEL_KEY || src.GEMINI_API_KEY || '',
    FANFOLD_MODEL_STEP: model, FANFOLD_MODEL_PLAN: model, FANFOLD_MODEL_VISION: model, FANFOLD_MODEL_ANSWER: model,
    BROWSER_AGENT_APPROVALS: src.TACK_APPROVALS ?? 'none',
  };
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) if (src[k]) env[k] = src[k];
  if (src.TACK_CHROME_PATH) env.BA_CHROME_PATH = src.TACK_CHROME_PATH;
  return env;
}

/** The owner link Fanfold prints on start: http://127.0.0.1:<port>/?t=<token>. */
export function parseOwnerUrl(text: string): { port: number; token: string } | null {
  const m = text.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([A-Za-z0-9]+)/);
  return m ? { port: Number(m[1]), token: m[2] } : null;
}

function readInstance(dir: string): { pid: number; port: number; token: string } | null {
  try {
    const v = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8')) as { pid?: unknown; port?: unknown; token?: unknown };
    return typeof v.pid === 'number' && typeof v.port === 'number' && typeof v.token === 'string' ? { pid: v.pid, port: v.port, token: v.token } : null;
  } catch {
    return null;
  }
}

async function healthy(base: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attach(dir: string): Promise<EngineHandle> {
  const inst = readInstance(dir);
  if (!inst) throw new Error(`no running Fanfold found in ${dir} (no instance.json)`);
  const base = `http://127.0.0.1:${inst.port}`;
  if (!(await healthy(base))) throw new Error(`the Fanfold in ${dir} does not answer on port ${inst.port}`);
  return { mode: 'attach', base, port: inst.port, ownerToken: null, agentToken: inst.token, stateDir: dir, pid: inst.pid, startedAt: new Date().toISOString() };
}

async function launch(): Promise<EngineHandle> {
  const dir = engineStateDir();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(ENGINE_DIR, 'bin/serve.ts'))) throw new Error('engine/bin/serve.ts is missing');
  const args = ['--no-warnings', 'bin/serve.ts', '--no-open', '--no-scheduler', '--port', process.env.TACK_ENGINE_PORT || '0'];
  if (process.env.TACK_ENGINE_HEADLESS === '1') args.push('--headless');
  const proc = spawn(process.execPath, args, { cwd: ENGINE_DIR, env: childEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  let out = '';
  let err = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  const owner = new Promise<{ port: number; token: string }>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`the engine did not start within 45 s${err ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}`)), 45_000);
    proc.stdout!.on('data', (chunk: string) => {
      out += chunk;
      const hit = parseOwnerUrl(out);
      if (hit) { clearTimeout(timer); ok(hit); }
      if (out.length > 64_000) out = out.slice(-8_000);
    });
    proc.once('exit', (code) => { clearTimeout(timer); fail(new Error(`the engine exited with code ${code}${err ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}`)); });
  });
  proc.stderr!.on('data', (chunk: string) => { err = (err + chunk).slice(-4000); });
  proc.once('exit', () => {
    if (child === proc) { child = null; handle = null; current = null; }
  });
  const { port, token } = await owner;
  const base = `http://127.0.0.1:${port}`;
  // announce() writes instance.json before the link is printed.
  let agentToken = '';
  for (let i = 0; i < 40 && !agentToken; i++) {
    const inst = readInstance(dir);
    if (inst?.port === port) agentToken = inst.token;
    else await sleep(100);
  }
  if (!agentToken) throw new Error('the engine started but wrote no agent key');
  for (let i = 0; i < 60; i++) {
    if (await healthy(base)) break;
    await sleep(250);
  }
  return { mode: 'own', base, port, ownerToken: token, agentToken, stateDir: dir, pid: proc.pid ?? 0, startedAt: new Date().toISOString() };
}

/** The engine, started or attached on first call. Concurrent callers share one start. */
export function ensureEngine(): Promise<EngineHandle> {
  if (process.env.TACK_ENGINE === 'off') return Promise.reject(new Error('the engine is turned off by TACK_ENGINE=off'));
  if (current) return current;
  const dir = attachDir();
  current = (dir ? attach(dir) : launch()).then((h) => {
    handle = h;
    lastError = '';
    return h;
  }, (e: unknown) => {
    current = null;
    lastError = (e as Error).message;
    if (child) { child.kill('SIGTERM'); child = null; }
    throw e;
  });
  return current;
}

/** Stops the engine Tack started, giving it time to close its browser; an attached one is left alone. */
export async function stopEngine(graceMs = 12_000): Promise<void> {
  const proc = child;
  child = null;
  handle = null;
  current = null;
  if (!proc || proc.exitCode !== null) return;
  const gone = new Promise<void>((ok) => proc.once('exit', () => ok()));
  proc.kill('SIGTERM');
  await Promise.race([gone, sleep(graceMs)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

// A coach that exits any other way still takes its engine with it.
process.once('exit', () => { if (child && child.exitCode === null) child.kill('SIGTERM'); });
