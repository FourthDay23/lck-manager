// Champion passives as combat effects (owner: combat-stats session), for the most picked champions in the 2026 LCK
// games (about 90; the rest have none). Numbers from Meraki's passive text ("a : b (based on level)" = linear by
// level, "x / y / z (based on level)" read as linear); mechanics the engine has no state for are averaged, noted
// at the champion. Spells that are passives in all but name (Vayne W, Kog'Maw W, Kalista E) are kit spells already.
import type { Unit } from "./engine";
import * as Stats from "./stats";
import type { Dmg } from "./stats";
import {
  M, P, T, active, applyCC, buff, byLevel, combatTime, dist, dot, foesNear, alliesNear, heal, hit, hitCount, hpF,
  inCombat, isMelee, nth, ready, resetHits, shield, use,
} from "./procs-lib";
import type { Ctx, Effect, PState } from "./procs-lib";
import type { UStats } from "./stats";
import type { Engine } from "./engine";
import { addAs } from "./itemfx";

const st = (c: Ctx) => Stats.stats(c.e, c.u);
const lvl = (c: Ctx, a: number, b: number) => byLevel(c.u, a, b);
const scale = (d: Dmg, n: number): Dmg => ({ p: d.p * n, m: d.m * n, t: d.t * n });
const critMul = (c: Ctx) => { const s = st(c); return 1 + s.crit * (s.critDmg - 1); };
const minute = (e: Engine) => e.t / 60;

const onHit = (f: (c: Ctx, t: Unit) => Dmg): Effect => ({ id: "p-onhit", attack: (c, t, n) => hit(c, t, scale(f(c, t), n)) });
const everyN = (every: number, f: (c: Ctx, t: Unit) => Dmg, after?: (c: Ctx, t: Unit) => void): Effect => ({
  id: "p-nth",
  attack: (c, t, n) => { const k = nth(c, t, n, every, "pas"); if (k) { hit(c, t, scale(f(c, t), k)); after?.(c, t); } },
});
/** Periodically empowered next attack (cooldown in seconds, in fights the effective one). */
const periodic = (cd: (c: Ctx) => number, f: (c: Ctx, t: Unit) => void): Effect => ({
  id: "p-periodic",
  attack: (c, t) => { if (ready(c, "pas")) { use(c, "pas", cd(c)); f(c, t); } },
});
/** Once per target every cd seconds. */
const perTarget = (cd: number, f: (c: Ctx, t: Unit) => void): Effect => ({
  id: "p-target",
  attack: (c, t) => { if (ready(c, `pt${t.i}`)) { use(c, `pt${t.i}`, cd); f(c, t); } },
});
/** After casting an ability, the next `count` attacks are empowered. */
const afterCast = (count: number, f: (c: Ctx, t: Unit, k: number) => void, max = count, asPct = 0): Effect => ({
  id: "p-aftercast",
  stats: asPct ? (e, u, p, s) => { if ((p.n.ac ?? 0) > 0 && (p.until.ac ?? -1) > e.t) addAs(u, s, asPct); } : undefined,
  cast: (c) => { c.p.n.ac = Math.min(max, (active(c, "ac") ? c.p.n.ac ?? 0 : 0) + count); c.p.until.ac = c.e.t + 4; },
  attack: (c, t, n) => {
    if (!active(c, "ac") || (c.p.n.ac ?? 0) <= 0) return;
    const k = Math.min(n, c.p.n.ac ?? 0);
    c.p.n.ac = (c.p.n.ac ?? 0) - n;
    f(c, t, k);
  },
});
const statsFx = (f: (e: Engine, u: Unit, p: PState, s: UStats) => void): Effect => ({ id: "p-stats", stats: f });
const inFight = (e: Engine, p: PState) => e.t - p.combatLast < 3;

