// Daily training and fatigue for the user's club (1군 + 2군). Called once per day from advanceDay.
import { weekday } from "./format";
import { addXp, age } from "./player";
import { clamp, Rng } from "./rng";
import type { GameState, Team } from "./types";

export type Intensity = "light" | "normal" | "hard";

/** Training intensity: experience multiplier and fatigue added per training day. */
export const INTENSITY: Record<Intensity, { label: string; xp: number; fatigue: number }> = {
  light: { label: "가볍게", xp: 0.7, fatigue: 1.2 },
  normal: { label: "보통", xp: 1, fatigue: 2.5 },
  hard: { label: "강하게", xp: 1.35, fatigue: 4.5 },
};

/** Default plan when a save has none: normal intensity, auto rest at 65 (the same line AI clubs use). */
export function trainPlanOf(t: Team): { intensity: Intensity; autoRestAt: number | null } {
  return t.trainPlan ?? { intensity: "normal", autoRestAt: 65 };
}

/** Fatigue recovered on a rest day (Monday, 휴식 training, or auto rest). */
export function restRecovery(t: Team): number {
  return 18 * (1 + t.facilities.housing * 0.12);
}

/** Training efficiency at a given fatigue: 1 below 55, 0.8 from 55, 0.5 from 75. */
export function fatigueXpMul(fatigue: number): number {
  return fatigue > 75 ? 0.5 : fatigue > 55 ? 0.8 : 1;
}

export function training(s: GameState, rng: Rng, matchToday: boolean) {
  const t = s.teams[s.user];
  const plan = trainPlanOf(t);
  const load = INTENSITY[plan.intensity] ?? INTENSITY.normal;
  const coaches = t.staff.map((id) => s.staff[id]).filter(Boolean);
  const dev = coaches.length ? coaches.reduce((a, c) => a + c.attrs.develop, 0) / coaches.length : 40;
  const devMul = 0.7 + dev / 160;
  const sunday = weekday(s.day) === 1; // Monday is the team's day off
  for (const id of [...t.roster, ...(t.academy ?? [])]) {
    const p = s.players[id];
    if (!p) continue;
    // auto rest: a tired player sits out today without changing his training setting
    const autoRest = plan.autoRestAt !== null && p.fatigue >= plan.autoRestAt;
    // rest days given in an event (core/events.ts)
    const evRest = (p.restDays ?? 0) > 0;
    if (evRest) p.restDays = p.restDays! - 1 || undefined;
    if (sunday || p.train === "rest" || autoRest || evRest) {
      p.fatigue = clamp(p.fatigue - restRecovery(t), 0, 100);
      p.morale = clamp(p.morale + 0.6, 0, 100);
      continue;
    }
    if (matchToday) continue;
    const a = age(p, s.season);
    const ageMul = a <= 20 ? 1.3 : a <= 23 ? 1.1 : a <= 26 ? 0.9 : 0.6;
    const fat = fatigueXpMul(p.fatigue);
    const xp = 6 * load.xp * (1 + t.facilities.training * 0.1) * devMul * ageMul * fat * rng.range(0.7, 1.3) * (p.academy ? 0.7 : 1);
    if (p.train === "champ") {
      const c = p.trainChamp;
      if (c) p.mastery[c] = clamp((p.mastery[c] ?? 35) + xp * 0.12, 0, 100);
      addXp(p, "pool", xp * 0.35);
    } else {
      addXp(p, p.train, xp);
    }
    p.fatigue = clamp(p.fatigue + load.fatigue, 0, 100);
  }
  // scrims build synergy among starters
  if (!sunday && !matchToday) t.synergy = clamp(t.synergy + 0.25, 0, 100);
  aiFatigue(s, sunday);
}

/** AI clubs run a sensible routine: normal training, Monday off, and rest for anyone at 65 or more. */
const AI_REST_AT = 65;
function aiFatigue(s: GameState, monday: boolean) {
  const playingToday = new Set<string>();
  // AI series of the day are already played by the time training runs, so count finished ones too
  for (const x of s.series) if (x.day === s.day) {
    if (x.a) playingToday.add(x.a);
    if (x.b) playingToday.add(x.b);
  }
  for (const tid of [...s.lck, ...s.intl]) {
    if (tid === s.user) continue;
    const t = s.teams[tid];
    if (!t) continue;
    for (const id of [...t.roster, ...(t.academy ?? [])]) {
      const p = s.players[id];
      if (!p) continue;
      if (monday || p.fatigue >= AI_REST_AT) p.fatigue = clamp(p.fatigue - restRecovery(t), 0, 100);
      else if (!playingToday.has(tid)) p.fatigue = clamp(p.fatigue + INTENSITY.normal.fatigue, 0, 100);
    }
  }
}
