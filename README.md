# pumpbubble.fun

Live bubble map for pump.fun tokens. Every bubble is a token — size is market cap, colour is price
change, gold means someone paid to make it big.

Ticker, image and market cap come from pump.fun itself. Price change and volume come from
DexScreener, because pump.fun exposes no change field.

## Run it

```bash
npm run dev
# → http://localhost:8787
```

No dependencies, no build step. Node 20+.

The front end is still one self-contained file (`public/index.html`), but it can no longer be
opened straight off disk: **pump.fun returns 403 to any request carrying an `Origin` header**, so
the token feed has to be read server-side. `npm run dev` runs the same API the Worker runs.

Check a running instance, local or deployed:

```bash
node scripts/check.mjs http://localhost:8787
```

## Layout

```
public/index.html   front end — canvas 2D, hand-rolled soft-body physics, zero deps
src/core.mjs        pump.fun fetch, DexScreener enrichment, history, image signing
src/boosts.mjs      tiers, Solana Pay orders, on-chain verification, decay
src/api.mjs         all HTTP routes (web-standard Request/Response)
worker/index.js     Cloudflare adapter — KV, edge image cache, cron
server/dev.mjs      Node adapter — in-memory, also serves public/
scripts/check.mjs   smoke test, exits non-zero so it can gate a deploy
```

`src/*` runs unmodified in Node and in Workers. One implementation of every route.

## Features

- Live pump.fun data, 300 tokens, refreshed every 15s (server caches upstream for 10s)
- Soft-body "liquid" bubbles that deform against each other
- Timeframe 5m / 1h / 6h / 24h · size by market cap, gain or volume · min-mcap, movement and text
  filters
- Hover tooltip on desktop, tap-for-detail card on mobile, click through to pump.fun
- Boosts: pay in SOL, bubble turns gold and grows past everyone, decays so it has to be renewed
- Ad rail above the map, sold slots configurable without a deploy
- Edge-cached, signature-protected image proxy so IPFS art never touches the render loop

## Earning

| | How | Status |
|---|---|---|
| Boosts | Solana Pay, self-serve, verified on-chain — `docs/payments.md` | built |
| Ad slots | rail above the map, slots live in KV | built, sold manually |
| Trade referrals | Buy button routed through Jupiter or a bot referral | not built — best next thing |
| Pro subscription | alerts, more bubbles, no ads | not built |

## Deploying

Cloudflare Workers. Full walkthrough, including the domain and the free-tier maths, in
`docs/deploy.md`.

```bash
npx wrangler login
npx wrangler kv namespace create BUBBLE_KV     # paste the id into wrangler.toml
npx wrangler secret put IMG_SECRET             # any long random string
npx wrangler secret put SOLANA_RPC             # Helius/QuickNode — the public RPC 429s
npx wrangler deploy
```

The treasury wallet is in `wrangler.toml` (it is public by nature — the modal prints it).
The map runs fine without an RPC; only boost checkout needs one.

## Security

The map renders attacker-controlled strings — anyone can mint a token called `<img src=x
onerror=…>` — next to a payment address. Threat model and defences are in `docs/security.md`.
Short version: escaped on write, stripped on the server, CSP behind both; orders are HMAC-signed so
tier, amount and treasury cannot be edited; boosts come only from a confirmed on-chain payment, so
editing the page fakes nothing for anyone but yourself.

Every boost ever sold is published at `/api/boost/history` with its Solana transaction, so the gold
on the map is auditable.

## Status

Live data and live payments. Not yet load-tested in production, and boost activation waits on a
client poll rather than a webhook — see the known limits in `docs/payments.md`.

See `CLAUDE.md` for architecture, product rules and the reasoning behind them.
