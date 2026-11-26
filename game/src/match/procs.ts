// Combat effects on top of the plain stats (owner: combat-stats session): item passives and actives, keystone runes,
// summoner spells and champion passives. Each one is an Effect (procs-lib.ts) with optional hooks; a unit's list is
// rebuilt when its items or keystone change. fight.ts calls the hooks below from basicAttack, landHits, spend, hurt,
// applyCC, supportOn and combat, passing `deal` so effect damage goes through its own hurt() (kill credit, saves).
//
// Time model: the engine steps every 0.25 s and basic attacks are a damage-per-second stream, so "every 3rd attack"
// counts fractional attacks (attack speed x step), "once per N seconds" uses internal cooldowns, and damage over time
// ticks in tick().
import type { Engine, Unit } from "./engine";
import * as Stats from "./stats";
import type { UStats } from "./stats";
import { ctx, healMul, markCombat, setBuilder, shieldLeft, shieldMul, state, heal } from "./procs-lib";
import type { Deal, Effect, Kind } from "./procs-lib";
import { ITEM_FX } from "./itemfx";
import { RUNE_FX } from "./runes";
import { PASSIVE_FX } from "./passives";
import { summonerFx } from "./summoners";

export type { Deal, Kind } from "./procs-lib";

/** Switch for the whole module (scripts can turn it off to compare). */
export const PROC_FLAGS = { items: true, runes: true, summoners: true, passives: true };

setBuilder((e, u, items, keystone) => {
  const out: Effect[] = [];
  if (PROC_FLAGS.passives) out.push(...(PASSIVE_FX[u.champ.id] ?? []));
  if (PROC_FLAGS.runes && keystone != null && RUNE_FX[keystone]) out.push(RUNE_FX[keystone]);
  if (PROC_FLAGS.items) {
    const seen = new Set<number>();
    for (const id of items) {
      if (seen.has(id)) continue; // unique passives count once
      seen.add(id);
      out.push(...(ITEM_FX[id] ?? []));
    }
  }
  if (PROC_FLAGS.summoners) out.push(...summonerFx(e, u));
  return out;
});

/** Dynamic stat changes: this unit's effects, then timed buffs / debuffs others put on it (procs-lib buff()). */
export function statMods(e: Engine, u: Unit, s: UStats) {
  const p = state(e, u);
  for (const f of p.effects) f.stats?.(e, u, p, s);
  const b = (name: string) => ((p.until[name] ?? -1) > e.t ? p.n[name] ?? 0 : 0);
  const as = b("asBuff");
  if (as) s.as = Math.min(2.5, s.as + Stats.champStats(u.champ.id).asr * as / 100);
  const slow = b("asSlow");
  if (slow) s.as *= 1 - slow;
  s.ap += b("apBuff");
  const ad = b("adBuff");
  s.ad += ad;
  s.bad += ad;
  const res = b("resBuff");
  if (res) { s.ar += s.bar * res; s.mr += s.bmr * res; }
  s.ar *= 1 - b("arDown");
  s.mr = s.mr * (1 - b("mrDown")) - b("mrFlat");
  s.ov += b("ovBuff");
}
Stats.setStatMods(statMods);

export function onAttack(e: Engine, u: Unit, t: Unit, n: number, deal: Deal) {
  if (n <= 0) return;
  const c = ctx(e, u, deal);
  markCombat(e, u, t);
  // Ardent Censer's bonus on-hit magic damage from an ally's heal / shield
  const oh = (c.p.until.onHitM ?? -1) > e.t ? c.p.n.onHitM ?? 0 : 0;
  if (oh > 0) {
    const amt = Stats.mitigate(e, u, t, { p: 0, m: oh * n, t: 0 });
    if (amt > 0) deal(u, t, amt, "proc");
  }
  for (const f of c.p.effects) f.attack?.(c, t, n);
}

export function onCast(e: Engine, u: Unit, k: number, deal: Deal) {
  const c = ctx(e, u, deal);
  c.p.until.spellblade = e.t + 10;
  for (const f of c.p.effects) f.cast?.(c, k);
}

