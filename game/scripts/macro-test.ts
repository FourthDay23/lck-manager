// Macro checks against the 2026 LCK benchmarks (lck-stats.gen.ts).
// Run (Git Bash): FLAGS=macro GAMES=12 STRATS=all MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/macro-test.ts
//   STRATS=all          every strategy plays GAMES games against "balanced" (sides alternate)
//   STRATS=split,teamfight  blue,red for every game;  unset: AI default picks
// Prints per strategy: team shape in minutes 20-35 (LCK filter: all 5 alive, none within 1,600 u of the own fountain),
// side-laner / grouped shares, objective takers at the pit vs LCK participant shares, solo takes by role, first takes,
// lone-hitter ticks, kills, game length, plan / abort counts.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine, ENGINE_FLAGS } from "../src/match/engine";
import type { ObjKey } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { FOUNTAIN } from "../src/match/map";
import { LCK_STATS } from "../src/match/lck-stats.gen";
import { STRATEGIES } from "../src/match/strategy";
import type { Strategy } from "../src/match/strategy";
import { st } from "../src/match/macro";

const root = "public", dir = "data";
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
for (const k of Object.keys(ENGINE_FLAGS)) (ENGINE_FLAGS as Record<string, boolean>)[k] = false; // only the listed modules
for (const f of (process.env.FLAGS ?? "macro").split(",").map((x) => x.trim()).filter(Boolean)) (ENGINE_FLAGS as Record<string, boolean>)[f] = true;
const GAMES = Number(process.env.GAMES ?? 12);
const STRATS = process.env.STRATS;
console.log("flags", JSON.stringify(ENGINE_FLAGS), "games/strategy", GAMES, "STRATS", STRATS ?? "(AI default)");

interface Acc {
  games: number; minutes: number; kills: number; wins: number;
  far: number[]; med: number[]; side: number; grouped: number; frames: number;
  byMin: Record<number, { far: number[]; med: number[]; side: number; grouped: number; n: number }>;
  takers: Record<string, number[]>; soloRole: Record<string, number>; first: Record<string, number[]>;
  objTicks: number; lone: number; loneJg: number;
  bigFights: number; spread: number[]; fights: number; fightSizes: number[];
  plans: Record<string, number>; aborts: Record<string, number>; earlyKills: number;
}
const mk = (): Acc => ({
  games: 0, minutes: 0, kills: 0, wins: 0, far: [], med: [], side: 0, grouped: 0, frames: 0, byMin: {}, takers: {}, soloRole: {}, first: {},
  objTicks: 0, lone: 0, loneJg: 0, bigFights: 0, spread: [], fights: 0, fightSizes: [], plans: {}, aborts: {}, earlyKills: 0,
});
const acc: Record<string, Acc> = {};
const killOrigin: Record<string, number> = {};
const earlyOrigin: Record<string, number> = {};
const fightCtx: Record<string, number> = {};
const killsByMin = new Array(45).fill(0);
let allGames = 0, allMin = 0;
const A = (k: string) => (acc[k] ??= mk());

