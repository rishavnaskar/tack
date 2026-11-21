/**
 * Stdio in front of a Fanfold that is already running.
 *
 * The host speaks MCP over stdio to this process, which relays each message
 * to the running instance over loopback HTTP. The host gets the same browser,
 * sign-ins and review queue the user already has open.
 *
 * When the host goes, Fanfold has to hear of it, or this agent's windows stay
 * open and "main" stays taken. A host that closes stdin, or ends this process
 * with a signal (`stop`), is let go here at once. One that kills it outright
 * is noticed by Fanfold itself: this process holds a stream open for as long
 * as it lives, and the stream closes with it.
 *
 * That stream also carries what Fanfold asks the host of its own accord, such
 * as a dialog for its user. Each is passed on to the host as a line, and the
 * host's answer goes back like any other message.
 */
import type { Readable, Writable } from 'node:stream';
import { findRunning, type Instance } from '../server/instance.ts';
import { RpcError, failure, parseMessage, type RpcId } from './protocol.ts';
import { onLines } from './stdio.ts';

/** After stdin closes, calls still running get this long before the agent is let go, which ends them. */
const STDIN_GRACE_MS = 2_000;
/** And this long, once let go, to send their answers. */
const LAST_ANSWERS_MS = 10_000;
/** How long the handshake waits for the stream to open, so a dialog asked in the first call can reach the host. */
const STREAM_OPEN_MS = 3_000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/** What the host is told when Fanfold is gone, or came back as a new start. */
export const COPY = {
  gone: 'Fanfold stopped answering: it was closed, or it crashed. Ask the user to start Fanfold again; this connection finds it by itself once it is back. '
    + 'Then look at the page again before going on, since this call may not have finished.',
  restarted: 'Note: Fanfold restarted since your last call, so the sessions and windows you had are gone, with anything typed in them, '
    + 'and nothing that waited for the user\'s approval was done. Open a session again and start that page over.',
};

