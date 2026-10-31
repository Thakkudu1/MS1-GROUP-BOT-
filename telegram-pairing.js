const TelegramBot = require('node-telegram-bot-api');

function startTelegram(getSocket) {
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
    await bot.sendMessage(msg.chat.id, '👑 MS1 GROUP BOT\n\nTap /pair to link WhatsApp using a pairing code.');
  });
  bot.onText(/^\/id$/, async (msg) => bot.sendMessage(msg.chat.id, 'Telegram ID: ' + String(msg.from && msg.from.id || '')));
  bot.onText(/^\/pair$/, async (msg) => {
    if (!authorized(msg)) return bot.sendMessage(msg.chat.id, 'Not authorized. Use /id and ask the owner to configure TELEGRAM_OWNER_ID.');
    await bot.sendMessage(msg.chat.id, 'Send your WhatsApp phone number with country code (digits only, e.g. 919876543210).');
  });
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/') || !authorized(msg)) return;
    const number = msg.text.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(number)) return;
    if (busy) return bot.sendMessage(msg.chat.id, 'Pairing is already in progress. Please wait.');
    const sock = getSocket();
    if (!sock) return bot.sendMessage(msg.chat.id, 'WhatsApp is starting. Wait a few seconds and send /pair again.');
    busy = true;
    try {
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
