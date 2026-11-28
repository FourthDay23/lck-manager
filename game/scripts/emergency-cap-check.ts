// T20: an AI club's emergency signing (an empty starting role nobody can be called up for) keeps to its payroll cap.
// For each run it plays to the day before the LCK 컵, then for every AI club in turn empties the Mid role (roster and
// 2군), sets the room left under the cap, and plays one day: the cup-eve fill (game.ts ensureAiLineups) must sign
// someone who fits under the cap, or someone on the league minimum when the club has less room than that. The same
// is done the day before a regular-season match (ensureAiLineupFor).
//
// Run: node scripts/run-ts.mjs scripts/emergency-cap-check.ts [runs=10]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, resolveEvent, userSeriesToday } from "../src/core/game";
import { playQuickSeries } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { ovr, salaryAsk } from "../src/core/player";
import { seasonDates } from "../src/core/schedule";
import { aiPayrollCap, payroll, releasePlayer } from "../src/core/market";
import type { Role } from "../src/data/types";
import type { GameState } from "../src/core/types";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));

const RUNS = Number(process.argv[3] ?? 10);
const MIN = 6000;
const ROLE: Role = "Mid";
// room left under the cap before the fill, in 만원: over the cap, under the minimum, a little, a lot
const ROOMS = [-20000, 3000, 15000, 60000, 100000];

const rng = new Rng(77);
/** One day, with the user's own series played on the spot (the day does not move on while one is waiting). */
function day(s: GameState) {
  const before = s.day;
  for (let i = 0; i < 5 && s.day === before; i++) {
    try {
      autoAdvance(s, data, "day");
    } catch (e) {
      // events.ts P14 (fixed separately in T21) can throw at the very end of a day; the day stands
      if (!String((e as Error).stack).includes("events.ts")) throw e;
    }
    while (s.events.length) resolveEvent(s, s.events[0].id, 0);
    s.cutscenes.length = 0;
    s.alerts = [];
    s.tradeOffers = [];
    s.saleOffers = [];
    const sr = userSeriesToday(s);
    if (sr) {
      playQuickSeries(s, data, sr, rng);
      closeUserSeries(s, data, sr);
    }
    if (s.over) { s.teams[s.user].cash = 1e9; s.over = undefined; }
  }
  if (s.day === before) throw new Error(`day ${before} does not advance`);
}

/** Empty `tid`'s Mid role, leave it `room` under its cap, play one day, and judge the signing. */
function trial(base: GameState, tid: string, room: number, path: string) {
  const s = structuredClone(base);
  const t = s.teams[tid];
  for (const id of [...t.roster, ...(t.academy ?? [])]) if (s.players[id]?.role === ROLE) releasePlayer(s, s.players[id], "check");
  s.bids = s.bids.filter((b) => b.team !== tid);
  // set the room by moving the salary of the club's best-paid player
  const top = t.roster.map((id) => s.players[id]).filter((p) => p?.contract).sort((a, b) => b.contract!.salary - a.contract!.salary)[0];
  if (!top) return null;
  const delta = aiPayrollCap(t) - room - payroll(s, t);
  if (top.contract!.salary + delta < MIN) return null;
  top.contract!.salary += delta;
  const best = Object.values(s.players).filter((p) => !p.team && !p.retired && p.role === ROLE && p.origin !== "intl" && !p.scandal)
    .sort((a, b) => ovr(b) - ovr(a))[0];
  day(s);
  const pid = s.teams[tid].lineup[ROLE];
  const p = pid ? s.players[pid] : null;
  const salary = p?.contract?.salary ?? 0;
  // signed during the day just played (the match-day fill runs after the date has moved on)
  const newSigning = !!p && (p.contract?.signedDay ?? -1) >= base.day;
  const over = payroll(s, s.teams[tid]) - aiPayrollCap(s.teams[tid]);
  const ok = !!p && (!newSigning || (room >= MIN ? salary <= room : salary <= MIN));
  return {
    path, tid, room, ok, empty: !p, newSigning, salary, over,
    who: p ? `${p.name} OVR ${ovr(p).toFixed(0)} ask ${salaryAsk(p, s.season)}` : "-",
    best: best ? `${best.name} OVR ${ovr(best).toFixed(0)} ask ${salaryAsk(best, s.season)}` : "-",
  };
}

let total = 0, bad = 0, empty = 0;
const byRoom: Record<string, { n: number; signed: number; ok: number; salary: number[]; ovr: number[] }> = {};
for (let run = 0; run < RUNS; run++) {
  const s = newGame(data, { team: "KT", difficulty: "normal", manager: "t", seed: 3000 + run });
  const d = seasonDates(s.season);
  while (s.day < d.cup - 1) day(s);
  const ai = s.lck.filter((x) => x !== s.user);
  const cases: [GameState, string, string][] = ai.map((tid) => [s, tid, "cup eve"]);
  // the day before each AI club's first regular-season series
  const s2 = structuredClone(s);
  while (s2.day < d.reg - 1) day(s2);
  for (const tid of ai) {
    const next = s2.series.filter((x) => !x.done && (x.a === tid || x.b === tid) && x.day > s2.day).sort((a, b) => a.day - b.day)[0];
    if (!next) continue;
    const s3 = structuredClone(s2);
    while (s3.day < next.day - 1) day(s3);
    cases.push([s3, tid, "match day"]);
  }
  for (const [base, tid, path] of cases) {
    for (const room of ROOMS) {
      const r = trial(base, tid, room, path);
      if (!r) continue;
      total++;
      if (!r.ok) bad++;
      if (r.empty) empty++;
      const k = `${path} · room ${room}`;
      const b = (byRoom[k] = byRoom[k] ?? { n: 0, signed: 0, ok: 0, salary: [], ovr: [] });
      b.n++;
      if (r.ok) b.ok++;
      if (r.newSigning) {
        b.signed++;
        b.salary.push(r.salary);
        b.ovr.push(Number(r.who.match(/OVR (\d+)/)?.[1] ?? 0));
      }
      if (!r.ok && bad <= 8) console.log(`  over: ${path} ${tid} room ${room} → ${r.who} at ${r.salary} (best free agent ${r.best}), club ${r.over > 0 ? "+" : ""}${r.over} vs cap`);
    }
  }
  console.error(`run ${run + 1}/${RUNS}`);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log("case (room in 만원)           trials  signed  within cap  signing salary  signing OVR");
for (const [k, b] of Object.entries(byRoom)) {
  console.log(`${k.padEnd(28)} ${String(b.n).padStart(6)}  ${String(b.signed).padStart(6)}  ${String(b.ok).padStart(10)}  ${mean(b.salary).toFixed(0).padStart(14)}  ${mean(b.ovr).toFixed(1).padStart(11)}`);
}
console.log(`\n${total} emergency fills: ${bad} broke the cap, ${empty} left the role empty`);
if (bad || empty) process.exitCode = 1;
