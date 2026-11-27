// Lane minions as real units (2026-11-27). Before this a lane was one number (the "front") pushed by a formula, the
// minions on screen were a fixed clump of twelve pixels that never died, CS was a rate and turrets had nothing to
// shoot but champions. Now waves spawn at the nexus on the real timers, walk their lane, fight the enemy wave, get
// shot by turrets, hit structures, and die to champions' last hits, wave clear and area spells. The lane front that
// the rest of the engine reads (where laners stand, who has pushed, where a siege waits) is derived from where the
// two waves meet. Values are the 2026 season's (patch 26.x, League of Legends Wiki "Minion" and the 26.1 notes):
//   first wave 0:30, every 30 s (25 s from 14:00, 20 s from 30:00); 3 melee + 3 caster, a siege minion every 3rd wave
//   (every 2nd from 14:00, every wave from 25:00; from 14:00 a wave with one has a melee less, from 30:00 a caster
//   less); a super minion instead in a lane whose enemy inhibitor is down (two when all three are); stats rise every
//   90 s; minions deal 60 % to champions and structures (siege 84 % to turrets); gold 20 / 14 / 50+.
// What stays abstract: minions keep to their lane's line (a sideways offset is for drawing and distances only).
import type { Engine, InhibState, SideN, TurretState, Unit } from "./engine";
import { DT, SIM_TUNE, applyTune } from "./engine";
import { clamp } from "../core/rng";
import type { SpellData } from "../data/types";
import { LANES, LANE_PATH, NEXUS, dist, laneU } from "./map";
import type { LaneId, Vec } from "./map";
import * as Fight from "./fight";
import * as Matchup from "./matchup";
import * as Stats from "./stats";
import * as Summoners from "./summoners";
import * as Turrets from "./turrets";

/**
 * How champions deal with the wave (scripts/turret-diag.ts and growth-check.ts against LCK 2026 CS by role and minute).
 * reach: a champion farms the enemy minions within this distance (walking up to each one is not simulated).
 * lastHit: chance that a finishing blow lands, before the player's rating and the lane matchup; lhWindow: a minion can
 *   be finished once its health is under this many of the champion's basic attacks (the hit that sets it up and the
 *   spell that helps are not simulated), at most one every lhEvery seconds; underTurret: last hits while the own
 *   turret is shooting the wave; pushDefend: the wave-clear share against a wave on the champion's own turret.
 * pushLane / pushSide / pushGroup: share of its wave-clear damage a champion puts into the wave on top of last hits,
 *   during laning / holding a lane after it / passing by in a group (a siege multiplies pushSide by SIM_TUNE.siegePush);
 *   area: how much of that also lands on every other minion nearby, for a champion with full wave clear.
 * gold: minion gold multiplier on the real 20 / 14 / 50. 1.12 keeps the 21 gold a CS the engine's income was
 *   calibrated with (the 2026 role quests add minion gold the engine does not model); vsChamp: minion damage to
 *   champions (x the real 60 %). At the full amount first blood came at 4.5 min and solo kills at 1.9-2.0 a game
 *   (LCK 5.1 / 1.6): the engine's laners trade inside the enemy wave where players step out of it; 0.5 gives 5.0 / 1.6; xp: minion experience multiplier on the real 62 / 31 / 75, shared by the champions
 *   within xpRange of the minion that died (100 / 65 / 43 / 33 / 26 % each for one to five). At the real values
 *   mid levels match LCK 2026 to 0.1 through 25:00. Per role: xpTop the top laner's 2026 role-quest bonus (0.4
 *   levels short at 15:00 without it), xpBot / xpSup what the carry and the support keep (at an equal share the
 *   engine's carry is 0.6 levels over LCK at 20:00 and its support 1.1: it farms side waves alone after laning, and
 *   real supports leave the lane to ward and roam more than the engine's do);
 * help: minions this close to an enemy champion that hits their champion turn on it (call for help), for helpFor s.
 * laneSiege: during laning, champion damage to a turret that has a defender next to it (they trade instead of hitting).
 * frontRate: how fast the lane front the engine reads follows the real meeting point (lane fraction per second).
 * towerDmg: the share of the time a champion in range of a structure is really hitting it (1 = every attack);
 *   minionDmg: minion damage to structures (1 = the real 60 %). They replace PACE_TUNE.towerDmg / minionDmg, which
 *   scaled the old made-up structure damage (ENGINE_FLAGS.minions off).
 * splash: share of a spell's damage that lands on the minions in its area (fights, lane pokes).
 * sideCs: what is left of GROWTH.sideCs (the CS a laner away from every wave still gets after 14:00) now that the
 *   waves it passes are farmed for real; recallOnClear: a laner with gold to spend goes home when the wave in front
 *   of it is dead, and the chance per step is this much higher then.
 * loneWave: damage to a structure from a wave that has none of its champions within 1,700 u. Real teams send someone
 *   to clear a wave before it reaches a turret; the engine's team plans do not, so at the full damage unattended
 *   waves took 1.6 turrets a game for the losing side that real losers do not get (LCK 2.6 a game, engine 4.2).
 * supPush: a support's share of the wave-clear damage in lane (it shoves with its carry but leaves the last hits).
 * pressure: after laning, extra minion damage to minions for the stronger team, per unit of power ratio above 1.
 * Scripts can override any of them with WAVE_TUNE=key:value,...
 */
