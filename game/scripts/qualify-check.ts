// International qualification screens: play one season headlessly as the strongest LCK roster (the user's own team
// starts empty, so after the stove league the user switches to the best AI-built team) and list the "qualify"
// cutscenes the user would see, with the day and the inbox line.
//   node scripts/run-ts.mjs scripts/qualify-check.ts
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, userSeriesToday, resolveEvent } from "../src/core/game";
import { playQuickSeries, teamPower } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { fmtDate } from "../src/core/format";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const s = newGame(data, { team: "T1", difficulty: "normal", manager: "t", seed: 99 });
const rng = new Rng(5);
let switched = false;
const seen: string[] = [];
let guard = 0;
while (s.day < 365 && guard++ < 5000) {
  autoAdvance(s, data, "match");
  if (!switched && s.day >= 45) {
    const best = [...s.lck].sort((a, b) => teamPower(s, b) - teamPower(s, a))[0];
    s.user = best;
    switched = true;
    console.log(`${fmtDate(s.day)}: playing as ${s.teams[best].name} (power ${teamPower(s, best).toFixed(1)})`);
  }
  if (s.events.length) resolveEvent(s, s.events[0].id, 0);
  for (const c of s.cutscenes) if (c.kind === "qualify") seen.push(`${fmtDate(s.day)} | ${c.title} | ${c.sub} | ${c.team} | ${c.lines?.length ?? 0} players`);
  s.cutscenes.length = 0;
  const sr = userSeriesToday(s);
  if (sr) {
    playQuickSeries(s, data, sr, rng);
    closeUserSeries(s, data, sr);
  }
}
console.log("qualify screens:");
for (const x of seen) console.log("  " + x);
console.log("inbox:", s.inbox.filter((m) => m.text.includes("진출이 확정")).map((m) => m.text));
for (const c of s.comps.filter((c) => ["MSI", "EWCQ", "EWC", "WORLDS"].includes(c.id))) console.log(c.id, c.teams.includes(s.user) ? "user in" : "user out", c.champion ? `won by ${s.teams[c.champion].short}` : "");
