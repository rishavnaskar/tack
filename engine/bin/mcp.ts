#!/usr/bin/env node
/**
 * Fanfold as an MCP server, for Claude Code, Claude Desktop, Codex, Gemini
 * CLI or any other host that speaks the protocol over stdio.
 *
 *   fanfold-mcp                  use the Fanfold already running, or start one
 *   fanfold-mcp --headless       no visible browser window
 *   fanfold-mcp --standalone     never attach to a running Fanfold
 *   fanfold-mcp --approvals app  always ask in Fanfold's own review queue
 *   fanfold-mcp --workers        also run scheduled workers in this process
 *   fanfold-mcp --no-open        never open Fanfold's window, even for an approval
 *   fanfold-mcp --state-dir DIR  the Fanfold that keeps its data in DIR, as its Connect page says
 *
 * The host's model does the thinking, so no model key is needed. With
 * OPENROUTER_API_KEY or FANFOLD_MODEL_URL set, the host can also hand whole
 * tasks to Fanfold's own agent.
 */
import { join } from 'node:path';
import { App, closeBudget } from '../src/app.ts';
import { stateDir } from '../src/daemon/protocol.ts';
import { ApiServer } from '../src/server/api.ts';
import { loadEnv } from '../src/lib/env.ts';
import { modelKeyFromEnv } from '../src/model/client.ts';
import { announce, anotherAlive, findRunning } from '../src/server/instance.ts';
import { serveStdio } from '../src/mcp/stdio.ts';
import { proxyStdio } from '../src/mcp/proxy.ts';
import { removeStaleSandboxes } from '../src/mcp/sandbox.ts';
import { authFromEnv } from '../src/auth/config.ts';

loadEnv();

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const say = (line: string): void => { process.stderr.write(`fanfold: ${line}\n`); };
// Before anything looks for a running Fanfold or its files.
if (flag('state-dir')) process.env.BROWSER_AGENT_STATE_DIR = flag('state-dir');
const io = { input: process.stdin, output: process.stdout };

const running = argv.includes('--standalone') ? null : await findRunning();
if (running) {
  say(`using the Fanfold already running (pid ${running.pid})`);
  // Hosts end this process with a signal. Fanfold is told first, so this agent's windows close and "main" is free.
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => stop.abort());
  await proxyStdio(running, io, fetch, undefined, stop.signal);
  process.exit(0);
}

const approvals = flag('approvals');
if (approvals !== undefined && approvals !== 'host' && approvals !== 'app') {
  say('--approvals takes "host" or "app"');
  process.exit(2);
}

await removeStaleSandboxes();

const app = App.create({
  apiKey: modelKeyFromEnv(),
  headless: argv.includes('--headless'),
  attachPort: flag('attach') ? Number(flag('attach')) : undefined,
  profileDir: flag('profile'),
  // Waiting questions are answered again when a résumé comes in, the profile changes or the user answers one.
  sweeps: true,
});

// With --standalone another Fanfold may still be answering its own approvals,
// and the Review link on disk is that one's.
const alone = !(await anotherAlive());
if (alone) app.expireOrphanedApprovals();

// With --no-open nothing else would ever show the person where Review is.
const reviewLink = join(stateDir(), 'review-link.txt');
const server = new ApiServer({
  app,
  mcp: { approvalsVia: approvals ?? 'host', openReviewOnApproval: !argv.includes('--no-open') },
  reviewLinkFile: alone ? reviewLink : undefined,
  // Sign-in is on unless FANFOLD_AUTH=off: a host gets nothing done until the person has signed in.
  auth: authFromEnv(),
});
const { port } = await server.listen(Number(flag('port') ?? 0));
const withdraw = await announce(port, server.agentToken);
// For the Fanfold extension in the user's own Chrome, when they use it.
await app.startExtensionBridge();

await app.modelReady;
if (argv.includes('--workers') && app.modelConfigured) {
  app.startScheduler({ intervalMs: 30_000, learnEveryMs: 6 * 60 * 60 * 1000 });
}

say(`ready on stdio. Its Review page: open the link saved in ${reviewLink}${argv.includes('--no-open') ? '' : ' (it opens by itself when something needs approval)'}`);

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  // Whatever hangs on the way out, Fanfold and its browser are gone within this.
  setTimeout(() => {
    app.killBrowser();
    process.exit(1);
  }, 20_000).unref();
  await withdraw().catch(() => {});
  const by = Date.now() + closeBudget.politeMs;
  await server.close(by).catch(() => {});
  await app.close(by).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await serveStdio(server.mcp.server, io).closed;
await shutdown();
