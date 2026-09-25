/* ==========================================================================
   pumpbubble.fun — the Telegram buybot

   A token community adds the bot to its group, an admin pastes the contract
   address, and from then on every buy is posted into the group — the format
   every community already knows from Bobby, Cherry and Major, with the group's
   own picture on it. The bot is the distribution: each alert is seen by every
   member, carries the site's name, and puts the Boost button one tap from the
   people who actually buy boosts.

   Three rules, in order of how expensive they were to learn elsewhere:

   1. **Nobody is messaged who did not ask.** A user is stored only after they
      press /start *and* pick something on the opt-in keyboard; a group is
      stored only after one of its admins ran /setup. There is no list of
      "everyone the bot has seen", because a bot that messages people who did
      not ask gets blocked, a blocked bot gets restricted by Telegram, and a
      restricted bot stops posting buys in every group at once.
   2. **Every string a token controls is escaped before it reaches a caption.**
      Ticker, name, website — all typed by whoever minted the coin. The caption
      is HTML.
   3. **Zero KV writes per buy.** The free tier allows a thousand writes a day
      and a busy token does that many buys before lunch. Config is written at
      setup and read (cached) at alert time; a buy touches nothing.

   Buys arrive from a Helius webhook (src/helius.mjs) and are read off the
   transaction's balances (src/solbuy.mjs). Solana only for now — that is where
   the groups are, and it is the one chain with a webhook we can register
   without running a server.
   ========================================================================== */

import { resolveAnyToken, isCA, isMint, clean, PUMP } from './core.mjs';
import { buyUrl } from './refs.mjs';
import { buysFromPayload } from './solbuy.mjs';
import { syncWebhook, webhookInfo, KEY as HELIUS_KEY } from './helius.mjs';
import { TTLS, KICK_S } from './guard.mjs';

export const SITE = 'https://pumpbubble.fun';
const DEXS = 'https://api.dexscreener.com';

export const enabled = (env = {}) => !!env.TG_BOT_TOKEN;
const site = (env = {}) => String(env.PUBLIC_ORIGIN || SITE).replace(/\/+$/, '');

/* KV layout. Indexes are kept as plain arrays because the store has no prefix
   listing, and none of these grows past what one JSON value carries. */
const K = {
  group: id => 'tg:group:' + id,        // one group's config
  groups: 'tg:groups',                  // [chatId] — every configured group
  mint: m => 'tg:mint:' + m,            // [chatId] — who wants alerts for this mint
  mints: 'tg:mints',                    // [{mint, pool}] — what Helius watches
  user: id => 'tg:user:' + id,          // one opted-in user
  users: 'tg:users',                    // [userId] — everyone opted in
  me: 'tg:me',                          // cached getMe
};

const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ================================================================ Telegram */

export async function tg(env, method, body) {
  const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  let j = null;
  try { j = await r.json(); } catch { /* fall through */ }
  if (!j || !j.ok) {
    const e = new Error('tg ' + method + ': ' + (j && j.description || r.status));
    e.code = j && j.error_code;
    e.description = (j && j.description) || '';
    throw e;
  }
  return j.result;
}

/* Telegram echoes this back on every webhook delivery, so a POST that does not
   carry it is not from Telegram. Derived from the token: nothing to store. */
export async function webhookSecret(env) {
  const buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(String(env.TG_BOT_TOKEN) + ':pumpbubble:tg-webhook'));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

/* Escape for Telegram's HTML parse mode. Three characters, no more — Telegram
   rejects a caption with an unknown entity, so over-escaping is its own bug. */
export const tgEsc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* A link is only a link if it is http(s). A token's "website" field is typed
   by the minter; `javascript:` has been tried. */
