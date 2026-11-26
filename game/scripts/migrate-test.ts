// Turn a fresh game into a v1-shaped save (no academies, no meta, no EWC), then migrate it and play on.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, migrateSave, newGame, userSeriesToday, resolveEvent } from "../src/core/game";
import { playQuickSeries } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { fmtDate } from "../src/core/format";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const s = newGame(data, { team: "KRX", difficulty: "normal", manager: "t", seed: 3 });
// strip to v1
for (const id of s.lck) {
  for (const pid of s.teams[id].academy ?? []) {
    const p = s.players[pid];
    p.team = null;
    p.academy = false;
    p.contract = null;
  }
  delete s.teams[id].academy;
}
delete s.meta;
s.comps = s.comps.filter((c) => c.id !== "EWC" && c.id !== "EWCQ");
s.version = 1;
s.day = 17;
console.log("notes:", migrateSave(s, data));
console.log("version", s.version, "patch", s.meta?.patch, "academy sizes", s.lck.map((id) => (s.teams[id].academy ?? []).length).join(","));
console.log("comps", s.comps.filter((c) => c.season === s.season).map((c) => `${c.id}@${fmtDate(c.start, false)}`).join(" "));
const rng = new Rng(1);
for (let i = 0; i < 800 && s.season === 2027; i++) {
  autoAdvance(s, data, "match");
  if (s.events.length) resolveEvent(s, s.events[0].id, 0);
  s.cutscenes.length = 0;
  const sr = userSeriesToday(s);
  if (sr) { playQuickSeries(s, data, sr, rng); closeUserSeries(s, data, sr); }
}
console.log("2027 done:", s.comps.filter((c) => c.season === 2027).map((c) => `${c.id}:${c.champion ? s.teams[c.champion].short : "-"}`).join(" "));
console.log("patches seen", s.meta?.history.map((h) => h.patch).join(","));
