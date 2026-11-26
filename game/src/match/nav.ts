// Walls and paths on Summoner's Rift (owner: nav agent).
// Contract used by engine.ts / fight.ts / macro.ts (do not change signatures without telling the integrator):
//   findPath(from, to)            waypoints (world units) ending at `to` (or the nearest walkable point to it)
//   advance(u, budget)            move u along u.path by `budget` world units, sliding along walls, never ending in a wall
//   blinkLanding(from, to, max, hop) where a dash/flash from `from` toward `to` (at most `max` long) lands
//   walkable(p), lineOfSight(a, b), nearestWalkable(p)
//   separate(units, dt)           push overlapping live champions apart a little (called once per engine step)
//
// Grid: navmask.gen.ts (built by scripts/build_navmask.py from public/assets/map11.png), 256x256 cells of ~58.6 x
// 59.0 units. A cell is walkable only if all its minimap pixels are, so a unit inside a walkable cell never stands on
// a wall pixel. Cell (gx, gy): gx = floor(u * N), gy = floor(v * N) with u = (x - minX) / W, v = 1 - (y - minY) / H
// (row 0 = top of the minimap) — the same formula render.ts and engine-diag use, so 256 and 512 cells nest exactly.
// Paths: line of sight -> straight; otherwise A* (binary heap, 8 neighbours, no corner cutting, mild traffic cost
// from the pro heatmap) + string pulling; routes between ~234u blocks are cached (deterministically) and re-validated
// with line of sight at both ends.
import type { Vec } from "./map";
import { MAP } from "./map";
import { NAV_BITS, NAV_N, TRAFFIC_CELL, TRAFFIC_EXTRA, TRAFFIC_H, TRAFFIC_K, TRAFFIC_ORIGIN, TRAFFIC_W } from "./navmask.gen";

const N = NAV_N;
const NN = N * N;
const MW = MAP.maxX - MAP.minX;
const MH = MAP.maxY - MAP.minY;
/** world size of one cell */
const CW = MW / N;
const CH = MH / N;
const CELL = Math.min(CW, CH);
const SQ2 = Math.SQRT2;

// ---------- data ----------
function b64(s: string): Uint8Array {
  const tbl = new Int16Array(128).fill(-1);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < abc.length; i++) tbl[abc.charCodeAt(i)] = i;
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "="; i--) n++;
  const out = new Uint8Array(((s.length * 3) >> 2) - n);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = tbl[s.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < out.length) out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

/** 1 = walkable */
const walk = new Uint8Array(NN);
/** step cost multiplier of entering a cell (>= 1) */
const cost = new Float32Array(NN);
let minCost = 1;
(function init() {
  const bits = b64(NAV_BITS);
  for (let i = 0; i < NN; i++) walk[i] = (bits[i >> 3] >> (i & 7)) & 1;
  // the outer ring is outside the map anyway; keeping it wall lets A* skip bounds checks
  for (let k = 0; k < N; k++) walk[k] = walk[(N - 1) * N + k] = walk[k * N] = walk[k * N + N - 1] = 0;
  const extra = b64(TRAFFIC_EXTRA);
  const tAt = (ix: number, iy: number) => {
    ix = ix < 0 ? 0 : ix >= TRAFFIC_W ? TRAFFIC_W - 1 : ix;
    iy = iy < 0 ? 0 : iy >= TRAFFIC_H ? TRAFFIC_H - 1 : iy;
    return extra[iy * TRAFFIC_W + ix];
  };
  minCost = Infinity;
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    const i = gy * N + gx;
    if (!walk[i]) { cost[i] = Infinity; continue; }
    // bilinear sample of the 500u traffic grid at the cell centre
    const x = MAP.minX + (gx + 0.5) * CW, y = MAP.maxY - (gy + 0.5) * CH;
    const fx = (x - TRAFFIC_ORIGIN.x) / TRAFFIC_CELL - 0.5, fy = (y - TRAFFIC_ORIGIN.y) / TRAFFIC_CELL - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const e = (tAt(ix, iy) * (1 - tx) + tAt(ix + 1, iy) * tx) * (1 - ty) + (tAt(ix, iy + 1) * (1 - tx) + tAt(ix + 1, iy + 1) * tx) * ty;
    cost[i] = 1 + (e / 255) * TRAFFIC_K;
    if (cost[i] < minCost) minCost = cost[i];
  }
})();

