#!/usr/bin/env python3
"""Rebuild the Jive logo set from ONE source image: brand/logo-source.jpg (neon-pink cat + white <j> on black).

Writes: public/logo-mark.png (transparent), icon-512/192, apple-touch-icon, icon-maskable-512, favicon.png/.ico/.svg,
og-image.png, and the intro layers (intro-cat.jpg = logo with the eyes switched off, intro-eyes.png = the eyes alone,
full-canvas, so the intro can glow them up).
Run: python3 scripts/logo/build-logo.py   (needs numpy + Pillow)
"""
import base64, io, os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
P = lambda *a: os.path.join(ROOT, 'public', *a)
CW, CH = 775, 1070                       # intro canvas (CSS aspect-ratio is 775/1070)
BG = (0, 0, 0)

src = Image.open(os.path.join(ROOT, 'brand', 'logo-source.jpg')).convert('RGB')
a = np.asarray(src, np.float32) / 255.0
H, W = a.shape[:2]

# --- eyes: the pink fill inside the head, found in the source ------------------------------------------------
yy, xx = np.mgrid[0:H, 0:W]
box = (yy > H * 0.27) & (yy < H * 0.385) & (xx > W * 0.31) & (xx < W * 0.635)   # just the eyes, clear of the head outline
eye = np.clip((a[..., 0] - 0.25) / 0.55, 0, 1) * np.clip((0.55 - a[..., 1]) / 0.35, 0, 1) * box
eye_m = Image.fromarray((eye * 255).astype(np.uint8))
eye_grow = eye_m.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(2))   # a little wider, so no pink fringe is left behind
eye_grow = np.asarray(eye_grow, np.float32) / 255.0

# --- transparent mark: alpha = brightest channel, colour un-premultiplied ---------------------------------------
al = a.max(axis=2, keepdims=True)
rgb = np.where(al > 1e-4, a / np.maximum(al, 1e-4), 0)
big = Image.fromarray((np.clip(np.concatenate([rgb, al], axis=2), 0, 1) * 255).astype(np.uint8), 'RGBA')
bb = big.getchannel('A').point(lambda v: 255 if v > 30 else 0).getbbox()

def fit(canvas, img, frac_h, dy=0.0):
    c = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    im = img.crop(bb)
    h = round(canvas * frac_h); w = round(im.width * h / im.height)
    c.alpha_composite(im.resize((w, h), Image.LANCZOS), ((canvas - w) // 2, round((canvas - h) / 2 + canvas * dy)))
    return c

def icon(size, frac, path):
    bg = Image.new('RGBA', (size, size), BG + (255,)); bg.alpha_composite(fit(size, big, frac))
    bg.convert('RGB').save(path)

logo = big.crop(bb); logo = logo.resize((300, round(300 * logo.height / logo.width)), Image.LANCZOS)
logo.save(P('logo-mark.png'))

icon(512, 0.84, P('icon-512.png'))
icon(192, 0.84, P('icon-192.png'))
icon(180, 0.84, P('apple-touch-icon.png'))
icon(512, 0.64, P('icon-maskable-512.png'))
icon(64, 0.90, P('favicon.png'))
ico = Image.new('RGBA', (256, 256), BG + (255,)); ico.alpha_composite(fit(256, big, 0.90))
ico.convert('RGB').save(P('favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
buf = io.BytesIO(); Image.open(P('icon-192.png')).resize((128, 128), Image.LANCZOS).save(buf, 'PNG')
open(P('favicon.svg'), 'w').write(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><image width="128" height="128" href="data:image/png;base64,'
    + base64.b64encode(buf.getvalue()).decode() + '"/></svg>')

og = Image.new('RGBA', (1200, 630), BG + (255,))
m = big.crop(bb); h = 580; w = round(m.width * h / m.height)
og.alpha_composite(m.resize((w, h), Image.LANCZOS), ((1200 - w) // 2, 25)); og.convert('RGB').save(P('og-image.png'))

# --- intro layers on the 775x1070 canvas ------------------------------------------------------------------------
x0, y0, x1, y1 = bb
scale = (CH * 0.96) / (y1 - y0)
nw, nh = round(W * scale), round(H * scale)
ox = round((CW - (x1 - x0) * scale) / 2 - x0 * scale)
oy = round((CH - (y1 - y0) * scale) / 2 - y0 * scale)

def place(img, mode, fill):
    c = Image.new(mode, (CW, CH), fill)
    c.paste(img.resize((nw, nh), Image.LANCZOS), (ox, oy))
    return c

# base layer: the logo exactly as drawn (eyes on, so the intro starts with the eyes showing)
place(Image.fromarray((a * 255).astype(np.uint8)), 'RGB', (0, 0, 0)).save(P('intro-cat.jpg'), quality=93)

# glow layer: the SAME pink as the eyes, only added light (screen-blended over the base, so it can never shift the colour)
col = (a * eye[..., None]).sum(axis=(0, 1)) / max(eye.sum(), 1e-6)          # mean eye colour
col = col / max(col.max(), 1e-6)
def blur(m, r):
    return np.asarray(Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), np.float32) / 255.0
r = W / 1408.0
bloom = np.clip(eye + blur(eye, 5 * r) * 0.9 + blur(eye, 16 * r) * 0.7 + blur(eye, 40 * r) * 0.5, 0, 1)
glow_rgba = np.concatenate([np.broadcast_to(col, (H, W, 3)), bloom[..., None]], axis=2)
place(Image.fromarray((np.clip(glow_rgba, 0, 1) * 255).astype(np.uint8), 'RGBA'), 'RGBA', (0, 0, 0, 0)).save(P('intro-eyes.png'))
print('eye colour', (col * 255).astype(int))

ys, xs = np.where(eye > 0.3)
ex0, ex1, ey0, ey1 = [(v * scale) for v in (xs.min(), xs.max(), ys.min(), ys.max())]
print('eyes bbox on intro canvas (percent): left %.1f top %.1f width %.1f height %.1f' % (
    (ex0 + ox) / CW * 100, (ey0 + oy) / CH * 100, (ex1 - ex0) / CW * 100, (ey1 - ey0) / CH * 100))
print('ok')
