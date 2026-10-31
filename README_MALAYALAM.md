# MS1 GROUP BOT — മലയാളം

ഈ repository-ൽ Telegram വഴി നിയന്ത്രിച്ച് WhatsApp pairing code നൽകുന്ന Node.js bot starter ഉണ്ട്.

## കമാൻഡുകൾ
- Telegram: `/start`, `/id`, `/pair`
- WhatsApp: `.menu`, `.ping`, `.alive`, `.owner`, `.tagall`, `.warn @member`, `.warnings`

## പ്രധാന സുരക്ഷാ മുന്നറിയിപ്പ്
Baileys ഒരു അനൗദ്യോഗിക WhatsApp Web ലൈബ്രറിയാണ്. WhatsApp നിയന്ത്രണങ്ങൾ/അക്കൗണ്ട് നിയന്ത്രണം ഉണ്ടാകാം. കഴിയുമെങ്കിൽ പ്രത്യേകം നമ്പർ ഉപയോഗിക്കുക. Telegram bot token, WhatsApp session files എന്നിവ രഹസ്യമാണ്; ഇവ GitHub-ൽ ഇടരുത്, മറ്റൊരാൾക്കും അയക്കരുത്.

## 1. Telegram bot സൃഷ്ടിക്കുക
1. Telegram-ൽ ഔദ്യോഗിക `@BotFather` തുറക്കുക.
2. `/newbot` അയച്ച് bot name ആയി `MS1 GROUP BOT` നൽകുക.
3. username ചോദിക്കുമ്പോൾ ലഭ്യമായ ഒരു username നൽകുക (അവസാനം `bot` വരണം).
4. BotFather നൽകുന്ന token സ്വകാര്യമായി സൂക്ഷിക്കുക. GitHub-ൽ പോസ്റ്റ് ചെയ്യരുത്.

## 2. ഹോസ്റ്റിൽ Environment Variables ചേർക്കുക
ഈ variables host-ന്റെ Environment/Secrets വിഭാഗത്തിൽ ചേർക്കുക:
- `TELEGRAM_BOT_TOKEN` = BotFather token
- `TELEGRAM_OWNER_ID` = നിങ്ങളുടെ numeric Telegram ID
- `OWNER_NUMBERS` = നിങ്ങളുടെ WhatsApp നമ്പർ country code സഹിതം, digits മാത്രം (ഉദാ. `919876543210`)
- `PREFIX` = `.`
- `WARN_LIMIT` = `3`

Telegram ID അറിയാൻ ആദ്യമായി `TELEGRAM_OWNER_ID` താൽക്കാലികമായി ഒഴിഞ്ഞുവെച്ച് bot run ചെയ്തശേഷം Telegram bot-ലേക്ക് `/id` അയയ്ക്കാം. Bot മറുപടിയിൽ ID കാണിക്കും. ആ ID host-ൽ `TELEGRAM_OWNER_ID` ആയി ചേർത്ത് service restart ചെയ്യുക. Token ഇല്ലാതെ Telegram bot പ്രവർത്തിക്കില്ല.

## 3. Deploy ചെയ്യുക
1. Host-ൽ **Node.js 20+** runtime അല്ലെങ്കിൽ Docker തിരഞ്ഞെടുക്കുക.
2. GitHub repository `Thakkudu1/MS1-GROUP-BOT-` connect ചെയ്യുക.
3. Start command: `npm start` (Docker ഉപയോഗിക്കുന്നുവെങ്കിൽ repository-യിലെ Dockerfile ഉപയോഗിക്കാം).
4. Environment variables ചേർക്കുക.
5. `session/` ഫോൾഡറിന് persistent disk/storage ഉണ്ടെന്ന് ഉറപ്പാക്കുക. Persistent storage ഇല്ലെങ്കിൽ restart/deploy കഴിഞ്ഞ് WhatsApp വീണ്ടും pair ചെയ്യേണ്ടിവരാം.
6. Service logs-ൽ bot start ആയെന്ന് ഉറപ്പാക്കുക.

## 4. WhatsApp pairing code നേടുക
1. Telegram bot-ൽ `/start` അയയ്ക്കുക.
2. `/pair` അയയ്ക്കുക.
3. WhatsApp നമ്പർ country code സഹിതം digits മാത്രം അയയ്ക്കുക (ഉദാ. `919876543210`).
4. Telegram-ൽ ലഭിക്കുന്ന pairing code സ്വകാര്യമായി സൂക്ഷിക്കുക.
5. WhatsApp തുറക്കുക → **Linked devices** → **Link a device** → **Link with phone number instead** → Telegram-ൽ ലഭിച്ച code നൽകുക.

Pairing code/token/session മറ്റാരുമായും പങ്കിടരുത്. ChatGPT-ക്ക് നിങ്ങളുടെ WhatsApp-ൽ നേരിട്ട് pairing പൂർത്തിയാക്കാൻ കഴിയില്ല.

## നിലവിലെ പരിധികൾ
ഇത് ഒരു starter ആണ്; എല്ലാ advanced group moderation ഫീച്ചറുകളും ഇപ്പോൾ ഇല്ല. Warning counter നിലവിൽ memory-ൽ മാത്രമാണ്. സൗജന്യ host ഉറക്കം/റീസ്റ്റാർട്ട്/ഡാറ്റാ പരിധികൾ ഏർപ്പെടുത്താം; 24/7 പ്രവർത്തനം ഉറപ്പല്ല. WhatsApp-ന്റെ ഔദ്യോഗികമായി പിന്തുണയ്ക്കുന്ന മാർഗങ്ങൾ ഉപയോഗിക്കുന്നത് കൂടുതൽ സുരക്ഷിതമാണ്.