export const WAVE_TUNE = {
  reach: 1500, lastHit: 0.98, lhWindow: 2, lhEvery: 0.9, underTurret: 0.85,
  pushLane: 0.15, pushSide: 0.6, pushGroup: 0.4, pushDefend: 0.8, area: 0.6,
  gold: 1.12, vsChamp: 0.5, help: 600, helpFor: 2.5, xp: 1, xpTop: 1.04, xpBot: 0.9, xpSup: 0.8, xpRange: 1500,
  laneSiege: 0.15, frontRate: 0.05,
  towerDmg: 1, minionDmg: 1,
  splash: 0.6, sideCs: 0.6, recallOnClear: 3, loneWave: 0.4, supPush: 0.5, pressure: 2,
};
export function applyWaveTune(spec: string | undefined) {
  applyTune(WAVE_TUNE, "WAVE_TUNE", spec);
}

export type MinionKind = "melee" | "caster" | "siege" | "super";
/** what killed a minion: a champion's finishing blow / its sustained attack / an area spell, enemy minions, a turret */
export type Cause = "lasthit" | "clear" | "skill" | "minion" | "turret";

export interface Minion {
  id: number;
  side: SideN;
  lane: LaneId;
  kind: MinionKind;
  /** lane fraction, 0 = blue nexus */
  u: number;
  /** sideways offset from the lane line (map units), for drawing and distances */
  lat: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  ad: number;
  /** attacks per second (the three of a row hit 15 % slower / as written / 15 % faster, so their targets do not
   *  all get low in the same second and a laner can take each last hit) */
  as: number;
  range: number;
  armor: number;
  gold: number;
  /** enemy minion it is attacking */
  tgt: Minion | null;
  /** enemy champion it turned on (call for help), -1 none, until champUntil */
  champ: number;
  champUntil: number;
  /** walking this step (not held by a target) */
  moving: boolean;
  /** attacking a structure this step */
  onStruct: boolean;
  /** champions that tried the last hit and missed (bit per unit) */
  miss: number;
  /** damage from enemy minions this step, applied after every minion has acted */
  pend: number;
  /** next to an ally with the baron buff */
  emp: boolean;
  /** lane segment it is on (cache for place()) */
  seg: number;
}

export interface Death { id: number; t: number; x: number; y: number; side: SideN; kind: MinionKind; cause: Cause; by: number; gold: number }

export interface MinionStats {
  spawned: number;
  /** deaths by cause, laning phase (before 14:00) and after */
  deaths: [Record<Cause, number>, Record<Cause, number>];
  /** deaths that paid a champion (CS) */
  credited: number;
  /** last hits a champion tried and missed */
  missed: number;
  /** laning-phase deaths that paid nobody: with an enemy champion that could have farmed it in reach / with none */
  unpaidNear: number;
  unpaidFar: number;
  /** minions alive (all lanes, both sides): sum over steps, steps, and the most at once */
  aliveSum: number;
  steps: number;
  maxAlive: number;
  /** most minions of one side in one lane at once */
  maxLane: number;
  /** damage minions dealt to champions / to structures */
  toChamps: number;
  toStructs: number;
}

interface Farm { hitAt: number; clear: number; clearAt: number }
interface Stop { u: number; r: number; pos: Vec; turret?: TurretState; inhib?: InhibState; nexus?: SideN; led?: boolean }
interface Mod {
  seq: number;
  wave: number;
  nextWave: number;
  queue: { at: number; lane: LaneId; side: SideN; kind: MinionKind; slot: number; wave: number }[];
  lanes: Record<LaneId, [Minion[], Minion[]]>;
  all: Minion[];
  farm: Farm[];
  deaths: Death[];
  deathSeq: number;
  raw: Record<LaneId, number>;
  waveOn: Map<TurretState, { t: number; v: boolean }>;
  /** lane fraction of each nexus turret on each lane (index in e.turrets) */
  ntU: Record<LaneId, Map<TurretState, number>>;
  ihU: Map<InhibState, number>;
  stats: MinionStats;
}

// ---------------------------------------------------------------- lane geometry

interface Geo { len: number; acc: number[]; pts: Vec[] }
const GEO = {} as Record<LaneId, Geo>;
function geo(lane: LaneId): Geo {
  let g = GEO[lane];
  if (g) return g;
  const pts = LANE_PATH[lane];
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + dist(pts[i - 1], pts[i]));
  g = GEO[lane] = { len: acc[acc.length - 1], acc, pts };
  return g;
}
/** Length of a lane in map units (nexus to nexus). */
export function laneLength(lane: LaneId): number {
  return geo(lane).len;
}
function place(m: Minion) {
  const g = geo(m.lane);
  const d = clamp(m.u, 0, 1) * g.len;
  let i = m.seg;
  while (i < g.acc.length - 2 && g.acc[i + 1] < d) i++;
  while (i > 0 && g.acc[i] > d) i--;
  m.seg = i;
  const a = g.pts[i], b = g.pts[i + 1];
  const sl = g.acc[i + 1] - g.acc[i] || 1;
  const k = (d - g.acc[i]) / sl;
  const dx = (b.x - a.x) / sl, dy = (b.y - a.y) / sl;
  m.x = a.x + (b.x - a.x) * k - dy * m.lat;
  m.y = a.y + (b.y - a.y) * k + dx * m.lat;
}

