/* ==========================================================================
   pumpbubble.fun — the AI market brief over Signals

   A short read of what the Signals table shows, written by Claude. It is off
   until the `ANTHROPIC_API_KEY` secret is set: without it the route answers
   `{ off: true }` and the page shows no brief at all — a templated paragraph
   labelled "AI" would be the invented-number rule broken in prose.

   The model is given the facts object from `briefFacts()` (src/signals.mjs)
   and nothing else: tickers, the signals each row raised in words, its
   market cap and moves. The instruction is to restate and connect those, to
   invent no figure and to give no advice. The page labels it as written by
   AI from the table under it, with its time.

   Raw fetch, no SDK: this project carries no dependencies (CLAUDE.md), the
   Worker bundle stays as it is, and the call is one POST.

   Cost is bounded by the cache, not by traffic: one brief per BRIEF_TTL, kept
   per isolate and in KV so every isolate reads the same one, and concurrent
   requests share the one in flight.
   ========================================================================== */

export const BRIEF_TTL = 15 * 60_000;
export const BRIEF_MODEL = 'claude-opus-5-5';
const API = 'https://api.anthropic.com/v1/messages';

export const SYSTEM = [
  'You write the market brief at the top of a crypto and stock screener\'s Signals table.',
  'You receive JSON: counts of signals by type, broad-market context, and the top rows, each with the signals it raised written out.',
  'Write 3 to 5 short sentences, under 110 words, plain text, no markdown, no lists, no emoji.',
  'Say what stands out: where the activity is (memecoins, Base, majors, stocks), which tickers lead and why, and whether the tape leans up or down.',
  'Use only numbers and tickers that appear in the JSON, written as they appear. Never estimate, project or invent a figure.',
  'Do not give advice or tell anyone to buy or sell; describe, do not recommend. Do not call anything a scam.',
  'Write tickers with a leading $.',
].join(' ');

const mem = { at: 0, text: '', model: '', inflight: null, err: '', errAt: 0 };

export function briefOn(env) { return !!(env && typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 20); }

/* One request to the Messages API → plain text, or throws. */
export async function writeBrief(facts, env, { http = fetch, ms = 45_000 } = {}) {
  const model = (env && /^claude-[a-z0-9.-]{3,40}$/.test(env.AI_MODEL || '')) ? env.AI_MODEL : BRIEF_MODEL;
  const r = await http(API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      /* a safety decline re-runs on a fallback model inside the same call */
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      /* a short summary of given facts: low effort is plenty */
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    }),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) {
    let msg = '';
    try { const j = await r.json(); msg = (j && j.error && j.error.message) || ''; } catch { /* no body */ }
    throw new Error('anthropic ' + r.status + (msg ? ': ' + String(msg).slice(0, 100) : ''));
  }
  const j = await r.json();
  if (j.stop_reason === 'refusal') throw new Error('declined');
  const text = (j.content || []).filter(b => b && b.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('empty brief');
  return { text: text.slice(0, 900), model: String(j.model || model) };
}

/* The cached brief, writing a new one when it has expired. `facts` is a
   thunk so nothing is computed while a fresh copy exists. `store` is the KV
   wrapper (get/put JSON); failures to read or write it cost only a rewrite. */
export async function getBrief({ env, store, facts, now = Date.now(), http } = {}) {
  if (!briefOn(env)) return { off: true };
  if (mem.text && now - mem.at < BRIEF_TTL) return { text: mem.text, at: mem.at, model: mem.model };
  if (store) {
    try {
      const saved = await store.get('ai:brief');
      if (saved && saved.text && now - saved.at < BRIEF_TTL) {
        Object.assign(mem, { at: saved.at, text: saved.text, model: saved.model || '' });
        return { text: mem.text, at: mem.at, model: mem.model };
      }
    } catch { /* a miss */ }
  }
  /* a failure is not retried for two minutes; the last brief stands meanwhile */
  if (mem.err && now - mem.errAt < 120_000) return mem.text ? { text: mem.text, at: mem.at, model: mem.model, stale: true } : { error: mem.err };
  if (!mem.inflight) {
    mem.inflight = (async () => {
      try {
        const f = await facts();
        if (!f || !f.top || !f.top.length) throw new Error('no signals to summarise');
        const b = await writeBrief(f, env, { http });
        Object.assign(mem, { at: Date.now(), text: b.text, model: b.model, err: '' });
        if (store) { try { await store.put('ai:brief', { at: mem.at, text: mem.text, model: mem.model }); } catch { /* next time */ } }
      } catch (e) {
        mem.err = String((e && e.message) || e).slice(0, 140); mem.errAt = Date.now();
      } finally { mem.inflight = null; }
    })();
  }
  await mem.inflight;
  if (mem.text) return { text: mem.text, at: mem.at, model: mem.model, stale: now - mem.at >= BRIEF_TTL || undefined };
  return { error: mem.err || 'no brief' };
}

export function _resetBrief() { Object.assign(mem, { at: 0, text: '', model: '', inflight: null, err: '', errAt: 0 }); }
