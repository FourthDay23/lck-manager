// Tournament draft (20 steps), hard fearless across a series, AI picks/bans and coach suggestions.
import type { GameData } from "../data/load";
import type { ChampionData, Role, StyleKey } from "../data/types";
import { ROLES } from "../data/types";
import { ovr } from "../core/player";
import { headCoach, teamPower, POWER_SCALE, MOD_GAIN, aiEdge } from "../core/quick";
import { clamp, logistic, Rng } from "../core/rng";
import type { GameState, Player } from "../core/types";
import { metaBonus, metaTier, teamMetaBonus } from "../core/meta";
import type { SideLoadout } from "./items";
import { champItems, optionEdge } from "./items";

export type Side = "blue" | "red";
export type StepKind = "ban" | "pick";
export const DRAFT_ORDER: [Side, StepKind][] = [
  ["blue", "ban"], ["red", "ban"], ["blue", "ban"], ["red", "ban"], ["blue", "ban"], ["red", "ban"],
  ["blue", "pick"], ["red", "pick"], ["red", "pick"], ["blue", "pick"], ["blue", "pick"], ["red", "pick"],
  ["red", "ban"], ["blue", "ban"], ["red", "ban"], ["blue", "ban"],
  ["red", "pick"], ["blue", "pick"], ["blue", "pick"], ["red", "pick"],
];

export interface DraftState {
  blue: string; // team id
  red: string;
  step: number;
  bans: Record<Side, string[]>;
  picks: Record<Side, Partial<Record<Role, string>>>;
  fearless: Set<string>; // picked in earlier games of this series
  history: { side: Side; kind: StepKind; champ: string; role?: Role }[];
  /** builds / keystones the coach chose after the draft (missing = the champion's most played LCK option) */
  loadout?: Partial<Record<Side, SideLoadout>>;
}

export function newDraft(blue: string, red: string, fearless: Iterable<string>): DraftState {
  return { blue, red, step: 0, bans: { blue: [], red: [] }, picks: { blue: {}, red: {} }, fearless: new Set(fearless), history: [] };
}

export function currentStep(d: DraftState): [Side, StepKind] | null {
  return DRAFT_ORDER[d.step] ?? null;
}

export function unavailable(d: DraftState): Set<string> {
  const out = new Set(d.fearless);
  for (const s of ["blue", "red"] as Side[]) {
    for (const c of d.bans[s]) out.add(c);
    for (const c of Object.values(d.picks[s])) if (c) out.add(c);
  }
  return out;
}

export function openRoles(d: DraftState, side: Side): Role[] {
  return ROLES.filter((r) => !d.picks[side][r]);
}

export function applyStep(d: DraftState, champ: string, role?: Role) {
  const st = currentStep(d);
  if (!st) return;
  const [side, kind] = st;
  if (kind === "ban") d.bans[side].push(champ);
  else {
    const r = role ?? openRoles(d, side)[0];
    d.picks[side][r] = champ;
  }
  d.history.push({ side, kind, champ, role: kind === "pick" ? role : undefined });
  d.step++;
}

export function lineupOf(s: GameState, teamId: string): Partial<Record<Role, Player>> {
  const t = s.teams[teamId];
  const out: Partial<Record<Role, Player>> = {};
  for (const r of ROLES) if (t.lineup[r]) out[r] = s.players[t.lineup[r]!];
  return out;
}

export function mastery(p: Player | undefined, c: ChampionData): number {
  if (!p) return 40;
  const m = p.mastery[c.id];
  if (m !== undefined) return m;
  // never played it in the pros: guess from champion pool and how standard the champion is for the role
  return clamp(32 + p.attrs.pool * 0.3 + (c.roles[p.role] ?? 0) * 12, 30, 72);
}

function metaScore(c: ChampionData): number {
  return c.pro.presence * 30 + Math.min(10, c.pro.picks / 8);
}

/** How good champion c is for role r on this team right now (0..~100). */
export function pickValue(s: GameState, data: GameData, d: DraftState, side: Side, c: ChampionData, r: Role): number {
  const team = side === "blue" ? d.blue : d.red;
  const p = lineupOf(s, team)[r];
  const roleFit = c.roles[r] ?? 0;
  if (roleFit < 0.05) return -100;
  let v = mastery(p, c) * 0.55 + metaScore(c) * 0.4 + roleFit * 18 + metaBonus(s, c.id) * 5;
  // team composition needs
  const mine = Object.values(d.picks[side]).map((id) => data.champ.get(id!)).filter(Boolean) as ChampionData[];
  const ap = mine.filter((x) => x.damage === "AP").length;
  const ad = mine.filter((x) => x.damage === "AD").length;
  if (c.damage === "AP" && ap === 0 && mine.length >= 2) v += 6;
  if (c.damage === "AD" && ad === 0 && mine.length >= 2) v += 4;
  if (c.damage === "AP" && ap >= 3) v -= 8;
  if (c.damage === "AD" && ad >= 3) v -= 8;
  const engage = mine.reduce((a, x) => a + x.style.engage, 0);
  if (engage < 8 && mine.length >= 2) v += c.style.engage * 0.8;
  // lane matchup: early vs scaling, very rough
  const enemySide: Side = side === "blue" ? "red" : "blue";
  const foe = d.picks[enemySide][r] ? data.champ.get(d.picks[enemySide][r]!) : undefined;
  if (foe) v += (c.style.early - foe.style.early) * 0.6;
  return v;
}

