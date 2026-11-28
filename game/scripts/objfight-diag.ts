// Where and when the engine's fights happen relative to epic monsters, with the definitions of
// scripts/lck_objfights.py (real LCK 2026) so the two outputs can be laid side by side. Same games as calibrate.ts.
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/objfight-diag.ts [games] [rosterSeed]
//   in parallel: node scripts/par.mjs objfight-diag.ts [games] [rosterSeed]  (same report)
//   JSON=C:/.../out.json writes the tables; LOG=<game#> prints that game's macro plan log and its fights.
//   EARLY_TUNE / PACE_TUNE / SIM_TUNE / STRAT / FLAGS as in calibrate.ts.
// Definitions (see lck_objfights.py): a fight is a chain of champion kills (15 s / 2,500 u), size = killers +
// assisters + victims, "at a pit" = centroid of its kills within 2,500 u of the dragon / baron pit, "in play" = a
// monster of that pit is up, spawns within 60 s or died in the last 30 s, "objective fight" = both.
// Engine-only extras: fights as the fight module sees them (members, also the ones that end without a kill), the
// plans the two brains ran, and how many champions stood near the pit when a monster spawned.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, ENGINE_FLAGS, applyEarlyTune, applyPaceTune, applySimTune, type ObjKey, type SideN, type Unit } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { BARON_PIT, DRAGON_PIT, NEXUS, dist, type Vec } from "../src/match/map";
import * as Macro from "../src/match/macro";
import { par } from "./lib/par";

const dir = existsSync("public/data/champions.json") && existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => {
  const p = `public/${dir}/${f}`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"), process.env.MATCHUPS === "0" ? null : j("matchups.json"));
const N = Number(process.argv[3] ?? 60);
const rosterSeed = Number(process.argv[4] ?? 3);
applyEarlyTune(process.env.EARLY_TUNE);
applySimTune(process.env.SIM_TUNE);
applyPaceTune(process.env.PACE_TUNE);
Macro.applyObjTune(process.env.OBJ_TUNE);
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("-"))) (ENGINE_FLAGS as Record<string, boolean>)[fl] = true;
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter((x) => x.startsWith("-"))) (ENGINE_FLAGS as Record<string, boolean>)[fl.slice(1)] = false;
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

type Pit = "dragon" | "baron";
const PITS: Record<Pit, Vec> = { dragon: DRAGON_PIT, baron: BARON_PIT };
const PIT_OF: Record<ObjKey, Pit> = { dragon: "dragon", elder: "dragon", baron: "baron", herald: "baron", grubs: "baron" };
const FIGHT_GAP = 15, FIGHT_RADIUS = 2500, PIT_R = 2500, PRE = 60, POST = 30, NEAR_R = 3000;
const RADII = [1500, 2500, 3500];
const phaseOf = (t: number) => (t < 14 * 60 ? "early" : t <= 25 * 60 ? "mid" : "late");
function place(c: Vec): string {
  if (dist(c, DRAGON_PIT) <= PIT_R) return "dragon pit";
  if (dist(c, BARON_PIT) <= PIT_R) return "baron pit";
  if (Math.min(dist(c, NEXUS[0]), dist(c, NEXUS[1])) <= 4500) return "base";
  if (Math.abs(c.x - c.y) <= 1300 * Math.SQRT2) return "mid lane";
  if (c.x < 2300 || c.y > 12500) return "top lane";
  if (c.y < 2300 || c.x > 12500) return "bot lane";
  return "river / jungle";
}

interface Kill { t: number; pos: Vec; parts: Set<number>; side: SideN }
interface Win { pit: Pit; obj: ObjKey; spawn: number; gone: number; taken: boolean; near?: [number, number]; atSpawn?: [number, number]; side?: SideN; plan?: string }
interface Fight { t: number; end: number; size: number; kills: number; c: Vec; near: Record<number, Pit | null>; obj: ObjKey | null; spawn60: boolean; kill60: boolean; place: string }
/** a fight as the fight module ran it (members that were in it at any time), with or without kills */
interface ModFight { t: number; end: number; size: number; pos: Vec; origin: string; kills: number; pit: Pit | null; obj: ObjKey | null }
interface G { dur: number; kills: number; fights: Fight[]; win: Win[]; mod: ModFight[] }

