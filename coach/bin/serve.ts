import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/llm.ts';
import { createApp } from '../src/server.ts';
import { mount as mountA } from '../src/routes/a.ts';

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

const port = Number(process.env.TACK_PORT) || 4400;
await app.listen(port, '127.0.0.1');
console.log(`tack coach listening on http://127.0.0.1:${port}`);

const stop = () => { void app.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
