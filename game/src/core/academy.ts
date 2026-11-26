// 2군 (LCK CL academy) rosters: built from each club's real 2026 LCK CL roster, topped up with prospects.
// Players move between the academy and the main roster by call-up (콜업) and send-down (2군행).
import type { GameData } from "../data/load";
import type { Role } from "../data/types";
import { ROLES, ROLE_KO } from "../data/types";
import { addNews, inbox } from "./news";
import { age, makeRookie, ovr } from "./player";
import { clamp, Rng } from "./rng";
import { money } from "./format";
import type { GameState, Player, Team } from "./types";

export const ACADEMY_MAX = 8;
export const MAIN_ROSTER_MAX = 10;
export const LCK_MIN_SALARY = 6000;

export function academyOf(t: Team): string[] {
  if (!t.academy) t.academy = [];
  return t.academy;
}

export function academySalary(p: Player): number {
  return Math.round((2000 + Math.max(0, ovr(p) - 50) * 120) / 100) * 100;
}

function putInAcademy(s: GameState, p: Player, t: Team, salary: number, years: number) {
  p.team = t.id;
  p.academy = true;
  p.contract = { salary, until: s.season + years - 1, signedDay: s.day };
  p.listed = false;
  p.unpaid = 0;
  p.feeTalk = undefined; // a new contract: earlier fee talks with any club are void
  academyOf(t).push(p.id);
}

/** Give every LCK club its 2군: the real 2026 LCK CL roster when those players are still free, plus prospects. */
export function setupAcademies(s: GameState, data: GameData, rng: Rng) {
  for (const id of s.lck) {
    const t = s.teams[id];
    if (t.academy && t.academy.length) continue;
    academyOf(t);
    const cl = data.teams.find((x) => x.tier === 2 && x.parent === id);
    for (const pid of cl?.lastRoster ?? []) {
      const p = s.players[pid];
      if (!p || p.team || p.retired || p.origin !== "real" || t.academy!.length >= ACADEMY_MAX) continue;
      putInAcademy(s, p, t, academySalary(p), rng.int(1, 2));
      p.history.push(`${s.season}: ${t.name} 2군`);
    }
    fillAcademy(s, t, rng);
  }
}

/** Make sure the academy covers every role at least once, with fictional prospects if needed. */
export function fillAcademy(s: GameState, t: Team, rng: Rng) {
  const ac = academyOf(t);
  for (const r of ROLES) {
    if (ac.length >= ACADEMY_MAX) break;
    if (ac.some((pid) => s.players[pid]?.role === r)) continue;
    const p = makeRookie(s, rng, r);
    s.players[p.id] = p;
    putInAcademy(s, p, t, academySalary(p), 2);
    p.history.push(`${s.season}: ${t.name} 2군 입단 (가상 신인)`);
  }
}

export function canCallUp(s: GameState, p: Player): { ok: boolean; msg?: string } {
  if (!p.team || !p.academy) return { ok: false, msg: "2군 선수가 아닙니다." };
  const t = s.teams[p.team];
  if (t.roster.length >= MAIN_ROSTER_MAX) return { ok: false, msg: "1군 로스터가 10명으로 가득 찼습니다." };
  if (p.scandal) return { ok: false, msg: "징계 중입니다." };
  return { ok: true };
}

/** 2군 → 1군. Salary rises to the LCK minimum if it was below it. */
export function callUp(s: GameState, p: Player, note = true): boolean {
  if (!canCallUp(s, p).ok) return false;
  const t = s.teams[p.team!];
  t.academy = academyOf(t).filter((x) => x !== p.id);
  t.roster.push(p.id);
  p.academy = false;
  if (p.contract && p.contract.salary < LCK_MIN_SALARY) p.contract.salary = LCK_MIN_SALARY;
  p.morale = clamp(p.morale + 10, 0, 100);
  p.history.push(`${s.season}: ${t.name} 1군 콜업`);
  if (!t.lineup[p.role] && t.id === s.user) t.lineup[p.role] = p.id;
  if (note) addNews(s, { kind: "sign", title: `${t.name}, 2군 '${p.name}' 1군 콜업`, body: `${ROLE_KO[p.role]} · OVR ${ovr(p)}`, teams: [t.id], players: [p.id] });
  return true;
}

export function canSendDown(s: GameState, p: Player): { ok: boolean; msg?: string } {
  if (!p.team || p.academy) return { ok: false };
  const t = s.teams[p.team];
  if (academyOf(t).length >= ACADEMY_MAX) return { ok: false, msg: "2군이 8명으로 가득 찼습니다." };
  if (ovr(p) >= 82 || p.fame >= 60) return { ok: false, msg: `${p.name}가 2군행을 거부합니다. (주축급 선수)` };
  return { ok: true };
}

/** 1군 → 2군. The contract stays; ambitious players take it badly. */
export function sendDown(s: GameState, p: Player): boolean {
  if (!canSendDown(s, p).ok) return false;
  const t = s.teams[p.team!];
  t.roster = t.roster.filter((x) => x !== p.id);
  for (const r of ROLES) if (t.lineup[r] === p.id) t.lineup[r] = null;
  academyOf(t).push(p.id);
  p.academy = true;
  p.morale = clamp(p.morale - 8 - p.persona.ambition * 12, 0, 100);
  p.history.push(`${s.season}: ${t.name} 2군행`);
  addNews(s, { kind: "release", title: `${t.name}, '${p.name}' 2군행`, teams: [t.id], players: [p.id] });
  return true;
}

/** Best academy player for a role (falls back to anyone when nobody plays it). */
export function bestAcademyFor(s: GameState, t: Team, role: Role): Player | null {
  const ac = academyOf(t).map((id) => s.players[id]).filter((p) => p && !p.scandal);
  const pool = ac.filter((p) => p.role === role);
  return (pool.length ? pool : ac).sort((a, b) => ovr(b) - ovr(a))[0] ?? null;
}

/** Fill an empty starting role from the academy. Returns the player called up, if any. */
export function autoCallUp(s: GameState, t: Team, role: Role): Player | null {
  if (t.roster.length >= MAIN_ROSTER_MAX) return null;
  const p = bestAcademyFor(s, t, role);
  if (!p || p.role !== role) return null;
  callUp(s, p, true);
  t.lineup[role] = p.id;
  if (t.id === s.user) inbox(s, `${ROLE_KO[role]} 자리가 비어 2군에서 ${p.name}를 콜업했습니다. (연봉 ${money(p.contract?.salary ?? 0)})`);
  return p;
}

/** Season end: renew young academy players, let older ones go, refill with prospects. */
export function academySeasonEnd(s: GameState, rng: Rng) {
  for (const id of s.lck) {
    const t = s.teams[id];
    for (const pid of [...academyOf(t)]) {
      const p = s.players[pid];
      if (!p) continue;
      if (!p.contract || p.contract.until > s.season) continue;
      const keep = age(p, s.season + 1) <= 22 || ovr(p) >= 62;
      if (keep) {
        p.contract = { salary: academySalary(p), until: s.season + 1, signedDay: s.day };
      } else {
        t.academy = academyOf(t).filter((x) => x !== pid);
        p.team = null;
        p.academy = false;
        p.contract = null;
        p.history.push(`${s.season}: ${t.name} 2군 계약 만료`);
        if (t.id === s.user) inbox(s, `2군 ${p.name}와 계약이 끝났습니다.`);
      }
    }
    fillAcademy(s, t, rng);
  }
}
