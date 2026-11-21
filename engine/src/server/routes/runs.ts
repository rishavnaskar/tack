/**
 * What runs did and found: a run's steps, what a collecting task gathered and
 * its report, the owner's word on an action a run left in doubt, and learning
 * from recent runs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../http.ts';
import * as Bodies from '../bodies.ts';
import { renderReport } from '../../agent/report.ts';
import { learnFromRuns } from '../../agent/learn.ts';
import type { RouteContext } from './context.ts';

/** What the person reads. */
const COPY = {
  noEffect: 'That action is not waiting to be checked.',
  noObjective: 'Those results are gone.',
};

/** Answer a request if it is one of these routes. False means "not mine". */
export async function handleRunRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  // The owner checked by hand whether an action a run attempted went out.
  const effect = url.pathname.match(/^\/api\/effects\/([\w-]+)\/settle$/);
  if (effect && req.method === 'POST') {
    const body = await readBody(req, Bodies.SettleEffect);
    if (ctx.app.store.getEffect(effect[1])?.status !== 'intended') {
      sendJson(res, { error: COPY.noEffect }, 404);
      return true;
    }
    const status = body.went ? 'committed' : 'failed';
    ctx.app.store.settleEffect(effect[1], status, 'checked by the owner');
    ctx.emit({ type: 'effect_settled', key: effect[1], status });
    sendJson(res, { settled: status });
    return true;
  }
  const run = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
  if (run && req.method === 'GET') {
    const row = ctx.app.store.getRun(run[1]);
    sendJson(res, {
      steps: ctx.app.store.steps(run[1]),
      objectiveId: (row?.objective_id as string) ?? null,
      // What a finished answer's footer says again when the thread is reopened.
      startedAt: (row?.started_at as string) ?? null,
      endedAt: (row?.ended_at as string) ?? null,
      costUsd: row?.cost_usd == null ? null : Number(row.cost_usd),
    });
    return true;
  }
  const objective = url.pathname.match(/^\/api\/objectives\/([\w-]+)$/);
  if (objective && req.method === 'GET') {
    collected(ctx, res, objective[1]);
    return true;
  }
  const report = url.pathname.match(/^\/api\/objectives\/([\w-]+)\/report$/);
  if (report && req.method === 'GET') {
    reportOf(ctx, res, report[1]);
    return true;
  }
  if (url.pathname === '/api/learn' && req.method === 'POST') {
    await learn(ctx, res);
    return true;
  }
  return false;
}

/** What a run collected, for the preview. */
function collected(ctx: RouteContext, res: ServerResponse, id: string): void {
  const objective = ctx.app.objectives.get(id);
  if (!objective) return sendJson(res, { error: COPY.noObjective }, 404);
  sendJson(res, {
    objective,
    found: ctx.app.objectives.count(id),
    findings: ctx.app.objectives.findings(id),
  });
}

/**
 * The same rows as markdown.
 *
 * Rendered from the database on request rather than read back off disk, so
 * it cannot be stale and exists whether or not the file was written.
 */
function reportOf(ctx: RouteContext, res: ServerResponse, id: string): void {
  const objective = ctx.app.objectives.get(id);
  if (!objective) return sendJson(res, { error: COPY.noObjective }, 404);
  const findings = ctx.app.objectives.findings(id);
  // When the rows were collected, not when the file was asked for.
  const last = findings.reduce((t, f) => (f.at > t ? f.at : t), '');
  const body = renderReport(objective, findings, last && isFinite(Date.parse(last)) ? new Date(last) : new Date());
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `inline; filename="${objective.report ?? 'findings.md'}"`,
  });
  res.end(body);
}

/** Reflect on recent runs and gate whatever comes out. Offline by design. */
async function learn(ctx: RouteContext, res: ServerResponse): Promise<void> {
  const result = await learnFromRuns({
    model: ctx.app.model,
    store: ctx.app.store,
    memory: ctx.app.memory,
  });
  ctx.emit({ type: 'learned', result });
  sendJson(res, result);
}
