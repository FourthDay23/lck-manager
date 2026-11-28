// Real LoL combat numbers for the fight engine (owner: combat-stats session).
// Data: spells.gen.ts (scripts/build_spells.py from Meraki + Data Dragon). Items: what the unit owns (items.ts).
//
// - Champion stats grow per level as in LoL: base + growth * (n - 1) * (0.7025 + 0.0175 * (n - 1)).
// - Attack speed = base + ratio * bonus% / 100 (bonus = per-level growth + items), capped at 2.5.
// - A basic attack's damage per second = AD * attack speed * (1 + crit chance * (crit damage - 1)).
// - Spell damage per cast = sum of its parts: flat + AP / AD / bonus AD / health / armor ratios, target health %.
//   Ranks follow a standard skill order (R at 6 / 11 / 16, the main damage spell maxed first).
// - Mitigation: physical by armor, magic by magic resist, 100 / (100 + resist) after penetration
//   (armor: % penetration, then lethality as flat; magic: % penetration, then flat).
// - Ability haste: cooldown * 100 / (100 + haste).
// The engine keeps its own multipliers on top (player skill, champion timing, baron / elder / soul, build edge).
import type { Engine, Unit } from "./engine";
import * as Items from "./items";
import type { ItemStats } from "./items";
import { CHAMP_STATS, ITEM_EXTRAS, SPELLS } from "./spells.gen";
import type { ChampStats, Grow, Part, SpellStat, Term } from "./spells.gen";

export interface UStats {
  level: number;
  hp: number;
  /** health from items */
  bhp: number;
  ad: number;
  bad: number;
  ap: number;
  ar: number;
  bar: number;
  mr: number;
  bmr: number;
  mana: number;
  /** attacks per second */
  as: number;
  /** crit chance 0..1 and crit damage multiplier (1.75 = 175 %) */
  crit: number;
  critDmg: number;
  leth: number;
  /** % penetration 0..1 */
  apen: number;
  mpen: number;
  mpenPct: number;
  haste: number;
  /** extra haste for the ultimate / basic abilities only (Night Vigil, Shojin ...) */
  ultHaste: number;
  basicHaste: number;
  /** life steal / omnivamp / heal and shield power, 0..1 */
  ls: number;
  ov: number;
  hsp: number;
}

/** Dynamic stat changes (procs.ts registers: item passives, runes, champion passives, buffs and debuffs). */
type StatMods = (e: Engine, u: Unit, s: UStats) => void;
let statMods: StatMods | null = null;
export function setStatMods(f: StatMods) {
  statMods = f;
}

/** Pre-mitigation damage by type. */
export interface Dmg { p: number; m: number; t: number }

/** real: the engine uses these numbers (engine.realStats(); also needs items.json). Scripts can turn it off. */
export const STATS_FLAGS = { real: true };

const AS_CAP = 2.5;
const DEFAULT: ChampStats = { hp: [620, 105], ad: [60, 3.2], ar: [30, 4.6], mr: [30, 1.6], mana: [300, 50], as: 0.65, asr: 0.65, asg: 2, crit: 175, ms: 335 };

const growth = (n: number) => (n - 1) * (0.7025 + 0.0175 * (n - 1));
const at = (g: Grow, n: number) => g[0] + g[1] * growth(n);

export function champStats(id: string): ChampStats {
  return CHAMP_STATS[id] ?? DEFAULT;
}
export function spellStats(id: string): SpellStat[] | null {
  return SPELLS[id] ?? null;
}