// ---------- cells ----------
const gxOf = (x: number) => Math.floor(((x - MAP.minX) / MW) * N);
const gyOf = (y: number) => Math.floor((1 - (y - MAP.minY) / MH) * N);
function cellIdx(x: number, y: number): number {
  const gx = gxOf(x), gy = gyOf(y);
  return gx < 0 || gy < 0 || gx >= N || gy >= N ? -1 : gy * N + gx;
}
const centerX = (gx: number) => MAP.minX + ((gx + 0.5) / N) * MW;
const centerY = (gy: number) => MAP.minY + (1 - (gy + 0.5) / N) * MH;
const okCell = (gx: number, gy: number) => gx >= 0 && gy >= 0 && gx < N && gy < N && walk[gy * N + gx] === 1;

export function walkable(p: Vec): boolean {
  const i = cellIdx(p.x, p.y);
  return i >= 0 && walk[i] === 1;
}

// ---------- rays ----------
/**
 * Walk the grid cells a segment touches (Amanatides & Woo; through an exact corner both side cells must be open).
 * Returns the fraction of the segment that stays on walkable cells: 1 = clear, 0 = starts blocked.
 */
function rayFrac(ax: number, ay: number, bx: number, by: number): number {
  // grid space (cells, y down)
  const u0 = ((ax - MAP.minX) / MW) * N, v0 = (1 - (ay - MAP.minY) / MH) * N;
  const u1 = ((bx - MAP.minX) / MW) * N, v1 = (1 - (by - MAP.minY) / MH) * N;
  let gx = Math.floor(u0), gy = Math.floor(v0);
  const ex = Math.floor(u1), ey = Math.floor(v1);
  if (!okCell(gx, gy)) return 0;
  if (gx === ex && gy === ey) return 1;
  const du = u1 - u0, dv = v1 - v0;
  const sx = du > 0 ? 1 : du < 0 ? -1 : 0, sy = dv > 0 ? 1 : dv < 0 ? -1 : 0;
  const tdx = sx ? 1 / Math.abs(du) : Infinity, tdy = sy ? 1 / Math.abs(dv) : Infinity;
  let tmx = sx > 0 ? (gx + 1 - u0) / du : sx < 0 ? (u0 - gx) / -du : Infinity;
  let tmy = sy > 0 ? (gy + 1 - v0) / dv : sy < 0 ? (v0 - gy) / -dv : Infinity;
  let n = Math.abs(ex - gx) + Math.abs(ey - gy);
  while (n > 0) {
    if (tmx < tmy) {
      gx += sx;
      if (!okCell(gx, gy)) return Math.min(1, tmx);
      tmx += tdx;
      n--;
    } else if (tmy < tmx) {
      gy += sy;
      if (!okCell(gx, gy)) return Math.min(1, tmy);
      tmy += tdy;
      n--;
    } else {
      // exactly through a corner: both side cells must be open
      if (!okCell(gx + sx, gy) || !okCell(gx, gy + sy)) return Math.min(1, tmx);
      gx += sx;
      gy += sy;
      if (!okCell(gx, gy)) return Math.min(1, tmx);
      tmx += tdx;
      tmy += tdy;
      n -= 2;
    }
  }
  return 1;
}

/** True when the straight segment a→b only crosses walkable cells. */
export function lineOfSight(a: Vec, b: Vec): boolean {
  return rayFrac(a.x, a.y, b.x, b.y) >= 1;
}

/** Closest walkable point to p (p itself when walkable). Ring search over cells, exact distance to cell rectangles. */
export function nearestWalkable(p: Vec): Vec {
  if (walkable(p)) return { x: p.x, y: p.y };
  let gx = gxOf(p.x), gy = gyOf(p.y);
  gx = gx < 0 ? 0 : gx >= N ? N - 1 : gx;
  gy = gy < 0 ? 0 : gy >= N ? N - 1 : gy;
  let best = -1, bestD = Infinity, bx = 0, by = 0;
  for (let r = 0; r < N; r++) {
    if (best >= 0 && (r - 1) * CELL > bestD) break;
    for (let yy = gy - r; yy <= gy + r; yy++) {
      if (yy < 0 || yy >= N) continue;
      const edge = yy === gy - r || yy === gy + r;
      for (let xx = gx - r; xx <= gx + r; xx += edge ? 1 : 2 * r || 1) {
        if (xx < 0 || xx >= N || !walk[yy * N + xx]) continue;
        // closest point of the cell rectangle, pulled 1.5u inside
        const x0 = MAP.minX + (xx / N) * MW, x1 = MAP.minX + ((xx + 1) / N) * MW;
        const y1 = MAP.minY + (1 - yy / N) * MH, y0 = MAP.minY + (1 - (yy + 1) / N) * MH;
        const qx = Math.min(x1 - 1.5, Math.max(x0 + 1.5, p.x)), qy = Math.min(y1 - 1.5, Math.max(y0 + 1.5, p.y));
        const d = Math.hypot(qx - p.x, qy - p.y);
        if (d < bestD) { bestD = d; best = yy * N + xx; bx = qx; by = qy; }
      }
    }
  }
  if (best < 0) return { x: p.x, y: p.y };
  const q = { x: bx, y: by };
  if (walkable(q)) return q;
  return { x: centerX(best % N), y: centerY((best / N) | 0) };
}