export function proxyStdio(
  instance: Instance,
  io: { input: Readable; output: Writable },
  fetchImpl: typeof fetch = fetch,
  find: () => Promise<Instance | null> = () => findRunning(fetchImpl),
  stop?: AbortSignal,
): Promise<void> {
  let current = instance;
  let sessionId: string | null = null;
  let initialize: string | null = null;
  // The handshake must land before anything that depends on its session id.
  let ready: Promise<unknown> = Promise.resolve();
  let held: AbortController | null = null;
  /** The host has been connected through this bridge, and a new start of Fanfold since then is news to it. */
  let joined = false;
  let restarted = false;

  const post = (body: string): Promise<Response> => fetchImpl(`http://127.0.0.1:${current.port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${current.token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body,
  });

  /** What Fanfold sends down the stream, passed on to the host one JSON-RPC message a line. */
  const pass = async (res: Response): Promise<void> => {
    const reader = res.ok ? res.body?.getReader() : undefined;
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (let at = buffered.indexOf('\n\n'); at >= 0; at = buffered.indexOf('\n\n')) {
        const data = buffered.slice(0, at).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        buffered = buffered.slice(at + 2);
        const parsed = data ? parseMessage(data) : null;
        if (parsed?.ok) io.output.write(JSON.stringify(parsed.message) + '\n');
      }
    }
  };

  /** A new session from Fanfold: hold its stream open from now on, in place of the last one's. Settles once it is open. */
  const adopt = (id: string | null): Promise<void> => {
    if (!id || id === sessionId) return Promise.resolve();
    sessionId = id;
    held?.abort();
    const holding = new AbortController();
    held = holding;
    const opened = fetchImpl(`http://127.0.0.1:${current.port}/mcp`, {
      method: 'GET',
      headers: { authorization: `Bearer ${current.token}`, 'mcp-session-id': id, accept: 'text/event-stream' },
      signal: holding.signal,
    }).then((res) => { void pass(res).catch(() => {}); }, () => {});
    return Promise.race([opened, wait(STREAM_OPEN_MS)]);
  };

  /*
   * The app restarted: new port or key, and none of this session's state.
   * Find it again and replay the host's own handshake, so the host carries on
   * rather than losing Fanfold until it is restarted itself.
   */
  const reconnect = async (): Promise<boolean> => {
    const next = await find().catch(() => null);
    if (!next || !initialize) return false;
    if (joined) restarted = true;
    current = next;
    sessionId = null;
    const res = await post(initialize);
    if (!res.ok) return false;
    await adopt(res.headers.get('mcp-session-id'));
    await res.text();
    await (await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).text();
    return true;
  };

  const relay = async (line: string, retried = false): Promise<void> => {
    const parsed = parseMessage(line);
    if (!parsed.ok) {
      io.output.write(JSON.stringify(parsed.error) + '\n');
      return;
    }
    const first = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
    // Only a request is answered here: a host's reply to something Fanfold asked has nobody waiting on this side.
    const id = 'method' in first && first.id !== undefined ? (first.id as RpcId) : null;
    const answer = (message: string): void => {
      if (id !== null) io.output.write(JSON.stringify(failure(id, RpcError.internal, message)) + '\n');
    };
    let res: Response;
    try {
      res = await post(line);
    } catch (err) {
      if (!retried && await reconnect()) return relay(line, true);
      return answer(COPY.gone);
    }
    if (res.status === 401 && !retried) {
      await res.text();
      if (await reconnect()) return relay(line, true);
      return answer('Fanfold restarted and could not be reached again; restart this MCP server');
    }
    await adopt(res.headers.get('mcp-session-id'));
    if (sessionId) joined = true;
    const text = (await res.text()).trim();
    // Only JSON-RPC goes to the host: a bare "unauthorized" on stdout is a
    // line it cannot parse, and the request it was waiting on never ends.
    if (!res.ok && !text.startsWith('{') && !text.startsWith('[')) return answer(`Fanfold answered ${res.status}: ${text.slice(0, 120)}`);
    if (text) io.output.write(withRestart(text) + '\n');
  };

  /** The first tool result after a new start of Fanfold says so, as a line of its own above the rest. */
  const withRestart = (text: string): string => {
    if (!restarted) return text;
    try {
      const reply = JSON.parse(text) as { result?: { content?: Array<{ type: string; text?: string }> } };
      if (!Array.isArray(reply.result?.content)) return text;
      restarted = false;
      reply.result.content.unshift({ type: 'text', text: COPY.restarted });
      return JSON.stringify(reply);
    } catch {
      return text;
    }
  };

  // Requests still on their way when the host closes its end are answered first.
  const inflight = new Set<Promise<void>>();
  const track = (p: Promise<void>): Promise<void> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  };

  /** Tell Fanfold this agent is gone, so its windows close and "main" is free. */
  const release = async (): Promise<void> => {
    held?.abort();
    if (!sessionId) return;
    await fetchImpl(`http://127.0.0.1:${current.port}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${current.token}`, 'mcp-session-id': sessionId },
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
  };

  return new Promise<void>((resolve) => {
    let released: Promise<void> | null = null;
    const letGo = (): Promise<void> => (released ??= release());
    const answered = (): Promise<unknown> => Promise.allSettled([...inflight]);
    // A signal does not wait for calls still running: the host that sent them has gone.
    const end = (): void => { void letGo().finally(resolve); };
    if (stop?.aborted) end();
    stop?.addEventListener('abort', end, { once: true });
    onLines(io.input, (line) => {
      if (line.includes('"initialize"')) {
        initialize = line;
        ready = track(relay(line));
        return;
      }
      track(ready.then(() => relay(line)));
    }, () => {
      // Quick calls still get their answers; one waiting on the user is ended by letting the agent go,
      // rather than holding its windows and "main" until the wait runs out.
      void Promise.race([answered(), wait(STDIN_GRACE_MS)])
        .then(letGo)
        .then(() => Promise.race([answered(), wait(LAST_ANSWERS_MS)]))
        .finally(resolve);
    });
  });
}
