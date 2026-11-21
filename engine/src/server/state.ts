/**
 * Parts of the page's state worked out from the app alone: what Fanfold's
 * own model cost today, what a previous start left in doubt, and what
 * Fanfold would put in each question waiting on the owner.
 */
import { tooManyEssaysSaid } from '../jobs/answerer.ts';
import { suggestionFor } from '../jobs/known.ts';
import type { Question } from '../jobs/questions.ts';
import { UNPRICED } from '../model/pricebook.ts';
import type { RouteContext } from './routes/context.ts';
import { startOfToday, type QuestionPlace } from './routes/jobs.ts';

/**
 * What Fanfold's own model cost today: the runs started today, and the
 * calls made outside any run (reading a document, telling an answer from a
 * task). Null when it was not used today, so nothing reads "$0.00", and
 * unknown when a call today went to a model with no known price.
 */
export function spendToday(ctx: RouteContext): { todayUsd: number | null; unknown: boolean } {
  const start = startOfToday();
  const raw = ctx.app.store.raw;
  const used = (raw.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE at >= ?').get(start) as { n: number }).n;
  if (!used) return { todayUsd: null, unknown: false };
  const unpriced = (raw.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE at >= ? AND reported_cost_usd IS NULL AND price_book_version LIKE ?')
    .get(start, `%${UNPRICED}`) as { n: number }).n;
  if (unpriced) return { todayUsd: null, unknown: true };
  const runs = (raw.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM runs WHERE started_at >= ?').get(start) as { usd: number }).usd;
  const loose = (raw.prepare('SELECT COALESCE(SUM(COALESCE(reported_cost_usd, computed_cost_usd)), 0) AS usd FROM usage_events WHERE at >= ? AND run_id IS NULL')
    .get(start) as { usd: number }).usd;
  return { todayUsd: Number(runs) + Number(loose), unknown: false };
}

/**
 * What a previous start left in doubt, each action with what it was and the
 * page it was on, so the owner can check it. An action of a run still going
 * is in flight, not in doubt.
 */
export function unfinishedView(ctx: RouteContext): Record<string, unknown> {
  const u = ctx.app.unfinishedBusiness();
  const step = ctx.app.store.raw.prepare('SELECT url FROM steps WHERE run_id = ? AND idx = ?');
  const effects = u.unsettledEffects.flatMap((e) => {
    const run = ctx.app.store.getRun(String(e.run_id));
    if (run?.status === 'running') return [];
    const at = step.get(String(e.run_id), Number(e.step_idx)) as { url?: string | null } | undefined;
    return [{
      key: String(e.idempotency_key), kind: String(e.kind), target: String(e.target),
      content: e.content == null ? null : String(e.content).slice(0, 400), at: String(e.intended_at),
      url: at?.url ?? null, goal: run ? String(run.goal ?? '').slice(0, 200) : null,
    }];
  });
  return { staleRuns: u.staleRuns, staleWorkerRuns: u.staleWorkerRuns, unsettledEffects: effects };
}

/** Each waiting question with what Fanfold would put in it, where that comes from, and the jobs it holds up. */
export async function withSuggestions(ctx: RouteContext, questions: Question[], places: Map<number, QuestionPlace>): Promise<Array<Question & Partial<QuestionPlace> & { suggestion: { value: string; from: string } | null }>> {
  const app = ctx.app;
  // The career record is merged once for every question, not once per question.
  const deps = {
    profile: app.profile, jobs: app.jobs, memory: app.memory,
    careers: app.careers, intents: app.intents, career: questions.length ? await app.career() : null,
  };
  // `tooManyEssays`: its form asked more essays than Fanfold drafts; Review offers to skip the job.
  return Promise.all(questions.map(async (q) => ({ ...q, ...places.get(q.id), tooManyEssays: !q.draft && tooManyEssaysSaid(q.draftWhy), suggestion: await suggestionFor(q, q.askedBy[0] ?? null, deps) })));
}
