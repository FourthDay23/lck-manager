// Tooltips of the top bar's 시즌 / 자금 / 월 급여 / 명성 · 팬 stats (shared bubble, ui/Tip.tsx). Read-only views of
// values core already keeps: the season calendar, the monthly ledger, the wage bill, fame and fans.
import { dayOfDate, dateOf, dayOfMonth, fmtDate, money, monthKey } from "../core/format";
import { monthlyExpensePreview, monthlyIncomePreview, sponsorFor } from "../core/economy";
import { nextUserSeries, phaseLabel } from "../core/game";
import { monthlyWages } from "../core/ledger";
import { appealWord, teamAppeal } from "../core/player";
import { seasonDates } from "../core/schedule";
import { COMP_NAME } from "../core/types";
import type { GameState } from "../core/types";
import { store } from "../store";
import { defineTip } from "./Tip";

const Row = ({ k, v, cls }: { k: string; v: string; cls?: string }) => (
  <span class="tip-row"><span>{k}</span><span class={cls}>{v}</span></span>
);

/** the next day the season phase label changes, and the label from then (the season rolls over on its end day) */
function nextPhase(s: GameState): { day: number; label: string } | null {
  const now = phaseLabel(s);
  let season = s.season;
  for (let k = 1; k <= 400; k++) {
    const day = s.day + k;
    while (day > seasonDates(season).end) season++;
    const label = phaseLabel({ ...s, season, day } as GameState);
    if (label !== now) return { day, label };
  }
  return null;
}

defineTip("season", () => {
  const s = store.s;
  if (!s) return null;
  const nx = nextPhase(s);
  const game = nextUserSeries(s);
  const opp = game ? s.teams[game.a === s.user ? game.b! : game.a!]?.name ?? "미정" : "";
  const days = (d: number) => (d - s.day === 0 ? "오늘" : `${d - s.day}일 뒤`);
  return {
    body: (
      <>
        <span class="tip-main">{s.season} 시즌 · <b>{phaseLabel(s)}</b></span>
        {nx && (
          <>
            <span class="tip-sec">다음 단계: {nx.label}</span>
            <span class="tip-row"><span>{fmtDate(nx.day, false)}</span><span>{days(nx.day)}</span></span>
          </>
        )}
        <span class="tip-sec">다음 경기{game ? `: vs ${opp}` : ""}</span>
        {game ? (
          <>
            <span class="tip-row"><span>{fmtDate(game.day, false)}</span><span>{days(game.day)}</span></span>
            <span class="tip-sub">{COMP_NAME[game.comp]} · Bo{game.bo}</span>
          </>
        ) : <span class="tip-sub">잡힌 경기가 없습니다</span>}
      </>
    ),
  };
});

const neg = (v: number) => (v ? `-${money(v)}` : money(0));
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
const top = (r: Record<string, number>, n: number) => Object.entries(r).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).slice(0, n);

/** the first of next month, and the coming 25th (today counts if wages have not been paid yet) */
function nextDays(s: GameState) {
  const d = dateOf(s.day);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  // the daily tick books a day's money as it leaves that day: on the 1st (and the 25th) it is still to come
  const first = dayOfMonth(s.day) === 1 ? s.day : dayOfDate(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1);
  const paidThisMonth = s.lastPayMonth === monthKey(s.day);
  const pay = dayOfMonth(s.day) < 25 || (dayOfMonth(s.day) === 25 && !paidThisMonth)
    ? dayOfDate(y, m, 25)
    : dayOfDate(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 25);
  return { first, pay };
}

