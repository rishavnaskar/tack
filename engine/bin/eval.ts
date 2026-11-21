#!/usr/bin/env node
/** Run the action-selection eval across model tiers. */
import { ModelClient, apiKeyFromEnv } from '../src/model/client.ts';
import { loadCases, runEval, formatReport } from '../src/eval/action-eval.ts';
import type { Tier } from '../src/model/pricebook.ts';
import { loadEnv } from '../src/lib/env.ts';

loadEnv();

const tiers = (process.argv.slice(2).filter((a) => !a.startsWith('-')) as Tier[]);
const selected: Tier[] = tiers.length ? tiers : ['step', 'vision', 'plan'];

const cases = await loadCases();
console.log(`${cases.length} cases\n`);
const client = new ModelClient({ apiKey: apiKeyFromEnv() });

for (const tier of selected) {
  const report = await runEval(client, tier, cases);
  console.log(formatReport(report));
  console.log();
}
