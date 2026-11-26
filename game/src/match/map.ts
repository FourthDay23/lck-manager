// Summoner's Rift geometry in Riot map units (x right, y up, blue base bottom-left).
// Structure positions are the medians of BUILDING_KILL events in the 2026 LCK timelines.
import type { HeatmapData, Role } from "../data/types";
import { ROLES } from "../data/types";

export const MAP = { minX: -120, minY: -120, maxX: 14870, maxY: 14980 };
export const MIRROR_C = 14764.1;
export type Vec = { x: number; y: number };
export const mirror = (p: Vec): Vec => ({ x: MIRROR_C - p.y, y: MIRROR_C - p.x });
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export type LaneId = "top" | "mid" | "bot";
export const LANES: LaneId[] = ["top", "mid", "bot"];
export const ROLE_LANE: Partial<Record<Role, LaneId>> = { Top: "top", Mid: "mid", Bot: "bot", Support: "bot" };

export const FOUNTAIN: [Vec, Vec] = [{ x: 560, y: 580 }, { x: 14200, y: 14220 }];
export const NEXUS: [Vec, Vec] = [{ x: 1551, y: 1659 }, { x: 13210, y: 13230 }];

export interface TurretDef { side: 0 | 1; lane: LaneId | "nexus"; tier: 1 | 2 | 3 | 4; pos: Vec }
export const TURRETS: TurretDef[] = [
  { side: 0, lane: "top", tier: 1, pos: { x: 981, y: 10441 } },
  { side: 0, lane: "top", tier: 2, pos: { x: 1512, y: 6699 } },
  { side: 0, lane: "top", tier: 3, pos: { x: 1169, y: 4287 } },
  { side: 0, lane: "mid", tier: 1, pos: { x: 5846, y: 6396 } },
  { side: 0, lane: "mid", tier: 2, pos: { x: 5048, y: 4812 } },
  { side: 0, lane: "mid", tier: 3, pos: { x: 3651, y: 3696 } },
  { side: 0, lane: "bot", tier: 1, pos: { x: 10504, y: 1029 } },
  { side: 0, lane: "bot", tier: 2, pos: { x: 6919, y: 1483 } },
  { side: 0, lane: "bot", tier: 3, pos: { x: 4281, y: 1253 } },
  { side: 0, lane: "nexus", tier: 4, pos: { x: 1748, y: 2270 } },
  { side: 0, lane: "nexus", tier: 4, pos: { x: 2177, y: 1807 } },
  { side: 1, lane: "top", tier: 1, pos: { x: 4318, y: 13875 } },
  { side: 1, lane: "top", tier: 2, pos: { x: 7943, y: 13411 } },
  { side: 1, lane: "top", tier: 3, pos: { x: 10481, y: 13650 } },
  { side: 1, lane: "mid", tier: 1, pos: { x: 8955, y: 8510 } },
  { side: 1, lane: "mid", tier: 2, pos: { x: 9767, y: 10113 } },
  { side: 1, lane: "mid", tier: 3, pos: { x: 11134, y: 11207 } },
  { side: 1, lane: "bot", tier: 1, pos: { x: 13866, y: 4505 } },
  { side: 1, lane: "bot", tier: 2, pos: { x: 13327, y: 8226 } },
  { side: 1, lane: "bot", tier: 3, pos: { x: 13624, y: 10572 } },
  { side: 1, lane: "nexus", tier: 4, pos: { x: 12611, y: 13084 } },
  { side: 1, lane: "nexus", tier: 4, pos: { x: 13052, y: 12612 } },
];
export const INHIBS: { side: 0 | 1; lane: LaneId; pos: Vec }[] = [
  { side: 0, lane: "top", pos: { x: 1172, y: 3583 } },
  { side: 0, lane: "mid", pos: { x: 3210, y: 3217 } },
  { side: 0, lane: "bot", pos: { x: 3468, y: 1230 } },
  { side: 1, lane: "top", pos: { x: 11275, y: 13657 } },
  { side: 1, lane: "mid", pos: { x: 11593, y: 11669 } },
  { side: 1, lane: "bot", pos: { x: 13599, y: 11319 } },
];

