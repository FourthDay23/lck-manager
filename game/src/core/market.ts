// Transfers: user negotiations (interview, offers, club fee talks), AI bids, trades, sales, staff hiring.
import type { Role } from "../data/types";
import { ROLES, ROLE_KO } from "../data/types";
import { addNews, inbox, teamName } from "./news";
import { LOW_PREFERENCE, age, contractYearsLeft, emptyLine, marketValue, ovr, salaryAsk, teamAppeal } from "./player";
import { clamp, hashUnit, Rng } from "./rng";
import { money } from "./format";
import type { Bid, GameState, Player, Staff, Team, TradeOffer } from "./types";
import { seasonDates } from "./schedule";
import { earn, spend, teamCash } from "./ledger";
import { eventAskMul, outLabel } from "./evmemo";
import { farewellHow, queueFarewell } from "./farewell";

export const ROSTER_MAX = 10;

// ---------- windows ----------
function openOn(season: number, dn: number): boolean {
  const d = seasonDates(season);
  if (dn < d.cup) return true; // stove league
  if (dn >= d.cup + 47 && dn <= d.break1End) return true; // after the cup
  if (dn >= d.msi && dn < d.reg2) return true; // mid-season
  if (dn >= d.end - 1) return true;
  return false;
}

export function windowOpen(s: GameState): boolean {
  return openOn(s.season, s.day);
}

export function windowLabel(s: GameState): string {
  return windowOpen(s) ? "이적시장 열림" : "이적시장 닫힘";
}

/**
 * When the window next opens (if closed today) or closes (if open today): `day` is the first day in the other state,
 * `days` how many days away it is. Walks the same rule as windowOpen day by day, rolling to the next season after
 * its last day (seasonEnd runs on seasonDates().end, so the day after belongs to the next season).
 */
export function windowCountdown(s: GameState): { open: boolean; days: number; day: number } {
  const open = windowOpen(s);
  let season = s.season;
  for (let k = 1; k <= 400; k++) {
    const dn = s.day + k;
    while (dn > seasonDates(season).end) season++;
    if (openOn(season, dn) !== open) return { open, days: k, day: dn };
  }
  return { open, days: 0, day: s.day };
}

// ---------- lineup helpers ----------
export function autoLineup(s: GameState, t: Team) {
  const used = new Set<string>();
  const lineup = { Top: null, Jungle: null, Mid: null, Bot: null, Support: null } as Team["lineup"];
  const avail = t.roster.map((id) => s.players[id]).filter((p) => p && !p.scandal);
  for (const r of ROLES) {
    const best = avail.filter((p) => p.role === r && !used.has(p.id)).sort((a, b) => ovr(b) - ovr(a))[0];
    if (best) {
      lineup[r] = best.id;
      used.add(best.id);
    }
  }
  for (const r of ROLES) {
    if (lineup[r]) continue;
    const any = avail.filter((p) => !used.has(p.id)).sort((a, b) => ovr(b) - ovr(a))[0];
    if (any) {
      lineup[r] = any.id;
      used.add(any.id);
    }
  }
  t.lineup = lineup;
}

export function payroll(s: GameState, t: Team): number {
  let sum = 0;
  for (const id of t.roster) sum += s.players[id]?.contract?.salary ?? 0;
  for (const id of t.academy ?? []) sum += s.players[id]?.contract?.salary ?? 0;
  for (const id of t.staff) sum += s.staff[id]?.contract?.salary ?? 0;
  return sum;
}

export function aiPayrollCap(t: Team): number {
  return 50000 + t.wealth * 60000;
}

/**
 * Room left under an AI club's payroll cap, counting the salaries of its bids still waiting for an answer (any of
 * them may be accepted). Counting only signed contracts let a club with five open roles bid the same room five
 * times: T1, who wins nearly every contested bid, ended its first stove league at 43-47억 against a 35억 cap with
 * four of the five best players.
 */
export function aiCapRoom(s: GameState, t: Team): number {
  const open = s.bids.reduce((a, b) => a + (b.team === t.id ? b.salary : 0), 0);
  return aiPayrollCap(t) - payroll(s, t) - open;
}

/** Takes him off his club. Leaving the user's main roster for anywhere else queues the thank-you card (core/farewell.ts), which is returned so the caller can say how he left. */
function removeFromTeam(s: GameState, p: Player, to?: string) {
  if (!p.team) return undefined;
  const bye = to === s.user ? undefined : queueFarewell(s, p);
  const t = s.teams[p.team];
  if (t) {
    t.roster = t.roster.filter((x) => x !== p.id);
    if (t.academy) t.academy = t.academy.filter((x) => x !== p.id);
    for (const r of ROLES) if (t.lineup[r] === p.id) t.lineup[r] = null;
    // a foreign club that loses a player (sold to the LCK, retired) signs a local replacement
    if (s.intl.includes(t.id) && !t.roster.some((id) => s.players[id]?.role === p.role)) refillIntl(s, t, p.role);
    if (t.id !== s.user) autoLineup(s, t);
  }
  p.lastTeamName = t?.name ?? p.lastTeamName;
  p.team = null;
  p.academy = false;
  p.feeTalk = undefined; // also covers paths that set p.team directly afterwards (2군 등록)
  return bye;
}

export function joinTeam(s: GameState, p: Player, teamId: string, salary: number, years: number, starterPromise = false) {
  const bye = removeFromTeam(s, p, teamId);
  if (bye?.farewell) Object.assign(bye.farewell, { how: "transfer", to: teamId });
  const t = s.teams[teamId];
  p.team = teamId;
  p.academy = false;
  p.contract = { salary, until: s.season + years - 1, starterPromise, signedDay: s.day };
  p.listed = false;
  p.unpaid = 0;
  p.interview = undefined;
  p.patience = undefined;
  p.askSalary = undefined;
  p.askTerms = undefined;
  p.feeTalk = undefined;
  t.roster.push(p.id);
  t.synergy = clamp(t.synergy - 5, 20, 100);
  p.history.push(`${s.season}: ${t.name} 입단`);
  s.bids = s.bids.filter((b) => b.player !== p.id);
  if (t.id !== s.user) autoLineup(s, t);
  else {
    const r = p.role;
    if (!t.lineup[r]) t.lineup[r] = p.id;
  }
}

export function releasePlayer(s: GameState, p: Player, reason: string) {
  const from = p.team;
  const bye = removeFromTeam(s, p);
  if (bye?.farewell) Object.assign(bye.farewell, farewellHow(reason));
  p.contract = null;
  p.listed = false;
  if (from) p.history.push(`${s.season}: ${teamName(s, from)} 계약 해지 (${reason})`);
}

// ---------- user negotiation ----------
export type NegMode = "sign" | "renew" | "transfer";

