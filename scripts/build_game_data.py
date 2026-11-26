"""Build players.json, staff.json and teams.json (+ team logos) for the manager game.

  python scripts/fetch_game_data.py     # Cargo listings into data/cargo_cache/game_*.json
  python scripts/build_game_data.py [--no-logos] [--sanity]

Ratings: every game a player played is scored against the other players of the same role in the same
league (LCK or LCK CL) with z-scores of per-minute stats, kill participation, KDA and the result. The
mean game score is shrunk toward the role mean (weight n / (n + 15)), 2026 games count 1.0 and 2025
games 0.6. Tier 1 (anyone with an LCK game) is rated from LCK games only, tier 2 from LCK CL games.
OVR = tier base + spread * performance + playing time + results (titles, international games).
"""

from __future__ import annotations

import argparse
import colorsys
import gzip
import json
import math
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cargo_cache"
OUT_DIR = ROOT / "game" / "public" / "data"
ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
YEAR_WEIGHT = {"2025": 0.6, "2026": 1.0}
SHRINK_GAMES = 15

COUNTRY_ISO = {"South Korea": "KR", "Korea": "KR", "China": "CN", "Vietnam": "VN", "Taiwan": "TW", "Japan": "JP",
               "United States": "US", "Canada": "CA", "Australia": "AU", "Italy": "IT", "Brazil": "BR", "France": "FR",
               "Germany": "DE", "Spain": "ES", "Denmark": "DK", "Sweden": "SE", "Poland": "PL", "United Kingdom": "GB",
               "Philippines": "PH", "Thailand": "TH", "Indonesia": "ID", "Malaysia": "MY", "Hong Kong": "HK"}

# The 20 game teams. id = file-safe short name.
TEAMS = [
    # id, Leaguepedia name, Korean name, tier, parent, wealth, fans (rough fan base for the game, not a measurement)
    ("T1", "T1", "T1", 1, None, 5, 2_500_000),
    ("GEN", "Gen.G", "젠지", 1, None, 5, 1_100_000),
    ("HLE", "Hanwha Life Esports", "한화생명e스포츠", 1, None, 5, 800_000),
    ("DK", "Dplus Kia", "디플러스 기아", 1, None, 4, 900_000),
    ("KT", "KT Rolster", "kt 롤스터", 1, None, 4, 650_000),
    ("BFX", "BNK FEARX", "BNK 피어엑스", 1, None, 2, 250_000),
    ("DNS", "DN SOOPers", "DN 수퍼스", 1, None, 3, 300_000),
    ("NS", "Nongshim RedForce", "농심 레드포스", 1, None, 3, 300_000),
    ("BRO", "HANJIN BRION", "한진 브리온", 1, None, 2, 220_000),
    ("KRX", "Kiwoom DRX", "키움 DRX", 1, None, 3, 450_000),
    ("T1EA", "T1 Esports Academy", "T1 이스포츠 아카데미", 2, "T1", 2, 120_000),
    ("GENGA", "Gen.G Global Academy", "젠지 글로벌 아카데미", 2, "GEN", 2, 50_000),
    ("HLEC", "Hanwha Life Esports Challengers", "한화생명e스포츠 챌린저스", 2, "HLE", 2, 40_000),
    ("DKC", "Dplus Kia Challengers", "디플러스 기아 챌린저스", 2, "DK", 2, 45_000),
    ("KTC", "KT Rolster Challengers", "kt 롤스터 챌린저스", 2, "KT", 2, 35_000),
    ("BFXY", "BNK FEARX Youth", "BNK 피어엑스 유스", 2, "BFX", 1, 15_000),
    ("DNSC", "DN SOOPers Challengers", "DN 수퍼스 챌린저스", 2, "DNS", 1, 20_000),
    ("NSEA", "Nongshim Esports Academy", "농심 이스포츠 아카데미", 2, "NS", 1, 20_000),
    ("BROC", "HANJIN BRION Challengers", "한진 브리온 챌린저스", 2, "BRO", 1, 15_000),
    ("KRXC", "Kiwoom DRX Challengers", "키움 DRX 챌린저스", 2, "KRX", 1, 30_000),
]
# Older Leaguepedia names of the same team, so earlier rows land on the right team.
TEAM_RENAMES = {"BRION": "HANJIN BRION", "DRX": "Kiwoom DRX", "BRION Challengers": "HANJIN BRION Challengers",
                "DRX Challengers": "Kiwoom DRX Challengers", "OKSavingsBank BRION": "HANJIN BRION",
                "FearX": "BNK FEARX", "Kwangdong Freecs": "DN SOOPers", "DN Freecs": "DN SOOPers",
                "DN Freecs Challengers": "DN SOOPers Challengers", "Kwangdong Freecs Challengers": "DN SOOPers Challengers",
                "OKSavingsBank BRION Challengers": "HANJIN BRION Challengers", "FearX Youth": "BNK FEARX Youth",
                "Dplus KIA": "Dplus Kia", "Dplus KIA Challengers": "Dplus Kia Challengers"}

