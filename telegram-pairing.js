const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

function startTelegram(getSocket, isPairingReady, waitForPairingReady, getCurrentQr, waitForQr) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const ownerId = String(process.env.TELEGRAM_OWNER_ID || '').trim();
  if (!token) {
    console.log('Telegram pairing disabled: set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID.');
    return;
  }
  const bot = new TelegramBot(token);
  let busy = false;
  const authorized = (msg) => ownerId && String(msg.from && msg.from.id || '') === ownerId;

  bot.on('message', async (msg) => {
    const text = String(msg.text || '').trim();
    const match = text.match(/^\/(start|id|qr|pair)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i);
    if (match) {
      const command = match[1].toLowerCase();
      console.log('Telegram command received:', '/' + command, 'from user', String(msg.from && msg.from.id || 'unknown'));
      try {
        if (command === 'start') {
          const reply = authorized(msg)
            ? '👑 MS1 GROUP BOT\n\nSend /qr to receive a WhatsApp QR image, or /pair to use a pairing code.'
            : 'MS1 GROUP BOT\nYour Telegram ID: ' + String(msg.from && msg.from.id || '') + '\nAsk the owner to set TELEGRAM_OWNER_ID to this ID.';
          await bot.sendMessage(msg.chat.id, reply);
          console.log('Telegram /start reply sent.');
          return;
        }
        if (command === 'id') {
          await bot.sendMessage(msg.chat.id, 'Telegram ID: ' + String(msg.from && msg.from.id || ''));
          return;
        }
        if (!authorized(msg)) {
          await bot.sendMessage(msg.chat.id, 'Not authorized. Your Telegram ID is ' + String(msg.from && msg.from.id || '') + '. Ask the owner to configure TELEGRAM_OWNER_ID.');
          return;
        }
        if (command === 'qr') {
          let qr = getCurrentQr();
          if (!qr) qr = await waitForQr(30000);
          if (!qr) {
            await bot.sendMessage(msg.chat.id, 'WhatsApp QR is not ready yet. Wait for the bot to reconnect, then send /qr again.');
            return;
          }
          const image = await QRCode.toBuffer(qr, { type: 'png', width: 700, margin: 2 });
          await bot.sendPhoto(msg.chat.id, image, {
            caption: 'MS1 GROUP BOT — FRESH WhatsApp QR\nScan immediately (within 10 seconds): WhatsApp → Linked devices → Link a device. Keep both phones online and WhatsApp updated. Do not share this QR.'
          });
          console.log('Fresh WhatsApp QR image sent to Telegram user', String(msg.from && msg.from.id || 'unknown'));
          return;
        }
        if (command === 'pair') {
          await bot.sendMessage(msg.chat.id, 'Send your WhatsApp phone number with country code (digits only, e.g. 919876543210).');
          return;
        }
      } catch (e) {
        console.error('Telegram command reply failed for /' + command + ':', e.message);
        try { await bot.sendMessage(msg.chat.id, 'MS1 bot error: ' + e.message); } catch (sendError) {
          console.error('Telegram error notice could not be sent:', sendError.message);
        }
      }
      return;
    }

    if (!text || text.startsWith('/') || !authorized(msg)) return;
    const number = text.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(number)) return;
    if (busy) {
      await bot.sendMessage(msg.chat.id, 'Pairing is already in progress. Please wait.');
      return;
    }
    let sock = getSocket();
    if (!sock) {
      await bot.sendMessage(msg.chat.id, 'WhatsApp is starting. Wait a few seconds and send /pair again.');
      return;
    }
    if (sock.authState?.creds?.registered) {
      await bot.sendMessage(msg.chat.id, 'WhatsApp already has a saved linked session. Wait for it to reconnect; do not request another pairing code yet.');
      return;
    }
    busy = true;
    try {
      const ready = isPairingReady() || await waitForPairingReady(20000);
      sock = getSocket();
      if (!ready || !sock || sock.authState?.creds?.registered) {
        await bot.sendMessage(msg.chat.id, 'WhatsApp is not ready for a pairing code yet. Wait for the bot to reconnect, then send /pair again.');
        return;
      }
      const rawCode = String(await sock.requestPairingCode(number));
      const cleanCode = rawCode.replace(/[^A-Za-z0-9]/g, '');
      const pretty = cleanCode.length === 8 ? cleanCode.slice(0, 4) + '-' + cleanCode.slice(4) : rawCode;
      await bot.sendMessage(msg.chat.id, '🔐 MS1 GROUP BOT Pairing Code\n\n' + pretty + '\n\nWhatsApp → Linked devices → Link a device → Link with phone number instead. Enter this code promptly. Do not share it with anyone.');
    } catch (e) {
      console.error('Pairing code error:', e.message);
      await bot.sendMessage(msg.chat.id, 'Could not get a pairing code. Confirm the WhatsApp number including country code, then wait for WhatsApp to finish reconnecting before trying again.');
    } finally {
      busy = false;
    }
  });

  bot.on('polling_error', (e) => console.error('Telegram polling error:', e.message));
  bot.on('error', (e) => console.error('Telegram bot error:', e.message));
  bot.getMe().then((me) => console.log('Telegram bot identity verified:', '@' + (me.username || 'unknown')))
    .catch((e) => console.error('Telegram getMe failed:', e.message));
  bot.startPolling().then(() => console.log('Telegram polling started successfully.'))
    .catch((e) => console.error('Telegram polling could not start:', e.message));
}

module.exports = { startTelegram };
