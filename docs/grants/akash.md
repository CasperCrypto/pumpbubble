# Akash ecosystem grant — application draft

Ready to paste into Akash's grant channel (akash.network/grants, the Akash forum, or a Community Pool
proposal drafted with the Community Awards Board). Written 2026-10-08. Numbers are live figures from
that day; refresh them before sending.

---

## Akash GPU Price Board & Open API — the open market's price of compute, in public

**Applicant:** pumpbubble.fun (Casper — t.me/casper_crypto, x.com/pumpbubblefun)
**Ask:** $12,000 in AKT, in three milestones
**Status:** the first version is already live — this grant extends it, not starts it

### Why now

CME set October 5, 2026 as the launch of its first regulated GPU futures (H100 and B200 rental-index
contracts). ICE has announced futures on Ornn's index. Compute is becoming a priced market, and the
reference prices behind those contracts are paid data: traders, builders and the press do not see
them. The one GPU market whose prices are public by design is Akash — and today almost nobody outside
Akash's own console sees them.

### What is live today

- **A GPU price strip on pumpbubble.fun's Compute map** — the hourly price of one H100, A100, RTX
  PRO 6000, RTX 5090 and RTX 4090 on Akash, the cheapest free GPU, GPUs free / listed, and the day's
  and week's move from our own hourly history. H100 read $2.72 an hour on 2026-10-08, beside Ornn's
  benchmark at $2.79: the open market priced in line with the institutional index.
- **A free, open JSON API**: `https://pumpbubble.fun/api/compute/gpus` (`?history=1` adds the hourly
  points). CORS open, cached five minutes, free with a link back.
- **Next to the market around it**: 17 compute tokens (AKT among them) and 38 compute companies
  (NVIDIA, TSMC, Micron, CoreWeave…) as live bubbles, so a visitor sees the price of compute and who
  sells it on one screen.
- ~8,000 visitors a month to the site, a Telegram buy bot in token communities, and an embed any site
  can drop in.

### What the grant funds

| Milestone | Delivers | Weeks | AKT (USD) |
|---|---|---|---|
| 1. The whole market | every GPU model Akash prices, not eight; price spread across providers (min / median / max); availability over time; a public daily archive (JSON + CSV, open repository) | 2 | $4,000 |
| 2. Out into the world | an embeddable price widget any site can paste (one iframe or one script); "Rent on Akash" on every GPU card, deep-linking into Akash Console for that model — the board sends demand, not just attention | 3 | $4,000 |
| 3. Three months of it, in public | weekly "price of compute" report and share card (Akash's open market against the futures benchmarks where licensable), posted on X and Telegram; API kept up and documented | 12 | $4,000 |

The board's code (`compute.mjs`) and the widget are published under MIT in a public repository at
milestone 1.

### How Akash benefits

- **Demand**: every card carries "Rent on Akash" into Console — measured as click-throughs.
- **A public benchmark**: "the open-market price of an H100" becomes a number journalists, traders
  and builders can quote, with Akash's name on it.
- **Distribution**: a weekly report and an embeddable widget carry Akash prices onto other sites.

### What we report

Monthly: API requests, widget embeds, click-throughs into Akash Console, report reach (views,
reposts). Public, in the forum thread.

### What we will not do

Invent or smooth a number. The board shows posted rates and says so ("posted rates, not trades");
a model Akash does not price is left off rather than estimated.

---

## Before sending — the operator's decisions

1. **Open-sourcing `src/compute.mjs` and the widget under MIT** — Akash's ecosystem grants fund
   open-source tools. The rest of the repository stays private.
2. **The amount** — $12,000 is a modest ask for a solo builder with a live product; Akash's
   developer grants have run from $100 to $100,000. Lower it to start smaller and faster.
3. **Who submits** — from the operator's own GitHub and forum accounts.
