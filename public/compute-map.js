/* pumpbubble.fun — the compute map (/compute-map). src/computemap.mjs builds
   the page and the data in #cm-data; this draws it. No library: Equal Earth
   projection by its published formula, countries from /world-110m.json
   (Natural Earth), one canvas. Every string from the data is a stranger's
   (an Akash provider names itself), so tooltips are built with esc(). */
(function () {
  'use strict';
  var el = function (id) { return document.getElementById(id); };
  var raw = el('cm-data'), cv = el('cm-c'), box = el('cm');
  if (!raw || !cv || !box) return;
  var D = JSON.parse(raw.textContent || '{}');
  var tip = el('cm-tip'), card = el('cm-card');
  var g = cv.getContext('2d');
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ---------------------------------------------------------- projection */
  var A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2, R = Math.PI / 180;
  function ee(lon, lat) {
    var t = Math.asin(M * Math.sin(lat * R)), t2 = t * t, t6 = t2 * t2 * t2;
    return [lon * R * Math.cos(t) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))), t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))];
  }
  var VIEWS = { world: [-180, -56, 180, 80], na: [-128, 14, -62, 57], eu: [-12, 35, 34, 71], asia: [64, -12, 152, 50] };
  var view = 'world', on = { sites: true, metros: true, projects: true, power: true };
  var T = { s: 1, ox: 0, oy: 0 }, W = 0, H = 0, K = 1;

  function fit() {
    var b = VIEWS[view], x0 = 1 / 0, x1 = -1 / 0, y0 = 1 / 0, y1 = -1 / 0;
    for (var i = 0; i <= 12; i++) for (var j = 0; j <= 12; j++) {
      var p = ee(b[0] + (b[2] - b[0]) * i / 12, b[1] + (b[3] - b[1]) * j / 12);
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    W = box.clientWidth || 360;
    var aspect = (x1 - x0) / (y1 - y0);
    H = Math.round(Math.max(W < 600 ? 150 : 240, Math.min(640, W / aspect)));
    /* dots are sized for a desktop-wide map; a phone's world is a third of that */
    K = Math.max(0.5, Math.min(1, W / 900)) * (view === 'world' ? 1 : 1.25);
    var pad = 10, s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
    T = { s: s, ox: W / 2 - s * (x0 + x1) / 2, oy: H / 2 + s * (y0 + y1) / 2 };
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.height = H + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function xy(lon, lat) { var p = ee(lon, lat); return [T.ox + p[0] * T.s, T.oy - p[1] * T.s]; }

  /* ------------------------------------------------------------- colours */
  var price = (D.power && D.power.countries) || {};
  function mix(a, b, t) { return a.map(function (v, i) { return Math.round(v + (b[i] - v) * t); }); }
  function heat(c) {
    var t = Math.max(0, Math.min(1, (c - 6) / 14)), lo = [31, 157, 106], mid = [201, 178, 58], hi = [217, 87, 63];
    var rgb = t < 0.5 ? mix(lo, mid, t * 2) : mix(mid, hi, (t - 0.5) * 2);
    return 'rgba(' + rgb.join(',') + ',0.62)';
  }
  var cents = function (v) { return v == null ? '—' : (+v).toFixed(1) + '¢/kWh'; };
  var usd = function (v) { return v == null ? '—' : '$' + (+v).toFixed(2); };

  /* ------------------------------------------------------------ drawing */
  var world = null, paths = [], dots = [];
  function build() {
    paths = [];
    if (!world) return;
    for (var i = 0; i < world.countries.length; i++) {
      var c = world.countries[i], p = new Path2D();
      for (var k = 0; k < c.r.length; k++) {
        var r = c.r[k];
        for (var n = 0; n < r.length; n += 2) {
          var q = xy(r[n] / 10, Math.max(-89, Math.min(89, r[n + 1] / 10)));
          if (n) p.lineTo(q[0], q[1]); else p.moveTo(q[0], q[1]);
        }
        p.closePath();
      }
      paths.push({ c: c, p: p });
    }
  }
  function draw() {
    g.clearRect(0, 0, W, H);
    for (var i = 0; i < paths.length; i++) {
      var a = paths[i], cp = a.c.a2 ? price[a.c.a2] : null;
      g.fillStyle = on.power && cp != null ? heat(cp) : '#121826';
      g.fill(a.p);
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 0.6; g.stroke(a.p);
    }
    dots = [];
    var k;
    if (on.metros) for (k = 0; k < (D.metros || []).length; k++) {
      var m = D.metros[k], q = xy(m.lon, m.lat), rr = (2.4 + Math.min(4, m.regions.length) * 0.7) * K;
      g.beginPath(); g.arc(q[0], q[1], rr, 0, 7);
      g.fillStyle = 'rgba(159,183,255,0.85)'; g.fill();
      g.strokeStyle = 'rgba(10,14,24,0.9)'; g.lineWidth = 1; g.stroke();
      dots.push({ x: q[0], y: q[1], r: rr, kind: 'metro', d: m });
    }
    if (on.sites) for (k = 0; k < (D.sites || []).length; k++) {
      var s = D.sites[k], p2 = xy(s.lon, s.lat), rs = (s.gpus > 0 ? 3 + Math.sqrt(s.gpus) * 1.4 : 2) * K;
      g.save();
      if (s.gpus > 0) { g.shadowColor = 'rgba(61,240,155,0.7)'; g.shadowBlur = 12 * K; }
      g.beginPath(); g.arc(p2[0], p2[1], rs, 0, 7);
      g.fillStyle = s.gpus > 0 ? 'rgba(61,240,155,0.9)' : 'rgba(61,240,155,0.3)'; g.fill();
      g.restore();
      dots.push({ x: p2[0], y: p2[1], r: rs, kind: 'site', d: s });
    }
    if (on.projects) for (k = 0; k < (D.projects || []).length; k++) {
      var j = D.projects[k], p3 = xy(j.lon, j.lat), rp = (j.gw ? 5 + Math.sqrt(j.gw) * 5 : 6) * K;
      g.beginPath(); g.arc(p3[0], p3[1], rp, 0, 7);
      g.fillStyle = 'rgba(245,197,66,0.16)'; g.fill();
      g.strokeStyle = '#f5c542'; g.lineWidth = Math.max(1.2, 2 * K); g.stroke();
      g.beginPath(); g.arc(p3[0], p3[1], 2, 0, 7); g.fillStyle = '#f5c542'; g.fill();
      dots.push({ x: p3[0], y: p3[1], r: rp, kind: 'project', d: j });
    }
  }
  function render() { fit(); build(); draw(); }

  /* ------------------------------------------------------------- reading */
  function where(x) { return x.power ? cents(x.power.cents) + (x.power.src === 'eia' ? ' (' + esc(x.power.where) + ')' : '') : 'no published price'; }
  function describe(h) {
    var d = h.d;
    if (h.kind === 'site') {
      return '<b>' + esc(d.host || 'Akash provider') + '</b><br><span class="d">' + esc([d.region, d.country].filter(Boolean).join(', ')) + '</span><br>'
        + 'GPUs: ' + d.gpus + (d.gpus ? ' · ' + d.free + ' free' : '') + (d.models.length ? '<br>' + esc(d.models.join(', ')) : '')
        + (d.up7d != null ? '<br>Uptime 7d: ' + esc(d.up7d) + '%' : '') + '<br>Power: ' + where(d);
    }
    if (h.kind === 'metro') return '<b>' + esc(d.city) + '</b><br>' + d.regions.map(esc).join('<br>') + '<br>Power: ' + where(d);
    if (h.kind === 'project') {
      return '<b>' + esc(d.name) + '</b> <span class="d">' + esc(d.who) + '</span><br>' + esc(d.city)
        + '<br>Stated target: ' + (d.gw ? (d.gw >= 1 ? d.gw + ' GW' : Math.round(d.gw * 1000) + ' MW') : '—') + '<br><span class="d">' + esc(d.now) + '</span><br>Power: ' + where(d);
    }
    var c = h.d, v = c.a2 ? price[c.a2] : null;
    return '<b>' + esc(c.n) + '</b><br>Industrial power: ' + (v != null ? cents(v) : 'no published price')
      + (v != null ? '<br><span class="d">An H100-hour of power ≈ ' + usd(0.91 * v / 100) + '</span>' : '');
  }
  function hit(x, y) {
    var best = null, bd = 1 / 0;
    for (var i = dots.length - 1; i >= 0; i--) {
      var o = dots[i], dd = Math.hypot(o.x - x, o.y - y);
      if (dd <= o.r + 6 && dd < bd) { best = o; bd = dd; }
    }
    if (best) return best;
    if (!on.power) return null;
    for (var k = 0; k < paths.length; k++) if (g.isPointInPath(paths[k].p, x * (cv.width / W), y * (cv.height / H))) return { kind: 'country', d: paths[k].c };
    return null;
  }
  function pos(e) { var b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
  cv.addEventListener('mousemove', function (e) {
    var p = pos(e), h = hit(p[0], p[1]);
    if (!h) { tip.hidden = true; cv.style.cursor = ''; return; }
    tip.innerHTML = describe(h); tip.hidden = false; cv.style.cursor = h.kind === 'country' ? '' : 'pointer';
    var bx = box.getBoundingClientRect(), cb = cv.getBoundingClientRect();
    var left = cb.left - bx.left + p[0] + 14, top = cb.top - bx.top + p[1] + 14;
    if (left + 270 > bx.width) left = Math.max(6, left - 290);
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  });
  cv.addEventListener('mouseleave', function () { tip.hidden = true; });
  cv.addEventListener('click', function (e) {
    var p = pos(e), h = hit(p[0], p[1]);
    if (!card) return;
    if (!h) { card.classList.remove('on'); return; }
    card.innerHTML = describe(h); card.classList.add('on');
  });

  /* ------------------------------------------------------------- controls */
  box.querySelectorAll('[data-l]').forEach(function (b) {
    b.addEventListener('click', function () { on[b.dataset.l] = !on[b.dataset.l]; b.classList.toggle('on', on[b.dataset.l]); draw(); });
  });
  box.querySelectorAll('[data-v]').forEach(function (b) {
    b.addEventListener('click', function () {
      view = b.dataset.v;
      box.querySelectorAll('[data-v]').forEach(function (x) { x.classList.toggle('on', x === b); });
      tip.hidden = true; render();
    });
  });
  var last = 0;
  if (window.ResizeObserver) new ResizeObserver(function () { if (Math.abs(box.clientWidth - last) > 2) { last = box.clientWidth; render(); } }).observe(box);
  else window.addEventListener('resize', render);

  render();
  fetch('/world-110m.json').then(function (r) { return r.json(); }).then(function (j) { world = j; render(); }).catch(function () { render(); });
})();
