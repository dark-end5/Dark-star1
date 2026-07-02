'use strict';

const readline = require('readline');
const fs       = require('fs-extra');
const path     = require('path');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const P      = require('pino');
const chalk  = require('chalk');
const moment = require('moment-timezone');
const axios  = require('axios');

const cfg    = require('./config');
const store  = require('./database/store');

const menu         = require('./lib/menu');
const handleDl     = require('./lib/download');
const handleFun    = require('./lib/fun');
const gamesHandler = require('./lib/games');
const groupHandler = require('./lib/group');
const ownerHandler = require('./lib/owner');
const toolsHandler = require('./lib/tools');

const SESSION_DIR = path.join(__dirname, 'session');
const msgCache    = new Map();

// ─── Banner ───────────────────────────────────────────────────────────────────
function showBanner() {
  console.clear();
  console.log(chalk.cyan('╔══════════════════════════════════╗'));
  console.log(chalk.cyan('║       DARK-STAR1 BOT  ⭐          ║'));
  console.log(chalk.cyan('║    WhatsApp Automation Bot       ║'));
  console.log(chalk.cyan('╚══════════════════════════════════╝\n'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatPhoneNumber(raw) {
  return raw.replace(/[^0-9]/g, '').trim();
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(query, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// ─── SESSION_ID restoration ───────────────────────────────────────────────────
// Users obtain a SESSION_ID from the pairing web app at:
//   cfg.pairingServer  (e.g. https://khanxmd-pair.onrender.com)
// The ID is a base64-encoded JSON credential blob.  When provided,
// write it into the session/ folder so Baileys loads it automatically
// and no pairing code prompt is needed.
async function restoreSessionFromId(sessionId) {
  if (!sessionId || sessionId.trim() === '') return false;
  try {
    await fs.ensureDir(SESSION_DIR);
    const credsPath = path.join(SESSION_DIR, 'creds.json');

    // Already restored — skip
    if (await fs.pathExists(credsPath)) {
      console.log(chalk.cyan('ℹ️  Session folder already exists — skipping SESSION_ID restore.'));
      return true;
    }

    // Strip optional prefix (some bots use "Dark-star1;base64...")
    const raw     = sessionId.includes(';') ? sessionId.split(';').slice(1).join(';') : sessionId;
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const creds   = JSON.parse(decoded);
    await fs.writeJSON(credsPath, creds, { spaces: 2 });
    console.log(chalk.green('✅ Session restored from SESSION_ID — skipping pairing code.'));
    return true;
  } catch {
    console.log(chalk.yellow('⚠️  SESSION_ID provided but could not be decoded. Falling back to pairing code.'));
    return false;
  }
}

// ─── Pairing code request with retries ────────────────────────────────────────
async function requestPairingCodeWithRetry(sock, phoneNumber, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(chalk.yellow(`\n⏳ Requesting pairing code (attempt ${attempt}/${maxAttempts})...`));
      await sleep(3000);
      const code = await sock.requestPairingCode(phoneNumber);
      return code;
    } catch (err) {
      console.log(chalk.red(`❌ Attempt ${attempt} failed: ${err.message}`));
      if (attempt < maxAttempts) {
        const wait = attempt * 4000;
        console.log(chalk.yellow(`⏳ Retrying in ${wait / 1000}s...`));
        await sleep(wait);
      }
    }
  }
  return null;
}

function printPairingCode(code) {
  const padded = code.padEnd(12, ' ');
  console.log(chalk.green('\n╔══════════════════════════════════╗'));
  console.log(chalk.green(`║   🔑 PAIRING CODE: ${padded}  ║`));
  console.log(chalk.green('╚══════════════════════════════════╝'));
  console.log(chalk.cyan('\n📱 Steps to link:'));
  console.log(chalk.white('  1. Open WhatsApp on your phone'));
  console.log(chalk.white('  2. Tap the 3 dots menu → Linked Devices'));
  console.log(chalk.white('  3. Tap "Link a Device"'));
  console.log(chalk.white('  4. Choose "Link with Phone Number"'));
  console.log(chalk.white(`  5. Enter the code: ${chalk.bold.green(code)}\n`));
  console.log(chalk.dim(`💡 Tip: To avoid entering a code on every restart, use a SESSION_ID.`));
  console.log(chalk.dim(`   Get one at: ${cfg.pairingServer}\n`));
}

// ─── Middleware helpers ────────────────────────────────────────────────────────
function isOwner(sender) {
  const num    = sender.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
  const owners = store.getSetting('owners', [formatPhoneNumber(cfg.ownerNumber)]);
  return owners.includes(num) || num === formatPhoneNumber(cfg.ownerNumber);
}

async function handleAI(sock, msg, body, from) {
  if (!store.getSetting('aimode', false)) return false;
  if (body.startsWith(cfg.prefix)) return false;
  if (msg.key.fromMe) return false;
  try {
    const res = await axios.get(
      `https://api.popcat.xyz/chatbot?msg=${encodeURIComponent(body)}&owner=DarkStar1`,
      { timeout: 8000 }
    );
    if (res.data?.response) {
      await sock.sendMessage(from, { text: `🤖 ${res.data.response}` }, { quoted: msg });
      return true;
    }
  } catch {}
  return false;
}

async function handleViewOnce(sock, msg) {
  if (!store.getSetting('antiviewonce', false)) return;
  const vo = msg.message?.viewOnceMessage?.message || msg.message?.viewOnceMessageV2?.message;
  if (!vo) return;
  const from   = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const imgMsg = vo.imageMessage;
  const vidMsg = vo.videoMessage;
  if (!imgMsg && !vidMsg) return;
  try {
    const buffer  = await downloadMediaMessage({ message: vo, key: msg.key }, 'buffer', {});
    const caption = `👁️ *Anti-ViewOnce* — Sent by @${sender.split('@')[0]}`;
    if (imgMsg) {
      await sock.sendMessage(from, { image: buffer, caption }, { mentions: [sender] });
    } else {
      await sock.sendMessage(from, { video: buffer, caption }, { mentions: [sender] });
    }
  } catch {}
}

async function handleAutoSeeStatus(sock, msg) {
  if (!store.getSetting('autosee', false)) return;
  if (msg.key.remoteJid !== 'status@broadcast') return;
  try {
    await sock.readMessages([msg.key]);
    await sock.sendMessage(msg.key.remoteJid, { react: { text: '❤️', key: msg.key } });
  } catch {}
}

async function handleAutoStatus(sock) {
  if (!store.getSetting('autostatus', false)) return;
  const now        = moment().tz(cfg.timeZone || 'Africa/Nairobi');
  const statusText = `${cfg.autobioText}\n🕐 ${now.format('HH:mm')} | ${now.format('ddd, D MMM')}`;
  try { await sock.sendMessage('status@broadcast', { text: statusText }); } catch {}
}

// ─── Main bot ─────────────────────────────────────────────────────────────────
async function startBot() {
  showBanner();

  // Attempt to restore session from SESSION_ID env var
  const envSessionId = process.env.SESSION_ID || cfg.sessionId || '';
  const sessionRestored = await restoreSessionFromId(envSessionId);

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:                          state,
    printQRInTerminal:             false,
    logger:                        P({ level: 'silent' }),
    browser:                       ['Dark-Star1', 'Chrome', '114.0.0'],
    generateHighQualityLinkPreview: true,
    syncFullHistory:               false,
    connectTimeoutMs:              60_000,
    keepAliveIntervalMs:           15_000,
    retryRequestDelayMs:           500,
    maxMsgRetryCount:              5,
    markOnlineOnConnect:           true,
  });

  // Only request pairing code if not already registered and no SESSION_ID was loaded
  if (!state.creds.registered && !sessionRestored) {
    let phoneNumber = formatPhoneNumber(cfg.ownerNumber);

    console.log(chalk.yellow(`\n📲 Bot not yet linked to any WhatsApp account.`));
    console.log(chalk.white(`   Default number from config: ${chalk.bold(phoneNumber)}`));
    console.log(chalk.dim(`   Or get a SESSION_ID at: ${cfg.pairingServer}\n`));

    try {
      const answer = await Promise.race([
        askQuestion(chalk.cyan(`Enter phone number with country code (or press Enter to use ${phoneNumber}): `)),
        sleep(15000).then(() => ''),
      ]);
      if (answer) phoneNumber = formatPhoneNumber(answer);
    } catch {}

    if (!phoneNumber || phoneNumber.length < 7) {
      console.log(chalk.red('❌ Invalid phone number. Set OWNER_NUMBER in config/env and restart.'));
      process.exit(1);
    }

    console.log(chalk.cyan(`\n📱 Linking to number: ${chalk.bold(phoneNumber)}`));
    const code = await requestPairingCodeWithRetry(sock, phoneNumber);

    if (code) {
      printPairingCode(code);
    } else {
      console.log(chalk.red('\n❌ Could not obtain a pairing code after all attempts.'));
      console.log(chalk.yellow('💡 Fixes:'));
      console.log(chalk.white(`   • Use a SESSION_ID from: ${cfg.pairingServer}`));
      console.log(chalk.white('   • Check your number includes country code (e.g. 254712345678)'));
      console.log(chalk.white('   • Delete the session/ folder and restart: rm -rf session && node index.js'));
      console.log(chalk.white('   • Wait 60s and try again (WhatsApp rate-limits pairing requests)'));
    }
  }

  // ─── Connection events ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(chalk.yellow('⚠️  QR appeared — this bot uses pairing codes, not QR.'));
      console.log(chalk.yellow('   Restart and enter your phone number, or use a SESSION_ID.'));
    }

    if (connection === 'connecting') {
      console.log(chalk.yellow('🔄 Connecting to WhatsApp...'));
    }

    if (connection === 'open') {
      console.log(chalk.green('✅ WhatsApp connected successfully!'));
      console.log(chalk.cyan(`🤖 Logged in as: ${sock.user?.id?.split(':')[0] || 'unknown'}`));
      try { await ownerHandler.startAutobio(sock, cfg); } catch {}
      setInterval(() => handleAutoStatus(sock), 2 * 60 * 60 * 1000);
      console.log(chalk.cyan('🚀 Dark-Star1 Bot is fully ready — all features active!'));
    }

    if (connection === 'close') {
      const statusCode  = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.log(chalk.red('\n🔒 Bot was logged out from WhatsApp.'));
        console.log(chalk.yellow('   Delete session folder and restart:'));
        console.log(chalk.white('   rm -rf session && node index.js'));
        process.exit(1);
      } else {
        console.log(chalk.yellow(`⚠️  Connection closed (code: ${statusCode}). Reconnecting in 5s...`));
        await sleep(5000);
        startBot();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Group participant events ───────────────────────────────────────────────
  sock.ev.on('group-participants.update', async (update) => {
    try { await groupHandler.handleParticipants(sock, update); } catch {}
  });

  // ─── Anti-delete ────────────────────────────────────────────────────────────
  sock.ev.on('messages.delete', async (item) => {
    if (!store.getSetting('antidelete', false)) return;
    const keys = item.keys || [];
    for (const key of keys) {
      const cached = msgCache.get(key.id);
      if (!cached) continue;
      const { msg: oldMsg, from: oldFrom, sender } = cached;
      try {
        const body = oldMsg.message?.conversation || oldMsg.message?.extendedTextMessage?.text || '';
        if (body) {
          await sock.sendMessage(oldFrom, {
            text: `🗑️ *Deleted Message by @${sender.split('@')[0]}:*\n\n${body}`,
            mentions: [sender]
          });
        }
      } catch {}
    }
  });

  // ─── Messages ──────────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe && !msg.key.remoteJid?.endsWith('@s.whatsapp.net')) continue;

      const from    = msg.key.remoteJid;
      const sender  = msg.key.participant || msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const body    = msg.message?.conversation
                   || msg.message?.extendedTextMessage?.text
                   || msg.message?.imageMessage?.caption
                   || msg.message?.videoMessage?.caption
                   || '';

      // Cache for anti-delete
      if (msg.key.id) {
        msgCache.set(msg.key.id, { msg, from, sender });
        if (msgCache.size > 500) msgCache.delete(msgCache.keys().next().value);
      }

      try { await handleAutoSeeStatus(sock, msg); } catch {}
      try { await handleViewOnce(sock, msg); } catch {}

      // Auto-typing / auto-recording presence
      if (!msg.key.fromMe && body && store.getSetting('autotyping', false)) {
        try { await sock.sendPresenceUpdate('composing', from); } catch {}
        setTimeout(async () => { try { await sock.sendPresenceUpdate('paused', from); } catch {} }, 2000);
      }
      if (!msg.key.fromMe && body && store.getSetting('autorecording', false)) {
        try { await sock.sendPresenceUpdate('recording', from); } catch {}
        setTimeout(async () => { try { await sock.sendPresenceUpdate('paused', from); } catch {} }, 2000);
      }

      // Group-specific events
      if (isGroup && !msg.key.fromMe) {
        try { await groupHandler.handleGroupEvents(sock, msg, isGroup); } catch {}
      }

      // First-DM greeting
      if (!isGroup && !msg.key.fromMe && body) {
        const senderNum  = sender.replace('@s.whatsapp.net', '');
        const hasGreeted = store.getUser(senderNum, 'greeted', false);
        if (!hasGreeted) {
          store.setUser(senderNum, 'greeted', true);
          try { await sock.sendMessage(from, { text: cfg.followUpMsg }); } catch {}
        }
      }

      // Bot mode filter
      const botMode = store.getSetting('botmode', cfg.mode || 'public');
      if (botMode === 'private' && isGroup) continue;
      if (botMode === 'group'   && !isGroup) continue;

      // Non-command messages: games → AI
      if (!msg.key.fromMe && body && !body.startsWith(cfg.prefix)) {
        try {
          const answered = await gamesHandler.checkGameAnswer(sock, msg, body);
          if (answered) continue;
        } catch {}
        try { await handleAI(sock, msg, body, from); } catch {}
        continue;
      }

      if (!body.startsWith(cfg.prefix)) continue;

      // ── Parse command ────────────────────────────────────────────────────────
      const command    = body.slice(cfg.prefix.length).trim().split(' ')[0].toLowerCase();
      const args       = body.slice(cfg.prefix.length).trim().split(' ').slice(1);
      const ownerCheck = isOwner(sender);

      let isAdmin    = false;
      let isBotAdmin = false;
      if (isGroup) {
        try {
          const meta  = await sock.groupMetadata(from);
          const admins = meta.participants.filter(p => p.admin).map(p => p.id);
          isAdmin    = admins.includes(sender);
          isBotAdmin = admins.some(id => id.includes(sock.user?.id?.split(':')[0]));
        } catch {}
      }

      // ── Dispatch ─────────────────────────────────────────────────────────────
      try {
        if (command === 'menu') { await menu(sock, from, cfg.prefix); continue; }
        if (await ownerHandler(sock, msg, command, args, ownerCheck))               continue;
        if (await groupHandler(sock, msg, command, args, isGroup, isAdmin, isBotAdmin)) continue;
        if (await handleDl(sock, msg, command, args))                               continue;
        if (await toolsHandler(sock, msg, command, args))                           continue;
        if (await gamesHandler(sock, msg, command, args))                           continue;
        if (await handleFun(sock, msg, command, args))                              continue;

        await sock.sendMessage(from, {
          text: `❓ Unknown command: *${cfg.prefix}${command}*\nSend *${cfg.prefix}menu* to see all commands.`
        }, { quoted: msg });

      } catch (err) {
        console.error(chalk.red(`[CMD ERROR] ${command}: ${err.message}`));
        try { await sock.sendMessage(from, { text: `❌ Error: ${err.message}` }, { quoted: msg }); } catch {}
      }
    }
  });
}

process.on('uncaughtException',  err => { if (err) console.error(chalk.red('[UNCAUGHT]'),     err.message); });
process.on('unhandledRejection', err => { if (err) console.error(chalk.red('[UNHANDLED]'),    err?.message || err); });

startBot();
