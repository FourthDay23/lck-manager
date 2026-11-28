// New game, the daily loop, stage progression and season rollover.
import type { GameData } from "../data/load";
import type { Role } from "../data/types";
import { ROLES } from "../data/types";
import { dayOfMonth, fmtDate, money, weekday } from "./format";
import { addNews, inbox, teamName } from "./news";
import { addXp, age, makeRookie, ovr, playerFromData, potentialFor, salaryAsk } from "./player";
import { clamp, hash32, hashUnit, Rng } from "./rng";
import {
  buildSeason, buildSeasonLate, comp, makeBracket4, makeBracket6, makeBracket8, makeSwissRound, resolveFeeds, seasonDates, standings, swissRecords,
} from "./schedule";
import { playQuickSeries } from "./quick";
import { academySeasonEnd, autoCallUp, setupAcademies } from "./academy";
import { patchDue, rollPatch } from "./meta";
import { training } from "./training";
import { aiDailyMarket, autoLineup, joinTeam, releasePlayer, releaseStaff, staffAsk, windowOpen } from "./market";
import { INTL_COMPS, economyDay, earn, spend, seriesRewards, sponsorFor } from "./economy";
import type { CompId, Difficulty, GameState, Player, Series, Staff, Team } from "./types";
import { COMP_NAME } from "./types";
import { afterUserSeries, endSetBreak, eventsDay, FICTION, MILD_SCANDALS, resolveChoice, SERIOUS_SCANDALS, sponsorEventMul } from "./events";
import { newEvState } from "./evmemo";

export const SAVE_VERSION = 5;

export interface NewGameOpts { team: string; difficulty: Difficulty; manager: string; seed?: number }

function staffFromData(d: GameData["staff"][number]): Staff {
  const u = (k: string) => hashUnit(d.id + ":" + k);
  const rec = d.record ?? { w: 0, l: 0 };
  const wr = rec.w + rec.l > 0 ? rec.w / (rec.w + rec.l) : 0.5;
  const base = 46 + d.fame * 0.3 + Math.min(10, d.titles * 2.5) + (wr - 0.5) * 20;
  return {
    id: d.id, name: d.name, realName: d.realName, nat: d.nat || "KR", role: d.role, team: null, contract: null,
    fame: clamp(Math.round(d.fame), 0, 100),
    attrs: {
      draft: clamp(Math.round(base + (u("d") - 0.5) * 16), 30, 97),
      develop: clamp(Math.round(base - 4 + (u("v") - 0.5) * 26), 30, 97),
      motivate: clamp(Math.round(base - 2 + (u("m") - 0.5) * 24), 30, 97),
      analysis: clamp(Math.round(base + (u("a") - 0.5) * 18), 30, 97),
    },
    titles: d.titles, record: rec, lastTeamName: d.lastTeam,
  };
}

function teamFromData(d: GameData["teams"][number], userId: string, difficulty: Difficulty): Team {
  const fame = clamp(Math.round(20 + d.wealth * 10 + d.titles.lck * 1.2 + d.titles.worlds * 3), 10, 100);
  const startCash = { easy: 1.4, normal: 1, hard: 0.7 }[difficulty] * (80000 + d.wealth * 30000);
  const t: Team = {
    id: d.id, name: d.name, nameKo: d.nameKo, short: d.short, tier: d.tier, region: "LCK", colors: d.colors, logo: d.logo,
    wealth: d.wealth, fans: d.fans || d.wealth * 300000, fame, cash: Math.round(startCash),
    roster: [], lineup: { Top: null, Jungle: null, Mid: null, Bot: null, Support: null }, staff: [],
    policy: d.wealth >= 5 ? "star" : d.wealth >= 4 ? "win" : d.wealth <= 2 ? (hashUnit(d.id) < 0.5 ? "youth" : "budget") : "vet",
    synergy: 50, facilities: { training: d.wealth >= 4 ? 1 : 0, housing: d.wealth >= 4 ? 1 : 0, analysis: 0, marketing: 0 },
    sponsor: 0, goods: [], titles: { lck: d.titles.lck, msi: d.titles.msi, worlds: d.titles.worlds, cup: 0 },
  };
  if (t.id === userId) t.facilities = { training: 0, housing: 0, analysis: 0, marketing: 0 };
  t.sponsor = sponsorFor(t);
  return t;
}

/** Fixed contracts at the start: everyone else is a free agent. */
const FIXED: { name: string; team: string; salary: number; until: number }[] = [
  { name: "Faker", team: "T1", salary: 80000, until: 2029 },
  { name: "ShowMaker", team: "Dplus Kia", salary: 45000, until: 2028 },
];

export function newGame(data: GameData, o: NewGameOpts): GameState {
  const seed = o.seed ?? (Date.now() & 0x7fffffff);
  const rng = new Rng(seed);
  const season = 2027;
  const s: GameState = {
    version: SAVE_VERSION, seed, rng: rng.state, day: 0, season, difficulty: o.difficulty, user: o.team,
    managerName: o.manager || "단장", players: {}, staff: {}, teams: {}, lck: [], intl: [], comps: [], series: [],
    bids: [], tradeOffers: [], saleOffers: [], news: [], trophies: [], ledger: [], events: [], cutscenes: [], inbox: [],
    genCount: 0, stats: { seasonsPlayed: 0, seriesW: 0, seriesL: 0 }, tut: [], ev: newEvState(0),
  };
  for (const td of data.teams.filter((t) => t.tier === 1)) {
    const t = teamFromData(td, o.team, o.difficulty);
    s.teams[t.id] = t;
    s.lck.push(t.id);
  }
  for (const pd of data.players) s.players[pd.id] = playerFromData(pd, season);
  for (const sd of data.staff) s.staff[sd.id] = staffFromData(sd);
  // international clubs: fixed rosters, never in the market
  for (const it of data.intl) {
    const t: Team = {
      id: it.id, name: it.name, nameKo: it.name, short: it.short, tier: 1, region: it.region, colors: it.colors, logo: it.logo,
      wealth: 4, fans: 500000, fame: clamp(it.strength - 20, 20, 90), cash: 0, roster: [],
      lineup: { Top: null, Jungle: null, Mid: null, Bot: null, Support: null }, staff: [], policy: "win", synergy: 60,
      facilities: { training: 0, housing: 0, analysis: 0, marketing: 0 }, sponsor: 0, goods: [],
      titles: { lck: 0, msi: 0, worlds: 0, cup: 0 }, intlStrength: it.strength,
    };
    s.teams[t.id] = t;
    s.intl.push(t.id);
    for (const rp of it.roster) {
      // a player who left the LCK for this club exists in players.json too: move that record instead of copying it
      const moved = s.players[rp.id];
      if (moved && moved.origin === "real" && !moved.team) {
        // stays a regular player (origin "real") so the LCK market can buy him back from the foreign club
        moved.team = t.id;
        moved.contract = { salary: salaryAsk(moved, season), until: 9999, signedDay: 0 };
        moved.history.push(`${season}: ${it.name} 소속 (해외 리그)`);
        t.roster.push(moved.id);
        continue;
      }
      const id = `intl:${it.id}:${rp.id}`;
      const p = playerFromData({
        id, name: rp.name, realName: "", nat: rp.nat, birth: null, role: rp.role, tier: 1, lastTeam: it.name, teams: [it.name],
        seasons: [], games: 0, stats: {}, attrs: rp.attrs, ovr: rp.ovr, fame: 40, champs: rp.champs, intl: 0,
      }, season);
      p.origin = "intl";
      p.team = t.id;
      p.contract = { salary: 0, until: 9999, signedDay: 0 };
      s.players[id] = p;
      t.roster.push(id);
    }
    autoLineup(s, t);
  }
  // fixed contracts
  for (const f of FIXED) {
    const p = Object.values(s.players).find((x) => x.name === f.name && x.origin === "real");
    const t = Object.values(s.teams).find((x) => x.name === f.team || x.id === f.team);
    if (!p || !t) continue;
    p.team = t.id;
    p.contract = { salary: f.salary, until: f.until, signedDay: 0 };
    p.morale = 80;
    t.roster.push(p.id);
    autoLineup(s, t);
  }
  for (let i = 0; i < 25; i++) {
    const p = makeRookie(s, rng, ROLES[i % 5]);
    s.players[p.id] = p;
  }
  setupAcademies(s, data, rng);
  rollPatch(s, data, rng);
  buildSeason(s, season, rng);
  const me = s.teams[o.team];
  addNews(s, {
    kind: "info",
    title: `${me.name}, 새 단장 체제 출범 (${s.managerName})`,
    body: "2027 시즌을 앞두고 LCK 전 구단이 로스터를 새로 꾸립니다. Faker(T1)와 ShowMaker(Dplus Kia)를 뺀 모든 선수가 자유계약 신분입니다.",
    teams: [me.id],
  });
  inbox(s, `스토브리그가 열렸습니다. 1월 14일 LCK 컵 개막 전까지 주전 5명과 감독을 갖춰야 합니다. 시작 자금 ${money(me.cash)}.`);
  s.rng = rng.state;
  return s;
}

