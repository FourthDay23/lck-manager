// Does a lane matchup of m (match/matchup.ts) play out in the engine the way it does in LCK?
// Target: the favoured side wins logistic(m) of otherwise even games, and leads its lane by about m / goldSlope gold
// at 14:00 (the LCK link between 14-minute gold and the result, matchups.json goldSlope).
// Equal rosters and mastery, the same ten champions every game (sides and teams swap so champion and side edges
// cancel), and MATCHUP_TUNE.force puts a matchup of +/-M on one role, so every game is a matchup game.
// Run: node scripts/run-ts.mjs scripts/matchup-check.ts [games] [role|comp] [M]
//      role "comp" puts a composition counter edge of +/-M on the teams instead (MATCHUP_TUNE.forceComp)
//      MATCHUP_TUNE=dmg:0.35,init:0.35,cs:0.45,rest:0.35,comp:0.3 overrides the engine factors for the run
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import type { Role } from "../src/data/types";
import { ovr } from "../src/core/player";
import { MATCHUP_TUNE } from "../src/match/matchup";
import { par } from "./lib/par";
import { DRAW } from "../src/match/engine";
// no screen: skip the draw-only effects list (results stay the same; HEADLESS=0 keeps it)
if (process.env.HEADLESS !== "0" && DRAW) DRAW.fx = false; // (DRAW is missing in code from before it, scripts/ab.mjs --base)

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
for (const kv of (process.env.MATCHUP_TUNE ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split(":");
  (MATCHUP_TUNE as unknown as Record<string, number>)[k] = Number(v);
}
const N = Number(process.argv[3] ?? 200);
const COMP = process.argv[4] === "comp";
const ROLE = (COMP ? "Mid" : process.argv[4] ?? "Mid") as Role;
const M = Number(process.argv[5] ?? 0.4);
const slope = data.matchups?.goldSlope ?? 0.000527;

const s = newGame(data, { team: "T1", difficulty: "normal", manager: "t", seed: 4 });
s.user = "__nobody__";
const rr = new Rng(8);
const pool = rr.shuffle(Object.values(s.players).filter((p) => !p.team && p.origin === "real"));
const [A, B] = [s.lck[0], s.lck[1]];
for (const r of ROLES) {
  const two = pool.filter((p) => p.role === r).sort((x, y) => ovr(y) - ovr(x)).slice(4, 6);
  joinTeam(s, two[0], A, 10000, 2);
  joinTeam(s, two[1], B, 10000, 2);
}
for (const id of [...s.teams[A].roster, ...s.teams[B].roster]) { const p = s.players[id]; p.mastery = {}; for (const c of data.champions) p.mastery[c.id] = 70; }
autoLineup(s, s.teams[A]);
autoLineup(s, s.teams[B]);
// the two most played LCK champions of each role
const pickSets: [Record<Role, string>, Record<Role, string>] = [{} as Record<Role, string>, {} as Record<Role, string>];
const used = new Set<string>();
for (const r of ROLES) {
  const cs = data.champions.filter((c) => (c.roles[r] ?? 0) >= 0.5 && !used.has(c.id)).sort((a, b) => b.pro.picks - a.pro.picks).slice(0, 2);
  pickSets[0][r] = cs[0].id; pickSets[1][r] = cs[1].id;
  used.add(cs[0].id); used.add(cs[1].id);
}

let favWins = 0, gold = 0, cs = 0, kills = 0, len = 0, deaths = 0;
for (let g = 0; g < N; g++) {
  // swap picks, teams and the favoured side in a 8-game cycle so champion / roster / side edges cancel
  const swapPicks = g % 2 === 1, swapTeams = g % 4 >= 2, favBlue = g % 8 < 4;
  const picks = { blue: pickSets[swapPicks ? 1 : 0], red: pickSets[swapPicks ? 0 : 1] };
  const blue = swapTeams ? B : A, red = swapTeams ? A : B;
  if (COMP) MATCHUP_TUNE.forceComp = favBlue ? M : -M;
  else MATCHUP_TUNE.force = { role: ROLE, m: favBlue ? M : -M };
  // par.game: plays the game here, or leaves it to another piece of a parallel run (scripts/par.mjs)
  const r = par.game(g, () => {
    const e = new Engine({ s, data, blue, red, picks, seed: 900 + g });
    while (!e.over && e.t < 14 * 60) e.step();
    const fav = e.units.find((u) => u.role === ROLE && u.side === (favBlue ? 0 : 1))!;
    const other = e.units.find((u) => u.role === ROLE && u.side !== fav.side)!;
    const at14 = { gold: fav.gold - other.gold, cs: fav.cs - other.cs, kills: fav.k - other.k, deaths: fav.d - other.d };
    e.runToEnd();
    return { ...at14, t: e.t, favWon: e.winner === fav.side };
  });
  if (!r) continue;
  gold += r.gold;
  cs += r.cs;
  kills += r.kills;
  deaths += r.deaths;
  len += r.t;
  if (r.favWon) favWins++;
}
par.end();
MATCHUP_TUNE.force = null;
MATCHUP_TUNE.forceComp = null;
const wr = favWins / N;
const se = Math.sqrt(wr * (1 - wr) / N);
console.log(`${COMP ? "composition" : ROLE} matchup ${M} logit, ${N} games, factors ${JSON.stringify({ dmg: MATCHUP_TUNE.dmg, init: MATCHUP_TUNE.init, cs: MATCHUP_TUNE.cs, rest: MATCHUP_TUNE.rest, comp: MATCHUP_TUNE.comp, ...(COMP ? {} : { rating: MATCHUP_TUNE[`rating${ROLE}`] }) })}`);
console.log(`favoured side won ${(wr * 100).toFixed(1)}% (+-${(se * 100).toFixed(1)}), LCK target ${(100 / (1 + Math.exp(-M))).toFixed(1)}%`);
console.log(`at 14:00 in that lane: gold ${(gold / N).toFixed(0)} (LCK target ${(M / slope).toFixed(0)}), cs ${(cs / N).toFixed(1)}, kills ${(kills / N).toFixed(2)}, deaths ${(deaths / N).toFixed(2)}; game ${(len / N / 60).toFixed(1)} min`);
