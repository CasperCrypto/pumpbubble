# Embedding — the distribution product

The map is worth more on other people's sites than on ours alone. Every embed is a referral source,
and referral traffic is what makes boost and ad inventory worth buying. So the free tier is
deliberately generous: the attribution badge is the entire price, and the badge is the point.

Sales page: `/partners`. Widget: `/embed`.

## The two tiers

**Free.** Anyone, no key, no account. Live data, real art, choice of feed, timeframe and bubble
count. Carries a small "live on pumpbubble.fun" badge that links home with a UTM tag.

**Partner.** Monthly, invoiced, key issued by hand. Drops the badge, sets a custom accent colour,
and pins one token on screen regardless of ranking. Everything else identical.

What a partner **cannot** buy, at any price: anything that changes what the data says. Presentation
is for sale; the numbers are not. The moment an embed can misstate a market cap the map is worth
nothing to anybody, including the partner paying for it.

## Parameters

    /embed?mode=graduated&tf=h1&limit=60&real=1&k=<key>

| param | values | effect |
|---|---|---|
| `mode` | `graduated` (default), `bonding` | which feed |
| `tf` | `m5`, `h1` (default), `h6`, `h24` | timeframe colour is based on |
| `limit` | 10–200 | bubbles on screen |
| `real` | `1` (default), `0` | `0` shows unbacked and copycat tokens too |
| `k` | partner key | unlocks the paid presentation |

Out-of-range values fall back to defaults rather than erroring — an embed on someone else's page
must never render blank because of a typo in a query string.

## Issuing a partner key

```bash
node scripts/make-embed-key.mjs --site acme.fun --accent "#ff8a3d" --pin <mint> --months 1
```

It prints the embed code to send them. The key must be signed with the **same `IMG_SECRET` the
deployment uses** — in production that is the value the worker generated and stored in KV, not
whatever is in `.env`:

```bash
npx wrangler kv key get --binding=BUBBLE_KV img_secret --remote
```

Keys are HMAC-signed and carry their own permissions, so verifying one costs no storage and no
lookup. There is no key list to maintain and nothing to revoke against — which is the trade: to end
a partnership early you rotate `IMG_SECRET`, and that invalidates every key at once. With a handful
of partners that is fine. If it stops being fine, move keys into KV with an id per partner.

**The key is not a secret.** It sits in the partner's page source and anyone can copy it. That is
acceptable because it grants nothing but presentation — a copied key gets somebody an unbadged map,
which costs us a badge impression and nothing else.

## Expiry is deliberately soft

An expired key falls back to the free, badged tier. The embed keeps working.

A lapsed invoice should start a renewal conversation, not take the partner's homepage down. Breaking
their site is how you lose the renewal *and* the reference.

## Why `/embed` needs its own headers

The site-wide policy is `frame-ancestors 'none'` plus `X-Frame-Options: DENY`, which is correct for
a page that displays a payment address and wrong for the one route whose purpose is to live in
someone else's iframe.

`/embed` is therefore served by the worker with `frame-ancestors *` and no `X-Frame-Options`, set in
`worker/index.js` rather than in `_headers` — the worker runs first, so the exception does not
depend on which asset-layer rule wins. It is also served `noindex`: it is a widget, not a document
that should rank on its own.

## One file, not two

The embed is `index.html` in a stripped mode (`body.embed`), not a separate page. An embed that
drifts from the real map stops being a preview of the real map, which is the only reason a site
would put it there. Changes to the map reach every embed automatically.