// ---------- items ----------
function itemSums(e: Engine, u: Unit): { s: Required<ItemStats>; x: Required<NonNullable<(typeof ITEM_EXTRAS)[string]>>; key: string } {
  const s: Required<ItemStats> = { ad: 0, ap: 0, hp: 0, armor: 0, mr: 0, as: 0, crit: 0, haste: 0, leth: 0, mpen: 0, ms: 0 };
  const x = { apen: 0, mpenPct: 0, critDmg: 0, apAmp: 0, ls: 0, ov: 0, hsp: 0 };
  const owned = Items.unitItems(e, u);
  if (!owned) return { s, x, key: "" };
  for (const id of owned.items) {
    const it = owned.data.items[String(id)];
    if (!it) continue;
    for (const k of Object.keys(it.stats) as (keyof ItemStats)[]) s[k] += it.stats[k] ?? 0;
    const ex = ITEM_EXTRAS[String(id)];
    if (ex) {
      // % penetration from two items stacks multiplicatively in LoL; the rest adds
      if (ex.apen) x.apen = 100 - (100 - x.apen) * (1 - ex.apen / 100);
      if (ex.mpenPct) x.mpenPct = 100 - (100 - x.mpenPct) * (1 - ex.mpenPct / 100);
      x.critDmg += ex.critDmg ?? 0;
      x.apAmp += ex.apAmp ?? 0;
      x.ls += ex.ls ?? 0;
      x.ov += ex.ov ?? 0;
      x.hsp += ex.hsp ?? 0;
    }
  }
  // Gold already spent toward the next item (its components, items.ts pending()): that item's plain stats in
  // proportion, at 80 % (components are less gold-efficient; their stats, not the finished item's passive).
  let partKey = "";
  const pend = Items.pending(e, u);
  if (pend && pend.next != null) {
    const it = owned.data.items[String(pend.next)];
    if (it && it.cost > 0 && pend.spent > 0) {
      const f = Math.min(1, pend.spent / it.cost) * 0.8;
      for (const k of Object.keys(it.stats) as (keyof ItemStats)[]) s[k] += (it.stats[k] ?? 0) * f;
      partKey = `+${pend.next}:${Math.round(f * 20)}`;
    }
  }
  // What every player has besides bought items: rune stat shards (adaptive force 9 + 9, health 65: the usual LCK
  // pick) and the lane starter (Doran's) until four items fill the inventory. Jungle and support starters have no
  // combat stats.
  const physical = u.champ.damage !== "AP";
  if (physical) s.ad += 10.8;
  else s.ap += 18;
  s.hp += 65;
  if (owned.items.length < 4 && u.role !== "Jungle" && u.role !== "Support") {
    if (u.champ.damage === "AP") { s.ap += 18; s.hp += 90; }
    else if (u.champ.tags[0] === "Tank") s.hp += 110;
    else { s.ad += 8; s.hp += 80; }
  }
  return { s, x, key: owned.items.join(",") + partKey };
}

// ---------- unit stats (cached per level + owned items) ----------
/** Key of the cached stats: level, then kind 0 = no item data, 1 = full build, 2 = next item `next`, `part`/20 of it
 *  bought (the same cases as a "level|next:part" string, without building one at every read). */
interface Cache { lvl: number; kind: number; next: number; part: number; st: UStats }
const caches = new WeakMap<Engine, Cache[]>();

interface Memo { t: number; base: UStats; st: UStats }
const memos = new WeakMap<Engine, Memo[]>();

/**
 * A unit's stats now: level and items (cached), then the dynamic changes of its effects and buffs, worked out once
 * per engine step (a buff that starts mid-step counts from the next one, 0.25 s later). A level-up or purchase
 * mid-step makes a new base, so it shows at once.
 */
export function stats(e: Engine, u: Unit): UStats {
  const base = baseStats(e, u);
  if (!statMods) return base;
  let list = memos.get(e);
  if (!list) memos.set(e, (list = []));
  const m = list[u.i];
  if (m && m.t === e.t && m.base === base) return m.st;
  const s = { ...base };
  statMods(e, u, s);
  list[u.i] = { t: e.t, base, st: s };
  return s;
}

