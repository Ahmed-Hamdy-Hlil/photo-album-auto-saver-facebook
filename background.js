
// Download requests from content script.
//
// ZIP mode pipeline: each photo is fetched IMMEDIATELY when reported and stored
// in IndexedDB (keyed by run). Chrome may kill and restart the service worker
// at any time, so nothing that must survive the run may live in SW memory.

const DB_NAME = 'fb_auto_saver';
const STORE = 'photos';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function dbPut(key, value) {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function dbClear() {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function dbGetRun(runId) {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).filter((it) => it && it.runId === runId));
    req.onerror = () => reject(req.error);
  }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'DOWNLOAD' && msg.url && msg.filename) {
    chrome.downloads.download({
      url: msg.url,
      filename: `Facebook Auto Photos/${msg.filename}`,
      saveAs: false,
      conflictAction: 'uniquify',
    }, (id) => {
      if (chrome.runtime.lastError) {
        sendResponse({ok: false, error: chrome.runtime.lastError.message});
      } else {
        sendResponse({ok: true, id});
      }
    });
    return true;
  }

  // ZIP mode: fetch the photo's bytes right now and persist them.
  if (msg?.type === 'ADD_TO_ZIP' && msg.url && msg.filename) {
    (async () => {
      try {
        const res = await fetch(msg.url, {credentials: 'omit'});
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = new Uint8Array(await res.arrayBuffer());
        const runId = Number(msg.runId) || 0;
        await dbPut(runId + '::' + msg.filename, {name: msg.filename, data, runId});
        sendResponse({ok: true});
      } catch (e) {
        sendResponse({ok: false, error: String(e?.message || e)});
      }
    })();
    return true;
  }

  // Popup starts a ZIP run: wipe any leftovers from previous runs first.
  if (msg?.type === 'ZIP_RUN_START') {
    dbClear().catch(() => {}).finally(() => sendResponse({ok: true}));
    return true;
  }

  // Content script reports the run ended (completed or stopped) — popup receives
  // this message directly too; here we only react to it.
  if (msg?.type === 'AUTO_FINISHED') {
    maybeBuildZip();
    sendResponse({ok: true});
    return true;
  }

  // The offscreen builder finished assembling the ZIP and hands us its blob URL
  // (offscreen documents have no chrome.downloads API — we download from here).
  if (msg?.type === 'ZIP_BLOB_URL' && msg.url) {
    cleanupZipWatch();
    startZipDownload(msg.url, msg.filename || 'facebook_photos.zip', Number(msg.saved) || 0, msg.isDataUrl ? 1 : 0);
    sendResponse({ok: true});
    return true;
  }

  // Error reports from the offscreen builder (e.g. no photos found).
  if (msg?.type === 'ZIP_ERROR') {
    zipFail(String(msg.error || 'خطأ غير معروف'));
    sendResponse({ok: true});
    return true;
  }
});

// When an auto run finishes (or is stopped), bundle the queued photos into one ZIP.
async function maybeBuildZip() {
  try {
    const {zipMode, zipRunId} = await chrome.storage.local.get({zipMode: false, zipRunId: 0});
    if (!zipMode) return;
    const items = await dbGetRun(zipRunId);
    if (!items.length) return;

    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
    const filename = `Facebook Auto Photos/Facebook_Photos_${stamp}.zip`;

    await ensureOffscreen();
    chrome.runtime.sendMessage({type: 'BUILD_ZIP', runId: zipRunId, filename}).catch(() => {});
  } catch (e) {
    chrome.runtime.sendMessage({type: 'ZIP_ERROR', error: String(e?.message || e)}).catch(() => {});
  }
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  }).catch(() => null);
  if (contexts && contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Build the ZIP of saved Facebook photos and download it',
  }).catch(() => {}); // "already exists" races are fine
}

function closeOffscreen() {
  chrome.offscreen.closeDocument().catch(() => {});
}

// ---- ZIP download (service worker side) ----
// The blob URL lives in the offscreen page, so that page must stay open until
// the download completes — closing it revokes the URL.
let zipWatch = null;

function startZipDownload(url, filename, saved, attempt) {
  chrome.downloads.download({url, filename, saveAs: false, conflictAction: 'uniquify'}, (id) => {
    const err = chrome.runtime.lastError;
    if (err || id === undefined) {
      if (attempt === 0) {
        // Some Chrome builds can't resolve a blob URL from another context —
        // fall back to a self-contained data URL, once.
        chrome.runtime.sendMessage({type: 'ZIP_MAKE_DATA_URL', filename, saved}).catch(() => {});
      } else {
        zipFail('تعذر تنزيل الملف: ' + (err?.message || 'سبب غير معروف'));
      }
      return;
    }
    const listener = (delta) => {
      if (!zipWatch || delta.id !== zipWatch.id || !delta.state) return;
      if (delta.state.current === 'complete') {
        zipSucceed();
      } else if (delta.state.current === 'interrupted') {
        if (attempt === 0) {
          cleanupZipWatch();
          chrome.runtime.sendMessage({type: 'ZIP_MAKE_DATA_URL', filename, saved}).catch(() => {});
        } else {
          zipFail('تم إيقاف تنزيل الملف');
        }
      }
    };
    zipWatch = {
      id,
      listener,
      filename,
      saved,
      timeout: setTimeout(() => zipFail('انتهت مهلة تنزيل الملف'), 5 * 60 * 1000),
    };
    chrome.downloads.onChanged.addListener(listener);
    // The download may already be finished before the listener got registered.
    chrome.downloads.search({id}, (results) => {
      const st = results && results[0] && results[0].state;
      if (st === 'complete') zipSucceed();
      else if (st === 'interrupted') listener({id, state: {current: 'interrupted'}});
    });
  });
}

function cleanupZipWatch() {
  if (!zipWatch) return;
  clearTimeout(zipWatch.timeout);
  chrome.downloads.onChanged.removeListener(zipWatch.listener);
  zipWatch = null;
}

function zipSucceed() {
  if (!zipWatch) return;
  const w = zipWatch;
  cleanupZipWatch();
  chrome.runtime.sendMessage({type: 'ZIP_DONE', saved: w.saved, filename: w.filename}).catch(() => {});
  closeOffscreen();
}

function zipFail(message) {
  cleanupZipWatch();
  chrome.runtime.sendMessage({type: 'ZIP_ERROR', error: message}).catch(() => {});
  closeOffscreen();
}