export interface Question {
  id: string;
  q: string;
  answers: { t: string; w: Partial<Record<keyof Player["persona"], number>>; base: number }[];
}

const SIGN_Q: Question[] = [
  { id: "role", q: "우리 팀에 오면 어떤 역할을 맡게 되나요?", answers: [
    { t: "팀의 중심입니다. 주전으로 시작합니다.", w: { ambition: 1 }, base: 0.15 },
    { t: "경쟁을 통해 주전을 따내야 합니다.", w: { ambition: -0.6, loyalty: 0.3 }, base: -0.05 },
    { t: "당분간은 식스맨으로 경험을 쌓습니다.", w: { ambition: -1.2 }, base: -0.2 },
    { t: "메타와 상대에 따라 기용합니다.", w: {}, base: 0 },
  ] },
  { id: "goal", q: "이번 시즌 목표는 뭔가요?", answers: [
    { t: "무조건 우승입니다.", w: { ambition: 1.2 }, base: 0.05 },
    { t: "플레이오프 진출이 1차 목표입니다.", w: {}, base: 0 },
    { t: "성장 중심 리빌딩 시즌입니다.", w: { ambition: -0.8, loyalty: 0.4 }, base: -0.05 },
    { t: "팬과 함께 즐기는 팀을 만들고 싶습니다.", w: { temper: -0.5 }, base: 0 },
  ] },
  { id: "pay", q: "대우는 어떻게 생각하시나요?", answers: [
    { t: "시장가 이상으로 확실히 대우하겠습니다.", w: { greed: 1.2 }, base: 0.1 },
    { t: "성적 보너스로 보상하겠습니다.", w: { ambition: 0.8, greed: -0.3 }, base: 0 },
    { t: "팀 사정이 넉넉하진 않습니다.", w: { greed: -1.2 }, base: -0.15 },
    { t: "계약금으로 성의를 보이겠습니다.", w: { greed: 0.7 }, base: 0.05 },
  ] },
  { id: "mood", q: "팀 분위기는 어떤가요?", answers: [
    { t: "가족 같은 분위기입니다.", w: { loyalty: 1 }, base: 0.05 },
    { t: "철저한 실력주의입니다.", w: { ambition: 0.7, temper: -0.6 }, base: 0 },
    { t: "자유롭게 의견을 냅니다.", w: { temper: 0.9 }, base: 0.05 },
    { t: "감독 중심의 규율이 있습니다.", w: { temper: -1 }, base: -0.05 },
  ] },
  { id: "future", q: "나중에 더 큰 무대로 가고 싶다면요?", answers: [
    { t: "좋은 제안이 오면 보내 드리겠습니다.", w: { ambition: 1 }, base: 0.05 },
    { t: "오래 함께하고 싶습니다.", w: { loyalty: 1.1, ambition: -0.3 }, base: 0 },
    { t: "계약 기간은 지켜야 합니다.", w: { ambition: -0.5 }, base: -0.05 },
    { t: "바이아웃 조항을 넣읍시다.", w: { greed: 0.8 }, base: 0 },
  ] },
  { id: "practice", q: "연습은 어떻게 하나요?", answers: [
    { t: "스크림 위주로 강하게 갑니다.", w: { ambition: 0.9, temper: -0.2 }, base: 0 },
    { t: "솔로랭크는 자율입니다.", w: { temper: 0.8 }, base: 0.05 },
    { t: "컨디션 관리가 먼저입니다.", w: { loyalty: 0.3 }, base: 0.05 },
    { t: "개인 VOD 분석을 많이 합니다.", w: {}, base: 0 },
  ] },
];

const RENEW_Q: Question[] = [
  { id: "r-role", q: "재계약하면 제 역할은 뭔가요?", answers: [
    { t: "팀의 중심입니다.", w: { ambition: 1 }, base: 0.15 },
    { t: "지금처럼 갑니다.", w: { loyalty: 0.5 }, base: 0 },
    { t: "경쟁해서 증명해야 합니다.", w: { ambition: -0.9 }, base: -0.1 },
    { t: "상황을 봐서 정하겠습니다.", w: {}, base: -0.2 },
  ] },
  { id: "r-eval", q: "지난 시즌 저를 어떻게 평가하세요?", answers: [
    { t: "최고의 시즌이었습니다.", w: { temper: 0.3 }, base: 0.15 },
    { t: "좋았지만 더 할 수 있습니다.", w: { ambition: 0.9 }, base: 0.05 },
    { t: "아쉬움이 많았습니다.", w: { temper: -1 }, base: -0.2 },
    { t: "기록이 말해 줍니다.", w: {}, base: 0 },
  ] },
  { id: "r-pay", q: "연봉은 어떻게 되나요?", answers: [
    { t: "확실히 올려 드리겠습니다.", w: { greed: 1.2 }, base: 0.1 },
    { t: "동결하고 보너스를 늘리겠습니다.", w: { greed: -0.6, ambition: 0.5 }, base: -0.05 },
    { t: "팀 사정상 조금 줄여야 합니다.", w: { greed: -1.4 }, base: -0.3 },
    { t: "다년 계약으로 안정을 드리겠습니다.", w: { loyalty: 0.8 }, base: 0.05 },
  ] },
  { id: "r-team", q: "내년 팀 전력은 어떻게 되나요?", answers: [
    { t: "우승할 수 있게 보강합니다.", w: { ambition: 1.1 }, base: 0.1 },
    { t: "지금 멤버를 지킵니다.", w: { loyalty: 0.9 }, base: 0.05 },
    { t: "젊은 선수 위주로 갑니다.", w: { ambition: -0.7 }, base: -0.1 },
    { t: "아직 정해진 게 없습니다.", w: {}, base: -0.15 },
  ] },
];

export function interviewFor(p: Player, mode: NegMode, season: number): Question[] {
  const pool = mode === "renew" ? RENEW_Q : SIGN_Q;
  const order = [...pool].sort((a, b) => hashUnit(`${p.id}:${season}:${a.id}`) - hashUnit(`${p.id}:${season}:${b.id}`));
  return order.slice(0, 3).map((q) => ({
    ...q,
    answers: [...q.answers].sort((a, b) => hashUnit(`${p.id}:${q.id}:${a.t}`) - hashUnit(`${p.id}:${q.id}:${b.t}`)),
  }));
}

export function answerScore(p: Player, a: Question["answers"][number]): number {
  let v = a.base;
  for (const [k, w] of Object.entries(a.w)) v += (w ?? 0) * (p.persona[k as keyof Player["persona"]] - 0.45) * 1.2;
  return v;
}

export interface InterviewResult { good: number; bad: number; salaryMul: number; affinity: number; refused: boolean }

