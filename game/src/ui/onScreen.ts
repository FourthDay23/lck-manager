import { useEffect, useRef } from "preact/hooks";
import { appW } from "./scale";

/**
 * Keeps a full-screen layer (position: fixed) on the part of the page being looked at. On a phone the app's layout is
 * wider than the screen, so the browser's layout viewport (what position: fixed covers) grows past it and a centred
 * dialog lands off screen; the visual viewport is what the player sees. On a desktop the two are the same.
 * Give the returned ref to the layer; its left / top / width / height follow the visual viewport.
 */
export function useOnScreen<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    const fit = () => {
      const z = window.innerWidth / appW() || 1; // the app's zoom on <html> (ui/scale.ts)
      el.style.left = `${vv.offsetLeft / z}px`;
      el.style.top = `${vv.offsetTop / z}px`;
      el.style.width = `${vv.width / z}px`;
      el.style.height = `${vv.height / z}px`;
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, []);
  return ref;
}
