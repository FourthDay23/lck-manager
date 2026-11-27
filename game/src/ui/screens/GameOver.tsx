// Game over: a day ended with the club's cash below zero (core/game.ts advanceDay). The save stays on this screen;
// the way on is a new game or another save from the start screen.
import { store, S } from "../../store";
import { fmtDate, money } from "../../core/format";
import { TeamLogo } from "../components";

export function GameOverScreen() {
  const s = S();
  const me = s.teams[s.user];
  const over = s.over!;
  const back = () => {
    store.s = null;
    store.tut = null;
    store.tip = null;
    store.modal = null;
    store.screen = { name: "home" };
    store.bump();
  };
  return (
    <div class="loading" style={{ gap: 14 }}>
      <div class="title-logo" style={{ color: "#ff6b6b" }}>GAME OVER</div>
      <div class="frame pad center" style={{ maxWidth: 460 }}>
        <div class="row" style={{ justifyContent: "center", gap: 10 }}>
          <TeamLogo id={me.id} size={44} />
          <h2 style={{ margin: 0 }}>{me.name} 파산</h2>
        </div>
        <p>
          {fmtDate(over.day)}, 자금이 <b class="neg">{money(over.cash)}</b>인 채로 하루가 지나 구단 운영이 끝났습니다.
          {s.managerName && s.managerName !== "단장" ? ` ${s.managerName} 단장은` : " 단장은"} 자리에서 물러납니다.
        </p>
        <div class="muted" style={{ fontSize: 12 }}>
          치른 시즌 {s.stats.seasonsPlayed} · 시리즈 {s.stats.seriesW}승 {s.stats.seriesL}패 · 우승 {s.trophies.length}회
        </div>
        <button class="btn primary" style={{ marginTop: 12 }} onClick={back}>처음 화면으로 (새 게임 · 다른 세이브)</button>
      </div>
    </div>
  );
}