export function finishInterview(s: GameState, p: Player, qs: Question[], picks: number[], rng: Rng): InterviewResult {
  let mul = 1;
  let aff = 0;
  let good = 0, bad = 0;
  qs.forEach((q, i) => {
    const a = q.answers[picks[i]];
    const sc = answerScore(p, a);
    const mag = hashUnit(`${p.id}:${a.t}`);
    if (sc > 0.22) { good++; mul -= 0.03 + mag * 0.03; aff += 8 + mag * 8; }
    else if (sc < -0.22) { bad++; mul += 0.05 + mag * 0.05; aff -= 18 + mag * 12; }
    else { mul += -0.01 + mag * 0.03; aff += -3 + mag * 7; }
  });
  if (good === 3) mul -= 0.03;
  if (mul < 1) mul = 1 - Math.min(0.08, (1 - mul) / 2);
  const refuseP = bad ? Math.min(0.9, (1 - Math.pow(0.6, bad)) * ((p.affinity ?? 0) + aff < -10 ? 1.3 : 1)) : 0;
  const refused = bad > 0 && rng.chance(refuseP * 0.6);
  // A refusal leaves the interview to be held again once the lock ends; its affinity loss stays.
  p.interview = refused ? undefined : { salaryMul: mul, affinity: aff, done: true };
  p.affinity = clamp((p.affinity ?? 0) + aff, -100, 100);
  p.patience = 4 - bad;
  if (refused) p.lockUntil = s.day + 10;
  return { good, bad, salaryMul: mul, affinity: aff, refused };
}

export function startNegotiation(s: GameState, p: Player, mode: NegMode) {
  const t = s.teams[s.user];
  if (p.affinity === undefined) p.affinity = Math.round((teamAppeal(t, s) - 0.5) * 60 + (p.persona.loyalty - 0.5) * 10);
  if (p.patience === undefined) p.patience = 4;
  if (p.askSalary === undefined) p.askSalary = currentAsk(s, p, mode, 2);
}

/** Player's opening ask for a contract of `years` with the user's club. */
export function currentAsk(s: GameState, p: Player, mode: NegMode, years: number): number {
  let ask = salaryAsk(p, s.season);
  const star = ovr(p) >= 85;
  ask *= star ? [1, 1, 1.03, 1.08][years] ?? 1 : [1, 1.06, 1, 0.97][years] ?? 1;
  if (mode === "renew") ask *= p.morale >= 75 ? 0.93 : p.morale < 40 ? 1.2 : 1;
  ask *= p.interview?.salaryMul ?? 1;
  if (mode === "renew") ask *= eventAskMul(s, p); // broken promises, early or promised raises (core/events.ts)
  ask *= s.difficulty === "hard" ? 1.08 : s.difficulty === "easy" ? 0.92 : 1;
  return Math.max(6000, Math.round(ask / 100) * 100);
}

function reservation(s: GameState, p: Player, mode: NegMode, years: number, starter: boolean): number {
  const t = s.teams[s.user];
  const appeal = teamAppeal(t, s);
  let f = 0.88 + hashUnit(p.id + ":res") * 0.08 - (appeal - 0.5) * 0.15;
  if (starter) f -= 0.02 + p.persona.ambition * 0.04;
  f -= (p.affinity ?? 0) / 800;
  if (mode === "renew") f -= p.persona.loyalty * 0.06;
  return currentAsk(s, p, mode, years) * f;
}

export interface Offer { salary: number; years: number; bonus: number; starter: boolean }
export interface OfferReply { kind: "accept" | "counter" | "insult" | "walk" | "rival"; msg: string }

export function rivalsFor(s: GameState, pid: string): Bid[] {
  return s.bids.filter((b) => b.player === pid && b.team !== s.user);
}

/** The salary from the user's club that beats the best rival bid for a free agent (0 when none). */
function rivalNeedFor(s: GameState, p: Player, mode: NegMode): { need: number; team: string } {
  if (mode !== "sign") return { need: 0, team: "" };
  const appealMe = teamAppeal(s.teams[s.user], s);
  let need = 0;
  let team = "";
  for (const b of rivalsFor(s, p.id)) {
    const n = b.salary * (0.75 + teamAppeal(s.teams[b.team], s) * 0.5) / (0.75 + appealMe * 0.5);
    if (n > need) { need = n; team = b.team; }
  }
  return { need, team };
}

/**
 * The player's current ask for these terms. An ask given for other terms (years, starter promise) is carried
 * over by the ratio of the hidden floors, and it is never under the floor or the best rival bid as they stand
 * now, so paying the shown ask today is accepted whichever terms the user picks.
 */
export function askFor(s: GameState, p: Player, mode: NegMode, years: number, starter: boolean): number {
  const ask = currentAsk(s, p, mode, years);
  const res = reservation(s, p, mode, years, starter);
  // no ask yet: the opening ask, lifted to the floor when low affinity has pushed the floor above it
  if (p.askSalary === undefined) return Math.ceil(Math.max(res, rivalNeedFor(s, p, mode).need, ask) / 100) * 100;
  const t = p.askTerms ?? { years: 2, starter: false };
  const mapped = t.years === years && t.starter === starter ? p.askSalary : (p.askSalary * res) / reservation(s, p, mode, t.years, t.starter);
  return Math.ceil(Math.max(res, rivalNeedFor(s, p, mode).need, Math.min(ask, mapped)) / 100) * 100;
}

