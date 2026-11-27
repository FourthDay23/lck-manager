// One engine game's blue jungler, second by second for the first minutes: task, camp target, distance to it, speed.
// For finding where the jungler's time goes between camps (scripts/growth-check.ts "jungle-walk").
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/jg-trace.ts [game] [untilMin]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, applyGrowthTune } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";

const dir = "data";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"));
applyGrowthTune(process.env.GROWTH_TUNE);
const G = Number(process.argv[3] ?? 0);
const until = Number(process.argv[4] ?? 6) * 60;
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
const rng = new Rng(11);
let e!: Engine;
for (let g = 0; g <= G; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  if (g === G) e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
}
const u = e.units.find((x) => x.side === 0 && x.role === "Jungle")!;
let last = { x: u.x, y: u.y, t: 0 };
let lastCs = 0;
while (!e.over && e.t < until) {
  e.step();
  if (e.t - last.t >= 1 - 1e-9) {
    const c = u.campTarget !== undefined ? e.camps[u.campTarget] : undefined;
    const sp = Math.hypot(u.x - last.x, u.y - last.y) / (e.t - last.t);
    const up = e.camps.filter((x) => x.alive && x.side === 0).map((x) => x.kind[0] + (x.kind === "scuttle" ? "S" : "")).join("");
    const mark = u.cs > lastCs ? ` +CS ${u.cs}` : "";
    console.log(`${Math.floor(e.t / 60)}:${String(Math.floor(e.t % 60)).padStart(2, "0")} ${u.task.padEnd(7)} camp ${c ? `${c.kind}${c.alive ? "" : "(dead)"} d${Math.round(Math.hypot(u.x - c.pos.x, u.y - c.pos.y))}` : "-"} spd ${sp.toFixed(0)} up[${up}] goal ${u.goal ? `${Math.round(u.goal.x)},${Math.round(u.goal.y)}` : "-"} path ${u.path.length}${mark}`);
    last = { x: u.x, y: u.y, t: e.t };
    lastCs = u.cs;
  }
}
