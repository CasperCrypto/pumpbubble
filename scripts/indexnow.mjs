/* Tell Bing (and Yandex, Seznam, Naver — every IndexNow engine shares the
   ping) which pages changed, so they are recrawled in minutes instead of
   days. Bing's index is what ChatGPT search and Copilot read.

   The key is public by design: IndexNow proves ownership by fetching
   https://pumpbubble.fun/<key>.txt, which is in public/.

     node scripts/indexnow.mjs              # every URL in the live sitemap
     node scripts/indexnow.mjs /kols /bot   # just these */
const HOST = 'pumpbubble.fun';
const KEY = '07027eb587da9a77da45e98f55c87359';
const args = process.argv.slice(2);
let urls = args.map(p => 'https://' + HOST + (p.startsWith('/') ? p : '/' + p));
if (!urls.length) {
  const xml = await (await fetch('https://' + HOST + '/sitemap.xml')).text();
  urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
}
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: 'https://' + HOST + '/' + KEY + '.txt', urlList: urls.slice(0, 10000) }),
});
console.log(res.status, res.statusText, '—', urls.length, 'URLs submitted');
if (res.status >= 400) console.log(await res.text());
