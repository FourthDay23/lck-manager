// Transfer window countdown: the top bar's 이적시장 stat and the side menu's 이적시장 item show a bubble with the
// days until the window opens (closed today) or closes (open today), from core/market windowCountdown().
// Mouse: on hover (and keyboard focus). Touch: tapping the stat toggles the bubble; tapping the menu item still opens
// the market screen, and the bubble shows beside it for a few seconds.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fmtDate } from "../core/format";
import { windowCountdown, windowLabel } from "../core/market";
import type { GameState } from "../core/types";
import { appW, localRect, onScale } from "./scale";
import "./markettip.css";

/** "": hidden, "hover": while the mouse (or keyboard focus) is on it, "pin": tapped on a touch screen */
type Shown = "" | "hover" | "pin";

const FLASH_MS = 4000;

function useTip(ref: { current: HTMLElement | null }, tap: "toggle" | "flash") {
  const [shown, setShown] = useState<Shown>("");
  const [pinAt, setPinAt] = useState(0);
  const touch = useRef(false);
  // a tapped bubble closes on a tap anywhere else, when the screen scale changes, and (menu item) after a while
  useEffect(() => {
    if (shown !== "pin") return;
    const hide = () => setShown("");
    const outside = (e: Event) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) hide();
    };
    document.addEventListener("pointerdown", outside, true);
    const unScale = onScale(hide);
    const timer = tap === "flash" ? window.setTimeout(hide, FLASH_MS) : undefined;
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      unScale();
      clearTimeout(timer);
    };
  }, [shown, pinAt]);
  // the bubble is fixed to the window: a scroll (the side menu on a short screen, the page) would leave it behind
  useEffect(() => {
    if (!shown) return;
    const hide = () => setShown("");
    document.addEventListener("scroll", hide, true);
    return () => document.removeEventListener("scroll", hide, true);
  }, [shown]);
  const on = {
    onPointerEnter: (e: PointerEvent) => { if (e.pointerType === "mouse") setShown((v) => v || "hover"); },
    onPointerLeave: (e: PointerEvent) => { if (e.pointerType === "mouse") setShown((v) => (v === "hover" ? "" : v)); },
    onPointerDown: (e: PointerEvent) => { touch.current = e.pointerType !== "mouse"; },
    // a touch that turns into a scroll gets no click: don't let a later keyboard Enter count as a tap
    onPointerCancel: () => { touch.current = false; },
    onFocus: (e: FocusEvent) => {
      let kb = false;
      try {
        kb = (e.currentTarget as HTMLElement).matches(":focus-visible");
      } catch {
        // Safari before 15.4 has no :focus-visible
      }
      if (kb) setShown((v) => v || "hover");
    },
    onBlur: () => setShown((v) => (v === "hover" ? "" : v)),
  };
  /** call from the click handler: only a touch / pen tap pins the bubble (a mouse already shows it on hover) */
  const tapped = () => {
    if (!touch.current) return;
    touch.current = false;
    if (tap === "toggle" && shown === "pin") return setShown("");
    setShown("pin");
    setPinAt(Date.now());
  };
  return { shown, on, tapped };
}

/** the top bar's 이적시장 stat */
export function MarketStat({ s }: { s: GameState }) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useTip(ref, "toggle");
  return (
    <div
      ref={ref}
      class="stat mkt-stat"
      tabIndex={0}
      aria-describedby={t.shown ? "mkt-tip-stat" : undefined}
      {...t.on}
      onClick={t.tapped}
    >
      <span>이적시장</span>
      {windowLabel(s)}
      {t.shown && <MarketBubble id="mkt-tip-stat" s={s} anchor={ref} side="below" />}
    </div>
  );
}

/** the side menu's 이적시장 item: a menu button that also shows the bubble */
export function MarketNav({ s, cls, onClick, children }: { s: GameState; cls: string; onClick: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLButtonElement>(null);
  const t = useTip(ref, "flash");
  return (
    <button
      ref={ref}
      class={cls}
      aria-describedby={t.shown ? "mkt-tip-nav" : undefined}
      {...t.on}
      onClick={() => {
        t.tapped();
        onClick();
      }}
    >
      {children}
      {t.shown && <MarketBubble id="mkt-tip-nav" s={s} anchor={ref} side="right" />}
    </button>
  );
}

/**
 * The bubble, fixed to the window beside its anchor (the side menu scrolls and clips what sticks out of it).
 * Placed with localRect() because the app runs under a CSS zoom (ui/scale.ts). "right" falls back to "below" when
 * the window is too narrow.
 */
function MarketBubble({ id, s, anchor, side }: { id: string; s: GameState; anchor: { current: HTMLElement | null }; side: "below" | "right" }) {
  const box = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; at: "below" | "right"; arrow: number } | null>(null);
  const c = windowCountdown(s);
  useLayoutEffect(() => {
    const a = anchor.current, b = box.current;
    if (!a || !b) return;
    const r = localRect(a), m = localRect(b), W = appW(), gap = 8, edge = 6;
    if (side === "right" && r.right + gap + m.width <= W - edge) {
      const top = Math.max(edge, r.top + r.height / 2 - m.height / 2);
      setPos({ left: r.right + gap, top, at: "right", arrow: r.top + r.height / 2 - top });
      return;
    }
    const left = Math.max(edge, Math.min(r.left, W - edge - m.width));
    const mid = Math.min(r.left + 16, r.left + r.width / 2);
    setPos({ left, top: r.bottom + gap, at: "below", arrow: Math.max(10, Math.min(m.width - 10, mid - left)) });
  }, [side, s.day, c.open, c.days]);
  if (!c.days) return null;
  const last = c.open && c.days === 1;
  const style = (pos
    ? { left: `${pos.left}px`, top: `${pos.top}px`, "--arrow": `${pos.arrow}px` }
    : { left: "0px", top: "0px", visibility: "hidden" }) as Record<string, string>;
  return (
    <span ref={box} id={id} role="tooltip" class={`mkt-tip ${c.open ? "open" : "shut"} ${pos?.at ?? ""}`} style={style}>
      <span class="mkt-tip-main">
        {c.open ? "이적시장 마감까지" : "이적시장 개장까지"}: <b>{c.days}일</b>
      </span>
      <span class="mkt-tip-sub">
        {c.open ? (last ? "오늘이 마지막 날입니다" : `${fmtDate(c.day - 1, false)}까지 열림`) : `${fmtDate(c.day, false)} 개장`}
      </span>
    </span>
  );
}
