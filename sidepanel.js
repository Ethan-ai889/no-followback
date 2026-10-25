const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const listEl = $('list');
const exportBtn = $('export');
const scanBtn = $('scan');
const abortBtn = $('abort');

const RESERVED_PATHS = new Set([
  'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose', 'search',
  'login', 'signup', 'tos', 'privacy', 'following', 'followers', 'verified', 'jobs',
  'communities', 'about', 'help', 'download', 'intent', 'hashtag', 'share',
]);

let state = {
  noFollowBack: [], // raw from latest scan
  total: 0,
  followsYou: 0,
  ignored: {}, // usernameLower -> timestamp
  scanning: false,
};

function isIgnored(username) {
  return !!state.ignored[String(username).toLowerCase()];
}

function pendingList() {
  return state.noFollowBack.filter((u) => !isIgnored(u.username));
}

function ignoredInScanCount() {
  return state.noFollowBack.filter((u) => isIgnored(u.username)).length;
}

async function loadIgnored() {
  const data = await chrome.storage.local.get(['ignoreMap', 'doneMap']);
  // migrate old "done" marks into ignore once
  state.ignored = { ...(data.ignoreMap || {}) };
  if (data.doneMap && Object.keys(data.doneMap).length) {
    for (const [k, v] of Object.entries(data.doneMap)) {
      if (!state.ignored[k]) state.ignored[k] = v;
    }
    await chrome.storage.local.set({ ignoreMap: state.ignored });
    await chrome.storage.local.remove(['doneMap']);
  }
}

async function saveIgnored() {
  await chrome.storage.local.set({ ignoreMap: state.ignored });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getActiveXTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = tabs.find((t) => t.url && /https:\/\/(x|twitter)\.com\//.test(t.url));
  if (!tab) {
    const all = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    tab = all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  }
  return tab || null;
}

function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('页面加载超时，请打开 x.com 后重试'));
    }, timeoutMs);

    function finish(tab) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }

    function onUpdated(id, info, tab) {
      if (id === tabId && info.status === 'complete') finish(tab);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish(tab);
    }).catch(() => {});
  });
}

/** Runs in the X page to read the logged-in account (never a hardcoded user). */
function detectLoginInPage() {
  const reserved = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose', 'search',
    'login', 'signup', 'tos', 'privacy', 'following', 'followers', 'verified', 'jobs',
    'communities', 'about', 'help', 'download', 'intent', 'hashtag', 'share',
  ]);

  const pickUser = (href) => {
    const clean = String(href || '').split('?')[0].replace(/\/$/, '');
    const m = clean.match(/^\/([A-Za-z0-9_]+)$/);
    if (!m) return null;
    if (reserved.has(m[1].toLowerCase())) return null;
    return m[1];
  };

  const path = location.pathname || '';
  if (/\/i\/flow\/login/i.test(path) || path === '/login' || path === '/i/flow/single_sign_on') {
    return { loggedIn: false, username: null, reason: 'login_page' };
  }

  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (profileLink) {
    const u = pickUser(profileLink.getAttribute('href'));
    if (u) return { loggedIn: true, username: u, reason: 'profile_link' };
  }

  for (const a of document.querySelectorAll('a[href^="/"]')) {
    const aria = (a.getAttribute('aria-label') || '');
    if (/profile|个人资料|個人資料/i.test(aria)) {
      const u = pickUser(a.getAttribute('href'));
      if (u) return { loggedIn: true, username: u, reason: 'aria_profile' };
    }
  }

  // Account switcher button often exposes @handle in text / aria
  const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  if (switcher) {
    const blob = `${switcher.getAttribute('aria-label') || ''} ${switcher.innerText || ''}`;
    const m = blob.match(/@([A-Za-z0-9_]{1,15})/);
    if (m) return { loggedIn: true, username: m[1], reason: 'switcher' };
  }

  const hasTwid = document.cookie.split(';').some((c) => c.trim().startsWith('twid='));
  const hasAuth = document.cookie.split(';').some((c) => c.trim().startsWith('auth_token='));
  if (hasTwid || hasAuth) {
    return { loggedIn: true, username: null, reason: 'cookie_only' };
  }

  if (document.querySelector('[data-testid="loginButton"], a[href="/login"], a[href*="/i/flow/login"]')) {
    return { loggedIn: false, username: null, reason: 'login_cta' };
  }

  return { loggedIn: false, username: null, reason: 'unknown' };
}

