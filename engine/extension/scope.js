/**
 * Where Fanfold is allowed to be: its own tab groups, one per window it opened.
 *
 * Everything the app can list, attach to, open or close goes through here,
 * so "only the Fanfold groups" is a property of this file rather than of
 * every caller remembering to check.
 *
 * Tabs Fanfold opens never go into one of the user's windows: they open in a
 * window of Fanfold's own, unfocused, each in an orange "Fanfold" group. The
 * tabs it opened are remembered in chrome.storage.local, with their address
 * and window, so that after a crash the app can be told which are its own,
 * and after Chrome restarts the restored ones can be closed rather than
 * turning into the user's.
 */

const GROUP_TITLE = 'Fanfold';
const GROUP_COLOR = 'orange';
const NO_GROUP = -1;

/** Opening two tabs at once with no group yet would otherwise make two groups. */
let creating = Promise.resolve();
/** The stored lists are read, changed and written back one change at a time. */
let writing = Promise.resolve();

/** Tabs Fanfold is closing itself, so their closing is not taken for the user's. */
export const closingByFanfold = new Set();

export const targetIdOf = (tabId) => `tab-${tabId}`;
export const urlOf = (tab) => tab.url || tab.pendingUrl || '';

function change(area, key, edit) {
  const next = writing.then(async () => {
    const stored = (await chrome.storage[area].get(key))[key];
    const value = edit(Array.isArray(stored) ? stored : []);
    await chrome.storage[area].set({ [key]: value });
    return value;
  });
  writing = next.catch(() => {});
  return next;
}

async function read(area, key) {
  await writing;
  const stored = (await chrome.storage[area].get(key))[key];
  return Array.isArray(stored) ? stored : [];
}

/**
 * Every Fanfold group open now: the ones made this browser session, and any
 * orange "Fanfold" group, such as one the user made to hand tabs over.
 */
export async function fanfoldGroups() {
  const known = new Set(await read('session', 'groupIds'));
  const groups = await chrome.tabGroups.query({});
  return groups.filter((g) => known.has(g.id) || (g.title === GROUP_TITLE && g.color === GROUP_COLOR));
}

export async function isFanfoldGroup(groupId) {
  if (typeof groupId !== 'number' || groupId === NO_GROUP) return false;
  return (await fanfoldGroups()).some((g) => g.id === groupId);
}

export function forgetGroup(groupId) {
  return change('session', 'groupIds', (ids) => ids.filter((id) => id !== groupId));
}

async function tabsOfGroups(groups) {
  const tabs = [];
  for (const group of groups) tabs.push(...await chrome.tabs.query({ groupId: group.id }));
  return tabs;
}

/** The tabs Fanfold opened, or that its own tabs opened: { tabId, url, windowId, openerTabId?, popup? }. */
export function createdTabs() {
  return read('local', 'createdTabs');
}

function recordCreated(entry) {
  return change('local', 'createdTabs', (list) => [...list.filter((e) => e.tabId !== entry.tabId), entry]);
}

/** Gone, or taken back by the user. Returns what was recorded of it, or null when it was not Fanfold's. */
export async function forgetCreatedTab(tabId) {
  let found = null;
  await change('local', 'createdTabs', (list) => list.filter((e) => {
    if (e.tabId !== tabId) return true;
    found = e;
    return false;
  }));
  return found;
}

/** Kept up to date as the tab moves on, so a restored copy of it can be recognised by its address. */
export async function noteCreatedUrl(tabId, url) {
  if (!(await createdTabs()).some((e) => e.tabId === tabId && e.url !== url)) return;
  await change('local', 'createdTabs', (list) => list.map((e) => (e.tabId === tabId ? { ...e, url } : e)));
}

export function fanfoldWindows() {
  return read('session', 'windows');
}

export function forgetWindow(windowId) {
  return change('session', 'windows', (ids) => ids.filter((id) => id !== windowId));
}

