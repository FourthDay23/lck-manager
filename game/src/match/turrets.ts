// Turrets, inhibitors and the nexus with the 2026 season's rules (2026-11-27). Before this a turret had a made-up
// health (3600 / 3800 / 4200 / 3200), no armor, plates only on the outer one until 14:00, and shot nothing but
// champions (the closest one in a fight). Values: League of Legends Wiki "Turret" and the patch 26.1 notes, checked
// against 502 LCK 2026 games (scripts/lck_turrets.py: 54 plates a game, five on every outer, inner and inhibitor turret).
//   health 9000 / 5000 / 4750 / 3500 (outer / inner / inhibitor / nexus), armor and magic resist 60 (outer: -15 a
//   minute from 11:00, 0 at 14:00); attack 182-350 / 187-427 / 187-427 / 165-405 by game time, 0.833 a second, range
//   750, 30 % armor penetration, +50 % per hit on a champion (up to +150 %, gone 5 s after the last one);
//   to minions a share of their full health per shot: melee 45 %, caster 70 %, siege 14 / 11 / 8 %, super 5 %.
//   Plates: five on outer, inner and inhibitor turrets for the whole game, broken at 10 / 25 / 45 / 70 / 100 % health
//   lost, 120 gold each to the champions nearby (outer: -10 a minute from 11:00, 80 at the least). Bulwark: at 90 / 75 /
//   55 / 30 % health the turret gets +30..50 armor and magic resist for 20 s (by enemy champions within 850).
//   Crystalline Overgrowth: 90 s after the last one, the next champion attack takes 2-3.3 % (level 1) to 8.8-18.9 %
//   (level 18) of the turret's full health as true damage (lowest for 60 s, then rising over 240 s).
//   Backdoor: -80 % damage (true damage too) with no enemy minions near, back on 3 s after the last one.
//   Champions hit for 100 % attack damage + 60 % ability power (magic when that part is larger), melee +20 %.
//   Inhibitor turrets regenerate 3 a second and nexus turrets 6 up to the top of their health bracket; nexus turrets
//   come back 3:00 after they fall at 40 % health. Inhibitor 4000 (+15 a second, back after 5:00), nexus 5500 (+20).
//   Gold: 50 / 25 / 25 / 50 to every player of the team, +300 for the game's first turret to those nearby.
// Targeting, as in the game: a turret keeps its target until it dies or leaves the range; a new one is the closest
// siege or super minion, then melee, then caster, then champion. While it is not on a champion, an enemy champion in
// range that damages one of its champions within 1400 of the turret becomes the target at once ("call for help").
import type { Engine, InhibState, SideN, TurretState, Unit } from "./engine";
import { DT } from "./engine";
import { clamp } from "../core/rng";
import { NEXUS, dist } from "./map";
import * as Fight from "./fight";
import * as Minions from "./minions";
import type { Minion, MinionKind } from "./minions";
import * as Stats from "./stats";

export const RANGE = 750;
export const INHIB_HP = 4000;
export const NEXUS_HP = 5500;
const HP = [0, 9000, 5000, 4750, 3500];
const PERIOD = 1 / 0.833;
const RESIST = 60;
const INHIB_REGEN = 15, NEXUS_REGEN = 20, STRUCT_ARMOR = 20;
/** health lost at which each of the five plates breaks */
const PLATE_AT = [0.1, 0.25, 0.45, 0.7, 1];
const PLATE_GOLD = 120;
/** health left at which a Bulwark stack starts */
const BULWARK_AT = [0.9, 0.75, 0.55, 0.3];
const OVERGROWTH_CD = 90;
const NEXUS_TURRET_RESPAWN = 180;
const GLOBAL_GOLD = [0, 50, 25, 25, 50];
const FIRST_TURRET_GOLD = 300;
/** a champion that hit one of the turret's champions this long ago still draws its fire */
const HELP_WINDOW = 1;
/** herald charge: the old 45 % of a 5000-health outer turret, kept as an amount now that the turret has 9000 */
export const HERALD_DAMAGE = 2250;

export function maxHp(tier: number): number {
  return HP[tier] ?? HP[4];
}
export function platesOf(tier: number): number {
  return tier <= 3 ? 5 : 0;
}

