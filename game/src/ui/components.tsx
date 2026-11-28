import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { champImg } from "../data/load";
import { hash32 } from "../core/rng";
import { money } from "../core/format";
import { store, S, D } from "../store";
import { ovr } from "../core/player";
import "./logo.css";

// ---------- team logos ----------
// Every logo sits on the same white tile so all teams look alike and dark marks (Dplus Kia) stay visible on the dark UI.
// The PNGs already carry their margin and a common visual size (scripts/fit_team_logos.py), so the tile has no padding.
// They are drawn smooth, not pixelated: nearest-neighbour shrinking of a 256 px logo to 16-56 px breaks thin lines.

/** srcset for logos/<ID>.png: the fitting script also writes <ID>@32/@64/@128.png. */
function logoSrcSet(logo: string): string | undefined {
  const m = /^(logos\/[^/@]+)\.png$/.exec(logo);
  if (!m) return undefined;
  return `data/${m[1]}@32.png 32w, data/${m[1]}@64.png 64w, data/${m[1]}@128.png 128w, data/${logo} 256w`;
}

/** A logo (or a colored badge when there is no logo file) for any team record, with or without a game loaded. */
export function LogoBox({ logo, colors, short, size = 28 }: { logo: string | null; colors: [string, string]; short: string; size?: number }) {
  if (logo) {
    return (
      <span class="logo-box" style={{ width: size, height: size }}>
        <img src={`data/${logo}`} srcset={logoSrcSet(logo)} sizes={`${size}px`} alt={short} draggable={false} />
      </span>
    );
  }
  return (
    <span class="badge-logo" style={{ width: size, height: size, background: colors[0], color: colors[1] === colors[0] ? "#fff" : colors[1], boxShadow: `inset 0 0 0 2px ${colors[1]}`, fontSize: Math.max(8, Math.round(size / 3.2)) }}>
      {short.slice(0, 4)}
    </span>
  );
}

export function TeamLogo({ id, size = 28 }: { id: string | null | undefined; size?: number }) {
  if (!id) return <span class="badge-logo" style={{ width: size, height: size, background: "#222", color: "#888" }}>FA</span>;
  const t = S().teams[id];
  if (!t) return null;
  return <LogoBox logo={t.logo} colors={t.colors} short={t.short} size={size} />;
}

const SKIN = ["#f1c9a5", "#e8b991", "#d9a47a", "#c68b5e", "#f5d6b8"];
const HAIR = ["#1b1b1f", "#2b1d14", "#3b2a1d", "#5a3a20", "#14141a", "#6b4b2a", "#a0a0a8", "#c25b2f"];

/** Deterministic 12x12 pixel portrait in team colors. `bare`: no background square, for a figure standing on a scene (the event dialog's stage). */
export function avatarUrl(id: string, c1: string, c2: string, bare = false): string {
  const key = `${id}|${c1}|${c2}|${bare ? 1 : 0}`;
  const hit = avatarCache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = 12; cv.height = 12;
  const g = cv.getContext("2d")!;
  const h = hash32(id);
  const skin = SKIN[h % SKIN.length], hair = HAIR[(h >> 4) % HAIR.length];
  const style = (h >> 8) % 4;
  if (!bare) { g.fillStyle = "#141826"; g.fillRect(0, 0, 12, 12); }
  g.fillStyle = c1; g.fillRect(1, 9, 10, 3);
  g.fillStyle = c2; g.fillRect(5, 9, 2, 3);
  g.fillStyle = skin; g.fillRect(3, 3, 6, 6); g.fillRect(5, 8, 2, 1);
  g.fillStyle = hair;
  g.fillRect(3, 2, 6, 2);
  if (style === 0) { g.fillRect(2, 3, 1, 3); g.fillRect(9, 3, 1, 3); }
  if (style === 1) { g.fillRect(3, 4, 2, 1); }
  if (style === 2) { g.fillRect(2, 2, 8, 1); g.fillRect(2, 3, 1, 4); g.fillRect(9, 3, 1, 4); }
  if (style === 3) { g.fillRect(4, 1, 4, 1); }
  g.fillStyle = "#101014"; g.fillRect(4, 5, 1, 1); g.fillRect(7, 5, 1, 1);
  if ((h >> 12) % 3 === 0) { g.fillStyle = "#222"; g.fillRect(3, 5, 6, 1); g.fillStyle = "#88c"; g.fillRect(4, 5, 1, 1); g.fillRect(7, 5, 1, 1); }
  g.fillStyle = "#b56a5a"; g.fillRect(5, 7, 2, 1);
  const url = cv.toDataURL();
  avatarCache.set(key, url);
  return url;
}
const avatarCache = new Map<string, string>();

