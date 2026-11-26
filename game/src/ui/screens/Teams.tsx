import { useState } from "preact/hooks";
import { S, store } from "../../store";
import { ROLES, ROLE_KO } from "../../data/types";
import { ovr, age, teamDifficulty } from "../../core/player";
import { teamPower } from "../../core/quick";
import { money } from "../../core/format";
import { Avatar, ChampIcon, Modal, Ovr, PName, RoleTag, TeamLogo } from "../components";

export function TeamsScreen() {
  const s = S();
  const [region, setRegion] = useState<"LCK" | "intl">("LCK");
  const ids = region === "LCK" ? s.lck : s.intl;
  return (
    <div>
      <h1>타 팀 로스터</h1>
      <div class="tabs">
        <button class={`btn small ${region === "LCK" ? "on" : ""}`} onClick={() => setRegion("LCK")}>LCK</button>
        <button class={`btn small ${region === "intl" ? "on" : ""}`} onClick={() => setRegion("intl")}>해외 리그</button>
      </div>
      <div class="grid2">
        {ids.map((id) => {
          const t = s.teams[id];
          const hc = t.staff.map((x) => s.staff[x]).find((x) => x?.role === "Head Coach");
          return (
            <div class="frame pad" style={{ cursor: "pointer" }} onClick={() => store.open("team", id)}>
              <div class="row" style={{ justifyContent: "space-between" }}>
                <div class="row"><TeamLogo id={id} size={36} /><div><b>{t.name}</b><div class="muted" style={{ fontSize: 11 }}>{t.region} · 감독 {hc?.name ?? "없음"} · 전력 {teamPower(s, id).toFixed(1)}{t.region === "LCK" && <> · 난이도 {teamDifficulty(t).label}</>}</div></div></div>
                <div class="muted" style={{ fontSize: 11, textAlign: "right" }}>LCK {t.titles.lck} · MSI {t.titles.msi} · 월즈 {t.titles.worlds}</div>
              </div>
              <div class="row" style={{ gap: 4, marginTop: 6 }}>
                {ROLES.map((r) => {
                  const p = t.lineup[r] ? s.players[t.lineup[r]!] : null;
                  return (
                    <div class="col center" style={{ width: 88, gap: 0 }}>
                      <span class="dim" style={{ fontSize: 10 }}>{ROLE_KO[r]}</span>
                      {p ? <><Avatar pid={p.id} size={28} /><span style={{ fontSize: 11 }}>{p.name}</span><Ovr v={ovr(p)} /></> : <span class="neg" style={{ fontSize: 11 }}>공석</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TeamModal({ id }: { id: string }) {
  const s = S();
  const t = s.teams[id];
  if (!t) return null;
  const players = t.roster.map((x) => s.players[x]).filter(Boolean).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || ovr(b) - ovr(a));
  const starters = new Set(Object.values(t.lineup));
  return (
    <Modal wide>
      <div class="row"><TeamLogo id={id} size={48} /><div><h1 style={{ margin: 0 }}>{t.name}</h1><div class="muted">{t.region} · 명성 {Math.round(t.fame)} · 팬 {(t.fans / 10000).toFixed(1)}만 · 전력 {teamPower(s, id).toFixed(1)} · 팀 합 {Math.round(t.synergy)}</div></div></div>
      <div class="sp" />
      <table class="t">
        <thead><tr><th></th><th>선수</th><th>포지션</th><th class="num">OVR</th><th class="num">나이</th><th>계약</th><th class="num">연봉</th><th>주력 챔피언</th></tr></thead>
        <tbody>
          {players.map((p) => (
            <tr>
              <td>{starters.has(p.id) ? <span class="tag gold">주전</span> : <span class="tag">후보</span>}</td>
              <td><div class="row" style={{ gap: 6 }}><Avatar pid={p.id} size={22} /><PName pid={p.id} /><span class="dim">{p.realName}</span></div></td>
              <td><RoleTag r={p.role} /></td>
              <td class="num"><Ovr v={ovr(p)} /></td>
              <td class="num">{age(p, s.season)}</td>
              <td>{p.contract && p.origin !== "intl" ? `${p.contract.until}년까지` : "-"}</td>
              <td class="num">{p.origin === "intl" ? "-" : money(p.contract?.salary ?? 0)}</td>
              <td>{Object.entries(p.mastery).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => <ChampIcon id={c} size={20} />)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(t.academy ?? []).length > 0 && (
        <>
          <h3 style={{ marginTop: 10 }}>2군 (LCK CL)</h3>
          <div class="row" style={{ gap: 4 }}>
            {(t.academy ?? []).map((x) => s.players[x]).filter(Boolean).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role)).map((p) => (
              <span class="tag" style={{ cursor: "pointer" }} onClick={() => store.open("player", p.id)}>{ROLE_KO[p.role]} {p.name} {ovr(p)}</span>
            ))}
          </div>
        </>
      )}
      <h3 style={{ marginTop: 10 }}>코칭스태프</h3>
      {t.staff.map((x) => s.staff[x]).filter(Boolean).map((st) => <span class="tag">{st.role === "Head Coach" ? "감독" : "코치"} {st.name}</span>)}
      {!t.staff.length && <span class="muted">없음</span>}
    </Modal>
  );
}
