const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const fs = require('fs');
const TELEGRAM_STATS_FILE = process.env.TELEGRAM_STATS_FILE || (process.env.PORT ? '/data/telegram-message-counts.json' : './telegram-message-counts.json');
let TELEGRAM_MESSAGE_COUNTS = {};
try { if (fs.existsSync(TELEGRAM_STATS_FILE)) TELEGRAM_MESSAGE_COUNTS = JSON.parse(fs.readFileSync(TELEGRAM_STATS_FILE, 'utf8')); }
catch (e) { console.error('Could not load Telegram message counts:', e.message); }
function recordTelegramMessage(chatId, user, msg) {
  if (!TELEGRAM_MESSAGE_COUNTS[chatId]) TELEGRAM_MESSAGE_COUNTS[chatId] = {};
  const id = String(user.id);
  if (!TELEGRAM_MESSAGE_COUNTS[chatId][id]) TELEGRAM_MESSAGE_COUNTS[chatId][id] = { count: 0, name: '' };
  TELEGRAM_MESSAGE_COUNTS[chatId][id].count += 1;
  TELEGRAM_MESSAGE_COUNTS[chatId][id].name = [user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ? '@' + user.username : id);
  try { fs.writeFileSync(TELEGRAM_STATS_FILE, JSON.stringify(TELEGRAM_MESSAGE_COUNTS, null, 2)); }
  catch (e) { console.error('Could not save Telegram message counts:', e.message); }
}

function startTelegram(getSocket, isPairingReady, waitForPairingReady, getCurrentQr, waitForQr) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const ownerId = String(process.env.TELEGRAM_OWNER_ID || '').trim();
  if (!token) {
    console.log('Telegram pairing disabled: set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID.');
    return;
  }
  const bot = new TelegramBot(token, { polling: true });
  let busy = false;
  const authorized = (msg) => ownerId && String(msg.from && msg.from.id || '') === ownerId;
  bot.onText(/^\/start$/, async (msg) => {
    if (!authorized(msg)) {
      await bot.sendMessage(msg.chat.id, 'MS1 GROUP BOT\nYour Telegram ID: ' + String(msg.from && msg.from.id || '') + '\nAsk the owner to set TELEGRAM_OWNER_ID to this ID.');
      return;
    }
    await bot.sendMessage(msg.chat.id, '👑 MS1 GROUP BOT\n\nSend /qr to receive a WhatsApp QR image, or /pair to use a pairing code.');
  });
  bot.onText(/^\/id$/, async (msg) => bot.sendMessage(msg.chat.id, 'Telegram ID: ' + String(msg.from && msg.from.id || '')));
  bot.onText(/^\/qr$/, async (msg) => {
    if (!authorized(msg)) return bot.sendMessage(msg.chat.id, 'Not authorized.');
    try {
      let qr = getCurrentQr();
      if (!qr) qr = await waitForQr(20000);
      if (!qr) {
        await bot.sendMessage(msg.chat.id, 'WhatsApp QR is not ready yet. Wait for the bot to reconnect, then send /qr again.');
        return;
      }
      const image = await QRCode.toBuffer(qr, { type: 'png', width: 700, margin: 2 });
      await bot.sendPhoto(msg.chat.id, image, {
        caption: 'MS1 GROUP BOT — WhatsApp QR\nOpen WhatsApp on the phone you want to link → Linked devices → Link a device, then scan this QR from another screen. Do not share this QR.'
      });
    } catch (e) {
      console.error('QR send error:', e.message);
      await bot.sendMessage(msg.chat.id, 'Could not send the QR image. Please try /qr again in a few seconds.');
    }
  });

  bot.onText(/^\/pair$/, async (msg) => {
    if (!authorized(msg)) return bot.sendMessage(msg.chat.id, 'Not authorized. Use /id and ask the owner to configure TELEGRAM_OWNER_ID.');
    await bot.sendMessage(msg.chat.id, 'Send your WhatsApp phone number with country code (digits only, e.g. 919876543210).');
  });
  bot.on('message', async (msg) => {
    const isGroup = ['group', 'supergroup'].includes(msg.chat && msg.chat.type);
    if (isGroup && msg.from && !msg.from.is_bot) {
      recordTelegramMessage(msg.chat.id, msg.from, msg);
      const command = String(msg.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
      if (command === '/topchat') {
        const all = Object.entries(TELEGRAM_MESSAGE_COUNTS[String(msg.chat.id)] || {}).map(([id, s]) => ({ id, name: s.name || id, count: Number(s.count) || 0 })).sort((a, b) => b.count - a.count).slice(0, 10);
        const lines = all.map((item, i) => (['🥇', '🥈', '🥉'][i] || (String(i + 1) + '.')) + ' ' + item.name + ' — ' + item.count + ' messages');
        await bot.sendMessage(msg.chat.id, lines.length ? '🏆 TOP 10 CHATTERS 🏆\n\n' + lines.join('\n') + '\n\nCounts start from when this bot began tracking messages.' : 'No messages have been counted yet.');
      } else if (command === '/mystats') {
        const mine = TELEGRAM_MESSAGE_COUNTS[String(msg.chat.id)] && TELEGRAM_MESSAGE_COUNTS[String(msg.chat.id)][String(msg.from.id)];
        await bot.sendMessage(msg.chat.id, '📊 Your message count: ' + (Number(mine && mine.count) || 0));
      }
      return;
    }
    if (!msg.text || msg.text.startsWith('/') || !authorized(msg)) return;
    const number = msg.text.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(number)) return;
    if (busy) return bot.sendMessage(msg.chat.id, 'Pairing is already in progress. Please wait.');
    let sock = getSocket();
    if (!sock) return bot.sendMessage(msg.chat.id, 'WhatsApp is starting. Wait a few seconds and send /pair again.');
    if (sock.authState?.creds?.registered) {
      return bot.sendMessage(msg.chat.id, 'WhatsApp already has a saved linked session. Wait for it to reconnect; do not request another pairing code yet.');
    }
    busy = true;
    try {
      // Baileys requires the socket to reach its QR/pairing-ready event first.
      const ready = isPairingReady() || await waitForPairingReady(20000);
      sock = getSocket();
      if (!ready || !sock || sock.authState?.creds?.registered) {
        await bot.sendMessage(msg.chat.id, 'WhatsApp is not ready for a pairing code yet. Wait for the bot to reconnect, then send /pair again.');
        return;
      }
      const rawCode = String(await sock.requestPairingCode(number));
      // Normalize first because Baileys versions may return a code already containing a hyphen.
      const cleanCode = rawCode.replace(/[^A-Za-z0-9]/g, '');
      const pretty = cleanCode.length === 8 ? cleanCode.slice(0, 4) + '-' + cleanCode.slice(4) : rawCode;
      await bot.sendMessage(msg.chat.id, '🔐 MS1 GROUP BOT Pairing Code\n\n' + pretty + '\n\nWhatsApp → Linked devices → Link a device → Link with phone number instead. Enter this code promptly. Do not share it with anyone.');
    } catch (e) {
      console.error('Pairing code error:', e.message);
      await bot.sendMessage(msg.chat.id, 'Could not get a pairing code. Confirm the WhatsApp number including country code, then wait for WhatsApp to finish reconnecting before trying again.');
    } finally { busy = false; }
  });
  bot.on('polling_error', (e) => console.error('Telegram polling error:', e.message));
  console.log('Telegram control bot started.');
}

module.exports = { startTelegram };
