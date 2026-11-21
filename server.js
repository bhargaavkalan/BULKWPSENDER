const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const { parse } = require('csv-parse');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// ─── Auth credentials ──────────────────────────────────────────────────────────
const AUTH_USER = 'Savoire';
const AUTH_PASS = 'Savoire@2026@123456789';
const AUTH_TOKEN = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');

// ─── Auth middleware (checks x-auth-token header sent by frontend) ─────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(cors());
app.use(express.json());

// ── Public routes (no auth needed) ────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// Login API — returns token on success
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    return res.json({ success: true, token: AUTH_TOKEN });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

// Dashboard (protected page)
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Static assets (css, js, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ─── Upload directories ────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CSV_DIR    = path.join(__dirname, 'uploads', 'csv');
const FILE_DIR   = path.join(__dirname, 'uploads', 'files');
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(CSV_DIR);
fs.ensureDirSync(FILE_DIR);

// ─── Multer storage ────────────────────────────────────────────────────────────
const csvStorage = multer.diskStorage({
  destination: CSV_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const fileStorage = multer.diskStorage({
  destination: FILE_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const uploadCsv  = multer({ storage: csvStorage });
const uploadFile = multer({ storage: fileStorage, limits: { fileSize: 64 * 1024 * 1024 } });

// ─── WhatsApp client ───────────────────────────────────────────────────────────
let client = null;
let clientReady = false;
let qrDataUrl = null;
let campaignStatus = { running: false, total: 0, sent: 0, failed: 0, log: [] };

function createClient() {
  const puppeteerOpts = {
    headless: true,
    timeout: 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--window-size=1280,720'
    ]
  };

  // If running in Docker / Linux container with system Chromium installed
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else if (process.platform === 'linux' && fs.existsSync('/usr/bin/chromium')) {
    puppeteerOpts.executablePath = '/usr/bin/chromium';
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    webVersion: '2.3000.1017054136-alpha',
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017054136-alpha.html',
    },
    puppeteer: puppeteerOpts
  });

  client.on('qr', async (qr) => {
    qrDataUrl = await qrcode.toDataURL(qr);
    clientReady = false;
    io.emit('qr', qrDataUrl);
    io.emit('status', { connected: false, message: 'Scan the QR code with WhatsApp' });
    console.log('[WA] QR generated');
  });

  client.on('ready', () => {
    clientReady = true;
    qrDataUrl = null;
    const info = client.info;
    io.emit('ready', { name: info?.pushname || 'Unknown', number: info?.wid?.user || '' });
    io.emit('status', { connected: true, message: `Connected as ${info?.pushname || 'Unknown'}` });
    console.log('[WA] Client ready');
  });

  client.on('authenticated', () => {
    io.emit('status', { connected: false, message: 'Authenticated – loading session…' });
  });

  client.on('auth_failure', () => {
    clientReady = false;
    io.emit('status', { connected: false, message: 'Auth failed. Please re-scan QR.' });
  });

  client.on('disconnected', (reason) => {
    clientReady = false;
    io.emit('status', { connected: false, message: `Disconnected: ${reason}` });
    setTimeout(createClient, 3000);
  });

  client.initialize().catch(console.error);
}

createClient();

// ─── Helper: sleep ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Helper: format phone number ──────────────────────────────────────────────
function formatPhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);           // 0091... → 91...
  else if (p.startsWith('0')) p = '91' + p.slice(1); // 07... → 917...
  // Auto-add India country code if number looks local (10 digits starting with 6-9)
  if (p.length === 10 && /^[6-9]/.test(p)) p = '91' + p;
  if (p.length < 7) throw new Error(`Invalid phone number: ${phone}`);
  return p + '@c.us';
}

// ─── Helper: validate & resolve WhatsApp ID ───────────────────────────────────
async function resolveWhatsAppId(phone) {
  const rawNum = String(phone).replace(/\D/g, '');
  // Try as-is first, then with country code 91
  const candidates = [rawNum];
  if (rawNum.length === 10 && /^[6-9]/.test(rawNum)) candidates.unshift('91' + rawNum);

  for (const num of candidates) {
    try {
      const result = await client.getNumberId(num);
      if (result) {
        console.log(`[RESOLVED] ${phone} → ${result._serialized}`);
        return result._serialized; // e.g. "917448219335@c.us"
      }
    } catch (e) { /* try next */ }
  }
  throw new Error(`Number ${phone} is not registered on WhatsApp`);
}

// ─── Helper: send one message ─────────────────────────────────────────────────
async function sendMessage({ phone, message, filePath, caption }) {
  console.log(`[SEND] → ${phone}`);

  // Resolve the correct WhatsApp chat ID via getNumberId (avoids LID error)
  const chatId = await resolveWhatsAppId(phone);

  if (filePath) {
    const media = MessageMedia.fromFilePath(filePath);
    const opts  = { caption: caption || message || '' };
    await client.sendMessage(chatId, media, opts);
  } else if (message) {
    await client.sendMessage(chatId, message);
  } else {
    throw new Error('No message or file provided');
  }
}

