// Items, runes (keystones) and kill bounties, built from 502 real LCK 2026 games (public/data/items.json,
// scripts/build_items.py). Owner: main game session. Engine hooks (engine.ts): itemPower(u, channel), the item/
// keystone multipliers in aaDps / spellDmg / maxHp, tick() once per step, killGold() in kill().
//
// How items change the fight numbers
// - Gold only turns into strength when it is spent: a unit "shops" whenever it stands in its fountain (recall or
//   respawn). Bought gold follows the champion's real LCK purchase path; finished items count 1.1 per gold,
//   components of the next item 0.8, gold past the full build 0.9 (ITEM_TUNE). Before items.json the engine counted all
//   earned gold at once (itemPower = (gold - 500) / 3000); for an average build these weights give about the same
//   total, so the engine's calibration holds, but power now jumps when an item is finished and lags until a recall.
// - Item stats decide where the strength goes. Stat gold (AD 35, AP 20, HP 2.67, armor 20, MR 18, 1% AS 25,
//   1% crit 40, lethality 30, magic pen 31) is split into three channels: auto attacks (AD/AS/crit/lethality),
//   spells (AP/magic pen) and bulk (HP/armor/MR). Each channel is compared with the average build of the champion's
//   class (first Data Dragon tag), so a usual build keeps the old numbers and a tank or damage build shifts them.
// - Statistics pick the default and add a small edge: every champion uses its most played LCK build and keystone
//   unless the coach picks another one. The chosen option's win rate, shrunk toward the champion's own win rate
//   (EDGE_PRIOR games), minus that win rate, is its edge; capped at +/-3 points, each point of win rate is worth 0.8%
//   damage. Keystones also carry a small timing profile (early / mid / late), centred on zero over all keystones.
import type { Engine, Unit } from "./engine";
import type { GameData } from "../data/load";
import type { ChampionData, Role } from "../data/types";
import { FOUNTAIN } from "./map";
// circular with core/quick.ts (which imports defaultEdgePower); read only inside functions, so load order is safe
import { POWER_SCALE } from "../core/quick";

export interface ItemStats { ad?: number; ap?: number; hp?: number; armor?: number; mr?: number; as?: number; crit?: number; haste?: number; leth?: number; mpen?: number; ms?: number }
export interface ItemDef { name: string; cost: number; kind: "legendary" | "boots" | "support"; stats: ItemStats; n: number; w: number; removed?: boolean; iconVer?: string; from?: number[] }
/** A component item (not a finished build item): name, full cost, its own components (Data Dragon `from`). */
export interface PartDef { name: string; cost: number; from: number[] }
export interface KeystoneDef { name: string; tree: number; treeName: string; icon: string; n: number; w: number }
export interface BuildOpt { core: number[]; boots?: number; n: number; w: number }
export interface KeystoneOpt { id: number; sub: number; n: number; w: number }
export interface ChampItems {
  n: number; w: number; builds: BuildOpt[]; path: number[]; keystones: KeystoneOpt[]; spike?: number[];
  /** most played role in the games (champion entries only) */
  role?: Role;
  /** flex picks (3+ games in 2+ roles): the same record per role */
  roles?: Partial<Record<Role, ChampItems>>;
}
/** Kill and objective bounty fits from the same games (see scripts/build_items.py, `bounty`). */
export interface BountyData {
  killBase: number;
  killLevel: { perLevel: number; fromLevel: number; max: number };
  firstBloodExtra: number;
  deathStreakFit: { params: { perDeath: number; perDeficit: number; relPivot: number; floor: number } };
  shutdown: { params: { perKill: number; perAssist: number; perGoldLead: number; teamFrom: number; teamFull: number; cap: number } };
  goldCheck?: { assist?: { assisters: number; eachPerBounty: number }[] };
  objective: {
    activeFrom: number;
    byType: Record<string, { mode?: number; share: number }>;
    /** [deficit bucket start, objectives taken, share paid, mean paid] */
    byDeficit: [number, number, number, number][];
  };
}
export interface ItemData {
  version: string;
  games: number;
  patches: string[];
  items: Record<string, ItemDef>;
  /** every component of the finished items, down the recipe tree */
  parts?: Record<string, PartDef>;
  keystones: Record<string, KeystoneDef>;
  trees: Record<string, { name: string; icon: string }>;
  champs: Record<string, ChampItems>;
  roleDefaults: Partial<Record<Role, ChampItems>>;
  bounty: BountyData;
}