defineTip("cash", () => {
  const s = store.s;
  if (!s) return null;
  const me = s.teams[s.user];
  const mk = monthKey(s.day);
  const cur = s.ledger.find((x) => x.month === mk);
  const prev = s.ledger.find((x) => x.month !== mk);
  const inc = cur ? sum(cur.income) : 0, exp = cur ? sum(cur.expense) : 0;
  const { first, pay } = nextDays(s);
  const nextIn = sum(monthlyIncomePreview(s)), wages = monthlyWages(s);
  const sign = (v: number) => (v > 0 ? "+" : "") + money(v);
  return {
    tone: me.cash < 0 ? "red" : "gold",
    body: (
      <>
        <span class="tip-main">자금 <b>{money(me.cash)}</b></span>
        {me.cash < 0 && <span class="tip-sub neg">자금이 마이너스인 채로 하루가 지나면 게임 오버입니다.</span>}
        <span class="tip-sec">이번 달 ({dateOf(s.day).getUTCMonth() + 1}월)</span>
        <Row k="수입" v={`+${money(inc)}`} cls="pos" />
        {cur && top(cur.income, 3).map(([k, v]) => <Row k={`· ${k}`} v={money(v)} />)}
        <Row k="지출" v={neg(exp)} cls={exp ? "neg" : undefined} />
        {cur && top(cur.expense, 3).map(([k, v]) => <Row k={`· ${k}`} v={money(v)} />)}
        {prev && <Row k={`지난달 (${Number(prev.month.slice(5))}월) 수지`} v={sign(sum(prev.income) - sum(prev.expense))} cls={sum(prev.income) >= sum(prev.expense) ? "pos" : "neg"} />}
        <span class="tip-sec">다가오는 돈</span>
        <Row k={`${fmtDate(first, false)} 수입`} v={`+${money(nextIn)}`} cls="pos" />
        <Row k={`${fmtDate(pay, false)} 급여`} v={`-${money(wages)}`} cls="neg" />
        <span class="tip-sub">자세한 내역은 재정 · 굿즈 화면</span>
      </>
    ),
  };
});

defineTip("wages", () => {
  const s = store.s;
  if (!s) return null;
  const me = s.teams[s.user];
  const ex = monthlyExpensePreview(s);
  const wages = monthlyWages(s);
  const { pay, first } = nextDays(s);
  const left = pay - s.day;
  const short = me.cash < wages;
  return {
    tone: short ? "red" : "gold",
    body: (
      <>
        <span class="tip-main">다음 지급 <b>{fmtDate(pay, false)}</b> {left === 0 ? "(오늘)" : `(${left}일 뒤)`}</span>
        <Row k="선수 연봉 ÷ 12" v={neg(ex["선수 연봉"])} />
        <Row k="스태프 연봉 ÷ 12" v={neg(ex["스태프 연봉"])} />
        <Row k="합계" v={`-${money(wages)}`} cls="neg" />
        <span class="tip-sub">매달 25일에 나갑니다. 2군 선수 연봉도 포함됩니다.</span>
        {ex["시설 유지비"] > 0 && <span class="tip-sub">시설 유지비 {money(ex["시설 유지비"])}은 {fmtDate(first, false)}에 따로 나갑니다.</span>}
        {short && <span class="tip-sub neg">지금 자금({money(me.cash)})으로는 급여를 다 줄 수 없습니다.</span>}
      </>
    ),
  };
});

defineTip("fame", () => {
  const s = store.s;
  if (!s) return null;
  const me = s.teams[s.user];
  const broadcast = monthlyIncomePreview(s)["방송·콘텐츠"];
  return {
    body: (
      <>
        <span class="tip-main">명성 <b>{Math.round(me.fame)}</b> / 100 · 팬 <b>{(me.fans / 10000).toFixed(1)}만</b></span>
        <span class="tip-sec">명성: 구단의 이름값</span>
        <span class="tip-sub">스폰서 금액(시즌마다 다시 정함, 지금 기준 월 {money(sponsorFor(me))})과 선수 영입 매력(지금 {appealWord(teamAppeal(me, s))}), 굿즈 판매를 올립니다.</span>
        <span class="tip-sub">↑ 시리즈 승리(토너먼트·국제전일수록 크게), 우승 · ↓ 토너먼트 패배, 논란 덮기, 사전 접촉 징계, 일부 이벤트</span>
        <span class="tip-sec">팬: 구단을 응원하는 사람 수</span>
        <span class="tip-sub">매달 방송 · 콘텐츠 수입(지금 월 {money(broadcast)})과 굿즈 수요가 팬 수에 비례합니다.</span>
        <span class="tip-sub">↑ 시리즈 승리(질 때도 조금), 우승, 마케팅팀 시설 · ↓ 논란 덮기, 일부 이벤트</span>
      </>
    ),
  };
});