// ---------------------------------------------------------------- setup

const CAUSES: Cause[] = ["lasthit", "clear", "skill", "minion", "turret"];
const zero = () => Object.fromEntries(CAUSES.map((c) => [c, 0])) as Record<Cause, number>;

export function init(e: Engine): void {
  const m: Mod = {
    seq: 0, wave: 0, nextWave: FIRST_WAVE, queue: [],
    lanes: { top: [[], []], mid: [[], []], bot: [[], []] }, all: [],
    farm: e.units.map(() => ({ hitAt: 0, clear: 0, clearAt: -9 })), deaths: [], deathSeq: 0,
    raw: { top: 0.5, mid: 0.5, bot: 0.5 }, waveOn: new Map(),
    ntU: { top: new Map(), mid: new Map(), bot: new Map() }, ihU: new Map(),
    stats: { spawned: 0, deaths: [zero(), zero()], credited: 0, missed: 0, unpaidNear: 0, unpaidFar: 0, aliveSum: 0, steps: 0, maxAlive: 0, maxLane: 0, toChamps: 0, toStructs: 0 },
  };
  for (const lane of LANES) for (const t of e.turrets) if (t.lane === "nexus") m.ntU[lane].set(t, laneU(lane, t.pos));
  for (const ih of e.inhibs) m.ihU.set(ih, laneU(ih.lane, ih.pos));
  e.mods.minions = m;
}
function mod(e: Engine): Mod {
  let m = e.mods.minions as Mod | undefined;
  if (!m) {
    init(e);
    m = e.mods.minions as Mod;
  }
  return m;
}

/** Every minion alive (read only: the renderer, turrets, scripts). */
export function list(e: Engine): readonly Minion[] {
  return mod(e).all;
}
export function stats(e: Engine): MinionStats {
  return mod(e).stats;
}
/** Minions that died lately, newest last (the renderer draws the puff and the gold of a last hit). */
export function deaths(e: Engine): readonly Death[] {
  return mod(e).deaths;
}
/** Where the two waves of a lane really meet (the engine's `front` follows it at WAVE_TUNE.frontRate). */
export function rawFront(e: Engine, lane: LaneId): number {
  return mod(e).raw[lane];
}

// ---------------------------------------------------------------- waves

const FIRST_WAVE = 30;
const SPAWN_GAP = 0.8;
const UPGRADE_EVERY = 90;
/** sideways slots: melee row, siege in the middle, caster row */
const LAT: Record<MinionKind, number[]> = { melee: [0, -85, 85], caster: [0, -95, 95], siege: [40], super: [-40, 40] };

function waveInterval(t: number): number {
  return t >= 30 * 60 ? 20 : t >= 14 * 60 ? 25 : 30;
}
/** Minion move speed: 350, +25 at 11 / 16 / 21 / 26 min. */
export function moveSpeed(t: number): number {
  const m = t / 60;
  return 350 + (m >= 11 ? 25 : 0) + (m >= 16 ? 25 : 0) + (m >= 21 ? 25 : 0) + (m >= 26 ? 25 : 0);
}

function make(e: Engine, M: Mod, side: SideN, lane: LaneId, kind: MinionKind, slot: number, wave: number): Minion {
  const up = Math.max(0, Math.floor((e.t - FIRST_WAVE) / UPGRADE_EVERY));
  let hp: number, ad: number, as: number, range: number, armor = 0, gold: number;
  if (kind === "melee") {
    hp = Math.min(1550, 430 + 35 * up); ad = Math.min(80, 11 + 3 * Math.max(0, up - 5)); as = 1.25; range = 110; armor = up >= 6 ? 20 : 0; gold = 20;
  } else if (kind === "caster") {
    hp = Math.min(600, 275 + 9 * up); ad = Math.min(125, 19.5 + 1.5 * Math.min(up, 5) + 4 * Math.max(0, up - 5)); as = 0.667; range = 550; gold = 14;
  } else if (kind === "siege") {
    // +1.5 per upgrade, +4 from wave 15 (7:30, the 4th upgrade)
    hp = Math.min(5850, 750 + 85 * up); ad = Math.min(126, 39 + 1.5 * Math.min(up, 4) + 4 * Math.max(0, up - 4)); as = 1; range = 300; gold = 50 + up;
  } else {
    hp = Math.min(7500, 1500 + 100 * up); ad = Math.min(480, 180 + 5 * up); as = 0.85; range = 170; armor = 100; gold = 50 + up;
  }
  if (kind === "melee" || kind === "caster") as *= 0.85 + 0.15 * (slot % 3);
  const m: Minion = {
    id: ++M.seq, side, lane, kind, u: side === 0 ? 0.004 : 0.996, lat: LAT[kind][slot % LAT[kind].length] + ((wave * 37 + slot * 53) % 31) - 15,
    x: 0, y: 0, hp, maxHp: hp, ad, as, range, armor, gold, tgt: null, champ: -1, champUntil: 0, moving: true, onStruct: false,
    miss: 0, pend: 0, emp: false, seg: side === 0 ? 0 : LANE_PATH[lane].length - 2,
  };
  place(m);
  return m;
}

