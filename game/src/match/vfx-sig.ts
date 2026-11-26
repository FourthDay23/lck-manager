// Signature looks for a few iconic spells; every other spell keeps the shared shapes in vfx.ts.
// A signature swaps the generic shape for one of ten motifs. Positions follow the same Fx contract as vfx.ts
// (dash/blink: x,y = landing, tx,ty = start; otherwise x,y = caster, tx,ty = aim point; to = main target), and each
// motif lands at the same share T of its lifetime as the generic shape would, so the hit flashes stay in sync.
// The team colour still edges every motif; the signature colour fills it.
import type { Engine } from "./engine";
import type { LiveFx, SkillFx } from "./vfx";

export const TEAM = ["#4aa3ff", "#ff5a5a"] as const;
export const TEAM_HI = ["#d2eaff", "#ffd6d6"] as const;
export const INK = "#05070d";
export const GOLD = "#ffd36b";

export type Motif = "hook" | "missile" | "beam" | "skyfall" | "shockwave" | "slash" | "tornado" | "boomerang" | "charge" | "bind";

export const MOTIF_KO: Record<Motif, string> = {
  hook: "갈고리", missile: "대형 투사체", beam: "광선", skyfall: "낙하", shockwave: "충격파",
  slash: "베기", tornado: "회오리", boomerang: "부메랑", charge: "돌진 충격", bind: "속박",
};

export interface Sig {
  motif: Motif;
  /** the motif's own colour (the team colour still edges it) */
  col: string;
  /** variant: missile arrow | rocket, skyfall pillar | meteor, boomerang blade | orb */
  style?: string;
  /** keep the spell's secondary effect (Jarvan IV R's arena wall); otherwise the motif replaces it */
  keepAlso?: boolean;
}

const S = (motif: Motif, col: string, style?: string, keepAlso?: boolean): Sig => ({ motif, col, style, keepAlso });

/** Champion id + spell key -> look. Picked from the most-played pro champions plus the best-known spells. */
export const SIG: Record<string, Sig> = {
  // thrown and reeled back in
  "Blitzcrank.Q": S("hook", "#ffd84a"),
  "Thresh.Q": S("hook", "#5dff9e"),
  "Pyke.Q": S("hook", "#5ee6d0"),
  "Nautilus.Q": S("hook", "#ffb066"),
  // big projectiles
  "Ashe.R": S("missile", "#9ee7ff", "arrow"),
  "Varus.Q": S("missile", "#c77dff", "arrow"),
  "Jinx.R": S("missile", "#ff6ad5", "rocket"),
  "Corki.R": S("missile", "#ffb347", "rocket"),
  // beams
  "Lux.R": S("beam", "#fff3b0"),
  "Ezreal.R": S("beam", "#ffd36b"),
  "Viktor.E": S("beam", "#ff9a3c"),
  "Velkoz.R": S("beam", "#d86bff"),
  // from the sky
  "Leona.R": S("skyfall", "#ffd36b", "pillar"),
  "Karthus.R": S("skyfall", "#9cffd8", "pillar"),
  "Pantheon.R": S("skyfall", "#ffa040", "meteor"),
  "Ziggs.R": S("skyfall", "#ff7a3c", "meteor"),
  "Xerath.R": S("skyfall", "#7fb0ff", "meteor"),
  "Galio.R": S("skyfall", "#9ec8ff", "meteor"),
  "Annie.R": S("skyfall", "#ff6a3c", "meteor"),
  // shockwaves
  "Orianna.R": S("shockwave", "#8fd8ff"),
  "Amumu.R": S("shockwave", "#7dff9a"),
  "Neeko.R": S("shockwave", "#ff8ad8"),
  "Alistar.Q": S("shockwave", "#c8b0ff"),
  "Gragas.R": S("shockwave", "#ffb070"),
  // blades
  "Yasuo.R": S("slash", "#bfe8ff"),
  "Yone.R": S("slash", "#ff7a9a"),
  "Aatrox.Q": S("slash", "#ff4a5a"),
  "Riven.R": S("slash", "#8fffb0"),
  "Gwen.Q": S("slash", "#c8f4ff"),
  "Akali.R": S("slash", "#8fd0ff"),
  "Zed.R": S("slash", "#ff5a5a"),
  "LeeSin.R": S("slash", "#ffb84a"),
  // whirlwinds
  "Yasuo.Q": S("tornado", "#d8f4ff"),
  "Janna.Q": S("tornado", "#c8f0ff"),
  "Yone.Q": S("tornado", "#ffb0c0"),
  // out and back
  "Ahri.Q": S("boomerang", "#ff8ad8", "orb"),
  "Sivir.Q": S("boomerang", "#ffd080", "blade"),
  "Gnar.Q": S("boomerang", "#ffb060", "blade"),
  "Draven.R": S("boomerang", "#ff7050", "blade"),
  // charges that end in a crash
  "Malphite.R": S("charge", "#d8a070"),
  "Vi.R": S("charge", "#ff70b0"),
  "Sion.R": S("charge", "#ff5040"),
  "Hecarim.R": S("charge", "#8ff0e0"),
  "JarvanIV.R": S("charge", "#ffc040", undefined, true),
  "KSante.R": S("charge", "#ffa060"),
  // binds
  "Morgana.Q": S("bind", "#c070ff"),
  "Lux.Q": S("bind", "#fff0a0"),
  "Varus.R": S("bind", "#b060ff"),
};