function cluster(kills: Kill[]): Kill[][] {
  const fights: Kill[][] = [];
  let open: Kill[][] = [];
  for (const k of kills) {
    open = open.filter((f) => k.t - f[f.length - 1].t <= FIGHT_GAP);
    let best: Kill[] | null = null, bd = Infinity;
    for (const f of open) {
      const d = Math.min(...f.map((o) => dist(k.pos, o.pos)));
      if (d <= FIGHT_RADIUS && d < bd) { best = f; bd = d; }
    }
    if (!best) { best = []; fights.push(best); open.push(best); }
    best.push(k);
  }
  return fights;
}
const inPlay = (win: Win[], pit: Pit, t: number) => win.find((w) => w.pit === pit && w.spawn - PRE <= t && t <= w.gone + POST)?.obj ?? null;

const games: G[] = [];
const plans: Record<string, number> = {};
const aborts: Record<string, number> = {};
const calls: Record<string, number> = {};
const rng = new Rng(11);
const EPIC = new Set(["dragon", "elder", "baron", "herald", "grubs"]);
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const strategy = process.env.STRAT ? (process.env.STRAT.split(",").map((x) => x || null) as [never, never]) : undefined;
  // par.game: plays the game here, or leaves it to another piece of a parallel run (scripts/par.mjs)
  const res = par.game(g, () => {
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g, strategy });
  const LOG = process.env.LOG !== undefined && Number(process.env.LOG) === g;
  if (LOG && Macro.st(e)) Macro.st(e)!.logOn = true;
  const kills: Kill[] = [];
  const kill0 = e.kill.bind(e);
  e.kill = (src: Unit | null, v: Unit) => {
    const parts = new Set<number>([v.i]);
    if (src && src.side !== v.side) parts.add(src.i);
    for (const [i, t] of v.lastHitBy) if (e.t - t < 10 && e.units[i].side !== v.side) parts.add(i);
    kills.push({ t: e.t, pos: { x: v.x, y: v.y }, parts, side: (1 - v.side) as SideN });
    kill0(src, v);
  };
  const win: Win[] = [];
  const open: Partial<Record<ObjKey, Win>> = {};
  const mod = new Map<number, ModFight & { members: Set<number> }>();
  const near = (pit: Pit, side: SideN): [number, number] => {
    const n = [0, 0];
    for (const u of frame) if (dist(u, PITS[pit]) <= NEAR_R) n[u.side]++;
    return [n[side], n[1 - side]];
  };
  let frame: { x: number; y: number; side: SideN }[] = [];
  let seen = 0;
  while (!e.over && e.t < 3600) {
    const before: Partial<Record<ObjKey, boolean>> = {};
    for (const k of Object.keys(e.obj) as ObjKey[]) before[k] = e.obj[k].alive;
    e.step();
    if (e.t % 60 < 0.25) frame = e.units.filter((u) => u.alive).map((u) => ({ x: u.x, y: u.y, side: u.side }));
    for (const k of Object.keys(e.obj) as ObjKey[]) {
      const o = e.obj[k];
      if (!before[k] && o.alive) {
        const now = [0, 0];
        for (const u of e.units) if (u.alive && dist(u, PITS[PIT_OF[k]]) <= NEAR_R) now[u.side]++;
        open[k] = { pit: PIT_OF[k], obj: k, spawn: e.t, gone: e.t, taken: false, atSpawn: [now[0], now[1]] };
      } else if (before[k] && !o.alive && open[k]) {
        const w = open[k]!;
        w.gone = e.t;
        win.push(w);
        delete open[k];
      }
    }
    for (; seen < e.events.length; seen++) {
      const ev = e.events[seen];
      if (!EPIC.has(ev.type)) continue;
      // the window of this kill was closed in this same step
      const w = [...win].reverse().find((x) => x.obj === ev.type && x.gone === e.t);
      if (w) {
        w.taken = true; w.side = ev.side; w.near = near(w.pit, ev.side);
        const tp = Macro.st(e)?.brains[ev.side].plan;
        w.plan = tp ? (tp.obj === w.obj ? `${tp.kind}${tp.solo ? " solo" : ""}` : `other (${tp.kind})`) : "-";
      }
    }
    for (const [id, f] of e.fights) {
      let m = mod.get(id);
      if (!m) {
        m = { t: f.start, end: e.t, size: 0, pos: { x: f.x, y: f.y }, origin: f.origin ?? "?", kills: 0, pit: null, obj: null, members: new Set() };
        mod.set(id, m);
      }
      m.end = e.t;
      for (const u of e.units) if (u.fightId === id) m.members.add(u.i);
      if (m.members.size > m.size) { m.size = m.members.size; m.pos = { x: f.x, y: f.y }; }
    }
  }
  if (!e.over) e.runToEnd();
  for (const k of Object.keys(open) as ObjKey[]) { const w = open[k]!; w.gone = e.t; win.push(w); }
  const fights: Fight[] = cluster(kills).map((f) => {
    const parts = new Set<number>();
    for (const k of f) for (const i of k.parts) parts.add(i);
    const c = { x: f.reduce((p, k) => p + k.pos.x, 0) / f.length, y: f.reduce((p, k) => p + k.pos.y, 0) / f.length };
    const t0 = f[0].t;
    const nearP: Record<number, Pit | null> = {};
    for (const r of RADII) nearP[r] = (Object.keys(PITS) as Pit[]).find((pk) => dist(c, PITS[pk]) <= r) ?? null;
    const pit = nearP[PIT_R];
    return {
      t: t0, end: f[f.length - 1].t, size: Math.min(10, parts.size), kills: f.length, c, near: nearP, obj: pit ? inPlay(win, pit, t0) : null,
      spawn60: win.some((w) => Math.abs(t0 - w.spawn) <= 60), kill60: win.some((w) => w.taken && t0 - w.gone >= -60 && t0 - w.gone <= 60), place: place(c),
    };
  });
  const mods: ModFight[] = [...mod.values()].map((m) => {
    const pit = (Object.keys(PITS) as Pit[]).find((pk) => dist(m.pos, PITS[pk]) <= PIT_R) ?? null;
    return { t: m.t, end: m.end, size: m.size, pos: m.pos, origin: m.origin, pit, obj: pit ? inPlay(win, pit, m.t) : null,
      kills: kills.filter((k) => k.t >= m.t && k.t <= m.end + 1 && dist(k.pos, m.pos) < 2500).length };
  });
  const game: G = { dur: e.t, kills: e.kills[0] + e.kills[1], fights, win, mod: mods };
  const M = Macro.st(e);
  const pl: Record<string, number> = {}, ab: Record<string, number> = {}, ca: Record<string, number> = {};
  if (M) for (const sd of [0, 1] as SideN[]) {
    for (const [k, v] of Object.entries(M.stats[sd].plans)) pl[k] = (pl[k] ?? 0) + v;
    for (const [k, v] of Object.entries(M.stats[sd].aborts)) ab[k] = (ab[k] ?? 0) + v;
    for (const [k, v] of Object.entries(M.stats[sd].calls ?? {})) ca[k] = (ca[k] ?? 0) + v;
  }
  if (LOG) {
    const ts = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    console.log(`--- game ${g}: ${e.names[0]} vs ${e.names[1]}, ${ts(e.t)}, kills ${e.kills[0]}-${e.kills[1]}`);
    const lines: [number, string][] = [];
    for (const l of M?.log ?? []) { const [mm, ss] = l.split(" ")[0].split(":").map(Number); lines.push([mm * 60 + ss, l]); }
    for (const f of fights) lines.push([f.t, `${ts(f.t)} # FIGHT size ${f.size} kills ${f.kills} at ${f.place}${f.obj ? ` (${f.obj} in play)` : ""}`]);
    for (const w of win) { lines.push([w.spawn, `${ts(w.spawn)} * ${w.obj} spawns (near ${w.atSpawn?.join("v")})`]); if (w.taken) lines.push([w.gone, `${ts(w.gone)} * ${w.obj} taken by ${w.side ? "R" : "B"} (near ${w.near?.join("v")})`]); }
    for (const m of mods) if (m.size >= 4) lines.push([m.t, `${ts(m.t)} ~ module fight ${m.origin} size ${m.size} kills ${m.kills} ${(m.end - m.t).toFixed(0)}s at ${place(m.pos)}`]);
    lines.sort((x, y) => x[0] - y[0]);
    for (const [, l] of lines) console.log(l);
  }
  return { game, pl, ab, ca };
  });
  if (!res) continue;
  games.push(res.game);
  for (const [k, v] of Object.entries(res.pl)) plans[k] = (plans[k] ?? 0) + v;
  for (const [k, v] of Object.entries(res.ab)) aborts[k] = (aborts[k] ?? 0) + v;
  for (const [k, v] of Object.entries(res.ca)) calls[k] = (calls[k] ?? 0) + v;
}
par.end();

