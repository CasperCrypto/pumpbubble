# Growth plan — 2026-11-23 (~30,000 visitors a month)

Written as the product, marketing and trading view on "we need more users". What competitors
do is from general knowledge of these products, not a fresh audit — check before quoting it.

## Where we stand

What nobody else has in one place: the **bubble map across pump.fun, Base, Robinhood Chain,
majors and stocks**; **KOLs ranked by what pump.fun paid them against what their calls did for
followers** (hold-now); **top traders by realized profit, not paper**; **smart money holdings**;
a **free buy bot that tags top-trader and KOL buys**; a swap with a 1% fee.

What is weak: data that depends on pump.fun (refusing servers since 13 Nov — KOL records, Calls,
Traders read days old), no accounts/watchlists (nothing brings a visitor back), the bot's Solana
watcher without a keyed RPC (no alerts), and distribution (the X account and the bot are the only
channels).

## The competition, and the one thing to take from each

| product | what it is good at | take |
|---|---|---|
| DexScreener | every pair on every chain, charts, paid boosts/trending | they sell trending slots — our trending is computed; say so loudly |
| GMGN / Axiom / Photon / BullX | trading terminals: smart-money wallets, sniping, copy trading, 1-click buy | they hold keys; we never do. Our copy-trade is alerts + your own wallet — sell that as safety |
| Birdeye | token analytics, holders, wallet PnL | per-token holder and wallet pages rank in Google — our `/t/` pages should carry more |
| Bubblemaps | holder-cluster bubbles (who owns the supply) | **a holder-cluster view on the token card** is the most-asked-for data we lack |
| cryptobubbles.net | the bubble look, huge SEO from "crypto bubbles" | our map is the same idea for memecoins — target "pump.fun bubbles", "memecoin bubble map" |
| Kolscan / Cielo | KOL and wallet leaderboards, wallet alerts | we beat them on *paid vs. what followers kept*; publish it weekly |
| Bobby / Major / Safeguard (TG bots) | buy alerts, captcha | ours is free with smart tags and a card picture; the bot is the distribution |

## Features, in the order they should be built

1. **Watchlist + price alerts in the bot** (no account: the Telegram user *is* the account).
   "Alert me when $X moves 20%" / "when a top trader buys $X". The only thing that brings people
   back daily. Cheap: AudienceDO already fans out per user.
2. **Holders on the token card and `/t/` page**: top-10 share, dev share, new-holder rate, and
   whether top traders / KOLs hold it (we already know). Jupiter's audit gives most of it.
3. **"Did this KOL dump on you?" per call** — a share card per KOL: paid $X, followers kept 0.15×.
   The most shareable thing we can make; post one a day from the X account.
4. **Daily "Bubble report"** — one auto post + `/report/<date>` page: top movers, smart money
   entries, the KOL of the day, the cheapest GPU and power. One page a day is a page a day in
   Google, and a reason to follow on X/Telegram.
5. **Wallet pages** `/wallet/<addr>` for every top trader and KOL: their board ranks, callout
   rewards, last calls — server-rendered for SEO ("<name> pump.fun wallet").
6. **Pro** ($9–19/mo, paid in SOL/USDC like boosts): unlimited alerts, wallet-tracker slots
   beyond ten, no sponsored line, CSV export of the boards. Only after 1–2 have users.

Not now: our own launchpad, auto-trading, a mobile app (the site is the app; add a PWA install
prompt instead — the manifest exists).

## Data to add

- Holder concentration and dev holding on every Solana token (Jupiter audit, already fetched).
- Liquidity locked / burned (pump.fun graduations burn LP — say so; it is a trust signal).
- Per-token "smart money in / out last 24h" (from the boards we already read).
- Energy map: Japan, Taiwan, Malaysia, Kazakhstan, Mexico, Thailand, Vietnam still grey — each
  needs an industrial figure from a source that publishes it (see scripts/tariffs.mjs header).

## Distribution — what actually moves the number

- **Keep the bot in groups**: every alert is an ad seen by a whole community. Outreach list in the
  console; the welcome gold hour is the pitch.
- **One X post a day** from data only we have (KOL hold-now, realized-profit traders, smart money
  ZCAT ×16). The Share top 10 popup already writes them.
- **SEO**: done this week — tools hub, smart money, signals, new tokens, copy trading, 250 token
  pages in the sitemap, edge-cached pages. Next: Search Console + Bing Webmaster, IndexNow after
  deploys, AI crawlers unblocked in Cloudflare, listings (AlternativeTo, Product Hunt, Solana
  ecosystem pages, Telegram bot catalogs).
- **Workers Paid ($5/mo)** is a growth item, not an ops item: every free-tier stop (KV writes, DO
  time, 100k requests) is a day the site looks broken to new visitors.