/** Lane polylines from the blue nexus to the red nexus. */
export const LANE_PATH: Record<LaneId, Vec[]> = {
  top: [NEXUS[0], { x: 1172, y: 3583 }, { x: 1169, y: 4287 }, { x: 1512, y: 6699 }, { x: 981, y: 10441 }, { x: 1700, y: 13150 },
    { x: 4318, y: 13875 }, { x: 7943, y: 13411 }, { x: 10481, y: 13650 }, { x: 11275, y: 13657 }, NEXUS[1]],
  mid: [NEXUS[0], { x: 3210, y: 3217 }, { x: 3651, y: 3696 }, { x: 5048, y: 4812 }, { x: 5846, y: 6396 }, { x: 7380, y: 7400 },
    { x: 8955, y: 8510 }, { x: 9767, y: 10113 }, { x: 11134, y: 11207 }, { x: 11593, y: 11669 }, NEXUS[1]],
  bot: [NEXUS[0], { x: 3468, y: 1230 }, { x: 4281, y: 1253 }, { x: 6919, y: 1483 }, { x: 10504, y: 1029 }, { x: 13100, y: 1700 },
    { x: 13866, y: 4505 }, { x: 13327, y: 8226 }, { x: 13624, y: 10572 }, { x: 13599, y: 11319 }, NEXUS[1]],
};

const laneLen: Record<string, number[]> = {};
function cumulative(lane: LaneId): number[] {
  if (laneLen[lane]) return laneLen[lane];
  const pts = LANE_PATH[lane];
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + dist(pts[i - 1], pts[i]));
  laneLen[lane] = acc;
  return acc;
}
/** Point at fraction u (0 = blue nexus, 1 = red nexus) along a lane. */
export function lanePoint(lane: LaneId, u: number): Vec {
  const acc = cumulative(lane);
  const total = acc[acc.length - 1];
  const d = Math.max(0, Math.min(1, u)) * total;
  const pts = LANE_PATH[lane];
  for (let i = 1; i < pts.length; i++) {
    if (acc[i] >= d) {
      const t = (d - acc[i - 1]) / Math.max(1, acc[i] - acc[i - 1]);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
  }
  return pts[pts.length - 1];
}
export function laneU(lane: LaneId, p: Vec): number {
  const acc = cumulative(lane);
  const pts = LANE_PATH[lane];
  let best = 0, bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = (acc[i - 1] + Math.sqrt(L2) * t) / acc[acc.length - 1];
    }
  }
  return best;
}

export type CampKind = "blue" | "gromp" | "wolves" | "raptors" | "red" | "krugs";
export const CAMPS_BLUE: { kind: CampKind; pos: Vec }[] = [
  { kind: "blue", pos: { x: 3800, y: 7950 } },
  { kind: "gromp", pos: { x: 2090, y: 8430 } },
  { kind: "wolves", pos: { x: 3780, y: 6470 } },
  { kind: "raptors", pos: { x: 6950, y: 5450 } },
  { kind: "red", pos: { x: 7770, y: 4040 } },
  { kind: "krugs", pos: { x: 8400, y: 2650 } },
];
/** Red camps whose mirrored blue position falls on a minimap wall: nearest points with open ground around them. */
export const CAMP_POS_RED: Partial<Record<CampKind, Vec>> = { wolves: { x: 7931, y: 10940 }, red: { x: 10918, y: 6870 }, krugs: { x: 12030, y: 6634 } };
export const SCUTTLE: Vec[] = [{ x: 4400, y: 9600 }, { x: 10400, y: 5200 }];
export const DRAGON_PIT: Vec = { x: 9866, y: 4414 };
export const BARON_PIT: Vec = { x: 5007, y: 10471 };
export const CAMP_KO: Record<CampKind | "scuttle", string> = {
  blue: "블루", gromp: "두꺼비", wolves: "늑대", raptors: "칼날부리", red: "레드", krugs: "돌거북", scuttle: "바위게",
};

// ---------- walkability from where pro players actually stood ----------
export const CELL = 500;
export const GW = 30;
export const GH = 31;
let walkCost: Float32Array | null = null;
let heat: HeatmapData | null = null;

export function cellOf(p: Vec): [number, number] {
  return [Math.max(0, Math.min(GW - 1, Math.floor((p.x - MAP.minX) / CELL))), Math.max(0, Math.min(GH - 1, Math.floor((p.y - MAP.minY) / CELL)))];
}
export function cellCenter(ix: number, iy: number): Vec {
  return { x: MAP.minX + (ix + 0.5) * CELL, y: MAP.minY + (iy + 0.5) * CELL };
}

