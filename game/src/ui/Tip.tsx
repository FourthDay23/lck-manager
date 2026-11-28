// The one tooltip of the app (replaces the browser's own `title` tooltip everywhere).
//
// Mark an element with
//   data-tip="text"            plain text: the first line is the headline, further lines ("\n") are small grey notes
//   data-tipk="kind" (+ data-tiparg="…")   rich content drawn by a renderer registered with defineTip(kind, …)
//   data-tipside="right"       put the bubble to the right of the element (falls back to below / above)
// and the single <TipLayer /> shows the bubble: on mouse hover and keyboard focus, and on a touch tap (a tap on a
// button still presses it and the bubble shows for a few seconds; a tap on anything else toggles it). A `title`
// attribute that is still somewhere in the UI is taken over the same way on hover, so the browser's own tooltip
// never shows. The bubble is fixed to the window, placed with localRect() because the app runs under a CSS zoom
// (ui/scale.ts), and kept inside the window.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useStore } from "../store";
import { appH, appW, localRect, onScale, uiZoom } from "./scale";
import "./tip.css";

export type TipTone = "gold" | "green" | "red" | "blue";
export interface TipView { body: ComponentChildren; tone?: TipTone }
type Render = (arg: string, el: HTMLElement) => TipView | null;

const kinds = new Map<string, Render>();
/** register the renderer of `data-tipk="kind"`; it runs while the bubble is shown (on every store update) */
export function defineTip(kind: string, render: Render) {
  kinds.set(kind, render);
}

/** props for a rich tip: `<div {...tip("cash")}>` */
export function tip(kind: string, arg?: string, side?: "right"): Record<string, string | undefined> {
  return { "data-tipk": kind, "data-tiparg": arg, "data-tipside": side };
}

/** "": hover / keyboard focus, "pin": tapped on a touch screen, "flash": a tapped button (closes by itself) */
type Mode = "hover" | "focus" | "pin" | "flash";
interface Cur { el: HTMLElement; mode: Mode; at: number }

const FLASH_MS = 4000;
const BUBBLE_ID = "app-tip";
let cur: Cur | null = null;
const subs = new Set<() => void>();
const changed = () => { for (const f of subs) f(); };

function has(el: HTMLElement): boolean {
  if (el.dataset.tipk && kinds.has(el.dataset.tipk)) return true;
  // a leftover `title`: take it over so the browser's tooltip does not show as well (checked first: when the UI
  // sets a new title, it is newer than the copy taken last time)
  const t = el.getAttribute("title");
  if (t) {
    el.dataset.tip = t;
    el.removeAttribute("title");
    return true;
  }
  return !!el.dataset.tip;
}

/** the nearest element with a tip, from the event target up */
function anchorOf(t: EventTarget | null): HTMLElement | null {
  let el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
  for (; el; el = el.parentElement) {
    if (el instanceof HTMLElement && has(el)) return el;
    if (el.id === BUBBLE_ID) return null;
  }
  return null;
}

/** point the element's aria-describedby at the bubble while it shows, keeping any description it already had */
function describe(el: HTMLElement, on: boolean) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== BUBBLE_ID);
  if (on) ids.push(BUBBLE_ID);
  if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
  else el.removeAttribute("aria-describedby");
}

function show(el: HTMLElement, mode: Mode) {
  if (cur && cur.el !== el) describe(cur.el, false);
  cur = { el, mode, at: Date.now() };
  describe(el, true);
  changed();
}
export function hideTip() {
  if (!cur) return;
  describe(cur.el, false);
  cur = null;
  changed();
}

