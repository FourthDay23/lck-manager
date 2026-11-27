// Nav self-test: reachability of every camp / structure, path validity, blink rules, A* speed.
// Run (Git Bash): MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/nav-test.ts
// Optional: PATHS_OUT=file.json dumps sample routes (world coords) for a visual check.
import { readFileSync, writeFileSync } from "node:fs";
import * as Nav from "../src/match/nav";
import { BARON_PIT, CAMPS, DRAGON_PIT, FOUNTAIN, GRUBS_PIT, GRUB_SPOTS, HERALD_PIT, INHIBS, LANES, MAP, NEXUS, SCUTTLE, TURRETS, lanePoint } from "../src/match/map";
import type { Vec } from "../src/match/map";

const mask = JSON.parse(readFileSync("scripts/wallmask.json", "utf8"));
const W = MAP.maxX - MAP.minX, H = MAP.maxY - MAP.minY;
const isWall = (x: number, y: number) => {
  const px = Math.floor(((x - MAP.minX) / W) * mask.w), py = Math.floor((1 - (y - MAP.minY) / H) * mask.h);
  if (px < 0 || py < 0 || px >= mask.w || py >= mask.h) return true;
  return mask.rows[py][px] === "1";
};
const segWall = (a: Vec, b: Vec) => {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / 8));
  for (let i = 0; i <= n; i++) if (isWall(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) return true;
  return false;
};
let fails = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) { fails++; console.log("FAIL", msg); }
};
const fmt = (p: Vec) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`;

// --- key points
const pts: [string, Vec][] = [];
FOUNTAIN.forEach((p, i) => pts.push([`fountain${i}`, p]));
NEXUS.forEach((p, i) => pts.push([`nexus${i}`, p]));
TURRETS.forEach((t) => pts.push([`turret ${t.side} ${t.lane} ${t.tier}`, t.pos]));
INHIBS.forEach((t) => pts.push([`inhib ${t.side} ${t.lane}`, t.pos]));
CAMPS.forEach((list, side) => list.forEach((c) => pts.push([`${side ? "red" : "blue"} ${c.kind}`, c.pos])));
SCUTTLE.forEach((p, i) => pts.push([`scuttle${i}`, p]));
pts.push(["dragon", DRAGON_PIT], ["baron", BARON_PIT], ["herald", HERALD_PIT], ["grubs", GRUBS_PIT]);
GRUB_SPOTS.forEach((p, i) => pts.push([`grub${i}`, p]));
for (const lane of LANES) for (let u = 0; u <= 1.0001; u += 0.05) pts.push([`${lane} ${u.toFixed(2)}`, lanePoint(lane, u)]);

let maxSnap = 0;
const t0 = performance.now();
const routes: Vec[][] = [];
for (const [name, p] of pts) {
  const q = Nav.nearestWalkable(p);
  const snap = Math.hypot(q.x - p.x, q.y - p.y);
  if (snap > 0) console.log(`  snapped ${name} ${fmt(p)} -> ${fmt(q)} (${snap.toFixed(0)}u)`);
  maxSnap = Math.max(maxSnap, snap);
  check(Nav.walkable(q) && !isWall(q.x, q.y), `${name} snap not walkable`);
  for (const side of [0, 1]) {
    const f = FOUNTAIN[side];
    const path = Nav.findPath(f, p);
    const end = path[path.length - 1];
    check(Math.hypot(end.x - q.x, end.y - q.y) < 1, `${name} path end ${fmt(end)} != ${fmt(q)}`);
    let prev = f;
    for (const w of path) {
      check(Nav.walkable(w), `${name} waypoint in wall ${fmt(w)}`);
      check(Nav.lineOfSight(prev, w), `${name} leg without LOS ${fmt(prev)}->${fmt(w)}`);
      check(!segWall(prev, w), `${name} leg crosses wall pixels ${fmt(prev)}->${fmt(w)}`);
      prev = w;
    }
    if (side === 0 && /blue|red |scuttle|dragon|baron/.test(name)) routes.push([f, ...path]);
  }
}
console.log(`key points: ${pts.length}, max snap ${maxSnap.toFixed(0)}u, paths from both fountains ok (${(performance.now() - t0).toFixed(0)} ms)`);

// --- jungle clear routes (blue side full clear, red side full clear)
for (const side of [0, 1] as const) {
  const camps = CAMPS[side].map((c) => c.pos);
  let at: Vec = FOUNTAIN[side];
  const route: Vec[] = [at];
  let len = 0;
  for (const c of camps) {
    const p = Nav.findPath(at, c);
    for (const w of p) { len += Math.hypot(w.x - at.x, w.y - at.y); at = w; route.push(w); }
  }
  routes.push(route);
  console.log(`side ${side} full clear route: ${route.length} waypoints, ${len.toFixed(0)}u`);
}

// --- random pairs: validity + timing (cold cache vs warm)
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const randWalk = (): Vec => {
  for (;;) {
    const p = { x: MAP.minX + rnd() * W, y: MAP.minY + rnd() * H };
    if (Nav.walkable(p)) return p;
  }
};
const pairs: [Vec, Vec][] = [];
for (let i = 0; i < 2000; i++) pairs.push([randWalk(), randWalk()]);
Object.assign(Nav.navStats, { findPath: 0, los: 0, reuse: 0, astar: 0, cacheHit: 0, cacheMiss: 0, expanded: 0 });
let t1 = performance.now();
let bad = 0, ratio = 0;
for (const [a, b] of pairs) {
  const p = Nav.findPath(a, b);
  let prev = a, L = 0;
  for (const w of p) {
    if (!Nav.lineOfSight(prev, w) || segWall(prev, w)) bad++;
    L += Math.hypot(w.x - prev.x, w.y - prev.y);
    prev = w;
  }
  ratio += L / Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
}
const cold = performance.now() - t1;
console.log(`2000 random pairs: ${bad} bad legs, mean path/straight ${(ratio / pairs.length).toFixed(3)}, ` +
  `${(cold / pairs.length).toFixed(3)} ms/path cold`, JSON.stringify(Nav.navStats));
t1 = performance.now();
for (const [a, b] of pairs) Nav.findPath({ x: a.x + 20, y: a.y - 15 }, { x: b.x - 25, y: b.y + 10 });
console.log(`same pairs jittered (cache): ${((performance.now() - t1) / pairs.length).toFixed(3)} ms/path`, JSON.stringify(Nav.navStats));
check(bad === 0, "random pair paths have bad legs");

// --- LOS / walkable speed
t1 = performance.now();
let n = 0;
for (let i = 0; i < 200000; i++) {
  const a = pairs[i % pairs.length][0];
  const ang = i * 0.37;
  if (Nav.lineOfSight(a, { x: a.x + Math.cos(ang) * 600, y: a.y + Math.sin(ang) * 600 })) n++;
}
console.log(`lineOfSight 600u: ${((performance.now() - t1) * 1000 / 200000).toFixed(2)} µs/call (${((100 * n) / 200000).toFixed(0)}% clear)`);

// --- blink / dash rules
let hops = 0;
for (let i = 0; i < 20000; i++) {
  const a = pairs[i % pairs.length][0];
  const ang = rnd() * Math.PI * 2;
  const to = { x: a.x + Math.cos(ang) * 450, y: a.y + Math.sin(ang) * 450 };
  const f = Nav.blinkLanding(a, to, 420, true);
  const d = Nav.blinkLanding(a, to, 600, false);
  check(Nav.walkable(f) && !isWall(f.x, f.y), `flash lands in wall ${fmt(a)}->${fmt(f)}`);
  check(Nav.walkable(d) && !isWall(d.x, d.y), `dash lands in wall ${fmt(a)}->${fmt(d)}`);
  check(Nav.lineOfSight(a, d), `dash crossed a wall ${fmt(a)}->${fmt(d)}`);
  check(Math.hypot(f.x - a.x, f.y - a.y) <= 420.01 && Math.hypot(d.x - a.x, d.y - a.y) <= 450.01, "blink too long");
  if (!Nav.lineOfSight(a, f)) hops++;
}
console.log(`blink: 20000 flashes, ${hops} hopped a wall; dashes never cross walls`);

// --- advance: chase straight through a wall, unit pushed into a wall
{
  const u = { x: 3800, y: 7950, path: [] as Vec[] };
  const target = { x: 2090, y: 8430 };
  let steps = 0;
  while (Math.hypot(u.x - target.x, u.y - target.y) > 5 && steps < 400) {
    u.path = [{ ...target }]; // engine-style direct chase every tick
    const px = u.x, py = u.y;
    Nav.advance(u, 100);
    check(Nav.walkable(u), "advance ended in wall");
    check(!segWall({ x: px, y: py }, u), `advance step crossed wall ${px.toFixed(0)},${py.toFixed(0)} -> ${fmt(u)}`);
    steps++;
  }
  console.log(`direct chase blue->gromp: arrived in ${steps} steps`);
  const v = { x: 7400, y: 9000, path: [{ x: 7380, y: 7400 }] }; // likely inside a wall
  Nav.advance(v, 50);
  check(Nav.walkable(v), "unit in wall not popped out");
}

// --- separate
{
  const us = Array.from({ length: 5 }, () => ({ x: 7380, y: 7400, alive: true, side: 0 as 0 | 1 }));
  for (let k = 0; k < 20; k++) Nav.separate(us, 0.25);
  let minD = Infinity;
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) minD = Math.min(minD, Math.hypot(us[i].x - us[j].x, us[i].y - us[j].y));
  console.log(`separate: 5 stacked units -> min distance ${minD.toFixed(0)}u after 5 s`);
  check(us.every((u) => Nav.walkable(u)), "separate pushed into wall");
  const stuck = [{ x: 7400, y: 9000, alive: true, side: 1 as 0 | 1 }, { x: -500, y: 20000, alive: true, side: 1 as 0 | 1 }];
  Nav.separate(stuck, 0.25);
  check(stuck.every((u) => Nav.walkable(u)), "separate did not pop units out of walls");
}

if (process.env.PATHS_OUT) writeFileSync(process.env.PATHS_OUT, JSON.stringify(routes));
console.log(fails ? `${fails} FAILURES` : "nav-test OK");

// --- optional: full games with the nav flag (GAMES=n), counting nav calls and time spent inside nav
if (Number(process.env.GAMES ?? 0) > 0) {
  const { assembleData } = await import("../src/data/load");
  const { newGame } = await import("../src/core/game");
  const { joinTeam, autoLineup } = await import("../src/core/market");
  const { ovr } = await import("../src/core/player");
  const { Engine, ENGINE_FLAGS } = await import("../src/match/engine");
  const { newDraft, autoDraft } = await import("../src/match/draft");
  const { Rng } = await import("../src/core/rng");
  const { ROLES } = await import("../src/data/types");
  const { existsSync } = await import("node:fs");
  const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
  const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
  const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "t", seed: 7 });
  const pool = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => ovr(b) - ovr(a));
  for (const r of ROLES) {
    const byRole = pool.filter((p) => p.role === r);
    for (const tid of s.lck) {
      if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
      const p = byRole.shift();
      if (p) joinTeam(s, p, tid, 10000, 2);
    }
  }
  for (const tid of s.lck) autoLineup(s, s.teams[tid]);
  for (const k of Object.keys(ENGINE_FLAGS)) (ENGINE_FLAGS as Record<string, boolean>)[k] = false; // only the listed modules
  for (const f of (process.env.FLAGS ?? "nav").split(",").map((x) => x.trim()).filter(Boolean)) (ENGINE_FLAGS as Record<string, boolean>)[f] = true;
  Object.assign(Nav.navStats, { findPath: 0, los: 0, reuse: 0, astar: 0, cacheHit: 0, cacheMiss: 0, expanded: 0 });
  const G = Number(process.env.GAMES);
  // CALLERS=1: which engine lines trigger A* searches
  const callers: Record<string, number> = {};
  if (process.env.CALLERS) {
    Nav.navDebug.onAstar = (from) => {
      const lines = (new Error().stack ?? "").split(String.fromCharCode(10)).slice(3, 5);
      const unit = from as { task?: string; role?: string; fightId?: number };
      const st = (unit.task ? `[${unit.role} ${unit.fightId ? "fight" : unit.task}] ` : "") + lines.map((l) => {
        const m = l.match(/at (\S+)/);
        return m ? m[1] : l.trim();
      }).join(" < ");
      callers[st] = (callers[st] ?? 0) + 1;
    };
  }
  // ANALYZE=1: what the victims were doing when they died, how fast units travel
  const deaths: Record<string, number> = {};
  let moved = 0, movingTicks = 0;
  if (process.env.ANALYZE) {
    const P = Engine.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const origKill = P.kill, origLeave = P.leaveFight;
    P.leaveFight = function (this: { t: number }, u: unknown) {
      (u as { leftAt?: number }).leftAt = this.t;
      return origLeave.call(this, u);
    };
    P.kill = function (this: { t: number }, src: unknown, v: unknown) {
      const vu = v as { task: string; fightId: number; leftAt?: number; recallEnd?: number };
      const since = vu.leftAt === undefined ? 99 : this.t - vu.leftAt;
      const k = vu.fightId ? "in fight" : since < 15 ? `fleeing (${vu.task}, left fight <15s)` : `out of fight (${vu.task})`;
      deaths[k] = (deaths[k] ?? 0) + 1;
      return origKill.call(this, src, v);
    };
  }
  if (process.env.OLDSTRAIGHT) {
    // experiment: the old engine (nav flag off) but every goal is a straight line
    const P = Engine.prototype as unknown as { setGoal: (u: { goal: Vec | null; path: Vec[] }, g: Vec) => void };
    P.setGoal = function (u, g) {
      if (u.goal && Math.abs(u.goal.x - g.x) < 60 && Math.abs(u.goal.y - g.y) < 60) return;
      u.goal = { x: g.x, y: g.y };
      u.path = [g];
    };
  }
  let steps = 0, kills = 0, mins = 0;
  const per: string[] = [];
  const t0 = performance.now();
  for (let g = 0; g < G; g++) {
    const seed = 2000 + g * 37;
    const a = s.lck[g % 10], b = s.lck[(g + 3) % 10];
    const d = newDraft(a, b, []);
    autoDraft(s, data, d, new Rng(seed));
    const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed });
    const prev = e.units.map((u) => ({ x: u.x, y: u.y }));
    while (!e.over && e.t < 3600) {
      e.step();
      steps++;
      if (process.env.ANALYZE) for (const u of e.units) {
        const p = prev[u.i];
        const st = Math.hypot(u.x - p.x, u.y - p.y);
        if (u.alive && st > 1 && st < 200 && !u.fightId) { moved += st; movingTicks++; }
        p.x = u.x; p.y = u.y;
      }
    }
    kills += e.kills[0] + e.kills[1];
    if (process.env.VERBOSE) per.push(`${e.kills[0] + e.kills[1]}k/${(e.t / 60).toFixed(0)}m`);
    mins += e.t / 60;
  }
  const ms = performance.now() - t0;
  for (const [k, v] of Object.entries(callers).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String(v).padStart(7), k);
  console.log(`games ${G} flags ${JSON.stringify(ENGINE_FLAGS)}: ${(ms / 1000).toFixed(1)} s, ${steps} steps, ${(ms * 1000 / steps).toFixed(0)} µs/step, ` +
    `kills/game ${(kills / G).toFixed(1)}, ${(mins / G).toFixed(1)} min`);
  if (per.length) console.log(per.join(" "));
  if (process.env.ANALYZE) {
    // route length vs straight line: old heatmap A* (map.ts, used with the nav flag off) vs nav
    const M = await import("../src/match/map");
    M.initMap(data.heatmap);
    let oldR = 0, navR = 0, n = 0;
    for (const [a, b] of pairs) {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < 900) continue;
      const len = (p: Vec[]) => { let L = 0, q = a; for (const w of p) { L += Math.hypot(w.x - q.x, w.y - q.y); q = w; } return L; };
      oldR += len(M.findPath(a, b)) / d;
      navR += Nav.pathLength(a, b) / d;
      n++;
    }
    console.log(`route length / straight line over ${n} random pairs: old map.ts A* ${(oldR / n).toFixed(3)}, nav ${(navR / n).toFixed(3)}`);
  }
  if (process.env.ANALYZE) {
    console.log(`moving out of fights: ${(moved / Math.max(1, movingTicks) / 0.25).toFixed(0)} u/s over ${movingTicks} unit-ticks`);
    console.log("deaths:", Object.entries(deaths).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / G).toFixed(1)}`).join(", "));
  }
  console.log("nav calls:", JSON.stringify(Nav.navStats), `A* per game ${(Nav.navStats.astar / G).toFixed(0)}`);
}
