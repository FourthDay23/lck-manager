import { dayOfDate, weekday } from "./format";
import type { CompId, Competition, GameState, Series, Standing } from "./types";
import { COMP_NAME } from "./types";
import type { Rng } from "./rng";

const MATCH_WEEKDAYS = [3, 4, 5, 6, 0]; // Wed..Sun

/** Circle-method round robin. Returns rounds of pairs. */
export function roundRobin(teams: string[], double: boolean, rng: Rng): [string, string][][] {
  const list = rng.shuffle([...teams]);
  if (list.length % 2) list.push("BYE");
  const n = list.length;
  const rounds: [string, string][][] = [];
  const arr = [...list];
  for (let r = 0; r < n - 1; r++) {
    const round: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a !== "BYE" && b !== "BYE") round.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(round);
    arr.splice(1, 0, arr.pop()!);
  }
  if (double) {
    const second = rounds.map((round) => round.map(([a, b]) => [b, a] as [string, string]));
    return [...rounds, ...second];
  }
  return rounds;
}

/** Spread series over match weekdays, `perDay` series a day, never the same team twice on one day. */
function placeSeries(pairs: [string, string][], start: number, perDay: number): { pair: [string, string]; day: number }[] {
  const out: { pair: [string, string]; day: number }[] = [];
  let day = start;
  const queue = [...pairs];
  while (queue.length) {
    while (!MATCH_WEEKDAYS.includes(weekday(day))) day++;
    const used = new Set<string>();
    let placed = 0;
    for (let i = 0; i < queue.length && placed < perDay; ) {
      const [a, b] = queue[i];
      if (used.has(a) || used.has(b)) {
        i++;
        continue;
      }
      used.add(a);
      used.add(b);
      out.push({ pair: queue[i], day });
      queue.splice(i, 1);
      placed++;
    }
    day++;
  }
  return out;
}

let seriesSeq = 0;
export function newSeries(s: GameState, comp: CompId, season: number, stage: string, day: number, a: string | null, b: string | null, bo: 1 | 3 | 5): Series {
  seriesSeq = Math.max(seriesSeq, s.series.length) + 1;
  const sr: Series = { id: `${comp}${season}-${stage}-${seriesSeq}`, comp, season, stage, day, a, b, bo, done: false, wa: 0, wb: 0, games: [] };
  s.series.push(sr);
  return sr;
}

const PRIZES: Record<CompId, number[]> = {
  CUP: [20000, 10000, 5000, 5000, 2000, 2000],
  REG: [5000, 3000, 2000],
  REG2: [],
  PO: [30000, 15000, 8000, 8000, 4000, 4000],
  MSI: [35000, 17000, 9000, 9000, 4000, 4000, 4000, 4000],
  EWCQ: [3000, 1500, 800, 800],
  EWC: [80000, 40000, 20000, 20000, 9000, 9000, 9000, 9000],
  WORLDS: [60000, 30000, 15000, 15000, 7000, 7000, 7000, 7000],
};

export function seasonDates(season: number) {
  return {
    offStart: dayOfDate(season - 1, 11, 16),
    cup: dayOfDate(season, 1, 14),
    break1End: dayOfDate(season, 3, 31),
    reg: dayOfDate(season, 4, 1),
    msi: dayOfDate(season, 6, 24),
    ewcq: dayOfDate(season, 7, 15),
    ewc: dayOfDate(season, 7, 22),
    reg2: dayOfDate(season, 8, 5),
    po: dayOfDate(season, 9, 10),
    worlds: dayOfDate(season, 10, 7),
    end: dayOfDate(season, 11, 15),
  };
}

