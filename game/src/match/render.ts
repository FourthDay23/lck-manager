// Canvas renderer for the match: low-res 512px buffer scaled up with nearest-neighbour, so it reads as pixel art.
import type { Engine, Fx, GameEvent, ObjKey, Unit } from "./engine";
import { MAP, NEXUS, LANES, BARON_PIT, DRAGON_PIT, GRUB_SPOTS, MIRROR_C, lanePoint, laneU } from "./map";
import type { CampKind, Vec } from "./map";
import { champImg, spellImg } from "../data/load";
import { SkillFx } from "./vfx";
import * as Macro from "./macro";
import * as Summoners from "./summoners";
import type { SummonerName } from "./summoners.gen";
import type { LiveFx } from "./vfx";

export const RES = 512;
export type CamMode = "auto" | "all" | "top" | "mid" | "bot" | "jungle" | "follow";
interface Cam { x: number; y: number; size: number }
/** A candidate camera shot for the broadcast director. `reason` is the caption shown when the camera cuts to it. */
interface Shot { id: string; x: number; y: number; size: number; score: number; label: string; reason: string }
/** The line under the board; `at` is the real time (performance.now()) it came up. */
export interface CutCaption { text: string; at: number }
interface Caption extends CutCaption { prio: number; x?: number; y?: number; born: number }
/** A caption stays at least this long before another may replace it (unless that one matters far more), and at most CAPTION_MS. */
export const CAPTION_MIN = 3000;
export const CAPTION_MS = 4200;
/** ms the whole map shows where the camera is about to go in */
const CUE_MS = 350;
/** ms a summoner spell's icon and mark stay on the map */
const SUM_MS = 1500;
/** ms a death marker stays on the map */
const DEATH_MS = 2800;
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

// ---------- pixel sprites: rows of palette keys, "." is empty (MatchRenderer.sprite) ----------
/** tower, 7 x 9 cells: crown (x), light (c), body and base (b) */
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
/**
 * Jungle camps and epic monsters are all drawn as the same mark, a disc with a dark outline (MatchRenderer.disc):
 * no shape of its own per monster (the owner's call, 11-28). Colour tells them apart, and size the camps from the
 * epic monsters. Radius in buffer px on the whole map and in a close-up; a disc is 2r + 1 across.
 */
const CAMP_R = [3, 5];
const EPIC_R = [5, 9];
const GRUB_R = [2, 3];
/** A camp that is up: a bright colour inside the dark outline, so it stands out from the olive ground. */
const CAMP_COL: Record<CampKind | "scuttle", string> = {
  blue: "#5fb0ff", red: "#ff6b4a", gromp: "#ffe9a8", wolves: "#ffe9a8", raptors: "#ffe9a8", krugs: "#ffe9a8", scuttle: "#7ff0d0",
};
/** A camp or monster that is not up: the same disc, dim, with the time left under it. */
const GONE_COL = "#5a6274";
const GONE_ALPHA = 0.8;
const OBJ_COL: Record<ObjKey, string> = { dragon: "#ff9a3c", elder: "#c9f0ff", baron: "#b06cff", herald: "#9a7bff", grubs: "#d7a4ff" };
/** What stands in each pit, most important first: only one waits there at a time. */
const PITS: ObjKey[][] = [["elder", "dragon"], ["baron", "herald", "grubs"]];
/** ms a camp that just came up is ringed */
const CAMP_UP_MS = 900;
interface Box { x: number; y: number; w: number; h: number }

export class MatchRenderer {
  ctx: CanvasRenderingContext2D;
  mode: CamMode = "auto";
  followIdx = 1;
  /** the next frame jumps straight to the target instead of gliding */
  private snap = true;
  /** What the auto camera shows, for the LIVE tag: "전체 맵", or the teamfight it is in on. */
  shotLabel = "전체 맵";
  /**
   * Auto camera (see pacing.ts): the whole map while the game is fast-forwarded, a close-up only while the clock is
   * slowed for a teamfight. `focusId` is that fight (0 = none), set by the match loop every frame.
   */
  private focusId = 0;
  private focusSize = 0;
  /** real time the focus was set: the spot is marked on the whole map for CUE_MS before the camera goes in */
  private focusAt = 0;
  /** the camera is in the close-up */
  private close = false;
  /** the frame the close-up is heading for (it only moves when the fight leaves the middle of the view) */
  private aim: Cam | null = null;
  private following = false;
  /** the spot about to be shown, and the close-up just left: both drawn as a box on the whole map */
  private cue: Cam | null = null;
  private left: { cam: Cam; at: number } | null = null;
  private leftAt = -1e9;
  private drawnAt = 0;
  /** false while the game is paused: the idle attack animations stop too */
  animate = true;
  /** One line under the board; see say(). */
  private cap: Caption | null = null;
  private capNext: Caption | null = null;
  private sceneSeen = new Map<string, number>();
  private sceneT = -1;
  /** champions that just died: a grey marker stays where they fell */
  private deaths: { x: number; y: number; side: 0 | 1; champ: string; born: number }[] = [];
  /** summoner spells just used (Fx.sum): the icon over the caster and the spell's mark, see drawSums */
  private sums: { name: SummonerName; from: number; to: number; x: number; y: number; tx: number; ty: number; born: number; arrive: boolean }[] = [];
  /** how far each icon is drawn from its unit so that icons do not cover each other (world units) */
  private spread: Vec[] = [];
  /** camps that are up, by id: the real time each came up (it is ringed for a moment) and the health it came up with */
  private campUp = new Map<number, { at: number; full: number }>();
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
    // auto camera: a new game starts on the whole map with nothing queued
    this.shotLabel = "전체 맵";
    this.labelFor = this.saidFor = 0;
    this.focusId = this.focusSize = this.focusAt = 0;
    this.close = this.following = false;
    this.aim = this.cue = null;
    this.left = null;
    this.leftAt = -1e9;
    this.cap = this.capNext = null;
    this.sceneSeen.clear();
    this.sceneT = -1;
    this.deaths = [];
    this.sums = [];
    this.spread = [];
    this.campUp.clear();
    this.prevPos = null;
    this.upCache = null;
    this.snap = true;
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
      case "shutdown": {
        const gold = ev.text.match(/제압골 \d+골드/)?.[0];
        return a && v ? `${josa(this.tag(a), "이가")} ${this.tag(v)}의 연속 킬을 끊었습니다${gold ? ` (${gold})` : ""}` : plain(ev.text);
      }
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
      // the same words as the pacing: a teamfight is six or more (pacing.ts), anything smaller is a skirmish
      const label = n >= 8 ? "대규모 한타" : n >= 6 ? "한타" : n >= 3 ? "소규모 교전" : f.origin === "gank" ? "갱킹" : "교전";
      const place = this.placeOf(cx, cy);
      let reason: string;
      if (f.origin === "gank") {
        const jg = m.find((u) => u.role === "Jungle");
        reason = jg ? `${josa(this.tag(jg), "이가")} ${josa(place, "으로")} 갱킹을 왔습니다` : `${place}에 갱킹이 들어왔습니다`;
      } else if (n === 2) {
        reason = `${place}에서 ${josa(this.tag(m[0]), "과와")} ${josa(this.tag(m[1]), "이가")} 맞붙었습니다`;
      } else if (n >= 6) {
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
    // once per engine step: frames between steps (high refresh rate, pause, slow motion) see the same answer
    if (this.upCache && this.upCache.t === e.t) return this.upCache.shots;
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
      // really walking toward each other (standing close is just the lane)
      const closing = foes.some((b) => {
        if (!prev || dt <= 0) return false;
        const pa = prev.pos[a.i], pb = prev.pos[b.i];
        const before = Math.hypot(pa.x - pb.x, pa.y - pb.y), after = Math.hypot(a.x - b.x, a.y - b.y);
        return (before - after) / dt > 60;
      });
      if (!closing) continue;
      // the group: everyone within 1000 of the two sides' members
      const group = new Set<Unit>([a, ...foes]);
      for (const u of alive) if ([...group].some((g) => Math.hypot(g.x - u.x, g.y - u.y) < 1000)) group.add(u);
      const m = [...group];
      m.forEach((u) => seen.add(u.i));
      // laners trading in their lane (1v1, the bot 2v2) are the lane, not a fight about to start: it takes three
      // or more with at least one who came from elsewhere (jungler, roamer, a group on the move)
      if (m.length < 3 || m.every((u) => u.task === "lane")) continue;
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
    this.upCache = { t: e.t, shots: out };
    return out;
  }
  private upCache: { t: number; shots: Shot[] } | null = null;

