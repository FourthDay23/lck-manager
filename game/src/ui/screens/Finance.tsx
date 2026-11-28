import { useState } from "preact/hooks";
import { S, store } from "../../store";
import { FACILITY_INFO, GOODS, facilityCost, goodsDemand, monthlyExpensePreview, monthlyIncomePreview, startGoods, upgradeFacility } from "../../core/economy";
import type { GoodsKind, Team } from "../../core/types";
import { money } from "../../core/format";
import { ovr } from "../../core/player";
import { autosave } from "../App";
import { tutSpot } from "../Tutorial";
import { WinBonusPanel } from "../WinBonus";

export function FinanceScreen() {
  const s = S();
  const me = s.teams[s.user];
  const inc = monthlyIncomePreview(s);
  const exp = monthlyExpensePreview(s);
  const incT = Object.values(inc).reduce((a, b) => a + b, 0);
  const expT = Object.values(exp).reduce((a, b) => a + b, 0);
  const [kind, setKind] = useState<GoodsKind>("photocard");
  const [units, setUnits] = useState(2000);
  const [feat, setFeat] = useState<string>(me.roster[0] ?? "");
  const [msg, setMsg] = useState("");
  const g = GOODS[kind];
  const preview = { id: "p", kind, featured: g.needsPlayer ? feat : null, units, sold: 0, price: g.price, cost: 0, startDay: s.day, weeksLeft: 6, revenue: 0 };
  const est = [0, 1, 2, 3, 4, 5].reduce((a, i) => a + goodsDemand(s, { ...preview, weeksLeft: 6 - i }), 0);
  return (
    <div>
      <h1>재정 · 굿즈</h1>
      <div class="grid3">
        <div class="frame pad">
          <h2>자금</h2>
          <div style={{ fontSize: 22 }} class={me.cash < 0 ? "neg" : "gold"}>{money(me.cash)}</div>
          <div class="muted">월 수지 예상 <span class={incT - expT >= 0 ? "pos" : "neg"}>{money(incT - expT)}</span></div>
          <div class="muted" style={{ fontSize: 11 }}>자금이 모자라면 급여를 못 줍니다. 3개월 연속 밀리면 선수가 계약을 깨고 나가거나 연봉 삭감을 받아들입니다.</div>
        </div>
        <div class="frame pad">
          <h2>월 수입 (매월 1일)</h2>
          {Object.entries(inc).map(([k, v]) => <div class="row" style={{ justifyContent: "space-between" }}><span>{k}</span><span class="pos">{money(v)}</span></div>)}
          <div class="muted" style={{ fontSize: 11 }}>스폰서 금액은 시즌마다 명성과 우승 횟수로 다시 정해집니다. 승리 수당(아래 내역)과 상금, 굿즈는 따로 들어옵니다.</div>
        </div>
        <div class="frame pad">
          <h2>월 지출</h2>
          {Object.entries(exp).map(([k, v]) => <div class="row" style={{ justifyContent: "space-between" }}><span>{k}</span><span class="neg">{money(v)}</span></div>)}
          <div class="muted" style={{ fontSize: 11 }}>급여는 매월 25일, 시설 유지비는 1일에 나갑니다.</div>
        </div>
      </div>
      <WinBonusPanel />
      <div class="grid2">
        <div class="frame pad" data-tut="goods">
          <h2>굿즈 제작</h2>
          <div class="tabs">
            {(Object.keys(GOODS) as GoodsKind[]).map((k) => <button class={`btn small ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{GOODS[k].name}</button>)}
          </div>
          <div class="muted">{g.desc} · 개당 원가 {g.unitCost * 10000 >= 10000 ? money(g.unitCost) : `${Math.round(g.unitCost * 10000).toLocaleString()}원`} · 판매가 {money(g.price)}</div>
          {g.needsPlayer && (
            <div class="row">
              <span>대표 선수</span>
              <select value={feat} onChange={(e) => setFeat((e.target as HTMLSelectElement).value)}>
                {me.roster.map((id) => <option value={id}>{s.players[id].name} (명성 {s.players[id].fame}, OVR {ovr(s.players[id])})</option>)}
              </select>
            </div>
          )}
          <div class="row">
            <span>수량</span>
            {[500, 1000, 2000, 5000, 10000, 20000].map((n) => <button class={`btn small ${units === n ? "on" : ""}`} onClick={() => setUnits(n)}>{n.toLocaleString()}</button>)}
          </div>
          <div>제작비 <b>{money(Math.round(units * g.unitCost))}</b> · 6주 예상 판매 약 {Math.round(Math.min(units, est)).toLocaleString()}개 → 매출 약 {money(Math.round(Math.min(units, est) * g.price))}</div>
          <div class="dim" style={{ fontSize: 11 }}>예상치는 팬 수, 명성, 대표 선수 인기, 최근 성적으로 계산합니다. 성적이 떨어지면 덜 팔리고, 남은 재고는 손해입니다.</div>
          <button class="btn primary" onClick={() => { const r = startGoods(s, kind, units, g.needsPlayer ? feat : null); setMsg(r.msg); autosave(); store.bump(); if (r.ok) tutSpot("goods"); }}>제작</button>
          {msg && <span class="gold"> {msg}</span>}
          <h3 style={{ marginTop: 10 }}>판매 현황</h3>
          <table class="t">
            <tbody>
              {me.goods.slice(0, 8).map((r) => (
                <tr>
                  <td>{GOODS[r.kind].name}{r.featured ? ` · ${s.players[r.featured]?.name}` : ""}</td>
                  <td class="num">{r.sold.toLocaleString()}/{r.units.toLocaleString()}</td>
                  <td class="num">{money(r.revenue)}</td>
                  <td class="num muted">원가 {money(r.cost)}</td>
                  <td>{r.weeksLeft > 0 ? <span class="tag green">판매 중 {r.weeksLeft}주</span> : <span class="tag">종료</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="frame pad">
          <h2>시설</h2>
          {(Object.keys(FACILITY_INFO) as (keyof Team["facilities"])[]).map((k) => (
            <div class="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
              <div><b>{FACILITY_INFO[k].name}</b> <span class="gold">Lv{me.facilities[k]}</span><div class="muted" style={{ fontSize: 11 }}>{FACILITY_INFO[k].desc} · 유지비 레벨당 월 300만</div></div>
              <button class="btn small" disabled={me.facilities[k] >= 5} onClick={() => { const r = upgradeFacility(s, k); store.say(r.msg); autosave(); }}>
                {me.facilities[k] >= 5 ? "최대" : `업그레이드 ${money(facilityCost(me.facilities[k]))}`}
              </button>
            </div>
          ))}
          <h3 style={{ marginTop: 10 }}>월별 장부</h3>
          <table class="t">
            <thead><tr><th>월</th><th class="num">수입</th><th class="num" title="수입 가운데 승리 수당">승리 수당</th><th class="num">지출</th><th class="num">합계</th></tr></thead>
            <tbody>
              {s.ledger.slice(0, 12).map((l) => {
                const i = Object.values(l.income).reduce((a, b) => a + b, 0);
                const e = Object.values(l.expense).reduce((a, b) => a + b, 0);
                return (
                  <tr data-tip={[`${l.month} 내역`, ...Object.entries(l.income).map(([k, v]) => `+${k} ${money(v)}`), ...Object.entries(l.expense).map(([k, v]) => `-${k} ${money(v)}`)].join("\n")}>
                    <td>{l.month}</td><td class="num pos">{money(i)}</td><td class="num">{l.income["승리 수당"] ? <span class="pos">{money(l.income["승리 수당"])}</span> : <span class="dim">-</span>}</td><td class="num neg">{money(e)}</td><td class={`num ${i - e >= 0 ? "pos" : "neg"}`}>{money(i - e)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
