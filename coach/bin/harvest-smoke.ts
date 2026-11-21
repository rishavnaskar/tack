// Live check of the harvest path: node --no-warnings coach/bin/harvest-smoke.ts ["AI Product Manager"] [Bengaluru] [10]
// Uses no cache unless SMOKE_CACHE=1, so the numbers are a cold run.

import { harvest } from '../src/engine-live.ts';
import { BOARDS } from '../src/boards.ts';

const role = process.argv[2] || 'AI Product Manager';
const location = process.argv[3] || 'Bengaluru';
const count = Number(process.argv[4]) || 10;
const verbose = process.env.SMOKE_VERBOSE === '1';

const t0 = Date.now();
const r = await harvest(role, location, count, {
  cacheDir: process.env.SMOKE_CACHE === '1' ? undefined : null,
  trace: { step: (step, detail) => { if (verbose) console.log(`  [${step}] ${detail}`); } },
});
const ms = Date.now() - t0;

if (!r.ok) {
  console.log(`not available: ${r.reason} (${ms} ms)`);
  process.exit(1);
}
console.log(`boards answered: ${r.boards.answered}/${BOARDS.length}, roles scanned: ${r.scanned}, fitting "${role}": ${r.matched}, ${ms} ms`);
for (const f of r.boards.failed) console.log(`  failed: ${f.board}: ${f.error}`);
console.log(`${r.postings.length} postings for "${role}" near ${location}:`);
for (const p of r.postings) {
  console.log(`  ${p.title} | ${p.company} | ${p.location} | ${p.source} | ${p.seniority}/${p.roleFamily}/${p.companySize} | ${p.text.length} chars${p.salary ? ` | ${p.salary}` : ''}`);
}
