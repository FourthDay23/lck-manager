// Teamfight module check: a sample 5v5 fight log, per-game fight stats, spacing in 6+ champion fights, and kill clusters
// against the 2026 LCK benchmarks (src/match/lck-stats.gen.ts).
// Run (Git Bash): FLAGS=fight GAMES=8 MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/fight-test.ts
//   FLAGS=          old combat (before), for the spacing / cluster comparison
//   FLAGS=nav,macro,fight  everything on
//   LOG=0           no sample log; LOGGAME=n picks the game the sample comes from; LOGMIN=m earliest minute (default 15)
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine, ENGINE_FLAGS } from "../src/match/engine";
import type { Unit } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import * as Fight from "../src/match/fight";
import { LCK_STATS } from "../src/match/lck-stats.gen";

const root = "public";
const dir = "data";
const j = (f: string) => (existsSync(`${root}/${dir}/${f}`) ? JSON.parse(readFileSync(`${root}/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
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

const GAMES = Number(process.env.GAMES ?? 8);
const flags = (process.env.FLAGS ?? "fight").split(",").map((x) => x.trim()).filter(Boolean);
for (const k of Object.keys(ENGINE_FLAGS)) (ENGINE_FLAGS as Record<string, boolean>)[k] = false; // only the listed modules
for (const f of flags) (ENGINE_FLAGS as Record<string, boolean>)[f] = true;
const LOG = process.env.LOG !== "0";
const LOGGAME = Number(process.env.LOGGAME ?? 0);
const LOGMIN = Number(process.env.LOGMIN ?? 15);
console.log("flags", JSON.stringify(ENGINE_FLAGS));

const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const add = (r: Record<string, number>, k: string, v = 1) => (r[k] = (r[k] ?? 0) + v);

// ---- aggregates
let minutes = 0, kills = 0;
const agg: Record<string, number> = {};
const opened: Record<string, number> = {}, openedSmall: Record<string, number> = {}, casts: Record<string, number> = {}, bySize: Record<string, number> = {}, soloBy: Record<string, number> = {}, ends: Record<string, number> = {}, starts: Record<string, number> = {};
const posTime: number[] = [], durations: number[] = [];
const modSpace = { mates: [] as number[], rangedTarget: [] as number[], backFront: [] as number[], enchCarry: [] as number[] };
// spacing measured from the outside (works for the old combat too)
const space = { mates: [] as number[], rangedNearest: [] as number[], fromCenter: [] as number[], piled: 0, sampled: 0 };
// kill clusters (LCK definition): chain of kills <= 15 s after the last one, <= 2,500 u from any kill in the chain
interface K { t: number; x: number; y: number; victim: number; killer: number; assists: number[]; side: number }
interface Cluster { kills: K[]; last: number }
const clusters: { first: number; n: number; parts: number; both: boolean }[] = [];
const killMin: number[] = new Array(60).fill(0), runMin: number[] = new Array(60).fill(0);
let soloKills = 0, allKills = 0;
const joinSpread: number[] = [];
let sampleDone = false;
let sample: { id: number; g: number; n: number; lines: string[] } | null = null;
const soloWhy: Record<string, number> = {};

for (let g = 0; g < GAMES; g++) {
  const seed = 2000 + g * 37;
  const a = s.lck[g % 10], b = s.lck[(g + 3) % 10];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, new Rng(seed));
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed });
  // sample log: lines grouped per fight; print the first fight with 8+ members after LOGMIN
  const lines = new Map<number, string[]>();
  if (ENGINE_FLAGS.fight && LOG && g === LOGGAME) Fight.setLog(e, (line, fid) => {
    if (!fid) return;
    const arr = lines.get(fid) ?? [];
    arr.push(line);
    lines.set(fid, arr);
  });
  const prevK = e.units.map((u) => u.k), prevD = e.units.map((u) => u.d), prevA = e.units.map((u) => u.a);
  const open: Cluster[] = [];
  const closeCluster = (c: Cluster) => {
    const parts = new Set<number>();
    for (const k of c.kills) {
      parts.add(k.victim);
      if (k.killer >= 0) parts.add(k.killer);
      for (const x of k.assists) parts.add(x);
    }
    clusters.push({ first: c.kills[0].t, n: c.kills.length, parts: parts.size, both: new Set(c.kills.map((k) => k.side)).size > 1 });
  };
  const fightJoin = new Map<number, number[]>();
  const seen = new Map<number, Set<number>>();
  let lastFights = new Set<number>();
  while (!e.over && e.t < 3600) {
    e.step();
    const m = Math.floor(e.t / 60);
    if (Math.abs(e.t - m * 60) < 1e-6 && m < 60) runMin[m]++;
    // kills this step: deaths, with killers and assisters from the stat counters
    const victims: Unit[] = [], killers: Unit[] = [], assisters: Unit[] = [];
    for (const u of e.units) {
      if (u.d > prevD[u.i]) victims.push(u);
      if (u.k > prevK[u.i]) killers.push(u);
      if (u.a > prevA[u.i]) assisters.push(u);
      prevK[u.i] = u.k; prevD[u.i] = u.d; prevA[u.i] = u.a;
    }
    for (const v of victims) {
      const killer = killers.find((x) => x.side !== v.side);
      const k: K = { t: e.t, x: v.x, y: v.y, victim: v.i, killer: killer ? killer.i : -1, assists: assisters.filter((x) => x.side !== v.side).map((x) => x.i), side: 1 - v.side };
      allKills++;
      if (killer && !k.assists.length) soloKills++;
      if (m < 60) killMin[m]++;
      let c = open.find((c2) => e.t - c2.last <= 15 && c2.kills.some((x) => Math.hypot(x.x - k.x, x.y - k.y) <= 2500));
      if (!c) { c = { kills: [], last: e.t }; open.push(c); }
      c.kills.push(k);
      c.last = e.t;
    }
    for (let i = open.length - 1; i >= 0; i--) if (e.t - open[i].last > 15) { closeCluster(open[i]); open.splice(i, 1); }
    // join spread (same as engine-diag)
    for (const u of e.units) if (u.fightId) {
      const sn = seen.get(u.fightId) ?? new Set<number>();
      if (!sn.has(u.i)) {
        sn.add(u.i);
        seen.set(u.fightId, sn);
        const arr = fightJoin.get(u.fightId) ?? [];
        arr.push(e.t);
        fightJoin.set(u.fightId, arr);
      }
    }
    const now = new Set(e.fights.keys());
    for (const id of lastFights) if (!now.has(id)) {
      const arr = fightJoin.get(id) ?? [];
      if (arr.length >= 6) joinSpread.push(Math.max(...arr) - Math.min(...arr));
      if (lines.has(id)) {
        // keep the busiest 8+ champion fight after LOGMIN as the sample
        const ls = lines.get(id)!;
        if (arr.length >= 8 && Math.min(...arr) >= LOGMIN * 60 && (!sample || ls.length > sample.lines.length)) sample = { id, g, n: arr.length, lines: ls };
        lines.delete(id);
      }
    }
    lastFights = now;
    // spacing in fights with 6+ live members, once a second
    if (Math.abs(e.t - Math.round(e.t)) < 1e-6) {
      for (const [id, f] of e.fights) {
        const mem = e.units.filter((u) => u.alive && u.fightId === id);
        if (mem.length < 6 || e.t - f.start < 2) continue;
        const sides = [mem.filter((u) => u.side === 0), mem.filter((u) => u.side === 1)];
        if (sides[0].length < 2 || sides[1].length < 2) continue;
        const cx = mem.reduce((a2, u) => a2 + u.x, 0) / mem.length, cy = mem.reduce((a2, u) => a2 + u.y, 0) / mem.length;
        for (const sd of [0, 1]) {
          const l = sides[sd];
          const ds: number[] = [];
          for (let i = 0; i < l.length; i++) for (let k2 = i + 1; k2 < l.length; k2++) ds.push(Math.hypot(l[i].x - l[k2].x, l[i].y - l[k2].y));
          space.mates.push(med(ds));
          for (const u of l) {
            space.fromCenter.push(Math.hypot(u.x - cx, u.y - cy));
            if (u.champ.ranged) space.rangedNearest.push(Math.min(...sides[1 - sd].map((o) => Math.hypot(o.x - u.x, o.y - u.y))));
          }
        }
        for (const u of mem) {
          space.sampled++;
          const near = Math.min(...mem.filter((o) => o !== u).map((o) => Math.hypot(o.x - u.x, o.y - u.y)));
          if (near < 100) space.piled++;
        }
      }
    }
  }
  for (const c of open) closeCluster(c);
  if (sample && !sampleDone) {
    sampleDone = true;
    console.log(`\n===== sample fight #${sample.id} (game ${sample.g}, ${sample.n} champions) =====`);
    for (const l of sample.lines.slice(0, 160)) console.log(l);
    if (sample.lines.length > 160) console.log(`  ... ${sample.lines.length - 160} more lines`);
  }
  minutes += e.t / 60;
  kills += e.kills[0] + e.kills[1];
  if (ENGINE_FLAGS.fight) {
    const st = Fight.stats(e);
    for (const k of ["fights", "trades", "allins", "teamfights", "cc", "ccChains", "ccOverlaps", "ults", "ultAoe", "ultMulti", "hits", "misses", "kills", "flashes", "escapes", "retreats"] as const) add(agg, k, st[k]);
    for (const [k, v] of Object.entries(st.opened)) add(opened, k, v);
    for (const [k, v] of Object.entries(st.openedSmall)) add(openedSmall, k, v);
    for (const [k, v] of Object.entries(st.casts)) add(casts, k, v);
    for (const [k, v] of Object.entries(st.killsBySize)) add(bySize, k, v);
    for (const [k, v] of Object.entries(st.soloBySize)) add(soloBy, k, v);
    for (const [k, v] of Object.entries(st.soloWhy)) add(soloWhy, k, v);
    for (const [k, v] of Object.entries(st.ends)) add(ends, k, v);
    for (const [k, v] of Object.entries(st.starts)) add(starts, k, v);
    posTime.push(...st.posTime);
    durations.push(...st.durations);
    modSpace.mates.push(...st.spaceMates);
    modSpace.rangedTarget.push(...st.spaceRangedToTarget);
    modSpace.backFront.push(...st.spaceBackToFront);
    modSpace.enchCarry.push(...st.spaceEnchToCarry);
  }
  console.log(`game ${g}: ${(e.t / 60).toFixed(1)} min, kills ${e.kills[0]}-${e.kills[1]}, winner ${e.winner === 0 ? "blue" : "red"}`);
}

console.log(`\n===== ${GAMES} games =====`);
console.log(`avg length ${(minutes / GAMES).toFixed(1)} min, kills/game ${(kills / GAMES).toFixed(1)}, median join spread (6+ fights) ${med(joinSpread).toFixed(1)}s over ${joinSpread.length} fights`);
if (ENGINE_FLAGS.fight) {
  const G = GAMES;
  console.log(`fights/game ${(agg.fights / G).toFixed(1)} (trades ${(agg.trades / G).toFixed(1)}, lane all-ins ${(agg.allins / G).toFixed(1)}), 6+ member fights/game ${(agg.teamfights / G).toFixed(1)}`);
  const tf = agg.teamfights || 1;
  console.log(`6+ fights opened by: ${Object.entries(opened).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pct(v, tf)}`).join(", ")}`);
  console.log(`  -> % opened by an engage spell: ${pct(opened.engage ?? 0, tf)}; median set-up time before the brawl ${med(posTime).toFixed(1)}s`);
  const sm = Object.values(openedSmall).reduce((x, y) => x + y, 0);
  console.log(`smaller skirmishes opened by: ${Object.entries(openedSmall).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pct(v, sm)}`).join(", ")}`);
  console.log(`CC applied ${(agg.cc / G).toFixed(1)}/game, chains ${(agg.ccChains / G).toFixed(1)}/game (${pct(agg.ccChains, agg.cc)}), overlaps ${pct(agg.ccOverlaps, agg.cc)}`);
  console.log(`ults cast ${(agg.ults / G).toFixed(1)}/game, ults hitting >= 2: ${(agg.ultMulti / G).toFixed(1)}/game (${pct(agg.ultMulti, agg.ults)} of ults, ${pct(agg.ultMulti, agg.ultAoe)} of AoE ults aimed at 2+)`);
  console.log(`spell hit rate ${pct(agg.hits, agg.hits + agg.misses)} (hits per cast incl. AoE extras), flashes ${(agg.flashes / G).toFixed(1)}/game, escape dashes ${(agg.escapes / G).toFixed(1)}/game, side retreats ${(agg.retreats / G).toFixed(1)}/game`);
  console.log(`casts by use: ${Object.entries(casts).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${(v / G).toFixed(0)}`).join(", ")}`);
  console.log(`kills by fight size (members): ${["2", "3-4", "5-7", "8-10", "none"].map((k) => `${k}: ${((bySize[k] ?? 0) / G).toFixed(1)} (${pct(soloBy[k] ?? 0, bySize[k] ?? 0)} solo)`).join(", ")} per game`);
  console.log(`  solo kills in 5+ fights by cause: ${Object.entries(soloWhy).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`skirmish starts: ${Object.entries(starts).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`fight ends: ${Object.entries(ends).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ")}; median fight length ${med(durations).toFixed(1)}s`);
  console.log(`spacing (module, 6+ fights while brawling): teammate median ${med(modSpace.mates).toFixed(0)}u, ranged→own target ${med(modSpace.rangedTarget).toFixed(0)}u, backline→nearest own front ${med(modSpace.backFront).toFixed(0)}u, enchanter→carry ${med(modSpace.enchCarry).toFixed(0)}u`);
}
console.log(`spacing (all 6+ fights, measured outside): teammate pair median ${med(space.mates).toFixed(0)}u, ranged→nearest enemy ${med(space.rangedNearest).toFixed(0)}u, champion→fight centre ${med(space.fromCenter).toFixed(0)}u, stacked (<100u from another champion) ${pct(space.piled, space.sampled)}`);

// ---- LCK comparison
const L = LCK_STATS.fights;
const phaseOf = (t: number) => (t < 14 * 60 ? "early" : t < 25 * 60 ? "mid" : "late");
const byPh: Record<string, { n: number; kills: number; parts: number; both: number }> = { early: { n: 0, kills: 0, parts: 0, both: 0 }, mid: { n: 0, kills: 0, parts: 0, both: 0 }, late: { n: 0, kills: 0, parts: 0, both: 0 } };
for (const c of clusters) {
  const p = byPh[phaseOf(c.first)];
  p.n++; p.kills += c.n; p.parts += c.parts; if (c.both) p.both++;
}
const six = clusters.filter((c) => c.parts >= 6).length;
console.log(`\n===== kill clusters vs LCK 2026 (<=15 s, <=2,500 u) =====`);
console.log(`clusters/game ${(clusters.length / GAMES).toFixed(1)} (LCK ${(L.byPhase.early.perGame + L.byPhase.mid.perGame + L.byPhase.late.perGame).toFixed(1)}), kills/cluster ${(clusters.reduce((a2, c) => a2 + c.n, 0) / Math.max(1, clusters.length)).toFixed(2)} (LCK 1.97), 6+ participants ${pct(six, clusters.length)} (LCK 38.5%)`);
const tgt: Record<string, { size: number; kpf: number; both: number }> = { early: { size: L.byPhase.early.avgSize, kpf: 1.47, both: 17 }, mid: { size: L.byPhase.mid.avgSize, kpf: 1.98, both: 24 }, late: { size: L.byPhase.late.avgSize, kpf: 2.46, both: 30 } };
for (const ph of ["early", "mid", "late"]) {
  const p = byPh[ph];
  const lp = L.byPhase[ph as "early"];
  console.log(`  ${ph.padEnd(5)} clusters/game ${(p.n / GAMES).toFixed(1)} (LCK ${lp.perGame.toFixed(1)}), participants ${(p.parts / Math.max(1, p.n)).toFixed(1)} (LCK ${tgt[ph].size.toFixed(1)}), kills/cluster ${(p.kills / Math.max(1, p.n)).toFixed(2)} (LCK ${tgt[ph].kpf}), both sides scored ${pct(p.both, p.n)} (LCK ${tgt[ph].both}%)`);
}
console.log(`solo kills ${pct(soloKills, allKills)} (LCK ${(L.soloKillShare * 100).toFixed(1)}%)`);
const kpm = (a2: number, b2: number) => {
  let k = 0, r = 0;
  for (let m = a2; m <= b2; m++) { k += killMin[m] ?? 0; r += runMin[m] ?? 0; }
  return r ? k / r : NaN;
};
const lk = (a2: number, b2: number) => {
  let k = 0, n = 0;
  for (let m = a2; m <= Math.min(b2, L.killsPerMin.length - 1); m++) { k += L.killsPerMin[m]; n++; }
  return n ? k / n : NaN;
};
console.log(`kills/min: ${[[3, 7], [8, 13], [14, 21], [22, 30], [31, 44]].map(([x, y]) => `${x}-${y}m ${kpm(x, y).toFixed(2)} (LCK ${lk(x, y).toFixed(2)})`).join(", ")}`);
