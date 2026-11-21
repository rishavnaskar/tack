/** Client side of the daemon protocol. Auto-starts the daemon on demand. */

import { connect, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { socketPath, tokenPath, MAX_LINE_BYTES, type Response } from './protocol.ts';

export class DaemonClient {
  #socket: Socket | null = null;
  #token: string | null = null;
  #buffer = '';
  // Keyed by request id, not a FIFO queue. Responses can arrive in any order,
  // and a queue silently hands the wrong result to the wrong caller.
  #pending = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async connect(autostart = true): Promise<void> {
    try {
      await this.#open();
    } catch (err) {
      if (!autostart) throw err;
      await startDaemonDetached();
      await this.#open();
    }
    this.#token = (await readFile(tokenPath(), 'utf8')).trim();
  }

  async #open(): Promise<void> {
    this.#socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(socketPath());
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    this.#socket.on('data', (chunk) => {
      this.#buffer += chunk.toString('utf8');
      if (this.#buffer.length > MAX_LINE_BYTES) {
        this.#failAll(new Error('daemon sent an oversized response'));
        this.#socket?.destroy();
        return;
      }
      let idx: number;
      while ((idx = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, idx);
        this.#buffer = this.#buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let response: Response;
        try {
          response = JSON.parse(line) as Response;
        } catch {
          continue; // an unparseable line belongs to no request we can name
        }
        const waiter = this.#pending.get(response.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        this.#pending.delete(response.id);
        waiter.resolve(response);
      }
    });

    // A daemon that dies must not leave the caller waiting forever.
    this.#socket.on('close', () => this.#failAll(new Error('the daemon closed the connection')));
    this.#socket.on('error', (err) => this.#failAll(err));
  }

  #failAll(err: Error): void {
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.#pending.clear();
  }

  async call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.#socket || !this.#token) throw new Error('not connected');
    const id = randomUUID();

    const response = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`daemon did not answer "${cmd}" within ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket!.write(JSON.stringify({ id, token: this.#token, cmd, args }) + '\n');
    });

    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  close(): void {
    this.#failAll(new Error('client closed'));
    this.#socket?.end();
    this.#socket = null;
  }
}

/**
 * Start the daemon as a detached child and wait for it to accept connections.
 * Detached because the browser must survive the CLI process exiting — that is
 * the entire reason a daemon exists.
 */
async function startDaemonDetached(timeoutMs = 20_000): Promise<void> {
  const entry = fileURLToPath(new URL('../../bin/daemon.ts', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise<boolean>((resolve) => {
      const probe = connect(socketPath());
      const done = (v: boolean) => { probe.destroy(); resolve(v); };
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('daemon did not come up in time');
}
