/**
 * Evidence from the machine where it happens.
 *
 * Two browser flows fail on a healthy Chrome from an ordinary Terminal and
 * cannot be reproduced where this code is written, because a headless Chrome
 * lives about a second there. This runs both, step by step, and prints what
 * Chrome actually did: every CDP event with a timestamp, the browser
 * process's exit code and signal, the tail of its stderr, and which Chrome
 * processes still hold the profile between a close and a relaunch.
 *
 *   npm run diagnose            # both flows, three times each
 *   npm run diagnose -- guard   # only the guarded-link flow
 *   npm run diagnose -- restart # only the orderly-restart flow
 *   npm run diagnose -- launch  # HEADFUL launch against the real profile
 *
 * launch uses the real agent profile; other flows use temporary profiles.
 * Unexpected exits also check Northlight's local log for this exact PID.
 */

import { mkdtemp, rm, readdir, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchChrome, type Launched } from '../src/cdp/launcher.ts';
import { resolveChromeExecutable } from '../src/cdp/browser-config.ts';
import { readTerminationEvidence } from '../src/cdp/termination-evidence.ts';
import { Page } from '../src/observe/page.ts';
import { startFixtureServer } from '../test/harness.ts';

const run = promisify(execFile);
const only = process.argv[2];
const say = (s = ''): void => { process.stdout.write(s + '\n'); };
const stamp = (t0: number): string => `+${String(Date.now() - t0).padStart(5)}ms`;

const { server, origin } = await startFixtureServer();

/** Launch with every event recorded, and the process watched. */
async function launchTraced(profileDir: string, log: string[], t0: number, headless = true): Promise<Launched> {
  const b = await launchChrome({ profileDir, headless });
  b.process.once('exit', (code, signal) => log.push(`${stamp(t0)} CHROME EXITED code=${code} signal=${signal}`));
  b.process.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString('utf8').split('\n')) {
      // Only what could explain a death: CHECK failures, crashes, fatal logs.
      if (/FATAL|CHECK|Check failed|crash|Assertion|SIGSEGV|SIGABRT|Received signal/i.test(line)) {
        log.push(`${stamp(t0)} chrome stderr: ${line.trim().slice(0, 200)}`);
      }
    }
  });
  for (const ev of ['Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Page.frameRequestedNavigation',
    'Page.frameStartedLoading', 'Page.frameNavigated', 'Page.frameStoppedLoading', 'Page.loadEventFired',
    'Target.targetCrashed', 'Target.detachedFromTarget', 'Target.targetDestroyed', 'Inspector.targetCrashed',
    'Inspector.detached', 'Runtime.executionContextsCleared']) {
    b.client.on(ev, (p) => {
      const brief = ev.includes('Dialog') ? `type=${p.type} hasBrowserHandler=${p.hasBrowserHandler}`
        : ev === 'Page.frameNavigated' ? `url=${String((p.frame as { url?: string })?.url ?? '').split('/').slice(-1)[0]}`
        : ev === 'Page.frameRequestedNavigation' ? `reason=${p.reason} url=${String(p.url).split('/').slice(-1)[0]}`
        : ev.includes('detached') || ev.includes('Detached') ? `reason=${p.reason ?? ''}`
        : '';
      log.push(`${stamp(t0)} ${ev} ${brief}`.trimEnd());
    });
  }
  return b;
}

async function chromeOnProfile(profileDir: string): Promise<number> {
  try {
    const { stdout } = await run('/bin/ps', ['-Ao', 'args']);
    return stdout.split('\n').filter((l) => l.includes(`--user-data-dir=${profileDir}`)).length;
  } catch {
    return -1;
  }
}

async function singleton(profileDir: string): Promise<string> {
  try { return `SingletonLock -> ${await readlink(join(profileDir, 'SingletonLock'))}`; }
  catch { return 'no SingletonLock'; }
}