export function Avatar({ pid, size = 36, bare }: { pid: string; size?: number; bare?: boolean }) {
  const s = S();
  const p = s.players[pid];
  const t = p?.team ? s.teams[p.team] : null;
  const url = avatarUrl(pid, t?.colors[0] ?? "#3a4262", t?.colors[1] ?? "#1b1f2e", bare);
  return <img class="avatar" src={url} width={size} height={size} alt="" />;
}

/** a champion portrait; its tooltip is the champion's name (or `title`), plus the player's mastery when given */
export function ChampIcon({ id, size = 32, title, mastery }: { id: string | null | undefined; size?: number; title?: string; mastery?: number }) {
  if (!id) return <span style={{ display: "inline-block", width: size, height: size, background: "#0b0d14" }} />;
  const d = D();
  return <img class="px" src={champImg(d.ddVersion, id)} width={size} height={size} data-tip={`${title ?? d.champ.get(id)?.name ?? id}${mastery !== undefined ? `\n숙련도 ${Math.round(mastery)} / 100` : ""}`} alt={d.champ.get(id)?.name ?? ""} loading="lazy" />;
}

export function Ovr({ v }: { v: number }) {
  const cls = v >= 88 ? "s" : v >= 78 ? "a" : v >= 66 ? "b" : "c";
  return <span class={`ovr ${cls}`}>{v}</span>;
}

export function Money({ v, sign = false }: { v: number; sign?: boolean }) {
  return <span class={sign ? (v >= 0 ? "pos" : "neg") : ""}>{sign && v > 0 ? "+" : ""}{money(v)}</span>;
}

export function Bar({ v, max = 100, color }: { v: number; max?: number; color?: string }) {
  return (
    <div class="bar">
      <i style={{ width: `${Math.max(0, Math.min(100, (v / max) * 100))}%`, background: color }} />
    </div>
  );
}

export function Modal({ children, wide, onClose }: { children: ComponentChildren; wide?: boolean; onClose?: () => void }) {
  return (
    <div class="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) (onClose ?? (() => store.close()))(); }}>
      <div class={`modal frame ${wide ? "wide" : ""}`}>
        <button class="btn small x" onClick={() => (onClose ?? (() => store.close()))()}>닫기</button>
        {children}
      </div>
    </div>
  );
}

export function PName({ pid, showTeam }: { pid: string; showTeam?: boolean }) {
  const s = S();
  const p = s.players[pid];
  if (!p) return <span>-</span>;
  return (
    <a href="#" onClick={(e) => { e.preventDefault(); store.open("player", pid); }} style={{ color: "inherit", textDecoration: "none" }}>
      <b>{p.name}</b>
      {showTeam && <span class="muted"> · {p.team ? s.teams[p.team]?.short : "FA"}</span>}
    </a>
  );
}

export function RoleTag({ r }: { r: string }) {
  const ko: Record<string, string> = { Top: "탑", Jungle: "정글", Mid: "미드", Bot: "원딜", Support: "서폿" };
  return <span class="tag">{ko[r] ?? r}</span>;
}

