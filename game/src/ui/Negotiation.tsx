import { useState } from "preact/hooks";
import { S, store } from "../store";
import { Rng } from "../core/rng";
import { money } from "../core/format";
import { ovr, salaryAsk, teamAppeal, traitWord, marketValue } from "../core/player";
import {
  FEE_ROUNDS, ROSTER_MAX, askFor, canOfferFee, clubDemand, completeUserSigning, currentAsk, feeTalk, finishInterview, interviewFor, offerFee, rivalsFor,
  startNegotiation, submitOffer, willTalk,
} from "../core/market";
import type { NegMode, Offer } from "../core/market";
import { Avatar, Bar, Modal, Ovr, TeamLogo } from "./components";
import { autosave } from "./App";
import { monthlyWages } from "../core/ledger";
import { monthlyIncomePreview } from "../core/economy";
import { ROLE_KO } from "../data/types";

/** What this contract costs now and every month, next to what the club earns. */
function CostBox({ upfront, fee, bonus, monthlyAdd }: { upfront: number; fee: number; bonus: number; monthlyAdd: number }) {
  const s = S();
  const me = s.teams[s.user];
  const wages = monthlyWages(s);
  const income = Object.values(monthlyIncomePreview(s)).reduce((a, b) => a + b, 0);
  const after = wages + monthlyAdd;
  return (
    <div class="frame pad" style={{ marginTop: 6, background: "#121522" }}>
      <div class="row" style={{ justifyContent: "space-between" }}>
        <span>계약하면 바로 나가는 돈</span>
        <b class={upfront > me.cash ? "neg" : ""}>{money(upfront)}</b>
      </div>
      <div class="muted" style={{ fontSize: 11 }}>이적료 {money(fee)} + 계약금 {money(bonus)} · 현재 자금 {money(me.cash)} → {money(me.cash - upfront)}</div>
      <div class="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
        <span>매달 25일 급여</span>
        <b class="neg">{monthlyAdd >= 0 ? "+" : ""}{money(monthlyAdd)}</b>
      </div>
      <div class="muted" style={{ fontSize: 11 }}>
        월 급여 합계 {money(wages)} → <span class={after > income ? "neg" : ""}>{money(after)}</span> · 월 고정 수입 {money(income)}
        {after > income && " (고정 수입보다 많습니다. 승리 수당·상금·굿즈로 메워야 합니다)"}
      </div>
    </div>
  );
}

