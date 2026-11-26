"""Turn Leaguepedia V5 timelines into position heatmaps for the LoLSim engine.

Outputs (under output/heatmaps/ and data/heatmaps/):
  role_phase_grid.png    5 roles x 6 time windows, own-side view (red side mirrored onto blue)
  jungle_early.png       junglers at minutes 1-6, own-side view
  kills_phase.png        where champion kills happen, real map coordinates (no mirroring)
  _alignment_check.png   turret/inhib kill positions over the minimap, to prove the overlay lines up
  role_minute_grid.json  per role, per minute counts on a coarse grid, for the sim engine

Why mirror red side across the anti-diagonal (x, y) -> (c - y, c - x) and not through the
center: a point reflection would throw red's bot laner into blue's top lane. The anti-diagonal
keeps top lane on top and dragon pit at the bottom river, so roles stack cleanly.

Usage:
  python scripts/build_heatmaps.py --index data/games_lck_2026.json --label "LCK 2026"
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy.ndimage import gaussian_filter  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MINIMAP = ROOT / "data" / "assets" / "map11.png"
# Riot's documented coordinate bounds for Summoner's Rift (map 11); the Data Dragon minimap covers exactly this box.
MAP_MIN_X, MAP_MIN_Y, MAP_MAX_X, MAP_MAX_Y = -120, -120, 14870, 14980
EXTENT = (MAP_MIN_X, MAP_MAX_X, MAP_MIN_Y, MAP_MAX_Y)

ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
ROLE_KO = {"Top": "탑", "Jungle": "정글", "Mid": "미드", "Bot": "원딜", "Support": "서폿"}
PHASES = [(1, 3, "1–3분"), (4, 7, "4–7분"), (8, 13, "8–13분"),
          (14, 19, "14–19분"), (20, 25, "20–25분"), (26, 99, "26분 이후")]
FINE_BIN = 125      # map units per heatmap cell (map is ~15000 wide -> ~120 cells)
COARSE_BIN = 500    # cells for the engine export (30 x 30)
MAX_MINUTE = 45

CHAMPION_ALIASES = {"wukong": "monkeyking", "nunuwillump": "nunu", "renataglasc": "renata"}

plt.rcParams["font.family"] = "Malgun Gothic"
plt.rcParams["axes.unicode_minus"] = False


def champion_key(name: str) -> str:
    key = re.sub(r"[^a-z]", "", name.lower())
    return CHAMPION_ALIASES.get(key, key)


def load_game(raw_path: Path) -> dict:
    with gzip.open(raw_path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def unwrap(payload: dict | None) -> dict | None:
    if payload is None:
        return None
    return payload.get("info", payload)


def assign_roles(data: dict, roster: list[dict], stats: Counter) -> dict[int, tuple[int, str]]:
    """participantId -> (side 1=blue/2=red, role). Scoreboard first, participant order as fallback."""
    by_side_champion = {(row["side"], champion_key(row["champion"])): row["role"] for row in roster}
    assigned = {}
    for participant in data["participants"]:
        pid = participant["participantId"]
        side = 1 if participant["teamId"] == 100 else 2
        order_role = ROLES[(pid - 1) % 5]
        role = by_side_champion.get((side, champion_key(participant["championName"])))
        if role not in ROLES:
            stats["role_fallback_to_order"] += 1
            role = order_role
        elif role != order_role:
            stats["role_differs_from_order"] += 1
        else:
            stats["role_matches_order"] += 1
        assigned[pid] = (side, role)
    return assigned


def fountain_mirror_constant(games: list[tuple[dict, dict, dict]]) -> float:
    """Fit c in (x, y) -> (c - y, c - x) from where both teams stand in the first frame."""
    blue, red = [], []
    for _, timeline, roles in games:
        first = timeline["frames"][0]["participantFrames"]
        for pid_text, frame in first.items():
            side, _ = roles[int(pid_text)]
            (blue if side == 1 else red).append((frame["position"]["x"], frame["position"]["y"]))
    bx, by = np.mean(blue, axis=0)
    rx, ry = np.mean(red, axis=0)
    return float(((bx + ry) + (by + rx)) / 2)


def to_own_side(x: float, y: float, side: int, mirror_c: float) -> tuple[float, float]:
    if side == 1:
        return x, y
    return mirror_c - y, mirror_c - x


def empty_grid(bin_size: int) -> np.ndarray:
    nx = int(np.ceil((MAP_MAX_X - MAP_MIN_X) / bin_size))
    ny = int(np.ceil((MAP_MAX_Y - MAP_MIN_Y) / bin_size))
    return np.zeros((nx, ny), dtype=np.int32)


def add_point(grid: np.ndarray, bin_size: int, x: float, y: float) -> None:
    ix = int((x - MAP_MIN_X) // bin_size)
    iy = int((y - MAP_MIN_Y) // bin_size)
    if 0 <= ix < grid.shape[0] and 0 <= iy < grid.shape[1]:
        grid[ix, iy] += 1


def draw_panel(ax, counts: np.ndarray, title: str, minimap: np.ndarray, cmap_name: str = "inferno",
               sigma: float = 1.6) -> None:
    ax.imshow(minimap, extent=EXTENT, origin="upper")
    ax.imshow(np.zeros((2, 2, 4)) + [0, 0, 0, 0.45], extent=EXTENT, origin="lower")  # dim the map
    if counts.sum() > 0:
        smooth = gaussian_filter(counts.astype(float), sigma=sigma)
        level = np.sqrt(smooth / smooth.max())  # sqrt so thin spread still shows next to hot spots
        rgba = plt.get_cmap(cmap_name)(level)
        rgba[..., 3] = np.clip(level * 1.25, 0, 0.92)
        ax.imshow(np.transpose(rgba, (1, 0, 2)), extent=EXTENT, origin="lower", interpolation="bilinear")
    ax.set_xlim(MAP_MIN_X, MAP_MAX_X)
    ax.set_ylim(MAP_MIN_Y, MAP_MAX_Y)
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(title, fontsize=11, pad=4)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", default=str(ROOT / "data" / "games_lck_2026.json"))
    parser.add_argument("--label", default="LCK 2026")
    args = parser.parse_args()

    index = json.loads(Path(args.index).read_text(encoding="utf-8"))
    out_dir = ROOT / "output" / "heatmaps"
    export_dir = ROOT / "data" / "heatmaps"
    out_dir.mkdir(parents=True, exist_ok=True)
    export_dir.mkdir(parents=True, exist_ok=True)
    minimap = np.asarray(Image.open(MINIMAP).convert("RGB"))

    stats: Counter = Counter()
    games = []
    for entry in index["games"]:
        raw = load_game(ROOT / entry["raw"])
        data, timeline = unwrap(raw["data"]), unwrap(raw["timeline"])
        if timeline is None:
            stats["games_without_timeline"] += 1
            continue
        games.append((data, timeline, assign_roles(data, entry["roster"], stats)))
    mirror_c = fountain_mirror_constant(games)

    role_phase = {(role, phase): empty_grid(FINE_BIN) for role in ROLES for phase in range(len(PHASES))}
    jungle_minute = {minute: empty_grid(FINE_BIN) for minute in range(1, 7)}
    kills_phase = {phase: empty_grid(FINE_BIN) for phase in range(len(PHASES))}
    structures = []
    engine = {role: {minute: empty_grid(COARSE_BIN) for minute in range(1, MAX_MINUTE + 1)} for role in ROLES}

    def phase_of(minute: int) -> int | None:
        for number, (start, end, _) in enumerate(PHASES):
            if start <= minute <= end:
                return number
        return None

    for data, timeline, roles in games:
        stats["games"] += 1
        for frame in timeline["frames"]:
            minute = round(frame["timestamp"] / 60000)
            phase = phase_of(minute)
            if minute >= 1:
                for pid_text, pframe in frame["participantFrames"].items():
                    side, role = roles[int(pid_text)]
                    if pframe.get("championStats", {}).get("health", 1) <= 0:
                        stats["dead_samples_skipped"] += 1  # a dead player's position is where they died
                        continue
                    x, y = to_own_side(pframe["position"]["x"], pframe["position"]["y"], side, mirror_c)
                    stats["position_samples"] += 1
                    if phase is not None:
                        add_point(role_phase[(role, phase)], FINE_BIN, x, y)
                    if role == "Jungle" and minute in jungle_minute:
                        add_point(jungle_minute[minute], FINE_BIN, x, y)
                    if minute <= MAX_MINUTE:
                        add_point(engine[role][minute], COARSE_BIN, x, y)
            for event in frame["events"]:
                position = event.get("position")
                if not position:
                    continue
                if event["type"] == "CHAMPION_KILL":
                    kill_phase = phase_of(max(1, round(event["timestamp"] / 60000)))
                    if kill_phase is not None:
                        add_point(kills_phase[kill_phase], FINE_BIN, position["x"], position["y"])
                        stats["kills"] += 1
                elif event["type"] == "BUILDING_KILL":
                    structures.append((position["x"], position["y"]))

    caption = (f"{args.label} · {stats['games']}경기 · Leaguepedia V5 타임라인(1분 간격 좌표) · "
               f"레드 진영은 블루 시점으로 대칭 변환")

    # 1. role x phase grid
    fig, axes = plt.subplots(len(ROLES), len(PHASES), figsize=(len(PHASES) * 2.7, len(ROLES) * 2.85))
    for row, role in enumerate(ROLES):
        for col, (_, _, label) in enumerate(PHASES):
            draw_panel(axes[row][col], role_phase[(role, col)], f"{ROLE_KO[role]} · {label}", minimap)
    fig.suptitle("포지션별 위치 분포", fontsize=16, y=0.995)
    fig.text(0.5, 0.004, caption, ha="center", fontsize=9, color="#555")
    fig.tight_layout(rect=(0, 0.012, 1, 0.985))
    fig.savefig(out_dir / "role_phase_grid.png", dpi=110)
    plt.close(fig)

    # 2. jungle early minutes
    fig, axes = plt.subplots(2, 3, figsize=(3 * 3.2, 2 * 3.35))
    for number, minute in enumerate(range(1, 7)):
        draw_panel(axes[number // 3][number % 3], jungle_minute[minute], f"정글 · {minute}분", minimap, sigma=1.2)
    fig.suptitle("정글 초반 위치 (분 단위 스냅샷)", fontsize=15, y=0.995)
    fig.text(0.5, 0.004, caption, ha="center", fontsize=8, color="#555")
    fig.tight_layout(rect=(0, 0.015, 1, 0.98))
    fig.savefig(out_dir / "jungle_early.png", dpi=110)
    plt.close(fig)

    # 3. kill locations (real coordinates: dragon stays bottom, baron stays top)
    fig, axes = plt.subplots(2, 3, figsize=(3 * 3.2, 2 * 3.35))
    for col, (_, _, label) in enumerate(PHASES):
        draw_panel(axes[col // 3][col % 3], kills_phase[col], f"킬 위치 · {label}  (n={kills_phase[col].sum()})",
                   minimap, cmap_name="magma", sigma=2.0)
    fig.suptitle("킬이 난 위치 (실제 맵 좌표, 대칭 변환 없음)", fontsize=15, y=0.995)
    fig.text(0.5, 0.004, f"{args.label} · {stats['games']}경기 · CHAMPION_KILL 이벤트 좌표", ha="center",
             fontsize=8, color="#555")
    fig.tight_layout(rect=(0, 0.015, 1, 0.98))
    fig.savefig(out_dir / "kills_phase.png", dpi=110)
    plt.close(fig)

    # 4. alignment check: structure kill positions should sit on turrets/inhibitors
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.imshow(minimap, extent=EXTENT, origin="upper")
    if structures:
        xs, ys = zip(*structures)
        ax.scatter(xs, ys, s=10, c="#00ff88", edgecolors="black", linewidths=0.3)
    ax.set_title(f"정렬 확인: 포탑·억제기 파괴 좌표 {len(structures)}개")
    fig.tight_layout()
    fig.savefig(out_dir / "_alignment_check.png", dpi=110)
    plt.close(fig)

    export = {
        "source": f"{args.label}, Leaguepedia V5 timelines",
        "games": stats["games"],
        "view": "own side (blue); red side mirrored with (x, y) -> (c - y, c - x)",
        "mirror_c": round(mirror_c, 1),
        "bin_size": COARSE_BIN,
        "origin": [MAP_MIN_X, MAP_MIN_Y],
        "shape": list(engine["Top"][1].shape),
        "index_order": "counts[role][minute][ix][iy], ix along x, iy along y",
        "counts": {role: {str(minute): grid.tolist() for minute, grid in minutes.items()}
                   for role, minutes in engine.items()},
    }
    (export_dir / "role_minute_grid.json").write_text(json.dumps(export, separators=(",", ":")), encoding="utf-8")

    summary = {"mirror_c": round(mirror_c, 1), **stats}
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
