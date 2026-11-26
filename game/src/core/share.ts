// Roster codes: turn a team into a short text code, and build a match between two codes on any device.
// Nothing is sent over the network: players copy the code (messenger, etc.) and paste it into the host device.
import LZString from "lz-string";
import type { GameData } from "../data/load";
import type { AttrKey, Role } from "../data/types";
import { ATTR_KEYS, ROLES } from "../data/types";
import { emptyLine, ovr, personaFor } from "./player";
import { hash32, Rng } from "./rng";
import { rollPatch } from "./meta";
import type { GameState, Player, Staff, Team } from "./types";

const PREFIX = "LCKM1";

interface CodePlayer {
  n: string; // handle
  rn: string; // real name
  r: Role;
  nat: string;
  b: number; // birth year
  a: number[]; // attributes in ATTR_KEYS order
  o: number; // ovr offset
  f: number; // fame
  fm: number; // form
  mo: number; // morale
  m: [string, number][]; // top champion masteries
  s: 1 | 0; // starter
}

export interface TeamCode {
  v: 1;
  name: string;
  short: string;
  colors: [string, string];
  logo: string | null;
  origin: string; // team id on the source device, for the logo
  manager: string;
  season: number;
  synergy: number;
  coach: { name: string; draft: number; develop: number; motivate: number; analysis: number } | null;
  players: CodePlayer[];
}

/** Build a code for one of the user's teams: the five starters plus up to three subs. */
export function exportTeamCode(s: GameState, teamId: string): string {
  const t = s.teams[teamId];
  const starters = ROLES.map((r) => t.lineup[r]).filter(Boolean) as string[];
  const subs = t.roster.filter((id) => !starters.includes(id)).slice(0, 3);
  const enc = (id: string, starter: boolean): CodePlayer => {
    const p = s.players[id];
    return {
      n: p.name, rn: p.realName, r: p.role, nat: p.nat, b: p.birthYear,
      a: ATTR_KEYS.map((k) => p.attrs[k]), o: Math.round(p.ovrOffset * 10) / 10, f: p.fame, fm: Math.round(p.form * 10) / 10,
      mo: Math.round(p.morale),
      m: Object.entries(p.mastery).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([c, v]) => [c, Math.round(v)] as [string, number]),
      s: starter ? 1 : 0,
    };
  };
  const hc = t.staff.map((id) => s.staff[id]).find((x) => x?.role === "Head Coach");
  const code: TeamCode = {
    v: 1, name: t.name, short: t.short, colors: t.colors, logo: t.logo, origin: t.id, manager: s.managerName, season: s.season,
    synergy: Math.round(t.synergy),
    coach: hc ? { name: hc.name, ...hc.attrs } : null,
    players: [...starters.map((id) => enc(id, true)), ...subs.map((id) => enc(id, false))],
  };
  const body = LZString.compressToEncodedURIComponent(JSON.stringify(code));
  const sum = (hash32(body) % 0xffff).toString(16).padStart(4, "0");
  return `${PREFIX}-${body}-${sum}`;
}

export function parseTeamCode(text: string): { ok: true; code: TeamCode } | { ok: false; msg: string } {
  const raw = text.trim().replace(/\s+/g, "");
  if (!raw.startsWith(PREFIX + "-")) return { ok: false, msg: "LCK 매니저 로스터 코드가 아닙니다. (LCKM1-로 시작해야 합니다)" };
  const last = raw.lastIndexOf("-");
  const body = raw.slice(PREFIX.length + 1, last);
  const sum = raw.slice(last + 1);
  if ((hash32(body) % 0xffff).toString(16).padStart(4, "0") !== sum) return { ok: false, msg: "코드 일부가 잘렸거나 바뀌었습니다. 처음부터 끝까지 다시 복사해 주세요." };
  try {
    const code = JSON.parse(LZString.decompressFromEncodedURIComponent(body) ?? "") as TeamCode;
    if (code.v !== 1 || !Array.isArray(code.players) || code.players.filter((p) => p.s).length < 5) return { ok: false, msg: "주전 5명이 없는 코드입니다." };
    return { ok: true, code };
  } catch {
    return { ok: false, msg: "코드를 읽을 수 없습니다." };
  }
}