# All-time titles. 2025-2026 are computed from the scoreboards (TITLE_EVENTS below); everything before 2025
# is entered by hand from the public records because Leaguepedia's TournamentResults table is missing most
# pre-2025 Worlds and every OGN-era split. Counted only under the same organization (SKT -> T1, DAMWON -> DK,
# Longzhu/Kingzone -> DRX, KT Arrows -> KT; Samsung-era titles are not given to Gen.G, ROX's to HLE).
TITLES_BEFORE_2025 = {
    "T1": {"lck": 10, "msi": 2, "worlds": 5, "ewc": 1},
    "GEN": {"lck": 4, "msi": 1},
    "HLE": {"lck": 1},
    "DK": {"lck": 3, "worlds": 1},
    "KT": {"lck": 2},
    "KRX": {"lck": 2, "worlds": 1},
}
# Events whose winner counts as a title. Value = title key.
TITLE_EVENTS = {
    "LCK/2025 Season/Cup": "cup", "LCK/2026 Season/Cup": "cup",
    "LCK/2025 Season/Season Playoffs": "lck", "LCK/2026 Season/Season Playoffs": "lck",
    "2025 First Stand": "firstStand", "2026 First Stand": "firstStand",
    "2025 Mid-Season Invitational": "msi", "2026 Mid-Season Invitational": "msi",
    "2025 Season World Championship/Main Event": "worlds", "2026 Season World Championship/Main Event": "worlds",
    "Esports World Cup 2025": "ewc", "Esports World Cup 2026": "ewc",
}
# Hand-entered major titles before 2025 for current players and coaches (fame only, not OVR).
LEGACY = {
    # players
    "Faker": {"worlds": 5, "lck": 10, "msi": 2}, "Keria": {"worlds": 2, "lck": 1}, "Oner": {"worlds": 2, "lck": 1},
    "Gumayusi": {"worlds": 2, "lck": 1}, "Zeus": {"worlds": 2, "lck": 1}, "Canyon": {"worlds": 1, "lck": 4, "msi": 1},
    "ShowMaker": {"worlds": 1, "lck": 3}, "Ruler": {"worlds": 1, "lck": 1, "msi": 1}, "Chovy": {"lck": 4, "msi": 1},
    "Kiin": {"lck": 1, "msi": 1}, "Peyz": {"lck": 3, "msi": 1}, "Kingen": {"worlds": 1}, "Zeka (Kim Geon-woo)": {"worlds": 1, "lck": 1},
    "Pyosik": {"worlds": 1}, "Lehends": {"lck": 3}, "Kanavi": {"msi": 1}, "Delight": {"lck": 1},
    "Viper": {"worlds": 1, "lck": 1}, "Doran (Choi Hyeon-jun)": {"lck": 1}, "Peanut": {"worlds": 1, "lck": 2, "msi": 1},
    # coaches (titles won as player or coach)
    "kkOma": {"worlds": 4, "lck": 8, "msi": 2}, "Bengi": {"worlds": 4, "lck": 3, "msi": 1}, "Score": {"lck": 1},
    "Homme": {"lck": 1},
}
# OVR formula constants (tier 1 rated from LCK games, tier 2 from LCK CL games)
OVR_T1 = {"base": 64, "perf": 12.0, "playtime": 6.0, "titles": 1.3, "titles_cap": 6.0, "intl": 3.0, "legacy": 1.3, "legacy_cap": 6.5}
OVR_T2 = {"base": 55, "perf": 10.0, "playtime": 5.0}
SCALE = {1: {"median": 77.0, "top": 95.0, "regular_games": 100, "low": 1.0},
         2: {"median": 62.0, "top": 71.0, "regular_games": 80, "low": 0.5}}
FIRST_TEAM_STAFF_ROLES = ("Head Coach", "Coach", "Strategic Coach", "Analyst")
STAFF_ROLE_MAP = {"Head Coach": "Head Coach", "Interim Head Coach": "Head Coach", "Head Coach/Strategic Coach": "Head Coach",
                  "Assistant Head Coach": "Coach", "Assistant Coach": "Coach", "Positional Coach": "Coach",
                  "Strategic Coach": "Strategic Coach", "Analyst": "Analyst", "Coach": "Coach"}
LCK_EVENT_ORDER = ["Cup", "Rounds 1-2", "Road to MSI", "Rounds 3-5", "Rounds 3-4", "Season Play-In", "Season Playoffs"]
CL_EVENT_ORDER = ["Kickoff", "Rounds 1-2", "Rounds 3-5", "Rounds 3-4", "Season Play-In", "Season Playoffs"]


def load(name: str):
    return json.loads((CACHE / f"game_{name}.json").read_text(encoding="utf-8"))


