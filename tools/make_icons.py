import sys
from PIL import Image, ImageDraw

S = 1024
out_dir = sys.argv[1]

def cubic(p0, p1, p2, p3, n=60):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0]
        y = mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1]
        pts.append((x, y))
    return pts

def shield(cx, top, w, h):
    # Build the right half, then mirror it
    hw = w / 2
    right = []
    right += cubic((cx, top), (cx + hw*0.45, top + h*0.08), (cx + hw*0.8, top + h*0.10), (cx + hw, top + h*0.08))
    right += [(cx + hw, top + h*0.45)]
    right += cubic((cx + hw, top + h*0.45), (cx + hw, top + h*0.75), (cx + hw*0.45, top + h*0.90), (cx, top + h))
    left = [(2*cx - x, y) for x, y in reversed(right)]
    return right + left

# Dropbox glyph (viewBox 43 x 40)
GLYPH = [
    [(12.5,0),(0,8.1),(8.7,15.1),(21.2,7.3)],
    [(0,21.9),(12.5,30.1),(21.2,22.8),(8.7,15.1)],
    [(21.2,22.8),(30,30.1),(42.4,22),(33.8,15.1)],
    [(42.4,8.1),(30,0),(21.2,7.3),(33.8,15.1)],
    [(21.3,24.4),(12.5,31.7),(8.8,29.2),(8.8,32),(21.3,39.5),(33.8,32),(33.8,29.2),(30,31.7)],
]

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
cx = S / 2
d.polygon(shield(cx, 40, 860, 950), fill=(0, 97, 254, 255))  # Shield (Dropbox blue)

gw = 500
scale = gw / 42.4
gh = 39.5 * scale
ox, oy = cx - gw / 2, 465 - gh / 2  # Center near the shield's centroid (y≈476)
for poly in GLYPH:
    d.polygon([(ox + x*scale, oy + y*scale) for x, y in poly], fill=(255, 255, 255, 255))

for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f'{out_dir}/icon{size}.png')
print('ok')
