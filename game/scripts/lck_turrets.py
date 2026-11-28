"""When turrets fall in real LCK 2026 games (raw Riot match-v5 timelines): by tier and lane, turret plates by minute,
turrets down by minute, inhibitors and nexus turrets, and lane CS by minute for the wave supply check.
Target numbers for scripts/turret-diag.ts.

Run: python -I scripts/lck_turrets.py [--raw ../data/raw]
"""
from __future__ import annotations

import argparse
import gzip
import json
from collections import defaultdict
from pathlib import Path


def q(v: list[float], p: float) -> float:
    s = sorted(v)
    return s[min(len(s) - 1, int(p * (len(s) - 1) + 0.5))] if s else float("nan")


TIER = {"OUTER_TURRET": 1, "INNER_TURRET": 2, "BASE_TURRET": 3, "NEXUS_TURRET": 4}
LANE = {"TOP_LANE": "top", "MID_LANE": "mid", "BOT_LANE": "bot"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(Path(__file__).resolve().parent.parent.parent / "data" / "raw"))
    args = ap.parse_args()
    n = 0
    first_by_tier: dict[int, list[float]] = defaultdict(list)       # first turret of that tier in the game
    all_by_tier: dict[int, list[float]] = defaultdict(list)         # every turret of that tier
    count_by_tier: dict[int, int] = defaultdict(int)
    outer_by_lane: dict[str, list[float]] = defaultdict(list)       # every outer turret, by lane
    first_outer_lane: dict[str, int] = defaultdict(int)             # which lane lost the game's first turret
    by_minute = {m: 0 for m in (10, 12, 14, 16, 18, 20, 22, 25, 28, 30, 35)}
    plates_by_minute = {m: 0 for m in (5, 8, 10, 12, 14, 16, 20, 25, 30, 99)}
    plates_by_lane: dict[str, int] = defaultdict(int)
    plates_total = 0
    inhib_times: list[float] = []
    inhibs = 0
    nexus_turrets = 0
    killer_kind = {"champion": 0, "minion": 0}
    towers_per_game: list[int] = []
    loser_towers: list[int] = []
    winner_towers: list[int] = []
    gap_outer_inner: list[float] = []  # same lane and side: outer -> inner
    gap_inner_base: list[float] = []
    gap_base_inhib: list[float] = []
    for f in sorted(Path(args.raw).glob("*.json.gz")):
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            payload = json.load(fh)
        tl = payload.get("timeline", payload)
        tl = tl.get("info", tl)
        frames = tl.get("frames") or []
        if not frames:
            continue
        n += 1
        evs = [ev for fr in frames for ev in fr.get("events", [])]
        seen_tier: set[int] = set()
        first_done = False
        towers = 0
        lost = {100: 0, 200: 0}
        when: dict[tuple[int, str, int], float] = {}
        win_team = None
        for ev in evs:
            if ev.get("type") == "GAME_END":
                win_team = ev.get("winningTeam")
        for ev in evs:
            t = ev.get("timestamp", 0) / 60000
            ty = ev.get("type")
            if ty == "TURRET_PLATE_DESTROYED":
                plates_total += 1
                plates_by_lane[LANE.get(ev.get("laneType", ""), "?")] += 1
                for m in plates_by_minute:
                    if t < m:
                        plates_by_minute[m] += 1
            if ty != "BUILDING_KILL":
                continue
            if ev.get("buildingType") == "INHIBITOR_BUILDING":
                inhibs += 1
                inhib_times.append(t)
                key = (ev.get("teamId", 0), LANE.get(ev.get("laneType", ""), "?"), 3)
                if key in when:
                    gap_base_inhib.append(t - when[key])
                continue
            if ev.get("buildingType") != "TOWER_BUILDING":
                continue
            tier = TIER.get(ev.get("towerType", ""), 0)
            lane = LANE.get(ev.get("laneType", ""), "?")
            towers += 1
            lost[ev.get("teamId", 100)] = lost.get(ev.get("teamId", 100), 0) + 1
            killer_kind["champion" if ev.get("killerId", 0) else "minion"] += 1
            for m in by_minute:
                if t < m:
                    by_minute[m] += 1
            count_by_tier[tier] += 1
            all_by_tier[tier].append(t)
            if tier not in seen_tier:
                seen_tier.add(tier)
                first_by_tier[tier].append(t)
            if tier == 1:
                outer_by_lane[lane].append(t)
                if not first_done:
                    first_done = True
                    first_outer_lane[lane] += 1
            if tier == 4:
                nexus_turrets += 1
            team = ev.get("teamId", 0)
            if tier in (1, 2, 3):
                when[(team, lane, tier)] = t
                prev = when.get((team, lane, tier - 1))
                if prev is not None:
                    (gap_outer_inner if tier == 2 else gap_inner_base).append(t - prev)
        towers_per_game.append(towers)
        if win_team in (100, 200):
            # `lost[team]` = turrets that team lost
            winner_towers.append(lost[200 if win_team == 100 else 100])
            loser_towers.append(lost[win_team])
    print(f"games {n}")
    print(f"turrets destroyed per game {sum(towers_per_game) / n:.2f} (winner takes {sum(winner_towers) / max(1, len(winner_towers)):.2f}, loser takes {sum(loser_towers) / max(1, len(loser_towers)):.2f})")
    print("turrets down (both teams) by minute: " + " ".join(f"{m}:{v / n:.2f}" for m, v in by_minute.items()))
    for tier, name in ((1, "outer"), (2, "inner"), (3, "inhibitor turret"), (4, "nexus turret")):
        fb, al = first_by_tier[tier], all_by_tier[tier]
        print(f"{name}: per game {count_by_tier[tier] / n:.2f} | first of the game median {q(fb, 0.5):.1f} min (P10 {q(fb, 0.1):.1f}, P90 {q(fb, 0.9):.1f}, in {len(fb) / n * 100:.0f}% of games) | all: median {q(al, 0.5):.1f} (P10 {q(al, 0.1):.1f}, P90 {q(al, 0.9):.1f})")
    print("outer turret by lane (median min, per game): " + " ".join(f"{l}:{q(outer_by_lane[l], 0.5):.1f}/{len(outer_by_lane[l]) / n:.2f}" for l in ("top", "mid", "bot")))
    print("lane of the game's first turret: " + " ".join(f"{l}:{first_outer_lane[l] / n * 100:.0f}%" for l in ("top", "mid", "bot")))
    print(f"same lane: outer -> inner median {q(gap_outer_inner, 0.5):.1f} min (P25 {q(gap_outer_inner, 0.25):.1f}, P75 {q(gap_outer_inner, 0.75):.1f}); inner -> inhibitor turret {q(gap_inner_base, 0.5):.1f} (P25 {q(gap_inner_base, 0.25):.1f}, P75 {q(gap_inner_base, 0.75):.1f}); inhibitor turret -> inhibitor {q(gap_base_inhib, 0.5):.2f}")
    print(f"inhibitors per game {inhibs / n:.2f}, median {q(inhib_times, 0.5):.1f} min; nexus turrets per game {nexus_turrets / n:.2f}")
    print(f"turret plates per game {plates_total / n:.2f}; taken before minute: " + " ".join(f"{m}:{v / n:.2f}" for m, v in plates_by_minute.items()))
    print("plates by lane per game: " + " ".join(f"{l}:{plates_by_lane[l] / n:.2f}" for l in ("top", "mid", "bot")))
    tot = killer_kind["champion"] + killer_kind["minion"]
    print(f"turret last hit: champion {killer_kind['champion'] / tot * 100:.0f}%, minions {killer_kind['minion'] / tot * 100:.0f}%")


if __name__ == "__main__":
    main()
