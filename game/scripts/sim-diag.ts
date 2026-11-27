// Engine-only check of the things that look wrong to a viewer (no renderer, so it is fast): champions under an
// enemy turret that is not shooting, enemies side by side without a fight (lane opponents after laning, a jungler
// who came to gank), standing frozen and dithering by situation, fight flicker, and what the herald does.
// Same rosters and game seeds as scripts/view-diag.ts, so a change can be compared before / after.
//   node scripts/run-ts.mjs scripts/sim-diag.ts [games=20]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, applySimTune } from "../src/match/engine";
import * as Summoners from "../src/match/summoners";
import type { Unit } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { BARON_PIT, FOUNTAIN } from "../src/match/map";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"));
const N = Number(process.argv[3] ?? 20);
// SIM_TUNE=towerGrace:1,gankCd:10 overrides the behaviour knobs (engine.ts SIM_TUNE) for this run
applySimTune(process.env.SIM_TUNE);
// SUM_TUNE=tpLane:0,tpJoin:0 overrides how Teleport is used (summoners.ts SUM_TUNE)
Summoners.applySumTune(process.env.SUM_TUNE);
const TRACE = process.env.TRACE ? process.env.TRACE.split(",") : null;
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
s.user = "__nobody__";
const rr = new Rng(3);
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

