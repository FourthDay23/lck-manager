// Summoner spells in fights (owner: combat-stats session). Which pair each player takes: summoners.gen.ts, the most
// taken pair of that champion in that role in the 2026 LCK games (scripts/build_combat_ref.py), else the role's.
// Flash, Smite and Teleport stay with the engine (engine.tryFlash, objective smite, lane / macro movement); this file
// adds Ignite, Exhaust, Heal, Barrier and Cleanse with a simple use rule each (the fight AI's stand-in).
// Cooldowns from LoL; Ionian Boots of Lucidity give 10 summoner spell haste.
import type { Engine, Unit } from "./engine";
import * as Items from "./items";
import { SUMMONER_PAIRS, ROLE_PAIRS } from "./summoners.gen";
import type { SummonerName } from "./summoners.gen";
import { T, alliesNear, buff, byLevel, dot, foesNear, grievous, heal, hpF, inStasis, ready, shield, use } from "./procs-lib";
import type { Ctx, Effect } from "./procs-lib";

export function summonersOf(u: Unit): SummonerName[] {
  return SUMMONER_PAIRS[u.champ.id]?.[u.role] ?? ROLE_PAIRS[u.role] ?? ["flash"];
}

function haste(c: Ctx): number {
  const owned = Items.unitItems(c.e, c.u);
  return owned?.items.includes(3158) ? 100 / 110 : 1;
}
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
      use(c, "ignite", 180 * haste(c));
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
      use(c, "exhaust", 240 * haste(c));
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
      use(c, "heal", 240 * haste(c));
      const amt = byLevel(c.u, 80, 318);
      heal(c.e, c.u, amt);
      const other = low.find((a) => a !== c.u);
      if (other) heal(c.e, other, amt);
    },
  },
  barrier: {
    id: "barrier",
    tick: (c) => {
      if (!fighting(c) || !ready(c, "barrier") || hpF(c.u) >= 0.3 || !foesNear(c.e, c.u, 900).length) return;
      use(c, "barrier", 180 * haste(c));
      shield(c.e, c.u, byLevel(c.u, 120, 480), 2.5);
    },
  },
  cleanse: {
    id: "cleanse",
    tick: (c) => {
      // never on its own save (a stasis is a stun here too)
      if (!fighting(c) || !ready(c, "cleanse") || c.u.stunUntil - c.e.t < 0.75 || inStasis(c.e, c.u)) return;
      use(c, "cleanse", 240 * haste(c));
      c.u.stunUntil = c.e.t;
      c.p.until.cleanse = c.e.t + 3;
    },
  },
};

export function summonerFx(_e: Engine, u: Unit): Effect[] {
  return summonersOf(u).map((s) => FX[s]).filter((x): x is Effect => !!x);
}
