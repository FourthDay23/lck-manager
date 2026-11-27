// Teamfights with champion kits (owner: fight agent).
// Called by engine.ts when ENGINE_FLAGS.fight is on:
//   init(e)       once, at the end of the Engine constructor
//   combat(e)     every step, replaces the whole old Engine.combat() (lane duels, starting/joining/ending fights,
//                 per-unit fight actions, spells, turret shots at divers)
//
// A fight goes through phases per side: position (hold formation by fight role, poke) -> engage (the engager walks in
// and opens with its engage spell) -> brawl (role targeting, kiting, peel, CC chains) -> retreat (the losing side runs
// together, flashes when about to die). Allies near a fight are called in at once and walk to their side's formation,
// so a team arrives together instead of trickling in. Damage stays on the engine's scale (aaDps / spellDmg, with the
// kit's damage weight in place of SpellData.power).
import type { Engine, Fx, SideN, Unit } from "./engine";
import { ENGINE_FLAGS, SIM_TUNE } from "./engine";
import type { SpellData } from "../data/types";
import type { CcType, ChampionKit, FightRole, SpellKit, SpellUse } from "./kit-types";
import { kitFor } from "./kits";
import * as Stats from "./stats";
import * as Procs from "./procs";
import * as Matchup from "./matchup";
import { buffOf, setCCHook, setFightShields, shieldLeft } from "./procs-lib";
import * as Nav from "./nav";
import * as Macro from "./macro";
import type { Stance } from "./macro";
import * as Turrets from "./turrets";
import { BARON_PIT, DRAGON_PIT, FOUNTAIN, dist } from "./map";
import type { Vec } from "./map";

const DT = 0.25;

/** Calibration knobs (the integrator tunes these against kills/game and game length). */
export const FIGHT_TUNE = {
  aaMul: 1,
  spellMul: 0.9,
  /** damage share for champions caught in an area spell other than its main target */
  aoeMul: 0.75,
  supportMul: 0.9,
  towerMul: 1,
  /** multiplies the chance per second that a fight starts */
  startMul: 1,
  /** how far allies answer a call to a fight (map units) */
  call: 2900,
  callLaning: 2300,
  /** safety cap on one fight */
  maxLen: 30,
  /** a losing side in a fight of 8+ champions calls it this much earlier (power ratio), so 5v5s do not end 0-5 every time */
  bigRetreat: 0.05,
};

type Phase = "position" | "engage" | "brawl" | "retreat";
type FightKind = "trade" | "allin" | "skirmish";

interface UState {
  kit: ChampionKit;
  role: FightRole;
  melee: boolean;
  /** basic attack reach in fights */
  range: number;
  /** longest damaging non-dash spell reach (for artillery standoff) */
  poke: number;
  aaMul: number;
  spMul: number[];
  /** kit damage weights scaled so the champion's spell damage per second matches the engine's SpellData.power */
  kitScale: number;
  /** flank side, -1 / 1 */
  lat: number;
  target: number;
  lockUntil: number;
  rootUntil: number;
  slowUntil: number;
  silenceUntil: number;
  blindUntil: number;
  groundUntil: number;
  /** when the last hard CC on this unit ends */
  ccEnd: number;
  buffUntil: number;
  buffKind: string;
  untargetUntil: number;
  /** running out of the fight */
  bail: boolean;
  bailAt: number;
  pathTo: Vec | null;
  pathAt: number;
  hitChampAt: number;
  /** the enemy champion that hit landed on (turret and minion aggro) */
  hitChampV: number;
  shields: { amt: number; until: number }[];
  joinAt: number;
  /** effective AI uses per slot: the kit's, plus engage/escape fallbacks when the kit lists none */
  uses: SpellUse[][];
  /** allies that shielded / healed / buffed this unit recently (assist credit, as in LoL) */
  helpers: { i: number; until: number }[];
  /** ally saves on this unit: cannot drop below 1 hp / comes back once */
  invulnUntil: number;
  reviveUntil: number;
  /** knocked up / back (for spells that require an airborne target) */
  airUntil: number;
  /** walled in (arena CC): cannot leave the ring */
  arenaUntil: number;
  arena: { x: number; y: number; r: number };
  /** when each enemy caster last landed a spell on this unit (spells that need a mark) */
  marks: Map<number, number>;
  /** stays to finish a low enemy although its team is pulling out (trading back) */
  commitUntil: number;
  /** a hook that landed: the caster follows it to `aim` once it has flown (HOOK_TRAVEL), see upkeep */
  hook: { at: number; aim: number; len: number; walls: boolean } | null;
  /** outside a fight: since when it has stood in range of an enemy turret with no wave on it (-1: it is not), see turretShots */
  towerAt: number;
}

interface EngagePlan { u: number; k: number; aim: number; count: number }

interface FInfo {
  id: number;
  kind: FightKind;
  origin: string;
  phase: [Phase, Phase];
  phaseAt: [number, number];
  maxLen: number;
  extended: boolean;
  next: number;
  nextCall: number;
  nextSample: number;
  plan: [EngagePlan | null, EngagePlan | null];
  /** what turned the fight into a brawl */
  opened: string | null;
  firstDmg: number;
  brawlAt: number;
  members: Set<number>;
  initiator: SideN;
  logged: boolean;
  /** seconds each side holds its formation before it may engage */
  hold: [number, number];
}

export interface FightStats {
  fights: number;
  trades: number;
  allins: number;
  teamfights: number;
  opened: Record<string, number>;
  openedSmall: Record<string, number>;
  cc: number;
  ccChains: number;
  ccOverlaps: number;
  ults: number;
  ultAoe: number;
  ultMulti: number;
  casts: Record<string, number>;
  hits: number;
  misses: number;
  kills: number;
  killsBySize: Record<string, number>;
  /** kills with no assist, by fight size bucket */
  soloBySize: Record<string, number>;
  /** solo kills in fights of 5+: turret / chased runner / in the brawl */
  soloWhy: Record<string, number>;
  flashes: number;
  escapes: number;
  retreats: number;
  ends: Record<string, number>;
  /** how skirmishes start: "position" (both sides set up), "brawl" (pick / gank), "caught" (one side runs at once) */
  starts: Record<string, number>;
  posTime: number[];
  durations: number[];
  sizes: number[];
  /** spacing in fights with 6+ members, sampled once a second while brawling */
  spaceMates: number[];
  spaceRangedToTarget: number[];
  spaceBackToFront: number[];
  spaceEnchToCarry: number[];
}

interface Mod {
  /** hurt() for combat effects (procs.ts): damage from items, runes, summoner spells and passives */
  deal: Procs.Deal;
  u: UState[];
  f: Map<number, FInfo>;
  stats: FightStats;
  log: ((line: string, fight: number) => void) | null;
  /** fight being processed (log context) */
  cur: number;
  tower: { target: number; fxAt: number }[];
}

const HARD = new Set<CcType>(["stun", "knockup", "knockback", "pull", "charm", "taunt", "fear", "sleep", "suppress", "polymorph"]);
const SQUISHY = new Set<FightRole>(["backline", "artillery", "enchanter", "assassin"]);
const DIVE = new Set<FightRole>(["diver", "assassin"]);

function newStats(): FightStats {
  return {
    fights: 0, trades: 0, allins: 0, teamfights: 0, opened: {}, openedSmall: {}, cc: 0, ccChains: 0, ccOverlaps: 0,
    ults: 0, ultAoe: 0, ultMulti: 0, casts: {}, hits: 0, misses: 0, kills: 0, killsBySize: {}, soloBySize: {}, soloWhy: {}, flashes: 0, escapes: 0,
    retreats: 0, ends: {}, starts: {}, posTime: [], durations: [], sizes: [], spaceMates: [], spaceRangedToTarget: [], spaceBackToFront: [],
    spaceEnchToCarry: [],
  };
}

// ---------------------------------------------------------------- setup

export function init(e: Engine): void {
  const m: Mod = {
    deal: () => {}, u: e.units.map((u) => makeUnit(e, u)), f: new Map(), stats: newStats(), log: null, cur: 0,
    tower: e.turrets.map(() => ({ target: -1, fxAt: 0 })),
  };
  m.deal = (src, v, amount, kind) => hurt(e, m, src, v, amount, kind);
  e.mods.fight = m;
  // crowd control from combat effects (Nautilus' root, Braum's stun ...) goes through applyCC
  setCCHook((e2, src, v, type, dur) => { applyCC(e2, mod(e2), src, v, { type: type as CcType, dur }); });
  // shields from combat effects and these here drain one pool: expiring ones see each other (shieldLeft)
  setFightShields((e2, u) => mod(e2).u[u.i]?.shields ?? []);
}

function mod(e: Engine): Mod {
  let m = e.mods.fight as Mod | undefined;
  if (!m) {
    init(e);
    m = e.mods.fight as Mod;
  }
  return m;
}

/** When `u` last damaged an enemy champion in a fight, and whom: a turret turns on a champion that hits one of its
 *  own in its range, and so do the minions next to it (turrets.ts, minions.ts). */
export function lastChampHit(e: Engine, u: Unit): { at: number; v: number } {
  const s = (e.mods.fight as Mod | undefined)?.u[u.i];
  return s ? { at: s.hitChampAt, v: s.hitChampV } : { at: -9, v: -1 };
}

/** False while `u` cannot be targeted (stasis, an untargetable spell): turrets and minions leave it alone too. */
export function hittable(e: Engine, u: Unit): boolean {
  const s = (e.mods.fight as Mod | undefined)?.u[u.i];
  return !s || e.t >= s.untargetUntil;
}

/** Damage to a champion from lane minions (minions.ts), with the fight's shields, saves and kill credit. */
export function outsideHurt(e: Engine, v: Unit, amount: number): void {
  hurt(e, mod(e), null, v, amount, "proc");
}

/** Fight stats of this engine (fight-test). */
export function stats(e: Engine): FightStats {
  return mod(e).stats;
}
/** Send a line per fight action to `fn` (fight-test), tagged with the fight id (0 = none); null turns it off. */
export function setLog(e: Engine, fn: ((line: string, fight: number) => void) | null): void {
  mod(e).log = fn;
}
/** The unit u is attacking in its fight, if any. */
export function targetOf(e: Engine, u: Unit): Unit | null {
  const t = mod(e).u[u.i]?.target ?? -1;
  return t >= 0 ? e.units[t] : null;
}
export function fightRole(e: Engine, u: Unit): FightRole {
  return mod(e).u[u.i].role;
}
export function phaseOf(e: Engine, fightId: number, side: SideN): string | null {
  return mod(e).f.get(fightId)?.phase[side] ?? null;
}

function makeUnit(e: Engine, u: Unit): UState {
  const kit = kitFor(u.champ);
  const melee = !u.champ.ranged;
  const range = melee ? 200 : Math.max(450, u.champ.attackRange || 500);
  let poke = range;
  kit.spells.forEach((sk, k) => {
    if (!sk || sk.dmg <= 0 || sk.dash || k === 3 || sk.target === "self" || sk.target === "ally") return;
    const r = sk.range > 3000 ? 0 : sk.range;
    if (sk.uses.includes("poke") || sk.uses.includes("dps") || sk.uses.includes("burst")) poke = Math.max(poke, Math.min(1400, r));
  });
  // real numbers (engine.realStats) need neither: the spell ratios and attack stats are the champion's own
  const real = e.realStats();
  const ks = real ? 1 : kitScale(u, kit);
  const { aa, sp } = real ? { aa: 1, sp: [1, 1, 1, 1] } : dmgProfile(u, kit, ks);
  return {
    kit, role: kit.role, melee, range, poke, aaMul: aa, spMul: sp, kitScale: ks, lat: u.i % 2 ? 1 : -1, target: -1, lockUntil: 0,
    rootUntil: 0, slowUntil: 0, silenceUntil: 0, blindUntil: 0, groundUntil: 0, ccEnd: 0, buffUntil: 0, buffKind: "",
    untargetUntil: 0, bail: false, bailAt: 0, pathTo: null, pathAt: -9, hitChampAt: -9, hitChampV: -1, shields: [], joinAt: 0,
    uses: effectiveUses(kit, melee), helpers: [], invulnUntil: 0, reviveUntil: 0, airUntil: 0, arenaUntil: 0,
    arena: { x: 0, y: 0, r: 0 }, marks: new Map(), commitUntil: 0, hook: null, towerAt: -1,
  };
  void e;
}

/**
 * The kit's uses per slot, plus fallbacks so a kit without explicit engage/escape data (the stub, or a champion the
 * kits table does not cover) still plays its role: a frontline/diver hard-CC that dashes or reaches far is its engage,
 * and a dash that can go anywhere doubles as an escape.
 */
function effectiveUses(kit: ChampionKit, melee: boolean): SpellUse[][] {
  const hasEngage = kit.spells.some((sk) => sk?.uses.includes("engage"));
  const hasEscape = kit.spells.some((sk) => sk?.uses.includes("escape"));
  return kit.spells.map((sk, k) => {
    if (!sk) return [];
    const uses = [...sk.uses];
    const hard = !!sk.cc && HARD.has(sk.cc.type);
    const engager = kit.role === "frontline" || kit.role === "diver" || (kit.role === "skirmisher" && melee);
    if (!hasEngage && engager && hard && (!!sk.dash || (k === 3 && areaRadius(sk) >= 200) || (sk.range >= 600 && sk.range < 3000))) uses.unshift("engage");
    const dashy = !!sk.dash || sk.shape === "dash" || sk.shape === "blink";
    if (!hasEscape && dashy && !uses.includes("escape") && (sk.dash?.to !== "ally")) uses.push("escape");
    return uses;
  });
}

/**
 * Kit damage weights come from real spell data and do not sum to what the engine was calibrated with: keep the
 * champion's spell damage per second (sum of weight / cooldown) equal to the engine's (SpellData.power / cd), so the
 * kit only redistributes damage between the four spells.
 */
function kitScale(u: Unit, kit: ChampionKit): number {
  // same cast-count model as kits.gen.ts: casts per 12 s fight = max(1, 12 / cd)
  const casts = (cd: number) => Math.max(1, 12 / Math.max(0.5, cd));
  let eng = 0, kt = 0;
  u.champ.spells.forEach((sp, k) => {
    eng += (sp.power || 1) * casts(sp.cd || (k === 3 ? 100 : 10));
    const sk = kit.spells[k];
    if (sk && sk.dmg > 0) kt += sk.dmg * casts(sk.cd || sp.cd || 10);
  });
  return kt > 0 ? clamp(eng / kt, 0.6, 1.6) : 1;
}

/**
 * Pro damage profile: when the kit knows what share of a champion's damage came from basic attacks and each spell,
 * nudge the engine's generic split toward it (square-root damped, total kept), so Jinx hits with attacks and Syndra
 * with spells without changing how much damage a champion deals overall.
 */
function dmgProfile(u: Unit, kit: ChampionKit, scale: number): { aa: number; sp: number[] } {
  const flat = { aa: 1, sp: [1, 1, 1, 1] };
  const share = kit.dmgShare;
  if (!share || (kit.games ?? 0) < 4) return flat;
  const tags = u.champ.tags;
  const mark = tags.includes("Marksman") ? 1.55 : tags.includes("Fighter") ? 1.15 : tags.includes("Support") ? 0.6 : 0.85;
  const caster = tags.includes("Mage") || tags.includes("Assassin") ? 1.35 : tags.includes("Support") ? 0.7 : 1;
  const L = 11;
  // engine damage over a 12 s fight at level 11: attacks ~60% uptime, each spell max(1, 12 / cd) casts
  // (the kits' cast-count model, so a kit that matches pro data needs no correction)
  const eng = [(24 + L * 6) * mark * 12 * 0.6];
  for (let k = 0; k < 4; k++) {
    const sk = kit.spells[k];
    eng.push(sk && sk.dmg > 0 ? (20 + L * 13) * sk.dmg * scale * caster * Math.max(1, 12 / Math.max(0.5, sk.cd || 10)) : 0);
  }
  const totE = eng.reduce((a, b) => a + b, 0);
  const totS = share.reduce((a, b) => a + b, 0);
  if (totE <= 0 || totS <= 0) return flat;
  const mul = eng.map((v, i) => {
    if (v <= 0) return 1;
    const want = share[i] / totS, have = v / totE;
    return Math.max(0.6, Math.min(1.6, Math.sqrt(Math.max(0.05, want) / have)));
  });
  const after = eng.reduce((a, v, i) => a + v * mul[i], 0);
  const norm = totE / Math.max(1, after);
  return { aa: mul[0] * norm, sp: [1, 2, 3, 4].map((i) => mul[i] * norm) };
}

