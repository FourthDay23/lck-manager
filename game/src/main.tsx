import { options, render } from "preact";
import "./styles.css";
import { App } from "./ui/App";
import { TipLayer } from "./ui/Tip";
import { store } from "./store";
import { initScale } from "./ui/scale";

// Preact 11 no longer adds "px" to numeric style values, so `style={{ fontSize: 11 }}` was silently dropped.
// Add the unit here once for every element instead of rewriting every style in the UI.
const UNITLESS = /^(?:opacity|zIndex|flex|flexGrow|flexShrink|order|lineHeight|fontWeight|zoom|gridRow|gridColumn|aspectRatio)$/;
const prevVnode = options.vnode;
options.vnode = (vnode) => {
  const style = (vnode.props as { style?: unknown } | null)?.style;
  if (style && typeof style === "object") {
    const st = style as Record<string, unknown>;
    for (const k in st) {
      const v = st[k];
      if (typeof v === "number" && v !== 0 && !UNITLESS.test(k) && !k.startsWith("--")) st[k] = `${v}px`;
    }
  }
  prevVnode?.(vnode);
};

if (import.meta.env.DEV) (window as unknown as { __store: typeof store }).__store = store;

// the screen scale (ui/scale.ts) is set before the first paint, so the app does not jump in size
initScale();

render(<><App /><TipLayer /></>, document.getElementById("app")!);
