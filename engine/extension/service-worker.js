/**
 * Fanfold's extension: lets the Fanfold app on this computer work in the
 * tabs of the "Fanfold" tab group, through chrome.debugger.
 *
 * It does nothing a site could not see a person's DevTools do. Chrome shows
 * its "is debugging this browser" bar for as long as a tab is attached, and
 * nothing here hides that, alters what a page can observe about the browser,
 * or answers a challenge on the user's behalf.
 *
 * Listeners are registered at the top level, synchronously: a service worker
 * is restarted for an event, and one registered later would miss the event
 * it was woken for.
 */

import { connect, pair, disconnect, emitToFanfold, reportPaused, refreshStatus, askFanfold } from './link.js';
import { forgetGroup, forgetWindow, tidyRestored } from './scope.js';
import {
  wire, restorePaused, setPaused, detachLeftovers,
  onDebuggerEvent, onDebuggerDetach, onTabUpdated, onTabRemoved, onTabCreated,
} from './sessions.js';

wire({
  emit(message) {
    emitToFanfold(message);
    // The popup counts the tabs in use, and this is one fewer.
    if (message.method === 'Fanfold.tabReleased') void refreshStatus();
  },
  onPausedChange: reportPaused,
});

chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener(onDebuggerDetach);
chrome.tabs.onCreated.addListener((tab) => void onTabCreated(tab));
chrome.tabs.onUpdated.addListener((tabId, change) => void onTabUpdated(tabId, change));
chrome.tabs.onRemoved.addListener((tabId) => void onTabRemoved(tabId));
chrome.tabGroups.onRemoved.addListener((group) => void forgetGroup(group.id));
chrome.windows.onRemoved.addListener((windowId) => void forgetWindow(windowId));

/** Tidying what an earlier Chrome left comes before anything is said to Fanfold about it. */
let tidied = Promise.resolve();
const tidy = (opts) => (tidied = tidied.then(() => tidyRestored(opts)).catch(() => {}));

chrome.alarms.onAlarm.addListener(() => void tidied.then(connect));
// Only a real browser start restores a "Fanfold" group; the tabs in it that Fanfold did not make are given back as ordinary tabs.
chrome.runtime.onStartup.addListener(() => void tidy({ ungroupRest: true }).then(connect));
chrome.runtime.onInstalled.addListener(() => void tidied.then(connect));

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only this extension's own pages: no content script exists, and no
  // external sender is declared in the manifest.
  if (sender.id !== chrome.runtime.id) return false;
  const reply = (work) => {
    work.then((value) => respond({ ok: true, value }), (err) => respond({ ok: false, error: String(err?.message ?? err) }));
    return true;
  };
  switch (message?.type) {
    case 'pair':
      return reply(pair(message.code));
    case 'disconnect':
      return reply(disconnect());
    case 'resume':
      return reply(setPaused(false));
    case 'refresh':
      return reply(tidied.then(connect).then(refreshStatus));
    case 'stopTab':
    case 'stopAll':
      return reply(Promise.resolve(askFanfold(message)));
    default:
      return false;
  }
});

async function boot() {
  await restorePaused();
  // A worker that was stopped mid-run left Chrome holding attachments this
  // instance knows nothing about, with Fanfold's connection already gone.
  await detachLeftovers();
  // Tabs Fanfold made that Chrome restored under new ids are closed before Fanfold is told what is its own.
  await tidy({ ungroupRest: false });
  await refreshStatus();
  await connect();
}

void boot();
