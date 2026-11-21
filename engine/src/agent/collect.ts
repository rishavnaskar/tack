/**
 * Collecting toward a target: opening the objective, banking rows the model
 * read, and reading several pages at once.
 *
 * Kept apart from the loop so the loop reads as a sequence of steps. Nothing
 * here can actuate a page: fan-out only navigates and reads.
 */

import type { AgentAction } from './prompt.ts';
import type { AgentEvent, ModelLike } from './loop.ts';
import type { Objectives, Objective, Progress, Finding } from './objective.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';
import { runFanout, MAX_URLS, type FanoutItem } from './fanout.ts';
import { rowUrl } from './actions.ts';

/** Open the thread's objective on the first step that declares a count. */
export function openObjectiveIfAsked(a: {
  objectives: Objectives; current: Objective | null; action: AgentAction; conversationId: string; goal: string;
}): Objective | null {
  if (a.current) return a.current;
  if (!a.action.objective || a.action.objective.targetCount <= 0) return null;
  return a.objectives.open({
    conversationId: a.conversationId, goal: a.goal,
    targetCount: a.action.objective.targetCount,
    what: a.action.objective.what || null,
  });
}

/** Bank findings against the objective. Deduped and capped at the target by the store. */
export function bank(objectives: Objectives, objective: Objective, findings: Finding[], runId: string): { added: number; progress: Progress } {
  const added = objectives.recordAll(objective.id, findings, runId);
  return { added, progress: objectives.progress(objective.id)! };
}

/** The rows a model reported on this step, as findings tied to the page they came from. */
export function rowsAsFindings(objective: Objective, rows: NonNullable<AgentAction['findings']>, pageUrl: string): Finding[] {
  return rows.map((r) => ({
    kind: objective.what ?? 'item',
    label: r.label,
    data: { label: r.label, detail: r.detail, url: rowUrl(r.url, pageUrl) },
    sourceUrl: pageUrl,
  }));
}

/** What the model is told after a bank, so it knows what is still missing. */
export function describeBanked(added: number, offered: number, p: Progress): string {
  return `recorded ${added} new (${offered - added} already had) — ` +
    `${p.found}${p.objective.targetCount ? ' of ' + p.objective.targetCount : ''} so far`;
}

export interface FanoutStepResult {
  urls: string[];
  findings: Finding[];
  items: FanoutItem[];
  failed: FanoutItem[];
  costUsd: number;
  ms: number;
}

/** Read up to MAX_URLS pages at once, reporting each as it finishes. */
export async function readPagesAtOnce(a: {
  action: AgentAction; page: BrowserRuntime; model: ModelLike; signal?: AbortSignal;
  kind?: string; step: number; onEvent: (e: AgentEvent) => void;
}): Promise<FanoutStepResult | null> {
  const urls = (a.action.urls ?? []).slice(0, MAX_URLS);
  if (!urls.length) return null;
  const started = Date.now();
  const out = await runFanout({
    urls, extract: a.action.value || 'the rows this page lists',
    page: a.page, model: a.model, signal: a.signal, kind: a.kind,
    onItem: (item, done, total) => a.onEvent({
      type: 'fanout', step: a.step, url: item.url, rows: item.findings.length,
      error: item.error, done, total,
    }),
  });
  return {
    urls, findings: out.findings, items: out.items,
    failed: out.items.filter((i) => i.error), costUsd: out.costUsd, ms: Date.now() - started,
  };
}