/** The coach's choice for one player: index into the champion's builds / keystones (0 = most played in LCK). */
export interface Loadout { build: number; keystone: number }
export type SideLoadout = Partial<Record<Role, Loadout>>;

/**
 * The engine's economy runs below real LCK gold (scripts/items-check.ts, 2026-11-26, 20-25 min): Top 1.09x, Jungle
 * 1.30x, Mid 1.13x, Bot 1.35x, Support 1.30x real/engine. Its fight numbers are calibrated on its own gold, so the
 * gold is left alone and only item purchases are read on the real scale (items finish at real LCK minutes);
 * itemPower converts back. Re-measure with items-check.ts if the engine's gold income changes.
 */
export const ROLE_GOLD_SCALE: Record<Role, number> = { Top: 1.09, Jungle: 1.3, Mid: 1.13, Bot: 1.35, Support: 1.3 };
/**
 * Gold weights in itemPower and the objective-bounty switch; scripts/calibrate.ts can override them (ITEM_TUNE).
 * Chosen on 150-game runs (2026-11-26 21h; real LCK 32.2 min / 29.5 kills, engine without items 33.1 / 28.8):
 * 1.06 / 0.75 / 0.5 gave 34.9 min / 32.8 kills (gold only counts after a recall, so average item power ran low and
 * leads took longer to close), 0.85 past the full build alone changed nothing, no objective bounty 34.0 / 31.5,
 * 1.1 / 0.8 / 0.9 with bounties 33.5 / 30.1.
 */
export const ITEM_TUNE = {
  finished: 1.1, parts: 0.8, beyond: 0.9, objectiveBounty: true,
  /** recall wish rises from urgeLo to urgeHi times the real players' usual gold (SHOP_AT) */
  urgeLo: 1.0, urgeHi: 1.6,
  /** chance per 0.25 s step to start the recall: base + urge x slope (see recallChance) */
  recallBase: 0.003, recallSlope: 0.02,
};
// Recall tuning (items-check.ts, 30 games each, 2026-11-26 21:40): 0.7-1.3 / 0.004 + 0.03 recalled too often in lane
// (3.5-4 visits before 10 min, real 2.6-3.4) and killed the early game (first blood 7.3 min, real 5.1; 36.9 min /
// 34 kills); 1.0-1.6 / 0.003 + 0.02 gives 2.7-3.5 early visits, 10-11 per 30 min (real 11.5-12.4), first blood 5.2,
// 33.7 min / 29.0 kills (real 32.2 / 29.5).
export const EDGE_PRIOR = 60;
export const EDGE_CAP = 0.03;
const EDGE_TO_POWER = 0.8;
type Channel = "aa" | "sp" | "hp";

// ---------- icons ----------
const CDN = "https://ddragon.leagueoflegends.com/cdn";
export function itemImg(data: ItemData, id: number): string {
  const it = data.items[String(id)];
  return `${CDN}/${it?.iconVer ?? data.version}/img/item/${id}.png`;
}
export function runeImg(icon: string): string {
  return `${CDN}/img/${icon}`;
}

// ---------- statistics ----------
/** The record for a champion in a role: its own games in that role, else its games if they carry over (carry roles
 *  share builds; support and non-support do not), else the role's default. */
export function champItems(data: ItemData, champ: string, role: Role): ChampItems | null {
  const c = data.champs[champ];
  const def = data.roleDefaults[role] ?? null;
  if (!c) return def;
  const own = c.roles?.[role];
  if (own) return own;
  if (!c.role || c.role === role) return c;
  return (c.role === "Support") !== (role === "Support") ? def : c;
}

