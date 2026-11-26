"""Build the Summoner's Rift nav grid for src/match/nav.ts.

Run from the game folder:  python -I scripts/build_navmask.py [--preview out.png]
Writes src/match/navmask.gen.ts (embedded data, no fetch needed headless or in the browser).

Source: public/assets/map11.png (512x512 stylized minimap). Black pixels (R+G+B < 60) are walls or outside the
map — the same rule as scripts/wallmask.json, which engine-diag uses to score "standing on a wall".
Grid: 256x256 cells (~58.6 x 59.0 map units). A cell is walkable only if all four of its minimap pixels are
walkable, so any point inside a walkable cell is off the wall mask. Row 0 is the TOP of the image (max y).

Cleaning:
  * the 512 mask is already clean (one 4-connected walkable area; the only speck is a single pixel in the bottom
    river mouth). SPECK can open such specks, but it is 0 so that walkable(p) never lands on a wallmask pixel;
    1-pixel walkable gaps between walls close by themselves in the conservative 2x2 downsample;
  * the outer ring of cells is forced to wall (nav.ts skips A* bounds checks);
  * after downsampling, walkable pockets not connected to the main area are filled (unreachable anyway);
  * every structure / camp / pit / fountain / lane / scuttle point must sit in the main area (snapped to the
    nearest walkable cell if it falls on a wall pixel; the snap distance is reported and must be small).
Traffic: public/data/heatmap.json (role x minute counts of 500-unit cells, blue-side view; red mirrored) is
summed over roles and minutes, folded with its mirror so both sides count, and baked as a coarse 30x31 grid of
per-cell extra cost (uint8) that nav.ts samples bilinearly: cost = 1 + K / (1 + log1p(traffic)).
"""
import base64
import json
import math
import re
import sys
from collections import deque

from PIL import Image

MAP = dict(minX=-120, minY=-120, maxX=14870, maxY=14980)
W = MAP["maxX"] - MAP["minX"]
H = MAP["maxY"] - MAP["minY"]
MIRROR_C = 14764.1
SRC = 512
G = 256  # nav grid resolution
K_TRAFFIC = 0.8  # mild: an empty cell costs 1.8, the busiest lane ~1.06
SPECK = 0  # wall specks up to this many pixels become walkable (0: keep every wall pixel; walkable(p) => not on wallmask)


def world_to_px(x, y, n):
    return math.floor((x - MAP["minX"]) / W * n), math.floor((1 - (y - MAP["minY"]) / H) * n)


def cell_center(gx, gy, n=G):
    return MAP["minX"] + (gx + 0.5) / n * W, MAP["maxY"] - (gy + 0.5) / n * H


def components(grid, n, val):
    """4-connected components of cells equal to val; returns list of index lists."""
    seen = bytearray(n * n)
    out = []
    for start in range(n * n):
        if grid[start] != val or seen[start]:
            continue
        q = deque([start])
        seen[start] = 1
        cells = []
        while q:
            i = q.popleft()
            cells.append(i)
            x, y = i % n, i // n
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < n and 0 <= ny < n:
                    j = ny * n + nx
                    if not seen[j] and grid[j] == val:
                        seen[j] = 1
                        q.append(j)
        out.append(cells)
    return out


def key_points():
    """Every coordinate literal in map.ts (fountains, nexus, turrets, inhibs, lane paths, camps, scuttle, pits)
    plus the mirrored blue camps (red side jungle)."""
    src = open("src/match/map.ts", encoding="utf8").read()
    pts = []
    for m in re.finditer(r"\{\s*(?:kind:\s*\"(\w+)\",\s*pos:\s*)?\{?\s*x:\s*(-?\d+(?:\.\d+)?),\s*y:\s*(-?\d+(?:\.\d+)?)\s*\}", src):
        kind, x, y = m.group(1), float(m.group(2)), float(m.group(3))
        pts.append((f"{kind or 'pt'}", x, y))
    camps = [p for p in pts if p[0] in ("blue", "gromp", "wolves", "raptors", "red", "krugs")]
    for name, x, y in camps:
        pts.append((f"red-side {name}", MIRROR_C - y, MIRROR_C - x))
    return pts


