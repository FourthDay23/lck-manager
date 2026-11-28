// Transfer window countdown: the top bar's 이적시장 stat and the side menu's 이적시장 item show the shared tooltip
// (ui/Tip.tsx) with the days until the window opens (closed today) or closes (open today), from core/market
// windowCountdown(). Mouse: on hover (and keyboard focus). Touch: tapping the stat toggles it; tapping the menu item
// still opens the market screen, and the bubble shows beside it for a few seconds.
import type { ComponentChildren } from "preact";
import { fmtDate } from "../core/format";
import { windowCountdown, windowLabel } from "../core/market";
import type { GameState } from "../core/types";
import { store } from "../store";
import { defineTip, tip } from "./Tip";

defineTip("market", () => {
  const s = store.s;
  if (!s) return null;
  const c = windowCountdown(s);
  if (!c.days) return null;
  const last = c.open && c.days === 1;
  return {
    tone: c.open ? "green" : "gold",
    body: (
      <>
        <span class="tip-main">
          {c.open ? "이적시장 마감까지" : "이적시장 개장까지"}: <b>{c.days}일</b>
        </span>
        <span class="tip-sub">
          {c.open ? (last ? "오늘이 마지막 날입니다" : `${fmtDate(c.day - 1, false)}까지 열림`) : `${fmtDate(c.day, false)} 개장`}
        </span>
      </>
    ),
  };
});

/** the top bar's 이적시장 stat */
export function MarketStat({ s }: { s: GameState }) {
  return (
    <div class="stat" tabIndex={0} {...tip("market")}>
      <span>이적시장</span>
      {windowLabel(s)}
    </div>
  );
}

/** the side menu's 이적시장 item: a menu button that also shows the bubble */
export function MarketNav({ cls, onClick, children }: { s: GameState; cls: string; onClick: () => void; children: ComponentChildren }) {
  return (
    <button class={cls} onClick={onClick} {...tip("market", undefined, "right")}>
      {children}
    </button>
  );
}