/** True when champItems() gives the champion's own LCK games (not a role default). */
export function hasOwnRecord(data: ItemData, champ: string, role: Role): boolean {
  const ci = champItems(data, champ, role);
  return !!ci && ci !== data.roleDefaults[role];
}

/** Win-rate edge of an option over the champion's own record, shrunk toward it and capped. */
export function optionEdge(ci: ChampItems, n: number, w: number): number {
  const base = ci.n ? ci.w / ci.n : 0.5;
  const shrunk = (w + EDGE_PRIOR * base) / (n + EDGE_PRIOR);
  return Math.max(-EDGE_CAP, Math.min(EDGE_CAP, shrunk - base));
}

/** Purchase order for a build: its core first, the rest of the champion's usual path after, boots and the support
 *  item at the position they usually take. A short path (champions with one or two games) is filled up to five
 *  legendaries from `fill` (the role default), so a rare pick does not stop getting stronger mid game. */
export function buildPath(data: ItemData, ci: ChampItems, buildIdx: number, fill?: ChampItems | null): number[] {
  const b = ci.builds[buildIdx] ?? ci.builds[0];
  const kind = (id: number) => data.items[String(id)]?.kind;
  const special = (id: number) => kind(id) === "boots" || kind(id) === "support";
  const rest = ci.path.filter((id) => !special(id) && !(b?.core ?? []).includes(id));
  const main = [...(b?.core ?? []), ...rest].slice(0, 5);
  for (const id of fill?.path ?? []) if (main.length < 5 && !special(id) && !main.includes(id)) main.push(id);
  const out = [...main];
  // boots / support item go back where the usual path has them (counted in finished legendaries before them);
  // the build's own boots take the place of the path's boots
  const specials = ci.path.filter(special).map((id) => ({ id, at: ci.path.indexOf(id) }));
  if (b?.boots && !specials.some((x) => x.id === b.boots)) {
    const old = specials.find((x) => kind(x.id) === "boots");
    if (old) old.id = b.boots;
    else specials.push({ id: b.boots, at: -1 });
  }
  for (const sp of specials) {
    const before = sp.at < 0 ? 1 : ci.path.slice(0, sp.at).filter((id) => !special(id)).length;
    out.splice(Math.min(out.length, before + out.filter(special).length), 0, sp.id);
  }
  return out.filter((id) => data.items[String(id)]).slice(0, 6);
}

const STAT_GOLD: Record<keyof ItemStats, [Channel, number] | null> = {
  ad: ["aa", 35], as: ["aa", 25], crit: ["aa", 40], leth: ["aa", 30],
  ap: ["sp", 20], mpen: ["sp", 31],
  hp: ["hp", 2.67], armor: ["hp", 20], mr: ["hp", 18],
  haste: null, ms: null,
};
function channelGold(it: ItemDef | undefined): Record<Channel, number> {
  const out = { aa: 0, sp: 0, hp: 0 };
  if (!it) return out;
  for (const [k, v] of Object.entries(it.stats ?? {}) as [keyof ItemStats, number][]) {
    const g = STAT_GOLD[k];
    // ddragon keeps attack speed and crit as fractions (0.35); the build script may already give percent
    if (g) out[g[0]] += (k === "as" || k === "crit") && v <= 1 ? v * 100 * g[1] : v * g[1];
  }
  return out;
}
function shares(g: Record<Channel, number>): Record<Channel, number> {
  const t = g.aa + g.sp + g.hp || 1;
  return { aa: g.aa / t, sp: g.sp / t, hp: g.hp / t };
}

