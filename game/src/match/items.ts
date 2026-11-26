// Items, runes (keystones) and kill bounties, built from 502 real LCK 2026 games (public/data/items.json,
// scripts/build_items.py). Owner: main game session. Engine hooks (engine.ts): itemPower(u, channel), the item/
// keystone multipliers in aaDps / spellDmg / maxHp, tick() once per step, killGold() in kill().
//
// How items change the fight numbers
// - Gold only turns into strength when it is spent: a unit "shops" whenever it stands in its fountain (recall or
//   respawn). Bought gold follows the champion's real LCK purchase path; finished items count 1.06 per gold,
//   components of the next item 0.75, gold past the full build 0.5. Before items.json existed the engine counted all
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

export interface ItemStats { ad?: number; ap?: number; hp?: number; armor?: number; mr?: number; as?: number; crit?: number; haste?: number; leth?: number; mpen?: number; ms?: number }
export interface ItemDef { name: string; cost: number; kind: "legendary" | "boots" | "support"; stats: ItemStats; n: number; w: number; removed?: boolean; iconVer?: string }
export interface KeystoneDef { name: string; tree: number; treeName: string; icon: string; n: number; w: number }
export interface BuildOpt { core: number[]; boots?: number; n: number; w: number }
export interface KeystoneOpt { id: number; sub: number; n: number; w: number }
export interface ChampItems { n: number; w: number; builds: BuildOpt[]; path: number[]; keystones: KeystoneOpt[]; spike?: number[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BountyData = Record<string, any>;
export interface ItemData {
  version: string;
  games: number;
  patches: string[];
  items: Record<string, ItemDef>;
  keystones: Record<string, KeystoneDef>;
  trees: Record<string, { name: string; icon: string }>;
  champs: Record<string, ChampItems>;
  roleDefaults: Partial<Record<Role, ChampItems>>;
  bounty: BountyData;
}

/** The coach's choice for one player: index into the champion's builds / keystones (0 = most played in LCK). */
export interface Loadout { build: number; keystone: number }
export type SideLoadout = Partial<Record<Role, Loadout>>;

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
export function champItems(data: ItemData, champ: string, role: Role): ChampItems | null {
  return data.champs[champ] ?? data.roleDefaults[role] ?? null;
}

/** Win-rate edge of an option over the champion's own record, shrunk toward it and capped. */
export function optionEdge(ci: ChampItems, n: number, w: number): number {
  const base = ci.n ? ci.w / ci.n : 0.5;
  const shrunk = (w + EDGE_PRIOR * base) / (n + EDGE_PRIOR);
  return Math.max(-EDGE_CAP, Math.min(EDGE_CAP, shrunk - base));
}

/** Purchase order for a build: its core first, the rest of the champion's usual path after, boots and the support
 *  item at the position they usually take. */
export function buildPath(data: ItemData, ci: ChampItems, buildIdx: number): number[] {
  const b = ci.builds[buildIdx] ?? ci.builds[0];
  const special = (id: number) => data.items[String(id)]?.kind === "boots" || data.items[String(id)]?.kind === "support";
  const rest = ci.path.filter((id) => !special(id) && !(b?.core ?? []).includes(id));
  const main = [...(b?.core ?? []), ...rest].slice(0, 5);
  const out = [...main];
  // put boots / support item back where the usual path has them (counted in finished non-special items before them)
  const specials = ci.path.filter(special);
  if (b?.boots && !specials.includes(b.boots)) {
    const old = specials.findIndex((id) => data.items[String(id)]?.kind === "boots");
    if (old >= 0) specials[old] = b.boots;
    else specials.push(b.boots);
  }
  for (const sp of specials) {
    const at = ci.path.indexOf(sp);
    const before = at < 0 ? 1 : ci.path.slice(0, at).filter((id) => !special(id)).length;
    out.splice(Math.min(out.length, before + out.filter(special).length), 0, sp);
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
  chCum: Record<Channel, number>[]; // cumulative channel gold of the first k path items
  owned: number;
  shopGold: number;
  keystone: number | null;
  ksEdge: number;
  buildEdge: number;
  build: number;
  ksIdx: number;
  cls: Record<Channel, number>;
}
interface EState { items: ItemData; u: UState[] }
const states = new WeakMap<Engine, EState>();

export function init(e: Engine, loadouts?: [SideLoadout | undefined, SideLoadout | undefined]) {
  const items = (e.data as GameData & { items?: ItemData | null }).items;
  if (!items) return;
  const us: UState[] = e.units.map((u) => {
    const ci = champItems(items, u.champ.id, u.role);
    const lo = loadouts?.[u.side]?.[u.role] ?? { build: 0, keystone: 0 };
    const build = ci && ci.builds[lo.build] ? lo.build : 0;
    const ksIdx = ci && ci.keystones[lo.keystone] ? lo.keystone : 0;
    const path = ci ? buildPath(items, ci, build) : [];
    const cum = [0];
    const chCum = [{ aa: 0, sp: 0, hp: 0 }];
    for (const id of path) {
      const it = items.items[String(id)];
      cum.push(cum[cum.length - 1] + (it?.cost ?? 3000));
      const g = channelGold(it), p = chCum[chCum.length - 1];
      chCum.push({ aa: p.aa + g.aa, sp: p.sp + g.sp, hp: p.hp + g.hp });
    }
    const b = ci?.builds[build], k = ci?.keystones[ksIdx];
    return {
      ci, path, cum, chCum, owned: 0, shopGold: u.gold, build, ksIdx,
      keystone: k?.id ?? null,
      ksEdge: ci && k ? optionEdge(ci, k.n, k.w) : 0,
      buildEdge: ci && b ? optionEdge(ci, b.n, b.w) : 0,
      cls: classShares(e.data, items, u.champ),
    };
  });
  states.set(e, { items, u: us });
}

/** Shopping: a living unit standing in its fountain spends everything it has earned. */
export function tick(e: Engine) {
  const st = states.get(e);
  if (!st) return;
  for (const u of e.units) {
    if (!u.alive) continue;
    const s = st.u[u.i];
    if (u.gold - s.shopGold < 1) continue;
    const f = FOUNTAIN[u.side];
    if ((u.x - f.x) ** 2 + (u.y - f.y) ** 2 > 1300 * 1300) continue;
    const ratio = u.hp / Math.max(1, u.maxHp);
    s.shopGold = u.gold;
    const budget = s.shopGold - 500;
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
  const budget = Math.max(0, s.shopGold - 500);
  const done = s.cum[s.owned];
  const full = s.owned >= s.path.length;
  const rest = budget - done;
  const base = (done * 1.06 + rest * (full ? 0.5 : 0.75)) / 3000;
  if (!ch || !s.path.length) return base;
  // channel shares of what is owned (plus the share of the next item that the spare gold is going into)
  const have = s.chCum[s.owned];
  const nextFrac = full ? 0 : Math.min(1, rest / Math.max(1, s.cum[s.owned + 1] - done));
  const next = full ? { aa: 0, sp: 0, hp: 0 } : diff(s.chCum[s.owned + 1], have);
  const g = { aa: have.aa + next.aa * nextFrac, sp: have.sp + next.sp * nextFrac, hp: have.hp + next.hp * nextFrac };
  const sh = g.aa + g.sp + g.hp > 0 ? shares(g) : shares(s.chCum[Math.min(1, s.path.length)]);
  const w = (sh[ch] + 0.05) / (s.cls[ch] + 0.05);
  return base * Math.max(0.3, Math.min(2, w));
}
function diff(a: Record<Channel, number>, b: Record<Channel, number>): Record<Channel, number> {
  return { aa: a.aa - b.aa, sp: a.sp - b.sp, hp: a.hp - b.hp };
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

/** What the HUD shows: finished items in purchase order, the keystone and the chosen options. */
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
  // a win-rate edge e of one player's option is a team win-rate edge e: logit on the 4.5 power scale
  return 4.5 * Math.log((0.5 + edge) / (0.5 - edge));
}
