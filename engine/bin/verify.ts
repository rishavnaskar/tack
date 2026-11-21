#!/usr/bin/env node
/**
 * One command for the gates that cannot be checked from inside agent tooling:
 * a real Chrome, and a real Google consent.
 *
 * It exists because "run the browser suite and tell me what happened" is a
 * procedure, and a procedure with steps is one people get wrong. Its real job
 * is interpretation — saying whether a failure was a check in this code not
 * holding, or the environment taking the browser away. Those look alike in a
 * test summary and call for opposite responses.
 *
 * Plain text on purpose, so the output can be pasted somewhere.
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseFailures, parseTotals, type Failure, type FailureCause } from '../src/eval/tap.ts';
import { loadEnv } from '../src/lib/env.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const dbFlag = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : undefined;
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const say = (line = ''): void => { process.stdout.write(line + '\n'); };

interface SuiteResult {
  tests: number;
  passed: number;
  failed: number;
  failures: Failure[];
  timedOut: boolean;
  output: string;
}

/**
 * Run a suite with a hard deadline.
 *
 * A browser dying at the wrong moment can leave the runner waiting on a
 * promise that never settles, and a verification command that hangs is worse
 * than one reporting a timeout: whoever ran it learns nothing and cannot tell
 * whether to keep waiting.
 */
async function runSuite(script: string, timeoutMs = 5 * 60_000): Promise<SuiteResult> {
  const { output, timedOut } = await new Promise<{ output: string; timedOut: boolean }>((resolve) => {
    const child = execFile('npm', ['run', script], { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      (_err, stdout, stderr) => {
        clearTimeout(timer);
        resolve({ output: stdout + stderr, timedOut: false });
      });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ output: '', timedOut: true });
    }, timeoutMs);
  });
  return { ...parseTotals(output), failures: parseFailures(output), timedOut, output };
}

/** What each cause means, in the terms someone acting on it needs. */
const MEANING: Record<FailureCause, string> = {
  assertion: 'a check in this code did not hold - these are defects',
  'browser-lost': 'the browser or its transport went away mid-test',
  protocol: 'CDP returned an error, usually a dying session',
  precondition: 'the code was used in an order it does not support',
  unknown: 'could not be attributed - worth looking at directly',
};