export function bestPicks(s: GameState, data: GameData, d: DraftState, side: Side, n: number, rng: Rng | null, noise = 0) {
  const avail = unavailable(d);
  const roles = openRoles(d, side);
  const out: { champ: ChampionData; role: Role; score: number }[] = [];
  for (const c of data.champions) {
    if (avail.has(c.id)) continue;
    for (const r of roles) {
      const v = pickValue(s, data, d, side, c, r) + (rng && noise ? rng.range(-noise, noise) : 0);
      if (v > -50) out.push({ champ: c, role: r, score: v });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const uniq = out.filter((x) => (seen.has(x.champ.id) ? false : (seen.add(x.champ.id), true)));
  return uniq.slice(0, n);
}

/** Ban value: deny what the opponent's players are best on, plus raw meta strength. */
export function banValue(s: GameState, data: GameData, d: DraftState, side: Side, c: ChampionData): { v: number; why: string } {
  const enemy: Side = side === "blue" ? "red" : "blue";
  const lu = lineupOf(s, enemy === "blue" ? d.blue : d.red);
  let best = 0;
  let why = "";
  for (const r of openRoles(d, enemy)) {
    const p = lu[r];
    if (!p) continue;
    const m = p.mastery[c.id];
    if (m === undefined || (c.roles[r] ?? 0) < 0.1) continue;
    const v = (m - 50) * 0.9 * (0.5 + ovr(p) / 200);
    if (v > best) {
      best = v;
      why = `${p.name} 숙련 ${Math.round(m)}`;
    }
  }
  const meta = metaScore(c);
  const tier = metaTier(s, c.id);
  const patchV = tier === "S" ? 16 : tier === "A" ? 7 : tier === "N" ? -10 : 0;
  if (tier === "S" && patchV + meta * 0.5 > best) why = `패치 ${s.meta?.patch} S티어`;
  else if (meta * 0.9 > best) why = `프로 메타 (출현율 ${Math.round(c.pro.presence * 100)}%)`;
  return { v: best + meta * 0.5 + patchV, why };
}

export function bestBans(s: GameState, data: GameData, d: DraftState, side: Side, n: number, rng: Rng | null, noise = 0) {
  const avail = unavailable(d);
  return data.champions
    .filter((c) => !avail.has(c.id))
    .map((c) => {
      const b = banValue(s, data, d, side, c);
      return { champ: c, score: b.v + (rng && noise ? rng.range(-noise, noise) : 0), why: b.why };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

export function aiStep(s: GameState, data: GameData, d: DraftState, rng: Rng) {
  const st = currentStep(d);
  if (!st) return;
  const [side, kind] = st;
  const team = s.teams[side === "blue" ? d.blue : d.red];
  const hc = headCoach(s, team);
  const noise = hc ? clamp((100 - hc.attrs.draft) / 8, 1, 8) : 9;
  if (kind === "ban") {
    const b = bestBans(s, data, d, side, 3, rng, noise)[0];
    applyStep(d, b ? b.champ.id : data.champions[0].id);
  } else {
    const p = bestPicks(s, data, d, side, 3, rng, noise);
    const choice = p[0];
    if (choice) applyStep(d, choice.champ.id, choice.role);
    else applyStep(d, data.champions.find((c) => !unavailable(d).has(c.id))!.id, openRoles(d, side)[0]);
  }
}

/** Head coach suggestions: count and accuracy come from the coach's draft rating and the analysis room. */
export function coachSuggestions(s: GameState, data: GameData, d: DraftState, side: Side, rng: Rng) {
  const st = currentStep(d);
  if (!st) return { coach: null as string | null, items: [] as { champ: ChampionData; role?: Role; why: string }[] };
  const team = s.teams[side === "blue" ? d.blue : d.red];
  const hc = headCoach(s, team);
  const draft = hc?.attrs.draft ?? 35;
  const n = draft < 50 ? 2 : draft < 60 ? 3 : draft < 70 ? 4 : draft < 80 ? 5 : 6;
  const noise = clamp((100 - draft) / 6 - team.facilities.analysis * 0.8, 0.5, 12);
  if (st[1] === "ban") {
    return { coach: hc?.name ?? null, items: bestBans(s, data, d, side, n, rng, noise).map((x) => ({ champ: x.champ, role: undefined as Role | undefined, why: x.why })) };
  }
  const lu = lineupOf(s, team.id);
  return {
    coach: hc?.name ?? null,
    items: bestPicks(s, data, d, side, n, rng, noise).map((x) => {
      const p = lu[x.role];
      const m = p ? Math.round(mastery(p, x.champ)) : 0;
      const tier = metaTier(s, x.champ.id);
      const tierTxt = tier === "S" ? " · S티어" : tier === "A" ? " · A티어" : tier === "N" ? " · 너프됨" : "";
      const why = (p && p.mastery[x.champ.id] ? `${p.name} 숙련 ${m}` : `${x.role} 프로 메타 (${Math.round(x.champ.pro.presence * 100)}%)`) + tierTxt;
      return { champ: x.champ, role: x.role, why };
    }),
  };
}

export const COMP_KEYS: StyleKey[] = ["early", "scaling", "engage", "peel", "poke", "burst"];

export function compProfile(data: GameData, picks: Partial<Record<Role, string>>) {
  const cs = Object.values(picks).map((id) => data.champ.get(id!)).filter(Boolean) as ChampionData[];
  const prof = {} as Record<StyleKey, number>;
  for (const k of COMP_KEYS) prof[k] = cs.reduce((a, c) => a + (c.style[k] ?? 0), 0) / Math.max(1, cs.length);
  const ap = cs.filter((c) => c.damage === "AP").length;
  const ad = cs.filter((c) => c.damage === "AD").length;
  return { prof, ap, ad, n: cs.length };
}

/** Composition modifier on team rating (same scale as overall). */
export function compBonus(data: GameData, picks: Partial<Record<Role, string>>): number {
  const { prof, ap, ad, n } = compProfile(data, picks);
  if (n < 5) return 0;
  let b = 0;
  if (ap === 0 || ad === 0) b -= 2;
  if (prof.engage < 3.5) b -= 1.2;
  if (prof.peel < 2.5) b -= 0.6;
  b += (prof.engage + prof.burst + prof.scaling - 15) / 10;
  return clamp(b, -3, 2);
}

export function masteryBonus(s: GameState, data: GameData, teamId: string, picks: Partial<Record<Role, string>>): number {
  const lu = lineupOf(s, teamId);
  let sum = 0;
  for (const r of ROLES) {
    const c = picks[r] ? data.champ.get(picks[r]!) : undefined;
    if (!c) continue;
    sum += (mastery(lu[r], c) - 62) / 9;
  }
  return clamp(sum / 5, -3, 3);
}

/** Win probability shown after the draft. */
export function draftWinProb(s: GameState, data: GameData, d: DraftState): number {
  // composition and meta are manager-side modifiers (MOD_GAIN, see core/quick.ts); mastery is player strength
  const pb = teamPower(s, d.blue) + (compBonus(data, d.picks.blue) + teamMetaBonus(s, Object.values(d.picks.blue))) * MOD_GAIN + masteryBonus(s, data, d.blue, d.picks.blue);
  const pr = teamPower(s, d.red) + (compBonus(data, d.picks.red) + teamMetaBonus(s, Object.values(d.picks.red))) * MOD_GAIN + masteryBonus(s, data, d.red, d.picks.red);
  const lo = loadoutEdgePower(data, d, "blue") - loadoutEdgePower(data, d, "red");
  // blue side: +0.22 logit at equal strength (LCK 2025-26; the engine's swapped-side games land close to it)
  return logistic((pb - pr + aiEdge(s, d.blue, d.red) + lo) / POWER_SCALE + 0.22);
}

/** Win-rate edge of the chosen builds / keystones (LCK statistics, items.ts) on the team power scale. */
export function loadoutEdgePower(data: GameData, d: DraftState, side: Side): number {
  if (!data.items) return 0;
  let edge = 0;
  for (const r of ROLES) {
    const c = d.picks[side][r];
    if (!c) continue;
    const ci = champItems(data.items, c, r);
    if (!ci) continue;
    const lo = d.loadout?.[side]?.[r];
    const b = ci.builds[lo?.build ?? 0] ?? ci.builds[0], k = ci.keystones[lo?.keystone ?? 0] ?? ci.keystones[0];
    edge += (b ? optionEdge(ci, b.n, b.w) : 0) + (k ? optionEdge(ci, k.n, k.w) : 0);
  }
  edge = Math.max(-0.2, Math.min(0.2, edge));
  return POWER_SCALE * Math.log((0.5 + edge) / (0.5 - edge));
}

/** Auto-complete the whole draft for both sides (used for "결과만 보기" and AI vs AI). */
export function autoDraft(s: GameState, data: GameData, d: DraftState, rng: Rng) {
  while (currentStep(d)) aiStep(s, data, d, rng);
}
