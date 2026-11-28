// Team brain: game plans, rotations, objectives (owner: macro agent).
// Called by engine.ts when ENGINE_FLAGS.macro is on:
//   init(e)                  once, at the end of the Engine constructor
//   teamThink(e)             every step (0.25 s), replaces the old Engine.teamThink (throttled inside)
//   unitTick(e, u)           every step for each live unit that is not recalling-channel / not in a fight;
//                            returns true when this module moved/handled the unit this step (engine then skips its old logic)
//   hitsObjective(e, u, k)   whether u may damage objective k this step (only committed attackers)
//   stance(e, u)             read by fight.ts: should u start / join fights right now?
//
// Design (2026-11-26)
//  * One brain per side re-thinks every 2.5 s. It scores candidate PLANS — take/setup an objective, contest an enemy
//    take, defend a structure, siege a lane, group reset — against "no plan" (0.45). The running plan gets +0.3
//    (hysteresis) and is committed for a while (setup: until the spawn, take: until done or aborted, siege 20 s ...);
//    only emergencies (defend, contest) may break a commitment.
//  * Members not used by the plan follow the FORMATION: laning (old engine code), spread (everyone farms a lane),
//    1-4 / 1-3-1 (side laner(s) + a group), five (one group). Formation is re-rolled every 35-60 s from the strategy
//    and the 2026 LCK grouped-share curve (lck-stats.gen.ts shape).
//  * Groups move as one: a virtual anchor walks to the destination at the slowest member's pace and waits while
//    fewer than `quorum` members are within 1,300 u; members stand at role offsets around it.
//  * Objectives: setup (shove the lanes next to the pit, then hold the setup zone) -> gather (the minimum group at our
//    river entrance, ~1,600-2,000 u out) -> commit (hitters walk in, guards hold our side ~1,000 u out). The side that
//    holds the area (presence-weighted power, symmetric) sets up at the entrance; the other waits 2,700 u back and
//    only commits by contesting. Only committed hitters damage it, and only once enough of them are inside the pit
//    (counted live). The group size is the minimum (dragon/herald 3, grubs 2, baron/elder 4) plus members until we
//    out-muscle what can arrive; hitter counts are drawn from the LCK participant shares; a jungler solos only when
//    the enemy jungler is dead or far and nobody is near. Laning-phase objectives are given up by the side without
//    the area (its jungler keeps farming), which is what lets the other jungler solo grubs.
//  * Voidgrubs are three monsters (engine GRUB_TUNE, GRUB_MACRO here). One side holds the area during laning (power
//    ratio x a per-game tilt) and takes them when it is free; the other side's jungler may walk in alone to smite one
//    (a "poach": a contest plan of one) or start on an unwatched camp (a "sneak"). A jungler on the grubs stays
//    against one enemy; when more show up it finishes the grub it is on and leaves with what it has.
//  * Danger: outnumbered units fall back to a turret away from the threat; groups back off together; survivors of a
//    lost fight keep retreating while the engine's calm runs; hurt units reset instead of walking back in.
//  * Heatmaps/zones only scatter positions inside the area a plan picked.
//  * planLabel(e, side) gives the current plan in Korean for a HUD; st(e).log records plan changes when logOn.
//
// Objective fights (2026-11-27, T08; measured with scripts/objfight-diag.ts against scripts/lck_objfights.py)
//  * Before: a take was dropped as "outnumbered" whenever every enemy that could arrive out-muscled the plan's own
//    three or four members, so two even teams both left the same dragon; the side without the area waited 2,700 u
//    back and usually left as well. Fights over a dragon came with 25 % of dragon kills (LCK 2026: 31 %), fights of
//    six or more before 14:00 0.04 times a game (0.77).
//  * Now each side makes one of three calls on an epic monster from its whole-team presence-weighted power there:
//    hold the area (stage at the entrance, start it), hover (대치: stand OBJ_TUNE.hover out on its own side and collapse
//    on the take when the contest odds are there), or concede (below concedeAt: no plan, and the trade context below).
//  * Standoff: a side that holds the area does not start the monster while enemies near the pit match it; it waits
//    (the fight module opens the fight if somebody finds an engage) and starts it after its standoff time
//    (OBJ_TUNE.standoffMin..standoffMax seconds) at even odds.
//    Guards stand on the fan points nearest the enemy, between it and the pit.
//  * Trade: while three or more enemies are on a pit we are not playing for, the other pit's monster and a turret on
//    the far side of the map are worth more (tradeCtx); the plan remembers what it was traded for (HUD label).
//  * purpose(e, side, f) tells fight.ts what a side wants from a fight next to a pit: "take" (finish the monster),
//    "stop" (the enemy is on it: fight now or lose it) or "hold".
import type { Engine, ObjKey, SideN, Unit } from "./engine";
import { ENGINE_FLAGS, GRUB_TUNE, SIM_TUNE, applyTune } from "./engine";
import type { LaneId, Vec } from "./map";
import { BARON_PIT, DRAGON_PIT, FOUNTAIN, LANES, MIRROR_C, NEXUS, ROLE_LANE, dist, lanePoint, laneU, mirror } from "./map";
import * as Nav from "./nav";
import * as Items from "./items";
import * as Summoners from "./summoners";
import { STEAL_TUNE, secondsTo } from "./objsmite";
import { LCK_STATS } from "./lck-stats.gen";
import type { Strategy, StrategyParams } from "./strategy";
import { STRATEGY_PARAMS } from "./strategy";
import type { Role } from "../data/types";

export type Stance = "engage" | "hold" | "avoid" | "free";

const DT = 0.25;
const THINK = 2.5;
const HYST = 0.3;
const NONE_SCORE = 0.45;

type Pit = "dragon" | "baron";
const PIT_OF: Record<ObjKey, Pit> = { dragon: "dragon", elder: "dragon", baron: "baron", herald: "baron", grubs: "baron" };
const PIT_POS: Record<Pit, Vec> = { dragon: DRAGON_PIT, baron: BARON_PIT };
const OBJS: ObjKey[] = ["elder", "baron", "dragon", "herald", "grubs"];
/** River entrances on blue's side where a team gathers (placed on the wall mask). Red's are blue's at the other pit
 *  turned 180° about the map centre: the Rift's real symmetry swaps dragon and baron. */
const BLUE_STAGE: Record<Pit, Vec> = { dragon: { x: 8500, y: 5300 }, baron: { x: 5300, y: 8500 } };
const rot = (p: Vec): Vec => ({ x: MIRROR_C - p.x, y: MIRROR_C - p.y });
/** a side holds the dragon area (sets up at its entrance instead of waiting back) when its presence-weighted power is
 *  at least this share of the other side's */
const DRAGON_HOLD = 0.8;
/**
 * Objective fights (T08). Scripts can override any of them with OBJ_TUNE=key:value,...
 * hover: how far from the pit the side without the area waits, on its own side (was 2,700 u).
 * concede / concedeBig / concedeMinor: below this share of the enemy's presence-weighted power at the pit a side gives
 *   the monster up instead of showing up (dragon / soul-point dragon, baron, elder / herald, grubs).
 * contest / contestBig / contestEpic: the same yardstick for collapsing on an enemy take (was 0.95 / 0.8 / 0.65, but
 *   weighed against every enemy within 25 s; now both sides over the same few seconds, see contestCand).
 * standoffEdge: a side holding the area starts the monster at once when it has this power edge over the enemies
 *   within `near` of the pit; otherwise it waits standoffMin..standoffMax seconds and starts it at standoffGo.
 * groupFrom: the minute from which a dragon is played as a group objective even if none has been taken (laningFor).
 * seen: an enemy group this close to a monster that is up is about to take it (contestCand); laneReach: during
 *   laning only champions within this many seconds of the pit answer; guard: how far out the guards stand.
 * backOff: a committed take is called off when the enemies within `near` have this edge over our members there.
 * tradeObj / tradeSiege: score bonus for the other pit's monster / a far-side turret while the enemy is on a pit we
 *   are not playing for (on top of the strategy's `trade`).
 * baronFrom: before this minute a baron call needs more bodies down (takeCand).
 * stealFrom: a steal run is only for a jungler this close to the pit when the enemy commits; stealHover / stealLoose:
 *   its chance when its team is at the pit for that monster / is not; stealBig: added for baron, elder and soul-race
 *   dragons (stealTick, T09).
 */
export const OBJ_TUNE = {
  hover: 2300,
  concede: 0.6, concedeBig: 0.45, concedeMinor: 0.7,
  contest: 0.95, contestBig: 0.78, contestEpic: 0.65,
  near: 2600, standoffEdge: 1.25, standoffMin: 5, standoffMax: 12, standoffGo: 0.9,
  seen: 2300, laneReach: 16, guard: 820, groupFrom: 11, stage: 0,
  backOff: 1.5,
  tradeObj: 0.35, tradeSiege: 0.3,
  baronFrom: 24,
  stealFrom: 3600, stealHover: 0.65, stealLoose: 0.3, stealBig: 0.2,
};
export function applyObjTune(spec: string | undefined) {
  applyTune(OBJ_TUNE, "OBJ_TUNE", spec);
}
/** siege score bonus when the target lane's inhibitor is already down (the nexus is next), see siegeCand */
const BASE_OPEN_PUSH = 0.6;
/** a sieging group whose wave has not reached the structure yet stands this far (lane fraction) behind the wave front */
const SIEGE_WAVE_BACK = 0.012;
/** minimum group before a team commits (spec); a safe jungler may still solo dragon / herald / grubs */
const MIN_GROUP: Record<ObjKey, number> = { dragon: 3, herald: 3, grubs: 2, baron: 4, elder: 4 };
const PREF: Record<ObjKey, Role[]> = {
  dragon: ["Jungle", "Bot", "Support", "Mid", "Top"],
  elder: ["Jungle", "Bot", "Support", "Mid", "Top"],
  grubs: ["Jungle", "Top", "Mid", "Support", "Bot"],
  herald: ["Jungle", "Top", "Mid", "Support", "Bot"],
  baron: ["Jungle", "Mid", "Support", "Bot", "Top"],
};
/** chance a safe jungler takes it alone (before the strategy's multiplier); LCK solo shares dragon 21 %, herald 19 %, grubs 78 % */
const SOLO_P: Partial<Record<ObjKey, number>> = { dragon: 0.75, herald: 0.5, grubs: 1 };
/**
 * Voidgrub decisions (LCK 2026, scripts/lck_grubs.py; the engine's numbers come from scripts/grubs-diag.ts).
 * poach: chance per camp that a side's jungler, seeing the enemy on the grubs and able to get there before they are
 *   gone, walks in alone for a last hit (both teams got a grub in 19.7 % of LCK games, 71 % of those with the two
 *   teams' kills within 20 s of each other, and only 13.5 % of games see a champion die at the pit).
 * poachEdge: it only goes when the enemies at the pit are no stronger than this times the jungler (one enemy at most).
 * stayEdge: a jungler alone on the grubs stays when a single enemy this much stronger at most comes near (it used to
 *   leave for anyone within 2,600 u); two or more still chase it off with the grubs it has.
 */
export const GRUB_MACRO = {
  poach: 1, poachEdge: 2.5, stayEdge: 1.3,
  /** who holds the grubs during laning: the power ratio at the pit is multiplied by exp(tilt x a normal draw per
   *  game + blueEdge) for blue and its inverse for red. LCK: the first grub goes to the side ahead in gold at 8:00
   *  in 55.7 % of games only (lane states and jungle paths decide, which the power ratio does not see) and blue takes
   *  59.6 % of all grubs. The same tilt decides who may answer a take with a group (contestCand). */
  tilt: 0.55, blueEdge: 0.28,
  /** sneak: chance per camp that the jungler of the side without the area starts on the grubs alone when the enemy
   *  jungler is far and nobody is near. finish: a jungler chased off the grubs first finishes the one it is on when
   *  that grub is under this share of its health (so it leaves with one or two instead of none). */
  sneak: 1, finish: 0.9,
  /** a side is at the pit when the grubs spawn in this share of camps; otherwise it is free for them an exponential
   *  time later (mean lateMean seconds). LCK: first grub 14 / 18 / 32 / 74 / 117 s after 8:00 (P10 / 25 / 50 / 75 / 90). */
  onTime: 0.42, lateMean: 62,
  /** skip: share of games in which neither side starts on the camp (LCK: 2.8 % of camps leave untouched). back: a
   *  side walks over for grubs somebody left behind this often (LCK: 9 % of the visits that stop with grubs alive
   *  are never followed up and those grubs despawn). */
  skip: 0.03, back: 0.6,
  /** a group at the grubs leaves the hitting to its jungler this often (the others guard): LCK grubs die to one
   *  champion 78 % of the time */
  groupSolo: 0.6,
};
/** Scripts can override any of them with GRUB_MACRO=key:value,... */
export function applyGrubMacro(spec: string | undefined) {
  applyTune(GRUB_MACRO, "GRUB_MACRO", spec);
}
/** a side's multiplier on its power at the grubs during laning (GRUB_MACRO.tilt) */
const grubTilt = (M: MacroState, side: SideN) => (side === 0 ? M.grubTilt : 1 / M.grubTilt);
/** a grub this side is hitting right now is nearly dead: it finishes that one before leaving (GRUB_MACRO.finish).
 *  A grub somebody else left damaged does not count (it regenerates for up to 25 s). */
function grubInHand(e: Engine, side: SideN): boolean {
  for (const g of e.grubUnits) if (g.alive && g.hp < g.maxHp * GRUB_MACRO.finish && e.t - g.hitAt[side] < 2) return true;
  return false;
}
/** A side that came over to stop the enemy's grubs stays on the camp once the enemy is gone: the jungler that walked
 *  in for a last hit (a poach) always, a group that answered only when it is free for the grubs by now (its start
 *  delay has passed) and takes the trouble (GRUB_MACRO.back), the same tests as for a take of its own (takeCand). */
function grubStays(e: Engine, b: Brain, p: Plan): boolean {
  if (p.poach) return true;
  const at = e.obj.grubs.spawnAt, r = rollFor(e, b, "grubs");
  return (at === null || e.t >= at + grubDelay(r.late)) && r.back < GRUB_MACRO.back;
}
/** seconds after the spawn before a side is free for the grubs, from its per-camp draw (0..1) */
function grubDelay(u: number): number {
  if (u < GRUB_MACRO.onTime) return 0;
  return Math.min(300, -Math.log(Math.max(1e-6, 1 - (u - GRUB_MACRO.onTime) / (1 - GRUB_MACRO.onTime))) * GRUB_MACRO.lateMean);
}
const FALLBACK_PART: Record<ObjKey, number[]> = {
  dragon: [0.21, 0.28, 0.3, 0.17, 0.05], baron: [0.01, 0.07, 0.28, 0.45, 0.19], herald: [0.19, 0.29, 0.29, 0.2, 0.04],
  grubs: [0.78, 0.17, 0.04, 0.01, 0], elder: [0.05, 0.14, 0.25, 0.45, 0.11],
};
const ZONE_OF: Record<Pit, "dragonTake" | "baronTake"> = { dragon: "dragonTake", baron: "baronTake" };
/** formation offsets around a group anchor: [forward, lateral] */
const FORM: Record<Role, [number, number]> = { Top: [300, -650], Jungle: [150, 600], Mid: [-150, -200], Bot: [-550, 250], Support: [450, 120] };
const SLOT_ROLE: Record<Role, number> = { Jungle: 0, Bot: 1, Mid: 2, Support: 3, Top: 4 };

type Job = "old" | "lane" | "jungle" | "group" | "split" | "obj" | "guard" | "defend" | "escort" | "recall";
type PlanKind = "none" | "take" | "contest" | "siege" | "defend" | "reset";
type Formation = "lanes" | "spread" | "1-4" | "1-3-1" | "five";

interface UMem {
  job: Job;
  lane?: LaneId;
  buddy?: number;
  spot?: Vec;
  spotFor: string;
  spotAt: number;
  retreatUntil: number;
  retreatTo?: Vec;
  invade?: number;
}