// ---------------------------------------------------------------- small helpers

type Calm = Unit & { calmUntil?: number };
const calm = (e: Engine, u: Unit) => ((u as Calm).calmUntil ?? 0) > e.t;
const setCalm = (u: Unit, until: number) => ((u as Calm).calmUntil = until);
const hpF = (u: Unit) => u.hp / Math.max(1, u.maxHp);
const nm = (u: Unit) => `${u.side ? "R" : "B"}:${u.name}(${u.champ.name})`;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const norm = (x: number, y: number): Vec => {
  const d = Math.hypot(x, y) || 1;
  return { x: x / d, y: y / d };
};
const ts = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

function stanceOf(e: Engine, u: Unit): Stance {
  return ENGINE_FLAGS.macro ? Macro.stance(e, u) : "free";
}

function log(e: Engine, M: Mod, line: string, fight = M.cur) {
  if (M.log) M.log(`[${ts(e.t)}] ${line}`, fight);
}

/** Engine's spell damage for this spell with the kit's damage weight in place of SpellData.power. */
function spellBase(e: Engine, u: Unit, sp: SpellData) {
  return e.spellDmg(u, sp) / (sp.power || 1);
}

/**
 * Damage of one cast of spell k. Real numbers (engine.realStats): the spell's own ratios at its rank, after v's armor /
 * magic resist (v = null: a typical target, for the AI's estimates); the kit's damage weight only says whether the AI
 * treats the spell as a damage spell. Older path: the engine's formula with the kit's weight.
 */
function spellDamage(e: Engine, M: Mod, u: Unit, k: number, v: Unit | null = null): number {
  const sp = u.champ.spells[k];
  const sk = M.u[u.i].kit.spells[k];
  if (!sp || !sk || sk.dmg <= 0) return 0;
  const us = M.u[u.i];
  if (e.realStats()) {
    if (Stats.noDamage(u, k)) return 0;
    const raw = Stats.hasDamage(u, k) ? Stats.spellRaw(e, u, k, v) : Stats.fallbackRaw(u, sk.dmg);
    const net = v ? Stats.mitigate(e, u, v, raw) : (raw.p + raw.m) * 0.62 + raw.t;
    return net * e.realMul(u, "sp") * FIGHT_TUNE.spellMul;
  }
  return spellBase(e, u, sp) * sk.dmg * us.kitScale * us.spMul[k] * FIGHT_TUNE.spellMul;
}

/** Heal / shield size of a support spell when the data has none: the engine's level curve x the kit's weight. */
function legacySupport(e: Engine, u: Unit, weight: number) {
  return (20 + u.level * 13) * weight * e.skill(u) * FIGHT_TUNE.supportMul * (1 + Stats.stats(e, u).hsp);
}

/** Already-mitigated damage. With real numbers it first passes the combat effects (amplifiers, damage reduction,
 *  lifelines, spell storing), then saves (Guardian Angel, Zhonya's, passives), and afterwards life steal / riders. */
function hurt(e: Engine, M: Mod, src: Unit | null, v: Unit, amount: number, kind: Procs.Kind = "spell") {
  if (!v.alive || amount <= 0) return;
  // LCK champion matchups (matchup.ts). Not on Death's Dance's stored damage ("raw": it was multiplied when it was
  // stored), and a killing blow stays one (an execute such as Collector's deals exactly the health left)
  if (src && kind !== "raw") {
    const lethal = amount >= v.hp + v.shield;
    amount *= Matchup.dmgMul(e, src, v);
    if (lethal) amount = Math.max(amount, v.hp + v.shield + 1);
  }
  const real = e.realStats();
  if (real) {
    amount = Procs.incoming(e, src, v, amount, kind, M.deal);
    if (amount <= 0 || !v.alive) return;
  }
  const vs = M.u[v.i];
  if (e.t < vs.invulnUntil) amount = Math.min(amount, Math.max(0, v.hp + v.shield - 1));
  if (e.t < vs.reviveUntil && amount >= v.hp + v.shield) {
    // revive: the killing blow is undone once
    vs.reviveUntil = 0;
    v.hp = v.maxHp * 0.35;
    log(e, M, `  ✚ ${nm(v)} revived`, v.fightId);
    return;
  }
  if (amount <= 0) return;
  if (real && amount >= v.hp + v.shield && Procs.onLethal(e, v, src, M.deal)) return;
  const fid = v.fightId;
  const info = fid ? M.f.get(fid) : undefined;
  const f = fid ? e.fights.get(fid) : undefined;
  if (src) {
    // whoever shielded / healed / buffed the attacker shares the kill (LoL assist rule)
    const hs = M.u[src.i].helpers;
    for (let i = hs.length - 1; i >= 0; i--) {
      if (hs[i].until < e.t) hs.splice(i, 1);
      else if (hs[i].i !== src.i) v.lastHitBy.set(hs[i].i, e.t);
    }
  }
  e.damage(src, v, amount);
  // an effect below may finish v through a nested hurt(), which counts that kill itself
  const died = !v.alive;
  if (real) Procs.onDealt(e, src, v, amount, kind, M.deal);
  if (f) f.last = e.t;
  if (info && info.firstDmg < 0) info.firstDmg = e.t;
  if (src) { M.u[src.i].hitChampAt = e.t; M.u[src.i].hitChampV = v.i; }
  if (died) {
    M.stats.kills++;
    const n = info ? info.members.size : 0;
    const b = n <= 0 ? "none" : n <= 2 ? "2" : n <= 4 ? "3-4" : n <= 7 ? "5-7" : "8-10";
    M.stats.killsBySize[b] = (M.stats.killsBySize[b] ?? 0) + 1;
    const credit = [...v.lastHitBy.entries()].filter(([i, t]) => e.t - t < 10 && e.units[i].side !== v.side && i !== src?.i).length;
    if (!credit || (!src && credit === 1)) {
      M.stats.soloBySize[b] = (M.stats.soloBySize[b] ?? 0) + 1;
      if (n >= 5) {
        const why = !src ? "turret" : M.u[v.i].bail ? "chased" : M.u[src.i].role + ">" + M.u[v.i].role;
        M.stats.soloWhy[why] = (M.stats.soloWhy[why] ?? 0) + 1;
      }
    }
    log(e, M, `  ✖ ${nm(v)} slain by ${src ? nm(src) : "turret"}${info ? ` (fight #${info.id}, ${n} in fight)` : ""}`, info?.id ?? 0);
  }
}

/** Move toward p this step, around walls when the nav module is on. `mul` scales speed (kiting, slows). */
function inArena(e: Engine, M: Mod, u: Unit, p: Vec): Vec {
  const s = M.u[u.i];
  if (e.t >= s.arenaUntil) return p;
  const d = dist(p, s.arena);
  if (d <= s.arena.r) return p;
  return { x: s.arena.x + ((p.x - s.arena.x) / d) * s.arena.r * 0.95, y: s.arena.y + ((p.y - s.arena.y) / d) * s.arena.r * 0.95 };
}

function moveTo(e: Engine, M: Mod, u: Unit, p0: Vec, mul = 1) {
  const s = M.u[u.i];
  if (e.t < u.stunUntil || e.t < s.rootUntil) return;
  const p = inArena(e, M, u, p0);
  if (dist(u, p) < 25) return;
  if (ENGINE_FLAGS.nav) {
    const stale = !s.pathTo || dist(s.pathTo, p) > 160 || e.t - s.pathAt > 0.75 || !u.path.length;
    if (stale) {
      const dest = Nav.walkable(p) ? p : Nav.nearestWalkable(p);
      u.path = Nav.lineOfSight(u, dest) ? [{ x: dest.x, y: dest.y }] : Nav.findPath(u, dest);
      s.pathTo = { x: p.x, y: p.y };
      s.pathAt = e.t;
    } else if (u.path.length === 1 && dist(u.path[0], p) < 160) {
      u.path[0] = { x: p.x, y: p.y };
    }
  } else {
    u.path = [{ x: p.x, y: p.y }];
  }
  let m = mul;
  if (e.t < s.slowUntil) m *= 0.65;
  if (e.t < s.buffUntil && s.buffKind === "ms") m *= 1.25;
  e.moveStep(u, DT * m);
}

/** Dash/blink the caster toward `to` (at most len); returns the start point, or null if it could not move. */
function dashMove(e: Engine, M: Mod, u: Unit, to: Vec, len: number, overWalls: boolean): Vec | null {
  const s = M.u[u.i];
  if (e.t < u.stunUntil || e.t < s.rootUntil || e.t < s.groundUntil) return null;
  const from = { x: u.x, y: u.y };
  to = inArena(e, M, u, to);
  const d = dist(from, to);
  if (d < 40) return null;
  const goal = d > len ? { x: from.x + ((to.x - from.x) / d) * len, y: from.y + ((to.y - from.y) / d) * len } : { x: to.x, y: to.y };
  const p = ENGINE_FLAGS.nav ? Nav.blinkLanding(from, goal, len, overWalls) : goal;
  if (dist(p, from) < 40) return null;
  u.x = p.x;
  u.y = p.y;
  u.path = [];
  u.goal = null;
  s.pathTo = null;
  return from;
}

function displace(e: Engine, v: Unit, dx: number, dy: number) {
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const to = { x: v.x + dx, y: v.y + dy };
  const p = ENGINE_FLAGS.nav ? Nav.blinkLanding(v, to, len, false) : to;
  v.x = p.x;
  v.y = p.y;
  v.path = [];
}

function targetable(e: Engine, M: Mod, f: Unit, from: Unit): boolean {
  if (!f.alive) return false;
  const s = M.u[f.i];
  if (e.t < s.untargetUntil) return false;
  // in a stasis save (Guardian Angel, Zhonya's, Sion's reanimation): nothing to hit
  if (buffOf(e, f, "stasis") > 0) return false;
  if (e.t < s.buffUntil && s.buffKind === "stealth" && dist(f, from) > 350) return false;
  return true;
}

// ---------------------------------------------------------------- main step

export function combat(e: Engine): void {
  const M = mod(e);
  for (const u of e.units) if (u.fightId && !e.fights.has(u.fightId)) dropOut(e, M, u);
  upkeep(e, M);
  const k0 = e.kills[0] + e.kills[1];
  const kBefore = M.stats.kills;
  e.laneDuels();
  startFights(e, M);
  mergeFights(e, M);
  for (const [id, f] of [...e.fights]) runFight(e, M, id, f);
  M.cur = 0;
  turretShots(e, M);
  // combat effects: damage over time, auras, item actives, summoner spells, expiring shields
  if (e.realStats()) Procs.tick(e, DT, M.deal);
  // kills from lane pokes (engine.laneDuels) do not go through hurt()
  const k1 = e.kills[0] + e.kills[1];
  const missed = k1 - k0 - (M.stats.kills - kBefore);
  if (missed > 0) M.stats.killsBySize.none = (M.stats.killsBySize.none ?? 0) + missed;
}

function dropOut(e: Engine, M: Mod, u: Unit) {
  e.leaveFight(u);
  M.u[u.i].bail = false;
  M.u[u.i].target = -1;
}

function upkeep(e: Engine, M: Mod) {
  for (const u of e.units) {
    const s = M.u[u.i];
    // engine.kill() clears fightId directly, so a unit that died mid-fight never passes through end()/dropOut()
    if (!u.alive && (s.bail || s.target >= 0)) {
      s.bail = false;
      s.target = -1;
      s.commitUntil = 0;
    }
    if (s.hook && (!u.alive || e.t >= s.hook.at)) {
      // the hook has reached its target: the caster is carried to it (Thresh Q, Nautilus Q, Leona E...)
      const h = s.hook;
      s.hook = null;
      const v = e.units[h.aim];
      // the tether breaks if the caster is pulling out, the target vanished (stealth, untargetable) or was moved far away
      if (u.alive && v && targetable(e, M, v, u) && !s.bail && dist(u, v) <= h.len + 300) {
        const n = norm(v.x - u.x, v.y - u.y);
        const len = Math.max(0, Math.min(h.len, dist(u, v) - 110));
        const from = len > 40 ? dashMove(e, M, u, { x: u.x + n.x * len, y: u.y + n.y * len }, h.len, h.walls) : null;
        if (from) log(e, M, `  ${nm(u)} follows the hook to ${nm(v)} (dash ${Math.round(dist(from, u))}u)`, u.fightId || 0);
      }
    }
    if (!s.shields.length) continue;
    if (!u.alive) {
      s.shields = [];
      continue;
    }
    s.shields = s.shields.filter((sh) => {
      if (e.t < sh.until) return true;
      // only what this shield still holds goes away (shields absorb in expiry order; procs.ts shields count too)
      u.shield = Math.max(0, u.shield - shieldLeft(e, u, sh));
      return false;
    });
  }
}

// ---------------------------------------------------------------- starting fights

function startFights(e: Engine, M: Mod) {
  const alive = e.units.filter((u) => u.alive && u.recallEnd === undefined);
  for (const u of alive) {
    if (u.fightId || calm(e, u)) continue;
    const st = stanceOf(e, u);
    for (const foe of alive) {
      if (foe.side === u.side || calm(e, foe)) continue;
      const d = dist(u, foe);
      // a ganking jungler holds at the edge of the turret's range instead of walking in (engine.jungleTick): from
      // there it can still open the dive on a target that sits under its turret
      const reach = d > 1050 && u.task === "gank" && e.turrets.some((t) => t.alive && t.side === foe.side && dist(t.pos, foe) < 860) ? SIM_TUNE.gankReach : 1050;
      if (d > reach) continue;
      if (foe.fightId) {
        // walking into an ongoing fight: only when actually in contact, never from across the river
        if (d < 650 && st !== "avoid" && e.fights.has(foe.fightId) && M.f.get(foe.fightId)?.kind === "skirmish") {
          const info = M.f.get(foe.fightId)!;
          join(e, M, u, foe.fightId, info, "contact");
        }
        break;
      }
      const myGroup = alive.filter((x) => x.side === u.side && !x.fightId && !calm(e, x) && dist(x, u) < 1500 && (x === u || x.task !== "recall") && (x === u || stanceOf(e, x) !== "avoid" || dist(x, foe) < 700));
      const theirGroup = alive.filter((x) => x.side === foe.side && !x.fightId && !calm(e, x) && dist(x, foe) < 1500);
      const mp = myGroup.reduce((a, x) => a + e.power(x), 0);
      const tp = theirGroup.reduce((a, x) => a + e.power(x), 0) || 1;
      const ratio = mp / tp;
      const underTurret = e.turrets.some((t) => t.alive && t.side === foe.side && dist(t.pos, foe) < 800);
      let rate = e.engageRate(u, foe, ratio, underTurret, myGroup.length + theirGroup.length) * FIGHT_TUNE.startMul;
      rate *= startMod(e, M, u, st, foe, myGroup, ratio);
      if (rate > 0 && e.rng.chance(clamp(rate * DT, 0, 0.9))) {
        begin(e, M, u, foe, myGroup, theirGroup, ratio);
        break;
      }
      if (ratio < 0.6 && u.task !== "obj" && u.task !== "siege") {
        const home = e.nearestOwnTurret(u);
        if (home) e.setGoal(u, home);
      }
    }
  }
}

/** Stance, kit and HP adjustments on top of the engine's base engage rate. */
function startMod(e: Engine, M: Mod, u: Unit, st: Stance, foe: Unit, mine: Unit[], ratio: number): number {
  if (st === "avoid") return 0;
  let m = 1;
  if (st === "engage") m *= 1.8;
  else if (st === "hold") {
    const defending = e.turrets.some((t) => t.alive && t.side === u.side && dist(t.pos, foe) < 1600) || dist(foe, DRAGON_PIT) < 1500 || dist(foe, BARON_PIT) < 1500;
    m *= defending ? 1 : 0.4;
  }
  // a group with an engage tool up is more willing to go
  if (!e.laningPhase() && mine.length >= 2) {
    const ready = mine.some((x) => M.u[x.i].uses.some((us, k) => us.includes("engage") && e.t >= x.cds[k]));
    if (ready) m *= 1.2;
    else if (ratio < 1.1) m *= 0.8;
  }
  const avgHp = mine.reduce((a, x) => a + hpF(x), 0) / Math.max(1, mine.length);
  if (avgHp < 0.5) m *= 0.5;
  if (!ENGINE_FLAGS.macro) {
    const strat = e.strategy[u.side];
    const min = e.minute();
    if (strat === "scaling" && min < 25) m *= 0.75;
    else if (strat === "early" && min < 15) m *= 1.25;
    else if (strat === "teamfight" && min >= 14) m *= 1.15;
  }
  return m;
}

function newInfo(e: Engine, id: number, origin: string, kind: FightKind, initiator: SideN): FInfo {
  return {
    id, kind, origin, phase: ["brawl", "brawl"], phaseAt: [e.t, e.t],
    maxLen: kind === "trade" ? 3.5 + e.rng.next() * 2 : kind === "allin" ? (e.minute() > 24 ? 20 : 12) : FIGHT_TUNE.maxLen,
    extended: false, next: e.t + 0.5, nextCall: e.t + 1, nextSample: e.t + 1, plan: [null, null], opened: null, firstDmg: -1,
    brawlAt: -1, members: new Set(), initiator, logged: false, hold: [1.5 + e.rng.next() * 1.5, 1.5 + e.rng.next() * 1.5],
  };
}

function begin(e: Engine, M: Mod, u: Unit, foe: Unit, mine: Unit[], theirs: Unit[], ratio: number) {
  const id = ++e.fightSeq;
  const laning = e.laningPhase();
  const trade = laning && mine.length + theirs.length <= 3 && u.task !== "gank";
  const origin = u.task === "gank" ? "gank" : u.task === "siege" ? "siege" : u.task === "obj" ? "obj" : laning ? "early" : "mid";
  e.fights.set(id, { x: (u.x + foe.x) / 2, y: (u.y + foe.y) / 2, start: e.t, last: e.t, trade, origin });
  const info = newInfo(e, id, origin, trade ? "trade" : "skirmish", u.side);
  M.f.set(id, info);
  M.cur = id;
  M.stats.fights++;
  if (trade) M.stats.trades++;
  for (const x of [...mine, ...theirs]) join(e, M, x, id, info, "start");
  const f = e.fights.get(id)!;
  if (!trade) callAllies(e, M, info, f, true);
  // opening phases: picks and ganks go straight in; group meetings set up first
  const s = u.side, o = (1 - s) as SideN;
  const small = mine.length + theirs.length <= 3 && !hasCallers(e, info);
  if (trade || origin === "gank") info.phase = ["brawl", "brawl"];
  else if (small) {
    info.phase[s] = "brawl";
    info.phase[o] = 1 / Math.max(0.01, ratio) < 0.62 ? "retreat" : "brawl";
  } else {
    info.phase = ["position", "position"];
  }
  if (info.phase[s] === "brawl" && info.phase[o] === "brawl") info.brawlAt = e.t;
  if (info.phase[o] === "retreat") sideRetreat(e, M, info, o, "caught");
  if (!trade) {
    const key = info.phase[o] === "retreat" ? "caught" : info.phase[s] === "position" ? "position" : origin === "gank" ? "gank" : "pick";
    M.stats.starts[key] = (M.stats.starts[key] ?? 0) + 1;
  }
  log(e, M, `FIGHT #${id} ${origin}${trade ? " (trade)" : ""} started by ${nm(u)} on ${nm(foe)} — ratio ${ratio.toFixed(2)}, phases B:${info.phase[0]} R:${info.phase[1]}`);
}

function hasCallers(e: Engine, info: FInfo) {
  for (const i of info.members) if (M_joinedFar(e, i, info)) return true;
  return false;
}
function M_joinedFar(e: Engine, i: number, info: FInfo) {
  const u = e.units[i];
  const f = e.fights.get(info.id);
  return !!f && u.fightId === info.id && dist(u, f) > 1200;
}

function join(e: Engine, M: Mod, u: Unit, id: number, info: FInfo, how: string) {
  if (u.fightId === id) return;
  e.joinFight(u, id);
  const s = M.u[u.i];
  s.bail = false;
  s.target = -1;
  s.joinAt = e.t;
  s.pathTo = null;
  info.members.add(u.i);
  if (M.log && how !== "start") {
    const f = e.fights.get(id);
    log(e, M, `  + ${nm(u)} [${s.role}] joins #${id} (${how}${f ? `, ${Math.round(dist(u, f))}u away` : ""})`);
  }
}

/** Allies of both teams near a fight answer the call together and walk to their side's formation. */
function callAllies(e: Engine, M: Mod, info: FInfo, f: { x: number; y: number }, initial: boolean) {
  if (info.kind !== "skirmish") return;
  const laning = e.laningPhase();
  const present = [false, false];
  for (const i of info.members) if (e.units[i].alive && e.units[i].fightId === info.id) present[e.units[i].side] = true;
  const nearPit = dist(f, DRAGON_PIT) < 2200 || dist(f, BARON_PIT) < 2200;
  for (const x of e.units) {
    if (!x.alive || x.fightId || x.recallEnd !== undefined || calm(e, x) || !present[x.side] || info.phase[x.side] === "retreat") continue;
    if (x.task === "recall" || hpF(x) < 0.4) continue;
    const st = stanceOf(e, x);
    if (st === "avoid") continue;
    const d = dist(x, f);
    let R = laning ? FIGHT_TUNE.callLaning : FIGHT_TUNE.call;
    if (info.origin === "obj" || nearPit) R += 600;
    if (st === "engage") R += 400;
    else if (st === "hold") R -= 900;
    if (!ENGINE_FLAGS.macro && e.strategy[x.side] === "teamfight" && !laning) R += 400;
    if (d > R) continue;
    let p = st === "engage" ? 1 : st === "hold" ? 0.5 : 0.85;
    if (!initial) {
      p *= 0.3;
      if (d / e.speed(x) > 7) continue;
    }
    if (!e.rng.chance(p)) continue;
    join(e, M, x, info.id, info, initial ? "called" : "late call");
  }
}

function mergeFights(e: Engine, M: Mod) {
  if (e.fights.size < 2) return;
  const ids = [...e.fights.keys()];
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      const A = e.fights.get(ids[a]), B = e.fights.get(ids[b]);
      const IA = M.f.get(ids[a]), IB = M.f.get(ids[b]);
      if (!A || !B || !IA || !IB || IA.kind !== "skirmish" || IB.kind !== "skirmish") continue;
      if (dist(A, B) > 1000) continue;
      const [keep, drop, KI, DI] = IA.members.size >= IB.members.size ? [ids[a], ids[b], IA, IB] : [ids[b], ids[a], IB, IA];
      for (const u of e.units) if (u.fightId === drop) join(e, M, u, keep, KI, "merge");
      KI.opened ??= DI.opened;
      e.fights.get(keep)!.start = Math.min(e.fights.get(keep)!.start, e.fights.get(drop)!.start);
      e.fights.delete(drop);
      M.f.delete(drop);
      log(e, M, `  fights #${drop} and #${keep} merge`, keep);
      return;
    }
  }
}

