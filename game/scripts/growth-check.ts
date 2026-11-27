// CS and level by role and minute in engine games, next to the real LCK 2026 table from scripts/lck_growth.py.
// Same games as calibrate.ts / early-diag.ts (same rosters, drafts, seeds). "lane" CS is what economy() gives near
// waves and side lanes; the rest (camps, scuttle) is counted as jungle CS.
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/growth-check.ts [games] [rosterSeed]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, applyEarlyTune, applyGrowthTune } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";

const dir = "data";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"));
const N = Number(process.argv[3] ?? 40);
const rosterSeed = Number(process.argv[4] ?? 3);
applyEarlyTune(process.env.EARLY_TUNE);
// GROWTH_TUNE=laneCs:12,sideCs:7 overrides the CS / XP / gold income (engine.ts GROWTH) for this run
applyGrowthTune(process.env.GROWTH_TUNE);
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

const MINUTES = [2, 3, 5, 8, 10, 15, 20, 25, 30];
// where the time goes (seconds per game) by role and phase: dead, at a wave front, clearing a camp, or the unit's task
const PHASES = [[0, 600], [600, 1200], [1200, 99999]] as const;
const timeUse = new Map<string, Map<string, number>>();
const use = (role: string, ph: number, what: string, dt: number) => {
  const k = `${role}:${ph}`;
  const m = timeUse.get(k) ?? new Map<string, number>();
  m.set(what, (m.get(what) ?? 0) + dt);
  timeUse.set(k, m);
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
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
  laneCs = e.units.map(() => 0);
  let mi = 0;
  while (!e.over && e.t < 70 * 60) {
    const t0 = e.t;
    e.step();
    const dt = e.t - t0;
    const ph = PHASES.findIndex(([a, b]) => t0 >= a && t0 < b);
    phaseLen[ph] += dt;
    const fronts = (["top", "mid", "bot"] as const).map((l) => e.laneFrontPos(l));
    for (const u of e.units) {
      let what: string;
      if (!u.alive) what = "dead";
      else if (u.campTarget !== undefined && e.camps[u.campTarget]?.alive && Math.hypot(u.x - e.camps[u.campTarget].pos.x, u.y - e.camps[u.campTarget].pos.y) <= 250) what = "camp";
      else if (fronts.some((f) => Math.hypot(u.x - f.x, u.y - f.y) < 1100)) what = `wave/${u.task}`;
      // a jungler on its jungle task: walking to a camp that is up, or waiting with none of its own up
      else if (u.task === "jungle") what = e.camps.some((c) => c.alive && c.side === u.side && c.kind !== "scuttle") ? "jungle-walk" : "jungle-wait";
      else what = u.task;
      use(u.role, ph, what, dt);
    }
    while (mi < MINUTES.length && e.t >= MINUTES[mi] * 60) {
      for (const u of e.units) {
        const k = `${MINUTES[mi]}:${u.role}`;
        const x = acc.get(k) ?? { cs: 0, jg: 0, lvl: 0, xp: 0, gold: 0, n: 0 };
        x.cs += u.cs; x.jg += u.cs - laneCs[u.i]; x.lvl += u.level; x.xp += u.xp; x.gold += u.gold; x.n++;
        acc.set(k, x);
      }
      mi++;
    }
  }
  const mins = e.t / 60;
  dur += mins;
  for (const u of e.units) {
    const x = end.get(u.role) ?? { cspm: 0, jgpm: 0, lvl: 0, n: 0 };
    x.cspm += u.cs / mins; x.jgpm += (u.cs - laneCs[u.i]) / mins; x.lvl += u.level; x.n++;
    end.set(u.role, x);
  }
}
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
