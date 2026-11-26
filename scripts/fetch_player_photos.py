"""Collect the official headshots of every player in the game data from lolesports.com team pages.

  python scripts/fetch_player_photos.py

Source: https://lolesports.com/en-US/teams/<slug> (server-rendered HTML; robots.txt allows everything).
Each roster card has the handle, the romanised real name and a photo on static.lolesports.com, served
through Riot's resize proxy (am-a.akamaihd.net). Team pages list the club's LCK CL roster as well.
Players without a photo get `default-headshot.png` there; those are recorded as having no photo.
lolesports lists no coaches, so staff are not covered here.

Pages are cached in data/lolesports_cache/, photos go to data/player_photos/<id>.png (384 px wide),
and data/player_photos/manifest.json says which card each game id matched.
"""
from __future__ import annotations

import html
import json
import re
import time
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "game" / "public" / "data"
CACHE = ROOT / "data" / "lolesports_cache"
OUT = ROOT / "data" / "player_photos"
HEADERS = {"User-Agent": "lolsim-research/0.1 (player photo lookup)"}
PAGE_PAUSE, IMAGE_PAUSE = 3.0, 1.5
WIDTH = 384

# game team id -> lolesports team slug (academies are listed on the parent club's page)
SLUGS = {
    "T1": "t1", "GEN": "geng", "HLE": "hanwha-life-esports", "DK": "dwg-kia", "KT": "kt-rolster",
    "BFX": "fearx", "DNS": "kwangdong-freecs", "NS": "nongshim-redforce", "BRO": "fredit-brion", "KRX": "drx",
    "BLG": "bilibili-gaming", "KC": "karmine-corp", "IG": "invictus-gaming", "AL": "anyones-legend",
    "TL": "team-liquid", "LOS": "los", "MVK": "saigon-buffalo-esports", "C9": "cloud9", "G2": "g2-esports",
    "LYON": "lyon-gaming", "TES": "top-esports", "CFO": "ctbc-flying-oyster", "MKOI": "mad-lions",
    "FUR": "furia", "DCG": "deep-cross-gaming", "TSW": "team-secret-whales",
}
CARD = re.compile(r'<img alt="([^"]*)"[^>]*?src="https://am-a\.akamaihd\.net/image\?resize=\d+:&amp;f='
                  r'http%3A%2F%2Fstatic\.lolesports\.com%2Fplayers%2F([^"]+)"')


def get(url: str, pause: float) -> requests.Response | None:
    """Plain GET with backoff on 429/5xx and on dropped connections (the resize proxy once failed a TLS handshake)."""
    response = None
    for delay in (5, 20, 60):
        try:
            response = requests.get(url, headers=HEADERS, timeout=60)
        except requests.RequestException as error:
            print(f"    retry in {delay}s: {type(error).__name__}", flush=True)
            time.sleep(delay)
            continue
        time.sleep(pause)
        if response.status_code == 429 or response.status_code >= 500:
            time.sleep(delay)
            continue
        return response
    return response


def is_image(response: requests.Response | None) -> bool:
    # the CDN answers binary/octet-stream, so check the bytes instead of the content type
    return bool(response is not None and response.ok and (
        response.content[:4] in (b"\x89PNG", b"RIFF") or response.content[:3] == b"\xff\xd8\xff"))


def team_cards(slug: str) -> list[dict]:
    path = CACHE / f"team_{slug}.html"
    if not path.exists():
        response = get(f"https://lolesports.com/en-US/teams/{slug}", PAGE_PAUSE)
        response.raise_for_status()
        path.write_text(response.text, encoding="utf-8")
    text = path.read_text(encoding="utf-8")
    cards, seen = [], set()
    for m in CARD.finditer(text):
        texts = [html.unescape(x).strip() for x in re.findall(r">([^<>]+)<", text[m.end():m.end() + 6000]) if x.strip()]
        file = html.unescape(m.group(2))
        from urllib.parse import unquote
        file = unquote(file)
        handle = texts[0] if texts else ""
        if (handle, file) in seen:
            continue
        seen.add((handle, file))
        cards.append({"slug": slug, "handle": handle, "realName": texts[1] if len(texts) > 1 else "",
                      "file": file, "default": file.startswith("default-headshot")})
    return cards


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    players = json.loads((DATA / "players.json").read_text(encoding="utf-8"))["players"]
    teams = json.loads((DATA / "teams.json").read_text(encoding="utf-8"))["teams"]
    intl = json.loads((DATA / "intl.json").read_text(encoding="utf-8"))["teams"]

    cards = []
    for tid, slug in SLUGS.items():
        got = team_cards(slug)
        cards += got
        print(f"{tid:<5} {slug:<24} {len(got)} cards, {sum(not c['default'] for c in got)} with photo", flush=True)
    by_handle: dict[str, list[dict]] = {}
    for c in cards:
        by_handle.setdefault(norm(c["handle"]), []).append(c)

    team_of = {t["name"].lower(): (t.get("parent") or t["id"]) for t in teams}
    people = []  # (game id, display name, home slug)
    for p in players:
        people.append((p["id"], p["name"], SLUGS.get(team_of.get((p["lastTeam"] or "").lower(), ""))))
    for t in intl:
        for r in t["roster"]:
            if not r.get("inPlayersJson"):
                people.append((f"intl:{t['id']}:{r['id']}", r["name"], SLUGS[t["id"]]))

    manifest, used_files = {}, set()
    for pid, name, home in people:
        options = by_handle.get(norm(name), [])
        pick = next((c for c in options if c["slug"] == home), None)
        how = "team page"
        if not pick and len({c["file"] for c in options}) == 1:
            pick, how = options[0], "other team page"  # moved clubs (Viper on BLG)
        if not pick:
            manifest[pid] = {"name": name, "photo": None, "why": "not on any page" if not options else "ambiguous handle"}
            continue
        if pick["default"]:
            manifest[pid] = {"name": name, "photo": None, "why": "default headshot", "slug": pick["slug"],
                             "realNameLatin": pick["realName"]}
            continue
        stem = safe(pid)
        while stem.lower() in used_files:
            stem += "_2"
        used_files.add(stem.lower())
        target = OUT / f"{stem}.png"
        source = "http://static.lolesports.com/players/" + pick["file"]
        if not target.exists():
            response = get(f"https://am-a.akamaihd.net/image?resize={WIDTH}:&f={quote(source, safe='')}", IMAGE_PAUSE)
            if not is_image(response):  # resize proxy down: take the original and shrink it here
                response = get(source.replace("http://", "https://"), IMAGE_PAUSE)
            if not is_image(response):
                code = response.status_code if response is not None else "no response"
                manifest[pid] = {"name": name, "photo": None, "why": f"download failed ({code})"}
                continue
            from io import BytesIO
            from PIL import Image
            image = Image.open(BytesIO(response.content)).convert("RGBA")
            if image.width > WIDTH:
                image = image.resize((WIDTH, round(image.height * WIDTH / image.width)), Image.LANCZOS)
            image.save(target)
        manifest[pid] = {"name": name, "photo": f"{stem}.png", "source": source, "slug": pick["slug"],
                         "realNameLatin": pick["realName"], "matched": how}
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    have = sum(1 for v in manifest.values() if v["photo"])
    print(f"photos {have}/{len(manifest)}")
    for pid, v in manifest.items():
        if not v["photo"]:
            print(f"  no photo: {pid:<34} {v['why']}")


if __name__ == "__main__":
    main()
