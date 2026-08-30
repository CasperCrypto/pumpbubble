/* ==========================================================================
   pumpbubble.fun — the X poster

   A post is "$SYM +312% in 24h" plus a link, and X renders the share card from
   that link's Open Graph tags. The link matters more than the image: a picture
   posted directly is a dead end, while a link puts the card in the timeline
   *and* brings the click back to the map.

   Everything here is off unless four secrets are set. A half-configured poster
   that throws once an hour is worse than no poster.

   The filters are the important part. pump.fun's top mover at any moment is
   usually a token minted ten minutes ago showing +1452986%, which is a real
   number and reads as a scam to everybody who sees it. Posting those would
   train people to scroll past us. So a candidate needs a market cap, real
   volume, and a gain inside a band that a person would believe.
   ========================================================================== */

export const KEY = 'xbot';

/* Credibility filters, not data filters — the map still shows everything.

   Per asset class, because "a move worth posting about" is not one number. A
   memecoin doing +25% in a day is a Tuesday; a listed company doing +25% in a
   day is a takeover. The first version applied the memecoin band to everything
   and the stocks card 404'd for want of movers, which is the correct answer to
   the wrong question.

   The upper bound is the interesting one. It exists because pump.fun's top
   mover is routinely a token minted minutes ago showing +1452986% — a real
   figure that reads as a scam to everyone who sees it. */
const BANDS = {
  pumpfun: { mcap: 50_000, vol: 10_000, min: 25, max: 1500 },
  majors: { mcap: 10_000_000, vol: 0, min: 10, max: 500 },
  stocks: { mcap: 1_000_000_000, vol: 0, min: 3, max: 100 },
};

/* Rate. A promotional account that posts every five minutes is a spam account.
   One a day is the brief, and the hour is fixed so the account has a rhythm
   rather than firing at whatever minute the first cron of the day happens to
   run. 15:00 UTC is late morning in New York and evening in Europe. */
const DEFAULT_PER_DAY = 1;
const DEFAULT_HOUR = 15;
const MIN_GAP_MS = 3 * 60 * 60 * 1000;
const REPOST_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const perDay = env => Math.max(1, Math.min(5, Number(env.XBOT_PER_DAY) || DEFAULT_PER_DAY));
const hourOf = env => {
  const h = Number(env.XBOT_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_HOUR;
};

const enc = s => encodeURIComponent(s)
  .replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function creds(env = {}) {
  const c = {
    key: env.X_API_KEY, secret: env.X_API_SECRET,
    token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET,
  };
  return (c.key && c.secret && c.token && c.tokenSecret) ? c : null;
}

/* The two halves of an OAuth 1.0a signature, separated so each can be checked
   against an authoritative vector. Getting this wrong returns a bare 401 with
   no indication of which of six steps was at fault, so neither half is taken
   on trust: the base string is compared to the one X publishes, and the MAC to
   the RFC 2202 vector. */
export function baseString(method, url, params) {
  return [
    method.toUpperCase(),
    enc(url),
    enc(Object.keys(params).sort().map(k => enc(k) + '=' + enc(params[k])).join('&')),
  ].join('&');
}

export async function hmacSha1B64(keyData, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyData),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export async function sign(method, url, params, consumerSecret, tokenSecret) {
  return hmacSha1B64(
    enc(consumerSecret) + '&' + enc(tokenSecret || ''),
    baseString(method, url, params));
}

async function authHeader(method, url, c, extra = {}) {
  const oauth = {
    oauth_consumer_key: c.key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.token,
    oauth_version: '1.0',
    ...extra,
  };
  /* A JSON body is not form-encoded, so its contents are deliberately absent
     from the signature base — only oauth and query parameters belong there. */
  oauth.oauth_signature = await sign(method, url, oauth, c.secret, c.tokenSecret);
  return 'OAuth ' + Object.keys(oauth).sort()
    .map(k => enc(k) + '="' + enc(oauth[k]) + '"').join(', ');
}

export async function postTweet(env, text) {
  const c = creds(env);
  if (!c) return { ok: false, why: 'not configured' };
  const url = 'https://api.twitter.com/2/tweets';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: await authHeader('POST', url, c),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      /* Status only. The body of an X error can echo the request, and this
         request is signed with the account's credentials. */
      return { ok: false, why: 'x ' + r.status };
    }
    const j = await r.json();
    return { ok: true, id: (j && j.data && j.data.id) || null };
  } catch (e) {
    return { ok: false, why: (e && e.name) || 'error' };
  }
}

