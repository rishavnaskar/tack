/**
 * A CDP browser endpoint, as far as Fanfold's client can tell.
 *
 * Fanfold drives a browser through Target.* at the browser level and flat
 * sessions below it. An extension has neither: it has chrome.debugger on one
 * tab at a time, and chrome.tabs for everything else. This file makes the
 * second look like the first for exactly the commands Fanfold sends, scoped
 * to the Fanfold tab groups (scope.js).
 *
 * chrome.debugger allows one attachment per tab per extension, while CDP
 * lets a client hold several sessions on a target (Fanfold attaches a second
 * before it detaches the first when it recovers a tab). So a session here is
 * a name for a tab's single attachment, and the attachment ends when the
 * last name is given up.
 */

import { deniedHost, denyMessage, attachable } from './policy.js';
import {
  scopeTabs, tabInScope, isFanfoldGroup, createTab, adoptOpened, forgetCreatedTab, noteCreatedUrl,
  closeCreatedTabs, createdTabs, fanfoldWindows, closingByFanfold, targetIdOf, urlOf,
} from './scope.js';

const DEBUGGER_VERSION = '1.3';

/**
 * What a session may be asked. Fanfold's own client has the same list; it is
 * repeated here so that holding the pairing token is not enough to reach
 * Network or Storage, where the user's cookies are.
 */
const SESSION_DOMAINS = new Set(['Page', 'Runtime', 'DOM', 'Input', 'Emulation', 'Log']);

const PAUSED_MESSAGE = 'Fanfold is paused in Chrome because debugging was cancelled there. ' +
  'Open the Fanfold extension and choose Resume.';

export const COPY = {
  fileAccess: 'Chrome did not let Fanfold attach the file. In Chrome, open chrome://extensions, choose Details on Fanfold, ' +
    'and turn on "Allow access to file URLs". Then try again.',
  notFanfoldWindow: 'Fanfold did not open that window',
};

/** sessionId -> { tabId, scripts } */
const sessions = new Map();
/** tabId -> Set of sessionIds */
const attached = new Map();
/** tabId -> the chrome.debugger.attach still in flight */
const attaching = new Map();
/**
 * tabId -> the denied host a tab was let go for.
 *
 * The debugger reports a navigation the moment the page commits it, which
 * can be before chrome.tabs has the new address. Asked of chrome.tabs alone,
 * a tab just released for landing on a denied site can still show its old
 * address, and Fanfold would be let straight back onto it.
 */
const releasedFor = new Map();
/** Tabs the debugger already reported closed, so its word and chrome.tabs' word on one tab are said once. */
const gone = new Set();
let nextSession = 1;
let paused = false;
let emit = () => {};
let onPausedChange = () => {};

export function wire(handlers) {
  emit = handlers.emit;
  onPausedChange = handlers.onPausedChange;
}

export function isPaused() {
  return paused;
}

export async function restorePaused() {
  paused = (await chrome.storage.session.get('paused')).paused === true;
}

export async function setPaused(value) {
  if (paused === value) return;
  paused = value;
  await chrome.storage.session.set({ paused });
  onPausedChange(paused);
}

function cdpError(code, message) {
  return Object.assign(new Error(message), { cdp: { code, message } });
}

/** What chrome.debugger says when the attachment a command needed has gone. */
const ATTACHMENT_GONE = /Debugger is not attached|No tab with given id|Detached while handling command/i;

/** chrome.debugger reports a protocol error as a JSON string in Error.message. */
export function toCdpError(err) {
  if (err?.cdp) return err.cdp;
  const message = String(err?.message ?? err);
  // Worded as CDP words it, because that wording is what tells Fanfold the
  // tab is lost and can be recovered rather than that the command was wrong.
  if (ATTACHMENT_GONE.test(message)) return { code: -32001, message: `Session with given id not found. (${message})` };
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed.message === 'string') return { code: parsed.code ?? -32000, message: parsed.message };
  } catch {
    /* not JSON: an extension API error, reported as it is */
  }
  return { code: -32000, message };
}

function tabIdOf(targetId) {
  const match = /^tab-(\d+)$/.exec(String(targetId ?? ''));
  return match ? Number(match[1]) : null;
}

async function requireGroupTab(targetId) {
  const tabId = tabIdOf(targetId);
  const tab = tabId === null ? null : await tabInScope(tabId);
  if (!tab) throw cdpError(-32602, 'No target with given id found in the Fanfold tab group');
  return tab;
}

const deniedTab = (tab) => deniedHost(urlOf(tab)) ?? releasedFor.get(tab.id) ?? null;

