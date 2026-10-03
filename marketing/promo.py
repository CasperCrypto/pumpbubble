"""
pumpbubble.fun — promo video, vertical 1080x1920, 30 fps, ~26 s.

    python marketing/promo.py            # the whole video -> marketing/out/pumpbubble-promo.mp4
    python marketing/promo.py --stills   # one frame per scene -> marketing/out/still-*.png

Everything in it is drawn here: the panicking pink trader (wojak-style, our
own drawing), the green bubble degen, the bubble map, the cards. No Pepe —
Matt Furie owns him and enforces it. The beat is synthesised here too, so
there is no music to license.

Congress and White House names are redacted on purpose: the disclosure
reports may not be used for advertising (5 U.S.C. 13107, and the Congress
feed's own terms say so). SEC Form 4 data has no such limit.
"""
import math
import os
import random
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
W, H, FPS = 1080, 1920, 30
BPM = 140
BEAT = 60 / BPM
BAR = BEAT * 4
SCENES = [  # (name, bars)
    ('dump', 2), ('pump', 2), ('map', 2), ('smart', 2), ('insiders', 2), ('bot', 2), ('outro', 3),
]
DUR = sum(b for _, b in SCENES) * BAR + 0.6

DISPLAY = os.path.join(ROOT, 'src', 'assets', 'archivo-black.ttf')
BODY = 'C:/Windows/Fonts/segoeuib.ttf'
BODY_R = 'C:/Windows/Fonts/segoeui.ttf'
EMOJI = 'C:/Windows/Fonts/seguiemj.ttf'
LOGO = os.path.join(ROOT, 'public', 'icon-512.png')

BG = (7, 9, 12)
GREEN = (38, 217, 133)
GREEN_HI = (95, 247, 180)
RED = (255, 77, 106)
GOLD = (245, 184, 36)
WHITE = (242, 245, 247)
DIM = (138, 148, 163)
PINK = (247, 166, 184)

random.seed(7)
_fonts = {}


def font(path, size):
    k = (path, size)
    if k not in _fonts:
        _fonts[k] = ImageFont.truetype(path, size)
    return _fonts[k]


