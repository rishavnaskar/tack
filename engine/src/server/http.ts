/**
 * Request and response plumbing shared by every route.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parse, ValidationError, type Check } from './schema.ts';
import { MAX_DOCUMENT_BYTES } from '../memory/import.ts';

/** An error that already knows which HTTP status it deserves. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Imports are capped at this, and the request cap below is sized to match. */
export { MAX_DOCUMENT_BYTES };
/** base64 inflates by ~4/3; leave room for the JSON envelope too. */
export const MAX_DOCUMENT_BODY_BYTES = Math.ceil(MAX_DOCUMENT_BYTES * 4 / 3) + 64 * 1024;

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Read a JSON body, with a per-route cap.
 *
 * The default is small because a local UI has no reason to post megabytes and
 * an unbounded read is how a local server becomes a memory-exhaustion bug.
 * The document route needs a much larger one: a base64-encoded PDF is about a
 * third larger than the file, so the documented 20 MiB limit needs roughly
 * 27 MiB of body.
 */
export async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      /*
       * Too big — but stopping here would hang the caller. Throwing
       * mid-stream leaves the rest of the body unread on a kept-alive socket:
       * the client sits blocked writing into a full TCP window, the server
       * waits for its next request, and nothing ever moves. So the rest is
       * swallowed, up to a hard ceiling, and the connection is marked to
       * close, so the client gets a real 413 instead of silence.
       */
      const ceiling = maxBytes * 4;
      for await (const more of req) {
        size += (more as Buffer).length;
        if (size > ceiling) { req.destroy(); break; }
      }
      // Said in the person's terms: the byte count of an encoded request is not the size of their file.
      throw new HttpError(413, maxBytes >= MAX_DOCUMENT_BODY_BYTES
        ? `This file is too large: Fanfold takes files up to ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB.`
        : 'This is too large for Fanfold to take in one request.');
    }
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

/** Read a body and check it against its schema. Any mismatch is a 400 naming the field. */
export async function readBody<T>(req: IncomingMessage, schema: Check<T>, maxBytes?: number): Promise<T> {
  const raw = await readJson(req, maxBytes);
  try {
    return parse(schema, raw);
  } catch (err) {
    if (err instanceof ValidationError) throw new HttpError(400, err.message);
    throw err;
  }
}
