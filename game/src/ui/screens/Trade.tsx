import { useState } from "preact/hooks";
import { S, store } from "../../store";
import { executeTrade, judgeTrade, tradeValue, windowOpen } from "../../core/market";
import { ovr } from "../../core/player";
import { money } from "../../core/format";
import { Avatar, Ovr, PName, RoleTag, TeamLogo } from "../components";
import { autosave } from "../App";
import { MoneyStepper } from "../Negotiation";

export function TradeScreen() {
  const s = S();
  const preset = store.screen.arg?.split(":") ?? [];
  const others = s.lck.filter((x) => x !== s.user);
  const [team, setTeam] = useState(preset[0] && others.includes(preset[0]) ? preset[0] : others[0]);
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>(preset[1] ? [preset[1]] : []);
  const [cash, setCash] = useState(0);
  const [msg, setMsg] = useState("");
  const me = s.teams[s.user];
  const them = s.teams[team];
  const open = windowOpen(s);
  const toggle = (arr: string[], set: (v: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const verdict = give.length || get.length ? judgeTrade(s, team, give, get, cash) : null;
  const propose = () => {
    if (!open) return setMsg("이적시장이 닫혀 있습니다.");
    if (cash > me.cash) return setMsg("현금이 부족합니다.");
    const v = judgeTrade(s, team, give, get, cash);
    if (!v.ok) return setMsg(v.msg);
    // the players coming to us must agree to move
    for (const id of get) {
      const p = s.players[id];
      if (p.persona.loyalty > 0.85 && them.fame >= me.fame) return setMsg(`${p.name}가 이적을 거부했습니다. 지금 팀에 남고 싶어 합니다.`);
    }
    executeTrade(s, team, give, get, cash);
    setGive([]); setGet([]); setCash(0);
    setMsg(v.msg);
    autosave();
    store.bump();
  };
  const list = (ids: string[], sel: string[], set: (v: string[]) => void) => (
    <table class="t">
      <tbody>
        {ids.map((id) => s.players[id]).sort((a, b) => ovr(b) - ovr(a)).map((p) => (
          <tr class={`click ${sel.includes(p.id) ? "me" : ""}`} onClick={() => toggle(sel, set, p.id)}>
            <td><input type="checkbox" checked={sel.includes(p.id)} /></td>
            <td><div class="row" style={{ gap: 6 }}><Avatar pid={p.id} size={22} /><PName pid={p.id} /></div></td>
            <td><RoleTag r={p.role} /></td>
            <td class="num"><Ovr v={ovr(p)} /></td>
            <td class="num muted">{money(p.contract?.salary ?? 0)}</td>
            <td class="num muted">가치 {money(tradeValue(s, p))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div>
      <h1>트레이드</h1>
      {!open && <div class="neg">이적시장이 닫혀 있어 지금은 트레이드할 수 없습니다.</div>}
      <div class="tabs">
        {others.map((id) => <button class={`btn small ${team === id ? "on" : ""}`} onClick={() => { setTeam(id); setGet([]); setMsg(""); }}><TeamLogo id={id} size={16} /> {s.teams[id].short}</button>)}
      </div>
      <div class="grid2">
        <div class="frame pad">
          <h2>우리가 주는 선수</h2>
          {list(me.roster, give, setGive)}
        </div>
        <div class="frame pad">
          <h2><TeamLogo id={team} size={20} /> {them.name}에게서 받는 선수</h2>
          {list(them.roster, get, setGet)}
        </div>
      </div>
      <div class="frame pad">
        <div class="row" style={{ alignItems: "flex-start" }}>
          <span style={{ paddingTop: 4 }}>현금 얹기 (우리가 지급)</span>
          <MoneyStepper value={cash} min={0} max={Math.max(0, Math.min(me.cash, 200000))} step={1000} big={10000} onChange={setCash}
            presets={[{ label: "없음", value: 0 }]} />
          <button class="btn primary" disabled={!open || (!give.length && !get.length)} onClick={propose}>제안하기</button>
        </div>
        {verdict && <div class="muted">상대 반응 예상: {verdict.ratio >= 1.02 ? "수락할 것 같습니다" : verdict.ratio >= 0.9 ? "조금 모자랍니다" : verdict.ratio >= 0.7 ? "손해라고 봅니다" : "관심 없음"} (가치 비율 {verdict.ratio.toFixed(2)})</div>}
        {msg && <div class="gold">{msg}</div>}
        <div class="dim" style={{ fontSize: 11 }}>상대 구단은 받는 선수 가치(나이, 능력치, 잔여 계약, 주전 여부)와 포지션 공백을 따집니다. 계약은 그대로 넘어갑니다.</div>
      </div>
    </div>
  );
}