function play(g: number, strat: [Strategy | null, Strategy | null], labels: [string, string]) {
  const seed = 5000 + g * 41;
  const a = s.lck[g % 10], b = s.lck[(g + 3) % 10];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, new Rng(seed));
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed, strategy: strat });
  const lab: [string, string] = [labels[0] || e.strategy[0], labels[1] || e.strategy[1]];
  const LOG = process.env.LOG !== undefined && Number(process.env.LOG) === g;
  if (LOG && st(e)) st(e)!.logOn = true;
  const objPrevHp: Record<string, number> = {}, objWasAlive: Record<string, boolean> = {};
  const firstDone: Record<string, boolean> = {};
  const fightJoin = new Map<number, number[]>();
  const seen = new Set<string>();
  let lastFights = new Set<number>();
  let early: [number, number] = [0, 0];
  while (!e.over && e.t < 3600) {
    for (const k of Object.keys(e.obj)) { objPrevHp[k] = e.obj[k as ObjKey].hp; objWasAlive[k] = e.obj[k as ObjKey].alive; }
    e.step();
    if (Math.abs(e.t - 840) < 1e-6) {
      early = [e.kills[0], e.kills[1]];
      for (const [k, v] of Object.entries(e.killOrigin)) earlyOrigin[k] = (earlyOrigin[k] ?? 0) + v;
    }
    // shape (LCK filter)
    if (e.t >= 1200 && e.t <= 2100 && Math.abs(e.t % 10) < 1e-6) {
      for (const sd of [0, 1] as const) {
        const m = e.units.filter((u) => u.side === sd);
        if (m.some((u) => !u.alive || Math.hypot(u.x - FOUNTAIN[sd].x, u.y - FOUNTAIN[sd].y) < 1600)) continue;
        const cx = m.reduce((q, u) => q + u.x, 0) / 5, cy = m.reduce((q, u) => q + u.y, 0) / 5;
        const ds = m.map((u) => Math.hypot(u.x - cx, u.y - cy)).sort((x, y) => x - y);
        let side = false;
        for (const u of m) {
          const o = m.filter((x) => x !== u);
          const ox = o.reduce((q, x) => q + x.x, 0) / 4, oy = o.reduce((q, x) => q + x.y, 0) / 4;
          if (Math.hypot(u.x - ox, u.y - oy) > 4000) side = true;
        }
        const grouped = ds[4] <= 2500;
        const X = A(lab[sd]);
        X.far.push(ds[4]); X.med.push(ds[2]); X.frames++; if (side) X.side++; if (grouped) X.grouped++;
        const mb = Math.floor(e.t / 300) * 5;
        const B = (X.byMin[mb] ??= { far: [], med: [], side: 0, grouped: 0, n: 0 });
        B.far.push(ds[4]); B.med.push(ds[2]); B.n++; if (side) B.side++; if (grouped) B.grouped++;
      }
    }
    // objectives
    for (const k of Object.keys(e.obj) as ObjKey[]) {
      const o = e.obj[k];
      if (!objWasAlive[k]) continue;
      const at = e.units.filter((u) => u.alive && !u.fightId && Math.hypot(u.x - o.pos.x, u.y - o.pos.y) < 650);
      if (!at.length) continue;
      if (o.alive && o.hp >= objPrevHp[k]) continue;
      for (const sd of [0, 1] as const) {
        const mine = at.filter((u) => u.side === sd);
        if (!mine.length) continue;
        const X = A(lab[sd]);
        X.objTicks++;
        if (mine.length === 1) { X.lone++; if (mine[0].role === "Jungle") X.loneJg++; }
      }
      const justDied = !o.alive || (k === "dragon" && o.spawnAt && o.spawnAt > e.t);
      if (justDied) {
        const ev = e.events[e.events.length - 1];
        const sd = ev && ["dragon", "baron", "grubs", "herald", "elder", "soul", "steal"].includes(ev.type) ? ev.side : null;
        if (sd !== null) {
          const n = at.filter((u) => u.side === sd).length;
          const X = A(lab[sd]);
          (X.takers[k] ??= [0, 0, 0, 0, 0, 0])[Math.min(5, n)]++;
          if (n === 1) { const r = at.find((u) => u.side === sd)!.role; X.soloRole[`${k}:${r}`] = (X.soloRole[`${k}:${r}`] ?? 0) + 1; }
          if (!firstDone[k]) { firstDone[k] = true; (X.first[k] ??= []).push(e.t); }
        }
      }
    }
    // fights: what both teams were doing when a mid-game fight started
    if (e.t > 840) for (const [id, f] of e.fights) {
      if (fightJoin.has(id) || f.start !== e.t) continue;
      const M0 = st(e);
      if (!M0) continue;
      const mem = e.units.filter((u) => u.fightId === id);
      const jobs = (sd: number) => mem.filter((u) => u.side === sd).map((u) => M0.units[u.i].job).sort().join("+") || "-";
      const pl = (sd: number) => `${M0.brains[sd].plan.kind}${M0.brains[sd].plan.kind === "take" ? ":" + M0.brains[sd].plan.phase : ""}/${M0.brains[sd].formation}`;
      const key = `${f.origin} ${[`${pl(0)} [${jobs(0)}]`, `${pl(1)} [${jobs(1)}]`].sort().join(" vs ")}`;
      fightCtx[key] = (fightCtx[key] ?? 0) + 1;
    }
    for (const u of e.units) if (u.fightId) {
      const key = `${u.i}:${u.fightId}`;
      if (!seen.has(key)) { seen.add(key); const arr = fightJoin.get(u.fightId) ?? []; arr.push(e.t); fightJoin.set(u.fightId, arr); }
    }
    const now = new Set(e.fights.keys());
    for (const id of lastFights) if (!now.has(id)) {
      const arr = fightJoin.get(id) ?? [];
      for (const l of new Set(lab)) { const X = A(l); X.fights += 0.5; X.fightSizes.push(arr.length); if (arr.length >= 6) { X.bigFights += 0.5; X.spread.push(Math.max(...arr) - Math.min(...arr)); } }
    }
    lastFights = now;
  }
  const M = st(e);
  if (LOG && M) {
    const evs = e.events.filter((x) => ["dragon", "baron", "grubs", "herald", "elder", "steal", "turret", "inhib", "first_turret", "ace"].includes(x.type))
      .map((x) => ({ t: x.t, s: `${Math.floor(x.t / 60)}:${String(Math.floor(x.t % 60)).padStart(2, "0")} ${x.side ? "R" : "B"} ** ${x.type}: ${x.text}` }));
    const lines = M.log.map((s2) => { const [mm, ss] = s2.split(" ")[0].split(":").map(Number); return { t: mm * 60 + ss, s: s2 }; });
    console.log(`--- game ${g}: ${e.strategy.join(" vs ")} winner ${e.winner} at ${(e.t / 60).toFixed(1)} min, kills ${e.kills.join("-")}`);
    for (const x of [...lines, ...evs].sort((p, q) => p.t - q.t)) console.log(x.s);
  }
  for (const sd of [0, 1] as const) {
    const X = A(lab[sd]);
    X.games++; X.minutes += e.t / 60; X.kills += e.kills[sd]; X.earlyKills += early[sd];
    if (sd === 0) for (const [k, v] of Object.entries(e.killOrigin)) killOrigin[k] = (killOrigin[k] ?? 0) + v;
    if (sd === 0) for (const ev of e.events) if (["kill", "solo", "first_blood"].includes(ev.type)) killsByMin[Math.min(44, Math.floor(ev.t / 60))]++;
    if (sd === 0) { allGames++; allMin += e.t / 60; }
    if (e.winner === sd) X.wins++;
    if (M) {
      for (const [k, v] of Object.entries(M.stats[sd].plans)) X.plans[k] = (X.plans[k] ?? 0) + v;
      for (const [k, v] of Object.entries(M.stats[sd].aborts)) X.aborts[k] = (X.aborts[k] ?? 0) + v;
      for (const [k, v] of Object.entries(M.stats[sd].formations)) X.plans["F:" + k] = (X.plans["F:" + k] ?? 0) + v;
    }
  }
}

