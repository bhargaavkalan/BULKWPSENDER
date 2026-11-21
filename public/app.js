// ── Auth guard ─────────────────────────────────────────────────────────────────
const authToken = sessionStorage.getItem('bulkwa_token');
if (!authToken) { window.location.href = '/'; }

// ── Authenticated fetch wrapper ────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['x-auth-token'] = authToken;
  const res = await fetch(url, options);
  if (res.status === 401) { sessionStorage.clear(); window.location.href = '/'; }
  return res;
}

// ── Anti-ban pause event ───────────────────────────────────────────────────────
socket.on('anti_ban_pause', data => {
  const banner = document.getElementById('antibан-banner');
  if (banner) {
    document.getElementById('antibан-reason').textContent = '🛡️ ' + data.reason;
    banner.style.display = 'flex';
    setTimeout(() => { banner.style.display = 'none'; }, (data.ms || 5000) + 2000);
  }
  toast('🛡️ ' + data.reason, 'info', (data.ms || 5000) + 1000);
});

// ── Anti-Ban helpers ───────────────────────────────────────────────────────────
function getAntiBanConfig() {
  return {
    enabled:           document.getElementById('ab-enabled')?.checked  ?? true,
    typingDelay:       document.getElementById('ab-typing')?.checked   ?? true,
    shuffleRecipients: document.getElementById('ab-shuffle')?.checked  ?? false,
    spintax:           document.getElementById('ab-spintax')?.checked  ?? false,
    minDelay:          parseInt(document.getElementById('ab-min-delay')?.value)  || 4000,
    maxDelay:          parseInt(document.getElementById('ab-max-delay')?.value)  || 12000,
    batchSize:         parseInt(document.getElementById('ab-batch')?.value)      || 20,
    batchBreakMin:     parseInt(document.getElementById('ab-break-min')?.value)  || 30000,
    batchBreakMax:     parseInt(document.getElementById('ab-break-max')?.value)  || 60000,
    maxPerHour:        parseInt(document.getElementById('ab-max-hour')?.value)   || 100,
  };
}

function syncAntiBan() { /* values read on send — no extra action needed */ }

function toggleAntiBan() {
  const panel   = document.getElementById('antibан-panel');
  const chevron = document.getElementById('antibан-chevron');
  panel.classList.toggle('open');
  chevron.style.transform = panel.classList.contains('open') ? 'rotate(180deg)' : '';
}

function applyPreset(preset) {
  const presets = {
    safe:     { min: 8000,  max: 20000, batch: 10, bMin: 60000,  bMax: 120000, maxHr: 50  },
    balanced: { min: 4000,  max: 12000, batch: 20, bMin: 30000,  bMax: 60000,  maxHr: 100 },
    fast:     { min: 1500,  max: 4000,  batch: 50, bMin: 15000,  bMax: 30000,  maxHr: 200 },
  };
  const p = presets[preset];
  if (!p) return;
  document.getElementById('ab-min-delay').value  = p.min;
  document.getElementById('ab-max-delay').value  = p.max;
  document.getElementById('ab-batch').value       = p.batch;
  document.getElementById('ab-break-min').value   = p.bMin;
  document.getElementById('ab-break-max').value   = p.bMax;
  document.getElementById('ab-max-hour').value    = p.maxHr;
  const labels = { safe: '🛡️ Safe preset applied', balanced: '⚖️ Balanced preset applied', fast: '⚡ Fast preset applied' };
  toast(labels[preset], 'success');
}

// ── Socket.IO ──────────────────────────────────────────────────────────────────
const socket = io();

// ── State ──────────────────────────────────────────────────────────────────────
let clientReady  = false;
let contacts = [];          // [{phone, message}]
let uploadedFile = null;    // {filename, originalname, size, mimetype}
let csvFilename  = null;    // server filename of uploaded CSV
let csvRows      = [];      // parsed CSV rows preview
let csvAttachedFile = null; // file attached to CSV campaign

// ── Tab navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('tab-' + el.dataset.tab).classList.add('active');
  });
});

