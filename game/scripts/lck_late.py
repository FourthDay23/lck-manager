"""How real LCK 2026 games close (raw Riot match-v5 timelines): turrets down by minute, first inhibitor, first baron,
how long games last after them, and kills after 30 min. Target numbers for scripts/late-diag.ts.

Run: python -I scripts/lck_late.py [--raw ../data/raw]
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path


def q(v: list[float], p: float) -> float:
    s = sorted(v)
    return s[min(len(s) - 1, int(p * (len(s) - 1) + 0.5))] if s else float("nan")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(Path(__file__).resolve().parent.parent.parent / "data" / "raw"))
    args = ap.parse_args()
    n = 0
    length: list[float] = []
    turrets_by = {14: 0, 20: 0, 25: 0, 30: 0}
    first_inhib: list[float] = []
    after_inhib: list[float] = []
    first_baron: list[float] = []
    after_baron: list[float] = []
    inhibs = 0
    inner_first: list[float] = []
    base_first: list[float] = []
    for f in sorted(Path(args.raw).glob("*.json.gz")):
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            payload = json.load(fh)
        tl = payload.get("timeline", payload)
        tl = tl.get("info", tl)
        frames = tl.get("frames") or []
        if not frames:
            continue
        n += 1
        end = None
        fi = fb = None
        inner = base = None
        evs = [ev for fr in frames for ev in fr.get("events", [])]
        for ev in evs:
            if ev.get("type") == "GAME_END":
                end = ev["timestamp"] / 60000
        if end is None:
            end = frames[-1]["timestamp"] / 60000
        length.append(end)
        for ev in evs:
            t = ev.get("timestamp", 0) / 60000
            if ev.get("type") == "BUILDING_KILL":
                if ev.get("buildingType") == "TOWER_BUILDING":
                    for m in turrets_by:
                        if t < m:
                            turrets_by[m] += 1
                    tt = ev.get("towerType", "")
                    if tt == "INNER_TURRET" and inner is None:
                        inner = t
                    if tt == "BASE_TURRET" and base is None:
                        base = t
                elif ev.get("buildingType") == "INHIBITOR_BUILDING":
                    inhibs += 1
                    if fi is None:
                        fi = t
            if ev.get("type") == "ELITE_MONSTER_KILL" and ev.get("monsterType") == "BARON_NASHOR" and fb is None:
                fb = t
        if fi is not None:
            first_inhib.append(fi)
            after_inhib.append(end - fi)
        if fb is not None:
            first_baron.append(fb)
            after_baron.append(end - fb)
        if inner is not None:
            inner_first.append(inner)
        if base is not None:
            base_first.append(base)
    print(f"games {n}, length median {q(length, 0.5):.1f} min (P25 {q(length, 0.25):.1f}, P75 {q(length, 0.75):.1f}, P90 {q(length, 0.9):.1f}), share over 38 min {sum(1 for x in length if x > 38) / n * 100:.0f}%")
    print("turrets down (both teams) by minute: " + " ".join(f"{m}:{v / n:.2f}" for m, v in turrets_by.items()))
    print(f"first inner (tier 2) turret median {q(inner_first, 0.5):.1f} min, first base (tier 3) {q(base_first, 0.5):.1f} ({len(base_first) / n * 100:.0f}% of games)")
    print(f"first inhibitor median {q(first_inhib, 0.5):.1f} min ({len(first_inhib) / n * 100:.0f}% of games), game lasts {q(after_inhib, 0.5):.1f} min after it (median); inhibitors per game {inhibs / n:.2f}")
    print(f"first baron median {q(first_baron, 0.5):.1f} min ({len(first_baron) / n * 100:.0f}% of games), game lasts {q(after_baron, 0.5):.1f} min after it (median)")


if __name__ == "__main__":
    main()
