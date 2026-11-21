/**
 * The connection to Fanfold: find it on loopback, prove both ends, then carry
 * CDP until one side goes away, and come back when it returns.
 *
 * Fanfold cannot dial an extension, so this side dials, and keeps dialling.
 * A service worker is stopped after 30 seconds without an event; traffic on
 * an open WebSocket counts as one, so Fanfold's pings keep this alive while
 * connected, and an alarm wakes it to try again while it is not.
 */

import { newNonce, parsePairingCode, keyFromToken, keyFromCode, proofOf, sameProof } from './auth.js';
import { setDenyHosts, setOwnOrigins } from './policy.js';
import { handleCommand, toCdpError, releaseAll, recheckPolicy, isPaused, attachedCount, closeTabsNamed, fileAccess } from './sessions.js';
import { createdReport } from './scope.js';

const PROTOCOL = 1;
const DEFAULT_PORT = 47600;
const PORT_ATTEMPTS = 5;
const DIAL_TIMEOUT_MS = 8_000;
const CODE_TTL_MS = 5 * 60_000;
const RETRY_ALARM = 'fanfold-reconnect';
const MAX_BACKOFF_MS = 30_000;
/** What the app may be told about the tabs it is using, at most. */
const MAX_IN_USE = 200;

let socket = null;
let dialling = false;
let failures = 0;
let retryTimer = null;
let status = { state: 'not-paired', error: '', port: null };
/** What the last Fanfold that turned this extension away said. */
let refusal = '';

async function publish(patch) {
  status = { ...status, ...patch };
  // The popup reads this, and hears about changes through storage events,
  // so it shows the truth even when it opens while this worker is asleep.
  await chrome.storage.session.set({ status: { ...status, paused: isPaused(), tabs: attachedCount() } });
}

export function refreshStatus() {
  return publish({});
}

async function pendingPairing() {
  const { pairing } = await chrome.storage.session.get('pairing');
  if (!pairing || pairing.expiresAt <= Date.now()) {
    if (pairing) await chrome.storage.session.remove('pairing');
    return null;
  }
  return pairing;
}

async function chromeVersion() {
  const data = await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']).catch(() => null);
  const brand = data?.fullVersionList?.find((b) => b.brand === 'Google Chrome')
    ?? data?.fullVersionList?.find((b) => b.brand === 'Chromium');
  return brand?.version ?? '';
}

function scheduleRetry() {
  const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures) + Math.floor(Math.random() * 500);
  failures++;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), delay);
}

/**
 * A timer dies with the worker; an alarm starts the worker again. Kept for
 * as long as there is a pairing to return to, connected or not, so a worker
 * Chrome stopped for its own reasons still comes back.
 */
async function ensureAlarm() {
  if (!(await chrome.alarms.get(RETRY_ALARM))) await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** Events from sessions.js, and state for Fanfold's status display. */
export function emitToFanfold(message) {
  send(message);
}

export function reportPaused(paused) {
  send({ bridge: 'state', paused });
  void refreshStatus();
}

/**
 * The popup's Stop buttons. Only these two requests reach Fanfold this way,
 * and only over the proven connection. Returns whether it was sent.
 */
export function askFanfold(request) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (request?.type === 'stopAll') send({ bridge: 'stopAll' });
  else if (request?.type === 'stopTab' && /^tab-\d+$/.test(String(request.targetId))) send({ bridge: 'stop', targetId: request.targetId });
  else return false;
  return true;
}

/**
 * The tabs Fanfold says it is using, for the popup's list and the toolbar
 * badge. Kept to what the popup shows: an id, an address and what for.
 */
async function showInUse(tabs) {
  const list = (Array.isArray(tabs) ? tabs : []).slice(0, MAX_IN_USE)
    .filter((t) => t && /^tab-\d+$/.test(String(t.targetId)))
    .map((t) => ({
      targetId: String(t.targetId),
      url: typeof t.url === 'string' ? t.url.slice(0, 2048) : '',
      owner: typeof t.owner === 'string' ? t.owner.slice(0, 16) : '',
      waiting: t.waiting === true,
    }));
  await chrome.storage.session.set({ inUse: list });
  await chrome.action.setBadgeText({ text: list.length ? String(list.length) : '' }).catch(() => {});
  if (list.length) await chrome.action.setBadgeBackgroundColor({ color: '#F0521C' }).catch(() => {});
}