interface Plan {
  kind: PlanKind;
  id: string;
  obj?: ObjKey;
  lane?: LaneId;
  target?: Vec;
  since: number;
  until: number;
  expires: number;
  score: number;
  members: number[];
  hitters: number[];
  /** members that must be near the pit before committing */
  need: number;
  /** wanted hitters (drawn from LCK shares) */
  h: number;
  phase: "setup" | "gather" | "commit";
  phaseAt: number;
  solo: boolean;
  engage: boolean;
  /** our presence-weighted power / theirs around the target */
  ratio: number;
  /** we hold the area: set up close and start it; without it hover on our side (OBJ_TUNE.hover) */
  prio: boolean;
  emergency?: boolean;
  /** grubs: a contest by the jungler alone, for a last hit (GRUB_MACRO.poach) */
  poach?: boolean;
  /** how long this side stands off before it starts the monster at even odds, and since when it has been standing
   *  off (both set the first time its gathered group finds matching enemies at the pit) */
  standoff?: number;
  standAt?: number;
  /** the monster the enemy was on when this plan was picked as the trade for it */
  trade?: ObjKey;
  /** contest: the seconds both sides were weighed over when it was picked (contestCand); planValid uses the same */
  hz?: number;
}

interface Group {
  key: string;
  x: number;
  y: number;
  path: Vec[];
  dest: Vec;
  pathFor: Vec | null;
  members: number[];
  quorum: number;
}

interface Brain {
  side: SideN;
  strat: Strategy;
  P: StrategyParams;
  plan: Plan;
  next: number;
  formation: Formation;
  formUntil: number;
  splitter: number;
  side2: number;
  splitLane: LaneId;
  group: Group;
  hist: { t: number; my: number; th: number }[];
  cool: Partial<Record<string, number>>;
  rolls: Partial<Record<ObjKey, { at: number; solo: number; h: number; poach: number; late: number; sneak: number; back: number }>>;
  wonFight: boolean;
  /** lost the fight of the last 20 s (two kills or more behind in it) */
  lostFight: boolean;
  /** when takeCand last gave a monster up for lack of power (concedeAt), by monster */
  gaveUp: Partial<Record<ObjKey, number>>;
  /** the enemy is on a pit we are not playing for (think): the monster and its pit */
  trade: { k: ObjKey; pit: Pit } | null;
  /** the jungler is going for a steal of monster k (stealTick); `tried`: the spawn it was last decided for, by monster */
  steal: { k: ObjKey; by: number; until: number } | null;
  stealTried: Partial<Record<ObjKey, number>>;
}

interface Geo {
  stage: [Record<Pit, Vec>, Record<Pit, Vec>];
  guard: [Record<Pit, Vec[]>, Record<Pit, Vec[]>];
  back: [Record<Pit, Vec>, Record<Pit, Vec>];
  slots: Record<Pit, Vec[]>;
}

export interface MacroStats {
  plans: Record<string, number>; aborts: Record<string, number>; formations: Record<string, number>;
  /** objective calls (T08): hover:<obj> = thinks spent hovering, standoff:<obj> = commits that waited out a standoff,
   *  start:<obj> = commits at once, concede:<obj>, trade:<what> = plans picked as a trade */
  calls: Record<string, number>;
}

export interface MacroState {
  brains: [Brain, Brain];
  units: UMem[];
  /** committed hitters inside each pit, per side, this step */
  pit: [Partial<Record<ObjKey, number>>, Partial<Record<ObjKey, number>>];
  geo: Geo;
  stats: [MacroStats, MacroStats];
  log: string[];
  logOn: boolean;
  /** blue's multiplier on its hold of the grub area this game (red: the inverse), see GRUB_MACRO.tilt */
  grubTilt: number;
  /** nobody starts on the grubs this game (GRUB_MACRO.skip) */
  grubSkip: boolean;
}

// ---------- small helpers ----------
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const snap = (p: Vec): Vec => Nav.nearestWalkable(p);
const toward = (a: Vec, b: Vec, d: number): Vec => {
  const L = dist(a, b) || 1;
  return { x: a.x + ((b.x - a.x) / L) * d, y: a.y + ((b.y - a.y) / L) * d };
};
const hpf = (u: Unit) => u.hp / Math.max(1, u.maxHp);
const lastShop = (u: Unit) => {
  const x = u as Unit & { lastShop?: number };
  if (x.lastShop === undefined) x.lastShop = u.gold;
  return x.lastShop;
};
const setShop = (u: Unit) => { (u as Unit & { lastShop?: number }).lastShop = u.gold; };
const channeling = (u: Unit) => u.task === "recall";
const inFountain = (u: Unit) => dist(u, FOUNTAIN[u.side]) < 1300;

function log(M: MacroState, e: Engine, b: Brain, s: string) {
  if (!M.logOn) return;
  const m = Math.floor(e.t / 60), sec = Math.floor(e.t % 60);
  M.log.push(`${m}:${String(sec).padStart(2, "0")} ${b.side ? "R" : "B"} ${s}`);
}

export function st(e: Engine): MacroState | null {
  return (e.mods.macro as MacroState | undefined) ?? null;
}

function partShares(k: ObjKey): number[] {
  const p = LCK_STATS?.objectives?.[k]?.participants;
  return p && p.length === 5 ? p : FALLBACK_PART[k];
}

function lckShape(minute: number): { sideLaner: number; grouped: number } {
  const sh = LCK_STATS?.shape;
  if (!sh || !sh.length) return { sideLaner: 0.64, grouped: 0.28 };
  const m = clamp(Math.round(minute), sh[0].minute, sh[sh.length - 1].minute);
  return sh.find((r) => r.minute === m) ?? sh[sh.length - 1];
}

