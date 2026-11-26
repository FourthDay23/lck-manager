// Canvas renderer for the match: low-res 512px buffer scaled up with nearest-neighbour, so it reads as pixel art.
import type { Engine, Fx, GameEvent, Unit } from "./engine";
import { MAP, NEXUS, LANES, BARON_PIT, DRAGON_PIT, MIRROR_C, lanePoint, laneU } from "./map";
import type { Vec } from "./map";
import { champImg } from "../data/load";
import { SkillFx } from "./vfx";
import * as Macro from "./macro";
import type { LiveFx } from "./vfx";

export const RES = 512;
export type CamMode = "auto" | "all" | "top" | "mid" | "bot" | "jungle" | "follow";
interface Cam { x: number; y: number; size: number }
/** A candidate camera shot for the broadcast director. `reason` is the caption shown when the camera cuts to it. */
interface Shot { id: string; x: number; y: number; size: number; score: number; label: string; reason: string }
/** Caption explaining the latest camera cut; `at` is real time (performance.now()). */
export interface CutCaption { text: string; at: number }
export const CAPTION_MS = 3200;
const LANE_KO: Record<string, string> = { top: "탑", mid: "미드", bot: "바텀" };
const OBJ_NOUN: Record<string, string> = { baron: "내셔 남작", elder: "장로 드래곤", dragon: "드래곤", herald: "협곡의 전령", grubs: "공허 유충" };

/**
 * Korean particle after a word: 이/가, 을/를, 과/와, 으로/로, 은/는. Looks at the last Hangul syllable
 * (or the one before a closing bracket, for "Faker(아리)"); English names count as ending in a vowel.
 */
function josa(word: string, pair: "이가" | "을를" | "과와" | "으로" | "은는"): string {
  const w = word.replace(/[)\]]+$/, "");
  const ch = w.charCodeAt(w.length - 1);
  let batchim = false, rieul = false;
  if (ch >= 0xac00 && ch <= 0xd7a3) {
    const jong = (ch - 0xac00) % 28;
    batchim = jong > 0;
    rieul = jong === 8;
  } else if (/[0-9]$/.test(w)) {
    batchim = /[013678]$/.test(w);
  }
  if (pair === "으로") return word + (batchim && !rieul ? "으로" : "로");
  const [a, b] = pair === "이가" ? ["이", "가"] : pair === "을를" ? ["을", "를"] : pair === "과와" ? ["과", "와"] : ["은", "는"];
  return word + (batchim ? a : b);
}
const EVENT_SHOT: Partial<Record<string, string>> = {
  first_blood: "퍼스트 블러드", solo: "솔로 킬", double: "더블 킬", triple: "트리플 킬", quadra: "쿼드라 킬", penta: "펜타 킬",
  ace: "에이스", shutdown: "셧다운", steal: "스틸", dragon: "드래곤 처치", soul: "드래곤의 영혼", elder: "장로 드래곤",
  grubs: "공허 유충 처치", herald: "협곡의 전령 처치", baron: "내셔 남작 처치", turret: "포탑 파괴", first_turret: "첫 포탑",
  inhib: "억제기 파괴", nexus: "넥서스 파괴",
};
const OBJ_SHOT: Record<string, [number, string]> = {
  baron: [34, "내셔 남작"], elder: [36, "장로 드래곤"], dragon: [24, "드래곤 둥지"], herald: [15, "협곡의 전령"], grubs: [13, "공허 유충"],
};

const PRESETS: Record<Exclude<CamMode, "jungle" | "follow" | "auto">, Cam> = {
  all: { x: 7375, y: 7430, size: 15100 },
  top: { x: 2900, y: 11900, size: 6400 },
  mid: { x: 7400, y: 7400, size: 6800 },
  bot: { x: 11900, y: 2900, size: 6400 },
};

interface Particle { x: number; y: number; vx: number; vy: number; born: number; life: number; color: string; size: number }

const imgCache = new Map<string, HTMLImageElement>();
function champImage(version: string, id: string): HTMLImageElement {
  let img = imgCache.get(id);
  if (!img) {
    img = new Image();
    img.crossOrigin = "anonymous"; // Data Dragon allows CORS, so the canvas stays readable
    img.src = champImg(version, id);
    imgCache.set(id, img);
  }
  return img;
}

const BLUE = "#4aa3ff";
const RED = "#ff5a5a";

export class MatchRenderer {
  ctx: CanvasRenderingContext2D;
  mode: CamMode = "auto";
  followIdx = 1;
  /** Broadcast director state: current shot, when it started, and what to call it on screen. */
  shotId: string | null = null;
  shotSince = 0;
  /** game time of the last cut (holds are counted in real and game time) */
  shotSinceT = 0;
  /** the next frame jumps straight to the target instead of panning */
  private snap = true;
  shotLast: Shot | null = null;
  shotLabel = "";
  idleSince = 0;
  idleSinceT = 0;
  /** real time of the last re-frame inside a shot (rate-limited so a moving fight does not jerk the view) */
  private reframedAt = 0;
  /** Why the auto camera last cut, for the subtitle under the board. Null in manual camera modes. */
  cut: CutCaption | null = null;
  private fallbackKey = "";
  cam: Cam = { ...PRESETS.all };
  fxSeen = 0;
  live: LiveFx[] = [];
  parts: Particle[] = [];
  map: HTMLImageElement;
  version: string;
  highlightSide: 0 | 1 | null;
  shake = 0;
  /** Skill effects, cast chips and hit feedback (see vfx.ts). */
  readonly skills = new SkillFx(this);

  constructor(private canvas: HTMLCanvasElement, private e: Engine, version: string, highlightSide: 0 | 1 | null) {
    canvas.width = RES;
    canvas.height = RES;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.map = new Image();
    this.map.src = "assets/map11.png";
    this.version = version;
    this.highlightSide = highlightSide;
    for (const u of e.units) champImage(version, u.champ.id);
  }

