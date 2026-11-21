import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/llm.ts';
import { createApp } from '../src/server.ts';
import { mount as mountA } from '../src/routes/a.ts';
import { mount as mountC } from '../src/routes/c.ts';
import { setOwnBase } from '../src/practice.ts';
import { stopEngine } from '../src/engine-proc.ts';

loadEnv();
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

const port = Number(process.env.TACK_PORT) || 4400;
await app.listen(port, '127.0.0.1');
setOwnBase(`http://127.0.0.1:${port}`);
console.log(`tack coach listening on http://127.0.0.1:${port}`);

// The engine closes its browser on the way out, so it gets its grace before the coach exits.
const stop = () => { void Promise.all([app.close(), stopEngine()]).then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