async function detectLoginOnTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: detectLoginInPage,
  });
  return result || { loggedIn: false, username: null, reason: 'inject_failed' };
}

async function ensureContent(tabId) {
  // Always (re)inject so sidepanel updates take effect without full tab reload
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    throw new Error('无法注入脚本。请确认标签页是已加载完成的 x.com 页面（不要用 edge:// 等内部页）。');
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (e) {
    throw new Error('页面脚本未就绪。请刷新正在关注页后再试。');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateSummary() {
  const raw = state.noFollowBack.length;
  const ignored = ignoredInScanCount();
  const pending = raw - ignored;
  $('summary').hidden = false;
  $('sum-total').textContent = String(state.total);
  $('sum-back').textContent = String(state.followsYou);
  $('sum-raw').textContent = String(raw);
  $('sum-ignored').textContent = String(ignored);
  $('sum-pending').textContent = String(pending);
}

function render() {
  const hideIgnored = $('hide-ignored').checked;
  const items = state.noFollowBack.filter((u) => !(hideIgnored && isIgnored(u.username)));
  listEl.innerHTML = '';
  updateSummary();
  if (!items.length) {
    listEl.innerHTML = '<li class="empty">暂无待处理未回关账号（或已全部忽略）。</li>';
    exportBtn.disabled = !state.noFollowBack.length;
    return;
  }
  for (const u of items) {
    const li = document.createElement('li');
    const ignored = isIgnored(u.username);
    li.className = 'item' + (ignored ? ' done' : '');
    li.innerHTML = `
      <div>
        <div class="name">${escapeHtml(u.displayName || u.username)}</div>
        <div class="handle">@${escapeHtml(u.username)}${ignored ? ' · 已忽略' : ''}</div>
      </div>
      <div class="row-actions">
        <button type="button" data-act="locate" data-user="${escapeHtml(u.username)}">定位</button>
        <a href="${u.profileUrl}" target="_blank" rel="noreferrer">主页</a>
        <button type="button" data-act="toggle-ignore" data-user="${escapeHtml(u.username)}">${ignored ? '取消忽略' : '忽略'}</button>
      </div>`;
    listEl.appendChild(li);
  }
  exportBtn.disabled = false;
}

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const user = btn.dataset.user;
  if (btn.dataset.act === 'toggle-ignore') {
    const key = user.toLowerCase();
    if (state.ignored[key]) delete state.ignored[key];
    else state.ignored[key] = Date.now();
    await saveIgnored();
    render();
    setStatus(state.ignored[key] ? `已忽略 @${user}，不计入待处理` : `已取消忽略 @${user}`);
    return;
  }
  if (btn.dataset.act === 'locate') {
    btn.disabled = true;
    setStatus('缩小页面并翻页定位 @' + user + ' …');
    let shrunk = false;
    let tab = null;
    try {
      tab = await getActiveXTab();
      if (!tab) throw new Error('请先打开 x.com 正在关注页');
      await chrome.tabs.update(tab.id, { active: true });
      await ensureContent(tab.id);
      const ping = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      if (!ping || !ping.followingPage) {
        throw new Error('请先打开正在关注页，再点定位');
      }
      try {
        const z = await chrome.runtime.sendMessage({ type: 'SHRINK_TAB', tabId: tab.id });
        shrunk = !!(z && z.ok);
      } catch (e) {}
      await sleep(300);
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'LOCATE_USER',
        username: user,
        options: { stepPauseMs: 140, maxRounds: 600 },
      });
      if (!res || !res.ok) throw new Error((res && res.error) || '定位失败');
      if (!(res.result && res.result.found)) {
        setStatus('列表里没找到 @' + user + '，可能已取关或误扫，可忽略或重新扫描。');
        return;
      }
      // Zoom back to 100%, then re-align — shrink scroll position does not match 100% view
      if (shrunk) {
        setStatus('已找到，恢复 100% 并重新对准 @' + user + ' …');
        try { await chrome.runtime.sendMessage({ type: 'RESTORE_TAB', tabId: tab.id }); } catch (e) {}
        shrunk = false;
        await sleep(400);
        const ref = await chrome.tabs.sendMessage(tab.id, {
          type: 'REFOCUS_USER',
          username: user,
          options: { maxRounds: 50, stepPauseMs: 110 },
        });
        if (ref && ref.ok && ref.result && ref.result.found) {
          const fy = ref.result.followsYou;
          const tip = fy === true ? '（有「关注了你」）' : fy === false ? '（未见「关注了你」）' : '';
          setStatus('已定位到 @' + user + ' ' + tip);
        } else {
          setStatus('已恢复 100%，但对准失败，请再点一次定位或手动稍稍上下滚动。');
        }
      } else {
        const fy = res.result.followsYou;
        const tip = fy === true ? '（有「关注了你」）' : fy === false ? '（未见「关注了你」）' : '';
        setStatus('已定位到 @' + user + ' ' + tip);
      }
    } catch (err) {
      setStatus(String(err.message || err));
    } finally {
      if (shrunk && tab) {
        try { await chrome.runtime.sendMessage({ type: 'RESTORE_TAB', tabId: tab.id }); } catch (e) {}
      }
      btn.disabled = false;
    }
  }
});

