// Match engine: 10 champions on Summoner's Rift, 0.25 s ticks of game time.
// Positions follow the pro heatmap (where each role stands at each minute), lanes have minion fronts,
// junglers clear camps on real timers, fights resolve spell by spell. The renderer only reads this state.
import type { GameData } from "../data/load";
import type { ChampionData, Role, SpellData, VfxKind } from "../data/types";
import { ROLES, ROLE_KO } from "../data/types";
import { Rng, clamp } from "../core/rng";
import { josa } from "../core/format";
import type { GameState, Player } from "../core/types";
import { ovr } from "../core/player";
import { coachBonus, fatiguePenalty, starterFatigue } from "../core/quick";
import { compBonus, mastery } from "./draft";
import { metaBonus } from "../core/meta";
import {
  BARON_PIT, CAMPS_BLUE, CAMP_POS_RED, DRAGON_PIT, FOUNTAIN, INHIBS, LANES, LANE_PATH, NEXUS, ROLE_LANE, SCUTTLE, TURRETS,
  dist, findPath, laneU, lanePoint, mirror, sampleHeat, initMap,
} from "./map";
import type { CampKind, LaneId, Vec } from "./map";
import * as Nav from "./nav";
import * as Macro from "./macro";
import * as Fight from "./fight";
import * as Items from "./items";
import type { SideLoadout } from "./items";
import type { Strategy } from "./strategy";
import { defaultStrategy } from "./strategy";

export const DT = 0.25;
export type SideN = 0 | 1;

/**
 * Feature switches for the engine rework (2026-11-26). Each module (nav = walls & paths, macro = team plans &
 * objectives, fight = teamfights with champion kits) is wired in behind its flag so it can be tested on its own;
 * test scripts may flip these at runtime. With a flag off the engine runs the old code path.
 */
export const ENGINE_FLAGS = { nav: true, macro: true, fight: true };

export interface Unit {
  i: number;
  side: SideN;
  role: Role;
  pid: string;
  name: string;
  champ: ChampionData;
  rating: number;
  x: number;
  y: number;
  path: Vec[];
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnAt: number;
  level: number;
  xp: number;
  gold: number;
  cs: number;
  k: number;
  d: number;
  a: number;
  streak: number;
  multi: { n: number; last: number };
  cds: number[];
  stunUntil: number;
  shield: number;
  task: "lane" | "jungle" | "roam" | "recall" | "obj" | "fight" | "siege" | "return" | "gank" | "group";
  taskUntil: number;
  goal: Vec | null;
  campTarget?: number;
  objTarget?: ObjKey;
  recallEnd?: number;
  lastHitBy: Map<number, number>;
  baronUntil: number;
  elderUntil: number;
  dmg: number;
  fightId: number;
}

export type ObjKey = "dragon" | "grubs" | "herald" | "baron" | "elder";
export const OBJ_KO: Record<ObjKey, string> = { dragon: "드래곤", grubs: "공허 유충", herald: "협곡의 전령", baron: "내셔 남작", elder: "장로 드래곤" };

export interface ObjState { key: ObjKey; alive: boolean; spawnAt: number | null; hp: number; maxHp: number; pos: Vec; takenBy?: SideN; type?: string; left?: number }
export interface CampState { id: number; side: SideN; kind: CampKind | "scuttle"; pos: Vec; alive: boolean; spawnAt: number; hp: number; maxHp: number }
export interface TurretState { side: SideN; lane: LaneId | "nexus"; tier: number; pos: Vec; hp: number; maxHp: number; alive: boolean; u: number; plates: number }
export interface InhibState { side: SideN; lane: LaneId; pos: Vec; hp: number; alive: boolean; respawnAt: number }
export interface LaneState { id: LaneId; front: number }

export interface Fx {
  t: number;
  id: number;
  kind: VfxKind | "aa" | "kill" | "tower" | "recall" | "smite" | "objhit" | "level" | "hit";
  side: SideN;
  /** skills: caster position (dash/blink: landing point); hit: victim position */
  x: number; y: number;
  /** skills: aim point (dash/blink: start point) */
  tx: number; ty: number;
  color: string;
  r: number;
  w: number;
  from?: number;
  to?: number;
  text?: string;
  // ---- contract with vfx.ts (agreed with the VFX session, all optional) ----
  key?: "Q" | "W" | "E" | "R";
  icon?: string;
  also?: VfxKind;
  /** cast against jungle monsters / minions: drawn small and faint */
  pve?: boolean;
  /** the skill missed its main target (`to`) */
  miss?: boolean;
  /** lingering zones/walls: engine time t when it ends */
  until?: number;
}

export type EvType =
  | "kill" | "first_blood" | "solo" | "double" | "triple" | "quadra" | "penta" | "ace" | "shutdown"
  | "dragon" | "soul" | "elder" | "grubs" | "herald" | "baron" | "steal" | "turret" | "first_turret" | "inhib" | "nexus" | "info";

export interface GameEvent { t: number; type: EvType; side: SideN; text: string; actor?: number; victim?: number; big: boolean; x?: number; y?: number }

export interface EngineSetup {
  s: GameState;
  data: GameData;
  blue: string;
  red: string;
  picks: { blue: Partial<Record<Role, string>>; red: Partial<Record<Role, string>> };
  seed: number;
  tactic?: [Tactic, Tactic];
  /** macro game plan chosen before the game (user side) or by the AI coach; see strategy.ts */
  strategy?: [Strategy | null, Strategy | null];
  /** builds / keystones per side (items.ts); missing = each champion's most played LCK option */
  loadout?: [SideLoadout | undefined, SideLoadout | undefined];
}
export type Tactic = "aggressive" | "standard" | "safe";

const DRAGON_TYPES = ["화염", "대지", "바다", "바람", "화학공학", "마법공학"];
/** Spell shapes a laner can poke with without moving (vfx.ts draws these from the caster to the target). */
const POKE_KINDS = new Set<VfxKind>(["line", "circle", "cone", "target", "zone", "knockup", "wall"]);

export class Engine {
  t = 0;
  rng: Rng;
  units: Unit[] = [];
  lanes: Record<LaneId, LaneState> = { top: { id: "top", front: 0.5 }, mid: { id: "mid", front: 0.5 }, bot: { id: "bot", front: 0.5 } };
  turrets: TurretState[] = [];
  inhibs: InhibState[] = [];
  nexus: [number, number] = [4000, 4000];
  camps: CampState[] = [];
  obj: Record<ObjKey, ObjState>;
  events: GameEvent[] = [];
  fx: Fx[] = [];
  over = false;
  winner: SideN | null = null;
  kills: [number, number] = [0, 0];
  towers: [number, number] = [0, 0];
  dragons: [string[], string[]] = [[], []];
  grubs: [number, number] = [0, 0];
  heralds: [number, number] = [0, 0];
  barons: [number, number] = [0, 0];
  soul: SideN | null = null;
  soulType = "";
  firstBlood = false;
  firstTurret = false;
  fightSeq = 0;
  fights = new Map<number, { x: number; y: number; start: number; last: number; trade?: boolean; origin?: string; size?: number }>();
  killOrigin: Record<string, number> = {};
  tactic: [Tactic, Tactic];
  strategy: [Strategy, Strategy] = ["balanced", "balanced"];
  /** the data this engine was built from (champions, meta, heatmap) */
  data: GameData;
  /** per-module scratch state, keyed by module name (macro/fight keep their own data here) */
  mods: Record<string, unknown> = {};
  teamMod: [number, number] = [0, 0];
  names: [string, string];
  teamIds: [string, string];
  dragonOrder: string[] = [];
  nextTeamThink = 0;
  meta: GameData["meta"];

