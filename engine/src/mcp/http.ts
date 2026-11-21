/**
 * MCP over HTTP: a host POSTs a JSON-RPC message and gets the answer back as
 * JSON. One connection per `Mcp-Session-Id`, handed out at initialize.
 *
 * A host may also GET a stream on its session and hold it open, as MCP's
 * streamable HTTP has it. What Fanfold sends the host of its own accord goes
 * down that stream as events: a question for the host's user (its dialog),
 * the notice that withdraws one, progress. The host POSTs its answers back.
 * A host holding no stream cannot be asked anything, so what needs its user
 * waits in Fanfold's own Review. The stream also tells of the host going:
 * when its process ends, however it ends, the stream closes and the agent is
 * let go.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Outbound, type Connection, type McpServer } from './server.ts';
import { RpcError, failure, isResponse, parseMessage, type Peer, type RequestOptions, type RpcResponse } from './protocol.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** An oversized body is read to its end and dropped, up to this, so the connection can carry the next request. */
const DRAIN_BYTES = 64 * 1024 * 1024;
const MAX_CONNECTIONS = 32;
/** Often enough that an idle stream is never taken for a dead one on the way. */
const PING_MS = 15_000;

const SILENT_PEER: Peer = { notify: () => {} };

/** The way back to one host: the stream it holds, when it holds one. */
class StreamPeer implements Peer {
  #stream: ServerResponse | null = null;
  readonly #out = new Outbound((message) => { this.#stream?.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`); });

  hold(stream: ServerResponse | null): void {
    this.#stream = stream;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#out.notify(method, params);
  }

  request(method: string, params: Record<string, unknown>, opts?: RequestOptions): Promise<unknown> {
    if (!this.#stream) return Promise.reject(new Error('this host holds no stream to be asked on'));
    return this.#out.request(method, params, opts);
  }

  /** True when the host's message answered one of ours. */
  settle(response: RpcResponse): boolean {
    return this.#out.settle(response);
  }

  close(): void {
    this.#out.close();
  }
}

interface HttpSession {
  connection: Connection;
  peer: StreamPeer;
}

async function readText(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > DRAIN_BYTES) {
      req.destroy();
      return null;
    }
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY_BYTES) return null;
  return Buffer.concat(chunks).toString('utf8');
}

export class McpHttp {
  readonly #server: McpServer;
  readonly #connections = new Map<string, HttpSession>();
  /** The stream each session's host holds open, if it holds one. */
  readonly #streams = new Map<string, ServerResponse>();

  constructor(server: McpServer) {
    this.#server = server;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = String(req.headers['mcp-session-id'] ?? '');

    if (req.method === 'DELETE') {
      this.#end(sessionId);
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && sessionId) return this.#hold(sessionId, res);
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST, DELETE' }).end();
      return;
    }

    const body = await readText(req);
    if (body === null) return this.#send(res, 413, failure(null, RpcError.invalidRequest, 'message too large'));
    const parsed = parseMessage(body);
    if (!parsed.ok) return this.#send(res, 400, parsed.error);
    const messages = Array.isArray(parsed.message) ? parsed.message : [parsed.message];

    const starting = messages.some((m) => 'method' in m && m.method === 'initialize');
    const known = starting ? undefined : this.#connections.get(sessionId);
    let connection = known?.connection;
    let issued: string | null = null;
    if (!connection) {
      if (starting) {
        const peer = new StreamPeer();
        connection = this.#server.connect(peer);
        issued = randomUUID();
        this.#remember(issued, { connection, peer });
      } else {
        connection = this.#server.connect(SILENT_PEER);
      }
    }

    const responses: RpcResponse[] = [];
    for (const message of messages) {
      // The host answering something Fanfold asked it, such as its user's reply in a dialog.
      if (isResponse(message)) {
        known?.peer.settle(message);
        continue;
      }
      const response = await connection.receive(message);
      if (response) responses.push(response);
    }

    if (!responses.length) {
      res.writeHead(202).end();
      return;
    }
    this.#send(res, 200, Array.isArray(parsed.message) ? responses : responses[0], issued);
  }

  close(): void {
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    for (const stream of streams) stream.end();
    for (const { connection, peer } of this.#connections.values()) {
      connection.close();
      peer.close();
    }
    this.#connections.clear();
  }

  /** The host has gone: what its agent held is let go. */
  #end(sessionId: string): void {
    const stream = this.#streams.get(sessionId);
    this.#streams.delete(sessionId);
    stream?.end();
    const held = this.#connections.get(sessionId);
    held?.connection.close();
    held?.peer.close();
    this.#connections.delete(sessionId);
  }

  /**
   * Held open by the host for as long as it runs. Its closing is the host
   * going, even one killed before it could say so. An agent that is only
   * thinking between calls keeps it open, so it is never let go for that.
   */
  #hold(sessionId: string, res: ServerResponse): void {
    const held = this.#connections.get(sessionId);
    if (!held) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('no such session');
      return;
    }
    const previous = this.#streams.get(sessionId);
    this.#streams.set(sessionId, res);
    previous?.end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': open\n\n');
    held.peer.hold(res);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    ping.unref();
    res.on('close', () => {
      clearInterval(ping);
      // A stream this host has since replaced says nothing about the host.
      if (this.#streams.get(sessionId) === res) this.#end(sessionId);
    });
  }

  #remember(id: string, session: HttpSession): void {
    if (this.#connections.size >= MAX_CONNECTIONS) this.#end(this.#connections.keys().next().value as string);
    this.#connections.set(id, session);
  }

  #send(res: ServerResponse, status: number, body: unknown, sessionId?: string | null): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    });
    res.end(JSON.stringify(body));
  }
}
