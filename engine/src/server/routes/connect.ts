/**
 * What another agent needs to use Fanfold as a tool, and what is connected
 * right now.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { hostOf } from '../../agent/actions.ts';
import type { FanfoldMcp } from '../../mcp/fanfold.ts';
import { readBody, sendJson } from '../http.ts';
import { extensionGaps } from '../../extension/connect.ts';
import { withoutKey } from '../../policy/navigable.ts';
import { stateDir } from '../../daemon/protocol.ts';
import * as Bodies from '../bodies.ts';
import type { RouteContext } from './context.ts';

const MCP_BIN = fileURLToPath(new URL('../../../bin/mcp.ts', import.meta.url));
const EXTENSION_DIR = fileURLToPath(new URL('../../../extension', import.meta.url));

export interface ConnectExtras {
  mcp: FanfoldMcp;
  port(): number | null;
  /** Reaches /mcp only. The person's own key is never handed to an agent. */
  agentToken: string;
}

export function connectView(ctx: RouteContext, extras: ConnectExtras): Record<string, unknown> {
  const port = extras.port();
  return {
    // Run by the host itself. It attaches to this Fanfold when it is open, and starts its own when it is not.
    // The Node that runs Fanfold, whatever older one a host finds on its own path.
    command: process.execPath,
    // A Fanfold keeping its data somewhere of its own is found there, not at the default.
    args: ['--no-warnings', MCP_BIN, ...(process.env.BROWSER_AGENT_STATE_DIR ? ['--state-dir', stateDir()] : [])],
    // For a host that prefers HTTP. The token is this session's and changes on restart.
    endpoint: port ? `http://127.0.0.1:${port}/mcp` : null,
    agentToken: port ? extras.agentToken : null,
    modelConfigured: ctx.app.modelConfigured,
    modelRefused: ctx.app.model.refusal?.message ?? null,
    tools: extras.mcp.tools
      .filter((t) => t.available?.() ?? true)
      .map((t) => ({ name: t.name, title: t.title })),
    sessions: extras.mcp.sessions.list().map((s) => ({
      name: s.name, kind: s.kind, steps: s.step, openedAt: s.openedAt,
      at: s.observation ? hostOf(s.observation.url) : null,
    })),
    waitingPages: ctx.app.parkedRuns().length,
  };
}

/** The extension link as the Browser page shows it. The pairing token is never part of this. */
function extensionView(ctx: RouteContext): Record<string, unknown> {
  const status = ctx.app.extension.status();
  return {
    ...status,
    wanted: ctx.app.browserMode,
    inUse: ctx.app.browserInUse,
    browserOpen: ctx.app.browserStarted,
    problem: ctx.app.browserProblem,
    gaps: extensionGaps(status, ctx.app.sites.list()),
    folder: EXTENSION_DIR,
  };
}

/** The tabs Fanfold is using for its work, each with what it is for, so the person can stop any of them. */
function tabsView(ctx: RouteContext): Record<string, unknown> {
  return {
    tabs: ctx.app.tabsInUse().map((tab) => ({
      targetId: tab.targetId, mode: tab.mode, url: tab.url ? withoutKey(tab.url) : null, owner: tab.owner.kind,
      openedAt: tab.openedAt, waiting: tab.keepUntil !== null, why: tab.keepWhy,
    })),
  };
}

/** Answer a request if it is one of these routes. False means "not mine". */
export async function handleConnectRoutes(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL, extras: ConnectExtras,
): Promise<boolean> {
  if (url.pathname === '/api/teach/start' && req.method === 'POST') {
    const body = await readBody(req, Bodies.TeachStart);
    if (body.url && !/^https?:\/\//.test(body.url)) {
      sendJson(res, { error: 'the starting address must be an http(s) address' }, 400);
      return true;
    }
    try {
      sendJson(res, await ctx.app.teaching.start({ url: body.url || undefined }));
    } catch (err) {
      sendJson(res, { error: (err as Error).message }, 409);
    }
    return true;
  }
  if (url.pathname === '/api/teach/stop' && req.method === 'POST') {
    const body = await readBody(req, Bodies.TeachStop);
    sendJson(res, await ctx.app.teaching.stop({ save: body.save, name: body.name }));
    return true;
  }
  if (url.pathname === '/api/connect' && req.method === 'GET') {
    sendJson(res, connectView(ctx, extras));
    return true;
  }
  if (url.pathname === '/api/teach' && req.method === 'GET') {
    sendJson(res, ctx.app.teaching.status());
    return true;
  }
  if (url.pathname === '/api/extension' && req.method === 'GET') {
    sendJson(res, extensionView(ctx));
    return true;
  }
  if (url.pathname === '/api/extension/pair' && req.method === 'POST') {
    if (!ctx.app.extension.status().listening) {
      sendJson(res, { error: 'Fanfold is not listening for the extension. Restart Fanfold and try again.' }, 409);
      return true;
    }
    sendJson(res, { ...ctx.app.extension.beginPairing(), ...extensionView(ctx) });
    return true;
  }
  if (url.pathname === '/api/extension' && req.method === 'DELETE') {
    ctx.app.extension.unpair();
    sendJson(res, extensionView(ctx));
    return true;
  }
  if (url.pathname === '/api/tabs' && req.method === 'GET') {
    sendJson(res, tabsView(ctx));
    return true;
  }
  if (url.pathname === '/api/tabs/stop' && req.method === 'POST') {
    const body = await readBody(req, Bodies.StopTab);
    const stopped = await ctx.app.stopTab(body.targetId!);
    sendJson(res, { stopped, ...tabsView(ctx) }, stopped ? 200 : 404);
    return true;
  }
  if (url.pathname === '/api/tabs/stop-all' && req.method === 'POST') {
    const stopped = await ctx.app.stopEverything();
    sendJson(res, { stopped, ...tabsView(ctx) });
    return true;
  }
  return false;
}
