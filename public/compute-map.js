/* pumpbubble.fun — the Compute tab's map view. Loaded the first time the
   tab's Map switch is pressed; the data comes from /api/compute/map
   (src/computemap.mjs), the outlines from /world-110m.json (Natural Earth).

   No library: Equal Earth projection by its published formula, one canvas,
   zoom with the wheel, a pinch, a double click or the + and − buttons, drag
   to move. Countries are coloured by what power costs there, in US dollars
   per kWh — industrial where published, wholesale (striped) where only that
   is open, grey where nothing is. The panel says what a place is: its power,
   how clean its grid is, and the compute in it.

   Every string from the data is a stranger's (an Akash provider names
   itself), so everything written into the page goes through esc(). */
(function () {
  'use strict';
  if (window.ComputeMap) return;

  var CSS = [
    '.cmw{position:absolute;inset:0;font:13px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8edf5;user-select:none}',
    '.cmw canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}',
    '.cmw canvas.drag{cursor:grabbing}',
    '.cm-top{position:absolute;left:10px;top:10px;right:10px;display:flex;flex-wrap:wrap;gap:6px;pointer-events:none}',
    '.cm-top .grp{display:flex;flex-wrap:wrap;gap:5px;pointer-events:auto}',
    '.cm-top button,.cm-zoom button{font:700 12px/1 inherit;color:#9aa4b6;background:rgba(10,14,22,.82);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:7px 11px;cursor:pointer;backdrop-filter:blur(6px)}',
    '.cm-top button.on{color:#fff;border-color:rgba(255,255,255,.32);background:rgba(30,38,54,.92)}',
    '.cm-top i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:0}',
    '.cm-zoom{position:absolute;right:344px;bottom:14px;display:flex;flex-direction:column;gap:6px}',
    '.cm-zoom button{width:34px;height:34px;padding:0;border-radius:10px;font-size:17px;color:#e8edf5}',
    '.cm-legend{position:absolute;left:12px;bottom:12px;padding:8px 10px;border-radius:12px;background:rgba(10,14,22,.82);border:1px solid rgba(255,255,255,.1);font-size:11.5px;color:#9aa4b6;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;max-width:calc(100% - 410px)}',
    '.cm-legend .bar{display:inline-block;width:110px;height:8px;border-radius:4px;background:linear-gradient(90deg,#1f9d6a,#c9b23a 50%,#d9573f);vertical-align:0;margin:0 6px}',
    '.cm-legend .sw{display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:5px}',
    '.cm-tip{position:absolute;pointer-events:none;max-width:250px;padding:8px 10px;border-radius:10px;background:rgba(8,11,18,.95);border:1px solid rgba(255,255,255,.16);font-size:12px;box-shadow:0 8px 28px rgba(0,0,0,.5)}',
    '.cm-tip b{font-size:13px}.cm-d{color:#8a93a6}',
    '.cm-panel{position:absolute;top:56px;right:12px;bottom:60px;width:320px;overflow:auto;padding:14px 14px 12px;border-radius:16px;background:rgba(8,11,18,.9);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(8px);user-select:text;-webkit-overflow-scrolling:touch}',
    '.cm-panel h3{margin:0 0 2px;font-size:16px;font-weight:900;letter-spacing:-.01em}',
    '.cm-panel h4{margin:14px 0 6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#8a93a6;font-weight:800}',
    '.cm-big{font-size:26px;font-weight:900;letter-spacing:-.02em;margin:6px 0 0}.cm-big small{font-size:13px;font-weight:700;color:#8a93a6}',
    '.cm-kind{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.08);color:#c9d1de;margin-top:4px}',
    '.cm-kind.w{background:rgba(201,178,58,.16);color:#e4cf6a}',
    '.cm-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:10px 0 2px}.cm-stats div{padding:8px;border-radius:10px;background:rgba(255,255,255,.04)}.cm-stats b{display:block;font-size:16px;font-weight:900}.cm-stats span{font-size:10.5px;color:#8a93a6}',
    '.cm-rows{display:flex;flex-direction:column}.cm-row{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px;cursor:pointer}.cm-row:hover{background:rgba(255,255,255,.05)}',
    '.cm-row .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cm-row .v{font-weight:800;font-variant-numeric:tabular-nums}.cm-row .s{color:#8a93a6;font-size:11.5px;font-variant-numeric:tabular-nums}',
    '.cm-row .r{width:16px;color:#5d6678;font-size:11px}',
    '.cm-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex:none}',
    '.cm-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin-top:8px;font-size:12.5px}.cm-kv span{color:#8a93a6}.cm-kv b{font-weight:700;text-align:right;font-variant-numeric:tabular-nums}',
    '.cm-back{font:700 12px/1 inherit;color:#8a93a6;background:none;border:0;padding:0 0 8px;cursor:pointer}.cm-back:hover{color:#e8edf5}',
    '.cm-src{margin-top:16px;font-size:10.5px;line-height:1.5;color:#5d6678}',
    '.cm-grab{display:none}',
    '.cm-load{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#8a93a6;font-size:13px}',
    '@media (max-width:760px){',
    '.cm-top{left:8px;right:52px;top:8px;flex-direction:column;gap:5px}.cm-top .grp{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.cm-top .grp::-webkit-scrollbar{display:none}.cm-top button{padding:6px 9px;font-size:11.5px;white-space:nowrap;flex:none}',
    '.cm-legend{display:none}',
    '.cm-zoom{right:8px;bottom:auto;top:8px}',
    '.cm-panel{top:auto;left:0;right:0;bottom:0;width:auto;max-height:46%;border-radius:16px 16px 0 0;padding:6px 14px 14px}',
    '.cm-panel.min{max-height:56px;overflow:hidden}',
    '.cm-grab{display:block;width:40px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:2px auto 8px;cursor:pointer}',
    '}',
  ].join('\n');

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var $kwh = function (v) { return v == null ? '—' : '$' + (+v).toFixed(3); };
  var $h = function (v) { return v == null ? '—' : '$' + (+v).toFixed(2); };
  var fmtGw = function (gw) { return gw ? (gw >= 1 ? gw + ' GW' : Math.round(gw * 1000) + ' MW') : '—'; };

  /* ---------------------------------------------------------- projection */
  var A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2, R = Math.PI / 180;
  function ee(lon, lat) {
    var t = Math.asin(M * Math.sin(lat * R)), t2 = t * t, t6 = t2 * t2 * t2;
    return [lon * R * Math.cos(t) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))), t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))];
  }
  var WORLD = [-180, -57, 180, 83];
  var VIEWS = { world: WORLD, na: [-128, 14, -62, 57], eu: [-12, 35, 34, 71], asia: [64, -12, 152, 50] };

  /* ------------------------------------------------------------- state */
  var box, root, cv, g, tip, panel, dpr = 1, W = 0, H = 0;
  var B = { s: 1, ox: 0, oy: 0 };          // base: the world fitted to the box
  var V = { z: 1, px: 0, py: 0 };          // view: zoom and pan over the base
  var D = null, world = null, built = false, loadedAt = 0, on = { sites: true, metros: true, projects: true, power: true };
  var shapes = [], dots = [], NAME = { SG: 'Singapore', HK: 'Hong Kong', BH: 'Bahrain', MT: 'Malta', LU: 'Luxembourg', LI: 'Liechtenstein', XK: 'Kosovo', US: 'United States' };
  var focusGpu = null, selected = null, raf = 0, stripe = null;

  function base(lon, lat) { var p = ee(lon, lat); return [B.ox + p[0] * B.s, B.oy - p[1] * B.s]; }
  function scr(b) { return [b[0] * V.z + V.px, b[1] * V.z + V.py]; }

  function fitBase() {
    var x0 = 1 / 0, x1 = -1 / 0, y0 = 1 / 0, y1 = -1 / 0;
    for (var i = 0; i <= 16; i++) for (var j = 0; j <= 16; j++) {
      var p = ee(WORLD[0] + (WORLD[2] - WORLD[0]) * i / 16, WORLD[1] + (WORLD[3] - WORLD[1]) * j / 16);
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    var s = Math.min((W - 20) / (x1 - x0), (H - 20) / (y1 - y0));
    B = { s: s, ox: W / 2 - s * (x0 + x1) / 2, oy: H / 2 + s * (y0 + y1) / 2 };
  }
  /* the part of the box the map can use: left of the panel on a desktop,
     above the folded sheet and below the chips on a phone */
  function area() {
    return W > 760 ? { x: 0, y: 48, w: W - 344, h: H - 96 } : { x: 0, y: 84, w: W, h: H - 84 - 60 };
  }
  /* the zoom and pan that frame a lon/lat box */
  function frame(b) {
    var x0 = 1 / 0, x1 = -1 / 0, y0 = 1 / 0, y1 = -1 / 0;
    for (var i = 0; i <= 8; i++) for (var j = 0; j <= 8; j++) {
      var p = base(b[0] + (b[2] - b[0]) * i / 8, b[1] + (b[3] - b[1]) * j / 8);
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    var a = area(), z = Math.max(1, Math.min(24, Math.min(a.w / (x1 - x0), a.h / (y1 - y0))));
    return { z: z, px: a.x + a.w / 2 - (x0 + x1) / 2 * z, py: a.y + a.h / 2 - (y0 + y1) / 2 * z };
  }
  function clampView(v) {
    var z = Math.max(1, Math.min(40, v.z)), m = 60;
    return { z: z, px: Math.min(m, Math.max(W - W * z - m, v.px)), py: Math.min(m, Math.max(H - H * z - m, v.py)) };
  }
  function centreOn(b, z) { var a = area(); return { z: z, px: a.x + a.w / 2 - b[0] * z, py: a.y + a.h / 2 - b[1] * z }; }
  function zoomAt(x, y, z) {
    var nz = Math.max(1, Math.min(40, z)), k = nz / V.z;
    V = clampView({ z: nz, px: x - (x - V.px) * k, py: y - (y - V.py) * k });
    redraw();
  }
  function flyTo(to, ms) {
    var from = { z: V.z, px: V.px, py: V.py }, t0 = performance.now(), d = ms || 450;
    to = clampView(to);
    (function step(now) {
      var t = Math.min(1, (now - t0) / d), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      V = { z: from.z + (to.z - from.z) * e, px: from.px + (to.px - from.px) * e, py: from.py + (to.py - from.py) * e };
      draw();
      if (t < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ------------------------------------------------------------- power */
  function powerOf(cc, st) {
    if (!D) return null;
    if (cc === 'US' && st && D.states[st] != null) return { usd: D.states[st], kind: 'industrial', label: (D.stateNames[st] || st) + ' (state)' };
    var c = D.countries[cc];
    if (!c) return null;
    if (c.ind != null) return { usd: c.ind, kind: 'industrial', period: c.indP };
    if (c.whl != null) return { usd: c.whl, kind: 'wholesale', period: c.whlP, market: c.whlM };
    return null;
  }
  function heatRgb(usd) {
    var t = Math.max(0, Math.min(1, (usd - 0.05) / 0.15)), lo = [31, 157, 106], mid = [201, 178, 58], hi = [217, 87, 63];
    var a = t < 0.5 ? lo : mid, b = t < 0.5 ? mid : hi, u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * u); });
  }
  var rgba = function (c, a) { return 'rgba(' + c.join(',') + ',' + a + ')'; };

  /* ------------------------------------------------------------ building */
  function build() {
    shapes = [];
    if (!world) return;
    for (var i = 0; i < world.countries.length; i++) {
      var c = world.countries[i], p = new Path2D(), best = null, bestA = 0;
      if (c.a2 && !NAME[c.a2]) NAME[c.a2] = c.n;
      for (var k = 0; k < c.r.length; k++) {
        var r = c.r[k], area = 0, cx = 0, cy = 0, pts = [];
        for (var n = 0; n < r.length; n += 2) pts.push(base(r[n] / 10, Math.max(-89, Math.min(89, r[n + 1] / 10))));
        for (var q = 0; q < pts.length; q++) {
          if (q) p.lineTo(pts[q][0], pts[q][1]); else p.moveTo(pts[q][0], pts[q][1]);
          var a = pts[q], b = pts[(q + 1) % pts.length], f = a[0] * b[1] - b[0] * a[1];
          area += f; cx += (a[0] + b[0]) * f; cy += (a[1] + b[1]) * f;
        }
        p.closePath();
        if (Math.abs(area) > bestA && area) { bestA = Math.abs(area); best = [cx / (3 * area), cy / (3 * area), Math.sqrt(Math.abs(area) / 2)]; }
      }
      shapes.push({ c: c, p: p, label: best });
    }
    built = true;
  }
  function makeStripe() {
    var c = document.createElement('canvas'); c.width = c.height = 8;
    var x = c.getContext('2d');
    x.strokeStyle = 'rgba(5,7,12,0.55)'; x.lineWidth = 2.2;
    x.beginPath(); x.moveTo(-2, 10); x.lineTo(10, -2); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
    return g.createPattern(c, 'repeat');
  }

  /* ------------------------------------------------------------- drawing */
  function redraw() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; draw(); }); }
  function draw() {
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!D) return;
    g.setTransform(dpr * V.z, 0, 0, dpr * V.z, dpr * V.px, dpr * V.py);
    if (stripe && stripe.setTransform) stripe.setTransform(new DOMMatrix().scale(1 / V.z));
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i], pw = on.power ? powerOf(s.c.a2) : null;
      g.fillStyle = pw ? rgba(heatRgb(pw.usd), selected && selected.cc === s.c.a2 ? 0.85 : 0.6) : '#111722';
      g.fill(s.p);
      if (pw && pw.kind === 'wholesale' && stripe) { g.fillStyle = stripe; g.fill(s.p); }
      g.lineWidth = (selected && selected.cc === s.c.a2 ? 1.6 : 0.6) / V.z;
      g.strokeStyle = selected && selected.cc === s.c.a2 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.08)';
      g.stroke(s.p);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* prices on the countries, once they are big enough to carry one */
    if (on.power && V.z >= 2.2) {
      g.font = '700 11px ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (var j = 0; j < shapes.length; j++) {
        var sh = shapes[j], pl = sh.label, pw2 = powerOf(sh.c.a2);
        if (!pl || !pw2 || pl[2] * V.z < 26) continue;
        var q = scr(pl);
        if (q[0] < -40 || q[0] > W + 40 || q[1] < -20 || q[1] > H + 20) continue;
        var txt = '$' + pw2.usd.toFixed(3);
        g.lineWidth = 3; g.strokeStyle = 'rgba(5,7,12,0.85)'; g.strokeText(txt, q[0], q[1]);
        g.fillStyle = '#fff'; g.fillText(txt, q[0], q[1]);
      }
    }
    dots = [];
    var grow = 1 + Math.log2(V.z) * 0.18, k = Math.max(0.55, Math.min(1, W / 1000)) * grow, d, p;
    if (on.metros) for (d = 0; d < D.metros.length; d++) {
      var m = D.metros[d]; p = scr(base(m.lon, m.lat));
      var rm = (2.2 + Math.min(4, m.regions.length) * 0.6) * k;
      g.beginPath(); g.arc(p[0], p[1], rm, 0, 7); g.fillStyle = 'rgba(159,183,255,0.9)'; g.fill();
      g.lineWidth = 1; g.strokeStyle = 'rgba(5,7,12,0.9)'; g.stroke();
      dots.push({ x: p[0], y: p[1], r: rm, kind: 'metro', d: m });
    }
    if (on.sites) for (d = 0; d < D.sites.length; d++) {
      var s2 = D.sites[d]; p = scr(base(s2.lon, s2.lat));
      var hit = !focusGpu || s2.models.some(function (x) { return focusGpu.akash.indexOf(x) >= 0; });
      var rs = (s2.gpus > 0 ? 3 + Math.sqrt(s2.gpus) * 1.25 : 2) * k;
      g.save();
      if (s2.gpus > 0 && hit) { g.shadowColor = 'rgba(61,240,155,0.65)'; g.shadowBlur = 10 * k; }
      g.beginPath(); g.arc(p[0], p[1], rs, 0, 7);
      g.fillStyle = !hit ? 'rgba(61,240,155,0.12)' : s2.gpus > 0 ? 'rgba(61,240,155,0.9)' : 'rgba(61,240,155,0.32)'; g.fill();
      g.restore();
      dots.push({ x: p[0], y: p[1], r: rs, kind: 'site', d: s2 });
    }
    if (on.projects) for (d = 0; d < D.projects.length; d++) {
      var j2 = D.projects[d]; p = scr(base(j2.lon, j2.lat));
      var rp = (j2.gw ? 5 + Math.sqrt(j2.gw) * 4.5 : 6) * k;
      g.beginPath(); g.arc(p[0], p[1], rp, 0, 7); g.fillStyle = 'rgba(245,197,66,0.15)'; g.fill();
      g.lineWidth = Math.max(1.3, 2 * k); g.strokeStyle = '#f5c542'; g.stroke();
      g.beginPath(); g.arc(p[0], p[1], 2 * k, 0, 7); g.fillStyle = '#f5c542'; g.fill();
      dots.push({ x: p[0], y: p[1], r: rp, kind: 'project', d: j2 });
    }
    if (selected && selected.x != null) {
      p = scr(base(selected.lon, selected.lat));
      g.beginPath(); g.arc(p[0], p[1], 14, 0, 7); g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.stroke();
    }
  }

  /* ------------------------------------------------------------ hit test */
  function hitAt(x, y) {
    var best = null, bd = 1 / 0;
    for (var i = dots.length - 1; i >= 0; i--) {
      var o = dots[i], dd = Math.hypot(o.x - x, o.y - y);
      if (dd <= Math.max(o.r, 6) + 5 && dd < bd) { best = o; bd = dd; }
    }
    if (best) return best;
    g.setTransform(dpr * V.z, 0, 0, dpr * V.z, dpr * V.px, dpr * V.py);
    for (var k = 0; k < shapes.length; k++) {
      if (g.isPointInPath(shapes[k].p, x * dpr, y * dpr)) { g.setTransform(dpr, 0, 0, dpr, 0, 0); return { kind: 'country', d: shapes[k].c }; }
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return null;
  }

  /* -------------------------------------------------------------- words */
  function placeName(cc, st) { return cc === 'US' && st ? (D.stateNames[st] || st) + ', US' : (NAME[cc] || cc || '—'); }
  function powerLine(pw) {
    if (!pw) return '<span class="cm-d">no open price</span>';
    return '<b>' + $kwh(pw.usd) + '</b>/kWh <span class="cm-d">' + (pw.kind === 'wholesale' ? 'wholesale' : 'industrial') + '</span>';
  }
  function tipHtml(h) {
    var d = h.d;
    if (h.kind === 'site') return '<b>' + esc(d.host || 'Akash provider') + '</b><br><span class="cm-d">' + esc([d.region, d.country].filter(Boolean).join(', ')) + '</span><br>' + d.gpus + ' GPUs' + (d.gpus ? ' · ' + d.free + ' free' : '') + (d.models.length ? ' · ' + esc(d.models.join(', ')) : '') + '<br>Power ' + powerLine(powerOf(d.cc, d.st));
    if (h.kind === 'metro') return '<b>' + esc(d.city) + '</b><br><span class="cm-d">' + d.regions.length + ' cloud region' + (d.regions.length > 1 ? 's' : '') + '</span><br>Power ' + powerLine(powerOf(d.cc, d.st));
    if (h.kind === 'project') return '<b>' + esc(d.name) + '</b> <span class="cm-d">' + esc(d.who) + '</span><br>' + esc(d.city) + ' · ' + fmtGw(d.gw) + '<br>Power ' + powerLine(powerOf(d.cc, d.st));
    return '<b>' + esc(NAME[d.a2] || d.n) + '</b><br>Power ' + powerLine(powerOf(d.a2));
  }

  function countryBlock(cc, st) {
    var c = D.countries[cc] || {}, pw = powerOf(cc, st), out = '';
    if (pw) {
      out += '<div class="cm-big">' + $kwh(pw.usd) + ' <small>per kWh</small></div>'
        + '<span class="cm-kind' + (pw.kind === 'wholesale' ? ' w' : '') + '">' + (pw.kind === 'wholesale' ? 'Wholesale · ' + esc(pw.period || '') : 'Industrial · ' + esc(pw.period || (cc === 'US' ? D.asOf.us : ''))) + '</span>'
        + '<div class="cm-kv"><span>One H100 at full power</span><b>' + $h(D.h100 * pw.usd) + ' / hour</b>'
        + '<span>A 100 MW campus, a year</span><b>$' + Math.round(pw.usd * 100000 * 8760 / 1e6) + 'M</b></div>';
    } else out += '<div class="cm-big" style="font-size:16px;color:#8a93a6">No open power price</div>';
    if (pw && pw.kind === 'wholesale') out += '<p class="cm-d" style="margin:8px 0 0;font-size:11.5px">Wholesale is what power trades for before networks, taxes and retail — what a data center pays is higher.</p>';
    if (c.co2 != null || c.lowc != null) {
      out += '<h4>Grid</h4><div class="cm-kv">' + (c.co2 != null ? '<span>Carbon intensity</span><b>' + c.co2 + ' g CO₂/kWh</b>' : '') + (c.lowc != null ? '<span>Low-carbon power</span><b>' + c.lowc + '%</b>' : '') + '<span>Year</span><b>' + esc(c.gy || '') + '</b></div>';
    }
    return out;
  }
  function computeHere(cc) {
    var sites = D.sites.filter(function (s) { return s.cc === cc && s.gpus > 0; }), metros = D.metros.filter(function (m) { return m.cc === cc; }), proj = D.projects.filter(function (p) { return p.cc === cc; });
    if (!sites.length && !metros.length && !proj.length) return '';
    var gpus = sites.reduce(function (n, s) { return n + s.gpus; }, 0), free = sites.reduce(function (n, s) { return n + s.free; }, 0);
    var out = '<h4>Compute here</h4><div class="cm-kv">';
    if (sites.length) out += '<span>Akash GPUs</span><b>' + gpus + ' · ' + free + ' free</b>';
    if (metros.length) out += '<span>Cloud regions</span><b>' + metros.reduce(function (n, m) { return n + m.regions.length; }, 0) + ' in ' + metros.length + ' cit' + (metros.length > 1 ? 'ies' : 'y') + '</b>';
    if (proj.length) out += '<span>AI megaprojects</span><b>' + proj.length + '</b>';
    out += '</div><div class="cm-rows" style="margin-top:6px">';
    proj.forEach(function (p, i) { out += row('p' + i, '<span class="cm-dot" style="background:#f5c542"></span>', esc(p.name), fmtGw(p.gw), esc(p.city.split(',')[0])); });
    sites.slice(0, 5).forEach(function (s) { out += row('s' + D.sites.indexOf(s), '<span class="cm-dot" style="background:#3df09b"></span>', esc(s.host || 'Akash provider'), s.gpus + ' GPUs', esc(s.models.slice(0, 2).join(', '))); });
    return out + '</div>';
  }
  function row(key, icon, name, val, sub) {
    return '<div class="cm-row" data-k="' + esc(key) + '">' + icon + '<span class="n">' + name + (sub ? ' <span class="s">' + sub + '</span>' : '') + '</span><span class="v">' + val + '</span></div>';
  }

  /* ---------------------------------------------------------------- panel */
  /* industrial prices only: a wholesale price is a different thing and
     would top the list for being incomplete, not for being cheap */
  function cheapestPlaces() {
    var list = [];
    Object.keys(D.countries).forEach(function (cc) {
      var pw = powerOf(cc);
      if (pw && pw.kind === 'industrial' && (NAME[cc] || cc === 'US')) list.push({ cc: cc, usd: pw.usd, kind: pw.kind });
    });
    var states = {};
    D.metros.concat(D.projects, D.sites).forEach(function (x) { if (x.cc === 'US' && x.st && D.states[x.st] != null) states[x.st] = 1; });
    Object.keys(states).forEach(function (st) { list.push({ cc: 'US', st: st, usd: D.states[st], kind: 'industrial' }); });
    return list.sort(function (a, b) { return a.usd - b.usd; });
  }
  function home() {
    selected = null; focusGpu = null;
    var gpus = D.sites.reduce(function (n, s) { return n + s.gpus; }, 0), free = D.sites.reduce(function (n, s) { return n + s.free; }, 0);
    var regions = D.metros.reduce(function (n, m) { return n + m.regions.length; }, 0), gw = D.projects.reduce(function (n, p) { return n + (p.gw || 0); }, 0);
    var places = cheapestPlaces(), html = '<span class="cm-grab"></span><h3>Where compute runs, and what power costs</h3>'
      + '<div class="cm-stats"><div><b>' + (gpus || '—') + '</b><span>Akash GPUs · ' + free + ' free</span></div><div><b>' + regions + '</b><span>cloud regions</span></div><div><b>' + (gw ? gw.toFixed(1) + ' GW' : '—') + '</b><span>AI megaprojects</span></div></div>'
      + '<h4>Cheapest industrial power · an H100-hour</h4><div class="cm-rows">';
    places.slice(0, 8).forEach(function (p, i) {
      html += row('c' + (p.st ? 'US-' + p.st : p.cc), '<span class="r">' + (i + 1) + '</span>', esc(placeName(p.cc, p.st)), $kwh(p.usd), $h(D.h100 * p.usd) + '/h');
    });
    html += '</div>';
    var whl = Object.keys(D.countries).filter(function (cc) { var pw = powerOf(cc); return pw && pw.kind === 'wholesale'; })
      .sort(function (a, b) { return D.countries[a].whl - D.countries[b].whl; });
    if (whl.length) html += '<p class="cm-d" style="font-size:11.5px;margin:6px 6px 0">Wholesale only (striped): ' + whl.map(function (cc) { return '<a href="#" data-k="c' + esc(cc) + '" style="color:#c9d1de">' + esc(NAME[cc] || cc) + '</a>'; }).join(' · ') + '</p>';
    if (D.gpus.length) {
      html += '<h4>Cheapest GPU-hour on Akash</h4><div class="cm-rows">';
      D.gpus.forEach(function (gp) { html += row('g' + gp.id, '<span class="cm-dot" style="background:#3df09b"></span>', esc(gp.model), $h(gp.from != null ? gp.from : gp.usd), gp.power ? '+ ' + $h(gp.power.usd) + ' power' : ''); });
      html += '</div>';
    }
    html += '<h4>AI megaprojects</h4><div class="cm-rows">';
    D.projects.slice().sort(function (a, b) { return (b.gw || 0) - (a.gw || 0); }).forEach(function (p) { html += row('p' + D.projects.indexOf(p), '<span class="cm-dot" style="background:#f5c542"></span>', esc(p.name), fmtGw(p.gw), esc(p.city.split(',')[0])); });
    html += '</div><p class="cm-src">Sources: Akash Network (live) · Eurostat · U.S. EIA · ECB · Global Day-Ahead Electricity Price Dataset (Zenodo, CC BY 4.0) · Ember via Our World in Data (CC BY 4.0) · AWS, Google Cloud and Azure region lists · company announcements · Natural Earth.</p>';
    panel.innerHTML = html;
    draw();
  }
  function showCountry(cc, st) {
    selected = { cc: cc };
    var html = '<span class="cm-grab"></span><button class="cm-back" data-k="home">← All places</button><h3>' + esc(placeName(cc, st)) + '</h3>' + countryBlock(cc, st);
    if (cc === 'US') {
      var ss = Object.keys(D.states).map(function (s) { return { st: s, usd: D.states[s] }; }).sort(function (a, b) { return a.usd - b.usd; });
      html += '<h4>Cheapest states</h4><div class="cm-rows">';
      ss.slice(0, 8).forEach(function (s, i) { html += row('cUS-' + s.st, '<span class="r">' + (i + 1) + '</span>', esc(D.stateNames[s.st] || s.st), $kwh(s.usd), $h(D.h100 * s.usd) + '/h'); });
      html += '</div>';
    }
    html += computeHere(cc);
    panel.innerHTML = html; panel.classList.remove('min');
    draw();
  }
  function showDot(h) {
    var d = h.d, html = '<span class="cm-grab"></span><button class="cm-back" data-k="home">← All places</button>';
    selected = { cc: d.cc, x: 1, lon: d.lon, lat: d.lat };
    if (h.kind === 'site') {
      html += '<h3>' + esc(d.host || 'Akash provider') + '</h3><div class="cm-d">' + esc([d.region, d.country].filter(Boolean).join(', ')) + ' · Akash provider</div>'
        + '<div class="cm-kv"><span>GPUs</span><b>' + d.gpus + ' · ' + d.free + ' free</b>' + (d.models.length ? '<span>Models</span><b>' + esc(d.models.join(', ')) + '</b>' : '')
        + (d.up7d != null ? '<span>Uptime, 7 days</span><b>' + esc(d.up7d) + '%</b>' : '') + (d.audited ? '<span>Audited</span><b>yes</b>' : '') + '</div>'
        + '<p class="cm-d" style="font-size:11.5px;margin:8px 0 0">Position is Akash’s IP geolocation of the provider: a city, not a building.</p>';
    } else if (h.kind === 'metro') {
      html += '<h3>' + esc(d.city) + '</h3><div class="cm-d">Cloud regions</div><div class="cm-rows" style="margin-top:6px">'
        + d.regions.map(function (r) { return '<div class="cm-row" style="cursor:default"><span class="cm-dot" style="background:#9fb7ff"></span><span class="n">' + esc(r) + '</span></div>'; }).join('') + '</div>';
    } else {
      html += '<h3>' + esc(d.name) + '</h3><div class="cm-d">' + esc(d.who) + ' · ' + esc(d.city) + '</div>'
        + '<div class="cm-kv"><span>Stated target</span><b>' + fmtGw(d.gw) + '</b></div><p style="margin:8px 0 0;font-size:12.5px">' + esc(d.now) + '</p>'
        + (/^https:\/\//.test(d.src || '') ? '<p style="margin:6px 0 0;font-size:12px"><a href="' + esc(d.src) + '" target="_blank" rel="noopener nofollow" style="color:#3df09b">Source ↗</a></p>' : '');
    }
    html += '<h4>Power here · ' + esc(placeName(d.cc, d.st)) + '</h4>' + countryBlock(d.cc, d.st);
    panel.innerHTML = html; panel.classList.remove('min');
    draw();
  }
  function showGpu(id) {
    var gp = D.gpus.filter(function (x) { return x.id === id; })[0];
    if (!gp) return;
    var AK = { h100: ['h100'], h200: ['h200'], a100: ['a100'], b200: ['b200'], b300: ['b300'], rtx4090: ['rtx4090'], rtx5090: ['rtx5090'], pro6000: ['pro6000se', 'pro6000we'] };
    focusGpu = { id: id, akash: AK[id] || [id] };
    selected = null;
    var html = '<span class="cm-grab"></span><button class="cm-back" data-k="home">← All places</button><h3>' + esc(gp.model) + '</h3>'
      + '<div class="cm-big">' + $h(gp.from != null ? gp.from : gp.usd) + ' <small>per GPU-hour on Akash</small></div>'
      + '<div class="cm-kv"><span>Typical posted price</span><b>' + $h(gp.usd) + '</b>' + (gp.listed ? '<span>Free / listed</span><b>' + esc(gp.free) + ' / ' + esc(gp.listed) + '</b>' : '')
      + (gp.power ? '<span>Its power, cheapest place</span><b>' + $h(gp.power.usd) + '/h · ' + esc(placeName(gp.power.cc, gp.power.st)) + '</b>' : '') + '</div>'
      + '<h4>Offered in</h4><div class="cm-rows">';
    gp.ccs.forEach(function (cc) { html += row('c' + cc, '', esc(NAME[cc] || cc), powerOf(cc) ? $kwh(powerOf(cc).usd) : '—', ''); });
    html += '</div><p class="cm-d" style="font-size:11.5px">Providers offering it are lit on the map; the rest are dimmed. Posted prices, not trades.</p>';
    panel.innerHTML = html; panel.classList.remove('min');
    draw();
  }
  function onPanel(e) {
    var t = e.target.closest('[data-k],.cm-grab');
    if (!t) return;
    e.preventDefault();
    if (t.classList.contains('cm-grab')) { panel.classList.toggle('min'); return; }
    var k = t.getAttribute('data-k');
    if (k === 'home') return home();
    if (k[0] === 'c') {
      var m = /^cUS-([A-Z]{2})$/.exec(k);
      if (m) return showCountry('US', m[1]);
      var cc = k.slice(1), sh = shapes.filter(function (s) { return s.c.a2 === cc; })[0];
      showCountry(cc);
      if (sh && sh.label) flyTo(centreOn(sh.label, Math.max(2.4, Math.min(8, 90 / sh.label[2]))));
      return;
    }
    if (k[0] === 'g') return showGpu(k.slice(1));
    var list = k[0] === 'p' ? D.projects : k[0] === 's' ? D.sites : null, d = list && list[+k.slice(1)];
    if (!d) return;
    showDot({ kind: k[0] === 'p' ? 'project' : 'site', d: d });
    flyTo(centreOn(base(d.lon, d.lat), Math.max(V.z, 5)));
  }

  /* ------------------------------------------------------------- pointers */
  var ptrs = {}, drag = null, pinch = null;
  function local(e) { var r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function bindPointers() {
    cv.addEventListener('pointerdown', function (e) {
      cv.setPointerCapture(e.pointerId);
      ptrs[e.pointerId] = local(e);
      var ids = Object.keys(ptrs);
      if (ids.length === 2) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: V.z, px: V.px, py: V.py, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
        drag = null;
      } else if (ids.length === 1) {
        drag = { x: ptrs[ids[0]][0], y: ptrs[ids[0]][1], px: V.px, py: V.py, moved: false };
      }
    });
    cv.addEventListener('pointermove', function (e) {
      var p = local(e);
      if (ptrs[e.pointerId]) ptrs[e.pointerId] = p;
      var ids = Object.keys(ptrs);
      if (pinch && ids.length === 2) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        var nz = Math.max(1, Math.min(40, pinch.z * d / Math.max(1, pinch.d))), k = nz / pinch.z;
        var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        V = clampView({ z: nz, px: mx - (pinch.mx - pinch.px) * k, py: my - (pinch.my - pinch.py) * k });
        tip.hidden = true; redraw(); return;
      }
      if (drag && ids.length === 1) {
        var dx = p[0] - drag.x, dy = p[1] - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; cv.classList.add('drag'); tip.hidden = true; }
        if (drag.moved) { V = clampView({ z: V.z, px: drag.px + dx, py: drag.py + dy }); redraw(); }
        return;
      }
      if (e.pointerType !== 'mouse') return;
      var h = hitAt(p[0], p[1]);
      if (!h) { tip.hidden = true; return; }
      tip.innerHTML = tipHtml(h); tip.hidden = false;
      var left = p[0] + 14, top = p[1] + 14;
      if (left + 260 > W) left = Math.max(6, p[0] - 270);
      if (top + 110 > H) top = Math.max(6, p[1] - 110);
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    });
    var end = function (e) {
      var wasClick = drag && !drag.moved && !pinch, p = ptrs[e.pointerId];
      delete ptrs[e.pointerId];
      if (Object.keys(ptrs).length < 2) pinch = null;
      cv.classList.remove('drag');
      if (wasClick && p && e.type === 'pointerup') {
        var h = hitAt(p[0], p[1]);
        if (!h) { home(); return; }
        tip.hidden = true;
        if (h.kind === 'country') showCountry(h.d.a2 || ''); else showDot(h);
      }
      drag = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !drag) tip.hidden = true; });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = local(e);
      zoomAt(p[0], p[1], V.z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)));
      tip.hidden = true;
    }, { passive: false });
    cv.addEventListener('dblclick', function (e) { var p = local(e); flyTo({ z: Math.min(40, V.z * 2), px: p[0] - (p[0] - V.px) * 2, py: p[1] - (p[1] - V.py) * 2 }, 300); });
  }

  /* ------------------------------------------------------------- layout */
  function size() {
    W = root.clientWidth || 360; H = root.clientHeight || 400;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var old = B, oldW = size.w || 0, oldH = size.h || 0;
    fitBase();
    size.w = W; size.h = H;
    /* keep what the reader was looking at when the box changes size: the
       projected point under the old centre goes under the new one */
    if (size.done && oldW) {
      var ex = ((oldW / 2 - V.px) / V.z - old.ox) / old.s, ey = (old.oy - (oldH / 2 - V.py) / V.z) / old.s;
      V = clampView({ z: V.z, px: W / 2 - (B.ox + ex * B.s) * V.z, py: H / 2 - (B.oy - ey * B.s) * V.z });
    } else { V = clampView(frame(WORLD)); size.done = true; }
    if (world) build();
    draw();
  }
  function mountOnce(el) {
    if (root) return;
    box = el;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement('div'); root.className = 'cmw';
    root.innerHTML = '<canvas aria-label="World map of GPU providers, cloud regions and AI data centers, coloured by the price of power"></canvas>'
      + '<div class="cm-top"><div class="grp" data-g="l"><button data-l="power" class="on"><i style="background:linear-gradient(90deg,#1f9d6a,#d9573f)"></i>Power price</button><button data-l="sites" class="on"><i style="background:#3df09b"></i>GPU providers</button><button data-l="metros" class="on"><i style="background:#9fb7ff"></i>Cloud regions</button><button data-l="projects" class="on"><i style="background:#f5c542"></i>AI megaprojects</button></div>'
      + '<div class="grp" data-g="v"><button data-v="world">World</button><button data-v="na">N. America</button><button data-v="eu">Europe</button><button data-v="asia">Asia</button></div></div>'
      + '<div class="cm-zoom"><button data-z="in" aria-label="Zoom in">+</button><button data-z="out" aria-label="Zoom out">−</button><button data-z="home" aria-label="Whole world" style="font-size:13px">⤢</button></div>'
      + '<div class="cm-legend"><span>Power, US$ per kWh</span><span>$0.05<span class="bar"></span>$0.20+</span><span><span class="sw" style="background:repeating-linear-gradient(135deg,#9a8f3f 0 3px,#3a3a2a 3px 6px)"></span>wholesale only</span><span><span class="sw" style="background:#111722;border:1px solid #2a3140"></span>no open data</span></div>'
      + '<aside class="cm-panel"></aside><div class="cm-tip" hidden></div><div class="cm-load">Loading the map…</div>';
    box.appendChild(root);
    cv = root.querySelector('canvas'); g = cv.getContext('2d'); tip = root.querySelector('.cm-tip'); panel = root.querySelector('.cm-panel');
    stripe = makeStripe();
    panel.addEventListener('click', onPanel);
    root.querySelector('[data-g="l"]').addEventListener('click', function (e) {
      var b = e.target.closest('[data-l]'); if (!b) return;
      on[b.dataset.l] = !on[b.dataset.l]; b.classList.toggle('on', on[b.dataset.l]); draw();
    });
    root.querySelector('[data-g="v"]').addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]'); if (!b) return;
      flyTo(frame(VIEWS[b.dataset.v]), 550);
    });
    root.querySelector('.cm-zoom').addEventListener('click', function (e) {
      var b = e.target.closest('[data-z]'); if (!b) return;
      var ar = area(), cx = ar.x + ar.w / 2, cy = ar.y + ar.h / 2, k = b.dataset.z === 'in' ? 1.8 : 1 / 1.8;
      if (b.dataset.z === 'home') return flyTo(frame(WORLD), 450);
      flyTo({ z: V.z * k, px: cx - (cx - V.px) * k, py: cy - (cy - V.py) * k }, 260);
    });
    bindPointers();
    if (window.ResizeObserver) new ResizeObserver(function () { if (!box.hidden && (Math.abs(root.clientWidth - W) > 1 || Math.abs(root.clientHeight - H) > 1)) size(); }).observe(root);
    if (window.innerWidth <= 760) panel.classList.add('min');
  }
  function load() {
    if (D && Date.now() - loadedAt < 10 * 60e3) return Promise.resolve();
    var a = fetch('/api/compute/map').then(function (r) { return r.json(); }).then(function (j) { D = j; loadedAt = Date.now(); });
    var b = world ? Promise.resolve() : fetch('/world-110m.json').then(function (r) { return r.json(); }).then(function (j) { world = j; });
    return Promise.all([a, b]);
  }

  window.ComputeMap = {
    show: function (el) {
      mountOnce(el);
      root.style.display = '';
      load().then(function () {
        var ld = root.querySelector('.cm-load'); if (ld) ld.remove();
        size();
        if (!selected && !focusGpu) home();
      }).catch(function () {
        var ld = root.querySelector('.cm-load'); if (ld) ld.textContent = 'The map could not load — try again in a minute.';
      });
    },
    hide: function () { if (root) { root.style.display = 'none'; if (tip) tip.hidden = true; } },
  };
})();