/** Average channel shares of each champion class (first tag), over the first four path items, weighted by games. */
const classCache = new WeakMap<ItemData, Map<string, Record<Channel, number>>>();
function classShares(data: GameData, items: ItemData, champ: ChampionData): Record<Channel, number> {
  let m = classCache.get(items);
  if (!m) {
    const acc = new Map<string, { g: Record<Channel, number>; n: number }>();
    for (const [id, ci] of Object.entries(items.champs)) {
      const c = data.champ.get(id);
      if (!c) continue;
      const cls = c.tags[0] ?? "Fighter";
      const sh = shares(sumGold(items, ci.path.slice(0, 4)));
      const a = acc.get(cls) ?? { g: { aa: 0, sp: 0, hp: 0 }, n: 0 };
      for (const ch of ["aa", "sp", "hp"] as Channel[]) a.g[ch] += sh[ch] * ci.n;
      a.n += ci.n;
      acc.set(cls, a);
    }
    m = new Map([...acc].map(([k, v]) => [k, { aa: v.g.aa / v.n, sp: v.g.sp / v.n, hp: v.g.hp / v.n }]));
    classCache.set(items, m);
  }
  return m.get(champ.tags[0] ?? "Fighter") ?? { aa: 0.4, sp: 0.3, hp: 0.3 };
}
function sumGold(items: ItemData, ids: number[]): Record<Channel, number> {
  const out = { aa: 0, sp: 0, hp: 0 };
  for (const id of ids) {
    const g = channelGold(items.items[String(id)]);
    out.aa += g.aa; out.sp += g.sp; out.hp += g.hp;
  }
  return out;
}

// ---------- keystone timing profiles (design values, centred on zero) ----------
// NOTE for the combat-stats session (stats.ts / procs.ts): once real keystone procs and item stats drive the fight
// numbers, drop these profiles and the channel weights (`w`) here, or keystones and builds count twice. The
// statistical edge (ksEdge / buildEdge in mul()) and the purchase model stay useful either way.
// [early < 14 min, mid, late > 28 min] added to the multiplier of the listed channels
const KS_PROFILE: Record<number, Partial<Record<Channel, [number, number, number]>>> = {
  8005: { aa: [0.02, 0.01, 0] },            // 집중 공격
  8008: { aa: [-0.03, 0.01, 0.04] },        // 치명적 속도
  8021: { hp: [0.02, 0.01, 0] },            // 기민한 발놀림
  8010: { aa: [-0.01, 0.01, 0.02], sp: [-0.01, 0.01, 0.02] }, // 정복자
  8112: { sp: [0.03, 0.01, -0.01], aa: [0.02, 0, -0.01] },   // 감전
  8128: { sp: [-0.02, 0, 0.03], aa: [-0.02, 0, 0.03] },      // 어둠의 수확
  9923: { aa: [0.03, 0, -0.02] },           // 칼날비
  8124: { aa: [0.02, 0, -0.01], sp: [0.02, 0, -0.01] },      // 포식자
  8214: { sp: [0.01, 0.01, 0] },            // 콩콩이 소환
  8229: { sp: [0.01, 0.01, 0] },            // 신비로운 유성
  8437: { hp: [0.03, 0.01, 0], aa: [0.01, 0, -0.01] },       // 착취의 손아귀
  8439: { hp: [0.02, 0.02, 0.02], aa: [-0.01, -0.01, -0.01], sp: [-0.01, -0.01, -0.01] }, // 여진
  8465: { hp: [0.01, 0.01, 0.01], sp: [-0.01, 0, 0] },       // 수호자
  8369: { aa: [0, 0.01, 0.02], sp: [0, 0.01, 0.02] },        // 선제공격
};

// ---------- per-engine state ----------
interface UState {
  ci: ChampItems | null;
  path: number[];
  cum: number[]; // cumulative cost of the first k path items
  /** where the build's stats go: auto attacks / spells / bulk, around 1 for the class's usual build */
  w: Record<Channel, number>;
  owned: number;
  shopGold: number;
  keystone: number | null;
  ksEdge: number;
  buildEdge: number;
  build: number;
  ksIdx: number;
  /** shop visits: game time and engine gold spent (for checks against the real games) */
  shops: { t: number; gold: number }[];
  /** standing in the fountain area last step (a visit starts on arrival) */
  inBase: boolean;
}
interface EState {
  items: ItemData;
  u: UState[];
  /** victim deaths since their last kill, and assists since their last death (bounty inputs) */
  deathStreak: number[];
  assistsSinceDeath: number[];
  /** events already checked for objective bounties */
  evSeen: number;
}
const states = new WeakMap<Engine, EState>();

