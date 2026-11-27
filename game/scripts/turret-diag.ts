// Minions and turrets in engine games (same rosters, drafts and seeds as calibrate.ts): what kills minions, how many
// are alive, what turrets shoot and why, when plates and turrets fall. Compare with scripts/lck_turrets.py (LCK 2026).
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/turret-diag.ts [games=40] [rosterSeed=3]
//   FLAGS=-minions      the engine as it was before real minions (turret and plate times only)
//   LOG=3               print every change of a turret's target in game 3 (LOGMAX lines, default 80)
//   WAVE_TUNE=... PACE_TUNE=... SIM_TUNE=...   override the knobs for this run
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, ENGINE_FLAGS, applyEarlyTune, applyGrowthTune, applyPaceTune, applySimTune } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import * as Minions from "../src/match/minions";
import * as Turrets from "../src/match/turrets";
import { LANES } from "../src/match/map";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
const N = Number(process.argv[3] ?? 40);
const rosterSeed = Number(process.argv[4] ?? 3);
applyEarlyTune(process.env.EARLY_TUNE);
applyGrowthTune(process.env.GROWTH_TUNE);
applySimTune(process.env.SIM_TUNE);
applyPaceTune(process.env.PACE_TUNE);
Minions.applyWaveTune(process.env.WAVE_TUNE);
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
  if (fl.startsWith("-")) (ENGINE_FLAGS as Record<string, boolean>)[fl.slice(1)] = false;
  else (ENGINE_FLAGS as Record<string, boolean>)[fl] = true;
}
const LOG = process.env.LOG ? Number(process.env.LOG) : -1;
const LOGMAX = Number(process.env.LOGMAX ?? 80);

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

const qt = (v: number[], p: number) => { const x = [...v].sort((a, b) => a - b); return x.length ? x[Math.min(x.length - 1, Math.round(p * (x.length - 1)))] : NaN; };
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const TIER = ["", "outer", "inner", "inhibitor turret", "nexus turret"];
const KO: Record<string, string> = { melee: "근접 미니언", caster: "원거리 미니언", siege: "공성 미니언", super: "슈퍼 미니언" };