type Source = "champ" | "minion" | "herald" | "overgrowth";
export interface AggroEvent {
  t: number;
  turret: number;
  /** what it now shoots */
  target: "minion" | "champ";
  kind?: MinionKind;
  champ?: number;
  /** priority: closest of the highest class; help: it hit our champion (victim); nowave: no minions in range */
  why: "priority" | "help" | "nowave";
  victim?: number;
}
export interface TurretStats {
  /** shots by what they were aimed at */
  shots: Record<MinionKind | "champ", number>;
  /** shots at champions: called for help (it hit a champion of the turret's side) / no minions in range */
  champWhy: { help: number; nowave: number };
  champKills: number;
  plates: { t: number; tier: number; lane: string; side: SideN; paid: boolean }[];
  down: { t: number; tier: number; lane: string; side: SideN; champ: boolean }[];
  dmg: Record<Source, number>;
  /** damage that backdoor protection took off */
  backdoor: number;
  respawns: number;
}

interface TS {
  minion: Minion | null;
  champ: number;
  /** why it is on that champion */
  why: "help" | "nowave";
  nextShot: number;
  heat: number;
  heatAt: number;
  /** enemy minions (or the herald) were last near at */
  minionAt: number;
  bulwark: number[];
  bwIdx: number;
  /** Crystalline Overgrowth: ready since (lane turrets only) */
  ogAt: number;
  lastBy: number;
  lastByAt: number;
  respawnAt: number;
  /** how often it has fallen (a nexus turret that came back pays its gold only the first time) */
  falls: number;
}
interface Mod {
  t: TS[];
  idx: Map<TurretState, number>;
  stats: TurretStats;
  log: ((ev: AggroEvent) => void) | null;
}

export function init(e: Engine): void {
  const m: Mod = {
    t: e.turrets.map((t) => ({
      minion: null, champ: -1, why: "nowave", nextShot: 0, heat: 0, heatAt: -9, minionAt: -9, bulwark: [], bwIdx: 0,
      ogAt: t.tier <= 3 ? OVERGROWTH_CD : Infinity, lastBy: -1, lastByAt: -9, respawnAt: 0, falls: 0,
    })),
    idx: new Map(e.turrets.map((t, i) => [t, i])),
    stats: {
      shots: { melee: 0, caster: 0, siege: 0, super: 0, champ: 0 }, champWhy: { help: 0, nowave: 0 }, champKills: 0,
      plates: [], down: [], dmg: { champ: 0, minion: 0, herald: 0, overgrowth: 0 }, backdoor: 0, respawns: 0,
    },
    log: null,
  };
  e.mods.turrets = m;
}
function mod(e: Engine): Mod {
  let m = e.mods.turrets as Mod | undefined;
  if (!m) {
    init(e);
    m = e.mods.turrets as Mod;
  }
  return m;
}
export function stats(e: Engine): TurretStats {
  return mod(e).stats;
}
/** Every change of a turret's target (scripts/turret-diag.ts). */
export function setLog(e: Engine, fn: ((ev: AggroEvent) => void) | null): void {
  mod(e).log = fn;
}
/** The turret that is firing on this champion, if one is. */
export function aimingAt(e: Engine, u: Unit): TurretState | null {
  const M = mod(e);
  for (let i = 0; i < M.t.length; i++) if (M.t[i].champ === u.i && e.turrets[i].alive) return e.turrets[i];
  return null;
}

/** What turret `i` is shooting now (the renderer, scripts). */
export function targetOf(e: Engine, i: number): { minion: Minion | null; champ: number } {
  const s = mod(e).t[i];
  return { minion: s.minion && s.minion.hp > 0 ? s.minion : null, champ: s.champ };
}

// ---------------------------------------------------------------- numbers

/** Attack damage by game time: +12 from 0:30 and each minute to 350 at 13:30 (outer), +16 from 3:00 to 427 / 405 at 17:00. */
export function attackDamage(e: Engine, t: TurretState): number {
  if (t.tier === 1) return 182 + 12 * clamp(Math.floor((e.t - 30) / 60) + 1, 0, 14);
  return (t.tier === 4 ? 165 : 187) + 16 * clamp(Math.floor((e.t - 180) / 60) + 1, 0, 15);
}

