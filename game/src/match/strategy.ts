// Macro game plans a coach sets before the game (owner: macro agent; the UI reads STRATEGIES / STRATEGY_KO / STRATEGY_DESC).
// STRATEGY_PARAMS are the knobs macro.ts reads: when the team groups, how many hold side lanes, how early it sets up
// objectives, how much it values each objective, how readily it fights. Targets (min 20-35, single team-game P25-P75 of
// the 2026 LCK, lck-stats.gen.ts): sideLaner 0.54-0.77, grouped 0.17-0.39; league median 0.635 / 0.279.
import type { GameState } from "../core/types";
import type { ChampionData } from "../data/types";
import { LCK_STATS } from "./lck-stats.gen";

export type Strategy = "balanced" | "teamfight" | "split" | "early" | "objective" | "scaling";
export const STRATEGIES: Strategy[] = ["balanced", "teamfight", "split", "early", "objective", "scaling"];

export const STRATEGY_KO: Record<Strategy, string> = {
  balanced: "균형",
  teamfight: "한타 위주",
  split: "사이드 운영",
  early: "초반 주도",
  objective: "오브젝트 설계",
  scaling: "후반 지향",
};

export const STRATEGY_DESC: Record<Strategy, string> = {
  balanced: "상황에 맞춰 라인 관리, 오브젝트, 한타를 고르게 가져갑니다.",
  teamfight: "15분부터 다섯 명이 함께 움직이고, 오브젝트마다 한타를 엽니다.",
  split: "사이드에 강한 한 명이 라인을 밀고, 나머지는 반대편 오브젝트를 압박합니다(1-4·1-3-1).",
  early: "갱킹·다이브·카운터 정글로 초반 이득을 노리고, 첫 용과 유충에 적극적입니다.",
  objective: "스폰 전에 라인을 밀고 먼저 자리 잡습니다. 불리하면 반대편 오브젝트와 맞바꿉니다.",
  scaling: "초반 교전을 피하고 성장합니다. 포탑 앞에서 버티다 30분 무렵 한타로 승부합니다.",
};

type ObjKey = "dragon" | "grubs" | "herald" | "baron" | "elder";

export interface StrategyParams {
  /** minute from which the members not holding a side lane move as one group (99 = only for objectives) */
  groupFrom: number;
  /** minute from which all five group up between objectives (99 = never) */
  fiveFrom: number;
  /** side laners kept while grouped: 1 = 1-4, 2 = 1-3-1 */
  sideLanes: number;
  /** added to the LCK grouped-share curve when rolling the all-five formation (after fiveFrom) */
  fiveBias: number;
  /** share of the remaining (not five) time spent in 1-4 rather than spread farming */
  oneFour: number;
  /** after 22 min, chance a formation roll picks 1-3-1 (two side lanes) instead */
  tri: number;
  /** seconds before a spawn the team starts to shove lanes and move to the objective */
  setupLead: number;
  /** objective value multipliers */
  obj: Record<ObjKey, number>;
  /** willingness to answer an enemy objective take (multiplier) */
  contest: number;
  /** added to the power ratio when deciding to fight (positive = forces fights) */
  fight: number;
  /** before this minute the team avoids fights unless clearly ahead */
  avoidUntil: number;
  /** extra jungle ganks per minute during laning (negative = cancels some of the default ganks) */
  gank: number;
  /** chance per think that the jungler invades an enemy camp when the enemy jungler is far (laning) */
  invade: number;
  /** cross-map trade willingness when the enemy takes an objective we cannot contest */
  trade: number;
  /** power ratio needed to siege a turret */
  siegeEdge: number;
  /** the side laner keeps pushing while the other four take baron / elder */
  splitHold: boolean;
  /** solo jungler takes when the enemy jungler is far (multiplier) */
  solo: number;
}

const OBJ1: Record<ObjKey, number> = { dragon: 1, grubs: 1, herald: 1, baron: 1, elder: 1 };

