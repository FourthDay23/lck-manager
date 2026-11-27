import { useEffect, useState } from "preact/hooks";
import { loadData } from "../data/load";
import { store, useStore } from "../store";
import { fmtDate, money } from "../core/format";
import { SAVE_VERSION, autoAdvance, migrateSave, phaseLabel, nextUserSeries, userSeriesToday } from "../core/game";
import { inbox } from "../core/news";
import type { AutoMode } from "../core/game";
import { windowLabel } from "../core/market";
import { saveGame } from "../core/save";
import { monthlyWages } from "../core/ledger";
import { TeamLogo } from "./components";
import { StartScreen } from "./screens/Start";
import { HomeScreen } from "./screens/Home";
import { ScheduleScreen } from "./screens/Schedule";
import { RosterScreen } from "./screens/Roster";
import { MarketScreen } from "./screens/Market";
import { TradeScreen } from "./screens/Trade";
import { TeamsScreen } from "./screens/Teams";
import { StaffScreen } from "./screens/Staff";
import { FinanceScreen } from "./screens/Finance";
import { NewsScreen } from "./screens/News";
import { TrophyScreen } from "./screens/Trophies";
import { SeriesScreen } from "./screens/Series";
import { SettingsScreen } from "./screens/Settings";
import { MetaScreen } from "./screens/Meta";
import { ExhibitionScreen } from "./screens/Exhibition";
import { GameOverScreen } from "./screens/GameOver";
import { PlayerModal } from "./PlayerModal";
import { NegotiationModal } from "./Negotiation";
import { StaffNegotiationModal } from "./StaffNegotiation";
import { AlertLayer, EventModal, CutsceneLayer } from "./Overlays";
import { TutorialLayer } from "./Tutorial";
import { TeamModal } from "./screens/Teams";

let saveTimer: number | undefined;
export function autosave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (store.s) saveGame(store.s, store.slot).catch((e) => console.warn("save failed", e));
  }, 400);
}

export function advance(mode: AutoMode) {
  const s = store.s!;
  const stop = autoAdvance(s, store.data!, mode);
  if (stop === "match" || userSeriesToday(s)) store.go("series");
  autosave();
  store.bump();
}

const NAV: [string, string][] = [
  ["home", "홈"],
  ["schedule", "일정 · 순위"],
  ["meta", "메타 · 패치"],
  ["roster", "선수단"],
  ["market", "이적시장"],
  ["trade", "트레이드"],
  ["teams", "타 팀 로스터"],
  ["staff", "감독 · 코치진"],
  ["finance", "재정 · 굿즈"],
  ["news", "뉴스"],
  ["trophies", "트로피 진열장"],
  ["exhibition", "코드 대전"],
  ["settings", "저장 · 설정"],
];

