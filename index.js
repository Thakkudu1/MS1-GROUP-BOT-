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
const SESSION_DIR = process.env.SESSION_DIR || (process.env.PORT ? "/data/session" : "./session");
fs.mkdirSync(SESSION_DIR, { recursive: true });
let sock;
let restarting = false;

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
    if (qr && !process.env.TELEGRAM_BOT_TOKEN) {
      console.log("\nScan this QR from WhatsApp > Linked devices:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      restarting = false;
      console.log("MS1 GROUP BOT connected.");
    }
    if (connection === "close" && !restarting) {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
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

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const chat = msg.key.remoteJid;
      if (!chat || chat === "status@broadcast") continue;
      const sender = msg.key.participant || chat;
      const text = getText(msg).trim();
      if (!text) continue;

      const reply = (body) => sock.sendMessage(chat, { text: body }, { quoted: msg });
      const command = text.startsWith(PREFIX)
        ? text.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase() : "";
      const args = command ? text.slice(PREFIX.length).trim().split(/\s+/).slice(1) : [];

      if (command === "menu" || command === "help") {
        await reply(
`╭─「 MS1 GROUP BOT 」
│ Prefix: ${PREFIX}
│ ${PREFIX}menu / ${PREFIX}help
│ ${PREFIX}ping
│ ${PREFIX}alive
│ ${PREFIX}tagall (group admins)
│ ${PREFIX}warn @user (group admins)
│ ${PREFIX}warnings (group admins)
│ ${PREFIX}owner
╰ No forced channel join`
        );
      } else if (command === "ping") {
        await reply("Pong! 🟢 MS1 GROUP BOT is online.");
      } else if (command === "alive") {
        await reply("🟢 MS1 GROUP BOT is running.");
      } else if (command === "owner") {
        await reply(OWNER_NUMBERS.length ? `Owner: ${OWNER_NUMBERS.map(n => "+" + n).join(", ")}` : "Owner number is not configured yet.");
      } else if (command === "tagall" && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        if (!metadata) { await reply("Could not read group information."); continue; }
        const botJid = jidNormalizedUser(sock.user.id);
        const botIsAdmin = metadata.participants.some(p => jidNormalizedUser(p.id) === botJid && (p.admin === "admin" || p.admin === "superadmin"));
        const senderIsAdmin = metadata.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!botIsAdmin) { await reply("Please make the bot an admin to use group mention features."); continue; }
        if (!senderIsAdmin && !isOwner(sender)) { await reply("Only group admins can use this command."); continue; }
        const mentions = metadata.participants.map(p => p.id);
        const body = args.join(" ") || "Attention everyone!";
        await sock.sendMessage(chat, { text: `📢 ${body}\n\n` + mentions.map(j => "@" + senderNumber(j)).join(" "), mentions }, { quoted: msg });
      } else if (command === "warn" && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        const senderIsAdmin = metadata?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!senderIsAdmin && !isOwner(sender)) { await reply("Only group admins can warn members."); continue; }
        const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!target) { await reply(`Mention a member: ${PREFIX}warn @member`); continue; }
        const key = `${chat}:${target}`;
        const count = (WARNINGS.get(key) || 0) + 1;
        WARNINGS.set(key, count);
        await reply(`⚠️ @${senderNumber(target)} warning ${count}/${WARN_LIMIT}.` + (count >= WARN_LIMIT ? "\nWarning limit reached. An admin should review this member." : ""));
      } else if (command === "warnings" && isGroup(chat)) {
        const metadata = await sock.groupMetadata(chat).catch(() => null);
        const senderIsAdmin = metadata?.participants.some(p => jidNormalizedUser(p.id) === jidNormalizedUser(sender) && (p.admin === "admin" || p.admin === "superadmin"));
        if (!senderIsAdmin && !isOwner(sender)) { await reply("Only group admins can check warnings."); continue; }
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

startTelegram(() => sock);
startBot().catch(err => { console.error("Bot failed to start:", err); process.exit(1); });
