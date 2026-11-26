import { useState } from "preact/hooks";
import { S, store } from "../../store";
import { fireStaffUser, staffAsk, staffSlots } from "../../core/market";
import { money } from "../../core/format";
import type { Staff } from "../../core/types";
import { TeamLogo } from "../components";
import { autosave } from "../App";

const ROLE_NAME: Record<Staff["role"], string> = { "Head Coach": "감독", Coach: "코치", "Strategic Coach": "전략 코치", Analyst: "분석관" };

function Attrs({ st }: { st: Staff }) {
  return (
    <span class="muted" style={{ fontSize: 11 }}>
      밴픽 {st.attrs.draft} · 육성 {st.attrs.develop} · 동기부여 {st.attrs.motivate} · 분석 {st.attrs.analysis}
    </span>
  );
}

export function StaffScreen() {
  const s = S();
  const me = s.teams[s.user];
  const [role, setRole] = useState<"all" | "hc" | "coach">("all");
  const mine = me.staff.map((id) => s.staff[id]).filter(Boolean);
  const slots = staffSlots(s, me);
  const pool = Object.values(s.staff).filter((x) => x.team !== s.user && (role === "all" || (role === "hc" ? x.role === "Head Coach" : x.role !== "Head Coach")))
    .sort((a, b) => (a.team ? 1 : 0) - (b.team ? 1 : 0) || b.fame - a.fame);
  const lockDays = (st: Staff) => (st.talk?.lockUntil && st.talk.lockUntil > s.day ? st.talk.lockUntil - s.day : 0);
  return (
    <div>
      <h1>감독 · 코치진</h1>
      <div class="muted" style={{ marginBottom: 8 }}>
        감독의 밴픽 능력은 밴픽 때 추천해 주는 챔피언 수(2~6개)와 정확도를 정합니다. 육성은 훈련 경험치, 분석은 상대 분석과 선수 잠재력 판단에 쓰입니다. 감독 1명 + 코치 4명까지.
      </div>
      <div class="frame pad">
        <h2>우리 코칭스태프 (감독 {slots.hc}/1 · 코치 {slots.others}/4)</h2>
        {!mine.length && <div class="neg">코칭스태프가 없습니다. 경기력과 밴픽 추천에 불리합니다.</div>}
        <table class="t">
          <tbody>
            {mine.map((st) => (
              <tr>
                <td><span class="tag gold">{ROLE_NAME[st.role]}</span></td>
                <td><b>{st.name}</b> <span class="dim">{st.realName}</span></td>
                <td><Attrs st={st} /></td>
                <td class="num">{money(st.contract?.salary ?? 0)}/년 · {st.contract?.until}년까지</td>
                <td class="right"><button class="btn small danger" onClick={() => { if (confirm(`${st.name}와 결별합니다. 위약금은 연봉의 30%입니다.`)) { fireStaffUser(s, st); autosave(); store.bump(); } }}>계약 해지</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="frame pad">
        <h2>감독 · 코치 목록</h2>
        <div class="tabs">
          <button class={`btn small ${role === "all" ? "on" : ""}`} onClick={() => setRole("all")}>전체</button>
          <button class={`btn small ${role === "hc" ? "on" : ""}`} onClick={() => setRole("hc")}>감독</button>
          <button class={`btn small ${role === "coach" ? "on" : ""}`} onClick={() => setRole("coach")}>코치</button>
        </div>
        <div class="muted" style={{ fontSize: 11 }}>선임은 선수 영입처럼 면담 3문항과 조건 협상을 거칩니다. 숨은 최저 연봉이 있고, 너무 낮게 부르면 인내심이 떨어져 협상을 거부합니다.</div>
        <table class="t">
          <thead><tr><th>역할</th><th>이름</th><th>소속</th><th>능력</th><th class="num">명성</th><th class="num">우승</th><th class="num">요구 연봉</th><th></th></tr></thead>
          <tbody>
            {pool.map((st) => (
                <tr>
                  <td><span class="tag">{ROLE_NAME[st.role]}</span></td>
                  <td><b>{st.name}</b> <span class="dim">{st.realName}</span></td>
                  <td>{st.team ? <><TeamLogo id={st.team} size={16} /> {s.teams[st.team]?.short}</> : <span class="muted">FA · 전 {st.lastTeamName ?? "-"}</span>}</td>
                  <td><Attrs st={st} /></td>
                  <td class="num">{st.fame}</td>
                  <td class="num">{st.titles}</td>
                  <td class="num">{money(staffAsk(st))}</td>
                  <td class="right">
                    {!st.team && (lockDays(st)
                      ? <span class="muted" style={{ fontSize: 11 }}>협상 거부 {lockDays(st)}일</span>
                      : <button class="btn small" onClick={() => store.open("staffnego", st.id)}>선임 협상</button>)}
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