const MIN = [10, 12, 14, 16, 18, 20, 22, 25, 28, 30, 35];
const PMIN = [5, 8, 10, 12, 14, 16, 20, 25, 30, 99];
const downBy = MIN.map(() => 0), platesBy = PMIN.map(() => 0);
const firstTier: number[][] = [[], [], [], [], []], allTier: number[][] = [[], [], [], [], []];
const outerLane: Record<string, number[]> = { top: [], mid: [], bot: [] };
const firstLane: Record<string, number> = { top: 0, mid: 0, bot: 0 };
const gapOI: number[] = [], gapIB: number[] = [];
let towers = 0, plates = 0, inhibs = 0, len = 0, kills = 0, winnerT = 0, loserT = 0, lastChamp = 0, lastAny = 0;
const firstPlate: number[] = [], plateToKill: number[] = [];
const causes: Record<string, number>[] = [{}, {}];
const M = { spawned: 0, credited: 0, missed: 0, unpaidNear: 0, unpaidFar: 0, aliveSum: 0, steps: 0, maxAlive: 0, maxLane: 0, toChamps: 0, toStructs: 0 };
const T = { shots: {} as Record<string, number>, help: 0, nowave: 0, champKills: 0, dmg: {} as Record<string, number>, backdoor: 0, respawns: 0 };
let minionKills = 0, execs = 0, turretBlows = 0;
// killing blows with no champion as the source (turret shots, minions), with or without a champion to credit
const kill0 = Engine.prototype.kill;
Engine.prototype.kill = function (this: Engine, src, v) {
  if (!src) {
    turretBlows++;
    if (![...v.lastHitBy.entries()].some(([i, t]) => this.t - t < 10 && this.units[i].side !== v.side)) {
      execs++;
      if (process.env.TRACE_EXEC) {
        const tw = this.turrets.filter((t) => t.alive && t.side !== v.side).map((t) => ({ t, d: Math.hypot(t.pos.x - v.x, t.pos.y - v.y) })).sort((a, b) => a.d - b.d)[0];
        console.log(`  exec ${clock(this.t)} ${v.role} ${v.champ.id} task=${v.task} fight=${v.fightId ? 1 : 0} by=${this.execBy} turret=${tw ? `${tw.t.lane}${tw.t.tier} d=${Math.round(tw.d)} wave=${this.waveAt(tw.t) ? 1 : 0}` : "-"} goalD=${v.goal && tw ? Math.round(Math.hypot(tw.t.pos.x - v.goal.x, tw.t.pos.y - v.goal.y)) : "-"}`);
      }
    }
  }
  kill0.call(this, src, v);
};
// lane fronts during laning: how far from the middle, and how long a wave sits on a turret
let frontDev = 0, frontN = 0, crashed = 0, clash = 0;
const laneDmg: Record<string, number> = {};
// turrets by who took them: the eventual winner / loser, by minute and by tier; and the winner's gold lead
const WL = [14, 16, 18, 20, 22, 25, 28, 30, 99];
const wlBy = [WL.map(() => 0), WL.map(() => 0)], wlTier = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
const goldLead: Record<number, number[]> = { 10: [], 14: [], 20: [], 25: [], 30: [] };
// lane turrets (outer / inner) by whether the side that took them was ahead in gold: how many of each side stood near
const fall = { ahead: { n: 0, att: 0, def: 0, alone: 0, noDef: 0 }, behind: { n: 0, att: 0, def: 0, alone: 0, noDef: 0 } };
let laneDmgDone = false;
// how many minions one side has in one lane, sampled once a second: waves that pile up or vanish would show here
const stack = [0, 0, 0, 0, 0];
let stackN = 0, emptyLane = 0;
let worst = { n: 0, at: "" };
const csAt: Record<string, number[]> = {};