/* Is this a number a person would believe?

   pump.fun's top mover at any moment is usually a token minted ten minutes ago
   showing +1452986%. That is a real figure and it reads as a scam to everyone
   who sees it, so posting them would train people to scroll past us. The map
   still shows everything; this gate is only about what we put our name to. */
export function credible(t, tf = 'h24', kind = 'pumpfun') {
  const b = BANDS[kind] || BANDS.pumpfun;
  const g = t && t.pc ? t.pc[tf] : null;
  if (g == null || !Number.isFinite(Number(g))) return false;
  if (!t.sym || t.banned || t.dust) return false;
  if (!(t.mcap >= b.mcap)) return false;
  /* Stocks and majors carry no DexScreener volume line, so the cap gate carries
     them on its own — a listed company is not a rug. */
  if (b.vol && !(t.vol >= b.vol)) return false;
  const n = Number(g);
  return n >= b.min && n <= b.max;
}

export function topMovers(tokens, tf = 'h24', n = 5, kind = 'pumpfun') {
  return (tokens || []).filter(t => credible(t, tf, kind))
    .sort((a, b) => Number(b.pc[tf]) - Number(a.pc[tf]))
    .slice(0, n);
}

/* The handle a token claims, if it plausibly belongs to it.

   pump.fun's twitter field is typed in by whoever minted the coin, so it is an
   attacker-controlled string: a scam token can name @elonmusk and we would tag
   him from our own account, vouching for it. Mentions are therefore off unless
   switched on, and even then the handle has to resemble the ticker or the name.
   Cashtags carry the reach anyway — $FONE is clickable on X and is how these
   communities already find posts about themselves. */
export function handleOf(t, env = {}) {
  if (String(env.XBOT_MENTIONS || '') !== '1') return '';
  const raw = String((t && t.twitter) || '');
  const m = raw.match(/(?:twitter|x)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  if (!m) return '';
  const h = m[1].toLowerCase();
  if (/^(i|intent|share|home|search|hashtag)$/.test(h)) return '';
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const sym = norm(t.sym), name = norm(t.name);
  if (!sym) return '';
  return (h.includes(sym) || sym.includes(h) || (name && (h.includes(name) || name.includes(h))))
    ? '@' + m[1] : '';
}

const gainStr = g => (Number(g) >= 0 ? '+' : '')
  + (Math.abs(Number(g)) >= 100 ? Math.round(Number(g)) : Number(g).toFixed(1)) + '%';

/* Trillions are reachable here: the majors post sums the whole top 250, which
   is a number in the low thousands of billions. Without this rung it read
   "$2748.92B tracked cap", which is correct and looks like a typo. */
const capStr = n => (n >= 1e12 ? '$' + (n / 1e12).toFixed(2) + 'T'
  : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n / 1e3) + 'K');

/* One post each. Every composer returns { text, share } or null when the data
   is not there — never a post carrying a number we did not measure. */