// ---------------------------------------------------------------- one fight per step

interface Geo {
  C: [Vec, Vec];
  dir: [Vec, Vec];
  /** the most advanced point of each side along its own push direction */
  front: [Vec, Vec];
  carry: [Unit | null, Unit | null];
  focus: Map<number, number>;
}

function sideCentroid(list: Unit[], f: Vec): Vec {
  const near = list.filter((u) => dist(u, f) < 1700);
  const use = near.length ? near : list;
  if (!use.length) return { x: f.x, y: f.y };
  return { x: use.reduce((a, u) => a + u.x, 0) / use.length, y: use.reduce((a, u) => a + u.y, 0) / use.length };
}

function pickCarry(M: Mod, list: Unit[]): Unit | null {
  let best: Unit | null = null, bv = -Infinity;
  for (const u of list) {
    const r = M.u[u.i].role;
    // the one the team protects: a ranged damage dealer (or the bot / mid laner when nobody is ranged)
    const ranged = r === "backline" || r === "artillery";
    if (!ranged && u.role !== "Bot" && u.role !== "Mid") continue;
    if (r === "enchanter" || r === "frontline") continue;
    const v = (ranged ? 2 : 0) + (u.role === "Bot" ? 1 : u.role === "Mid" ? 0.6 : 0) + u.gold / 12000 + hpF(u) * 0.3;
    if (v > bv) { bv = v; best = u; }
  }
  return best;
}

function geometry(e: Engine, M: Mod, f: Vec, side: [Unit[], Unit[]]): Geo {
  const act = side.map((l) => l.filter((u) => !M.u[u.i].bail)) as [Unit[], Unit[]];
  const C: [Vec, Vec] = [sideCentroid(act[0].length ? act[0] : side[0], f), sideCentroid(act[1].length ? act[1] : side[1], f)];
  const d0 = norm(C[1].x - C[0].x, C[1].y - C[0].y);
  const dir: [Vec, Vec] = [d0, { x: -d0.x, y: -d0.y }];
  const front: [Vec, Vec] = [C[0], C[1]];
  for (const s of [0, 1] as SideN[]) {
    let best = -Infinity;
    for (const u of act[s]) {
      if (dist(u, C[s]) > 1600) continue;
      const p = (u.x - C[s].x) * dir[s].x + (u.y - C[s].y) * dir[s].y;
      if (p > best) best = p;
    }
    if (best > -Infinity) front[s] = { x: C[s].x + dir[s].x * best, y: C[s].y + dir[s].y * best };
  }
  const focus = new Map<number, number>();
  for (const l of side) for (const u of l) {
    const t = M.u[u.i].target;
    if (t >= 0) focus.set(t, (focus.get(t) ?? 0) + 1);
  }
  const here = (l: Unit[], c: Vec) => l.filter((u) => dist(u, c) < 1500);
  return { C, dir, front, carry: [pickCarry(M, here(act[0], C[0])), pickCarry(M, here(act[1], C[1]))], focus };
}

function runFight(e: Engine, M: Mod, id: number, f: { x: number; y: number; start: number; last: number; trade?: boolean; origin?: string; size?: number }) {
  M.cur = id;
  let info = M.f.get(id);
  if (!info) {
    // fights opened by engine.laneDuels() (lane all-ins)
    const kind: FightKind = f.origin === "allin" ? "allin" : f.trade ? "trade" : "skirmish";
    info = newInfo(e, id, f.origin ?? "?", kind, 0);
    M.f.set(id, info);
    M.stats.fights++;
    if (kind === "allin") M.stats.allins++;
    for (const u of e.units) if (u.fightId === id) {
      info.members.add(u.i);
      // these units joined through engine.joinFight, not join(): clear what an earlier fight left behind
      // (a laner who died while running away would otherwise start the all-in still marked as fleeing)
      const s = M.u[u.i];
      s.bail = false;
      s.target = -1;
      s.joinAt = e.t;
      s.pathTo = null;
    }
    info.brawlAt = e.t;
    log(e, M, `FIGHT #${id} ${info.origin} (lane all-in): ${[...info.members].map((i) => nm(e.units[i])).join(", ")}`);
  }
  const members = e.units.filter((x) => x.fightId === id && x.alive);
  const side: [Unit[], Unit[]] = [members.filter((m) => m.side === 0), members.filter((m) => m.side === 1)];
  if (members.length) {
    f.x = members.reduce((a, m) => a + m.x, 0) / members.length;
    f.y = members.reduce((a, m) => a + m.y, 0) / members.length;
  }
  const age = e.t - f.start;
  if (!side[0].length || !side[1].length) return end(e, M, id, info, side[0].length || side[1].length ? "one side left" : "empty");
  if (info.kind === "trade" && !info.extended && Math.min(...members.map(hpF)) < 0.35) {
    info.extended = true;
    info.maxLen += 4;
  }
  if (age > info.maxLen) return end(e, M, id, info, info.kind === "skirmish" ? "time cap" : "timer");
  const quiet = e.t - Math.max(f.last, f.start);
  if (info.kind === "skirmish" && quiet > (info.brawlAt < 0 ? 12 : 6)) return end(e, M, id, info, "no contact");

  let geo = geometry(e, M, f, side);
  // the fight's spot (renderer marker, join distances): between the two groups actually fighting, not pulled toward
  // allies still walking up
  f.x = (geo.C[0].x + geo.C[1].x) / 2;
  f.y = (geo.C[0].y + geo.C[1].y) / 2;
  if (e.t >= info.next) {
    info.next = e.t + 0.5;
    think(e, M, info, f, side, geo);
  }
  if (info.kind === "skirmish" && e.t >= info.nextCall) {
    info.nextCall = e.t + 1;
    if (age < 14) callAllies(e, M, info, f, false);
  }
  // contact: once the two fronts touch, nobody is positioning any more
  if (info.phase[0] !== "brawl" || info.phase[1] !== "brawl") {
    let close = Infinity;
    for (const a of side[0]) for (const b of side[1]) if (!M.u[a.i].bail && !M.u[b.i].bail) close = Math.min(close, dist(a, b));
    const engaging = info.phase[0] === "engage" || info.phase[1] === "engage";
    if (close < (engaging ? 180 : 320)) toBrawl(e, M, info, "contact");
  }
  for (const u of members) act(e, M, u, info, side, geo);
  // runners who got away leave the fight
  for (const u of members) {
    const s = M.u[u.i];
    if (!u.alive || !s.bail) continue;
    let near = Infinity;
    for (const o of side[1 - u.side]) if (o.alive && !M.u[o.i].bail) near = Math.min(near, dist(o, u));
    const home = e.nearestOwnTurret(u)!;
    // a lane fight cannot be joined, so once nobody chases its runner any more it is over for the runner too (else the
    // winner stood idle until the runner was 1,350 u away)
    const unchased = info.kind !== "skirmish" && e.t - s.bailAt >= 0.5 &&
      !side[1 - u.side].some((o) => o.alive && !M.u[o.i].bail && M.u[o.i].target === u.i);
    if (unchased || near > 1350 || (dist(u, home) < 500 && near > 700) || e.t - s.bailAt > 12) {
      dropOut(e, M, u);
      setCalm(u, e.t + 5);
      e.setGoal(u, home);
      log(e, M, `  ← ${nm(u)} got away (${Math.round(hpF(u) * 100)}% hp)`);
    }
  }
  // spacing sample for 6+ member fights
  if (e.t >= info.nextSample) {
    info.nextSample = e.t + 1;
    if (info.members.size >= 6 && info.phase[0] === "brawl" && info.phase[1] === "brawl" && side[0].length >= 3 && side[1].length >= 3) {
      geo = geometry(e, M, f, side);
      sampleSpacing(e, M, side, geo);
    }
  }
}

