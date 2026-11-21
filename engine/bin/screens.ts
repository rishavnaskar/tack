#!/usr/bin/env node
/**
 * Render every surface against a seeded in-memory app in a real headless
 * Chrome and screenshot it. For checking the UI by eye, and for catching
 * leaked values (undefined, NaN, HTTP errors) in rendered text.
 *
 *   npm run screens -- <outdir> [dark]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { App } from '../src/app.ts';
import { ApiServer } from '../src/server/api.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome } from '../src/cdp/launcher.ts';
import { Page } from '../src/observe/page.ts';
import { FakeRuntime } from '../test/fakes.ts';
import { seedDemo } from '../test/seed.ts';

const out = process.argv[2];
if (!out) { process.stderr.write('usage: screens <outdir> [dark]\n'); process.exit(2); }
mkdirSync(out, { recursive: true });
const theme = process.argv[3] === 'dark' ? 'dark' : 'light';

const app = App.create({ apiKey: 'test-key', dbPath: ':memory:', extensionPort: 0 });
await app.startExtensionBridge();
const fake = new FakeRuntime({ b: { url: 'about:blank', nodes: [] } }, 'b');
Object.defineProperty(app, 'page', { get: () => fake });
app.startBrowser = async () => fake;
Object.defineProperty(app, 'browserStarted', { get: () => true });
const seeded = seedDemo(app);

const server = new ApiServer({ app });
const { url } = await server.listen(0);
// A desktop-sized window: the rail and inspector hide below 1180px, and
// those are half of what is being checked.
const profileDir = await mkdtemp(join(tmpdir(), 'ba-screens-'));
const browser = await launchChrome({ profileDir, headless: true, args: ['--window-size=1440,960'] });
const page = await Page.first(browser.client, { ownWindow: true });
const h = { page, close: async () => { await page.close().catch(() => {}); await browser.close().catch(() => {}); await rm(profileDir, { recursive: true, force: true }); } };
const bad: string[] = [];
const routes = ['chat', 'workers', 'workers/new', `workers/${seeded.workerId}`, `workers/${seeded.workerId}/applications`,
  'applications', 'review', 'profile', 'browser', 'playbooks/greenhouse', 'connect'];
for (const r of routes) {
  await h.page.goto(`${url}#${r}`);
  await new Promise((res) => setTimeout(res, 900));
  if (theme === 'dark') {
    const obs = await h.page.observe();
    const btn = obs.nodes.find((n) => String(n.name ?? '').startsWith('Switch to dark'));
    if (btn?.ref) { await h.page.act({ kind: 'click', ref: btn.ref, pageStateId: obs.pageStateId }); await new Promise((res) => setTimeout(res, 300)); }
    else if (r === routes[0]) process.stderr.write('dark toggle not found; is the rail open?\n');
  }
  const obs = await h.page.observe({ interactive: false });
  const texts = obs.nodes.map((n) => `${n.name ?? ''} ${n.text ?? ''} ${n.value ?? ''}`).join('\n');
  for (const needle of ['undefined', 'NaN', '[object Object]', 'HTTP 4', 'HTTP 5', 'is not defined', 'Cannot read']) {
    if (texts.includes(needle)) bad.push(`${r}: contains "${needle}"`);
  }
  writeFileSync(`${out}/${theme}-${r.replace(/[^a-z0-9]+/gi, '-')}.png`, await h.page.screenshot());
  process.stdout.write(`${r}: ${obs.nodes.length} nodes\n`);
}
process.stdout.write(bad.length ? `PROBLEMS:\n${bad.join('\n')}\n` : 'no leaked values\n');
await h.close();
await server.close();
await app.close();
process.exit(bad.length ? 1 : 0);
