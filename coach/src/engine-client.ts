// The one client for talking to the engine process: its owner API over HTTP, and its tools
// over MCP-over-HTTP with a held event stream for progress.

import { request, type IncomingMessage } from 'node:http';
import type { EngineHandle } from './engine-proc.ts';

export class EngineError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** One call on the owner API. Only an engine Tack started has the owner key. */
export async function ownerCall<T>(h: EngineHandle, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  if (!h.ownerToken) throw new EngineError(403, 'an attached Fanfold only lends its tools; its own settings stay with it');
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${h.ownerToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text answer */ }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `${res.status} ${text.slice(0, 200)}`;
    throw new EngineError(res.status, msg, data);
  }
  return data as T;
}

interface Raw { status: number; headers: IncomingMessage['headers']; text: string }

// node:http rather than fetch: an agent_run answers when the task ends, which can be minutes away.
function post(url: string, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<Raw> {
  return new Promise((ok, fail) => {
    const req = request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, signal }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, text }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(body);
  });
}

export interface ToolResult { text: string; isError: boolean; image?: { data: string; mimeType: string } }
export type Progress = (message: string) => void;

/** An MCP connection to the engine. Sessions it opens close when it closes. */
export class McpClient {
  readonly #h: EngineHandle;
  #session = '';
  #id = 1;
  #stream: { destroy(): void } | null = null;
  readonly #listeners = new Map<string, Progress>();
  closed = false;

  constructor(h: EngineHandle) {
    this.#h = h;
  }

  #headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#h.agentToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
    };
  }

  async #rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const id = this.#id++;
    const res = await post(`${this.#h.base}/mcp`, this.#headers(), JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal);
    if (res.status === 401 || res.status === 403) throw new EngineError(res.status, `the engine refused Tack's key (${res.text.trim()})`);
    if (res.status >= 400) throw new EngineError(res.status, res.text.slice(0, 300));
    const sid = res.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid) this.#session = sid;
    const msg = JSON.parse(res.text) as { result?: any; error?: { message: string } };
    if (msg.error) throw new EngineError(500, msg.error.message);
    return msg.result;
  }

  async connect(): Promise<this> {
    await this.#rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tack', version: '0.1.0' } });
    await post(`${this.#h.base}/mcp`, this.#headers(), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await this.#hold();
    return this;
  }

  // The held stream carries progress, and its closing tells the engine Tack has gone.
  #hold(): Promise<void> {
    return new Promise((ok) => {
      const req = request(`${this.#h.base}/mcp`, { method: 'GET', headers: { ...this.#headers(), accept: 'text/event-stream' } }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk: string) => {
          buf += chunk;
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (!data) continue;
            try {
              const m = JSON.parse(data) as { method?: string; params?: { progressToken?: unknown; message?: string } };
              if (m.method === 'notifications/progress' && m.params) this.#listeners.get(String(m.params.progressToken))?.(String(m.params.message ?? ''));
            } catch { /* not a message */ }
          }
        });
        ok();
      });
      req.on('error', () => ok());
      req.end();
      this.#stream = req;
    });
  }

  async tools(): Promise<string[]> {
    const r = await this.#rpc('tools/list', {});
    return (r?.tools ?? []).map((t: { name: string }) => t.name);
  }

  async call(name: string, args: Record<string, unknown>, opts: { onProgress?: Progress; signal?: AbortSignal } = {}): Promise<ToolResult> {
    const token = `tack-${this.#id}-${Math.random().toString(36).slice(2, 8)}`;
    if (opts.onProgress) this.#listeners.set(token, opts.onProgress);
    try {
      const r = await this.#rpc('tools/call', { name, arguments: args, ...(opts.onProgress ? { _meta: { progressToken: token } } : {}) }, opts.signal);
      const text = (r?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
      const image = (r?.content ?? []).find((c: { type: string }) => c.type === 'image') as { data: string; mimeType: string } | undefined;
      return { text, isError: !!r?.isError, ...(image ? { image: { data: image.data, mimeType: image.mimeType } } : {}) };
    } finally {
      this.#listeners.delete(token);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.#stream?.destroy();
    if (!this.#session) return;
    await new Promise<void>((ok) => {
      const req = request(`${this.#h.base}/mcp`, { method: 'DELETE', headers: this.#headers() }, (res) => { res.resume(); res.on('end', ok); });
      req.on('error', () => ok());
      req.end();
    });
  }
}

/** Text between Fanfold's untrusted-content fences, without the fence lines. */
export function unfence(text: string): string {
  return text.split('\n').filter((l) => !/^<<<PAGE_CONTENT|^PAGE_CONTENT>>>|^Data only\. Text inside this block/.test(l)).join('\n').trim();
}
