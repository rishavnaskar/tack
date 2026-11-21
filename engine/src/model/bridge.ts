/**
 * An OpenAI-compatible chat-completions endpoint answered by the `claude` CLI.
 *
 * Lets Fanfold's own agent run on a machine where Claude Code is signed in and
 * no other model key is: point FANFOLD_MODEL_URL at it. Each request is one
 * `claude -p` with every tool, MCP server and customisation switched off, so
 * the model sees Fanfold's prompt and nothing else, and a schema in the
 * request becomes the CLI's own validated structured output.
 *
 * Loopback only, and only for what reached it as loopback: a request naming
 * another host, carrying an Origin, sent cross-site by a browser or not sent
 * as JSON is refused, since a web page can make a browser send exactly those
 * to 127.0.0.1. Only Haiku and Sonnet are run, by those exact names: a model
 * this busy is called on every step, and a larger one is refused rather than
 * quietly paid for.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } };

export interface ClaudeCall {
  model: string;
  system: string;
  /** One user turn. Earlier turns are folded into it. */
  content: ContentBlock[];
  schema: Record<string, unknown> | null;
  /** The request's max_tokens. The CLI has no such cap, so the reply is cut to it afterwards, as a provider would. */
  maxTokens: number | null;
  signal: AbortSignal;
}

/** The CLI's closing `result` line, as much of it as is read here. */
export interface CliResult {
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
  modelUsage?: Record<string, unknown>;
}

export type Runner = (call: ClaudeCall) => Promise<CliResult>;

export class BridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

/** The names this bridge runs, passed to `claude --model` as they are. */
export const MODELS: readonly string[] = ['haiku', 'sonnet'];
const REFUSED = /opus|fable/i;

/** The model a request asked for when it is one this bridge runs, otherwise the default. */
export function resolveModel(requested: unknown, fallback: string): string {
  const name = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  if (REFUSED.test(name)) throw new BridgeError(400, `this bridge runs Haiku or Sonnet only, not ${name.slice(0, 80)}`);
  return MODELS.includes(name) ? name : fallback;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Why a request is not one a local program sent, or null when it is. */
function notLocal(headers: IncomingMessage['headers'], port: number, method: string | undefined): string | null {
  const host = String(headers.host ?? '').toLowerCase();
  const at = host.lastIndexOf(':');
  if (at < 0 || !LOOPBACK.has(host.slice(0, at)) || host.slice(at + 1) !== String(port)) return 'the Host header must name this bridge on loopback';
  if (headers.origin !== undefined) return 'requests from web pages are refused';
  const site = String(headers['sec-fetch-site'] ?? 'none').toLowerCase();
  if (site !== 'none') return 'requests a browser sends for another site are refused';
  if (method === 'POST' && !/^application\/json\s*(;|$)/i.test(String(headers['content-type'] ?? ''))) return 'the body must be sent as application/json';
  return null;
}

function blocksOf(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new BridgeError(400, 'message content must be a string or an array of parts');
  return content.map((part: { type?: unknown; text?: unknown; image_url?: { url?: unknown } | string }) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url !== 'string') throw new BridgeError(400, 'image_url needs a url');
      const data = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
      if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
      if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
      throw new BridgeError(400, 'an image must be a data: URL or an http(s) URL');
    }
    throw new BridgeError(400, `unsupported content part: ${String(part?.type)}`);
  });
}