/** Stats from level and items only. */
export function baseStats(e: Engine, u: Unit): UStats {
  let list = caches.get(e);
  if (!list) caches.set(e, (list = []));
  // cheap key: level, the next item on the path, how far its components are
  const pend = Items.pending(e, u);
  const kind = !pend ? 0 : pend.next == null ? 1 : 2;
  let next = 0, part = 0;
  if (pend && pend.next != null) {
    next = pend.next;
    const cost = e.data.items?.items[String(pend.next)]?.cost ?? 0;
    part = cost > 0 ? Math.round(Math.min(1, pend.spent / cost) * 20) : 0;
  }
  const hit = list[u.i];
  if (hit && hit.lvl === u.level && hit.kind === kind && hit.next === next && hit.part === part) return hit.st;
  const items = itemSums(e, u);
  const c = champStats(u.champ.id);
  const n = Math.max(1, Math.min(18, u.level));
  const { s, x } = items;
  const baseAd = at(c.ad, n);
  const bonusAs = c.asg * growth(n) + s.as;
  const st: UStats = {
    level: n,
    hp: at(c.hp, n) + s.hp,
    bhp: s.hp,
    ad: baseAd + s.ad,
    bad: s.ad,
    ap: s.ap * (1 + x.apAmp / 100),
    ar: at(c.ar, n) + s.armor,
    bar: s.armor,
    mr: at(c.mr, n) + s.mr,
    bmr: s.mr,
    mana: at(c.mana, n),
    as: Math.min(AS_CAP, c.as + c.asr * bonusAs / 100),
    crit: Math.min(1, s.crit / 100),
    critDmg: c.crit / 100 + x.critDmg / 100,
    leth: s.leth,
    apen: x.apen / 100,
    mpen: s.mpen,
    mpenPct: x.mpenPct / 100,
    haste: s.haste,
    ultHaste: 0,
    basicHaste: 0,
    ls: x.ls / 100,
    ov: x.ov / 100,
    hsp: x.hsp / 100,
  };
  list[u.i] = { lvl: u.level, kind, next, part, st };
  return st;
}

// ---------- skill ranks ----------
/** Rank of each spell [Q, W, E, R] at this level: R at 6 / 11 / 16, one point in each basic spell by level 3,
 *  then the main damage spell to 5, then the second. A basic spell reaches rank r at level 2r - 1 (LoL's cap).
 *  `order` = basic slots, main first. */
export function ranks(level: number, order: number[]): [number, number, number, number] {
  const n = Math.max(1, Math.min(18, level));
  const r = n >= 16 ? 3 : n >= 11 ? 2 : n >= 6 ? 1 : 0;
  const cap = Math.min(5, Math.ceil(n / 2));
  let pts = n - r;
  const out = [0, 0, 0, r] as [number, number, number, number];
  for (const k of order) {
    if (pts <= 0) break;
    out[k]++;
    pts--;
  }
  for (const k of order) {
    const add = Math.min(pts, cap - out[k]);
    out[k] += add;
    pts -= add;
  }
  return out;
}

const orderCache = new Map<string, number[]>();
/** Basic spells by damage per second of cooldown at a mid-game reference (the one a player maxes first leads). */
export function skillOrder(id: string): number[] {
  const hit = orderCache.get(id);
  if (hit) return hit;
  const sp = SPELLS[id];
  const ref: UStats = { level: 11, hp: 1800, bhp: 600, ad: 160, bad: 70, ap: 120, ar: 70, bar: 20, mr: 50, bmr: 10, mana: 900, as: 1, crit: 0, critDmg: 1.75, leth: 0, apen: 0, mpen: 0, mpenPct: 0, haste: 0, ultHaste: 0, basicHaste: 0, ls: 0, ov: 0, hsp: 0 };
  const val = (k: number) => {
    if (!sp?.[k]) return 0;
    const d = partsRaw(sp[k].d, 3, ref, null);
    const cd = sp[k].cd?.[2] ?? sp[k].cd?.[0] ?? 10;
    return (d.p + d.m + d.t + 0.4 * sumSupport(sp[k].h, 3, ref)) / Math.max(3, cd);
  };
  const order = [0, 1, 2].sort((a, b) => val(b) - val(a) || a - b);
  orderCache.set(id, order);
  return order;
}

// ranks() by champion and level, worked out once (rankOf is read for every spell number, many times a step)
const rankCache = new Map<string, Map<number, [number, number, number, number]>>();
export function rankOf(u: Unit, k: number): number {
  let byLevel = rankCache.get(u.champ.id);
  if (!byLevel) rankCache.set(u.champ.id, (byLevel = new Map()));
  let r = byLevel.get(u.level);
  if (!r) byLevel.set(u.level, (r = ranks(u.level, skillOrder(u.champ.id))));
  return r[k];
}

