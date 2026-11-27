// Summoner spells (owner: combat-stats session; the match view session added Teleport, Ghost, the shared cooldown
// state and the effects the renderer and the HUD read, 2026-11-27).
// Which pair each player takes: summoners.gen.ts, the most taken pair of that champion in that role in the 2026 LCK
// games (scripts/build_combat_ref.py), else the role's.
//  * Ignite, Exhaust, Heal, Barrier, Cleanse, Ghost: a simple use rule each inside fights (the fight AI's stand-in).
//  * Flash: engine.flashToward (escapes: engine.tryFlash; a flash engage: fight.ts engagerAct).
//  * Smite: charges, recharge, the jungle pet's upgrades and the use rules all live in the Smite section below
//    (T12, 2026-11-27). The engine finishes camps with it (engine.hitCamp: wantsCampSmite + smite) and epic monsters
//    (engine.objectivesTick: smiteDamage / canSmite / smite); in fights, Unleashed / Primal Smite on a champion is a
//    simple rule in FX.smite like the spells above. For fights and smite contests:
//      canSmite(e, u, champion?)   castable now: a charge, past the 15 s lock (champion: Unleashed Smite or later)
//      smiteCharges(e, u)          charges now (0..2); smiteNextIn(e, u) s until the next one (0 = both there)
//      smiteReadyIn(e, u)          s until it can be cast (0 = now); smiteTier(e, u) 0 Smite / 1 Unleashed / 2 Primal
//      smiteDamage(e, u, champion?) its damage now (monster 600 / 1000 / 1400; champion 0 / 40 / 40)
//      smite(e, u, { camp } | { obj }, { why, quiet })   cast on a camp or an epic monster: charge, damage, effect
//      smiteChampion(c, v, { why })  cast on an enemy champion from a fight effect (Ctx: damage through fight.ts)
//      feedPet(e, u)               a large monster killed: the pet's treats (the upgrades)
//      keepsLastSmite(e, u)        the last charge is being kept for an epic monster (up, or spawning soon)
//  * Teleport: teleportTick below, called first thing for every living unit.
// Every use goes through spend(): it starts the cooldown the HUD shows and queues an effect for the renderer
// (Fx.sum). Cooldowns from LoL; Ionian Boots of Lucidity give 10 summoner spell haste.
import type { CampState, Engine, ObjKey, Unit } from "./engine";
import * as Items from "./items";
import { FOUNTAIN, LANES, lanePoint } from "./map";
import type { Vec } from "./map";
import * as Nav from "./nav";
import { SUMMONER_PAIRS, ROLE_PAIRS } from "./summoners.gen";
import type { SummonerName } from "./summoners.gen";
import { T, alliesNear, applyCC, buff, byLevel, dist, dot, foesNear, grievous, heal, hpF, inStasis, ready, shield, state } from "./procs-lib";
import type { Ctx, Effect } from "./procs-lib";

export function summonersOf(u: Unit): SummonerName[] {
  return SUMMONER_PAIRS[u.champ.id]?.[u.role] ?? ROLE_PAIRS[u.role] ?? ["flash"];
}

export const SUMMONER_KO: Record<SummonerName, string> = {
  flash: "점멸", ignite: "점화", teleport: "순간이동", smite: "강타", heal: "회복", barrier: "방어막", exhaust: "탈진",
  cleanse: "정화", ghost: "유체화", mark: "표식",
};
/** Data Dragon file names (img/spell/). */
export const SUMMONER_ICON: Record<SummonerName, string> = {
  flash: "SummonerFlash.png", ignite: "SummonerDot.png", teleport: "SummonerTeleport.png", smite: "SummonerSmite.png",
  heal: "SummonerHeal.png", barrier: "SummonerBarrier.png", exhaust: "SummonerExhaust.png", cleanse: "SummonerBoost.png",
  ghost: "SummonerHaste.png", mark: "SummonerSnowball.png",
};
/** Seconds. Smite's 15 is only the lock between two casts: its charges are in the Smite section (SMITE). */
const COOLDOWN: Record<SummonerName, number> = {
  flash: 300, ignite: 180, teleport: 360, smite: 15, heal: 240, barrier: 180, exhaust: 240, cleanse: 240, ghost: 240, mark: 80,
};
const COLOR: Record<SummonerName, string> = {
  flash: "#fff3a0", ignite: "#ff7a3c", teleport: "#b48cff", smite: "#ffe28a", heal: "#7dff8a", barrier: "#ffd36b",
  exhaust: "#c9b27a", cleanse: "#bfefff", ghost: "#8fd0ff", mark: "#ffffff",
};

