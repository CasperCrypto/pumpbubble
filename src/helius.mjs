/* ==========================================================================
   pumpbubble.fun — Helius webhook, for the buybot

   Buy alerts need to hear about a transaction within seconds of it landing.
   Polling cannot do that at any rate a free tier allows, pump.fun's own trade
   endpoints answer 404 now, and a persistent websocket is exactly the thing a
   Worker does not hold. A webhook is the shape that fits: Helius watches the
   addresses we care about and POSTs each transaction to us as it happens.

   One webhook, many addresses. Every group's token adds its mint (and its
   deepest pool, where one exists — some routes list only the pool) to a single
   address list, and the list is rewritten whenever it changes. Raw payloads
   rather than "enhanced" ones, because a buy is read off balances in
   src/solbuy.mjs and needs nobody's interpretation of the instructions.

   The key is the one already inside SOLANA_RPC when that is a Helius URL, so
   turning the bot on adds no second Helius secret — and rotating the RPC key
   rotates this too, which is the direction that rotation should work in.
   ========================================================================== */

export const KEY = 'tg:helius';

/* api.helius.xyz — the webhooks API. `api.helius-rpc.com` does not resolve
   (Cloudflare 530 / 1016, origin DNS), which is what the first /setup in a
   real group reported: "helius 530 error code: 1016". The RPC lives on
   helius-rpc.com; the REST API does not. */
const API = 'https://api.helius.xyz/v0/webhooks';

export function heliusKey(env = {}) {
  if (env.HELIUS_KEY) return String(env.HELIUS_KEY);
  const rpc = String(env.SOLANA_RPC || '');
  const m = rpc.match(/[?&]api-key=([A-Za-z0-9-]+)/);
  return m ? m[1] : '';
}

/* The value Helius sends back in the Authorization header on every delivery.
   Derived from the key so there is nothing extra to store, and long enough
   that guessing it is not a plan. */
export async function deliveryAuth(env) {
  const key = heliusKey(env);
  if (!key) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key + ':pumpbubble:tg-trade'));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function call(env, method, path = '', body) {
  const key = heliusKey(env);
  if (!key) throw new Error('no helius key');
  const r = await fetch(API + path + '?api-key=' + encodeURIComponent(key), {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) throw new Error('helius ' + r.status + ' ' + (j && (j.error || j.message) || txt.slice(0, 120)));
  return j;
}

/* A short fingerprint of an address set, kept beside the webhook's id: every
   create or edit costs a hundred credits, so a sync whose set is the one
   Helius already has is skipped (src/tgbot.mjs, syncHelius). */
export function addrHash(addresses) {
  let h = 0x811c9dc5;
  for (const c of [...new Set(addresses)].filter(Boolean).sort().join(',')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* Point the webhook at this deployment's /tg/trade with the set of addresses
   it should watch. Creates the webhook the first time, updates it after, and
   remembers its id in KV so a redeploy does not create a second one. */
export async function syncWebhook(env, store, origin, addresses) {
  const auth = await deliveryAuth(env);
  if (!auth) return { ok: false, error: 'no helius key' };
  const want = {
    webhookURL: origin + '/tg/trade',
    transactionTypes: ['ANY'],
    accountAddresses: [...new Set(addresses)].filter(Boolean),
    webhookType: 'raw',
    authHeader: auth,
  };
  /* An empty address list is a webhook that fires for nothing, which is fine —
     but Helius rejects it, so with no groups the webhook is simply deleted. */
  let saved = null;
  try { saved = await store.get(KEY); } catch { /* fall through */ }

  if (!want.accountAddresses.length) {
    if (saved && saved.id) {
      /* forget the id only once the webhook is really gone: a refused delete
         (a halted plan refuses everything) that cleared it anyway left a
         webhook nobody could find again, delivering into credits after the
         reset */
      try { await call(env, 'DELETE', '/' + saved.id); }
      catch (e) { if (!/404|not found/i.test(String(e && e.message))) return { ok: false, error: String(e && e.message || e) }; }
      try { await store.put(KEY, null); } catch {}
    }
    return { ok: true, addresses: 0, deleted: !!(saved && saved.id) };
  }

  const h = addrHash(want.accountAddresses);
  if (saved && saved.id) {
    try {
      const j = await call(env, 'PUT', '/' + saved.id, want);
      try { await store.put(KEY, { ...saved, at: Date.now(), url: want.webhookURL, h }); } catch {}
      return { ok: true, id: saved.id, addresses: want.accountAddresses.length, updated: true, raw: j && j.webhookID };
    } catch (e) {
      /* The saved id may belong to a webhook that was deleted from the Helius
         dashboard; fall through and create a fresh one. */
      if (!/404|not found/i.test(String(e.message))) throw e;
    }
  }
  const j = await call(env, 'POST', '', want);
  const id = j && (j.webhookID || j.id);
  if (!id) throw new Error('helius returned no webhook id');
  try { await store.put(KEY, { id, at: Date.now(), url: want.webhookURL, h }); } catch {}
  return { ok: true, id, addresses: want.accountAddresses.length, created: true };
}

export async function webhookInfo(env, store) {
  let saved = null;
  try { saved = await store.get(KEY); } catch {}
  if (!saved || !saved.id) return { configured: !!heliusKey(env), exists: false };
  try {
    const j = await call(env, 'GET', '/' + saved.id);
    return {
      configured: true, exists: true, id: saved.id,
      url: j && j.webhookURL, addresses: (j && j.accountAddresses || []).length,
    };
  } catch (e) {
    return { configured: true, exists: false, id: saved.id, error: String(e.message) };
  }
}
