// Starters' fatigue over the first weeks of the LCK Cup at each training intensity, with and without auto rest.
// Run: node scripts/run-ts.mjs scripts/fatigue-test.ts
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { advanceDay, closeUserSeries, newGame, resolveEvent, userSeriesToday } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { playQuickSeries, fatiguePenalty, starterFatigue } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { ovr } from "../src/core/player";
import { seasonDates } from "../src/core/schedule";
import type { Intensity } from "../src/core/training";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));

function run(intensity: Intensity, autoRestAt: number | null) {
  const s = newGame(data, { team: "KT", difficulty: "normal", manager: "t", seed: 5 });
  const me = s.teams[s.user];
  const pool = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => ovr(b) - ovr(a));
  for (const r of ROLES) {
    const p = pool.find((x) => x.role === r && !x.team);
    if (p) joinTeam(s, p, s.user, 10000, 2);
  }
  autoLineup(s, me);
  me.trainPlan = { intensity, autoRestAt };
  // everyone trains (no manual rest), the default focus
  for (const id of me.roster) s.players[id].train = "mechanics";
  const rng = new Rng(3);
  const cup = seasonDates(s.season).cup;
  const marks: string[] = [];
  let series = 0;
  while (s.day < cup + 35) {
    const before = s.day;
    advanceDay(s, data);
    if (s.events.length) resolveEvent(s, s.events[0].id, 0);
    s.cutscenes.length = 0;
    const sr = userSeriesToday(s);
    if (sr) {
      playQuickSeries(s, data, sr, rng);
      closeUserSeries(s, data, sr);
      series++;
      advanceDay(s, data);
    }
    if (s.day === before) break;
    const rel = s.day - cup;
    if (rel >= -14 && rel % 7 === 0) {
      const f = starterFatigue(s, s.user);
      marks.push(`${rel >= 0 ? "+" : ""}${rel}d ${f.toFixed(0)}(-${fatiguePenalty(f).toFixed(1)})`);
    }
  }
  const max = Math.max(...me.roster.map((id) => s.players[id].fatigue));
  console.log(`${intensity.padEnd(6)} autoRest=${String(autoRestAt).padEnd(4)} series=${series} | ${marks.join("  ")} | max now ${max.toFixed(0)}`);
}

for (const auto of [null, 75] as (number | null)[]) for (const i of ["light", "normal", "hard"] as Intensity[]) run(i, auto);
