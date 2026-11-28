// Hiring a head coach or coach through talks, like signing a player: a gate, a three-question
// interview, then salary/years/bonus offers with a hidden floor, counters and patience.
// The rules mirror the player talks in market.ts (finishInterview, reservation, submitOffer).
import { LOW_PREFERENCE, personaFor, teamAppeal } from "./player";
import { clamp, hashUnit, Rng } from "./rng";
import { money } from "./format";
import { spend } from "./ledger";
import { hireStaffUser, staffAsk, staffSlots } from "./market";
import type { Question } from "./market";
import type { GameState, Player, Staff, StaffTalk } from "./types";

type Persona = Player["persona"];

export const STAFF_ROLE_KO: Record<Staff["role"], string> = { "Head Coach": "감독", Coach: "코치", "Strategic Coach": "전략 코치", Analyst: "분석관" };

/** Fixed personality, from the id like a player's (prefixed so a coach never shares one with a player). */
export function staffPersona(st: Staff): Persona {
  return personaFor("staff:" + st.id);
}

export function staffTraitWord(st: Staff): string {
  const { loyalty, ambition, greed, temper } = staffPersona(st);
  const m = Math.max(loyalty, ambition, greed, temper);
  if (m < 0.6) return "무난함";
  if (m === loyalty) return "의리파";
  if (m === ambition) return "우승 욕심";
  if (m === greed) return "돈 중시";
  return "다혈질";
}

/** A star coach, who values a short deal like a star player. */
function isStar(st: Staff): boolean {
  return st.fame >= 80;
}

/** Talks state for this season: the interview and patience start over each season, affinity and a lock carry. */
export function staffTalk(s: GameState, st: Staff): StaffTalk {
  const t = st.talk;
  if (t && t.season === s.season) return t;
  const appeal = teamAppeal(s.teams[s.user], s);
  const start = Math.round((appeal - 0.5) * 60 + (staffPersona(st).loyalty - 0.5) * 10);
  st.talk = { season: s.season, affinity: t?.affinity ?? start, patience: 4, lockUntil: t?.lockUntil };
  return st.talk;
}

export function willTalkStaff(s: GameState, st: Staff): { ok: boolean; msg?: string } {
  if (st.team === s.user) return { ok: false, msg: "이미 우리 구단 소속입니다." };
  if (st.team) return { ok: false, msg: `${s.teams[st.team]?.name ?? st.team}와 계약 중입니다.` };
  const slots = staffSlots(s, s.teams[s.user]);
  if (st.role === "Head Coach" && slots.hc >= 1) return { ok: false, msg: "감독은 한 명만 둘 수 있습니다. 먼저 현 감독과 계약을 해지하세요." };
  if (st.role !== "Head Coach" && slots.others >= 4) return { ok: false, msg: "코치진은 4명까지입니다." };
  const lock = st.talk?.lockUntil;
  if (lock && lock > s.day) return { ok: false, msg: `협상 거부 중 (${lock - s.day}일 남음)` };
  // a famous, ambitious head coach wants a club that can win, like the star players
  if (st.role === "Head Coach" && LOW_PREFERENCE.has(s.user) && st.fame >= 80 && staffPersona(st).ambition > 0.6) {
    return { ok: false, msg: "우승을 노릴 수 있는 팀을 맡고 싶다며 협상을 거절했습니다. (선수 선호도가 낮은 구단)" };
  }
  return { ok: true };
}