# ------------------------------------------------------------------ easing
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease_out_cubic(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3


def ease_out_back(t, s=1.70158):
    t = clamp(t) - 1
    return 1 + (s + 1) * t ** 3 + s * t ** 2


def ease_in_out(t):
    t = clamp(t)
    return 3 * t * t - 2 * t * t * t


def pulse(t):
    """1 on every beat, decaying fast — for things that bump with the kick."""
    ph = (t % BEAT) / BEAT
    return math.exp(-ph * 7)


# ------------------------------------------------------------------ layers
_text = {}


def text_layer(s, path, size, fill, emoji=False):
    k = (s, path, size, fill, emoji)
    if k in _text:
        return _text[k]
    f = font(path, size)
    l, t, r, b = f.getbbox(s)
    pad = int(size * 0.35)
    img = Image.new('RGBA', (r - l + pad * 2, b - t + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((pad - l, pad - t), s, font=f, fill=fill, embedded_color=emoji)
    _text[k] = img
    return img


def glow_of(layer, color, radius):
    a = layer.split()[3]
    g = Image.new('RGBA', layer.size, color + (0,))
    g.putalpha(a)
    pad = radius * 3
    big = Image.new('RGBA', (layer.width + pad * 2, layer.height + pad * 2), (0, 0, 0, 0))
    big.alpha_composite(g, (pad, pad))
    return big.filter(ImageFilter.GaussianBlur(radius)), pad


_glow = {}


def put(frame, layer, cx, cy, scale=1.0, alpha=1.0, glow=None, glow_r=18, key=None):
    """Composite `layer` centred at (cx, cy), scaled, faded, optionally glowing."""
    if alpha <= 0.01 or scale <= 0.01:
        return
    lay = layer
    if glow:
        gk = (key or id(layer), glow, glow_r)
        if gk not in _glow:
            _glow[gk] = glow_of(layer, glow, glow_r)
        g, pad = _glow[gk]
        _place(frame, g, cx, cy, scale, alpha * 0.9)
    _place(frame, lay, cx, cy, scale, alpha)


def _place(frame, lay, cx, cy, scale, alpha):
    if abs(scale - 1) > 0.002:
        w, h = max(1, int(lay.width * scale)), max(1, int(lay.height * scale))
        lay = lay.resize((w, h), Image.BICUBIC)
    if alpha < 0.999:
        a = lay.split()[3].point(lambda v: int(v * alpha))
        lay = lay.copy()
        lay.putalpha(a)
    x, y = int(cx - lay.width / 2), int(cy - lay.height / 2)
    # clip to the frame: a bubble flying off the edge is partly, or wholly, outside it
    sx, sy, dx, dy = max(0, -x), max(0, -y), max(0, x), max(0, y)
    w, h = min(lay.width - sx, frame.width - dx), min(lay.height - sy, frame.height - dy)
    if w <= 0 or h <= 0:
        return
    frame.alpha_composite(lay.crop((sx, sy, sx + w, sy + h)), (dx, dy))


def rounded(size, radius, fill, outline=None, width=2):
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=fill, outline=outline, width=width)
    return img


# ------------------------------------------------------------------ bubbles
_bub = {}


def bubble(r, color, label='', sub='', sub_color=None):
    """A glossy bubble like the site's: dark core, bright rim, a highlight."""
    k = (r, color, label, sub, sub_color)
    if k in _bub:
        return _bub[k]
    s = r * 2 + 8
    yy, xx = np.mgrid[0:s, 0:s].astype(np.float32)
    c = s / 2
    d = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / r
    inside = d <= 1.0
    col = np.array(color, np.float32)
    core = col * 0.22
    rim = np.minimum(col * 1.15 + 20, 255)
    m = np.clip(d, 0, 1) ** 2.6
    rgb = core[None, None, :] * (1 - m[..., None]) + rim[None, None, :] * m[..., None]
    alpha = np.clip((1.0 - d) * r * 0.9, 0, 1) * 0.94
    alpha[~inside] = 0
    img = Image.fromarray(np.dstack([rgb, alpha[..., None] * 255]).astype(np.uint8), 'RGBA')
    hl = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse((c - r * 0.62, c - r * 0.78, c - r * 0.02, c - r * 0.38), fill=(255, 255, 255, 70))
    hl = hl.filter(ImageFilter.GaussianBlur(max(2, r * 0.08)))
    img.alpha_composite(hl)
    ring = ImageDraw.Draw(img)
    ring.ellipse((c - r, c - r, c + r, c + r), outline=tuple(int(v) for v in rim) + (200,), width=max(2, r // 30))
    if label:
        ls = max(14, int(r * 0.36))
        t = text_layer(label, DISPLAY, ls, WHITE)
        img.alpha_composite(t, (int(c - t.width / 2), int(c - t.height / 2 - (r * 0.16 if sub else 0))))
        if sub:
            st = text_layer(sub, DISPLAY, max(12, int(r * 0.24)), sub_color or WHITE)
            img.alpha_composite(st, (int(c - st.width / 2), int(c - st.height / 2 + r * 0.26)))
    _bub[k] = img
    return img


# --------------------------------------------------------------- background
def make_background():
    """A field of faint blurred bubbles, taller than the frame so it can drift."""
    bg = Image.new('RGBA', (W, H + 600), BG + (255,))
    layer = Image.new('RGBA', bg.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(34):
        r = random.randint(40, 230)
        x, y = random.randint(-100, W + 100), random.randint(-100, H + 700)
        col = random.choice([GREEN, GREEN, RED, RED, GOLD])
        d.ellipse((x - r, y - r, x + r, y + r), fill=col + (random.randint(14, 32),))
    layer = layer.filter(ImageFilter.GaussianBlur(6))
    bg.alpha_composite(layer)
    return bg


def make_vignette():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((xx - W / 2) / (W * 0.75)) ** 2 + ((yy - H / 2) / (H * 0.62)) ** 2)
    a = np.clip((d - 0.55) * 1.4, 0, 1) * 200
    v = np.zeros((H, W, 4), np.uint8)
    v[..., 3] = a.astype(np.uint8)
    return Image.fromarray(v, 'RGBA')


def make_grain(n=6):
    out = []
    for _ in range(n):
        g = np.random.randint(0, 255, (H // 2, W // 2), np.uint8)
        a = np.full((H // 2, W // 2), 6, np.uint8)
        img = Image.fromarray(np.dstack([g, g, g, a]), 'RGBA').resize((W, H), Image.NEAREST)
        out.append(img)
    return out


# --------------------------------------------------------------- characters
def pink_trader(t):
    """Our own wojak-style panicking trader: pink, bald, hands on his face."""
    S = 640
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    ink = (20, 14, 18, 255)
    sk = PINK + (255,)
    # shoulders
    d.rounded_rectangle((90, 520, 550, 760), 120, fill=(52, 58, 72, 255), outline=ink, width=8)
    # head
    d.ellipse((150, 70, 490, 470), fill=sk, outline=ink, width=9)
    # ears
    d.ellipse((122, 230, 182, 320), fill=sk, outline=ink, width=8)
    d.ellipse((458, 230, 518, 320), fill=sk, outline=ink, width=8)
    d.ellipse((150, 70, 490, 470), outline=ink, width=9)
    # forehead wrinkles
    for i in range(3):
        y = 150 + i * 22
        d.arc((250, y - 20, 390, y + 20), 200, 340, fill=ink, width=5)
    # brows, raised in panic
    d.line((225, 222, 290, 200), fill=ink, width=9)
    d.line((350, 200, 415, 222), fill=ink, width=9)
    # eyes: wide, tiny pupils
    for ex in (258, 382):
        d.ellipse((ex - 34, 238, ex + 34, 296), fill=(255, 255, 255, 255), outline=ink, width=6)
        d.ellipse((ex - 9, 258, ex + 9, 276), fill=ink)
    # tears, running
    for ex in (240, 400):
        ph = (t * 2.4 + ex) % 1.0
        ty = 300 + ph * 150
        d.ellipse((ex - 9, ty - 14, ex + 9, ty + 14), fill=(90, 170, 255, 230))
        d.line((ex, 296, ex, ty), fill=(90, 170, 255, 160), width=8)
    # mouth: screaming
    m = 1 + 0.12 * math.sin(t * 30)
    d.ellipse((268, 330 - 10 * m, 372, 430 + 10 * m), fill=(60, 10, 22, 255), outline=ink, width=8)
    d.ellipse((290, 395, 350, 425), fill=(220, 70, 90, 255))
    # hands on cheeks
    for hx, flip in ((170, 1), (470, -1)):
        d.rounded_rectangle((hx - 46, 300, hx + 46, 470), 40, fill=sk, outline=ink, width=8)
        for k in range(3):
            fy = 312 + k * 26
            d.line((hx - 30 * flip, fy, hx + 10 * flip, fy), fill=ink, width=4)
    return img


def degen_bubble(t, glasses_drop):
    """The pumpbubble degen: a green bubble in pixel shades, smirking."""
    r = 250
    body = bubble(r, GREEN).copy()
    d = ImageDraw.Draw(body)
    c = body.width / 2
    # smirk
    d.arc((c - 90, c + 10, c + 110, c + 140), 15, 140, fill=(8, 30, 20, 255), width=14)
    # pixel shades, sliding down into place
    gy = c - 70 - (1 - ease_out_cubic(glasses_drop)) * 380
    px = 22
    shade = [
        '1111111111111111111',
        '1001111111001111111',
        '1101111111101111111',
        '0111111110011111110',
        '0011111100001111100',
    ]
    ox = c - len(shade[0]) * px / 2
    for j, row in enumerate(shade):
        for i, ch in enumerate(row):
            if ch == '1':
                x0, y0 = ox + i * px, gy + j * px
                d.rectangle((x0, y0, x0 + px - 1, y0 + px - 1), fill=(5, 5, 7, 255))
            elif j > 0 and i in (1, 2, 10, 11) and j < 3:
                x0, y0 = ox + i * px, gy + j * px
                d.rectangle((x0, y0, x0 + px - 1, y0 + px - 1), fill=(255, 255, 255, 255))
    return body


# --------------------------------------------------------------- charts
def candles(frame, x0, y0, w, h, n, trend, prog, color):
    """n candles walking up (trend>0) or down, drawn in as `prog` goes 0->1."""
    d = ImageDraw.Draw(frame)
    rnd = random.Random(11 if trend > 0 else 5)
    vals, prev = [], (0.08 if trend > 0 else 0.92)
    for i in range(n):
        q = (i + 1) / n
        target = (0.08 + 0.86 * q ** 1.7) if trend > 0 else (0.92 - 0.84 * (1 - (1 - q) ** 1.6))
        c = clamp(target + rnd.uniform(-0.04, 0.04), 0.02, 0.98)
        vals.append((prev, c, max(prev, c) + rnd.uniform(0.005, 0.03), min(prev, c) - rnd.uniform(0.005, 0.03)))
        prev = c
    shown = int(n * clamp(prog))
    cw = w / n
    for i, (o, c, hi, lo) in enumerate(vals[:shown]):
        up = c >= o
        col = (GREEN if up else RED) if color is None else color
        X = x0 + i * cw + cw / 2
        Y = lambda q: y0 + h - q * h
        d.line((X, Y(hi), X, Y(lo)), fill=col + (255,), width=4)
        top, bot = Y(max(o, c)), Y(min(o, c))
        d.rectangle((X - cw * 0.36, top, X + cw * 0.36, max(top + 6, bot)), fill=col + (255,))


# --------------------------------------------------------------- scenes
def headline(frame, t, small, big, accent, y=300, big_size=118):
    """A small label and a big slammed headline, bumping with the beat."""
    s = ease_out_back(t / 0.35) if t < 0.35 else 1.0
    a = clamp(t / 0.12)
    if small:
        put(frame, text_layer(small, DISPLAY, 46, accent), W / 2, y - 100, 1.0, a)
    lines = big.split('\n')
    for i, ln in enumerate(lines):
        bump = 1 + 0.025 * pulse(t)
        put(frame, text_layer(ln, DISPLAY, big_size, WHITE), W / 2, y + i * big_size * 1.02,
            (0.6 + 0.4 * s) * bump, a, glow=accent, glow_r=22)


def scene_dump(f, t, dur):
    headline(f, t, 'YOU:', 'BUYING\nTHE TOP', RED, y=300)
    candles(f, 110, 760, 860, 440, 22, -1, (t - 0.2) / 1.6, None)
    pct = -87 * ease_out_cubic((t - 0.4) / 1.6)
    if t > 0.4:
        put(f, text_layer('%d%%' % round(pct), DISPLAY, 150, RED), W / 2, 640, 1 + 0.05 * pulse(t), 1, glow=RED, glow_r=26)
    jit = (random.Random(int(t * 30)).uniform(-6, 6) * clamp(t - 0.5)) if t > 0.5 else 0
    put(f, pink_trader(t), W / 2 + jit, 1500 + 20 * (1 - ease_out_back((t - 0.15) / 0.5)), 1.15, clamp((t - 0.1) / 0.2))
    for i, e in enumerate(['📉', '💀', '😭']):
        tt = t - 0.8 - i * 0.25
        if tt > 0:
            put(f, text_layer(e, EMOJI, 110, WHITE, emoji=True), 180 + i * 360, 1180 - tt * 140, ease_out_back(tt / 0.3), clamp(1.6 - tt))


def scene_pump(f, t, dur):
    headline(f, t, 'PUMPBUBBLE USERS:', 'IN BEFORE\nCT', GREEN, y=300)
    candles(f, 110, 760, 860, 440, 22, 1, (t - 0.15) / 1.4, None)
    v = 4269 * ease_out_cubic((t - 0.3) / 1.5)
    if t > 0.3:
        put(f, text_layer('+{:,}%'.format(int(v)), DISPLAY, 140, GREEN_HI), W / 2, 640, 1 + 0.06 * pulse(t), 1, glow=GREEN, glow_r=28)
    put(f, degen_bubble(t, (t - 0.9) / 0.35), W / 2, 1490 - 30 * math.sin(t * 6) * clamp(t - 1.2), 1.0, clamp(t / 0.2))
    for i, e in enumerate(['🚀', '💎', '🙌', '🔥']):
        tt = t - 1.4 - i * 0.18
        if tt > 0:
            put(f, text_layer(e, EMOJI, 104, WHITE, emoji=True), 150 + i * 260, 1230 - tt * 260, ease_out_back(tt / 0.3), clamp(1.8 - tt))


MAP = [  # label, change, r, colour
    ('$BUBBLE', '+9,434%', 190, GREEN), ('$DEGEN', '+2,305%', 150, GREEN), ('$WAGMI', '+789%', 120, GREEN),
    ('$NGMI', '-42%', 105, RED), ('$GIGA', '+3,652%', 140, GREEN), ('$COPE', '-18%', 82, RED),
    ('$MOON', '+611%', 112, GREEN), ('$JEET', '-67%', 96, RED), ('$HOPIUM', '+1,204%', 118, GREEN),
    ('$CHAD', '+356%', 92, GREEN), ('$RUG', '-91%', 74, RED), ('$SEND', '+148%', 86, GREEN),
    ('$APE', '+222%', 78, GREEN), ('$REKT', '-33%', 66, RED), ('$FOMO', '+470%', 100, GREEN),
]
_spots = None


def map_spots():
    """Bubble positions packed once: largest first, nudged until they do not overlap."""
    global _spots
    if _spots:
        return _spots
    rnd = random.Random(3)
    spots = []
    for (lab, ch, r, col) in sorted(MAP, key=lambda m: -m[2]):
        for _ in range(4000):
            x, y = rnd.uniform(r + 30, W - r - 30), rnd.uniform(560 + r, 1700 - r)
            if all(math.hypot(x - sx, y - sy) > r + sr + 10 for sx, sy, sr, *_ in spots):
                break
        spots.append((x, y, r, lab, ch, col))
    _spots = spots
    return spots


def scene_map(f, t, dur):
    headline(f, t, 'THE LIVE PUMP.FUN', 'BUBBLE MAP', GREEN, y=290, big_size=124)
    for i, (x, y, r, lab, ch, col) in enumerate(map_spots()):
        tt = t - 0.15 - i * 0.06
        if tt <= 0:
            continue
        s = ease_out_back(tt / 0.45)
        fx = x + 10 * math.sin(t * 1.7 + i)
        fy = y + 12 * math.cos(t * 1.3 + i * 1.7) + (1 - ease_out_cubic(tt / 0.5)) * 500
        gold = lab == '$BUBBLE'
        b = bubble(r, GOLD if gold else col, lab, ch, WHITE)
        put(f, b, fx, fy, s * (1 + (0.05 * pulse(t) if gold else 0)), 1, glow=GOLD if gold else None, glow_r=30, key=('b', lab))
        if gold and tt > 0.8:
            a = clamp((tt - 0.8) / 0.2)
            put(f, text_layer('⚡', EMOJI, 40, WHITE, emoji=True), fx - 120, fy - r - 34, 1, a)
            put(f, text_layer('BOOSTED', DISPLAY, 36, GOLD), fx + 20, fy - r - 34, 1, a)


def card(w, h, title, rows, accent, icon):
    img = rounded((w, h), 34, (16, 20, 27, 238), outline=accent + (120,), width=3)
    img.alpha_composite(text_layer(icon, EMOJI, 64, WHITE, emoji=True), (26, 18))
    img.alpha_composite(text_layer(title, DISPLAY, 40, WHITE), (120, 26))
    for i, (a, b, bc) in enumerate(rows):
        y = 118 + i * 74
        img.alpha_composite(text_layer(a, BODY, 40, (220, 226, 232)), (34, y))
        bl = text_layer(b, DISPLAY, 42, bc)
        img.alpha_composite(bl, (w - bl.width - 26, y - 4))
    return img


def scene_smart(f, t, dur):
    headline(f, t, 'FOLLOW THE', 'SMART\nMONEY', GREEN, y=300)
    cards = [
        card(920, 360, 'TOP TRADERS · banked', [('@gigachad_sol', '+$412K', GREEN), ('@wagmi_whale', '+$188K', GREEN), ('@0xhopium', '+$96K', GREEN)], GREEN, '🧠'),
        card(920, 286, 'TOP CALLERS', [('@callooor', '71% hit 2x', GREEN_HI), ('@sendooor', '64% hit 2x', GREEN_HI)], GOLD, '📣'),
        card(920, 212, 'WHALE ALERT', [('bought $DEGEN', '340 SOL', GOLD)], GOLD, '🐳'),
    ]
    y = 760
    for i, c in enumerate(cards):
        tt = t - 0.25 - i * 0.28
        if tt > 0:
            x = W / 2 + (1 - ease_out_cubic(tt / 0.4)) * 900
            put(f, c, x, y + c.height / 2, 1, clamp(tt / 0.2))
        y += c.height + 36


def redacted(w):
    """A black bar where a name would be — glitching a little."""
    img = Image.new('RGBA', (w, 46), (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle((0, 4, w, 42), fill=(0, 0, 0, 255))
    return img


def scene_insiders(f, t, dur):
    headline(f, t, 'SEE WHAT', 'CEOs &\nCONGRESS BUY', GREEN, y=290, big_size=112)
    rows = [
        ('🏛', 'CONGRESS', 'Rep.', 'BOUGHT', '$1M–$5M', GREEN, True),
        ('💼', 'CEO', 'SpaceX President', 'SOLD SPCX', '$52.5M', RED, False),
        ('🦅', 'WHITE HOUSE', 'Official', 'BOUGHT', '$250K–$500K', GREEN, True),
    ]
    y = 650
    for i, (ic, grp, who, side, amt, col, hide) in enumerate(rows):
        tt = t - 0.3 - i * 0.3
        if tt <= 0:
            y += 250
            continue
        c = rounded((940, 210), 30, (16, 20, 27, 238), outline=(255, 255, 255, 30), width=2)
        c.alpha_composite(text_layer(ic, EMOJI, 70, WHITE, emoji=True), (24, 50))
        c.alpha_composite(text_layer(grp, DISPLAY, 30, DIM), (128, 26))
        wl = text_layer(who, BODY, 46, WHITE)
        c.alpha_composite(wl, (124, 70))
        if hide:
            c.alpha_composite(redacted(170), (124 + wl.width - 20, 80))
        sl = text_layer(side, DISPLAY, 40, col)
        c.alpha_composite(sl, (124, 128))
        if hide:
            c.alpha_composite(redacted(110), (124 + sl.width - 20, 136))
        al = text_layer(amt, DISPLAY, 50, col)
        c.alpha_composite(al, (940 - al.width - 24, 72))
        x = W / 2 - (1 - ease_out_cubic(tt / 0.4)) * 900
        put(f, c, x, y + 105, 1, clamp(tt / 0.2))
        y += 250
    if t > 1.4:
        put(f, text_layer('from public filings · live', BODY, 40, DIM), W / 2, 1460, 1, clamp((t - 1.4) / 0.3))


def scene_bot(f, t, dur):
    headline(f, t, 'FREE BUY BOT', 'FOR YOUR\nTELEGRAM', GREEN, y=300)
    tt = t - 0.2
    if tt <= 0:
        return
    msg = rounded((900, 640), 38, (23, 33, 43, 250))
    d = ImageDraw.Draw(msg)
    logo = Image.open(LOGO).convert('RGBA').resize((92, 92), Image.LANCZOS)
    mask = Image.new('L', (92, 92), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, 91, 91), fill=255)
    msg.paste(logo, (28, 26), mask)
    msg.alpha_composite(text_layer('pumpbubble bot', BODY, 40, (110, 190, 255)), (138, 34))
    msg.alpha_composite(text_layer('🐳', EMOJI, 50, WHITE, emoji=True), (16, 128))
    msg.alpha_composite(text_layer('| $DEGEN WHALE BUY!', DISPLAY, 46, WHITE), (96, 140))
    dots = int(clamp((tt - 0.3) / 0.9) * 10)
    for i in range(dots):
        d.ellipse((32 + i * 82, 232, 32 + i * 82 + 64, 296), fill=GREEN + (255,))
    lines = [('💰', 'Spent  25.4 SOL ($4,120)'), ('🪙', 'Got  12.4M DEGEN'), ('📈', 'MCap  $1.2M')]
    for i, (e, s) in enumerate(lines):
        if tt > 1.0 + i * 0.12:
            msg.alpha_composite(text_layer(e, EMOJI, 46, WHITE, emoji=True), (28, 330 + i * 92))
            msg.alpha_composite(text_layer(s, BODY, 46, WHITE), (104, 328 + i * 92))
    put(f, msg, W / 2, 1180, 0.8 + 0.2 * ease_out_back(tt / 0.4), clamp(tt / 0.15))
    if tt > 1.5:
        put(f, text_layer('🐳', EMOJI, 230, WHITE, emoji=True), W / 2 + 300, 1560, ease_out_back((tt - 1.5) / 0.35) * (1 + 0.06 * pulse(t)), 1)


def scene_outro(f, t, dur):
    logo = Image.open(LOGO).convert('RGBA').resize((560, 560), Image.LANCZOS)
    arr = np.array(logo).astype(np.float32)
    lum = arr[..., :3].max(axis=2)
    arr[..., 3] = np.clip((lum - 14) * 3.2, 0, 255)
    logo = Image.fromarray(arr.astype(np.uint8), 'RGBA')
    s = ease_out_back(t / 0.6)
    put(f, logo, W / 2, 700, s * (1 + 0.03 * pulse(t)), clamp(t / 0.2), glow=GREEN, glow_r=40, key='logo')
    # bubbles bursting out of it
    rnd = random.Random(42)
    for i in range(26):
        ang = rnd.uniform(0, math.tau)
        sp = rnd.uniform(380, 900)
        tt = t - 0.15
        if tt <= 0:
            break
        rr = rnd.randint(18, 54)
        x = W / 2 + math.cos(ang) * sp * ease_out_cubic(tt / 1.4)
        y = 700 + math.sin(ang) * sp * ease_out_cubic(tt / 1.4)
        put(f, bubble(rr, rnd.choice([GREEN, GREEN, RED, GOLD])), x, y, 1, clamp(1.6 - tt / 1.5))
    if t > 0.5:
        a = clamp((t - 0.5) / 0.3)
        wa, wb = text_layer('pumpbubble', DISPLAY, 112, WHITE), text_layer('.fun', DISPLAY, 112, GREEN)
        pad = int(112 * 0.35)
        ga, gb = wa.width - 2 * pad, wb.width - 2 * pad
        x0 = W / 2 - (ga + gb) / 2
        put(f, wa, x0 + ga / 2, 1160, 1, a)
        put(f, wb, x0 + ga + gb / 2, 1160, 1, a, glow=GREEN, glow_r=20)
    if t > 1.1:
        put(f, text_layer('NOT A WEBSITE.', DISPLAY, 72, DIM), W / 2, 1330, ease_out_back((t - 1.1) / 0.3), 1)
    if t > 1.6:
        put(f, text_layer('A MOVEMENT.', DISPLAY, 96, WHITE), W / 2, 1440, ease_out_back((t - 1.6) / 0.3) * (1 + 0.03 * pulse(t)), 1, glow=GREEN, glow_r=24)
    if t > 2.3:
        a = clamp((t - 2.3) / 0.4)
        put(f, text_layer('map · smart money · insiders · buy bot · swap', BODY, 40, DIM), W / 2, 1610, 1, a)
        put(f, text_layer('t.me/pumpbubble   ·   x.com/pumpbubblefun', DISPLAY, 40, GREEN_HI), W / 2, 1700, 1, a)


SCENE_FN = {'dump': scene_dump, 'pump': scene_pump, 'map': scene_map, 'smart': scene_smart,
            'insiders': scene_insiders, 'bot': scene_bot, 'outro': scene_outro}


# --------------------------------------------------------------- frames
def render_frame(i, BGI, VIG, GRAIN):
    t = i / FPS
    # which scene, and how far into it
    acc, name, t0, dur = 0.0, SCENES[-1][0], 0.0, SCENES[-1][1] * BAR
    for n, bars in SCENES:
        d = bars * BAR
        if t < acc + d:
            name, t0, dur = n, acc, d
            break
        acc += d
    else:
        name, t0, dur = SCENES[-1][0], acc - SCENES[-1][1] * BAR, SCENES[-1][1] * BAR
    lt = t - t0
    drift = int((t * 22) % 600)
    frame = BGI.crop((0, drift, W, drift + H)).copy()
    if name == 'dump':
        tint = Image.new('RGBA', (W, H), (90, 0, 20, 40))
        frame.alpha_composite(tint)
    SCENE_FN[name](frame, lt, dur)
    if name != 'outro':
        put(frame, text_layer('pumpbubble.fun', DISPLAY, 34, (255, 255, 255)), 200, 92, 1, 0.55)
    frame.alpha_composite(VIG)
    frame.alpha_composite(GRAIN[i % len(GRAIN)])
    # a white flash and a punch-in on every scene change
    if lt < 0.1 and t0 > 0:
        fl = Image.new('RGBA', (W, H), (255, 255, 255, int(150 * (1 - lt / 0.1))))
        frame.alpha_composite(fl)
    if lt < 0.18 and t0 > 0:
        z = 1.06 - 0.06 * ease_out_cubic(lt / 0.18)
        big = frame.resize((int(W * z), int(H * z)), Image.BICUBIC)
        frame = big.crop(((big.width - W) // 2, (big.height - H) // 2, (big.width - W) // 2 + W, (big.height - H) // 2 + H))
    return frame.convert('RGB')


# --------------------------------------------------------------- audio
SR = 44100


def make_audio(path):
    n = int(DUR * SR)
    mix = np.zeros(n, np.float32)
    rng = np.random.default_rng(1)

    def add(sig, at, gain=1.0):
        i = int(at * SR)
        if i >= n:
            return
        e = min(n, i + len(sig))
        mix[i:e] += sig[:e - i] * gain

    def kick():
        L = int(0.38 * SR)
        tt = np.arange(L) / SR
        f = 46 + 120 * np.exp(-tt / 0.028)
        ph = 2 * np.pi * np.cumsum(f) / SR
        s = np.sin(ph) * np.exp(-tt / 0.2)
        s[:120] += rng.uniform(-1, 1, 120) * np.linspace(0.6, 0, 120)
        return np.tanh(s * 1.6)

    def clap():
        L = int(0.3 * SR)
        tt = np.arange(L) / SR
        nz = rng.uniform(-1, 1, L)
        nz = np.diff(nz, prepend=0)
        env = np.zeros(L)
        for off in (0, 0.009, 0.018):
            k = int(off * SR)
            env[k:] += np.exp(-(tt[:L - k]) / 0.05)
        env += np.exp(-tt / 0.16) * 0.5
        return nz * env * 0.5

    def hat(open_=False):
        L = int((0.18 if open_ else 0.045) * SR)
        tt = np.arange(L) / SR
        nz = np.diff(np.diff(rng.uniform(-1, 1, L), prepend=0), prepend=0)
        return nz * np.exp(-tt / (0.06 if open_ else 0.012)) * 0.6

    def sub808(freq, length):
        L = int(length * SR)
        tt = np.arange(L) / SR
        s = np.sin(2 * np.pi * freq * tt) * np.exp(-tt / 0.75) * (1 - np.exp(-tt / 0.004))
        return np.tanh(s * 2.2) * 0.8

    def pluck(freq, length=0.22):
        L = int(length * SR)
        tt = np.arange(L) / SR
        sq = np.sign(np.sin(2 * np.pi * freq * tt)) * 0.5 + (2 * ((freq * tt) % 1) - 1) * 0.5
        y = np.zeros(L)
        a, prev = 0.18, 0.0
        for k in range(L):
            prev = prev + a * (sq[k] - prev)
            y[k] = prev
        return y * np.exp(-tt / 0.12)

    def ding():
        L = int(0.5 * SR)
        tt = np.arange(L) / SR
        return (np.sin(2 * np.pi * 1318.5 * tt) + 0.5 * np.sin(2 * np.pi * 2637 * tt)) * np.exp(-tt / 0.12) * 0.5

    def boom():
        L = int(1.2 * SR)
        tt = np.arange(L) / SR
        s = np.sin(2 * np.pi * (40 + 40 * np.exp(-tt / 0.08)) * tt) * np.exp(-tt / 0.45)
        s += rng.uniform(-1, 1, L) * np.exp(-tt / 0.06) * 0.4
        return np.tanh(s * 1.4)

    def riser(length):
        L = int(length * SR)
        tt = np.arange(L) / SR
        nz = np.diff(rng.uniform(-1, 1, L), prepend=0)
        return nz * (tt / length) ** 2 * 0.5

    C2 = 65.41
    roots = [C2, C2, C2 * 0.8, C2 * 0.8, C2 * 1.189, C2 * 1.189, C2 * 0.891, C2 * 0.891,
             C2, C2, C2 * 0.8, C2 * 0.8, C2 * 1.189, C2 * 0.891, C2]
    penta = [523.25, 622.25, 698.46, 783.99, 932.33, 1046.5]
    motif = [0, 2, 3, 2, 4, 3, 2, 1, 0, 2, 3, 4, 5, 4, 3, 2]
    total_bars = sum(b for _, b in SCENES)
    k1, cl, hh, hho = kick(), clap(), hat(), hat(True)
    for bar in range(total_bars):
        b0 = bar * BAR
        intro = bar < 2
        last = bar == total_bars - 1
        # kick: trap pattern (1, the and of 2, 3-ish)
        for pos in ([0, 2.5] if intro else [0, 1.75, 2.5, 3.25]):
            add(k1, b0 + pos * BEAT, 0.9)
        if not intro:
            add(cl, b0 + 2 * BEAT, 0.55)               # half-time clap
            for s in range(8):
                add(hh, b0 + s * BEAT / 2, 0.28)
            if bar % 2 == 1:                            # a hat roll into the next bar
                for s in range(8):
                    add(hh, b0 + 3 * BEAT + s * BEAT / 8, 0.18 + s * 0.02)
            add(hho, b0 + 1.5 * BEAT, 0.2)
        # 808 under the kick
        add(sub808(roots[bar % len(roots)], BAR * (0.9 if intro else 0.45)), b0, 0.55)
        if not intro:
            add(sub808(roots[bar % len(roots)], BAR * 0.4), b0 + 2.5 * BEAT, 0.45)
        # the lead: a sad fall first, then the bright motif
        for s in range(16):
            if intro:
                if s % 4 == 0:
                    add(pluck(penta[max(0, 4 - s // 4)] * 0.5, 0.4), b0 + s * BEAT / 4, 0.25)
            elif not last:
                add(pluck(penta[motif[(s + bar * 3) % 16]]), b0 + s * BEAT / 4, 0.16)
    # scene changes: a boom, with a riser before it
    acc = 0.0
    for name, bars in SCENES:
        if acc > 0:
            add(boom(), acc, 0.5)
            add(riser(BAR * 0.5), acc - BAR * 0.5, 0.3)
        acc += bars * BAR
    # dings on the money moments
    for at in [SCENES[0][1] * BAR + 0.5, SCENES[0][1] * BAR + 1.2, (SCENES[0][1] + SCENES[1][1]) * BAR + 1.0]:
        add(ding(), at, 0.35)
    bot_at = sum(b for _, b in SCENES[:5]) * BAR
    for i in range(10):
        add(ding() * 0.6, bot_at + 0.5 + i * 0.09, 0.2)
    end = sum(b for _, b in SCENES[:-1]) * BAR
    add(boom(), end, 0.7)
    # master: soft clip, fade out the tail
    mix = np.tanh(mix * 1.1)
    fade = int(1.2 * SR)
    mix[-fade:] *= np.linspace(1, 0, fade)
    mix = mix / (np.abs(mix).max() + 1e-6) * 0.9
    st = np.stack([mix, mix], axis=1)
    pcm = (st * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# --------------------------------------------------------------- main
def main():
    os.makedirs(OUT, exist_ok=True)
    BGI, VIG, GRAIN = make_background(), make_vignette(), make_grain()
    total = int(DUR * FPS)
    if '--stills' in sys.argv:
        acc = 0.0
        for name, bars in SCENES:
            at = acc + bars * BAR * 0.82
            render_frame(int(at * FPS), BGI, VIG, GRAIN).save(os.path.join(OUT, 'still-%s.png' % name))
            acc += bars * BAR
        print('stills in', OUT)
        return
    wav = os.path.join(OUT, 'beat.wav')
    make_audio(wav)
    mp4 = os.path.join(OUT, 'pumpbubble-promo.mp4')
    ff = subprocess.Popen([
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
        '-i', wav, '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-strict', '-2', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mp4,
    ], stdin=subprocess.PIPE)
    for i in range(total):
        ff.stdin.write(render_frame(i, BGI, VIG, GRAIN).tobytes())
        if i % 60 == 0:
            print('frame', i, '/', total, flush=True)
    ff.stdin.close()
    ff.wait()
    print('wrote', mp4)


if __name__ == '__main__':
    main()
