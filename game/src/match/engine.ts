// Match engine: 10 champions on Summoner's Rift, 0.25 s ticks of game time.
// Positions follow the pro heatmap (where each role stands at each minute), lanes have minion fronts,
// junglers clear camps on real timers, fights resolve spell by spell. The renderer only reads this state.
import type { GameData } from "../data/load";
import type { ChampionData, Role, SpellData, VfxKind } from "../data/types";
import { ROLES, ROLE_KO } from "../data/types";
import { Rng, clamp } from "../core/rng";
import { josa } from "../core/format";
import type { GameState, Player } from "../core/types";
import { ovr } from "../core/player";
import { coachBonus, fatiguePenalty, MOD_GAIN, starterFatigue } from "../core/quick";
import { compBonus, mastery } from "./draft";
import { metaBonus } from "../core/meta";
import {
  BARON_PIT, CAMPS_BLUE, CAMP_POS_RED, DRAGON_PIT, FOUNTAIN, INHIBS, LANES, LANE_PATH, NEXUS, ROLE_LANE, SCUTTLE, TURRETS,
  dist, findPath, laneU, lanePoint, mirror, sampleHeat, initMap,
} from "./map";
import type { CampKind, LaneId, Vec } from "./map";
import * as Nav from "./nav";
import * as Macro from "./macro";
import * as Fight from "./fight";
import * as Items from "./items";
import type { SideLoadout } from "./items";
import * as Matchup from "./matchup";
import * as Stats from "./stats";
import * as Summoners from "./summoners";
import * as ObjSmite from "./objsmite";
import type { SummonerName } from "./summoners.gen";
import type { Strategy } from "./strategy";
import { defaultStrategy } from "./strategy";

export const DT = 0.25;
export type SideN = 0 | 1;

/**
 * Feature switches for the engine rework (2026-11-26). Each module (nav = walls & paths, macro = team plans &
 * objectives, fight = teamfights with champion kits) is wired in behind its flag so it can be tested on its own;
 * test scripts may flip these at runtime. With a flag off the engine runs the old code path.
 */
export const ENGINE_FLAGS = { nav: true, macro: true, fight: true };

/**
 * How far apart player strength puts two units in this engine. A unit's rating (overall + role fit + form +
 * mastery + team modifiers + meta + a per-game roll, all on the teamPower scale) is pulled toward RATING_REF by
 * this factor before anything reads it, so every rating-driven edge (damage multiplier, poke and skillshot odds,
 * gank choice, smite steals, CS rate) shrinks or grows together and no single channel gets out of line.
 * Real LCK 2025-26 results put POWER_SCALE (core/quick.ts) at 9.5 (scripts/real-scale.ts); at factor 1 the engine
 * played like a scale of ~6.2 (calibrate slope 1.53 vs 9.5 over 6 roster seeds), 0.7 brings it to ~1.05.
 */
export const RATING_SPREAD = 0.7;
const RATING_REF = 75;
/** cds[3] (the ultimate) until level 6: every "t >= cds[k]" readiness check fails without a separate level test.
 *  Before this, ults were cast from level 1 (e.g. Galio R in a 2:20 lane all-in). */
const R_LOCKED = 1e9;

/**
 * Laning-phase fight rates (calibrated with scripts/early-diag.ts against LCK 2026, scripts/lck_early.py: 3.83 kills
 * by 10 min and 6.83 by 14, 70 % of them with a jungler in it, 3.55 champions per kill, 1v1 only 10 %).
 * gankRate: chance per step that a jungler starts a gank (on top of the coach's strategy); gankMin: how good a lane
 * must look (pickGankLane score); allin: lane all-in rates per second; meet / meetEdge: chance per second that two
 * champions who meet off-lane (junglers at a camp or the scuttle, a roaming mid) start a fight, even / at a 1.3 edge.
 * Scripts can override any of them with EARLY_TUNE=key:value,... (allinTop / allinMid / allinBot for the lanes).
 */
