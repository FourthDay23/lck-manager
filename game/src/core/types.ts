import type { Attrs, AttrKey, Role } from "../data/types";

export type Difficulty = "easy" | "normal" | "hard";
export type TrainFocus = AttrKey | "champ" | "rest";
export type Policy = "win" | "star" | "youth" | "vet" | "budget";

export interface Contract {
  salary: number; // 만원 / year
  until: number; // last season year covered (contract ends at that season's end)
  starterPromise?: boolean;
  signedDay: number;
}

export interface SeasonLine {
  g: number; w: number; k: number; d: number; a: number; cs: number; mvp: number;
}

export interface Player {
  id: string;
  name: string;
  realName: string;
  nat: string;
  birthYear: number;
  role: Role;
  tier: 1 | 2;
  origin: "real" | "gen" | "intl";
  team: string | null;
  contract: Contract | null;
  attrs: Attrs;
  ovrOffset: number; // data ovr - formula(attrs), keeps the data's ranking after growth
  pot: number; // hidden ceiling for ovr
  fame: number;
  morale: number;
  fatigue: number;
  form: number; // -10..10 recent performance
  mastery: Record<string, number>; // champion id -> 0..100
  persona: { loyalty: number; ambition: number; greed: number; temper: number };
  unpaid: number;
  train: TrainFocus;
  trainChamp?: string;
  xp: Partial<Record<AttrKey, number>>;
  season: SeasonLine;
  career: SeasonLine & { titles: string[] };
  history: string[];
  lastTeamName: string | null;
  exempt?: boolean; // 병역 혜택
  retired?: boolean;
  lockUntil?: number; // refuses talks until this day
  listed?: boolean; // owner put him on the transfer list
  academy?: boolean; // on the club's 2군 roster rather than the main roster
  interview?: { salaryMul: number; affinity: number; done: boolean };
  affinity?: number; // toward the user's club, -100..100
  patience?: number;
  askSalary?: number; // current ask in an open negotiation
  askTerms?: { years: number; starter: boolean }; // the terms askSalary was given for (market.ts askFor)
  /** The user's transfer-fee talks with the club that holds his contract (see market.ts feeTalk). */
  feeTalk?: { team: string; season: number; start: number; rounds: number; counter?: number; agreed?: number };
  scandal?: number; // days of suspension
  stats?: { wr?: number; kda?: number; kp?: number; dpm?: number; cspm?: number };
}

export interface Staff {
  id: string;
  name: string;
  realName: string;
  nat: string;
  role: "Head Coach" | "Coach" | "Strategic Coach" | "Analyst";
  team: string | null;
  contract: Contract | null;
  fame: number;
  attrs: { draft: number; develop: number; motivate: number; analysis: number };
  titles: number;
  record: { w: number; l: number };
  lastTeamName: string | null;
  /** The user's hiring talks with this coach (core/staffNeg.ts). */
  talk?: StaffTalk;
}

export interface StaffTalk {
  season: number;
  affinity: number; // toward the user's club, -100..100
  patience: number;
  ask?: number; // current ask in an open negotiation
  askYears?: number; // the contract length `ask` was given for (staffNeg.ts staffAskFor)
  interview?: { salaryMul: number }; // set once the interview is done
  lockUntil?: number; // refuses talks until this day
}

export interface GoodsRun {
  id: string;
  kind: GoodsKind;
  featured: string | null; // player id
  units: number;
  sold: number;
  price: number; // 만원 per unit
  cost: number; // total cost paid
  startDay: number;
  weeksLeft: number;
  revenue: number;
}
export type GoodsKind = "uniform" | "photocard" | "stick" | "figure";

export interface Team {
  id: string;
  name: string;
  nameKo: string;
  short: string;
  tier: 1 | 2;
  region: "LCK" | string;
  colors: [string, string];
  logo: string | null;
  wealth: number;
  fans: number;
  fame: number;
  cash: number;
  roster: string[];
  academy?: string[]; // 2군 (LCK CL) player ids, max 8
  /** User club training plan: daily intensity and the fatigue level at which a player rests automatically (null = off). */
  trainPlan?: { intensity: "light" | "normal" | "hard"; autoRestAt: number | null };
  lineup: Record<Role, string | null>;
  staff: string[];
  policy: Policy;
  synergy: number;
  facilities: { training: number; housing: number; analysis: number; marketing: number };
  sponsor: number; // monthly sponsor income, renegotiated each season
  goods: GoodsRun[];
  titles: { lck: number; msi: number; worlds: number; cup: number };
  intlStrength?: number;
  tradeBlock?: string[];
  aiCooldown?: number;
}

