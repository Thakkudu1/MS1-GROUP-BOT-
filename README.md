# MS2 WhatsApp Group Bot

Independent MS2 deployment on the `ms2-group-bot` branch. The original `main` branch (MS1) is not changed.

## Runtime and hosting

- Use Node.js 22 in BotNix's Docker Image selector (Node.js 20+ is required by the package).
- The Pterodactyl Node.js egg clones the repository and runs `npm install` during its install step.
- Main file: `index.js`; start command: `npm start`.
- The server listens on `PORT`, then `SERVER_PORT`, then port 3000 as a fallback.
- Health endpoints: `/` and `/health`; diagnostic endpoint: `/status`.
- WhatsApp session defaults to `./session` (server files persist across normal restarts). If a persistent volume is available, set `SESSION_DIR` and `STATS_FILE` in the private `.env` file to locations on that volume.

## BotNix setup

1. In Startup, set Git Repo Address to `https://github.com/Thakkudu1/MS1-GROUP-BOT-` and Install Branch to `ms2-group-bot`.
2. Keep User Uploaded Files OFF; keep Git Username, Git Access Token, Additional Node Packages, Uninstall Node Packages, and Additional Arguments blank for this public repository.
3. Set Main File to `index.js` and choose Docker Image `Nodejs 22`.
4. The visible Startup variables are for the generic Node.js egg; they do not include the bot's Telegram credentials. Do not put secrets in GitHub or the public `.env.example`.
5. After the server files have been installed, create a private file named `.env` in the server File Manager. Copy the variable names from `.env.example` and fill in the real values there. Do not upload or commit a real `.env` file. If the File Manager hides dotfiles, use the panel's New File action with the exact filename `.env`.
6. Start the server and inspect Console logs. Deployment is not confirmed until installation succeeds and the process remains online.

## Private environment variables

- `TELEGRAM_BOT_TOKEN`: token from BotFather for a dedicated Telegram bot.
- `TELEGRAM_OWNER_ID`: the owner's numeric Telegram user ID.
- `OWNER_NUMBERS`: WhatsApp owner number(s), country code included, digits only; separate multiple numbers with commas.
- `PREFIX`: command prefix, default `.`.
- `WARN_LIMIT`: warning threshold, default `3`.
- `STATUS_AUTO_REACT` and `STATUS_AUTO_SEEN`: `true` or `false`.
- `SESSION_DIR` and `STATS_FILE`: optional paths for session and message-count storage.

## Sarvam cloned-voice replies

This branch includes an optional Sarvam Instant Voice Cloning integration in `voice.js`. The existing text reply is sent first; when voice is configured, the bot also sends a WhatsApp voice note for replies routed through `sendVoiceReply` (including `.ping`, `.say <text>`, and owner-mention replies). Voice API failures are logged and do not cancel the text reply.

Set these values in the hosting panel's private environment variables or private `.env` file:

- `SARVAM_API_KEY`: Sarvam API key. Never commit or share it.
- `SARVAM_VOICE_ID`: saved clone ID from Sarvam Content Studio → My voices.
- `VOICE_LANGUAGE=ml-IN`: Malayalam output.
- `VOICE_REPLIES=true`: enable voice notes (set to `false` to disable).

The clone must be created by someone who has the speaker's permission. Sarvam's one-shot API is `POST https://api.sarvam.ai/voices/clone`; the implementation sends the saved `voice_id` and decodes the returned base64 audio. The `/status` health endpoint reports only whether these settings are configured; it never exposes their values.

## Telegram pairing

Create a dedicated Telegram bot with BotFather. Add its token and the owner's numeric Telegram ID to the private `.env` file. In the bot's private Telegram chat, use `/start`, then `/pair`, and follow the prompts. Send the WhatsApp number with country code; the bot returns a pairing code. On WhatsApp, choose Linked devices → Link a device → Link with phone number. This branch disables QR login. Never share the Telegram token or pairing code.

## Included commands and behavior

`.menu`, `.help`, `.ping`, `.alive`, `.owner`, `.topchat`, `.mystats`, `.tagall`, `.kick`, `.promote`, `.demote`, `.warn`, `.warnings`, `.antilink`, `.antidelete`, `.antispam`, `.securityalerts`, `.welcome`, `.rules`, `.statusreact`, and `.statusseen`.

Also includes Telegram owner-only pairing, welcome/goodbye notices, message counts, text anti-delete recovery for messages observed while online, link/spam moderation, status auto-seen/reactions, and reconnect/session-save handling. Admin actions require the bot to be a WhatsApp group admin and remain subject to WhatsApp restrictions. Some group settings and warning counts currently reset after restart.

## Not implemented or not yet verified

AI-generated Malayalam replies, Malayalam audio greetings, fake-number detection/automatic banning, and restaurant menu/order automation are not implemented in this branch. Deployment, persistent-volume behavior, Telegram credentials, WhatsApp pairing, and continuous uptime must be tested in BotNix Cloud before the service can be considered live.