/** Lifetime multiplier per motif (they have more to show than the generic shape). */
export const SIG_LIFE: Record<Motif, number> = {
  hook: 1.3, missile: 1.2, beam: 1.2, skyfall: 1.4, shockwave: 1.2, slash: 1.4, tornado: 1.2, boomerang: 1.4, charge: 1.2, bind: 1.7,
};

/** A flash, a team-coloured ring and debris flying out. k = 0..1 through the blast. */
function blast(p: SkillFx, x: number, y: number, col: string, team: string, k: number, s: number, a0: number) {
  if (k < 0.25) p.disc(x, y, (6 + k * 20) * s, "#ffffff", (1 - k / 0.25) * 0.8 * a0);
  p.disc(x, y, (8 + k * 10) * s, col, 0.4 * (1 - k) * a0);
  p.ring(x, y, (6 + k * 16) * s, team, 2, (1 - k) * a0);
  for (let i = 0; i < 8; i++) {
    const an = (i * Math.PI) / 4 + 0.3, r = (4 + k * 18) * s;
    p.box(x + Math.cos(an) * r, y + Math.sin(an) * r, 2, col, (1 - k) * a0);
  }
}

/** Dark cracks radiating on the ground. */
function cracks(p: SkillFx, x: number, y: number, r0: number, r1: number, a: number) {
  for (let i = 0; i < 6; i++) {
    const an = (i * Math.PI) / 3 + 0.4;
    p.seg(x + Math.cos(an) * r0, y + Math.sin(an) * r0, x + Math.cos(an) * r1, y + Math.sin(an) * r1, INK, 1, a, false);
  }
}

/**
 * Draw one signature effect. t = 0..1 through its life, T = when it reaches its target (same as the generic shape).
 * Ground parts go in the "under" layer, everything else "over" the champions.
 */
