"""Build game/public/data/intl.json: non-LCK teams from MSI 2026 / Worlds 2026 with rosters on the LCK scale.

  python scripts/build_game_data.py      # first (players.json is the scale anchor)
  python scripts/build_intl.py [--no-logos] [--sanity]

Rating: every 2025-2026 international game (First Stand, MSI, Worlds, EWC) is scored against all players of
the same role in those games, so LCK, LPL, LEC, LCP and LTA players share one performance scale. The LCK
players who appear in both files fit a line perf_intl -> OVR (players.json); that line rates everyone else.
Team strength = roster mean OVR + 10 * (international game win rate - 0.5), clamped to 60-95.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_game_data import (ROLES, ROLE_WEIGHTS, METRICS, COUNTRY_ISO, CaselessDict, champion_lookup,  # noqa: E402
                             clamp, handle, num, logo_colors)
from fetch_game_data import cached, quoted_list, INTL_PAGES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "game" / "public" / "data"
YEAR_WEIGHT = {"2025": 0.6, "2026": 1.0}
SHRINK_GAMES = 10
TARGET_PAGES_2026 = ["2026 Mid-Season Invitational", "2026 Season World Championship/Main Event",
                     "2026 Season World Championship/Play-In"]
LCK_TEAMS = {"T1", "Gen.G", "Hanwha Life Esports", "Dplus Kia", "KT Rolster", "BNK FEARX", "DN SOOPers",
             "Nongshim RedForce", "HANJIN BRION", "Kiwoom DRX", "DRX", "BRION"}
REGION_MAP = {"China": "LPL", "EMEA": "LEC", "Europe": "LEC", "Asia Pacific": "LCP", "Pacific": "LCP", "Vietnam": "LCP",
              "Taiwan": "LCP", "Japan": "LCP", "Oceania": "LCP", "PCS": "LCP", "Americas": "LTA", "North America": "LTA",
              "Brazil": "LTA", "Latin America": "LTA", "LTA North": "LTA", "LTA South": "LTA"}
REGION_COLORS = {"LPL": ["#d6261f", "#f5c400"], "LEC": ["#1b3d8f", "#f0f0f0"], "LCP": ["#16a2a8", "#101828"],
                 "LTA": ["#7b2ff7", "#f0f0f0"], "other": ["#777777", "#202020"]}
# Wikipedia article titles to look up a logo; teams not listed (or not found) keep logo null.
WIKI_ARTICLES = {
    "Bilibili Gaming": "Bilibili Gaming", "Top Esports": "Top Esports", "Anyone's Legend": "Anyone's Legend",
    "JD Gaming": "JD Gaming", "Invictus Gaming": "Invictus Gaming", "Weibo Gaming": "Weibo Gaming",
    "G2 Esports": "G2 Esports", "Fnatic": "Fnatic", "Karmine Corp": "Karmine Corp", "Team Vitality": "Team Vitality",
    "Movistar KOI": "Movistar KOI", "FlyQuest": "FlyQuest", "Cloud9": "Cloud9", "Team Liquid": "Team Liquid",
    "100 Thieves": "100 Thieves", "PaiN Gaming": "PaiN Gaming", "LOUD": "LOUD (esports)", "Vivo Keyd Stars": "Vivo Keyd Stars",
    "CTBC Flying Oyster": "CTBC Flying Oyster", "GAM Esports": "GAM Esports", "Team Secret Whales": "Team Secret",
    "PSG Talon": "PSG Talon", "Fukuoka SoftBank HAWKS gaming": "SoftBank Hawks Gaming", "Ninjas in Pyjamas": "Ninjas in Pyjamas",
    "Team Heretics": "Team Heretics", "GIANTX": "GiantX", "Shopify Rebellion": "Shopify Rebellion", "Dignitas": "Dignitas (esports)",
    "LØS": "LØS", "MVK Esports": "MVK Esports", "Deep Cross Gaming": "Deep Cross Gaming", "FURIA": "FURIA Esports",
    "LYON (2024 American Team)": "LYON (esports)",
}
# Teams the Leaguepedia Teams table does not return under their scoreboard name.
MANUAL_TEAMS = {"LYON (2024 American Team)": {"Short": "LYON", "Region": "North America", "Display": "LYON"}}


SP_FIELDS = ("SP.GameId=GameId,SP.Link=Link,SP.Champion=Champion,SP.Role=Role,SP.Side=Side,SP.Team=Team,"
             "SP.Kills=K,SP.Deaths=D,SP.Assists=A,SP.Gold=Gold,SP.CS=CS,SP.DamageToChampions=Dmg,"
             "SP.VisionScore=VS,SP.PlayerWin=Win,SP.DateTime_UTC=DT,SP.OverviewPage=Page,"
             "SG.Gamelength_Number=Len,SG.Team1Kills=T1K,SG.Team2Kills=T2K")


def fetch():
    rows = cached("sp_intl_full", tables="ScoreboardPlayers=SP,ScoreboardGames=SG", join_on="SP.GameId=SG.GameId",
                  fields=SP_FIELDS, where=f"SP.OverviewPage IN ({quoted_list(INTL_PAGES)})", order_by="SP.GameId")
    links = sorted({r["Link"] for r in rows if r.get("Link")})
    people = []
    for start in range(0, len(links), 50):
        chunk = links[start:start + 50]
        people += cached(f"people_intl_{start // 50}", tables="PlayerRedirects=PR,Players=P", join_on="PR.OverviewPage=P.OverviewPage",
                         fields="PR.AllName=Asked,P.OverviewPage=Page,P.ID=ID,P.Name=Name,P.NativeName=Native,"
                                "P.Country=Country,P.Birthdate=Birth,P.Role=Role,P.Team=Team,P.Residency=Residency",
                         where=f"PR.AllName IN ({quoted_list(chunk)})")
    teams = sorted({r["Team"] for r in rows if r.get("Team")})
    team_rows = cached("teams_intl", tables="Teams=T", fields="T.Name=Name,T.Short=Short,T.Region=Region,T.Image=Image",
                       where=f"T.Name IN ({quoted_list(teams)})")
    return rows, people, team_rows


def game_rows(raw):
    out = []
    for r in raw:
        if r.get("Role") not in ROLES or not r.get("Link"):
            continue
        length = num(r.get("Len"), 30.0) or 30.0
        team_kills = num(r.get("T1K") if r.get("Side") == "1" else r.get("T2K"))
        k, d, a = num(r["K"]), num(r["D"]), num(r["A"])
        year = "2026" if r["Page"].startswith("2026") or r["Page"].endswith("2026") else "2025"
        out.append({"link": r["Link"], "role": r["Role"], "team": r["Team"], "page": r["Page"], "year": year,
                    "game": r["GameId"], "dt": r.get("DT") or "", "champ": r.get("Champion") or "",
                    "win": 1.0 if r.get("Win") == "Yes" else 0.0, "k": k, "d": d, "a": a,
                    "kp": (k + a) / team_kills if team_kills else 0.0,
                    "kda": __import__("math").log1p((k + a) / max(1.0, d)),
                    "dpm": num(r.get("Dmg")) / length, "gpm": num(r.get("Gold")) / length,
                    "cspm": num(r.get("CS")) / length, "vspm": num(r.get("VS")) / length, "kpg": k, "dpg": d})
    by_role = defaultdict(list)
    for r in out:
        by_role[r["role"]].append(r)
    for group in by_role.values():
        for m in METRICS:
            values = [r[m] for r in group]
            mean, sd = statistics.fmean(values), statistics.pstdev(values) or 1.0
            for r in group:
                r["z_" + m] = (r[m] - mean) / sd
        for r in group:
            r["score"] = sum(w * r["z_" + m] for m, w in ROLE_WEIGHTS[r["role"]].items())
    return out


def player_perf(games):
    weights = [YEAR_WEIGHT[g["year"]] for g in games]
    n = sum(weights)
    shrink = n / (n + SHRINK_GAMES)
    wmean = lambda key: sum(w * g[key] for w, g in zip(weights, games)) / n  # noqa: E731
    raw = {
        "laning": (0.55 * wmean("z_cspm") + 0.45 * wmean("z_gpm")) * shrink,
        "teamfight": (0.5 * wmean("z_kp") + 0.3 * wmean("z_dpm") + 0.2 * wmean("z_kda")) * shrink,
        "macro": (0.55 * wmean("z_win") + 0.25 * wmean("z_vspm") + 0.2 * wmean("z_gpm")) * shrink,
        "mechanics": (0.45 * wmean("z_dpm") + 0.3 * wmean("z_kda") + 0.25 * wmean("z_kpg")) * shrink,
        "consistency": (0.6 * (0.9 - (statistics.pstdev([g["score"] for g in games]) if len(games) > 1 else 1.0))
                        + 0.4 * -wmean("z_dpg")) * shrink,
        "pool": (len({g["champ"] for g in games}) - 6) / 5.0,
    }
    return wmean("score") * shrink, raw


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-logos", action="store_true")
    parser.add_argument("--sanity", action="store_true")
    args = parser.parse_args()

    raw, people_rows, team_rows = fetch()
    people = CaselessDict()
    for p in people_rows:
        people[p["Asked"].lower()] = p
    team_info = {t["Name"]: t for t in team_rows}
    rows = game_rows(raw)
    champ_id = champion_lookup()
    lck = {p["id"].lower(): p for p in json.loads((OUT_DIR / "players.json").read_text(encoding="utf-8"))["players"]}

    by_player = defaultdict(list)
    for r in rows:
        by_player[r["link"]].append(r)
    perf, raw_attr, main_role = {}, {}, {}
    for link, games in by_player.items():
        role = Counter(g["role"] for g in games).most_common(1)[0][0]
        main_role[link] = role
        perf[link], raw_attr[link] = player_perf([g for g in games if g["role"] == role] or games)

    # calibrate perf_intl -> LCK OVR on LCK players with enough international games
    pairs = [(perf[l], lck[l.lower()]["ovr"]) for l, g in by_player.items()
             if l.lower() in lck and lck[l.lower()]["tier"] == 1 and len(g) >= 8]
    xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    # Match mean and spread rather than least squares: the regression slope pulls stars toward the middle
    # (Chovy 95 would come back as 88), which would make every foreign star weaker than his LCK peer.
    r = statistics.correlation(xs, ys)
    slope = statistics.pstdev(ys) / statistics.pstdev(xs)
    intercept = my - slope * mx
    resid = statistics.pstdev([y - (intercept + slope * x) for x, y in pairs])
    print(f"calibration on {len(pairs)} LCK players: r={r:.2f}, OVR = {intercept:.1f} + {slope:.1f} * perf_intl (residual sd {resid:.1f})")

    # attribute z-scores across every international player
    zs = defaultdict(dict)
    for attr in ("laning", "teamfight", "macro", "mechanics", "consistency", "pool"):
        values = [raw_attr[l][attr] for l in raw_attr]
        mean, sd = statistics.fmean(values), statistics.pstdev(values) or 1.0
        for l in raw_attr:
            zs[l][attr] = (raw_attr[l][attr] - mean) / sd

    # target teams: non-LCK teams at MSI 2026 or Worlds 2026; roster = most-played player per role in the latest event
    team_pages = defaultdict(set)
    for r in rows:
        team_pages[r["team"]].add(r["page"])
    targets = sorted(t for t, pages in team_pages.items() if t not in LCK_TEAMS and pages & set(TARGET_PAGES_2026))
    if not targets:
        targets = sorted(t for t, pages in team_pages.items() if t not in LCK_TEAMS and any(p.startswith("2025") for p in pages))
    team_wr = {}
    for team in targets:
        games = {}
        for r in rows:
            if r["team"] == team:
                games[r["game"]] = (r["win"], YEAR_WEIGHT[r["year"]])
        w = sum(weight for _, weight in games.values())
        team_wr[team] = sum(win * weight for win, weight in games.values()) / w if w else 0.5

    logo_dir = OUT_DIR / "logos"
    logo_dir.mkdir(parents=True, exist_ok=True)
    teams_out, used_ids = [], set()
    for team in targets:
        info = team_info.get(team) or MANUAL_TEAMS.get(team, {})
        tid = "".join(ch for ch in (info.get("Short") or team) if ch.isalnum()).upper()[:6] or team[:4].upper()
        while tid in used_ids or tid in {"T1", "GEN", "HLE", "DK", "KT", "BFX", "DNS", "NS", "BRO", "KRX"}:
            tid += "X"
        used_ids.add(tid)
        region = REGION_MAP.get(info.get("Region") or "", "other")
        team_games = [r for r in rows if r["team"] == team]
        latest_page = max({r["page"] for r in team_games}, key=lambda p: max(r["dt"] for r in team_games if r["page"] == p))
        roster = []
        for role in ROLES:
            in_role = Counter(r["link"] for r in team_games if r["page"] == latest_page and r["role"] == role)
            if not in_role:
                in_role = Counter(r["link"] for r in team_games if r["role"] == role)
            if not in_role:
                continue
            link = in_role.most_common(1)[0][0]
            person = people.get(link, {})
            ovr = clamp(intercept + slope * perf[link], 58, 95)
            own = zs[link]
            own_mean = statistics.fmean(own.values())
            attrs = {a: int(round(clamp(ovr + 4.5 * (own[a] - own_mean) + 1.0 * own[a], 30, 99))) for a in own}
            known = lck.get(link.lower())
            if known and known["tier"] == 1:
                # moved abroad from the LCK: keep the players.json rating so one person has one rating
                ovr, attrs = known["ovr"], dict(known["attrs"])
            champs = Counter(champ_id(g["champ"]) for g in by_player[link] if champ_id(g["champ"]))
            champ_wins = Counter(champ_id(g["champ"]) for g in by_player[link] if champ_id(g["champ"]) and g["win"])
            roster.append({
                "id": link, "name": person.get("ID") or handle(link),
                "realName": (person.get("Native") or "").strip() or person.get("Name") or None,
                "role": role, "nat": COUNTRY_ISO.get(person.get("Country") or "", (person.get("Country") or "??")[:2].upper()),
                "birth": person.get("Birth") or None, "ovr": int(round(ovr)),
                "attrs": attrs, "inPlayersJson": bool(known),
                "champs": [{"c": c, "g": n, "w": champ_wins[c]} for c, n in champs.most_common(10)],
                "intlGames": len(by_player[link]),
            })
        mean_ovr = statistics.fmean(p["ovr"] for p in roster) if roster else 70
        strength = int(round(clamp(mean_ovr + 10 * (team_wr[team] - 0.5), 60, 95)))
        logo = None
        path = logo_dir / f"{tid}.png"
        if not args.no_logos and not path.exists() and team in WIKI_ARTICLES:
            fetch_article_logo(WIKI_ARTICLES[team], path)
        if path.exists():
            logo = f"logos/{tid}.png"
        colors = logo_colors(path) if logo else REGION_COLORS.get(region, REGION_COLORS["other"])
        teams_out.append({"id": tid, "name": info.get("Display") or team, "short": info.get("Short") or tid, "region": region, "colors": colors,
                          "logo": logo, "strength": strength, "intlWinRate": round(team_wr[team], 3),
                          "events": sorted(team_pages[team]), "roster": roster})

    teams_out.sort(key=lambda t: -t["strength"])
    (OUT_DIR / "intl.json").write_text(json.dumps({
        "generated": __import__("datetime").date.today().isoformat(),
        "calibration": {"intercept": round(intercept, 2), "slope": round(slope, 2), "lckPlayers": len(pairs), "residualSd": round(resid, 2)},
        "teams": teams_out}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(teams_out)} teams -> intl.json ({sum(1 for t in teams_out if t['logo'])} with logos)")
    if args.sanity:
        for t in teams_out:
            print(f"{t['strength']:>3} {t['id']:<6} {t['name']:<30} {t['region']:<5} wr {t['intlWinRate']:.2f} logo={bool(t['logo'])} | "
                  + ", ".join(f"{p['role'][0]}:{p['name']} {p['ovr']}" for p in t["roster"]))
        check = [(l, lck[l.lower()]["ovr"], round(intercept + slope * perf[l])) for l in by_player if l.lower() in lck and len(by_player[l]) >= 8]
        print("LCK check (players.json OVR vs intl-scale OVR):", sorted(check, key=lambda c: -c[1])[:15])
    return 0


def polite_get(url: str, params: dict | None = None):
    """GET with backoff on Wikimedia's 429 / non-JSON answers. Returns the response or None."""
    import requests
    import time
    from build_game_data import WIKI_HEADERS
    for wait in (3, 10, 30, 60):
        time.sleep(wait)
        response = requests.get(url, params=params, headers=WIKI_HEADERS, timeout=60)
        if response.status_code == 429:
            continue
        return response
    return None


