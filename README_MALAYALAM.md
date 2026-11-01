# MS1 GROUP BOT — മലയാളം

ഈ repository-ൽ Telegram വഴി നിയന്ത്രിച്ച് WhatsApp pairing code നൽകുന്ന Node.js bot starter ഉണ്ട്.

## കമാൻഡുകൾ
- Telegram: `/start`, `/id`, `/pair`, `/topchat`, `/mystats`
- Telegram ഗ്രൂപ്പിൽ `/topchat` ഉപയോഗിച്ചാൽ Top 10 മെസ്സേജ് അയച്ചവരെ കാണിക്കും; `/mystats` നിങ്ങളുടെ കണക്ക് കാണിക്കും.
- Telegram ഗ്രൂപ്പിലെ എല്ലാ മെസ്സേജുകളും എണ്ണാൻ BotFather-ൽ `/setprivacy` → നിങ്ങളുടെ bot തിരഞ്ഞെടുക്കുക → `Disable` ചെയ്യുക. ശേഷം ബോട്ടിനെ ഗ്രൂപ്പിൽ ചേർക്കുക. കണക്ക് ബോട്ട് ചേർത്തതിന് ശേഷമുള്ള മെസ്സേജുകളിൽ നിന്നാണ് തുടങ്ങുക.
- WhatsApp: `.menu`, `.ping`, `.alive`, `.owner`, `.topchat`, `.mystats`, `.tagall`, `.warn @member`, `.warnings`
- `.topchat`: ഗ്രൂപ്പിൽ ഏറ്റവും കൂടുതൽ മെസ്സേജ് അയച്ച Top 10 അംഗങ്ങളെ കാണിക്കും.
- `.mystats`: നിങ്ങൾ അയച്ച മെസ്സേജുകളുടെ എണ്ണം കാണിക്കും.
- മെസ്സേജ് കണക്ക് ബോട്ട് പ്രവർത്തിക്കുന്ന സമയത്തുമുതൽ ശേഖരിക്കും; പഴയ മെസ്സേജുകൾ കണക്കിൽ വരില്ല.

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

## 3. DormHost-ൽ Deploy ചെയ്യുക
1. DormHost dashboard-ൽ `New app` അമർത്തുക.
2. Name: `ms1-group-bot`; Plan: WhatsApp/Telegram bot തുടർച്ചയായി പ്രവർത്തിക്കാൻ `Awake` ആണ് അനുയോജ്യം; Region: `Mumbai, India`.
3. GitHub repository `https://github.com/Thakkudu1/MS1-GROUP-BOT-` සහ branch `main` തിരഞ്ഞെടുക്കുക.
4. `Subdirectory` ശൂന്യമായി വിടുക. Repository root-ലെ `Dockerfile` ഉപയോഗിച്ചാണ് build.
5. `Create and deploy` അമർത്തിയശേഷം app-ന്റെ `Environment` വിഭാഗത്തിൽ ആവശ്യമായ variables ചേർക്കുക.
6. App-ന് `PORT` ലഭിക്കും; `index.js` അതിൽ `0.0.0.0`-ൽ health endpoint തുറക്കും. WhatsApp session `/data/session`-ൽ സൂക്ഷിക്കും, അത് DormHost persistent storage ആണ്.
7. `Live logs`-ൽ build വിജയിച്ചതും `Health server listening` / `Telegram control bot started` സന്ദേശങ്ങളും ഉണ്ടെന്ന് പരിശോധിക്കുക.

## 4. WhatsApp pairing code നേടുക
1. Telegram bot-ൽ `/start` അയയ്ക്കുക.
2. `/pair` അയയ്ക്കുക.
3. WhatsApp നമ്പർ country code സഹിതം digits മാത്രം അയയ്ക്കുക (ഉദാ. `919876543210`).
4. Telegram-ൽ ലഭിക്കുന്ന pairing code സ്വകാര്യമായി സൂക്ഷിക്കുക.
5. WhatsApp തുറക്കുക → **Linked devices** → **Link a device** → **Link with phone number instead** → Telegram-ൽ ലഭിച്ച code നൽകുക.

Pairing code/token/session മറ്റാരുമായും പങ്കിടരുത്. ChatGPT-ക്ക് നിങ്ങളുടെ WhatsApp-ൽ നേരിട്ട് pairing പൂർത്തിയാക്കാൻ കഴിയില്ല.

## നിലവിലെ പരിധികൾ
ഇത് ഒരു starter ആണ്; എല്ലാ advanced group moderation ഫീച്ചറുകളും ഇപ്പോൾ ഇല്ല. Warning counter നിലവിൽ memory-ൽ മാത്രമാണ്. സൗജന്യ host ഉറക്കം/റീസ്റ്റാർട്ട്/ഡാറ്റാ പരിധികൾ ഏർപ്പെടുത്താം; 24/7 പ്രവർത്തനം ഉറപ്പല്ല. WhatsApp-ന്റെ ഔദ്യോഗികമായി പിന്തുണയ്ക്കുന്ന മാർഗങ്ങൾ ഉപയോഗിക്കുന്നത് കൂടുതൽ സുരക്ഷിതമാണ്.
