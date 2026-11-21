#!/usr/bin/env node
/**
 * `ba` — the browser agent CLI.
 *
 * Thin client over the daemon. Exists so a person can drive and inspect the
 * same browser session the agent uses: sign in by hand once, then verify that
 * observation and ref-clicks work against the real, logged-in site.
 */

import { DaemonClient } from '../src/daemon/client.ts';

const USAGE = `ba — browser agent

  ba open <url>                 navigate
  ba snapshot [-i] [--viewport] observe the page (-i = interactive only)
  ba click <@ref>               click by ref from the last snapshot
  ba fill <@ref> <text>         clear and type into a field
  ba type <@ref> <text>         type without clearing
  ba select <@ref> <value>      choose an option
  ba check|uncheck <@ref>       set a checkbox
  ba hover <@ref>               hover
  ba press <key>                e.g. Enter, Tab, Meta+a
  ba scroll [pixels]            scroll the page
  ba shot [path.png]            screenshot
  ba status                     daemon and session info
  ba quit                       stop the daemon and close the browser

Refs come from the most recent snapshot and expire when the page changes.
`;

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h') {
  process.stdout.write(USAGE);
  process.exit(0);
}

const client = new DaemonClient();
await client.connect();

try {
  await run(cmd, rest);
} catch (err) {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  client.close();
  process.exit(1);
}
client.close();

async function run(command: string, args: string[]): Promise<void> {
  const ref = () => args[0]?.replace(/^@/, '');

  switch (command) {
    case 'open':
      await client.call('open', { url: args[0] });
      await snapshot(args.includes('-i'), false);
      return;

    case 'snapshot':
    case 'obs':
      await snapshot(args.includes('-i'), args.includes('--viewport'));
      return;

    case 'click': case 'hover': case 'check': case 'uncheck':
      await act({ kind: command, ref: ref() });
      return;

    case 'fill': case 'type': case 'select':
      await act({ kind: command, ref: ref(), value: args.slice(1).join(' ') });
      return;

    case 'press':
      await act({ kind: 'press', key: args[0] });
      return;

    case 'scroll':
      await act({ kind: 'scroll', amount: Number(args[0] ?? 500) });
      return;

    case 'shot': {
      const res = await client.call('screenshot', args[0] ? { path: args[0] } : {}) as Record<string, unknown>;
      process.stdout.write(args[0] ? `saved ${res.path} (${res.bytes} bytes)\n` : `${res.base64}\n`);
      return;
    }

    case 'status':
      process.stdout.write(JSON.stringify(await client.call('status'), null, 2) + '\n');
      return;

    case 'quit':
      await client.call('quit');
      process.stdout.write('stopping\n');
      return;

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

/**
 * The most recent snapshot's state id, held for the life of this process.
 *
 * Refs are leases on one observation. The daemon deliberately refuses to fill
 * a missing state id from its own last snapshot — that would resolve a ref
 * against a newer page — so the CLI carries it explicitly.
 */
let currentStateId: string | null = null;

async function snapshot(interactive: boolean, viewportOnly: boolean): Promise<void> {
  const res = await client.call('observe', { interactive, viewportOnly }) as {
    text: string; stats: Record<string, number>; pageStateId: string;
  };
  currentStateId = res.pageStateId;
  process.stdout.write(res.text + '\n');
  const s = res.stats;
  process.stderr.write(
    `\n[${s.nodes} nodes · ${s.refs} refs · ~${s.tokens} tokens · ${s.walkMs}ms walk · ${s.totalMs}ms total]\n`,
  );
}

async function act(args: Record<string, unknown>): Promise<void> {
  if (args.ref && !currentStateId) {
    process.stderr.write('take a snapshot first: refs are only valid against the observation that produced them\n');
    process.exit(2);
  }
  const res = await client.call('act', args.ref ? { ...args, pageStateId: currentStateId } : args) as {
    ok: boolean; failure?: string; detail?: string; navigated: boolean; ms: number;
  };
  if (!res.ok) {
    process.stderr.write(`${res.failure}: ${res.detail}\n`);
    process.exit(2);
  }
  process.stderr.write(`ok (${res.ms}ms${res.navigated ? ', navigated' : ''})\n`);
  // After a navigation the old refs are dead, so re-observing here is not a
  // convenience — it is the only way the next command can address anything.
  if (res.navigated) await snapshot(true, false);
}
