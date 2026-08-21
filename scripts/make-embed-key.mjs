/* ==========================================================================
   Issue a partner embed key.

       node --env-file-if-exists=.env scripts/make-embed-key.mjs \
         --site acme.fun --pin <mint> --accent "#ff8a3d" --months 1

   Keys are HMAC-signed with IMG_SECRET and carry their own permissions, so
   there is nothing to store and nothing to look up when one is used. Issue them
   by hand — this is a monthly B2B sale, and a conversation with a customer is
   not a bottleneck worth automating until there are enough of them to be one.

   IMPORTANT: the key must be signed with the SAME IMG_SECRET the deployment
   uses. In production that is the value the worker generated and keeps in KV,
   not whatever is in .env — read it with:
       npx wrangler kv key get --binding=BUBBLE_KV img_secret --remote
   ========================================================================== */

import { signEmbedKey } from '../src/embed.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const secret = process.env.IMG_SECRET || arg('secret');
if (!secret) {
  console.error(`
  No signing secret.

  Pass --secret <value>, or set IMG_SECRET. For production, read the one the
  worker actually uses:

    npx wrangler kv key get --binding=BUBBLE_KV img_secret --remote
`);
  process.exit(1);
}

const site = arg('site');
if (!site) { console.error('  --site is required (the partner domain, for your own records)'); process.exit(1); }

const accent = arg('accent');
if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) {
  console.error('  --accent must be a 6-digit hex colour like #ff8a3d'); process.exit(1);
}

const pin = arg('pin');
if (pin && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pin)) {
  console.error('  --pin must be a Solana mint address'); process.exit(1);
}

const months = Math.max(1, parseInt(arg('months', '1'), 10) || 1);
const exp = Date.now() + months * 30 * 24 * 3600 * 1000;

const claims = { tier: 'partner', brand: false, site, accent, pin, exp, iat: Date.now() };
const key = await signEmbedKey(claims, secret);

const params = new URLSearchParams({ k: key });
if (arg('limit')) params.set('limit', arg('limit'));
if (arg('tf')) params.set('tf', arg('tf'));
if (arg('mode')) params.set('mode', arg('mode'));

console.log(`
  partner   ${site}
  expires   ${new Date(exp).toISOString().slice(0, 10)}  (${months} month${months > 1 ? 's' : ''})
  accent    ${accent || '(ours)'}
  pinned    ${pin || '(none)'}

  Embed code to send them:

<iframe src="https://pumpbubble.fun/embed?${params}"
        style="width:100%;height:600px;border:0;border-radius:16px"
        loading="lazy" title="Live pump.fun bubble map"></iframe>

  The key is not a secret — it is visible in their page source. It cannot be
  used to change anything about the data, only how the map is presented, and
  copying it to another site gains nothing worth protecting.

  When it expires the embed keeps working and falls back to the free, badged
  tier. A lapsed invoice should start a renewal conversation, not take the
  partner's page down.
`);