  setEngine(e: Engine) {
    this.e = e;
    this.fxSeen = 0;
    this.live = [];
    this.parts = [];
    this.skills.reset();
    this.stepFrom = [];
    this.lerp = 1;
    for (const u of e.units) champImage(this.version, u.champ.id);
  }

  private tag(u: Unit) {
    return `${u.name}(${u.champ.name})`;
  }

  /** Where on the map a point is, in words a caster would use. */
  private placeOf(x: number, y: number): string {
    const e = this.e;
    const p = { x, y };
    if (Math.hypot(x - DRAGON_PIT.x, y - DRAGON_PIT.y) < 1500) return "드래곤 둥지";
    if (Math.hypot(x - BARON_PIT.x, y - BARON_PIT.y) < 1500) return "바론 둥지";
    if (Math.hypot(x - NEXUS[0].x, y - NEXUS[0].y) < 3400) return `${e.names[0]} 본진`;
    if (Math.hypot(x - NEXUS[1].x, y - NEXUS[1].y) < 3400) return `${e.names[1]} 본진`;
    let lane = "", best = Infinity;
    for (const l of LANES) {
      const q = lanePoint(l, laneU(l, p));
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < best) { best = d; lane = l; }
    }
    if (best < 1200) return `${LANE_KO[lane]}`;
    const diag = x + y - MIRROR_C;
    if (Math.abs(diag) < 1700) return x < y ? "위쪽 강가" : "아래쪽 강가";
    return `${e.names[diag < 0 ? 0 : 1]} 정글`;
  }

  /** "T1 3 대 Gen.G 2" head count, blue side first. */
  private headcount(units: Unit[]): string {
    const b = units.filter((u) => u.side === 0).length, r = units.length - b;
    return `${this.e.names[0]} ${b} 대 ${this.e.names[1]} ${r}`;
  }

  /** Caption text for a recent event. */
  private eventReason(ev: GameEvent): string {
    const e = this.e;
    const a = ev.actor !== undefined ? e.units[ev.actor] : undefined;
    const v = ev.victim !== undefined ? e.units[ev.victim] : undefined;
    const place = ev.x !== undefined && ev.y !== undefined ? this.placeOf(ev.x, ev.y) : "";
    // engine lines look like "첫 포탑! T1가 ..." or "T1, 내셔 남작 처치!": drop a short shout-out prefix and a trailing "!"
    const plain = (t: string) => {
      const m = t.match(/^([^!,]{1,10})!\s*(.+)$/);
      return (m ? m[2] : t).replace(/!$/, "");
    };
    const team = e.names[ev.side];
    switch (ev.type) {
      case "kill": return a && v ? `${place}에서 ${josa(this.tag(a), "이가")} ${josa(this.tag(v), "을를")} 잡았습니다` : plain(ev.text);
      case "first_blood": return a && v ? `퍼스트 블러드: ${place}에서 ${josa(this.tag(a), "이가")} ${josa(this.tag(v), "을를")} 잡았습니다` : plain(ev.text);
      case "solo": return a ? `${place}에서 ${josa(this.tag(a), "이가")} 솔로 킬을 냈습니다` : plain(ev.text);
      case "double": case "triple": case "quadra": case "penta":
        return a ? `${this.tag(a)}의 ${EVENT_SHOT[ev.type]}` : plain(ev.text);
      case "ace": return `${josa(team, "이가")} 상대 다섯 명을 모두 잡았습니다`;
      case "shutdown": return a && v ? `${josa(this.tag(a), "이가")} ${this.tag(v)}의 연속 킬을 끊었습니다` : plain(ev.text);
      case "steal": return a ? `${josa(this.tag(a), "이가")} 오브젝트를 빼앗았습니다` : plain(ev.text);
      case "nexus": return `${josa(team, "이가")} 넥서스를 파괴했습니다`;
      default: return plain(ev.text);
    }
  }

  /** Everything worth pointing the camera at right now, with a score. */
  private shots(): Shot[] {
    const e = this.e;
    const out: Shot[] = [];
    // fights: bigger fights first
    for (const [id, f] of e.fights) {
      const m = e.units.filter((u) => u.alive && u.fightId === id);
      if (m.length < 2 || new Set(m.map((u) => u.side)).size < 2) continue;
      const cx = m.reduce((a, u) => a + u.x, 0) / m.length, cy = m.reduce((a, u) => a + u.y, 0) / m.length;
      const spread = Math.max(...m.map((u) => Math.hypot(u.x - cx, u.y - cy)));
      const n = m.length;
      const label = n >= 7 ? "대규모 한타" : n >= 4 ? "한타" : n === 3 ? "소규모 교전" : f.origin === "gank" ? "갱킹" : "교전";
      const place = this.placeOf(cx, cy);
      let reason: string;
      if (f.origin === "gank") {
        const jg = m.find((u) => u.role === "Jungle");
        reason = jg ? `${josa(this.tag(jg), "이가")} ${josa(place, "으로")} 갱킹을 왔습니다` : `${place}에 갱킹이 들어왔습니다`;
      } else if (n === 2) {
        reason = `${place}에서 ${josa(this.tag(m[0]), "과와")} ${josa(this.tag(m[1]), "이가")} 맞붙었습니다`;
      } else if (n >= 4) {
        reason = `${place}에서 ${this.headcount(m)} ${josa(label, "이가")} 열렸습니다`;
      } else {
        reason = `${place}에서 ${this.headcount(m)} 교전이 벌어졌습니다`;
      }
      out.push({ id: `f${id}`, x: cx, y: cy, size: Math.max(3600, Math.min(8200, spread * 2.6 + 2600)), score: 8 + n * 4 + (n >= 6 ? 10 : 0), label, reason });
    }
    // objectives with someone on them
    for (const [k, [base, label]] of Object.entries(OBJ_SHOT)) {
      const o = e.obj[k as keyof typeof e.obj];
      if (!o.alive) continue;
      const near = e.units.filter((u) => u.alive && Math.hypot(u.x - o.pos.x, u.y - o.pos.y) < 1300);
      if (!near.length) continue;
      const contested = new Set(near.map((u) => u.side)).size > 1;
      const side = near[0].side;
      const hitting = o.hp < o.maxHp - 1;
      const noun = k === "dragon" && o.type ? `${o.type} 드래곤` : OBJ_NOUN[k];
      const reason = contested
        ? `${josa(noun, "을를")} 두고 양 팀 ${near.length}명이 모였습니다`
        : hitting
          ? `${josa(e.names[side], "이가")} ${josa(noun, "을를")} 치기 시작했습니다`
          : near.length === 1
            ? `${josa(this.tag(near[0]), "이가")} ${noun} 쪽으로 왔습니다`
            : `${e.names[side]} ${near.length}명이 ${noun} 앞에 모였습니다`;
      out.push({ id: `o${k}`, x: o.pos.x, y: o.pos.y, size: 4800, score: base + near.length * 2 + (contested ? 12 : 0), label: contested ? `${label} 대치` : label, reason });
    }
    // sieges: two or more attackers at a standing structure
    for (const t of e.turrets) {
      if (!t.alive) continue;
      const att = e.units.filter((u) => u.alive && u.side !== t.side && Math.hypot(u.x - t.pos.x, u.y - t.pos.y) < 1100);
      if (att.length < 2) continue;
      const where = t.lane === "nexus" ? "쌍둥이 포탑" : `${t.lane === "top" ? "탑" : t.lane === "mid" ? "미드" : "바텀"} ${t.tier}차 포탑`;
      const reason = `${e.names[att[0].side]} ${att.length}명이 ${e.names[t.side]}의 ${josa(where, "을를")} 두드립니다`;
      out.push({ id: `t${t.lane}${t.tier}${t.side}${t.pos.x}`, x: t.pos.x, y: t.pos.y, size: 5200, score: 9 + att.length * 3 + (t.tier >= 3 ? 6 : 0), label: `${where} 공략`, reason });
    }
    // what is about to happen: the camera should already be there when it starts
    out.push(...this.upcoming());
    // what just happened: kills, towers, objectives (fades over 8 game seconds). Kept low: by the time it is on
    // screen it is over, so it only fills a quiet moment (the nexus still wins).
    for (const ev of e.events.slice(-12)) {
      if (ev.x === undefined || ev.y === undefined || ev.type === "info") continue;
      const age = e.t - ev.t;
      if (age > 8) continue;
      const base = ev.type === "nexus" ? 60 : ev.big ? 12 : 5;
      out.push({ id: `e${ev.t}${ev.type}`, x: ev.x, y: ev.y, size: 4600, score: base * (1 - age / 10), label: EVENT_SHOT[ev.type] ?? "킬 장면", reason: this.eventReason(ev) });
    }
    // one entry per id (an objective can be both "planned" and "someone is there"): keep the stronger one
    const byId = new Map<string, Shot>();
    for (const s of out) if (!byId.has(s.id) || byId.get(s.id)!.score < s.score) byId.set(s.id, s);
    return [...byId.values()];
  }

  /** Last sampled unit positions (every game second), to tell whether two groups are closing in. */
  private prevPos: { t: number; pos: Vec[] } | null = null;

  /** Shots for things that have not happened yet: team plans on objectives and towers, ganks on the way, and two
   *  groups walking into each other. Ids match the shots the same scene gets once it starts, so no second cut. */
  private upcoming(): Shot[] {
    const e = this.e;
    const out: Shot[] = [];
    // team plans (macro brains): objective setups and sieges are decided well before anyone arrives
    const M = Macro.st(e);
    if (M) {
      const plans = ([0, 1] as const).map((side) => ({ side, p: M.brains[side].plan }));
      const byObj = new Map<string, { side: 0 | 1; phase: string; contest: boolean }[]>();
      for (const { side, p } of plans) {
        if ((p.kind === "take" || p.kind === "contest") && p.obj && !p.solo) {
          const o = e.obj[p.obj];
          if (!o.alive && !(o.spawnAt !== null && o.spawnAt - e.t < 35)) continue;
          const list = byObj.get(p.obj) ?? [];
          list.push({ side, phase: p.phase, contest: p.kind === "contest" });
          byObj.set(p.obj, list);
        }
        if (p.kind === "siege" && p.lane) {
          const t = e.frontierTurret((1 - side) as 0 | 1, p.lane);
          if (!t) continue;
          const where = `${LANE_KO[p.lane]} ${t.tier}차 포탑`;
          out.push({
            id: `t${t.lane}${t.tier}${t.side}${t.pos.x}`, x: t.pos.x, y: t.pos.y, size: 5200, score: 12 + p.members.length * 2,
            label: `${where} 공략`, reason: `${josa(e.names[side], "이가")} ${where} 공성을 준비합니다`,
          });
        }
      }
      for (const [k, list] of byObj) {
        const shot = OBJ_SHOT[k];
        if (!shot) continue;
        const o = e.obj[k as keyof typeof e.obj];
        const noun = k === "dragon" && o.type ? `${o.type} 드래곤` : OBJ_NOUN[k];
        const w = Math.max(...list.map((x) => (x.phase === "commit" ? 1 : x.phase === "gather" ? 0.85 : 0.6)));
        const both = list.length > 1;
        const a = list[0];
        const team = e.names[a.side];
        const reason = both
          ? `양 팀이 ${noun} 앞으로 모이고 있습니다`
          : a.contest
            ? `${josa(team, "이가")} ${noun} 저지에 나섭니다`
            : a.phase === "setup"
              ? `${josa(team, "이가")} ${noun} 사냥을 준비합니다`
              : a.phase === "gather"
                ? `${josa(team, "이가")} ${noun} 앞으로 모입니다`
                : `${josa(team, "이가")} ${noun} 사냥에 들어갑니다`;
        out.push({ id: `o${k}`, x: o.pos.x, y: o.pos.y, size: 4800, score: shot[0] * w + (both ? 12 : 0), label: both ? `${shot[1]} 대치` : shot[1], reason });
      }
    }
    // ganks on the way: show the lane before the jungler gets there
    for (const u of e.units) {
      const lane = (u as Unit & { gankLane?: "top" | "mid" | "bot" }).gankLane;
      if (!u.alive || u.task !== "gank" || !lane || u.fightId) continue;
      const prey = e.units.filter((v) => v.alive && v.side !== u.side && v.task === "lane" && Math.hypot(v.x - u.x, v.y - u.y) < 4200);
      const near = prey.sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
      if (!near) continue;
      const d = Math.hypot(near.x - u.x, near.y - u.y);
      const cx = (near.x * 2 + u.x) / 3, cy = (near.y * 2 + u.y) / 3;
      out.push({
        id: `g${u.i}`, x: cx, y: cy, size: Math.max(4200, Math.min(7000, d * 1.5 + 2000)), score: 13 + (4200 - d) / 600,
        label: "갱킹", reason: `${josa(this.tag(u), "이가")} ${josa(LANE_KO[lane], "으로")} 갱킹을 가고 있습니다`,
      });
    }
    // two groups closing in (not in a fight yet): a fight is a few seconds away
    const alive = e.units.filter((u) => u.alive && !u.fightId && u.recallEnd === undefined);
    const prev = this.prevPos;
    const dt = prev ? e.t - prev.t : 0;
    const seen = new Set<number>();
    for (const a of alive) {
      if (a.side !== 0 || seen.has(a.i)) continue;
      const foes = alive.filter((b) => b.side === 1 && Math.hypot(a.x - b.x, a.y - b.y) < 2400);
      if (!foes.length) continue;
      const closing = foes.some((b) => {
        if (!prev || dt <= 0) return false;
        const pa = prev.pos[a.i], pb = prev.pos[b.i];
        const before = Math.hypot(pa.x - pb.x, pa.y - pb.y), after = Math.hypot(a.x - b.x, a.y - b.y);
        return (before - after) / dt > 60 || after < 1400;
      });
      if (!closing) continue;
      // the group: everyone within 1000 of the two sides' members
      const group = new Set<Unit>([a, ...foes]);
      for (const u of alive) if ([...group].some((g) => Math.hypot(g.x - u.x, g.y - u.y) < 1000)) group.add(u);
      const m = [...group];
      m.forEach((u) => seen.add(u.i));
      // two laners facing each other is the lane, not a fight about to start
      if (m.length < 3) continue;
      const cx = m.reduce((s, u) => s + u.x, 0) / m.length, cy = m.reduce((s, u) => s + u.y, 0) / m.length;
      const spread = Math.max(...m.map((u) => Math.hypot(u.x - cx, u.y - cy)));
      const n = m.length;
      const place = this.placeOf(cx, cy);
      out.push({
        id: `c${Math.min(...m.map((u) => u.i))}`, x: cx, y: cy, size: Math.max(3800, Math.min(8200, spread * 2.6 + 2800)), score: 6 + n * 3,
        label: n >= 6 ? "한타 직전" : "교전 직전", reason: `${place}에서 ${this.headcount(m)} 맞닥뜨리기 직전입니다`,
      });
    }
    if (!prev || e.t - prev.t >= 1) this.prevPos = { t: e.t, pos: e.units.map((u) => ({ x: u.x, y: u.y })) };
    return out;
  }

  /** Pick a shot like a broadcast observer: hold it for a moment, cut away for something bigger, then fall back.
   *  Cuts are instant (see draw); a new shot over the same spot only changes the caption. */
  private director(now: number): Cam {
    const shots = this.shots();
    const best = shots.reduce<Shot | null>((a, b) => (!a || b.score > a.score ? b : a), null);
    let cur = this.shotId ? shots.find((x) => x.id === this.shotId) ?? null : null;
    const held = now - this.shotSince;
    const heldGame = this.e.t - this.shotSinceT;
    // the scene the camera already shows took a new name (a planned objective became the fight over it, a gank on
    // the way became the gank): follow it without a cut
    if (!cur && best && this.shotLast && Math.hypot(best.x - this.shotLast.x, best.y - this.shotLast.y) < this.shotLast.size * 0.25 && best.score >= 10) {
      cur = best;
      this.shotId = best.id;
      if (best.reason !== this.shotLast.reason) this.cut = { text: best.reason, at: now };
    }
    // hold a shot ~2.5 s (and 5 game s) before cutting to something better; something far bigger cuts sooner
    if (cur && best && best.id !== cur.id && ((held > 2500 && heldGame > 5 && best.score > cur.score * 1.35) || (held > 1000 && best.score > cur.score * 2.2))) cur = null;
    // the scene just ended: stay on it a moment (1.5 s, 3 game s) unless something big is on
    if (!cur && this.shotLast && now - this.idleSince < 1500 && this.e.t - this.idleSinceT < 3 && !(best && best.score >= 30)) {
      return { x: this.shotLast.x, y: this.shotLast.y, size: this.shotLast.size };
    }
    if (!cur && best && best.score >= 10 && (held > 900 || !this.shotLast)) {
      cur = best;
      this.shotId = best.id;
      this.shotSince = now;
      this.shotSinceT = this.e.t;
      this.snap = true;
      // a cut: say why
      this.cut = { text: best.reason, at: now };
      this.fallbackKey = "";
    }
    if (cur) {
      // once an objective shot turns into a stand-off, keep calling it that until the camera cuts away
      if (this.shotLast?.id === cur.id && this.shotLabel.endsWith("대치") && !cur.label.endsWith("대치")) cur = { ...cur, label: `${cur.label} 대치` };
      this.shotLast = cur;
      this.shotLabel = cur.label;
      this.idleSince = now;
      this.idleSinceT = this.e.t;
      return { x: cur.x, y: cur.y, size: cur.size };
    }
    // linger on the last shot briefly after it ends, then go wide or tour the lanes
    if (this.shotLast && now - this.idleSince < 1600) return { x: this.shotLast.x, y: this.shotLast.y, size: this.shotLast.size };
    const ended = this.shotLast?.label ?? null;
    this.shotId = null;
    this.shotLast = null;
    if (this.e.t < 14 * 60 && this.e.t > 60) {
      const lanes: (keyof typeof PRESETS)[] = ["bot", "mid", "top", "bot"];
      const pick = lanes[Math.floor(now / 7000) % lanes.length];
      this.shotLabel = pick === "bot" ? "바텀 라인전" : pick === "mid" ? "미드 라인전" : "탑 라인전";
      const key = `lane:${pick}`;
      if (key !== this.fallbackKey) {
        this.cut = { text: ended ? `${ended} 장면이 끝나 ${josa(this.shotLabel, "으로")} 돌아갑니다` : `큰 장면이 없어 ${josa(this.shotLabel, "을를")} 보여 줍니다`, at: now };
        this.fallbackKey = key;
      }
      return { ...PRESETS[pick] };
    }
    this.shotLabel = "전체 맵";
    if (this.fallbackKey !== "all") {
      this.cut = {
        text: this.e.t <= 60 ? "양 팀이 라인으로 향합니다" : ended ? `${ended} 장면이 끝나 전체 맵으로 돌아갑니다` : "큰 장면이 없어 전체 맵을 보여 줍니다",
        at: now,
      };
      this.fallbackKey = "all";
    }
    return { ...PRESETS.all };
  }

  private target(now: number): Cam {
    let c: Cam;
    if (this.mode === "auto") c = this.director(now);
    else {
      // manual camera: no captions, and the director starts fresh when auto comes back
      this.cut = null;
      this.fallbackKey = "";
      if (this.mode === "jungle" || this.mode === "follow") {
        const u = this.e.units[this.followIdx] ?? this.e.units[1];
        c = { x: u.x, y: u.y, size: this.mode === "jungle" ? 6200 : 5200 };
      } else c = { ...PRESETS[this.mode] };
    }
    // keep the view inside the map so no black edges show
    const half = c.size / 2;
    if (c.size < MAP.maxX - MAP.minX) {
      c.x = Math.max(MAP.minX + half, Math.min(MAP.maxX - half, c.x));
      c.y = Math.max(MAP.minY + half, Math.min(MAP.maxY - half, c.y));
    }
    return c;
  }

  // world -> buffer px
  sx(x: number) {
    return ((x - (this.cam.x - this.cam.size / 2)) / this.cam.size) * RES;
  }
  sy(y: number) {
    return (1 - (y - (this.cam.y - this.cam.size / 2)) / this.cam.size) * RES;
  }
  len(w: number) {
    return (w / this.cam.size) * RES;
  }

  /** Pull new fx from the engine and give each a real-time lifetime. */
  private ingest(now: number) {
    const fx = this.e.fx;
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i];
      if (f.id <= this.fxSeen) continue;
      const made = this.skills.ingest(f, now, this.live, this.e);
      this.live.push(...made);
      // ultimates: gold sparks off the caster and a small jolt
      if (made[0].key === "R" && !made[0].pve && made[0].kind !== "hit") { this.burst(f.x, f.y, "#ffd36b", 10, now); this.shake = Math.max(this.shake, 2); }
      if (f.kind === "kill") this.burst(f.x, f.y, f.color, 14, now);
      if (f.kind === "blink") { this.burst(f.x, f.y, "#fff3a0", 8, now); this.burst(f.tx, f.ty, "#fff3a0", 8, now); }
      if (f.kind === "heal") this.burst(f.tx, f.ty, "#7dff8a", 6, now, -1);
      if (f.kind === "smite") { this.burst(f.x, f.y, "#ffe28a", 18, now); this.shake = 6; }
      if (f.kind === "global") this.shake = Math.max(this.shake, 3);
    }
    this.fxSeen = this.e.fxSeq;
    if (this.live.length > 300) this.live.splice(0, this.live.length - 300);
  }

  /** Skip everything emitted so far (after fast-forwarding). */
  syncFx() {
    this.fxSeen = this.e.fxSeq;
  }

  private burst(x: number, y: number, color: string, n: number, now: number, up = 0) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 300 + Math.random() * 500;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + up * 400, born: now, life: 400 + Math.random() * 400, color, size: 1 + Math.random() * 2 });
    }
  }

  draw(now: number) {
    this.ingest(now);
    const tgt = this.target(now);
    if (this.mode === "auto") {
      // broadcast camera: cut, never pan. Inside one shot it stays put and re-frames (also a cut) only when the
      // action drifts out of the middle or no longer fits.
      const drift = Math.hypot(tgt.x - this.cam.x, tgt.y - this.cam.y);
      const off = drift > this.cam.size * 0.3 || tgt.size > this.cam.size * 1.45 || tgt.size < this.cam.size * 0.6;
      // re-frame at most every 1.5 s, unless the action is leaving the screen
      if (this.snap || (off && now - this.reframedAt > 1500) || drift > this.cam.size * 0.45) {
        if (!this.snap) this.reframedAt = now;
        this.cam = { ...tgt };
      }
      this.snap = false;
    } else {
      // manual modes (follow a player, lane presets) still glide
      const k = 0.12;
      this.cam.x += (tgt.x - this.cam.x) * k;
      this.cam.y += (tgt.y - this.cam.y) * k;
      this.cam.size += (tgt.size - this.cam.size) * k;
      this.snap = true;
    }
    const c = this.ctx;
    c.save();
    if (this.shake > 0) {
      c.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= 0.85;
      if (this.shake < 0.3) this.shake = 0;
    }
    c.fillStyle = "#05070d";
    c.fillRect(0, 0, RES, RES);
    this.drawMap();
    this.drawLanes(now);
    this.drawStructures();
    this.drawCamps();
    this.drawObjectives(now);
    this.skills.under(this.e, this.live, now);
    this.drawUnits(now);
    this.skills.over(this.e, this.live, now);
    this.drawParticles(now);
    this.skills.drawTags(this.e, now);
    c.restore();
    if (this.cam.size < 12000) this.drawInset();
    this.live = this.live.filter((f) => now - f.born < f.life);
  }

  /** Broadcast-style minimap in the corner while the camera is zoomed in. */
  private drawInset() {
    const c = this.ctx;
    const S = 104, X = RES - S - 6, Y = 6;
    const W = MAP.maxX - MAP.minX, H = MAP.maxY - MAP.minY;
    const mx = (x: number) => X + ((x - MAP.minX) / W) * S;
    const my = (y: number) => Y + (1 - (y - MAP.minY) / H) * S;
    c.fillStyle = "#05070d";
    c.fillRect(X - 2, Y - 2, S + 4, S + 4);
    if (this.map.complete && this.map.naturalWidth) c.drawImage(this.map, X, Y, S, S);
    c.fillStyle = "rgba(6,10,22,0.45)";
    c.fillRect(X, Y, S, S);
    for (const t of this.e.turrets) {
      if (!t.alive) continue;
      c.fillStyle = t.side ? "#ff9a9a" : "#9ad0ff";
      c.fillRect(Math.round(mx(t.pos.x)) - 1, Math.round(my(t.pos.y)) - 1, 2, 2);
    }
    for (const u of this.e.units) {
      if (!u.alive) continue;
      c.fillStyle = "#05070d";
      c.fillRect(Math.round(mx(u.x)) - 2, Math.round(my(u.y)) - 2, 5, 5);
      c.fillStyle = u.side ? RED : BLUE;
      c.fillRect(Math.round(mx(u.x)) - 1, Math.round(my(u.y)) - 1, 3, 3);
    }
    // the current view
    const x0 = mx(this.cam.x - this.cam.size / 2), y0 = my(this.cam.y + this.cam.size / 2);
    c.strokeStyle = "#f2f4fa";
    c.lineWidth = 1;
    c.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round((this.cam.size / W) * S), Math.round((this.cam.size / H) * S));
  }

  private drawMap() {
    const c = this.ctx;
    if (!this.map.complete || !this.map.naturalWidth) return;
    const W = MAP.maxX - MAP.minX, H = MAP.maxY - MAP.minY;
    const iw = this.map.naturalWidth, ih = this.map.naturalHeight;
    const x0 = this.cam.x - this.cam.size / 2, y1 = this.cam.y + this.cam.size / 2;
    const sxi = ((x0 - MAP.minX) / W) * iw;
    const syi = (1 - (y1 - MAP.minY) / H) * ih;
    const sw = (this.cam.size / W) * iw, sh = (this.cam.size / H) * ih;
    c.drawImage(this.map, sxi, syi, sw, sh, 0, 0, RES, RES);
    c.fillStyle = "rgba(6,10,22,0.35)";
    c.fillRect(0, 0, RES, RES);
  }

  /** Minion waves: a clump of outlined pixels per side where the two waves meet. */
  private drawLanes(now: number) {
    if (this.e.t < 50) return;
    const c = this.ctx;
    const zoom = this.cam.size < 9000;
    const s = zoom ? 5 : 3; // body size in buffer px
    for (const lane of ["top", "mid", "bot"] as const) {
      const f = this.e.lanes[lane].front;
      const a = this.lanePt(lane, f - 0.02), b = this.lanePt(lane, f + 0.02);
      // unit normal to the lane direction, to spread the wave sideways
      const dx = this.sx(b.x) - this.sx(a.x), dy = this.sy(b.y) - this.sy(a.y);
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L, tx = dx / L, ty = dy / L;
      const centre = this.lanePt(lane, f);
      const cx = this.sx(centre.x), cy = this.sy(centre.y);
      for (let side = 0; side < 2; side++) {
        const dir = side === 0 ? -1 : 1;
        const body = side === 0 ? "#7cc4ff" : "#ff8c8c";
        const dark = side === 0 ? "#123a66" : "#5e1a1a";
        for (let i = 0; i < 6; i++) {
          const row = Math.floor(i / 3), col = i % 3;
          const along = dir * (s * 0.9 + row * (s + 2)) + Math.sin(now / 220 + i * 1.3 + side * 2) * 0.8;
          const across = (col - 1) * (s + 1);
          const px = Math.round(cx + tx * along + nx * across - s / 2);
          const py = Math.round(cy + ty * along + ny * across - s / 2);
          c.fillStyle = "#05070d";
          c.fillRect(px - 1, py - 1, s + 2, s + 2);
          c.fillStyle = body;
          c.fillRect(px, py, s, s);
          if (row === 1) { // casters: darker core
            c.fillStyle = dark;
            c.fillRect(px + Math.floor(s / 3), py + Math.floor(s / 3), Math.max(1, Math.ceil(s / 3)), Math.max(1, Math.ceil(s / 3)));
          }
        }
      }
    }
  }

  /** Same arc-length parameter as the engine (lane front, turret `u`). Sampling by segment index instead put the
   *  drawn wave hundreds of units away from the engine's front, past standing turrets on lanes with uneven segments. */
  private lanePt(lane: "top" | "mid" | "bot", u: number): Vec {
    return lanePoint(lane, u);
  }

  /** Turrets as small pixel towers with an outline, HP bar and attack range when enemies are near. */
  private drawStructures() {
    const c = this.ctx;
    const zoom = this.cam.size < 9000;
    const u = zoom ? 2 : 1; // pixel unit
    // tower sprite, 7 x 10 cells: crown, body, base
    const TOWER = [
      ".x.x.x.",
      ".xxxxx.",
      "..ccc..",
      "..bbb..",
      "..bbb..",
      "..bbb..",
      "..bbb..",
      ".bbbbb.",
      "bbbbbbb",
    ];
    for (const t of this.e.turrets) {
      const x = Math.round(this.sx(t.pos.x)), y = Math.round(this.sy(t.pos.y));
      if (x < -30 || y < -30 || x > RES + 30 || y > RES + 30) continue;
      const w = 7 * u, h = TOWER.length * u;
      const ox = x - Math.floor(w / 2), oy = y - h + 2 * u;
      if (!t.alive) {
        c.fillStyle = "#05070d";
        c.fillRect(x - 3 * u - 1, y - u - 1, 6 * u + 2, 3 * u + 2);
        c.fillStyle = "#5a5f6e";
        c.fillRect(x - 3 * u, y - u, 2 * u, 2 * u);
        c.fillRect(x, y, 3 * u, u * 2);
        continue;
      }
      const body = t.side ? "#ff6b6b" : "#5aa9ff";
      const crown = t.side ? "#ffc2c2" : "#c2e2ff";
      // range ring while an enemy champion is close
      const threat = this.e.units.some((v) => v.alive && v.side !== t.side && Math.hypot(v.x - t.pos.x, v.y - t.pos.y) < 1150);
      if (threat) {
        c.strokeStyle = t.side ? "rgba(255,107,107,0.45)" : "rgba(90,169,255,0.45)";
        c.lineWidth = 1;
        c.beginPath();
        c.arc(x, y, this.len(775), 0, Math.PI * 2);
        c.stroke();
      }
      // outline: draw the sprite one pixel bigger in black first
      c.fillStyle = "#05070d";
      TOWER.forEach((row, ry) => [...row].forEach((ch, rx) => {
        if (ch !== ".") c.fillRect(ox + rx * u - 1, oy + ry * u - 1, u + 2, u + 2);
      }));
      TOWER.forEach((row, ry) => [...row].forEach((ch, rx) => {
        if (ch === ".") return;
        c.fillStyle = ch === "x" ? crown : ch === "c" ? "#ffffff" : body;
        c.fillRect(ox + rx * u, oy + ry * u, u, u);
      }));
      if (t.hp < t.maxHp) {
        const bw = w + 2;
        c.fillStyle = "#05070d";
        c.fillRect(ox - 1, oy + h + 1, bw, 3);
        c.fillStyle = body;
        c.fillRect(ox, oy + h + 2, Math.max(1, Math.round((bw - 2) * (t.hp / t.maxHp))), 1);
      }
    }
    for (const ih of this.e.inhibs) {
      const x = Math.round(this.sx(ih.pos.x)), y = Math.round(this.sy(ih.pos.y));
      const s = zoom ? 7 : 4;
      c.fillStyle = "#05070d";
      c.beginPath();
      c.moveTo(x, y - s - 1); c.lineTo(x + s + 1, y); c.lineTo(x, y + s + 1); c.lineTo(x - s - 1, y);
      c.fill();
      c.fillStyle = ih.alive ? (ih.side ? "#ff9a9a" : "#9ad0ff") : "#3a3f4b";
      c.beginPath();
      c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y);
      c.fill();
      if (!ih.alive && zoom && ih.respawnAt > this.e.t) {
        const left = Math.ceil(ih.respawnAt - this.e.t);
        c.font = "8px Galmuri9, monospace";
        c.textAlign = "center";
        c.fillStyle = "#e8ecf5";
        c.fillText(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, x, y + s + 9);
      }
    }
    NEXUS.forEach((p, side) => {
      const x = Math.round(this.sx(p.x)), y = Math.round(this.sy(p.y));
      const s = zoom ? 13 : 7;
      c.fillStyle = "#05070d";
      c.beginPath();
      c.moveTo(x, y - s - 2); c.lineTo(x + s + 2, y); c.lineTo(x, y + s + 2); c.lineTo(x - s - 2, y);
      c.fill();
      c.fillStyle = side ? RED : BLUE;
      c.beginPath();
      c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y);
      c.fill();
      c.fillStyle = "#ffffff";
      c.fillRect(x - 1, y - 1, 3, 3);
      const hp = this.e.nexus[side] / 4000;
      if (hp < 1) {
        c.fillStyle = "#05070d";
        c.fillRect(x - s - 1, y + s + 3, 2 * s + 2, 3);
        c.fillStyle = side ? RED : BLUE;
        c.fillRect(x - s, y + s + 4, Math.max(1, Math.round(2 * s * Math.max(0, hp))), 1);
      }
    });
  }

  private drawCamps() {
    const c = this.ctx;
    const zoomed = this.cam.size < 9000;
    for (const camp of this.e.camps) {
      const x = Math.round(this.sx(camp.pos.x)), y = Math.round(this.sy(camp.pos.y));
      if (x < -10 || y < -10 || x > RES + 10 || y > RES + 10) continue;
      if (camp.alive) {
        c.fillStyle = camp.kind === "blue" ? "#58a6ff" : camp.kind === "red" ? "#ff6b4a" : camp.kind === "scuttle" ? "#9ff0d0" : "#c8b88a";
        const s = camp.kind === "blue" || camp.kind === "red" ? (zoomed ? 5 : 3) : zoomed ? 4 : 2;
        c.fillRect(x - s / 2, y - s / 2, s, s);
      } else if (zoomed) {
        const left = Math.ceil(camp.spawnAt - this.e.t);
        if (left > 0 && left < 400) {
          c.font = "8px Galmuri9, monospace";
          c.fillStyle = "rgba(220,220,230,0.8)";
          c.textAlign = "center";
          c.fillText(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, x, y + 3);
        }
      }
    }
  }

  private drawObjectives(now: number) {
    const c = this.ctx;
    const items: [keyof Engine["obj"], string][] = [["dragon", "#ff9a3c"], ["elder", "#c9f0ff"], ["baron", "#b06cff"], ["herald", "#9a7bff"], ["grubs", "#c68cff"]];
    for (const [k, col] of items) {
      const o = this.e.obj[k];
      const x = Math.round(this.sx(o.pos.x)), y = Math.round(this.sy(o.pos.y));
      if (o.alive) {
        const pulse = 1 + Math.sin(now / 250) * 0.15;
        const r = (this.cam.size > 9000 ? 5 : 9) * pulse;
        c.fillStyle = col;
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "#0a0d16";
        c.fillRect(x - 1, y - 1, 2, 2);
        // hp ring while being hit
        if (o.hp < o.maxHp) {
          c.strokeStyle = "#ffe28a";
          c.lineWidth = 2;
          c.beginPath();
          c.arc(x, y, r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (o.hp / o.maxHp));
          c.stroke();
        }
      }
    }
  }

  /** Unit positions before the latest engine step, and how far (0..1) the clock has run toward the next step.
   *  Units are drawn between the two, so slow play (a teamfight in real time is only 4 engine steps a second)
   *  still moves smoothly. The match loop calls beforeStep() before each step and sets lerp after stepping. */
  private stepFrom: Vec[] = [];
  lerp = 1;
  beforeStep() {
    this.stepFrom = this.e.units.map((u) => ({ x: u.x, y: u.y }));
  }

  /** Where to draw a unit: between engine steps (see lerp), plus the knock-up bob unless `bob` is off. */
  unitPos(u: Unit, now: number, bob = true): Vec {
    let x = u.x, y = u.y;
    const p = this.stepFrom[u.i];
    if (p && this.lerp < 1) {
      const dx = u.x - p.x, dy = u.y - p.y;
      // a dash, flash or respawn jumps: draw it where it landed rather than sliding across
      if (dx * dx + dy * dy < 400 * 400) {
        x = p.x + dx * this.lerp;
        y = p.y + dy * this.lerp;
      }
    }
    let up = 0;
    if (bob) {
      for (const f of this.live) {
        if (f.kind === "knockup" && f.to === u.i) {
          const t = (now - f.born) / f.life;
          if (t >= 0 && t < 1) up = Math.sin(t * Math.PI) * 220; // hits are scheduled ahead (born in the future)
        }
      }
    }
    return { x, y: y + up };
  }

  private drawUnits(now: number) {
    const c = this.ctx;
    const zoomed = this.cam.size < 9000;
    const size = zoomed ? 22 : 15;
    for (const u of this.e.units) {
      if (!u.alive) continue;
      const p = this.unitPos(u, now);
      const x = Math.round(this.sx(p.x)), y = Math.round(this.sy(p.y));
      if (x < -30 || y < -30 || x > RES + 30 || y > RES + 30) continue;
      let alpha = 1;
      for (const f of this.live) if (f.kind === "stealth" && f.from === u.i) alpha = 0.35;
      c.globalAlpha = alpha;
      const ring = u.side ? RED : BLUE;
      // team ring
      c.fillStyle = ring;
      c.fillRect(x - size / 2 - 1, y - size / 2 - 1, size + 2, size + 2);
      if (this.highlightSide === u.side) {
        c.strokeStyle = "#ffd36b";
        c.lineWidth = 1;
        c.strokeRect(x - size / 2 - 2.5, y - size / 2 - 2.5, size + 5, size + 5);
      }
      const img = imgCache.get(u.champ.id);
      if (img?.complete && img.naturalWidth) c.drawImage(img, x - size / 2, y - size / 2, size, size);
      else {
        c.fillStyle = u.champ.color || "#888";
        c.fillRect(x - size / 2, y - size / 2, size, size);
      }
      // shield
      if (u.shield > 5) {
        c.strokeStyle = "rgba(255,255,255,0.9)";
        c.lineWidth = 1;
        c.strokeRect(x - size / 2 - 3.5, y - size / 2 - 3.5, size + 7, size + 7);
      }
      // stun
      if (this.e.t < u.stunUntil) {
        c.fillStyle = "#ffe95a";
        for (let i = 0; i < 3; i++) {
          const a = now / 150 + (i * Math.PI * 2) / 3;
          c.fillRect(Math.round(x + Math.cos(a) * 7) - 1, Math.round(y - size / 2 - 5 + Math.sin(a) * 2) - 1, 2, 2);
        }
      }
      // hp bar
      const bw = size + 2;
      c.fillStyle = "#0a0d16";
      c.fillRect(x - bw / 2, y - size / 2 - 5, bw, 3);
      c.fillStyle = u.side ? "#ff6b6b" : "#5ad07a";
      c.fillRect(x - bw / 2, y - size / 2 - 5, Math.max(1, Math.round(bw * (u.hp / u.maxHp))), 3);
      if (u.baronUntil > this.e.t) {
        c.fillStyle = "#b06cff";
        c.fillRect(x + size / 2 - 2, y + size / 2 - 2, 4, 4);
      }
      if (zoomed) {
        c.font = "8px Galmuri9, monospace";
        c.textAlign = "center";
        c.fillStyle = "#0a0d16";
        c.fillText(u.name, x + 1, y + size / 2 + 9);
        c.fillStyle = "#e8ecf5";
        c.fillText(u.name, x, y + size / 2 + 8);
      }
      // recall column
      if (u.recallEnd !== undefined) {
        c.strokeStyle = "#7fd3ff";
        c.globalAlpha = 0.5 + Math.sin(now / 100) * 0.3;
        c.beginPath();
        c.arc(x, y, size / 2 + 4, 0, Math.PI * 2 * (1 - (u.recallEnd - this.e.t) / 8));
        c.stroke();
      }
      c.globalAlpha = 1;
    }
  }

  private drawParticles(now: number) {
    const c = this.ctx;
    this.parts = this.parts.filter((p) => now - p.born < p.life);
    for (const p of this.parts) {
      const t = (now - p.born) / p.life;
      const age = (now - p.born) / 1000;
      const x = this.sx(p.x + p.vx * age), y = this.sy(p.y + p.vy * age);
      c.globalAlpha = 1 - t;
      c.fillStyle = p.color;
      c.fillRect(Math.round(x), Math.round(y), p.size, p.size);
    }
    c.globalAlpha = 1;
  }

  /** Screen position of a unit in CSS pixels relative to the canvas, for DOM overlays. */
  screenOf(i: number): { x: number; y: number } {
    const u = this.e.units[i];
    const rect = this.canvas.getBoundingClientRect();
    return { x: (this.sx(u.x) / RES) * rect.width, y: (this.sy(u.y) / RES) * rect.height };
  }
}