async function guardFlow(n: number): Promise<void> {
  const log: string[] = [];
  const t0 = Date.now();
  const profileDir = await mkdtemp(join(tmpdir(), 'ba-diag-guard-'));
  let b: Launched | null = null;
  try {
    b = await launchTraced(profileDir, log, t0);
    const page = await Page.first(b.client);
    await page.goto(`${origin}/dialogs.html`);
    let obs = await page.observe({ interactive: true });
    const guard = obs.nodes.find((x) => x.role === 'checkbox')!;
    await page.act({ kind: 'check', ref: guard.ref!, pageStateId: obs.pageStateId });
    obs = await page.observe({ interactive: true });
    const link = obs.nodes.find((x) => x.role === 'link' && x.name === 'Leave the page')!;
    log.push(`${stamp(t0)} >>> click the guarded link`);
    const res = await page.act({ kind: 'click', ref: link.ref!, pageStateId: obs.pageStateId });
    log.push(`${stamp(t0)} <<< click returned ok=${res.ok} navigated=${res.navigated} failure=${res.failure ?? '-'} ${res.detail ?? ''}`.trimEnd());
    await new Promise((r) => setTimeout(r, 800));
    try {
      const after = await page.observe();
      log.push(`${stamp(t0)} observe after: url=${after.url.split('/').slice(-1)[0]} alive=${b.process.exitCode === null}`);
    } catch (err) {
      log.push(`${stamp(t0)} observe after THREW: ${(err as Error).message.slice(0, 120)}`);
    }
  } catch (err) {
    log.push(`${stamp(t0)} FLOW THREW: ${(err as Error).message.slice(0, 160)}`);
  } finally {
    say(`--- guard flow #${n}  (chrome alive at end: ${b ? b.process.exitCode === null : 'never launched'})`);
    for (const l of log) say('  ' + l);
    await b?.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function restartFlow(n: number): Promise<void> {
  const log: string[] = [];
  const t0 = Date.now();
  const profileDir = await mkdtemp(join(tmpdir(), 'ba-diag-restart-'));
  let b: Launched | null = null;
  try {
    b = await launchTraced(profileDir, log, t0);
    const page = await Page.first(b.client);
    await page.goto(`${origin}/session/login`);
    const who = (await page.observe()).nodes.map((x) => x.text).find((t) => t && t !== 'jobs');
    log.push(`${stamp(t0)} signed in as: ${who}`);

    log.push(`${stamp(t0)} >>> close() the browser`);
    await page.close().catch(() => {});
    await b.close();
    log.push(`${stamp(t0)} <<< close() returned; chrome processes on profile: ${await chromeOnProfile(profileDir)}; ${await singleton(profileDir)}`);
    b = null;

    log.push(`${stamp(t0)} >>> relaunch on the same profile`);
    try {
      b = await launchTraced(profileDir, log, t0);
      log.push(`${stamp(t0)} <<< relaunch handshake ok; processes on profile: ${await chromeOnProfile(profileDir)}`);
      const page2 = await Page.first(b.client);
      await page2.goto(`${origin}/session/whoami`);
      const who2 = (await page2.observe()).nodes.map((x) => x.text).find((t) => t && t !== 'jobs');
      log.push(`${stamp(t0)} after relaunch, whoami: ${who2}`);
    } catch (err) {
      log.push(`${stamp(t0)} RELAUNCH FAILED: ${(err as Error).message.slice(0, 200)}`);
      log.push(`${stamp(t0)} processes on profile now: ${await chromeOnProfile(profileDir)}; ${await singleton(profileDir)}`);
      const files = await readdir(profileDir).catch(() => [] as string[]);
      log.push(`${stamp(t0)} profile dir has: ${files.filter((f) => /Singleton|lock/i.test(f)).join(', ') || 'no lock files'}`);
    }
  } catch (err) {
    log.push(`${stamp(t0)} FLOW THREW: ${(err as Error).message.slice(0, 160)}`);
  } finally {
    say(`--- restart flow #${n}`);
    for (const l of log) say('  ' + l);
    await b?.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true });
  }
}