/** Weighted random point from a 500 u blue-view count grid, inside [rMin, rMax] of `center` (real coordinates). */
function scatter(e: Engine, grid: number[][] | undefined, side: SideN, center: Vec, rMin: number, rMax: number, keep?: (p: Vec) => boolean): Vec {
  if (grid) {
    let total = 0;
    const cand: { p: Vec; w: number }[] = [];
    for (let ix = 0; ix < grid.length; ix++) {
      const col = grid[ix];
      for (let iy = 0; iy < col.length; iy++) {
        const v = col[iy];
        if (!v) continue;
        const c0 = { x: -120 + (ix + 0.5) * 500, y: -120 + (iy + 0.5) * 500 };
        const c = side === 0 ? c0 : mirror(c0);
        const d = dist(c, center);
        if (d < rMin || d > rMax || (keep && !keep(c))) continue;
        cand.push({ p: c, w: v });
        total += v;
      }
    }
    if (total > 0) {
      let r = e.rng.next() * total;
      for (const c of cand) {
        r -= c.w;
        if (r <= 0) {
          const p = { x: c.p.x + (e.rng.next() - 0.5) * 420, y: c.p.y + (e.rng.next() - 0.5) * 420 };
          const d = dist(p, center);
          const q = d > rMax ? toward(center, p, rMax) : d < rMin ? toward(center, p, rMin) : p;
          return snap(q);
        }
      }
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = e.rng.next() * Math.PI * 2, r = rMin + e.rng.next() * (rMax - rMin);
    const p = { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
    if (!keep || keep(p)) return snap(p);
  }
  return snap(center);
}

function ownHalf(side: SideN, p: Vec, slack = 400) {
  return side === 0 ? p.x + p.y < MIRROR_C + slack : p.x + p.y > MIRROR_C - slack;
}

/** `contest`: valuing a stop of the enemy's take (contestCand) rather than our own take */
function objValue(e: Engine, side: SideN, k: ObjKey, contest = false): number {
  const my = e.dragons[side].length, th = e.dragons[1 - side].length;
  switch (k) {
    case "dragon": return 1 + (my >= 3 ? 0.9 : my === 2 ? 0.25 : 0) + (th >= 3 ? 0.8 : th === 2 ? 0.2 : 0);
    // three grubs are worth what the camp was as one monster; leftovers less (a lone jungler still picks them up)
    case "grubs": return 0.45 + 0.1 * (e.obj.grubs.alive ? e.obj.grubs.left ?? 3 : 3);
    case "herald": return 0.75;
    case "baron": return 1.6 + (e.minute() > 30 ? 0.3 : 0);
    // elder is the comeback for the side without the soul; the soul side (it wins ~90% of engine and LCK games anyway)
    // converts by sieging instead of camping elder (engine before: 1.0-1.3 elders per game that reached the elder spawn,
    // 72-77% by the soul side; LCK 2026: 0.54, 57%). Stopping the other side's elder keeps its full value.
    case "elder": return e.soul === side && !contest ? 1.4 : 2.6;
  }
}

/** How soon (0..1) an enemy can matter at p within `horizon` seconds. */
function presence(e: Engine, x: Unit, p: Vec, horizon: number): number {
  if (!x.alive) {
    const back = x.respawnAt - e.t + dist(FOUNTAIN[x.side], p) / 420;
    return back < horizon ? 0.45 : 0;
  }
  if (channeling(x) && x.recallEnd !== undefined) return 0.3;
  const eta = dist(x, p) / 420;
  return eta < 6 ? 1 : eta < 12 ? 0.8 : eta < horizon ? 0.55 : 0.25;
}

function powerAt(e: Engine, us: Unit[], p: Vec, horizon: number) {
  let s = 0;
  for (const u of us) s += e.power(u.alive ? u : { ...u, hp: u.maxHp }) * presence(e, u, p, horizon);
  return s;
}

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

/** The monsters a team shows up for even when it is behind: baron, elder and the dragons of a soul race (the enemy on
 *  two stacks or more, or our own soul point). */
function bigObj(e: Engine, side: SideN, k: ObjKey): boolean {
  return k === "baron" || k === "elder" || (k === "dragon" && (e.dragons[1 - side].length >= 2 || e.dragons[side].length >= 3));
}

/** Below this share of the enemy's presence-weighted power at the pit a side does not show up for the monster. */
function concedeAt(e: Engine, b: Brain, k: ObjKey): number {
  const base = bigObj(e, b.side, k) ? OBJ_TUNE.concedeBig : k === "dragon" ? OBJ_TUNE.concede : OBJ_TUNE.concedeMinor;
  return base - b.P.fight * 0.5;
}

/** The power share (members that can get there in time against every enemy that can) a side needs to collapse on an
 *  enemy take. A team behind still flanks a baron / elder for a steal or a fight (LCK teams rarely hand baron over). */
function contestMin(e: Engine, b: Brain, k: ObjKey): number {
  const base = k === "baron" || k === "elder" ? OBJ_TUNE.contestEpic : bigObj(e, b.side, k) ? OBJ_TUNE.contestBig : OBJ_TUNE.contest;
  return base - b.P.fight * 0.5;
}

/** Who stands within OBJ_TUNE.near of a pit right now: our (plan members') count and power, the enemies', the edge. */
function atPit(e: Engine, side: SideN, pit: Vec, members?: number[]) {
  let ourN = 0, ourP = 0, thN = 0, thP = 0;
  for (const u of e.units) {
    if (!u.alive || channeling(u) || dist(u, pit) > OBJ_TUNE.near) continue;
    if (u.side !== side) { thN++; thP += e.power(u); }
    else if (!members || members.includes(u.i)) { ourN++; ourP += e.power(u); }
  }
  return { ourN, ourP, thN, thP, edge: (ourP + 1) / (thP + 1) };
}

/** Laning rules for a monster (no setup before the spawn, the side without lane priority gives it up, only the lanes
 *  next to it come): everything during laning except the dragon once one has been taken or OBJ_TUNE.groupFrom minutes
 *  have passed. From the second dragon on both teams set up for it as a group, as they do after laning (before, every
 *  dragon before 14:00 ran on laning rules: fights of 6+ before 14:00 0.04 a game, LCK 2026 0.77, 45 % of them at the
 *  dragon pit). */
function laningFor(e: Engine, V: View, k: ObjKey): boolean {
  if (!V.laning) return false;
  if (k !== "dragon") return true;
  return e.dragons[0].length + e.dragons[1].length < 1 && V.minute < OBJ_TUNE.groupFrom;
}

/** The monster in play at a pit: up, or spawning within `lead` seconds (the herald is held back while baron is up). */
function inPlay(e: Engine, pk: Pit, lead: number): ObjKey | null {
  for (const k of OBJS) {
    if (PIT_OF[k] !== pk || (k === "herald" && e.obj.baron.alive)) continue;
    const o = e.obj[k];
    if (o.alive || (o.spawnAt !== null && o.spawnAt >= e.t && o.spawnAt - e.t < lead)) return k;
  }
  return null;
}

/** The other side is on the monster: its plan is committed on it and the monster has taken damage. (Health below full
 *  alone also holds after our own called-off take, since a monster no longer heals while it is being fought over.) */
function enemyOn(e: Engine, M: MacroState, side: SideN, k: ObjKey): boolean {
  const o = e.obj[k], p = M.brains[1 - side].plan;
  return o.alive && o.hp < o.maxHp * 0.97 && (p.kind === "take" || p.kind === "contest") && p.obj === k && p.phase === "commit";
}

/** The other side's plan is committed on monster k (walking in on it or hitting it). */
function enemyCommitted(e: Engine, M: MacroState, side: SideN, k: ObjKey): boolean {
  const p = M.brains[1 - side].plan;
  return e.obj[k].alive && (p.kind === "take" || p.kind === "contest") && p.obj === k && p.phase === "commit";
}

/** The enemy is on a pit we are not playing for (three or more of them within OBJ_TUNE.near, its monster in play, and
 *  we have no plan there or only hover): what we do elsewhere now is a trade for it. */
function tradeCtx(e: Engine, b: Brain, V: View): Brain["trade"] {
  const p = b.plan;
  for (const pk of ["dragon", "baron"] as Pit[]) {
    const k = inPlay(e, pk, 20);
    if (!k) continue;
    if ((p.kind === "take" || p.kind === "contest") && p.obj && PIT_OF[p.obj] === pk && (p.prio || p.kind === "contest" || p.phase === "commit")) continue;
    if (V.theirs.filter((x) => dist(x, PIT_POS[pk]) < OBJ_TUNE.near).length >= 3) return { k, pit: pk };
  }
  return null;
}

// ---------- init ----------
function buildGeo(): Geo {
  const stage: Geo["stage"] = [
    { dragon: snap(BLUE_STAGE.dragon), baron: snap(BLUE_STAGE.baron) },
    { dragon: snap(rot(BLUE_STAGE.baron)), baron: snap(rot(BLUE_STAGE.dragon)) },
  ];
  // OBJ_TUNE.stage > 0 pulls the entrances in to that distance from the pit (they are 1,630-1,900 u out)
  if (OBJ_TUNE.stage > 0) for (const side of [0, 1] as SideN[]) for (const pk of ["dragon", "baron"] as Pit[]) {
    stage[side][pk] = snap(toward(PIT_POS[pk], stage[side][pk], OBJ_TUNE.stage));
  }
  const guard: Geo["guard"] = [{} as Record<Pit, Vec[]>, {} as Record<Pit, Vec[]>];
  const back: Geo["back"] = [{} as Record<Pit, Vec>, {} as Record<Pit, Vec>];
  const slots = {} as Record<Pit, Vec[]>;
  for (const pk of ["dragon", "baron"] as Pit[]) {
    const pit = PIT_POS[pk];
    for (const side of [0, 1] as SideN[]) {
      // guards hold our side of the pit: fanned around the line to our stage, just outside the hitters (was ~950 u
      // out, and fights over a take happened 1,500-2,500 u from the pit; LCK: 20 % of big fights inside 1,500 u)
      const a0 = Math.atan2(stage[side][pk].y - pit.y, stage[side][pk].x - pit.x);
      guard[side][pk] = [-0.55, 0.55, 0].map((da) => {
        let g = snap({ x: pit.x + Math.cos(a0 + da) * OBJ_TUNE.guard, y: pit.y + Math.sin(a0 + da) * OBJ_TUNE.guard });
        if (dist(g, pit) < OBJ_TUNE.guard - 170) g = snap(toward(pit, g, OBJ_TUNE.guard));
        return g;
      });
      // where the side without the area hovers: on the line to its own entrance, outside the guards' reach
      back[side][pk] = snap(toward(pit, stage[side][pk], OBJ_TUNE.hover));
    }
    // hitter slots: a fan around the pit centre facing the opening (the mean direction to both stages)
    const mx = (stage[0][pk].x + stage[1][pk].x) / 2 - pit.x, my = (stage[0][pk].y + stage[1][pk].y) / 2 - pit.y;
    const a0 = Math.atan2(my, mx);
    slots[pk] = [0, 1, -1, 2, -2].map((j) => {
      const a = a0 + j * 0.75;
      const p = snap({ x: pit.x + Math.cos(a) * 300, y: pit.y + Math.sin(a) * 300 });
      return dist(p, pit) < 520 ? p : { x: pit.x, y: pit.y };
    });
  }
  return { stage, guard, back, slots };
}

function noPlan(t: number): Plan {
  return { kind: "none", id: "none", since: t, until: t, expires: Infinity, score: NONE_SCORE, members: [], hitters: [], need: 0, h: 0, phase: "commit", phaseAt: t, solo: false, engage: false, ratio: 1, prio: true };
}

function pickSplitter(e: Engine, side: SideN, exclude = -1): number {
  let best = -1, bv = -Infinity;
  for (const u of e.units) {
    if (u.side !== side || u.i === exclude || u.role === "Jungle" || u.role === "Support") continue;
    const v = (u.champ.style?.split ?? 0) + (u.role === "Top" ? 2 : u.role === "Mid" ? 0.5 : 0) + (u.champ.style?.waveclear ?? 5) * 0.15;
    if (v > bv) { bv = v; best = u.i; }
  }
  return best;
}

export function init(e: Engine): void {
  const brains = ([0, 1] as SideN[]).map((side): Brain => {
    const strat = e.strategy[side] ?? "balanced";
    const splitter = pickSplitter(e, side);
    return {
      side, strat, P: STRATEGY_PARAMS[strat] ?? STRATEGY_PARAMS.balanced, plan: noPlan(0), next: 1 + side * 1.25,
      formation: "lanes", formUntil: 0, splitter, side2: pickSplitter(e, side, splitter), splitLane: "top",
      group: { key: "", x: 0, y: 0, path: [], dest: { x: 0, y: 0 }, pathFor: null, members: [], quorum: 1 },
      hist: [], cool: {}, rolls: {}, wonFight: false, lostFight: false, gaveUp: {}, trade: null, steal: null, stealTried: {},
    };
  }) as [Brain, Brain];
  const units = e.units.map((): UMem => ({ job: "old", spotFor: "", spotAt: -99, retreatUntil: 0 }));
  const state: MacroState = {
    brains, units, pit: [{}, {}], geo: buildGeo(),
    stats: [{ plans: {}, aborts: {}, formations: {}, calls: {} }, { plans: {}, aborts: {}, formations: {}, calls: {} }], log: [], logOn: false,
    // a normal draw from three uniforms (sd 1)
    grubTilt: Math.exp(GRUB_MACRO.tilt * (e.rng.next() + e.rng.next() + e.rng.next() - 1.5) * 2 + GRUB_MACRO.blueEdge),
    grubSkip: e.rng.next() < GRUB_MACRO.skip,
  };
  e.mods.macro = state;
}

// ---------- team think ----------
interface View {
  side: SideN;
  team: Unit[];
  foes: Unit[];
  mine: Unit[];
  theirs: Unit[];
  myPow: number;
  thPow: number;
  edge: number;
  numAdv: number;
  minute: number;
  laning: boolean;
  baron: boolean;
}

function view(e: Engine, side: SideN): View {
  const team = e.units.filter((u) => u.side === side);
  const foes = e.units.filter((u) => u.side !== side);
  const mine = team.filter((u) => u.alive);
  const theirs = foes.filter((u) => u.alive);
  const myPow = mine.reduce((a, u) => a + e.power(u), 0);
  const thPow = theirs.reduce((a, u) => a + e.power(u), 0);
  return {
    side, team, foes, mine, theirs, myPow, thPow, edge: (myPow + 1) / (thPow + 1), numAdv: mine.length - theirs.length,
    minute: e.minute(), laning: e.laningPhase(), baron: mine.some((u) => u.baronUntil > e.t),
  };
}

export function teamThink(e: Engine): void {
  const M = st(e);
  if (!M) return;
  for (const b of M.brains) {
    if (e.t >= b.next) {
      b.next = e.t + THINK;
      think(e, M, b);
    }
    planTick(e, M, b);
    stealTick(e, M, b);
    groupTick(e, b);
  }
  // committed hitters inside each pit (for hitsObjective)
  for (const side of [0, 1] as SideN[]) {
    const b = M.brains[side];
    const cnt: Partial<Record<ObjKey, number>> = {};
    const p = b.plan;
    if ((p.kind === "take" || p.kind === "contest") && p.obj && p.phase === "commit") {
      const pit = PIT_POS[PIT_OF[p.obj]];
      let n = 0;
      for (const i of p.hitters) {
        const u = e.units[i];
        if (u.alive && !u.fightId && !channeling(u) && dist(u, pit) < 650) n++;
      }
      cnt[p.obj] = n;
    }
    M.pit[side] = cnt;
  }
}

function think(e: Engine, M: MacroState, b: Brain) {
  const V = view(e, b.side);
  // fight outcome over the last 20 s
  b.hist.push({ t: e.t, my: e.kills[b.side], th: e.kills[1 - b.side] });
  while (b.hist.length && e.t - b.hist[0].t > 20) b.hist.shift();
  const h0 = b.hist[0];
  b.wonFight = e.kills[b.side] - h0.my - (e.kills[1 - b.side] - h0.th) >= 2;
  b.lostFight = e.kills[1 - b.side] - h0.th - (e.kills[b.side] - h0.my) >= 2;
  // side laner(s)
  const sp = e.units[b.splitter];
  if (!sp || (!sp.alive && sp.respawnAt - e.t > 25)) {
    const alt = pickSplitter(e, b.side, b.splitter);
    if (alt >= 0 && e.units[alt].alive) b.splitter = alt;
  }
  b.trade = tradeCtx(e, b, V);
  choosePlan(e, M, b, V);
  chooseFormation(e, M, b, V);
  assign(e, M, b, V);
}

// ---------- plan candidates ----------
function mkPlan(e: Engine, kind: PlanKind, id: string, score: number, members: number[], extra: Partial<Plan> = {}): Plan {
  return {
    kind, id, since: e.t, until: e.t + 10, expires: e.t + 120, score, members, hitters: [], need: 1, h: 0,
    phase: "commit", phaseAt: e.t, solo: false, engage: false, ratio: 1, prio: true, ...extra,
  };
}

function rollFor(e: Engine, b: Brain, k: ObjKey) {
  const o = e.obj[k];
  const at = o.spawnAt ?? -1;
  let r = b.rolls[k];
  if (!r || r.at !== at) {
    // hitters for a group take: LCK participant shares with n >= 2
    const sh = partShares(k);
    const tot = sh.slice(1).reduce((a, v) => a + v, 0) || 1;
    let x = e.rng.next() * tot, h = 2;
    for (let n = 2; n <= 5; n++) { x -= sh[n - 1]; if (x <= 0) { h = n; break; } }
    const alone = e.rng.next();
    if (k === "grubs" && alone < GRUB_MACRO.groupSolo) h = 1;
    r = { at, solo: e.rng.next(), h, poach: e.rng.next(), late: e.rng.next(), sneak: e.rng.next(), back: e.rng.next() };
    b.rolls[k] = r;
  }
  return r;
}

function usable(e: Engine, b: Brain, u: Unit, k: ObjKey, V: View): boolean {
  if (!u.alive) return u.respawnAt - e.t < 8;
  if (u.i === b.splitter && !V.laning && b.formation !== "five" && b.formation !== "spread") {
    if (b.P.splitHold || (k !== "baron" && k !== "elder")) return false;
  }
  return true;
}

function nextSpawn(e: Engine): { k: ObjKey; in: number } | null {
  let best: { k: ObjKey; in: number } | null = null;
  for (const k of OBJS) {
    const o = e.obj[k];
    if (k === "herald" && e.obj.baron.alive) continue;
    const t = o.alive ? 0 : o.spawnAt === null ? Infinity : Math.max(0, o.spawnAt - e.t);
    if (t < Infinity && (!best || t < best.in)) best = { k, in: t };
  }
  return best;
}

function takeCand(e: Engine, M: MacroState, b: Brain, V: View, k: ObjKey): Plan | null {
  const o = e.obj[k];
  if (k === "herald" && e.obj.baron.alive) return null;
  const spawnIn = o.alive ? 0 : o.spawnAt === null ? Infinity : o.spawnAt - e.t;
  const lan = laningFor(e, V, k);
  const lead = lan ? (k === "grubs" ? 40 : 0) : b.P.setupLead;
  if (spawnIn > lead) return null;
  if ((b.cool[k] ?? 0) > e.t) return null;
  // the grubs leave at 14:45: no walking over for a camp that will be gone
  if (k === "grubs" && o.alive && e.t > GRUB_TUNE.leaveAt - 15) return null;
  const pk = PIT_OF[k], pit = PIT_POS[pk];
  // another objective at the same pit already planned by us: one at a time
  const val = objValue(e, b.side, k) * (b.P.obj[k] ?? 1);
  const jg = V.team.find((u) => u.role === "Jungle")!;
  const ej = V.foes.find((u) => u.role === "Jungle")!;
  const ejFar = !ej.alive ? ej.respawnAt - e.t > 15 : dist(ej, pit) > (k === "grubs" ? 3400 : 6000) || (channeling(ej) && ej.recallEnd !== undefined);
  const foesNear = V.theirs.filter((x) => dist(x, pit) < 3800).length;
  const foesClose = V.theirs.filter((x) => dist(x, pit) < (k === "grubs" ? 2200 : 2600)).length;
  const roll = rollFor(e, b, k);
  const cur = b.plan.kind === "take" && b.plan.obj === k ? b.plan : null;
  if (k === "grubs" && !cur) {
    if (M.grubSkip) return null;
    // not every side is free for the grubs the moment they are up (GRUB_MACRO.onTime / lateMean); 12 s to walk over
    if (o.spawnAt !== null && e.t < o.spawnAt + grubDelay(roll.late) - 12) return null;
    // grubs left behind are not always worth the walk
    if (o.alive && (o.left ?? 3) < 3 && roll.back >= GRUB_MACRO.back) return null;
  }
  const soloP = (SOLO_P[k] ?? 0) * b.P.solo;
  const soloOk = soloP > 0 && jg.alive && hpf(jg) > 0.5 && ejFar && foesClose === 0 && spawnIn < 40;
  // decided freshly until the team commits, then kept
  const solo = cur && cur.phase === "commit" ? cur.solo : soloOk && roll.solo < soloP;
  if (cur?.solo && cur.phase === "commit" && !(ejFar && jg.alive) && o.hp > o.maxHp * 0.3) return null; // the solo is off
  const prefs = PREF[k];
  const pool = V.team.filter((u) => usable(e, b, u, k, V))
    .sort((a, c) => prefs.indexOf(a.role) - prefs.indexOf(c.role) + (dist(a, pit) - dist(c, pit)) / 9000);
  let members: number[] = [];
  let need = 1;
  if (solo) {
    members = [jg.i];
    need = 1;
  }
  const horizon = Math.max(10, spawnIn) + 20;
  const thP = powerAt(e, V.foes, pit, horizon);
  if (!solo) {
    // bring the minimum group, then add members (preference order) until we out-muscle what can show up;
    // the rest keep farming their lanes (LCK mid-game dragons are mostly 2-4 champions)
    need = MIN_GROUP[k];
    const all = k === "baron" || k === "elder";
    members = [];
    let p0 = 0;
    for (const u of pool) {
      if (!all && members.length >= need) {
        const enough = lan ? members.length >= need + (roll.solo < 0.45 ? 1 : 0) : p0 > thP * (1.0 + Math.max(0, b.P.fight));
        if (enough) break;
      }
      members.push(u.i);
      p0 += e.power(u.alive ? u : { ...u, hp: u.maxHp }) * presence(e, u, pit, horizon);
    }
    if (members.length < need) return null;
    if (!members.includes(jg.i) && k !== "baron" && k !== "elder" && lan) return null;
  }
  const mem = members.map((i) => e.units[i]);
  const ourP = powerAt(e, mem, pit, horizon);
  const ratio = (ourP + 1) / (thP + 1);
  // who holds the area (whole teams, symmetric between the sides). Dragons: a side within DRAGON_HOLD of the other's
  // presence-weighted power holds it too, so both set up and the weaker side is not forced to concede every dragon.
  // Engine fights at a 1.1-1.25 power edge go to the stronger side only ~61% of the time (1.25-1.5: ~79%), yet with a
  // 1.0 cut the side 5 % weaker always waited 2,700 u back and gave up: dragon 0-4 splits came as often in even
  // matchups (40-53%) as in lopsided ones (scripts/dragon-curve.ts; LCK 2026: 0-4 in 24% of games).
  // (grubs during laning: who holds them is not the power ratio alone, GRUB_MACRO.tilt)
  const raw = ((powerAt(e, V.team, pit, horizon) + 1) / (thP + 1)) * (k === "grubs" && lan ? grubTilt(M, b.side) : 1);
  const area = raw / (k === "dragon" ? DRAGON_HOLD : 1);
  // laning-phase objectives are given up by the side without priority (its jungler goes back to farming), except
  // that its jungler may start alone on grubs nobody is watching (a sneak). A sneak that is off before it commits
  // (the enemy jungler came near) ends there: it must not turn into a group that waits back without the area
  const sneak = k === "grubs" && solo && roll.sneak < GRUB_MACRO.sneak;
  if (lan && area < 1 && !sneak && (!cur || (k === "grubs" && cur.phase !== "commit"))) return null;
  // too weak to show up at all: concede it (choosePlan ends a plan that has not committed as "concede") and look for a
  // trade. Between this and the hold line the side hovers. A committed take is called off by planValid instead.
  // A side that has just lost the fight and is down bodies gives an ordinary monster up as well, instead of staying
  // for a second fight over it (4+ fights about a dragon: 2.4-2.8 a game, LCK 2026 1.66; baron, elder and soul-race
  // dragons are still played for).
  const beaten = b.lostFight && V.numAdv <= -1 && !bigObj(e, b.side, k);
  if (!solo && !(cur && cur.phase === "commit") && (raw < concedeAt(e, b, k) || beaten)) {
    b.gaveUp[k] = e.t;
    return null;
  }
  let score: number;
  let trade: ObjKey | undefined;
  if (solo) score = val * 0.8 + 0.3;
  else {
    score = val + clamp(ratio - 1, -1, 1) * (lan ? 0.6 : 1.1) + V.numAdv * 0.12 + b.P.fight * 0.5 + (b.wonFight ? 0.3 : 0);
    // the enemy is on the other pit and we are not playing for that one: this is the trade (before: only with three
    // enemies inside 1,500 u of it)
    if (b.trade && b.trade.pit !== pk) {
      score += OBJ_TUNE.tradeObj + 0.4 * b.P.trade;
      trade = b.trade.k;
    }
  }
  if (lan) {
    // laning phase: lane priority next to the pit, the enemy lane partners missing, how long it has been up
    const lane: LaneId = pk === "dragon" ? "bot" : "top";
    const f = e.lanes[lane].front;
    score += (b.side === 0 ? f - 0.5 : 0.5 - f) * 2.5;
    const partners = V.foes.filter((x) => ROLE_LANE[x.role] === lane);
    score += partners.filter((x) => !x.alive || dist(x, pit) > 6000 || (channeling(x) && x.recallEnd !== undefined)).length * 0.2;
    // LCK takes the first dragon ~2.5 min after it spawns (median 7:35), grubs ~30 s after
    if (o.alive && o.spawnAt !== null) score += Math.min(0.8, (e.t - o.spawnAt) / 260);
    score -= k === "grubs" ? 0.1 : 1.05;
  }
  if (k === "baron" || k === "elder") {
    // baron is called after a pick / won fight, or when the enemy is far away; LCK first baron median 24:53
    const late = V.minute > 28;
    const early = V.minute < 24;
    // Calibration (integrator, 2026-11-26): the distance-discounted `ratio` made 5v5 barons at 20-21 min look safe —
    // 84% of barons were taken with nobody down and no kill before, 2.0-2.2 barons and 0.35 elders per game, and the
    // gold lead snowballed to 21% of team gold at 25 min (LCK 2026: 1.31 barons, 0.09 elders, 8.7%). A baron takes
    // 20-30 s, long enough for the whole enemy team to arrive, so the gate compares against every enemy that can be
    // there within 25 s at full presence.
    const ourFull = mem.reduce((a, u) => a + e.power(u), 0);
    const thFull = V.foes.filter((x) => x.alive || x.respawnAt - e.t < 25).reduce((a, x) => a + e.power(x.alive ? x : { ...x, hp: x.maxHp }), 0);
    const honest = (ourFull + 1) / (thFull + 1);
    // engine power is steep in gold/levels (a 3k lead at 20 min is ~1.5x; median 1.5 at baron takes), so a ratio-only
    // call is kept for stomps; otherwise baron follows a pick or a won fight, as in LCK
    // one pick alone was enough before (any death + ratio 1.1 → baron every time it was up); before 23 min the first
    // baron needs two down or a won fight with a body up (LCK first baron median 24:53)
    // (T08: with fights over the 2nd / 3rd dragon and the herald there is a won fight around 20:00 far more often, and
    // on the old rule (before 23 min: two down, or one down after a won fight) the first baron came at 21.8 min, the
    // first inhibitor at 24.0 and games ran 2.4 min short. Before OBJ_TUNE.baronFrom it now takes three down, or two
    // down after a won fight; with four / three the first baron came at 26.8 min, LCK 2026: 24.9.)
    const veryEarly = V.minute < OBJ_TUNE.baronFrom;
    const down = V.numAdv >= (veryEarly ? 3 : 2) || (V.numAdv >= 1 && !veryEarly && (honest > 1.35 || b.wonFight)) || (V.numAdv >= 2 && veryEarly && b.wonFight);
    // elder without a pick or a won fight needs a stomp: a full-strength enemy can flip it (LCK elder takers had more
    // champions alive in 52% of takes)
    const safe = down || honest > (k === "elder" ? 2.4 : late ? 1.75 : early ? 2.4 : 2.0) || (b.wonFight && !veryEarly && honest > 1.05);
    if (!safe && !(cur && cur.phase === "commit")) return null;
    // no camping the baron spawn unless the enemy is down bodies or the plan is built around objectives
    if (k === "baron" && !o.alive && V.numAdv < 1 && b.strat !== "objective") return null;
    if (k === "baron" && !cur && !(ratio > 1.45 || V.numAdv >= 2 || late || b.wonFight)) score -= 0.5;
  }
  if (V.minute < b.P.avoidUntil && !solo && ratio < 1.2) score -= 0.35;
  const plan = mkPlan(e, "take", `take:${k}`, score, members, {
    obj: k, need, solo, h: solo ? 1 : Math.min(roll.h, members.length),
    phase: o.alive ? "gather" : "setup", until: o.alive ? e.t + 15 : e.t + spawnIn + 10, expires: e.t + spawnIn + 110,
    engage: ratio >= 1 - b.P.fight && !(V.minute < b.P.avoidUntil && ratio < 1.35),
    ratio: area, prio: solo || area >= 1, trade,
  });
  return plan;
}

function contestCand(e: Engine, M: MacroState, b: Brain, V: View, k: ObjKey): Plan | null {
  const o = e.obj[k];
  if (!o.alive) return null;
  // our own take of it is the same fight — unless we are the side waiting back without priority: that side commits by
  // contesting (before, this line vetoed it, so the waiting side never contested and left on "outnumbered")
  if (b.plan.kind === "take" && b.plan.obj === k && (b.plan.prio || b.plan.phase === "commit")) return null;
  if ((b.cool[`c:${k}`] ?? 0) > e.t) return null;
  const pit = PIT_POS[PIT_OF[k]];
  // the enemy is on it, or its group stands at the entrance (OBJ_TUNE.seen): a dragon dies about 11 s after the first
  // hit, so an answer that starts at the first hit (before: two enemies inside 1,400 u) mostly arrived too late
  // Baron and elder take 20-30 s, long enough to answer once the enemy stands on them: for those the old trigger
  // stays (answering every enemy pair seen near the baron pit made 2.0 fights a game about baron; LCK 2026: 0.9).
  const onIt = V.theirs.filter((x) => dist(x, pit) < 1400);
  // the grubs' health does not come back with the dead ones: go by when the camp was last hit
  const hitting = k === "grubs" ? e.t - (o.hitAt ?? -99) < 3 : o.hp < o.maxHp * 0.97;
  const slow = k === "baron" || k === "elder";
  const coming = slow ? onIt.length : V.theirs.filter((x) => dist(x, pit) < OBJ_TUNE.seen).length;
  // grubs: only an enemy that is there for them counts (a jungler walking past the pit would start a "contest" that
  // then takes the camp itself); one still walking in is early enough for ours to come over for a last hit
  const ep = M.brains[1 - b.side].plan;
  const foeOnGrubs = k === "grubs" && (ep.kind === "take" || ep.kind === "contest") && ep.obj === "grubs" && ep.phase !== "setup";
  if (k === "grubs" ? !onIt.length || (!hitting && !foeOnGrubs) : hitting ? !onIt.length : coming < 2) return null;
  let dps = 0;
  for (const x of onIt) if (dist(x, pit) < 650 && !x.fightId) dps += e.aaDps(x) * 1.2 + 30;
  const ttk = o.hp / Math.max(60, dps);
  // who can be there in time; during laning only the ones close by answer (the far lanes keep farming)
  const reach = laningFor(e, V, k) ? Math.min(ttk + 5, OBJ_TUNE.laneReach) : ttk + 5;
  const can = V.mine.filter((u) => !(channeling(u) && u.recallEnd !== undefined) && hpf(u) > 0.3 && dist(u, pit) / e.speed(u) < reach);
  if (!can.length) return null;
  // both sides weighed over the time this takes (before: our members that can make it against every enemy within
  // 25 s, which counted a top laner 20 s away at 0.55 for them and nothing for us)
  const hz = clamp(reach, 10, 25);
  const ourP = powerAt(e, can, pit, hz);
  const thP = powerAt(e, V.foes, pit, hz);
  // grubs during laning: the side that holds the area (same tilt as its take) answers with a group, the other only
  // with its jungler (poachCand)
  const ratio = ((ourP + 1) / (thP + 1)) * (k === "grubs" && V.laning ? grubTilt(M, b.side) : 1);
  // the side about to lose the soul race fights for the dragon from the enemy's 2nd stack on (engine 200 games: one
  // team took all four dragons in 48% of games; LCK 2026 ~22%); a team behind still flanks a baron / elder
  if (ratio < contestMin(e, b, k)) {
    // no fight for the grubs, but our jungler can still walk in for a last hit
    return k === "grubs" && (hitting || foeOnGrubs) ? poachCand(e, b, V, can) : null;
  }
  // not straight back in after a lost fight with two or more down
  if (b.lostFight && V.numAdv <= -2 && !bigObj(e, b.side, k)) return null;
  const val = objValue(e, b.side, k, true) * (b.P.obj[k] ?? 1);
  let score = val * b.P.contest * (hitting ? 1 : 0.7) - 0.3 + clamp(ratio - 1, -1, 0.8) * 1.3 + (can.length - onIt.length) * 0.15 + b.P.fight;
  if (V.minute < b.P.avoidUntil && ratio < 1.3) score -= 0.4;
  if (k === "grubs" || k === "herald") score -= 0.2;
  return mkPlan(e, "contest", `contest:${k}`, score, can.map((u) => u.i), {
    // h = hitters needed in the pit before anyone damages it (hitsObjective): all of `can` meant a contest that won the
    // fight rarely started hitting (one member a few hundred units out blocked it) while the dragon regenerated
    obj: k, need: Math.min(3, can.length), h: Math.min(3, can.length), hitters: contestHitters(e, b, k, can.map((u) => u.i)), phase: "gather",
    until: e.t + 15, expires: e.t + 60, engage: ratio >= 0.9 - b.P.fight, emergency: true, ratio, prio: true, hz,
  });
}

/** Who hits the objective in a contest: everyone, except at the grubs, where the jungler does, at times with one
 *  more (LCK: a grub dies to one champion 78 % of the time, to three or more 5 %). */
function contestHitters(e: Engine, b: Brain, k: ObjKey, ids: number[]): number[] {
  if (k !== "grubs" || ids.length < 2) return ids.slice();
  // among the living (a dead jungler as the only hitter would leave the others standing in the pit)
  const live = ids.filter((i) => e.units[i].alive);
  if (live.length < 2) return live.length ? live : ids.slice();
  const jg = live.find((i) => e.units[i].role === "Jungle");
  const rest = live.filter((i) => i !== jg).sort((a, c) => dist(e.units[a], BARON_PIT) - dist(e.units[c], BARON_PIT));
  if (jg === undefined) return rest.slice(0, 2);
  // the same draw as a group take's: mostly the jungler alone (GRUB_MACRO.groupSolo)
  return rollFor(e, b, "grubs").h <= 1 ? [jg] : [jg, rest[0]];
}

/** The jungler alone goes for one of the grubs the enemy is taking (GRUB_MACRO). Only from no plan or a grub plan:
 *  the brain runs one plan a side, and a dragon setup is not dropped for a grub. */
function poachCand(e: Engine, b: Brain, V: View, can: Unit[]): Plan | null {
  const jg = can.find((u) => u.role === "Jungle");
  if (!jg || hpf(jg) < 0.5) return null;
  const cur = b.plan;
  if (cur.kind !== "none" && cur.obj !== "grubs") return null;
  if (!(cur.kind === "contest" && cur.poach) && rollFor(e, b, "grubs").poach >= GRUB_MACRO.poach * b.P.contest) return null;
  const there = V.theirs.filter((x) => dist(x, BARON_PIT) < 2200);
  if (there.length > 1 || there.reduce((a, x) => a + e.power(x), 0) > e.power(jg) * GRUB_MACRO.poachEdge) return null;
  return mkPlan(e, "contest", "contest:grubs", 0.9, [jg.i], {
    obj: "grubs", need: 1, h: 1, hitters: [jg.i], phase: "gather", until: e.t + 10, expires: e.t + 45, engage: false,
    emergency: true, ratio: 1, prio: true, poach: true,
  });
}

interface Structure { pos: Vec; lane: LaneId; value: number; tier: number }
function ownStructures(e: Engine, side: SideN): Structure[] {
  const out: Structure[] = [];
  for (const lane of LANES) {
    const t = e.frontierTurret(side, lane);
    if (t) { out.push({ pos: t.pos, lane, tier: t.tier, value: t.tier === 1 ? 0.45 : t.tier === 2 ? 0.65 : 0.95 }); continue; }
    const ih = e.inhibs.find((x) => x.side === side && x.lane === lane);
    if (ih?.alive) out.push({ pos: ih.pos, lane, tier: 4, value: 1.05 });
  }
  if (e.inhibs.some((x) => x.side === side && !x.alive)) {
    const nt = e.turrets.find((t) => t.side === side && t.lane === "nexus" && t.alive);
    out.push({ pos: nt ? nt.pos : NEXUS[side], lane: "mid", tier: 5, value: 1.6 });
  }
  return out;
}

function defendCand(e: Engine, M: MacroState, b: Brain, V: View): Plan | null {
  if (V.laning) return null;
  let best: Plan | null = null;
  for (const s of ownStructures(e, b.side)) {
    const foes = V.theirs.filter((x) => dist(x, s.pos) < 1700);
    const threat = foes.length >= 2 || (foes.length >= 1 && (s.tier >= 3 || foes.some((x) => x.baronUntil > e.t)));
    if (!threat) continue;
    const near = V.mine.filter((u) => hpf(u) > 0.3 && !(channeling(u) && u.recallEnd !== undefined) && (u.i !== b.splitter || s.tier >= 4 || dist(u, s.pos) < 4000))
      .sort((a, c) => dist(a, s.pos) - dist(c, s.pos));
    const thP = V.theirs.reduce((a, x) => a + e.power(x) * (dist(x, s.pos) < 3000 ? 1 : 0.3), 0);
    // send the nearest defenders until (with the turret) they match the siege; inner structures get everyone
    const pool: Unit[] = [];
    let acc = 0;
    for (const u of near) {
      if (s.tier < 3 && pool.length >= 2 && acc * 1.3 > thP * 1.1) break;
      pool.push(u);
      acc += e.power(u) * presence(e, u, s.pos, 15);
    }
    if (!pool.length) continue;
    const ourP = powerAt(e, pool, s.pos, 15) * 1.3;
    const ratio = (ourP + 1) / (thP + 1);
    // outer towers are given up unless we can hold them (turret counted); inner ones are fought for harder
    if (ratio < (s.tier <= 2 ? 1 : s.tier === 3 ? 0.8 : 0.55) - b.P.fight * 0.5) continue;
    const id = `defend:${s.lane}:${s.tier}`;
    if ((b.cool[id] ?? 0) > e.t) continue;
    let score = s.value + clamp(ratio - 1, -1, 1) * 1.2 + 0.25;
    if (V.minute < b.P.avoidUntil) score += 0.2; // scaling teams hold under their towers
    if (!best || score > best.score) {
      const back = lanePoint(s.lane, laneU(s.lane, s.pos) + (b.side === 0 ? -0.016 : 0.016));
      best = mkPlan(e, "defend", id, score, pool.map((u) => u.i), {
        lane: s.lane, target: s.tier >= 5 ? s.pos : back, until: e.t + 12, expires: e.t + 50, emergency: true, engage: ratio >= 1.05, ratio,
      });
    }
  }
  return best;
}

function siegeCand(e: Engine, M: MacroState, b: Brain, V: View): Plan | null {
  if (V.laning) return null;
  const pool = V.mine.filter((u) => u.i !== b.splitter && hpf(u) > 0.45 && !(channeling(u) && u.recallEnd !== undefined));
  if (pool.length < 3 || V.mine.length < V.theirs.length) return null;
  const enemy = (1 - b.side) as SideN;
  const cx = pool.reduce((a, u) => a + u.x, 0) / pool.length, cy = pool.reduce((a, u) => a + u.y, 0) / pool.length;
  let best: Plan | null = null;
  for (const lane of LANES) {
    if (lane === b.splitLane && b.formation !== "five" && pool.length < 4) continue;
    if ((b.cool[`siege:${lane}`] ?? 0) > e.t) continue;
    const tp = e.siegeTarget(enemy, lane);
    if (!tp) continue;
    const ourP = powerAt(e, pool, tp, 25);
    const thP = powerAt(e, V.foes, tp, 25);
    const ratio = (ourP + 1) / (thP + 1);
    const tierT = e.frontierTurret(enemy, lane);
    const f = e.lanes[lane].front;
    const push = b.side === 0 ? f - 0.5 : 0.5 - f;
    let v = 0.15 + (ratio - b.P.siegeEdge) * 1.0 + V.numAdv * 0.25 + (V.baron ? 0.7 : 0) + (b.wonFight ? 0.4 : 0) + push * 0.6 +
      (lane === "mid" ? 0.1 : 0) - Math.hypot(tp.x - cx, tp.y - cy) / 25000 + (tierT ? (tierT.tier - 1) * 0.08 : 0.25);
    if (V.minute < b.P.avoidUntil && ratio < 1.5) v -= 0.4;
    // an open base (this lane's inhibitor is down, so the target is the nexus) is a push to end. LCK 2026 games end a
    // median 0.7 min after the first inhibitor and see 1.63 inhibitors per game (scripts/lck_late.py); the engine took
    // 5.8 min and 3.4 inhibitors: the team took an inhibitor, went back to farming formations (28 % of the next 2 min)
    // and broke it again after it respawned.
    const inh = e.inhibs.find((x) => x.side === enemy && x.lane === lane);
    const baseOpen = !tierT && !!inh && !inh.alive;
    if (baseOpen) v += BASE_OPEN_PUSH + V.numAdv * 0.15;
    // the enemy is on a pit we are not playing for: a turret on the far side of the map is the trade (the lane away
    // from that pit in full, mid for half)
    const far = b.trade ? (lane === "mid" ? 0.5 : (b.trade.pit === "dragon") === (lane === "top") ? 1 : 0) : 0;
    if (far) v += (OBJ_TUNE.tradeSiege + 0.35 * b.P.trade) * far;
    // sieges follow an edge: bodies up, baron, a won fight, or a clearly stronger group (an open base needs only an even one)
    if (V.numAdv < 1 && !V.baron && !b.wonFight && ratio < b.P.siegeEdge + 0.2 && !(baseOpen && ratio >= 1) && !far) continue;
    if (ratio < 0.95) continue;
    if (!best || v > best.score) {
      const u0 = laneU(lane, tp);
      const stand = lanePoint(lane, u0 + (b.side === 0 ? -0.017 : 0.017));
      // with the baron buff the siege is kept for the rest of the buff (LCK: games end a median 6.2 min after the
      // first baron; with a 20 s commitment the engine needed 8.8 min and took a second/third baron far too often)
      const buffLeft = V.baron ? Math.max(...pool.map((u) => u.baronUntil - e.t)) : 0;
      best = mkPlan(e, "siege", `siege:${lane}`, v + (V.baron ? 0.5 : 0), pool.map((u) => u.i), {
        lane, target: snap(stand), until: e.t + Math.max(baseOpen ? 40 : 20, Math.min(90, buffLeft)), expires: e.t + Math.max(70, buffLeft + 20),
        engage: ratio >= 1.05 - b.P.fight, ratio, trade: far ? b.trade!.k : undefined,
      });
    }
  }
  return best;
}

function resetCand(e: Engine, M: MacroState, b: Brain, V: View): Plan | null {
  if (V.laning) return null;
  const pool = V.mine.filter((u) => !inFountain(u) && dist(u, FOUNTAIN[b.side]) > 3500);
  if (pool.length < 3) return null;
  if (V.theirs.some((x) => pool.some((u) => dist(u, x) < 2800))) return null;
  const hp = pool.reduce((a, u) => a + hpf(u), 0) / pool.length;
  const spend = pool.reduce((a, u) => a + (u.gold - lastShop(u)), 0) / pool.length;
  const nx = nextSpawn(e);
  if (nx && nx.in < 40 && hp > 0.35) return null;
  let s = 0.1 + (0.65 - hp) * 1.6 + (spend - 1100) / 1400;
  if (nx && nx.in >= 60 && nx.in < 130) s += 0.25;
  if (V.baron) s -= 0.5;
  return mkPlan(e, "reset", "reset", s, pool.map((u) => u.i), { until: e.t + 12, expires: e.t + 25 });
}

function planValid(e: Engine, M: MacroState, b: Brain, V: View, p: Plan): string | null {
  if (e.t > p.expires) return "expired";
  if (p.kind === "take" || p.kind === "contest") {
    const k = p.obj!, o = e.obj[k];
    if (!o.alive && (p.kind === "contest" || p.phase !== "setup")) return "done";
    if (!o.alive && o.spawnAt === null) return "done";
    const pit = PIT_POS[PIT_OF[k]];
    const mem = p.members.map((i) => e.units[i]);
    const alive = mem.filter((u) => u.alive || u.respawnAt - e.t < 6).length;
    if (alive < Math.min(p.need, p.kind === "contest" ? 1 : p.need)) return "members";
    // nearly done, or (grubs) the one in hand is: finish it first
    const late = o.alive && (o.hp < o.maxHp * 0.3 || (k === "grubs" && grubInHand(e, b.side)));
    // nobody left to stop: the contest is over (a take of our own is takeCand's call). At the grubs whoever came
    // over stays on what is left of the camp when it is free for it (grubStays), which is how the grubs a team walked
    // away from are taken "right there" (LCK: in 52 % of the visits that stop with grubs alive); otherwise it goes
    // back to what it was doing and the grubs are left for later.
    if (p.kind === "contest" && e.t - p.since > 5 && !V.theirs.some((x) => dist(x, pit) < OBJ_TUNE.near + 400) && !(k === "grubs" && grubStays(e, b, p))) return "done";
    if (p.poach) {
      // in for a last hit, out when a second enemy turns up or it is getting hurt
      const jg = mem[0];
      if (V.theirs.filter((x) => dist(x, pit) < 1800).length > 1 || (jg.alive && hpf(jg) < 0.35)) return "spotted";
    } else if (p.solo) {
      const foes = V.theirs.filter((x) => dist(x, pit) < 2600);
      // one enemy (a jungler come to smite a grub) does not chase a healthy jungler off the grubs; more do, and it
      // leaves with the grubs it has
      const jg = mem[0];
      const stay = k === "grubs" && foes.length === 1 && jg.alive && hpf(jg) > 0.45 && e.power(foes[0]) <= e.power(jg) * GRUB_MACRO.stayEdge;
      if (!late && foes.length && !stay) return "spotted";
    } else if (!late && o.alive && p.kind === "contest") {
      // the candidate's yardstick with some slack (before: a flat 1.3, so a baron contest allowed at 0.65 of the
      // enemy's power was called off again in the next think)
      const ourW = powerAt(e, mem, pit, p.hz ?? 25);
      const thW = powerAt(e, V.foes, pit, p.hz ?? 25);
      const tilt = k === "grubs" && V.laning ? grubTilt(M, b.side) : 1;
      if (((ourW + 1) / (thW + 1)) * tilt < contestMin(e, b, k) - 0.12) return "outnumbered";
    } else if (!late && o.alive && p.phase === "commit") {
      // a committed take is called off by what stands at the pit: the enemies there against our members there.
      // (Before, every enemy that could arrive within 25 s was weighed against the plan's own three or four members
      // from the moment the plan started, so two even teams both dropped the same dragon as "outnumbered", 3.5 such
      // aborts a game. Whether to show up at all is takeCand's call on whole-team power, see concedeAt.)
      const a = atPit(e, b.side, pit, p.members);
      if (a.thN > 0 && a.thP > a.ourP * (OBJ_TUNE.backOff + b.P.fight)) return "outnumbered";
    }
    if (p.kind === "take" && p.phase === "gather" && p.prio && e.t - p.phaseAt > 40) return "slow";
  }
  if (p.kind === "defend") {
    if (!p.target) return "done";
    const foes = V.theirs.filter((x) => dist(x, p.target!) < 2300).length;
    if (!foes) return "done";
    const lane = p.lane!;
    if (!ownStructures(e, b.side).some((s) => s.lane === lane && dist(s.pos, p.target!) < 1500)) return "lost";
    const ourW = powerAt(e, p.members.map((i) => e.units[i]), p.target, 15) * 1.3;
    if (powerAt(e, V.foes, p.target, 15) > ourW * 1.6 && !p.id.endsWith(":5") && !p.id.endsWith(":4")) return "outnumbered";
  }
  if (p.kind === "siege") {
    if (V.mine.length < V.theirs.length) return "numbers";
    const mem = p.members.map((i) => e.units[i]).filter((u) => u.alive);
    if (mem.length < 3) return "members";
    if (mem.reduce((a, u) => a + hpf(u), 0) / mem.length < 0.38) return "hp";
    if (p.target && powerAt(e, V.foes, p.target, 25) > powerAt(e, mem, p.target, 25) * 1.3) return "outnumbered";
  }
  if (p.kind === "reset") {
    if (p.members.every((i) => !e.units[i].alive || inFountain(e.units[i]))) return "done";
  }
  return null;
}

function choosePlan(e: Engine, M: MacroState, b: Brain, V: View) {
  const cur = b.plan;
  const cands: Plan[] = [];
  const d = defendCand(e, M, b, V);
  if (d) cands.push(d);
  for (const k of OBJS) {
    const c = contestCand(e, M, b, V, k);
    if (c) cands.push(c);
    const t = takeCand(e, M, b, V, k);
    if (t) cands.push(t);
  }
  const s = siegeCand(e, M, b, V);
  if (s) cands.push(s);
  const r = resetCand(e, M, b, V);
  if (r) cands.push(r);
  for (const c of cands) c.score += (e.rng.next() - 0.5) * 0.08;

  let keep: Plan | null = null;
  let keepV = NONE_SCORE;
  if (cur.kind !== "none") {
    // a take whose own candidate now vetoes it (solo is off, baron no longer safe, lost the area, too few members)
    // ends before it commits; before, the veto only blocked starting a plan and the old one ran on until it expired
    const vetoed = cur.kind === "take" && cur.phase !== "commit" && !cands.some((c) => c.id === cur.id);
    const why = planValid(e, M, b, V, cur) ?? (vetoed ? (cur.obj && b.gaveUp[cur.obj] === e.t ? "concede" : "vetoed") : null);
    if (why) {
      if (why !== "done") {
        M.stats[b.side].aborts[`${cur.id}:${why}`] = (M.stats[b.side].aborts[`${cur.id}:${why}`] ?? 0) + 1;
        if (why === "concede") bump(M.stats[b.side].calls, `concede:${cur.obj}`);
        if (cur.obj) b.cool[cur.kind === "contest" ? `c:${cur.obj}` : cur.obj] = e.t + (why === "outnumbered" || why === "spotted" ? 25 : why === "concede" ? 20 : 12);
        if (cur.kind === "siege" || cur.kind === "defend") b.cool[cur.id] = e.t + 20;
      }
      log(M, e, b, `end ${cur.id}: ${why}`);
      // the same plan does not come straight back
      if (why !== "done") for (let i = cands.length - 1; i >= 0; i--) if (cands[i].id === cur.id) cands.splice(i, 1);
    } else {
      const fresh = cands.find((c) => c.id === cur.id);
      keep = cur;
      // without a fresh candidate the kept plan's score decays step by step (it used to stay flat forever)
      keepV = (fresh ? fresh.score : (cur.score -= 0.05)) + HYST;
      if (fresh) {
        cur.score = fresh.score;
        cur.engage = fresh.engage;
        cur.ratio = fresh.ratio;
        if (cur.prio && fresh.ratio < 0.88) cur.prio = false;
        else if (!cur.prio && fresh.ratio > 1.1) { cur.prio = true; if (cur.phase === "gather") cur.phaseAt = e.t; }
        if (cur.kind === "take" && cur.phase !== "commit" && fresh.solo !== cur.solo) {
          cur.solo = fresh.solo;
          log(M, e, b, `${cur.id} -> ${cur.solo ? "solo" : "group"}`);
          cur.members = fresh.members;
          cur.need = fresh.need;
          cur.h = fresh.h;
          cur.hitters = [];
          if (cur.solo) cur.prio = true;
        } else if (cur.kind === "take") {
          // fold in members that became available; keep hitters/phase
          for (const i of fresh.members) if (!cur.members.includes(i) && !cur.solo) cur.members.push(i);
        } else if (cur.kind === "contest" || cur.kind === "defend" || cur.kind === "siege") {
          for (const i of fresh.members) if (!cur.members.includes(i)) cur.members.push(i);
          if (cur.kind === "siege") cur.target = fresh.target;
          if (cur.kind === "contest") { cur.hitters = contestHitters(e, b, cur.obj!, cur.members); cur.hz = fresh.hz; }
          // a poach that the team now backs is a contest like any other
          if (cur.poach && !fresh.poach) { cur.poach = false; cur.need = fresh.need; cur.h = fresh.h; }
        }
      }
    }
  }
  const committed = keep !== null && e.t < keep.until;
  let best: Plan | null = keep;
  let bestV = keep ? keepV : NONE_SCORE;
  for (const c of cands) {
    if (keep && c.id === keep.id) continue;
    if (committed && !c.emergency) continue;
    const need = committed ? bestV + 0.35 : bestV;
    if (c.score > need) { best = c; bestV = c.score; }
  }
  // the side waiting back without priority commits by contesting: its contest of that objective is the next step of
  // the same plan, not a rival that has to beat it by the hysteresis margin
  if (keep && best === keep && keep.kind === "take" && !keep.prio && keep.phase !== "commit") {
    const c = cands.find((x) => x.kind === "contest" && x.obj === keep.obj && x.score > NONE_SCORE);
    if (c) best = c;
  }
  if (best && best !== keep) {
    // a contest of the objective we are already taking is the same fight; a won contest is finished as a take from the
    // pit (before, the fresh take restarted at "gather", walked the hitters out to the entrance and the dragon
    // regenerated 2 %/s until a new commit — or an "outnumbered" abort once the enemy respawned)
    // only from a contest that is still valid (keep === cur): an aborted one ("outnumbered") must not hand its commit on
    if (keep === cur && best.kind === "take" && cur.kind === "contest" && cur.obj === best.obj && cur.phase === "commit" && e.obj[best.obj!].alive) {
      best.phase = "commit";
      best.phaseAt = e.t;
      best.prio = true;
      best.hitters = cur.hitters.filter((i) => best!.members.includes(i));
    }
    b.plan = best;
    M.stats[b.side].plans[best.id] = (M.stats[b.side].plans[best.id] ?? 0) + 1;
    if (best.trade) bump(M.stats[b.side].calls, `trade:${best.kind === "siege" ? "turret" : best.obj}`);
    if (best.solo) M.stats[b.side].plans[`${best.id}:solo`] = (M.stats[b.side].plans[`${best.id}:solo`] ?? 0) + 1;
    if (best.poach) M.stats[b.side].plans[`${best.id}:poach`] = (M.stats[b.side].plans[`${best.id}:poach`] ?? 0) + 1;
    if (best.kind === "take") pickHitters(e, b, best);
    log(M, e, b, `plan ${best.id}${best.solo ? " solo" : ""} score ${best.score.toFixed(2)} ratio ${best.ratio.toFixed(2)} prio ${best.prio} members ${best.members.map((i) => e.units[i].role).join("/")} (was ${cur.id})`);
  } else if (!best) {
    if (cur.kind !== "none") log(M, e, b, `plan none (was ${cur.id})`);
    b.plan = noPlan(e.t);
  }
  if (b.plan.kind === "take") {
    pickHitters(e, b, b.plan);
    if (!b.plan.prio && b.plan.phase !== "commit") bump(M.stats[b.side].calls, `hover:${b.plan.obj}`);
  }
}

function pickHitters(e: Engine, b: Brain, p: Plan) {
  if (p.solo) { p.hitters = p.members.slice(0, 1); p.h = 1; p.need = 1; return; }
  const pit = PIT_POS[PIT_OF[p.obj!]];
  const live = p.members.map((i) => e.units[i]).filter((u) => u.alive || u.respawnAt - e.t < 5);
  // jungler first (smite), then carries, nearest first
  const rank = (u: Unit) => (u.role === "Jungle" ? -10 : u.role === "Bot" ? -2 : u.role === "Mid" ? -1.5 : u.role === "Top" ? -1 : 0) + dist(u, pit) / 3000;
  live.sort((a, c) => rank(a) - rank(c));
  const keep = p.hitters.filter((i) => live.some((u) => u.i === i));
  // the grubs can be left to the jungler alone (rollFor)
  const want = Math.max(p.obj === "grubs" ? 1 : 2, Math.min(p.h, live.length));
  for (const u of live) {
    if (keep.length >= want) break;
    if (!keep.includes(u.i)) keep.push(u.i);
  }
  p.hitters = keep;
}

/**
 * Steal runs (T09). When the enemy commits to a monster (walks in on it: a dragon dies about 11 s after the first
 * hit, so waiting for the hit leaves no time) a jungler close by with a Smite charge may go for it: once per monster,
 * more often when its team is at the pit anyway (hovering, or gathered for it) than when it gave the monster up, and
 * for the monsters that matter (bigObj). It waits outside Smite's reach and goes in at the last moment (stealJob);
 * the Smite fight itself is objsmite.ts. Not for the grubs (three small monsters, T07).
 */
function stealTick(e: Engine, M: MacroState, b: Brain) {
  const s = b.steal;
  if (s) {
    const u = e.units[s.by];
    if (!e.obj[s.k].alive || !u.alive || e.t > s.until || hpf(u) < 0.2 || !enemyCommitted(e, M, b.side, s.k)) {
      const why = !e.obj[s.k].alive ? "monster gone" : !u.alive ? "dead" : e.t > s.until ? "time" : hpf(u) < 0.2 ? "hurt" : "enemy left";
      const d = dist(u, PIT_POS[PIT_OF[s.k]]);
      bump(M.stats[b.side].calls, `stealend:${why}, ${d < STEAL_TUNE.range ? "in reach" : d < STEAL_TUNE.range + STEAL_TUNE.flashIn ? "a flash away" : d < 2000 ? "close" : "far"}`);
      log(M, e, b, `steal run over: ${why}, ${Math.round(d)} u from the pit${u.fightId ? ", in a fight" : ""}`);
      b.steal = null;
      // back to what it was doing (stealJob put it on the objective task)
      if (u.task === "obj") u.task = "jungle";
      u.objTarget = undefined;
      u.goal = null;
      u.path = [];
      M.units[u.i].spotFor = "";
    }
    return;
  }
  for (const k of OBJS) {
    const o = e.obj[k];
    if (k === "grubs" || !o.alive || !enemyCommitted(e, M, b.side, k)) continue;
    const key = o.spawnAt ?? -1;
    if (b.stealTried[k] === key) continue;
    const jg = e.units.find((u) => u.side === b.side && u.role === "Jungle")!;
    const pit = PIT_POS[PIT_OF[k]];
    if (!jg.alive || hpf(jg) < 0.4 || channeling(jg) || dist(jg, pit) > OBJ_TUNE.stealFrom || Summoners.smiteReadyIn(e, jg) > 3) continue;
    b.stealTried[k] = key;
    const p = b.plan;
    // its team is walking in on the monster already (a contest, or a take of its own: a race): the jungler is with it
    if ((p.kind === "contest" || p.kind === "take") && p.obj === k && p.phase === "commit") continue;
    const there = p.kind === "take" && p.obj === k;
    const chance = (there ? OBJ_TUNE.stealHover : OBJ_TUNE.stealLoose) + (bigObj(e, b.side, k) ? OBJ_TUNE.stealBig : 0);
    if (!e.rng.chance(clamp(chance * (0.6 + 0.4 * b.P.contest), 0, 0.95))) continue;
    b.steal = { k, by: jg.i, until: e.t + 40 };
    M.units[jg.i].spotFor = "";
    bump(M.stats[b.side].calls, `steal:${k}`);
    log(M, e, b, `steal run on ${k} by ${jg.name} (${Math.round((o.hp / o.maxHp) * 100)}% left)`);
    return;
  }
}

/** Whether u is on a steal run for monster k (objsmite.ts: it may flash into Smite's reach). */
export function stealing(e: Engine, u: Unit, k?: ObjKey): boolean {
  const s = st(e)?.brains[u.side].steal;
  return !!s && s.by === u.i && (k === undefined || s.k === k);
}

/** fight.ts: a steal runner that got caught in a fight keeps walking to its spot instead of fighting (it takes the
 *  hits; a stun still stops it). True when this moved the unit. */
export function stealWalk(e: Engine, u: Unit): boolean {
  const M = st(e);
  if (!M) return false;
  const b = M.brains[u.side];
  if (!b.steal || b.steal.by !== u.i) return false;
  stealJob(e, b, u, M.units[u.i]);
  return true;
}

/** Open ground on a ring around a pit: the point that is nearest by foot for u, scored down for enemies standing near. */
function ringSpot(e: Engine, u: Unit, pit: Vec, r: number, lo: number, hi: number): Vec | null {
  let best: Vec | null = null, bv = Infinity;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const q = snap({ x: pit.x + Math.cos(a) * r, y: pit.y + Math.sin(a) * r });
    const d = dist(q, pit);
    if (d < lo || d > hi) continue;
    let len = 0, prev: Vec = u;
    for (const w of Nav.findPath(u, q)) { len += dist(prev, w); prev = w; }
    for (const x of e.units) if (x.alive && x.side !== u.side) len += Math.max(0, 1400 - dist(x, q)) * 4;
    if (len < bv) { bv = len; best = q; }
  }
  return best;
}

/**
 * The steal runner. It waits just outside Smite's reach, on open ground away from the enemy (often behind the pit
 * wall), and goes in when the monster is about to drop into its Smite: when the time left at the current damage is
 * what the walk in takes (with Flash up it can leave it later: objsmite.ts flashes it in). Walking in at once, it
 * was caught and killed at the pit mouth before the monster was low (every run in the first 60 games).
 */
function stealJob(e: Engine, b: Brain, u: Unit, m: UMem) {
  const k = b.steal!.k;
  const pit = PIT_POS[PIT_OF[k]];
  u.task = "obj";
  u.objTarget = k;
  // where it will Smite from: open ground inside the reach (counted from the monster's centre), nearest by foot
  const tag = `steal:${k}`;
  if (!m.spot || m.spotFor !== tag || (e.t - m.spotAt > 6 && dist(u, pit) > STEAL_TUNE.range + 700)) {
    m.spot = ringSpot(e, u, pit, STEAL_TUNE.range - 180, 0, STEAL_TUNE.range - 120) ?? snap(toward(pit, u, STEAL_TUNE.range - 180));
    m.spotFor = tag;
    m.spotAt = e.t;
  }
  const toSpot = dist(u, m.spot);
  const flash = Summoners.isReady(e, u, "flash");
  // it waits on its way in, this far short of that spot: with Flash up as far out as the Flash still reaches from
  // (objsmite.ts flashes it in), without it a short walk away
  const out = flash ? STEAL_TUNE.flashIn + 40 : STEAL_TUNE.walkIn;
  const left = secondsTo(e, k, Summoners.smiteDamage(e, u));
  const dive = dist(u, pit) < STEAL_TUNE.range - 40 || (!flash && left <= toSpot / e.speed(u) + 0.5);
  if (dive || toSpot > out + 40) go(e, u, m.spot, 40);
}

/** Per-step phase changes (gather -> commit as soon as the group is there). */
function planTick(e: Engine, M: MacroState, b: Brain) {
  const p = b.plan;
  if (p.kind !== "take" && p.kind !== "contest") return;
  const o = e.obj[p.obj!];
  if (p.phase === "setup" && o.alive) { p.phase = "gather"; p.phaseAt = e.t; p.until = Math.max(p.until, e.t + 15); }
  if (p.phase !== "gather") return;
  const pk = PIT_OF[p.obj!], pit = PIT_POS[pk];
  const R = Math.max(1800, dist(M.geo.stage[b.side][pk], pit) + 700);
  let n = 0;
  for (const i of p.members) {
    const u = e.units[i];
    if (u.alive && !channeling(u) && dist(u, pit) < R) n++;
  }
  let go = n >= p.need && (p.prio || p.kind === "contest");
  if (p.kind === "contest") {
    let dps = 0;
    for (const x of e.units) if (x.side !== b.side && x.alive && !x.fightId && dist(x, pit) < 650) dps += e.aaDps(x) * 1.2 + 30;
    const ttk = o.hp / Math.max(60, dps);
    go = go || e.t - p.phaseAt > 5 || ttk < 8;
  } else if (go && !p.solo) {
    // standoff: with enemies at the pit that match us, the group holds its entrance first instead of walking onto the
    // monster in front of them. It starts it at once with a clear edge, after its standoff time at even odds, and
    // when the enemy starts it first (then this is the answer to their take, on the contest yardstick).
    const a = atPit(e, b.side, pit, p.members);
    if (a.thN > 0 && a.edge < OBJ_TUNE.standoffEdge) {
      p.standoff ??= OBJ_TUNE.standoffMin + e.rng.next() * (OBJ_TUNE.standoffMax - OBJ_TUNE.standoffMin);
      // counted from the moment the two groups first face each other, not from the start of the gathering (a group
      // that needed 15 s to gather would start the monster the moment it was complete)
      p.standAt ??= e.t;
      go = (e.t - p.standAt > p.standoff && a.edge >= OBJ_TUNE.standoffGo) || (enemyOn(e, M, b.side, p.obj!) && a.edge >= contestMin(e, b, p.obj!));
      if (go) bump(M.stats[b.side].calls, `standoff:${p.obj}`);
    } else bump(M.stats[b.side].calls, `start:${p.obj}`);
  }
  if (go) { p.phase = "commit"; p.phaseAt = e.t; }
}

// ---------- formation & jobs ----------
function chooseFormation(e: Engine, M: MacroState, b: Brain, V: View) {
  if (V.laning) { b.formation = "lanes"; return; }
  // an enemy inhibitor down: stay grouped to end instead of drifting back to side lanes (see BASE_OPEN_PUSH)
  const baseOpen = e.inhibs.some((x) => x.side !== b.side && !x.alive);
  if (b.formation !== "lanes" && e.t < b.formUntil && !(baseOpen && b.formation !== "five")) return;
  b.formUntil = e.t + 35 + e.rng.next() * 25;
  if (baseOpen) {
    b.formation = "five";
    M.stats[b.side].formations[`${b.strat}:five`] = (M.stats[b.side].formations[`${b.strat}:five`] ?? 0) + 1;
    return;
  }
  const P = b.P, m = V.minute;
  let f: Formation;
  if (m < P.groupFrom) f = "spread";
  else {
    const sh = lckShape(m);
    const pFive = m < P.fiveFrom ? 0 : clamp(sh.grouped + P.fiveBias, 0, 0.92);
    const r = e.rng.next();
    if (r < pFive) f = "five";
    else if ((P.sideLanes >= 2 || (P.tri > 0 && m > 22 && e.rng.next() < P.tri)) && b.side2 >= 0 && e.units[b.side2].alive) f = "1-3-1";
    else if (P.sideLanes >= 1) f = r < pFive + P.oneFour * (1 - pFive) ? "1-4" : "spread";
    else f = "five";
  }
  b.formation = f;
  M.stats[b.side].formations[`${b.strat}:${f}`] = (M.stats[b.side].formations[`${b.strat}:${f}`] ?? 0) + 1;
}

/** Side lane for the split pusher: away from where the team is looking. */
function chooseSplitLane(e: Engine, b: Brain, V: View): LaneId {
  const p = b.plan;
  let focus: Pit | null = null;
  if (p.obj) focus = PIT_OF[p.obj];
  else if (p.kind === "siege" || p.kind === "defend") return p.lane === "top" ? "bot" : p.lane === "bot" ? "top" : b.splitLane;
  else {
    const nx = nextSpawn(e);
    if (nx && nx.in < 120) focus = PIT_OF[nx.k];
  }
  if (focus) return focus === "dragon" ? "top" : "bot";
  return b.splitLane;
}

function setJob(m: UMem, u: Unit, job: Job, lane?: LaneId, buddy?: number) {
  if (m.job !== job || m.lane !== lane) {
    m.spot = undefined;
    m.spotFor = "";
    if (job === "old" && (u.task === "obj" || u.task === "siege" || u.task === "group")) {
      u.task = u.role === "Jungle" ? "jungle" : "lane";
      u.objTarget = undefined;
      u.goal = null;
      u.path = [];
    }
  }
  m.job = job;
  m.lane = lane;
  m.buddy = buddy;
}

function assign(e: Engine, M: MacroState, b: Brain, V: View) {
  const p = b.plan;
  const inPlan = new Set(p.members);
  b.splitLane = chooseSplitLane(e, b, V);
  const free: Unit[] = [];
  for (const u of V.team) {
    const m = M.units[u.i];
    if (!inPlan.has(u.i)) { free.push(u); continue; }
    switch (p.kind) {
      case "take": setJob(m, u, p.hitters.includes(u.i) ? "obj" : "guard"); break;
      case "contest": setJob(m, u, "obj"); break;
      case "siege": setJob(m, u, "group"); break;
      case "defend": setJob(m, u, "defend"); break;
      case "reset": setJob(m, u, "recall"); break;
      default: free.push(u);
    }
  }
  if (p.kind === "siege") setGroup(e, b, p.id, p.members, siegeDest(e, b, p), Math.min(3, p.members.length));
  // everybody else follows the formation
  if (V.laning) {
    for (const u of free) setJob(M.units[u.i], u, u.role === "Jungle" ? "jungle" : "old");
    return;
  }
  const f = b.formation;
  const groupers: number[] = [];
  const used = new Set<LaneId>();
  const laners: Unit[] = [];
  // a jungler outside the team's plan farms camps that are up rather than walking with the group (LCK junglers keep
  // farming between objectives: 6.2 jungle CS a minute from 20 to 30 min, the engine's grouped jungler had 1.9)
  // (not when an objective spawns within 45 s: the jungler sets up for it with the team; a spawn time already past
  // without a spawn is the herald held back while baron is up, not an upcoming one)
  const soon = OBJS.some((k) => {
    const at = e.obj[k].spawnAt;
    return !e.obj[k].alive && at !== null && at >= e.t && at - e.t < 45;
  });
  const farmJg = f !== "spread" && !soon &&
    e.camps.some((c) => c.alive && c.side === b.side && c.kind !== "scuttle");
  for (const u of free) {
    const m = M.units[u.i];
    if (farmJg && u.role === "Jungle") { setJob(m, u, "jungle"); continue; }
    if (f === "spread") {
      if (u.role === "Jungle") setJob(m, u, "jungle");
      else if (u.role === "Support") {
        const bot = V.team.find((x) => x.role === "Bot")!;
        const jg = V.team.find((x) => x.role === "Jungle")!;
        const buddy = free.includes(bot) && bot.alive ? bot : jg;
        setJob(m, u, "escort", undefined, buddy.i);
      } else if (u.i === b.splitter) { setJob(m, u, "split", b.splitLane); used.add(b.splitLane); }
      else laners.push(u);
    } else if ((f === "1-4" || f === "1-3-1") && u.i === b.splitter) { setJob(m, u, "split", b.splitLane); used.add(b.splitLane); }
    else if (f === "1-3-1" && u.i === b.side2) {
      const other: LaneId = b.splitLane === "top" ? "bot" : "top";
      setJob(m, u, "split", other);
      used.add(other);
    } else groupers.push(u.i);
  }
  for (const u of laners) {
    const pref = ROLE_LANE[u.role] ?? "mid";
    const lane = !used.has(pref) ? pref : (["mid", "top", "bot"] as LaneId[]).find((l) => !used.has(l)) ?? pref;
    used.add(lane);
    setJob(M.units[u.i], u, "lane", lane);
  }
  // answer a lone enemy pushing a side lane deep (match the split pusher)
  if (groupers.length >= 2) {
    for (const lane of ["top", "bot"] as LaneId[]) {
      if (used.has(lane)) continue;
      const s = ownStructures(e, b.side).find((x) => x.lane === lane);
      if (!s) continue;
      const pusher = V.theirs.find((x) => dist(x, s.pos) < 2600);
      if (!pusher || V.theirs.filter((x) => dist(x, s.pos) < 3500).length > 1) continue;
      const cand = groupers.map((i) => e.units[i]).filter((u) => u.alive && u.role !== "Support" && e.power(u) > e.power(pusher) * 0.8)
        .sort((a, c) => dist(a, s.pos) - dist(c, s.pos))[0];
      if (!cand) continue;
      groupers.splice(groupers.indexOf(cand.i), 1);
      setJob(M.units[cand.i], cand, "lane", lane);
      used.add(lane);
    }
  }
  for (const i of groupers) setJob(M.units[i], e.units[i], "group");
  if (p.kind !== "siege" && groupers.length) {
    const { key, dest } = formationDest(e, M, b, V);
    setGroup(e, b, key, groupers, dest, Math.min(3, groupers.length));
  }
}

function formationDest(e: Engine, M: MacroState, b: Brain, V: View): { key: string; dest: Vec } {
  // a stronger enemy group close to ours: back off together toward our nearest turret (unless we want the fight)
  const g = b.group;
  if (g.key.startsWith("form") && g.members.length) {
    const near = g.members.map((i) => e.units[i]).filter((u) => u.alive && dist(u, g) < 1700);
    const ourP = near.reduce((a, u) => a + e.power(u), 0);
    const threat = V.theirs.filter((x) => dist(x, g) < 2800);
    const thP = threat.reduce((a, x) => a + e.power(x), 0);
    const want = 1.15 - b.P.fight - (V.minute < b.P.avoidUntil ? -0.25 : 0);
    if (thP > 0 && thP > ourP * want) {
      // fall back to a turret that is away from them (not the one they are walking to)
      const c = { x: threat.reduce((a, x) => a + x.x, 0) / threat.length, y: threat.reduce((a, x) => a + x.y, 0) / threat.length };
      const home = e.turrets.filter((t) => t.alive && t.side === b.side).map((t) => t.pos)
        .filter((q) => dist(q, c) > dist(g, c) + 600 && !V.theirs.some((x) => dist(x, q) < 2200))
        .sort((p, q) => dist(p, g) - dist(q, g))[0] ?? FOUNTAIN[b.side];
      return { key: g.key, dest: home };
    }
  }
  const nx = nextSpawn(e);
  if (nx && nx.in < 100) {
    const pk = PIT_OF[nx.k];
    return { key: `form:${pk}`, dest: M.geo.stage[b.side][pk] };
  }
  // hold a little behind the mid wave (still pushing it) rather than on top of it
  const f = e.lanes.mid.front;
  return { key: "form:mid", dest: turretSafe(e, b.side, snap(lanePoint("mid", f + (b.side === 0 ? -0.055 : 0.055)))) };
}

// ---------- groups ----------
function setGroup(e: Engine, b: Brain, key: string, members: number[], dest: Vec, quorum: number) {
  const g = b.group;
  if (g.key === key && g.members.length) {
    g.members = members;
    g.quorum = quorum;
    if (dist(g.dest, dest) > 150) { g.dest = dest; g.pathFor = null; }
    return;
  }
  const live = members.map((i) => e.units[i]).filter((u) => u.alive && !inFountain(u));
  let start: Vec = FOUNTAIN[b.side];
  if (live.length) {
    // the member the others are closest to (biased toward the destination): a real, walkable spot
    let bv = Infinity;
    for (const u of live) {
      const v = live.reduce((a, x) => a + dist(u, x), 0) + dist(u, dest) * 0.6;
      if (v < bv) { bv = v; start = u; }
    }
  }
  b.group = { key, x: start.x, y: start.y, path: [], dest, pathFor: null, members, quorum };
}

function groupTick(e: Engine, b: Brain) {
  const g = b.group;
  if (!g.members.length || !g.key) return;
  let live = 0, near = 0, spd = Infinity;
  for (const i of g.members) {
    const u = e.units[i];
    if (!u.alive || channeling(u)) continue;
    live++;
    if (dist(u, g) < 1300) { near++; spd = Math.min(spd, e.speed(u)); }
  }
  if (!live || near < Math.min(g.quorum, live)) return;
  if (dist(g, g.dest) < 80) return;
  if (!g.pathFor) {
    // the group's anchor walks around enemy turrets too (its members follow it)
    g.path = ENGINE_FLAGS.nav ? e.aroundTurret(b.side, g, Nav.findPath(g, g.dest)) : [g.dest];
    g.pathFor = g.dest;
  }
  let budget = spd * 0.9 * DT;
  while (budget > 0 && g.path.length) {
    const wp = g.path[0];
    const d = dist(g, wp);
    if (d <= budget) { g.x = wp.x; g.y = wp.y; budget -= d; g.path.shift(); }
    else { g.x += ((wp.x - g.x) / d) * budget; g.y += ((wp.y - g.y) / d) * budget; budget = 0; }
  }
}

function groupSpot(e: Engine, b: Brain, u: Unit): Vec {
  const g = b.group;
  let fx = g.dest.x - g.x, fy = g.dest.y - g.y;
  let L = Math.hypot(fx, fy);
  if (L < 250) {
    // at the destination: face the enemy base
    const n = NEXUS[1 - b.side];
    fx = n.x - g.x; fy = n.y - g.y; L = Math.hypot(fx, fy) || 1;
  }
  fx /= L; fy /= L;
  const [f0, lat] = FORM[u.role];
  const fwd = f0 + (u.champ.ranged ? -60 : 40);
  return { x: g.x + fx * fwd - fy * lat, y: g.y + fy * fwd + fx * lat };
}

/** Keep a standing spot out of enemy turret range unless our wave is on that turret (engine.waveAt): a turret with
 *  no minions to shoot now shoots champions standing in range, in a fight or not (fight.ts turretShots). */
function turretSafe(e: Engine, side: SideN, p: Vec): Vec {
  let q = p;
  // a spot pushed out of one turret's range can land in the next one's (the nexus twins are 650 u apart, mid tier 2
  // and 3 about 1,750): look again, and if it keeps bouncing between two, step back toward our own base
  for (let pass = 0; pass < 4; pass++) {
    const t = e.exposedAt(side, q, 860);
    if (!t) return q;
    const from = pass === 3 || dist(t.pos, q) < 1 ? FOUNTAIN[side] : q;
    q = snap(toward(t.pos, from, 900));
  }
  return q;
}

/** Where a sieging group stands: on the structure once our wave is on it, until then with the wave, pushing it in
 *  (it used to stand under the turret and hit it with no minions anywhere near). */
function siegeDest(e: Engine, b: Brain, p: Plan): Vec {
  const tgt = p.target!;
  if (!p.lane || !e.exposedAt(b.side, tgt, 900)) return tgt;
  const f = e.lanes[p.lane].front;
  return turretSafe(e, b.side, snap(lanePoint(p.lane, f + (b.side === 0 ? -SIEGE_WAVE_BACK : SIEGE_WAVE_BACK))));
}

/** After laning, the weaker of two enemies holding the same wave keeps SIM_TUNE.laneGap away from the other instead
 *  of standing next to it (two split pushers stood 300 u apart for a minute). The stronger one holds the wave. */
function keepGap(e: Engine, u: Unit, lane: LaneId, p: Vec): Vec {
  let foe: Unit | null = null, nd = SIM_TUNE.laneGap;
  for (const x of e.units) {
    if (!x.alive || x.side === u.side || x.fightId || x.task !== "lane") continue;
    const d = dist(x, p);
    if (d < nd) { nd = d; foe = x; }
  }
  if (!foe) return p;
  // under our own turret the defender is the one who gives ground (it stood on top of the champion hitting the turret)
  const home = e.turrets.some((t) => t.alive && t.side === u.side && dist(t.pos, p) < 900);
  const pu = e.power(u), pf = e.power(foe);
  if (!home && (pu > pf || (pu === pf && u.i < foe.i))) return p;
  const dir = u.side === 0 ? -1 : 1;
  const u0 = laneU(lane, p);
  const per = dist(lanePoint(lane, u0), lanePoint(lane, u0 + dir * 0.02)) / 0.02 || 20000;
  const want = laneU(lane, foe) + (dir * (SIM_TUNE.laneGap + 40)) / per;
  return lanePoint(lane, dir < 0 ? Math.min(u0, want) : Math.max(u0, want));
}

// ---------- unit behaviour ----------
function go(e: Engine, u: Unit, g: Vec, tol = 90) {
  if (dist(u, g) <= tol) return;
  if (!u.goal || Math.abs(u.goal.x - g.x) > 60 || Math.abs(u.goal.y - g.y) > 60) e.setGoal(u, g);
  else if (!u.path.length) { u.goal = null; e.setGoal(u, g); }
  e.moveStep(u, DT);
}

function startRecall(e: Engine, u: Unit) {
  if (inFountain(u)) return;
  u.task = "recall";
  u.objTarget = undefined;
  setShop(u);
}

function wantRecall(e: Engine, b: Brain, u: Unit, m: UMem): boolean {
  const p = b.plan;
  const busy = (m.job === "obj" || m.job === "guard") && p.phase === "commit";
  const f = hpf(u);
  if (f < 0.28) {
    if (busy && p.obj && e.obj[p.obj].alive && e.obj[p.obj].hp < e.obj[p.obj].maxHp * 0.3 && f > 0.15) return false;
    return !inFountain(u);
  }
  if (busy || m.job === "defend" || (m.job === "group" && p.kind === "siege")) return false;
  // hurt and nothing urgent: reset rather than walk back into the next fight
  if (f < 0.45 && !e.laningPhase() && !e.units.some((x) => x.alive && x.side !== u.side && dist(x, u) < 2500)) return e.rng.chance(0.03);
  // gold in the pocket: go home and buy like real players do (items.ts shopUrge: next item affordable, or the gold
  // LCK players usually carry back); without items.json the old 1500-gold rule
  const urge = Items.shopUrge(e, u);
  const rich = urge !== null ? urge > 0 : u.gold - lastShop(u) > 1500;
  if (!rich || inFountain(u)) return false;
  const nx = nextSpawn(e);
  if (nx && nx.in < 45 && dist(u, PIT_POS[PIT_OF[nx.k]]) < 7000) return false;
  return e.rng.chance(urge !== null ? Items.recallChance(urge) : 0.004);
}

/** Outnumbered nearby: fall back toward a turret behind us. */
function danger(e: Engine, b: Brain, u: Unit, m: UMem): boolean {
  if (e.t < 120 || u.task === "gank") return false;
  if (e.t < m.retreatUntil && m.retreatTo) {
    go(e, u, m.retreatTo, 120);
    return true;
  }
  const p = b.plan;
  let foes = 0, friends = 1, fx = 0, fy = 0, foeP = 0;
  const R = m.job === "split" ? 3000 : 2300;
  for (const o of e.units) {
    if (!o.alive || o === u) continue;
    const d = dist(o, u);
    if (d > R) continue;
    if (o.side === u.side) { if (d < 2300) friends++; }
    else { foes++; fx += o.x; fy += o.y; foeP += e.power(o); }
  }
  if (!foes) return false;
  let flee = foes >= friends + 2 || (foes >= 3 && foes > friends && hpf(u) < 0.6);
  if ((m.job === "obj" || m.job === "guard") && p.engage && p.phase === "commit") flee = foes >= friends + 3;
  if (m.job === "defend") flee = foes >= friends + 3 || (foes > friends && hpf(u) < 0.4);
  if (m.job === "split" && friends === 1) flee = foes >= 2 || foeP > e.power(u) * 1.25;
  if (!flee) return false;
  const c = { x: fx / foes, y: fy / foes };
  const safe = e.turrets.filter((t) => t.alive && t.side === u.side).map((t) => t.pos)
    .filter((q) => dist(q, c) > dist(u, c) + 300).sort((a, q) => dist(a, u) - dist(q, u))[0] ?? FOUNTAIN[u.side];
  m.retreatTo = safe;
  m.retreatUntil = e.t + 4;
  go(e, u, safe, 120);
  return true;
}

/** Walk to a fight our side is in, close by. */
function joinFight(e: Engine, u: Unit, R = 1400): boolean {
  if (hpf(u) < 0.4 || !e.fights.size) return false;
  for (const [id, f] of e.fights) {
    if ((f as { trade?: boolean }).trade) continue;
    if (dist(u, f) > R) continue;
    if (!e.units.some((x) => x.fightId === id && x.side === u.side && x.alive)) continue;
    go(e, u, f, 60);
    return true;
  }
  return false;
}

function laneJob(e: Engine, u: Unit, m: UMem, lane: LaneId) {
  const front = e.laneFrontPos(lane);
  // a new spot every 6 s, when the wave has moved on, or at once when the wave left the turret this spot is under
  if (!m.spot || m.spotFor !== `lane:${lane}` || e.t - m.spotAt > 6 || dist(m.spot, front) > 1100 || (!e.laningPhase() && e.exposedAt(u.side, m.spot, 860))) {
    m.spot = e.laningPhase() ? e.laneStand(u, lane) : turretSafe(e, u.side, keepGap(e, u, lane, e.laneStand(u, lane)));
    m.spotFor = `lane:${lane}`;
    m.spotAt = e.t;
  }
  u.task = "lane";
  go(e, u, m.spot, 70);
}

function splitJob(e: Engine, u: Unit, m: UMem, lane: LaneId) {
  const enemy = (1 - u.side) as SideN;
  const f = e.lanes[lane].front;
  const t = e.frontierTurret(enemy, lane);
  let spot: Vec;
  if (t && e.waveAt(t)) spot = lanePoint(lane, t.u + (u.side === 0 ? -0.016 : 0.016));
  else if (!t) spot = turretSafe(e, u.side, lanePoint(lane, laneU(lane, e.siegeTarget(enemy, lane) ?? lanePoint(lane, f)) + (u.side === 0 ? -0.016 : 0.016)));
  else spot = keepGap(e, u, lane, lanePoint(lane, f + (u.side === 0 ? -0.006 : 0.006)));
  u.task = "lane";
  go(e, u, spot, 80);
}

function jungleJob(e: Engine, M: MacroState, b: Brain, u: Unit, m: UMem, laning: boolean) {
  const ext = u as Unit & { gankLane?: LaneId; gankThere?: number };
  // invade: an enemy camp while their jungler is on the far side
  if (m.invade !== undefined) {
    const c = e.camps[m.invade];
    const ej = e.units.find((x) => x.side !== u.side && x.role === "Jungle")!;
    if (!c.alive || (ej.alive && dist(ej, c.pos) < 3000) || hpf(u) < 0.45) m.invade = undefined;
    else {
      u.task = "jungle";
      if (dist(u, c.pos) > 250) { go(e, u, c.pos, 200); return; }
      clearCamp(e, u, c.id);
      return;
    }
  }
  if (laning && e.t > 195 && u.task !== "gank") {
    if (b.P.gank > 0 && e.gankReady(u) && e.rng.chance((b.P.gank / 60) * DT)) {
      const lane = e.pickGankLane(u);
      if (lane) { u.task = "gank"; ext.gankLane = lane; ext.gankThere = undefined; u.taskUntil = e.t + 28; }
    } else if (b.P.invade > 0 && e.rng.chance(b.P.invade * DT / 2.5)) {
      const ej = e.units.find((x) => x.side !== u.side && x.role === "Jungle")!;
      const camp = e.camps.filter((c) => c.side !== u.side && c.kind !== "scuttle" && c.alive && dist(u, c.pos) < 4500 && (!ej.alive || dist(ej, c.pos) > 6000))
        .sort((a, c) => dist(u, a.pos) - dist(u, c.pos))[0];
      if (camp) { m.invade = camp.id; return; }
    }
  }
  if (!laning) {
    const anyCamp = e.camps.some((c) => c.alive && ((c.side === u.side && c.kind !== "scuttle") || (c.kind === "scuttle" && dist(u, c.pos) < 4500)));
    if (!anyCamp && u.task !== "gank") {
      // nothing up: shadow the group or wait near the next objective
      const g = b.group;
      const nx = nextSpawn(e);
      const target = g.members.length && g.key ? { x: g.x, y: g.y } : nx ? M.geo.stage[u.side][PIT_OF[nx.k]] : e.laneFrontPos("mid");
      if (!m.spot || m.spotFor !== "jg-idle" || e.t - m.spotAt > 8 || e.exposedAt(u.side, m.spot, 860)) {
        m.spot = turretSafe(e, u.side, scatter(e, e.data.heatmap?.counts.Jungle?.[String(clamp(Math.round(e.minute()), 1, 45))], u.side, target, 0, 1400));
        m.spotFor = "jg-idle";
        m.spotAt = e.t;
      }
      u.task = "jungle";
      go(e, u, m.spot, 120);
      return;
    }
  }
  const wasGank = u.task === "gank";
  e.jungleTick(u);
  if (!wasGank && u.task === "gank" && b.P.gank < 0 && e.rng.chance(-b.P.gank)) {
    u.task = "jungle";
    ext.gankLane = undefined;
  }
}

function clearCamp(e: Engine, u: Unit, id: number) {
  e.hitCamp(u, e.camps[id]);
}

function escortJob(e: Engine, b: Brain, u: Unit, m: UMem) {
  const bud = m.buddy !== undefined ? e.units[m.buddy] : undefined;
  let anchor: Vec;
  if (bud && bud.alive && !inFountain(bud) && !channeling(bud)) anchor = bud;
  else {
    const g = b.group;
    anchor = g.members.length && g.key ? g : e.laneFrontPos("mid");
  }
  if (!m.spot || m.spotFor !== "escort" || e.t - m.spotAt > 3 || dist(m.spot, anchor) > 700 || (!e.laningPhase() && e.exposedAt(u.side, m.spot, 860))) {
    const n = NEXUS[1 - u.side];
    const f = toward(anchor, n, 260);
    m.spot = turretSafe(e, u.side, snap({ x: f.x + (e.rng.next() - 0.5) * 300, y: f.y + (e.rng.next() - 0.5) * 300 }));
    m.spotFor = "escort";
    m.spotAt = e.t;
  }
  u.task = "roam";
  go(e, u, m.spot, 90);
}

function objJob(e: Engine, M: MacroState, b: Brain, u: Unit, m: UMem, guard: boolean) {
  const p = b.plan;
  const k = p.obj!;
  const pk = PIT_OF[k], pit = PIT_POS[pk];
  // only the ones walking in on the objective count as "obj" (the old combat reads the task as aggression)
  u.task = p.phase === "commit" && (!guard || p.kind === "contest") ? "obj" : "group";
  u.objTarget = k;
  const tag = `${p.id}:${p.phase}:${p.prio ? 1 : 0}`;
  if (p.phase === "setup") {
    const o = e.obj[k];
    const spawnIn = (o.spawnAt ?? e.t) - e.t;
    const lane = ROLE_LANE[u.role];
    const serves = pk === "dragon" ? lane === "bot" || lane === "mid" : lane === "top" || lane === "mid";
    const f = lane ? e.lanes[lane].front : 0.5;
    const pushed = u.side === 0 ? f > 0.56 : f < 0.44;
    if (lane && u.role !== "Support" && serves && spawnIn > 28 && !pushed) { laneJob(e, u, m, lane); u.task = "group"; return; }
  }
  if (p.phase !== "commit") {
    // re-pick the spot inside the zone now and then (warding / shuffling rather than freezing)
    if (!m.spot || m.spotFor !== tag || (p.phase === "setup" && e.t - m.spotAt > 9 + (u.i % 4) * 2)) {
      m.spotAt = e.t;
      const stage = p.prio ? M.geo.stage[u.side][pk] : M.geo.back[u.side][pk];
      if (p.phase === "gather" && p.prio && dist(u, pit) < 1750 && dist(u, pit) > 800) m.spot = { x: u.x, y: u.y };
      else m.spot = scatter(e, LCK_STATS?.zones?.[ZONE_OF[pk]]?.[u.role], u.side, stage, 0, p.prio ? 650 : 700,
        (q) => dist(q, pit) > (p.prio ? 1050 : OBJ_TUNE.hover - 400) && ownHalf(u.side, q, p.prio ? 300 : -300));
      m.spotFor = tag;
    }
    if (!joinFight(e, u)) go(e, u, m.spot, 120);
    return;
  }
  // commit
  if (joinFight(e, u, 1500)) return;
  if (!guard) {
    const slots = M.geo.slots[pk];
    const idx = p.hitters.indexOf(u.i);
    const s = slots[(idx >= 0 ? idx : SLOT_ROLE[u.role]) % slots.length];
    go(e, u, s, 60);
    return;
  }
  if (!m.spot || m.spotFor !== tag || e.t - m.spotAt > 4 + (u.i % 3)) {
    m.spotAt = e.t;
    // guards stand between the pit and the enemy (zoning it off the take, the jungler off a steal): of the fan points
    // of both sides, all on open ground ~950 u out, the three nearest to the enemies around the pit. With nobody
    // near, our own side as before.
    let gs = M.geo.guard[u.side][pk];
    let fx = 0, fy = 0, fn = 0;
    for (const x of e.units) if (x.alive && x.side !== u.side && dist(x, pit) < 3800) { fx += x.x; fy += x.y; fn++; }
    if (fn) {
      const c = { x: fx / fn, y: fy / fn };
      gs = [...M.geo.guard[0][pk], ...M.geo.guard[1][pk]].sort((p1, p2) => dist(p1, c) - dist(p2, c)).slice(0, 3);
    }
    const base = gs[SLOT_ROLE[u.role] % gs.length];
    let q = snap({ x: base.x + (e.rng.next() - 0.5) * 300, y: base.y + (e.rng.next() - 0.5) * 300 });
    if (dist(q, pit) < OBJ_TUNE.guard - 170) q = snap(toward(pit, q, OBJ_TUNE.guard));
    m.spot = q;
    m.spotFor = tag;
  }
  go(e, u, m.spot, 100);
}

function defendJob(e: Engine, b: Brain, u: Unit, m: UMem) {
  const p = b.plan;
  const tgt = p.target ?? e.nearestOwnTurret(u)!;
  if (joinFight(e, u, 1800)) { u.task = "group"; return; }
  if (!m.spot || m.spotFor !== `${p.id}:def` || e.t - m.spotAt > 8) {
    m.spotAt = e.t;
    m.spot = snap({ x: tgt.x + (e.rng.next() - 0.5) * 420, y: tgt.y + (e.rng.next() - 0.5) * 420 });
    m.spotFor = `${p.id}:def`;
  }
  u.task = "group";
  go(e, u, m.spot, 100);
}

function groupJob(e: Engine, b: Brain, u: Unit, m: UMem) {
  const g = b.group;
  u.task = b.plan.kind === "siege" ? "siege" : "group";
  if (!g.members.length || !g.key) { laneJob(e, u, m, "mid"); return; }
  if (joinFight(e, u)) return;
  let target: Vec;
  if (dist(u, g) > 1900) target = turretSafe(e, u.side, { x: g.x, y: g.y });
  else {
    // a slowly changing personal offset so a standing group does not freeze in formation
    if (!m.spot || m.spotFor !== "gj" || e.t - m.spotAt > 7) {
      m.spot = { x: (e.rng.next() - 0.5) * 700, y: (e.rng.next() - 0.5) * 700 };
      m.spotFor = "gj";
      m.spotAt = e.t;
    }
    const s = groupSpot(e, b, u);
    // also when sieging: under the turret only once our wave is on it (siegeDest keeps the group with the wave until then)
    target = turretSafe(e, u.side, { x: s.x + m.spot.x, y: s.y + m.spot.y });
  }
  if (!u.goal || dist(u.goal, target) > 220 || (!u.path.length && dist(u, target) > 120)) {
    const q = Nav.walkable(target) ? target : snap(target);
    u.goal = null;
    e.setGoal(u, q);
  }
  e.moveStep(u, DT);
}

export function unitTick(e: Engine, u: Unit): boolean {
  const M = st(e);
  if (!M) return false;
  const m = M.units[u.i];
  const b = M.brains[u.side];
  if (m.job === "old") return false;
  // regen in the fountain area (the old code does this only on its own path)
  if (dist(u, FOUNTAIN[u.side]) < 1200) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.08 * DT);
  // a steal run comes before everything else the jungler was doing (stealTick ends it)
  if (b.steal && b.steal.by === u.i) { stealJob(e, b, u, m); return true; }
  if (m.job === "recall") {
    if (inFountain(u)) { if (hpf(u) < 0.95) return true; }
    else { startRecall(e, u); return true; }
  }
  if (wantRecall(e, b, u, m)) { startRecall(e, u); return true; }
  // just pulled out of a lost fight: keep backing off (the engine set a home goal and a short calm)
  const calm = (u as Unit & { calmUntil?: number }).calmUntil ?? 0;
  if (calm > e.t && m.job !== "defend") {
    if (!m.retreatTo || e.t >= m.retreatUntil) { m.retreatTo = e.nearestOwnTurret(u) ?? FOUNTAIN[u.side]; m.retreatUntil = calm; }
    go(e, u, m.retreatTo, 120);
    return true;
  }
  if (danger(e, b, u, m)) return true;
  const laning = e.laningPhase();
  switch (m.job) {
    case "lane": if (!joinFight(e, u, 1600)) laneJob(e, u, m, m.lane ?? "mid"); break;
    case "split": splitJob(e, u, m, m.lane ?? b.splitLane); break;
    case "jungle": jungleJob(e, M, b, u, m, laning); break;
    case "escort": if (!joinFight(e, u)) escortJob(e, b, u, m); break;
    case "group": groupJob(e, b, u, m); break;
    case "obj": case "guard":
      if (b.plan.obj && (b.plan.kind === "take" || b.plan.kind === "contest")) objJob(e, M, b, u, m, m.job === "guard");
      else groupJob(e, b, u, m);
      break;
    case "defend": defendJob(e, b, u, m); break;
    case "recall": groupJob(e, b, u, m); break;
    default: return false;
  }
  return true;
}

