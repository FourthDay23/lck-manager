// Item passives and actives as combat effects (owner: combat-stats session). Numbers from Meraki items.json
// (data/meraki_items, 2026-02) where it has them, LoL values otherwise; plain stats (AD, AP, armor ...) and
// % penetration / crit damage / AP amplification / life steal / omnivamp are in stats.ts already.
// Effects that need item-only state the engine does not keep are approximated, noted at the item:
// "Manaflow" mana stacks (Archangel's, Manamune, Winter's Approach), Rod of Ages minutes, Mejai's stacks.
import type { Unit } from "./engine";
import * as Stats from "./stats";
import {
  M, P, T, active, adaptive, alliesNear, buff, byLevel, combatTime, dist, dot, foesNear, grievous, heal, hit, hitCount,
  hpF, inCombat, inStasis, isMelee, nth, ready, resetHits, shield, use,
} from "./procs-lib";
import type { Ctx, Effect } from "./procs-lib";
import type { Dmg } from "./stats";

const scale = (d: Dmg, n: number): Dmg => ({ p: d.p * n, m: d.m * n, t: d.t * n });
const baseAd = (c: Ctx) => {
  const s = Stats.champStats(c.u.champ.id);
  const n = Math.max(1, Math.min(18, c.u.level));
  return s.ad[0] + s.ad[1] * (n - 1) * (0.7025 + 0.0175 * (n - 1));
};
const st = (c: Ctx) => Stats.stats(c.e, c.u);
const critMul = (c: Ctx) => {
  const s = st(c);
  return 1 + s.crit * (s.critDmg - 1);
};

/** Bonus damage on every basic attack. */
const onHit = (id: string, f: (c: Ctx, t: Unit) => Dmg): Effect => ({ id, attack: (c, t, n) => hit(c, t, scale(f(c, t), n)) });
/** Every `every` basic attacks on the same target. */
const everyN = (id: string, every: number, f: (c: Ctx, t: Unit) => Dmg): Effect => ({
  id, attack: (c, t, n) => { const k = nth(c, t, n, every, id); if (k) hit(c, t, scale(f(c, t), k)); },
});
/** Spellblade: the next attack within 10 s after an ability (1.5 s cooldown; one Spellblade item counts). */
const spellblade = (id: string, f: (c: Ctx, t: Unit) => Dmg, after?: (c: Ctx, t: Unit) => void): Effect => ({
  id,
  attack: (c, t, n) => {
    if (n <= 0 || !active(c, "spellblade") || !ready(c, "sb")) return;
    c.p.until.spellblade = -1;
    use(c, "sb", 1.5);
    hit(c, t, f(c, t));
    after?.(c, t);
  },
});
/** Lifeline: the hit that would take the holder under 30 % health first grants a shield (90 s, one Lifeline). */
const lifeline = (id: string, amount: (c: Ctx) => number, dur: number, magicOnly = false, extra?: (c: Ctx) => void): Effect => ({
  id,
  hurt: (c, src, a) => {
    const u = c.u;
    if (!src || !ready(c, "lifeline") || u.hp + u.shield - a > u.maxHp * 0.3) return a;
    if (magicOnly && src.champ.damage !== "AP") return a;
    use(c, "lifeline", 90);
    shield(c.e, u, amount(c), dur);
    extra?.(c);
    return a;
  },
});
/** Active used in a fight when an enemy champion is within `range` (fight AI stand-in). */
const activeNear = (id: string, cd: number, range: number, f: (c: Ctx, foes: Unit[]) => void): Effect => ({
  id,
  tick: (c) => {
    if (!c.u.fightId || !ready(c, id)) return;
    const foes = foesNear(c.e, c.u, range);
    if (!foes.length) return;
    use(c, id, cd);
    f(c, foes);
  },
});
/** Aura damage every second in combat to enemies within r. */
const immolate = (id: string, r: number, perSec: (c: Ctx) => Dmg): Effect => ({
  id,
  tick: (c, dt) => {
    if (!inCombat(c)) return;
    for (const f of foesNear(c.e, c.u, r)) hit(c, f, scale(perSec(c), dt), "dot");
  },
});
const cleave = (id: string, pct: (c: Ctx) => number, r = 350): Effect => ({
  id,
  attack: (c, t, n) => {
    const others = foesNear(c.e, c.u, r, t).filter((x) => x !== t);
    for (const o of others.slice(0, 3)) hit(c, o, P(st(c).ad * pct(c) * n));
  },
});
const grievousOn = (id: string): Effect => ({ id, dealt: (c, v, _a, kind) => { if (kind !== "dot") grievous(c.e, v); } });
const lvl = (c: Ctx, a: number, b: number) => byLevel(c.u, a, b);
const meleeOr = (c: Ctx, m: number, r: number) => (isMelee(c.u) ? m : r);

