"""Fetch every Leaguepedia Cargo listing the manager game data needs, caching each one.

Run once (about 15 minutes because anonymous Cargo queries must be spaced out); reruns read
the cache in data/cargo_cache/game_*.json and only fetch what is missing.

  python scripts/fetch_game_data.py

Outputs (all lists of Cargo rows):
  game_sp_<league>_<year>.json   ScoreboardPlayers + ScoreboardGames (stats, game length, team kills)
  game_sp_intl.json              ScoreboardPlayers at First Stand / MSI / Worlds / EWC 2025-2026
  game_pb_lck.json               PicksAndBansS7 for LCK 2025-2026 (bans)
  game_tr.json                   TournamentRosters for LCK and LCK CL 2025-2026 (players + coaches)
  game_rc_staff.json             RosterChanges rows for staff (Head Coach / Coach / Strategic Coach ...)
  game_people.json               PlayerRedirects -> Players (real name, country, birthdate) for everyone above
  game_results.json              TournamentResults first places (LCK, MSI, Worlds), for team titles
  game_teams.json                Teams table rows (short name, logo file) for the 20 game teams
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_leaguepedia import cargo_all  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cargo_cache"
SECONDS_BETWEEN_QUERIES = 8.0

INTL_PAGES = [
    "2025 First Stand", "2026 First Stand",
    "2025 Mid-Season Invitational", "2026 Mid-Season Invitational",
    "2025 Season World Championship/Main Event", "2025 Season World Championship/Play-In",
    "2026 Season World Championship/Main Event", "2026 Season World Championship/Play-In",
    "Esports World Cup 2025", "Esports World Cup 2026",
]

LCK_TEAMS = ["T1", "Gen.G", "Hanwha Life Esports", "Dplus Kia", "KT Rolster", "BNK FEARX", "DN SOOPers",
             "Nongshim RedForce", "HANJIN BRION", "Kiwoom DRX"]
CL_TEAMS = ["T1 Esports Academy", "Gen.G Global Academy", "Hanwha Life Esports Challengers", "Dplus Kia Challengers",
            "KT Rolster Challengers", "BNK FEARX Youth", "DN SOOPers Challengers", "Nongshim Esports Academy",
            "HANJIN BRION Challengers", "Kiwoom DRX Challengers"]

_last_query = [0.0]


def cached(name: str, **query) -> list[dict]:
    path = CACHE / f"game_{name}.json"
    if path.exists():
        rows = json.loads(path.read_text(encoding="utf-8"))
        print(f"{name}: {len(rows)} rows (cache)", flush=True)
        return rows
    wait = SECONDS_BETWEEN_QUERIES - (time.time() - _last_query[0])
    if wait > 0:
        time.sleep(wait)
    print(f"{name}: fetching ...", flush=True)
    rows = cargo_all(**query)
    _last_query[0] = time.time()
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    print(f"{name}: {len(rows)} rows", flush=True)
    return rows


def quoted_list(names) -> str:
    return ",".join('"' + n.replace('"', '\\"') + '"' for n in names)


SP_FIELDS = ("SP.GameId=GameId,SP.Link=Link,SP.Champion=Champion,SP.Role=Role,SP.Side=Side,SP.Team=Team,"
             "SP.Kills=K,SP.Deaths=D,SP.Assists=A,SP.Gold=Gold,SP.CS=CS,SP.DamageToChampions=Dmg,"
             "SP.VisionScore=VS,SP.PlayerWin=Win,SP.DateTime_UTC=DT,SP.OverviewPage=Page,"
             "SG.Gamelength_Number=Len,SG.Team1Kills=T1K,SG.Team2Kills=T2K")


def main() -> int:
    CACHE.mkdir(parents=True, exist_ok=True)
    links: set[str] = set()

    for league, prefix in (("lck", "LCK/"), ("cl", "LCK CL/")):
        for year in ("2025", "2026"):
            rows = cached(f"sp_{league}_{year}", tables="ScoreboardPlayers=SP,ScoreboardGames=SG",
                          join_on="SP.GameId=SG.GameId", fields=SP_FIELDS,
                          where=f'SP.GameId LIKE "{prefix}{year}%"', order_by="SP.GameId")
            links.update(r["Link"] for r in rows if r.get("Link"))

    cached("sp_intl", tables="ScoreboardPlayers=SP", fields="SP.GameId=GameId,SP.Link=Link,SP.Team=Team,SP.OverviewPage=Page,SP.PlayerWin=Win",
           where=f"SP.OverviewPage IN ({quoted_list(INTL_PAGES)})", order_by="SP.GameId")

    bans = ",".join(f"PB.Team{t}Ban{i}=T{t}B{i}" for t in (1, 2) for i in range(1, 6))
    cached("pb_lck", tables="PicksAndBansS7=PB", fields=f"PB.GameId=GameId,{bans}",
           where='PB.GameId LIKE "LCK/2025%" OR PB.GameId LIKE "LCK/2026%"', order_by="PB.GameId")

    tr = cached("tr", tables="TournamentRosters=TR", fields="TR.Team=Team,TR.OverviewPage=Page,TR.RosterLinks=Links,TR.Roles=Roles",
                where='TR.OverviewPage LIKE "LCK/2025%" OR TR.OverviewPage LIKE "LCK/2026%" '
                      'OR TR.OverviewPage LIKE "LCK CL/2025%" OR TR.OverviewPage LIKE "LCK CL/2026%"',
                order_by="TR.OverviewPage")
    staff_links: set[str] = set()
    for row in tr:
        for link, role in zip((row["Links"] or "").split(";;"), (row["Roles"] or "").split(";;")):
            link = link.strip()
            if not link:
                continue
            if role.strip() in ("Top", "Jungle", "Mid", "Bot", "Support"):
                links.add(link)
            else:
                staff_links.add(link)

    staff_sorted = sorted(staff_links)
    rc_rows: list[dict] = []
    for start in range(0, len(staff_sorted), 40):
        chunk = staff_sorted[start:start + 40]
        rc_rows += cached(f"rc_staff_{start // 40}", tables="RosterChanges=RC",
                          fields="RC.Date_Sort=Date,RC.Player=Player,RC.Direction=Direction,RC.Team=Team,RC.Role=Role",
                          where=f'RC.Player IN ({quoted_list(chunk)}) AND RC.Date_Sort >= "2023-11-01"',
                          order_by="RC.Date_Sort")
    (CACHE / "game_rc_staff.json").write_text(json.dumps(rc_rows, ensure_ascii=False), encoding="utf-8")

    everyone = sorted(links | staff_links)
    people: list[dict] = []
    for start in range(0, len(everyone), 50):
        chunk = everyone[start:start + 50]
        people += cached(f"people_{start // 50}", tables="PlayerRedirects=PR,Players=P",
                         join_on="PR.OverviewPage=P.OverviewPage",
                         fields="PR.AllName=Asked,P.OverviewPage=Page,P.ID=ID,P.Name=Name,P.NativeName=Native,"
                                "P.Country=Country,P.Birthdate=Birth,P.Role=Role,P.Team=Team,P.Residency=Residency",
                         where=f"PR.AllName IN ({quoted_list(chunk)})")
    (CACHE / "game_people.json").write_text(json.dumps(people, ensure_ascii=False), encoding="utf-8")
    # Redirect names are stored with a capital first letter ("Deokdam"), scoreboards keep the player's
    # own spelling ("deokdam"): ask again for the ones that did not match.
    found = {p["Asked"].lower() for p in people}
    retry = sorted({n[:1].upper() + n[1:] for n in everyone if n.lower() not in found})
    if retry:
        cached("people_fix", tables="PlayerRedirects=PR,Players=P", join_on="PR.OverviewPage=P.OverviewPage",
               fields="PR.AllName=Asked,P.OverviewPage=Page,P.ID=ID,P.Name=Name,P.NativeName=Native,"
                      "P.Country=Country,P.Birthdate=Birth,P.Role=Role,P.Team=Team,P.Residency=Residency",
               where=f"PR.AllName IN ({quoted_list(retry)})")

    cached("results", tables="TournamentResults=TRS,Tournaments=T", join_on="TRS.OverviewPage=T.OverviewPage",
           fields="TRS.Team=Team,TRS.Event=Event,TRS.Date=Date,T.League=League,T.Year=Year,T.TournamentLevel=Level,TRS.OverviewPage=Page",
           where='TRS.Place_Number="1" AND T.TournamentLevel="Primary" AND '
                 '(T.League IN ("LoL Champions Korea","Champions","OGN Champions","LCK") OR T.League LIKE "%World Championship%" '
                 'OR T.League LIKE "Mid-Season Invitational%")',
           order_by="TRS.Date")

    cached("teams", tables="Teams=T", fields="T.Name=Name,T.Short=Short,T.Image=Image,T.Region=Region,T.OverviewPage=Page",
           where=f"T.Name IN ({quoted_list(LCK_TEAMS + CL_TEAMS)})")

    print(f"done: {len(links)} player links, {len(staff_links)} staff links, {len(people)} people rows", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
