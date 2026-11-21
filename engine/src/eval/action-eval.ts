/**
 * Tier-1 eval: action selection against saved page snapshots.
 *
 * No browser, no network beyond the model call, deterministic inputs. Each
 * case states a goal, a snapshot, the history so far, and the set of actions
 * a competent agent could take. It exists to answer questions that opinion
 * cannot: which model tier is actually good enough for the inner loop, and
 * whether a prompt change helped or hurt.
 *
 * Grading is programmatic — an exact match on kind, and on ref where the case
 * names one. No LLM judge: a judge would have to be calibrated before it
 * could be trusted as a gate, and these cases do not need one.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ModelClient } from '../model/client.ts';
import { buildStepMessages, ACTION_SCHEMA, STEP_MAX_TOKENS, type AgentAction } from '../agent/prompt.ts';
import { MODELS, type Tier } from '../model/pricebook.ts';
import { parseObservation } from './derive-cases.ts';

export interface EvalCase {
  name: string;
  why: string;
  goal: string;
  page: string;
  history: string[];
  /**
   * Actions a competent agent could take.
   *
   * `ref` pins an exact element. `role`/`name` pin it semantically, which is
   * what a case derived from a real trajectory can state. An entry with
   * NEITHER accepts any target of that kind, which for `click` means any
   * click on any control — so it is only ever correct for kinds that have no
   * target at all, like `scroll` or `done`.
   */
  accept: Array<{ kind: string; ref?: string; role?: string; name?: string }>;
}

export interface CaseResult {
  name: string;
  pass: boolean;
  got: { kind: string; ref?: string } | null;
  expected: Array<{ kind: string; ref?: string }>;
  reason: string;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface EvalReport {
  tier: Tier;
  modelId: string;
  passed: number;
  total: number;
  accuracy: number;
  p50LatencyMs: number;
  totalCostUsd: number;
  results: CaseResult[];
}

export async function loadCases(dir?: string): Promise<EvalCase[]> {
  const root = dir ?? fileURLToPath(new URL('../../evals/action-selection/', import.meta.url));
  const files = (await readdir(root)).filter((f) => f.endsWith('.json')).sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    cases.push(JSON.parse(await readFile(`${root}${f}`, 'utf8')) as EvalCase);
  }
  return cases;
}

function matches(got: AgentAction, accept: EvalCase['accept'], page: string): boolean {
  return accept.some((a) => {
    if (a.kind !== got.kind) return false;
    if (a.ref !== undefined && normaliseRef(got.ref) !== a.ref) return false;
    if (a.role !== undefined || a.name !== undefined) {
      // Resolve what the model actually chose on this page, and compare the
      // control rather than the ref. A case that says "click Show more" must
      // not be satisfied by clicking something else.
      const ref = normaliseRef(got.ref);
      const chosen = ref ? parseObservation(page).find((n) => n.ref === ref) : undefined;
      if (!chosen) return false;
      if (a.role !== undefined && chosen.role !== a.role) return false;
      if (a.name !== undefined && chosen.name !== a.name) return false;
    }
    return true;
  });
}

function normaliseRef(ref: string | undefined): string {
  return (ref ?? '').replace(/^@/, '').trim();
}

export interface RunEvalOptions {
  concurrency?: number;
  /** Extra lessons injected into every case, to measure their effect. */
  lessons?: string[];
}

export async function runEval(
  client: ModelClient,
  tier: Tier,
  cases: EvalCase[],
  options: RunEvalOptions = {},
): Promise<EvalReport> {
  const concurrency = options.concurrency ?? 4;
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      results[i] = await runCase(client, tier, cases[i], options.lessons);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const passed = results.filter((r) => r.pass).length;

  return {
    tier,
    modelId: MODELS[tier].id,
    passed,
    total: cases.length,
    accuracy: cases.length ? passed / cases.length : 0,
    p50LatencyMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
    results,
  };
}

async function runCase(client: ModelClient, tier: Tier, c: EvalCase, lessons?: string[]): Promise<CaseResult> {
  try {
    const res = await client.completeJson<AgentAction>({
      tier,
      // The loop's budget: a case cut off mid-reply would score as a wrong choice.
      maxTokens: STEP_MAX_TOKENS,
      schema: ACTION_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      messages: buildStepMessages({ goal: c.goal, page: c.page, history: c.history, lessons }),
    });
    const action = res.content;
    return {
      name: c.name,
      pass: matches(action, c.accept, c.page),
      got: { kind: action.kind, ref: normaliseRef(action.ref) || undefined },
      expected: c.accept,
      reason: action.reason ?? '',
      latencyMs: res.usage.latencyMs,
      costUsd: res.usage.reportedCostUsd ?? res.usage.computedCostUsd,
    };
  } catch (err) {
    return {
      name: c.name, pass: false, got: null, expected: c.accept, reason: '',
      latencyMs: 0, costUsd: 0, error: (err as Error).message.slice(0, 200),
    };
  }
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.modelId}  ${report.passed}/${report.total} (${(report.accuracy * 100).toFixed(0)}%)  ` +
      `p50 ${report.p50LatencyMs}ms  $${report.totalCostUsd.toFixed(6)}`,
  );
  for (const r of report.results) {
    if (r.pass) continue;
    const got = r.error ? `ERROR ${r.error}` : `${r.got?.kind} ${r.got?.ref ?? ''}`.trim();
    const want = r.expected.map((e) => `${e.kind}${e.ref ? ' ' + e.ref : ''}`).join(' | ');
    lines.push(`   ✗ ${r.name}: got ${got}, wanted ${want}`);
    if (r.reason) lines.push(`     reason: ${r.reason.slice(0, 140)}`);
  }
  return lines.join('\n');
}