export function drawSig(p: SkillFx, e: Engine, f: LiveFx, sig: Sig, now: number, t: number, T: number, layer: "under" | "over") {
  const h = p.h, c = h.ctx;
  const team = TEAM[f.side], col = sig.col, a0 = f.fade, s = f.scale;
  const usz = p.unitSize();
  const x0 = h.sx(f.x), y0 = h.sy(f.y), x1 = h.sx(f.tx), y1 = h.sy(f.ty);
  switch (sig.motif) {
    case "hook": {
      if (layer !== "over") break;
      // out to the target (past it on a miss), then reeled back to wherever the caster is now
      const reach = f.miss ? 1.3 : 1;
      const ex = x0 + (x1 - x0) * reach, ey = y0 + (y1 - y0) * reach;
      const back = t > T;
      // reeled back to wherever the caster is now: back to the throw spot on a miss or a pull (Blitzcrank), or short
      // at the target when a hook-dasher (Nautilus, Thresh) was carried there by the hit
      const home = back ? p.at(e, f.from, now, f.x, f.y, false) : { x: x0, y: y0 };
      const k = back ? 1 - (t - T) / (1 - T) : t / T; // 0 at the caster, 1 at the far end
      const hx = home.x + (ex - home.x) * k, hy = home.y + (ey - home.y) * k;
      const a = (back && f.miss ? 0.6 : 1) * a0;
      const n = Math.floor(Math.hypot(hx - home.x, hy - home.y) / 5);
      for (let i = 1; i < n; i++) {
        const q = i / n;
        p.box(home.x + (hx - home.x) * q, home.y + (hy - home.y) * q, 2, col, 0.9 * a);
      }
      const ang = Math.atan2(ey - y0, ex - x0), cl = 5 * s;
      for (const side of [-1, 1]) p.seg(hx, hy, hx - Math.cos(ang + side * 0.7) * cl, hy - Math.sin(ang + side * 0.7) * cl, col, 2, a);
      p.box(hx, hy, 4 * s, team, a, "#ffffff");
      if (!f.miss && t > T && t < T + 0.15) p.ring(x1, y1, (4 + ((t - T) / 0.15) * 8) * s, col, 2, (1 - (t - T) / 0.15) * a0);
      break;
    }
    case "missile": {
      if (layer !== "over") break;
      // flies through the aim point: a landed skillshot stops there with a blast, a miss or global shot keeps going
      const ang = Math.atan2(y1 - y0, x1 - x0), ca = Math.cos(ang), sa = Math.sin(ang);
      const d = Math.hypot(x1 - x0, y1 - y0);
      const stop = f.kind !== "global" && !f.miss;
      const k = t / T; // 1 at the target
      const dist = (stop ? Math.min(1, k) : k) * d;
      const hx = x0 + ca * dist, hy = y0 + sa * dist;
      const a = (t < 0.8 ? 1 : (1 - t) / 0.2) * a0;
      if (!stop || k < 1) {
        if (sig.style === "rocket") {
          const L = 9 * s, bx = hx - ca * L, by = hy - sa * L;
          for (let i = 1; i <= 5; i++) {
            const q = dist - L - i * 7 * s;
            if (q < 0) break;
            p.box(x0 + ca * q, y0 + sa * q, 3 + i * 0.6, "#8a8f9c", (0.55 - i * 0.09) * a);
          }
          p.seg(bx, by, hx, hy, team, 5 * s, a);
          p.seg(bx, by, hx, hy, col, 3 * s, a, false);
          p.box(hx, hy, 3 * s, "#ffffff", a);
          p.box(bx - ca * 2, by - sa * 2, 3 * s, Math.floor(now / 60) % 2 ? "#ffd36b" : "#ff7a3c", a);
        } else {
          const L = 12 * s, bx = hx - ca * L, by = hy - sa * L;
          const tail = Math.max(0, dist - 40 * s);
          p.seg(x0 + ca * tail, y0 + sa * tail, bx, by, col, 1, 0.5 * a, false);
          p.seg(bx, by, hx, hy, col, 2 * s, a);
          const hw = 4 * s;
          const head = () => {
            c.moveTo(hx + ca * hw, hy + sa * hw);
            c.lineTo(hx - sa * hw * 0.8, hy + ca * hw * 0.8);
            c.lineTo(hx + sa * hw * 0.8, hy - ca * hw * 0.8);
            c.closePath();
          };
          p.stroke(head, team, 1, a);
          c.globalAlpha = a;
          c.fillStyle = "#ffffff";
          c.beginPath(); head(); c.fill();
        }
      }
      if (stop && k >= 1) blast(p, x1, y1, col, team, (t - T) / (1 - T), s, a0);
      break;
    }
    case "beam": {
      if (layer !== "over") break;
      // charge: a dashed aim line and a glow growing at the caster; then the beam fires down the whole line
      const ang = Math.atan2(y1 - y0, x1 - x0), ca = Math.cos(ang), sa = Math.sin(ang);
      const d = Math.hypot(x1 - x0, y1 - y0);
      const L = f.kind === "global" ? d + 600 : Math.max(60, d * 1.6);
      const ex = x0 + ca * L, ey = y0 + sa * L;
      const fire = T * 0.8;
      if (t < fire) {
        const k = t / fire;
        c.setLineDash([4, 3]);
        p.seg(x0, y0, ex, ey, col, 1, (0.45 + 0.35 * Math.sin(now / 50)) * a0, false);
        c.setLineDash([]);
        p.disc(x0, y0, (2 + k * 4) * s, col, 0.9 * a0);
        p.ring(x0, y0, (2 + k * 4) * s + 1, team, 1, a0);
      } else {
        const k = (t - fire) / (1 - fire);
        const w = Math.max(4, Math.min(10, h.len(f.w || 120))) * s * (k < 0.1 ? 1.4 : 1);
        const a = (1 - k) * a0;
        p.seg(x0, y0, ex, ey, team, w + 2, a);
        p.seg(x0, y0, ex, ey, col, w, a, false);
        p.seg(x0, y0, ex, ey, "#ffffff", Math.max(1, w / 3), a, false);
      }
      break;
    }
    case "skyfall": {
      // a shadow marks the spot, something drops from above, then it hits
      // usually the aim point; for a self-cast aimed at the caster (Karthus R) the enemy main target instead.
      // vfx.ts moves such a cast onto the first champion it hit as soon as a hit arrives.
      const enemyTo = f.to !== undefined && e.units[f.to] !== undefined && e.units[f.to].side !== f.side;
      const selfAimed = Math.hypot(f.tx - f.x, f.ty - f.y) < 1;
      const g = selfAimed && enemyTo ? p.at(e, f.to, now, f.tx, f.ty, false) : { x: x1, y: y1 };
      const R = Math.min(34, Math.max(8, h.len(f.r || 300)) * s);
      if (layer === "under") {
        if (t < T) {
          p.disc(g.x, g.y, R * (t / T), INK, 0.35 * a0);
          c.setLineDash([3, 2]);
          p.ring(g.x, g.y, R, team, 1, 0.9 * a0);
          c.setLineDash([]);
        } else {
          const k = (t - T) / (1 - T);
          p.disc(g.x, g.y, R, col, 0.3 * (1 - k) * a0);
          cracks(p, g.x, g.y, R * 0.3, R * 0.9, 0.7 * (1 - k) * a0);
        }
        break;
      }
      if (t < T) {
        const k = t / T;
        if (sig.style === "pillar") {
          // a column of light narrowing onto the spot
          const w = R * (1.2 - k * 0.6);
          c.globalAlpha = (0.2 + 0.35 * k) * a0;
          c.fillStyle = col;
          c.fillRect(Math.round(g.x - w / 2), Math.round(g.y - 160), Math.round(w), 160);
          c.globalAlpha = (0.3 + 0.5 * k) * a0;
          c.fillStyle = "#ffffff";
          c.fillRect(Math.round(g.x - w / 6), Math.round(g.y - 160), Math.max(1, Math.round(w / 3)), 160);
        } else {
          // a burning rock falling in at an angle, with a tail
          const drop = (1 - k * k) * 70;
          const mx = g.x - drop * 0.5, my = g.y - drop; // in from the upper left, over the fight rather than off its edge
          p.seg(mx - 12 * s, my - 18 * s, mx, my, col, 4 * s, 0.6 * a0);
          p.disc(mx, my, 7 * s, INK, a0);
          p.disc(mx, my, 6 * s, col, a0);
          p.disc(mx - 2, my - 2, 2.5 * s, "#ffffff", a0);
        }
      } else {
        const k = (t - T) / (1 - T);
        blast(p, g.x, g.y, col, team, k, s * 1.4, a0);
        p.ring(g.x, g.y, R * (1 + k * 0.3), team, 2, (1 - k) * a0);
        if (sig.style === "pillar" && k < 0.4) {
          const w = R * 0.6;
          c.globalAlpha = (1 - k / 0.4) * 0.8 * a0;
          c.fillStyle = "#ffffff";
          c.fillRect(Math.round(g.x - w / 2), Math.round(g.y - 160), Math.round(w), 160);
        }
      }
      break;
    }
    case "shockwave": {
      // energy gathers in, then rings race out over cracked ground. Centre: the engine's aim point, which is the
      // caster itself for auras cast around the caster (Alistar Q, Amumu R)
      const cp = f.kind === "self" ? p.at(e, f.from, now, f.x, f.y, false) : { x: x1, y: y1 };
      const R = Math.min(36, Math.max(10, h.len(f.r || 300)) * s);
      const wind = T * 0.7;
      if (t < wind) {
        if (layer !== "over") break;
        const k = t / wind;
        for (let i = 0; i < 8; i++) {
          const an = (i * Math.PI) / 4 + now / 300, r = R * 1.2 * (1 - k);
          p.box(cp.x + Math.cos(an) * r, cp.y + Math.sin(an) * r, 2, col, a0);
        }
        p.disc(cp.x, cp.y, 2 + k * 3, col, a0);
        break;
      }
      const k = (t - wind) / (1 - wind);
      if (layer === "under") {
        p.disc(cp.x, cp.y, R * Math.min(1, k * 3), col, 0.3 * (1 - k) * a0);
        cracks(p, cp.x, cp.y, R * 0.25, R * (0.5 + 0.4 * Math.min(1, k * 2)), 0.6 * (1 - k) * a0);
      } else {
        for (let j = 0; j < 3; j++) {
          const kj = k - j * 0.12;
          if (kj > 0) p.ring(cp.x, cp.y, R * (0.3 + kj), j === 0 ? team : col, j === 0 ? 2 : 1, (1 - kj) * a0);
        }
        if (k < 0.2) p.disc(cp.x, cp.y, R * 0.4, "#ffffff", (1 - k / 0.2) * 0.7 * a0);
      }
      break;
    }
    case "slash": {
      if (layer !== "over") break;
      // a streak toward the target, then crescent cuts across it (four for an ultimate)
      const tg = f.to !== undefined ? p.at(e, f.to, now, f.tx, f.ty) : { x: x1, y: y1, alive: true };
      if (t < T) {
        const from = f.kind === "dash" || f.kind === "blink" ? { x: x1, y: y1 } : { x: x0, y: y0 };
        const k = t / T;
        p.seg(from.x, from.y, from.x + (tg.x - from.x) * k, from.y + (tg.y - from.y) * k, col, 2, 0.8 * a0);
        break;
      }
      const n = f.key === "R" ? 4 : 3, span = (1 - T) / n;
      const r = usz * 0.75 * s;
      for (let i = 0; i < n; i++) {
        const k = (t - T - i * span * 0.7) / (span * 1.6);
        if (k < 0 || k > 1) continue;
        const base = (((f.id * 37 + i * 71) % 180) * Math.PI) / 180, sweep = 1.6 * Math.min(1, k * 2);
        const a = (1 - k) * a0;
        p.stroke(() => c.arc(tg.x, tg.y, r, base, base + sweep), "#ffffff", 3, a);
        p.stroke(() => c.arc(tg.x, tg.y, Math.max(1, r - 2), base + 0.1, base + Math.max(0.1, sweep - 0.1)), col, 1, a, false);
      }
      if (t - T < 0.15) p.ring(tg.x, tg.y, usz / 2 + 2, team, 2, (1 - (t - T) / 0.15) * a0);
      break;
    }
    case "tornado": {
      if (layer !== "over") break;
      // a spinning funnel travelling down the line, kicking up dust
      const reach = f.miss ? 1.4 : 1;
      const k = Math.min(1, t / T);
      const hx = x0 + (x1 - x0) * k * reach, hy = y0 + (y1 - y0) * k * reach;
      const a = (t < T ? 1 : 1 - (t - T) / (1 - T)) * a0;
      for (let i = 1; i <= 3; i++) {
        const q = Math.max(0, k - i * 0.08) * reach;
        p.box(x0 + (x1 - x0) * q, y0 + (y1 - y0) * q, 3, "#c8c0a8", (0.5 * a) / i);
      }
      // widening upward, the top ring in the team colour
      for (let j = 0; j < 3; j++) {
        const rr = 8 * s * (0.55 + j * 0.3), yy = hy - j * 4 * s, sp = now / 70 + j * 2;
        p.stroke(() => c.arc(hx, yy, rr, sp, sp + 3.6), j === 2 ? team : col, 2, a);
      }
      break;
    }
    case "boomerang": {
      if (layer !== "over") break;
      // out to the far end, then back to wherever the caster is now
      const reach = f.miss ? 1.25 : 1;
      const ex = x0 + (x1 - x0) * reach, ey = y0 + (y1 - y0) * reach;
      const back = t > T;
      const k = back ? (t - T) / (1 - T) : t / T;
      const home = back ? p.at(e, f.from, now, f.x, f.y) : { x: x0, y: y0 };
      const hx = back ? ex + (home.x - ex) * k : x0 + (ex - x0) * k;
      const hy = back ? ey + (home.y - ey) * k : y0 + (ey - y0) * k;
      const a = (back && k > 0.85 ? (1 - k) / 0.15 : 1) * a0;
      if (sig.style === "orb") {
        p.disc(hx, hy, 5 * s, INK, a);
        p.disc(hx, hy, 4 * s, col, a);
        p.disc(hx, hy, 2 * s, "#ffffff", a);
        p.ring(hx, hy, 5 * s + 1, team, 1, a, false);
        for (let i = 0; i < 3; i++) {
          const an = now / 90 + i * 2.1;
          p.box(hx + Math.cos(an) * 8 * s, hy + Math.sin(an) * 8 * s, 2, col, a);
        }
      } else {
        const sp = now / 40, L = 8 * s;
        for (const off of [0, Math.PI / 2]) {
          p.seg(hx - Math.cos(sp + off) * L, hy - Math.sin(sp + off) * L, hx + Math.cos(sp + off) * L, hy + Math.sin(sp + off) * L, col, 3, a);
        }
        p.box(hx, hy, 4, team, a, "#ffffff");
      }
      break;
    }
    case "charge": {
      // a thick streak with speed lines to the landing spot (x,y), then a crash there
      const R = Math.min(30, Math.max(12, h.len(f.r || 300)) * s);
      if (t < T) {
        if (layer !== "over") break;
        const k = t / T;
        const hx = x1 + (x0 - x1) * k, hy = y1 + (y0 - y1) * k;
        const ang = Math.atan2(y0 - y1, x0 - x1), nx = -Math.sin(ang), ny = Math.cos(ang);
        p.seg(x1, y1, hx, hy, team, 5 * s, 0.8 * a0);
        p.seg(x1, y1, hx, hy, col, 3 * s, a0, false);
        for (const o of [-6, 6]) {
          p.seg(x1 + nx * o + (hx - x1) * 0.4, y1 + ny * o + (hy - y1) * 0.4, hx + nx * o, hy + ny * o, "#ffffff", 1, 0.7 * a0, false);
        }
        p.disc(hx, hy, 5 * s, col, a0);
        break;
      }
      const k = (t - T) / (1 - T);
      if (layer === "under") {
        p.disc(x0, y0, R * Math.min(1, k * 4), col, 0.35 * (1 - k) * a0);
        cracks(p, x0, y0, R * 0.2, R * 0.8, 0.7 * (1 - k) * a0);
      } else {
        p.seg(x1, y1, x0, y0, col, 2, 0.5 * (1 - k) * a0, false);
        blast(p, x0, y0, col, team, k, s, a0);
        p.ring(x0, y0, R * (0.4 + k * 0.8), team, 2, (1 - k) * a0);
      }
      break;
    }
    case "bind": {
      if (layer !== "over") break;
      // an orb on a line; if it lands, chains circle the target until it breaks free
      const fly = f.miss ? 0.7 : T, reach = f.miss ? 1.5 : 1;
      if (t < fly || f.miss) {
        const k = Math.min(1, t / fly);
        const hx = x0 + (x1 - x0) * k * reach, hy = y0 + (y1 - y0) * k * reach;
        const a = (f.miss && t > fly ? 1 - (t - fly) / (1 - fly) : 1) * a0;
        const k0 = Math.max(0, k - 0.3) * reach;
        p.seg(x0 + (x1 - x0) * k0, y0 + (y1 - y0) * k0, hx, hy, col, 2, 0.6 * a, false);
        p.disc(hx, hy, 5 * s, INK, a);
        p.disc(hx, hy, 4 * s, col, a);
        p.disc(hx, hy, 1.5 * s, "#ffffff", a);
        p.ring(hx, hy, 5 * s + 1, team, 1, a, false);
        break;
      }
      const tg = p.at(e, f.to, now, f.tx, f.ty);
      if (!tg.alive) break;
      const k = (t - fly) / (1 - fly);
      const a = (k > 0.8 ? (1 - k) / 0.2 : 1) * a0;
      const r = usz / 2 + 4;
      p.stroke(() => c.ellipse(tg.x, tg.y, r, r * 0.7, 0, 0, Math.PI * 2), col, 1, 0.8 * a, false);
      for (let i = 0; i < 8; i++) {
        const an = now / 200 + (i * Math.PI) / 4;
        p.box(tg.x + Math.cos(an) * r, tg.y + Math.sin(an) * r * 0.7, 3, team, a, col);
      }
      break;
    }
  }
  c.globalAlpha = 1;
}
