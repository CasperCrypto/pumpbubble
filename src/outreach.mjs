/* ==========================================================================
   pumpbubble.fun — who to invite to the buy bot.

   The bot spreads itself one group at a time: every alert shows pumpbubble to
   everyone in a token's community. Finding those communities by hand meant
   scrolling pump.fun for an hour; this is the list instead, for the console.

   A lead is a pump.fun coin that has a community worth reaching and is not
   already running our bot:
   - graduated, backed by our own quality filter (no copycat swarms, no paper
     caps), between $50K and $50M;
   - two hours to thirty days old: past the first-hour rugs, still active;
   - traded in the last half hour;
   - a Telegram or X link the project typed in itself, kept only when it is a
     plain https link to t.me / x.com / twitter.com.
   Telegram first, because the bot lives in Telegram groups; then by 24h
   volume. Measured 2026-10-15: one coin in fifty freshly graduated lists a
   Telegram link — most communities live on X now, so X links count too.
   ========================================================================== */

export const LEAD = { minCap: 50_000, maxCap: 50_000_000, minAgeH: 2, maxAgeH: 30 * 24, activeMin: 30, max: 60 };

const TG = /^https:\/\/(t\.me|telegram\.me)\/[A-Za-z0-9_+\/-]{3,80}$/;
const XL = /^https:\/\/(x\.com|twitter\.com)\/[A-Za-z0-9_\/?=&.%-]{1,120}$/;
const WEB = /^https:\/\/[^\s"'<>]{4,200}$/;

/* http becomes https; a bare "t.me/x" gains the scheme; any other scheme (javascript:, data:) is nothing */
const normLink = s => {
  const v = String(s || '').trim().replace(/^http:\/\//i, 'https://');
  if (!v || /^https:\/\//i.test(v)) return v;
  return /^[a-z][a-z0-9+.-]*:/i.test(v) ? '' : 'https://' + v;
};
export const tgLink = s => { const v = normLink(s); return TG.test(v) ? v : ''; };
export const xLink = s => { const v = normLink(s); return XL.test(v) ? v : ''; };
export const webLink = s => { const v = normLink(s); return WEB.test(v) && !TG.test(v) && !XL.test(v) ? v : ''; };

export function leads(tokens, trackedMints, now = Date.now(), lim = LEAD) {
  const has = trackedMints instanceof Set ? trackedMints : new Set(trackedMints || []);
  const out = [];
  for (const t of tokens || []) {
    if (!t || !t.mint || !t.grad || t.banned || t.solid === false || has.has(t.mint)) continue;
    if (!(t.mcap >= lim.minCap && t.mcap <= lim.maxCap)) continue;
    const ageH = t.created ? (now - t.created) / 3.6e6 : null;
    if (ageH == null || ageH < lim.minAgeH || ageH > lim.maxAgeH) continue;
    if (!t.lastTrade || now - t.lastTrade > lim.activeMin * 60_000) continue;
    const telegram = tgLink(t.telegram), twitter = xLink(t.twitter);
    if (!telegram && !twitter) continue;
    out.push({
      mint: t.mint, sym: t.sym, name: t.name || '', img: t.img || '',
      mcap: t.mcap, vol: t.vol || 0, h24: t.pc && t.pc.h24 != null ? t.pc.h24 : null,
      ageH: Math.round(ageH * 10) / 10, telegram, twitter, website: webLink(t.website),
    });
  }
  out.sort((a, b) => (b.telegram ? 1 : 0) - (a.telegram ? 1 : 0) || (b.vol || 0) - (a.vol || 0) || b.mcap - a.mcap);
  return out.slice(0, lim.max);
}
