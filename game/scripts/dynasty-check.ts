// How often does one AI club run away with the LCK? Plays whole careers headlessly and counts, per club:
// regular-season record (1·2R double round robin + 3R single = 27 series), titles, unbeaten seasons and grand slams
// (LCK 컵 + LCK 플레이오프 + MSI + 월즈 in one season). Also snapshots the parts of teamPower at fixed dates so the
// spread between clubs can be traced to its source (player OVR, synergy, coaching staff, morale, form, fatigue).
//
// Run: node scripts/run-ts.mjs scripts/dynasty-check.ts [runs=20] [seasons=3] [user=none|<team id>]
//   user=none: every LCK club is AI-run (the user is a placeholder club outside the league)
//   user=KT:   the user plays KT with a plain auto-manager (signs the best affordable free agent per role)
// FLAT=morale,form,synergy,fatigue resets that state to a neutral value every day (to see what each one adds).
// OUT=<file.json> writes the per-season rows for later comparison.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, userSeriesToday, resolveEvent, AI_MORALE } from "../src/core/game";
import { playQuickSeries, teamPower, coachBonus, fatiguePenalty, MOD_GAIN } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { ovr, salaryAsk } from "../src/core/player";
import { seasonDates, standings } from "../src/core/schedule";
import { aiPayrollCap, joinTeam, hireStaffUser, staffAsk, payroll } from "../src/core/market";
import { ROLES } from "../src/data/types";
import type { GameState, Team } from "../src/core/types";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));

const RUNS = Number(process.argv[3] ?? 20);
const SEASONS = Number(process.argv[4] ?? 3);
const USER = process.argv[5] ?? "none";
const FLAT = new Set((process.env.FLAT ?? "").split(",").filter(Boolean));
const OUT = process.env.OUT ?? "";
const SEED0 = Number(process.env.SEED0 ?? 1000);
if (process.env.AI_PULL) AI_MORALE.pull = Number(process.env.AI_PULL);
let crashes = 0;

type Parts = { ovr: number; form: number; syn: number; coach: number; morale: number; fat: number; power: number };
type Row = {
  run: number; season: number; team: string;
  sw: number; sl: number; gw: number; gl: number; // regular season (REG + REG2) series and games
  reg12: [number, number]; // 1·2R series W-L
  titles: string[]; // CUP REG PO MSI EWC WORLDS
  parts: Record<string, Record<string, Parts>>; // snapshot name -> club id -> parts
};

function partsOf(s: GameState, tid: string): Parts {
  const t = s.teams[tid];
  let o = 0, f = 0, m = 0, fa = 0;
  for (const r of ROLES) {
    const p = t.lineup[r] ? s.players[t.lineup[r]!] : null;
    if (!p) { o += 35; continue; }
    o += ovr(p) + (p.role === r ? 0 : -8);
    f += p.form * 0.15;
    m += p.morale;
    fa += p.fatigue;
  }
  return {
    ovr: o / 5, form: f / 5,
    syn: MOD_GAIN * (t.synergy - 50) / 12,
    coach: MOD_GAIN * coachBonus(s, t),
    morale: MOD_GAIN * (m / 5 - 60) / 20,
    fat: -MOD_GAIN * fatiguePenalty(fa / 5),
    power: teamPower(s, tid),
  };
}

/** A placeholder user club outside the league, so every LCK club is run by the AI. */
function detachUser(s: GameState) {
  const real = s.teams[s.user];
  const d = data.teams.find((x) => x.id === real.id)!;
  real.facilities = { training: d.wealth >= 4 ? 1 : 0, housing: d.wealth >= 4 ? 1 : 0, analysis: 0, marketing: 0 };
  const u: Team = {
    ...real, id: "__U", name: "관전", nameKo: "관전", short: "__U", roster: [], staff: [], academy: [],
    lineup: { Top: null, Jungle: null, Mid: null, Bot: null, Support: null }, cash: 1e12, goods: [],
    titles: { lck: 0, msi: 0, worlds: 0, cup: 0 },
  };
  s.teams.__U = u;
  s.user = "__U";
}

