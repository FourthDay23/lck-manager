// The game's own patch meta: a few times a season it rolls which champions are strong (S/A) or nerfed.
// Picking meta champions raises a player's rating in the match engine and in AI-vs-AI results.
import type { GameData } from "../data/load";
import type { ChampionData, Role } from "../data/types";
import { ROLES, ROLE_KO } from "../data/types";
import { addNews } from "./news";
import { Rng } from "./rng";
import { seasonDates } from "./schedule";
import type { GameState, MetaTier } from "./types";

/** Rating change per player for playing a champion of this tier (same scale as overall). */
export const META_BONUS: Record<MetaTier, number> = { S: 4, A: 2, N: -2.5 };
export const META_LABEL: Record<MetaTier, string> = { S: "S", A: "A", N: "너프" };

export function metaTier(s: GameState, champ: string): MetaTier | undefined {
  return s.meta?.tiers[champ];
}

export function metaBonus(s: GameState, champ: string | undefined | null): number {
  if (!champ) return 0;
  const t = s.meta?.tiers[champ];
  return t ? META_BONUS[t] : 0;
}

/** Average meta bonus of a five-champion pick list (team power scale). */
export function teamMetaBonus(s: GameState, champs: (string | undefined)[]): number {
  return champs.reduce((a, c) => a + metaBonus(s, c), 0) / 5;
}

/** Days on which a new patch lands: before each split and international event. */
export function patchDays(season: number): number[] {
  const d = seasonDates(season);
  return [d.cup - 9, d.reg - 9, d.msi - 9, d.reg2 - 9, d.worlds - 12];
}

export function patchDue(s: GameState): boolean {
  return patchDays(s.season).includes(s.day);
}

function candidates(data: GameData, role: Role): ChampionData[] {
  return data.champions.filter((c) => (c.roles[role] ?? 0) >= 0.35);
}

/** Roll a new patch. Popular pro picks are likelier to be strong, but any champion that fits a role can rise. */
export function rollPatch(s: GameState, data: GameData, rng: Rng) {
  const prev = s.meta;
  const n = prev && prev.patch.startsWith(`${s.season - 2000}.`) ? Number(prev.patch.split(".")[1]) + 1 : 1;
  const patch = `${s.season - 2000}.${n}`;
  const tiers: Record<string, MetaTier> = {};
  const taken = new Set<string>();
  const prevStrong = new Set(Object.entries(prev?.tiers ?? {}).filter(([, t]) => t === "S").map(([c]) => c));
  const pick = (pool: ChampionData[], count: number, weight: (c: ChampionData) => number): ChampionData[] => {
    const out: ChampionData[] = [];
    for (let i = 0; i < count; i++) {
      const left = pool.filter((c) => !taken.has(c.id));
      const c = rng.weighted(left, weight);
      if (!c) break;
      taken.add(c.id);
      out.push(c);
    }
    return out;
  };
  const w = (c: ChampionData) => (1 + Math.sqrt(c.pro.picks + c.pro.bans) / 3) * (prevStrong.has(c.id) ? 0.35 : 1) * (0.5 + rng.next());
  for (const r of ROLES) {
    for (const c of pick(candidates(data, r), 2, w)) tiers[c.id] = "S";
    for (const c of pick(candidates(data, r), 3, w)) tiers[c.id] = "A";
  }
  // nerfs: last patch's S tier is the likeliest target, plus a few other popular picks
  const nerfPool = data.champions.filter((c) => !taken.has(c.id) && (prevStrong.has(c.id) || c.pro.picks > 20));
  for (const c of pick(nerfPool, 7, (c) => (prevStrong.has(c.id) ? 4 : 1) * (1 + c.pro.picks / 60))) tiers[c.id] = "N";
  s.meta = {
    patch,
    since: s.day,
    tiers,
    history: [...(prev?.history ?? []), { patch, since: s.day, s: Object.keys(tiers).filter((c) => tiers[c] === "S"), nerf: Object.keys(tiers).filter((c) => tiers[c] === "N") }].slice(-12),
  };
  const names = (ids: string[]) => ids.map((id) => data.champ.get(id)?.name ?? id).join(", ");
  const sByRole = ROLES.map((r) => `${ROLE_KO[r]} ${names(Object.keys(tiers).filter((c) => tiers[c] === "S" && (data.champ.get(c)?.roles[r] ?? 0) >= 0.35).slice(0, 2))}`).join(" / ");
  addNews(s, {
    kind: "info",
    title: `[패치 ${patch}] 메타 리포트`,
    body: `S티어: ${sByRole}. 너프: ${names(Object.keys(tiers).filter((c) => tiers[c] === "N"))}.`,
  });
}
