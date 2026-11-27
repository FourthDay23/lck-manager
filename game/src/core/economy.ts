// Money for the user's club: monthly income on the 1st, salaries on the 25th, goods, facilities.
import { dayOfMonth, money, monthKey } from "./format";
import { addNews, inbox } from "./news";
import { ovr } from "./player";
import { clamp, Rng } from "./rng";
import { releasePlayer, autoLineup, pushAlert } from "./market";
import type { CompId, GameState, GoodsKind, GoodsRun, Player, Series, Team } from "./types";
import { earn, spend } from "./ledger";
import { goodsEventMul } from "./events";
export { earn, spend, ledger, monthlyWages } from "./ledger";

const DIFF_INCOME = { easy: 1.25, normal: 1, hard: 0.8 } as const;

/** Monthly sponsor money. Set at the start of each season from fame, results and brand. */
export function sponsorFor(t: Team): number {
  const titles = t.titles.lck + t.titles.msi * 1.5 + t.titles.worlds * 3;
  return Math.round(3000 + t.wealth * 1500 + t.fame * 45 + Math.min(4000, titles * 120));
}

export function monthlyIncomePreview(s: GameState): Record<string, number> {
  const t = s.teams[s.user];
  const mul = DIFF_INCOME[s.difficulty];
  return {
    스폰서: Math.round(t.sponsor * mul),
    "리그 분배금": Math.round(2000 * mul),
    "방송·콘텐츠": Math.round((t.fans / 1500) * (1 + t.facilities.marketing * 0.06) * mul),
  };
}

export function facilityUpkeep(t: Team): number {
  const f = t.facilities;
  return (f.training + f.housing + f.analysis + f.marketing) * 300;
}

export function facilityCost(level: number): number {
  return (level + 1) * 12000;
}

export function monthlyExpensePreview(s: GameState): Record<string, number> {
  const t = s.teams[s.user];
  let players = 0, staff = 0;
  for (const id of [...t.roster, ...(t.academy ?? [])]) players += (s.players[id]?.contract?.salary ?? 0) / 12;
  for (const id of t.staff) staff += (s.staff[id]?.contract?.salary ?? 0) / 12;
  return { "선수 연봉": Math.round(players), "스태프 연봉": Math.round(staff), "시설 유지비": facilityUpkeep(t) };
}

export function economyDay(s: GameState, rng: Rng) {
  const dom = dayOfMonth(s.day);
  if (dom === 1) {
    for (const [k, v] of Object.entries(monthlyIncomePreview(s))) earn(s, k, v);
    spend(s, "시설 유지비", facilityUpkeep(s.teams[s.user]));
  }
  if (dom === 18) paydayWarning(s);
  if (dom === 25 && s.lastPayMonth !== monthKey(s.day)) {
    s.lastPayMonth = monthKey(s.day);
    payday(s, rng);
  }
  goodsDay(s, rng);
}

/**
 * A week before payday: staff are always paid (players can go unpaid), so cash below the staff bill means the
 * day ends in the red on the 25th, and that is game over. Stops the clock with a notice.
 */
function paydayWarning(s: GameState) {
  const t = s.teams[s.user];
  const staffPay = t.staff.reduce((a, id) => a + Math.round((s.staff[id]?.contract?.salary ?? 0) / 12), 0);
  if (t.cash - staffPay >= 0) return;
  pushAlert(s, {
    kind: "info",
    title: "급여일에 자금이 마이너스가 됩니다",
    body: `25일에 스태프 연봉 ${money(staffPay)}이 나가면 자금(지금 ${money(t.cash)})이 마이너스가 됩니다. 자금이 마이너스인 채로 하루가 지나면 게임 오버입니다. 선수를 팔거나 계약을 정리해 그 전에 메우세요.`,
    ref: "payday-warning",
  });
}

