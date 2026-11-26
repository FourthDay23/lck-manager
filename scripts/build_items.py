"""Build game/public/data/items.json: LCK 2026 item builds, keystones and kill/objective bounty numbers.

  python -I scripts/build_items.py [--index data/games_lck_2026.json] [--version 16.23.1]

Sources
  * The Riot match-v5 match + timeline of every game in the index (data/raw/*.json.gz, 502 LCK 2026 games,
    patches 16.1-16.16).
  * Data Dragon <version> item.json (ko_KR, en_US) and runesReforged.json (ko_KR) in data/ddragon/<version>/.
    An item id completed in the games but missing from <version> is taken from the ko_KR item.json of the
    newest patch it was bought on (<major>.<minor>.1, e.g. 3097 Stormrazor -> 16.16.1), marked
    "removed": true and given "iconVer" so the CDN icon URL works. Missing Data Dragon files are downloaded
    once (User-Agent lolsim-research/0.1); existing files are kept. Names are ko_KR; en_US only labels the
    console output.

Roles
  teamPosition/individualPosition are garbage in these tournament games (mostly "AFK"), so the role comes
  from the participant order, Top, Jungle, Mid, Bot, Support per team (it agrees with the Leaguepedia
  roster in the index for every participant whose champion name matches).

Finished items (all from Data Dragon fields, nothing hand-listed except the support quest chain)
  legendary  on Summoner's Rift (maps["11"]), not Boots/Consumable/Trinket, no requiredChampion, gold total
             >= 1500 and no "into" left after dropping targets that are off map 11, not in store, or Ornn
             upgrades (requiredAlly). The 1500 floor (instead of ~2200) only adds Mejai's Soulstealer;
             the cheapest real legendaries in these games cost 2200 (support items).
             Archangel's Staff / Manamune / Winter's Approach / Whispering Circlet count under the id that is
             bought; their transformed forms (Seraph's, Muramana, ...) never appear in ITEM_PURCHASED.
  boots      tier-2 boots: Boots tag and built from 1001 (Boots). Tier-3 boots (the Mid role-quest upgrade)
             are never bought, so the tier-2 purchase is the completion.
  support    the final forms of the support quest (the "into" of 3867 World's Fruit: 3869/3870/3871/3876/3877).
             3865 is granted at 0:00 and upgrades on its own, so there is no ITEM_PURCHASED: the
             completion time is the ITEM_DESTROYED of 3867 and the form is read from the final inventory
             (or an ITEM_PURCHASED/ITEM_SOLD of a form).
  A legendary or boots is completed at its ITEM_PURCHASED timestamp; an ITEM_UNDO with beforeId cancels the
  latest live purchase of that id. Only the first completion of each id counts, and only the first tier-2
  boots / support form per player-game.
  Each finished item lists its direct components (`from`, Data Dragon); `parts` has every component item down the
  tree ({name, cost, from}), so the game can show the components bought toward the next item.

Per champion (and per role in roleDefaults)
  role          the champion's most played role in these games.
  roles         only for flex picks (3+ games in two or more roles): the same fields per role, so a top
                Camille does not get the support Camille build. The game falls back to the role default
                when a champion is used in a role it has no games in and the builds would not carry over.
  n/w           player-games and wins.
  builds        "core" = ordered first three completed legendaries (no boots, no support item). Exact
                sequences are grouped; top 3 by n (ties: w, then ids). If fewer than 3 games reached three
                legendaries, all non-empty cores (shorter ones included) are grouped instead. "boots" is the
                most common first tier-2 boots among that group's games (null if none).
  path          greedy merge: repeatedly take, in every game, the first legendary not yet chosen and add the
                most common one (ties: lower mean position, then id); up to 5 others. Boots (most common
                first tier-2 boots) are inserted after the median number of legendaries finished before them.
                Champions mostly played as Support (and the Support role default) start with their most
                common support form and keep up to 4 legendaries. At most 6 items.
  keystones     top 3 (keystone, secondary tree) pairs by n; the keystone is the first primary selection.
  spike         mean minute of the 1st/2nd/3rd completed legendary over the games that reached it.

Bounty ("bounty" section; every number is measured by this script, nothing is copied from the web)
  Kill rows are CHAMPION_KILL events with a champion killer. Gold values come from the frame before the
  kill (frame i holds events in (t[i-1], t[i]]). Streaks are rebuilt from the events: kill streak = kills
  since last death, assists = assists since last death, death streak = deaths since last kill.
  * CHAMPION_KILL.bounty is the base kill gold: level-scaled, reduced by death streak, +first blood. It does
    NOT include shutdownBounty; the killer gets bounty + shutdownBounty. Checked with per-minute totalGold:
    a baseline (CS, jungle CS, level-ups, role) is fitted on quiet minutes, then the residual gold of minutes
    with exactly one kill is regressed on bounty and shutdownBounty ("goldCheck").
  * killBase/killLevel: modal bounty per victim level among victims with no death streak and no first blood.
  * deathStreak: [deaths, 300 * mean(bounty / level base)] - the reduction is also driven by how far behind in
    gold the victim is, so deathStreakFit fits mult = 1 - deaths * (a + b * max(0, r0 - rel)) with
    rel = victim gold / mean gold of all 10 and a 100 gold floor (grid over r0 with least squares for a, b,
    then a pattern search on the squared error of the clamped model).
  * shutdown: fitted min(cap, a*kills + c*assists + b*max(0, lead)) * clamp((teamLead - t0) / t1, 0, 1)
    (coarse grid over t0, t1 with least squares for a, c, b, then a pattern search on the squared error of
    the clipped model). The victim's own lead is tried as victim minus the mean of all 10 and as victim
    minus the enemy laner, with and without the team factor; the best team-factor model by squared error
    is kept and all four are written to shutdown.compare.
  * assist: residual gold of minutes with exactly one assist, by number of assisters.
  * objective: bounty > 0 on BUILDING_KILL / ELITE_MONSTER_KILL vs the taking team's gold deficit at the
    event time (interpolated between frames), the OBJECTIVE_BOUNTY_PRESTART activations, and a team-level
    gold regression showing the value is a team total.

Output is deterministic (sorted iteration, fixed tie-breaks, grid and pattern searches) and compact.
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import json
import os
import re
import statistics
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "game" / "public" / "data" / "items.json"
CHAMPIONS = ROOT / "game" / "public" / "data" / "champions.json"
DDRAGON = ROOT / "data" / "ddragon"
CDN = "https://ddragon.leagueoflegends.com/cdn"
HEADERS = {"User-Agent": "lolsim-research/0.1"}
ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]

LEGENDARY_MIN_GOLD = 1500
SUPPORT_LAST_STAGE = "3867"  # World's Fruit; its "into" are the final support items
SHUTDOWN_CAP = 700  # the largest shutdownBounty in the data (134 kills sit exactly on it)
KILL_FLOOR = 100  # the smallest kill bounty in the data (99/100)

# ko_KR <stats> labels -> output keys. Only haste/leth/mpen are missing from Data Dragon "stats".
DESC_STATS = {"공격력": "ad", "주문력": "ap", "체력": "hp", "방어력": "armor", "마법 저항력": "mr",
              "공격 속도": "as", "치명타 확률": "crit", "스킬 가속": "haste", "물리 관통력": "leth",
              "마법 관통력": "mpen", "이동 속도": "ms"}
DD_STATS = {"FlatPhysicalDamageMod": ("ad", 1), "FlatMagicDamageMod": ("ap", 1), "FlatHPPoolMod": ("hp", 1),
            "FlatArmorMod": ("armor", 1), "FlatSpellBlockMod": ("mr", 1), "PercentAttackSpeedMod": ("as", 100),
            "FlatCritChanceMod": ("crit", 100), "FlatMovementSpeedMod": ("ms", 1)}
STAT_ORDER = ["ad", "ap", "hp", "armor", "mr", "as", "crit", "haste", "leth", "mpen", "ms"]


# --------------------------------------------------------------------------------------------- helpers

def r1(x):
    """One decimal, or an int when it is whole."""
    x = round(float(x), 1)
    return int(x) if x == int(x) else x


def fetch(path: Path, url: str) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        path.write_bytes(response.read())
    print(f"  downloaded {url}")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_retry(path: Path, text: str) -> None:
    """Write through a temp file and os.replace; retry while another process (dev server, scanner) holds the file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except OSError:
            if attempt == 19:
                raise
            time.sleep(0.5)