export function submitOffer(s: GameState, p: Player, mode: NegMode, o: Offer, rng: Rng): OfferReply {
  startNegotiation(s, p, mode);
  const eff = o.salary + (o.bonus / Math.max(1, o.years)) * 0.8;
  const ask = currentAsk(s, p, mode, o.years);
  // the last ask, carried over to these terms
  p.askSalary = askFor(s, p, mode, o.years, o.starter);
  p.askTerms = { years: o.years, starter: o.starter };
  const res = reservation(s, p, mode, o.years, o.starter);
  const { need: rivalNeed, team: rivalTeam } = rivalNeedFor(s, p, mode);
  if (eff >= res && eff >= rivalNeed) return { kind: "accept", msg: "좋습니다. 계약하겠습니다." };
  if (eff >= res && eff < rivalNeed) {
    p.patience = (p.patience ?? 4) - 1;
    if ((p.patience ?? 0) <= 0) {
      p.lockUntil = s.day + 7;
      p.patience = undefined;
      p.askSalary = undefined;
      p.askTerms = undefined;
      return { kind: "walk", msg: `${teamName(s, rivalTeam)} 쪽 조건이 더 좋아서 그쪽과 이야기하겠습니다. (7일간 협상 거부)` };
    }
    return { kind: "rival", msg: `${teamName(s, rivalTeam)}에서 더 좋은 조건을 받았습니다. (남은 인내심 ${p.patience})` };
  }
  const ratio = eff / ask;
  if (ratio < 0.7) {
    p.patience = (p.patience ?? 4) - 2;
    p.affinity = clamp((p.affinity ?? 0) - (ratio < 0.5 ? 30 : 18), -100, 100);
  } else {
    p.patience = (p.patience ?? 4) - 1;
    p.affinity = clamp((p.affinity ?? 0) - (ratio >= 0.9 ? 0 : 4), -100, 100);
  }
  if ((p.patience ?? 0) <= 0 || (p.affinity ?? 0) <= -60) {
    p.lockUntil = s.day + 7;
    p.patience = undefined;
    p.askSalary = undefined;
    p.askTerms = undefined;
    return { kind: "walk", msg: "더 이야기해도 의미가 없을 것 같습니다. (7일간 협상 거부)" };
  }
  // The counter is measured from the last one, so a better offer never raises it, and a lowball wins
  // no ground: the player keeps the last ask. It meets a fair offer halfway, keeps a margin over the
  // floor, and never drops under the floor as it stands after this reply's affinity loss nor under
  // what beats the best rival bid, so paying the counter the same day (same years and starter promise)
  // is always accepted.
  const resNow = reservation(s, p, mode, o.years, o.starter);
  const prevAsk = p.askSalary ?? ask;
  const step = ratio < 0.7 ? prevAsk : Math.max(resNow + (prevAsk - resNow) * 0.35, (prevAsk + eff) / 2);
  const newAsk = Math.max(resNow, rivalNeed, Math.min(prevAsk, step));
  p.askSalary = Math.ceil(newAsk / 100) * 100;
  if (ratio < 0.7) return { kind: "insult", msg: `이건 너무 낮습니다. (요구 ${money(p.askSalary)}, 인내심 ${p.patience})` };
  return { kind: "counter", msg: `${money(p.askSalary)} 정도면 생각해 보겠습니다. (인내심 ${p.patience})` };
}

export function canAfford(s: GameState, amount: number): boolean {
  return s.teams[s.user].cash >= amount;
}

export function completeUserSigning(s: GameState, p: Player, mode: NegMode, o: Offer, fee: number) {
  const t = s.teams[s.user];
  const fromTeam = p.team;
  if (fee > 0 && fromTeam) {
    spend(s, "이적료", fee);
    s.teams[fromTeam].cash += fee;
  }
  spend(s, "계약금", o.bonus);
  if (mode === "renew") {
    p.contract = { salary: o.salary, until: Math.max(p.contract?.until ?? s.season, s.season) + o.years, starterPromise: o.starter, signedDay: s.day };
    p.morale = clamp(p.morale + 8, 0, 100);
    p.interview = undefined;
    p.patience = undefined;
    p.askSalary = undefined;
    p.askTerms = undefined;
    p.history.push(`${s.season}: ${t.name} 재계약 (${o.years}년)`);
    addNews(s, { kind: "renew", title: `[오피셜] ${t.name}, '${p.name}'와 재계약`, body: `${o.years}년 계약. 연봉 ${money(o.salary)}.`, teams: [t.id], players: [p.id] });
    s.cutscenes.push({ kind: "renew", title: `${p.name} 재계약`, sub: `${o.years}년 · 연봉 ${money(o.salary)}`, player: p.id, team: t.id });
    return;
  }
  joinTeam(s, p, t.id, o.salary, o.years, o.starter);
  p.morale = clamp(65 + (p.affinity ?? 0) / 5, 30, 95);
  const feeText = fee > 0 ? ` 이적료 ${money(fee)}.` : "";
  addNews(s, {
    kind: "sign",
    title: `[오피셜] ${t.name}, ${fromTeam ? teamName(s, fromTeam) + "의 " : ""}'${p.name}' 영입`,
    body: `${o.years}년 계약, 연봉 ${money(o.salary)}.${feeText}`,
    teams: [t.id, ...(fromTeam ? [fromTeam] : [])],
    players: [p.id],
  });
  s.cutscenes.push({ kind: "sign", title: `WELCOME ${p.name}`, sub: `${o.years}년 · 연봉 ${money(o.salary)}${fee ? " · 이적료 " + money(fee) : ""}`, player: p.id, team: t.id });
}

// ---------- club fee talks (player under contract at an AI club) ----------
export function clubDemand(s: GameState, p: Player): number {
  const t = p.team ? s.teams[p.team] : null;
  if (!t) return 0;
  let v = marketValue(p, s.season);
  const isStarter = Object.values(t.lineup).includes(p.id);
  if (isStarter) v *= 1.25;
  if (t.policy === "star" || t.policy === "win") v *= 1.15;
  if (t.policy === "budget") v *= 0.9;
  if (p.listed) v *= 0.85;
  const sameRole = t.roster.filter((id) => s.players[id]?.role === p.role).length;
  if (isStarter && sameRole <= 1) v *= 1.3; // no replacement in that role
  if (t.roster.length <= 5) v *= 1.2;
  v *= 1 + hashUnit(`${p.id}:${t.id}:${s.season}:fee`) * 0.15;
  return Math.max(2000, Math.round(v / 100) * 100);
}

export function feeReply(s: GameState, p: Player, fee: number, round: number): { ok: boolean; counter?: number; msg: string } {
  // The caller shows the club's name as the speaker, so messages do not repeat it.
  const demand = clubDemand(s, p);
  if (fee >= demand) return { ok: true, msg: `좋습니다. 이적료 ${money(fee)}에 합의합니다. 이제 선수와 협상하세요.` };
  if (round >= 3) return { ok: false, msg: "더 이상 이야기할 게 없습니다." };
  if (fee >= demand * 0.78) {
    // The counter is a price the club will take: never below its demand, firmer the lower the offer.
    // Rounded up to the fee slider's 500 step so the slider can show it exactly.
    const counter = Math.ceil((demand + (demand - fee) * 0.25) / 500) * 500;
    // money() always ends in 억 or 만, so the particle is 이라면.
    return { ok: false, counter, msg: `${money(counter)}이라면 보내 드리겠습니다.` };
  }
  return { ok: false, msg: "그 금액으로는 안 됩니다. 핵심 선수입니다." };
}

export const FEE_ROUNDS = 3;
/** Days after the first offer before a club that ran out of rounds will talk again. */
export const FEE_RESET_DAYS = 14;

/**
 * The user's fee talks for a player, kept on the player so they survive closing the window and reloading.
 * They belong to his current club and season; an agreement holds for that season, unused rounds reset
 * FEE_RESET_DAYS after the first offer.
 */
