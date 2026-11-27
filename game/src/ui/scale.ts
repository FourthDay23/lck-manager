// App-wide screen scale (a CSS zoom on <html>), chosen per device.
//
// Galmuri pixel fonts are drawn on a pixel grid, so they are sharpest when one CSS pixel is a whole number of
// device pixels; at Windows 125% (devicePixelRatio 1.25) glyphs are a little soft, and below one device pixel per
// CSS pixel (zoomed out under 100%) glyph pixels merge and strokes break. The automatic scale keeps the size the
// system and the browser ask for, except that it never goes under one device pixel per CSS pixel. It does not
// shrink a 125% / 150% screen to 1:1 (0.8 / 0.667): that was sharp but made the text too small to read (user, 11-27). Fitting the start screen's
// footer and the match map to the window is done by layout (start.css, MatchView), not by zoom. The settings offer
// fixed sizes, with the sharp ones for this screen marked.
//
// Under the zoom, 100vh / 100vw are zoomed too and getBoundingClientRect() returns screen pixels, while lengths set
// in styles are zoomed: size things to the window with var(--app-h) / var(--app-w) (or appH() / appW()), and turn a
// measured rectangle into style lengths with localRect().

/** "auto", or a fixed zoom on top of the browser's own scale (1 = as the browser shows it) */
export type ScaleMode = "auto" | number;

const KEY = "lckmgr_ui_scale";
/** fixed choices offered in the settings (the crisp ones for this device are added and marked there) */
export const SCALE_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.33, 1.5];

let mode: ScaleMode = readMode();
let zoom = 1;
const subs = new Set<() => void>();

function readMode(): ScaleMode {
  try {
    const v = localStorage.getItem(KEY);
    if (!v || v === "auto") return "auto";
    const n = Number(v);
    return n >= 0.5 && n <= 2 ? n : "auto";
  } catch {
    return "auto";
  }
}

/** a whole number of device pixels per CSS pixel (and at least one) at this zoom */
export function isCrisp(z: number, dpr = window.devicePixelRatio || 1): boolean {
  const k = z * dpr;
  return Math.round(k) >= 1 && Math.abs(k - Math.round(k)) < 0.02;
}

/**
 * The automatic zoom: 1 (the size the system and the browser ask for, so Ctrl + / − work as usual), but back up to
 * one device pixel per CSS pixel when the browser is zoomed out under that (a 100% screen at 80% -> 1.25).
 */
export function autoZoom(dpr: number): number {
  return dpr < 1 ? 1 / dpr : 1;
}

export const scaleMode = () => mode;
/** the zoom in use now */
export const uiZoom = () => zoom;
/** the window's height / width in the app's CSS pixels (after the zoom) */
export const appH = () => window.innerHeight / zoom;
export const appW = () => window.innerWidth / zoom;
/** an element's box in the app's CSS pixels (getBoundingClientRect gives screen pixels under the zoom) */
export function localRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  return new DOMRect(r.x / zoom, r.y / zoom, r.width / zoom, r.height / zoom);
}
/** convert a screen-pixel rectangle (from getBoundingClientRect) to the app's CSS pixels */
export function toLocal(r: DOMRect): DOMRect {
  return new DOMRect(r.x / zoom, r.y / zoom, r.width / zoom, r.height / zoom);
}
/** run `f` after every change of scale; returns the unsubscribe */
export function onScale(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

export function applyScale() {
  const dpr = window.devicePixelRatio || 1;
  // innerWidth / innerHeight are the browser's window in CSS px: the zoom on <html> does not change them
  const w = window.innerWidth, h = window.innerHeight;
  zoom = mode === "auto" ? autoZoom(dpr) : mode;
  const root = document.documentElement;
  root.style.zoom = Math.abs(zoom - 1) < 1e-4 ? "" : String(zoom);
  root.style.setProperty("--app-h", `${h / zoom}px`);
  root.style.setProperty("--app-w", `${w / zoom}px`);
  // window height bucket for layouts that tighten up on short screens (start.css): s < 760 <= m < 960 <= l
  const lh = h / zoom;
  root.dataset.vh = lh < 760 ? "s" : lh < 960 ? "m" : "l";
  for (const f of subs) f();
}

export function setScaleMode(m: ScaleMode) {
  mode = m;
  try {
    localStorage.setItem(KEY, String(m));
  } catch {
    // private mode: the choice lasts until the page is closed
  }
  applyScale();
}

/** once at start: apply, and again when the window, the browser zoom or the screen (devicePixelRatio) changes */
export function initScale() {
  applyScale();
  addEventListener("resize", applyScale);
  // moving the window to a screen with another scaling changes devicePixelRatio, not always with a resize
  const watch = () => {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", () => { applyScale(); watch(); }, { once: true });
  };
  watch();
}
