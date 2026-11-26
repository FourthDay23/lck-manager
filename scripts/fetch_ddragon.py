"""Download Data Dragon champion data (ko_KR, en_US) and the square portraits.

  python scripts/fetch_ddragon.py [version]

Files land in data/ddragon/<version>/ (championFull_<locale>.json, img/<id>.png). Existing files are kept.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CDN = "https://ddragon.leagueoflegends.com"
HEADERS = {"User-Agent": "lolsim-research/0.1"}


def main() -> int:
    version = sys.argv[1] if len(sys.argv) > 1 else requests.get(f"{CDN}/api/versions.json", headers=HEADERS, timeout=30).json()[0]
    out = ROOT / "data" / "ddragon" / version
    (out / "img").mkdir(parents=True, exist_ok=True)
    for locale in ("ko_KR", "en_US"):
        path = out / f"championFull_{locale}.json"
        if not path.exists():
            response = requests.get(f"{CDN}/cdn/{version}/data/{locale}/championFull.json", headers=HEADERS, timeout=60)
            response.raise_for_status()
            path.write_bytes(response.content)
    champions = json.loads((out / "championFull_en_US.json").read_text(encoding="utf-8"))["data"]
    fetched = 0
    for champ_id in sorted(champions):
        path = out / "img" / f"{champ_id}.png"
        if path.exists():
            continue
        response = requests.get(f"{CDN}/cdn/{version}/img/champion/{champ_id}.png", headers=HEADERS, timeout=30)
        response.raise_for_status()
        path.write_bytes(response.content)
        fetched += 1
        time.sleep(0.05)
    print(f"version {version}: {len(champions)} champions, {fetched} portraits fetched -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
