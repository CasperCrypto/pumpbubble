/* The swap parser lives in public/js/solbuy.mjs so the wallet page can load
   the exact code the bot runs (it has no imports, so a browser can import it
   as it is). Everything server-side keeps importing it from here. */
export * from '../public/js/solbuy.mjs';
