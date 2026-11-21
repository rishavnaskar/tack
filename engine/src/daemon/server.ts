/**
 * The browser daemon.
 *
 * Holds exactly one Chrome (the agent's own profile) and its page session,
 * and serves commands over a token-authenticated Unix socket. The `ba` CLI
 * is its client: each command reaches this process, so the browser outlives
 * the command that started it.
 */

import { createServer, type Socket, type Server } from 'node:net';
import { mkdir, writeFile, unlink, chmod } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { launchChrome, defaultProfileDir, type Launched } from '../cdp/launcher.ts';
import { Page } from '../observe/page.ts';
import { renderObservation, observationStats, snapshotNotes } from '../observe/render.ts';
import {
  stateDir, socketPath, tokenPath, artifactDir, validateRequest, MAX_LINE_BYTES, type Response,
} from './protocol.ts';
import type { ActionRequest, PageStateId, Ref } from '../types.ts';
import { assertNavigable } from '../policy/navigable.ts';
import { loggerFromEnv } from '../lib/log.ts';

const log = loggerFromEnv().child({ component: 'daemon' });

export interface DaemonOptions {
  profileDir?: string;
  headless?: boolean;
}

export class Daemon {
  #server: Server | null = null;
  #browser: Launched | null = null;
  #page: Page | null = null;
  #token = '';
  #startedAt = Date.now();
  #stopping = false;
  #opts: DaemonOptions;

  constructor(opts: DaemonOptions = {}) {
    this.#opts = opts;
  }

  get page(): Page {
    if (!this.#page) throw new Error('browser not started');
    if (this.#browser?.client.closed) throw new Error('browser is gone; restart the daemon');
    return this.#page;
  }

  async start(): Promise<void> {
    await mkdir(stateDir(), { recursive: true });
    // A stale socket from a crashed daemon would block bind(); it is safe to
    // remove because a live daemon holds the lock on the same path.
    if (existsSync(socketPath())) {
      await this.#assertNotRunning();
      await unlink(socketPath()).catch(() => {});
    }

    this.#token = randomBytes(32).toString('hex');
    await writeFile(tokenPath(), this.#token, { mode: 0o600 });
    await chmod(tokenPath(), 0o600);

    this.#browser = await launchChrome({
      profileDir: this.#opts.profileDir ?? defaultProfileDir(),
      headless: this.#opts.headless ?? false,
    });
    this.#page = await Page.first(this.#browser.client);

    // The daemon must not outlive its browser. A user closing the agent's
    // Chrome window is ordinary, not exceptional, and a daemon still holding
    // a socket over a dead browser answers every command with a confusing
    // transport error. Exiting instead means the next client autostarts a
    // clean one, and the profile on disk keeps the signed-in sessions.
    this.#browser.process.once('exit', () => {
      if (this.#stopping) return;
      log.warn('browser exited; shutting down daemon');
      void this.stop().then(() => process.exit(0));
    });

    this.#server = createServer((socket) => this.#handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(socketPath(), () => resolve());
    });
    await chmod(socketPath(), 0o600);

    const shutdown = () => { void this.stop().then(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  async #assertNotRunning(): Promise<void> {
    const { connect } = await import('node:net');
    const alive = await new Promise<boolean>((resolve) => {
      const probe = connect(socketPath());
      const done = (v: boolean) => { probe.destroy(); resolve(v); };
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
      setTimeout(() => done(false), 500).unref();
    });
    if (alive) throw new Error(`a daemon is already listening on ${socketPath()}`);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#page?.close().catch(() => {});
    await this.#browser?.close();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
    await unlink(socketPath()).catch(() => {});
    await unlink(tokenPath()).catch(() => {});
  }

  #handleConnection(socket: Socket): void {
    let buffer = '';
    // Commands on one connection are handled strictly in order. The handlers
    // are async and drive a single browser; letting two overlap would
    // interleave navigation and actions on the same page.
    let queue: Promise<void> = Promise.resolve();

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE_BYTES) {
        socket.write(JSON.stringify({ id: '', ok: false, error: 'request line too large' }) + '\n');
        socket.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        queue = queue.then(async () => {
          const response = await this.#handleLine(line);
          if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
        });
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async #handleLine(line: string): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { id: '', ok: false, error: 'malformed request' };
    }
    const check = validateRequest(parsed);
    if (!check.ok) return { id: '', ok: false, error: check.error };

    const req = check.request;
    if (!timingSafeEqualStr(req.token, this.#token)) {
      return { id: req.id, ok: false, error: 'unauthorized' };
    }
    try {
      return { id: req.id, ok: true, result: await this.handle(req.cmd, req.args ?? {}) };
    } catch (err) {
      return { id: req.id, ok: false, error: (err as Error).message };
    }
  }

  /** Command dispatch, exposed directly so tests can skip the socket. */
  async handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      case 'status':
        return {
          pid: process.pid,
          uptimeMs: Date.now() - this.#startedAt,
          profileDir: this.#browser?.profileDir,
          url: this.#page?.lastObservation?.url ?? null,
        };

      case 'open': {
        const url = String(args.url ?? '');
        if (!url) throw new Error('open requires a url');
        const target = normalizeUrl(url);
        assertNavigable(target);
        await this.page.goto(target);
        return { url: target };
      }

      case 'observe': {
        const obs = await this.page.observe({
          interactive: Boolean(args.interactive),
          viewportOnly: Boolean(args.viewportOnly),
        });
        return {
          pageStateId: obs.pageStateId,
          text: [renderObservation(obs), ...snapshotNotes(obs)].join('\n'),
          stats: observationStats(obs),
        };
      }

      case 'act': {
        // The caller's own state id, never one filled in from the daemon's
        // last observation. Substituting it would let a caller send a bare
        // ref and have it resolved against a NEWER snapshot — which is
        // exactly the stale-ref failure the lease design exists to prevent,
        // reintroduced by the transport.
        if (args.ref !== undefined && args.pageStateId === undefined) {
          throw new Error(
            'act with a ref requires the pageStateId of the observation that produced it. ' +
            'Take a snapshot and pass its pageStateId.',
          );
        }
        const req: ActionRequest = {
          kind: args.kind as ActionRequest['kind'],
          ref: args.ref ? (String(args.ref).replace(/^@/, '') as Ref) : undefined,
          pageStateId: args.pageStateId as PageStateId | undefined,
          value: args.value === undefined ? undefined : String(args.value),
          key: args.key === undefined ? undefined : String(args.key),
          url: args.url === undefined ? undefined : String(args.url),
          amount: args.amount === undefined ? undefined : Number(args.amount),
        };
        return this.page.act(req);
      }

      case 'screenshot': {
        const buf = await this.page.screenshot();
        if (args.path) {
          // Artifacts go in a directory the agent owns. A caller-supplied
          // absolute path would let a command write anywhere the user can.
          const path = resolveArtifactPath(String(args.path));
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, buf);
          return { path, bytes: buf.length };
        }
        return { base64: buf.toString('base64'), bytes: buf.length };
      }

      case 'quit':
        setTimeout(() => void this.stop().then(() => process.exit(0)), 10);
        return { stopping: true };

      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  }
}

function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

export function resolveArtifactPath(requested: string): string {
  const base = artifactDir();
  const full = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  const normalisedBase = resolve(base);
  if (full !== normalisedBase && !full.startsWith(normalisedBase + '/')) {
    throw new Error(
      `refusing to write outside the agent's artifact directory (${normalisedBase}). ` +
      `Pass a relative name instead of ${requested}.`,
    );
  }
  return full;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