  constructor(cfg: EngineSetup) {
    const { s, data } = cfg;
    initMapOnce(data);
    this.data = data;
    this.meta = data.meta;
    this.rng = new Rng(cfg.seed);
    this.tactic = cfg.tactic ?? ["standard", "standard"];
    this.teamIds = [cfg.blue, cfg.red];
    this.names = [s.teams[cfg.blue].name, s.teams[cfg.red].name];
    const sides: [string, Partial<Record<Role, string>>][] = [[cfg.blue, cfg.picks.blue], [cfg.red, cfg.picks.red]];
    sides.forEach(([tid, picks], side) => {
      const t = s.teams[tid];
      const comp = compBonus(data, picks);
      const moraleAvg = ROLES.reduce((a, r) => a + (t.lineup[r] ? s.players[t.lineup[r]!].morale : 60), 0) / 5;
      const edge = tid === s.user ? 0 : s.difficulty === "hard" ? 1.5 : s.difficulty === "easy" ? -1 : 0.4;
      const userPlays = cfg.blue === s.user || cfg.red === s.user;
      this.teamMod[side] = (t.synergy - 50) / 12 + coachBonus(s, t) + comp + (moraleAvg - 60) / 20 + (userPlays ? edge : 0) - fatiguePenalty(starterFatigue(s, tid));
      ROLES.forEach((role) => {
        const pid = t.lineup[role];
        const p: Player | undefined = pid ? s.players[pid] : undefined;
        const champId = picks[role] ?? data.champions[0].id;
        const champ = data.champ.get(champId) ?? data.champions[0];
        const m = mastery(p, champ);
        const base = p ? ovr(p) + (p.role === role ? 0 : -8) + p.form * 0.15 : 45;
        const rating = base + (m - 62) / 4.5 + this.teamMod[side] + metaBonus(s, champ.id) + this.rng.normal(0, 3);
        const f = FOUNTAIN[side];
        const u: Unit = {
          i: this.units.length, side: side as SideN, role, pid: pid ?? "", name: p?.name ?? ROLE_KO[role], champ, rating,
          x: f.x + (this.rng.next() - 0.5) * 300, y: f.y + (this.rng.next() - 0.5) * 300, path: [],
          hp: 1, maxHp: 1, alive: true, respawnAt: 0, level: 1, xp: 0, gold: 500, cs: 0, k: 0, d: 0, a: 0, streak: 0,
          multi: { n: 0, last: -99 }, cds: [0, 0, 0, 0], stunUntil: 0, shield: 0, task: "lane", taskUntil: 0, goal: null,
          lastHitBy: new Map(), baronUntil: 0, elderUntil: 0, dmg: 0, fightId: 0,
        };
        this.units.push(u);
      });
    });
    for (const u of this.units) {
      u.maxHp = this.maxHp(u);
      u.hp = u.maxHp;
    }
    for (const td of TURRETS) {
      const maxHp = td.tier === 1 ? 3600 : td.tier === 2 ? 3800 : td.tier === 3 ? 4200 : 3200;
      this.turrets.push({ side: td.side, lane: td.lane, tier: td.tier, pos: td.pos, hp: maxHp, maxHp, alive: true, u: td.lane === "nexus" ? (td.side ? 0.97 : 0.03) : laneU(td.lane, td.pos), plates: td.tier === 1 ? 5 : 0 });
    }
    for (const ih of INHIBS) this.inhibs.push({ side: ih.side, lane: ih.lane, pos: ih.pos, hp: 3000, alive: true, respawnAt: 0 });
    const camps = this.meta.camps;
    let id = 0;
    for (const side of [0, 1] as SideN[]) {
      for (const c of CAMPS_BLUE) {
        const pos = side === 0 ? c.pos : CAMP_POS_RED[c.kind] ?? mirror(c.pos);
        const timing = camps[c.kind] ?? { firstSpawn: 90, respawn: 135 };
        const hp = c.kind === "blue" || c.kind === "red" ? 1600 : 1100;
        this.camps.push({ id: id++, side, kind: c.kind, pos, alive: false, spawnAt: timing.firstSpawn, hp, maxHp: hp });
      }
    }
    const sc = camps.scuttle ?? { firstSpawn: 210, respawn: 150 };
    SCUTTLE.forEach((pos, i) => this.camps.push({ id: id++, side: i === 0 ? 0 : 1, kind: "scuttle", pos, alive: false, spawnAt: sc.firstSpawn, hp: 900, maxHp: 900 }));
    const o = this.meta.objectives;
    const mk = (key: ObjKey, pos: Vec, spawnAt: number | null, hp: number): ObjState => ({ key, alive: false, spawnAt, hp, maxHp: hp, pos });
    this.obj = {
      dragon: mk("dragon", DRAGON_PIT, o.dragon?.firstSpawn ?? 300, 3600),
      grubs: { ...mk("grubs", BARON_PIT, o.grubs?.firstSpawn ?? 480, 2400), left: 3 },
      herald: mk("herald", BARON_PIT, o.herald?.firstSpawn ?? 900, 5200),
      baron: mk("baron", BARON_PIT, o.baron?.firstSpawn ?? 1200, 9500),
      elder: mk("elder", DRAGON_PIT, null, 8000),
    };
    const a = this.rng.pick(DRAGON_TYPES);
    let b = this.rng.pick(DRAGON_TYPES);
    while (b === a) b = this.rng.pick(DRAGON_TYPES);
    let c = this.rng.pick(DRAGON_TYPES);
    while (c === a || c === b) c = this.rng.pick(DRAGON_TYPES);
    this.dragonOrder = [a, b, c];
    this.soulType = c;
    this.obj.dragon.type = a;
    // game plans: the user's pick, otherwise the AI coach reads its own roster and draft
    for (const side of [0, 1] as SideN[]) {
      this.strategy[side] = cfg.strategy?.[side] ?? defaultStrategy(s, this.teamIds[side], this.units.filter((u) => u.side === side).map((u) => u.champ));
    }
    if (ENGINE_FLAGS.macro) Macro.init(this);
    if (ENGINE_FLAGS.fight) Fight.init(this);
    Items.init(this, cfg.loadout);
  }

  // ---------- stats ----------
  /** Item strength, (gold - 500) / 3000 scale. With items.json it counts bought items only, and a channel weights
   *  it by where the build's stats go (aa / sp / hp); see items.ts. */
  itemPower(u: Unit, ch?: "aa" | "sp" | "hp") {
    return Items.itemPower(this, u, ch);
  }
  phaseMul(u: Unit) {
    const m = this.t / 60;
    const early = (u.champ.style.early - 5) / 5;
    const late = (u.champ.style.scaling - 5) / 5;
    return 1 + (m < 15 ? early * 0.07 : 0) + (m > 28 ? late * 0.08 : 0) - (m > 28 ? early * 0.04 : 0);
  }
  skill(u: Unit) {
    return clamp(1 + (u.rating - 75) / 80, 0.7, 1.35);
  }
  maxHp(u: Unit) {
    const tags = u.champ.tags;
    const tank = tags.includes("Tank") ? 1.45 : tags.includes("Fighter") ? 1.2 : tags.includes("Support") ? 1.05 : 0.92;
    const ip = this.itemPower(u, "hp");
    return (640 + u.level * 95) * tank * (1 + ip * (tank > 1.1 ? 0.2 : 0.12)) * Items.mul(this, u, "hp");
  }
  aaDps(u: Unit) {
    const tags = u.champ.tags;
    const mark = tags.includes("Marksman") ? 1.55 : tags.includes("Fighter") ? 1.15 : tags.includes("Support") ? 0.6 : 0.85;
    const buff = (u.baronUntil > this.t ? 1.25 : 1) * (u.elderUntil > this.t ? 1.25 : 1);
    return (24 + u.level * 6) * mark * (1 + this.itemPower(u, "aa") * 0.18) * Items.mul(this, u, "aa") * this.skill(u) * this.phaseMul(u) * buff * this.soulMul(u.side);
  }
  spellDmg(u: Unit, sp: SpellData) {
    const tags = u.champ.tags;
    const caster = tags.includes("Mage") || tags.includes("Assassin") ? 1.35 : tags.includes("Support") ? 0.7 : 1;
    const buff = (u.baronUntil > this.t ? 1.2 : 1) * (u.elderUntil > this.t ? 1.25 : 1);
    return (20 + u.level * 13) * (sp.power || 1) * caster * (1 + this.itemPower(u, "sp") * 0.16) * Items.mul(this, u, "sp") * this.skill(u) * this.phaseMul(u) * buff * this.soulMul(u.side);
  }
  soulMul(side: SideN) {
    return (this.soul === side ? 1.08 : 1) * (1 + this.dragons[side].length * 0.015);
  }
  power(u: Unit) {
    return (this.aaDps(u) * 6 + this.spellDmg(u, u.champ.spells[0] ?? ({ power: 1 } as SpellData)) * 2) * (u.hp / u.maxHp + 0.35) * Math.sqrt(this.maxHp(u) / 1200);
  }
  minute() {
    return this.t / 60;
  }
  laningPhase() {
    return this.t < 14 * 60;
  }

