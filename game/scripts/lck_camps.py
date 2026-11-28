"""Where the jungle camps and epic monsters really are, from the LCK 2026 timelines (data/raw).

  python -I game/scripts/lck_camps.py --raw data/raw [--png out.png --map game/public/assets/map11.png]

- Epic monsters: ELITE_MONSTER_KILL positions by type (median = the pit).
- Camps: junglers (participants 2 and 7) at the 1-minute frames of minutes 1-9, as a 100-unit histogram. A jungler
  stands in a camp while clearing it, so the peaks inside the jungle are the camps.
"""
import argparse, glob, gzip, json, statistics as st
from collections import defaultdict

ap = argparse.ArgumentParser()
ap.add_argument("--raw", default="data/raw")
ap.add_argument("--png")
ap.add_argument("--map", default="game/public/assets/map11.png")
a = ap.parse_args()

elite = defaultdict(list)
jg = {100: [], 200: []}  # (minute, x, y)
games = 0
for f in sorted(glob.glob(a.raw + "/*.json.gz")):
    d = json.load(gzip.open(f))
    fr = d["timeline"]["frames"]
    games += 1
    for i, x in enumerate(fr):
        for ev in x["events"]:
            if ev["type"] == "ELITE_MONSTER_KILL" and "position" in ev:
                elite[ev["monsterType"]].append((ev["position"]["x"], ev["position"]["y"]))
        if 1 <= i <= 9:
            for pid, team in (("2", 100), ("7", 200)):
                pf = x["participantFrames"].get(pid)
                if pf and pf.get("position"):
                    jg[team].append((i, pf["position"]["x"], pf["position"]["y"]))

print(f"games {games}")
print("== epic monsters (ELITE_MONSTER_KILL) ==")
for k, v in elite.items():
    xs, ys = [p[0] for p in v], [p[1] for p in v]
    print(f"{k:14s} n={len(v):5d} median=({st.median(xs):.0f}, {st.median(ys):.0f})  p10-p90 x {sorted(xs)[len(xs)//10]}..{sorted(xs)[len(xs)*9//10]} y {sorted(ys)[len(ys)//10]}..{sorted(ys)[len(ys)*9//10]}")
    # most common exact value (a monster that does not move reports its spawn point)
    c = defaultdict(int)
    for p in v: c[p] += 1
    top = sorted(c.items(), key=lambda kv: -kv[1])[:2]
    print("   most common:", top)

BIN = 100
print("== jungler position peaks, minutes 1-9 (100u bins, 3x3 sum, local maxima) ==")
for team in (100, 200):
    h = defaultdict(int)
    for _, x, y in jg[team]: h[(x // BIN, y // BIN)] += 1
    sm = {}
    for (bx, by) in list(h):
        sm[(bx, by)] = sum(h.get((bx + dx, by + dy), 0) for dx in (-1, 0, 1) for dy in (-1, 0, 1))
    peaks = []
    for k, v in sorted(sm.items(), key=lambda kv: -kv[1]):
        if v < 25: break
        if all(abs(k[0] - p[0][0]) > 5 or abs(k[1] - p[0][1]) > 5 for p in peaks):
            # centroid of the samples within 250u
            cx, cy = k[0] * BIN + 50, k[1] * BIN + 50
            pts = [(x, y) for _, x, y in jg[team] if abs(x - cx) < 250 and abs(y - cy) < 250]
            peaks.append((k, v, st.mean(p[0] for p in pts), st.mean(p[1] for p in pts), len(pts)))
    print(f"team {team} ({'blue' if team == 100 else 'red'}), samples {len(jg[team])}")
    for k, v, mx, my, n in peaks[:22]:
        print(f"   ({mx:6.0f}, {my:6.0f})  n={n}")

if a.png:
    from PIL import Image, ImageDraw
    im = Image.open(a.map).convert("RGB").resize((1024, 1024), Image.NEAREST)
    dr = ImageDraw.Draw(im, "RGBA")
    W, H, MINX, MINY = 14990, 15100, -120, -120
    def px(x, y): return ((x - MINX) / W * 1024, (1 - (y - MINY) / H) * 1024)
    for team, col in ((100, (80, 170, 255, 70)), (200, (255, 90, 90, 70))):
        for _, x, y in jg[team]:
            X, Y = px(x, y)
            dr.rectangle([X - 1, Y - 1, X + 1, Y + 1], fill=col)
    for k, v in elite.items():
        for x, y in v:
            X, Y = px(x, y)
            dr.point([X, Y], fill=(255, 220, 90, 160))
    im.save(a.png)
    print("wrote", a.png)
