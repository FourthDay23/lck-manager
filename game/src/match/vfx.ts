// Skill effects on the match canvas. Every champion's spells follow one visual grammar so a fight reads at a glance:
//   who    — a chip with the spell icon and its key (Q/W/E/R) pops over the caster; ultimates get a gold frame and their name
//   where  — the shape (bolt, circle, cone, dash, wall…) is drawn in the caster's TEAM colour with a dark outline,
//            filled with the champion's own colour lifted so it shows on the darkened map
//   result — a spell that lands flashes the victim when the projectile gets there; a skillshot that misses flies past
// Jungle-clear casts are drawn small and faint so champion fights stand out.
import type { Engine, Fx, Unit } from "./engine";
import type { Vec } from "./map";
import type { VfxKind } from "../data/types";
import { spellImg } from "../data/load";
import { SIG, SIG_LIFE, drawSig, TEAM, TEAM_HI, INK, GOLD } from "./vfx-sig";
import type { Sig } from "./vfx-sig";

/**
 * Optional fields this layer reads on top of the engine's Fx (contract agreed with the engine side).
 * Spell fx: key/icon/also of the spell, pve for jungle/minion casts, miss when the main target dodged it.
 * "hit" fx: one per champion the spell landed on — from = caster, to = victim, key = spell key, also = "knockup" to lift them.
 * Without them, key/icon/also are looked up from the spell name in fx.text, and a spell fx with no text counts as pve.
 */
export interface SkillFields {
  key?: "Q" | "W" | "E" | "R";
  icon?: string;
  also?: VfxKind;
  pve?: boolean;
  miss?: boolean;
}
export type FxIn = Omit<Fx, "kind"> & SkillFields & { kind: Fx["kind"] | "hit" };
type Kind = FxIn["kind"];

const SPELL_KINDS = new Set<Kind>(["line", "circle", "cone", "dash", "blink", "target", "self", "shield", "heal", "zone", "global", "summon", "knockup", "wall", "stealth"]);

export interface LiveFx extends FxIn {
  born: number;
  life: number;
  /** size multiplier: ultimates bigger, jungle-clear casts smaller */
  scale: number;
  /** opacity multiplier: jungle-clear casts are faint */
  fade: number;
  /** the champion's colour, brightened */
  accent: string;
  /** a signature look for this spell (vfx-sig.ts), drawn instead of the shared shape */
  sig?: Sig;
  /** a skyfall aimed at its own caster has been moved onto the first champion it hit */
  retargeted?: boolean;
}

/** The parts of MatchRenderer the skill layer draws with. */
export interface FxHost {
  ctx: CanvasRenderingContext2D;
  cam: { size: number };
  version: string;
  sx(x: number): number;
  sy(y: number): number;
  len(w: number): number;
  /** where the unit is drawn (between engine steps), with the knock-up bob unless bob is false */
  unitPos(u: Unit, now: number, bob?: boolean): Vec;
}

interface Tag { unit: number; side: 0 | 1; key: string; icon?: string; name?: string; ult: boolean; born: number; life: number }

/** Real-time lifetime (ms) per effect. */
const LIFE: Partial<Record<Kind, number>> = {
  line: 620, global: 1100, circle: 800, cone: 560, dash: 560, blink: 560, target: 600, self: 900, shield: 1100,
  heal: 900, zone: 1800, summon: 1000, knockup: 720, wall: 1600, stealth: 900, hit: 340,
  aa: 220, tower: 220, objhit: 260, kill: 900, recall: 1200, smite: 520,
};
/** Share of the lifetime before the effect reaches its target (projectile flight, circle wind-up). */
const TRAVEL: Partial<Record<Kind, number>> = {
  line: 0.5, global: 0.4, target: 0.45, circle: 0.35, cone: 0.15, dash: 0.25, wall: 0.15, zone: 0.12, knockup: 0.1,
};
/** Share of the lifetime at which an effect of this kind lands; hits and signature motifs use the same value. */
function travelOf(kind: Kind): number {
  return TRAVEL[kind] ?? 0.08;
}
/** How far into its life a held zone/wall stays (both start fading at 0.75). */
const HOLD = 0.7;
/** Secondary effects drawn where the main one lands (a bolt that leaves a zone, a dash that ends in a slam…). */
const SECOND = new Set<Kind>(["circle", "zone", "wall", "summon", "heal", "shield", "self"]);

