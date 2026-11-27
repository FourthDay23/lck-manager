// Smite fights over epic monsters and steals (T09, 2026-11-28). Called by engine.objectivesTick:
//   dealt(e, k, bySide)          the damage each side put on the monster this step (who has been doing it)
//   finish(e, k, at, bySide)     the last hit this step, if there is one: who takes it and whether it is a steal
// macro.ts sends a jungler on a steal run (stealTick / stealJob) and asks stealing(); the jungler's Smite itself
// (charges, the pet's 600 / 1000 / 1400, the 15 s lock) is summoners.ts (T12).
//
// Model
//  * The side that has done most of the damage since the monster was last at full health is the one taking it; its
//    jungler is the owner, the other one the thief. A jungler counts when it is alive, not stunned, has a charge and
//    stands within STEAL_TUNE.range of the monster (Smite's 500 u from the monster's edge; over the pit wall too, as
//    in the real game). Being in a fight does not stop a Smite, only slows the hands.
//  * Each quarter second in which the monster's health is inside a jungler's Smite damage, that jungler presses with a
//    chance set by its reflexes (Unit.reflex: the player's mechanics and consistency), lower for the thief (it does
//    not control the damage) and for a jungler that is being fought. A bigger Smite (pet upgrade) reaches the health
//    first. If both press in the same quarter second the owner usually wins; the loser's charge is gone all the same.
//    With no Smite pressed the team's damage finishes it.
//  * A steal runner waits outside the reach, away from the enemy (macro.ts stealJob), and goes in when the monster
//    is about to drop into its Smite: on foot, or with Flash from up to STEAL_TUNE.flashIn outside the reach.
//  * It is a steal when the side that takes the last hit did less than STEAL_TUNE.stolenShare of the damage.
// LCK 2026 (scripts/lck_steals.py, 502 games): the other team hit the monster too in 21 % of dragon / baron / herald
// takes; the team credited with fewer champions than the other took 4.4 % of dragons, 5.0 % of barons, 4.6 % of
// heralds (0.32 a game), 90 % of those by its jungler. scripts/steal-diag.ts prints the engine's side.
import type { Engine, ObjKey, SideN, Unit } from "./engine";
import { OBJ_KO, applyTune } from "./engine";
import * as Summoners from "./summoners";
import * as Macro from "./macro";
import { dist } from "./map";
import { josa } from "../core/format";

/**
 * range: how far from the monster's centre a jungler can Smite it. react: chance per 0.25 s that an average jungler
 * (reflex 73) presses once the health is inside its Smite; reactSkill: per point of reflex; thief: multiplier for the
 * jungler of the side that is not doing the monster; busy: multiplier for one that is in a fight or was hit within
 * 1.5 s; tie: when both press in the same quarter second the thief wins this often at equal reflexes (tieSkill per
 * point of difference). stolenShare: the taker's share of the damage under which the take is a steal. flashIn: a
 * steal runner flashes into reach from up to this far outside it; flashAt: when the health is within this multiple
 * of its Smite damage. Scripts can override any of them with STEAL_TUNE=key:value,...
 */
export const STEAL_TUNE = {
  range: 750,
  react: 0.6, reactSkill: 0.012, thief: 0.7, busy: 0.7,
  tie: 0.3, tieSkill: 0.0125,
  stolenShare: 0.4,
  flashIn: 400, flashAt: 1.5,
};
export function applyStealTune(spec: string | undefined) {
  applyTune(STEAL_TUNE, "STEAL_TUNE", spec);
}
const REFLEX_REF = 73;

export interface StealStats {
  /** epic takes; of those: both junglers in reach with a charge at the last hit; a steal runner in reach */
  takes: Record<string, number>;
  both: Record<string, number>;
  steals: Record<string, number>;
  /** the thief pressed and lost, or stood in reach while the owner took it */
  failed: Record<string, number>;
  /** takes whose last hit was a Smite; flashes into reach */
  smited: number;
  flashIn: number;
}

interface State {
  /** damage by side since the monster was last at full health, when it was last hit and how fast (per second) */
  dmg: Record<string, [number, number]>;
  last: Record<string, number>;
  rate: Record<string, number>;
  stats: StealStats;
}

function st(e: Engine): State {
  let s = e.mods.objsmite as State | undefined;
  if (!s) {
    s = { dmg: {}, last: {}, rate: {}, stats: { takes: {}, both: {}, steals: {}, failed: {}, smited: 0, flashIn: 0 } };
    e.mods.objsmite = s;
  }
  return s;
}
export const stats = (e: Engine): StealStats => st(e).stats;
const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
const reflexOf = (u: Unit) => u.reflex ?? REFLEX_REF;
const nm = (u: Unit) => `${u.name}(${u.champ.name})`;

/** The damage each side put on monster k this step. */
export function dealt(e: Engine, k: ObjKey, bySide: number[]): void {
  const S = st(e);
  const o = e.obj[k];
  // back at full health: whoever hit it before no longer owns it
  if (!S.dmg[k] || o.hp >= o.maxHp * 0.995) S.dmg[k] = [0, 0];
  S.dmg[k][0] += bySide[0];
  S.dmg[k][1] += bySide[1];
  if (bySide[0] + bySide[1] > 0) {
    S.last[k] = e.t;
    S.rate[k] = (bySide[0] + bySide[1]) / 0.25;
  }
}

