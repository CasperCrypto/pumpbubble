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

import { resolveAnyToken, pumpCoin, isCA, isMint, isEvmAddr, clean } from './core.mjs';
import { CHAINS, isChain, poolsFrom, tokenFacts, ethUsd as evmEthUsd } from './evmbuy.mjs';
import { buyOrSwap, pumpJoin, swapPath } from './refs.mjs';
import { buysFromPayload, walletSwapsFromPayload } from './solbuy.mjs';
import { syncWebhook, webhookInfo, addrHash, KEY as HELIUS_KEY } from './helius.mjs';
import { solPolling } from './solwatch.mjs';
import { TTLS, KICK_S } from './guard.mjs';
import { TIERS as BOOST_TIERS, AD_TIERS, welcomeGold } from './boosts.mjs';
import { UNSUB, MAX_FOLLOWS } from './audience.mjs';
import { smartWallets, topSmart, smartSignal } from './smartset.mjs';
import { buyCardSpec } from './buycard.mjs';
import { BOT_BONUS } from './taps.mjs';
import { TOP_N as CALL_TOP_N } from './callers.mjs';

/* Said at every Start, because pressing Start is what puts somebody on the
   list the operator can DM (src/audience.mjs). */
export const DISCLOSURE = 'Starting me adds you to pumpbubble updates — new launches, trending tokens and sponsored drops. /stop or 🔕 any time.';

export const SITE = 'https://pumpbubble.fun';
const DEXS = 'https://api.dexscreener.com';

export const enabled = (env = {}) => !!env.TG_BOT_TOKEN;
/* our own Telegram group (TG_COMMUNITY), linked from the Start menu and the
   setup reply; only a t.me link is accepted */
/* our X account (X_PROFILE), beside the group; only an x.com profile link */
export const xProfile = (env = {}) => /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(String(env.X_PROFILE || '')) ? env.X_PROFILE : 'https://x.com/pumpbubblefun';
export const community = (env = {}) => /^https:\/\/t\.me\/[A-Za-z0-9_]{4,40}$/.test(String(env.TG_COMMUNITY || '')) ? env.TG_COMMUNITY : 'https://t.me/pumpbubble';
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
  channel: 'tg:channel',                // the public smart-money channel, set in the console
  profile: 'tg:profile',                // which version of BOT_PROFILE Telegram has, and the photo
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
export async function ensureWebhook(env, store, audience = null) {
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
  try { out.profile = await ensureProfile(env, store); }
  catch (e) { out.profile = { ok: false, error: String(e && e.message || e) }; }
  /* Keep Helius's watched set right, on the cron: a webhook that is missing,
     or watching a set other than today's (the top traders turn over), is
     synced; an unchanged one is left alone — every edit is 100 credits. */
  out.helius = await syncHelius(env, store, audience);
  return out;
}

/* ====================================================== the bot's profile */
/* Everything Telegram shows about the bot before and around a conversation,
   set by the bot itself so nothing depends on somebody remembering BotFather:
   the "/" command lists (one for private chats, one for group members, one
   for group admins — Telegram shows the most specific), the text in an empty
   chat ("What can this bot do?"), the line on its profile and on shared
   links, the Menu button, the admin rights it asks for when added to a group
   or a channel, and — only when it has none — its profile photo.

   Applied once per version of this object: the hash of it is kept in KV
   (`tg:profile`), so the cron's hourly look costs one read, and editing any
   text below re-applies everything on the next tick. */
const RIGHTS = {
  is_anonymous: false, can_manage_chat: true, can_delete_messages: false, can_manage_video_chats: false,
  can_restrict_members: false, can_promote_members: false, can_change_info: false, can_invite_users: false,
  can_post_stories: false, can_edit_stories: false, can_delete_stories: false,
};
export const BOT_PROFILE = {
  description: [
    '🫧 pumpbubble — the live pump.fun bubble map, in Telegram.',
    '',
    '➕ Free buy bot for your token’s group: every buy with your picture, a join captcha, a welcome message.',
    '👛 Track any wallet — every buy and sell, copy it in one tap.',
    '🧠 Follow pump.fun’s top traders by profit actually banked.',
    '📣 pump.fun\u2019s best callers, measured — their new calls here first.',
    '⚡ Make a token gold on the map, or advertise it.',
    '',
    'News: x.com/pumpbubblefun',
    '',
    'Tap Start below.',
  ].join('\n'),
  short: 'Free buy bot + captcha for your group. Track wallets and pump.fun’s top traders. The live bubble map.',
  commands: {
    private: [
      { command: 'start', description: '🏠 Main menu' },
      { command: 'buybot', description: '➕ Free buy bot for your group' },
      { command: 'track', description: '👛 Track a wallet: /track WALLET name' },
      { command: 'wallets', description: '📋 Your tracked wallets' },
      { command: 'toptraders', description: '🧠 Follow pump.fun’s top traders' },
      { command: 'callers', description: '📣 Top callers — their calls, first' },
      { command: 'boost', description: '⚡ Make a token gold on the map' },
      { command: 'ads', description: '📣 Advertise a token' },
      { command: 'help', description: '❓ How everything works' },
      { command: 'stop', description: '🔕 Stop all messages from me' },
    ],
    group: [
      { command: 'status', description: '📊 What this group is tracking' },
      { command: 'boost', description: '⚡ Make this token gold on the map' },
      { command: 'ads', description: '📣 Advertise this token' },
      { command: 'help', description: '❓ How the buy bot works' },
    ],
    admins: [
      { command: 'setup', description: '🚀 Start buy alerts: /setup CONTRACT_ADDRESS' },
      { command: 'settings', description: '⚙️ Picture, emoji, minimum buy, 🛡 guard' },
      { command: 'test', description: '🧪 Post a sample buy alert' },
      { command: 'welcome', description: '👋 Welcome message: /welcome Hi {name}!' },
      { command: 'status', description: '📊 What this group is tracking' },
      { command: 'boost', description: '⚡ Make this token gold on the map' },
      { command: 'ads', description: '📣 Advertise this token' },
      { command: 'stop', description: '⏹ Stop buy alerts here' },
      { command: 'help', description: '❓ All commands' },
    ],
  },
  /* what the guard needs, and nothing it does not */
  groupRights: { ...RIGHTS, can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_pin_messages: true, can_manage_topics: false },
  /* the Smart money channel: post, and edit its own posts */
  channelRights: { ...RIGHTS, can_post_messages: true, can_edit_messages: true },
};

export function profileHash(p = BOT_PROFILE) {
  const str = JSON.stringify(p);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function ensureProfile(env, store) {
  if (!enabled(env)) return { enabled: false };
  const v = profileHash();
  let saved = null;
  try { saved = await store.get(K.profile); } catch {}
  if (saved && saved.v === v && saved.ok) return { ok: true, v, applied: false, photo: saved.photo || '' };
  const P = BOT_PROFILE, errors = [];
  const run = async (method, body) => {
    try { await tg(env, method, body); } catch (e) { errors.push(method + ': ' + (e.description || e.message)); }
  };
  await run('setMyCommands', { commands: P.commands.private, scope: { type: 'default' } });
  await run('setMyCommands', { commands: P.commands.private, scope: { type: 'all_private_chats' } });
  await run('setMyCommands', { commands: P.commands.group, scope: { type: 'all_group_chats' } });
  await run('setMyCommands', { commands: P.commands.admins, scope: { type: 'all_chat_administrators' } });
  await run('setMyDescription', { description: P.description });
  await run('setMyShortDescription', { short_description: P.short });
  await run('setChatMenuButton', { menu_button: { type: 'commands' } });
  await run('setMyDefaultAdministratorRights', { rights: P.groupRights });
  await run('setMyDefaultAdministratorRights', { rights: P.channelRights, for_channels: true });
  /* A picture already on the bot is the operator's (set in BotFather) and
     stays; ours goes up only on a bot with none. */
  let photo = (saved && saved.photo) || '';
  if (photo !== 'ours' && photo !== 'theirs') {
    try { photo = await ensurePhoto(env, store); }
    catch (e) { errors.push('photo: ' + (e.description || e.message)); photo = ''; }
  }
  const rec = { v, ok: !errors.length, at: Date.now(), photo, errors: errors.slice(0, 5) };
  try { await store.put(K.profile, rec); } catch {}
  return { ok: rec.ok, v, applied: true, photo, errors: rec.errors };
}

/* setMyProfilePhoto takes a new upload only (a JPG, as multipart), so the
   picture is fetched from the site — public/bot-avatar.jpg, the map's P
   bubble — and sent on as a file. */
async function ensurePhoto(env, store) {
  const bot = await me(env, store);
  const have = await tg(env, 'getUserProfilePhotos', { user_id: bot.id, limit: 1 });
  if (have && have.total_count > 0) return 'theirs';
  const r = await fetch(site(env) + '/bot-avatar.jpg', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('avatar ' + r.status);
  const form = new FormData();
  form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
  form.append('avatar', new Blob([await r.arrayBuffer()], { type: 'image/jpeg' }), 'avatar.jpg');
  const res = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/setMyProfilePhoto', {
    method: 'POST', body: form, signal: AbortSignal.timeout(20000),
  });
  let j = null;
  try { j = await res.json(); } catch { /* below */ }
  if (!j || !j.ok) {
    const e = new Error('setMyProfilePhoto: ' + ((j && j.description) || res.status));
    e.description = (j && j.description) || '';
    throw e;
  }
  return 'ours';
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
/* Where a token's buttons go, by chain. Solana: pump.fun or DexScreener,
   Buy through the referral when one is set, else our /swap page. EVM:
   DexScreener, and Buy on our /swap page too — Relay routes Base, Ethereum
   and Robinhood Chain there, with our fee, where Uniswap earned nothing and
   had no Robinhood Chain at all. */
export function tokenLinks(env, g, token = {}) {
  const origin = site(env);
  const net = CHAINS[g.chain];
  if (net) {
    const a = String(g.token || token.addr || '');
    const chart = 'https://dexscreener.com/' + net.dex + '/' + encodeURIComponent(a);
    const sym = clean(token.sym || g.sym || '', 12);
    return {
      chart,
      buy: swapPath(g.chain, a) ? origin + swapPath(g.chain, a) : chart,
      bubble: g.chain === 'ethereum' || !sym ? origin + '/?source=trending' : origin + '/s/' + encodeURIComponent(sym) + '?source=' + g.chain,
      boost: origin + '/?boost=' + encodeURIComponent(a),
    };
  }
  const mint = token.mint || g.mint;
  return {
    chart: token.grad === false ? 'https://pump.fun/coin/' + encodeURIComponent(mint) : 'https://dexscreener.com/solana/' + encodeURIComponent(mint),
    buy: buyOrSwap(env, origin, mint),
    bubble: origin + '/s/' + encodeURIComponent(mint),
    boost: origin + '/?boost=' + encodeURIComponent(mint),
  };
}

/* Buy size in the bubble style: a name and a ten-step meter on a log scale,
   so a $20 buy and a $20,000 one both read at a glance — where a row of
   emoji runs off the screen at the top and says almost nothing at the
   bottom, and looks the same in every buy bot's alert. */
export const TIERS = [[10000, '🐋', 'WHALE'], [2500, '🦈', 'SHARK'], [500, '🐬', 'DOLPHIN'], [100, '🐟', 'FISH'], [0, '🦐', 'SHRIMP']];
export function buyTier(usd) { const u = num(usd); return TIERS.find(t => u >= t[0]) || TIERS[TIERS.length - 1]; }
export function buyMeter(usd) {
  const u = num(usd);
  const n = u > 0 ? clamp(Math.round(Math.log10(u) * 2.2 - 0.6), 1, 10) : 0;
  /* full-height blocks: they take the text's own colour on light and dark
     themes alike, where the thinner ▰▱ drew small and faint on desktop */
  return '█'.repeat(n) + '░'.repeat(10 - n);
}
/* numbers as people say them: 0.5 SOL, not 0.5000; 11.45M tokens, not
   11,453,237.88 */
const trimZ = s => s.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
export function solShort(n) {
  n = num(n);
  return trimZ(n >= 100 ? n.toFixed(1) : n >= 10 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4));
}
export function qtyShort(n) {
  n = num(n);
  if (n >= 1e9) return trimZ((n / 1e9).toFixed(2)) + 'B';
  if (n >= 1e6) return trimZ((n / 1e6).toFixed(2)) + 'M';
  if (n >= 1e3) return Math.round(n).toLocaleString('en-US');
  if (n >= 1) return trimZ(n.toFixed(2));
  return n > 0 ? n.toLocaleString('en-US', { maximumSignificantDigits: 4 }) : '0';
}

/* A whale, by the group's own measure ($5,000 unless it picked another in
   ⚙️ Settings → 🐋 Whale buys): the headline says so, the alert carries the
   group's whale media when it set one, and the bot reacts with 🐳. */
export const WHALES = [1000, 2500, 5000, 10000, 25000];
export const whaleAt = (g = {}) => (WHALES.includes(num(g.whaleMin)) ? num(g.whaleMin) : 5000);

/* The bot reacts to its own alert on the buys worth looking up for, with
   Telegram's big animation — it plays full size for everyone watching the
   chat (setMessageReaction, is_big). A whale gets 🐳, a top trader or a top
   caller 💯, four figures 🔥; everything else nothing, so it stays an event.
   Groups can switch it off. */
export function buyReaction({ usd, smart = null, caller = null, group = {} }) {
  if (group.react === false) return '';
  if (num(usd) >= whaleAt(group)) return '🐳';
  if ((smart && smart.rank) || (caller && caller.rank)) return '💯';
  if (num(usd) >= 1000) return '🔥';
  return '';
}

/* Two styles. `classic` (the default — "I like the old look", 2026-10-02): the size of the buy
   by name and meter, the numbers in a quote block, the token's place on the
   map — kept one tap away in ⚙️ Settings → 🎨 Style. `classic`: the format
   the communities know from Bobby and the rest, one emoji per $step, with
   the whale headline, whale media and the reaction on top. Both print the same facts and the same
   escaped strings; only the layout differs. */
