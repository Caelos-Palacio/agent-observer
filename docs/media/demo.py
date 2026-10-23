#!/usr/bin/env python3
# ---- suite kit (identical in every repo): 800x450, 15 fps, pure render(t) -> image ----
import os, sys, shutil, subprocess, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H, FPS, S = 800, 450, 15, 2          # S = supersampling factor
BG, TEXT, MUTED = '#0d1117', '#e6edf3', '#8b949e'
ACCENT, OK, ERROR, WARN = '#58a6ff', '#3fb950', '#f85149', '#d29922'
FONT_DIRS = [Path.home() / '.local/share/fonts/JetBrainsMonoNerd']
FALLBACK = ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']
FONT_FILES = {False: 'JetBrainsMonoNerdFont-Regular.ttf', True: 'JetBrainsMonoNerdFont-Bold.ttf'}


def rgb(h, a=1.0):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), round(255 * max(0, min(1, a))))


def clamp(x): return max(0.0, min(1.0, x))
def seg(t, a, b): return clamp((t - a) / (b - a))
def ease(x): x = clamp(x); return 4 * x ** 3 if x < .5 else 1 - (-2 * x + 2) ** 3 / 2   # cubic in-out
def lerp(a, b, k): return a + (b - a) * k
def typed(s, t, t0, cps=55): return s[:max(0, int((t - t0) * cps))]


_fonts = {}
def font(size, bold=False):
    key = (size, bold)
    if key not in _fonts:
        cands = [d / FONT_FILES[bold] for d in FONT_DIRS] + [Path(p) for p in FALLBACK]
        path = next(p for p in cands if p.exists())
        _fonts[key] = ImageFont.truetype(str(path), round(size * S))
    return _fonts[key]


class Cv:
    def __init__(self):
        self.img = Image.new('RGB', (W * S, H * S), BG)
        self.d = ImageDraw.Draw(self.img, 'RGBA')

    def text(self, x, y, s, size=13, color=TEXT, a=1.0, bold=False, anchor='la'):
        if a > .01 and s:
            self.d.text((x * S, y * S), s, font=font(size, bold), fill=rgb(color, a), anchor=anchor)

    def width(self, s, size=13, bold=False): return font(size, bold).getlength(s) / S

    def box(self, x0, y0, x1, y1, outline=MUTED, a=1.0, fill=None, fa=1.0, r=6, w=1):
        self.d.rounded_rectangle([x0 * S, y0 * S, x1 * S, y1 * S], radius=r * S,
                                 outline=rgb(outline, a), width=round(w * S),
                                 fill=rgb(fill, fa) if fill else None)

    def line(self, x0, y0, x1, y1, color=MUTED, a=1.0, w=1, dash=0):
        if not dash:
            self.d.line([x0 * S, y0 * S, x1 * S, y1 * S], fill=rgb(color, a), width=round(w * S))
            return
        n = int(max(abs(x1 - x0), abs(y1 - y0)) // dash)
        for i in range(0, n, 2):
            p, q = i / n, min(1, (i + 1) / n)
            self.d.line([lerp(x0, x1, p) * S, lerp(y0, y1, p) * S, lerp(x0, x1, q) * S, lerp(y0, y1, q) * S],
                        fill=rgb(color, a), width=round(w * S))

    def arrow(self, x0, y0, x1, y1, color=MUTED, a=1.0):
        self.line(x0, y0, x1, y1, color, a)
        s = 1 if x1 > x0 else -1
        self.d.polygon([(x1 * S, y1 * S), ((x1 - 7 * s) * S, (y1 - 4) * S), ((x1 - 7 * s) * S, (y1 + 4) * S)], fill=rgb(color, a))

    def dot(self, x, y, color=ACCENT, a=1.0, r=4.5):
        self.d.ellipse([(x - r) * S, (y - r) * S, (x + r) * S, (y + r) * S], fill=rgb(color, a))
        self.d.ellipse([(x - r * 2) * S, (y - r * 2) * S, (x + r * 2) * S, (y + r * 2) * S], fill=rgb(color, a * .16))


def envelope(t, T, fade=.5):
    """Loop envelope: blank at t=0 and t=T, so the GIF loops seamlessly."""
    return ease(seg(t, 0, fade)) * (1 - ease(seg(t, T - fade, T)))


def finish(cv, t, T):
    blank = Image.new('RGB', cv.img.size, BG)
    img = Image.blend(blank, cv.img, envelope(t, T))
    return img.resize((W, H), Image.LANCZOS)


def build(render, T, out, frame=None):
    if frame is not None:
        render(frame).save(out); return
    n = round(T * FPS)
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(n):
            render(i / FPS).save(f'{tmp}/f{i:04d}.png')
        pal = f'{tmp}/pal.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(FPS), '-i', f'{tmp}/f%04d.png',
                        '-vf', 'palettegen=max_colors=128:stats_mode=full', pal], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(FPS), '-i', f'{tmp}/f%04d.png', '-i', pal,
                        '-lavfi', 'paletteuse=dither=none', '-loop', '0', str(out)], check=True)
    print(f'{out}: {n} frames, {T}s, {Path(out).stat().st_size / 1e6:.2f} MB')