function resist(e: Engine, t: TurretState, S: TS): number {
  let r = RESIST;
  if (t.tier === 1) r -= 15 * clamp(Math.floor((e.t - 660) / 60) + 1, 0, 4);
  if (S.bulwark.length) {
    S.bulwark = S.bulwark.filter((x) => x > e.t);
    if (S.bulwark.length) {
      let n = 0;
      for (const u of e.units) if (u.alive && u.side !== t.side && dist(u, t.pos) < 850) n++;
      r += S.bulwark.length * (30 + 5 * clamp(n - 1, 0, 4));
    }
  }
  return r;
}

/** Lane turrets fall in order; the nexus turrets can be hit while an inhibitor is down. */
export function vulnerable(e: Engine, t: TurretState): boolean {
  if (t.lane === "nexus") return e.inhibs.some((x) => x.side === t.side && !x.alive);
  for (const o of e.turrets) if (o.alive && o.side === t.side && o.lane === t.lane && o.tier < t.tier) return false;
  return true;
}

function backdoor(e: Engine, t: TurretState, S: TS): boolean {
  if (Minions.anyNear(e, t.pos, 1000, (1 - t.side) as SideN)) S.minionAt = e.t;
  return e.t - S.minionAt > 3;
}

/** Overgrowth damage as a share of the turret's full health, by the attackers' average level and how long it grew. */
function overgrowth(e: Engine, side: SideN, age: number): number {
  let lv = 0;
  for (const u of e.units) if (u.side === side) lv += u.level / 5;
  const k = clamp((lv - 1) / 17, 0, 1);
  const lo = 0.02 + (0.088 - 0.02) * k, hi = 0.033 + (0.189 - 0.033) * k;
  return lo + (hi - lo) * clamp((age - 60) / 240, 0, 1);
}

/** A champion's basic attacks on a structure per second and their type: 100 % attack damage + 60 % ability power,
 *  magic when that part is the larger one, melee +20 %. No critical strikes. */
function champRaw(e: Engine, u: Unit): { raw: number; type: "p" | "m" } {
  if (!e.realStats()) return { raw: e.aaDps(u), type: "p" };
  const s = Stats.stats(e, u);
  return { raw: (s.ad + 0.6 * s.ap) * s.as * (u.champ.ranged ? 1 : 1.2), type: s.bad > 0.6 * s.ap || s.ap <= 0 ? "p" : "m" };
}

// ---------------------------------------------------------------- damage to structures

/**
 * Damage to a turret before its resistances ("t": true damage). Handles the order turrets fall in, backdoor
 * protection, Bulwark, the plates and their gold, and the fall itself. Returns what it took.
 */
export function hit(e: Engine, t: TurretState, raw: number, type: "p" | "m" | "t", src: Unit | null, how: Source): number {
  if (!t.alive || raw <= 0 || !vulnerable(e, t)) return 0;
  const M = mod(e);
  const S = M.t[M.idx.get(t)!];
  let dmg = raw;
  if (type !== "t") {
    let r = resist(e, t, S);
    if (src && e.realStats()) {
      const s = Stats.stats(e, src);
      r = type === "p" ? r * (1 - s.apen) - s.leth : r * (1 - s.mpenPct) - s.mpen;
    }
    dmg *= 100 / (100 + Math.max(0, r));
  }
  if (how === "minion" || how === "herald") S.minionAt = e.t;
  else if (backdoor(e, t, S)) {
    M.stats.backdoor += dmg * 0.8;
    dmg *= 0.2;
  }
  t.hp -= dmg;
  M.stats.dmg[how] += dmg;
  if (src) { S.lastBy = src.i; S.lastByAt = e.t; }
  if (t.tier <= 3) {
    while (S.bwIdx < BULWARK_AT.length && t.hp <= t.maxHp * BULWARK_AT[S.bwIdx]) {
      S.bwIdx++;
      S.bulwark.push(e.t + 20);
      if (S.bulwark.length > 4) S.bulwark.shift();
    }
    while (t.plates > 0 && t.hp <= t.maxHp * (1 - PLATE_AT[5 - t.plates]) + 1e-6) {
      t.plates--;
      plateGold(e, M, t);
    }
  }
  if (t.hp <= 0) {
    t.hp = 0;
    const by = src ?? (e.t - S.lastByAt < 10 && S.lastBy >= 0 ? e.units[S.lastBy] : null);
    M.stats.down.push({ t: e.t, tier: t.tier, lane: t.lane, side: t.side, champ: !!by });
    S.minion = null;
    S.champ = -1;
    if (t.lane === "nexus") S.respawnAt = e.t + NEXUS_TURRET_RESPAWN;
    e.turretDown(t, by);
  }
  return dmg;
}