/**
 * Launch the way `npm start` does — HEADFUL, against the real agent profile —
 * and watch what Chrome does for ten seconds.
 *
 * Every suite that passes runs headless against a throwaway profile. A real
 * run does neither, and when the browser has already gone by the time an
 * action runs, every `goto` comes back TRANSPORT_LOST in 0ms. This is the
 * flow that shows why, and it is the one that cannot be reproduced anywhere
 * but the machine it happens on.
 */
async function launchFlow(n: number, headless: boolean): Promise<void> {
  const log: string[] = [];
  const t0 = Date.now();
  const { defaultProfileDir } = await import('../src/cdp/launcher.ts');
  const profileDir = defaultProfileDir();
  let b: Launched | null = null;
  try {
    log.push(`${stamp(t0)} profile: ${profileDir}`);
    log.push(`${stamp(t0)} other Chromes on this profile before launch: ${await chromeOnProfile(profileDir)}; ${await singleton(profileDir)}`);
    b = await launchTraced(profileDir, log, t0, headless);
    log.push(`${stamp(t0)} handshake ok, pid ${b.process.pid}; processes on profile: ${await chromeOnProfile(profileDir)}`);

    const page = await Page.first(b.client);
    log.push(`${stamp(t0)} attached to a page target`);

    // Exactly what a first task does.
    await page.goto('https://example.com/', 20_000);
    const obs = await page.observe({ interactive: false });
    log.push(`${stamp(t0)} navigated: ${obs.url} (${obs.nodes.length} nodes)`);

    // Then simply watch. A browser that dies does it in the first seconds.
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      const alive = b.process.exitCode === null && b.process.signalCode === null;
      let answers = 'yes';
      try { await b.client.send('Target.getTargets'); } catch (err) { answers = (err as Error).message.slice(0, 40); }
      log.push(`${stamp(t0)} +${i * 2}s alive=${alive} cdp-answers=${answers}`);
      if (!alive || answers !== 'yes') {
        process.exitCode = 1;
        const evidence = await readTerminationEvidence(b.process.pid!, t0);
        if (evidence) log.push(evidence);
        break;
      }
    }
  } catch (err) {
    process.exitCode = 1;
    log.push(`${stamp(t0)} FLOW THREW: ${(err as Error).message.slice(0, 500)}`);
    const pid = b?.process.pid ?? Number(/pid=(\d+)/.exec((err as Error).message)?.[1]);
    const evidence = pid ? await readTerminationEvidence(pid, t0) : null;
    if (evidence) log.push(evidence);
  } finally {
    say(`--- launch flow #${n} (${headless ? 'headless' : 'HEADFUL, like npm start'})`);
    for (const l of log) say('  ' + l);
    await b?.close().catch(() => {});
  }
}

try {
  say(`Executable: ${await resolveChromeExecutable()}`);
  // Asked of the browser itself over CDP, not of the binary: the path is not
  // reliably reachable from a script, and "unknown" is worth nothing.
  let version = 'unknown';
  {
    const dir = await mkdtemp(join(tmpdir(), 'ba-diag-version-'));
    try {
      const b = await launchChrome({ profileDir: dir, headless: true });
      const v = await b.client.send<{ product?: string; revision?: string }>('Browser.getVersion')
        .catch(() => ({} as { product?: string; revision?: string }));
      version = `${v.product ?? 'unknown'}${v.revision ? ` (${v.revision})` : ''}`;
      await b.close().catch(() => {});
    } catch { /* leave unknown */ }
    await rm(dir, { recursive: true, force: true });
  }
  say(`Chrome: ${version}   node: ${process.version}   platform: ${process.platform} ${process.arch}`);
  say();
  if (only === 'launch') {
    // Headful first: that is what `npm start` uses and what failed.
    for (let i = 1; i <= 2; i++) await launchFlow(i, false);
    await launchFlow(3, true);
  } else {
    if (!only || only === 'guard') for (let i = 1; i <= 3; i++) await guardFlow(i);
    if (!only || only === 'restart') for (let i = 1; i <= 3; i++) await restartFlow(i);
  }
} finally {
  (server as unknown as { destroyConnections?: () => void }).destroyConnections?.();
  server.close();
}
