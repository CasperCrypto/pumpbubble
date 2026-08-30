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

/* What the page needs to build a link itself.

   Deliberately not a per-token URL in the feed: 300 tokens would carry 300
   near-identical strings for a button most visitors never press. The template
   is sent once and the mint substituted on click. */
export function buyConfig(env = {}) {
  const id = String(env.REF_PROVIDER || '').toLowerCase();
  const p = PROVIDERS[id];
  const ref = String(env.REF_CODE || '').trim();

  /* No provider configured is the normal state until somebody signs up, and it
     has to be a quiet no rather than a half-working button. */
  if (!p) return { enabled: false, providers: Object.keys(PROVIDERS) };

  return {
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
