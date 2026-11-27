"""CS and level by role and minute in real LCK 2026 games (raw Riot match-v5 timelines), plus end-of-game totals.
Target numbers for scripts/growth-check.ts (the engine's side of the same table).

Run: python -I scripts/lck_growth.py [--raw ../data/raw]
Participants 1-5 are blue Top/Jungle/Mid/Bot/Support, 6-10 red in the same order. CS = lane minions + jungle monsters.
A minute counts only games still running then: the game lasted that long (the last frame of a timeline is stamped
at the end of the game, not on a minute, so a frame at that index is not enough).
"""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
MINUTES = [2, 3, 5, 8, 10, 15, 20, 25, 30]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(Path(__file__).resolve().parent.parent.parent / "data" / "raw"))
    args = ap.parse_args()
    files = sorted(Path(args.raw).glob("*.json.gz"))
    if not files:
        raise SystemExit(f"no *.json.gz games in {Path(args.raw).resolve()}")
    # (role, minute) -> sums
    acc: dict[tuple[str, int], list[float]] = {}
    end = {r: [0.0, 0.0, 0.0, 0.0] for r in ROLES}  # cs, jungle cs, level, n
    dur = []
    for f in files:
        d = json.load(gzip.open(f))
        frames = d["timeline"]["frames"]
        seconds = d["data"]["gameDuration"]
        for m in MINUTES:
            # a game that ended at 29:30 has its end frame at index 30: that is not minute 30
            if m >= len(frames) or m * 60 > seconds:
                continue
            for pid, pf in frames[m]["participantFrames"].items():
                r = ROLES[(int(pid) - 1) % 5]
                a = acc.setdefault((r, m), [0.0] * 6)  # cs, jungle cs, level, xp, n, gold earned
                a[0] += pf["minionsKilled"] + pf["jungleMinionsKilled"]
                a[1] += pf["jungleMinionsKilled"]
                a[2] += pf["level"]
                a[3] += pf["xp"]
                a[4] += 1
                a[5] += pf["totalGold"]
        mins = d["data"]["gameDuration"] / 60
        dur.append(mins)
        for p in d["data"]["participants"]:
            r = ROLES[(p["participantId"] - 1) % 5]
            e = end[r]
            e[0] += (p["totalMinionsKilled"] + p["neutralMinionsKilled"]) / mins
            e[1] += p["neutralMinionsKilled"] / mins
            e[2] += p["champLevel"]
            e[3] += 1
    print(f"{len(files)} games, mean length {sum(dur) / len(dur):.1f} min")
    print("minute  role      games   CS  (jungle)   level   xp    gold")
    for m in MINUTES:
        for r in ROLES:
            a = acc.get((r, m))
            if not a:
                continue
            n = a[4]
            print(f"{m:>5}   {r:<8} {n / 2:>5.0f} {a[0] / n:>6.1f} ({a[1] / n:>5.1f}) {a[2] / n:>6.2f} {a[3] / n:>6.0f} {a[5] / n:>6.0f}")
    print("end of game: CS/min (jungle CS/min), level")
    for r in ROLES:
        e = end[r]
        print(f"  {r:<8} {e[0] / e[3]:>5.2f} ({e[1] / e[3]:>4.2f})  Lv {e[2] / e[3]:.2f}")


if __name__ == "__main__":
    main()
