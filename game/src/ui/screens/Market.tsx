import { useState } from "preact/hooks";
import { S, store } from "../../store";
import { ROLES, ROLE_KO } from "../../data/types";
import type { Role } from "../../data/types";
import { age, marketValue, ovr, salaryAsk } from "../../core/player";
import { money, fmtShort } from "../../core/format";
import { acceptSale, acceptTradeOffer, rivalsFor, windowOpen } from "../../core/market";
import { Avatar, Ovr, PName, RoleTag, TeamLogo } from "../components";
import { autosave } from "../App";
import { tutLock } from "../Tutorial";

type Tab = "fa" | "all" | "cl" | "abroad" | "offers" | "bids";

export function MarketScreen() {
  const s = S();
  const initial = (store.screen.arg as Tab) ?? "fa";
  const [tab0, setTab] = useState<Tab>(initial);
  const [role0, setRole] = useState<Role | "">("");
  // the first-run tutorial holds the list on free-agent top laners while the player picks one
  const lock = tutLock();
  const tab: Tab = lock?.marketTab ?? tab0;
  const role: Role | "" = lock?.marketRole ?? role0;
  const [q, setQ] = useState("");
  const [minOvr, setMinOvr] = useState(0);
  const [sort, setSort] = useState<"ovr" | "ask" | "age" | "fame">("ovr");
  const open = windowOpen(s);
  let pool = Object.values(s.players).filter((p) => !p.retired && p.origin !== "intl" && p.team !== s.user);
  if (tab === "fa") pool = pool.filter((p) => !p.team);
  if (tab === "all") pool = pool.filter((p) => p.tier === 1 || p.origin === "real");
  if (tab === "cl") pool = pool.filter((p) => p.tier === 2);
  if (tab === "abroad") pool = pool.filter((p) => !!p.team && s.intl.includes(p.team));
  if (role) pool = pool.filter((p) => p.role === role);
  if (q) pool = pool.filter((p) => (p.name + p.realName).toLowerCase().includes(q.toLowerCase()));
  if (minOvr) pool = pool.filter((p) => ovr(p) >= minOvr);
  const key = (p: (typeof pool)[number]) => sort === "ovr" ? -ovr(p) : sort === "ask" ? salaryAsk(p, s.season) : sort === "age" ? age(p, s.season) : -p.fame;
  pool.sort((a, b) => key(a) - key(b));
  const myBids = s.bids.filter((b) => b.team !== s.user);
  return (
    <div>
      <h1>이적시장</h1>
      <div class="muted" style={{ marginBottom: 6 }}>
        {open ? "이적시장이 열려 있습니다. 계약 중인 선수도 구단과 이적료를 합의한 뒤 협상할 수 있습니다." : "이적시장이 닫혀 있습니다. FA 선수 영입과 재계약만 가능합니다."}
        {" "}다른 구단도 같은 선수에게 입찰합니다. 입찰 마감일이 되면 선수가 가장 좋은 조건을 고릅니다.
      </div>
      <div class="tabs">
        <button class={`btn small ${tab === "fa" ? "on" : ""}`} onClick={() => setTab("fa")}>FA 선수</button>
        <button class={`btn small ${tab === "all" ? "on" : ""}`} onClick={() => setTab("all")}>최근 2년 LCK 선수 전체</button>
        <button class={`btn small ${tab === "cl" ? "on" : ""}`} onClick={() => setTab("cl")}>LCK CL · 신인</button>
        <button class={`btn small ${tab === "abroad" ? "on" : ""}`} onClick={() => setTab("abroad")}>해외 리그의 LCK 출신</button>
        <button class={`btn small ${tab === "offers" ? "on" : ""}`} onClick={() => setTab("offers")}>받은 제안 ({s.tradeOffers.length + s.saleOffers.length})</button>
        <button class={`btn small ${tab === "bids" ? "on" : ""}`} onClick={() => setTab("bids")}>다른 구단 입찰 현황 ({myBids.length})</button>
      </div>
      {tab === "abroad" && <div class="muted" style={{ marginBottom: 6 }}>LCK·LCK CL에서 뛴 기록이 있고 지금 해외 팀과 계약된 선수입니다. 이적시장이 열려 있을 때 그 팀과 이적료를 맞춘 뒤 협상합니다. 선수가 빠진 해외 팀은 대체 선수를 채웁니다.</div>}
      {(tab === "fa" || tab === "all" || tab === "cl" || tab === "abroad") && (
        <div class="frame pad">
          <div class="row" style={{ marginBottom: 6 }}>
            <button class={`btn small ${role === "" ? "on" : ""}`} onClick={() => setRole("")}>전체</button>
            {ROLES.map((r) => <button class={`btn small ${role === r ? "on" : ""}`} onClick={() => setRole(r)}>{ROLE_KO[r]}</button>)}
            <input type="text" placeholder="이름 검색" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ width: 120 }} />
            <span class="muted">OVR ≥</span>
            <input type="number" value={minOvr} onInput={(e) => setMinOvr(Number((e.target as HTMLInputElement).value))} style={{ width: 56 }} />
            <span class="muted">정렬</span>
            <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as typeof sort)}>
              <option value="ovr">능력치</option><option value="ask">요구 연봉</option><option value="age">나이</option><option value="fame">명성</option>
            </select>
            <span class="muted">{pool.length}명</span>
          </div>
          <table class="t">
            <thead><tr><th>선수</th><th>포지션</th><th>소속</th><th class="num">OVR</th><th class="num">나이</th><th class="num">명성</th><th class="num">요구 연봉</th><th class="num">이적료(추정)</th><th>경쟁</th><th></th></tr></thead>
            <tbody>
              {pool.slice(0, 120).map((p) => {
                const rivals = rivalsFor(s, p.id);
                return (
                  <tr class="click" onClick={() => store.open("player", p.id)}>
                    <td><div class="row" style={{ gap: 6 }}><Avatar pid={p.id} size={22} /><PName pid={p.id} /><span class="dim" style={{ fontSize: 11 }}>{p.realName}</span>{p.origin === "gen" && <span class="tag">신인</span>}{p.listed && <span class="tag gold">판매 중</span>}</div></td>
                    <td><RoleTag r={p.role} /></td>
                    <td>{p.team ? <><TeamLogo id={p.team} size={16} /> {s.teams[p.team].short}{p.academy && " 2군"}</> : <span class="muted">FA · 전 {p.lastTeamName ?? "-"}</span>}</td>
                    <td class="num"><Ovr v={ovr(p)} /></td>
                    <td class="num">{age(p, s.season)}</td>
                    <td class="num">{p.fame}</td>
                    <td class="num">{money(salaryAsk(p, s.season))}</td>
                    <td class="num">{p.team ? money(marketValue(p, s.season)) : "-"}</td>
                    <td>{rivals.length ? <span class="tag red">{rivals.length}개 구단</span> : ""}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button class="btn small" disabled={(!!p.team && !open) || !!lock} onClick={() => store.open("nego", p.id, p.team ? "transfer" : "sign")}>협상</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tab === "offers" && (
        <div class="grid2">
          <div class="frame pad">
            <h2>트레이드 제안</h2>
            {!s.tradeOffers.length && <div class="muted">없음</div>}
            {s.tradeOffers.map((o) => (
              <div class="frame dark pad">
                <div class="row"><TeamLogo id={o.from} size={22} /> <b>{s.teams[o.from].name}</b> <span class="dim">~{fmtShort(o.expires)}</span></div>
                <div>받는 선수: {o.give.map((id) => <span><PName pid={id} /> <Ovr v={ovr(s.players[id])} /> </span>)}</div>
                <div>주는 선수: {o.want.map((id) => <span><PName pid={id} /> <Ovr v={ovr(s.players[id])} /> </span>)}</div>
                {o.cash > 0 && <div class="gold">추가로 받는 현금 {money(o.cash)}</div>}
                <div class="row">
                  <button class="btn small primary" onClick={() => { const ok = acceptTradeOffer(s, o); store.say(ok ? "트레이드 성사" : "조건이 바뀌어 무산됐습니다"); autosave(); store.bump(); }}>수락</button>
                  <button class="btn small" onClick={() => { s.tradeOffers = s.tradeOffers.filter((x) => x !== o); store.bump(); }}>거절</button>
                </div>
              </div>
            ))}
          </div>
          <div class="frame pad">
            <h2>이적료 제안 (이적 목록 선수)</h2>
            {!s.saleOffers.length && <div class="muted">없음. 선수 상세에서 '이적 목록에 올리기'를 하면 구단들이 이적료를 제시합니다.</div>}
            {s.saleOffers.map((o) => (
              <div class="row frame dark pad" style={{ justifyContent: "space-between" }}>
                <span><TeamLogo id={o.team} size={18} /> {s.teams[o.team].name} → <PName pid={o.player} /> <b class="gold">{money(o.fee)}</b> <span class="muted">(가치 {money(marketValue(s.players[o.player], s.season))})</span></span>
                <span>
                  <button class="btn small primary" onClick={() => { acceptSale(s, o.id); autosave(); store.bump(); }}>판매</button>
                  <button class="btn small" onClick={() => { s.saleOffers = s.saleOffers.filter((x) => x !== o); store.bump(); }}>거절</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === "bids" && (
        <div class="frame pad">
          <h2>진행 중인 입찰</h2>
          <table class="t">
            <thead><tr><th>구단</th><th>선수</th><th class="num">OVR</th><th class="num">제시 연봉</th><th class="num">기간</th><th>결정일</th></tr></thead>
            <tbody>
              {myBids.sort((a, b) => a.due - b.due).map((b) => (
                <tr>
                  <td><TeamLogo id={b.team} size={16} /> {s.teams[b.team].name}</td>
                  <td><PName pid={b.player} /></td>
                  <td class="num"><Ovr v={ovr(s.players[b.player])} /></td>
                  <td class="num">{money(b.salary)}</td>
                  <td class="num">{b.years}년</td>
                  <td>{fmtShort(b.due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
