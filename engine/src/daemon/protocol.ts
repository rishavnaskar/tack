/**
 * Daemon wire protocol: newline-delimited JSON over a Unix-domain socket.
 *
 * The browser session has to outlive a single CLI invocation — the whole
 * point is that the user signs into a site once and the session persists — so
 * something has to hold it. That something listens on a UDS in a
 * user-private directory, never a TCP port, and every request carries a
 * per-launch token. Filesystem permissions plus the token mean another
 * local process cannot drive the user's logged-in browser.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where everything lives, per OS. The directory name stays "browser-agent"
 * so an existing database, profile and sign-ins are found after the rename.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.BROWSER_AGENT_STATE_DIR) return env.BROWSER_AGENT_STATE_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'browser-agent');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'browser-agent');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'browser-agent');
}

/** Files the agent produces live here, and nowhere else. */
export function artifactDir(): string {
  return join(stateDir(), 'artifacts');
}

export function socketPath(): string {
  return join(stateDir(), 'daemon.sock');
}

export function tokenPath(): string {
  return join(stateDir(), 'daemon.token');
}

/**
 * Every request carries an id and every response echoes it.
 *
 * Without one the client can only match responses to requests by arrival
 * order, and the daemon handles each line asynchronously — so two commands in
 * flight can complete out of order and the client attributes the wrong result
 * to the wrong command. Silently, and only under concurrency.
 */
export interface Request {
  id: string;
  token: string;
  cmd: string;
  args?: Record<string, unknown>;
}

export type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

/** A single line may not exceed this. Applies to both directions. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Reject anything that is not shaped like a request before dispatching it. */
export function validateRequest(value: unknown): { ok: true; request: Request } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'request must be an object' };
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 128) return { ok: false, error: 'id must be a short string' };
  if (typeof r.token !== 'string') return { ok: false, error: 'token must be a string' };
  if (typeof r.cmd !== 'string' || !/^[a-z_]{1,32}$/.test(r.cmd)) return { ok: false, error: 'cmd must be a short lowercase name' };
  if (r.args !== undefined && (typeof r.args !== 'object' || r.args === null || Array.isArray(r.args))) {
    return { ok: false, error: 'args must be an object' };
  }
  return { ok: true, request: r as unknown as Request };
}