def lane_samples():
    """Points along the LANE_PATH polylines every ~150 units (where laners stand)."""
    src = open("src/match/map.ts", encoding="utf8").read()
    nexus = [(1551, 1659), (13210, 13230)]
    out = []
    for lane in ("top", "mid", "bot"):
        m = re.search(lane + r": \[NEXUS\[0\],(.*?)NEXUS\[1\]\]", src, re.S)
        body = m.group(1)
        poly = [nexus[0]] + [(float(a), float(b)) for a, b in re.findall(r"x:\s*(-?\d+),\s*y:\s*(-?\d+)", body)] + [nexus[1]]
        for (ax, ay), (bx, by) in zip(poly, poly[1:]):
            L = math.hypot(bx - ax, by - ay)
            n = max(1, int(L // 150))
            for i in range(n):
                t = i / n
                out.append((lane, ax + (bx - ax) * t, ay + (by - ay) * t))
    return out


def main():
    preview = None
    if "--preview" in sys.argv:
        preview = sys.argv[sys.argv.index("--preview") + 1]
    im = Image.open("public/assets/map11.png").convert("RGB")
    assert im.size == (SRC, SRC), im.size
    px = im.load()
    walk = bytearray(SRC * SRC)
    for y in range(SRC):
        for x in range(SRC):
            r, g, b = px[x, y]
            walk[y * SRC + x] = 1 if r + g + b >= 60 else 0

    # 1) open tiny wall specks (not terrain)
    opened = 0
    for comp in components(walk, SRC, 0):
        if len(comp) <= SPECK and not any(i % SRC in (0, SRC - 1) or i // SRC in (0, SRC - 1) for i in comp):
            for i in comp:
                walk[i] = 1
            opened += len(comp)

    # 2) downsample conservatively: a cell is walkable only if all its pixels are
    f = SRC // G
    grid = bytearray(G * G)
    for gy in range(G):
        for gx in range(G):
            ok = 1
            for dy in range(f):
                row = (gy * f + dy) * SRC + gx * f
                for dx in range(f):
                    if not walk[row + dx]:
                        ok = 0
            grid[gy * G + gx] = ok
    raw_walkable = sum(grid)
    # the outer ring stays wall (nav.ts relies on it to skip bounds checks)
    border = 0
    for k in range(G):
        for i in (k, (G - 1) * G + k, k * G, k * G + G - 1):
            border += grid[i]
            grid[i] = 0
    print("walkable border cells cleared:", border)

    # 3) keep the main walkable area (4-connected == 8-connected without corner cutting)
    comps = sorted(components(grid, G, 1), key=len, reverse=True)
    main = comps[0]
    filled = 0
    for c in comps[1:]:
        for i in c:
            grid[i] = 0
        filled += len(c)
    in_main = bytearray(G * G)
    for i in main:
        in_main[i] = 1

    # 4) key points must be in the main area (snap distance reported)
    def snap(x, y):
        gx, gy = world_to_px(x, y, G)
        gx = min(G - 1, max(0, gx))
        gy = min(G - 1, max(0, gy))
        if in_main[gy * G + gx]:
            return 0.0, gx, gy
        best = None
        for r in range(1, 40):
            for yy in range(gy - r, gy + r + 1):
                for xx in range(gx - r, gx + r + 1):
                    if 0 <= xx < G and 0 <= yy < G and in_main[yy * G + xx]:
                        cx, cy = cell_center(xx, yy)
                        d = math.hypot(cx - x, cy - y)
                        if best is None or d < best[0]:
                            best = (d, xx, yy)
            if best:
                return best
        raise SystemExit(f"no walkable cell near {x},{y}")

    worst = []
    for name, x, y in key_points():
        d, gx, gy = snap(x, y)
        worst.append((d, name, x, y))
    worst.sort(reverse=True)
    print("key points:", len(worst), "| snapped (>0):", sum(1 for w in worst if w[0] > 0))
    for d, name, x, y in worst[:12]:
        if d > 0:
            print(f"   {name:18s} ({x:.0f},{y:.0f}) on wall, nearest walkable cell centre {d:.0f}u away")
    assert worst[0][0] < 400, "a key point is far from walkable ground"
    lane_bad = [(n, x, y, snap(x, y)[0]) for n, x, y in lane_samples()]
    lane_off = [l for l in lane_bad if l[3] > 0]
    print(f"lane polyline samples on wall: {len(lane_off)}/{len(lane_bad)}, max snap {max([l[3] for l in lane_off] or [0]):.0f}u")

    # 5) traffic (coarse 500u grid, both sides)
    h = json.load(open("public/data/heatmap.json", encoding="utf8"))
    bs = h["bin_size"]
    ox, oy = h["origin"]
    TW, TH = h["shape"]
    tot = [[0.0] * TH for _ in range(TW)]
    for role, by_min in h["counts"].items():
        for m, g2 in by_min.items():
            for ix in range(TW):
                col = g2[ix]
                for iy in range(TH):
                    v = col[iy]
                    if not v:
                        continue
                    tot[ix][iy] += v
                    cx, cy = ox + (ix + 0.5) * bs, oy + (iy + 0.5) * bs
                    mx, my = MIRROR_C - cy, MIRROR_C - cx
                    jx = min(TW - 1, max(0, int((mx - ox) // bs)))
                    jy = min(TH - 1, max(0, int((my - oy) // bs)))
                    tot[jx][jy] += v
    extra = bytearray(TW * TH)  # extra cost * 255 / K, laid out iy-major: [iy * TW + ix]
    for ix in range(TW):
        for iy in range(TH):
            e = K_TRAFFIC / (1 + math.log1p(tot[ix][iy]))
            extra[iy * TW + ix] = max(0, min(255, round(e / K_TRAFFIC * 255)))

    # 6) emit
    bits = bytearray(G * G // 8)
    for i in range(G * G):
        if grid[i]:
            bits[i >> 3] |= 1 << (i & 7)
    b64 = base64.b64encode(bytes(bits)).decode()
    tb64 = base64.b64encode(bytes(extra)).decode()
    out = [
        "// GENERATED by scripts/build_navmask.py from public/assets/map11.png + public/data/heatmap.json. Do not edit.",
        f"// {G}x{G} walkable bits (row 0 = top of the minimap = max y, bit i = row*{G}+col, LSB first), base64.",
        f"// Traffic: {TW}x{TH} uint8 (index iy*{TW}+ix, 500u cells from ({ox},{oy}), y up); extra cost = v/255*K.",
        f"export const NAV_N = {G};",
        f"export const NAV_BITS = \"{b64}\";",
        f"export const TRAFFIC_W = {TW};",
        f"export const TRAFFIC_H = {TH};",
        f"export const TRAFFIC_CELL = {bs};",
        f"export const TRAFFIC_ORIGIN = {{ x: {ox}, y: {oy} }};",
        f"export const TRAFFIC_K = {K_TRAFFIC};",
        f"export const TRAFFIC_EXTRA = \"{tb64}\";",
        "",
    ]
    open("src/match/navmask.gen.ts", "w", encoding="utf8", newline="\n").write("\n".join(out))
    print(f"opened {opened} speck px; grid {G}x{G}: walkable {raw_walkable} -> {sum(grid)} "
          f"({100 * sum(grid) / (G * G):.1f}%), filled {filled} cells in {len(comps) - 1} pockets; "
          f"one component: {len(components(grid, G, 1)) == 1}")
    print(f"wrote src/match/navmask.gen.ts ({len(b64) + len(tb64)} chars of data)")

    if preview:
        sc = 3
        img = Image.new("RGB", (G * sc, G * sc))
        p2 = img.load()
        for gy in range(G):
            for gx in range(G):
                i = gy * G + gx
                if grid[i]:
                    cx, cy = cell_center(gx, gy)
                    tx = min(TW - 1, max(0, int((cx - ox) // bs)))
                    ty = min(TH - 1, max(0, int((cy - oy) // bs)))
                    v = extra[ty * TW + tx]
                    col = (255 - v // 2, 255 - v // 2, 200)
                else:
                    col = (0, 0, 0) if not walk[(gy * f) * SRC + gx * f] else (120, 0, 0)
                for dy in range(sc):
                    for dx in range(sc):
                        p2[gx * sc + dx, gy * sc + dy] = col
        for name, x, y in key_points():
            gx, gy = world_to_px(x, y, G)
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    xx, yy = gx * sc + 1 + dx, gy * sc + 1 + dy
                    if 0 <= xx < G * sc and 0 <= yy < G * sc:
                        p2[xx, yy] = (0, 160, 255)
        img.save(preview)
        print("preview", preview)


if __name__ == "__main__":
    main()