function sampleSpacing(e: Engine, M: Mod, side: [Unit[], Unit[]], geo: Geo) {
  const st = M.stats;
  for (const s of [0, 1] as SideN[]) {
    const l = side[s].filter((u) => !M.u[u.i].bail);
    const ds: number[] = [];
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) ds.push(dist(l[i], l[j]));
    if (ds.length) st.spaceMates.push(ds.sort((a, b) => a - b)[Math.floor(ds.length / 2)]);
    const fronts = l.filter((u) => M.u[u.i].role === "frontline" || M.u[u.i].role === "skirmisher" || M.u[u.i].role === "diver");
    for (const u of l) {
      const us = M.u[u.i];
      if (!us.melee && us.target >= 0 && e.units[us.target].alive) st.spaceRangedToTarget.push(dist(u, e.units[us.target]));
      if ((us.role === "backline" || us.role === "artillery") && fronts.length) st.spaceBackToFront.push(Math.min(...fronts.map((x) => dist(x, u))));
      if (us.role === "enchanter" && geo.carry[s] && geo.carry[s] !== u) st.spaceEnchToCarry.push(dist(u, geo.carry[s]!));
    }
  }
}

function setPhase(e: Engine, M: Mod, info: FInfo, s: SideN, ph: Phase) {
  if (info.phase[s] === ph) return;
  info.phase[s] = ph;
  info.phaseAt[s] = e.t;
  log(e, M, `  #${info.id} ${s ? "RED" : "BLUE"} → ${ph}`);
}

function toBrawl(e: Engine, M: Mod, info: FInfo, why: string) {
  for (const s of [0, 1] as SideN[]) if (info.phase[s] === "position" || info.phase[s] === "engage") setPhase(e, M, info, s, "brawl");
  if (info.brawlAt < 0) info.brawlAt = e.t;
  if (!info.opened) info.opened = why;
}

function sideRetreat(e: Engine, M: Mod, info: FInfo, s: SideN, why: string) {
  setPhase(e, M, info, s, "retreat");
  M.stats.retreats++;
  const o = (1 - s) as SideN;
  let stay = 0;
  for (const u of e.units) {
    if (u.fightId !== info.id || u.side !== s || !u.alive) continue;
    const us = M.u[u.i];
    if (us.bail) continue;
    // someone with a kill right in front of them takes it before leaving
    const prey = e.units.some((x) => x.alive && x.side === o && x.fightId === info.id && !M.u[x.i].bail && hpF(x) < 0.35 && dist(x, u) < us.range + 250);
    if (prey && hpF(u) > 0.3) {
      us.commitUntil = e.t + 2.5;
      stay++;
      continue;
    }
    us.bail = true;
    us.bailAt = e.t;
  }
  if (info.phase[o] === "position" || info.phase[o] === "engage") setPhase(e, M, info, o, "brawl");
  log(e, M, `  #${info.id} ${s ? "RED" : "BLUE"} disengages (${why})${stay ? `, ${stay} stay for a kill` : ""}`);
}

/** Team decisions twice a second: when to engage, when to pull out. */
function think(e: Engine, M: Mod, info: FInfo, f: Vec, side: [Unit[], Unit[]], geo: Geo) {
  if (info.kind !== "skirmish") {
    // lane trades / all-ins: the side that is clearly losing backs off
    lanePullOut(e, M, info, side);
    return;
  }
  const pw = [0, 0], n = [0, 0], gathered = [0, 0];
  // who is actually in it (within 1,800 u of a non-running enemy): retreat calls count these, not the ones still walking up
  const pwNear = [0, 0], nNear = [0, 0];
  for (const s of [0, 1] as SideN[]) for (const u of side[s]) {
    if (M.u[u.i].bail) continue;
    const p = e.power(u);
    pw[s] += p;
    n[s]++;
    if (dist(u, geo.C[s]) < 1200) gathered[s]++;
    if (side[1 - s].some((o) => !M.u[o.i].bail && dist(o, u) <= 1800)) {
      pwNear[s] += p;
      nNear[s]++;
    }
  }
  const late = e.minute() > 24;
  for (const s of [0, 1] as SideN[]) {
    const o = (1 - s) as SideN;
    const ph = info.phase[s];
    if (ph === "retreat" || n[s] === 0) continue;
    const ratio = pw[s] / Math.max(1, pw[o]);
    const tp = e.t - info.phaseAt[s];
    if (ph === "position") {
      const g = gathered[s] / n[s];
      const plan = bestEngage(e, M, s, side[s], side[o]);
      const want = engageThreshold(e, info, s, side[s]);
      if (ratio < 0.62 && tp > 1) { sideRetreat(e, M, info, s, `outmatched ${ratio.toFixed(2)}`); continue; }
      // hold the formation a moment (poke, wait for the rest) unless the enemy is already beaten
      const ready = (g >= 0.75 && tp >= info.hold[s]) || tp > 5 || (ratio > 1.6 && tp >= 1);
      const need = want - (plan ? 0.08 : 0) - Math.min(0.15, tp * 0.015);
      if ((ready && ratio >= need) || (tp > 10 && ratio >= 0.85)) {
        info.plan[s] = plan;
        if (plan) {
          setPhase(e, M, info, s, "engage");
          const pu = e.units[plan.u];
          log(e, M, `  #${info.id} ${s ? "RED" : "BLUE"} engage plan: ${nm(pu)} ${pu.champ.spells[plan.k].key} ${pu.champ.spells[plan.k].name} on ${nm(e.units[plan.aim])} (${plan.count} in reach), ratio ${ratio.toFixed(2)}`);
        } else {
          setPhase(e, M, info, s, "brawl");
          log(e, M, `  #${info.id} ${s ? "RED" : "BLUE"} walks in (no engage tool), ratio ${ratio.toFixed(2)}`);
          if (info.phase[o] !== "retreat") toBrawl(e, M, info, "walk-in");
        }
      } else if (tp > 10) sideRetreat(e, M, info, s, "standoff");
    } else if (ph === "engage") {
      const plan = info.plan[s];
      const pu = plan ? e.units[plan.u] : null;
      if (!plan || !pu || !pu.alive || pu.fightId !== info.id || e.t < pu.cds[plan.k] || tp > 4) {
        // engager gone, spell already used, or it took too long: everyone goes
        setPhase(e, M, info, s, "brawl");
        if (info.phase[o] !== "retreat") toBrawl(e, M, info, "walk-in");
      } else if (!e.units[plan.aim].alive || e.units[plan.aim].fightId !== info.id) {
        info.plan[s] = bestEngage(e, M, s, side[s], side[o]);
      }
    } else if (ph === "brawl") {
      // once committed, a team fights it out a little before calling it
      const thr = (late ? 0.58 : 0.68) + (info.members.size >= 8 ? FIGHT_TUNE.bigRetreat : 0);
      const near = pwNear[s] / Math.max(1, pwNear[o]);
      const outnumbered = nNear[s] + 2 <= nNear[o] && near < 0.9;
      if (info.brawlAt >= 0 && e.t - info.brawlAt > 3 && nNear[s] > 0 && ((near < thr && e.rng.chance(late ? 0.3 : 0.4)) || outnumbered)) {
        sideRetreat(e, M, info, s, `losing ${near.toFixed(2)} (${nNear[s]}v${nNear[o]})`);
      } else if (nNear[s] === 0 && pwNear[o] > 0 && pw[s] < pwNear[o] * 0.8 && info.brawlAt >= 0 && e.t - info.brawlAt > 1) {
        // the ones in front are gone: the rest do not walk into it one by one
        sideRetreat(e, M, info, s, `too late to help (${n[s]} arriving vs ${nNear[o]})`);
      }
    }
  }
  if (info.phase[0] === "retreat" && info.phase[1] === "retreat" && info.brawlAt < 0) M.stats.ends.standoff = (M.stats.ends.standoff ?? 0);
}

/** a lane loser below this hp fraction retreats inside the fight (chaseable); healthier ones just walk off */
const LANE_CHASE_HP = 0.45;

function lanePullOut(e: Engine, M: Mod, info: FInfo, side: [Unit[], Unit[]]) {
  const age = e.t - (e.fights.get(info.id)?.start ?? e.t);
  if (age < 2) return;
  const pw = [0, 0];
  for (const s of [0, 1]) for (const u of side[s]) pw[s] += e.power(u);
  for (const s of [0, 1] as SideN[]) {
    if (info.phase[s] === "retreat") continue;
    if (pw[s] < pw[1 - s] * (e.minute() > 24 ? 0.7 : 0.85) && e.rng.chance(0.45)) {
      log(e, M, `  #${info.id} ${s ? "RED" : "BLUE"} backs off (lost the trade)`);
      M.stats.retreats++;
      setPhase(e, M, info, s, "retreat");
      for (const u of side[s]) {
        if (hpF(u) < 0.25 && e.tryFlash(u)) M.stats.flashes++;
        if (hpF(u) < LANE_CHASE_HP) {
          // low: runs home inside the fight, where the winner may chase it (see act / chaseOk); one already running
          // keeps its start time (the chase window and the 12 s cap count from it)
          const us = M.u[u.i];
          if (!us.bail) { us.bail = true; us.bailAt = e.t; }
          continue;
        }
        dropOut(e, M, u);
        setCalm(u, e.t + 5);
        e.setGoal(u, e.nearestOwnTurret(u)!);
      }
      return;
    }
  }
}

function engageThreshold(e: Engine, info: FInfo, s: SideN, mine: Unit[]): number {
  let w = 1.02;
  const tac = e.tactic[s];
  if (tac === "aggressive") w -= 0.08;
  else if (tac === "safe") w += 0.1;
  if (info.initiator === s) w -= 0.08;
  let eng = 0, hold = 0;
  for (const u of mine) {
    const st = stanceOf(e, u);
    if (st === "engage") eng++;
    else if (st === "hold" || st === "avoid") hold++;
  }
  if (eng * 2 > mine.length) w -= 0.1;
  if (hold * 2 > mine.length) w += 0.1;
  if (!ENGINE_FLAGS.macro) {
    const strat = e.strategy[s];
    if (strat === "teamfight") w -= 0.05;
    else if (strat === "scaling" && e.minute() < 25) w += 0.08;
    else if (strat === "early" && e.minute() < 15) w -= 0.05;
  }
  return w;
}

/** The best way this side can open: who, with which spell, on whom, hitting how many. */
function bestEngage(e: Engine, M: Mod, s: SideN, mine: Unit[], foes: Unit[]): EngagePlan | null {
  let best: EngagePlan | null = null, bv = 0;
  const live = foes.filter((x) => x.alive && !M.u[x.i].bail);
  if (!live.length) return null;
  for (const u of mine) {
    const us = M.u[u.i];
    if (us.bail || !u.alive || e.t < us.silenceUntil) continue;
    for (let k = 0; k < 4; k++) {
      const sk = us.kit.spells[k];
      if (!sk || !us.uses[k].includes("engage") || e.t < u.cds[k] || !u.champ.spells[k]) continue;
      const reach = reachOf(us, sk);
      const rad = areaRadius(sk);
      for (const aim of live) {
        if (!targetable(e, M, aim, u)) continue;
        const count = rad > 0 ? live.filter((x) => dist(x, aim) <= rad).length : 1;
        const need = sk.minTargets ? Math.min(sk.minTargets, live.length) : 1;
        if (count < need) continue;
        const d = dist(u, aim);
        const v = count + (sk.cc && HARD.has(sk.cc.type) ? 1 : 0) + (SQUISHY.has(M.u[aim.i].role) ? 0.5 : 0) - Math.max(0, d - reach) / 1500 + (k === 3 ? 0.3 : 0);
        if (v > bv) { bv = v; best = { u: u.i, k, aim: aim.i, count }; }
      }
    }
  }
  return best;
}

function end(e: Engine, M: Mod, id: number, info: FInfo, why: string) {
  const f = e.fights.get(id);
  const n = info.members.size;
  const st = M.stats;
  st.ends[why] = (st.ends[why] ?? 0) + 1;
  st.sizes.push(n);
  if (f) st.durations.push(e.t - f.start);
  if (info.kind === "skirmish") {
    const key = info.opened ?? (info.firstDmg >= 0 ? "poke only" : "no fight");
    if (n >= 6) {
      st.teamfights++;
      st.opened[key] = (st.opened[key] ?? 0) + 1;
      if (f && info.brawlAt >= 0) st.posTime.push(info.brawlAt - f.start);
    } else st.openedSmall[key] = (st.openedSmall[key] ?? 0) + 1;
  }
  for (const u of e.units) {
    if (u.fightId !== id) continue;
    const s = M.u[u.i];
    if (s.bail) setCalm(u, e.t + 5);
    else if (why === "no contact" || why === "time cap") setCalm(u, e.t + 4);
    s.bail = false;
    s.target = -1;
  }
  log(e, M, `END #${id} (${why}) after ${f ? (e.t - f.start).toFixed(1) : "?"}s, ${n} took part, opened by: ${info.opened ?? "-"}`);
  e.endFight(id);
  M.f.delete(id);
}

// ---------------------------------------------------------------- per unit

function act(e: Engine, M: Mod, u: Unit, info: FInfo, side: [Unit[], Unit[]], geo: Geo) {
  if (!u.alive || u.fightId !== info.id) return;
  const s = M.u[u.i];
  if (e.t < u.stunUntil) return;
  const foes = side[1 - u.side].filter((x) => x.alive && x.fightId === info.id);
  const allies = side[u.side].filter((x) => x.alive && x.fightId === info.id);
  if (!foes.length) return;
  const ph = info.phase[u.side];
  if (!s.bail && ph !== "retreat" && shouldBail(e, M, u, info, foes, allies, geo)) {
    log(e, M, `  ↩ ${nm(u)} bails at ${Math.round(hpF(u) * 100)}% hp`);
    // lane fights too: the runner stays in the fight while it runs, so the winner can chase it down (chaseOk: not
    // deep under its turret, not for long). Before, a lane loser left the fight on the spot and real-stat damage
    // (much less burst than the old % model) almost never killed in lane: 2 % of lane all-ins ended in a kill.
    if (info.kind !== "skirmish" && hpF(u) < 0.2 && e.tryFlash(u)) M.stats.flashes++;
    s.bail = true;
    s.bailAt = e.t;
  }
  if (ph === "retreat" && !s.bail && e.t >= s.commitUntil) {
    s.bail = true;
    s.bailAt = e.t;
  }
  if (s.bail) return retreatAct(e, M, u, info, foes, allies, geo);
  const target = pickTarget(e, M, u, info, foes, allies, geo);
  s.target = target ? target.i : -1;
  if (ph === "position") return positionAct(e, M, u, info, foes, allies, geo, target);
  if (ph === "engage") {
    const plan = info.plan[u.side];
    if (plan && plan.u === u.i) return engagerAct(e, M, u, info, foes, allies, geo, plan);
    return positionAct(e, M, u, info, foes, allies, geo, target, 0.55);
  }
  brawlAct(e, M, u, info, foes, allies, geo, target);
}

function shouldBail(e: Engine, M: Mod, u: Unit, info: FInfo, foes: Unit[], allies: Unit[], geo: Geo): boolean {
  const f = hpF(u);
  if (f > 0.3) return false;
  const threats = foes.filter((x) => !M.u[x.i].bail && (M.u[x.i].target === u.i || dist(x, u) < 500));
  if (!threats.length) return false;
  const myAvg = allies.reduce((a, x) => a + hpF(x), 0) / Math.max(1, allies.length);
  const foeAvg = foes.reduce((a, x) => a + hpF(x), 0) / Math.max(1, foes.length);
  const losing = foes.length > allies.length || myAvg < foeAvg - 0.1;
  const focused = threats.length >= 2;
  // a winning team does not peel off at the first scratch: only when focused and nearly dead
  if (!losing && !(focused && f < 0.18)) return false;
  // a carry with a healthy enchanter next to it keeps fighting a little longer
  void geo;
  return e.rng.chance(info.kind === "skirmish" ? 0.4 : 0.35);
}