export const EARLY_TUNE = {
  // was 0.0018 / 0.35 / bot 0.0004 / 0.003 / 0.012 before real-stat damage and real recalls (first kill 9.0 min,
  // 0.9 kills by 10 min); 0.008 and all-ins 0.0008 / 0.00055 / 0.0008 gave 5.5 min and 3.9 (60 games, roster seed 3).
  // 2026-11-27: after the gank give-up rule (SIM_TUNE.gankWait / gankCd) and turret shots outside fights, those gave
  // 6.5 min and 2.8 kills by 10 min; these give 5.5 and 3.8 (200 games, seed 3)
  gankRate: 0.012,
  gankMin: 0.15,
  allinTop: 0.0013,
  allinMid: 0.0009,
  allinBot: 0.0013,
  meet: 0.006,
  meetEdge: 0.02,
};
export function applyEarlyTune(spec: string | undefined) {
  applyTune(EARLY_TUNE, "EARLY_TUNE", spec);
}
export function applyTune(target: Record<string, number>, name: string, spec: string | undefined) {
  for (const kv of (spec ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split(":");
    const n = Number(v);
    // a typo or a missing value would silently turn ganks / all-ins off (rng.chance(NaN) is false): refuse it
    if (!Object.prototype.hasOwnProperty.call(target, k) || v === undefined || v === "" || !Number.isFinite(n)) {
      throw new Error(`${name}: bad entry "${kv}" (keys: ${Object.keys(target).join(", ")})`);
    }
    target[k] = n;
  }
}

/**
 * CS, XP and gold income, calibrated with scripts/growth-check.ts against LCK 2026 (scripts/lck_growth.py, 502 games:
 * CS, level, XP and gold by role at 2 / 3 / 5 / 8 / 10 / 15 / 20 / 25 / 30 min). Before this (2026-11-27) the engine's
 * junglers had half the real camp CS (46 vs 77 at 10 min), every role ended about 2 levels low and supports had no CS.
 * laneCs: CS per minute near a wave; laneXpSolo / laneXpDuo: XP per second near a wave (duo: the shared bot lane),
 * rising by laneXpGrow per game minute; sideCs: CS per minute for a laner away from the fronts after 14:00 (side
 * waves, camps), sideBot: the ADC's multiplier on it (LCK ADCs farm 10.2 a minute); sideXp: XP per second for a laner
 * on a side-lane job after laning but away from its front; awayXp*: XP per second away from waves (during laning /
 * after; the jungler's own pair); supCs / supGold: the support's CS per minute and gold per second near a wave.
 * Camps pay 4 CS each as in the real timelines (12 CS at 2:00, 24 at 3:00 for a full clear): campDpsMul / campDpsAdd
 * set the jungler's damage to camps (x basic attack dps, + flat), campHp / campHpGrow the camps' health and its rise
 * per game minute (tougher early camps and a slower rise: a flat damage bonus on light camps finished the first clear
 * at 1:57, 20 CS at 2:00 against LCK's 11.3, while lowering the damage alone slowed every later clear), campHurt the damage it
 * takes back (the pet's healing covers much of it; at full damage junglers went home at 25 % hp before finishing the
 * first clear), campXpBig / campXpSmall the XP per buff / other camp, campGold the gold multiplier (buff 100, small
 * 75, scuttle 120). epicCs / grubCs: CS for the last hit on a dragon, herald, baron or elder / on each voidgrub (in
 * LCK timelines 22 % of a jungler's monster CS is neither its own jungle nor the enemy's).
 * Scripts can override any of them with GROWTH_TUNE=key:value,...
 */
export const GROWTH = {
  laneCs: 12.6, laneXpSolo: 10, laneXpDuo: 8.8, laneXpGrow: 0.025,
  sideCs: 8, sideBot: 1.6, sideXp: 9.5, awayXpLaning: 1.2, awayXp: 4.5, jgAwayXpLaning: 1.5, jgAwayXp: 3.2,
  supCs: 2.5, supGold: 2.2,
  campDpsMul: 3.6, campDpsAdd: 0, campHurt: 0.5, campXpBig: 250, campXpSmall: 175, campGold: 1.2,
  epicCs: 4, grubCs: 1,
  /** camp health multiplier (buff 1600, other camps 1100) and its rise per game minute at each spawn */
  campHp: 1.6, campHpGrow: 1 / 60,
  /** the jungler's own gank roll after the laning phase, as a share of EARLY_TUNE.gankRate. Late ganks only go for a
   *  target alone at its lane (Engine.gankable), so few of them start; 1 with the pace calibration (PACE_TUNE) */
  lateGank: 1,
};
export function applyGrowthTune(spec: string | undefined) {
  applyTune(GROWTH, "GROWTH_TUNE", spec);
}

/**
 * Game pace after laning (scripts/calibrate.ts against LCK 2026: 32.2 min, first tower 15.7 min). towerDmg: champion
 * damage to turrets / inhibitors (x basic attack dps); minionDmg: the wave's damage to a structure it sits on;
 * engage: the chance that two groups meeting outside a siege, an objective or a gank start a fight (engageRate).
 * Set 2026-11-27 after turret shots outside fights and sieges that wait for the wave (SIM_TUNE) made games 34.6-37.2
 * min with first towers at 16.7-17.2 and too few kills from 10 to 30 min (2.8 / 6.4 / 9.7 per 10-min block); with
 * these, EARLY_TUNE and SIM_TUNE.siegePush 3.2: 31.9 min, 28.8 kills, first tower 15.9 (200 games, roster seed 3).
 * 2026-11-27 (T08): engage 3.8 -> 2.4. Fights over epic monsters (macro.ts OBJ_TUNE) now bring 10 kills a game where
 * they brought 3; chance meetings of two groups are cut by as much so kills stay at 29.7 (120 games, seed 3: 32.7
 * kills at 3.8, kills from such meetings 11.5 -> 5.5 a game).
 * Scripts can override them with PACE_TUNE=key:value,...
 */
export const PACE_TUNE = { towerDmg: 1.6, minionDmg: 1.3, engage: 2.4 };
export function applyPaceTune(spec: string | undefined) {
  applyTune(PACE_TUNE, "PACE_TUNE", spec);
}

/**
 * Fixes for things that looked wrong in the match view (2026-11-27, measured with scripts/sim-diag.ts; 40 games before
 * -> after): champion-seconds per game under an enemy turret with no wave, outside a fight and never shot 108 -> 9
 * (and shot for most of those); lane opponents within 400 u with no fight after 14:00 27 -> 2 pair-seconds; a ganking
 * jungler standing next to its target, p90 14.8 s -> 3.8 s; the herald no longer hits a turret from the pit.
 * towerGrace: a turret with no wave on it shoots a champion outside a fight once it has stood in range this long (s);
 *   before, turrets only shot champions that were in a fight, so a group could stand under one for half a minute.
 * waveNear: the attacking wave counts as on a turret while the lane front is within this distance of it (u).
 * siegePush: a sieging group now walks in with its wave (it cannot hit the turret before the wave is there) and shoves
 *   it this much harder; at 1 games ran 0.7 min longer than before the change, at 2 the same length.
 * sidePoke / sidePokeLo / sidePokeHi: after the laning phase, two enemies holding the same lane poke each other this
 *   often (per second per pair) for this share of max hp; laneGap: the weaker one (under a turret: the defender) keeps
 *   this far away (u). Before, two side laners stood 300 u apart for a minute without doing anything.
 * gankArrive / gankWait / gankCd: a jungler who has been within gankArrive of the target for gankWait seconds with no
 *   fight calls the gank off and waits gankCd before the next one (it used to shadow the laner for up to 28 s, and
 *   followed a laner who had gone home through the enemy's turrets). gankPoor: chance per second that a gank at poor
 *   odds (ratio under 0.8) goes in anyway; it was 0.1 over a stay of up to 28 s, now the stay is gankWait.
 *   gankReach: from the edge of a turret's range the jungler can still open the dive on a target under that turret.
 * heraldDelay / heraldNear / heraldForce: the herald is held after the take and charges once a teammate is within
 *   heraldNear of an enemy outer turret (not before heraldDelay s), or on its own after heraldForce s.
 * Calibration (scripts/calibrate.ts, 200 games x roster seeds 3 and 5, on the engine as it was before the GROWTH
 * retune, before -> after): length 33.9 -> 33.9 min, kills 33.6 -> 32.8, first blood 5.45 -> 5.8 min, first tower
 * 16.7 -> 16.85 min, solo kills 1.17 -> 0.96.
 * Scripts can override any of them with SIM_TUNE=key:value,...
 */
export const SIM_TUNE = {
  // siegePush 3.2 (was 2): set in the 2026-11-27 pace calibration together with PACE_TUNE
  towerGrace: 0.75, waveNear: 850, siegePush: 3.2,
  sidePoke: 0.04, sidePokeLo: 0.03, sidePokeHi: 0.07, laneGap: 520,
  gankArrive: 800, gankWait: 3.5, gankCd: 20, gankPoor: 0.35, gankReach: 1500,
  heraldDelay: 8, heraldNear: 3000, heraldForce: 90,
};
export function applySimTune(spec: string | undefined) {
  applyTune(SIM_TUNE, "SIM_TUNE", spec);
}

export interface Unit {
  i: number;
  side: SideN;
  role: Role;
  pid: string;
  name: string;
  champ: ChampionData;
  rating: number;
  x: number;
  y: number;
  path: Vec[];
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnAt: number;
  level: number;
  xp: number;
  gold: number;
  cs: number;
  k: number;
  d: number;
  a: number;
  streak: number;
  multi: { n: number; last: number };
  cds: number[];
  stunUntil: number;
  shield: number;
  task: "lane" | "jungle" | "roam" | "recall" | "obj" | "fight" | "siege" | "return" | "gank" | "group";
  taskUntil: number;
  goal: Vec | null;
  campTarget?: number;
  objTarget?: ObjKey;
  recallEnd?: number;
  lastHitBy: Map<number, number>;
  baronUntil: number;
  elderUntil: number;
  dmg: number;
  fightId: number;
  /** how fast the player's hands are (mechanics and consistency, about 60-96; 73 is the median LCK jungler): the Smite
   *  fights over epic monsters read it (objsmite.ts) */
  reflex?: number;
}

export type ObjKey = "dragon" | "grubs" | "herald" | "baron" | "elder";
export const OBJ_KO: Record<ObjKey, string> = { dragon: "드래곤", grubs: "공허 유충", herald: "협곡의 전령", baron: "내셔 남작", elder: "장로 드래곤" };

/** an epic monster heals unless a champion within this distance is fighting or walking in on it (objectivesTick) */
const OBJ_LEASH = 1300;
export interface ObjState { key: ObjKey; alive: boolean; spawnAt: number | null; hp: number; maxHp: number; pos: Vec; takenBy?: SideN; type?: string; left?: number }
export interface CampState { id: number; side: SideN; kind: CampKind | "scuttle"; pos: Vec; alive: boolean; spawnAt: number; hp: number; maxHp: number }
export interface TurretState { side: SideN; lane: LaneId | "nexus"; tier: number; pos: Vec; hp: number; maxHp: number; alive: boolean; u: number; plates: number }
export interface InhibState { side: SideN; lane: LaneId; pos: Vec; hp: number; alive: boolean; respawnAt: number }
export interface LaneState { id: LaneId; front: number }

export interface Fx {
  t: number;
  id: number;
  kind: VfxKind | "aa" | "kill" | "tower" | "recall" | "smite" | "objhit" | "level" | "hit" | "sum";
  side: SideN;
  /** skills: caster position (dash/blink: landing point); hit: victim position */
  x: number; y: number;
  /** skills: aim point (dash/blink: start point) */
  tx: number; ty: number;
  color: string;
  r: number;
  w: number;
  from?: number;
  to?: number;
  text?: string;
  // ---- contract with vfx.ts (agreed with the VFX session, all optional) ----
  key?: "Q" | "W" | "E" | "R";
  icon?: string;
  also?: VfxKind;
  /** cast against jungle monsters / minions: drawn small and faint */
  pve?: boolean;
  /** the skill missed its main target (`to`) */
  miss?: boolean;
  /** lingering zones/walls: engine time t when it ends */
  until?: number;
  /** a summoner spell was used (summoners.ts spend): kind "sum" is its own effect, from the caster to tx,ty / `to`;
   *  on other kinds (the Flash blink, the objective smite) it only names the spell for the icon over the caster */
  sum?: SummonerName;
}

export type EvType =
  | "kill" | "first_blood" | "solo" | "double" | "triple" | "quadra" | "penta" | "ace" | "shutdown"
  | "dragon" | "soul" | "elder" | "grubs" | "herald" | "baron" | "steal" | "turret" | "first_turret" | "inhib" | "nexus" | "info"
  /** a jungler stood in Smite's reach of an epic monster the other team was taking and did not get it (objsmite.ts) */
  | "steal_fail";

export interface GameEvent { t: number; type: EvType; side: SideN; text: string; actor?: number; victim?: number; big: boolean; x?: number; y?: number }

export interface EngineSetup {
  s: GameState;
  data: GameData;
  blue: string;
  red: string;
  picks: { blue: Partial<Record<Role, string>>; red: Partial<Record<Role, string>> };
  seed: number;
  tactic?: [Tactic, Tactic];
  /** macro game plan chosen before the game (user side) or by the AI coach; see strategy.ts */
  strategy?: [Strategy | null, Strategy | null];
  /** builds / keystones per side (items.ts); missing = each champion's most played LCK option */
  loadout?: [SideLoadout | undefined, SideLoadout | undefined];
}
export type Tactic = "aggressive" | "standard" | "safe";

const DRAGON_TYPES = ["화염", "대지", "바다", "바람", "화학공학", "마법공학"];
/** Spell shapes a laner can poke with without moving (vfx.ts draws these from the caster to the target). */
const POKE_KINDS = new Set<VfxKind>(["line", "circle", "cone", "target", "zone", "knockup", "wall"]);

export class Engine {
  t = 0;
  rng: Rng;
  units: Unit[] = [];
  lanes: Record<LaneId, LaneState> = { top: { id: "top", front: 0.5 }, mid: { id: "mid", front: 0.5 }, bot: { id: "bot", front: 0.5 } };
  turrets: TurretState[] = [];
  inhibs: InhibState[] = [];
  nexus: [number, number] = [4000, 4000];
  camps: CampState[] = [];
  obj: Record<ObjKey, ObjState>;
  events: GameEvent[] = [];
  fx: Fx[] = [];
  over = false;
  winner: SideN | null = null;
  kills: [number, number] = [0, 0];
  towers: [number, number] = [0, 0];
  dragons: [string[], string[]] = [[], []];
  grubs: [number, number] = [0, 0];
  heralds: [number, number] = [0, 0];
  barons: [number, number] = [0, 0];
  soul: SideN | null = null;
  soulType = "";
  firstBlood = false;
  firstTurret = false;
  fightSeq = 0;
  fights = new Map<number, { x: number; y: number; start: number; last: number; trade?: boolean; origin?: string; size?: number }>();
  killOrigin: Record<string, number> = {};
  tactic: [Tactic, Tactic];
  strategy: [Strategy, Strategy] = ["balanced", "balanced"];
  /** the data this engine was built from (champions, meta, heatmap) */
  data: GameData;
  /** per-module scratch state, keyed by module name (macro/fight keep their own data here) */
  mods: Record<string, unknown> = {};
  teamMod: [number, number] = [0, 0];
  names: [string, string];
  teamIds: [string, string];
  dragonOrder: string[] = [];
  nextTeamThink = 0;
  meta: GameData["meta"];

  constructor(cfg: EngineSetup) {
    const { s, data } = cfg;
    initMapOnce(data);
    this.data = data;
    this.meta = data.meta;
    this.rng = new Rng(cfg.seed);
    this.tactic = cfg.tactic ?? ["standard", "standard"];
    this.teamIds = [cfg.blue, cfg.red];
    this.names = [s.teams[cfg.blue].name, s.teams[cfg.red].name];
    const sides: [string, Partial<Record<Role, string>>][] = [[cfg.blue, cfg.picks.blue], [cfg.red, cfg.picks.red]];
    sides.forEach(([tid, picks], side) => {
      const t = s.teams[tid];
      const comp = compBonus(data, picks);
      const moraleAvg = ROLES.reduce((a, r) => a + (t.lineup[r] ? s.players[t.lineup[r]!].morale : 60), 0) / 5;
      const edge = tid === s.user ? 0 : s.difficulty === "hard" ? 1.5 : s.difficulty === "easy" ? -1 : 0.4;
      const userPlays = cfg.blue === s.user || cfg.red === s.user;
      // manager-side modifiers keep their designed win-rate effect on the real-data scale (MOD_GAIN, core/quick.ts)
      this.teamMod[side] = MOD_GAIN * ((t.synergy - 50) / 12 + coachBonus(s, t) + comp + (moraleAvg - 60) / 20 + (userPlays ? edge : 0) - fatiguePenalty(starterFatigue(s, tid)));
      ROLES.forEach((role) => {
        const pid = t.lineup[role];
        const p: Player | undefined = pid ? s.players[pid] : undefined;
        const champId = picks[role] ?? data.champions[0].id;
        const champ = data.champ.get(champId) ?? data.champions[0];
        const m = mastery(p, champ);
        const base = p ? ovr(p) + (p.role === role ? 0 : -8) + p.form * 0.15 : 45;
        const raw = base + (m - 62) / 4.5 + this.teamMod[side] + metaBonus(s, champ.id) * MOD_GAIN + this.rng.normal(0, 3);
        const rating = RATING_REF + (raw - RATING_REF) * RATING_SPREAD;
        const f = FOUNTAIN[side];
        const u: Unit = {
          i: this.units.length, side: side as SideN, role, pid: pid ?? "", name: p?.name ?? ROLE_KO[role], champ, rating,
          x: f.x + (this.rng.next() - 0.5) * 300, y: f.y + (this.rng.next() - 0.5) * 300, path: [],
          hp: 1, maxHp: 1, alive: true, respawnAt: 0, level: 1, xp: 0, gold: 500, cs: 0, k: 0, d: 0, a: 0, streak: 0,
          multi: { n: 0, last: -99 }, cds: [0, 0, 0, R_LOCKED], stunUntil: 0, shield: 0, task: "lane", taskUntil: 0, goal: null,
          lastHitBy: new Map(), baronUntil: 0, elderUntil: 0, dmg: 0, fightId: 0,
          reflex: p ? p.attrs.mechanics * 0.7 + p.attrs.consistency * 0.3 + p.form * 0.3 : undefined,
        };
        this.units.push(u);
      });
    });
    for (const u of this.units) {
      u.maxHp = this.maxHp(u);
      u.hp = u.maxHp;
    }
    for (const td of TURRETS) {
      const maxHp = td.tier === 1 ? 3600 : td.tier === 2 ? 3800 : td.tier === 3 ? 4200 : 3200;
      this.turrets.push({ side: td.side, lane: td.lane, tier: td.tier, pos: td.pos, hp: maxHp, maxHp, alive: true, u: td.lane === "nexus" ? (td.side ? 0.97 : 0.03) : laneU(td.lane, td.pos), plates: td.tier === 1 ? 5 : 0 });
    }
    for (const ih of INHIBS) this.inhibs.push({ side: ih.side, lane: ih.lane, pos: ih.pos, hp: 3000, alive: true, respawnAt: 0 });
    const camps = this.meta.camps;
    let id = 0;
    for (const side of [0, 1] as SideN[]) {
      for (const c of CAMPS_BLUE) {
        const pos = side === 0 ? c.pos : CAMP_POS_RED[c.kind] ?? mirror(c.pos);
        const timing = camps[c.kind] ?? { firstSpawn: 90, respawn: 135 };
        const hp = (c.kind === "blue" || c.kind === "red" ? 1600 : 1100) * GROWTH.campHp;
        this.camps.push({ id: id++, side, kind: c.kind, pos, alive: false, spawnAt: timing.firstSpawn, hp, maxHp: hp });
      }
    }
    const sc = camps.scuttle ?? { firstSpawn: 210, respawn: 150 };
    SCUTTLE.forEach((pos, i) => this.camps.push({ id: id++, side: i === 0 ? 0 : 1, kind: "scuttle", pos, alive: false, spawnAt: sc.firstSpawn, hp: 900, maxHp: 900 }));
    const o = this.meta.objectives;
    const mk = (key: ObjKey, pos: Vec, spawnAt: number | null, hp: number): ObjState => ({ key, alive: false, spawnAt, hp, maxHp: hp, pos });
    this.obj = {
      dragon: mk("dragon", DRAGON_PIT, o.dragon?.firstSpawn ?? 300, 3600),
      grubs: { ...mk("grubs", BARON_PIT, o.grubs?.firstSpawn ?? 480, 2400), left: 3 },
      herald: mk("herald", BARON_PIT, o.herald?.firstSpawn ?? 900, 5200),
      baron: mk("baron", BARON_PIT, o.baron?.firstSpawn ?? 1200, 9500),
      elder: mk("elder", DRAGON_PIT, null, 8000),
    };
    const a = this.rng.pick(DRAGON_TYPES);
    let b = this.rng.pick(DRAGON_TYPES);
    while (b === a) b = this.rng.pick(DRAGON_TYPES);
    let c = this.rng.pick(DRAGON_TYPES);
    while (c === a || c === b) c = this.rng.pick(DRAGON_TYPES);
    this.dragonOrder = [a, b, c];
    this.soulType = c;
    this.obj.dragon.type = a;
    // game plans: the user's pick, otherwise the AI coach reads its own roster and draft
    for (const side of [0, 1] as SideN[]) {
      this.strategy[side] = cfg.strategy?.[side] ?? defaultStrategy(s, this.teamIds[side], this.units.filter((u) => u.side === side).map((u) => u.champ));
    }
    if (ENGINE_FLAGS.macro) Macro.init(this);
    if (ENGINE_FLAGS.fight) Fight.init(this);
    Items.init(this, cfg.loadout);
    // LCK champion matchups between lane opponents (matchup.ts: lane damage, pokes, CS share)
    Matchup.init(this);
    // real numbers: level-1 health includes the rune shards and the starter item, known only after Items.init
    if (this.realStats()) for (const u of this.units) u.hp = u.maxHp = this.maxHp(u);
  }

  // ---------- stats ----------
  /** Item strength, (gold - 500) / 3000 scale. With items.json it counts bought items only, and a channel weights
   *  it by where the build's stats go (aa / sp / hp); see items.ts. */
  itemPower(u: Unit, ch?: "aa" | "sp" | "hp") {
    return Items.itemPower(this, u, ch);
  }
  phaseMul(u: Unit) {
    const m = this.t / 60;
    const early = (u.champ.style.early - 5) / 5;
    const late = (u.champ.style.scaling - 5) / 5;
    return 1 + (m < 15 ? early * 0.07 : 0) + (m > 28 ? late * 0.08 : 0) - (m > 28 ? early * 0.04 : 0);
  }
  skill(u: Unit) {
    return clamp(1 + (u.rating - 75) / 80, 0.7, 1.35);
  }
  /**
   * Real LoL numbers drive the fight (stats.ts: champion stats by level + owned items, attack speed, armor / magic
   * resist, spell ratios; procs.ts: item passives, keystones, summoner spells, champion passives) whenever items.json
   * is loaded. Without it the older class-and-gold formulas below run.
   */
  realStats(): boolean {
    return Stats.STATS_FLAGS.real && !!this.data.items;
  }
  /** What the engine adds on top of the real numbers: player skill, baron / elder / soul, the build's LCK edge. */
  realMul(u: Unit, ch: "aa" | "sp") {
    const buff = ch === "aa"
      ? (u.baronUntil > this.t ? 1.25 : 1) * (u.elderUntil > this.t ? 1.25 : 1)
      : (u.baronUntil > this.t ? 1.2 : 1) * (u.elderUntil > this.t ? 1.25 : 1);
    return Items.edgeMul(this, u, ch) * this.skill(u) * buff * this.soulMul(u.side);
  }
  maxHp(u: Unit) {
    if (this.realStats()) return Stats.stats(this, u).hp * Items.edgeMul(this, u, "hp");
    const tags = u.champ.tags;
    const tank = tags.includes("Tank") ? 1.45 : tags.includes("Fighter") ? 1.2 : tags.includes("Support") ? 1.05 : 0.92;
    const ip = this.itemPower(u, "hp");
    return (640 + u.level * 95) * tank * (1 + ip * (tank > 1.1 ? 0.2 : 0.12)) * Items.mul(this, u, "hp");
  }
  /** Basic attack damage per second before the target's armor. */
  aaDps(u: Unit) {
    if (this.realStats()) return Stats.aaRaw(this, u) * this.realMul(u, "aa");
    const tags = u.champ.tags;
    const mark = tags.includes("Marksman") ? 1.55 : tags.includes("Fighter") ? 1.15 : tags.includes("Support") ? 0.6 : 0.85;
    const buff = (u.baronUntil > this.t ? 1.25 : 1) * (u.elderUntil > this.t ? 1.25 : 1);
    return (24 + u.level * 6) * mark * (1 + this.itemPower(u, "aa") * 0.18) * Items.mul(this, u, "aa") * this.skill(u) * this.phaseMul(u) * buff * this.soulMul(u.side);
  }
  /** Damage of one cast before the target's resistances (real path: against a typical target). */
  spellDmg(u: Unit, sp: SpellData) {
    if (this.realStats()) {
      const k = u.champ.spells.indexOf(sp);
      if (k < 0 || Stats.noDamage(u, k)) return 0;
      const raw = Stats.hasDamage(u, k) ? Stats.spellRaw(this, u, k, null) : Stats.fallbackRaw(u, sp.power || 1);
      return (raw.p + raw.m + raw.t) * this.realMul(u, "sp");
    }
    const tags = u.champ.tags;
    const caster = tags.includes("Mage") || tags.includes("Assassin") ? 1.35 : tags.includes("Support") ? 0.7 : 1;
    const buff = (u.baronUntil > this.t ? 1.2 : 1) * (u.elderUntil > this.t ? 1.25 : 1);
    return (20 + u.level * 13) * (sp.power || 1) * caster * (1 + this.itemPower(u, "sp") * 0.16) * Items.mul(this, u, "sp") * this.skill(u) * this.phaseMul(u) * buff * this.soulMul(u.side);
  }
  soulMul(side: SideN) {
    return (this.soul === side ? 1.08 : 1) * (1 + this.dragons[side].length * 0.015);
  }
  power(u: Unit) {
    if (this.realStats()) {
      // damage over ~6 s (attacks + each spell at most twice, the ultimate once) x durability (armor / magic resist);
      // that part only changes between steps, so it is worked out once per step (it is read very often)
      const base = Stats.perStep(this, `pw${u.i}`, () => {
        let spells = 0;
        u.champ.spells.forEach((sp, k) => {
          const d = this.spellDmg(u, sp);
          if (d > 0) spells += d * Math.min(k === 3 ? 1 : 2, 6 / Math.max(2, this.cdOf(u, sp, k)));
        });
        return (this.aaDps(u) * 6 + spells) * Math.sqrt(Stats.effectiveHp(this, u) / 1900);
      });
      return base * (u.hp / u.maxHp + 0.35);
    }
    return (this.aaDps(u) * 6 + this.spellDmg(u, u.champ.spells[0] ?? ({ power: 1 } as SpellData)) * 2) * (u.hp / u.maxHp + 0.35) * Math.sqrt(this.maxHp(u) / 1200);
  }
  minute() {
    return this.t / 60;
  }
  laningPhase() {
    return this.t < 14 * 60;
  }

  // ---------- helpers ----------
  fxSeq = 0;
  /** Queue a visual effect; returns it so a caller can still set `miss` after rolling the hit in the same step. */
  fx_(f: Omit<Fx, "t" | "id">): Fx {
    const fx: Fx = { t: this.t, id: ++this.fxSeq, ...f };
    this.fx.push(fx);
    if (this.fx.length > 400) this.fx.splice(0, this.fx.length - 400);
    return fx;
  }
  event(type: EvType, side: SideN, text: string, big: boolean, actor?: number, victim?: number, at?: Vec) {
    const ref = at ?? (victim !== undefined ? this.units[victim] : actor !== undefined ? this.units[actor] : undefined);
    this.events.push({ t: this.t, type, side, text, actor, victim, big, x: ref?.x, y: ref?.y });
  }
  enemies(u: Unit) {
    return this.units.filter((e) => e.side !== u.side && e.alive);
  }
  allies(u: Unit) {
    return this.units.filter((e) => e.side === u.side && e.alive && e !== u);
  }
  setGoal(u: Unit, g: Vec) {
    if (u.goal && Math.abs(u.goal.x - g.x) < 60 && Math.abs(u.goal.y - g.y) < 60) return;
    u.goal = { x: g.x, y: g.y };
    if (ENGINE_FLAGS.nav) {
      u.path = this.aroundTurret(u.side, u, Nav.findPath(u, g));
      return;
    }
    u.path = dist(u, g) > 900 ? findPath(u, g) : [g];
  }
  /** A path from `u` that only passes through the range of an enemy turret with no wave on it (it would shoot the
   *  walker) is bent around it: one extra waypoint just outside the range, on the side the path already leans to. A
   *  path that starts or ends inside the range is left alone (leaving, diving, hitting the turret). */
  aroundTurret(side: SideN, u: Vec, path: Vec[], depth = 0): Vec[] {
    if (!path.length) return path;
    const g = path[path.length - 1];
    const R = 800;
    for (const t of this.turrets) {
      if (!t.alive || t.side === side || dist(t.pos, u) < R + 40 || dist(t.pos, g) < R + 40) continue;
      let a: Vec = u;
      for (const b of path) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const k = clamp(((t.pos.x - a.x) * dx + (t.pos.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
        const cx = a.x + dx * k, cy = a.y + dy * k;
        let nx = cx - t.pos.x, ny = cy - t.pos.y;
        const n = Math.hypot(nx, ny);
        a = b;
        // a path that only clips the edge is through before the turret fires (SIM_TUNE.towerGrace); at 720 from the
        // turret, the old cut-off, the walk through the range took 1.6 s
        if (n >= 770) continue;
        if (this.waveAt(t)) break;
        // straight over the turret: step aside across the walking direction
        if (n < 30) { nx = -dy; ny = dx; }
        const m = Math.hypot(nx, ny) || 1;
        const w = Nav.nearestWalkable({ x: t.pos.x + (nx / m) * 1000, y: t.pos.y + (ny / m) * 1000 });
        if (dist(w, t.pos) < R + 40) break; // a wall on that side: no room to go around
        // the way to the extra waypoint can cut the same range again, and the rest may cross another turret's:
        // look at the bent path once or twice more
        const bent = [...Nav.findPath(u, w), ...Nav.findPath(w, g)];
        return depth < 2 ? this.aroundTurret(side, u, bent, depth + 1) : bent;
      }
    }
    return path;
  }
  speed(u: Unit) {
    const base = u.champ.moveSpeed || 340;
    return (base + 30 + Math.min(60, u.gold / 300)) * (u.baronUntil > this.t ? 1.05 : 1) * Summoners.speedMul(this, u);
  }
  moveStep(u: Unit, dt: number) {
    if (this.t < u.stunUntil) return;
    let budget = this.speed(u) * dt;
    if (ENGINE_FLAGS.nav) {
      Nav.advance(u, budget);
      return;
    }
    while (budget > 0 && u.path.length) {
      const wp = u.path[0];
      const d = dist(u, wp);
      if (d <= budget) {
        u.x = wp.x;
        u.y = wp.y;
        budget -= d;
        u.path.shift();
      } else {
        u.x += ((wp.x - u.x) / d) * budget;
        u.y += ((wp.y - u.y) / d) * budget;
        budget = 0;
      }
    }
  }
  nearestEnemyTurret(u: Unit): TurretState | null {
    let best: TurretState | null = null, bd = Infinity;
    for (const t of this.turrets) {
      if (!t.alive || t.side === u.side) continue;
      const d = dist(u, t.pos);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  frontierTurret(side: SideN, lane: LaneId): TurretState | null {
    // the next standing turret of `side` in `lane` (outermost first)
    const ts = this.turrets.filter((t) => t.side === side && t.lane === lane && t.alive).sort((a, b) => a.tier - b.tier);
    return ts[0] ?? null;
  }
  /** The attacking side's minion wave has reached this turret: it shoots minions, so champions may stand in range. */
  waveAt(t: TurretState): boolean {
    if (t.lane === "nexus") return LANES.some((l) => (t.side === 1 ? this.lanes[l].front >= 0.93 : this.lanes[l].front <= 0.07));
    // by distance, not by lane fraction: 0.045 of a lane is about 1,035 u on top and bot but 760 u on mid, so on the
    // side lanes a wave still outside the turret's own range (780) counted as on it, and on mid one inside it did not
    return this.frontierTurret(t.side, t.lane) === t && dist(this.laneFrontPos(t.lane), t.pos) < SIM_TUNE.waveNear;
  }
  /** The standing enemy turret that has point `p` in range with no wave on it (it would shoot a champion of `side` there). */
  exposedAt(side: SideN, p: Vec, range = 780): TurretState | null {
    for (const t of this.turrets) if (t.alive && t.side !== side && dist(t.pos, p) < range && !this.waveAt(t)) return t;
    return null;
  }
  /** Where a recalled or respawned champion appears: a fixed spot per champion around the fountain, not all on one point. */
  fountainSpot(u: Unit): Vec {
    const f = FOUNTAIN[u.side];
    const a = ((u.i % 5) / 5) * Math.PI * 2 + 0.6;
    return { x: f.x + Math.cos(a) * 120, y: f.y + Math.sin(a) * 120 };
  }
  laneFrontPos(lane: LaneId) {
    return lanePoint(lane, this.lanes[lane].front);
  }
  /** Where a laner of `side` stands relative to the wave: a little toward its own base. */
  laneStand(u: Unit, lane: LaneId) {
    const f = this.lanes[lane].front;
    const back = (u.champ.ranged ? 0.035 : 0.018) * (u.side === 0 ? -1 : 1);
    const p = lanePoint(lane, f + back);
    const jitter = (u.role === "Support" ? 260 : 120);
    return { x: p.x + (this.rng.next() - 0.5) * jitter, y: p.y + (this.rng.next() - 0.5) * jitter };
  }

  // ---------- main tick ----------
  step() {
    if (this.over) return;
    this.t += DT;
    this.spawns();
    this.teamThink();
    for (const u of this.units) this.unitTick(u);
    this.combat();
    if (ENGINE_FLAGS.nav) Nav.separate(this.units, DT);
    this.lanesTick();
    this.objectivesTick();
    this.heraldTick();
    this.economy();
    Items.tick(this);
    this.checkEnd();
  }

  runToEnd(maxT = 60 * 60) {
    while (!this.over && this.t < maxT) this.step();
    if (!this.over) {
      // safety: stronger team breaks the nexus
      const p = [0, 1].map((sd) => this.units.filter((u) => u.side === sd).reduce((a, u) => a + u.gold + u.rating * 100, 0));
      this.finish(p[0] >= p[1] ? 0 : 1);
    }
  }

  spawns() {
    for (const c of this.camps) {
      if (!c.alive && this.t >= c.spawnAt) {
        c.alive = true;
        c.hp = c.maxHp * (1 + this.minute() * GROWTH.campHpGrow);
      }
    }
    for (const k of Object.keys(this.obj) as ObjKey[]) {
      const o = this.obj[k];
      if (!o.alive && o.spawnAt !== null && this.t >= o.spawnAt) {
        if (k === "herald" && this.obj.baron.alive) continue;
        o.alive = true;
        o.maxHp = (k === "baron" ? 9500 : k === "elder" ? 8000 : k === "herald" ? 5200 : k === "grubs" ? 2400 : 3600) * (1 + this.minute() / 40);
        o.hp = o.maxHp;
        if (k === "dragon") this.event("info", 0, `${o.type} 드래곤 등장`, false);
        if (k === "baron") {
          this.event("info", 0, "내셔 남작 등장", false);
          if (this.obj.herald.alive) this.obj.herald.alive = false;
          this.obj.herald.spawnAt = null;
        }
        if (k === "grubs") this.event("info", 0, "공허 유충 등장", false);
        if (k === "herald") this.event("info", 0, "협곡의 전령 등장", false);
      }
    }
    for (const ih of this.inhibs) if (!ih.alive && ih.respawnAt && this.t >= ih.respawnAt) { ih.alive = true; ih.hp = 3000; }
    for (const u of this.units) {
      if (!u.alive && this.t >= u.respawnAt) {
        u.alive = true;
        const f = this.fountainSpot(u);
        u.x = f.x; u.y = f.y;
        u.maxHp = this.maxHp(u);
        u.hp = u.maxHp;
        u.task = "return";
        u.path = [];
        u.goal = null;
        u.lastHitBy.clear();
      }
    }
  }

  /** Team-level calls every few seconds: objectives, grouping, sieges. */
  teamThink() {
    if (ENGINE_FLAGS.macro) {
      Macro.teamThink(this);
      return;
    }
    if (this.t < this.nextTeamThink) return;
    this.nextTeamThink = this.t + 3;
    for (const side of [0, 1] as SideN[]) {
      const mine = this.units.filter((u) => u.side === side && u.alive);
      const theirs = this.units.filter((u) => u.side !== side && u.alive);
      const aggro = this.tactic[side] === "aggressive" ? 0.25 : this.tactic[side] === "safe" ? -0.2 : 0;
      const myPow = mine.reduce((a, u) => a + this.power(u), 0);
      const thPow = theirs.reduce((a, u) => a + this.power(u), 0) || 1;
      const edge = myPow / thPow;
      // objectives in priority order
      const order: ObjKey[] = ["elder", "baron", "dragon", "herald", "grubs"];
      for (const k of order) {
        const o = this.obj[k];
        if (!o.alive) continue;
        const sentAlready = mine.filter((u) => u.task === "obj" && u.objTarget === k);
        let want = 0;
        let who: Unit[] = [];
        // lane priority: who has more people near this pit right now
        const nearMine = mine.filter((u) => dist(u, o.pos) < 5200).length;
        const nearTheirs = theirs.filter((u) => dist(u, o.pos) < 5200).length;
        const prio = (nearMine - nearTheirs) * 0.12;
        const noise = (this.rng.next() - 0.5) * 0.5;
        if (k === "dragon") {
          const near = mine.filter((u) => ["Jungle", "Bot", "Support", "Mid"].includes(u.role));
          want = 0.45 + (edge - 1) * 0.3 + prio + (theirs.length < mine.length ? 0.25 : 0) + (this.dragons[side].length >= 3 ? 0.25 : 0) + aggro * 0.5 + noise;
          who = near;
        } else if (k === "grubs" || k === "herald") {
          want = 0.42 + (edge - 1) * 0.3 + prio + (theirs.length < mine.length ? 0.2 : 0) + aggro * 0.5 + noise;
          who = mine.filter((u) => ["Jungle", "Top", "Mid"].includes(u.role));
        } else {
          // baron / elder: only with a numbers or power lead, all five
          want = (edge - 1.12) * 3 + (theirs.length + 1 < mine.length ? 0.8 : 0) + aggro + (this.minute() > 30 ? 0.15 : 0);
          if (k === "elder") want += 0.3;
          who = mine;
        }
        if (sentAlready.length) continue;
        if (want > 0.62 && this.rng.chance(0.5)) {
          for (const u of who) {
            if (u.task === "recall" || u.task === "fight") continue;
            u.task = "obj";
            u.objTarget = k;
            u.taskUntil = this.t + 60;
          }
        }
      }
      // contest: enemy is on an objective -> answer if not outclassed
      for (const k of Object.keys(this.obj) as ObjKey[]) {
        const o = this.obj[k];
        if (!o.alive) continue;
        const attackers = theirs.filter((u) => u.task === "obj" && u.objTarget === k && dist(u, o.pos) < 1400);
        if (!attackers.length) continue;
        const defending = mine.filter((u) => u.task === "obj" && u.objTarget === k);
        if (defending.length) continue;
        const attPow = attackers.reduce((a, u) => a + this.power(u), 0);
        const responders = mine.filter((u) => dist(u, o.pos) < 7000 && u.task !== "recall");
        const resPow = responders.reduce((a, u) => a + this.power(u), 0);
        const importance = k === "baron" || k === "elder" ? 1.3 : k === "dragon" ? 1 : 0.7;
        const soulPoint = k === "dragon" && (this.dragons[0].length >= 3 || this.dragons[1].length >= 3);
        const contestP = k === "baron" || k === "elder" || soulPoint ? 0.75 : 0.3;
        if (resPow * importance > attPow * (1.05 - aggro) && this.rng.chance(contestP)) {
          for (const u of responders) {
            u.task = "obj";
            u.objTarget = k;
            u.taskUntil = this.t + 45;
          }
        }
      }
      // after the laning phase, a team with an edge groups and sieges
      const sieging = mine.some((u) => u.task === "siege");
      if (!sieging && !this.laningPhase() && mine.length >= 4 && ((theirs.length <= 2 && this.rng.chance(0.5)) || mine.some((u) => u.baronUntil > this.t) || (edge > 1.4 && this.rng.chance(0.04 + aggro * 0.1)))) {
        const lane = this.pickSiegeLane(side);
        if (lane) {
          for (const u of mine) {
            if (u.task === "obj" || u.task === "recall") continue;
            u.task = "siege";
            u.goal = null;
            u.taskUntil = this.t + 40;
            (u as Unit & { siegeLane?: LaneId }).siegeLane = lane;
          }
        }
      }
    }
  }

  pickSiegeLane(side: SideN): LaneId | null {
    const enemy = (1 - side) as SideN;
    let best: LaneId | null = null, bestScore = -Infinity;
    for (const lane of LANES) {
      const t = this.frontierTurret(enemy, lane);
      const inhib = this.inhibs.find((x) => x.side === enemy && x.lane === lane)!;
      if (!t && !inhib.alive) continue;
      const tier = t ? t.tier : 4;
      const score = -tier + (lane === "mid" ? 0.3 : 0) + this.rng.next() * 0.5;
      if (score > bestScore) { bestScore = score; best = lane; }
    }
    if (!best) {
      // all lanes open: go for nexus turrets via mid
      return "mid";
    }
    return best;
  }

  unitTick(u: Unit) {
    if (!u.alive) return;
    // Teleport: channelling, landing, or walking from the landing spot to the fight it came for (summoners.ts)
    if (Summoners.teleportTick(this, u)) return;
    // recall channel
    if (u.task === "recall") {
      if (u.recallEnd !== undefined) {
        if (this.t >= u.recallEnd) {
          const f = this.fountainSpot(u);
          u.x = f.x; u.y = f.y;
          u.maxHp = this.maxHp(u);
          u.hp = u.maxHp;
          u.recallEnd = undefined;
          u.task = "return";
          u.goal = null;
          u.path = [];
        }
        return;
      }
      if (dist(u, FOUNTAIN[u.side]) < 900) {
        u.hp = u.maxHp = this.maxHp(u);
        u.task = "return";
        return;
      }
      // not next to an enemy, and not inside the range of a turret that would shoot the whole channel
      if (!this.enemies(u).some((e) => dist(e, u) < 1300) && !this.exposedAt(u.side, u, 860)) {
        u.recallEnd = this.t + 8;
        u.path = [];
        this.fx_({ kind: "recall", side: u.side, x: u.x, y: u.y, tx: u.x, ty: u.y, color: "#7fd3ff", r: 160, w: 0, from: u.i });
        return;
      }
      // run home first
      this.setGoal(u, FOUNTAIN[u.side]);
      this.moveStep(u, DT);
      return;
    }
    if (u.fightId) {
      // movement inside fights is handled by combat()
      return;
    }
    if (ENGINE_FLAGS.macro && Macro.unitTick(this, u)) return;
    // regen in fountain area
    if (dist(u, FOUNTAIN[u.side]) < 1200) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.08 * DT);
    // decide to recall
    const low = u.hp / u.maxHp < 0.3;
    // gold to spend: go home and buy like real players (items.ts shopUrge); without items.json the old 1500 rule.
    // Laning units run on this path (macro gives them the "old" job), so this is where early recalls come from.
    const urge = Items.shopUrge(this, u);
    const rich = urge !== null ? urge > 0 : u.gold - (u as Unit & { lastShop?: number }).lastShop! > 1500;
    if ((low || (rich && this.rng.chance(urge !== null ? Items.recallChance(urge) : 0.004))) && u.task !== "obj") {
      u.task = "recall";
      (u as Unit & { lastShop?: number }).lastShop = u.gold;
      return;
    }
    if ((u as Unit & { lastShop?: number }).lastShop === undefined) (u as Unit & { lastShop?: number }).lastShop = u.gold;
    // danger: an enemy group nearby that outnumbers us -> fall back toward a turret behind us
    if (u.task !== "gank" && this.t > 120) {
      let foes = 0, friends = 1, fx = 0, fy = 0;
      for (const o of this.units) {
        if (!o.alive || o === u) continue;
        const d = dist(o, u);
        if (d > 2300) continue;
        if (o.side === u.side) friends++;
        else { foes++; fx += o.x; fy += o.y; }
      }
      if (foes >= friends + 2 || (foes >= 3 && foes > friends && u.hp / u.maxHp < 0.6)) {
        const c = { x: fx / foes, y: fy / foes };
        const safe = this.turrets.filter((t) => t.alive && t.side === u.side).map((t) => t.pos)
          .filter((p) => dist(p, c) > dist(u, c) + 300).sort((a, b) => dist(a, u) - dist(b, u))[0] ?? FOUNTAIN[u.side];
        if (u.task === "obj" || u.task === "siege") { u.task = "group"; u.objTarget = undefined; }
        this.setGoal(u, safe);
        u.taskUntil = this.t + 6;
        this.moveStep(u, DT);
        return;
      }
    }
    if (u.task === "obj" && u.objTarget) {
      const o = this.obj[u.objTarget];
      // outnumbered: give the objective up instead of walking in one by one
      const mineAlive = this.units.filter((x) => x.side === u.side && x.alive).length;
      const theirsAlive = this.units.filter((x) => x.side !== u.side && x.alive).length;
      if (mineAlive + 1 < theirsAlive || u.hp / u.maxHp < 0.35) {
        u.task = "group";
        u.objTarget = undefined;
        this.setGoal(u, this.nearestOwnTurret(u)!);
      } else if (!o.alive || this.t > u.taskUntil) {
        u.task = "group";
        u.objTarget = undefined;
      } else {
        const off = { x: o.pos.x + (u.i % 5 - 2) * 140, y: o.pos.y + (u.side ? 220 : -220) };
        this.setGoal(u, off);
        this.moveStep(u, DT);
        return;
      }
    }
    if (u.task === "siege") {
      const lane = (u as Unit & { siegeLane?: LaneId }).siegeLane ?? "mid";
      const mineAlive = this.units.filter((x) => x.side === u.side && x.alive).length;
      const theirsAlive = this.units.filter((x) => x.side !== u.side && x.alive).length;
      if (this.t > u.taskUntil || mineAlive < theirsAlive || u.hp / u.maxHp < 0.3) {
        u.task = "group";
      } else {
        const target = this.siegeTarget((1 - u.side) as SideN, lane);
        if (target) {
          const toward = { x: target.x + (u.side ? 1 : -1) * 350 + (u.i % 5 - 2) * 90, y: target.y + (u.side ? 1 : -1) * 350 };
          this.setGoal(u, toward);
          this.moveStep(u, DT);
          return;
        }
        u.task = "group";
      }
    }
    if (u.role === "Jungle" && this.laningPhase()) {
      this.jungleTick(u);
      return;
    }
    if (this.laningPhase() && u.task !== "roam") {
      const lane = ROLE_LANE[u.role]!;
      if (u.role === "Support" && this.t > 8 * 60 && this.rng.chance(0.0025)) {
        u.task = "roam";
        u.taskUntil = this.t + 35;
        const g = sampleHeat("Support", this.minute(), u.side, () => this.rng.next());
        if (g) this.setGoal(u, g);
      } else {
        u.task = "lane";
        if (!u.goal || this.rng.chance(0.15) || dist(u.goal, this.laneFrontPos(lane)) > 900) this.setGoal(u, this.laneStand(u, lane));
      }
      this.moveStep(u, DT);
      return;
    }
    if (u.task === "roam" && this.t > u.taskUntil) u.task = this.laningPhase() ? "lane" : "group";
    // mid/late game: go where this role usually is at this minute
    if (!u.goal || !u.path.length || this.t > u.taskUntil) {
      u.taskUntil = this.t + 18 + this.rng.next() * 22;
      let g = sampleHeat(u.role, this.minute(), u.side, () => this.rng.next());
      if (!g) g = this.laneFrontPos(ROLE_LANE[u.role] ?? "mid");
      // farm side lanes: snap to a nearby wave if one is close
      for (const lane of LANES) {
        const fp = this.laneFrontPos(lane);
        if (dist(g, fp) < 2200) {
          g = this.laneStand(u, lane);
          break;
        }
      }
      this.setGoal(u, g);
    }
    this.moveStep(u, DT);
  }

  siegeTarget(enemy: SideN, lane: LaneId): Vec | null {
    const t = this.frontierTurret(enemy, lane);
    if (t) return t.pos;
    const ih = this.inhibs.find((x) => x.side === enemy && x.lane === lane);
    if (ih?.alive) return ih.pos;
    const nt = this.turrets.find((x) => x.side === enemy && x.lane === "nexus" && x.alive);
    if (nt) return nt.pos;
    return NEXUS[enemy];
  }

  jungleRoute(u: Unit): number[] {
    const own = this.camps.filter((c) => c.side === u.side && c.kind !== "scuttle");
    const order: CampKind[] = this.rng.next() < 0.7 ? ["blue", "gromp", "wolves", "raptors", "red", "krugs"] : ["red", "krugs", "raptors", "wolves", "blue", "gromp"];
    return order.map((k) => own.find((c) => c.kind === k)!.id);
  }

  jungleTick(u: Unit) {
    const ext = u as Unit & { route?: number[]; gankLane?: LaneId; gankThere?: number; gankOut?: number };
    if (!ext.route) ext.route = this.jungleRoute(u);
    // gank decision
    if (u.task === "gank" && ext.gankLane) {
      const lane = ext.gankLane;
      const foe = this.units.find((e) => e.side !== u.side && e.alive && ROLE_LANE[e.role] === lane && e.role !== "Jungle");
      // the target sits under its turret with no wave of ours on it: wait at the edge of the range instead of walking in
      const tower = foe ? this.exposedAt(u.side, foe, 860) : null;
      const there = !!foe && (dist(u, foe) < SIM_TUNE.gankArrive || (!!tower && dist(u, tower.pos) < 1000));
      if (there) {
        if (ext.gankThere === undefined) ext.gankThere = this.t;
        ext.gankOut = undefined;
      } else if (ext.gankThere !== undefined) {
        // trailing a laner who walks, the jungler drifts in and out of the arrival range: only a full second
        // outside restarts the wait (every single step did, so such a gank ran its whole 28 s)
        ext.gankOut ??= this.t;
        if (this.t - ext.gankOut >= 1) ext.gankThere = ext.gankOut = undefined;
      }
      // arrived and no fight started (combat() would have taken the unit): the gank is not on, back to the camps
      const stale = ext.gankThere !== undefined && this.t - ext.gankThere >= SIM_TUNE.gankWait;
      // after laning the target may walk into its team on the way: give up rather than follow it in
      if (!foe || this.t > u.taskUntil || stale || !this.gankable(foe, lane) || this.gankGone(foe, lane)) {
        u.task = "jungle";
        ext.gankLane = undefined;
        ext.gankThere = ext.gankOut = undefined;
        // also after a chase that never got there: the same lane was picked again in the next step
        if (stale || this.t > u.taskUntil) this.gankCooldown(u);
      } else {
        let g: Vec = { x: foe.x, y: foe.y };
        if (tower) {
          const d = dist(tower.pos, u) || 1;
          g = { x: tower.pos.x + ((u.x - tower.pos.x) / d) * 900, y: tower.pos.y + ((u.y - tower.pos.y) / d) * 900 };
        }
        this.setGoal(u, g);
        this.moveStep(u, DT);
        return;
      }
    }
    // after laning the jungler's own gank roll runs at GROWTH.lateGank of its laning rate (at the full rate a jungler
    // sent to farm after 14:00 spent its time walking to lanes: 2.5 camp CS a minute, LCK 6.2)
    const gankRate = EARLY_TUNE.gankRate * (this.laningPhase() ? 1 : GROWTH.lateGank);
    if (this.t > 195 && u.task !== "gank" && gankRate > 0 && this.gankReady(u) && this.rng.chance(gankRate)) {
      const lane = this.pickGankLane(u);
      if (lane) {
        u.task = "gank";
        ext.gankLane = lane;
        ext.gankThere = undefined;
        u.taskUntil = this.t + 28;
        return;
      }
    }
    // scuttle when it is up and close enough
    const scut = this.camps.filter((c) => c.kind === "scuttle" && c.alive).sort((a, b) => dist(u, a.pos) - dist(u, b.pos))[0];
    let target: CampState | undefined;
    // the scuttle-or-camp choice sticks for 10 s (re-rolling every tick made the jungler's goal flip back and forth)
    const sx = u as Unit & { scutRoll?: { at: number; go: boolean } };
    if (scut && dist(u, scut.pos) < 4500) {
      if (!sx.scutRoll || this.t - sx.scutRoll.at > 10) sx.scutRoll = { at: this.t, go: this.rng.chance(0.6) };
      if (sx.scutRoll.go) target = scut;
    }
    if (!target) {
      // the camp that can be cleared soonest: walk there, or wait at it if it respawns before we would reach another
      // (junglers track their timers; walking to the nearest one that is up sent the engine's jungler across the map
      // while the camp next to it came back seconds later). 370: about a jungler's move speed.
      let bestT = Infinity;
      for (const id of ext.route) {
        const c = this.camps[id];
        const ready = c.alive ? 0 : c.spawnAt - this.t;
        if (ready > 25) continue;
        const tt = Math.max(dist(u, c.pos) / 370, ready);
        if (tt < bestT) { bestT = tt; target = c; }
      }
    }
    if (!target) {
      // nothing up: shadow a lane
      const g = sampleHeat("Jungle", this.minute(), u.side, () => this.rng.next());
      if (g && (!u.goal || !u.path.length)) this.setGoal(u, g);
      this.moveStep(u, DT);
      return;
    }
    u.task = "jungle";
    u.campTarget = target.id;
    if (dist(u, target.pos) > 250) {
      this.setGoal(u, target.pos);
      this.moveStep(u, DT);
      return;
    }
    if (!target.alive) return; // waiting for it to respawn
    // clear the camp
    if (this.rng.chance(0.08)) this.castRandom(u, null, target.pos);
    this.hitCamp(u, target);
  }

  /** One step of a champion clearing a camp (also macro.ts); the kill pays out like the real camp (4 CS each). */
  hitCamp(u: Unit, c: CampState) {
    c.hp -= (this.aaDps(u) * GROWTH.campDpsMul + GROWTH.campDpsAdd) * DT;
    // damage taken per camp kept apart from campHp: the rate follows the camp's health / campHp^2, so a camp that takes
    // campHp times as long to clear costs the same health in all (scaled by the camp's own health alone, campHp 1.6
    // cost 2.6x as much per camp and junglers went home at 28 % hp after 2-4 camps)
    const hurt = (c.maxHp / (GROWTH.campHp * GROWTH.campHp)) * 0.004 * DT * 4 * GROWTH.campHurt;
    u.hp = Math.max(u.maxHp * 0.25, u.hp - hurt);
    // the jungler finishes the camp with Smite once it is within Smite's damage (summoners.ts: charges, upgrades and
    // when a charge is kept for an epic monster)
    if (c.hp > 0 && Summoners.wantsCampSmite(this, u, c)) Summoners.smite(this, u, { camp: c });
    if (c.hp > 0) return;
    c.alive = false;
    const timing = c.kind === "scuttle" ? this.meta.camps.scuttle : this.meta.camps[c.kind];
    c.spawnAt = this.t + (timing?.respawn ?? 135);
    const big = c.kind === "blue" || c.kind === "red";
    u.gold += (big ? 100 : c.kind === "scuttle" ? 120 : 75) * GROWTH.campGold;
    u.xp += big ? GROWTH.campXpBig : GROWTH.campXpSmall;
    u.cs += 4;
    // every camp has one large monster: the jungle pet's treat (Smite's upgrades)
    Summoners.feedPet(this, u);
  }

  /**
   * After laning, a gank target has to be alone at its lane: within 2000 of the wave and with at most one teammate
   * within 1500. Lanes stop being role-bound then (a top laner grouped mid is not "in top"), and ganks picked by role
   * walked into grouped teams: a third ended in the jungler's death, 8.5 % in a takedown. Laning ganks are unchanged.
   */
  gankable(foe: Unit, lane: LaneId): boolean {
    if (this.laningPhase()) return true;
    if (dist(foe, this.laneFrontPos(lane)) > 2000) return false;
    let mates = 0;
    for (const o of this.units) if (o !== foe && o.alive && o.side === foe.side && dist(o, foe) < 1500) mates++;
    return mates <= 1;
  }

  /** After a gank that was called off: no new gank for SIM_TUNE.gankCd seconds (also read by macro.ts). */
  gankCooldown(u: Unit) {
    (u as Unit & { gankCdUntil?: number }).gankCdUntil = this.t + SIM_TUNE.gankCd;
  }
  gankReady(u: Unit): boolean {
    return this.t >= ((u as Unit & { gankCdUntil?: number }).gankCdUntil ?? 0);
  }
  /** The lane's enemy is not there to be ganked: recalling, in its base, or (during laning) away from the wave on its
   *  way back. Junglers used to walk after such a target through the enemy's turrets toward its base. */
  gankGone(foe: Unit, lane: LaneId): boolean {
    if (foe.task === "recall" || dist(foe, FOUNTAIN[foe.side]) < 4500) return true;
    return this.laningPhase() && dist(foe, this.laneFrontPos(lane)) > 2500;
  }

  pickGankLane(u: Unit): LaneId | null {
    let best: LaneId | null = null, bestV = EARLY_TUNE.gankMin;
    for (const lane of LANES) {
      const ally = this.units.find((e) => e.side === u.side && e.alive && ROLE_LANE[e.role] === lane && e.role !== "Support");
      const foe = this.units.find((e) => e.side !== u.side && e.alive && ROLE_LANE[e.role] === lane && e.role !== "Support");
      if (!foe || !ally || !this.gankable(foe, lane) || this.gankGone(foe, lane)) continue;
      const front = this.lanes[lane].front;
      const pushedOnUs = u.side === 0 ? 1 - front : front; // high when the wave sits near our tower
      const v = pushedOnUs * 0.8 + (1 - foe.hp / foe.maxHp) * 0.6 + (lane === "bot" ? 0.1 : 0) + (u.rating - foe.rating) / 100 - dist(u, foe) / 20000;
      if (v > bestV) { bestV = v; best = lane; }
    }
    return best;
  }

  // ---------- combat ----------
  /** Chance per second that u picks a fight with e right now. */
  engageRate(u: Unit, e: Unit, ratio: number, underTurret: boolean, sizes = 2): number {
    const aggro = this.tactic[u.side] === "aggressive" ? 1.4 : this.tactic[u.side] === "safe" ? 0.6 : 1;
    let r: number;
    if (u.task === "gank") {
      r = ratio > 0.8 ? 1.2 : SIM_TUNE.gankPoor;
    } else if (u.task === "siege" || u.task === "obj") {
      r = ratio > 1.15 ? 0.18 : ratio > 0.95 ? 0.04 : 0.008;
    } else if (this.laningPhase()) {
      const lu = ROLE_LANE[u.role], le = ROLE_LANE[e.role];
      // lane opponents are handled by laneDuels(); this covers jungle meetings and roams
      if (lu && lu === le && u.role !== "Jungle" && e.role !== "Jungle") return 0;
      r = ratio > 1.3 ? EARLY_TUNE.meetEdge : EARLY_TUNE.meet;
    } else {
      r = (ratio > 1.35 ? 0.025 : ratio > 1.05 ? 0.008 : ratio > 0.9 ? 0.003 : 0.0008) * PACE_TUNE.engage;
      if (this.minute() > 28) r *= 1.5;
      if (sizes <= 2) r *= 0.3; // lone pick-offs are rarer than group fights
    }
    if (underTurret && ratio < 1.8) r *= 0.25;
    return r * aggro;
  }

  /** Per-lane rates of a committed all-in during laning, per second (EARLY_TUNE). */
  static allinRate(lane: LaneId): number {
    return lane === "top" ? EARLY_TUNE.allinTop : lane === "mid" ? EARLY_TUNE.allinMid : EARLY_TUNE.allinBot;
  }

  /** After the laning phase: two enemies holding the same lane poke each other now and then. No all-in from here
   *  (solo kills are already above LCK); the weaker one keeps its distance (macro.ts keepGap). */
  sideDuels() {
    // pairs of lane holders close to each other: at a wave, or walking the same way to their next lane
    const free = this.units.filter((u) => u.alive && !u.fightId && u.task === "lane" && u.recallEnd === undefined);
    const taken = new Set<number>();
    for (const a of free) {
      if (a.side !== 0) continue;
      let b: Unit | null = null, bd = 1100;
      for (const y of free) {
        if (y.side !== 1 || taken.has(y.i)) continue;
        const d = dist(a, y);
        if (d < bd) { bd = d; b = y; }
      }
      if (!b) continue;
      taken.add(b.i);
      if (!this.rng.chance(SIM_TUNE.sidePoke * DT)) continue;
      // the LCK matchup (matchup.ts) tilts who pokes, whether it lands and how hard, faded after laning
      const mu = Matchup.pairEdge(this, a, b) * Matchup.MATCHUP_TUNE.init;
      const [src, dst] = this.rng.chance(0.5 + (a.rating - b.rating) / 120 + mu) ? [a, b] : [b, a];
      const pokes = src.champ.spells.slice(0, 3).filter((x) => x && POKE_KINDS.has(x.vfx));
      const sp = pokes.length ? pokes[this.rng.int(0, pokes.length - 1)] : undefined;
      if (!sp || this.t < src.cds[sp.key === "Q" ? 0 : sp.key === "W" ? 1 : 2]) continue;
      const fx = this.emitSpellFx(src, sp, dst, dst, false);
      if (this.rng.chance(clamp(0.5 + (src.rating - dst.rating) / 120 + (src === a ? mu : -mu), 0.2, 0.85))) {
        this.hitFx(src, dst, sp);
        this.damage(src, dst, dst.maxHp * this.rng.range(SIM_TUNE.sidePokeLo, SIM_TUNE.sidePokeHi) * Matchup.dmgMul(this, src, dst));
      } else fx.miss = true;
    }
  }

  /** Laning: small pokes most of the time, a rare all-in that can become a solo kill. */
  laneDuels() {
    if (this.t < 70) return;
    if (!this.laningPhase()) {
      this.sideDuels();
      return;
    }
    for (const lane of LANES) {
      const sideUnits = [0, 1].map((sd) => this.units.filter((u) => u.side === sd && u.alive && !u.fightId && u.task === "lane" && ROLE_LANE[u.role] === lane && u.recallEnd === undefined));
      if (!sideUnits[0].length || !sideUnits[1].length) continue;
      const a = sideUnits[0][0], b = sideUnits[1][0];
      if (dist(a, b) > 1300) continue;
      // the lane's LCK matchup (matchup.ts, from blue's side): who pokes, whether it lands, how hard, who wants to all-in
      const mu = Matchup.laneEdge(this, a);
      // poke
      if (this.rng.chance(0.09 * DT)) {
        const [src, dst] = this.rng.chance(0.5 + (a.rating - b.rating) / 120 + mu * Matchup.MATCHUP_TUNE.init) ? [a, b] : [b, a];
        // pokes only use spells that hit from where the caster stands (no dashes, no ally heals/shields, no self buffs)
        const pokes = src.champ.spells.slice(0, 3).filter((x) => x && POKE_KINDS.has(x.vfx));
        const sp = pokes.length ? pokes[this.rng.int(0, pokes.length - 1)] : undefined;
        if (sp && this.t >= src.cds[sp.key === "Q" ? 0 : sp.key === "W" ? 1 : 2]) {
          const fx = this.emitSpellFx(src, sp, dst, dst, false);
          const tilt = (src.side === 0 ? mu : -mu) * Matchup.MATCHUP_TUNE.init;
          if (this.rng.chance(clamp(0.5 + (src.rating - dst.rating) / 120 + tilt, 0.2, 0.85))) {
            this.hitFx(src, dst, sp);
            this.damage(src, dst, dst.maxHp * this.rng.range(0.05, 0.13) * Matchup.dmgMul(this, src, dst));
          } else fx.miss = true;
        }
      }
      const pa = sideUnits[0].reduce((s, u) => s + this.power(u), 0) * Math.exp(Matchup.MATCHUP_TUNE.dmg * mu);
      const pb = sideUnits[1].reduce((s, u) => s + this.power(u), 0) * Math.exp(-Matchup.MATCHUP_TUNE.dmg * mu);
      const ratio = Math.max(pa / pb, pb / pa);
      const lowHp = Math.min(...[...sideUnits[0], ...sideUnits[1]].map((u) => u.hp / u.maxHp));
      const rate = Engine.allinRate(lane) * (1 + Math.max(0, ratio - 1) * 3) * (lowHp < 0.45 ? 3 : 1) *
        (this.tactic[0] === "aggressive" || this.tactic[1] === "aggressive" ? 1.4 : 1);
      if (this.rng.chance(rate * DT * 4)) {
        const id = ++this.fightSeq;
        this.fights.set(id, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, start: this.t, last: this.t, origin: "allin" });
        for (const u of [...sideUnits[0], ...sideUnits[1]]) this.joinFight(u, id);
      }
    }
  }

  /** Flash out of a lost fight once every 5 minutes. */
  tryFlash(u: Unit): boolean {
    return this.flashToward(u, this.nearestOwnTurret(u)!, "escape");
  }
  /**
   * Flash: up to 420 u toward `p`, stopping `stop` short of it (an engage lands just inside its spell's reach).
   * False when the champion has no Flash or it is on cooldown (summoners.ts keeps the 300 s; it was a private timer
   * here, and every champion had the spell whether it took it or not).
   */
  flashToward(u: Unit, p: Vec, why: "escape" | "engage", stop = 0): boolean {
    if (!Summoners.isReady(this, u, "flash")) return false;
    const len = Math.min(420, dist(u, p) - stop);
    if (len < 60) return false;
    Summoners.spend(this, u, "flash", { why, quiet: true });
    const ang = Math.atan2(p.y - u.y, p.x - u.x);
    const from = { x: u.x, y: u.y };
    if (ENGINE_FLAGS.nav) {
      const q = Nav.blinkLanding(from, { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len }, len, true);
      u.x = q.x;
      u.y = q.y;
      u.path = [];
      u.goal = null;
    } else {
      u.x += Math.cos(ang) * len;
      u.y += Math.sin(ang) * len;
    }
    // blink: x,y = landing point, tx,ty = start (vfx.ts contract)
    this.fx_({ kind: "blink", side: u.side, x: u.x, y: u.y, tx: from.x, ty: from.y, color: "#fff3a0", r: 120, w: 0, from: u.i, text: "점멸", sum: "flash" });
    return true;
  }

  combat() {
    if (ENGINE_FLAGS.fight) {
      Fight.combat(this);
      return;
    }
    // orphaned fight ids (fight ended while the unit was joining)
    for (const u of this.units) if (u.fightId && !this.fights.has(u.fightId)) this.leaveFight(u);
    this.laneDuels();
    const alive = this.units.filter((u) => u.alive && u.recallEnd === undefined);
    const calm = (x: Unit) => ((x as Unit & { calmUntil?: number }).calmUntil ?? 0) > this.t;
    for (const u of alive) {
      if (u.fightId || calm(u)) continue;
      for (const e of alive) {
        if (e.side === u.side || calm(e)) continue;
        const d = dist(u, e);
        if (d > 1050) continue;
        if (e.fightId) {
          if (d < 1400 && this.fights.has(e.fightId)) this.joinFight(u, e.fightId);
          break;
        }
        const myGroup = alive.filter((x) => x.side === u.side && !x.fightId && dist(x, u) < 1500);
        const theirGroup = alive.filter((x) => x.side === e.side && !x.fightId && dist(x, e) < 1500);
        const mp = myGroup.reduce((a, x) => a + this.power(x), 0);
        const tp = theirGroup.reduce((a, x) => a + this.power(x), 0) || 1;
        const ratio = mp / tp;
        const underTurret = this.turrets.some((t) => t.alive && t.side === e.side && dist(t.pos, e) < 800);
        if (this.rng.chance(clamp(this.engageRate(u, e, ratio, underTurret, myGroup.length + theirGroup.length) * DT, 0, 0.9))) {
          const id = ++this.fightSeq;
          const trade = this.laningPhase() && myGroup.length + theirGroup.length <= 3 && u.task !== "gank";
          const origin = u.task === "gank" ? "gank" : u.task === "siege" ? "siege" : u.task === "obj" ? "obj" : this.laningPhase() ? "early" : "mid";
          this.fights.set(id, { x: (u.x + e.x) / 2, y: (u.y + e.y) / 2, start: this.t, last: this.t, trade, origin });
          for (const x of [...myGroup, ...theirGroup]) this.joinFight(x, id);
          break;
        }
        if (ratio < 0.6 && u.task !== "obj" && u.task !== "siege") {
          const home = this.nearestOwnTurret(u);
          if (home) this.setGoal(u, home);
        }
      }
    }
    for (const [id, f] of this.fights) {
      const members = this.units.filter((x) => x.fightId === id && x.alive);
      const sides = new Set(members.map((m) => m.side));
      if (members.length) {
        f.x = members.reduce((a, m) => a + m.x, 0) / members.length;
        f.y = members.reduce((a, m) => a + m.y, 0) / members.length;
      }
      const trade = (f as { trade?: boolean }).trade;
      const maxLen = trade ? 3.5 + this.rng.next() * 2 : this.minute() > 24 ? 20 : 12;
      // an even trade usually ends with both backing off; a big lead turns it into an all-in
      const lowest = Math.min(...members.map((m) => m.hp / m.maxHp));
      const allIn = trade && lowest < 0.35;
      if (sides.size < 2 || this.t - f.start > (allIn ? maxLen + 4 : maxLen)) {
        this.endFight(id);
        continue;
      }
      // the side that is clearly losing pulls out together
      if (this.t - f.start > 2) {
        const pw = [0, 0];
        for (const m of members) pw[m.side] += this.power(m);
        for (const sd of [0, 1] as SideN[]) {
          const late = this.minute() > 24;
          if (pw[sd] < pw[1 - sd] * (late ? 0.7 : 0.88) && this.rng.chance(late ? 0.12 : 0.3)) {
            for (const m of members.filter((x) => x.side === sd)) {
              if (m.hp / m.maxHp < 0.4 && this.tryFlash(m)) { /* flashed */ }
              this.leaveFight(m);
              (m as Unit & { calmUntil?: number }).calmUntil = this.t + 5;
              this.setGoal(m, this.nearestOwnTurret(m)!);
            }
          }
        }
      }
      for (const u of this.units) {
        if (!u.alive || u.fightId || u.recallEnd !== undefined) continue;
        const dd = dist(u, f);
        if (dd < 1300 && !trade) this.joinFight(u, id);
        else if (dd < 4000 && members.length >= 3 && u.task !== "recall" && this.rng.chance(0.06)) this.setGoal(u, f);
      }
      for (const m of members) this.fightAct(m, members);
    }
  }

  endFight(id: number) {
    for (const u of this.units) if (u.fightId === id) this.leaveFight(u);
    this.fights.delete(id);
  }

  nearestOwnTurret(u: Unit): Vec | null {
    let best: Vec | null = null, bd = Infinity;
    for (const t of this.turrets) {
      if (!t.alive || t.side !== u.side) continue;
      const d = dist(u, t.pos);
      if (d < bd) { bd = d; best = t.pos; }
    }
    return best ?? FOUNTAIN[u.side];
  }

  joinFight(u: Unit, id: number) {
    if (u.fightId === id) return;
    u.fightId = id;
    u.task = "fight";
    const f = this.fights.get(id);
    if (f) f.size = (f.size ?? 0) + 1;
  }
  leaveFight(u: Unit) {
    u.fightId = 0;
    u.task = this.laningPhase() ? (u.role === "Jungle" ? "jungle" : "lane") : "group";
    u.goal = null;
    u.path = [];
    if (u.alive && u.hp / u.maxHp < 0.35) u.task = "recall";
  }

  fightAct(u: Unit, members: Unit[]) {
    if (!u.alive || this.t < u.stunUntil) return;
    const foes = members.filter((m) => m.side !== u.side && m.alive);
    if (!foes.length) return;
    // flee when nearly dead and the fight is lost
    const allies = members.filter((m) => m.side === u.side && m.alive);
    const myFrac = u.hp / u.maxHp;
    const foeFrac = foes.reduce((a, f) => a + f.hp / f.maxHp, 0) / foes.length;
    const losing = foes.length > allies.length || myFrac < foeFrac - 0.15;
    if (myFrac < 0.35 && losing && this.rng.chance(0.35)) {
      if (myFrac < 0.2) this.tryFlash(u);
      this.leaveFight(u);
      (u as Unit & { calmUntil?: number }).calmUntil = this.t + 5;
      u.task = "recall";
      this.setGoal(u, this.nearestOwnTurret(u)!);
      return;
    }
    // target: lowest effective hp in reach, carries preferred
    const target = foes
      .map((f) => ({ f, v: f.hp + dist(u, f) * 0.8 - (f.role === "Bot" || f.role === "Mid" ? 150 : 0) }))
      .sort((a, b) => a.v - b.v)[0].f;
    const range = u.champ.ranged ? Math.max(450, u.champ.attackRange) : 200;
    const d = dist(u, target);
    if (d > range) {
      u.path = [{ x: target.x, y: target.y }];
      this.moveStep(u, DT);
    } else if (u.champ.ranged && d < range * 0.6 && this.rng.chance(0.3)) {
      // kite back
      const ang = Math.atan2(u.y - target.y, u.x - target.x);
      u.path = [{ x: u.x + Math.cos(ang) * 120, y: u.y + Math.sin(ang) * 120 }];
      this.moveStep(u, DT);
    }
    // spells first
    for (let k = 0; k < 4; k++) {
      const sp = u.champ.spells[k];
      if (!sp || this.t < u.cds[k]) continue;
      const reach = Math.max(range + 150, Math.min(sp.range || 600, 1400));
      if (sp.vfx !== "global" && d > reach) continue;
      if (k === 3 && foes.length === 1 && target.hp / target.maxHp < 0.2) continue; // do not waste ult
      if (!this.rng.chance(k === 3 ? 0.3 : 0.35)) continue;
      this.cast(u, k, target, members);
      break;
    }
    // auto attacks
    if (d <= range + 30) {
      const dmg = this.aaDps(u) * DT * this.rng.range(0.75, 1.25);
      this.damage(u, target, dmg);
      if (u.champ.ranged && this.rng.chance(0.35)) this.fx_({ kind: "aa", side: u.side, x: u.x, y: u.y, tx: target.x, ty: target.y, color: u.side ? "#ff8a8a" : "#8ab8ff", r: 0, w: 0, from: u.i, to: target.i });
    }
    // turrets shoot divers
    for (const t of this.turrets) {
      if (!t.alive || t.side === u.side) continue;
      if (dist(t.pos, u) < 780 && this.rng.chance(0.5)) {
        const dmg = (180 + this.minute() * 6) * DT * 2;
        this.damage(null, u, dmg);
        if (this.rng.chance(0.4)) this.fx_({ kind: "tower", side: t.side, x: t.pos.x, y: t.pos.y, tx: u.x, ty: u.y, color: t.side ? "#ff6b6b" : "#6ba8ff", r: 0, w: 0, to: u.i });
      }
    }
  }

  /** Jungle-clear cast (drawn small and faint). Dashes are skipped (the caster does not move here); heals/shields/self buffs target the caster. */
  castRandom(u: Unit, target: Unit | null, at: Vec) {
    const k = this.rng.int(0, 2);
    const sp = u.champ.spells[k];
    if (!sp || this.t < u.cds[k]) return;
    if (sp.vfx === "dash" || sp.vfx === "blink") return;
    u.cds[k] = this.t + this.cdOf(u, sp, k);
    const onSelf = sp.vfx === "heal" || sp.vfx === "shield" || sp.vfx === "self" || sp.vfx === "stealth" || sp.vfx === "summon";
    if (onSelf) this.emitSpellFx(u, sp, u, u, true);
    else this.emitSpellFx(u, sp, target, at, true);
  }

  cdOf(u: Unit, sp: SpellData, k: number) {
    if (this.realStats()) {
      // the spell's cooldown at its rank with ability haste; the kit's / champions.json's when the data has none
      const real = Stats.cooldown(this, u, k) ?? (sp.cd || (k === 3 ? 100 : 10)) * 100 / (100 + Stats.stats(this, u).haste);
      return Math.max(k === 3 ? 20 : 2, real);
    }
    const base = sp.cd || (k === 3 ? 100 : 10);
    const haste = 1 - Math.min(0.4, u.level * 0.012 + this.itemPower(u) * 0.03);
    return Math.max(k === 3 ? 40 : 3, base * haste);
  }

  cast(u: Unit, k: number, target: Unit, members: Unit[]) {
    const sp = u.champ.spells[k];
    u.cds[k] = this.t + this.cdOf(u, sp, k);
    const kind = sp.vfx;
    const friendly = kind === "shield" || kind === "heal";
    if (friendly) {
      const ally = members.filter((m) => m.side === u.side && m.alive).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] ?? u;
      const amount = this.spellDmg(u, sp) * 0.9;
      if (kind === "heal") ally.hp = Math.min(ally.maxHp, ally.hp + amount);
      else ally.shield += amount;
      this.emitSpellFx(u, sp, ally, ally, false);
      return;
    }
    let fx: Fx;
    if (kind === "dash" || kind === "blink") {
      const ang = Math.atan2(target.y - u.y, target.x - u.x);
      const len = Math.min(dist(u, target) - 80, kind === "blink" ? 450 : 600);
      const from = { x: u.x, y: u.y };
      if (len > 0) {
        const to = { x: u.x + Math.cos(ang) * len, y: u.y + Math.sin(ang) * len };
        const p = ENGINE_FLAGS.nav ? Nav.blinkLanding(from, to, len, kind === "blink") : to;
        u.x = p.x;
        u.y = p.y;
      }
      fx = this.emitSpellFx(u, sp, target, from, false);
    } else if (kind === "stealth" || kind === "self" || kind === "summon") {
      fx = this.emitSpellFx(u, sp, target, u, false);
    } else {
      fx = this.emitSpellFx(u, sp, target, target, false);
    }
    // hit or miss
    const skillshot = kind === "line" || kind === "cone" || kind === "circle" || kind === "global" || kind === "wall";
    const stunned = this.t < target.stunUntil;
    const hitP = skillshot ? clamp(0.52 + (u.rating - target.rating) / 140 + (stunned ? 0.4 : 0), 0.2, 0.96) : 0.95;
    const aoe = kind === "circle" || kind === "cone" || kind === "zone" || kind === "knockup" || kind === "wall" || (kind === "line" && (sp.width ?? 0) > 200);
    const radius = Math.max(220, sp.radius ?? 250);
    const victims = aoe ? members.filter((m) => m.side !== u.side && m.alive && dist(m, target) < radius) : [target];
    let hitMain = false;
    for (const v of victims) {
      if (!this.rng.chance(v === target ? hitP : hitP * 0.7)) continue;
      if (v === target) hitMain = true;
      this.hitFx(u, v, sp);
      const dmg = this.spellDmg(u, sp) * this.rng.range(0.85, 1.15);
      this.damage(u, v, dmg);
      if (sp.cc || kind === "knockup" || kind === "wall") {
        v.stunUntil = Math.max(v.stunUntil, this.t + (k === 3 ? 1.5 : 0.8));
      }
    }
    if (!hitMain) fx.miss = true;
  }

  /** One skill effect. Returns the Fx so the caller can mark `miss` once the hit is rolled (same step). */
  emitSpellFx(u: Unit, sp: SpellData, target: Unit | null, at: Vec, pve: boolean): Fx {
    const color = u.champ.color || (u.side ? "#ff6b6b" : "#5aa9ff");
    return this.fx_({
      kind: sp.vfx, side: u.side, x: u.x, y: u.y, tx: at.x, ty: at.y, color,
      r: sp.radius ?? 250, w: sp.width ?? 120, from: u.i, to: target?.i, text: pve ? undefined : sp.name,
      key: sp.key, icon: sp.icon, also: sp.also, pve: pve || undefined,
    });
  }

  /** One "hit" effect per victim a skill lands on (vfx.ts flashes the victim when the projectile arrives). */
  hitFx(u: Unit, v: Unit, sp: SpellData) {
    const knock = sp.vfx === "knockup" || sp.also === "knockup";
    this.fx_({
      kind: "hit", side: u.side, x: v.x, y: v.y, tx: v.x, ty: v.y, color: u.champ.color || (u.side ? "#ff6b6b" : "#5aa9ff"),
      r: 0, w: 0, from: u.i, to: v.i, key: sp.key, also: knock ? "knockup" : undefined,
    });
  }

  damage(src: Unit | null, v: Unit, amount: number) {
    if (!v.alive) return;
    let a = amount;
    if (v.shield > 0) {
      const absorbed = Math.min(v.shield, a);
      v.shield -= absorbed;
      a -= absorbed;
    }
    v.hp -= a;
    if (src) {
      src.dmg += a;
      v.lastHitBy.set(src.i, this.t);
    }
    if (v.hp <= 0) this.kill(src, v);
  }

  kill(src: Unit | null, v: Unit) {
    const fight = v.fightId ? this.fights.get(v.fightId) : undefined;
    const fo = fight?.origin ?? (v.fightId ? "?" : "nofight");
    const oneVsOne = !fight || (fight.size ?? 2) <= 2;
    this.killOrigin[fo] = (this.killOrigin[fo] ?? 0) + 1;
    v.alive = false;
    v.hp = 0;
    v.d += 1;
    v.fightId = 0;
    v.task = "return";
    v.path = [];
    const lvl = v.level;
    const timer = Math.min(75, 6 + lvl * 2.5 + Math.max(0, (this.t - 900) / 60) * 0.9);
    v.respawnAt = this.t + timer;
    const killerSide = (1 - v.side) as SideN;
    this.kills[killerSide] += 1;
    // credit
    let killer = src && src.side !== v.side ? src : null;
    const recent = [...v.lastHitBy.entries()].filter(([, t]) => this.t - t < 10).map(([i]) => this.units[i]).filter((x) => x.side !== v.side);
    if (!killer && recent.length) killer = recent[recent.length - 1];
    const assists = recent.filter((x) => x !== killer);
    // kill gold and shutdown (제압골) fitted on real LCK games (items.ts); without items.json the old flat rule
    const kg = Items.killGold(this, killer, v, assists, !this.firstBlood);
    const wasShutdown = kg ? kg.shutdown >= 250 : v.streak >= 3;
    v.streak = 0;
    const bounty = kg ? kg.bounty + kg.shutdown : 300 + (wasShutdown ? 150 + Math.min(700, (v.k - v.d) * 50) : 0) + (this.firstBlood ? 0 : 100);
    this.fx_({ kind: "kill", side: killerSide, x: v.x, y: v.y, tx: v.x, ty: v.y, color: killerSide ? "#ff5a5a" : "#5aa9ff", r: 200, w: 0, to: v.i, from: killer?.i });
    if (killer) {
      killer.k += 1;
      killer.streak += 1;
      killer.gold += bounty;
      killer.xp += 220 + lvl * 25;
      // multikill window
      if (this.t - killer.multi.last <= (killer.multi.n === 4 ? 30 : 10)) killer.multi.n += 1;
      else killer.multi.n = 1;
      killer.multi.last = this.t;
    }
    for (const a of assists) {
      a.a += 1;
      a.gold += kg ? kg.assist : Math.round(150 / Math.max(1, assists.length)) + 20;
      a.xp += 120;
    }
    const kName = killer ? `${killer.name}(${killer.champ.name})` : "포탑";
    const vName = `${v.name}(${v.champ.name})`;
    if (!this.firstBlood) {
      this.firstBlood = true;
      this.event("first_blood", killerSide, `퍼스트 블러드! ${kName} → ${vName}`, true, killer?.i, v.i);
    } else if (killer && !assists.length && oneVsOne && this.allies(killer).every((x) => dist(x, v) > 1600)) {
      this.event("solo", killerSide, `솔로 킬! ${ROLE_KO[killer.role]} ${josa(kName, "이가")} ${josa(vName, "을를")} 잡았습니다`, true, killer.i, v.i);
    } else {
      this.event("kill", killerSide, `${kName} → ${vName}`, false, killer?.i, v.i);
    }
    if (wasShutdown && killer) {
      const extra = kg ? ` (제압골 ${kg.shutdown}골드)` : "";
      this.event("shutdown", killerSide, `셧다운! ${josa(kName, "이가")} ${v.name}의 연속 킬을 끊었습니다${extra}`, false, killer.i, v.i);
    }
    if (killer && killer.multi.n >= 2) {
      const n = killer.multi.n;
      const t: EvType = n === 2 ? "double" : n === 3 ? "triple" : n === 4 ? "quadra" : "penta";
      const label = n === 2 ? "더블 킬" : n === 3 ? "트리플 킬" : n === 4 ? "쿼드라 킬" : "펜타 킬";
      if (n <= 5) this.event(t, killerSide, `${label}! ${kName}`, true, killer.i);
    }
    if (this.units.filter((x) => x.side === v.side).every((x) => !x.alive)) {
      this.event("ace", killerSide, `에이스! ${josa(this.names[killerSide], "이가")} 상대 다섯 명을 모두 잡았습니다`, true, undefined, v.i);
    }
  }

  // ---------- lanes, turrets, structures ----------
  lanesTick() {
    if (this.t < 55) return;
    // blue power / red power, clamped, for map pressure after laning
    const tp = [0, 1].map((sd) => this.units.filter((u) => u.side === sd && u.alive).reduce((a, u) => a + this.power(u), 0));
    const powRatio = clamp((tp[0] + 1) / (tp[1] + 1), 0.5, 2);
    for (const lane of LANES) {
      const L = this.lanes[lane];
      const fp = lanePoint(lane, L.front);
      const push = [0, 0];
      for (const u of this.units) {
        if (!u.alive || u.fightId) continue;
        const d = dist(u, fp);
        // a sieging group shoves the wave it is walking in with (SIM_TUNE.siegePush): it can no longer hit a turret before the wave is there
        if (d < 1300) push[u.side] += (0.6 + u.champ.style.waveclear * 0.06 + this.itemPower(u) * 0.15 + (u.baronUntil > this.t ? 1.2 : 0)) * (u.task === "siege" ? SIM_TUNE.siegePush : 1);
      }
      // super minions
      for (const side of [0, 1] as SideN[]) {
        const enemyInhib = this.inhibs.find((x) => x.side !== side && x.lane === lane);
        if (enemyInhib && !enemyInhib.alive) push[side] += 0.9;
      }
      let dir = (push[0] - push[1]) * 0.0009 + (this.rng.next() - 0.5) * 0.0012;
      if (this.laningPhase()) dir += (0.5 - L.front) * 0.0006; // waves drift back to the middle
      else dir += (powRatio - 1) * 0.0012; // map pressure: the stronger team crashes waves into towers
      let nf = clamp(L.front + dir * DT * 4, 0.04, 0.96);
      // standing turrets stop the wave
      const redT = this.frontierTurret(1, lane);
      const blueT = this.frontierTurret(0, lane);
      const redInhib = this.inhibs.find((x) => x.side === 1 && x.lane === lane)!;
      const blueInhib = this.inhibs.find((x) => x.side === 0 && x.lane === lane)!;
      const redStop = redT ? redT.u - 0.02 : redInhib.alive ? laneU(lane, redInhib.pos) - 0.02 : 0.95;
      const blueStop = blueT ? blueT.u + 0.02 : blueInhib.alive ? laneU(lane, blueInhib.pos) + 0.02 : 0.05;
      nf = clamp(nf, blueStop, redStop);
      L.front = nf;
      // structure damage when the wave sits on it
      if (nf >= redStop - 0.005) this.hitStructure(0, lane, push[0]);
      if (nf <= blueStop + 0.005) this.hitStructure(1, lane, push[1]);
    }
    // champions sieging a structure
    for (const u of this.units) {
      if (!u.alive || u.fightId) continue;
      for (const t of this.turrets) {
        if (!t.alive || t.side === u.side || dist(t.pos, u) > 750) continue;
        const defenders = this.units.some((e) => e.alive && e.side === t.side && dist(e, t.pos) < 1300);
        if (defenders && this.laningPhase()) continue;
        this.damageTurret(t, this.aaDps(u) * (this.minute() > 20 ? 0.75 : 0.55) * PACE_TUNE.towerDmg * DT, u);
      }
      for (const ih of this.inhibs) {
        if (!ih.alive || ih.side === u.side || dist(ih.pos, u) > 700) continue;
        if (this.turrets.some((t) => t.alive && t.side === ih.side && t.lane === ih.lane)) continue;
        ih.hp -= this.aaDps(u) * PACE_TUNE.towerDmg * DT;
        if (ih.hp <= 0) this.destroyInhib(ih, u.side);
      }
      if (dist(NEXUS[1 - u.side], u) < 900) {
        const standing = this.turrets.some((t) => t.alive && t.side !== u.side && t.lane === "nexus");
        const anyInhib = this.inhibs.some((x) => x.side !== u.side && !x.alive);
        if (!standing && anyInhib) {
          this.nexus[1 - u.side] -= this.aaDps(u) * DT;
          if (this.nexus[1 - u.side] <= 0) this.finish(u.side);
        }
      }
    }
  }

  hitStructure(attacker: SideN, lane: LaneId, push: number) {
    const enemy = (1 - attacker) as SideN;
    const t = this.frontierTurret(enemy, lane);
    const champs = this.units.filter((u) => u.alive && u.side === attacker && !u.fightId && t && dist(u, t.pos) < 900);
    const minionDps = (14 + push * 4) * (this.laningPhase() ? 0.55 : 1) * (1 + Math.max(0, this.minute() - 20) / 15) * PACE_TUNE.minionDmg;
    if (t) {
      this.damageTurret(t, minionDps * DT, champs[0] ?? null);
      return;
    }
    const ih = this.inhibs.find((x) => x.side === enemy && x.lane === lane)!;
    if (ih.alive) {
      ih.hp -= minionDps * DT;
      if (ih.hp <= 0) this.destroyInhib(ih, attacker);
    }
  }

  damageTurret(t: TurretState, amount: number, by: Unit | null) {
    t.hp -= amount;
    if (t.tier === 1 && t.plates > 0 && this.t < 14 * 60) {
      const plateHp = t.maxHp - (5 - t.plates + 1) * (t.maxHp / 5);
      if (t.hp <= plateHp) {
        t.plates -= 1;
        if (by) by.gold += 125;
      }
    }
    if (t.hp <= 0 && t.alive) {
      t.alive = false;
      const side = (1 - t.side) as SideN;
      this.towers[side] += 1;
      for (const u of this.units) if (u.side === side) u.gold += by && u === by ? 300 : 70;
      const where = t.lane === "nexus" ? "쌍둥이" : `${t.lane === "top" ? "탑" : t.lane === "mid" ? "미드" : "바텀"} ${t.tier}차`;
      if (!this.firstTurret) {
        this.firstTurret = true;
        this.event("first_turret", side, `첫 포탑! ${josa(this.names[side], "이가")} ${where} 포탑을 파괴했습니다`, true, undefined, undefined, t.pos);
      } else this.event("turret", side, `${this.names[side]} ${where} 포탑 파괴`, false, undefined, undefined, t.pos);
    }
  }

  destroyInhib(ih: InhibState, by: SideN) {
    ih.alive = false;
    ih.hp = 0;
    ih.respawnAt = this.t + 300;
    this.event("inhib", by, `${this.names[by]}, ${ih.lane === "top" ? "탑" : ih.lane === "mid" ? "미드" : "바텀"} 억제기 파괴!`, true, undefined, undefined, ih.pos);
  }

  // ---------- objectives ----------
  objectivesTick() {
    for (const k of Object.keys(this.obj) as ObjKey[]) {
      const o = this.obj[k];
      if (!o.alive) continue;
      const at = this.units.filter((u) => u.alive && !u.fightId && dist(u, o.pos) < 650 && (!ENGINE_FLAGS.macro || Macro.hitsObjective(this, u, k)));
      if (!at.length) {
        // nobody is hitting it (a fight over it): a jungler in reach whose Smite covers what is left still takes it
        const fin = ObjSmite.finish(this, k, at, [0, 0]);
        if (fin) { this.takeObjective(k, fin); continue; }
        // it does not heal while it is being fought over: champions in a fight at the pit (nobody in a fight can hit
        // it) or walking in on it. It keeps the damage it has taken, so the side that wins the fight finishes it.
        // Before, it healed 2 % a second through the fight (30 % over a 15 s fight) and the take started over.
        // Bystanders do not count (both river scuttles are 1,000 u from a pit).
        if (!this.units.some((u) => u.alive && (u.fightId !== 0 || u.task === "obj") && dist(u, o.pos) < OBJ_LEASH)) o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.02 * DT);
        continue;
      }
      const bySide = [0, 0];
      for (const u of at) bySide[u.side] += this.aaDps(u) * 1.2 + 30;
      const contested = bySide[0] > 0 && bySide[1] > 0;
      const mul = DT * (contested ? 0.5 : 1);
      o.hp -= (bySide[0] + bySide[1]) * mul;
      ObjSmite.dealt(this, k, [bySide[0] * mul, bySide[1] * mul]);
      if (this.rng.chance(0.15)) {
        const hitter = at[Math.floor(this.rng.next() * at.length)];
        this.fx_({ kind: "objhit", side: hitter.side, x: hitter.x, y: hitter.y, tx: o.pos.x, ty: o.pos.y, color: "#ffd36b", r: 0, w: 0, from: hitter.i });
      }
      // last hit: a Smite fight between the junglers in reach, or the team's damage (objsmite.ts; T12's rule was the
      // taking side's jungler finishing it at its Smite damage, with a flat steal roll for the other jungler)
      const fin = ObjSmite.finish(this, k, at, bySide);
      if (fin) this.takeObjective(k, fin);
    }
  }

  /** The last hit on an epic monster: the taker's Smite if it was one, the effect, the reward and the pet's treat. */
  takeObjective(k: ObjKey, fin: ObjSmite.Finish) {
    const o = this.obj[k];
    const { side, taker, steal } = fin;
    // the jungler's Smite takes the last hit (anyone else's, or one with no charge left, is just the last hit: no
    // spell to show)
    const smote = fin.smote && Summoners.smite(this, taker, { obj: k }, { quiet: true, why: steal ? "steal" : "obj" }) > 0;
    this.fx_({ kind: "smite", side, x: o.pos.x, y: o.pos.y, tx: o.pos.x, ty: o.pos.y, color: "#ffe28a", r: 320, w: 0, from: taker.i, sum: smote ? "smite" : undefined });
    // the jungle pet eats a treat for an epic monster its team takes with the jungler there
    const pet = this.units.find((u) => u.side === side && u.role === "Jungle" && u.alive && dist(u, o.pos) < 1500);
    this.secure(k, side, taker, steal);
    if (pet) Summoners.feedPet(this, pet);
  }

  secure(k: ObjKey, side: SideN, taker: Unit, steal: boolean) {
    const o = this.obj[k];
    const team = this.names[side];
    const respawn = this.meta.objectives[k]?.respawn ?? null;
    const mates = this.units.filter((u) => u.side === side);
    // epic monsters count as CS for whoever lands the last hit, like the camps (the grubs camp is three monsters)
    taker.cs += k === "grubs" ? GROWTH.grubCs * 3 : GROWTH.epicCs;
    if (steal) this.event("steal", side, `스틸! ${josa(`${taker.name}(${taker.champ.name})`, "이가")} ${josa(OBJ_KO[k], "을를")} 빼앗았습니다`, true, taker.i, undefined, o.pos);
    if (k === "dragon") {
      this.dragons[side].push(o.type!);
      for (const u of mates) u.gold += 50;
      this.event("dragon", side, `${team}, ${o.type} 드래곤 처치 (${this.dragons[side].length}스택)`, false, taker.i, undefined, o.pos);
      if (this.dragons[side].length >= 4 && this.soul === null) {
        this.soul = side;
        this.event("soul", side, `${team}, ${this.soulType} 드래곤의 영혼 획득!`, true, undefined, undefined, o.pos);
        o.alive = false;
        o.spawnAt = null;
        this.obj.elder.spawnAt = this.t + (this.meta.objectives.elder?.respawn ?? 360);
        return;
      }
      const next = this.dragons[0].length + this.dragons[1].length;
      o.type = this.dragonOrder[Math.min(next, 2)];
      o.alive = false;
      o.spawnAt = this.t + (respawn ?? 300);
      return;
    }
    if (k === "elder") {
      for (const u of mates) if (u.alive) u.elderUntil = this.t + 150;
      this.event("elder", side, `${team}, 장로 드래곤 처치 (처형 버프)`, true, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = this.t + (respawn ?? 360);
      return;
    }
    if (k === "baron") {
      this.barons[side] += 1;
      for (const u of mates) {
        u.gold += 300;
        if (u.alive) u.baronUntil = this.t + 180;
      }
      this.event("baron", side, `${team}, 내셔 남작 처치!`, true, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = this.t + (respawn ?? 360);
      return;
    }
    if (k === "grubs") {
      this.grubs[side] += 3;
      this.event("grubs", side, `${team}, 공허 유충 3마리 처치`, false, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = null;
      return;
    }
    if (k === "herald") {
      this.heralds[side] += 1;
      this.event("herald", side, `${team}, 협곡의 전령 획득`, false, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = null;
      // the team carries it and lets it loose at a turret later (heraldTick); it used to hit a turret across the map
      // in the same step it was taken
      this.heraldHeld = { side, taker: taker.i, at: this.t };
    }
  }

  /** A herald that was taken and not used yet. */
  heraldHeld: { side: SideN; taker: number; at: number } | null = null;

  /** The held herald charges an enemy outer turret once a teammate is near one (lowest tier first, then the closest),
   *  or the old default lane on its own after SIM_TUNE.heraldForce seconds. Same damage as before: 45 % of the turret. */
  heraldTick() {
    const h = this.heraldHeld;
    if (!h || this.t - h.at < SIM_TUNE.heraldDelay) return;
    const enemy = (1 - h.side) as SideN;
    const fronts = LANES.map((l) => ({ l, t: this.frontierTurret(enemy, l) })).filter((x): x is { l: LaneId; t: TurretState } => !!x.t);
    if (!fronts.length) {
      this.heraldHeld = null;
      return;
    }
    const mates = this.units.filter((u) => u.alive && u.side === h.side);
    let best: { l: LaneId; t: TurretState; by: Unit } | null = null, bv = Infinity;
    for (const f of fronts) {
      for (const u of mates) {
        const d = dist(u, f.t.pos);
        if (d > SIM_TUNE.heraldNear) continue;
        const v = f.t.tier * 10000 + d;
        if (v < bv) { bv = v; best = { ...f, by: u }; }
      }
    }
    if (!best) {
      // forced only with someone alive to bring it in (a wiped team's herald charged alone and paid its dead taker)
      if (this.t - h.at < SIM_TUNE.heraldForce || !mates.length) return;
      const f = fronts.sort((a, b) => a.t.tier - b.t.tier)[0];
      best = { ...f, by: mates.find((u) => u.i === h.taker) ?? mates[0] };
    }
    this.heraldHeld = null;
    // it runs in along the lane: dash fx with x,y = where it lands (the turret), tx,ty = where it starts
    const t = best.t;
    const back = lanePoint(best.l, t.u + (h.side === 0 ? -0.06 : 0.06));
    const d = dist(back, t.pos) || 1;
    const from = { x: t.pos.x + ((back.x - t.pos.x) / d) * 900, y: t.pos.y + ((back.y - t.pos.y) / d) * 900 };
    this.fx_({ kind: "dash", side: h.side, x: t.pos.x, y: t.pos.y, tx: from.x, ty: from.y, color: "#b48cff", r: 300, w: 260, text: "전령 돌진" });
    this.damageTurret(t, t.maxHp * 0.45, best.by);
  }

  // ---------- passive income ----------
  economy() {
    const m = this.minute();
    for (const u of this.units) {
      if (!u.alive) continue;
      if (this.t > 110) u.gold += 2.04 * DT;
      // xp and cs from waves
      const lane = ROLE_LANE[u.role];
      let nearWave = false;
      for (const l of LANES) if (dist(u, this.laneFrontPos(l)) < 1100) nearWave = true;
      const solo = u.role === "Top" || u.role === "Mid";
      if (nearWave && this.t > 55) {
        const share = u.role === "Support" ? 0.6 : u.role === "Bot" ? 0.8 : 1;
        u.xp += (solo ? GROWTH.laneXpSolo : GROWTH.laneXpDuo) * share * DT * (1 + m * GROWTH.laneXpGrow);
        if (u.role !== "Support") {
          // the lane's LCK matchup moves the CS share between the two laners (zero-sum on average, matchup.ts)
          const mu = this.laningPhase() && lane && u.role !== "Jungle" ? Matchup.laneEdge(this, u) * Matchup.MATCHUP_TUNE.cs : 0;
          const rate = (GROWTH.laneCs / 60) * (0.85 + u.rating / 500) * (lane ? 1 : 0.9) * clamp(1 + mu, 0.5, 1.5);
          const gained = rate * DT * (this.rng.next() < 0.5 ? 1.6 : 0.4);
          u.cs += gained;
          u.gold += gained * 21;
        } else {
          // the support item's gold, and the odd minion the ADC is not there for
          const g = (GROWTH.supCs / 60) * DT;
          u.cs += g;
          u.gold += GROWTH.supGold * DT + g * 21;
        }
      } else if (u.role === "Jungle") {
        u.xp += (this.laningPhase() ? GROWTH.jgAwayXpLaning : GROWTH.jgAwayXp) * DT;
      } else {
        // after laning, a laner holding a side lane (lane / split job) farms it from where it stands
        const side = !this.laningPhase() && u.task === "lane";
        u.xp += (this.laningPhase() ? GROWTH.awayXpLaning : side ? GROWTH.sideXp : GROWTH.awayXp) * DT;
        // side waves and jungle camps away from the main fronts
        if (u.role !== "Support" && !u.fightId && this.t > 840) {
          const g = ((GROWTH.sideCs * (u.role === "Bot" ? GROWTH.sideBot : 1)) / 60) * DT;
          u.cs += g;
          u.gold += g * 21;
        }
      }
      // level ups
      while (u.level < 18 && u.xp >= this.xpFor(u.level + 1)) {
        u.level += 1;
        if (u.level >= 6 && u.cds[3] >= R_LOCKED) u.cds[3] = this.t; // the ultimate unlocks at level 6
        const newMax = this.maxHp(u);
        u.hp += newMax - u.maxHp;
        u.maxHp = newMax;
      }
      if (this.rng.chance(0.02)) {
        const newMax = this.maxHp(u);
        u.hp = (u.hp / u.maxHp) * newMax;
        u.maxHp = newMax;
      }
    }
  }
  xpFor(level: number) {
    // cumulative xp to reach `level`
    const n = level - 1;
    return 180 * n + 50 * n * (n + 1);
  }

  checkEnd() {
    if (this.over) return;
  }

  finish(side: SideN) {
    if (this.over) return;
    this.over = true;
    this.winner = side;
    this.event("nexus", side, `${this.names[side]} 승리! 넥서스 파괴`, true, undefined, undefined, NEXUS[1 - side]);
  }

  gold(side: SideN) {
    return Math.round(this.units.filter((u) => u.side === side).reduce((a, u) => a + u.gold, 0));
  }

  /** Objective timers for the HUD: seconds until spawn (0 = up now), null = not coming. */
  timers(): { key: ObjKey | "camp"; label: string; at: number | null; alive: boolean }[] {
    return (Object.keys(this.obj) as ObjKey[]).map((k) => ({
      key: k,
      label: k === "dragon" ? `${this.obj.dragon.type ?? ""} 드래곤` : OBJ_KO[k],
      at: this.obj[k].spawnAt,
      alive: this.obj[k].alive,
    }));
  }
}

let mapReady = false;
function initMapOnce(data: GameData) {
  if (mapReady) return;
  initMap(data.heatmap);
  mapReady = true;
}

export { LANE_PATH };
