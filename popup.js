
const countEl = document.getElementById('count');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const resetBtn = document.getElementById('reset');
const statusEl = document.getElementById('status');
const barFill = document.getElementById('barFill');
const zipEl = document.getElementById('zipMode');

// Remember the ZIP preference across sessions
chrome.storage.local.get({zipMode: false}).then((s) => { zipEl.checked = !!s.zipMode; });
zipEl.addEventListener('change', () => chrome.storage.local.set({zipMode: zipEl.checked}));

document.querySelectorAll('.quick button').forEach(b => {
  b.addEventListener('click', () => { countEl.value = b.dataset.n; });
});

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  countEl.disabled = running;
}

async function getTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab || !/^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(tab.url || '')) {
    return null;
  }
  return tab;
}

startBtn.addEventListener('click', async () => {
  const target = Math.max(1, Math.min(500, Number(countEl.value) || 10));
  countEl.value = target;

  const tab = await getTab();
  if (!tab) {
    statusEl.textContent = 'افتح صفحة فيسبوك بها عارض الصور أولًا';
    statusEl.className = 'status error';
    return;
  }

  statusEl.textContent = `جارٍ الحفظ... 0 من ${target}`;
  statusEl.className = 'status';
  barFill.style.width = '0%';
  setRunning(true);

  let runId = 0;
  if (zipEl.checked) {
    runId = Date.now();
    try {
      // Wipe previous runs' leftovers before this run starts queueing photos.
      await chrome.runtime.sendMessage({type: 'ZIP_RUN_START', runId});
      await chrome.storage.local.set({zipRunId: runId});
    } catch {}
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {type: 'START_AUTO', target, zipMode: zipEl.checked, runId});
  } catch (e) {
    statusEl.textContent = 'تعذّر التواصل مع الصفحة. أعد تحميل فيسبوك.';
    statusEl.className = 'status error';
    setRunning(false);
  }
});

stopBtn.addEventListener('click', async () => {
  const tab = await getTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, {type: 'STOP_AUTO'}); } catch {}
  }
  setRunning(false);
  statusEl.textContent = 'تم الإيقاف';
});

resetBtn.addEventListener('click', async () => {
  const tab = await getTab();
  if (!tab) {
    statusEl.textContent = 'افتح فيسبوك أولًا';
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {type: 'RESET_COUNTER'});
    statusEl.textContent = 'الترقيم اتردّ لـ 1';
    statusEl.className = 'status';
  } catch {}
});

// Live updates from content script (forwarded by background)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'PROGRESS') {
    const pct = msg.target ? Math.round((msg.saved / msg.target) * 100) : 0;
    barFill.style.width = pct + '%';
    statusEl.textContent = `جارٍ الحفظ... ${msg.saved} من ${msg.target}`;
    statusEl.className = 'status';
  } else if (msg?.type === 'AUTO_FINISHED') {
    setRunning(false);
    if (msg.ok) {
      barFill.style.width = '100%';
      statusEl.textContent = zipEl.checked
        ? `تم حفظ ${msg.saved} صورة — جارٍ تجهيز ملف الـ ZIP...`
        : `تم حفظ ${msg.saved} صورة بنجاح ✓`;
      statusEl.className = 'status done';
    } else if (zipEl.checked && msg.saved > 0) {
      statusEl.textContent = `اتوقف — جارٍ تجهيز الـ ZIP بالصور اللي اتحفظت...`;
      statusEl.className = 'status done';
    } else {
      statusEl.textContent = `اتوقف — ${msg.reason} (${msg.saved} محفوظة)`;
      statusEl.className = 'status error';
    }
  } else if (msg?.type === 'ZIP_DONE') {
    setRunning(false);
    barFill.style.width = '100%';
    statusEl.textContent = `اتنزّل الـ ZIP ✓ (${msg.saved} صورة${msg.failed ? ` — فشل ${msg.failed}` : ''})`;
    statusEl.className = 'status done';
  } else if (msg?.type === 'ZIP_ERROR') {
    setRunning(false);
    statusEl.textContent = `فشل تجميع الـ ZIP: ${msg.error || 'خطأ غير معروف'}`;
    statusEl.className = 'status error';
  }
});

// On open, check current state
(async () => {
  const tab = await getTab();
  if (!tab) {
    statusEl.textContent = 'افتح صفحة فيسبوك وافتح عارض الصور';
    statusEl.className = 'status';
    return;
  }
  try {
    const st = await chrome.tabs.sendMessage(tab.id, {type: 'PING'});
    if (st?.autoMode) {
      setRunning(true);
      const pct = st.autoTarget ? Math.round((st.autoSaved / st.autoTarget) * 100) : 0;
      barFill.style.width = pct + '%';
      statusEl.textContent = `جارٍ الحفظ... ${st.autoSaved} من ${st.autoTarget}`;
    }
  } catch {}
})();
