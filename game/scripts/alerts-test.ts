// Offers become alerts and stop auto-advance; abroad LCK players are buyable and their club refills; team difficulty labels.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, migrateSave, newGame } from "../src/core/game";
import { clubDemand, completeUserSigning, joinTeam } from "../src/core/market";
import { ovr, salaryAsk, teamDifficulty } from "../src/core/player";
import { ROLES } from "../src/data/types";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
console.log("difficulty:", data.teams.filter((t) => t.tier === 1).map((t) => `${t.short} ${teamDifficulty(t).label}`).join(" | "));
const s = newGame(data, { team: "KT", difficulty: "normal", manager: "t", seed: 5 });
// give the user a decent roster so AI clubs want to trade
const pool = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => ovr(b) - ovr(a));
for (const r of ROLES) {
  const p = pool.find((x) => x.role === r && !x.team)!;
  joinTeam(s, p, "KT", salaryAsk(p, s.season), 2);
}
const abroad = Object.values(s.players).filter((p) => p.origin === "real" && p.team && s.intl.includes(p.team));
console.log("abroad buyable:", abroad.map((p) => `${p.name}@${s.teams[p.team!].short}`).join(", "));
// buy one back
const v = abroad[0];
const club = s.teams[v.team!];
const before = club.roster.length;
completeUserSigning(s, v, "transfer", { salary: salaryAsk(v, s.season), years: 2, bonus: 0, starter: false }, clubDemand(s, v));
console.log(`bought ${v.name} from ${club.short}: club roster ${before} -> ${club.roster.length}, has ${v.role}: ${club.roster.some((id) => s.players[id].role === v.role)}, lineup full: ${ROLES.every((r) => club.lineup[r])}`);
// run the stove league until an offer pops
let stops = 0;
s.players[s.teams.KT.roster[0]].listed = true;
for (let i = 0; i < 400 && stops < 3; i++) {
  const stop = autoAdvance(s, data, "match");
  for (const sr of s.series) if (sr.day < s.day && !sr.done && (sr.a === s.user || sr.b === s.user)) sr.done = true;
  s.cutscenes.length = 0;
  if (stop === "offer") {
    stops++;
    const a = s.alerts![s.alerts!.length - 1];
    console.log(`day ${s.day} stop=offer: ${a.kind} | ${a.title} | ${a.body}`);
  } else if (stop === "match") { s.series.filter((x) => x.day === s.day && (x.a === s.user || x.b === s.user)).forEach((x) => { x.done = true; x.winner = x.a!; }); s.day++; }
}
// a v2 save gets the abroad players back
const old = newGame(data, { team: "T1", difficulty: "normal", manager: "t", seed: 6 });
for (const p of Object.values(old.players)) if (p.origin === "real" && p.team && old.intl.includes(p.team)) p.origin = "intl";
old.version = 2;
console.log("migration notes:", migrateSave(old, data));