export function feeTalk(s: GameState, p: Player): { rounds: number; counter?: number; agreed?: number; resetIn: number } {
  const ft = p.feeTalk;
  if (!ft || ft.team !== p.team || ft.season !== s.season) return { rounds: 0, resetIn: 0 };
  if (ft.agreed !== undefined) return { rounds: ft.rounds, agreed: ft.agreed, resetIn: 0 };
  const resetIn = ft.start + FEE_RESET_DAYS - s.day;
  if (resetIn <= 0) return { rounds: 0, resetIn: 0 };
  return { rounds: ft.rounds, counter: ft.counter, resetIn };
}

/** Whether the user may send `fee` now: a round is left, or it pays the club's last counter. */
export function canOfferFee(s: GameState, p: Player, fee: number): boolean {
  const ft = feeTalk(s, p);
  if (ft.agreed !== undefined) return false;
  return ft.rounds < FEE_ROUNDS || (ft.counter !== undefined && fee >= ft.counter);
}

/** One fee offer from the user: the club's reply, recorded on the player. */
export function offerFee(s: GameState, p: Player, fee: number): { ok: boolean; counter?: number; msg: string } {
  const ft = feeTalk(s, p);
  if (ft.agreed !== undefined) return { ok: true, msg: `이미 이적료 ${money(ft.agreed)}에 합의했습니다.` };
  if (!canOfferFee(s, p, fee)) return { ok: false, msg: "더 이상 이야기할 게 없습니다." };
  // A counter is a promise: it stands even if his demand has risen since (training, a lineup change).
  const r = ft.counter !== undefined && fee >= ft.counter
    ? { ok: true, msg: `좋습니다. 이적료 ${money(fee)}에 합의합니다. 이제 선수와 협상하세요.` }
    : feeReply(s, p, fee, ft.rounds);
  const rec = ft.rounds > 0 && p.feeTalk ? p.feeTalk : { team: p.team!, season: s.season, start: s.day, rounds: 0 };
  rec.rounds = ft.rounds + 1;
  if (r.ok) rec.agreed = fee;
  else if (r.counter !== undefined) rec.counter = r.counter;
  p.feeTalk = rec;
  return r;
}

/** Loyal player at a winning club may refuse to talk at all. */
export function willTalk(s: GameState, p: Player): { ok: boolean; msg?: string } {
  if (p.retired) return { ok: false, msg: "은퇴한 선수입니다." };
  if (p.lockUntil && p.lockUntil > s.day) return { ok: false, msg: `협상 거부 중 (${p.lockUntil - s.day}일 남음)` };
  if (p.scandal) return { ok: false, msg: `${outLabel(p)} 중이라 협상할 수 없습니다.` };
  if (p.team && p.team !== s.user) {
    const t = s.teams[p.team];
    const mine = s.teams[s.user];
    const loyal = p.persona.loyalty > 0.75 && teamAppeal(t, s) >= teamAppeal(mine, s);
    if (loyal && !p.listed) return { ok: false, msg: `${t.name}에 남고 싶다고 합니다.` };
  }
  // ambitious stars do not consider clubs players rank low
  if (LOW_PREFERENCE.has(s.user) && ovr(p) >= 85 && p.persona.ambition > 0.6 && p.team !== s.user) {
    return { ok: false, msg: "우승을 노릴 수 있는 팀으로 가고 싶다며 협상을 거절했습니다. (선수 선호도가 낮은 구단)" };
  }
  return { ok: true };
}

// ---------- terminate / list / sell ----------
export function terminatePenalty(s: GameState, p: Player): number {
  if (!p.contract) return 0;
  return Math.round((p.contract.salary * contractYearsLeft(p, s.season) * 0.5) / 100) * 100;
}

export function terminateUser(s: GameState, p: Player) {
  const t = s.teams[s.user];
  const pen = terminatePenalty(s, p);
  spend(s, "위약금", pen);
  addNews(s, { kind: "release", title: `${t.name}, '${p.name}'와 계약 해지`, body: `위약금 ${money(pen)}.`, teams: [t.id], players: [p.id] });
  releasePlayer(s, p, "구단 결정");
}

export function acceptSale(s: GameState, offerId: string) {
  const o = s.saleOffers.find((x) => x.id === offerId);
  if (!o) return;
  const p = s.players[o.player];
  const buyer = s.teams[o.team];
  const me = s.teams[s.user];
  if (p.team !== s.user) return;
  earn(s, "선수 판매", o.fee);
  buyer.cash -= o.fee;
  const salary = Math.max(p.contract?.salary ?? 6000, salaryAsk(p, s.season));
  joinTeam(s, p, buyer.id, salary, 2);
  autoLineup(s, me);
  s.saleOffers = s.saleOffers.filter((x) => x.player !== p.id);
  addNews(s, { kind: "sign", title: `[오피셜] ${buyer.name}, ${me.name}에서 '${p.name}' 영입`, body: `이적료 ${money(o.fee)}.`, teams: [buyer.id, me.id], players: [p.id] });
}

// ---------- trades ----------
export function tradeValue(s: GameState, p: Player): number {
  const base = Math.max(marketValue(p, s.season), 3000 + Math.pow(Math.max(0, ovr(p) - 50), 2) * 40);
  const t = p.team ? s.teams[p.team] : null;
  const starter = t && Object.values(t.lineup).includes(p.id) ? 1.12 : 1;
  const potBonus = Math.max(0, p.pot - ovr(p)) * 600;
  return base * starter + potBonus;
}

export interface TradeVerdict { ratio: number; ok: boolean; msg: string }

export function judgeTrade(s: GameState, aiTeam: string, give: string[], get: string[], cash: number): TradeVerdict {
  const t = s.teams[aiTeam];
  let gain = 0;
  let loss = 0;
  const lostRoles = new Map<Role, number>();
  const gainRoles = new Map<Role, number>();
  for (const id of give) {
    const p = s.players[id];
    gain += tradeValue(s, p);
    gainRoles.set(p.role, (gainRoles.get(p.role) ?? 0) + 1);
  }
  for (const id of get) {
    const p = s.players[id];
    loss += tradeValue(s, p);
    if (Object.values(t.lineup).includes(id)) lostRoles.set(p.role, (lostRoles.get(p.role) ?? 0) + 1);
  }
  let fit = 1;
  for (const [r, n] of lostRoles) {
    const remaining = t.roster.filter((id) => !get.includes(id) && s.players[id]?.role === r).length;
    if (remaining + (gainRoles.get(r) ?? 0) < 1) fit -= 0.25 * n; // they would have nobody in that role
  }
  const ratio = (gain * fit + cash) / Math.max(1, loss * 1.1);
  const after = t.roster.length - get.length + give.length;
  if (after > ROSTER_MAX) return { ratio, ok: false, msg: `${t.name}: 로스터가 꽉 차서 받을 수 없습니다.` };
  if (after < 5) return { ratio, ok: false, msg: `${t.name}: 그러면 선수가 5명도 안 남습니다.` };
  if (ratio >= 1.02) return { ratio, ok: true, msg: `${t.name}: 좋습니다. 트레이드하죠.` };
  if (ratio >= 0.9) return { ratio, ok: false, msg: `${t.name}: 조금만 더 얹어 주시면 생각해 보겠습니다.` };
  if (ratio >= 0.7) return { ratio, ok: false, msg: `${t.name}: 우리한테 손해입니다.` };
  return { ratio, ok: false, msg: `${t.name}: 관심 없습니다.` };
}

