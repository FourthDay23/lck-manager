import { useState } from "preact/hooks";
import { S, store } from "../store";
import { Rng } from "../core/rng";
import { money } from "../core/format";
import { teamAppeal } from "../core/player";
import { staffAsk } from "../core/market";
import {
  STAFF_ROLE_KO, completeStaffHire, finishStaffInterview, staffAskFor, staffCurrentAsk, staffInterviewFor, staffTalk, staffTraitWord, submitStaffOffer,
  willTalkStaff,
} from "../core/staffNeg";
import type { StaffOffer } from "../core/staffNeg";
import { Bar, Modal, TeamLogo } from "./components";
import { autosave } from "./App";
import { monthlyWages } from "../core/ledger";
import { monthlyIncomePreview } from "../core/economy";
import { MoneyStepper } from "./Negotiation";
import { tutSpot } from "./Tutorial";

/** Talks to hire a head coach or coach: interview, then salary, years and bonus. */
export function StaffNegotiationModal({ sid }: { sid: string }) {
  const s = S();
  const st = s.staff[sid];
  const me = s.teams[s.user];
  const rng = new Rng(s.rng ^ s.day ^ (sid.length * 7919));
  const talk = staffTalk(s, st);
  const gate = willTalkStaff(s, st);
  const qs = staffInterviewFor(st, s.season);
  const [log, setLog] = useState<{ who: string; text: string }[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [picks, setPicks] = useState<number[]>([]);
  const baseAsk = staffCurrentAsk(s, st, 2);
  const [offer, setOffer] = useState<StaffOffer>({ salary: Math.round(((talk.ask ?? baseAsk) * 0.9) / 100) * 100, years: 2, bonus: 0 });
  const say = (who: string, text: string) => setLog((l) => [...l, { who, text }]);
  const step = !gate.ok ? "blocked" : !talk.interview ? "interview" : "offer";
  const role = STAFF_ROLE_KO[st.role];

  const answer = (i: number) => {
    const np = [...picks, i];
    setPicks(np);
    say("나", qs[qIdx].answers[i].t);
    if (np.length < qs.length) {
      setQIdx(qIdx + 1);
      return;
    }
    const res = finishStaffInterview(s, st, qs, np, rng);
    say(st.name, res.refused ? "생각해 봤는데, 이 팀과는 맞지 않는 것 같습니다." : res.good >= 2 ? "좋은 이야기 감사합니다. 조건 이야기해 보죠." : res.bad >= 2 ? "음... 조금 실망스럽네요." : "알겠습니다. 조건을 들어 볼게요.");
    if (!res.refused) {
      talk.ask = staffCurrentAsk(s, st, offer.years);
      talk.askYears = offer.years;
      // say the ask as the offer screen shows it (lifted to the floor if needed)
      say(st.name, `${offer.years}년이면 연봉 ${money(staffAskFor(s, st, offer.years))}을 원합니다.`);
    }
    autosave();
    store.bump();
  };
  const send = () => {
    if (offer.bonus > me.cash) return say("시스템", `계약금을 낼 자금이 부족합니다 (${money(me.cash)}).`);
    say("나", `연봉 ${money(offer.salary)} · ${offer.years}년 · 계약금 ${money(offer.bonus)}`);
    const r = submitStaffOffer(s, st, offer);
    say(st.name, r.msg);
    if (r.kind === "accept") {
      const h = completeStaffHire(s, st, offer);
      if (!h.ok) {
        say("시스템", h.msg);
        store.bump();
        return;
      }
      if (st.role === "Head Coach") tutSpot("coach");
      autosave();
      store.close();
      store.say(`${role} ${st.name} 선임: 지금 ${money(offer.bonus)} 지급, 매달 25일 급여 ${money(Math.round(offer.salary / 12))}`);
      return;
    }
    autosave();
    store.bump();
  };

  const appeal = teamAppeal(me, s);
  // the ask for the length on screen: a counter for another length is carried over
  const ask = staffAskFor(s, st, offer.years);
  const wages = monthlyWages(s);
  const income = Object.values(monthlyIncomePreview(s)).reduce((a, b) => a + b, 0);
  const monthlyAdd = Math.round(offer.salary / 12);
  return (
    <Modal>
      <h2>{role} 선임 협상</h2>
      <div class="row" style={{ alignItems: "flex-start", gap: 14 }}>
        <div class="col center" style={{ width: 130 }}>
          <div class="frame dark center" style={{ width: 90, height: 90, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>{st.name.slice(0, 1)}</div>
          <b>{st.name}</b>
          <div class="dim" style={{ fontSize: 11 }}>{st.realName}</div>
          <div><span class="tag gold">{role}</span></div>
          <div class="muted" style={{ fontSize: 11 }}>{st.lastTeamName ? <>전 {st.lastTeamName}</> : "FA"} · 명성 {st.fame} · 우승 {st.titles}</div>
          <div class="muted" style={{ fontSize: 11 }}>성향: {staffTraitWord(st)}</div>
          <div class="muted" style={{ fontSize: 11 }}>호감도</div>
          <div style={{ width: 110 }}><Bar v={talk.affinity + 100} max={200} color={talk.affinity >= 0 ? "#8ef0a8" : "#ff8a8a"} /></div>
          <div class="muted" style={{ fontSize: 11 }}>인내심 {"♥".repeat(Math.max(0, talk.patience))}</div>
          <div class="muted" style={{ fontSize: 11 }}><TeamLogo id={me.id} size={14} /> 우리 구단 매력 {Math.round(appeal * 100)}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div class="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            밴픽 {st.attrs.draft} · 육성 {st.attrs.develop} · 동기부여 {st.attrs.motivate} · 분석 {st.attrs.analysis}
          </div>
          <div class="feed" style={{ maxHeight: 180, marginBottom: 6 }}>
            {log.map((l) => <div><b class={l.who === "나" ? "gold" : ""}>{l.who}</b>: {l.text}</div>)}
          </div>
          {step === "blocked" && <div class="neg">{gate.msg}</div>}
          {step === "interview" && (
            <div class="frame dark pad">
              <h3>면담 ({qIdx + 1}/{qs.length})</h3>
              <div class="speech">{st.name}: "{qs[qIdx].q}"</div>
              {qs[qIdx].answers.map((a, i) => <button class="btn qbtn" onClick={() => answer(i)}>{a.t}</button>)}
              <div class="dim" style={{ fontSize: 11 }}>성향에 맞는 답일수록 요구액이 내려가고 호감도가 오릅니다. 답의 효과는 사람마다 고정입니다.</div>
            </div>
          )}
          {step === "offer" && (
            <div class="frame dark pad">
              <div>{role} 요구: <b class="gold">{money(ask)}</b>/년 <span class="muted">(시장 기준 {money(staffAsk(st))})</span></div>
              <div class="row" style={{ alignItems: "flex-start" }}>
                <span style={{ width: 60, paddingTop: 4 }}>연봉</span>
                <MoneyStepper value={offer.salary} min={2000} max={Math.max(4000, Math.round(ask * 1.6))} step={100} big={1000} onChange={(v) => setOffer({ ...offer, salary: v })}
                  presets={[{ label: "요구액", value: ask }, { label: "−5%", value: ask * 0.95 }, { label: "−10%", value: ask * 0.9 }]} />
              </div>
              <div class="row">
                <span style={{ width: 60 }}>기간</span>
                {[1, 2, 3].map((y) => <button class={`btn small ${offer.years === y ? "on" : ""}`} onClick={() => setOffer({ ...offer, years: y })}>{y}년</button>)}
              </div>
              <div class="row" style={{ alignItems: "flex-start" }}>
                <span style={{ width: 60, paddingTop: 4 }}>계약금</span>
                <MoneyStepper value={offer.bonus} min={0} max={Math.round(ask)} step={500} big={2500} onChange={(v) => setOffer({ ...offer, bonus: v })}
                  presets={[{ label: "없음", value: 0 }, { label: "연봉 10%", value: offer.salary * 0.1 }, { label: "25%", value: offer.salary * 0.25 }, { label: "50%", value: offer.salary * 0.5 }]} />
              </div>
              <div class="muted" style={{ fontSize: 11 }}>계약금은 연봉으로 환산해 '계약금/기간 × 0.8'만큼 쳐줍니다. 너무 낮게 부르면 인내심이 두 칸 깎입니다.</div>
              <div class="frame pad" style={{ marginTop: 6, background: "#121522" }}>
                <div class="row" style={{ justifyContent: "space-between" }}>
                  <span>계약하면 바로 나가는 돈</span>
                  <b class={offer.bonus > me.cash ? "neg" : ""}>{money(offer.bonus)}</b>
                </div>
                <div class="muted" style={{ fontSize: 11 }}>계약금 {money(offer.bonus)} · 현재 자금 {money(me.cash)} → {money(me.cash - offer.bonus)}</div>
                <div class="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
                  <span>매달 25일 급여</span>
                  <b class="neg">+{money(monthlyAdd)}</b>
                </div>
                <div class="muted" style={{ fontSize: 11 }}>
                  월 급여 합계 {money(wages)} → <span class={wages + monthlyAdd > income ? "neg" : ""}>{money(wages + monthlyAdd)}</span> · 월 고정 수입 {money(income)}
                </div>
              </div>
              <div class="row" style={{ marginTop: 6 }}>
                <button class="btn primary" onClick={send}>제안</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