async function getTargets() {
  const tabs = (await scopeTabs()).filter((tab) => attachable(urlOf(tab)));
  const ids = new Set(tabs.map((tab) => tab.id));
  // Tabs Fanfold may not work on are listed, since they are in the group,
  // but last: the app attaches to the first page it is shown.
  tabs.sort((a, b) => Number(Boolean(deniedTab(a))) - Number(Boolean(deniedTab(b))));
  return {
    targetInfos: tabs.map((tab) => ({
      targetId: targetIdOf(tab.id),
      type: 'page',
      title: tab.title ?? '',
      url: urlOf(tab),
      attached: attached.has(tab.id),
      canAccessOpener: false,
      // Which tab opened it, when that is one Fanfold may see too: what a page's own popups are told apart by.
      ...(typeof tab.openerTabId === 'number' && ids.has(tab.openerTabId) ? { openerId: targetIdOf(tab.openerTabId) } : {}),
    })),
  };
}

/** Said after the reply, so the app has claimed the tab by the time it hears where it went. */
function reportOpened(params) {
  setTimeout(() => emit({ method: 'Fanfold.tabOpened', params }), 0);
}

async function createTarget(params) {
  if (paused) throw cdpError(-32000, PAUSED_MESSAGE);
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  const host = deniedHost(url);
  if (host) throw cdpError(-32000, denyMessage(host));
  if (!attachable(url)) throw cdpError(-32000, `Fanfold cannot open ${url}`);
  const tab = await createTab(url, {
    newWindow: params.newWindow === true,
    bounds: { left: params.left, top: params.top, width: params.width, height: params.height },
  });
  reportOpened({ targetId: targetIdOf(tab.id), tabId: tab.id, windowId: tab.windowId, url, openerId: null });
  return { targetId: targetIdOf(tab.id) };
}

async function attachToTarget(params) {
  if (paused) throw cdpError(-32000, PAUSED_MESSAGE);
  if (params.flatten !== true) throw cdpError(-32602, 'Only flat sessions are supported (flatten: true)');
  const tab = await requireGroupTab(params.targetId);
  const host = deniedTab(tab);
  if (host) throw cdpError(-32000, denyMessage(host));

  // Reserved before the await, so a second attach to the same tab that
  // arrives meanwhile shares this attachment instead of racing it.
  let ids = attached.get(tab.id);
  if (!ids) {
    ids = new Set();
    attached.set(tab.id, ids);
    attaching.set(tab.id, chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_VERSION));
  }
  try {
    await attaching.get(tab.id);
  } catch (err) {
    if (attached.get(tab.id) === ids) attached.delete(tab.id);
    throw err;
  } finally {
    attaching.delete(tab.id);
  }
  // Released while the attach was in flight: the tab left the group or was closed.
  if (attached.get(tab.id) !== ids) throw cdpError(-32000, 'The tab went away while attaching');
  const sessionId = `ff-${tab.id}-${nextSession++}`;
  ids.add(sessionId);
  sessions.set(sessionId, { tabId: tab.id, scripts: new Set() });
  return { sessionId };
}

async function detachFromTarget(params) {
  const sessionId = String(params.sessionId ?? '');
  const session = sessions.get(sessionId);
  if (!session) throw cdpError(-32602, 'No session with given id');
  sessions.delete(sessionId);
  const ids = attached.get(session.tabId);
  ids?.delete(sessionId);
  if (ids && ids.size === 0) {
    attached.delete(session.tabId);
    await chrome.debugger.detach({ tabId: session.tabId }).catch(() => {});
  } else {
    // The attachment lives on for another session, so what a real CDP
    // session would have taken with it has to be removed by hand.
    for (const identifier of session.scripts) {
      await chrome.debugger
        .sendCommand({ tabId: session.tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })
        .catch(() => {});
    }
  }
  emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: targetIdOf(session.tabId) } });
  return {};
}

async function closeTarget(params) {
  const tab = await requireGroupTab(params.targetId);
  closingByFanfold.add(tab.id);
  await chrome.tabs.remove(tab.id);
  return { success: true };
}

async function activateTarget(params) {
  const tab = await requireGroupTab(params.targetId);
  // Already the one in front of its window: nothing to change, and the
  // user's view of that window is left alone. Otherwise the tab comes
  // forward in its own window; no window is ever raised or focused.
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  return {};
}

/** The window a tab of Fanfold's is in, as Browser.getWindowForTarget reports it. */
async function getWindowForTarget(params) {
  const tab = await requireGroupTab(params.targetId);
  const win = await chrome.windows.get(tab.windowId);
  return {
    windowId: win.id,
    bounds: { left: win.left, top: win.top, width: win.width, height: win.height, windowState: win.state ?? 'normal' },
  };
}