function spawn(e: Engine, M: Mod) {
  if (e.t >= M.nextWave) {
    const wave = ++M.wave;
    M.nextWave += waveInterval(e.t);
    const siegeEvery = e.t >= 25 * 60 ? 1 : e.t >= 14 * 60 ? 2 : 3;
    const siege = wave % siegeEvery === 0;
    for (const side of [0, 1] as SideN[]) {
      const downAll = e.inhibs.filter((x) => x.side !== side && !x.alive && x.respawnAt - e.t > 2 * waveInterval(e.t)).length;
      for (const lane of LANES) {
        const ih = e.inhibs.find((x) => x.side !== side && x.lane === lane)!;
        // super minions stop two waves before the inhibitor is back
        const supers = !ih.alive && ih.respawnAt - e.t > 2 * waveInterval(e.t) ? (downAll >= 3 ? 2 : 1) : 0;
        const big = supers > 0 || siege;
        const melee = 3 - (e.t >= 14 * 60 && big ? 1 : 0);
        const caster = 3 - (e.t >= 30 * 60 ? 1 : 0);
        let k = 0;
        const add = (kind: MinionKind, slot: number) => M.queue.push({ at: e.t + k++ * SPAWN_GAP, lane, side, kind, slot, wave });
        for (let i = 0; i < melee; i++) add("melee", i);
        if (supers) for (let i = 0; i < supers; i++) add("super", i);
        else if (siege) add("siege", 0);
        for (let i = 0; i < caster; i++) add("caster", i);
      }
    }
  }
  if (!M.queue.length) return;
  let kept = 0;
  for (const q of M.queue) {
    if (q.at > e.t) { M.queue[kept++] = q; continue; }
    const m = make(e, M, q.side, q.lane, q.kind, q.slot, q.wave);
    M.lanes[q.lane][q.side].push(m);
    M.all.push(m);
    M.stats.spawned++;
  }
  M.queue.length = kept;
}

// ---------------------------------------------------------------- damage and death

/** experience of a minion, and each champion's share of it when 1..5 of them are in range (2026 values) */
const XP: Record<MinionKind, number> = { melee: 62, caster: 31, siege: 75, super: 75 };
const XP_SHARE = [1, 0.65, 0.433, 0.325, 0.26];

function die(e: Engine, M: Mod, m: Minion, cause: Cause, by: Unit | null) {
  m.hp = 0;
  // experience goes to the enemy champions in range, whoever or whatever killed it
  let n = 0;
  for (const u of e.units) if (u.alive && u.side !== m.side && dist(u, m) < WAVE_TUNE.xpRange) n++;
  if (n) {
    const each = XP[m.kind] * XP_SHARE[n - 1] * WAVE_TUNE.xp;
    for (const u of e.units) {
      if (u.alive && u.side !== m.side && dist(u, m) < WAVE_TUNE.xpRange) u.xp += each * (u.role === "Top" ? WAVE_TUNE.xpTop : u.role === "Bot" ? WAVE_TUNE.xpBot : u.role === "Support" ? WAVE_TUNE.xpSup : 1);
    }
  }
  const late = e.laningPhase() ? 0 : 1;
  M.stats.deaths[late][cause]++;
  let gold = 0;
  if (by) {
    gold = m.gold * WAVE_TUNE.gold;
    by.cs += 1;
    by.gold += gold;
    M.stats.credited++;
  } else if (!late) {
    if (e.units.some((u) => u.side !== m.side && u.role !== "Support" && canFarm(e, u) && dist(u, m) < WAVE_TUNE.reach)) M.stats.unpaidNear++;
    else M.stats.unpaidFar++;
  }
  M.deaths.push({ id: ++M.deathSeq, t: e.t, x: m.x, y: m.y, side: m.side, kind: m.kind, cause, by: by ? by.i : -1, gold });
  if (M.deaths.length > 80) M.deaths.splice(0, M.deaths.length - 80);
}

/** Damage to a minion from outside this module (turret shots). Returns true when it died. */
export function hurt(e: Engine, m: Minion, amount: number, cause: Cause, by: Unit | null = null): boolean {
  if (m.hp <= 0 || amount <= 0) return false;
  m.hp -= amount;
  if (m.hp > 0) return false;
  die(e, mod(e), m, cause, by);
  return true;
}

/** The attacking side's minions within `r` of a point (turret targets, backdoor check). */
export function near(e: Engine, p: Vec, r: number, side: SideN): Minion[] {
  const out: Minion[] = [];
  for (const m of mod(e).all) if (m.side === side && m.hp > 0 && Math.abs(m.x - p.x) < r && Math.abs(m.y - p.y) < r && dist(m, p) < r) out.push(m);
  return out;
}
export function anyNear(e: Engine, p: Vec, r: number, side: SideN): boolean {
  for (const m of mod(e).all) if (m.side === side && m.hp > 0 && Math.abs(m.x - p.x) < r && Math.abs(m.y - p.y) < r && dist(m, p) < r) return true;
  return false;
}

/**
 * engine.waveAt: the attacking wave is on this turret, so champions may stand in its range. Two minions in range, or
 * one that is still healthy: with the last one about to fall the turret turns on a champion within a second, and
 * champions should be walking out by then, as players do.
 */
