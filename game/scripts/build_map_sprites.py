"""Map sprites for the match view, from the owner's pixel-art cut-outs.

  python -X utf8 game/scripts/build_map_sprites.py --src data/sprites_pixel/cutout [--sheet out.png]

Source: data/sprites_pixel/cutout/*.png (not in git: large originals, see its README.md). Each is pixel art drawn
on a coarse grid but saved at many real pixels per drawn pixel (camp icons ~26, Baron and Herald ~9, structures
~5.5, drakes 1-2), far larger than anything on the 512 px match canvas.

Output: game/public/assets/map/<name>.png and <name>_2x.png, already at the size they are drawn at. The renderer
(match/sprites.ts) puts them on whole canvas pixels without scaling, so nothing is resampled at run time and the
canvas's own nearest-neighbour scaling keeps every sprite pixel square at any map size or screen scale.
  <name>.png     the whole map (one canvas pixel is about 30 map units)
  <name>_2x.png   close-ups (camera under 9,000 units wide): twice the size, cut from the source again rather than
                 doubled, so it has the detail of its size

How a sprite is shrunk: the source is cropped to its drawing and resampled down with premultiplied alpha (so the
transparent surround does not darken the edge). Shrinking a 230 px dragon to 25 px averages its colours into mud,
so saturation, contrast and brightness are raised again (more for the smaller size); then the alpha is cut to
on / off and a one-pixel dark outline is drawn around the shape, which is what keeps a blue dragon readable on
the blue water of its pit. The camp icons are small enough in the source grid (19 x 14 and 13 x 13 drawn pixels)
to come out close to pixel for pixel.

Also rewrites the scoreboard's dragon and dragon-soul icons (public/assets/hud/drake_*.png, soul_*.png) from the
same set (hud_drake_*, hud_soul_*), at the size of the icons they replace.
"""
import argparse
import os

from PIL import Image, ImageEnhance

ap = argparse.ArgumentParser()
ap.add_argument("--src", default="data/sprites_pixel/cutout")
ap.add_argument("--out", default="game/public/assets/map")
ap.add_argument("--hud", default="game/public/assets/hud")
ap.add_argument("--sheet", help="also write a contact sheet of everything made, on the map's ground colours")
a = ap.parse_args()

ELEMENTS = ["fire", "water", "earth", "air", "hextech", "chemtech", "elder"]
OUTLINE = (5, 7, 13, 255)

# name -> (source file, height in canvas px on the whole map). Width follows the drawing's proportions.
# Sizes: a champion icon is 15 px (19 with its ring), a lane is about 14 px wide, a pit about 36 px across.
SPRITES = {
    "baron": ("baron", 28),
    "herald": ("herald", 22),
    "grub": ("grub", 10),
    "camp_buff": ("hud_camp_buff", 10),
    "camp_small": ("hud_camp_small", 9),
    "turret_blue": ("turret_blue", 15),
    "turret_red": ("turret_red", 15),
    "turret_blue_destroyed": ("turret_blue_destroyed", 6),
    "turret_red_destroyed": ("turret_red_destroyed", 6),
    "inhibitor_blue": ("inhibitor_blue", 10),
    "inhibitor_red": ("inhibitor_red", 10),
    "inhibitor_blue_destroyed": ("inhibitor_blue_destroyed", 7),
    "inhibitor_red_destroyed": ("inhibitor_red_destroyed", 7),
    "nexus_blue": ("nexus_blue", 14),
    "nexus_red": ("nexus_red", 14),
    "nexus_blue_destroyed": ("nexus_blue_destroyed", 10),
    "nexus_red_destroyed": ("nexus_red_destroyed", 10),
}
for el in ELEMENTS:
    SPRITES[f"drake_{el}"] = (f"drake_2_{el}", 25)  # the winged pose (drake_2), the owner's pick

# (saturation, contrast, brightness) put back after the shrink: whole-map size, close-up size
BOOST = {1: (1.45, 1.25, 1.12), 2: (1.3, 1.18, 1.08)}


