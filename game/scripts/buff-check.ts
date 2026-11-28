// The baron and elder buffs are lost on death (engine.kill): checks it over engine games with the same rosters, drafts
// and seeds as calibrate.ts. Counts the champions that died while buffed, and how many of them still carried a buff
// when they came back (must be 0; before the fix every one whose buff had not run out by then did).
// Run: node scripts/par.mjs buff-check.ts 60 3      (or scripts/ab.mjs buff-check.ts 60 3 --base main)
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import type { Unit } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { par } from "./lib/par";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
const N = Number(process.argv[3] ?? 60);
const rosterSeed = Number(process.argv[4] ?? 3);
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

/** per game: deaths with a baron / elder buff on, respawns that still had one, and the seconds of buff those kept */
interface Rec { buffedDeaths: number; keptOnRespawn: number; keptSeconds: number; deadBuffSeconds: number; barons: number; elders: number; first: string }
const recs: Rec[] = [];
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const rec = par.game(g, (): Rec => {
    const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
    const R: Rec = { buffedDeaths: 0, keptOnRespawn: 0, keptSeconds: 0, deadBuffSeconds: 0, barons: 0, elders: 0, first: "" };
    const kill0 = e.kill.bind(e);
    e.kill = (src: Unit | null, v: Unit) => {
      if (v.baronUntil > e.t || v.elderUntil > e.t) R.buffedDeaths++;
      kill0(src, v);
    };
    const wasAlive = e.units.map(() => true);
    const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    while (!e.over && e.t < 3600) {
      e.step();
      e.units.forEach((u, i) => {
        const left = Math.max(u.baronUntil - e.t, u.elderUntil - e.t, 0);
        if (!u.alive && left > 0) R.deadBuffSeconds += 0.25;
        if (u.alive && !wasAlive[i] && left > 0) {
          R.keptOnRespawn++;
          R.keptSeconds += left;
          if (!R.first) R.first = `game ${g} ${clock(e.t)} ${u.name} is back with ${left.toFixed(0)} s of ${u.baronUntil > e.t ? "baron" : "elder"} buff`;
        }
        wasAlive[i] = u.alive;
      });
    }
    R.barons = e.barons[0] + e.barons[1];
    R.elders = e.events.filter((x) => x.type === "elder").length;
    return R;
  });
  if (!rec) continue;
  recs.push(rec);
}
par.end();
const n = recs.length;
const sum = (f: (r: Rec) => number) => recs.reduce((x, r) => x + f(r), 0);
console.log(`games ${n}, roster seed ${rosterSeed} | barons ${(sum((r) => r.barons) / n).toFixed(2)}, elders ${(sum((r) => r.elders) / n).toFixed(2)} a game`);
console.log(`champions that died with a baron or elder buff on: ${sum((r) => r.buffedDeaths)} (${(sum((r) => r.buffedDeaths) / n).toFixed(2)} a game)`);
console.log(`of them still buffed when they came back: ${sum((r) => r.keptOnRespawn)}, with ${(sum((r) => r.keptSeconds) / Math.max(1, sum((r) => r.keptOnRespawn))).toFixed(0)} s left on average | seconds a dead champion carried a buff: ${sum((r) => r.deadBuffSeconds).toFixed(0)}`);
const ex = recs.find((r) => r.first);
if (ex) console.log(`  e.g. ${ex.first}`);
console.log(sum((r) => r.keptOnRespawn) === 0 && sum((r) => r.deadBuffSeconds) === 0 ? "OK: no buff outlives a death" : "FAIL: buffs outlive deaths");
