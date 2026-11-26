"""Build game/public/data/meta.json: match-engine calibration numbers from the LCK 2026 timelines.

  python scripts/build_meta.py [--index data/games_lck_2026.json]

Everything under "measured" comes from the Riot timelines in data/raw (502 LCK 2026 games). Spawn and
respawn timers are checked against the earliest kill times seen in the data; the values that the
timelines cannot show (jungle camps, exact spawn rules, draft rules) come from the web sources named in
WEB_RULES and are marked with their source.
"""

from __future__ import annotations

import argparse
import gzip
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "game" / "public" / "data" / "meta.json"
ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]

# Values the timelines cannot show. Checked against the 2026 LCK earliest kill times printed by this
# script (see "earliestKill" in the output) and the sources listed per entry.
DEV_PREVIEW = "https://www.leagueoflegends.com/news/dev/dev-2026-season-one-gameplay-preview/"
WEB_RULES = {
    "objectives": {
        "dragon": {"firstSpawn": 300, "respawn": 300,
                   "note": "5:00 first spawn, 5:00 respawn. 2026 data: earliest kill 5:22, shortest gap between kills 5:07"},
        "grubs": {"firstSpawn": 480, "respawn": None, "count": 3,
                  "note": "one camp of 3 Void Grubs at 8:00, the second wave was cut in 2025 (" + DEV_PREVIEW + "). "
                          "2026 data: earliest kill 8:05, exactly 3 grubs taken in all 502 games"},
        "herald": {"firstSpawn": 900, "respawn": None,
                   "note": "Rift Herald at 15:00, one spawn. 2026 data: earliest kill 15:13, exactly 1 per game"},
        "baron": {"firstSpawn": 1200, "respawn": 360,
                  "note": "Baron back to 20:00 in patch 26.1 (" + DEV_PREVIEW + "); 6:00 respawn. "
                          "2026 data: earliest kill 20:18, shortest gap 6:08"},
        "atakhan": {"firstSpawn": None, "respawn": None, "removed": True,
                    "note": "Atakhan was removed in patch 26.1 (" + DEV_PREVIEW + "); no ATAKHAN kill in the 502 LCK 2026 games"},
        "elder": {"firstSpawn": None, "respawn": 360,
                  "note": "Elder Dragon spawns after a team takes the dragon soul (6:00 after the soul dragon), 6:00 respawn. "
                          "2026 data: earliest kill 28:54, shortest gap 6:18"},
    },
    "camps": {
        "blue": {"firstSpawn": 55, "respawn": 300},
        "red": {"firstSpawn": 55, "respawn": 300},
        "gromp": {"firstSpawn": 55, "respawn": 135},
        "wolves": {"firstSpawn": 55, "respawn": 135},
        "raptors": {"firstSpawn": 55, "respawn": 135},
        "krugs": {"firstSpawn": 55, "respawn": 135},
        "scuttle": {"firstSpawn": 175, "respawn": 150},
        "note": "Respawn times are the long-standing LoL Wiki values (buffs 5:00, small camps 2:15, Scuttle 2:30). "
                "First spawns: the 2026 preview moves every first camp spawn 35 s earlier (" + DEV_PREVIEW + "), so 1:30 -> 0:55 "
                "and Scuttle 3:30 -> 2:55. Checked in the 2026 timelines: junglers have 0 camp CS at 1:00 and 11.2 at 2:00. "
                "Gromp/Krugs may still spawn a few seconds after the other camps; not verified.",
    },
    "patch26": [
        "first minion wave at 0:30 (was 1:05); 2026 data: mid laners already have 0.45 CS at 1:00",
        "Atakhan, Feats of Strength and Forced Power Play removed; first blood (100 g) and first tower (300 g) bonuses back",
        "role quests: Top gets Teleport and bonus XP, Mid a boots upgrade and 4 s Recall, ADC gold and a 7th item slot",
        "turret shields are permanent; inner and inhibitor turrets have shields too",
        "epic monsters +15% HP, stats scale with champion level; most epic monster gold reduced",
    ],
}


