// Shared state and helpers for combat effects (owner: combat-stats session). Effect tables (itemfx.ts, runes.ts,
// passives.ts, summoners.ts) import only this file; procs.ts registers how a unit's effect list is built, so there is
// no import cycle between the tables and the hooks.
import type { Engine, Unit } from "./engine";
import * as Stats from "./stats";
import type { Dmg, UStats } from "./stats";
import * as Items from "./items";

/** raw = already final (Death's Dance release, Knight's Vow share): no amplifiers, no life steal / riders again. */
export type Kind = "aa" | "spell" | "proc" | "dot" | "raw";
/** Applies already-mitigated damage through fight.ts hurt(). */
export type Deal = (src: Unit | null, v: Unit, amount: number, kind: Kind) => void;

export interface PState {
  /** internal cooldowns: key -> time it is ready again */
  cd: Record<string, number>;
  /** buff / debuff end times */
  until: Record<string, number>;
  /** generic counters (stacks, souls ...) */
  n: Record<string, number>;
  /** per target and key: fractional attack count for "every Nth attack" */
  atk: Map<string, number>;
  /** shields this module added: removed when they expire */
  shields: { amt: number; until: number }[];
  /** damage over time on this unit */
  dots: { src: number; perSec: number; until: number; key?: string }[];
  /** Death's Dance: damage stored to be taken as true damage over 3 s */
  stored: number;
  storedSrc: number;
  /** first and last moment in combat with champions */
  combatFrom: number;
  combatLast: number;
  /** alive at the last tick (death / respawn detection) */
  wasAlive: boolean;
  effects: Effect[];
  key: string;
}

export interface Ctx { e: Engine; u: Unit; p: PState; deal: Deal }

export interface Effect {
  id: string;
  /** dynamic stat changes, in place (called on every stats read) */
  stats?(e: Engine, u: Unit, p: PState, s: UStats): void;
  /** n basic attacks landed on t this step (fractional) */
  attack?(c: Ctx, t: Unit, n: number): void;
  cast?(c: Ctx, k: number): void;
  spellHit?(c: Ctx, v: Unit, k: number): void;
  /** multiplier on damage this unit deals to v */
  out?(c: Ctx, v: Unit, kind: Kind): number;
  /** multiplier on damage this unit takes */
  inc?(c: Ctx, src: Unit | null, kind: Kind): number;
  /** damage about to hit this unit after multipliers: return what still lands (shields, storing) */
  hurt?(c: Ctx, src: Unit | null, amount: number, kind: Kind): number;
  /** this unit would die: true = prevented (the effect sets hp / stasis itself) */
  lethal?(c: Ctx, src: Unit | null): boolean;
  /** after this unit dealt damage */
  dealt?(c: Ctx, v: Unit, amount: number, kind: Kind): void;
  /** this unit applied crowd control */
  cc?(c: Ctx, v: Unit, type: string, dur: number): void;
  /** this unit healed / shielded an ally: may return a changed amount */
  support?(c: Ctx, ally: Unit, amount: number): number | void;
  /** an enemy champion this unit damaged in the last 3 s died (takedown) */
  takedown?(c: Ctx, v: Unit): void;
  /** any enemy champion within 1000 died (Trundle, Cho'Gath) */
  nearbyDeath?(c: Ctx, v: Unit): void;
  /** this unit died (per-life state resets; timed buffs are cleared for it) */
  death?(c: Ctx): void;
  tick?(c: Ctx, dt: number): void;
  /** heals and shields received x (1 + healIn) */
  healIn?: number;
  /** crowd control duration reduction 0..1 (largest one counts) */
  tenacity?: number;
}

// ---------- crowd control from effects ----------
/** fight.ts registers how an effect applies crowd control (its applyCC); no-op until then. */
type CCHook = (e: Engine, src: Unit, v: Unit, type: string, dur: number) => void;
let ccHook: CCHook = () => {};
export function setCCHook(h: CCHook) {
  ccHook = h;
}
export function applyCC(c: Ctx, v: Unit, type: string, dur: number) {
  if (v.alive) ccHook(c.e, c.u, v, type, dur);
}

// ---------- state ----------
type Builder = (e: Engine, u: Unit, items: number[], keystone: number | null) => Effect[];
let builder: Builder = () => [];
export function setBuilder(b: Builder) {
  builder = b;
}

const states = new WeakMap<Engine, PState[]>();

