"""Layered pixel portraits: one face layer per person + a few recolourable outfit templates.

The game draws  background -> face layer -> outfit template (recoloured with the current team's colours),
so a transfer, a release to free agency or a new club changes the clothes without redrawing anybody.

  python scripts/portrait_layers.py faces       ChatGPT face grids -> data/portrait_layers/faces/<file>.png
  python scripts/portrait_layers.py templates   ChatGPT outfit drawings -> data/portrait_layers/templates/<name>.png
  python scripts/portrait_layers.py preview     sample composites (own team / another team / free agent)
  python scripts/portrait_layers.py selftest    run the whole pipeline on synthetic ChatGPT-like images

Inputs (saved by hand from ChatGPT):
  data/portrait_layers/generated/<team folder>/batch<N>.png   3x2 grid of 512 px cells, see chatgpt_batches.json
  data/portrait_layers/raw_templates/<template>.png           one 512 px drawing per template
  (kept apart from data/team_photos/, which scripts/export_team_photos.py rebuilds)
Everything is 64x64 pixel art drawn at 8x by ChatGPT on a magenta (#FF00FF) background.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
GAME_DATA = ROOT / "game" / "public" / "data"


class Paths:
    """Where inputs and outputs live: the LoLSim repo by default, or a self-contained portrait kit (--kit DIR)."""

    def __init__(self, kit: Path | None = None):
        self.kit = kit
        if kit:
            self.gen = kit / "work" / "generated"
            self.retakes = kit / "work" / "retakes"
            self.raw = kit / "work" / "raw_templates"
            self.out = kit / "output"
            self.batches = kit / "prompts" / "batches.json"
            self.teams = kit / "data" / "teams.json"
        else:
            layers = ROOT / "data" / "portrait_layers"
            self.gen = layers / "generated"
            self.retakes = layers / "retakes"
            self.raw = layers / "raw_templates"
            self.out = layers
            self.batches = ROOT / "data" / "team_photos" / "chatgpt_batches.json"
            self.teams = None


P = Paths()
LAYERS = P.out  # kept for older callers


def load_teams() -> dict[str, dict]:
    """team id -> {"name", "colors"} from the kit's data/teams.json or the game data."""
    if P.teams and P.teams.exists():
        return json.loads(P.teams.read_text(encoding="utf-8"))
    teams = {t["id"]: t for t in json.loads((GAME_DATA / "teams.json").read_text(encoding="utf-8"))["teams"]}
    teams.update({t["id"]: t for t in json.loads((GAME_DATA / "intl.json").read_text(encoding="utf-8"))["teams"]})
    return teams

# ---------------- the layer spec (the game must follow the same numbers) ----------------
SIZE = 64                  # final layer size in pixels
SCALE = 8                  # ChatGPT draws every pixel as an 8x8 block
CELL = SIZE * SCALE        # 512
CENTER_X = 32              # face layer: horizontal centre of the neck
CHIN_Y = 40                # face layer: first row of the neck (just under the chin)
NECK_BOTTOM_Y = 54         # face layer: the neck reaches at least this row (the collar covers it)
COLLAR_TOP_Y = 46          # outfit templates: top edge of the collar
BG_KEY = (255, 0, 255)     # magenta background in every ChatGPT drawing
UI_BG = "#141826"          # what the game draws behind the layers

# outfit templates are drawn only with these key colours; the game swaps them for the team's colours
KEYS = {
    "main": "#FF0000", "main_dark": "#990000", "main_light": "#FF8080",
    "sub": "#00FF00", "sub_dark": "#009900",
    "accent": "#0000FF",
    "outline": "#000000",
}
SUIT_FIXED = {"shirt": "#FFFFFF", "shirt_shade": "#C8C8C8", "jacket": "#2A2D3A", "jacket_dark": "#1A1C26"}
TEMPLATES = {
    "jersey_a": ("선수 유니폼 A (기본)",
                 "몸판은 주색, 옷깃과 소매 끝은 보조색, 어깨 솔기에 포인트색 1블록 선. 주색 그림자와 하이라이트로 주름을 살짝 넣어.", {}),
    "jersey_b": ("선수 유니폼 B (사선 띠)",
                 "유니폼 A와 같은 몸판에, 오른쪽 어깨에서 왼쪽 옆구리로 내려가는 보조색 사선 띠(폭 3블록)를 넣어. 띠 가장자리는 보조색 그림자.", {}),
    "jersey_c": ("선수 유니폼 C (가슴 띠)",
                 "유니폼 A와 같은 몸판에, 가슴을 가로지르는 보조색 띠(폭 3블록)를 넣고 띠 위아래에 포인트색 1블록 선을 그어.", {}),
    "suit": ("감독·코치 정장",
             "어두운 재킷(고정색), 흰 셔츠 옷깃, 넥타이는 주색(주색 그림자로 매듭과 주름), 왼쪽 가슴에 보조색 배지 2×2블록.", SUIT_FIXED),
    "hoodie": ("FA·신인 후드티",
               "후드티 몸판은 주색(게임이 FA 기본색으로 칠함), 목 뒤로 넘긴 모자 테두리와 후드 끈은 보조색. 로고 없음.", {}),
}
PLAYER_JERSEYS = ("jersey_a", "jersey_b", "jersey_c")


def hexrgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def luminance(c) -> float:
    def lin(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = c
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(a, b) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def team_palette(colors: list[str]) -> dict[str, tuple]:
    """Key colour -> real colour for one team. The game must use the same rule."""
    c0, c1 = hexrgb(colors[0]), hexrgb(colors[1])
    accent = (240, 240, 240) if luminance(c0) < 0.3 else (16, 16, 16)
    sub = c1 if contrast(c0, c1) >= 1.4 else accent  # TL-style near-identical pairs
    return {"main": c0, "main_dark": mix(c0, (0, 0, 0), 0.4), "main_light": mix(c0, (255, 255, 255), 0.45),
            "sub": sub, "sub_dark": mix(sub, (0, 0, 0), 0.4), "accent": accent, "outline": (11, 13, 20)}


def jersey_for(team_id: str) -> str:
    """Default jersey pattern per club (stable, spread over the three patterns). The game may store its own choice."""
    import zlib
    return PLAYER_JERSEYS[zlib.crc32(team_id.encode()) % len(PLAYER_JERSEYS)]


# ---------------- ChatGPT image -> 64x64 layer ----------------
def pixelate(cell: Image.Image) -> np.ndarray:
    """A 512 px ChatGPT cell -> 64x64 RGB. Finds the 8 px grid phase, then takes each block's median colour."""
    a = np.asarray(cell.convert("RGB").resize((CELL, CELL), Image.NEAREST), dtype=np.int16)
    padded = np.pad(a, ((0, SCALE), (0, SCALE), (0, 0)), mode="edge")
    best, best_score = (0, 0), None
    for dy in range(SCALE):
        for dx in range(SCALE):
            blocks = padded[dy:dy + CELL, dx:dx + CELL].reshape(SIZE, SCALE, SIZE, SCALE, 3)
            score = blocks.std(axis=(1, 3)).mean()
            if best_score is None or score < best_score:
                best, best_score = (dy, dx), score
    dy, dx = best
    blocks = padded[dy:dy + CELL, dx:dx + CELL].reshape(SIZE, SCALE, SIZE, SCALE, 3)
    return np.median(blocks, axis=(1, 3)).astype(np.uint8)


def key_out(px: np.ndarray) -> np.ndarray:
    """RGB 64x64 -> RGBA with the magenta background (and magenta-tinted edge blocks) made transparent."""
    r, g, b = (px[..., i].astype(int) for i in range(3))
    bg = (r > 170) & (b > 170) & (g < 110) & (abs(r - b) < 90)
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    return np.dstack([px, alpha])


def quantize(rgba: np.ndarray, colors: int = 20) -> np.ndarray:
    opaque = rgba[..., 3] > 0
    if len({tuple(c) for c in rgba[opaque][:, :3]}) <= colors:
        return rgba
    img = Image.fromarray(rgba[..., :3]).quantize(colors=colors, method=Image.Quantize.MEDIANCUT).convert("RGB")
    out = rgba.copy()
    out[..., :3] = np.asarray(img)
    return out


def neck_anchor(rgba: np.ndarray) -> tuple[int, float] | None:
    """(chin row, neck centre x) from the narrow run of rows at the bottom of the drawing."""
    mask = rgba[..., 3] > 0
    rows = [np.flatnonzero(mask[y]) for y in range(SIZE)]
    widths = [len(r) and (r[-1] - r[0] + 1) for r in rows]
    if not any(widths):
        return None
    max_w = max(widths)
    bottom = max(y for y in range(SIZE) if widths[y])
    y = bottom
    while y >= 0 and widths[y] and widths[y] <= 0.55 * max_w:
        y -= 1
    chin = y + 1
    if bottom - chin < 1:  # no narrow neck found: treat the bottom as the chin line
        return None
    centre = float(np.mean([(rows[k][0] + rows[k][-1]) / 2 for k in range(chin, bottom + 1)]))
    return chin, centre


def align_face(rgba: np.ndarray) -> tuple[np.ndarray, str]:
    """Move the face so the neck centre sits on CENTER_X and the chin on CHIN_Y; extend the neck down under the collar."""
    anchor = neck_anchor(rgba)
    note = "ok"
    if anchor is None:
        mask = rgba[..., 3] > 0
        ys, xs = np.nonzero(mask)
        anchor = (int(ys.max()) - 10, float((xs.min() + xs.max()) / 2))
        note = "no neck found, aligned by the bounding box"
    chin, centre = anchor
    dy, dx = CHIN_Y - chin, CENTER_X - int(round(centre))
    out = np.zeros_like(rgba)
    src = rgba
    ys, xs = np.nonzero(src[..., 3] > 0)
    for y, x in zip(ys, xs):
        ny, nx = y + dy, x + dx
        if 0 <= ny < SIZE and 0 <= nx < SIZE:
            out[ny, nx] = src[y, x]
    mask = out[..., 3] > 0
    last = max((y for y in range(SIZE) if mask[y].any()), default=None)
    if last is not None and last < NECK_BOTTOM_Y:
        for y in range(last + 1, NECK_BOTTOM_Y + 1):
            out[y] = out[last]
    if abs(dy) > 6 or abs(dx) > 6:
        note += f"; moved far ({dx:+d},{dy:+d}) - check the drawing size"
    return out, note


def snap_to_keys(rgba: np.ndarray, allowed: dict[str, str]) -> np.ndarray:
    pal = np.array([hexrgb(v) for v in allowed.values()], dtype=int)
    out = rgba.copy()
    opaque = out[..., 3] > 0
    px = out[opaque][:, :3].astype(int)
    nearest = ((px[:, None, :] - pal[None, :, :]) ** 2).sum(-1).argmin(1)
    out[opaque, :3] = pal[nearest].astype(np.uint8)
    return out


def recolor(template: np.ndarray, palette: dict[str, tuple]) -> np.ndarray:
    out = template.copy()
    for key, hexv in KEYS.items():
        hit = (template[..., :3] == np.array(hexrgb(hexv), dtype=np.uint8)).all(-1) & (template[..., 3] > 0)
        out[hit, :3] = palette[key]
    return out


def compose(face: np.ndarray | None, template: np.ndarray, colors: list[str]) -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), hexrgb(UI_BG) + (255,))
    if face is not None:
        f = Image.fromarray(face, "RGBA")
        img.alpha_composite(f)
    img.alpha_composite(Image.fromarray(recolor(template, team_palette(colors)), "RGBA"))
    return img


