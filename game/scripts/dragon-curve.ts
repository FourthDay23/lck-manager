// Dragon / soul / elder behaviour of the headless engine, measured like scripts/lck_dragons.py measures the 502 LCK
// 2026 games (same tables, same definitions), on the same games calibrate.ts plays (same rosters, drafts, seeds).
// Run: node scripts/run-ts.mjs scripts/dragon-curve.ts [games] [rosterSeed]
//   PLANS=1 adds what the side that did NOT take the dragon was doing (macro plan at the kill / while it was up),
//           plan starts / aborts, engine power ratio by gold lead, hitters in the pit, time from first hit to kill.
//   LOG=<game#> prints that game's macro plan log with a gold/plan line every 30 s; TRACE=1 adds a line per second
//           while the dragon is up and someone is within 3,000 u (HP, each side's plan and champions by distance).
// Bash: cd <game folder> && MSYS_NO_PATHCONV=1 PLANS=1 node scripts/run-ts.mjs scripts/dragon-curve.ts 300 3
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, type SideN } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { DRAGON_PIT, dist } from "../src/match/map";
import * as Macro from "../src/match/macro";
import { gameWinProb } from "../src/core/quick";

const dir = existsSync("public/data/champions.json") && existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => {
  const p = `public/${dir}/${f}`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
// items and champion matchups on, as in calibrate.ts (before, this script ran without them: 27.7 min games)
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"), process.env.MATCHUPS === "0" ? null : j("matchups.json"));
Macro.applyObjTune(process.env.OBJ_TUNE);
const N = Number(process.argv[3] ?? 60);
const rosterSeed = Number(process.argv[4] ?? 3);
const PLANS = !!process.env.PLANS;
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

interface Drag {
  t: number; my: number; th: number; lead: number; alive: [number, number]; k60: [number, number];
  trade: Record<string, number>; since: number; contested: boolean; parts: number; steal: boolean;
  otherPlan: string; otherSeen: string[]; otherNear: number; otherMinDist: number; powRatio: number; hitters: number; ttk: number; frameNear: number[];
}
interface G { stacks: [number, number]; soul: SideN | null; elders: number; drag: Drag[]; dur: number; g15: [number, number] | null; g25: [number, number] | null; kills: number; barons: number; ft: number; steals: number; soulT: number | null; elderBy: SideN[]; win: SideN; p: number }
const games: G[] = [];
const aborts: Record<string, number> = {};
const planCount: Record<string, number> = {};
const rng = new Rng(11);
const KILL = new Set(["kill", "first_blood", "solo"]);
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const strategy = process.env.STRAT ? (process.env.STRAT.split(",").map((x) => x || null) as [never, never]) : undefined;
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g, strategy });
  // LOG=<game#> prints that game's macro plan log around every dragon kill
  const LOG = process.env.LOG !== undefined && Number(process.env.LOG) === g;
  if (LOG && Macro.st(e)) Macro.st(e)!.logOn = true;
  const out: Drag[] = [];
  const stacks: [number, number] = [0, 0];
  let seen = e.events.length;
  let g15: [number, number] | null = null, g25: [number, number] | null = null;
  // plans each side ran while the current dragon was up
  let planSeen: [Set<string>, Set<string>] = [new Set(), new Set()];
  let nextSample = 0;
  let prevT: number | null = null;
  const lastNear = [-99, -99];
  let lastFull = 0;
  let frame = [0, 0];
  while (!e.over && e.t < 3600) {
    e.step();
    if (!g15 && e.t >= 900) g15 = [e.gold(0), e.gold(1)];
    if (!g25 && e.t >= 1500) g25 = [e.gold(0), e.gold(1)];
    const M = Macro.st(e);
    // last time each side had a live champion inside 900 u of the pit while the dragon was up
    if (e.obj.dragon.alive) for (const u of e.units) if (u.alive && dist(u, DRAGON_PIT) < 900) lastNear[u.side] = e.t;
    if (e.obj.dragon.alive && e.obj.dragon.hp >= e.obj.dragon.maxHp * 0.97) lastFull = e.t;
    if (Math.abs(e.t % 60) < 0.01) frame = [0, 1].map((x) => e.units.filter((u) => u.side === x && u.alive && dist(u, DRAGON_PIT) < 3000).length);
    if (LOG && M && process.env.TRACE && e.obj.dragon.alive && Math.abs(e.t % 1) < 0.01 && e.units.some((u) => u.alive && dist(u, DRAGON_PIT) < 3000)) {
      const o = e.obj.dragon;
      const sideTxt = (sd: SideN) => {
        const us = e.units.filter((u) => u.side === sd);
        const p = M.brains[sd].plan;
        const r = (lo: number, hi: number) => us.filter((u) => u.alive && dist(u, DRAGON_PIT) >= lo && dist(u, DRAGON_PIT) < hi).length;
        return `${sd ? "R" : "B"} ${p.id}/${p.phase}${p.prio ? "" : "/np"} pit<900:${r(0, 900)} <2000:${r(900, 2000)} <4000:${r(2000, 4000)} fight:${us.filter((u) => u.fightId).length} dead:${us.filter((u) => !u.alive).length}`;
      };
      M.log.push(`${Math.floor(e.t / 60)}:${String(Math.floor(e.t % 60)).padStart(2, "0")} ~ drag ${Math.round((o.hp / o.maxHp) * 100)}% | ${sideTxt(0)} | ${sideTxt(1)}`);
    }
    if (LOG && M && Math.abs(e.t % 30) < 0.01) {
      const al = [0, 1].map((sd) => e.units.filter((u) => u.side === sd && u.alive).length);
      M.log.push(`${Math.floor(e.t / 60)}:${String(Math.floor(e.t % 60)).padStart(2, "0")} . gold B-R ${e.gold(0) - e.gold(1)} alive ${al[0]}v${al[1]} dragon ${e.obj.dragon.alive ? "UP" : "down"} elder ${e.obj.elder.alive ? "UP" : "-"} baron ${e.obj.baron.alive ? "UP" : "-"} plans B ${M.brains[0].plan.id}/${M.brains[0].plan.phase} R ${M.brains[1].plan.id}/${M.brains[1].plan.phase}`);
    }
    if (PLANS && M && e.obj.dragon.alive && e.t >= nextSample) {
      nextSample = e.t + 2.5;
      for (const sd of [0, 1] as SideN[]) {
        const p = M.brains[sd].plan;
        planSeen[sd].add(p.kind === "take" || p.kind === "contest" ? `${p.id}:${p.phase}${p.prio ? "" : ":noprio"}` : p.id.split(":")[0]);
      }
    }
    for (; seen < e.events.length; seen++) {
      const ev = e.events[seen];
      if (ev.type !== "dragon") continue;
      const sd = ev.side, ot = (1 - sd) as SideN;
      const alive: [number, number] = [e.units.filter((u) => u.side === sd && u.alive).length, e.units.filter((u) => u.side === ot && u.alive).length];
      const k60: [number, number] = [0, 0];
      for (const x of e.events) if (KILL.has(x.type) && x.t >= e.t - 60 && x.t <= e.t) k60[x.side === sd ? 0 : 1]++;
      const others = e.units.filter((u) => u.side === ot && u.alive);
      const op = M ? M.brains[ot].plan : null;
      out.push({
        t: e.t, my: stacks[sd], th: stacks[ot], lead: e.gold(sd) - e.gold(ot), alive, k60, trade: {},
        since: e.t - (prevT === null ? 300 : prevT + 300),
        // LCK "enemy in assists" proxy: an enemy champion inside 900 u of the pit in the last 10 s
        contested: e.t - lastNear[ot] <= 10,
        parts: e.units.filter((u) => u.side === sd && u.alive && dist(u, DRAGON_PIT) < 1200).length,
        steal: e.events.some((x) => x.type === "steal" && x.t === e.t && x.side === sd),
        otherPlan: op ? (op.kind === "take" || op.kind === "contest" ? `${op.id}:${op.phase}${op.prio ? "" : ":noprio"}` : op.id.split(":")[0]) : "-",
        otherSeen: [...planSeen[ot]], otherNear: others.filter((u) => dist(u, DRAGON_PIT) < 3000).length,
        otherMinDist: others.length ? Math.min(...others.map((u) => dist(u, DRAGON_PIT))) : 99999,
        powRatio: [sd, ot].map((x) => e.units.filter((u) => u.side === x).reduce((a2, u) => a2 + e.power({ ...u, hp: u.maxHp }), 0)).reduce((p, q2) => p / q2),
        hitters: M ? (M.pit[sd].dragon ?? 0) : 0,
        ttk: e.t - lastFull,
        frameNear: [frame[sd], frame[ot]],
      });
      (out[out.length - 1] as Drag & { side: SideN }).side = sd;
      stacks[sd]++;
      prevT = e.t;
      planSeen = [new Set(), new Set()];
    }
  }
  if (!e.over) e.runToEnd();
  {
    const M = Macro.st(e);
    if (M) for (const sd of [0, 1] as SideN[]) {
      for (const [k, v] of Object.entries(M.stats[sd].aborts)) if (k.includes("dragon") || k.includes("elder")) aborts[k] = (aborts[k] ?? 0) + v;
      for (const [k, v] of Object.entries(M.stats[sd].plans)) if (k.includes("dragon") || k.includes("elder")) planCount[k] = (planCount[k] ?? 0) + v;
    }
  }
  if (LOG) {
    const M = Macro.st(e)!;
    const ts = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    console.log(`--- game ${g}: ${a} (B, ${e.strategy[0]}) vs ${b} (R, ${e.strategy[1]}), winner ${e.winner ? "R" : "B"}, dragons B ${stacks[0]} R ${stacks[1]}`);
    for (const ev of e.events) if (["dragon", "soul", "elder", "baron", "herald", "turret", "first_turret", "steal"].includes(ev.type) || KILL.has(ev.type)) M.log.push(`${ts(ev.t)} ${ev.side ? "R" : "B"} EVENT ${ev.type}`);
    const lines = M.log.map((l) => ({ l, t: Number(l.split(" ")[0].split(":")[0]) * 60 + Number(l.split(" ")[0].split(":")[1]) })).sort((p, q2) => p.t - q2.t);
    for (const { l } of lines) console.log(l);
  }
  // cross-map trades by the side that did not take it: [-60 s, +30 s]
  for (const dr of out) {
    const sd = (dr as Drag & { side: SideN }).side;
    for (const x of e.events) {
      if (x.side === sd || x.t < dr.t - 60 || x.t > dr.t + 30) continue;
      const w = x.type === "turret" || x.type === "first_turret" ? "tower" : x.type === "inhib" || x.type === "grubs" || x.type === "herald" || x.type === "baron" ? x.type : null;
      if (w) dr.trade[w] = (dr.trade[w] ?? 0) + 1;
    }
  }
  games.push({ stacks, soul: e.soul, elders: e.events.filter((x) => x.type === "elder").length, drag: out, dur: e.t, g15, g25, kills: e.kills[0] + e.kills[1], barons: e.barons[0] + e.barons[1], ft: e.events.find((x) => x.type === "first_turret")?.t ?? e.t, steals: e.events.filter((x) => x.type === "steal").length, soulT: e.events.find((x) => x.type === "soul")?.t ?? null, elderBy: e.events.filter((x) => x.type === "elder").map((x) => x.side), win: e.winner as SideN, p: gameWinProb(s, a, b) });
}