$('hide-ignored').addEventListener('change', render);

$('clear-results').addEventListener('click', async () => {
  await chrome.storage.local.remove(['lastScan']);
  state.noFollowBack = [];
  state.total = 0;
  state.followsYou = 0;
  render();
  $('summary').hidden = true;
  setStatus('已清空扫描结果（忽略名单保留）');
});

$('clear-ignored').addEventListener('click', async () => {
  state.ignored = {};
  await chrome.storage.local.remove(['ignoreMap', 'doneMap']);
  await saveIgnored();
  render();
  setStatus('已清空忽略名单');
});

$('open-following').addEventListener('click', async () => {
  setStatus('正在识别当前登录账号…');
  try {
    let tab = await getActiveXTab();
    if (!tab) {
      tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
      await waitTabComplete(tab.id).catch(() => {});
      await sleep(600);
    } else {
      await chrome.tabs.update(tab.id, { active: true });
    }

    let info;
    try {
      info = await detectLoginOnTab(tab.id);
    } catch (e) {
      // Tab may still be on about:blank / internal — open home and retry
      await chrome.tabs.update(tab.id, { url: 'https://x.com/home' });
      await waitTabComplete(tab.id).catch(() => {});
      await sleep(800);
      info = await detectLoginOnTab(tab.id);
    }

    if (!info.loggedIn) {
      await chrome.tabs.update(tab.id, { url: 'https://x.com/i/flow/login' });
      setStatus('请先登录 X，登录后再点「打开正在关注」');
      return;
    }

    if (!info.username) {
      // Nav may not be ready on odd URLs — bounce to home once
      const url = tab.url || '';
      if (!/https:\/\/(x|twitter)\.com\/(home)?\/?(\?|$)/i.test(url) && !/\/home(\/|\?|$)/i.test(url)) {
        await chrome.tabs.update(tab.id, { url: 'https://x.com/home' });
        await waitTabComplete(tab.id).catch(() => {});
        await sleep(900);
        info = await detectLoginOnTab(tab.id);
      } else {
        await sleep(700);
        info = await detectLoginOnTab(tab.id);
      }
    }

    if (!info.username) {
      setStatus('已登录但读不到用户名。请先点开一次自己的主页，再点「打开正在关注」。');
      return;
    }

    if (RESERVED_PATHS.has(info.username.toLowerCase())) {
      setStatus('用户名识别异常，请刷新 x.com 后重试');
      return;
    }

    await chrome.tabs.update(tab.id, { url: `https://x.com/${info.username}/following` });
    setStatus(`已跳转到 @${info.username} 的正在关注`);
  } catch (err) {
    setStatus(String(err.message || err));
  }
});

