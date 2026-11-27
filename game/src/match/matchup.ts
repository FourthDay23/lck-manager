// Champion matchups measured on real LCK games (public/data/matchups.json, scripts/build_matchups.py).
//
// A matchup `m` is how champion A does against champion B in the same role beyond both champions' usual results and
// both teams' strength, in win logit: A's chance against an otherwise even game is logistic(m). The builder fits it
// jointly on LCK 2025-26 results and the 14:00 lane gold of the 2026 timelines and shrinks it with a prior chosen by
// the data (Laplace evidence). LCK matchups come out small (the largest pairs about 2%p): pros rarely play a lane they
// think they lose, so hard counters hardly appear in the games. Pairs that never met in LCK count as even.
//
// Where it is used
// - draft.ts: pick value against a revealed opponent, the risk of being counter-picked when the opponent is still
//   hidden (blind pick), bans that protect our picks, coach suggestions, the predicted win chance.
// - core/quick.ts: results-only games.
// - engine.ts / fight.ts: during laning, damage between lane opponents, who gets to poke, whether pokes land and the
//   lane CS share follow the matchup (dmgMul, laneEdge); it fades after 14:00 to a smaller rest for side lanes.
//   The engine numbers are fitted so a matchup of m wins about logistic(m) (scripts/matchup-check.ts).
// - Team compositions: engage / poke / peel counters (engage > poke > peel > engage) with the weights fitted on the
//   same LCK games. They came out near zero (slightly the other way), so they barely move anything. In the engine they
//   scale all champion damage of a side from 14:00 (compPhase), fitted like the lane factors.
// - Counter items (counterPath, called from items.ts init): the LCK build path turns toward magic resist / armor /
//   Grievous Wounds as often as LCK players did against that many enemy AP / AD / healer champions (LCK 2026: a top
//   laner had a magic resist legendary in the first four 22-26% of the time against 0-2 AP champions, 48% against 3).
// - MATCHUP_TUNE.gain scales every matchup at once (1 = the measured LCK size).
import type { GameData } from "../data/load";
import type { Engine, Unit } from "./engine";
import type { ItemData } from "./items";
import type { Role } from "../data/types";
import { ROLES } from "../data/types";
import { Rng } from "../core/rng";

/** [m, games, wins of a, mean 14:00 lane gold lead of a (null without a timeline), timeline games] */
export type PairRow = [number, number, number, number | null, number];

export interface MatchupData {
  source: string;
  games: number;
  goldGames: number;
  goldMinute: number;
  /** win logit per gold of 14:00 team gold lead (LCK 2026) */
  goldSlope: number;
  goldSigma: number;
  tau: number;
  roles: Record<Role, Record<string, PairRow>>;
  comp: { keys: ("engage" | "poke" | "peel")[]; mean: number[]; sd: number[]; w: number[] };
  /** LCK 2026: how often a role had a magic resist / armor / Grievous Wounds legendary among its first four, by the
   *  number of enemy AP / AD / healer champions (0..5), and the role's most bought items of that kind */
  counterItems?: Record<CounterKind, CounterRow> & { healer: number };
}
export type CounterKind = "mr" | "armor" | "antiheal";
export interface CounterRow {
  feature: "ap" | "ad" | "heal";
  base: Record<Role, number>;
  rates: Record<Role, number[]>;
  items: Record<Role, number[]>;
  /** most bought items of that kind per role and champion class (first Data Dragon tag), and per class */
  byRoleClass?: Partial<Record<Role, Record<string, number[]>>>;
  byClass?: Record<string, number[]>;
}

