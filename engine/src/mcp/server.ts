/**
 * The MCP server, independent of how messages arrive.
 *
 * A transport hands each incoming message to a Connection and writes back
 * whatever it returns. Stdio and HTTP share this, so a tool behaves the same
 * whichever way a host reaches it.
 */
import type { Logger } from '../lib/log.ts';
import { silentLogger } from '../lib/log.ts';
import { validate } from './json-schema.ts';
import {
  PROTOCOL_VERSIONS, RpcError, failure, success,
  type CallContext, type CallResult, type ClientInfo, type Peer, type RequestOptions, type RpcId,
  type RpcMessage, type RpcRequest, type RpcResponse, type Tool, type ToolOutput,
} from './protocol.ts';

export interface ServerOptions {
  name: string;
  version: string;
  /** Shown to the host's model once, at connect: how to use these tools well. */
  instructions: string;
  tools: Tool[];
  log?: Logger;
  /** A host went away: whatever it held for itself can be let go. */
  onDisconnect?(caller: object): void;
  /** Words to refuse a tool call with, while there are some for it. Nothing runs. */
  refuse?(tool: string, args: Record<string, unknown>): string | null;
}

export class McpServer {
  readonly #opts: ServerOptions;
  readonly #log: Logger;

  constructor(opts: ServerOptions) {
    const names = new Set<string>();
    for (const tool of opts.tools) {
      if (names.has(tool.name)) throw new Error(`two tools are named ${tool.name}`);
      names.add(tool.name);
    }
    this.#opts = opts;
    this.#log = (opts.log ?? silentLogger).child({ component: 'mcp' });
  }

  connect(peer: Peer): Connection {
    return new Connection(this.#opts, peer, this.#log);
  }
}

export class Connection {
  readonly #opts: ServerOptions;
  readonly #peer: Peer;
  readonly #log: Logger;
  readonly #inFlight = new Map<RpcId, AbortController>();
  #client: ClientInfo = { name: 'unknown', version: '', elicitation: false };

  constructor(opts: ServerOptions, peer: Peer, log: Logger) {
    this.#opts = opts;
    this.#peer = peer;
    this.#log = log;
  }

  get client(): ClientInfo {
    return this.#client;
  }

