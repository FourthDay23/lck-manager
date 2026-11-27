// What a viewer would find odd or tiring in the match view, measured without a browser. Real engine games run
// through MatchRenderer with a stub canvas, with the same loop as ui/screens/Series.tsx MatchView (speed button,
// "한타 실시간" on), and the script counts:
//   engine  : position jumps outside fights, standing frozen, back-and-forth dithering, enemies side by side without a
//             fight, champions under an enemy turret that never shoots, fights that flicker or restart
//   playback: how often the clock switches between fast and real time
//   camera  : cut intervals in real seconds, zoom jumps, ping-pong cuts, caption turnover, icon overlap, on-screen speed
//   node scripts/run-ts.mjs scripts/view-diag.ts [games=6] [speed=2] [slowmo=1]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import type { Unit } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { FOUNTAIN } from "../src/match/map";
import * as Fight from "../src/match/fight";
import { Pacer } from "../src/match/pacing";

const noop = () => undefined;
const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop: noop }) : noop), set: () => true });
(globalThis as Record<string, unknown>).Image = class { src = ""; complete = false; naturalWidth = 0; crossOrigin = ""; };
const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
const { MatchRenderer, RES } = await import("../src/match/render");

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"));
const N = Number(process.argv[3] ?? 6);
const SPEED = Number(process.argv[4] ?? 8);
const SLOWMO = (process.argv[5] ?? "1") !== "0";
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

// ---- engine tallies ----
const aliveT: Record<string, number> = {}, idleT: Record<string, number> = {}, moveT: Record<string, number> = {}, revs: Record<string, number> = {};
const longIdle: Record<string, number> = {};
const idleSamples: { g: number; t: number; who: string; ctx: string; len: number }[] = [];
const jumps: Record<string, number> = {};
const jumpSamples: { g: number; t: number; who: string; d: number; task: string }[] = [];
const win: Record<string, number> = {}, dither: Record<string, number> = {};
let ignoreLane = 0, ignoreOther = 0, bystander = 0;
const ignoreSamples: { g: number; t: number; a: string; b: string; len: number; tasks: string }[] = [];
const underTurret: Record<string, number> = {};
const turretSamples: { g: number; t: number; who: string; where: string; len: number }[] = [];
const fightDur: number[] = [], fightSize: number[] = [];
let fightsAll = 0, fightsShort = 0, refights = 0, rejoin = 0, spreadWide = 0, fightSteps = 0;
let remoteKills = 0, killsAll = 0, turretKills = 0;
let gameMin = 0;

// ---- playback / camera tallies ----
let realMs = 0, slowMs = 0;
const segLen: number[] = [], gapLen: number[] = [];
const cutGap: number[] = [];
const cutWhy: Record<string, number> = {};
let cuts = 0, zoomJumps = 0, farCuts = 0, pingPong = 0;
const viewMs: Record<string, number> = {};
const capGap: number[] = [];
let captions = 0, labels = 0;
let visUnits = 0, overlapped = 0, visUnitsWide = 0, overlappedWide = 0;
const scrSpeedFast: number[] = [], scrSpeedSlow: number[] = [];
let banners = 0;
let realSteps = 0, realQuiet = 0, realPosition = 0, cutsReal = 0, cutsFast = 0;
const realBySize: Record<string, number> = {};
const fightFill: number[] = [];
let fightVis = 0, fightCovered = 0;
const labelMs: Record<string, number> = {};
const paceMs: Record<string, number> = {};
let paceChanges = 0, closeMs = 0, closeMovingMs = 0;
const fightFillWide: number[] = [];
let fightVisWide = 0, fightCoveredWide = 0;

