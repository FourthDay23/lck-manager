// Play through seasons headlessly: user series are quick-simmed. Catches errors in stage transitions and rollover.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, userSeriesToday, resolveEvent, phaseLabel } from "../src/core/game";
import { playQuickSeries } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { fmtDate, money } from "../src/core/format";
import { ovr } from "../src/core/player";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const team = process.argv[3] ?? "T1";
const s = newGame(data, { team, difficulty: "normal", manager: "t", seed: 99 });
const rng = new Rng(5);
const seasons = Number(process.argv[4] ?? 1.5);
const endDay = Math.round(365 * seasons);
let lastPhase = "";
let guard = 0;
while (s.day < endDay && guard++ < 5000) {
  const stop = autoAdvance(s, data, "match");
  if (s.events.length) resolveEvent(s, s.events[0].id, 0);
  s.cutscenes.length = 0;
  const sr = userSeriesToday(s);
  if (sr) {
    playQuickSeries(s, data, sr, rng);
    closeUserSeries(s, data, sr);
  }
  const ph = phaseLabel(s);
  if (ph !== lastPhase) {
    lastPhase = ph;
    const me = s.teams[s.user];
    console.log(`${fmtDate(s.day)} | ${ph} | cash ${money(me.cash)} | roster ${me.roster.length} | fame ${Math.round(me.fame)} fans ${me.fans} | stop ${stop}`);
  }
}
for (const c of s.comps) console.log(c.season, c.id, c.done ? "done" : "open", c.champion ? s.teams[c.champion].name : "-", c.teams.length);
console.log("trophies", s.trophies.map((t) => t.name));
console.log("series total", s.series.length, "done", s.series.filter((x) => x.done).length);
console.log("news kinds", Object.entries(s.news.reduce((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {} as Record<string, number>)));
const me = s.teams[s.user];
console.log("user lineup", Object.values(me.lineup).map((id) => (id ? `${s.players[id].name}(${ovr(s.players[id])})` : "-")).join(", "));
console.log("ledger", s.ledger.slice(0, 4).map((l) => `${l.month}: +${money(Object.values(l.income).reduce((a, b) => a + b, 0))} -${money(Object.values(l.expense).reduce((a, b) => a + b, 0))}`).join(" | "));
console.log("players retired", Object.values(s.players).filter((p) => p.retired).length, "gen", s.genCount);
for (const name of ["Viper", "kyeahoo", "Morgan", "Loki", "Berserker"]) {
  const ps = Object.values(s.players).filter((p) => p.name === name);
  console.log(name, ps.map((p) => `${p.id} -> ${p.team ? s.teams[p.team].name : "FA"} (${p.origin})`).join(" | "));
}
console.log("academies", s.lck.map((id) => `${s.teams[id].short}:${(s.teams[id].academy ?? []).length}(${(s.teams[id].academy ?? []).filter((x) => s.players[x].origin === "real").length} real)`).join(" "));
console.log("callup news", s.news.filter((n) => n.title.includes("콜업")).length, s.news.filter((n) => n.title.includes("콜업")).slice(0, 3).map((n) => n.title));