$('abort').addEventListener('click', async () => {
  const tab = await getActiveXTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'ABORT_SCAN' }); } catch {}
  }
  setStatus('正在停止…');
});

$('scan').addEventListener('click', async () => {
  const tab = await getActiveXTab();
  if (!tab) {
    setStatus('请先打开 x.com 的正在关注页面（可点「打开正在关注」）');
    return;
  }
  state.scanning = true;
  scanBtn.disabled = true;
  abortBtn.disabled = false;
  setStatus('缩小页面并开始扫描，请保持该标签页可见…');
  let shrunk = false;
  try {
    await ensureContent(tab.id);
    const ping = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (!ping?.followingPage) {
      throw new Error('当前不是「正在关注」页。请先点「打开正在关注」，再到地址栏类似 x.com/你的用户名/following 的页面再扫。');
    }
    const z = await chrome.runtime.sendMessage({ type: 'SHRINK_TAB', tabId: tab.id });
    shrunk = !!z?.ok;
    await sleep(400);
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'START_SCAN' });
    if (!res?.ok) throw new Error(res?.error || '扫描失败');
    const r = res.result;
    state.noFollowBack = r.noFollowBack || [];
    state.total = r.total || 0;
    state.followsYou = r.followsYou || 0;
    await chrome.storage.local.set({ lastScan: r });
    const pending = pendingList().length;
    const ignored = ignoredInScanCount();
    setStatus(`完成：共 ${state.total} 人，未回关原始 ${state.noFollowBack.length}，已忽略 ${ignored}，待处理 ${pending}`);
    render();
  } catch (e) {
    setStatus(String(e.message || e));
  } finally {
    if (shrunk) {
      try { await chrome.runtime.sendMessage({ type: 'RESTORE_TAB', tabId: tab.id }); } catch {}
    }
    state.scanning = false;
    scanBtn.disabled = false;
    abortBtn.disabled = true;
  }
});

$('export').addEventListener('click', () => {
  const lines = ['username,displayName,profileUrl,ignored'];
  for (const u of state.noFollowBack) {
    const ignored = isIgnored(u.username) ? '1' : '0';
    lines.push([u.username, JSON.stringify(u.displayName || ''), u.profileUrl, ignored].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `no-followback-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SCAN_PROGRESS') {
    setStatus(`扫描中… 已见 ${msg.scanned} 人，未回关 ${msg.noFollowBack}`);
  }
  if (msg?.type === 'SCAN_ERROR') setStatus(msg.message || '扫描出错');
  if (msg?.type === 'LOCATE_PROGRESS') {
    const phase = msg.phase === 'refocus' ? '对准' : '翻页';
    setStatus('定位 @' + msg.username + ' ' + phase + '中… (' + (msg.round || '') + ')');
  }
});

(async () => {
  await loadIgnored();
  const data = await chrome.storage.local.get(['lastScan', 'scanClearedV3']);
  if (!data.scanClearedV3) {
    await chrome.storage.local.remove(['lastScan', 'doneMap', 'ignoreMap', 'scanClearedV1']);
    state.ignored = {};
    state.noFollowBack = [];
    state.total = 0;
    state.followsYou = 0;
    await chrome.storage.local.set({ ignoreMap: {}, scanClearedV3: true });
    render();
    $('summary').hidden = true;
    setStatus('已清空旧扫描与处理记录，请重新扫描；之后可用「忽略」排除大V');
    return;
  }
  if (data.lastScan?.noFollowBack) {
    state.noFollowBack = data.lastScan.noFollowBack;
    state.total = data.lastScan.total || 0;
    state.followsYou = data.lastScan.followsYou || 0;
    render();
    setStatus(`已加载上次扫描：待处理 ${pendingList().length}（已忽略 ${ignoredInScanCount()}）`);
  } else {
    render();
    $('summary').hidden = true;
    setStatus('就绪：点「打开正在关注」登录自己的号后开始扫描');
  }
})();
