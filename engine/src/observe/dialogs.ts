/**
 * How a JavaScript dialog is answered.
 *
 * A dialog blocks the page until it is answered, and while a DevTools client
 * is attached with Page enabled, Chrome waits for THAT client to answer rather
 * than dismissing anything itself. Without an answer, a single confirm() on
 * an "are you sure?" button froze the tab and the connection went down behind
 * it, reproduced 5/5 against a button whose only job was to call confirm().
 *
 *   alert          accept: it has one button; accepting is just closing it
 *   confirm/prompt DISMISS: cancel is the conservative answer, and the agent
 *                  must never silently say yes to a question the page thought
 *                  was worth asking
 *   beforeunload   depends on who raised it (below)
 *
 * Who raised a beforeunload decides how it is answered. Raised by a
 * navigation the agent's own Page.navigate started: accept. That is the
 * ordinary browser-initiated path, the same as a person typing a URL and
 * clicking Leave. Raised by a navigation the PAGE started (a link the agent
 * clicked): dismiss. Accepting on that path is what took the browser down on
 * every run from an ordinary Terminal: the renderer-initiated navigation is
 * aborted moments after the accept, Chrome asks again, and accepting the
 * re-ask proceeds with leaving a page that has nowhere to go. The only tab
 * closes and headless Chrome exits 0. Dismissing keeps the page where it is;
 * the recovery then stands the guard down and navigates with Page.navigate.
 *
 * Either way the answer is recorded and shown in the next observation,
 * because "your confirmation was cancelled" changes what the model should
 * believe happened.
 */

import type { DialogEvent, Untrusted } from '../types.ts';

export function answerDialog(
  params: { type?: unknown; message?: unknown },
  navigatingByCommand: boolean,
  now = new Date(),
): DialogEvent {
  const type = String(params.type ?? 'alert') as DialogEvent['type'];
  const raisedByOurNavigate = type === 'beforeunload' && navigatingByCommand;
  const accept = type === 'alert' || raisedByOurNavigate;
  return {
    type,
    message: String(params.message ?? '') as Untrusted,
    answer: accept ? 'accepted' : 'dismissed',
    at: now.toISOString(),
  };
}
