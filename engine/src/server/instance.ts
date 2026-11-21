/**
 * Where a running Fanfold can be found by another process on this machine.
 *
 * One browser profile can be open in one process. So a second entry point,
 * such as an MCP host starting its own copy, looks here first and talks to
 * the one already running instead of failing on the profile lock.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from '../daemon/protocol.ts';

export interface Instance {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export function instancePath(): string {
  return join(stateDir(), 'instance.json');
}

/**
 * Record this process as the running one. Returns how to withdraw it.
 *
 * Never over another Fanfold that is still alive: a standalone copy started
 * beside the app would otherwise take its place, and on exit leave nothing
 * for the next host to attach to.
 */
export async function announce(port: number, token: string): Promise<() => Promise<void>> {
  const path = instancePath();
  await mkdir(stateDir(), { recursive: true });
  if (await anotherAlive()) return async () => {};
  const instance: Instance = { pid: process.pid, port, token, startedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(instance), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return async () => {
    const current = await read(path);
    if (current?.pid === process.pid) await rm(path, { force: true });
  };
}

async function read(path: string): Promise<Instance | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<Instance>;
    if (typeof value.pid !== 'number' || typeof value.port !== 'number' || typeof value.token !== 'string') return null;
    return value as Instance;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The running instance, if its process exists and its server answers. */
export async function findRunning(fetchImpl: typeof fetch = fetch): Promise<Instance | null> {
  const instance = await read(instancePath());
  if (!instance || instance.pid === process.pid || !alive(instance.pid)) return null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${instance.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.status === 200 || res.status === 503 ? instance : null;
  } catch {
    return null;
  }
}

/**
 * Whether another Fanfold's process is alive on this state folder, answering
 * or not. A busy one that misses a health check is still alive, and what it
 * holds, such as its pending approvals, is still its own.
 */
export async function anotherAlive(): Promise<boolean> {
  const instance = await read(instancePath());
  return !!instance && instance.pid !== process.pid && alive(instance.pid);
}