const okUrl = u => typeof u === 'string' && /^https?:\/\/[^\s"'<>]{4,300}$/i.test(u) ? u : '';
const attr = u => okUrl(u).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

let meMem = { at: 0, v: null };
export async function me(env, store) {
  const now = Date.now();
  if (meMem.v && now - meMem.at < 3_600_000) return meMem.v;
  try {
    const saved = await store.get(K.me);
    if (saved && saved.username && now - (saved.at || 0) < 86_400_000) {
      meMem = { at: now, v: saved }; return saved;
    }
  } catch {}
  const r = await tg(env, 'getMe');
  const v = { username: r.username || '', id: r.id, at: now };
  meMem = { at: now, v };
  try { await store.put(K.me, v); } catch {}
  return v;
}

/* Called from cron. Points Telegram at /tg/webhook if it is not already, so
   setting TG_BOT_TOKEN is the whole of turning the bot on. */
let ensuredAt = 0;
export async function ensureWebhook(env, store) {
  if (!enabled(env)) return { enabled: false };
  if (Date.now() - ensuredAt < 3_600_000) return { enabled: true, checked: false };
  ensuredAt = Date.now();
  const want = site(env) + '/tg/webhook';
  const info = await tg(env, 'getWebhookInfo');
  let out;
  /* chat_member carries joins in groups that hide the join message; it is
     only delivered when asked for by name, so an older registration without
     it is redone */
  const upd = ['message', 'my_chat_member', 'chat_member', 'callback_query'];
  const have = (info && info.allowed_updates) || [];
  if (info && info.url === want && upd.every(u => have.includes(u))) out = { enabled: true, ok: true, url: want, pending: info.pending_update_count };
  else {
    await tg(env, 'setWebhook', {
      url: want,
      secret_token: await webhookSecret(env),
      allowed_updates: upd,
    });
    out = { enabled: true, ok: true, url: want, set: true };
  }
  /* A group whose /setup could not register the buy feed (the first real one
     hit a wrong Helius host) has its mint tracked and no webhook. Heal it here,
     on the cron, instead of asking the group to run /setup again. */
  try {
    let saved = null;
    try { saved = await store.get(HELIUS_KEY); } catch {}
    const addrs = await watchAddresses(store);
    if (addrs.length && !(saved && saved.id)) out.helius = await syncWebhook(env, store, site(env), addrs);
  } catch (e) { out.helius = { ok: false, error: String(e && e.message || e) }; }
  return out;
}

/* ============================================================ formatting */

export function fmtUsd(n) {
  n = num(n);
  if (n <= 0) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* Token amounts: 11,453,237.88 for the big ones, sensible decimals below. */
export function fmtQty(n) {
  n = num(n);
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

export function fmtSol(n) {
  n = num(n);
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4);
}

/* One emoji per `step` dollars, plus one so the smallest buy still shows one.
   Capped, because a whale buy that renders as four hundred emoji is a wall,
   not a signal. */
export function emojiRow(usd, emoji = '🟢', step = 20) {
  const n = clamp(1 + Math.floor(num(usd) / Math.max(1, num(step) || 20)), 1, 30);
  return tgEsc(emoji).repeat(n);
}

/* The alert. HTML caption plus inline keyboard.

   Header emoji says what kind of buy it was — 🆕 a new holder, 🐋 four
   figures, 🟢 otherwise. Everything from the token is escaped; every link is
   validated. */
export function formatBuy({ buy, token, group, solUsd, botName, env = {}, test = false }) {
  const usd = num(buy.sol) * num(solUsd);
  const sym = clean(token.sym || group.sym || '?', 12);
  const hdr = usd >= 1000 ? '🐋' : buy.newHolder ? '🆕' : '🟢';
  const origin = site(env);
  const mint = token.mint || group.mint;

  const lines = [];
  lines.push(`${test ? '🧪 <b>TEST</b> · ' : ''}${hdr} | <b>${tgEsc(sym)} BUY!</b>`);
  if (botName) lines.push(`<i>by @${tgEsc(botName)}</i>`);
  lines.push('');
  lines.push(emojiRow(usd, group.emoji, group.step));
  lines.push('');
  lines.push(`🔷 <b>SOL</b> ${fmtSol(buy.sol)}${solUsd > 0 ? ` (${fmtUsd(usd)})` : ''}`);
  const sig = /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(String(buy.sig || '')) ? buy.sig : '';
  const tx = sig ? ` (<a href="https://solscan.io/tx/${sig}">Tx</a>)` : '';
  lines.push(`🪙 <b>${tgEsc(sym)}</b> ${fmtQty(buy.tokens)}${tx}`);
  const wallet = buy.buyer && isMint(buy.buyer)
    ? ` (<a href="https://solscan.io/account/${buy.buyer}">Wallet</a>)` : '';
  lines.push(`🔎 <b>Position:</b> ${buy.newHolder ? 'New Holder' : 'Holder'}${wallet}`);
  if (num(token.mcap) > 0) lines.push(`📈 <b>MCap:</b> ${fmtUsd(token.mcap)}`);

  const soc = [];
  const s = group.socials || {};
  if (okUrl(s.web)) soc.push(`<a href="${attr(s.web)}">Web</a>`);
  if (okUrl(s.x)) soc.push(`<a href="${attr(s.x)}">𝕏</a>`);
  if (okUrl(s.tg)) soc.push(`<a href="${attr(s.tg)}">TG</a>`);
  if (soc.length) lines.push(`📣 <b>Socials:</b> ${soc.join(' | ')}`);

  lines.push('');
  lines.push(`🫧 <a href="${origin}/s/${encodeURIComponent(mint)}">${tgEsc(sym)} on the bubble map</a>`);

  /* Chart goes to a chart. Bonding-curve tokens live on pump.fun; graduated
     ones have a DexScreener page. Buy goes through the referral when one is
     configured and to a plain Jupiter swap when not — a button that says Buy
     and does nothing is worse than no button. */
  const chart = token.grad === false
    ? 'https://pump.fun/coin/' + encodeURIComponent(mint)
    : 'https://dexscreener.com/solana/' + encodeURIComponent(mint);
  const buyLink = buyUrl(env, mint) || ('https://jup.ag/swap/SOL-' + encodeURIComponent(mint));
  const keyboard = {
    inline_keyboard: [
      [{ text: '📊 Chart', url: chart }, { text: '🫧 Bubble', url: origin + '/s/' + encodeURIComponent(mint) }],
      [{ text: '💲 Buy', url: buyLink }, { text: '⚡ Boost', url: origin + '/?boost=' + encodeURIComponent(mint) }],
    ],
  };
  return { caption: lines.join('\n'), keyboard };
}

/* ================================================================ config */

let groupMem = new Map();          // chatId -> {at, v}
export async function getGroup(store, chatId) {
  const hit = groupMem.get(chatId);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v = null;
  try { v = await store.get(K.group(chatId)); } catch {}
  groupMem.set(chatId, { at: Date.now(), v });
  return v;
}

async function putGroup(store, chatId, cfg) {
  await store.put(K.group(chatId), cfg);
  groupMem.set(chatId, { at: Date.now(), v: cfg });
  let ids = [];
  try { ids = (await store.get(K.groups)) || []; } catch {}
  if (!ids.includes(chatId)) { ids.push(chatId); await store.put(K.groups, ids); }
}

async function addTracking(store, mint, pool, chatId) {
  let chats = [];
  try { chats = (await store.get(K.mint(mint))) || []; } catch {}
  if (!chats.includes(chatId)) { chats.push(chatId); await store.put(K.mint(mint), chats); }
  let list = [];
  try { list = (await store.get(K.mints)) || []; } catch {}
  const row = list.find(r => r.mint === mint);
  if (!row) { list.push({ mint, pool: pool || '' }); await store.put(K.mints, list); }
  else if (pool && row.pool !== pool) { row.pool = pool; await store.put(K.mints, list); }
  mintsMem = { at: 0, v: null };
}

async function dropTracking(store, mint, chatId) {
  let chats = [];
  try { chats = (await store.get(K.mint(mint))) || []; } catch {}
  chats = chats.filter(c => c !== chatId);
  await store.put(K.mint(mint), chats.length ? chats : null);
  if (!chats.length) {
    let list = [];
    try { list = (await store.get(K.mints)) || []; } catch {}
    const next = list.filter(r => r.mint !== mint);
    if (next.length !== list.length) await store.put(K.mints, next);
  }
  mintsMem = { at: 0, v: null };
}

export async function removeGroup(store, chatId) {
  const g = await getGroup(store, chatId);
  if (g && g.mint) await dropTracking(store, g.mint, chatId);
  await store.put(K.group(chatId), null);
  groupMem.set(chatId, { at: Date.now(), v: null });
  let ids = [];
  try { ids = (await store.get(K.groups)) || []; } catch {}
  const next = ids.filter(id => id !== chatId);
  if (next.length !== ids.length) await store.put(K.groups, next);
}

let mintsMem = { at: 0, v: null };
export async function tracked(store) {
  if (mintsMem.v && Date.now() - mintsMem.at < 30_000) return mintsMem.v;
  let list = [];
  try { list = (await store.get(K.mints)) || []; } catch {}
  const v = { list, set: new Set(list.map(r => r.mint)) };
  mintsMem = { at: Date.now(), v };
  return v;
}

export async function watchAddresses(store) {
  const { list } = await tracked(store);
  const out = [];
  for (const r of list) { out.push(r.mint); if (r.pool) out.push(r.pool); }
  return out;
}

/* The pool and the socials. Some routers list only the pool in a swap's
   accounts, so the pool is watched alongside the mint; a bonding-curve token
   has no pool yet and the mint alone is in every one of its trades.

   **pump.fun's own record first.** The first /setup in a real group asked
   DexScreener only, DexScreener answered the Worker 429 (it does that to
   Cloudflare's shared egress — see CLAUDE.md), and a token that had graduated
   to PumpSwap was set up with no pool and announced as "bonding curve".
   pump.fun names the pool itself (`pump_swap_pool`) and the socials the
   creator entered, and it answers the Worker. DexScreener only fills gaps. */
async function poolAndSocials(mint) {
  let pool = '';
  const socials = {};
  try {
    const r = await fetch(PUMP + '/coins/' + encodeURIComponent(mint), {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000),
    });
    const c = r.ok ? await r.json() : null;
    if (c && c.complete) {
      const p = c.pump_swap_pool || c.pool_address || c.raydium_pool || '';
      if (isMint(p)) pool = p;
    }
    if (c) {
      const web = okUrl(c.website), x = okUrl(c.twitter), t = okUrl(c.telegram);
      if (web) socials.web = web;
      if (x) socials.x = x;
      if (t) socials.tg = t;
    }
  } catch { /* DexScreener below */ }
  if (pool && socials.x) return { pool, socials };
  const dex = await dexPoolAndSocials(mint);
  return { pool: pool || dex.pool, socials: { ...dex.socials, ...socials } };
}

async function dexPoolAndSocials(mint) {
  try {
    const r = await fetch(DEXS + '/latest/dex/tokens/' + encodeURIComponent(mint), {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000),
    });
    const j = await r.json();
    const pairs = ((j && j.pairs) || []).filter(p => p.chainId === 'solana')
      .sort((a, b) => num(b.liquidity && b.liquidity.usd) - num(a.liquidity && a.liquidity.usd));
    const p = pairs[0];
    if (!p) return { pool: '', socials: {} };
    const info = p.info || {};
    const socials = {};
    const web = (info.websites || []).map(w => okUrl(w && w.url)).find(Boolean);
    if (web) socials.web = web;
    for (const s of info.socials || []) {
      const u = okUrl(s && s.url);
      if (!u) continue;
      if (s.type === 'twitter' && !socials.x) socials.x = u;
      if (s.type === 'telegram' && !socials.tg) socials.tg = u;
    }
    return { pool: isMint(p.pairAddress) ? p.pairAddress : '', socials };
  } catch { return { pool: '', socials: {} }; }
}