/** Where the unit's fight role wants it to stand while the teams size each other up. */
function slotPoint(M: Mod, u: Unit, info: FInfo, geo: Geo, adv: number): Vec {
  const s = u.side, o = (1 - s) as SideN;
  const us = M.u[u.i];
  const d = geo.dir[s];
  const perp = { x: -d.y, y: d.x };
  const Fo = geo.front[o];
  const carry = geo.carry[s];
  let along = 600, lat = 0;
  switch (us.role) {
    case "frontline": along = 520; lat = us.lat * 140; break;
    case "skirmisher": along = 620; lat = us.lat * 260; break;
    case "diver": along = 720; lat = us.lat * 620; break;
    case "assassin": along = 880; lat = us.lat * 780; break;
    case "backline": along = Math.max(us.range + 230, 700); lat = us.lat * 220; break;
    case "artillery": along = Math.max(us.poke - 60, 850); lat = us.lat * 260; break;
    case "enchanter":
      if (carry && carry !== u) return { x: carry.x - d.x * 170 + perp.x * us.lat * 160, y: carry.y - d.y * 170 + perp.y * us.lat * 160 };
      along = Math.max(us.range + 200, 700); lat = us.lat * 200; break;
  }
  along *= adv;
  void info;
  return { x: Fo.x - d.x * along + perp.x * lat, y: Fo.y - d.y * along + perp.y * lat };
}

function positionAct(e: Engine, M: Mod, u: Unit, info: FInfo, foes: Unit[], allies: Unit[], geo: Geo, target: Unit | null, adv = 1) {
  const us = M.u[u.i];
  const slot = slotPoint(M, u, info, geo, adv);
  // poke while holding formation
  const c = chooseSpell(e, M, u, info, foes, allies, geo, target, "position");
  if (c) cast(e, M, u, info, c, foes, allies, geo);
  if (dist(u, slot) > 70) moveTo(e, M, u, slot);
  if (target && dist(u, target) <= us.range + 30) basicAttack(e, M, u, target, info, 1);
}

/** how far outside its engage spell's reach an engager may be to flash in (Flash covers 420) */
const FLASH_ENGAGE_GAP = 380;

function engagerAct(e: Engine, M: Mod, u: Unit, info: FInfo, foes: Unit[], allies: Unit[], geo: Geo, plan: EngagePlan) {
  const us = M.u[u.i];
  const aim = e.units[plan.aim];
  const sk = us.kit.spells[plan.k];
  if (!aim.alive || !sk || e.t < u.cds[plan.k]) return brawlAct(e, M, u, info, foes, allies, geo, aim);
  const reach = reachOf(us, sk);
  if (dist(u, aim) > reach) {
    // a Flash away from an engage that catches two or more: flash in and cast (one target is not worth the spell;
    // Flash was only ever used to run away)
    const gap = dist(u, aim) - reach;
    // (not while grounded: no blinks then)
    if (!(plan.count >= 2 && gap <= FLASH_ENGAGE_GAP && hpF(u) > 0.45 && e.t >= us.groundUntil && e.flashToward(u, aim, "engage", Math.max(0, reach - 40)))) {
      moveTo(e, M, u, aim);
      return;
    }
    M.stats.flashes++;
    us.pathTo = null;
    log(e, M, `  ⚡ ${nm(u)} flashes in to engage on ${nm(aim)}`);
  }
  const c: Choice = { k: plan.k, aim, ally: null, score: 9, why: "engage" };
  if (!cast(e, M, u, info, c, foes, allies, geo)) {
    // blocked (e.g. a wall in the way of the dash): walk in instead
    moveTo(e, M, u, aim);
  }
}

function retreatPoint(e: Engine, u: Unit, foes: Unit[]): Vec {
  const home = e.nearestOwnTurret(u) ?? FOUNTAIN[u.side];
  const act = foes.filter((x) => x.alive);
  if (!act.length) return home;
  const fc = { x: act.reduce((a, x) => a + x.x, 0) / act.length, y: act.reduce((a, x) => a + x.y, 0) / act.length };
  // the turret is past the enemies: run to the fountain side instead
  if (dist(fc, home) < dist(u, home) && dist(fc, u) < dist(u, home)) return FOUNTAIN[u.side];
  return home;
}

function retreatAct(e: Engine, M: Mod, u: Unit, info: FInfo, foes: Unit[], allies: Unit[], geo: Geo) {
  const us = M.u[u.i];
  const chasers = foes.filter((x) => !M.u[x.i].bail);
  let near: Unit | null = null, nd = Infinity;
  for (const x of chasers) {
    const d = dist(x, u);
    if (d < nd) { nd = d; near = x; }
  }
  const home = retreatPoint(e, u, chasers);
  if (near && nd < 520) {
    // about to die: flash
    const threat = chasers.filter((x) => dist(x, u) < 700).reduce((a, x) => a + e.aaDps(x) * 2 + spellDamage(e, M, x, 0), 0);
    if (hpF(u) < 0.25 && u.hp < threat && e.tryFlash(u)) {
      M.stats.flashes++;
      us.pathTo = null;
      log(e, M, `  ⚡ ${nm(u)} flashes away (${Math.round(hpF(u) * 100)}% hp)`);
    } else {
      const c = chooseSpell(e, M, u, info, foes, allies, geo, near, "retreat");
      if (c) cast(e, M, u, info, c, foes, allies, geo);
    }
  }
  moveTo(e, M, u, home);
  // ranged runners still shoot whoever is right on them
  if (near && !us.melee && nd <= us.range) basicAttack(e, M, u, near, info, 0.5);
}

function chaseOk(e: Engine, M: Mod, u: Unit, t: Unit): boolean {
  const ts = M.u[t.i];
  if (!ts.bail) return true;
  if (hpF(u) < 0.3 || e.t - ts.bailAt > 6) return false;
  const d = dist(u, t);
  if (d > (M.u[u.i].melee ? 1000 : M.u[u.i].range + 450)) return false;
  for (const tw of e.turrets) {
    if (!tw.alive || tw.side !== t.side || dist(tw.pos, t) > 850) continue;
    return hpF(t) < 0.18 && hpF(u) > 0.55 && e.minute() > 3;
  }
  return true;
}

function pickTarget(e: Engine, M: Mod, u: Unit, info: FInfo, foes: Unit[], allies: Unit[], geo: Geo): Unit | null {
  const us = M.u[u.i];
  const carry = geo.carry[u.side];
  let best: Unit | null = null, bv = -Infinity;
  for (const f of foes) {
    if (!targetable(e, M, f, u)) continue;
    const fs = M.u[f.i];
    const d = dist(u, f);
    if (d > 2200) continue;
    if (fs.bail && !chaseOk(e, M, u, f)) continue;
    const inRange = d <= us.range + 60;
    let v = 0;
    const gap = Math.max(0, d - us.range);
    v -= gap / (DIVE.has(us.role) ? 900 : 420);
    v += (1 - hpF(f)) * 1.2;
    if (e.t < f.stunUntil) v += 1;
    else if (e.t < fs.rootUntil || e.t < fs.slowUntil) v += 0.4;
    // focus fire: pile onto whoever the team is already hitting, and onto the engage target
    v += Math.min(3, geo.focus.get(f.i) ?? 0) * 0.5;
    const plan = info.plan[u.side];
    if (plan && plan.aim === f.i && info.brawlAt >= 0 && e.t - info.brawlAt < 4) v += 0.8;
    if (carry && carry !== u && M.u[carry.i].target === f.i && (us.role === "enchanter" || us.role === "frontline")) v += 0.7;
    switch (us.role) {
      case "backline":
      case "artillery":
        if (inRange) v += 1;
        if (fs.target === u.i) v += 0.8;
        if (DIVE.has(fs.role) && d < 650) v += 0.8;
        break;
      case "diver":
      case "assassin":
        if (SQUISHY.has(fs.role)) v += 1.5;
        if (f.role === "Bot" || f.role === "Mid") v += 0.5;
        if (fs.role === "frontline") v -= 0.6;
        break;
      case "frontline":
        if (carry && dist(f, carry) < 600) v += 1.6;
        if (d < 500) v += 0.6;
        break;
      case "skirmisher":
        if (SQUISHY.has(fs.role)) v += 0.6;
        v += (1 - hpF(f)) * 0.6;
        break;
      case "enchanter":
        if (carry && dist(f, carry) < 650) v += 1.2;
        if (inRange) v += 0.5;
        break;
    }
    if (fs.bail) v -= 0.4;
    if (us.target === f.i) v += 0.5;
    if (v > bv) { bv = v; best = f; }
  }
  return best;
}

function brawlAct(e: Engine, M: Mod, u: Unit, info: FInfo, foes: Unit[], allies: Unit[], geo: Geo, target: Unit | null) {
  const us = M.u[u.i];
  if (!target) {
    // nobody worth chasing: regroup with the team
    const back = geo.C[u.side];
    if (dist(u, back) > 300) moveTo(e, M, u, back);
    return;
  }
  const c = chooseSpell(e, M, u, info, foes, allies, geo, target, "brawl");
  if (c) cast(e, M, u, info, c, foes, allies, geo);
  if (!u.alive || e.t < u.stunUntil) return;
  const d = dist(u, target);
  let aaMul = 1;
  const carry = geo.carry[u.side];
  if (us.melee) {
    if (d > us.range) {
      if (DIVE.has(us.role) && d > 700) {
        // flank: come in at an angle instead of through the enemy front
        const dd = geo.dir[u.side];
        const perp = { x: -dd.y, y: dd.x };
        moveTo(e, M, u, { x: target.x + perp.x * us.lat * Math.min(420, d * 0.35), y: target.y + perp.y * us.lat * Math.min(420, d * 0.35) });
      } else moveTo(e, M, u, target);
    }
  } else if (us.role === "enchanter" && carry && carry !== u) {
    const dd = geo.dir[u.side];
    const perp = { x: -dd.y, y: dd.x };
    const spot = { x: carry.x - dd.x * 150 + perp.x * us.lat * 120, y: carry.y - dd.y * 150 + perp.y * us.lat * 120 };
    const threat = nearestThreat(M, u, foes);
    if (threat && dist(threat, u) < 260) {
      kite(e, M, u, threat, geo);
      aaMul = 0.85;
    } else if (dist(u, spot) > 60) moveTo(e, M, u, spot);
  } else {
    const threat = nearestThreat(M, u, foes);
    if (threat && dist(threat, u) < Math.max(260, us.range * 0.55)) {
      kite(e, M, u, threat, geo);
      aaMul = 0.85;
    } else if (d > us.range) {
      // close to attack range, no further
      const k = (us.range * 0.92) / d;
      moveTo(e, M, u, { x: target.x + (u.x - target.x) * k, y: target.y + (u.y - target.y) * k });
    } else if (d < us.range * 0.6 && M.u[target.i].melee) {
      kite(e, M, u, target, geo);
      aaMul = 0.85;
    }
  }
  if (dist(u, target) <= us.range + 30) basicAttack(e, M, u, target, info, aaMul);
}

function nearestThreat(M: Mod, u: Unit, foes: Unit[]): Unit | null {
  let best: Unit | null = null, bd = Infinity;
  for (const f of foes) {
    const fs = M.u[f.i];
    if (!fs.melee || fs.bail) continue;
    const d = dist(f, u);
    if (d < bd && (fs.target === u.i || d < 330)) { bd = d; best = f; }
  }
  return best;
}

/** Step away from `from` (and a little back toward the own side) while still attacking. */
function kite(e: Engine, M: Mod, u: Unit, from: Unit, geo: Geo) {
  const away = norm(u.x - from.x, u.y - from.y);
  const back = geo.dir[u.side];
  const dir = norm(away.x - back.x * 0.6, away.y - back.y * 0.6);
  moveTo(e, M, u, { x: u.x + dir.x * 220, y: u.y + dir.y * 220 }, 0.6);
}

function basicAttack(e: Engine, M: Mod, u: Unit, t: Unit, info: FInfo, mul: number) {
  const us = M.u[u.i];
  if (e.t < us.blindUntil || !t.alive) return;
  let m = mul * us.aaMul * FIGHT_TUNE.aaMul;
  if (e.t < us.buffUntil && (us.buffKind === "as" || us.buffKind === "ad")) m *= 1.3;
  const real = e.realStats();
  const dmg = e.aaDps(u) * DT * e.rng.range(0.75, 1.25) * m * (real ? Stats.armorMul(e, u, t) : 1);
  hurt(e, M, u, t, dmg, "aa");
  // on-hit effects count the attacks landed this step (attack speed x step, fewer while kiting)
  if (real && t.alive) Procs.onAttack(e, u, t, Stats.stats(e, u).as * DT * mul * (e.t < us.buffUntil && us.buffKind === "as" ? 1.3 : 1), M.deal);
  if (!info.opened && info.phase[0] === "brawl" && info.phase[1] === "brawl") info.opened = "aa";
  if (!us.melee && e.rng.chance(0.35)) e.fx_({ kind: "aa", side: u.side, x: u.x, y: u.y, tx: t.x, ty: t.y, color: u.side ? "#ff8a8a" : "#8ab8ff", r: 0, w: 0, from: u.i, to: t.i });
}

// ---------------------------------------------------------------- spells

interface Choice {
  k: number;
  aim: Unit | null;
  ally: Unit | null;
  score: number;
  why: SpellUse | "save";
}

function reachOf(us: UState, sk: SpellKit): number {
  if (sk.uses.includes("global")) return 30000;
  if (sk.dash && sk.dash.to !== "ally") return sk.dash.len + Math.max(us.melee ? 150 : us.range * 0.7, sk.radius || 0);
  if (sk.target === "self") {
    const m = selfMode(us, sk);
    return m === "aura" ? Math.max(150, sk.radius) : m === "empower" ? us.range + 50 : m === "global" ? 3000 : us.range + 200;
  }
  if (sk.shape === "global") return Math.min(sk.range || 3000, 3000);
  let r = sk.range;
  if (!r || r > 3000) r = us.range + 150;
  return Math.min(r, 1600) + 40;
}

function areaRadius(sk: SpellKit): number {
  const r = Math.max(sk.radius || 0, (sk.width ?? 0) >= 200 ? (sk.width ?? 0) * 0.6 : 0);
  return r >= 120 ? r : 0;
}

/** Enemies the spell hits when aimed at `aim` (aim first). */
function victimsOf(u: Unit, sk: SpellKit, aim: Unit, foes: Unit[], us?: UState): Unit[] {
  const rad = areaRadius(sk);
  if (sk.target === "self" && us) {
    const m = selfMode(us, sk);
    if (m === "aura") return foes.filter((f) => dist(f, u) <= Math.max(150, sk.radius)).sort((a, b) => (a === aim ? -1 : b === aim ? 1 : 0));
    if (m === "buff") return [];
    if (m === "global") return [aim, ...foes.filter((f) => f !== aim && dist(f, u) <= 3000)];
    if (dist(u, aim) > us.range + 80) return [];
    return [aim, ...foes.filter((f) => f !== aim && sk.radius > 0 && dist(f, aim) <= sk.radius)];
  }
  if (sk.target === "self" && rad > 0) return foes.filter((f) => dist(f, u) <= rad).sort((a, b) => (a === aim ? -1 : b === aim ? 1 : 0));
  if (rad <= 0) return [aim];
  const list = foes.filter((f) => f !== aim && dist(f, aim) <= rad);
  return [aim, ...list];
}