/** Only a window Fanfold opened is moved or resized, and it is never focused. */
async function setWindowBounds(params) {
  const windowId = Number(params.windowId);
  if (!(await fanfoldWindows()).includes(windowId)) throw cdpError(-32000, COPY.notFanfoldWindow);
  const b = params.bounds && typeof params.bounds === 'object' ? params.bounds : {};
  const update = {};
  for (const key of ['left', 'top', 'width', 'height']) if (typeof b[key] === 'number' && Number.isFinite(b[key])) update[key] = Math.round(b[key]);
  if (['normal', 'minimized', 'maximized', 'fullscreen'].includes(b.windowState)) update.state = b.windowState;
  await chrome.windows.update(windowId, update);
  return {};
}

async function getVersion() {
  const data = await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']).catch(() => null);
  const brand = data?.fullVersionList?.find((b) => b.brand === 'Google Chrome')
    ?? data?.fullVersionList?.find((b) => b.brand === 'Chromium');
  return {
    protocolVersion: DEBUGGER_VERSION,
    product: brand ? `Chrome/${brand.version}` : 'Chrome',
    revision: '',
    userAgent: navigator.userAgent,
    jsVersion: '',
  };
}

const BROWSER_COMMANDS = {
  'Target.getTargets': getTargets,
  'Target.createTarget': createTarget,
  'Target.attachToTarget': attachToTarget,
  'Target.detachFromTarget': detachFromTarget,
  'Target.closeTarget': closeTarget,
  'Target.activateTarget': activateTarget,
  'Browser.getVersion': getVersion,
  'Browser.getWindowForTarget': getWindowForTarget,
  'Browser.setWindowBounds': setWindowBounds,
  // Downloads in the user's Chrome go where the user's settings send them.
  'Browser.setDownloadBehavior': async () => ({}),
};

/** No await before chrome.debugger.sendCommand: input events must leave in the order they arrived. */
function sessionCommand(sessionId, method, params) {
  const session = sessions.get(sessionId);
  if (!session) throw cdpError(-32001, 'Session with given id not found.');
  if (!SESSION_DOMAINS.has(method.slice(0, method.indexOf('.')))) {
    throw cdpError(-32601, `'${method}' is not available through the Fanfold extension`);
  }
  if (method === 'Page.navigate') {
    const host = deniedHost(params.url);
    if (host) throw cdpError(-32000, denyMessage(host));
  }
  return chrome.debugger.sendCommand({ tabId: session.tabId }, method, params).then((result) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && result?.identifier) session.scripts.add(result.identifier);
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') session.scripts.delete(params.identifier);
    return result ?? {};
  }, async (err) => {
    // Chrome hands a file to a page through an extension only when the user allowed that extension file URLs.
    if (method === 'DOM.setFileInputFiles' && !(await fileAccess())) throw cdpError(-32000, COPY.fileAccess);
    throw err;
  });
}

/** Whether the user let this extension read local files, which attaching one needs. */
export async function fileAccess() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return null;
  }
}

export async function handleCommand(message) {
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (typeof message.sessionId === 'string') return sessionCommand(message.sessionId, message.method, params);
  const handler = Object.hasOwn(BROWSER_COMMANDS, message.method) ? BROWSER_COMMANDS[message.method] : null;
  if (!handler) throw cdpError(-32601, `'${message.method}' is not available through the Fanfold extension`);
  return handler(params);
}

/**
 * Give a tab up and tell Fanfold, the way a closed tab is reported on a pipe:
 * the session detaches, and the page driving it re-attaches or fails.
 */
async function releaseTab(tabId, reason, detail = {}) {
  const ids = attached.get(tabId);
  if (!ids && !detail.always) return;
  attached.delete(tabId);
  const targetId = targetIdOf(tabId);
  for (const sessionId of ids ?? []) {
    sessions.delete(sessionId);
    emit({ method: 'Inspector.detached', params: { reason }, sessionId });
    emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } });
  }
  if (ids && detail.stillAttached !== false) await chrome.debugger.detach({ tabId }).catch(() => {});
  // byUser: the person took the tab back (dragged it out, ungrouped or closed it), as against Fanfold or a page's own rule letting it go.
  emit({
    method: 'Fanfold.tabReleased',
    params: { targetId, reason, host: detail.host ?? null, message: detail.message ?? null, byUser: detail.byUser === true },
  });
}

