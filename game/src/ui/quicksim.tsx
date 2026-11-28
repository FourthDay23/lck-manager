// "결과만" (quick result) runs: the engine plays a whole game without a screen. Run in one go inside the click
// handler, a set held the page for ~0.8 s and a Bo5 "시리즈 끝까지 결과만" for several seconds (T41). Here the
// same steps run in slices of about SLICE_MS, with a turn for the browser between slices (it paints the progress
// layer and stays responsive). Same steps in the same order: the result is exactly the one runToEnd() gives.
import { useEffect, useState } from "preact/hooks";
import { DRAW } from "../match/engine";
import type { Engine } from "../match/engine";

const SLICE_MS = 40;
/** The longest a game runs before the engine ends it (Engine.runToEnd's default). */
const MAX_T = 60 * 60;

interface Busy { label: string; t: number }
let busy: Busy | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

/** True while a quick run is going: buttons that start another one do nothing then. */
export function quickBusy(): boolean {
  return busy !== null;
}

// a turn for the browser without setTimeout's clamping, and without requestAnimationFrame (which stops in a
// background tab, where the run should go on)
const channel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const waiting: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => waiting.shift()?.();
function yieldToBrowser(): Promise<void> {
  return new Promise((r) => {
    if (!channel) { setTimeout(r, 0); return; }
    waiting.push(r);
    channel.port2.postMessage(0);
  });
}

/**
 * Play `e` to its end like e.runToEnd(), a slice at a time, showing `label` (e.g. "2세트") and the game clock on
 * the progress layer. Draw-only effects are not kept meanwhile (nothing shows them; results do not read them).
 */
export async function runToEndSliced(e: Engine, label: string): Promise<void> {
  busy = { label, t: 0 };
  changed();
  const keepFx = DRAW.fx;
  DRAW.fx = false;
  try {
    while (!e.over && e.t < MAX_T) {
      const t0 = performance.now();
      while (!e.over && e.t < MAX_T && performance.now() - t0 < SLICE_MS) e.step();
      busy.t = e.t;
      changed();
      await yieldToBrowser();
    }
    e.runToEnd(MAX_T); // nothing left to step: only the engine's own ending of an over-long game
  } finally {
    DRAW.fx = keepFx;
    busy = null;
    changed();
  }
}

/** The layer over the screen while a quick run is going: what is being played and how far, clicks held. */
export function QuickSimLayer() {
  const [, set] = useState(0);
  useEffect(() => {
    const l = () => set((v) => v + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (!busy) return null;
  const m = Math.floor(busy.t / 60), sec = Math.floor(busy.t % 60);
  // a typical game is about 32 minutes: the bar fills toward that and waits at the end for longer ones
  const pct = Math.min(96, (busy.t / (34 * 60)) * 100);
  return (
    <div class="quicksim-layer" role="status" aria-live="polite">
      <div class="frame pad quicksim-box">
        <div><b>{busy.label}</b> 결과 계산 중 · 경기 시간 {m}:{String(sec).padStart(2, "0")}</div>
        <div class="quicksim-bar"><div style={{ width: `${pct}%` }} /></div>
      </div>
    </div>
  );
}
