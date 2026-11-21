#!/usr/bin/env node
/**
 * Run one task end to end against a real browser.
 *
 *   node --no-warnings bin/run.ts "find AI engineer jobs in SF" --url https://jobs.example
 */
import { launchChrome, defaultProfileDir } from '../src/cdp/launcher.ts';
import { Page } from '../src/observe/page.ts';
import { ModelClient, apiKeyFromEnv } from '../src/model/client.ts';
import { Store } from '../src/store/db.ts';
import { runTask, type AgentEvent } from '../src/agent/loop.ts';
import { stateDir } from '../src/daemon/protocol.ts';
import { join } from 'node:path';
import { loadEnv } from '../src/lib/env.ts';

loadEnv();

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const goal = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true).join(' ').trim();
if (!goal) {
  process.stderr.write('usage: run.ts "<goal>" [--url <start url>] [--steps N] [--headless]\n');
  process.exit(1);
}

const store = new Store(join(stateDir(), 'agent.db'));
const model = new ModelClient({ apiKey: apiKeyFromEnv() });
const browser = await launchChrome({
  profileDir: flag('profile') ?? defaultProfileDir(),
  headless: args.includes('--headless'),
});
const page = await Page.first(browser.client);
if (flag('url')) await page.goto(flag('url')!);

const render = (e: AgentEvent): void => {
  switch (e.type) {
    case 'run_started': process.stdout.write(`run ${e.runId}\ngoal: ${e.goal}\n\n`); break;
    case 'observed': process.stdout.write(`[${e.step}] ${e.url}\n      observed ${e.nodes} nodes, ~${e.tokens} tok, ${e.ms}ms\n`); break;
    case 'chose': process.stdout.write(`      ${e.action.kind}${e.action.ref ? ' ' + e.action.ref : ''}${e.action.value ? ' ' + JSON.stringify(e.action.value.slice(0, 50)) : ''}  (${e.tier}, ${e.ms}ms, $${e.costUsd.toFixed(6)})\n      "${e.action.reason}"\n`); break;
    case 'acted': process.stdout.write(`      ${e.ok ? 'ok' : 'FAILED ' + e.failure} ${e.ms}ms\n\n`); break;
    case 'approval_required': process.stdout.write(`\n  APPROVAL REQUIRED (${e.sensitivity})\n  ${e.why}\n`); break;
    case 'finished': process.stdout.write(`\n${e.status.toUpperCase()}: ${e.message}\n${e.steps} steps, $${e.costUsd.toFixed(6)}\n`); break;
  }
};

const result = await runTask({
  goal, page, model, store,
  maxSteps: Number(flag('steps') ?? 20),
  onEvent: render,
});

await browser.close();
store.close();
process.exit(result.status === 'done' ? 0 : 1);