/**
 * gain: scales every matchup (1 = the LCK size). The engine factors are per logit of matchup, fitted with
 * scripts/matchup-check.ts so that a matchup of m wins logistic(m) of otherwise even games and leads its lane by about
 * m / goldSlope gold at 14:00, as in LCK; `force` / `forceComp` let that script put a matchup on a role or the teams.
 * Fitting (2026-11-27, Mid, m = 0.4, 600 games each; target 59.9 % and +808 gold):
 *   lane factors only (dmg .5 / init .35 / cs .2): +1,122 gold at m 0.6 but 55.6 % (target 64.6): the engine turns one
 *     lane's lead into wins more weakly than LCK (~0.2 vs 0.5 win logit per 1,000 gold), and a damage bonus for the
 *     winner after laning barely helped (x2.3 damage still only 61.5 %)
 *   + rating 15 / 25: 56.0 % +977 / 59.5 % +1,216; lower lane factors with rating 20: 56.2 % +933
 *   -> rating carries the win, small lane factors shape the 14:00 lead; the rating is per role (ratingTop..Support):
 *   final check at 13 / 24 / 28 / 5 / 34: Top 60.5 %, Jungle 60.3 %, Mid 61.8 %, Bot 58.0 %, Support 58.8 % (+-2.0).
 */
export const MATCHUP_TUNE = {
  gain: 1,
  /** damage between lane opponents: x exp(dmg x m) */
  dmg: 0.15,
  /** chance to be the one who pokes, and that the poke lands: + init x m */
  init: 0.1,
  /** lane CS / gold share near the wave: x (1 + cs x m), zero-sum between the two */
  cs: 0.06,
  /** after laning (14:00) the lane effects fade to `rest` by 20:00 */
  rest: 0.35,
  /** the matchup as player strength for the whole game: rating + ratingRole x m (the engine already turns rating
   *  into wins the way the win formula does). Per role, because the same rating moves some roles' games more
   *  (a top laner's edge turns into solo kills, an ADC carries). Matchup 0.4, 600 games each, target 59.9 %:
   *  at 26: Top 68.8 % (+1,519 gold at 14:00), Jungle 61.0 %, Mid 58.9 % (+684), Bot 74.0 % (+464), Support 57.7 %;
   *  Bot at 10: 63.7 % (+255). Scaled in win logit (Bot from its two points) to: */
  ratingTop: 13,
  ratingJungle: 24,
  ratingMid: 28,
  ratingBot: 5,
  ratingSupport: 34,
  /** composition counters: all champion damage of the side x exp(comp x edge), from 14:00, full from 20:00
   *  (comp edge 0.6: factor 0.3 won 69.4 %, 0.6 won 83.1 %, target 64.6 %) */
  comp: 0.22,
  force: null as null | { role: Role; m: number },
  /** blue's composition edge for matchup-check.ts (red gets the opposite) */
  forceComp: null as null | number,
};

export interface PairInfo { m: number; n: number; wins: number; gold: number | null; ng: number }

/** a against b in role r from a's side, or null when the two never met in LCK (or no table is loaded). */
export function pair(data: GameData, r: Role, a: string | undefined, b: string | undefined): PairInfo | null {
  const t = data.matchups?.roles?.[r];
  if (!t || !a || !b || a === b) return null;
  const flip = a > b;
  const row = t[flip ? `${b}|${a}` : `${a}|${b}`];
  if (!row) return null;
  const [m, n, wa, g, ng] = row;
  return flip ? { m: -m, n, wins: n - wa, gold: g === null ? null : -g, ng } : { m, n, wins: wa, gold: g, ng };
}

/** Matchup of a against b in win logit (0 for unknown pairs), with the gain applied. */
export function edge(data: GameData, r: Role, a: string | undefined, b: string | undefined): number {
  const p = pair(data, r, a, b);
  return p ? p.m * MATCHUP_TUNE.gain : 0;
}

type Picks = Partial<Record<Role, string>>;

export function laneEdges(data: GameData, A: Picks, B: Picks): Record<Role, number> {
  const out = {} as Record<Role, number>;
  for (const r of ROLES) out[r] = edge(data, r, A[r], B[r]);
  return out;
}

