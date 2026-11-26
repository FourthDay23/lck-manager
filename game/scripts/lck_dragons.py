"""Dragon / soul / elder behaviour in the 502 LCK 2026 games (benchmark for the match engine's dragon play).

Reads ../data/raw/*.json.gz (Riot match-v5 data + timeline). Run from the game folder:
    python -I scripts/lck_dragons.py [--json out.json]

Per non-elder dragon kill: taker, stacks before (taker, other), team gold lead of the taker (totalGold, linearly
interpolated between the 60 s frames), champions alive per team (deaths from CHAMPION_KILL with the Riot respawn
formula), kills in the last 60 s, cross-map trades by the other team (tower / plate / grubs / herald / baron within
[-60 s, +30 s]), seconds since the dragon spawned (5:00, kill + 5:00). scripts/dragon-curve.ts prints the same
tables for the engine.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path

GAME_ROOT = Path(__file__).resolve().parent.parent
RAW = GAME_ROOT.parent / "data" / "raw"
DRAGON_PIT = (9866, 4414)

BRW = [10, 10, 12, 12, 14, 16, 20, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5]


def respawn_s(level: int, t_s: float) -> float:
    m = t_s / 60
    tif = 0.0
    if m > 15:
        tif += min(m - 15, 15) * 2 * 0.00425
    if m > 30:
        tif += min(m - 30, 15) * 2 * 0.003
    if m > 45:
        tif += min(m - 45, 10) * 2 * 0.0145
    return BRW[max(1, min(18, level)) - 1] * (1 + min(0.5, tif))


def unwrap(p: dict) -> dict:
    return p.get("info", p)


def bucket(lead: float) -> str:
    a = abs(lead)
    return "<1k" if a < 1000 else "1-3k" if a < 3000 else "3-6k" if a < 6000 else ">6k"


BUCKETS = ["<1k", "1-3k", "3-6k", ">6k"]


def process(path: Path) -> dict | None:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        raw = json.load(fh)
    info = unwrap(raw["data"])
    frames = unwrap(raw["timeline"])["frames"]
    side_of = {p["participantId"]: (0 if p["teamId"] == 100 else 1) for p in info["participants"]}
    dur = info["gameDuration"] / (1000 if info["gameDuration"] > 20_000 else 1)

    def team_gold(ts: float) -> tuple[float, float]:
        i = min(int(ts // 60_000), len(frames) - 1)
        while i > 0 and frames[i]["timestamp"] > ts:
            i -= 1
        j = min(i + 1, len(frames) - 1)
        g = []
        for f in (frames[i], frames[j]):
            s = [0.0, 0.0]
            for pid_text, pf in f["participantFrames"].items():
                pid = int(pid_text)
                if pid in side_of:
                    s[side_of[pid]] += pf.get("totalGold", 0)
            g.append(s)
        t0, t1 = frames[i]["timestamp"], frames[j]["timestamp"]
        w = 0 if t1 <= t0 else max(0.0, min(1.0, (ts - t0) / (t1 - t0)))
        return (g[0][0] * (1 - w) + g[1][0] * w, g[0][1] * (1 - w) + g[1][1] * w)

    def level_at(pid: int, ts: float) -> int:
        i = min(int(ts // 60_000), len(frames) - 1)
        while i > 0 and frames[i]["timestamp"] > ts:
            i -= 1
        return frames[i]["participantFrames"].get(str(pid), {}).get("level", 1)

    events = [e for f in frames for e in f.get("events", [])]
    events.sort(key=lambda e: e.get("timestamp", 0))
    deaths: list[tuple[float, float, int]] = []  # (t, until, side)
    kills: list[tuple[float, int]] = []  # (t, killer side)
    trades: list[tuple[float, int, str]] = []  # (t, side that gained, what)
    drag: list[dict] = []
    elders = 0
    elder_by: list[tuple[float, int]] = []
    elder_ctx: list[dict] = []
    soul = None
    soul_t = None
    for e in events:
        et = e.get("type")
        ts = e.get("timestamp", 0) / 1000
        if et == "CHAMPION_KILL":
            v = e.get("victimId", 0)
            if v not in side_of:
                continue
            deaths.append((ts, ts + respawn_s(level_at(v, ts * 1000), ts), side_of[v]))
            kills.append((ts, 1 - side_of[v]))
        elif et == "BUILDING_KILL" and e.get("buildingType") == "TOWER_BUILDING":
            owner = 0 if e.get("teamId") == 100 else 1
            trades.append((ts, 1 - owner, "tower"))
        elif et == "BUILDING_KILL" and e.get("buildingType") == "INHIBITOR_BUILDING":
            owner = 0 if e.get("teamId") == 100 else 1
            trades.append((ts, 1 - owner, "inhib"))
        elif et == "TURRET_PLATE_DESTROYED":
            owner = 0 if e.get("teamId") == 100 else 1
            trades.append((ts, 1 - owner, "plate"))
        elif et == "ELITE_MONSTER_KILL":
            mt = e.get("monsterType")
            side = {100: 0, 200: 1}.get(e.get("killerTeamId"))
            if side is None and e.get("killerId", 0) in side_of:
                side = side_of[e["killerId"]]
            if side is None:
                continue
            if mt == "DRAGON" and e.get("monsterSubType") == "ELDER_DRAGON":
                elders += 1
                elder_by.append((ts, side))
                g = team_gold(ts * 1000)
                alive = [5 - sum(1 for (t0, t1, sd) in deaths if sd == x and t0 <= ts < t1) for x in (0, 1)]
                elder_ctx.append({"lead": g[side] - g[1 - side], "more_alive": alive[side] > alive[1 - side]})
                continue
            if mt in ("HORDE", "RIFTHERALD", "BARON_NASHOR"):
                trades.append((ts, side, {"HORDE": "grubs", "RIFTHERALD": "herald", "BARON_NASHOR": "baron"}[mt]))
                continue
            if mt != "DRAGON":
                continue
            assists = e.get("assistingParticipantIds", []) or []
            drag.append({"t": ts, "side": side, "contested": any(side_of.get(a) == 1 - side for a in assists),
                         "parts": len({a for a in assists if side_of.get(a) == side} | ({e.get("killerId")} if side_of.get(e.get("killerId")) == side else set()))})
        elif et == "DRAGON_SOUL_GIVEN":
            pass
    stacks = [0, 0]
    out = []
    prev_t = None
    for d in drag:
        s = d["side"]
        ts = d["t"]
        g = team_gold(ts * 1000)
        alive = [5 - sum(1 for (t0, t1, sd) in deaths if sd == x and t0 <= ts < t1) for x in (0, 1)]
        k60 = [sum(1 for (t0, ks) in kills if ks == x and ts - 60 <= t0 <= ts) for x in (0, 1)]
        tr = Counter(w for (t0, sd, w) in trades if sd == 1 - s and ts - 60 <= t0 <= ts + 30)
        spawn = 300 if prev_t is None else prev_t + 300
        # champions (alive) within 3,000 u of the pit in the last 60 s frame before the kill
        fi = min(int(ts * 1000 // 60_000), len(frames) - 1)
        while fi > 0 and frames[fi]["timestamp"] > ts * 1000:
            fi -= 1
        near = [0, 0]
        for pid_text, pf in frames[fi]["participantFrames"].items():
            pid = int(pid_text)
            if pid not in side_of or pf.get("championStats", {}).get("health", 1) <= 0:
                continue
            if math.hypot(pf["position"]["x"] - DRAGON_PIT[0], pf["position"]["y"] - DRAGON_PIT[1]) < 3000:
                near[0 if side_of[pid] == s else 1] += 1
        out.append({
            "near": tuple(near),
            "t": ts, "my": stacks[s], "th": stacks[1 - s], "lead": g[s] - g[1 - s],
            "alive": (alive[s], alive[1 - s]), "k60": (k60[s], k60[1 - s]),
            "trade": dict(tr), "since": ts - spawn, "contested": d["contested"], "parts": d["parts"],
        })
        stacks[s] += 1
        prev_t = ts
        if stacks[s] >= 4 and soul is None:
            soul = s
            soul_t = ts
    g15 = team_gold(15 * 60_000) if dur > 15 * 60 else None
    g25 = team_gold(25 * 60_000) if dur > 25 * 60 else None
    return {"stacks": stacks, "soul": soul, "elders": elders, "drag": out, "dur": dur,
            "g15": g15, "g25": g25, "soul_t": soul_t, "elder_by": elder_by, "elder_ctx": elder_ctx,
            "win": 0 if any(t["win"] for t in info["teams"] if t["teamId"] == 100) else 1}


def pct(a: float, b: float) -> str:
    return f"{100 * a / b:5.1f}%" if b else "   - "


def report(games: list[dict]) -> dict:
    N = len(games)
    res: dict = {"games": N}
    dr = [d for g in games for d in g["drag"]]
    split = Counter()
    for g in games:
        a, b = sorted(g["stacks"])
        split[f"{a}-{b}" + (" soul" if g["soul"] is not None else "")] += 1
    souls = sum(1 for g in games if g["soul"] is not None)
    zero4 = sum(1 for g in games if sorted(g["stacks"]) == [0, 4])
    print(f"games {N} | dragons/game {len(dr) / N:.2f} | elder/game {sum(g['elders'] for g in games) / N:.3f} | soul {souls / N:.3f} | "
          f"0-4 {zero4 / N:.3f} of games ({zero4 / max(1, souls):.2f} of souls) | length {statistics.fmean(g['dur'] for g in games) / 60:.1f} min")
    print("split (sorted final non-elder counts):", "  ".join(f"{k}:{pct(v, N).strip()}" for k, v in sorted(split.items(), key=lambda kv: -kv[1])))
    sg = [g for g in games if g["soul"] is not None]
    st_ = sorted(g["soul_t"] for g in sg)
    opp = [g for g in sg if g["dur"] > g["soul_t"] + 360]
    el_soul = sum(1 for g in sg for (_, s) in g["elder_by"] if s == g["soul"])
    print(f"soul at median {st_[len(st_) // 2] / 60:.1f} min | soul team wins {pct(sum(1 for g in sg if g['win'] == g['soul']), len(sg)).strip()} | "
          f"game still on when elder spawns {pct(len(opp), len(sg)).strip()} of soul games | elder kills per such game "
          f"{sum(g['elders'] for g in opp) / max(1, len(opp)):.2f} (by the soul team {pct(el_soul, max(1, sum(g['elders'] for g in sg))).strip()}) | "
          f"game length after soul median {statistics.median(g['dur'] - g['soul_t'] for g in sg) / 60:.1f} min")
    ec = [c for g in games for c in g["elder_ctx"]]
    if ec:
        print(f"elder takes: taker ahead in gold {pct(sum(1 for c in ec if c['lead'] > 0), len(ec)).strip()} | taker had more alive "
              f"{pct(sum(1 for c in ec if c['more_alive']), len(ec)).strip()} (n={len(ec)})")
    g15 =[abs(g["g15"][0] - g["g15"][1]) for g in games if g["g15"]]
    g25 = [abs(g["g25"][0] - g["g25"][1]) for g in games if g["g25"]]
    t15 = [sum(g["g15"]) / 2 for g in games if g["g15"]]
    print(f"team gold 15:00 {statistics.fmean(t15):.0f} (median |lead| {statistics.median(g15):.0f}) | median |lead| 25:00 {statistics.median(g25):.0f}")
    # curve
    print("P(gold leader takes the dragon) by |lead| at the kill:")
    curve = {}
    for name, sel in (("all", lambda d: True), ("soul point (a team on 3)", lambda d: max(d["my"], d["th"]) == 3),
                      ("1st-2nd dragon", lambda d: d["my"] + d["th"] < 2), ("3rd+ non-soul-point", lambda d: d["my"] + d["th"] >= 2 and max(d["my"], d["th"]) < 3)):
        row = []
        for bk in BUCKETS:
            ds = [d for d in dr if sel(d) and bucket(d["lead"]) == bk and d["lead"] != 0]
            n = len(ds)
            w = sum(1 for d in ds if d["lead"] > 0)
            row.append((bk, n, w / n if n else float("nan")))
        curve[name] = row
        print(f"  {name:28s} " + "  ".join(f"{bk:>5s} {p * 100:5.1f}% (n={n})" for bk, n, p in row))
    res["curve"] = curve
    # by stack state
    print("P(team with more stacks takes the next dragon) by stacks before (more-fewer):")
    st = defaultdict(lambda: [0, 0])
    for d in dr:
        a, b = d["my"], d["th"]
        key = f"{max(a, b)}-{min(a, b)}"
        st[key][0] += 1
        if a > b:
            st[key][1] += 1
    print("  " + "  ".join(f"{k}: {v[1] / v[0] * 100:5.1f}% (n={v[0]})" for k, v in sorted(st.items()) if k[0] != k[2]))
    # who takes when tied in stacks: by gold
    # trailing-team takes: what goes with them
    print("dragons by the taker's gold position (lead of the taker):")
    for name, sel in (("taker ahead >1k", lambda d: d["lead"] > 1000), ("even ±1k", lambda d: abs(d["lead"]) <= 1000), ("taker behind >1k", lambda d: d["lead"] < -1000)):
        ds = [d for d in dr if sel(d)]
        n = len(ds)
        if not n:
            continue
        numadv = sum(1 for d in ds if d["alive"][0] > d["alive"][1])
        numdis = sum(1 for d in ds if d["alive"][0] < d["alive"][1])
        k_up = sum(1 for d in ds if d["k60"][0] > d["k60"][1])
        trade = sum(1 for d in ds if d["trade"])
        trade_big = sum(1 for d in ds if any(k in d["trade"] for k in ("tower", "herald", "grubs", "baron", "inhib")))
        since = sorted(d["since"] for d in ds)
        cont = sum(1 for d in ds if d["contested"])
        print(f"  {name:17s} n={n:4d} | taker has more alive {pct(numadv, n)} fewer {pct(numdis, n)} | won kills last 60 s {pct(k_up, n)} | "
              f"other side traded (any {pct(trade, n)}, tower/epic {pct(trade_big, n)}) | enemy in assists {pct(cont, n)} | "
              f"since spawn median {statistics.median(since):.0f} s, <60 s {pct(sum(1 for x in since if x < 60), n)}")
    # why the gold-trailing side got it: first matching reason, in this order
    def why(d: dict) -> str:
        if any(k in d["trade"] for k in ("tower", "herald", "grubs", "baron", "inhib")):
            return "leader took tower/epic"
        if d["contested"]:
            return "contested"
        if d["alive"][0] > d["alive"][1]:
            return "more alive"
        if d["k60"][0] > d["k60"][1]:
            return "won kills 60 s"
        if d["trade"]:
            return "leader took plates"
        return "nothing seen"
    for name, sel in (("taker behind >1k", lambda d: d["lead"] < -1000), ("taker ahead >1k", lambda d: d["lead"] > 1000)):
        ds = [d for d in dr if sel(d)]
        c = Counter(why(d) for d in ds)
        print(f"  reasons, {name}: " + "  ".join(f"{k} {pct(v, len(ds)).strip()}" for k, v in c.most_common()))
    print("contested share (enemy in assists) by stacks before (taker-other):",
          "  ".join(f"{k}: {pct(v[1], v[0]).strip()} (n={v[0]})" for k, v in sorted(
              ((k, [sum(1 for d in dr if f"{d['my']}-{d['th']}" == k), sum(1 for d in dr if f"{d['my']}-{d['th']}" == k and d["contested"])])
               for k in {f"{d['my']}-{d['th']}" for d in dr}), key=lambda kv: kv[0]) if v[0] >= 20))
    # soul point: the team on 3 by its gold position
    for name, sel in (("team on 3 ahead >1k", lambda lead: lead > 1000), ("±1k", lambda lead: abs(lead) <= 1000), ("team on 3 behind >1k", lambda lead: lead < -1000)):
        n = w = 0
        for d in dr:
            if max(d["my"], d["th"]) != 3 or d["my"] == d["th"]:
                continue
            lead3 = d["lead"] if d["my"] == 3 else -d["lead"]
            if not sel(lead3):
                continue
            n += 1
            w += d["my"] == 3
        print(f"  soul point, {name}: team on 3 takes {pct(w, n)} (n={n})")
    # k-0 states: does the team with all the stacks take the next one, by its own gold position
    row = []
    for name, sel in (("stack leader ahead >1k", lambda l: l > 1000), ("±1k", lambda l: abs(l) <= 1000), ("behind >1k", lambda l: l < -1000)):
        n = w = 0
        for d in dr:
            if not (d["my"] + d["th"] > 0 and min(d["my"], d["th"]) == 0):
                continue
            lead_sl = d["lead"] if d["my"] > 0 else -d["lead"]
            if not sel(lead_sl):
                continue
            n += 1
            w += d["my"] > 0
        row.append(f"{name} {pct(w, n).strip()} (n={n})")
    print("  k-0 states (1-0, 2-0, 3-0), P(the team with the stacks takes the next): " + " | ".join(row))
    # who was around shortly before (last minute frame before the kill, alive, within 3,000 u of the pit)
    for name, sel in (("all", lambda d: True), ("taker ahead >1k", lambda d: d["lead"] > 1000), ("taker behind >1k", lambda d: d["lead"] < -1000)):
        ds = [d for d in dr if sel(d)]
        oth = Counter(min(d["near"][1], 5) for d in ds)
        tak = Counter(min(d["near"][0], 5) for d in ds)
        print(f"  frame before the kill, {name:16s}: other side within 3,000 u " + " ".join(f"{k}:{pct(oth[k], len(ds)).strip()}" for k in range(6)) +
              " | taker side " + " ".join(f"{k}:{pct(tak[k], len(ds)).strip()}" for k in range(6)))
    # numbers at the kill overall
    eq = Counter((min(5, d["alive"][0]), min(5, d["alive"][1])) for d in dr)
    print("alive (taker v other) at the kill, top:", "  ".join(f"{a}v{b}:{pct(v, len(dr)).strip()}" for (a, b), v in eq.most_common(8)))
    since = sorted(d["since"] for d in dr)
    q = lambda p: since[int(p * (len(since) - 1))]
    print(f"seconds from spawn to kill: P25 {q(0.25):.0f} | median {q(0.5):.0f} | P75 {q(0.75):.0f} | P90 {q(0.9):.0f}")
    parts = Counter(d["parts"] for d in dr)
    print("taker champions credited:", "  ".join(f"{k}:{pct(v, len(dr)).strip()}" for k, v in sorted(parts.items())))
    # gold-lead curve restricted to equal numbers (no pick) vs a pick
    for name, sel in (("equal alive", lambda d: d["alive"][0] == d["alive"][1]), ("taker-side numbers differ", lambda d: d["alive"][0] != d["alive"][1])):
        row = []
        for bk in BUCKETS:
            ds = [d for d in dr if sel(d) and bucket(d["lead"]) == bk and d["lead"] != 0]
            n = len(ds)
            w = sum(1 for d in ds if d["lead"] > 0)
            row.append(f"{bk:>5s} {w / n * 100 if n else float('nan'):5.1f}% (n={n})")
        print(f"  leader-takes, {name:26s} " + "  ".join(row))
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    ap.add_argument("--raw", default=str(RAW), help="folder with the *.json.gz timelines (default ../data/raw)")
    args = ap.parse_args()
    games = []
    for p in sorted(Path(args.raw).glob("*.json.gz")):
        g = process(p)
        if g:
            games.append(g)
    res = report(games)
    if args.json:
        Path(args.json).write_text(json.dumps(res, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