// ---------- interview ----------
const STAFF_Q: Question[] = [
  { id: "s-power", q: "제게 어떤 권한을 주실 건가요?", answers: [
    { t: "밴픽과 선수 기용을 모두 맡기겠습니다.", w: { ambition: 1 }, base: 0.1 },
    { t: "중요한 결정은 단장과 상의해서 정합니다.", w: { loyalty: 0.5, ambition: -0.6 }, base: -0.05 },
    { t: "데이터 팀 의견을 우선합니다.", w: { temper: -0.8 }, base: -0.1 },
    { t: "상황에 따라 다르게 하겠습니다.", w: {}, base: -0.05 },
  ] },
  { id: "s-goal", q: "이번 시즌 목표는 뭔가요?", answers: [
    { t: "무조건 우승입니다.", w: { ambition: 1.2 }, base: 0.05 },
    { t: "플레이오프 진출이 1차 목표입니다.", w: {}, base: 0 },
    { t: "젊은 선수를 키우는 시즌입니다.", w: { ambition: -0.8, loyalty: 0.4 }, base: -0.05 },
    { t: "팬이 즐거워하는 팀을 만들고 싶습니다.", w: { temper: -0.5 }, base: 0 },
  ] },
  { id: "s-support", q: "지원은 어느 정도 해 주시나요?", answers: [
    { t: "분석 인력과 장비를 아낌없이 붙이겠습니다.", w: { ambition: 0.6, greed: 0.5 }, base: 0.1 },
    { t: "있는 자원으로 해 봅시다.", w: { greed: -1.1 }, base: -0.1 },
    { t: "성적에 따라 늘리겠습니다.", w: { ambition: 0.7 }, base: 0 },
    { t: "연봉으로 확실히 보상하겠습니다.", w: { greed: 1.1 }, base: 0.05 },
  ] },
  { id: "s-room", q: "선수단 분위기는 어떤가요?", answers: [
    { t: "베테랑이 중심을 잡고 있습니다.", w: { loyalty: 0.8 }, base: 0.05 },
    { t: "젊고 패기가 넘칩니다.", w: { temper: 0.8, ambition: 0.3 }, base: 0 },
    { t: "개성이 강한 선수가 많습니다.", w: { temper: -0.9 }, base: -0.05 },
    { t: "아직 하나로 뭉치지 못했습니다.", w: { ambition: 0.5, temper: -0.4 }, base: -0.1 },
  ] },
  { id: "s-slump", q: "성적이 나쁘면 어떻게 되나요?", answers: [
    { t: "시즌 끝까지 믿고 맡기겠습니다.", w: { loyalty: 1, temper: 0.3 }, base: 0.1 },
    { t: "시즌 중간에 평가하겠습니다.", w: { temper: -0.6 }, base: -0.05 },
    { t: "결과로 말해야 합니다.", w: { ambition: 0.8, greed: -0.3 }, base: -0.05 },
    { t: "함께 책임지겠습니다.", w: { loyalty: 0.7 }, base: 0.05 },
  ] },
  { id: "s-term", q: "계약 기간은 어떻게 생각하세요?", answers: [
    { t: "장기 계약으로 안정을 드리겠습니다.", w: { loyalty: 1, ambition: -0.3 }, base: 0.05 },
    { t: "1년씩 평가하겠습니다.", w: { greed: 0.5, loyalty: -0.8 }, base: -0.1 },
    { t: "성과에 따라 연장 옵션을 넣겠습니다.", w: { ambition: 0.6, greed: 0.4 }, base: 0 },
    { t: "원하시는 대로 맞추겠습니다.", w: {}, base: 0 },
  ] },
];

/** Three questions and their answer order, fixed per coach and season. */
export function staffInterviewFor(st: Staff, season: number): Question[] {
  const order = [...STAFF_Q].sort((a, b) => hashUnit(`staff:${st.id}:${season}:${a.id}`) - hashUnit(`staff:${st.id}:${season}:${b.id}`));
  return order.slice(0, 3).map((q) => ({
    ...q,
    answers: [...q.answers].sort((a, b) => hashUnit(`staff:${st.id}:${q.id}:${a.t}`) - hashUnit(`staff:${st.id}:${q.id}:${b.t}`)),
  }));
}

export function staffAnswerScore(st: Staff, a: Question["answers"][number]): number {
  const pr = staffPersona(st);
  let v = a.base;
  for (const [k, w] of Object.entries(a.w)) v += (w ?? 0) * (pr[k as keyof Persona] - 0.45) * 1.2;
  return v;
}

export interface StaffInterviewResult { good: number; bad: number; salaryMul: number; affinity: number; refused: boolean }

/** Same effects as a player's interview: ask multiplier, affinity, patience, and a chance to refuse (10-day lock). */
export function finishStaffInterview(s: GameState, st: Staff, qs: Question[], picks: number[], rng: Rng): StaffInterviewResult {
  const talk = staffTalk(s, st);
  let mul = 1;
  let aff = 0;
  let good = 0, bad = 0;
  qs.forEach((q, i) => {
    const a = q.answers[picks[i]];
    const sc = staffAnswerScore(st, a);
    const mag = hashUnit(`staff:${st.id}:${a.t}`);
    if (sc > 0.22) { good++; mul -= 0.03 + mag * 0.03; aff += 8 + mag * 8; }
    else if (sc < -0.22) { bad++; mul += 0.05 + mag * 0.05; aff -= 18 + mag * 12; }
    else { mul += -0.01 + mag * 0.03; aff += -3 + mag * 7; }
  });
  if (good === 3) mul -= 0.03;
  if (mul < 1) mul = 1 - Math.min(0.08, (1 - mul) / 2);
  const refuseP = bad ? Math.min(0.9, (1 - Math.pow(0.6, bad)) * (talk.affinity + aff < -10 ? 1.3 : 1)) : 0;
  const refused = bad > 0 && rng.chance(refuseP * 0.6);
  talk.affinity = clamp(talk.affinity + aff, -100, 100);
  talk.patience = 4 - bad;
  talk.ask = undefined;
  talk.askYears = undefined;
  // a refusal leaves the interview to be held again once the lock ends
  talk.interview = refused ? undefined : { salaryMul: mul };
  if (refused) talk.lockUntil = s.day + 10;
  return { good, bad, salaryMul: mul, affinity: aff, refused };
}

