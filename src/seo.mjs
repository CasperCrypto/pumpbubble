/* ==========================================================================
   pumpbubble.fun — server-rendered market content

   The map is a <canvas>. To a crawler that is an empty box: measured on the
   live homepage, 196 indexable words, all of it UI chrome, and not one coin
   name. coin360 outranks us for market-overview queries because their page
   contains the market as text and ours does not.

   So /market renders the same data the map is drawing, as HTML, on the server.
   This is not a crawler trick: the table is visible to every visitor, it is the
   same numbers the bubbles show, and it is genuinely useful to anyone who wants
   to read rather than look. Serving different content to Googlebot would be
   cloaking and would eventually cost the ranking it bought.
   ========================================================================== */

const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const usd = n => {
  n = Number(n) || 0;
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
};

const price = n => {
  n = Number(n) || 0;
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(4);
  return '$' + n.toPrecision(3);
};

const pct = n => {
  n = Number(n) || 0;
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
};

/* ------------------------------------------------------------------ table */
export function marketTable(tokens, limit = 100) {
  const rows = tokens
    .filter(t => t.mcap > 0)
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, limit);

  if (!rows.length) return '<p class="muted">Market data is loading.</p>';

  return `<table class="mkt">
  <thead><tr>
    <th scope="col">#</th><th scope="col">Coin</th><th scope="col">Price</th>
    <th scope="col">1h</th><th scope="col">24h</th>
    <th scope="col">Market cap</th><th scope="col">Volume 24h</th>
  </tr></thead>
  <tbody>
${rows.map((t, i) => {
    const h1 = Number(t.pc?.h1) || 0, h24 = Number(t.pc?.h24) || 0;
    return `    <tr>
      <td class="rank">${i + 1}</td>
      <th scope="row" class="coin">${esc(t.name || t.sym)} <span>${esc(t.sym)}</span></th>
      <td>${price(t.price)}</td>
      <td class="${h1 >= 0 ? 'up' : 'dn'}">${pct(h1)}</td>
      <td class="${h24 >= 0 ? 'up' : 'dn'}">${pct(h24)}</td>
      <td>${usd(t.mcap)}</td>
      <td>${usd(t.vol)}</td>
    </tr>`;
  }).join('\n')}
  </tbody>
</table>`;
}

/* A one-line summary that reads like a person wrote it, because a crawler
   weights prose differently from a table and a reader wants the gist. */
export function marketSummary(tokens) {
  const t = tokens.filter(x => x.mcap > 0).sort((a, b) => b.mcap - a.mcap);
  if (!t.length) return '';
  const total = t.reduce((s, x) => s + x.mcap, 0);
  const up = t.filter(x => (Number(x.pc?.h24) || 0) >= 0).length;
  const movers = [...t].sort((a, b) =>
    Math.abs(Number(b.pc?.h24) || 0) - Math.abs(Number(a.pc?.h24) || 0)).slice(0, 3);

  return `Tracking ${t.length} coins worth ${usd(total)} in total. ` +
    `${up} are up over the last 24 hours and ${t.length - up} are down. ` +
    `The biggest moves: ` +
    movers.map(m => `${esc(m.sym)} ${pct(Number(m.pc?.h24) || 0)}`).join(', ') + '.';
}

/* --------------------------------------------------------- structured data */
/* An ItemList of the top coins, which is what a market-overview page actually
   is. Keep it to the same rows the table shows — structured data describing
   something not on the page is a manual-action risk, not a shortcut. */
export function marketJsonLd(tokens, { url, limit = 20 } = {}) {
  const rows = tokens.filter(t => t.mcap > 0).sort((a, b) => b.mcap - a.mcap).slice(0, limit);
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: 'Crypto Market Overview — live bubble map of the whole market',
        description: 'A live bubble map and table of the crypto market. Bubble size is market cap, colour is price change.',
        isPartOf: { '@type': 'WebSite', name: 'pumpbubble.fun', url: 'https://pumpbubble.fun' },
      },
      {
        '@type': 'ItemList',
        name: 'Top cryptocurrencies by market capitalisation',
        numberOfItems: rows.length,
        itemListElement: rows.map((t, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: `${t.name || t.sym} (${t.sym})`,
        })),
      },
    ],
  };
  /* </script> inside JSON would close the tag early */
  return `<script type="application/ld+json">${
    JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/* Fill the placeholders in a static page with live, server-rendered content. */
export function renderMarketPage(html, snapshot, url) {
  const tokens = snapshot?.tokens || [];
  const updated = new Date(snapshot?.ts || Date.now()).toISOString();
  return html
    .replace('<!--MARKET_SUMMARY-->', marketSummary(tokens))
    .replace('<!--MARKET_TABLE-->', marketTable(tokens))
    .replace('<!--MARKET_JSONLD-->', marketJsonLd(tokens, { url }))
    .replace(/<!--UPDATED-->/g, esc(updated));
}
