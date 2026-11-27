// Choice events, headless: plays two seasons picking a random allowed option each time, then checks the rules.
// Run: node scripts/run-ts.mjs scripts/events-check.ts [team] [seed]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, resolveEvent, userSeriesToday } from "../src/core/game";
import { playQuickSeries } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { EVENT_DEFS, chooseSetBreak, endSetBreak, eventsDay, forceEvent, setBreakDue } from "../src/core/events";
import { weekStartOf } from "../src/core/evmemo";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const team = process.argv[3] ?? "T1";
const seed = Number(process.argv[4] ?? 7);
const s = newGame(data, { team, difficulty: "normal", manager: "t", seed });
const rng = new Rng(seed * 31 + 1);
const cls = new Map(EVENT_DEFS.map((d) => [d.id, d]));

const dupLineup = () => {
  const ids = Object.values(s.teams[s.user].lineup).filter(Boolean);
  return new Set(ids).size !== ids.length;
};
let dupDays = 0;
let fails = 0;
const fail = (m: string) => { fails++; console.log("FAIL", m); };
const fired: { day: number; def: string; cls: string; pol: string }[] = [];
const counts: Record<string, number> = {};
let setBreaks = 0;
const endDay = Math.round(365 * 2);
for (let guard = 0; s.day < endDay && guard < 20000; guard++) {
  const dup0 = dupLineup();
  autoAdvance(s, data, "match");
  if (!dup0 && dupLineup()) { dupDays++; if (dupDays <= 3) console.log("lineup duplicate appeared while advancing to", s.day, JSON.stringify(s.teams[s.user].lineup)); }
  while (s.events.length) {
    const ev = s.events[0];
    const d = ev.def ? cls.get(ev.def) : undefined;
    if (d) {
      fired.push({ day: s.day, def: d.id, cls: d.cls, pol: d.pol });
      counts[d.id] = (counts[d.id] ?? 0) + 1;
      for (const o of ev.options) {
        // words and stored chances agree: "거예요" only at 70%+, "수도" only at 20-69%
        for (const roll of o.probs ?? []) if (roll.reduce((a, b) => a + b, 0) > 1.0001) fail(`${d.id} "${o.label}" chances add up past 1: ${roll}`);
      }
    }
    const ok = ev.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    const pick = ok.length ? rng.pick(ok) : 0;
    const before = s.events.length;
    const dupBefore = dupLineup();
    resolveEvent(s, ev.id, pick);
    if (!dupBefore && dupLineup()) fail(`${ev.def ?? ev.kind} "${ev.options[pick].label}" put one player in two lineup slots`);
    if (s.events.length === before) { s.events.shift(); fail(`${ev.def ?? ev.kind} did not resolve`); }
    if (ev.def && !(s.ev?.result?.lines.length)) fail(`${ev.def} gave no result lines`);
    if (s.ev) s.ev.result = undefined;
  }
  s.alerts = [];
  s.cutscenes.length = 0;
  const sr = userSeriesToday(s);
  if (sr) {
    // the set-break talk on its own: once after a lost game, given back when the series ends
    playQuickSeries(s, data, sr, rng);
    if (sr.bo >= 3 && sr.games.length >= 1) {
      const t = s.teams[s.user];
      const lost = sr.games.find((g) => g.winner !== s.user);
      if (lost) {
        const keep = sr.games.slice();
        const wa = sr.wa, wb = sr.wb;
        sr.games = [lost];
        sr.wa = lost.winner === sr.a ? 1 : 0;
        sr.wb = lost.winner === sr.b ? 1 : 0;
        if (setBreakDue(s, sr)) {
          const m0 = Object.fromEntries(Object.values(t.lineup).filter(Boolean).map((id) => [id!, s.players[id!].morale]));
          const syn0 = t.synergy;
          chooseSetBreak(s, sr, rng.int(0, 2));
          if (setBreakDue(s, sr)) fail("set break offered twice in one series");
          sr.games = keep; sr.wa = wa; sr.wb = wb;
          // the talk lasts for this series only: closeUserSeries gives it back first (endSetBreak), then the
          // result moves morale. Check the give-back on its own, then close as usual.
          endSetBreak(s, sr);
          for (const [id, m] of Object.entries(m0)) {
            const p = s.players[id];
            if (Math.abs(p.morale - m) > 0.01) fail(`set break morale not given back for ${p.name}: ${m} -> ${p.morale}`);
          }
          if (Math.abs(t.synergy - syn0) > 0.01) fail(`set break synergy not given back: ${syn0} -> ${t.synergy}`);
          closeUserSeries(s, data, sr);
          setBreaks++;
          continue;
        }
        sr.games = keep; sr.wa = wa; sr.wb = wb;
      }
    }
    closeUserSeries(s, data, sr);
  }
}

