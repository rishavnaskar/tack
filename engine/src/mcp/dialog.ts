/**
 * The host's own dialog, shown to its user on Fanfold's behalf.
 *
 * A host can say it shows dialogs and then never answer one: a headless run
 * with nobody at it. So a dialog never holds a tool call for long; after that
 * the agent is told what a host without a dialog is told, and the dialog
 * stays open. A connection whose first dialog goes unanswered that long is
 * taken at its silence: for the rest of it, Fanfold asks as it asks a host
 * that shows no dialogs, at once. Whatever a dialog asks also waits in
 * Fanfold's Review, and an answer there withdraws the dialog at once, with
 * MCP's cancellation notice. An answer the user gives in the dialog later
 * still counts: whoever opened it decides what to do with it.
 */
import type { Logger } from '../lib/log.ts';
import type { CallContext, ClientInfo } from './protocol.ts';

export interface Reply {
  action?: string;
  content?: Record<string, unknown>;
}

/**
 * How long a call waits on a dialog (the first of a connection's, at most
 * `firstMs`), and how often Review is looked at meanwhile. Shortened in tests.
 */
export const dialogWait = { ms: 60_000, firstMs: 20_000, pollMs: 500 };

export interface Dialog {
  /** The user's reply, or null when it failed, was withdrawn, or the connection went. */
  reply: Promise<Reply | null>;
  openedAt: number;
}

/** Connections that have answered a dialog: someone is there, so theirs get the longer wait. */
const answering = new WeakSet<ClientInfo>();
/**
 * When each dialog opened on a connection that has answered none yet: the
 * wait for those is the shorter one. Kept by time, not by connection, since
 * the asking tool passes on only the reply and the time it opened.
 */
const unproven = new Map<number, { client: ClientInfo; log: Logger }>();
const UNPROVEN_KEPT = 500;

/**
 * Nobody answered this connection's first dialog in time: it is treated as a
 * host that shows none, for as long as it is connected. Its later questions
 * and approvals are put the way they are put to such a host, without a wait.
 */
function noDialogs(client: ClientInfo, log: Logger): void {
  if (!client.elicitation) return;
  client.elicitation = false;
  log.info('the host did not answer its first dialog; asking it as a host without dialogs from now on', { client: client.name });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Show the dialog. While it is open, `settled` saying the same thing was answered elsewhere withdraws it. */
export function openDialog(call: CallContext, params: Record<string, unknown>, settled: () => boolean, log: Logger): Dialog {
  const withdraw = new AbortController();
  const openedAt = Date.now();
  let open = true;
  const reply = call.peer.request!('elicitation/create', params, { signal: withdraw.signal })
    .then((r) => r as Reply, (err: unknown) => {
      if (!withdraw.signal.aborted) log.warn('the host could not ask its user', { err });
      return null;
    })
    .finally(() => { open = false; });
  void (async () => {
    while (open) {
      await sleep(dialogWait.pollMs);
      if (open && settled()) withdraw.abort();
    }
  })();
  void reply.then((r) => { if (r) answering.add(call.client); });
  if (!answering.has(call.client)) {
    unproven.set(openedAt, { client: call.client, log });
    if (unproven.size > UNPROVEN_KEPT) unproven.delete(unproven.keys().next().value as number);
    // No reply by the end of the shorter wait: nobody is there to answer this connection's dialogs.
    const silence = setTimeout(() => {
      if (open && !answering.has(call.client)) noDialogs(call.client, log);
    }, Math.min(dialogWait.firstMs, dialogWait.ms));
    silence.unref();
    void reply.finally(() => clearTimeout(silence));
  }
  return { reply, openedAt };
}

/**
 * The reply, if it comes in time: `firstMs` for a dialog of a connection that
 * has answered none, `ms` once it has. 'later' when it does not come, or the
 * call was cancelled: the dialog is still open then.
 */
export async function waitForReply<T>(dialog: { reply: Promise<T>; openedAt: number }, signal: AbortSignal): Promise<T | 'later'> {
  const asked = unproven.get(dialog.openedAt);
  const limit = asked && !answering.has(asked.client) ? Math.min(dialogWait.firstMs, dialogWait.ms) : dialogWait.ms;
  const left = dialog.openedAt + limit - Date.now();
  // Out of time with nobody having answered on this connection: it shows no dialogs from now on.
  const silent = (): 'later' => {
    if (asked && !answering.has(asked.client)) noDialogs(asked.client, asked.log);
    return 'later';
  };
  if (signal.aborted) return 'later';
  if (left <= 0) return silent();
  let timer: NodeJS.Timeout | undefined;
  const later = new Promise<'later'>((resolve) => {
    timer = setTimeout(() => resolve(silent()), left);
    signal.addEventListener('abort', () => resolve('later'), { once: true });
  });
  try {
    return await Promise.race([dialog.reply, later]);
  } finally {
    clearTimeout(timer);
  }
}