/** Team composition counters (engage > poke > peel > engage) for A against B, win logit, fitted on LCK. */
export function compEdge(data: GameData, A: Picks, B: Picks): number {
  const cm = data.matchups?.comp;
  if (!cm) return 0;
  const prof = (P: Picks) => {
    const cs = ROLES.map((r) => (P[r] ? data.champ.get(P[r]!) : undefined));
    if (cs.some((c) => !c)) return null;
    return cm.keys.map((k, i) => (cs.reduce((a, c) => a + (c!.style[k] ?? 5), 0) / 5 - cm.mean[i]) / (cm.sd[i] || 1));
  };
  const a = prof(A), b = prof(B);
  if (!a || !b) return 0;
  const [E, P, D] = [0, 1, 2];
  const t = [a[E] * b[P] - b[E] * a[P], a[P] * b[D] - b[P] * a[D], a[D] * b[E] - b[D] * a[E]];
  return t.reduce((s, v, i) => s + v * (cm.w[i] ?? 0), 0) * MATCHUP_TUNE.gain;
}

/** All matchups of side A against side B (lanes + composition), win logit. */
export function draftEdge(data: GameData, A: Picks, B: Picks): number {
  const l = laneEdges(data, A, B);
  return ROLES.reduce((s, r) => s + l[r], 0) + compEdge(data, A, B);
}

/** Picks as role -> champion from the role-ordered list quick.ts uses. */
export function byRole(champs: string[]): Picks {
  const out: Picks = {};
  ROLES.forEach((r, i) => { if (champs[i]) out[r] = champs[i]; });
  return out;
}

// ---------- opponents of one champion ----------
interface Opp { id: string; m: number; n: number }
const index = new WeakMap<object, Map<string, Opp[]>>();
/** Every LCK opponent of champ in role r, m from champ's side. */
export function opponents(data: GameData, r: Role, champ: string): Opp[] {
  const t = data.matchups?.roles?.[r];
  if (!t) return [];
  let idx = index.get(t);
  if (!idx) {
    idx = new Map();
    for (const [key, row] of Object.entries(t)) {
      const [a, b] = key.split("|");
      const push = (x: string, o: Opp) => { const l = idx!.get(x) ?? []; l.push(o); idx!.set(x, l); };
      push(a, { id: b, m: row[0], n: row[1] });
      push(b, { id: a, m: -row[0], n: row[1] });
    }
    index.set(t, idx);
  }
  return idx.get(champ) ?? [];
}

/** The champions champ does best and worst against in LCK (at least minN games, |m| above noise). */
export function bestWorst(data: GameData, r: Role, champ: string, k = 3, minN = 3) {
  const l = opponents(data, r, champ).filter((o) => o.n >= minN && Math.abs(o.m) >= 0.005);
  return {
    good: l.filter((o) => o.m > 0).sort((a, b) => b.m - a.m).slice(0, k),
    bad: l.filter((o) => o.m < 0).sort((a, b) => a.m - b.m).slice(0, k),
  };
}

