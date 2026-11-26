"""Replace eight LCK team logos with Leaguepedia's current square logo and patch teams.json `logo` fields.

Done 2026-11-26 from hand-saved copies in data/logo_inbox/ (1000 px WebP from the file pages; KRX is an SVG
the user supplied, rendered with PyMuPDF). The script never reaches the image host when an inbox copy exists.

  python scripts/update_team_logos.py            # look up files, import, resize, patch, report tone
  python scripts/update_team_logos.py --tones    # also print the tone of every file in logos/

Leaguepedia's api.php gives the file URL and upload date, but the image host (static.wikia.nocookie.net)
answers scripted requests with a Cloudflare challenge. The script tries the download once and, if it gets
the challenge, does not retry or work around it. Instead it reads a copy saved by hand into data/logo_inbox/
(any size; .png or .webp; named like the Leaguepedia file or like <ID>.png).

Only `game/public/data/logos/<ID>.png` and the `logo` field of the owning team and its academy change.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_leaguepedia import api_get  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "game" / "public" / "data"
LOGO_DIR = OUT_DIR / "logos"
INBOX = ROOT / "data" / "logo_inbox"
CACHE = ROOT / "data" / "cargo_cache" / "game_logo_files.json"
HEADERS = {"User-Agent": "lolsim-research/0.1 (team logo lookup)"}
SIZE = 256

# team id -> Leaguepedia file (square variant: the team's emblem on a transparent square canvas)
LOGO_FILES = {
    "KT": "KT Rolsterlogo square.png",
    "DNS": "DN SOOPerslogo square.png",
    "BRO": "HANJIN BRIONlogo square.png",  # redirects to BRIONlogo square.png
    "BFX": "BNK FEARXlogo square.png",
    "KRX": "Kiwoom DRXlogo square.png",
    "DK": "Dplus Kialogo square.png",
    "GEN": "Gen.Glogo square.png",
    "HLE": "Hanwha Life Esportslogo square.png",
}


def file_page(name: str) -> str:
    return "https://lol.fandom.com/wiki/File:" + name.replace(" ", "_")


def lookup() -> dict:
    payload = api_get({"action": "query", "formatversion": 2, "prop": "imageinfo", "redirects": 1,
                       "iiprop": "url|size|timestamp|sha1", "iiurlwidth": SIZE,
                       "titles": "|".join("File:" + f for f in LOGO_FILES.values())})
    query = payload["query"]
    alias = {r["from"]: r["to"] for r in query.get("redirects", [])}
    alias.update({n["from"]: n["to"] for n in query.get("normalized", [])})
    pages = {p["title"]: p for p in query["pages"]}
    info = {}
    for tid, name in LOGO_FILES.items():
        title = "File:" + name
        while title in alias:
            title = alias[title]
        page = pages.get(title, {})
        ii = (page.get("imageinfo") or [{}])[0]
        info[tid] = {"requested": name, "file": title.removeprefix("File:"), "uploaded": ii.get("timestamp"),
                     "width": ii.get("width"), "height": ii.get("height"), "sha1": ii.get("sha1"),
                     "url": ii.get("url"), "thumburl": ii.get("thumburl"), "page": file_page(title.removeprefix("File:"))}
    CACHE.write_text(json.dumps(info, indent=1, ensure_ascii=False), encoding="utf-8")
    return info


def try_download(url: str) -> bytes | None:
    """One plain request. A Cloudflare challenge (or anything that is not an image) means: use the inbox copy."""
    response = requests.get(url, headers=HEADERS, timeout=60)
    time.sleep(2.0)
    if response.ok and response.content[:4] in (b"\x89PNG", b"RIFF"):
        return response.content
    reason = "Cloudflare challenge" if response.headers.get("cf-mitigated") == "challenge" else f"HTTP {response.status_code}"
    print(f"    download refused ({reason}); not retrying")
    return None


# words that identify a hand-saved copy whatever the browser named it (the id itself must match exactly)
INBOX_TOKENS = {"KT": ["kt rolster"], "DNS": ["dn soopers", "soopers"], "BRO": ["brion"],
                "BFX": ["fearx"], "KRX": ["kiwoom", "drx"], "DK": ["dplus"], "GEN": ["gen.g"], "HLE": ["hanwha"]}
IMAGE_SUFFIXES = (".png", ".webp", ".jpg", ".jpeg", ".svg")


def inbox_copy(tid: str) -> Path | None:
    if not INBOX.exists():
        return None
    for path in sorted(INBOX.iterdir()):
        stem = path.stem.lower().replace("_", " ").replace("-", " ")
        if path.suffix.lower() in IMAGE_SUFFIXES and (
                stem == tid.lower() or any(token in stem for token in INBOX_TOKENS[tid])):
            return path
    return None


def open_image(path: Path) -> Image.Image:
    """Raster files through Pillow; SVG rendered with PyMuPDF at 1024 px on a transparent background."""
    if path.suffix.lower() != ".svg":
        return Image.open(path)
    import pymupdf
    page = pymupdf.open(path)[0]
    zoom = 1024 / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=True)
    return Image.frombytes("RGBA", (pix.width, pix.height), pix.samples)


def normalise(image: Image.Image) -> Image.Image:
    """Trim the transparent margin, centre on a square transparent canvas, scale to SIZE px."""
    image = image.convert("RGBA")
    box = image.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if box:
        image = image.crop(box)
    side = max(image.size)
    pad = round(side * 0.04)
    canvas = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    canvas.paste(image, ((canvas.width - image.width) // 2, (canvas.height - image.height) // 2), image)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def luminance(r: int, g: int, b: int) -> float:
    def lin(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def tone(path: Path) -> dict:
    """How the logo reads on the game's dark UI, from its opaque pixels.

    lowOnDark: share with contrast ratio below 2 against #111111 (these pixels all but vanish there).
    tone: "mostly dark" if lowOnDark >= 0.5 (needs a light plate), "mostly light" if lowOnDark <= 0.15
    (bright or saturated colours that show on dark), otherwise "mixed".
    dark / light: share with relative luminance < 0.08 (about #4f4f4f and darker) / > 0.45 (about #b4b4b4 and lighter).
    """
    image = Image.open(path).convert("RGBA").resize((96, 96))
    bg = luminance(17, 17, 17)
    n = dark = light = low = 0
    for r, g, b, a in image.get_flattened_data():
        if a < 128:
            continue
        y = luminance(r, g, b)
        n += 1
        dark += y < 0.08
        light += y > 0.45
        low += (y + 0.05) / (bg + 0.05) < 2.0
    if not n:
        return {"tone": "empty"}
    d, l, o = dark / n, light / n, low / n
    label = "mostly dark" if o >= 0.5 else "mostly light" if o <= 0.15 else "mixed"
    return {"tone": label, "dark": round(d, 2), "light": round(l, 2), "lowOnDark": round(o, 2)}


def patch_teams(done: set[str]) -> list[str]:
    path = OUT_DIR / "teams.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    changed = []
    for team in data["teams"]:
        owner = team.get("parent") or team["id"]
        if owner in done:
            new = f"logos/{owner}.png"
            if team.get("logo") != new:
                team["logo"] = new
            changed.append(team["id"])
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return changed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tones", action="store_true", help="print the tone of every logo in logos/")
    args = parser.parse_args()

    info = lookup()
    done, missing = set(), []
    for tid, meta in info.items():
        print(f"{tid}: {meta['file']} (uploaded {meta['uploaded']}, {meta['width']}x{meta['height']})")
        image = None
        source = inbox_copy(tid)
        if source:
            image = open_image(source)
            print(f"    using inbox copy {source.name}")
        elif meta["thumburl"]:
            raw = try_download(meta["thumburl"])
            image = Image.open(BytesIO(raw)) if raw else None
        if image is None:
            missing.append(tid)
            continue
        print(f"    source size {image.size[0]}x{image.size[1]}")
        normalise(image).save(LOGO_DIR / f"{tid}.png", optimize=True)
        done.add(tid)

    if done:
        print("teams.json logo patched for:", ", ".join(patch_teams(done)))
    for tid in sorted(done):
        print(f"  {tid:<4} {tone(LOGO_DIR / f'{tid}.png')}")
    if missing:
        INBOX.mkdir(parents=True, exist_ok=True)
        print(f"\nNot imported: {', '.join(missing)}. Save these into {INBOX} and run again:")
        for tid in missing:
            print(f"  {tid:<4} {info[tid]['page']}")
    if args.tones:
        print("\nall logos:")
        for path in sorted(LOGO_DIR.glob("*.png")):
            print(f"  {path.stem:<5} {tone(path)}")


if __name__ == "__main__":
    main()
