// CS and level by role and minute in engine games, next to the real LCK 2026 table from scripts/lck_growth.py.
// Same games as calibrate.ts / early-diag.ts (same rosters, drafts, seeds). "lane" CS is what economy() gives near
// waves and side lanes; the rest (camps, scuttle) is counted as jungle CS.
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/growth-check.ts [games] [rosterSeed]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, ENGINE_FLAGS, applyEarlyTune, applyGrowthTune } from "../src/match/engine";
import { applyWaveTune } from "../src/match/minions";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { par } from "./lib/par";
import { DRAW } from "../src/match/engine";
// no screen: skip the draw-only effects list (results stay the same; HEADLESS=0 keeps it)
if (process.env.HEADLESS !== "0" && DRAW) DRAW.fx = false; // (DRAW is missing in code from before it, scripts/ab.mjs --base)

const dir = "data";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"));
const N = Number(process.argv[3] ?? 40);
const rosterSeed = Number(process.argv[4] ?? 3);
applyEarlyTune(process.env.EARLY_TUNE);
// GROWTH_TUNE=laneCs:12,sideCs:7 overrides the CS / XP / gold income (engine.ts GROWTH) for this run
applyGrowthTune(process.env.GROWTH_TUNE);
// WAVE_TUNE=lastHit:0.9 overrides the wave knobs (minions.ts); FLAGS=-minions runs the engine without real minions
applyWaveTune(process.env.WAVE_TUNE);
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) (ENGINE_FLAGS as Record<string, boolean>)[fl.replace(/^-/, "")] = !fl.startsWith("-");
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
s.user = "__nobody__";
const rr = new Rng(rosterSeed);
const pool = rr.shuffle(Object.values(s.players).filter((p) => !p.team && p.origin === "real"));
for (const r of ROLES) {
  const byRole = pool.filter((p) => p.role === r);
  for (const tid of s.lck) {
    if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
    const p = byRole.shift();
    if (p) joinTeam(s, p, tid, 10000, 2);
  }
}
for (const tid of s.lck) autoLineup(s, s.teams[tid]);
const rng = new Rng(11);

// lane CS: what economy() adds (waves near the unit, side lanes after 14:00)
let laneCs: number[] = [];
const econ = Engine.prototype.economy;
Engine.prototype.economy = function (this: Engine) {
  const before = this.units.map((u) => u.cs);
  econ.call(this);
  this.units.forEach((u, i) => (laneCs[i] += u.cs - before[i]));
};
// with real minions (ENGINE_FLAGS.minions) the last hits are paid in lanesTick (minions.ts)
const lanes = Engine.prototype.lanesTick;
Engine.prototype.lanesTick = function (this: Engine) {
  const before = this.units.map((u) => u.cs);
  lanes.call(this);
  this.units.forEach((u, i) => (laneCs[i] += u.cs - before[i]));
};