/** Every tab Fanfold may touch: those in its groups, and popup windows its own tabs opened, which Chrome cannot group. */
export async function scopeTabs() {
  const tabs = await tabsOfGroups(await fanfoldGroups());
  const seen = new Set(tabs.map((t) => t.id));
  for (const entry of await createdTabs()) {
    if (!entry.popup || seen.has(entry.tabId)) continue;
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
    if (tab) tabs.push(tab);
  }
  return tabs;
}

/** The tab, if it exists and is Fanfold's to touch right now; otherwise null. */
export async function tabInScope(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  if (await isFanfoldGroup(tab.groupId)) return tab;
  const entry = (await createdTabs()).find((e) => e.tabId === tabId);
  return entry?.popup ? tab : null;
}

function boundsOf(bounds) {
  const out = {};
  for (const key of ['left', 'top', 'width', 'height']) {
    const n = bounds?.[key];
    if (typeof n === 'number' && Number.isFinite(n)) out[key] = Math.round(n);
  }
  return out;
}

/** The first window Fanfold opened this session that is still there. */
async function homeWindow() {
  for (const id of await fanfoldWindows()) {
    const win = await chrome.windows.get(id).catch(() => null);
    if (win?.type === 'normal') return win.id;
  }
  return null;
}

/** Put the tab in this window's Fanfold group, making the group if the window has none. */
async function groupIn(tab) {
  const existing = (await fanfoldGroups()).find((g) => g.windowId === tab.windowId);
  if (existing) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
    return existing.id;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  await change('session', 'groupIds', (ids) => [...ids, groupId]);
  return groupId;
}

async function openTab(url, opts) {
  const windowId = opts.newWindow ? null : await homeWindow();
  let tab;
  if (windowId === null) {
    // Unfocused: a window of Fanfold's never comes up over what the user is doing.
    const where = { url, focused: false, type: 'normal' };
    // Chrome refuses bounds mostly off the screen it can see; then the window goes wherever Chrome puts new ones.
    const win = await chrome.windows.create({ ...where, ...boundsOf(opts.bounds) })
      .catch((err) => (/bounds/i.test(String(err?.message)) ? chrome.windows.create(where) : Promise.reject(err)));
    await change('session', 'windows', (ids) => [...ids, win.id]);
    tab = win.tabs[0];
  } else {
    // Never active: opening a tab must not take the page the user is reading out from under them.
    tab = await chrome.tabs.create({ windowId, url, active: false });
  }
  try {
    await groupIn(tab);
  } catch (err) {
    // A tab that could not be put in a group is outside the scope, and
    // must not be left open as if it were inside it.
    closingByFanfold.add(tab.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw err;
  }
  await recordCreated({ tabId: tab.id, url, windowId: tab.windowId });
  return tab;
}

/** A new tab in a window of Fanfold's own; with `newWindow`, in a new window of its own at `bounds`. */
export function createTab(url, opts = {}) {
  const next = creating.then(() => openTab(url, opts));
  creating = next.catch(() => {});
  return next;
}

/**
 * A tab opened by one of Fanfold's tabs (a popup, "Apply on company site").
 * One opened by a tab Fanfold made is Fanfold's too: grouped where Chrome
 * did not group it, and remembered with the tab that opened it, so the app
 * can give it to the same piece of work. One opened by a tab the user lent
 * stays the user's. Returns what to tell the app, or null when the opener is
 * none of Fanfold's.
 */
export async function adoptOpened(tab) {
  if (typeof tab?.openerTabId !== 'number') return null;
  const opener = await tabInScope(tab.openerTabId);
  if (!opener) return null;
  const mine = (await createdTabs()).some((e) => e.tabId === opener.id);
  const url = urlOf(tab);
  if (mine) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    const popup = win !== null && win.type !== 'normal';
    if (!popup && !(await isFanfoldGroup(tab.groupId))) await groupIn(tab).catch(() => {});
    await recordCreated({ tabId: tab.id, url, windowId: tab.windowId, openerTabId: opener.id, ...(popup ? { popup: true } : {}) });
  }
  return { tabId: tab.id, openerTabId: opener.id, windowId: tab.windowId, url };
}