export function hitsObjective(e: Engine, u: Unit, k: ObjKey): boolean {
  const M = st(e);
  if (!M) return true;
  const p = M.brains[u.side].plan;
  if ((p.kind !== "take" && p.kind !== "contest") || p.obj !== k || p.phase !== "commit") return false;
  if (!p.hitters.includes(u.i)) return false;
  // a contest answers the enemy's take: its hitters race for a monster the enemy is on, they do not start one or
  // finish one the enemy has left. (Now that a contest begins when the enemy is seen at the entrance, it would
  // otherwise be a take without any of takeCand's checks: 29 % of barons fell to a contest. A won contest goes on as a
  // take, see choosePlan.) Not at the grubs: a contest there only starts when the enemy's plan is on them
  // (contestCand), is one or two champions, and whoever came over stays on what is left of the camp (T07).
  if (p.kind === "contest" && k !== "grubs" && !enemyOn(e, M, u.side, k)) return false;
  if (p.solo) return u.role === "Jungle";
  // counted live: a hitter may have been pulled into a fight earlier this step
  const pit = PIT_POS[PIT_OF[k]];
  let n = 0, live = 0;
  for (const i of p.hitters) {
    const x = e.units[i];
    if (!x.alive || x.fightId) continue;
    live++;
    if (!channeling(x) && dist(x, pit) < 650) n++;
  }
  M.pit[u.side][k] = n;
  // one hitter is enough for a grub (the jungler come to smite one); the other monsters need two in the pit
  return n >= Math.max(k === "grubs" ? 1 : 2, Math.min(p.h, live));
}

