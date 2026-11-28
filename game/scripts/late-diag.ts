// How engine games close (same games as calibrate.ts, items on unless ITEMS=0): length spread, turrets down by minute,
// first tier-2 / tier-3 turret, first inhibitor and first baron and how long the game lasts after them, plus what the
// side ahead does after its first baron. Compare with scripts/lck_late.py (real LCK 2026).
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/late-diag.ts [games] [rosterSeed]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, ENGINE_FLAGS, applyEarlyTune } from "../src/match/engine";
import { applyWaveTune } from "../src/match/minions";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import * as Macro from "../src/match/macro";

const dir = "data";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"));
const N = Number(process.argv[3] ?? 60);
const rosterSeed = Number(process.argv[4] ?? 3);
applyEarlyTune(process.env.EARLY_TUNE);
// WAVE_TUNE=lastHit:0.9 overrides the wave knobs (minions.ts); FLAGS=-minions runs the engine without real minions
applyWaveTune(process.env.WAVE_TUNE);
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) (ENGINE_FLAGS as Record<string, boolean>)[fl.replace(/^-/, "")] = !fl.startsWith("-");
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
const length: number[] = [], firstInhib: number[] = [], afterInhib: number[] = [], firstBaron: number[] = [], afterBaron: number[] = [];
const inner: number[] = [], base: number[] = [];
const turretsBy: Record<number, number> = { 14: 0, 20: 0, 25: 0, 30: 0 };
let inhibs = 0;
const planAfterBaron: Record<string, number> = {};
let planSamples = 0;
const planAfterInhib: Record<string, number> = {};
let inhibSamples = 0;
const afterInhibState = { games: 0, aliveAtt: 0, aliveDef: 0, killsAtt: 0, killsDef: 0, endedIn2: 0 };
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
  let fb = -1, fbSide = -1, fi = -1, fiSide = -1;
  while (!e.over && e.t < 3600) {
    e.step();
    if (fi < 0) {
      const ev = e.events.find((x) => x.type === "inhib");
      if (ev) {
        fi = ev.t; fiSide = ev.side;
        afterInhibState.games++;
        afterInhibState.aliveAtt += e.units.filter((u) => u.side === fiSide && u.alive).length;
        afterInhibState.aliveDef += e.units.filter((u) => u.side !== fiSide && u.alive).length;
      }
    }
    // the inhibitor team in the 2 minutes after its first inhibitor (sampled every 5 s): plan, where it is
    if (fi >= 0 && e.t - fi < 120 && Math.abs(e.t / 5 - Math.round(e.t / 5)) < 1e-6) {
      const key = (Macro.planLabel(e, fiSide as 0 | 1) || "-").split(" · ")[0];
      planAfterInhib[key] = (planAfterInhib[key] ?? 0) + 1;
      inhibSamples++;
    }
    if (fb < 0) {
      const ev = e.events.find((x) => x.type === "baron");
      if (ev) { fb = ev.t; fbSide = ev.side ?? -1; }
    }
    // what the baron team's brain does in the 3 minutes after it (sampled every 5 s)
    if (fb >= 0 && fbSide >= 0 && e.t - fb < 180 && Math.abs(e.t / 5 - Math.round(e.t / 5)) < 1e-6) {
      const label = Macro.planLabel(e, fbSide as 0 | 1) || "-";
      const key = label.split(" · ")[0];
      planAfterBaron[key] = (planAfterBaron[key] ?? 0) + 1;
      planSamples++;
    }
  }
  const end = e.t / 60;
  length.push(end);
  const ev = e.events;
  for (const x of ev) {
    if (x.type === "turret" || x.type === "first_turret") {
      for (const m of Object.keys(turretsBy).map(Number)) if (x.t / 60 < m) turretsBy[m]++;
      const text = String((x as { text?: string }).text ?? "");
      if (/2차/.test(text) && inner.length < g + 1 && !inner[g]) inner[g] = x.t / 60;
      if (/3차/.test(text) && !base[g]) base[g] = x.t / 60;
    }
  }
  inhibs += ev.filter((x) => x.type === "inhib").length;
  if (fi >= 0) {
    firstInhib.push(fi / 60);
    afterInhib.push(end - fi / 60);
    if (end - fi / 60 < 2) afterInhibState.endedIn2++;
    for (const x of ev) {
      if (!["kill", "first_blood", "solo"].includes(x.type) || x.t < fi || x.t > fi + 90) continue;
      if (x.side === fiSide) afterInhibState.killsAtt++; else afterInhibState.killsDef++;
    }
  }
  if (fb >= 0) { firstBaron.push(fb / 60); afterBaron.push(end - fb / 60); }
}
const inn = inner.filter((x) => x !== undefined), bas = base.filter((x) => x !== undefined);
console.log(`games ${N} (roster seed ${rosterSeed}), length median ${qt(length, 0.5).toFixed(1)} min (P25 ${qt(length, 0.25).toFixed(1)}, P75 ${qt(length, 0.75).toFixed(1)}, P90 ${qt(length, 0.9).toFixed(1)}), share over 38 min ${(length.filter((x) => x > 38).length / N * 100).toFixed(0)}%`);
console.log(`turrets down (both teams) by minute: ${Object.entries(turretsBy).map(([m, v]) => `${m}:${(v / N).toFixed(2)}`).join(" ")}`);
console.log(`first inner (tier 2) turret median ${qt(inn, 0.5).toFixed(1)} min, first base (tier 3) ${qt(bas, 0.5).toFixed(1)} (${(bas.length / N * 100).toFixed(0)}% of games)`);
console.log(`first inhibitor median ${qt(firstInhib, 0.5).toFixed(1)} min (${(firstInhib.length / N * 100).toFixed(0)}% of games), game lasts ${qt(afterInhib, 0.5).toFixed(1)} min after it (median); inhibitors per game ${(inhibs / N).toFixed(2)}`);
console.log(`first baron median ${qt(firstBaron, 0.5).toFixed(1)} min (${(firstBaron.length / N * 100).toFixed(0)}% of games), game lasts ${qt(afterBaron, 0.5).toFixed(1)} min after it (median)`);
const ai = afterInhibState, gi = Math.max(1, ai.games);
console.log(`at the first inhibitor: alive ${(ai.aliveAtt / gi).toFixed(2)} (inhib team) v ${(ai.aliveDef / gi).toFixed(2)}; kills in the next 90 s ${(ai.killsAtt / gi).toFixed(2)} v ${(ai.killsDef / gi).toFixed(2)}; game over within 2 min ${(ai.endedIn2 / gi * 100).toFixed(0)}%`);
console.log(`inhib team's plan in the 2 min after its first inhibitor: ${Object.entries(planAfterInhib).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${(v / Math.max(1, inhibSamples) * 100).toFixed(0)}%`).join(" | ")}`);
console.log(`baron team's plan in the 3 min after its first baron: ${Object.entries(planAfterBaron).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${(v / planSamples * 100).toFixed(0)}%`).join(" | ")}`);
