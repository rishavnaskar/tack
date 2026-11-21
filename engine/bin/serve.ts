#!/usr/bin/env node
/**
 * Start the agent and its local UI.
 *
 *   npm start                 opens the UI; the agent's browser opens when a task needs it
 *   npm start -- --headless   no visible window (fixtures, CI)
 *   npm start -- --attach 9222   drive a Chrome already on that loopback port
 */
import { App, closeBudget } from '../src/app.ts';
import { ApiServer } from '../src/server/api.ts';
import { modelKeyFromEnv } from '../src/model/client.ts';
import { loadEnv } from '../src/lib/env.ts';
import { announce, anotherAlive } from '../src/server/instance.ts';
import { authFromEnv } from '../src/auth/config.ts';

loadEnv();

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

// No key is not a reason to refuse to start: another agent can drive
// Fanfold over MCP, and the UI and Review work without a model of its own.
const app = App.create({
  apiKey: modelKeyFromEnv(),
  headless: argv.includes('--headless'),
  attachPort: flag('attach') ? Number(flag('attach')) : undefined,
  profileDir: flag('profile'),
  // Waiting questions are answered again when a résumé comes in, the profile changes or the user answers one.
  sweeps: true,
});

if (!(await anotherAlive())) app.expireOrphanedApprovals();
// A Gemini key the person saved in Fanfold wins over .env.
await app.modelReady;

const unfinished = app.unfinishedBusiness();
if (unfinished.staleRuns || unfinished.unsettledEffects.length) {
  const runs = unfinished.staleRuns;
  const actions = unfinished.unsettledEffects.length;
  process.stderr.write(`\n${[
    runs ? `Fanfold stopped unexpectedly last time while ${runs === 1 ? 'a task was' : `${runs} tasks were`} running. `
      + `${runs === 1 ? 'Its conversation says' : 'Their conversations say'} it did not finish.` : '',
    actions ? `${actions === 1 ? 'One action was' : `${actions} actions were`} started but never confirmed: `
      + `check ${actions === 1 ? 'it' : 'them'} under Needs a look in Fanfold.` : '',
  ].filter(Boolean).join('\n')}\n`);
}

/** Tidy steps (5 s), the browser's grace (5 s) and its kill, with room to spare. */
const SHUTDOWN_LIMIT_MS = 20_000;

// Sign-in is on unless FANFOLD_AUTH=off.
const server = new ApiServer({ app, auth: authFromEnv() });
const { url, port } = await server.listen(Number(flag('port') ?? 0));
// So an MCP host started later uses this browser instead of fighting for its profile.
const withdraw = await announce(port, server.agentToken);
// For the Fanfold extension in the user's own Chrome, when they use it.
await app.startExtensionBridge();
// In the background: documents with no career record yet (as after an upgrade) are read, then waiting questions are answered again once.
void app.catchUp();

// No browser yet: it opens when a task needs one and closes once nothing has
// for a while, so nothing is left open between tasks.

if (!app.modelConfigured) {
  process.stdout.write(
    'No model is configured, so Fanfold\'s own agent and its workers are off. Another agent can still use it over MCP.\n'
    + 'To turn them on, connect a Gemini key in Fanfold\'s Setup, set OPENROUTER_API_KEY in .env, or point FANFOLD_MODEL_URL at an OpenAI-compatible endpoint.\n',
  );
}

// Scheduled workers only recur if something checks for due slots. Without
// this they are manual runs with a schedule written next to them. Without a
// model every one of those runs would fail, so there is nothing to schedule
// until a key is saved.
let scheduling = false;
const schedule = (): void => {
  if (scheduling || argv.includes('--no-scheduler') || !app.modelConfigured) return;
  scheduling = true;
  app.startScheduler({
    intervalMs: Number(flag('tick') ?? 30_000),
    learnEveryMs: Number(flag('learn-every') ?? 6 * 60 * 60 * 1000),
    onLearned: (r) => {
      const result = r as { gated?: unknown[]; derivedCases?: number };
      process.stdout.write(
        `learning pass: ${result.gated?.length ?? 0} lesson(s) gated, ` +
        `${result.derivedCases ?? 0} case(s) derived from real failures\n`,
      );
    },
  });
  process.stdout.write('scheduler: on (workers + periodic reflection)\n');
};
schedule();
app.onEvent((e) => { if (e.type === 'setup_changed') schedule(); });

process.stdout.write(`\nFanfold\n${url}\n\nThe link carries a session token — it only works from this machine.\n`);

// Open it, rather than printing a URL and calling that "opens the UI".
if (!argv.includes('--no-open')) {
  const { execFile } = await import('node:child_process');
  const opener: [string, string[]] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['/usr/bin/open', [url]]
    : ['xdg-open', [url]];
  execFile(opener[0], opener[1], () => { /* a failure here is not fatal */ });
}

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  process.stdout.write('\nshutting down\n');
  // Whatever hangs on the way out, Fanfold and its browser are gone within this.
  setTimeout(() => {
    app.killBrowser();
    process.exit(1);
  }, SHUTDOWN_LIMIT_MS).unref();
  await withdraw().catch(() => {});
  // One budget for every tidy step that talks to the browser; then it gets its grace and is killed.
  const by = Date.now() + closeBudget.politeMs;
  await server.close(by).catch(() => {});
  await app.close(by).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
