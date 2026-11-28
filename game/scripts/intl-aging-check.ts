// Foreign clubs over several seasons (T22): each club's starting five (name, age, OVR) at every season start.
// Run: node scripts/run-ts.mjs scripts/intl-aging-check.ts [seasons=6] [clubs=BLG,KC,G2] [seed=1000]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, userSeriesToday, resolveEvent } from "../src/core/game";
import { playQuickSeries } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { age, ovr } from "../src/core/player";
import { ROLES } from "../src/data/types";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));

const SEASONS = Number(process.argv[3] ?? 6);
const CLUBS = (process.argv[4] ?? "BLG,KC,G2").split(",");
const seed = Number(process.argv[5] ?? 1000);
const s = newGame(data, { team: "KT", difficulty: "normal", manager: "t", seed });
const rng = new Rng(seed * 7 + 1);
const first = s.season;
const show = () => {
  console.log(`\n== ${s.season} season start`);
  for (const id of CLUBS) {
    const t = s.teams[id];
    if (!t) continue;
    const five = ROLES.map((r) => s.players[t.lineup[r]!]).filter(Boolean);
    const avg = five.reduce((a, p) => a + ovr(p), 0) / five.length;
    console.log(`${id.padEnd(4)} level ${(t.intlStrength ?? 0).toFixed(0)} avg ${avg.toFixed(1)} | ` + five.map((p) => `${p.name} ${age(p, s.season)}세 ${ovr(p)}`).join(" · "));
  }
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
