// Where the talent goes over seasons (T22): active players by OVR band and by where they are (LCK club, LCK 2군,
// foreign club, free agent), plus the age of the top 50, at every season start. All LCK clubs AI-run like dynasty-check.
// Run: node scripts/run-ts.mjs scripts/talent-check.ts [seasons=8] [seed=1000]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, userSeriesToday, resolveEvent } from "../src/core/game";
import { playQuickSeries } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { age, ovr } from "../src/core/player";
import type { GameState } from "../src/core/types";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));

const SEASONS = Number(process.argv[3] ?? 8);
const seed = Number(process.argv[4] ?? 1000);
const s = newGame(data, { team: "KT", difficulty: "normal", manager: "t", seed });
const rng = new Rng(seed * 7 + 1);
const first = s.season;
const where = (st: GameState, id: string) => {
  const p = st.players[id];
  if (!p.team) return "FA";
  if (st.intl.includes(p.team)) return "intl";
  return p.academy ? "2군" : "LCK";
};
const show = () => {
  const act = Object.values(s.players).filter((p) => !p.retired);
  const bands = [85, 80, 75, 70];
  const line = (pred: (o: number) => boolean) => {
    const xs = act.filter((p) => pred(ovr(p)));
    const c: Record<string, number> = { LCK: 0, "2군": 0, intl: 0, FA: 0 };
    for (const p of xs) c[where(s, p.id)]++;
    return `${String(xs.length).padStart(3)} (LCK ${c.LCK} 2군 ${c["2군"]} intl ${c.intl} FA ${c.FA})`;
  };
  const top = act.filter((p) => !p.team || !s.intl.includes(p.team)).sort((a, b) => ovr(b) - ovr(a)).slice(0, 50);
  const lckOrigin = act.filter((p) => p.origin !== "intl");
  console.log(`${s.season}: ` + bands.map((b) => `>=${b}: ${line((o) => o >= b)}`).join(" | ")
    + ` | non-intl top50 avg OVR ${(top.reduce((a, p) => a + ovr(p), 0) / 50).toFixed(1)} age ${(top.reduce((a, p) => a + age(p, s.season), 0) / 50).toFixed(1)}`
    + ` | non-intl active ${lckOrigin.length}, <=21y ${lckOrigin.filter((p) => age(p, s.season) <= 21).length}, best <=21y ${Math.max(...lckOrigin.filter((p) => age(p, s.season) <= 21).map(ovr))}`);
};
show();
let guard = 0;
while (s.season < first + SEASONS && guard++ < 20000) {
  const season = s.season;
  try { autoAdvance(s, data, "day"); } catch (e) { if (!String((e as Error).stack).includes("events.ts")) throw e; }
  while (s.events.length) resolveEvent(s, s.events[0].id, 0);
  s.cutscenes.length = 0;
  s.alerts = [];
  s.tradeOffers = [];
  s.saleOffers = [];
  const sr = userSeriesToday(s);
  if (sr) { playQuickSeries(s, data, sr, rng); closeUserSeries(s, data, sr); }
  if (s.over) { s.teams[s.user].cash = 1e9; s.over = undefined; }
  if (s.season !== season) show();
}
// who left the game, by reason, among non-foreign players who were 75+ when they left
const gone = Object.values(s.players).filter((p) => p.retired && p.origin !== "intl" && ovr(p) >= 75);
const reasons: Record<string, { n: number; age: number; ovr: number }> = {};
for (const p of gone) {
  const why = p.history[p.history.length - 1]?.split(": ")[1] ?? "?";
  const r = (reasons[why] = reasons[why] ?? { n: 0, age: 0, ovr: 0 });
  r.n++;
  r.age += s.season - p.birthYear;
  r.ovr += ovr(p);
}
console.log(`\nleft the game with OVR 75+ (non-foreign) over ${SEASONS} seasons: ` + Object.entries(reasons).map(([k, r]) => `${k} ${r.n} (avg OVR ${(r.ovr / r.n).toFixed(1)}, age now ${(r.age / r.n).toFixed(1)})`).join(" · "));
// rookies made during the career (gen:) that reached 75+
const gens = Object.values(s.players).filter((p) => p.origin === "gen");
console.log(`generated rookies ${gens.length}: best OVR ${Math.max(...gens.map(ovr))}, 70+ ${gens.filter((p) => ovr(p) >= 70).length}, 75+ ${gens.filter((p) => ovr(p) >= 75).length}, on an LCK roster ${gens.filter((p) => p.team && s.lck.includes(p.team) && !p.academy).length}, avg pot ${(gens.reduce((a, p) => a + p.pot, 0) / gens.length).toFixed(1)}`);
