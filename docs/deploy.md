# Deploying pumpbubble.fun

The site needs a server. Not by choice: pump.fun answers **403 to any request carrying an `Origin`
header**, so a browser can never read its API directly. Static hosting (GitHub Pages, Netlify drop)
cannot work on its own.

Cloudflare Workers is the fit — free tier covers this comfortably, the edge cache is what makes the
IPFS token art fast, and the DNS for `pumpbubble.fun` can live in the same account.

## 1. Cloudflare

```bash
npm i -D wrangler          # only dev dependency in the project
npx wrangler login
```

Create the KV namespace that holds boosts, ad slots and market-cap history:

```bash
npx wrangler kv namespace create BUBBLE_KV
```

Paste the printed id into `wrangler.toml` under `[[kv_namespaces]]`.

## 2. Secrets

```bash
npx wrangler secret put IMG_SECRET
```
Any long random string. It signs image-proxy URLs — without it the proxy would be an open relay for
the whole internet. Changing it later just invalidates old image URLs, which is harmless.

```bash
npx wrangler secret put SOLANA_RPC
```
**Do not ship the public endpoint.** `api.mainnet-beta.solana.com` returns 429 under real load —
measured, not assumed — and payments would silently fail to verify. Helius, QuickNode and Triton
all have a free tier that is plenty; step-by-step Helius setup is in `docs/payments.md`.
It goes in as a *secret*, not a var, because the API key is part of the URL.

The **treasury wallet** is already set in `wrangler.toml` under `[vars]`. It is public by nature —
it is printed in the boost modal — so it is not a secret, and keeping it in version control means
the one value that decides where money goes changes only through a reviewed commit. Use a
**dedicated wallet**, not a personal one, and move funds out of it periodically.

## 3. Deploy

```bash
npx wrangler deploy
node scripts/check.mjs https://pumpbubble.<your-subdomain>.workers.dev
```

The smoke test checks the three fields the product is defined by (ticker, image, market cap), data
freshness, that the image proxy refuses unsigned URLs, and that gold stays under the 25% cap. It
exits non-zero on failure, so it can gate a deploy.

## 4. Domain

Once `pumpbubble.fun` is registered, add it to Cloudflare (Websites → Add a site) and point the
registrar's nameservers at the two Cloudflare gives you. Then uncomment in `wrangler.toml`:

```toml
[[routes]]
pattern = "pumpbubble.fun"
custom_domain = true
```

and `npx wrangler deploy` again. Cloudflare issues the certificate itself; there is no CNAME file
and no DNS record to add by hand.

If the registrar cannot delegate nameservers, the alternative is a CNAME from `pumpbubble.fun` to
the workers.dev hostname, with the route configured as a custom domain in the dashboard.

## Cost

Free tier limits, against what this actually uses:

| | Free tier | Used |
|---|---|---|
| Worker requests | 100k/day | 1 per visitor per 15s, plus images (edge-cached) |
| KV writes | 1000/day | ~288 (history every 5 min) + one per boost sold |
| KV reads | 100k/day | 1 per `/api/tokens` |
| Cron | included | every 5 min |

The design keeps history in isolate memory and only persists every 5 minutes specifically to stay
inside the 1000 writes/day ceiling. If you move to Durable Objects later that constraint goes away.

## Do this straight after the first deploy

Add a Cloudflare **Rate Limiting rule** (Security → WAF → Rate limiting rules) on `/api/*`, around
300 requests/minute per IP. There is an in-process limiter already, but it only sees one isolate —
only the edge rule is global. Details in `docs/security.md`.

## Watch after launch

- `npx wrangler tail` — live logs.
- `/api/health` — last snapshot error, cached token count, whether treasury and RPC are configured.
- `/api/boost/history` — the public ledger of every boost sold, with Solscan links.
- The one thing that would break everything: **pump.fun blocking Cloudflare egress IPs.** It cannot
  be tested before deploying. If `/api/health` shows persistent fetch errors while the same call
  works from your laptop, that is what happened — the fix is to move ingest to a small VPS or a
  Cloudflare Tunnel and keep the Worker as the cache in front.

## Deploying without a terminal

The local wrangler flow needs an interactive login and the right working
directory. Neither is always available, so there are two other routes.

### Cloudflare Workers Builds (recommended)

Cloudflare builds and deploys straight from GitHub. No GitHub Actions minutes,
no local terminal.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Workers** →
   **Connect to Git**, and pick `CasperCrypto/pumpbubble`.
2. It reads `wrangler.toml`, so no build command is needed. Deploy command
   stays the default `npx wrangler deploy`.
3. Every push to `main` deploys from then on.

### GitHub Actions

`.github/workflows/deploy.yml` does the same thing, gated on the payment tests.
It is set to **manual trigger only**, because Actions bills against a minutes
quota on private repos and this account's billing is blocked — a push trigger
would fail before the job started and mail a failure notice each time.

To use it: add a repository secret `CLOUDFLARE_API_TOKEN` (Settings → Secrets
and variables → Actions), then run it from the Actions tab. To deploy on every
push, restore the `push:` trigger noted at the top of the file.

### What still has to be done once, in the dashboard

Neither route creates storage or secrets for you:

- **KV namespace** — Storage & Databases → KV → Create → name it `BUBBLE_KV`,
  then paste its id into `wrangler.toml`. The id is not a secret.
- **Worker secrets** — the worker's Settings → Variables and Secrets:
  - `SOLANA_RPC` — your Helius URL (secret: the key is in the URL)
  - `IMG_SECRET` — any long random string
