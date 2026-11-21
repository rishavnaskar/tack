/**
 * The page and its assets.
 *
 * Fonts and brand images are served from allow-lists by name: the request
 * path is only ever a key into a map, so no part of a URL reaches the
 * filesystem and there is nothing for a traversal to traverse.
 */

import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

const UI = new URL('./ui.html', import.meta.url);

/**
 * The two typefaces the interface is set in, bundled rather than fetched.
 * They are served without a token because a font file carries nothing — see
 * the note at the auth check.
 */
const FONTS = new Map<string, URL>([
  ['host-grotesk.woff2', new URL('./fonts/host-grotesk.woff2', import.meta.url)],
  ['jetbrains-mono.woff2', new URL('./fonts/jetbrains-mono.woff2', import.meta.url)],
]);

/** The mark and favicons, same rules as the fonts: fixed names, no token. */
const BRAND = new Map<string, { file: URL; type: string }>([
  ['favicon.svg', { file: new URL('./brand/favicon.svg', import.meta.url), type: 'image/svg+xml' }],
  ['favicon.ico', { file: new URL('./brand/favicon.ico', import.meta.url), type: 'image/x-icon' }],
  ['apple-touch-icon.png', { file: new URL('./brand/apple-touch-icon.png', import.meta.url), type: 'image/png' }],
  ['mark-light.svg', { file: new URL('./brand/mark-light.svg', import.meta.url), type: 'image/svg+xml' }],
  ['mark-dark.svg', { file: new URL('./brand/mark-dark.svg', import.meta.url), type: 'image/svg+xml' }],
]);

export async function serveBrand(res: ServerResponse, name: string): Promise<void> {
  const asset = BRAND.get(name);
  if (!asset) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=86400' });
  res.end(await readFile(asset.file));
}

export async function serveFont(res: ServerResponse, name: string): Promise<void> {
  const file = FONTS.get(name);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'font/woff2',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(await readFile(file));
}

export async function serveUi(res: ServerResponse): Promise<void> {
  const html = await readFile(UI, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/**
 * What a person sees when they open the address without the link's key: a
 * bookmark, or the address typed by hand. It says where the link is, and
 * nothing about this process.
 */
const LOCKED = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fanfold</title>
<link rel="icon" href="/favicon.svg">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #F7F6F4; color: #0B0B0C; font: 15px/1.55 system-ui, sans-serif; }
  main { max-width: 440px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  p { margin: 0 0 10px; color: #4a4744; }
  @media (prefers-color-scheme: dark) { body { background: #0B0B0C; color: #F7F6F4; } p { color: #b9b4ad; } }
</style>
</head>
<body>
<main>
  <h1>You need your private link</h1>
  <p>Fanfold gives you a link each time it starts. That link has a key for this computer, and this address is missing it.</p>
  <p>Go back to where you started Fanfold and open the link from there.</p>
</main>
</body>
</html>
`;

/** The name each key-free link's page goes by on the page that says it opened. */
const COPY = {
  review: 'Review',
  setup: 'Setup',
  signin: 'Sign-in',
  expiredTitle: 'This link has expired',
  expired: 'Fanfold makes a new private link each time it starts, and this one is from an earlier start, so its key no longer works.',
  expiredNext: 'Go back to where you started Fanfold and open the newest link from there.',
};

/**
 * The page keeps its key for the tab, out of the address (ui.html). A reload
 * comes here without it, and this puts it back. A key that did not open
 * Fanfold is forgotten, so an old tab does not keep trying it.
 */
const RESTORE = `<script>
(function () {
  var KEY = 'fanfold-key';
  var store = null;
  try { store = window.sessionStorage; } catch (e) { return; }
  var params = new URLSearchParams(location.search);
  var tried = params.get('t');
  if (tried !== null) {
    try { if (store.getItem(KEY) === tried) store.removeItem(KEY); } catch (e) { /* nothing kept */ }
    params.delete('t');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    return;
  }
  var kept = null;
  try { kept = store.getItem(KEY); } catch (e) { /* nothing kept */ }
  if (kept) location.replace('/?t=' + encodeURIComponent(kept) + location.hash);
})();
</script>
`;

/**
 * What the Review, Setup and sign-in links answer with. The real page opens
 * in its own tab, from this process: the link itself carries no key, so it
 * can be shown to an agent and clicked by the person. A link followed again
 * within a few seconds opens nothing more, and says so.
 */
const opened = (page: string, now: boolean): string => LOCKED
  .replace(/<h1>[\s\S]*?<\/h1>/, now ? `<h1>${page} is open in a new tab</h1>` : `<h1>${page} opened a moment ago</h1>`)
  .replace(/<p>[\s\S]*<\/p>/, now
    ? `<p>Fanfold opened your ${page} page in a new browser tab. You can close this one.</p>`
    : `<p>Fanfold opened your ${page} page in a new browser tab a few seconds ago, so it didn’t open another. Look for that tab, or open this link again in a few seconds if you can’t find it.</p>`);

export function serveOpened(res: ServerResponse, page: 'review' | 'setup' | 'signin', now = true): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(opened(COPY[page], now));
}

/** `expired`: the address carried a key, just not this start's. */
export function serveLocked(res: ServerResponse, opts: { expired?: boolean } = {}): void {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  const page = opts.expired
    ? LOCKED
      .replace(/<h1>[\s\S]*?<\/h1>/, `<h1>${COPY.expiredTitle}</h1>`)
      .replace(/<p>[\s\S]*<\/p>/, `<p>${COPY.expired}</p>\n  <p>${COPY.expiredNext}</p>`)
    : LOCKED;
  res.end(page.replace('</head>', `${RESTORE}</head>`));
}