def solve(a, b):
    """Gaussian elimination with partial pivoting (small dense systems)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-9:
            continue  # degenerate column: its coefficient stays 0
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c and m[r][c]:
                f = m[r][c] / m[c][c]
                for k in range(c, n + 1):
                    m[r][k] -= f * m[c][k]
    return [m[i][n] / m[i][i] if abs(m[i][i]) >= 1e-9 else 0.0 for i in range(n)]


def lstsq(xs, ys):
    """Ordinary least squares through normal equations; xs is a list of feature lists."""
    k = len(xs[0])
    ata = [[0.0] * k for _ in range(k)]
    aty = [0.0] * k
    for x, y in zip(xs, ys):
        for i in range(k):
            xi = x[i]
            if xi:
                aty[i] += xi * y
                row = ata[i]
                for j in range(k):
                    row[j] += xi * x[j]
    return solve(ata, aty)


def refine(fun, x, steps, halvings=8):
    """Deterministic pattern search: try +/- step on each parameter, halve the steps when nothing improves."""
    x, fx, steps = list(x), fun(x), list(steps)
    while halvings > 0:
        improved = False
        for i in range(len(x)):
            for sign in (1, -1):
                y = list(x)
                y[i] += sign * steps[i]
                fy = fun(y)
                if fy < fx:
                    x, fx, improved = y, fy, True
                    break
        if not improved:
            steps = [s / 2 for s in steps]
            halvings -= 1
    return x, fx


def mean(values):
    return statistics.fmean(values) if values else 0.0


def pct(values, q):
    values = sorted(values)
    k = (len(values) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


# --------------------------------------------------------------------------------------------- items

def item_stats(item) -> dict:
    stats = {}
    for key, (name, scale) in DD_STATS.items():
        value = item.get("stats", {}).get(key, 0)
        if value:
            stats[name] = value * scale
    block = re.search(r"<stats>(.*?)</stats>", item.get("description", ""))
    for part in (block.group(1).split("<br>") if block else []):
        value = re.search(r"<attention>\s*([\d.]+)\s*(%?)\s*</attention>", part)
        if not value:
            continue
        label = re.sub(r"<[^>]+>", "", re.sub(r"<attention>.*?</attention>", "", part)).strip()
        key = DESC_STATS.get(label)
        if not key or key in stats:
            continue
        if value.group(2) and key in ("mpen", "ms"):
            continue  # percent magic pen / move speed have no key in the schema
        stats[key] = float(value.group(1))
    return {k: r1(stats[k]) for k in STAT_ORDER if stats.get(k)}


def classify(iid: str, data: dict) -> str | None:
    """'legendary' | 'boots' | None for one Data Dragon item (support forms are handled separately)."""
    item = data.get(iid)
    if not item or not item.get("maps", {}).get("11"):
        return None
    tags = set(item.get("tags", []))
    if "Boots" in tags:
        return "boots" if "1001" in item.get("from", []) else None
    if tags & {"Consumable", "Trinket"} or item.get("requiredChampion") or item.get("consumed"):
        return None
    if item["gold"]["total"] < LEGENDARY_MIN_GOLD:
        return None
    into = [t for t in item.get("into", []) if t in data and data[t].get("maps", {}).get("11")
            and data[t].get("inStore", True) is not False and not data[t].get("requiredAlly")]
    return None if into else "legendary"


# --------------------------------------------------------------------------------------------- per game

def game_players(data, timeline, kind_of, support_forms):
    """One record per participant: role, champion name, win, runes, ordered completions."""
    parts = data["participants"]
    purchases = defaultdict(list)  # pid -> [[t, id, live]]
    support_done = {}
    form_events = defaultdict(list)
    for frame in timeline["frames"]:
        for e in frame["events"]:
            kind, pid = e["type"], e.get("participantId", 0)
            if kind == "ITEM_PURCHASED":
                purchases[pid].append([e["timestamp"], e["itemId"], True])
                if e["itemId"] in support_forms:
                    form_events[pid].append(e["itemId"])
            elif kind == "ITEM_UNDO" and e.get("beforeId"):
                for rec in reversed(purchases[pid]):
                    if rec[1] == e["beforeId"] and rec[2]:
                        rec[2] = False
                        break
            elif kind == "ITEM_SOLD" and e.get("itemId") in support_forms:
                form_events[pid].append(e["itemId"])
            elif kind == "ITEM_DESTROYED" and str(e.get("itemId")) == SUPPORT_LAST_STAGE and pid not in support_done:
                support_done[pid] = e["timestamp"]
    players = []
    for i, p in enumerate(parts):
        pid = i + 1
        seq, seen, boots_done = [], set(), False
        for t, iid, live in purchases[pid]:
            kind = kind_of(iid) if live else None
            if not kind or iid in seen or (kind == "boots" and boots_done):
                continue
            seen.add(iid)
            boots_done |= kind == "boots"
            seq.append((t, iid, kind))
        if pid in support_done:
            forms = [it for it in (p[f"item{s}"] for s in range(7)) if it in support_forms] or form_events[pid]
            if forms:
                seq.append((support_done[pid], forms[0], "support"))
                seq.sort()
        styles = p["perks"]["styles"]
        primary = next((s for s in styles if s.get("description") == "primaryStyle"), styles[0])
        sub = next((s for s in styles if s.get("description") == "subStyle"), styles[-1])
        players.append({"role": ROLES[i % 5], "championName": p["championName"], "win": bool(p["win"]),
                        "keystone": primary["selections"][0]["perk"], "tree": primary["style"], "sub": sub["style"],
                        "seq": seq})
    return players


def summarize(records, support_like: bool) -> dict:
    n = len(records)
    out = {"n": n, "w": sum(r["win"] for r in records)}
    legs = [[iid for _, iid, k in r["seq"] if k == "legendary"] for r in records]
    leg_t = [[t for t, _, k in r["seq"] if k == "legendary"] for r in records]
    boots = [next((iid for _, iid, k in r["seq"] if k == "boots"), None) for r in records]

    cores = [tuple(l[:3]) for l in legs]
    full = [i for i, c in enumerate(cores) if len(c) == 3]
    pool = full if len(full) >= 3 else [i for i, c in enumerate(cores) if c]
    groups = defaultdict(list)
    for i in pool:
        groups[cores[i]].append(i)
    ranked = sorted(groups.items(), key=lambda kv: (-len(kv[1]), -sum(records[i]["win"] for i in kv[1]), kv[0]))
    builds = []
    for core, idx in ranked[:3]:
        bc = Counter(boots[i] for i in idx if boots[i])
        top_boots = min(bc, key=lambda b: (-bc[b], b)) if bc else None
        builds.append({"core": list(core), "boots": top_boots, "n": len(idx), "w": sum(records[i]["win"] for i in idx)})
    out["builds"] = builds

    # path: greedy "next most common legendary"
    sup_c = Counter(iid for r in records for _, iid, k in r["seq"] if k == "support")
    prefix = [min(sup_c, key=lambda s: (-sup_c[s], s))] if support_like and sup_c else []
    pos = defaultdict(list)
    for l in legs:
        for j, iid in enumerate(l):
            pos[iid].append(j)
    chosen = []
    while len(chosen) < 5 - len(prefix):
        votes = Counter()
        for l in legs:
            nxt = next((iid for iid in l if iid not in chosen), None)
            if nxt is not None:
                votes[nxt] += 1
        if not votes:
            break
        chosen.append(min(votes, key=lambda iid: (-votes[iid], mean(pos[iid]), iid)))
    bc = Counter(b for b in boots if b)
    path = list(chosen)
    if bc:
        top_boots = min(bc, key=lambda b: (-bc[b], b))
        before = []
        for r, b in zip(records, boots):
            if b:
                tb = next(t for t, iid, k in r["seq"] if k == "boots")
                before.append(sum(1 for t, _, k in r["seq"] if k == "legendary" and t < tb))
        path.insert(min(statistics.median_low(before), len(path)), top_boots)
    out["path"] = (prefix + path)[:6]

    kc = Counter((r["keystone"], r["sub"]) for r in records)
    kw = Counter((r["keystone"], r["sub"]) for r in records if r["win"])
    out["keystones"] = [{"id": k, "sub": s, "n": kc[(k, s)], "w": kw[(k, s)]}
                        for k, s in sorted(kc, key=lambda ks: (-kc[ks], -kw[ks], ks))[:3]]
    spike = []
    for j in range(3):
        ts = [t[j] for t in leg_t if len(t) > j]
        if not ts:
            break
        spike.append(r1(mean(ts) / 60000))
    out["spike"] = spike
    return out


# --------------------------------------------------------------------------------------------- bounty

class LevelClock:
    def __init__(self, timeline):
        self.ev = defaultdict(list)
        for frame in timeline["frames"]:
            for e in frame["events"]:
                if e["type"] == "LEVEL_UP":
                    self.ev[e["participantId"]].append((e["timestamp"], e["level"]))
        for v in self.ev.values():
            v.sort()
        self.ts = {p: [t for t, _ in v] for p, v in self.ev.items()}

    def at(self, pid, t):
        i = bisect.bisect_right(self.ts.get(pid, []), t)
        return max([1] + [lv for _, lv in self.ev[pid][:i]])


def kill_rows(timeline):
    frames = timeline["frames"]
    levels = LevelClock(timeline)
    fb_marks = {(e["timestamp"], e.get("killerId")) for f in frames for e in f["events"]
                if e["type"] == "CHAMPION_SPECIAL_KILL" and e.get("killType") == "KILL_FIRST_BLOOD"}
    ks, asd, ds = Counter(), Counter(), Counter()
    rows = []
    for fi, frame in enumerate(frames):
        prev = frames[fi - 1]["participantFrames"] if fi else frame["participantFrames"]
        gold = {p: prev[str(p)]["totalGold"] for p in range(1, 11)}
        for e in frame["events"]:
            if e["type"] != "CHAMPION_KILL":
                continue
            k, v, t = e.get("killerId", 0), e["victimId"], e["timestamp"]
            assists = e.get("assistingParticipantIds") or []
            if 1 <= k <= 10:
                vt = range(1, 6) if v <= 5 else range(6, 11)
                et = range(6, 11) if v <= 5 else range(1, 6)
                avg = sum(gold.values()) / 10
                rows.append({"t": t, "bounty": e["bounty"], "shutdown": e["shutdownBounty"], "fb": (t, k) in fb_marks,
                             "ks": ks[v], "as": asd[v], "ds": ds[v], "level": levels.at(v, t),
                             "rel": gold[v] / avg, "leadAvg": gold[v] - avg,
                             "leadLane": gold[v] - gold[v + 5 if v <= 5 else v - 5],
                             "team": sum(gold[p] for p in vt) - sum(gold[p] for p in et)})
                ks[k] += 1
                ds[k] = 0
            for a in assists:
                asd[a] += 1
            ks[v] = asd[v] = 0
            ds[v] += 1
    return rows


def gold_minutes(timeline, quiet, killer_one, assist_one, team_rows, pool_share):
    """Per-minute totalGold deltas for the gold checks."""
    frames = timeline["frames"]
    for i in range(3, len(frames)):
        a, b = frames[i - 1]["participantFrames"], frames[i]["participantFrames"]
        if not 59000 <= frames[i]["timestamp"] - frames[i - 1]["timestamp"] <= 61000:
            continue
        events = frames[i]["events"]
        involved = defaultdict(list)
        skip = set()
        team = {100: defaultdict(float), 200: defaultdict(float)}
        for e in events:
            kind = e["type"]
            if kind in ("ITEM_SOLD", "ITEM_UNDO"):
                skip.add(e["participantId"])
            elif kind == "CHAMPION_KILL":
                k = e.get("killerId", 0)
                assists = e.get("assistingParticipantIds") or []
                if 1 <= k <= 10:
                    involved[k].append(("k", e))
                    side = team[100 if k <= 5 else 200]
                    side["kill"] += e["bounty"] + e["shutdownBounty"]
                    side["kill"] += e["bounty"] * pool_share.get(len(assists), 0)
                for p in assists:
                    involved[p].append(("a", e))
                involved[e["victimId"]].append(("v", e))
            elif kind == "BUILDING_KILL":
                side = team[300 - e["teamId"]]
                side["obj"] += e.get("bounty", 0)
                side["b_" + (e.get("towerType") or e.get("buildingType", ""))] += 1
            elif kind == "TURRET_PLATE_DESTROYED":
                team[300 - e["teamId"]]["plate"] += 1
            elif kind == "ELITE_MONSTER_KILL" and e.get("killerTeamId") in team:
                side = team[e["killerTeamId"]]
                side["obj"] += e.get("bounty", 0)
                side["m_" + e.get("monsterType", "")] += 1
        if i >= 15:
            for side, ps in ((100, range(1, 6)), (200, range(6, 11))):
                f = team[side]
                f["cs"] = sum(b[str(p)]["minionsKilled"] - a[str(p)]["minionsKilled"] for p in ps)
                f["jcs"] = sum(b[str(p)]["jungleMinionsKilled"] - a[str(p)]["jungleMinionsKilled"] for p in ps)
                f["const"] = 1
                team_rows.append((dict(f), sum(b[str(p)]["totalGold"] - a[str(p)]["totalGold"] for p in ps)))
        if any(e["type"] in ("BUILDING_KILL", "TURRET_PLATE_DESTROYED", "ELITE_MONSTER_KILL") for e in events):
            continue
        for p in range(1, 11):
            role = (p - 1) % 5
            if p in skip or role == 4:
                continue  # supports earn support-quest gold the baseline cannot see
            pa, pb = a[str(p)], b[str(p)]
            x = [pb["minionsKilled"] - pa["minionsKilled"], pb["jungleMinionsKilled"] - pa["jungleMinionsKilled"],
                 pb["level"] - pa["level"]] + [1.0 if role == j else 0.0 for j in range(4)]
            y = pb["totalGold"] - pa["totalGold"]
            inv = involved[p]
            if not inv:
                quiet.append((x, y))
            elif len(inv) == 1 and inv[0][0] == "k":
                killer_one.append((x, y, inv[0][1]["bounty"], inv[0][1]["shutdownBounty"]))
            elif len(inv) == 1 and inv[0][0] == "a":
                e = inv[0][1]
                assist_one.append((x, y, e["bounty"], e["shutdownBounty"], len(e["assistingParticipantIds"])))


def objective_rows(timeline, rows, activations):
    frames = timeline["frames"]

    def team_gold(fi, t):
        """Team totalGold at time t, interpolated between the frames around the event."""
        if fi == 0:
            pf = frames[0]["participantFrames"]
            return {100: sum(pf[str(p)]["totalGold"] for p in range(1, 6)), 200: sum(pf[str(p)]["totalGold"] for p in range(6, 11))}
        a, b = frames[fi - 1], frames[fi]
        w = (t - a["timestamp"]) / (b["timestamp"] - a["timestamp"]) if b["timestamp"] > a["timestamp"] else 1.0
        gold = {p: a["participantFrames"][str(p)]["totalGold"] * (1 - w) + b["participantFrames"][str(p)]["totalGold"] * w
                for p in range(1, 11)}
        return {100: sum(gold[p] for p in range(1, 6)), 200: sum(gold[p] for p in range(6, 11))}

    for fi, frame in enumerate(frames):
        for e in frame["events"]:
            kind = e["type"]
            if kind == "OBJECTIVE_BOUNTY_PRESTART":
                g = team_gold(fi, e["timestamp"])
                deficit = g[300 - e["teamId"]] - g[e["teamId"]]
                activations.append({"t": e["timestamp"], "start": e.get("actualStartTime", e["timestamp"]),
                                    "deficit": deficit, "rel": deficit / (g[100] + g[200])})
            elif kind in ("BUILDING_KILL", "ELITE_MONSTER_KILL"):
                if kind == "BUILDING_KILL":
                    taking = 300 - e["teamId"]
                    typ = e.get("towerType") if e.get("buildingType") == "TOWER_BUILDING" else "INHIBITOR"
                else:
                    taking = e.get("killerTeamId")
                    typ = "ELDER_DRAGON" if e.get("monsterSubType") == "ELDER_DRAGON" else e.get("monsterType")
                if taking not in (100, 200):
                    continue
                g = team_gold(fi, e["timestamp"])
                rows.append({"t": e["timestamp"], "type": typ, "bounty": e.get("bounty", 0) or 0,
                             "deficit": g[300 - taking] - g[taking]})


def shutdown_pred(p, ks, asx, lead, team, use_team=True):
    a, c, b, t0, t1 = p
    m = min(1.0, max(0.0, (team - t0) / t1)) if use_team else 1.0
    return min(SHUTDOWN_CAP, max(0.0, a * ks + c * asx + b * lead)) * m


def fit_shutdown(rows, lead_key, use_team):
    """Coarse (t0, t1) grid with least squares for (a, c, b), then a pattern search on the squared error of the
    clipped model. Returns sse, mae, r2 and params (a, c, b, t0, t1)."""
    y = [r["shutdown"] for r in rows]
    everything = [(r["ks"], r["as"], max(0.0, r[lead_key]), r["team"], v) for r, v in zip(rows, y)]
    # rows with no kills, assists or lead always predict 0: their error is a constant
    data = [d for d in everything if d[0] or d[1] or d[2]]
    const = sum(d[4] ** 2 for d in everything if not (d[0] or d[1] or d[2]))
    ybar = mean(y)
    sst = sum((v - ybar) ** 2 for v in y)

    def ls(t0, t1):
        s = [0.0] * 9
        for ks, asx, lead, team, v in data:
            m = min(1.0, max(0.0, (team - t0) / t1)) if use_team else 1.0
            if m <= 0:
                continue
            x0, x1, x2 = m * ks, m * asx, m * lead
            s[0] += x0 * x0; s[1] += x0 * x1; s[2] += x0 * x2; s[3] += x1 * x1; s[4] += x1 * x2; s[5] += x2 * x2
            s[6] += x0 * v; s[7] += x1 * v; s[8] += x2 * v
        return solve([[s[0], s[1], s[2]], [s[1], s[3], s[4]], [s[2], s[4], s[5]]], [s[6], s[7], s[8]])

    def sse(p):
        a, c, b, t0, t1 = p
        if t1 <= 0:
            return float("inf")
        total = 0.0
        for ks, asx, lead, team, v in data:
            raw = a * ks + c * asx + b * lead
            raw = SHUTDOWN_CAP if raw > SHUTDOWN_CAP else (raw if raw > 0 else 0.0)
            if use_team:
                m = (team - t0) / t1
                raw *= 1.0 if m > 1 else (m if m > 0 else 0.0)
            total += (raw - v) * (raw - v)
        return total + const

    if use_team:
        grid = [(t0, t1) for t0 in range(-3000, 1001, 500) for t1 in range(1000, 10001, 1000)]
        start = min(([*ls(t0, t1), t0, t1] for t0, t1 in grid), key=sse)
        params, err = refine(sse, start, [10, 2, 0.002, 100, 200])
    else:
        params = [*ls(0, 1), 0, 1]
        params, err = refine(lambda p: sse(p[:3] + [0, 1]), params[:3], [10, 2, 0.002])
        params = params + [0, 1]
        err = sse(params)
    mae = mean([abs(shutdown_pred(params, ks, asx, lead, team, use_team) - v) for ks, asx, lead, team, v in everything])
    return {"sse": err, "mae": mae, "r2": 1 - err / sst, "params": params, "useTeam": use_team}


def build_bounty(kills, quiet, killer_one, assist_one, team_rows, objectives, activations, games):
    out = {}
    # ---- base kill gold by victim level
    clean = [r for r in kills if r["ds"] == 0 and not r["fb"]]
    by_level = defaultdict(Counter)
    for r in clean:
        by_level[r["level"]][r["bounty"]] += 1
    level_mode = {lv: min(c, key=lambda g: (-c[g], g)) for lv, c in by_level.items()}
    kill_base = Counter(level_mode[lv] for lv in level_mode if lv <= 6).most_common(1)[0][0]
    steps = [level_mode[lv] - level_mode[lv - 1] for lv in range(7, 19) if lv in level_mode and lv - 1 in level_mode]
    per_level = int(round(statistics.median(steps)))
    free = max((lv for lv in level_mode if level_mode[lv] == kill_base), default=6)
    cap = max(level_mode.values())

    def base_gold(level):
        return min(cap, kill_base + per_level * max(0, level - free))

    fb_extra = Counter(r["bounty"] - base_gold(r["level"]) for r in kills if r["fb"]).most_common(1)[0][0]
    for r in kills:
        r["base"] = base_gold(r["level"]) + (fb_extra if r["fb"] else 0)
    exact = sum(r["bounty"] == r["base"] for r in kills)
    exact_clean = sum(r["bounty"] == r["base"] for r in kills if r["ds"] == 0)
    out["killBase"] = kill_base
    out["killLevel"] = {"formula": f"{kill_base} + {per_level:g} * max(0, victimLevel - {free}), at most {cap}",
                        "perLevel": per_level, "fromLevel": free, "max": cap,
                        "byLevel": [[lv, level_mode[lv], sum(by_level[lv].values())] for lv in sorted(level_mode)],
                        "exactShare": round(exact / len(kills), 3),
                        "exactShareNoDeathStreak": round(exact_clean / sum(1 for r in kills if r["ds"] == 0), 3)}
    out["firstBloodExtra"] = fb_extra

    # ---- death streak
    table = []
    for d in range(0, 8):
        s = [r["bounty"] / r["base"] for r in kills if (r["ds"] == d if d < 7 else r["ds"] >= 7)]
        if s:
            table.append([d, round(kill_base * mean(s))])
    out["deathStreak"] = table
    mult_by_ds = {d: g / kill_base for d, g in table}

    def ds_pred(r, a, b, r0):
        mult = 1 - r["ds"] * (a + b * max(0.0, r0 - r["rel"]))
        return max(min(r["base"], KILL_FLOOR), r["base"] * min(1.0, max(0.0, mult)))

    streaky = [r for r in kills if r["ds"] > 0]  # deaths == 0 never changes with the parameters

    streak_data = [(r["base"], r["ds"], r["rel"], r["bounty"], min(r["base"], KILL_FLOOR)) for r in streaky]

    def ds_sse(p):
        a, b, r0 = p
        total = 0.0
        for base, d, rel, v, floor in streak_data:
            mult = 1 - d * (a + b * (r0 - rel if r0 > rel else 0.0))
            pred = base * (1.0 if mult > 1 else (mult if mult > 0 else 0.0))
            pred = pred if pred > floor else floor
            total += (pred - v) * (pred - v)
        return total

    starts = []
    for i in range(90, 131, 2):
        r0 = i / 100
        a, b = lstsq([[r["base"] * r["ds"], r["base"] * r["ds"] * max(0.0, r0 - r["rel"])] for r in streaky],
                     [r["base"] - r["bounty"] for r in streaky])
        starts.append([a, b, r0])
    (a, b, r0), _ = refine(ds_sse, min(starts, key=ds_sse), [0.01, 0.05, 0.02], halvings=12)
    mae = mean([abs(ds_pred(r, a, b, r0) - r["bounty"]) for r in kills])
    out["deathStreakFit"] = {
        "formula": "bounty = max(100, base * (1 - deaths * (perDeath + perDeficit * max(0, relPivot - rel)))), "
                   "base = killLevel formula (+ firstBloodExtra), deaths = victim deaths since last kill, "
                   "rel = victim totalGold / mean totalGold of all 10 at the frame before the kill",
        "params": {"perDeath": round(a, 4), "perDeficit": round(b, 4), "relPivot": round(r0, 3), "floor": KILL_FLOOR},
        "mae": r1(mae), "maeTable": r1(mean([abs(r["base"] * mult_by_ds[min(r["ds"], 7)] - r["bounty"]) for r in kills])),
        "maeNoReduction": r1(mean([abs(r["base"] - r["bounty"]) for r in kills])), "n": len(kills),
        "tableNote": "deathStreak = [victim deaths since last kill (7 = 7+), 300 * mean(bounty / base)]: the gold for a "
                     "level 1-6 victim; scale by base / 300 for higher levels"}

    # ---- shutdown
    compare = {}
    for lead_key, label in (("leadAvg", "avg10"), ("leadLane", "laner")):
        for use_team in (True, False):
            compare[(label, use_team)] = fit_shutdown(kills, lead_key, use_team)
    (lead_label, _), best = min(((k, v) for k, v in compare.items() if k[1]), key=lambda kv: kv[1]["sse"])
    lead_key = "leadAvg" if lead_label == "avg10" else "leadLane"
    a, c, b, t0, t1 = best["params"]
    y = [r["shutdown"] for r in kills]
    pred = [shutdown_pred(best["params"], r["ks"], r["as"], max(0.0, r[lead_key]), r["team"]) for r in kills]
    pos = [i for i, v in enumerate(y) if v > 0]

    def buckets(key, edges):
        rows = []
        for lo, hi in zip(edges, edges[1:] + [None]):
            s = [r["shutdown"] for r in kills if (r[key] >= lo or lo == edges[0]) and (hi is None or r[key] < hi)]
            if s:
                rows.append([lo, r1(mean(s)), len(s)])
        return rows

    by_streak = []
    for k in range(0, 9):
        s = [r["shutdown"] for r in kills if (r["ks"] == k if k < 8 else r["ks"] >= 8)]
        if s:
            by_streak.append([k, r1(mean(s)), len(s)])
    lead_name = "victim totalGold - mean totalGold of all 10" if lead_key == "leadAvg" else "victim totalGold - enemy laner totalGold"
    out["shutdown"] = {
        "formula": f"shutdown = min({SHUTDOWN_CAP}, max(0, perKill * K + perAssist * A + perGoldLead * max(0, G))) "
                   "* clamp((T - teamFrom) / (teamFull - teamFrom), 0, 1); K = victim kills since last death, "
                   f"A = victim assists since last death, G = {lead_name}, T = victim team totalGold - enemy team totalGold, "
                   "all at the frame before the kill. shutdownBounty is paid to the killer on top of bounty.",
        "params": {"perKill": r1(a), "perAssist": r1(c), "perGoldLead": round(b, 4), "teamFrom": round(t0),
                   "teamFull": round(t0 + t1), "cap": SHUTDOWN_CAP, "lead": lead_label},
        "fit": {"mae": r1(best["mae"]), "maeIfZero": r1(mean(y)), "maeWhenPaid": r1(mean([abs(pred[i] - y[i]) for i in pos])),
                "r2": round(best["r2"], 3), "n": len(y), "shareNonZero": round(len(pos) / len(y), 3),
                "maxSeen": max(y), "atCap": sum(1 for v in y if v == SHUTDOWN_CAP)},
        "compare": {f"{label}{'+team' if team else ''}": {"r2": round(v["r2"], 3), "mae": r1(v["mae"])}
                    for (label, team), v in sorted(compare.items())},
        "tableNote": "byStreak [victim kills since last death (8 = 8+), mean shutdownBounty, kills]; byLead (G) and "
                     "byTeamLead (T) [bucketStart, mean shutdownBounty, kills], first bucket also holds everything below, "
                     "last everything above",
        "byStreak": by_streak,
        "byLead": buckets(lead_key, list(range(-3000, 4001, 500))),
        "byTeamLead": buckets("team", list(range(-4000, 8001, 1000))),
    }

    # ---- gold checks (killer and assist shares)
    coef = lstsq([x for x, _ in quiet], [y for _, y in quiet])

    def resid(x, y):
        return y - sum(ci * xi for ci, xi in zip(coef, x))

    alpha, beta = lstsq([[bt, sd] for _, _, bt, sd in killer_one], [resid(x, y) for x, y, _, _ in killer_one])
    shares = []
    pool_share = {}
    for k in range(1, 5):
        s = [(resid(x, y), bt, sd) for x, y, bt, sd, n in assist_one if n == k]
        if not s:
            continue
        share = mean([v for v, _, _ in s]) / mean([bt for _, bt, _ in s])
        sb, ss = lstsq([[bt, sd] for _, bt, sd in s], [v for v, _, _ in s])
        shares.append([k, round(share, 3), round(share * k, 3), round(ss, 3), len(s)])
        pool_share[k] = share * k
    out["goldCheck"] = {
        "note": "per-minute totalGold residuals after a CS/jungle CS/level-up/role baseline fitted on quiet minutes "
                "(no kill, no building, plate or epic monster in the minute; supports left out)",
        "killerPerBounty": round(alpha, 3), "killerPerShutdown": round(beta, 3), "killerMinutes": len(killer_one),
        "assist": [{"assisters": k, "eachPerBounty": s, "poolPerBounty": p, "eachPerShutdown": sd, "minutes": n}
                   for k, s, p, sd, n in shares],
        "baselineMinutes": len(quiet)}
    out["assist"] = ("Each assister gets about " + " / ".join(f"{s[1] * 100:.0f}%" for s in shares)
                     + " of the kill's bounty when " + " / ".join(str(s[0]) for s in shares)
                     + " champions assist (team pool " + " / ".join(f"{s[2] * 100:.0f}%" for s in shares)
                     + " of bounty, so the pool grows with more assisters instead of a flat 50% split); "
                       "shutdownBounty is not shared with assisters (fitted share about 0). Killer receives bounty + shutdownBounty.")

    # ---- objectives
    after = min(a["start"] for a in activations) if activations else 0
    late = [o for o in objectives if o["t"] >= after]
    by_type = {}
    for typ in sorted({o["type"] for o in objectives}):
        s = [o for o in objectives if o["type"] == typ]
        paid = [o["bounty"] for o in s if o["bounty"] > 0]
        entry = {"n": len(s), "paid": len(paid), "share": round(len(paid) / len(s), 3)}
        if paid:
            pc = Counter(paid)
            entry.update({"mode": min(pc, key=lambda g: (-pc[g], -g)), "mean": round(mean(paid)), "max": max(paid)})
        by_type[typ] = entry
    by_deficit = []
    edges = list(range(-2000, 9001, 1000))
    for lo, hi in zip(edges, edges[1:] + [None]):
        s = [o for o in late if (o["deficit"] >= lo or lo == edges[0]) and (hi is None or o["deficit"] < hi)]
        if s:
            paid = [o["bounty"] for o in s if o["bounty"] > 0]
            by_deficit.append([lo, len(s), round(len(paid) / len(s), 3), round(mean(paid)) if paid else 0])
    names = sorted({k for f, _ in team_rows for k in f})
    tcoef = lstsq([[f.get(k, 0) for k in names] for f, _ in team_rows], [g for _, g in team_rows])
    paid_all = [o for o in objectives if o["bounty"] > 0]
    out["objective"] = {
        "note": "bounty on BUILDING_KILL / ELITE_MONSTER_KILL is the team total paid to the taking team, only while an "
                "objective bounty is active for it: OBJECTIVE_BOUNTY_PRESTART (15 s warning) fires only after 14:00 and "
                "only for the team behind in gold. deficit = enemy team totalGold - taking team totalGold at the event time "
                "(interpolated between frames). activeFrom = earliest actualStartTime seen (s).",
        "activeFrom": round(after / 1000),
        "warning": round(mean([(a["start"] - a["t"]) / 1000 for a in activations])) if activations else None,
        "activations": len(activations),
        "gamesWithActivation": games["withActivation"],
        "activationDeficit": {"min": round(min(a["deficit"] for a in activations)),
                              "p10": round(pct([a["deficit"] for a in activations], 0.1)),
                              "p50": round(pct([a["deficit"] for a in activations], 0.5)),
                              "relMin": round(min(a["rel"] for a in activations), 3),
                              "relP10": round(pct([a["rel"] for a in activations], 0.1), 3),
                              "relP50": round(pct([a["rel"] for a in activations], 0.5), 3)} if activations else None,
        "minDeficitWhenPaid": round(min(o["deficit"] for o in paid_all)) if paid_all else None,
        "byType": by_type,
        "byDeficit": by_deficit,
        "byDeficitNote": "[deficitBucketStart, objectives taken after activeFrom, share with bounty > 0, mean bounty when paid]",
        "teamGoldPerBounty": round(tcoef[names.index("obj")], 2) if "obj" in names else None,
    }
    return out


# --------------------------------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", default=str(ROOT / "data" / "games_lck_2026.json"))
    parser.add_argument("--version", default="16.23.1")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    version = args.version
    vdir = DDRAGON / version
    for locale in ("ko_KR", "en_US"):
        fetch(vdir / f"item_{locale}.json", f"{CDN}/{version}/data/{locale}/item.json")
    fetch(vdir / "runesReforged_ko_KR.json", f"{CDN}/{version}/data/ko_KR/runesReforged.json")
    items_ko = load_json(vdir / "item_ko_KR.json")["data"]
    items_en = load_json(vdir / "item_en_US.json")["data"]
    runes = load_json(vdir / "runesReforged_ko_KR.json")
    champ_ids = [c["id"] for c in load_json(CHAMPIONS)["champions"]]
    by_lower = {c.lower(): c for c in champ_ids}
    support_forms = {int(i) for i in items_ko[SUPPORT_LAST_STAGE]["into"]}

    index = load_json(Path(args.index))
    games = []
    for game in index["games"]:
        raw = json.load(gzip.open(ROOT / game["raw"], "rt", encoding="utf-8"))
        if raw.get("timeline"):
            games.append(raw)
    games.sort(key=lambda g: g["data"]["gameId"])

    # Item ids bought but missing from <version>: newest patch they were bought on.
    newest_patch = {}
    for g in games:
        major, minor = g["data"]["gameVersion"].split(".")[:2]
        patch = (int(major), int(minor))
        for frame in g["timeline"]["frames"]:
            for e in frame["events"]:
                if e["type"] == "ITEM_PURCHASED" and str(e["itemId"]) not in items_ko:
                    newest_patch[e["itemId"]] = max(newest_patch.get(e["itemId"], patch), patch)
    old_data = {}
    for iid, (major, minor) in sorted(newest_patch.items()):
        old_version = f"{major}.{minor}.1"
        if old_version not in old_data:
            path = DDRAGON / old_version / "item_ko_KR.json"
            fetch(path, f"{CDN}/{old_version}/data/ko_KR/item.json")
            old_data[old_version] = load_json(path)["data"]
    removed = {}  # iid -> (version, data)
    for iid, (major, minor) in newest_patch.items():
        data = old_data[f"{major}.{minor}.1"]
        if str(iid) in data:
            removed[iid] = (f"{major}.{minor}.1", data)

    kinds = {}

    def kind_of(iid):
        if iid not in kinds:
            if str(iid) in items_ko:
                kinds[iid] = classify(str(iid), items_ko)
            elif iid in removed:
                kinds[iid] = classify(str(iid), removed[iid][1])
            else:
                kinds[iid] = None
        return kinds[iid]

    records = []
    unmapped = Counter()
    kills, quiet, killer_one, assist_one, team_rows, objectives, activations = [], [], [], [], [], [], []
    with_activation = 0
    patches = set()
    for g in games:
        data, timeline = g["data"], g["timeline"]
        major, minor = data["gameVersion"].split(".")[:2]
        patches.add((int(major), int(minor)))
        for rec in game_players(data, timeline, kind_of, support_forms):
            cid = by_lower.get(rec["championName"].lower())
            if not cid:
                unmapped[rec["championName"]] += 1
            rec["champ"] = cid
            records.append(rec)
        kills.extend(kill_rows(timeline))
        before = len(activations)
        objective_rows(timeline, objectives, activations)
        with_activation += len(activations) > before
    # First gold pass without the assist term to get the assist pool, then the team regression with it.
    for g in games:
        gold_minutes(g["timeline"], quiet, killer_one, assist_one, [], {})
    base_coef = lstsq([x for x, _ in quiet], [y for _, y in quiet])
    pool = {}
    for k in range(1, 5):
        s = [(y - sum(c * xi for c, xi in zip(base_coef, x)), bt) for x, y, bt, _, n in assist_one if n == k]
        if s:
            pool[k] = k * mean([v for v, _ in s]) / mean([bt for _, bt in s])
    for g in games:
        gold_minutes(g["timeline"], [], [], [], team_rows, pool)

    # ---- items
    item_n, item_w = Counter(), Counter()
    for rec in records:
        for _, iid, _ in rec["seq"]:
            item_n[iid] += 1
            item_w[iid] += rec["win"]
    items_out = {}
    for iid in sorted(item_n):
        sid = str(iid)
        if sid in items_ko:
            it, entry = items_ko[sid], {}
        else:
            ver, data = removed[iid]
            it, entry = data[sid], {"removed": True, "iconVer": ver}
        kind = "support" if iid in support_forms else ("boots" if kind_of(iid) == "boots" else "legendary")
        items_out[sid] = {"name": it["name"], "cost": it["gold"]["total"], "kind": kind, "stats": item_stats(it),
                          "n": item_n[iid], "w": item_w[iid], "from": [int(x) for x in it.get("from", [])], **entry}

    # ---- components: what each finished item is built from, all the way down (the match HUD shows the parts a
    # player has bought toward the next item)
    parts = {}

    def add_part(pid: str, src: dict) -> None:
        if pid in parts or pid in items_out:
            return
        p = src.get(pid) or items_ko.get(pid)
        if not p:
            return
        parts[pid] = {"name": p["name"], "cost": p["gold"]["total"], "from": [int(x) for x in p.get("from", [])]}
        for c in p.get("from", []):
            add_part(str(c), src)

    for sid, v in items_out.items():
        src = items_ko if sid in items_ko else removed[int(sid)][1]
        for c in v["from"]:
            add_part(str(c), src)

    # ---- keystones / trees
    trees, keystone_info = {}, {}
    for tree in runes:
        trees[str(tree["id"])] = {"name": tree["name"], "icon": tree["icon"]}
        for rune in tree["slots"][0]["runes"]:
            keystone_info[rune["id"]] = {"name": rune["name"], "tree": tree["id"], "treeName": tree["name"], "icon": rune["icon"]}
    ks_n = Counter(r["keystone"] for r in records)
    ks_w = Counter(r["keystone"] for r in records if r["win"])
    keystones = {}
    for k in sorted(ks_n, key=lambda k: (-ks_n[k], k)):
        info = keystone_info.get(k)
        if not info:
            print(f"  keystone {k} not in runesReforged {version}")
            continue
        keystones[str(k)] = {**info, "n": ks_n[k], "w": ks_w[k]}

    # ---- champions / roles
    by_champ = defaultdict(list)
    by_role = defaultdict(list)
    for rec in records:
        by_role[rec["role"]].append(rec)
        if rec["champ"]:
            by_champ[rec["champ"]].append(rec)
    champs = {}
    for cid in sorted(by_champ):
        recs = by_champ[cid]
        roles = Counter(r["role"] for r in recs)
        main_role = min(roles, key=lambda r: (-roles[r], ROLES.index(r)))
        champs[cid] = summarize(recs, main_role == "Support")
        # main role, and a separate entry per role for flex picks (support Camille builds nothing like top Camille)
        champs[cid]["role"] = main_role
        played = [r for r in ROLES if roles[r] >= 3]
        if len(played) >= 2:
            champs[cid]["roles"] = {r: summarize([x for x in recs if x["role"] == r], r == "Support") for r in played}
    role_defaults = {role: summarize(by_role[role], role == "Support") for role in ROLES}

    bounty = build_bounty(kills, quiet, killer_one, assist_one, team_rows, objectives, activations,
                          {"withActivation": with_activation})

    out = {"version": version, "games": len(games),
           "patches": [f"{a}.{b}" for a, b in sorted(patches)],
           "items": items_out, "parts": parts, "keystones": keystones, "trees": trees, "champs": champs,
           "roleDefaults": role_defaults, "bounty": bounty}
    write_retry(OUT, json.dumps(out, ensure_ascii=False, separators=(",", ":")))

    # ---- console report
    size = OUT.stat().st_size
    print(f"{len(games)} games, patches {out['patches'][0]}-{out['patches'][-1]} -> {OUT} ({size / 1024:.1f} KB)")
    print(f"items {len(items_out)} ({Counter(v['kind'] for v in items_out.values())}), keystones {len(keystones)}, "
          f"champs {len(champs)}, removed items {[(k, v['name'], v['iconVer']) for k, v in items_out.items() if v.get('removed')]}")
    print("unmapped champion names:", dict(unmapped) or "none")
    finished = sorted(k for k, v in kinds.items() if v)
    print("finished ids by rule (bought in games):", len(finished))
    print("not-finished but >= 2000 gold bought:", sorted({iid for iid, k in kinds.items() if not k and str(iid) in items_ko
                                                            and items_ko[str(iid)]["gold"]["total"] >= 2000}))
    en = lambda iid: items_en.get(str(iid), {}).get("name", items_out.get(str(iid), {}).get("name", iid))
    for cid in ("Aatrox", "Ahri", "Azir", "Rell"):
        if cid in champs:
            c = champs[cid]
            print(f"  {cid}: n={c['n']} w={c['w']} path={[en(i) for i in c['path']]} spike={c['spike']}")
    print(json.dumps({k: bounty[k] for k in ("killBase", "firstBloodExtra", "deathStreak", "assist")}, ensure_ascii=False))
    print(json.dumps({"killLevel": {k: v for k, v in bounty["killLevel"].items() if k != "byLevel"},
                      "deathStreakFit": bounty["deathStreakFit"], "goldCheck": bounty["goldCheck"]}, ensure_ascii=False))
    print(json.dumps({k: bounty["shutdown"][k] for k in ("params", "fit", "compare")}, ensure_ascii=False))
    print(json.dumps({k: v for k, v in bounty["objective"].items() if k not in ("note", "byDeficitNote")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