export type CompId = "CUP" | "REG" | "REG2" | "PO" | "MSI" | "EWCQ" | "EWC" | "WORLDS";
export const COMP_NAME: Record<CompId, string> = {
  CUP: "LCK 컵",
  REG: "LCK 정규 시즌 1·2R",
  REG2: "LCK 정규 시즌 3R",
  PO: "LCK 플레이오프",
  MSI: "MSI",
  EWCQ: "EWC 선발전",
  EWC: "e스포츠 월드컵(EWC)",
  WORLDS: "월드 챔피언십",
};

export interface GameRecord {
  blue: string;
  red: string;
  winner: string;
  duration: number;
  kills: [number, number];
  gold: [number, number];
  picks: { blue: string[]; red: string[] };
  bans: { blue: string[]; red: string[] };
  mvp: string | null;
  box?: Record<string, { k: number; d: number; a: number; cs: number; champ: string }>;
}

export interface Series {
  id: string;
  comp: CompId;
  season: number;
  stage: string; // "RR", "QF", "SF", "F", "SW1"...
  day: number;
  a: string | null; // null = to be decided by bracket
  b: string | null;
  bo: 1 | 3 | 5;
  done: boolean;
  wa: number;
  wb: number;
  winner?: string;
  games: GameRecord[];
  feedA?: string; // bracket feed: "W:<seriesId>" / "L:<seriesId>" / "S:<seed>"
  feedB?: string;
}

export interface Standing { team: string; w: number; l: number; gw: number; gl: number }

export interface Competition {
  id: CompId;
  season: number;
  name: string;
  teams: string[];
  start: number;
  end: number;
  done: boolean;
  champion?: string;
  runnerUp?: string;
  prize: number[]; // by final rank, 만원
}

export interface NewsItem {
  id: string;
  day: number;
  kind: "sign" | "release" | "trade" | "result" | "title" | "tamper" | "scandal" | "money" | "info" | "renew" | "rumor";
  title: string;
  body?: string;
  teams?: string[];
  players?: string[];
  mine?: boolean;
}

export interface Trophy {
  id: string;
  comp: CompId;
  season: number;
  name: string;
  day: number;
  final?: string; // "3:1 vs Gen.G"
  roster: { name: string; role: Role }[];
  coach: string | null;
}

export interface Bid {
  team: string;
  player: string;
  salary: number;
  years: number;
  fee: number;
  due: number;
}

export interface TradeOffer {
  id: string;
  from: string; // AI team
  give: string[]; // their players
  want: string[]; // user's players
  cash: number; // + means AI pays the user
  expires: number;
}

export interface SaleOffer {
  id: string;
  team: string;
  player: string;
  fee: number;
  expires: number;
}

export interface ModalEvent {
  id: string;
  kind: string;
  title: string;
  body: string;
  player?: string;
  options: { label: string; desc: string; effect: string }[];
}

export interface Cutscene {
  kind: "sign" | "renew" | "title" | "trade";
  title: string;
  sub?: string;
  player?: string;
  team?: string;
  lines?: string[];
  trophy?: CompId;
}

export interface LedgerMonth {
  month: string;
  income: Record<string, number>;
  expense: Record<string, number>;
}

export type MetaTier = "S" | "A" | "N";
export interface MetaState {
  patch: string;
  since: number;
  tiers: Record<string, MetaTier>;
  history: { patch: string; since: number; s: string[]; nerf: string[] }[];
}

export interface GameState {
  version: number;
  seed: number;
  rng: number;
  day: number;
  season: number;
  difficulty: Difficulty;
  user: string;
  managerName: string;
  players: Record<string, Player>;
  staff: Record<string, Staff>;
  teams: Record<string, Team>;
  lck: string[]; // LCK team ids
  intl: string[]; // international team ids
  comps: Competition[];
  series: Series[];
  bids: Bid[];
  tradeOffers: TradeOffer[];
  saleOffers: SaleOffer[];
  news: NewsItem[];
  trophies: Trophy[];
  ledger: LedgerMonth[];
  events: ModalEvent[];
  cutscenes: Cutscene[];
  inbox: { id: string; day: number; text: string; read?: boolean }[];
  genCount: number;
  lastPayMonth?: string;
  stats: { seasonsPlayed: number; seriesW: number; seriesL: number };
  meta?: MetaState;
  /** Big pop-up notices the player must see (trade offers, transfer bids). Shown one at a time, newest last. */
  alerts?: { id: string; day: number; kind: "trade" | "sale" | "info"; title: string; body: string; ref?: string }[];
}

export type { Role, Attrs };