// ─── Socket connection ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Client connected');
  if (qrDataUrl) socket.emit('qr', qrDataUrl);
  if (clientReady) {
    const info = client?.info;
    socket.emit('ready', { name: info?.pushname || 'Unknown', number: info?.wid?.user || '' });
    socket.emit('status', { connected: true, message: `Connected as ${info?.pushname || ''}` });
  } else {
    socket.emit('status', { connected: false, message: 'Waiting for QR scan…' });
  }
  socket.emit('campaign_status', campaignStatus);
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════════════════════

// Status
app.get('/api/status', requireAuth, (req, res) => {
  res.json({ connected: clientReady, qr: qrDataUrl, campaign: campaignStatus });
});

// Get full campaign log (for debugging)
app.get('/api/logs', requireAuth, (req, res) => {
  res.json({ log: campaignStatus.log });
});

// Upload CSV
app.post('/api/upload/csv', requireAuth, uploadCsv.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });
  try {
    const rows = await parseCsv(req.file.path);
    res.json({ success: true, file: req.file.filename, rows, count: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Upload attachment file
app.post('/api/upload/file', requireAuth, uploadFile.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    success: true,
    filename: req.file.filename,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

// Send bulk messages
app.post('/api/send', requireAuth, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  if (campaignStatus.running) return res.status(409).json({ error: 'A campaign is already running' });

  const { contacts, message, attachedFile, caption, delayMs = 2000, csvFile, antiBan } = req.body;

  let recipients = [];

  // From direct contacts array
  if (contacts && contacts.length) {
    recipients = contacts.map(c => ({ phone: c.phone, message: c.message || message }));
  }

  // From CSV file
  if (csvFile) {
    const csvPath = path.join(CSV_DIR, csvFile);
    if (fs.existsSync(csvPath)) {
      const rows = await parseCsv(csvPath);
      rows.forEach(row => recipients.push({ phone: row.phone, message: row.message || message }));
    }
  }

  if (!recipients.length) return res.status(400).json({ error: 'No recipients provided' });

  const filePath = attachedFile ? path.join(FILE_DIR, attachedFile) : null;

  // Start campaign in background
  campaignStatus = { running: true, total: recipients.length, sent: 0, failed: 0, log: [] };
  io.emit('campaign_status', campaignStatus);
  res.json({ success: true, total: recipients.length });

  runCampaign(recipients, message, filePath, caption, parseInt(delayMs), antiBan || {});
});

// Stop campaign
app.post('/api/stop', requireAuth, (req, res) => {
  campaignStatus.running = false;
  io.emit('campaign_status', campaignStatus);
  res.json({ success: true });
});

// Logout WhatsApp
app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    await client.logout();
    clientReady = false;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️  ANTI-BAN ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

// Default anti-ban config (can be overridden per campaign via req.body.antiBan)
const DEFAULT_ANTI_BAN = {
  enabled:          true,
  minDelay:         4000,   // ms — minimum gap between messages
  maxDelay:         12000,  // ms — maximum gap (random in range)
  typingDelay:      true,   // simulate typing before sending
  typingMs:         1500,   // base typing simulation time (ms)
  batchSize:        20,     // send N messages then take a long break
  batchBreakMin:    30000,  // batch break min (ms) — 30 s
  batchBreakMax:    60000,  // batch break max (ms) — 60 s
  maxPerHour:       100,    // hard cap: messages per hour
  shuffleRecipients:false,  // randomise send order
  spintax:          false,  // {Hi|Hello|Hey} message spinning
};

let antiBanConfig = { ...DEFAULT_ANTI_BAN };

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Random integer between min and max (inclusive) */
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/** Random delay within configured range */
function randomDelay() {
  const ms = randInt(antiBanConfig.minDelay, antiBanConfig.maxDelay);
  console.log(`[ANTI-BAN] Waiting ${(ms/1000).toFixed(1)}s before next message…`);
  return sleep(ms);
}

/** Simulate typing indicator */
async function simulateTyping(chatId, messageLen) {
  if (!antiBanConfig.typingDelay) return;
  try {
    const chat = await client.getChatById(chatId);
    // typing time proportional to message length, with jitter
    const ms = Math.min(antiBanConfig.typingMs + messageLen * 25, 6000) + randInt(0, 800);
    await chat.sendStateTyping();
    await sleep(ms);
    await chat.clearState();
  } catch (e) { /* non-fatal */ }
}

/** Spintax processor: "Hello {friend|mate|there}" → picks one option */
function spinText(text) {
  if (!text || !antiBanConfig.spintax) return text;
  return text.replace(/\{([^{}]+)\}/g, (_, opts) => {
    const choices = opts.split('|');
    return choices[randInt(0, choices.length - 1)];
  });
}

/** Shuffle array in-place (Fisher-Yates) */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Campaign runner (with full anti-ban) ─────────────────────────────────────
async function runCampaign(recipients, defaultMsg, filePath, caption, delayMs, antiBan = {}) {
  // Merge caller's antiBan settings over defaults
  antiBanConfig = { ...DEFAULT_ANTI_BAN, ...antiBan };

  // Shuffle recipients if requested
  if (antiBanConfig.shuffleRecipients) shuffle(recipients);

  const hourStart    = Date.now();
  let   sentThisHour = 0;

  for (let i = 0; i < recipients.length; i++) {
    if (!campaignStatus.running) break;

    // ── Hourly rate cap ────────────────────────────────────────────────────────
    if (antiBanConfig.enabled && antiBanConfig.maxPerHour > 0) {
      if (sentThisHour >= antiBanConfig.maxPerHour) {
        const elapsed   = Date.now() - hourStart;
        const waitUntil = 3600000 - elapsed; // remainder of the hour
        if (waitUntil > 0) {
          const waitMin = Math.ceil(waitUntil / 60000);
          console.log(`[ANTI-BAN] Hourly cap reached. Pausing ${waitMin} min…`);
          io.emit('anti_ban_pause', { reason: `Hourly cap (${antiBanConfig.maxPerHour}) reached. Resuming in ${waitMin} min.`, ms: waitUntil });
          campaignStatus.pauseReason = `Rate limit pause — ${waitMin} min`;
          io.emit('campaign_status', campaignStatus);
          await sleep(waitUntil);
          sentThisHour = 0;
          campaignStatus.pauseReason = null;
        }
      }
    }

    // ── Batch break every N messages ───────────────────────────────────────────
    if (antiBanConfig.enabled && i > 0 && i % antiBanConfig.batchSize === 0) {
      const breakMs  = randInt(antiBanConfig.batchBreakMin, antiBanConfig.batchBreakMax);
      const breakSec = Math.ceil(breakMs / 1000);
      console.log(`[ANTI-BAN] Batch break — cooling down ${breakSec}s after ${antiBanConfig.batchSize} messages…`);
      io.emit('anti_ban_pause', { reason: `Batch break after ${antiBanConfig.batchSize} messages (${breakSec}s cool-down)`, ms: breakMs });
      campaignStatus.pauseReason = `Batch break — ${breakSec}s`;
      io.emit('campaign_status', campaignStatus);
      await sleep(breakMs);
      campaignStatus.pauseReason = null;
    }

    const { phone } = recipients[i];
    // Apply spintax to per-recipient message or default
    const rawMsg  = recipients[i].message || defaultMsg || '';
    const message = spinText(rawMsg);

    const logEntry = {
      index: i + 1, phone, status: '',
      time: new Date().toLocaleTimeString(),
      delay: null
    };

    try {
      // Resolve chat ID first (needed for typing simulation)
      const chatId = await resolveWhatsAppId(phone);

      // ── Typing simulation ──────────────────────────────────────────────────
      if (antiBanConfig.enabled) {
        await simulateTyping(chatId, (message || caption || '').length);
      }

      // ── Send ───────────────────────────────────────────────────────────────
      if (filePath) {
        const media = MessageMedia.fromFilePath(filePath);
        await client.sendMessage(chatId, media, { caption: caption || message || '' });
      } else if (message) {
        await client.sendMessage(chatId, message);
      }

      logEntry.status = 'sent';
      campaignStatus.sent++;
      sentThisHour++;
      console.log(`[SENT ✓] ${phone} (${i + 1}/${recipients.length})`);

    } catch (err) {
      logEntry.status = 'failed';
      logEntry.error  = err.message;
      campaignStatus.failed++;
      console.error(`[FAIL ✗] ${phone} → ${err.message}`);
    }

    campaignStatus.log.unshift(logEntry);
    if (campaignStatus.log.length > 500) campaignStatus.log.pop();
    io.emit('campaign_status', campaignStatus);
    io.emit('log_entry', logEntry);

    // ── Random delay between messages ──────────────────────────────────────────
    if (i < recipients.length - 1 && campaignStatus.running) {
      if (antiBanConfig.enabled) {
        await randomDelay();
      } else {
        await sleep(delayMs || 2000);
      }
    }
  }

  antiBanConfig = { ...DEFAULT_ANTI_BAN }; // reset
  campaignStatus.running     = false;
  campaignStatus.pauseReason = null;
  io.emit('campaign_status', campaignStatus);
  io.emit('campaign_done', { sent: campaignStatus.sent, failed: campaignStatus.failed });
}

// ── Get/Set anti-ban settings ──────────────────────────────────────────────────
app.get('/api/antibан', requireAuth, (req, res) => res.json(antiBanConfig));
app.post('/api/antibан', requireAuth, (req, res) => {
  antiBanConfig = { ...DEFAULT_ANTI_BAN, ...req.body };
  res.json({ success: true, config: antiBanConfig });
});

// ─── CSV parser ────────────────────────────────────────────────────────────────
function parseCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, trim: true, skip_empty_lines: true, bom: true }))
      .on('data', row => {
        // Flexible column names
        const phone = row.phone || row.Phone || row.PHONE || row.number || row.Number || row.mobile || row.Mobile;
        const message = row.message || row.Message || row.msg || row.Msg || row.text || row.Text || '';
        if (phone) rows.push({ phone: String(phone).trim(), message: String(message).trim() });
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

// ─── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 BulkWhatsApp running at http://localhost:${PORT}\n`);
});