/* ================================================================ updates */

const HELP = [
  '<b>pumpbubble buybot</b>',
  '',
  '/setup <code>&lt;contract address&gt;</code> — start posting buys for a token',
  '/media — send a photo, GIF or video with this as its caption to use it on buys',
  '/emoji 🟢 — the emoji that fills the buy bar',
  '/step 20 — dollars per emoji',
  '/minbuy 0 — hide buys under this many dollars',
  '/web, /x, /tg <code>&lt;url&gt;</code> — links under each buy',
  '/settings — buttons for all of the above, and 🛡 Guard: join captcha, welcome, clean joins',
  '/welcome <code>text</code> — the welcome message; {name}, {group}, {sym} fill in',
  '/test — post a sample alert',
  '/status — what this group is tracking',
  '/stop — stop posting here',
  '',
  'Admins only. Solana tokens for now.',
].join('\n');

const adminMem = new Map();       // chat:user -> {at, ok}
async function isAdmin(env, msg) {
  const chat = msg.chat, from = msg.from;
  /* An anonymous admin posts as the group itself. */
  if (msg.sender_chat && msg.sender_chat.id === chat.id) return true;
  if (!from) return false;
  const key = chat.id + ':' + from.id;
  const hit = adminMem.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.ok;
  let ok = false;
  try {
    const m = await tg(env, 'getChatMember', { chat_id: chat.id, user_id: from.id });
    ok = m && (m.status === 'creator' || m.status === 'administrator');
  } catch {}
  adminMem.set(key, { at: Date.now(), ok });
  return ok;
}

const say = (env, chatId, text, extra = {}) => tg(env, 'sendMessage', {
  chat_id: chatId, text, parse_mode: 'HTML',
  link_preview_options: { is_disabled: true }, ...extra,
}).catch(() => null);