// ── Socket events ──────────────────────────────────────────────────────────────
socket.on('qr', qrDataUrl => {
  console.log('[App] QR received via WebSocket');
  document.getElementById('qr-img').src = qrDataUrl;
  document.getElementById('qr-img').style.display = 'block';
  document.querySelector('.qr-placeholder').style.display = 'none';
  document.getElementById('qr-panel').style.display = 'flex';
  document.getElementById('connected-panel').style.display = 'none';
  document.getElementById('status-text').textContent = 'QR Code Ready! Scan now with WhatsApp.';
  document.getElementById('status-text').style.color = 'var(--green)';
});

socket.on('ready', info => {
  document.getElementById('wa-name').textContent   = info.name   || 'WhatsApp';
  document.getElementById('wa-number').textContent = info.number ? '+' + info.number : '';
  document.getElementById('qr-panel').style.display = 'none';
  document.getElementById('connected-panel').style.display = 'flex';
  document.getElementById('conn-badge').className  = 'badge connected';
  document.getElementById('conn-badge').innerHTML  = '<i class="fas fa-circle"></i> Connected';
  document.getElementById('btn-logout').style.display = 'inline-flex';
});

socket.on('status', data => {
  document.getElementById('status-text').textContent = data.message || '';
  if (!data.connected) {
    document.getElementById('conn-badge').className = 'badge disconnected';
    document.getElementById('conn-badge').innerHTML = '<i class="fas fa-circle"></i> Disconnected';
    document.getElementById('btn-logout').style.display = 'none';
  }
});

socket.on('campaign_status', data => updateCampaignUI(data));

socket.on('log_entry', entry => prependLogRow(entry));

socket.on('campaign_done', data => {
  toast(`✅ Done! Sent: ${data.sent}  Failed: ${data.failed}`, 'success', 5000);
});