# ---------------- commands ----------------
def cmd_faces(gen_dir: Path | None = None, out_dir: Path | None = None, batches_path: Path | None = None,
              retake_dir: Path | None = None) -> dict:
    """Cut every batch grid into face layers. A one-person redraw in retakes/<face file> wins over the grid cell."""
    gen_dir, out_dir = gen_dir or P.gen, out_dir or P.out / "faces"
    batches_path, retake_dir = batches_path or P.batches, retake_dir or P.retakes
    batches = json.loads(batches_path.read_text(encoding="utf-8"))
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {}
    for b in batches:
        path = gen_dir / b["folder"] / f"batch{b['batch']}.png"
        grid = None
        if path.exists():
            grid = Image.open(path).convert("RGB")
            if grid.size != (3 * CELL, 2 * CELL):
                grid = grid.resize((3 * CELL, 2 * CELL), Image.LANCZOS)
        for i, person in enumerate(b["people"]):
            retake = retake_dir / person["face"]
            if retake.exists():
                cell, source = Image.open(retake).convert("RGB"), f"retakes/{person['face']}"
            elif grid is not None:
                cell = grid.crop(((i % 3) * CELL, (i // 3) * CELL, (i % 3 + 1) * CELL, (i // 3 + 1) * CELL))
                source = f"{b['folder']}/batch{b['batch']}.png#{i + 1}"
            else:
                continue
            layer, note = align_face(quantize(key_out(pixelate(cell))))
            Image.fromarray(layer, "RGBA").save(out_dir / person["face"])
            report[person["id"]] = {"face": person["face"], "from": source, "note": note}
            for alias in person.get("alsoIds", []):
                report[alias] = {**report[person["id"]], "aliasOf": person["id"]}
    (out_dir / "faces_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    # what the game reads: person id (players.json / staff.json / "intl:<team>:<id>") -> face layer file
    (out_dir / "index.json").write_text(json.dumps({k: v["face"] for k, v in report.items()}, ensure_ascii=False, indent=1),
                                        encoding="utf-8")
    print(f"faces: {len(report)} layers -> {out_dir}  ({sum(1 for r in report.values() if r['note'] != 'ok')} to check)")
    return report


def cmd_templates(raw_dir: Path | None = None, out_dir: Path | None = None) -> list[str]:
    raw_dir, out_dir = raw_dir or P.raw, out_dir or P.out / "templates"
    out_dir.mkdir(parents=True, exist_ok=True)
    done = []
    for name, (_, _, fixed) in TEMPLATES.items():
        path = raw_dir / f"{name}.png"
        if not path.exists():
            continue
        rgba = key_out(pixelate(Image.open(path)))
        rgba[:max(0, COLLAR_TOP_Y - 4)] = 0  # nothing of the outfit above the collar zone
        Image.fromarray(snap_to_keys(rgba, {**KEYS, **fixed}), "RGBA").save(out_dir / f"{name}.png")
        done.append(name)
    print(f"templates: {', '.join(done) or 'none found'} -> {out_dir}")
    return done


def cmd_preview(faces_dir: Path | None = None, tpl_dir: Path | None = None, out: Path | None = None,
                batches_path: Path | None = None, limit: int = 12) -> Path | None:
    faces_dir, tpl_dir = faces_dir or P.out / "faces", tpl_dir or P.out / "templates"
    out, batches_path = out or P.out / "preview.png", batches_path or P.batches
    batches = json.loads(batches_path.read_text(encoding="utf-8"))
    teams = load_teams()
    tpl = {p.stem: np.asarray(Image.open(p).convert("RGBA")) for p in tpl_dir.glob("*.png")}
    if not tpl:
        print("preview: no templates yet")
        return None
    people = [(p, b["team"]) for b in batches for p in b["people"] if (faces_dir / p["face"]).exists()][:limit]
    other = ["GEN", "HLE", "KT", "T1"]
    fa = ["#3a4262", "#1b1f2e"]
    zoom, gap = 4, 10
    cols = 3
    sheet = Image.new("RGB", (cols * (SIZE * zoom + gap) + gap, max(1, len(people)) * (SIZE * zoom + 28) + 40), (15, 18, 32))
    d = ImageDraw.Draw(sheet)
    from PIL import ImageFont
    malgun = Path("C:/Windows/Fonts/malgun.ttf")
    f = ImageFont.truetype(str(malgun), 13) if malgun.exists() else None
    d.text((gap, 10), "왼쪽: 소속팀 · 가운데: 다른 팀으로 이적 · 오른쪽: FA", fill=(220, 222, 235), font=f)
    for r, (p, team_id) in enumerate(people):
        face = np.asarray(Image.open(faces_dir / p["face"]).convert("RGBA"))
        moved = next(t for t in other if t != team_id)
        if p["kind"] == "player":
            looks = [(tpl.get(jersey_for(team_id)), teams[team_id]["colors"]), (tpl.get(jersey_for(moved)), teams[moved]["colors"]),
                     (tpl.get("hoodie"), fa)]
        else:
            looks = [(tpl.get("suit"), teams[team_id]["colors"]), (tpl.get("suit"), teams[moved]["colors"]), (tpl.get("suit"), fa)]
        y = 40 + r * (SIZE * zoom + 28)
        for c, (t, colors) in enumerate(looks):
            x = gap + c * (SIZE * zoom + gap)
            img = compose(face, t, colors) if t is not None else compose(face, np.zeros((SIZE, SIZE, 4), np.uint8), colors)
            sheet.paste(img.convert("RGB").resize((SIZE * zoom, SIZE * zoom), Image.NEAREST), (x, y))
        d.text((gap, y + SIZE * zoom + 4), f"{p['name']} ({team_id} → {moved} → FA)", fill=(200, 205, 222), font=f)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"preview: {len(people)} people -> {out}")
    return out


# ---------------- self test with fake ChatGPT output ----------------
def fake_face_cell(seed: int) -> Image.Image:
    """A 512 px magenta cell with a blocky head, drawn off-centre, on a shifted grid, slightly blurred like ChatGPT output."""
    rng = np.random.default_rng(seed)
    px = Image.new("RGB", (SIZE, SIZE), BG_KEY)
    d = ImageDraw.Draw(px)
    ox, oy = int(rng.integers(-3, 4)), int(rng.integers(-3, 4))
    skin = tuple(int(v) for v in rng.choice([[241, 201, 165], [217, 164, 122], [198, 139, 94]]))
    hair = tuple(int(v) for v in rng.choice([[27, 27, 31], [90, 58, 32], [200, 180, 90]]))
    d.rectangle([20 + ox, 14 + oy, 43 + ox, 39 + oy], fill=skin)            # face
    d.rectangle([18 + ox, 8 + oy, 45 + ox, 17 + oy], fill=hair)             # hair
    d.rectangle([28 + ox, 40 + oy, 35 + ox, 50 + oy], fill=mix(skin, (0, 0, 0), 0.1))  # neck
    d.rectangle([25 + ox, 26 + oy, 27 + ox, 27 + oy], fill=(16, 16, 20))
    d.rectangle([36 + ox, 26 + oy, 38 + ox, 27 + oy], fill=(16, 16, 20))
    if seed % 2:
        d.rectangle([23 + ox, 25 + oy, 40 + ox, 25 + oy], fill=(34, 34, 34))   # glasses bar
    big = px.resize((CELL, CELL), Image.NEAREST)
    shift = Image.new("RGB", (CELL, CELL), BG_KEY)
    shift.paste(big, (int(rng.integers(0, 8)), int(rng.integers(0, 8))))
    return shift.filter(ImageFilter.GaussianBlur(0.8))


def fake_template(name: str) -> Image.Image:
    px = Image.new("RGB", (SIZE, SIZE), BG_KEY)
    d = ImageDraw.Draw(px)
    if name == "suit":
        d.polygon([(6, 63), (10, 50), (26, 46), (38, 46), (54, 50), (58, 63)], fill=hexrgb(SUIT_FIXED["jacket"]))
        d.polygon([(26, 46), (32, 56), (38, 46)], fill=hexrgb(SUIT_FIXED["shirt"]))
        d.rectangle([31, 48, 33, 63], fill=hexrgb(KEYS["main"]))
        d.rectangle([44, 52, 45, 53], fill=hexrgb(KEYS["sub"]))
    else:
        d.polygon([(6, 63), (10, 50), (26, 46), (38, 46), (54, 50), (58, 63)], fill=hexrgb(KEYS["main"]))
        d.rectangle([26, 46, 38, 48], fill=hexrgb(KEYS["sub"]))
        d.line([(10, 52), (24, 47)], fill=hexrgb(KEYS["accent"]))
        if name == "jersey_b":
            d.line([(44, 50), (20, 63)], fill=hexrgb(KEYS["sub"]), width=3)
        if name == "jersey_c":
            d.rectangle([8, 55, 56, 57], fill=hexrgb(KEYS["sub"]))
        d.rectangle([12, 56, 50, 58], fill=hexrgb(KEYS["main_dark"])) if name == "hoodie" else None
    d.rectangle([28, 46, 35, 49], fill=BG_KEY)  # neck opening
    return px.resize((CELL, CELL), Image.NEAREST).filter(ImageFilter.GaussianBlur(0.6))


def cmd_selftest() -> None:
    import tempfile
    import zlib
    tmp = Path(tempfile.mkdtemp(prefix="portrait_selftest_"))
    batches = json.loads(P.batches.read_text(encoding="utf-8"))[:2]
    for b in batches:
        grid = Image.new("RGB", (3 * CELL, 2 * CELL), BG_KEY)
        for i, _ in enumerate(b["people"]):
            grid.paste(fake_face_cell(zlib.crc32(b["folder"].encode()) % 1000 + i), ((i % 3) * CELL, (i // 3) * CELL))
        (tmp / "gen" / b["folder"]).mkdir(parents=True, exist_ok=True)
        grid.save(tmp / "gen" / b["folder"] / f"batch{b['batch']}.png")
    (tmp / "batches.json").write_text(json.dumps(batches, ensure_ascii=False), encoding="utf-8")
    (tmp / "raw").mkdir()
    for name in TEMPLATES:
        fake_template(name).save(tmp / "raw" / f"{name}.png")
    report = cmd_faces(tmp / "gen", tmp / "faces", tmp / "batches.json", tmp / "retakes")
    bad = []
    for pid, r in report.items():
        face = np.asarray(Image.open(tmp / "faces" / r["face"]))
        chin, centre = neck_anchor(face) or (None, None)
        if chin != CHIN_Y or abs(centre - CENTER_X) > 1:
            bad.append((pid, chin, centre))
    done = cmd_templates(tmp / "raw", tmp / "templates")
    for name in done:
        t = np.asarray(Image.open(tmp / "templates" / f"{name}.png"))
        allowed = {hexrgb(v) for v in {**KEYS, **TEMPLATES[name][2]}.values()}
        colours = {tuple(c) for c in t[t[..., 3] > 0][:, :3]}
        if not colours <= allowed:
            bad.append((name, "non-key colours", len(colours - allowed)))
    out = cmd_preview(tmp / "faces", tmp / "templates", tmp / "preview.png", tmp / "batches.json", limit=6)
    print(f"selftest folder: {tmp}")
    print("selftest:", "PASS" if not bad else f"FAIL {bad}")
    if out:
        print(f"selftest preview: {out}")


def cmd_check() -> bool:
    """Final acceptance: every template, every face present and aligned. Writes output/check_report.json."""
    batches = json.loads(P.batches.read_text(encoding="utf-8"))
    faces_dir, tpl_dir = P.out / "faces", P.out / "templates"
    problems = []
    for name, (_, _, fixed) in TEMPLATES.items():
        path = tpl_dir / f"{name}.png"
        if not path.exists():
            problems.append({"what": "template", "name": name, "problem": "missing"})
            continue
        t = np.asarray(Image.open(path).convert("RGBA"))
        allowed = {hexrgb(v) for v in {**KEYS, **fixed}.values()}
        if not {tuple(c) for c in t[t[..., 3] > 0][:, :3]} <= allowed:
            problems.append({"what": "template", "name": name, "problem": "colours outside the key palette"})
        if (t[:COLLAR_TOP_Y - 4, :, 3] > 0).any():
            problems.append({"what": "template", "name": name, "problem": "drawn above the collar zone"})
    people = [(b, p) for b in batches for p in b["people"]]
    for b, p in people:
        path = faces_dir / p["face"]
        if not path.exists():
            problems.append({"what": "face", "id": p["id"], "name": p["name"], "batch": f"{b['folder']}/batch{b['batch']}",
                             "problem": "missing"})
            continue
        face = np.asarray(Image.open(path).convert("RGBA"))
        anchor = neck_anchor(face)
        if anchor is None or anchor[0] != CHIN_Y or abs(anchor[1] - CENTER_X) > 1:
            problems.append({"what": "face", "id": p["id"], "name": p["name"], "batch": f"{b['folder']}/batch{b['batch']}",
                             "problem": f"neck not on the anchor ({anchor})"})
        opaque = face[..., 3] > 0
        if opaque.sum() < 300:
            problems.append({"what": "face", "id": p["id"], "name": p["name"], "problem": "almost empty"})
        if (face[48:, :, 3] > 0).sum(axis=1).max(initial=0) > 20:
            problems.append({"what": "face", "id": p["id"], "name": p["name"], "problem": "something wide below the chin (shoulders or clothes?)"})
    P.out.mkdir(parents=True, exist_ok=True)
    (P.out / "check_report.json").write_text(json.dumps(problems, ensure_ascii=False, indent=1), encoding="utf-8")
    done_faces = sum(1 for _, p in people if (faces_dir / p["face"]).exists())
    print(f"check: templates {sum(1 for n in TEMPLATES if (tpl_dir / f'{n}.png').exists())}/{len(TEMPLATES)}, "
          f"faces {done_faces}/{len(people)}, problems {len(problems)} -> {P.out / 'check_report.json'}")
    return not problems


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["faces", "templates", "preview", "check", "selftest"])
    ap.add_argument("--kit", type=Path, help="run inside a portrait kit folder (work/, output/, prompts/, data/)")
    a = ap.parse_args()
    if a.kit:
        P = Paths(a.kit.resolve())
    result = {"faces": cmd_faces, "templates": cmd_templates, "preview": cmd_preview, "check": cmd_check,
              "selftest": cmd_selftest}[a.command]()
    if a.command == "check" and not result:
        sys.exit(1)
