import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmError } from './llm.ts';
import * as hosted from './hosted.ts';
import { closeAll, removeSession, sessionFiles, stateDir } from './store.ts';

export type Ctx = { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: any };
export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
export interface Router {
  get(path: string, h: Handler): void;
  post(path: string, h: Handler): void;
  put(path: string, h: Handler): void;
  patch(path: string, h: Handler): void;
  delete(path: string, h: Handler): void;
  /** A GET page outside /api, answered before the UI's static files. */
  page?(path: string, h: Handler): void;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Route = { method: string; parts: string[]; pattern: string; handler: Handler };

const MAX_BODY = 25 * 1024 * 1024; // base64 PDFs
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EVENTS = '/api/events';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

// Routes may be registered as "/plan" or "/api/plan"; both mean /api/plan.
function apiPath(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return p === '/api' || p.startsWith('/api/') ? p : `/api${p}`;
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Starts a server-sent events response; returns a writer and keeps the socket alive.
export function openSse(res: ServerResponse, onClose: () => void): (data: unknown, id?: string) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => { clearInterval(beat); onClose(); });
  return (data, id) => { res.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`); };
}

async function readBody(req: IncomingMessage, max = MAX_BODY, tooLarge = 'request body too large'): Promise<any> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, tooLarge);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, tooLarge);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function uiDir(): string {
  return process.env.TACK_UI_DIR ? resolve(process.env.TACK_UI_DIR) : fileURLToPath(new URL('../../ui/dist/', import.meta.url));
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const root = resolve(uiDir());
  if (!existsSync(join(root, 'index.html'))) {
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Tack coach is running. The UI is not built yet: run the build in ui/ to create ui/dist.\n');
    } else {
      notFound(res);
    }
    return;
  }
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  // No NUL bytes, no backslashes, no dotfiles; the resolved file must stay under the UI root.
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((s) => s.startsWith('.') && s !== '')) return notFound(res);
  const file = resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  const back = relative(root, file);
  const inside = back === '' || (!back.startsWith('..') && !isAbsolute(back));
  let target = inside && existsSync(file) && statSync(file).isFile() ? file : '';
  if (!target) {
    // Asset requests that miss are real 404s; everything else is a client-side route.
    if (extname(rel) && extname(rel) !== '.html') return notFound(res);
    target = join(root, 'index.html');
  }
  const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const immutable = target.includes(`${sep}assets${sep}`);
  res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(target);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
}

const GENERIC: Record<number, string> = {
  500: 'Something went wrong on our end. Try again in a minute.',
  502: 'The model did not give a clear answer. Try again in a minute.',
  503: 'The model is not available right now. Try again later.',
  504: 'The model took too long to answer. Try again in a minute.',
};

export interface App {
  router: Router;
  server: Server;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
  /** Hosted shutdown: stop taking requests, end event streams, wait for the rest up to `ms`. */
  drain(ms: number): Promise<void>;
  /** Write routes that have no input check of their own in hosted mode. */
  unchecked(): string[];
}

export function createApp(): App {
  const isHosted = hosted.isHosted();
  const routes: Route[] = [];
  const pages: Route[] = [];
  const add = (method: string) => (path: string, handler: Handler) => {
    const parts = split(apiPath(path));
    routes.push({ method, parts, pattern: `/${parts.join('/')}`, handler });
  };
  const router: Router = {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    page: (path, handler) => { const parts = split(path); pages.push({ method: 'GET', parts, pattern: `/${parts.join('/')}`, handler }); },
  };

  if (isHosted) {
    const dir = stateDir();
    hosted.configure({ stateDir: dir });
    // Sessions kept from an earlier run join the cap and the expiry; stale ones go now.
    const ttl = hosted.limits().sessionTtlMs;
    for (const f of sessionFiles()) {
      if (Date.now() - f.at > ttl) removeSession(f.key);
      else hosted.adopt(f.key, f.at);
    }
    hosted.startSweeper();
  }

  let draining = false;
  let inflight = 0;
  const streams = new Set<ServerResponse>();

  function match(method: string, path: string, table = routes): { route?: Route; params: Record<string, string>; allowed: boolean } {
    const parts = split(path);
    let allowed = false;
    for (const route of table) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i];
        if (want.startsWith(':')) {
          try { params[want.slice(1)] = decodeURIComponent(parts[i]); } catch { params[want.slice(1)] = parts[i]; }
        } else if (want !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      allowed = true;
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { route, params, allowed };
    }
    return { params: {}, allowed };
  }

  // In hosted mode server errors say nothing about the inside: no messages, paths or stacks.
  function failure(err: unknown, rid: string): { status: number; body: Record<string, unknown>; retryAfter?: number } {
    const budget = isHosted ? hosted.budgetHit() : undefined;
    if (err instanceof hosted.BudgetError || (budget && !(err instanceof HttpError && err.status < 500))) {
      const b = err instanceof hosted.BudgetError ? err : budget!;
      return { status: 429, body: { error: b.message, code: 'budget', scope: b.scope, retryAfter: b.retryAfter }, retryAfter: b.retryAfter };
    }
    if (err instanceof hosted.InvalidInput) return { status: err.status, body: { error: err.message } };
    const status = err instanceof HttpError ? err.status : err instanceof LlmError ? (err.status === 503 ? 503 : 502) : 500;
    if (!isHosted || status < 500) return { status, body: { error: (err as Error).message || 'internal error' } };
    if (err instanceof LlmError && err.status === 429) {
      return { status: 503, body: { error: 'The model is too busy right now. Try again later.', requestId: rid }, retryAfter: 60 };
    }
    const noKey = err instanceof LlmError && err.status === 503 && /no model key/.test(err.message);
    return { status, body: { error: noKey ? 'The model is not set up on this server.' : GENERIC[status] ?? GENERIC[500], requestId: rid } };
  }

  function refuse(res: ServerResponse, r: hosted.Refusal): void {
    if (r.retryAfter) res.setHeader('retry-after', String(r.retryAfter));
    sendJson(res, r.status, { error: r.message, code: r.code, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const rid = hosted.requestId(req);
    const t0 = Date.now();
    let routeName = '';
    let visitor: hosted.Visitor | undefined;
    const ip = isHosted ? hosted.clientIp(req) : '';

    if (isHosted) {
      res.setHeader('x-request-id', rid);
      hosted.securityHeaders(res, hosted.isSecure(req));
      res.once('close', () => {
        hosted.log({
          level: 'info', msg: 'request', rid, method, route: routeName || (url.pathname.startsWith('/api') ? 'unmatched' : 'static'),
          status: res.statusCode, ms: Date.now() - t0, ...(visitor ? { sess: visitor.key.slice(0, 8) } : {}),
        });
      });
      if (draining) {
        res.setHeader('connection', 'close');
        return sendJson(res, 503, { error: 'Tack is restarting. Try again in a moment.' });
      }
      if (!METHODS.has(method)) return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (url.pathname === '/healthz') {
      routeName = '/healthz';
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, draining ? 503 : 200, { ok: !draining });
    }

    if (isHosted) {
      try {
        hosted.limitIp(ip);
      } catch (err) {
        if (err instanceof hosted.Refusal) return refuse(res, err);
        throw err;
      }
    }

    const origin = req.headers.origin;
    if (!isHosted && origin && DEV_ORIGINS.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
    }
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const off = hosted.blocked(url.pathname);
    if (off) {
      routeName = 'blocked';
      return sendJson(res, 409, off);
    }

    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      const page = match(method, url.pathname, pages);
      if (page.route) {
        routeName = page.route.pattern;
        try {
          const out = await page.route.handler({ req, res, params: page.params, query: url.searchParams, body: {} });
          if (!res.headersSent && !res.writableEnded) {
            const html = String(out ?? '');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) });
            res.end(method === 'HEAD' ? undefined : html);
          }
        } catch (err) {
          const f = failure(err, rid);
          if (f.status >= 500) logError(err, `${method} ${url.pathname}`, rid);
          if (!res.headersSent) { res.writeHead(f.status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(f.body.error)); }
        }
        return;
      }
      return serveStatic(req, res, url.pathname);
    }

    const { route, params, allowed } = match(method, url.pathname);
    if (!route) return sendJson(res, allowed ? 405 : 404, { error: allowed ? 'method not allowed' : `no route for ${method} ${url.pathname}` });
    routeName = route.pattern;
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

    if (!isHosted) {
      try {
        const body = hasBody ? await readBody(req) : {};
        const out = await route.handler({ req, res, params, query: url.searchParams, body });
        if (res.headersSent || res.writableEnded) return;
        if (out === undefined) { res.writeHead(204); res.end(); return; }
        sendJson(res, 200, withCapabilities(route, out));
      } catch (err) {
        // Model failures are upstream problems, not the client's: 503 when no key, else 502.
        const f = failure(err, rid);
        if (f.status >= 500) console.error(`${method} ${url.pathname}:`, err);
        if (res.headersSent) { res.end(); return; }
        sendJson(res, f.status, f.body);
      }
      return;
    }

    // Hosted: origin and type checks, a visitor and its limits, then the visitor's own scope for the handler.
    const stream = route.pattern === EVENTS;
    try {
      if (WRITES.has(method)) {
        if (!hosted.sameOrigin(req)) throw new hosted.Refusal(403, 'origin', 'Requests from other sites are not allowed.');
        const length = Number(req.headers['content-length'] ?? 0);
        const chunked = /chunked/i.test(String(req.headers['transfer-encoding'] ?? ''));
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if ((length > 0 || chunked) && type !== 'application/json') throw new hosted.Refusal(415, 'type', 'Send the body as application/json.');
      }
      visitor = hosted.visitorFor(req, res, ip, hosted.isSecure(req));
      hosted.limitVisitor(visitor, stream);
      hosted.track(visitor, res, stream, ip);
    } catch (err) {
      if (err instanceof hosted.Refusal) return refuse(res, err);
      throw err;
    }
    if (stream) {
      streams.add(res);
      res.once('close', () => streams.delete(res));
    } else {
      inflight++;
      res.once('close', () => { inflight--; });
    }

    const v = visitor;
    await hosted.runAs(v, async () => {
      try {
        const body = hasBody ? await readBody(req, hosted.bodyLimit(route.pattern), hosted.tooLarge(route.pattern)) : {};
        if (hasBody || method === 'DELETE') hosted.checkWrite(method, route.pattern, body, params);
        const out = await route.handler({ req, res, params, query: url.searchParams, body });
        if (res.headersSent || res.writableEnded) return;
        if (out === undefined) { res.writeHead(204); res.end(); return; }
        sendJson(res, 200, withCapabilities(route, out));
      } catch (err) {
        const f = failure(err, rid);
        if (f.status >= 500) logError(err, route.pattern, rid);
        if (res.headersSent) { res.end(); return; }
        if (f.retryAfter) res.setHeader('retry-after', String(f.retryAfter));
        sendJson(res, f.status, f.body);
      }
    });
  }

  function withCapabilities(route: Route, out: unknown): unknown {
    if (route.pattern !== '/api/state' || route.method !== 'GET' || !out || typeof out !== 'object' || Array.isArray(out)) return out;
    const o = out as Record<string, unknown>;
    if (!isHosted) return { ...o, capabilities: o.capabilities ?? hosted.capabilities() };
    const l = hosted.limits();
    const retentionHours = Math.round(l.sessionTtlMs / 3_600_000);
    return { ...o, capabilities: hosted.capabilities(), hosted: { preview: true, downloadUrl: hosted.downloadUrl(), retentionHours, resumeMaxBytes: l.resumeBytes } };
  }

  function logError(err: unknown, where: string, rid: string): void {
    if (!isHosted) { console.error(`${where}:`, err); return; }
    hosted.log({ level: 'error', msg: 'request failed', rid, route: where, err: hosted.errText(err) });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logError(err, req.url?.split('?')[0] ?? '', '');
      if (!res.headersSent) sendJson(res, 500, { error: GENERIC[500] });
      else res.end();
    });
  });
  if (isHosted) {
    // Slow or stalled uploads give up rather than hold a socket.
    server.headersTimeout = 20_000;
    server.requestTimeout = 120_000;
  }

  return {
    router,
    server,
    listen: (port, host = '127.0.0.1') => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, host, () => { server.off('error', fail); ok(); });
    }),
    close: () => new Promise((ok) => {
      if (isHosted) hosted.stopSweeper();
      server.closeAllConnections?.();
      server.close(() => ok());
    }),
    drain: async (ms) => {
      draining = true;
      hosted.stopSweeper();
      const closed = new Promise<void>((ok) => server.close(() => ok()));
      for (const s of streams) s.end();
      server.closeIdleConnections?.();
      const until = Date.now() + ms;
      while (inflight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      server.closeAllConnections?.();
      await closed;
      closeAll();
    },
    unchecked: () => routes.filter((r) => WRITES.has(r.method) && !hosted.blocked(r.pattern) && !hosted.hasCheck(r.method, r.pattern)).map((r) => `${r.method} ${r.pattern}`),
  };
}