function hitChance(e: Engine, M: Mod, u: Unit, sk: SpellKit, v: Unit, phase: Phase | "retreat"): number {
  const vs = M.u[v.i];
  if (!sk.skillshot) return 0.96;
  let p = 0.68 - (sk.delay || 0.25) * 0.35 + (u.rating - v.rating) / 140;
  const d = dist(u, v);
  p -= clamp((d - 450) / 2500, 0, 0.2);
  const rem = v.stunUntil - e.t;
  if (rem >= (sk.delay || 0.25)) p += 0.5;
  else if (rem > 0) p += 0.2;
  else if (e.t < vs.rootUntil) p += 0.45;
  else if (e.t < vs.slowUntil) p += 0.12;
  if (phase === "position") p -= 0.06; // standing apart, ready to sidestep
  if (vs.bail) p += 0.05; // running in a straight line
  return clamp(p, 0.12, 0.97);
}

function chooseSpell(e: Engine, M: Mod, u: Unit, info: FInfo, foes: Unit[], allies: Unit[], geo: Geo, target: Unit | null, mode: "position" | "brawl" | "retreat"): Choice | null {
  const us = M.u[u.i];
  if (e.t < us.lockUntil || e.t < us.silenceUntil) return null;
  let best: Choice | null = null;
  for (let k = 0; k < 4; k++) {
    const sk = us.kit.spells[k];
    if (!sk || !u.champ.spells[k] || e.t < u.cds[k]) continue;
    const c = evalSpell(e, M, u, info, k, sk, foes, allies, geo, target, mode);
    if (c && (!best || c.score > best.score)) best = c;
  }
  return best && best.score >= 1 ? best : null;
}

function evalSpell(e: Engine, M: Mod, u: Unit, info: FInfo, k: number, sk: SpellKit, foes: Unit[], allies: Unit[], geo: Geo, target: Unit | null, mode: "position" | "brawl" | "retreat"): Choice | null {
  const us = M.u[u.i];
  const reach = reachOf(us, sk);
  const carry = geo.carry[u.side];
  const brawlAge = info.brawlAt >= 0 ? e.t - info.brawlAt : 0;
  let best: Choice | null = null;
  const offer = (c: Choice) => {
    if (!best || c.score > best.score) best = c;
  };
  let live = foes.filter((f) => targetable(e, M, f, u));
  if (sk.requires === "airborne") {
    // e.g. Yasuo R: only onto someone already in the air
    live = live.filter((f) => e.t < M.u[f.i].airUntil);
    if (!live.length) return null;
    if (!target || !live.includes(target)) target = live[0];
  }
  const inReach = (f: Unit) => dist(u, f) <= reach;
  const isDash = !!sk.dash || sk.shape === "dash" || sk.shape === "blink";
  const blocked = isDash && (e.t < us.rootUntil || e.t < us.groundUntil);
  const dmg = sk.dmg > 0 ? spellDamage(e, M, u, k) : 0;
  const hard = !!sk.cc && HARD.has(sk.cc.type);
  // skillshot discipline: ultimates and hard CC wait for a decent chance to land (unless the fight drags on)
  const phase = info.phase[u.side];
  const picky = (k === 3 || hard) && brawlAge < 4;
  const worth = (f: Unit) => !sk.skillshot || hitChance(e, M, u, sk, f, phase) >= (picky ? 0.42 : mode === "position" ? 0.3 : 0.25);
  // ally saves: someone in range is about to die
  if (sk.save && mode !== "position") {
    const range = sk.target === "self" ? 0 : Math.min(sk.range > 3000 ? 1000 : sk.range || 800, 1400);
    for (const a of allies) {
      if (a !== u && dist(a, u) > range + 60) continue;
      if (a === u && sk.target !== "self" && !(sk.save.radius ?? 0)) continue;
      const as = M.u[a.i];
      if (e.t < as.invulnUntil || e.t < as.reviveUntil) continue;
      const threats = live.filter((f) => dist(f, a) < 800 && (M.u[f.i].target === a.i || dist(f, a) < 400)).length;
      if (!threats || hpF(a) > 0.25) continue;
      offer({ k, aim: null, ally: a, score: 4.5 + (a === carry ? 0.3 : 0) + threats * 0.1, why: "save" });
    }
  }
  // buffs that cover allies around the caster
  if (sk.allyBuff?.kind === "stasis" && mode !== "position") {
    // stasis on our own side (e.g. Bard R) only to save someone about to die
    const r = Math.max(250, sk.allyBuff.radius || 0);
    const range = Math.min(sk.range > 3000 ? 1200 : sk.range || 900, 1600);
    for (const a of allies) {
      if (dist(a, u) > range || hpF(a) > 0.22) continue;
      if (!live.some((f) => dist(f, a) < 600 && (M.u[f.i].target === a.i || dist(f, a) < 350))) continue;
      offer({ k, aim: null, ally: a, score: 3.5 + (a === carry ? 0.3 : 0), why: "buff" });
      void r;
    }
  } else if (sk.allyBuff && (sk.allyBuff.radius || 0) > 0 && mode !== "position") {
    const near = allies.filter((a) => dist(a, u) <= sk.allyBuff!.radius);
    const fighting = near.filter((a) => live.some((f) => dist(f, a) < 900)).length;
    if (mode === "retreat" && sk.allyBuff.kind === "ms" && near.length >= 2) offer({ k, aim: null, ally: u, score: 2.2 + near.length * 0.2, why: "buff" });
    else if (mode === "brawl" && fighting >= 2) offer({ k, aim: null, ally: u, score: 1.3 + fighting * 0.25, why: "buff" });
  }
  for (const use of us.uses[k]) {
    switch (use) {
      case "heal":
      case "shield":
      case "buff": {
        if (sk.target !== "ally" && sk.target !== "self") break;
        const range = sk.target === "self" ? 0 : Math.min(sk.range > 3000 ? 800 : sk.range || 700, 1300);
        const pool = sk.target === "self" ? [u] : allies.filter((a) => dist(a, u) <= range + 60);
        for (const a of pool) {
          const threatened = live.filter((f) => M.u[f.i].target === a.i && dist(f, a) < 900).length;
          let need: number;
          if (use === "heal") need = 1 - hpF(a) - 0.25 + threatened * 0.15 + (a === carry ? 0.1 : 0);
          else if (use === "shield") need = (1 - hpF(a)) * 0.8 + threatened * 0.3 + (a === carry ? 0.15 : 0) - 0.2;
          else need = mode === "brawl" && live.some((f) => dist(f, a) < M.u[a.i].range + 120) ? 0.4 + (a === carry ? 0.3 : 0) : 0;
          if (mode === "position") need -= 0.3;
          if (mode === "retreat" && use === "buff") need = 0;
          if (need <= 0.12) continue;
          offer({ k, aim: null, ally: a, score: 1 + need * 2.5, why: use });
        }
        break;
      }
      case "engage": {
        if (mode !== "brawl" || blocked) break;
        const need0 = sk.minTargets ? Math.min(sk.minTargets, live.length) : 1;
        const need = brawlAge > 10 ? Math.max(1, need0 - 1) : need0;
        const rad = areaRadius(sk);
        for (const f of live) {
          if (!inReach(f) || !worth(f)) continue;
          const count = rad > 0 ? live.filter((x) => dist(x, f) <= rad).length : 1;
          if (count < need) continue;
          const rem = f.stunUntil - e.t;
          if (hard && rem > (sk.delay || 0.25) + 0.2 && count === 1) continue;
          offer({ k, aim: f, ally: null, score: 2 + count * 0.6 + (hard ? 0.5 : 0) + (f === target ? 0.3 : 0), why: "engage" });
        }
        break;
      }
      case "cc":
      case "peel": {
        if (!sk.cc || (isDash && blocked)) break;
        if (mode === "position") break;
        if (sk.target === "ally") {
          // centred on an ally: knock away whoever is on it
          const rad = Math.max(areaRadius(sk), 250);
          const range = Math.min(sk.range > 3000 ? 900 : sk.range || 700, 1300);
          for (const a of allies) {
            if (dist(a, u) > range + 60) continue;
            const near = live.filter((f) => dist(f, a) <= rad);
            if (!near.length) continue;
            const onIt = near.filter((f) => M.u[f.i].target === a.i).length;
            if (!onIt && a !== carry) continue;
            offer({ k, aim: near[0], ally: a, score: 2.4 + near.length * 0.4 + onIt * 0.3 + (hpF(a) < 0.4 ? 0.6 : 0), why: "peel" });
          }
          break;
        }
        const need = k === 3 && sk.minTargets ? Math.min(sk.minTargets, live.length) : 1;
        const rad = areaRadius(sk);
        // peel: the enemy closest to our carry (or on us)
        const guard = mode === "retreat" ? u : carry ?? u;
        for (const f of live) {
          if (!inReach(f) || !worth(f)) continue;
          const rem = f.stunUntil - e.t;
          if (hard && rem > (sk.delay || 0.25) + 0.15) continue; // would overlap the CC already on it
          const count = rad > 0 ? live.filter((x) => dist(x, f) <= rad).length : 1;
          if (count < need) continue;
          let sc = 0;
          const onGuard = dist(f, guard) < 520 && (M.u[f.i].target === guard.i || DIVE.has(M.u[f.i].role) || dist(f, guard) < 300);
          if (use === "peel" || mode === "retreat") sc = onGuard ? 2.8 : 0;
          if (use === "cc" || sc === 0) sc = Math.max(sc, f === target ? 1.9 : 1.3);
          if (onGuard) sc += 0.6;
          if ((geo.focus.get(f.i) ?? 0) >= 2) sc += 0.4;
          if (rem > 0 && rem <= (sk.delay || 0.25) + 0.15) sc += 0.4; // chain onto a CC that is about to end
          if (sk.requires === "mark") sc += e.t - (M.u[f.i].marks.get(u.i) ?? -99) < 4 ? 0.5 : -0.8;
          sc += (count - 1) * 0.4;
          if (!hard) sc -= 0.4;
          offer({ k, aim: f, ally: null, score: sc, why: use === "peel" || onGuard ? "peel" : "cc" });
        }
        break;
      }
      case "execute": {
        if (mode !== "brawl" || dmg <= 0) break;
        for (const f of live) {
          if (!inReach(f) || (blocked && isDash)) continue;
          if (f.hp + f.shield <= spellDamage(e, M, u, k, f) * 1.05 || hpF(f) < 0.22) offer({ k, aim: f, ally: null, score: 3.4 + (f === target ? 0.2 : 0), why: "execute" });
        }
        break;
      }
      case "burst":
      case "dps":
      case "poke":
      case "waveclear": {
        if (dmg <= 0 || !target) break;
        if (mode === "retreat") break;
        if (isDash && (blocked || mode === "position")) break;
        if (mode === "position" && use !== "poke" && !(us.role === "artillery" && k !== 3 && reach >= 850)) break;
        const aim = target;
        if (sk.target === "self" && !victimsOf(u, sk, aim, live, us).length) break;
        if (!inReach(aim)) {
          // a damage spell that reaches someone else in range
          const alt = live.filter((f) => inReach(f) && worth(f)).sort((a, b) => hpF(a) - hpF(b))[0];
          if (alt && k !== 3) offer({ k, aim: alt, ally: null, score: 0.9 + (1 - hpF(alt)) * 0.4, why: use });
          break;
        }
        if (!worth(aim)) break;
        // keep ultimates for when they matter
        if (k === 3) {
          if (sk.minTargets && victimsOf(u, sk, aim, live, us).length < Math.min(sk.minTargets, live.length) && brawlAge < 10) break;
          if (hpF(aim) < 0.15 && !sk.uses.includes("execute")) break;
          if (aim.hp < e.aaDps(u) * 1.2) break;
        }
        const kills = aim.hp + aim.shield <= spellDamage(e, M, u, k, aim);
        let sc = use === "burst" ? 1.7 : use === "poke" ? (mode === "position" ? 1.6 : 1.2) : use === "waveclear" ? 0.9 : 1.3;
        if (kills) sc += 1.5;
        if (sk.cc && hard && aim.stunUntil - e.t > (sk.delay || 0.25) + 0.3) sc -= 0.3;
        const n = victimsOf(u, sk, aim, live, us).length;
        sc += (n - 1) * 0.3;
        offer({ k, aim, ally: null, score: sc, why: use });
        break;
      }
      case "zone": {
        if (mode === "retreat") {
          const chaser = live.filter(inReach).sort((a, b) => dist(a, u) - dist(b, u))[0];
          if (chaser && dist(chaser, u) < 500) offer({ k, aim: chaser, ally: null, score: 1.6, why: "zone" });
          break;
        }
        const rad = Math.max(areaRadius(sk), 250);
        for (const f of live) {
          if (!inReach(f)) continue;
          const count = live.filter((x) => dist(x, f) <= rad).length;
          if (count < 2 && !(f === target && mode === "brawl")) continue;
          offer({ k, aim: f, ally: null, score: (mode === "position" ? 1.1 : 1.4) + count * 0.3, why: "zone" });
        }
        break;
      }
      case "gapclose": {
        if (mode !== "brawl" || blocked || !target) break;
        const d = dist(u, target);
        if (d <= us.range + 120 || d > reach) break;
        if (hpF(u) < 0.35) break;
        if (!us.melee && hpF(target) > 0.25) break; // ranged carries do not dash into the enemy
        offer({ k, aim: target, ally: null, score: DIVE.has(us.role) ? 2.4 : 2, why: "gapclose" });
        break;
      }
      case "escape": {
        if (blocked || !isDash) break;
        const threat = live.filter((f) => dist(f, u) < 520).length;
        if (mode === "retreat" && threat) offer({ k, aim: null, ally: null, score: 3, why: "escape" });
        else if (mode === "brawl" && hpF(u) < 0.3 && threat >= 1) offer({ k, aim: null, ally: null, score: 2.6, why: "escape" });
        break;
      }
      case "summon":
      case "stealth": {
        if (mode === "position") break;
        if (use === "stealth" && mode === "retreat" && live.some((f) => dist(f, u) < 600)) offer({ k, aim: null, ally: u, score: 2.4, why: "stealth" });
        else if (mode === "brawl" && target && dist(u, target) < us.range + 250) offer({ k, aim: target, ally: null, score: 1.1, why: use });
        break;
      }
      case "global": {
        if (mode !== "brawl" || dmg <= 0) break;
        for (const f of live) {
          const n = victimsOf(u, sk, f, live, us).length;
          if (hpF(f) < 0.35 || n >= 2) offer({ k, aim: f, ally: null, score: hpF(f) < 0.35 ? 2.6 : 1.8 + n * 0.2, why: "global" });
        }
        break;
      }
    }
  }
  // a self buff with no listed use (e.g. "self" shape steroids): pop it when fighting
  if (!best && sk.target === "self" && sk.uses.length === 0 && mode === "brawl" && target && dist(u, target) < us.range + 200) {
    best = { k, aim: target, ally: null, score: 1.05, why: "buff" };
  }
  return best;
}

/** vfx kinds the renderer draws on the caster's own side: never aimed at an enemy (`to` = ally or caster) */
const FRIENDLY_FX = new Set<string>(["shield", "heal", "self", "stealth", "summon"]);

/** skillshots whose kit dash only happens when they land ("champion id:spell index", 0 = Q … 3 = R) */
const HOOK_DASH = new Set<string>(["Thresh:0", "Nautilus:0", "Leona:2", "Amumu:0", "LeeSin:0", "Vex:3"]);
/** seconds a landed hook flies before the caster follows it (the renderer draws the hook's flight in about 0.4 s) */
const HOOK_TRAVEL = 0.4;

