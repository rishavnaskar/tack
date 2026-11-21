/**
 * Chrome launcher — dedicated agent profile.
 *
 * We launch our own Chrome against a `user-data-dir` the agent owns. We do not
 * attach to the user's running Chrome: since M136 Chrome ignores remote
 * debugging on the default profile precisely to stop cookie exfiltration over
 * CDP, and we would not want that access even if it were offered. The user
 * signs in once, in a real window, and the session persists in this profile.
 * The agent therefore never holds the user's personal cookies, passwords, or
 * browsing history — only the accounts they deliberately signed the agent into.
 *
 * Note on a flag we deliberately do NOT pass: every tutorial recommends
 * `--disable-blink-features=AutomationControlled` to hide the automation
 * signal. That is disguise, not automation, and it is out of scope by policy.
 * We identify as what we are.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, rm, readlink, chmod, open as openFile, readFile, writeFile } from 'node:fs/promises';
import { stateDir } from '../daemon/protocol.ts';
import { dirname, join } from 'node:path';
import { PipeTransport } from './transport.ts';
import { WebSocketTransport } from './ws-transport.ts';
import { CdpClient, type CdpClientOptions } from './client.ts';
import { resolveChromeExecutable } from './browser-config.ts';

const execFileAsync = promisify(execFile);

/**
 * Remove a stale singleton left by an unclean exit.
 *
 * Chrome marks a profile as in use with SingletonLock (a symlink naming the
 * owning host and pid), SingletonCookie and SingletonSocket. On a clean exit
 * it removes them. After a crash — or a SIGKILL, or an abandoned launch
 * attempt — they survive, and the next Chrome started against that profile
 * forwards its command line to the instance it believes is running and then
 * exits without owning the session. This is not evidence that a browser
 * which completed a pipe handshake later handed off. The repeated clean
 * post-handshake exits on this Mac were Northlight sending TERM, confirmed
 * by exact-PID entries in its own log.
 */
async function clearStaleSingleton(profileDir: string): Promise<void> {
  const lock = join(profileDir, 'SingletonLock');
  let owner: string | null = null;
  try {
    owner = await readlink(lock);
  } catch {
    return; // No lock, nothing to clear.
  }
  // The link target is "<host>-<pid>". If that pid is alive, leave it alone:
  // waitForProfileProcessesToExit should already have caught it, and racing a
  // live browser for its own profile is how profiles get corrupted.
  const pid = Number(owner?.split('-').pop());
  if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) return;
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await rm(join(profileDir, name), { force: true }).catch(() => {});
  }
}

/**
 * Guard against two launches racing for the same profile.
 *
 * Chrome's own singleton exists, but it resolves the race by having the
 * second instance hand its command line to the first and exit cleanly — which
 * is indistinguishable, from our side, from a browser that started and then
 * vanished. Taking a lock first means the second launch gets a clear error
 * instead of a mystery.
 *
 * An O_EXCL create is the lock; a stale one from a crash is cleared once its
 * recorded pid is gone.
 */
async function acquireLaunchLock(profileDir: string): Promise<() => Promise<void>> {
  const lockPath = join(profileDir, '.agent-launch-lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await openFile(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = Number(await readFile(lockPath, 'utf8').catch(() => ''));
      if (Number.isFinite(owner) && owner > 0 && isAlive(owner)) {
        // The lock is held for as long as that process has the browser open,
        // not just while it starts one — two processes must never drive the
        // same profile. Said plainly, because "already launching" sounds like
        // a race to wait out when it is usually just `npm start` still
        // running in another window.
        throw new Error(
          `another process (pid ${owner}) already has this Chrome profile open: ${profileDir}. ` +
          'Stop it first (Ctrl-C in the window running npm start), or use --profile to work in a different one.',
        );
      }
      await rm(lockPath, { force: true }).catch(() => {});
    }
  }
  throw new Error(`could not take the launch lock for ${profileDir}`);
}

/**
 * Tell Chrome its last session ended cleanly.
 *
 * Fanfold's Chrome dies with Fanfold's pipe, and Chrome then counts the
 * session as a crash: the next start offers to restore it, and a restored
 * session brings back every tab Fanfold had open. Those tabs belong to work
 * that no longer exists. A missing file gets the two keys; one that cannot be
 * read is left alone for Chrome to deal with as it would anyway.
 */
