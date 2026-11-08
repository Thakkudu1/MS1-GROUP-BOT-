# MS2 WhatsApp Group Bot

Independent MS2 deployment on the `ms2-group-bot` branch. The original `main` branch (MS1) is not changed.

## Runtime and hosting

- Node.js 20 or newer; Baileys 6.7.24.
- Install command: `npm install`
- Start command: `npm start`
- Health endpoint: `/health`; detailed status endpoint: `/status`.
- Mount a persistent volume at `/data`. WhatsApp auth files default to `/data/session`; message counts default to `/data/message-counts.json`.
- In BotNix Cloud, deploy this repository's `ms2-group-bot` branch as a Node.js service, set the start command to `npm start`, attach persistent storage at `/data`, and configure the variables in `.env.example` in the dashboard. The exact volume controls must be confirmed in the account.

## Telegram pairing

Create a dedicated Telegram bot with BotFather. Set `TELEGRAM_BOT_TOKEN` and the owner's numeric `TELEGRAM_OWNER_ID` in the hosting dashboard. In the bot's private Telegram chat, use `/start`, then `/pair`, and follow the prompts. The owner sends their WhatsApp number with country code; the bot returns an 8-character pairing code. On WhatsApp choose Linked devices → Link a device → Link with phone number instead. Never share the Telegram token or pairing code.

## Environment variables

See `.env.example`. Also set `OWNER_NUMBERS` to the owner's WhatsApp number including country code, digits only. Do not commit real secrets.

## Included commands and behavior

`.menu`, `.help`, `.ping`, `.alive`, `.owner`, `.topchat`, `.mystats`, `.tagall`, `.kick`, `.promote`, `.demote`, `.warn`, `.warnings`, `.antilink`, `.antidelete`, `.antispam`, `.securityalerts`, `.welcome`, `.rules`, `.statusreact`, and `.statusseen`.

Also includes Telegram owner-only pairing, welcome/goodbye notices, persistent message counts, text anti-delete recovery for messages observed while online, link/spam moderation, status auto-seen/reactions, and reconnect/session-save handling. Admin actions require the bot to be a WhatsApp group admin and remain subject to WhatsApp restrictions. Some group settings and warning counts currently reset after restart.

## Not implemented or not yet verified

AI-generated Malayalam replies, Malayalam audio greetings, fake-number detection/automatic banning, and restaurant menu/order automation are not implemented in this branch. Deployment, persistent-volume behavior, Telegram credentials, WhatsApp pairing, and continuous uptime must be tested in BotNix Cloud before the service can be considered live.