// ---------- spell numbers ----------
interface Tgt { hp: number; maxHp: number; bhp: number }

function termValue(t: Term, rank: number, s: UStats, tgt: Tgt | null): number {
  const vals = t[1];
  let v = vals[Math.min(vals.length - 1, Math.max(0, rank - 1))];
  if (t[0] === "flat") return v;
  const per = t[2];
  if (per) for (const [k, pv] of per) v += pv * statOf(k, s) / 100;
  const pct = v / 100;
  switch (t[0]) {
    case "tmhp": return pct * (tgt ? tgt.maxHp : 2000);
    case "tchp": return pct * (tgt ? tgt.hp : 1500);
    case "tmiss": return pct * (tgt ? Math.max(0, tgt.maxHp - tgt.hp) : 500);
    case "tbhp": return pct * (tgt ? tgt.bhp : 600);
    case "mmiss": return pct * Math.max(0, s.hp * 0.4);
    case "bmana": return 0;
    default: return pct * statOf(t[0], s);
  }
}

function statOf(k: string, s: UStats): number {
  switch (k) {
    case "ap": return s.ap;
    case "ad": return s.ad;
    case "bad": return s.bad;
    case "bhp": return s.bhp;
    case "mhp": return s.hp;
    case "ar": return s.ar;
    case "bar": return s.bar;
    case "mr": return s.mr;
    case "bmr": return s.bmr;
    case "mmana": return s.mana;
    default: return 0;
  }
}

function partsRaw(parts: Part[], rank: number, s: UStats, tgt: Tgt | null): Dmg {
  const d: Dmg = { p: 0, m: 0, t: 0 };
  for (const [mult, type, terms] of parts) {
    let v = 0;
    for (const t of terms) v += termValue(t, rank, s, tgt);
    v *= mult;
    if (type === "p") d.p += v;
    else if (type === "m") d.m += v;
    else if (type === "t") d.t += v;
    else { d.p += v / 2; d.m += v / 2; }
  }
  return d;
}

function sumSupport(parts: Part[], rank: number, s: UStats): number {
  let v = 0;
  for (const [mult, , terms] of parts) for (const t of terms) v += termValue(t, rank, s, null) * mult;
  return v;
}

/** True when the spell has real damage numbers (otherwise the engine keeps its old formula for it). */
export function hasDamage(u: Unit, k: number): boolean {
  return !!SPELLS[u.champ.id]?.[k]?.d.length;
}
/** True when the spell deals no damage in LoL (its kit weight is ignored). */
export function noDamage(u: Unit, k: number): boolean {
  return !!SPELLS[u.champ.id]?.[k]?.none;
}
/** Champion whose spells have real numbers at all (Meraki data; the two newest champions do not). */
export function hasSpellData(u: Unit): boolean {
  return !!SPELLS[u.champ.id];
}
export function hasSupport(u: Unit, k: number): boolean {
  return !!SPELLS[u.champ.id]?.[k]?.h.length;
}

/** Pre-mitigation damage of one cast of spell k on `v` (null: a typical target). */
export function spellRaw(e: Engine, u: Unit, k: number, v: Unit | null): Dmg {
  const sp = SPELLS[u.champ.id]?.[k];
  if (!sp || !sp.d.length) return { p: 0, m: 0, t: 0 };
  const rank = Math.max(1, rankOf(u, k));
  const tgt = v ? { hp: v.hp, maxHp: v.maxHp, bhp: v.alive ? stats(e, v).bhp : 0 } : null;
  return partsRaw(sp.d, rank, stats(e, u), tgt);
}

/**
 * A spell without real numbers (champion missing from Meraki, or a format the builder cannot read): the kit's damage
 * weight on a level curve near the real values of comparable spells (weight 2 at level 11 is about 250), typed by the
 * champion's damage type.
 */
export function fallbackRaw(u: Unit, weight: number): Dmg {
  const v = (20 + 13 * Math.max(1, Math.min(18, u.level))) * weight * 0.8;
  const d = u.champ.damage;
  return d === "AD" ? { p: v, m: 0, t: 0 } : d === "AP" ? { p: 0, m: v, t: 0 } : { p: v / 2, m: v / 2, t: 0 };
}