export function init(e: Engine, loadouts?: [SideLoadout | undefined, SideLoadout | undefined]) {
  const items = e.data.items;
  if (!items) return;
  const us: UState[] = e.units.map((u) => {
    const ci = champItems(items, u.champ.id, u.role);
    const lo = loadouts?.[u.side]?.[u.role] ?? { build: 0, keystone: 0 };
    const build = ci && ci.builds[lo.build] ? lo.build : 0;
    const ksIdx = ci && ci.keystones[lo.keystone] ? lo.keystone : 0;
    const path = ci ? buildPath(items, ci, build, items.roleDefaults[u.role]) : [];
    const cum = [0];
    for (const id of path) cum.push(cum[cum.length - 1] + (items.items[String(id)]?.cost ?? 3000));
    const b = ci?.builds[build], k = ci?.keystones[ksIdx];
    return {
      ci, path, cum, owned: 0, shopGold: u.gold, build, ksIdx, shops: [], inBase: true,
      w: channelWeights(items, path, classShares(e.data, items, u.champ)),
      keystone: k?.id ?? null,
      ksEdge: ci && k ? optionEdge(ci, k.n, k.w) : 0,
      buildEdge: ci && b ? optionEdge(ci, b.n, b.w) : 0,
    };
  });
  states.set(e, { items, u: us, deathStreak: e.units.map(() => 0), assistsSinceDeath: e.units.map(() => 0), evSeen: 0 });
}

// ---------- bounties (제압골) ----------
const teamGold = (e: Engine, side: number) => e.units.filter((u) => u.side === side).reduce((a, u) => a + u.gold, 0);

/**
 * Gold for a kill, with the formulas fitted on the real games (Riot's hidden bounty state is not in the data, so
 * these are its observable shape):
 *  - base: 300, +10 per victim level above 6 (max 420), +100 for first blood;
 *  - a victim who keeps dying is worth less: base x (1 - deaths x (a + b x max(0, pivot - rel))), at least 100,
 *    deaths = deaths since their last kill, rel = their gold / the average of all ten;
 *  - shutdown (paid to the killer only): min(700, 104.6 K + 13 A + 0.0162 x gold lead over the average), scaled by
 *    how far the victim's team is ahead (nothing once it is about 1k behind, full at 4k ahead);
 *  - each assister gets a share of the base that shrinks with more assisters (49 / 29 / 25 / 22 %).
 * Call before the engine resets the victim's kill streak. Updates the streak counters itself.
 */
export function killGold(e: Engine, killer: Unit | null, v: Unit, assisters: Unit[], firstBlood: boolean): { bounty: number; shutdown: number; assist: number } | null {
  const st = states.get(e);
  if (!st) return null;
  const B = st.items.bounty;
  const avg = e.units.reduce((a, u) => a + u.gold, 0) / e.units.length;
  const rel = v.gold / Math.max(1, avg);
  let base = Math.min(B.killLevel.max, B.killBase + B.killLevel.perLevel * Math.max(0, v.level - B.killLevel.fromLevel));
  if (firstBlood) base += B.firstBloodExtra;
  const ds = B.deathStreakFit.params;
  const deaths = st.deathStreak[v.i];
  const bounty = Math.round(Math.max(ds.floor, base * (1 - deaths * (ds.perDeath + ds.perDeficit * Math.max(0, ds.relPivot - rel)))));
  const sp = B.shutdown.params;
  const K = v.streak, A = st.assistsSinceDeath[v.i];
  const lead = v.gold - avg;
  const T = teamGold(e, v.side) - teamGold(e, 1 - v.side);
  const teamF = Math.max(0, Math.min(1, (T - sp.teamFrom) / (sp.teamFull - sp.teamFrom)));
  const shutdown = Math.round(Math.min(sp.cap, Math.max(0, sp.perKill * K + sp.perAssist * A + sp.perGoldLead * Math.max(0, lead))) * teamF);
  const shares = B.goldCheck?.assist ?? [];
  const n = Math.max(1, Math.min(4, assisters.length));
  const each = shares.find((x) => x.assisters === n)?.eachPerBounty ?? [0.49, 0.29, 0.25, 0.22][n - 1];
  // counters for the next kills
  st.deathStreak[v.i] += 1;
  st.assistsSinceDeath[v.i] = 0;
  if (killer) st.deathStreak[killer.i] = 0;
  for (const a of assisters) st.assistsSinceDeath[a.i] += 1;
  return { bounty, shutdown, assist: Math.round(bounty * each) };
}