export function onSpellHit(e: Engine, u: Unit, v: Unit, k: number, deal: Deal) {
  const c = ctx(e, u, deal);
  markCombat(e, u, v);
  for (const f of c.p.effects) f.spellHit?.(c, v, k);
}

/** Spell shields (Banshee's Veil, Edge of Night): true = this spell is blocked. */
export function spellShield(e: Engine, v: Unit): boolean {
  const p = state(e, v);
  if (!p.effects.some((f) => f.id === "spellshield")) return false;
  if ((p.cd.spellshield ?? -1) > e.t) return false;
  p.cd.spellshield = e.t + 40;
  return true;
}

/** Damage src -> v about to land (after armor / magic resist): multipliers, shields, storing. Returns what lands. */
export function incoming(e: Engine, src: Unit | null, v: Unit, amount: number, kind: Kind, deal: Deal): number {
  if (amount <= 0) return 0;
  const pv = state(e, v);
  const on = (name: string) => ((pv.until[name] ?? -1) > e.t ? pv.n[name] ?? 0 : 0);
  if (on("stasis")) return 0;
  let a = amount;
  if (kind === "raw") {
    // already final: only the victim's own lifelines / saves still see it
    const cv = ctx(e, v, deal);
    for (const f of cv.p.effects) if (f.hurt) a = f.hurt(cv, src, a, kind);
    return Math.max(0, a);
  }
  if (src) {
    const c = ctx(e, src, deal);
    for (const f of c.p.effects) if (f.out) a *= f.out(c, v, kind);
    markCombat(e, src, v);
    const ps = c.p;
    // the attacker is weakened (Exhaust, Glacial Augment)
    if ((ps.until.weaken ?? -1) > e.t) a *= 1 - (ps.n.weaken ?? 0);
    // Imperial Mandate: the holder's team consumes the mark for 10 % current health magic damage
    const mark = on("mandate");
    if (mark && mark === src.side + 1 && (pv.cd.mandate ?? -1) <= e.t) {
      pv.cd.mandate = e.t + 9;
      a += Stats.mitigate(e, src, v, { p: 0, m: v.hp * 0.1, t: 0 });
    }
  }
  a *= 1 + on("expose");
  // Abyssal Mask: magic damage only (the attacker's damage type stands in for this hit's)
  const abyss = on("abyss");
  if (abyss && src) a *= 1 + abyss * (src.champ.damage === "AP" ? 1 : src.champ.damage === "Mixed" ? 0.5 : 0);
  // Knight's Vow: 12 % goes to the vow holder instead
  const vow = on("vow");
  if (vow && kind !== "dot") {
    const holder = e.units[vow - 1];
    if (holder?.alive) {
      deal(null, holder, a * 0.12, "raw");
      a *= 0.88;
    }
  }
  const cv = ctx(e, v, deal);
  for (const f of cv.p.effects) if (f.inc) a *= f.inc(cv, src, kind);
  for (const f of cv.p.effects) if (f.hurt) a = f.hurt(cv, src, a, kind);
  return Math.max(0, a);
}

/** v would die from this hit: true when an effect prevents it. */
export function onLethal(e: Engine, v: Unit, src: Unit | null, deal: Deal): boolean {
  const c = ctx(e, v, deal);
  for (const f of c.p.effects) if (f.lethal?.(c, src)) return true;
  return false;
}

/** Test tap: every champion damage that went through fight.ts hurt() with real numbers (scripts/combat-check.ts). */
let dealtTap: ((src: Unit | null, v: Unit, amount: number, kind: Kind) => void) | null = null;
export function setDealtTap(f: typeof dealtTap) {
  dealtTap = f;
}

/** After src dealt damage to v: life steal, omnivamp, healing riders. */
export function onDealt(e: Engine, src: Unit | null, v: Unit, amount: number, kind: Kind, deal: Deal) {
  dealtTap?.(src, v, amount, kind);
  if (!src || amount <= 0 || src.side === v.side || kind === "raw") return;
  const s = Stats.stats(e, src);
  const vamp = s.ov * (kind === "aa" || kind === "spell" ? 1 : 0.33) + (kind === "aa" ? s.ls : 0);
  if (vamp > 0) heal(e, src, amount * vamp);
  const c = ctx(e, src, deal);
  for (const f of c.p.effects) f.dealt?.(c, v, amount, kind);
}