/** A plain human-like manager for the user's club: best affordable free agent per empty role, a head coach. */
function userMarket(s: GameState) {
  const t = s.teams[s.user];
  if (!t.staff.some((x) => s.staff[x]?.role === "Head Coach")) {
    const hc = Object.values(s.staff).filter((x) => !x.team && x.role === "Head Coach")
      .sort((a, b) => (b.attrs.draft + b.attrs.analysis) - (a.attrs.draft + a.attrs.analysis))
      .find((x) => staffAsk(x) < t.cash / 8);
    if (hc) hireStaffUser(s, hc, staffAsk(hc), 2, false);
  }
  const empty = ROLES.filter((r) => !t.roster.some((id) => s.players[id]?.role === r));
  for (const r of empty) {
    const left = aiPayrollCap(t) - payroll(s, t);
    const per = left / Math.max(1, empty.filter((x) => !t.roster.some((id) => s.players[id]?.role === x)).length);
    const p = Object.values(s.players).filter((x) => !x.team && !x.retired && !x.scandal && x.role === r && x.origin !== "intl")
      .sort((a, b) => ovr(b) - ovr(a)).find((x) => salaryAsk(x, s.season) <= per);
    if (p) joinTeam(s, p, t.id, salaryAsk(p, s.season), 2);
  }
}

function flatten(s: GameState) {
  for (const tid of s.lck) {
    const t = s.teams[tid];
    if (FLAT.has("synergy")) t.synergy = 50;
    for (const id of [...t.roster, ...(t.academy ?? [])]) {
      const p = s.players[id];
      if (!p) continue;
      if (FLAT.has("morale")) p.morale = 70;
      if (FLAT.has("form")) p.form = 0;
      if (FLAT.has("fatigue")) p.fatigue = 10;
    }
  }
}