  // ---------- helpers ----------
  fxSeq = 0;
  /** Queue a visual effect; returns it so a caller can still set `miss` after rolling the hit in the same step. */
  fx_(f: Omit<Fx, "t" | "id">): Fx {
    const fx: Fx = { t: this.t, id: ++this.fxSeq, ...f };
    this.fx.push(fx);
    if (this.fx.length > 400) this.fx.splice(0, this.fx.length - 400);
    return fx;
  }
  event(type: EvType, side: SideN, text: string, big: boolean, actor?: number, victim?: number, at?: Vec) {
    const ref = at ?? (victim !== undefined ? this.units[victim] : actor !== undefined ? this.units[actor] : undefined);
    this.events.push({ t: this.t, type, side, text, actor, victim, big, x: ref?.x, y: ref?.y });
  }
  enemies(u: Unit) {
    return this.units.filter((e) => e.side !== u.side && e.alive);
  }
  allies(u: Unit) {
    return this.units.filter((e) => e.side === u.side && e.alive && e !== u);
  }
  setGoal(u: Unit, g: Vec) {
    if (u.goal && Math.abs(u.goal.x - g.x) < 60 && Math.abs(u.goal.y - g.y) < 60) return;
    u.goal = { x: g.x, y: g.y };
    if (ENGINE_FLAGS.nav) {
      u.path = Nav.findPath(u, g);
      return;
    }
    u.path = dist(u, g) > 900 ? findPath(u, g) : [g];
  }
  speed(u: Unit) {
    const base = u.champ.moveSpeed || 340;
    return (base + 30 + Math.min(60, u.gold / 300)) * (u.baronUntil > this.t ? 1.05 : 1);
  }
  moveStep(u: Unit, dt: number) {
    if (this.t < u.stunUntil) return;
    let budget = this.speed(u) * dt;
    if (ENGINE_FLAGS.nav) {
      Nav.advance(u, budget);
      return;
    }
    while (budget > 0 && u.path.length) {
      const wp = u.path[0];
      const d = dist(u, wp);
      if (d <= budget) {
        u.x = wp.x;
        u.y = wp.y;
        budget -= d;
        u.path.shift();
      } else {
        u.x += ((wp.x - u.x) / d) * budget;
        u.y += ((wp.y - u.y) / d) * budget;
        budget = 0;
      }
    }
  }
  nearestEnemyTurret(u: Unit): TurretState | null {
    let best: TurretState | null = null, bd = Infinity;
    for (const t of this.turrets) {
      if (!t.alive || t.side === u.side) continue;
      const d = dist(u, t.pos);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  frontierTurret(side: SideN, lane: LaneId): TurretState | null {
    // the next standing turret of `side` in `lane` (outermost first)
    const ts = this.turrets.filter((t) => t.side === side && t.lane === lane && t.alive).sort((a, b) => a.tier - b.tier);
    return ts[0] ?? null;
  }
  laneFrontPos(lane: LaneId) {
    return lanePoint(lane, this.lanes[lane].front);
  }
  /** Where a laner of `side` stands relative to the wave: a little toward its own base. */
  laneStand(u: Unit, lane: LaneId) {
    const f = this.lanes[lane].front;
    const back = (u.champ.ranged ? 0.035 : 0.018) * (u.side === 0 ? -1 : 1);
    const p = lanePoint(lane, f + back);
    const jitter = (u.role === "Support" ? 260 : 120);
    return { x: p.x + (this.rng.next() - 0.5) * jitter, y: p.y + (this.rng.next() - 0.5) * jitter };
  }

  // ---------- main tick ----------
  step() {
    if (this.over) return;
    this.t += DT;
    this.spawns();
    this.teamThink();
    for (const u of this.units) this.unitTick(u);
    this.combat();
    if (ENGINE_FLAGS.nav) Nav.separate(this.units, DT);
    this.lanesTick();
    this.objectivesTick();
    this.economy();
    Items.tick(this);
    this.checkEnd();
  }

  runToEnd(maxT = 60 * 60) {
    while (!this.over && this.t < maxT) this.step();
    if (!this.over) {
      // safety: stronger team breaks the nexus
      const p = [0, 1].map((sd) => this.units.filter((u) => u.side === sd).reduce((a, u) => a + u.gold + u.rating * 100, 0));
      this.finish(p[0] >= p[1] ? 0 : 1);
    }
  }

  spawns() {
    for (const c of this.camps) {
      if (!c.alive && this.t >= c.spawnAt) {
        c.alive = true;
        c.hp = c.maxHp * (1 + this.minute() / 30);
      }
    }
    for (const k of Object.keys(this.obj) as ObjKey[]) {
      const o = this.obj[k];
      if (!o.alive && o.spawnAt !== null && this.t >= o.spawnAt) {
        if (k === "herald" && this.obj.baron.alive) continue;
        o.alive = true;
        o.maxHp = (k === "baron" ? 9500 : k === "elder" ? 8000 : k === "herald" ? 5200 : k === "grubs" ? 2400 : 3600) * (1 + this.minute() / 40);
        o.hp = o.maxHp;
        if (k === "dragon") this.event("info", 0, `${o.type} 드래곤 등장`, false);
        if (k === "baron") {
          this.event("info", 0, "내셔 남작 등장", false);
          if (this.obj.herald.alive) this.obj.herald.alive = false;
          this.obj.herald.spawnAt = null;
        }
        if (k === "grubs") this.event("info", 0, "공허 유충 등장", false);
        if (k === "herald") this.event("info", 0, "협곡의 전령 등장", false);
      }
    }
    for (const ih of this.inhibs) if (!ih.alive && ih.respawnAt && this.t >= ih.respawnAt) { ih.alive = true; ih.hp = 3000; }
    for (const u of this.units) {
      if (!u.alive && this.t >= u.respawnAt) {
        u.alive = true;
        const f = FOUNTAIN[u.side];
        u.x = f.x; u.y = f.y;
        u.maxHp = this.maxHp(u);
        u.hp = u.maxHp;
        u.task = "return";
        u.path = [];
        u.goal = null;
        u.lastHitBy.clear();
      }
    }
  }

  /** Team-level calls every few seconds: objectives, grouping, sieges. */
  teamThink() {
    if (ENGINE_FLAGS.macro) {
      Macro.teamThink(this);
      return;
    }
    if (this.t < this.nextTeamThink) return;
    this.nextTeamThink = this.t + 3;
    for (const side of [0, 1] as SideN[]) {
      const mine = this.units.filter((u) => u.side === side && u.alive);
      const theirs = this.units.filter((u) => u.side !== side && u.alive);
      const aggro = this.tactic[side] === "aggressive" ? 0.25 : this.tactic[side] === "safe" ? -0.2 : 0;
      const myPow = mine.reduce((a, u) => a + this.power(u), 0);
      const thPow = theirs.reduce((a, u) => a + this.power(u), 0) || 1;
      const edge = myPow / thPow;
      // objectives in priority order
      const order: ObjKey[] = ["elder", "baron", "dragon", "herald", "grubs"];
      for (const k of order) {
        const o = this.obj[k];
        if (!o.alive) continue;
        const sentAlready = mine.filter((u) => u.task === "obj" && u.objTarget === k);
        let want = 0;
        let who: Unit[] = [];
        // lane priority: who has more people near this pit right now
        const nearMine = mine.filter((u) => dist(u, o.pos) < 5200).length;
        const nearTheirs = theirs.filter((u) => dist(u, o.pos) < 5200).length;
        const prio = (nearMine - nearTheirs) * 0.12;
        const noise = (this.rng.next() - 0.5) * 0.5;
        if (k === "dragon") {
          const near = mine.filter((u) => ["Jungle", "Bot", "Support", "Mid"].includes(u.role));
          want = 0.45 + (edge - 1) * 0.3 + prio + (theirs.length < mine.length ? 0.25 : 0) + (this.dragons[side].length >= 3 ? 0.25 : 0) + aggro * 0.5 + noise;
          who = near;
        } else if (k === "grubs" || k === "herald") {
          want = 0.42 + (edge - 1) * 0.3 + prio + (theirs.length < mine.length ? 0.2 : 0) + aggro * 0.5 + noise;
          who = mine.filter((u) => ["Jungle", "Top", "Mid"].includes(u.role));
        } else {
          // baron / elder: only with a numbers or power lead, all five
          want = (edge - 1.12) * 3 + (theirs.length + 1 < mine.length ? 0.8 : 0) + aggro + (this.minute() > 30 ? 0.15 : 0);
          if (k === "elder") want += 0.3;
          who = mine;
        }
        if (sentAlready.length) continue;
        if (want > 0.62 && this.rng.chance(0.5)) {
          for (const u of who) {
            if (u.task === "recall" || u.task === "fight") continue;
            u.task = "obj";
            u.objTarget = k;
            u.taskUntil = this.t + 60;
          }
        }
      }
      // contest: enemy is on an objective -> answer if not outclassed
      for (const k of Object.keys(this.obj) as ObjKey[]) {
        const o = this.obj[k];
        if (!o.alive) continue;
        const attackers = theirs.filter((u) => u.task === "obj" && u.objTarget === k && dist(u, o.pos) < 1400);
        if (!attackers.length) continue;
        const defending = mine.filter((u) => u.task === "obj" && u.objTarget === k);
        if (defending.length) continue;
        const attPow = attackers.reduce((a, u) => a + this.power(u), 0);
        const responders = mine.filter((u) => dist(u, o.pos) < 7000 && u.task !== "recall");
        const resPow = responders.reduce((a, u) => a + this.power(u), 0);
        const importance = k === "baron" || k === "elder" ? 1.3 : k === "dragon" ? 1 : 0.7;
        const soulPoint = k === "dragon" && (this.dragons[0].length >= 3 || this.dragons[1].length >= 3);
        const contestP = k === "baron" || k === "elder" || soulPoint ? 0.75 : 0.3;
        if (resPow * importance > attPow * (1.05 - aggro) && this.rng.chance(contestP)) {
          for (const u of responders) {
            u.task = "obj";
            u.objTarget = k;
            u.taskUntil = this.t + 45;
          }
        }
      }
      // after the laning phase, a team with an edge groups and sieges
      const sieging = mine.some((u) => u.task === "siege");
      if (!sieging && !this.laningPhase() && mine.length >= 4 && ((theirs.length <= 2 && this.rng.chance(0.5)) || mine.some((u) => u.baronUntil > this.t) || (edge > 1.4 && this.rng.chance(0.04 + aggro * 0.1)))) {
        const lane = this.pickSiegeLane(side);
        if (lane) {
          for (const u of mine) {
            if (u.task === "obj" || u.task === "recall") continue;
            u.task = "siege";
            u.goal = null;
            u.taskUntil = this.t + 40;
            (u as Unit & { siegeLane?: LaneId }).siegeLane = lane;
          }
        }
      }
    }
  }

  pickSiegeLane(side: SideN): LaneId | null {
    const enemy = (1 - side) as SideN;
    let best: LaneId | null = null, bestScore = -Infinity;
    for (const lane of LANES) {
      const t = this.frontierTurret(enemy, lane);
      const inhib = this.inhibs.find((x) => x.side === enemy && x.lane === lane)!;
      if (!t && !inhib.alive) continue;
      const tier = t ? t.tier : 4;
      const score = -tier + (lane === "mid" ? 0.3 : 0) + this.rng.next() * 0.5;
      if (score > bestScore) { bestScore = score; best = lane; }
    }
    if (!best) {
      // all lanes open: go for nexus turrets via mid
      return "mid";
    }
    return best;
  }

  unitTick(u: Unit) {
    if (!u.alive) return;
    // recall channel
    if (u.task === "recall") {
      if (u.recallEnd !== undefined) {
        if (this.t >= u.recallEnd) {
          const f = FOUNTAIN[u.side];
          u.x = f.x; u.y = f.y;
          u.maxHp = this.maxHp(u);
          u.hp = u.maxHp;
          u.recallEnd = undefined;
          u.task = "return";
          u.goal = null;
          u.path = [];
        }
        return;
      }
      if (dist(u, FOUNTAIN[u.side]) < 900) {
        u.hp = u.maxHp = this.maxHp(u);
        u.task = "return";
        return;
      }
      if (!this.enemies(u).some((e) => dist(e, u) < 1300)) {
        u.recallEnd = this.t + 8;
        u.path = [];
        this.fx_({ kind: "recall", side: u.side, x: u.x, y: u.y, tx: u.x, ty: u.y, color: "#7fd3ff", r: 160, w: 0, from: u.i });
        return;
      }
      // run home first
      this.setGoal(u, FOUNTAIN[u.side]);
      this.moveStep(u, DT);
      return;
    }
    if (u.fightId) {
      // movement inside fights is handled by combat()
      return;
    }
    if (ENGINE_FLAGS.macro && Macro.unitTick(this, u)) return;
    // regen in fountain area
    if (dist(u, FOUNTAIN[u.side]) < 1200) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.08 * DT);
    // decide to recall
    const low = u.hp / u.maxHp < 0.3;
    // gold to spend: go home and buy like real players (items.ts shopUrge); without items.json the old 1500 rule.
    // Laning units run on this path (macro gives them the "old" job), so this is where early recalls come from.
    const urge = Items.shopUrge(this, u);
    const rich = urge !== null ? urge > 0 : u.gold - (u as Unit & { lastShop?: number }).lastShop! > 1500;
    if ((low || (rich && this.rng.chance(urge !== null ? Items.recallChance(urge) : 0.004))) && u.task !== "obj") {
      u.task = "recall";
      (u as Unit & { lastShop?: number }).lastShop = u.gold;
      return;
    }
    if ((u as Unit & { lastShop?: number }).lastShop === undefined) (u as Unit & { lastShop?: number }).lastShop = u.gold;
    // danger: an enemy group nearby that outnumbers us -> fall back toward a turret behind us
    if (u.task !== "gank" && this.t > 120) {
      let foes = 0, friends = 1, fx = 0, fy = 0;
      for (const o of this.units) {
        if (!o.alive || o === u) continue;
        const d = dist(o, u);
        if (d > 2300) continue;
        if (o.side === u.side) friends++;
        else { foes++; fx += o.x; fy += o.y; }
      }
      if (foes >= friends + 2 || (foes >= 3 && foes > friends && u.hp / u.maxHp < 0.6)) {
        const c = { x: fx / foes, y: fy / foes };
        const safe = this.turrets.filter((t) => t.alive && t.side === u.side).map((t) => t.pos)
          .filter((p) => dist(p, c) > dist(u, c) + 300).sort((a, b) => dist(a, u) - dist(b, u))[0] ?? FOUNTAIN[u.side];
        if (u.task === "obj" || u.task === "siege") { u.task = "group"; u.objTarget = undefined; }
        this.setGoal(u, safe);
        u.taskUntil = this.t + 6;
        this.moveStep(u, DT);
        return;
      }
    }
    if (u.task === "obj" && u.objTarget) {
      const o = this.obj[u.objTarget];
      // outnumbered: give the objective up instead of walking in one by one
      const mineAlive = this.units.filter((x) => x.side === u.side && x.alive).length;
      const theirsAlive = this.units.filter((x) => x.side !== u.side && x.alive).length;
      if (mineAlive + 1 < theirsAlive || u.hp / u.maxHp < 0.35) {
        u.task = "group";
        u.objTarget = undefined;
        this.setGoal(u, this.nearestOwnTurret(u)!);
      } else if (!o.alive || this.t > u.taskUntil) {
        u.task = "group";
        u.objTarget = undefined;
      } else {
        const off = { x: o.pos.x + (u.i % 5 - 2) * 140, y: o.pos.y + (u.side ? 220 : -220) };
        this.setGoal(u, off);
        this.moveStep(u, DT);
        return;
      }
    }
    if (u.task === "siege") {
      const lane = (u as Unit & { siegeLane?: LaneId }).siegeLane ?? "mid";
      const mineAlive = this.units.filter((x) => x.side === u.side && x.alive).length;
      const theirsAlive = this.units.filter((x) => x.side !== u.side && x.alive).length;
      if (this.t > u.taskUntil || mineAlive < theirsAlive || u.hp / u.maxHp < 0.3) {
        u.task = "group";
      } else {
        const target = this.siegeTarget((1 - u.side) as SideN, lane);
        if (target) {
          const toward = { x: target.x + (u.side ? 1 : -1) * 350 + (u.i % 5 - 2) * 90, y: target.y + (u.side ? 1 : -1) * 350 };
          this.setGoal(u, toward);
          this.moveStep(u, DT);
          return;
        }
        u.task = "group";
      }
    }
    if (u.role === "Jungle" && this.laningPhase()) {
      this.jungleTick(u);
      return;
    }
    if (this.laningPhase() && u.task !== "roam") {
      const lane = ROLE_LANE[u.role]!;
      if (u.role === "Support" && this.t > 8 * 60 && this.rng.chance(0.0025)) {
        u.task = "roam";
        u.taskUntil = this.t + 35;
        const g = sampleHeat("Support", this.minute(), u.side, () => this.rng.next());
        if (g) this.setGoal(u, g);
      } else {
        u.task = "lane";
        if (!u.goal || this.rng.chance(0.15) || dist(u.goal, this.laneFrontPos(lane)) > 900) this.setGoal(u, this.laneStand(u, lane));
      }
      this.moveStep(u, DT);
      return;
    }
    if (u.task === "roam" && this.t > u.taskUntil) u.task = this.laningPhase() ? "lane" : "group";
    // mid/late game: go where this role usually is at this minute
    if (!u.goal || !u.path.length || this.t > u.taskUntil) {
      u.taskUntil = this.t + 18 + this.rng.next() * 22;
      let g = sampleHeat(u.role, this.minute(), u.side, () => this.rng.next());
      if (!g) g = this.laneFrontPos(ROLE_LANE[u.role] ?? "mid");
      // farm side lanes: snap to a nearby wave if one is close
      for (const lane of LANES) {
        const fp = this.laneFrontPos(lane);
        if (dist(g, fp) < 2200) {
          g = this.laneStand(u, lane);
          break;
        }
      }
      this.setGoal(u, g);
    }
    this.moveStep(u, DT);
  }

  siegeTarget(enemy: SideN, lane: LaneId): Vec | null {
    const t = this.frontierTurret(enemy, lane);
    if (t) return t.pos;
    const ih = this.inhibs.find((x) => x.side === enemy && x.lane === lane);
    if (ih?.alive) return ih.pos;
    const nt = this.turrets.find((x) => x.side === enemy && x.lane === "nexus" && x.alive);
    if (nt) return nt.pos;
    return NEXUS[enemy];
  }

  jungleRoute(u: Unit): number[] {
    const own = this.camps.filter((c) => c.side === u.side && c.kind !== "scuttle");
    const order: CampKind[] = this.rng.next() < 0.7 ? ["blue", "gromp", "wolves", "raptors", "red", "krugs"] : ["red", "krugs", "raptors", "wolves", "blue", "gromp"];
    return order.map((k) => own.find((c) => c.kind === k)!.id);
  }

  jungleTick(u: Unit) {
    const ext = u as Unit & { route?: number[]; gankLane?: LaneId };
    if (!ext.route) ext.route = this.jungleRoute(u);
    // gank decision
    if (u.task === "gank" && ext.gankLane) {
      const lane = ext.gankLane;
      const foe = this.units.find((e) => e.side !== u.side && e.alive && ROLE_LANE[e.role] === lane && e.role !== "Jungle");
      if (!foe || this.t > u.taskUntil) {
        u.task = "jungle";
        ext.gankLane = undefined;
      } else {
        this.setGoal(u, { x: foe.x, y: foe.y });
        this.moveStep(u, DT);
        return;
      }
    }
    if (this.t > 195 && u.task !== "gank" && this.rng.chance(0.0018)) {
      const lane = this.pickGankLane(u);
      if (lane) {
        u.task = "gank";
        ext.gankLane = lane;
        u.taskUntil = this.t + 28;
        return;
      }
    }
    // scuttle when it is up and close enough
    const scut = this.camps.filter((c) => c.kind === "scuttle" && c.alive).sort((a, b) => dist(u, a.pos) - dist(u, b.pos))[0];
    let target: CampState | undefined;
    // the scuttle-or-camp choice sticks for 10 s (re-rolling every tick made the jungler's goal flip back and forth)
    const sx = u as Unit & { scutRoll?: { at: number; go: boolean } };
    if (scut && dist(u, scut.pos) < 4500) {
      if (!sx.scutRoll || this.t - sx.scutRoll.at > 10) sx.scutRoll = { at: this.t, go: this.rng.chance(0.6) };
      if (sx.scutRoll.go) target = scut;
    }
    if (!target) {
      const alive = ext.route.map((id) => this.camps[id]).filter((c) => c.alive);
      target = alive.sort((a, b) => dist(u, a.pos) - dist(u, b.pos))[0];
    }
    if (!target) {
      // nothing up: shadow a lane
      const g = sampleHeat("Jungle", this.minute(), u.side, () => this.rng.next());
      if (g && (!u.goal || !u.path.length)) this.setGoal(u, g);
      this.moveStep(u, DT);
      return;
    }
    u.task = "jungle";
    u.campTarget = target.id;
    if (dist(u, target.pos) > 250) {
      this.setGoal(u, target.pos);
      this.moveStep(u, DT);
      return;
    }
    // clear the camp
    const dps = this.aaDps(u) * 1.6 + 40;
    target.hp -= dps * DT;
    if (this.rng.chance(0.08)) this.castRandom(u, null, target.pos);
    u.hp = Math.max(u.maxHp * 0.25, u.hp - target.maxHp * 0.004 * DT * 4);
    if (target.hp <= 0) {
      target.alive = false;
      const timing = target.kind === "scuttle" ? this.meta.camps.scuttle : this.meta.camps[target.kind];
      target.spawnAt = this.t + (timing?.respawn ?? 135);
      const big = target.kind === "blue" || target.kind === "red";
      u.gold += big ? 100 : target.kind === "scuttle" ? 120 : 75;
      u.xp += big ? 220 : 150;
      u.cs += 4;
    }
  }

  pickGankLane(u: Unit): LaneId | null {
    let best: LaneId | null = null, bestV = 0.35;
    for (const lane of LANES) {
      const ally = this.units.find((e) => e.side === u.side && e.alive && ROLE_LANE[e.role] === lane && e.role !== "Support");
      const foe = this.units.find((e) => e.side !== u.side && e.alive && ROLE_LANE[e.role] === lane && e.role !== "Support");
      if (!foe || !ally) continue;
      const front = this.lanes[lane].front;
      const pushedOnUs = u.side === 0 ? 1 - front : front; // high when the wave sits near our tower
      const v = pushedOnUs * 0.8 + (1 - foe.hp / foe.maxHp) * 0.6 + (lane === "bot" ? 0.1 : 0) + (u.rating - foe.rating) / 100 - dist(u, foe) / 20000;
      if (v > bestV) { bestV = v; best = lane; }
    }
    return best;
  }

  // ---------- combat ----------
  /** Chance per second that u picks a fight with e right now. */
  engageRate(u: Unit, e: Unit, ratio: number, underTurret: boolean, sizes = 2): number {
    const aggro = this.tactic[u.side] === "aggressive" ? 1.4 : this.tactic[u.side] === "safe" ? 0.6 : 1;
    let r: number;
    if (u.task === "gank") {
      r = ratio > 0.8 ? 1.2 : 0.1;
    } else if (u.task === "siege" || u.task === "obj") {
      r = ratio > 1.15 ? 0.18 : ratio > 0.95 ? 0.04 : 0.008;
    } else if (this.laningPhase()) {
      const lu = ROLE_LANE[u.role], le = ROLE_LANE[e.role];
      // lane opponents are handled by laneDuels(); this covers jungle meetings and roams
      if (lu && lu === le && u.role !== "Jungle" && e.role !== "Jungle") return 0;
      r = ratio > 1.3 ? 0.012 : 0.003;
    } else {
      r = ratio > 1.35 ? 0.025 : ratio > 1.05 ? 0.008 : ratio > 0.9 ? 0.003 : 0.0008;
      if (this.minute() > 28) r *= 1.5;
      if (sizes <= 2) r *= 0.3; // lone pick-offs are rarer than group fights
    }
    if (underTurret && ratio < 1.8) r *= 0.25;
    return r * aggro;
  }

  /** Per-lane rates of a committed all-in during laning, per second (from 2026 LCK solo kill rates). */
  static ALLIN: Record<LaneId, number> = { top: 0.0008, mid: 0.00055, bot: 0.0004 };

  /** Laning: small pokes most of the time, a rare all-in that can become a solo kill. */
  laneDuels() {
    if (!this.laningPhase() || this.t < 70) return;
    for (const lane of LANES) {
      const sideUnits = [0, 1].map((sd) => this.units.filter((u) => u.side === sd && u.alive && !u.fightId && u.task === "lane" && ROLE_LANE[u.role] === lane && u.recallEnd === undefined));
      if (!sideUnits[0].length || !sideUnits[1].length) continue;
      const a = sideUnits[0][0], b = sideUnits[1][0];
      if (dist(a, b) > 1300) continue;
      // poke
      if (this.rng.chance(0.09 * DT)) {
        const [src, dst] = this.rng.chance(0.5 + (a.rating - b.rating) / 120) ? [a, b] : [b, a];
        // pokes only use spells that hit from where the caster stands (no dashes, no ally heals/shields, no self buffs)
        const pokes = src.champ.spells.slice(0, 3).filter((x) => x && POKE_KINDS.has(x.vfx));
        const sp = pokes.length ? pokes[this.rng.int(0, pokes.length - 1)] : undefined;
        if (sp && this.t >= src.cds[sp.key === "Q" ? 0 : sp.key === "W" ? 1 : 2]) {
          const fx = this.emitSpellFx(src, sp, dst, dst, false);
          if (this.rng.chance(clamp(0.5 + (src.rating - dst.rating) / 120, 0.2, 0.85))) {
            this.hitFx(src, dst, sp);
            this.damage(src, dst, dst.maxHp * this.rng.range(0.05, 0.13));
          } else fx.miss = true;
        }
      }
      const pa = sideUnits[0].reduce((s, u) => s + this.power(u), 0);
      const pb = sideUnits[1].reduce((s, u) => s + this.power(u), 0);
      const ratio = Math.max(pa / pb, pb / pa);
      const lowHp = Math.min(...[...sideUnits[0], ...sideUnits[1]].map((u) => u.hp / u.maxHp));
      const rate = Engine.ALLIN[lane] * (1 + Math.max(0, ratio - 1) * 3) * (lowHp < 0.45 ? 3 : 1) *
        (this.tactic[0] === "aggressive" || this.tactic[1] === "aggressive" ? 1.4 : 1);
      if (this.rng.chance(rate * DT * 4)) {
        const id = ++this.fightSeq;
        this.fights.set(id, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, start: this.t, last: this.t, origin: "allin" });
        for (const u of [...sideUnits[0], ...sideUnits[1]]) this.joinFight(u, id);
      }
    }
  }