export const PASSIVE_FX: Record<string, Effect[]> = {
  XinZhao: [everyN(3, (c) => P(st(c).ad * lvl(c, 0.15, 0.6)), (c) => heal(c.e, c.u, lvl(c, 6, 74) + 0.1 * st(c).bad))],
  // Overheat: about every 15 s in a fight, 4 s of empowered attacks and attack speed
  Rumble: [{
    id: "p-heat",
    stats: (e, u, p, s) => { if ((p.until.heat ?? -1) > e.t) addAs(u, s, byLevel(u, 50, 130)); },
    attack: (c, t, n) => {
      if (inCombat(c) && ready(c, "heat")) { use(c, "heat", 15); c.p.until.heat = c.e.t + 4; }
      if (active(c, "heat")) hit(c, t, M((lvl(c, 5, 40) + 0.25 * st(c).ap) * n));
    },
  }],
  Ryze: [statsFx((_e, _u, _p, s) => { s.mana *= 1 + 0.1 * s.ap / 100; })],
  Ezreal: [{
    id: "p-ez",
    stats: (e, u, p, s) => { if ((p.until.ez ?? -1) > e.t) addAs(u, s, 10 * (p.n.ez ?? 0)); },
    spellHit: (c) => { c.p.n.ez = Math.min(5, (active(c, "ez") ? c.p.n.ez ?? 0 : 0) + 1); c.p.until.ez = c.e.t + 6; },
  }],
  Ambessa: [afterCast(1, (c, t, k) => hit(c, t, P((lvl(c, 5, 30) + 0.3 * st(c).bad) * k)), 3, 50)],
  // 4th shot always crits and deals missing health damage; bonus AD from crit and attack speed
  Jhin: [
    statsFx((_e, u, _p, s) => {
      const bonusAs = Math.max(0, (s.as / Stats.champStats(u.champ.id).as - 1) * 100);
      const b = s.ad * (byLevel(u, 0.04, 0.44) + 0.0035 * s.crit * 100 + 0.003 * bonusAs);
      s.ad += b;
      s.bad += b;
    }),
    everyN(4, (c, t) => P(st(c).ad * (st(c).critDmg - 1) * (1 - st(c).crit) + (t.maxHp - t.hp) * lvl(c, 0.15, 0.25))),
  ],
  // Mortal Will: after 5 attacks / casts the next ability is empowered (about +60 % of a Q)
  Pantheon: [{
    id: "p-pan",
    attack: (c, _t, n) => { c.p.n.mw = (c.p.n.mw ?? 0) + n; },
    cast: (c) => { c.p.n.mw = (c.p.n.mw ?? 0) + 1; },
    spellHit: (c, v) => { if ((c.p.n.mw ?? 0) >= 5) { c.p.n.mw = 0; hit(c, v, P(lvl(c, 40, 220) + 0.6 * st(c).bad)); } },
  }],
  JarvanIV: [perTarget(6, (c, t) => hit(c, t, P(Math.max(20, t.hp * 0.08))))],
  MonkeyKing: [statsFx((e, u, p, s) => { s.ar += byLevel(u, 6, 10) * (inFight(e, p) ? 4 : 1); })],
  Alistar: [{ id: "p-ali", cc: (c) => { if (!ready(c, "ali")) return; use(c, "ali", 8); heal(c.e, c.u, c.u.maxHp * 0.05); for (const a of alliesNear(c.e, c.u, 600)) if (a !== c.u) heal(c.e, a, c.u.maxHp * 0.07); } }],
  Corki: [onHit((c) => T(st(c).ad * 0.2 * critMul(c)))],
  Vi: [{ id: "p-vi", spellHit: (c) => { if (ready(c, "vi")) { use(c, "vi", 12); shield(c.e, c.u, c.u.maxHp * 0.12, 3); } } }],
  Aurora: [{
    id: "p-aurora",
    attack: (c, t, n) => aurora(c, t, n),
    spellHit: (c, v) => aurora(c, v, 1),
  }],
  Nautilus: [perTarget(8, (c, t) => { hit(c, t, P(lvl(c, 14, 116))); applyCC(c, t, "root", lvl(c, 0.75, 1.5)); })],
  Ahri: [{ id: "p-ahri", takedown: (c) => heal(c.e, c.u, lvl(c, 75, 165) + 0.3 * st(c).ap) }],
  KSante: [{
    id: "p-ksante",
    spellHit: (c, v) => { c.p.until[`ks${v.i}`] = c.e.t + 4; },
    attack: (c, t) => { if (active(c, `ks${t.i}`)) { c.p.until[`ks${t.i}`] = -1; hit(c, t, P(12 + t.maxHp * lvl(c, 0.01, 0.02))); } },
  }],
  Rakan: [{ id: "p-rakan", tick: (c) => { if (inCombat(c) && ready(c, "rakan")) { use(c, "rakan", 20); shield(c.e, c.u, lvl(c, 30, 225) + 0.95 * st(c).ap, 10); } } }],
  Lucian: [afterCast(1, (c, t, k) => hit(c, t, P(st(c).ad * lvl(c, 0.5, 0.6) * critMul(c) * k)))],
  // Glory in Death: revives at full health for a while (health decays), with attack speed and on-hit damage
  Sion: [{
    id: "p-sion",
    lethal: (c) => {
      if (c.p.n.sionUsed) return false;
      c.p.n.sionUsed = 1;
      c.u.hp = c.u.maxHp;
      buff(c.e, c.u, "stasis", 1, 1.5);
      c.u.stunUntil = Math.max(c.u.stunUntil, c.e.t + 1.5);
      c.p.until.zombie = c.e.t + 1.5 + 12;
      return true;
    },
    stats: (e, u, p, s) => { if ((p.until.zombie ?? -1) > e.t) { s.as = Math.max(s.as, 1.75); s.ls += 1; } void u; },
    attack: (c, t, n) => { if (active(c, "zombie")) hit(c, t, P(t.maxHp * 0.1 * n)); },
    tick: (c, dt) => {
      if (active(c, "zombie") && !active(c, "stasis")) c.deal(null, c.u, c.u.maxHp / 12 * dt, "raw");
    },
    // once per life: dying (as the zombie or otherwise) re-arms it for the next life
    death: (c) => { c.p.n.sionUsed = 0; },
  }],
  Rell: [{
    id: "p-rell",
    attack: (c, t, n) => { const s = st(c); hit(c, t, M((s.ar + s.mr) * 0.05 * n)); buff(c.e, t, "arDown", 0.15, 5); buff(c.e, t, "mrDown", 0.15, 5); },
    spellHit: (c, v) => { buff(c.e, v, "arDown", 0.15, 5); buff(c.e, v, "mrDown", 0.15, 5); },
  }],
  Varus: [{ id: "p-varus", takedown: (c) => buff(c.e, c.u, "asBuff", 50, lvl(c, 5, 11)) }],
  Orianna: [onHit((c) => M((lvl(c, 10, 60) + 0.15 * st(c).ap) * 1.3))],
  Gwen: [onHit((c, t) => M(t.maxHp * (0.01 + 0.0055 * st(c).ap / 100))), {
    id: "p-gwen-heal",
    dealt: (c, _v, a, kind) => { if (kind === "aa") heal(c.e, c.u, Math.min(a * 0.5, lvl(c, 10, 25) + 0.065 * st(c).ap) * 0.25); },
  }],
  // Fury empowers a basic ability about every other rotation
  Renekton: [{ id: "p-renek", out: (_c, _v, kind) => (kind === "spell" ? 1.12 : 1) }],
  Yunara: [onHit((c) => { const s = st(c); return M(s.ad * s.critDmg * s.crit * (0.1 + 0.1 * s.ap / 100)); })],
  Bard: [periodic(() => 4, (c, t) => hit(c, t, M(35 + 0.4 * st(c).ap + 10 * Math.min(10, minute(c.e) / 3))))],
  Galio: [periodic(() => 6, (c, t) => {
    const s = st(c);
    const d = M(lvl(c, 15, 115) + s.ad + 0.45 * s.ap + 0.6 * s.bmr);
    for (const f of [t, ...foesNear(c.e, c.u, 250, t).filter((x) => x !== t)]) hit(c, f, d);
  })],
  Kaisa: [
    onHit((c) => M(lvl(c, 4, 24) + lvl(c, 1, 6) * 2 + st(c).ap * 0.18)),
    everyN(5, (c, t) => M((t.maxHp - t.hp) * (0.15 + 0.06 * st(c).ap / 100))),
  ],
  Lulu: [onHit((c) => M(3 * (lvl(c, 5, 39) + 0.05 * st(c).ap) * 0.8))],
  Nocturne: [everyN(4, (c, t) => {
    const s = st(c);
    for (const f of foesNear(c.e, c.u, 250, t).filter((x) => x !== t)) hit(c, f, P(s.ad * 1.2));
    heal(c.e, c.u, (lvl(c, 13, 30) + 0.3 * s.ap) * (1 + foesNear(c.e, c.u, 250, t).length));
    return P(s.ad * 1.2 * critMul(c));
  })],
  Poppy: [periodic(() => 10, (c, t) => { hit(c, t, M(lvl(c, 20, 180))); shield(c.e, c.u, c.u.maxHp * lvl(c, 0.11, 0.2), 3); })],
  // Sunlight: an ally's next hit on a target Leona marked deals bonus magic damage (counted on her hit)
  Leona: [{ id: "p-leona", spellHit: (c, v) => { if (ready(c, `leo${v.i}`)) { use(c, `leo${v.i}`, 2.5); hit(c, v, M(lvl(c, 32, 151) * 0.8)); } } }],
  MissFortune: [perTarget(4, (c, t) => hit(c, t, P(st(c).ad * lvl(c, 0.5, 1))))],
  Naafiri: [onHit((c) => P(lvl(c, 10, 40) + 0.1 * st(c).bad))],
  LeeSin: [afterCast(2, () => {}, 2, 40)],
  Braum: [{
    id: "p-braum",
    attack: (c, t, n) => braum(c, t, n),
    spellHit: (c, v) => braum(c, v, 1),
  }],
  Xayah: [afterCast(3, (c, t, k) => hit(c, t, P(st(c).ad * 0.3 * k)), 5)],
  Trundle: [{ id: "p-trundle", nearbyDeath: (c, v) => heal(c.e, c.u, v.maxHp * lvl(c, 0.018, 0.055)) }],
  Yone: [statsFx((_e, _u, _p, s) => { const c2 = s.crit * 2; s.crit = Math.min(1, c2); if (c2 > 1) { s.ad += (c2 - 1) * 50; s.bad += (c2 - 1) * 50; } })],
  Caitlyn: [everyN(6, (c) => { const s = st(c); return P(s.ad * (lvl(c, 0.6, 1.2) + 1.4875 * s.crit)); })],
  Sejuani: [
    statsFx((e, _u, p, s) => { if (!inFight(e, p) || e.t - p.combatFrom < 3) { s.ar += 10 + 0.75 * s.bar; s.mr += 10 + 0.75 * s.bmr; } }),
    { id: "p-seju", cc: (c, v, type) => { if (type === "stun" && ready(c, `sj${v.i}`)) { use(c, `sj${v.i}`, 6); hit(c, v, M(v.maxHp * 0.1)); } } },
  ],
  Renata: [perTarget(6, (c, t) => hit(c, t, M(t.maxHp * lvl(c, 0.01, 0.02) * 2 + t.maxHp * 0.02 * st(c).ap / 100)))],
  Jax: [statsFx((e, u, p, s) => { if (inFight(e, p)) addAs(u, s, byLevel(u, 40, 100) * Math.min(1, (e.t - p.combatFrom) / 2)); })],
  Seraphine: [{ id: "p-sera", out: (_c, _v, kind) => (kind === "spell" ? 1.12 : 1) }],
  Aatrox: [periodic(() => 6, (c, t) => { const d = M(t.maxHp * lvl(c, 0.04, 0.08)); hit(c, t, d); heal(c.e, c.u, Stats.mitigate(c.e, c.u, t, d) * 0.5); })],
  // Rebirth: an egg with full health for 6 s; if it survives, Anivia is back (4 min cooldown)
  Anivia: [{
    id: "p-anivia",
    lethal: (c) => {
      if (!ready(c, "egg")) return false;
      use(c, "egg", 240);
      c.u.hp = c.u.maxHp;
      c.p.until.egg = c.e.t + 6;
      c.u.stunUntil = Math.max(c.u.stunUntil, c.e.t + 6);
      return true;
    },
    stats: (e, u, p, s) => { if ((p.until.egg ?? -1) > e.t) { const r = byLevel(u, -40, 20); s.ar += r; s.mr += r; } },
  }],
  Sylas: [afterCast(1, (c, t, k) => {
    const s = st(c);
    const d = M((s.ad * 1.3 + 0.3 * s.ap) * k);
    for (const f of [t, ...foesNear(c.e, c.u, 300, t).filter((x) => x !== t)]) hit(c, f, d);
  }, 3, 125)],
  Akali: [{
    id: "p-akali",
    spellHit: (c) => { c.p.until.ring = c.e.t + 4; },
    attack: (c, t) => {
      if (!active(c, "ring") || !ready(c, "kama")) return;
      use(c, "kama", 4);
      const s = st(c);
      hit(c, t, M(lvl(c, 35, 182) + 0.6 * s.bad + 0.55 * s.ap));
    },
  }],
  Ziggs: [periodic(() => 5, (c, t) => hit(c, t, M(lvl(c, 20, 160) + 0.5 * st(c).ap)))],
  Zeri: [everyN(5, (c, t) => M(lvl(c, 75, 160) + 1.1 * st(c).ap + t.maxHp * lvl(c, 0.01, 0.11)))],
  Camille: [periodic(() => 12, (c) => shield(c.e, c.u, c.u.maxHp * 0.2, 2))],
  Shen: [{ id: "p-shen", cast: (c) => { if (ready(c, "ki")) { use(c, "ki", 8); shield(c.e, c.u, lvl(c, 47, 120) + 0.13 * st(c).bhp, 2.5); } } }],
  Maokai: [periodic(() => 6, (c) => { if (hpF(c.u) < 0.95) heal(c.e, c.u, c.u.maxHp * lvl(c, 0.04, 0.128)); })],
  Olaf: [statsFx((_e, u, _p, s) => { const f = Math.min(1, (1 - u.hp / u.maxHp) / 0.7); addAs(u, s, byLevel(u, 50, 100) * f); s.ls += byLevel(u, 0.08, 0.25) * f; })],
  // Transcendence (120 splinters) usually comes in the mid game
  Syndra: [statsFx((e, _u, _p, s) => { s.ap *= 1 + 0.15 * Math.min(1, Math.max(0, (minute(e) - 15) / 12)); })],
  Elise: [onHit((c) => M((12 + 30 * Math.min(1, c.u.level / 16) + 0.15 * st(c).ap) * 0.5)), {
    id: "p-elise-heal", attack: (c, _t, n) => heal(c.e, c.u, (6 + 6 * Math.min(1, c.u.level / 16) + 0.08 * st(c).ap) * 0.5 * n),
  }],
  // Masterwork items from about 14 minutes; Brittle on immobilize
  Ornn: [
    statsFx((e, _u, _p, s) => { if (minute(e) >= 14) { s.hp += 0.2 * s.bhp; s.ar += 0.2 * s.bar; s.mr += 0.2 * s.bmr; } }),
    { id: "p-ornn", cc: (c, v) => { if (ready(c, `orn${v.i}`)) { use(c, `orn${v.i}`, 8); hit(c, v, M(v.maxHp * lvl(c, 0.1, 0.18))); } } },
  ],
  Senna: [statsFx((e, _u, _p, s) => { const souls = Math.min(120, minute(e) * 2.2); s.ad += 0.75 * souls; s.bad += 0.75 * souls; s.crit = Math.min(1, s.crit + 0.1 * Math.floor(souls / 20)); })],
  Mel: [{ id: "p-mel", spellHit: (c, v) => { if (ready(c, `mel${v.i}`)) { use(c, `mel${v.i}`, 5); hit(c, v, M(lvl(c, 50, 80) + 0.1 * st(c).ap)); } } }],
  Lillia: [{
    id: "p-lillia",
    spellHit: (c, v) => {
      const s = st(c);
      dot(c, v, M(v.maxHp * (0.05 + 0.0125 * s.ap / 100)), 3, "dust");
      heal(c.e, c.u, (lvl(c, 6, 90) + 0.3 * s.ap) * 0.3);
    },
  }],
  Jinx: [{
    id: "p-jinx",
    stats: (e, _u, p, s) => { if ((p.until.excited ?? -1) > e.t) s.as *= 1 + 0.25 * (p.n.excited ?? 0); },
    takedown: (c) => { c.p.n.excited = Math.min(5, (active(c, "excited") ? c.p.n.excited ?? 0 : 0) + 1); c.p.until.excited = c.e.t + 6; },
  }],
  Gragas: [{ id: "p-gragas", cast: (c) => { if (ready(c, "grg")) { use(c, "grg", 8); heal(c.e, c.u, c.u.maxHp * 0.055); } } }],
  Blitzcrank: [{
    id: "p-blitz",
    hurt: (c, src, a) => {
      if (src && ready(c, "blitz") && c.u.hp + c.u.shield - a < c.u.maxHp * 0.3) { use(c, "blitz", 90); shield(c.e, c.u, st(c).mana * 0.35, 10); }
      return a;
    },
  }],
  Hwei: [{
    id: "p-hwei",
    spellHit: (c, v) => {
      if (active(c, `hw${v.i}`)) { c.p.until[`hw${v.i}`] = -1; hit(c, v, M(lvl(c, 35, 230) + 0.3 * st(c).ap)); }
      else c.p.until[`hw${v.i}`] = c.e.t + 4;
    },
  }],
  Thresh: [statsFx((e, _u, _p, s) => { const souls = Math.min(120, minute(e) * 1.1); s.ap += souls; s.ar += souls; })],
  Darius: [{
    // Hemorrhage: attacks and abilities bleed 5 stacks; at 5, Noxian Might (bonus AD)
    id: "p-darius",
    attack: (c, t, n) => darius(c, t, n),
    spellHit: (c, v) => darius(c, v, 1),
    stats: (e, u, p, s) => { if ((p.until.might ?? -1) > e.t) { const b = byLevel(u, 30, 230); s.ad += b; s.bad += b; } },
  }],
  // CommunityDragon game data (data/cdragon, 2026-11-25): attacks deal 5 : 40 (+ 10 % AP) to 10 : 80 (+ 20 % AP)
  // magic damage on-hit, rising with the target's missing health
  Locke: [onHit((c, t) => {
    const ap = st(c).ap;
    const lo = lvl(c, 5, 40) + 0.1 * ap, hi = lvl(c, 10, 80) + 0.2 * ap;
    return M(lo + (hi - lo) * (1 - hpF(t)));
  })],
  // Determination: hits on champions stack 1.5 : 2.8 % bonus AD (12 stacks, doubled when full); filled, Zaahen revives
  // (300 / 240 / 180 s by level, 30 / 45 / 60 % health after 4 s). R's passive: 10 / 20 / 30 % armor penetration.
  Zaahen: [{
    id: "p-zaahen",
    stats: (e, u, p, s) => {
      const r = Stats.rankOf(u, 3);
      if (r > 0) s.apen = 1 - (1 - s.apen) * (1 - 0.1 * r);
      if (!inFight(e, p)) return;
      const stacks = Math.min(12, (e.t - p.combatFrom) * 2.5);
      const b = s.bad * byLevel(u, 0.015, 0.028) * stacks * (stacks >= 12 ? 2 : 1);
      s.ad += b;
      s.bad += b;
    },
    lethal: (c) => {
      if (!ready(c, "zrevive") || combatTime(c) < 4.8) return false;
      const lv = c.u.level;
      use(c, "zrevive", lv >= 11 ? 180 : lv >= 6 ? 240 : 300);
      c.u.hp = c.u.maxHp * (lv >= 11 ? 0.6 : lv >= 6 ? 0.45 : 0.3);
      buff(c.e, c.u, "stasis", 1, 4);
      c.u.stunUntil = Math.max(c.u.stunUntil, c.e.t + 4);
      return true;
    },
  }],
};

function aurora(c: Ctx, t: Unit, add: number) {
  if (hitCount(c, t, add, 4, "aur") < 3) return;
  resetHits(c, t, "aur");
  const s = st(c);
  hit(c, t, M(t.maxHp * (0.03 + 0.015 * s.ap / 100)));
  heal(c.e, c.u, lvl(c, 3, 20) + 0.02 * s.ap);
}

function braum(c: Ctx, t: Unit, add: number) {
  if (!ready(c, `br${t.i}`)) return;
  if (hitCount(c, t, add, 4, "br") < 4) return;
  resetHits(c, t, "br");
  use(c, `br${t.i}`, 8);
  hit(c, t, M(lvl(c, 26, 196)));
  applyCC(c, t, "stun", lvl(c, 1.25, 1.75));
}

function darius(c: Ctx, t: Unit, add: number) {
  const stacks = Math.min(5, hitCount(c, t, add, 5, "bleed"));
  const s = st(c);
  dot(c, t, P((lvl(c, 13, 30) + 0.3 * s.bad) * stacks), 5, "hemorrhage");
  if (stacks >= 5) c.p.until.might = c.e.t + 5;
}

void T; void combatTime; void dist; void isMelee;