/** Champion colours are mid-tone; stretch them to full brightness and mix in some white so they read on the dark map. */
function lift(c: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return "#e8ecf5";
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const top = Math.max(...ch) || 1;
  const out = ch.map((v) => Math.round(Math.min(255, (v * 255) / top) * 0.75 + 255 * 0.25));
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

export class SkillFx {
  private tags: Tag[] = [];
  private icons = new Map<string, HTMLImageElement>();

  constructor(readonly h: FxHost) {}

  reset() {
    this.tags = [];
    this.loadedFor = null;
  }

  /** Start fetching every spell icon of this match up front, so a chip never shows an empty box on a first cast. */
  private loadedFor: Engine | null = null;
  private preload(e: Engine) {
    if (this.loadedFor === e) return;
    this.loadedFor = e;
    for (const u of e.units) for (const sp of u.champ.spells) if (sp.icon) this.icon(sp.icon);
  }

  /** Turn one engine effect into what gets drawn. `live` is searched so a hit waits for its own projectile. */
  ingest(raw: FxIn, now: number, live: LiveFx[], e: Engine): LiveFx[] {
    this.preload(e);
    const f: FxIn = { ...raw };
    if (SPELL_KINDS.has(f.kind) && f.from !== undefined) {
      // fill in what the engine did not send, from the caster's spell with that name
      const sp = f.text ? e.units[f.from]?.champ.spells.find((s) => s.name === f.text) : undefined;
      if (sp) {
        f.key ??= sp.key;
        f.icon ??= sp.icon;
        f.also ??= sp.also;
      }
      f.pve ??= !f.text;
    }
    const ult = f.key === "R" && !f.pve;
    const scale = f.pve ? 0.7 : ult ? 1.35 : 1;
    const fade = f.pve ? 0.5 : 1;
    const life = (LIFE[f.kind] ?? 520) * (ult ? 1.2 : 1);
    const accent = lift(f.color);
    if (f.kind === "hit") {
      // the engine rolls the hit at cast time; show it when the spell visibly arrives
      let src: LiveFx | undefined;
      for (let i = live.length - 1; i >= 0; i--) {
        const x = live[i];
        if (x.from === f.from && x.key === f.key && x.kind !== "hit") { src = x; break; }
      }
      // damage lands at cast time in the engine: a hit that already killed shows now, together with the kill effect
      const victim = f.to !== undefined ? e.units[f.to] : undefined;
      const at = victim && !victim.alive ? now : Math.max(now, src ? src.born + travelOf(src.kind) * src.life : now);
      const out: LiveFx[] = [{ ...f, born: at, life, scale, fade: 1, accent }];
      // no key on the lift: it must not be mistaken for the spell by the next victim's lookup, nor get the ult ring.
      // A knock-up spell already lifts its main target from the cast, so only the other victims get one here.
      const lifted = src?.kind === "knockup" && src.to === f.to;
      // a skyfall aimed at its own caster (Karthus R, Annie R) lands on the first champion it hit; one aimed at an ally
      // (Galio R lands on the ally it flew to, so it looks self-aimed too) stays where it is
      const aimU = src?.to !== undefined ? e.units[src.to] : undefined;
      const allyAimed = !!aimU && src!.to !== src!.from && aimU.side === src!.side;
      // a global cast on the caster itself (Galio R saving himself) is centred on him; a summon on itself (Annie R) is not
      const selfCentred = !!src && src.to === src.from && src.kind === "global";
      if (src?.sig?.motif === "skyfall" && !src.retargeted && !allyAimed && !selfCentred && Math.hypot(src.tx - src.x, src.ty - src.y) < 1) {
        src.tx = f.x;
        src.ty = f.y;
        src.retargeted = true;
      }
      if (f.also === "knockup" && !lifted) out.push({ ...f, kind: "knockup", key: undefined, born: at, life: LIFE.knockup!, scale, fade: 1, accent });
      return out;
    }
    const sig = f.key && !f.pve && f.from !== undefined ? SIG[`${e.units[f.from]?.champ.id}.${f.key}`] : undefined;
    const sLife = sig ? life * SIG_LIFE[sig.motif] : life;
    const out: LiveFx[] = [{ ...f, born: now, life: sLife, scale, fade, accent, sig }];
    if (f.key && f.from !== undefined && !f.pve) {
      this.tags = this.tags.filter((t) => t.unit !== f.from);
      this.tags.push({ unit: f.from, side: f.side, key: f.key, icon: f.icon, name: f.text, ult, born: now, life: ult ? 1600 : 950 });
      if (f.icon) this.icon(f.icon);
    }
    // a signature motif shows its own landing, so it replaces the secondary effect unless told to keep it
    if (f.also && SECOND.has(f.also) && (!sig || sig.keepAlso)) {
      // dashes and blinks land where the caster ended up; everything else where it was aimed
      const atCaster = f.kind === "dash" || f.kind === "blink";
      const kind = f.also;
      out.push({
        ...f, kind, key: undefined,
        x: atCaster ? f.tx : f.x, y: atCaster ? f.ty : f.y,
        tx: atCaster ? f.x : f.tx, ty: atCaster ? f.y : f.ty,
        to: kind === "heal" || kind === "shield" ? f.from : f.to,
        born: now + (TRAVEL[f.kind] ?? 0.1) * sLife, life: LIFE[kind] ?? 520, scale, fade, accent,
      });
    }
    return out;
  }

  private icon(file: string): HTMLImageElement {
    let img = this.icons.get(file);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous"; // Data Dragon allows CORS, so the canvas stays readable
      img.src = spellImg(this.h.version, file);
      this.icons.set(file, img);
    }
    return img;
  }

  // ---- drawing helpers: shapes get a dark outline underneath so they read on the busy map ----

  stroke(path: () => void, color: string, w: number, a: number, ink = true) {
    if (a <= 0) return;
    const c = this.h.ctx;
    if (ink) {
      c.globalAlpha = Math.min(1, a) * 0.8;
      c.strokeStyle = INK;
      c.lineWidth = w + 2;
      c.beginPath(); path(); c.stroke();
    }
    c.globalAlpha = Math.min(1, a);
    c.strokeStyle = color;
    c.lineWidth = w;
    c.beginPath(); path(); c.stroke();
  }

  ring(x: number, y: number, r: number, color: string, w: number, a: number, ink = true) {
    this.stroke(() => this.h.ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2), color, w, a, ink);
  }

  seg(x0: number, y0: number, x1: number, y1: number, color: string, w: number, a: number, ink = true) {
    const c = this.h.ctx;
    this.stroke(() => { c.moveTo(x0, y0); c.lineTo(x1, y1); }, color, w, a, ink);
  }

  disc(x: number, y: number, r: number, color: string, a: number) {
    if (a <= 0 || r <= 0) return;
    const c = this.h.ctx;
    c.globalAlpha = Math.min(1, a);
    c.fillStyle = color;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }

  /** Outlined square centred on x,y, optionally with a differently coloured core. */
  box(x: number, y: number, s: number, color: string, a: number, core?: string) {
    if (a <= 0 || s < 1) return;
    const c = this.h.ctx;
    const S = Math.max(1, Math.round(s));
    const px = Math.round(x - S / 2), py = Math.round(y - S / 2);
    c.globalAlpha = Math.min(1, a);
    c.fillStyle = INK;
    c.fillRect(px - 1, py - 1, S + 2, S + 2);
    c.fillStyle = color;
    c.fillRect(px, py, S, S);
    if (core && S >= 3) {
      c.fillStyle = core;
      c.fillRect(px + 1, py + 1, S - 2, S - 2);
    }
  }

  /** Screen position of a unit (or a fallback world point), following knock-up bobbing unless `bob` is off. */
  at(e: Engine, i: number | undefined, now: number, wx: number, wy: number, bob = true) {
    const u = i !== undefined ? e.units[i] : undefined;
    if (!u) return { x: this.h.sx(wx), y: this.h.sy(wy), alive: true };
    const p = this.h.unitPos(u, now, bob);
    return { x: this.h.sx(p.x), y: this.h.sy(p.y), alive: u.alive };
  }

  unitSize() {
    return this.h.cam.size < 9000 ? 22 : 15; // same as MatchRenderer.drawUnits
  }

  /** Ground shapes, drawn under the champions. */
  under(e: Engine, live: LiveFx[], now: number) {
    const c = this.h.ctx, h = this.h;
    this.preload(e); // every frame, not only on a new effect: the icons should be in before the first cast

    // zones/walls the engine keeps up (`until`, engine time) hold their full look until then, then fade out as usual;
    // pausing the match holds them too, since engine time stops
    for (const f of live) {
      if (f.until === undefined || e.t >= f.until || (f.kind !== "zone" && f.kind !== "wall")) continue;
      if (now - f.born > HOLD * f.life) f.born = now - HOLD * f.life;
    }
    for (const f of live) {
      if (now < f.born) continue;
      const t = Math.min(1, (now - f.born) / f.life);
      if (f.sig) {
        drawSig(this, e, f, f.sig, now, t, travelOf(f.kind), "under");
        continue;
      }
      const team = TEAM[f.side], a0 = f.fade;
      switch (f.kind) {
        case "circle": {
          const x = h.sx(f.tx), y = h.sy(f.ty);
          const R = Math.max(6, h.len(f.r)) * f.scale;
          const wind = TRAVEL.circle!;
          if (t < wind) {
            // wind-up: the area is marked and fills in, like a ground indicator
            const k = t / wind;
            this.disc(x, y, R, team, 0.14 * a0);
            this.disc(x, y, R * k, f.accent, 0.28 * a0);
            this.ring(x, y, R, team, 1, 0.9 * a0);
          } else {
            // impact: a bright flash, then a shock ring
            const k = (t - wind) / (1 - wind);
            this.disc(x, y, R, f.accent, 0.5 * (1 - k) * a0);
            if (k < 0.25) this.disc(x, y, R * 0.55, "#ffffff", 0.7 * (1 - k / 0.25) * a0);
            this.ring(x, y, R * (1 + k * 0.3), team, 2, (1 - k) * a0);
          }
          break;
        }
        case "zone": {
          // lingering area: tinted floor with a marching dashed border
          const x = h.sx(f.tx), y = h.sy(f.ty);
          const R = Math.max(6, h.len(f.r)) * f.scale * Math.min(1, t / 0.1);
          const a = (t > 0.75 ? (1 - t) / 0.25 : 1) * a0;
          this.disc(x, y, R, f.accent, 0.22 * a);
          c.setLineDash([3, 2]);
          c.lineDashOffset = -now / 80;
          this.ring(x, y, R, team, 1, 0.9 * a);
          c.setLineDash([]);
          c.lineDashOffset = 0;
          break;
        }
        case "wall": {
          // a row of blocks across the cast direction, rising out of the ground
          const cx = h.sx(f.tx), cy = h.sy(f.ty);
          const ang = Math.atan2(cy - h.sy(f.y), cx - h.sx(f.x)) + Math.PI / 2;
          const L = Math.min(70, Math.max(16, h.len(Math.max(400, f.w * 2.5))) * f.scale);
          const n = 7, bs = Math.min(6, Math.max(3, Math.round(L / n) - 1));
          const rise = Math.min(1, t / 0.15);
          const a = (t > 0.75 ? (1 - t) / 0.25 : 1) * a0;
          for (let i = 0; i < n; i++) {
            const d = (i - (n - 1) / 2) * (L / n);
            const px = cx + Math.cos(ang) * d, py = cy + Math.sin(ang) * d;
            this.box(px, py, bs * rise, team, a);
            if (rise >= 1 && a > 0) { // a lit top edge so the blocks read as standing up
              c.globalAlpha = Math.min(1, a);
              c.fillStyle = "#ffffff";
              c.fillRect(Math.round(px - bs / 2), Math.round(py - bs / 2), Math.round(bs), 1);
            }
          }
          break;
        }
        case "cone": {
          // a wedge that snaps open from the caster
          const x0 = h.sx(f.x), y0 = h.sy(f.y);
          const ang = Math.atan2(h.sy(f.ty) - y0, h.sx(f.tx) - x0);
          // a big area: filled in the team colour (a champion colour over this much ground reads as the other team)
          const L = Math.min(60, Math.max(16, h.len(Math.max(400, f.r))) * f.scale);
          const k = Math.min(1, t / 0.2);
          const a = (t < 0.2 ? 1 : 1 - (t - 0.2) / 0.8) * a0;
          const r = L * (0.55 + 0.45 * k);
          const wedge = () => { c.moveTo(x0, y0); c.arc(x0, y0, r, ang - 0.5, ang + 0.5); c.closePath(); };
          c.globalAlpha = 0.3 * a;
          c.fillStyle = team;
          c.beginPath(); wedge(); c.fill();
          this.stroke(() => c.arc(x0, y0, r * 0.7, ang - 0.4, ang + 0.4), f.accent, 1, 0.8 * a, false);
          this.stroke(wedge, team, 2, a);
          break;
        }
      }
    }
    c.globalAlpha = 1;
  }

  /** Projectiles, buffs and hit feedback, drawn over the champions. */
  over(e: Engine, live: LiveFx[], now: number) {
    const c = this.h.ctx, h = this.h;
    const usz = this.unitSize();
    for (const f of live) {
      if (now < f.born) continue;
      const t = Math.min(1, (now - f.born) / f.life);
      const team = TEAM[f.side], hi = TEAM_HI[f.side], a0 = f.fade;
      const x0 = h.sx(f.x), y0 = h.sy(f.y), x1 = h.sx(f.tx), y1 = h.sy(f.ty);
      // ultimates: a gold ring bursts off the caster
      if (f.key === "R" && !f.pve && f.kind !== "hit" && t < 0.45) {
        const k = t / 0.45;
        const cp = this.at(e, f.from, now, f.x, f.y, false); // on the caster as drawn (units are drawn between steps)
        this.ring(cp.x, cp.y, usz / 2 + 3 + k * 14, GOLD, 2, 1 - k);
      }
      if (f.sig) {
        drawSig(this, e, f, f.sig, now, t, travelOf(f.kind), "over");
        continue;
      }
      switch (f.kind) {
        case "line": {
          // a bolt with a trail; on a hit it pops at the target, on a miss it sails past and fades
          const fly = f.miss ? 0.7 : TRAVEL.line!;
          const reach = f.miss ? 1.5 : 1;
          const k = Math.min(1, t / fly);
          const hx = x0 + (x1 - x0) * k * reach, hy = y0 + (y1 - y0) * k * reach;
          const w = Math.round(Math.max(2, Math.min(5, h.len(f.w))) * f.scale);
          if (t < fly) {
            const k0 = Math.max(0, k - 0.35);
            const bx = x0 + (x1 - x0) * k0 * reach, by = y0 + (y1 - y0) * k0 * reach;
            this.seg(bx, by, hx, hy, team, w, 0.8 * a0);
            this.seg(bx, by, hx, hy, hi, Math.max(1, w - 2), 0.9 * a0, false);
            this.box(hx, hy, w + 2, "#ffffff", a0, f.accent);
          } else {
            const k2 = (t - fly) / (1 - fly);
            if (f.miss) this.box(hx, hy, w + 1, hi, (1 - k2) * 0.7 * a0);
            else this.ring(x1, y1, (3 + k2 * 9) * f.scale, team, 2, (1 - k2) * a0);
          }
          break;
        }
        case "global": {
          // a beam from the caster across the map, with a marker where it was aimed
          const ang = Math.atan2(y1 - y0, x1 - x0);
          const far = Math.hypot(x1 - x0, y1 - y0) + 600;
          const k = Math.min(1, t / 0.4);
          const a = (t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6) * a0;
          const w = Math.round(5 * f.scale);
          const ex = x0 + Math.cos(ang) * far * k, ey = y0 + Math.sin(ang) * far * k;
          this.seg(x0, y0, ex, ey, team, w, 0.85 * a);
          this.seg(x0, y0, ex, ey, "#ffffff", Math.max(1, w - 3), a, false);
          if (t > 0.3) this.ring(x1, y1, 6 + Math.sin(now / 90) * 2, team, 1, a);
          break;
        }
        case "target": {
          // a homing orb that follows the target, then a sparkle on it
          const to = this.at(e, f.to, now, f.tx, f.ty);
          const fly = TRAVEL.target!;
          if (t < fly) {
            const k = t / fly, k0 = Math.max(0, k - 0.25);
            const px = x0 + (to.x - x0) * k, py = y0 + (to.y - y0) * k;
            this.seg(x0 + (to.x - x0) * k0, y0 + (to.y - y0) * k0, px, py, team, 2, 0.7 * a0);
            this.box(px, py, 5 * f.scale, f.accent, a0, "#ffffff");
          } else {
            const k = (t - fly) / (1 - fly);
            const L = (4 + k * 6) * f.scale;
            for (let i = 0; i < 4; i++) {
              const a = (i * Math.PI) / 2;
              this.seg(to.x, to.y, to.x + Math.cos(a) * L, to.y + Math.sin(a) * L, hi, 1, (1 - k) * a0);
            }
          }
          break;
        }
        case "dash": {
          // x,y = where the caster ended up, tx,ty = where it started: a streak with fading after-images
          const a = (1 - t) * a0;
          this.seg(x1, y1, x0, y0, team, Math.round(3 * f.scale), 0.8 * a);
          this.seg(x1, y1, x0, y0, hi, 1, a, false);
          const s = Math.round(usz * 0.6);
          for (let i = 1; i <= 3; i++) {
            const k = i / 4;
            c.globalAlpha = 0.6 * a * k;
            c.strokeStyle = f.accent;
            c.lineWidth = 1;
            c.strokeRect(Math.round(x1 + (x0 - x1) * k - s / 2) + 0.5, Math.round(y1 + (y0 - y1) * k - s / 2) + 0.5, s, s);
          }
          break;
        }
        case "blink": {
          // a dotted hop with a ring at both ends
          const a = (1 - t) * a0;
          c.setLineDash([2, 3]);
          this.seg(x1, y1, x0, y0, hi, 1, 0.8 * a, false);
          c.setLineDash([]);
          this.ring(x1, y1, 3 + t * 8, hi, 1, a);
          this.ring(x0, y0, 3 + t * 8, hi, 1, a);
          break;
        }
        case "self": {
          // a buff: a ring swelling off the caster and sparks circling up around it
          const p = this.at(e, f.from, now, f.x, f.y);
          const a = (1 - t) * a0;
          this.ring(p.x, p.y, usz / 2 + 2 + t * 9 * f.scale, f.accent, 2, a);
          for (let i = 0; i < 4; i++) {
            const ang = now / 160 + (i * Math.PI) / 2, r = usz / 2 + 3;
            this.box(p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r * 0.6 - t * 8, 2, f.accent, a);
          }
          break;
        }
        case "shield": {
          // a hexagon around the protected champion
          const p = this.at(e, f.to, now, f.tx, f.ty);
          const a = (t > 0.6 ? (1 - t) / 0.4 : 1) * a0;
          const r = usz / 2 + 5;
          this.stroke(() => {
            for (let i = 0; i <= 6; i++) {
              const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
              const px = p.x + Math.cos(ang) * r, py = p.y + Math.sin(ang) * r;
              if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
            }
          }, hi, 2, a);
          const sp = (now / 90) % 6, i0 = Math.floor(sp);
          const a1 = (i0 / 6) * Math.PI * 2 + Math.PI / 6, a2 = ((i0 + 1) / 6) * Math.PI * 2 + Math.PI / 6, f2 = sp - i0;
          this.box(p.x + (Math.cos(a1) * (1 - f2) + Math.cos(a2) * f2) * r, p.y + (Math.sin(a1) * (1 - f2) + Math.sin(a2) * f2) * r, 2, "#ffffff", a);
          break;
        }
        case "heal": {
          // green pluses floating up off the healed champion
          const p = this.at(e, f.to, now, f.tx, f.ty);
          for (let i = 0; i < 3; i++) {
            const k = (t - i * 0.15) / 0.7;
            if (k < 0 || k > 1) continue;
            const px = Math.round(p.x + (i - 1) * 7), py = Math.round(p.y - 4 - k * 16);
            const a = (1 - k) * a0;
            c.globalAlpha = a;
            c.fillStyle = INK;
            c.fillRect(px - 2, py - 4, 4, 8);
            c.fillRect(px - 4, py - 2, 8, 4);
            c.fillStyle = "#7dff8a";
            c.fillRect(px - 1, py - 3, 2, 6);
            c.fillRect(px - 3, py - 1, 6, 2);
          }
          break;
        }
        case "summon": {
          // a summoning ring, then the summoned thing: a small bobbing diamond
          const R = Math.max(5, h.len(f.r) * 0.6) * f.scale;
          if (t < 0.3) this.ring(x1, y1, R * (t / 0.3), f.accent, 1, a0);
          const a = (t > 0.7 ? (1 - t) / 0.3 : 1) * a0;
          const s = Math.round(4 * f.scale), cy = Math.round(y1 + Math.sin(now / 120));
          const diamond = (d: number) => { c.beginPath(); c.moveTo(x1, cy - d); c.lineTo(x1 + d, cy); c.lineTo(x1, cy + d); c.lineTo(x1 - d, cy); c.closePath(); c.fill(); };
          c.globalAlpha = a;
          c.fillStyle = INK; diamond(s + 1);
          c.fillStyle = f.accent; diamond(s);
          c.fillStyle = "#ffffff";
          c.fillRect(Math.round(x1), cy, 1, 1);
          break;
        }
        case "knockup": {
          // a ring on the ground and chevrons beside the airborne champion
          const g = this.at(e, f.to, now, f.tx, f.ty, false);
          const p = this.at(e, f.to, now, f.tx, f.ty);
          if (!p.alive) break;
          const a = (1 - t) * a0;
          this.ring(g.x, g.y, (4 + t * 12) * f.scale, "#ffffff", 1, a);
          for (const side of [-1, 1]) {
            const x = p.x + side * (usz / 2 + 4), y = p.y - t * 8;
            this.stroke(() => { c.moveTo(x - 3, y + 2); c.lineTo(x, y - 1); c.lineTo(x + 3, y + 2); }, hi, 1, a);
          }
          break;
        }
        case "stealth": {
          // a puff of smoke where the caster vanished
          const a = (1 - t) * 0.8 * a0;
          for (let i = 0; i < 6; i++) {
            const ang = (i * Math.PI) / 3, r = 4 + t * 10;
            this.box(x0 + Math.cos(ang) * r, y0 + Math.sin(ang) * r, 3, "#9aa3b5", a);
          }
          break;
        }
        case "hit": {
          // the spell landed: the victim flashes white and sparks fly in the attacker's colour
          const p = this.at(e, f.to, now, f.tx, f.ty);
          const big = f.key === "R";
          // the killing blow: the champion is already gone, so only the sparks show
          if (p.alive && t < 0.45) {
            c.globalAlpha = 0.8 * (1 - t / 0.45);
            c.fillStyle = "#ffffff";
            c.fillRect(Math.round(p.x - usz / 2), Math.round(p.y - usz / 2), usz, usz);
          }
          const L = (big ? 9 : 5) + t * (big ? 9 : 6);
          const r0 = usz / 2 + 1;
          for (let i = 0; i < 4; i++) {
            const ang = Math.PI / 4 + (i * Math.PI) / 2;
            const cx = Math.cos(ang), cy = Math.sin(ang);
            this.seg(p.x + cx * r0, p.y + cy * r0, p.x + cx * (r0 + L), p.y + cy * (r0 + L), big ? GOLD : team, 2, 1 - t);
          }
          break;
        }
        case "aa":
        case "objhit": {
          const to = f.to !== undefined ? this.at(e, f.to, now, f.tx, f.ty) : { x: x1, y: y1 };
          const k = Math.min(1, t * 1.3);
          this.box(x0 + (to.x - x0) * k, y0 + (to.y - y0) * k, 2, f.kind === "aa" ? hi : f.color, 1 - t * 0.3);
          break;
        }
        case "tower": {
          const to = this.at(e, f.to, now, f.tx, f.ty);
          this.seg(x0, y0, to.x, to.y, f.color, 2, 1 - t);
          break;
        }
        case "kill": {
          this.ring(x0, y0, 4 + t * 16, f.color, 2, 1 - t);
          c.globalAlpha = 1 - t;
          c.fillStyle = "#ffffff";
          for (let i = -3; i <= 3; i++) {
            c.fillRect(Math.round(x0 + i) - 1, Math.round(y0 + i) - 1, 2, 2);
            c.fillRect(Math.round(x0 + i) - 1, Math.round(y0 - i) - 1, 2, 2);
          }
          break;
        }
        case "smite": {
          this.disc(x0, y0, h.len(f.r) * (0.3 + t), "#fff7c2", 1 - t);
          break;
        }
      }
    }
    c.globalAlpha = 1;
  }

  /** Who cast what: an icon chip over each caster, the newest spell only. */
  drawTags(e: Engine, now: number) {
    const c = this.h.ctx, h = this.h;
    const zoomed = h.cam.size < 9000;
    const usz = this.unitSize();
    this.tags = this.tags.filter((t) => now - t.born < t.life);
    c.font = "8px Galmuri9, monospace";
    c.textAlign = "center";
    const placed: { x: number; y: number; w: number; h: number }[] = []; // chips already drawn this frame
    for (const tg of this.tags) {
      if (!zoomed && !tg.ult) continue; // wide shots: ultimates only
      const u = e.units[tg.unit];
      if (!u || !u.alive) continue;
      const p = h.unitPos(u, now);
      const k = (now - tg.born) / tg.life;
      const s = tg.ult ? (zoomed ? 14 : 11) : 10; // icon size in buffer px
      const W = s + 10, H = s + 2; // 1px frame, icon, 1px divider, 7px key cell, 1px frame
      const cx = Math.round(h.sx(p.x));
      let top = Math.round(h.sy(p.y) - usz / 2 - 7 - H - Math.min(1, k * 6) * 2);
      const x0 = cx - Math.floor(W / 2);
      // champions bunch up in fights: a chip that would cover an earlier one goes on top of it instead
      const named = tg.ult && !!tg.name;
      const above = named ? 10 : 0; // room for the ult name line
      // the name is centred over the chip and usually wider than it: reserve the wider of the two
      const nameW = named ? Math.ceil(c.measureText(tg.name!).width) + 2 : 0;
      const left = Math.min(x0 - 1, Math.floor(cx - nameW / 2));
      const right = Math.max(x0 + W + 1, Math.ceil(cx + nameW / 2));
      const area = (y: number) => ({ x: left, y: y - 1 - above, w: right - left, h: H + 2 + above });
      for (let tries = 0; tries < 6; tries++) {
        const r = area(top);
        const hit = placed.find((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
        if (!hit) break;
        top = hit.y - H - 2;
      }
      placed.push(area(top));
      c.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      c.fillStyle = INK;
      c.fillRect(x0 - 1, top - 1, W + 2, H + 2);
      c.fillStyle = tg.ult ? GOLD : TEAM[tg.side];
      c.fillRect(x0, top, W, H);
      const img = tg.icon ? this.icon(tg.icon) : null;
      if (img && img.complete && img.naturalWidth) c.drawImage(img, x0 + 1, top + 1, s, s);
      else {
        c.fillStyle = INK;
        c.fillRect(x0 + 1, top + 1, s, s);
      }
      c.fillStyle = INK;
      c.fillRect(x0 + s + 2, top + 1, 7, s);
      c.fillStyle = tg.ult ? GOLD : "#ffffff";
      c.fillText(tg.key, x0 + s + 6, top + 1 + Math.round((s - 7) / 2) + 7);
      if (tg.ult && tg.name) {
        c.fillStyle = INK;
        c.fillText(tg.name, cx + 1, top - 2);
        c.fillStyle = GOLD;
        c.fillText(tg.name, cx, top - 3);
      }
    }
    c.globalAlpha = 1;
  }
}