async function onCommand(ws, message) {
  let reply;
  try {
    reply = { id: message.id, result: await handleCommand(message) };
  } catch (err) {
    reply = { id: message.id, error: toCdpError(err) };
  }
  if (typeof message.sessionId === 'string') reply.sessionId = message.sessionId;
  if (socket === ws) send(reply);
  if (message.method.startsWith('Target.')) void refreshStatus();
}

async function onControl(ws, message) {
  switch (message.bridge) {
    case 'ping':
      send({ bridge: 'pong' });
      return;
    case 'policy':
      setDenyHosts(message.denyHosts);
      if (message.ownOrigins !== undefined) setOwnOrigins(message.ownOrigins);
      await recheckPolicy();
      return;
    case 'release':
      await releaseAll({ closeTabs: message.closeTabs === true });
      if (socket === ws) send({ bridge: 'released', ref: message.ref });
      void refreshStatus();
      return;
    case 'close': {
      // Tabs of an earlier run of Fanfold that it no longer wants. Only tabs this extension opened are ever closed this way.
      const closed = await closeTabsNamed(message.targetIds);
      if (socket === ws) send({ bridge: 'closed', ref: message.ref, targetIds: closed });
      void refreshStatus();
      return;
    }
    case 'inUse':
      await showInUse(message.tabs);
      return;
    case 'bye':
      // Fanfold forgot this extension: the token is worthless, and trying
      // it again every few seconds would only be refused every few seconds.
      if (message.reason === 'unpaired') await chrome.storage.local.remove('token');
      return;
    default:
  }
}

function onLive(ws, message) {
  if (typeof message.bridge === 'string') return void onControl(ws, message);
  if (typeof message.id === 'number' && typeof message.method === 'string') void onCommand(ws, message);
}

async function onClosed(ws) {
  if (socket !== ws) return;
  socket = null;
  // Nothing stays attached to the user's tabs with nobody driving them.
  await releaseAll();
  await showInUse([]);
  const { token } = await chrome.storage.local.get('token');
  if (!token) {
    await publish({ state: 'not-paired' });
    return;
  }
  await publish({ state: 'connecting' });
  scheduleRetry();
}

/**
 * One attempt at one port. Resolves 'connected', 'refused' (Fanfold answered
 * and said no), 'stranger' (something answered that could not prove it is the
 * user's Fanfold) or 'unreachable'.
 */
function dial(port, credential) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    } catch {
      resolve('unreachable');
      return;
    }
    const nonce = newNonce();
    let stage = 'opening';
    let outcome = 'unreachable';
    /** Commands that arrive while the report of this extension's tabs is being made, answered after it. */
    const early = [];
    const timer = setTimeout(() => ws.close(), DIAL_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };

    ws.onopen = async () => {
      stage = 'hello';
      ws.send(JSON.stringify({
        bridge: 'hello',
        protocol: PROTOCOL,
        mode: credential.code ? 'pair' : 'token',
        nonce,
        extensionVersion: chrome.runtime.getManifest().version,
        chrome: await chromeVersion(),
        paused: isPaused(),
      }));
    };

    ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (stage === 'live') return onLive(ws, message);
      if (stage === 'reporting') return void early.push(message);

      if (message.bridge === 'refused') {
        // Said before anything was proved, so it may be another Fanfold, or
        // anything else on the port: never a reason to forget the pairing.
        // A Fanfold that really unpaired this extension says so once
        // connected ('bye'), and a new code replaces the token anyway.
        outcome = 'refused';
        refusal = String(message.message ?? 'Fanfold refused the connection.');
        ws.close();
        return;
      }

      if (stage === 'hello' && message.bridge === 'challenge') {
        stage = 'proving';
        const salt = String(message.salt ?? '');
        const key = credential.code
          ? await keyFromCode(credential.code, nonce, salt)
          : await keyFromToken(credential.token);
        if (!sameProof(message.proof, await proofOf(key, 'bridge', port, nonce, salt))) {
          outcome = 'stranger';
          ws.close();
          return;
        }
        ws.send(JSON.stringify(credential.code
          ? { bridge: 'auth', proof: await proofOf(key, 'extension', port, nonce, salt) }
          : { bridge: 'auth', token: credential.token }));
        return;
      }

      if (stage === 'proving' && message.bridge === 'paired' && typeof message.token === 'string') {
        credential.token = message.token;
        await chrome.storage.local.set({ token: message.token });
        await chrome.storage.session.remove('pairing');
        return;
      }

      if (stage === 'proving' && message.bridge === 'ready') {
        stage = 'reporting';
        socket = ws;
        failures = 0;
        setDenyHosts(message.denyHosts);
        setOwnOrigins(message.ownOrigins);
        // Fanfold, now proven, hears which tabs here it opened before anything
        // it asks is answered, so a tab it opens next is never mistaken for one
        // left from before.
        const tabs = await createdReport().catch(() => []);
        send({ bridge: 'created', tabs, fileAccess: await fileAccess() });
        stage = 'live';
        for (const queued of early.splice(0)) onLive(ws, queued);
        await chrome.storage.local.set({ port });
        await publish({ state: 'connected', error: '', port });
        settle('connected');
      }
    };

    ws.onclose = () => {
      if (stage === 'live') return void onClosed(ws);
      if (stage === 'reporting') void onClosed(ws);
      settle(outcome);
    };
  });
}

