// Keystone runes as combat effects (owner: combat-stats session). Numbers from Data Dragon 16.23.1
// runesReforged_ko_KR.json. Which keystone a player runs comes from items.ts (the LCK pick or the coach's).
// What each rune produced in the real games (scripts/real-dmg.json `keystones`, var1 per minute) is the check.
import * as Stats from "./stats";
import {
  M, active, adaptive, alliesNear, buff, byLevel, combatTime, dot, foesNear, heal, hit, hitCount, hpF, inCombat,
  isMelee, nth, ready, resetHits, shield, use,
} from "./procs-lib";
import type { Ctx, Effect } from "./procs-lib";
import type { Unit } from "./engine";
import { addAs } from "./itemfx";

const st = (c: Ctx) => Stats.stats(c.e, c.u);
const lvl = (c: Ctx, a: number, b: number) => byLevel(c.u, a, b);
const IMMOBILE = new Set(["stun", "root", "knockup", "knockback", "pull", "charm", "taunt", "fear", "sleep", "suppress", "polymorph", "arena"]);

/** 3 separate hits (attacks or abilities) on one champion within 3 s. */
function electrocute(c: Ctx, t: Unit, add: number) {
  if (!ready(c, "elec")) return;
  if (hitCount(c, t, add, 3, "elec") < 3) return;
  use(c, "elec", 20);
  resetHits(c, t, "elec");
  const s = st(c);
  hit(c, t, adaptive(c.e, c.u, lvl(c, 70, 240) + 0.1 * s.bad + 0.05 * s.ap));
}

function conquerorStack(c: Ctx, add: number) {
  c.p.n.conq = Math.min(12, (active(c, "conq") ? c.p.n.conq ?? 0 : 0) + add);
  c.p.until.conq = c.e.t + 5;
}

function aery(c: Ctx, t: Unit) {
  if (!ready(c, "aery")) return;
  use(c, "aery", 2.5);
  const s = st(c);
  hit(c, t, adaptive(c.e, c.u, lvl(c, 10, 50) + 0.05 * s.ap + 0.1 * s.bad));
}