export function waveOn(e: Engine, t: TurretState): boolean {
  const M = mod(e);
  const c = M.waveOn.get(t);
  if (c && c.t === e.t) return c.v;
  let n = 0, healthy = false;
  for (const m of M.all) {
    if (m.side === t.side || m.hp <= 0 || Math.abs(m.x - t.pos.x) > 800 || Math.abs(m.y - t.pos.y) > 800 || dist(m, t.pos) > 800) continue;
    n++;
    if (m.hp > m.maxHp * 0.5) healthy = true;
  }
  const v = n >= 2 || healthy;
  M.waveOn.set(t, { t: e.t, v });
  return v;
}

// ---------------------------------------------------------------- one step

export function tick(e: Engine): void {
  const M = mod(e);
  spawn(e, M);
  if (!M.all.length) return;
  callForHelp(e, M);
  baronAura(e, M);
  const sp = moveSpeed(e.t) * DT;
  const bonus = pushBonus(e);
  for (const lane of LANES) {
    const L = geo(lane).len;
    for (const side of [0, 1] as SideN[]) {
      const mine = M.lanes[lane][side], foes = M.lanes[lane][1 - side];
      if (!mine.length) continue;
      const dir = side === 0 ? 1 : -1;
      const stops = stopsFor(e, M, lane, side);
      for (const m of mine) {
        if (m.hp <= 0) continue;
        m.moving = false;
        m.onStruct = false;
        // a champion that hit our champion next to us
        if (m.champ >= 0) {
          const c = e.units[m.champ];
          if (e.t < m.champUntil && c.alive && Fight.hittable(e, c) && dist(c, m) <= m.range + 200) {
            hitChampion(e, M, m, c);
            continue;
          }
          m.champ = -1;
        }
        // the enemy minion in front
        let tg = m.tgt;
        if (tg && (tg.hp <= 0 || (tg.u - m.u) * dir < -0.006)) tg = null;
        if (!tg) {
          // the closest one, with the one straight ahead (same sideways slot) preferred: the two front rows pair off
          // instead of all six hitting one minion (that way a melee minion fell every 2 s and a wave was gone in 8)
          let bd = Infinity;
          for (const f of foes) {
            if (f.hp <= 0) continue;
            const d = Math.abs(f.u - m.u) * L;
            if (d > 800) continue;
            const v = d + Math.abs(f.lat - m.lat) * 0.6;
            if (v < bd) { bd = v; tg = f; }
          }
        }
        m.tgt = tg;
        if (tg) {
          const gap = Math.abs(tg.u - m.u) * L;
          if (gap <= m.range + 30) {
            // 2 % / 3.5 % / 5 % of the target's current health on top, as minions have against minions
            const onHit = m.kind === "melee" ? 0.02 : m.kind === "caster" ? 0.035 : m.kind === "siege" ? 0.05 : 0;
            tg.pend += (m.ad + tg.hp * onHit) * m.as * DT * (100 / (100 + tg.armor)) * (1 + bonus[side]) * (tg.emp ? 0.4 : 1);
          } else {
            m.u += dir * Math.min(sp, gap - m.range) / L;
            m.moving = true;
          }
          continue;
        }
        // the next enemy structure on the lane
        let stop: Stop | null = null;
        for (const s of stops) if ((s.u - m.u) * dir > -0.006) { stop = s; break; }
        const gapS = stop ? (stop.u - m.u) * dir * L : Infinity;
        if (stop && gapS <= m.range + stop.r) {
          hitStructure(e, M, m, stop);
          m.onStruct = true;
          continue;
        }
        // a champion standing in the wave with nothing else to hit
        const c = adjacentChampion(e, m);
        if (c) {
          hitChampion(e, M, m, c);
          continue;
        }
        m.u += dir * Math.min(sp, stop ? gapS - m.range - stop.r + 10 : sp) / L;
        m.moving = true;
      }
    }
  }
  // minion damage lands for both sides at once (no first-mover edge for the side that acts first)
  for (const m of M.all) {
    if (m.pend > 0 && m.hp > 0) {
      m.hp -= m.pend;
      if (m.hp <= 0) die(e, M, m, "minion", null);
    }
    m.pend = 0;
  }
  for (const m of M.all) if (m.hp > 0) place(m);
  farm(e, M);
  sweep(e, M);
  fronts(e, M);
}

/** The side whose champions are higher level on average gets up to +60 % minion damage to minions (from 3:30):
 *  (5 % + 5 % x its turret lead) x level lead (at most 3). */
function pushBonus(e: Engine): [number, number] {
  if (e.t < 210) return [0, 0];
  const lv = [0, 0];
  for (const u of e.units) lv[u.side] += u.level / 5;
  const lead = clamp(lv[0] - lv[1], -3, 3);
  const turretLead = [Math.max(0, e.towers[0] - e.towers[1]), Math.max(0, e.towers[1] - e.towers[0])];
  const out: [number, number] = [lead > 0 ? Math.min(0.6, (0.05 + 0.05 * turretLead[0]) * lead) : 0, lead < 0 ? Math.min(0.6, (0.05 + 0.05 * turretLead[1]) * -lead) : 0];
  if (!e.laningPhase() && WAVE_TUNE.pressure > 0) {
    // map pressure: the stronger team (champions alive, by power) wins the waves it is not standing at as well. The
    // old lane formula had this as a drift of every front toward the weaker side; without it the side behind in gold
    // took 3.1 outer and inner turrets a game with a lone laner (old engine 1.6, LCK losers 2.5)
    const tp = [0, 0];
    for (const u of e.units) if (u.alive) tp[u.side] += e.power(u);
    const r = clamp((tp[0] + 1) / (tp[1] + 1), 0.5, 2);
    if (r > 1) out[0] += (r - 1) * WAVE_TUNE.pressure;
    else out[1] += (1 / r - 1) * WAVE_TUNE.pressure;
  }
  return out;
}

