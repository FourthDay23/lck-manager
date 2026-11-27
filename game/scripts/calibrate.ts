// Headless engine runs: game length, kills, objectives, and whether the watched engine agrees with
// the one-line AI-vs-AI formula (gameWinProb) on who wins.
// Run: node scripts/run-ts.mjs scripts/calibrate.ts [games] [rosterSeed]
//  in parallel: node scripts/par.mjs calibrate.ts [games] [rosterSeed]  (same report; A/B: scripts/ab.mjs)
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, ENGINE_FLAGS, applyEarlyTune, applyGrowthTune, applyPaceTune, applySimTune } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { par, engineSnap } from "./lib/par";
import { DRAW } from "../src/match/engine";
// no screen: skip the draw-only effects list (results stay the same; HEADLESS=0 keeps it)
if (process.env.HEADLESS !== "0" && DRAW) DRAW.fx = false; // (DRAW is missing in code from before it, scripts/ab.mjs --base)
import { Rng } from "../src/core/rng";
import { gameWinProb, teamPower } from "../src/core/quick";
import { ROLES } from "../src/data/types";
import { ITEM_TUNE } from "../src/match/items";

const dir = existsSync("public/data/champions.json") && existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => {
  const p = `public/${dir}/${f}`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
// ITEMS=0 runs the engine without items.json (the older gold-only item model and flat kill gold);
// MATCHUPS=0 without the LCK champion matchups (matchups.json, match/matchup.ts). The reference formula below
// (gameWinProb) knows nothing of the drafted champions, so with matchups on its bucket table and slope also carry them
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"), process.env.MATCHUPS === "0" ? null : j("matchups.json"));
// ITEM_TUNE=beyond:0.85,objectiveBounty:0 overrides items.ts weights for this run
for (const kv of (process.env.ITEM_TUNE ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split(":");
  (ITEM_TUNE as Record<string, number | boolean>)[k] = k === "objectiveBounty" ? v !== "0" : Number(v);
}
const N = Number(process.argv[3] ?? 60);
// EARLY_TUNE=gankRate:0.004,allinBot:0.0008 overrides the laning fight rates (engine.ts EARLY_TUNE) for this run
applyEarlyTune(process.env.EARLY_TUNE);
// GROWTH_TUNE=laneCs:12,sideCs:7 overrides the CS / XP / gold income (engine.ts GROWTH) for this run
applyGrowthTune(process.env.GROWTH_TUNE);
// SIM_TUNE=siegePush:2.2 overrides the turret / side-lane / gank / herald behaviour values (engine.ts SIM_TUNE) for this run
applySimTune(process.env.SIM_TUNE);
// PACE_TUNE=towerDmg:1.3 overrides the structure damage after laning (engine.ts PACE_TUNE) for this run
applyPaceTune(process.env.PACE_TUNE);
// FLAGS=nav,macro,fight turns engine modules on (default: the engine's own defaults)
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("-"))) (ENGINE_FLAGS as Record<string, boolean>)[fl] = true;
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter((x) => x.startsWith("-"))) (ENGINE_FLAGS as Record<string, boolean>)[fl.slice(1)] = false;
const rosterSeed = Number(process.argv[4] ?? 3);
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
s.user = "__nobody__"; // no difficulty edge in calibration
// random rosters from the real pool, so strengths spread like a real league
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
let len = 0, kills = 0, drag = 0, barons = 0, solo = 0, steals = 0, multis = 0, aces = 0;
let fb = 0, ft = 0, doubles = 0, heralds = 0, grubs = 0, souls = 0, elders = 0;
const kpm = [0, 0, 0, 0, 0];
const buckets = [0, 0, 0, 0, 0].map(() => ({ n: 0, wins: 0, expSum: 0 }));
let brierEngine = 0;
const pairs: [number, number][] = [];
const rows: { p: number; win: number; len: number; kills: number; drag: number; barons: number }[] = [];
let blueWins = 0;
const split: Record<string, number> = {};
const origins: Record<string, number> = {};
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  // STRAT=balanced,balanced forces both sides' game plans (default: each AI coach picks its own)
  const strategy = process.env.STRAT ? (process.env.STRAT.split(",").map((x) => x || null) as [never, never]) : undefined;
  // par.game: plays the game here, or leaves it to another piece of a parallel run (scripts/par.mjs)
  const e = par.game(g, () => { const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g, strategy }); e.runToEnd(); return engineSnap(e); });
  if (!e) continue;
  len += e.t;
  kills += e.kills[0] + e.kills[1];
  drag += e.dragons[0].length + e.dragons[1].length;
  barons += e.barons[0] + e.barons[1];
  solo += e.events.filter((x) => x.type === "solo").length;
  steals += e.events.filter((x) => x.type === "steal").length;
  multis += e.events.filter((x) => ["triple", "quadra", "penta"].includes(x.type)).length;
  aces += e.events.filter((x) => x.type === "ace").length;
  elders += e.events.filter((x) => x.type === "elder").length;
  fb += e.events.find((x) => x.type === "first_blood")?.t ?? e.t;
  ft += e.events.find((x) => x.type === "first_turret")?.t ?? e.t;
  doubles += e.events.filter((x) => x.type === "double").length;
  heralds += e.heralds[0] + e.heralds[1];
  grubs += (e.grubs[0] + e.grubs[1]) / 3;
  souls += e.soul !== null ? 1 : 0;
  const key = [e.dragons[0].length, e.dragons[1].length].sort().join("-") + (e.soul !== null ? (e.winner === e.soul ? " soulWin" : " soulLose") : "");
  split[key] = (split[key] ?? 0) + 1;
  for (const [k, v] of Object.entries(e.killOrigin)) origins[k] = (origins[k] ?? 0) + v;
  for (const ev of e.events) if (["kill", "first_blood", "solo"].includes(ev.type)) kpm[Math.min(4, Math.floor(ev.t / 600))]++;
  const p = gameWinProb(s, a, b);
  const win = e.winner === 0 ? 1 : 0;
  const k = Math.min(4, Math.floor(p * 5));
  buckets[k].n++;
  buckets[k].wins += win;
  buckets[k].expSum += p;
  brierEngine += (p - win) ** 2;
  blueWins += win;
  pairs.push([p, win]);
  rows.push({ p, win, len: e.t, kills: e.kills[0] + e.kills[1], drag: e.dragons[0].length + e.dragons[1].length, barons: e.barons[0] + e.barons[1] });
}
par.end();
// logistic fit win ~ sigmoid(slope * logit(p) + bias): slope 1 / bias 0 = the engine agrees with the formula;
// slope < 1 = ratings matter less in the engine than in the AI-vs-AI formula; bias > 0 = blue-side edge
function fitLogit(xy: [number, number][]) {
  let a = 1, b0 = 0;
  for (let it = 0; it < 60; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const [p, y] of xy) {
      const x = Math.log(Math.min(0.995, Math.max(0.005, p)) / (1 - Math.min(0.995, Math.max(0.005, p))));
      const q = 1 / (1 + Math.exp(-(a * x + b0)));
      const w = q * (1 - q);
      ga += (y - q) * x; gb += y - q;
      haa += w * x * x; hab += w * x; hbb += w;
    }
    const det = haa * hbb - hab * hab || 1e-9;
    a += (hbb * ga - hab * gb) / det;
    b0 += (haa * gb - hab * ga) / det;
  }
  return { slope: a, bias: b0 };
}
const f = (x: number) => (x / N).toFixed(2);
const pw = s.lck.map((t) => teamPower(s, t)).sort((x, y) => y - x);
console.log(`data=${dir} games=${N} team power ${pw[0].toFixed(1)}..${pw[pw.length - 1].toFixed(1)}`);
console.log(`length ${(len / N / 60).toFixed(1)} min | kills ${f(kills)} | dragons ${f(drag)} | barons ${f(barons)} | elder ${f(elders)} | solo ${f(solo)} | steals ${f(steals)} | triple+ ${f(multis)} | aces ${f(aces)}`);
console.log(`first blood ${(fb / N / 60).toFixed(1)} min | first tower ${(ft / N / 60).toFixed(1)} min | doubles ${f(doubles)} | heralds ${f(heralds)} | grub camps ${f(grubs)} | soul ${f(souls)}`);
console.log(`kills by 10-min block (per game): ${kpm.map((x) => (x / N).toFixed(1)).join(" / ")}`);
console.log(`target (LCK 2026, 502 games): 32.2 min, 29.5 kills, 4.4 dragons, 1.31 barons, 0.09 elder, 1.6 solo, 4.1 multikills (double+), 1.03 ace, FB 5.1, FT 15.7, soul 0.46, kills by block 3.8/8.5/11.8/4.7/0.6`);
console.log("formula p bucket -> engine blue win rate (should match the bucket's mean p):");
for (const [i, bk] of buckets.entries()) if (bk.n) console.log(`  p ${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}: mean p ${(bk.expSum / bk.n).toFixed(2)}  engine ${(bk.wins / bk.n).toFixed(2)}  (n=${bk.n})`);
console.log(`brier of formula vs engine results ${(brierEngine / N).toFixed(3)} (0.25 = coin flip)`);
const fit = fitLogit(pairs);
console.log(`logistic fit: slope ${fit.slope.toFixed(2)} (1 = engine as decisive as the formula), blue bias ${fit.bias.toFixed(2)} logit`);
console.log("kill origins per game", Object.entries(origins).map(([k, v]) => `${k} ${(v / N).toFixed(1)}`).join(" | "));
console.log("dragon splits", Object.entries(split).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  "));
console.log(`blue side win rate ${(blueWins / N * 100).toFixed(1)}%`);
// PAIRS=file.json writes each game's (formula p, blue won, length, kills, dragons, barons) so several roster seeds can
// be pooled into one slope fit (one or two seeds swing 0.3-1.6 on their own)
if (process.env.PAIRS) writeFileSync(process.env.PAIRS, JSON.stringify(rows));
