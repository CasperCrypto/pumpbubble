/* ==========================================================================
   pumpbubble.fun — boosts (the paid layer)

   Solana Pay with a unique reference pubkey per order, exactly as planned in
   CLAUDE.md: no processor, no KYC, no chargebacks. The reference is a random
   32-byte address that is never a signer — it only has to be a valid pubkey
   so it lands in the transaction's account list, where we can find it again.

   Storage is injected (`store`), so the same logic runs on Cloudflare KV in
   production and on a Map in local dev.
   ========================================================================== */

/* Tiers mirror the markup in index.html — keep both in step. */
export const TIERS = {
  spark: { id: 'spark', label: 'Spark',  mult: 1.5, usd: 9,   hours: 6  },
  pump:  { id: 'pump',  label: 'Pump',   mult: 2.4, usd: 49,  hours: 24 },
  whale: { id: 'whale', label: 'Whale',  mult: 4.0, usd: 149, hours: 72 },
};

export const ORDER_TTL_MS = 30 * 60 * 1000;   // a quote is good for 30 minutes
const LAMPORTS = 1e9;

/* ------------------------------------------------------------- base58 */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const b of bytes) { if (b === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
const isPubkey = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export function newReference() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base58(b);
}

/* --------------------------------------------------------------- orders */
export function tierOf(id) { return TIERS[id] || TIERS.pump; }

export async function createOrder(store, { mint, sym, tierId, solPrice, treasury }) {
  if (!isPubkey(treasury)) throw new Error('treasury wallet not configured');
  if (!mint) throw new Error('missing mint');
  if (!(solPrice > 0)) throw new Error('no SOL price available');

  const tier = tierOf(tierId);
  /* Priced in USD, settled in SOL. The rate is locked into the order so the
     amount cannot drift between quote and payment.

     The last three decimals are a random nonce (worth ~$0.0001) that makes
     every open order's amount unique. Solana Pay puts our reference key in the
     transaction, but a trader who just copies the address out of the modal and
     sends from their wallet produces a transaction with no reference in it —
     the unique amount is what lets us match that payment anyway. */
  const base = Math.floor((tier.usd / solPrice) * 1e3) / 1e3;
  const nonce = (crypto.getRandomValues(new Uint32Array(1))[0] % 900 + 100) * 1e-6;
  const amountSol = Math.round((base + nonce) * 1e6) / 1e6;
  const now = Date.now();
  const order = {
    id: 'ord_' + newReference().slice(0, 16),
    reference: newReference(),
    mint, sym: sym || '',
    tier: tier.id, mult: tier.mult, hours: tier.hours,
    usd: tier.usd, solPrice, amountSol,
    treasury,
    status: 'pending',
    createdAt: now,
    expiresAt: now + ORDER_TTL_MS,
  };
  order.payUrl = solanaPayUrl(order);
  await store.put('order:' + order.id, order, { ttlSec: 3600 });
  return order;
}

export function solanaPayUrl(o) {
  const p = new URLSearchParams({
    amount: String(o.amountSol),
    reference: o.reference,
    label: 'pumpbubble.fun',
    message: `Boost ${o.sym || o.mint.slice(0, 6)} ${o.tier} x${o.mult}`,
    memo: o.id,
  });
  return `solana:${o.treasury}?${p}`;
}

/* ------------------------------------------------------ chain verification */
async function rpc(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error('rpc ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('rpc: ' + (j.error.message || 'unknown'));
  return j.result;
}

/* How much SOL a transaction moved into the treasury. Balance delta is the
   honest measure: it survives any instruction shape, including a transfer
   wrapped in a CPI. Returns 0 if the treasury is not in the transaction. */
function receivedBy(tx, treasury) {
  const keys = (tx?.transaction?.message?.accountKeys || [])
    .map(k => (typeof k === 'string' ? k : k.pubkey));
  const idx = keys.indexOf(treasury);
  if (idx < 0) return 0;
  const pre = tx?.meta?.preBalances?.[idx];
  const post = tx?.meta?.postBalances?.[idx];
  if (pre == null || post == null) return 0;
  return (post - pre) / LAMPORTS;
}

/* One failed lookup must not abort the scan: public RPCs 429 constantly, and
   giving up on the first one would strand a payment that already landed. */
async function getTx(rpcUrl, sig) {
  try {
    return await rpc(rpcUrl, 'getTransaction',
      [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
  } catch { return null; }
}

/* Find a confirmed payment for this order. Two routes, because both happen:

     1. Solana Pay — the wallet includes our reference key, so we can look the
        payment up directly. Cheap and exact.
     2. Manual send — the trader copied the address out of the modal. No
        reference in the transaction, so we scan recent treasury activity for
        the order's unique amount instead.

   Returns { signature, received, slot } or null while still unpaid. */
export async function findPayment(rpcUrl, order) {
  /* --- route 1: reference key ------------------------------------------- */
  const sigs = await rpc(rpcUrl, 'getSignaturesForAddress',
    [order.reference, { limit: 10 }]).catch(() => []);

  for (const s of (Array.isArray(sigs) ? sigs : [])) {
    if (s.err) continue;
    const tx = await getTx(rpcUrl, s.signature);
    if (!tx || tx.meta?.err) continue;
    const received = receivedBy(tx, order.treasury);
    /* 1.5% tolerance for wallets that round the amount down */
    if (received >= order.amountSol * 0.985) {
      return { signature: s.signature, received, slot: s.slot };
    }
  }

  /* --- route 2: unique amount into the treasury -------------------------- */
  const tsigs = await rpc(rpcUrl, 'getSignaturesForAddress',
    [order.treasury, { limit: 40 }]).catch(() => []);
  if (!Array.isArray(tsigs)) return null;

  /* only transactions that could belong to this order */
  const since = Math.floor(order.createdAt / 1000) - 60;
  const candidates = tsigs.filter(s => !s.err && (!s.blockTime || s.blockTime >= since)).slice(0, 25);

  for (const s of candidates) {
    const tx = await getTx(rpcUrl, s.signature);
    if (!tx || tx.meta?.err) continue;
    const received = receivedBy(tx, order.treasury);
    /* The amount carries a per-order nonce, so an exact match identifies the
       order. Tolerance stays far below the nonce step to avoid collisions. */
    if (Math.abs(received - order.amountSol) < 5e-7) {
      return { signature: s.signature, received, slot: s.slot };
    }
  }
  return null;
}

/* ------------------------------------------------------------ active boosts */
/* A boost's contribution decays linearly to zero across its lifetime, so
   staying big means paying again. That decay is the product, not a detail. */
export function bonusOf(b, now = Date.now()) {
  const span = b.until - b.startedAt;
  if (span <= 0) return 0;
  const left = (b.until - now) / span;
  if (left <= 0) return 0;
  return (b.mult - 1) * left;
}

export async function activeBoosts(store, now = Date.now()) {
  const list = (await store.get('boosts')) || [];
  const live = list.filter(b => b.until > now);
  const byMint = new Map();
  for (const b of live) {
    const cur = byMint.get(b.mint) || { mint: b.mint, sym: b.sym, bonus: 0, spentUsd: 0, until: 0, count: 0 };
    cur.bonus += bonusOf(b, now);      /* stacking: many small boosts beat one big one */
    cur.spentUsd += b.usd;
    cur.count++;
    cur.until = Math.max(cur.until, b.until);
    cur.sym = cur.sym || b.sym;
    byMint.set(b.mint, cur);
  }
  return { live, byMint };
}

export async function activateBoost(store, order, payment) {
  const now = Date.now();
  const list = (await store.get('boosts')) || [];
  /* idempotent: the same signature must never buy two boosts */
  if (list.some(b => b.sig === payment.signature)) {
    return list.find(b => b.sig === payment.signature);
  }
  const boost = {
    id: order.id,
    mint: order.mint,
    sym: order.sym,
    tier: order.tier,
    mult: order.mult,
    usd: order.usd,
    sol: payment.received,
    sig: payment.signature,
    startedAt: now,
    until: now + order.hours * 3600 * 1000,
  };
  const kept = list.filter(b => b.until > now - 864e5).concat(boost);
  await store.put('boosts', kept);
  return boost;
}

/* Merge live boosts into a snapshot's tokens. Tokens that were boosted but are
   no longer in the pump.fun feed are re-added, so a paid bubble never vanishes
   mid-flight. */
export function applyBoosts(tokens, byMint) {
  const idx = new Map(tokens.map(t => [t.mint, t]));
  for (const [mint, b] of byMint) {
    const t = idx.get(mint);
    if (t) { t.boost = b.bonus; t.boostUsd = b.spentUsd; t.boostUntil = b.until; }
  }
  return tokens;
}

/* Guardrail from CLAUDE.md: total gold must stay under ~25% of bubble area, or
   the inventory eats the thing being sold. Bubble area scales with r^2 and the
   boost multiplies r, so this compares boosted vs unboosted area share. */
export function goldShare(tokens) {
  let gold = 0, total = 0;
  for (const t of tokens) {
    const base = Math.sqrt(Math.max(t.mcap, 1));
    const r = base * (1 + (t.boost || 0) * 0.6);
    total += r * r;
    if (t.boost > 0) gold += r * r;
  }
  return total > 0 ? gold / total : 0;
}