def crop(im: Image.Image) -> Image.Image:
    return im.crop(im.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox())


def shrink(im: Image.Image, h: int, boost: tuple[float, float, float]) -> Image.Image:
    """Down to height h (premultiplied alpha), colours raised, hard alpha, dark outline. 2 px larger each way."""
    im = crop(im.convert("RGBA"))
    w = max(1, round(im.size[0] * h / im.size[1]))
    small = im.convert("RGBa").resize((w, h), Image.LANCZOS).convert("RGBA")
    alpha = small.getchannel("A")
    rgb = small.convert("RGB")
    for enhancer, amount in zip((ImageEnhance.Color, ImageEnhance.Contrast, ImageEnhance.Brightness), boost):
        rgb = enhancer(rgb).enhance(amount)
    small = rgb.convert("RGBA")
    small.putalpha(alpha)
    px = small.load()
    out = Image.new("RGBA", (w + 2, h + 2), (0, 0, 0, 0))
    op = out.load()
    solid = [[px[x, y][3] >= 110 for x in range(w)] for y in range(h)]
    for y in range(h):
        for x in range(w):
            if solid[y][x]:
                r, g, b, _ = px[x, y]
                op[x + 1, y + 1] = (r, g, b, 255)
    # outline: every empty pixel that touches the shape (4 neighbours)
    for y in range(h + 2):
        for x in range(w + 2):
            if op[x, y][3]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                sx, sy = x + dx - 1, y + dy - 1
                if 0 <= sx < w and 0 <= sy < h and solid[sy][sx]:
                    op[x, y] = OUTLINE
                    break
    return out


os.makedirs(a.out, exist_ok=True)
made = []
for name, (src, h) in SPRITES.items():
    im = Image.open(os.path.join(a.src, src + ".png"))
    for suffix, k in (("", 1), ("_2x", 2)):
        out = shrink(im, h * k, BOOST[k])
        out.save(os.path.join(a.out, f"{name}{suffix}.png"), optimize=True)
        made.append((f"{name}{suffix}", out))
print(f"{len(made)} map sprites -> {a.out}")

# scoreboard icons: the same file names and about the same size as the ones they replace (shown at 16-28 CSS px)
n = 0
for kind, size in (("drake", 54), ("soul", 68)):
    for el in ELEMENTS:
        p = os.path.join(a.src, f"hud_{kind}_{el}.png")
        if not os.path.exists(p):
            continue
        im = crop(Image.open(p).convert("RGBA"))
        side = max(im.size)
        sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        sq.paste(im, ((side - im.size[0]) // 2, (side - im.size[1]) // 2))
        sq.convert("RGBa").resize((size, size), Image.LANCZOS).convert("RGBA").save(os.path.join(a.hud, f"{kind}_{el}.png"), optimize=True)
        n += 1
print(f"{n} scoreboard icons -> {a.hud}")

if a.sheet:
    # everything at 4x on the two ground colours of the minimap (olive land, blue river) and on a wall
    cols = [(143, 152, 105), (22, 120, 150), (5, 7, 13)]
    pad, k = 6, 4
    rows = [made[i:i + 12] for i in range(0, len(made), 12)]
    W = max(sum(im.size[0] * k + pad for _, im in r) for r in rows) + pad
    H = sum(max(im.size[1] for _, im in r) * k + pad for r in rows) + pad
    sheet = Image.new("RGB", (W, H * len(cols)), (0, 0, 0))
    for ci, col in enumerate(cols):
        band = Image.new("RGB", (W, H), col)
        y = pad
        for r in rows:
            x = pad
            for _, im in r:
                big = im.resize((im.size[0] * k, im.size[1] * k), Image.NEAREST)
                band.paste(big, (x, y), big)
                x += big.size[0] + pad
            y += max(im.size[1] for _, im in r) * k + pad
        sheet.paste(band, (0, H * ci))
    sheet.save(a.sheet)
    print("sheet", a.sheet, sheet.size)
