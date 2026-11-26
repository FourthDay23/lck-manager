import { S, D } from "../../store";
import { ROLES, ROLE_KO } from "../../data/types";
import { META_BONUS, patchDays } from "../../core/meta";
import type { MetaTier } from "../../core/types";
import { fmtDate } from "../../core/format";
import { ChampIcon } from "../components";

export function MetaScreen() {
  const s = S();
  const d = D();
  const meta = s.meta;
  const me = s.teams[s.user];
  if (!meta) return <div class="frame pad">아직 패치 정보가 없습니다.</div>;
  const byTier = (tier: MetaTier, r?: (typeof ROLES)[number]) =>
    Object.entries(meta.tiers).filter(([c, t]) => t === tier && (!r || (d.champ.get(c)?.roles[r] ?? 0) >= 0.35)).map(([c]) => c);
  const next = patchDays(s.season).find((x) => x > s.day) ?? patchDays(s.season + 1)[0];
  // our players who already know this patch's strong champions
  const ready = [...me.roster].map((id) => s.players[id]).filter(Boolean).flatMap((p) =>
    Object.entries(p.mastery).filter(([c, m]) => (meta.tiers[c] === "S" || meta.tiers[c] === "A") && m >= 60).map(([c, m]) => ({ p, c, m })),
  ).sort((a, b) => b.m - a.m);
  return (
    <div>
      <h1>메타 · 패치 {meta.patch}</h1>
      <div class="muted" style={{ marginBottom: 8 }}>
        {fmtDate(meta.since, false)} 적용 · 다음 패치 {fmtDate(next, false)}. 게임이 패치마다 강한 챔피언과 너프된 챔피언을 새로 정합니다.
        경기에서 S티어 챔피언을 잡은 선수는 능력치 +{META_BONUS.S}, A티어는 +{META_BONUS.A}, 너프된 챔피언은 {META_BONUS.N}로 계산된다(관전 경기와 결과만 보기 모두).
      </div>
      <div class="frame pad">
        <h2>포지션별 티어</h2>
        <table class="t">
          <thead><tr><th>포지션</th><th>S티어</th><th>A티어</th></tr></thead>
          <tbody>
            {ROLES.map((r) => (
              <tr>
                <td><span class="tag">{ROLE_KO[r]}</span></td>
                <td><div class="tierrow">{byTier("S", r).map((c) => <div class="c"><ChampIcon id={c} size={40} />{d.champ.get(c)?.name}</div>)}</div></td>
                <td><div class="tierrow">{byTier("A", r).map((c) => <div class="c"><ChampIcon id={c} size={34} />{d.champ.get(c)?.name}</div>)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 style={{ marginTop: 8 }}>너프</h3>
        <div class="tierrow">{byTier("N").map((c) => <div class="c" style={{ opacity: 0.75 }}><ChampIcon id={c} size={34} />{d.champ.get(c)?.name}</div>)}</div>
      </div>
      <div class="grid2">
        <div class="frame pad">
          <h2>우리 선수의 메타 챔피언 숙련도</h2>
          {!ready.length && <div class="muted">S·A티어 챔피언 숙련도 60 이상인 선수가 없습니다. 선수단 화면에서 연습 챔피언을 메타 챔피언으로 바꿔 두면 숙련도가 오릅니다.</div>}
          {ready.slice(0, 14).map(({ p, c, m }) => (
            <div class="row" style={{ gap: 6 }}>
              <ChampIcon id={c} size={24} />
              <span style={{ width: 90 }}>{p.name}</span>
              <span class="muted">{d.champ.get(c)?.name}</span>
              <span class={`tier t${meta.tiers[c]}`} style={{ position: "static", padding: "0 4px" }}>{meta.tiers[c]}</span>
              <b>{Math.round(m)}</b>
            </div>
          ))}
        </div>
        <div class="frame pad">
          <h2>지난 패치</h2>
          {[...meta.history].reverse().map((h) => (
            <div style={{ padding: "4px 0", borderBottom: "1px solid #222739" }}>
              <b>{h.patch}</b> <span class="dim">{fmtDate(h.since, false)}</span>
              <div class="row" style={{ gap: 2 }}>
                <span class="muted" style={{ fontSize: 11 }}>S</span>{h.s.map((c) => <ChampIcon id={c} size={20} />)}
                <span class="muted" style={{ fontSize: 11, marginLeft: 6 }}>너프</span>{h.nerf.map((c) => <ChampIcon id={c} size={20} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
