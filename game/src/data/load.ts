import type {
  ChampionData, HeatmapData, IntlTeamData, MetaData, PlayerData, StaffData, TeamData, Role,
} from "./types";
import { ROLES } from "./types";
import type { ItemData } from "../match/items";
import type { MatchupData } from "../match/matchup";

export interface GameData {
  source: "data" | "data-sample";
  ddVersion: string;
  champions: ChampionData[];
  champ: Map<string, ChampionData>;
  players: PlayerData[];
  staff: StaffData[];
  teams: TeamData[];
  intl: IntlTeamData[];
  meta: MetaData;
  heatmap: HeatmapData | null;
  /** real LCK item / keystone / bounty statistics (items.json); null runs the engine's older gold-only model */
  items: ItemData | null;
  /** champion matchups and composition counters measured on LCK games (matchups.json); null counts every pair even */
  matchups: MatchupData | null;
}

async function getJson<T>(dir: string, file: string): Promise<T | null> {
  try {
    const r = await fetch(`${dir}/${file}`, { cache: "no-cache" });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (type.includes("text/html")) return null; // vite answers unknown paths with index.html
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Timers used when meta.json is missing a value (patch 26.x values, seconds). */
export const DEFAULT_META: MetaData = {
  objectives: {
    dragon: { firstSpawn: 300, respawn: 300 },
    grubs: { firstSpawn: 480, respawn: null },
    herald: { firstSpawn: 900, respawn: null },
    baron: { firstSpawn: 1200, respawn: 360 },
    elder: { firstSpawn: 0, respawn: 360 },
  },
  camps: {
    blue: { firstSpawn: 90, respawn: 300 },
    red: { firstSpawn: 90, respawn: 300 },
    gromp: { firstSpawn: 102, respawn: 135 },
    wolves: { firstSpawn: 90, respawn: 135 },
    raptors: { firstSpawn: 90, respawn: 135 },
    krugs: { firstSpawn: 102, respawn: 135 },
    scuttle: { firstSpawn: 210, respawn: 150 },
  },
  gameLength: { mean: 1900, p10: 1560, p90: 2280 },
};

const FALLBACK_INTL: [string, string, string, number, string, string][] = [
  ["BLG", "Bilibili Gaming", "LPL", 90, "#00a1e0", "#ffffff"],
  ["AL", "Anyone's Legend", "LPL", 88, "#c8102e", "#ffffff"],
  ["TES", "Top Esports", "LPL", 86, "#ff6a00", "#1a1a1a"],
  ["JDG", "JD Gaming", "LPL", 84, "#c8102e", "#1a1a1a"],
  ["G2", "G2 Esports", "LEC", 84, "#f2f2f2", "#1a1a1a"],
  ["FNC", "Fnatic", "LEC", 78, "#ff5900", "#1a1a1a"],
  ["MKOI", "Movistar KOI", "LEC", 77, "#1d1d6b", "#ffffff"],
  ["KC", "Karmine Corp", "LEC", 76, "#0d5fff", "#1a1a1a"],
  ["CFO", "CTBC Flying Oyster", "LCP", 78, "#0f6e5b", "#ffffff"],
  ["GAM", "GAM Esports", "LCP", 70, "#f5c400", "#1a1a1a"],
  ["FLY", "FlyQuest", "LTA", 76, "#1d6b38", "#ffffff"],
  ["100T", "100 Thieves", "LTA", 72, "#e4002b", "#1a1a1a"],
];

function fallbackIntl(): IntlTeamData[] {
  return FALLBACK_INTL.map(([id, name, region, strength, c1, c2]) => ({
    id, name, short: id, region, strength, colors: [c1, c2], logo: null,
    roster: ROLES.map((role: Role) => ({
      id: `${id}-${role}`, name: `${id} ${role}`, role, nat: region === "LPL" ? "CN" : "XX",
      ovr: strength,
      attrs: { laning: strength, teamfight: strength, macro: strength, mechanics: strength, consistency: strength, pool: strength },
      champs: [],
    })),
  }));
}

export async function loadData(): Promise<GameData> {
  let dir: "data" | "data-sample" = "data";
  let champs = await getJson<{ version: string; champions: ChampionData[] }>("data", "champions.json");
  let players = await getJson<{ players: PlayerData[] }>("data", "players.json");
  if (!champs || !players) {
    dir = "data-sample";
    champs = await getJson("data-sample", "champions.json");
    players = await getJson("data-sample", "players.json");
  }
  if (!champs || !players) throw new Error("public/data 폴더에 champions.json, players.json이 없습니다");
  const [staff, teams, intl, meta, heatmap, items, matchups] = await Promise.all([
    getJson<{ staff: StaffData[] }>(dir, "staff.json"),
    getJson<{ teams: TeamData[] }>(dir, "teams.json"),
    getJson<{ teams: IntlTeamData[] }>(dir, "intl.json"),
    getJson<MetaData>(dir, "meta.json"),
    getJson<HeatmapData>(dir, "heatmap.json"),
    getJson<ItemData>(dir, "items.json"),
    getJson<MatchupData>(dir, "matchups.json"),
  ]);
  if (!teams) throw new Error("teams.json이 없습니다");
  return assembleData(dir, champs, players, staff, teams, intl, meta, heatmap, items, matchups);
}

export function assembleData(
  dir: "data" | "data-sample",
  champs: { version: string; champions: ChampionData[] },
  players: { players: PlayerData[] },
  staff: { staff: StaffData[] } | null,
  teams: { teams: TeamData[] },
  intl: { teams: IntlTeamData[] } | null,
  meta: MetaData | null,
  heatmap: HeatmapData | null,
  items: ItemData | null = null,
  matchups: MatchupData | null = null,
): GameData {
  const mergedMeta: MetaData = {
    ...DEFAULT_META,
    ...(meta ?? {}),
    objectives: { ...DEFAULT_META.objectives, ...(meta?.objectives ?? {}) },
    camps: { ...DEFAULT_META.camps, ...(meta?.camps ?? {}) },
  };
  const champions = champs.champions.slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return {
    source: dir,
    ddVersion: champs.version,
    champions,
    champ: new Map(champions.map((c) => [c.id, c])),
    players: players.players,
    staff: staff?.staff ?? [],
    teams: teams.teams,
    intl: intl?.teams?.length ? intl.teams : fallbackIntl(),
    meta: mergedMeta,
    heatmap,
    items: items?.champs ? items : null,
    matchups: matchups?.roles ? matchups : null,
  };
}

export function champImg(version: string, id: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${id}.png`;
}
export function spellImg(version: string, icon: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${icon}`;
}