// ── Campaign UI ────────────────────────────────────────────────────────────────
function updateCampaignUI(data) {
  document.getElementById('stat-sent').textContent   = data.sent   || 0;
  document.getElementById('stat-failed').textContent = data.failed || 0;
  document.getElementById('stat-total').textContent  = data.total  || 0;
  document.getElementById('stat-status').textContent = data.running ? 'Running' : 'Idle';

  const pct = data.total ? Math.round(((data.sent + data.failed) / data.total) * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-label').textContent = data.running
    ? `Sending ${data.sent + data.failed} / ${data.total}…` : 'Complete';
  document.getElementById('progress-section').style.display = data.total ? 'block' : 'none';

  // Rebuild full log on reconnect
  if (data.log && data.log.length) {
    const tbody = document.getElementById('log-body');
    tbody.innerHTML = '';
    data.log.forEach(prependLogRow);
  }
}

function prependLogRow(entry) {
  const tbody = document.getElementById('log-body');
  // remove placeholder
  const ph = tbody.querySelector('td[colspan]');
  if (ph) ph.closest('tr').remove();

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${entry.index}</td>
    <td>${entry.phone}</td>
    <td class="status-${entry.status}">${entry.status.toUpperCase()}</td>
    <td>${entry.time}</td>
    <td class="muted">${entry.error || ''}</td>`;
  tbody.prepend(tr);
}

// ── Compose: contacts ──────────────────────────────────────────────────────────
function renderContacts() {
  const list = document.getElementById('contacts-list');
  if (!contacts.length) { list.innerHTML = '<div class="muted" style="font-size:0.82rem">No contacts added yet.</div>'; return; }
  list.innerHTML = contacts.map((c, i) => `
    <div class="contact-row">
      <span class="phone">${c.phone}</span>
      <span class="msg-preview">${c.message || '<em>default msg</em>'}</span>
      <button class="btn-icon btn-danger-icon" onclick="removeContact(${i})"><i class="fas fa-times"></i></button>
    </div>`).join('');
}

function addContact() {
  const phone = document.getElementById('new-phone').value.trim().replace(/\D/g,'');
  if (!phone) { toast('Enter a phone number', 'error'); return; }
  const message = document.getElementById('new-msg-override').value.trim();
  contacts.push({ phone, message });
  document.getElementById('new-phone').value = '';
  document.getElementById('new-msg-override').value = '';
  renderContacts();
}

function removeContact(i) { contacts.splice(i, 1); renderContacts(); }
function clearContacts()   { contacts = []; renderContacts(); }

function loadPasted() {
  const raw = document.getElementById('bulk-paste').value.trim();
  if (!raw) return;
  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
  lines.forEach(l => {
    const phone = l.replace(/\D/g,'');
    if (phone.length >= 7) contacts.push({ phone, message: '' });
  });
  document.getElementById('bulk-paste').value = '';
  toast(`Added ${lines.length} numbers`, 'success');
  renderContacts();
}

function pasteNumbers() { document.getElementById('bulk-paste').focus(); }

// ── File upload ────────────────────────────────────────────────────────────────
function getFileIcon(mime) {
  if (!mime) return 'fa-file';
  if (mime.startsWith('image/')) return 'fa-file-image';
  if (mime.startsWith('video/')) return 'fa-file-video';
  if (mime.startsWith('audio/')) return 'fa-file-audio';
  if (mime.includes('pdf'))  return 'fa-file-pdf';
  if (mime.includes('word') || mime.includes('document')) return 'fa-file-word';
  if (mime.includes('excel') || mime.includes('sheet'))   return 'fa-file-excel';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('compressed')) return 'fa-file-zipper';
  return 'fa-file';
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

async function uploadFileToServer(file, prefix) {
  const form = new FormData();
  form.append('file', file);
  const r = await apiFetch('/api/upload/file', { method: 'POST', body: form });
  return await r.json();
}

async function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  toast('Uploading file…', 'info');
  const res = await uploadFileToServer(file);
  if (res.error) { toast(res.error, 'error'); return; }
  uploadedFile = res;
  document.getElementById('drop-label').textContent = 'File attached';
  const prev = document.getElementById('file-preview');
  prev.style.display = 'flex';
  document.getElementById('file-icon').className = `fas ${getFileIcon(res.mimetype)}`;
  document.getElementById('file-name').textContent = res.originalname;
  document.getElementById('file-size').textContent = formatBytes(res.size);
  document.getElementById('caption-row').style.display = 'block';
  toast('File uploaded: ' + res.originalname, 'success');
}

function removeFile() {
  uploadedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('caption-row').style.display = 'none';
  document.getElementById('drop-label').textContent = 'Drag & drop any file here, or click to browse';
}

// CSV tab file
async function handleCsvFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  toast('Uploading file…', 'info');
  const res = await uploadFileToServer(file);
  if (res.error) { toast(res.error, 'error'); return; }
  csvAttachedFile = res;
  document.getElementById('csv-file-drop-label').textContent = 'File attached';
  const prev = document.getElementById('csv-file-preview');
  prev.style.display = 'flex';
  document.getElementById('csv-file-icon').className = `fas ${getFileIcon(res.mimetype)}`;
  document.getElementById('csv-file-name').textContent = res.originalname;
  document.getElementById('csv-file-size').textContent = formatBytes(res.size);
  document.getElementById('csv-caption-row').style.display = 'block';
  toast('File uploaded: ' + res.originalname, 'success');
}

function removeCsvFile() {
  csvAttachedFile = null;
  document.getElementById('csv-file-input').value = '';
  document.getElementById('csv-file-preview').style.display = 'none';
  document.getElementById('csv-caption-row').style.display = 'none';
  document.getElementById('csv-file-drop-label').textContent = 'Drag & drop any file here, or click to browse';
}

// ── Drag & drop ────────────────────────────────────────────────────────────────
function onDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDrop(e) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.getElementById('file-input');
  inp.files = dt.files;
  handleFileSelect(inp);
}
function onDropCsv(e) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.getElementById('csv-input');
  inp.files = dt.files;
  handleCsvSelect(inp);
}
function onDropCsvFile(e) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.getElementById('csv-file-input');
  inp.files = dt.files;
  handleCsvFileSelect(inp);
}

// ── CSV upload ─────────────────────────────────────────────────────────────────
async function handleCsvSelect(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('csv', file);
  toast('Parsing CSV…', 'info');
  const r = await apiFetch('/api/upload/csv', { method: 'POST', body: form });
  const res = await r.json();
  if (res.error) { toast(res.error, 'error'); return; }
  csvFilename = res.file;
  csvRows     = res.rows;
  document.getElementById('csv-drop-label').textContent = file.name;
  document.getElementById('csv-info-text').textContent = `${res.count} contacts loaded from ${file.name}`;
  renderCsvTable(res.rows.slice(0, 10));
  document.getElementById('csv-preview').style.display = 'block';
  toast(`CSV loaded: ${res.count} contacts`, 'success');
}

function removeCsv() {
  csvFilename = null; csvRows = [];
  document.getElementById('csv-input').value = '';
  document.getElementById('csv-preview').style.display = 'none';
  document.getElementById('csv-drop-label').textContent = 'Drag & drop CSV here, or click to browse';
}

function renderCsvTable(rows) {
  if (!rows.length) return;
  const wrap = document.getElementById('csv-table-wrap');
  const headers = Object.keys(rows[0]);
  wrap.innerHTML = `<table>
    <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${headers.map(h=>`<td>${r[h]||''}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

// ── Send campaign ──────────────────────────────────────────────────────────────
async function startCampaign() {
  if (!contacts.length) { toast('Add at least one contact', 'error'); return; }
  const message = document.getElementById('default-message').value.trim();
  if (!message && !uploadedFile) { toast('Enter a message or attach a file', 'error'); return; }

  const body = {
    contacts,
    message,
    attachedFile: uploadedFile?.filename || null,
    caption: document.getElementById('file-caption').value.trim() || null,
    delayMs: parseInt(document.getElementById('delay').value) || 2000,
    antiBan: getAntiBanConfig()
  };

  const r = await apiFetch('/api/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const res = await r.json();
  if (res.error) { toast(res.error, 'error'); return; }
  toast(`Campaign started! ${res.total} messages queued.`, 'success');
  // Switch to dashboard
  document.querySelector('[data-tab="dashboard"]').click();
}

async function startCsvCampaign() {
  if (!csvFilename) { toast('Upload a CSV file first', 'error'); return; }
  const message = document.getElementById('csv-default-message').value.trim();
  if (!message && !csvAttachedFile) { toast('Enter a default message or attach a file', 'error'); return; }

  const body = {
    csvFile: csvFilename,
    message,
    attachedFile: csvAttachedFile?.filename || null,
    caption: document.getElementById('csv-file-caption')?.value.trim() || null,
    delayMs: parseInt(document.getElementById('csv-delay').value) || 2000,
    antiBan: getAntiBanConfig()
  };

  const r = await apiFetch('/api/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const res = await r.json();
  if (res.error) { toast(res.error, 'error'); return; }
  toast(`CSV Campaign started! ${res.total} messages queued.`, 'success');
  document.querySelector('[data-tab="dashboard"]').click();
}

// ── Stop campaign ──────────────────────────────────────────────────────────────
document.getElementById('btn-stop').addEventListener('click', async () => {
  await apiFetch('/api/stop', { method: 'POST' });
  toast('Campaign stopped', 'info');
});

// ── Logout ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('Disconnect WhatsApp and logout?')) return;
  try { await apiFetch('/api/logout', { method: 'POST' }); } catch(e) {}
  sessionStorage.clear();
  window.location.href = '/';
});

// ── Clear logs ─────────────────────────────────────────────────────────────────
function clearLogs() {
  document.getElementById('log-body').innerHTML =
    '<tr><td colspan="5" class="muted text-center">No messages sent yet.</td></tr>';
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<i class="fas ${icons[type]} " style="color:var(--${type==='success'?'green':type==='error'?'red':'blue'})"></i><span>${msg}</span>`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── Refresh QR directly ───────────────────────────────────────────────────────
function reloadQrImg() {
  const qrImg = document.getElementById('qr-img');
  if (qrImg && !clientReady) {
    qrImg.src = '/api/qr.png?t=' + Date.now();
  }
}
setInterval(reloadQrImg, 3000);
reloadQrImg();

// ── Periodic fallback status check ─────────────────────────────────────────────
async function checkStatusFallback() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    console.log('[Status Polling]', data);
    if (data.qr && !clientReady) {
      const qrImg = document.getElementById('qr-img');
      if (qrImg.src !== data.qr) {
        qrImg.src = data.qr;
      }
      qrImg.style.display = 'block';
      const ph = document.querySelector('.qr-placeholder');
      if (ph) ph.style.display = 'none';
      document.getElementById('qr-panel').style.display = 'flex';
      const statusTxt = document.getElementById('status-text');
      if (statusTxt) {
        statusTxt.textContent = 'QR Code Ready! Scan now with WhatsApp.';
        statusTxt.style.color = '#25D366';
      }
    }
  } catch (e) {
    console.error('Status check error:', e);
  }
}
setInterval(checkStatusFallback, 2500);
checkStatusFallback();

// ── Init ───────────────────────────────────────────────────────────────────────
renderContacts();
