// Shapes of the JSON files in public/data (written by scripts/build_*.py in the data session).

export type Role = "Top" | "Jungle" | "Mid" | "Bot" | "Support";
export const ROLES: Role[] = ["Top", "Jungle", "Mid", "Bot", "Support"];
export const ROLE_KO: Record<Role, string> = { Top: "탑", Jungle: "정글", Mid: "미드", Bot: "원딜", Support: "서폿" };

export type AttrKey = "laning" | "teamfight" | "macro" | "mechanics" | "consistency" | "pool";
export const ATTR_KEYS: AttrKey[] = ["laning", "teamfight", "macro", "mechanics", "consistency", "pool"];
export const ATTR_KO: Record<AttrKey, string> = {
  laning: "라인전",
  teamfight: "한타",
  macro: "운영",
  mechanics: "피지컬",
  consistency: "안정감",
  pool: "챔프폭",
};
export type Attrs = Record<AttrKey, number>;

export type VfxKind =
  | "line" | "circle" | "cone" | "dash" | "blink" | "target" | "self" | "shield" | "heal"
  | "zone" | "global" | "summon" | "knockup" | "wall" | "stealth";

export interface SpellData {
  key: "Q" | "W" | "E" | "R";
  name: string;
  icon: string;
  cd: number;
  range: number;
  vfx: VfxKind;
  /** a second effect the spell has (e.g. a dash that ends in a knock-up) */
  also?: VfxKind;
  radius?: number;
  width?: number;
  cc: boolean;
  power: number;
}

export type StyleKey = "early" | "scaling" | "engage" | "peel" | "poke" | "waveclear" | "split" | "burst" | "sustain";
export const STYLE_KO: Record<StyleKey, string> = {
  early: "초반", scaling: "후반", engage: "이니시", peel: "보호", poke: "포킹",
  waveclear: "라인클리어", split: "스플릿", burst: "폭딜", sustain: "유지력",
};

export interface ChampionData {
  id: string;
  name: string;
  nameEn: string;
  tags: string[];
  roles: Record<Role, number>;
  damage: "AP" | "AD" | "Mixed";
  ranged: boolean;
  attackRange: number;
  moveSpeed: number;
  color: string;
  style: Record<StyleKey, number>;
  pro: { picks: number; bans: number; wins: number; presence: number };
  spells: SpellData[];
  passive?: { name: string };
}

export interface PlayerData {
  id: string;
  name: string;
  realName: string;
  nat: string;
  birth: string | null;
  role: Role;
  tier: 1 | 2;
  lastTeam: string | null;
  teams: string[];
  seasons: string[];
  games: number;
  stats: Partial<{ wr: number; kda: number; kp: number; dpm: number; gpm: number; cspm: number; vspm: number; gd15: number | null }>;
  attrs: Attrs;
  ovr: number;
  fame: number;
  champs: { c: string; g: number; w: number }[];
  intl: number;
}

export interface StaffData {
  id: string;
  name: string;
  realName: string;
  nat: string;
  birth: string | null;
  role: "Head Coach" | "Coach" | "Strategic Coach" | "Analyst";
  lastTeam: string | null;
  tier: 1 | 2;
  seasons: string[];
  record?: { w: number; l: number };
  titles: number;
  fame: number;
}

export interface TeamData {
  id: string;
  name: string;
  nameKo: string;
  short: string;
  tier: 1 | 2;
  parent: string | null;
  academy: string | null;
  colors: [string, string];
  logo: string | null;
  wealth: number;
  fans: number;
  lastRoster: string[];
  lastStaff: string[];
  titles: { lck: number; msi: number; worlds: number };
}

export interface IntlTeamData {
  id: string;
  name: string;
  short: string;
  region: string;
  colors: [string, string];
  logo: string | null;
  strength: number;
  roster: { id: string; name: string; role: Role; nat: string; ovr: number; attrs: Attrs; champs: { c: string; g: number; w: number }[] }[];
}

export interface ObjTiming { firstSpawn: number; respawn: number | null }
export interface MetaData {
  objectives: Partial<Record<"dragon" | "grubs" | "herald" | "baron" | "atakhan" | "elder", ObjTiming>>;
  camps: Partial<Record<"blue" | "red" | "gromp" | "wolves" | "raptors" | "krugs" | "scuttle", ObjTiming>>;
  gameLength?: { mean: number; p10: number; p90: number };
  killsPerMin?: number[];
  soloKillRate?: Partial<Record<Role, number>>;
  multikills?: { double: number; triple: number; quadra: number; penta: number };
  dragonTypes?: Record<string, number>;
  draft?: { order?: [string, string][]; fearless?: string; source?: string };
}

export interface HeatmapData {
  bin_size: number;
  origin: [number, number];
  shape: [number, number];
  counts: Record<Role, Record<string, number[][]>>;
}
