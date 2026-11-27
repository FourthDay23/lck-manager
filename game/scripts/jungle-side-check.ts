// The two junglers side by side: camp CS, level and gold by minute for the blue and the red team's jungler, camps
// cleared by kind, and the game-level numbers a change to the jungle could move (blue win rate, length, kills).
// Same games as calibrate.ts / growth-check.ts (same rosters, drafts, seeds).
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/jungle-side-check.ts [games] [rosterSeed]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";

const dir = "data";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
const N = Number(process.argv[3] ?? 100);
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

const MINUTES = [3, 5, 8, 10, 15, 20, 25];
type Acc = { cs: number; lvl: number; gold: number; n: number };
const acc = new Map<string, Acc>();
const cleared = [new Map<string, number>(), new Map<string, number>()];
let blueWins = 0, dur = 0, kills = 0;
const teamCs = [0, 0], teamGold15 = [0, 0];
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
  const jg = [0, 1].map((sd) => e.units.find((u) => u.side === sd && u.role === "Jungle")!);
  const wasAlive = e.camps.map((c) => c.alive);
  let mi = 0;
  while (!e.over && e.t < 70 * 60) {
    e.step();
    e.camps.forEach((c, i) => {
      if (wasAlive[i] && !c.alive) {
        // whose jungler is standing on it
        const by = jg.filter((u) => u.alive && Math.hypot(u.x - c.pos.x, u.y - c.pos.y) < 400).sort((x, y) => Math.hypot(x.x - c.pos.x, x.y - c.pos.y) - Math.hypot(y.x - c.pos.x, y.y - c.pos.y))[0];
        if (by) cleared[by.side].set(c.kind, (cleared[by.side].get(c.kind) ?? 0) + 1);
      }
      wasAlive[i] = c.alive;
    });
    while (mi < MINUTES.length && e.t >= MINUTES[mi] * 60) {
      for (const u of jg) {
        const k = `${MINUTES[mi]}:${u.side}`;
        const x = acc.get(k) ?? { cs: 0, lvl: 0, gold: 0, n: 0 };
        x.cs += u.cs; x.lvl += u.level; x.gold += u.gold; x.n++;
        acc.set(k, x);
      }
      if (MINUTES[mi] === 15) for (const sd of [0, 1]) teamGold15[sd] += e.gold(sd as 0 | 1);
      mi++;
    }
  }
  if (e.winner === 0) blueWins++;
  dur += e.t / 60;
  kills += e.units.reduce((x, u) => x + u.k, 0);
  for (const u of e.units) teamCs[u.side] += u.cs / (e.t / 60);
}
console.log(`${N} games, roster seed ${rosterSeed}: blue wins ${((blueWins / N) * 100).toFixed(1)}%, length ${(dur / N).toFixed(1)} min, kills ${(kills / N).toFixed(1)}`);
console.log(`team CS/min  blue ${(teamCs[0] / N).toFixed(1)}  red ${(teamCs[1] / N).toFixed(1)}   team gold at 15:00  blue ${(teamGold15[0] / N).toFixed(0)}  red ${(teamGold15[1] / N).toFixed(0)}`);
console.log("minute   blue jungler: CS  level  gold  |  red jungler: CS  level  gold  |  red - blue CS");
for (const m of MINUTES) {
  const b = acc.get(`${m}:0`), r = acc.get(`${m}:1`);
  if (!b || !r) continue;
  const f = (x: Acc) => `${(x.cs / x.n).toFixed(1).padStart(6)} ${(x.lvl / x.n).toFixed(2).padStart(6)} ${(x.gold / x.n).toFixed(0).padStart(6)}`;
  console.log(`${String(m).padStart(5)}    ${f(b)}          |  ${f(r)}        |  ${((r.cs / r.n) - (b.cs / b.n)).toFixed(1).padStart(5)}`);
}
console.log("camps cleared per game by the jungler standing on them (own and enemy camps):");
for (const sd of [0, 1]) {
  const m = cleared[sd];
  console.log(`  ${sd ? "red " : "blue"}  ${["blue", "gromp", "wolves", "raptors", "red", "krugs", "scuttle"].map((k) => `${k} ${((m.get(k) ?? 0) / N).toFixed(1)}`).join("  ")}`);
}