// ---------- report (same tables as scripts/lck_dragons.py) ----------
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1).padStart(5)}%` : "   - ");
const median = (xs: number[]) => { const s2 = [...xs].sort((x, y) => x - y); return s2.length ? s2[Math.floor((s2.length - 1) / 2)] : NaN; };
const bucket = (l: number) => { const a2 = Math.abs(l); return a2 < 1000 ? "<1k" : a2 < 3000 ? "1-3k" : a2 < 6000 ? "3-6k" : ">6k"; };
const BUCKETS = ["<1k", "1-3k", "3-6k", ">6k"];
const dr = games.flatMap((g) => g.drag);
const split: Record<string, number> = {};
for (const g of games) {
  const [x, y] = [...g.stacks].sort((p, q) => p - q);
  const k = `${x}-${y}${g.soul !== null ? " soul" : ""}`;
  split[k] = (split[k] ?? 0) + 1;
}
const souls = games.filter((g) => g.soul !== null).length;
const zero4 = games.filter((g) => Math.min(...g.stacks) === 0 && Math.max(...g.stacks) === 4).length;
console.log(`games ${N} (roster seed ${rosterSeed}) | dragons/game ${(dr.length / N).toFixed(2)} | elder/game ${(games.reduce((a, g) => a + g.elders, 0) / N).toFixed(3)} | soul ${(souls / N).toFixed(3)} | 0-4 ${(zero4 / N).toFixed(3)} of games (${(zero4 / Math.max(1, souls)).toFixed(2)} of souls) | length ${(games.reduce((a, g) => a + g.dur, 0) / N / 60).toFixed(1)} min`);
console.log("0-4 by matchup (formula p of blue):", [[0, 0.15, "even"], [0.15, 0.35, "clear favourite"], [0.35, 0.51, "lopsided"]].map(([lo, hi, nm]) => {
  const gs = games.filter((g) => Math.abs(g.p - 0.5) >= (lo as number) && Math.abs(g.p - 0.5) < (hi as number));
  const z = gs.filter((g) => Math.min(...g.stacks) === 0 && Math.max(...g.stacks) === 4);
  const fav = z.filter((g) => (g.stacks[0] === 4) === (g.p >= 0.5)).length;
  return `${nm} ${pct(z.length, gs.length).trim()} (n=${gs.length}, by the favourite ${pct(fav, z.length).trim()})`;
}).join(" | "));
const per = (f: (g: G) => number) => (games.reduce((a2, g) => a2 + f(g), 0) / N);
console.log(`engine only: kills ${per((g) => g.kills).toFixed(2)} | barons ${per((g) => g.barons).toFixed(2)} | first tower ${(per((g) => g.ft) / 60).toFixed(1)} min | steals ${per((g) => g.steals).toFixed(2)}`);
console.log("split (sorted final non-elder counts):", Object.entries(split).sort((p, q) => q[1] - p[1]).map(([k, v]) => `${k}:${pct(v, N).trim()}`).join("  "));
{
  const sg = games.filter((g) => g.soul !== null && g.soulT !== null);
  const opp = sg.filter((g) => g.dur > g.soulT! + 360);
  const el = sg.reduce((a2, g) => a2 + g.elderBy.length, 0);
  const elSoul = sg.reduce((a2, g) => a2 + g.elderBy.filter((x) => x === g.soul).length, 0);
  console.log(`soul at median ${(median(sg.map((g) => g.soulT!)) / 60).toFixed(1)} min | soul team wins ${pct(sg.filter((g) => g.win === g.soul).length, sg.length).trim()} | game still on when elder spawns ${pct(opp.length, sg.length).trim()} of soul games | elder kills per such game ${(opp.reduce((a2, g) => a2 + g.elderBy.length, 0) / Math.max(1, opp.length)).toFixed(2)} (by the soul team ${pct(elSoul, Math.max(1, el)).trim()}) | game length after soul median ${(median(sg.map((g) => g.dur - g.soulT!)) / 60).toFixed(1)} min`);
}
const g15 = games.filter((g) => g.g15).map((g) => Math.abs(g.g15![0] - g.g15![1]));
const g25 = games.filter((g) => g.g25).map((g) => Math.abs(g.g25![0] - g.g25![1]));
const t15 = games.filter((g) => g.g15).map((g) => (g.g15![0] + g.g15![1]) / 2);
console.log(`team gold 15:00 ${(t15.reduce((p, q) => p + q, 0) / t15.length).toFixed(0)} (median |lead| ${median(g15).toFixed(0)}) | median |lead| 25:00 ${median(g25).toFixed(0)}`);
console.log("P(gold leader takes the dragon) by |lead| at the kill:");
const rows: [string, (x: Drag) => boolean][] = [
  ["all", () => true], ["soul point (a team on 3)", (x) => Math.max(x.my, x.th) === 3],
  ["1st-2nd dragon", (x) => x.my + x.th < 2], ["3rd+ non-soul-point", (x) => x.my + x.th >= 2 && Math.max(x.my, x.th) < 3],
];
const curveRow = (sel: (x: Drag) => boolean) => BUCKETS.map((bk) => {
  const ds = dr.filter((x) => sel(x) && bucket(x.lead) === bk && x.lead !== 0);
  const w = ds.filter((x) => x.lead > 0).length;
  return `${bk.padStart(5)} ${ds.length ? ((w / ds.length) * 100).toFixed(1).padStart(5) : "  nan"}% (n=${ds.length})`;
}).join("  ");
for (const [name, sel] of rows) console.log(`  ${name.padEnd(28)} ${curveRow(sel)}`);
console.log("P(team with more stacks takes the next dragon) by stacks before (more-fewer):");
const stc: Record<string, [number, number]> = {};
for (const x of dr) {
  const k = `${Math.max(x.my, x.th)}-${Math.min(x.my, x.th)}`;
  stc[k] ??= [0, 0];
  stc[k][0]++;
  if (x.my > x.th) stc[k][1]++;
}
console.log("  " + Object.entries(stc).filter(([k]) => k[0] !== k[2]).sort().map(([k, v]) => `${k}: ${((v[1] / v[0]) * 100).toFixed(1).padStart(5)}% (n=${v[0]})`).join("  "));
console.log("dragons by the taker's gold position (lead of the taker):");
const pos: [string, (x: Drag) => boolean][] = [["taker ahead >1k", (x) => x.lead > 1000], ["even ±1k", (x) => Math.abs(x.lead) <= 1000], ["taker behind >1k", (x) => x.lead < -1000]];
for (const [name, sel] of pos) {
  const ds = dr.filter(sel);
  const n = ds.length;
  if (!n) continue;
  const since = ds.map((x) => x.since);
  console.log(`  ${name.padEnd(17)} n=${String(n).padStart(4)} | taker has more alive ${pct(ds.filter((x) => x.alive[0] > x.alive[1]).length, n)} fewer ${pct(ds.filter((x) => x.alive[0] < x.alive[1]).length, n)} | won kills last 60 s ${pct(ds.filter((x) => x.k60[0] > x.k60[1]).length, n)} | other side traded (tower/epic ${pct(ds.filter((x) => Object.keys(x.trade).length > 0).length, n)}) | enemy near pit ${pct(ds.filter((x) => x.contested).length, n)} | steal ${pct(ds.filter((x) => x.steal).length, n)} | since spawn median ${median(since).toFixed(0)} s, <60 s ${pct(since.filter((x) => x < 60).length, n)}`);
}
const why = (x: Drag) => Object.keys(x.trade).length ? "leader took tower/epic" : x.contested ? "contested" : x.alive[0] > x.alive[1] ? "more alive" : x.k60[0] > x.k60[1] ? "won kills 60 s" : "nothing seen";
for (const [name, sel] of [["taker behind >1k", (x: Drag) => x.lead < -1000], ["taker ahead >1k", (x: Drag) => x.lead > 1000]] as [string, (x: Drag) => boolean][]) {
  const ds = dr.filter(sel);
  const c: Record<string, number> = {};
  for (const x of ds) c[why(x)] = (c[why(x)] ?? 0) + 1;
  console.log(`  reasons, ${name}: ` + Object.entries(c).sort((p, q2) => q2[1] - p[1]).map(([k, v]) => `${k} ${pct(v, ds.length).trim()}`).join("  "));
}
{
  const c: Record<string, [number, number]> = {};
  for (const x of dr) { const k = `${x.my}-${x.th}`; c[k] ??= [0, 0]; c[k][0]++; if (x.contested) c[k][1]++; }
  console.log("contested share (enemy inside 900 u in the last 10 s) by stacks before (taker-other):", Object.entries(c).filter(([, v]) => v[0] >= 12).sort().map(([k, v]) => `${k}: ${pct(v[1], v[0]).trim()} (n=${v[0]})`).join("  "));
  for (const [name, sel] of [["team on 3 ahead >1k", (l: number) => l > 1000], ["±1k", (l: number) => Math.abs(l) <= 1000], ["team on 3 behind >1k", (l: number) => l < -1000]] as [string, (l: number) => boolean][]) {
    let n = 0, w = 0;
    for (const x of dr) {
      if (Math.max(x.my, x.th) !== 3 || x.my === x.th) continue;
      if (!sel(x.my === 3 ? x.lead : -x.lead)) continue;
      n++;
      if (x.my === 3) w++;
    }
    console.log(`  soul point, ${name}: team on 3 takes ${pct(w, n)} (n=${n})`);
  }
}
{
  const row: string[] = [];
  for (const [name, sel] of [["stack leader ahead >1k", (l: number) => l > 1000], ["±1k", (l: number) => Math.abs(l) <= 1000], ["behind >1k", (l: number) => l < -1000]] as [string, (l: number) => boolean][]) {
    let n = 0, w = 0;
    for (const x of dr) {
      if (!(x.my + x.th > 0 && Math.min(x.my, x.th) === 0)) continue;
      if (!sel(x.my > 0 ? x.lead : -x.lead)) continue;
      n++;
      if (x.my > 0) w++;
    }
    row.push(`${name} ${pct(w, n).trim()} (n=${n})`);
  }
  console.log("  k-0 states (1-0, 2-0, 3-0), P(the team with the stacks takes the next): " + row.join(" | "));
}
const eq: Record<string, number> = {};
for (const x of dr) { const k = `${x.alive[0]}v${x.alive[1]}`; eq[k] = (eq[k] ?? 0) + 1; }
console.log("alive (taker v other) at the kill, top:", Object.entries(eq).sort((p, q) => q[1] - p[1]).slice(0, 8).map(([k, v]) => `${k}:${pct(v, dr.length).trim()}`).join("  "));
for (const [name, sel] of [["all", () => true], ["taker ahead >1k", (x: Drag) => x.lead > 1000], ["taker behind >1k", (x: Drag) => x.lead < -1000]] as [string, (x: Drag) => boolean][]) {
  const ds = dr.filter(sel);
  const hist = (i: number) => [0, 1, 2, 3, 4, 5].map((k) => `${k}:${pct(ds.filter((x) => Math.min(5, x.frameNear[i]) === k).length, ds.length).trim()}`).join(" ");
  console.log(`  frame before the kill, ${name.padEnd(16)}: other side within 3,000 u ${hist(1)} | taker side ${hist(0)}`);
}
const since = dr.map((x) => x.since).sort((p, q) => p - q);
const q = (p: number) => since[Math.floor(p * (since.length - 1))];
console.log(`seconds from spawn to kill: P25 ${q(0.25).toFixed(0)} | median ${q(0.5).toFixed(0)} | P75 ${q(0.75).toFixed(0)} | P90 ${q(0.9).toFixed(0)}`);
const parts: Record<number, number> = {};
for (const x of dr) parts[x.parts] = (parts[x.parts] ?? 0) + 1;
console.log("taker champions within 1,200 u of the pit:", Object.entries(parts).map(([k, v]) => `${k}:${pct(v, dr.length).trim()}`).join("  "));
for (const [name, sel] of [["equal alive", (x: Drag) => x.alive[0] === x.alive[1]], ["taker-side numbers differ", (x: Drag) => x.alive[0] !== x.alive[1]]] as [string, (x: Drag) => boolean][]) {
  console.log(`  leader-takes, ${name.padEnd(26)} ${curveRow(sel)}`);
}
if (PLANS) {
  const cnt = (f: (x: Drag) => string[]) => {
    const c: Record<string, number> = {};
    for (const x of dr) for (const k of f(x)) c[k] = (c[k] ?? 0) + 1;
    return Object.entries(c).sort((p, q2) => q2[1] - p[1]).slice(0, 14).map(([k, v]) => `${k}:${pct(v, dr.length).trim()}`).join("  ");
  };
  console.log("other side's plan at the kill:", cnt((x) => [x.otherPlan]));
  console.log("other side's plans while it was up (any):", cnt((x) => x.otherSeen));
  const near: Record<number, number> = {};
  for (const x of dr) near[x.otherNear] = (near[x.otherNear] ?? 0) + 1;
  console.log("other side alive within 3,000 u at the kill:", Object.entries(near).map(([k, v]) => `${k}:${pct(v, dr.length).trim()}`).join("  "), `| median nearest ${median(dr.map((x) => x.otherMinDist)).toFixed(0)} u`);
  for (const [name, sel] of pos) {
    const ds = dr.filter(sel);
    const c: Record<string, number> = {};
    for (const x of ds) c[x.otherPlan] = (c[x.otherPlan] ?? 0) + 1;
    console.log(`  ${name}: other plan at kill`, Object.entries(c).sort((p, q2) => q2[1] - p[1]).slice(0, 8).map(([k, v]) => `${k}:${pct(v, ds.length).trim()}`).join("  "));
  }
  // engine full-team power ratio (leader / trailer, full HP) by gold lead at the kill
  console.log("engine power ratio leader/trailer by |lead|:", BUCKETS.map((bk) => {
    const ds = dr.filter((x) => bucket(x.lead) === bk && x.lead !== 0).map((x) => (x.lead > 0 ? x.powRatio : 1 / x.powRatio));
    return `${bk} ${median(ds).toFixed(2)}`;
  }).join("  "));
  const hit: Record<number, number> = {};
  for (const x of dr) hit[x.hitters] = (hit[x.hitters] ?? 0) + 1;
  console.log("taker's committed hitters in the pit at the kill:", Object.entries(hit).map(([k, v]) => `${k}:${pct(v, dr.length).trim()}`).join("  "));
  { const t2 = dr.map((x) => x.ttk).sort((p, q2) => p - q2); console.log(`seconds from the first hit (last full HP) to the kill: P25 ${t2[Math.floor(t2.length * 0.25)].toFixed(1)} | median ${t2[Math.floor(t2.length * 0.5)].toFixed(1)} | P75 ${t2[Math.floor(t2.length * 0.75)].toFixed(1)}`); }
  console.log("dragon/elder plans started per game:", Object.entries(planCount).sort((p, q2) => q2[1] - p[1]).map(([k, v]) => `${k} ${(v / N).toFixed(2)}`).join("  "));
  console.log("dragon/elder plan aborts per game:", Object.entries(aborts).sort((p, q2) => q2[1] - p[1]).map(([k, v]) => `${k} ${(v / N).toFixed(2)}`).join("  "));
}
