const TelegramBot = require('node-telegram-bot-api');

function startTelegram(getSocket, isPairingReady, waitForPairingReady) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const ownerId = String(process.env.TELEGRAM_OWNER_ID || '').trim();
  if (!token || !ownerId) {
    console.log('Telegram pairing disabled: configure TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID.');
    return;
  }

  const bot = new TelegramBot(token, { polling: false });
  let busy = false;
  let awaitingNumberFor = null;
  const authorized = (msg) => String(msg.from?.id || '') === ownerId;

  bot.on('message', async (msg) => {
    if (msg.chat?.type !== 'private') return;
    const text = String(msg.text || '').trim();
    const command = text.match(/^\/(start|id|pair)(?:@([A-Za-z0-9_]+))?$/i)?.[1]?.toLowerCase();

    try {
      if (command === 'id') {
        await bot.sendMessage(msg.chat.id, 'Telegram ID: ' + String(msg.from?.id || ''));
        return;
      }
      if (command === 'start') {
        await bot.sendMessage(msg.chat.id, authorized(msg)
          ? '👑 MS2 GROUP BOT\n\nQR login is disabled. Send /pair to link WhatsApp using a phone-number pairing code only.'
          : 'MS2 GROUP BOT\nYour Telegram ID: ' + String(msg.from?.id || '') + '\nAsk the owner to configure this ID privately.');
        return;
      }
      if (command === 'pair') {
        if (!authorized(msg)) {
          await bot.sendMessage(msg.chat.id, 'Not authorized. Your Telegram ID: ' + String(msg.from?.id || ''));
          return;
        }
        awaitingNumberFor = String(msg.from.id);
        await bot.sendMessage(msg.chat.id, 'Send your WhatsApp number with country code, digits only (example: 919876543210). This private chat is used only to request the pairing code.');
        return;
      }
      if (!authorized(msg) || !awaitingNumberFor || awaitingNumberFor !== String(msg.from?.id)) return;

      const number = text.replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(number)) {
        await bot.sendMessage(msg.chat.id, 'Number format is invalid. Send 10–15 digits including country code, or send /pair to start again.');
        return;
      }
      if (busy) {
        await bot.sendMessage(msg.chat.id, 'Pairing request is already running. Please wait.');
        return;
      }

      let sock = getSocket();
      if (!sock) {
        await bot.sendMessage(msg.chat.id, 'WhatsApp is starting. Wait a few seconds, then send /pair again.');
        return;
      }
      if (sock.authState?.creds?.registered) {
        awaitingNumberFor = null;
        await bot.sendMessage(msg.chat.id, 'A WhatsApp session is already linked. The bot will reconnect using the saved session. Do not request a new code unless the session is intentionally reset.');
        return;
      }

      busy = true;
      awaitingNumberFor = null;
      try {
        const ready = isPairingReady() || await waitForPairingReady(25000);
        sock = getSocket();
        if (!ready || !sock || sock.authState?.creds?.registered) {
          await bot.sendMessage(msg.chat.id, 'WhatsApp is not ready to issue a pairing code yet. Wait for the service to reconnect, then send /pair again.');
          return;
        }
        const rawCode = String(await sock.requestPairingCode(number));
        const cleanCode = rawCode.replace(/[^A-Za-z0-9]/g, '');
        const formatted = cleanCode.length === 8 ? cleanCode.slice(0, 4) + '-' + cleanCode.slice(4) : rawCode;
        await bot.sendMessage(msg.chat.id,
          '🔐 MS2 GROUP BOT — Pairing Code\n\n' + formatted +
          '\n\nWhatsApp → Linked devices → Link a device → Link with phone number instead. Enter this code promptly. Never forward or share it.');
      } catch (error) {
        console.error('[PAIRING] Pairing-code request failed:', error?.message || error);
        await bot.sendMessage(msg.chat.id, 'Could not generate the pairing code. Check the WhatsApp number and try again after the bot is fully started.');
      } finally {
        busy = false;
      }
      return;
    } catch (error) {
      console.error('[TELEGRAM] Message handling failed:', error?.message || error);
      try { await bot.sendMessage(msg.chat.id, 'MS2 bot could not complete that request. Please try again.'); } catch {}
    }
  });

  bot.on('polling_error', error => console.error('[TELEGRAM] Polling error:', error?.message || error));
  bot.on('error', error => console.error('[TELEGRAM] Bot error:', error?.message || error));
  bot.getMe()
    .then(me => console.log('[TELEGRAM] Owner pairing bot verified:', '@' + (me.username || 'unknown')))
    .catch(error => console.error('[TELEGRAM] Bot identity check failed:', error?.message || error));
  bot.startPolling()
    .then(() => console.log('[TELEGRAM] Pairing-code control bot started. QR commands are disabled.'))
    .catch(error => console.error('[TELEGRAM] Polling could not start:', error?.message || error));
}

module.exports = { startTelegram };