  /** The match loop passes on what pacing.ts decided: the teamfight to frame (0 = none) and how big it is. */
  setFocus(id: number, size: number, now: number) {
    if (id && !this.focusId) this.focusAt = now;
    this.focusId = id;
    if (id) this.focusSize = size;
  }

  /** The frame that holds a fight: its champions with room around them for spells and for the ones walking in. */
  private fightFrame(id: number): Cam | null {
    const f = this.e.fights.get(id);
    const all = this.e.units.filter((u) => u.alive && u.fightId === id);
    if (!f || !all.length) return null;
    // someone still a screen away would stretch the frame until nobody can be made out: frame the ones at the fight
    // (the ones walking in come into the frame as they arrive)
    const near = all.filter((u) => Math.hypot(u.x - f.x, u.y - f.y) < 1700);
    const m = near.length >= 2 ? near : all;
    const xs = m.map((u) => u.x), ys = m.map((u) => u.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(2600, Math.min(5000, Math.max(x1 - x0, y1 - y0) + 1400)) };
  }

  /**
   * Auto camera. Fast-forward is watched on the whole map: at 8x and more a close-up is a blur (a champion crosses the
   * view in about a second) and every cut costs the viewer their bearings. Only a teamfight, which runs in real time,
   * gets a close-up: the spot is boxed on the whole map for a moment, then the camera cuts in, stays on one frame
   * (following only when the fight leaves the middle), and cuts back out when the fight is over.
   */
  private autoCam(now: number): Cam {
    const e = this.e;
    const frame = this.focusId ? this.fightFrame(this.focusId) : null;
    if (!this.close) {
      this.cue = null;
      if (!this.focusId || !frame) {
        this.shotLabel = "전체 맵";
        this.labelFor = 0;
        return { ...PRESETS.all };
      }
      this.shotLabel = this.fightLabel(frame);
      // mark the spot first; and never go back in within 1.5 s of coming out (the fight is in real time by then, so
      // nothing is missed on the whole map, and out-in-out is what made the old camera hard to watch)
      if (now - this.focusAt < CUE_MS || now - this.leftAt < 1500) {
        this.cue = this.fit(frame);
        return { ...PRESETS.all };
      }
      this.close = true;
      this.following = false;
      this.aim = this.fit(frame);
      this.snap = true;
      this.announce(frame, now);
      return frame;
    }
    if (!this.focusId) {
      // the fight is over: back to the whole map, with the place just left marked for a moment
      this.left = { cam: { ...this.cam }, at: now };
      this.leftAt = now;
      this.close = false;
      this.aim = null;
      this.snap = true;
      this.shotLabel = "전체 맵";
      this.labelFor = 0;
      return { ...PRESETS.all };
    }
    if (frame && this.aim) {
      // hold the frame; move only when someone in the fight is near the edge or the frame no longer fits
      const c = this.cam;
      this.shotLabel = this.fightLabel(frame);
      if (Math.hypot(frame.x - c.x, frame.y - c.y) > c.size) {
        // the focus moved to a fight somewhere else (the first one ended, or a far bigger one took over): that is
        // a cut, not a pan, and it is said like any other teamfight the camera goes to
        this.aim = this.fit(frame);
        this.following = false;
        this.snap = true;
        this.announce(frame, now);
        return frame;
      }
      const edge = c.size * 0.43;
      const m = e.units.filter((u) => u.alive && u.fightId === this.focusId && Math.hypot(u.x - frame.x, u.y - frame.y) < frame.size);
      const out = m.some((u) => Math.abs(u.x - c.x) > edge || Math.abs(u.y - c.y) > edge);
      if (!this.following && (out || frame.size > c.size * 1.3 || frame.size < c.size * 0.5)) {
        // one move to where the fight is now, a little roomier so the next one is not needed at once, then hold
        // again (chasing the frame every step never came to rest)
        this.following = true;
        // (kept inside the map here, or "arrived" below would never come true at the map's edge)
        this.aim = this.fit({ x: frame.x, y: frame.y, size: Math.min(5200, frame.size * 1.18) });
      } else if (this.following && Math.hypot(this.aim.x - c.x, this.aim.y - c.y) < c.size * 0.03 && Math.abs(this.aim.size - c.size) < c.size * 0.05) {
        this.following = false;
      }
    }
    return this.aim ? { ...this.aim } : { ...this.cam };
  }

  /** The place is named once per fight: one that drifts along the river would otherwise flip the tag between "미드"
   *  and "위쪽 강가". Its size may still grow into a 대규모 한타. */
  private fightLabel(frame: Cam): string {
    if (this.labelFor !== this.focusId) {
      this.labelFor = this.focusId;
      this.labelPlace = this.placeOf(frame.x, frame.y);
    }
    return `${this.labelPlace} ${this.focusSize >= 8 ? "대규모 한타" : "한타"}`;
  }
  private labelPlace = "";
  private labelFor = 0;
  /** the fight the opening line was last said for (one line per fight, however the frame moves) */
  private saidFor = 0;

  /** The line for the teamfight the camera goes to, unless one about this very spot has only just come up. */
  private announce(frame: Cam, now: number) {
    if (this.saidFor === this.focusId) return;
    this.saidFor = this.focusId;
    const cur = this.cap;
    if (cur && cur.x !== undefined && now - cur.at < 2500 && Math.hypot(cur.x - frame.x, (cur.y ?? 0) - frame.y) < 1800) return;
    const m = this.e.units.filter((u) => u.alive && u.fightId === this.focusId);
    this.say(`${this.placeOf(frame.x, frame.y)}에서 ${this.headcount(m)} ${josa(this.focusSize >= 8 ? "대규모 한타" : "한타", "이가")} 열렸습니다`, 5, now, frame);
  }

