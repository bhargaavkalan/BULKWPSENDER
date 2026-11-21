# BulkWhatsApp Messenger 🚀

Full-stack Bulk WhatsApp Messenger Web App with built-in Anti-Ban engine, authentication, and support for all file attachments.

---

## ⚠️ Important Hosting Notice: Vercel vs Render / Railway

> **Can this run directly on Vercel?**
> **No.** Vercel is designed strictly for **Serverless Functions** (stateless, short timeout of 10–60s, read-only filesystem, no persistent background processes).
>
> **Why this app requires a persistent server:**
> 1. `whatsapp-web.js` launches a full persistent headless **Chromium browser process** (Puppeteer) in the background.
> 2. It keeps an active, continuous **WebSocket connection** to WhatsApp's servers.
> 3. It maintains a **LocalAuth session folder** (`.wwebjs_auth/`) so you do not need to scan the QR code on every single request.
> 4. Serverless platforms terminate idle instances immediately, which kills your WhatsApp session and drops the connection.

---

## 🌟 Recommended Free/Low-Cost Cloud Hosts

Deploy this app to any of the following continuous container/server hosts:

### Option 1: Render.com (Recommended - Free Tier)
1. Push this folder to a private **GitHub** repository.
2. Sign up on [Render.com](https://render.com).
3. Click **New +** ➔ **Web Service**.
4. Connect your GitHub repository.
5. Choose **Docker** environment (it automatically detects the included `Dockerfile`).
6. Set Disk Storage (optional but recommended for session persistence):
   - Mount path: `/app/.wwebjs_auth`
7. Click **Create Web Service**!

### Option 2: Railway.app (Easiest)
1. Push project to **GitHub**.
2. Go to [Railway.app](https://railway.app) ➔ **New Project** ➔ **Deploy from GitHub repo**.
3. Railway automatically builds using the provided `Dockerfile`.
4. Add a Volume at `/app/.wwebjs_auth` for persistent login.

### Option 3: VPS (DigitalOcean / Linode / AWS EC2 / Contabo)
```bash
git clone <your-repo>
cd BULKWHAT
npm install
npm install -g pm2
pm2 start server.js --name bulkwa
pm2 startup
pm2 save
```

---

## 🔑 Login Credentials

* **Username:** `Savoire`
* **Password:** `Savoire@2026@123456789`

---

## 🛡️ Anti-Ban Engine Features

* **Random Jitter Delay**: Configurable random intervals (e.g. 4s – 12s) between messages.
* **Typing Indicator Simulation**: Sends human-like "typing..." status before dispatch.
* **Batch Cooldowns**: Automatically pauses after batches (e.g. 30–60s pause every 20 messages).
* **Hourly Cap**: Prevents exceeding WhatsApp rate thresholds.
* **Spintax Support**: Allows dynamic text variations per contact like `{Hello|Hi|Hey} {friend|customer}`.
* **Phone Auto-Sanitization**: Automatically detects and formats 10-digit numbers into valid international WhatsApp IDs (e.g., `91xxxxxxxxxx@c.us`).

---

## 🚀 Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```
Open **http://localhost:3000** in your browser.
