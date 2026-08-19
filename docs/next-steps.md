# Next steps — prompts to paste into Claude Code

Each of these is a self-contained task. Roughly in order of expected return.

## Done since the last pass

- **Backend + pump.fun ingest.** Turned out to be mandatory, not optional: pump.fun 403s any
  request with an `Origin` header, so the browser can never read it. `src/` + `worker/` + `server/`.
- **Real Solana Pay boosts.** Unique reference per order, on-chain verification, server-side decay.
  See `docs/payments.md`.
- **Image proxy.** HMAC-signed, edge-cached, and it repairs the dead `cf-ipfs.com` URLs pump.fun
  still serves.

## 1. Buy button with referral routing

> Add a Buy action to the hover tooltip and the mobile token card, routed through a referral link
> (Jupiter, or a bot referral like Axiom/Photon/BullX/Trojan — make the provider configurable in
> one place). Track clicks server-side so the click-through rate is visible.

Why first: highest expected revenue, no sales effort, and it doesn't touch the map's integrity.
Every other screener monetises this way for a reason.

## 2. Boost leaderboard + boost-war view

> Add a leaderboard: biggest bubble right now, biggest today, all-time record boost. Plus a
> "boost war" mode where size comes only from boost spend. Make it shareable (OG image + a clean
> share card).

Why: this is the screenshot people post. Free marketing loop, and it makes boosts competitive
rather than a one-off purchase. The boost records already carry `spentUsd` and timestamps.

## 3. Payment webhook instead of polling

> Replace the `/api/boost/status` polling with a Helius webhook pointed at the worker, so a boost
> activates the moment the transaction confirms. Keep the polling path as a fallback, and add a
> cron sweep over pending orders so a payment still activates if the buyer closed the tab.

Why: closing the tab currently strands an activation (the money arrives, the boost doesn't start).
That is the one payment failure mode that will generate support messages.

## 4. Per-trade bubble flashes via PumpPortal

> Add PumpPortal's free WebSocket to the worker's ingest, and push trade events to the browser so
> bubbles flash on individual trades instead of only moving on the 15s refresh.

Why: this is the differentiator — nobody does it well. The ingest already lives server-side, which
is where the socket belongs.

## 5. Pre-graduation "bonding" mode

> Add a second mode for tokens still on the bonding curve, using Bitquery's pump.fun endpoints
> (they expose bonding-curve market cap). Keep it a separate toggle from graduated tokens.

Note: sorting by market cap currently returns ~96% graduated tokens, so the bonding-curve world is
essentially invisible today. Its lifetimes are so different that the same 24h axis doesn't apply.

---

## Things not to break

- Gold bubbles must never be mistakable for genuinely large-cap tokens
- Total gold stays under ~25% of on-screen bubble area (`goldShare` in `/api/tokens`)
- Live numbers are never nudged or smoothed — only demo data animates
- Keep 5m/1h/6h/24h selectable; a 24h change is meaningless for a token minutes old
- Never ship API keys client-side; the image proxy stays signed
- Don't round the boost amount — the last decimals are a per-order nonce (`docs/payments.md`)
- Test at 1440×900 and 390×844, and run `node scripts/check.mjs` before calling a change done