export async function markProfileClean(profileDir: string): Promise<void> {
  const path = join(profileDir, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    prefs = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const profile = prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile)
    ? prefs.profile as Record<string, unknown> : {};
  if (profile.exit_type === 'Normal' && profile.exited_cleanly === true) return;
  prefs.profile = { ...profile, exit_type: 'Normal', exited_cleanly: true };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(prefs));
  } catch {
    // Not fatal: the flag below still keeps the restore offer out of sight.
  }
}

/** What Chrome reads to bring back the last session's tabs. Cookies, sign-ins and site data live elsewhere and are not touched. */
const SESSION_FILES = ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];

/**
 * Forget the last session's tabs before a start.
 *
 * Marking the profile clean is not enough: after Fanfold is killed outright,
 * Chrome still reopens what it last saved, a half-filled form among it, with
 * the answers typed into it. Every tab of Fanfold's belongs to work that died
 * with that Fanfold, so there is nothing in these files worth bringing back.
 */
async function forgetLastSession(profileDir: string): Promise<void> {
  for (const name of SESSION_FILES) {
    await rm(join(profileDir, 'Default', name), { recursive: true, force: true }).catch(() => {});
  }
}

/** Alive, or not ours to signal: only "no such process" proves it gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProfileProcessesToExit(profileDir: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let running = false;
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-Ao', 'args']);
      running = stdout.split('\n').some((line) => line.includes(`--user-data-dir=${profileDir}`));
    } catch {
      return; // If we cannot check, do not block shutdown on it.
    }
    if (!running) return;
    await delay(120);
  }
}

interface LaunchOptions extends CdpClientOptions {
  /** Directory for the agent's own Chrome profile. */
  profileDir?: string;
  /** Path to the Chrome binary. */
  executablePath?: string;
  /** Headless is for fixtures and CI only — real sessions need a real window. */
  headless?: boolean;
  /** Extra args. Reviewed by the caller; no security-weakening flags. */
  args?: string[];
  /** Attempts before giving up on a browser that keeps handing off. */
  launchAttempts?: number;
}

export interface Launched {
  client: CdpClient;
  process: ChildProcess;
  profileDir: string;
  /** Quit: Chrome is asked first and given CLOSE_GRACE_MS, then it and every process it started are killed. */
  close(): Promise<void>;
  /** Kill Chrome and every process it started at once, for a shutdown that cannot wait. */
  kill?(): void;
}

/** How long a Chrome asked to quit is given before it is killed. A Chrome that stopped answering never quits by itself. */
const CLOSE_GRACE_MS = 5_000;

/** How long the browser must stay up after the handshake to count as live. */
const STABILITY_WINDOW_MS = 600;

export function defaultProfileDir(): string {
  return join(stateDir(), 'chrome-profile');
}

/** A request id the client never issues, so Chrome's reply to a quit is ignored. */
const QUIT_ID = 2_147_483_000;

/** Flags that would weaken the browser's security posture or disguise the agent. */
const FORBIDDEN_ARG_PREFIXES = [
  '--disable-web-security',
  '--disable-blink-features=AutomationControlled',
  '--allow-running-insecure-content',
  '--ignore-certificate-errors',
  '--disable-site-isolation-trials',
  '--remote-debugging-port',
  '--remote-allow-origins',
];

/**
 * A visible Chrome on a Mac paces its frames to the display, and one started
 * with the display on stops drawing when the display sleeps: a dialog opened
 * in an animation frame never appears and a screenshot never returns. Chrome
 * started with the display already off falls back to its own timer and keeps
 * drawing; this asks for that timer from the start. Measured: 16.7 ms a frame
 * on 120 Hz and 100 Hz displays, where the display's own clock gave 8.3 and
 * 10. display-wake.ts still checks before each session acts.
 */
const OWN_FRAME_CLOCK = 'ForceMacVSyncTimerForDebugging';

export function frameClockArgs(platform: NodeJS.Platform, headless: boolean | undefined, extra: readonly string[]): string[] {
  if (platform !== 'darwin' || headless) return [...extra];
  const at = extra.findIndex((a) => a.startsWith('--enable-features='));
  if (at < 0) return [...extra, `--enable-features=${OWN_FRAME_CLOCK}`];
  // Chrome reads only one --enable-features, so the feature joins the caller's list.
  const merged = [...extra];
  merged[at] = `${merged[at]},${OWN_FRAME_CLOCK}`;
  return merged;
}

