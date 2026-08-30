/* ==========================================================================
   pumpbubble.fun — the X poster

   A post is "$SYM +312% in 24h" plus a link to /s/<mint>, and X renders the
   share card from that link's Open Graph tags. The link matters more than the
   image: a picture posted directly is a dead end, while a link puts the card in
   the timeline *and* brings the click back to the map.

   Everything here is off unless four secrets are set. A half-configured poster
   that throws once an hour is worse than no poster.

   The filters are the important part. pump.fun's top mover at any moment is
   usually a token minted ten minutes ago showing +1452986%, which is a real
   number and reads as a scam to everybody who sees it. Posting those would
   train people to scroll past us. So a candidate needs a market cap, real
   volume, and a gain inside a band that a person would believe.
   ========================================================================== */

export const KEY = 'xbot';

/* Credibility filters, not data filters — the map still shows everything. */
const MIN_MCAP = 50_000;
const MIN_VOL = 10_000;
const MIN_GAIN = 25;
const MAX_GAIN = 1500;

/* Rate. A promotional account that posts every five minutes is a spam account. */
const MAX_PER_DAY = 5;
const MIN_GAP_MS = 3 * 60 * 60 * 1000;
const REPOST_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

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

/* Pick one token worth posting about, or nothing. */
export function pick(tokens, state, now = Date.now()) {
  const recent = (state && state.recent) || {};
  const ok = tokens.filter(t => {
    const g = t.pc && t.pc.h24;
    if (g == null || !Number.isFinite(Number(g))) return false;
    if (!t.mint || t.banned || t.dust) return false;
    if (!(t.mcap >= MIN_MCAP) || !(t.vol >= MIN_VOL)) return false;
    if (g < MIN_GAIN || g > MAX_GAIN) return false;
    if (recent[t.mint] && (now - recent[t.mint]) < REPOST_COOLDOWN_MS) return false;
    return true;
  });
  if (!ok.length) return null;
  return ok.sort((a, b) => b.pc.h24 - a.pc.h24)[0];
}

export function compose(t, origin) {
  const g = Number(t.pc.h24);
  const gain = '+' + (g >= 100 ? Math.round(g) : g.toFixed(1)) + '%';
  const cap = t.mcap >= 1e6 ? '$' + (t.mcap / 1e6).toFixed(1) + 'M'
                            : '$' + Math.round(t.mcap / 1e3) + 'K';
  return '$' + t.sym + ' ' + gain + ' in 24h\n\n'
    + cap + ' market cap · live on the bubble map\n'
    + origin + '/s/' + t.mint;
}

function dayOf(ms) { return Math.floor(ms / 86400000); }

/* Called from cron. Returns what it did so the scheduled run is legible in
   logs rather than silently doing nothing for a week. */
export async function tick(env, store, fetchTokens, origin = 'https://pumpbubble.fun') {
  if (!creds(env)) return { skipped: 'not configured' };

  const now = Date.now();
  const state = (await store.get(KEY)) || { recent: {}, count: 0, day: 0, lastAt: 0 };
  if (state.day !== dayOf(now)) { state.day = dayOf(now); state.count = 0; }

  if (state.count >= MAX_PER_DAY) return { skipped: 'daily cap' };
  if (now - (state.lastAt || 0) < MIN_GAP_MS) return { skipped: 'too soon' };

  let tokens = [];
  try { tokens = await fetchTokens(); } catch { return { skipped: 'no feed' }; }

  const t = pick(tokens, state, now);
  if (!t) return { skipped: 'nothing worth posting' };

  const res = await postTweet(env, compose(t, origin));
  if (!res.ok) return { posted: false, why: res.why };

  state.recent[t.mint] = now;
  state.lastAt = now;
  state.count = (state.count || 0) + 1;
  /* Keep the cooldown table from growing without bound. */
  for (const [m, at] of Object.entries(state.recent)) {
    if (now - at > REPOST_COOLDOWN_MS) delete state.recent[m];
  }
  try { await store.put(KEY, state); } catch { /* a repeat is better than a crash */ }
  return { posted: true, sym: t.sym, id: res.id };
}