function plateGold(e: Engine, M: Mod, t: TurretState) {
  const gold = PLATE_GOLD - (t.tier === 1 ? 10 * clamp(Math.floor((e.t - 660) / 60) + 1, 0, 4) : 0);
  const near = e.units.filter((u) => u.alive && u.side !== t.side && dist(u, t.pos) < 2000);
  for (const u of near) u.gold += gold / near.length;
  M.stats.plates.push({ t: e.t, tier: t.tier, lane: t.lane, side: t.side, paid: near.length > 0 });
}

/** Gold for a destroyed turret (engine.turretDown): the team's share, and the first turret's bonus to those nearby. */
export function payout(e: Engine, t: TurretState, first: boolean): void {
  const side = (1 - t.side) as SideN;
  const team = e.units.filter((u) => u.side === side);
  const M = mod(e);
  if (M.t[M.idx.get(t)!].falls++ > 0) return;
  for (const u of team) u.gold += GLOBAL_GOLD[t.tier] ?? 0;
  if (first) {
    const near = team.filter((u) => u.alive && dist(u, t.pos) < 2500);
    const to = near.length ? near : team;
    for (const u of to) u.gold += FIRST_TURRET_GOLD / to.length;
  }
}

/** The herald's charge (engine.heraldTick). */
export function heraldHit(e: Engine, t: TurretState, by: Unit | null): void {
  hit(e, t, HERALD_DAMAGE, "t", by, "herald");
}

export function hitInhib(e: Engine, ih: InhibState, raw: number, by: SideN, src: Unit | null): number {
  if (!ih.alive || raw <= 0) return 0;
  if (e.turrets.some((t) => t.alive && t.side === ih.side && t.lane === ih.lane)) return 0;
  const dmg = raw * (100 / (100 + STRUCT_ARMOR));
  ih.hp -= dmg;
  void src;
  if (ih.hp <= 0) e.destroyInhib(ih, by);
  return dmg;
}

/** The nexus can be hit once both of its turrets are down and an inhibitor is. */
export function hitNexus(e: Engine, side: SideN, raw: number, by: SideN): number {
  if (e.over || raw <= 0) return 0;
  if (e.turrets.some((t) => t.alive && t.side === side && t.lane === "nexus")) return 0;
  if (!e.inhibs.some((x) => x.side === side && !x.alive)) return 0;
  const dmg = raw * (100 / (100 + STRUCT_ARMOR));
  e.nexus[side] -= dmg;
  if (e.nexus[side] <= 0) e.finish(by);
  return dmg;
}

// ---------------------------------------------------------------- one step (engine.lanesTick)