/** Shield / heal amount of one cast of spell k (heal and shield power included). */
export function supportAmount(e: Engine, u: Unit, k: number): number {
  const sp = SPELLS[u.champ.id]?.[k];
  if (!sp || !sp.h.length) return 0;
  const s = stats(e, u);
  return sumSupport(sp.h, Math.max(1, rankOf(u, k)), s) * (1 + s.hsp);
}

/** Basic attack damage per second before armor. */
export function aaRaw(e: Engine, u: Unit): number {
  const s = stats(e, u);
  return s.ad * s.as * (1 + s.crit * (s.critDmg - 1));
}

/** Multiplier armor leaves of physical damage from `src` on `v`. */
export function armorMul(e: Engine, src: Unit | null, v: Unit): number {
  const t = stats(e, v);
  const s = src ? stats(e, src) : null;
  const eff = Math.max(0, t.ar * (1 - (s?.apen ?? 0)) - (s?.leth ?? 0));
  return 100 / (100 + eff);
}
export function mrMul(e: Engine, src: Unit | null, v: Unit): number {
  const t = stats(e, v);
  const s = src ? stats(e, src) : null;
  const eff = Math.max(0, t.mr * (1 - (s?.mpenPct ?? 0)) - (s?.mpen ?? 0));
  return 100 / (100 + eff);
}

/** Damage after armor / magic resist. */
export function mitigate(e: Engine, src: Unit | null, v: Unit, d: Dmg): number {
  return (d.p ? d.p * armorMul(e, src, v) : 0) + (d.m ? d.m * mrMul(e, src, v) : 0) + d.t;
}

/** Real cooldown of spell k (rank and ability haste), or null when the data has none. */
export function cooldown(e: Engine, u: Unit, k: number): number | null {
  const cd = SPELLS[u.champ.id]?.[k]?.cd;
  if (!cd || !cd.length) return null;
  const rank = Math.max(1, rankOf(u, k));
  const base = cd[Math.min(cd.length - 1, rank - 1)];
  const s = stats(e, u);
  return base * 100 / (100 + s.haste + (k === 3 ? s.ultHaste : s.basicHaste));
}

interface StatMemo { lvl: number; a: number; b: number; st: UStats; v: number }
const statMemos = new WeakMap<Engine, StatMemo[]>();
/**
 * f() kept across steps while what it is made of stays the same: u's stats (all of them, after effects and buffs),
 * its level (spell ranks) and two engine multipliers a, b the caller passes in. Only for an f that reads nothing
 * else (engine power: spell damage, cooldowns, attack dps, durability). Exact: any change, even -0 to 0, recomputes.
 */
export function byStats(e: Engine, u: Unit, a: number, b: number, f: () => number): number {
  const st = stats(e, u);
  let list = statMemos.get(e);
  if (!list) statMemos.set(e, (list = []));
  const m = list[u.i];
  if (m && m.lvl === u.level && Object.is(m.a, a) && Object.is(m.b, b) && sameStats(m.st, st)) return m.v;
  const v = f();
  list[u.i] = { lvl: u.level, a, b, st, v };
  return v;
}
function sameStats(x: UStats, y: UStats): boolean {
  if (x === y) return true;
  for (const k in y) if (!Object.is(x[k as keyof UStats], y[k as keyof UStats])) return false;
  return true;
}

/** Once-per-step memo for values that are expensive and only change between steps (engine team power). */
const stepMemos = new WeakMap<Engine, Map<string, { t: number; v: number }>>();
export function perStep(e: Engine, key: string, f: () => number): number {
  let m = stepMemos.get(e);
  if (!m) stepMemos.set(e, (m = new Map()));
  const hit = m.get(key);
  if (hit && hit.t === e.t) return hit.v;
  const v = f();
  m.set(key, { t: e.t, v });
  return v;
}

/** Health a unit effectively has against an even mix of physical and magic damage (for team power). */
export function effectiveHp(e: Engine, u: Unit): number {
  const s = stats(e, u);
  return s.hp * (1 + (s.ar + s.mr) / 200);
}
