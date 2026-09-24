/* ==========================================================================
   pumpbubble.fun — boosts (the paid layer)

   Solana Pay with a unique reference pubkey per order, exactly as planned in
   CLAUDE.md: no processor, no KYC, no chargebacks. The reference is a random
   32-byte address that is never a signer — it only has to be a valid pubkey
   so it lands in the transaction's account list, where we can find it again.

   Storage is injected (`store`), so the same logic runs on Cloudflare KV in
   production and on a Map in local dev.
   ========================================================================== */

import { applyBid, bidOrderFields } from './bids.mjs';

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

/* Orders are stateless and signed, not stored.

   Writing every quote to KV would mean anyone could burn the 1000 writes/day
   free-tier budget just by opening the boost modal in a loop — and it would
   leave a pile of expired orders to garbage-collect. Instead the order is
   HMAC-signed and handed to the client, which passes it back when polling.
   Nothing in it is secret (amount, treasury and reference are all shown in the
   modal); the signature is only there so none of it can be edited. Storage now
   happens exactly once per actual sale. */
export async function signOrder(order, secret) {
  const body = btoa(unescape(encodeURIComponent(JSON.stringify(order))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sig = btoa(String.fromCharCode(...new Uint8Array(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return body + '.' + sig;
}

export async function readOrder(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const want = btoa(String.fromCharCode(...new Uint8Array(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(
      atob(body.replace(/-/g, '+').replace(/_/g, '/')))));
  } catch { return null; }
}

export async function createOrder({ mint, chain = 'solana', sym, name, img, mcap, grad, tierId, solPrice, treasury, ref = '', taken = [], kind = 'boost', bidSol = 0 }) {
  /* The treasury is always a Solana account — that is where the money lands,
     whatever chain the advertised token is on. */
  if (!isPubkey(treasury)) throw new Error('treasury wallet not configured');
  /* The token identifier is validated against its own chain. A Base contract is
     not a Solana pubkey and checking it as one refused every non-Solana boost. */
  const evm = chain !== 'solana';
  if (evm ? !/^0x[0-9a-f]{40}$/i.test(mint) : !isPubkey(mint)) {
    throw new Error('that is not a valid token address');
  }
  if (!(solPrice > 0)) throw new Error('no SOL price available');
  /* Reject an unknown tier rather than quietly billing them for another one. */
  if (tierId && !TIERS[tierId]) throw new Error('unknown boost tier');

  const tier = tierOf(tierId);
  /* Priced in USD, settled in SOL. The rate is locked into the order so the
     amount cannot drift between quote and payment.

     The amount carries a random nonce in its final lamports, which is what
     identifies the payment. Solana Pay puts our reference key in the
     transaction, but a trader who copies the address out of the modal and
     sends from their wallet produces a transaction with no reference in it at
     all — the unique amount is what lets that payment be matched anyway.

     The nonce is drawn from ~1e6 values, not a few hundred: with only 900 the
     birthday collision across ~20 concurrent orders is around 20%, and a
     collision means someone's payment activates someone else's bubble. All
     arithmetic is in integer lamports, so matching is exact rather than
     float-tolerant. */
  /* Six decimals, not nine. Measured against a real payment: Phantom's deep
     link prefills the amount correctly, but anyone paying by hand has to type
     it, and a nine-decimal figure gets truncated — a live attempt sent
     0.104550140 against a quote of 0.104550144 and went unmatched.

     Six decimals is typeable and still leaves 999 distinct nonces per price
     point. Uniqueness is guaranteed rather than hoped for: `taken` carries the
     amounts of every pending order, and the nonce is drawn from what is free. */
  let lamports = 0;
  if (kind === 'bid') {
    /* A bid's amount is the bidder's, not ours: they are buying a rank, and
       what that rank is worth is exactly the question the board asks. */
    ({ lamports } = bidOrderFields(bidSol, taken));
  } else {
    const baseLamports = Math.floor((tier.usd / solPrice) * 1e3) * 1e6; // 0.001 SOL granularity
    const used = new Set(taken);
    for (let i = 0; i < 200 && !lamports; i++) {
      const nonce = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 999);
      const candidate = baseLamports + nonce * 1000;                   // 1 microSOL steps
      if (!used.has(candidate)) lamports = candidate;
    }
    /* every nonce at this price is in flight — extremely unlikely, but never
       issue a quote that could match somebody else's payment */
    if (!lamports) throw new Error('too many boosts being paid for right now — try again in a minute');
  }

  const amountSol = lamports / LAMPORTS;
  const now = Date.now();
  const order = {
    id: 'ord_' + newReference().slice(0, 16),
    reference: newReference(),
    mint, chain, sym: sym || '', name: name || '', img: img || '', mcap: mcap || 0,
    grad: grad !== false,
    kind,
    tier: kind === 'bid' ? 'bid' : tier.id,
    mult: kind === 'bid' ? 0 : tier.mult,
    hours: kind === 'bid' ? 0 : tier.hours,
    /* A bid has no USD price — it is whatever was offered, converted only for
       display and for the affiliate commission. */
    usd: kind === 'bid' ? Math.round(lamports / 1e9 * solPrice * 100) / 100 : tier.usd,
    solPrice, amountSol, lamports,
    treasury,
    /* The referral code is signed into the order so it cannot be swapped after
       the buyer has seen the price. Whether it is worth anything is decided at
       confirmation, against the affiliate list and the payer's wallet. */
    ref: ref || '',
    status: 'pending',
    createdAt: now,
    expiresAt: now + ORDER_TTL_MS,
  };
  order.payUrl = solanaPayUrl(order);
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

/* How many lamports a transaction moved into the treasury. Balance delta is the
   honest measure: it survives any instruction shape, including a transfer
   wrapped in a CPI. Integer lamports throughout — no float comparisons on
   money. Returns 0 if the treasury is not in the transaction. */
const accountKeys = tx => (tx?.transaction?.message?.accountKeys || [])
  .map(k => (typeof k === 'string' ? k : k.pubkey));

function receivedLamports(tx, treasury) {
  const keys = accountKeys(tx);
  const idx = keys.indexOf(treasury);
  if (idx < 0) return 0;
  const pre = tx?.meta?.preBalances?.[idx];
  const post = tx?.meta?.postBalances?.[idx];
  if (pre == null || post == null) return 0;
  return post - pre;
}

/* One failed lookup must not abort the scan: public RPCs 429 constantly, and
   giving up on the first one would strand a payment that already landed. */
async function getTx(rpcUrl, sig) {
  try {
    return await rpc(rpcUrl, 'getTransaction',
      [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
  } catch { return null; }
}

/* One shared scan of recent treasury activity, cached.

   The obvious implementation — scan the chain once per status poll — costs a
   getTransaction per recent payment per polling buyer. At a 6s poll that is
   hundreds of RPC calls a minute and burns a free Helius tier in days. Since
   every pending order is looking at the same treasury, the scan is done once
   for everybody and reused: RPC cost becomes constant no matter how many
   people are paying at the same time. */
const scanCache = { at: 0, payments: [], inflight: null };
const SCAN_TTL = 10_000;
const MAX_DECODES_PER_SCAN = 25;

export async function scanTreasury(rpcUrl, treasury, force = false) {
  const now = Date.now();
  if (!force && now - scanCache.at < SCAN_TTL) return scanCache.payments;
  if (scanCache.inflight) return scanCache.inflight;

  scanCache.inflight = (async () => {
    try {
      const sigs = await rpc(rpcUrl, 'getSignaturesForAddress', [treasury, { limit: 100 }]);
      const fresh = [];
      /* An order can be paid up to 24h after it was quoted, so nothing older
         than that can belong to one. getSignaturesForAddress already reports
         blockTime, so old history is skipped without spending a getTransaction
         on it — the difference between a usable treasury and a wallet that
         takes a minute to scan because it has years of activity behind it. */
      const notBefore = Math.floor(Date.now() / 1000) - 25 * 3600;
      let decodes = 0;

      for (const s of (Array.isArray(sigs) ? sigs : [])) {
        if (s.err) continue;
        if (s.blockTime && s.blockTime < notBefore) break;   // list is newest-first

        /* reuse anything already decoded — transactions are immutable */
        const known = scanCache.payments.find(p => p.signature === s.signature);
        if (known) { fresh.push(known); continue; }

        /* Bound the cold start. In steady state only new transactions decode. */
        if (++decodes > MAX_DECODES_PER_SCAN) break;

        const tx = await getTx(rpcUrl, s.signature);
        if (!tx || tx.meta?.err) continue;
        const lamports = receivedLamports(tx, treasury);
        if (lamports > 0) {
          fresh.push({
            signature: s.signature, lamports,
            blockTime: s.blockTime || 0, slot: s.slot,
            /* Keep the account list: a Solana Pay transaction carries the
               order's reference key here, which identifies the order without
               relying on the amount. Free, since the transaction is already
               decoded. */
            keys: accountKeys(tx),
          });
        }
      }
      scanCache.payments = fresh;
      scanCache.at = Date.now();
      return fresh;
    } catch {
      /* keep serving the last good scan rather than reporting everyone unpaid */
      return scanCache.payments;
    } finally {
      scanCache.inflight = null;
    }
  })();
  return scanCache.inflight;
}

/* Match an order against the shared scan. Exact lamports, and the payment must
   not predate the quote. Returns { signature, received, slot } or null. */
export async function findPayment(rpcUrl, order) {
  const payments = await scanTreasury(rpcUrl, order.treasury);
  const notBefore = Math.floor(order.createdAt / 1000) - 120;   // clock skew allowance
  /* keys[0] is the fee payer, i.e. the wallet that actually sent this. It is
     what makes a self-referral check possible later. */
  const hit = p => ({ signature: p.signature, received: p.lamports / LAMPORTS,
                      slot: p.slot, payer: p.keys && p.keys[0] || '' });

  const candidates = payments.filter(p => !p.blockTime || p.blockTime >= notBefore);

  /* 1. Reference key present — a Solana Pay transaction naming this order.
        Here we can accept an overpayment, because the reference says which
        order it belongs to. Never a shortfall: paying less than the price
        buys nothing regardless of how the payment identifies itself. */
  for (const p of candidates) {
    if (p.keys?.includes(order.reference) && p.lamports >= order.lamports) return hit(p);
  }

  /* 2. No reference — someone copied the address out of the modal. The unique
        amount is the only identifier, so it has to match to the lamport: a
        larger payment is indistinguishable from a different order's. */
  for (const p of candidates) {
    if (p.lamports === order.lamports) return hit(p);
  }
  return null;
}

/* ============================================================== boost maths

   Size comes from what was paid, and paid size has to stay proportional or the
   map stops working. Two constraints pull against each other:

     - many small buyers must be able to out-boost one whale (that is the
       product: micro-boosts are expected to out-earn big packages)
     - no amount of money may let one bubble swallow the screen

   Adding bonuses linearly satisfied the first and violated the second. Modelled
   on the real tiers: fifty $9 boosts on one token reached radius x16 — a 480px
   bubble, larger than a phone screen — because nothing bounded the sum.

   So bonus is a function of *total decayed spend*, not a sum of per-order
   multipliers:

       bonus = SPEND_K * spend^SPEND_EXP        (capped at BONUS_CAP)

   The exponent is not invented. The existing price ladder — $9→x1.5, $49→x2.4,
   $149→x4.0 — already follows spend^0.64 almost exactly, so this curve
   reproduces every advertised tier for a single purchase (x1.46, x2.40, x3.92)
   while making the tenth buyer add less than the first. Same prices, same
   headline numbers, sane stacking. */

/* Fitted to the two ends of the existing ladder, so all three advertised
   multipliers come out within a rounding error:
     exponent = ln(3.0/0.5) / ln(149/9) = 0.637,  K = 0.5 / 9^0.637
   giving $9 -> x1.50, $49 -> x2.47, $149 -> x3.99 against advertised
   x1.5 / x2.4 / x4.0. The tiers were never arbitrary; this just names the
   curve they were already on and extends it to pooled spend. */
const SPEND_EXP = 0.637;
const SPEND_K = 0.1233;
const BONUS_CAP = 5.0;       // radius x4 — beyond this one bubble owns the map

/* The inverse of the curve below: what spend buys a given bonus. The console
   sets a house bubble's size as "×2" or "×4" — what the face will print —
   and this turns that into the spend the one sizing path already understands,
   so a house bubble is sized exactly like a paid one of the same face. */
export function spendForBonus(bonus) {
  const b = Math.max(0, Math.min(BONUS_CAP, Number(bonus) || 0));
  return b > 0 ? Math.pow(b / SPEND_K, 1 / SPEND_EXP) : 0;
}

export function bonusFromSpend(usd) {
  if (!(usd > 0)) return 0;
  return Math.min(BONUS_CAP, SPEND_K * Math.pow(usd, SPEND_EXP));
}

/* What one order still counts for. Decays linearly to zero across its lifetime,
   so staying big means paying again — the decay is the product, not a detail.
   It decays the *spend*, which then goes through the curve above; decaying the
   bonus directly would make two half-spent boosts worth more than one whole. */
export function liveSpend(b, now = Date.now()) {
  /* A house boost is the operator's own permanent feature, not a purchase, so
     it neither decays nor expires. Everything downstream — pooling, the bonus
     curve, the gold-share guardrail, the re-add path for a token that leaves
     the feed — treats it exactly like any other boost, which is the point:
     one definition of paid size, not two that drift apart. */
  if (b.house) return b.usd;
  const span = b.until - b.startedAt;
  if (span <= 0) return 0;
  const left = (b.until - now) / span;
  return left <= 0 ? 0 : b.usd * left;
}

/* Kept for the single-order case and for tests. */
export function bonusOf(b, now = Date.now()) {
  return bonusFromSpend(liveSpend(b, now));
}

/* ============================================================ pending orders

   Quotes are stateless and signed, which is right for the quote itself. But a
   payment can only be reconciled against something that knows it is owed, and a
   stateless quote lives only in the buyer's tab. Measured in production: a
   correct, exact payment went unclaimed because the page navigated away to
   Phantom and nothing was left polling. Nothing server-side knew the order had
   ever existed, so nothing could put it right.

   So an order is persisted at the moment the buyer commits to paying — not when
   the modal opens — and a sweep matches arriving payments against the list.
   That is one write per real intent, and it makes the closed-tab case, the
   crashed-browser case and the paid-then-walked-away case all recoverable.

   The whole list lives under one key: it is small, it is always read as a unit,
   and one key means one write per order rather than a key per order. */

const PENDING_KEY = 'pending';
const PENDING_TTL = 26 * 3600 * 1000;    // outlive the 24h payment window

export async function listPending(store, now = Date.now()) {
  const all = (await store.get(PENDING_KEY)) || [];
  return all.filter(o => now - o.createdAt < PENDING_TTL);
}

export async function addPending(store, order) {
  const all = await listPending(store);
  if (all.some(o => o.id === order.id)) return all;
  /* keep it bounded: this is a work queue, not an archive */
  const kept = all.slice(-400).concat({
    id: order.id, mint: order.mint, sym: order.sym, name: order.name, img: order.img,
    mcap: order.mcap, grad: order.grad, tier: order.tier, mult: order.mult, hours: order.hours,
    usd: order.usd, lamports: order.lamports, amountSol: order.amountSol,
    reference: order.reference, treasury: order.treasury, ref: order.ref || '',
    createdAt: order.createdAt, expiresAt: order.expiresAt,
  });
  await store.put(PENDING_KEY, kept);
  return kept;
}

export async function dropPending(store, ids) {
  const gone = new Set(ids);
  const all = await listPending(store);
  const kept = all.filter(o => !gone.has(o.id));
  if (kept.length !== all.length) await store.put(PENDING_KEY, kept);
  return kept;
}

/* Match every arriving payment against every pending order in one pass.
   Returns the boosts it activated. Safe on a timer and safe to run twice:
   activation is idempotent on the transaction signature. */
export async function sweepPayments(store, rpcUrl, treasury, resolveRef = null) {
  const pending = await listPending(store);
  if (!pending.length) return [];

  const payments = await scanTreasury(rpcUrl, treasury, true);
  if (!payments.length) return [];

  const existing = (await store.get('boosts')) || [];
  const claimed = new Set(existing.map(b => b.sig));
  const activated = [];
  const done = [];

  for (const order of pending) {
    const notBefore = Math.floor(order.createdAt / 1000) - 120;
    const hit = payments.find(p =>
      !claimed.has(p.signature) &&
      (!p.blockTime || p.blockTime >= notBefore) &&
      (p.lamports === order.lamports ||
        /* a Solana Pay transaction naming this order may also overpay */
        (p.keys?.includes(order.reference) && p.lamports >= order.lamports)));
    if (!hit) continue;
    claimed.add(hit.signature);
    const payer = (hit.keys && hit.keys[0]) || '';
    /* the closed-tab path must credit the referrer exactly as the live poll does */
    const ref = resolveRef
      ? await resolveRef({ code: order.ref, usd: order.usd, payer })
      : null;
    const boost = await activateBoost(store, order,
      { signature: hit.signature, received: hit.lamports / LAMPORTS, slot: hit.slot,
        payer, ref });
    activated.push(boost);
    done.push(order.id);
  }

  /* clear what was paid, and what is too old to ever be paid */
  const stale = pending.filter(o => Date.now() - o.createdAt > 24 * 3600 * 1000).map(o => o.id);
  if (done.length || stale.length) await dropPending(store, [...done, ...stale]);
  return activated;
}

export async function activeBoosts(store, now = Date.now()) {
  const list = (await store.get('boosts')) || [];
  /* A house bubble now has a duration the operator picks; one written before
     that carries `until` a century out, so the same test serves both. */
  const live = list.filter(b => (b.house && !b.until) || b.until > now);
  const byMint = new Map();
  for (const b of live) {
    const cur = byMint.get(b.mint) ||
      { mint: b.mint, sym: b.sym, bonus: 0, liveUsd: 0, spentUsd: 0, until: 0, count: 0 };
    /* Pool the decayed spend; the curve is applied once, to the total. Summing
       per-order bonuses instead is what made stacking unbounded. */
    cur.liveUsd += liveSpend(b, now);
    cur.spentUsd += b.usd;
    cur.count++;
    cur.until = Math.max(cur.until, b.until);
    cur.sym = cur.sym || b.sym;
    cur.name = cur.name || b.name || '';
    cur.img = cur.img || b.img || '';
    cur.mcap = cur.mcap || b.mcap || 0;
    if (cur.grad === undefined) cur.grad = b.grad !== false;
    byMint.set(b.mint, cur);
  }
  for (const cur of byMint.values()) cur.bonus = bonusFromSpend(cur.liveUsd);
  return { live, byMint };
}

export async function activateBoost(store, order, payment) {
  /* A bid rides the identical payment machinery and lands in a different
     ledger. Branching here rather than at each call site means the live poll,
     the closed-tab sweep and any future path all credit it the same way. */
  if (order.kind === 'bid') {
    return applyBid(store, {
      mint: order.mint, sym: order.sym, name: order.name, img: order.img,
      mcap: order.mcap, sol: payment.received,
      sig: payment.signature, payer: payment.payer,
    });
  }

  const now = Date.now();
  const list = (await store.get('boosts')) || [];
  /* idempotent: the same signature must never buy two boosts */
  if (list.some(b => b.sig === payment.signature)) {
    return list.find(b => b.sig === payment.signature);
  }
  const boost = {
    id: order.id,
    mint: order.mint,
    /* Carried so the map knows which chain to price it on, and so the re-add
       builds it as a contract rather than as a Solana mint. */
    chain: order.chain || 'solana',
    sym: order.sym,
    /* kept so a boosted token that is outside the ranked feed still renders
       with its real art and name rather than as a blank circle */
    name: order.name || '',
    img: order.img || '',
    mcap: order.mcap || 0,
    /* which feed it belongs to, so the paid bubble is re-added to the right map */
    grad: order.grad !== false,
    tier: order.tier,
    mult: order.mult,
    usd: order.usd,
    sol: payment.received,
    sig: payment.signature,
    payer: payment.payer || '',
    /* commission owed on this sale, decided server-side at confirmation time and
       never recomputed afterwards */
    ref: payment.ref || null,
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
  /* Keyed by whichever identifier the token actually has. A Solana token is its
     mint; an ERC-20 on Base or Robinhood Chain has no mint and is its contract
     address, so indexing on `mint` alone silently never matched them and a
     house boost on an EVM token did nothing at all. */
  const idx = new Map(tokens.map(t => [t.addr || t.mint, t]));
  for (const [mint, b] of byMint) {
    const t = idx.get(mint);
    if (t) { t.boost = b.bonus; t.boostUsd = b.spentUsd; t.boostUntil = b.until; }
  }
  return tokens;
}

/* Guardrail from CLAUDE.md: total gold must stay under ~25% of bubble area, or
   the inventory eats the thing being sold.

   This has to mirror sizes() in index.html exactly, or it measures a map that
   is not the one being drawn. Market caps span 4+ orders of magnitude, so the
   renderer log-compresses them into a 0.30–1.00 radius band and only then
   multiplies by the boost. Measuring raw sqrt(mcap) instead makes the largest
   token look far more dominant than it is on screen, and would refuse a single
   top-tier boost on exactly the tokens most likely to buy one. */
export function goldShare(tokens) {
  if (!tokens.length) return 0;
  const vals = tokens.map(t => Math.max(t.mcap, 1e-9));
  const lo = Math.log(Math.min(...vals));
  const hi = Math.log(Math.max(...vals));
  const sp = Math.max(hi - lo, 1e-6);

  let gold = 0, total = 0;
  for (let i = 0; i < tokens.length; i++) {
    const norm = Math.pow((Math.log(vals[i]) - lo) / sp, 0.85);
    const r = (0.30 + 0.70 * norm) * (1 + (tokens[i].boost || 0) * 0.6);
    const area = r * r;
    total += area;
    if (tokens[i].boost > 0) gold += area;
  }
  return total > 0 ? gold / total : 0;
}