  /** Flash out of a lost fight once every 5 minutes. */
  tryFlash(u: Unit): boolean {
    const ext = u as Unit & { flashAt?: number };
    if ((ext.flashAt ?? 0) > this.t) return false;
    ext.flashAt = this.t + 300;
    const home = this.nearestOwnTurret(u)!;
    const ang = Math.atan2(home.y - u.y, home.x - u.x);
    const from = { x: u.x, y: u.y };
    if (ENGINE_FLAGS.nav) {
      const p = Nav.blinkLanding(from, { x: from.x + Math.cos(ang) * 420, y: from.y + Math.sin(ang) * 420 }, 420, true);
      u.x = p.x;
      u.y = p.y;
      u.path = [];
      u.goal = null;
    } else {
      u.x += Math.cos(ang) * 420;
      u.y += Math.sin(ang) * 420;
    }
    // blink: x,y = landing point, tx,ty = start (vfx.ts contract)
    this.fx_({ kind: "blink", side: u.side, x: u.x, y: u.y, tx: from.x, ty: from.y, color: "#fff3a0", r: 120, w: 0, from: u.i, text: "점멸" });
    return true;
  }

  combat() {
    if (ENGINE_FLAGS.fight) {
      Fight.combat(this);
      return;
    }
    // orphaned fight ids (fight ended while the unit was joining)
    for (const u of this.units) if (u.fightId && !this.fights.has(u.fightId)) this.leaveFight(u);
    this.laneDuels();
    const alive = this.units.filter((u) => u.alive && u.recallEnd === undefined);
    const calm = (x: Unit) => ((x as Unit & { calmUntil?: number }).calmUntil ?? 0) > this.t;
    for (const u of alive) {
      if (u.fightId || calm(u)) continue;
      for (const e of alive) {
        if (e.side === u.side || calm(e)) continue;
        const d = dist(u, e);
        if (d > 1050) continue;
        if (e.fightId) {
          if (d < 1400 && this.fights.has(e.fightId)) this.joinFight(u, e.fightId);
          break;
        }
        const myGroup = alive.filter((x) => x.side === u.side && !x.fightId && dist(x, u) < 1500);
        const theirGroup = alive.filter((x) => x.side === e.side && !x.fightId && dist(x, e) < 1500);
        const mp = myGroup.reduce((a, x) => a + this.power(x), 0);
        const tp = theirGroup.reduce((a, x) => a + this.power(x), 0) || 1;
        const ratio = mp / tp;
        const underTurret = this.turrets.some((t) => t.alive && t.side === e.side && dist(t.pos, e) < 800);
        if (this.rng.chance(clamp(this.engageRate(u, e, ratio, underTurret, myGroup.length + theirGroup.length) * DT, 0, 0.9))) {
          const id = ++this.fightSeq;
          const trade = this.laningPhase() && myGroup.length + theirGroup.length <= 3 && u.task !== "gank";
          const origin = u.task === "gank" ? "gank" : u.task === "siege" ? "siege" : u.task === "obj" ? "obj" : this.laningPhase() ? "early" : "mid";
          this.fights.set(id, { x: (u.x + e.x) / 2, y: (u.y + e.y) / 2, start: this.t, last: this.t, trade, origin });
          for (const x of [...myGroup, ...theirGroup]) this.joinFight(x, id);
          break;
        }
        if (ratio < 0.6 && u.task !== "obj" && u.task !== "siege") {
          const home = this.nearestOwnTurret(u);
          if (home) this.setGoal(u, home);
        }
      }
    }
    for (const [id, f] of this.fights) {
      const members = this.units.filter((x) => x.fightId === id && x.alive);
      const sides = new Set(members.map((m) => m.side));
      if (members.length) {
        f.x = members.reduce((a, m) => a + m.x, 0) / members.length;
        f.y = members.reduce((a, m) => a + m.y, 0) / members.length;
      }
      const trade = (f as { trade?: boolean }).trade;
      const maxLen = trade ? 3.5 + this.rng.next() * 2 : this.minute() > 24 ? 20 : 12;
      // an even trade usually ends with both backing off; a big lead turns it into an all-in
      const lowest = Math.min(...members.map((m) => m.hp / m.maxHp));
      const allIn = trade && lowest < 0.35;
      if (sides.size < 2 || this.t - f.start > (allIn ? maxLen + 4 : maxLen)) {
        this.endFight(id);
        continue;
      }
      // the side that is clearly losing pulls out together
      if (this.t - f.start > 2) {
        const pw = [0, 0];
        for (const m of members) pw[m.side] += this.power(m);
        for (const sd of [0, 1] as SideN[]) {
          const late = this.minute() > 24;
          if (pw[sd] < pw[1 - sd] * (late ? 0.7 : 0.88) && this.rng.chance(late ? 0.12 : 0.3)) {
            for (const m of members.filter((x) => x.side === sd)) {
              if (m.hp / m.maxHp < 0.4 && this.tryFlash(m)) { /* flashed */ }
              this.leaveFight(m);
              (m as Unit & { calmUntil?: number }).calmUntil = this.t + 5;
              this.setGoal(m, this.nearestOwnTurret(m)!);
            }
          }
        }
      }
      for (const u of this.units) {
        if (!u.alive || u.fightId || u.recallEnd !== undefined) continue;
        const dd = dist(u, f);
        if (dd < 1300 && !trade) this.joinFight(u, id);
        else if (dd < 4000 && members.length >= 3 && u.task !== "recall" && this.rng.chance(0.06)) this.setGoal(u, f);
      }
      for (const m of members) this.fightAct(m, members);
    }
  }

