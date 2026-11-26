"""Download Riot match-v5 data + timeline JSON for pro games from Leaguepedia.

Leaguepedia stores the raw Riot JSON of each pro game as two wiki pages:
  "V5 data:{RiotPlatformGameId}"            -> end-of-game data (participants, teams)
  "V5 data:{RiotPlatformGameId}/Timeline"   -> 60 s frames with x/y per player + events

Roles come from the ScoreboardPlayers Cargo table, because the role fields inside the
Riot JSON (teamPosition, individualPosition, lane, role) are garbage in tournament games.

Only api.php is used: index.php?action=raw sits behind a Cloudflare challenge.

Usage:
  python scripts/fetch_leaguepedia.py --like "LCK/2026%"
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path

import requests

API = "https://lol.fandom.com/api.php"
HEADERS = {"User-Agent": "lolsim-research/0.1 (pro game position heatmaps)"}
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
SECONDS_BETWEEN_PAGE_REQUESTS = 1.0
SECONDS_BETWEEN_CARGO_PAGES = 8.0

session = requests.Session()
session.headers.update(HEADERS)


def api_get(params: dict, attempts: int = 9) -> dict:
    params = {"format": "json", **params}
    delay = 10.0
    for attempt in range(1, attempts + 1):
        try:
            response = session.get(API, params=params, timeout=90)
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.HTTPError(f"HTTP {response.status_code}")
            response.raise_for_status()
            payload = response.json()
            if "error" in payload:
                code = payload["error"].get("code")
                if code in ("maxlag", "ratelimited"):
                    raise requests.HTTPError(f"api error {code}")
                raise RuntimeError(f"Leaguepedia API error: {payload['error']}")
            return payload
        except (requests.RequestException, ValueError) as error:
            if attempt == attempts:
                raise
            print(f"  retry {attempt}/{attempts - 1} after {delay:.0f}s: {error}", flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 180)
    raise AssertionError("unreachable")


def cargo_all(tables: str, fields: str, where: str, join_on: str | None = None, order_by: str | None = None) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        params = {"action": "cargoquery", "tables": tables, "fields": fields, "where": where,
                  "limit": 500, "offset": offset}
        if join_on:
            params["join_on"] = join_on
        if order_by:
            params["order_by"] = order_by
        batch = [item["title"] for item in api_get(params).get("cargoquery", [])]
        rows.extend(batch)
        if len(batch) < 500:
            return rows
        offset += 500
        time.sleep(SECONDS_BETWEEN_CARGO_PAGES)  # anonymous Cargo queries get "ratelimited" when sent back to back


def cargo_cached(cache_path: Path, **query) -> list[dict]:
    """Cargo is the rate-limited part, so keep each listing on disk and reuse it on rerun."""
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    rows = cargo_all(**query)
    cache_path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return rows


def fetch_game_json(riot_platform_game_id: str) -> tuple[dict, dict | None]:
    data_title = f"V5 data:{riot_platform_game_id}"
    timeline_title = f"{data_title}/Timeline"
    payload = api_get({"action": "query", "formatversion": 2, "prop": "revisions",
                       "rvprop": "content", "rvslots": "main",
                       "titles": f"{data_title}|{timeline_title}"})
    # MediaWiki answers with normalized titles ("LOLTMNT02_462538" comes back as "LOLTMNT02 462538"),
    # so map every returned page back to the title we asked for.
    asked_for = {entry["to"]: entry["from"] for entry in payload["query"].get("normalized", [])}
    by_title = {}
    for page in payload["query"]["pages"]:
        if page.get("missing"):
            continue
        title = asked_for.get(page["title"], page["title"])
        by_title[title] = json.loads(page["revisions"][0]["slots"]["main"]["content"])
    if data_title not in by_title:
        raise RuntimeError(f"missing page {data_title}")
    # Chronobreaks leave a game without a timeline page; keep the data so stats still count.
    return by_title[data_title], by_title.get(timeline_title)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--like", default="LCK/2026%", help='SQL LIKE pattern on GameId, e.g. "LCK/2026%"')
    parser.add_argument("--index", default=None, help="output index path (default data/games_<slug>.json)")
    args = parser.parse_args()

    slug = args.like.replace("%", "").replace("/", "_").strip("_").lower()
    index_path = Path(args.index) if args.index else ROOT / "data" / f"games_{slug}.json"
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    cache_dir = ROOT / "data" / "cargo_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    print(f"listing games LIKE {args.like!r} ...", flush=True)
    games = cargo_cached(
        cache_dir / f"{slug}_games.json",
        tables="MatchScheduleGame=MSG,PostgameJsonMetadata=PJM",
        join_on="MSG.RiotPlatformGameId=PJM.RiotPlatformGameId",
        fields="MSG.GameId=GameId,MSG.RiotPlatformGameId=RPGId,MSG.Blue=Blue,MSG.Red=Red,"
               "MSG.Winner=Winner,MSG.OverviewPage=OverviewPage,PJM.RiotVersion=Version",
        where=f'MSG.GameId LIKE "{args.like}" AND PJM.RiotVersion="5"',
        order_by="MSG.GameId",
    )
    print(f"  {len(games)} games with V5 JSON", flush=True)

    players = cargo_cached(
        cache_dir / f"{slug}_players.json",
        tables="ScoreboardPlayers=SP",
        fields="SP.GameId=GameId,SP.Link=Player,SP.Champion=Champion,SP.Role=Role,SP.Side=Side,SP.Team=Team",
        where=f'SP.GameId LIKE "{args.like}"',
    )
    roster_by_game: dict[str, list[dict]] = {}
    for row in players:
        roster_by_game.setdefault(row["GameId"], []).append(
            {"player": row["Player"], "champion": row["Champion"], "role": row["Role"],
             "side": int(row["Side"]) if row["Side"] else None, "team": row["Team"]})
    print(f"  {len(players)} scoreboard rows", flush=True)

    index = []
    failed = []
    for number, game in enumerate(games, 1):
        rpgid = game["RPGId"]
        out_path = RAW_DIR / f"{rpgid}.json.gz"
        entry = {"game_id": game["GameId"], "rpgid": rpgid, "blue": game["Blue"], "red": game["Red"],
                 "winner_side": int(game["Winner"]) if game["Winner"] else None,
                 "overview": game["OverviewPage"], "roster": roster_by_game.get(game["GameId"], []),
                 "raw": str(out_path.relative_to(ROOT)).replace("\\", "/")}
        if not out_path.exists():
            try:
                data, timeline = fetch_game_json(rpgid)
            except Exception as error:  # keep going; one broken page should not stop a 500-game pull
                print(f"[{number}/{len(games)}] {rpgid} FAILED: {error}", flush=True)
                failed.append({"rpgid": rpgid, "error": str(error)})
                continue
            with gzip.open(out_path, "wt", encoding="utf-8") as handle:
                json.dump({"data": data, "timeline": timeline}, handle, separators=(",", ":"))
            print(f"[{number}/{len(games)}] {rpgid} saved ({'timeline' if timeline else 'NO timeline'})", flush=True)
            time.sleep(SECONDS_BETWEEN_PAGE_REQUESTS)
        index.append(entry)

    index_path.write_text(json.dumps({"pattern": args.like, "games": index, "failed": failed},
                                     ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"done: {len(index)} games indexed, {len(failed)} failed -> {index_path}", flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
