/**
 * Model Context Protocol, the parts this server speaks: JSON-RPC 2.0 messages,
 * the lifecycle handshake, and tools. Written against the public
 * specification rather than an SDK, because the app has no runtime
 * dependencies.
 */
import type { ObjectSchema } from './json-schema.ts';

/** Newest first. A client asking for one of these gets it; any other gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: RpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RpcMessage = RpcRequest | RpcResponse;

export const RpcError = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface CallResult {
  content: Content[];
  isError?: boolean;
}

/** What a tool hands back. A bare string is the common case. */
export type ToolOutput = string | { text: string; image?: { data: string; mimeType: string }; isError?: boolean };

export interface ClientInfo {
  name: string;
  version: string;
  /** The client can show the user a question on the server's behalf. */
  elicitation: boolean;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Withdraws the request: the client is sent MCP's cancellation notice for it. */
  signal?: AbortSignal;
}

/** The way back to the client, for progress and for asking the user something. */
export interface Peer {
  notify(method: string, params?: Record<string, unknown>): void;
  /** Absent on a transport that cannot carry server-initiated requests. */
  request?(method: string, params: Record<string, unknown>, opts?: RequestOptions): Promise<unknown>;
}

export interface CallContext {
  client: ClientInfo;
  peer: Peer;
  /** The same object for every call on one connection: which agent is asking. */
  caller?: object;
  signal: AbortSignal;
  progress(message: string, done?: number, total?: number): void;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Left out of the list while false, so a host never plans around a tool that cannot work. */
  available?(): boolean;
  run(args: Record<string, unknown>, call: CallContext): Promise<ToolOutput>;
}

export function isResponse(m: RpcMessage): m is RpcResponse {
  return !('method' in m) && 'id' in m;
}

export function parseMessage(line: string): { ok: true; message: RpcMessage | RpcMessage[] } | { ok: false; error: RpcResponse } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: failure(null, RpcError.parse, 'not valid JSON') };
  }
  const shaped = (v: unknown): v is RpcMessage =>
    typeof v === 'object' && v !== null && (v as { jsonrpc?: unknown }).jsonrpc === '2.0';
  if (Array.isArray(value) && value.length && value.every(shaped)) return { ok: true, message: value };
  if (shaped(value)) return { ok: true, message: value };
  return { ok: false, error: failure(null, RpcError.invalidRequest, 'not a JSON-RPC 2.0 message') };
}

export function success(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function failure(id: RpcId | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
