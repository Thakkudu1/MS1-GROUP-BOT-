# MS1 GROUP BOT — മലയാളം

**Login:** WhatsApp Pairing Code മാത്രം. QR code generation, display, Telegram QR command എന്നിവ ഒഴിവാക്കിയിരിക്കുന്നു.

## WhatsApp ഗ്രൂപ്പ് കമാൻഡുകൾ

- `.ping`, `.alive`, `.help`
- `.topchat`, `.mystats`
- `.tagall [message]` — ഗ്രൂപ്പ് അഡ്മിൻ / ബോട്ട് ഉടമ
- `.kick @user`, `.promote @user`, `.demote @user` — ഗ്രൂപ്പ് അഡ്മിൻ / ബോട്ട് ഉടമ
- `.warn @user`, `.warnings`
- `.antilink on|off`
- `.antidelete on|off` — ബോട്ട് പ്രവർത്തിക്കുന്ന സമയത്ത് cache ചെയ്ത ടെക്സ്റ്റ് മാത്രം തിരിച്ചറിയാം
- `.antispam on|off`
- `.securityalerts on|off`
- `.welcome on|off`
- `.rules [text]`
- `.statusseen on|off`, `.statusreact on|off` — ബോട്ട് ഉടമയ്ക്ക് മാത്രം

ഗ്രൂപ്പ് സെറ്റിംഗുകളും warnings-ഉം നിലവിലെ കോഡിൽ process memory-ലാണ്; restart ചെയ്താൽ reset ആകാം. Message count JSON ഫയലിൽ സൂക്ഷിക്കുന്നു. എല്ലാ ഫീച്ചറുകളും WhatsApp/ Baileys permissions-നും group admin privileges-നും വിധേയമാണ്.

## Telegram വഴി Pairing Code മാത്രം

1. Telegram-ൽ നിങ്ങളുടെ bot-ന്റെ private chat തുറക്കുക.
2. `/start` അയയ്ക്കുക.
3. `/pair` അയയ്ക്കുക.
4. WhatsApp നമ്പർ country code സഹിതം digits മാത്രം അയയ്ക്കുക (ഉദാ. `919876543210`).
5. Telegram-ൽ ലഭിക്കുന്ന 8-character pairing code ഉടൻ ഉപയോഗിക്കുക.
6. WhatsApp → **Linked devices** → **Link a device** → **Link with phone number instead** → code നൽകുക.

**QR login ലഭ്യമല്ല.** QR code സൃഷ്ടിക്കുകയോ അയയ്ക്കുകയോ ചെയ്യുന്ന command ഇല്ല. Pairing code, Telegram token, session files എന്നിവ രഹസ്യമായി സൂക്ഷിക്കുക; ആരുമായും പങ്കിടരുത്.

## ആവശ്യമായ Environment Variables

- `TELEGRAM_BOT_TOKEN` — BotFather token
- `TELEGRAM_OWNER_ID` — നിങ്ങളുടെ Telegram numeric ID
- `OWNER_NUMBERS` — ഉടമയുടെ WhatsApp നമ്പർ country code സഹിതം, digits മാത്രം
- `PREFIX` — default `.`
- `WARN_LIMIT` — default `3`
- `LOG_LEVEL` — default `silent`

Telegram ID അറിയാൻ ആദ്യം `/id` അയയ്ക്കുക. ലഭിച്ച ID hosting secrets-ൽ `TELEGRAM_OWNER_ID` ആയി ചേർക്കുക.

## Hosting

- Node.js 20+
- Start command: `npm start`
- Persistent storage നിർബന്ധം: `/data/session` (WhatsApp login keys), `/data/message-counts.json` (message stats)
- Health endpoint: `/health`
- Status endpoint: `/status`

Host-ൽ persistent disk mount ചെയ്തില്ലെങ്കിൽ restart/deploy സമയത്ത് WhatsApp session നഷ്ടപ്പെടാം. Free host sleep ചെയ്യാം; 24/7 uptime ഉറപ്പില്ല.

## സുരക്ഷാ കുറിപ്പുകൾ

Baileys ഔദ്യോഗിക WhatsApp Business API അല്ല; WhatsApp Web automation ആണ്. WhatsApp account restrictions ഉണ്ടാകാനുള്ള സാധ്യതയുണ്ട്; anti-ban guarantee ഇല്ല. Bot-നെ group admin ആക്കിയാൽ മാത്രമേ delete/remove/promote/demote പോലുള്ള പ്രവർത്തനങ്ങൾ സാധിക്കൂ. Fake-number detection വിശ്വസനീയമായി ഉറപ്പാക്കാൻ കഴിയില്ല; സംശയകരമായ അക്കൗണ്ടുകൾ admin review ചെയ്യണം.

Private-chat Grill Arabia auto-reply/menu/gallery feature ഈ പതിപ്പിൽ ഉദ്ദേശ്യപൂർവ്വം ഒഴിവാക്കിയിരിക്കുന്നു.