/** Create the season's competitions and their round-robin series. Bracket series are added as stages finish. */
export function buildSeason(s: GameState, season: number, rng: Rng) {
  const d = seasonDates(season);
  const mk = (id: CompId, teams: string[], start: number, end: number): Competition => {
    const c: Competition = { id, season, name: `${season} ${COMP_NAME[id]}`, teams, start, end, done: false, prize: PRIZES[id] };
    s.comps.push(c);
    return c;
  };
  const lck = s.lck;
  mk("CUP", lck, d.cup, d.cup + 52);
  for (const x of placeSeries(roundRobin(lck, false, rng).flat(), d.cup, 2)) newSeries(s, "CUP", season, "RR", x.day, x.pair[0], x.pair[1], 3);
  mk("REG", lck, d.reg, d.msi - 10);
  for (const x of placeSeries(roundRobin(lck, true, rng).flat(), d.reg, 2)) newSeries(s, "REG", season, "RR", x.day, x.pair[0], x.pair[1], 3);
  mk("MSI", [], d.msi, d.msi + 18);
  buildSeasonLate(s, season, rng);
}

/** EWC qualifier, EWC, round 3, playoffs and Worlds. Split out so old saves can be rebuilt on the EWC calendar. */
export function buildSeasonLate(s: GameState, season: number, rng: Rng) {
  const d = seasonDates(season);
  const mk = (id: CompId, teams: string[], start: number, end: number): Competition => {
    const c: Competition = { id, season, name: `${season} ${COMP_NAME[id]}`, teams, start, end, done: false, prize: PRIZES[id] };
    s.comps.push(c);
    return c;
  };
  const lck = s.lck;
  mk("EWCQ", [], d.ewcq, d.ewcq + 4);
  mk("EWC", [], d.ewc, d.ewc + 12);
  mk("REG2", lck, d.reg2, d.po - 3);
  for (const x of placeSeries(roundRobin(lck, false, rng).flat(), d.reg2, 2)) newSeries(s, "REG2", season, "RR", x.day, x.pair[0], x.pair[1], 3);
  mk("PO", [], d.po, d.po + 20);
  mk("WORLDS", [], d.worlds, d.worlds + 36);
}

/** 4-team bracket: 1v4, 2v3 on consecutive days, final two days later. */
export function makeBracket4(s: GameState, compId: CompId, season: number, seeds: string[], start: number, bo: 3 | 5 = 5) {
  const a = newSeries(s, compId, season, "SF", start, seeds[0], seeds[3], bo);
  const b = newSeries(s, compId, season, "SF", start + 1, seeds[1], seeds[2], bo);
  const f = newSeries(s, compId, season, "F", start + 3, null, null, bo);
  f.feedA = `W:${a.id}`;
  f.feedB = `W:${b.id}`;
}

export function comp(s: GameState, id: CompId, season = s.season): Competition | undefined {
  return s.comps.find((c) => c.id === id && c.season === season);
}

export function standings(s: GameState, ids: CompId[], season = s.season, stage = "RR"): Standing[] {
  const map = new Map<string, Standing>();
  const teams = new Set<string>();
  for (const id of ids) for (const t of comp(s, id, season)?.teams ?? []) teams.add(t);
  for (const t of teams) map.set(t, { team: t, w: 0, l: 0, gw: 0, gl: 0 });
  for (const sr of s.series) {
    if (!sr.done || sr.season !== season || !ids.includes(sr.comp) || sr.stage !== stage || !sr.a || !sr.b) continue;
    const A = map.get(sr.a), B = map.get(sr.b);
    if (!A || !B) continue;
    A.gw += sr.wa; A.gl += sr.wb; B.gw += sr.wb; B.gl += sr.wa;
    if (sr.winner === sr.a) { A.w++; B.l++; } else { B.w++; A.l++; }
  }
  return [...map.values()].sort((x, y) => y.w - x.w || (y.gw - y.gl) - (x.gw - x.gl) || y.gw - x.gw || x.team.localeCompare(y.team));
}

function nextMatchDay(day: number): number {
  let d = day;
  while (!MATCH_WEEKDAYS.includes(weekday(d))) d++;
  return d;
}

