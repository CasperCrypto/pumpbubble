/* ==========================================================================
   pumpbubble.fun — trade referrals

   The map already tells somebody which token is moving. The gap between that
   and them buying it is one click, and that click is worth money to whoever
   routes it. This is the only revenue line that needs no sales effort and no
   inventory: it scales with traffic instead of competing with it.

   Two rules shape the whole file.

   **The destination is a template, not a redirect through us.** The link on the
   page points straight at the venue. Bouncing it through our own /go?to= would
   add a hop, leak the referrer, and make us look like a tracker — for nothing,
   because the referral credit lives in the destination URL either way.

   **A missing code means no button, not a broken one.** Every provider below is
   off until a code is configured. A Buy button that opens a terminal with
   somebody else's referral, or none at all, is worse than no button: it trains
   people to ignore it.

   Codes are read from the environment so they can be rotated without a deploy,
   and nothing here is secret — a referral code is public by construction, it
   travels in the URL. It lives in config only because it changes.
   ========================================================================== */

/* Solana venues. The shapes are the ones each product documents for its own
   affiliate links; a code that turns out to be wrong shows up as an unpaid
   referral, never as a broken page, because the mint is always in the path. */
export const PROVIDERS = {
  axiom: {
    id: 'axiom', label: 'Axiom',
    url: (mint, ref) => 'https://axiom.trade/t/' + mint + (ref ? '/' + ref : ''),
  },
  photon: {
    id: 'photon', label: 'Photon',
    url: (mint, ref) => ref
      ? 'https://photon-sol.tinyastro.io/en/r/' + ref + '/' + mint
      : 'https://photon-sol.tinyastro.io/en/lp/' + mint,
  },
  bullx: {
    id: 'bullx', label: 'BullX',
    url: (mint, ref) => 'https://neo.bullx.io/terminal?chainId=1399811149&address='
      + mint + (ref ? '&r=' + encodeURIComponent(ref) : ''),
  },
  gmgn: {
    id: 'gmgn', label: 'GMGN',
    url: (mint, ref) => 'https://gmgn.ai/sol/token/'
      + (ref ? encodeURIComponent(ref) + '_' : '') + mint,
  },
  trojan: {
    id: 'trojan', label: 'Trojan',
    url: (mint, ref) => 'https://t.me/solana_trojanbot?start=r-'
      + (ref ? encodeURIComponent(ref) + '-' : '') + mint,
  },
  jupiter: {
    id: 'jupiter', label: 'Jupiter',
    /* Jupiter's referral is an on-chain fee share rather than an affiliate
       programme, so the code is a wallet address and the split is explicit.
       It is the only one here that does not depend on somebody else's
       partner terms staying the same. */
    url: (mint, ref, bps) => 'https://jup.ag/swap/SOL-' + mint
      + (ref ? '?referrer=' + encodeURIComponent(ref) + '&feeBps=' + (bps || 50) : ''),
  },
};

/* The operator's pump.fun invite link (`PUMP_JOIN`). pump.fun credits a
   referrer when someone *creates an account* through it — it lands on an
   "invited you" page, not on a coin — so it cannot sit behind a Buy button
   (someone tapping Buy wants that token). It goes where new traders are: a
   line on the card of a Solana token, and the bot's Start menu. Only a
   pump.fun/join link is accepted, so the setting cannot point anywhere else. */
export function pumpJoin(env = {}) {
  const u = String(env.PUMP_JOIN || '').trim();
  return /^https:\/\/pump\.fun\/join\/[A-Za-z0-9_-]{2,40}$/.test(u) ? u : '';
}

/* Our own swap page (`public/swap.html`, `/swap?mint=`): Jupiter's widget,
   on our domain, with our fee on the quote once `JUP_REFERRAL` is set.

   It is the Buy button's destination whenever no trading-bot referral is
   configured. That bends the rule above on purpose: the rule exists because
   a link out to somebody else's terminal with no code on it spends the click
   and earns nothing. This link keeps the visitor on pumpbubble, and the day
   the referral account exists every click earns, with no deploy.

   The fee account is a Jupiter referral account — a public key, not a secret.
   Jupiter takes 50-255 bps in the plugin and keeps a fifth of it. */
export const SWAP_PATH = '/swap?mint=';
/* The swap page's Content-Security-Policy (served by worker/index.js). Wider
   than the map's because Jupiter's widget needs it; still no framing, no
   forms, no plugins, and scripts only from us and plugin.jup.ag. */
export const SWAP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://plugin.jup.ag",
  "style-src 'self' 'unsafe-inline' https://plugin.jup.ag https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com https://plugin.jup.ag",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
export const JUP_FEE_MIN = 50, JUP_FEE_MAX = 255;
export function swapConfig(env = {}) {
  const acct = String(env.JUP_REFERRAL || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(acct)) return { fee: false };
  const raw = Math.round(Number(env.JUP_FEE_BPS) || JUP_FEE_MIN);
  const feeBps = Math.min(JUP_FEE_MAX, Math.max(JUP_FEE_MIN, raw));
  return { fee: true, referralAccount: acct, feeBps };
}

/* What the page needs to build a link itself.

   Deliberately not a per-token URL in the feed: 300 tokens would carry 300
   near-identical strings for a button most visitors never press. The template
   is sent once and the mint substituted on click. */
export function buyConfig(env = {}) {
  const id = String(env.REF_PROVIDER || '').toLowerCase();
  const p = PROVIDERS[id];
  const ref = String(env.REF_CODE || '').trim();
  const join = pumpJoin(env);
  const swap = SWAP_PATH + '__MINT__';

  /* No trading-bot referral: Buy opens our own swap page instead. */
  if (!p) return { enabled: false, swap, providers: Object.keys(PROVIDERS), ...(join ? { join } : {}) };

  return {
    ...(join ? { join } : {}),
    swap,
    enabled: true,
    provider: p.id,
    label: p.label,
    hasCode: !!ref,
    /* MINT is substituted client-side. A placeholder rather than a function
       because this crosses a JSON boundary. */
    template: p.url('__MINT__', ref, Number(env.REF_FEE_BPS) || 0),
  };
}

export function buyUrl(env, mint) {
  const cfg = buyConfig(env);
  if (!cfg.enabled || !mint) return '';
  return cfg.template.replace('__MINT__', encodeURIComponent(mint));
}

/* Where a Buy for a Solana mint goes from outside the page (the bot's Buy
   and Copy buy): the trading-bot referral when set, else our swap page. */
export function buyOrSwap(env, origin, mint) {
  if (!mint) return '';
  return buyUrl(env, mint) || origin + SWAP_PATH + encodeURIComponent(mint);
}
