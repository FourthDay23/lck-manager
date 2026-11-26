// Early game (laning, < 14 min) diagnosis with the full engine (items on unless ITEMS=0): when kills happen, which
// fights start (all-in / gank / jungle meetings / skirmishes), how many join, how often they end in a kill, how often
// junglers start a gank and how often laners are away (recall / dead). Same games as calibrate.ts.
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/early-diag.ts [games] [rosterSeed]
// LCK 2026 references (502 games): kills by 10 min 3.8, first blood 5.1 min (median 4.3), early kill clusters 4.7 per
// game with 4.1 participants and 1.47 kills each (scripts/fight-test.ts clusters, lck-stats.gen.ts)
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, applyEarlyTune } from "../src/match/engine";
import type { Unit } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";

const dir = "data";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"));
const N = Number(process.argv[3] ?? 60);
const rosterSeed = Number(process.argv[4] ?? 3);
applyEarlyTune(process.env.EARLY_TUNE);
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

const kpm = new Array(15).fill(0);
let fbSum = 0;
const fbs: number[] = [];
const fightStats: Record<string, { n: number; members: number; kills: number; withKill: number; bothScored: number }> = {};
const killBy: Record<string, number> = {};
let gankStarts = 0, gankFights = 0;
const awayLaner = { recall: 0, dead: 0, fight: 0, lane: 0, other: 0 };
let recallsBefore10 = 0;
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
  const seen = new Set<number>();
  const live = new Map<number, { origin: string; members: Set<number>; kills: number; sides: Set<number> }>();
  const prevD = e.units.map((u) => u.d);
  const prevTask = e.units.map((u) => u.task);
  const fightOf = e.units.map(() => 0);
  let firstKill = -1;
  while (!e.over && e.t < 14 * 60) {
    for (const u of e.units) fightOf[u.i] = u.fightId ?? 0;
    e.step();
    for (const [id, f] of e.fights) {
      if (!seen.has(id)) {
        seen.add(id);
        live.set(id, { origin: (f as { origin?: string }).origin ?? "?", members: new Set(), kills: 0, sides: new Set() });
      }
    }
    for (const u of e.units) {
      if (u.fightId && live.has(u.fightId)) live.get(u.fightId)!.members.add(u.i);
      if (u.role === "Jungle" && u.task === "gank" && prevTask[u.i] !== "gank") gankStarts++;
      // the engine sets task "recall" one step and recallEnd a later one: count the change into "recall"
      if (prevTask[u.i] !== "recall" && u.task === "recall" && e.t < 600) recallsBefore10++;
      prevTask[u.i] = u.task;
    }
    for (const v of e.units) {
      if (v.d > prevD[v.i]) {
        prevD[v.i] = v.d;
        const m = Math.floor(e.t / 60);
        if (m < 15) kpm[m]++;
        if (firstKill < 0) firstKill = e.t;
        const fid = fightOf[v.i] || v.fightId || 0;
        const f = live.get(fid);
        const key = f ? f.origin : "no fight";
        killBy[key] = (killBy[key] ?? 0) + 1;
        if (f) { f.kills++; f.sides.add(1 - v.side); }
      }
    }
    // where are the laners, sampled every 10 s between 3 and 10 min
    if (e.t > 180 && e.t < 600 && Math.abs(e.t / 10 - Math.round(e.t / 10)) < 1e-6) {
      for (const u of e.units) {
        if (u.role === "Jungle") continue;
        if (!u.alive) awayLaner.dead++;
        else if (u.recallEnd !== undefined || u.task === "recall") awayLaner.recall++;
        else if (u.fightId) awayLaner.fight++;
        else if (u.task === "lane") awayLaner.lane++;
        else awayLaner.other++;
      }
    }
  }
  if (firstKill < 0) firstKill = 14 * 60;
  fbSum += firstKill;
  fbs.push(firstKill);
  for (const f of live.values()) {
    const fs = (fightStats[f.origin] = fightStats[f.origin] ?? { n: 0, members: 0, kills: 0, withKill: 0, bothScored: 0 });
    fs.n++;
    fs.members += f.members.size;
    fs.kills += f.kills;
    if (f.kills) fs.withKill++;
    if (f.sides.size > 1) fs.bothScored++;
    if (f.origin === "gank") gankFights++;
  }
}
fbs.sort((x, y) => x - y);
const per = (x: number) => (x / N).toFixed(2);
console.log(`games ${N} (roster seed ${rosterSeed}, items ${process.env.ITEMS === "0" ? "off" : "on"})`);
console.log(`first kill mean ${(fbSum / N / 60).toFixed(1)} min, median ${(fbs[Math.floor(N / 2)] / 60).toFixed(1)} (LCK 5.1 / 4.3)`);
console.log(`kills by 10 min ${per(kpm.slice(0, 10).reduce((a, x) => a + x, 0))} (LCK 3.8), 10-14 min ${per(kpm.slice(10, 14).reduce((a, x) => a + x, 0))}`);
console.log(`kills per minute: ${kpm.slice(0, 14).map((x, i) => `${i}:${(x / N).toFixed(2)}`).join(" ")}`);
console.log(`kills by fight origin (< 14 min, per game): ${Object.entries(killBy).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${per(v)}`).join(" | ")}`);
console.log("fights started before 14 min (per game): origin  n  members  kills/fight  P(kill)  both scored");
for (const [k, v] of Object.entries(fightStats).sort((x, y) => y[1].n - x[1].n))
  console.log(`  ${k.padEnd(8)} ${per(v.n).padStart(6)}  ${(v.members / v.n).toFixed(2)}  ${(v.kills / v.n).toFixed(2)}  ${(v.withKill / v.n * 100).toFixed(0)}%  ${(v.bothScored / Math.max(1, v.withKill) * 100).toFixed(0)}%`);
console.log(`gank starts per game ${per(gankStarts)} (both junglers), gank fights ${per(gankFights)}`);
console.log(`recalls before 10 min per game ${per(recallsBefore10)}`);
const tot = Object.values(awayLaner).reduce((a, x) => a + x, 0) || 1;
console.log(`laner state 3-10 min: ${Object.entries(awayLaner).map(([k, v]) => `${k} ${(v / tot * 100).toFixed(0)}%`).join(" ")}`);
void ({} as Unit);
