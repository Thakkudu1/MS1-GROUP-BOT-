require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const http = require("http");
const { startTelegram } = require("./telegram-pairing");

const PREFIX = process.env.PREFIX || ".";
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || "")
  .split(",").map(x => x.replace(/\D/g, "")).filter(Boolean);
const WARN_LIMIT = Number(process.env.WARN_LIMIT || 3);
const WARNINGS = new Map();
const GROUP_SETTINGS = new Map();
const LAST_MESSAGES = new Map();
const LAST_OWNER_REPLIES = new Map();
let statusAutoReact = process.env.STATUS_AUTO_REACT !== "false";
let statusAutoSeen = process.env.STATUS_AUTO_SEEN !== "false";
const STATUS_HEART_REACTIONS = ["❤️", "💖", "💕", "💗", "💘", "💝", "💓", "💞", "🩷"];
const MESSAGE_CACHE = new Map();
const MESSAGE_CACHE_LIMIT = 500;
function groupSettings(jid) {
  if (!GROUP_SETTINGS.has(jid)) GROUP_SETTINGS.set(jid, { antilink: true, antidelete: false, antispam: false, securityalerts: true, welcome: true, rules: "No rules have been set yet." });
  return GROUP_SETTINGS.get(jid);
}
const SESSION_DIR = process.env.SESSION_DIR || (process.env.PORT ? "/data/session" : "./session");
const STATS_FILE = process.env.STATS_FILE || (process.env.PORT ? "/data/message-counts.json" : "./message-counts.json");
let MESSAGE_COUNTS = {};
try {
  if (fs.existsSync(STATS_FILE)) MESSAGE_COUNTS = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
} catch (e) { console.error("Could not load message counts:", e.message); }
function recordGroupMessage(chat, sender, displayName) {
  if (!MESSAGE_COUNTS[chat]) MESSAGE_COUNTS[chat] = {};
  if (!MESSAGE_COUNTS[chat][sender]) MESSAGE_COUNTS[chat][sender] = { count: 0, name: displayName || senderNumber(sender) };
  MESSAGE_COUNTS[chat][sender].count += 1;
  if (displayName) MESSAGE_COUNTS[chat][sender].name = displayName;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(MESSAGE_COUNTS, null, 2)); }
  catch (e) { console.error("Could not save message counts:", e.message); }
}
fs.mkdirSync(SESSION_DIR, { recursive: true });
let sock;
let whatsappConnected = false;
let restarting = false;
let starting = false;
let reconnectAttempts = 0;
let lastIncomingMessageAt = null;
let messageProcessingErrors = 0;
let lastCredsSavedAt = null;
let lastCredsSaveError = null;
let reconnectTimer = null;
let pairingReady = false;
let pairingReadyWaiters = [];

// Retry failed startup attempts with capped exponential backoff. This covers
// transient DNS/network failures before the WhatsApp socket is fully created.
function scheduleStartupRetry(error) {
  starting = false;
  restarting = false;
  whatsappConnected = false;
  console.error("[STARTUP RETRY] WhatsApp startup failed:", error?.stack || error?.message || error);
  if (reconnectTimer) return;
  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
  reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
  console.warn("[STARTUP RETRY] Retrying in " + delay + " ms; saved session will be preserved.");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch(scheduleStartupRetry);
  }, delay);
  reconnectTimer.unref?.();
}

