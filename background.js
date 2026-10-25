chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const zoomState = new Map();

async function shrinkTab(tabId) {
  try {
    const prev = await chrome.tabs.getZoom(tabId);
    zoomState.set(tabId, prev);
    await chrome.tabs.setZoom(tabId, 0.3);
    return prev;
  } catch (e) {
    console.warn('[no-followback] setZoom failed', e);
    return null;
  }
}

async function restoreTab(tabId) {
  try {
    const prev = zoomState.has(tabId) ? zoomState.get(tabId) : 1;
    zoomState.delete(tabId);
    await chrome.tabs.setZoom(tabId, prev ?? 1);
  } catch (e) {
    try { await chrome.tabs.setZoom(tabId, 1); } catch {}
  }
}

async function wipeScanHistoryOnce() {
  try {
    const { scanClearedV3 } = await chrome.storage.local.get(['scanClearedV3']);
    if (scanClearedV3) return;
    await chrome.storage.local.remove(['lastScan', 'doneMap', 'ignoreMap', 'scanClearedV1']);
    await chrome.storage.local.set({ scanClearedV3: true, ignoreMap: {} });
    console.log('[no-followback] wiped scan/ignore history');
  } catch (e) {
    console.warn('[no-followback] wipe failed', e);
  }
}

chrome.runtime.onInstalled.addListener(() => { wipeScanHistoryOnce(); });
wipeScanHistoryOnce();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SHRINK_TAB') {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId == null) { sendResponse({ ok: false }); return false; }
    shrinkTab(tabId).then((prev) => sendResponse({ ok: true, prev })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'RESTORE_TAB') {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId == null) { sendResponse({ ok: false }); return false; }
    restoreTab(tabId).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'CLEAR_RESULTS') {
    chrome.storage.local.remove(['lastScan']).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'CLEAR_IGNORED') {
    chrome.storage.local.set({ ignoreMap: {} }).then(() => chrome.storage.local.remove(['doneMap'])).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'SCAN_PROGRESS' || msg?.type === 'SCAN_DONE' || msg?.type === 'SCAN_ERROR' || msg?.type === 'LOCATE_PROGRESS') {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  return false;
});