for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
  let lines = 0;
  if (g === LOG && ENGINE_FLAGS.minions) {
    console.log(`--- game ${g}: ${e.names[0]} (blue) vs ${e.names[1]} (red), turret target changes ---`);
    Turrets.setLog(e, (ev) => {
      if (lines++ >= LOGMAX) return;
      const t = e.turrets[ev.turret];
      const nm = `${t.side ? "레드" : "블루"} ${t.lane === "nexus" ? "쌍둥이" : `${t.lane} ${t.tier}차`}`;
      const who = (i: number) => `${e.units[i].name}(${e.units[i].champ.name})`;
      const what = ev.target === "minion" ? KO[ev.kind!] : who(ev.champ!);
      const why = ev.why === "help" ? `아군 ${who(ev.victim!)} 공격 → 전환` : ev.why === "nowave" ? "사거리 안 미니언 없음" : "우선순위(가장 가까운 상위 등급)";
      console.log(`  ${clock(ev.t).padStart(5)}  ${nm} 포탑 → ${what}  [${why}]`);
    });
  }
  const alive = e.turrets.map(() => true), pl = e.turrets.map((t) => t.plates);
  const fp = e.turrets.map(() => -1);
  const when = new Map<string, number>();
  const seen = new Set<number>();
  let firstDone = false;
  const lost = [0, 0];
  let nextCs = 0;
  const marks = [300, 600, 900, 1200, 1500];
  const taken: { t: number; tier: number; by: number }[] = [];
  const goldAt: Record<number, number> = {};
  laneDmgDone = false;
  while (!e.over && e.t < 3600) {
    e.step();
    if (ENGINE_FLAGS.minions && e.t > 90 && Math.round(e.t * 4) % 4 === 0) {
      const n: Record<string, number> = {};
      for (const m of Minions.list(e)) n[`${m.lane}:${m.side}`] = (n[`${m.lane}:${m.side}`] ?? 0) + 1;
      for (const lane of LANES) {
        for (const sd of [0, 1]) {
          const k = n[`${lane}:${sd}`] ?? 0;
          stack[k === 0 ? 0 : k <= 7 ? 1 : k <= 14 ? 2 : k <= 21 ? 3 : 4]++;
          stackN++;
          if (k > worst.n) worst = { n: k, at: `game ${g} ${clock(e.t)} ${lane} ${sd ? "red" : "blue"}, front ${e.lanes[lane].front.toFixed(2)}` };
        }
        if (!(n[`${lane}:0`] ?? 0) && !(n[`${lane}:1`] ?? 0)) emptyLane++;
      }
    }
    if (!laneDmgDone && e.t >= 840 && ENGINE_FLAGS.minions) {
      laneDmgDone = true;
      for (const [k, v] of Object.entries(Turrets.stats(e).dmg)) laneDmg[k] = (laneDmg[k] ?? 0) + v;
    }
    e.turrets.forEach((t, i) => {
      if (t.plates < pl[i]) {
        const n = pl[i] - t.plates;
        pl[i] = t.plates;
        plates += n;
        if (fp[i] < 0) { fp[i] = e.t; if (t.tier === 1) firstPlate.push(e.t / 60); }
        PMIN.forEach((m, k) => { if (e.t < m * 60) platesBy[k] += n; });
      }
      if (alive[i] && !t.alive) {
        alive[i] = false;
        towers++;
        lost[t.side]++;
        taken.push({ t: e.t, tier: t.tier, by: 1 - t.side });
        if (t.tier <= 2) {
          const by = 1 - t.side;
          const lead = e.gold(by as 0 | 1) - e.gold(t.side);
          const att = e.units.filter((u) => u.alive && u.side === by && Math.hypot(u.x - t.pos.x, u.y - t.pos.y) < 1500).length;
          const def = e.units.filter((u) => u.alive && u.side === t.side && Math.hypot(u.x - t.pos.x, u.y - t.pos.y) < 2000).length;
          const b = lead >= 0 ? fall.ahead : fall.behind;
          b.n++; b.att += att; b.def += def;
          if (att <= 1) b.alone++;
          if (def === 0) b.noDef++;
        }
        MIN.forEach((m, k) => { if (e.t < m * 60) downBy[k]++; });
        allTier[t.tier].push(e.t / 60);
        if (!seen.has(t.tier)) { seen.add(t.tier); firstTier[t.tier].push(e.t / 60); }
        if (fp[i] >= 0 && t.tier === 1) plateToKill.push((e.t - fp[i]) / 60);
        if (t.tier === 1) {
          outerLane[t.lane].push(e.t / 60);
          if (!firstDone) { firstDone = true; firstLane[t.lane]++; }
        }
        if (t.tier <= 3) {
          when.set(`${t.side}:${t.lane}:${t.tier}`, e.t);
          const prev = when.get(`${t.side}:${t.lane}:${t.tier - 1}`);
          if (prev !== undefined) (t.tier === 2 ? gapOI : gapIB).push((e.t - prev) / 60);
        }
      } else if (!alive[i] && t.alive) alive[i] = true; // a nexus turret came back
    });
    if (e.laningPhase() && e.t > 120 && Math.round(e.t * 4) % 4 === 0) {
      for (const lane of LANES) {
        const f = e.lanes[lane].front;
        frontDev += Math.abs(f - 0.5);
        frontN++;
        const tb = e.frontierTurret(0, lane), tr = e.frontierTurret(1, lane);
        if ((tb && e.waveAt(tb)) || (tr && e.waveAt(tr))) crashed++;
        if (ENGINE_FLAGS.minions) {
          let b = false, r = false;
          for (const m of Minions.list(e)) if (m.lane === lane && Math.abs(m.u - f) < 0.04) { if (m.side === 0) b = true; else r = true; }
          if (b && r) clash++;
        }
      }
    }
    for (const m of [10, 14, 20, 25, 30]) if (goldAt[m] === undefined && e.t >= m * 60) goldAt[m] = e.gold(0) - e.gold(1);
    if (nextCs < marks.length && e.t >= marks[nextCs]) {
      for (const u of e.units) (csAt[`${marks[nextCs] / 60}:${u.role}`] ??= []).push(u.cs);
      nextCs++;
    }
  }
  len += e.t;
  kills += e.kills[0] + e.kills[1];
  inhibs += e.events.filter((x) => x.type === "inhib").length;
  minionKills += e.events.filter((x) => (x.type === "kill" || x.type === "first_blood") && x.text.includes("미니언 →")).length;
  if (e.winner !== null) {
    winnerT += lost[1 - e.winner]; loserT += lost[e.winner];
    for (const x of taken) {
      const k = x.by === e.winner ? 0 : 1;
      WL.forEach((m, i) => { if (x.t < m * 60) wlBy[k][i]++; });
      wlTier[k][x.tier]++;
    }
    for (const [m, v] of Object.entries(goldAt)) goldLead[Number(m)].push(e.winner === 0 ? v : -v);
  }
  if (ENGINE_FLAGS.minions) {
    const ms = Minions.stats(e), ts = Turrets.stats(e);
    for (const ph of [0, 1]) for (const [k, v] of Object.entries(ms.deaths[ph])) causes[ph][k] = (causes[ph][k] ?? 0) + v;
    for (const k of Object.keys(M) as (keyof typeof M)[]) M[k] = k === "maxAlive" || k === "maxLane" ? Math.max(M[k], ms[k]) : M[k] + ms[k];
    for (const [k, v] of Object.entries(ts.shots)) T.shots[k] = (T.shots[k] ?? 0) + v;
    for (const [k, v] of Object.entries(ts.dmg)) T.dmg[k] = (T.dmg[k] ?? 0) + v;
    T.help += ts.champWhy.help; T.nowave += ts.champWhy.nowave; T.champKills += ts.champKills; T.backdoor += ts.backdoor; T.respawns += ts.respawns;
    for (const dn of ts.down) { lastAny++; if (dn.champ) lastChamp++; }
  }
}