// ---------- queries ----------
export function userSeriesToday(s: GameState): Series | undefined {
  return s.series.find((x) => x.day === s.day && !x.done && (x.a === s.user || x.b === s.user) && x.a && x.b);
}

export function nextUserSeries(s: GameState): Series | undefined {
  return s.series.filter((x) => !x.done && (x.a === s.user || x.b === s.user) && x.day >= s.day).sort((a, b) => a.day - b.day)[0];
}

export function phaseLabel(s: GameState): string {
  const d = seasonDates(s.season);
  const n = s.day;
  if (n < d.cup) return "스토브리그";
  if (n < d.cup + 47) return COMP_NAME.CUP;
  if (n < d.reg) return "휴식기";
  if (n < d.msi - 10) return COMP_NAME.REG;
  if (n < d.ewcq) return "MSI 기간";
  if (n < d.ewc) return COMP_NAME.EWCQ;
  if (n < d.reg2) return COMP_NAME.EWC;
  if (n < d.po - 3) return COMP_NAME.REG2;
  if (n < d.worlds) return COMP_NAME.PO;
  if (n < d.end) return COMP_NAME.WORLDS;
  return "시즌 종료";
}

// ---------- daily systems ----------
function aiGrowth(s: GameState, rng: Rng) {
  if (dayOfMonth(s.day) !== 2) return;
  for (const p of Object.values(s.players)) {
    if (p.retired || p.team === s.user || !p.team) continue;
    const gap = p.pot - ovr(p);
    if (gap <= 0) continue;
    const a = age(p, s.season);
    const chance = clamp((0.25 + gap * 0.06) * (a <= 21 ? 1.3 : a <= 24 ? 1 : 0.5), 0, 0.9);
    if (rng.chance(chance)) {
      const k = rng.pick(["laning", "teamfight", "macro", "mechanics", "consistency", "pool"] as const);
      p.attrs[k] = clamp(p.attrs[k] + 1, 0, 99);
    }
  }
}

function moraleDay(s: GameState, rng: Rng) {
  const t = s.teams[s.user];
  const starters = new Set(Object.values(t.lineup));
  for (const id of t.roster) {
    const p = s.players[id];
    if (!p) continue;
    if (starters.has(id)) p.morale = clamp(p.morale + 0.15, 0, 100);
    else p.morale = clamp(p.morale - 0.15 - p.persona.ambition * 0.35 - (p.contract?.starterPromise ? 0.6 : 0), 0, 100);
    p.form *= 0.995;
  }
  // low morale no longer raises events by itself here: core/events.ts (M1-M4) does, and the old five
  // (bench, pay, burnout, slump, late) come only as aftermaths of earlier choices
}

/** Choice events go to core/events.ts; events saved before v5 (no `def`) still resolve the old way below. */
export function resolveEvent(s: GameState, evId: string, opt: number) {
  const ev = s.events.find((e) => e.id === evId);
  if (!ev) return;
  if (ev.def) return resolveChoice(s, evId, opt);
  s.events = s.events.filter((e) => e.id !== evId);
  const p = ev.player ? s.players[ev.player] : null;
  const t = s.teams[s.user];
  const eff = ev.options[opt]?.effect;
  if (!p) return;
  const m = (v: number) => (p.morale = clamp(p.morale + v, 0, 100));
  switch (eff) {
    case "promise": m(15); if (p.contract) p.contract.starterPromise = true; break;
    case "list": m(8); p.listed = true; break;
    case "deny": m(ev.kind === "pay" ? -10 : -8); break;
    case "bonus": spend(s, "선수 보너스", Math.round(salaryAsk(p, s.season) * 0.08)); m(14); break;
    case "later": m(6); if (p.interview) p.interview.salaryMul += 0.05; break;
    case "rest": p.fatigue = clamp(p.fatigue - 35, 0, 100); m(10); t.synergy = clamp(t.synergy - 1, 0, 100); break;
    case "care": spend(s, "상담 지원", 500); m(7); p.attrs.consistency = clamp(p.attrs.consistency + 1, 0, 99); break;
    case "push": m(-6); p.attrs.mechanics = clamp(p.attrs.mechanics + 1, 0, 99); break;
    case "fine": m(-5); t.synergy = clamp(t.synergy + 1, 0, 100); break;
    case "talk": m(5); break;
    case "ban": m(-12); t.synergy = clamp(t.synergy + 2, 0, 100); p.scandal = 14; autoLineupIfUserMissing(s); break;
    case "grind": p.attrs.mechanics = clamp(p.attrs.mechanics + 1, 0, 99); p.fatigue = clamp(p.fatigue + 15, 0, 100); m(4); break;
    case "vod": p.attrs.macro = clamp(p.attrs.macro + 1, 0, 99); m(4); break;
    case "rest2": p.fatigue = clamp(p.fatigue - 25, 0, 100); m(9); break;
    case "sus": p.scandal = 21; m(-20); t.fame = clamp(t.fame + 1, 0, 100); autoLineupIfUserMissing(s); break;
    case "cover": t.fame = clamp(t.fame - 5, 0, 100); t.fans = Math.round(t.fans * 0.97); m(5); break;
    case "cut": releasePlayer(s, p, "품위 손상"); t.fame = clamp(t.fame + 2, 0, 100); autoLineup(s, t); break;
  }
}

