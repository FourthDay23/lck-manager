"""How often an epic monster is contested and stolen in the LCK 2026 games (benchmark for the engine's smite fights).

Reads ../data/raw/*.json.gz (Riot match-v5 data + timeline). Run from the game folder:
    python -I scripts/lck_steals.py [--raw <folder>]
(a task worktree is checked out without data/: pass --raw <main folder>/data/raw)

The timeline has no "steal" event. ELITE_MONSTER_KILL gives the killer, the team credited (killerTeamId) and
assistingParticipantIds, which lists every champion that damaged the monster, of both teams. From that:
  * contested: a champion of the other team is among the assisters (it hit the monster too).
  * outdamaged take: the other team has more champions credited than the taking team (killer + own assisters) and at
    least two. The team that was doing the monster lost the last hit: the closest thing to a steal the data shows.
  * jungler: the killer is the taking team's jungler (participants 2 and 7; the last hit is nearly always a Smite).
A steal with the stolen-from team credited by fewer champions than the stealing team cannot be told from a contest,
so "outdamaged take" is a lower bound on steals and "contested" an upper bound.
scripts/steal-diag.ts prints the engine's side.
"""

from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter
from pathlib import Path

GAME_ROOT = Path(__file__).resolve().parent.parent
KIND = {"BARON_NASHOR": "baron", "RIFTHERALD": "herald", "HORDE": "grubs"}


def unwrap(p: dict) -> dict:
    return p.get("info", p)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(GAME_ROOT.parent / "data" / "raw"))
    a = ap.parse_args()
    files = sorted(Path(a.raw).glob("*.json.gz"))
    if not files:
        raise SystemExit(f"no raw games under {a.raw} (pass --raw <main folder>/data/raw)")
    n = Counter()
    contested = Counter()
    out = Counter()
    out_jg = Counter()
    jg_kill = Counter()
    for path in files:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            raw = json.load(fh)
        info = unwrap(raw["data"])
        side = {p["participantId"]: p["teamId"] for p in info["participants"]}
        for fr in unwrap(raw["timeline"])["frames"]:
            for e in fr.get("events", []):
                if e.get("type") != "ELITE_MONSTER_KILL":
                    continue
                kt = e.get("killerTeamId")
                if kt not in (100, 200):
                    continue
                mt = e.get("monsterType")
                k = "elder" if e.get("monsterSubType") == "ELDER_DRAGON" else "dragon" if mt == "DRAGON" else KIND.get(mt)
                if not k:
                    continue
                killer = e.get("killerId", 0)
                ass = e.get("assistingParticipantIds", [])
                own = 1 + sum(1 for x in ass if side.get(x) == kt)
                opp = sum(1 for x in ass if side.get(x) not in (kt, None))
                n[k] += 1
                if killer in (2, 7):
                    jg_kill[k] += 1
                if opp:
                    contested[k] += 1
                if opp >= 2 and opp > own:
                    out[k] += 1
                    if killer in (2, 7):
                        out_jg[k] += 1
    g = len(files)
    print(f"LCK 2026, {g} games. Per monster: takes a game | last hit by the jungler | contested (the other team hit it too) | outdamaged take (likely steal) | of those by the jungler")
    for k in ("dragon", "elder", "baron", "herald", "grubs"):
        if not n[k]:
            continue
        print(f"  {k:<7} {n[k] / g:5.2f} | {jg_kill[k] / n[k] * 100:5.1f}% | {contested[k] / n[k] * 100:5.1f}% | {out[k] / n[k] * 100:4.1f}% ({out[k]}, {out[k] / g:.3f} a game) | {out_jg[k]}")
    big = ("dragon", "elder", "baron", "herald")
    tot = sum(n[k] for k in big)
    print(f"  dragon + elder + baron + herald: contested {sum(contested[k] for k in big) / tot * 100:.1f}% | outdamaged takes {sum(out[k] for k in big) / g:.3f} a game ({sum(out[k] for k in big) / tot * 100:.1f}% of takes)")


if __name__ == "__main__":
    main()
