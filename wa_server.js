const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let status = 'disconnected';
let latestQR = null;
let isStarting = false;
let reconnectTimer = null;

// Chat ve Contact verilerini hafızada tutmak için store oluştur
const store = makeInMemoryStore({ logger: require('pino')({ level: 'silent' }) });
store.readFromFile('./admin/auth_info/baileys_store.json');
setInterval(() => {
  store.writeToFile('./admin/auth_info/baileys_store.json');
}, 10_000);

const AUTH_DIR = path.join(__dirname, 'admin', 'auth_info');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

async function startSocket() {
  if (isStarting) return;
  isStarting = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      browser: ['DreamStudio', 'Chrome', '120.0.0'],
      logger: require('pino')({ level: 'silent' }),
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    // Store'u socket'e bağla
    store.bind(sock.ev);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          latestQR = await QRCode.toString(qr, { type: 'svg', width: 256 });
          status = 'qr';
          console.log('QR ready');
        } catch(e) { console.error('QR error:', e.message); }
      }

      if (connection === 'open') {
        status = 'connected';
        latestQR = null;
        isStarting = false;
        console.log('WhatsApp connected!');
      }

      if (connection === 'close') {
        isStarting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.error;
        console.log(`WA closed. Code: ${code}, Reason: ${reason}`);

        if (code === DisconnectReason.loggedOut) {
          status = 'loggedout';
          sock = null;
          latestQR = null;
          console.log('Logged out — clear auth_info to reconnect');
        } else {
          status = 'disconnected';
          latestQR = null;
          sock = null;
          console.log('Reconnecting in 5s...');
          reconnectTimer = setTimeout(startSocket, 5000);
        }
      }
    });

  } catch(e) {
    isStarting = false;
    status = 'disconnected';
    console.error('WA start error:', e.message);
    reconnectTimer = setTimeout(startSocket, 10000);
  }
}

app.post('/start', async (req, res) => {
  try {
    if (status === 'connected') return res.json({ status: 'connected', qr: null });

    if (status === 'loggedout') {
      // Auth dosyalarını temizle
      if (fs.existsSync(AUTH_DIR)) {
        fs.readdirSync(AUTH_DIR).forEach(f => fs.unlinkSync(path.join(AUTH_DIR, f)));
      }
      status = 'disconnected';
      latestQR = null;
    }

    if (!isStarting) startSocket();

    // QR oluşana kadar bekle (max 30s)
    let tries = 0;
    while (status !== 'qr' && status !== 'connected' && tries < 60) {
      await new Promise(r => setTimeout(r, 500));
      tries++;
    }

    res.json({ status, qr: latestQR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ status, qr: status === 'qr' ? latestQR : null });
});

app.post('/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!sock || status !== 'connected') {
    console.error('WA send failed: not connected, status:', status);
    return res.status(400).json({ ok: false, error: 'Not connected' });
  }
  try {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    console.log('WA sent to:', phone);
    res.json({ ok: true });
  } catch (e) {
    console.error('WA send error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    status = 'disconnected';
    latestQR = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    res.json({ ok: true });
  } catch(e) {
    sock = null;
    status = 'disconnected';
    res.json({ ok: true });
  }
});

app.get('/chats', async (req, res) => {
  if (!sock || status !== 'connected') {
    return res.status(400).json({ ok: false, error: 'WhatsApp bağlı değil' });
  }
  try {
    // Tüm sohbetleri al ve son mesaja göre sırala
    const chats = store.chats.all().sort((a, b) => {
      const tsA = a.conversationTimestamp || 0;
      const tsB = b.conversationTimestamp || 0;
      return tsB - tsA; // Azalan sıra (en yeni en üstte)
    });

    // En son 100 sohbeti filtrele (grupları ve özel jid'leri yoksay, sadece normal numaralar)
    const recent100 = chats
      .filter(c => c.id && c.id.endsWith('@s.whatsapp.net'))
      .slice(0, 100)
      .map(c => {
        let phone = c.id.split('@')[0];
        let name = c.name || phone; // İsmi yoksa numarasını isim yap
        return { name: name, phone: phone, last_car: 'WhatsApp Kişisi' };
      });

    res.json({ ok: true, data: recent100 });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(3001, '0.0.0.0', () => {
  console.log('WA Server running on port 3001');
  startSocket().catch(e => console.error('WA Auto-start error:', e.message));
});