const OBJ_TYPE: Record<string, string> = { dragon: "DRAGON", elder: "ELDER_DRAGON", baron: "BARON_NASHOR", herald: "RIFTHERALD", grubs: "HORDE" };
const TURRET_TYPE = ["", "OUTER_TURRET", "INNER_TURRET", "BASE_TURRET"];

/** Objective bounties: after ~14 min the team behind in gold sometimes gets extra gold for a tower or an epic
 *  monster. How often grows with the deficit, as in the real games (none under 1k behind, all at 9k+). */
function objectiveBounties(e: Engine, st: EState) {
  const O = st.items.bounty.objective;
  const evs = e.events;
  for (; st.evSeen < evs.length; st.evSeen++) {
    const ev = evs[st.evSeen];
    if (ev.t < O.activeFrom) continue;
    let type = OBJ_TYPE[ev.type];
    if (ev.type === "turret" || ev.type === "first_turret") {
      const t = e.turrets.find((x) => !x.alive && x.pos.x === ev.x && x.pos.y === ev.y);
      type = t ? (t.lane === "nexus" ? "NEXUS_TURRET" : TURRET_TYPE[t.tier] ?? "") : "";
    }
    const def = type ? O.byType[type] : undefined;
    if (!def?.mode) continue;
    const deficit = teamGold(e, 1 - ev.side) - teamGold(e, ev.side);
    const row = [...O.byDeficit].reverse().find((r) => deficit >= r[0]);
    const p = row ? row[2] : 0;
    if (p <= 0 || !e.rng.chance(p)) continue;
    const team = e.units.filter((u) => u.side === ev.side);
    for (const u of team) u.gold += def.mode / team.length;
    e.event("info", ev.side, `오브젝트 현상금: ${e.names[ev.side]} +${def.mode}골드`, false);
    st.evSeen++; // past this objective; the "info" line just added is skipped when the loop reaches it
    break; // one payout per step; the rest are checked next step
  }
}

/** Shopping: a living unit standing in its fountain spends everything it has earned. */
export function tick(e: Engine) {
  const st = states.get(e);
  if (!st) return;
  if (ITEM_TUNE.objectiveBounty) objectiveBounties(e, st);
  for (const u of e.units) {
    const s = st.u[u.i];
    const f = FOUNTAIN[u.side];
    const home = u.alive && (u.x - f.x) ** 2 + (u.y - f.y) ** 2 <= 1300 * 1300;
    const arrived = home && !s.inBase;
    s.inBase = home;
    if (!home || u.gold - s.shopGold < 1) continue;
    const ratio = u.hp / Math.max(1, u.maxHp);
    // one visit per arrival (recall or respawn); the few gold earned while still standing there are spent too
    if (arrived) s.shops.push({ t: e.t, gold: u.gold - s.shopGold });
    else if (s.shops.length) s.shops[s.shops.length - 1].gold += u.gold - s.shopGold;
    s.shopGold = u.gold;
    const budget = (s.shopGold - 500) * ROLE_GOLD_SCALE[u.role];
    while (s.owned < s.path.length && s.cum[s.owned + 1] <= budget) s.owned++;
    u.maxHp = e.maxHp(u);
    u.hp = Math.min(u.maxHp, u.maxHp * ratio);
  }
}

