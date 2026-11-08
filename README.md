# MS2 GROUP BOT

Independent MS2-branded deployment branch based on the existing MS1 project. The original `main` branch is not changed.

## Runtime
- Node.js 20 or newer
- Start command: `npm start`
- Health endpoint: `/health`
- Status endpoint: `/status`
- WhatsApp library: Baileys 6.7.24
- Telegram control: `node-telegram-bot-api`

## Telegram pairing setup
1. In Telegram, open **@BotFather** and create a new bot for MS2.
2. Copy the new bot token. Do not post it publicly or commit it to GitHub.
3. Set `TELEGRAM_BOT_TOKEN` in the hosting provider's environment settings.
4. Set `TELEGRAM_OWNER_ID` to the owner's numeric Telegram ID. Start the new bot and send `/id`; use the returned numeric ID.
5. Set `OWNER_NUMBERS` to the WhatsApp owner number with country code (digits only; multiple numbers separated by commas).
6. Set `PREFIX=.` (or your preferred command prefix).
7. In a private chat with the new Telegram bot, send `/start`, then `/pair`, then the WhatsApp number including country code. Enter the returned code in WhatsApp: **Linked devices → Link a device → Link with phone number instead**.

The pairing code is a secret. Never share it. Keep a persistent disk mounted at `/data` so `/data/session` survives restarts.

## Hosting environment variables
Required for Telegram pairing:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID`

Recommended:
- `OWNER_NUMBERS`
- `PREFIX=.`
- `WARN_LIMIT=3`
- `SESSION_DIR=/data/session`
- `STATS_FILE=/data/message-counts.json`
- `PORT` (provided by the host; defaults to 3000)

Do not add real tokens, phone numbers, or session files to this repository.

## Commands currently present in the inherited code
- `.menu`, `.help`, `.ping`, `.alive`, `.owner`
- `.topchat`, `.mystats`
- `.tagall`, `.kick`, `.promote`, `.demote`
- `.warn`, `.warnings`
- `.antilink on|off`, `.antidelete on|off`, `.antispam on|off`
- `.securityalerts on|off`, `.welcome on|off`, `.rules [text]`
- Owner-only status controls: `.statusreact on|off`, `.statusseen on|off`

Group moderation actions require the bot to be a group admin. Telegram control is restricted to the configured owner ID.

## Important scope note
This branch carries forward the features actually present in the source project. Features not implemented in that source (for example, an AI chat provider integration, restaurant ordering automation, or custom Malayalam audio greeting) still need separate implementation and credentials; they are not claimed as completed here.
