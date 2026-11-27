import type { Role } from "../data/types";
import { ROLES } from "../data/types";
import type { GameData } from "../data/load";
import { ovr } from "./player";
import { clamp, logistic, Rng } from "./rng";
import type { GameRecord, GameState, Series, Team } from "./types";
import { metaBonus, teamMetaBonus } from "./meta";
import { defaultEdgePower } from "../match/items";
import * as Matchup from "../match/matchup";

// Power points per logit of win odds. Fitted on real LCK 2025-26 games (1,057, per-game lineups' OVR):
// 10.8 over all games, 7.4 on gaps under 10; 9.5 sits inside both 95% intervals. Was 4.5. scripts/real-scale.ts
export const POWER_SCALE = 9.5;
/**
 * The manager-side modifiers (difficulty, coaching staff, synergy, morale, fatigue, meta picks, team composition)
 * were sized as win-rate effects when the scale was 4.5. The new scale is fitted on player OVR only, so these are
 * multiplied by MOD_GAIN to keep the effect they were designed for (hard difficulty about +8 points at even
 * strength, a meta pick advantage near 58-62 %, fatigue 70 about -13 points). Player strength (OVR, form, role fit,
 * champion mastery) stays on the fitted scale. The match engine applies the same gain to its teamMod and meta terms.
 */
export const MOD_GAIN = POWER_SCALE / 4.5;

export function headCoach(s: GameState, t: Team) {
  return t.staff.map((id) => s.staff[id]).find((x) => x?.role === "Head Coach");
}

export function coachBonus(s: GameState, t: Team): number {
  const staff = t.staff.map((id) => s.staff[id]).filter(Boolean);
  if (!staff.length) return -2.5; // no coaching staff at all
  const hc = staff.find((x) => x.role === "Head Coach");
  const hcVal = hc ? (hc.attrs.draft + hc.attrs.analysis) / 2 : 45;
  const others = staff.filter((x) => x !== hc);
  const helpers = others.reduce((a, x) => a + (x.attrs.analysis + x.attrs.draft) / 2, 0) / Math.max(1, others.length);
  return clamp((hcVal - 60) / 12 + (others.length ? (helpers - 55) / 30 : -0.5), -3, 3.5);
}

/** Team strength on the same scale as player overall (one number per team). */
export function teamPower(s: GameState, teamId: string): number {
  const t = s.teams[teamId];
  if (!t) return 50;
  let sum = 0;
  let morale = 0;
  let fatigue = 0;
  for (const r of ROLES) {
    const pid = t.lineup[r];
    const p = pid ? s.players[pid] : null;
    if (!p) {
      sum += 35;
      continue;
    }
    const roleFit = p.role === r ? 0 : -8;
    sum += ovr(p) + roleFit + p.form * 0.15;
    morale += p.morale;
    fatigue += p.fatigue;
  }
  const avg = sum / 5;
  return avg + MOD_GAIN * ((t.synergy - 50) / 12 + coachBonus(s, t) + (morale / 5 - 60) / 20 - fatiguePenalty(fatigue / 5));
}

/** Power lost to the starting five's average fatigue: nothing up to 40, then 1 per 12 (70 → 2.5, 90 → 4.2). */
export function fatiguePenalty(avgFatigue: number): number {
  return Math.max(0, avgFatigue - 40) / 12;
}

/** What fatigue actually costs on the team-power scale (OVR points), MOD_GAIN included: the number to show players. */
export function fatigueLoss(avgFatigue: number): number {
  return fatiguePenalty(avgFatigue) * MOD_GAIN;
}

/** Average fatigue of a team's starting five (missing slots count as 0). */
export function starterFatigue(s: GameState, teamId: string): number {
  const t = s.teams[teamId];
  if (!t) return 0;
  let sum = 0;
  for (const r of ROLES) {
    const pid = t.lineup[r];
    sum += pid ? s.players[pid]?.fatigue ?? 0 : 0;
  }
  return sum / 5;
}

/** Advantage of side `a` from difficulty: the AI gets a small edge against the user. */
export function aiEdge(s: GameState, a: string, b: string): number {
  const d = (s.difficulty === "hard" ? 1.5 : s.difficulty === "easy" ? -1 : 0.4) * MOD_GAIN;
  if (a === s.user) return -d;
  if (b === s.user) return d;
  return 0;
}

export function gameWinProb(s: GameState, a: string, b: string): number {
  return logistic((teamPower(s, a) - teamPower(s, b) + aiEdge(s, a, b)) / POWER_SCALE);
}

export function seriesWinProb(pGame: number, bo: number): number {
  const need = Math.ceil(bo / 2);
  // P(reach need wins before opponent does)
  const memo = new Map<string, number>();
  const f = (x: number, y: number): number => {
    if (x === need) return 1;
    if (y === need) return 0;
    const k = `${x},${y}`;
    if (memo.has(k)) return memo.get(k)!;
    const v = pGame * f(x + 1, y) + (1 - pGame) * f(x, y + 1);
    memo.set(k, v);
    return v;
  };
  return f(0, 0);
}