function codePlayer(id: string, teamId: string, c: CodePlayer, season: number): Player {
  const attrs = {} as Record<AttrKey, number>;
  ATTR_KEYS.forEach((k, i) => (attrs[k] = Math.max(1, Math.min(99, Math.round(c.a[i] ?? 60)))));
  return {
    id, name: c.n, realName: c.rn ?? "", nat: c.nat ?? "KR", birthYear: c.b ?? season - 21, role: c.r, tier: 1, origin: "real", team: teamId,
    contract: { salary: 0, until: 9999, signedDay: 0 }, attrs, ovrOffset: c.o ?? 0, pot: 99, fame: c.f ?? 30, morale: c.mo ?? 70,
    fatigue: 0, form: c.fm ?? 0, mastery: Object.fromEntries(c.m ?? []), persona: personaFor(id), unpaid: 0, train: "rest", xp: {},
    season: emptyLine(), career: { ...emptyLine(), titles: [] }, history: [], lastTeamName: null,
  };
}

/**
 * A throwaway game state holding only the two teams, for the exhibition match. Nothing here touches the career save.
 * `codes[0]` plays as side "EXA", `codes[1]` as "EXB".
 */
export function buildExhibition(data: GameData, codes: [TeamCode, TeamCode], hostMeta: GameState["meta"] | undefined, seed: number): GameState {
  const s: GameState = {
    version: 2, seed, rng: seed, day: 0, season: Math.max(codes[0].season, codes[1].season), difficulty: "normal", user: "__exhibition__",
    managerName: "", players: {}, staff: {}, teams: {}, lck: ["EXA", "EXB"], intl: [], comps: [], series: [], bids: [], tradeOffers: [],
    saleOffers: [], news: [], trophies: [], ledger: [], events: [], cutscenes: [], inbox: [], genCount: 0,
    stats: { seasonsPlayed: 0, seriesW: 0, seriesL: 0 },
  };
  codes.forEach((c, i) => {
    const tid = i === 0 ? "EXA" : "EXB";
    const t: Team = {
      id: tid, name: c.name, nameKo: c.name, short: c.short, tier: 1, region: "LCK", colors: c.colors, logo: c.logo, wealth: 3, fans: 0,
      fame: 50, cash: 0, roster: [], lineup: { Top: null, Jungle: null, Mid: null, Bot: null, Support: null }, staff: [], policy: "win",
      synergy: c.synergy ?? 60, facilities: { training: 0, housing: 0, analysis: 0, marketing: 0 }, sponsor: 0, goods: [],
      titles: { lck: 0, msi: 0, worlds: 0, cup: 0 },
    };
    s.teams[tid] = t;
    c.players.forEach((cp, k) => {
      const pid = `${tid}:${k}:${cp.n}`;
      const p = codePlayer(pid, tid, cp, s.season);
      s.players[pid] = p;
      t.roster.push(pid);
      if (cp.s && !t.lineup[cp.r]) t.lineup[cp.r] = pid;
    });
    for (const r of ROLES) {
      if (t.lineup[r]) continue;
      const spare = t.roster.find((id) => !Object.values(t.lineup).includes(id));
      if (spare) t.lineup[r] = spare;
    }
    if (c.coach) {
      const st: Staff = {
        id: `${tid}:coach`, name: c.coach.name, realName: "", nat: "KR", role: "Head Coach", team: tid, contract: null, fame: 50,
        attrs: { draft: c.coach.draft, develop: c.coach.develop, motivate: c.coach.motivate, analysis: c.coach.analysis },
        titles: 0, record: { w: 0, l: 0 }, lastTeamName: null,
      };
      s.staff[st.id] = st;
      t.staff.push(st.id);
    }
  });
  if (hostMeta) s.meta = hostMeta;
  else rollPatch(s, data, new Rng(seed));
  return s;
}

export function codeSummary(c: TeamCode): string {
  const starters = c.players.filter((p) => p.s);
  return starters.map((p) => p.n).join(" · ");
}

export function codeOvr(c: TeamCode): number {
  const tmp = c.players.filter((p) => p.s).map((cp, i) => codePlayer(`tmp${i}`, "X", cp, c.season));
  return Math.round(tmp.reduce((a, p) => a + ovr(p), 0) / Math.max(1, tmp.length));
}
