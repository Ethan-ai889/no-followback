(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const api = {
    scanning: false,
    abortScan: false,
  };

  function isFollowingPage() {
    return /\/following(?:\/|\?|$)/.test(location.pathname);
  }

  function primaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]') || document.body;
  }

  function getUserCells() {
    return [...primaryColumn().querySelectorAll('[data-testid="UserCell"]')];
  }

  function cellLooksLikeFollowingEntry(cell) {
    const btns = [...cell.querySelectorAll('button, [role="button"]')];
    const texts = btns.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim());
    const joined = texts.join(' | ');
    if (/正在关注|Following|取消关注|Unfollow/i.test(joined)) return true;
    if (/关注$|Follow$/i.test(joined) && !/正在关注|Following|取消关注|Unfollow/i.test(joined)) return false;
    return isFollowingPage();
  }

  function parseCell(cell) {
    if (!cellLooksLikeFollowingEntry(cell)) return null;

    const nameRoot = cell.querySelector('[data-testid="User-Name"]');
    const candidates = [];
    if (nameRoot) {
      for (const a of nameRoot.querySelectorAll('a[href^="/"]')) candidates.push(a);
    }
    for (const a of cell.querySelectorAll('a[href^="/"]')) {
      if (!candidates.includes(a)) candidates.push(a);
    }

    let username = '';
    let profileUrl = '';
    for (const a of candidates) {
      const href = (a.getAttribute('href') || '').split('?')[0].replace(/\/$/, '');
      if (!/^\/[A-Za-z0-9_]+$/.test(href)) continue;
      const u = href.slice(1);
      const blocked = new Set([
        'home','explore','notifications','messages','i','settings','compose','search',
        'login','signup','tos','privacy','following','followers','verified','jobs','communities'
      ]);
      if (blocked.has(u.toLowerCase())) continue;
      username = u;
      profileUrl = `https://x.com/${u}`;
      break;
    }
    if (!username) return null;

    let displayName = username;
    if (nameRoot) {
      const spans = [...nameRoot.querySelectorAll('span')].map((s) => (s.textContent || '').trim()).filter(Boolean);
      const name = spans.find((t) => t && !t.startsWith('@') && t.toLowerCase() !== username.toLowerCase());
      if (name) displayName = name;
    }

    const followsYou =
      !!cell.querySelector('[data-testid="userFollowIndicator"]') ||
      /关注了你|Follows you/i.test(cell.innerText || '');

    return { username, displayName, profileUrl, followsYou };
  }

  function highlight(el) {
    const prev = el.style.outline;
    const prevBg = el.style.backgroundColor;
    el.style.outline = '3px solid #1d9bf0';
    el.style.backgroundColor = 'rgba(29,155,240,0.22)';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      el.style.outline = prev;
      el.style.backgroundColor = prevBg;
    }, 3000);
  }

  function cellMatchesUsername(cell, target) {
    const t = String(target).replace(/^@/, '').toLowerCase();
    return [...cell.querySelectorAll('a[href^="/"]')].some((a) => {
      const href = (a.getAttribute('href') || '').split('?')[0].replace(/\/$/, '');
      return href.toLowerCase() === '/' + t;
    });
  }

  function findCellByUsername(target) {
    for (const cell of getUserCells()) {
      if (cellMatchesUsername(cell, target)) return cell;
    }
    return null;
  }

  function scrollStep() {
    const col = primaryColumn();
    const dy = Math.max(Math.floor(window.innerHeight * 0.9), 480);
    window.scrollBy(0, dy);
    if (col && col !== document.body) col.scrollTop = (col.scrollTop || 0) + dy;
  }

  async function scanFollowing({ maxIdleRounds = 10, stepPauseMs = 450 } = {}) {
    if (!isFollowingPage()) {
      throw new Error('请先打开你的「正在关注」页（地址栏应类似 x.com/你的用户名/following）。');
    }
    if (api.scanning) throw new Error('已有扫描在进行中');
    api.scanning = true;
    api.abortScan = false;

    const seen = new Map();
    let idle = 0;
    let lastCount = 0;
    let nextIndex = 0;

    const report = () => {
      const all = [...seen.values()];
      chrome.runtime.sendMessage({
        type: 'SCAN_PROGRESS',
        scanned: all.length,
        noFollowBack: all.filter((u) => !u.followsYou).length,
      }).catch(() => {});
    };

    try {
      window.scrollTo(0, 0);
      const col = primaryColumn();
      if (col.scrollTop !== undefined) col.scrollTop = 0;
      await sleep(400);

      while (idle < maxIdleRounds && !api.abortScan) {
        for (const cell of getUserCells()) {
          const u = parseCell(cell);
          if (!u) continue;
          const key = u.username.toLowerCase();
          const prev = seen.get(key);
          if (!prev) {
            u.index = nextIndex++;
            seen.set(key, u);
          } else if (u.followsYou && !prev.followsYou) {
            u.index = prev.index;
            seen.set(key, u);
          }
        }
        report();

        if (seen.size === lastCount) idle += 1;
        else {
          idle = 0;
          lastCount = seen.size;
        }

        const beforeY = window.scrollY;
        const beforeH = document.documentElement.scrollHeight;
        scrollStep();
        await sleep(stepPauseMs);

        const grew = document.documentElement.scrollHeight > beforeH + 2;
        const moved = Math.abs(window.scrollY - beforeY) > 2;
        if (!grew && !moved && idle >= 2) idle += 1;
      }

      if (api.abortScan) throw new Error('扫描已中止');

      const all = [...seen.values()];
      const result = {
        type: 'SCAN_DONE',
        scannedAt: Date.now(),
        pageUrl: location.href,
        total: all.length,
        followsYou: all.filter((u) => u.followsYou).length,
        noFollowBack: all.filter((u) => !u.followsYou),
      };
      chrome.runtime.sendMessage(result).catch(() => {});
      return result;
    } finally {
      api.scanning = false;
      api.abortScan = false;
    }
  }

  /** Original list-scroll locate. Sidepanel shrinks zoom first for speed. */
  async function locateUser(username, { maxRounds = 500, stepPauseMs = 160 } = {}) {
    if (!username) throw new Error('缺少用户名');
    if (!isFollowingPage()) throw new Error('请先打开「正在关注」页再定位');
    const target = String(username).replace(/^@/, '').toLowerCase();

    // Visible first — no need to rescan from top
    {
      const cell = findCellByUsername(target);
      if (cell) {
        highlight(cell);
        const u = parseCell(cell);
        return { found: true, username: target, followsYou: u ? u.followsYou : null, method: 'visible' };
      }
    }

    window.scrollTo(0, 0);
    const col = primaryColumn();
    if (col.scrollTop !== undefined) col.scrollTop = 0;
    await sleep(280);

    let idle = 0;
    let lastY = -1;
    for (let i = 0; i < maxRounds; i++) {
      const cell = findCellByUsername(target);
      if (cell) {
        highlight(cell);
        const u = parseCell(cell);
        return { found: true, username: target, followsYou: u ? u.followsYou : null, method: 'scroll', round: i + 1 };
      }

      // Also match by href if parse filters are strict
      for (const c of getUserCells()) {
        if (cellMatchesUsername(c, target)) {
          highlight(c);
          const u = parseCell(c);
          return { found: true, username: target, followsYou: u ? u.followsYou : null, method: 'scroll', round: i + 1 };
        }
      }

      const y = window.scrollY;
      scrollStep();
      await sleep(stepPauseMs);

      chrome.runtime.sendMessage({
        type: 'LOCATE_PROGRESS',
        username: target,
        round: i + 1,
      }).catch(() => {});

      if (Math.abs(window.scrollY - y) < 2 && Math.abs(window.scrollY - lastY) < 2) idle += 1;
      else idle = 0;
      lastY = window.scrollY;
      if (idle >= 5) break;
    }
    return { found: false, username: target, method: 'scroll' };
  }


  /** After zoom restore, bring the user back into the 100% viewport. */
  async function refocusUser(username, { maxRounds = 40, stepPauseMs = 120 } = {}) {
    if (!username) throw new Error('缺少用户名');
    if (!isFollowingPage()) throw new Error('请先打开「正在关注」页');
    const target = String(username).replace(/^@/, '').toLowerCase();

    const tryHit = () => {
      const cell = findCellByUsername(target);
      if (!cell) return null;
      highlight(cell);
      const u = parseCell(cell);
      return { found: true, username: target, followsYou: u ? u.followsYou : null, method: 'refocus' };
    };

    const hit = tryHit();
    if (hit) return hit;

    // Search nearby first (zoom change often only shifts viewport a bit)
    const startY = window.scrollY;
    for (let i = 0; i < Math.ceil(maxRounds / 3); i++) {
      window.scrollBy(0, -Math.max(Math.floor(window.innerHeight * 0.85), 400));
      const col = primaryColumn();
      if (col && col !== document.body) col.scrollTop = Math.max(0, (col.scrollTop || 0) - Math.max(Math.floor(window.innerHeight * 0.85), 400));
      await sleep(stepPauseMs);
      const h = tryHit();
      if (h) return h;
    }
    window.scrollTo(0, Math.max(0, startY - 100));
    await sleep(150);
    for (let i = 0; i < maxRounds; i++) {
      const h = tryHit();
      if (h) return h;
      scrollStep();
      await sleep(stepPauseMs);
      chrome.runtime.sendMessage({ type: 'LOCATE_PROGRESS', username: target, round: i + 1, phase: 'refocus' }).catch(() => {});
    }
    return { found: false, username: target, method: 'refocus' };
  }

  api.scanFollowing = scanFollowing;
  api.locateUser = locateUser;
  api.refocusUser = refocusUser;
  api.isFollowingPage = isFollowingPage;
  api.ping = () => ({
    ok: true,
    followingPage: isFollowingPage(),
    href: location.href,
    scanning: api.scanning,
    version: '1.5.3',
  });
  api.abort = () => { api.abortScan = true; };

  window.__nfbApi = api;

  if (!window.__nfbListenerBound) {
    window.__nfbListenerBound = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      const a = window.__nfbApi;
      if (!a) return false;
      if (msg?.type === 'START_SCAN') {
        a.scanFollowing(msg.options || {})
          .then((r) => sendResponse({ ok: true, result: r }))
          .catch((e) => {
            chrome.runtime.sendMessage({ type: 'SCAN_ERROR', message: String(e.message || e) }).catch(() => {});
            sendResponse({ ok: false, error: String(e.message || e) });
          });
        return true;
      }
      if (msg?.type === 'ABORT_SCAN') {
        a.abort();
        sendResponse({ ok: true });
        return false;
      }
      if (msg?.type === 'LOCATE_USER') {
        a.locateUser(msg.username, msg.options || {})
          .then((r) => sendResponse({ ok: true, result: r }))
          .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
        return true;
      }
      if (msg?.type === 'REFOCUS_USER') {
        a.refocusUser(msg.username, msg.options || {})
          .then((r) => sendResponse({ ok: true, result: r }))
          .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
        return true;
      }
      if (msg?.type === 'PING') {
        sendResponse(a.ping());
        return false;
      }
      return false;
    });
  }
})();