const MINUTES = [2, 3, 5, 8, 10, 15, 20, 25, 30];
// where the time goes (seconds per game) by role and phase: dead, at a wave front, clearing a camp, or the unit's task
const PHASES = [[0, 600], [600, 1200], [1200, 99999]] as const;
const timeUse = new Map<string, Map<string, number>>();
const use = (into: Map<string, Map<string, number>>, k: string, what: string, dt: number) => {
  const m = into.get(k) ?? new Map<string, number>();
  m.set(what, (m.get(what) ?? 0) + dt);
  into.set(k, m);
};
const phaseLen = [0, 0, 0];
type Acc = { cs: number; jg: number; lvl: number; xp: number; gold: number; n: number };
const acc = new Map<string, Acc>();
const end = new Map<string, { cspm: number; jgpm: number; lvl: number; n: number }>();
let dur = 0;
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  // par.game: plays the game here, or leaves it to another piece of a parallel run (scripts/par.mjs). The game only
  // logs what it adds (time use summed per game: multiples of DT, so the totals come out the same) and the totals
  // are added below in game order
  const r = par.game(g, () => {
    const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
    laneCs = e.units.map(() => 0);
    const useG = new Map<string, Map<string, number>>();
    const phaseG = [0, 0, 0];
    const accOps: [string, number, number, number, number, number][] = [];
    let mi = 0;
    while (!e.over && e.t < 70 * 60) {
      const t0 = e.t;
      e.step();
      const dt = e.t - t0;
      const ph = PHASES.findIndex(([a, b]) => t0 >= a && t0 < b);
      phaseG[ph] += dt;
      const fronts = (["top", "mid", "bot"] as const).map((l) => e.laneFrontPos(l));
      for (const u of e.units) {
        let what: string;
        if (!u.alive) what = "dead";
        else if (u.campTarget !== undefined && e.camps[u.campTarget]?.alive && Math.hypot(u.x - e.camps[u.campTarget].pos.x, u.y - e.camps[u.campTarget].pos.y) <= 250) what = "camp";
        else if (fronts.some((f) => Math.hypot(u.x - f.x, u.y - f.y) < 1100)) what = `wave/${u.task}`;
        // a jungler on its jungle task: walking to a camp that is up, or waiting with none of its own up
        else if (u.task === "jungle") what = e.camps.some((c) => c.alive && c.side === u.side && c.kind !== "scuttle") ? "jungle-walk" : "jungle-wait";
        else what = u.task;
        use(useG, `${u.role}:${ph}`, what, dt);
      }
      while (mi < MINUTES.length && e.t >= MINUTES[mi] * 60) {
        for (const u of e.units) accOps.push([`${MINUTES[mi]}:${u.role}`, u.cs, u.cs - laneCs[u.i], u.level, u.xp, u.gold]);
        mi++;
      }
    }
    const mins = e.t / 60;
    const endOps = e.units.map((u) => [u.role, u.cs / mins, (u.cs - laneCs[u.i]) / mins, u.level] as [string, number, number, number]);
    return { useG, phaseG, accOps, mins, endOps };
  });
  if (!r) continue;
  for (const [k, m] of r.useG) for (const [what, dt] of m) use(timeUse, k, what, dt);
  r.phaseG.forEach((v, i) => (phaseLen[i] += v));
  for (const [k, cs, jg, lvl, xp, gold] of r.accOps) {
    const x = acc.get(k) ?? { cs: 0, jg: 0, lvl: 0, xp: 0, gold: 0, n: 0 };
    x.cs += cs; x.jg += jg; x.lvl += lvl; x.xp += xp; x.gold += gold; x.n++;
    acc.set(k, x);
  }
  dur += r.mins;
  for (const [role, cspm, jgpm, lvl] of r.endOps) {
    const x = end.get(role) ?? { cspm: 0, jgpm: 0, lvl: 0, n: 0 };
    x.cspm += cspm; x.jgpm += jgpm; x.lvl += lvl; x.n++;
    end.set(role, x);
  }
}
par.end();
console.log(`${N} games, roster seed ${rosterSeed}, mean length ${(dur / N).toFixed(1)} min`);
console.log("minute  role      games   CS  (jungle)   level   xp    gold");
for (const m of MINUTES) {
  for (const r of ROLES) {
    const x = acc.get(`${m}:${r}`);
    if (!x) continue;
    console.log(`${String(m).padStart(5)}   ${r.padEnd(8)} ${String(x.n / 2).padStart(5)} ${(x.cs / x.n).toFixed(1).padStart(6)} (${(x.jg / x.n).toFixed(1).padStart(5)}) ${(x.lvl / x.n).toFixed(2).padStart(6)} ${(x.xp / x.n).toFixed(0).padStart(6)} ${(x.gold / x.n).toFixed(0).padStart(6)}`);
  }
}
console.log("time use, share of each phase (0-10 / 10-20 / 20+ min):");
for (const r of ROLES) {
  for (const [ph, [a]] of PHASES.entries()) {
    const m = timeUse.get(`${r}:${ph}`);
    if (!m || !phaseLen[ph]) continue;
    const tot = [...m.values()].reduce((x, y) => x + y, 0);
    const parts = [...m.entries()].sort((x, y) => y[1] - x[1]).filter(([, v]) => v / tot >= 0.02).map(([k, v]) => `${k} ${((v / tot) * 100).toFixed(0)}%`);
    console.log(`  ${r.padEnd(8)} ${String(a / 60).padStart(2)}+  ${parts.join(", ")}`);
  }
}
console.log("end of game: CS/min (jungle CS/min), level");
for (const r of ROLES) {
  const x = end.get(r)!;
  console.log(`  ${r.padEnd(8)} ${(x.cspm / x.n).toFixed(2).padStart(5)} (${(x.jgpm / x.n).toFixed(2)})  Lv ${(x.lvl / x.n).toFixed(2)}`);
}
