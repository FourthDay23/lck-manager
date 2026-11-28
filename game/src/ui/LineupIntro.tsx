// The lineup card between the draft and the game, like the broadcast's: blue on the left, red on the right, one row
// per lane from top to support. Each row is a strip of the champion's splash art (drawn small and blown up, so it
// sits with the pixel UI), the champion's name and "TEAM Player", with the lane's icon down the middle. The rows
// slide in from either side, top first, hold for a moment, and the game starts. A click or any key starts it at once.
// With "reduce motion" on (prefers-reduced-motion) it shows still and goes on after the same pause.
// MatchView shows it over the match, whose clock waits until it is gone: only when the game is watched, never on
// "결과만 보기" or another flow that skips the match screen.
import { useEffect, useRef, useState } from "preact/hooks";
import { D, S } from "../store";
import { ROLES } from "../data/types";
import type { Role } from "../data/types";
import { champSplash } from "../data/load";
import type { Engine } from "../match/engine";
import type { SeriesInfo } from "./Scorebar";
import { TeamLogo } from "./components";
import "./lineup-intro.css";

/** ms: the five rows are in by about 1.1 s; the card stays until HOLD, then slides out (OUT) */
const HOLD = 2700, OUT = 260;
/** how big one pixel of the art is, in CSS px */
const ART_PX = 3;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** the images being preloaded, kept so they are not collected (and their download dropped) before the card opens */
const preloaded = new Map<string, HTMLImageElement>();
/** Start loading the splash arts (when the draft is done), so the card has them when it opens. */
export function preloadSplashes(ids: (string | undefined)[]) {
  if (preloaded.size > 40) preloaded.clear();
  for (const id of ids) {
    if (!id || preloaded.has(id)) continue;
    const img = new Image();
    img.src = champSplash(id);
    preloaded.set(id, img);
  }
}

/** the lane icons on a 16×16 pixel grid (shown at whole multiples), after the game's position icons: top and bottom
 *  corners with their square, mid's diagonal, a pine for the jungle, a shield with a cross for support */
const LANE_ICON: Record<Role, string> = {
  Top: "M1 1h14v3H4v11H1z M7 7h4v4H7z",
  Jungle: "M7 1h2v2h2v2h2v2h-2v2h3v2H2V9h3V7H3V5h2V3h2z M7 11h2v4H7z",
  Mid: "M12 1h3v3h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H1v-3h1v-1h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2h1z M1 1h6v3H4v3H1z M15 15H9v-3h3V9h3z",
  Bot: "M15 15H1v-3h11V1h3z M5 5h4v4H5z",
  Support: "M2 1h12v8l-6 6-6-6z M7 3v2H5v2h2v2h2V7h2V5H9V3z",
};
export function LaneIcon({ role, size = 32 }: { role: Role; size?: number }) {
  return (
    <svg class="lane-ic" width={size} height={size} viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
      <path d={LANE_ICON[role]} fill="currentColor" fill-rule="evenodd" />
    </svg>
  );
}

/** The champion's splash in the strip's shape: the upper part, a little right of centre, where most splashes have the
 *  champion; drawn at one canvas pixel per ART_PX CSS px and shown blown up (image-rendering: pixelated). */
function SplashArt({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const cv = ref.current;
    const box = cv?.parentElement;
    if (!cv || !box) return;
    const bw = Math.max(1, box.clientWidth), bh = Math.max(1, box.clientHeight);
    cv.width = Math.max(8, Math.round(bw / ART_PX));
    cv.height = Math.max(4, Math.round(bh / ART_PX));
    const img = new Image();
    let live = true;
    img.onload = () => {
      if (!live) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const w = img.naturalWidth, h = img.naturalHeight, a = cv.width / cv.height;
      let cw = w, ch = cw / a;
      if (ch > h * 0.62) { ch = h * 0.62; cw = ch * a; }
      const sx = Math.min(w - cw, Math.max(0, w * 0.56 - cw / 2));
      const sy = Math.min(h - ch, Math.max(0, h * 0.3 - ch / 2));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cv.width, cv.height);
      setReady(true);
    };
    img.src = champSplash(id);
    return () => { live = false; };
  }, [id]);
  return <canvas ref={ref} class={`li-art ${ready ? "ready" : ""}`} />;
}

export function LineupIntro({ e, series, onDone }: { e: Engine; series?: SeriesInfo; onDone: () => void }) {
  const s = S();
  const data = D();
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };
  useEffect(() => {
    const still = reduced();
    const t1 = setTimeout(() => (still ? finish() : setLeaving(true)), HOLD);
    const t2 = still ? 0 : setTimeout(finish, HOLD + OUT);
    // any key starts the game now (the click is on the card itself)
    const onKey = (ev: KeyboardEvent) => {
      // (not the browser's own shortcuts: reload, devtools, zoom)
      if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || /^F\d+$/.test(ev.key) || ["Shift", "Control", "Alt", "Meta"].includes(ev.key)) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    };
    addEventListener("keydown", onKey, true);
    return () => { clearTimeout(t1); if (t2) clearTimeout(t2); removeEventListener("keydown", onKey, true); };
  }, []);
  const strip = (side: 0 | 1, r: Role, i: number) => {
    const u = e.units.find((x) => x.side === side && x.role === r);
    const team = s.teams[e.teamIds[side]];
    return (
      <div class={`li-strip ${side ? "red" : "blue"}`} style={`--i:${i}`}>
        <div class="li-art-box">{u && <SplashArt id={u.champ.id} />}</div>
        <div class="li-text">
          <span class="li-champ">{u ? data.champ.get(u.champ.id)?.name ?? u.champ.name : "-"}</span>
          <b class="li-name"><span class="li-team">{team?.short ?? e.names[side]}</span> {u?.name ?? "-"}</b>
        </div>
      </div>
    );
  };
  return (
    <div class={`li ${leaving ? "out" : ""}`} onClick={finish} role="dialog" aria-label="양 팀 라인업">
      <div class="li-head">
        <span class="li-side blue"><TeamLogo id={e.teamIds[0]} size={30} /><b>{s.teams[e.teamIds[0]]?.short}</b></span>
        <span class="li-title">
          <small>{series ? `${series.label} · ${series.game}` : "라인업"}</small>
          <b>LINEUP</b>
        </span>
        <span class="li-side red"><b>{s.teams[e.teamIds[1]]?.short}</b><TeamLogo id={e.teamIds[1]} size={30} /></span>
      </div>
      <div class="li-board">
        {ROLES.map((r, i) => (
          <>
            {strip(0, r, i)}
            <div class="li-lane" style={`--i:${i}`}><LaneIcon role={r} /></div>
            {strip(1, r, i)}
          </>
        ))}
      </div>
      <div class="li-hint">화면을 누르거나 아무 키나 누르면 바로 시작합니다</div>
    </div>
  );
}
