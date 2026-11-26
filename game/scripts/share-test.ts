// Export two teams as codes, parse them back, build an exhibition and play one game.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, newGame } from "../src/core/game";
import { buildExhibition, codeOvr, exportTeamCode, parseTeamCode } from "../src/core/share";
import { Engine } from "../src/match/engine";
import { autoDraft, newDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
// "device 1" and "device 2": two separate careers
const dev1 = newGame(data, { team: "HLE", difficulty: "normal", manager: "철수", seed: 1 });
const dev2 = newGame(data, { team: "GEN", difficulty: "normal", manager: "영희", seed: 2 });
for (const s of [dev1, dev2]) {
  autoAdvance(s, data, "match"); // run the stove league so AI and auto call-ups fill the lineups
  s.cutscenes.length = 0;
}
const c1 = exportTeamCode(dev1, "GEN"); // any team works; use AI-built rosters so both are full
const c2 = exportTeamCode(dev2, "T1");
console.log("code lengths", c1.length, c2.length, c1.slice(0, 40) + "...");
const p1 = parseTeamCode(c1), p2 = parseTeamCode(c2);
if (!p1.ok || !p2.ok) throw new Error("parse failed");
console.log("parsed", p1.code.name, codeOvr(p1.code), "|", p2.code.name, codeOvr(p2.code));
const broken = parseTeamCode(c1.slice(0, -10) + "AAAAAAAAAA");
console.log("tampered code ->", broken.ok ? "accepted (bad)" : broken.msg);
const ex = buildExhibition(data, [p1.code, p2.code], dev1.meta, 42);
const d = newDraft("EXA", "EXB", []);
autoDraft(ex, data, d, new Rng(3));
const e = new Engine({ s: ex, data, blue: d.blue, red: d.red, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 9 });
e.runToEnd();
console.log(`exhibition: ${ex.teams.EXA.name} vs ${ex.teams.EXB.name} -> winner ${e.winner === 0 ? ex.teams.EXA.name : ex.teams.EXB.name}, ${Math.round(e.t / 60)} min, kills ${e.kills}`);
console.log("lineups", Object.values(ex.teams.EXA.lineup).map((id) => ex.players[id!].name).join(","), "|", Object.values(ex.teams.EXB.lineup).map((id) => ex.players[id!].name).join(","));