let gi = 0;
if (STRATS === "all") {
  for (const st0 of STRATEGIES) for (let g = 0; g < GAMES; g++) {
    const blue = g % 2 === 0;
    const pair: [Strategy, Strategy] = blue ? [st0, "balanced"] : ["balanced", st0];
    const labels: [string, string] = st0 === "balanced" ? ["balanced", "balanced"] : blue ? [st0, "vs:" + st0] : ["vs:" + st0, st0];
    play(gi++, pair, labels);
  }
} else if (STRATS) {
  const pair = STRATS.split(",").map((x) => (x || null)) as [Strategy | null, Strategy | null];
  for (let g = 0; g < GAMES; g++) play(gi++, pair, ["", ""]);
} else for (let g = 0; g < GAMES; g++) play(gi++, [null, null], ["", ""]);

const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const pc = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;
const LS = LCK_STATS;
const lckBy = (m: number) => LS.shape.filter((r) => r.minute >= m && r.minute < m + 5);
console.log("\nLCK min 20-35: sideLaner 0.635 grouped 0.279 (P25-P75 side .54-.77, grouped .17-.39)");
for (const m of [20, 25, 30]) {
  const r = lckBy(m);
  console.log(`  LCK ${m}-${m + 4}: far ${med(r.map((x) => x.farthest)).toFixed(0)} med ${med(r.map((x) => x.median)).toFixed(0)} side ${(r.reduce((a, x) => a + x.sideLaner, 0) / r.length).toFixed(2)} grouped ${(r.reduce((a, x) => a + x.grouped, 0) / r.length).toFixed(2)}`);
}
const lp = (k: ObjKey) => LS.objectives[k].participants.map((x) => (x * 100).toFixed(0)).join("/");
console.log(`LCK participants 1..5: dragon ${lp("dragon")}  baron ${lp("baron")}  herald ${lp("herald")}  grubs ${lp("grubs")}  elder ${lp("elder")}`);
console.log(`LCK first take (s): dragon ${LS.objectives.dragon.firstAt} grubs ${LS.objectives.grubs.firstAt} herald ${LS.objectives.herald.firstAt} baron ${LS.objectives.baron.firstAt}`);
for (const [k, X] of Object.entries(acc).sort()) {
  console.log(`\n== ${k}: ${X.games} team-games, win ${pc(X.wins, X.games)}, len ${(X.minutes / X.games).toFixed(1)} min, kills/team-game ${(X.kills / X.games).toFixed(1)} (before 14:00 ${(X.earlyKills / X.games).toFixed(1)})`);
  console.log(`  shape 20-35 (${X.frames} frames): far ${med(X.far).toFixed(0)} med ${med(X.med).toFixed(0)} sideLaner ${(X.side / Math.max(1, X.frames)).toFixed(2)} grouped ${(X.grouped / Math.max(1, X.frames)).toFixed(2)}`);
  for (const [m, B] of Object.entries(X.byMin)) console.log(`    min ${m}: far ${med(B.far).toFixed(0)} med ${med(B.med).toFixed(0)} side ${(B.side / B.n).toFixed(2)} grouped ${(B.grouped / B.n).toFixed(2)} (n ${B.n})`);
  const tk = Object.entries(X.takers).map(([o, arr]) => { const n = arr.reduce((a, v) => a + v, 0); return `${o} ${n}: ${arr.slice(1).map((v) => pc(v, n)).join("/")}${arr[0] ? ` (0:${arr[0]})` : ""}`; });
  console.log(`  takers at pit 1..5: ${tk.join("  ")}`);
  console.log(`  solo takes: ${JSON.stringify(X.soloRole)}  lone-hitter ticks ${pc(X.lone, X.objTicks)} (jungler ${pc(X.loneJg, X.objTicks)}, non-jungle ${pc(X.lone - X.loneJg, X.objTicks)})`);
  console.log(`  first take: ${Object.entries(X.first).map(([o, v]) => `${o} ${med(v).toFixed(0)}`).join(", ")}`);
  console.log(`  fights ${(X.fights / X.games * 2).toFixed(1)}/game, size>=6 ${(X.bigFights / X.games * 2).toFixed(1)}/game, join spread ${med(X.spread).toFixed(1)}s`);
  const top = (o: Record<string, number>) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([a, v]) => `${a} ${(v / X.games).toFixed(1)}`).join(", ");
  console.log(`  plans/game: ${top(X.plans)}`);
  console.log(`  aborts/game: ${top(X.aborts)}`);
}
const kpmL = LS.fights.killsPerMin;
const bucket = (arr: number[], a: number, b: number) => arr.slice(a, b).reduce((x, y) => x + y, 0);
console.log("");
console.log(`all: ${allGames} games, ${(allMin / Math.max(1, allGames)).toFixed(1)} min; kill origins per game:`, Object.entries(killOrigin).map(([k, v]) => `${k} ${(v / allGames).toFixed(1)}`).join(", "));
if (process.env.CTX) console.log("mid-game fight starts (top 25):\n  " + Object.entries(fightCtx).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v}  ${k}`).join("\n  "));
console.log("kill origins before 14:00 per game:", Object.entries(earlyOrigin).map(([k, v]) => `${k} ${(v / allGames).toFixed(1)}`).join(", "));
console.log(`kills per game by phase (ours / LCK sum of per-minute rates): 0-14 ${(bucket(killsByMin, 0, 14) / allGames).toFixed(1)} / ${bucket(kpmL, 0, 14).toFixed(1)}, 14-25 ${(bucket(killsByMin, 14, 25) / allGames).toFixed(1)} / ${bucket(kpmL, 14, 25).toFixed(1)}, 25+ ${(bucket(killsByMin, 25, 45) / allGames).toFixed(1)}`);