function autoLineupIfUserMissing(s: GameState) {
  const t = s.teams[s.user];
  for (const r of ROLES) {
    const id = t.lineup[r];
    if (id && s.players[id]?.scandal) t.lineup[r] = null;
  }
}

/**
 * Days out (suspension, injury, leave) run down here. Scandals now reach every player, real ones too, always
 * marked as fiction. The user's club gets them as choice events (core/events.ts N20); LCK clubs here, as news:
 * 70% a mild incident with no ban, 30% a serious one with a ban.
 */
function scandalDay(s: GameState, rng: Rng) {
  const me = s.teams[s.user];
  for (const p of Object.values(s.players)) {
    if (p.scandal) {
      p.scandal -= 1;
      if (p.scandal <= 0) {
        p.scandal = undefined;
        p.outWhy = undefined;
        // a starter who sat out for rest or treatment takes his place back from a weaker stand-in
        const slot = p.outSlot;
        if (slot && p.team === s.user && !p.academy && !Object.values(me.lineup).includes(p.id)) {
          const holder = me.lineup[slot] ? s.players[me.lineup[slot]!] : null;
          if (!holder || ovr(holder) < ovr(p)) me.lineup[slot] = p.id;
        }
        p.outSlot = undefined;
      }
    }
  }
  if (weekday(s.day) !== 3) return;
  const pool = Object.values(s.players).filter((p) => p.team && p.team !== s.user && s.lck.includes(p.team) && !p.academy && !p.scandal && !p.retired);
  for (const p of pool) {
    if (!rng.chance(0.002 + p.persona.temper * 0.004)) continue;
    const team = s.teams[p.team!];
    if (rng.chance(0.7)) {
      const sc = rng.pick(MILD_SCANDALS);
      addNews(s, { kind: "scandal", title: `[해프닝] ${team.name} '${p.name}', ${sc.t}`, body: `${sc.body} 구단이 사과했습니다.${FICTION}`, teams: [team.id], players: [p.id] });
      continue;
    }
    const sc = rng.pick(SERIOUS_SCANDALS);
    p.scandal = sc.days;
    p.outWhy = "징계";
    addNews(s, { kind: "scandal", title: `[논란] ${team.name} '${p.name}', ${sc.t}`, body: `${sc.body} 구단은 ${sc.days}일 출전 정지를 발표했습니다.${FICTION}`, teams: [team.id], players: [p.id] });
    autoLineup(s, team);
  }
}

function ensureUserLineup(s: GameState, rng: Rng) {
  const t = s.teams[s.user];
  for (const r of ROLES) {
    if (t.lineup[r]) continue;
    const bench = t.roster.map((id) => s.players[id]).filter((p) => p && !p.scandal && !Object.values(t.lineup).includes(p.id))
      .sort((a, b) => (b.role === r ? 10 : 0) + ovr(b) - ((a.role === r ? 10 : 0) + ovr(a)))[0];
    if (bench) {
      t.lineup[r] = bench.id;
      continue;
    }
    // call someone up from the 2군 first
    if (autoCallUp(s, t, r)) continue;
    // emergency: sign the best cheap free agent at that role on a minimum one-year deal
    const fa = Object.values(s.players).filter((p) => !p.team && !p.retired && p.role === r && p.origin !== "intl" && !p.scandal)
      .sort((a, b) => ovr(b) - ovr(a)).slice(0, 25).sort((a, b) => salaryAsk(a, s.season) - salaryAsk(b, s.season))[0];
    if (fa) {
      joinTeam(s, fa, t.id, 6000, 1);
      t.lineup[r] = fa.id;
      inbox(s, `${r} 자리가 비어 있어 리그 규정에 따라 ${fa.name}와 최저 연봉 1년 긴급 계약을 맺었습니다.`);
      addNews(s, { kind: "sign", title: `${t.name}, 긴급 수혈 '${fa.name}' 영입`, teams: [t.id], players: [fa.id] });
    }
  }
}

function ensureAiLineups(s: GameState, rng: Rng) {
  for (const id of s.lck) {
    if (id === s.user) continue;
    const t = s.teams[id];
    autoLineup(s, t);
    for (const r of ROLES) {
      if (t.lineup[r]) continue;
      if (autoCallUp(s, t, r)) {
        autoLineup(s, t);
        continue;
      }
      const fa = Object.values(s.players).filter((p) => !p.team && !p.retired && p.role === r && p.origin !== "intl" && !p.scandal)
        .sort((a, b) => ovr(b) - ovr(a))[0] ?? makeRookieInto(s, rng, r);
      joinTeam(s, fa, t.id, Math.max(6000, Math.round(salaryAsk(fa, s.season) / 100) * 100), 1);
      autoLineup(s, t);
    }
  }
}

function makeRookieInto(s: GameState, rng: Rng, r: Role): Player {
  const p = makeRookie(s, rng, r);
  s.players[p.id] = p;
  return p;
}

// ---------- series & stages ----------
export function finishSeries(s: GameState, data: GameData, sr: Series, rng: Rng) {
  sr.done = true;
  sr.winner = sr.wa > sr.wb ? sr.a! : sr.b!;
  const loser = sr.winner === sr.a ? sr.b! : sr.a!;
  const intl = INTL_COMPS.includes(sr.comp);
  const bonus = seriesRewards(s, sr.winner, true, sr.stage, intl);
  if (bonus) sr.bonus = bonus;
  seriesRewards(s, loser, false, sr.stage, intl);
  for (const tid of [sr.a!, sr.b!]) {
    const t = s.teams[tid];
    const won = tid === sr.winner;
    for (const r of ROLES) {
      const pid = t.lineup[r];
      const p = pid ? s.players[pid] : null;
      if (!p) continue;
      p.morale = clamp(p.morale + (won ? 3 : -4), 0, 100);
      p.fatigue = clamp(p.fatigue + 8, 0, 100);
    }
    for (const g of sr.games) {
      if (!g.box) continue;
      for (const [pid, b] of Object.entries(g.box)) {
        const p = s.players[pid];
        if (!p || p.team !== tid) continue;
        p.season.g++; p.season.k += b.k; p.season.d += b.d; p.season.a += b.a; p.season.cs += b.cs;
        if (g.winner === tid) p.season.w++;
        if (g.mvp === pid) p.season.mvp++;
        const kda = (b.k + b.a) / Math.max(1, b.d);
        p.form = clamp(p.form * 0.7 + (kda - 3) * 0.9 + (g.winner === tid ? 1 : -1), -10, 10);
      }
    }
  }
  if (sr.a === s.user || sr.b === s.user) {
    if (sr.winner === s.user) s.stats.seriesW++;
    else s.stats.seriesL++;
    const opp = sr.winner === s.user ? loser : sr.winner;
    addNews(s, {
      kind: "result",
      title: `${teamName(s, sr.a)} ${sr.wa}:${sr.wb} ${teamName(s, sr.b)}`,
      body: `${COMP_NAME[sr.comp]} ${stageName(sr.stage)}. ${sr.winner === s.user ? "승리" : "패배"} vs ${teamName(s, opp)}`,
      teams: [sr.a!, sr.b!],
      mine: true,
    });
  } else if (sr.stage !== "RR" && !sr.stage.startsWith("SW")) {
    addNews(s, { kind: "result", title: `${teamName(s, sr.a)} ${sr.wa}:${sr.wb} ${teamName(s, sr.b)}`, body: `${COMP_NAME[sr.comp]} ${stageName(sr.stage)}`, teams: [sr.a!, sr.b!] });
  }
  resolveFeeds(s);
  if (sr.stage === "F") completeComp(s, data, sr.comp, sr.season, sr.winner, loser);
}

