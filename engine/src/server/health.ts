/**
 * The one route a process supervisor may call without the session token.
 *
 * It says whether the server is serving and whether its browser came up, and
 * nothing more: no error text, paths, accounts or run state. A page that
 * reaches the loopback port learns only that Fanfold runs here, which the
 * fonts route already tells it.
 */
import { readFileSync } from 'node:fs';

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export type HealthStatus = 'ok' | 'idle' | 'degraded';

export interface Health {
  status: HealthStatus;
  version: string;
  uptimeSeconds: number;
}

/**
 * A browser that failed to start is a 503 so a supervisor marks the container
 * unhealthy. No browser at all is the normal idle state, not a start in
 * progress: one opens when a task needs it and closes when nothing has for a
 * while, so a server without one is serving.
 */
export function health(
  browser: { started: boolean; failed: boolean },
  uptimeSeconds: number,
): { code: number; body: Health } {
  const status: HealthStatus = browser.started ? 'ok' : browser.failed ? 'degraded' : 'idle';
  return {
    code: status === 'degraded' ? 503 : 200,
    body: { status, version: VERSION, uptimeSeconds: Math.floor(uptimeSeconds) },
  };
}
