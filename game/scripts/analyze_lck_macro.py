"""Extract pro-play macro benchmarks from the 502 LCK 2026 games for the LoLSim team AI.

Reads  ../data/games_lck_2026.json  (index: teams per side, roster roles, winner)
       ../data/raw/*.json.gz        (Riot match-v5 `data` + `timeline`, frames every 60 s)
       public/data/teams.json       (team ids used by the game)
       public/data/heatmap.json     (grid layout only: origin, bin size, shape, mirror constant)
Writes src/match/lck-stats.gen.ts   (LCK_STATS, typed LckStats)

Run from the game folder:
    python -I scripts/analyze_lck_macro.py [--dump extra.json]

Definitions (also repeated in the generated file header):
  * Roles come from the Leaguepedia roster (side + champion); participant order is the fallback.
    Riot's teamPosition / individualPosition are junk in tournament games.
  * Objectives: participants = killer + assists that belong to the taking team (killerTeamId).
    Riot also lists enemies that damaged the monster in assistingParticipantIds; those are dropped
    (and counted as "contested"). Elder = DRAGON with monsterSubType ELDER_DRAGON, kept out of "dragon".
  * Fights: CHAMPION_KILL events chained when a kill is <= 15 s after the cluster's last kill and
    <= 2,500 u from any kill already in it. Participants = killers + assists + victims (distinct).
    Phase by the fight's first kill: early < 14:00, mid 14:00-25:00, late > 25:00.
  * Alive heuristic: championStats.health <= 0 means dead (the frame keeps the death position).
    "In base" = within 1,600 u of the own fountain (fitted from frame 0). Team shape uses only
    full-strength team-frames: all five alive and out of base.
  * Grids follow heatmap.json: [ix][iy], 500 u cells, origin (-120, -120), blue-side view;
    red players mirrored with (x, y) -> (c - y, c - x), c = 14764.1. Zones count alive players
    outside their base only (heatmap.json kept base samples).
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

GAME_ROOT = Path(__file__).resolve().parent.parent
LOLSIM_ROOT = GAME_ROOT.parent
INDEX = LOLSIM_ROOT / "data" / "games_lck_2026.json"
TEAMS = GAME_ROOT / "public" / "data" / "teams.json"
HEATMAP = GAME_ROOT / "public" / "data" / "heatmap.json"
OUT = GAME_ROOT / "src" / "match" / "lck-stats.gen.ts"

ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
CHAMPION_ALIASES = {"wukong": "monkeyking", "nunuwillump": "nunu", "renataglasc": "renata"}
TEAM_NAME_ALIASES = {"DRX": "KRX", "BRION": "BRO"}          # older names in the index -> teams.json id
EXTRA_PREFIXES = {"KRX": {"DRX"}}                          # riotIdGameName prefixes seen per team id

EARLY_END = 14 * 60_000
MID_END = 25 * 60_000
FIGHT_GAP_MS = 15_000
FIGHT_RADIUS = 2_500
BASE_RADIUS = 1_600
SIDE_LANER_DIST = 4_000
GROUPED_DIST = 2_500
SHAPE_MINUTES = range(15, 41)
STYLE_MINUTES = range(20, 36)
ZONE_GOLD_MINUTES = range(20, 31)
GOLD_SWING = 2_000
KPM_MINUTES = 45
BIG_FIGHT = 6
OBJECTIVES = ["dragon", "baron", "herald", "grubs", "elder"]
STRATEGIES = ["balanced", "teamfight", "split", "early", "objective", "scaling"]
SUGGEST_MIN_SCORE = 0.75     # best style score (z units) needed to suggest something other than balanced
SCALING_MIN_LATE = 0.5       # z of (long-game win delta or avg duration) needed before "scaling" is allowed
STYLE_TOP_N = 3              # strategy targets = mean of the N teams scoring highest on that style


def champion_key(name: str) -> str:
    key = re.sub(r"[^a-z]", "", name.lower())
    return CHAMPION_ALIASES.get(key, key)


def unwrap(payload: dict) -> dict:
    return payload.get("info", payload)


def dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def quantile(values: list[float], q: float) -> float:
    """Linear-interpolated quantile (same as numpy's default)."""
    s = sorted(values)
    if not s:
        return float("nan")
    pos = (len(s) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def r3(x: float) -> float:
    return round(float(x), 3)


class Layout:
    def __init__(self) -> None:
        self.origin = (-120.0, -120.0)
        self.bin = 500
        self.shape = (30, 31)
        self.mirror_c = 14764.1
        if HEATMAP.exists():
            with HEATMAP.open(encoding="utf-8") as fh:
                h = json.load(fh)
            self.origin = (float(h["origin"][0]), float(h["origin"][1]))
            self.bin = int(h["bin_size"])
            self.shape = (int(h["shape"][0]), int(h["shape"][1]))
            self.mirror_c = float(h["mirror_c"])

    def own_side(self, x: float, y: float, side: int) -> tuple[float, float]:
        return (x, y) if side == 1 else (self.mirror_c - y, self.mirror_c - x)

    def empty(self) -> list[list[int]]:
        return [[0] * self.shape[1] for _ in range(self.shape[0])]

    def add(self, grid: list[list[int]], x: float, y: float, side: int) -> None:
        x, y = self.own_side(x, y, side)
        ix = int((x - self.origin[0]) // self.bin)
        iy = int((y - self.origin[1]) // self.bin)
        if 0 <= ix < self.shape[0] and 0 <= iy < self.shape[1]:
            grid[ix][iy] += 1


def load_teams() -> dict[str, dict]:
    with TEAMS.open(encoding="utf-8") as fh:
        raw = json.load(fh)
    items = raw if isinstance(raw, list) else raw.get("teams", raw)
    if isinstance(items, dict):
        items = list(items.values())
    return {t["id"]: t for t in items}


def team_id_for(name: str, by_name: dict[str, str]) -> str | None:
    if name in TEAM_NAME_ALIASES:
        return TEAM_NAME_ALIASES[name]
    return by_name.get(name)


class Acc:
    """Everything accumulated over all games."""

    def __init__(self, layout: Layout) -> None:
        self.layout = layout
        self.games = 0
        self.stats = Counter()
        # objectives
        self.obj_n = Counter()
        self.obj_parts = {k: Counter() for k in OBJECTIVES + ["atakhan"]}
        self.obj_solo = {k: Counter() for k in OBJECTIVES + ["atakhan"]}
        self.obj_first: dict[str, list[float]] = defaultdict(list)
        self.obj_contested = Counter()
        self.obj_unattributed = Counter()
        # fights
        self.fight_sizes = Counter()
        self.phase_fights = Counter()
        self.phase_size_sum = Counter()
        self.phase_games = Counter()            # games that reached the phase
        self.phase_minutes = Counter()          # game-minutes spent in the phase (for per-minute rates)
        self.fight_kills = Counter()            # total kills in fights per phase
        self.fight_traded = Counter()           # fights where both sides scored, per phase
        self.kills_by_minute = [0] * KPM_MINUTES
        self.games_alive_minute = [0] * KPM_MINUTES
        self.kills_total = 0
        self.kills_solo = 0
        self.kills_executed = 0
        # shape
        self.shape_rows: dict[int, list[tuple[float, float, int, int]]] = defaultdict(list)
        self.shape_frames_total = Counter()
        self.game_split: list[float] = []      # per team-game side-laner share (style window)
        self.game_group: list[float] = []
        # teams
        self.team = defaultdict(lambda: Counter())
        self.team_durations: dict[str, list[float]] = defaultdict(list)
        self.team_results: dict[str, list[tuple[float, bool]]] = defaultdict(list)
        self.prefixes: dict[str, Counter] = defaultdict(Counter)
        self.unmatched_names = Counter()
        self.durations: list[float] = []
        # zones
        self.zones = {z: {r: layout.empty() for r in ROLES}
                      for z in ["dragonTake", "dragonGive", "baronTake", "baronGive", "ahead", "behind"]}
        self.zone_events = Counter()


def assign_roles(info: dict, roster: list[dict], stats: Counter) -> dict[int, tuple[int, str]]:
    by_side_champion = {(row["side"], champion_key(row["champion"])): row["role"] for row in roster}
    out = {}
    for p in info["participants"]:
        pid = p["participantId"]
        side = 1 if p["teamId"] == 100 else 2
        order_role = ROLES[(pid - 1) % 5]
        role = by_side_champion.get((side, champion_key(p["championName"])))
        if role not in ROLES:
            stats["role_fallback_to_order"] += 1
            role = order_role
        elif role != order_role:
            stats["role_differs_from_order"] += 1
        else:
            stats["role_matches_order"] += 1
        out[pid] = (side, role)
    return out


def frame_before(frames: list[dict], ts: float) -> dict | None:
    """Last 60 s frame at or before ts."""
    i = min(int(ts // 60_000), len(frames) - 1)
    while i > 0 and frames[i]["timestamp"] > ts:
        i -= 1
    return frames[i] if frames else None


def fountains(index_games: list[dict]) -> dict[int, tuple[float, float]]:
    pts = {1: [], 2: []}
    for g in index_games[:60]:
        with gzip.open(LOLSIM_ROOT / g["raw"], "rt", encoding="utf-8") as fh:
            r = json.load(fh)
        info = unwrap(r["data"])
        side_of = {p["participantId"]: (1 if p["teamId"] == 100 else 2) for p in info["participants"]}
        for pid_text, pf in unwrap(r["timeline"])["frames"][0]["participantFrames"].items():
            pts[side_of[int(pid_text)]].append((pf["position"]["x"], pf["position"]["y"]))
    return {s: (statistics.fmean(p[0] for p in v), statistics.fmean(p[1] for p in v)) for s, v in pts.items()}


def cluster_fights(kills: list[dict]) -> list[list[dict]]:
    fights: list[list[dict]] = []
    open_fights: list[list[dict]] = []
    for k in sorted(kills, key=lambda e: e["ts"]):
        open_fights = [f for f in open_fights if k["ts"] - f[-1]["ts"] <= FIGHT_GAP_MS]
        best, best_d = None, None
        for f in open_fights:
            d = min(dist(k["pos"], o["pos"]) for o in f)
            if d <= FIGHT_RADIUS and (best_d is None or d < best_d):
                best, best_d = f, d
        if best is None:
            best = []
            fights.append(best)
            open_fights.append(best)
        best.append(k)
    return fights


def process_game(entry: dict, acc: Acc, team_by_name: dict[str, str], fountain: dict) -> None:
    with gzip.open(LOLSIM_ROOT / entry["raw"], "rt", encoding="utf-8") as fh:
        raw = json.load(fh)
    info = unwrap(raw["data"])
    frames = unwrap(raw["timeline"])["frames"]
    roles = assign_roles(info, entry["roster"], acc.stats)
    side_of = {pid: s for pid, (s, _) in roles.items()}
    role_of = {pid: r for pid, (_, r) in roles.items()}
    pids = {1: [p for p in roles if side_of[p] == 1], 2: [p for p in roles if side_of[p] == 2]}
    duration_s = info["gameDuration"] / (1000 if info["gameDuration"] > 20_000 else 1)
    duration_ms = duration_s * 1000
    acc.games += 1
    acc.durations.append(duration_s)

    team_of_side = {}
    for side, key in ((1, "blue"), (2, "red")):
        tid = team_id_for(entry[key], team_by_name)
        if tid is None:
            acc.unmatched_names[entry[key]] += 1
        team_of_side[side] = tid
    for p in info["participants"]:
        tid = team_of_side[side_of[p["participantId"]]]
        name = p.get("riotIdGameName") or p.get("summonerName") or ""
        if tid and name:
            acc.prefixes[tid][name.split(" ")[0]] += 1
    winner_side = entry.get("winner_side")
    if winner_side not in (1, 2):
        winner_side = 1 if any(t["win"] for t in info["teams"] if t["teamId"] == 100) else 2
    for side in (1, 2):
        tid = team_of_side[side]
        if tid:
            acc.team[tid]["games"] += 1
            acc.team[tid]["wins"] += int(side == winner_side)
            acc.team_durations[tid].append(duration_s)
            acc.team_results[tid].append((duration_s, side == winner_side))

    for phase, start in (("early", 0), ("mid", EARLY_END), ("late", MID_END)):
        end = {"early": EARLY_END, "mid": MID_END, "late": math.inf}[phase]
        if duration_ms > start:
            acc.phase_games[phase] += 1
            acc.phase_minutes[phase] += (min(duration_ms, end) - start) / 60_000
    for m in range(KPM_MINUTES):
        if duration_s > m * 60:
            acc.games_alive_minute[m] += 1

    # ---- events -------------------------------------------------------------------------
    kills: list[dict] = []
    first_take: dict[str, float] = {}
    game_obj = Counter()                    # (objective, side) -> takes in this game
    for fr in frames:
        for e in fr.get("events", []):
            et = e.get("type")
            ts = e.get("timestamp", 0)
            if et == "CHAMPION_KILL":
                victim = e.get("victimId", 0)
                if victim not in side_of:
                    continue
                killer = e.get("killerId", 0)
                assists = [a for a in e.get("assistingParticipantIds", []) or [] if a in side_of]
                pos = (e.get("position", {}).get("x", 0), e.get("position", {}).get("y", 0))
                kills.append({"ts": ts, "pos": pos, "killer": killer, "victim": victim, "assists": assists})
                acc.kills_total += 1
                m = int(ts // 60_000)
                if m < KPM_MINUTES:
                    acc.kills_by_minute[m] += 1
                if killer in side_of and not assists:
                    acc.kills_solo += 1
                if killer not in side_of:
                    acc.kills_executed += 1
                if ts < EARLY_END and killer in side_of and side_of[killer] != side_of[victim]:
                    tid = team_of_side[side_of[killer]]
                    if tid:
                        acc.team[tid]["early_kills"] += 1
            elif et == "TURRET_PLATE_DESTROYED" and ts < EARLY_END:
                owner = 1 if e.get("teamId") == 100 else 2
                tid = team_of_side[3 - owner]
                if tid:
                    acc.team[tid]["early_plates"] += 1
            elif et == "BUILDING_KILL" and e.get("buildingType") == "TOWER_BUILDING" and ts < EARLY_END:
                owner = 1 if e.get("teamId") == 100 else 2
                tid = team_of_side[3 - owner]
                if tid:
                    acc.team[tid]["early_towers"] += 1
            elif et == "ELITE_MONSTER_KILL":
                mt = e.get("monsterType")
                key = {"DRAGON": "dragon", "BARON_NASHOR": "baron", "RIFTHERALD": "herald",
                       "HORDE": "grubs", "ATAKHAN": "atakhan"}.get(mt)
                if key is None:
                    acc.stats[f"unknown_monster_{mt}"] += 1
                    continue
                if key == "dragon" and e.get("monsterSubType") == "ELDER_DRAGON":
                    key = "elder"
                team_side = {100: 1, 200: 2}.get(e.get("killerTeamId"))
                killer = e.get("killerId", 0)
                if team_side is None and killer in side_of:
                    team_side = side_of[killer]
                if team_side is None:
                    # killerTeamId 300 + killerId 0: grubs/herald that despawned untaken. Not a take.
                    acc.stats[f"despawned_{key}"] += 1
                    continue
                assists = e.get("assistingParticipantIds", []) or []
                parts = {a for a in assists if side_of.get(a) == team_side}
                if side_of.get(killer) == team_side:
                    parts.add(killer)
                if any(side_of.get(a) == 3 - team_side for a in assists):
                    acc.obj_contested[key] += 1
                acc.obj_n[key] += 1
                if parts:
                    acc.obj_parts[key][len(parts)] += 1
                    if len(parts) == 1:
                        acc.obj_solo[key][role_of[next(iter(parts))]] += 1
                else:
                    acc.obj_unattributed[key] += 1
                if key not in first_take or ts < first_take[key]:
                    first_take[key] = ts
                game_obj[(key, team_side)] += 1
                if key in ("dragon", "baron"):
                    fr_before = frame_before(frames, ts)
                    if fr_before is not None:
                        acc.zone_events[key] += 1
                        for pid_text, pf in fr_before["participantFrames"].items():
                            pid = int(pid_text)
                            if pid not in side_of or pf.get("championStats", {}).get("health", 1) <= 0:
                                continue
                            pos = (pf["position"]["x"], pf["position"]["y"])
                            if dist(pos, fountain[side_of[pid]]) < BASE_RADIUS:
                                acc.stats["zone_skipped_in_base"] += 1
                                continue
                            zone = f"{key}{'Take' if side_of[pid] == team_side else 'Give'}"
                            acc.layout.add(acc.zones[zone][role_of[pid]], pos[0], pos[1], side_of[pid])
    for key, ts in first_take.items():
        acc.obj_first[key].append(ts / 1000)
    for side in (1, 2):
        tid = team_of_side[side]
        if not tid:
            continue
        for key in ("dragon", "grubs", "herald", "baron", "elder"):
            mine, theirs = game_obj[(key, side)], game_obj[(key, 3 - side)]
            acc.team[tid][f"obj_{key}_mine"] += mine
            acc.team[tid][f"obj_{key}_all"] += mine + theirs

    # ---- fights -------------------------------------------------------------------------
    big_fights = 0
    for f in cluster_fights(kills):
        parts = set()
        side_kills = Counter()
        for k in f:
            parts.add(k["victim"])
            parts.update(k["assists"])
            if k["killer"] in side_of:
                parts.add(k["killer"])
            side_kills[3 - side_of[k["victim"]]] += 1
        size = min(len(parts), 10)
        start = f[0]["ts"]
        phase = "early" if start < EARLY_END else ("mid" if start <= MID_END else "late")
        acc.fight_sizes[size] += 1
        acc.phase_fights[phase] += 1
        acc.phase_size_sum[phase] += size
        acc.fight_kills[phase] += len(f)
        if side_kills[1] and side_kills[2]:
            acc.fight_traded[phase] += 1
        if size >= BIG_FIGHT:
            big_fights += 1
    for side in (1, 2):
        tid = team_of_side[side]
        if tid:
            acc.team[tid]["big_fights"] += big_fights

    # ---- frames: team shape and gold-state zones -------------------------------------------
    for m, fr in enumerate(frames):
        pfs = fr["participantFrames"]
        if m in SHAPE_MINUTES or m in ZONE_GOLD_MINUTES:
            gold = {s: sum(pfs[str(p)].get("totalGold", 0) for p in pids[s]) for s in (1, 2)}
        for side in (1, 2):
            tid = team_of_side[side]
            members = []
            alive_all = True
            for p in pids[side]:
                pf = pfs[str(p)]
                pos = (pf["position"]["x"], pf["position"]["y"])
                alive = pf.get("championStats", {}).get("health", 1) > 0
                in_base = dist(pos, fountain[side]) < BASE_RADIUS
                if not alive or in_base:
                    alive_all = False
                members.append((p, pos, alive and not in_base))
            if m in ZONE_GOLD_MINUTES:
                lead = gold[side] - gold[3 - side]
                zone = "ahead" if lead >= GOLD_SWING else ("behind" if lead <= -GOLD_SWING else None)
                if zone:
                    acc.zone_events[zone] += 1
                    for p, pos, usable in members:
                        if usable:
                            acc.layout.add(acc.zones[zone][role_of[p]], pos[0], pos[1], side)
                        else:
                            acc.stats["zone_skipped_dead_or_base"] += 1
            if m not in SHAPE_MINUTES:
                continue
            acc.shape_frames_total[m] += 1
            if tid:
                acc.team[tid]["style_frames_total"] += int(m in STYLE_MINUTES)
            if not alive_all:
                continue
            pts = [pos for _, pos, _ in members]
            cx = statistics.fmean(p[0] for p in pts)
            cy = statistics.fmean(p[1] for p in pts)
            d = [dist(p, (cx, cy)) for p in pts]
            side_laner = 0
            for i, p in enumerate(pts):
                others = [q for j, q in enumerate(pts) if j != i]
                ox = statistics.fmean(q[0] for q in others)
                oy = statistics.fmean(q[1] for q in others)
                if dist(p, (ox, oy)) > SIDE_LANER_DIST:
                    side_laner = 1
                    break
            grouped = int(max(d) <= GROUPED_DIST)
            acc.shape_rows[m].append((max(d), statistics.median(d), side_laner, grouped))
            if m in STYLE_MINUTES:
                key = f"g{acc.games}s{side}"
                acc.team["__game__"][key + "_n"] += 1
                acc.team["__game__"][key + "_split"] += side_laner
                acc.team["__game__"][key + "_group"] += grouped
                if tid:
                    acc.team[tid]["style_frames"] += 1
                    acc.team[tid]["style_split"] += side_laner
                    acc.team[tid]["style_group"] += grouped


def zscores(values: dict[str, float]) -> dict[str, float]:
    vals = list(values.values())
    mu = statistics.fmean(vals)
    sd = statistics.pstdev(vals) or 1.0
    return {k: (v - mu) / sd for k, v in values.items()}


def build(acc: Acc, teams: dict[str, dict]) -> tuple[dict, dict]:
    extra: dict = {"stats": dict(acc.stats)}
    # ---- objectives
    objectives = {}
    for key in OBJECTIVES:
        parts = acc.obj_parts[key]
        total = sum(parts.values())
        entry = {
            "n": acc.obj_n[key],
            "participants": [r3(parts[i] / total) if total else 0 for i in range(1, 6)],
            "soloByRole": {r: acc.obj_solo[key][r] for r in ROLES},
        }
        if acc.obj_first[key]:
            entry["firstAt"] = int(round(statistics.median(acc.obj_first[key])))
        objectives[key] = entry
    extra["objectives"] = {
        k: {"contested": acc.obj_contested[k], "unattributed": acc.obj_unattributed[k],
            "gamesWithTake": len(acc.obj_first[k]), "n": acc.obj_n[k],
            "participantCounts": dict(acc.obj_parts[k])}
        for k in OBJECTIVES + ["atakhan"]
    }

    # ---- fights
    n_fights = sum(acc.fight_sizes.values())
    by_phase = {}
    for phase in ("early", "mid", "late"):
        nf = acc.phase_fights[phase]
        by_phase[phase] = {
            "fights": nf,
            "avgSize": r3(acc.phase_size_sum[phase] / nf) if nf else 0,
            "perGame": r3(nf / acc.games),
        }
    extra["fights"] = {
        "total": n_fights,
        "perPhase": {p: {"gamesReached": acc.phase_games[p],
                         "perGameReached": r3(acc.phase_fights[p] / max(acc.phase_games[p], 1)),
                         "perMinute": r3(acc.phase_fights[p] / max(acc.phase_minutes[p], 1)),
                         "killsPerFight": r3(acc.fight_kills[p] / max(acc.phase_fights[p], 1)),
                         "tradedShare": r3(acc.fight_traded[p] / max(acc.phase_fights[p], 1))}
                     for p in ("early", "mid", "late")},
        "kills": acc.kills_total, "solo": acc.kills_solo, "executed": acc.kills_executed,
        "gamesAliveByMinute": acc.games_alive_minute,
    }
    fights = {
        "sizeShare": [r3(acc.fight_sizes[i] / n_fights) for i in range(1, 11)],
        "byPhase": by_phase,
        "killsPerMin": [r3(acc.kills_by_minute[m] / acc.games_alive_minute[m]) if acc.games_alive_minute[m] else 0
                        for m in range(KPM_MINUTES)],
        "soloKillShare": r3(acc.kills_solo / acc.kills_total),
    }

    # ---- shape
    shape = []
    extra["shapeSamples"] = {}
    for m in SHAPE_MINUTES:
        rows = acc.shape_rows[m]
        if not rows:
            continue
        shape.append({
            "minute": m,
            "farthest": int(round(statistics.median(r[0] for r in rows))),
            "median": int(round(statistics.median(r[1] for r in rows))),
            "sideLaner": r3(statistics.fmean(r[2] for r in rows)),
            "grouped": r3(statistics.fmean(r[3] for r in rows)),
        })
        extra["shapeSamples"][m] = {"full": len(rows), "all": acc.shape_frames_total[m]}

    # per team-game style distribution (how far a single game can swing)
    gg = acc.team["__game__"]
    g_split, g_group = [], []
    for k, v in gg.items():
        if k.endswith("_n") and v >= 5:
            base = k[:-2]
            g_split.append(gg[base + "_split"] / v)
            g_group.append(gg[base + "_group"] / v)
    extra["teamGame"] = {
        "n": len(g_split),
        "split": {q: r3(quantile(g_split, q)) for q in (0.1, 0.25, 0.5, 0.75, 0.9)},
        "group": {q: r3(quantile(g_group, q)) for q in (0.1, 0.25, 0.5, 0.75, 0.9)},
    }

    # ---- team styles
    league_median_dur = statistics.median(acc.durations)
    raw: dict[str, dict] = {}
    for tid, c in acc.team.items():
        if tid == "__game__" or c["games"] == 0:
            continue
        g = c["games"]
        shares = [c[f"obj_{k}_mine"] / c[f"obj_{k}_all"] for k in ("dragon", "grubs", "herald") if c[f"obj_{k}_all"]]
        res = acc.team_results[tid]
        long_games = [w for d, w in res if d >= league_median_dur]
        short_games = [w for d, w in res if d < league_median_dur]
        raw[tid] = {
            "games": g,
            "winRate": c["wins"] / g,
            "split": c["style_split"] / max(c["style_frames"], 1),
            "group": c["style_group"] / max(c["style_frames"], 1),
            "early": (c["early_kills"] + c["early_plates"] + c["early_towers"]) / g,
            "earlyKills": c["early_kills"] / g,
            "earlyPlates": c["early_plates"] / g,
            "earlyTowers": c["early_towers"] / g,
            "objective": statistics.fmean(shares) if shares else 0.5,
            "dragonShare": c["obj_dragon_mine"] / max(c["obj_dragon_all"], 1),
            "grubShare": c["obj_grubs_mine"] / max(c["obj_grubs_all"], 1),
            "heraldShare": c["obj_herald_mine"] / max(c["obj_herald_all"], 1),
            "baronShare": c["obj_baron_mine"] / max(c["obj_baron_all"], 1),
            "fight": c["big_fights"] / g,
            "avgDuration": statistics.fmean(acc.team_durations[tid]),
            "longWin": statistics.fmean(long_games) if long_games else 0.5,
            "shortWin": statistics.fmean(short_games) if short_games else 0.5,
            "longGames": len(long_games),
            "fullStrengthShare": c["style_frames"] / max(c["style_frames_total"], 1),
        }
        raw[tid]["lateDelta"] = raw[tid]["longWin"] - raw[tid]["shortWin"]
    z = {k: zscores({t: v[k] for t, v in raw.items()})
         for k in ("split", "group", "early", "objective", "fight", "lateDelta", "avgDuration", "winRate", "earlyKills")}
    team_styles = {}
    extra["teams"] = {}
    for tid in sorted(raw, key=lambda t: list(teams).index(t) if t in teams else 99):
        v = raw[tid]
        late = max(z["lateDelta"][tid], z["avgDuration"][tid])
        scores = {
            "teamfight": (z["group"][tid] + z["fight"][tid]) / 2,
            "split": z["split"][tid],
            "early": z["early"][tid],
            "objective": z["objective"][tid],
            # low early aggression is not enough (weak teams have it too): needs real late evidence
            "scaling": (-z["early"][tid] + late) / 2 if late >= SCALING_MIN_LATE else -9.0,
        }
        best = max(scores, key=scores.get)
        suggested = best if scores[best] >= SUGGEST_MIN_SCORE else "balanced"
        team_styles[tid] = {
            "name": teams.get(tid, {}).get("name", tid),
            "games": v["games"],
            "split": r3(v["split"]),
            "group": r3(v["group"]),
            "early": r3(v["early"]),
            "objective": r3(v["objective"]),
            "fight": r3(v["fight"]),
            "suggested": suggested,
        }
        extra["teams"][tid] = {**{k: r3(x) for k, x in v.items()},
                               "z": {k: r3(z[k][tid]) for k in z},
                               "scores": {k: r3(x) for k, x in scores.items()}}

    # ---- strategy targets (team-level quantiles across the league)
    q = lambda key, p: quantile([v[key] for v in raw.values()], p)  # noqa: E731
    med_split, med_group, med_ek = q("split", 0.5), q("group", 0.5), q("earlyKills", 0.5)

    def top_teams(score_key: str) -> list[str]:
        return sorted(raw, key=lambda t: extra["teams"][t]["scores"][score_key], reverse=True)[:STYLE_TOP_N]

    def target(score_key: str, why: str) -> dict:
        ts = top_teams(score_key)
        return {"sideLaner": r3(statistics.fmean(raw[t]["split"] for t in ts)),
                "grouped": r3(statistics.fmean(raw[t]["group"] for t in ts)),
                "earlyKills": r3(statistics.fmean(raw[t]["earlyKills"] for t in ts)),
                "note": f"Mean of the {STYLE_TOP_N} most {why} LCK teams ({', '.join(ts)})."}

    strategy_targets = {
        "balanced": {"sideLaner": r3(med_split), "grouped": r3(med_group), "earlyKills": r3(med_ek),
                     "note": "League median team: shape in min 20-35 full-strength frames, kills before 14:00 per game."},
        "teamfight": target("teamfight", "grouped / big-fight"),
        "split": target("split", "side-lane heavy"),
        "early": target("early", "early-aggressive (kills+plates+towers <14:00)"),
        "objective": target("objective", "objective-taking (dragon/grub/herald share)"),
        "scaling": target("scaling", "late-leaning (low early, long-game wins)"),
    }
    extra["targetQuantiles"] = {k: {p: r3(q(k, p)) for p in (0.25, 0.5, 0.75)} for k in ("split", "group", "earlyKills")}
    extra["leagueMedianDuration"] = league_median_dur
    extra["durationQuantiles"] = {p: round(quantile(acc.durations, p)) for p in (0.1, 0.25, 0.5, 0.75, 0.9)}
    extra["prefixes"] = {t: dict(c.most_common(5)) for t, c in acc.prefixes.items()}
    extra["unmatched"] = dict(acc.unmatched_names)
    extra["zoneEvents"] = dict(acc.zone_events)

    stats = {
        "games": acc.games,
        "objectives": objectives,
        "fights": fights,
        "shape": shape,
        "teamStyles": team_styles,
        "strategyTargets": strategy_targets,
        "zones": acc.zones,
    }
    return stats, extra


HEADER = '''// GENERATED by scripts/analyze_lck_macro.py from {games} LCK 2026 games (Riot V5 timelines via Leaguepedia).
// Do not edit by hand; rerun `python -I scripts/analyze_lck_macro.py`.
//
// objectives.*: n = takes; participants[i] = share of takes with i+1 champions of the taking team
//   (killer + assists of the taking team; enemies listed as "assists" are dropped); soloByRole = takes
//   by exactly one champion, by role; firstAt = median seconds of the first take per game (games with a take).
//   grubs = one event per grub. elder = ELDER_DRAGON (not in dragon).
// fights: CHAMPION_KILL chains (<= 15 s from the last kill, <= 2,500 u from any kill in the chain).
//   size = distinct killers + assists + victims. byPhase by first kill: early < 14:00, mid 14-25, late > 25.
//   perGame = phase fights / all games. killsPerMin[m] = kills in minute m / games still running in minute m.
//   soloKillShare = kills by a champion with no assists / all kills.
// shape[minute]: team-frames with all 5 alive and none within 1,600 u of the own fountain.
//   farthest / median = medians (units) of the farthest and median member distance from the team centroid;
//   sideLaner = share with a member > 4,000 u from the centroid of the other four; grouped = all within 2,500 u.
// teamStyles (teams.json ids): split / group = sideLaner / grouped share in minutes 20-35;
//   early = (kills + plates + towers before 14:00) per game; objective = mean of dragon, grub, herald take share;
//   fight = fights with >= 6 participants per game. suggested = best style score (z within the 10 LCK teams):
//   teamfight = mean z(group, fight), split = z(split), early = z(early), objective = z(objective),
//   scaling = mean(-z(early), L) where L = max z(long-game win rate - short-game win rate, avg duration), only if L >= 0.5;
//   "balanced" when the best score < 0.75. Wiki: "LoLSim LCK 운영 데이터".
// strategyTargets: balanced = league median team; others = mean of the 3 teams scoring highest on that style.
// zones: 30x31 counts [ix][iy], 500 u cells from (-120, -120), blue-side view (red mirrored (x, y) -> (c - y, c - x),
//   c = 14764.1), alive players outside their base (>= 1,600 u from own fountain) only.
//   dragon/baron: the last 60 s frame before the kill (Take = taking team, Give = the other team);
//   ahead / behind: minutes 20-30 with team gold lead >= +2,000 / <= -2,000.
'''

INTERFACE = '''
export interface LckStats {
  games: number;
  objectives: Record<"dragon" | "baron" | "herald" | "grubs" | "elder", { n: number; participants: number[] /* shares for 1..5 */; soloByRole: Record<string, number>; firstAt?: number }>;
  fights: { sizeShare: number[] /* index i = share of fights with i+1 participants, length 10 */; byPhase: Record<"early" | "mid" | "late", { fights: number; avgSize: number; perGame: number }>; killsPerMin: number[] /* minute 0..44, per game */; soloKillShare: number };
  shape: { minute: number; farthest: number; median: number; sideLaner: number; grouped: number }[];
  teamStyles: Record<string /* teams.json id */, { name: string; games: number; split: number; group: number; early: number; objective: number; fight: number; suggested: string }>;
  strategyTargets: Record<string /* strategy id */, { sideLaner: number; grouped: number; earlyKills: number; note: string }>;
  zones: Record<"dragonTake" | "dragonGive" | "baronTake" | "baronGive" | "ahead" | "behind", Record<"Top" | "Jungle" | "Mid" | "Bot" | "Support", number[][]>>;
}
'''


def j(x) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(", ", ": "))


def write_ts(stats: dict, extra: dict) -> None:
    lines = [HEADER.format(games=stats["games"]).rstrip("\n"), INTERFACE.rstrip("\n"), ""]
    tg = extra["teamGame"]
    team_lines = [
        f"// single team-game spread (min 20-35, n={tg['n']}), P10/P25/P50/P75/P90:",
        "//   sideLaner " + " / ".join(str(v) for v in tg["split"].values()),
        "//   grouped   " + " / ".join(str(v) for v in tg["group"].values()),
        "// team detail (z within LCK):",
    ]
    for tid, v in extra["teams"].items():
        zz = v["z"]
        team_lines.append(
            f"//   {tid:<4} win {v['winRate']:.3f}  z split {zz['split']:+.2f} group {zz['group']:+.2f} "
            f"early {zz['early']:+.2f} obj {zz['objective']:+.2f} fight {zz['fight']:+.2f} "
            f"lateDelta {zz['lateDelta']:+.2f} dur {zz['avgDuration']:+.2f} -> {stats['teamStyles'][tid]['suggested']}")
    lines += team_lines
    lines.append("export const LCK_STATS: LckStats = {")
    lines.append(f'  "games": {stats["games"]},')
    lines.append('  "objectives": {')
    lines += [f'    "{k}": {j(v)},' for k, v in stats["objectives"].items()]
    lines.append("  },")
    f = stats["fights"]
    lines.append('  "fights": {')
    lines.append(f'    "sizeShare": {j(f["sizeShare"])},')
    lines.append(f'    "byPhase": {j(f["byPhase"])},')
    lines.append(f'    "killsPerMin": {j(f["killsPerMin"])},')
    lines.append(f'    "soloKillShare": {f["soloKillShare"]}')
    lines.append("  },")
    lines.append('  "shape": [')
    lines += [f"    {j(row)}," for row in stats["shape"]]
    lines.append("  ],")
    lines.append('  "teamStyles": {')
    lines += [f'    "{k}": {j(v)},' for k, v in stats["teamStyles"].items()]
    lines.append("  },")
    lines.append('  "strategyTargets": {')
    lines += [f'    "{k}": {j(v)},' for k, v in stats["strategyTargets"].items()]
    lines.append("  },")
    lines.append('  "zones": {')
    for zone, by_role in stats["zones"].items():
        lines.append(f'    "{zone}": {{')
        for role, grid in by_role.items():
            lines.append(f'      "{role}": {json.dumps(grid, separators=(",", ":"))},')
        lines.append("    },")
    lines.append("  },")
    lines.append("};")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dump", type=Path, help="also write diagnostics JSON (z-scores, sample sizes) here")
    args = ap.parse_args()

    with INDEX.open(encoding="utf-8") as fh:
        index_games = json.load(fh)["games"]
    teams = load_teams()
    team_by_name = {t["name"]: tid for tid, t in teams.items()}
    layout = Layout()
    fountain = fountains(index_games)
    acc = Acc(layout)
    for i, entry in enumerate(index_games, 1):
        process_game(entry, acc, team_by_name, fountain)
        if i % 100 == 0:
            print(f"  {i}/{len(index_games)} games")
    stats, extra = build(acc, teams)
    extra["fountains"] = {s: [round(c, 1) for c in xy] for s, xy in fountain.items()}
    write_ts(stats, extra)
    size_kb = OUT.stat().st_size / 1024
    print(f"wrote {OUT.relative_to(GAME_ROOT)} ({size_kb:.0f} KB) from {stats['games']} games")
    print("roles:", dict(acc.stats))
    print("unmatched team names:", extra["unmatched"] or "none")
    for key, o in stats["objectives"].items():
        print(f"  {key:<7} n={o['n']:<5} parts={o['participants']} solo={o['soloByRole']} firstAt={o.get('firstAt')}")
    print("  fights:", stats["fights"]["byPhase"], "sizes:", stats["fights"]["sizeShare"])
    print("  solo kill share:", stats["fights"]["soloKillShare"])
    print("  kills/min:", stats["fights"]["killsPerMin"])
    for row in stats["shape"]:
        n = extra["shapeSamples"][row["minute"]]
        print(f"  shape {row}  frames {n['full']}/{n['all']}")
    for tid, v in stats["teamStyles"].items():
        print(f"  {tid:<4} {v}")
    for k, v in stats["strategyTargets"].items():
        print(f"  target {k:<9} {v}")
    if args.dump:
        args.dump.write_text(json.dumps(extra, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        print("diagnostics ->", args.dump)


if __name__ == "__main__":
    main()