const interactive = (el: HTMLElement) => !!el.closest("button, a[href], input, select, textarea, [role=button], .nav");

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  let down: { x: number; y: number; el: HTMLElement | null; touch: boolean } | null = null;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const a = anchorOf(e.target);
    if (a) {
      if (cur?.el !== a) show(a, "hover");
    } else if (cur && cur.mode === "hover") hideTip();
  }, true);
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType === "mouse" && !e.relatedTarget && cur?.mode === "hover") hideTip();
  }, true);
  document.addEventListener("pointerdown", (e) => {
    const a = anchorOf(e.target);
    down = { x: e.clientX, y: e.clientY, el: a, touch: e.pointerType !== "mouse" };
    // a tap anywhere else closes a tapped bubble
    if (cur && (cur.mode === "pin" || cur.mode === "flash") && a !== cur.el) hideTip();
  }, true);
  document.addEventListener("pointercancel", () => { down = null; }, true);
  // pointerup, not click: a disabled button gets no click, and its tip (why it is disabled) matters most
  document.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || !d.touch || !d.el || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
    const el = d.el;
    if (interactive(el)) show(el, "flash");
    else if (cur?.el === el && cur.mode === "pin") hideTip();
    else show(el, "pin");
  }, true);
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    let kb = false;
    try {
      kb = t.matches(":focus-visible");
    } catch {
      // Safari before 15.4 has no :focus-visible
    }
    const a = kb ? anchorOf(t) : null;
    if (a) show(a, "focus");
  }, true);
  document.addEventListener("focusout", () => { if (cur?.mode === "focus") hideTip(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); }, true);
  // the bubble is fixed to the window: a scroll would leave it behind
  document.addEventListener("scroll", (e) => {
    if (cur && e.target instanceof Node && !e.target.contains(cur.el) && e.target !== document) return;
    hideTip();
  }, true);
  onScale(hideTip);
}

function content(el: HTMLElement): TipView | null {
  const k = el.dataset.tipk;
  if (k) {
    const r = kinds.get(k);
    return r ? r(el.dataset.tiparg ?? "", el) : null;
  }
  const t = el.dataset.tip;
  if (!t) return null;
  const [head, ...rest] = t.split("\n");
  return {
    body: (
      <>
        <span class="tip-main">{head}</span>
        {rest.filter(Boolean).map((x) => <span class="tip-sub">{x}</span>)}
      </>
    ),
  };
}

type Pos = { left: number; top: number; at: "below" | "above" | "right"; arrow: number };

/** mounted once at the root; draws the bubble of the element under the pointer / focus / tap */
export function TipLayer() {
  useStore(); // rich tips follow the game state while shown
  const [, setTick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  useEffect(() => {
    wire();
    const f = () => setTick((n) => n + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  const c = cur;
  // a tapped button's bubble closes by itself; any bubble goes when its element leaves the page
  useEffect(() => {
    if (!c) return;
    const timer = window.setInterval(() => {
      if (!c.el.isConnected || (c.mode === "flash" && Date.now() - c.at > FLASH_MS)) hideTip();
    }, 250);
    return () => clearInterval(timer);
  }, [c]);
  const view = c && c.el.isConnected ? content(c.el) : null;
  useLayoutEffect(() => {
    const b = box.current;
    if (!c || !b) return setPos(null);
    const r = localRect(c.el), m = localRect(b), gap = 8;
    // the visible part of the page: on a phone the page can be wider than the screen (scrolled / pinch-zoomed)
    const vv = window.visualViewport, z = uiZoom();
    const X0 = (vv ? vv.offsetLeft / z : 0) + 6, Y0 = (vv ? vv.offsetTop / z : 0) + 6;
    const X1 = (vv ? (vv.offsetLeft + vv.width) / z : appW()) - 6, Y1 = (vv ? (vv.offsetTop + vv.height) / z : appH()) - 6;
    let p: Pos;
    if (c.el.dataset.tipside === "right" && r.right + gap + m.width <= X1) {
      const top = Math.max(Y0, Math.min(r.top + r.height / 2 - m.height / 2, Y1 - m.height));
      p = { left: r.right + gap, top, at: "right", arrow: r.top + r.height / 2 - top };
    } else {
      const left = Math.max(X0, Math.min(r.left + r.width / 2 - Math.min(m.width / 2, 24), X1 - m.width));
      const mid = r.left + Math.min(r.width / 2, 24);
      const below = r.bottom + gap + m.height <= Y1 || r.top - gap - m.height < Y0;
      p = { left, top: below ? r.bottom + gap : r.top - gap - m.height, at: below ? "below" : "above", arrow: Math.max(10, Math.min(m.width - 10, mid - left)) };
    }
    if (!pos || p.left !== pos.left || p.top !== pos.top || p.at !== pos.at || p.arrow !== pos.arrow) setPos(p);
  });
  if (!c || !view) return null;
  const style = (pos
    ? { left: `${pos.left}px`, top: `${pos.top}px`, "--arrow": `${pos.arrow}px` }
    : { left: "0px", top: "0px", visibility: "hidden" }) as Record<string, string>;
  return (
    <div ref={box} id={BUBBLE_ID} role="tooltip" class={`tip ${view.tone ?? "gold"} ${pos?.at ?? ""}`} style={style}>
      {view.body}
    </div>
  );
}