// ---------- A* ----------
const gScore = new Float64Array(NN);
const parent = new Int32Array(NN);
const seenStamp = new Uint32Array(NN);
const closedStamp = new Uint32Array(NN);
let stamp = 0;
let heapF = new Float64Array(1 << 14);
let heapI = new Int32Array(1 << 14);
let heapN = 0;
function heapPush(f: number, i: number) {
  if (heapN === heapF.length) {
    const nf = new Float64Array(heapN * 2); nf.set(heapF); heapF = nf;
    const ni = new Int32Array(heapN * 2); ni.set(heapI); heapI = ni;
  }
  let k = heapN++;
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (heapF[p] <= f) break;
    heapF[k] = heapF[p];
    heapI[k] = heapI[p];
    k = p;
  }
  heapF[k] = f;
  heapI[k] = i;
}
function heapPop(): number {
  const top = heapI[0];
  const f = heapF[--heapN], i = heapI[heapN];
  let k = 0;
  for (;;) {
    let c = 2 * k + 1;
    if (c >= heapN) break;
    if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
    if (heapF[c] >= f) break;
    heapF[k] = heapF[c];
    heapI[k] = heapI[c];
    k = c;
  }
  heapF[k] = f;
  heapI[k] = i;
  return top;
}
// neighbour offsets: 4 straight, then 4 diagonal (each with its two straight components for the corner check)
const OFF = [1, -1, N, -N, N + 1, N - 1, -N + 1, -N - 1];
const OFFA = [0, 0, 0, 0, 1, -1, 1, -1];
const OFFB = [0, 0, 0, 0, N, N, -N, -N];
/** weighted A*: ~5x fewer expansions than plain A*, paths ~1% longer (string pulling straightens them) */
const H_WEIGHT = 1.3;

/** A* from cell si to cell gi (both walkable); returns the cell list (si..gi) or null. */
function astar(si: number, gi: number): number[] | null {
  if (++stamp === 0xffffffff) { seenStamp.fill(0); closedStamp.fill(0); stamp = 1; }
  const gx = gi % N, gy = (gi / N) | 0;
  const hw = minCost * H_WEIGHT, hd = (SQ2 - 1) * hw;
  heapN = 0;
  gScore[si] = 0;
  parent[si] = -1;
  seenStamp[si] = stamp;
  heapPush(0, si);
  let found = false;
  let expanded = 0;
  // the border ring of the grid is always wall (see init), so neighbours of a walkable cell are always in range
  while (heapN > 0) {
    const cur = heapPop();
    if (closedStamp[cur] === stamp) continue;
    closedStamp[cur] = stamp;
    expanded++;
    if (cur === gi) { found = true; break; }
    const g0 = gScore[cur];
    for (let k = 0; k < 8; k++) {
      const j = cur + OFF[k];
      if (walk[j] === 0 || closedStamp[j] === stamp) continue;
      let ng: number;
      if (k < 4) ng = g0 + cost[j];
      else {
        if (walk[cur + OFFA[k]] === 0 || walk[cur + OFFB[k]] === 0) continue; // no corner cutting
        ng = g0 + cost[j] * SQ2;
      }
      if (seenStamp[j] !== stamp || ng < gScore[j]) {
        seenStamp[j] = stamp;
        gScore[j] = ng;
        parent[j] = cur;
        let ax = (j % N) - gx, ay = ((j / N) | 0) - gy;
        if (ax < 0) ax = -ax;
        if (ay < 0) ay = -ay;
        heapPush(ng + (ax > ay ? ax * hw + ay * hd : ay * hw + ax * hd), j);
      }
    }
  }
  navStats.expanded += expanded;
  if (!found) return null;
  const cells: number[] = [];
  for (let c = gi; c !== -1; c = parent[c]) cells.push(c);
  cells.reverse();
  return cells;
}