function reportFailures(result: SuiteResult): void {
  const byCause = new Map<FailureCause, Failure[]>();
  for (const f of result.failures) byCause.set(f.cause, [...(byCause.get(f.cause) ?? []), f]);

  for (const [cause, list] of byCause) {
    say(`   ${list.length} ${cause}: ${MEANING[cause]}`);
    // Every failure is named, browser losses included: listed only by
    // count, a healthy machine that loses exactly one browser a run cannot
    // say which test did. A recurring loss is a cause to find, and the name
    // is where finding it starts.
    for (const f of list.slice(0, 6)) {
      say(`     ${f.name} -- ${(f.error || '(no error recorded)').replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  if (byCause.has('browser-lost') || byCause.has('protocol')) {
    say('   If you are inside an agent, sandbox or IDE task runner, try a plain Terminal.');
  }

  // Every failure the summary counted must be accounted for by name. An
  // unexplained one is precisely the one that might matter.
  const unexplained = result.failed - result.failures.length;
  if (unexplained > 0) {
    say(`   ${unexplained} failure(s) could not be attributed to a named test.`);
    say(`   Run the suite directly to see them.`);
  }
}

say();
say('Fanfold - verification');
say('============================');
say();

const [major, minor] = process.versions.node.split('.').map(Number);
say(`  node ${process.versions.node}  ${major > 22 || (major === 22 && minor >= 18) ? 'ok' : 'TOO OLD - needs 22.18 or later'}`);

let chromeOk = true;
await access(MAC_CHROME).catch(() => { chromeOk = false; });
say(`  Chrome        ${chromeOk ? 'found' : 'NOT FOUND at ' + MAC_CHROME}`);
say();

say('1. Browser-free tests');
const unit = await runSuite('test:unit');
const unitMissing = unit.tests - unit.passed - unit.failed;
say(`   ${unit.passed}/${unit.tests} passing` + (unit.failed ? `  -- ${unit.failed} FAILING` : ''));
if (unitMissing > 0) {
  // A cancelled test is not a passing test. It reports as neither, so a gate
  // keyed only on the failure count would call this green.
  say(`   ${unitMissing} did not run to completion (cancelled or interrupted).`);
}
if (unit.failures.length) reportFailures(unit);
say();

say('2. Real Chrome');
let browser: SuiteResult | null = null;
if (!chromeOk) {
  say('   skipped - Chrome is not installed where expected');
} else {
  browser = await runSuite('test:browser');
  if (browser.timedOut) {
    say('   TIMED OUT - the suite did not finish within five minutes.');
    say('   That usually means the browser died in a way that left the runner waiting.');
    say('   If you are inside an agent, sandbox or IDE task runner, try a plain Terminal.');
  } else if (browser.tests > 0 && browser.failed === 0 && browser.passed === browser.tests) {
    say(`   ${browser.passed}/${browser.tests} passing - the browser layer is verified`);
  } else {
    say(`   ${browser.passed}/${browser.tests} passing, ${browser.failed} failing`);
    reportFailures(browser);
  }
}
say();

say('3. Google connector');
loadEnv();

let googleConnected = false;
if (!process.env.COMPOSIO_API_KEY && !process.env.GOOGLE_CLIENT_ID) {
  say('   not configured');
  say('   Put COMPOSIO_API_KEY in app/.env (from app.composio.dev) and rerun; the consent then');
  say('   happens on Composio\'s screen. Or, for a direct client, set GOOGLE_CLIENT_ID.');
} else {
  say(`   provider: ${process.env.COMPOSIO_API_KEY ? 'Composio' : 'Google OAuth client'}`);
  const { App, defaultDbPath } = await import('../src/app.ts');
  const { availableTools } = await import('../src/agent/tools.ts');
  const { reachabilitySummary } = await import('../src/connectors/google.ts');
  // The database the app actually uses: a fresh in-memory one could never
  // see a token stored by a real sign-in, so the gate could not pass however
  // correctly someone completed consent.
  const dbPath = dbFlag ?? defaultDbPath();
  say(`   reading ${dbPath}`);
  const app = App.create({ apiKey: process.env.OPENROUTER_API_KEY ?? 'unused', dbPath });
  const scopes = await app.googleScopes();
  const actions = availableTools(await app.tools());

  if (!scopes.length) {
    say('   configured, not connected');
    say('   Run "npm start", then use Connect under Connectors in the UI.');
    if (process.env.COMPOSIO_API_KEY) say('   (Composio: connect Gmail and Calendar each once; status is polled until ACTIVE)');
  } else {
    say(`   token grants: ${actions.join(', ') || '(nothing usable)'}`);
    for (const s of scopes) say('     ' + s);
    // The gate is the API answering, not the scope list. A revoked grant, a
    // Gmail API left disabled in the Cloud project, or an OAuth client still
    // in testing all present as a flawless set of scopes and then fail on
    // first real use.
    say('   calling Google...');
    const reach = await app.checkGoogle().catch((err: Error) => {
      say(`   could not call Google: ${err.message}`);
      return null;
    });
    for (const [name, probe] of [['Gmail', reach?.gmail], ['Calendar', reach?.calendar]] as const) {
      if (!probe) continue;
      say(`     ${name}: ${probe.ok ? 'OK - ' : probe.skipped ? 'skipped - ' : 'FAILED - '}${probe.detail}`);
    }
    // Every capability the token advertises has to answer. Asking only that
    // SOMETHING answered would pass an account whose Gmail returns 403 while
    // Calendar works, with both scopes granted — an account the agent would
    // offer gmail_search on, and fail at.
    const verdict = reach ? reachabilitySummary(reach) : { usable: false, why: 'Google could not be called' };
    googleConnected = verdict.usable;
    say(`   ${verdict.usable ? 'usable' : 'NOT usable'}: ${verdict.why}`);
  }
  await app.close();
}
say();

const gates: Array<[string, boolean]> = [
  // Every test has to have actually run AND passed. A suite where one was
  // cancelled reports fail 0, which is not the same as being green.
  ['browser-free tests', unit.tests > 0 && unit.failed === 0 && unit.passed === unit.tests],
  ['real Chrome', Boolean(
    browser && !browser.timedOut && browser.tests > 0 &&
    browser.failed === 0 && browser.passed === browser.tests,
  )],
  ['Google reachable (a real API call answered)', googleConnected],
];

say('Verdict');
for (const [name, passed] of gates) say(`   [${passed ? 'x' : ' '}] ${name}`);
say();
say(gates.every(([, p]) => p)
  ? 'All three gates pass.'
  : 'Open gates above. A failing unit suite is a bug in this code; the others are environment or setup.');
say();

// Exit 1 is reserved for CONFIRMED defects: a failed assertion, or a
// browser-free test that did not run. A protocol error, a lost browser or an
// unattributable failure leave the gate open without claiming this code is
// broken — saying "defect" on evidence that does not support it is how a
// check stops being believed.
//   0 - every gate passes
//   1 - a defect here
//   2 - no defect found, but a gate is open
const confirmedDefects = [...(browser?.failures ?? []), ...unit.failures]
  .filter((f) => f.cause === 'assertion');
if (unit.failed > 0 || unitMissing > 0 || confirmedDefects.length > 0) process.exit(1);
process.exit(gates.every(([, p]) => p) ? 0 : 2);