export function state(e: Engine, u: Unit): PState {
  let list = states.get(e);
  if (!list) states.set(e, (list = []));
  let p = list[u.i];
  if (!p) {
    p = list[u.i] = { cd: {}, until: {}, n: {}, atk: new Map(), shields: [], dots: [], stored: 0, storedSrc: -1, combatFrom: -99, combatLast: -99, wasAlive: true, effects: [], key: "" };
  }
  // cheap key: the next item on the purchase path moves exactly when an item is finished (the keystone is fixed)
  const pend = Items.pending(e, u);
  const key = pend ? String(pend.next ?? "full") : "-";
  if (p.key !== key) {
    const owned = Items.unitItems(e, u);
    p.key = key;
    p.effects = builder(e, u, owned?.items ?? [], owned?.keystone ?? null);
  }
  return p;
}

export const ctx = (e: Engine, u: Unit, deal: Deal): Ctx => ({ e, u, p: state(e, u), deal });

// ---------- helpers ----------
/** Linear by level 1..18. */
export const byLevel = (u: Unit, a: number, b: number) => a + (b - a) * (Math.max(1, Math.min(18, u.level)) - 1) / 17;
export const ready = (c: Ctx, key: string) => (c.p.cd[key] ?? -1) <= c.e.t;
export const use = (c: Ctx, key: string, cd: number) => (c.p.cd[key] = c.e.t + cd);
export const active = (c: Ctx, key: string) => (c.p.until[key] ?? -1) > c.e.t;
export const inCombat = (c: Ctx) => c.e.t - c.p.combatLast < 3;
/** Seconds since this unit entered combat with champions (0 when out of combat). */
export const combatTime = (c: Ctx) => (inCombat(c) ? c.e.t - c.p.combatFrom : 0);
export const isMelee = (u: Unit) => !u.champ.ranged;
export const hpF = (u: Unit) => u.hp / Math.max(1, u.maxHp);
export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Adaptive damage type: physical when bonus AD outweighs AP (LoL's adaptive force). */
export function adaptive(e: Engine, u: Unit, amount: number): Dmg {
  const s = Stats.stats(e, u);
  const phys = s.bad > s.ap * 0.6 || (s.ap === 0 && s.bad === 0 && u.champ.damage !== "AP");
  return phys ? { p: amount, m: 0, t: 0 } : { p: 0, m: amount, t: 0 };
}
export const P = (v: number): Dmg => ({ p: v, m: 0, t: 0 });
export const M = (v: number): Dmg => ({ p: 0, m: v, t: 0 });
export const T = (v: number): Dmg => ({ p: 0, m: 0, t: v });

/** Deal pre-mitigation damage from an effect (mitigated by the victim's armor / magic resist). */
export function hit(c: Ctx, v: Unit, d: Dmg, kind: Kind = "proc") {
  if (!v.alive) return;
  const amt = Stats.mitigate(c.e, c.u, v, d);
  if (amt > 0) c.deal(c.u, v, amt, kind);
}
/** Heals and shields on u: Grievous Wounds -40 %, Spirit Visage +25 % ... */
export function healMul(e: Engine, u: Unit): number {
  const p = state(e, u);
  let m = 1;
  for (const f of p.effects) if (f.healIn) m += f.healIn;
  if ((p.until.gw ?? -1) > e.t) m *= 0.6;
  return m;
}
/** Shields on u: Spirit Visage +25 %, Serpent's Fang venom -50 / 35 % (Grievous Wounds does not cut shields). */
export function shieldMul(e: Engine, u: Unit): number {
  const p = state(e, u);
  let m = 1;
  for (const f of p.effects) if (f.healIn) m += f.healIn;
  if ((p.until.venom ?? -1) > e.t) m *= 1 - (p.n.venom ?? 0);
  return m;
}
export function heal(e: Engine, u: Unit, amount: number) {
  if (!u.alive || amount <= 0) return;
  u.hp = Math.min(u.maxHp, u.hp + amount * healMul(e, u));
}
export function shield(e: Engine, u: Unit, amount: number, dur: number) {
  if (!u.alive || amount <= 0) return;
  const amt = amount * shieldMul(e, u);
  u.shield += amt;
  state(e, u).shields.push({ amt, until: e.t + dur });
}

// ---------- shield bookkeeping shared with fight.ts ----------
type ShieldList = { amt: number; until: number }[];
let fightShields: (e: Engine, u: Unit) => ShieldList = () => [];
/** fight.ts registers its own per-unit shield list so expiring shields here and there see each other. */
export function setFightShields(f: (e: Engine, u: Unit) => ShieldList) {
  fightShields = f;
}
/**
 * What is left of a shield that expires now. Shields absorb in expiry order, so the one ending now took damage
 * first: it keeps whatever the pool holds beyond the other live shields' full amounts.
 */
export function shieldLeft(e: Engine, u: Unit, sh: { amt: number; until: number }): number {
  let others = 0;
  for (const x of fightShields(e, u)) if (x !== sh && x.until > e.t) others += x.amt;
  for (const x of state(e, u).shields) if (x !== sh && x.until > e.t) others += x.amt;
  return Math.max(0, Math.min(sh.amt, u.shield - others));
}
/** In a save that blocks all damage (Guardian Angel, Zhonya's, Sion, Anivia): cleanses must not end it. */
export function inStasis(e: Engine, u: Unit): boolean {
  const p = state(e, u);
  return (p.until.stasis ?? -1) > e.t || (p.until.egg ?? -1) > e.t;
}
export function grievous(e: Engine, v: Unit, dur = 3) {
  const p = state(e, v);
  p.until.gw = Math.max(p.until.gw ?? -1, e.t + dur);
}
/** Damage over time from c.u on v: total pre-mitigation damage over dur seconds. A keyed burn refreshes. */
export function dot(c: Ctx, v: Unit, total: Dmg, dur: number, key?: string) {
  if (!v.alive || dur <= 0) return;
  const ps = state(c.e, v);
  const perSec = Stats.mitigate(c.e, c.u, v, total) / dur;
  if (key) {
    const old = ps.dots.find((d) => d.src === c.u.i && d.key === key);
    if (old) {
      old.perSec = Math.max(old.perSec, perSec);
      old.until = c.e.t + dur;
      return;
    }
  }
  ps.dots.push({ src: c.u.i, perSec, until: c.e.t + dur, key });
}
/** Living enemies of u within r of `at`. */
export function foesNear(e: Engine, u: Unit, r: number, at: { x: number; y: number } = u): Unit[] {
  return e.units.filter((x) => x.alive && x.side !== u.side && dist(x, at) <= r);
}
export function alliesNear(e: Engine, u: Unit, r: number): Unit[] {
  return e.units.filter((x) => x.alive && x.side === u.side && dist(x, u) <= r);
}

/** "Every Nth attack": add n (fractional) attacks on t, return how many procs completed. */
export function nth(c: Ctx, t: Unit, n: number, every: number, key: string): number {
  const k = `${key}:${t.i}`;
  const v = (c.p.atk.get(k) ?? 0) + n;
  const procs = Math.floor(v / every);
  c.p.atk.set(k, v - procs * every);
  return procs;
}

/** Hits on t within a window (fractional attacks count as their share): returns the running count. */
export function hitCount(c: Ctx, t: Unit, add: number, window: number, key: string): number {
  const k = `${key}:${t.i}`, kl = `${key}@${t.i}`;
  if (c.e.t - (c.p.n[kl] ?? -99) > window) c.p.n[k] = 0;
  c.p.n[k] = (c.p.n[k] ?? 0) + add;
  c.p.n[kl] = c.e.t;
  return c.p.n[k];
}
export function resetHits(c: Ctx, t: Unit, key: string) {
  c.p.n[`${key}:${t.i}`] = 0;
}

/**
 * Timed buff / debuff on any unit, read by procs.ts (stats and damage taken). The strongest value counts.
 *  asBuff   bonus attack speed %          apBuff / adBuff  flat AP / bonus AD
 *  arDown   armor reduction 0..1          mrDown           magic resist reduction 0..1     mrFlat  flat MR loss
 *  asSlow   attack speed x (1 - value)    expose           damage taken x (1 + value)
 *  abyss    magic damage taken x (1 + value)               stasis  untouchable (damage taken x 0)
 *  onHitM   bonus magic damage per attack  (Ardent Censer)
 */
export function buff(e: Engine, u: Unit, name: string, value: number, dur: number) {
  const p = state(e, u);
  const live = (p.until[name] ?? -1) > e.t;
  p.n[name] = live ? Math.max(p.n[name] ?? 0, value) : value;
  p.until[name] = Math.max(live ? p.until[name] : -1, e.t + dur);
}
export function buffOf(e: Engine, u: Unit, name: string): number {
  const p = state(e, u);
  return (p.until[name] ?? -1) > e.t ? p.n[name] ?? 0 : 0;
}

export function markCombat(e: Engine, a: Unit, b: Unit) {
  for (const u of [a, b]) {
    const p = state(e, u);
    if (e.t - p.combatLast > 3) p.combatFrom = e.t;
    p.combatLast = e.t;
  }
}
