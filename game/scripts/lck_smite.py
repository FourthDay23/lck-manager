"""Smite use in the 2026 LCK games (match data: summoner1Casts / summoner2Casts), for scripts/smite-check.ts.

The raw games are ../data/raw/*.json.gz (Riot match v5 + timeline; participant 2 / 7 is each side's jungler: the
participants are in top / jungle / mid / bot / support order, teamPosition is not filled in). Smite is spell id 11.
Run: python -X utf8 scripts/lck_smite.py [data folder]  (a worktree checked out without data/: pass the main folder's)
Result (2026-11-27, 502 games, 1004 junglers): 19.1 casts a game (p10 15, p90 23), 0.60 a minute; by game length
<28 min 16.3, 28-32 18.2, 32-36 19.9, 36-40 21.2, 40+ 23.4; least squares 0.40 a minute + 6.2.
The casts include Smite on champions (Unleashed / Primal) and minions: the data does not say on what.
"""
import glob
import gzip
import json
import statistics as st
import sys
from pathlib import Path

DATA = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "data"
RAW = str(DATA / "raw" / "*.json.gz")
SMITE = 11
BUCKETS = [(0, 28), (28, 32), (32, 36), (36, 40), (40, 99)]


def main():
    rows = []
    for f in sorted(glob.glob(RAW)):
        with gzip.open(f, "rt", encoding="utf8") as fh:
            d = json.load(fh)["data"]
        mins = d["gameDuration"] / 60
        for i, p in enumerate(d["participants"]):
            a, b = p.get("summoner1Id", p.get("spell1Id")), p.get("summoner2Id", p.get("spell2Id"))
            if i % 5 != 1 or SMITE not in (a, b):
                continue
            rows.append((mins, p["summoner1Casts"] if a == SMITE else p["summoner2Casts"]))
    if not rows:
        raise SystemExit(f"no games under {RAW}")
    casts = sorted(c for _, c in rows)
    print(f"{len(rows)} junglers with Smite, mean game {st.mean(m for m, _ in rows):.1f} min")
    print(f"casts a game {st.mean(casts):.1f} (p10 {casts[len(casts) // 10]}, median {st.median(casts)}, p90 {casts[len(casts) * 9 // 10]})")
    print(f"casts a minute {st.mean(c / m for m, c in rows):.3f}")
    n = len(rows)
    mx, my = st.mean(m for m, _ in rows), st.mean(c for _, c in rows)
    slope = sum((m - mx) * (c - my) for m, c in rows) / sum((m - mx) ** 2 for m, _ in rows)
    print(f"least squares: {slope:.3f} a minute + {my - slope * mx:.2f}  (n {n})")
    for lo, hi in BUCKETS:
        sel = [c for m, c in rows if lo <= m < hi]
        if sel:
            print(f"  {lo}-{hi} min: {len(sel)} junglers, {st.mean(sel):.1f} casts")


if __name__ == "__main__":
    main()