// ---------- paths ----------
// Route cache: the map is cut into blocks of BLK x BLK cells (~234 units). For a (start block, goal block) pair we
// keep the string-pulled route between the two blocks' representative cells. The entry depends only on the key, never
// on which query filled it, so findPath(from, to) is a pure function of its inputs: games stay reproducible per seed
// whatever ran before (other games, the UI, tests). A query uses the entry when both ends see its first/last waypoint.
const BLK = 4;
const NB = N / BLK;
const cache = new Map<number, Vec[] | null>();
const CACHE_CAP = 60000;
/** per block: the walkable cell nearest the block centre, or -1 */
const blockRep = new Int32Array(NB * NB).fill(-1);
for (let by = 0; by < NB; by++) for (let bx = 0; bx < NB; bx++) {
  let best = -1, bd = Infinity;
  for (let y = by * BLK; y < (by + 1) * BLK; y++) for (let x = bx * BLK; x < (bx + 1) * BLK; x++) {
    if (!walk[y * N + x]) continue;
    const d = Math.abs(x + 0.5 - (bx + 0.5) * BLK) + Math.abs(y + 0.5 - (by + 0.5) * BLK);
    if (d < bd) { bd = d; best = y * N + x; }
  }
  blockRep[by * NB + bx] = best;
}
export const navStats = { findPath: 0, los: 0, reuse: 0, astar: 0, cacheHit: 0, cacheMiss: 0, expanded: 0 };
/** test hook: called after every A* search (scripts/nav-test.ts uses it to find the callers) */
export const navDebug: { onAstar: ((from: Vec, to: Vec, cells: number) => void) | null } = { onAstar: null };

const blockOf = (ci: number) => (((ci / N) | 0) / BLK | 0) * NB + ((ci % N) / BLK | 0);
const cellPt = (ci: number): Vec => ({ x: centerX(ci % N), y: centerY((ci / N) | 0) });

/** A* between two walkable cells, string-pulled between the exact points s and g: interior waypoints, or null. */
function route(s: Vec, si: number, g: Vec, gi: number): Vec[] | null {
  const cells = astar(si, gi);
  if (!cells) return null;
  navStats.astar++;
  if (navDebug.onAstar) navDebug.onAstar(s, g, cells.length);
  const pts: Vec[] = [s];
  for (let k = 1; k < cells.length - 1; k++) pts.push(cellPt(cells[k]));
  pts.push(g);
  const mid: Vec[] = [];
  let anchor = 0;
  for (let k = 2; k < pts.length; k++) {
    if (!lineOfSight(pts[anchor], pts[k])) {
      mid.push(pts[k - 1]);
      anchor = k - 1;
    }
  }
  // round the corners: a string-pulled corner sits on the cell next to the wall; move it out a little
  for (let k = 0; k < mid.length; k++) mid[k] = easeCorner(k ? mid[k - 1] : s, mid[k], k + 1 < mid.length ? mid[k + 1] : g);
  return mid;
}

/** Push a path corner up to ~50u away from the nearby wall cells, keeping both legs in line of sight. */
function easeCorner(prev: Vec, w: Vec, next: Vec): Vec {
  const gx = gxOf(w.x), gy = gyOf(w.y);
  let rx = 0, ry = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if ((dx || dy) && !okCell(gx + dx, gy + dy)) {
      const d2 = dx * dx + dy * dy;
      rx -= dx / d2;
      ry += dy / d2; // grid rows grow downward, world y upward
    }
  }
  const L = Math.hypot(rx, ry);
  if (L < 1e-6) return w;
  for (const k of [50, 34, 18]) {
    const q = { x: w.x + (rx / L) * k, y: w.y + (ry / L) * k };
    if (walkable(q) && lineOfSight(prev, q) && lineOfSight(q, next)) return q;
  }
  return w;
}

/** Cached route between the representative cells of two blocks (null when a block has no walkable cell). */
function blockRoute(sb: number, gb: number): Vec[] | null {
  const key = sb * NB * NB + gb;
  const hit = cache.get(key);
  if (hit !== undefined) {
    navStats.cacheHit++;
    return hit;
  }
  navStats.cacheMiss++;
  const rs = blockRep[sb], rg = blockRep[gb];
  const mid = rs < 0 || rg < 0 ? null : route(cellPt(rs), rs, cellPt(rg), rg);
  if (cache.size >= CACHE_CAP) cache.clear();
  cache.set(key, mid);
  return mid;
}

