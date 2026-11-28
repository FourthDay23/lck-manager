"""Where and when LCK fights happen relative to epic monsters (benchmark for the engine's objective fights).

Reads the 502 LCK 2026 games (Riot match-v5 data + timeline, ../data/raw/*.json.gz). Run from the game folder:
    python -I scripts/lck_objfights.py [--raw <folder>] [--json out.json]
(a task worktree is checked out without data/: pass --raw <main folder>/data/raw)

scripts/objfight-diag.ts prints the same tables for the engine, with the same definitions:
  * fight: CHAMPION_KILLs chained like analyze_lck_macro.py (a kill within 15 s of the fight's last kill and within
    2,500 u of one of its kills joins it); size = killers + assisters + victims; phase by the first kill
    (early < 14:00, mid 14-25, late > 25). Fights without a kill are invisible here.
  * at a pit: the centroid of the fight's kills is within PIT_R (2,500 u) of the dragon / baron pit.
  * in play: an epic monster of that pit is up at the first kill, spawns within 60 s after it, or died within the 30 s
    before it. Spawn times are rebuilt from the kills (dragon 5:00 then kill + 5:00, elder soul + 6:00 then + 6:00,
    grubs 8:00, herald 15:00 until 19:45, baron 20:00 then kill + 6:00).
  * objective fight: at a pit with that pit's monster in play.
  * per epic kill: was there a fight at its pit from 60 s before to 30 s after the kill.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

GAME_ROOT = Path(__file__).resolve().parent.parent
DRAGON_PIT = (9866.0, 4414.0)
BARON_PIT = (5007.0, 10471.0)
PITS = {"dragon": DRAGON_PIT, "baron": BARON_PIT}
NEXUS = ((1550.0, 1650.0), (13250.0, 13250.0))
FIGHT_GAP = 15.0
FIGHT_RADIUS = 2500.0
PIT_R = 2500.0
RADII = (1500.0, 2500.0, 3500.0)
EARLY_END, MID_END = 14 * 60.0, 25 * 60.0
PRE, POST = 60.0, 30.0
NEAR_R = 3000.0
HERALD_GONE = 19 * 60 + 45.0
GRUBS_GONE = 14 * 60 + 45.0


def unwrap(p: dict) -> dict:
    return p.get("info", p)


def dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def phase_of(t: float) -> str:
    return "early" if t < EARLY_END else ("mid" if t <= MID_END else "late")


def place(c) -> str:
    if dist(c, DRAGON_PIT) <= PIT_R:
        return "dragon pit"
    if dist(c, BARON_PIT) <= PIT_R:
        return "baron pit"
    if min(dist(c, NEXUS[0]), dist(c, NEXUS[1])) <= 4500:
        return "base"
    if abs(c[0] - c[1]) <= 1300 * math.sqrt(2):
        return "mid lane"
    if c[0] < 2300 or c[1] > 12500:
        return "top lane"
    if c[1] < 2300 or c[0] > 12500:
        return "bot lane"
    return "river / jungle"


def cluster(kills: list[dict]) -> list[list[dict]]:
    fights: list[list[dict]] = []
    open_f: list[list[dict]] = []
    for k in sorted(kills, key=lambda e: e["t"]):
        open_f = [f for f in open_f if k["t"] - f[-1]["t"] <= FIGHT_GAP]
        best, bd = None, None
        for f in open_f:
            d = min(dist(k["pos"], o["pos"]) for o in f)
            if d <= FIGHT_RADIUS and (bd is None or d < bd):
                best, bd = f, d
        if best is None:
            best = []
            fights.append(best)
            open_f.append(best)
        best.append(k)
    return fights


def game_rows(path: Path) -> dict | None:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        raw = json.load(fh)
    info = unwrap(raw["data"])
    frames = unwrap(raw["timeline"])["frames"]
    side_of = {p["participantId"]: (0 if p["teamId"] == 100 else 1) for p in info["participants"]}
    dur = info["gameDuration"] / (1000 if info["gameDuration"] > 20_000 else 1)
    events = sorted((e for f in frames for e in f.get("events", [])), key=lambda e: e.get("timestamp", 0))
    kills: list[dict] = []
    # windows: (pit, objective, spawn, gone, taken: bool)
    win: list[dict] = []

    def near_pit(t: float, pit: str, side: int | None) -> tuple[int, int] | None:
        """(taker side, other side) champions alive within NEAR_R of the pit at the last 1-min frame before t."""
        if side is None:
            return None
        i = min(int(t // 60), len(frames) - 1)
        while i > 0 and frames[i]["timestamp"] / 1000 > t:
            i -= 1
        n = [0, 0]
        for pid_text, pf in frames[i]["participantFrames"].items():
            pid = int(pid_text)
            pos = pf.get("position")
            if pid not in side_of or not pos or pf.get("championStats", {}).get("health", 1) <= 0:
                continue
            if dist((pos["x"], pos["y"]), PITS[pit]) <= NEAR_R:
                n[side_of[pid]] += 1
        return (n[side], n[1 - side])
    stacks = [0, 0]
    dragon_spawn: float | None = 300.0
    elder_spawn: float | None = None
    baron_spawn = 1200.0
    grub_kills: list[float] = []
    herald_kill: float | None = None
    herald_near = None
    for e in events:
        et = e.get("type")
        t = e.get("timestamp", 0) / 1000
        if et == "CHAMPION_KILL":
            v = e.get("victimId", 0)
            if v not in side_of or "position" not in e:
                continue
            parts = {v}
            if e.get("killerId", 0) in side_of:
                parts.add(e["killerId"])
            parts.update(a for a in e.get("assistingParticipantIds", []) if a in side_of)
            kills.append({"t": t, "pos": (e["position"]["x"], e["position"]["y"]), "parts": parts, "side": 1 - side_of[v]})
        elif et == "ELITE_MONSTER_KILL":
            mt = e.get("monsterType")
            side = {100: 0, 200: 1}.get(e.get("killerTeamId"))
            if mt == "DRAGON":
                if e.get("monsterSubType") == "ELDER_DRAGON":
                    win.append({"pit": "dragon", "obj": "elder", "spawn": elder_spawn if elder_spawn is not None else t - 60, "gone": t, "taken": True, "near": near_pit(t, "dragon", side)})
                    elder_spawn = t + 360
                else:
                    win.append({"pit": "dragon", "obj": "dragon", "spawn": dragon_spawn if dragon_spawn is not None else t - 60, "gone": t, "taken": True, "near": near_pit(t, "dragon", side)})
                    if side is not None:
                        stacks[side] += 1
                    if side is not None and stacks[side] >= 4:
                        dragon_spawn = None
                        elder_spawn = t + 360
                    else:
                        dragon_spawn = t + 300
            elif mt == "BARON_NASHOR":
                win.append({"pit": "baron", "obj": "baron", "spawn": baron_spawn, "gone": t, "taken": True, "near": near_pit(t, "baron", side)})
                baron_spawn = t + 360
            elif mt == "RIFTHERALD":
                if side is not None:
                    herald_kill = t
                    herald_near = near_pit(t, "baron", side)
            elif mt == "HORDE":
                grub_kills.append(t)
    # monsters still up when the game ended (or that left on their own)
    if dragon_spawn is not None and dragon_spawn - PRE < dur:
        win.append({"pit": "dragon", "obj": "dragon", "spawn": dragon_spawn, "gone": dur, "taken": False})
    if elder_spawn is not None and elder_spawn - PRE < dur:
        win.append({"pit": "dragon", "obj": "elder", "spawn": elder_spawn, "gone": dur, "taken": False})
    if baron_spawn - PRE < dur:
        win.append({"pit": "baron", "obj": "baron", "spawn": baron_spawn, "gone": dur, "taken": False})
    if dur > 480 - PRE:
        gone = max(grub_kills) if len(grub_kills) >= 3 else min(dur, GRUBS_GONE)
        win.append({"pit": "baron", "obj": "grubs", "spawn": 480.0, "gone": gone, "taken": bool(grub_kills)})
    if dur > 900 - PRE:
        win.append({"pit": "baron", "obj": "herald", "spawn": 900.0, "gone": herald_kill if herald_kill is not None else min(dur, HERALD_GONE), "taken": herald_kill is not None, "near": herald_near})

    fights = []
    for f in cluster(kills):
        parts: set[int] = set()
        for k in f:
            parts |= k["parts"]
        c = (sum(k["pos"][0] for k in f) / len(f), sum(k["pos"][1] for k in f) / len(f))
        t0 = f[0]["t"]
        near = {r: next((pk for pk, pp in PITS.items() if dist(c, pp) <= r), None) for r in RADII}
        pit = near[PIT_R]
        obj = None
        if pit:
            for w in win:
                if w["pit"] == pit and w["spawn"] - PRE <= t0 <= w["gone"] + POST:
                    obj = w["obj"]
                    break
        fights.append({
            "t": t0, "end": f[-1]["t"], "size": min(10, len(parts)), "kills": len(f), "c": c, "near": near, "obj": obj,
            "spawn60": any(abs(t0 - w["spawn"]) <= 60 for w in win),
            "kill60": any(w["taken"] and -60 <= t0 - w["gone"] <= 60 for w in win),
            "place": place(c), "both": len({k["side"] for k in f}) == 2,
        })
    return {"dur": dur, "fights": fights, "win": win}


SIZES = (("all", 1), ("4+", 4), ("6+", 6))
PHASES = ("early", "mid", "late", "all")


def report(games: list[dict], label: str) -> dict:
    n = len(games)
    out: dict = {"games": n, "label": label}
    print(f"== {label}: {n} games, median length {sorted(g['dur'] for g in games)[n // 2] / 60:.1f} min ==")
    print("fights by size and phase: per game | at a pit (2,500 u) | objective fight (pit + monster in play) | +-60 s of a spawn | +-60 s of an epic kill")
    table = {}
    for sname, smin in SIZES:
        for ph in PHASES:
            fs = [f for g in games for f in g["fights"] if f["size"] >= smin and (ph == "all" or phase_of(f["t"]) == ph)]
            if not fs:
                continue
            m = len(fs)
            row = {
                "perGame": m / n,
                "atPit": sum(1 for f in fs if f["near"][PIT_R]) / m,
                "objFight": sum(1 for f in fs if f["obj"]) / m,
                "spawn60": sum(1 for f in fs if f["spawn60"]) / m,
                "kill60": sum(1 for f in fs if f["kill60"]) / m,
                "pit1500": sum(1 for f in fs if f["near"][1500.0]) / m,
                "pit3500": sum(1 for f in fs if f["near"][3500.0]) / m,
                "kills": sum(f["kills"] for f in fs) / m,
            }
            table[f"{sname}:{ph}"] = row
            print(f"  {sname:>3} {ph:<5} {row['perGame']:5.2f} | pit {row['atPit'] * 100:4.1f}% (1,500 u {row['pit1500'] * 100:4.1f}, 3,500 u {row['pit3500'] * 100:4.1f}) | objective {row['objFight'] * 100:4.1f}% | spawn {row['spawn60'] * 100:4.1f}% | epic kill {row['kill60'] * 100:4.1f}% | kills/fight {row['kills']:.2f}")
    out["fights"] = table
    print("where fights of 6+ happen (share by phase):")
    places = ["dragon pit", "baron pit", "mid lane", "top lane", "bot lane", "river / jungle", "base"]
    loc = {}
    for ph in PHASES:
        fs = [f for g in games for f in g["fights"] if f["size"] >= 6 and (ph == "all" or phase_of(f["t"]) == ph)]
        if not fs:
            continue
        c = Counter(f["place"] for f in fs)
        loc[ph] = {p: c[p] / len(fs) for p in places}
        print(f"  {ph:<5} " + " | ".join(f"{p} {c[p] / len(fs) * 100:4.1f}%" for p in places))
    out["places6"] = loc
    print("which monster the objective fights (4+) are about, per game:")
    c = Counter(f["obj"] for g in games for f in g["fights"] if f["size"] >= 4 and f["obj"])
    out["objFightsBy"] = {k: v / n for k, v in c.items()}
    print("  " + " | ".join(f"{k} {v / n:.2f}" for k, v in sorted(c.items(), key=lambda kv: -kv[1])))
    print("per epic kill: a fight at its pit from 60 s before to 30 s after (any kill | 4+ fight | 6+ fight | kills in it):")
    per = {}
    for obj in ("dragon", "elder", "baron", "herald", "grubs"):
        tot = anyk = f4 = f6 = kills = 0
        for g in games:
            for w in g["win"]:
                if w["obj"] != obj or not w["taken"]:
                    continue
                tot += 1
                near = [f for f in g["fights"] if f["near"][PIT_R] == w["pit"] and w["gone"] - 60 <= f["t"] <= w["gone"] + 30]
                # a long fight that began earlier and was still going
                near += [f for f in g["fights"] if f["near"][PIT_R] == w["pit"] and f["t"] < w["gone"] - 60 <= f["end"]]
                if near:
                    anyk += 1
                    kills += sum(f["kills"] for f in near)
                if any(f["size"] >= 4 for f in near):
                    f4 += 1
                if any(f["size"] >= 6 for f in near):
                    f6 += 1
        if tot:
            per[obj] = {"perGame": tot / n, "anyKill": anyk / tot, "fight4": f4 / tot, "fight6": f6 / tot, "kills": kills / tot}
            print(f"  {obj:<7} {tot / n:4.2f}/game | {anyk / tot * 100:4.1f}% | {f4 / tot * 100:4.1f}% | {f6 / tot * 100:4.1f}% | {kills / tot:.2f}")
    out["perEpic"] = per
    print(f"champions within {NEAR_R:.0f} u of the pit at the 1-min frame before the kill (taker mean | other mean | other 0 | other 1-2 | other 3+):")
    att = {}
    for obj in ("dragon", "elder", "baron", "herald"):
        rows = [w["near"] for g in games for w in g["win"] if w["obj"] == obj and w["taken"] and w.get("near")]
        if not rows:
            continue
        m = len(rows)
        a = {
            "taker": sum(r[0] for r in rows) / m, "other": sum(r[1] for r in rows) / m,
            "other0": sum(1 for r in rows if r[1] == 0) / m, "other12": sum(1 for r in rows if 1 <= r[1] <= 2) / m,
            "other3": sum(1 for r in rows if r[1] >= 3) / m,
        }
        att[obj] = a
        print(f"  {obj:<7} {a['taker']:.2f} | {a['other']:.2f} | {a['other0'] * 100:4.1f}% | {a['other12'] * 100:4.1f}% | {a['other3'] * 100:4.1f}%")
    out["attendance"] = att
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(GAME_ROOT.parent / "data" / "raw"))
    ap.add_argument("--json")
    a = ap.parse_args()
    files = sorted(Path(a.raw).glob("*.json.gz"))
    if not files:
        raise SystemExit(f"no raw games under {a.raw} (pass --raw <main folder>/data/raw)")
    games = [g for g in (game_rows(p) for p in files) if g]
    out = report(games, "LCK 2026")
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