export function tick(e: Engine): void {
  const M = mod(e);
  // regeneration, and nexus turrets coming back
  e.turrets.forEach((t, i) => {
    const S = M.t[i];
    if (!t.alive) {
      if (S.respawnAt && e.t >= S.respawnAt) {
        S.respawnAt = 0;
        t.alive = true;
        t.hp = t.maxHp * 0.4;
        S.heat = 0;
        S.nextShot = e.t + PERIOD;
        M.stats.respawns++;
        e.event("info", t.side, `${e.names[t.side]} 쌍둥이 포탑 재생성`, false, undefined, undefined, t.pos);
      }
      return;
    }
    if (t.tier < 3 || t.hp >= t.maxHp) return;
    const f = t.hp / t.maxHp;
    const top = t.tier === 3 ? (f <= 0.3 ? 0.3 : f <= 0.75 ? 0.75 : 1) : f <= 0.4 ? 0.4 : f <= 0.7 ? 0.7 : 1;
    if (f < top) t.hp = Math.min(t.maxHp * top, t.hp + (t.tier === 3 ? 3 : 6) * DT);
  });
  for (const ih of e.inhibs) if (ih.alive && ih.hp < INHIB_HP) ih.hp = Math.min(INHIB_HP, ih.hp + INHIB_REGEN * DT);
  for (const side of [0, 1] as SideN[]) if (e.nexus[side] < NEXUS_HP) e.nexus[side] = Math.min(NEXUS_HP, e.nexus[side] + NEXUS_REGEN * DT);
  // champions hitting a structure: the closest turret that can be hit, else an inhibitor, else the nexus
  for (const u of e.units) {
    if (!u.alive || u.fightId || u.recallEnd !== undefined || u.task === "recall" || e.t < u.stunUntil) continue;
    const foe = (1 - u.side) as SideN;
    let tg: TurretState | null = null, bd = RANGE;
    for (const t of e.turrets) {
      if (!t.alive || t.side === u.side) continue;
      const d = dist(t.pos, u);
      if (d < bd && vulnerable(e, t)) { bd = d; tg = t; }
    }
    if (tg) {
      champHit(e, M, u, tg);
      continue;
    }
    const c = champRaw(e, u);
    let done = false;
    for (const ih of e.inhibs) {
      if (!ih.alive || ih.side === u.side || dist(ih.pos, u) > 700) continue;
      if (hitInhib(e, ih, c.raw * DT * Minions.WAVE_TUNE.towerDmg, u.side, u) > 0) { done = true; break; }
    }
    if (!done && dist(NEXUS[foe], u) < 900) hitNexus(e, foe, c.raw * DT * Minions.WAVE_TUNE.towerDmg, u.side);
  }
}

function champHit(e: Engine, M: Mod, u: Unit, t: TurretState) {
  const S = M.t[M.idx.get(t)!];
  // Minions.WAVE_TUNE.towerDmg: the share of the time a champion in range is really hitting the turret. During laning a
  // defender next to it means trading and last hitting instead (WAVE_TUNE.laneSiege)
  let f = Minions.WAVE_TUNE.towerDmg;
  if (e.laningPhase() && e.units.some((d) => d.alive && d.side === t.side && dist(d, t.pos) < 1300)) f *= Minions.WAVE_TUNE.laneSiege;
  const c = champRaw(e, u);
  hit(e, t, c.raw * DT * f, c.type, u, "champ");
  // Crystalline Overgrowth goes off on a champion's attack (not under backdoor protection)
  if (t.alive && e.t >= S.ogAt && !backdoor(e, t, S) && e.rng.chance(Math.min(1, f * DT))) {
    const age = e.t - S.ogAt;
    S.ogAt = e.t + OVERGROWTH_CD;
    hit(e, t, t.maxHp * overgrowth(e, u.side, age), "t", u, "overgrowth");
  }
}

// ---------------------------------------------------------------- shots

const CLASS: Record<MinionKind, number> = { siege: 0, super: 0, melee: 1, caster: 2 };
const TO_MINION: Record<MinionKind, number[]> = { melee: [0.45, 0.45, 0.45, 0.45], caster: [0.7, 0.7, 0.7, 0.7], siege: [0.14, 0.11, 0.08, 0.08], super: [0.05, 0.05, 0.05, 0.05] };

/**
 * Every turret picks its target by the game's rules and fires when its attack is ready.
 * hurtChamp: how a champion takes the shot (fight.ts: shields, saves, kill credit); null: champions are not shot.
 * ready: a champion outside a fight has stood in range long enough to be fired on (SIM_TUNE.towerGrace, fight.ts).
 */