def fetch_article_logo(article: str, path: Path) -> bool:
    """Find a file with "logo" in its name on the team's English Wikipedia article and save it as a 256 px PNG."""
    from io import BytesIO
    from PIL import Image
    api = "https://en.wikipedia.org/w/api.php"
    response = polite_get(api, {"action": "query", "format": "json", "formatversion": 2, "prop": "images",
                                "imlimit": 50, "redirects": 1, "titles": article})
    if response is None or not response.ok:
        print(f"  logo lookup failed for {article}")
        return False
    files = [i["title"] for p in response.json().get("query", {}).get("pages", []) for i in p.get("images", [])]
    skip = ("commons-logo", "wikidata", "edit-clear", "league_of_legends", "lck", "lpl", "lec", "valorant", "counter-strike",
            "dota", "symbol", "flag", "icon")
    # the file name must carry part of the team name, or league logos on the page (LCS, Call of Duty League) slip in
    generic = {"team", "esports", "gaming", "e-sports", "(esports)", "the"}
    tokens = [t for t in article.lower().replace("(esports)", "").split() if t not in generic and len(t) >= 2]
    candidates = [f for f in files if "logo" in f.lower() and not any(s in f.lower() for s in skip)
                  and any(t in f.lower() for t in tokens)]
    for filename in candidates[:2]:
        info = polite_get(api, {"action": "query", "format": "json", "formatversion": 2, "prop": "imageinfo",
                                "iiprop": "url", "iiurlwidth": 256, "titles": filename})
        if info is None or not info.ok:
            continue
        pages = info.json().get("query", {}).get("pages", [])
        ii = (pages[0].get("imageinfo") or [{}])[0] if pages else {}
        url = ii.get("thumburl") or ii.get("url")
        image = polite_get(url) if url else None
        if image is not None and image.ok and image.content[:4] == b"\x89PNG":
            picture = Image.open(BytesIO(image.content)).convert("RGBA")
            picture.thumbnail((256, 256))
            picture.save(path)
            return True
    print(f"  no logo saved for {article}")
    return False


if __name__ == "__main__":
    sys.exit(main())
