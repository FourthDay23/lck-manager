// How engine junglers use Smite, next to the LCK 2026 numbers from scripts/lck_smite.py (summoner casts in the 502
// games' match data). Same games as growth-check.ts / calibrate.ts (same rosters, drafts, seeds).
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/smite-check.ts [games] [rosterSeed]
// SUM_TUNE=smiteHold:30 / GROWTH_TUNE=... override the knobs for a run.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, applyEarlyTune, applyGrowthTune } from "../src/match/engine";
import * as Summoners from "../src/match/summoners";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), process.env.ITEMS === "0" ? null : j("items.json"));
const N = Number(process.argv[3] ?? 40);
const rosterSeed = Number(process.argv[4] ?? 3);
applyEarlyTune(process.env.EARLY_TUNE);
applyGrowthTune(process.env.GROWTH_TUNE);
Summoners.applySumTune(process.env.SUM_TUNE);
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

// LCK 2026 (scripts/lck_smite.py): casts per jungler per game by game length, and the overall rate
const LCK_BUCKETS: [number, number, number][] = [[0, 28, 16.3], [28, 32, 18.2], [32, 36, 19.9], [36, 40, 21.2], [40, 99, 23.4]];
const LCK = { perGame: 19.1, perMin: 0.6, len: 32.2 };

const PHASES = [[0, 600], [600, 1200], [1200, 99999]] as const;
const byReason: Record<string, number> = {};
const phaseCasts = [0, 0, 0];
const phaseMin = [0, 0, 0];
const buckets = LCK_BUCKETS.map(() => ({ casts: 0, n: 0 }));
let casts = 0, jgGames = 0, minutes = 0, full = 0, alive = 0, firstAt = 0, firstN = 0;
const tierAt = [[0, 0], [0, 0]];
const epics = { smote: 0, all: 0, steals: 0 };
let dur = 0;
const total = (e: Engine) => Object.entries(Summoners.usage(e)).filter(([k]) => k.startsWith("smite")).reduce((a, [, v]) => a + v, 0);
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
  const jgs = e.units.filter((u) => Summoners.has(u, "smite"));
  const tierSeen = jgs.map(() => [false, false]);
  const first = jgs.map(() => false);
  let prev = 0;
  while (!e.over && e.t < 70 * 60) {
    const t0 = e.t;
    e.step();
    const dt = e.t - t0;
    const ph = PHASES.findIndex(([x, y]) => t0 >= x && t0 < y);
    phaseMin[ph] += (dt / 60) * jgs.length;
    const now = total(e);
    phaseCasts[ph] += now - prev;
    prev = now;
    jgs.forEach((u, i) => {
      if (u.alive) {
        alive += dt;
        if (Summoners.smiteCharges(e, u) >= Summoners.SMITE.max) full += dt;
      }
      const tier = Summoners.smiteTier(e, u);
      for (const k of [0, 1]) if (tier > k && !tierSeen[i][k]) { tierSeen[i][k] = true; tierAt[k][0] += e.t / 60; tierAt[k][1]++; }
      if (!first[i] && Summoners.smiteCharges(e, u) === 0) { first[i] = true; firstAt += e.t; firstN++; }
    });
  }
  const mins = e.t / 60;
  dur += mins;
  for (const [k, v] of Object.entries(Summoners.usage(e))) if (k.startsWith("smite")) byReason[k] = (byReason[k] ?? 0) + v;
  const c = total(e);
  casts += c;
  jgGames += jgs.length;
  minutes += mins * jgs.length;
  const bi = LCK_BUCKETS.findIndex(([lo, hi]) => mins >= lo && mins < hi);
  buckets[bi].casts += c;
  buckets[bi].n += jgs.length;
  for (const ev of e.events) {
    if (ev.type === "dragon" || ev.type === "baron" || ev.type === "herald" || ev.type === "grubs" || ev.type === "elder") epics.all++;
    if (ev.type === "steal") epics.steals++;
  }
  epics.smote += (Summoners.usage(e)["smite:obj"] ?? 0) + (Summoners.usage(e)["smite:steal"] ?? 0);
}
const f1 = (x: number) => x.toFixed(1), f2 = (x: number) => x.toFixed(2);
console.log(`${N} games, roster seed ${rosterSeed}, mean length ${f1(dur / N)} min (LCK ${LCK.len})`);
console.log(`Smite casts per jungler: ${f1(casts / jgGames)} a game, ${f2(casts / minutes)} a minute (LCK ${LCK.perGame}, ${LCK.perMin})`);
console.log(`  by reason (per jungler-game): ${Object.entries(byReason).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k.replace("smite:", "")} ${f2(v / jgGames)}`).join(", ")}`);
console.log(`  by phase (per jungler-minute): ${PHASES.map(([x], i) => `${x / 60}+ ${f2(phaseCasts[i] / Math.max(1e-9, phaseMin[i]))}`).join(", ")}`);
console.log("  by game length: " + LCK_BUCKETS.map(([lo, hi, real], i) => `${lo}-${hi === 99 ? "" : hi} min ${buckets[i].n ? f1(buckets[i].casts / buckets[i].n) : "-"} (LCK ${real}, n ${buckets[i].n / 2})`).join(" | "));
console.log(`  time alive with both charges up (one going to waste): ${f1((full / Math.max(1, alive)) * 100)} %`);
console.log(`  first time both charges are used: ${f2(firstAt / Math.max(1, firstN) / 60)} min; Unleashed Smite at ${f1(tierAt[0][0] / Math.max(1, tierAt[0][1]))} min (${tierAt[0][1]}/${jgGames}), Primal at ${f1(tierAt[1][0] / Math.max(1, tierAt[1][1]))} min (${tierAt[1][1]}/${jgGames})`);
console.log(`  epic monsters: ${f2(epics.all / N)} a game, ${f1((epics.smote / Math.max(1, epics.all)) * 100)} % finished with Smite, steals ${f2(epics.steals / N)} a game`);