function pickChamps(s: GameState, data: GameData, t: Team, used: Set<string>, rng: Rng): string[] {
  const out: string[] = [];
  for (const r of ROLES) {
    const p = t.lineup[r] ? s.players[t.lineup[r]!] : null;
    const pool = Object.entries(p?.mastery ?? {})
      .filter(([c]) => !used.has(c) && data.champ.has(c))
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6);
    let pick = pool.length ? rng.weighted(pool, ([c, m]) => m * m * (1 + metaBonus(s, c) / 4))![0] : "";
    if (!pick) {
      const cands = data.champions.filter((c) => !used.has(c.id) && c.roles[r] > 0.2);
      pick = (cands.length ? rng.weighted(cands, (c) => (1 + c.pro.picks) * Math.max(0.2, 1 + metaBonus(s, c.id) / 2)) : rng.pick(data.champions))!.id;
    }
    used.add(pick);
    out.push(pick);
  }
  return out;
}

/** AI vs AI game: one Bernoulli on team power, then a plausible box score. */
export function quickGame(s: GameState, data: GameData, sr: Series, blue: string, red: string, used: Set<string>, rng: Rng): GameRecord {
  const tb = s.teams[blue], tr = s.teams[red];
  // picks first: meta champions raise the team's rating the same way they do in the match engine
  const picks = { blue: pickChamps(s, data, tb, used, rng), red: pickChamps(s, data, tr, used, rng) };
  const metaDiff = (teamMetaBonus(s, picks.blue) - teamMetaBonus(s, picks.red)) * MOD_GAIN;
  // each champion's most played LCK build and keystone: their win-rate edge, as in the match engine (items.ts)
  const buildEdge = (champs: string[]) => champs.reduce((a, c, i) => a + defaultEdgePower(data.items, c, ROLES[i]), 0);
  const buildDiff = buildEdge(picks.blue) - buildEdge(picks.red);
  // blue side: +0.22 logit at equal strength in LCK 2025-26 (inside the logit, as in draftWinProb)
  // champion matchups and composition counters measured on LCK, in win logit (match/matchup.ts)
  const muDiff = Matchup.draftEdge(data, Matchup.byRole(picks.blue), Matchup.byRole(picks.red));
  const pBlue = logistic((teamPower(s, blue) - teamPower(s, red) + aiEdge(s, blue, red) + metaDiff + buildDiff) / POWER_SCALE + 0.22 + muDiff);
  const blueWins = rng.chance(clamp(pBlue, 0.03, 0.97));
  const winner = blueWins ? blue : red;
  const duration = Math.round(clamp(rng.normal(1900, 260), 1380, 2700));
  const totalKills = Math.round(clamp(rng.normal(24, 7), 8, 48));
  const wk = Math.round(totalKills * clamp(rng.normal(0.66, 0.1), 0.5, 0.95));
  const kills: [number, number] = blueWins ? [wk, totalKills - wk] : [totalKills - wk, wk];
  const box: GameRecord["box"] = {};
  const split = (team: Team, champs: string[], k: number, d: number) => {
    const w = [0.22, 0.24, 0.26, 0.24, 0.04];
    ROLES.forEach((r: Role, i) => {
      const pid = team.lineup[r];
      if (!pid) return;
      box[pid] = {
        k: Math.round(k * w[i] * rng.range(0.6, 1.4)),
        d: Math.round((d / 5) * rng.range(0.4, 1.6)),
        a: Math.round(k * rng.range(0.3, 0.8)),
        cs: r === "Support" ? rng.int(25, 60) : r === "Jungle" ? rng.int(150, 230) : rng.int(220, 340),
        champ: champs[i],
      };
    });
  };
  split(tb, picks.blue, kills[0], kills[1]);
  split(tr, picks.red, kills[1], kills[0]);
  const winTeam = s.teams[winner];
  const mvp = ROLES.map((r) => winTeam.lineup[r]).filter(Boolean).sort((x, y) => {
    const bx = box[x!], by = box[y!];
    return (by ? by.k * 2 + by.a : 0) - (bx ? bx.k * 2 + bx.a : 0);
  })[0] ?? null;
  return {
    blue, red, winner, duration, kills,
    gold: blueWins ? [62000, 54000] : [54000, 62000],
    picks, bans: { blue: [], red: [] }, mvp, box,
  };
}

export function playQuickSeries(s: GameState, data: GameData, sr: Series, rng: Rng) {
  if (!sr.a || !sr.b) return;
  const need = Math.ceil(sr.bo / 2);
  const used = new Set<string>(); // fearless: a champion is used once per series
  let blue = sr.a;
  while (sr.wa < need && sr.wb < need) {
    const red = blue === sr.a ? sr.b : sr.a;
    const g = quickGame(s, data, sr, blue, red, used, rng);
    sr.games.push(g);
    if (g.winner === sr.a) sr.wa++;
    else sr.wb++;
    blue = g.winner === sr.a ? sr.b : sr.a; // loser picks blue next game
  }
}