const OBJ_NAME: Record<ObjKey, string> = { dragon: "드래곤", grubs: "공허 유충", herald: "협곡의 전령", baron: "내셔 남작", elder: "장로 드래곤" };
const LANE_NAME: Record<LaneId, string> = { top: "탑", mid: "미드", bot: "바텀" };
const FORMATION_NAME: Record<Formation, string> = { lanes: "라인전", spread: "라인 관리", "1-4": "1-4 운영", "1-3-1": "1-3-1 운영", five: "5인 이동" };

/** What a team is doing right now, in Korean, for a HUD / commentary line (e.g. "드래곤 집결", "1-4 운영"). */
export function planLabel(e: Engine, side: SideN): string {
  const M = st(e);
  if (!M) return "";
  const b = M.brains[side];
  const p = b.plan;
  switch (p.kind) {
    case "take": {
      const o = OBJ_NAME[p.obj!];
      if (p.solo) return `정글 단독 ${o}`;
      if (p.phase === "commit") return `${o} 사냥`;
      // enemies at the pit too: the two teams are facing each other
      const facing = e.units.some((x) => x.alive && x.side !== side && dist(x, PIT_POS[PIT_OF[p.obj!]]) < OBJ_TUNE.near + 400);
      if (facing && e.obj[p.obj!].alive) return `${o} 대치`;
      const what = p.phase === "setup" ? `${o} 준비` : p.prio ? `${o} 집결` : `${o} 대기`;
      return p.trade ? `${what}(${OBJ_NAME[p.trade]} 교환)` : what;
    }
    case "contest": return p.poach ? "유충 뺏기" : `${OBJ_NAME[p.obj!]} 저지`;
    case "siege": return p.trade ? `${LANE_NAME[p.lane!]} 공성(${OBJ_NAME[p.trade]} 교환)` : `${LANE_NAME[p.lane!]} 공성`;
    case "defend": return `${LANE_NAME[p.lane!]} 수비`;
    case "reset": return "정비(귀환)";
    default: return FORMATION_NAME[b.formation];
  }
}

