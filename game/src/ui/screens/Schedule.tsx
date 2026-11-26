import { useState } from "preact/hooks";
import { S, store } from "../../store";
import { comp, standings, swissRecords } from "../../core/schedule";
import type { CompId } from "../../core/types";
import { COMP_NAME } from "../../core/types";
import { fmtShort, fmtDate } from "../../core/format";
import { stageName } from "../../core/game";
import { TeamLogo, ChampIcon } from "../components";

const IDS: CompId[] = ["CUP", "REG", "MSI", "EWCQ", "EWC", "REG2", "PO", "WORLDS"];

export function ScheduleScreen() {
  const s = S();
  const [season, setSeason] = useState(s.season);
  const defaultTab = IDS.find((id) => { const c = comp(s, id, season); return c && !c.done; }) ?? "CUP";
  const [tab, setTab] = useState<CompId>(defaultTab);
  const [onlyMine, setOnlyMine] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const c = comp(s, tab, season);
  const seasons = [...new Set(s.comps.map((x) => x.season))].sort();
  const list = s.series.filter((x) => x.comp === tab && x.season === season && (!onlyMine || x.a === s.user || x.b === s.user)).sort((a, b) => a.day - b.day);
  const rr = tab === "CUP" || tab === "REG" || tab === "REG2";
  const table = rr ? standings(s, tab === "REG2" ? ["REG", "REG2"] : [tab], season) : [];
  const stages = [...new Set(list.map((x) => x.stage))];
  return (
    <div>
      <h1>일정 · 순위</h1>
      <div class="tabs">
        {seasons.map((y) => <button class={`btn small ${season === y ? "on" : ""}`} onClick={() => setSeason(y)}>{y}</button>)}
        <span style={{ width: 16 }} />
        {IDS.map((id) => <button class={`btn small ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{COMP_NAME[id]}</button>)}
        <span style={{ width: 16 }} />
        <button class={`btn small ${onlyMine ? "on" : ""}`} onClick={() => setOnlyMine(!onlyMine)}>우리 경기만</button>
      </div>
      {c && (
        <div class="muted" style={{ marginBottom: 6 }}>
          {c.name} · {fmtDate(c.start, false)} ~ {fmtDate(c.end, false)}
          {c.champion && <span class="gold"> · 우승 {s.teams[c.champion]?.name}</span>}
        </div>
      )}
      <div class="grid2" style={{ gridTemplateColumns: rr || tab === "WORLDS" ? "1fr 1.3fr" : "1fr" }}>
        {rr && (
          <div class="frame pad">
            <h2>{tab === "REG2" ? "정규 시즌 합산 순위" : "순위"}</h2>
            <table class="t">
              <thead><tr><th>#</th><th>팀</th><th class="num">승</th><th class="num">패</th><th class="num">세트 득실</th></tr></thead>
              <tbody>
                {table.map((r, i) => (
                  <tr class={`click ${r.team === s.user ? "me" : ""}`} onClick={() => store.open("team", r.team)}>
                    <td>{i + 1}</td>
                    <td><TeamLogo id={r.team} size={18} /> {s.teams[r.team].name}</td>
                    <td class="num">{r.w}</td><td class="num">{r.l}</td>
                    <td class="num">{r.gw - r.gl > 0 ? "+" : ""}{r.gw - r.gl}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {tab === "CUP" ? "상위 6팀 플레이오프 (3·4·5·6위 8강부터)" : tab === "REG" ? "1·2위 MSI·EWC 직행, 3~6위 EWC 선발전" : "합산 상위 6팀 플레이오프, 플레이오프 상위 4팀 월즈 진출"}
            </div>
          </div>
        )}
        {tab === "WORLDS" && (
          <div class="frame pad">
            <h2>스위스 스테이지</h2>
            <table class="t">
              <tbody>
                {swissRecords(s, season).sort((a, b) => b.w - a.w || a.l - b.l).map((r) => (
                  <tr class={r.team === s.user ? "me" : ""}>
                    <td><TeamLogo id={r.team} size={18} /> {s.teams[r.team]?.name}</td>
                    <td class="muted">{s.teams[r.team]?.region}</td>
                    <td class="num">{r.w}-{r.l}</td>
                    <td>{r.w >= 3 ? <span class="tag green">진출</span> : r.l >= 3 ? <span class="tag red">탈락</span> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div class="frame pad">
          <h2>경기</h2>
          {!list.length && <div class="muted">아직 대진이 없습니다.</div>}
          {stages.map((st) => (
            <div>
              <h3 style={{ marginTop: 8 }}>{stageName(st)}</h3>
              {list.filter((x) => x.stage === st).map((x) => {
                const mine = x.a === s.user || x.b === s.user;
                return (
                  <div>
                    <div class="row" style={{ gap: 6, padding: "3px 4px", background: mine ? "#262013" : "transparent", cursor: x.done ? "pointer" : "default" }} onClick={() => x.done && setOpen(open === x.id ? null : x.id)}>
                      <span class="dim" style={{ width: 40 }}>{fmtShort(x.day)}</span>
                      <span style={{ width: 150, textAlign: "right" }} class={x.winner === x.a ? "gold" : ""}>{x.a ? s.teams[x.a]?.name : "미정"}</span>
                      <TeamLogo id={x.a} size={18} />
                      <b style={{ width: 44, textAlign: "center" }}>{x.done ? `${x.wa} : ${x.wb}` : `Bo${x.bo}`}</b>
                      <TeamLogo id={x.b} size={18} />
                      <span style={{ width: 150 }} class={x.winner === x.b ? "gold" : ""}>{x.b ? s.teams[x.b]?.name : "미정"}</span>
                    </div>
                    {open === x.id && (
                      <div class="pad" style={{ background: "#121522" }}>
                        {x.games.map((g, i) => (
                          <div class="row" style={{ gap: 4, fontSize: 11 }}>
                            <span class="muted">{i + 1}세트</span>
                            <span class={g.winner === g.blue ? "gold" : ""}>{s.teams[g.blue]?.short}</span>
                            {g.picks.blue.map((c) => <ChampIcon id={c} size={18} />)}
                            <b>{g.kills[0]}:{g.kills[1]}</b>
                            {g.picks.red.map((c) => <ChampIcon id={c} size={18} />)}
                            <span class={g.winner === g.red ? "gold" : ""}>{s.teams[g.red]?.short}</span>
                            <span class="dim">{Math.floor(g.duration / 60)}분</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
