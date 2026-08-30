/* ==========================================================================
   pumpbubble.fun — SVG to PNG inside the Worker

   X, Telegram and Discord all refuse SVG in link previews, so a share card has
   to leave here as a raster image. There are no system fonts in a Worker, which
   is why the display face is compiled in as bytes: without it every string
   rasterises to nothing at all, silently, and the card still returns 200.

   The WASM module is ~2.4MB and is the only real dependency this project has.
   It is instantiated once per isolate, on the first card requested rather than
   at startup, so a visitor who never shares anything pays none of it.
   ========================================================================== */

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import FONT from './assets/archivo-black.ttf';

/* initWasm throws if called twice, and several requests can land on a cold
   isolate together, so the promise itself is the lock. */
let ready = null;
function boot() {
  if (!ready) {
    ready = initWasm(wasm).catch(e => { ready = null; throw e; });
  }
  return ready;
}

export async function svgToPng(svg, width) {
  await boot();
  const r = new Resvg(svg, {
    font: {
      fontBuffers: [new Uint8Array(FONT)],
      defaultFontFamily: 'Archivo Black',
      loadSystemFonts: false,
    },
    fitTo: { mode: 'width', value: width },
  });
  return r.render().asPng();
}
