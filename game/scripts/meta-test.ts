// Same rosters on both sides; one side drafts patch S/A champions, the other avoids them. How often does the meta side win?
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import type { Role } from "../src/data/types";
import { metaTier, teamMetaBonus } from "../src/core/meta";
import { gameWinProb } from "../src/core/quick";
import { ovr } from "../src/core/player";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const s = newGame(data, { team: "T1", difficulty: "normal", manager: "t", seed: 4 });
s.user = "__nobody__";
const rr = new Rng(8);
const pool = rr.shuffle(Object.values(s.players).filter((p) => !p.team && p.origin === "real"));
const [A, B] = [s.lck[0], s.lck[1]];
for (const r of ROLES) {
  const byOvr = pool.filter((p) => p.role === r).sort((x, y) => ovr(y) - ovr(x)).slice(4, 6);
  const two = byOvr;
  joinTeam(s, two[0], A, 10000, 2);
  joinTeam(s, two[1], B, 10000, 2);
}
for (const id of [...s.teams[A].roster, ...s.teams[B].roster]) { const p = s.players[id]; p.mastery = {}; for (const c of data.champions) p.mastery[c.id] = 70; }
autoLineup(s, s.teams[A]);
autoLineup(s, s.teams[B]);
const pickFor = (r: Role, wantMeta: boolean, used: Set<string>) => {
  const c = data.champions.filter((c) => (c.roles[r] ?? 0) >= 0.35 && !used.has(c.id) && (wantMeta ? metaTier(s, c.id) === "S" || metaTier(s, c.id) === "A" : !metaTier(s, c.id)))
    .sort((a, b) => b.pro.picks - a.pro.picks)[0];
  used.add(c.id);
  return c.id;
};
const N = Number(process.argv[3] ?? 200);
let metaWins = 0, bonus = 0;
for (let g = 0; g < N; g++) {
  const used = new Set<string>();
  const metaSide = g % 2; // alternate sides so blue edge cancels
  const picks = { blue: {} as Record<Role, string>, red: {} as Record<Role, string> };
  for (const r of ROLES) {
    picks.blue[r] = pickFor(r, metaSide === 0, used);
    picks.red[r] = pickFor(r, metaSide === 1, used);
  }
  const blue = g % 4 < 2 ? A : B, red = blue === A ? B : A;
  const e = new Engine({ s, data, blue, red, picks, seed: 500 + g });
  e.runToEnd();
  if (e.winner === metaSide) metaWins++;
  bonus += teamMetaBonus(s, Object.values(metaSide === 0 ? picks.blue : picks.red));
}
console.log(`patch ${s.meta?.patch}: meta side won ${metaWins}/${N} = ${(metaWins / N * 100).toFixed(1)}% (avg team meta bonus ${(bonus / N).toFixed(2)}); even rosters p=${gameWinProb(s, A, B).toFixed(2)}`);