/** Minions next to a champion that just damaged their champion turn on it (the real "call for help"). */
function callForHelp(e: Engine, M: Mod) {
  for (const c of e.units) {
    if (!c.alive || !c.fightId) continue;
    const h = Fight.lastChampHit(e, c);
    if (e.t - h.at > DT * 1.5) continue;
    for (const m of M.all) {
      if (m.side === c.side || m.hp <= 0 || m.onStruct || m.champ >= 0) continue;
      if (Math.abs(m.x - c.x) > WAVE_TUNE.help || Math.abs(m.y - c.y) > WAVE_TUNE.help || dist(m, c) > WAVE_TUNE.help) continue;
      m.champ = c.i;
      m.champUntil = e.t + WAVE_TUNE.helpFor;
    }
  }
}

/** Minions near an ally with the baron buff are tougher and hit structures harder (an approximation of the real
 *  Hand of Baron: damage reduction for melee, range and damage for casters and siege minions). */
function baronAura(e: Engine, M: Mod) {
  const buffed = e.units.filter((u) => u.alive && u.baronUntil > e.t);
  for (const m of M.all) {
    m.emp = false;
    for (const u of buffed) if (u.side === m.side && dist(u, m) < 1300) { m.emp = true; break; }
  }
}

function stopsFor(e: Engine, M: Mod, lane: LaneId, side: SideN): Stop[] {
  const enemy = (1 - side) as SideN;
  const out: Stop[] = [];
  for (const t of e.turrets) if (t.alive && t.side === enemy && t.lane === lane) out.push({ u: t.u, r: 130, pos: t.pos, turret: t });
  out.sort((a, b) => (side === 0 ? a.u - b.u : b.u - a.u));
  const ih = e.inhibs.find((x) => x.side === enemy && x.lane === lane)!;
  if (ih.alive) out.push({ u: M.ihU.get(ih)!, r: 180, pos: ih.pos, inhib: ih });
  const nts: Stop[] = [];
  for (const t of e.turrets) if (t.alive && t.side === enemy && t.lane === "nexus") nts.push({ u: M.ntU[lane].get(t)!, r: 130, pos: t.pos, turret: t });
  nts.sort((a, b) => (side === 0 ? a.u - b.u : b.u - a.u));
  out.push(...nts);
  out.push({ u: side === 0 ? 1 : 0, r: 300, pos: NEXUS[enemy], nexus: enemy });
  return out;
}

function hitStructure(e: Engine, M: Mod, m: Minion, s: Stop) {
  // a wave with none of its champions near (WAVE_TUNE.loneWave)
  s.led ??= e.units.some((u) => u.alive && u.side === m.side && dist(u, s.pos) < 1700);
  // 60 % to structures, a siege minion 84 % to turrets; empowered by the baron buff
  const raw = m.ad * m.as * DT * WAVE_TUNE.minionDmg * (m.emp ? 1.5 : 1) * (s.led ? 1 : WAVE_TUNE.loneWave);
  let dealt = 0;
  if (s.turret) dealt = Turrets.hit(e, s.turret, raw * (m.kind === "siege" ? 0.84 : 0.6), "p", null, "minion");
  else if (s.inhib) dealt = Turrets.hitInhib(e, s.inhib, raw * 0.6, m.side, null);
  else if (s.nexus !== undefined) dealt = Turrets.hitNexus(e, s.nexus, raw * 0.6, m.side);
  M.stats.toStructs += dealt;
}

function hitChampion(e: Engine, M: Mod, m: Minion, c: Unit) {
  const dmg = m.ad * m.as * DT * 0.6 * WAVE_TUNE.vsChamp * (e.realStats() ? Stats.armorMul(e, null, c) : 0.8);
  if (dmg <= 0) return;
  M.stats.toChamps += dmg;
  e.minionHit(c, dmg);
}

