// AI clubs' starter fatigue through a season (they must not pile it up now that it costs power).
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { advanceDay, closeUserSeries, newGame, resolveEvent, userSeriesToday, phaseLabel } from "../src/core/game";
import { playQuickSeries, starterFatigue, fatiguePenalty } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { fmtDate } from "../src/core/format";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const s = newGame(data, { team: "T1", difficulty: "normal", manager: "t", seed: 8 });
const rng = new Rng(2);
let next = 60;
while (s.day < 330) {
  advanceDay(s, data);
  if (s.events.length) resolveEvent(s, s.events[0].id, 0);
  s.cutscenes.length = 0;
  const sr = userSeriesToday(s);
  if (sr) { playQuickSeries(s, data, sr, rng); closeUserSeries(s, data, sr); advanceDay(s, data); }
  if (s.day >= next) {
    next += 45;
    const ai = s.lck.filter((x) => x !== s.user).map((t) => starterFatigue(s, t));
    const avg = ai.reduce((a, b) => a + b, 0) / ai.length;
    console.log(`${fmtDate(s.day, false).padEnd(14)} ${phaseLabel(s).padEnd(16)} AI starters avg ${avg.toFixed(0)} max ${Math.max(...ai).toFixed(0)} (penalty ${fatiguePenalty(Math.max(...ai)).toFixed(1)}) | user ${starterFatigue(s, s.user).toFixed(0)}`);
  }
}
