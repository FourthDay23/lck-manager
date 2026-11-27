// Foreign clubs (s.intl) keep fixed five-man rosters outside the LCK market. Their players age by the same rules as
// LCK players (core/game.ts seasonEnd, from 26) and grow toward their potential like any AI player (aiGrowth). This
// file renews those rosters: a retiring player is replaced by a young local prospect near the club's level, and a
// club drops a starter who has fallen well below it. Without this a foreign club only ever grew (T22).
import type { Role } from "../data/types";
import { ATTR_KEYS } from "../data/types";
import { addNews } from "./news";
import { age, emptyLine, formulaOvr, ovr, personaFor, potentialFor } from "./player";
import { clamp } from "./rng";
import type { Rng } from "./rng";
import { releasePlayer } from "./market";
import type { Attrs } from "../data/types";
import type { GameState, Player, Team } from "./types";

const REGION_NAT: Record<string, string> = { LPL: "CN", LEC: "EU", LCP: "TW", LTA: "US" };
const HANDLES = [
  "Ace", "Bolt", "Crane", "Drift", "Echo", "Flux", "Grim", "Hex", "Iris", "Jett", "Kyro", "Lynx", "Mako", "Nyx", "Orca",
  "Pulse", "Quake", "Rook", "Shiro", "Tempo", "Ultra", "Volt", "Wren", "Xeno", "Yuki", "Zephyr", "Astro", "Blaze",
  "Cobalt", "Dusk", "Ezra", "Frost", "Gekko", "Halo", "Inferno", "Jinx", "Kaze", "Lotus", "Mirage", "Nimbus", "Oath",
  "Phantom", "Quartz", "Raven", "Saber", "Talon", "Viper", "Warden", "Xiao", "Yang", "Zhen", "Ming", "Lei", "Tian",
];

/** How far below the club's level a starter (24+) may fall before the club replaces him. */
const DROP_GAP = 5;

function level(t: Team): number {
  return t.intlStrength ?? 75;
}

/** A young local prospect for a foreign club, a few points under its level with room to grow. */
export function intlProspect(s: GameState, rng: Rng, t: Team, role: Role, season: number): Player {
  s.genCount += 1;
  const taken = new Set(Object.values(s.players).map((p) => p.name));
  let name = rng.pick(HANDLES);
  for (let i = 0; taken.has(name) && i < 20; i++) name = rng.pick(HANDLES) + rng.pick(["", "X", "Z", "0"]) + (i > 5 ? i : "");
  if (taken.has(name)) name = `${name}${s.genCount}`;
  const id = `intl:${t.id}:new${s.genCount}`;
  const a = rng.int(18, 21);
  const target = clamp(Math.round(level(t) - rng.range(2, 6)), 50, 92);
  const attrs = {} as Attrs;
  for (const k of ATTR_KEYS) attrs[k] = clamp(Math.round(target + rng.normal(0, 3)), 30, 95);
  const p: Player = {
    id, name, realName: "", nat: REGION_NAT[t.region] ?? "XX", birthYear: season - a, role, tier: 1, origin: "intl",
    team: t.id, contract: { salary: 0, until: 9999, signedDay: s.day },
    attrs, ovrOffset: Math.round((target - formulaOvr(role, attrs)) * 10) / 10, pot: 0,
    fame: 20, morale: 70, fatigue: 0, form: 0, mastery: {}, persona: personaFor(id), unpaid: 0,
    train: "rest", xp: {}, season: emptyLine(), career: { ...emptyLine(), titles: [] },
    history: [`${season}: ${t.name} 입단 (신인)`], lastTeamName: null,
  };
  // the same hidden ceiling as everyone else, kept within reach of the club's level so a club does not snowball
  p.pot = Math.max(ovr(p), Math.min(potentialFor(id, ovr(p), a), level(t) + 5));
  return p;
}

/** A foreign-club player leaves the game (retirement, military service, dropped) and a prospect takes his role. */
export function replaceIntl(s: GameState, rng: Rng, p: Player, why: string, season: number) {
  const t = p.team ? s.teams[p.team] : null;
  if (!t) return;
  const np = intlProspect(s, rng, t, p.role, season + 1);
  s.players[np.id] = np;
  t.roster.push(np.id); // before the release, so market.ts does not sign its own stand-in for the empty role
  releasePlayer(s, p, why);
  p.retired = true;
  p.history.push(`${season}: ${why}`);
  if (ovr(p) >= 80) addNews(s, { kind: "info", title: `${t.name} '${p.name}' ${why}, 신인 '${np.name}' 합류`, teams: [], players: [p.id] });
}

/** Season end, after aging: each foreign club drops starters who have fallen well below its level. */
export function renewIntlRosters(s: GameState, rng: Rng, season: number) {
  for (const id of s.intl) {
    const t = s.teams[id];
    for (const pid of [...t.roster]) {
      const p = s.players[pid];
      if (!p || p.retired || p.origin !== "intl") continue;
      if (age(p, season + 1) >= 24 && ovr(p) < level(t) - DROP_GAP && rng.chance(0.6)) replaceIntl(s, rng, p, "세대교체로 방출", season);
    }
  }
}