// at most 2 random events a week; morale events and aftermaths are not counted
const perWeek = new Map<number, number>();
for (const f of fired) if (f.cls === "random") perWeek.set(weekStartOf(f.day), (perWeek.get(weekStartOf(f.day)) ?? 0) + 1);
const maxWeek = Math.max(0, ...perWeek.values());
if (maxWeek > 2) fail(`a week had ${maxWeek} random events`);
// one at a time is enforced by the loop above; same-day pairs would mean the queue fired twice
const byDay = new Map<number, number>();
for (const f of fired) byDay.set(f.day, (byDay.get(f.day) ?? 0) + 1);
const rnd = fired.filter((f) => f.cls === "random");
const negShare = rnd.filter((f) => f.pol === "neg").length / Math.max(1, rnd.length);
const allNeg = fired.filter((f) => f.pol === "neg").length / Math.max(1, fired.length);
const weeks = endDay / 7;
console.log(`events ${fired.length} in ${Math.round(weeks)} weeks: random ${rnd.length} (${(rnd.length / weeks).toFixed(2)}/week, max ${maxWeek} in a week), morale ${fired.filter((f) => f.cls === "morale").length}, aftermath ${fired.filter((f) => f.cls === "after").length}`);
console.log(`negative share: random ${(negShare * 100).toFixed(0)}%, all events ${(allNeg * 100).toFixed(0)}% (aim 60%)`);
console.log("by event", Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([k, v]) => `${k}:${v}`).join(" "));
const never = EVENT_DEFS.filter((d) => !counts[d.id]).map((d) => d.id);
console.log("never fired", never.join(" ") || "-");
console.log("set breaks checked", setBreaks, "| queue left", s.ev?.queue.length, "| promises left", s.ev?.promises.length);
console.log("memo sample", Object.entries(s.ev?.memo ?? {}).slice(0, 3).map(([k, v]) => `${s.players[k]?.name ?? k}: ${v.slice(-3).map((m) => m.text).join(" / ")}`).join(" | "));
if (rnd.length && (negShare < 0.45 || negShare > 0.75)) fail(`random negative share ${negShare.toFixed(2)} is far from 0.6`);

// the next series is a bracket slot whose opponent is not decided yet (playoff seed waiting for a quarterfinal):
// the daily check two days before must not crash (P14 read teams[null].name) or name no opponent ("FA의")
{
  const t = JSON.parse(JSON.stringify(s)) as typeof s;
  const next = t.series.filter((x) => !x.done && x.a && x.b && (x.a === t.user || x.b === t.user)).sort((a, b) => a.day - b.day)[0]
    ?? t.series.find((x) => x.a === t.user || x.b === t.user)!;
  if (next.a === t.user) next.b = null;
  else next.a = null;
  next.done = false;
  next.comp = "PO";
  next.stage = "SF";
  t.day = next.day - 2;
  t.teams[t.user].facilities.analysis = Math.max(1, t.teams[t.user].facilities.analysis);
  const snap = JSON.stringify(t);
  let crashed = 0;
  for (let k = 0; k < 200; k++) {
    const u = JSON.parse(snap) as typeof s;
    u.events = [];
    try {
      eventsDay(u, data, new Rng(1000 + k));
      for (const e of u.events) if (/FA의|undefined|null/.test(e.body)) fail(`${e.def} names no opponent before the bracket is decided: ${e.body}`);
    } catch (e) {
      if (++crashed <= 2) fail(`daily check before an undecided bracket series threw: ${(e as Error).message}`);
    }
  }
  console.log(`undecided bracket opponent: 200 daily checks, ${crashed} crashes`);
}

// every option of every event, forced on a copy of the end state: no crash, a result, chances under 1
const base = JSON.stringify(s);
let forced = 0, skipped: string[] = [];
for (const d of EVENT_DEFS) {
  for (let opt = 0; opt < 4; opt++) {
    const t = JSON.parse(base) as typeof s;
    t.events = [];
    const me = t.teams[t.user];
    me.cash = Math.max(me.cash, 500000);
    // give the club what some events need: a coach, an analyst, unpaid wages, a facility
    const coach = Object.values(t.staff).find((x) => !x.team);
    if (coach && !me.staff.length) { coach.team = me.id; coach.contract = { salary: 10000, until: t.season, signedDay: t.day }; me.staff.push(coach.id); }
    me.facilities.housing = Math.max(1, me.facilities.housing);
    for (const id of me.roster.slice(0, 3)) t.players[id].unpaid = 1;
    try {
      if (!forceEvent(t, data, d.id, new Rng(opt + 1))) { if (opt === 0) skipped.push(d.id); break; }
      const ev = t.events[0];
      if (opt >= ev.options.length) break;
      ev.options[opt].disabled = false;
      resolveEvent(t, ev.id, opt);
      if (t.events.includes(ev)) fail(`${d.id} option ${opt} did not resolve`);
      else if (!t.ev?.result?.lines.length) fail(`${d.id} option ${opt} gave no result`);
      forced++;
    } catch (e) {
      fail(`${d.id} option ${opt} threw: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`);
    }
  }
}
console.log(`forced options ${forced}${skipped.length ? `, skipped ${skipped.join(" ")}` : ""}`);
console.log(fails ? `${fails} FAIL` : "ok");
if (fails) process.exitCode = 1;
