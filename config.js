'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Dark-Star1 Config
// Edit values below or override with environment variables.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // ── Bot identity ─────────────────────────────────────────────────────────
  botName:       process.env.BOT_NAME      || 'Dark-Star1 ⭐',
  ownerNumber:   process.env.OWNER_NUMBER  || '923427582273',   // With country code, no +
  ownerName:     process.env.OWNER_NAME    || 'Owner',
  prefix:        process.env.PREFIX        || '.',

  // ── Session / pairing ────────────────────────────────────────────────────
  // Option A: paste your SESSION_ID here (or set the env var SESSION_ID)
  //           Get one from the pairing server URL below.
  sessionId:     process.env.SESSION_ID    || '',

  // Option B: pairing server web URL shown to users as a hint
  pairingServer: process.env.PAIRING_SERVER || 'https://khanxmd-pair.onrender.com',

  // ── Behaviour ────────────────────────────────────────────────────────────
  mode:          process.env.MODE          || 'public',  // public | group | private
  timeZone:      process.env.TIME_ZONE     || 'Africa/Nairobi',

  // ── Auto-bio ─────────────────────────────────────────────────────────────
  autobioText:     process.env.AUTO_BIO_QUOTE || 'Dark-Star1 ⭐ Online',
  autobioInterval: 20_000,

  // ── Follow-up DM ─────────────────────────────────────────────────────────
  followUpMsg: `👋 Hey! I'm *Dark-Star1* ⭐\nSend *${process.env.PREFIX || '.'}menu* to see all commands!`,

  // ── Group moderation ─────────────────────────────────────────────────────
  badWords: (process.env.BAD_WORDS || 'fuck,shit,bitch,asshole,bastard,cunt,dick,pussy').split(',').map(w => w.trim()),

  // ── Fun ──────────────────────────────────────────────────────────────────
  emojis: ['❤️', '😂', '🔥', '👍', '😍', '🎉', '💯', '✨', '🙏', '😎', '🤣', '😊', '👏', '🥰', '💪'],
};
