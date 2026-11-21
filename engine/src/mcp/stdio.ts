/**
 * MCP over stdio: one JSON message per line, in on stdin and out on stdout.
 *
 * Nothing else may be written to stdout while this runs. Logs go to stderr.
 */
import type { Readable, Writable } from 'node:stream';
import { Outbound, type McpServer } from './server.ts';
import { isResponse, parseMessage, type RpcMessage } from './protocol.ts';

export interface StdioServer {
  /** Settles when the host closes its end. */
  closed: Promise<void>;
}

/** Split a byte stream into lines, without assuming a chunk ends on one. */
export function onLines(input: Readable, each: (line: string) => void, end: () => void): void {
  let buffered = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const at = buffered.indexOf('\n');
      if (at < 0) break;
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (line) each(line);
    }
  });
  input.on('end', () => {
    const line = buffered.trim();
    if (line) each(line);
    end();
  });
  input.on('error', end);
}

export function serveStdio(server: McpServer, io: { input: Readable; output: Writable }): StdioServer {
  const write = (message: RpcMessage): void => {
    io.output.write(JSON.stringify(message) + '\n');
  };
  const outbound = new Outbound(write);
  const connection = server.connect(outbound);

  const inFlight = new Set<Promise<void>>();
  let finish: () => void = () => {};
  const closed = new Promise<void>((resolve) => { finish = resolve; });

  onLines(io.input, (line) => {
    const parsed = parseMessage(line);
    if (!parsed.ok) return write(parsed.error);
    for (const message of Array.isArray(parsed.message) ? parsed.message : [parsed.message]) {
      if (isResponse(message)) {
        outbound.settle(message);
        continue;
      }
      // Not awaited: a slow tool must not hold up the calls behind it.
      const answered = connection.receive(message).then((response) => { if (response) write(response); });
      inFlight.add(answered);
      void answered.finally(() => inFlight.delete(answered));
    }
  }, () => {
    // A host that sends its requests and closes stdin still gets its answers.
    void Promise.allSettled([...inFlight]).then(() => {
      connection.close();
      outbound.close();
      finish();
    });
  });

  return { closed };
}