def cli(render, T, default_out):
    a = sys.argv[1:]
    if a[:1] == ['--frame']:          # python demo.py --frame 5.5 out.png
        build(render, T, a[2], float(a[1]))
    else:
        build(render, T, a[0] if a else default_out)
# ---- end kit ----

# ---- scene: sources -> observer -> review; every terminal line is REAL output (capture.json) ----
import json
HERE = Path(__file__).resolve().parent
CAP = json.loads((HERE / 'capture.json').read_text())
T = 12.0
COLS = 86


def wrap(s, n=COLS):
    return [s[i:i + n] for i in range(0, len(s), n)] or ['']

def clip(s, n=COLS): return s if len(s) <= n else s[:n - 1] + '…'


CMD1 = wrap('$ ' + CAP['appendCommand'])
OUT1 = wrap(CAP['appendOut'])
CMD2 = ['$ ' + CAP['reviewCommand']]
OUT2 = [clip(l) for l in CAP['reviewLines']]
CMD3 = ['$ ' + CAP['importCommand']]
OUT3 = wrap(CAP['importOut'])
CMD4 = ['$ ' + CAP['brokerCommand']]
OUT4 = [clip(l) for l in CAP['brokerLines']]
REIMP = json.loads(CAP['reimportOut'])
SRC = [(40, 'host SDK · append'), (40, 'Codex import'), (40, 'broker audit export')]
OBS = (330, 470)
REV = (620, 760)
CHIP_Y = [70, 104, 138]            # top of each 26px chip
PAGES = [(0.5, 4.0), (4.0, 7.4), (7.4, 11.5)]


def page_alpha(t, i):
    a, b = PAGES[i]
    return ease(seg(t, a, a + .25)) * (1 - ease(seg(t, b - .3, b)))