export function executeTrade(s: GameState, aiTeam: string, give: string[], get: string[], cash: number) {
  const me = s.teams[s.user];
  const t = s.teams[aiTeam];
  const moves: [Player, string][] = [
    ...give.map((id) => [s.players[id], aiTeam] as [Player, string]),
    ...get.map((id) => [s.players[id], s.user] as [Player, string]),
  ];
  for (const [p, to] of moves) {
    const c = p.contract ?? { salary: salaryAsk(p, s.season), until: s.season + 1, signedDay: s.day };
    const years = Math.max(1, c.until - s.season + 1);
    joinTeam(s, p, to, c.salary, years);
    p.contract!.until = c.until;
  }
  teamCash(s, s.user, cash >= 0 ? "트레이드 현금" : "트레이드 현금", -cash);
  t.cash += cash;
  autoLineup(s, t);
  const names = (ids: string[]) => ids.map((id) => s.players[id].name).join(", ");
  addNews(s, {
    kind: "trade",
    title: `[트레이드] ${me.name} ↔ ${t.name}`,
    body: `${me.name}: ${names(get)} 영입 / ${t.name}: ${names(give)} 영입${cash ? ` / 현금 ${money(Math.abs(cash))} (${cash > 0 ? me.name : t.name} 지급)` : ""}`,
    teams: [me.id, t.id],
    players: [...give, ...get],
  });
  s.cutscenes.push({ kind: "trade", title: "트레이드 성사", sub: `${names(get)} 합류`, team: me.id, player: get[0] });
}

export function acceptTradeOffer(s: GameState, offer: TradeOffer) {
  const ok = offer.want.every((id) => s.players[id]?.team === s.user) && offer.give.every((id) => s.players[id]?.team === offer.from);
  s.tradeOffers = s.tradeOffers.filter((x) => x.id !== offer.id);
  if (!ok) return false;
  executeTrade(s, offer.from, offer.want, offer.give, -offer.cash);
  return true;
}

// ---------- staff ----------
export function staffAsk(st: Staff): number {
  const base = st.role === "Head Coach" ? 5000 + st.fame * 260 : st.role === "Analyst" ? 2500 + st.fame * 60 : 3000 + st.fame * 120;
  return Math.round(base / 100) * 100;
}

export function staffSlots(s: GameState, t: Team) {
  const list = t.staff.map((id) => s.staff[id]).filter(Boolean);
  return { hc: list.filter((x) => x.role === "Head Coach").length, others: list.filter((x) => x.role !== "Head Coach").length };
}

/** Sign a coach. `checkPrice` false: the salary was already agreed in talks (core/staffNeg.ts). */
export function hireStaffUser(s: GameState, st: Staff, salary: number, years: number, checkPrice = true): { ok: boolean; msg: string } {
  const t = s.teams[s.user];
  const slots = staffSlots(s, t);
  if (st.role === "Head Coach" && slots.hc >= 1) return { ok: false, msg: "감독은 한 명만 둘 수 있습니다. 먼저 현 감독과 계약을 해지하세요." };
  if (st.role !== "Head Coach" && slots.others >= 4) return { ok: false, msg: "코치진은 4명까지입니다." };
  const need = staffAsk(st) * (1.05 - teamAppeal(t, s) * 0.2);
  if (checkPrice && salary < need) return { ok: false, msg: `${st.name}: ${money(Math.round(need / 100) * 100)}은 받아야 합니다.` };
  if (st.team) {
    const old = s.teams[st.team];
    old.staff = old.staff.filter((x) => x !== st.id);
  }
  st.team = t.id;
  st.contract = { salary, until: s.season + years - 1, signedDay: s.day };
  t.staff.push(st.id);
  addNews(s, { kind: "sign", title: `[오피셜] ${t.name}, ${st.role === "Head Coach" ? "감독" : "코치"} '${st.name}' 선임`, teams: [t.id] });
  return { ok: true, msg: `${st.name} 선임 완료.` };
}

/** A coach leaves his club (contract over, or fired) and is a free agent again. */
export function releaseStaff(s: GameState, st: Staff) {
  const t = st.team ? s.teams[st.team] : null;
  if (t) t.staff = t.staff.filter((x) => x !== st.id);
  st.team = null;
  st.contract = null;
  // a head coach an old save had signed as a coach (game.ts oneStaffRecordPerPerson) is a head coach again
  if (st.ownRole) {
    st.role = st.ownRole;
    delete st.ownRole;
  }
}

export function fireStaffUser(s: GameState, st: Staff) {
  const t = s.teams[s.user];
  const pen = Math.round(((st.contract?.salary ?? 0) * 0.3) / 100) * 100;
  spend(s, "위약금", pen);
  releaseStaff(s, st);
  addNews(s, { kind: "release", title: `${t.name}, '${st.name}'와 결별`, body: `위약금 ${money(pen)}.`, teams: [t.id] });
}

// ---------- AI market ----------
function needRoles(s: GameState, t: Team): Role[] {
  const out: Role[] = [];
  for (const r of ROLES) if (!t.roster.some((id) => s.players[id]?.role === r)) out.push(r);
  return out;
}

function aiTargetScore(s: GameState, t: Team, p: Player, rng: Rng): number {
  const o = ovr(p);
  const a = age(p, s.season);
  let v = o;
  if (p.origin === "real") v += 2;
  switch (t.policy) {
    case "youth": v += (p.pot - o) * 0.6 + (a <= 21 ? 4 : 0); break;
    case "vet": v += a >= 24 ? 3 : -2; break;
    case "star": v += p.fame * 0.06; break;
    case "budget": v -= salaryAsk(p, s.season) / 4000; break;
    case "win": v += (o - 75) * 0.2; break;
  }
  return v + rng.range(0, 4);
}