export function stageName(st: string): string {
  if (st === "RR") return "정규 라운드";
  if (st === "QF") return "8강";
  if (st === "SF") return "4강";
  if (st === "F") return "결승";
  if (st.startsWith("SW")) return `스위스 ${st.slice(2)}라운드`;
  return st;
}

function bracketRanks(s: GameState, id: CompId, season: number, champion: string, runner: string): string[] {
  const out = [champion, runner];
  for (const st of ["SF", "QF"]) {
    for (const sr of s.series.filter((x) => x.comp === id && x.season === season && x.stage === st && x.done)) {
      const l = sr.winner === sr.a ? sr.b! : sr.a!;
      if (!out.includes(l)) out.push(l);
    }
  }
  return out;
}

/** The user's team qualified for an international event: a full-screen moment, not just a news line. */
function qualifyCutscene(s: GameState, id: CompId, season: number, how: string) {
  const roster = ROLES.map((r) => s.teams[s.user].lineup[r]).filter(Boolean).map((pid) => s.players[pid!]);
  s.cutscenes.push({ kind: "qualify", title: `${season} ${COMP_NAME[id]} 진출`, sub: how, team: s.user, trophy: id, lines: roster.map((x) => `${x.role} ${x.name}`) });
  inbox(s, `${season} ${COMP_NAME[id]} 진출이 확정됐습니다 (${how}).`);
}

function completeComp(s: GameState, data: GameData, id: CompId, season: number, champion: string, runner: string) {
  const c = comp(s, id, season);
  if (!c || c.done) return;
  c.done = true;
  c.champion = champion;
  c.runnerUp = runner;
  const ranks = bracketRanks(s, id, season, champion, runner);
  ranks.forEach((tid, i) => {
    const prize = c.prize[i] ?? 0;
    if (tid === s.user) earn(s, "상금", prize);
    else if (s.teams[tid]) s.teams[tid].cash += prize;
  });
  const t = s.teams[champion];
  if (id === "EWCQ") {
    // a qualifier: no trophy, just the ticket
    addNews(s, { kind: "info", title: `${t.name}, EWC 선발전 통과`, body: `EWC에 LCK 세 번째 대표로 나갑니다. 결승 상대 ${teamName(s, runner)}.`, teams: [t.id, runner] });
    if (champion === s.user) {
      inbox(s, "EWC 선발전을 통과했습니다. 7월 말 EWC에 나갑니다.");
      qualifyCutscene(s, "EWC", season, "선발전 우승 · LCK 3번 시드");
    }
    return;
  }
  if (id === "CUP") t.titles.cup++;
  if (id === "PO") t.titles.lck++;
  if (id === "MSI") t.titles.msi++;
  if (id === "WORLDS") t.titles.worlds++;
  t.fame = clamp(t.fame + (id === "WORLDS" ? 15 : id === "MSI" || id === "EWC" ? 8 : id === "PO" ? 8 : 4), 0, 100);
  t.fans = Math.round(t.fans * (id === "WORLDS" ? 1.35 : 1.12));
  const final = s.series.find((x) => x.comp === id && x.season === season && x.stage === "F");
  const score = final ? `${Math.max(final.wa, final.wb)}:${Math.min(final.wa, final.wb)} vs ${teamName(s, runner)}` : "";
  for (const r of ROLES) {
    const p = t.lineup[r] ? s.players[t.lineup[r]!] : null;
    if (p) {
      p.career.titles.push(`${season} ${COMP_NAME[id]}`);
      p.fame = clamp(p.fame + (id === "WORLDS" ? 10 : 4), 0, 100);
    }
  }
  addNews(s, { kind: "title", title: `${t.name}, ${season} ${COMP_NAME[id]} 우승`, body: `결승 ${score}`, teams: [t.id, runner] });
  if (champion === s.user) {
    const hc = t.staff.map((x) => s.staff[x]).find((x) => x?.role === "Head Coach");
    const roster = ROLES.map((r) => ({ name: t.lineup[r] ? s.players[t.lineup[r]!].name : "-", role: r }));
    s.trophies.push({ id: `${id}${season}`, comp: id, season, name: `${season} ${COMP_NAME[id]}`, day: s.day, final: score, roster, coach: hc?.name ?? null });
    s.cutscenes.push({ kind: "title", title: `${season} ${COMP_NAME[id]} 우승`, sub: score, team: t.id, trophy: id, lines: roster.map((x) => `${x.role} ${x.name}`) });
  }
}