/** Drop waypoints at both ends that line of sight makes unnecessary. */
function tighten(s: Vec, mid: Vec[], g: Vec): Vec[] {
  let a = 0, b = mid.length;
  while (b - a >= 2 && lineOfSight(s, mid[a + 1])) a++;
  while (b - a >= 2 && lineOfSight(mid[b - 2], g)) b--;
  if (b - a === 1 && lineOfSight(s, g)) return [];
  return mid.slice(a, b);
}

/**
 * Waypoints from `from` to `to` (both snapped to walkable ground), ending at the walkable goal. Every leg, including
 * from→first waypoint, has line of sight. If `from` is inside a wall the first waypoint is where it pops out.
 */
export function findPath(from: Vec, to: Vec): Vec[] {
  navStats.findPath++;
  const g = walkable(to) ? { x: to.x, y: to.y } : nearestWalkable(to);
  const fromOk = walkable(from);
  const s = fromOk ? from : nearestWalkable(from);
  const head: Vec[] = fromOk ? [] : [s];
  if (lineOfSight(s, g)) {
    navStats.los++;
    head.push(g);
    return head;
  }
  // a unit re-aiming at a goal near its current one (lane jitter, a moving target): keep its route, change the end
  const old = (from as { path?: Vec[] }).path;
  if (old && old.length >= 2) {
    const end = old[old.length - 1], prev = old[old.length - 2];
    if (Math.abs(end.x - g.x) + Math.abs(end.y - g.y) < 900 && lineOfSight(s, old[0]) && lineOfSight(prev, g)) {
      navStats.reuse++;
      for (const p of tighten(s, old.slice(0, -1), g)) head.push({ x: p.x, y: p.y });
      head.push(g);
      return head;
    }
  }
  const si = cellIdx(s.x, s.y), gi = cellIdx(g.x, g.y);
  const sb = blockOf(si), gb = blockOf(gi);
  const br = blockRoute(sb, gb);
  let mid: Vec[] | null = null;
  if (br) {
    // join the block route directly, or through the block's representative cell (at most ~170u aside)
    const rs = cellPt(blockRep[sb]), rg = cellPt(blockRep[gb]);
    const first = br.length ? br[0] : rg, last = br.length ? br[br.length - 1] : rs;
    const a = br.length && lineOfSight(s, first) ? 0 : lineOfSight(s, rs) ? 1 : -1;
    const b = br.length && lineOfSight(last, g) ? 0 : lineOfSight(rg, g) ? 1 : -1;
    if (a >= 0 && b >= 0) {
      const joined = a ? [rs, ...br] : br.slice();
      if (b) joined.push(rg);
      mid = tighten(s, joined, g);
    }
  }
  if (!mid) mid = route(s, si, g, gi); // a wall splits the start or goal block: exact search
  if (mid) for (const p of mid) head.push({ x: p.x, y: p.y });
  head.push(g);
  return head;
}

/** Walking distance along findPath (handy for "who gets there first"). */
export function pathLength(from: Vec, to: Vec): number {
  const p = findPath(from, to);
  let d = 0, x = from.x, y = from.y;
  for (const q of p) { d += Math.hypot(q.x - x, q.y - y); x = q.x; y = q.y; }
  return d;
}

// ---------- movement ----------
/** the waypoint object whose full leg was last checked for line of sight, per unit */
const legChecked = new WeakMap<object, Vec>();

function popOut(u: { x: number; y: number }) {
  const p = nearestWalkable(u);
  u.x = p.x;
  u.y = p.y;
}

/** Move u by (mx, my); if the straight move hits a wall, slide along it on the free axis. */
function slide(u: { x: number; y: number }, mx: number, my: number): boolean {
  if (rayFrac(u.x, u.y, u.x + mx, u.y + my) >= 1) {
    u.x += mx;
    u.y += my;
    return true;
  }
  const ax = Math.abs(mx) >= Math.abs(my);
  for (const [px, py] of ax ? [[mx, 0], [0, my]] : [[0, my], [mx, 0]]) {
    if (Math.abs(px) + Math.abs(py) < 0.5) continue;
    const nx = u.x + px, ny = u.y + py;
    if (rayFrac(u.x, u.y, nx, ny) >= 1) {
      u.x = nx;
      u.y = ny;
      return true;
    }
  }
  return false;
}