function placeAiBid(s: GameState, t: Team, role: Role | null, rng: Rng, minOvr = 0): boolean {
  const cap = aiCapRoom(s, t);
  const cands = Object.values(s.players).filter((p) =>
    !p.team && !p.retired && !p.scandal && (role ? p.role === role : true) && ovr(p) >= minOvr &&
    !s.bids.some((b) => b.player === p.id && b.team === t.id) && p.origin !== "intl");
  const affordable = cands.filter((p) => salaryAsk(p, s.season) <= cap);
  const pool = affordable.length ? affordable : [];
  if (!pool.length) return false;
  const crowded = (p: Player) => s.bids.filter((b) => b.player === p.id).length;
  const scored = pool.map((p) => ({ p, v: aiTargetScore(s, t, p, rng) - (crowded(p) >= 2 ? 6 : 0) })).sort((a, b) => b.v - a.v);
  const target = scored[0].p;
  const ask = salaryAsk(target, s.season);
  const salary = Math.min(cap, Math.round((ask * rng.range(0.95, 1.22)) / 100) * 100);
  s.bids.push({ team: t.id, player: target.id, salary, years: rng.int(1, 3), fee: 0, due: s.day + rng.int(2, 6) });
  return true;
}

export function resolveBids(s: GameState, rng: Rng) {
  const due = s.bids.filter((b) => b.due <= s.day);
  const players = [...new Set(due.map((b) => b.player))];
  for (const pid of players) {
    const p = s.players[pid];
    if (!p || p.team) {
      s.bids = s.bids.filter((b) => b.player !== pid);
      continue;
    }
    const offers = s.bids.filter((b) => b.player === pid && b.team !== s.user);
    if (!offers.length) continue;
    const ranked = offers
      .map((b) => ({ b, v: b.salary * (0.7 + teamAppeal(s.teams[b.team], s) * 0.6) * rng.range(0.9, 1.1) }))
      .sort((x, y) => y.v - x.v).map((x) => x.b);
    // a full roster, or a payroll that grew since the bid (emergency signings, call-ups): that offer lapses and the
    // player takes the next one the same day
    const fits = (b: Bid) => {
      const tm = s.teams[b.team];
      return tm.roster.length < ROSTER_MAX && payroll(s, tm) + b.salary <= aiPayrollCap(tm);
    };
    const best = ranked.find(fits);
    const lapsed = new Set(ranked.slice(0, best ? ranked.indexOf(best) : ranked.length));
    if (lapsed.size) s.bids = s.bids.filter((b) => !lapsed.has(b));
    if (!best) continue;
    const t = s.teams[best.team];
    joinTeam(s, p, t.id, best.salary, best.years);
    p.morale = 70;
    addNews(s, { kind: "sign", title: `[오피셜] ${t.name}, '${p.name}' 영입`, body: `${p.origin === "gen" ? "신인 " : ""}${p.role} · ${best.years}년 계약 · 연봉 ${money(best.salary)}`, teams: [t.id], players: [p.id] });
  }
}

export function aiDailyMarket(s: GameState, rng: Rng) {
  const d = seasonDates(s.season);
  const open = windowOpen(s);
  const daysToCup = d.cup - s.day;
  for (const id of s.lck) {
    if (id === s.user) continue;
    const t = s.teams[id];
    // staff
    if (open && !t.staff.some((x) => s.staff[x]?.role === "Head Coach") && rng.chance(0.12)) aiHireStaff(s, t, "Head Coach", rng);
    if (open && t.staff.length < 3 && rng.chance(0.04)) aiHireStaff(s, t, "Coach", rng);
    if (!open && t.roster.length >= 5) continue;
    const need = needRoles(s, t);
    const pending = s.bids.filter((b) => b.team === t.id).length;
    if (need.length) {
      const urgency = daysToCup > 0 ? clamp(1 - daysToCup / 50, 0.05, 1) : 1;
      if (pending < need.length && rng.chance(0.08 + urgency * 0.4)) {
        const role = need.find((r) => !s.bids.some((b) => b.team === t.id && s.players[b.player]?.role === r)) ?? null;
        if (role) placeAiBid(s, t, role, rng);
      }
      continue;
    }
    if (!open) continue;
    // a sub or two
    if (t.roster.length < 7 && pending === 0 && rng.chance(0.03)) placeAiBid(s, t, rng.pick(ROLES), rng);
    // upgrade a weak starter
    if (pending === 0 && rng.chance(0.006)) {
      const weakest = ROLES.map((r) => ({ r, p: t.lineup[r] ? s.players[t.lineup[r]!] : null })).filter((x) => x.p)
        .sort((a, b) => ovr(a.p!) - ovr(b.p!))[0];
      if (weakest) placeAiBid(s, t, weakest.r, rng, ovr(weakest.p!) + 4);
    }
    // AI to AI transfer
    if (rng.chance(0.0025)) aiPoach(s, t, rng);
    // too many players: release the weakest sub
    if (t.roster.length > 8) {
      const starters = new Set(Object.values(t.lineup));
      const sub = t.roster.map((x) => s.players[x]).filter((p) => !starters.has(p.id)).sort((a, b) => ovr(a) - ovr(b))[0];
      if (sub) {
        addNews(s, { kind: "release", title: `${t.name}, '${sub.name}' 방출`, teams: [t.id], players: [sub.id] });
        releasePlayer(s, sub, "로스터 정리");
      }
    }
  }
  resolveBids(s, rng);
  if (open) {
    aiOffersToUser(s, rng);
    aiSaleOffers(s, rng);
    if (rng.chance(0.004)) tamperingNews(s, rng);
  }
  s.tradeOffers = s.tradeOffers.filter((o) => o.expires > s.day);
  s.saleOffers = s.saleOffers.filter((o) => o.expires > s.day);
}

function aiHireStaff(s: GameState, t: Team, role: Staff["role"], rng: Rng) {
  const pool = Object.values(s.staff).filter((x) => !x.team && (role === "Head Coach" ? x.role === "Head Coach" : x.role !== "Head Coach"));
  if (!pool.length) return;
  const pick = rng.weighted(pool, (x) => Math.pow(x.fame + 10, 1.5) * (x.fame > t.wealth * 20 + 20 ? 0.3 : 1));
  if (!pick) return;
  pick.team = t.id;
  pick.contract = { salary: staffAsk(pick), until: s.season + rng.int(0, 1), signedDay: s.day };
  t.staff.push(pick.id);
  addNews(s, { kind: "sign", title: `[오피셜] ${t.name}, ${role === "Head Coach" ? "감독" : "코치"} '${pick.name}' 선임`, teams: [t.id] });
}

