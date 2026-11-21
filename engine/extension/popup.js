/**
 * The popup: what the extension is connected to, the tabs Fanfold is using,
 * and what a person can do about them. State is read from storage rather than
 * asked of the service worker, so it is right even when the worker is asleep.
 *
 * Stop lives here, not in the page: nothing an agent drives can reach an
 * extension page, so nothing but the person can press it.
 */

const STATES = {
  'not-paired': ['Not paired', 'Get a pairing code from Fanfold and enter it here.'],
  connecting: ['Connecting', 'Looking for Fanfold on this computer.'],
  connected: ['Connected', ''],
  offline: ['Fanfold not running', 'Start Fanfold. This will reconnect by itself.'],
  paused: ['Paused', 'You cancelled debugging in Chrome. Fanfold cannot use any tab until you resume.'],
};

export const COPY = {
  inUseTitle: 'Tabs Fanfold is using',
  stopHere: 'Stop Fanfold here',
  stopAll: 'Stop everything',
  stopping: 'Stopping…',
  notSent: 'Fanfold is not connected, so it could not be told to stop.',
  owners: {
    main: 'Fanfold’s main page',
    session: 'an agent’s session',
    run: 'a task',
    import: 'reading a document in',
  },
  waiting: 'waiting for you',
};

const $ = (id) => document.getElementById(id);

let status = null;
let inUse = [];
/** The tab in front of the window the popup was opened from. */
let here = null;

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || 'a blank page';
  }
}

function render() {
  const state = status?.paused && status.state === 'connected' ? 'paused' : status?.state ?? 'not-paired';
  const [title, detail] = STATES[state] ?? STATES['not-paired'];
  // What Fanfold says it is using, or at least the tabs it is attached to.
  const tabs = Math.max(inUse.length, status?.tabs ?? 0);
  $('dot').dataset.state = state;
  $('state').textContent = title;
  $('detail').textContent = state === 'connected'
    ? (tabs === 0 ? 'Fanfold is not using any tab right now.' : `Fanfold is using ${tabs} tab${tabs === 1 ? '' : 's'}.`)
    : detail;
  $('error').textContent = status?.error ?? '';
  $('error').hidden = !status?.error;
  $('pair-form').hidden = state !== 'not-paired' && state !== 'offline';
  $('resume').hidden = state !== 'paused';
  $('disconnect').hidden = state === 'not-paired';
  renderInUse(state === 'connected' || state === 'paused');
}

function renderInUse(connected) {
  const list = $('tabs');
  list.textContent = '';
  $('in-use').hidden = !connected || inUse.length === 0;
  $('in-use-title').textContent = COPY.inUseTitle;
  $('stop-all').textContent = COPY.stopAll;
  // The tab the person is looking at comes first.
  const ordered = [...inUse].sort((a, b) => Number(b.targetId === here) - Number(a.targetId === here));
  for (const tab of ordered) {
    const row = document.createElement('li');
    if (tab.targetId === here) row.dataset.here = '';
    const what = document.createElement('span');
    what.className = 'what';
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = hostOf(tab.url);
    const why = document.createElement('span');
    why.className = 'for';
    why.textContent = [COPY.owners[tab.owner] ?? COPY.owners.run, tab.waiting ? COPY.waiting : ''].filter(Boolean).join(' · ');
    what.append(host, why);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = COPY.stopHere;
    stop.addEventListener('click', () => void stopping(stop, { type: 'stopTab', targetId: tab.targetId }));
    row.append(what, stop);
    list.append(row);
  }
}

async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

async function stopping(button, message) {
  button.disabled = true;
  button.textContent = COPY.stopping;
  const answer = await ask(message);
  if (!answer?.ok || answer.value !== true) {
    $('error').textContent = COPY.notSent;
    $('error').hidden = false;
    button.disabled = false;
    button.textContent = message.type === 'stopAll' ? COPY.stopAll : COPY.stopHere;
  }
}

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('pair').disabled = true;
  const answer = await ask({ type: 'pair', code: $('code').value });
  $('pair').disabled = false;
  if (answer?.ok && !answer.value) $('code').value = '';
});

$('disconnect').addEventListener('click', () => void ask({ type: 'disconnect' }));
$('resume').addEventListener('click', () => void ask({ type: 'resume' }));
$('stop-all').addEventListener('click', () => void stopping($('stop-all'), { type: 'stopAll' }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.status) status = changes.status.newValue;
  if (changes.inUse) inUse = changes.inUse.newValue ?? [];
  if (changes.status || changes.inUse) render();
});

const stored = await chrome.storage.session.get(['status', 'inUse']);
status = stored.status ?? null;
inUse = Array.isArray(stored.inUse) ? stored.inUse : [];
const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
here = front ? `tab-${front.id}` : null;
render();
// Opening the popup is also a nudge: a worker that gave up waiting tries again now.
void ask({ type: 'refresh' });