/** Item strength on the old (gold - 500) / 3000 scale; with a channel, weighted by where the build's stats go. */
export function itemPower(e: Engine, u: Unit, ch?: Channel): number {
  const st = states.get(e);
  if (!st) return Math.max(0, u.gold - 500) / 3000;
  const s = st.u[u.i];
  // purchases on the real gold scale, strength back on the engine's
  const scale = ROLE_GOLD_SCALE[u.role];
  const budget = Math.max(0, s.shopGold - 500) * scale;
  const done = s.cum[s.owned];
  const full = s.owned >= s.path.length;
  const rest = budget - done;
  const base = (done * ITEM_TUNE.finished + rest * (full ? ITEM_TUNE.beyond : ITEM_TUNE.parts)) / 3000 / scale;
  return ch ? base * s.w[ch] : base;
}

/**
 * Channel weights of a build: its first four path items' stat shares against the class average on the same basis,
 * additive (1 + 1.5 x share difference, 0.5..1.6) so the class's games-weighted mean stays at 1. A ratio of shares
 * swung hard on channels a class barely buys (marksman health came out at 0.36).
 */
function channelWeights(items: ItemData, path: number[], cls: Record<Channel, number>): Record<Channel, number> {
  const g = sumGold(items, path.slice(0, 4));
  if (g.aa + g.sp + g.hp <= 0) return { aa: 1, sp: 1, hp: 1 };
  const sh = shares(g);
  const w = (ch: Channel) => Math.max(0.5, Math.min(1.6, 1 + 1.5 * (sh[ch] - cls[ch])));
  return { aa: w("aa"), sp: w("sp"), hp: w("hp") };
}

/** Keystone timing and the statistical edge of the chosen build/keystone, as a multiplier on one channel. */
export function mul(e: Engine, u: Unit, ch: Channel): number {
  const st = states.get(e);
  if (!st) return 1;
  const s = st.u[u.i];
  const m = e.t / 60;
  const prof = s.keystone ? KS_PROFILE[s.keystone]?.[ch] : undefined;
  const ks = prof ? prof[m < 14 ? 0 : m <= 28 ? 1 : 2] : 0;
  const edge = ch === "hp" ? 0 : (s.ksEdge + s.buildEdge) * EDGE_TO_POWER;
  return 1 + ks + edge;
}

/** Only the statistical edge of the chosen build/keystone (no keystone timing), for the real-stats fight path where
 *  keystones and items act through procs.ts / stats.ts instead (agreed with the combat-stats session). */
export function edgeMul(e: Engine, u: Unit, ch: Channel): number {
  const s = states.get(e)?.u[u.i];
  return !s || ch === "hp" ? 1 : 1 + (s.ksEdge + s.buildEdge) * EDGE_TO_POWER;
}

/** What the HUD shows: finished items in purchase order, the keystone and the chosen options. */
/**
 * Gold earned since the last visit at which real LCK players go back to buy (median over shop visits in the 502 games,
 * real-gold scale): carries about 850 (bot 1050: their items cost more), supports 415 (wards, the support item).
 */
export const SHOP_AT: Record<Role, number> = { Top: 850, Jungle: 850, Mid: 825, Bot: 1050, Support: 415 };

/**
 * How much a unit wants to go home and buy, 0..1, for the recall decision (macro.ts wantRecall): 1 when the gold in
 * its pocket finishes its next item, otherwise rising from 70% to 130% of the real players' usual amount (SHOP_AT).
 * Null without items.json (the caller keeps its own rule).
 */
export function shopUrge(e: Engine, u: Unit): number | null {
  const st = states.get(e);
  if (!st) return null;
  const s = st.u[u.i];
  const scale = ROLE_GOLD_SCALE[u.role];
  const pocket = (u.gold - s.shopGold) * scale;
  if (s.owned < s.path.length && (u.gold - 500) * scale >= s.cum[s.owned + 1] && pocket >= 300) return 1;
  const thr = SHOP_AT[u.role];
  return Math.max(0, Math.min(1, (pocket - thr * ITEM_TUNE.urgeLo) / (thr * (ITEM_TUNE.urgeHi - ITEM_TUNE.urgeLo))));
}

