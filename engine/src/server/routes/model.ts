/**
 * The person's own Gemini key: where Fanfold's model comes from, and saving
 * or removing the key. Alpha only: goes when plans arrive.
 *
 * The key goes to Google once, to check it, and is then kept encrypted. No
 * answer here carries it: the last four characters tell keys apart.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../http.ts';
import { ALPHA_GEMINI, checkGeminiKey, cleanKey, COPY } from '../../model/source.ts';
import * as Bodies from '../bodies.ts';
import type { RouteContext } from './context.ts';

/** What the page is told about the model. */
export function modelView(ctx: RouteContext): Record<string, unknown> {
  const { source, hint } = ctx.app.modelSource;
  return {
    source,
    configured: ctx.app.modelConfigured,
    refused: ctx.app.model.refusal?.message ?? null,
    hint,
    alpha: true,
    keyPage: ALPHA_GEMINI.keyPage,
  };
}

/** Answer a request if it is one of these routes. False means "not mine". */
export async function handleModelRoutes(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (url.pathname === '/api/model' && req.method === 'GET') {
    sendJson(res, modelView(ctx));
    return true;
  }
  if (url.pathname === '/api/model/key' && req.method === 'PUT') {
    const body = await readBody(req, Bodies.ModelKey);
    const key = cleanKey(body.key);
    if (!key) {
      sendJson(res, { error: COPY.notAKey, field: 'key' }, 400);
      return true;
    }
    const check = await checkGeminiKey(key, fetchImpl);
    if (!check.ok) {
      // Nothing is kept from a key Google turned down or could not check.
      ctx.log.info('a Gemini key was not saved', { refused: check.refused });
      sendJson(res, { error: check.error, ...(check.refused ? { field: 'key' } : {}) }, check.refused ? 400 : 502);
      return true;
    }
    await ctx.app.saveModelKey(key);
    sendJson(res, modelView(ctx));
    return true;
  }
  if (url.pathname === '/api/model/key' && req.method === 'DELETE') {
    await ctx.app.removeModelKey();
    sendJson(res, modelView(ctx));
    return true;
  }
  return false;
}