export const ITEM_FX: Record<number, Effect[]> = {
  // ---------- fighters / tanks ----------
  2501: [{ id: "bloodmail", stats: (e, u, _p, s) => { s.ad += s.bhp * 0.025 + s.ad * 0.12 * Math.min(1, Math.max(0, (1 - u.hp / u.maxHp) / 0.7)); void e; } }],
  2502: [{
    id: "despair",
    tick: (c) => {
      if (!inCombat(c) || !ready(c, "despair")) return;
      use(c, "despair", 4);
      let dealt = 0;
      for (const f of foesNear(c.e, c.u, 650)) {
        const d = M(st(c).bhp * 0.03);
        dealt += Stats.mitigate(c.e, c.u, f, d);
        hit(c, f, d);
      }
      heal(c.e, c.u, dealt * 2.5);
    },
  }],
  2504: [{
    id: "rookern",
    hurt: (c, src, a) => {
      if (src && src.champ.damage === "AP" && ready(c, "rookern")) { use(c, "rookern", 15); shield(c.e, c.u, c.u.maxHp * 0.15, 15); }
      return a;
    },
  }],
  2517: [{ id: "hunger", tenacity: 0.2, stats: (_e, _u, _p, s) => { s.haste += 5 + s.bad * 0.1; } }],
  2525: [lifeline("protoplasm", (c) => lvl(c, 200, 600), 5, false, (c) => { heal(c.e, c.u, lvl(c, 200, 400)); buff(c.e, c.u, "resBuff", 0.5, 5); })],
  3053: [
    { id: "sterak", stats: (e, u, _p, s) => { s.ad += baseAdOf(u) * 0.45; s.bad += baseAdOf(u) * 0.45; void e; } },
    lifeline("sterak-ll", (c) => st(c).bhp * 0.6, 4.5),
  ],
  3065: [{ id: "visage", healIn: 0.25 }],
  3068: [immolate("sunfire", 325, (c) => M(20 + st(c).bhp * 0.01))],
  3071: [{ id: "cleaver", dealt: (c, v, _a, kind) => { if (kind === "aa" || kind === "spell") buff(c.e, v, "arDown", Math.min(0.3, 0.06 * hitCount(c, v, 1, 6, "carve")), 6); } }],
  3074: [cleave("ravenous", (c) => meleeOr(c, 0.4, 0.2)), activeNear("ravenous-a", 10, 450, (c, foes) => foes.forEach((f) => hit(c, f, P(st(c).ad * 0.8))))],
  3075: [{
    id: "thornmail",
    hurt: (c, src, a, kind) => {
      if (src && kind === "aa") {
        hit(c, src, M((20 + st(c).bar * 0.1) * Stats.stats(c.e, src).as * 0.25));
        grievous(c.e, src);
      }
      return a;
    },
  }],
  3078: [spellblade("trinity", (c) => P(baseAd(c) * 2))],
  3083: [{ id: "warmog", stats: (_e, _u, _p, s) => { s.hp += s.bhp * 0.12; } }],
  3084: [{
    id: "heartsteel",
    stats: (_e, _u, p, s) => { s.hp += p.n.heartsteel ?? 0; },
    attack: (c, t) => {
      if (!ready(c, `hs${t.i}`)) return;
      use(c, `hs${t.i}`, 30);
      const d = 70 + c.u.maxHp * 0.06;
      hit(c, t, P(d));
      c.p.n.heartsteel = (c.p.n.heartsteel ?? 0) + d * 0.08;
    },
  }],
  3109: [{
    // Knight's Vow: redirects 12 % of the damage the worthy ally (own bot laner) takes while above 30 % health
    id: "vow",
    tick: (c) => {
      const ally = c.e.units.find((x) => x.side === c.u.side && x.role === "Bot" && x !== c.u && x.alive);
      if (ally && hpF(c.u) > 0.3 && dist(ally, c.u) < 1250) buff(c.e, ally, "vow", c.u.i + 1, 0.5);
    },
  }],
  3110: [{ id: "frozen", tick: (c) => { for (const f of foesNear(c.e, c.u, 700)) buff(c.e, f, "asSlow", 0.2, 0.5); } }],
  3143: [{
    id: "randuin",
    inc: (c, src, kind) => {
      if (!src || kind !== "aa") return 1;
      const s = Stats.stats(c.e, src);
      const critPart = s.crit * (s.critDmg - 1);
      return 1 - 0.3 * critPart / (1 + critPart);
    },
  }],
  3181: [everyN("hullbreaker", 5, (c) => P(baseAd(c) * meleeOr(c, 1.2, 0.6) + c.u.maxHp * meleeOr(c, 0.05, 0.025)))],
  3742: [{ id: "dmp", attack: (c, t) => { if (ready(c, "dmp")) { use(c, "dmp", 6); hit(c, t, P(40 + baseAd(c))); } } }],
  3748: [
    onHit("titanic", (c) => P(c.u.maxHp * meleeOr(c, 0.01, 0.005))),
    cleave("titanic-cl", (c) => (c.u.maxHp * meleeOr(c, 0.03, 0.015)) / Math.max(1, st(c).ad)),
    { id: "titanic-a", attack: (c, t) => { if (inCombat(c) && ready(c, "titanic-a")) { use(c, "titanic-a", 10); hit(c, t, P(c.u.maxHp * meleeOr(c, 0.04, 0.02))); } } },
  ],
  4401: [{ id: "fon", stats: (e, u, p, s) => { if (e.t - p.combatLast < 3) s.mr += Math.min(48, 6 * Math.max(0, e.t - p.combatFrom)); void u; } }],
  6333: [{
    id: "deathsdance",
    hurt: (c, src, a, kind) => {
      // damage over time, and what this item releases (raw), is not stored again
      if (kind === "dot" || kind === "raw") return a;
      const keep = meleeOr(c, 0.3, 0.1);
      c.p.stored += a * keep;
      if (src) c.p.storedSrc = src.i;
      return a * (1 - keep);
    },
  }],
  6631: [cleave("stridebreaker", (c) => meleeOr(c, 0.4, 0.2)), activeNear("stridebreaker-a", 15, 450, (c, foes) => foes.forEach((f) => hit(c, f, P(st(c).ad * 0.8))))],
  6610: [{
    id: "sundered",
    attack: (c, t) => {
      if (!ready(c, `ss${t.i}`)) return;
      use(c, `ss${t.i}`, 10);
      hit(c, t, P(st(c).ad * 0.8 - st(c).ad * st(c).crit * (st(c).critDmg - 1)));
      heal(c.e, c.u, baseAd(c) * meleeOr(c, 1, 0.5) + (c.u.maxHp - c.u.hp) * 0.06);
    },
  }],
  6662: [spellblade("iceborn", (c) => P(baseAd(c) * 1.5))],
  6664: [immolate("hollow", 325, (c) => M(15 + st(c).bhp * 0.01))],
  6665: [{ id: "jaksho", stats: (e, u, p, s) => { if (e.t - p.combatLast < 3 && e.t - p.combatFrom >= 5) { s.ar += s.bar * 0.3; s.mr += s.bmr * 0.3; } void u; } }],
  6698: [cleave("profane", (c) => meleeOr(c, 0.4, 0.2)), activeNear("profane-a", 15, 450, (c, foes) => foes.forEach((f) => hit(c, f, P(st(c).ad * 0.8))))],
  3869: [{
    // Celestial Opposition: damage from champions reduced for 2 s once champion damage starts (18 s cooldown)
    id: "celestial",
    inc: (c, src) => {
      if (!src) return 1;
      if (ready(c, "celestial")) { use(c, "celestial", 18); c.p.until.blessed = c.e.t + 2; }
      return (c.p.until.blessed ?? -1) > c.e.t ? meleeOr(c, 0.65, 0.75) : 1;
    },
  }],
  // ---------- lifelines and saves ----------
  3026: [{
    id: "ga",
    // resurrection: 4 s of stasis (no damage, cannot act), then back with half of base health. The health is set at
    // once (the stasis keeps it safe), so the unit is never left at 1 hp when the stasis ends.
    lethal: (c) => {
      if (!ready(c, "ga")) return false;
      use(c, "ga", 300);
      const base = Stats.champStats(c.u.champ.id).hp;
      c.u.hp = Math.max(1, (base[0] + base[1] * (c.u.level - 1) * (0.7025 + 0.0175 * (c.u.level - 1))) * 0.5);
      buff(c.e, c.u, "stasis", 1, 4);
      c.u.stunUntil = Math.max(c.u.stunUntil, c.e.t + 4);
      return true;
    },
  }],
  3156: [lifeline("maw", (c) => meleeOr(c, 200, 150) + st(c).bad * meleeOr(c, 1.5, 1.125), 3, true, (c) => buff(c.e, c.u, "ovBuff", 0.1, 8))],
  3157: [{
    id: "zhonya",
    hurt: (c, src, a) => {
      const u = c.u;
      if (!src || !ready(c, "zhonya") || u.hp + u.shield - a > u.maxHp * 0.25 || foesNear(c.e, u, 900).length === 0) return a;
      use(c, "zhonya", 120);
      buff(c.e, u, "stasis", 1, 2.5);
      u.stunUntil = Math.max(u.stunUntil, c.e.t + 2.5);
      return 0;
    },
  }],
  6673: [lifeline("shieldbow", (c) => lvl(c, 400, 700) * meleeOr(c, 1, 0.8), 3)],
  3102: [{ id: "spellshield" }],
  3814: [{ id: "spellshield" }],
  3139: [{ id: "scimitar", tick: (c) => { if (c.u.stunUntil - c.e.t > 1 && c.u.fightId && !inStasis(c.e, c.u) && ready(c, "qss")) { use(c, "qss", 90); c.u.stunUntil = c.e.t; } } }],
  3047: [{ id: "steelcaps", inc: (_c, _s, kind) => (kind === "aa" ? 0.9 : 1) }],
  3111: [{ id: "mercury", tenacity: 0.3 }],
  // ---------- marksmen / on-hit ----------
  3032: [{
    id: "yuntal",
    stats: (_e, _u, _p, s) => { s.crit = Math.min(1, s.crit + 0.25); },
    attack: (c, t) => { if (ready(c, "flurry")) { use(c, "flurry", 30); buff(c.e, c.u, "asBuff", 30, 6); } void t; },
  }],
  3033: [grievousOn("reminder")],
  3036: [{ id: "ldr", out: (c, v) => 1 + 0.15 * Math.min(1, Stats.stats(c.e, v).bhp / 1500) }],
  3085: [{
    id: "runaan",
    attack: (c, t, n) => {
      const others = foesNear(c.e, c.u, 650).filter((x) => x !== t).slice(0, 2);
      for (const o of others) hit(c, o, P(st(c).ad * 0.55 * critMul(c) * n));
    },
  }],
  3087: [{
    id: "statikk",
    attack: (c, t) => {
      if (!ready(c, "statikk")) return;
      use(c, "statikk", 6);
      for (const f of [t, ...foesNear(c.e, c.u, 500, t).filter((x) => x !== t).slice(0, 4)]) hit(c, f, M(60 * 3));
    },
  }],
  3091: [onHit("witsend", () => M(45)), { id: "witsend-t", tenacity: 0.2 }],
  3094: [everyN("rfc", 4, () => M(40))],
  3097: [everyN("stormrazor", 4, () => M(100))],
  3115: [onHit("nashor", (c) => M(15 + st(c).ap * 0.2))],
  3124: [
    onHit("guinsoo", () => M(30)),
    everyN("guinsoo-ph", 3, () => M(30)),
    { id: "guinsoo-as", stats: (e, u, p, s) => { if (e.t - p.combatLast < 3) addAs(u, s, Math.min(32, 8 * (e.t - p.combatFrom + 1))); } },
  ],
  3153: [onHit("botrk", (c, t) => P(t.hp * meleeOr(c, 0.09, 0.06)))],
  3302: [
    onHit("terminus", () => M(30)),
    { id: "terminus-st", stats: (e, u, p, s) => { if (e.t - p.combatLast < 3 && e.t - p.combatFrom > 2) { s.ar += 12; s.mr += 12; s.apen = 1 - (1 - s.apen) * 0.85; s.mpenPct = 1 - (1 - s.mpenPct) * 0.85; } void u; } },
  ],
  3508: [spellblade("reaver", (c) => P(baseAd(c) * 1.25 * (1 + 0.4 * st(c).crit)))],
  3072: [{ id: "bloodthirster", attack: (c) => { if (c.u.hp >= c.u.maxHp * 0.99 && ready(c, "bt")) { use(c, "bt", 12); shield(c.e, c.u, lvl(c, 165, 315), 12); } } }],
  6672: [everyN("kraken", 3, (c, t) => P((byLevel(c.u, 150, 200) * meleeOr(c, 1, 0.8)) * (1 + 0.75 * (1 - hpF(t)))))],
  6675: [{ id: "navori", stats: (_e, _u, _p, s) => { s.basicHaste += 20 * Math.min(2, s.as); } }],
  6676: [{ id: "collector", dealt: (c, v) => { if (v.alive && v.hp < v.maxHp * 0.05) c.deal(c.u, v, v.hp + v.shield + 1, "proc"); } }],
  2512: [{
    id: "fiendhunter",
    stats: (e, u, p, s) => { s.ultHaste += 30; if ((p.until.fiend ?? -1) > e.t) addAs(u, s, 50); },
    cast: (c, k) => { if (k === 3) { c.p.until.fiend = c.e.t + 4; } },
    attack: (c, t, n) => { if (active(c, "fiend")) hit(c, t, P(st(c).ad * 0.6 * n)); },
  }],
  3073: [{
    id: "hexplate",
    stats: (_e, _u, _p, s) => { s.ultHaste += 30; },
    cast: (c, k) => { if (k === 3 && ready(c, "hexplate")) { use(c, "hexplate", 30); buff(c.e, c.u, "asBuff", 50, 8); } },
  }],
  // ---------- mages ----------
  2503: [{ id: "blackfire", spellHit: (c, v) => dot(c, v, M(60 + st(c).ap * 0.06), 3, "blackfire") }],
  2510: [spellblade("dusk", (c) => M(baseAd(c) * 0.75 + st(c).ap * 0.1))],
  2520: [{ id: "bastion", spellHit: (c, v) => { if (ready(c, "bastion")) { use(c, "bastion", 8); hit(c, v, T(meleeOr(c, 30, 15) + st(c).leth * meleeOr(c, 2, 1))); } } }],
  2522: [{ id: "actualizer", out: (_c, _v, kind) => (kind === "spell" ? 1.05 : 1) }],
  2523: [{ id: "hexoptics", out: (c, v) => (c.u.champ.ranged ? 1 + 0.1 * Math.min(1, dist(c.u, v) / 700) : 1) }],
  // heal and shield power of Whispering Circlet / Dawncore is in their Data Dragon stats (ITEM_EXTRAS) already
  2526: [],
  3003: [{ id: "archangel", stats: (_e, _u, _p, s) => { s.ap += 9; } }],
  3004: [{ id: "manamune", stats: (_e, _u, _p, s) => { const b = 0.025 * (s.mana + 500); s.ad += b; s.bad += b; } }],
  3119: [{ id: "winters", stats: (_e, _u, _p, s) => { s.hp += 75; s.bhp += 75; } }],
  3041: [{ id: "mejai", stats: (_e, u, _p, s) => { s.ap += 5 * Math.min(25, Math.max(0, 4 * u.k + 2 * u.a - 6 * u.d)); } }],
  6657: [{ id: "roa", stats: (_e, _u, _p, s) => { s.hp += 70; s.bhp += 70; s.ap += 21; } }],
  3050: [{
    id: "zeke",
    stats: (_e, _u, _p, s) => { s.ultHaste += 15; },
    cast: (c, k) => { if (k === 3 && ready(c, "zeke")) { use(c, "zeke", 45); c.p.until.zekeStorm = c.e.t + 5; } },
    tick: (c, dt) => { if (active(c, "zekeStorm")) for (const f of foesNear(c.e, c.u, 350)) hit(c, f, M((25 + st(c).ap * 0.05) * dt), "dot"); },
  }],
  3100: [spellblade("lichbane", (c) => M(baseAd(c) * 0.75 + st(c).ap * 0.4))],
  3118: [{
    id: "malignance",
    stats: (_e, _u, _p, s) => { s.ultHaste += 20; },
    spellHit: (c, v, k) => { if (k === 3) { dot(c, v, M(60 + st(c).ap * 0.05), 3, "hatefog"); buff(c.e, v, "mrFlat", 10, 3); } },
  }],
  3137: [],
  3146: [activeNear("gunblade", 60, 700, (c, foes) => hit(c, foes[0], M(lvl(c, 175, 253) + st(c).ap * 0.3)))],
  3152: [activeNear("rocketbelt", 40, 500, (c, foes) => foes.slice(0, 2).forEach((f) => hit(c, f, M(100 + st(c).ap * 0.1))))],
  3161: [{
    id: "shojin",
    stats: (_e, _u, _p, s) => { s.basicHaste += 25; },
    spellHit: (c) => { c.p.n.shojin = Math.min(4, (active(c, "shojinT") ? c.p.n.shojin ?? 0 : 0) + 1); c.p.until.shojinT = c.e.t + 6; },
    out: (c, _v, kind) => (kind === "spell" && active(c, "shojinT") ? 1 + 0.03 * (c.p.n.shojin ?? 0) : 1),
  }],
  3165: [grievousOn("morello")],
  4628: [{ id: "horizon", out: (c, v, kind) => (kind === "spell" && dist(c.u, v) >= 600 ? 1.1 : 1) }],
  4633: [{
    id: "riftmaker",
    stats: (e, u, p, s) => { s.ap += s.bhp * 0.02; if (e.t - p.combatLast < 3 && e.t - p.combatFrom >= 4) s.ov += isMelee(u) ? 0.1 : 0.06; },
    out: (c) => 1 + 0.02 * Math.min(4, combatTime(c)),
  }],
  4645: [{ id: "shadowflame", out: (c, v, kind) => (kind !== "aa" && hpF(v) < 0.4 && c.u.champ.damage !== "AD" ? 1.2 : 1) }],
  4646: [{
    id: "stormsurge",
    dealt: (c, v, a) => {
      if (!ready(c, "stormsurge")) return;
      if (hitCount(c, v, a, 2.5, "surge") >= v.maxHp * 0.25) { use(c, "stormsurge", 30); resetHits(c, v, "surge"); hit(c, v, M(125 + st(c).ap * 0.1)); }
    },
  }],
  6653: [{ id: "liandry", spellHit: (c, v) => dot(c, v, M(v.maxHp * 0.06), 3, "liandry"), out: (c) => 1 + 0.02 * Math.min(3, combatTime(c)) }],
  6655: [{
    id: "luden",
    spellHit: (c, v) => {
      if (!ready(c, "luden")) return;
      use(c, "luden", 10);
      for (const f of [v, ...foesNear(c.e, c.u, 600, v).filter((x) => x !== v).slice(0, 3)]) hit(c, f, M(75 + st(c).ap * 0.05));
    },
  }],
  8010: [{ id: "bloodletter", spellHit: (c, v) => { if (c.u.champ.damage !== "AD") buff(c.e, v, "mrDown", Math.min(0.3, 0.075 * hitCount(c, v, 1, 6, "decay")), 6); } }],
  8020: [{ id: "abyssal", tick: (c) => { for (const f of foesNear(c.e, c.u, 700)) buff(c.e, f, "abyss", 0.12, 0.5); } }],
  4005: [{ id: "mandate", cc: (c, v) => { buff(c.e, v, "mandate", c.u.side + 1, 5); } }],
  // ---------- assassins ----------
  6692: [{
    id: "eclipse",
    attack: (c, t, n) => eclipse(c, t, n),
    spellHit: (c, v) => eclipse(c, v, 1),
  }],
  6695: [{ id: "serpent", dealt: (c, v) => buff(c.e, v, "venom", meleeOr(c, 0.5, 0.35), 3) }],
  6697: [{ id: "hubris", stats: (_e, u, _p, s) => { const b = Math.min(45, 15 + 2 * u.k); s.ad += b * 0.5; s.bad += b * 0.5; } }],
  6701: [{ id: "opportunity", stats: (_e, u, _p, s) => { s.leth += isMelee(u) ? 5 : 2.5; } }],
  6699: [everyN("voltaic", 4, () => P(100))],
  6609: [grievousOn("chempunk")],
  3142: [],
  // ---------- supports ----------
  3107: [{
    id: "redemption",
    tick: (c) => {
      if (!c.u.fightId || !ready(c, "redemption")) return;
      const hurt = alliesNear(c.e, c.u, 1200).filter((a) => hpF(a) < 0.5);
      if (!hurt.length) return;
      use(c, "redemption", 90);
      const at = hurt[0];
      for (const a of alliesNear(c.e, at, 550)) heal(c.e, a, lvl(c, 150, 350));
      for (const f of foesNear(c.e, c.u, 550, at)) c.deal(c.u, f, f.maxHp * 0.1, "proc");
    },
  }],
  3190: [{
    id: "locket",
    tick: (c) => {
      if (!c.u.fightId || !ready(c, "locket")) return;
      const near = alliesNear(c.e, c.u, 850);
      if (!near.some((a) => hpF(a) < 0.6 && a.fightId)) return;
      use(c, "locket", 90);
      for (const a of near) shield(c.e, a, lvl(c, 200, 360), 2.5);
    },
  }],
  3222: [{
    id: "mikael",
    tick: (c) => {
      if (!c.u.fightId || !ready(c, "mikael")) return;
      const a = alliesNear(c.e, c.u, 650).find((x) => x.stunUntil - c.e.t > 0.75 && !inStasis(c.e, x));
      if (!a) return;
      use(c, "mikael", 120);
      a.stunUntil = c.e.t;
      heal(c.e, a, lvl(c, 100, 250));
    },
  }],
  3504: [{ id: "ardent", support: (c, ally) => { for (const x of [ally, c.u]) { buff(c.e, x, "asBuff", 25, 6); buff(c.e, x, "onHitM", 20, 6); } } }],
  3870: [{ id: "dreammaker", support: (c, ally) => { if (ally !== c.u && ready(c, "dream")) { use(c, "dream", 8); shield(c.e, ally, lvl(c, 75, 255), 3); } } }],
  3876: [{ id: "sleigh", cc: (c) => { if (!ready(c, "sleigh")) return; use(c, "sleigh", 10); const w = alliesNear(c.e, c.u, 1500).sort((a, b) => hpF(a) - hpF(b))[0]; if (w) shield(c.e, w, lvl(c, 60, 150), 2.5); } }],
  3877: [spellblade("bloodsong", (c) => P(baseAd(c)), (c, t) => buff(c.e, t, "expose", meleeOr(c, 0.08, 0.05), 4))],
  2524: [{ id: "bandle", cc: (c) => { for (const a of alliesNear(c.e, c.u, 1000)) buff(c.e, a, "asBuff", meleeOr(c, 30, 20), meleeOr(c, 8, 4)); } }],
  6616: [{ id: "sfw", support: (c, ally) => { for (const x of [ally, c.u]) buff(c.e, x, "apBuff", 45, 6); } }],
  6617: [{
    id: "moonstone",
    support: (c, ally, a) => {
      const other = alliesNear(c.e, ally, 800).filter((x) => x !== ally && x !== c.u)[0];
      if (other) heal(c.e, other, a * 0.3);
      else return a * 1.3;
    },
  }],
  6620: [{
    id: "helia",
    dealt: (c, _v, a) => { c.p.n.soul = Math.min(lvl(c, 80, 250), (c.p.n.soul ?? 0) + a * 0.35); },
    support: (c, ally) => { if (ally !== c.u && c.p.n.soul) { heal(c.e, ally, c.p.n.soul); c.p.n.soul = 0; } },
  }],
  6621: [{ id: "dawncore", stats: (_e, _u, _p, s) => { s.ap += 20; } }],
};

function eclipse(c: Ctx, t: Unit, n: number) {
  if (!ready(c, `ecl${t.i}`)) return;
  if (hitCount(c, t, n, 2, "ecl") < 2) return;
  use(c, `ecl${t.i}`, 6);
  resetHits(c, t, "ecl");
  hit(c, t, P(t.maxHp * meleeOr(c, 0.06, 0.04)));
  shield(c.e, c.u, meleeOr(c, 80, 40) + Stats.stats(c.e, c.u).bad * meleeOr(c, 0.2, 0.15), 2);
}

function baseAdOf(u: Unit) {
  const s = Stats.champStats(u.champ.id);
  const n = Math.max(1, Math.min(18, u.level));
  return s.ad[0] + s.ad[1] * (n - 1) * (0.7025 + 0.0175 * (n - 1));
}
/** Add bonus attack speed % (through the champion's attack speed ratio, cap 2.5). */
export function addAs(u: Unit, s: Stats.UStats, pct: number) {
  s.as = Math.min(2.5, s.as + Stats.champStats(u.champ.id).asr * pct / 100);
}
void adaptive;
