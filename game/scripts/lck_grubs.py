"""Voidgrubs in real LCK 2026 games (raw Riot match-v5 timelines): the three grubs die one by one, so the timelines
show how many a team takes per visit, how often the two teams share the camp, when they die and why a team leaves
with one or two. Target numbers for scripts/grubs-diag.ts (same table from the engine).

Run: python -I scripts/lck_grubs.py [--raw ../data/raw] [--json out.json]

Facts the numbers rest on
  * ELITE_MONSTER_KILL with monsterType HORDE is one event per grub (killerTeamId 100 blue / 200 red; 300 = nobody:
    the grub was still alive when the camp left at 14:45, timestamp 885 s).
  * The camp spawns once, three grubs at 8:00; every game has exactly three HORDE events.
  * Participants 1-5 are blue Top/Jungle/Mid/Bot/Support, 6-10 red in the same order.
  * A VISIT is one team's run of kills with no gap over VISIT_GAP seconds and no kill by the other team in between
    (a jungler clearing the camp kills a grub every 2-12 s; 97 % of same-team gaps are under 15 s).
"""
from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter
from pathlib import Path

ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
PIT = (4750.0, 10100.0)   # centre of the HORDE kill positions (the baron pit)
NEAR = 2500.0             # a champion kill this close to the pit is "at the grubs"
VISIT_GAP = 20.0
SPAWN = 480.0


def role_of(pid: int) -> str:
    return ROLES[(pid - 1) % 5]


def team_of(pid: int) -> int:
    return 100 if 1 <= pid <= 5 else 200


def pct(a: float, b: float) -> str:
    return f"{100 * a / b:5.1f}%" if b else "   - "


