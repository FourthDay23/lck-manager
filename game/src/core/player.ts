import type { AttrKey, Attrs, PlayerData, Role } from "../data/types";
import { ATTR_KEYS } from "../data/types";
import { clamp, hashUnit, Rng } from "./rng";
import type { GameState, Player, Team } from "./types";

/** How much each attribute counts toward a role's overall. */
export const ROLE_WEIGHT: Record<Role, Attrs> = {
  Top: { laning: 0.25, teamfight: 0.2, macro: 0.13, mechanics: 0.22, consistency: 0.1, pool: 0.1 },
  Jungle: { laning: 0.08, teamfight: 0.2, macro: 0.32, mechanics: 0.15, consistency: 0.15, pool: 0.1 },
  Mid: { laning: 0.22, teamfight: 0.2, macro: 0.15, mechanics: 0.23, consistency: 0.1, pool: 0.1 },
  Bot: { laning: 0.22, teamfight: 0.28, macro: 0.08, mechanics: 0.24, consistency: 0.1, pool: 0.08 },
  Support: { laning: 0.15, teamfight: 0.25, macro: 0.3, mechanics: 0.1, consistency: 0.1, pool: 0.1 },
};

export function formulaOvr(role: Role, a: Attrs): number {
  const w = ROLE_WEIGHT[role];
  let s = 0;
  for (const k of ATTR_KEYS) s += a[k] * w[k];
  return s;
}

export function ovr(p: Player): number {
  return clamp(Math.round(formulaOvr(p.role, p.attrs) + p.ovrOffset), 25, 99);
}

export function age(p: Player, season: number): number {
  return season - p.birthYear;
}

/** Hidden ceiling, fixed per player by hash so it never rerolls. */
export function potentialFor(id: string, ovrNow: number, ageNow: number): number {
  const u = hashUnit(id + ":pot");
  let gap: number;
  if (ageNow <= 18) gap = 10 + u * 9;
  else if (ageNow <= 20) gap = 6 + u * 7;
  else if (ageNow <= 22) gap = 3 + u * 6;
  else if (ageNow <= 24) gap = 1 + u * 4;
  else gap = u * 2;
  return clamp(Math.round(ovrNow + gap), ovrNow, 99);
}

export function personaFor(id: string): Player["persona"] {
  return {
    loyalty: hashUnit(id + ":loy"),
    ambition: hashUnit(id + ":amb"),
    greed: hashUnit(id + ":grd"),
    temper: hashUnit(id + ":tmp"),
  };
}

const EXEMPT = new Set(["Faker", "Zeus", "Kanavi", "Chovy", "Ruler", "Keria"]);

export function playerFromData(d: PlayerData, season: number): Player {
  const birthYear = d.birth ? Number(d.birth.slice(0, 4)) : season - 20 - Math.floor(hashUnit(d.id + ":age") * 6);
  const attrs = { ...d.attrs };
  for (const k of ATTR_KEYS) attrs[k] = clamp(Math.round(attrs[k] ?? 60), 20, 99);
  const offset = d.ovr - formulaOvr(d.role, attrs);
  const mastery: Record<string, number> = {};
  for (const c of d.champs ?? []) mastery[c.c] = clamp(Math.round(48 + Math.sqrt(c.g) * 11 + (c.w / Math.max(1, c.g) - 0.5) * 16), 40, 98);
  const base: Player = {
    id: d.id,
    name: d.name,
    realName: d.realName,
    nat: d.nat || "KR",
    birthYear,
    role: d.role,
    tier: d.tier,
    origin: "real",
    team: null,
    contract: null,
    attrs,
    ovrOffset: Math.round(offset * 10) / 10,
    pot: 0,
    fame: clamp(Math.round(d.fame ?? 10), 0, 100),
    morale: 70,
    fatigue: 10,
    form: 0,
    mastery,
    persona: personaFor(d.id),
    unpaid: 0,
    train: "champ",
    xp: {},
    season: emptyLine(),
    career: { ...emptyLine(), titles: [] },
    history: [],
    lastTeamName: d.lastTeam,
    exempt: EXEMPT.has(d.id),
    stats: { wr: d.stats?.wr, kda: d.stats?.kda, kp: d.stats?.kp, dpm: d.stats?.dpm, cspm: d.stats?.cspm },
  };
  base.pot = potentialFor(d.id, ovr(base), season - birthYear);
  const first = d.champs?.[0]?.c;
  if (first) base.trainChamp = first;
  return base;
}

