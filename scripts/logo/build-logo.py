#!/usr/bin/env python3
"""Rebuild the Jive logo set: pink neon cat + pure-white <j> with an iridescent neon glow (no edge/border).

Source art: brand/cat-thin.png (thin solid-pink cat on black), public/intro-bk.png (dark backing behind the <j>),
brand/j-pieces/intro-{l,j,r}.jpg (white <j> pieces, used only as glyph SHAPES: their pink fringe is thresholded away).
Run: python3 scripts/logo/build-logo.py   (needs numpy + Pillow)
"""
import colorsys, os, sys
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
P = lambda *a: os.path.join(ROOT, 'public', *a)
S = 2                       # supersample
CW, CH = 775, 1070          # intro canvas
W, H = CW * S, CH * S

def load(p, mode):
    return Image.open(p).convert(mode)

# --- glyph mask (white core only, fringe removed) -----------------------------------------------
PIECES = [('intro-l.jpg', 13.5, 26.3), ('intro-j.jpg', 39.7, 22.6), ('intro-r.jpg', 62.3, 24.1)]
mask = Image.new('L', (W, H), 0)
for name, left, width in PIECES:
    im = load(os.path.join(ROOT, 'brand', 'j-pieces', name), 'L')
    # white core: well above the pink edge's luminance
    arr = np.asarray(im, dtype=np.float32)
    core = np.clip((arr - 170.0) / 60.0, 0, 1)            # soft threshold keeps AA
    m = Image.fromarray((core * 255).astype(np.uint8))
    w = round(CW * width / 100 * S)
    h = round(im.height * w / im.width)
    m = m.resize((w, h), Image.LANCZOS)
    mask.paste(m, (round(CW * left / 100 * S), round(CH * 44.1 / 100 * S)), m)
mask = mask.filter(ImageFilter.GaussianBlur(1.6 * S))                  # smooth source JPEG jaggies...
mask_np = np.clip((np.asarray(mask, dtype=np.float32) / 255.0 - 0.5) * 6 + 0.5, 0, 1)   # ...then re-sharpen the edge

# --- iridescent colour field: hue drifts across the mark ---------------------------------------
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
t = (xx / W * 1.15 + yy / H * 0.55)
def field(shift):
    hue = (0.93 + 0.5 * np.sin((t + shift) * 2 * np.pi * 0.9) * 0.5 + 0.0) % 1.0   # pink -> violet -> blue -> cyan -> back
    hue = 0.93 - 0.40 * (0.5 - 0.5 * np.cos((t + shift) * 2 * np.pi))               # 0.93 (pink) .. 0.53 (cyan)
    rgb = np.zeros((H, W, 3), np.float32)
    # vectorised HSV->RGB at s=0.85,v=1
    h6 = (hue % 1.0) * 6; i = np.floor(h6).astype(int) % 6; f = h6 - np.floor(h6)
    s, v = 0.85, 1.0
    p, q, tt = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    sel = [(v, tt, p), (q, v, p), (p, v, tt), (p, q, v), (tt, p, v), (v, p, q)]
    for k, (r, g, b) in enumerate(sel):
        m = i == k
        rgb[..., 0][m] = r if np.isscalar(r) else r[m]
        rgb[..., 1][m] = g if np.isscalar(g) else g[m]
        rgb[..., 2][m] = b if np.isscalar(b) else b[m]
    return rgb
col = field(0.0)

def blur(a, r):
    return np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r * S)), np.float32) / 255.0

glow = (blur(mask_np, 3) * 1.1 + blur(mask_np, 10) * 1.0 + blur(mask_np, 26) * 0.95 + blur(mask_np, 60) * 0.7)
glow_rgb = col * glow[..., None]
core = mask_np[..., None]
white = np.array([1.0, 1.0, 1.0], np.float32)
mark = np.clip(glow_rgb * (1 - core * 0.9) + white * core, 0, 1)      # white core, coloured halo, no edge

# --- cat ----------------------------------------------------------------------------------------
cat = load(os.path.join(ROOT, 'brand', 'cat-thin.png'), 'RGB').resize((W, H), Image.LANCZOS)
bk = load(P('intro-bk.png'), 'RGBA').resize((W, H), Image.LANCZOS)
cat_np = np.asarray(cat, np.float32) / 255.0
bk_a = (np.asarray(bk, np.float32)[..., 3:4] / 255.0)
bk_rgb = np.asarray(bk, np.float32)[..., :3] / 255.0
cat_np = cat_np * (1 - bk_a) + bk_rgb * bk_a                          # dark backing behind the mark
final = 1 - (1 - cat_np) * (1 - mark)                                   # screen
final = np.clip(final, 0, 1)

def save_rgb(a, path, q=None):
    im = Image.fromarray((a * 255).astype(np.uint8))
    im.save(path, quality=q) if q else im.save(path)

def to_rgba_on_black(a):
    """glow-on-black -> transparent PNG (alpha = brightest channel, colour un-premultiplied)"""
    al = a.max(axis=2, keepdims=True)
    rgb = np.where(al > 1e-4, a / np.maximum(al, 1e-4), 0)
    return np.concatenate([rgb, al], axis=2)

def rgba_img(a4): return Image.fromarray((np.clip(a4, 0, 1) * 255).astype(np.uint8), 'RGBA')

big = rgba_img(to_rgba_on_black(final))
big.save('/tmp/jive-logo-big.png')

def fit(canvas, img, frac_h, dy=0.0):
    c = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    bb = img.getchannel('A').point(lambda v: 255 if v > 18 else 0).getbbox()
    im = img.crop(bb)
    h = round(canvas * frac_h); w = round(im.width * h / im.height)
    im = im.resize((w, h), Image.LANCZOS)
    c.alpha_composite(im, ((canvas - w) // 2, round((canvas - h) / 2 + canvas * dy)))
    return c

BG = (9, 8, 12)
def icon(size, frac, path):
    c = fit(size, big, frac)
    bg = Image.new('RGBA', (size, size), BG + (255,)); bg.alpha_composite(c)
    bg.convert('RGB').save(path)

# transparent logo (sidebar / top bar)
bb = big.getchannel('A').point(lambda v: 255 if v > 10 else 0).getbbox()
logo = big.crop(bb); logo = logo.resize((230, round(230 * logo.height / logo.width)), Image.LANCZOS)
logo.save(P('logo-mark.png'))

icon(512, 0.84, P('icon-512.png'))
icon(192, 0.84, P('icon-192.png'))
icon(180, 0.84, P('apple-touch-icon.png'))
icon(512, 0.64, P('icon-maskable-512.png'))
icon(64, 0.90, P('favicon.png'))
ico = Image.new('RGBA', (256, 256), BG + (255,)); ico.alpha_composite(fit(256, big, 0.90))
ico.convert('RGB').save(P('favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

# og image 1200x630: mark on the right half of a dark field, as before (kept simple + centred)
og = Image.new('RGBA', (1200, 630), BG + (255,))
m = big.crop(bb); h = 560; w = round(m.width * h / m.height); m = m.resize((w, h), Image.LANCZOS)
og.alpha_composite(m, ((1200 - w) // 2, 35)); og.convert('RGB').save(P('og-image.png'))

# intro: one glow-baked layer replaces the three plain pieces (screen-blended over the cat)
save_rgb(np.asarray(Image.fromarray((mark * 255).astype(np.uint8)).resize((CW, CH), Image.LANCZOS), np.float32) / 255.0, P('intro-mark.jpg'), q=93)
print('ok')