  // ---------- summoner spells ----------
  private sumIcons = new Map<string, HTMLImageElement>();
  private sumIcon(name: SummonerName): HTMLImageElement {
    let img = this.sumIcons.get(name);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous";
      img.src = spellImg(this.version, Summoners.SUMMONER_ICON[name]);
      this.sumIcons.set(name, img);
    }
    return img;
  }

  /** A summoner spell was used (Fx.sum): remember it for the icon over the caster and the spell's mark on the map. */
  private sumUsed(f: Fx, now: number) {
    if (!f.sum || f.from === undefined) return;
    const arrive = f.kind === "sum" && f.sum === "teleport" && f.to === f.from;
    // the start of a teleport needs no icon: the channel ring and the landing beacon are drawn from the engine
    if (f.sum === "teleport" && !arrive) return;
    // one icon per champion and spell at a time
    this.sums = this.sums.filter((s) => s.from !== f.from || s.name !== f.sum);
    this.sums.push({ name: f.sum, from: f.from, to: f.to ?? -1, x: f.x, y: f.y, tx: f.tx, ty: f.ty, born: now, arrive });
    if (f.kind !== "sum") return; // the Flash blink and the objective smite already have their own effect
    if (f.sum === "heal") {
      this.burst(f.x, f.y, "#7dff8a", 8, now, -1);
      if (f.to !== undefined && f.to !== f.from) this.burst(f.tx, f.ty, "#7dff8a", 8, now, -1);
    } else if (f.sum === "ignite") this.burst(f.tx, f.ty, "#ff7a3c", 12, now);
    else if (f.sum === "exhaust") this.burst(f.tx, f.ty, "#c9b27a", 8, now);
    else if (f.sum === "barrier") this.burst(f.x, f.y, "#ffd36b", 10, now);
    else if (f.sum === "cleanse") this.burst(f.x, f.y, "#bfefff", 10, now);
    else if (f.sum === "ghost") this.burst(f.x, f.y, "#8fd0ff", 8, now);
    else if (arrive) {
      this.burst(f.x, f.y, "#b48cff", 16, now);
      this.shake = Math.max(this.shake, 2);
    }
  }

  /**
   * Summoner spells on the map. A Teleport shows for its whole channel at both ends (read from the engine, so it is
   * right at any playback speed): a ring on the champion and a beacon where it will land, which is what tells a
   * viewer of the whole map that someone is coming. The other spells show their icon at the caster's corner for a
   * moment and a mark on whoever they hit.
   */
  private drawSums(now: number) {
    const c = this.ctx, e = this.e;
    const size = this.iconSize();
    const wide = this.cam.size >= 9000;
    for (const u of e.units) {
      if (!u.alive) continue;
      const ch = Summoners.channel(e, u);
      if (ch) {
        const p = this.unitPos(u, now, false);
        const m = this.centre(p, size), x = Math.floor(m.x), y = Math.floor(m.y);
        // on the champion: a turning dashed ring and a column of light
        c.strokeStyle = "#b48cff";
        c.lineWidth = 2;
        c.setLineDash([3, 3]);
        c.lineDashOffset = -now / 60;
        c.beginPath();
        c.arc(m.x, m.y, size / 2 + 5, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 0.45 + Math.sin(now / 90) * 0.25;
        c.fillStyle = "#d9c4ff";
        c.fillRect(x - 1, m.y - size / 2 - 16, 3, 12);
        c.globalAlpha = 1;
        // where it lands: a beacon that fills as the channel runs
        const bx = Math.round(this.sx(ch.to.x)), by = Math.round(this.sy(ch.to.y));
        const r = Math.max(wide ? 7 : 10, this.len(260)) + Math.sin(now / 120) * 1.5;
        c.fillStyle = "rgba(180,140,255,0.22)";
        c.beginPath();
        c.arc(bx, by, r, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = "#05070d";
        c.lineWidth = 4;
        c.beginPath();
        c.arc(bx, by, r, 0, Math.PI * 2);
        c.stroke();
        c.strokeStyle = "#b48cff";
        c.lineWidth = 2;
        c.beginPath();
        c.arc(bx, by, r, 0, Math.PI * 2);
        c.stroke();
        c.strokeStyle = "#ffffff";
        c.beginPath();
        c.arc(bx, by, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ch.k);
        c.stroke();
        c.fillStyle = u.side ? RED : BLUE;
        c.fillRect(bx - 2, by - 2, 5, 5);
        const img = this.sumIcon("teleport");
        const s = wide ? 9 : 12;
        if (img.complete && img.naturalWidth) {
          c.fillStyle = "#05070d";
          c.fillRect(bx - s / 2 - 1, by - r - s - 3, s + 2, s + 2);
          c.drawImage(img, bx - s / 2, by - r - s - 2, s, s);
        }
      }
      if (Summoners.ghosting(e, u)) {
        // Ghost: speed lines trailing behind
        const p = this.unitPos(u, now, false);
        const m = this.centre(p, size), x = Math.floor(m.x), y = Math.floor(m.y);
        c.strokeStyle = "rgba(143,208,255,0.85)";
        c.lineWidth = 1;
        c.strokeRect(m.x - size / 2 - 3.5, m.y - size / 2 - 3.5, size + 7, size + 7);
      }
    }
    this.sums = this.sums.filter((s) => now - s.born < SUM_MS);
    const stack: Record<number, number> = {};
    for (const s of this.sums) {
      const k = (now - s.born) / SUM_MS;
      const u = e.units[s.from];
      const v = s.to >= 0 ? e.units[s.to] : undefined;
      c.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      // the mark on the target
      if (v && v.alive && (s.name === "ignite" || s.name === "exhaust" || (s.name === "heal" && v !== u))) {
        const p = this.unitPos(v, now, false);
        const m = this.centre(p, size), x = Math.floor(m.x), y = Math.floor(m.y);
        if (s.name === "ignite") {
          // a flame licking over the icon
          for (let i = 0; i < 4; i++) {
            const fx = m.x - size / 2 + 2 + ((i * 7 + Math.floor(now / 90)) % Math.max(4, size - 2));
            const fh = 3 + ((i * 5 + Math.floor(now / 70)) % 4);
            c.fillStyle = i % 2 ? "#ffd36b" : "#ff7a3c";
            c.fillRect(fx, m.y - size / 2 - fh, 2, fh);
          }
        } else if (s.name === "exhaust") {
          c.strokeStyle = "#c9b27a";
          c.lineWidth = 2;
          c.beginPath();
          c.arc(m.x, m.y, size / 2 + 6 - k * 4, 0, Math.PI * 2);
          c.stroke();
        } else {
          c.fillStyle = "#7dff8a";
          c.fillRect(x - 1, m.y - size / 2 - 9 - k * 6, 3, 7);
          c.fillRect(x - 3, m.y - size / 2 - 7 - k * 6, 7, 3);
        }
      }
      if (!u || !u.alive) continue;
      const p = this.unitPos(u, now, false);
      const m = this.centre(p, size), x = Math.floor(m.x), y = Math.floor(m.y);
      if (s.name === "barrier" || s.name === "cleanse" || s.name === "ghost" || s.arrive || (s.name === "heal")) {
        // a ring around the caster: golden shield, a cleansing burst, the landing
        c.strokeStyle = s.name === "barrier" ? "#ffd36b" : s.name === "cleanse" ? "#bfefff" : s.name === "ghost" ? "#8fd0ff" : s.name === "heal" ? "#7dff8a" : "#b48cff";
        c.lineWidth = 2;
        c.beginPath();
        c.arc(m.x, m.y, s.arrive ? size / 2 + 14 - k * 10 : size / 2 + 3 + k * 8, 0, Math.PI * 2);
        c.stroke();
      }
      // the spell's icon at the caster's upper right corner (skill chips sit centred above, so the two do not cover
      // each other)
      const img = this.sumIcon(s.name);
      const is = wide ? 10 : 13;
      // two spells at once (Flash and Heal in the same breath): the second icon goes above the first
      const nth = stack[s.from] ?? 0;
      stack[s.from] = nth + 1;
      const ix = x + Math.round(size / 2) - 3, iy = y - Math.round(size / 2) - is + 3 - Math.round(Math.min(1, k * 8) * 2) - nth * (is + 3);
      c.fillStyle = "#05070d";
      c.fillRect(ix - 2, iy - 2, is + 4, is + 4);
      c.fillStyle = "#ffd36b";
      c.fillRect(ix - 1, iy - 1, is + 2, is + 2);
      if (img.complete && img.naturalWidth) c.drawImage(img, ix, iy, is, is);
      else {
        c.fillStyle = "#3a4366";
        c.fillRect(ix, iy, is, is);
      }
    }
    c.globalAlpha = 1;
  }

  /** Keep a view inside the map so no black edges show. */
  private fit(c: Cam): Cam {
    const half = c.size / 2;
    if (c.size >= MAP.maxX - MAP.minX) return c;
    return { x: Math.max(MAP.minX + half, Math.min(MAP.maxX - half, c.x)), y: Math.max(MAP.minY + half, Math.min(MAP.maxY - half, c.y)), size: c.size };
  }

  private target(now: number): Cam {
    let c: Cam;
    if (this.mode === "auto") c = this.autoCam(now);
    else {
      // manual camera: the auto camera starts fresh when it comes back
      this.close = false;
      this.aim = this.cue = null;
      if (this.mode === "jungle" || this.mode === "follow") {
        const u = this.e.units[this.followIdx] ?? this.e.units[1];
        c = { x: u.x, y: u.y, size: this.mode === "jungle" ? 6200 : 5200 };
      } else c = { ...PRESETS[this.mode] };
    }
    return this.fit(c);
  }

  // ---------- the line under the board ----------
  /**
   * Queue one line of commentary. Only one shows at a time, for at least CAPTION_MIN: before this a new sentence came
   * up every 2.1 s and three in four were replaced inside 2 s, which nobody can read. A line that matters far more
   * (a teamfight opening, its result) may cut in; a line that has waited too long is dropped rather than shown late.
   */
  say(text: string, prio: number, now: number, at?: Vec) {
    const c: Caption = { text, prio, at: now, born: now, x: at?.x, y: at?.y };
    const cur = this.cap;
    if (!cur || now - cur.at >= CAPTION_MIN || prio >= cur.prio + 2) {
      this.cap = c;
      this.capNext = null;
    } else if (!this.capNext || prio >= this.capNext.prio) this.capNext = c;
  }

  /** The line to show now, or null. */
  caption(now: number): CutCaption | null {
    const next = this.capNext;
    // a waiting line is dropped once it is stale; the limit has to be longer than CAPTION_MIN, or a line queued in the
    // first half second of the current one could never come up
    if (next && now - next.born > (next.prio >= 5 ? 5000 : CAPTION_MIN + 400)) this.capNext = null;
    else if (next && (!this.cap || now - this.cap.at >= CAPTION_MIN)) {
      this.cap = { ...next, at: now };
      this.capNext = null;
    }
    return this.cap && now - this.cap.at <= CAPTION_MS ? this.cap : null;
  }

  /** The result of the teamfight the camera just left (pacing.ts FightResult). */
  sayResult(r: { kills: [number, number]; taken: { side: 0 | 1; text: string }[]; x: number; y: number }, now: number) {
    const n = this.e.names;
    const took = r.taken.map((t) => `${n[t.side]} ${t.text}`).join(", ");
    const text = r.kills[0] + r.kills[1] === 0
      // (the place as the tag named this fight, so "바론 둥지 한타" does not end as "위쪽 강가 한타")
      ? took ? `한타 결과: ${took}` : `${this.labelFor ? this.labelPlace : this.placeOf(r.x, r.y)} 한타는 킬 없이 끝났습니다`
      : `한타 결과: ${n[0]} ${r.kills[0]}킬, ${n[1]} ${r.kills[1]}킬${took ? ` · ${took}` : ""}`;
    this.say(text, 7, now, r);
  }

  /**
   * New scenes on the map become captions (once each): fights, ganks, objective set-ups, sieges. "About to clash" and
   * replays of what just happened are left out: the first may never happen, the second is what the banners are for.
   */
  private scenes(now: number) {
    const e = this.e;
    if (e.t === this.sceneT) return;
    this.sceneT = e.t;
    for (const s of this.shots()) {
      const kind = s.id[0];
      if (kind === "c" || kind === "e" || s.score < 10) continue;
      const seen = this.sceneSeen.has(s.id);
      this.sceneSeen.set(s.id, e.t);
      if (seen) continue;
      // the teamfight the camera is in gets its own line (autoCam); while it is there only big news from elsewhere counts
      if (s.id === `f${this.focusId}`) continue;
      const prio = kind === "o" ? (s.label.endsWith("대치") ? 4 : 3) : kind === "f" ? (s.score >= 28 ? 3 : s.score >= 20 ? 2 : 1) : 2;
      if (this.close && prio < 4) continue;
      // the same spot again inside a few seconds (a gank on the way, then the gank): the first line is enough
      const cur = this.cap;
      if (cur && cur.x !== undefined && now - cur.at < 4000 && Math.hypot(cur.x - s.x, (cur.y ?? 0) - s.y) < 1800 && prio <= cur.prio) continue;
      this.say(s.reason, prio, now, s);
    }
    for (const [id, t] of this.sceneSeen) if (e.t - t > 10) this.sceneSeen.delete(id);
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

  // ---------- drawing on whole pixels, centred on the point ----------
  /**
   * Centre of a `size` px icon at a world point, placed so that the icon's edges are on whole buffer pixels. Icons are
   * drawn from `x - size / 2`: with the centre rounded to a whole pixel, an odd size (the 15 px icons of the whole
   * map) put every edge of the icon, its ring and its bars across half a pixel, which the canvas draws blurred and a
   * pixel wider on one side. The centre stays within half a pixel of the point.
   */
  private centre(p: Vec, size: number): Vec {
    const h = size / 2;
    return { x: Math.round(this.sx(p.x) - h) + h, y: Math.round(this.sy(p.y) - h) + h };
  }

  /**
   * A pixel sprite (rows of palette keys, "." empty) with its middle on a world point, `u` buffer px a cell, a dark
   * outline around it. Returns the box it covers.
   */
  private sprite(rows: string[], p: Vec, u: number, pal: Record<string, string>, alpha = 1): Box {
    const c = this.ctx;
    const w = rows[0].length * u, h = rows.length * u;
    const ox = Math.round(this.sx(p.x) - w / 2), oy = Math.round(this.sy(p.y) - h / 2);
    c.globalAlpha = alpha;
    c.fillStyle = "#05070d";
    for (let ry = 0; ry < rows.length; ry++) for (let rx = 0; rx < rows[ry].length; rx++) {
      if (rows[ry][rx] !== ".") c.fillRect(ox + rx * u - 1, oy + ry * u - 1, u + 2, u + 2);
    }
    for (let ry = 0; ry < rows.length; ry++) for (let rx = 0; rx < rows[ry].length; rx++) {
      const ch = rows[ry][rx];
      if (ch === ".") continue;
      c.fillStyle = pal[ch];
      c.fillRect(ox + rx * u, oy + ry * u, u, u);
    }
    c.globalAlpha = 1;
    return { x: ox, y: oy, w, h };
  }

  /**
   * A filled pixel disc with a dark outline, its middle on the buffer pixel a world point falls in and `r` px from
   * there to its edge. Returns the box it covers (without the outline).
   */
  private disc(p: Vec, r: number, col: string, alpha = 1): Box {
    const c = this.ctx;
    const cx = Math.floor(this.sx(p.x)), cy = Math.floor(this.sy(p.y));
    c.globalAlpha = alpha;
    for (const [rad, fill] of [[r + 1, "#05070d"], [r, col]] as const) {
      c.fillStyle = fill;
      for (let d = -rad; d <= rad; d++) {
        // (the half pixel makes the small sizes round: r 3 gives rows of 3 5 7 7 7 5 3)
        const half = Math.floor(Math.sqrt((rad + 0.5) ** 2 - d * d));
        c.fillRect(cx - half, cy + d, half * 2 + 1, 1);
      }
    }
    c.globalAlpha = 1;
    return { x: cx - r, y: cy - r, w: 2 * r + 1, h: 2 * r + 1 };
  }

  /** A filled pixel diamond with its middle on buffer pixel (cx, cy), `r` px from there to each tip. */
  private diamond(cx: number, cy: number, r: number, col: string) {
    const c = this.ctx;
    c.fillStyle = col;
    for (let d = -r; d <= r; d++) {
      const half = r - Math.abs(d);
      c.fillRect(cx - half, cy + d, half * 2 + 1, 1);
    }
  }

  /** A health bar under a sprite's box. */
  private bar(b: Box, f: number, col: string) {
    const c = this.ctx;
    c.fillStyle = "#05070d";
    c.fillRect(b.x - 1, b.y + b.h + 1, b.w + 2, 3);
    c.fillStyle = col;
    c.fillRect(b.x, b.y + b.h + 2, Math.max(1, Math.round(b.w * Math.max(0, Math.min(1, f)))), 1);
  }

  /** Time left as m:ss under a sprite's box, with a dark edge so it reads on any ground. */
  private timer(b: Box, left: number, col = "#eef1f8") {
    const c = this.ctx;
    const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    const x = b.x + b.w / 2, y = b.y + b.h + 9;
    c.font = "8px Galmuri9, monospace";
    c.textAlign = "center";
    c.fillStyle = "#05070d";
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) c.fillText(text, x + dx, y + dy);
    c.fillStyle = col;
    c.fillText(text, x, y);
  }

  /** Pull new fx from the engine and give each a real-time lifetime. */
  private ingest(now: number) {
    const fx = this.e.fx;
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i];
      if (f.id <= this.fxSeen) continue;
      // summoner spells: the icon over the caster, and for kind "sum" the spell's own mark instead of a skill shape
      if (f.sum) this.sumUsed(f, now);
      if (f.kind === "sum") continue;
      const made = this.skills.ingest(f, now, this.live, this.e);
      this.live.push(...made);
      // ultimates: gold sparks off the caster and a small jolt
      if (made[0].key === "R" && !made[0].pve && made[0].kind !== "hit") { this.burst(f.x, f.y, "#ffd36b", 10, now); this.shake = Math.max(this.shake, 2); }
      if (f.kind === "kill") {
        this.burst(f.x, f.y, f.color, 14, now);
        const v = f.to !== undefined ? this.e.units[f.to] : undefined;
        if (v) this.deaths.push({ x: f.x, y: f.y, side: v.side, champ: v.champ.id, born: now });
      }
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
    const dt = Math.max(0, Math.min(100, now - this.drawnAt));
    this.drawnAt = now;
    const tgt = this.target(now);
    // the scale changed in one frame (a cut): icon offsets go straight to their new values instead of easing
    let jumped = false;
    if (this.mode === "auto") {
      this.scenes(now);
      // going in and coming out are cuts (a pan across the map at speed was what made the view hard to watch);
      // inside the close-up the camera follows at the pace of the fight, which now runs in real time
      if (this.snap || !this.close) {
        jumped = Math.abs(tgt.size - this.cam.size) > this.cam.size * 0.05;
        this.cam = { ...tgt };
      } else {
        const k = 1 - Math.exp(-dt / 420);
        this.cam.x += (tgt.x - this.cam.x) * k;
        this.cam.y += (tgt.y - this.cam.y) * k;
        this.cam.size += (tgt.size - this.cam.size) * k;
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
    this.layout(jumped);
    this.drawMap();
    this.drawLanes(now);
    this.drawStructures();
    this.drawCamps(now);
    this.drawObjectives(now);
    this.drawDeaths(now);
    this.skills.under(this.e, this.live, now);
    this.drawWork(now);
    this.drawUnits(now);
    this.skills.over(this.e, this.live, now);
    this.drawParticles(now);
    this.skills.drawTags(this.e, now);
    this.drawSums(now);
    this.drawMarks(now);
    c.restore();
    if (this.cam.size < 12000) this.drawInset(now);
    this.live = this.live.filter((f) => now - f.born < f.life);
    this.deaths = this.deaths.filter((d) => now - d.born < DEATH_MS);
  }

  private iconSize() {
    return this.cam.size < 9000 ? 22 : 15;
  }

  /** Where a unit is between two engine steps (see lerp), before icons are moved apart. */
  private rawPos(u: Unit): Vec {
    const p = this.stepFrom[u.i];
    if (p && this.lerp < 1) {
      const dx = u.x - p.x, dy = u.y - p.y;
      // a dash, flash or respawn jumps: draw it where it landed rather than sliding across
      if (dx * dx + dy * dy < 400 * 400) return { x: p.x + dx * this.lerp, y: p.y + dy * this.lerp };
    }
    return { x: u.x, y: u.y };
  }

  /**
   * Move icons apart where they would cover each other. An icon is a fixed 15 or 22 px, which is 110 to 440 map units
   * depending on the zoom, while champions in a fight stand 70 to 170 apart: in a teamfight 44 % of the icons had
   * another one on top (scripts/view-diag.ts). Only where things are drawn changes, by less than one icon.
   */
  private layout(jumped: boolean) {
    const us = this.e.units;
    const px = this.cam.size / RES;
    const need = this.iconSize() * 0.96 * px, max = this.iconSize() * 0.9 * px;
    const p = us.map((u) => (u.alive ? this.rawPos(u) : null));
    const off = us.map(() => ({ x: 0, y: 0 }));
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < us.length; i++) {
        const a = p[i];
        if (!a) continue;
        for (let j = i + 1; j < us.length; j++) {
          const b = p[j];
          if (!b) continue;
          let dx = b.x + off[j].x - a.x - off[i].x, dy = b.y + off[j].y - a.y - off[i].y;
          let d = Math.hypot(dx, dy);
          if (d >= need) continue;
          if (d < 1) {
            // the same spot (the fountain after a recall): a fixed direction per pair, so the icons do not flicker
            const ang = (i * 7 + j * 3) * 0.7;
            dx = Math.cos(ang);
            dy = Math.sin(ang);
            d = 1;
          }
          const push = ((need - d) / 2) * 0.85;
          off[i].x -= (dx / d) * push; off[i].y -= (dy / d) * push;
          off[j].x += (dx / d) * push; off[j].y += (dy / d) * push;
        }
      }
    }
    us.forEach((u, i) => {
      const o = off[i];
      const l = Math.hypot(o.x, o.y);
      if (l > max) { o.x *= max / l; o.y *= max / l; }
      const s = this.spread[i];
      // eased, so an icon slides aside instead of popping; straight to the new place after a cut
      this.spread[i] = !s || jumped || !u.alive ? o : { x: s.x + (o.x - s.x) * 0.3, y: s.y + (o.y - s.y) * 0.3 };
    });
  }

  /** A grey marker where a champion just fell, with a cross in the killer's colour. */
  private drawDeaths(now: number) {
    const c = this.ctx;
    const size = this.cam.size < 9000 ? 16 : 11;
    for (const d of this.deaths) {
      const age = (now - d.born) / DEATH_MS;
      const { x, y } = this.centre(d, size);
      if (x < -20 || y < -20 || x > RES + 20 || y > RES + 20) continue;
      c.globalAlpha = age < 0.7 ? 0.9 : 0.9 * (1 - (age - 0.7) / 0.3);
      c.fillStyle = "#05070d";
      c.fillRect(x - size / 2 - 1, y - size / 2 - 1, size + 2, size + 2);
      const img = imgCache.get(d.champ);
      if (img?.complete && img.naturalWidth) c.drawImage(img, x - size / 2, y - size / 2, size, size);
      c.fillStyle = "rgba(20,22,30,0.72)";
      c.fillRect(x - size / 2, y - size / 2, size, size);
      c.strokeStyle = d.side ? BLUE : RED;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x - size / 2 + 2, y - size / 2 + 2); c.lineTo(x + size / 2 - 2, y + size / 2 - 2);
      c.moveTo(x + size / 2 - 2, y - size / 2 + 2); c.lineTo(x - size / 2 + 2, y + size / 2 - 2);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** What a champion outside a fight is working on, if anything: a turret, an objective, a jungle camp or the wave. */
  private workTarget(u: Unit): Vec | null {
    const e = this.e;
    if (u.fightId || u.recallEnd !== undefined || u.task === "recall" || e.t < u.stunUntil) return null;
    const within = (p: Vec, r: number) => Math.hypot(p.x - u.x, p.y - u.y) < r;
    for (const t of e.turrets) {
      if (!t.alive || t.side === u.side || t.hp >= t.maxHp || !within(t.pos, 760)) continue;
      // same rule as the engine (lanesTick): in the laning phase a defended turret takes no champion damage
      if (e.laningPhase() && e.units.some((d) => d.alive && d.side === t.side && Math.hypot(d.x - t.pos.x, d.y - t.pos.y) < 1300)) continue;
      return t.pos;
    }
    for (const ih of e.inhibs) if (ih.alive && ih.side !== u.side && ih.hp < 3000 && within(ih.pos, 700)) return ih.pos;
    if (e.nexus[1 - u.side] < 4000 && within(NEXUS[1 - u.side], 900)) return NEXUS[1 - u.side];
    for (const o of Object.values(e.obj)) if (o.alive && o.hp < o.maxHp && Math.hypot(o.pos.x - u.x, o.pos.y - u.y) < 660) return o.pos;
    // (against the health the camp came up with, see drawCamps: late camps spawn above maxHp)
    for (const cp of e.camps) if (cp.alive && cp.hp < (this.campUp.get(cp.id)?.full ?? cp.maxHp) && Math.hypot(cp.pos.x - u.x, cp.pos.y - u.y) < 320) return cp.pos;
    if (e.t < 60 || u.role === "Support") return null;
    for (const lane of LANES) {
      const f = e.lanes[lane].front;
      const p = lanePoint(lane, f + (u.side === 0 ? 0.01 : -0.01));
      if (Math.hypot(p.x - u.x, p.y - u.y) < 1050) return p;
    }
    return null;
  }

  /**
   * Champions outside a fight visibly do their work: a shot or a swing at the wave, the camp, the turret. The engine
   * only moves numbers for these (CS, camp and turret health), so a laner stood frozen for half of the laning phase
   * and turrets lost health with nothing to see. Drawing only: timed off the wall clock, no effect on the game.
   */
  private drawWork(now: number) {
    this.lunge = [];
    if (!this.animate) return;
    const c = this.ctx;
    const wide = this.cam.size >= 9000;
    for (const u of this.e.units) {
      if (!u.alive) continue;
      const tg = this.workTarget(u);
      if (!tg) continue;
      const period = 760 + ((u.i * 137) % 360);
      const ph = ((now + u.i * 311) % period) / period;
      if (ph > 0.26) continue;
      const k = ph / 0.26; // 0..1 through one attack
      const from = this.rawPos(u);
      const dx = tg.x - from.x, dy = tg.y - from.y, d = Math.hypot(dx, dy) || 1;
      if (u.champ.ranged) {
        // a shot travelling to the target
        const x = this.sx(from.x + dx * k), y = this.sy(from.y + dy * k);
        const x2 = this.sx(from.x + dx * Math.max(0, k - 0.3)), y2 = this.sy(from.y + dy * Math.max(0, k - 0.3));
        const col = u.side ? "#ffd0d0" : "#cfe6ff";
        c.strokeStyle = col;
        c.lineWidth = 1;
        c.globalAlpha = 0.7;
        c.beginPath();
        c.moveTo(x2, y2);
        c.lineTo(x, y);
        c.stroke();
        c.globalAlpha = 1;
        // the head of the shot, and a small flash where it lands
        const h = wide ? 2 : 3;
        c.fillStyle = "#05070d";
        c.fillRect(Math.round(x - h / 2) - 1, Math.round(y - h / 2) - 1, h + 2, h + 2);
        c.fillStyle = col;
        c.fillRect(Math.round(x - h / 2), Math.round(y - h / 2), h, h);
        if (k > 0.85) {
          c.fillStyle = "#ffffff";
          c.fillRect(Math.round(this.sx(tg.x)) - 1, Math.round(this.sy(tg.y)) - 1, 3, 3);
        }
      } else {
        // a step in and a swing
        const reach = Math.min(d * 0.45, wide ? 220 : 150) * Math.sin(k * Math.PI);
        this.lunge[u.i] = { x: (dx / d) * reach, y: (dy / d) * reach };
        if (k > 0.35 && k < 0.8) {
          const r = this.iconSize() * 0.75;
          const ax = this.sx(from.x + (dx / d) * reach), ay = this.sy(from.y + (dy / d) * reach);
          const ang = Math.atan2(-(dy / d), dx / d);
          c.strokeStyle = "#f2f4fa";
          c.lineWidth = wide ? 1 : 2;
          c.beginPath();
          c.arc(ax, ay, r, ang - 0.7 + (k - 0.35) * 2, ang + 0.2 + (k - 0.35) * 2);
          c.stroke();
        }
      }
    }
  }
  /** melee champions step toward what they are hitting (drawWork) */
  private lunge: Vec[] = [];

  /**
   * Marks over the map: where the fights are while the whole map is shown, the spot the camera is about to go in on,
   * and the one it just left.
   */
  private drawMarks(now: number) {
    const c = this.ctx;
    const box = (cam: Cam, alpha: number, grow = 0) => {
      const x = this.sx(cam.x - cam.size / 2) - grow, y = this.sy(cam.y + cam.size / 2) - grow, w = this.len(cam.size) + grow * 2;
      const corner = Math.max(6, w * 0.22);
      c.globalAlpha = alpha;
      c.strokeStyle = "#ffd36b";
      c.lineWidth = 2;
      c.beginPath();
      for (const [px, py, hx, hy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + w, 1, -1], [x + w, y + w, -1, -1]] as const) {
        c.moveTo(px + hx * corner, py);
        c.lineTo(px, py);
        c.lineTo(px, py + hy * corner);
      }
      c.stroke();
      c.globalAlpha = 1;
    };
    if (this.cam.size >= 12000) {
      // every fight, small ones too: the camera does not go to them any more, so the map has to point at them
      for (const [id, f] of this.e.fights) {
        let n = 0, sides = 0;
        for (const u of this.e.units) if (u.alive && u.fightId === id) { n++; sides |= 1 << u.side; }
        if (sides !== 3) continue;
        const r = Math.max(11, this.len(520 + n * 130)) + Math.sin(now / 140) * 1.5;
        c.strokeStyle = n >= 4 ? "#ffd36b" : "#f2f4fa";
        c.lineWidth = n >= 4 ? 2 : 1;
        c.globalAlpha = 0.85;
        c.beginPath();
        c.arc(this.sx(f.x), this.sy(f.y), r, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }
      if (this.cue) box(this.cue, 0.6 + Math.sin(now / 45) * 0.4);
      if (this.left) {
        const age = (now - this.left.at) / 600;
        if (age >= 1) this.left = null;
        else box(this.left.cam, 0.8 * (1 - age), age * 6);
      }
    }
  }

  /** Broadcast-style minimap in the corner while the camera is zoomed in, with what is going on elsewhere. */
  private drawInset(now: number) {
    const c = this.ctx;
    const S = 128, X = RES - S - 6, Y = 6;
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
      c.fillRect(Math.floor(mx(u.x)) - 2, Math.floor(my(u.y)) - 2, 5, 5);
      c.fillStyle = u.side ? RED : BLUE;
      c.fillRect(Math.floor(mx(u.x)) - 1, Math.floor(my(u.y)) - 1, 3, 3);
    }
    // fights and deaths anywhere on the map, so what happens off screen is not missed
    for (const [id, f] of this.e.fights) {
      let sides = 0;
      for (const u of this.e.units) if (u.alive && u.fightId === id) sides |= 1 << u.side;
      if (sides !== 3) continue;
      c.strokeStyle = "#ffd36b";
      c.lineWidth = 1;
      c.beginPath();
      c.arc(mx(f.x), my(f.y), 5 + Math.sin(now / 140), 0, Math.PI * 2);
      c.stroke();
    }
    for (const d of this.deaths) {
      const x = Math.round(mx(d.x)), y = Math.round(my(d.y));
      c.strokeStyle = d.side ? BLUE : RED;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x - 3, y - 3); c.lineTo(x + 3, y + 3);
      c.moveTo(x + 3, y - 3); c.lineTo(x - 3, y + 3);
      c.stroke();
    }
    // teleports on the way: where each will land
    for (const u of this.e.units) {
      const ch = u.alive ? Summoners.channel(this.e, u) : null;
      if (!ch) continue;
      c.strokeStyle = "#b48cff";
      c.lineWidth = 1;
      c.beginPath();
      c.arc(mx(ch.to.x), my(ch.to.y), 4 + Math.sin(now / 120), 0, Math.PI * 2);
      c.stroke();
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
    for (const t of this.e.turrets) {
      const x = Math.round(this.sx(t.pos.x)), y = Math.round(this.sy(t.pos.y));
      if (x < -30 || y < -30 || x > RES + 30 || y > RES + 30) continue;
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
        c.arc(this.sx(t.pos.x), this.sy(t.pos.y), this.len(775), 0, Math.PI * 2);
        c.stroke();
      }
      // the middle of the tower on the turret's spot (its foot stood there before, so the tower was drawn above the
      // spot and off the middle of its own range ring)
      const b = this.sprite(TOWER, t.pos, u, { x: crown, c: "#ffffff", b: body });
      if (t.hp < t.maxHp) this.bar(b, t.hp / t.maxHp, body);
    }
    // inhibitors and the nexus: pixel diamonds with their middle on the pixel the spot falls in
    for (const ih of this.e.inhibs) {
      const x = Math.floor(this.sx(ih.pos.x)), y = Math.floor(this.sy(ih.pos.y));
      const s = zoom ? 7 : 4;
      this.diamond(x, y, s + 1, "#05070d");
      this.diamond(x, y, s, ih.alive ? (ih.side ? "#ff9a9a" : "#9ad0ff") : "#3a3f4b");
      if (!ih.alive && zoom && ih.respawnAt > this.e.t) this.timer({ x: x - s, y: y - s, w: 2 * s + 1, h: 2 * s + 1 }, Math.ceil(ih.respawnAt - this.e.t));
    }
    NEXUS.forEach((p, side) => {
      const x = Math.floor(this.sx(p.x)), y = Math.floor(this.sy(p.y));
      const s = zoom ? 13 : 7;
      this.diamond(x, y, s + 2, "#05070d");
      this.diamond(x, y, s, side ? RED : BLUE);
      c.fillStyle = "#ffffff";
      c.fillRect(x - 1, y - 1, 3, 3);
      const hp = this.e.nexus[side] / 4000;
      if (hp < 1) this.bar({ x: x - s, y: y - s, w: 2 * s + 1, h: 2 * s + 2 }, hp, side ? RED : BLUE);
    });
  }

  /**
   * Jungle camps, readable on the whole map: a camp that is up is a bright disc with a dark outline (the small tan
   * dot it used to be was the colour of the ground), one that was cleared is the same disc dimmed, with the time
   * until it is back under it. A camp that just came up is ringed for a moment; one being cleared shows its health.
   */
  private drawCamps(now: number) {
    const c = this.ctx;
    const r = CAMP_R[this.cam.size < 9000 ? 1 : 0];
    for (const camp of this.e.camps) {
      // what is known of a camp that is up (also for camps outside the view, so nothing is left over from an earlier
      // life): when it came up, and the health it came up with. A camp spawns above its maxHp after the first
      // minutes (Engine.spawns), so the bar is drawn against the most health seen, not against maxHp.
      let up = this.campUp.get(camp.id);
      if (!camp.alive) {
        if (up) this.campUp.delete(camp.id);
      } else if (!up) {
        // (a camp already up when the renderer first sees it, at the start of a watch or after a skip, is not ringed)
        this.campUp.set(camp.id, (up = { at: this.e.t - camp.spawnAt < 2 ? now : -1e9, full: Math.max(camp.hp, camp.maxHp) }));
      } else if (camp.hp > up.full) up.full = camp.hp;
      const x = this.sx(camp.pos.x), y = this.sy(camp.pos.y);
      if (x < -20 || y < -20 || x > RES + 20 || y > RES + 20) continue;
      if (!camp.alive || !up) {
        const b = this.disc(camp.pos, r, GONE_COL, GONE_ALPHA);
        const left = Math.ceil(camp.spawnAt - this.e.t);
        if (left > 0) this.timer(b, left, "#cfd5e2");
        continue;
      }
      const b = this.disc(camp.pos, r, CAMP_COL[camp.kind]);
      if (camp.hp < up.full) this.bar(b, camp.hp / up.full, "#ffe28a");
      const k = (now - up.at) / CAMP_UP_MS;
      if (k >= 0 && k < 1) {
        // a white ring closing in on the camp
        c.globalAlpha = 1 - k;
        c.strokeStyle = "#ffffff";
        c.lineWidth = 1;
        c.beginPath();
        c.arc(b.x + b.w / 2, b.y + b.h / 2, r + 3 + (1 - k) * 6, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }
    }
  }

  /**
   * Epic monsters, each on its own spot (the Voidgrubs one by one): the same disc as a camp, larger. A monster that
   * is up has a slow ring around it and shows its health while it is hit; an empty pit shows what comes there next
   * as a dim disc with the time left, the same way as a cleared camp.
   */
  private drawObjectives(now: number) {
    const c = this.ctx, e = this.e;
    const zoom = this.cam.size < 9000 ? 1 : 0;
    const draw = (k: ObjKey, up: boolean): Box => {
      const o = e.obj[k];
      const col = up ? OBJ_COL[k] : GONE_COL;
      const alpha = up ? 1 : GONE_ALPHA;
      if (k !== "grubs") {
        const b = this.disc(o.pos, EPIC_R[zoom], col, alpha);
        if (up) {
          // a dark core, as the epic monsters always had: with their size it sets them apart from a camp
          const s = zoom ? 3 : 1;
          c.fillStyle = "#0a0d16";
          c.fillRect(b.x + (b.w - s) / 2, b.y + (b.h - s) / 2, s, s);
        }
        return b;
      }
      // as many grubs as are left, each on its own spot; the box around them carries the ring, the bar and the time
      const n = up ? Math.max(1, Math.min(GRUB_SPOTS.length, o.left ?? GRUB_SPOTS.length)) : GRUB_SPOTS.length;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const b = this.disc(GRUB_SPOTS[i], GRUB_R[zoom], col, alpha);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    for (const pit of PITS) {
      const up = pit.filter((k) => e.obj[k].alive);
      for (const k of up) {
        const o = e.obj[k];
        const b = draw(k, true);
        c.strokeStyle = OBJ_COL[k];
        c.globalAlpha = 0.55;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h) / 2 + 3 + Math.sin(now / 250), 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
        if (o.hp < o.maxHp) this.bar(b, o.hp / o.maxHp, "#ffe28a");
      }
      if (up.length) continue;
      const next = pit.filter((k) => e.obj[k].spawnAt !== null && e.obj[k].spawnAt! > e.t).sort((a, b) => e.obj[a].spawnAt! - e.obj[b].spawnAt!)[0];
      if (next) this.timer(draw(next, false), Math.ceil(e.obj[next].spawnAt! - e.t), "#cfd5e2");
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
    let { x, y } = this.rawPos(u);
    // icons moved apart (layout) and the step of a melee attack on the wave or a turret (drawWork)
    const sp = this.spread[u.i], lg = this.lunge[u.i];
    if (sp) { x += sp.x; y += sp.y; }
    if (lg) { x += lg.x; y += lg.y; }
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
      // everything below is drawn from x - size / 2, which centre() keeps on a whole pixel
      const { x, y } = this.centre(p, size);
      if (x < -30 || y < -30 || x > RES + 30 || y > RES + 30) continue;
      let alpha = 1;
      for (const f of this.live) if (f.kind === "stealth" && f.from === u.i) alpha = 0.35;
      c.globalAlpha = alpha;
      const ring = u.side ? RED : BLUE;
      // team ring (dark edge first, so two icons side by side stay two icons)
      const rw = zoomed ? 2 : 1;
      c.fillStyle = "#05070d";
      c.fillRect(x - size / 2 - rw - 1, y - size / 2 - rw - 1, size + rw * 2 + 2, size + rw * 2 + 2);
      c.fillStyle = ring;
      c.fillRect(x - size / 2 - rw, y - size / 2 - rw, size + rw * 2, size + rw * 2);
      if (this.highlightSide === u.side) {
        c.strokeStyle = "#ffd36b";
        c.lineWidth = 1;
        c.strokeRect(x - size / 2 - rw - 1.5, y - size / 2 - rw - 1.5, size + rw * 2 + 3, size + rw * 2 + 3);
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
        c.strokeRect(x - size / 2 - rw - 2.5, y - size / 2 - rw - 2.5, size + rw * 2 + 5, size + rw * 2 + 5);
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
      // carrying the Rift Herald's eye: the charge comes when this team reaches an enemy turret (engine heraldTick)
      if (this.e.heraldHeld?.taker === u.i) {
        c.fillStyle = "#05070d";
        c.fillRect(x + size / 2 - 3, y - size / 2 - 3, 7, 7);
        c.fillStyle = "#9a7bff";
        c.fillRect(x + size / 2 - 2, y - size / 2 - 2, 5, 5);
        c.fillStyle = "#ffffff";
        c.fillRect(x + size / 2, y - size / 2, 1, 1);
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

  /**
   * Screen position of a unit in CSS pixels relative to the canvas, for DOM overlays. From the canvas's own layout
   * size: getBoundingClientRect() is in the zoomed page's pixels (ui/scale.ts), so at any screen scale but 1 an
   * overlay placed with it landed off the unit.
   */
  screenOf(i: number): { x: number; y: number } {
    const u = this.e.units[i];
    return { x: (this.sx(u.x) / RES) * this.canvas.clientWidth, y: (this.sy(u.y) / RES) * this.canvas.clientHeight };
  }
}