def pct(values, q):
    values = sorted(values)
    if not values:
        return None
    k = (len(values) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def summary(values):
    return {"mean": round(statistics.fmean(values), 1), "p10": round(pct(values, 0.1), 1),
            "p50": round(pct(values, 0.5), 1), "p90": round(pct(values, 0.9), 1), "n": len(values)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", default=str(ROOT / "data" / "games_lck_2026.json"))
    args = parser.parse_args()
    index = json.loads(Path(args.index).read_text(encoding="utf-8"))

    lengths, first_bloods, first_towers = [], [], []
    kills_by_minute = Counter()
    minutes_alive = Counter()  # games still running at minute m
    solo_by_role, solo_lane_by_role = Counter(), Counter()
    multis = Counter()
    aces = 0
    dragon_types = Counter()
    soul_games = 0
    soul_names = Counter()
    earliest = defaultdict(lambda: 10 ** 9)
    gaps = defaultdict(list)  # same monster in one game, time between kills
    kill_counts = defaultdict(list)  # per game count by monster type
    grub_counts = Counter()
    games = 0

    for game in index["games"]:
        raw = json.load(gzip.open(ROOT / game["raw"], "rt", encoding="utf-8"))
        timeline, data = raw.get("timeline"), raw["data"]
        if not timeline:
            continue
        games += 1
        duration = data["gameDuration"]
        lengths.append(duration)
        for m in range(1, 46):
            if duration >= m * 60:
                minutes_alive[m] += 1
        last_kill = {}
        per_type = Counter()
        fb_done = ft_done = False
        for frame in timeline["frames"]:
            for event in frame["events"]:
                kind = event["type"]
                t = event.get("timestamp", 0) / 1000
                if kind == "CHAMPION_KILL":
                    minute = int(t // 60) + 1
                    if minute <= 45:
                        kills_by_minute[minute] += 1
                    killer, victim = event.get("killerId", 0), event.get("victimId", 0)
                    if not fb_done:
                        first_bloods.append(t)
                        fb_done = True
                    if 1 <= killer <= 10 and not event.get("assistingParticipantIds"):
                        role = ROLES[(killer - 1) % 5]
                        solo_by_role[role] += 1
                        if 1 <= victim <= 10 and (victim - 1) % 5 == (killer - 1) % 5:
                            solo_lane_by_role[role] += 1
                elif kind == "CHAMPION_SPECIAL_KILL":
                    if event.get("killType") == "KILL_MULTI":
                        multis[event.get("multiKillLength", 2)] += 1
                    elif event.get("killType") == "KILL_ACE":
                        aces += 1
                elif kind == "BUILDING_KILL" and event.get("buildingType") == "TOWER_BUILDING" and not ft_done:
                    first_towers.append(t)
                    ft_done = True
                elif kind == "ELITE_MONSTER_KILL":
                    mtype = event.get("monsterType")
                    sub = event.get("monsterSubType")
                    key = {"DRAGON": "elder" if sub == "ELDER_DRAGON" else "dragon", "BARON_NASHOR": "baron",
                           "RIFTHERALD": "herald", "HORDE": "grubs", "ATAKHAN": "atakhan"}.get(mtype, mtype)
                    earliest[key] = min(earliest[key], t)
                    if key in last_kill and key != "grubs":
                        gaps[key].append(t - last_kill[key])
                    last_kill[key] = t
                    per_type[key] += 1
                    if key == "dragon":
                        dragon_types[sub] += 1
                elif kind == "DRAGON_SOUL_GIVEN" and event.get("teamId") in (100, 200):
                    # teamId 0 is the map announcing the soul type; 100/200 is a team actually taking the soul
                    soul_games += 1
                    soul_names[event.get("name")] += 1
        for key in ("dragon", "baron", "herald", "grubs", "atakhan", "elder"):
            kill_counts[key].append(per_type[key])
        grub_counts[per_type["grubs"]] += 1

    total_dragons = sum(dragon_types.values()) or 1
    measured = {
        "games": games,
        "earliestKill": {k: round(v) for k, v in sorted(earliest.items())},
        "minRespawnGap": {k: round(min(v)) for k, v in gaps.items() if v},
        "killsPerGame": {k: round(statistics.fmean(v), 2) for k, v in kill_counts.items()},
        "grubsTakenPerGame": dict(sorted(grub_counts.items())),
    }

    objectives = {}
    for key, rule in WEB_RULES["objectives"].items():
        entry = dict(rule)
        entry["earliestKill2026"] = round(earliest[key]) if earliest[key] < 10 ** 9 else None
        objectives[key] = entry
    out = {
        "source": "LCK 2026, Riot match-v5 timelines from Leaguepedia (502 games); timers from the League of Legends Wiki",
        "objectives": objectives,
        "camps": WEB_RULES["camps"],
        "patch26": WEB_RULES["patch26"],
        "gameLength": summary(lengths),
        "firstBlood": summary(first_bloods),
        "firstTower": summary(first_towers),
        "killsPerMin": [round(kills_by_minute[m] / minutes_alive[m], 3) if minutes_alive[m] else 0 for m in range(1, 46)],
        "killsPerMinNote": "index 0 = minute 1; mean champion kills (both teams) among games still running at that minute",
        "soloKillRate": {r: round(solo_by_role[r] / (2 * games), 3) for r in ROLES},
        "soloKillLane": {r: round(solo_lane_by_role[r] / (2 * games), 3) for r in ROLES},
        "soloKillNote": "per player per game: kills by that role with no assisting participant; soloKillLane counts only victims of the same role",
        "multikills": {name: round(multis[n] / games, 3) for n, name in ((2, "double"), (3, "triple"), (4, "quadra"), (5, "penta"))},
        "aceRate": round(aces / games, 3),
        "dragonTypes": {k: round(v / total_dragons, 3) for k, v in dragon_types.most_common()},
        "soulRate": round(soul_games / games, 3),
        "soulTypes": dict(soul_names.most_common()),
        "measured": measured,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    draft_path = ROOT / "data" / "draft_rules.json"
    if draft_path.exists():
        out["draft"] = json.loads(draft_path.read_text(encoding="utf-8"))
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ("gameLength", "firstBlood", "soloKillRate", "soloKillLane", "multikills",
                                          "aceRate", "soulRate", "dragonTypes")}, ensure_ascii=False))
    print(json.dumps(measured, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