/**
 * Move u along u.path by `budget` world units. Legs without line of sight (paths the engine set by hand, or a unit
 * pushed off its line) are re-planned once per call; otherwise the unit slides along the wall. Never ends in a wall.
 */
export function advance(u: { x: number; y: number; path: Vec[] }, budget: number): void {
  if (!walkable(u)) popOut(u);
  let replanned = false;
  let guard = 0;
  while (budget > 1e-6 && u.path.length && guard++ < 24) {
    let wp = u.path[0];
    if (!walkable(wp)) {
      wp = nearestWalkable(wp);
      u.path[0] = wp;
    }
    const dx = wp.x - u.x, dy = wp.y - u.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) {
      u.path.shift();
      continue;
    }
    if (legChecked.get(u) !== wp) {
      if (!replanned && !lineOfSight(u, wp)) {
        replanned = true;
        u.path = findPath(u, u.path[u.path.length - 1]);
        continue;
      }
      legChecked.set(u, wp);
    }
    const step = d < budget ? d : budget;
    const nx = step === d ? wp.x : u.x + (dx / d) * step;
    const ny = step === d ? wp.y : u.y + (dy / d) * step;
    if (rayFrac(u.x, u.y, nx, ny) >= 1) {
      u.x = nx;
      u.y = ny;
      budget -= step;
      if (step === d) u.path.shift();
      continue;
    }
    if (!replanned) {
      replanned = true;
      u.path = findPath(u, u.path[u.path.length - 1]);
      continue;
    }
    slide(u, (dx / d) * step, (dy / d) * step);
    break;
  }
}

/**
 * Landing point of a dash / flash from `from` toward `to`, at most `maxLen` long. Without `canHopWalls` the dash stops
 * just before the first wall; with it (flash, blinks) it lands on the target if that is walkable, else on the farthest
 * walkable point of the ray (so it still crosses a thin wall when there is ground behind it). Never inside a wall.
 */
export function blinkLanding(from: Vec, to: Vec, maxLen: number, canHopWalls: boolean): Vec {
  const f = walkable(from) ? { x: from.x, y: from.y } : nearestWalkable(from);
  let dx = to.x - f.x, dy = to.y - f.y;
  const d = Math.hypot(dx, dy);
  const len = Math.min(d, Math.max(0, maxLen));
  if (len < 1e-6) return f;
  dx /= d;
  dy /= d;
  const tx = f.x + dx * len, ty = f.y + dy * len;
  if (canHopWalls) {
    const t = { x: tx, y: ty };
    if (walkable(t)) return t;
    for (let s = len - CELL * 0.25; s > 0; s -= CELL * 0.25) {
      const p = { x: f.x + dx * s, y: f.y + dy * s };
      if (walkable(p)) return p;
    }
    return f;
  }
  const fr = rayFrac(f.x, f.y, tx, ty);
  if (fr >= 1) return { x: tx, y: ty };
  // back off from the wall a little; the point must be walkable and reachable on the ray
  for (let s = fr * len - 2; s > 0; s -= CELL * 0.25) {
    const p = { x: f.x + dx * s, y: f.y + dy * s };
    if (walkable(p) && rayFrac(f.x, f.y, p.x, p.y) >= 1) return p;
  }
  return f;
}

/**
 * Gentle repulsion between live champions closer than SEP units (never into walls). Also the per-step safety net:
 * a live champion left inside a wall by anything (spawn jitter, a teleport, a knockback) is popped out.
 */
const SEP = 70;
export function separate(units: { x: number; y: number; alive: boolean; side: 0 | 1 }[], dt: number): void {
  const rate = Math.min(1, 2 * dt); // close half the overlap per 0.25 s step
  for (const u of units) if (u.alive && !walkable(u)) popOut(u);
  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      if (!b.alive) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= SEP * SEP) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-3) {
        // exactly stacked: split along a fixed per-pair direction (deterministic, no RNG)
        const ang = (i * 7 + j * 13) * 0.7;
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        d = 1;
      }
      const push = Math.min(((SEP - Math.sqrt(d2)) / 2) * rate, 30);
      const px = (dx / d) * push, py = (dy / d) * push;
      slide(b, px, py);
      slide(a, -px, -py);
    }
  }
}