/** Crowd control duration reduction on v (largest source; Cleanse adds 65 % for 3 s). */
export function tenacity(e: Engine, v: Unit): number {
  const p = state(e, v);
  let t = 0;
  for (const f of p.effects) t = Math.max(t, f.tenacity ?? 0);
  if ((p.until.cleanse ?? -1) > e.t) t = Math.max(t, 0.65);
  return t;
}

export function onCC(e: Engine, src: Unit, v: Unit, type: string, dur: number, deal: Deal) {
  const c = ctx(e, src, deal);
  markCombat(e, src, v);
  for (const f of c.p.effects) f.cc?.(c, v, type, dur);
}

/** src healed (isShield false) / shielded ally by amount: the amount after support items (Moonstone, Helia ...)
 *  and what the ally receives (Grievous Wounds cuts heals, Serpent's Fang shields, Spirit Visage raises both). */
export function onSupport(e: Engine, src: Unit, ally: Unit, amount: number, deal: Deal, isShield: boolean): number {
  const c = ctx(e, src, deal);
  let a = amount; // heal and shield power is in the amount already (stats.supportAmount)
  for (const f of c.p.effects) {
    const r = f.support?.(c, ally, a);
    if (typeof r === "number") a = r;
  }
  return a * (isShield ? shieldMul(e, ally) : healMul(e, ally));
}
/** Heals / shields a unit gives itself. */
export function selfSupport(e: Engine, u: Unit, amount: number, isShield: boolean): number {
  return amount * (isShield ? shieldMul(e, u) : healMul(e, u));
}

/** Once per engine step: deaths (takedown effects), damage over time, expiring shields, auras, item actives,
 *  summoner spells. */
export function tick(e: Engine, dt: number, deal: Deal) {
  for (const v of e.units) {
    const pv = state(e, v);
    if (pv.wasAlive && !v.alive) {
      for (const u of e.units) {
        if (u.side === v.side || !u.alive) continue;
        const c = ctx(e, u, deal);
        const t = v.lastHitBy.get(u.i);
        if (t !== undefined && e.t - t <= 3) for (const f of c.p.effects) f.takedown?.(c, v);
        if (Math.hypot(u.x - v.x, u.y - v.y) <= 1000) for (const f of c.p.effects) f.nearbyDeath?.(c, v);
      }
      // per-life state: timed buffs / debuffs end, damage over time and stored damage are dropped
      const cv = ctx(e, v, deal);
      for (const f of cv.p.effects) f.death?.(cv);
      pv.until = {};
      pv.dots = [];
      pv.stored = 0;
    }
    pv.wasAlive = v.alive;
  }
  for (const u of e.units) {
    const p = state(e, u);
    if (p.shields.length) {
      p.shields = p.shields.filter((sh) => {
        if (sh.until > e.t && u.alive) return true;
        // only what this shield still holds goes away (fight.ts upkeep does the same)
        u.shield = Math.max(0, u.shield - (u.alive ? shieldLeft(e, u, sh) : sh.amt));
        return false;
      });
    }
    if (!u.alive) {
      p.dots = [];
      p.stored = 0;
      continue;
    }
    if (p.dots.length) {
      p.dots = p.dots.filter((d) => d.until > e.t);
      for (const d of p.dots) if (u.alive) deal(e.units[d.src] ?? null, u, d.perSec * dt, "dot");
    }
    if (p.stored > 0 && u.alive) {
      // Death's Dance: a third of what is stored, per second
      const take = Math.min(p.stored, Math.max(20, p.stored / 3) * dt);
      p.stored -= take;
      // stored after every multiplier: released as is
      deal(p.storedSrc >= 0 ? e.units[p.storedSrc] : null, u, take, "raw");
    }
    if (!u.alive) continue;
    const c = { e, u, p, deal };
    for (const f of p.effects) f.tick?.(c, dt);
  }
}

/** Effects a unit has right now (HUD / tests). */
export function effectsOf(e: Engine, u: Unit): string[] {
  return state(e, u).effects.map((f) => f.id);
}