  endFight(id: number) {
    for (const u of this.units) if (u.fightId === id) this.leaveFight(u);
    this.fights.delete(id);
  }

  nearestOwnTurret(u: Unit): Vec | null {
    let best: Vec | null = null, bd = Infinity;
    for (const t of this.turrets) {
      if (!t.alive || t.side !== u.side) continue;
      const d = dist(u, t.pos);
      if (d < bd) { bd = d; best = t.pos; }
    }
    return best ?? FOUNTAIN[u.side];
  }

  joinFight(u: Unit, id: number) {
    if (u.fightId === id) return;
    u.fightId = id;
    u.task = "fight";
    const f = this.fights.get(id);
    if (f) f.size = (f.size ?? 0) + 1;
  }
  leaveFight(u: Unit) {
    u.fightId = 0;
    u.task = this.laningPhase() ? (u.role === "Jungle" ? "jungle" : "lane") : "group";
    u.goal = null;
    u.path = [];
    if (u.alive && u.hp / u.maxHp < 0.35) u.task = "recall";
  }

  fightAct(u: Unit, members: Unit[]) {
    if (!u.alive || this.t < u.stunUntil) return;
    const foes = members.filter((m) => m.side !== u.side && m.alive);
    if (!foes.length) return;
    // flee when nearly dead and the fight is lost
    const allies = members.filter((m) => m.side === u.side && m.alive);
    const myFrac = u.hp / u.maxHp;
    const foeFrac = foes.reduce((a, f) => a + f.hp / f.maxHp, 0) / foes.length;
    const losing = foes.length > allies.length || myFrac < foeFrac - 0.15;
    if (myFrac < 0.35 && losing && this.rng.chance(0.35)) {
      if (myFrac < 0.2) this.tryFlash(u);
      this.leaveFight(u);
      (u as Unit & { calmUntil?: number }).calmUntil = this.t + 5;
      u.task = "recall";
      this.setGoal(u, this.nearestOwnTurret(u)!);
      return;
    }
    // target: lowest effective hp in reach, carries preferred
    const target = foes
      .map((f) => ({ f, v: f.hp + dist(u, f) * 0.8 - (f.role === "Bot" || f.role === "Mid" ? 150 : 0) }))
      .sort((a, b) => a.v - b.v)[0].f;
    const range = u.champ.ranged ? Math.max(450, u.champ.attackRange) : 200;
    const d = dist(u, target);
    if (d > range) {
      u.path = [{ x: target.x, y: target.y }];
      this.moveStep(u, DT);
    } else if (u.champ.ranged && d < range * 0.6 && this.rng.chance(0.3)) {
      // kite back
      const ang = Math.atan2(u.y - target.y, u.x - target.x);
      u.path = [{ x: u.x + Math.cos(ang) * 120, y: u.y + Math.sin(ang) * 120 }];
      this.moveStep(u, DT);
    }
    // spells first
    for (let k = 0; k < 4; k++) {
      const sp = u.champ.spells[k];
      if (!sp || this.t < u.cds[k]) continue;
      const reach = Math.max(range + 150, Math.min(sp.range || 600, 1400));
      if (sp.vfx !== "global" && d > reach) continue;
      if (k === 3 && foes.length === 1 && target.hp / target.maxHp < 0.2) continue; // do not waste ult
      if (!this.rng.chance(k === 3 ? 0.3 : 0.35)) continue;
      this.cast(u, k, target, members);
      break;
    }
    // auto attacks
    if (d <= range + 30) {
      const dmg = this.aaDps(u) * DT * this.rng.range(0.75, 1.25);
      this.damage(u, target, dmg);
      if (u.champ.ranged && this.rng.chance(0.35)) this.fx_({ kind: "aa", side: u.side, x: u.x, y: u.y, tx: target.x, ty: target.y, color: u.side ? "#ff8a8a" : "#8ab8ff", r: 0, w: 0, from: u.i, to: target.i });
    }
    // turrets shoot divers
    for (const t of this.turrets) {
      if (!t.alive || t.side === u.side) continue;
      if (dist(t.pos, u) < 780 && this.rng.chance(0.5)) {
        const dmg = (180 + this.minute() * 6) * DT * 2;
        this.damage(null, u, dmg);
        if (this.rng.chance(0.4)) this.fx_({ kind: "tower", side: t.side, x: t.pos.x, y: t.pos.y, tx: u.x, ty: u.y, color: t.side ? "#ff6b6b" : "#6ba8ff", r: 0, w: 0, to: u.i });
      }
    }
  }

