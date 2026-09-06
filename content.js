
(() => {
  'use strict';

  let lastUrl = '';
  let savedKeys = new Set();
  let counter = 1;
  let timer = null;

  // Auto-mode state
  let autoMode = false;
  let autoTarget = 0;
  let autoSaved = 0;
  let autoLoop = null;
  let lastClickedNextAt = 0;
  let lastSeenSameImg = 0;
  let abortFlag = false;
  let zipMode = false;
  let currentRunId = 0;
  let autoSkips = 0;

  const isVisible = (el) => {
    if (!el || el.tagName !== 'IMG') return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 250 && r.height > 180 &&
           r.bottom > 0 && r.right > 0 &&
           r.top < innerHeight && r.left < innerWidth &&
           s.display !== 'none' && s.visibility !== 'hidden' &&
           parseFloat(s.opacity || '1') > 0;
  };

  function getBestImage() {
    const imgs = [...document.images].filter(isVisible);
    if (!imgs.length) return null;

    const scored = imgs.map(img => {
      const r = img.getBoundingClientRect();
      const area = r.width * r.height;
      let score = area;

      let p = img.parentElement;
      for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.position === 'fixed' || ps.position === 'sticky') score *= 1.8;
        const role = (p.getAttribute('role') || '').toLowerCase();
        if (role === 'dialog') score *= 2.5;
        if (p.getAttribute('aria-modal') === 'true') score *= 2.5;
      }

      const ratio = r.width / r.height;
      if (r.width < 450 || r.height < 300) score *= 0.45;
      if (ratio > 8 || ratio < 0.125) score *= 0.1;

      return {img, score};
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.img || null;
  }

  function bestUrl(img) {
    if (!img) return '';
    return img.currentSrc || img.src || '';
  }

  async function loadState() {
    try {
      const s = await chrome.storage.local.get({counter: 1, savedKeys: []});
      counter = Number(s.counter) || 1;
      savedKeys = new Set(Array.isArray(s.savedKeys) ? s.savedKeys : []);
    } catch {}
  }

  async function saveState() {
    try {
      await chrome.storage.local.set({counter, savedKeys: [...savedKeys]});
    } catch {}
  }

  function extFromUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname.toLowerCase();
      const m = p.match(/\.(jpe?g|png|webp|gif|bmp|avif)$/);
      return m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'jpg';
    } catch { return 'jpg'; }
  }

  function keyFor(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname + '_' + (u.searchParams.get('oh') || '');
    } catch { return url; }
  }

  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, 900);
  }

  async function scan() {
    // Photos are saved ONLY while an auto run is active — no silent background saving.
    if (!autoMode) return;

    const img = getBestImage();
    const url = bestUrl(img);
    if (!url || url === lastUrl) return;

    if (!img.complete || img.naturalWidth < 500 || img.naturalHeight < 300) {
      setTimeout(scan, 700);
      return;
    }

    lastUrl = url;
    lastSeenSameImg = Date.now();
    const key = keyFor(url);
    if (savedKeys.has(key)) {
      // Already saved earlier in this run — advance instead of stalling.
      autoSkips++;
      if (autoSkips > 50) {
        finishAuto(false, 'stuck on already-saved photos');
        return;
      }
      setTimeout(() => goNextPhoto(), 800);
      return;
    }

    const ext = extFromUrl(url);
    const filename = String(counter) + '.' + ext;

    chrome.runtime.sendMessage({
      type: zipMode ? 'ADD_TO_ZIP' : 'DOWNLOAD',
      url,
      filename,
      runId: currentRunId
    }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        // This photo failed to queue — skip it and keep the run going.
        if (autoMode) setTimeout(() => goNextPhoto(), 1500);
        return;
      }
      savedKeys.add(key);
      counter++;
      autoSkips = 0;
      saveState();

      autoSaved++;
      reportProgress();
      if (autoSaved >= autoTarget) {
        finishAuto(true);
      } else {
        // small delay, then advance to next photo
        const wait = 1200 + Math.random() * 1300; // 1.2s – 2.5s
        setTimeout(() => goNextPhoto(), wait);
      }
    });
  }

  function reportProgress() {
    chrome.runtime.sendMessage({
      type: 'PROGRESS',
      saved: autoSaved,
      target: autoTarget,
    }).catch(() => {});
  }

  function findNextButton() {
    // Facebook's photo viewer "next" button is usually an <a> / <div> with aria-label containing
    // "Next" (en) / "التالي" (ar) / "Avançar" (pt) etc. We search broadly.
    const candidates = [];
    const els = document.querySelectorAll(
      '[role="button"], button, a[aria-label], [aria-label]'
    );

    const labels = ['next', 'التالي', 'التالى', 'avançar', 'siguiente', 'suivant', 'successivo', 'vor'];

    for (const el of els) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
      const txt = (el.textContent || '').toLowerCase().trim();

      const matchLabel = labels.some(l => aria.includes(l));
      const isNextSvg = !!el.querySelector('svg polygon[points*="4"], svg path[d*="M 6"]');
      const isClose = aria.includes('close') || aria.includes('إغلاق') || aria.includes('اغلاق');

      if (isClose) continue;

      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;

      if (!visible) continue;

      // Next button is usually on the right side of the screen
      const rightSide = r.left > innerWidth * 0.55;
      const verticalCenter = r.top > innerHeight * 0.2 && r.top < innerHeight * 0.85;

      let score = 0;
      if (matchLabel) score += 100;
      if (isNextSvg) score += 60;
      if (rightSide) score += 40;
      if (verticalCenter) score += 20;
      if (r.width >= 20 && r.width <= 80) score += 10;

      if (score > 0) {
        candidates.push({el, score, r});
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function goNextPhoto() {
    if (abortFlag || !autoMode) return;

    const btn = findNextButton();
    if (!btn) {
      // No next button — try keyboard fallback (ArrowRight) so we don't depend on layout guesses
      dispatchKey('ArrowRight');
      lastClickedNextAt = Date.now();
      lastSeenSameImg = lastSeenSameImg || Date.now();
      scheduleScan();
      return;
    }

    btn.click();
    lastClickedNextAt = Date.now();
    lastSeenSameImg = lastSeenSameImg || Date.now();
    scheduleScan();
  }

  function dispatchKey(key) {
    const opts = {
      key,
      code: key === 'ArrowRight' ? 'ArrowRight' : key,
      keyCode: key === 'ArrowRight' ? 39 : 0,
      which: key === 'ArrowRight' ? 39 : 0,
      bubbles: true,
      cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function startAuto(target) {
    if (autoMode) return;
    abortFlag = false;
    autoMode = true;
    autoTarget = Math.max(1, Math.min(500, Number(target) || 10));
    autoSaved = 0;
    autoSkips = 0;
    // Fresh run: ignore photos saved by earlier runs so they can't block this one.
    savedKeys.clear();
    lastUrl = '';
    saveState();

    lastSeenSameImg = Date.now();
    lastClickedNextAt = Date.now();

    reportProgress();

    // Save the current photo first (count = 1)
    scheduleScan();

    // Safety watchdog — if nothing changed for 12s after the last click, abort
    autoLoop = setInterval(() => {
      if (!autoMode) return;
      const idle = Date.now() - Math.max(lastClickedNextAt, lastSeenSameImg);
      if (idle > 12000) {
        finishAuto(false, 'No more photos detected (timeout)');
      }
    }, 1500);
  }

  function stopAuto(reason) {
    if (!autoMode) return;
    abortFlag = true;
    autoMode = false;
    autoTarget = 0;
    if (autoLoop) { clearInterval(autoLoop); autoLoop = null; }
    chrome.runtime.sendMessage({
      type: 'AUTO_FINISHED',
      ok: false,
      saved: autoSaved,
      reason: reason || 'Stopped by user',
    }).catch(() => {});
  }

  function finishAuto(ok, reason) {
    if (!autoMode) return;
    autoMode = false;
    if (autoLoop) { clearInterval(autoLoop); autoLoop = null; }
    chrome.runtime.sendMessage({
      type: 'AUTO_FINISHED',
      ok: !!ok,
      saved: autoSaved,
      reason: reason || (ok ? 'Completed' : 'Stopped'),
    }).catch(() => {});
    showToast(ok ? `Done — ${autoSaved} saved` : `Stopped — ${autoSaved} saved`);
  }

  function showToast(text) {
    const old = document.getElementById('__fb_auto_save_toast');
    if (old) old.remove();
    const d = document.createElement('div');
    d.id = '__fb_auto_save_toast';
    d.textContent = text;
    Object.assign(d.style, {
      position: 'fixed', zIndex: '2147483647', right: '20px', bottom: '20px',
      background: 'rgba(0,0,0,.85)', color: '#fff', padding: '12px 16px',
      borderRadius: '10px', font: '600 14px Arial', boxShadow: '0 3px 14px rgba(0,0,0,.3)',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 2200);
  }

  function start() {
    loadState().then(() => {
      const observer = new MutationObserver(() => {
        // In auto mode: refresh lastSeenSameImg so the watchdog doesn't fire falsely,
        // and rescan because the shown photo may have changed.
        if (autoMode) {
          lastSeenSameImg = Date.now();
          scheduleScan();
        }
      });
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['src', 'srcset', 'style', 'class'],
      });

      setInterval(() => {
        if (!autoMode) return;
        const img = getBestImage();
        const url = bestUrl(img);
        if (url && url !== lastUrl) scheduleScan();
      }, 1000);

      scheduleScan();
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'START_AUTO') {
      zipMode = !!msg.zipMode;
      currentRunId = Number(msg.runId) || 0;
      startAuto(msg.target || 10);
      sendResponse({ok: true, target: autoTarget});
    } else if (msg?.type === 'STOP_AUTO') {
      stopAuto('Stopped by user');
      sendResponse({ok: true});
    } else if (msg?.type === 'RESET_COUNTER') {
      counter = 1;
      savedKeys.clear();
      lastUrl = '';
      saveState();
      showToast('Counter reset — next photo will be 1');
      sendResponse({ok: true});
    } else if (msg?.type === 'PING') {
      sendResponse({ok: true, autoMode, autoSaved, autoTarget});
    }
    // Unknown messages (e.g. broadcasts): never hold the response port open.
  });

  start();
})();
