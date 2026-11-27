// Voidgrubs in headless engine games, in the same table as scripts/lck_grubs.py prints for the real LCK timelines:
// camp split per game, order of takers, visit sizes, why a team left with one or two, timing, who, fights and leads.
// Run: node scripts/run-ts.mjs scripts/grubs-diag.ts [games] [rosterSeed]
//   GRUB_TUNE=key:value,... overrides engine.ts GRUB_TUNE, GRUB_MACRO=... macro.ts GRUB_MACRO; STRAT=a,b forces both game plans; LOG=n prints game n's
//   grub kills and plan changes around them; JSON=C:/.../file.json writes the counts.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, applyGrubTune } from "../src/match/engine";
import type { SideN } from "../src/match/engine";
import * as Macro from "../src/match/macro";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { BARON_PIT } from "../src/match/map";

const dir = existsSync("public/data/champions.json") && existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => {
  const p = `public/${dir}/${f}`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
applyGrubTune(process.env.GRUB_TUNE);
// GRUB_MACRO=poach:0.3,stayEdge:1.1 overrides macro.ts GRUB_MACRO
for (const kv of (process.env.GRUB_MACRO ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split(":");
  if (!(k in Macro.GRUB_MACRO) || !Number.isFinite(Number(v))) throw new Error(`GRUB_MACRO: bad entry "${kv}"`);
  (Macro.GRUB_MACRO as Record<string, number>)[k] = Number(v);
}
const N = Number(process.argv[3] ?? 100);
const rosterSeed = Number(process.argv[4] ?? 3);
const LOG = process.env.LOG ? Number(process.env.LOG) : -1;
const SHORT = process.env.SHORT === "1";
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
s.user = "__nobody__";
const rr = new Rng(rosterSeed);
const pool = rr.shuffle(Object.values(s.players).filter((p) => !p.team && p.origin === "real"));
for (const r of ROLES) {
  const byRole = pool.filter((p) => p.role === r);
  for (const tid of s.lck) {
    if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
    const p = byRole.shift();
    if (p) joinTeam(s, p, tid, 10000, 2);
  }
}
for (const tid of s.lck) autoLineup(s, s.teams[tid]);
const rng = new Rng(11);

const VISIT_GAP = 20, NEAR = 2500, SPAWN = 480, LEAVE = 885;
const inc = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1).padStart(5)}%` : "   - ");
const quant = (xs: number[], ps = [10, 25, 50, 75, 90]) => {
  if (!xs.length) return "-";
  const a = [...xs].sort((x, y) => x - y);
  return ps.map((p) => a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))].toFixed(0)).join(" / ");
};
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const med = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : 0);

interface K { t: number; side: SideN; by: number; helpers: number; foe: boolean }
const split: Record<string, number> = {}, seq: Record<string, number> = {}, visits: Record<string, number> = {}, perGame: Record<string, number> = {};
const visitsLeft: Record<string, number> = {}, after: Record<string, number> = {}, ctx: Record<string, number> = {}, role: Record<string, number> = {}, part: Record<string, number> = {};
const leadTakes: Record<string, number> = {}, soloVisits: Record<string, number> = {};
const firstT: number[] = [], kth: number[][] = [[], [], []], gapIn: number[] = [], span: number[] = [], startDelay: number[] = [];
let killed = 0, blue = 0, partialN = 0, fightGames = 0, sharedN = 0, sharedSimul = 0, foeAssist = 0, firstAhead = 0, firstN = 0, games = 0;
let stacksWin = 0, stacksLose = 0;
const plans: Record<string, number> = {}, aborts: Record<string, number> = {};
const seqGames: Record<string, number[]> = {};
const winByGrubs: Record<string, { n: number; w: number }> = {};

for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const strategy = process.env.STRAT ? (process.env.STRAT.split(",").map((x) => x || null) as [never, never]) : undefined;
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g, strategy });
  const M = Macro.st(e);
  if (g === LOG && M) M.logOn = true;
  while (!e.over && e.t < SPAWN) e.step();
  const gold8 = [e.gold(0), e.gold(1)];
  // SHORT=1 stops at 15:00 (the camp is gone at 14:45): twice as fast, no results in [8]
  if (SHORT) while (!e.over && e.t < 900) e.step();
  else e.runToEnd();
  games++;
  const ks: K[] = e.grubLog.map((x) => ({ t: x.t, side: x.side, by: x.by, helpers: x.helpers, foe: x.foe }));
  const gone = 3 - ks.length;
  const nb = ks.filter((k) => k.side === 0).length, nr = ks.length - nb;
  inc(split, `${Math.max(nb, nr)}-${Math.min(nb, nr)} (+${gone} despawned)`);
  blue += nb;
  killed += ks.length;
  const pattern = ks.length ? ks.map((k) => (k.side === ks[0].side ? "A" : "B")).join("") + "-".repeat(gone) : "---";
  inc(seq, pattern);
  (seqGames[pattern] ??= []).push(g);
  ks.forEach((k, i) => {
    kth[i].push(k.t);
    inc(role, e.units[k.by].role);
    inc(part, String(Math.min(5, k.helpers)));
    if (k.foe) foeAssist++;
  });
  if (ks.length) firstT.push(ks[0].t);
  const vs: K[][] = [];
  for (const k of ks) {
    const last = vs[vs.length - 1];
    if (last && last[last.length - 1].side === k.side && k.t - last[last.length - 1].t <= VISIT_GAP) last.push(k);
    else vs.push([k]);
  }
  inc(perGame, String(vs.length));
  const kills = e.events.filter((x) => ["kill", "first_blood", "solo"].includes(x.type) && x.victim !== undefined && x.x !== undefined);
  const near = kills.filter((x) => Math.hypot(x.x! - BARON_PIT.x, x.y! - BARON_PIT.y) < NEAR);
  const lastT = ks.length ? ks[ks.length - 1].t : LEAVE;
  if (near.some((x) => x.t >= SPAWN - 30 && x.t <= lastT + 15)) fightGames++;
  let done = 0;
  vs.forEach((v, vi) => {
    done += v.length;
    const left = 3 - done;
    inc(visits, String(v.length));
    inc(visitsLeft, `(${v.length}, ${left})`);
    inc(soloVisits, v.every((k) => k.helpers === 1) ? "solo" : "group");
    for (let i = 1; i < v.length; i++) gapIn.push(v[i].t - v[i - 1].t);
    if (vi > 0) startDelay.push(v[0].t - vs[vi - 1][vs[vi - 1].length - 1].t);
    if (left > 0) {
      partialN++;
      const team = v[0].side, t0 = v[0].t, t1 = v[v.length - 1].t;
      const nxt = vs[vi + 1];
      if (!nxt) inc(after, "despawned (nobody came back)");
      else if (nxt[0].side === team) inc(after, "same team came back");
      else if (nxt[0].t - t1 <= VISIT_GAP) inc(after, "other team took the rest right there (within 20 s)");
      else inc(after, "other team took the rest later");
      const fight = near.filter((x) => x.t >= t0 - 25 && x.t <= t1 + 25);
      const ownDied = fight.some((x) => e.units[x.victim!].side === team);
      const foeDied = fight.some((x) => e.units[x.victim!].side !== team);
      const foeNow = !!nxt && nxt[0].side !== team && nxt[0].t - t1 <= VISIT_GAP;
      if (ownDied) inc(ctx, "a visitor's teammate died at the pit (+-25 s)");
      else if (foeDied) inc(ctx, "only enemies died at the pit (+-25 s)");
      else if (foeNow || v.some((k) => k.foe)) inc(ctx, "no kill, the enemy hit grubs too (smite / contest)");
      else inc(ctx, "no kill, no enemy on the grubs (left on their own)");
    }
  });
  if (vs.length === 1 && vs[0].length === 3) span.push(vs[0][2].t - vs[0][0].t);
  if (Math.max(nb, nr) === 2 && Math.min(nb, nr) === 1) {
    sharedN++;
    if (ks.some((k, i) => i > 0 && ks[i - 1].side !== k.side && k.t - ks[i - 1].t <= VISIT_GAP)) sharedSimul++;
  }
  if (ks.length) {
    const more = nb > nr ? 0 : nr > nb ? 1 : -1;
    if (more >= 0) {
      const lead = gold8[more] - gold8[1 - more];
      inc(leadTakes, lead >= 1000 ? "ahead 1k+" : lead >= 300 ? "ahead 0.3-1k" : lead > -300 ? "even (+-300)" : lead > -1000 ? "behind 0.3-1k" : "behind 1k+");
    }
    firstN++;
    if (gold8[ks[0].side] > gold8[1 - ks[0].side]) firstAhead++;
  }
  if (M) for (const ms of M.stats) {
    for (const [k, v] of Object.entries(ms.plans)) if (k.includes("grubs")) inc(plans, k, v);
    for (const [k, v] of Object.entries(ms.aborts)) if (k.includes("grubs")) inc(aborts, k, v);
  }
  const w = e.winner ?? 0;
  stacksWin += e.grubs[w];
  stacksLose += e.grubs[1 - w];
  if (e.over) for (const sd of [0, 1] as SideN[]) {
    const r = (winByGrubs[String(e.grubs[sd])] ??= { n: 0, w: 0 });
    r.n++;
    if (w === sd) r.w++;
  }
  if (g === LOG) {
    console.log(`--- game ${g}: ${e.names[0]} vs ${e.names[1]}`);
    for (const k of e.grubLog) console.log(`  ${mmss(k.t)} ${e.names[k.side]} ${e.units[k.by].role} ${e.units[k.by].champ.name} grub ${k.order} (helpers ${k.helpers}${k.foe ? ", enemy hit it too" : ""})`);
    for (const ev of e.events) if (ev.t > 440 && ev.t < 920) console.log(`  ${mmss(ev.t)} [${ev.type}] ${ev.text}`);
    if (M) for (const l of M.log) console.log(`  ${l}`);
  }
}

const ord = (m: Record<string, number>) => Object.entries(m).sort((x, y) => y[1] - x[1]);
console.log(`engine voidgrubs: ${games} games (roster seed ${rosterSeed}), ${killed} grubs killed (${(killed / games).toFixed(2)} a game), ${games * 3 - killed} left to despawn at 14:45`);
console.log("\n[1] camp split per game (most - least - despawned)");
for (const [k, v] of ord(split)) console.log(`  ${k}  ${String(v).padStart(4)}  ${pct(v, games)}`);
const shared = Object.entries(split).filter(([k]) => !k.includes("-0 ")).reduce((x, [, v]) => x + v, 0);
const unfinished = Object.entries(split).filter(([k]) => !k.includes("+0 ")).reduce((x, [, v]) => x + v, 0);
console.log(`  both teams got a grub: ${shared} ${pct(shared, games)}; one team all three: ${split["3-0 (+0 despawned)"] ?? 0} ${pct(split["3-0 (+0 despawned)"] ?? 0, games)}; camp not finished (1+ despawned): ${unfinished} ${pct(unfinished, games)}`);
console.log(`  blue share of grubs: ${pct(blue, killed)}`);
console.log("\n[2] order of takers (A = team of the first grub, B = other, - = despawned)");
for (const [k, v] of ord(seq)) console.log(`  ${k}  ${String(v).padStart(4)}  ${pct(v, games)}${k === "AAA" ? "" : `   games ${seqGames[k].slice(0, 8).join(", ")}`}`);
const nv = Object.values(visits).reduce((x, y) => x + y, 0);
console.log(`\n[3] visits (one team's run of kills, gaps <= ${VISIT_GAP} s): ${nv} (${(nv / games).toFixed(2)} a game)`);
for (const n of ["1", "2", "3"]) console.log(`  ${n} grub(s): ${String(visits[n] ?? 0).padStart(4)}  ${pct(visits[n] ?? 0, nv)}`);
console.log("  visits per game: " + Object.entries(perGame).sort().map(([k, v]) => `${k}: ${v} (${pct(v, games).trim()})`).join(", "));
console.log("  (size, grubs left alive after it): " + Object.entries(visitsLeft).sort().map(([k, v]) => `${k}: ${v}`).join(", "));
console.log(`  solo (every kill with one champion) / group visits: ${soloVisits.solo ?? 0} / ${soloVisits.group ?? 0}`);
console.log(`\n[4] partial visits (grubs still alive when the team stopped): ${partialN} (${pct(partialN, nv).trim()} of visits)`);
console.log("  what happened to the rest:");
for (const [k, v] of ord(after)) console.log(`    ${k}: ${v} ${pct(v, partialN)}`);
console.log("  what was going on:");
for (const [k, v] of ord(ctx)) console.log(`    ${k}: ${v} ${pct(v, partialN)}`);
console.log(`  later visit starts this long after the previous one ended (s, P10/25/50/75/90): ${quant(startDelay)}`);
console.log("\n[5] timing");
console.log(`  first grub (s after 8:00, P10/25/50/75/90): ${quant(firstT.map((t) => t - SPAWN))}  median ${mmss(med(firstT))}`);
for (let i = 0; i < 3; i++) {
  const xs = kth[i];
  const by = (t: number) => pct(xs.filter((x) => x < t).length, games);
  console.log(`  grub ${i + 1}: median ${mmss(med(xs))}, by 9:00 ${by(540)}, by 10:00 ${by(600)}, by 12:00 ${by(720)} (of all games)`);
}
console.log(`  gap between kills inside a visit (s, P10/25/50/75/90): ${quant(gapIn)}`);
console.log(`  clean 3-grub visit, first to third kill (s, P10/25/50/75/90): ${quant(span)}`);
console.log("\n[6] who");
console.log("  last hit by role: " + ROLES.map((r) => `${r} ${pct(role[r] ?? 0, killed).trim()}`).join(", "));
console.log("  own-team participants per grub (hitters in the pit) 1/2/3/4/5: " + [1, 2, 3, 4, 5].map((n) => pct(part[String(n)] ?? 0, killed).trim()).join(" / "));
console.log(`  an enemy also damaged the grub: ${pct(foeAssist, killed).trim()}`);
console.log("\n[7] fights and leads");
console.log(`  games with a champion kill within ${NEAR} u of the pit between 7:30 and the last grub: ${fightGames} ${pct(fightGames, games)}`);
console.log(`  2-1 games where the teams' kills interleave within ${VISIT_GAP} s (both in the pit): ${sharedSimul} of ${sharedN} ${pct(sharedSimul, sharedN)}`);
const lt = Object.values(leadTakes).reduce((x, y) => x + y, 0);
console.log("  gold lead at 8:00 of the side that took more grubs: " + ["ahead 1k+", "ahead 0.3-1k", "even (+-300)", "behind 0.3-1k", "behind 1k+"].map((k) => `${k} ${pct(leadTakes[k] ?? 0, lt).trim()}`).join(", "));
console.log(`  the first grub went to the side ahead in gold at 8:00: ${pct(firstAhead, firstN).trim()}`);
console.log("\n[8] result");
console.log("  win rate by the grubs a team took: " + Object.entries(winByGrubs).sort().map(([k, v]) => `${k}: ${pct(v.w, v.n).trim()} (n=${v.n})`).join(", "));
console.log(`  grub stacks at the end: winner ${(stacksWin / games).toFixed(2)}, loser ${(stacksLose / games).toFixed(2)}`);
console.log("\n[9] plans per game (engine only)");
console.log("  started: " + ord(plans).map(([k, v]) => `${k} ${(v / games).toFixed(2)}`).join(", "));
console.log("  ended early: " + ord(aborts).map(([k, v]) => `${k} ${(v / games).toFixed(2)}`).join(", "));
if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ games, killed, split, seq, visits, perGame, after, ctx, role, part, firstMedian: med(firstT) }, null, 1));
