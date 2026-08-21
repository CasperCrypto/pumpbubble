/* ==========================================================================
   pumpbubble.fun — embedding

   The map is worth more on other people's sites than on ours alone: every
   embed is a referral source, and referral traffic is what makes boost and ad
   inventory worth buying. So the free tier is deliberately generous — the
   attribution badge is the price, and it is the whole distribution engine.

   The paid tier removes the badge and lets a partner make the map theirs:
   their token pinned, their accent colour, their own list. That is a monthly
   B2B sale, not a self-serve one, so keys are issued by hand — the same way ad
   slots are. No billing integration until somebody asks for an invoice.

   A key is HMAC-signed and carries its own permissions, so verifying one costs
   no storage and no lookup. Same construction as a boost order: the contents
   are not secret, the signature only stops them being edited.
   ========================================================================== */

const enc = new TextEncoder();

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(body, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}

/* What a partner is allowed to change. Anything not listed here is not for
   sale — in particular nothing that would let an embed misrepresent the data. */
export const FREE = Object.freeze({
  tier: 'free',
  brand: true,        // the attribution badge, and the reason free exists
  accent: '',         // our colours
  pin: '',            // no pinned token
  site: '',
});

export async function signEmbedKey(claims, secret) {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  return body + '.' + await hmac(body, secret);
}

export async function readEmbedKey(key, secret) {
  if (typeof key !== 'string' || !key.includes('.')) return null;
  const [body, sig] = key.split('.');
  const want = await hmac(body, secret);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
  } catch { return null; }
}

/* Resolve a request's embed configuration. An absent, forged or expired key is
   not an error — it is simply the free tier, because an embed that breaks on a
   lapsed subscription takes the partner's page down with it and turns a renewal
   conversation into an outage. It degrades to branded instead. */
export async function embedConfig(key, secret) {
  if (!key || !secret) return { ...FREE };
  const claims = await readEmbedKey(key, secret);
  if (!claims) return { ...FREE, note: 'key not recognised' };
  if (claims.exp && Date.now() > claims.exp) {
    return { ...FREE, note: 'key expired', site: claims.site || '' };
  }
  return {
    tier: claims.tier || 'partner',
    brand: claims.brand !== false ? false : false,   // paid tiers drop the badge
    accent: typeof claims.accent === 'string' ? claims.accent.slice(0, 24) : '',
    pin: typeof claims.pin === 'string' ? claims.pin.slice(0, 44) : '',
    site: claims.site || '',
    exp: claims.exp || 0,
  };
}

/* Only ever emit a colour we produced or that matches a strict pattern — an
   accent value ends up in a style attribute, and a partner-supplied string is
   still a string from outside. */
export const safeAccent = s =>
  /^#[0-9a-f]{6}$/i.test(s || '') ? s : '';