/** Salaries. Players who go unpaid three months in a row either walk out or take a pay cut. */
function payday(s: GameState, rng: Rng) {
  const t = s.teams[s.user];
  const staff = t.staff.map((id) => s.staff[id]).filter(Boolean);
  for (const st of staff) {
    const amt = Math.round((st.contract?.salary ?? 0) / 12);
    spend(s, "스태프 연봉", amt);
  }
  const players = [...t.roster, ...(t.academy ?? [])].map((id) => s.players[id]).filter(Boolean).sort((a, b) => ovr(b) - ovr(a));
  const unpaid: Player[] = [];
  for (const p of players) {
    const amt = Math.round((p.contract?.salary ?? 0) / 12);
    if (t.cash >= amt) {
      spend(s, "선수 연봉", amt);
      p.unpaid = 0;
    } else {
      unpaid.push(p);
      p.unpaid += 1;
      p.morale = clamp(p.morale - 15, 0, 100);
    }
  }
  if (!unpaid.length) return;
  inbox(s, `월급을 다 주지 못했습니다: ${unpaid.map((p) => `${p.name}(${p.unpaid}개월째)`).join(", ")}`);
  addNews(s, { kind: "money", title: `${t.name}, 선수 ${unpaid.length}명 급여 미지급`, body: "재정 악화로 이번 달 급여가 밀렸습니다.", teams: [t.id] });
  for (const p of unpaid) {
    if (p.unpaid < 3) continue;
    const leaveP = clamp(0.35 + p.persona.ambition * 0.35 + p.persona.greed * 0.25 - p.persona.loyalty * 0.55 + (ovr(p) >= 80 ? 0.15 : 0), 0.05, 0.95);
    if (rng.chance(leaveP)) {
      addNews(s, { kind: "release", title: `'${p.name}', 3개월 임금 체불로 ${t.name}와 계약 해지`, body: "선수 측이 계약 해지를 통보했습니다. 자유계약 신분이 됩니다.", teams: [t.id], players: [p.id] });
      inbox(s, `${p.name}가 임금 체불로 계약을 해지하고 FA가 됐습니다.`);
      releasePlayer(s, p, "임금 체불");
      autoLineup(s, t);
    } else {
      const cut = rng.range(0.2, 0.32);
      if (p.contract) p.contract.salary = Math.max(6000, Math.round((p.contract.salary * (1 - cut)) / 100) * 100);
      p.unpaid = 0;
      addNews(s, { kind: "money", title: `'${p.name}', 연봉 ${Math.round(cut * 100)}% 삭감 받아들이고 잔류`, body: `밀린 급여 대신 삭감안에 합의했습니다. 새 연봉 ${money(p.contract?.salary ?? 0)}.`, teams: [t.id], players: [p.id] });
      inbox(s, `${p.name}가 연봉 삭감을 받아들이고 남기로 했습니다.`);
    }
  }
}

export const GOODS: Record<GoodsKind, { name: string; unitCost: number; price: number; appeal: number; needsPlayer: boolean; desc: string }> = {
  photocard: { name: "포토카드 팩", unitCost: 0.3, price: 1, appeal: 0.0035, needsPlayer: false, desc: "싸고 많이 팔립니다. 마진은 작습니다" },
  stick: { name: "응원봉", unitCost: 1.5, price: 4.5, appeal: 0.0012, needsPlayer: false, desc: "경기장 직관 팬 대상" },
  uniform: { name: "선수 유니폼", unitCost: 4, price: 9.9, appeal: 0.0007, needsPlayer: true, desc: "대표 선수 인기에 크게 좌우" },
  figure: { name: "한정판 피규어", unitCost: 7, price: 19, appeal: 0.00022, needsPlayer: true, desc: "스타 선수 전용. 위험하지만 크게 남습니다" },
};

export function startGoods(s: GameState, kind: GoodsKind, units: number, featured: string | null): { ok: boolean; msg: string } {
  const g = GOODS[kind];
  const t = s.teams[s.user];
  const cost = Math.round(units * g.unitCost);
  if (g.needsPlayer && !featured) return { ok: false, msg: "대표 선수를 골라 주세요." };
  if (t.cash < cost) return { ok: false, msg: `제작비 ${money(cost)}이 부족합니다.` };
  if (t.goods.filter((x) => x.weeksLeft > 0).length >= 3) return { ok: false, msg: "동시에 세 종류까지만 판매할 수 있습니다." };
  spend(s, "굿즈 제작", cost);
  const run: GoodsRun = { id: `g${s.day}-${kind}`, kind, featured, units, sold: 0, price: g.price, cost, startDay: s.day, weeksLeft: 6, revenue: 0 };
  t.goods.unshift(run);
  addNews(s, { kind: "info", title: `${t.name}, ${featured ? `'${s.players[featured]?.name}' ` : ""}${g.name} 출시`, teams: [t.id] });
  return { ok: true, msg: `${g.name} ${units.toLocaleString()}개 제작 (${money(cost)})` };
}

/** Weekly demand: fans x item appeal x featured star x recent form x marketing. */
export function goodsDemand(s: GameState, run: GoodsRun): number {
  const t = s.teams[s.user];
  const g = GOODS[run.kind];
  const star = run.featured ? s.players[run.featured] : null;
  const starMul = star ? 0.5 + (star.fame / 60) * (star.team === s.user ? 1 : 0.3) : 1;
  const recent = s.series.filter((x) => x.done && (x.a === t.id || x.b === t.id)).slice(-6);
  const wins = recent.filter((x) => x.winner === t.id).length;
  const formMul = 0.75 + (recent.length ? wins / recent.length : 0.5) * 0.6;
  const fade = [1.4, 1.15, 1, 0.85, 0.7, 0.55][6 - run.weeksLeft] ?? 0.5;
  return t.fans * g.appeal * starMul * formMul * (1 + t.facilities.marketing * 0.08) * (0.6 + t.fame / 120) * fade * goodsEventMul(s, run.featured);
}