export function emptyLine() {
  return { g: 0, w: 0, k: 0, d: 0, a: 0, cs: 0, mvp: 0 };
}

/** Annual salary the player expects, in 만원. LCK minimum is 6,000만. */
export function salaryAsk(p: Player, season: number): number {
  const o = ovr(p);
  const x = Math.max(0, (o - 55) / 40);
  const base = 6000 + Math.pow(x, 3) * 60000;
  const fameMul = 1 + p.fame / 170;
  const greed = 0.9 + p.persona.greed * 0.25;
  const a = age(p, season);
  const ageMul = a >= 29 ? 0.85 : 1;
  const formMul = 1 + clamp(p.form, -10, 10) / 60;
  return Math.max(6000, Math.round((base * fameMul * greed * ageMul * formMul) / 100) * 100);
}

/** Transfer value (fee a club would want for him), in 만원. */
export function marketValue(p: Player, season: number): number {
  const o = ovr(p);
  const x = Math.max(0, (o - 55) / 40);
  let v = 1000 + Math.pow(x, 3) * 150000;
  v *= 1 + p.fame / 200;
  const a = age(p, season);
  if (a <= 21) v *= 1.3;
  else if (a <= 23) v *= 1.12;
  else if (a >= 29) v *= 0.6;
  else if (a >= 27) v *= 0.8;
  if (p.contract) {
    const left = p.contract.until - season + 1;
    v *= left >= 3 ? 1.15 : left === 2 ? 1 : 0.75;
  } else v = 0;
  return Math.round(v / 100) * 100;
}

/** Clubs players rank lower than their budget alone would suggest (smaller fan base, little history of winning). */
export const LOW_PREFERENCE = new Set(["BFX", "NS", "BRO", "DNS"]);

export function teamAppeal(t: Team, s: GameState): number {
  // 0..1, how attractive the club is to players
  const titles = t.titles.lck * 0.6 + t.titles.worlds * 1.5 + t.titles.msi;
  const low = LOW_PREFERENCE.has(t.id) ? 0.14 : 0;
  return clamp(0.15 + t.fame / 250 + t.wealth * 0.04 + Math.min(0.18, titles * 0.01) - low, 0.05, 1);
}

/**
 * Difficulty of running a club, shown when picking a team: budget (wealth), how much players want to join
 * (LOW_PREFERENCE), and a little for winning history.
 */
export function teamDifficulty(t: { id: string; wealth: number; titles: { lck: number } }): { level: 1 | 2 | 3 | 4; label: string; why: string } {
  const low = LOW_PREFERENCE.has(t.id);
  const score = t.wealth + (low ? -1.5 : 0) + Math.min(1, t.titles.lck / 5) * 0.5;
  const why = `자금력 ${t.wealth}/5 · 선수 선호도 ${low ? "낮음" : t.wealth >= 5 ? "높음" : "보통"}`;
  if (score >= 5) return { level: 1, label: "쉬움", why };
  if (score >= 3.8) return { level: 2, label: "보통", why };
  if (score >= 2.6) return { level: 3, label: "어려움", why };
  return { level: 4, label: "매우 어려움", why };
}

export function appealWord(a: number): string {
  return a >= 0.75 ? "매우 높음" : a >= 0.55 ? "높음" : a >= 0.4 ? "보통" : a >= 0.25 ? "낮음" : "매우 낮음";
}

export function contractYearsLeft(p: Player, season: number): number {
  return p.contract ? p.contract.until - season + 1 : 0;
}