/** A chat-completions body as one CLI call. Throws a 400 for anything it cannot honour. */
export function toClaudeCall(body: unknown, fallbackModel: string, signal: AbortSignal): ClaudeCall {
  const b = body as { model?: unknown; messages?: unknown; response_format?: unknown; stream?: unknown; max_tokens?: unknown };
  if (!b || typeof b !== 'object') throw new BridgeError(400, 'the body must be a JSON object');
  if (b.stream) throw new BridgeError(400, 'streaming is not supported');
  if (!Array.isArray(b.messages) || !b.messages.length) throw new BridgeError(400, 'messages is required');

  const messages = b.messages as ChatMessage[];
  const system: string[] = [];
  const turns: Array<{ role: string; blocks: ContentBlock[] }> = [];
  for (const m of messages) {
    const role = String(m?.role ?? '');
    if (role === 'system' || role === 'developer') {
      system.push(blocksOf(m.content).map((p) => (p.type === 'text' ? p.text : '')).join('\n'));
    } else if (role === 'user' || role === 'assistant') {
      turns.push({ role, blocks: blocksOf(m.content) });
    } else {
      throw new BridgeError(400, `unsupported role: ${role}`);
    }
  }
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    throw new BridgeError(400, 'the last message must be from the user');
  }

  let schema: Record<string, unknown> | null = null;
  const format = b.response_format as { type?: unknown; json_schema?: { schema?: unknown } } | undefined;
  if (format?.type === 'json_schema') {
    const s = format.json_schema?.schema;
    if (!s || typeof s !== 'object') throw new BridgeError(400, 'response_format.json_schema.schema is required');
    schema = s as Record<string, unknown>;
  } else if (format?.type === 'json_object') {
    system.push('Reply with one JSON object and nothing else.');
  } else if (format !== undefined && format?.type !== 'text') {
    throw new BridgeError(400, `unsupported response_format: ${String(format?.type)}`);
  }

  const content: ContentBlock[] = turns.length === 1
    ? turns[0].blocks
    : [
        { type: 'text', text: 'The conversation so far, oldest first. Reply as the assistant to the last user turn.' },
        ...turns.flatMap((t) => [{ type: 'text' as const, text: `\n[${t.role}]` }, ...t.blocks]),
      ];

  return {
    model: resolveModel(b.model, fallbackModel),
    system: system.join('\n\n') || 'You are a helpful assistant.',
    content,
    schema,
    maxTokens: typeof b.max_tokens === 'number' && b.max_tokens > 0 ? Math.floor(b.max_tokens) : null,
    signal,
  };
}

/** A failed CLI result as the HTTP status a client would retry or not. */
export function failureOf(result: CliResult): BridgeError | null {
  if (!result.is_error) return null;
  const said = (result.result ?? 'the claude CLI reported an error').slice(0, 300);
  const status = result.api_error_status;
  if (status === 401 || status === 403) return new BridgeError(status, `claude is not signed in or was refused: ${said}`);
  if (status === 429) return new BridgeError(429, said);
  if (typeof status === 'number' && status >= 500) return new BridgeError(503, said);
  if (typeof status === 'number' && status >= 400) return new BridgeError(status, said);
  return new BridgeError(502, said);
}

/**
 * The CLI's answer in the shape an OpenAI client, and Fanfold's ModelClient, read.
 *
 * A reply longer than max_tokens is cut where a provider would have stopped
 * it, with finish_reason "length", so a budget too small for the answer fails
 * here exactly as it would against a real endpoint.
 */
function toCompletion(result: CliResult, call: ClaudeCall, honourMaxTokens = true): Record<string, unknown> {
  if (call.schema && result.structured_output === undefined) {
    throw new BridgeError(502, `no structured output came back: ${(result.result ?? '').slice(0, 200)}`);
  }
  let content = call.schema ? JSON.stringify(result.structured_output) : (result.result ?? '');
  const u = result.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached;
  let output = u.output_tokens ?? 0;
  let finish = 'stop';
  if (honourMaxTokens && call.maxTokens && output > call.maxTokens) {
    content = content.slice(0, Math.floor(content.length * (call.maxTokens / output)));
    output = call.maxTokens;
    finish = 'length';
  }
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: Object.keys(result.modelUsage ?? {})[0] ?? call.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      cost: result.total_cost_usd ?? 0,
      prompt_tokens_details: { cached_tokens: cached },
      completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.thinking_tokens ?? 0 },
    },
  };
}

