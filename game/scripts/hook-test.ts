// Hooks (Thresh Q, Nautilus Q, Leona E, Amumu Q, Lee Sin Q, Vex R) move the caster only when they land.
// Run: node scripts/run-ts.mjs scripts/hook-test.ts [games]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine } from "../src/match/engine";
import { ROLES } from "../src/data/types";
import * as Fight from "../src/match/fight";

const dir = "data";
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

const N = Number(process.argv[3] ?? 6);
const lineups = [
  { blue: { Top: "Ornn", Jungle: "LeeSin", Mid: "Vex", Bot: "Jinx", Support: "Thresh" }, red: { Top: "Gnar", Jungle: "Amumu", Mid: "Azir", Bot: "Varus", Support: "Nautilus" } },
  { blue: { Top: "Gnar", Jungle: "Amumu", Mid: "Azir", Bot: "Varus", Support: "Leona" }, red: { Top: "Ornn", Jungle: "LeeSin", Mid: "Vex", Bot: "Jinx", Support: "Thresh" } },
];
const names = new Set(["쓰레쉬", "노틸러스", "레오나", "아무무", "리 신", "벡스"]);
let hit = 0, hitMoved = 0, miss = 0, missMoved = 0, sameStep = 0;
const delays: number[] = [];
const samples: string[] = [];
const secs = (line: string) => {
  const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
for (let g = 0; g < N; g++) {
  const lu = lineups[g % lineups.length];
  const e = new Engine({ s, data, blue: s.lck[g % 10], red: s.lck[(g + 3) % 10], picks: lu, seed: 500 + g });
  // last hook cast per caster (log name "B:Player(champ)"), so the follow-up move can be matched to it
  const last = new Map<string, { t: number; hit: boolean }>();
  Fight.setLog(e, (line) => {
    if (process.env.DUMP) console.log("DUMP " + line);
    const follow = line.match(/\] +([BR]:[^ ]+\(([^)]+)\)) follows the hook/);
    if (follow) {
      const c = last.get(follow[1]);
      if (!c) return;
      if (c.hit) { hitMoved++; delays.push(secs(line) - c.t); } else missMoved++;
      last.delete(follow[1]);
      if (samples.length < 8) samples.push(line.trim());
      return;
    }
    const m = line.match(/\] +([BR]:[^ ]+\(([^)]+)\)) \[[^\]]+\] ([QWER]) /);
    if (!m || !names.has(m[2])) return;
    const keyOk = (m[2] === "레오나" && m[3] === "E") || (m[2] === "벡스" && m[3] === "R") || (!["레오나", "벡스"].includes(m[2]) && m[3] === "Q");
    if (!keyOk) return;
    const isHit = / HIT /.test(line);
    if (/\(dash \d+u\)/.test(line)) sameStep++; // the caster moved in the cast step itself: must not happen any more
    last.set(m[1], { t: secs(line), hit: isHit });
    if (isHit) hit++; else miss++;
    if (samples.length < 8 && (!isHit || samples.length < 4)) samples.push(line.trim());
  });
  e.runToEnd();
  if (process.env.DUMP) console.log("game", g, Math.round(e.t), e.kills, e.units.map((u) => u.champ.id).join(","));
}
const avgDelay = delays.length ? delays.reduce((a, x) => a + x, 0) / delays.length : 0;
console.log(`hook casts: hit ${hit} (caster followed ${hitMoved}, ${avgDelay.toFixed(2)} s after the cast), missed ${miss} (followed ${missMoved}), moved in the cast step ${sameStep}`);
for (const l of samples) console.log("  " + l);
if (missMoved > 0 || sameStep > 0) { console.log("FAIL: a missed hook moved the caster, or a hook moved it before flying"); process.exitCode = 1; }