export function shots(e: Engine, hurtChamp: ((u: Unit, amount: number) => void) | null, ready: (u: Unit) => boolean): void {
  const M = mod(e);
  e.turrets.forEach((t, ti) => {
    const S = M.t[ti];
    if (!t.alive) return;
    const foe = (1 - t.side) as SideN;
    if (S.minion && (S.minion.hp <= 0 || dist(S.minion, t.pos) > RANGE)) S.minion = null;
    if (S.champ >= 0) {
      const c = e.units[S.champ];
      if (!c.alive || !Fight.hittable(e, c) || dist(c, t.pos) > RANGE + 30) S.champ = -1;
    }
    // a champion in range that just damaged one of ours near the turret
    if (S.champ < 0 && hurtChamp) {
      let best: Unit | null = null, at = -Infinity, victim = -1;
      for (const c of e.units) {
        if (!c.alive || c.side === t.side || !Fight.hittable(e, c) || dist(c, t.pos) > RANGE) continue;
        const h = Fight.lastChampHit(e, c);
        if (e.t - h.at > HELP_WINDOW || h.v < 0 || dist(e.units[h.v], t.pos) > 1400) continue;
        if (h.at > at) { at = h.at; best = c; victim = h.v; }
      }
      if (best) {
        S.champ = best.i;
        S.why = "help";
        S.minion = null;
        M.log?.({ t: e.t, turret: ti, target: "champ", champ: best.i, why: "help", victim });
      }
    }
    if (S.champ < 0 && !S.minion) {
      // closest of the highest class: siege / super, melee, caster, then a champion
      let bm: Minion | null = null, bc = 9, bd = Infinity;
      for (const m of Minions.list(e)) {
        if (m.side !== foe || m.hp <= 0 || Math.abs(m.x - t.pos.x) > RANGE || Math.abs(m.y - t.pos.y) > RANGE) continue;
        const d = dist(m, t.pos);
        if (d > RANGE) continue;
        const c = CLASS[m.kind];
        if (c < bc || (c === bc && d < bd)) { bm = m; bc = c; bd = d; }
      }
      if (bm) {
        S.minion = bm;
        S.minionAt = e.t;
        M.log?.({ t: e.t, turret: ti, target: "minion", kind: bm.kind, why: "priority" });
      } else if (hurtChamp) {
        let best: Unit | null = null;
        bd = RANGE;
        for (const c of e.units) {
          if (!c.alive || c.side === t.side || !Fight.hittable(e, c)) continue;
          const d = dist(c, t.pos);
          if (d > bd || (!c.fightId && !ready(c))) continue;
          bd = d;
          best = c;
        }
        if (best) {
          S.champ = best.i;
          S.why = "nowave";
          M.log?.({ t: e.t, turret: ti, target: "champ", champ: best.i, why: "nowave" });
        }
      }
    } else if (S.minion) S.minionAt = e.t;
    if (e.t < S.nextShot || (S.champ < 0 && !S.minion)) return;
    S.nextShot = e.t + PERIOD;
    const color = t.side ? "#ff6b6b" : "#6ba8ff";
    if (S.champ >= 0 && hurtChamp) {
      const c = e.units[S.champ];
      if (e.t - S.heatAt > 5) S.heat = 0;
      // 30 % armor penetration; each hit on a champion makes the next one 50 % stronger, up to +150 %
      const mit = e.realStats() ? 100 / (100 + Stats.stats(e, c).ar * 0.7) : 0.75;
      const dmg = attackDamage(e, t) * (1 + 0.5 * S.heat) * mit;
      S.heat = Math.min(3, S.heat + 1);
      S.heatAt = e.t;
      M.stats.shots.champ++;
      M.stats.champWhy[S.why]++;
      e.fx_({ kind: "tower", side: t.side, x: t.pos.x, y: t.pos.y, tx: c.x, ty: c.y, color, r: 0, w: 0, to: c.i });
      hurtChamp(c, dmg);
      if (!c.alive) M.stats.champKills++;
    } else if (S.minion) {
      const m = S.minion;
      M.stats.shots[m.kind]++;
      e.fx_({ kind: "tower", side: t.side, x: t.pos.x, y: t.pos.y, tx: m.x, ty: m.y, color, r: 0, w: 0 });
      Minions.hurt(e, m, m.maxHp * TO_MINION[m.kind][t.tier - 1] * (m.emp ? 0.7 : 1), "turret");
      if (m.hp <= 0) S.minion = null;
    }
  });
}