/** Self-cast spells: an aura around the caster, an empowered attack on the current target, or a pure buff. */
function selfMode(us: UState, sk: SpellKit): "aura" | "empower" | "buff" | "global" {
  const rad = sk.radius || 0;
  if (sk.dmg <= 0 && !sk.cc) return "buff";
  if (sk.uses.includes("global") || sk.shape === "global") return "global";
  if (rad >= 150 && (us.melee || rad >= us.range * 0.8)) return "aura";
  return "empower";
}

/** The caster's own buff / shield / heal from a self spell. */
function selfEffects(e: Engine, M: Mod, u: Unit, sk: SpellKit, sp: SpellData, k: number): string {
  const us = M.u[u.i];
  const out: string[] = [];
  const b = sk.selfBuff;
  if (b) {
    us.buffUntil = e.t + b.dur;
    us.buffKind = b.kind;
    if (b.kind === "untargetable") us.untargetUntil = e.t + b.dur;
    if (b.kind === "dr") {
      const amt = u.maxHp * 0.12;
      u.shield += amt;
      us.shields.push({ amt, until: e.t + b.dur });
    }
    out.push(`buff ${b.kind} ${b.dur}s`);
  }
  const sup = sk.support ?? 0;
  if (sup > 0 && (us.uses[k].includes("shield") || us.uses[k].includes("heal"))) {
    const real = e.realStats();
    const raw = !real
      ? spellBase(e, u, sp) * sup * FIGHT_TUNE.supportMul
      : Stats.hasSupport(u, k) ? Stats.supportAmount(e, u, k) * FIGHT_TUNE.supportMul : legacySupport(e, u, sup);
    if (us.uses[k].includes("heal") && hpF(u) < 0.85) {
      const amount = real ? Procs.selfSupport(e, u, raw, false) : raw;
      const before = u.hp;
      u.hp = Math.min(u.maxHp, u.hp + amount);
      out.push(`heals self ${Math.round(u.hp - before)}`);
    } else {
      const amount = real ? Procs.selfSupport(e, u, raw, true) : raw;
      u.shield += amount;
      us.shields.push({ amt: amount, until: e.t + 2.5 });
      out.push(`shields self ${Math.round(amount)}`);
    }
  }
  return out.join(", ");
}

/** Shield / heal / buff an ally. */
function supportOn(e: Engine, M: Mod, u: Unit, sk: SpellKit, sp: SpellData, ally: Unit, why: SpellUse | "save"): string {
  let amount = spellBase(e, u, sp) * (sk.support ?? (sk.dmg || 1)) * FIGHT_TUNE.supportMul;
  if (e.realStats() && (why === "heal" || why === "shield" || (why === "peel" && (sk.support ?? 0) > 0))) {
    // the spell's real heal / shield (heal and shield power included), then support items and healing received
    const k = u.champ.spells.indexOf(sp);
    amount = k >= 0 && Stats.hasSupport(u, k) ? Stats.supportAmount(e, u, k) * FIGHT_TUNE.supportMul : legacySupport(e, u, sk.support ?? (sk.dmg || 1));
    amount = Procs.onSupport(e, u, ally, amount, M.deal, why !== "heal");
  }
  const as = M.u[ally.i];
  if (ally !== u) as.helpers.push({ i: u.i, until: e.t + 5 });
  if (why === "heal") {
    const before = ally.hp;
    ally.hp = Math.min(ally.maxHp, ally.hp + amount);
    return `heals ${Math.round(ally.hp - before)}`;
  }
  if (why === "shield" || (why === "peel" && (sk.support ?? 0) > 0)) {
    ally.shield += amount;
    as.shields.push({ amt: amount, until: e.t + 2.5 });
    return `shields ${Math.round(amount)}`;
  }
  if (why === "stealth") {
    as.buffUntil = e.t + (sk.selfBuff?.dur ?? 1.5);
    as.buffKind = "stealth";
    return "stealth";
  }
  const b = sk.selfBuff;
  as.buffUntil = e.t + (b?.dur ?? 3);
  as.buffKind = b?.kind ?? "as";
  if (b?.kind === "untargetable") as.untargetUntil = e.t + b.dur;
  if (b?.kind === "dr") {
    ally.shield += ally.maxHp * 0.12;
    as.shields.push({ amt: ally.maxHp * 0.12, until: e.t + b.dur });
  }
  return `buff ${as.buffKind}`;
}

interface HitResult { hit: Unit[]; hitMain: boolean; cc: string[]; dmg: number }

/** Roll each victim, then one "hit" fx, damage and CC per champion actually hit. */
function landHits(e: Engine, M: Mod, u: Unit, k: number, sk: SpellKit, sp: SpellData, victims: Unit[], aim: Unit | null, phase: Phase, at?: Vec): HitResult {
  const real = e.realStats();
  const dmg = spellDamage(e, M, u, k, real ? aim : null);
  const res: HitResult = { hit: [], hitMain: false, cc: [], dmg };
  const centre = at ?? aim ?? u;
  for (const v of victims) {
    if (!v.alive) continue;
    const p = hitChance(e, M, u, sk, v, phase) * (aim && v !== aim ? 0.8 : 1);
    if (!e.rng.chance(p)) continue;
    if (v === aim) res.hitMain = true;
    res.hit.push(v);
    e.hitFx(u, v, sp);
    // a spell shield (Banshee's Veil, Edge of Night) takes the whole spell: no damage, no crowd control
    if (real && Procs.spellShield(e, v)) continue;
    // real numbers: each victim's own resistances (and its health, for % health spells)
    const dv = real ? spellDamage(e, M, u, k, v) : dmg;
    // the main target takes the full hit; others caught in the area a little less (edges, partial overlap)
    if (dv > 0) hurt(e, M, u, v, dv * e.rng.range(0.85, 1.15) * (aim && v !== aim ? FIGHT_TUNE.aoeMul : 1), "spell");
    if (real && dv > 0 && v.alive) Procs.onSpellHit(e, u, v, k, M.deal);
    const vs = M.u[v.i];
    // conditional CC: only on a target already airborne / carrying this caster's mark
    const gated = sk.requires === "airborne" ? e.t >= vs.airUntil : sk.requires === "mark" ? !(e.t - (vs.marks.get(u.i) ?? -99) < 4) : false;
    if (sk.cc && v.alive && !gated) res.cc.push(applyCC(e, M, u, v, sk.cc, centre, sk.radius));
    vs.marks.set(u.i, e.t);
  }
  return res;
}

/** Stats, fight opening and the log line after an offensive cast. */
function afterCast(e: Engine, M: Mod, u: Unit, info: FInfo, c: Choice, k: number, sk: SpellKit, sp: SpellData, aimed: number, r: HitResult, phase: Phase, extra: string) {
  const st = M.stats;
  const hard = !!sk.cc && HARD.has(sk.cc.type);
  st.hits += r.hit.length;
  if (c.aim && !r.hitMain) st.misses++;
  if (k === 3) {
    st.ults++;
    if (aimed >= 2) st.ultAoe++;
    if (r.hit.length >= 2) st.ultMulti++;
  }
  if (!info.opened && r.hit.length && (phase === "brawl" || phase === "engage")) {
    info.opened = c.why === "engage" ? "engage" : hard ? "cc" : c.why === "gapclose" ? "gapclose" : "spell";
  }
  if (phase === "engage" || (c.why === "engage" && (info.phase[0] !== "brawl" || info.phase[1] !== "brawl"))) {
    if (!info.opened) info.opened = c.why === "engage" ? "engage" : "spell";
    toBrawl(e, M, info, info.opened);
  }
  if (M.log) {
    const us = M.u[u.i];
    const tgt = r.hit.length ? r.hit.map((v) => nm(v)).join(", ") : "nobody";
    const head = c.aim ? `→ ${nm(c.aim)}: ${r.hitMain ? "HIT" : "MISS"} ${tgt}` : `hits ${tgt}`;
    log(e, M, `  ${nm(u)} [${us.role}/${phase}] ${sp.key} ${sp.name} (${c.why}${k === 3 ? ", ULT" : ""}) ${head}${r.cc.length ? ` [${r.cc.join(", ")}]` : ""}${r.dmg > 0 && r.hit.length ? ` ~${Math.round(r.dmg)} dmg` : ""}${extra}`);
  }
}

/** Put the spell on cooldown (kit cooldown with the engine's haste) and count the cast. */
function spend(e: Engine, M: Mod, u: Unit, k: number, why: string) {
  const us = M.u[u.i];
  const sp = u.champ.spells[k];
  const sk = us.kit.spells[k];
  u.cds[k] = e.t + e.cdOf(u, sk?.cd ? { ...sp, cd: sk.cd } : sp, k);
  us.lockUntil = e.t + 0.45;
  M.stats.casts[why] = (M.stats.casts[why] ?? 0) + 1;
  // Spellblade, ultimate-cast items, "after casting" passives
  if (e.realStats()) Procs.onCast(e, u, k, M.deal);
}

/** Buffs a spell puts on allies (Sivir R speed, Rell E, Lulu W...): everyone within the radius, or the one ally. */
function applyAllyBuff(e: Engine, M: Mod, u: Unit, sk: SpellKit, focus: Unit, allies: Unit[]): string {
  const b = sk.allyBuff;
  if (!b) return "";
  // stasis is centred on the ally it saves; other team buffs on the caster
  const centre = b.kind === "stasis" ? focus : u;
  const group = (b.radius || 0) > 0 ? allies.filter((a) => a.alive && dist(a, centre) <= Math.max(b.radius, b.kind === "stasis" ? 250 : 0)) : [focus];
  if (!group.includes(focus) && b.kind === "stasis") group.push(focus);
  for (const a of group) {
    const as = M.u[a.i];
    if (b.kind === "stasis") {
      as.invulnUntil = Math.max(as.invulnUntil, e.t + b.dur);
      as.untargetUntil = Math.max(as.untargetUntil, e.t + b.dur);
      a.stunUntil = Math.max(a.stunUntil, e.t + b.dur);
    } else if (b.kind === "dr") {
      const amt = a.maxHp * 0.12;
      a.shield += amt;
      as.shields.push({ amt, until: e.t + b.dur });
    } else {
      as.buffUntil = e.t + b.dur;
      as.buffKind = b.kind;
    }
    if (a !== u) as.helpers.push({ i: u.i, until: e.t + 5 });
  }
  return `${b.kind} on ${group.length} ${group.length === 1 ? "ally" : "allies"}`;
}

/** Save an ally about to die: pull it out, make it unkillable for a moment, or let it come back once. */
function castSave(e: Engine, M: Mod, u: Unit, info: FInfo, c: Choice, allies: Unit[]): boolean {
  const us = M.u[u.i];
  const k = c.k;
  const sp = u.champ.spells[k];
  const sk = us.kit.spells[k];
  const sv = sk?.save;
  const ally = c.ally;
  if (!sp || !sk || !sv || !ally) return false;
  const isDashFx = sp.vfx === "dash" || sp.vfx === "blink";
  let from: Vec | null = null;
  if (isDashFx) {
    from = dashMove(e, M, u, ally, sk.dash?.len ?? 600, sk.dash?.overWalls ?? true);
    if (!from) return false; // never draw a dash that did not move
  }
  spend(e, M, u, k, "save");
  const group = (sv.radius ?? 0) > 0 ? allies.filter((a) => a.alive && dist(a, ally) <= sv.radius!) : [ally];
  if (!group.includes(ally)) group.push(ally);
  for (const a of group) {
    const as = M.u[a.i];
    if (sv.kind === "invuln") as.invulnUntil = Math.max(as.invulnUntil, e.t + sv.dur);
    else if (sv.kind === "revive") as.reviveUntil = Math.max(as.reviveUntil, e.t + Math.max(3, sv.dur));
    if (a !== u) as.helpers.push({ i: u.i, until: e.t + 5 });
  }
  if (sv.kind === "relocate" && ally !== u) {
    // pulled to the caster (lantern / Kalista R), or a step back toward safety when already next to it
    const home = e.nearestOwnTurret(ally) ?? FOUNTAIN[ally.side];
    const d = dist(ally, u);
    const to = d > 350 ? { x: u.x + ((ally.x - u.x) / d) * 150, y: u.y + ((ally.y - u.y) / d) * 150 } : (() => {
      const n = norm(home.x - ally.x, home.y - ally.y);
      return { x: ally.x + n.x * 600, y: ally.y + n.y * 600 };
    })();
    const len = dist(ally, to);
    const p = ENGINE_FLAGS.nav ? Nav.blinkLanding(ally, to, len, true) : to;
    ally.x = p.x;
    ally.y = p.y;
    ally.path = [];
    M.u[ally.i].pathTo = null;
    if (!M.u[ally.i].bail) { M.u[ally.i].bail = true; M.u[ally.i].bailAt = e.t; }
  }
  if (isDashFx && from) e.emitSpellFx(u, sp, ally, from, false);
  else e.emitSpellFx(u, sp, ally, ally, false);
  const extra = sk.allyBuff ? `, ${applyAllyBuff(e, M, u, sk, ally, allies)}` : "";
  log(e, M, `  ${nm(u)} [${us.role}/${info.phase[u.side]}] ${sp.key} ${sp.name} (SAVE ${sv.kind}) → ${ally === u ? "self" : nm(ally)} at ${Math.round(hpF(ally) * 100)}% hp${group.length > 1 ? ` (+${group.length - 1} more)` : ""}${extra}`);
  return true;
}

/** Cast the chosen spell. False if it could not go (nothing spent then). */
function cast(e: Engine, M: Mod, u: Unit, info: FInfo, c: Choice, foes: Unit[], allies: Unit[], geo: Geo): boolean {
  const us = M.u[u.i];
  const sp = u.champ.spells[c.k];
  const sk = us.kit.spells[c.k];
  if (!sp || !sk) return false;
  if (c.why === "save") return castSave(e, M, u, info, c, allies);
  const isDashFx = sp.vfx === "dash" || sp.vfx === "blink";
  if (c.why === "buff" && sk.allyBuff && ((sk.allyBuff.radius || 0) > 0 || sk.allyBuff.kind === "stasis") && !isDashFx) {
    // team buff around the caster (e.g. Sivir R), or a stasis dropped on an ally about to die (e.g. Bard R)
    const stasis = sk.allyBuff.kind === "stasis";
    const focus = stasis && c.ally ? c.ally : u;
    spend(e, M, u, c.k, stasis ? "save" : "buff");
    const self = sk.selfBuff ? selfEffects(e, M, u, sk, sp, c.k) : "";
    const what = applyAllyBuff(e, M, u, sk, focus, allies);
    e.emitSpellFx(u, sp, focus, focus, false);
    log(e, M, `  ${nm(u)} [${us.role}/${info.phase[u.side]}] ${sp.key} ${sp.name} (team buff) ${what}${self ? `, ${self}` : ""}`);
    return true;
  }
  const ok = castSpell(e, M, u, info, c, foes, allies, geo);
  // the ally part of the spell: around the caster, or on the ally it was cast on (an enemy-aimed cast of an
  // either/or spell like Lulu W buffs nobody)
  if (ok && sk.allyBuff && sk.allyBuff.kind !== "stasis" && ((sk.allyBuff.radius || 0) > 0 || c.ally)) {
    const what = applyAllyBuff(e, M, u, sk, c.ally ?? u, allies);
    if (what) log(e, M, `    + ${nm(u)} ${sp.key}: ${what}`);
  }
  return ok;
}

