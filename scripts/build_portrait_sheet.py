"""Draw every player's and coach's in-game pixel portrait onto one big contact sheet.

  python scripts/build_portrait_sheet.py [--scale 8] [--cols 12]

The portrait is a port of `avatarUrl` (game/src/ui/components.tsx) and `hash32` (game/src/core/rng.ts):
a 12x12 face picked from the id hash, with the jersey in the team's two colors. The port keeps the JS
quirks on purpose so the sheet shows what the game shows:
  - `h >> 4` and `h >> 8` are signed 32-bit shifts, so for ids whose hash has the top bit set the hair /
    style index is negative. `HAIR[negative]` is undefined, the canvas ignores `fillStyle = undefined`, and
    the hair is painted in the skin color that was set just before. A negative style draws no extra hair.
  - JS `%` keeps the sign of the dividend.

Jersey colors: the player's real 2026 team (teams.json / intl.json). In a new game everyone except Faker and
ShowMaker starts as a free agent, whose jersey is the game's FA default (#3a4262 / #1b1f2e).
Coaches have no portrait in the game yet; theirs are drawn with the same function and their last team's colors.

Writes data/portraits/sheet.png and one PNG per person under data/portraits/{players,staff}/.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "game" / "public" / "data"
OUT = ROOT / "data" / "portraits"
ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
ROLE_KO = {"Top": "탑", "Jungle": "정글", "Mid": "미드", "Bot": "원딜", "Support": "서폿"}
STAFF_KO = {"Head Coach": "감독", "Coach": "코치", "Strategic Coach": "전략 코치", "Analyst": "분석관"}
FA_COLORS = ("#3a4262", "#1b1f2e")

SKIN = ["#f1c9a5", "#e8b991", "#d9a47a", "#c68b5e", "#f5d6b8"]
HAIR = ["#1b1b1f", "#2b1d14", "#3b2a1d", "#5a3a20", "#14141a", "#6b4b2a", "#a0a0a8", "#c25b2f"]


# ---------- port of the game's portrait ----------
def hash32(s: str) -> int:
    h = 0x811C9DC5
    raw = s.encode("utf-16-le")  # JS charCodeAt walks UTF-16 code units
    for i in range(0, len(raw), 2):
        h ^= raw[i] | (raw[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def int32(x: int) -> int:
    x &= 0xFFFFFFFF
    return x - (1 << 32) if x & 0x80000000 else x


def js_mod(a: int, b: int) -> int:
    r = abs(a) % b
    return -r if a < 0 else r


def css(c: str) -> str:
    c = c.lower()
    return "#" + "".join(ch * 2 for ch in c[1:]) if len(c) == 4 else c


def portrait(pid: str, c1: str, c2: str) -> dict:
    """12x12 pixels exactly as avatarUrl draws them, plus the picks that made them."""
    h = hash32(pid)
    skin = SKIN[h % len(SKIN)]
    hair_idx = js_mod(int32(h) >> 4, len(HAIR))
    style = js_mod(int32(h) >> 8, 4)
    glasses = js_mod(int32(h) >> 12, 3) == 0
    px = [["#000000"] * 12 for _ in range(12)]
    fill = {"style": None}

    def set_fill(color):
        if color is not None:  # canvas ignores fillStyle = undefined and keeps the previous color
            fill["style"] = css(color)

    def rect(x, y, w, hgt):
        for yy in range(y, y + hgt):
            for xx in range(x, x + w):
                px[yy][xx] = fill["style"]

    set_fill("#141826"); rect(0, 0, 12, 12)
    set_fill(c1); rect(1, 9, 10, 3)
    set_fill(c2); rect(5, 9, 2, 3)
    set_fill(skin); rect(3, 3, 6, 6); rect(5, 8, 2, 1)
    set_fill(HAIR[hair_idx] if hair_idx >= 0 else None)
    rect(3, 2, 6, 2)
    if style == 0:
        rect(2, 3, 1, 3); rect(9, 3, 1, 3)
    if style == 1:
        rect(3, 4, 2, 1)
    if style == 2:
        rect(2, 2, 8, 1); rect(2, 3, 1, 4); rect(9, 3, 1, 4)
    if style == 3:
        rect(4, 1, 4, 1)
    set_fill("#101014"); rect(4, 5, 1, 1); rect(7, 5, 1, 1)
    if glasses:
        set_fill("#222"); rect(3, 5, 6, 1)
        set_fill("#88c"); rect(4, 5, 1, 1); rect(7, 5, 1, 1)
    set_fill("#b56a5a"); rect(5, 7, 2, 1)
    return {"px": px, "hash": h, "hairIdx": hair_idx, "style": style, "glasses": glasses,
            "bald": hair_idx < 0}


def signature(px) -> int:
    """hash32 over the concatenated pixel hex, for comparing against the browser."""
    return hash32("".join(c for row in px for c in row))


def to_image(px, scale: int) -> Image.Image:
    im = Image.new("RGB", (12, 12))
    im.putdata([tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for row in px for c in row])
    return im.resize((12 * scale, 12 * scale), Image.NEAREST)


# ---------- who goes where ----------
def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def groups():
    players = load("players.json")["players"]
    staff = load("staff.json")["staff"]
    teams = load("teams.json")["teams"]
    intl = load("intl.json")["teams"]
    by_name = {t["name"].lower(): t for t in teams}
    moved = {r["id"]: t for t in intl for r in t["roster"] if r.get("inPlayersJson")}
    role_rank = {r: i for i, r in enumerate(ROLES)}

    def entry(kind, pid, name, role, ovr, team, colors):
        return {"kind": kind, "id": pid, "name": name, "role": role, "ovr": ovr, "team": team, "colors": colors}

    out = []
    placed = set()
    for section, tier in (("LCK", 1), ("LCK CL", 2)):
        for t in (t for t in teams if t["tier"] == tier):
            roster_pos = {pid: i for i, pid in enumerate(t["lastRoster"])}
            members = [p for p in players if p["id"] not in moved and (p["lastTeam"] or "").lower() == t["name"].lower()]
            members.sort(key=lambda p: (p["id"] not in roster_pos, roster_pos.get(p["id"], 0), role_rank.get(p["role"], 9), -p["ovr"]))
            cells = [entry("player", p["id"], p["name"], p["role"], p["ovr"], t["id"], t["colors"]) for p in members]
            placed.update(p["id"] for p in members)
            coaches = [s for s in staff if (s["lastTeam"] or "").lower() == t["name"].lower()]
            coaches.sort(key=lambda s: (s["role"] != "Head Coach", s["id"] not in t["lastStaff"], s["name"].lower()))
            cells += [entry("staff", s["id"], s["name"], s["role"], None, t["id"], t["colors"]) for s in coaches]
            out.append({"section": section, "title": f"{t['nameKo']}  {t['name']}", "logo": t["logo"], "cells": cells})
    for t in intl:
        cells = []
        for r in t["roster"]:
            pid = r["id"] if r.get("inPlayersJson") else f"intl:{t['id']}:{r['id']}"  # the id the game hashes
            cells.append(entry("player", pid, r["name"], r["role"], r["ovr"], t["id"], t["colors"]))
            placed.add(r["id"])
        out.append({"section": "해외 (MSI·Worlds 2026)", "title": f"{t['name']}  {t['region']}", "logo": t["logo"], "cells": cells})
    rest = [p for p in players if p["id"] not in placed]
    rest.sort(key=lambda p: (role_rank.get(p["role"], 9), -p["ovr"]))
    rest_staff = [s for s in staff if (s["lastTeam"] or "").lower() not in by_name]
    if rest or rest_staff:
        cells = [entry("player", p["id"], p["name"], p["role"], p["ovr"], None, FA_COLORS) for p in rest]
        cells += [entry("staff", s["id"], s["name"], s["role"], None, None, FA_COLORS) for s in rest_staff]
        out.append({"section": "기타", "title": "게임 팀 밖 (FA 색)", "logo": None, "cells": cells})
    return out


# ---------- sheet ----------
def font(size, bold=False):
    for name in (("malgunbd.ttf", "malgun.ttf") if bold else ("malgun.ttf",)):
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def build(scale: int, cols: int) -> Path:
    grs = groups()
    face = 12 * scale
    cell_w, cell_h = face + 18, face + 46
    pad, head_h, section_h, gap = 24, 40, 54, 28
    inner = cols * cell_w
    width = pad * 2 + inner
    f_title, f_head, f_name, f_sub, f_tag = font(30, True), font(18, True), font(13, True), font(11), font(10, True)
    for g in grs:
        for c in g["cells"]:
            c["portrait"] = portrait(c["id"], *c["colors"])

    # pack team blocks into bands: a team with few people (an overseas five) shares its row with the next one
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
    height = pad + 70 + sum(b["h"] + 16 + (section_h if b["new_section"] else 0) for b in bands) + pad

    bg, panel, text, dim = (15, 18, 32), (24, 28, 46), (232, 234, 242), (140, 146, 170)
    sheet = Image.new("RGB", (width, height), bg)
    d = ImageDraw.Draw(sheet)
    n_players = sum(c["kind"] == "player" for g in grs for c in g["cells"])
    n_staff = sum(c["kind"] == "staff" for g in grs for c in g["cells"])
    n_bald = sum(c["portrait"]["bald"] for g in grs for c in g["cells"])
    d.text((pad, pad), "LoLSim 선수·감코 프로필 (게임 픽셀 초상화)", font=f_title, fill=text)
    d.text((pad, pad + 40), f"선수 {n_players}명 · 감코 {n_staff}명 · 저지 색은 2026 실제 소속팀 색 · 노란 테두리는 감코(게임에 아직 초상화가 없어 같은 규칙으로 그림) · "
                            f"BUG = 머리가 피부색으로 칠해지는 게임 버그 {n_bald}명", font=f_sub, fill=dim)
    (OUT / "players").mkdir(parents=True, exist_ok=True)
    (OUT / "staff").mkdir(parents=True, exist_ok=True)
    used = set()  # Windows file names ignore case, and staff.json has kkOma / KkOma style pairs

    def file_for(folder, pid):
        base = safe(pid)
        stem, n = base, 2
        while (folder, stem.lower()) in used:
            stem, n = f"{base}_{n}", n + 1
        used.add((folder, stem.lower()))
        return OUT / folder / f"{stem}.png"

    y = pad + 70
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
                sheet.paste(tile.convert("RGB"), (x0, y + 4))
                x0 += 42
            np_ = sum(c["kind"] == "player" for c in g["cells"])
            ns = len(g["cells"]) - np_
            d.text((x0, y + 9), f"{g['title']}  ·  선수 {np_}" + (f" · 감코 {ns}" if ns else ""), font=f_head, fill=text)
            for i, c in enumerate(g["cells"]):
                cx = bx + (i % b["w"]) * cell_w
                cy = y + head_h + (i // b["w"]) * cell_h
                info = c["portrait"]
                img = to_image(info["px"], scale)
                img.save(file_for("staff" if c["kind"] == "staff" else "players", c["id"]))
                border = (242, 193, 78) if c["kind"] == "staff" else (60, 66, 96)
                d.rectangle([cx - 2, cy - 2, cx + face + 1, cy + face + 1], outline=border, width=2)
                sheet.paste(img, (cx, cy))
                name = c["name"] if d.textlength(c["name"], font=f_name) <= face + 14 else c["name"][:12] + "…"
                d.text((cx, cy + face + 5), name, font=f_name, fill=text)
                if c["kind"] == "staff":
                    d.text((cx, cy + face + 23), STAFF_KO.get(c["role"], c["role"]), font=f_sub, fill=(242, 193, 78))
                else:
                    d.text((cx, cy + face + 23), f"{ROLE_KO.get(c['role'], c['role'])} · {c['ovr']}", font=f_sub, fill=dim)
                if info["bald"]:
                    d.text((cx + face - 18, cy + 2), "BUG", font=f_tag, fill=(255, 110, 110))
        y += band["h"] + 16
    path = OUT / "sheet.png"
    sheet.save(path, optimize=True)
    manifest = [{"section": g["section"], "group": g["title"], "kind": c["kind"], "id": c["id"], "name": c["name"],
                 "role": c["role"], "team": c["team"], "colors": list(c["colors"]), "hairIdx": c["portrait"]["hairIdx"],
                 "style": c["portrait"]["style"], "glasses": c["portrait"]["glasses"], "skinHairBug": c["portrait"]["bald"],
                 "signature": signature(c["portrait"]["px"])} for g in grs for c in g["cells"]]
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{path} {width}x{height}  players {n_players}, staff {n_staff}, skin-colored hair {n_bald}")
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=int, default=8)
    ap.add_argument("--cols", type=int, default=12)
    a = ap.parse_args()
    build(a.scale, a.cols)