function aiPoach(s: GameState, t: Team, rng: Rng) {
  const cap = aiCapRoom(s, t);
  const others = s.lck.filter((x) => x !== t.id && x !== s.user);
  const from = s.teams[rng.pick(others)];
  const cand = from.roster.map((x) => s.players[x]).filter((p) => p && !Object.values(from.lineup).includes(p.id) && ovr(p) > 70)
    .sort((a, b) => ovr(b) - ovr(a))[0];
  if (!cand || t.roster.length >= 8) return;
  const fee = clubDemand(s, cand);
  const sal = salaryAsk(cand, s.season);
  if (sal > cap || fee > t.cash + t.wealth * 20000) return;
  t.cash -= fee;
  from.cash += fee;
  joinTeam(s, cand, t.id, sal, rng.int(1, 3));
  addNews(s, { kind: "sign", title: `[오피셜] ${t.name}, ${from.name}에서 '${cand.name}' 영입`, body: `이적료 ${money(fee)}.`, teams: [t.id, from.id], players: [cand.id] });
}

function aiOffersToUser(s: GameState, rng: Rng) {
  const me = s.teams[s.user];
  if (me.roster.length < 5 || s.tradeOffers.length >= 3 || !rng.chance(0.012)) return;
  const others = s.lck.filter((x) => x !== s.user);
  const t = s.teams[rng.pick(others)];
  const want = me.roster.map((x) => s.players[x]).filter((p) => ovr(p) >= 68).sort(() => rng.next() - 0.5)[0];
  if (!want) return;
  const wantVal = tradeValue(s, want);
  const giveCands = t.roster.map((x) => s.players[x]).filter((p) => p.role === want.role || rng.chance(0.3))
    .sort((a, b) => Math.abs(tradeValue(s, a) - wantVal) - Math.abs(tradeValue(s, b) - wantVal));
  const give = giveCands[0];
  if (!give || t.roster.length <= 5) return;
  const diff = wantVal - tradeValue(s, give);
  const cash = clamp(Math.round((diff * rng.range(0.6, 1.0)) / 100) * 100, -20000, 60000);
  const offer: TradeOffer = { id: `to${s.day}-${t.id}-${want.id}`, from: t.id, give: [give.id], want: [want.id], cash: Math.max(0, cash), expires: s.day + 6 };
  s.tradeOffers.push(offer);
  inbox(s, `${t.name}가 트레이드를 제안했습니다: ${give.name} ↔ ${want.name}${offer.cash ? ` + ${money(offer.cash)}` : ""}`);
  pushAlert(s, { kind: "trade", ref: offer.id, title: `${t.name}의 트레이드 제안`, body: `${give.name}(${ovr(give)}) ↔ 우리 ${want.name}(${ovr(want)})${offer.cash ? `, 현금 ${money(offer.cash)} 추가` : ""}. ${offer.expires - s.day}일 안에 답해야 합니다.` });
}

function aiSaleOffers(s: GameState, rng: Rng) {
  const me = s.teams[s.user];
  for (const id of me.roster) {
    const p = s.players[id];
    if (!p.listed || !rng.chance(0.22)) continue;
    const buyers = s.lck.filter((x) => x !== s.user && s.teams[x].roster.length < 8);
    if (!buyers.length) continue;
    const b = rng.pick(buyers);
    const fee = Math.round((marketValue(p, s.season) * rng.range(0.7, 1.12)) / 100) * 100;
    if (fee <= 0) continue;
    s.saleOffers = s.saleOffers.filter((o) => !(o.player === p.id && o.team === b));
    s.saleOffers.push({ id: `so${s.day}-${b}-${p.id}`, team: b, player: p.id, fee, expires: s.day + 5 });
    inbox(s, `${s.teams[b].name}가 '${p.name}' 이적료로 ${money(fee)}을 제시했습니다.`);
    pushAlert(s, { kind: "sale", ref: `so${s.day}-${b}-${p.id}`, title: `${s.teams[b].name}의 이적료 제안`, body: `이적 목록의 ${p.name}에게 ${money(fee)}을 제시했습니다. (시장 가치 ${money(marketValue(p, s.season))}, 5일 안에 답해야 합니다)` });
  }
}

function tamperingNews(s: GameState, rng: Rng) {
  const ai = s.lck.filter((x) => x !== s.user);
  const t = s.teams[rng.pick(ai)];
  const victims = Object.values(s.players).filter((p) => p.team && p.team !== t.id && p.origin !== "intl" && ovr(p) >= 75);
  const p = victims.length ? rng.pick(victims) : null;
  if (!p) return;
  const fine = rng.int(3, 10) * 1000;
  t.cash -= fine;
  t.fame = clamp(t.fame - 3, 0, 100);
  addNews(s, {
    kind: "tamper",
    title: `[징계] ${t.name}, 계약 기간 중인 '${p.name}' 사전 접촉 확인`,
    body: `LCK 사무국이 ${t.name}에 제재금 ${money(fine)}을 부과했습니다. (게임 속 가상 사건)`,
    teams: [t.id, p.team!],
    players: [p.id],
  });
}

/** Queue a big pop-up for the player (trade offers, bids). Older notices of the same thing are replaced. */
export function pushAlert(s: GameState, a: { kind: "trade" | "sale" | "info"; title: string; body: string; ref?: string }) {
  if (!s.alerts) s.alerts = [];
  s.alerts = s.alerts.filter((x) => !(a.ref && x.ref === a.ref));
  s.alerts.push({ id: `al${s.day}-${s.alerts.length}-${a.ref ?? a.title}`, day: s.day, ...a });
  if (s.alerts.length > 8) s.alerts.splice(0, s.alerts.length - 8);
}

const REGION_NAT: Record<string, string> = { LPL: "CN", LEC: "EU", LCP: "TW", LTA: "US" };

/** A foreign club's stand-in for a role it just lost: a fictional local player near the club's strength. */
export function refillIntl(s: GameState, t: Team, role: Role) {
  s.genCount += 1;
  const strength = t.intlStrength ?? 75;
  const id = `intl:${t.id}:sub${s.genCount}`;
  const seed = hashUnit(id);
  const base = Math.round(strength - 5 + seed * 4);
  const p: Player = {
    id, name: `${t.short}${ROLE_KO[role]}${s.genCount % 100}`, realName: "", nat: REGION_NAT[t.region] ?? "XX", birthYear: s.season - 21,
    role, tier: 1, origin: "intl", team: t.id, contract: { salary: 0, until: 9999, signedDay: s.day },
    attrs: { laning: base, teamfight: base, macro: base, mechanics: base, consistency: base, pool: base }, ovrOffset: 0, pot: base,
    fame: 20, morale: 70, fatigue: 0, form: 0, mastery: {}, persona: { loyalty: 0.5, ambition: 0.5, greed: 0.5, temper: 0.5 }, unpaid: 0,
    train: "rest", xp: {}, season: emptyLine(), career: { ...emptyLine(), titles: [] }, history: [`${s.season}: ${t.name} 입단 (대체 선수)`], lastTeamName: null,
  };
  s.players[id] = p;
  t.roster.push(id);
}
