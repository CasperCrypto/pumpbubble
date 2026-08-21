/* ==========================================================================
   pumpbubble.fun — affiliates

   Most of the reach comes from people telling other communities to boost. That
   is unpaid sales work, and it should not stay unpaid: an affiliate gets a cut
   of every boost bought through their link.

   Design constraints, all of them consequences of this being real money:

   - Commission is decided server-side and recorded on the boost at the moment
     the chain confirms payment. It is never taken from the client, never
     recomputed later, and it never affects what the buyer pays.
   - Commission is only ever owed on revenue that actually arrived. There is no
     path that credits an affiliate for an unpaid order.
   - Self-referral is detected and voided, because the payer's wallet is in the
     transaction we already fetched. An affiliate paying themselves through
     their own link is a 20% discount, not a referral.
   - Everything an affiliate earned is visible to them, keyed off the same
     public boost ledger, so the numbers can be checked rather than trusted.

   Payouts are manual. Accruing and settling by hand is the right shape while
   the list is small, and it avoids putting a spend key anywhere near a worker.
   ========================================================================== */

const KEY = 'affiliates';
const PAYOUTS = 'payouts';

export const DEFAULT_PCT = 20;          // percent of each boost, to the referrer
const MAX_PCT = 50;                     // a guard against a fat-fingered override

/* Codes appear in URLs and in Telegram messages, so keep them unmistakable:
   lowercase, no punctuation that a chat client will linkify or mangle. */
export const isCode = s =>
  typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{2,23}$/.test(s);

const isWallet = s =>
  typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export async function listAffiliates(store) {
  return (await store.get(KEY)) || {};
}

export async function getAffiliate(store, code) {
  if (!isCode(code)) return null;
  const all = await listAffiliates(store);
  const a = all[code];
  return a && a.active !== false ? a : null;
}

export async function upsertAffiliate(store, { code, wallet, name = '', pct = DEFAULT_PCT }) {
  if (!isCode(code)) throw new Error('code must be 3-24 chars: a-z, 0-9, _ or -');
  if (!isWallet(wallet)) throw new Error('wallet must be a Solana address');
  const p = Number(pct);
  if (!(p > 0 && p <= MAX_PCT)) throw new Error(`pct must be between 0 and ${MAX_PCT}`);

  const all = await listAffiliates(store);
  all[code] = {
    code, wallet, name: String(name).slice(0, 40), pct: p,
    active: true,
    createdAt: all[code]?.createdAt || Date.now(),
  };
  await store.put(KEY, all);
  return all[code];
}

/* What an affiliate earns on one boost. Rounded to cents, and never more than
   the boost itself was worth. */
export function commissionUsd(usd, pct) {
  const c = (Number(usd) || 0) * (Number(pct) || 0) / 100;
  return Math.max(0, Math.min(Number(usd) || 0, Math.round(c * 100) / 100));
}

/* Resolve the referral for an order that has just been paid.

   `payer` is the wallet that actually sent the SOL, read from the transaction —
   which is what makes the self-referral check possible at all. */
export async function resolveReferral(store, { code, usd, payer }) {
  if (!code) return null;
  const aff = await getAffiliate(store, code);
  if (!aff) return null;

  /* Paying yourself through your own link is a discount, not a referral. */
  if (payer && aff.wallet === payer) {
    return { code: aff.code, wallet: aff.wallet, pct: aff.pct, usd: 0, voided: 'self-referral' };
  }

  return {
    code: aff.code,
    wallet: aff.wallet,
    pct: aff.pct,
    usd: commissionUsd(usd, aff.pct),
  };
}

/* ------------------------------------------------------------- statements */
/* Built from the boost ledger rather than a separate tally, so an affiliate's
   statement and the public record cannot disagree. */
export async function statement(store, code) {
  const aff = await getAffiliate(store, code);
  if (!aff) return null;

  const boosts = (await store.get('boosts')) || [];
  const mine = boosts.filter(b => b.ref && b.ref.code === code);

  const earned = mine.reduce((s, b) => s + (b.ref.usd || 0), 0);
  const payouts = ((await store.get(PAYOUTS)) || []).filter(p => p.code === code);
  const paid = payouts.reduce((s, p) => s + (p.usd || 0), 0);

  return {
    code: aff.code,
    name: aff.name,
    wallet: aff.wallet,
    pct: aff.pct,
    referrals: mine.length,
    earnedUsd: Math.round(earned * 100) / 100,
    paidUsd: Math.round(paid * 100) / 100,
    owedUsd: Math.round((earned - paid) * 100) / 100,
    /* the same transactions anyone can audit in /api/boost/history */
    boosts: mine.slice(-100).reverse().map(b => ({
      sym: b.sym, tier: b.tier, usd: b.usd,
      commissionUsd: b.ref.usd || 0,
      voided: b.ref.voided || null,
      at: b.startedAt,
      explorer: 'https://solscan.io/tx/' + b.sig,
    })),
    payouts: payouts.slice(-50).reverse(),
  };
}

export async function recordPayout(store, { code, usd, sig = '', note = '' }) {
  if (!isCode(code)) throw new Error('bad code');
  const list = (await store.get(PAYOUTS)) || [];
  list.push({ code, usd: Number(usd) || 0, sig, note, at: Date.now() });
  await store.put(PAYOUTS, list);
  return list;
}