/**
 * Launch Chrome and complete a CDP handshake.
 *
 * Bounded retries cover transient startup exits, not persistent external
 * interference. In particular, a profile change or a retry cannot prevent
 * Northlight's reloader from terminating regular Google Chrome. Configure
 * a dedicated automation binary or stop the conflicting application.
 */
export async function launchChrome(opts: LaunchOptions = {}): Promise<Launched> {
  const attempts = opts.launchAttempts ?? 4;
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await launchOnce(opts);
    } catch (err) {
      if (!(err instanceof EarlyExitError)) throw err;
      last = err;
      if (i + 1 < attempts) await delay(400 * (i + 1));
    }
  }
  throw new Error(`Chrome failed to start after ${attempts} attempts: ${last?.message}`);
}

class EarlyExitError extends Error {}

/**
 * Deliberately NOT unref'd. These waits are the only thing in flight during a
 * launch retry; an unref'd timer lets the event loop drain and Node exits with
 * the launch promise unsettled, which presents as a silent failure with no
 * error at all.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function launchOnce(opts: LaunchOptions): Promise<Launched> {
  const profileDir = opts.profileDir ?? defaultProfileDir();
  const executablePath = await resolveChromeExecutable(opts);

  await access(executablePath).catch(() => {
    throw new Error(`Chrome not found at ${executablePath}`);
  });
  const extra = opts.args ?? [];
  for (const arg of extra) {
    const bad = FORBIDDEN_ARG_PREFIXES.find((p) => arg.startsWith(p));
    if (bad) throw new Error(`refusing to launch with ${bad} — see launcher.ts policy note`);
  }
  await mkdir(profileDir, { recursive: true });
  await chmod(profileDir, 0o700).catch(() => { /* not fatal on odd filesystems */ });
  const releaseLaunchLock = await acquireLaunchLock(profileDir);
  await clearStaleSingleton(profileDir);
  await markProfileClean(profileDir);
  await forgetLastSession(profileDir);

  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    // Crash reporting off: an agent profile should not be uploading crash
    // dumps, and crashpad's Mach port handshake fails outright under some
    // sandboxes — when it does, Chrome aborts at startup with only
    // "no client check-in" in its log and no other explanation.
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // Sessions work side by side, and a page whose timers slow to once a
    // second when it is not in front misses its own typeahead's debounce.
    '--disable-background-timer-throttling',
    // A session that ended with Fanfold is not one to offer back: its tabs belonged to work that is over.
    '--hide-crash-restore-bubble',
    '--homepage=about:blank',
    // With no window to size, headless Chrome draws an 800 by 600 page and
    // most sites answer with their phone layout: menus folded away, search
    // behind an icon. A laptop-sized page is what a person would be looking at.
    ...(opts.headless ? ['--headless=new', '--window-size=1366,900'] : []),
    ...frameClockArgs(process.platform, opts.headless, extra),
    'about:blank',
  ];

  let child: ChildProcess;
  try {
    child = spawn(executablePath, args, {
      // fds 3 and 4 carry the CDP pipe. Chrome reads 3, writes 4.
      // Drain stderr so the browser cannot block on a full pipe.
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      // A process group of its own, so Chrome and its helpers can be killed
      // together. Chrome still exits when Fanfold does: the pipe closes.
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    await releaseLaunchLock();
    throw err;
  }

  // A spawn that fails — a bad path, a permissions problem, ENOMEM — emits
  // 'error' and never 'exit'. Without this listener that surfaces as an
  // unhandled rejection and the launch promise simply never settles.
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once('error', (err) => {
      reject(new Error(`could not start Chrome at ${executablePath}: ${(err as Error).message}`));
    });
  });

  let stderrTail = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-4096);
  });

  const writePipe = child.stdio[3] as NodeJS.WritableStream | null;
  const readPipe = child.stdio[4] as NodeJS.ReadableStream | null;
  if (!writePipe || !readPipe) {
    child.kill('SIGKILL');
    await releaseLaunchLock();
    throw new Error('Chrome did not expose the CDP pipe on fds 3/4');
  }

  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitedPromise = new Promise<void>((resolve) => {
    if (exited) return resolve();
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  const transport = new PipeTransport(writePipe as never, readPipe as never);
  const client = new CdpClient(transport, opts);

  try {
    await Promise.race([client.send('Target.getTargets'), spawnFailed]);
    // A successful handshake is not the same as a live browser. Chrome can
    // complete the handshake and then be terminated cleanly a moment later.
    // Symptom without this check: every subsequent command fails with
    // "CDP client closed" against a browser that looks fine on screen.
    await Promise.race([exitedPromise, delay(STABILITY_WINDOW_MS)]);
    if (exited) throw new Error('browser exited immediately after handshake');
    await client.send('Target.getTargets');
  } catch (err) {
    // The pipe closing and the child exiting are separate events and they do
    // not arrive in a fixed order, so give the exit a moment to land before
    // deciding whether this was a retryable startup failure or a real
    // protocol error. Without this wait the classification is a coin flip.
    await Promise.race([exitedPromise, delay(1_500)]);
    const exitedBeforeCleanup = exited;
    client.close();
    // A failed spawn emits error, not exit, and has no PID to terminate.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4_000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    await waitForProfileProcessesToExit(profileDir);
    await releaseLaunchLock();
    const detail = stderrTail.trim().split('\n').slice(-3).join(' | ');
    if (exitedBeforeCleanup) {
      throw new EarlyExitError(
        `Chrome exited during startup (pid=${child.pid} code=${child.exitCode} signal=${child.signalCode})` +
          (detail ? `: ${detail}` : ''),
      );
    }
    throw new Error(`CDP handshake failed: ${(err as Error).message}${detail ? ` | ${detail}` : ''}`);
  }

  let closing: Promise<void> | undefined;
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  // The whole group: a helper left behind holds the profile and a share of a core.
  const kill = (): void => {
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  };
  const exitWithin = (ms: number): Promise<boolean> => new Promise((resolve) => {
    if (!running()) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });

  const close = (): Promise<void> => closing ??= (async () => {
    // Ask Chrome to quit first. It flushes its cookie store and profile on
    // the way out; dropping the pipe or signalling it can cut that short,
    // and on Linux a session signed in a moment earlier came back signed
    // out. Signals stay as the fallback for a browser that will not answer.
    // Written to the pipe directly rather than through the client: the
    // client's allow-list keeps Browser.close away from everything that
    // drives pages, and the launcher, which owns the process and could
    // signal it anyway, is the one place a graceful quit belongs.
    if (running()) {
      try {
        transport.send({ id: QUIT_ID, method: 'Browser.close' });
      } catch {
        /* the pipe is already gone; the kill below still applies */
      }
      await exitWithin(CLOSE_GRACE_MS);
    }
    try {
      client.close();
    } catch {
      /* already down */
    }
    // A Chrome that did not quit in time is not asked again: one that stopped
    // answering ignores a SIGTERM just as it ignored Browser.close.
    if (running()) {
      kill();
      await exitWithin(2_000);
    } else if (process.platform !== 'win32' && child.pid) {
      // Chrome quit; a helper that outlived it goes too.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is empty */ }
    }
    await waitForProfileProcessesToExit(profileDir);
    await releaseLaunchLock();
  })();

  return { client, process: child, profileDir, close, kill };
}

/**
 * Attach to a Chrome that is already listening on a loopback debugging port.
 *
 * Used when we did not start the browser and so cannot hold a pipe. The
 * browser's lifetime is not ours: `close()` here drops the connection and
 * leaves Chrome running, which is the correct behaviour for a browser someone
 * else owns.
 */
export async function connectToChrome(
  opts: { port: number; host?: string } & CdpClientOptions,
): Promise<Omit<Launched, 'process'> & { process: null }> {
  const wsUrl = await WebSocketTransport.discover(opts.port, opts.host ?? '127.0.0.1');
  const transport = await WebSocketTransport.connect(wsUrl);
  const client = new CdpClient(transport as never, opts);
  await client.send('Target.getTargets');

  return {
    client,
    process: null,
    profileDir: '(attached — profile owned by the running browser)',
    async close() {
      client.close();
    },
  };
}