/** Fanfold has gone, or has finished: nothing stays attached behind it. */
export async function releaseAll({ closeTabs = false } = {}) {
  const tabIds = [...attached.keys()];
  attached.clear();
  sessions.clear();
  await Promise.all(tabIds.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
  if (closeTabs) await closeCreatedTabs();
}

/** Close these tabs, if Fanfold made them and they are still Fanfold's; nothing else is closed this way. */
export async function closeTabsNamed(targetIds) {
  const wanted = new Set((Array.isArray(targetIds) ? targetIds : []).map(tabIdOf).filter((id) => id !== null));
  const mine = new Set((await createdTabs()).map((e) => e.tabId).filter((id) => wanted.has(id)));
  if (!mine.size) return [];
  return (await closeCreatedTabs(mine)).map(targetIdOf);
}

/** After a service-worker restart the maps are empty but Chrome may still hold attachments. */
export async function detachLeftovers() {
  const tabs = await scopeTabs().catch(() => []);
  await Promise.all(tabs.filter((tab) => !attached.has(tab.id)).map((tab) => chrome.debugger.detach({ tabId: tab.id }).catch(() => {})));
}

async function releaseIfDenied(tabId, url) {
  const host = deniedHost(url);
  if (!host || !attached.has(tabId)) return;
  releasedFor.set(tabId, host);
  await releaseTab(tabId, 'denied-host', { host, message: denyMessage(host) });
}

export async function recheckPolicy() {
  for (const tabId of [...attached.keys()]) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await releaseIfDenied(tabId, urlOf(tab));
  }
}

export function onDebuggerEvent(source, method, params) {
  // Child sessions (out-of-process frames, workers) are never requested, so
  // an event carrying one is not something Fanfold has a session for.
  if (source.sessionId || source.tabId === undefined) return;
  const ids = attached.get(source.tabId);
  if (!ids) return;
  for (const sessionId of ids) emit({ method, params, sessionId });
  if (method === 'Inspector.targetCrashed') {
    emit({ method: 'Target.targetCrashed', params: { targetId: targetIdOf(source.tabId), status: 'crashed', errorCode: 0 } });
  }
  if (method === 'Page.frameNavigated' && params?.frame && !params.frame.parentId) {
    void releaseIfDenied(source.tabId, params.frame.url);
  }
}

export function onDebuggerDetach(source, reason) {
  if (source.tabId === undefined) return;
  // The bar's Cancel button is the user saying stop. Chrome detaches every
  // tab at once; attaching again a moment later would overrule them.
  if (reason === 'canceled_by_user') void setPaused(true);
  const closed = reason === 'target_closed';
  if (closed) gone.add(source.tabId);
  const byFanfold = closed && closingByFanfold.delete(source.tabId);
  void releaseTab(source.tabId, reason, { stillAttached: false, byUser: closed && !byFanfold });
}

export async function onTabUpdated(tabId, change) {
  // chrome.tabs has caught up: from here its address is the one to believe.
  if (change.url && !deniedHost(change.url)) releasedFor.delete(tabId);
  if (change.url) await noteCreatedUrl(tabId, change.url).catch(() => {});
  if (change.groupId !== undefined && !(await isFanfoldGroup(change.groupId))) {
    // Taken back: a tab Fanfold opened that the user moved out is theirs from now on, and is never closed by Fanfold.
    const created = await forgetCreatedTab(tabId);
    if (attached.has(tabId) || created) {
      await releaseTab(tabId, 'left-group', { message: 'The tab was moved out of the Fanfold tab group.', byUser: true, always: true });
    }
    return;
  }
  if (!attached.has(tabId)) return;
  if (change.url) await releaseIfDenied(tabId, change.url);
}

/** A tab appeared: one opened by a tab of Fanfold's is grouped, remembered and reported. */
export async function onTabCreated(tab) {
  const opened = await adoptOpened(tab).catch(() => null);
  if (!opened) return;
  emit({
    method: 'Fanfold.tabOpened',
    params: { targetId: targetIdOf(opened.tabId), tabId: opened.tabId, windowId: opened.windowId, url: opened.url, openerId: targetIdOf(opened.openerTabId) },
  });
}

export async function onTabRemoved(tabId) {
  releasedFor.delete(tabId);
  // An attached tab is reported by the debugger, which says whether Fanfold closed it.
  const reported = gone.delete(tabId) || attached.has(tabId);
  const byFanfold = reported ? false : closingByFanfold.delete(tabId);
  const created = await forgetCreatedTab(tabId);
  if (!reported && created) await releaseTab(tabId, 'closed', { always: true, byUser: !byFanfold, message: 'The tab was closed.' });
}

export function attachedCount() {
  return attached.size;
}