const n = games.length;
const out: Record<string, unknown> = { games: n, label: "engine" };
const med = [...games].map((g) => g.dur).sort((x, y) => x - y)[Math.floor(n / 2)];
console.log(`== engine: ${n} games (roster seed ${rosterSeed}), mean length ${(games.reduce((p, g) => p + g.dur, 0) / n / 60).toFixed(1)} min (median ${(med / 60).toFixed(1)}), kills ${(games.reduce((p, g) => p + g.kills, 0) / n).toFixed(1)} ==`);
console.log("fights by size and phase: per game | at a pit (2,500 u) | objective fight (pit + monster in play) | +-60 s of a spawn | +-60 s of an epic kill");
const SIZES: [string, number][] = [["all", 1], ["4+", 4], ["6+", 6]];
const PHASES = ["early", "mid", "late", "all"];
const table: Record<string, Record<string, number>> = {};
for (const [sname, smin] of SIZES) for (const ph of PHASES) {
  const fs = games.flatMap((g) => g.fights).filter((f) => f.size >= smin && (ph === "all" || phaseOf(f.t) === ph));
  if (!fs.length) continue;
  const m = fs.length;
  const sh = (fn: (f: Fight) => unknown) => fs.filter(fn).length / m;
  const row = { perGame: m / n, atPit: sh((f) => f.near[PIT_R]), objFight: sh((f) => f.obj), spawn60: sh((f) => f.spawn60), kill60: sh((f) => f.kill60), pit1500: sh((f) => f.near[1500]), pit3500: sh((f) => f.near[3500]), kills: fs.reduce((p, f) => p + f.kills, 0) / m };
  table[`${sname}:${ph}`] = row;
  const pc = (x: number) => (x * 100).toFixed(1).padStart(4);
  console.log(`  ${sname.padStart(3)} ${ph.padEnd(5)} ${row.perGame.toFixed(2).padStart(5)} | pit ${pc(row.atPit)}% (1,500 u ${pc(row.pit1500)}, 3,500 u ${pc(row.pit3500)}) | objective ${pc(row.objFight)}% | spawn ${pc(row.spawn60)}% | epic kill ${pc(row.kill60)}% | kills/fight ${row.kills.toFixed(2)}`);
}
out.fights = table;
console.log("where fights of 6+ happen (share by phase):");
const places = ["dragon pit", "baron pit", "mid lane", "top lane", "bot lane", "river / jungle", "base"];
const loc: Record<string, Record<string, number>> = {};
for (const ph of PHASES) {
  const fs = games.flatMap((g) => g.fights).filter((f) => f.size >= 6 && (ph === "all" || phaseOf(f.t) === ph));
  if (!fs.length) continue;
  loc[ph] = Object.fromEntries(places.map((p) => [p, fs.filter((f) => f.place === p).length / fs.length]));
  console.log(`  ${ph.padEnd(5)} ` + places.map((p) => `${p} ${(loc[ph][p] * 100).toFixed(1).padStart(4)}%`).join(" | "));
}
out.places6 = loc;
console.log("which monster the objective fights (4+) are about, per game:");
const by: Record<string, number> = {};
for (const g of games) for (const f of g.fights) if (f.size >= 4 && f.obj) by[f.obj] = (by[f.obj] ?? 0) + 1;
out.objFightsBy = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v / n]));
console.log("  " + Object.entries(by).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${(v / n).toFixed(2)}`).join(" | "));
console.log("per epic kill: a fight at its pit from 60 s before to 30 s after (any kill | 4+ fight | 6+ fight | kills in it):");
const per: Record<string, Record<string, number>> = {};
for (const obj of ["dragon", "elder", "baron", "herald", "grubs"] as ObjKey[]) {
  let tot = 0, anyk = 0, f4 = 0, f6 = 0, kk = 0;
  for (const g of games) for (const w of g.win) {
    if (w.obj !== obj || !w.taken) continue;
    tot++;
    const nearF = g.fights.filter((f) => f.near[PIT_R] === w.pit && ((f.t >= w.gone - 60 && f.t <= w.gone + 30) || (f.t < w.gone - 60 && f.end >= w.gone - 60)));
    if (nearF.length) { anyk++; kk += nearF.reduce((p, f) => p + f.kills, 0); }
    if (nearF.some((f) => f.size >= 4)) f4++;
    if (nearF.some((f) => f.size >= 6)) f6++;
  }
  if (!tot) continue;
  per[obj] = { perGame: tot / n, anyKill: anyk / tot, fight4: f4 / tot, fight6: f6 / tot, kills: kk / tot };
  console.log(`  ${obj.padEnd(7)} ${(tot / n).toFixed(2)}/game | ${(anyk / tot * 100).toFixed(1).padStart(4)}% | ${(f4 / tot * 100).toFixed(1).padStart(4)}% | ${(f6 / tot * 100).toFixed(1).padStart(4)}% | ${(kk / tot).toFixed(2)}`);
}
out.perEpic = per;
console.log(`champions within ${NEAR_R} u of the pit at the 1-min frame before the kill (taker mean | other mean | other 0 | other 1-2 | other 3+):`);
const att: Record<string, Record<string, number>> = {};
for (const obj of ["dragon", "elder", "baron", "herald"] as ObjKey[]) {
  const rows = games.flatMap((g) => g.win).filter((w) => w.obj === obj && w.taken && w.near).map((w) => w.near!);
  if (!rows.length) continue;
  const m = rows.length;
  att[obj] = { taker: rows.reduce((p, r) => p + r[0], 0) / m, other: rows.reduce((p, r) => p + r[1], 0) / m, other0: rows.filter((r) => r[1] === 0).length / m, other12: rows.filter((r) => r[1] >= 1 && r[1] <= 2).length / m, other3: rows.filter((r) => r[1] >= 3).length / m };
  const x = att[obj];
  console.log(`  ${obj.padEnd(7)} ${x.taker.toFixed(2)} | ${x.other.toFixed(2)} | ${(x.other0 * 100).toFixed(1).padStart(4)}% | ${(x.other12 * 100).toFixed(1).padStart(4)}% | ${(x.other3 * 100).toFixed(1).padStart(4)}%`);
}
out.attendance = att;
// engine only
console.log("-- engine only --");
console.log("champions within 3,000 u of the pit when the monster spawns (stronger-presence side | other | both sides 2+):");
for (const obj of ["dragon", "elder", "baron", "herald", "grubs"] as ObjKey[]) {
  const rows = games.flatMap((g) => g.win).filter((w) => w.obj === obj && w.atSpawn).map((w) => w.atSpawn!);
  if (!rows.length) continue;
  const m = rows.length;
  console.log(`  ${obj.padEnd(7)} ${(rows.reduce((p, r) => p + Math.max(r[0], r[1]), 0) / m).toFixed(2)} | ${(rows.reduce((p, r) => p + Math.min(r[0], r[1]), 0) / m).toFixed(2)} | ${(rows.filter((r) => r[0] >= 2 && r[1] >= 2).length / m * 100).toFixed(1)}%`);
}
console.log("taker's plan at the kill, and the median minute of the first one:");
for (const obj of ["dragon", "elder", "baron", "herald", "grubs"] as ObjKey[]) {
  const ws = games.flatMap((g) => g.win).filter((w) => w.obj === obj && w.taken);
  if (!ws.length) continue;
  const c: Record<string, number> = {};
  for (const w of ws) c[w.plan ?? "-"] = (c[w.plan ?? "-"] ?? 0) + 1;
  const first = games.map((g) => g.win.filter((w) => w.obj === obj && w.taken).map((w) => w.gone).sort((x, y) => x - y)[0]).filter((x) => x !== undefined).sort((x, y) => x - y);
  console.log(`  ${obj.padEnd(7)} ` + Object.entries(c).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${(v / ws.length * 100).toFixed(0)}%`).join(" | ") + ` | first at ${(first[Math.floor(first.length / 2)] / 60).toFixed(1)} min`);
}
console.log("fight-module fights with 6+ members: per game | at a pit | objective fight | ended without a kill | by origin");
for (const ph of PHASES) {
  const fs = games.flatMap((g) => g.mod).filter((f) => f.size >= 6 && (ph === "all" || phaseOf(f.t) === ph));
  if (!fs.length) continue;
  const og: Record<string, number> = {};
  for (const f of fs) og[f.origin] = (og[f.origin] ?? 0) + 1;
  console.log(`  ${ph.padEnd(5)} ${(fs.length / n).toFixed(2)} | pit ${(fs.filter((f) => f.pit).length / fs.length * 100).toFixed(1)}% | objective ${(fs.filter((f) => f.obj).length / fs.length * 100).toFixed(1)}% | no kill ${(fs.filter((f) => !f.kills).length / fs.length * 100).toFixed(1)}% | ${Object.entries(og).map(([k, v]) => `${k} ${(v / n).toFixed(2)}`).join(" ")}`);
}
const top = (o: Record<string, number>, k = 14) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, k).map(([key, v]) => `${key} ${(v / n).toFixed(2)}`).join(" | ");
console.log("plans started per game: " + top(plans, 20));
console.log("plans aborted per game: " + top(aborts, 20));
console.log("objective calls per game (hover = thinks spent hovering, 2.5 s each): " + top(calls, 30));
if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify(out, null, 1));