export const RUNE_FX: Record<number, Effect> = {
  8112: { id: "electrocute", attack: (c, t, n) => electrocute(c, t, n), spellHit: (c, v) => electrocute(c, v, 1) },
  8128: {
    id: "darkharvest",
    dealt: (c, v) => {
      if (!v.alive || hpF(v) >= 0.5 || !ready(c, "dh")) return;
      use(c, "dh", 35);
      const s = st(c);
      hit(c, v, adaptive(c.e, c.u, 30 + 11 * (c.p.n.souls ?? 0) + 0.1 * s.bad + 0.05 * s.ap));
      c.p.n.souls = (c.p.n.souls ?? 0) + 1;
    },
    takedown: (c) => { if ((c.p.cd.dh ?? -1) > c.e.t + 1) c.p.cd.dh = c.e.t + 1; },
  },
  9923: {
    id: "hailofblades",
    stats: (e, u, p, s) => { if ((p.until.hob ?? -1) > e.t && (p.n.hobLeft ?? 0) > 0) addAs(u, s, isMelee(u) ? 90 : 60); },
    attack: (c, t, n) => {
      if (ready(c, "hob") && inCombat(c)) { use(c, "hob", 10); c.p.until.hob = c.e.t + 3; c.p.n.hobLeft = 3; }
      if (active(c, "hob") && (c.p.n.hobLeft ?? 0) > 0) {
        const k = Math.min(n, c.p.n.hobLeft ?? 0);
        c.p.n.hobLeft = (c.p.n.hobLeft ?? 0) - n;
        const s = st(c);
        hit(c, t, { p: 0, m: 0, t: (lvl(c, 2, 20) + 0.12 * s.bad + 0.1 * s.ap) * k });
      }
    },
  },
  8351: {
    id: "glacial",
    cc: (c, v, type, dur) => {
      if (!IMMOBILE.has(type) || !ready(c, "glacial")) return;
      use(c, "glacial", 25);
      for (const f of foesNear(c.e, c.u, 500, v)) buff(c.e, f, "weaken", 0.15, 3 + dur);
    },
  },
  8360: { id: "spellbook" },
  8369: {
    id: "firststrike",
    out: (c) => {
      if (combatTime(c) <= 0.3 && ready(c, "fs")) { use(c, "fs", lvl(c, 25, 15)); c.p.until.fsOn = c.e.t + 3; }
      return active(c, "fsOn") ? 1.07 : 1;
    },
    dealt: (c, _v, a) => { if (active(c, "fsOn")) c.u.gold += a * 0.07 * (isMelee(c.u) ? 0.5 : 0.35); },
  },
  8005: {
    id: "pta",
    attack: (c, t, n) => {
      if (active(c, "ptaOn")) { c.p.until.ptaOn = c.e.t + 3; return; }
      if (hitCount(c, t, n, 4, "pta") < 3) return;
      resetHits(c, t, "pta");
      hit(c, t, adaptive(c.e, c.u, lvl(c, 40, 160)));
      c.p.until.ptaOn = c.e.t + 3;
    },
    out: (c) => (active(c, "ptaOn") ? 1.08 : 1),
  },
  8008: {
    id: "lethaltempo",
    stats: (e, u, p, s) => { if ((p.until.lt ?? -1) > e.t) addAs(u, s, (p.n.lt ?? 0) * (isMelee(u) ? 6 : 4)); },
    attack: (c, t, n) => {
      c.p.n.lt = Math.min(6, (active(c, "lt") ? c.p.n.lt ?? 0 : 0) + n);
      c.p.until.lt = c.e.t + 6;
      if ((c.p.n.lt ?? 0) >= 6) {
        const s = st(c);
        const base = isMelee(c.u) ? lvl(c, 9, 30) : lvl(c, 6, 24);
        const bonusAs = Math.max(0, (s.as / Stats.champStats(c.u.champ.id).as - 1) * 100);
        hit(c, t, adaptive(c.e, c.u, base * (1 + bonusAs / 100) * n));
      }
    },
  },
  8021: {
    id: "fleet",
    attack: (c, t, n) => {
      if (!nth(c, t, n, 4, "fleet") || !ready(c, "fleet")) return;
      use(c, "fleet", 4);
      const s = st(c);
      heal(c.e, c.u, (lvl(c, 15, 160) + 0.1 * s.bad + 0.05 * s.ap) * (isMelee(c.u) ? 1 : 0.6));
    },
  },
  8010: {
    id: "conqueror",
    stats: (e, u, p, s) => {
      if ((p.until.conq ?? -1) <= e.t) return;
      const af = byLevel(u, 1.8, 4) * (p.n.conq ?? 0);
      if (s.bad >= s.ap * 0.6 && u.champ.damage !== "AP") { s.ad += af * 0.6; s.bad += af * 0.6; }
      else s.ap += af;
    },
    attack: (c, _t, n) => conquerorStack(c, n * (isMelee(c.u) ? 2 : 1)),
    spellHit: (c) => conquerorStack(c, 2),
    dealt: (c, _v, a) => { if ((c.p.n.conq ?? 0) >= 12 && active(c, "conq")) heal(c.e, c.u, a * (isMelee(c.u) ? 0.08 : 0.05)); },
  },
  8437: {
    id: "grasp",
    stats: (_e, _u, p, s) => { s.hp += p.n.grasp ?? 0; },
    attack: (c, t) => {
      if (combatTime(c) < 4 || !ready(c, "grasp")) return;
      use(c, "grasp", 4);
      const r = isMelee(c.u) ? 1 : 0.4;
      hit(c, t, M(c.u.maxHp * 0.035 * r));
      heal(c.e, c.u, c.u.maxHp * 0.013 * r);
      c.p.n.grasp = (c.p.n.grasp ?? 0) + 5 * r;
    },
  },
  8439: {
    id: "aftershock",
    stats: (e, u, p, s) => {
      if ((p.until.after ?? -1) <= e.t) return;
      const cap = byLevel(u, 80, 150);
      s.ar += Math.min(cap, 45 + 0.75 * s.bar);
      s.mr += Math.min(cap, 45 + 0.75 * s.bmr);
    },
    cc: (c, v, type) => {
      if (!IMMOBILE.has(type) || !ready(c, "after")) return;
      use(c, "after", 20);
      c.p.until.after = c.e.t + 2.5;
      c.p.n.afterX = v.x;
      c.p.n.afterY = v.y;
      c.p.n.afterBoom = 1;
    },
    tick: (c) => {
      if (!c.p.n.afterBoom || active(c, "after")) return;
      c.p.n.afterBoom = 0;
      for (const f of foesNear(c.e, c.u, 350)) hit(c, f, M(lvl(c, 25, 120) + 0.08 * st(c).bhp));
    },
  },
  8465: {
    id: "guardian",
    tick: (c) => {
      if (!c.u.fightId || !ready(c, "guardian")) return;
      const a = alliesNear(c.e, c.u, 350).filter((x) => x.fightId && hpF(x) < 0.7).sort((x, y) => hpF(x) - hpF(y))[0];
      if (!a) return;
      use(c, "guardian", lvl(c, 75, 40));
      const s = st(c);
      const amt = lvl(c, 40, 150) + 0.2 * s.ap + 0.06 * s.bhp;
      shield(c.e, a, amt, 1.5);
      if (a !== c.u) shield(c.e, c.u, amt, 1.5);
    },
  },
  8214: {
    id: "aery",
    attack: (c, t) => aery(c, t),
    spellHit: (c, v) => aery(c, v),
    support: (c, ally) => {
      if (!ready(c, "aery")) return;
      use(c, "aery", 2.5);
      const s = st(c);
      shield(c.e, ally, lvl(c, 20, 100) + 0.05 * s.ap + 0.1 * s.bad, 2);
    },
  },
  8229: {
    id: "comet",
    spellHit: (c, v) => {
      if (!ready(c, "comet")) return;
      use(c, "comet", lvl(c, 20, 8));
      const s = st(c);
      // distance travelled amplifies up to 100 %; about a fifth of comets miss a moving target
      hit(c, v, adaptive(c.e, c.u, (lvl(c, 15, 100) + 0.05 * s.ap + 0.1 * s.bad) * 1.5 * 0.8));
    },
  },
  8230: { id: "phaserush" },
  8992: {
    id: "deathfire",
    spellHit: (c, v) => {
      const s = st(c);
      const perSec = lvl(c, 3, 12) + 0.025 * s.ap + 0.07 * s.bad;
      dot(c, v, M(perSec * 4 * (active(c, `df${v.i}`) ? 1.75 : 1)), 4, "deathfire");
      c.p.until[`df${v.i}`] = c.e.t + 4;
    },
  },
};
