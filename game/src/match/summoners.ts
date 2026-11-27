// Summoner spells (owner: combat-stats session; the match view session added Teleport, Ghost, the shared cooldown
// state and the effects the renderer and the HUD read, 2026-11-27).
// Which pair each player takes: summoners.gen.ts, the most taken pair of that champion in that role in the 2026 LCK
// games (scripts/build_combat_ref.py), else the role's.
//  * Ignite, Exhaust, Heal, Barrier, Cleanse, Ghost: a simple use rule each inside fights (the fight AI's stand-in).
//  * Flash: engine.flashToward (escapes: engine.tryFlash; a flash engage: fight.ts engagerAct).
//  * Smite: the objective last hit (engine.objectivesTick).
//  * Teleport: teleportTick below, called first thing for every living unit.
// Every use goes through spend(): it starts the cooldown the HUD shows and queues an effect for the renderer
// (Fx.sum). Cooldowns from LoL; Ionian Boots of Lucidity give 10 summoner spell haste.
import type { Engine, Unit } from "./engine";
import * as Items from "./items";
import { FOUNTAIN, LANES, lanePoint } from "./map";
import type { Vec } from "./map";
import * as Nav from "./nav";
import { SUMMONER_PAIRS, ROLE_PAIRS } from "./summoners.gen";
import type { SummonerName } from "./summoners.gen";
import { T, alliesNear, buff, byLevel, dist, dot, foesNear, grievous, heal, hpF, inStasis, ready, shield, state } from "./procs-lib";
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
/** Seconds. Smite has two charges in LoL; here it is its 15 s between uses, so the HUD shows it was just used. */
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
 */
export const SUM_TUNE = {
  tpLane: 0.55, tpLaneLate: 0, tpPlay: 0.9, tpJoin: 0.5, tpMin: 7000, tpSave: 3500, tpChannel: 4,
  ghostSpeed: 1.3, ghostTime: 10,
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
export const readyAt = (e: Engine, u: Unit, s: SummonerName) => state(e, u).cd[s] ?? 0;
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
 * A summoner spell goes on cooldown. Unless `quiet` (the caller draws its own effect and tags it with Fx.sum), an
 * effect is queued for the renderer: from the caster to `to` / `at`.
 */
export function spend(e: Engine, u: Unit, s: SummonerName, o: { to?: Unit | null; at?: Vec; why?: string; quiet?: boolean } = {}) {
  state(e, u).cd[s] = e.t + cooldown(e, u, s);
  const key = o.why ? `${s}:${o.why}` : s;
  const m = usage(e);
  m[key] = (m[key] ?? 0) + 1;
  if (o.quiet) return;
  const p = o.at ?? o.to ?? u;
  e.fx_({ kind: "sum", side: u.side, x: u.x, y: u.y, tx: p.x, ty: p.y, color: COLOR[s], r: 0, w: 0, from: u.i, to: o.to?.i, sum: s, text: SUMMONER_KO[s] });
}

/** For the HUD: the player's two spells, seconds left on each (0 = up) and whether it is being channelled right now. */
export function slots(e: Engine, u: Unit): { name: SummonerName; left: number; busy: boolean }[] {
  return summonersOf(u).map((name) => ({
    name, left: Math.max(0, readyAt(e, u, name) - e.t), busy: name === "teleport" && !!(u as TpUnit).tp && u.alive,
  }));
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