/** 6-team bracket: 3v6 and 4v5, winners meet seeds 2 and 1, then the final. */
export function makeBracket6(s: GameState, compId: CompId, season: number, seeds: string[], start: number) {
  const q1 = newSeries(s, compId, season, "QF", nextMatchDay(start), seeds[2], seeds[5], 5);
  const q2 = newSeries(s, compId, season, "QF", nextMatchDay(q1.day + 1), seeds[3], seeds[4], 5);
  const s1 = newSeries(s, compId, season, "SF", nextMatchDay(q2.day + 3), seeds[0], null, 5);
  s1.feedB = `W:${q2.id}`;
  const s2 = newSeries(s, compId, season, "SF", nextMatchDay(s1.day + 1), seeds[1], null, 5);
  s2.feedB = `W:${q1.id}`;
  const f = newSeries(s, compId, season, "F", nextMatchDay(s2.day + 4), null, null, 5);
  f.feedA = `W:${s1.id}`;
  f.feedB = `W:${s2.id}`;
}

/** 8-team single elimination. */
export function makeBracket8(s: GameState, compId: CompId, season: number, seeds: string[], start: number) {
  const order: [number, number][] = [[0, 7], [3, 4], [1, 6], [2, 5]];
  const qf = order.map(([x, y], i) => newSeries(s, compId, season, "QF", start + Math.floor(i / 2), seeds[x], seeds[y], 5));
  const sf1 = newSeries(s, compId, season, "SF", start + 5, null, null, 5);
  sf1.feedA = `W:${qf[0].id}`; sf1.feedB = `W:${qf[1].id}`;
  const sf2 = newSeries(s, compId, season, "SF", start + 6, null, null, 5);
  sf2.feedA = `W:${qf[2].id}`; sf2.feedB = `W:${qf[3].id}`;
  const f = newSeries(s, compId, season, "F", start + 10, null, null, 5);
  f.feedA = `W:${sf1.id}`; f.feedB = `W:${sf2.id}`;
}

export function resolveFeeds(s: GameState) {
  const byId = new Map(s.series.map((x) => [x.id, x]));
  const res = (feed?: string): string | null => {
    if (!feed) return null;
    const [kind, id] = [feed.slice(0, 1), feed.slice(2)];
    const src = byId.get(id);
    if (!src?.done || !src.winner) return null;
    if (kind === "W") return src.winner;
    return src.winner === src.a ? src.b : src.a;
  };
  for (const sr of s.series) {
    if (sr.done) continue;
    if (!sr.a && sr.feedA) sr.a = res(sr.feedA);
    if (!sr.b && sr.feedB) sr.b = res(sr.feedB);
  }
}

export interface SwissRec { team: string; w: number; l: number; opp: string[] }

export function swissRecords(s: GameState, season: number): SwissRec[] {
  const c = comp(s, "WORLDS", season);
  const recs = new Map<string, SwissRec>((c?.teams ?? []).map((t) => [t, { team: t, w: 0, l: 0, opp: [] }]));
  for (const sr of s.series) {
    if (sr.comp !== "WORLDS" || sr.season !== season || !sr.stage.startsWith("SW") || !sr.done || !sr.a || !sr.b) continue;
    const A = recs.get(sr.a)!, B = recs.get(sr.b)!;
    A.opp.push(sr.b); B.opp.push(sr.a);
    if (sr.winner === sr.a) { A.w++; B.l++; } else { B.w++; A.l++; }
  }
  return [...recs.values()];
}

/** Pair the next Swiss round among teams still alive (fewer than 3 wins and 3 losses). */
export function makeSwissRound(s: GameState, season: number, round: number, day: number, rng: Rng): boolean {
  const recs = swissRecords(s, season).filter((r) => r.w < 3 && r.l < 3);
  if (!recs.length) return false;
  const groups = new Map<string, SwissRec[]>();
  for (const r of recs) {
    const k = `${r.w}-${r.l}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  let dayOffset = 0;
  for (const [, g] of groups) {
    rng.shuffle(g);
    const left = [...g];
    while (left.length >= 2) {
      const a = left.shift()!;
      let j = left.findIndex((b) => !a.opp.includes(b.team));
      if (j < 0) j = 0;
      const b = left.splice(j, 1)[0];
      const decisive = a.w === 2 || a.l === 2;
      newSeries(s, "WORLDS", season, `SW${round}`, day + Math.floor(dayOffset / 4), a.team, b.team, decisive ? 3 : 1);
      dayOffset++;
    }
  }
  return true;
}
