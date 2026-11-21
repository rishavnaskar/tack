import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/llm.ts';
import { errText, isHosted, limits, lockProcesses, log } from '../src/hosted.ts';

loadEnv();
const hosted = isHosted();
// Before any module that could start a child process is loaded.
if (hosted) lockProcesses();

const { createApp } = await import('../src/server.ts');
const { mount: mountA } = await import('../src/routes/a.ts');
const { mount: mountC } = await import('../src/routes/c.ts');
const { setOwnBase } = await import('../src/practice.ts');
const { stopEngine } = await import('../src/engine-proc.ts');

const app = createApp();
mountA(app.router);

const routesB = new URL('../src/routes/b.ts', import.meta.url);
if (existsSync(fileURLToPath(routesB))) {
  const b = await import(routesB.href);
  b.mount(app.router);
} else {
  console.log('routes/b.ts not found: plan, portfolio, interview and tracker routes are off');
}

mountC(app.router);

if (!hosted) {
  const port = Number(process.env.TACK_PORT) || 4400;
  await app.listen(port, '127.0.0.1');
  setOwnBase(`http://127.0.0.1:${port}`);
  console.log(`tack coach listening on http://127.0.0.1:${port}`);

  // The engine closes its browser on the way out, so it gets its grace before the coach exits.
  const stop = () => { void Promise.all([app.close(), stopEngine()]).then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  // A request that fails is answered and logged; the process stays up for everyone else.
  process.on('uncaughtException', (err) => log({ level: 'error', msg: 'uncaught exception', err: errText(err) }));
  process.on('unhandledRejection', (err) => log({ level: 'error', msg: 'unhandled rejection', err: errText(err) }));

  const raw = process.env.PORT ?? process.env.TACK_PORT;
  const port = raw !== undefined && raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : 8080;
  await app.listen(port, '0.0.0.0');
  const bound = (app.server.address() as AddressInfo).port;
  setOwnBase(`http://127.0.0.1:${bound}`);
  const unchecked = app.unchecked();
  log({ level: 'info', msg: 'listening', host: '0.0.0.0', port: bound, mode: 'hosted', ...(unchecked.length ? { uncheckedWrites: unchecked } : {}) });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log({ level: 'info', msg: 'draining', signal });
    void Promise.all([app.drain(limits().drainMs), stopEngine()])
      .catch((err) => log({ level: 'error', msg: 'shutdown failed', err: errText(err) }))
      .finally(() => {
        log({ level: 'info', msg: 'stopped' });
        process.exit(0);
      });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