def num(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def canon_team(name: str) -> str:
    return TEAM_RENAMES.get(name, name)


def handle(page: str) -> str:
    return re.sub(r"\s*\(.*\)$", "", page).strip()


def page_rank(page: str) -> tuple:
    """Sort key for a tournament page: year, league tier, event order."""
    m = re.match(r"(LCK CL|LCK)/(\d{4}) Season/(.+)$", page)
    if not m:
        return (0, 0, 0)
    league, year, event = m.groups()
    order = CL_EVENT_ORDER if league == "LCK CL" else LCK_EVENT_ORDER
    event_index = next((i for i, e in enumerate(order) if event.startswith(e)), -1)
    return (int(year), 0 if league == "LCK CL" else 1, event_index)


# ------------------------------------------------------------------------------------------------- stats

def game_rows():
    """Every LCK / LCK CL player-game with derived per-game metrics."""
    rows = []
    for league in ("lck", "cl"):
        for year in ("2025", "2026"):
            for r in load(f"sp_{league}_{year}"):
                if r.get("Role") not in ROLES or not r.get("Link"):
                    continue
                length = num(r.get("Len"), 30.0) or 30.0
                team_kills = num(r.get("T1K") if r.get("Side") == "1" else r.get("T2K"))
                k, d, a = num(r["K"]), num(r["D"]), num(r["A"])
                rows.append({
                    "league": league, "year": year, "link": r["Link"], "role": r["Role"], "team": canon_team(r["Team"]),
                    "game": r["GameId"], "page": r["Page"], "dt": r.get("DT") or "", "champ": r.get("Champion") or "",
                    "win": 1.0 if r.get("Win") == "Yes" else 0.0, "k": k, "d": d, "a": a,
                    "kp": (k + a) / team_kills if team_kills else 0.0,
                    "kda": math.log1p((k + a) / max(1.0, d)),
                    "dpm": num(r.get("Dmg")) / length, "gpm": num(r.get("Gold")) / length,
                    "cspm": num(r.get("CS")) / length, "vspm": num(r.get("VS")) / length,
                    "kpg": k, "dpg": d, "len": length,
                })
    return rows


ROLE_WEIGHTS = {
    # metric weights for the per-game score
    "Top": {"dpm": 0.22, "gpm": 0.18, "cspm": 0.14, "kda": 0.16, "kp": 0.12, "win": 0.18},
    "Jungle": {"kp": 0.24, "dpm": 0.12, "gpm": 0.14, "kda": 0.16, "vspm": 0.12, "win": 0.22},
    "Mid": {"dpm": 0.22, "gpm": 0.18, "cspm": 0.14, "kda": 0.16, "kp": 0.12, "win": 0.18},
    "Bot": {"dpm": 0.24, "gpm": 0.18, "cspm": 0.14, "kda": 0.18, "kp": 0.08, "win": 0.18},
    "Support": {"kp": 0.26, "vspm": 0.22, "kda": 0.2, "dpg": -0.08, "win": 0.24},
}
METRICS = ["dpm", "gpm", "cspm", "kda", "kp", "vspm", "win", "dpg", "kpg"]


def add_zscores(rows):
    groups = defaultdict(list)
    for r in rows:
        groups[(r["league"], r["role"])].append(r)
    for group in groups.values():
        for m in METRICS:
            values = [r[m] for r in group]
            mean, sd = statistics.fmean(values), statistics.pstdev(values) or 1.0
            for r in group:
                r["z_" + m] = (r[m] - mean) / sd
        for r in group:
            w = ROLE_WEIGHTS[r["role"]]
            r["score"] = sum(weight * r["z_" + m] for m, weight in w.items())


def timeline_stats():
    """gd15 and solo kills per player from the LCK 2026 timelines (participant order = role order)."""
    index = json.loads((ROOT / "data" / "games_lck_2026.json").read_text(encoding="utf-8"))
    gd15, solo, games = defaultdict(list), Counter(), Counter()
    for game in index["games"]:
        raw = json.load(gzip.open(ROOT / game["raw"], "rt", encoding="utf-8"))
        timeline = raw.get("timeline")
        if not timeline:
            continue
        by_slot = {}
        for entry in game["roster"]:
            if entry["role"] in ROLES and entry["side"] in (1, 2):
                by_slot[(entry["side"] - 1) * 5 + ROLES.index(entry["role"]) + 1] = entry["player"]
        frames = timeline["frames"]
        frame15 = frames[15] if len(frames) > 15 else None
        for pid, player in by_slot.items():
            games[player] += 1
            if frame15:
                opp = pid + 5 if pid <= 5 else pid - 5
                pf = frame15["participantFrames"]
                gd15[player].append(pf[str(pid)]["totalGold"] - pf[str(opp)]["totalGold"])
        for frame in frames:
            for event in frame["events"]:
                if event["type"] == "CHAMPION_KILL" and not event.get("assistingParticipantIds"):
                    killer, victim = event.get("killerId", 0), event.get("victimId", 0)
                    if 1 <= killer <= 10 and 1 <= victim <= 10 and (killer - 1) % 5 == (victim - 1) % 5 and killer in by_slot:
                        solo[by_slot[killer]] += 1
    return gd15, solo, games


def event_winners():
    """Winner team of each title event (2025-2026)."""
    winners = {}
    for r in load("results"):
        page = r["Page"]
        if page in TITLE_EVENTS:
            winners[page] = canon_team(r["Team"])
    intl = load("sp_intl")
    finals = defaultdict(set)
    for r in intl:
        g = r["GameId"]
        if "_Finals_" in g and "Semi" not in g and "Quarter" not in g:
            finals[r["Page"]].add(g)
    for page, ids in finals.items():
        last = sorted(ids)[-1]
        for r in intl:
            if r["GameId"] == last and r["Win"] == "Yes":
                winners[page] = canon_team(r["Team"])
    return winners


# ----------------------------------------------------------------------------------------------- builders

def champion_lookup():
    data = json.loads((OUT_DIR / "champions.json").read_text(encoding="utf-8"))
    lookup = {}
    for c in data["champions"]:
        for name in (c["id"], c["nameEn"]):
            lookup[re.sub(r"[^a-z]", "", name.lower())] = c["id"]
    lookup.update({"wukong": "MonkeyKing", "nunuwillump": "Nunu", "renataglasc": "Renata"})
    return lambda name: lookup.get(re.sub(r"[^a-z]", "", (name or "").lower()))


class CaselessDict(dict):
    """Leaguepedia spells some handles with a different first-letter case in different tables."""

    def get(self, key, default=None):
        return super().get(key.lower(), default)


def people_by_link():
    people = CaselessDict()
    rows = load("people") + (load("people_fix") if (CACHE / "game_people_fix.json").exists() else [])
    for p in rows:
        people[p["Asked"].lower()] = p
    return people


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def build_players(rows, gd15, solo, tl_games, winners, people, champ_id):
    by_player = defaultdict(list)
    for r in rows:
        by_player[r["link"]].append(r)
    intl_games = Counter(r["Link"] for r in load("sp_intl"))
    intl_pages = defaultdict(set)
    for r in load("sp_intl"):
        intl_pages[r["Link"]].add((r["Page"], canon_team(r["Team"])))

    # role means of attribute inputs for later scaling
    players = []
    raw_attr = defaultdict(dict)
    for link, games in by_player.items():
        tier = 1 if any(g["league"] == "lck" for g in games) else 2
        rated = [g for g in games if g["league"] == ("lck" if tier == 1 else "cl")]
        role = Counter(g["role"] for g in games).most_common(1)[0][0]
        rated_role = [g for g in rated if g["role"] == role] or rated
        weights = [YEAR_WEIGHT[g["year"]] for g in rated_role]
        n_eff = sum(weights)
        wmean = lambda key: sum(w * g[key] for w, g in zip(weights, rated_role)) / n_eff  # noqa: E731
        shrink = n_eff / (n_eff + SHRINK_GAMES)
        perf = wmean("score") * shrink
        scores = [g["score"] for g in rated_role]
        consistency_sd = statistics.pstdev(scores) if len(scores) > 1 else 1.0
        champs = Counter(champ_id(g["champ"]) for g in games if champ_id(g["champ"]))
        champ_wins = Counter(champ_id(g["champ"]) for g in games if champ_id(g["champ"]) and g["win"])
        distinct = len(champs)
        # titles 2025-26: player appeared in that event for the winning team
        played_events = {(g["page"], g["team"]) for g in games} | intl_pages.get(link, set())
        titles = Counter(TITLE_EVENTS[page] for page, team in played_events if page in TITLE_EVENTS and winners.get(page) == team)
        lck_games = sum(1 for g in games if g["league"] == "lck")
        rated_games = len(rated)
        # attribute inputs (z, shrunk)
        gd = gd15.get(link, [])
        gd_z = (statistics.fmean(gd) / 900.0) * (len(gd) / (len(gd) + SHRINK_GAMES)) if gd else 0.0
        solo_rate = solo.get(link, 0) / tl_games[link] if tl_games.get(link) else None
        raw_attr[link] = {
            "laning": (0.45 * wmean("z_cspm") + 0.35 * wmean("z_gpm") + (0.6 * gd_z if gd else 0.0)) * shrink,
            "teamfight": (0.5 * wmean("z_kp") + 0.3 * wmean("z_dpm") + 0.2 * wmean("z_kda")) * shrink,
            "macro": (0.55 * wmean("z_win") + 0.25 * wmean("z_vspm") + 0.2 * wmean("z_gpm")) * shrink,
            "mechanics": (0.45 * wmean("z_dpm") + 0.3 * wmean("z_kda") + 0.25 * wmean("z_kpg") + (0.3 * (solo_rate or 0) if solo_rate else 0)) * shrink,
            "consistency": (0.6 * (0.9 - consistency_sd) + 0.4 * -wmean("z_dpg")) * shrink,
            "pool": (distinct - 8) / 6.0,
        }
        last = max(games, key=lambda g: (g["dt"], g["game"]))
        person = people.get(link, {})
        native = (person.get("Native") or "").strip()
        playtime = min(1.0, rated_games / 120.0)
        intl = intl_games.get(link, 0)
        title_points = titles["worlds"] * 2.5 + titles["msi"] * 1.5 + titles["lck"] * 1.5 + titles["firstStand"] * 0.8 + titles["ewc"] * 0.6 + titles["cup"] * 0.8
        legacy_worlds = LEGACY.get(link, {}).get("worlds", 0)
        if tier == 1:
            # results: titles won in 2025-26, international games, and big-stage experience (Worlds titles before 2025)
            ovr = (OVR_T1["base"] + OVR_T1["perf"] * perf + OVR_T1["playtime"] * playtime
                   + min(OVR_T1["titles_cap"], OVR_T1["titles"] * title_points) + OVR_T1["intl"] * min(1.0, intl / 45)
                   + min(OVR_T1["legacy_cap"], OVR_T1["legacy"] * legacy_worlds))
            ovr_range = (58, 96)
        else:
            ovr = OVR_T2["base"] + OVR_T2["perf"] * perf + OVR_T2["playtime"] * playtime
            ovr_range = (48, 74)
        players.append({
            "id": link, "name": person.get("ID") or handle(link), "realName": native or person.get("Name") or None,
            "nat": COUNTRY_ISO.get(person.get("Country") or "", "KR" if not person.get("Country") else (person.get("Country") or "")[:2].upper()),
            "birth": person.get("Birth") or None, "role": role, "tier": tier, "lastTeam": last["team"],
            "teams": sorted({g["team"] for g in games}, key=lambda t: max(g["dt"] for g in games if g["team"] == t), reverse=True),
            "seasons": sorted({g["year"] for g in games}), "games": len(games),
            "stats": {
                "wr": round(statistics.fmean(g["win"] for g in rated_role), 3),
                "kda": round((sum(g["k"] + g["a"] for g in rated_role)) / max(1.0, sum(g["d"] for g in rated_role)), 2),
                "kp": round(statistics.fmean(g["kp"] for g in rated_role), 3),
                "dpm": round(statistics.fmean(g["dpm"] for g in rated_role), 1),
                "gpm": round(statistics.fmean(g["gpm"] for g in rated_role), 1),
                "cspm": round(statistics.fmean(g["cspm"] for g in rated_role), 2),
                "vspm": round(statistics.fmean(g["vspm"] for g in rated_role), 2),
                "gd15": round(statistics.fmean(gd), 0) if gd else None,
                "soloKills": solo.get(link) if tl_games.get(link) else None,
                "ratedGames": rated_games,
            },
            "_perf": perf, "_ovr": clamp(ovr, *ovr_range),
            "champs": [{"c": c, "g": n, "w": champ_wins[c]} for c, n in champs.most_common(10)],
            "intl": intl, "titles2526": dict(titles), "lckGames": lck_games,
        })

    # stretch each tier to the target scale: the median regular (enough rated games) lands on SCALE[tier]["median"],
    # the best player on SCALE[tier]["top"]; players above the anchor move with that factor, players below it
    # with factor * SCALE[tier]["low"] (LCK CL needs a gentler bottom, or half the league sits on the floor).
    for tier, (lo, hi) in ((1, (60, 96)), (2, (50, 73))):
        group = [p for p in players if p["tier"] == tier]
        regulars = [p["_ovr"] for p in group if p["stats"]["ratedGames"] >= SCALE[tier]["regular_games"]]
        anchor, best = statistics.median(regulars), max(p["_ovr"] for p in group)
        factor = (SCALE[tier]["top"] - SCALE[tier]["median"]) / max(1e-6, best - anchor)
        for p in group:
            delta = p["_ovr"] - anchor
            p["_ovr"] = clamp(SCALE[tier]["median"] + delta * factor * (1.0 if delta >= 0 else SCALE[tier]["low"]), lo, hi)

    # attributes: z within tier, then shown as the player's profile around OVR: attr = OVR + spread * (z - mean z
    # of that player) + a small share of the absolute z, so a great player's weak side still reads as weaker.
    attrs_names = ("laning", "teamfight", "macro", "mechanics", "consistency", "pool")
    zs = defaultdict(dict)
    for attr in attrs_names:
        for tier in (1, 2):
            group = [p for p in players if p["tier"] == tier]
            values = [raw_attr[p["id"]][attr] for p in group]
            mean, sd = statistics.fmean(values), statistics.pstdev(values) or 1.0
            for p in group:
                zs[p["id"]][attr] = (raw_attr[p["id"]][attr] - mean) / sd
    for p in players:
        own = zs[p["id"]]
        own_mean = statistics.fmean(own.values())
        p["attrs"] = {a: int(round(clamp(p["_ovr"] + 4.5 * (own[a] - own_mean) + 1.0 * own[a], 30, 99))) for a in attrs_names}
    for p in players:
        p["ovr"] = int(round(p.pop("_ovr")))
        p.pop("_perf")
    return players


def roster_only_players(players, tr_rows, people):
    """Players on a 2025-26 roster page with no game: keep them so team rosters resolve."""
    known = {p["id"].lower() for p in players}
    extra = {}
    for row in sorted(tr_rows, key=lambda r: page_rank(r["Page"])):
        if "Showmatch" in row["Page"]:
            continue  # legends showmatch rosters are not real 2026 teams
        for link, role in zip((row["Links"] or "").split(";;"), (row["Roles"] or "").split(";;")):
            link, role = link.strip(), role.strip()
            if role in ROLES and link and link.lower() not in known:
                tier = 1 if row["Page"].startswith("LCK/") else 2
                person = people.get(link, {})
                extra[link] = {
                    "id": link, "name": person.get("ID") or handle(link), "realName": (person.get("Native") or "").strip() or person.get("Name") or None,
                    "nat": COUNTRY_ISO.get(person.get("Country") or "", "KR"), "birth": person.get("Birth") or None,
                    "role": role, "tier": tier, "lastTeam": canon_team(row["Team"]), "teams": [canon_team(row["Team"])],
                    "seasons": [row["Page"].split("/")[1][:4]], "games": 0, "stats": None,
                    "attrs": {a: (64 if tier == 1 else 54) for a in ("laning", "teamfight", "macro", "mechanics", "consistency", "pool")},
                    "ovr": 64 if tier == 1 else 54, "champs": [], "intl": 0, "titles2526": {}, "lckGames": 0,
                    "rosterOnly": True,
                }
    return list(extra.values())


def add_fame(players):
    for p in players:
        legacy = LEGACY.get(p["id"], {})
        t = p["titles2526"]
        fame = (14 * min(1.0, p["lckGames"] / 200) + 10 * min(1.0, p["intl"] / 60)
                + 7 * t.get("worlds", 0) + 4 * (t.get("msi", 0) + t.get("lck", 0)) + 2 * (t.get("cup", 0) + t.get("firstStand", 0) + t.get("ewc", 0))
                + 9 * legacy.get("worlds", 0) + 1.5 * legacy.get("lck", 0) + 3 * legacy.get("msi", 0)
                + 1.2 * max(0, p["ovr"] - 70))
        if p["tier"] == 2:
            fame *= 0.6
        p["fame"] = int(round(clamp(fame, 1, 100)))


def build_staff(tr_rows, rc_rows, rows, winners, people, players):
    # Leaguepedia spells some handles with another case on some pages (kkOma / KkOma, cvMax / CvMax, bon0 / Bon0).
    # That is one person, so everything is keyed by the lower-case link and one spelling becomes the id.
    membership = defaultdict(list)  # lower-case staff link -> [(page, team)]
    spellings = defaultdict(Counter)  # lower-case staff link -> spellings seen on roster pages
    latest = {}  # lower-case link -> (page rank, role) of the person's latest roster row, as player or staff
    for row in tr_rows:
        if "Showmatch" in row["Page"]:
            continue
        rank = page_rank(row["Page"])
        for link, role in zip((row["Links"] or "").split(";;"), (row["Roles"] or "").split(";;")):
            link, role = link.strip(), role.strip()
            if not link:
                continue
            key = link.lower()
            if key not in latest or rank >= latest[key][0]:
                latest[key] = (rank, role)
            if role not in ROLES:
                membership[key].append((row["Page"], canon_team(row["Team"])))
                spellings[key][link] += 1
    player_ids = {p["id"].lower() for p in players}
    # game results per (page, team)
    results = defaultdict(lambda: [0, 0])
    seen = set()
    for r in rows:
        key = (r["game"], r["team"])
        if key in seen:
            continue
        seen.add(key)
        results[(r["page"], r["team"])][0 if r["win"] else 1] += 1
    last_role = {}
    for r in sorted(rc_rows, key=lambda r: r["Date"] or ""):
        if r.get("Direction") == "Join" and r.get("Role"):
            last_role[r["Player"].lower()] = r["Role"]
    legacy_by_key = {k.lower(): v for k, v in LEGACY.items()}
    staff = []
    for key, member in membership.items():
        person = people.get(key, {})
        seen = spellings[key]
        link = person.get("ID") if person.get("ID") in seen else seen.most_common(1)[0][0]
        member.sort(key=lambda m: page_rank(m[0]))
        last_page, last_team = member[-1]
        rc_role = last_role.get(key, "Coach")
        role = STAFF_ROLE_MAP.get(rc_role)
        if role is None:
            role = "Coach" if "Coach" in rc_role else None
        if role is None:
            continue  # managers, streamers, directors are not coaching staff
        # a player-coach whose latest roster row has him playing (Bible, LCK CL 2025) is a player, not staff
        if key in player_ids and latest[key][1] in ROLES:
            print(f"  staff: {link} left out, his latest roster row is as a player ({latest[key][1]})")
            continue
        w = sum(results[m][0] for m in set(member))
        l = sum(results[m][1] for m in set(member))
        titles = 0
        for page, team in set(member):
            if page in TITLE_EVENTS and winners.get(page) == team:
                titles += 1
        years = {m[0].split("/")[1][:4] for m in member}
        teams_by_year = {(m[0].split("/")[1][:4], m[1]) for m in member if m[0].startswith("LCK/")}
        for page, team in winners.items():
            if not page.startswith("LCK") and TITLE_EVENTS.get(page) in ("msi", "worlds", "firstStand", "ewc"):
                year = re.search(r"20\d\d", page).group(0)
                if (year, team) in teams_by_year:
                    titles += 1
        legacy = legacy_by_key.get(key, {})
        tier = 1 if any(m[0].startswith("LCK/") for m in member) else 2
        win_rate = w / (w + l) if w + l else 0.5
        fame = (25 if tier == 1 else 8) + 8 * titles + 9 * legacy.get("worlds", 0) + 1.5 * legacy.get("lck", 0) \
            + 30 * (win_rate - 0.5) + (12 if role == "Head Coach" else 0)
        staff.append({
            "id": link, "name": person.get("ID") or handle(link), "realName": (person.get("Native") or "").strip() or person.get("Name") or None,
            "nat": COUNTRY_ISO.get(person.get("Country") or "", "KR"), "birth": person.get("Birth") or None,
            "role": role, "roleDetail": rc_role, "lastTeam": last_team, "tier": tier, "seasons": sorted(years),
            "record": {"w": w, "l": l}, "titles": titles, "fame": int(round(clamp(fame, 1, 100))),
        })
    return staff


def logo_colors(path: Path) -> list[str]:
    from PIL import Image
    image = Image.open(path).convert("RGBA").resize((64, 64))
    bins = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    for r, g, b, a in image.get_flattened_data():
        if a < 128:
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        key = ("dark" if v < 0.25 else "light") if s < 0.25 else int(h * 12) % 12
        slot = bins[key]
        slot[0] += 1
        slot[1] += r
        slot[2] += g
        slot[3] += b
    ranked = sorted(bins.items(), key=lambda kv: -kv[1][0])
    chromatic = [kv for kv in ranked if isinstance(kv[0], int) and kv[1][0] > 40]
    neutral = [kv for kv in ranked if not isinstance(kv[0], int)]
    picks = (chromatic[:2] + neutral)[:2] if chromatic else neutral[:2]
    colors = []
    for _, (n, r, g, b) in picks:
        colors.append("#{:02x}{:02x}{:02x}".format(int(r / n), int(g / n), int(b / n)))
    if len(colors) == 1:  # one-color logo: pair it with a contrasting neutral
        r, g, b = (int(colors[0][i:i + 2], 16) for i in (1, 3, 5))
        colors.append("#101010" if (0.299 * r + 0.587 * g + 0.114 * b) > 110 else "#f0f0f0")
    return colors or ["#888888", "#222222"]


MANUAL_COLORS = {"T1": ["#e2012d", "#101010"], "GEN": ["#aa8a00", "#101010"], "HLE": ["#f37021", "#101010"],
                 "KT": ["#e60012", "#101010"], "NS": ["#de2027", "#ffffff"],
                 # the 2026 crest is mostly black and gold, so logo_colors would pick olive / dark red
                 "BFX": ["#fce700", "#101010"],
                 # from the 2026 logos (colors[0] is the UI accent, so KRX puts its magenta before the navy)
                 "DNS": ["#0a51f1", "#101828"], "BRO": ["#004c29", "#f0f0f0"], "KRX": ["#d40881", "#001c58"]}

# Leaguepedia's image host (static.wikia.nocookie.net) answers scripted requests with a Cloudflare challenge,
# so logos come from Wikipedia / Wikimedia Commons instead: (wiki api host, file name). Fetched as 256 px PNG.
# KT, DNS, BRO, BFX, KRX, DK, GEN and HLE are not here: their current Leaguepedia square logos (saved by hand
# into data/logo_inbox/) are imported by scripts/update_team_logos.py. Wikipedia only had KT's corporate mark
# and the pre-2026 FearX / DRX logos, and nothing for DNS / BRO.
WIKI_LOGOS = {
    "T1": ("commons.wikimedia.org", "File:T1 esports logo.svg"),
    "NS": ("en.wikipedia.org", "File:Nongshim RedForce logo.png"),
}
WIKI_HEADERS = {"User-Agent": "lolsim-research/0.1 (team logo lookup)"}


def fetch_wiki_logo(host: str, filename: str, path: Path) -> bool:
    payload = requests.get(f"https://{host}/w/api.php", params={
        "action": "query", "format": "json", "formatversion": 2, "prop": "imageinfo", "iiprop": "url",
        "iiurlwidth": 256, "titles": filename}, headers=WIKI_HEADERS, timeout=60).json()
    pages = payload.get("query", {}).get("pages", [])
    info = (pages[0].get("imageinfo") or [{}])[0] if pages else {}
    url = info.get("thumburl") or info.get("url")
    time.sleep(1.0)
    if not url:
        print(f"  no logo url for {filename}")
        return False
    response = requests.get(url, headers=WIKI_HEADERS, timeout=60)
    time.sleep(1.0)
    if not response.ok or response.content[:4] != b"\x89PNG":
        print(f"  logo download failed for {filename}: HTTP {response.status_code}")
        return False
    from io import BytesIO
    from PIL import Image
    image = Image.open(BytesIO(response.content)).convert("RGBA")
    image.thumbnail((256, 256))
    image.save(path)
    return True


def build_teams(tr_rows, players, staff, winners, fetch_logos: bool):
    logo_dir = OUT_DIR / "logos"
    logo_dir.mkdir(parents=True, exist_ok=True)
    team_rows = {r["Name"]: r for r in load("teams")}
    player_ids = {p["id"].lower(): p["id"] for p in players}
    staff_ids = {s["id"].lower(): s["id"] for s in staff}
    titles_2526 = defaultdict(Counter)
    for page, team in winners.items():
        titles_2526[team][TITLE_EVENTS[page]] += 1
    teams = []
    for tid, name, name_ko, tier, parent, wealth, fans in TEAMS:
        own = [r for r in tr_rows if canon_team(r["Team"]) == name and "Showmatch" not in r["Page"] and r["Page"].split("/")[1].startswith("2026")]
        own.sort(key=lambda r: page_rank(r["Page"]))
        roster, roster_roles, staff_list = [], [], []
        if own:
            last = own[-1]
            for link, role in zip((last["Links"] or "").split(";;"), (last["Roles"] or "").split(";;")):
                link, role = link.strip(), role.strip()
                if role in ROLES and link.lower() in player_ids:
                    roster.append(player_ids[link.lower()])
                    roster_roles.append(role)
                elif role not in ROLES and link.lower() in staff_ids and staff_ids[link.lower()] not in staff_list:
                    staff_list.append(staff_ids[link.lower()])
        logo_owner = parent or tid  # academies use the parent club's logo
        path = logo_dir / f"{logo_owner}.png"
        if fetch_logos and not path.exists() and logo_owner in WIKI_LOGOS:
            fetch_wiki_logo(*WIKI_LOGOS[logo_owner], path)
        logo = f"logos/{logo_owner}.png" if path.exists() else None
        colors = MANUAL_COLORS.get(logo_owner) or (logo_colors(OUT_DIR / logo) if logo else ["#888888", "#222222"])
        titles = Counter(TITLES_BEFORE_2025.get(tid, {}))
        titles.update(titles_2526.get(name, {}))
        academy = next((t[0] for t in TEAMS if t[4] == tid), None)
        teams.append({
            "id": tid, "name": name, "nameKo": name_ko, "short": (team_rows.get(name) or {}).get("Short") or tid,
            "tier": tier, "parent": parent, "academy": academy, "colors": colors, "logo": logo,
            "wealth": wealth, "fans": fans, "lastRoster": roster, "lastRosterRoles": roster_roles, "lastStaff": staff_list,
            "titles": {k: titles.get(k, 0) for k in ("lck", "msi", "worlds", "cup", "firstStand", "ewc")},
        })
    return teams


def check_one_record_per_person(players, staff):
    """The game treats every id as a separate person: two ids for one person let him sign twice."""
    ids = Counter(x["id"].lower() for x in players + staff)
    twice = sorted(k for k, n in ids.items() if n > 1)
    if twice:
        raise SystemExit(f"one person has more than one player/staff record (ids differ only in case or are in both): {twice}")


def sanity(players, staff, teams):
    for tier in (1, 2):
        print(f"\n== tier {tier}: {sum(1 for p in players if p['tier'] == tier)} players")
        for role in ROLES:
            group = sorted((p for p in players if p["tier"] == tier and p["role"] == role), key=lambda p: -p["ovr"])
            print(f"-- {role} ({len(group)})")
            for p in group[:15 if tier == 1 else 6]:
                a = p["attrs"]
                print(f"  {p['ovr']:>3} {p['name']:<12} {p['lastTeam']:<22} g{p['games']:>4} intl{p['intl']:>3} fame{p['fame']:>4} "
                      f"lan{a['laning']} tf{a['teamfight']} mac{a['macro']} mech{a['mechanics']} con{a['consistency']} pool{a['pool']}")
    print("\nOVR distribution tier1:", Counter(p["ovr"] // 5 * 5 for p in players if p["tier"] == 1))
    print("OVR distribution tier2:", Counter(p["ovr"] // 5 * 5 for p in players if p["tier"] == 2))
    print("\nfame top 10:", [(p["name"], p["fame"]) for p in sorted(players, key=lambda p: -p["fame"])[:10]])
    print("\nstaff:", len(staff), Counter(s["role"] for s in staff))
    for s in sorted(staff, key=lambda s: -s["fame"])[:12]:
        print(f"  {s['fame']:>3} {s['name']:<12} {s['role']:<16} {s['lastTeam']:<24} {s['record']} titles {s['titles']}")
    print("\nteams:")
    for t in teams:
        print(f"  {t['id']:<6} {t['nameKo']:<16} logo={t['logo']} colors={t['colors']} roster={len(t['lastRoster'])} staff={len(t['lastStaff'])} titles={t['titles']}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-logos", action="store_true")
    parser.add_argument("--sanity", action="store_true")
    args = parser.parse_args()

    rows = game_rows()
    add_zscores(rows)
    gd15, solo, tl_games = timeline_stats()
    winners = event_winners()
    people = people_by_link()
    champ_id = champion_lookup()
    players = build_players(rows, gd15, solo, tl_games, winners, people, champ_id)
    tr_rows = load("tr")
    players += roster_only_players(players, tr_rows, people)
    add_fame(players)
    players.sort(key=lambda p: (p["tier"], -p["ovr"]))
    staff = build_staff(tr_rows, load("rc_staff"), rows, winners, people, players)
    staff.sort(key=lambda s: (s["tier"], -s["fame"]))
    check_one_record_per_person(players, staff)
    teams = build_teams(tr_rows, players, staff, winners, fetch_logos=not args.no_logos)

    today = date.today().isoformat()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "players.json").write_text(json.dumps({"generated": today, "players": players}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "staff.json").write_text(json.dumps({"generated": today, "staff": staff}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "teams.json").write_text(json.dumps({"generated": today, "eventWinners": winners, "teams": teams}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"players {len(players)} (tier1 {sum(p['tier'] == 1 for p in players)}, tier2 {sum(p['tier'] == 2 for p in players)}), "
          f"staff {len(staff)}, teams {len(teams)} ({sum(1 for t in teams if t['logo'])} with logos)")
    if args.sanity:
        sanity(players, staff, teams)
    return 0


if __name__ == "__main__":
    sys.exit(main())