// ---------- words for the screens ----------
/** Win-chance points (%p) of a matchup against an even game. */
export function pctPoints(m: number): number {
  return (1 / (1 + Math.exp(-m)) - 0.5) * 100;
}
/** Worth naming on screen: a quarter of a win-rate point or more (below that the words say "비슷"). */
export function notable(m: number): boolean {
  return Math.abs(pctPoints(m)) >= 0.25;
}
/** A coach with a weak draft rating only says the direction; a good one gives the number. */
export function edgeWord(m: number, exact: boolean): string {
  const p = pctPoints(m);
  if (exact) return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%p`;
  const a = Math.abs(p);
  if (a < 0.25) return "비슷";
  return (a >= 1 ? "" : "약간 ") + (p > 0 ? "유리" : "불리");
}
/** The coach knows matchup numbers from a draft rating of 60 (or 50 with a good analysis room). */
export function coachExact(draftRating: number, analysis: number): boolean {
  return draftRating + analysis * 4 >= 60;
}

// ---------- match engine ----------
interface EState {
  /** each unit's matchup against the enemy of its role, from its side */
  mu: number[];
  /** its lane's matchups from its side: the bot lane adds the ADC and the support pairs, other lanes are mu */
  lane: number[];
  /** composition counter edge of each side (blue, red) */
  comp: [number, number];
}
const states = new WeakMap<Engine, EState>();
const BOT_LANE = (r: Role) => r === "Bot" || r === "Support";

/** Called once the engine has its units (engine.ts constructor). */
export function init(e: Engine) {
  const f = MATCHUP_TUNE.force;
  const mu = e.units.map((u) => {
    if (f && f.role === u.role) return u.side === 0 ? f.m : -f.m;
    const o = e.units.find((x) => x.side !== u.side && x.role === u.role);
    return o ? edge(e.data, u.role, u.champ.id, o.champ.id) : 0;
  });
  const lane = e.units.map((u) => (BOT_LANE(u.role)
    ? e.units.filter((x) => x.side === u.side && BOT_LANE(x.role)).reduce((a, x) => a + mu[x.i], 0)
    : mu[u.i]));
  const picks = (side: number) => {
    const p: Picks = {};
    for (const u of e.units) if (u.side === side) p[u.role] = u.champ.id;
    return p;
  };
  const c = MATCHUP_TUNE.forceComp ?? compEdge(e.data, picks(0), picks(1));
  states.set(e, { mu, lane, comp: [c, -c] });
  // the rest of the matchup as player strength (MATCHUP_TUNE.ratingTop..ratingSupport, each player its own pair)
  for (const u of e.units) u.rating += MATCHUP_TUNE[`rating${u.role}`] * mu[u.i];
}

/** 0 during laning, up to 1 by 20:00: when teams group and the compositions meet. */
export function compPhase(e: Engine): number {
  return Math.max(0, Math.min(1, (e.t / 60 - 14) / 6));
}

/** 1 during laning, then down to MATCHUP_TUNE.rest by 20:00 (side lanes keep some of it). */
export function fade(e: Engine): number {
  const m = e.t / 60;
  if (m <= 14) return 1;
  if (m >= 20) return MATCHUP_TUNE.rest;
  return 1 - ((1 - MATCHUP_TUNE.rest) * (m - 14)) / 6;
}

/** u's lane matchup right now (win logit, faded). */
export function laneEdge(e: Engine, u: Unit): number {
  const st = states.get(e);
  return st ? st.lane[u.i] * fade(e) : 0;
}

/** Matchup of a against b right now: solo lanes -> their pair; the bot lane is one 2v2 lane, so any hit between its
 *  four players uses the lane total (ADC + support pairs), like the pokes, all-ins and CS share do; else 0. */
export function pairEdge(e: Engine, a: Unit, b: Unit): number {
  const st = states.get(e);
  if (!st || a.side === b.side) return 0;
  if (BOT_LANE(a.role) && BOT_LANE(b.role)) return st.lane[a.i] * fade(e);
  if (a.role === b.role) return st.mu[a.i] * fade(e);
  return 0;
}

/** Damage multiplier when src hits v (fight.ts hurt, engine.ts lane pokes): the lane matchup between lane opponents,
 *  and from 14:00 the composition counter of src's side against everyone. */
export function dmgMul(e: Engine, src: Unit, v: Unit): number {
  const st = states.get(e);
  if (!st || src.side === v.side) return 1;
  const x = MATCHUP_TUNE.dmg * pairEdge(e, src, v) + MATCHUP_TUNE.comp * st.comp[src.side] * compPhase(e);
  return x ? Math.exp(x) : 1;
}

// ---------- counter items ----------
const COUNTER_KINDS: CounterKind[] = ["mr", "armor", "antiheal"];
// items whose passive applies Grievous Wounds in the engine (itemfx.ts); scripts/build_matchups.py uses the same list
const GW_ITEMS = new Set([3033, 3165, 3075, 6609]);

function isKind(items: ItemData, k: CounterKind, id: number): boolean {
  const it = items.items[String(id)];
  if (!it || it.kind !== "legendary") return false;
  return k === "mr" ? (it.stats.mr ?? 0) > 0 : k === "armor" ? (it.stats.armor ?? 0) > 0 : GW_ITEMS.has(id);
}

/**
 * Adjust a unit's LCK build path (items.ts init) to the enemy composition the way LCK players do: the chance to have a
 * magic resist / armor / Grievous Wounds legendary among the first four follows counterItems[kind].rates[role][n]
 * for n enemy AP / AD / healer champions. The usual path stands for the role's usual rate (`base`): above it a path
 * without such an item gets its class's most bought one (champion class = first Data Dragon tag) as the third
 * legendary with probability (p - base) / (1 - base); below it a path with one drops it with (base - p) / base and the
 * next item of the champion's own LCK path (`own`) moves up. It never drops the chosen build's core (`keep`), an item
 * it just added, or one that also counts for another kind; without a fitting item it leaves the path alone.
 * The draws come from a generator derived from the engine's state, so the engine's own random stream is untouched.
 */
export function counterPath(e: Engine, u: Unit, path: number[], own: number[], keep: number[], items: ItemData): number[] {
  const ci = e.data.matchups?.counterItems;
  if (!ci || !path.length) return path;
  const rng = new Rng((e.rng.state ^ Math.imul(u.i + 1, 0x9e3779b1)) >>> 0);
  const foes = e.units.filter((x) => x.side !== u.side).map((x) => x.champ);
  const feat = {
    ap: foes.filter((c) => c.damage === "AP").length,
    ad: foes.filter((c) => c.damage === "AD").length,
    heal: foes.filter((c) => (c.style.sustain ?? 5) >= ci.healer).length,
  };
  const cls = u.champ.tags[0] ?? "Fighter";
  let out = path.slice();
  const added = new Set<number>();
  const legs = () => out.filter((id) => items.items[String(id)]?.kind === "legendary");
  const otherKind = (k: CounterKind, id: number) => COUNTER_KINDS.some((o) => o !== k && isKind(items, o, id));
  for (const k of COUNTER_KINDS) {
    const row = ci[k];
    const rates = row?.rates[u.role];
    if (!rates) continue;
    const base = row.base[u.role];
    const p = rates[Math.min(rates.length - 1, feat[row.feature])];
    const has = legs().slice(0, 4).find((id) => isKind(items, k, id));
    if (has === undefined && p > base && base < 1 && rng.chance((p - base) / (1 - base))) {
      // one of that kind later in the path moves up instead of a second one coming in (no two Grievous Wounds items)
      const later = legs().find((id) => isKind(items, k, id));
      if (later !== undefined) out.splice(out.indexOf(later), 1);
      const list = row.byRoleClass?.[u.role]?.[cls] ?? row.byClass?.[cls] ?? [];
      const add = later ?? list.find((id) => !out.includes(id) && items.items[String(id)]?.kind === "legendary");
      if (add === undefined) continue;
      // in as the third legendary (after the first two of the path), the last legendary drops off
      const l = legs();
      const at = l.length >= 2 ? out.indexOf(l[1]) + 1 : out.length;
      out.splice(at, 0, add);
      added.add(add);
      const last = legs()[5];
      if (last !== undefined) out.splice(out.lastIndexOf(last), 1);
    } else if (has !== undefined && p < base && base > 0 && !keep.includes(has) && !added.has(has) && !otherKind(k, has)
      && rng.chance((base - p) / base)) {
      const next = own.find((id) => !out.includes(id) && items.items[String(id)]?.kind === "legendary" && !isKind(items, k, id));
      if (next !== undefined) out = out.map((id) => (id === has ? next : id));
    }
  }
  return out.slice(0, 6);
}
