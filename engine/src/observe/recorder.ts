/**
 * Watching what a person does on a page, so it can be done again.
 *
 * Runs in the page while the user is teaching a flow. Each thing they do is
 * reported as what it was done to, named the way the agent names elements:
 * by role and accessible name, never by position or a selector. That is the
 * only description that still finds the element next week.
 *
 * What a person types into a password field is never read. The field is
 * reported as a secret, with no value, so a taught flow cannot carry one.
 */

/** One thing the user did. `t` is when, in page time. */
export type RecordedEvent =
  | { kind: 'loaded'; url: string; t: number }
  | { kind: 'click' | 'check' | 'uncheck'; role: string; name: string; t: number }
  | { kind: 'fill' | 'select'; role: string; name: string; value: string; t: number }
  | { kind: 'upload'; role: string; name: string; value: string; t: number }
  | { kind: 'secret'; role: string; name: string; t: number }
  | { kind: 'press'; key: string; t: number };

/** The binding the page calls to report an event. */
const RECORD_BINDING = '__baRecord';

const RECORDER_SOURCE = `(() => {
  window.__baRecording = true;
  if (window.__baRecorder) return;
  window.__baRecorder = true;

  const send = (event) => {
    if (!window.__baRecording || typeof window.${RECORD_BINDING} !== 'function') return;
    event.t = Date.now();
    try { window.${RECORD_BINDING}(JSON.stringify(event)); } catch { /* the watcher has gone */ }
  };
  // The element itself, or the nearest thing around it that has a name.
  const identify = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const id = window.__ba && window.__ba.identify ? window.__ba.identify(n) : null;
      if (id && id.name) return id;
    }
    return null;
  };
  const TOGGLES = ['checkbox', 'radio'];
  const BUTTONS = ['button', 'submit', 'reset', 'image'];

  // Only the page itself: a frame inside it loading is not somewhere the user went.
  if (window.top === window) send({ kind: 'loaded', url: location.href });

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || t.nodeType !== 1) return;
    // Typing and choosing are reported when the value settles, not on the click into the field.
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'OPTION' || t.isContentEditable) return;
    if (t.tagName === 'INPUT' && !BUTTONS.includes(t.type)) return;
    if (t.closest && t.closest('label')) return;
    const id = identify(t);
    if (id) send({ kind: 'click', role: id.role, name: id.name });
  }, true);

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t || t.nodeType !== 1) return;
    const id = identify(t);
    if (!id) return;
    if (t.tagName === 'SELECT') {
      const option = t.selectedOptions[0];
      send({ kind: 'select', role: id.role, name: id.name, value: option ? (option.label || option.text || '') : '' });
    } else if (t.tagName === 'INPUT' && t.type === 'file') {
      send({ kind: 'upload', role: id.role, name: id.name, value: t.files && t.files[0] ? t.files[0].name : '' });
    } else if (t.tagName === 'INPUT' && TOGGLES.includes(t.type)) {
      send({ kind: t.checked ? 'check' : 'uncheck', role: id.role, name: id.name });
    }
  }, true);

  // Typing is reported as it happens, not when the field is left: a field
  // reports its change only on losing focus, which can be after the next
  // thing the user did, and the steps would come out in the wrong order.
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t || t.nodeType !== 1) return;
    const text = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !TOGGLES.includes(t.type) && !BUTTONS.includes(t.type) && t.type !== 'file');
    if (!text) return;
    const id = identify(t);
    if (!id) return;
    if (t.type === 'password') send({ kind: 'secret', role: id.role, name: id.name });
    else send({ kind: 'fill', role: id.role, name: id.name, value: String(t.value).slice(0, 4000) });
  }, true);

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const t = ev.target;
    if (!t || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    send({ kind: 'press', key: 'Enter' });
  }, true);
})();`;

const RECORDER_STOP = 'window.__baRecording = false;';

export function parseRecorded(payload: unknown): RecordedEvent | null {
  if (typeof payload !== 'string' || payload.length > 20_000) return null;
  try {
    const value = JSON.parse(payload) as { kind?: unknown; t?: unknown };
    if (typeof value.kind !== 'string' || typeof value.t !== 'number') return null;
    return value as RecordedEvent;
  } catch {
    return null;
  }
}

/** What recording needs from the page it is watching. */
interface RecordingPort {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluate(expression: string): Promise<unknown>;
  /** Subscribe to calls of page bindings on this page. Returns how to unsubscribe. */
  onBinding(handler: (params: Record<string, unknown>) => void): () => void;
}

/**
 * Start reporting what the user does on a page, on this document and every
 * one it navigates to. The page's naming script must already be installed:
 * the recorder names elements with it. Returns how to stop.
 */
export async function startRecording(
  port: RecordingPort, onEvent: (event: RecordedEvent) => void,
): Promise<() => Promise<void>> {
  await port.send('Runtime.addBinding', { name: RECORD_BINDING });
  const off = port.onBinding((params) => {
    if (params.name !== RECORD_BINDING) return;
    const event = parseRecorded(params.payload);
    if (event) onEvent(event);
  });
  const added = await port.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SOURCE });
  await port.evaluate(RECORDER_SOURCE);
  return async () => {
    off();
    await port.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier }).catch(() => {});
    await port.evaluate(RECORDER_STOP).catch(() => {});
    await port.send('Runtime.removeBinding', { name: RECORD_BINDING }).catch(() => {});
  };
}
