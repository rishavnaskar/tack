/** Optional, read-only evidence for diagnostics; not a production dependency. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function northlightTermination(text: string, pid: number, since: number, until = Date.now()): string | null {
  for (const line of text.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.component === 'agent.reloader.darwin' && event.step === 'process.kill.success'
          && event.details?.pid === pid && event.details?.signal === 'TERM'
          && typeof event.ts === 'number' && event.ts >= since && event.ts <= until) {
        return `Northlight logged sending TERM to this Chrome (pid=${pid}) at ${new Date(event.ts).toISOString()}. `
          + 'Use a dedicated Chrome for Testing binary (npm run browser -- --path /absolute/path/to/binary), '
          + 'or quit Northlight before launching regular Chrome. Changing profiles or increasing retries does not resolve this conflict.';
      }
    } catch { /* Partial first/last line or unrelated log record. */ }
  }
  return null;
}

export async function readTerminationEvidence(pid: number, since: number): Promise<string | null> {
  const path = join(homedir(), 'Library', 'Application Support', 'Northlight', 'debug.log');
  try {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return northlightTermination(buffer.subarray(0, bytesRead).toString('utf8'), pid, since);
    } finally { await file.close(); }
  } catch { return null; }
}