function adjacentChampion(e: Engine, m: Minion): Unit | null {
  let best: Unit | null = null, bd = m.range + 100;
  for (const c of e.units) {
    if (!c.alive || c.side === m.side || !Fight.hittable(e, c)) continue;
    const d = dist(c, m);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------- champions and the wave

const FARM_ORDER: Record<string, number> = { Bot: 0, Mid: 1, Top: 2, Jungle: 3, Support: 4 };

/** Out of a fight and free to hit minions: not channelling, not on the way to a gank or an objective. */
function canFarm(e: Engine, u: Unit): boolean {
  if (!u.alive || u.fightId || u.recallEnd !== undefined || e.t < u.stunUntil) return false;
  if (u.task !== "lane" && u.task !== "siege" && u.task !== "group" && u.task !== "return" && u.task !== "jungle") return false;
  return !Summoners.channel(e, u);
}

/** A champion's damage per second into a wave: basic attacks plus its basic spells weighted by its wave clear. */
function clearDps(e: Engine, M: Mod, u: Unit): number {
  const F = M.farm[u.i];
  if (e.t - F.clearAt < 2) return F.clear;
  let spells = 0;
  for (let k = 0; k < 3; k++) {
    const sp = u.champ.spells[k];
    if (!sp) continue;
    const d = e.spellDmg(u, sp);
    if (d > 0) spells += d / Math.max(3, e.cdOf(u, sp, k));
  }
  F.clear = e.aaDps(u) + spells * (u.champ.style.waveclear / 10);
  F.clearAt = e.t;
  return F.clear;
}

function pushShare(e: Engine, u: Unit): number {
  let f: number;
  if (u.task === "siege") f = WAVE_TUNE.pushSide * SIM_TUNE.siegePush;
  else if (u.task === "lane") f = e.laningPhase() ? WAVE_TUNE.pushLane : WAVE_TUNE.pushSide;
  else if (u.task === "jungle") f = WAVE_TUNE.pushGroup * 0.5;
  else f = WAVE_TUNE.pushGroup;
  return f * (0.6 + u.champ.style.waveclear * 0.08) * (u.baronUntil > e.t ? 1.6 : 1);
}

function farm(e: Engine, M: Mod) {
  // the side that picks first alternates each step; within a side the carry farms first
  const first = Math.round(e.t / DT) % 2;
  const order = e.units.filter((u) => canFarm(e, u)).sort((a, b) => (a.side === b.side ? FARM_ORDER[a.role] - FARM_ORDER[b.role] : a.side === first ? -1 : 1));
  if (!order.length) return;
  const reach = WAVE_TUNE.reach;
  const inReach: Minion[] = [];
  for (const u of order) {
    inReach.length = 0;
    for (const m of M.all) {
      if (m.side === u.side || m.hp <= 0 || Math.abs(m.x - u.x) > reach || Math.abs(m.y - u.y) > reach || dist(m, u) > reach) continue;
      inReach.push(m);
    }
    if (!inReach.length) continue;
    // a support leaves the wave alone unless it is clearing it with a group; a jungler leaves it to the laner
    const support = u.role === "Support";
    if (u.role === "Jungle") {
      const c0 = inReach[0];
      if (order.some((o) => o !== u && o.side === u.side && o.role !== "Support" && o.role !== "Jungle" && dist(o, c0) < reach)) continue;
    }
    const F = M.farm[u.i];
    const real = e.realStats();
    const st = real ? Stats.stats(e, u) : null;
    // (casters finish minions with a spell as often as with an attack)
    const hit = st ? st.ad + 0.3 * st.ap : e.aaDps(u) * 1.2;
    const bit = 1 << u.i;
    let p = WAVE_TUNE.lastHit * (0.85 + u.rating / 500);
    if (e.laningPhase() && u.role !== "Jungle") p *= clamp(1 + Matchup.laneEdge(e, u) * Matchup.MATCHUP_TUNE.cs, 0.5, 1.5);
    const defending = underOwnTurret(e, u, inReach);
    if (defending) p *= WAVE_TUNE.underTurret;
    p = clamp(p, 0, 0.98);
    // the finishing blow
    if (!support && e.t >= F.hitAt) {
      let best: Minion | null = null;
      for (const m of inReach) {
        if (m.hp <= 0 || m.miss & bit) continue;
        if (m.hp <= hit * WAVE_TUNE.lhWindow * (100 / (100 + m.armor)) && (!best || m.hp < best.hp)) best = m;
      }
      if (best) {
        F.hitAt = e.t + clamp(1 / (st ? st.as : 0.8), 0.45, WAVE_TUNE.lhEvery);
        if (e.rng.chance(p)) die(e, M, best, "lasthit", u);
        else { best.miss |= bit; M.stats.missed++; }
      }
    }
    // sustained damage into the wave: the lowest minion, and for wave clear champions the ones around it
    // (a wave on the champion's own turret is cleared, not just last hit: it is eating the turret's plates)
    let share = defending ? Math.max(pushShare(e, u), WAVE_TUNE.pushDefend * (0.6 + u.champ.style.waveclear * 0.08)) : pushShare(e, u);
    if (support) share *= WAVE_TUNE.supPush;
    if (share <= 0) continue;
    let main: Minion | null = null;
    if (support) {
      // the healthiest minion, and never into the range its carry finishes them at
      for (const m of inReach) if (m.hp > m.maxHp * 0.4 && (!main || m.hp > main.hp)) main = m;
      if (main) main.hp = Math.max(main.maxHp * 0.4, main.hp - clearDps(e, M, u) * share * DT * (100 / (100 + main.armor)));
      continue;
    }
    for (const m of inReach) if (m.hp > 0 && !(m.miss & bit) && (!main || m.hp < main.hp)) main = m;
    if (!main) continue;
    const dps = clearDps(e, M, u) * share;
    const area = clamp((u.champ.style.waveclear - 2) / 8, 0, 1) * WAVE_TUNE.area;
    const mx = main.x, my = main.y;
    for (const m of inReach) {
      if (m.hp <= 0) continue;
      const isMain = m === main;
      if (!isMain && (area <= 0 || Math.abs(m.x - mx) > 420 || Math.abs(m.y - my) > 420)) continue;
      m.hp -= dps * DT * (isMain ? 1 : area) * (100 / (100 + m.armor));
      if (m.hp <= 0) die(e, M, m, isMain ? "clear" : "skill", m.miss & bit || !e.rng.chance(Math.min(0.98, p + 0.05)) ? null : u);
    }
  }
}

function underOwnTurret(e: Engine, u: Unit, foes: Minion[]): boolean {
  for (const t of e.turrets) {
    if (!t.alive || t.side !== u.side || dist(t.pos, u) > 1100) continue;
    for (const m of foes) if (dist(m, t.pos) < Turrets.RANGE) return true;
  }
  // an inhibitor or the nexus with no turret left in front of it is cleared the same way
  for (const ih of e.inhibs) {
    if (!ih.alive || ih.side !== u.side || dist(ih.pos, u) > 1100) continue;
    for (const m of foes) if (dist(m, ih.pos) < Turrets.RANGE) return true;
  }
  if (dist(NEXUS[u.side], u) < 1100) for (const m of foes) if (dist(m, NEXUS[u.side]) < Turrets.RANGE) return true;
  return false;
}

/**
 * A champion's spell that covers ground also hits the enemy minions in it (engine.emitSpellFx: fights, lane pokes).
 * The caster is paid for the ones it kills.
 */
export function splash(e: Engine, u: Unit, sp: SpellData, at: Vec): void {
  const M = mod(e);
  if (!M.all.length) return;
  const kind = sp.vfx;
  const round = kind === "circle" || kind === "zone" || kind === "knockup" || kind === "cone" || kind === "wall";
  if (!round && kind !== "line") return;
  const dmg = e.spellDmg(u, sp) * WAVE_TUNE.splash;
  if (dmg <= 0) return;
  const r = round ? Math.max(220, sp.radius ?? 250) : (sp.width ?? 120) / 2 + 70;
  const ax = u.x, ay = u.y, bx = at.x, by = at.y;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
  let n = 0;
  for (const m of M.all) {
    if (m.side === u.side || m.hp <= 0) continue;
    let d: number;
    if (round) d = Math.hypot(m.x - bx, m.y - by);
    else {
      const k = clamp(((m.x - ax) * dx + (m.y - ay) * dy) / L2, 0, 1);
      d = Math.hypot(m.x - (ax + dx * k), m.y - (ay + dy * k));
    }
    if (d > r) continue;
    m.hp -= dmg * (100 / (100 + m.armor));
    if (m.hp <= 0) die(e, M, m, "skill", u);
    if (++n >= 8) break;
  }
}

// ---------------------------------------------------------------- upkeep

function sweep(e: Engine, M: Mod) {
  let alive = 0;
  for (const lane of LANES) {
    for (const side of [0, 1] as SideN[]) {
      const arr = M.lanes[lane][side];
      let k = 0;
      for (const m of arr) if (m.hp > 0) arr[k++] = m;
      arr.length = k;
      alive += k;
      if (k > M.stats.maxLane) M.stats.maxLane = k;
    }
  }
  let k = 0;
  for (const m of M.all) if (m.hp > 0) M.all[k++] = m;
  M.all.length = k;
  M.stats.aliveSum += alive;
  M.stats.steps++;
  if (alive > M.stats.maxAlive) M.stats.maxAlive = alive;
}

/** Where the wave attacking `side`'s structures on this lane stops: in front of its outermost standing one. */
function stopU(e: Engine, M: Mod, lane: LaneId, side: SideN): number {
  const gap = (240 / geo(lane).len) * (side === 0 ? 1 : -1);
  const t = e.frontierTurret(side, lane);
  if (t) return t.u + gap;
  const ih = e.inhibs.find((x) => x.side === side && x.lane === lane)!;
  return ih.alive ? M.ihU.get(ih)! + gap : side === 0 ? 0.04 : 0.96;
}

/** The lane front the rest of the engine reads: where the two waves meet, or will meet. */
function fronts(e: Engine, M: Mod) {
  for (const lane of LANES) {
    const [B, R] = M.lanes[lane];
    let b: Minion | null = null, r: Minion | null = null;
    for (const m of B) if (!b || m.u > b.u) b = m;
    for (const m of R) if (!r || m.u < r.u) r = m;
    let raw = M.raw[lane];
    if (b && r) {
      const L = geo(lane).len;
      if ((r.u - b.u) * L <= 700) raw = (b.u + r.u) / 2;
      else {
        // apart: they meet where the walking ones get to (a wave held at a structure waits there)
        const vb = b.moving ? 1 : 0, vr = r.moving ? 1 : 0;
        raw = vb + vr > 0 ? b.u + (r.u - b.u) * (vb / (vb + vr)) : (b.u + r.u) / 2;
      }
    } else if (b) raw = b.u;
    else if (r) raw = r.u;
    // never past a standing structure: with its wave dead at their turret, the lead of the enemy's next wave is
    // still behind that turret, and laners (who stand by the front) walked in under it
    raw = clamp(raw, stopU(e, M, lane, 0), stopU(e, M, lane, 1));
    raw = clamp(raw, 0.04, 0.96);
    M.raw[lane] = raw;
    const Ls = e.lanes[lane];
    const step = WAVE_TUNE.frontRate * DT;
    Ls.front = clamp(Ls.front + clamp(raw - Ls.front, -step, step), 0.04, 0.96);
  }
}