const BLANK = /^(about:blank|chrome:\/\/newtab\/?)$/i;

/** Windows Fanfold opened that hold nothing but blank tabs are closed; a window the user has put a page in stays. */
async function closeEmptyWindows() {
  for (const id of await fanfoldWindows()) {
    const tabs = await chrome.tabs.query({ windowId: id }).catch(() => []);
    if (tabs.some((t) => t.groupId !== NO_GROUP || !BLANK.test(urlOf(t)))) continue;
    for (const t of tabs) closingByFanfold.add(t.id);
    if (tabs.length) await chrome.windows.remove(id).catch(() => {});
    await forgetWindow(id);
  }
}

/**
 * Close tabs Fanfold opened that are still Fanfold's (the user's own, and
 * ones they took back, are left), then any of its windows left empty. With
 * `only`, just those tab ids. Returns the ids closed.
 */
export async function closeCreatedTabs(only = null) {
  const doomed = [];
  for (const entry of await createdTabs()) {
    if (only && !only.has(entry.tabId)) continue;
    if (await tabInScope(entry.tabId)) doomed.push(entry.tabId);
  }
  for (const id of doomed) closingByFanfold.add(id);
  if (doomed.length) await chrome.tabs.remove(doomed).catch(() => {});
  await change('local', 'createdTabs', (list) => (only ? list.filter((e) => !only.has(e.tabId)) : []));
  await closeEmptyWindows();
  return doomed;
}

/** The tabs Fanfold made that are still Fanfold's, as the app knows them. */
export async function createdReport() {
  const out = [];
  for (const entry of await createdTabs()) {
    const tab = await tabInScope(entry.tabId);
    if (!tab) continue;
    out.push({
      targetId: targetIdOf(tab.id), url: urlOf(tab), windowId: tab.windowId,
      ...(typeof entry.openerTabId === 'number' ? { openerId: targetIdOf(entry.openerTabId) } : {}),
    });
  }
  return out;
}

/**
 * After Chrome starts (or this extension is loaded again), tabs in a
 * restored "Fanfold" group that Fanfold made are closed, matched by address
 * since a restart gives every tab a new id. With `ungroupRest`, which is
 * only right on a real browser start, the rest of those groups are ungrouped,
 * so a restored group never turns Fanfold's old tabs into ones the user lent.
 * Tabs still open from this browser session are left exactly as they are.
 */
export async function tidyRestored({ ungroupRest = false } = {}) {
  const live = [];
  const stale = [];
  for (const entry of await createdTabs()) {
    const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
    // Ids are unique within one browser session; after a restart a tab with the same id and window is that tab restored, or the user's, which is not in Fanfold's scope.
    (tab && tab.windowId === entry.windowId ? live : stale).push(entry);
  }
  const liveIds = new Set(live.map((e) => e.tabId));
  const staleUrls = stale.map((e) => e.url);
  const doomed = [];
  const loose = [];
  const groups = (await chrome.tabGroups.query({})).filter((g) => g.title === GROUP_TITLE && g.color === GROUP_COLOR);
  for (const tab of await tabsOfGroups(groups)) {
    if (liveIds.has(tab.id)) continue;
    const at = staleUrls.indexOf(urlOf(tab));
    if (at >= 0) {
      staleUrls.splice(at, 1);
      doomed.push(tab.id);
    } else if (ungroupRest) {
      loose.push(tab.id);
    }
  }
  for (const id of doomed) closingByFanfold.add(id);
  if (doomed.length) await chrome.tabs.remove(doomed).catch(() => {});
  if (loose.length) await chrome.tabs.ungroup(loose).catch(() => {});
  await change('local', 'createdTabs', (list) => list.filter((e) => liveIds.has(e.tabId)));
  return { closed: doomed.length, ungrouped: loose.length };
}