function stageProgress(s: GameState, data: GameData, rng: Rng) {
  const season = s.season;
  const d = seasonDates(season);
  const allDone = (cid: CompId, stage: string) => {
    const xs = s.series.filter((x) => x.comp === cid && x.season === season && x.stage === stage);
    return xs.length > 0 && xs.every((x) => x.done);
  };
  const has = (cid: CompId, stage: string) => s.series.some((x) => x.comp === cid && x.season === season && x.stage === stage);
  // LCK Cup playoffs
  if (allDone("CUP", "RR") && !has("CUP", "QF")) {
    const st = standings(s, ["CUP"], season);
    makeBracket6(s, "CUP", season, st.slice(0, 6).map((x) => x.team), s.day + 2);
    addNews(s, { kind: "info", title: `${season} LCK 컵 플레이오프 대진 확정`, body: st.slice(0, 6).map((x, i) => `${i + 1}. ${teamName(s, x.team)}`).join(" / ") });
  }
  // regular season 1-2 done -> regular season first place plaque, MSI
  const reg = comp(s, "REG", season)!;
  if (allDone("REG", "RR") && !reg.done) {
    reg.done = true;
    const st = standings(s, ["REG"], season);
    reg.champion = st[0].team;
    st.slice(0, 3).forEach((x, i) => {
      if (x.team === s.user) earn(s, "상금", reg.prize[i] ?? 0);
    });
    if (st[0].team === s.user) {
      s.trophies.push({ id: `REG${season}`, comp: "REG", season, name: `${season} 정규 시즌 1·2R 1위`, day: s.day, roster: ROLES.map((r) => ({ name: s.teams[s.user].lineup[r] ? s.players[s.teams[s.user].lineup[r]!].name : "-", role: r })), coach: null });
    }
    const msi = comp(s, "MSI", season)!;
    const intlSeeds = [...s.intl].sort((a, b) => (s.teams[b].intlStrength ?? 0) - (s.teams[a].intlStrength ?? 0)).slice(0, 6);
    msi.teams = [st[0].team, st[1].team, ...intlSeeds];
    const seeds = [st[0].team, intlSeeds[0], st[1].team, intlSeeds[1], ...intlSeeds.slice(2)];
    makeBracket8(s, "MSI", season, seeds, d.msi);
    addNews(s, { kind: "info", title: `${teamName(s, st[0].team)}·${teamName(s, st[1].team)}, MSI 진출`, body: "정규 시즌 1·2라운드 1, 2위 팀이 LCK 대표로 나섭니다.", teams: [st[0].team, st[1].team] });
    // the user's team going abroad gets the big screen (1st/2nd also go straight to EWC)
    const myRank = st.findIndex((x) => x.team === s.user);
    if (myRank === 0 || myRank === 1) {
      qualifyCutscene(s, "MSI", season, `정규 시즌 1·2R ${myRank + 1}위 · LCK ${myRank + 1}번 시드`);
      if (comp(s, "EWC", season)) qualifyCutscene(s, "EWC", season, `정규 시즌 1·2R ${myRank + 1}위 · 선발전 없이 직행`);
    }
    // EWC: 1st and 2nd go straight in, 3rd-6th play the qualifier for the last LCK seat
    const q = comp(s, "EWCQ", season);
    if (q && !has("EWCQ", "SF")) {
      q.teams = st.slice(2, 6).map((x) => x.team);
      makeBracket4(s, "EWCQ", season, q.teams, d.ewcq, 5);
      addNews(s, { kind: "info", title: `${season} EWC 선발전 대진 확정`, body: `${teamName(s, st[0].team)}·${teamName(s, st[1].team)} EWC 직행. 3~6위 ${q.teams.map((x) => teamName(s, x)).join(", ")}가 남은 한 자리를 다툽니다.`, teams: q.teams });
    }
  }
  // EWC: once the qualifier is decided
  const ewcq = comp(s, "EWCQ", season);
  const ewc = comp(s, "EWC", season);
  if (ewcq?.done && ewc && !ewc.teams.length && reg.done) {
    const st = standings(s, ["REG"], season);
    const lckSeeds = [st[0].team, st[1].team, ewcq.champion!];
    const intlSeeds = [...s.intl].sort((a, b) => (s.teams[b].intlStrength ?? 0) - (s.teams[a].intlStrength ?? 0)).slice(0, 5);
    ewc.teams = [...lckSeeds, ...intlSeeds];
    const seeds = [lckSeeds[0], intlSeeds[0], lckSeeds[1], intlSeeds[1], intlSeeds[2], lckSeeds[2], intlSeeds[3], intlSeeds[4]];
    makeBracket8(s, "EWC", season, seeds, Math.max(s.day + 2, d.ewc));
    addNews(s, { kind: "info", title: `${season} EWC LCK 대표 확정`, body: lckSeeds.map((x) => teamName(s, x)).join(" · "), teams: lckSeeds });
  }
  // playoffs after round 3
  if (allDone("REG2", "RR") && !has("PO", "QF")) {
    const st = standings(s, ["REG", "REG2"], season);
    const po = comp(s, "PO", season)!;
    po.teams = st.slice(0, 6).map((x) => x.team);
    const r2 = comp(s, "REG2", season);
    if (r2) { r2.done = true; r2.champion = st[0].team; }
    makeBracket6(s, "PO", season, po.teams, Math.max(s.day + 2, d.po));
    addNews(s, { kind: "info", title: `${season} LCK 플레이오프 진출 6팀 확정`, body: po.teams.map((x, i) => `${i + 1}. ${teamName(s, x)}`).join(" / ") });
  }
  // worlds: swiss
  const po = comp(s, "PO", season)!;
  const w = comp(s, "WORLDS", season)!;
  if (po.done && !w.teams.length) {
    const ranks = bracketRanks(s, "PO", season, po.champion!, po.runnerUp!).slice(0, 4);
    const intl = [...s.intl].sort((a, b) => (s.teams[b].intlStrength ?? 0) - (s.teams[a].intlStrength ?? 0)).slice(0, 12);
    w.teams = [...ranks, ...intl];
    if (w.teams.length % 2) w.teams.pop();
    addNews(s, { kind: "info", title: `LCK 월즈 대표 확정`, body: ranks.map((x, i) => `${i + 1}시드 ${teamName(s, x)}`).join(" / "), teams: ranks });
    const mySeed = ranks.indexOf(s.user);
    if (mySeed >= 0) qualifyCutscene(s, "WORLDS", season, `LCK 플레이오프 ${mySeed + 1}위 · LCK ${mySeed + 1}번 시드`);
  }
  if (w.teams.length && s.day >= d.worlds - 1 && !w.done && !has("WORLDS", "QF")) {
    const rounds = s.series.filter((x) => x.comp === "WORLDS" && x.season === season && x.stage.startsWith("SW"));
    const curRound = rounds.reduce((m, x) => Math.max(m, Number(x.stage.slice(2))), 0);
    const curDone = rounds.filter((x) => x.stage === `SW${curRound}`).every((x) => x.done);
    if (curRound === 0 || curDone) {
      const made = makeSwissRound(s, season, curRound + 1, Math.max(s.day + 1, d.worlds + curRound * 3), rng);
      if (!made) {
        const recs = swissRecords(s, season).filter((r) => r.w >= 3).sort((a, b) => a.l - b.l || b.w - a.w);
        const seeds = recs.slice(0, 8).map((r) => r.team);
        if (seeds.length === 8) makeBracket8(s, "WORLDS", season, seeds, s.day + 4);
      }
    }
  }
}