/** What a side wants from a fight next to a pit (fight.ts): "take" = it is on the monster and would rather finish
 *  it, "stop" = the enemy is on it and this side has to fight now or lose it, "hold" = nobody has started it. */
export type Purpose = "take" | "stop" | "hold";

/** The monster a fight at `f` is about and what `side` wants from it; null away from the pits or with no monster in
 *  play there (up, or spawning within 30 s). */
export function purpose(e: Engine, side: SideN, f: Vec): { k: ObjKey; want: Purpose } | null {
  const M = st(e);
  if (!M) return null;
  for (const pk of ["dragon", "baron"] as Pit[]) {
    if (dist(f, PIT_POS[pk]) > OBJ_TUNE.near) continue;
    const k = inPlay(e, pk, 30);
    if (!k) return null;
    const on = (p: Plan) => (p.kind === "take" || p.kind === "contest") && p.obj !== undefined && PIT_OF[p.obj] === pk;
    const mine = M.brains[side].plan, theirs = M.brains[1 - side].plan;
    if (on(mine) && mine.kind === "contest") return { k, want: "stop" };
    if (on(mine) && mine.phase === "commit") return { k, want: "take" };
    if (on(theirs) && enemyOn(e, M, side, k)) return { k, want: "stop" };
    return { k, want: "hold" };
  }
  return null;
}