const HANDLES = [
  "Raon", "Haneul", "Mirae", "Dawn", "Lumen", "Pyro", "Vexa", "Sorin", "Kairo", "Nabi", "Iden", "Yeon", "Taro", "Sol",
  "Ember", "Glint", "Haze", "Juno", "Kite", "Lark", "Moru", "Nova", "Onyx", "Pike", "Quill", "Rune", "Sable", "Tide",
  "Umbra", "Vale", "Wisp", "Yuri", "Zest", "Aster", "Bram", "Ciel", "Dyne", "Eon", "Fable", "Gale", "Hollow", "Ivo",
  "Jinu", "Koda", "Lien", "Mok", "Nuri", "Orin", "Pado", "Rimi", "Seol", "Toki", "Uri", "Vin", "Woo", "Yul", "Zeno",
  "Arin", "Bada", "Chan", "Doha", "Eun", "Garam", "Hyang", "Inho", "Jae", "Kyul", "Maru", "Narae", "Ohn", "Pureun",
];
const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황", "안", "송", "류", "홍"];
const GIVEN = ["민", "준", "서", "현", "우", "지", "도", "윤", "하", "건", "유", "진", "성", "재", "태", "승", "원", "혁", "수", "호", "영", "찬"];

/** Fictional prospect. Scandal events only ever target these. */
export function makeRookie(s: GameState, rng: Rng, role: Role): Player {
  s.genCount += 1;
  let handle = rng.pick(HANDLES);
  const taken = new Set(Object.values(s.players).map((p) => p.name));
  for (let i = 0; taken.has(handle) && i < 20; i++) handle = rng.pick(HANDLES) + rng.pick(["", "X", "K", "J"]) + (i > 5 ? i : "");
  if (taken.has(handle)) handle = `${handle}${s.genCount}`;
  const id = `gen:${s.genCount}:${handle}`;
  const a = rng.int(17, 19);
  const base = rng.range(48, 64);
  const attrs = {} as Attrs;
  for (const k of ATTR_KEYS) attrs[k] = clamp(Math.round(base + rng.normal(0, 5)), 30, 80);
  const p: Player = {
    id, name: handle,
    realName: rng.pick(SURNAMES) + rng.pick(GIVEN) + rng.pick(GIVEN),
    nat: "KR", birthYear: s.season - a, role, tier: 2, origin: "gen", team: null, contract: null,
    attrs, ovrOffset: 0, pot: 0, fame: rng.int(0, 6), morale: 70, fatigue: 0, form: 0, mastery: {},
    persona: personaFor(id), unpaid: 0, train: "champ", xp: {}, season: emptyLine(),
    career: { ...emptyLine(), titles: [] }, history: [`${s.season}: 신인 (가상 선수)`], lastTeamName: null,
  };
  p.pot = clamp(Math.round(ovr(p) + 8 + hashUnit(id) * 22), 50, 97);
  return p;
}

export function addXp(p: Player, key: AttrKey, amount: number): boolean {
  p.xp[key] = (p.xp[key] ?? 0) + amount;
  let up = false;
  while ((p.xp[key] ?? 0) >= 100) {
    p.xp[key]! -= 100;
    if (ovr(p) < p.pot && p.attrs[key] < 99) {
      p.attrs[key] += 1;
      up = true;
    }
  }
  return up;
}

export function bestRoleFit(p: Player): Role {
  return p.role;
}

/** One-word trait shown on cards, from personality. */
export function traitWord(p: Player): string {
  const { loyalty, ambition, greed, temper } = p.persona;
  const m = Math.max(loyalty, ambition, greed, temper);
  if (m < 0.6) return "무난함";
  if (m === loyalty) return "의리파";
  if (m === ambition) return "우승 욕심";
  if (m === greed) return "돈 중시";
  return "다혈질";
}

export function lineupOvr(s: GameState, t: Team): number {
  const ids = Object.values(t.lineup).filter(Boolean) as string[];
  if (!ids.length) return 0;
  return ids.reduce((acc, id) => acc + ovr(s.players[id]), 0) / 5;
}

export function attrKeysSorted(p: Player): AttrKey[] {
  return [...ATTR_KEYS].sort((a, b) => p.attrs[b] - p.attrs[a]);
}
