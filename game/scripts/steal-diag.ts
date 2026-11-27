// Smite fights and steals over epic monsters in the engine (objsmite.ts), next to the LCK 2026 figures of
// scripts/lck_steals.py. Same games as calibrate.ts.
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/steal-diag.ts [games] [rosterSeed]
//   STEAL_TUNE=react:0.6 / OBJ_TUNE=stealHover:0.7 override the knobs; LOG=<game#> prints that game's steal lines.
// LCK cannot show a steal directly: "the other team hit it too" (21 % of dragon / baron / herald takes) is the
// nearest thing to "both junglers were on it", and a take by the team credited with fewer champions than the other
// (4.4 % of dragons, 5.0 % of barons, 4.6 % of heralds; 0.32 a game) the nearest thing to a steal.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, type ObjKey, type SideN } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import * as Macro from "../src/match/macro";
import * as ObjSmite from "../src/match/objsmite";
import * as Summoners from "../src/match/summoners";

const dir = existsSync("public/data/champions.json") && existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => {
  const p = `public/${dir}/${f}`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
const N = Number(process.argv[3] ?? 60);
const rosterSeed = Number(process.argv[4] ?? 3);
Macro.applyObjTune(process.env.OBJ_TUNE);
ObjSmite.applyStealTune(process.env.STEAL_TUNE);
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

const KS: ObjKey[] = ["dragon", "elder", "baron", "herald", "grubs"];
const tot = { takes: {} as Record<string, number>, both: {} as Record<string, number>, steals: {} as Record<string, number>, failed: {} as Record<string, number>, runs: {} as Record<string, number>, smited: 0, flashIn: 0 };
const add = (o: Record<string, number>, k: string, v: number) => { o[k] = (o[k] ?? 0) + v; };
let len = 0, kills = 0, stealEvents = 0, smiteCasts = 0, stealerDied = 0, stealWins = 0, stolenWon = 0;
const usage: Record<string, number> = {};
const reflexGap: number[] = [];
const rng = new Rng(11);
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
  const LOG = process.env.LOG !== undefined && Number(process.env.LOG) === g;
  if (LOG && Macro.st(e)) Macro.st(e)!.logOn = true;
  let seen = 0;
  const pending: { t: number; by: number }[] = [];
  while (!e.over && e.t < 3600) {
    e.step();
    for (; seen < e.events.length; seen++) {
      const ev = e.events[seen];
      if (ev.type !== "steal") continue;
      stealEvents++;
      if (ev.actor !== undefined) {
        pending.push({ t: e.t, by: ev.actor });
        const jg = e.units.filter((u) => u.role === "Jungle");
        const me = jg.find((u) => u.i === ev.actor), other = jg.find((u) => u.i !== ev.actor);
        if (me && other && me.reflex !== undefined && other.reflex !== undefined) reflexGap.push(me.reflex - other.reflex);
      }
      if (LOG) console.log(`${Math.floor(e.t / 60)}:${String(Math.floor(e.t % 60)).padStart(2, "0")} ${ev.text}`);
    }
    // the thief dead within 8 s of its steal
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (!e.units[p.by].alive) { stealerDied++; pending.splice(i, 1); } else if (e.t - p.t > 8) pending.splice(i, 1);
    }
  }
  if (!e.over) e.runToEnd();
  const S = ObjSmite.stats(e);
  for (const k of KS) {
    add(tot.takes, k, S.takes[k] ?? 0); add(tot.both, k, S.both[k] ?? 0); add(tot.steals, k, S.steals[k] ?? 0); add(tot.failed, k, S.failed[k] ?? 0);
  }
  tot.smited += S.smited; tot.flashIn += S.flashIn;
  const M = Macro.st(e);
  if (M) for (const sd of [0, 1] as SideN[]) for (const [key, v] of Object.entries(M.stats[sd].calls)) if (key.startsWith("steal:")) add(tot.runs, key.slice(6), v);
  for (const [key, v] of Object.entries(Summoners.usage(e))) if (key.startsWith("smite")) add(usage, key, v);
  smiteCasts += Object.entries(Summoners.usage(e)).filter(([key]) => key.startsWith("smite")).reduce((p, [, v]) => p + v, 0);
  // did the team that stole anything win?
  const sides = new Set(e.events.filter((x) => x.type === "steal").map((x) => x.side));
  for (const sd of sides) { stealWins++; if (e.winner === sd) stolenWon++; }
  len += e.t; kills += e.kills[0] + e.kills[1];
  if (LOG) for (const l of M?.log ?? []) if (l.includes("steal")) console.log(l);
}
const pc = (x: number, y: number) => (y ? `${((x / y) * 100).toFixed(1).padStart(5)}%` : "    - ");
console.log(`== engine: ${N} games (roster seed ${rosterSeed}), ${(len / N / 60).toFixed(1)} min, ${(kills / N).toFixed(1)} kills ==`);
console.log("per monster: takes a game | both junglers in reach with a Smite at the last hit | steals | failed steals (a jungler in reach did not get it) | steal runs a game");
const LCK: Record<string, string> = { dragon: "LCK: other team hit it 21.1%, outdamaged take 4.4%", elder: "LCK: 50.0%, 13.6% (n=44)", baron: "LCK: 21.3%, 5.0%", herald: "LCK: 16.8%, 4.6%", grubs: "LCK: 9.7%, 1.0% (per grub)" };
for (const k of KS) {
  const t = tot.takes[k] ?? 0;
  if (!t) continue;
  console.log(`  ${k.padEnd(7)} ${(t / N).toFixed(2)} | ${pc(tot.both[k] ?? 0, t)} | ${pc(tot.steals[k] ?? 0, t)} (${((tot.steals[k] ?? 0) / N).toFixed(3)} a game) | ${pc(tot.failed[k] ?? 0, t)} | ${((tot.runs[k] ?? 0) / N).toFixed(2)}   [${LCK[k]}]`);
}
const big = ["dragon", "elder", "baron", "herald"];
const sum = (o: Record<string, number>) => big.reduce((p, k) => p + (o[k] ?? 0), 0);
console.log(`dragon + elder + baron + herald: both in reach ${pc(sum(tot.both), sum(tot.takes))} | steals ${(sum(tot.steals) / N).toFixed(3)} a game (${pc(sum(tot.steals), sum(tot.takes)).trim()} of takes) | failed ${(sum(tot.failed) / N).toFixed(3)} a game   [LCK: 20.9%, 0.317 a game (4.7%)]`);
console.log(`steal events (banner) ${(stealEvents / N).toFixed(3)} a game | last hit by a Smite ${pc(tot.smited, KS.reduce((p, k) => p + (tot.takes[k] ?? 0), 0)).trim()} of takes | flashes into reach ${(tot.flashIn / N).toFixed(3)} a game | the thief dead within 8 s ${pc(stealerDied, stealEvents).trim()}`);
console.log(`Smite casts a game ${(smiteCasts / N).toFixed(1)} (LCK 19.1 per jungler -> 38.2): ` + Object.entries(usage).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${(v / N).toFixed(2)}`).join(" | "));
if (reflexGap.length) console.log(`the stealing jungler's reflex minus the other's: mean ${(reflexGap.reduce((p, x) => p + x, 0) / reflexGap.length).toFixed(1)} (n=${reflexGap.length}; 0 = hands do not matter)`);
console.log(`games with a steal: the stealing team won ${pc(stolenWon, stealWins).trim()} (n=${stealWins})`);
