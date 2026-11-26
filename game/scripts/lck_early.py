"""Early-game kills in real LCK 2026 games (raw Riot match-v5 timelines): how many per minute, how many champions take
part (killer + assists + victim), whether a jungler is involved, where on the map, and how often the first blood is a
lane-only kill. Target numbers for scripts/early-diag.ts.

Run: python -I scripts/lck_early.py [--raw ../data/raw]
Participants 1-5 are blue Top/Jungle/Mid/Bot/Support, 6-10 red in the same order.
"""
from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter
from pathlib import Path

ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]


def role_of(pid: int) -> str:
    return ROLES[(pid - 1) % 5]


def zone(x: float, y: float) -> str:
    """Rough map zone on the 14,870 map: lanes along the edges / diagonal, jungle elsewhere, river by the diagonal."""
    d = abs(x - y)
    if x < 2200 or y > 12600:
        return "top"
    if y < 2200 or x > 12600:
        return "bot"
    if d < 1300 and 4000 < x < 10800:
        return "mid"
    if abs((x + y) - 14800) < 1500:
        return "river"
    return "jungle"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(Path(__file__).resolve().parent.parent.parent / "data" / "raw"))
    args = ap.parse_args()
    files = sorted(Path(args.raw).glob("*.json.gz"))
    games = 0
    per_min = Counter()
    size10 = Counter()
    jg10 = 0
    zone10 = Counter()
    kills10 = 0
    kills14 = 0
    fb_times: list[float] = []
    fb_jg = 0
    fb_size = Counter()
    lane_only10 = 0
    jg_kills_by_role = Counter()
    for f in files:
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            payload = json.load(fh)
        tl = payload.get("timeline", payload)
        tl = tl.get("info", tl)
        frames = tl.get("frames") or []
        if not frames:
            continue
        games += 1
        first = True
        for fr in frames:
            for ev in fr.get("events", []):
                if ev.get("type") != "CHAMPION_KILL":
                    continue
                t = ev["timestamp"] / 60000
                m = int(t)
                per_min[m] += 1
                killer = ev.get("killerId", 0)
                victim = ev.get("victimId", 0)
                assists = ev.get("assistingParticipantIds", []) or []
                parts = {p for p in [killer, victim, *assists] if p and 1 <= p <= 10}
                jungle = any(role_of(p) == "Jungle" for p in parts)
                pos = ev.get("position") or {"x": 0, "y": 0}
                if first:
                    fb_times.append(t)
                    fb_jg += jungle
                    fb_size[min(len(parts), 6)] += 1
                    first = False
                if t < 14:
                    kills14 += 1
                if t < 10:
                    kills10 += 1
                    size10[min(len(parts), 6)] += 1
                    jg10 += jungle
                    zone10[zone(pos["x"], pos["y"])] += 1
                    if not jungle:
                        lane_only10 += 1
                    if jungle and killer and role_of(killer) == "Jungle":
                        jg_kills_by_role[role_of(victim)] += 1
    n = max(1, games)
    fb_times.sort()
    print(f"games {games}")
    print(f"kills by 10 min {kills10 / n:.2f}, by 14 min {kills14 / n:.2f}")
    print("kills per minute: " + " ".join(f"{m}:{per_min[m] / n:.2f}" for m in range(14)))
    print(f"first blood mean {sum(fb_times) / len(fb_times):.1f} min, median {fb_times[len(fb_times) // 2]:.1f}; jungler involved {fb_jg / len(fb_times) * 100:.0f}%")
    print("first blood participants (killer+assists+victim): " + " ".join(f"{k}:{v / len(fb_times) * 100:.0f}%" for k, v in sorted(fb_size.items())))
    k10 = max(1, kills10)
    print("kills < 10 min by participants: " + " ".join(f"{k}:{v / k10 * 100:.0f}%" for k, v in sorted(size10.items())) + f"  (mean {sum(k * v for k, v in size10.items()) / k10:.2f})")
    print(f"kills < 10 min with a jungler involved {jg10 / k10 * 100:.0f}%, lane-only {lane_only10 / k10 * 100:.0f}%")
    print("kills < 10 min by zone: " + " ".join(f"{k} {v / k10 * 100:.0f}%" for k, v in zone10.most_common()))
    print("jungler kills < 10 min by victim role: " + " ".join(f"{k} {v / n:.2f}" for k, v in jg_kills_by_role.most_common()))


if __name__ == "__main__":
    main()
