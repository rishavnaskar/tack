#!/usr/bin/env node
/**
 * Serve an OpenAI-compatible /v1/chat/completions on loopback, answered by
 * the signed-in `claude` CLI, so Fanfold's own agent can run with no
 * OpenRouter key.
 *
 *   node --no-warnings bin/model-bridge.ts --port 4340
 *   FANFOLD_MODEL_URL=http://127.0.0.1:4340/v1 FANFOLD_MODEL_KEY=<the key it prints> npm start
 *
 *   --port 4340         where to listen (127.0.0.1 only)
 *   --model haiku       for requests that name no model it runs: haiku or sonnet
 *   --concurrency 6     claude processes at once; the rest queue
 *   --key <secret>      the bearer key to require (or FANFOLD_BRIDGE_KEY); one is made up at start otherwise
 *   --claude <path>     the claude executable
 *   --timeout 170       seconds before one call is given up on
 *   --ignore-max-tokens send whole replies even past a request's max_tokens
 *
 * One JSON line per request goes to stdout.
 */
import { randomBytes } from 'node:crypto';
import { createBridge, claudeRunner } from '../src/model/bridge.ts';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

const given = flag('key') ?? process.env.FANFOLD_BRIDGE_KEY ?? '';
const key = given || randomBytes(24).toString('base64url');

const bridge = createBridge({
  runner: claudeRunner({ command: flag('claude'), timeoutMs: Number(flag('timeout') ?? 170) * 1000 }),
  model: flag('model') ?? 'haiku',
  key,
  concurrency: Number(flag('concurrency') ?? 6),
  honourMaxTokens: !argv.includes('--ignore-max-tokens'),
  log: (entry) => process.stdout.write(JSON.stringify(entry) + '\n'),
});

const port = await bridge.listen(Number(flag('port') ?? 4340));
process.stderr.write(started(port, flag('model') ?? 'haiku', given ? null : key));

const stop = (): void => { bridge.server.close(); bridge.server.closeAllConnections(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** What the person starting it is told: where it is, and the key to give Fanfold. */
function started(at: number, model: string, made: string | null): string {
  const url = `http://127.0.0.1:${at}/v1`;
  return made
    ? `The model bridge is running at ${url} (it uses claude -p; the default model is ${model}). It only responds to requests that include its key. `
      + `The key for this run is ${made}. Start Fanfold with FANFOLD_MODEL_URL=${url} FANFOLD_MODEL_KEY=${made}\n`
    : `The model bridge is running at ${url} (it uses claude -p; the default model is ${model}). It only responds to requests that include the key you gave it. `
      + `Start Fanfold with FANFOLD_MODEL_URL=${url} and that same key in FANFOLD_MODEL_KEY.\n`;
}