  /** One incoming request or notification. Null means there is nothing to send back. */
  async receive(message: RpcMessage): Promise<RpcResponse | null> {
    if (!('method' in message) || typeof message.method !== 'string') return null;
    const request = message as RpcRequest;
    const isNotification = request.id === undefined || request.id === null;

    if (isNotification) {
      if (request.method === 'notifications/cancelled') {
        const id = request.params?.requestId as RpcId | undefined;
        if (id !== undefined) this.#inFlight.get(id)?.abort();
      }
      return null;
    }

    const id = request.id as RpcId;
    try {
      return success(id, await this.#dispatch(request, id));
    } catch (err) {
      if (err instanceof ProtocolError) return failure(id, err.code, err.message);
      this.#log.error('request failed', { method: request.method, err });
      return failure(id, RpcError.internal, (err as Error).message);
    }
  }

  /** Abort everything still running, when the transport goes away. */
  close(): void {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
    this.#opts.onDisconnect?.(this);
  }

  async #dispatch(request: RpcRequest, id: RpcId): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return this.#initialize(request.params ?? {});
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.#tools().map((t) => ({
            name: t.name, title: t.title, description: t.description,
            inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations },
          })),
        };
      case 'tools/call':
        return await this.#call(request.params ?? {}, id);
      default:
        throw new ProtocolError(RpcError.methodNotFound, `${request.method} is not supported`);
    }
  }

  #initialize(params: Record<string, unknown>): unknown {
    const asked = String(params.protocolVersion ?? '');
    const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    const info = (params.clientInfo ?? {}) as { name?: unknown; version?: unknown };
    const capabilities = (params.capabilities ?? {}) as { elicitation?: unknown };
    this.#client = {
      name: typeof info.name === 'string' ? info.name.slice(0, 80) : 'unknown',
      version: typeof info.version === 'string' ? info.version.slice(0, 40) : '',
      elicitation: capabilities.elicitation !== undefined && this.#peer.request !== undefined,
    };
    this.#log.info('client connected', { client: this.#client.name, version: this.#client.version, protocol: version });
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.#opts.name, title: 'Fanfold', version: this.#opts.version },
      instructions: this.#opts.instructions,
    };
  }

  #tools(): Tool[] {
    return this.#opts.tools.filter((t) => t.available?.() ?? true);
  }

  async #call(params: Record<string, unknown>, id: RpcId): Promise<CallResult> {
    const name = String(params.name ?? '');
    const tool = this.#tools().find((t) => t.name === name);
    if (!tool) throw new ProtocolError(RpcError.invalidParams, `no tool named ${JSON.stringify(name)}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const refused = this.#opts.refuse?.(name, args);
    if (refused) return toResult({ text: refused, isError: true });

    const problem = validate(tool.inputSchema, args);
    if (problem) return toResult({ text: problem, isError: true });

    const controller = new AbortController();
    this.#inFlight.set(id, controller);
    const token = (params._meta as { progressToken?: RpcId } | undefined)?.progressToken;
    let sent = 0;
    const call: CallContext = {
      client: this.#client,
      peer: this.#peer,
      caller: this,
      signal: controller.signal,
      progress: (message, done, total) => {
        if (token === undefined) return;
        this.#peer.notify('notifications/progress', {
          progressToken: token, progress: done ?? ++sent, ...(total !== undefined ? { total } : {}), message,
        });
      },
    };

    const started = Date.now();
    try {
      const output = await tool.run(args, call);
      this.#log.debug('tool ran', { tool: name, ms: Date.now() - started });
      return toResult(output);
    } catch (err) {
      // A failed tool is an answer the model can act on, not a protocol fault.
      this.#log.warn('tool failed', { tool: name, err });
      // "Target.attachToTarget failed (-32000): " says nothing a host can act on; what follows does.
      const message = String((err as Error).message ?? err).replace(/^[A-Z][A-Za-z]*\.[A-Za-z]+ failed \(-?\d+\): /, '');
      return toResult({ text: message, isError: true });
    } finally {
      this.#inFlight.delete(id);
    }
  }
}

class ProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function toResult(output: ToolOutput): CallResult {
  if (typeof output === 'string') return { content: [{ type: 'text', text: output }] };
  const content: CallResult['content'] = [{ type: 'text', text: output.text }];
  if (output.image) content.push({ type: 'image', data: output.image.data, mimeType: output.image.mimeType });
  return { content, ...(output.isError ? { isError: true } : {}) };
}

/**
 * Requests and notifications going the other way, over any channel that can
 * carry one message at a time. Responses are matched to requests by id.
 */
export class Outbound implements Peer {
  readonly #send: (message: RpcMessage) => void;
  readonly #waiting = new Map<RpcId, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  #next = 1;

  constructor(send: (message: RpcMessage) => void) {
    this.#send = send;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  request(method: string, params: Record<string, unknown>, opts: RequestOptions = {}): Promise<unknown> {
    const id = `fanfold-${this.#next++}`;
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    if (opts.signal?.aborted) return Promise.reject(new Error(`${method} was withdrawn`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        // Nobody is waiting on it now, so the client may as well close it.
        this.notify('notifications/cancelled', { requestId: id, reason: 'not answered in time' });
        reject(new Error(`${method} was not answered within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.#waiting.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
      // Withdrawn, as when the user answered the same thing elsewhere: the client is told, so its dialog can close.
      opts.signal?.addEventListener('abort', () => {
        if (!this.#waiting.delete(id)) return;
        clearTimeout(timer);
        this.notify('notifications/cancelled', { requestId: id, reason: 'answered elsewhere' });
        reject(new Error(`${method} was withdrawn`));
      }, { once: true });
    });
  }

  /** True when the response answered one of ours. */
  settle(response: RpcResponse): boolean {
    const waiting = response.id === null ? undefined : this.#waiting.get(response.id);
    if (!waiting) return false;
    this.#waiting.delete(response.id as RpcId);
    clearTimeout(waiting.timer);
    if (response.error) waiting.reject(new Error(response.error.message));
    else waiting.resolve(response.result);
    return true;
  }

  close(): void {
    for (const waiting of this.#waiting.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('the connection closed'));
    }
    this.#waiting.clear();
  }
}