export const STRATEGY_PARAMS: Record<Strategy, StrategyParams> = {
  balanced: {
    groupFrom: 21, fiveFrom: 25, sideLanes: 1, fiveBias: -0.18, oneFour: 0.5, tri: 0, setupLead: 50, obj: OBJ1, contest: 1, fight: 0, avoidUntil: 0, gank: 0,
    invade: 0, trade: 0.6, siegeEdge: 1.25, splitHold: false, solo: 1,
  },
  teamfight: {
    groupFrom: 14.5, fiveFrom: 15, sideLanes: 1, fiveBias: 0.15, oneFour: 0.75, tri: 0, setupLead: 55, obj: { dragon: 1.15, grubs: 0.9, herald: 1, baron: 1.15, elder: 1.2 },
    contest: 1.4, fight: 0.15, avoidUntil: 0, gank: 0.1, invade: 0, trade: 0.2, siegeEdge: 1.15, splitHold: false, solo: 0.7,
  },
  split: {
    groupFrom: 16, fiveFrom: 99, sideLanes: 1, fiveBias: -1, oneFour: 0.95, tri: 0.35, setupLead: 45, obj: { dragon: 0.95, grubs: 1, herald: 1.1, baron: 1.05, elder: 1.1 },
    contest: 0.8, fight: -0.1, avoidUntil: 0, gank: 0, invade: 0, trade: 1.1, siegeEdge: 1.3, splitHold: true, solo: 1,
  },
  early: {
    groupFrom: 18, fiveFrom: 24, sideLanes: 1, fiveBias: -0.25, oneFour: 0.45, tri: 0, setupLead: 60, obj: { dragon: 1.25, grubs: 1.35, herald: 1.25, baron: 1, elder: 1 },
    contest: 1.3, fight: 0.1, avoidUntil: 0, gank: 0.55, invade: 0.06, trade: 0.5, siegeEdge: 1.15, splitHold: false, solo: 1.2,
  },
  objective: {
    groupFrom: 21, fiveFrom: 24, sideLanes: 1, fiveBias: -0.25, oneFour: 0.45, tri: 0, setupLead: 55, obj: { dragon: 1.3, grubs: 1.2, herald: 1.25, baron: 1.3, elder: 1.3 },
    contest: 1, fight: 0, avoidUntil: 0, gank: 0, invade: 0, trade: 1.4, siegeEdge: 1.25, splitHold: false, solo: 1,
  },
  scaling: {
    groupFrom: 24, fiveFrom: 28, sideLanes: 1, fiveBias: 0.05, oneFour: 0.45, tri: 0, setupLead: 45, obj: { dragon: 0.85, grubs: 0.7, herald: 0.8, baron: 1, elder: 1.2 },
    contest: 0.65, fight: -0.15, avoidUntil: 26, gank: -0.35, invade: 0, trade: 0.8, siegeEdge: 1.4, splitHold: false, solo: 1,
  },
};

const avg = (cs: ChampionData[], k: keyof ChampionData["style"]) => cs.reduce((a, c) => a + (c.style?.[k] ?? 5), 0) / Math.max(1, cs.length);

/**
 * How well a drafted five suits each plan, as z-scores against auto-drafted LCK fives (median 0, ~1 = a clear lean).
 * Champs in role order Top, Jungle, Mid, Bot, Support. Centres/spreads measured on 400 auto drafts (2026-11-26).
 */
export function compFit(champs: ChampionData[]): Record<Strategy, number> {
  const engage = (avg(champs, "engage") - 4.3) / 1.4;
  const peel = (avg(champs, "peel") - 4) / 1.4;
  const early = (avg(champs, "early") - 5) / 1.1;
  const scaling = (avg(champs, "scaling") - 5.8) / 1;
  const wave = (avg(champs, "waveclear") - 5.2) / 1.2;
  const solo = champs.filter((_, i) => i === 0 || i === 2);
  const split = (Math.max(0, ...solo.map((c) => c.style?.split ?? 0)) - 5.5) / 1.8;
  return {
    balanced: 0,
    teamfight: (engage * 0.7 + peel * 0.3 - 1.01) / 0.47,
    split: (split + 0.28) / 0.43,
    early: (early - 0.36) / 0.71,
    objective: (wave * 0.6 + early * 0.25 - 0.15) / 0.29,
    scaling: (scaling * 0.7 - early * 0.3 + 0.05) / 0.8,
  };
}

/** What an AI coach picks when nobody chose: the team's real 2026 style blended with the drafted champions. */
export function defaultStrategy(s: GameState, teamId: string, champs: ChampionData[]): Strategy {
  void s;
  const styles = LCK_STATS?.teamStyles ?? {};
  // LCK CL sides (T1EA, DKC, ...) lean a little toward their parent club's style
  const parent = styles[teamId] ? undefined : Object.keys(styles).find((k) => teamId.startsWith(k));
  const real = (styles[teamId] ?? (parent ? styles[parent] : undefined))?.suggested as Strategy | undefined;
  const w = styles[teamId] ? 0.85 : 0.4;
  const fit = compFit(champs);
  let best: Strategy = "balanced", bestV = -Infinity;
  for (const k of STRATEGIES) {
    // the real style wins unless the draft clearly points elsewhere; with nothing standing out: balanced
    const v = (k === "balanced" ? 0.55 : fit[k] * 0.6) + (real === k ? w : 0);
    if (v > bestV) { bestV = v; best = k; }
  }
  return best;
}