export function initMap(h: HeatmapData | null) {
  heat = h;
  const total = new Float32Array(GW * GH);
  if (h) {
    for (const r of ROLES) {
      const byMin = h.counts[r];
      for (const m of Object.keys(byMin)) {
        const grid = byMin[m];
        for (let ix = 0; ix < GW; ix++) for (let iy = 0; iy < GH; iy++) {
          const v = grid[ix]?.[iy] ?? 0;
          if (!v) continue;
          total[iy * GW + ix] += v;
          const mp = mirror(cellCenter(ix, iy));
          const [jx, jy] = cellOf(mp);
          total[jy * GW + jx] += v;
        }
      }
    }
  } else {
    total.fill(1);
  }
  // lanes and structures are always walkable
  for (const lane of LANES) for (let u = 0; u <= 1; u += 0.01) {
    const [ix, iy] = cellOf(lanePoint(lane, u));
    total[iy * GW + ix] += 50;
  }
  walkCost = new Float32Array(GW * GH);
  for (let i = 0; i < total.length; i++) walkCost[i] = total[i] > 3 ? 1 + 5 / (1 + Math.log1p(total[i])) : Infinity;
}

function walkable(ix: number, iy: number) {
  return ix >= 0 && iy >= 0 && ix < GW && iy < GH && Number.isFinite(walkCost![iy * GW + ix]);
}

function nearestWalkable(ix: number, iy: number): [number, number] {
  if (walkable(ix, iy)) return [ix, iy];
  for (let r = 1; r < 6; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    if (walkable(ix + dx, iy + dy)) return [ix + dx, iy + dy];
  }
  return [ix, iy];
}

function lineClear(a: [number, number], b: [number, number]): boolean {
  const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t);
    if (!walkable(x, y)) return false;
  }
  return true;
}

const pathCache = new Map<number, Vec[]>();

/** A* over the traffic grid, string-pulled. Returns waypoints ending at `to`. */
export function findPath(from: Vec, to: Vec): Vec[] {
  if (!walkCost) return [to];
  const s = nearestWalkable(...cellOf(from));
  const g = nearestWalkable(...cellOf(to));
  const key = ((s[1] * GW + s[0]) << 12) | (g[1] * GW + g[0]);
  const cached = pathCache.get(key);
  if (cached) return [...cached, to];
  const N = GW * GH;
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const open: number[] = [];
  const si = s[1] * GW + s[0], gi = g[1] * GW + g[0];
  gScore[si] = 0;
  open.push(si);
  const fScore = new Float32Array(N).fill(Infinity);
  fScore[si] = 0;
  const closed = new Uint8Array(N);
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[bi]]) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur === gi) break;
    closed[cur] = 1;
    const cx = cur % GW, cy = Math.floor(cur / GW);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny)) continue;
      const ni = ny * GW + nx;
      if (closed[ni]) continue;
      const step = (dx && dy ? 1.414 : 1) * walkCost![ni];
      const t = gScore[cur] + step;
      if (t < gScore[ni]) {
        gScore[ni] = t;
        came[ni] = cur;
        fScore[ni] = t + Math.hypot(nx - g[0], ny - g[1]) * 1.2;
        if (!open.includes(ni)) open.push(ni);
      }
    }
  }
  const cells: [number, number][] = [];
  let c = gi;
  if (came[c] === -1 && c !== si) {
    pathCache.set(key, []);
    return [to];
  }
  while (c !== -1) {
    cells.unshift([c % GW, Math.floor(c / GW)]);
    if (c === si) break;
    c = came[c];
  }
  // string pull
  const pulled: [number, number][] = [];
  let anchor = 0;
  for (let i = 2; i < cells.length; i++) {
    if (!lineClear(cells[anchor], cells[i])) {
      pulled.push(cells[i - 1]);
      anchor = i - 1;
    }
  }
  const pts = pulled.map(([x, y]) => cellCenter(x, y));
  pathCache.set(key, pts);
  return [...pts, to];
}

/** Sample where a role tends to stand at a given minute (own-side view), for side 0 or mirrored for side 1. */
export function sampleHeat(role: Role, minute: number, side: 0 | 1, rnd: () => number): Vec | null {
  if (!heat) return null;
  const m = String(Math.max(1, Math.min(45, Math.round(minute))));
  const grid = heat.counts[role]?.[m];
  if (!grid) return null;
  let total = 0;
  for (const col of grid) for (const v of col) total += v;
  if (!total) return null;
  let r = rnd() * total;
  for (let ix = 0; ix < grid.length; ix++) for (let iy = 0; iy < grid[ix].length; iy++) {
    r -= grid[ix][iy];
    if (r <= 0) {
      const p = { x: MAP.minX + (ix + rnd()) * CELL, y: MAP.minY + (iy + rnd()) * CELL };
      return side === 0 ? p : mirror(p);
    }
  }
  return null;
}
