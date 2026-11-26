// One headless game with a state dump every 5 minutes.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "t", seed: 7 });
const pool = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => ovr(b) - ovr(a));
for (const r of ROLES) {
  const byRole = pool.filter((p) => p.role === r);
  for (const tid of s.lck) {
    if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
    const p = byRole.shift();
    if (p) joinTeam(s, p, tid, 10000, 2);
  }
}
for (const tid of s.lck) autoLineup(s, s.teams[tid]);
const seed = Number(process.argv[3] ?? 1003);
const d = newDraft(s.lck[0], s.lck[1], []);
autoDraft(s, data, d, new Rng(seed));
const e = new Engine({ s, data, blue: s.lck[0], red: s.lck[1], picks: { blue: d.picks.blue, red: d.picks.red }, seed });
let next = 300;
while (!e.over && e.t < 3600) {
  e.step();
  if (e.t >= next) {
    next += 300;
    console.log(`--- ${Math.round(e.t / 60)}m kills ${e.kills} towers ${e.towers} gold ${e.gold(0)}/${e.gold(1)} nexus ${e.nexus.map(Math.round)} fronts ${["top", "mid", "bot"].map((l) => e.lanes[l as "top"].front.toFixed(2))}`);
    console.log("  turrets alive", [0, 1].map((sd) => e.turrets.filter((t) => t.side === sd && t.alive).map((t) => `${t.lane[0]}${t.tier}:${Math.round(t.hp)}`).join(" ")));
    console.log("  inhibs", e.inhibs.map((x) => `${x.side}${x.lane[0]}${x.alive ? "+" : "-"}`).join(" "), "fights", e.fights.size);
    for (const u of e.units) console.log(`  ${u.side} ${u.role.padEnd(7)} ${u.champ.id.padEnd(12)} lv${u.level} ${u.alive ? "alive" : "dead "} task=${u.task.padEnd(6)} pos=${Math.round(u.x)},${Math.round(u.y)} hp=${Math.round(u.hp)}/${Math.round(u.maxHp)} k${u.k}/d${u.d} cs${Math.round(u.cs)} g${Math.round(u.gold)} path${u.path.length} fight${u.fightId}`);
  }
}
console.log("end", Math.round(e.t / 60), "winner", e.winner);
for (const ev of e.events.filter((x) => x.big)) console.log(Math.round(ev.t / 6) / 10, ev.type, ev.text);
console.log("first kills:");
for (const ev of e.events.filter((x) => ["kill", "first_blood", "solo"].includes(x.type)).slice(0, 14)) {
  const a = ev.actor !== undefined ? e.units[ev.actor] : null, v = ev.victim !== undefined ? e.units[ev.victim] : null;
  console.log((ev.t / 60).toFixed(2), ev.type, a?.role, "->", v?.role, ev.text);
}
console.log("kill origins", e.killOrigin);