// ---------- season rollover ----------
function seasonEnd(s: GameState, data: GameData, rng: Rng) {
  const season = s.season;
  // awards
  const lckPlayers = Object.values(s.players).filter((p) => p.team && s.lck.includes(p.team) && p.season.g > 0);
  const mvp = lckPlayers.sort((a, b) => b.season.mvp - a.season.mvp || ovr(b) - ovr(a))[0];
  if (mvp) addNews(s, { kind: "info", title: `${season} LCK 시즌 MVP: '${mvp.name}' (${teamName(s, mvp.team)})`, body: `MVP ${mvp.season.mvp}회`, teams: [mvp.team!], players: [mvp.id] });
  for (const p of Object.values(s.players)) {
    for (const k of ["g", "w", "k", "d", "a", "cs", "mvp"] as const) p.career[k] += p.season[k];
    p.season = { g: 0, w: 0, k: 0, d: 0, a: 0, cs: 0, mvp: 0 };
  }
  // aging, military service, retirement
  for (const p of Object.values(s.players)) {
    if (p.retired || p.origin === "intl") continue;
    const a = age(p, season + 1);
    if (a >= 26) {
      const speed = hashUnit(p.id + ":age");
      const drops = a >= 30 ? 3 : a >= 28 ? 2 : 1;
      for (let i = 0; i < drops; i++) {
        if (rng.chance(0.35 + speed * 0.4)) {
          const k = rng.pick(["mechanics", "laning", "consistency", "teamfight"] as const);
          p.attrs[k] = clamp(p.attrs[k] - rng.int(1, 2), 20, 99);
        }
      }
      if (a >= 26) p.attrs.macro = clamp(p.attrs.macro + (rng.chance(0.4) ? 1 : 0), 20, 99);
    }
    p.pot = Math.max(ovr(p), Math.min(p.pot, potentialFor(p.id, ovr(p), a)));
    const military = p.nat === "KR" && !p.exempt && a >= 28 && rng.chance(a >= 29 ? 0.8 : 0.45);
    const chose = !!p.retireAfter; // decided in an event this season (core/events.ts N18)
    p.retireAfter = undefined;
    const retire = chose || military || (a >= 31 && rng.chance(0.25 + (a - 31) * 0.15)) || (!p.team && ovr(p) < 50 && a >= 24 && rng.chance(0.3));
    if (retire && (chose || !(p.name === "Faker" && a < 35))) {
      const team = p.team;
      if (team) releasePlayer(s, p, military ? "입대" : "은퇴");
      p.retired = true;
      p.history.push(`${season}: ${military ? "군 입대" : "은퇴"}`);
      if (ovr(p) >= 70 || p.fame >= 40) addNews(s, { kind: "info", title: `'${p.name}', ${military ? "군 입대로 휴식기" : "현역 은퇴"}`, teams: team ? [team] : [], players: [p.id] });
    }
  }
  // contracts expire. AI clubs keep some players first.
  for (const p of Object.values(s.players)) {
    if (!p.team || !p.contract || p.academy || p.origin === "intl" || p.contract.until > season) continue;
    const t = s.teams[p.team];
    if (t.id !== s.user) {
      const starter = Object.values(t.lineup).includes(p.id);
      const keep = (starter ? 0.62 : 0.22) + (ovr(p) >= 80 ? 0.15 : ovr(p) < 65 ? -0.15 : 0) - (age(p, season) >= 28 ? 0.15 : 0);
      if (rng.chance(keep)) {
        p.contract = { salary: salaryAsk(p, season + 1), until: season + rng.int(1, 2), signedDay: s.day };
        continue;
      }
    }
    addNews(s, { kind: "release", title: `'${p.name}', ${t.name}와 계약 만료 FA`, teams: [t.id], players: [p.id] });
    releasePlayer(s, p, "계약 만료");
  }
  for (const st of Object.values(s.staff)) {
    if (st.team && st.contract && st.contract.until <= season && st.team !== s.user && rng.chance(0.5)) {
      releaseStaff(s, st);
    } else if (st.team && st.contract && st.contract.until <= season) {
      if (st.team === s.user) {
        inbox(s, `${st.name}와의 계약이 끝났습니다.`);
        releaseStaff(s, st);
      } else st.contract.until = season + 1;
    }
  }
  academySeasonEnd(s, rng);
  for (let i = 0; i < 18; i++) {
    const p = makeRookie(s, rng, ROLES[i % 5]);
    p.birthYear = season + 1 - rng.int(17, 19);
    s.players[p.id] = p;
  }
  for (const id of s.intl) {
    const t = s.teams[id];
    t.intlStrength = clamp((t.intlStrength ?? 75) + rng.normal(0, 2), 60, 95);
  }
  s.season = season + 1;
  s.stats.seasonsPlayed++;
  for (const id of s.lck) {
    const t = s.teams[id];
    t.sponsor = sponsorFor(t);
    if (id === s.user) t.sponsor = Math.round(t.sponsor * sponsorEventMul(s));
    t.synergy = clamp(t.synergy - 10, 30, 100);
  }
  buildSeason(s, s.season, rng);
  inbox(s, `${season} 시즌이 끝났습니다. 새 스폰서 계약: 월 ${money(s.teams[s.user].sponsor)}.`);
}

function contractReminders(s: GameState) {
  const d = seasonDates(s.season);
  if (s.day !== d.worlds - 20) return;
  const t = s.teams[s.user];
  const exp = t.roster.map((id) => s.players[id]).filter((p) => p.contract && p.contract.until <= s.season);
  if (exp.length) inbox(s, `시즌이 끝나면 계약이 만료되는 선수: ${exp.map((p) => p.name).join(", ")}. 선수단 화면에서 재계약을 협상할 수 있습니다.`);
}

// ---------- the day ----------
export type AdvanceStop = "match" | "event" | "cutscene" | "offer" | "over" | null;

/** Advance one day. Returns why it stopped, or null when the day passed normally. */
export function advanceDay(s: GameState, data: GameData): AdvanceStop {
  if (s.over) return "over";
  if (s.events.length) return "event";
  const userSr = userSeriesToday(s);
  if (userSr) return "match";
  const cutBefore = s.cutscenes.length;
  const rng = new Rng(s.rng);
  const d = seasonDates(s.season);
  const matchDay = s.series.some((x) => x.day === s.day && (x.a === s.user || x.b === s.user));
  // AI series of the day
  for (const sr of s.series.filter((x) => x.day === s.day && !x.done && x.a && x.b)) {
    playQuickSeries(s, data, sr, rng);
    finishSeries(s, data, sr, rng);
  }
  stageProgress(s, data, rng);
  training(s, rng, matchDay);
  aiGrowth(s, rng);
  moraleDay(s, rng);
  scandalDay(s, rng);
  aiDailyMarket(s, rng);
  economyDay(s, rng);
  contractReminders(s);
  if (s.day === d.cup - 1) {
    ensureAiLineups(s, rng);
  }
  if (s.day === d.end) seasonEnd(s, data, rng);
  if (patchDue(s)) rollPatch(s, data, rng);
  s.day += 1;
  // lineups must be complete on match days
  if (s.series.some((x) => x.day === s.day && !x.done && (x.a === s.user || x.b === s.user))) ensureUserLineup(s, rng);
  for (const sr of s.series.filter((x) => x.day === s.day && !x.done)) {
    for (const tid of [sr.a, sr.b]) if (tid && tid !== s.user && s.lck.includes(tid)) ensureAiLineupFor(s, tid, rng);
  }
  // choice events for the new day (aftermaths, low morale, random): on a match day they come before the match
  eventsDay(s, data, rng);
  s.rng = rng.state;
  // a day that ends in the red ends the game (old saves already in the red get until debtGrace)
  const cash = s.teams[s.user].cash;
  if (cash < 0 && !(s.debtGrace !== undefined && s.day <= s.debtGrace)) {
    s.over = { day: s.day - 1, cash };
    return "over";
  }
  if (s.cutscenes.length > cutBefore) return "cutscene";
  if (s.events.length) return "event";
  return null;
}

function ensureAiLineupFor(s: GameState, tid: string, rng: Rng) {
  const t = s.teams[tid];
  autoLineup(s, t);
  if (ROLES.every((r) => t.lineup[r])) return;
  for (const r of ROLES) {
    if (t.lineup[r]) continue;
    if (autoCallUp(s, t, r)) continue;
    const fa = Object.values(s.players).filter((p) => !p.team && !p.retired && p.role === r && p.origin !== "intl" && !p.scandal)
      .sort((a, b) => ovr(b) - ovr(a))[0] ?? makeRookieInto(s, rng, r);
    joinTeam(s, fa, t.id, Math.max(6000, salaryAsk(fa, s.season)), 1);
    addNews(s, { kind: "sign", title: `[오피셜] ${t.name}, '${fa.name}' 영입`, teams: [t.id], players: [fa.id] });
  }
  autoLineup(s, t);
}

