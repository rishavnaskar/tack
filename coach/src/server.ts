import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmError } from './llm.ts';

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

type Route = { method: string; parts: string[]; handler: Handler };

const MAX_BODY = 25 * 1024 * 1024; // base64 PDFs
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

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

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
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

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const root = uiDir();
  if (!existsSync(join(root, 'index.html'))) {
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Tack coach is running. The UI is not built yet: run the build in ui/ to create ui/dist.\n');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
    }
    return;
  }
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  const file = normalize(join(root, rel));
  const inside = file === root.replace(/[\\/]$/, '') || file.startsWith(root.endsWith(sep) ? root : root + sep);
  let target = inside && existsSync(file) && statSync(file).isFile() ? file : '';
  if (!target) {
    // Asset requests that miss are real 404s; everything else is a client-side route.
    if (extname(rel) && extname(rel) !== '.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    target = join(root, 'index.html');
  }
  const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const immutable = target.includes(`${sep}assets${sep}`);
  res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(target).pipe(res);
}

export function createApp(): { router: Router; server: Server; listen(port: number, host?: string): Promise<void>; close(): Promise<void> } {
  const routes: Route[] = [];
  const pages: Route[] = [];
  const add = (method: string) => (path: string, handler: Handler) => {
    routes.push({ method, parts: split(apiPath(path)), handler });
  };
  const router: Router = {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    page: (path, handler) => { pages.push({ method: 'GET', parts: split(path), handler }); },
  };

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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const origin = req.headers.origin;
    if (origin && DEV_ORIGINS.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
    }
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      const page = match(method, url.pathname, pages);
      if (page.route) {
        try {
          const out = await page.route.handler({ req, res, params: page.params, query: url.searchParams, body: {} });
          if (!res.headersSent && !res.writableEnded) {
            const html = String(out ?? '');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) });
            res.end(method === 'HEAD' ? undefined : html);
          }
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 500;
          if (status >= 500) console.error(`${method} ${url.pathname}:`, err);
          if (!res.headersSent) { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end((err as Error).message); }
        }
        return;
      }
      return serveStatic(req, res, url.pathname);
    }

    const { route, params, allowed } = match(method, url.pathname);
    if (!route) return sendJson(res, allowed ? 405 : 404, { error: allowed ? 'method not allowed' : `no route for ${method} ${url.pathname}` });
    try {
      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readBody(req) : {};
      const out = await route.handler({ req, res, params, query: url.searchParams, body });
      if (res.headersSent || res.writableEnded) return;
      if (out === undefined) { res.writeHead(204); res.end(); return; }
      sendJson(res, 200, out);
    } catch (err) {
      // Model failures are upstream problems, not the client's: 503 when no key, else 502.
      const status = err instanceof HttpError ? err.status : err instanceof LlmError ? (err.status === 503 ? 503 : 502) : 500;
      if (status >= 500) console.error(`${method} ${url.pathname}:`, err);
      if (res.headersSent) { res.end(); return; }
      sendJson(res, status, { error: (err as Error).message || 'internal error' });
    }
  }

  const server = createServer((req, res) => { void handle(req, res); });
  return {
    router,
    server,
    listen: (port, host = '127.0.0.1') => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, host, () => { server.off('error', fail); ok(); });
    }),
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
