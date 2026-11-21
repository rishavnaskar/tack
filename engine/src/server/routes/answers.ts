/**
 * Answering the questions waiting on Review again, on the owner's word.
 *
 * The same sweep runs by itself after a document comes in, the profile
 * changes or the user answers something; this is the button for it. Only the
 * owner's key reaches /api.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http.ts';
import type { RouteContext } from './context.ts';

/** What the owner reads when it could not run. */
export const COPY = {
  failed: 'Fanfold could not check the waiting questions again. Try again in a minute.',
};

const RESOLVE = /^\/api\/questions\/resolve$/;

export async function handleAnswerRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!RESOLVE.test(url.pathname) || req.method !== 'POST') return false;
  const result = await ctx.app.resolveQuestions();
  // A model that is missing or refused is said plainly, so "nothing changed" is not a mystery.
  const model = ctx.app.answerModelProblem;
  if (!result) {
    sendJson(res, { error: COPY.failed, model }, 500);
    return true;
  }
  // Counted from what waits now, so the button can say "answered N, suggested M, K still need you" and never "0 left" while some wait.
  // A suggested one is counted once, among the suggested: K is the rest.
  const open = ctx.app.questions.list('open', 1000);
  const suggested = open.filter((q) => q.draft).length;
  sendJson(res, { ...result, answeredCount: result.answered.length, suggested, left: open.length - suggested, model });
  return true;
}