export async function connect() {
  if (socket || dialling) return;
  dialling = true;
  try {
    const stored = await chrome.storage.local.get(['token', 'port']);
    const pairing = await pendingPairing();
    if (!stored.token && !pairing) {
      await chrome.alarms.clear(RETRY_ALARM);
      await publish({ state: 'not-paired' });
      return;
    }
    await ensureAlarm();
    await publish({ state: 'connecting' });
    const credential = pairing ? { code: pairing.code } : { token: stored.token };
    const defaults = Array.from({ length: PORT_ATTEMPTS }, (_, i) => DEFAULT_PORT + i);
    // A code that names a port means Fanfold is on that port and no other.
    const ports = pairing?.port ? [pairing.port] : [...new Set([stored.port, ...defaults].filter(Boolean))];

    let sawStranger = false;
    let sawRefusal = false;
    refusal = '';
    for (const port of ports) {
      const outcome = await dial(port, credential);
      if (outcome === 'connected') return;
      sawRefusal ||= outcome === 'refused';
      sawStranger ||= outcome === 'stranger';
    }

    if (sawRefusal) {
      // Every port was tried: the Fanfold this extension belongs to is not
      // among those that answered. A code that nobody took is spent.
      if (pairing) await chrome.storage.session.remove('pairing');
      await publish({ state: stored.token ? 'offline' : 'not-paired', error: refusal });
      if (stored.token) scheduleRetry();
      return;
    }

    if (pairing && sawStranger) {
      // A wrong code and a different program on the port look the same from
      // here, and the first is by far the likelier.
      await chrome.storage.session.remove('pairing');
      await publish({
        state: stored.token ? 'offline' : 'not-paired',
        error: 'That pairing code did not match. Check it, or get a new one from Fanfold.',
      });
      if (stored.token) scheduleRetry();
      return;
    }
    await publish({ state: 'offline' });
    scheduleRetry();
  } finally {
    dialling = false;
  }
}

/** The popup's Pair button. Returns an error to show, or null. */
export async function pair(text) {
  const parsed = parsePairingCode(text);
  if (!parsed) return 'A pairing code looks like ABCD-EFGH.';
  await chrome.storage.session.set({ pairing: { ...parsed, expiresAt: Date.now() + CODE_TTL_MS } });
  await publish({ error: '' });
  failures = 0;
  // A dial already under way is using the old token; starting a second
  // beside it would be skipped, and the code would sit unused.
  while (dialling) await new Promise((resolve) => setTimeout(resolve, 50));
  if (socket) {
    // Pairing again while connected: the old connection ends, and its
    // close handler would race this one for the next dial.
    const old = socket;
    socket = null;
    old.close();
    await releaseAll();
  }
  await connect();
  return status.error || null;
}

/** The popup's Disconnect button: let go of every tab and forget Fanfold until paired again. */
export async function disconnect() {
  clearTimeout(retryTimer);
  await chrome.alarms.clear(RETRY_ALARM);
  await chrome.storage.local.remove(['token', 'port']);
  await chrome.storage.session.remove('pairing');
  send({ bridge: 'unpair' });
  const old = socket;
  socket = null;
  old?.close();
  await releaseAll();
  await showInUse([]);
  await publish({ state: 'not-paired', error: '', port: null });
}
