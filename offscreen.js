
// Offscreen ZIP builder.
// The MV3 service worker cannot call URL.createObjectURL(), so the final ZIP is
// assembled and downloaded here. The photo bytes were already fetched and stored
// in IndexedDB by the service worker (keyed by run id) — this file only reads
// them, builds the ZIP and downloads it. Images are already compressed
// (JPEG/PNG), so entries are written with the STORE method — a small
// dependency-free ZIP writer.

// ---- CRC-32 (IEEE 802.3, reflected) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return {time, date};
}

// entries: [{name: string, data: Uint8Array}] -> Blob (application/zip)
function buildZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const {time, date} = dosDateTime(new Date());

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);          // local file header signature
    lh.setUint16(4, 20, true);                  // version needed
    lh.setUint16(6, 0x0800, true);              // flags: UTF-8 names
    lh.setUint16(8, 0, true);                   // method: store
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, e.data.length, true);      // compressed size
    lh.setUint32(22, e.data.length, true);      // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);                  // extra length
    chunks.push(new Uint8Array(lh.buffer), nameBytes, e.data);

    central.push({nameBytes, crc, size: e.data.length, offset, time, date});
    offset += 30 + nameBytes.length + e.data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);          // central directory signature
    cd.setUint16(4, 20, true);                  // version made by
    cd.setUint16(6, 20, true);                  // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, c.time, true);
    cd.setUint16(14, c.date, true);
    cd.setUint32(16, c.crc, true);
    cd.setUint32(20, c.size, true);
    cd.setUint32(24, c.size, true);
    cd.setUint16(28, c.nameBytes.length, true);
    cd.setUint32(42, c.offset, true);           // local header offset
    chunks.push(new Uint8Array(cd.buffer), c.nameBytes);
    cdSize += 46 + c.nameBytes.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);          // end of central directory
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));

  return new Blob(chunks, {type: 'application/zip'});
}

// Exposed for testing outside the browser (node --check / unit tests).
globalThis.ZipKit = {crc32, buildZip};

// ---- IndexedDB access (same database the service worker wrote to) ----
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

function dbGetRun(runId) {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).filter((it) => it && it.runId === runId));
    req.onerror = () => reject(req.error);
  }));
}

function dbClearRun(runId) {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(IDBKeyRange.bound(runId + '::', runId + '::\uffff'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// ---- Assemble + hand off ----
const nameOrder = (n) => parseInt(n, 10) || 0;

// The offscreen document has NO chrome.downloads API, so it cannot download the
// ZIP itself. It builds the blob, hands the object URL to the service worker
// (which downloads it), and must stay alive until then — destroying this page
// revokes its blob URLs.
let currentZip = null;

async function buildAndDownload(runId, filename) {
  const items = await dbGetRun(runId);
  items.sort((a, b) => nameOrder(a.name) - nameOrder(b.name));
  if (!items.length) {
    chrome.runtime.sendMessage({type: 'ZIP_ERROR', error: 'لم يتم العثور على صور محفوظة'}).catch(() => {});
    return;
  }

  const entries = items.map((it) => ({
    name: it.name,
    data: it.data instanceof Uint8Array ? it.data : new Uint8Array(it.data),
  }));

  const blob = buildZip(entries);
  dbClearRun(runId).catch(() => {});

  const url = URL.createObjectURL(blob);
  currentZip = {blob, url};
  chrome.runtime.sendMessage({type: 'ZIP_BLOB_URL', url, filename, saved: entries.length}).catch(() => {});
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'BUILD_ZIP' && Number(msg.runId)) {
      buildAndDownload(Number(msg.runId), msg.filename || 'facebook_photos.zip')
        .catch((e) => chrome.runtime.sendMessage({type: 'ZIP_ERROR', error: String(e?.message || e)}).catch(() => {}));
    } else if (msg?.type === 'ZIP_MAKE_DATA_URL' && currentZip) {
      // Fallback: self-contained data URL for when the service worker can't
      // resolve the blob URL from another context.
      blobToDataUrl(currentZip.blob)
        .then((dataUrl) => chrome.runtime.sendMessage({
          type: 'ZIP_BLOB_URL', url: dataUrl, filename: msg.filename, saved: msg.saved, isDataUrl: true,
        }))
        .catch((e) => chrome.runtime.sendMessage({type: 'ZIP_ERROR', error: String(e?.message || e)}).catch(() => {}));
    }
  });
}
