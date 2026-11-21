/**
 * How big and how slow is an observation, on pages the agent would meet?
 *
 * Phase 0 asks for runtime measurements across representative pages, and the
 * number that matters is not a benchmark score: it is whether the structural
 * observation stays inside the budget that makes this approach cheaper than
 * screenshots. A page that takes 150ms to walk and 400 tokens to describe is
 * the whole argument for CDP over vision.
 *
 * Real pages, fetched read-only over the network — fixtures cannot show what
 * a news homepage or a documentation site actually costs. Nothing is clicked,
 * nothing is signed into, and no page requiring a login is included.
 *
 *   npm run bench            # the default set
 *   npm run bench -- <url>…  # specific pages
 */

import { launchChrome } from '../src/cdp/launcher.ts';
import { Page } from '../src/observe/page.ts';
import { renderObservation } from '../src/observe/render.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Launched } from '../src/cdp/launcher.ts';

/**
 * Ten pages chosen for structural variety, not popularity: a trivial
 * document, long prose, reference tables, a heavy news front page, a search
 * result list, a client-rendered app, a form, a listing, a media-heavy page,
 * and a standards document that is mostly nested markup.
 */
const PAGES: Array<[string, string]> = [
  ['minimal static', 'https://example.com/'],
  ['long article', 'https://en.wikipedia.org/wiki/Chrome_DevTools_Protocol'],
  ['reference tables', 'https://developer.mozilla.org/en-US/docs/Web/API/Document'],
  ['news front page', 'https://text.npr.org/'],
  ['search results', 'https://duckduckgo.com/html/?q=structural+web+agent'],
  ['client-rendered app', 'https://github.com/nodejs/node'],
  ['form-heavy', 'https://httpbin.org/forms/post'],
  ['listing', 'https://news.ycombinator.com/'],
  ['media-heavy', 'https://commons.wikimedia.org/wiki/Main_Page'],
  ['spec markup', 'https://html.spec.whatwg.org/multipage/forms.html'],
];

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((u) => [new URL(u).hostname, u] as [string, string])
  : PAGES;

/**
 * A fresh browser per page.
 *
 * Not fastidiousness: measuring them all in one browser produces a cascade of
 * `net::ERR_ABORTED`. A page that times out leaves its navigation in flight —
 * abandoning the wait does not abandon the work — and the orphan aborts
 * whatever is navigated next, so one slow site makes every page after it look
 * unreachable. A measurement tool that contaminates its own later samples is
 * worse than no measurement.
 */
async function measure(label: string, url: string): Promise<Row | null> {
  const profileDir = await mkdtemp(join(tmpdir(), 'ba-bench-'));
  let launched: Launched | null = null;
  let page: Page | null = null;
  try {
    launched = await launchChrome({ profileDir, headless: true });
    page = await Page.first(launched.client);
    await withDeadline(label, 40_000, page.goto(url, 30_000));
    // Twice: the first observation on a fresh document also pays for
    // serializer injection, which is not what a step in a run costs.
    await withDeadline(label, 20_000, page.observe({ interactive: false }));
    const obs = await withDeadline(label, 20_000, page.observe({ interactive: false }));
    const text = renderObservation(obs);
    process.stdout.write(`  ${label.padEnd(20)} ok\n`);
    return {
      label,
      nodes: obs.nodes.length,
      walkMs: obs.walkMs,
      totalMs: obs.totalMs,
      chars: text.length,
      tokens: Math.ceil(text.length / 4),
      truncated: obs.truncated ? (obs.truncationReason ?? 'yes') : '-',
    };
  } catch (err) {
    process.stdout.write(`  ${label.padEnd(20)} FAILED: ${(err as Error).message}\n`);
    return null;
  } finally {
    await page?.close().catch(() => {});
    await launched?.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true });
  }
}

/** Give up on a page rather than let one slow site hold the whole run. */
async function withDeadline<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer!);
  }
}

interface Row {
  label: string; nodes: number; walkMs: number; totalMs: number;
  chars: number; tokens: number; truncated: string;
}
const rows: Row[] = [];
for (const [label, url] of targets) {
  const row = await measure(label, url);
  if (row) rows.push(row);
}
if (!rows.length) {
  process.stdout.write('\nNo page could be measured.\n');
  process.exit(1);
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);
process.stdout.write(`\n${'page'.padEnd(20)} ${pad('nodes', 6)} ${pad('walk', 6)} ${pad('total', 7)} ${pad('tokens', 7)}  truncated\n`);
for (const r of rows) {
  process.stdout.write(
    `${r.label.padEnd(20)} ${pad(r.nodes, 6)} ${pad(r.walkMs + 'ms', 6)} ${pad(r.totalMs + 'ms', 7)} ${pad(r.tokens, 7)}  ${r.truncated}\n`,
  );
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
process.stdout.write(
  `\n${rows.length} pages measured. `
  + `median walk ${median(rows.map((r) => r.walkMs))}ms, `
  + `median total ${median(rows.map((r) => r.totalMs))}ms, `
  + `median ${median(rows.map((r) => r.tokens))} tokens, `
  + `worst walk ${Math.max(...rows.map((r) => r.walkMs))}ms, `
  + `worst ${Math.max(...rows.map((r) => r.tokens))} tokens.\n`,
);