export function App() {
  const st = useStore();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadData().then((d) => {
      store.data = d;
      store.bump();
    }).catch((e) => setErr(String(e)));
  }, []);
  if (err) return <div class="loading"><h2>데이터를 불러오지 못했습니다</h2><div class="muted">{err}</div></div>;
  if (!st.data) return <div class="loading"><div class="title-logo">LCK MANAGER</div><div class="muted">데이터 불러오는 중...</div></div>;
  store.override = st.screen.name === "exhibition" ? store.exState : null;
  // a save opened before an update (or kept in memory across a hot reload) is brought up to date once
  if (st.s && st.s.version !== SAVE_VERSION) {
    for (const note of migrateSave(st.s, st.data)) inbox(st.s, note);
    autosave();
  }
  if (!st.s) return st.screen.name === "exhibition" ? <div class="main" style={{ height: "100vh" }}><ExhibitionScreen /></div> : <StartScreen />;
  const s = st.s;
  if (s.over) return <GameOverScreen />;
  const me = s.teams[s.user];
  const scr = st.screen.name;
  const today = userSeriesToday(s);
  const next = nextUserSeries(s);
  const offers = s.tradeOffers.length + s.saleOffers.length;
  const teamStyle = { "--team": accentOf(me.colors) } as Record<string, string>;
  return (
    <div class="shell" style={teamStyle}>
      <div class="topbar">
        <div class="team">
          <TeamLogo id={me.id} size={34} />
          <div>
            <b>{me.name}</b>
            <div class="muted" style={{ fontSize: 11 }}>{s.managerName && s.managerName !== "단장" ? `단장 ${s.managerName}` : "단장"}</div>
          </div>
        </div>
        <div class="stat"><span>날짜</span>{fmtDate(s.day)}</div>
        <div class="stat"><span>시즌</span>{s.season} · {phaseLabel(s)}</div>
        <div class="stat" title={me.cash < 0 ? "자금이 마이너스인 채로 하루가 지나면 게임 오버입니다." : undefined}><span>자금{me.cash < 0 && " · 게임 오버 위험"}</span><b class={me.cash < 0 ? "neg" : "gold"}>{money(me.cash)}</b></div>
        <div class="stat" title="선수·스태프 연봉 합계 ÷ 12. 매달 25일에 나갑니다."><span>월 급여 (25일)</span><span class="neg">-{money(monthlyWages(s))}</span></div>
        <div class="stat"><span>명성 · 팬</span>{Math.round(me.fame)} · {(me.fans / 10000).toFixed(1)}만</div>
        <div class="stat"><span>이적시장</span>{windowLabel(s)}</div>
        <div class="grow" />
        {today ? (
          <button class="btn primary" onClick={() => store.go("series")}>오늘 경기 하러 가기</button>
        ) : (
          <>
            <button class="btn" onClick={() => advance("day")}>다음 날</button>
            <button class="btn" onClick={() => advance("week")}>1주</button>
            <button class="btn primary" onClick={() => advance("match")} title={next ? `다음 경기 ${fmtDate(next.day, false)}` : ""}>
              다음 경기까지 ▶
            </button>
          </>
        )}
      </div>
      <div class="side">
        {NAV.map(([k, label]) => (
          <button class={`nav ${scr === k ? "on" : ""}`} onClick={() => store.go(k)}>
            {label}
            {k === "market" && offers > 0 && <span class="badge">{offers}</span>}
            {k === "news" && s.inbox.some((m) => !m.read) && <span class="badge">!</span>}
          </button>
        ))}
        <div class="sec">다음 경기</div>
        <div class="pad muted" style={{ fontSize: 11 }}>
          {next ? (
            <>
              {fmtDate(next.day, false)}
              <br />
              vs {s.teams[next.a === s.user ? next.b! : next.a!]?.name ?? "미정"}
            </>
          ) : "일정 없음"}
        </div>
      </div>
      <div class="main">
        {scr === "home" && <HomeScreen />}
        {scr === "schedule" && <ScheduleScreen />}
        {scr === "roster" && <RosterScreen />}
        {scr === "market" && <MarketScreen />}
        {scr === "trade" && <TradeScreen />}
        {scr === "teams" && <TeamsScreen />}
        {scr === "staff" && <StaffScreen />}
        {scr === "finance" && <FinanceScreen />}
        {scr === "news" && <NewsScreen />}
        {scr === "trophies" && <TrophyScreen />}
        {scr === "series" && <SeriesScreen />}
        {scr === "settings" && <SettingsScreen />}
        {scr === "meta" && <MetaScreen />}
        {scr === "exhibition" && <ExhibitionScreen />}
      </div>
      {st.modal?.kind === "player" && <PlayerModal pid={st.modal.arg!} />}
      {st.modal?.kind === "nego" && <NegotiationModal key={`${st.modal.arg}:${st.modal.arg2}`} pid={st.modal.arg!} mode={(st.modal.arg2 as "sign" | "renew" | "transfer") ?? "sign"} />}
      {st.modal?.kind === "staffnego" && <StaffNegotiationModal key={st.modal.arg} sid={st.modal.arg!} />}
      {st.modal?.kind === "team" && <TeamModal id={st.modal.arg!} />}
      {s.events.length > 0 && scr !== "series" && scr !== "exhibition" && <EventModal />}
      {(s.alerts?.length ?? 0) > 0 && !s.events.length && scr !== "series" && scr !== "exhibition" && <AlertLayer />}
      <CutsceneLayer />
      <TutorialLayer />
      {st.toast && <div class="toast frame">{st.toast.text}</div>}
    </div>
  );
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Team accent for the menu bar and highlights: too-dark main colors (Dplus Kia black, BRION green) fall back. */
function accentOf(colors: [string, string]): string {
  if (luminance(colors[0]) >= 0.22) return colors[0];
  if (luminance(colors[1]) >= 0.35) return colors[1];
  return "#f2c14e";
}
