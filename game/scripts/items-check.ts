// Items, keystones and bounties in engine games vs the real LCK games they come from (public/data/items.json).
//   node scripts/run-ts.mjs scripts/items-check.ts [games]
// Prints: minute of the 1st/2nd/3rd finished legendary per role (real: items.json `spike`, weighted by games),
// share of kills that pay a shutdown and its size (real: 16.8%, about 88 g off when paid), objective bounties per game.
import { readFileSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import type { Role } from "../src/data/types";
import { ITEM_TUNE, ROLE_GOLD_SCALE, shopHistory, unitItems } from "../src/match/items";

const j = (f: string) => JSON.parse(readFileSync(`public/data/${f}`, "utf8"));
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"));
const items = data.items!;
const N = Number(process.argv[3] ?? 30);
// ITEM_TUNE=recallBase:0.002,urgeLo:1 overrides items.ts tuning for this run (as in calibrate.ts)
for (const kv of (process.env.ITEM_TUNE ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split(":");
  (ITEM_TUNE as Record<string, number | boolean>)[k] = k === "objectiveBounty" ? v !== "0" : Number(v);
}
// ROLE_SCALE=Top:1.04,Bot:1.16 overrides items.ts ROLE_GOLD_SCALE for this run
for (const kv of (process.env.ROLE_SCALE ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split(":");
  // an empty value would read as 0 (Number("") is finite) and zero that role's item budget; refuse it, and keys that
  // only exist on the prototype
  if (!Object.prototype.hasOwnProperty.call(ROLE_GOLD_SCALE, k) || v === undefined || v === "" || !(Number(v) > 0)) {
    throw new Error(`ROLE_SCALE: bad entry "${kv}" (keys: ${Object.keys(ROLE_GOLD_SCALE).join(", ")}, values > 0)`);
  }
  ROLE_GOLD_SCALE[k as Role] = Number(v);
}
let fbSum = 0;
const kpb = [0, 0, 0, 0, 0];
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

// real spikes per role, weighted by games
const real: Record<Role, number[][]> = { Top: [], Jungle: [], Mid: [], Bot: [], Support: [] };
const rng = new Rng(5);
const sim: Record<Role, number[][]> = { Top: [[], [], []], Jungle: [[], [], []], Mid: [[], [], []], Bot: [[], [], []], Support: [[], [], []] };
let kills = 0, shutKills = 0, shutGold = 0, objBounties = 0, minutes = 0;
const gold: Record<Role, Record<number, number[]>> = { Top: {}, Jungle: {}, Mid: {}, Bot: {}, Support: {} };
// real LCK 2026 mean total gold by role at 5/10/15/20/25/30 min (same 502 games)
const REAL_GOLD: Record<Role, number[]> = {
  Top: [1782, 3503, 5346, 7467, 9495, 11492], Jungle: [1918, 3679, 5603, 7679, 9644, 11519], Mid: [1820, 3684, 5632, 7847, 9953, 12005],
  Bot: [1836, 3652, 6174, 8762, 11367, 14175], Support: [1336, 2511, 3777, 5085, 6416, 7742],
};
// real LCK shop visits (ITEM_PURCHASED more than 25 s apart = a new visit): per 30 min, before 10 min, median gold
// earned since the previous visit (scratchpad real_shops.py over data/raw)
const REAL_SHOPS: Record<Role, [number, number, number]> = { Top: [11.5, 2.6, 849], Jungle: [11.7, 2.9, 854], Mid: [12.4, 3.4, 824], Bot: [11.7, 2.9, 1050], Support: [15.2, 3.4, 415] };
const visits: Record<Role, number[]> = { Top: [], Jungle: [], Mid: [], Bot: [], Support: [] };
const early: Record<Role, number[]> = { Top: [], Jungle: [], Mid: [], Bot: [], Support: [] };
const spent: Record<Role, number[]> = { Top: [], Jungle: [], Mid: [], Bot: [], Support: [] };
for (let g = 0; g < N; g++) {
  const [a, b] = rng.shuffle([...s.lck]).slice(0, 2);
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  for (const side of ["blue", "red"] as const) for (const r of ROLES) {
    const c = d.picks[side][r];
    const ci = c ? items.champs[c] : undefined;
    if (ci?.spike) real[r].push(ci.spike);
  }
  const e = new Engine({ s, data, blue: a, red: b, picks: d.picks, seed: 500 + g });
  const owned = e.units.map(() => 0);
  while (!e.over && e.t < 3600) {
    e.step();
    const m = Math.round(e.t * 4) / 4;
    if (m % 300 === 0 && m <= 1800) for (const u of e.units) ((gold[u.role][m / 60] ??= []) as number[]).push(u.gold);
    for (const u of e.units) {
      const x = unitItems(e, u);
      if (!x) continue;
      // count legendaries only (boots and support item excluded), as items.json `spike` does
      const leg = x.items.filter((id) => items.items[String(id)]?.kind === "legendary").length;
      while (owned[u.i] < leg) {
        if (owned[u.i] < 3) sim[u.role][owned[u.i]].push(e.t / 60);
        owned[u.i]++;
      }
    }
  }
  minutes += e.t / 60;
  for (const u of e.units) {
    // after the first minute, like the real count (the starting purchase is not a visit)
    const hist = shopHistory(e, u).filter((x) => x.t > 60);
    visits[u.role].push((hist.length * 1800) / Math.max(1, e.t));
    early[u.role].push(hist.filter((x) => x.t < 600).length);
    for (const h of hist) spent[u.role].push(h.gold * ROLE_GOLD_SCALE[u.role]);
  }
  fbSum += e.events.find((x) => x.type === "first_blood")?.t ?? e.t;
  for (const ev of e.events) {
    if (["kill", "first_blood", "solo"].includes(ev.type)) { kills++; kpb[Math.min(4, Math.floor(ev.t / 600))]++; }
    if (ev.type === "shutdown") { shutKills++; shutGold += Number(ev.text.match(/제압골 (\d+)/)?.[1] ?? 0); }
    if (ev.type === "info" && ev.text.startsWith("오브젝트 현상금")) objBounties++;
  }
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`${N} games, ${(minutes / N).toFixed(1)} min average`);
console.log("minute of 1st / 2nd / 3rd legendary (engine vs real LCK picks of the same champions)");
for (const r of ROLES) {
  const rs = [0, 1, 2].map((k) => mean(real[r].map((x) => x[k]).filter((x) => x !== undefined)));
  const ss = [0, 1, 2].map((k) => mean(sim[r][k]));
  console.log(`  ${r.padEnd(8)} engine ${ss.map((x) => x.toFixed(1)).join(" / ")}   real ${rs.map((x) => x.toFixed(1)).join(" / ")}   (reached 3rd: ${sim[r][2].length}/${N * 2})`);
}
console.log(`shutdown kills (>= 250 g, shown as events): ${shutKills}/${kills} (${((shutKills / Math.max(1, kills)) * 100).toFixed(1)}%), mean ${Math.round(shutGold / Math.max(1, shutKills))} g`);
console.log(`objective bounties per game: ${(objBounties / N).toFixed(2)} (real: about 0.4)`);
console.log("total gold by role at 5/10/15/20/25/30 min: engine vs real");
for (const r of ROLES) {
  const eg = [5, 10, 15, 20, 25, 30].map((m) => mean(gold[r][m] ?? []));
  console.log(`  ${r.padEnd(8)} engine ${eg.map((x) => Math.round(x)).join(" / ")}   real ${REAL_GOLD[r].join(" / ")}`);
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
console.log("shop visits per 30 min / before 10 min / median gold since last visit (real-gold scale): engine vs real");
for (const r of ROLES) {
  console.log(`  ${r.padEnd(8)} engine ${mean(visits[r]).toFixed(1)} / ${mean(early[r]).toFixed(1)} / ${Math.round(median(spent[r]))}   real ${REAL_SHOPS[r].join(" / ")}`);
}
console.log(`kills ${(kills / N).toFixed(1)} per game, first blood ${(fbSum / N / 60).toFixed(1)} min, by 10-min block ${kpb.map((x) => (x / N).toFixed(1)).join(" / ")} (real 29.5, FB 5.1, 3.8 / 8.5 / 11.8 / 4.7 / 0.6)`);