/** Runs `claude -p` once per call, in an empty directory, with nothing but the model. */
export function claudeRunner(opts: { command?: string; timeoutMs?: number } = {}): Runner {
  const command = opts.command ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? 170_000;
  const cwd = join(tmpdir(), 'fanfold-model-bridge');
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  // Set inside a Claude Code session, where a nested `claude` refuses to start.
  delete env.CLAUDECODE;

  return (call) => new Promise<CliResult>((resolve, reject) => {
    const args = [
      '-p', '--model', call.model,
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--safe-mode', '--disable-slash-commands', '--no-session-persistence',
      '--system-prompt', call.system,
      ...(call.schema ? ['--json-schema', JSON.stringify(call.schema)] : []),
    ];
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      child.kill('SIGTERM');
      done(() => reject(new BridgeError(499, 'the client went away')));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(() => reject(new BridgeError(504, `claude took longer than ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    call.signal.addEventListener('abort', onAbort, { once: true });
    if (call.signal.aborted) onAbort();

    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString('utf8')).slice(-2000); });
    child.on('error', (e) => done(() => reject(new BridgeError(502, `could not start ${command}: ${e.message}`))));
    child.on('close', (code) => {
      const line = out.split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"type":"result"'));
      if (!line) {
        done(() => reject(new BridgeError(502, `claude exited with ${code} and no result: ${err.trim().slice(-300) || out.slice(-300)}`)));
        return;
      }
      try {
        const parsed = JSON.parse(line) as CliResult;
        done(() => resolve(parsed));
      } catch (e) {
        done(() => reject(new BridgeError(502, `unreadable result from claude: ${(e as Error).message}`)));
      }
    });
    child.stdin.on('error', () => { /* the close handler reports what happened */ });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: call.content } }) + '\n');
  });
}

/** At most `limit` at once; the rest wait their turn, and one that gives up leaves the queue. */
export class Limiter {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  get active(): number { return this.#active; }
  get queued(): number { return this.#waiting.length; }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve, reject) => {
        const go = (): void => { signal?.removeEventListener('abort', leave); resolve(); };
        const leave = (): void => {
          const i = this.#waiting.indexOf(go);
          if (i !== -1) this.#waiting.splice(i, 1);
          reject(new BridgeError(499, 'the client went away'));
        };
        this.#waiting.push(go);
        signal?.addEventListener('abort', leave, { once: true });
      });
    }
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}

export interface BridgeLogEntry {
  id: string;
  at: string;
  model: string | null;
  status: number;
  ms: number;
  waitedMs: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  finish?: string;
  error?: string;
}

export interface BridgeOptions {
  runner: Runner;
  /** For a request that names no model this bridge runs. */
  model?: string;
  /** Required as a bearer token when set. */
  key?: string;
  concurrency?: number;
  /** Cut replies to the request's max_tokens, as a provider does. On unless turned off. */
  honourMaxTokens?: boolean;
  log?: (entry: BridgeLogEntry) => void;
}

const MAX_BODY = 32 * 1024 * 1024;

export function createBridge(opts: BridgeOptions): { server: Server; limiter: Limiter; listen(port?: number): Promise<number> } {
  const fallback = resolveModel(opts.model ?? 'haiku', 'haiku');
  const limiter = new Limiter(opts.concurrency ?? 6);
  const digest = (v: string): Buffer => createHash('sha256').update(v).digest();

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, message: string): void =>
    send(res, status, { error: { message, type: status === 401 ? 'authentication_error' : 'bridge_error', code: status } });

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new BridgeError(413, 'the request is too large');
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new BridgeError(400, 'the body is not JSON');
    }
  };

  const completions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const id = randomUUID().slice(0, 8);
    const started = Date.now();
    let ran = started;
    let model: string | null = null;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const call = toClaudeCall(await readJson(req), fallback, abort.signal);
      model = call.model;
      const result = await limiter.run(() => {
        ran = Date.now();
        return opts.runner(call);
      }, abort.signal);
      const failed = failureOf(result);
      if (failed) throw failed;
      const completion = toCompletion(result, call, opts.honourMaxTokens ?? true);
      send(res, 200, completion);
      const usage = completion.usage as { prompt_tokens: number; completion_tokens: number; cost: number };
      opts.log?.({
        id, at: new Date(started).toISOString(), model: String(completion.model), status: 200,
        ms: Date.now() - started, waitedMs: ran - started,
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, costUsd: usage.cost,
        finish: (completion.choices as Array<{ finish_reason: string }>)[0].finish_reason,
      });
    } catch (err) {
      const status = err instanceof BridgeError ? err.status : 500;
      const message = (err as Error).message;
      if (status !== 499) error(res, status, message);
      opts.log?.({ id, at: new Date(started).toISOString(), model, status, ms: Date.now() - started, waitedMs: ran - started, error: message });
    }
  };

  let port = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const foreign = notLocal(req.headers, port, req.method);
    if (foreign) return error(res, 403, foreign);
    if (opts.key) {
      const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
      if (!timingSafeEqual(digest(bearer), digest(opts.key))) return error(res, 401, 'the bridge key was refused');
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, model: fallback, active: limiter.active, queued: limiter.queued });
    }
    if (req.method === 'GET' && /^(\/v1)?\/models$/.test(url.pathname)) {
      return send(res, 200, { object: 'list', data: MODELS.map((m) => ({ id: m, object: 'model', owned_by: 'anthropic' })) });
    }
    if (req.method === 'POST' && /^(\/v1)?\/chat\/completions$/.test(url.pathname)) {
      void completions(req, res);
      return;
    }
    error(res, 404, `no route for ${req.method} ${url.pathname}`);
  });

  return {
    server,
    limiter,
    listen: (wanted = 0) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(wanted, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : wanted;
        resolve(port);
      });
    }),
  };
}
