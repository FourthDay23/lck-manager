// Engine diagnostics: walls, objectives, fights. Run: FLAGS=nav,macro,fight GAMES=12 node scripts/run-ts.mjs scripts/engine-diag.ts
// (Git Bash: prefix MSYS_NO_PATHCONV=1). Wall mask = black pixels of public/assets/map11.png (scripts/wallmask.json).
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine, ENGINE_FLAGS } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { MAP } from "../src/match/map";

const root = "public";
const dir = "data";
const j = (f: string) => (existsSync(`${root}/${dir}/${f}`) ? JSON.parse(readFileSync(`${root}/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const mask = JSON.parse(readFileSync("scripts/wallmask.json", "utf8"));
const W = MAP.maxX - MAP.minX, H = MAP.maxY - MAP.minY;
const isWall = (x: number, y: number) => {
  const px = Math.floor(((x - MAP.minX) / W) * mask.w), py = Math.floor((1 - (y - MAP.minY) / H) * mask.h);
  if (px < 0 || py < 0 || px >= mask.w || py >= mask.h) return true;
  return mask.rows[py][px] === "1";
};
// deep inside a wall: the point and its 4 neighbours 60 units away are all wall (ignores edge rounding)
const deepWall = (x: number, y: number) => isWall(x, y) && isWall(x + 60, y) && isWall(x - 60, y) && isWall(x, y + 60) && isWall(x, y - 60);
const crossesWall = (ax: number, ay: number, bx: number, by: number) => {
  const d = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(d / 25));
  let run = 0;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (isWall(ax + (bx - ax) * t, ay + (by - ay) * t)) { run += d / n; if (run >= 90) return true; } else run = 0;
  }
  return false;
};

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

const GAMES = Number(process.env.GAMES ?? 12);
// FLAGS lists exactly the modules to run (unset = engine defaults, all on); "FLAGS=" = all off
if (process.env.FLAGS !== undefined) for (const k of Object.keys(ENGINE_FLAGS)) (ENGINE_FLAGS as Record<string, boolean>)[k] = false;
for (const f of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) (ENGINE_FLAGS as Record<string, boolean>)[f] = true;
const STRAT = process.env.STRAT as undefined | string; // e.g. STRAT=split,teamfight  (blue,red)
console.log("flags", JSON.stringify(ENGINE_FLAGS), "strategy", STRAT ?? "(AI default)");
let aliveTicks = 0, inWall = 0, deepIn = 0;
let kills = 0;
// team shape after 20 min, sampled every 10 s: distance of each team's farthest member from its centroid, and median member distance
const farthest: number[] = [], medRadius: number[] = [];
const inWallByTask: Record<string, number> = {};
const crossByTask: Record<string, number> = {};
let crosses = 0, dashCross = 0;
// objectives
const objSolo: Record<string, number> = {}; // ticks an objective was being hit by exactly 1 unit (of the side hitting)
const objSoloRole: Record<string, number> = {};
let objHitTicks = 0;
const takeCount: Record<string, number> = {}; // takes by number of takers at pit
const takeSoloRole: Record<string, number> = {};
// fights
const fightSizes: number[] = [];
const joinSpread: number[] = [];
let minutes = 0;

for (let g = 0; g < GAMES; g++) {
  const seed = 2000 + g * 37;
  const a = s.lck[g % 10], b = s.lck[(g + 3) % 10];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, new Rng(seed));
  const strategy = STRAT ? (STRAT.split(",").map((x) => x || null) as [never, never]) : undefined;
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed, strategy });
  const prev = e.units.map((u) => ({ x: u.x, y: u.y, alive: u.alive }));
  const objPrevHp: Record<string, number> = {};
  const objWasAlive: Record<string, boolean> = {};
  const fightJoin = new Map<number, number[]>();
  let lastFights = new Set<number>();
  while (!e.over && e.t < 3600) {
    for (const k of Object.keys(e.obj)) { objPrevHp[k] = e.obj[k as "dragon"].hp; objWasAlive[k] = e.obj[k as "dragon"].alive; }
    e.step();
    if (e.t >= 1200 && Math.abs(e.t % 10) < 1e-6) {
      for (const sd of [0, 1]) {
        const m = e.units.filter((u) => u.side === sd && u.alive);
        if (m.length < 4) continue;
        const cx = m.reduce((s2, u) => s2 + u.x, 0) / m.length, cy = m.reduce((s2, u) => s2 + u.y, 0) / m.length;
        const ds = m.map((u) => Math.hypot(u.x - cx, u.y - cy)).sort((x, y) => x - y);
        farthest.push(ds[ds.length - 1]);
        medRadius.push(ds[Math.floor(ds.length / 2)]);
      }
    }
    for (const u of e.units) {
      const p = prev[u.i];
      if (u.alive && p.alive) {
        aliveTicks++;
        if (isWall(u.x, u.y)) { inWall++; inWallByTask[u.task] = (inWallByTask[u.task] ?? 0) + 1; }
        if (deepWall(u.x, u.y)) deepIn++;
        const step = Math.hypot(u.x - p.x, u.y - p.y);
        if (step < 2000 && crossesWall(p.x, p.y, u.x, u.y)) {
          crosses++;
          const key = step > 200 ? "dash/flash" : u.fightId ? "fight" : u.task;
          crossByTask[key] = (crossByTask[key] ?? 0) + 1;
          if (step > 200) dashCross++;
        }
      }
      p.x = u.x; p.y = u.y; p.alive = u.alive;
    }
    // objectives
    for (const k of Object.keys(e.obj) as ("dragon" | "baron" | "grubs" | "herald" | "elder")[]) {
      const o = e.obj[k];
      if (!objWasAlive[k]) continue;
      const at = e.units.filter((u) => u.alive && !u.fightId && Math.hypot(u.x - o.pos.x, u.y - o.pos.y) < 650);
      if (!at.length) continue;
      if (o.alive && o.hp >= objPrevHp[k]) continue;
      objHitTicks++;
      for (const sd of [0, 1]) {
        const mine = at.filter((u) => u.side === sd);
        if (mine.length === 1) {
          objSolo[k] = (objSolo[k] ?? 0) + 1;
          const key = `${k}:${mine[0].role}:${mine[0].task}`;
          objSoloRole[key] = (objSoloRole[key] ?? 0) + 1;
        }
      }
      if (!o.alive || (k === "dragon" && o.spawnAt && o.spawnAt > e.t && objWasAlive[k])) {
        const ev = e.events[e.events.length - 1];
        const sd = ev && ["dragon", "baron", "grubs", "herald", "elder", "soul", "steal"].includes(ev.type) ? ev.side : null;
        if (sd !== null) {
          const n = at.filter((u) => u.side === sd).length;
          const key = `${k} n=${n}`;
          takeCount[key] = (takeCount[key] ?? 0) + 1;
          if (n === 1) {
            const r = at.find((u) => u.side === sd)!;
            const kk = `${k}:${r.role}`;
            takeSoloRole[kk] = (takeSoloRole[kk] ?? 0) + 1;
          }
        }
      }
    }
    // fights
    for (const u of e.units) if (u.fightId) {
      const arr = fightJoin.get(u.fightId) ?? [];
      if (!(u as any)._seen?.has(u.fightId)) {
        arr.push(e.t);
        fightJoin.set(u.fightId, arr);
        ((u as any)._seen ??= new Set()).add(u.fightId);
      }
    }
    const now = new Set(e.fights.keys());
    for (const id of lastFights) if (!now.has(id)) {
      const arr = fightJoin.get(id) ?? [];
      fightSizes.push(arr.length);
      if (arr.length >= 6) joinSpread.push(Math.max(...arr) - Math.min(...arr));
    }
    lastFights = now;
  }
  minutes += e.t / 60;
  kills += e.kills[0] + e.kills[1];
}

const pct = (a: number, b: number) => ((100 * a) / Math.max(1, b)).toFixed(1) + "%";
console.log(`games ${GAMES}, avg length ${(minutes / GAMES).toFixed(1)} min, kills/game ${(kills / GAMES).toFixed(1)}`);
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
console.log(`team shape after 20m (median): farthest member ${med(farthest).toFixed(0)}u from centroid, median member ${med(medRadius).toFixed(0)}u`);
console.log(`alive unit-ticks standing on wall pixels: ${pct(inWall, aliveTicks)} (deep inside wall: ${pct(deepIn, aliveTicks)})`);
console.log("  by task:", Object.entries(inWallByTask).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pct(v, inWall)}`).join(", "));
console.log(`tick moves crossing ≥90u of wall: ${crosses} (${(crosses / GAMES).toFixed(0)}/game), of which dash/flash ${dashCross}`);
console.log("  by cause:", Object.entries(crossByTask).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pct(v, crosses)}`).join(", "));
console.log(`objective damage ticks: ${objHitTicks}; ticks where a side's hitter was ALONE:`, objSolo);
console.log("  solo hitter role:task (top 12):", Object.entries(objSoloRole).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("takes by #takers at pit:", takeCount);
console.log("  solo takes by role:", takeSoloRole);
const big = fightSizes.filter((n) => n >= 6).length;
console.log(`fights: ${fightSizes.length} total; size>=6: ${big}; median join spread in big fights: ${joinSpread.sort((x, y) => x - y)[Math.floor(joinSpread.length / 2)]?.toFixed(1)}s`);