export type AutoMode = "day" | "week" | "match" | "event";

export function autoAdvance(s: GameState, data: GameData, mode: AutoMode): AdvanceStop {
  const start = s.day;
  for (let i = 0; i < 400; i++) {
    const alertsBefore = s.alerts?.length ?? 0;
    const stop = advanceDay(s, data);
    if (stop) return stop;
    // a new trade offer or bid stops the clock so it is not skipped past
    if ((s.alerts?.length ?? 0) > alertsBefore) return "offer";
    if (mode === "day") return null;
    if (mode === "week" && s.day - start >= 7) return null;
    if (mode === "match" && userSeriesToday(s)) return "match";
    if (mode === "event" && (s.tradeOffers.length || s.saleOffers.length)) return null;
  }
  return null;
}

// ---------- auto-advance (ui/AutoPlay.tsx): a day at a time, on a timer ----------
/** Where a running auto-advance ends by itself. "free" goes on until the player stops it. */
export type AutoTarget = "free" | "match" | "window" | "phase";

/** The calendar before an auto-advance step or run, to tell what it changed. */
export interface AutoMark { day: number; season: number; phase: string; window: boolean; cash: number }

/** A notice that ends an auto-advance (not just a wait): the player must not walk past it. */
export interface AutoHalt { kind: "over" | "payday" | "debt" | "contract" | "season" | "offer" | "bid"; text: string }

export function autoMark(s: GameState): AutoMark {
  return { day: s.day, season: s.season, phase: phaseLabel(s), window: windowOpen(s), cash: s.teams[s.user].cash };
}

/**
 * One day of auto-advance. Call it only when nothing is waiting for the player (no event, alert, cutscene or
 * match today). `stop` is autoAdvance's reason; `halt` a notice that must end the run.
 */
export function autoStep(s: GameState, data: GameData): { stop: AdvanceStop; halt: AutoHalt | null } {
  const m = autoMark(s);
  const stop = autoAdvance(s, data, "day");
  return { stop, halt: autoHalt(s, m) };
}

/** What a step from `m` to today brought that the player must see before more days go by. */
export function autoHalt(s: GameState, m: AutoMark): AutoHalt | null {
  if (s.over) return { kind: "over", text: "게임 오버" };
  const t = s.teams[s.user];
  if (s.alerts?.some((a) => a.ref === "payday-warning" && a.day >= m.day)) {
    return { kind: "payday", text: "급여일(25일)에 자금이 마이너스가 됩니다" };
  }
  if (t.cash < 0 && m.cash >= 0) return { kind: "debt", text: "자금이 마이너스가 됐습니다" };
  if (t.cash < 0 && s.debtGrace === s.day) return { kind: "debt", text: "오늘 안에 자금을 플러스로 만들지 못하면 게임 오버입니다" };
  if (s.season !== m.season) return { kind: "season", text: `${m.season} 시즌이 끝났습니다. 계약 만료와 스폰서 갱신을 확인하세요` };
  // same day as the inbox reminder (contractReminders)
  if (m.day === seasonDates(m.season).worlds - 20) {
    const exp = t.roster.map((id) => s.players[id]).filter((p) => p?.contract && p.contract.until <= s.season);
    if (exp.length) return { kind: "contract", text: `시즌 뒤 계약 만료: ${exp.map((p) => p.name).join(", ")}` };
  }
  // offers answered "later": today is the last day (market.ts drops them on the next day)
  const trade = s.tradeOffers.find((o) => o.expires === s.day);
  if (trade) return { kind: "offer", text: `${teamName(s, trade.from)}의 트레이드 제안은 오늘까지 답해야 합니다` };
  const sale = s.saleOffers.find((o) => o.expires === s.day);
  if (sale) return { kind: "offer", text: `${teamName(s, sale.team)}의 ${s.players[sale.player]?.name ?? ""} 이적료 제안은 오늘까지 답해야 합니다` };
  // a free agent the player is talking to picks a club when today ends (market.ts resolveBids)
  for (const b of s.bids) {
    if (b.team === s.user || b.due !== s.day) continue;
    const p = s.players[b.player];
    if (p && !p.team && (p.interview?.done || p.askSalary !== undefined)) {
      return { kind: "bid", text: `협상 중인 ${p.name}가 오늘이 지나면 다른 구단 제안 중에서 팀을 고릅니다` };
    }
  }
  return null;
}

/** The run's target is reached (the run started at `from`): the line to show, or null to go on. */
export function autoDone(s: GameState, target: AutoTarget, from: AutoMark): string | null {
  if (target === "match") return userSeriesToday(s) ? "경기 날입니다" : null;
  if (target === "window") {
    const open = windowOpen(s);
    if (open !== from.window) return open ? "이적시장이 열렸습니다" : "이적시장이 닫혔습니다";
    // an open window: stop on its last day, while signings can still be made
    return open && !windowOpen({ ...s, day: s.day + 1 }) ? "오늘이 이적시장 마지막 날입니다" : null;
  }
  if (target === "phase") return phaseLabel(s) !== from.phase ? `${phaseLabel(s)} 일정이 시작됐습니다` : null;
  return null;
}

/** The target as a label, and the day it falls on (null when there is none, e.g. no match left). */
export function autoTargetInfo(s: GameState, target: AutoTarget): { label: string; day: number | null } {
  if (target === "free") return { label: "멈출 때까지", day: null };
  if (target === "match") {
    const n = nextUserSeries(s);
    return { label: "다음 경기", day: n ? n.day : null };
  }
  // scan the season's calendar (window and phase only depend on the day)
  const open = windowOpen(s), phase = phaseLabel(s), end = seasonDates(s.season).end;
  for (let day = s.day + 1; day <= s.day + 400; day++) {
    // the season rolls over on its last day (seasonEnd), after which the next season's calendar applies
    const at = { ...s, day, season: day > end ? s.season + 1 : s.season };
    if (target === "window" && windowOpen(at) !== open) return { label: open ? "이적시장 마감" : "이적시장 개장", day: open ? day - 1 : day };
    if (target === "phase" && phaseLabel(at) !== phase) return { label: `다음 일정 (${phaseLabel(at)})`, day };
  }
  return { label: target === "window" ? (open ? "이적시장 마감" : "이적시장 개장") : "다음 일정", day: null };
}

/** Called by the UI after the user's whole series is played. */
export function closeUserSeries(s: GameState, data: GameData, sr: Series) {
  const rng = new Rng(s.rng);
  endSetBreak(s, sr);
  finishSeries(s, data, sr, rng);
  afterUserSeries(s, sr, rng);
  stageProgress(s, data, rng);
  s.rng = rng.state;
}

export function seedHash(s: GameState, k: string) {
  return hash32(`${s.seed}:${k}`);
}