/* Commands arrive as "/setup", "/setup@botname", or "/setup arg". */
export function command(text) {
  const m = String(text || '').match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

export async function handleUpdate(ctx, update) {
  const { env, store } = ctx;
  if (update.my_chat_member) return onMembership(ctx, update.my_chat_member);
  if (update.callback_query) return onCallback(ctx, update.callback_query);
  if (update.chat_member) return onChatMember(ctx, update.chat_member);
  const msg = update.message;
  if (!msg || !msg.chat) return;

  /* A group that became a supergroup gets a new id; carry the config over. */
  if (msg.migrate_to_chat_id) {
    const g = await getGroup(store, msg.chat.id);
    if (g) { await putGroup(store, msg.migrate_to_chat_id, { ...g, chatId: msg.migrate_to_chat_id }); await removeGroup(store, msg.chat.id); await addTracking(store, g.mint, g.pool, msg.migrate_to_chat_id); }
    return;
  }

  const type = msg.chat.type;
  if (type === 'private') return onPrivate(ctx, msg);
  if (type === 'group' || type === 'supergroup') return onGroup(ctx, msg);
}

async function onMembership(ctx, m) {
  const { env, store } = ctx;
  const status = m.new_chat_member && m.new_chat_member.status;
  const chat = m.chat;
  if (!chat || chat.type === 'private') return;
  if (status === 'left' || status === 'kicked') {
    await removeGroup(store, chat.id);
    await resync(ctx);
    return;
  }
  if (status === 'member' || status === 'administrator') {
    const old = m.old_chat_member && m.old_chat_member.status;
    if (old === 'left' || old === 'kicked' || !old) {
      await say(env, chat.id,
        '🫧 Hi! I post buys for your token, with your picture on each one.\n\n'
        + 'An admin can start with:\n<code>/setup &lt;contract address&gt;</code>\n\n/help for the rest.');
    }
  }
}

async function onGroup(ctx, msg) {
  const { env, store } = ctx;
  const chatId = msg.chat.id;
  if (msg.new_chat_members || msg.left_chat_member) return onJoinLeave(ctx, msg);
  const text = msg.text || msg.caption || '';
  const c = command(text);

  /* Media becomes the group's buy picture two ways: sent with "/media" as its
     caption, or sent as a reply to the bot's upload prompt (the ⚙️ menu's
     Upload button). Admins only, either way. */
  const hasMedia = !!(msg.photo || msg.animation || msg.video);
  const rt = msg.reply_to_message;
  const toPrompt = hasMedia && !c && rt && rt.from && rt.from.is_bot
    && String(rt.text || '').startsWith(MEDIA_PROMPT);
  if (hasMedia && ((c && c.cmd === 'media') || toPrompt)) {
    if (!await isAdmin(env, msg)) return;
    const bot = await me(env, store).catch(() => null);
    if (toPrompt && bot && bot.id && rt.from.id !== bot.id) return;
    const g = await getGroup(store, chatId);
    if (!g) return say(env, chatId, 'Run /setup first, then send the media.');
    await putGroup(store, chatId, { ...g, media: mediaOf(msg) });
    return say(env, chatId, '✅ Saved. Every buy will carry this.', settingsMarkup());
  }
  if (!c) return;

  const ADMIN_CMDS = new Set(['setup', 'emoji', 'step', 'minbuy', 'web', 'x', 'tg', 'stop', 'test', 'media', 'settings', 'welcome']);
  if (c.cmd === 'help' || c.cmd === 'start') return say(env, chatId, HELP);
  if (c.cmd === 'status') {
    const g = await getGroup(store, chatId);
    if (!g) return say(env, chatId, 'Not tracking anything here yet. /setup <code>&lt;contract address&gt;</code>');
    return say(env, chatId,
      `Tracking <b>${tgEsc(g.sym)}</b> on Solana\n<code>${tgEsc(g.mint)}</code>\n`
      + `emoji ${tgEsc(g.emoji)} · step $${num(g.step)} · min buy $${num(g.minBuy)} · media ${g.media ? g.media.kind : 'none'}`,
      settingsMarkup());
  }
  if (!ADMIN_CMDS.has(c.cmd)) return;
  if (!await isAdmin(env, msg)) return say(env, chatId, 'Admins only.');

  if (c.cmd === 'setup') {
    const addr = c.arg.split(/\s+/)[0] || '';
    if (!isCA(addr)) return say(env, chatId, 'Send the contract address after the command:\n<code>/setup &lt;address&gt;</code>');
    if (!isMint(addr)) return say(env, chatId, 'Buy alerts are Solana-only for now. Base and Robinhood Chain are next.');
    const t = await resolveAnyToken(addr, env.IMG_SECRET);
    if (!t) return say(env, chatId, 'No token found at that address.');
    if (t.chain && t.chain !== 'solana') return say(env, chatId, 'Buy alerts are Solana-only for now.');
    const { pool, socials } = await poolAndSocials(addr);
    const prev = await getGroup(store, chatId);
    if (prev && prev.mint && prev.mint !== addr) await dropTracking(store, prev.mint, chatId);
    /* Switching to a different token keeps the group's own choices (emoji,
       step, minimum, the guard) and drops what belonged to the old token —
       its links and its picture — or the new token's buys would link to the
       old one's X account. Re-running /setup on the same token keeps it all. */
    const same = !!(prev && prev.mint === addr);
    const cfg = {
      chatId, mint: addr, pool, chain: 'solana',
      sym: clean(t.sym, 12), name: clean(t.name, 48),
      socials: { ...(same && prev.socials || {}), ...socials },
      emoji: (prev && prev.emoji) || '🟢',
      step: (prev && prev.step) || 20,
      minBuy: (prev && prev.minBuy) || 0,
      media: (same && prev.media) || null,
      ...(prev && prev.guard ? { guard: prev.guard } : {}),
      by: msg.from && msg.from.id, at: Date.now(),
    };
    await putGroup(store, chatId, cfg);
    await addTracking(store, addr, pool, chatId);
    const sync = await resync(ctx);
    const warn = sync && sync.ok ? '' : `\n\n⚠️ Saved, but the buy feed could not be registered: ${tgEsc(sync && sync.error || 'unknown')}`;
    /* graduation comes from pump.fun's own flag, not from whether a pool
       lookup happened to answer */
    return say(env, chatId,
      `✅ Tracking <b>${tgEsc(cfg.sym)}</b> — ${tgEsc(cfg.name)}\n`
      + `MCap ${fmtUsd(t.mcap)} · ${t.grad === false ? 'bonding curve' : 'graduated'}\n\n`
      + 'Set the picture, emoji and minimum buy with the buttons below.' + warn,
      settingsMarkup());
  }

  const g = await getGroup(store, chatId);
  if (!g) return say(env, chatId, 'Run /setup <code>&lt;contract address&gt;</code> first.');

  if (c.cmd === 'stop') {
    await removeGroup(store, chatId);
    await resync(ctx);
    return say(env, chatId, 'Stopped — no more buy alerts here, and the guard is off. /setup <code>&lt;contract address&gt;</code> to start again.');
  }
  if (c.cmd === 'welcome') {
    /* Plain text: escaped when sent, so an admin cannot break the caption,
       and the placeholders are filled after escaping. Empty resets it. */
    const text = c.arg.slice(0, 600);
    const guard = { ttl: 5, ...(g.guard || {}), text, welcome: text ? true : !!(g.guard && g.guard.welcome) };
    await putGroup(store, chatId, { ...g, guard });
    return say(env, chatId, text
      ? '✅ Welcome message saved and switched on. It shows once someone new arrives, and replaces the one before.'
      : 'Welcome message reset to the default.', settingsMarkup());
  }
  if (c.cmd === 'settings') {
    const v = settingsView(g);
    return say(env, chatId, v.text, { reply_markup: { inline_keyboard: v.kb } });
  }
  if (c.cmd === 'media') {
    return say(env, chatId, 'Send a photo, GIF or video with <code>/media</code> as its caption — or use ⚙️ Settings → Media.', settingsMarkup());
  }
  if (c.cmd === 'emoji') {
    const e = (c.arg.split(/\s+/)[0] || '').slice(0, 16);
    if (!e || /[<>&\w]/.test(e)) return say(env, chatId, 'Send one emoji: <code>/emoji 🔥</code>');
    await putGroup(store, chatId, { ...g, emoji: e });
    return say(env, chatId, `Buy bar: ${tgEsc(e).repeat(5)}`);
  }
  if (c.cmd === 'step' || c.cmd === 'minbuy') {
    const v = Math.round(num(c.arg.replace(/[$,]/g, '')));
    if (c.cmd === 'step' && !(v >= 1 && v <= 100000)) return say(env, chatId, 'Dollars per emoji, 1–100000: <code>/step 20</code>');
    if (c.cmd === 'minbuy' && !(v >= 0 && v <= 1e7)) return say(env, chatId, 'Minimum buy in dollars: <code>/minbuy 50</code>');
    await putGroup(store, chatId, { ...g, [c.cmd === 'step' ? 'step' : 'minBuy']: v });
    return say(env, chatId, c.cmd === 'step' ? `One emoji per $${v}.` : (v ? `Hiding buys under $${v}.` : 'Showing every buy.'));
  }
  if (c.cmd === 'web' || c.cmd === 'x' || c.cmd === 'tg') {
    const u = okUrl(c.arg.split(/\s+/)[0] || '');
    const socials = { ...(g.socials || {}) };
    if (u) socials[c.cmd] = u; else delete socials[c.cmd];
    await putGroup(store, chatId, { ...g, socials });
    return say(env, chatId, u ? `Saved: ${tgEsc(u)}` : `Removed the ${c.cmd} link.`);
  }
  if (c.cmd === 'test') return sendTest(ctx, chatId, g);
}

async function sendTest(ctx, chatId, g) {
  const { env, store } = ctx;
  const t = await tokenInfo(env, g.mint);
  const solUsd = num(ctx.solUsd);
  const price = num(t && t.price);
  const buy = {
    sol: 0.5, tokens: price > 0 && solUsd > 0 ? (0.5 * solUsd) / price : 1_000_000,
    buyer: '', sig: '', newHolder: true,
  };
  const bot = await me(env, store).catch(() => ({ username: '' }));
  const { caption, keyboard } = formatBuy({ buy, token: t || g, group: g, solUsd, botName: bot.username, env, test: true });
  return sendAlert(env, store, chatId, g, caption, keyboard);
}

/* ============================================================== settings */
/* Everything the slash commands do, as buttons. The commands stay — some
   admins type faster than they tap — but a group should never need /help to
   set its buy bar up. One message, edited in place as the admin moves
   through it. Callback data is `cfg:<what>[:<value>]`, under Telegram's 64
   bytes; choices are indexes into the lists below, never free text. */

export const EMOJIS = ['🟢', '🔥', '🚀', '💎', '🐸', '🫧', '⚡', '💰', '🐶', '🌕', '🦍', '👑'];
export const MINBUYS = [0, 10, 25, 50, 100, 250, 500, 1000];
export const STEPS = [5, 10, 20, 50, 100, 250];
export const MEDIA_PROMPT = '🖼 Reply to this message with a photo, GIF or video';

const settingsMarkup = () => ({ reply_markup: { inline_keyboard: [[{ text: '⚙️ Settings', callback_data: 'cfg:main' }]] } });

function mediaOf(msg) {
  /* Photos come as a size ladder; the last is the largest. */
  return msg.animation ? { kind: 'animation', id: msg.animation.file_id }
    : msg.video ? { kind: 'video', id: msg.video.file_id }
    : { kind: 'photo', id: msg.photo[msg.photo.length - 1].file_id };
}

const back = [{ text: '« Back', callback_data: 'cfg:main' }];
const rows = (items, per) => items.reduce((a, x, i) => (i % per ? a[a.length - 1].push(x) : a.push([x]), a), []);

export function settingsView(g, page = 'main') {
  const sym = tgEsc(g.sym || '?');
  const step = num(g.step) || 20, minBuy = num(g.minBuy);
  const links = ['web', 'x', 'tg'].filter(k => g.socials && okUrl(g.socials[k]))
    .map(k => ({ web: 'Web', x: '𝕏', tg: 'TG' })[k]);
  if (page === 'emoji') return {
    text: `😀 <b>Buy bar emoji</b> for ${sym}\nNow: ${tgEsc(g.emoji || '🟢')}\n\nAny other: <code>/emoji 🦄</code>`,
    kb: [...rows(EMOJIS.map((e, i) => ({ text: (e === g.emoji ? '✅ ' : '') + e, callback_data: 'cfg:emoji:' + i })), 4), back],
  };
  if (page === 'min') return {
    text: `💵 <b>Minimum buy</b> for ${sym}\nBuys under this are not posted. Now: ${minBuy ? '$' + minBuy : 'every buy'}`,
    kb: [...rows(MINBUYS.map((v, i) => ({ text: (v === minBuy ? '✅ ' : '') + (v ? '$' + v : 'All'), callback_data: 'cfg:min:' + i })), 4), back],
  };
  if (page === 'step') return {
    text: `📊 <b>Dollars per emoji</b> for ${sym}\nA $100 buy at $20 shows ${tgEsc((g.emoji || '🟢').repeat(6))}. Now: $${step}`,
    kb: [...rows(STEPS.map((v, i) => ({ text: (v === step ? '✅ ' : '') + '$' + v, callback_data: 'cfg:step:' + i })), 3), back],
  };
  if (page === 'media') return {
    text: `🖼 <b>Buy media</b> for ${sym}\nNow: ${g.media ? g.media.kind : 'none'}\n\nTap Upload, then reply to my message with a photo, GIF or video.`,
    kb: [[{ text: '📤 Upload', callback_data: 'cfg:media:new' }],
         ...(g.media ? [[{ text: '🗑 Remove', callback_data: 'cfg:media:off' }]] : []), back],
  };
  if (page === 'links') return {
    text: `🔗 <b>Links under each buy</b> for ${sym}\nNow: ${links.join(' · ') || 'none'}\n\n`
      + 'Change with <code>/web url</code>, <code>/x url</code>, <code>/tg url</code> — the command alone removes one.',
    kb: [back],
  };
  if (page === 'guard') {
    const gd = g.guard || {}, ttl = TTLS.includes(+gd.ttl) ? +gd.ttl : 5;
    const on = v => v ? '✅ on' : '⬜ off';
    return {
      text: `🛡 <b>Guard</b> for this group\n\n`
        + `<b>Join captcha</b> ${on(gd.captcha)} — new members are muted until they tap the emoji I name; `
        + `${ttl} min to answer, then they are removed and can rejoin\n`
        + `<b>Welcome message</b> ${on(gd.welcome)} — the previous one is deleted when someone new arrives\n`
        + `<b>Clean joins</b> ${on(gd.clean)} — deletes the "joined" and "left" lines\n\n`
        + 'Your own welcome: <code>/welcome Hi {name}, welcome to {group}!</code>\n\n'
        + 'I need to be an admin with <b>Ban users</b> and <b>Delete messages</b>.',
      kb: [
        [{ text: (gd.captcha ? '✅' : '⬜') + ' Join captcha', callback_data: 'cfg:gcap' }],
        [{ text: (gd.welcome ? '✅' : '⬜') + ' Welcome message', callback_data: 'cfg:gwel' }],
        [{ text: (gd.clean ? '✅' : '⬜') + ' Clean joins', callback_data: 'cfg:gcln' }],
        TTLS.map((m, i) => ({ text: (m === ttl ? '✅ ' : '') + m + ' min', callback_data: 'cfg:gttl:' + i })),
        back,
      ],
    };
  }
  if (page === 'stop') return {
    text: `⏹ Stop posting ${sym} buys here?

This also switches the 🛡 Guard off. To track a different token instead, just send <code>/setup &lt;new contract address&gt;</code> — the guard and your emoji stay.`,
    kb: [[{ text: 'Yes, stop', callback_data: 'cfg:stop:yes' }, { text: 'Cancel', callback_data: 'cfg:main' }]],
  };
  return {
    text: `⚙️ <b>${sym}</b> buy alerts\n\n`
      + `Emoji ${tgEsc(g.emoji || '🟢')} · one per $${step}\n`
      + `Min buy ${minBuy ? '$' + minBuy : 'none — every buy'}\n`
      + `Media ${g.media ? g.media.kind : 'none'}\n`
      + `Links ${links.join(' · ') || 'none'}\n\nAdmins only.`,
    kb: [
      [{ text: '🖼 Media', callback_data: 'cfg:media' }, { text: 'Emoji ' + (g.emoji || '🟢'), callback_data: 'cfg:emoji' }],
      [{ text: '💵 Min buy', callback_data: 'cfg:min' }, { text: '📊 $ per emoji', callback_data: 'cfg:step' }],
      [{ text: '🧪 Test alert', callback_data: 'cfg:test' }, { text: '🔗 Links', callback_data: 'cfg:links' }],
      [{ text: '🛡 Guard', callback_data: 'cfg:guard' }, { text: '⏹ Stop alerts', callback_data: 'cfg:stop' }],
    ],
  };
}

async function onSettings(ctx, q, act) {
  const { env, store } = ctx;
  const ack = (text, alert = false) => tg(env, 'answerCallbackQuery',
    { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  const chat = q.message && q.message.chat;
  if (!chat || chat.type === 'private') return ack();
  if (!await isAdmin(env, { chat, from: q.from })) return ack('Only group admins can change these.', true);
  let g = await getGroup(store, chat.id);
  if (!g) return ack('Run /setup <contract address> first.', true);

  const show = view => tg(env, 'editMessageText', {
    chat_id: chat.id, message_id: q.message.message_id, text: view.text, parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: view.kb },
  }).catch(() => null);
  const save = async (patch, note) => {
    g = { ...g, ...patch };
    await putGroup(store, chat.id, g);
    await ack(note);
    return show(settingsView(g));
  };

  const [what, val] = act.split(':');
  const i = Math.floor(num(val));
  const GKEY = { gcap: 'captcha', gwel: 'welcome', gcln: 'clean' };
  if (GKEY[what] || (what === 'gttl' && TTLS[i])) {
    const gd = { ttl: 5, ...(g.guard || {}) };
    let note;
    if (what === 'gttl') { gd.ttl = TTLS[i]; note = TTLS[i] + ' minutes to answer'; }
    else {
      const key = GKEY[what], turnOn = !gd[key];
      /* Say so now, not on the first join: a captcha the bot cannot enforce
         mutes nobody and deletes nothing. */
      if (turnOn && key !== 'welcome') {
        const why = await missingRights(ctx, chat.id);
        if (why) return ack(why, true);
      }
      gd[key] = turnOn;
      note = { captcha: 'Join captcha', welcome: 'Welcome message', clean: 'Clean joins' }[key] + (turnOn ? ' on' : ' off');
    }
    g = { ...g, guard: gd };
    await putGroup(store, chat.id, g);
    await ack(note);
    return show(settingsView(g, 'guard'));
  }
  if (what === 'emoji' && val != null && EMOJIS[i]) return save({ emoji: EMOJIS[i] }, 'Emoji ' + EMOJIS[i]);
  if (what === 'min' && val != null && MINBUYS[i] != null) return save({ minBuy: MINBUYS[i] }, MINBUYS[i] ? 'Hiding buys under $' + MINBUYS[i] : 'Showing every buy');
  if (what === 'step' && val != null && STEPS[i]) return save({ step: STEPS[i] }, 'One emoji per $' + STEPS[i]);
  if (what === 'media' && val === 'off') return save({ media: null }, 'Media removed');
  if (what === 'media' && val === 'new') {
    await ack();
    /* force_reply opens the reply box; selective + a mention of whoever
       tapped keeps it from opening for every member of the group */
    const who = q.from ? `<a href="tg://user?id=${num(q.from.id)}">${tgEsc(q.from.first_name || 'admin')}</a>` : '';
    return say(env, chat.id, `${MEDIA_PROMPT} — it goes on every buy. ${who}`,
      { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Attach a photo, GIF or video' } });
  }
  if (what === 'test') { await ack('Sending a test alert'); return sendTest(ctx, chat.id, g); }
  if (what === 'stop' && val === 'yes') {
    await removeGroup(store, chat.id);
    await resync(ctx);
    await ack('Stopped');
    return tg(env, 'editMessageText', { chat_id: chat.id, message_id: q.message.message_id,
      text: 'Stopped — no more buy alerts here, and the guard is off. /setup <code>&lt;contract address&gt;</code> to start again.', parse_mode: 'HTML' }).catch(() => null);
  }
  await ack();
  return show(settingsView(g, ['emoji', 'min', 'step', 'media', 'links', 'stop', 'guard'].includes(what) ? what : 'main'));
}

/* ================================================================= guard */
/* Joins, the captcha and the welcome. State lives in the GroupGuard Durable
   Object (src/guard.mjs has the why); this is the Telegram side. */

const PERMS = ['can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos',
  'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls',
  'can_send_other_messages', 'can_add_web_page_previews', 'can_invite_users'];
const perms = v => Object.fromEntries(PERMS.map(k => [k, v]));
const mention = u => `<a href="tg://user?id=${num(u && u.id)}">${tgEsc(String((u && (u.first_name || u.username)) || 'there').slice(0, 32))}</a>`;
const del = (env, chatId, id) => id ? tg(env, 'deleteMessage', { chat_id: chatId, message_id: id }).catch(() => null) : null;

async function missingRights(ctx, chatId) {
  const bot = await me(ctx.env, ctx.store).catch(() => null);
  if (!bot || !bot.id) return 'Could not check my admin rights — try again.';
  let m = null;
  try { m = await tg(ctx.env, 'getChatMember', { chat_id: chatId, user_id: bot.id }); } catch {}
  if (!m || m.status !== 'administrator') return 'Make me an admin first, with Ban users and Delete messages.';
  if (!m.can_restrict_members) return 'I need the Ban users right to mute new members.';
  if (!m.can_delete_messages) return 'I need the Delete messages right.';
  return '';
}

async function onJoinLeave(ctx, msg) {
  const { env, store } = ctx;
  const chat = msg.chat;
  const g = await getGroup(store, chat.id);
  const gd = g && g.guard;
  if (!gd) return;
  if (gd.clean) await del(env, chat.id, msg.message_id);
  /* bots are added by admins, not by spammers joining a link */
  for (const u of msg.new_chat_members || []) if (u && !u.is_bot) await onJoin(ctx, chat, u, g);
}

/* A join seen as a member update: the only signal in a group that hides its
   join messages. Muting and unmuting also arrive here and are not joins. */
async function onChatMember(ctx, cm) {
  const chat = cm.chat;
  if (!chat || chat.type === 'private') return;
  const was = cm.old_chat_member && cm.old_chat_member.status;
  const now = cm.new_chat_member && cm.new_chat_member.status;
  const u = cm.new_chat_member && cm.new_chat_member.user;
  if (!u || u.is_bot) return;
  const joined = (was === 'left' || was === 'kicked' || !was) && (now === 'member' || (now === 'restricted' && cm.new_chat_member.is_member));
  if (!joined) return;
  const g = await getGroup(ctx.store, chat.id);
  if (g && g.guard) await onJoin(ctx, chat, u, g);
}

async function onJoin(ctx, chat, u, g) {
  const { env } = ctx;
  const gd = g.guard || {};
  if ((!gd.captcha && !gd.welcome) || !ctx.guard) return;
  const j = await ctx.guard(chat.id, 'join', { uid: u.id, captcha: !!gd.captcha, ttlMin: gd.ttl }).catch(() => null);
  if (!j || j.dup) return;
  if (j.captcha) {
    const muted = await tg(env, 'restrictChatMember', {
      chat_id: chat.id, user_id: u.id, permissions: perms(false), use_independent_chat_permissions: true,
    }).then(() => true).catch(() => false);
    if (muted) {
      const kb = [];
      j.options.forEach((e, i) => { if (i % 4 === 0) kb.push([]); kb[kb.length - 1].push({ text: e, callback_data: `cap:${u.id}:${i}` }); });
      const m = await say(env, chat.id,
        `👋 ${mention(u)}, welcome to <b>${tgEsc(chat.title || 'the group')}</b>!\n\n`
        + `Tap the ${j.target} below to unlock chat. You have ${j.ttl} min.`,
        { reply_markup: { inline_keyboard: kb } });
      if (m) await ctx.guard(chat.id, 'msg', { uid: u.id, msg: m.message_id }).catch(() => null);
      return;
    }
    /* could not mute (rights removed since it was switched on): no captcha
       nobody enforces — forget it and fall through to the welcome */
    await ctx.guard(chat.id, 'drop', { uid: u.id }).catch(() => null);
  }
  if (gd.welcome) await postWelcome(ctx, chat, u, g);
}

export function welcomeText(g, chat, u) {
  const gd = g.guard || {};
  const tpl = gd.text || '👋 Welcome {name} to {group}!\n\n🫧 ${sym} is live on the bubble map — buys post here as they happen.';
  return tgEsc(tpl)
    .replace(/\{name\}/g, mention(u))
    .replace(/\{group\}/g, '<b>' + tgEsc((chat && chat.title) || 'the group') + '</b>')
    .replace(/\{sym\}/g, tgEsc(g.sym || ''));
}

async function postWelcome(ctx, chat, u, g) {
  const { env } = ctx;
  const origin = site(env);
  const mint = g.mint;
  const buttons = mint ? [[
    { text: '📊 Chart', url: 'https://dexscreener.com/solana/' + encodeURIComponent(mint) },
    { text: '💲 Buy', url: buyUrl(env, mint) || ('https://jup.ag/swap/SOL-' + encodeURIComponent(mint)) },
    { text: '🫧 Bubble', url: origin + '/s/' + encodeURIComponent(mint) },
  ]] : [];
  const m = await say(env, chat.id, welcomeText(g, chat, u), buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
  if (!m) return;
  const r = await ctx.guard(chat.id, 'welcome', { msg: m.message_id }).catch(() => null);
  if (r && r.prev) await del(env, chat.id, r.prev);
}

async function onCaptcha(ctx, q, rest) {
  const { env, store } = ctx;
  const ack = (text, alert = false) => tg(env, 'answerCallbackQuery',
    { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  const [uidS, iS] = rest.split(':');
  const uid = Math.floor(num(uidS));
  const chat = q.message && q.message.chat;
  if (!chat || !ctx.guard) return ack();
  if (!q.from || q.from.id !== uid) return ack('This check is for the new member.', true);
  const r = await ctx.guard(chat.id, 'answer', { uid, i: Math.floor(num(iS)) }).catch(() => null);
  if (!r || r.result === 'none' || r.result === 'expired') {
    await ack('This check has expired.', true);
    return del(env, chat.id, q.message.message_id);
  }
  if (r.result === 'wrong') return ack(`❌ Not that one — ${r.left} ${r.left === 1 ? 'try' : 'tries'} left.`, true);
  if (r.result === 'fail') {
    await ack('❌ Wrong. You can rejoin in a minute.', true);
    await kick(env, chat.id, uid);
    return del(env, chat.id, q.message.message_id);
  }
  /* passed: "True for all permissions lifts restrictions" — the member falls
     back to the group's own defaults, not to more than them */
  await tg(env, 'restrictChatMember', { chat_id: chat.id, user_id: uid, permissions: perms(true) }).catch(() => null);
  await ack('✅ Verified — welcome!');
  await del(env, chat.id, q.message.message_id);
  const g = await getGroup(store, chat.id);
  if (g && g.guard && g.guard.welcome) await postWelcome(ctx, chat, q.from, g);
}

/* A ban this short lifts itself: removed now, free to rejoin in a minute. */
const kick = (env, chatId, uid) => tg(env, 'banChatMember', {
  chat_id: chatId, user_id: uid, until_date: Math.floor(Date.now() / 1000) + KICK_S,
}).catch(() => null);

/* Called by the GroupGuard alarm with whoever let their captcha run out. */
export async function guardExpire(env, chatId, list) {
  for (const p of list || []) {
    await kick(env, chatId, p.uid);
    await del(env, chatId, p.msg);
  }
}

/* Private chat: /start offers the opt-in keyboard and stores nothing until a
   choice is made. /stop forgets the user entirely. */
async function onPrivate(ctx, msg) {
  const { env, store } = ctx;
  const c = command(msg.text || '');
  const uid = msg.from && msg.from.id;
  if (!c || !uid) return;
  if (c.cmd === 'start' || c.cmd === 'help') {
    return say(env, msg.chat.id,
      '🫧 <b>pumpbubble</b> — the live bubble map for pump.fun, Base, Robinhood Chain and the market.\n\n'
      + 'To add buy alerts to your group: add me there and run <code>/setup &lt;contract address&gt;</code>.\n\n'
      + 'Want anything from me here? Pick what you like — nothing is sent otherwise.',
      { reply_markup: { inline_keyboard: [
        [{ text: '🫧 Daily Bubble Index', callback_data: 'sub:index' }],
        [{ text: '🔥 Trending tokens', callback_data: 'sub:trend' }],
        [{ text: 'No thanks', callback_data: 'sub:none' }],
      ] } });
  }
  if (c.cmd === 'stop') {
    await forgetUser(store, uid);
    return say(env, msg.chat.id, 'Done — nothing more from me. /start any time.');
  }
}

async function onCallback(ctx, q) {
  const { env, store } = ctx;
  const data = String(q.data || '');
  const uid = q.from && q.from.id;
  const chatId = q.message && q.message.chat && q.message.chat.id;
  if (uid && data.startsWith('cfg:')) return onSettings(ctx, q, data.slice(4));
  if (uid && data.startsWith('cap:')) return onCaptcha(ctx, q, data.slice(4));
  if (!uid || !data.startsWith('sub:')) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {}); return; }
  const pick = data.slice(4);
  if (pick === 'none') {
    await forgetUser(store, uid);
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Nothing will be sent.' }).catch(() => {});
    if (chatId) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }
  let u = null;
  try { u = await store.get(K.user(uid)); } catch {}
  const subs = { ...(u && u.subs || {}) };
  subs[pick] = !subs[pick];
  await store.put(K.user(uid), { id: uid, chatId: chatId || uid, subs, at: Date.now() });
  let ids = [];
  try { ids = (await store.get(K.users)) || []; } catch {}
  if (!ids.includes(uid)) { ids.push(uid); await store.put(K.users, ids); }
  await tg(env, 'answerCallbackQuery', {
    callback_query_id: q.id,
    text: (subs[pick] ? 'Subscribed: ' : 'Unsubscribed: ') + (pick === 'index' ? 'Daily Bubble Index' : 'Trending tokens'),
  }).catch(() => {});
  if (chatId) {
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [
      [{ text: (subs.index ? '✅ ' : '') + '🫧 Daily Bubble Index', callback_data: 'sub:index' }],
      [{ text: (subs.trend ? '✅ ' : '') + '🔥 Trending tokens', callback_data: 'sub:trend' }],
      [{ text: 'No thanks', callback_data: 'sub:none' }],
    ] } }).catch(() => {});
  }
}

async function forgetUser(store, uid) {
  await store.put(K.user(uid), null);
  let ids = [];
  try { ids = (await store.get(K.users)) || []; } catch {}
  const next = ids.filter(id => id !== uid);
  if (next.length !== ids.length) await store.put(K.users, next);
}

async function resync(ctx) {
  try {
    return await syncWebhook(ctx.env, ctx.store, site(ctx.env), await watchAddresses(ctx.store));
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/* ================================================================= trades */

let tokenMem = new Map();          // mint -> {at, v}
async function tokenInfo(env, mint) {
  const hit = tokenMem.get(mint);
  if (hit && Date.now() - hit.at < 20_000) return hit.v;
  let v = null;
  try { v = await resolveAnyToken(mint, env.IMG_SECRET); } catch {}
  tokenMem.set(mint, { at: Date.now(), v });
  if (tokenMem.size > 500) tokenMem.delete(tokenMem.keys().next().value);
  return v;
}

/* Telegram allows ~20 messages a minute into one group. Past that, buys are
   dropped rather than queued: an alert about a buy from three minutes ago is
   noise, and a queue that never drains is a memory leak with a delay. */
const sentMem = new Map();         // chatId -> [ts]
function allowed(chatId) {
  const now = Date.now();
  const arr = (sentMem.get(chatId) || []).filter(t => now - t < 60_000);
  if (arr.length >= 18) { sentMem.set(chatId, arr); return false; }
  arr.push(now); sentMem.set(chatId, arr);
  return true;
}

/* Helius retries a delivery it thinks failed, and one transaction can appear
   in two payloads. A buy is posted once per signature per isolate. */
const seenSigs = new Set();
function fresh(sig) {
  if (!sig) return true;
  if (seenSigs.has(sig)) return false;
  seenSigs.add(sig);
  if (seenSigs.size > 4000) { const it = seenSigs.values(); for (let i = 0; i < 1000; i++) seenSigs.delete(it.next().value); }
  return true;
}

async function sendAlert(env, store, chatId, g, caption, keyboard) {
  const base = { chat_id: chatId, caption, parse_mode: 'HTML', reply_markup: keyboard };
  const m = g.media;
  try {
    if (m && m.kind === 'photo') return await tg(env, 'sendPhoto', { ...base, photo: m.id });
    if (m && m.kind === 'animation') return await tg(env, 'sendAnimation', { ...base, animation: m.id });
    if (m && m.kind === 'video') return await tg(env, 'sendVideo', { ...base, video: m.id });
    return await tg(env, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  } catch (e) {
    const d = String(e.description || e.message || '');
    /* The group is gone or we were removed: stop trying. */
    if (/kicked|not a member|chat not found|CHAT_WRITE_FORBIDDEN|deactivated|not enough rights/i.test(d)) {
      await removeGroup(store, chatId).catch(() => {});
      return null;
    }
    /* A media file id that stopped working: post the text and drop the media. */
    if (m && /wrong file identifier|failed to get HTTP URL|file is too big|WEBPAGE_MEDIA_EMPTY/i.test(d)) {
      await putGroup(store, chatId, { ...g, media: null }).catch(() => {});
      return tg(env, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } }).catch(() => null);
    }
    return null;
  }
}

/* A Helius delivery: every buy of a tracked mint, fanned out to every group
   that asked for it. `solUsd` comes from the caller because the price cache
   lives in api.mjs. Returns counts so the route can report what it did. */
export const LAT = [];              // seconds, block to posted, this isolate
export async function onTrade(ctx, payload, solUsd) {
  const { env, store } = ctx;
  const { set } = await tracked(store);
  if (!set.size) return { buys: 0, sent: 0 };
  const buys = buysFromPayload(payload, set);
  let sent = 0, skipped = 0;
  const bot = await me(env, store).catch(() => ({ username: '' }));
  for (const buy of buys) {
    if (!fresh(buy.sig)) continue;
    let chats = [];
    try { chats = (await store.get(K.mint(buy.mint))) || []; } catch {}
    if (!chats.length) continue;
    const token = (await tokenInfo(env, buy.mint)) || { mint: buy.mint };
    const usd = buy.sol * num(solUsd);
    for (const chatId of chats) {
      const g = await getGroup(store, chatId);
      if (!g || g.mint !== buy.mint) continue;
      if (num(g.minBuy) > 0 && usd < num(g.minBuy)) { skipped++; continue; }
      if (!allowed(chatId)) { skipped++; continue; }
      const { caption, keyboard } = formatBuy({ buy, token, group: g, solUsd, botName: bot.username, env });
      if (await sendAlert(env, store, chatId, g, caption, keyboard)) {
        sent++;
        /* block time to alert posted, in seconds — the number that decides
           whether this feels live next to Bobby; read with wrangler tail */
        if (buy.blockTime) {
          const lat = (Date.now() - buy.blockTime * 1000) / 1000;
          LAT.push(lat); if (LAT.length > 100) LAT.shift();
          console.log(JSON.stringify({ ev: 'buy-alert', sym: g.sym, latencyS: +lat.toFixed(1) }));
        }
      }
    }
  }
  return { buys: buys.length, sent, skipped };
}

/* ================================================================ status */

export async function status(env, store) {
  const out = { enabled: enabled(env) };
  if (!out.enabled) return out;
  let groups = [], users = [], mints = [];
  try { groups = (await store.get(K.groups)) || []; } catch {}
  try { users = (await store.get(K.users)) || []; } catch {}
  try { mints = (await store.get(K.mints)) || []; } catch {}
  out.groups = groups.length; out.subscribers = users.length; out.mints = mints.length;
  try { const info = await tg(env, 'getWebhookInfo'); out.telegram = { url: info.url || '', pending: info.pending_update_count || 0, lastError: info.last_error_message || '' }; }
  catch (e) { out.telegram = { error: String(e.message) }; }
  out.helius = await webhookInfo(env, store);
  if (LAT.length) {
    const s = LAT.slice().sort((a, b) => a - b);
    out.latency = { alerts: s.length, medianS: +s[s.length >> 1].toFixed(1), p90S: +s[Math.floor(s.length * 0.9)].toFixed(1) };
  }
  return out;
}

/* Broadcast to people who opted in — and only them. Chunked, because one
   request cannot send to thousands; the caller passes `after` back until
   `done`. Groups get it only when an admin turned the feed on for the group. */
export async function broadcast(env, store, { audience, text, after = 0, limit = 150, dry = false }) {
  const html = String(text || '').trim();
  if (!html) return { ok: false, error: 'empty' };
  if (!['index', 'trend'].includes(audience)) return { ok: false, error: 'audience must be index or trend' };
  let ids = [];
  try { ids = (await store.get(K.users)) || []; } catch {}
  const slice = ids.slice(after, after + limit);
  let sent = 0, eligible = 0, gone = 0;
  for (const uid of slice) {
    let u = null;
    try { u = await store.get(K.user(uid)); } catch {}
    if (!u || !u.subs || !u.subs[audience]) continue;
    eligible++;
    if (dry) continue;
    try {
      await tg(env, 'sendMessage', { chat_id: u.chatId || uid, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: false } });
      sent++;
    } catch (e) {
      /* Blocked us: forget them, which is what they asked for. */
      if (/blocked|deactivated|chat not found/i.test(String(e.description || e.message))) { await forgetUser(store, uid).catch(() => {}); gone++; }
    }
  }
  const next = after + limit;
  return { ok: true, audience, eligible, sent, gone, dry, after: next, total: ids.length, done: next >= ids.length };
}