const rng = new Rng(21);
for (let g = 0; g < N; g++) {
  const [a, b] = rng.shuffle([...s.lck]).slice(0, 2);
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: d.picks, seed: 1000 + g });
  const r = new MatchRenderer(canvas, e, data.ddVersion, null);
  const nm = (u: Unit) => `${u.side ? "R" : "B"}:${u.name}(${u.champ.name})`;
  const ctxOf = (u: Unit): string => {
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
  const pair = new Map<string, { len: number; at: number; tasks: string }>();
  const tur = new Map<string, { len: number; at: number; where: string }>();
  const liveFights = new Map<number, { start: number; maxN: number; x: number; y: number; members: Set<number>; left: Set<number> }>();
  const ended: { t: number; x: number; y: number; members: Set<number> }[] = [];
  let evSeen = 0;
  let hpPrev = e.units.map((u) => u.hp);
  let dmgAt = -99;
  /** called after every engine step while the clock is in real time */
  const sampleReal = () => {
    if (e.units.some((u, i) => u.hp < hpPrev[i] - 0.5 || (!u.alive && hpPrev[i] > 0))) dmgAt = e.t;
    realSteps++;
    if (e.t - dmgAt > 1) realQuiet++;
    let big = 0, pos = false;
    for (const id of e.fights.keys()) {
      const m = e.units.filter((u) => u.alive && u.fightId === id);
      const took = Math.max(e.fights.get(id)?.size ?? 0, m.length); // everyone who took part, as pacing.ts counts it
      if (took >= 4 && new Set(m.map((u) => u.side)).size === 2 && took > big) {
        big = took;
        pos = Fight.phaseOf(e, id, 0) === "position" && Fight.phaseOf(e, id, 1) === "position";
      }
    }
    add(realBySize, big >= 8 ? "8-10" : big >= 6 ? "6-7" : big >= 4 ? "4-5" : "after the fight (tail)", DT);
    if (pos) realPosition++;
  };

  const sample = () => {
    const t = e.t;
    e.units.forEach((u, i) => {
      const p = prev[i];
      if (u.alive && p.alive) {
        const dx = u.x - p.x, dy = u.y - p.y, dd = Math.hypot(dx, dy);
        const c = ctxOf(u);
        add(aliveT, c, DT);
        const vmax = e.speed(u) * DT;
        const home = d2(u, FOUNTAIN[u.side]) < 200 && dd > 800; // recall landing (each unit has its own spot near the fountain)
        if (dd > vmax * 1.5 + 40 && !home) {
          const k = p.fid || u.fightId ? "in a fight (dash/blink/flash/hook)" : "outside any fight";
          add(jumps, k);
          if (!(p.fid || u.fightId) && jumpSamples.length < 400) jumpSamples.push({ g, t, who: nm(u), d: Math.round(dd), task: u.task });
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
      if (p.fid && !u.fightId && u.alive) liveFights.get(p.fid)?.left.add(i);
      if (u.fightId && u.fightId !== p.fid && liveFights.get(u.fightId)?.left.has(i)) rejoin++;
      p.x = u.x; p.y = u.y; p.alive = u.alive; p.fid = u.fightId;
    });
    // enemies next to each other with no fight
    const free = e.units.filter((u) => u.alive && u.task !== "recall" && u.recallEnd === undefined);
    const seenPair = new Set<string>();
    for (const x of free) {
      if (x.side !== 0) continue;
      for (const y of free) {
        if (y.side !== 1 || d2(x, y) > 400) continue;
        if (x.fightId && y.fightId) continue;
        if (x.fightId || y.fightId) { bystander += DT; continue; }
        const lanePair = e.laningPhase() && x.task === "lane" && y.task === "lane";
        if (lanePair) { ignoreLane += DT; continue; }
        ignoreOther += DT;
        const key = `${x.i}-${y.i}`;
        seenPair.add(key);
        const pr = pair.get(key) ?? { len: 0, at: t, tasks: `${x.task}/${y.task}` };
        pr.len += DT;
        pair.set(key, pr);
      }
    }
    for (const [key, pr] of pair) if (!seenPair.has(key)) {
      if (pr.len >= 4) { const [x, y] = key.split("-").map(Number); ignoreSamples.push({ g, t: pr.at, a: nm(e.units[x]), b: nm(e.units[y]), len: pr.len, tasks: pr.tasks }); }
      pair.delete(key);
    }
    // under an enemy turret, not in a fight (turrets only shoot units that are in a fight)
    const seenTur = new Set<string>();
    e.turrets.forEach((tw, ti) => {
      if (!tw.alive) return;
      for (const u of e.units) {
        if (!u.alive || u.side === tw.side || u.fightId || d2(u, tw.pos) > 775) continue;
        // the engine's own rule for "a wave is on this turret" (also used by turretShots), so this agrees with sim-diag.ts
        const wave = e.waveAt(tw);
        const k = tw.lane === "nexus" ? (wave ? "nexus turret, wave there" : "nexus turret, no wave") : wave ? "wave at the turret" : "no wave there";
        add(underTurret, k, DT);
        if (k === "no wave there") {
          const key = `${ti}-${u.i}`;
          seenTur.add(key);
          const x = tur.get(key) ?? { len: 0, at: t, where: `${tw.lane} T${tw.tier}` };
          x.len += DT;
          tur.set(key, x);
        }
      }
    });
    for (const [key, x] of tur) if (!seenTur.has(key)) {
      if (x.len >= 3) turretSamples.push({ g, t: x.at, who: nm(e.units[Number(key.split("-")[1])]), where: x.where, len: x.len });
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
      fightSteps++;
      let far = 0;
      for (const u of m) for (const v of m) far = Math.max(far, d2(u, v));
      if (far > 3000) spreadWide++;
    }
    for (const [id, lf] of liveFights) if (!e.fights.has(id)) {
      const len = t - lf.start;
      fightDur.push(len);
      fightSize.push(lf.maxN);
      if (len < 1.5) fightsShort++;
      ended.push({ t, x: lf.x, y: lf.y, members: lf.members });
      liveFights.delete(id);
    }
    // kills from far away / by a turret
    for (; evSeen < e.events.length; evSeen++) {
      const ev = e.events[evSeen];
      if (ev.big || ["dragon", "soul", "elder", "grubs", "herald", "baron"].includes(ev.type)) banners++;
      if (ev.type !== "kill" && ev.type !== "first_blood" && ev.type !== "solo") continue;
      killsAll++;
      if (ev.actor === undefined) { turretKills++; continue; }
      if (ev.victim !== undefined && d2(e.units[ev.actor], e.units[ev.victim]) > 1600) remoteKills++;
    }
  };

  // ---- the MatchView loop (ui/screens/Series.tsx): the same Pacer decides the clock and the camera focus ----
  const pacer = new Pacer(e, SPEED);
  const frame = 1000 / 60;
  let now = 0, acc = 0, wasReal = false, segStart = 0, lastSegEnd = -1, resultSeq = 0;
  let lastCam = { ...r.cam }, lastCutAt = 0, lastCap = 0, lastLabel = "", lastTarget = SPEED;
  const camHist: { x: number; y: number; at: number }[] = [];
  let lastScr: ({ x: number; y: number } | null)[] = e.units.map(() => null);
  let fr = 0;
  while (!e.over && e.t < 3600) {
    now += frame;
    const gps = pacer.update(frame, SPEED, SLOWMO);
    // "real" = the clock is at (or heading for) real time: a teamfight or the moment after it
    const real = pacer.target <= 1;
    acc += (frame / 1000) * gps;
    let steps = 0;
    while (acc >= 0.25 && steps < 400 && !e.over) {
      r.beforeStep();
      e.step();
      sample();
      if (real) sampleReal();
      hpPrev = e.units.map((u) => u.hp);
      acc -= 0.25;
      steps++;
      if (pacer.brake(SPEED, SLOWMO)) { acc = Math.min(acc, 0.2); break; }
    }
    r.lerp = Math.min(1, acc / 0.25);
    r.setFocus(pacer.focus, pacer.size, now);
    if (pacer.result && pacer.result.seq !== resultSeq) { resultSeq = pacer.result.seq; r.sayResult(pacer.result, now); }
    realMs += frame;
    if (real) slowMs += frame;
    add(paceMs, pacer.target <= 1 ? "real time" : `${pacer.target}x`, frame);
    if (pacer.target !== lastTarget) { paceChanges++; lastTarget = pacer.target; }
    if (real && !wasReal) { segStart = now; if (lastSegEnd >= 0) gapLen.push((now - lastSegEnd) / 1000); }
    if (!real && wasReal) { segLen.push((now - segStart) / 1000); lastSegEnd = now; }
    wasReal = real;
    r.draw(now);
    const moved = Math.hypot(r.cam.x - lastCam.x, r.cam.y - lastCam.y);
    const cut = moved > 300 || Math.abs(r.cam.size - lastCam.size) > 400;
    if (r.cam.size < 12000) { closeMs += frame; if (!cut && moved > 2) closeMovingMs += frame; }
    if (cut) {
      cuts++;
      if (real) cutsReal++; else cutsFast++;
      cutGap.push((now - lastCutAt) / 1000);
      lastCutAt = now;
      add(cutWhy, r.cam.size >= 12000 ? "back to the whole map" : lastCam.size >= 12000 ? "into a teamfight" : "jump inside a close-up");
      const zr = Math.max(r.cam.size / lastCam.size, lastCam.size / r.cam.size);
      if (zr >= 1.5) zoomJumps++;
      if (Math.hypot(r.cam.x - lastCam.x, r.cam.y - lastCam.y) > Math.min(r.cam.size, lastCam.size) * 0.75) farCuts++;
      const back = camHist[camHist.length - 2];
      if (back && now - back.at < 6000 && Math.hypot(back.x - r.cam.x, back.y - r.cam.y) < 1200 && Math.hypot(lastCam.x - r.cam.x, lastCam.y - r.cam.y) > 1500) pingPong++;
      camHist.push({ x: r.cam.x, y: r.cam.y, at: now });
      lastScr = e.units.map(() => null);
    }
    lastCam = { ...r.cam };
    add(viewMs, r.cam.size >= 12000 ? "full map" : r.cam.size >= 6000 ? "lane / wide (6-9k)" : r.cam.size >= 4700 ? "medium (4.7-6k)" : "close (<4.7k)", frame);
    const cap = r.caption(now);
    if (cap && cap.at !== lastCap) {
      captions++;
      if (lastCap) capGap.push((cap.at - lastCap) / 1000);
      lastCap = cap.at;
      // CAPS=1: the lines of the first game as a viewer would read them (real s, game clock, tag, line)
      if (process.env.CAPS && g === 0) console.log(`  ${(now / 1000).toFixed(1).padStart(6)}s ${clock(e.t)} [${r.shotLabel} · ${pacer.target <= 1 ? "실시간" : pacer.target + "배속"}] ${cap.text}`);
    }
    if (r.shotLabel !== lastLabel) {
      labels++;
      lastLabel = r.shotLabel;
      if (process.env.CAPS && g === 0) console.log(`  ${(now / 1000).toFixed(1).padStart(6)}s ${clock(e.t)} LIVE -> ${r.shotLabel}`);
    }
    add(labelMs, r.shotLabel === "전체 맵" ? "full map" : "teamfight close-up", frame);
    // icons on top of each other, and how fast they cross the screen (buffer px, RES wide)
    if (fr++ % 6 === 0) {
      const size = r.cam.size < 9000 ? 22 : 15;
      const at = new Map(e.units.filter((u) => u.alive).map((u) => { const p = r.unitPos(u, now, false); return [u.i, { i: u.i, x: r.sx(p.x), y: r.sy(p.y) }] as const; }));
      const vis = [...at.values()].filter((p) => p.x > 0 && p.y > 0 && p.x < RES && p.y < RES);
      for (const p of vis) {
        const hit = vis.some((o) => o !== p && Math.abs(o.x - p.x) < size * 0.6 && Math.abs(o.y - p.y) < size * 0.6);
        if (r.cam.size >= 12000) { visUnitsWide++; if (hit) overlappedWide++; } else { visUnits++; if (hit) overlapped++; }
        const l = lastScr[p.i];
        if (l && !cut) {
          const v = Math.hypot(p.x - l.x, p.y - l.y) / ((frame * 6) / 1000) / RES; // screens per second
          if (v > 0.002) (real ? scrSpeedSlow : scrSpeedFast).push(v);
        }
      }
      // every fight of 4+ on screen, in whatever view it is shown (close-up or whole map): how much of the view it
      // fills and how many of its icons sit under another, as drawn
      for (const id of e.fights.keys()) {
        const m = e.units.filter((u) => u.alive && u.fightId === id).map((u) => at.get(u.i)!).filter((p) => p && p.x > 0 && p.y > 0 && p.x < RES && p.y < RES);
        if (m.length < 4) continue;
        const xs = m.map((p) => p.x), ys = m.map((p) => p.y);
        const fill = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / RES;
        const inClose = r.cam.size < 12000;
        (inClose ? fightFill : fightFillWide).push(fill);
        for (const p of m) {
          const hit = m.some((o) => o !== p && Math.abs(o.x - p.x) < size * 0.6 && Math.abs(o.y - p.y) < size * 0.6);
          if (inClose) { fightVis++; if (hit) fightCovered++; } else { fightVisWide++; if (hit) fightCoveredWide++; }
        }
      }
      const next: ({ x: number; y: number } | null)[] = e.units.map(() => null);
      for (const p of vis) next[p.i] = { x: p.x, y: p.y };
      lastScr = next;
    }
  }
  if (wasReal) segLen.push((now - segStart) / 1000);

  gameMin += e.t / 60;
  const st = Fight.stats(e);
  if (g === 0) console.log("fight ends (game 1):", fmtRec(st.ends), "| starts:", fmtRec(st.starts));
}

const perGame = (v: number) => (v / N).toFixed(1);
console.log(`\n===== ${N} games, ${gameMin.toFixed(0)} game min, playback ${SPEED}x (${SPEED} game s per real s), 한타 실시간 ${SLOWMO ? "on" : "off"} =====`);
console.log(`\n[ENGINE] position jumps per game: ${fmtRec(jumps, (v) => perGame(v))}`);
const byTask: Record<string, number> = {};
for (const x of jumpSamples) add(byTask, x.task);
console.log(`  outside-fight jumps by task: ${fmtRec(byTask)}`);
for (const x of jumpSamples.sort((p, o) => o.d - p.d).slice(0, 8)) console.log(`    g${x.g} ${clock(x.t)} ${x.who} jumped ${x.d}u (task ${x.task})`);
console.log(`\n[ENGINE] share of alive time by situation, and how much of it the champion does not move at all:`);
const totalAlive = Object.values(aliveT).reduce((p, o) => p + o, 0);
for (const [k, v] of Object.entries(aliveT).sort((p, o) => o[1] - p[1])) {
  console.log(`    ${k.padEnd(16)} ${pct(v, totalAlive).padStart(6)} of time | frozen ${pct(idleT[k] ?? 0, v).padStart(6)} | frozen 6s+ streaks/game ${perGame(longIdle[k] ?? 0).padStart(5)} | reversals per moving min ${(((revs[k] ?? 0) / Math.max(1, moveT[k] ?? 0)) * 60).toFixed(1).padStart(5)} | 4s windows going nowhere ${pct(dither[k] ?? 0, win[k] ?? 0)}`);
}
const odd = idleSamples.filter((x) => !["recall-channel", "fountain", "camp", "pit"].includes(x.ctx)).sort((p, o) => o.len - p.len);
console.log(`  longest frozen streaks outside recall/fountain/camp/pit (${odd.length} of 6s+ in all):`);
for (const x of odd.slice(0, 10)) console.log(`    g${x.g} ${clock(x.t)} ${x.who} stood still ${x.len.toFixed(1)}s (${x.ctx})`);
console.log(`\n[ENGINE] enemies within 400u and no fight, champion-pair seconds per game: lane opponents ${perGame(ignoreLane)}, anyone else ${perGame(ignoreOther)}; standing next to a fight without being in it ${perGame(bystander)}`);
for (const x of ignoreSamples.sort((p, o) => o.len - p.len).slice(0, 8)) console.log(`    g${x.g} ${clock(x.t)} ${x.a} and ${x.b} side by side ${x.len.toFixed(1)}s (${x.tasks})`);
console.log(`\n[ENGINE] under a standing enemy turret and not in a fight (the turret does not shoot), seconds per game: ${fmtRec(underTurret, (v) => perGame(v))}`);
for (const x of turretSamples.sort((p, o) => o.len - p.len).slice(0, 8)) console.log(`    g${x.g} ${clock(x.t)} ${x.who} at ${x.where} for ${x.len.toFixed(1)}s`);
console.log(`\n[ENGINE] fights per game ${perGame(fightsAll)}; shorter than 1.5s ${perGame(fightsShort)}; restarted at the same spot within 5s ${perGame(refights)}; a champion left and re-joined the same fight ${perGame(rejoin)}; steps with members 3000u+ apart ${pct(spreadWide, fightSteps)}`);
console.log(`  fight length (game s): median ${q(fightDur, 0.5).toFixed(1)}, p90 ${q(fightDur, 0.9).toFixed(1)}; size: 2 ${fightSize.filter((x) => x <= 2).length}, 3 ${fightSize.filter((x) => x === 3).length}, 4-5 ${fightSize.filter((x) => x >= 4 && x <= 5).length}, 6+ ${fightSize.filter((x) => x >= 6).length}`);
console.log(`  kills per game ${perGame(killsAll)}; killer 1600u+ away ${perGame(remoteKills)}; no killer (turret) ${perGame(turretKills)}`);

console.log(`\n[PLAYBACK] real viewing time per game ${(realMs / 1000 / N / 60).toFixed(1)} min, of which real-time teamfights ${(slowMs / 1000 / N / 60).toFixed(1)} min (${pct(slowMs, realMs)})`);
console.log(`  real-time stretches per game ${perGame(segLen.length)}: median ${q(segLen, 0.5).toFixed(1)}s, p10 ${q(segLen, 0.1).toFixed(1)}s, p90 ${q(segLen, 0.9).toFixed(1)}s`);
console.log(`  fast stretch between two of them (real s): median ${q(gapLen, 0.5).toFixed(1)}, under 1s ${pct(gapLen.filter((x) => x < 1).length, gapLen.length)}, under 2s ${pct(gapLen.filter((x) => x < 2).length, gapLen.length)}`);
console.log(`  real-time seconds by the biggest fight on at that moment: ${fmtRec(realBySize, (v) => pct(v, realSteps * DT))}`);
console.log(`  of the real-time seconds: nobody took damage in the last second ${pct(realQuiet, realSteps)}; both teams still positioning ${pct(realPosition, realSteps)}`);
console.log(`  time at each pace: ${fmtRec(paceMs, (v) => pct(v, realMs))}`);
console.log(`  pace changes per real minute ${(paceChanges / (realMs / 60000)).toFixed(1)} (in and out of real time ${((segLen.length * 2) / (realMs / 60000)).toFixed(1)})`);

console.log(`\n[CAMERA] cuts ${perGame(cuts)} per game, one every ${(realMs / 1000 / Math.max(1, cuts)).toFixed(1)} real s on average; gap median ${q(cutGap, 0.5).toFixed(1)}s, under 1s ${pct(cutGap.filter((x) => x < 1).length, cutGap.length)}, under 2s ${pct(cutGap.filter((x) => x < 2).length, cutGap.length)}, under 3s ${pct(cutGap.filter((x) => x < 3).length, cutGap.length)}`);
console.log(`  cuts per real minute: during real-time fights ${(cutsReal / (slowMs / 60000)).toFixed(1)}, during fast playback ${(cutsFast / ((realMs - slowMs) / 60000)).toFixed(1)}`);
console.log(`  what is on screen (real time share): ${fmtRec(labelMs, (v) => pct(v, realMs))}`);
console.log(`  fights of 4+ in a close-up: the fighters span ${(q(fightFill, 0.5) * 100).toFixed(0)}% of the view width (median; p90 ${(q(fightFill, 0.9) * 100).toFixed(0)}%), ${pct(fightCovered, fightVis)} of their icons are covered by another`);
console.log(`  fights of 4+ on the whole map: span ${(q(fightFillWide, 0.5) * 100).toFixed(0)}% (p90 ${(q(fightFillWide, 0.9) * 100).toFixed(0)}%), ${pct(fightCoveredWide, fightVisWide)} of their icons covered`);
console.log(`  close-up time in which the camera is moving (following the fight): ${pct(closeMovingMs, closeMs)}`);
console.log(`  why:${fmtRec(cutWhy, (v) => pct(v, cuts))}`);
console.log(`  zoom changes 1.5x+ ${pct(zoomJumps, cuts)} of cuts; jumps to a different place (>0.75 of the view) ${pct(farCuts, cuts)}; back to the place of two cuts ago within 6s ${pct(pingPong, cuts)}`);
console.log(`  view share of real time: ${fmtRec(viewMs, (v) => pct(v, realMs))}`);
console.log(`  captions ${perGame(captions)} per game (one per ${(realMs / 1000 / Math.max(1, captions)).toFixed(1)} real s); replaced within 2s ${pct(capGap.filter((x) => x < 2).length, capGap.length)}, within 3.2s (before it would fade) ${pct(capGap.filter((x) => x < 3.2).length, capGap.length)}; LIVE label changes ${perGame(labels)} per game`);
console.log(`  banners (big plays + objectives) ${perGame(banners)} per game = one per ${(realMs / 1000 / Math.max(1, banners)).toFixed(1)} real s`);
console.log(`  champion icons covered by another icon: zoomed views ${pct(overlapped, visUnits)}, full map ${pct(overlappedWide, visUnitsWide)}`);
console.log(`  on-screen speed of moving champions (screen widths per real s): fast playback median ${q(scrSpeedFast, 0.5).toFixed(2)}, p90 ${q(scrSpeedFast, 0.9).toFixed(2)}; real-time median ${q(scrSpeedSlow, 0.5).toFixed(3)}, p90 ${q(scrSpeedSlow, 0.9).toFixed(3)}`);