export function stance(e: Engine, u: Unit): Stance {
  const M = st(e);
  if (!M) return "free";
  const b = M.brains[u.side];
  const m = M.units[u.i];
  const p = b.plan;
  // a steal runner is not there to fight: it does not start or answer one (fight.ts keeps it walking if it is caught)
  if (b.steal && b.steal.by === u.i) return "avoid";
  if (m.job === "recall" || e.t < m.retreatUntil || hpf(u) < 0.3 || channeling(u)) return "avoid";
  const holdBack = e.minute() < b.P.avoidUntil;
  switch (m.job) {
    case "obj": case "guard":
      return p.engage ? "engage" : "hold";
    case "defend":
      return p.engage ? "engage" : "hold";
    case "split": {
      let foeP = 0, myP = e.power(u);
      for (const x of e.units) {
        if (!x.alive || dist(x, u) > 2500) continue;
        if (x.side === u.side) myP += x === u ? 0 : e.power(x);
        else foeP += e.power(x);
      }
      return myP > foeP * 1.3 ? "free" : "avoid";
    }
    case "group":
      if (p.kind === "siege") return p.engage ? "engage" : "hold";
      return b.P.fight > 0.05 && !holdBack ? "engage" : holdBack ? "avoid" : "hold";
    case "old":
      if (u.task === "gank") return "engage";
      return holdBack ? "hold" : "free";
    default:
      return holdBack ? "avoid" : "free";
  }
}