export { staffAsk, windowOpen };

/**
 * Bring an older save up to date. v1 -> v2: EWC calendar for the current season (only if round 3 has not
 * started yet), 2군 rosters, and the in-game meta. Returns short notes to show the player.
 */
export function migrateSave(s: GameState, data: GameData): string[] {
  const notes: string[] = [];
  const rng = new Rng((s.rng ^ 0x5eed1234) >>> 0);
  if (!s.comps.some((c) => c.id === "EWC" && c.season === s.season)) {
    const d = seasonDates(s.season);
    const late: CompId[] = ["REG2", "PO", "WORLDS"];
    const started = s.series.some((x) => x.season === s.season && late.includes(x.comp) && x.done);
    if (!started && s.day < d.msi) {
      s.comps = s.comps.filter((c) => !(c.season === s.season && late.includes(c.id)));
      s.series = s.series.filter((x) => !(x.season === s.season && late.includes(x.comp)));
      buildSeasonLate(s, s.season, rng);
      notes.push(`${s.season} 시즌 일정에 EWC 선발전(7월 15일)과 EWC(7월 22일)를 넣고, 정규 시즌 3R을 8월 5일, 플레이오프를 9월 10일로 옮겼습니다.`);
    } else if (!(s.version >= 2)) {
      // said once, when the v1 save is first opened: every load comes through here, and this season stays without EWC
      notes.push("이번 시즌은 이미 진행돼서 EWC는 다음 시즌부터 들어갑니다.");
    }
  }
  if (!s.meta) {
    rollPatch(s, data, rng);
    notes.push(`게임 자체 메타가 생겼습니다. 지금 패치는 ${s.meta!.patch}. 메타 화면에서 S티어 챔피언을 확인할 수 있습니다.`);
  }
  // v3: Korean players abroad who also have LCK records become buyable again
  const abroad = Object.values(s.players).filter((p) => p.origin === "intl" && !p.id.startsWith("intl:"));
  for (const p of abroad) {
    p.origin = "real";
    if (p.contract) p.contract.salary = salaryAsk(p, s.season);
  }
  if (abroad.length) notes.push(`해외 리그에서 뛰는 LCK 출신 선수 ${abroad.length}명(${abroad.map((p) => p.name).join(", ")})을 이적시장에서 영입할 수 있습니다.`);
  if (s.lck.some((id) => !s.teams[id].academy)) {
    setupAcademies(s, data, rng);
    notes.push("구단마다 2군 로스터가 생겼습니다. 선수단 화면에서 콜업할 수 있습니다.");
  }
  notes.push(...oneStaffRecordPerPerson(s, data));
  if (!(s.version >= 4)) {
    // v4: game over below zero cash. A save already in the red gets 30 days to get out of it.
    const cash = s.teams[s.user].cash;
    if (cash < 0 && !s.over) {
      s.debtGrace = s.day + 30;
      notes.push(`이제 자금이 마이너스인 채로 하루가 지나면 게임 오버입니다. 지금 자금이 ${money(cash)}이라 ${fmtDate(s.debtGrace, false)}까지 기다려 줍니다. 그 전에 플러스로 만드세요.`);
    }
    // v4: tutorial progress lives in the save. A career started before keeps going without the intro;
    // the match-day guides still show once.
    s.tut ??= ["intro", "go"];
  }
  if (!s.ev) {
    // v5: choice events. Old events still on screen resolve the old way (game.ts resolveEvent).
    s.ev = newEvState(s.day);
    if (s.version !== undefined && s.version < 5) notes.push("이제 경기 사이사이 선택지 이벤트가 생깁니다. 선수 사기가 많이 떨어지면 따로 이벤트가 뜨고, 선택에 따라 며칠 뒤 후폭풍이 올 수 있습니다.");
  }
  s.version = SAVE_VERSION;
  return notes;
}

/**
 * One person, one staff record. Older data had three coaches twice, under ids that differ only in case
 * (kkOma/KkOma, cvMax/CvMax, bon0/Bon0), and the player-coach Bible as a coach as well as a player, so one person
 * could be signed twice: as head coach and coach of one club, or by two clubs. The record that holds a contract
 * is kept (the user's first, then a head coach's) under the id the data now uses; the other one leaves its club.
 */
function oneStaffRecordPerPerson(s: GameState, data: GameData): string[] {
  const notes: string[] = [];
  const byKey = new Map(data.staff.map((d) => [d.id.toLowerCase(), d]));
  const playerKeys = new Set(Object.keys(s.players).map((id) => id.toLowerCase()));
  const groups = new Map<string, Staff[]>();
  for (const st of Object.values(s.staff)) {
    const key = st.id.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), st]);
  }
  const roleKo = (st: Staff) => (st.role === "Head Coach" ? "감독" : "코치");
  const leave = (st: Staff, why: string) => {
    const t = st.team ? s.teams[st.team] : null;
    if (t) t.staff = t.staff.filter((x) => x !== st.id);
    if (t && t.id === s.user) notes.push(`${roleKo(st)} '${st.name}'를 코칭스태프에서 뺐습니다. ${why}`);
    delete s.staff[st.id];
  };
  for (const [key, list] of groups) {
    const d = byKey.get(key);
    if (!d) {
      // the data now keeps this player-coach as a player only
      if (playerKeys.has(key)) for (const st of list) leave(st, "선수로도 등록된 같은 사람이라 선수 기록만 남겼습니다.");
      continue;
    }
    if (list.length === 1 && list[0].id === d.id) {
      // nothing to merge. Roles never change in play, so one that differs from the data's was kept by an earlier
      // cleanup (before ownRole) or the data changed: free, he takes his own role now; signed, when that contract ends.
      const st = list[0];
      if (st.role !== d.role && !st.ownRole) {
        if (st.team) st.ownRole = d.role;
        else st.role = d.role;
      }
      continue;
    }
    const score = (st: Staff) => (st.team === s.user ? 4 : 0) + (st.team ? 2 : 0) + (st.role === "Head Coach" ? 1 : 0);
    const keep = [...list].sort((a, b) => score(b) - score(a) || Number(b.id === d.id) - Number(a.id === d.id))[0];
    for (const st of list) {
      if (st !== keep) leave(st, `${roleKo(keep)} '${keep.name}'와 같은 사람이 중복 등록돼 있었습니다.`);
    }
    // the merged data (record, fame, attrs) for the one person; a signed coach keeps his job and contract, and
    // the user's talks carry over whichever of the records they were held with
    const talk = keep.talk ?? list.find((st) => st.talk)?.talk;
    const merged: Staff = { ...staffFromData(d), team: keep.team, contract: keep.contract, talk };
    if (keep.team && keep.role !== merged.role) {
      // e.g. the head coach signed as a coach: he is a head coach again once he leaves (market.ts releaseStaff)
      merged.ownRole = merged.role;
      merged.role = keep.role;
    }
    delete s.staff[keep.id];
    s.staff[d.id] = merged;
    const t = keep.team ? s.teams[keep.team] : null;
    if (t) t.staff = t.staff.map((x) => (x === keep.id ? d.id : x));
  }
  return notes;
}
