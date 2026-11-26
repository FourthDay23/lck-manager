"""Put every player's (and coach's) real headshot on one big contact sheet, grouped by team.

  python scripts/build_photo_sheet.py

Photos come from scripts/fetch_player_photos.py (data/player_photos/, lolesports.com official headshots).
People without a photo get a grey placeholder with the reason. The team grouping and order are the same as the
pixel-portrait sheet (scripts/build_portrait_sheet.py). Writes data/player_photos/sheet.png.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_portrait_sheet import DATA, ROLE_KO, STAFF_KO, font, groups  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "data" / "player_photos"
STAFF_PHOTOS = ROOT / "data" / "staff_photos"
WHY_KO = {"default headshot": "공식 사진 미등록", "not on any page": "lolesports에 없음",
          "ambiguous handle": "동명이인", "staff": "감코 사진 출처 없음",
          "not on liquipedia": "Liquipedia에도 없음", "liquipedia page has no photo": "Liquipedia에 사진 없음",
          "download failed": "받기 실패"}


def mix(c1, c2, t):
    return tuple(round(a + (b - a) * t) for a, b in zip(c1, c2))


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def headshot(path: Path, side: int) -> Image.Image:
    """Square crop from the top of the person (head and shoulders), transparent background kept."""
    im = Image.open(path).convert("RGBA")
    box = im.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox() or (0, 0, im.width, im.height)
    left, top, right, bottom = box
    size = min(right - left, bottom - top)
    cx = (left + right) // 2
    crop = im.crop((cx - size // 2, top, cx - size // 2 + size, top + size))
    return crop.resize((side, side), Image.LANCZOS)


def placeholder(side: int, fill) -> Image.Image:
    im = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = side
    d.ellipse([s * 0.34, s * 0.16, s * 0.66, s * 0.48], fill=fill)
    d.rounded_rectangle([s * 0.2, s * 0.54, s * 0.8, s * 1.1], radius=int(s * 0.18), fill=fill)
    return im


def manifests() -> tuple[dict, dict]:
    manifest = json.loads((PHOTOS / "manifest.json").read_text(encoding="utf-8"))
    sman_path = STAFF_PHOTOS / "manifest.json"
    sman = json.loads(sman_path.read_text(encoding="utf-8")) if sman_path.exists() else {}
    return manifest, sman


def photo_of(cell: dict, manifest: dict, sman: dict) -> tuple[Path | None, dict]:
    """The photo file of a sheet cell (or None) and its manifest entry."""
    info = (manifest if cell["kind"] == "player" else sman).get(cell["id"]) or {}
    if not info.get("photo"):
        return None, info
    return (PHOTOS if cell["kind"] == "player" else STAFF_PHOTOS) / info["photo"], info


def main() -> None:
    render(groups(), PHOTOS / "sheet.png", "LoLSim 선수·감코 실제 프로필 사진")


def render(grs: list[dict], path: Path, title: str, cols: int = 11) -> None:
    """Draw the given team groups on one sheet. cols 11 lets two overseas fives (plus the gap) share a row."""
    manifest, sman = manifests()
    side = 132
    cell_w, cell_h = side + 14, side + 50
    pad, head_h, section_h, gap = 24, 42, 54, 28
    inner = cols * cell_w
    width = pad * 2 + inner
    f_title, f_head, f_name, f_sub, f_why = font(30, True), font(18, True), font(14, True), font(11), font(11, True)

    bands, prev = [], None
    for g in grs:
        w = max(1, min(cols, len(g["cells"])))
        block = {"g": g, "w": w, "rows": max(1, -(-len(g["cells"]) // w))}
        band = bands[-1] if bands else None
        if band and band["section"] == g["section"] and band["used"] + gap + w * cell_w <= inner:
            block["x"] = band["used"] + gap
            band["used"] += gap + w * cell_w
            band["blocks"].append(block)
        else:
            block["x"] = 0
            bands.append({"section": g["section"], "used": w * cell_w, "blocks": [block], "new_section": g["section"] != prev})
        prev = g["section"]
    for band in bands:
        band["h"] = head_h + max(b["rows"] for b in band["blocks"]) * cell_h + 4
    height = pad + 80 + sum(b["h"] + 16 + (section_h if b["new_section"] else 0) for b in bands) + pad

    bg, panel, text, dim = (15, 18, 32), (24, 28, 46), (232, 234, 242), (140, 146, 170)
    sheet = Image.new("RGB", (width, height), bg)
    d = ImageDraw.Draw(sheet)
    cells = [c for g in grs for c in g["cells"]]
    n_pl = sum(c["kind"] == "player" for c in cells)
    have = sum(1 for c in cells if c["kind"] == "player" and (manifest.get(c["id"]) or {}).get("photo"))
    n_st = sum(c["kind"] == "staff" for c in cells)
    have_st = sum(1 for c in cells if c["kind"] == "staff" and (sman.get(c["id"]) or {}).get("photo"))
    def source_of(c):
        return ((manifest if c["kind"] == "player" else sman).get(c["id"]) or {}).get("source")
    n_lp = sum(1 for c in cells if source_of(c) == "leaguepedia")
    n_lq = sum(1 for c in cells if source_of(c) == "liquipedia")
    d.text((pad, pad), title, font=f_title, fill=text)
    n_man = sum(1 for c in cells if source_of(c) == "manual")
    d.text((pad, pad + 40), f"선수 {n_pl}명 중 {have}명 · 감코 {n_st}명 중 {have_st}명 · 회색 실루엣은 사진 없음", font=f_sub, fill=dim)
    d.text((pad, pad + 56), f"표시 없음: lolesports.com 공식 프로필(2026) · LP {n_lp}: Leaguepedia · LQ {n_lq}: Liquipedia · "
                            f"직접 {n_man}: 사용자가 받음 · 저작권은 사진마다 다름", font=f_sub, fill=dim)
    y = pad + 80
    for band in bands:
        if band["new_section"]:
            d.text((pad, y + 14), band["section"], font=f_title, fill=(242, 193, 78))
            y += section_h
        for b in band["blocks"]:
            g, bx = b["g"], pad + b["x"]
            d.rounded_rectangle([bx - 8, y, bx + b["w"] * cell_w - 4, y + band["h"]], radius=8, fill=panel)
            x0 = bx
            if g["logo"]:
                logo = Image.open(DATA / g["logo"]).convert("RGBA")
                logo.thumbnail((28, 28), Image.LANCZOS)
                tile = Image.new("RGBA", (32, 32), (255, 255, 255, 255))
                tile.paste(logo, ((32 - logo.width) // 2, (32 - logo.height) // 2), logo)
                sheet.paste(tile.convert("RGB"), (x0, y + 5))
                x0 += 42
            np_ = sum(c["kind"] == "player" for c in g["cells"])
            ns = len(g["cells"]) - np_
            d.text((x0, y + 10), f"{g['title']}  ·  선수 {np_}" + (f" · 감코 {ns}" if ns else ""), font=f_head, fill=text)
            for i, c in enumerate(g["cells"]):
                cx = bx + (i % b["w"]) * cell_w
                cy = y + head_h + (i // b["w"]) * cell_h
                team = rgb(c["colors"][0])
                top, bottom = mix(team, (58, 64, 92), 0.55), (36, 41, 62)
                tile = Image.new("RGB", (side, side))
                td = ImageDraw.Draw(tile)
                for row in range(side):
                    td.line([(0, row), (side, row)], fill=mix(top, bottom, row / side))
                info = manifest.get(c["id"]) if c["kind"] == "player" else sman.get(c["id"])
                why = None
                if info and info.get("photo"):
                    face = headshot((PHOTOS if c["kind"] == "player" else STAFF_PHOTOS) / info["photo"], side)
                    tile.paste(face, (0, 0), face)
                else:
                    ph = placeholder(side, (90, 96, 120))
                    tile.paste(ph, (0, 0), ph)
                    reason = (info or {}).get("liquipedia") if (info or {}).get("liquipedia") in WHY_KO else (info or {}).get("why", "staff")
                    why = WHY_KO.get(reason, "사진 없음")
                sheet.paste(tile, (cx, cy))
                tag = {"leaguepedia": ("LP", (120, 200, 255)), "liquipedia": ("LQ", (255, 190, 120)),
                       "manual": ("직접", (150, 230, 150))}.get((info or {}).get("source"))
                if tag:
                    d.rectangle([cx, cy, cx + d.textlength(tag[0], font=f_why) + 6, cy + 15], fill=(20, 22, 34))
                    d.text((cx + 3, cy + 1), tag[0], font=f_why, fill=tag[1])
                border = (242, 193, 78) if c["kind"] == "staff" else (60, 66, 96)
                d.rectangle([cx - 2, cy - 2, cx + side + 1, cy + side + 1], outline=border, width=2)
                if why:
                    tw = d.textlength(why, font=f_why)
                    d.rectangle([cx, cy + side - 20, cx + side, cy + side], fill=(20, 22, 34))
                    d.text((cx + (side - tw) / 2, cy + side - 18), why, font=f_why, fill=(200, 205, 222))
                name = c["name"] if d.textlength(c["name"], font=f_name) <= side + 10 else c["name"][:13] + "…"
                d.text((cx, cy + side + 5), name, font=f_name, fill=text)
                if c["kind"] == "staff":
                    d.text((cx, cy + side + 25), STAFF_KO.get(c["role"], c["role"]), font=f_sub, fill=(242, 193, 78))
                else:
                    d.text((cx, cy + side + 25), f"{ROLE_KO.get(c['role'], c['role'])} · {c['ovr']}", font=f_sub, fill=dim)
        y += band["h"] + 16
    sheet.save(path, optimize=True)
    print(f"{path} {width}x{height}  players {n_pl} (photo {have}), staff {n_st}")


if __name__ == "__main__":
    main()
