"""Where the dragon and Baron pits are on the minimap art, against the engine's pit spots (match/map.ts).

  python -I game/scripts/pit-check.py

The engine's walls come from public/assets/map11.png (scripts/build_navmask.py), and the match is drawn on the same
picture, so a monster stands in the middle of its pit when its spot is the middle of the pit on this art: the water
pixel deepest inside the round pit (the centre of the largest circle of water that fits in it). Also prints which
way each pit opens onto the river, in screen angles (0 = right, 90 = down).
"""
import math
import os
import re

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
MAP = os.path.join(HERE, "..", "public", "assets", "map11.png")
SRC = os.path.join(HERE, "..", "src", "match", "map.ts")
W, H, MINX, MINY = 14990, 15100, -120, -120

src = open(SRC, encoding="utf8").read()
spots = {}
for name in ("DRAGON_PIT", "BARON_PIT"):
    m = re.search(name + r": Vec = \{ x: (-?\d+), y: (-?\d+) \}", src)
    spots[name] = (int(m.group(1)), int(m.group(2)))

im = np.asarray(Image.open(MAP).convert("RGB")).astype(int)
n = im.shape[0]
r, b = im[..., 0], im[..., 2]
water = (b > r + 25) & (b > 90)
depth = ndimage.distance_transform_edt(water)


def to_px(x, y):
    return (x - MINX) / W * n, (1 - (y - MINY) / H) * n


def to_world(px, py):
    return MINX + (px + 0.5) / n * W, MINY + (1 - (py + 0.5) / n) * H


worst = 0.0
for name, (x, y) in spots.items():
    cx, cy = to_px(x, y)
    x0, y0 = int(cx - 30), int(cy - 30)
    win = depth[y0:y0 + 60, x0:x0 + 60]
    top = win.max()
    ys, xs = np.nonzero(win >= top - 0.75)
    px, py = x0 + xs.mean(), y0 + ys.mean()
    wx, wy = to_world(px, py)
    off = math.hypot(wx - x, wy - y)
    worst = max(worst, off)
    angs = [a for a in range(0, 360, 3) if water[int(round(py + math.sin(math.radians(a)) * (top + 4))), int(round(px + math.cos(math.radians(a)) * (top + 4)))]]
    opening = math.degrees(math.atan2(sum(math.sin(math.radians(a)) for a in angs), sum(math.cos(math.radians(a)) for a in angs)))
    print(f"{name}: engine ({x}, {y}); pit middle ({wx:.0f}, {wy:.0f}), radius {top / n * W:.0f} u; off by {off:.0f} u; opens toward {opening:.0f} deg")
print("pit-check OK" if worst < 40 else f"pit-check: a pit spot is {worst:.0f} u from the middle of its pit")
