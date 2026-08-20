# Why this is not React (and when it should be)

## What pump.fun uses

Next.js with React, measured rather than assumed — the served HTML carries ~1990 `_next/static`
references and `self.__next_f` App Router streaming markers.

That is the right choice **for them** and it does not follow that it is right here. pump.fun is a
content and trading site: thousands of DOM nodes, routing, forms, wallet adapters, live comment
threads, per-token pages. React exists to keep a large, frequently-changing DOM tree in sync with
state, and they have a large, frequently-changing DOM tree.

## What this app actually is

One `<canvas>` element and a 60fps physics loop, plus about thirty DOM nodes of chrome (chips, a
modal, the ad rail, a tooltip).

The expensive part — 100 bubbles × 64 vertices × up to 7 neighbours, every frame — is drawn with
imperative canvas calls. React cannot help with that. In a React version it would live inside a
`useEffect` escape hatch, untouched by the renderer, exactly as it is now. React would be managing
the thirty easy nodes and contributing nothing to the hard part.

What it would add: a build step, `node_modules`, ~45KB of framework before any of our code, and a
hydration pass on a page whose entire job is to start animating immediately.

Measured cost of the current approach: `step()` 0.42ms/frame, `draw()` ~19ms/frame in a software
renderer. If the frame budget becomes a problem, the fix is WebGL or OffscreenCanvas — not a
different way of managing DOM.

## The honest argument for React

**React escapes interpolated strings by default.** The stored XSS documented in
`docs/security.md` — token names going straight into `innerHTML` — would not have happened in JSX,
because you have to opt into `dangerouslySetInnerHTML` to get that behaviour. That is a real
advantage and it is worth stating plainly rather than arguing around.

It is also worth keeping in proportion:

- The bug is fixed, with three independent locks and a test that asserts the payload stays inert.
- React would not have prevented anything on the payment side. **No framework decides what counts
  as paid.** That is the server checking the chain, and it is written the same way regardless of
  what renders the page.
- Rewriting the front end is itself the most dangerous thing you can do to a working, audited
  payment flow.

## The change actually worth making

Not React — a **build step**, for one specific reason.

The CSP currently needs `script-src 'unsafe-inline'` because the whole front end is one
self-contained file. That is the weakest remaining link in the security model. Moving the script
into its own file lets the CSP drop `unsafe-inline`, which turns "escaping is our defence" into
"even a missed escape cannot execute".

If that is done, the same step makes TypeScript available, which would have caught real bugs from
this project's own history: a `return` inside `try` that let rejections escape as 500s, and a canvas
sized from a flex child before layout resolved, which rendered a 0×0 map.

Suggested order, cheapest first:

1. Extract the inline script to `app.js`, drop `unsafe-inline` from the CSP. No framework needed.
2. Add TypeScript with `checkJs` on the existing files — types without a rewrite.
3. Only if the site grows real pages (a boost leaderboard, per-token pages, SEO landing pages)
   reach for a framework, and then Astro or Next.js, because the reason will be routing and
   server-rendered HTML — not the bubbles.

## The rule

The canvas stays imperative whatever happens above it. If a framework is ever added, it manages
navigation and chrome; it does not own the render loop.