  /** Jungle-clear cast (drawn small and faint). Dashes are skipped (the caster does not move here); heals/shields/self buffs target the caster. */
  castRandom(u: Unit, target: Unit | null, at: Vec) {
    const k = this.rng.int(0, 2);
    const sp = u.champ.spells[k];
    if (!sp || this.t < u.cds[k]) return;
    if (sp.vfx === "dash" || sp.vfx === "blink") return;
    u.cds[k] = this.t + this.cdOf(u, sp, k);
    const onSelf = sp.vfx === "heal" || sp.vfx === "shield" || sp.vfx === "self" || sp.vfx === "stealth" || sp.vfx === "summon";
    if (onSelf) this.emitSpellFx(u, sp, u, u, true);
    else this.emitSpellFx(u, sp, target, at, true);
  }

  cdOf(u: Unit, sp: SpellData, k: number) {
    const base = sp.cd || (k === 3 ? 100 : 10);
    const haste = 1 - Math.min(0.4, u.level * 0.012 + this.itemPower(u) * 0.03);
    return Math.max(k === 3 ? 40 : 3, base * haste);
  }

  cast(u: Unit, k: number, target: Unit, members: Unit[]) {
    const sp = u.champ.spells[k];
    u.cds[k] = this.t + this.cdOf(u, sp, k);
    const kind = sp.vfx;
    const friendly = kind === "shield" || kind === "heal";
    if (friendly) {
      const ally = members.filter((m) => m.side === u.side && m.alive).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] ?? u;
      const amount = this.spellDmg(u, sp) * 0.9;
      if (kind === "heal") ally.hp = Math.min(ally.maxHp, ally.hp + amount);
      else ally.shield += amount;
      this.emitSpellFx(u, sp, ally, ally, false);
      return;
    }
    let fx: Fx;
    if (kind === "dash" || kind === "blink") {
      const ang = Math.atan2(target.y - u.y, target.x - u.x);
      const len = Math.min(dist(u, target) - 80, kind === "blink" ? 450 : 600);
      const from = { x: u.x, y: u.y };
      if (len > 0) {
        const to = { x: u.x + Math.cos(ang) * len, y: u.y + Math.sin(ang) * len };
        const p = ENGINE_FLAGS.nav ? Nav.blinkLanding(from, to, len, kind === "blink") : to;
        u.x = p.x;
        u.y = p.y;
      }
      fx = this.emitSpellFx(u, sp, target, from, false);
    } else if (kind === "stealth" || kind === "self" || kind === "summon") {
      fx = this.emitSpellFx(u, sp, target, u, false);
    } else {
      fx = this.emitSpellFx(u, sp, target, target, false);
    }
    // hit or miss
    const skillshot = kind === "line" || kind === "cone" || kind === "circle" || kind === "global" || kind === "wall";
    const stunned = this.t < target.stunUntil;
    const hitP = skillshot ? clamp(0.52 + (u.rating - target.rating) / 140 + (stunned ? 0.4 : 0), 0.2, 0.96) : 0.95;
    const aoe = kind === "circle" || kind === "cone" || kind === "zone" || kind === "knockup" || kind === "wall" || (kind === "line" && (sp.width ?? 0) > 200);
    const radius = Math.max(220, sp.radius ?? 250);
    const victims = aoe ? members.filter((m) => m.side !== u.side && m.alive && dist(m, target) < radius) : [target];
    let hitMain = false;
    for (const v of victims) {
      if (!this.rng.chance(v === target ? hitP : hitP * 0.7)) continue;
      if (v === target) hitMain = true;
      this.hitFx(u, v, sp);
      const dmg = this.spellDmg(u, sp) * this.rng.range(0.85, 1.15);
      this.damage(u, v, dmg);
      if (sp.cc || kind === "knockup" || kind === "wall") {
        v.stunUntil = Math.max(v.stunUntil, this.t + (k === 3 ? 1.5 : 0.8));
      }
    }
    if (!hitMain) fx.miss = true;
  }

  /** One skill effect. Returns the Fx so the caller can mark `miss` once the hit is rolled (same step). */
  emitSpellFx(u: Unit, sp: SpellData, target: Unit | null, at: Vec, pve: boolean): Fx {
    const color = u.champ.color || (u.side ? "#ff6b6b" : "#5aa9ff");
    return this.fx_({
      kind: sp.vfx, side: u.side, x: u.x, y: u.y, tx: at.x, ty: at.y, color,
      r: sp.radius ?? 250, w: sp.width ?? 120, from: u.i, to: target?.i, text: pve ? undefined : sp.name,
      key: sp.key, icon: sp.icon, also: sp.also, pve: pve || undefined,
    });
  }

  /** One "hit" effect per victim a skill lands on (vfx.ts flashes the victim when the projectile arrives). */
  hitFx(u: Unit, v: Unit, sp: SpellData) {
    const knock = sp.vfx === "knockup" || sp.also === "knockup";
    this.fx_({
      kind: "hit", side: u.side, x: v.x, y: v.y, tx: v.x, ty: v.y, color: u.champ.color || (u.side ? "#ff6b6b" : "#5aa9ff"),
      r: 0, w: 0, from: u.i, to: v.i, key: sp.key, also: knock ? "knockup" : undefined,
    });
  }

  damage(src: Unit | null, v: Unit, amount: number) {
    if (!v.alive) return;
    let a = amount;
    if (v.shield > 0) {
      const absorbed = Math.min(v.shield, a);
      v.shield -= absorbed;
      a -= absorbed;
    }
    v.hp -= a;
    if (src) {
      src.dmg += a;
      v.lastHitBy.set(src.i, this.t);
    }
    if (v.hp <= 0) this.kill(src, v);
  }

  kill(src: Unit | null, v: Unit) {
    const fight = v.fightId ? this.fights.get(v.fightId) : undefined;
    const fo = fight?.origin ?? (v.fightId ? "?" : "nofight");
    const oneVsOne = !fight || (fight.size ?? 2) <= 2;
    this.killOrigin[fo] = (this.killOrigin[fo] ?? 0) + 1;
    v.alive = false;
    v.hp = 0;
    v.d += 1;
    v.fightId = 0;
    v.task = "return";
    v.path = [];
    const lvl = v.level;
    const timer = Math.min(75, 6 + lvl * 2.5 + Math.max(0, (this.t - 900) / 60) * 0.9);
    v.respawnAt = this.t + timer;
    const killerSide = (1 - v.side) as SideN;
    this.kills[killerSide] += 1;
    // credit
    let killer = src && src.side !== v.side ? src : null;
    const recent = [...v.lastHitBy.entries()].filter(([, t]) => this.t - t < 10).map(([i]) => this.units[i]).filter((x) => x.side !== v.side);
    if (!killer && recent.length) killer = recent[recent.length - 1];
    const assists = recent.filter((x) => x !== killer);
    // kill gold and shutdown (제압골) fitted on real LCK games (items.ts); without items.json the old flat rule
    const kg = Items.killGold(this, killer, v, assists, !this.firstBlood);
    const wasShutdown = kg ? kg.shutdown >= 250 : v.streak >= 3;
    v.streak = 0;
    const bounty = kg ? kg.bounty + kg.shutdown : 300 + (wasShutdown ? 150 + Math.min(700, (v.k - v.d) * 50) : 0) + (this.firstBlood ? 0 : 100);
    this.fx_({ kind: "kill", side: killerSide, x: v.x, y: v.y, tx: v.x, ty: v.y, color: killerSide ? "#ff5a5a" : "#5aa9ff", r: 200, w: 0, to: v.i, from: killer?.i });
    if (killer) {
      killer.k += 1;
      killer.streak += 1;
      killer.gold += bounty;
      killer.xp += 220 + lvl * 25;
      // multikill window
      if (this.t - killer.multi.last <= (killer.multi.n === 4 ? 30 : 10)) killer.multi.n += 1;
      else killer.multi.n = 1;
      killer.multi.last = this.t;
    }
    for (const a of assists) {
      a.a += 1;
      a.gold += kg ? kg.assist : Math.round(150 / Math.max(1, assists.length)) + 20;
      a.xp += 120;
    }
    const kName = killer ? `${killer.name}(${killer.champ.name})` : "포탑";
    const vName = `${v.name}(${v.champ.name})`;
    if (!this.firstBlood) {
      this.firstBlood = true;
      this.event("first_blood", killerSide, `퍼스트 블러드! ${kName} → ${vName}`, true, killer?.i, v.i);
    } else if (killer && !assists.length && oneVsOne && this.allies(killer).every((x) => dist(x, v) > 1600)) {
      this.event("solo", killerSide, `솔로 킬! ${ROLE_KO[killer.role]} ${josa(kName, "이가")} ${josa(vName, "을를")} 잡았습니다`, true, killer.i, v.i);
    } else {
      this.event("kill", killerSide, `${kName} → ${vName}`, false, killer?.i, v.i);
    }
    if (wasShutdown && killer) {
      const extra = kg ? ` (제압골 ${kg.shutdown}골드)` : "";
      this.event("shutdown", killerSide, `셧다운! ${josa(kName, "이가")} ${v.name}의 연속 킬을 끊었습니다${extra}`, false, killer.i, v.i);
    }
    if (killer && killer.multi.n >= 2) {
      const n = killer.multi.n;
      const t: EvType = n === 2 ? "double" : n === 3 ? "triple" : n === 4 ? "quadra" : "penta";
      const label = n === 2 ? "더블 킬" : n === 3 ? "트리플 킬" : n === 4 ? "쿼드라 킬" : "펜타 킬";
      if (n <= 5) this.event(t, killerSide, `${label}! ${kName}`, true, killer.i);
    }
    if (this.units.filter((x) => x.side === v.side).every((x) => !x.alive)) {
      this.event("ace", killerSide, `에이스! ${josa(this.names[killerSide], "이가")} 상대 다섯 명을 모두 잡았습니다`, true, undefined, v.i);
    }
  }

  // ---------- lanes, turrets, structures ----------
  lanesTick() {
    if (this.t < 55) return;
    // blue power / red power, clamped, for map pressure after laning
    const tp = [0, 1].map((sd) => this.units.filter((u) => u.side === sd && u.alive).reduce((a, u) => a + this.power(u), 0));
    const powRatio = clamp((tp[0] + 1) / (tp[1] + 1), 0.5, 2);
    for (const lane of LANES) {
      const L = this.lanes[lane];
      const fp = lanePoint(lane, L.front);
      const push = [0, 0];
      for (const u of this.units) {
        if (!u.alive || u.fightId) continue;
        const d = dist(u, fp);
        if (d < 1300) push[u.side] += 0.6 + u.champ.style.waveclear * 0.06 + this.itemPower(u) * 0.15 + (u.baronUntil > this.t ? 1.2 : 0);
      }
      // super minions
      for (const side of [0, 1] as SideN[]) {
        const enemyInhib = this.inhibs.find((x) => x.side !== side && x.lane === lane);
        if (enemyInhib && !enemyInhib.alive) push[side] += 0.9;
      }
      let dir = (push[0] - push[1]) * 0.0009 + (this.rng.next() - 0.5) * 0.0012;
      if (this.laningPhase()) dir += (0.5 - L.front) * 0.0006; // waves drift back to the middle
      else dir += (powRatio - 1) * 0.0012; // map pressure: the stronger team crashes waves into towers
      let nf = clamp(L.front + dir * DT * 4, 0.04, 0.96);
      // standing turrets stop the wave
      const redT = this.frontierTurret(1, lane);
      const blueT = this.frontierTurret(0, lane);
      const redInhib = this.inhibs.find((x) => x.side === 1 && x.lane === lane)!;
      const blueInhib = this.inhibs.find((x) => x.side === 0 && x.lane === lane)!;
      const redStop = redT ? redT.u - 0.02 : redInhib.alive ? laneU(lane, redInhib.pos) - 0.02 : 0.95;
      const blueStop = blueT ? blueT.u + 0.02 : blueInhib.alive ? laneU(lane, blueInhib.pos) + 0.02 : 0.05;
      nf = clamp(nf, blueStop, redStop);
      L.front = nf;
      // structure damage when the wave sits on it
      if (nf >= redStop - 0.005) this.hitStructure(0, lane, push[0]);
      if (nf <= blueStop + 0.005) this.hitStructure(1, lane, push[1]);
    }
    // champions sieging a structure
    for (const u of this.units) {
      if (!u.alive || u.fightId) continue;
      for (const t of this.turrets) {
        if (!t.alive || t.side === u.side || dist(t.pos, u) > 750) continue;
        const defenders = this.units.some((e) => e.alive && e.side === t.side && dist(e, t.pos) < 1300);
        if (defenders && this.laningPhase()) continue;
        this.damageTurret(t, this.aaDps(u) * (this.minute() > 20 ? 0.75 : 0.55) * DT, u);
      }
      for (const ih of this.inhibs) {
        if (!ih.alive || ih.side === u.side || dist(ih.pos, u) > 700) continue;
        if (this.turrets.some((t) => t.alive && t.side === ih.side && t.lane === ih.lane)) continue;
        ih.hp -= this.aaDps(u) * DT;
        if (ih.hp <= 0) this.destroyInhib(ih, u.side);
      }
      if (dist(NEXUS[1 - u.side], u) < 900) {
        const standing = this.turrets.some((t) => t.alive && t.side !== u.side && t.lane === "nexus");
        const anyInhib = this.inhibs.some((x) => x.side !== u.side && !x.alive);
        if (!standing && anyInhib) {
          this.nexus[1 - u.side] -= this.aaDps(u) * DT;
          if (this.nexus[1 - u.side] <= 0) this.finish(u.side);
        }
      }
    }
  }

  hitStructure(attacker: SideN, lane: LaneId, push: number) {
    const enemy = (1 - attacker) as SideN;
    const t = this.frontierTurret(enemy, lane);
    const champs = this.units.filter((u) => u.alive && u.side === attacker && !u.fightId && t && dist(u, t.pos) < 900);
    const minionDps = (14 + push * 4) * (this.laningPhase() ? 0.55 : 1) * (1 + Math.max(0, this.minute() - 20) / 15);
    if (t) {
      this.damageTurret(t, minionDps * DT, champs[0] ?? null);
      return;
    }
    const ih = this.inhibs.find((x) => x.side === enemy && x.lane === lane)!;
    if (ih.alive) {
      ih.hp -= minionDps * DT;
      if (ih.hp <= 0) this.destroyInhib(ih, attacker);
    }
  }

  damageTurret(t: TurretState, amount: number, by: Unit | null) {
    t.hp -= amount;
    if (t.tier === 1 && t.plates > 0 && this.t < 14 * 60) {
      const plateHp = t.maxHp - (5 - t.plates + 1) * (t.maxHp / 5);
      if (t.hp <= plateHp) {
        t.plates -= 1;
        if (by) by.gold += 125;
      }
    }
    if (t.hp <= 0 && t.alive) {
      t.alive = false;
      const side = (1 - t.side) as SideN;
      this.towers[side] += 1;
      for (const u of this.units) if (u.side === side) u.gold += by && u === by ? 300 : 70;
      const where = t.lane === "nexus" ? "쌍둥이" : `${t.lane === "top" ? "탑" : t.lane === "mid" ? "미드" : "바텀"} ${t.tier}차`;
      if (!this.firstTurret) {
        this.firstTurret = true;
        this.event("first_turret", side, `첫 포탑! ${josa(this.names[side], "이가")} ${where} 포탑을 파괴했습니다`, true, undefined, undefined, t.pos);
      } else this.event("turret", side, `${this.names[side]} ${where} 포탑 파괴`, false, undefined, undefined, t.pos);
    }
  }

  destroyInhib(ih: InhibState, by: SideN) {
    ih.alive = false;
    ih.hp = 0;
    ih.respawnAt = this.t + 300;
    this.event("inhib", by, `${this.names[by]}, ${ih.lane === "top" ? "탑" : ih.lane === "mid" ? "미드" : "바텀"} 억제기 파괴!`, true, undefined, undefined, ih.pos);
  }

  // ---------- objectives ----------
  objectivesTick() {
    for (const k of Object.keys(this.obj) as ObjKey[]) {
      const o = this.obj[k];
      if (!o.alive) continue;
      const at = this.units.filter((u) => u.alive && !u.fightId && dist(u, o.pos) < 650 && (!ENGINE_FLAGS.macro || Macro.hitsObjective(this, u, k)));
      if (!at.length) {
        o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.02 * DT);
        continue;
      }
      const bySide = [0, 0];
      for (const u of at) bySide[u.side] += this.aaDps(u) * 1.2 + 30;
      const contested = bySide[0] > 0 && bySide[1] > 0;
      o.hp -= (bySide[0] + bySide[1]) * DT * (contested ? 0.5 : 1);
      if (this.rng.chance(0.15)) {
        const hitter = at[Math.floor(this.rng.next() * at.length)];
        this.fx_({ kind: "objhit", side: hitter.side, x: hitter.x, y: hitter.y, tx: o.pos.x, ty: o.pos.y, color: "#ffd36b", r: 0, w: 0, from: hitter.i });
      }
      if (o.hp <= 0) {
        // last hit: smite fight between junglers near the pit
        let side: SideN = bySide[0] >= bySide[1] ? 0 : 1;
        const jg = [0, 1].map((sd) => this.units.find((u) => u.side === sd && u.role === "Jungle" && u.alive && dist(u, o.pos) < 900));
        let steal = false;
        const other = (1 - side) as SideN;
        if (jg[other] && (contested || this.rng.chance(0.3))) {
          const pSteal = clamp(0.12 + (jg[other]!.rating - (jg[side]?.rating ?? 60)) / 120 + (jg[side] ? 0 : 0.35), 0.03, 0.6);
          if (this.rng.chance(pSteal)) {
            side = other;
            steal = true;
          }
        }
        const taker = jg[side] ?? at.find((u) => u.side === side) ?? at[0];
        this.fx_({ kind: "smite", side, x: o.pos.x, y: o.pos.y, tx: o.pos.x, ty: o.pos.y, color: "#ffe28a", r: 320, w: 0, from: taker.i });
        this.secure(k, side, taker, steal);
      }
    }
  }

  secure(k: ObjKey, side: SideN, taker: Unit, steal: boolean) {
    const o = this.obj[k];
    const team = this.names[side];
    const respawn = this.meta.objectives[k]?.respawn ?? null;
    const mates = this.units.filter((u) => u.side === side);
    if (steal) this.event("steal", side, `스틸! ${josa(`${taker.name}(${taker.champ.name})`, "이가")} ${josa(OBJ_KO[k], "을를")} 빼앗았습니다`, true, taker.i, undefined, o.pos);
    if (k === "dragon") {
      this.dragons[side].push(o.type!);
      for (const u of mates) u.gold += 50;
      this.event("dragon", side, `${team}, ${o.type} 드래곤 처치 (${this.dragons[side].length}스택)`, false, taker.i, undefined, o.pos);
      if (this.dragons[side].length >= 4 && this.soul === null) {
        this.soul = side;
        this.event("soul", side, `${team}, ${this.soulType} 드래곤의 영혼 획득!`, true, undefined, undefined, o.pos);
        o.alive = false;
        o.spawnAt = null;
        this.obj.elder.spawnAt = this.t + (this.meta.objectives.elder?.respawn ?? 360);
        return;
      }
      const next = this.dragons[0].length + this.dragons[1].length;
      o.type = this.dragonOrder[Math.min(next, 2)];
      o.alive = false;
      o.spawnAt = this.t + (respawn ?? 300);
      return;
    }
    if (k === "elder") {
      for (const u of mates) if (u.alive) u.elderUntil = this.t + 150;
      this.event("elder", side, `${team}, 장로 드래곤 처치 (처형 버프)`, true, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = this.t + (respawn ?? 360);
      return;
    }
    if (k === "baron") {
      this.barons[side] += 1;
      for (const u of mates) {
        u.gold += 300;
        if (u.alive) u.baronUntil = this.t + 180;
      }
      this.event("baron", side, `${team}, 내셔 남작 처치!`, true, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = this.t + (respawn ?? 360);
      return;
    }
    if (k === "grubs") {
      this.grubs[side] += 3;
      this.event("grubs", side, `${team}, 공허 유충 3마리 처치`, false, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = null;
      return;
    }
    if (k === "herald") {
      this.heralds[side] += 1;
      this.event("herald", side, `${team}, 협곡의 전령 획득`, false, taker.i, undefined, o.pos);
      o.alive = false;
      o.spawnAt = null;
      // the herald charges the lane with the most standing enemy towers
      const lane = LANES.map((l) => ({ l, t: this.frontierTurret((1 - side) as SideN, l) })).filter((x) => x.t).sort((a, b) => a.t!.tier - b.t!.tier)[0];
      if (lane?.t) {
        // dash fx: x,y = where it lands (the turret), tx,ty = where it starts (the pit)
        this.fx_({ kind: "dash", side, x: lane.t.pos.x, y: lane.t.pos.y, tx: o.pos.x, ty: o.pos.y, color: "#b48cff", r: 300, w: 260, text: "전령 돌진" });
        this.damageTurret(lane.t, lane.t.maxHp * 0.45, taker);
      }
    }
  }

  // ---------- passive income ----------
  economy() {
    const m = this.minute();
    for (const u of this.units) {
      if (!u.alive) continue;
      if (this.t > 110) u.gold += 2.04 * DT;
      // xp and cs from waves
      const lane = ROLE_LANE[u.role];
      let nearWave = false;
      for (const l of LANES) if (dist(u, this.laneFrontPos(l)) < 1100) nearWave = true;
      const solo = u.role === "Top" || u.role === "Mid";
      if (nearWave && this.t > 55) {
        const share = u.role === "Support" ? 0.6 : u.role === "Bot" ? 0.8 : 1;
        u.xp += (solo ? 8.2 : 6.6) * share * DT * (1 + m / 60);
        if (u.role !== "Support") {
          const rate = (10.5 / 60) * (0.85 + u.rating / 500) * (lane ? 1 : 0.9);
          const gained = rate * DT * (this.rng.next() < 0.5 ? 1.6 : 0.4);
          u.cs += gained;
          u.gold += gained * 21;
        } else u.gold += 0.25 * DT * 4;
      } else if (u.role === "Jungle") {
        u.xp += (this.laningPhase() ? 1.5 : 4) * DT;
      } else {
        u.xp += (this.laningPhase() ? 1.2 : 3.5) * DT;
        // side waves and jungle camps away from the main fronts
        if (u.role !== "Support" && !u.fightId && this.t > 840) {
          const g = (6 / 60) * DT;
          u.cs += g;
          u.gold += g * 21;
        }
      }
      // level ups
      while (u.level < 18 && u.xp >= this.xpFor(u.level + 1)) {
        u.level += 1;
        const newMax = this.maxHp(u);
        u.hp += newMax - u.maxHp;
        u.maxHp = newMax;
      }
      if (this.rng.chance(0.02)) {
        const newMax = this.maxHp(u);
        u.hp = (u.hp / u.maxHp) * newMax;
        u.maxHp = newMax;
      }
    }
  }
  xpFor(level: number) {
    // cumulative xp to reach `level`
    const n = level - 1;
    return 180 * n + 50 * n * (n + 1);
  }

  checkEnd() {
    if (this.over) return;
  }

  finish(side: SideN) {
    if (this.over) return;
    this.over = true;
    this.winner = side;
    this.event("nexus", side, `${this.names[side]} 승리! 넥서스 파괴`, true, undefined, undefined, NEXUS[1 - side]);
  }

  gold(side: SideN) {
    return Math.round(this.units.filter((u) => u.side === side).reduce((a, u) => a + u.gold, 0));
  }

  /** Objective timers for the HUD: seconds until spawn (0 = up now), null = not coming. */
  timers(): { key: ObjKey | "camp"; label: string; at: number | null; alive: boolean }[] {
    return (Object.keys(this.obj) as ObjKey[]).map((k) => ({
      key: k,
      label: k === "dragon" ? `${this.obj.dragon.type ?? ""} 드래곤` : OBJ_KO[k],
      at: this.obj[k].spawnAt,
      alive: this.obj[k].alive,
    }));
  }
}

let mapReady = false;
function initMapOnce(data: GameData) {
  if (mapReady) return;
  initMap(data.heatmap);
  mapReady = true;
}

export { LANE_PATH };
