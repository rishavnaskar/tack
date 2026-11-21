// Lays the engine's application windows out side by side. The engine keeps Chrome on a private
// debugging pipe and cascades its windows on a laptop screen, so on macOS Tack moves them through
// Chrome's own scripting interface, matching windows by the page each session is on.

import { execFile } from 'node:child_process';

export interface Rect { left: number; top: number; width: number; height: number }

/** A grid for n windows on this screen: two across up to four windows, three across past that. */
export function grid(n: number, screen: Rect): Rect[] {
  if (n <= 0) return [];
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const w = Math.floor(screen.width / cols);
  const h = Math.floor(screen.height / rows);
  return Array.from({ length: n }, (_, i) => ({
    left: screen.left + (i % cols) * w, top: screen.top + Math.floor(i / cols) * h, width: w, height: h,
  }));
}

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => (err ? fail(Object.assign(new Error(`${err.message}\n${stderr}`.trim()), { killed: err.killed })) : ok(stdout.trim())));
  });
}

/** The main screen's usable area, through AppKit (no other app is asked). */
async function screenArea(): Promise<Rect | null> {
  const js = 'ObjC.import("AppKit"); const s = $.NSScreen.mainScreen; const f = s.frame; const v = s.visibleFrame; '
    + 'JSON.stringify({ left: v.origin.x, top: f.size.height - v.origin.y - v.size.height, width: v.size.width, height: v.size.height })';
  try { return JSON.parse(await run('osascript', ['-l', 'JavaScript', '-e', js])) as Rect; } catch { return null; }
}

function appName(chromePath?: string): string {
  const m = chromePath?.match(/\/([^/]+)\.app\//);
  return m ? m[1] : 'Google Chrome for Testing';
}

/**
 * Moves the windows showing these pages into a grid, in the order given. A window is matched by
 * its active tab's address; ones that match nothing are left where they are. Never throws.
 */
export async function tileWindows(pages: { key: string; hosts: string[] }[], o: { chromePath?: string; platform?: NodeJS.Platform } = {}): Promise<{ moved: number; note: string }> {
  if ((o.platform ?? process.platform) !== 'darwin' || process.env.TACK_TILE === '0' || process.env.TACK_ENGINE_HEADLESS === '1') {
    return { moved: 0, note: 'tiling is off here' };
  }
  if (!pages.length) return { moved: 0, note: 'no windows to tile' };
  const screen = await screenArea();
  if (!screen) return { moved: 0, note: 'could not read the screen size' };
  const cells = grid(pages.length, screen);
  const want = pages.map((p, i) => ({ hosts: p.hosts.map((h) => h.toLowerCase()), b: cells[i] }));
  if (blocked) return { moved: 0, note: blocked };
  // Asking a browser that is not running would start one: check first.
  const js = `
const app = Application(${JSON.stringify(appName(o.chromePath))});
if (!app.running()) { '0'; } else {
const want = ${JSON.stringify(want)};
let moved = 0; const used = {};
const wins = app.windows();
for (const w of want) {
  for (let i = 0; i < wins.length; i++) {
    if (used[i]) continue;
    let url = '';
    try { url = String(wins[i].activeTab().url()).toLowerCase(); } catch (e) { continue; }
    if (!w.hosts.some((h) => url.includes(h))) continue;
    wins[i].bounds = { x: w.b.left, y: w.b.top, width: w.b.width, height: w.b.height };
    used[i] = true; moved++; break;
  }
}
String(moved); }`;
  try {
    const moved = Number(await run('osascript', ['-l', 'JavaScript', '-e', js])) || 0;
    return { moved, note: `${moved} of ${pages.length} windows side by side` };
  } catch (e) {
    const err = e as Error & { killed?: boolean };
    const msg = err.message.replace(/^Command failed: osascript[\s\S]*?\n(?=\S)/, '');
    // Waiting on the person's answer to macOS's Automation question, or refused: asked once, not again this run.
    if (err.killed || /-1743|not authori[sz]ed|not allowed|timed out/i.test(msg)) {
      blocked = 'macOS has not allowed Tack to arrange Chrome\'s windows yet: allow it under System Settings, Privacy & Security, Automation';
      return { moved: 0, note: blocked };
    }
    return { moved: 0, note: `could not arrange the windows: ${msg.split('\n').slice(-2).join(' ').slice(0, 160)}` };
  }
}

let blocked = '';