function waitForPairingReady(timeoutMs = 20000) {
  if (pairingReady) return Promise.resolve(true);
  return new Promise(resolve => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      pairingReadyWaiters = pairingReadyWaiters.filter(item => item !== waiter);
      resolve(false);
    }, timeoutMs);
    pairingReadyWaiters.push(waiter);
  });
}
function markPairingReady() {
  pairingReady = true;
  const waiters = pairingReadyWaiters;
  pairingReadyWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

function senderNumber(jid = "") {
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}
function isOwner(jid, alternateJids = []) {
  // WhatsApp groups may identify the same account with either a phone-number JID
  // or a Linked Identity (LID). Check both participant fields against both
  // identities exposed by the connected account.
  const senderJids = [jid, ...alternateJids].filter(Boolean);
  const ownerJids = [sock?.user?.id, sock?.user?.lid].filter(Boolean);
  const sameAsConnectedAccount = senderJids.some(senderJid =>
    ownerJids.some(ownerJid =>
      jidNormalizedUser(senderJid) === jidNormalizedUser(ownerJid)
    )
  );
  const connectedNumbers = ownerJids
    .filter(value => /@(s\.whatsapp\.net|c\.us)$/.test(value))
    .map(senderNumber)
    .filter(Boolean);
  const senderNumbers = senderJids
    .filter(value => /@(s\.whatsapp\.net|c\.us)$/.test(value))
    .map(senderNumber)
    .filter(Boolean);
  return sameAsConnectedAccount ||
    senderNumbers.some(number =>
      OWNER_NUMBERS.includes(number) || connectedNumbers.includes(number)
    );
}
function isGroup(jid = "") { return jid.endsWith("@g.us"); }
function unwrapMessageContent(message) {
  let current = message || {};
  for (let i = 0; i < 5; i++) {
    const nested = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message;
    if (!nested) break;
    current = nested;
  }
  return current;
}
function getText(msg) {
  const m = unwrapMessageContent(msg.message);
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    "";
}

// The repository stores the JPEG as Base64 text. Decode it once and verify
// the JPEG signature so an invalid text file is never sent as an image.
const MS2_LOGO_PATH = require("path").join(__dirname, "assets", "ms1-logo.jpg.b64");
let MS2_LOGO_BUFFER = null;
try {
  const logoBase64 = fs.readFileSync(MS2_LOGO_PATH, "utf8").replace(/\s/g, "");
  const decodedLogo = Buffer.from(logoBase64, "base64");
  const isJpeg = decodedLogo.length > 4 &&
    decodedLogo[0] === 0xff && decodedLogo[1] === 0xd8 &&
    decodedLogo[decodedLogo.length - 2] === 0xff && decodedLogo[decodedLogo.length - 1] === 0xd9;
  if (!isJpeg) throw new Error("Logo asset is not a complete JPEG image");
  MS2_LOGO_BUFFER = decodedLogo;
  console.log("[MS2 LOGO] JPEG loaded and validated:", decodedLogo.length, "bytes");
} catch (e) {
  console.error("[MS2 LOGO] Logo unavailable; check assets/ms1-logo.jpg.b64:", e.message);
}
async function sendMs1LogoNotice(chat, caption, quoted) {
  if (!MS2_LOGO_BUFFER) {
    await sock.sendMessage(chat, { text: caption }, quoted ? { quoted } : {}).catch(() => {});
    return;
  }
  await sock.sendMessage(chat, {
    image: MS2_LOGO_BUFFER,
    mimetype: "image/jpeg",
    caption
  }, quoted ? { quoted } : {}).catch(e =>
    console.error("[COMMAND PERMISSION] Notice failed:", e?.message || e)
  );
}
async function startBot() {
  // Never create two sockets at once: concurrent sockets sharing one auth folder
  // can overwrite Signal keys and trigger Bad MAC/decryption failures.
  if (starting) {
    console.log("[START] WhatsApp startup already in progress; duplicate start skipped.");
    return;
  }
  starting = true;
  pairingReady = false;

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); }
  catch (e) { console.warn("[BAILEYS VERSION] Could not fetch latest version; using library default:", e?.message || e); }

  const currentSocket = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || "silent" }),
    printQRInTerminal: false,
    browser: ["MS2 GROUP BOT", "Chrome", "1.0.0"],
    // Keep the WhatsApp WebSocket alive and allow slower mobile/host networks
    // enough time to complete handshakes and queries.
    keepAliveIntervalMs: 20_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    retryRequestDelayMs: 2_000,
    maxMsgRetryCount: 3,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  sock = currentSocket;

  // Serialize credential writes. Rapid creds.update events can otherwise
  // trigger overlapping writes to the same multi-file auth state.
  let credsSaveQueue = Promise.resolve();
  currentSocket.ev.on("creds.update", () => {
    credsSaveQueue = credsSaveQueue
      .then(() => saveCreds())
      .then(() => {
        lastCredsSavedAt = new Date().toISOString();
        lastCredsSaveError = null;
        console.log("[SESSION SAVE] WhatsApp credentials saved.");
      })
      .catch(e => {
        lastCredsSaveError = String(e?.message || e);
        console.error("[SESSION SAVE] Credentials could not be saved:", e?.stack || e?.message || e);
      });
  });

  currentSocket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    // Ignore events from an old socket after a replacement has been installed.
    if (sock !== currentSocket) return;

    const disconnectError = lastDisconnect?.error;
    const statusCode = disconnectError?.output?.statusCode;
    const errorText = String(disconnectError?.message || disconnectError || "");
    const badMac = /bad\s*mac|mac\s*error|decrypt.*session|invalid.*session/i.test(errorText);

    if (connection || qr || lastDisconnect) {
      console.log("[WA CONNECTION] state=" + (connection || "connecting") +
        " code=" + (statusCode || "-") +
        " qr=" + Boolean(qr) +
        " error=" + errorText.slice(0, 140));
    }
    if (qr) markPairingReady(); // Internal Baileys pairing signal only; QR is never displayed or sent.
    if (connection === "open" || connection === "close") {
      whatsappConnected = connection === "open";
      pairingReady = false;
    }
    if (connection === "open") {
      restarting = false;
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      console.log("[WA CONNECTION] MS2 GROUP BOT connected successfully.");
      return;
    }
    if (connection !== "close" || restarting) return;

    restarting = true;
    // Bad MAC during message decryption is NOT proof that the whole login is
    // invalid. Preserve auth files and reconnect; only a confirmed logged-out
    // / 401 response requires a fresh QR session.
    const loggedOut = statusCode === 401 || statusCode === DisconnectReason.loggedOut;
    if (badMac) {
      console.error("[SESSION WARNING] Bad MAC/decryption error detected. Preserving /data/session; no automatic auth deletion.");
    }
    const delay = loggedOut ? 2500 : Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
    reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
    console.log(loggedOut
      ? "[RECONNECT] WhatsApp reports logged out; a fresh QR login will be required."
      : "[RECONNECT] Scheduling one reconnect in " + delay + " ms; saved session will be preserved.");

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        if (loggedOut) {
          // A 401/logged-out session is invalid. The manual backup remains the
          // recovery point; all other disconnects retain the existing keys.
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR, { recursive: true });
          console.warn("[SESSION] Cleared auth files only after confirmed logged-out/401 status.");
        }
        restarting = false;
        await startBot();
      } catch (err) {
        starting = false;
        restarting = false;
        console.error("[RECONNECT] WhatsApp restart failed:", err?.stack || err?.message || err);
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startBot().catch(scheduleStartupRetry);
          }, 10000);
        }
      }
    }, delay);
  });

  currentSocket.ev.on("group-participants.update", async (event) => {
    if (sock !== currentSocket) return;
    if (!groupSettings(event.id).welcome) return;
    for (const participant of event.participants || []) {
      if (event.action === "add") {
        const welcomeText = `📢✨ *A WARM WELCOME!* ✨📢

🌟 Welcome to our group, @${senderNumber(participant)}! 🌟 ❤️🤝

We're happy to have you here! 😊🔥
Stay connected, respect everyone, share positive vibes, and help make this group amazing.

💬 *Your presence matters. Let's make great memories together!* 💯❤️

━━━━━━━━━━━━━━
💖 *BEST WISHES FROM MS2 GROUP!* 💖
━━━━━━━━━━━━━━`;
        let profilePicUrl = null;
        try { profilePicUrl = await sock.profilePictureUrl(participant, "image"); } catch {}
        if (profilePicUrl) {
          await sock.sendMessage(event.id, { image: { url: profilePicUrl }, caption: welcomeText, mentions: [participant] }).catch(async () => {
            await sock.sendMessage(event.id, { text: welcomeText, mentions: [participant] }).catch(() => {});
          });
        } else {
          await sock.sendMessage(event.id, { text: welcomeText, mentions: [participant] }).catch(() => {});
        }
        // Send the compact MS2 brand logo as a separate image directly below the welcome notice.
        if (MS2_LOGO_BUFFER) {
          await sock.sendMessage(event.id, {
            image: MS2_LOGO_BUFFER,
            mimetype: "image/jpeg",
            caption: "MS TWO • TECH CREW"
          }).catch(e => console.error("[WELCOME LOGO] Send failed:", e?.message || e));
        } else {
          console.error("[WELCOME LOGO] Skipped: logo file did not pass JPEG validation.");
        }
      } else if (event.action === "remove") {
        const goodbyeText = "😂 ഇറങ്ങിപ്പോടാ പുള്ളെ! 👋\n\n@" + senderNumber(participant) + " ഗ്രൂപ്പിൽ നിന്ന് പുറത്തുപോയി. 🚪";
        let profilePicUrl = null;
        try { profilePicUrl = await sock.profilePictureUrl(participant, "image"); } catch {}
        if (profilePicUrl) {
          await sock.sendMessage(event.id, {
            image: { url: profilePicUrl },
            caption: goodbyeText,
            mentions: [participant]
          }).catch(async () => {
            await sock.sendMessage(event.id, { text: goodbyeText, mentions: [participant] }).catch(() => {});
          });
        } else {
          await sock.sendMessage(event.id, { text: goodbyeText, mentions: [participant] }).catch(() => {});
        }
      }
    }
  });

  // Cache text messages so the bot can repost them if they are deleted for everyone.
  // This is in-memory only and does not recover messages sent before the bot was running.
  currentSocket.ev.on("messages.update", async (updates) => {
    if (sock !== currentSocket) return;
    for (const item of updates || []) {
      const protocolMessage = item.update?.message?.protocolMessage;
      const isRevoke = protocolMessage &&
        (protocolMessage.type === 0 || protocolMessage.type === "REVOKE");
      if (!isRevoke) continue;
      const deletedKey = protocolMessage.key;
      const chat = deletedKey?.remoteJid || item.key?.remoteJid;
      const id = deletedKey?.id;
      if (!chat || !id || !isGroup(chat) || !groupSettings(chat).antidelete) continue;
      const cacheKey = chat + ":" + id;
      const cached = MESSAGE_CACHE.get(cacheKey);
      if (!cached?.text) {
        console.log("[ANTIDELETE] Deleted message not in text cache", JSON.stringify({ chat, id }));
        continue;
      }
      const senderTag = "@" + senderNumber(cached.sender);
      await sock.sendMessage(chat, {
        text: "🗑️ *ANTI-DELETE: മെസ്സേജ് ഡിലീറ്റ് ചെയ്തു*\\nഅയച്ചത്: " + senderTag +
          "\\nമെസ്സേജ്: " + cached.text,
        mentions: cached.sender ? [cached.sender] : []
      }).catch(e => console.error("[ANTIDELETE] Restore notice failed:", e?.message || e));
      console.log("[ANTIDELETE] Reposted deleted text", JSON.stringify({ chat, id }));
    }
  });

  currentSocket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (sock !== currentSocket) return;
    console.log("[INCOMING EVENT]", JSON.stringify({ type, count: (messages || []).length, connected: whatsappConnected }));
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
      lastIncomingMessageAt = new Date().toISOString();
      if (!msg.message) continue;
      // Unwrap WhatsApp ephemeral/view-once wrappers before parsing commands and mentions.
      msg.message = unwrapMessageContent(msg.message);
      const chat = msg.key.remoteJid;
      if (!chat) continue;
      // Automatically view incoming statuses and react with heart emojis only.
      if (chat === "status@broadcast") {
        if (!msg.key.fromMe && msg.key.id) {
          if (statusAutoSeen) {
            await sock.readMessages([msg.key])
              .catch(e => console.error("[STATUS AUTO-SEEN] failed:", e?.message || e));
          }
          if (statusAutoReact) {
            const reaction = STATUS_HEART_REACTIONS[Math.floor(Math.random() * STATUS_HEART_REACTIONS.length)];
            await sock.sendMessage("status@broadcast", { react: { text: reaction, key: msg.key } })
              .catch(e => console.error("[STATUS AUTO-REACTION] failed:", e?.message || e));
          }
        }
        continue;
      }
      const sender = msg.key.fromMe
        ? (sock.user?.id || msg.key.participant || msg.key.participantAlt || chat)
        : (msg.key.participant || msg.key.participantAlt || msg.participant || chat);
      const text = getText(msg).trim();
      if (isGroup(chat) && text && msg.key.id) {
        const cacheKey = chat + ":" + msg.key.id;
        MESSAGE_CACHE.set(cacheKey, { text, sender, timestamp: Date.now() });
        if (MESSAGE_CACHE.size > MESSAGE_CACHE_LIMIT) {
          const oldestKey = MESSAGE_CACHE.keys().next().value;
          if (oldestKey) MESSAGE_CACHE.delete(oldestKey);
        }
      }
      if (isGroup(chat)) {
        console.log("[TOPCHAT] message", JSON.stringify({ type, fromMe: Boolean(msg.key.fromMe), chat, participant: msg.key.participant || null, participantAlt: msg.key.participantAlt || null, pushName: msg.pushName || null }));
        recordGroupMessage(chat, sender, msg.pushName || senderNumber(sender));
      }
      if (!text) continue;

      // Fast-path ping before group metadata and mention processing.
      const normalizedPing = text.trim().toLowerCase();
      if (normalizedPing === PREFIX.toLowerCase() + "ping" || normalizedPing === "ping") {
        console.log("[COMMAND] ping received", JSON.stringify({ chat, fromMe: Boolean(msg.key.fromMe), sender, prefix: PREFIX }));
        try {
          await sock.sendMessage(chat, { text: "Pong! 🟢 MS2 GROUP BOT is online." }, { quoted: msg });
          console.log("[COMMAND] ping reply sent", chat);
        } catch (e) {
          console.error("[COMMAND] ping reply failed:", e?.stack || e?.message || e);
        }
        continue;
      }

      // Private-chat auto-replies are intentionally disabled by owner request.

      if (isGroup(chat)) {
        // Reply when the owner is mentioned, or when the group is all-mentioned/tagged.
        const mentionedJids = [
          ...(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []),
          ...(msg.message?.imageMessage?.contextInfo?.mentionedJid || []),
          ...(msg.message?.videoMessage?.contextInfo?.mentionedJid || []),
          ...(msg.message?.documentMessage?.contextInfo?.mentionedJid || []),
          ...(msg.message?.messageContextInfo?.mentionedJid || [])
        ];
        const textDigits = text.replace(/\\D/g, "");
        const ownerMentioned = OWNER_NUMBERS.some(ownerNumber =>
          mentionedJids.some(jid => senderNumber(jid) === ownerNumber) ||
          (ownerNumber.length >= 10 && textDigits.includes(ownerNumber))
        );
        // Match the owner's WhatsApp profile/contact name from group metadata as well.
        let groupMetadataForMentions = null;
        if (isGroup(chat)) {
          groupMetadataForMentions = await sock.groupMetadata(chat).catch(() => null);
        }
        const ownerParticipants = (groupMetadataForMentions?.participants || []).filter(p =>
          OWNER_NUMBERS.includes(senderNumber(p.id)) ||
          OWNER_NUMBERS.includes(senderNumber(p.phoneNumber || ""))
        );
        const ownerNames = ownerParticipants
          .flatMap(p => [p.notify, p.name, p.verifiedName, p.pushName])
          .filter(name => typeof name === "string" && name.trim().length >= 2)
          .map(name => name.trim().toLocaleLowerCase());
        const normalizedText = text.toLocaleLowerCase();
        const ownerNameMentioned = ownerNames.some(name => normalizedText.includes(name));
        const explicitAllMention = /@everyone|@all|all mention|ഓൾ മെൻഷൻ/i.test(text);
        let allGroupMembersMentioned = false;
        if (isGroup(chat) && mentionedJids.length > 1) {
          const metadata = groupMetadataForMentions;
          allGroupMembersMentioned = Boolean(metadata &&
            mentionedJids.length >= Math.max(2, metadata.participants.length - 1));
        }
        if (ownerMentioned || ownerNameMentioned || explicitAllMention || allGroupMembersMentioned) {
          const replyOpeners = [
            "🥰 എന്താ വിശേഷം?",
            "ഹായ് കൂട്ടുകാരേ! 😄",
            "ഞാൻ ഇവിടെ ഉണ്ട് ട്ടോ 😊",
            "ഓഹോ, എന്നെയാണോ വിളിച്ചത്? 😄",
            "ഹലോ ഹലോ! 👋",
            "വിളി കേട്ടു ട്ടോ! 💖",
            "എന്നെ ഓർത്തതിന് നന്ദി 😊",
            "എന്താ മക്കളേ വിശേഷം? 😍",
            "മെൻഷൻ കണ്ടു ട്ടോ ✨",
            "ഹായ്, സുഖമാണോ? 🌸",
            "അയ്യോ, ഞാൻ ഇവിടെയുണ്ട്! 😄",
            "പറയൂ കൂട്ടുകാരേ 💛",
            "യെസ്, ഞാൻ ഓൺലൈനിലുണ്ട്! 😎",
            "എന്താ കാര്യം? 😊",
            "ഹായ് ഹായ്! 💕",
            "ഞാൻ കേൾക്കുന്നുണ്ട് ട്ടോ 👂",
            "എന്നെയാണോ അന്വേഷിച്ചത്? 😄",
            "ഇവിടെത്തന്നെയുണ്ട് കൂട്ടുകാരേ! 🌼",
            "ഓക്കേ, ഞാൻ റെഡിയാണ്! 💬",
            "സ്നേഹത്തോടെ ഹായ്! ❤️",
            "അങ്ങനെ വിളിച്ചോ? 😄",
            "ഞാൻ എത്തിയിട്ടുണ്ട് ട്ടോ! ✨",
            "ഹായ് എല്ലാവർക്കും! 🥰",
            "എന്തെങ്കിലും പറയാനുണ്ടോ? 💭",
            "വിളി കിട്ടി കൂട്ടുകാരേ! 📩",
            "സുഖമാണോ കൂട്ടുകാരേ? 💗",
            "എന്തൊക്കെയുണ്ട് വിശേഷങ്ങൾ? 🌺",
            "ഞാൻ കേൾക്കാൻ തയ്യാറാണ്! 😊",
            "വിളിച്ചാൽ ഞാൻ വരുമല്ലോ! 😄",
            "കൂട്ടുകാരുടെ വിളി എപ്പോഴും കേൾക്കും! 💞",
            "ഹായ്, പറയൂ പറയൂ! 🙌",
            "എന്നെ ടാഗ് ചെയ്തോ? 😎",
            "കണ്ടു ട്ടോ, മെസ്സേജ് കിട്ടി! 📲",
            "ഞാൻ ഇവിടെയുണ്ട്, പേടിക്കണ്ട! 😂",
            "എന്താ വിശേഷം പറയാനുള്ളത്? 🌻",
            "ഒരു ഹായ് പറയാൻ വന്നതാണ്! 💌",
            "നിങ്ങളുടെ ബോട്ട് ഇവിടെ ഉണ്ട്! 🤖",
            "എന്നെ വിളിച്ചത് സന്തോഷമായി! 🥰",
            "ഹായ്, ഞാൻ ശ്രദ്ധിക്കുന്നുണ്ട്! 👀",
            "പറയൂ, എന്താണ് പ്ലാൻ? 😄"
          ];
          const replyClosers = [
            "പറയൂ, എന്താണ് വിശേഷം? 😊",
            "എന്ത് സഹായമാണ് വേണ്ടത്? 💬",
            "എല്ലാവരും സുഖമായിരിക്കുന്നല്ലോ? 💖",
            "പറയൂ, കേൾക്കാൻ റെഡിയാണ്! 😄",
            "എന്താ പുതിയ വാർത്തകൾ? 🌸",
            "സംസാരിക്കാം, പറയൂ ട്ടോ! 🤗",
            "എന്തെങ്കിലും കാര്യമുണ്ടെങ്കിൽ പറയണേ! 💛",
            "ഞാൻ ഇവിടെത്തന്നെയുണ്ട്, മടിക്കണ്ട! ✨",
            "പറഞ്ഞോളൂ, ശ്രദ്ധിച്ച് കേൾക്കുന്നുണ്ട്! 👂",
            "എന്താണ് ഇന്നത്തെ വിശേഷം? 😍",
            "നമുക്ക് സംസാരിക്കാം കൂട്ടുകാരേ! 💕",
            "പറഞ്ഞാൽ സന്തോഷത്തോടെ മറുപടി തരാം! 🌷",
            "എന്താണ് സഹായിക്കേണ്ടത് എന്ന് പറയൂ! 🙏",
            "ഒരു നല്ല ദിവസം ആയിരിക്കട്ടെ! ☀️",
            "നിങ്ങളുടെ മെസ്സേജ് കണ്ടു, പറയൂ! 📩",
            "എന്തെങ്കിലും സംശയമുണ്ടെങ്കിൽ ചോദിക്കൂ! 🧠",
            "ഞാൻ റെഡിയാണ്, തുടങ്ങിക്കോളൂ! 🚀",
            "എല്ലാം ഓക്കേയല്ലേ? 💚",
            "വിശേഷങ്ങൾ പങ്കുവെക്കൂ! 🌈",
            "പറയൂ, കേൾക്കുന്നുണ്ട് ട്ടോ! 🎧"
          ];
          const friendlyReplies = replyOpeners.flatMap(opener =>
            replyClosers.map(closer => opener + " " + closer)
          );
          const previousReply = LAST_OWNER_REPLIES.get(chat);
          const choices = friendlyReplies.filter(replyText => replyText !== previousReply);
          const replyText = choices[Math.floor(Math.random() * choices.length)] || friendlyReplies[0];
          LAST_OWNER_REPLIES.set(chat, replyText);
          await sock.sendMessage(chat, { text: replyText }, { quoted: msg }).catch(e =>
            console.error("[OWNER MENTION REPLY] failed:", e?.message || e)
          );
        }
        const settings = groupSettings(chat);
        const now = Date.now();
        const spamKey = chat + ":" + sender;
        const prior = LAST_MESSAGES.get(spamKey) || { time: 0, count: 0 };
        const recent = now - prior.time < 5000;
        LAST_MESSAGES.set(spamKey, { time: now, count: recent ? prior.count + 1 : 1 });
        if (settings.antispam && recent && prior.count >= 4) {
          const meta = await sock.groupMetadata(chat).catch(() => null);
          const senderAdmin = meta?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
          if (!senderAdmin && !isOwner(sender)) {
            await sock.sendMessage(chat, { text: "⚠️ Please slow down; anti-spam is enabled." }, { quoted: msg }).catch(() => {});
            if (settings.securityalerts) {
              const adminJids = [...new Set((meta?.participants || [])
                .filter(p => p.admin === "admin" || p.admin === "superadmin")
                .map(p => p.id).filter(Boolean))];
              const mentions = [...new Set([sender, ...adminJids])];
              const adminTags = adminJids.map(jid => "@" + senderNumber(jid)).join(" ");
              await sock.sendMessage(chat, {
                text: "🚨 *SPAM ALERT* 🚨\nകുറച്ച് സെക്കൻഡുകൾക്കുള്ളിൽ ഒരാൾ നിരവധി മെസ്സേജുകൾ അയച്ചു. പരിശോധിക്കുക.\nഅയച്ചത്: @" + senderNumber(sender) + (adminTags ? "\nഅഡ്മിൻമാർ: " + adminTags : ""),
                mentions
              }).catch(e => console.error("[SPAM ALERT] failed:", e?.message || e));
            }
            continue;
          }
        }
        const containsAnyLink = /(?:https?:\/\/|ftp:\/\/|www\d?\.[^\s]+|(?:chat\.whatsapp\.com|wa\.me|whatsapp\.com|t\.me|telegram\.me|telegram\.org|youtu\.be|youtube\.com|instagram\.com|facebook\.com|fb\.watch|bit\.ly|tinyurl\.com|tiktok\.com|x\.com|twitter\.com)\/?[^\s]*|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:[/:?#][^\s]*)?)/i.test(text);
        if (settings.antilink && containsAnyLink) {
          const meta = await sock.groupMetadata(chat).catch(() => null);
          const botJids = [sock.user?.id, sock.user?.lid].filter(Boolean);
          const ownerIsAdmin = (meta?.participants || []).some(p =>
            botJids.some(jid =>
              [p.id, p.phoneNumber, p.lid].filter(Boolean).some(id =>
                jidNormalizedUser(id) === jidNormalizedUser(jid)
              )
            ) && (p.admin === "admin" || p.admin === "superadmin")
          );
          const adminJids = [...new Set((meta?.participants || [])
            .filter(p => p.admin === "admin" || p.admin === "superadmin")
            .flatMap(p => [p.id, p.phoneNumber, p.lid].filter(Boolean)))];
          const adminTags = adminJids.map(jid => "@" + senderNumber(jid)).join(" ");

          // The connected WhatsApp account must be a group admin to remove links.
          // If it is not an admin, leave the message in place and alert the admins.
          if (!ownerIsAdmin) {
            console.log("[ANTILINK] Bot account is not a group admin; notifying admins", chat);
            const alertText = "🚨 *MS2 ANTI-LINK WARNING* 🚨\nഒരു ലിങ്ക് കണ്ടെത്തി. ഈ ഗ്രൂപ്പിൽ ബോട്ട് അഡ്മിൻ അല്ലാത്തതിനാൽ മെസ്സേജ് ഡിലീറ്റ് ചെയ്യാൻ കഴിയില്ല.\nഅയച്ചത്: @" +
              senderNumber(sender) + (adminTags ? "\nഅഡ്മിൻമാർ: " + adminTags : "\nഗ്രൂപ്പ് അഡ്മിൻമാരെ കണ്ടെത്താനായില്ല.");
            await sock.sendMessage(chat, {
              text: alertText,
              mentions: [...new Set([sender, ...adminJids])]
            }).catch(e => console.error("[ANTILINK] Admin warning failed:", e?.message || e));
            continue;
          }

          // Remove links from every member, including admins and the bot owner.
          const deleteKey = {
            remoteJid: chat,
            fromMe: Boolean(msg.key.fromMe),
            id: msg.key.id,
            participant: msg.key.participant || msg.key.participantAlt || sender
          };
          let linkDeleted = false;
          try {
            await sock.sendMessage(chat, { delete: deleteKey });
            linkDeleted = true;
            console.log("[ANTILINK] Deleted link message", JSON.stringify({ chat, id: msg.key.id }));
          } catch (e) {
            console.error("[ANTILINK] Delete failed:", e?.message || e);
          }

          // Remove the link sender from the group after detecting the link.
          // WhatsApp may reject removal of group owners/admins or if the sender JID is not actionable.
          const senderIsBot = botJids.some(jid => jidNormalizedUser(jid) === jidNormalizedUser(sender));
          let senderRemoved = false;
          if (!senderIsBot) {
            try {
              await sock.groupParticipantsUpdate(chat, [sender], "remove");
              senderRemoved = true;
              console.log("[ANTILINK] Removed link sender from group", JSON.stringify({ chat, sender }));
            } catch (e) {
              console.error("[ANTILINK] Could not remove link sender:", e?.message || e);
            }
          }

          const resultLines = [
            linkDeleted ? "🔗 ലിങ്ക് മെസ്സേജ് ഡിലീറ്റ് ചെയ്തു." : "⚠️ ലിങ്ക് മെസ്സേജ് ഡിലീറ്റ് ചെയ്യാൻ കഴിഞ്ഞില്ല.",
            senderRemoved ? "🚫 ലിങ്ക് അയച്ചയാളെ ഗ്രൂപ്പിൽ നിന്ന് നീക്കം ചെയ്തു." :
              (senderIsBot ? "ബോട്ട് സ്വന്തം മെസ്സേജ് അയച്ചതിനാൽ ബോട്ടിനെ നീക്കം ചെയ്തില്ല." :
                "⚠️ അയച്ചയാളെ നീക്കം ചെയ്യാൻ കഴിഞ്ഞില്ല. അയാൾ ഗ്രൂപ്പ് അഡ്മിൻ/ഓണർ ആയിരിക്കാം; ബോട്ടിന്റെ അനുമതിയും പരിശോധിക്കുക."),
            "അയച്ചത്: @" + senderNumber(sender)
          ];
          await sock.sendMessage(chat, {
            text: "🛡️ *MS2 ANTI-LINK ACTION*\n" + resultLines.join("\n"),
            mentions: [sender]
          }).catch(e => console.error("[ANTILINK] Action notice failed:", e?.message || e));
          continue;
        }
      }

      const reply = (body) => sock.sendMessage(chat, { text: body }, { quoted: msg });
      const safePlainCommands = new Set(["menu", "help", "ping", "alive", "owner", "topchat", "mystats", "rules"]);
      const firstWord = text.trim().split(/\s+/)[0].toLowerCase();
      const command = text.startsWith(PREFIX)
        ? text.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase()
        : (safePlainCommands.has(firstWord) ? firstWord : "");
      const args = command
        ? (text.startsWith(PREFIX)
            ? text.slice(PREFIX.length).trim().split(/\s+/).slice(1)
            : text.trim().split(/\s+/).slice(1))
        : [];
      // Keep private owner-only controls restricted, but let group admins use
      // the admin-protected moderation/settings commands below. Public utility
      // commands (menu, ping, alive, topchat, mystats, rules read) remain usable.
      if (["owner", "statusseen", "statusreact"].includes(command) &&
          !isOwner(sender, [msg.key.participant, msg.key.participantAlt, msg.participant, chat])) {
        console.log("[COMMAND AUTH] owner-only command denied", JSON.stringify({
          sender, participant: msg.key.participant || null,
          participantAlt: msg.key.participantAlt || null, command
        }));
        await sendMs1LogoNotice(chat, "🔒 ഈ കമാൻഡ് MS2 GROUP BOT ഉടമയ്ക്ക് മാത്രം ഉപയോഗിക്കാം.", msg);
        continue;
      }
      if (command === "topchat" && isGroup(chat)) {
        const ranking = Object.entries(MESSAGE_COUNTS[chat] || {}).map(([jid, stats]) => ({ jid, name: stats.name || senderNumber(jid), count: Number(stats.count) || 0 })).sort((a, b) => b.count - a.count).slice(0, 10);
        if (!ranking.length) await reply("📊 ഇതുവരെ ഗ്രൂപ്പ് മെസ്സേജുകൾ കണക്കാക്കിയിട്ടില്ല.");
        else {
          const lines = ranking.map((item, i) => (["🥇", "🥈", "🥉"][i] || (String(i + 1) + ".")) + " " + item.name + " — " + item.count + " മെസ്സേജുകൾ");
          await reply("🏆 *TOP 10 CHATTERS* 🏆\n\n" + lines.join("\n") + "\n\n📌 ബോട്ട് കണക്കാക്കിത്തുടങ്ങിയതുമുതലുള്ള മെസ്സേജുകളാണ് ഉൾപ്പെടുത്തിയിരിക്കുന്നത്.");
        }
      } else if (command === "mystats" && isGroup(chat)) {
        const mine = MESSAGE_COUNTS[chat]?.[sender];
        await reply("📊 നിങ്ങളുടെ മെസ്സേജ് എണ്ണം: " + (Number(mine?.count) || 0));
      } else if (command === "menu" || command === "help") {
        await reply(
`╭─「 MS2 GROUP BOT 」
│ Prefix: ${PREFIX}
│ ${PREFIX}menu / ${PREFIX}help
│ ${PREFIX}ping
│ ${PREFIX}alive
│ ${PREFIX}topchat (top 10 message senders)
│ ${PREFIX}mystats (your message count)
│ ${PREFIX}tagall [message] (owner/admins)
│ ${PREFIX}kick @user / ${PREFIX}promote @user (owner/admins)
│ ${PREFIX}demote @user (owner/admins)
│ ${PREFIX}warn @user / ${PREFIX}warnings
│ ${PREFIX}antilink on|off (group admins / owner)
│ ${PREFIX}antidelete on|off (text recovery; admins / owner)
│ ${PREFIX}antispam on|off (admins)
│ ${PREFIX}securityalerts on|off (link/spam admin alerts)
│ ${PREFIX}welcome on|off (admins)
│ ${PREFIX}statusreact on|off (owner; heart-only status reactions)
│ ${PREFIX}statusseen on|off (owner; auto-view statuses)
│ ${PREFIX}rules [text] (admins)
│ ${PREFIX}ping / ${PREFIX}alive / ${PREFIX}owner
╰ Settings reset when the bot restarts`
        );
      } else if (command === "ping") {
        await reply("Pong! 🟢 MS2 GROUP BOT is online.");
      } else if (command === "alive") {
        await reply("🟢 MS2 GROUP BOT is running.");
      } else if (command === "owner") {
        await reply(OWNER_NUMBERS.length ? `Owner: ${OWNER_NUMBERS.map(n => "+" + n).join(", ")}` : "Owner number is not configured yet.");
      } else if (command === "statusseen") {
        if (!isOwner(sender)) { await reply("🔒 ഈ കമാൻഡ് ബോട്ട് ഓണർക്ക് മാത്രം ഉപയോഗിക്കാം."); continue; }
        const value = args[0]?.toLowerCase();
        if (!["on", "off"].includes(value)) {
          await reply("Usage: " + PREFIX + "statusseen on|off. Current: " + (statusAutoSeen ? "ON 👀" : "OFF"));
          continue;
        }
        statusAutoSeen = value === "on";
        await reply(statusAutoSeen ? "👀 Status Auto-Seen ON!" : "Status Auto-Seen OFF.");
      } else if (command === "statusreact") {
        if (!isOwner(sender)) { await reply("🔒 ഈ കമാൻഡ് ബോട്ട് ഓണർക്ക് മാത്രം ഉപയോഗിക്കാം."); continue; }
        const value = args[0]?.toLowerCase();
        if (!["on", "off"].includes(value)) {
          await reply("Usage: " + PREFIX + "statusreact on|off. Current: " + (statusAutoReact ? "ON 💖" : "OFF"));
          continue;
        }
        statusAutoReact = value === "on";
        await reply(statusAutoReact ? "💖 Status Auto-Reaction ON! ❤️💖💕💗💘💝💓💞🩷" : "Status Auto-Reaction OFF.");
      } else if (["kick", "promote", "demote"].includes(command)) {
        if (!isGroup(chat)) { await reply("This command works only in a group."); continue; }
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        if (!metadata) { await reply("Could not read group information."); continue; }
        const botJid = jidNormalizedUser(sock.user.id);
        const botIsAdmin = metadata.participants.some(p => jidNormalizedUser(p.id) === botJid && (p.admin === "admin" || p.admin === "superadmin"));
        const senderIsAdmin = metadata.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!isOwner(sender) && !senderIsAdmin) { await reply("Only the bot owner or a group admin can use this command."); continue; }
        if (!botIsAdmin) { await reply("Please make the bot a group admin first."); continue; }
        const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) { await reply("Mention a member to " + command + "."); continue; }
        const action = command === "kick" ? "remove" : command === "promote" ? "promote" : "demote";
        try {
          await sock.groupParticipantsUpdate(chat, [target], action);
          await reply("Done: " + command + " for @" + senderNumber(target) + ".");
        } catch (e) { await reply("Could not " + command + " that member. Check bot admin permissions."); }
      } else if (["antilink", "antidelete", "antispam", "securityalerts", "welcome"].includes(command) && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        const senderIsAdmin = metadata?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!senderIsAdmin && !isOwner(sender)) { await reply("Only group admins can change settings."); continue; }
        const value = args[0]?.toLowerCase();
        if (!["on", "off"].includes(value)) { await reply("Usage: " + PREFIX + command + " on|off"); continue; }
        groupSettings(chat)[command] = value === "on";
        await reply(command + " is now " + value + " for this running session.");
      } else if (command === "rules" && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        const senderIsAdmin = metadata?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (args.length && !senderIsAdmin && !isOwner(sender)) { await reply("Only group admins can change rules."); continue; }
        if (args.length) {
          groupSettings(chat).rules = args.join(" ");
          await reply("Group rules updated for this running session.");
        } else {
          await reply("Group rules: " + groupSettings(chat).rules);
        }
      } else if (command === "tagall" && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        if (!metadata) { await reply("Could not read group information."); continue; }
        const senderIsAdmin = metadata.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!isOwner(sender) && !senderIsAdmin) { await reply("Only the bot owner or a group admin can use this command."); continue; }
        const mentions = metadata.participants.map(p => p.id);
        const body = args.join(" ") || "Attention everyone!";
        await sock.sendMessage(chat, { text: `📢 ${body}\n\n` + mentions.map(j => "@" + senderNumber(j)).join(" "), mentions }, { quoted: msg });
      } else if (command === "warn" && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        const senderIsAdmin = metadata?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!isOwner(sender) && !senderIsAdmin) { await reply("Only the bot owner or a group admin can use this command."); continue; }
        const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) { await reply(`Mention a member: ${PREFIX}warn @member`); continue; }
        const key = `${chat}:${target}`;
        const count = (WARNINGS.get(key) || 0) + 1;
        WARNINGS.set(key, count);
        await reply(`⚠️ @${senderNumber(target)} warning ${count}/${WARN_LIMIT}.` + (count >= WARN_LIMIT ? "\nWarning limit reached. An admin should review this member." : ""));
      } else if (command === "warnings" && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        const senderIsAdmin = metadata?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!isOwner(sender) && !senderIsAdmin) { await reply("Only the bot owner or a group admin can use this command."); continue; }
        await reply("Warnings are stored in memory for this running session; persistent storage is not configured yet.");
      } else if (command) {
        await reply(`Unknown command. Send ${PREFIX}menu to see available commands.`);
      }
      } catch (messageError) {
        messageProcessingErrors += 1;
        console.error("[MESSAGE PROCESSING] One message failed; continuing with the next message:", messageError?.stack || messageError?.message || messageError);
        try {
          if (msg?.key?.remoteJid && sock === currentSocket && whatsappConnected) {
            await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ ഈ മെസ്സേജ് പ്രോസസ് ചെയ്യുമ്പോൾ താൽക്കാലിക പ്രശ്നം ഉണ്ടായി. വീണ്ടും ശ്രമിക്കുക." });
          }
        } catch (replyError) {
          console.error("[MESSAGE PROCESSING] Could not send recovery notice:", replyError?.message || replyError);
        }
      }
    }
  });
  starting = false;
}
// DormHost expects an HTTP listener on PORT. These endpoints are health checks only.
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({
      app: "running",
      whatsapp: whatsappConnected ? "connected" : "disconnected",
      starting,
      reconnecting: restarting,
      reconnectAttempts,
      lastIncomingMessageAt,
      messageProcessingErrors,
      sessionSave: {
        lastSavedAt: lastCredsSavedAt,
        lastError: lastCredsSaveError
      },
      uptimeSeconds: Math.floor(process.uptime()),
      sessionStorage: SESSION_DIR
    }) + "\n");
    return;
  }
  // Keep the platform liveness probe independent from WhatsApp readiness.
  // A WhatsApp outage must not cause the host to repeatedly kill the Node process.
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("MS2 GROUP BOT process is running\n");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});
server.listen(PORT, "0.0.0.0", () => console.log(`Health server listening on 0.0.0.0:${PORT}`));

startTelegram(() => sock, () => pairingReady, waitForPairingReady);
startBot().catch(scheduleStartupRetry);

// Log rejected background tasks without silently terminating the bot process.
process.on("unhandledRejection", reason => {
  console.error("[UNHANDLED REJECTION] Background task failed:", reason?.stack || reason?.message || reason);
});

// A truly uncaught exception can leave the process in an unsafe state. Exit
// non-zero so the hosting platform's configured restart policy can relaunch it.
process.on("uncaughtException", error => {
  console.error("[UNCAUGHT EXCEPTION] Exiting for host-level restart:", error?.stack || error);
  process.exit(1);
});
