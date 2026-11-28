"""Cut the match scorebar's icons out of the League client's own UI art (served by CommunityDragon)
and write them to game/public/assets/hud/.

    python game/scripts/build_hud_icons.py            # download the atlases, cut, write
    python game/scripts/build_hud_icons.py --cache D  # keep the downloaded atlases in D

Sources (raw.communitydragon.org/latest):
  game/assets/ux/scoreboard/neutraltimersatlas.png   in-game objective timer icons (drakes, baron, herald)
  game/assets/ux/srx/dragonuiprototype.png           dragon soul badges (diamonds, one per element)
  game/assets/ux/minimap/icons/grub.png              void grubs
  plugins/rcp-fe-lol-match-history/.../right_icons_grub.png   flat team-stat icons (tower)
  plugins/rcp-fe-lol-match-history/.../icon_gold.png          gold coins
  plugins/rcp-fe-lol-postgame/.../scoreboard-sword-icon.svg   sword (drawn twice, crossed)
"""
import argparse
import os
import re
import tempfile
import urllib.request

from PIL import Image

CD = "https://raw.communitydragon.org/latest"
SRC = {
    "timers": f"{CD}/game/assets/ux/scoreboard/neutraltimersatlas.png",
    "srx": f"{CD}/game/assets/ux/srx/dragonuiprototype.png",
    "grub": f"{CD}/game/assets/ux/minimap/icons/grub.png",
    "stats": f"{CD}/plugins/rcp-fe-lol-match-history/global/default/right_icons_grub.png",
    "gold": f"{CD}/plugins/rcp-fe-lol-match-history/global/default/icon_gold.png",
    "sword": f"{CD}/plugins/rcp-fe-lol-postgame/global/default/scoreboard-sword-icon.svg",
}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "assets", "hud")

# where each icon sits in its atlas: a search box; the icon is the opaque part inside it
TIMERS = {  # neutraltimersatlas.png (1024x512)
    "baron": (30, 250, 100, 322),
    "herald": (336, 250, 386, 322),
    "drake_water": (120, 345, 170, 422),
    "drake_air": (188, 345, 234, 422),
    "drake_fire": (257, 345, 302, 422),
    "drake_earth": (322, 345, 370, 422),
    "drake_elder": (399, 345, 449, 422),
    "drake_chemtech": (468, 345, 523, 422),
    "drake_hextech": (542, 345, 593, 422),
}
SRX = {  # dragonuiprototype.png (512x512): the colored diamonds are the soul badges
    "soul_air": (1, 110, 75, 186),
    "soul_earth": (76, 110, 150, 186),
    "soul_fire": (151, 110, 225, 186),
    "soul_water": (226, 110, 300, 186),
    "soul_chemtech": (377, 110, 452, 186),
    "soul_hextech": (9, 313, 85, 390),
}


def fetch(url: str, cache: str) -> str:
    path = os.path.join(cache, re.sub(r"[^A-Za-z0-9._-]", "_", url.split("/latest/")[1]))
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": "lck-manager-asset-script"})
        with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
            f.write(r.read())
    return path


def trim(im: Image.Image, box, alpha=8) -> Image.Image:
    """The opaque part of `box`, padded to a square so icons line up."""
    c = im.crop(box)
    bb = c.getchannel("A").point(lambda a: 255 if a > alpha else 0).getbbox()
    c = c.crop(bb)
    side = max(c.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.alpha_composite(c, ((side - c.width) // 2, (side - c.height) // 2))
    return sq


def tint(im: Image.Image, light, dark) -> Image.Image:
    """Recolor a flat one-color icon: its brightness (relative to its brightest pixel) picks a color
    between `dark` and `light`, alpha kept."""
    px = im.load()
    out = Image.new("RGBA", im.size)
    po = out.load()
    top = max(sum(px[x, y][:3]) for y in range(im.height) for x in range(im.width) if px[x, y][3] > 128) or 1
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            t = min(1.0, (r + g + b) / top)
            po[x, y] = tuple(round(dark[i] + (light[i] - dark[i]) * t) for i in range(3)) + (a,)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "lck_hud_atlas"))
    # The dragon and dragon-soul icons (drake_*.png, soul_*.png) are no longer the client's: they are the owner's
    # pixel art, written by build_map_sprites.py. This script leaves them alone unless told to put the client's back.
    ap.add_argument("--client-dragons", action="store_true", help="also overwrite drake_*.png and soul_*.png with the client's icons")
    args = ap.parse_args()
    cache = args.cache
    os.makedirs(cache, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    src = {k: fetch(u, cache) for k, u in SRC.items()}

    timers = Image.open(src["timers"]).convert("RGBA")
    for name, box in TIMERS.items():
        if name.startswith("drake_") and not args.client_dragons:
            continue
        trim(timers, box).save(os.path.join(OUT, f"{name}.png"))
    srx = Image.open(src["srx"]).convert("RGBA")
    for name, box in SRX.items():
        if not args.client_dragons:
            continue
        trim(srx, box).save(os.path.join(OUT, f"{name}.png"))
    trim(Image.open(src["grub"]).convert("RGBA"), (0, 0, 64, 64)).save(os.path.join(OUT, "grub.png"))

    # flat stat icons are beige (#A09B8C) on a dark halo in the client; lighten the icon so it reads on the dark bar
    # like the broadcast's, and keep the halo dark (it works as an outline)
    stats = Image.open(src["stats"]).convert("RGBA")
    tint(trim(stats, (0, 0, 80, 80)), (240, 236, 226), (10, 12, 18)).save(os.path.join(OUT, "tower.png"))
    # the gold coins: top half of icon_gold.png is the lit state; color it gold
    gold = Image.open(src["gold"]).convert("RGBA")
    tint(trim(gold, (0, 0, 56, 48)), (255, 214, 102), (150, 96, 18)).save(os.path.join(OUT, "gold.png"))

    # crossed swords: the client's sword path, once as is and once mirrored
    svg = open(src["sword"], encoding="utf-8").read()
    d = re.search(r'\sd="([^"]+)"', svg).group(1)
    with open(os.path.join(OUT, "swords.svg"), "w", encoding="utf-8") as f:
        f.write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">'
            f'<path fill-rule="evenodd" d="{d}" fill="#ECE8DE"/>'
            f'<path fill-rule="evenodd" d="{d}" fill="#ECE8DE" transform="matrix(-1 0 0 1 20 0)"/>'
            "</svg>\n"
        )
    for f in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, f)
        print(f, Image.open(p).size if f.endswith(".png") else "", os.path.getsize(p))


if __name__ == "__main__":
    main()