const f = (x: number, k = 2) => (x / N).toFixed(k);
console.log(`games ${N}, roster seed ${rosterSeed}, minions ${ENGINE_FLAGS.minions ? "on" : "off"} | length ${(len / N / 60).toFixed(1)} min, kills ${f(kills, 1)}`);
if (ENGINE_FLAGS.minions) {
  for (const [ph, name] of [[0, "laning (to 14:00)"], [1, "after 14:00"]] as const) {
    const tot = Object.values(causes[ph]).reduce((x, y) => x + y, 0) || 1;
    console.log(`minion deaths ${name}: ${f(tot, 0)} a game | ` + ["lasthit", "clear", "skill", "minion", "turret"].map((k) => `${k} ${((causes[ph][k] ?? 0) / tot * 100).toFixed(1)}%`).join(", "));
  }
  const died = Object.values(causes[0]).reduce((x, y) => x + y, 0) + Object.values(causes[1]).reduce((x, y) => x + y, 0);
  console.log(`minions spawned ${f(M.spawned, 0)} a game, died ${f(died, 0)}, alive at the end ${f(M.spawned - died, 0)} | paid to a champion (CS) ${(M.credited / died * 100).toFixed(1)}% | last hits missed ${f(M.missed, 0)} a game`);
  const lan = Object.values(causes[0]).reduce((x, y) => x + y, 0) || 1;
  console.log(`laning deaths that paid nobody: ${((M.unpaidNear + M.unpaidFar) / lan * 100).toFixed(1)}% (a farmer of the other side in reach ${(M.unpaidNear / lan * 100).toFixed(1)}%, none there ${(M.unpaidFar / lan * 100).toFixed(1)}%)`);
  console.log(`minions alive at once: mean ${(M.aliveSum / M.steps).toFixed(1)}, most ${M.maxAlive}; most of one side in one lane ${M.maxLane}`);
  console.log(`minions of one side in one lane, share of the time: none ${(stack[0] / stackN * 100).toFixed(1)}%, 1-7 ${(stack[1] / stackN * 100).toFixed(1)}%, 8-14 ${(stack[2] / stackN * 100).toFixed(1)}%, 15-21 ${(stack[3] / stackN * 100).toFixed(1)}%, 22+ ${(stack[4] / stackN * 100).toFixed(2)}% | a lane with no minions at all ${(emptyLane / (stackN / 2) * 100).toFixed(2)}% | most: ${worst.n} (${worst.at})`);
  console.log(`minion damage a game: to champions ${f(M.toChamps, 0)}, to structures ${f(M.toStructs, 0)}; champions killed by minions ${f(minionKills)}`);
  const shots = Object.values(T.shots).reduce((x, y) => x + y, 0) || 1;
  console.log(`turret shots a game ${f(shots, 0)}: ` + Object.entries(T.shots).map(([k, v]) => `${k} ${(v / shots * 100).toFixed(1)}%`).join(", "));
  console.log(`shots at champions a game ${f(T.shots.champ ?? 0, 1)}: called for help (the champion hit one of the turret's) ${f(T.help, 1)}, no minions in range ${f(T.nowave, 1)} | champions killed by a turret shot ${f(T.champKills)}`);
  const dm = Object.values(T.dmg).reduce((x, y) => x + y, 0) || 1;
  console.log(`turret damage taken a game ${f(dm, 0)}: ` + Object.entries(T.dmg).map(([k, v]) => `${k} ${(v / dm * 100).toFixed(0)}%`).join(", ") + ` | taken off by backdoor protection ${f(T.backdoor, 0)} | nexus turrets back ${f(T.respawns)}`);
  console.log(`turret damage taken by 14:00 a game ${f(Object.values(laneDmg).reduce((x, y) => x + y, 0), 0)}: ` + Object.entries(laneDmg).map(([k, v]) => `${k} ${f(v, 0)}`).join(", "));
  console.log(`turret last hit: champion ${(lastChamp / (lastAny || 1) * 100).toFixed(0)}%`);
}
console.log(`champion deaths to a turret or minion blow ${f(turretBlows)} a game (${f(execs)} with no champion to credit)`);
console.log(`laning fronts: mean distance from the middle ${(frontDev / (frontN || 1)).toFixed(3)} of the lane, a wave on a turret ${(crashed / (frontN || 1) * 100).toFixed(1)}% of lane-seconds, both waves fighting at the front ${(clash / (frontN || 1) * 100).toFixed(1)}%`);
console.log("CS (engine): " + [5, 10, 15, 20, 25].map((m) => `${m}min ` + ["Top", "Jungle", "Mid", "Bot", "Support"].map((r) => { const v = csAt[`${m}:${r}`] ?? []; return (v.reduce((x, y) => x + y, 0) / (v.length || 1)).toFixed(0); }).join("/")).join("  "));
console.log("CS (LCK 2026): 5min 40/37/42/40/5  10min 90/77/96/91/14  15min 139/116/149/145/21  20min 188/154/201/204/26  25min 230/186/244/259/29");
console.log(`turrets destroyed per game ${f(towers)} (winner takes ${f(winnerT)}, loser takes ${f(loserT)})   [LCK 11.60, 9.00 / 2.60]`);
console.log("taken by the eventual winner by minute: " + WL.map((m, i) => `${m}:${f(wlBy[0][i])}`).join(" ") + ` | by tier ${wlTier[0].slice(1).map((v) => f(v)).join("/")}`);
console.log("                              LCK 2026: 14:0.18 16:0.53 18:1.31 20:2.07 22:2.74 25:3.93 28:5.45 30:6.42 99:9.00 | by tier 2.99/2.41/1.56/2.04");
console.log("taken by the eventual loser  by minute: " + WL.map((m, i) => `${m}:${f(wlBy[1][i])}`).join(" ") + ` | by tier ${wlTier[1].slice(1).map((v) => f(v)).join("/")}`);
console.log("                              LCK 2026: 14:0.10 16:0.26 18:0.64 20:1.04 22:1.33 25:1.67 28:1.99 30:2.11 99:2.60 | by tier 1.97/0.49/0.11/0.03");
console.log("winner's gold lead (median): " + Object.entries(goldLead).map(([m, v]) => `${m}min ${Math.round(qt(v, 0.5))}`).join("  ") + "   [LCK 10min 531  14min 936  20min 2341  25min 3847  30min 5360]");
for (const [k, b] of Object.entries(fall)) console.log(`outer / inner turrets taken by the side ${k} in gold: ${f(b.n)} a game | attackers near ${(b.att / (b.n || 1)).toFixed(2)}, defenders near ${(b.def / (b.n || 1)).toFixed(2)} | at most one attacker ${(b.alone / (b.n || 1) * 100).toFixed(0)}%, no defender ${(b.noDef / (b.n || 1) * 100).toFixed(0)}%`);
console.log("turrets down by minute: " + MIN.map((m, k) => `${m}:${f(downBy[k])}`).join(" "));
console.log("              LCK 2026: 10:0.01 12:0.08 14:0.27 16:0.79 18:1.95 20:3.11 22:4.06 25:5.60 28:7.44 30:8.52 35:10.43");
const LCK_T = ["", "4.96 | first 15.8 (12.7-18.4) | all 19.2", "2.89 | first 24.5 (18.8-30.5) | all 26.8", "1.68 | first 29.1 (23.6-35.6) | all 29.8", "2.08 | first 30.9 (25.5-38.1) | all 31.2"];
for (const tier of [1, 2, 3, 4]) {
  const fb = firstTier[tier], al = allTier[tier];
  console.log(`${TIER[tier]}: per game ${f(al.length)} | first of the game median ${qt(fb, 0.5).toFixed(1)} min (P10 ${qt(fb, 0.1).toFixed(1)}, P90 ${qt(fb, 0.9).toFixed(1)}, in ${(fb.length / N * 100).toFixed(0)}% of games) | all: median ${qt(al, 0.5).toFixed(1)}   [LCK ${LCK_T[tier]}]`);
}
console.log("outer turret by lane (median min / per game): " + LANES.map((l) => `${l}:${qt(outerLane[l], 0.5).toFixed(1)}/${f(outerLane[l].length)}`).join(" ") + "   [LCK top:19.3/1.74 mid:20.0/1.54 bot:18.5/1.68]");
console.log("lane of the game's first turret: " + LANES.map((l) => `${l}:${(firstLane[l] / N * 100).toFixed(0)}%`).join(" ") + "   [LCK top:35% mid:20% bot:46%]");
console.log(`same lane: outer -> inner median ${qt(gapOI, 0.5).toFixed(1)} min, inner -> inhibitor turret ${qt(gapIB, 0.5).toFixed(1)}   [LCK 7.2, 2.0]`);
console.log(`inhibitors per game ${f(inhibs)}   [LCK 1.63]`);
console.log(`turret plates per game ${f(plates)}; taken before minute: ` + PMIN.map((m, k) => `${m}:${f(platesBy[k])}`).join(" "));
console.log("                                    LCK 2026 54.32: 5:0.91 8:2.85 10:4.81 12:7.15 14:10.39 16:14.64 20:25.07 25:35.34 30:45.83 99:54.32");
console.log(`first plate of an outer turret: median ${qt(firstPlate, 0.5).toFixed(1)} min; first plate -> that turret's fall: median ${qt(plateToKill, 0.5).toFixed(1)} min   [LCK 8.8, 10.4]`);