export function NegotiationModal({ pid, mode }: { pid: string; mode: NegMode }) {
  const s = S();
  const p = s.players[pid];
  const me = s.teams[s.user];
  const rng = new Rng(s.rng ^ s.day ^ pid.length);
  const talk = willTalk(s, p);
  const needClub = mode === "transfer" && !!p.team && p.team !== s.user;
  // fee talks live on the player, so closing the window or reloading keeps rounds, counter and agreement
  const ft = feeTalk(s, p);
  const [fee, setFee] = useState(() => ft.counter ?? Math.round(marketValue(p, s.season) / 1000) * 1000);
  const [log, setLog] = useState<{ who: string; text: string }[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [picks, setPicks] = useState<number[]>([]);
  const qs = interviewFor(p, mode, s.season);
  startNegotiation(s, p, mode);
  const baseAsk = currentAsk(s, p, mode, 2);
  const [offer, setOffer] = useState<Offer>({ salary: Math.round((p.askSalary ?? baseAsk) * 0.9 / 100) * 100, years: 2, bonus: 0, starter: false });
  const agreed = ft.agreed;
  const say = (who: string, text: string) => setLog((l) => [...l, { who, text }]);
  const rivals = mode === "sign" ? rivalsFor(s, pid) : [];
  const step = !talk.ok ? "blocked" : needClub && agreed === undefined ? "club" : !p.interview?.done ? "interview" : "offer";
  const fromTeam = p.team ? s.teams[p.team] : null;

  const sendFee = () => {
    if (fee > me.cash) return say("시스템", `자금이 부족합니다 (${money(me.cash)}).`);
    const r = offerFee(s, p, fee);
    say("나", `이적료 ${money(fee)}을 제시했습니다.`);
    say(fromTeam!.name, r.msg);
    if (!r.ok && r.counter) setFee(r.counter);
    autosave();
    store.bump();
  };
  const answer = (i: number) => {
    const np = [...picks, i];
    setPicks(np);
    say("나", qs[qIdx].answers[i].t);
    if (np.length < qs.length) {
      setQIdx(qIdx + 1);
      return;
    }
    const res = finishInterview(s, p, qs, np, rng);
    say(p.name, res.refused ? "생각해 봤는데, 이 팀과는 맞지 않는 것 같습니다." : res.good >= 2 ? "좋은 이야기 감사합니다. 조건 이야기해 보죠." : res.bad >= 2 ? "음... 조금 실망스럽네요." : "알겠습니다. 조건을 들어 볼게요.");
    if (!res.refused) {
      p.askSalary = currentAsk(s, p, mode, offer.years);
      p.askTerms = { years: offer.years, starter: offer.starter };
      // say the ask as the offer screen shows it (lifted to the floor or a rival bid if needed)
      say(p.name, `${offer.years}년이면 연봉 ${money(askFor(s, p, mode, offer.years, offer.starter))}을 원합니다.`);
    }
    autosave();
    store.bump();
  };
  const send = () => {
    if (mode !== "renew" && me.roster.length >= ROSTER_MAX) return say("시스템", "로스터가 10명으로 가득 찼습니다.");
    const fee0 = agreed ?? 0;
    if (offer.bonus + fee0 > me.cash) return say("시스템", `계약금과 이적료를 낼 자금이 부족합니다 (${money(me.cash)}).`);
    say("나", `연봉 ${money(offer.salary)} · ${offer.years}년 · 계약금 ${money(offer.bonus)}${offer.starter ? " · 주전 보장" : ""}`);
    const r = submitOffer(s, p, mode, offer, rng);
    say(p.name, r.msg);
    if (r.kind === "accept") {
      completeUserSigning(s, p, mode, offer, fee0); // joinTeam clears p.feeTalk
      autosave();
      store.close();
      const now = offer.bonus + fee0;
      store.say(`${p.name} 계약: 지금 ${money(now)} 지급, 매달 25일 급여 ${money(Math.round(offer.salary / 12))}`);
      return;
    }
    autosave();
    store.bump();
  };
  const appeal = teamAppeal(me, s);
  // the ask for the terms on screen: a counter for other years or starter promise is carried over
  const ask = askFor(s, p, mode, offer.years, offer.starter);
  return (
    <Modal>
      <h2>{mode === "renew" ? "재계약 협상" : mode === "transfer" ? "이적 협상" : "FA 영입 협상"}</h2>
      <div class="row" style={{ alignItems: "flex-start", gap: 14 }}>
        <div class="col center" style={{ width: 130 }}>
          <Avatar pid={pid} size={90} />
          <b>{p.name}</b>
          <div><Ovr v={ovr(p)} /> <span class="tag">{ROLE_KO[p.role]}</span></div>
          <div class="muted" style={{ fontSize: 11 }}>성향: {traitWord(p)}</div>
          <div class="muted" style={{ fontSize: 11 }}>호감도</div>
          <div style={{ width: 110 }}><Bar v={(p.affinity ?? 0) + 100} max={200} color={(p.affinity ?? 0) >= 0 ? "#8ef0a8" : "#ff8a8a"} /></div>
          <div class="muted" style={{ fontSize: 11 }}>인내심 {"♥".repeat(Math.max(0, p.patience ?? 4))}</div>
          <div class="muted" style={{ fontSize: 11 }}>우리 구단 매력 {Math.round(appeal * 100)}</div>
        </div>
        <div style={{ flex: 1 }}>
          {rivals.length > 0 && (
            <div class="frame dark pad" style={{ marginBottom: 6 }}>
              <span class="neg">경쟁 구단 {rivals.length}곳</span>{" "}
              {rivals.map((b) => <span><TeamLogo id={b.team} size={16} /> {s.teams[b.team].short} </span>)}
              <span class="muted"> · 가장 이른 결정일까지 {Math.max(0, Math.min(...rivals.map((b) => b.due)) - s.day)}일</span>
            </div>
          )}
          <div class="feed" style={{ maxHeight: 180, marginBottom: 6 }}>
            {log.map((l) => <div><b class={l.who === "나" ? "gold" : ""}>{l.who}</b>: {l.text}</div>)}
          </div>
          {step === "blocked" && <div class="neg">{talk.msg}</div>}
          {step === "club" && fromTeam && (
            <div class="frame dark pad">
              <div class="row"><TeamLogo id={fromTeam.id} size={22} /> <b>{fromTeam.name}와 이적료 협상</b> <span class="muted">({ft.rounds}/{FEE_ROUNDS}회{ft.rounds >= FEE_ROUNDS && ` · ${ft.resetIn}일 뒤 다시 협상할 수 있습니다${ft.counter !== undefined ? `. 마지막 제시액 ${money(ft.counter)}은 지금도 받습니다` : ""}`})</span></div>
              <div class="muted" style={{ fontSize: 12 }}>
                시장 가치 {money(marketValue(p, s.season))}. 주전이거나 대체 선수가 없으면 더 비싸게 부릅니다. 이적료를 합의해도 선수가 거절할 수 있습니다.
              </div>
              <div class="row">
                <input type="range" min={0} max={Math.max(20000, clubDemand(s, p) * 2)} step={500} value={fee} onInput={(e) => setFee(Number((e.target as HTMLInputElement).value))} style={{ width: 260 }} />
                <b>{money(fee)}</b>
                <button class="btn primary small" onClick={sendFee} disabled={!canOfferFee(s, p, fee)}>제시</button>
              </div>
            </div>
          )}
          {step === "interview" && (
            <div class="frame dark pad">
              <h3>면담 ({qIdx + 1}/{qs.length})</h3>
              <div class="speech">{p.name}: "{qs[qIdx].q}"</div>
              {qs[qIdx].answers.map((a, i) => <button class="btn qbtn" onClick={() => answer(i)}>{a.t}</button>)}
              <div class="dim" style={{ fontSize: 11 }}>선수 성향에 맞는 답일수록 요구액이 내려가고 호감도가 오릅니다. 답의 효과는 선수마다 고정입니다.</div>
            </div>
          )}
          {step === "offer" && (
            <div class="frame dark pad">
              <div>선수 요구: <b class="gold">{money(ask)}</b>/년 <span class="muted">(시장 기준 {money(salaryAsk(p, s.season))})</span>{mode === "renew" && p.contract && <span class="muted"> · 현재 연봉 {money(p.contract.salary)}</span>}</div>
              <div class="row">
                <span style={{ width: 60 }}>연봉</span>
                <input type="range" min={6000} max={Math.max(12000, Math.round(ask * 1.6))} step={100} value={offer.salary} onInput={(e) => setOffer({ ...offer, salary: Number((e.target as HTMLInputElement).value) })} style={{ width: 260 }} />
                <b>{money(offer.salary)}</b>
              </div>
              <div class="row">
                <span style={{ width: 60 }}>기간</span>
                {[1, 2, 3].map((y) => <button class={`btn small ${offer.years === y ? "on" : ""}`} onClick={() => setOffer({ ...offer, years: y })}>{y}년</button>)}
              </div>
              <div class="row">
                <span style={{ width: 60 }}>계약금</span>
                <input type="range" min={0} max={Math.round(ask)} step={500} value={offer.bonus} onInput={(e) => setOffer({ ...offer, bonus: Number((e.target as HTMLInputElement).value) })} style={{ width: 260 }} />
                <b>{money(offer.bonus)}</b>
              </div>
              <label class="row" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={offer.starter} onChange={(e) => setOffer({ ...offer, starter: (e.target as HTMLInputElement).checked })} />
                주전 보장 <span class="muted" style={{ fontSize: 11 }}>(욕심 많은 선수는 크게 반깁니다. 벤치에 두면 사기가 빨리 떨어집니다)</span>
              </label>
              <div class="muted" style={{ fontSize: 11 }}>
                계약금은 연봉으로 환산해 '계약금/기간 × 0.8'만큼 쳐줍니다. 너무 낮게 부르면 인내심이 두 칸 깎입니다.
                {agreed !== undefined && <> 합의한 이적료 {money(agreed)}이 함께 나갑니다.</>}
              </div>
              <CostBox upfront={offer.bonus + (agreed ?? 0)} fee={agreed ?? 0} bonus={offer.bonus} monthlyAdd={Math.round((offer.salary - (mode === "renew" ? p.contract?.salary ?? 0 : 0)) / 12)} />
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