/** Move (dashes), emit the effect, roll hits, apply damage/CC/shields. False if it could not go. */
function castSpell(e: Engine, M: Mod, u: Unit, info: FInfo, c: Choice, foes: Unit[], allies: Unit[], geo: Geo): boolean {
  const us = M.u[u.i];
  const k = c.k;
  const sp = u.champ.spells[k];
  const sk = us.kit.spells[k];
  if (!sp || !sk) return false;
  const isDashFx = sp.vfx === "dash" || sp.vfx === "blink";
  const friendlyFx = FRIENDLY_FX.has(sp.vfx);
  const st = M.stats;
  const phase = info.phase[u.side];
  const live = foes.filter((f) => f.alive);
  const putOnCd = () => spend(e, M, u, k, c.why);
  void allies;

  // ---- escape dash (no enemy aim)
  if (c.why === "escape") {
    if (!isDashFx && !sk.dash) return false;
    const chasers = live.filter((f) => !M.u[f.i].bail);
    const home = retreatPoint(e, u, chasers);
    const toHome = norm(home.x - u.x, home.y - u.y);
    let ax = 0, ay = 0;
    for (const f of chasers) if (dist(f, u) < 900) { const n = norm(u.x - f.x, u.y - f.y); ax += n.x; ay += n.y; }
    const dir = norm(toHome.x + ax * 0.8, toHome.y + ay * 0.8);
    const len = Math.min(900, sk.dash?.len ?? Math.min(450, sk.range || 450));
    const dest = { x: u.x + dir.x * len, y: u.y + dir.y * len };
    const start = { x: u.x, y: u.y };
    const from = dashMove(e, M, u, dest, len, sk.dash?.overWalls ?? sp.vfx === "blink");
    if (!from) return false; // never draw a dash that did not move
    putOnCd();
    if (sk.selfBuff) selfEffects(e, M, u, sk, sp, k);
    if (isDashFx) e.emitSpellFx(u, sp, null, from, false);
    else if (friendlyFx) e.emitSpellFx(u, sp, u, u, false);
    else e.emitSpellFx(u, sp, null, { x: start.x + dir.x * len, y: start.y + dir.y * len }, false);
    st.escapes++;
    log(e, M, `  ${nm(u)} ${sp.key} ${sp.name} (escape) dashes away ${Math.round(dist(from, u))}u (${Math.round(hpF(u) * 100)}% hp)`);
    return true;
  }

  // ---- spells cast on an ally (shields, heals, buffs; ally-centred AoE like an enlarged ally knocking enemies up)
  if (c.ally && sk.target !== "self") {
    const ally = c.ally;
    let from: Vec | null = null;
    if (sk.dash && sk.dash.to === "ally" && ally !== u) {
      from = dashMove(e, M, u, ally, sk.dash.len, sk.dash.overWalls);
      if (!from && isDashFx) return false;
    } else if (isDashFx) return false;
    putOnCd();
    const what = supportOn(e, M, u, sk, sp, ally, c.why);
    if (isDashFx && from) e.emitSpellFx(u, sp, ally, from, false);
    else e.emitSpellFx(u, sp, ally, ally, false);
    const rad = areaRadius(sk);
    if ((sk.cc || sk.dmg > 0) && rad > 0) {
      const vs = live.filter((f) => dist(f, ally) <= rad);
      const r = landHits(e, M, u, k, sk, sp, vs, null, phase);
      afterCast(e, M, u, info, { ...c, aim: null }, k, sk, sp, vs.length, r, phase, ` around ${nm(ally)} (${what})`);
    } else log(e, M, `  ${nm(u)} ${sp.key} ${sp.name} (${c.why}) → ${ally === u ? "self" : nm(ally)}: ${what}`);
    return true;
  }

  // ---- self casts: buffs, auras around the caster, empowered attacks
  if (sk.target === "self") {
    const mode = selfMode(us, sk);
    let from: Vec | null = null;
    if (isDashFx) {
      // a self spell drawn as a dash (e.g. a leap): it has to move
      const aim = c.aim ?? live.sort((a, b) => dist(a, u) - dist(b, u))[0];
      if (!aim) return false;
      const len = Math.max(0, Math.min(sk.dash?.len ?? 400, dist(u, aim) - 120));
      const n = norm(aim.x - u.x, aim.y - u.y);
      from = len > 40 ? dashMove(e, M, u, { x: u.x + n.x * len, y: u.y + n.y * len }, len, sk.dash?.overWalls ?? sp.vfx === "blink") : null;
      if (!from) return false;
    }
    putOnCd();
    const what = selfEffects(e, M, u, sk, sp, k);
    const aim = c.aim && c.aim.alive ? c.aim : null;
    let victims: Unit[] = [];
    if (mode === "aura") victims = live.filter((f) => dist(f, u) <= Math.max(150, sk.radius));
    else if (mode === "global") victims = live.filter((f) => dist(f, u) <= 3000);
    else if (mode === "empower" && aim && dist(u, aim) <= us.range + 80) victims = [aim, ...live.filter((f) => f !== aim && sk.radius > 0 && dist(f, aim) <= sk.radius)];
    if (aim && victims.includes(aim)) victims = [aim, ...victims.filter((v) => v !== aim)];
    let fx: Fx;
    if (isDashFx) fx = e.emitSpellFx(u, sp, aim, from!, false);
    else if (friendlyFx) fx = e.emitSpellFx(u, sp, u, u, false);
    else fx = e.emitSpellFx(u, sp, aim, (mode === "empower" || mode === "global") && aim ? aim : u, false);
    if (mode === "buff" || !victims.length) {
      if (!friendlyFx && aim && mode !== "buff") fx.miss = true;
      log(e, M, `  ${nm(u)} ${sp.key} ${sp.name} (${c.why}) self: ${what || "no effect"}`);
      return true;
    }
    const r = landHits(e, M, u, k, sk, sp, victims, aim, phase);
    if (!friendlyFx && aim && !r.hitMain) fx.miss = true;
    afterCast(e, M, u, info, { ...c, aim }, k, sk, sp, victims.length, r, phase, what ? ` (${what})` : "");
    return true;
  }

  // ---- aimed at an enemy (target / direction / area)
  const aim = c.aim;
  if (!aim) return false;
  // a summon aimed at an enemy (Annie R's Tibbers) is drawn at the target, not on the caster; a summon that carries the
  // caster (Zed W shadow, Nidalee W) stays on the caster's side as before
  const ownSideFx = friendlyFx && !(sp.vfx === "summon" && !sk.dash);
  const hook = HOOK_DASH.has(`${u.champ.id}:${k}`);
  let hookLanding = false;
  let from: Vec | null = null;
  let fx: Fx | null = null;
  if (sk.dash && sk.dash.to !== "ally") {
    const d = dist(u, aim);
    let to: Vec;
    const sidestep = sk.dash.to === "direction" && !us.melee && sk.dash.len <= 500 && dist(u, aim) <= us.range + 100 &&
      (c.why === "dps" || c.why === "poke" || c.why === "burst" || c.why === "waveclear");
    if (sidestep) {
      // ranged repositioning dash (a tumble) while the target is already in range: sidestep, keep range
      const dd = geo.dir[u.side];
      const perp = { x: -dd.y * us.lat, y: dd.x * us.lat };
      to = { x: u.x + perp.x * sk.dash.len, y: u.y + perp.y * sk.dash.len };
    } else {
      const stop = us.melee || sk.dmg > 0 || sk.cc ? 110 : us.range * 0.8;
      const len = Math.max(0, Math.min(sk.dash.len, d - stop));
      const n = norm(aim.x - u.x, aim.y - u.y);
      to = { x: u.x + n.x * len, y: u.y + n.y * len };
    }
    if (isDashFx) {
      from = dashMove(e, M, u, to, sk.dash.len, sk.dash.overWalls);
      if (!from) return false; // never draw a dash that did not move
    } else if (hook) {
      // a hook that carries the caster only when it lands (Thresh Q, Nautilus Q, Leona E): cast now, follow it in upkeep
      fx = e.emitSpellFx(u, sp, aim, aim, false);
      hookLanding = true;
    } else {
      // a skillshot that carries the caster (e.g. a line that dashes): cast from the start, then move
      fx = ownSideFx ? e.emitSpellFx(u, sp, u, u, false) : e.emitSpellFx(u, sp, aim, aim, false);
      from = dashMove(e, M, u, to, sk.dash.len, sk.dash.overWalls);
    }
  } else if (isDashFx) {
    // dash-shaped spell without kit dash data: treat as a dash onto the target
    const d = dist(u, aim);
    const len = Math.max(0, Math.min(sp.vfx === "blink" ? 450 : 600, d - 100));
    const n = norm(aim.x - u.x, aim.y - u.y);
    from = len > 40 ? dashMove(e, M, u, { x: u.x + n.x * len, y: u.y + n.y * len }, len, sp.vfx === "blink") : null;
    if (!from) return false;
  }
  putOnCd();
  if (!fx) {
    if (isDashFx) fx = e.emitSpellFx(u, sp, aim, from!, false);
    else if (ownSideFx) fx = e.emitSpellFx(u, sp, u, u, false);
    else fx = e.emitSpellFx(u, sp, aim, aim, false);
  }
  if (sk.shape === "zone" || sk.shape === "wall" || sp.vfx === "zone" || sp.vfx === "wall") fx.until = e.t + 2.5;
  if (sk.selfBuff) selfEffects(e, M, u, sk, sp, k);
  let victims = victimsOf(u, sk, aim, live);
  // a dash that ended short of a melee-range spell cannot reach
  if (from || sk.dash) {
    const reachNow = Math.max(areaRadius(sk), us.melee ? 260 : us.range + 50) + 60;
    victims = victims.filter((v) => dist(u, v) <= reachNow || (!isDashFx && v === aim));
  }
  const r = landHits(e, M, u, k, sk, sp, victims, aim, phase);
  if (!r.hitMain && !ownSideFx) fx.miss = true;
  const hooked = hookLanding && r.hitMain && !!sk.dash;
  if (hooked) us.hook = { at: e.t + HOOK_TRAVEL, aim: aim.i, len: sk.dash!.len, walls: sk.dash!.overWalls };
  afterCast(e, M, u, info, c, k, sk, sp, victims.length, r, phase, from ? ` (dash ${Math.round(dist(from, u))}u)` : hooked ? " (hooked)" : "");
  return true;
}

function applyCC(e: Engine, M: Mod, src: Unit, v: Unit, cc: { type: CcType; dur: number }, at?: Vec, radius?: number): string {
  const vs = M.u[v.i];
  const t = e.t;
  if (cc.type === "arena") {
    const c = at ?? { x: v.x, y: v.y };
    vs.arenaUntil = Math.max(vs.arenaUntil, t + clamp(cc.dur, 0.5, 3.5));
    vs.arena = { x: c.x, y: c.y, r: Math.max(250, radius ?? 325) };
    M.stats.cc++;
    v.lastHitBy.set(src.i, t);
    if (e.realStats()) Procs.onCC(e, src, v, cc.type, cc.dur, M.deal);
    return `arena ${cc.dur.toFixed(1)}s`;
  }
  // tenacity (Mercury's Treads, Cleanse ...) shortens crowd control; Aftershock, Glacial Augment ... react to it
  const real = e.realStats();
  // tenacity does not shorten airborne (knockup / knockback / pull) or suppression, as in LoL
  const airborne = cc.type === "knockup" || cc.type === "knockback" || cc.type === "pull" || cc.type === "suppress";
  const dur = clamp(cc.dur * (real && !airborne ? 1 - Procs.tenacity(e, v) : 1), 0.2, 2.5);
  if (real) Procs.onCC(e, src, v, cc.type, dur, M.deal);
  M.stats.cc++;
  v.lastHitBy.set(src.i, t); // crowd control counts toward the assist
  let tag = cc.type;
  if (HARD.has(cc.type)) {
    const rem = v.stunUntil - t;
    if (rem > 0.4) { M.stats.ccOverlaps++; tag += " (overlap)"; }
    else if (rem > 0 || (vs.ccEnd > 0 && t - vs.ccEnd < 0.75)) { M.stats.ccChains++; tag += " CHAIN"; }
    v.stunUntil = Math.max(v.stunUntil, t + dur);
    vs.ccEnd = v.stunUntil;
    if (cc.type === "knockup" || cc.type === "knockback") vs.airUntil = Math.max(vs.airUntil, t + dur);
    const away = norm(v.x - src.x, v.y - src.y);
    if (cc.type === "knockback") displace(e, v, away.x * 220, away.y * 220);
    else if (cc.type === "pull") displace(e, v, -away.x * Math.min(300, dist(v, src) - 120), -away.y * Math.min(300, dist(v, src) - 120));
    else if (cc.type === "charm" || cc.type === "taunt") displace(e, v, -away.x * Math.min(120, dist(v, src) - 100), -away.y * Math.min(120, dist(v, src) - 100));
    else if (cc.type === "fear") displace(e, v, away.x * 120, away.y * 120);
  } else if (cc.type === "root") vs.rootUntil = Math.max(vs.rootUntil, t + dur);
  else if (cc.type === "slow") vs.slowUntil = Math.max(vs.slowUntil, t + dur);
  else if (cc.type === "silence") vs.silenceUntil = Math.max(vs.silenceUntil, t + dur);
  else if (cc.type === "blind") vs.blindUntil = Math.max(vs.blindUntil, t + dur);
  else if (cc.type === "ground") vs.groundUntil = Math.max(vs.groundUntil, t + dur);
  return `${tag} ${dur.toFixed(1)}s`;
}

// ---------------------------------------------------------------- turrets

/** Each turret shoots one champion in range: a fighter who just hit a champion near it (diving), else the closest.
 *  A champion that is not in a fight is a target only while no wave of its side is on the turret, and after
 *  SIM_TUNE.towerGrace seconds in range (before this, turrets ignored anyone outside a fight). */
function turretShots(e: Engine, M: Mod) {
  const m = e.minute();
  for (const u of e.units) {
    const s = M.u[u.i];
    if (!u.alive || u.fightId || !e.exposedAt(u.side, u)) s.towerAt = -1;
    else if (s.towerAt < 0) s.towerAt = e.t;
  }
  if (ENGINE_FLAGS.minions) {
    // the game's own targeting (turrets.ts): minions first, a champion when it hits one of the turret's champions
    // or when no minions are in range (outside a fight: after SIM_TUNE.towerGrace)
    Turrets.shots(e, (u, amount) => hurt(e, M, null, u, amount * FIGHT_TUNE.towerMul, "proc"),
      (u) => M.u[u.i].towerAt >= 0 && e.t - M.u[u.i].towerAt >= SIM_TUNE.towerGrace);
    return;
  }
  e.turrets.forEach((t, ti) => {
    const ts = M.tower[ti];
    if (!t.alive) { ts.target = -1; return; }
    let best: Unit | null = null, bv = -Infinity;
    let wave: boolean | null = null;
    for (const u of e.units) {
      if (!u.alive || u.side === t.side) continue;
      const d = dist(t.pos, u);
      if (d > 780) continue;
      if (!u.fightId) {
        const since = M.u[u.i].towerAt;
        if (since < 0 || e.t - since < SIM_TUNE.towerGrace) continue;
        wave ??= e.waveAt(t);
        if (wave) continue;
      }
      let v = -d;
      if (e.t - M.u[u.i].hitChampAt < 1.5) v += 1000;
      if (ts.target === u.i) v += 300;
      if (v > bv) { bv = v; best = u; }
    }
    if (!best) { ts.target = -1; return; }
    ts.target = best.i;
    hurt(e, M, null, best, (180 + m * 6) * DT * FIGHT_TUNE.towerMul, "proc");
    if (e.t >= ts.fxAt) {
      ts.fxAt = e.t + 0.8;
      e.fx_({ kind: "tower", side: t.side, x: t.pos.x, y: t.pos.y, tx: best.x, ty: best.y, color: t.side ? "#ff6b6b" : "#6ba8ff", r: 0, w: 0, to: best.i });
    }
  });
}