const rows: Row[] = [];
const t0 = Date.now();
for (let run = 0; run < RUNS; run++) {
  const seed = SEED0 + run;
  const s = newGame(data, { team: USER === "none" ? "KT" : USER, difficulty: "normal", manager: "t", seed });
  if (USER === "none") detachUser(s);
  const rng = new Rng(seed * 7 + 1);
  const firstSeason = s.season;
  const lastSeason = firstSeason + SEASONS - 1;
  const snaps: Record<number, Record<string, Record<string, Parts>>> = {};
  let guard = 0;
  while (s.season <= lastSeason && guard++ < 20000) {
    const d = seasonDates(s.season);
    if (USER !== "none" && s.day < d.cup) userMarket(s);
    for (const [name, day] of [["cup", d.cup], ["reg", d.reg], ["reg2", d.reg2], ["worlds", d.worlds]] as const) {
      if (s.day === day) {
        snaps[s.season] = snaps[s.season] ?? {};
        snaps[s.season][name] = Object.fromEntries(s.lck.map((tid) => [tid, partsOf(s, tid)]));
      }
    }
    const season = s.season;
    try {
      autoAdvance(s, data, "day");
    } catch (e) {
      // events.ts P14 reads the name of a bracket opponent not decided yet (a game bug outside this check). It throws
      // at the very end of the day, after everything this check measures, so the day stands
      if (!String(e).includes("reading 'name'") || !String((e as Error).stack).includes("events.ts")) throw e;
      crashes++;
    }
    if (FLAT.size) flatten(s);
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
    if (s.season !== season) {
      // season `season` just ended: collect it
      const champ = (id: string) => s.comps.find((c) => c.id === id && c.season === season)?.champion;
      const reg = standings(s, ["REG", "REG2"], season);
      const r12 = standings(s, ["REG"], season);
      for (const tid of s.lck) {
        const st = reg.find((x) => x.team === tid)!;
        const st12 = r12.find((x) => x.team === tid)!;
        const titles = (["CUP", "REG", "PO", "MSI", "EWC", "WORLDS"] as const).filter((id) => champ(id) === tid);
        rows.push({
          run, season: season - firstSeason + 1, team: tid,
          sw: st?.w ?? 0, sl: st?.l ?? 0, gw: st?.gw ?? 0, gl: st?.gl ?? 0, reg12: [st12?.w ?? 0, st12?.l ?? 0],
          titles: [...titles], parts: snaps[season] ?? {},
        });
      }
    }
  }
  if ((run + 1) % 5 === 0) console.error(`run ${run + 1}/${RUNS} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// ---------- report ----------
const teams = [...new Set(rows.map((r) => r.team))];
const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const seasonsTotal = RUNS * SEASONS;
console.log(`\n${RUNS} runs x ${SEASONS} seasons, user=${USER}${FLAT.size ? `, FLAT=${[...FLAT].join(",")}` : ""}, AI morale pull ${AI_MORALE.pull}${crashes ? `, event crashes skipped ${crashes}` : ""}`);
const GS = ["CUP", "PO", "MSI", "WORLDS"];
for (const sn of [0, ...Array.from({ length: SEASONS }, (_, i) => i + 1)]) {
  const rs = rows.filter((r) => !sn || r.season === sn);
  const nSeasons = sn ? RUNS : seasonsTotal;
  console.log(`\n== ${sn ? `season ${sn}` : "all seasons"} (${nSeasons} seasons)`);
  console.log("team  series W%  games W%  best  CUP  REG  PO   MSI  EWC  WRL  unbeaten27 18-0  grandslam  avgOVR(cup)");
  const line = teams.map((t) => {
    const x = rs.filter((r) => r.team === t);
    const sw = x.reduce((a, r) => a + r.sw, 0), sl = x.reduce((a, r) => a + r.sl, 0);
    const gw = x.reduce((a, r) => a + r.gw, 0), gl = x.reduce((a, r) => a + r.gl, 0);
    const cnt = (id: string) => x.filter((r) => r.titles.includes(id)).length;
    const best = Math.max(...x.map((r) => pct(r.sw, r.sw + r.sl)));
    const unbeaten = x.filter((r) => r.sl === 0 && r.sw > 0).length;
    const r12 = x.filter((r) => r.reg12[1] === 0 && r.reg12[0] > 0).length;
    const gs = x.filter((r) => GS.every((id) => r.titles.includes(id))).length;
    const ovrCup = x.map((r) => r.parts.cup?.[t]?.ovr).filter((v): v is number => v !== undefined);
    return { t, wr: pct(sw, sw + sl), text: `${t.padEnd(5)} ${pct(sw, sw + sl).toFixed(1).padStart(6)}   ${pct(gw, gw + gl).toFixed(1).padStart(6)}  ${best.toFixed(0).padStart(4)}  ${[cnt("CUP"), cnt("REG"), cnt("PO"), cnt("MSI"), cnt("EWC"), cnt("WORLDS")].map((v) => String(v).padStart(3)).join("  ")}  ${String(unbeaten).padStart(6)}     ${String(r12).padStart(4)}  ${String(gs).padStart(6)}     ${ovrCup.length ? (ovrCup.reduce((a, b) => a + b, 0) / ovrCup.length).toFixed(1) : "-"}` };
  }).sort((a, b) => b.wr - a.wr);
  for (const l of line) console.log(l.text);
  // spread of club records within each season. Real LCK regular seasons (series W% across the ten clubs): 2025 sd
  // 22.7pp with Gen.G 29-1, 2026 sd 18.1pp with Hanwha Life and Gen.G 19-7
  const spreads: number[] = [];
  const tops: number[] = [];
  const seasonKeys = [...new Set(rs.map((r) => `${r.run}:${r.season}`))];
  let lckIntl = { msi: 0, worlds: 0, ewc: 0 };
  let maxTitles: number[] = [];
  for (const k of seasonKeys) {
    const x = rs.filter((r) => `${r.run}:${r.season}` === k);
    const wrs = x.map((r) => pct(r.sw, r.sw + r.sl));
    spreads.push(sd(wrs));
    tops.push(Math.max(...wrs));
    if (x.some((r) => r.titles.includes("MSI"))) lckIntl.msi++;
    if (x.some((r) => r.titles.includes("WORLDS"))) lckIntl.worlds++;
    if (x.some((r) => r.titles.includes("EWC"))) lckIntl.ewc++;
    maxTitles.push(Math.max(...x.map((r) => r.titles.filter((id) => id !== "REG").length)));
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const unbeatenAny = seasonKeys.filter((k) => rs.some((r) => `${r.run}:${r.season}` === k && r.sl === 0 && r.sw > 0)).length;
  const gsAny = seasonKeys.filter((k) => rs.some((r) => `${r.run}:${r.season}` === k && GS.every((id) => r.titles.includes(id)))).length;
  const n = seasonKeys.length;
  console.log(`club series W% sd ${mean(spreads).toFixed(1)}pp · best club ${mean(tops).toFixed(1)}% · seasons with a 27-0 club ${unbeatenAny}/${n} (${pct(unbeatenAny, n).toFixed(0)}%) · grand slam ${gsAny}/${n} (${pct(gsAny, n).toFixed(0)}%)`);
  console.log(`LCK club won MSI ${pct(lckIntl.msi, n).toFixed(0)}% · EWC ${pct(lckIntl.ewc, n).toFixed(0)}% · Worlds ${pct(lckIntl.worlds, n).toFixed(0)}% · most titles by one club (of CUP/PO/MSI/EWC/WORLDS) avg ${mean(maxTitles).toFixed(2)}, 4+ in ${maxTitles.filter((v) => v >= 4).length}/${n}`);
  // where does the spread come from? sd across clubs of each part, per snapshot
  for (const snap of ["cup", "reg", "reg2", "worlds"]) {
    const sds: Record<keyof Parts, number[]> = { ovr: [], form: [], syn: [], coach: [], morale: [], fat: [], power: [] };
    for (const k of seasonKeys) {
      const x = rs.filter((r) => `${r.run}:${r.season}` === k);
      const ps = x[0]?.parts?.[snap];
      if (!ps) continue;
      for (const key of Object.keys(sds) as (keyof Parts)[]) sds[key].push(sd(Object.values(ps).map((p) => p[key])));
    }
    if (!sds.power.length) continue;
    console.log(`  sd across clubs @${snap.padEnd(6)} ` + (Object.keys(sds) as (keyof Parts)[]).map((k) => `${k} ${mean(sds[k]).toFixed(2)}`).join(" · "));
  }
}

// regression: how much of the regular-season record each part explains (corr with series W%) at the reg snapshot
{
  const xs = rows.filter((r) => r.parts.reg);
  const keys: (keyof Parts)[] = ["ovr", "form", "syn", "coach", "morale", "fat", "power"];
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db || 1);
  };
  const wr = xs.map((r) => pct(r.sw, r.sw + r.sl));
  console.log("\ncorrelation with regular-season series W% (part measured at 1·2R start): " + keys.map((k) => `${k} ${corr(xs.map((r) => r.parts.reg[r.team]?.[k] ?? 0), wr).toFixed(2)}`).join(" · "));
  // mean part value of the season's best club minus the league mean
  const lead: Record<string, number[]> = {};
  for (const k of new Set(xs.map((r) => `${r.run}:${r.season}`))) {
    const x = xs.filter((r) => `${r.run}:${r.season}` === k);
    const top = x.sort((a, b) => pct(b.sw, b.sw + b.sl) - pct(a.sw, a.sw + a.sl))[0];
    for (const snap of ["cup", "reg", "reg2", "worlds"]) {
      const ps = top.parts[snap];
      if (!ps) continue;
      const all = Object.values(ps);
      for (const key of keys) {
        const m = all.reduce((a, p) => a + p[key], 0) / all.length;
        (lead[`${snap}.${key}`] = lead[`${snap}.${key}`] ?? []).push(ps[top.team][key] - m);
      }
    }
  }
  for (const snap of ["cup", "reg", "reg2", "worlds"]) {
    if (!lead[`${snap}.power`]) continue;
    console.log(`season's best club minus league mean @${snap.padEnd(6)} ` + keys.map((k) => `${k} ${(lead[`${snap}.${k}`].reduce((a, b) => a + b, 0) / lead[`${snap}.${k}`].length).toFixed(2)}`).join(" · "));
  }
}
if (OUT) writeFileSync(OUT, JSON.stringify(rows));
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