/** Seconds until monster k's health is inside `dmg` at the rate it is being hit now; Infinity while nobody hits it. */
export function secondsTo(e: Engine, k: ObjKey, dmg: number): number {
  const S = st(e);
  if (e.t - (S.last[k] ?? -99) > 0.6 || !(S.rate[k] > 0)) return Infinity;
  return Math.max(0, e.obj[k].hp - dmg) / S.rate[k];
}

/** The side doing monster k (most of the damage so far); null when nobody has hit it since it was at full health. */
export function ownerOf(e: Engine, k: ObjKey): SideN | null {
  const d = st(e).dmg[k];
  if (!d || d[0] + d[1] <= 0) return null;
  return d[0] >= d[1] ? 0 : 1;
}

function pPress(e: Engine, u: Unit, thief: boolean): number {
  let p = STEAL_TUNE.react + (reflexOf(u) - REFLEX_REF) * STEAL_TUNE.reactSkill;
  if (thief) p *= STEAL_TUNE.thief;
  let hit = false;
  for (const t of u.lastHitBy.values()) if (e.t - t < 1.5) { hit = true; break; }
  if (u.fightId !== 0 || hit) p *= STEAL_TUNE.busy;
  return Math.min(0.92, Math.max(0.12, p));
}

export interface Finish { side: SideN; taker: Unit; steal: boolean; smote: boolean }

/**
 * The last hit on monster k this step, or null while it lives. `at`: the champions hitting it this step (may be
 * empty: everybody is fighting), `bySide`: their damage per second by side. On a Smite the monster's health is taken
 * down by the caller's Summoners.smite; the caller (engine.objectivesTick) draws the effect and calls secure().
 */
export function finish(e: Engine, k: ObjKey, at: Unit[], bySide: number[]): Finish | null {
  const o = e.obj[k];
  const S = st(e);
  const own = ownerOf(e, k);
  // nobody has hit it, or it was left a while ago: nothing to finish
  if (own === null || (o.hp > 0 && e.t - (S.last[k] ?? -99) > 10)) return null;
  const thiefSide = (1 - own) as SideN;
  const near = (side: SideN, reach: number) => e.units.find((u) => u.side === side && u.role === "Jungle" && u.alive && dist(u, o.pos) < reach);
  // a steal runner just outside the reach flashes in when the monster is about to drop into its Smite
  const runner = near(thiefSide, STEAL_TUNE.range + STEAL_TUNE.flashIn);
  if (runner && dist(runner, o.pos) >= STEAL_TUNE.range && e.t >= runner.stunUntil && Summoners.canSmite(e, runner) && Macro.stealing(e, runner, k) &&
    o.hp <= Summoners.smiteDamage(e, runner) * STEAL_TUNE.flashAt && e.flashToward(runner, o.pos, "engage", STEAL_TUNE.range - 150)) S.stats.flashIn++;
  const ready = (side: SideN) => {
    const u = near(side, STEAL_TUNE.range);
    return u && e.t >= u.stunUntil && Summoners.canSmite(e, u) ? u : undefined;
  };
  const jo = ready(own), jt = ready(thiefSide);
  const inside = (u: Unit | undefined) => !!u && o.hp <= Summoners.smiteDamage(e, u);
  const pressO = inside(jo) && e.rng.chance(pPress(e, jo!, false));
  const pressT = inside(jt) && e.rng.chance(pPress(e, jt!, true));
  let winner: Unit | undefined;
  if (pressO && pressT) {
    // both in the same quarter second: the owner's team controls the damage, the thief needs the faster hands
    const pT = Math.min(0.7, Math.max(0.08, STEAL_TUNE.tie + (reflexOf(jt!) - reflexOf(jo!)) * STEAL_TUNE.tieSkill));
    winner = e.rng.chance(pT) ? jt : jo;
    const loser = winner === jt ? jo! : jt!;
    // the loser's Smite lands on nothing: the charge is gone and its effect shows (two Smites on screen)
    Summoners.spend(e, loser, "smite", { at: o.pos, why: "lost", pve: true });
  } else winner = pressO ? jo : pressT ? jt : undefined;
  let side: SideN, taker: Unit, smote = false;
  if (winner) {
    side = winner.side;
    taker = winner;
    smote = true;
  } else {
    if (o.hp > 0) return null;
    // no Smite: the team's damage finishes it; with both sides hitting, the last hit follows the damage
    const tot = bySide[0] + bySide[1];
    side = tot > 0 && bySide[0] > 0 && bySide[1] > 0 ? (e.rng.chance(bySide[0] / tot) ? 0 : 1) : tot > 0 ? (bySide[0] > 0 ? 0 : 1) : own;
    taker = at.find((u) => u.side === side) ?? near(side, 900) ?? at[0] ?? e.units.find((u) => u.side === side && u.alive) ?? e.units[side * 5];
  }
  const d = S.dmg[k];
  const share = d[side] / Math.max(1, d[0] + d[1]);
  const steal = side !== own && share < STEAL_TUNE.stolenShare;
  bump(S.stats.takes, k);
  if (smote) S.stats.smited++;
  if (jo && jt) bump(S.stats.both, k);
  if (steal) bump(S.stats.steals, k);
  else if (jt && side === own) {
    // a jungler stood in reach with a Smite and did not get it: a failed steal
    bump(S.stats.failed, k);
    e.event("info", own, `${josa(nm(taker), "이가")} ${josa(OBJ_KO[k], "을를")} 지켰습니다 · ${nm(jt)} 스틸 실패`, false);
  }
  S.dmg[k] = [0, 0];
  return { side, taker, steal, smote };
}