function goodsDay(s: GameState, rng: Rng) {
  const t = s.teams[s.user];
  for (const run of t.goods) {
    if (run.weeksLeft <= 0) continue;
    if ((s.day - run.startDay) % 7 !== 6) continue;
    const want = Math.round(goodsDemand(s, run) * rng.range(0.8, 1.2));
    const sold = Math.min(run.units - run.sold, want);
    run.sold += sold;
    const rev = Math.round(sold * run.price);
    run.revenue += rev;
    earn(s, "굿즈 판매", rev);
    run.weeksLeft -= 1;
    if (run.weeksLeft === 0 || run.sold >= run.units) {
      run.weeksLeft = 0;
      inbox(s, `${GOODS[run.kind].name} 판매 종료: ${run.sold.toLocaleString()}/${run.units.toLocaleString()}개, 매출 ${money(run.revenue)} (제작비 ${money(run.cost)})`);
    }
  }
}

export function upgradeFacility(s: GameState, key: keyof Team["facilities"]): { ok: boolean; msg: string } {
  const t = s.teams[s.user];
  const lv = t.facilities[key];
  if (lv >= 5) return { ok: false, msg: "최대 레벨입니다." };
  const cost = facilityCost(lv);
  if (t.cash < cost) return { ok: false, msg: `${money(cost)}이 필요합니다.` };
  spend(s, "시설 투자", cost);
  t.facilities[key] = lv + 1;
  return { ok: true, msg: "업그레이드 완료" };
}

export const FACILITY_INFO: Record<keyof Team["facilities"], { name: string; desc: string }> = {
  training: { name: "연습실 장비", desc: "훈련 경험치 +10%/레벨" },
  housing: { name: "숙소", desc: "피로 회복 +12%/레벨" },
  analysis: { name: "분석실", desc: "밴픽 추천 정확도, 상대 분석 +" },
  marketing: { name: "마케팅팀", desc: "팬 증가, 굿즈 수요 +8%/레벨" },
};

/** International events: fans, fame and the win bonus count double. */
export const INTL_COMPS: readonly CompId[] = ["MSI", "WORLDS", "EWC"];

/** A bracket stage (playoffs, finals) rather than round robin or Swiss. */
function bigStage(stage: string): boolean {
  return stage !== "RR" && !stage.startsWith("SW");
}

/** 승리 수당 for winning one series (games won inside it pay nothing): 400만 round robin/Swiss, 1,200만 bracket, x2 abroad. */
export function winBonus(stage: string, intl: boolean): number {
  return (bigStage(stage) ? 1200 : 400) * (intl ? 2 : 1);
}

export function seriesWinBonus(sr: Pick<Series, "comp" | "stage">): number {
  return winBonus(sr.stage, INTL_COMPS.includes(sr.comp));
}

/** Why a series pays what it does, e.g. "정규 라운드", or "토너먼트 1,200만 · 국제 대회 ×2" where it doubles. */
export function winBonusRule(sr: Pick<Series, "comp" | "stage">): string {
  const big = bigStage(sr.stage);
  const kind = big ? "토너먼트" : sr.stage === "RR" ? "정규 라운드" : "스위스 라운드";
  return INTL_COMPS.includes(sr.comp) ? `${kind} ${money(big ? 1200 : 400)} · 국제 대회 ×2` : kind;
}

/** The user's series wins of a season with the 승리 수당 each one paid, newest first. */
export function winBonusLog(s: GameState, season = s.season): { sr: Series; amount: number }[] {
  return s.series
    .filter((x) => x.done && x.season === season && x.winner === s.user)
    .map((sr) => ({ sr, amount: sr.bonus ?? seriesWinBonus(sr) }))
    .sort((a, b) => b.sr.day - a.sr.day);
}

/** Results move fans, fame and win bonuses. Returns the 승리 수당 paid to the user's club (0 for anyone else). */
export function seriesRewards(s: GameState, teamId: string, won: boolean, stage: string, intl: boolean): number {
  const t = s.teams[teamId];
  const big = bigStage(stage);
  const fansGain = won ? (big ? 30000 : 9000) * (intl ? 2 : 1) : 2000;
  t.fans = Math.round(t.fans + fansGain * (1 + t.facilities.marketing * 0.08) * (teamId === s.user ? 1 : 0.8));
  t.fame = clamp(t.fame + (won ? (big ? 3 : 1) * (intl ? 2 : 1) : big ? -1 : 0) * 0.8, 0, 100);
  if (teamId !== s.user || !won) return 0;
  const bonus = winBonus(stage, intl);
  earn(s, "승리 수당", bonus);
  return bonus;
}