def render(t):
    cv = Cv()
    cv.text(40, 24, 'agent-observer', 14, TEXT, bold=True)
    cv.text(760, 26, 'synthetic events · fake key · real CLI output', 12, MUTED, anchor='ra')
    p = [page_alpha(t, i) for i in range(3)]
    chip_act = [p[0], 0, p[2]]
    # sources
    for i, (x, label) in enumerate(SRC):
        y = CHIP_Y[i]; a = lerp(.45, 1, chip_act[i])
        cv.box(x, y, 200, y + 26, ACCENT if chip_act[i] > .5 else MUTED, a, r=6)
        cv.text(x + 12, y + 6, label, 12, TEXT if chip_act[i] > .5 else MUTED, a)
        cv.line(200, y + 13, OBS[0] - 6, 117, MUTED, .22 + .3 * chip_act[i])
    obs_act = max(p[0], p[1] * .6, p[2])
    cv.box(OBS[0], 70, OBS[1], 164, ACCENT if obs_act > .5 else MUTED, lerp(.45, 1, obs_act), r=8)
    cv.text(400, 88, 'OBSERVER', 13, TEXT, lerp(.45, 1, obs_act), bold=True, anchor='ma')
    cv.text(400, 112, 'metadata only', 12, MUTED, lerp(.45, 1, obs_act), anchor='ma')
    cv.text(400, 134, 'no prompts · args · keys', 12, MUTED, lerp(.45, 1, obs_act), anchor='ma')
    rv = p[1]
    cv.arrow(OBS[1] + 6, 117, REV[0] - 6, 117, MUTED, .5)
    cv.box(REV[0], 70, REV[1], 164, ACCENT if rv > .5 else MUTED, lerp(.45, 1, rv), r=8)
    cv.text(690, 88, 'REVIEW', 13, TEXT, lerp(.45, 1, rv), bold=True, anchor='ma')
    cv.text(690, 112, 'counted findings', 12, MUTED, lerp(.45, 1, rv), anchor='ma')
    cv.text(690, 134, 'pack → your agent', 12, MUTED, lerp(.45, 1, rv), anchor='ma')
    # packets
    k = seg(t, 2.0, 2.6)
    if 0 < k < 1: cv.dot(lerp(206, OBS[0] - 6, ease(k)), lerp(CHIP_Y[0] + 13, 117, ease(k)), ACCENT)
    k = seg(t, 4.6, 5.2)
    if 0 < k < 1: cv.dot(lerp(OBS[1] + 6, REV[0] - 6, ease(k)), 117, ACCENT)
    k = seg(t, 8.6, 9.2)
    if 0 < k < 1: cv.dot(lerp(206, OBS[0] - 6, ease(k)), lerp(CHIP_Y[2] + 13, 117, ease(k)), ACCENT)
    # dropped-field note (page 1)
    kd = ease(seg(t, 2.9, 3.2)) * (1 - ease(seg(t, 3.7, 4.0)))
    if kd > .01:
        cv.text(400, 172, '"prompt", "apiKey"', 12, ERROR, kd, anchor='ma')
        w = cv.width('"prompt", "apiKey"', 12)
        cv.line(400 - w / 2, 180, 400 + w / 2, 180, ERROR, kd)
    # terminal
    cv.box(40, 196, 760, 394, MUTED, .5, r=6)
    pg = 0
    def lines(rows, t0, a, items):
        pass
    def draw(rows, pa, t0):
        """rows: (text, color, appear_time, typed?)"""
        y = 214
        for text, color, at, typ in rows:
            if t >= at:
                s = typed(text, t, at, 90) if typ else text
                cv.text(54, y, s, 13, color, pa * (1 if typ else ease(seg(t, at, at + .25))))
            y += 20
    draw([(l, TEXT, 0.7 + i * .5, True) for i, l in enumerate(CMD1)] +
         [(l, MUTED, 2.7 + i * .25, False) for i, l in enumerate(OUT1)], p[0], .5)
    draw([(CMD2[0], TEXT, 4.2, True)] +
         [(l, WARN if '"code"' in l else MUTED, 5.3 + i * .3, False) for i, l in enumerate(OUT2)], p[1], 4.0)
    draw([(CMD3[0], TEXT, 7.6, True)] +
         [(l, OK if i == 0 else OK, 9.0 + i * .25, False) for i, l in enumerate(OUT3)] +
         [(CMD4[0], TEXT, 9.5, True)] +
         [(l, MUTED, 10.0 + i * .25, False) for i, l in enumerate(OUT4)], p[2], 7.4)
    # captions
    caps = [(0.6, 4.0, 'Unknown fields never reach the store: "prompt" and "apiKey" were dropped.'),
            (4.0, 7.4, 'Review gives operational findings with counted evidence. No model is called.'),
            (7.4, 11.5, f'Broker audit import is metadata-only. Run again: {REIMP["imported"]} new, {REIMP["duplicates"]} duplicates.')]
    for a, b, s in caps:
        k = ease(seg(t, a, a + .3)) * (1 - ease(seg(t, b - .3, b)))
        cv.text(40, 414, s, 14, TEXT, k)
    return finish(cv, t, T)


if __name__ == '__main__':
    cli(render, T, HERE / 'demo.gif')
