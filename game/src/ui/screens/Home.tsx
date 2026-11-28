import { store, S } from "../../store";
import { fmtDate, money } from "../../core/format";
import { nextUserSeries, stageName } from "../../core/game";
import { standings, comp } from "../../core/schedule";
import { teamPower, seriesWinProb, gameWinProb, fatigueLoss, starterFatigue } from "../../core/quick";
import { COMP_NAME } from "../../core/types";
import { ROLES, ROLE_KO } from "../../data/types";
import { monthlyExpensePreview, monthlyIncomePreview, seriesWinBonus, winBonusLog } from "../../core/economy";
import { Avatar, ChampIcon, Ovr, PName, TeamLogo } from "../components";
import { ovr } from "../../core/player";
import { oddsWord } from "../../core/format";

export function HomeScreen() {
  const s = S();
  const me = s.teams[s.user];
  const next = nextUserSeries(s);
  const opp = next ? (next.a === s.user ? next.b : next.a) : null;
  const inc = Object.values(monthlyIncomePreview(s)).reduce((a, b) => a + b, 0);
  const exp = Object.values(monthlyExpensePreview(s)).reduce((a, b) => a + b, 0);
  const hc = me.staff.map((id) => s.staff[id]).find((x) => x?.role === "Head Coach");
  const bonusLog = winBonusLog(s);
  const todo: string[] = [];
  if (me.cash < 0) {
    todo.push(s.debtGrace !== undefined && s.day <= s.debtGrace
      ? `자금이 마이너스입니다. ${fmtDate(s.debtGrace, false)}까지 플러스로 만들지 못하면 게임 오버입니다`
      : "자금이 마이너스입니다. 오늘 안에 플러스로 만들지 못하면 하루가 지날 때 게임 오버입니다");
  }
  for (const r of ROLES) if (!me.lineup[r]) todo.push(`${ROLE_KO[r]} 주전이 없습니다`);
  if (!hc) todo.push("감독이 없습니다 (밴픽 추천과 경기력에 불리)");
  if (me.roster.length < 6) todo.push("후보 선수가 없습니다");
  const live = ["CUP", "REG", "REG2"].map((c) => comp(s, c as "CUP")).find((c) => c && !c.done && s.day >= c.start - 30);
  const table = live ? standings(s, live.id === "REG2" ? ["REG", "REG2"] : [live.id]) : [];
  const pGame = opp ? gameWinProb(s, s.user, opp) : 0;
  // fatigue warning: any starter at 75+ or the five averaging 60+
  const starters = ROLES.map((r) => me.lineup[r]).filter(Boolean).map((id) => s.players[id!]).filter(Boolean);
  const avgFat = starterFatigue(s, s.user);
  const spent = starters.filter((p) => p.fatigue >= 75);
  const fatWarn = spent.length > 0 || avgFat >= 60;
  return (
    <div>
      <div class="row" style={{ justifyContent: "space-between" }}>
        <h1>홈</h1>
        <span class="muted">{fmtDate(s.day)}</span>
      </div>
      {fatWarn && (
        <div class="frame pad" style={{ boxShadow: "0 0 0 2px #6e2630" }}>
          <h2 style={{ color: "var(--red)" }}>주전 피로 경고</h2>
          <div>
            주전 평균 피로 {Math.round(avgFat)} · 경기력 {fatigueLoss(avgFat) > 0 ? `−${fatigueLoss(avgFat).toFixed(1)}` : "영향 없음"}
            {spent.length > 0 && <> · 한계(75 이상): {spent.map((p) => `${p.name} ${Math.round(p.fatigue)}`).join(", ")}</>}
          </div>
          <div class="muted" style={{ fontSize: 12 }}>훈련 강도를 낮추거나, 지친 선수를 휴식으로 돌리거나, 자동 휴식을 켜면 회복됩니다.</div>
          <button class="btn small" style={{ marginTop: 6 }} onClick={() => store.go("roster")}>선수단에서 피로 관리</button>
        </div>
      )}
      {todo.length > 0 && (
        <div class="frame pad" style={{ boxShadow: "0 0 0 2px #6e4a14" }}>
          <h2 style={{ color: "var(--warn)" }}>할 일</h2>
          {todo.map((t) => <div>· {t}</div>)}
          <div class="row" style={{ marginTop: 6 }}>
            <button class="btn small" data-tut="todo-market" onClick={() => store.go("market")}>이적시장</button>
            <button class="btn small" onClick={() => store.go("staff")}>감독 · 코치진</button>
          </div>
        </div>
      )}
      <div class="grid2">
        <div class="frame pad">
          <h2>다음 경기</h2>
          {next && opp ? (
            <div class="row" style={{ justifyContent: "space-between" }}>
              <div class="col center"><TeamLogo id={s.user} size={56} /><b>{me.name}</b><span class="muted">전력 {teamPower(s, s.user).toFixed(1)}</span></div>
              <div class="col center">
                <div class="muted">{COMP_NAME[next.comp]} · {stageName(next.stage)}</div>
                <div style={{ fontFamily: "Galmuri14", fontSize: 22 }}>VS</div>
                <div class="muted">{fmtDate(next.day, false)} · Bo{next.bo}</div>
                <div>예상 승률 {Math.round(seriesWinProb(pGame, next.bo) * 100)}% <span class="muted">({oddsWord(seriesWinProb(pGame, next.bo))})</span></div>
                <div class="muted" style={{ fontSize: 12 }}>이기면 승리 수당 <b class="gold">{money(seriesWinBonus(next))}</b></div>
              </div>
              <div class="col center"><TeamLogo id={opp} size={56} /><b>{s.teams[opp].name}</b><span class="muted">전력 {teamPower(s, opp).toFixed(1)}</span></div>
            </div>
          ) : <div class="muted">잡힌 경기가 없습니다.</div>}
        </div>
        <div class="frame pad">
          <h2>주전 라인업</h2>
          {ROLES.map((r) => {
            const pid = me.lineup[r];
            const p = pid ? s.players[pid] : null;
            const top = p ? Object.entries(p.mastery).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
            return (
              <div class="row" style={{ gap: 8, padding: "2px 0" }}>
                <span class="tag" style={{ width: 36 }}>{ROLE_KO[r]}</span>
                {p ? (
                  <>
                    <Avatar pid={p.id} size={24} />
                    <span style={{ width: 110 }}><PName pid={p.id} /></span>
                    <Ovr v={ovr(p)} />
                    {top.map(([c, m]) => <ChampIcon id={c} size={20} mastery={m} />)}
                    <span class="muted" style={{ fontSize: 11 }}>사기 {Math.round(p.morale)} · 피로 {Math.round(p.fatigue)}</span>
                  </>
                ) : <span class="neg">비어 있음</span>}
              </div>
            );
          })}
          <div class="muted" style={{ marginTop: 6 }}>감독: {hc ? hc.name : "없음"} · 팀 합 {Math.round(me.synergy)}</div>
        </div>
      </div>
      <div class="grid3">
        <div class="frame pad">
          <h2>재정</h2>
          <div>자금 <b class="gold">{money(me.cash)}</b></div>
          <div class="muted">월 수입 예상 {money(inc)} · 월 지출 예상 {money(exp)}</div>
          <div class={inc - exp >= 0 ? "pos" : "neg"}>월 수지 {money(inc - exp)}</div>
          {bonusLog.length > 0 && (
            <div style={{ marginTop: 4 }}>
              {s.season} 승리 수당 <b class="pos">+{money(bonusLog.reduce((a, x) => a + x.amount, 0))}</b> <span class="muted">(시리즈 {bonusLog.length}승 · 최근 {fmtDate(bonusLog[0].sr.day, false)} +{money(bonusLog[0].amount)})</span>
            </div>
          )}
          <div class="muted" style={{ fontSize: 11, marginTop: 4 }}>승리 수당, 상금, 굿즈 판매는 별도입니다. 25일에 급여가 나갑니다.</div>
        </div>
        <div class="frame pad">
          <h2>{live ? live.name : "순위"}</h2>
          <table class="t">
            <tbody>
              {table.map((r, i) => (
                <tr class={r.team === s.user ? "me" : ""}>
                  <td>{i + 1}</td>
                  <td><TeamLogo id={r.team} size={16} /> {s.teams[r.team].short}</td>
                  <td class="num">{r.w}-{r.l}</td>
                  <td class="num muted">{r.gw - r.gl >= 0 ? "+" : ""}{r.gw - r.gl}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!table.length && <div class="muted">시즌 개막 전</div>}
        </div>
        <div class="frame pad">
          <h2>알림</h2>
          {s.tradeOffers.length > 0 && <div class="gold">트레이드 제안 {s.tradeOffers.length}건 <button class="btn small" onClick={() => store.go("market", "offers")}>보기</button></div>}
          {s.saleOffers.length > 0 && <div class="gold">이적료 제안 {s.saleOffers.length}건 <button class="btn small" onClick={() => store.go("market", "offers")}>보기</button></div>}
          {s.inbox.slice(0, 6).map((m) => <div style={{ fontSize: 12, padding: "3px 0", borderBottom: "1px solid #222739" }}><span class="dim">{fmtDate(m.day, false)}</span> {m.text}</div>)}
        </div>
      </div>
      <div class="frame pad">
        <h2>최근 뉴스</h2>
        {s.news.slice(0, 7).map((n) => (
          <div class={`news-item ${n.mine ? "mine" : ""}`}>
            <span class="dim">{fmtDate(n.day, false)}</span> <span class="t">{n.title}</span>
            {n.body && <div class="muted" style={{ fontSize: 12 }}>{n.body}</div>}
          </div>
        ))}
        <button class="btn small" onClick={() => store.go("news")}>뉴스 전체</button>
      </div>
    </div>
  );
}
