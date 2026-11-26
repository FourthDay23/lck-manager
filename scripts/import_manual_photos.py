"""Photos the user downloaded by hand for the three people no site had a profile photo for.

  python scripts/import_manual_photos.py

Sources (saved by the user into data/leaguepedia_gallery/ on 2026-11-26, identified by eye):
  - Eclipse (Kim Min-jun, T1 Esports Academy): T1 "Sub-roster call-up ECLIPSE" graphic -> crop off the grey frame
    and the caption.
  - Gyul (Park Ju-won, Gen.G Global Academy coach): "THANK YOU ... GYUL" farewell graphic -> crop below the title.
  - Dopil (Yang Seong-pil, BNK FEARX Youth coach): plain photo saved as Dopil.webp.
The originals are copied to data/manual_photos/ and the crops written next to the other photos, with manifest
entries marked source "manual".
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
INBOX = ROOT / "data" / "leaguepedia_gallery"
KEEP = ROOT / "data" / "manual_photos"
PLAYER_DIR = ROOT / "data" / "player_photos"
STAFF_DIR = ROOT / "data" / "staff_photos"

# id, kind, name, file in INBOX (prefix match), square crop box (left, top, right, bottom) in source pixels
PHOTOS = [
    ("Eclipse (Kim Min-jun)", "player", "Eclipse", "kKHmsBCZLxGYQeOa9P", (75, 56, 455, 436)),
    ("Gyul", "staff", "Gyul", "images.jfif", (80, 80, 322, 322)),  # starts under the "THANK YOU" title
    ("Dopil", "staff", "Dopil", "Dopil.webp", (25, 15, 195, 185)),
]


def main() -> None:
    KEEP.mkdir(parents=True, exist_ok=True)
    for pid, kind, name, prefix, box in PHOTOS:
        source = next(p for p in INBOX.iterdir() if p.is_file() and p.name.startswith(prefix))
        original = KEEP / f"{name}_original{source.suffix.lower()}"
        shutil.copy2(source, original)
        crop = Image.open(source).convert("RGB").crop(box).resize((384, 384), Image.LANCZOS)
        folder = PLAYER_DIR if kind == "player" else STAFF_DIR
        target = folder / f"manual_{name}.png"
        crop.save(target)
        man_path = folder / "manifest.json"
        man = json.loads(man_path.read_text(encoding="utf-8"))
        old = man.get(pid, {})
        man[pid] = {"name": name, "photo": target.name, "source": "manual", "original": f"data/manual_photos/{original.name}",
                    "note": "downloaded by the user; identity checked from the caption / file name",
                    "previous": {k: old.get(k) for k in ("why", "liquipedia") if old.get(k)}}
        man_path.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{pid:<24} {source.name[:40]:<40} -> {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