/** Chance per engine step to start a recall at a given shopUrge (both recall decisions use it). */
export function recallChance(urge: number): number {
  return ITEM_TUNE.recallBase + urge * ITEM_TUNE.recallSlope;
}

/**
 * The item a unit is building toward and the gold already spent on its components (real-gold scale, as bought at the
 * last shop visit): `next` is the next path item, null once the path is complete (then `spent` is the gold bought
 * past the full build). For the real-stats fight path (stats.ts adds the next item's stats in proportion).
 * Starting items are not modelled here: the first 500 gold (start gold) never enters the budget.
 */
export function pending(e: Engine, u: Unit): { next: number | null; spent: number } | null {
  const st = states.get(e);
  if (!st) return null;
  const s = st.u[u.i];
  const budget = Math.max(0, s.shopGold - 500) * ROLE_GOLD_SCALE[u.role];
  const spent = Math.max(0, budget - s.cum[s.owned]);
  return { next: s.owned < s.path.length ? s.path[s.owned] : null, spent };
}

/**
 * Components bought toward an item with `gold` (real-gold scale): its recipe parts in Data Dragon order while the
 * gold covers each one's full cost; the first part it cannot afford is broken into its own parts, as far as the gold
 * goes. (Real players also buy cheap parts first; the order is close enough for the HUD.)
 */
export function partsBought(data: ItemData, itemId: number, gold: number): number[] {
  const from = data.items[String(itemId)]?.from ?? data.parts?.[String(itemId)]?.from ?? [];
  const cost = (id: number) => data.parts?.[String(id)]?.cost ?? data.items[String(id)]?.cost ?? Infinity;
  const out: number[] = [];
  let left = gold;
  for (const c of from) {
    if (left >= cost(c)) {
      out.push(c);
      left -= cost(c);
      continue;
    }
    out.push(...partsBought(data, c, left));
    break;
  }
  return out;
}

/** The next item and the components of it the unit has already bought (shown in the HUD next to finished items). */
export function building(e: Engine, u: Unit): { next: number | null; parts: number[] } | null {
  const st = states.get(e);
  const p = pending(e, u);
  if (!st || !p || p.next === null) return p ? { next: null, parts: [] } : null;
  return { next: p.next, parts: partsBought(st.items, p.next, p.spent) };
}

/** Name and cost of any item id (finished item or component), for tooltips. */
export function itemName(data: ItemData, id: number): string {
  return data.items[String(id)]?.name ?? data.parts?.[String(id)]?.name ?? String(id);
}

/** Shop visits of a unit so far (scripts/items-check.ts compares them with the real games). */
export function shopHistory(e: Engine, u: Unit): { t: number; gold: number }[] {
  return states.get(e)?.u[u.i].shops ?? [];
}

export function unitItems(e: Engine, u: Unit): { items: number[]; keystone: number | null; data: ItemData } | null {
  const st = states.get(e);
  if (!st) return null;
  const s = st.u[u.i];
  return { items: s.path.slice(0, s.owned), keystone: s.keystone, data: st.items };
}

/** Team-power bonus (quick.ts scale) for AI games: the default (most played) build and keystone of each champion. */
export function defaultEdgePower(items: ItemData | null | undefined, champ: string, role: Role): number {
  if (!items) return 0;
  const ci = champItems(items, champ, role);
  if (!ci) return 0;
  const b = ci.builds[0], k = ci.keystones[0];
  const edge = (b ? optionEdge(ci, b.n, b.w) : 0) + (k ? optionEdge(ci, k.n, k.w) : 0);
  // a win-rate edge e of one player's option is a team win-rate edge e: logit on the POWER_SCALE power scale
  return POWER_SCALE * Math.log((0.5 + edge) / (0.5 - edge));
}
