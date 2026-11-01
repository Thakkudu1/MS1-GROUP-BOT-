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
const qrcode = require("qrcode-terminal");
const { startTelegram } = require("./telegram-pairing");

const PREFIX = process.env.PREFIX || ".";
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || "")
  .split(",").map(x => x.replace(/\D/g, "")).filter(Boolean);
const WARN_LIMIT = Number(process.env.WARN_LIMIT || 3);
const WARNINGS = new Map();
const GROUP_SETTINGS = new Map();
const LAST_MESSAGES = new Map();
function groupSettings(jid) {
  if (!GROUP_SETTINGS.has(jid)) GROUP_SETTINGS.set(jid, { antilink: true, antispam: false, welcome: true, rules: "No rules have been set yet." });
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
let restarting = false;
let pairingReady = false;
let pairingReadyWaiters = [];
let latestQr = null;
let qrWaiters = [];

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
function waitForQr(timeoutMs = 20000) {
  if (latestQr) return Promise.resolve(latestQr);
  return new Promise(resolve => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      qrWaiters = qrWaiters.filter(item => item !== waiter);
      resolve(null);
    }, timeoutMs);
    qrWaiters.push(waiter);
  });
}
function publishQr(qr) {
  latestQr = qr;
  const waiters = qrWaiters;
  qrWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(qr);
  }
}
function clearQr() { latestQr = null; }

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
function isOwner(jid) {
  const n = senderNumber(jid);
  return OWNER_NUMBERS.includes(n);
}
function isGroup(jid = "") { return jid.endsWith("@g.us"); }
function getText(msg) {
  const m = msg.message || {};
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    "";
}
async function startBot() {
  pairingReady = false;
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || "silent" }),
    printQRInTerminal: false,
    browser: ["MS1 GROUP BOT", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    if (connection || qr || lastDisconnect) {
      console.log("WA state=" + (connection || "connecting") +
        " code=" + (statusCode || "-") +
        " qr=" + Boolean(qr) +
        " error=" + String(lastDisconnect?.error?.message || "-").slice(0, 140));
    }
    if (qr) { markPairingReady(); publishQr(qr); }
    if (connection === "open" || connection === "close") { pairingReady = false; clearQr(); }
    if (qr && !process.env.TELEGRAM_BOT_TOKEN) {
      console.log("\nScan this QR from WhatsApp > Linked devices:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      restarting = false;
      console.log("MS1 GROUP BOT connected.");
    }
    if (connection === "close" && !restarting) {
      if (statusCode === DisconnectReason.loggedOut) {
        restarting = true;
        console.log("WhatsApp logged out; clearing stale session and restarting for a new pairing.");
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR, { recursive: true });
        } catch (e) {
          console.error("Could not reset WhatsApp session:", e.message);
        }
        setTimeout(() => startBot().catch(err => {
          restarting = false;
          console.error("WhatsApp restart failed:", err);
        }), 1500);
      } else {
        console.log("WhatsApp connection closed; reconnecting...");
        setTimeout(() => startBot().catch(err => console.error("WhatsApp reconnect failed:", err)), 3000);
      }
    }
  });

  sock.ev.on("group-participants.update", async (event) => {
    if (!groupSettings(event.id).welcome) return;
    for (const participant of event.participants || []) {
      if (event.action === "add") {
        const welcomeText = `📢✨ *A WARM WELCOME!* ✨📢

🌟 Welcome to our group, @${senderNumber(participant)}! 🌟 ❤️🤝

We're happy to have you here! 😊🔥
Stay connected, respect everyone, share positive vibes, and help make this group amazing.

💬 *Your presence matters. Let's make great memories together!* 💯❤️

━━━━━━━━━━━━━━
💖 *BEST WISHES FROM MS1 GROUP!* 💖
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

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const chat = msg.key.remoteJid;
      if (!chat || chat === "status@broadcast") continue;
      const sender = msg.key.fromMe
        ? (sock.user?.id || msg.key.participant || msg.key.participantAlt || chat)
        : (msg.key.participant || msg.key.participantAlt || msg.participant || chat);
      const text = getText(msg).trim();
      if (isGroup(chat)) {
        console.log("[TOPCHAT] message", JSON.stringify({ type, fromMe: Boolean(msg.key.fromMe), chat, participant: msg.key.participant || null, participantAlt: msg.key.participantAlt || null, pushName: msg.pushName || null }));
        recordGroupMessage(chat, sender, msg.pushName || senderNumber(sender));
      }
      if (!text) continue;

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
          await sock.sendMessage(chat, {
            text: "🥰 എന്താ വിശേഷം, സുഖമല്ലേ? 💖 ഞാൻ ഇവിടെത്തന്നെയുണ്ട് ട്ടോ! 😊✨ പറയൂ, എന്താണ് വിശേഷങ്ങൾ? 💬💕"
          }, { quoted: msg }).catch(() => {});
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
            continue;
          }
        }
        if (settings.antilink && /https?:\/\/|www\.|chat\.whatsapp\.com\//i.test(text)) {
          const meta = await sock.groupMetadata(chat).catch(() => null);
          const senderAdmin = meta?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
          if (!senderAdmin && !isOwner(sender)) {
            const botAdmin = meta?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sock.user.id) && (p.admin === "admin" || p.admin === "superadmin"));
            if (botAdmin) await sock.sendMessage(chat, { delete: msg.key }).catch(() => {});
            await sock.sendMessage(chat, { text: "🔗 Links are not allowed in this group." }).catch(() => {});
            continue;
          }
        }
      }

      const reply = (body) => sock.sendMessage(chat, { text: body }, { quoted: msg });
      const command = text.startsWith(PREFIX)
        ? text.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase() : "";
      const args = command ? text.slice(PREFIX.length).trim().split(/\s+/).slice(1) : [];
      // Statistics commands are available to group members; other commands remain owner-only.
      if (command && !isOwner(sender) && !["topchat", "mystats", "antilink"].includes(command)) {
        await reply("🔒 ഈ കമാൻഡ് ഉപയോഗിക്കാൻ ബോട്ട് ഓണർക്ക് മാത്രം അനുവാദമുണ്ട്.");
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
`╭─「 MS1 GROUP BOT 」
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
│ ${PREFIX}antispam on|off (admins)
│ ${PREFIX}welcome on|off (admins)
│ ${PREFIX}rules [text] (admins)
│ ${PREFIX}ping / ${PREFIX}alive / ${PREFIX}owner
╰ Settings reset when the bot restarts`
        );
      } else if (command === "ping") {
        await reply("Pong! 🟢 MS1 GROUP BOT is online.");
      } else if (command === "alive") {
        await reply("🟢 MS1 GROUP BOT is running.");
      } else if (command === "owner") {
        await reply(OWNER_NUMBERS.length ? `Owner: ${OWNER_NUMBERS.map(n => "+" + n).join(", ")}` : "Owner number is not configured yet.");
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
      } else if (["antilink", "antispam", "welcome"].includes(command) && isGroup(chat)) {
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
    }
  });
}
// DormHost expects an HTTP listener on PORT. These endpoints are health checks only.
const PORT = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("MS1 GROUP BOT is running\n");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});
server.listen(PORT, "0.0.0.0", () => console.log(`Health server listening on 0.0.0.0:${PORT}`));

startTelegram(() => sock, () => pairingReady, waitForPairingReady, () => latestQr, waitForQr);
startBot().catch(err => { console.error("Bot failed to start:", err); process.exit(1); });
