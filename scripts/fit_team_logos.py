"""Give every team logo the same visual size and centre, and write small copies for sharp downscaling.

The game shows each logo on a white square tile (LogoBox in game/src/ui/components.tsx, no padding).
Logos come in very different shapes: a wide wordmark (DK, T1, HLE) fitted with `contain` looks far
smaller than a round emblem (BFX) in the same tile. This script bakes a common fit into the PNG itself:

  - trim the transparent margin, then centre the logo's bounding box on a 256 px transparent square;
  - scale so the geometric mean of width and height is A of the canvas (same "area" for every logo),
    nudged by ink coverage (dense solid marks slightly smaller, thin line marks slightly larger);
  - never let the longest side pass M of the canvas (wide and tall logos stop at the tile edge margin).

It also writes <ID>@32.png, @64.png and @128.png next to <ID>.png; LogoBox lists them in srcset so the
browser picks a copy close to the displayed size instead of shrinking 256 px down to 16-56 px.

Originals are kept in data/logo_src/<ID>.png. data/logo_src/fitted.json holds the sha1 of each fitted
output: when logos/<ID>.png no longer matches it (update_team_logos.py or a hand copy replaced it), the
new file is taken as the original and fitted again. Running the script twice changes nothing.

  python scripts/fit_team_logos.py
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO_DIR = ROOT / "game" / "public" / "data" / "logos"
SRC_DIR = ROOT / "data" / "logo_src"
MANIFEST = SRC_DIR / "fitted.json"

CANVAS = 256
A = 0.68    # geometric-mean side of the logo / canvas
M = 0.92    # longest side cap / canvas
K = 0.20    # ink-coverage exponent (0 = ignore coverage)
INK_REF = 0.55
VARIANTS = (32, 64, 128)


def sha1(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def fit(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    box = image.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if box:
        image = image.crop(box)
    w, h = image.size
    hist = image.getchannel("A").histogram()
    ink = sum(i * n for i, n in enumerate(hist)) / 255 / (w * h)
    scale = A * CANVAS / (w * h) ** 0.5 * (INK_REF / max(ink, 0.05)) ** K
    scale = min(scale, M * CANVAS / max(w, h))
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    image = image.resize(size, Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((CANVAS - size[0]) // 2, (CANVAS - size[1]) // 2))
    return canvas


def main() -> None:
    SRC_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}

    for path in sorted(LOGO_DIR.glob("*.png")):
        if "@" in path.stem:
            continue
        tid = path.stem
        if manifest.get(tid) != sha1(path):
            shutil.copy2(path, SRC_DIR / path.name)
            print(f"{tid}: new original saved to data/logo_src")

    for src in sorted(SRC_DIR.glob("*.png")):
        tid = src.stem
        fitted = fit(Image.open(src))
        out = LOGO_DIR / f"{tid}.png"
        fitted.save(out, optimize=True)
        for n in VARIANTS:
            fitted.resize((n, n), Image.LANCZOS).save(LOGO_DIR / f"{tid}@{n}.png", optimize=True)
        manifest[tid] = sha1(out)

    MANIFEST.write_text(json.dumps(manifest, indent=1, sort_keys=True), encoding="utf-8")
    print(f"fitted {len(manifest)} logos")


if __name__ == "__main__":
    main()