export function OvrOf({ pid }: { pid: string }) {
  return <Ovr v={ovr(S().players[pid])} />;
}

/** Small pixel trophy drawn from a character map: each letter is a color. */
const TROPHY_ART: Record<string, { map: string[]; pal: Record<string, string> }> = {
  WORLDS: {
    map: [
      "....hhhhhhhh....",
      "...hsssssssshh..",
      "..hhsWWWWWWshhh.",
      ".hh.sWWWWWWs.hh.",
      ".h..sWWWWWWs..h.",
      ".hh.sWWWWWWs.hh.",
      "..hhhsWWWWshhh..",
      "....hhsWWshh....",
      "......hssh......",
      "......hssh......",
      ".....hssssh.....",
      "....hhssssh.....",
      "...dddddddddd...",
      "...dGGGGGGGGd...",
      "...dddddddddd...",
    ],
    pal: { h: "#8d97ad", s: "#d8deea", W: "#f4f7fc", d: "#2d2a26", G: "#c9a45a" },
  },
  MSI: {
    map: [
      "......gggg......",
      ".....gGGGGg.....",
      "....gGYYYYGg....",
      "....gGYYYYGg....",
      ".....gGGGGg.....",
      "......gggg......",
      ".......gg.......",
      "......gGGg......",
      ".....gGGGGg.....",
      "....gGGGGGGg....",
      "...dddddddddd...",
      "...dbbbbbbbbd...",
      "...dddddddddd...",
    ],
    pal: { g: "#a47b22", G: "#f2c14e", Y: "#fff0b0", d: "#2a2218", b: "#4a90d8" },
  },
  PO: {
    map: [
      ".....gGGGGg.....",
      "....gGGYYGGg....",
      "...gGGGYYGGGg...",
      "...gGGGGGGGGg...",
      "....gGGGGGGg....",
      ".....gGGGGg.....",
      "......gGGg......",
      "......gGGg......",
      ".....gGGGGg.....",
      "....dddddddd....",
      "....dRRRRRRd....",
      "...dddddddddd...",
    ],
    pal: { g: "#9c741e", G: "#e8b43a", Y: "#fff4c2", d: "#231c14", R: "#c0392b" },
  },
  CUP: {
    map: [
      "...ssssssssss...",
      "..sSSSSSSSSSSs..",
      ".ss.SSSSSSSS.ss.",
      ".s..SSSSSSSS..s.",
      ".ss.SSSSSSSS.ss.",
      "..ssSSSSSSSSss..",
      "....sSSSSSSs....",
      "......sSSs......",
      "......sSSs......",
      "....dddddddd....",
      "....dBBBBBBd....",
      "....dddddddd....",
    ],
    pal: { s: "#7f8aa3", S: "#c7d0e0", d: "#20232c", B: "#3b6fd8" },
  },
  REG: {
    map: [
      "..dddddddddddd..",
      "..dGGGGGGGGGGd..",
      "..dGwwwwwwwwGd..",
      "..dGwYYYYYYwGd..",
      "..dGwwwwwwwwGd..",
      "..dGwYYYYwwwGd..",
      "..dGwwwwwwwwGd..",
      "..dGGGGGGGGGGd..",
      "..dddddddddddd..",
    ],
    pal: { d: "#2a1d10", G: "#b8862b", w: "#3b2a18", Y: "#f2c14e" },
  },
};

export function TrophyArt({ comp, scale = 6, dim }: { comp: string; scale?: number; dim?: boolean }) {
  const art = TROPHY_ART[comp] ?? TROPHY_ART.CUP;
  const w = art.map[0].length, h = art.map.length;
  return (
    <svg width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shape-rendering="crispEdges" class={dim ? "empty" : ""}>
      {art.map.flatMap((row, y) =>
        [...row].map((ch, x) => (ch === "." ? null : <rect x={x} y={y} width={1} height={1} fill={art.pal[ch] ?? "#fff"} />)),
      )}
    </svg>
  );
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