export const COMPOSERS = {
  /* The single hype coin. This is the one a community reposts, because it is
     about them and nobody else. */
  mover({ pumpfun, origin, env, state, now }) {
    const seen = (state && state.recent) || {};
    const t = topMovers(pumpfun, 'h24', 8)
      .filter(x => !seen[x.mint] || (now - seen[x.mint]) > REPOST_COOLDOWN_MS)[0];
    if (!t) return null;
    const at = handleOf(t, env);
    return {
      mint: t.mint,
      text: '$' + t.sym + ' ' + gainStr(t.pc.h24) + ' in 24h' + (at ? ' ' + at : '') + '\n\n'
        + capStr(t.mcap) + ' market cap · top mover on the bubble map right now\n'
        + origin + '/s/' + t.mint,
      share: '/s/' + t.mint,
    };
  },

  /* The ranking. Five communities with a reason to share it instead of one, and
     the cashtags put the post in front of each of them. */
  board({ pumpfun, origin }) {
    const top = topMovers(pumpfun, 'h24', 5);
    if (top.length < 3) return null;
    const lines = top.map((t, i) => (i + 1) + '. $' + t.sym + ' ' + gainStr(t.pc.h24));
    return {
      text: 'Top movers on pump.fun today\n\n' + lines.join('\n')
        + '\n\nLive map ↓\n' + origin + '/s/top',
      share: '/s/top',
    };
  },

  /* The state of the whole board. No single project to flatter, so this one is
     for people who follow the account rather than the coin. */
  market({ majors, origin }) {
    const rated = (majors || []).filter(t => t.pc && Number.isFinite(Number(t.pc.h24)));
    if (rated.length < 20) return null;
    const green = rated.filter(t => Number(t.pc.h24) > 0).length;
    const cap = rated.reduce((a, t) => a + (Number(t.mcap) || 0), 0);
    const best = rated.slice().sort((a, b) => Number(b.pc.h24) - Number(a.pc.h24))[0];
    return {
      text: 'Market check\n\n' + green + ' green / ' + (rated.length - green)
        + ' red across the top ' + rated.length + '\n'
        + capStr(cap) + ' tracked cap\n'
        + 'Leading: $' + best.sym + ' ' + gainStr(best.pc.h24) + '\n\n'
        + origin + '/s/top?source=majors',
      share: '/s/top?source=majors',
    };
  },

  /* Stocks, on the same map. A different audience arrives for these, and they
     are the one category here nobody expects. */
  stocks({ stocks, origin }) {
    const top = topMovers(stocks, 'h24', 5, 'stocks');
    if (top.length < 3) return null;
    const lines = top.map((t, i) => (i + 1) + '. $' + t.sym + ' ' + gainStr(t.pc.h24));
    return {
      text: 'Biggest movers in stocks today\n\n' + lines.join('\n')
        + '\n\nSame bubble map as the memecoins ↓\n' + origin + '/s/top?source=stocks',
      share: '/s/top?source=stocks',
    };
  },
};

/* Rotation, so the account is not one note. Weighted towards the single-coin
   post because that is the one that gets reposted, and anchored to the day
   number rather than a counter in storage: a wiped state file should not
   restart the cycle. */
export const TYPES = ['mover', 'board', 'mover', 'market', 'mover', 'board', 'stocks'];

export function dayOf(ms) { return Math.floor(ms / 86400000); }

/* Build the day's post, falling through to the next type when a feed is thin
   rather than skipping the day entirely. */
export function build(feeds, env, state, now, origin) {
  const start = dayOf(now) % TYPES.length;
  for (let i = 0; i < TYPES.length; i++) {
    const kind = TYPES[(start + i) % TYPES.length];
    let out = null;
    try { out = COMPOSERS[kind]({ ...feeds, origin, env, state, now }); } catch { out = null; }
    if (out && out.text) return { kind, ...out };
  }
  return null;
}

/* Called from cron. Returns what it did so a scheduled run is legible in logs
   rather than silently doing nothing for a week. */
export async function tick(env, store, feeds, origin = 'https://pumpbubble.fun') {
  if (!creds(env)) return { skipped: 'not configured' };

  const now = Date.now();
  const state = (await store.get(KEY)) || { recent: {}, count: 0, day: 0, lastAt: 0 };
  if (state.day !== dayOf(now)) { state.day = dayOf(now); state.count = 0; }

  if (state.count >= perDay(env)) return { skipped: 'daily cap' };
  if (now - (state.lastAt || 0) < MIN_GAP_MS) return { skipped: 'too soon' };
  /* Wait for the hour. Without this the day's post lands at whatever minute the
     first cron after midnight UTC fires, which is the middle of the night. */
  if (state.count === 0 && new Date(now).getUTCHours() < hourOf(env)) {
    return { skipped: 'before posting hour' };
  }

  let data;
  try { data = await feeds(); } catch { return { skipped: 'no feed' }; }

  const post = build(data, env, state, now, origin);
  if (!post) return { skipped: 'nothing worth posting' };

  const res = await postTweet(env, post.text);
  if (!res.ok) return { posted: false, kind: post.kind, why: res.why };

  if (post.mint) state.recent[post.mint] = now;
  state.lastAt = now;
  state.count = (state.count || 0) + 1;
  for (const [m, at] of Object.entries(state.recent || {})) {
    if (now - at > REPOST_COOLDOWN_MS) delete state.recent[m];
  }
  try { await store.put(KEY, state); } catch { /* a repeat is better than a crash */ }
  return { posted: true, kind: post.kind, id: res.id };
}
