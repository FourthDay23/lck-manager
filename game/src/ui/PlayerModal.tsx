import { S, D, store } from "../store";
import { ATTR_KEYS, ATTR_KO, ROLE_KO } from "../data/types";
import { age, marketValue, ovr, salaryAsk, traitWord } from "../core/player";
import { money } from "../core/format";
import { terminatePenalty, terminateUser, willTalk, windowOpen } from "../core/market";
import { Avatar, Bar, ChampIcon, Modal, Ovr, TeamLogo } from "./components";
import { potWord } from "./screens/Roster";
import { autosave } from "./App";
import { callUp, canCallUp } from "../core/academy";

export function PlayerModal({ pid }: { pid: string }) {
  const s = S();
  const d = D();
  const p = s.players[pid];
  if (!p) return null;
  const mine = p.team === s.user;
  const team = p.team ? s.teams[p.team] : null;
  const champs = Object.entries(p.mastery).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const me = s.teams[s.user];
  const analysis = Math.max(40, ...me.staff.map((id) => s.staff[id]?.attrs.analysis ?? 40));
  const talk = willTalk(s, p);
  const open = windowOpen(s);
  const expiring = p.contract && p.contract.until <= s.season;
  return (
    <Modal wide>
      <div class="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div class="col center" style={{ width: 150 }}>
          <Avatar pid={p.id} size={120} />
          <div style={{ fontFamily: "Galmuri14", fontSize: 20 }}>{p.name}</div>
          <div class="muted">{p.realName || ""}</div>
          <div><Ovr v={ovr(p)} /> <span class="tag">{ROLE_KO[p.role]}</span></div>
          <div class="muted" style={{ fontSize: 11 }}>{p.nat} · {age(p, s.season)}세 · {traitWord(p)}</div>
          {p.origin === "gen" && <span class="tag">가상 신인</span>}
          {p.origin === "intl" && <span class="tag blue">해외 리그</span>}
        </div>
        <div style={{ flex: 1 }}>
          <div class="row" style={{ justifyContent: "space-between" }}>
            <div class="row"><TeamLogo id={p.team} size={28} /> <b>{team ? team.name : "자유계약(FA)"}</b> {p.academy && <span class="tag gold">2군</span>} {p.tier === 2 && !p.academy && <span class="tag">LCK CL 출신</span>}</div>
            <div class="muted">명성 {p.fame} · 사기 {Math.round(p.morale)} · 피로 {Math.round(p.fatigue)} · 폼 {p.form >= 0 ? "+" : ""}{p.form.toFixed(1)}</div>
          </div>
          <div class="grid2" style={{ marginTop: 8 }}>
            <div class="frame dark pad">
              <h3>능력치</h3>
              {ATTR_KEYS.map((k) => (
                <div class="row" style={{ gap: 8 }}>
                  <span style={{ width: 56 }}>{ATTR_KO[k]}</span>
                  <div style={{ flex: 1 }}><Bar v={p.attrs[k]} color={p.attrs[k] >= 85 ? "#ffd36b" : p.attrs[k] >= 70 ? "#8ef0a8" : "#8ab8ff"} /></div>
                  <b style={{ width: 24, textAlign: "right" }}>{p.attrs[k]}</b>
                  {mine && <span class="dim" style={{ width: 32, fontSize: 10 }}>{Math.round(p.xp[k] ?? 0)}xp</span>}
                </div>
              ))}
              <div class="muted" style={{ marginTop: 4 }}>성장 여력: {potWord(p.pot - ovr(p), analysis, p.id)}</div>
            </div>
            <div class="frame dark pad">
              <h3>챔피언 숙련도</h3>
              <div class="row" style={{ gap: 6 }}>
                {champs.map(([c, m]) => (
                  <div class="col center" style={{ width: 46, gap: 0 }}>
                    <ChampIcon id={c} size={36} />
                    <span style={{ fontSize: 10 }}>{Math.round(m)}</span>
                  </div>
                ))}
                {!champs.length && <span class="muted">기록이 없습니다</span>}
              </div>
            </div>
          </div>
          <div class="grid2">
            <div class="frame dark pad">
              <h3>기록</h3>
              {p.stats?.kda !== undefined && <div class="muted" style={{ fontSize: 12 }}>2025-2026 실제 기록: 승률 {Math.round((p.stats.wr ?? 0) * 100)}% · KDA {p.stats.kda?.toFixed(2)} · 킬관여 {Math.round((p.stats.kp ?? 0) * 100)}% · 분당 딜 {Math.round(p.stats.dpm ?? 0)} · 분당 CS {(p.stats.cspm ?? 0).toFixed(1)}</div>}
              <div style={{ fontSize: 12 }}>이번 시즌: {p.season.g}세트 {p.season.w}승 · {p.season.k}/{p.season.d}/{p.season.a} · MVP {p.season.mvp}</div>
              <div style={{ fontSize: 12 }}>통산(게임 속): {p.career.g}세트 · 우승 {p.career.titles.length}회</div>
              {p.career.titles.slice(-5).map((t) => <div class="gold" style={{ fontSize: 11 }}>🏆 {t}</div>)}
              <div class="dim" style={{ fontSize: 11, marginTop: 4 }}>{p.history.slice(-4).join(" / ")}</div>
            </div>
            <div class="frame dark pad">
              <h3>계약 · 가치</h3>
              <div>계약: {p.contract ? `${money(p.contract.salary)}/년 · ${p.contract.until}년까지` : "없음"}</div>
              <div>예상 요구 연봉: {money(salaryAsk(p, s.season))}</div>
              <div>이적 시장 가치: {p.contract ? money(marketValue(p, s.season)) : "FA (이적료 없음)"}</div>
              {p.unpaid > 0 && <div class="neg">급여 체불 {p.unpaid}개월</div>}
              <div class="row" style={{ marginTop: 8 }}>
                {mine ? (
                  <>
                    {p.academy && <button class="btn small primary" disabled={!canCallUp(s, p).ok} title={canCallUp(s, p).msg} onClick={() => { callUp(s, p); autosave(); store.bump(); }}>1군 콜업</button>}
                    <button class="btn small primary" onClick={() => store.open("nego", p.id, "renew")} disabled={!talk.ok}>재계약 협상{expiring ? " (만료 예정)" : ""}</button>
                    <button class="btn small" onClick={() => { p.listed = !p.listed; autosave(); store.bump(); }}>{p.listed ? "이적 목록에서 내리기" : "이적 목록에 올리기"}</button>
                    <button class="btn small danger" onClick={() => {
                      if (!confirm(`${p.name}와 계약을 해지합니다. 위약금 ${money(terminatePenalty(s, p))}. 되돌릴 수 없습니다.`)) return;
                      terminateUser(s, p);
                      autosave();
                      store.close();
                    }}>계약 해지 ({money(terminatePenalty(s, p))})</button>
                  </>
                ) : p.origin !== "intl" && !p.retired ? (
                  <>
                    <button class="btn small primary" disabled={!talk.ok || (!open && !!p.team)} onClick={() => store.open("nego", p.id, p.team ? "transfer" : "sign")}>
                      {p.team ? "이적 협상" : "영입 협상"}
                    </button>
                    {p.team && <button class="btn small" disabled={!open} onClick={() => { store.close(); store.go("trade", `${p.team}:${p.id}`); }}>트레이드 제안</button>}
                  </>
                ) : null}
              </div>
              {!talk.ok && <div class="neg" style={{ fontSize: 12 }}>{talk.msg}</div>}
              {!open && p.team && !mine && <div class="muted" style={{ fontSize: 12 }}>이적시장이 닫혀 있습니다. FA 영입과 재계약은 언제든 됩니다.</div>}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