const DT = 0.25;
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const add = (o: Record<string, number>, k: string, v = 1) => { o[k] = (o[k] ?? 0) + v; };
const pct = (a: number, b: number) => `${b ? ((a / b) * 100).toFixed(1) : "0.0"}%`;
const q = (xs: number[], p: number) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const fmtRec = (o: Record<string, number>, f = (v: number) => v.toFixed(0)) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${f(v)}`).join(", ");
const perGame = (v: number) => (v / N).toFixed(1);

const aliveT: Record<string, number> = {}, idleT: Record<string, number> = {}, moveT: Record<string, number> = {}, revs: Record<string, number> = {};
const longIdle: Record<string, number> = {}, win: Record<string, number> = {}, dither: Record<string, number> = {};
const idleSamples: { g: number; t: number; who: string; ctx: string; len: number }[] = [];
const jumps: Record<string, number> = {};
// enemies within 400u, neither in a fight
const pairSec: Record<string, number> = {};
const pairSamples: { g: number; t: number; a: string; b: string; len: number; tasks: string; phase: string }[] = [];
// under a standing enemy turret, not in a fight
const turSec: Record<string, number> = {}, turFire: Record<string, number> = {};
const turSamples: { g: number; t: number; who: string; where: string; len: number; fired: number }[] = [];
// what the champion was doing while exposed (no wave), and who died to a turret outside a fight
const turTask: Record<string, number> = {};
const siegeSec: Record<string, number> = {};
const gankStart: Record<string, number> = {}, gankEnd: Record<string, number> = {};
let kills10 = 0;
const turDeaths: { g: number; t: number; who: string; task: string; sinceFight: number; where: string }[] = [];
// a jungler on a gank standing next to its prey without a fight
const gankHover: number[] = [];
const gankSamples: { g: number; t: number; who: string; len: number }[] = [];
// herald
const heraldDelay: number[] = [], heraldFromPit: number[] = [];
let heraldsTaken = 0, heraldCharges = 0;
const fightDur: number[] = [], fightSize: number[] = [];
let fightsAll = 0, fightsShort = 0, refights = 0, rejoin = 0;
let killsAll = 0, turretKills = 0, soloKills = 0, gameMin = 0;
/** summoner spell uses, by spell and reason (summoners.ts usage) */
const sumUsed: Record<string, number> = {};
/** how many of the ten players take each spell, summed over the games */
const sumHeld: Record<string, number> = {};
let turretDeathsOut = 0; // died to a turret while not in a fight
const firstKill: number[] = [], firstTurret: number[] = [];
let towers = 0;

const rng = new Rng(21);
for (let g = 0; g < N; g++) {
  const [a, b] = rng.shuffle([...s.lck]).slice(0, 2);
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: d.picks, seed: 1000 + g });
  const nm = (u: Unit) => `${u.side ? "R" : "B"}:${u.name}(${u.champ.name})`;
  const ctxOf = (u: Unit): string => {
    if (Summoners.channel(e, u)) return "teleport-channel";
    if (u.task === "recall") return u.recallEnd !== undefined ? "recall-channel" : "recall-walk";
    if (u.fightId) return "fight";
    if (d2(u, FOUNTAIN[u.side]) < 1300) return "fountain";
    if (e.camps.some((c) => d2(u, c.pos) < 350)) return "camp";
    for (const o of Object.values(e.obj)) if (o.alive && d2(u, o.pos) < 900) return "pit";
    if (e.turrets.some((t) => t.alive && t.side !== u.side && d2(u, t.pos) < 800)) return "at-enemy-turret";
    return u.task;
  };
  const prev = e.units.map((u) => ({ x: u.x, y: u.y, alive: u.alive, dx: 0, dy: 0, d: 0, fid: u.fightId }));
  const idle = e.units.map(() => ({ len: 0, ctx: "", at: 0 }));
  const wnd = e.units.map((u) => ({ n: 0, L: 0, x: u.x, y: u.y, ok: true }));
  const pair = new Map<string, { len: number; at: number; tasks: string; phase: string }>();
  const tur = new Map<string, { len: number; at: number; where: string; fired: number }>();
  const hover = e.units.map(() => ({ len: 0, at: 0 }));
  const liveFights = new Map<number, { start: number; maxN: number; x: number; y: number; members: Set<number>; left: Set<number> }>();
  const ended: { t: number; x: number; y: number; members: Set<number> }[] = [];
  let evSeen = 0, fxSeen = 0, heraldAt = -1;
  const shotAt = e.units.map(() => -99);
  const taskBefore = e.units.map((u) => u.task as string);
  const fightEndAt = e.units.map(() => -99);
  /** step in which each unit's Teleport landed (not a position bug) */
  const tpLanded = e.units.map(() => -99);

  while (!e.over && e.t < 3600) {
    e.step();
    const t = e.t;
    // new effects: turret shots (who is being shot) and the herald's charge
    for (const f of e.fx) {
      if (f.id <= fxSeen) continue;
      if (f.kind === "tower" && f.to !== undefined) shotAt[f.to] = t;
      if (f.kind === "sum" && f.sum === "teleport" && f.from !== undefined && f.to === f.from) tpLanded[f.from] = t;
      if (f.kind === "dash" && f.text === "전령 돌진") {
        heraldCharges++;
        heraldFromPit.push(d2({ x: f.tx, y: f.ty }, BARON_PIT));
        if (heraldAt >= 0) heraldDelay.push(t - heraldAt);
      }
    }
    fxSeen = e.fxSeq;
    e.units.forEach((u, i) => {
      const p = prev[i];
      if (u.alive && p.alive) {
        const dx = u.x - p.x, dy = u.y - p.y, dd = Math.hypot(dx, dy);
        const c = ctxOf(u);
        add(aliveT, c, DT);
        const vmax = e.speed(u) * DT;
        const home = (d2(u, FOUNTAIN[u.side]) < 260 && dd > 800) || tpLanded[i] === t;
        if (dd > vmax * 1.5 + 40 && !home) {
          add(jumps, p.fid || u.fightId ? "in a fight" : `outside a fight (${u.task})`);
          wnd[i].ok = false;
        }
        if (dd < 0.5) {
          add(idleT, c, DT);
          if (idle[i].len === 0) { idle[i].ctx = c; idle[i].at = t; }
          idle[i].len += DT;
        } else {
          if (idle[i].len >= 6) { add(longIdle, idle[i].ctx); idleSamples.push({ g, t: idle[i].at, who: nm(u), ctx: idle[i].ctx, len: idle[i].len }); }
          idle[i].len = 0;
        }
        if (dd > 15) {
          add(moveT, c, DT);
          if (p.d > 15 && (dx * p.dx + dy * p.dy) / (dd * p.d) < -0.7) add(revs, c);
        }
        const w = wnd[i];
        w.n++; w.L += dd;
        if (w.n >= 16) {
          if (w.ok) { add(win, c); if (w.L > 400 && d2(u, w) < w.L * 0.25) add(dither, c); }
          w.n = 0; w.L = 0; w.x = u.x; w.y = u.y; w.ok = true;
        }
        p.dx = dx; p.dy = dy; p.d = dd;
      } else {
        if (idle[i].len >= 6) { add(longIdle, idle[i].ctx); idleSamples.push({ g, t: idle[i].at, who: nm(u), ctx: idle[i].ctx, len: idle[i].len }); }
        idle[i].len = 0;
        wnd[i] = { n: 0, L: 0, x: u.x, y: u.y, ok: true };
        p.d = 0;
      }
      if (p.fid && !u.fightId) fightEndAt[i] = t;
      if (p.fid && !u.fightId && u.alive) liveFights.get(p.fid)?.left.add(i);
      if (u.fightId && u.fightId !== p.fid && liveFights.get(u.fightId)?.left.has(i)) rejoin++;
      p.x = u.x; p.y = u.y; p.alive = u.alive; p.fid = u.fightId;
    });
    // enemies next to each other with no fight
    const free = e.units.filter((u) => u.alive && u.task !== "recall" && u.recallEnd === undefined && !u.fightId);
    const seenPair = new Set<string>();
    for (const x of free) {
      if (x.side !== 0) continue;
      for (const y of free) {
        if (y.side !== 1 || d2(x, y) > 400) continue;
        const phase = e.laningPhase() ? "laning" : "after 14";
        const kind = x.task === "gank" || y.task === "gank" ? "gank" : x.task === "lane" && y.task === "lane" ? "lane pair" : "other";
        add(pairSec, `${phase}: ${kind}`, DT);
        const key = `${x.i}-${y.i}`;
        seenPair.add(key);
        const pr = pair.get(key) ?? { len: 0, at: t, tasks: `${x.task}/${y.task}`, phase };
        pr.len += DT;
        pair.set(key, pr);
      }
    }
    for (const [key, pr] of pair) if (!seenPair.has(key)) {
      if (pr.len >= 4) { const [x, y] = key.split("-").map(Number); pairSamples.push({ g, t: pr.at, a: nm(e.units[x]), b: nm(e.units[y]), len: pr.len, tasks: pr.tasks, phase: pr.phase }); }
      pair.delete(key);
    }
    // sieging: hitting a structure, or still on the way / waiting for the wave
    for (const u of e.units) {
      if (!u.alive || u.fightId || u.task !== "siege") continue;
      const hitting = e.turrets.some((x) => x.alive && x.side !== u.side && d2(x.pos, u) <= 750) || e.inhibs.some((x) => x.alive && x.side !== u.side && d2(x.pos, u) <= 700);
      add(siegeSec, hitting ? "hitting a structure" : "not hitting", DT);
    }
    // a ganking jungler within 800u of an enemy laner, no fight
    for (const u of e.units) {
      const h = hover[u.i];
      const near = u.alive && !u.fightId && u.task === "gank" && e.units.some((v) => v.alive && v.side !== u.side && !v.fightId && v.role !== "Jungle" && d2(u, v) < 800);
      if (near) { if (h.len === 0) h.at = t; h.len += DT; }
      else if (h.len > 0) { gankHover.push(h.len); if (h.len >= 4) gankSamples.push({ g, t: h.at, who: nm(u), len: h.len }); h.len = 0; }
    }
    // under an enemy turret, not in a fight
    const seenTur = new Set<string>();
    e.turrets.forEach((tw, ti) => {
      if (!tw.alive) return;
      for (const u of e.units) {
        if (!u.alive || u.side === tw.side || u.fightId || d2(u, tw.pos) > 775) continue;
        // the engine's own rule (what turretShots uses), so "no wave" here is exactly when the turret may shoot
        const wave = e.waveAt(tw);
        const k = `${tw.lane === "nexus" ? "nexus turret" : "lane turret"}, ${wave ? "wave there" : "no wave"}`;
        add(turSec, k, DT);
        const fired = t - shotAt[u.i] < 1.05;
        if (fired) add(turFire, k, DT);
        if (!wave) {
          add(turTask, t - fightEndAt[u.i] < 4 ? `${u.task}, just out of a fight` : u.task, DT);
          const key = `${ti}-${u.i}`;
          seenTur.add(key);
          const x = tur.get(key) ?? { len: 0, at: t, where: `${tw.lane} T${tw.tier}`, fired: 0 };
          x.len += DT;
          if (fired) x.fired += DT;
          tur.set(key, x);
        }
      }
    });
    for (const [key, x] of tur) if (!seenTur.has(key)) {
      if (x.len >= 3) turSamples.push({ g, t: x.at, who: nm(e.units[Number(key.split("-")[1])]), where: x.where, len: x.len, fired: x.fired });
      tur.delete(key);
    }
    // fights
    for (const [id, f] of e.fights) {
      const m = e.units.filter((u) => u.alive && u.fightId === id);
      let lf = liveFights.get(id);
      if (!lf) {
        lf = { start: f.start, maxN: 0, x: f.x, y: f.y, members: new Set(), left: new Set() };
        liveFights.set(id, lf);
        fightsAll++;
        if (ended.some((x) => t - x.t < 5 && d2(x, f) < 900 && m.some((u) => x.members.has(u.i)))) refights++;
      }
      lf.maxN = Math.max(lf.maxN, m.length);
      lf.x = f.x; lf.y = f.y;
      for (const u of m) lf.members.add(u.i);
    }
    for (const [id, lf] of liveFights) if (!e.fights.has(id)) {
      fightDur.push(t - lf.start);
      fightSize.push(lf.maxN);
      if (t - lf.start < 1.5) fightsShort++;
      ended.push({ t, x: lf.x, y: lf.y, members: lf.members });
      liveFights.delete(id);
    }
    for (; evSeen < e.events.length; evSeen++) {
      const ev = e.events[evSeen];
      if (ev.type === "herald") { heraldsTaken++; heraldAt = t; }
      if (ev.type === "first_turret") firstTurret.push(t / 60);
      if (ev.type === "solo") soloKills++;
      if (ev.type !== "kill" && ev.type !== "first_blood" && ev.type !== "solo") continue;
      if (ev.type === "first_blood") firstKill.push(t / 60);
      killsAll++;
      if (t < 600) kills10++;
      if (ev.actor === undefined) {
        turretKills++;
        // the victim's fight id is cleared on death; the step before tells whether it was fighting
        if (ev.victim !== undefined && t - fightEndAt[ev.victim] > 0.3) {
          turretDeathsOut++;
          const v = e.units[ev.victim];
          const tw = e.turrets.filter((x) => x.side !== v.side).sort((p, o) => d2(p.pos, v) - d2(o.pos, v))[0];
          turDeaths.push({ g, t, who: nm(v), task: taskBefore[ev.victim], sinceFight: t - fightEndAt[ev.victim], where: `${tw.lane} T${tw.tier}` });
        }
      }
    }
    // ganks: how many start, and how they end (a fight, or called off / timed out)
    e.units.forEach((u, i) => {
      if (u.role !== "Jungle") return;
      const early = t < 600 ? "before 10:00" : t < 840 ? "10:00-14:00" : "after 14:00";
      if (u.task === "gank" && taskBefore[i] !== "gank") add(gankStart, early);
      if (taskBefore[i] === "gank" && u.task !== "gank") add(gankEnd, `${early}: ${u.fightId ? "fight" : !u.alive ? "died" : "no fight"}`);
    });
    e.units.forEach((u, i) => { taskBefore[i] = u.task; });
    // TRACE=game,name,fromSec,toSec prints one champion step by step
    if (TRACE && g === Number(TRACE[0]) && t >= Number(TRACE[2]) && t <= Number(TRACE[3])) {
      const u = e.units.find((x) => x.name === TRACE[1]);
      if (u) {
        const tw = e.turrets.filter((x) => x.alive && x.side !== u.side).sort((p, o) => d2(p.pos, u) - d2(o.pos, u))[0];
        const foe = e.units.filter((x) => x.alive && x.side !== u.side).sort((p, o) => d2(p, u) - d2(o, u))[0];
        console.log(`  ${clock(t)}.${Math.round((t % 1) * 100)} ${nm(u)} ${u.alive ? "" : "DEAD "}task ${u.task} hp ${Math.round((u.hp / u.maxHp) * 100)}% at ${Math.round(u.x)},${Math.round(u.y)} fight ${u.fightId} goal ${u.goal ? `${Math.round(u.goal.x)},${Math.round(u.goal.y)}` : "-"} | turret ${tw.lane} T${tw.tier} ${Math.round(d2(tw.pos, u))}u wave ${e.waveAt(tw)} | nearest foe ${foe ? `${nm(foe)} ${Math.round(d2(foe, u))}u task ${foe.task}` : "-"}`);
      }
    }
  }
  gameMin += e.t / 60;
  for (const [k, v] of Object.entries(Summoners.usage(e))) add(sumUsed, k, v);
  for (const u of e.units) for (const sp of Summoners.summonersOf(u)) add(sumHeld, sp);
  towers += e.towers[0] + e.towers[1];
}

console.log(`===== ${N} games, ${(gameMin / N).toFixed(1)} min per game, kills ${perGame(killsAll)} (solo ${perGame(soloKills)}, no killer = turret ${perGame(turretKills)}, of those outside a fight ${perGame(turretDeathsOut)}), towers ${perGame(towers)} =====`);
console.log(`first kill ${(firstKill.reduce((a, b) => a + b, 0) / Math.max(1, firstKill.length)).toFixed(1)} min, first turret ${(firstTurret.reduce((a, b) => a + b, 0) / Math.max(1, firstTurret.length)).toFixed(1)} min`);
console.log(`\n[TURRET] champion-seconds per game under a standing enemy turret and not in a fight:`);
for (const [k, v] of Object.entries(turSec).sort((p, o) => o[1] - p[1])) console.log(`    ${k.padEnd(28)} ${perGame(v).padStart(7)} s, being shot ${pct(turFire[k] ?? 0, v)}`);
for (const x of turSamples.sort((p, o) => o.len - p.len).slice(0, 8)) console.log(`    g${x.g} ${clock(x.t)} ${x.who} at ${x.where} for ${x.len.toFixed(1)}s (shot at for ${x.fired.toFixed(1)}s)`);
console.log(`    no wave, by what the champion was doing (s per game): ${fmtRec(turTask, (v) => perGame(v))}`);
console.log(`    died to a turret outside a fight: ${perGame(turDeaths.length)} per game`);
for (const x of turDeaths.slice(0, 14)) console.log(`      g${x.g} ${clock(x.t)} ${x.who} at ${x.where} (task ${x.task}, ${x.sinceFight > 90 ? "no fight before" : `${x.sinceFight.toFixed(1)}s after its fight`})`);
console.log(`\n[SIDE BY SIDE] enemies within 400u, neither in a fight, champion-pair seconds per game: ${fmtRec(pairSec, (v) => perGame(v))}`);
for (const x of pairSamples.sort((p, o) => o.len - p.len).slice(0, 10)) console.log(`    g${x.g} ${clock(x.t)} ${x.a} and ${x.b} ${x.len.toFixed(1)}s (${x.tasks}, ${x.phase})`);
console.log(`\n[GANK] stretches of a ganking jungler within 800u of an enemy laner without a fight: ${perGame(gankHover.length)} per game, median ${q(gankHover, 0.5).toFixed(1)}s, p90 ${q(gankHover, 0.9).toFixed(1)}s, max ${Math.max(0, ...gankHover).toFixed(1)}s, 4s+ ${perGame(gankHover.filter((x) => x >= 4).length)} per game`);
for (const x of gankSamples.sort((p, o) => o.len - p.len).slice(0, 5)) console.log(`    g${x.g} ${clock(x.t)} ${x.who} hovered ${x.len.toFixed(1)}s`);
console.log(`    ganks started per game: ${fmtRec(gankStart, (v) => perGame(v))}; ended: ${fmtRec(gankEnd, (v) => perGame(v))}; kills before 10:00 ${perGame(kills10)}`);
console.log(`\n[HERALD] taken ${perGame(heraldsTaken)} per game, charges ${perGame(heraldCharges)}; charge starts ${q(heraldFromPit, 0.5).toFixed(0)}u from the pit (median, min ${Math.min(99999, ...heraldFromPit).toFixed(0)}); delay after the take: median ${q(heraldDelay, 0.5).toFixed(1)}s, p90 ${q(heraldDelay, 0.9).toFixed(1)}s, max ${Math.max(0, ...heraldDelay).toFixed(1)}s`);
console.log(`\n[SIEGE] champion-seconds per game with the siege task: ${fmtRec(siegeSec, (v) => perGame(v))}`);
console.log(`\n[MOVEMENT] jumps per game: ${fmtRec(jumps, (v) => perGame(v))}`);
const totalAlive = Object.values(aliveT).reduce((p, o) => p + o, 0);
for (const [k, v] of Object.entries(aliveT).sort((p, o) => o[1] - p[1])) {
  console.log(`    ${k.padEnd(16)} ${pct(v, totalAlive).padStart(6)} of time | frozen ${pct(idleT[k] ?? 0, v).padStart(6)} | frozen 6s+ /game ${perGame(longIdle[k] ?? 0).padStart(6)} | reversals per moving min ${(((revs[k] ?? 0) / Math.max(1, moveT[k] ?? 0)) * 60).toFixed(1).padStart(5)} | 4s windows going nowhere ${pct(dither[k] ?? 0, win[k] ?? 0)}`);
}
const odd = idleSamples.filter((x) => !["recall-channel", "fountain", "camp", "pit"].includes(x.ctx)).sort((p, o) => o.len - p.len);
for (const x of odd.slice(0, 6)) console.log(`    g${x.g} ${clock(x.t)} ${x.who} stood still ${x.len.toFixed(1)}s (${x.ctx})`);
console.log(`\n[FIGHTS] per game ${perGame(fightsAll)}; shorter than 1.5s ${perGame(fightsShort)}; restarted at the same spot within 5s ${perGame(refights)}; left and re-joined the same fight ${perGame(rejoin)}; length median ${q(fightDur, 0.5).toFixed(1)}s; size 2: ${perGame(fightSize.filter((x) => x <= 2).length)}, 3: ${perGame(fightSize.filter((x) => x === 3).length)}, 4-5: ${perGame(fightSize.filter((x) => x >= 4 && x <= 5).length)}, 6+: ${perGame(fightSize.filter((x) => x >= 6).length)}`);

// summoner spells: uses per game, and per player who takes the spell
{
  const bySpell: Record<string, number> = {};
  for (const [k, v] of Object.entries(sumUsed)) add(bySpell, k.split(":")[0], v);
  console.log(`\n[SUMMONERS] uses per game (per holder): ${Object.entries(bySpell).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${perGame(v)} (${(v / Math.max(1, sumHeld[k] ?? 0)).toFixed(1)})`).join(", ")}`);
  console.log(`    by reason: ${Object.entries(sumUsed).filter(([k]) => k.includes(":")).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${perGame(v)}`).join(", ")}`);
}