// ---------- offers ----------
/** The coach's ask for a deal of `years` with the user's club. */
export function staffCurrentAsk(s: GameState, st: Staff, years: number): number {
  let ask = staffAsk(st);
  ask *= isStar(st) ? [1, 1, 1, 1.03][years] ?? 1 : [1, 1.06, 1, 0.97][years] ?? 1;
  ask *= st.talk?.season === s.season ? st.talk.interview?.salaryMul ?? 1 : 1;
  ask *= s.difficulty === "hard" ? 1.08 : s.difficulty === "easy" ? 0.92 : 1;
  return Math.max(2000, Math.round(ask / 100) * 100);
}

/** The hidden lowest salary he accepts, like a player's: 88~96% of the ask, lower for an attractive club and good affinity. */
function staffReservation(s: GameState, st: Staff, years: number): number {
  const appeal = teamAppeal(s.teams[s.user], s);
  let f = 0.88 + hashUnit("staff:" + st.id + ":res") * 0.08 - (appeal - 0.5) * 0.15;
  f -= staffTalk(s, st).affinity / 800;
  return staffCurrentAsk(s, st, years) * f;
}

/**
 * The coach's current ask for `years`. An ask given for another length is carried over by the ratio of the
 * hidden floors and never sits under today's floor, so paying the shown ask today is accepted for any length.
 */
export function staffAskFor(s: GameState, st: Staff, years: number): number {
  const talk = staffTalk(s, st);
  const ask = staffCurrentAsk(s, st, years);
  const res = staffReservation(s, st, years);
  // no ask yet: the opening ask, lifted to the floor when low affinity has pushed the floor above it
  if (talk.ask === undefined) return Math.ceil(Math.max(res, ask) / 100) * 100;
  const from = talk.askYears ?? 2;
  const mapped = from === years ? talk.ask : (talk.ask * res) / staffReservation(s, st, from);
  return Math.ceil(Math.max(res, Math.min(ask, mapped)) / 100) * 100;
}

export interface StaffOffer { salary: number; years: number; bonus: number }
export interface StaffReply { kind: "accept" | "counter" | "insult" | "walk"; msg: string }

export function submitStaffOffer(s: GameState, st: Staff, o: StaffOffer): StaffReply {
  const talk = staffTalk(s, st);
  const eff = o.salary + (o.bonus / Math.max(1, o.years)) * 0.8;
  const ask = staffCurrentAsk(s, st, o.years);
  // the last ask, carried over to this length
  talk.ask = staffAskFor(s, st, o.years);
  talk.askYears = o.years;
  const res = staffReservation(s, st, o.years);
  if (eff >= res) return { kind: "accept", msg: "좋습니다. 함께하겠습니다." };
  const ratio = eff / ask;
  if (ratio < 0.7) {
    talk.patience -= 2;
    talk.affinity = clamp(talk.affinity - (ratio < 0.5 ? 30 : 18), -100, 100);
  } else {
    talk.patience -= 1;
    talk.affinity = clamp(talk.affinity - (ratio >= 0.9 ? 0 : 4), -100, 100);
  }
  if (talk.patience <= 0 || talk.affinity <= -60) {
    talk.lockUntil = s.day + 7;
    talk.patience = 4;
    talk.ask = undefined;
    talk.askYears = undefined;
    return { kind: "walk", msg: "더 이야기해도 의미가 없을 것 같습니다. (7일간 협상 거부)" };
  }
  // Same counter rule as a player's: never above the last counter, no ground for a lowball, a margin over
  // the floor as it stands after this reply's affinity loss, so paying it the same day (same years) is accepted.
  const resNow = staffReservation(s, st, o.years);
  const prevAsk = talk.ask ?? ask;
  const step = ratio < 0.7 ? prevAsk : Math.max(resNow + (prevAsk - resNow) * 0.35, (prevAsk + eff) / 2);
  talk.ask = Math.ceil(Math.max(resNow, Math.min(prevAsk, step)) / 100) * 100;
  if (ratio < 0.7) return { kind: "insult", msg: `이건 너무 낮습니다. (요구 ${money(talk.ask)}, 인내심 ${talk.patience})` };
  return { kind: "counter", msg: `${money(talk.ask)} 정도면 생각해 보겠습니다. (인내심 ${talk.patience})` };
}

/** After an accepted offer: pay the bonus, sign him, clear the talks (affinity stays) and queue the WELCOME cutscene. */
export function completeStaffHire(s: GameState, st: Staff, o: StaffOffer): { ok: boolean; msg: string } {
  const me = s.teams[s.user];
  if (o.bonus > me.cash) return { ok: false, msg: `계약금을 낼 자금이 부족합니다 (${money(me.cash)}).` };
  const r = hireStaffUser(s, st, o.salary, o.years, false);
  if (!r.ok) return r;
  if (o.bonus > 0) spend(s, "계약금", o.bonus);
  if (st.talk) st.talk = { season: st.talk.season, affinity: st.talk.affinity, patience: 4 };
  s.cutscenes.push({
    kind: "staff", title: `${STAFF_ROLE_KO[st.role]} ${st.name} 선임`,
    sub: `${o.years}년 · 연봉 ${money(o.salary)}${o.bonus > 0 ? " · 계약금 " + money(o.bonus) : ""}`, staff: st.id, team: me.id,
  });
  return r;
}