/**
 * How Teleport and the flash engage are used (scripts may change these; measured with scripts/sim-diag.ts).
 * tpLane / tpLaneLate: chance that a laner back at the fountain teleports to its lane instead of walking (during the
 *   laning phase / after it: 0, the spell is kept for fights then, as in the LCK); tpPlay: the same when a fight with
 *   allies is on where it is going; tpJoin: chance that a side laner far from a fresh fight of five or more teleports
 *   to it.
 * tpMin: no teleport for a walk shorter than this (u); tpSave: it has to save at least this much walking (u).
 * tpChannel: seconds standing still before the jump (LoL: 4). ghostSpeed / ghostTime: Ghost's move speed and length.
 * smiteHold: a jungler down to its last Smite charge keeps it for an epic monster that is up or spawns within this
 *   many seconds, unless the other charge is back before then (wantsCampSmite; measured with scripts/smite-check.ts).
 */
export const SUM_TUNE = {
  tpLane: 0.55, tpLaneLate: 0, tpPlay: 0.9, tpJoin: 0.5, tpMin: 7000, tpSave: 3500, tpChannel: 4,
  ghostSpeed: 1.3, ghostTime: 10,
  smiteHold: 45,
};
export function applySumTune(spec: string | undefined) {
  for (const kv of (spec ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split(":");
    const n = Number(v);
    if (!Object.prototype.hasOwnProperty.call(SUM_TUNE, k) || v === undefined || v === "" || !Number.isFinite(n)) {
      throw new Error(`SUM_TUNE: bad entry "${kv}" (keys: ${Object.keys(SUM_TUNE).join(", ")})`);
    }
    (SUM_TUNE as Record<string, number>)[k] = n;
  }
}

// ---------- cooldowns: one store for every spell (procs-lib state: the same `cd` the fight effects use) ----------
export const has = (u: Unit, s: SummonerName) => summonersOf(u).includes(s);
/** When the spell can be cast again (Smite: from its charges, see smiteReadyIn). */
export const readyAt = (e: Engine, u: Unit, s: SummonerName) => (s === "smite" ? e.t + smiteReadyIn(e, u) : state(e, u).cd[s] ?? 0);
export const isReady = (e: Engine, u: Unit, s: SummonerName) => has(u, s) && readyAt(e, u, s) <= e.t;

function cooldown(e: Engine, u: Unit, s: SummonerName): number {
  // Unleashed Teleport from 10:00: 330 s
  const base = s === "teleport" && e.t >= 600 ? 330 : COOLDOWN[s];
  return Items.unitItems(e, u)?.items.includes(3158) ? (base * 100) / 110 : base;
}

/** How often each spell was used, by reason ("flash:escape", "teleport:lane" ...), for scripts. */
const used = new WeakMap<Engine, Record<string, number>>();
export function usage(e: Engine): Record<string, number> {
  let m = used.get(e);
  if (!m) used.set(e, (m = {}));
  return m;
}

/**
 * A summoner spell goes on cooldown (Smite: one of its charges is used). Unless `quiet` (the caller draws its own
 * effect and tags it with Fx.sum), an effect is queued for the renderer: from the caster to `to` / `at`; `pve` marks
 * one cast on a monster.
 */
export function spend(e: Engine, u: Unit, s: SummonerName, o: { to?: Unit | null; at?: Vec; why?: string; quiet?: boolean; pve?: boolean } = {}) {
  if (s === "smite") useCharge(e, u);
  else state(e, u).cd[s] = e.t + cooldown(e, u, s);
  const key = o.why ? `${s}:${o.why}` : s;
  const m = usage(e);
  m[key] = (m[key] ?? 0) + 1;
  if (o.quiet) return;
  const p = o.at ?? o.to ?? u;
  e.fx_({ kind: "sum", side: u.side, x: u.x, y: u.y, tx: p.x, ty: p.y, color: COLOR[s], r: 0, w: 0, from: u.i, to: o.to?.i, sum: s, text: SUMMONER_KO[s], pve: o.pve });
}

/**
 * For the HUD: the player's two spells, seconds left on each (0 = up) and whether it is being channelled right now.
 * Smite also gives its charges (0..2) and upgrade (0 Smite, 1 Unleashed, 2 Primal).
 */
export function slots(e: Engine, u: Unit): { name: SummonerName; left: number; busy: boolean; charges?: number; tier?: number }[] {
  return summonersOf(u).map((name) => ({
    name, left: Math.max(0, readyAt(e, u, name) - e.t), busy: name === "teleport" && !!(u as TpUnit).tp && u.alive,
    ...(name === "smite" ? { charges: smiteCharges(e, u), tier: smiteTier(e, u) } : {}),
  }));
}

// ---------- Smite ----------
/**
 * LoL rules for 2026 (V26.01; wiki.leagueoflegends.com Smite and Gustwalker Hatchling, read 2026-11-27):
 *  - charges: one at the start, at most two; while under two a new one comes every 90 s, the first timer starting at
 *    0:48 (the second charge at 2:18, read like the pet's "from 1:30, with the first treat at 2:30"); 15 s lock
 *    between two casts. Summoner spell haste (Ionian Boots) shortens the recharge, not the lock.
 *  - damage to a monster: 600 true; 1000 (Unleashed Smite) once the jungle pet has eaten 15 treats; 1400 (Primal
 *    Smite, which also hits the monsters around: the engine's camp is one health bar anyway) at 35. No heal since
 *    V12.22.
 *  - treats: 1 per large monster killed (a camp's big monster, the scuttle, an epic monster with the team) and a stored
 *    bonus treat every 60 s from 1:30 (the first at 2:30), eaten with the next large monster. The first upgrade comes
 *    at about 6 min, the second at about 13 (scripts/smite-check.ts).
 *  - Unleashed and Primal Smite can be cast on an enemy champion: 40 true damage and a 20 % slow for 2 s.
 * LCK 2026 (scripts/lck_smite.py, 502 games): a jungler casts Smite 19.1 times a game, 0.60 a minute (16.3 in games
 * under 28 min, 23.4 over 40), close to every charge it gets in short games.
 */
export const SMITE = {
  dmg: [600, 1000, 1400], treats: [15, 35], champDmg: 40, champSlow: 0.2, champSlowTime: 2,
  lock: 15, recharge: 90, max: 2, firstTimer: 48, bonusFrom: 90, bonusEvery: 60, range: 500,
};
/** The fight model has one slow strength (fight.ts moveToward: x0.65); Smite's 20 % for 2 s is the same slowing as this. */
const FIGHT_SLOW = 0.35;

interface SmiteState {
  charges: number;
  /** when the next charge comes (only meaningful while under SMITE.max) */
  next: number;
  /** no cast before this (the 15 s between two casts) */
  lock: number;
  treats: number;
  /** stored bonus treats and when the next one is stored */
  bonus: number;
  bonusAt: number;
}
const smites = new WeakMap<Engine, SmiteState[]>();
function recharge(e: Engine, u: Unit): number {
  return Items.unitItems(e, u)?.items.includes(3158) ? (SMITE.recharge * 100) / 110 : SMITE.recharge;
}
/** The unit's Smite, brought up to now (charges that came back, bonus treats stored). */
function sm(e: Engine, u: Unit): SmiteState {
  let list = smites.get(e);
  if (!list) smites.set(e, (list = []));
  let s = list[u.i];
  if (!s) s = list[u.i] = { charges: 1, next: SMITE.firstTimer + recharge(e, u), lock: 0, treats: 0, bonus: 0, bonusAt: SMITE.bonusFrom + SMITE.bonusEvery };
  while (s.charges < SMITE.max && e.t >= s.next) {
    s.charges++;
    if (s.charges < SMITE.max) s.next += recharge(e, u);
  }
  while (e.t >= s.bonusAt) {
    s.bonus++;
    s.bonusAt += SMITE.bonusEvery;
  }
  return s;
}
function useCharge(e: Engine, u: Unit) {
  const s = sm(e, u);
  // the recharge timer runs only while under the maximum: it starts now when a full Smite is used
  if (s.charges >= SMITE.max) s.next = e.t + recharge(e, u);
  s.charges = Math.max(0, s.charges - 1);
  s.lock = e.t + SMITE.lock;
}

export const smiteCharges = (e: Engine, u: Unit) => (has(u, "smite") ? sm(e, u).charges : 0);
/** Seconds until the next charge comes back (0 when both are there; Infinity without Smite). */
export function smiteNextIn(e: Engine, u: Unit): number {
  if (!has(u, "smite")) return Infinity;
  const s = sm(e, u);
  return s.charges >= SMITE.max ? 0 : Math.max(0, s.next - e.t);
}
/** Seconds until Smite can be cast: the lock after a cast, or the next charge when none is left (Infinity without). */
export function smiteReadyIn(e: Engine, u: Unit): number {
  if (!has(u, "smite")) return Infinity;
  const s = sm(e, u);
  return Math.max(0, s.lock - e.t, s.charges > 0 ? 0 : s.next - e.t);
}
/** 0 Smite, 1 Unleashed Smite (15 treats), 2 Primal Smite (35). */
export function smiteTier(e: Engine, u: Unit): number {
  if (!has(u, "smite")) return 0;
  const t = sm(e, u).treats;
  return t >= SMITE.treats[1] ? 2 : t >= SMITE.treats[0] ? 1 : 0;
}
/** Smite's damage now: to a monster (true damage, also epic monsters), or to an enemy champion (0 before Unleashed). */
export function smiteDamage(e: Engine, u: Unit, champion = false): number {
  if (!has(u, "smite")) return 0;
  const tier = smiteTier(e, u);
  return champion ? (tier > 0 ? SMITE.champDmg : 0) : SMITE.dmg[tier];
}
/** Can be cast this step: alive, a charge, past the lock (on a champion: Unleashed Smite or later). */
export function canSmite(e: Engine, u: Unit, champion = false): boolean {
  return u.alive && smiteReadyIn(e, u) <= 0 && (!champion || smiteTier(e, u) > 0);
}

/**
 * Cast Smite on a camp or an epic monster: uses a charge, takes the damage off its health and (unless `quiet`: the
 * caller draws its own effect) queues the effect from the jungler to the monster. Killing it is the caller's part
 * (engine.hitCamp, engine.objectivesTick / secure). Range is the caller's check too (SMITE.range from the edge).
 * Returns the damage dealt; 0 = not cast (no Smite, no charge, locked). why: the usage key ("camp", "obj", "steal" ...).
 */
export function smite(e: Engine, u: Unit, target: { camp: CampState } | { obj: ObjKey }, o: { why?: string; quiet?: boolean } = {}): number {
  if (!canSmite(e, u)) return 0;
  const dmg = smiteDamage(e, u);
  const m = "camp" in target ? target.camp : e.obj[target.obj];
  m.hp -= dmg;
  spend(e, u, "smite", { at: m.pos, why: o.why ?? ("camp" in target ? "camp" : "obj"), quiet: o.quiet, pve: true });
  return dmg;
}

/**
 * Cast Unleashed / Primal Smite on an enemy champion from a fight effect (c: the caster's Ctx, so the damage goes
 * through fight.ts hurt: shields, kill credit). 40 true damage and the slow. Returns the damage, 0 = not cast.
 * Used by the simple fight rule in FX.smite below.
 */
export function smiteChampion(c: Ctx, v: Unit, o: { why?: string } = {}): number {
  if (!v.alive || v.side === c.u.side || !canSmite(c.e, c.u, true)) return 0;
  const dmg = smiteDamage(c.e, c.u, true);
  spend(c.e, c.u, "smite", { to: v, why: o.why ?? "champ" });
  c.deal(c.u, v, dmg, "proc");
  applyCC(c, v, "slow", (SMITE.champSlowTime * SMITE.champSlow) / FIGHT_SLOW);
  return dmg;
}

/** A large monster this unit killed (camp, scuttle, an epic monster with its team): the pet eats a treat, and a
 *  stored bonus treat with it. No-op without Smite. */
export function feedPet(e: Engine, u: Unit) {
  if (!has(u, "smite")) return;
  const s = sm(e, u);
  s.treats += 1;
  if (s.bonus > 0) {
    s.bonus--;
    s.treats += 1;
  }
}

/** Seconds until an epic monster is up (0 = one is up now), Infinity when none is coming. */
function epicIn(e: Engine): number {
  let best = Infinity;
  for (const k of Object.keys(e.obj) as ObjKey[]) {
    const o = e.obj[k];
    if (o.alive) return 0;
    // (the herald does not come while the baron is up)
    if (o.spawnAt === null || (k === "herald" && e.obj.baron.alive)) continue;
    best = Math.min(best, Math.max(0, o.spawnAt - e.t));
  }
  return best;
}

/**
 * The jungler's last charge is kept for an epic monster that is up or spawns within SUM_TUNE.smiteHold s, unless the
 * other charge is back before then. False with both charges up (using one wastes nothing).
 */
export function keepsLastSmite(e: Engine, u: Unit): boolean {
  const s = sm(e, u);
  if (s.charges >= SMITE.max) return false;
  const epic = epicIn(e);
  return epic < SUM_TUNE.smiteHold && s.next - e.t > epic;
}

/**
 * Whether a jungler clearing camp c spends a charge on it now: the camp is within Smite's damage (Smite finishes it:
 * the engine's camp is one health bar), and the charge is not the one kept for an epic monster (keepsLastSmite).
 */
export function wantsCampSmite(e: Engine, u: Unit, c: CampState): boolean {
  return canSmite(e, u) && c.hp <= smiteDamage(e, u) && !keepsLastSmite(e, u);
}

/** Ghost: move speed while it runs (engine.speed). */
export function speedMul(e: Engine, u: Unit): number {
  if (!has(u, "ghost")) return 1;
  return (state(e, u).until.ghost ?? -1) > e.t ? SUM_TUNE.ghostSpeed : 1;
}
export const ghosting = (e: Engine, u: Unit) => speedMul(e, u) > 1;

// ---------- Teleport ----------
interface Tp { start: number; end: number; to: Vec; join: number }
type TpUnit = Unit & {
  tp?: Tp;
  /** already decided (yes or no) for this stay at the fountain */
  tpAsked?: boolean;
  /** the last fight this unit considered teleporting to */
  tpSeen?: number;
  /** walking from the teleport to the fight it came for */
  tpJoin?: { until: number; fight: number };
};

/** The teleport being channelled, for the renderer: where to, and how far along (0..1). */
export function channel(e: Engine, u: Unit): { to: Vec; k: number } | null {
  const tp = (u as TpUnit).tp;
  if (!tp || !u.alive || e.t > tp.end + 0.5) return null;
  return { to: tp.to, k: Math.max(0, Math.min(1, (e.t - tp.start) / Math.max(0.01, tp.end - tp.start))) };
}

/**
 * Where a teleport toward `goal` lands: next to the allied outer structure nearest to it, or (`minions`: Unleashed
 * Teleport, from 10:00, used for fights) on our side of a minion wave when that is nearer. A plain return to lane
 * goes to the turret only: landing on a wave crashed into the enemy's turret put laners straight back into the
 * siege, and games ran 4 to 6 minutes shorter.
 */
function landing(e: Engine, u: Unit, goal: Vec, minions: boolean): Vec | null {
  let best: Vec | null = null, bd = Infinity;
  for (const t of e.turrets) {
    if (!t.alive || t.side !== u.side || t.lane === "nexus") continue;
    const d = dist(t.pos, goal);
    if (d < bd) { bd = d; best = t.pos; }
  }
  if (minions && e.t >= 600) {
    for (const lane of LANES) {
      const p = lanePoint(lane, e.lanes[lane].front + (u.side === 0 ? -0.025 : 0.025));
      if (e.exposedAt(u.side, p, 900)) continue; // not into a turret that would shoot the arrival
      const d = dist(p, goal);
      if (d < bd) { bd = d; best = p; }
    }
  }
  if (!best) return null;
  const home = FOUNTAIN[u.side];
  const d = dist(best, home) || 1;
  return Nav.nearestWalkable({ x: best.x + ((home.x - best.x) / d) * 220, y: best.y + ((home.y - best.y) / d) * 220 });
}

function startTp(e: Engine, u: Unit, to: Vec, why: string, join = 0) {
  const x = u as TpUnit;
  x.tp = { start: e.t, end: e.t + SUM_TUNE.tpChannel, to, join };
  u.path = [];
  u.goal = null;
  spend(e, u, "teleport", { at: to, why });
}

/**
 * Called first for every living unit (engine.unitTick). True = Teleport has the unit this step: channelling, landing,
 * or walking from the landing spot to the fight it came for.
 *  - back at the fountain with a long walk ahead (after a recall or a death): teleport to the lane, like the top and
 *    mid laners who take the spell do; almost always when a fight with allies is on where it is going;
 *  - a side laner far from a fresh fight of five or more: teleport to the nearest allied turret or wave and walk in.
 */
export function teleportTick(e: Engine, u: Unit): boolean {
  const x = u as TpUnit;
  if (x.tp) {
    // a channel left over from before a death, or broken by being pulled into a fight
    if (e.t > x.tp.end + 0.5 || u.fightId) x.tp = undefined;
    else if (e.t < x.tp.end) return true;
    else {
      const tp = x.tp;
      x.tp = undefined;
      u.x = tp.to.x;
      u.y = tp.to.y;
      u.path = [];
      u.goal = null;
      // the landing: an effect on the spot (kind "sum" with from === to marks the arrival for the renderer)
      e.fx_({ kind: "sum", side: u.side, x: u.x, y: u.y, tx: u.x, ty: u.y, color: COLOR.teleport, r: 0, w: 0, from: u.i, to: u.i, sum: "teleport" });
      if (tp.join) x.tpJoin = { until: e.t + 14, fight: tp.join };
      return true;
    }
  }
  if (x.tpJoin) {
    const f = e.fights.get(x.tpJoin.fight);
    const mates = f ? e.units.some((m) => m.alive && m.side === u.side && m.fightId === x.tpJoin!.fight) : false;
    // (back at the fountain = it died on the way: the walk is off)
    if (!f || !mates || u.fightId || e.t > x.tpJoin.until || hpF(u) < 0.35 || dist(u, FOUNTAIN[u.side]) < 1600) x.tpJoin = undefined;
    else {
      e.setGoal(u, { x: f.x, y: f.y });
      e.moveStep(u, 0.25);
      return true;
    }
  }
  const home = FOUNTAIN[u.side];
  const atBase = dist(u, home) < 1600;
  // away from the fountain: the next stay there decides afresh (cleared here, before the cooldown check below, so
  // a unit that dies or recalls just as Teleport comes back up is not left with the old answer)
  if (!atBase) x.tpAsked = false;
  if (u.fightId || u.task === "recall" || u.recallEnd !== undefined || e.t < 150 || !isReady(e, u, "teleport")) return false;
  // ---- from the fountain to where it was going ----
  if (atBase && !x.tpAsked && u.goal && hpF(u) >= 0.9) {
    const walk = dist(u, u.goal);
    if (walk < SUM_TUNE.tpMin) return false;
    let play = false;
    for (const [id, f] of e.fights) {
      if (dist(f, u.goal) < 3500 && e.units.some((m) => m.alive && m.side === u.side && m.fightId === id)) play = true;
    }
    const to = landing(e, u, u.goal, play);
    if (!to || dist(to, u.goal) + SUM_TUNE.tpSave > walk) return false;
    x.tpAsked = true;
    const p = play ? SUM_TUNE.tpPlay : e.laningPhase() ? SUM_TUNE.tpLane : SUM_TUNE.tpLaneLate;
    if (!e.rng.chance(p)) return false;
    startTp(e, u, to, play ? "play" : "lane");
    return true;
  }
  // ---- a side laner far from a fight that has just broken out ----
  if (u.task === "lane" && e.t > 300 && hpF(u) >= 0.55) {
    for (const [id, f] of e.fights) {
      if (x.tpSeen === id || e.t - f.start > 5 || dist(u, f) < 6000) continue;
      let mine = 0, theirs = 0;
      for (const m of e.units) if (m.alive && m.fightId === id) { if (m.side === u.side) mine++; else theirs++; }
      if (mine < 2 || theirs < 2 || mine + theirs < 5) continue;
      x.tpSeen = id;
      const to = landing(e, u, f, true);
      if (!to || dist(to, f) > 3200) continue;
      if (!e.rng.chance(SUM_TUNE.tpJoin)) continue;
      startTp(e, u, to, "join", id);
      return true;
    }
  }
  return false;
}

// ---------- spells with a use rule inside fights ----------
const fighting = (c: Ctx) => c.u.fightId !== 0;

const FX: Partial<Record<SummonerName, Effect>> = {
  ignite: {
    id: "ignite",
    tick: (c) => {
      if (!fighting(c) || !ready(c, "ignite")) return;
      // on the lowest enemy in range that is worth it (under 45 % health, or under 60 % before 10 minutes)
      const limit = c.e.t < 600 ? 0.6 : 0.45;
      const v = foesNear(c.e, c.u, 600).filter((f) => hpF(f) < limit).sort((a, b) => a.hp - b.hp)[0];
      if (!v) return;
      spend(c.e, c.u, "ignite", { to: v });
      dot(c, v, T(70 + 20 * c.u.level), 5, "ignite");
      grievous(c.e, v, 5);
    },
  },
  exhaust: {
    id: "exhaust",
    tick: (c) => {
      if (!fighting(c) || !ready(c, "exhaust")) return;
      // on the enemy carry or diver closest to a hurt ally
      const hurt = alliesNear(c.e, c.u, 900).filter((a) => hpF(a) < 0.6 && a.fightId);
      if (!hurt.length) return;
      const v = foesNear(c.e, c.u, 650).sort((a, b) => Math.hypot(a.x - hurt[0].x, a.y - hurt[0].y) - Math.hypot(b.x - hurt[0].x, b.y - hurt[0].y))[0];
      if (!v) return;
      spend(c.e, c.u, "exhaust", { to: v });
      buff(c.e, v, "weaken", 0.35, 3);
    },
  },
  heal: {
    id: "heal",
    tick: (c) => {
      if (!fighting(c) || !ready(c, "heal")) return;
      const low = alliesNear(c.e, c.u, 850).filter((a) => hpF(a) < 0.3 && a.fightId).sort((a, b) => hpF(a) - hpF(b));
      const me = hpF(c.u) < 0.3;
      if (!me && !low.length) return;
      const other = low.find((a) => a !== c.u);
      spend(c.e, c.u, "heal", { to: other ?? c.u });
      const amt = byLevel(c.u, 80, 318);
      heal(c.e, c.u, amt);
      if (other) heal(c.e, other, amt);
    },
  },
  barrier: {
    id: "barrier",
    tick: (c) => {
      if (!fighting(c) || !ready(c, "barrier") || hpF(c.u) >= 0.3 || !foesNear(c.e, c.u, 900).length) return;
      spend(c.e, c.u, "barrier");
      shield(c.e, c.u, byLevel(c.u, 120, 480), 2.5);
    },
  },
  cleanse: {
    id: "cleanse",
    tick: (c) => {
      // never on its own save (a stasis is a stun here too)
      if (!fighting(c) || !ready(c, "cleanse") || c.u.stunUntil - c.e.t < 0.75 || inStasis(c.e, c.u)) return;
      spend(c.e, c.u, "cleanse");
      c.u.stunUntil = c.e.t;
      c.p.until.cleanse = c.e.t + 3;
    },
  },
  smite: {
    id: "smite",
    tick: (c) => {
      // Unleashed / Primal Smite on an enemy champion in a fight: on a low one in range (to finish it or keep it from
      // getting away), or on the nearest when both charges are up (one would go to waste); never the charge kept for
      // an epic monster. LCK junglers use almost every charge they get (SMITE), these too.
      if (!fighting(c) || !canSmite(c.e, c.u, true) || keepsLastSmite(c.e, c.u)) return;
      const foes = foesNear(c.e, c.u, SMITE.range + 100).filter((f) => !inStasis(c.e, f));
      if (!foes.length) return;
      const low = foes.filter((f) => hpF(f) < 0.3).sort((a, b) => a.hp - b.hp)[0];
      if (!low && smiteCharges(c.e, c.u) < SMITE.max) return;
      smiteChampion(c, low ?? foes.sort((a, b) => dist(a, c.u) - dist(b, c.u))[0]);
    },
  },
  ghost: {
    id: "ghost",
    tick: (c) => {
      if (!fighting(c) || !ready(c, "ghost")) return;
      // to get away when low with someone on top of it, or to run a low enemy down
      const foes = foesNear(c.e, c.u, 1100);
      const flee = hpF(c.u) < 0.35 && foes.some((f) => dist(f, c.u) < 650);
      const chase = foes.some((f) => hpF(f) < 0.3 && dist(f, c.u) > 350);
      if (!flee && !chase) return;
      spend(c.e, c.u, "ghost");
      c.p.until.ghost = c.e.t + SUM_TUNE.ghostTime;
    },
  },
};

export function summonerFx(_e: Engine, u: Unit): Effect[] {
  return summonersOf(u).map((s) => FX[s]).filter((x): x is Effect => !!x);
}
