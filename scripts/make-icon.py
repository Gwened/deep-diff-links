"""Renders the Deep Diff Links icon (256x256 RGBA PNG) with signed distance fields. Usage: python3 scripts/make-icon.py images/icon.png (pure Python, no dependencies, ~25 s)"""
import math, struct, sys, zlib

SIZE, SS = 256, 4  # output size, supersampling per axis

def hexc(h, a=1.0):
    h = h.lstrip('#'); return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, a)

def sd_round_rect(x, y, x0, y0, x1, y1, r):
    cx, cy, hx, hy = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    dx, dy = abs(x - cx) - hx, abs(y - cy) - hy
    return math.hypot(max(dx, 0), max(dy, 0)) + min(max(dx, dy), 0) - r

def sd_capsule(x, y, ax, ay, bx, by, r):
    px, py, vx, vy = x - ax, y - ay, bx - ax, by - ay
    t = max(0, min(1, (px * vx + py * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - vx * t, py - vy * t) - r

BG, PANEL, LINE = hexc('#1F2328'), hexc('#2D333B'), hexc('#768390')
RED_BG, RED_LINE = hexc('#E5534B', 0.30), hexc('#F47067')
GREEN_BG, GREEN_LINE = hexc('#57AB5A', 0.30), hexc('#6BC46D')
BLUE, WHITE = hexc('#316DCA'), hexc('#FFFFFF')

PANELS = [(30, 40, 124, 216), (132, 40, 226, 216)]
ROWS = [62, 84, 106, 128, 150, 172, 194]  # bar centre y
WIDTHS = [[60, 44, 66, 52, 38, 58, 30], [60, 44, 70, 62, 48, 58, 30]]
HIGHLIGHT = [({2, 3}, RED_BG, RED_LINE), ({2, 3, 4}, GREEN_BG, GREEN_LINE)]
BADGE = (200, 200, 44)

def link_layers(x, y):
    cx, cy, R = BADGE
    yield sd_round_rect(x, y, cx - R - 6, cy - R - 6, cx + R + 6, cy + R + 6, R + 6), BG  # ring separating badge
    yield math.hypot(x - cx, y - cy) - R, BLUE
    c, s = math.cos(math.radians(-45)), math.sin(math.radians(-45))
    u, v = (x - cx) * c - (y - cy) * s, (x - cx) * s + (y - cy) * c
    for a, b in ((-20, -4), (4, 20)):
        d = sd_capsule(u, v, a, 0, b, 0, 10)
        yield abs(d) - 3.5, WHITE

def layers(x, y):
    yield sd_round_rect(x, y, 0, 0, SIZE, SIZE, 52), BG
    for p, (x0, y0, x1, y1) in enumerate(PANELS):
        yield sd_round_rect(x, y, x0, y0, x1, y1, 12), PANEL
        rows, band, line = HIGHLIGHT[p]
        for i, ry in enumerate(ROWS):
            if i in rows:
                top = ry - 11 if i - 1 not in rows else ry - 11
                yield sd_round_rect(x, y, x0, top, x1, ry + 11, 0.01), band
            w = WIDTHS[p][i]
            yield sd_round_rect(x, y, x0 + 12, ry - 4, x0 + 12 + w, ry + 4, 4), (line if i in rows else LINE)
    yield from link_layers(x, y)

def over(dst, src, cov):
    a = src[3] * cov
    oa = a + dst[3] * (1 - a)
    if oa == 0: return (0, 0, 0, 0)
    return tuple((src[k] * a + dst[k] * dst[3] * (1 - a)) / oa for k in range(3)) + (oa,)

def pixel(px, py):
    acc = [0.0] * 4
    for sy in range(SS):
        for sx in range(SS):
            x, y = px + (sx + 0.5) / SS, py + (sy + 0.5) / SS
            col = (0, 0, 0, 0)
            for d, c in layers(x, y):
                if d <= 0: col = over(col, c, 1.0)
            for k in range(3): acc[k] += col[k] * col[3]
            acc[3] += col[3]
    n = SS * SS
    a = acc[3] / n
    return tuple(round(min(1, (acc[k] / acc[3] if acc[3] else 0)) * 255) for k in range(3)) + (round(a * 255),)

def write_png(path, rows):
    raw = b''.join(b'\x00' + bytes(v for p in row for v in p) for row in rows)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

write_png(sys.argv[1], [[pixel(x, y) for x in range(SIZE)] for y in range(SIZE)])
