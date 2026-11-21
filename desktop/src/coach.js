// Runs the coach server as a child process on Electron's own Node
// (ELECTRON_RUN_AS_NODE), which strips TypeScript types and ships node:sqlite.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export class Coach {
  /**
   * @param {{ entry: string, watchdog: string, cwd: string, logFile: string, echo: boolean,
   *           env: () => Record<string, string>, log: (line: string) => void }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.port = 0;
    this.onExit = null;
    mkdirSync(dirname(opts.logFile), { recursive: true });
    if (existsSync(opts.logFile) && statSync(opts.logFile).size > 5 * 1024 * 1024) renameSync(opts.logFile, `${opts.logFile}.1`);
    this.logStream = createWriteStream(opts.logFile, { flags: 'a' });
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port) {
    this.port = port || (await freePort());
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--import', pathToFileURL(this.opts.watchdog).href, this.opts.entry],
      {
        cwd: this.opts.cwd,
        env: { ...this.opts.env(), ELECTRON_RUN_AS_NODE: '1', TACK_PORT: String(this.port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const echo = this.opts.echo ? process.stdout : null;
    let up = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        this.logStream.write(chunk);
        echo?.write(chunk);
      });
    }
    exited.then(({ code, signal }) => {
      this.opts.log(`coach exited (pid ${child.pid}, code ${code}, signal ${signal})`);
      if (this.child !== child) return;
      this.child = null;
      if (up) this.onExit?.({ code, signal });
    });

    const ready = await Promise.race([this.#waitReady(30_000), exited.then(() => false)]);
    if (!ready) {
      await this.stop();
      throw new Error(`coach did not answer on port ${this.port}; see ${this.opts.logFile}`);
    }
    up = true;
    this.opts.log(`coach ready at ${this.url} (pid ${child.pid}) in ${Date.now() - started} ms`);
    return this.url;
  }

  async #waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.child) {
      try {
        // /api/state probes the job boards, which can take a few seconds offline.
        const res = await fetch(`${this.url}/api/state`, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          await res.arrayBuffer();
          return true;
        }
      } catch {
        // not listening yet
      }
      await sleep(150);
    }
    return false;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timedOut = await Promise.race([gone.then(() => false), sleep(3000).then(() => true)]);
    if (timedOut) {
      this.opts.log(`coach ignored SIGTERM, killing pid ${child.pid}`);
      child.kill('SIGKILL');
      await gone;
    }
  }

  /** Restarts on the same port when it is still free, so the window can keep its URL. */
  async restart() {
    const port = this.port;
    await this.stop();
    try {
      return await this.start(port);
    } catch {
      return this.start();
    }
  }
}
