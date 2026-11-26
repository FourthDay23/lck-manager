"""Save the profile photos team by team: one folder per team with every player's and coach's photo and a team sheet.

  python scripts/export_team_photos.py

Output (rebuilt from scratch each run):
  data/team_photos/1_LCK/01_T1/00_sheet.png         the team on one sheet (same look as the big sheet)
  data/team_photos/1_LCK/01_T1/01_Top_Doran.png      384 px square head-and-shoulders crop, roster order:
  ...                                               players first (last roster order), then head coach, coaches
  data/team_photos/2_LCK_CL/..., data/team_photos/3_INTL/...
Photos come from data/player_photos/ and data/staff_photos/ (see their manifests for each photo's source).
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_photo_sheet import headshot, manifests, photo_of, render  # noqa: E402
from build_portrait_sheet import groups  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "team_photos"
SECTION_DIR = {"LCK": "1_LCK", "LCK CL": "2_LCK_CL", "해외 (MSI·Worlds 2026)": "3_INTL", "기타": "4_OTHER"}
ROLE_FILE = {"Head Coach": "HeadCoach", "Coach": "Coach", "Strategic Coach": "StrategicCoach", "Analyst": "Analyst"}


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "x"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    manifest, sman = manifests()
    counts = {}
    total = missing = 0
    for g in groups():
        section = SECTION_DIR.get(g["section"], "4_OTHER")
        counts[section] = counts.get(section, 0) + 1
        team_id = next((c["team"] for c in g["cells"] if c["team"]), "OTHER")
        folder = OUT / section / f"{counts[section]:02d}_{safe(team_id)}"
        folder.mkdir(parents=True)
        for i, c in enumerate(g["cells"], 1):
            path, _ = photo_of(c, manifest, sman)
            role = c["role"] if c["kind"] == "player" else ROLE_FILE.get(c["role"], safe(c["role"]))
            if path is None:
                missing += 1
                continue
            headshot(path, 384).save(folder / f"{i:02d}_{role}_{safe(c['name'])}.png")
            total += 1
        cols = min(11, max(5, len(g["cells"])))
        render([g], folder / "00_sheet.png", g["title"].replace("  ", " · "), cols=cols)
    print(f"{OUT}: {sum(counts.values())} teams, {total} photos, {missing} without photo")


if __name__ == "__main__":
    main()