export function formatBuy({ buy, token, group, solUsd, botName, env = {}, test = false, ad = null, smart = null, caller = null, rank = null }) {
  const usd = buy.usd != null ? num(buy.usd) : num(buy.sol) * num(solUsd);
  const sym = clean(token.sym || group.sym || '?', 12);
  const net = CHAINS[group.chain];
  const native = net ? net.native : 'SOL';
  const links = tokenLinks(env, group, token);
  const bubble = group.style === 'bubble';

  /* only a hash or an address of the chain's own shape becomes a link */
  const sig = String(buy.sig || '');
  const txUrl = net && /^0x[0-9a-fA-F]{64}$/.test(sig) ? `${net.explorer}/tx/${sig}`
    : !net && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig) ? `https://solscan.io/tx/${sig}` : '';
  const walletUrl = net && isEvmAddr(buy.buyer) ? `${net.explorer}/address/${buy.buyer}`
    : !net && buy.buyer && isMint(buy.buyer) ? `https://solscan.io/account/${buy.buyer}` : '';

  /* The buyer is one of pump.fun's top traders by realized profit — the
     line no other buy bot can print (src/smartset.mjs). */
  const tags = [], short = [];
  if (smart && smart.rank) {
    const who = smart.xh && /^\w{1,15}$/.test(smart.xh) ? '@' + smart.xh : clean(smart.name || '', 20);
    tags.push(`🧠 <b>SMART BUY</b> — ${tgEsc(who)}, #${Math.floor(smart.rank)} on pump.fun ${tgEsc(smart.when || '')} by profit banked (+${fmtUsd(smart.realized)})`);
    short.push(`🧠 <b>Smart buy</b> · ${tgEsc(who)} · #${Math.floor(smart.rank)} on pump.fun ${tgEsc(smart.when || '')} · +${fmtUsd(smart.realized)} banked`);
  }
  /* The KOL line: the buyer is one of the week's top callers on pump.fun —
     the Calls tab's own ranking, whose calls reach 2× most reliably. Their
     followers watch what they buy; a group seeing that line is seeing why. */
  if (caller && caller.rank) {
    const who = caller.xh && /^\w{1,15}$/.test(caller.xh) ? '@' + caller.xh : clean(caller.name || '', 20);
    const hit = caller.hit2 != null && isFinite(+caller.hit2) && caller.n > 0 ? ` — ${Math.round(+caller.hit2 * 100)}% of their ${Math.floor(caller.n)} calls hit 2×` : '';
    tags.push(`📣 <b>TOP CALLER BUY</b> — ${tgEsc(who)}, #${Math.floor(caller.rank)} caller on pump.fun this week${tgEsc(hit)}`);
    const rec = caller.hit2 != null && isFinite(+caller.hit2) && caller.n > 0 ? ` · ${Math.round(+caller.hit2 * 100)}% of ${Math.floor(caller.n)} calls hit 2×` : '';
    short.push(`📣 <b>Top caller</b> · ${tgEsc(who)} · #${Math.floor(caller.rank)} this week${tgEsc(rec)}`);
  }

  const s = group.socials || {};
  const socials = [okUrl(s.web) && `<a href="${attr(s.web)}">Web</a>`, okUrl(s.x) && `<a href="${attr(s.x)}">𝕏</a>`,
    okUrl(s.tg) && `<a href="${attr(s.tg)}">TG</a>`].filter(Boolean);
  const paid = ad && okUrl(ad.url);
  const lines = [];
  if (bubble) {
    /* Seven lines where the classic alert takes twelve: what was bought and
       for how much on top, how big that is on the meter, who bought it when
       it matters, the receipt in a quote block, and the map. No "by @bot"
       line — Telegram already shows who posted it. */
    const [, te, tn] = buyTier(usd);
    const amount = usd > 0 ? fmtUsd(usd) : solShort(buy.sol) + ' ' + native;
    lines.push(`${te} <b>${tgEsc(sym)} BUY</b> · <b>${amount}</b>${test ? ' · <i>test</i>' : ''}`);
    lines.push(`<b>${buyMeter(usd)}</b> ${tn}`);
    lines.push(...short);
    const facts = [`${solShort(buy.sol)} ${native} → <b>${qtyShort(buy.tokens)} ${tgEsc(sym)}</b>`];
    const more = [num(token.mcap) > 0 && `MCap <b>${fmtUsd(token.mcap)}</b>`, buy.newHolder && '🆕 New holder'].filter(Boolean);
    if (more.length) facts.push(more.join(' · '));
    const refs = [txUrl && `<a href="${txUrl}">Tx</a>`, walletUrl && `<a href="${walletUrl}">Buyer</a>`, ...socials];
    if (refs.length) facts.push(refs.join(' · '));
    lines.push('<blockquote>' + facts.join('\n') + '</blockquote>');
    if (paid) lines.push(`📢 <b>Ad</b> · <a href="${attr(ad.url)}">${tgEsc(clean(ad.title || '', 22))}</a>${ad.name ? ' — ' + tgEsc(clean(ad.name, 32)) : ''}`);
    const place = rank && rank.rank > 0 && rank.rank <= 50 ? `#${Math.floor(rank.rank)} trending on pumpbubble` : `${tgEsc(sym)} on pumpbubble`;
    const foot = [`🫧 <a href="${links.bubble}">${place}</a>`];
    if (!paid && botName) foot.push(`<a href="https://t.me/${tgEsc(botName)}?start=ads">📢 Your token here</a>`);
    lines.push(foot.join(' · '));
  } else {
    const whale = usd >= whaleAt(group);
    const hdr = whale ? '🐳' : usd >= 1000 ? '🐋' : buy.newHolder ? '🆕' : '🟢';
    lines.push(`${test ? '🧪 <b>TEST</b> · ' : ''}${hdr} | <b>${tgEsc(sym)} ${whale ? 'WHALE BUY' : 'BUY'}!</b>`);
    if (botName) lines.push(`<i>by @${tgEsc(botName)}</i>`);
    lines.push(...tags);
    lines.push('');
    lines.push(emojiRow(usd, group.emoji, group.step));
    lines.push('');
    lines.push(`🔷 <b>${native}</b> ${fmtSol(buy.sol)}${usd > 0 ? ` (${fmtUsd(usd)})` : ''}`);
    const tx = txUrl ? ` (<a href="${txUrl}">Tx</a>)` : '';
    lines.push(`🪙 <b>${tgEsc(sym)}</b> ${fmtQty(buy.tokens)}${tx}`);
    const wallet = walletUrl ? ` (<a href="${walletUrl}">Wallet</a>)` : '';
    /* EVM buys do not know whether the wallet held before; say only what is known */
    if (buy.newHolder === undefined) { if (wallet) lines.push(`🔎 <b>Buyer:</b>${wallet}`); }
    else lines.push(`🔎 <b>Position:</b> ${buy.newHolder ? 'New Holder' : 'Holder'}${wallet}`);
    if (num(token.mcap) > 0) lines.push(`📈 <b>MCap:</b> ${fmtUsd(token.mcap)}`);
  }

  if (!bubble) {
    if (socials.length) lines.push(`📣 <b>Socials:</b> ${socials.join(' | ')}`);
    lines.push('');
    /* The sponsored line: a paid token (its ticker, its own page — never text
       or a link somebody typed), or, while the slot is unsold, the slot selling
       itself — the same idea as the rail's empty pitch. */
    if (paid) {
      lines.push(`📣 <b>Ad:</b> <a href="${attr(ad.url)}">${tgEsc(clean(ad.title || '', 22))}</a>${ad.name ? ' — ' + tgEsc(clean(ad.name, 32)) : ''}`);
    } else if (botName) {
      lines.push(`📣 <a href="https://t.me/${tgEsc(botName)}?start=ads">Your token here, under every buy</a>`);
    }
    /* where the token sits on the map right now, when it is on the trending tab */
    const place = rank && rank.rank > 0 && rank.rank <= 50 ? `#${Math.floor(rank.rank)} trending on` : `${tgEsc(sym)} on`;
    lines.push(`🫧 <a href="${links.bubble}">${place} the bubble map</a>`);
  }

  /* Chart goes to a chart; Buy through the referral where one is configured
     and to our own swap page when not — a button that says Buy and does nothing
     is worse than no button. */
  const keyboard = {
    inline_keyboard: [
      [{ text: '📊 Chart', url: links.chart }, { text: '🫧 Bubble', url: links.bubble }],
      /* Boost opens the purchase inside the bot when we know its name — the
         person tapping is already in Telegram */
      [{ text: '💲 Buy', url: links.buy }, { text: '⚡ Boost', url: botName && /^\w+$/.test(botName)
        ? 'https://t.me/' + botName + '?start=boost_' + (group.token || token.mint || group.mint) : links.boost }],
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

/* The tokens groups follow ([{mint, pool}]), kept half a minute per isolate.
   A failed read is not an empty list: it keeps the last good one, or says
   `failed` — an empty list that was really a KV error is how a sync could
   strip every group's token from the feed. `fresh` skips the half minute
   (the Solana watcher, poked by /setup). */
let mintsMem = { at: 0, v: null };
export async function tracked(store, fresh = false) {
  if (!fresh && mintsMem.v && Date.now() - mintsMem.at < 30_000) return mintsMem.v;
  let list;
  try { list = (await store.get(K.mints)) || []; }
  catch {
    if (mintsMem.v) { mintsMem.at = Date.now() - 25_000; return mintsMem.v; }
    return { list: [], set: new Set(), failed: true };
  }
  const v = { list, set: new Set(list.map(r => r.mint)) };
  mintsMem = { at: Date.now(), v };
  return v;
}

/* What Helius should watch, and whether every read behind it worked. The
   groups' tokens only when Helius delivers the buys (SOL_BUYS=helius) — by
   default the Solana watcher polls them (src/solwatch.mjs), and Helius
   delivering them too would post every buy twice and spend credits on the
   busiest addresses there are. */
async function watchSet(store, audience = null, env = {}) {
  const out = [];
  let partial = false;
  if (!solPolling(env)) {
    const t = await tracked(store);
    if (t.failed) partial = true;
    for (const r of t.list) { out.push(r.mint); if (r.pool) out.push(r.pool); }
  }
  /* the wallet tracker: every wallet somebody follows, and pump.fun's top
     traders while anyone follows them as a group or a channel posts them */
  if (audience) {
    try { out.push(...((await audience('wallets')).list || [])); } catch { partial = true; }
    try {
      const fans = (await audience('smartFans')).list || [];
      let channel = null;
      try { channel = await store.get(K.channel); } catch { partial = true; }
      if (fans.length || channel) out.push(...topSmart(await smartWallets()).keys());
    } catch { partial = true; }
  }
  return { addrs: [...new Set(out)], partial };
}

export async function watchAddresses(store, audience = null, env = {}) {
  return (await watchSet(store, audience, env)).addrs;
}

/* The one way the Helius webhook changes: from a complete read only (a
   failed read must never strip or delete it), and only when the set differs
   from the one it was last given — the hash is kept with its id — or when
   there is nothing left to watch and a webhook still exists. */
export async function syncHelius(env, store, audience = null) {
  try {
    const { addrs, partial } = await watchSet(store, audience, env);
    if (partial) return { ok: false, error: 'watch list read failed — left as it was' };
    let saved = null;
    try { saved = await store.get(HELIUS_KEY); } catch { return { ok: false, error: 'could not read the webhook record' }; }
    const has = !!(saved && saved.id);
    if (!addrs.length && !has) return { ok: true, addresses: 0 };
    if (addrs.length && has && saved.h === addrHash(addrs)) return { ok: true, addresses: addrs.length, unchanged: true };
    return await syncWebhook(env, store, site(env), addrs);
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
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
    const c = await pumpCoin(mint, 8000);
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
  '🫧 <b>pumpbubble buy bot</b>',
  '',
  '<b>Admins</b>',
  '/setup <code>&lt;contract address&gt;</code> — post every buy of a token: Solana, Base, Ethereum or Robinhood Chain',
  '/settings — buttons for the picture or GIF on buys, emoji, minimum buy, links, and 🛡 Guard: join captcha, welcome, clean joins',
  '/test — post a sample alert',
  '/welcome <code>text</code> — the welcome message; {name}, {group}, {sym} fill in',
  '/stop — stop posting here',
  '',
  '<b>Everyone</b>',
  '/status — what this group is tracking',
  '/boost, /ads — make the token gold on the map, or advertise it (in a private chat with me)',
  '',
  'Also for admins: /emoji 🟢 · /step 20 (dollars per emoji) · /minbuy 50 · /web, /x, /tg <code>&lt;url&gt;</code> · a photo, GIF or video with /media as its caption.',
  'A 0x address that trades on more than one chain: <code>/setup 0x… base</code>.',
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
    if (g) {
      await putGroup(store, msg.migrate_to_chat_id, { ...g, chatId: msg.migrate_to_chat_id });
      await removeGroup(store, msg.chat.id);
      if (g.mint) await addTracking(store, g.mint, g.pool, msg.migrate_to_chat_id);
      if (isChain(g.chain) && g.token && ctx.evm) {
        await ctx.evm(g.chain, 'untrack', { token: g.token, chatId: msg.chat.id }).catch(() => null);
        await ctx.evm(g.chain, 'track', { token: g.token, chatId: msg.migrate_to_chat_id }).catch(() => null);
      }
    }
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
  /* every group that adds the bot is remembered, set up or not, for the
     console: the ones that added it and never ran /setup are the follow-ups */
  if (ctx.audience) {
    const f = m.from || {};
    await ctx.audience('seenGroup', { group: { id: chat.id, title: chat.title, username: chat.username, type: chat.type, status,
      by: f.id, byName: [f.first_name, f.last_name].filter(Boolean).join(' '), byUser: f.username } }).catch(() => null);
  }
  if (status === 'left' || status === 'kicked') {
    /* an EVM token's watcher only notices a gone group when a buy happens —
       a quiet token was polled every few seconds for nobody */
    await untrackOld(ctx, chat.id, await getGroup(store, chat.id), '');
    await removeGroup(store, chat.id);
    await resync(ctx);
    return;
  }
  if (status === 'administrator' && ctx.launch && (m.old_chat_member && m.old_chat_member.status) !== 'administrator') {
    const p = await ctx.launch('pending', { chat: chat.id }).catch(() => null);
    if (p && p.ok) await bindGroup(ctx, chat.id, p.mint).catch(() => null);
  }
  if (status === 'member' || status === 'administrator') {
    const old = m.old_chat_member && m.old_chat_member.status;
    if (old === 'left' || old === 'kicked' || !old) {
      await say(env, chat.id,
        '🫧 <b>Thanks for adding me!</b>\n\n'
        + 'Admins: send <code>/setup &lt;contract address&gt;</code> and I will post every buy here.\n'
        + 'Then /settings for the picture on buys, emoji, minimum buy and the 🛡 join captcha.\n\n'
        + 'Type / to see all my commands.');
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
  const toWhale = hasMedia && !c && rt && rt.from && rt.from.is_bot
    && String(rt.text || '').startsWith(WHALE_PROMPT);
  if (hasMedia && ((c && c.cmd === 'whalemedia') || toWhale)) {
    if (!await isAdmin(env, msg)) return;
    const bot = await me(env, store).catch(() => null);
    if (toWhale && bot && bot.id && rt.from.id !== bot.id) return;
    const g = await getGroup(store, chatId);
    if (!g) return say(env, chatId, 'Run /setup first, then send the media.');
    await putGroup(store, chatId, { ...g, whaleMedia: mediaOf(msg) });
    return say(env, chatId, `🐳 Saved. Every buy of ${fmtUsd(whaleAt(g))} or more will carry this.`, settingsMarkup());
  }
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

  const ADMIN_CMDS = new Set(['setup', 'emoji', 'step', 'minbuy', 'web', 'x', 'tg', 'stop', 'test', 'media', 'whalemedia', 'settings', 'welcome']);
  /* t.me/<bot>?startgroup=setup_<address> — from a token's card, its page or
     the launch kit: the group is set up for that token the moment an admin
     adds the bot, nothing typed. Telegram delivers it as "/start <payload>". */
  const auto = c.cmd === 'start' && /^setup_([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/.exec(c.arg || '');
  if (auto && await isAdmin(env, msg)) return runSetup(ctx, msg, auto[1], '');
  /* startgroup=launch_<code>: the Launch Kit's creator making the token's
     official group — set up, and bound to the token's own /tg link */
  const claim = c.cmd === 'start' && /^launch_([1-9A-HJ-NP-Za-km-z]{12,24})$/.exec(c.arg || '');
  if (claim && await isAdmin(env, msg)) return launchGroup(ctx, msg, claim[1]);
  if (c.cmd === 'help' || c.cmd === 'start') return say(env, chatId, HELP);
  /* anyone may buy for the token; the purchase itself happens in private */
  if (c.cmd === 'boost' || c.cmd === 'ads' || c.cmd === 'ad') {
    const g0 = await getGroup(store, chatId);
    const bot = await me(env, store).catch(() => null);
    const ca = g0 && (g0.token || g0.mint);
    if (!bot || !bot.username) return;
    const start = c.cmd === 'boost' ? (ca ? 'boost_' + ca : 'boost') : (ca ? 'ad_' + ca : 'ads');
    return say(env, chatId, c.cmd === 'boost'
      ? '⚡ Golden bubbles on pumpbubble.fun — the token grows past everyone on the map. Pick a size in private:'
      : '📣 Ads: a slot on the map\u2019s rail, or a line under every buy alert in every group I\u2019m in. Pick one in private:',
      { reply_markup: { inline_keyboard: [[{ text: c.cmd === 'boost' ? '⚡ Boost' : '📣 See ad slots', url: 'https://t.me/' + bot.username + '?start=' + start }]] } });
  }
  if (c.cmd === 'status') {
    const g = await getGroup(store, chatId);
    if (!g) return say(env, chatId, 'Not tracking anything here yet. /setup <code>&lt;contract address&gt;</code>');
    return say(env, chatId,
      `Tracking <b>${tgEsc(g.sym)}</b> on ${tgEsc((CHAINS[g.chain] && CHAINS[g.chain].name) || 'Solana')}\n<code>${tgEsc(g.token || g.mint)}</code>\n`
      + `emoji ${tgEsc(g.emoji)} · step $${num(g.step)} · min buy $${num(g.minBuy)} · media ${g.media ? g.media.kind : 'none'}`,
      settingsMarkup());
  }
  if (!ADMIN_CMDS.has(c.cmd)) return;
  if (!await isAdmin(env, msg)) return say(env, chatId, 'Admins only.');

  if (c.cmd === 'setup') {
    const [addr = '', wantChain = ''] = c.arg.split(/\s+/);
    if (!isCA(addr)) return say(env, chatId, 'Send the contract address after the command:\n<code>/setup &lt;address&gt;</code>');
    return runSetup(ctx, msg, addr, wantChain);
  }

  const g = await getGroup(store, chatId);
  if (!g) return say(env, chatId, 'Run /setup <code>&lt;contract address&gt;</code> first.');
  return groupCommand(ctx, msg, c, g);
}

/* The Launch Kit's group: the one-time code becomes the token, the group is
   set up for it (a token seconds old may not be on pump.fun's API yet, so
   it is asked a few times), and the group becomes the token's official one. */
async function launchGroup(ctx, msg, code) {
  const { env } = ctx, chatId = msg.chat.id;
  const r = ctx.launch ? await ctx.launch('useClaim', { code }).catch(() => null) : null;
  if (!r || !r.ok) return say(env, chatId, 'This launch link was used already or has expired. <code>/setup &lt;address&gt;</code> sets me up for any token.');
  for (let i = 0; i < 4 && !(await resolveAnyToken(r.mint, env.IMG_SECRET).catch(() => null)); i++) await new Promise(ok => setTimeout(ok, 2500));
  await runSetup(ctx, msg, r.mint, '');
  return bindGroup(ctx, chatId, r.mint);
}

/* The group becomes what the token's own pumpbubble.fun/tg/<mint> opens: an
   invite link the bot makes, the token's picture as the group's, and a
   pinned welcome. Without admin rights yet, it waits for them. */
export async function bindGroup(ctx, chatId, mint) {
  const { env } = ctx;
  let invite = '';
  try { invite = (await tg(env, 'createChatInviteLink', { chat_id: chatId, name: 'pumpbubble' })).invite_link || ''; } catch { /* not an admin yet */ }
  if (!invite) {
    if (ctx.launch) await ctx.launch('pend', { chat: chatId, mint }).catch(() => null);
    return say(env, chatId, 'Make me an admin (with "Invite users") and this becomes your token\u2019s official group — the Telegram link in its pump.fun page will open it.');
  }
  if (ctx.launch) {
    await ctx.launch('setLinks', { mint, patch: { invite, chat: chatId } }).catch(() => null);
    await ctx.launch('clearPending', { chat: chatId }).catch(() => null);
  }
  const t = await resolveAnyToken(mint, env.IMG_SECRET).catch(() => null);
  const sym = (t && t.sym) || 'TOKEN';
  /* the token's picture as the group's, when the bot may change it */
  try {
    const raw = await pumpCoin(mint).catch(() => null);
    const src = raw && typeof raw.image_uri === 'string' && /^https:\/\//.test(raw.image_uri) ? raw.image_uri : '';
    if (src) {
      const res = await fetch(src, { signal: AbortSignal.timeout(8000) });
      const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      if (bytes && bytes.length > 100 && bytes.length < 5e6) await tgUpload(env, 'setChatPhoto', { chat_id: chatId }, 'photo', bytes, 'token.png').catch(() => null);
    }
  } catch { /* the group keeps its own picture */ }
  const page = site(env) + '/t/' + mint;
  const sent = await say(env, chatId,
    `\u{1FAE7} <b>The official $${tgEsc(sym)} group</b>\n\n`
    + `The Telegram link on $${tgEsc(sym)}\u2019s pump.fun page opens this group. Buys post here as they happen.\n\n`
    + `<a href="${page}">Token page</a> \u00b7 <a href="https://pump.fun/coin/${mint}">pump.fun</a>`,
    { reply_markup: { inline_keyboard: [[{ text: '\u{1F7E2} Buy $' + sym, url: site(env) + '/swap?mint=' + mint }, { text: '\u{1F4C8} Chart', url: 'https://pump.fun/coin/' + mint }]] } });
  if (sent && sent.message_id) await tg(env, 'pinChatMessage', { chat_id: chatId, message_id: sent.message_id, disable_notification: true }).catch(() => null);
  return sent;
}

/* A setup that broke half-way used to say nothing at all — the webhook
   swallows errors — so an admin could only report that it "does not work".
   Now the group is told which step failed, and the log says it too. */
async function runSetup(ctx, msg, addr, wantChain) {
  const { env } = ctx, chatId = msg.chat.id;
  try {
    return await setupToken(ctx, msg, addr, wantChain);
  } catch (e) {
    const why = String((e && e.message) || e).replace(/bot\d+:[\w-]+/g, 'bot…').slice(0, 200);
    console.log(JSON.stringify({ ev: 'tg-setup-error', chat: chatId, addr, error: why }));
    return say(env, chatId, `⚠️ Setup did not finish: <code>${tgEsc(why)}</code>\n`
      + `Run /setup <code>${tgEsc(addr)}</code> in a minute — if it fails again, tell us in <a href="${community(env)}">our Telegram group</a>.`);
  }
}

async function setupToken(ctx, msg, addr, wantChain) {
  const { env, store } = ctx;
  const chatId = msg.chat.id;
  {
    if (isEvmAddr(addr)) return setupEvm(ctx, msg, addr.toLowerCase(), wantChain.toLowerCase());
    const t = await resolveAnyToken(addr, env.IMG_SECRET);
    if (!t) return say(env, chatId, 'No token found at that address.');
    if (t.chain && t.chain !== 'solana') return say(env, chatId, 'Buy alerts are Solana-only for now.');
    const { pool, socials } = await poolAndSocials(addr);
    const prev = await getGroup(store, chatId);
    await untrackOld(ctx, chatId, prev, 'solana:' + addr);
    /* Switching to a different token keeps the group's own choices (emoji,
       step, minimum, the guard) and drops what belonged to the old token —
       its links and its picture — or the new token's buys would link to the
       old one's X account. Re-running /setup on the same token keeps it all. */
    const same = !!(prev && prev.mint === addr);
    const cfg = {
      chatId, mint: addr, pool, chain: 'solana', token: '',
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
    /* polled (the default): wake the Solana watcher so the first buy lands in
       seconds, not on its next read of the list; Helius has nothing to do */
    const polled = solPolling(env);
    if (polled && ctx.sol) await ctx.sol('track').catch(() => null);
    const sync = polled ? { ok: true } : await resync(ctx);
    const head = await tapHeadStart(ctx, { mint: addr, chain: 'solana', sym: cfg.sym, name: cfg.name, img: t.img || '', mcap: t.mcap || 0 })
      + await welcomeLine(ctx, cfg, { mint: addr, chain: 'solana', sym: cfg.sym, name: cfg.name, img: t.img || '', mcap: t.mcap || 0 });
    const warn = sync && sync.ok ? '' : `\n\n⚠️ Saved, but the buy feed could not be registered: ${tgEsc(sync && sync.error || 'unknown')}`;
    /* graduation comes from pump.fun's own flag, not from whether a pool
       lookup happened to answer */
    return say(env, chatId,
      `✅ Tracking <b>${tgEsc(cfg.sym)}</b> — ${tgEsc(cfg.name)}\n`
      + `MCap ${fmtUsd(t.mcap)} · ${t.grad === false ? 'bonding curve' : 'graduated'}\n\n`
      + head
      + 'Set the picture, emoji and minimum buy with the buttons below.\n'
      + `Questions or ideas: <a href="${community(env)}">our Telegram group</a> · news on <a href="${xProfile(env)}">X</a>.` + warn,
      settingsMarkup());
  }
}

/* Every admin command but /setup, on a group that has run it. */
async function groupCommand(ctx, msg, c, g) {
  const { env, store } = ctx;
  const chatId = msg.chat.id;
  if (c.cmd === 'stop') {
    await untrackOld(ctx, chatId, g, '');
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

async function sendTest(ctx, chatId, g, { whale = false } = {}) {
  const { env, store } = ctx;
  /* a whale test is a buy a fifth over the group's whale line, so the
     headline, the whale media and the 🐳 reaction all show */
  const wantUsd = whale ? whaleAt(g) * 1.2 : 0;
  const opts = usd => ({ whale: usd >= whaleAt(g), react: buyReaction({ usd, group: g }) });
  if (isChain(g.chain)) {
    const eth = await evmEthUsd();
    const t = await tokenInfo(env, g.token);
    const price = num(t && t.price);
    const amt = whale && eth > 0 ? wantUsd / eth : 0.05;
    const buy = { sol: amt, usd: amt * eth, tokens: price > 0 && eth > 0 ? (amt * eth) / price : 1_000_000, buyer: '', sig: '' };
    const bot = await me(env, store).catch(() => ({ username: '' }));
    const token = { sym: g.sym, mcap: t && t.mcap, addr: g.token };
    const { caption, keyboard } = formatBuy({ buy, token, group: g, solUsd: eth, botName: bot.username, env, test: true, ad: await alertAd(store) });
    return sendAlert(env, store, chatId, g, caption, keyboard, { ...opts(buy.usd),
      card: buyCardSpec({ buy: { ...buy, newHolder: true }, token: { ...token, img: (t && t.img) || '' }, usd: buy.usd, payWith: 'ETH', whale: buy.usd >= whaleAt(g) }) });
  }
  const t = await tokenInfo(env, g.mint);
  const solUsd = num(ctx.solUsd);
  const price = num(t && t.price);
  const sol = whale && solUsd > 0 ? wantUsd / solUsd : 0.5;
  const buy = {
    sol, tokens: price > 0 && solUsd > 0 ? (sol * solUsd) / price : 1_000_000,
    buyer: '', sig: '', newHolder: true,
  };
  const bot = await me(env, store).catch(() => ({ username: '' }));
  const { caption, keyboard } = formatBuy({ buy, token: t || g, group: g, solUsd, botName: bot.username, env, test: true, ad: await alertAd(store) });
  return sendAlert(env, store, chatId, g, caption, keyboard, { ...opts(sol * solUsd),
    card: buyCardSpec({ buy, token: t || g, usd: sol * solUsd, payWith: 'SOL', whale: sol * solUsd >= whaleAt(g) }) });
}

/* ================================================================ EVM */
/* /setup with a 0x address. The chain is where the token trades deepest
   among Base, Ethereum and Robinhood Chain, unless the admin names one; the
   pools come from DexScreener once, here, and after that the chain's
   EvmWatch Durable Object reads swaps straight from the chain. */
async function setupEvm(ctx, msg, addr, want) {
  const { env, store } = ctx;
  const chatId = msg.chat.id;
  if (!ctx.evm) return say(env, chatId, 'Buy alerts for Base, Ethereum and Robinhood Chain are not switched on in this deployment.');
  let pairs = null;
  try {
    const r = await fetch(DEXS + '/latest/dex/tokens/' + addr, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
    if (r.ok) pairs = ((await r.json()) || {}).pairs || [];
  } catch {}
  if (!pairs) return say(env, chatId, 'Could not reach DexScreener to find this token\u2019s pools — try again in a minute.');
  const liq = p => (p && p.liquidity && p.liquidity.usd) || 0;
  const onChain = pairs.filter(p => isChain(p.chainId));
  if (!onChain.length) return say(env, chatId, 'No pools found for that address on ' + Object.values(CHAINS).map(c => c.name).join(', ') + '.');
  let chain = isChain(want) ? want : '';
  if (!chain) {
    const depth = {};
    for (const p of onChain) depth[p.chainId] = (depth[p.chainId] || 0) + liq(p);
    chain = Object.entries(depth).sort((a, b) => b[1] - a[1])[0][0];
  }
  const mine = onChain.filter(p => p.chainId === chain).sort((a, b) => liq(b) - liq(a));
  if (!mine.length) return say(env, chatId, `No pools on ${CHAINS[chain].name} for that address.`);
  const pools = poolsFrom(mine, addr, chain);
  if (!pools.length) return say(env, chatId, `Found it on ${CHAINS[chain].name}, but none of its pools trade against ETH or a dollar stablecoin, so its buys cannot be priced yet.`);
  const facts = await tokenFacts(chain, addr, env).catch(() => ({ dec: 18, supply: 0 }));
  const top = mine[0];
  const me_ = String(top.baseToken && top.baseToken.address || '').toLowerCase() === addr ? top.baseToken : top.quoteToken;
  const info = top.info || {};
  const socials = {};
  const web = (info.websites || []).map(w => okUrl(w && w.url)).find(Boolean);
  if (web) socials.web = web;
  for (const s of info.socials || []) {
    const u = okUrl(s && s.url);
    if (u && s.type === 'twitter' && !socials.x) socials.x = u;
    if (u && s.type === 'telegram' && !socials.tg) socials.tg = u;
  }
  const prev = await getGroup(store, chatId);
  const same = !!(prev && prev.chain === chain && prev.token === addr);
  await untrackOld(ctx, chatId, prev, chain + ':' + addr);
  const cfg = {
    chatId, chain, token: addr, mint: '', pool: '',
    sym: clean(me_ && me_.symbol, 12) || '?', name: clean(me_ && (me_.name || me_.symbol), 48) || 'unknown',
    socials: { ...(same && prev.socials || {}), ...socials },
    emoji: (prev && prev.emoji) || '🟢',
    step: (prev && prev.step) || 20,
    minBuy: (prev && prev.minBuy) || 0,
    media: (same && prev.media) || null,
    ...(prev && prev.guard ? { guard: prev.guard } : {}),
    by: msg.from && msg.from.id, at: Date.now(),
  };
  await putGroup(store, chatId, cfg);
  const r = await ctx.evm(chain, 'track', { token: addr, chatId, meta: { sym: cfg.sym, dec: facts.dec, supply: facts.supply, pools } })
    .catch(e => ({ ok: false, error: String(e && e.message || e) }));
  const warn = r && r.ok ? '' : `\n\n⚠️ Saved, but the ${CHAINS[chain].name} watcher did not answer: ${tgEsc(r && r.error || 'unknown')}`;
  const head = await tapHeadStart(ctx, { addr, chain, sym: cfg.sym, name: cfg.name, mcap: num(top.marketCap) || num(top.fdv) })
    + await welcomeLine(ctx, cfg, { addr, chain, sym: cfg.sym, name: cfg.name, img: okUrl(info.imageUrl) || '', mcap: num(top.marketCap) || num(top.fdv) });
  const dexes = [...new Set(pools.map(p => p.dex).filter(Boolean))].join(', ');
  return say(env, chatId,
    `✅ Tracking <b>${tgEsc(cfg.sym)}</b> — ${tgEsc(cfg.name)} on ${CHAINS[chain].name}\n`
    + `MCap ${fmtUsd(num(top.marketCap) || num(top.fdv))} · watching ${pools.length} pool${pools.length > 1 ? 's' : ''}${dexes ? ' (' + tgEsc(dexes) + ')' : ''}\n\n`
    + head
    + 'Set the picture, emoji and minimum buy with the buttons below.\n'
    + `Questions or ideas: <a href="${community(env)}">our Telegram group</a> · news on <a href="${xProfile(env)}">X</a>.` + warn,
    settingsMarkup());
}

/* Tap wars' head start for a token whose group installed the bot — the
   reason for a project to pick us over another buy bot. Once per token. */
async function tapHeadStart(ctx, tok) {
  if (!ctx.arena) return '';
  const r = await ctx.arena('grant', { tok, n: BOT_BONUS }).catch(() => null);
  if (!r || !r.ok || !r.granted) return '';
  return `🫧 <b>Entered Tap wars</b> on pumpbubble.fun with a ${r.granted.toLocaleString('en-US')}-tap head start — `
    + `get your community tapping: 1,000 taps wins a free ad slot, 5,000 a golden bubble.\n`
    + `<a href="${site(ctx.env)}/?source=taps">Tap for ${tgEsc(tok.sym)}</a>\n\n`;
}

/* The welcome gift (boosts.mjs welcomeGold): gold on the map for an hour,
   once per token — the line in the setup reply a project screenshots. */
async function welcomeLine(ctx, g, tok) {
  let r = null;
  try { r = await welcomeGold(ctx.store, tok); } catch { r = null; }
  if (!r || !r.ok) return '';
  const L = tokenLinks(ctx.env, g, tok);
  return `✨ <b>Welcome gift</b>: $${tgEsc(tok.sym)} is gold on pumpbubble.fun for the next hour. `
    + `<a href="${L.bubble}">See it on the map</a> — screenshot it for your community.

`;
}

/* Stop following whatever this group followed before, unless it is the same
   token (`key` is chain:address). Solana leaves the Helius list; EVM leaves
   its chain's watcher. */
async function untrackOld(ctx, chatId, prev, key) {
  if (!prev) return;
  const evm = isChain(prev.chain) && prev.token;
  const prevKey = evm ? prev.chain + ':' + prev.token : prev.mint ? 'solana:' + prev.mint : '';
  if (!prevKey || prevKey === key) return;
  if (evm) { if (ctx.evm) await ctx.evm(prev.chain, 'untrack', { token: prev.token, chatId }).catch(() => null); }
  else { await dropTracking(ctx.store, prev.mint, chatId); if (key) await resync(ctx); }
}

/* Called by a chain's EvmWatch with the buys of one poll. Returns what it
   sent and any chat that no longer follows the token, so the watcher can
   drop it — the watcher's own list heals itself instead of trusting that
   every stop reached it. */
export async function onEvmBuys(ctx, chain, buys, chatsByToken, ethPrice) {
  const { env, store } = ctx;
  let sent = 0;
  const stale = [];
  const bot = await me(env, store).catch(() => ({ username: '' }));
  for (const b of buys || []) {
    for (const chatId of (chatsByToken && chatsByToken[b.token]) || []) {
      const g = await getGroup(store, chatId);
      if (!g || g.chain !== chain || g.token !== b.token) { stale.push({ token: b.token, chatId }); continue; }
      if (num(g.minBuy) > 0 && b.usd < num(g.minBuy)) continue;
      if (!allowed(chatId)) continue;
      const buy = { sol: b.eth, usd: b.usd, tokens: b.tokens, buyer: b.buyer || '', sig: b.tx };
      const token = { sym: g.sym, mcap: b.mcap, addr: b.token };
      const { caption, keyboard } = formatBuy({ buy, token, group: g, solUsd: ethPrice, botName: bot.username, env, ad: await alertAd(store) });
      const art = await tokenInfo(env, b.token).catch(() => null);
      if (await sendAlert(env, store, chatId, g, caption, keyboard,
        { whale: num(b.usd) >= whaleAt(g), react: buyReaction({ usd: b.usd, group: g }),
          card: buyCardSpec({ buy, token: { ...token, img: (art && art.img) || '' }, usd: num(b.usd), payWith: 'ETH', whale: num(b.usd) >= whaleAt(g) }) })) {
        sent++;
        if (b.ts) {
          const lat = Date.now() / 1000 - b.ts;
          LAT.push(lat); if (LAT.length > 100) LAT.shift();
          console.log(JSON.stringify({ ev: 'buy-alert', chain, sym: g.sym, latencyS: +lat.toFixed(1) }));
        }
      }
    }
  }
  return { sent, stale };
}

/* ================================================================== shop */
/* Boosts and ads, bought in a private chat with the bot through the very
   routes the site uses (ctx.self → /api/boost/order, /api/boost/sweep): one
   order system, one gold-share cap, one sweep, one treasury. Nothing here
   prices anything itself. */

const when = t => new Date(t).toUTCString().replace(/^\w+, /, '').replace(/:\d\d GMT$/, ' UTC');

async function askForToken(ctx, chatId, what) {
  return say(ctx.env, chatId, (what === 'boost'
    ? '⚡ <b>Boost a token</b> — its bubble turns gold and grows past everyone on pumpbubble.fun.'
    : '📣 <b>Advertise</b> — a slot on the map\u2019s rail, or a line under every buy alert in every group I\u2019m in.')
    + '\n\nSend me the token\u2019s contract address — Solana, Base, Ethereum or Robinhood Chain.');
}

export function shopKeyboard(ca, what = '') {
  const b = Object.values(BOOST_TIERS).map(t => ({ text: `⚡ ${t.label} $${t.usd} · ×${t.mult} · ${t.hours}h`, callback_data: `buy:b:${t.id}:${ca}` }));
  const a = Object.values(AD_TIERS).map(t => ({ text: t.review ? `📨 ${t.label} $${t.usd} · to everyone on my list` : `📣 ${t.label} $${t.usd} · ${t.hours}h`, callback_data: `buy:a:${t.id}:${ca}` }));
  return what === 'ad' ? [...a.map(x => [x]), ...b.map(x => [x])] : [...b.map(x => [x]), ...a.map(x => [x])];
}

async function shopFor(ctx, chatId, ca, what = '') {
  const { env } = ctx;
  const t = await resolveAnyToken(isEvmAddr(ca) ? ca.toLowerCase() : ca, env.IMG_SECRET).catch(() => null);
  if (!t) {
    if (isMint(ca)) return say(env, chatId, 'That is not a token I can find — is it a wallet? I can tell you every time it buys or sells.',
      { reply_markup: { inline_keyboard: [[{ text: '👛 Track this wallet', callback_data: 'trk:add:' + ca }]] } });
    return say(env, chatId, 'No token found at that address. Check it and send it again.');
  }
  const chain = (CHAINS[t.chain] && CHAINS[t.chain].name) || (t.chain === 'solana' || !t.chain ? 'Solana' : t.chain);
  const key = isEvmAddr(ca) ? ca.toLowerCase() : ca;
  /* Somebody pasting a token may want to buy it, not promote it: the swap
     and the chart come first, the shop below them. */
  const top = isMint(key)
    ? [[{ text: '🛒 Buy $' + clean(t.sym, 12), url: buyOrSwap(env, site(env), key) },
        { text: '📊 Chart', url: (t.grad === false ? 'https://pump.fun/coin/' : 'https://dexscreener.com/solana/') + encodeURIComponent(key) }]]
    : [[...(swapPath(t.chain, key) ? [{ text: '🛒 Buy $' + clean(t.sym, 12), url: site(env) + swapPath(t.chain, key) }] : []),
        { text: '📊 Chart', url: 'https://dexscreener.com/' + encodeURIComponent((CHAINS[t.chain] && CHAINS[t.chain].dex) || t.chain || 'ethereum') + '/' + encodeURIComponent(key) }]];
  return say(env, chatId,
    `<b>$${tgEsc(t.sym)}</b> — ${tgEsc(t.name)} · ${tgEsc(chain)}${t.mcap ? ' · MCap ' + fmtUsd(t.mcap) : ''}\n\n`
    + (isMint(key) || swapPath(t.chain, key) ? '🛒 Buy it from your own wallet, or promote it:\n\n' : 'Promote it:\n\n')
    + '⚡ <b>Boost</b>: a golden bubble on the map, sized by what was paid, fading over its hours.\n'
    + '📣 <b>Map ad</b>: a slot on the moving rail above the map.\n'
    + '📣 <b>Buy-alert ad</b>: your token on a line under every buy alert, in every group I post in.\n'
    + '📨 <b>DM blast</b>: your token in a sponsored DM to everyone on my list' + (await audienceLine(ctx)) + ', sent after review.\n\n'
    + 'Promotions are paid in SOL.',
    { reply_markup: { inline_keyboard: [...top, ...shopKeyboard(key, what), [MENU_BTN]] } });
}

async function onShop(ctx, q, data) {
  const { env, store } = ctx;
  const chatId = q.message && q.message.chat && q.message.chat.id;
  const ack = (text, alert = false) => tg(env, 'answerCallbackQuery',
    { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  if (!chatId) return ack();
  if (data === 'shop:boost' || data === 'shop:ads') { await ack(); return askForToken(ctx, chatId, data === 'shop:boost' ? 'boost' : 'ads'); }

  if (data.startsWith('buy:')) {
    const [, kind, tier, ca] = data.split(':');
    if (!isCA(ca || '') || !ctx.self) return ack('Try again in a moment.', true);
    await ack('Making your quote…');
    const r = await ctx.self('/api/boost/order', {
      mint: ca, tier, kind: kind === 'a' ? 'ad' : 'boost', notify: chatId,
    }, String(q.from.id)).catch(() => null);
    if (!r || !r.ok) return say(env, chatId, '⚠️ ' + tgEsc((r && r.error) || 'Could not make a quote right now — try again in a minute.'));
    const o = r.order;
    const head = o.kind === 'ad' && o.tier === 'dm'
      ? `📨 <b>DM blast for $${tgEsc(o.sym)}</b> — one sponsored DM to everyone on my list${await audienceLine(ctx)}, sent once it is reviewed`
      : o.kind === 'ad'
      ? `📣 <b>${tgEsc(AD_TIERS[o.tier] ? AD_TIERS[o.tier].label : 'Ad')} for $${tgEsc(o.sym)}</b> — ${o.hours}h, `
        + (o.startsAt && o.startsAt > Date.now() + 60_000 ? 'starts ' + when(o.startsAt) : 'starts as soon as it is paid')
      : `⚡ <b>Boost $${tgEsc(o.sym)}</b> — ${tgEsc(o.tier)} ×${o.projection ? o.projection.to : o.mult} for ${o.hours}h`;
    return say(env, chatId,
      `${head}\n\n$${o.usd} — send exactly\n<code>${o.amountSol}</code> SOL\nto\n<code>${tgEsc(o.treasury)}</code>\n\n`
      + 'The exact amount is how your payment is found — send exactly it, in one transfer, from any wallet. '
      + 'Tap the amount and the address to copy them. Quote valid 30 minutes; a payment is matched for 24 hours, '
      + 'and I will message you here when it lands.',
      { reply_markup: { inline_keyboard: [[{ text: '✅ I\u2019ve paid — check', callback_data: 'chk:' + o.id }]] } });
  }

  if (data.startsWith('chk:')) {
    const id = data.slice(4);
    if (!/^ord_[A-Za-z0-9]{1,24}$/.test(id)) return ack();
    /* the same sweep the cron runs: finds the payment, activates, notifies */
    if (ctx.self) await ctx.self('/api/boost/sweep', null, String(q.from.id)).catch(() => null);
    const found = await paidById(store, id);
    if (!found) return ack('Not seen yet. Payments show within a minute or so of confirming — I will message you when it lands.', true);
    await ack('✅ Paid');
    return tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: '✅ Paid', callback_data: 'chk:' + id }]] } }).catch(() => null);
  }
  return ack();
}

async function audienceLine(ctx) {
  const r = ctx.audience ? await ctx.audience('count').catch(() => null) : null;
  return r && r.count ? ` (${r.count.toLocaleString('en-US')} people now)` : '';
}

async function paidById(store, id) {
  for (const key of ['boosts', 'ads', 'alertads', 'dmads']) {
    let list = [];
    try { list = (await store.get(key)) || []; } catch {}
    const hit = list.find(x => x && x.id === id);
    if (hit) return hit;
  }
  return null;
}

/* Called by the sweep for anything bought from the bot. */
export async function notifyPaid(env, b) {
  const chat = num(b && b.notify);
  if (!chat) return null;
  const origin = site(env);
  let text;
  if (b.kind === 'ad' && b.slot === 'dm') {
    text = `✅ <b>Payment received</b> — your DM blast for ${tgEsc(b.title)} is in review and goes out once approved. I will not charge twice if it is declined: the operator refunds it.`;
  } else if (b.kind === 'ad') {
    const t = AD_TIERS[b.slot];
    text = `✅ <b>Payment received</b> — your ${tgEsc(t ? t.label : 'ad')} for ${tgEsc(b.title)} `
      + (b.from > Date.now() + 60_000 ? `starts ${when(b.from)}` : 'is live now') + `, until ${when(b.until)}.`;
  } else {
    const link = isMint(b.mint) ? `\n\n🫧 <a href="${origin}/s/${encodeURIComponent(b.mint)}">See it on the map</a>` : `\n\n🫧 <a href="${origin}">See it on the map</a>`;
    text = `✅ <b>Payment received</b> — $${tgEsc(b.sym)} is gold on the map at ×${b.mult} until ${when(b.until)}.${link}`;
  }
  return tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

/* The paid line under buy alerts, read through a minute's cache. */
let adMem = { at: 0, v: null };
export async function alertAd(store) {
  const now = Date.now();
  if (now - adMem.at < 60_000) return adMem.v;
  let list = [];
  try { list = (await store.get('alertads')) || []; } catch {}
  const v = list.find(a => a && (a.from || 0) <= now && a.until > now) || null;
  adMem = { at: now, v };
  return v;
}

/* ======================================================== wallet tracker */
/* Track any Solana wallet, or pump.fun's top traders as one switch, and get
   every buy and sell in a private chat with ⚡ Copy buy — the trade opens in
   the trading bot or swap the Buy button already uses, so nothing here ever
   holds a key or anyone's money. The wallets ride the buybot's Helius webhook
   (watchAddresses); a swap is read off balances (parseWalletSwaps). */

async function trackerMenu(ctx, chatId, uid, messageId = 0) {
  const { env } = ctx;
  if (!ctx.audience) return say(env, chatId, 'The wallet tracker is not switched on in this deployment.');
  const [f, s] = await Promise.all([ctx.audience('following', { id: uid }), ctx.audience('isSmart', { id: uid })]);
  const list = (f && f.list) || [];
  const smart = !!(s && s.smart);
  const text = '👛 <b>Wallet tracker</b>\n\n'
    + `🧠 Top traders: ${smart ? '✅ following pump.fun\u2019s top 300 by realized profit' : '⬜ off'}\n`
    + (list.length ? list.map(x => `• ${tgEsc(x.label || x.wallet.slice(0, 4) + '…' + x.wallet.slice(-4))} <code>${tgEsc(x.wallet)}</code>`).join('\n') : '• no wallets yet')
    + `\n\nAdd one: <code>/track WALLET name</code> — up to ${MAX_FOLLOWS}. Every buy and sell arrives here with ⚡ Copy buy.`;
  const kb = [
    [{ text: (smart ? '✅' : '⬜') + ' Follow top traders', callback_data: 'trk:smart' }],
    ...list.map(x => [{ text: '✖ ' + (x.label || x.wallet.slice(0, 6) + '…'), callback_data: 'trk:rm:' + x.wallet }]),
  ];
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: kb } };
  if (messageId) return tg(env, 'editMessageText', { ...payload, message_id: messageId }).catch(() => null);
  return tg(env, 'sendMessage', payload).catch(() => null);
}

async function trackWallet(ctx, chatId, uid, wallet, label) {
  const { env } = ctx;
  if (!ctx.audience) return say(env, chatId, 'The wallet tracker is not switched on in this deployment.');
  if (!isMint(wallet)) return say(env, chatId, 'Send a Solana wallet address: <code>/track WALLET name</code>');
  const r = await ctx.audience('follow', { id: uid, wallet, label: clean(label || '', 24) }).catch(() => null);
  if (!r || !r.ok) return say(env, chatId, '⚠️ ' + tgEsc((r && r.error) || 'Could not save that — try again.'));
  const sync = await resync(ctx);
  const smart = (await smartWallets().catch(() => null))?.get(wallet);
  return say(env, chatId,
    `👛 Tracking <code>${tgEsc(wallet)}</code>${label ? ' as <b>' + tgEsc(clean(label, 24)) + '</b>' : ''}.`
    + (smart ? `\n🧠 That is ${tgEsc(smart.name)}, #${smart.rank} on pump.fun ${tgEsc(smart.when)} by profit banked.` : '')
    + '\n\nEvery buy and sell arrives here.' + (sync && sync.ok ? '' : '\n\n⚠️ Saved, but the feed did not update yet: ' + tgEsc(sync && sync.error || '')),
    { reply_markup: { inline_keyboard: [[{ text: '👛 My wallets', callback_data: 'trk:menu' }]] } });
}

async function onTracker(ctx, q, act) {
  const { env } = ctx;
  const chatId = q.message && q.message.chat && q.message.chat.id;
  const uid = q.from.id;
  const ack = (text, alert = false) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  if (!chatId || !ctx.audience) return ack();
  if (act === 'menu') { await ack(); return trackerMenu(ctx, chatId, uid); }
  if (act === 'smart') {
    const now = !((await ctx.audience('isSmart', { id: uid })) || {}).smart;
    await ctx.audience('smart', { id: uid, on: now });
    await resync(ctx);
    await ack(now ? '🧠 Following pump.fun\u2019s top traders — their buys and sells arrive here.' : 'Stopped following the top traders.', true);
    return trackerMenu(ctx, chatId, uid, q.message.chat.type === 'private' && q.message.text && q.message.text.startsWith('👛') ? q.message.message_id : 0);
  }
  if (act === 'smartoff') {
    await ctx.audience('smart', { id: uid, on: false });
    await resync(ctx);
    return ack('Stopped the top-trader alerts. /wallets to turn them back on.', true);
  }
  if (act.startsWith('rm:')) {
    await ctx.audience('unfollow', { id: uid, wallet: act.slice(3) });
    await resync(ctx);
    await ack('Removed');
    return trackerMenu(ctx, chatId, uid, q.message.message_id);
  }
  if (act.startsWith('add:')) { await ack(); return trackWallet(ctx, chatId, uid, act.slice(4), ''); }
  return ack();
}

/* One Helius delivery, read for the tracker: who followed the wallet, who
   follows the top traders, and the public channel. Per person, twenty alerts
   a minute at most — the overflow is dropped, like the groups' feed. */
const userSent = new Map();
function allowedUser(uid) {
  const now = Date.now();
  const arr = (userSent.get(uid) || []).filter(t => now - t < 60_000);
  if (arr.length >= 20) { userSent.set(uid, arr); return false; }
  arr.push(now); userSent.set(uid, arr);
  if (userSent.size > 5000) userSent.delete(userSent.keys().next().value);
  return true;
}

let routeMem = { at: 0, wallets: new Set(), fans: [] };
async function trackerRoute(ctx) {
  if (Date.now() - routeMem.at < 60_000) return routeMem;
  const [w, f] = await Promise.all([ctx.audience('wallets').catch(() => null), ctx.audience('smartFans').catch(() => null)]);
  routeMem = { at: Date.now(), wallets: new Set((w && w.list) || []), fans: (f && f.list) || [] };
  return routeMem;
}

export function formatSwap({ s, token, who, smart, env = {}, solUsd = 0 }) {
  const sym = clean(token.sym || '?', 12);
  const usd = s.sol * num(solUsd);
  const L = tokenLinks(env, { mint: s.mint, sym }, token);
  const head = s.side === 'buy' ? '🟢 <b>BUY</b>' : '🔴 <b>SELL</b>';
  const name = smart ? `🧠 ${tgEsc(smart.xh && /^\w{1,15}$/.test(smart.xh) ? '@' + smart.xh : clean(smart.name || '', 20))} · #${Math.floor(smart.rank)} on pump.fun ${tgEsc(smart.when || '')}`
    : `👛 <b>${tgEsc(who || (s.wallet.slice(0, 4) + '…' + s.wallet.slice(-4)))}</b>`;
  const lines = [
    `${head} · ${name}`,
    '',
    s.side === 'buy'
      ? `${fmtSol(s.sol)} SOL${usd > 0 ? ' (' + fmtUsd(usd) + ')' : ''} → ${fmtQty(s.tokens)} <b>$${tgEsc(sym)}</b>${s.newHolder ? ' · 🆕 first buy' : ''}`
      : `${fmtQty(s.tokens)} <b>$${tgEsc(sym)}</b> → ${fmtSol(s.sol)} SOL${usd > 0 ? ' (' + fmtUsd(usd) + ')' : ''}${s.closed ? ' · sold all' : ''}`,
    `${num(token.mcap) > 0 ? 'MCap ' + fmtUsd(token.mcap) + ' · ' : ''}`
      + (/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(s.sig || '') ? `<a href="https://solscan.io/tx/${s.sig}">Tx</a> · ` : '')
      + `<a href="https://solscan.io/account/${s.wallet}">Wallet</a>`,
  ];
  const keyboard = { inline_keyboard: [
    [{ text: '⚡ Copy buy', url: L.buy }, { text: '📊 Chart', url: L.chart }],
    [{ text: '🫧 Bubble', url: L.bubble }],
  ] };
  return { text: lines.join('\n'), keyboard };
}

async function onWalletTrades(ctx, payload, solUsd) {
  const { env, store } = ctx;
  if (!ctx.audience) return { swaps: 0, dms: 0 };
  const route = await trackerRoute(ctx);
  let channel = null;
  try { channel = await store.get(K.channel); } catch {}
  const smartMap = (route.fans.length || channel) ? topSmart(await smartWallets().catch(() => new Map())) : new Map();
  const watch = new Set([...route.wallets, ...smartMap.keys()]);
  if (!watch.size) return { swaps: 0, dms: 0 };
  const swaps = walletSwapsFromPayload(payload, watch);
  let dms = 0;
  for (const s of swaps) {
    if (!fresh('w:' + s.sig + ':' + s.wallet)) continue;
    const token = (await tokenInfo(env, s.mint)) || { mint: s.mint };
    const smart = smartMap.get(s.wallet) || null;
    /* a wallet someone tracks by name: every trade, to them — a handful of
       people, sent here; capped per person like the groups' feed */
    const named = new Set();
    if (route.wallets.has(s.wallet)) {
      const r = await ctx.audience('route', { wallets: [s.wallet] }).catch(() => null);
      for (const x of ((r && r.by && r.by[s.wallet]) || []).slice(0, 25)) {
        named.add(x.uid);
        if (!allowedUser(x.uid)) continue;
        const { text, keyboard } = formatSwap({ s, token, who: x.label, smart: x.label ? null : smart, env, solUsd });
        try {
          await tg(env, 'sendMessage', { chat_id: x.uid, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard });
          dms++;
        } catch (e) {
          if (/blocked|deactivated|chat not found/i.test(String(e.description || e.message))) await ctx.audience('purge', { id: x.uid }).catch(() => null);
        }
      }
    }
    /* followers of the top traders: entries and full exits only, handed to
       the audience object's paced queue — never a loop over every follower
       inside this request */
    if (smart && smartSignal(s)) {
      const uids = route.fans.filter(u => !named.has(u));
      if (uids.length) {
        const { text, keyboard } = formatSwap({ s, token, smart, env, solUsd });
        const buttons = [...keyboard.inline_keyboard, [{ text: '🔕 Stop top-trader alerts', callback_data: 'trk:smartoff' }]];
        const q = await ctx.audience('fanout', { uids, html: text, buttons }).catch(() => null);
        if (q && q.ok) dms += q.queued;
      }
    }
    /* the public channel: top traders' new positions — the free alpha feed
       that brings people to the bot */
    if (channel && smart && s.side === 'buy' && smartSignal(s) && allowedUser('ch')) {
      const { text, keyboard } = formatSwap({ s, token, smart, env, solUsd });
      await tg(env, 'sendMessage', { chat_id: channel.id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard }).catch(() => null);
    }
  }
  return { swaps: swaps.length, dms };
}

/* The console sets the channel: the bot must be an admin there to post. */
export async function setChannel(env, store, handle) {
  const h = String(handle || '').trim();
  if (!h) { await store.put(K.channel, null); return { ok: true, channel: null }; }
  const id = /^-?\d+$/.test(h) ? Number(h) : (h.startsWith('@') ? h : '@' + h);
  let chat;
  try { chat = await tg(env, 'getChat', { chat_id: id }); } catch (e) { return { ok: false, error: 'I cannot see that channel — add me to it as an admin first.' }; }
  const bot = await me(env, store).catch(() => null);
  try {
    const m = await tg(env, 'getChatMember', { chat_id: chat.id, user_id: bot && bot.id });
    if (!m || (m.status !== 'administrator' && m.status !== 'creator')) return { ok: false, error: 'Make me an admin of the channel so I can post.' };
  } catch { return { ok: false, error: 'Make me an admin of the channel so I can post.' }; }
  const v = { id: chat.id, title: chat.title || '', username: chat.username || '' };
  await store.put(K.channel, v);
  return { ok: true, channel: v };
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
export const WHALE_PROMPT = '🐳 Reply to this message with the photo, GIF or video for whale buys';

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
        + `<b>Verify in private chat</b> ${on(gd.dm)} — the captcha opens in a chat with me; everyone who verifies can get pumpbubble DMs\n`
        + `<b>Welcome message</b> ${on(gd.welcome)} — the previous one is deleted when someone new arrives\n`
        + `<b>Clean joins</b> ${on(gd.clean)} — deletes the "joined" and "left" lines\n\n`
        + 'Your own welcome: <code>/welcome Hi {name}, welcome to {group}!</code>\n\n'
        + 'I need to be an admin with <b>Ban users</b> and <b>Delete messages</b>.',
      kb: [
        [{ text: (gd.captcha ? '✅' : '⬜') + ' Join captcha', callback_data: 'cfg:gcap' }],
        [{ text: (gd.dm ? '✅' : '⬜') + ' Verify in private chat', callback_data: 'cfg:gdm' }],
        [{ text: (gd.welcome ? '✅' : '⬜') + ' Welcome message', callback_data: 'cfg:gwel' }],
        [{ text: (gd.clean ? '✅' : '⬜') + ' Clean joins', callback_data: 'cfg:gcln' }],
        TTLS.map((m, i) => ({ text: (m === ttl ? '✅ ' : '') + m + ' min', callback_data: 'cfg:gttl:' + i })),
        back,
      ],
    };
  }
  if (page === 'whale') {
    const at = whaleAt(g), react = g.react !== false;
    return {
      text: `🐳 <b>Whale buys</b> for ${sym}\n\n`
        + `A buy of <b>${fmtUsd(at)}</b> or more gets the 🐳 WHALE BUY headline${react ? ', a big 🐳 reaction' : ''}`
        + ` and its own media.\nWhale media: ${g.whaleMedia ? g.whaleMedia.kind : 'none — the usual media is used'}\n\n`
        + `Reactions ${react ? '✅ on' : '⬜ off'} — 🔥 from $1,000, 💯 when a top trader or top caller buys, 🐳 for a whale.`,
      kb: [[{ text: '📤 Upload whale media', callback_data: 'cfg:wmedia:new' }, ...(g.whaleMedia ? [{ text: '🗑 Remove', callback_data: 'cfg:wmedia:off' }] : [])],
           WHALES.map((v, i) => ({ text: (v === at ? '✅ ' : '') + fmtUsd(v).replace(',000', 'K').replace(',500', '.5K'), callback_data: 'cfg:wmin:' + i })),
           [{ text: (react ? '✅' : '⬜') + ' Reactions', callback_data: 'cfg:react' }, { text: '🐳 Whale test', callback_data: 'cfg:wtest' }],
           back],
    };
  }
  if (page === 'style') {
    const classic = g.style !== 'bubble';
    return {
      text: `🎨 <b>Buy style</b> for ${sym}\n\n`
        + `<b>Bubble</b>${classic ? '' : ' ✅'} — how big the buy is, by name and a meter:\n`
        + `🐬 <b>${sym} BUY</b> · <b>$620</b>\n<b>${buyMeter(620)}</b> DOLPHIN\n\n`
        + `<b>Classic</b>${classic ? ' ✅' : ''} — one ${tgEsc(g.emoji || '🟢')} per $${step}, like other buy bots:\n`
        + `${emojiRow(620, g.emoji, step)}\n\n`
        + `<b>Buy card picture</b>${g.card === false ? '' : ' ✅'} — every buy drawn as a picture with your token's art, `
        + `market cap and the buyer's position; a 🧠 top trader or 📣 top KOL is named on it. Used only when you have not set your own media.`,
      kb: [[{ text: (classic ? '' : '✅ ') + '🫧 Bubble', callback_data: 'cfg:style:bubble' },
            { text: (classic ? '✅ ' : '') + '😀 Classic', callback_data: 'cfg:style:classic' }],
           [{ text: (g.card === false ? '⬜' : '✅') + ' Buy card picture', callback_data: 'cfg:card' }],
           [{ text: '🧪 Test alert', callback_data: 'cfg:test' }], back],
    };
  }
  if (page === 'stop') return {
    text: `⏹ Stop posting ${sym} buys here?

This also switches the 🛡 Guard off. To track a different token instead, just send <code>/setup &lt;new contract address&gt;</code> — the guard and your emoji stay.`,
    kb: [[{ text: 'Yes, stop', callback_data: 'cfg:stop:yes' }, { text: 'Cancel', callback_data: 'cfg:main' }]],
  };
  const classic = g.style !== 'bubble';
  return {
    text: `⚙️ <b>${sym}</b> buy alerts\n\n`
      + `Style ${classic ? 'Classic — a row of emoji' : 'Bubble — buy size and a meter'}\n`
      + `Emoji ${tgEsc(g.emoji || '🟢')} · one per $${step}${classic ? '' : ' (classic style)'}\n`
      + `Whales from ${fmtUsd(whaleAt(g))} · reactions ${g.react !== false ? 'on' : 'off'}${g.whaleMedia ? ' · own media' : ''}\n`
      + `Min buy ${minBuy ? '$' + minBuy : 'none — every buy'}\n`
      + `Media ${g.media ? g.media.kind : 'none'}\n`
      + `Links ${links.join(' · ') || 'none'}\n\nAdmins only.`,
    kb: [
      [{ text: '🐳 Whale buys', callback_data: 'cfg:whale' }, { text: '🎨 Style: ' + (classic ? 'Classic' : 'Bubble'), callback_data: 'cfg:style' }],
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
  const GKEY = { gcap: 'captcha', gwel: 'welcome', gcln: 'clean', gdm: 'dm' };
  if (GKEY[what] || (what === 'gttl' && TTLS[i])) {
    const gd = { ttl: 5, ...(g.guard || {}) };
    let note;
    if (what === 'gttl') { gd.ttl = TTLS[i]; note = TTLS[i] + ' minutes to answer'; }
    else {
      const key = GKEY[what], turnOn = !gd[key];
      /* Say so now, not on the first join: a captcha the bot cannot enforce
         mutes nobody and deletes nothing. */
      if (turnOn && key !== 'welcome' && key !== 'dm') {
        const why = await missingRights(ctx, chat.id);
        if (why) return ack(why, true);
      }
      gd[key] = turnOn;
      note = { captcha: 'Join captcha', welcome: 'Welcome message', clean: 'Clean joins', dm: 'Verify in private chat' }[key] + (turnOn ? ' on' : ' off')
        + (key === 'dm' && turnOn && !gd.captcha ? ' — switch the join captcha on too' : '');
    }
    g = { ...g, guard: gd };
    await putGroup(store, chat.id, g);
    await ack(note);
    return show(settingsView(g, 'guard'));
  }
  if (what === 'wmin' && val != null && WHALES[i]) {
    g = { ...g, whaleMin: WHALES[i] };
    await putGroup(store, chat.id, g);
    await ack('Whales from ' + fmtUsd(WHALES[i]));
    return show(settingsView(g, 'whale'));
  }
  if (what === 'card') {
    g = { ...g, card: g.card === false };
    await putGroup(store, chat.id, g);
    await ack(g.card ? 'Buy card on — when no media is set' : 'Buy card off');
    return show(settingsView(g, 'style'));
  }
  if (what === 'react') {
    g = { ...g, react: g.react === false };
    await putGroup(store, chat.id, g);
    await ack(g.react ? 'Reactions on' : 'Reactions off');
    return show(settingsView(g, 'whale'));
  }
  if (what === 'wmedia' && val === 'off') {
    g = { ...g, whaleMedia: null };
    await putGroup(store, chat.id, g);
    await ack('Whale media removed');
    return show(settingsView(g, 'whale'));
  }
  if (what === 'wmedia' && val === 'new') {
    await ack();
    const who = q.from ? `<a href="tg://user?id=${num(q.from.id)}">${tgEsc(q.from.first_name || 'admin')}</a>` : '';
    return say(env, chat.id, `${WHALE_PROMPT} — it goes on every buy of ${fmtUsd(whaleAt(g))} or more. ${who}`,
      { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Attach a photo, GIF or video' } });
  }
  if (what === 'wtest') { await ack('Sending a whale test'); return sendTest(ctx, chat.id, g, { whale: true }); }
  if (what === 'style' && (val === 'bubble' || val === 'classic')) {
    g = { ...g, style: val };
    await putGroup(store, chat.id, g);
    await ack(val === 'bubble' ? 'Bubble style — buy size and a meter' : 'Classic style — a row of emoji');
    return show(settingsView(g, 'style'));
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
    await untrackOld(ctx, chat.id, g, '');
    await removeGroup(store, chat.id);
    await resync(ctx);
    await ack('Stopped');
    return tg(env, 'editMessageText', { chat_id: chat.id, message_id: q.message.message_id,
      text: 'Stopped — no more buy alerts here, and the guard is off. /setup <code>&lt;contract address&gt;</code> to start again.', parse_mode: 'HTML' }).catch(() => null);
  }
  await ack();
  return show(settingsView(g, ['emoji', 'min', 'step', 'media', 'links', 'stop', 'guard', 'style', 'whale'].includes(what) ? what : 'main'));
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
    if (muted && gd.dm) {
      /* verify in private: the button opens a chat with the bot, and that
         Start is what puts the member on the list */
      const bot = await me(env, ctx.store).catch(() => null);
      if (bot && bot.username) {
        const code = 'v_' + (chat.id < 0 ? 'm' + (-chat.id) : String(chat.id));
        const m = await say(env, chat.id,
          `👋 ${mention(u)}, welcome to <b>${tgEsc(chat.title || 'the group')}</b>!\n\n`
          + `Tap below to verify — it opens a private chat with me. You have ${j.ttl} min.`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Verify', url: 'https://t.me/' + bot.username + '?start=' + code }]] } });
        if (m) await ctx.guard(chat.id, 'msg', { uid: u.id, msg: m.message_id }).catch(() => null);
        return;
      }
    }
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
  /* function replacers: a name, title or ticker containing "$&" or "$'"
     would otherwise be expanded by replace() into pieces of the message */
  const name = mention(u), group = '<b>' + tgEsc((chat && chat.title) || 'the group') + '</b>', sym = tgEsc(g.sym || '');
  return tgEsc(tpl)
    .replace(/\{name\}/g, () => name)
    .replace(/\{group\}/g, () => group)
    .replace(/\{sym\}/g, () => sym);
}

async function postWelcome(ctx, chat, u, g) {
  const { env } = ctx;
  const has = g.mint || g.token;
  const L = has ? tokenLinks(env, g) : null;
  const buttons = L ? [[
    { text: '📊 Chart', url: L.chart }, { text: '💲 Buy', url: L.buy }, { text: '🫧 Bubble', url: L.bubble },
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

const chatFromCode = code => { const s = String(code || ''); return s.startsWith('m') ? -Number(s.slice(1)) : Number(s); };

async function verifyStart(ctx, msg, arg) {
  const { env } = ctx;
  const code = arg.slice(2);
  const chatId = chatFromCode(code);
  const uid = msg.from.id;
  const p = ctx.guard ? await ctx.guard(chatId, 'peek', { uid }).catch(() => null) : null;
  if (!p || !p.ok) return say(env, msg.chat.id, 'Nothing to verify right now. If you just joined a group, tap its ✅ Verify button again — or rejoin if the time ran out.');
  let title = 'the group';
  try { const ch = await tg(env, 'getChat', { chat_id: chatId }); if (ch && ch.title) title = ch.title; } catch {}
  const kb = [];
  p.options.forEach((e, i) => { if (i % 4 === 0) kb.push([]); kb[kb.length - 1].push({ text: e, callback_data: `vcap:${code}:${i}` }); });
  return say(env, msg.chat.id,
    `🛡 Verify to chat in <b>${tgEsc(title)}</b>\n\nTap the ${p.target} below.\n\n<i>${DISCLOSURE}</i>`,
    { reply_markup: { inline_keyboard: kb } });
}

async function onVerifyAnswer(ctx, q, rest) {
  const { env, store } = ctx;
  const ack = (text, alert = false) => tg(env, 'answerCallbackQuery',
    { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  const [code, iS] = rest.split(':');
  const chatId = chatFromCode(code);
  const uid = q.from.id;
  const dm = q.message && q.message.chat && q.message.chat.id;
  const edit = text => tg(env, 'editMessageText', { chat_id: dm, message_id: q.message.message_id, text, parse_mode: 'HTML' }).catch(() => null);
  if (!ctx.guard || !chatId) return ack();
  const r = await ctx.guard(chatId, 'answer', { uid, i: Math.floor(num(iS)) }).catch(() => null);
  if (!r || r.result === 'none' || r.result === 'expired') { await ack(); return edit('This check has expired — rejoin the group to get a new one.'); }
  if (r.result === 'wrong') return ack(`❌ Not that one — ${r.left} ${r.left === 1 ? 'try' : 'tries'} left.`, true);
  if (r.result === 'fail') {
    await ack();
    await kick(env, chatId, uid);
    await del(env, chatId, r.msg);
    return edit('❌ Wrong. You can rejoin the group in a minute and try again.');
  }
  await tg(env, 'restrictChatMember', { chat_id: chatId, user_id: uid, permissions: perms(true) }).catch(() => null);
  await ack('✅ Verified');
  await del(env, chatId, r.msg);
  await edit('✅ Verified — you can chat in the group now.');
  const g = await getGroup(store, chatId);
  if (g && g.guard && g.guard.welcome) {
    let chat = { id: chatId, title: '' };
    try { const ch = await tg(env, 'getChat', { chat_id: chatId }); if (ch) chat = ch; } catch {}
    await postWelcome(ctx, chat, q.from, g);
  }
}

/* One DM from the list (the AudienceDO's sender). Every message carries the
   way out; 'gone' means blocked or deleted, and the list forgets them. */
export async function sendDm(env, id, html, buttons = [], { unsub = true } = {}) {
  try {
    await tg(env, 'sendMessage', {
      chat_id: id, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: !unsub },
      /* a mass DM carries Unsubscribe; a tracker alert carries its own way out */
      reply_markup: { inline_keyboard: [...(Array.isArray(buttons) ? buttons : []), ...(unsub ? [[UNSUB]] : [])] },
    });
    return 'ok';
  } catch (e) {
    const d = String(e.description || e.message || '');
    return /blocked|deactivated|chat not found|user not found|PEER_ID_INVALID/i.test(d) ? 'gone' : 'fail';
  }
}

/* The console's list of groups: every group configured with /setup, joined
   with every group that ever added the bot (the AudienceDO keeps those, set
   up or not), and Telegram's own title, @username and member count, read
   live — for the first 20, since the free plan allows a Worker invocation 50
   subrequests and each group costs two — and kept for five minutes. */
let groupListMem = { at: 0, v: null };
export async function groupList(ctx, { fresh = false } = {}) {
  if (!fresh && groupListMem.v && Date.now() - groupListMem.at < 300_000) return groupListMem.v;
  const { env, store } = ctx;
  const ids = (await store.get(K.groups)) || [];
  const seen = ctx.audience ? (((await ctx.audience('groups').catch(() => null)) || {}).list || []) : [];
  const by = new Map();
  for (const s of seen) by.set(String(s.id), { id: s.id, seen: s });
  for (const id of ids) by.set(String(id), { ...(by.get(String(id)) || { id: +id }), configured: true });
  const rows = [...by.values()];
  for (const r of rows) if (r.configured) r.cfg = await getGroup(store, r.id).catch(() => null);
  const gone = r => !r.configured && r.seen && (r.seen.status === 'left' || r.seen.status === 'kicked');
  const live = rows.filter(r => !gone(r)).sort((a, b) => (b.configured ? 1 : 0) - (a.configured ? 1 : 0)).slice(0, 20);
  for (let i = 0; i < live.length; i += 5) {
    await Promise.all(live.slice(i, i + 5).map(async r => {
      try {
        const c = await tg(env, 'getChat', { chat_id: r.id });
        r.title = c.title || ''; r.username = c.username || ''; r.type = c.type || '';
      } catch (e) { if (/not found|kicked|forbidden|bot is not a member/i.test(String(e.description || e.message || ''))) r.lost = true; }
      if (!r.lost) { try { r.members = await tg(env, 'getChatMemberCount', { chat_id: r.id }); } catch { /* unknown */ } }
    }));
  }
  const rank = s => (s === 'tracking' ? 0 : s === 'not set up' ? 1 : 2);
  const out = rows.map(r => {
    const s = r.seen || {}, c = r.cfg || null;
    const status = r.lost || gone(r) ? 'removed' : r.configured ? 'tracking' : 'not set up';
    return {
      id: r.id, status,
      title: clean(r.title || s.title || '', 80), username: r.username || s.username || '', type: r.type || s.type || '',
      members: Number.isFinite(+r.members) ? +r.members : null,
      token: c ? { sym: c.sym || '', chain: c.chain || 'solana', addr: c.mint || c.token || '' } : null,
      guard: !!(c && c.guard && (c.guard.captcha || c.guard.welcome || c.guard.clean)),
      setupAt: (c && c.at) || 0, addedAt: s.addedAt || 0, leftAt: s.leftAt || 0,
      by: s.by ? { id: s.by, name: s.byName || '', user: s.byUser || '' } : (c && c.by ? { id: c.by, name: '', user: '' } : null),
    };
  }).sort((a, b) => rank(a.status) - rank(b.status) || (b.members || 0) - (a.members || 0) || (b.addedAt || 0) - (a.addedAt || 0));
  groupListMem = { at: Date.now(), v: out };
  return out;
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
  if (!uid) return;
  if (c && c.cmd === 'stop') {
    await forgetUser(store, uid);
    if (ctx.audience) { await ctx.audience('purge', { id: uid }).catch(() => null); await resync(ctx); }
    return say(env, msg.chat.id, 'Done — nothing more from me. /start any time.');
  }
  /* anyone talking to the bot in private has pressed Start: on the list */
  if (ctx.audience && !(msg.from && msg.from.is_bot)) {
    await ctx.audience('add', {
      id: uid, src: c && c.cmd === 'start' ? (c.arg || 'start').split('_')[0] : 'chat',
      name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '), user: msg.from.username || '',
    }).catch(() => null);
  }
  if (c && c.cmd === 'start' && /^v_m?\d{1,20}$/.test(c.arg || '')) return verifyStart(ctx, msg, c.arg);
  /* a pasted contract address is the start of a purchase */
  const pasted = String(msg.text || '').trim();
  if (!c && isCA(pasted)) return shopFor(ctx, msg.chat.id, pasted);
  /* Nothing typed here goes unanswered: a half-pasted address says so, and
     anything else points at what the bot can do. A photo or a sticker (no
     text) gets nothing — there is nothing to say about it. */
  if (!c) {
    if (!pasted) return;
    const partial = /^(0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{20,})$/.test(pasted);
    return say(env, msg.chat.id, partial
      ? 'That looks like part of an address — paste the whole thing, from a token\u2019s page or a wallet.'
      : 'Paste a token address to buy or boost it, or a wallet address to track it. Everything else is in the menu:',
      { reply_markup: { inline_keyboard: [[MENU_BTN, { text: '❓ How it works', callback_data: 'help:menu' }]] } });
  }
  if (c.cmd === 'start' && c.arg) {
    const [what, ca] = [c.arg.split('_')[0], c.arg.slice(c.arg.indexOf('_') + 1)];
    if ((what === 'boost' || what === 'ad') && isCA(ca)) return shopFor(ctx, msg.chat.id, ca, what);
    if (what === 'boost' || what === 'ads' || what === 'ad') return askForToken(ctx, msg.chat.id, what);
  }
  if (c.cmd === 'boost' || c.cmd === 'ads' || c.cmd === 'ad') return askForToken(ctx, msg.chat.id, c.cmd);
  if (c.cmd === 'track') {
    const [wallet = '', ...rest] = c.arg.split(/\s+/);
    if (!wallet) return trackerMenu(ctx, msg.chat.id, uid);
    return trackWallet(ctx, msg.chat.id, uid, wallet, rest.join(' '));
  }
  if (c.cmd === 'untrack') {
    const wallet = c.arg.split(/\s+/)[0] || '';
    if (!ctx.audience) return;
    await ctx.audience('unfollow', { id: uid, wallet });
    await resync(ctx);
    return say(env, msg.chat.id, 'Stopped tracking <code>' + tgEsc(wallet) + '</code>.');
  }
  if (c.cmd === 'wallets' || c.cmd === 'tracker') return trackerMenu(ctx, msg.chat.id, uid);
  if (c.cmd === 'start' || c.cmd === 'menu') return sendMenu(ctx, msg.chat.id);
  if (c.cmd === 'help') return sendHelp(ctx, msg.chat.id, 'menu');
  if (c.cmd === 'buybot' || c.cmd === 'setup') return sendHelp(ctx, msg.chat.id, 'group');
  if (c.cmd === 'toptraders' || c.cmd === 'smart') return sendHelp(ctx, msg.chat.id, 'traders');
  if (c.cmd === 'callers' || c.cmd === 'calls') return sendCallers(ctx, msg.chat.id, uid);
  return say(env, msg.chat.id, 'I don\u2019t know that command. Type / to see mine, or:',
    { reply_markup: { inline_keyboard: [[MENU_BTN, { text: '❓ How it works', callback_data: 'help:menu' }]] } });
}

/* ============================================================== menus */
/* What somebody sees in a private chat. The first screen says what the bot
   is for in four lines and puts each behind a button; the detail is one tap
   down, in Help, edited in place so the chat does not fill with menus. The
   disclosure stays on the first screen: it is the condition the mass DM
   was built on (see CLAUDE.md). */
export const MENU_BTN = { text: '🏠 Menu', callback_data: 'menu' };
const addToGroupUrl = bot => 'https://t.me/' + bot.username + '?startgroup=setup&admin=delete_messages+restrict_members+pin_messages+invite_users';

export function mainMenu(env, bot) {
  const text = '🫧 <b>pumpbubble</b> — the live pump.fun bubble map, in Telegram.\n\n'
    + '➕ <b>Buy bot</b> — free buy alerts, a join captcha and a welcome for your token\u2019s group\n'
    + '👛 <b>Wallet tracker</b> — every buy and sell of any wallet, copied in one tap\n'
    + '🧠 <b>Top traders</b> — follow pump.fun\u2019s best, by profit actually banked\n'
    + '📣 <b>Callers</b> — pump.fun\u2019s best callers, measured; their calls here first\n'
    + '⚡ <b>Promote</b> — make a token gold on the map, or advertise it\n\n'
    + 'Or just paste a token or wallet address here.\n\n'
    + '<i>' + DISCLOSURE + '</i>';
  const kb = [];
  /* Add-to-group asks for the admin rights the guard needs up front —
     Telegram's startgroup link can request them — so an owner is not sent
     back to promote the bot by hand before the captcha works. */
  if (bot && /^\w+$/.test(bot.username || '')) kb.push([{ text: '➕ Add the buy bot to my group', url: addToGroupUrl(bot) }]);
  kb.push([{ text: '👛 Wallet tracker', callback_data: 'trk:menu' }, { text: '🧠 Follow top traders', callback_data: 'trk:smart' }]);
  kb.push([{ text: '📣 Top callers', callback_data: 'call:menu' }, { text: '🔥 Live calls', url: site(env) + '/?source=calls' }]);
  kb.push([{ text: '⚡ Boost a token', callback_data: 'shop:boost' }, { text: '📣 Advertise', callback_data: 'shop:ads' }]);
  kb.push([{ text: '🫧 Open the map', url: site(env) }, { text: '💬 Community', url: community(env) }]);
  kb.push([{ text: '𝕏 Follow on X', url: xProfile(env) }, { text: '❓ How it works', callback_data: 'help:menu' }]);
  kb.push([UNSUB]);
  if (pumpJoin(env)) kb.push([{ text: '🟢 New to pump.fun? Create an account', url: pumpJoin(env) }]);
  return { text, keyboard: kb };
}

export function helpScreen(env, bot, topic) {
  const back = [{ text: '⬅️ Back', callback_data: 'help:menu' }, MENU_BTN];
  const add = bot && /^\w+$/.test(bot.username || '') ? [{ text: '➕ Add the buy bot to my group', url: addToGroupUrl(bot) }] : null;
  const T = {
    menu: {
      text: '❓ <b>How it works</b> — pick a topic:',
      keyboard: [
        [{ text: '➕ Buy bot for my group', callback_data: 'help:group' }],
        [{ text: '👛 Wallet tracker', callback_data: 'help:wallets' }, { text: '🧠 Top traders', callback_data: 'help:traders' }],
        [{ text: '📣 Callers', callback_data: 'help:callers' }],
        [{ text: '⚡ Boosts and ads', callback_data: 'help:promote' }, { text: '🔕 Messages and safety', callback_data: 'help:privacy' }],
        [MENU_BTN],
      ],
    },
    group: {
      text: '➕ <b>Buy bot for your group</b> — free\n\n'
        + '1. Tap <b>Add the buy bot to my group</b>, pick the group, and keep the admin rights it asks for — the captcha needs them.\n'
        + '2. In the group, send <code>/setup &lt;contract address&gt;</code>. Solana, Base, Ethereum and Robinhood Chain all work.\n'
        + '3. Send /settings for buttons: a picture or GIF on every buy, the emoji, a minimum buy, and 🛡 Guard — join captcha, welcome message, clean joins.\n\n'
        + 'A token’s first setup also gets 500 Tap wars taps, and an hour as a golden bubble on the map when a slot is free.',
      keyboard: [...(add ? [add] : []), back],
    },
    wallets: {
      text: '👛 <b>Wallet tracker</b>\n\n'
        + '• Paste a wallet address here, or send <code>/track WALLET name</code>.\n'
        + '• Every buy and sell arrives here within seconds, with <b>⚡ Copy buy</b> — it opens the same trade in your own wallet.\n'
        + '• Up to ' + MAX_FOLLOWS + ' wallets. /wallets lists them; tap ✖ to drop one.',
      keyboard: [[{ text: '👛 My wallets', callback_data: 'trk:menu' }], back],
    },
    traders: {
      text: '🧠 <b>Top traders</b>\n\n'
        + 'pump.fun\u2019s top traders by profit actually banked — not paper gains. Follow them with one tap and their bigger buys and exits (1 SOL or more) arrive here, with ⚡ Copy buy.\n\n'
        + 'Their buys are also marked 🧠 SMART BUY in every group running the bot.',
      keyboard: [[{ text: '🧠 Follow top traders', callback_data: 'trk:smart' }, { text: '🫧 See them', url: site(env) + '/?source=traders' }], back],
    },
    callers: {
      text: '📣 <b>Callers</b>\n\n'
        + 'On pump.fun anyone can make a public call on a coin they hold. pumpbubble ranks the callers by how often their calls reach 2×, '
        + 'adjusted for how many they made, so one lucky call does not top the board.\n\n'
        + 'Every call shows what a follower kept — the peak, and where it is now — and whether the caller still holds it.\n\n'
        + 'Follow the top callers and each new call arrives here the moment it is made, with Buy and Chart.',
      keyboard: [[{ text: '📣 Top callers', callback_data: 'call:menu' }, { text: '🔥 Live calls', url: site(env) + '/?source=calls' }], back],
    },
    promote: {
      text: '⚡ <b>Boosts and ads</b>\n\n'
        + '• <b>Boost</b>: the token\u2019s bubble turns gold and grows past everyone on the map, fading over its hours.\n'
        + '• <b>Map ad</b>: a slot on the moving rail above the map.\n'
        + '• <b>Buy-alert ad</b>: a line under every buy alert, in every group I post in.\n\n'
        + 'Send me the token\u2019s address, pick one and pay in SOL. I message you here the moment it is live.',
      keyboard: [[{ text: '⚡ Boost a token', callback_data: 'shop:boost' }, { text: '📣 Advertise', callback_data: 'shop:ads' }], back],
    },
    privacy: {
      text: '🔕 <b>Messages and safety</b>\n\n'
        + DISCLOSURE + '\n\n'
        + '• /stop — stop everything and forget you.\n'
        + '• 🔕 on any update — stop the updates only; wallet alerts you asked for keep coming.\n'
        + '• I never ask for a private key, a seed phrase or a payment to \u201cverify\u201d. Anyone who does is not me.',
      keyboard: [[UNSUB], back],
    },
  };
  return T[topic] || T.menu;
}

/* Show a screen: edit the message a button sits on when there is one, send a
   new one otherwise (or when the edit is refused). */
async function showScreen(env, chatId, messageId, text, keyboard) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } };
  if (messageId) {
    try { return await tg(env, 'editMessageText', { ...payload, message_id: messageId }); }
    catch (e) { if (/not modified/i.test(e.description || '')) return null; }
  }
  return tg(env, 'sendMessage', payload).catch(() => null);
}
async function sendMenu(ctx, chatId, messageId = 0) {
  const bot = await me(ctx.env, ctx.store).catch(() => null);
  const m = mainMenu(ctx.env, bot);
  return showScreen(ctx.env, chatId, messageId, m.text, m.keyboard);
}
async function sendHelp(ctx, chatId, topic, messageId = 0) {
  const bot = await me(ctx.env, ctx.store).catch(() => null);
  const h = helpScreen(ctx.env, bot, topic);
  return showScreen(ctx.env, chatId, messageId, h.text, h.keyboard);
}

/* ============================================================== callers */
/* The week's top callers (src/callers.mjs, read from the CallersDO), and the
   switch that sends their new calls here. The ranking is explained in one
   line on the screen itself: a board people act on has to say what it
   measures. */
const pctOf = x => Math.round((+x || 0) * 100) + '%';
export function callersScreen(env, rows, on) {
  const list = (rows || []).slice(0, 10).map(r => `${r.rank}. <b>${tgEsc(r.xh ? '@' + r.xh : r.name)}</b>${r.verified ? ' ✓' : ''}`
    + ` — ${pctOf(r.hit2)} of ${r.n} calls hit 2×` + (r.med ? `, median peak ${(+r.med).toFixed(1)}×` : '')).join('\n');
  const text = '📣 <b>Top callers this week</b>\n'
    + '<i>Ranked by how often their calls reach 2×, adjusted for how many they made — one lucky call does not top the board.</i>\n\n'
    + (list || 'The board is filling up: the first records arrive within a few minutes.')
    + '\n\n' + (on
      ? `✅ Each new call from the top ${CALL_TOP_N} arrives here the moment it is made.`
      : `Follow them and each new call from the top ${CALL_TOP_N} arrives here the moment it is made, with Buy and Chart.`);
  const keyboard = [
    [{ text: on ? '✅ Following top callers' : '📣 Follow top callers', callback_data: 'call:follow' }],
    [{ text: '🔥 Live calls', url: site(env) + '/?source=calls' }, { text: '🏆 Full board', url: site(env) + '/?source=callers' }],
    [MENU_BTN],
  ];
  return { text, keyboard };
}
async function sendCallers(ctx, chatId, uid, messageId = 0) {
  let rows = [], on = false;
  if (ctx.callers) { try { rows = ((await ctx.callers('board', { window: 'weekly' })) || {}).rows || []; } catch { rows = []; } }
  if (ctx.audience && uid) { try { on = !!((await ctx.audience('isCallFan', { id: uid })) || {}).calls; } catch { on = false; } }
  const s = callersScreen(ctx.env, rows, on);
  return showScreen(ctx.env, chatId, messageId, s.text, s.keyboard);
}
async function onCalls(ctx, q, act) {
  const { env } = ctx;
  const chatId = q.message && q.message.chat && q.message.chat.id;
  const uid = q.from.id;
  const ack = (text, alert = false) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  if (!chatId) return ack();
  const mid = q.message && q.message.message_id;
  if (act === 'menu') { await ack(); return sendCallers(ctx, chatId, uid, mid); }
  if (!ctx.audience) return ack('Call alerts are not switched on in this deployment.', true);
  if (act === 'follow') {
    const now = !((await ctx.audience('isCallFan', { id: uid }).catch(() => null)) || {}).calls;
    await ctx.audience('callFan', { id: uid, on: now }).catch(() => null);
    await ack(now ? '📣 Following the top callers — their new calls arrive here.' : 'Stopped the call alerts.', true);
    return sendCallers(ctx, chatId, uid, mid);
  }
  if (act === 'off') {
    await ctx.audience('callFan', { id: uid, on: false }).catch(() => null);
    return ack('Stopped the call alerts. /callers to turn them back on.', true);
  }
  return ack();
}

/* One new call from a top caller, as a DM. The caller's record comes first
   — it is why the message exists — then the coin, the thesis in their words,
   the address to check, and a line saying a record is not a promise. */
export function formatCallAlert(env, call, caller) {
  const who = caller && caller.xh ? '@' + caller.xh : (caller && caller.name) || 'a top caller';
  const html = `📣 <b>NEW CALL</b> — ${tgEsc(who)}${caller && caller.verified ? ' ✓' : ''}\n`
    + (caller ? `#${Math.floor(+caller.rank || 0)} caller this week · ${pctOf(caller.hit2)} of ${Math.floor(+caller.n || 0)} calls reached 2×`
      + (caller.med ? ` · median peak ${(+caller.med).toFixed(1)}×` : '') + '\n' : '')
    + `\n<b>$${tgEsc(clean(call.sym, 12))}</b>${call.name ? ' — ' + tgEsc(clean(call.name, 48)) : ''}\n`
    + `Called at ${fmtUsd(call.mcapAtCall)} market cap\n`
    + (call.thesis ? `\n\u201c${tgEsc(clean(call.thesis, 180))}\u201d\n` : '')
    + `\n<code>${tgEsc(call.mint)}</code>\n`
    + '<i>A caller\u2019s record is not a promise. Not financial advice.</i>';
  const origin = site(env);
  const buttons = [
    [{ text: '🛒 Buy $' + clean(call.sym, 12), url: buyOrSwap(env, origin, call.mint) },
     { text: '📊 Chart', url: 'https://pump.fun/coin/' + encodeURIComponent(call.mint) }],
    [{ text: '📣 All calls', url: origin + '/?source=calls' }, { text: '🔕 Stop call alerts', callback_data: 'call:off' }],
  ];
  return { html, buttons };
}

async function onCallback(ctx, q) {
  const { env, store } = ctx;
  const data = String(q.data || '');
  const uid = q.from && q.from.id;
  const chatId = q.message && q.message.chat && q.message.chat.id;
  if (uid && data === 'unsub') {
    await forgetUser(store, uid);
    if (ctx.audience) await ctx.audience('remove', { id: uid }).catch(() => null);
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Unsubscribed — nothing more from me. /start to come back.', show_alert: true }).catch(() => {});
    if (chatId) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }
  if (uid && (data === 'menu' || data.startsWith('help:'))) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (!chatId) return;
    const mid = q.message && q.message.message_id;
    return data === 'menu' ? sendMenu(ctx, chatId, mid) : sendHelp(ctx, chatId, data.slice(5), mid);
  }
  if (uid && data.startsWith('call:')) return onCalls(ctx, q, data.slice(5));
  if (uid && data.startsWith('vcap:')) return onVerifyAnswer(ctx, q, data.slice(5));
  if (uid && data.startsWith('cfg:')) return onSettings(ctx, q, data.slice(4));
  if (uid && (data.startsWith('shop:') || data.startsWith('buy:') || data.startsWith('chk:'))) return onShop(ctx, q, data);
  if (uid && data.startsWith('trk:')) return onTracker(ctx, q, data.slice(4));
  if (uid && data.startsWith('cap:')) return onCaptcha(ctx, q, data.slice(4));
  if (!uid || !data.startsWith('sub:')) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id }).catch(() => {}); return; }
  const pick = data.slice(4);
  if (pick === 'none') {
    await forgetUser(store, uid);
    if (ctx.audience) await ctx.audience('remove', { id: uid }).catch(() => null);
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
  return syncHelius(ctx.env, ctx.store, ctx.audience);
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

/* The buy card (src/buycard.mjs) is drawn in the CardDO — hundreds of
   milliseconds of CPU, which a free-plan Worker request does not have and a
   Durable Object does. Anything short of a PNG back is no card. */
export async function buyCardPng(env, spec) {
  if (!env.CARDS || !spec) return null;
  try {
    const stub = env.CARDS.get(env.CARDS.idFromName('cards'));
    const r = await stub.fetch('https://cards/', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec), signal: AbortSignal.timeout(12000) });
    if (!r.ok || !/image\/png/.test(r.headers.get('content-type') || '')) return null;
    const buf = await r.arrayBuffer();
    return buf.byteLength > 1000 ? buf : null;
  } catch { return null; }
}

/* A photo upload: Telegram takes a new file only as multipart. */
export async function tgUpload(env, method, fields, fileField, bytes, filename) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  form.append(fileField, new Blob([bytes], { type: 'image/png' }), filename);
  const res = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/' + method, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  let j = null;
  try { j = await res.json(); } catch { /* below */ }
  if (!j || !j.ok) {
    const e = new Error(method + ': ' + ((j && j.description) || res.status));
    e.description = (j && j.description) || '';
    throw e;
  }
  return j.result;
}

/* A group's own media always wins; the card is for the groups that set none,
   and any group can switch it off (⚙️ Settings → 🎨 Style). */
const wantsCard = (g, m) => !m && g.card !== false;

export async function sendAlert(env, store, chatId, g, caption, keyboard, { whale = false, react = '', card = null } = {}) {
  const base = { chat_id: chatId, caption, parse_mode: 'HTML', reply_markup: keyboard };
  const useWhale = !!(whale && g.whaleMedia);
  const m = useWhale ? g.whaleMedia : g.media;
  const png = card && wantsCard(g, m) ? await buyCardPng(env, card) : null;
  let sent = null;
  try {
    if (m && m.kind === 'photo') sent = await tg(env, 'sendPhoto', { ...base, photo: m.id });
    else if (m && m.kind === 'animation') sent = await tg(env, 'sendAnimation', { ...base, animation: m.id });
    else if (m && m.kind === 'video') sent = await tg(env, 'sendVideo', { ...base, video: m.id });
    else if (png) {
      /* a card that Telegram refuses is the text alert, never a missed buy */
      sent = await tgUpload(env, 'sendPhoto', base, 'photo', png, 'buy.png').catch(e => {
        if (/kicked|not a member|chat not found|CHAT_WRITE_FORBIDDEN|deactivated|not enough rights/i.test(String(e.description || e.message || ''))) throw e;
        return null;
      });
      if (!sent) sent = await tg(env, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
    }
    else sent = await tg(env, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  } catch (e) {
    const d = String(e.description || e.message || '');
    /* The group is gone or we were removed: stop trying. */
    if (/kicked|not a member|chat not found|CHAT_WRITE_FORBIDDEN|deactivated|not enough rights/i.test(d)) {
      await removeGroup(store, chatId).catch(() => {});
      return null;
    }
    /* A media file id that stopped working: post the text and drop that media. */
    if (m && /wrong file identifier|failed to get HTTP URL|file is too big|WEBPAGE_MEDIA_EMPTY/i.test(d)) {
      await putGroup(store, chatId, { ...g, ...(useWhale ? { whaleMedia: null } : { media: null }) }).catch(() => {});
      sent = await tg(env, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } }).catch(() => null);
    } else return null;
  }
  /* the big animated reaction, on the buys that earn one; a group that
     limits its reactions simply refuses it, which costs nothing */
  if (sent && sent.message_id && react) {
    await tg(env, 'setMessageReaction', { chat_id: chatId, message_id: sent.message_id,
      reaction: [{ type: 'emoji', emoji: react }], is_big: true }).catch(() => null);
  }
  return sent;
}

/* A Helius delivery: every buy of a tracked mint, fanned out to every group
   that asked for it. `solUsd` comes from the caller because the price cache
   lives in api.mjs. Returns counts so the route can report what it did. */
export const LAT = [];              // seconds, block to posted, this isolate
/* The week's top callers as a wallet lookup for the buy alert: the Calls
   watcher's own board (2× hit rate at the lower edge of its Wilson
   interval), its top fifty, kept ten minutes per isolate. A failed read
   keeps the last good list. */
let callerMem = { at: 0, v: new Map() };
export async function topCallers(ctx, now = Date.now()) {
  if (!ctx || !ctx.callers) return callerMem.v;
  if (callerMem.v.size && now - callerMem.at < 600_000) return callerMem.v;
  let rows = [];
  try { rows = ((await ctx.callers('board', { window: 'weekly' })) || {}).rows || []; } catch { rows = []; }
  const m = new Map();
  for (const r of rows.slice(0, 50)) if (r && r.wallet) m.set(r.wallet, { name: r.name || '', xh: r.xh || '', rank: r.rank, hit2: r.hit2, n: r.n });
  if (m.size || !callerMem.v.size) callerMem = { at: now, v: m };
  else callerMem.at = now - 540_000;
  return callerMem.v;
}

/* `wallets` and `buys` say which half to do: a Helius delivery is the wallet
   tracker's, plus the buys only when Helius delivers those (SOL_BUYS=helius);
   the Solana watcher's poll is buys only. */
export async function onTrade(ctx, payload, solUsd, { wallets = true, buys: withBuys = true } = {}) {
  const { env, store } = ctx;
  const w = wallets ? await onWalletTrades(ctx, payload, solUsd).catch(() => ({ swaps: 0, dms: 0 })) : { swaps: 0, dms: 0 };
  const { set } = await tracked(store);
  const buys = withBuys && set.size ? buysFromPayload(payload, set) : [];
  /* Every Helius delivery is a Worker request — 371,067 of them in six hours
     on 2026-09-30, which is what took the site past the free plan's 100,000 a
     day. One line per delivery says what it was for (a group's buy, a watched
     wallet's swap, or nothing we use), sampled into the dashboard's Logs by
     [observability]. */
  console.log(JSON.stringify({ ev: wallets ? 'tg-trade' : 'sol-poll', txs: Array.isArray(payload) ? payload.length : 1, buys: buys.length, swaps: w.swaps || 0 }));
  if (!set.size) return { buys: 0, sent: 0, wallets: w };
  let sent = 0, skipped = 0;
  const bot = await me(env, store).catch(() => ({ username: '' }));
  for (const buy of buys) {
    if (!fresh(buy.sig)) continue;
    let chats = [];
    try { chats = (await store.get(K.mint(buy.mint))) || []; } catch {}
    if (!chats.length) continue;
    const token = (await tokenInfo(env, buy.mint)) || { mint: buy.mint };
    const usd = buy.sol * num(solUsd);
    const smart = (await smartWallets().catch(() => null))?.get(buy.buyer) || null;
    const caller = (await topCallers(ctx).catch(() => null))?.get(buy.buyer) || null;
    for (const chatId of chats) {
      const g = await getGroup(store, chatId);
      if (!g || g.mint !== buy.mint) continue;
      if (num(g.minBuy) > 0 && usd < num(g.minBuy)) { skipped++; continue; }
      if (!allowed(chatId)) { skipped++; continue; }
      const { caption, keyboard } = formatBuy({ buy, token, group: g, solUsd, botName: bot.username, env, ad: await alertAd(store), smart, caller,
        rank: ctx.mapRank ? ctx.mapRank(buy.mint) : null });
      if (await sendAlert(env, store, chatId, g, caption, keyboard,
        { whale: usd >= whaleAt(g), react: buyReaction({ usd, smart, caller, group: g }),
          card: buyCardSpec({ buy, token, usd, payWith: 'SOL', smart, caller, rank: ctx.mapRank ? ctx.mapRank(buy.mint) : null, whale: usd >= whaleAt(g) }) })) {
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
  try { const info = await tg(env, 'getWebhookInfo'); out.telegram = { url: info.url || '', pending: info.pending_update_count || 0, lastError: info.last_error_message || '', lastErrorAt: info.last_error_date || 0 }; }
  catch (e) { out.telegram = { error: String(e.message).replace(/bot\d+:[\w-]+/g, 'bot…') }; }
  out.helius = await webhookInfo(env, store);
  try { const pr = await store.get(K.profile); if (pr) out.profile = { ok: !!pr.ok, photo: pr.photo || '', at: pr.at, errors: pr.errors || [] }; } catch {}
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
