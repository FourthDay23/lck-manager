"""Fill the photo gaps from Liquipedia: every coach, and the players lolesports.com has no photo for.

  python scripts/fetch_liquipedia_photos.py --contact you@example.com

Liquipedia API terms (https://liquipedia.net/api-terms-of-use), followed here:
  - MediaWiki API only (no HTML pages), at most one HTTP request per 2 seconds (image downloads included),
    no action=parse, gzip, one reused connection;
  - a User-Agent naming the project with contact information. The contact is passed on the command line and
    is not stored anywhere in the repository;
  - every API answer is cached in data/liquipedia_cache/ and reused;
  - Liquipedia text is CC-BY-SA 3.0; each photo keeps its own license, linked from the manifests.

Identity check: a page counts only when its infobox Korean name (|name=) equals our realName, or, when one side
has no name, its |birth_date= equals our birth. A handle page that is somebody else falls back to a search for the
Korean name. Photos are the infobox |image=, fetched as a 384 px thumbnail.

Players go to data/player_photos/ (their manifest entries are updated), coaches to data/staff_photos/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "game" / "public" / "data"
CACHE = ROOT / "data" / "liquipedia_cache"
PLAYER_DIR = ROOT / "data" / "player_photos"
STAFF_DIR = ROOT / "data" / "staff_photos"
API = "https://liquipedia.net/leagueoflegends/api.php"
GAP = 2.2  # seconds between any two requests
WIDTH = 384
# checked by hand: our id -> Liquipedia title, where the automatic name check cannot pass
MANUAL = {
    # Gen.G head coach. Liquipedia spells the surname 유 (not 류) and gives 1994-01-18 (Leaguepedia: 01-28);
    # the page photo is "GEN Ryu at LCK 2026", so it is the same person.
    "Ryu": "Ryu",
}


class Client:
    def __init__(self, contact: str):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": f"lolsim-research/0.1 (personal game project; {contact})",
                                     "Accept-Encoding": "gzip"})
        self.last = 0.0

    def _wait(self):
        delay = self.last + GAP - time.time()
        if delay > 0:
            time.sleep(delay)
        self.last = time.time()

    def api(self, **params) -> dict:
        params = {"action": "query", "format": "json", "formatversion": 2, **params}
        key = hashlib.sha1(json.dumps(params, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
        path = CACHE / f"{key}.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        for delay in (10, 30, 90):
            self._wait()
            response = self.session.get(API, params=params, timeout=60)
            if response.status_code == 429 or response.status_code >= 500:
                print(f"    HTTP {response.status_code}, waiting {delay}s", flush=True)
                time.sleep(delay)
                continue
            response.raise_for_status()
            data = response.json()
            if "error" in data:  # never cache an error answer
                raise RuntimeError(f"Liquipedia API error: {data['error'].get('info')}")
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return data
        raise RuntimeError(f"Liquipedia API kept failing for {params}")

    def image(self, url: str) -> bytes | None:
        for delay in (10, 30):
            self._wait()
            try:
                response = self.session.get(url, timeout=60)
            except requests.RequestException:
                time.sleep(delay)
                continue
            if response.ok and (response.content[:3] == b"\xff\xd8\xff" or response.content[:4] in (b"\x89PNG", b"RIFF")
                                or response.content[:4] == b"GIF8"):
                return response.content
            if response.status_code in (429, 500, 502, 503):
                time.sleep(delay)
                continue
            return None
        return None


def infobox(text: str) -> dict:
    out = {}
    for key in ("id", "name", "romanized_name", "birth_date", "image", "roles", "role", "team"):
        # [ \t] not \s: an empty "|image=" must not swallow the next line ("|name=...")
        m = re.search(rf"^\|[ \t]*{key}[ \t]*=[ \t]*(.*?)[ \t]*$", text, re.M)
        if m:
            out[key] = m.group(1).strip()
    return out


def contents(client: Client, titles: list[str]) -> dict[str, dict]:
    """title asked -> {"title", "box"} for pages that exist, following redirects."""
    found = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        q = client.api(titles="|".join(chunk), redirects=1, prop="revisions", rvprop="content", rvslots="main")["query"]
        alias = {}
        for kind in ("normalized", "redirects"):
            for r in q.get(kind, []):
                alias[r["from"]] = r["to"]
        pages = {p["title"]: p for p in q.get("pages", []) if not p.get("missing")}
        for t in chunk:
            final = t
            for _ in range(3):
                final = alias.get(final, final)
            page = pages.get(final)
            if page:
                text = page.get("revisions", [{}])[0].get("slots", {}).get("main", {}).get("content", "")
                found[t] = {"title": final, "box": infobox(text)}
    return found


def same_person(box: dict, real: str | None, birth: str | None) -> bool:
    name = re.sub(r"\s+", "", box.get("name", ""))
    real = re.sub(r"\s+", "", real or "")
    if name and real:
        return name == real
    born = (box.get("birth_date") or "")[:10]
    return bool(born and birth and born == birth[:10])


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--contact", required=True, help="contact for the Liquipedia User-Agent (not stored)")
    args = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    STAFF_DIR.mkdir(parents=True, exist_ok=True)
    client = Client(args.contact)

    players = {p["id"]: p for p in json.loads((DATA / "players.json").read_text(encoding="utf-8"))["players"]}
    staff = json.loads((DATA / "staff.json").read_text(encoding="utf-8"))["staff"]
    pman_path = PLAYER_DIR / "manifest.json"
    pman = json.loads(pman_path.read_text(encoding="utf-8"))

    # who: every coach, and players lolesports had no photo for (intl ids are not in players.json and all have one)
    people = [("staff", s["id"], s["name"], s.get("realName"), s.get("birth")) for s in staff]
    people += [("player", pid, players[pid]["name"], players[pid].get("realName"), players[pid].get("birth"))
               for pid, v in pman.items() if not v.get("photo") and pid in players]
    print(f"looking up {len(people)} people ({sum(k == 'staff' for k, *_ in people)} coaches)", flush=True)

    # step 1: the handle as a page title (Liquipedia capitalises the first letter itself)
    by_handle = contents(client, sorted({n for _, _, n, _, _ in people}))
    match = {}
    for kind, pid, name, real, birth in people:
        hit = by_handle.get(name)
        if hit and same_person(hit["box"], real, birth):
            match[pid] = hit
    # step 2: search the Korean name for the rest
    rest = [p for p in people if p[1] not in match and p[3]]
    for kind, pid, name, real, birth in rest:
        q = client.api(list="search", srsearch=f'"{real}"', srnamespace=0, srlimit=8, srwhat="text")["query"]
        titles = [s["title"] for s in q.get("search", [])]
        if not titles:
            continue
        pages = contents(client, titles)
        hits = [h for h in pages.values() if same_person(h["box"], real, birth)]
        if hits:
            hits.sort(key=lambda h: (norm(h["box"].get("id", "")) != norm(name), h["title"]))
            match[pid] = hits[0]
    manual = contents(client, sorted(set(MANUAL.values())))
    for pid, title in MANUAL.items():
        if pid not in match and title in manual and any(p[1] == pid for p in people):
            match[pid] = manual[title]
    print(f"identified {len(match)}/{len(people)}", flush=True)

    # step 3: image URLs for the infobox files
    files = sorted({m["box"]["image"] for m in match.values() if m["box"].get("image")})
    info = {}
    for i in range(0, len(files), 50):
        q = client.api(titles="|".join("File:" + f for f in files[i:i + 50]), prop="imageinfo",
                       iiprop="url|size|extmetadata", iiurlwidth=WIDTH)["query"]
        alias = {n["from"]: n["to"] for n in q.get("normalized", [])}
        pages = {p["title"]: p for p in q.get("pages", [])}
        for f in files[i:i + 50]:
            page = pages.get(alias.get("File:" + f, "File:" + f), {})
            ii = (page.get("imageinfo") or [{}])[0]
            meta = ii.get("extmetadata") or {}
            info[f] = {"url": ii.get("thumburl") or ii.get("url"), "page": ii.get("descriptionurl"),
                       "license": (meta.get("LicenseShortName") or {}).get("value"),
                       "artist": re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", ""))[:120]}

    # step 4: download
    sman_path = STAFF_DIR / "manifest.json"
    sman = json.loads(sman_path.read_text(encoding="utf-8")) if sman_path.exists() else {}
    used = {p.stem.lower() for p in PLAYER_DIR.glob("*.png")} | {p.stem.lower() for p in STAFF_DIR.glob("*.png")}
    for kind, pid, name, real, birth in people:
        m = match.get(pid)
        entry = {"name": name, "photo": None}
        if not m:
            entry["why"] = "not on liquipedia"
        elif not m["box"].get("image") or not (info.get(m["box"]["image"]) or {}).get("url"):
            entry.update({"why": "liquipedia page has no photo", "liquipedia": m["title"]})
        else:
            f = m["box"]["image"]
            folder = STAFF_DIR if kind == "staff" else PLAYER_DIR
            stem = safe(pid)
            target = folder / f"{stem}.png"
            if not target.exists() and stem.lower() in used:  # kkOma / KkOma on a case-blind disk
                stem += "_2"
                target = folder / f"{stem}.png"
            used.add(stem.lower())
            if not target.exists():
                raw = client.image(info[f]["url"])
                if raw:
                    image = Image.open(BytesIO(raw)).convert("RGB")
                    if image.width > WIDTH:
                        image = image.resize((WIDTH, round(image.height * WIDTH / image.width)), Image.LANCZOS)
                    image.save(target)
            if target.exists():
                entry = {"name": name, "photo": target.name, "source": "liquipedia", "liquipedia": m["title"],
                         "file": f, "filePage": info[f]["page"], "license": info[f]["license"], "artist": info[f]["artist"]}
            else:
                entry.update({"why": "download failed", "liquipedia": m["title"]})
        if kind == "staff":
            sman[pid] = entry
        elif entry["photo"] or pman.get(pid, {}).get("photo") is None:
            old = pman.get(pid, {})
            pman[pid] = {**entry, "lolesports": old.get("why")} if entry["photo"] else {**old, "liquipedia": entry.get("why")}
        print(f"  {kind:<6} {pid:<34} {entry.get('photo') or entry.get('why')}", flush=True)
    sman_path.write_text(json.dumps(sman, ensure_ascii=False, indent=1), encoding="utf-8")
    pman_path.write_text(json.dumps(pman, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"coaches with photo {sum(1 for v in sman.values() if v.get('photo'))}/{len(sman)}, "
          f"players with photo {sum(1 for v in pman.values() if v.get('photo'))}/{len(pman)}")


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


if __name__ == "__main__":
    main()