def quant(xs: list[float], ps=(10, 25, 50, 75, 90)) -> str:
    if not xs:
        return "-"
    s = sorted(xs)
    return " / ".join(f"{s[min(len(s) - 1, int(len(s) * p / 100))]:.0f}" for p in ps)


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{int(t % 60):02d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(Path(__file__).resolve().parent.parent.parent / "data" / "raw"))
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    files = sorted(Path(args.raw).glob("*.json.gz"))

    games = 0
    split = Counter()            # (most, least, despawned)
    seq = Counter()              # order of takers, "A" = team of the first kill, "B" = the other, "-" = despawned
    visits = Counter()           # size of a visit
    visits_left = Counter()      # (size, grubs still alive after it)
    visits_per_game = Counter()
    first_t: list[float] = []
    kth_t: list[list[float]] = [[], [], []]
    span: list[float] = []       # first to last kill of a clean 3-0 single visit
    gap_in_visit: list[float] = []
    killer_role = Counter()
    part = Counter()             # same-team participants per grub (killer + own assists)
    foe_assist = 0
    kills_total = 0
    blue_kills = 0
    after_partial = Counter()    # what happened to the grubs a partial visit left
    partial_ctx = Counter()      # context of a partial visit
    partial_n = 0
    fight_games = 0              # a champion kill at the grubs between the spawn and the last grub
    shared_simul = 0             # 2-1 games where the two teams' kills are within VISIT_GAP of each other
    shared_n = 0
    lead_takes = Counter()       # gold lead at 8:00 of the side that took more grubs
    first_by_lead = Counter()
    start_delay: list[float] = []  # second visit: seconds after the previous visit's last kill
    win_by = Counter()           # (grubs a team took, won)

    for f in files:
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            payload = json.load(fh)
        tl = payload.get("timeline", payload)
        tl = tl.get("info", tl)
        frames = tl.get("frames") or []
        if not frames:
            continue
        info = (payload.get("data") or {}).get("info") or payload.get("data") or {}
        won = {t.get("teamId"): bool(t.get("win")) for t in info.get("teams") or []}
        grubs = []
        champ_kills = []
        for fr in frames:
            for ev in fr.get("events", []):
                ty = ev.get("type")
                if ty == "ELITE_MONSTER_KILL" and ev.get("monsterType") == "HORDE":
                    grubs.append((ev["timestamp"] / 1000, ev.get("killerTeamId"), ev.get("killerId") or 0, ev.get("assistingParticipantIds") or []))
                elif ty == "CHAMPION_KILL":
                    p = ev.get("position") or {}
                    champ_kills.append((ev["timestamp"] / 1000, ev.get("victimId") or 0, ev.get("killerId") or 0, p.get("x", 0), p.get("y", 0)))
        if not grubs:
            continue
        games += 1
        grubs.sort()
        taken = [g for g in grubs if g[1] in (100, 200)]
        gone = len(grubs) - len(taken)
        b = sum(1 for g in taken if g[1] == 100)
        r = len(taken) - b
        split[(max(b, r), min(b, r), gone)] += 1
        blue_kills += b
        if won:
            win_by[(b, won.get(100, False))] += 1
            win_by[(r, won.get(200, False))] += 1
        # order of takers
        if taken:
            a_team = taken[0][1]
            seq["".join("A" if g[1] == a_team else "B" for g in taken) + "-" * gone] += 1
        else:
            seq["---"] += 1
        # kills
        for i, g in enumerate(taken):
            kills_total += 1
            kth_t[i].append(g[0])
            killer_role[role_of(g[2]) if g[2] else "?"] += 1
            own = [a for a in g[3] if team_of(a) == g[1]]
            part[min(5, 1 + len(own))] += 1
            if len(own) != len(g[3]):
                foe_assist += 1
        if taken:
            first_t.append(taken[0][0])
        # visits
        vs: list[list[tuple]] = []
        for g in taken:
            if vs and vs[-1][-1][1] == g[1] and g[0] - vs[-1][-1][0] <= VISIT_GAP:
                vs[-1].append(g)
            else:
                vs.append([g])
        visits_per_game[len(vs)] += 1
        near_kills = [k for k in champ_kills if ((k[3] - PIT[0]) ** 2 + (k[4] - PIT[1]) ** 2) ** 0.5 < NEAR]
        last_t = taken[-1][0] if taken else 885.0
        if any(SPAWN - 30 <= k[0] <= last_t + 15 for k in near_kills):
            fight_games += 1
        done = 0
        for vi, v in enumerate(vs):
            done += len(v)
            left = len(taken) + gone - done
            visits[len(v)] += 1
            visits_left[(len(v), left)] += 1
            for x, y in zip(v, v[1:]):
                gap_in_visit.append(y[0] - x[0])
            if vi > 0:
                start_delay.append(v[0][0] - vs[vi - 1][-1][0])
            if left > 0:
                # a partial visit: what came next, and what was going on
                partial_n += 1
                team = v[0][1]
                t0, t1 = v[0][0], v[-1][0]
                nxt = vs[vi + 1] if vi + 1 < len(vs) else None
                if nxt is None:
                    after_partial["despawned (nobody came back)"] += 1
                elif nxt[0][1] == team:
                    after_partial["same team came back"] += 1
                elif nxt[0][0] - t1 <= VISIT_GAP:
                    after_partial["other team took the rest right there (within 20 s)"] += 1
                else:
                    after_partial["other team took the rest later"] += 1
                fight = [k for k in near_kills if t0 - 25 <= k[0] <= t1 + 25]
                own_died = any(team_of(k[1]) == team for k in fight)
                foe_died = any(team_of(k[1]) != team for k in fight)
                foe_touch = any(any(team_of(a) != team for a in g[3]) for g in v)
                foe_took_now = nxt is not None and nxt[0][1] != team and nxt[0][0] - t1 <= VISIT_GAP
                if own_died:
                    partial_ctx["a visitor's teammate died at the pit (+-25 s)"] += 1
                elif foe_died:
                    partial_ctx["only enemies died at the pit (+-25 s)"] += 1
                elif foe_took_now or foe_touch:
                    partial_ctx["no kill, the enemy hit grubs too (smite / contest)"] += 1
                else:
                    partial_ctx["no kill, no enemy on the grubs (left on their own)"] += 1
        if len(vs) == 1 and len(vs[0]) == 3:
            span.append(vs[0][-1][0] - vs[0][0][0])
        if (max(b, r), min(b, r)) == (2, 1):
            shared_n += 1
            ts = [(g[0], g[1]) for g in taken]
            if any(x[1] != y[1] and y[0] - x[0] <= VISIT_GAP for x, y in zip(ts, ts[1:])):
                shared_simul += 1
        # gold lead at 8:00 of the side that took more
        if taken and len(frames) > 8:
            pf = frames[8].get("participantFrames") or {}
            gb = sum(v.get("totalGold", 0) for k, v in pf.items() if int(k) <= 5)
            gr = sum(v.get("totalGold", 0) for k, v in pf.items() if int(k) > 5)
            more = 100 if b > r else 200 if r > b else 0
            if more:
                lead = (gb - gr) if more == 100 else (gr - gb)
                bucket = "ahead 1k+" if lead >= 1000 else "ahead 0.3-1k" if lead >= 300 else "even (+-300)" if lead > -300 else "behind 0.3-1k" if lead > -1000 else "behind 1k+"
                lead_takes[bucket] += 1
            fl = (gb - gr) if taken[0][1] == 100 else (gr - gb)
            first_by_lead["ahead" if fl > 0 else "behind"] += 1

    print(f"LCK 2026 voidgrubs: {games} games, {kills_total} grubs killed ({kills_total / games:.2f} a game), "
          f"{games * 3 - kills_total} left to despawn at 14:45")
    print("\n[1] camp split per game (most - least - despawned)")
    for k, v in sorted(split.items(), key=lambda x: -x[1]):
        print(f"  {k[0]}-{k[1]} (+{k[2]} despawned)  {v:4d}  {pct(v, games)}")
    shared = sum(v for k, v in split.items() if k[1] > 0)
    print(f"  both teams got a grub: {shared} {pct(shared, games)}; one team all three: {split[(3, 0, 0)]} {pct(split[(3, 0, 0)], games)}; "
          f"camp not finished (1+ despawned): {sum(v for k, v in split.items() if k[2] > 0)} {pct(sum(v for k, v in split.items() if k[2] > 0), games)}")
    print(f"  blue share of grubs: {pct(blue_kills, kills_total)}")
    print("\n[2] order of takers (A = team of the first grub, B = other, - = despawned)")
    for k, v in sorted(seq.items(), key=lambda x: -x[1]):
        print(f"  {k}  {v:4d}  {pct(v, games)}")
    nv = sum(visits.values())
    print(f"\n[3] visits (one team's run of kills, gaps <= {VISIT_GAP:.0f} s): {nv} ({nv / games:.2f} a game)")
    for n in (1, 2, 3):
        print(f"  {n} grub(s): {visits[n]:4d}  {pct(visits[n], nv)}")
    print("  visits per game: " + ", ".join(f"{k}: {v} ({pct(v, games).strip()})" for k, v in sorted(visits_per_game.items())))
    print("  (size, grubs left alive after it): " + ", ".join(f"{k}: {v}" for k, v in sorted(visits_left.items())))
    print(f"\n[4] partial visits (grubs still alive when the team stopped): {partial_n} ({pct(partial_n, nv).strip()} of visits)")
    print("  what happened to the rest:")
    for k, v in sorted(after_partial.items(), key=lambda x: -x[1]):
        print(f"    {k}: {v} {pct(v, partial_n)}")
    print("  what was going on:")
    for k, v in sorted(partial_ctx.items(), key=lambda x: -x[1]):
        print(f"    {k}: {v} {pct(v, partial_n)}")
    print(f"  later visit starts this long after the previous one ended (s, P10/25/50/75/90): {quant(start_delay)}")
    print("\n[5] timing")
    print(f"  first grub (s after 8:00, P10/25/50/75/90): {quant([t - SPAWN for t in first_t])}  median {mmss(sorted(first_t)[len(first_t) // 2])}")
    for i in range(3):
        xs = kth_t[i]
        print(f"  grub {i + 1}: median {mmss(sorted(xs)[len(xs) // 2])}, by 9:00 {pct(sum(1 for t in xs if t < 540), games)}, by 10:00 {pct(sum(1 for t in xs if t < 600), games)}, by 12:00 {pct(sum(1 for t in xs if t < 720), games)} (of all games)")
    print(f"  gap between kills inside a visit (s, P10/25/50/75/90): {quant(gap_in_visit)}")
    print(f"  clean 3-grub visit, first to third kill (s, P10/25/50/75/90): {quant(span)}")
    print("\n[6] who")
    print("  last hit by role: " + ", ".join(f"{r} {pct(killer_role[r], kills_total).strip()}" for r in ROLES))
    print("  own-team participants per grub (killer + assists) 1/2/3/4/5: " + " / ".join(pct(part[n], kills_total).strip() for n in range(1, 6)))
    print(f"  an enemy also damaged the grub (enemy in assists): {pct(foe_assist, kills_total).strip()}")
    print("\n[7] fights and leads")
    print(f"  games with a champion kill within {NEAR:.0f} u of the pit between 7:30 and the last grub: {fight_games} {pct(fight_games, games)}")
    print(f"  2-1 games where the teams' kills interleave within {VISIT_GAP:.0f} s (both in the pit): {shared_simul} of {shared_n} {pct(shared_simul, shared_n)}")
    tot = sum(lead_takes.values())
    print("  gold lead at 8:00 of the side that took more grubs: " + ", ".join(f"{k} {pct(lead_takes[k], tot).strip()}" for k in ["ahead 1k+", "ahead 0.3-1k", "even (+-300)", "behind 0.3-1k", "behind 1k+"]))
    ft = sum(first_by_lead.values())
    print(f"  the first grub went to the side ahead in gold at 8:00: {pct(first_by_lead['ahead'], ft).strip()}")
    print("\n[8] result")
    print("  win rate by the grubs a team took: " + ", ".join(
        f"{n}: {pct(win_by[(n, True)], win_by[(n, True)] + win_by[(n, False)]).strip()} (n={win_by[(n, True)] + win_by[(n, False)]})" for n in range(4)))

    if args.json:
        out = {
            "games": games, "killed": kills_total, "split": {f"{k[0]}-{k[1]}+{k[2]}": v for k, v in split.items()},
            "seq": dict(seq), "visits": {str(k): v for k, v in visits.items()}, "partial": partial_n,
            "afterPartial": dict(after_partial), "partialCtx": dict(partial_ctx),
            "firstMedian": sorted(first_t)[len(first_t) // 2], "killerRole": dict(killer_role),
            "participants": {str(k): v for k, v in part.items()},
        }
        Path(args.json).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
