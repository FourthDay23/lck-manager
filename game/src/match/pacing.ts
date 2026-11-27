// Playback pacing for the match view: how fast the clock runs, and which fight (if any) the broadcast camera frames.
// The two belong together. Fast-forward is shown on the whole map, where nothing has to be followed; the camera only
// goes in when the clock drops to real time for a teamfight, and comes back out when the fight is over. Before this
// the camera cut every 1.6 s (median) and the clock jumped between 16x and 1x seven times a minute
// (scripts/view-diag.ts). Used by ui/screens/Series.tsx (MatchView) and scripts/view-diag.ts.
import type { Engine, SideN } from "./engine";
import * as Fight from "./fight";

/** Speed buttons, in game seconds per real second: 8x is eight times as fast as the real game. */
export const SPEEDS = [4, 8, 16, 32, 64];
export const DEFAULT_SPEED = 8;

export const PACE = {
  /** a fight this many champions took part in is a teamfight: real time and a close-up */
  teamfight: 6,
  /** a smaller fight only caps fast playback at `skirmishSpeed`; the camera stays on the whole map */
  skirmish: 4,
  skirmishSpeed: 4,
  /** two teams facing each other before anyone has gone in, or a lull inside a teamfight */
  setupSpeed: 2,
  /** game seconds without damage after which a teamfight counts as a lull (runners being chased, a stand-off) */
  lull: 3,
  /** game seconds in real time after the fight ended, so the last kills and spells land */
  tail: 1.5,
  /** the camera stays longer (at setupSpeed) while both teams are still standing there, up to this many game seconds */
  tailMax: 6,
  /** real ms to get back up to speed, and to slow down */
  rampUp: 900,
  rampDown: 130,
  /** slowing down starts from this speed at most, so an engage is never fast-forwarded through */
  brakeFrom: 6,
};

export type Tier = "quiet" | "skirmish" | "setup" | "teamfight" | "tail";
/** What a teamfight came to, handed over when the camera leaves it. */
export interface FightResult { seq: number; kills: [number, number]; taken: { side: SideN; text: string }[]; x: number; y: number }

const OBJ_EVENTS = new Set(["dragon", "soul", "elder", "grubs", "herald", "baron"]);

interface Cand { id: number; n: number; tier: Tier; x: number; y: number }

function ease(from: number, to: number, x: number): number {
  const k = 1 - Math.exp(-3 * x);
  const v = Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * k);
  return Math.abs(v - to) < to * 0.03 ? to : v;
}

export class Pacer {
  /** game seconds per real second right now (eased between the tiers) */
  gps: number;
  /** the speed the clock is heading for; 1 = real time */
  target: number;
  tier: Tier = "quiet";
  /** the fight the camera should frame; 0 = none (whole map) */
  focus = 0;
  /** where that fight is, kept through the tail after it ended */
  spot: { x: number; y: number } | null = null;
  /** how many champions took part in the focused fight */
  size = 0;
  /** set when the camera leaves a teamfight (seq goes up by one each time) */
  result: FightResult | null = null;
  /** everyone who has been in the focused fight (its result counts their deaths only) */
  private members = new Set<number>();
  private tailFrom = -1;
  private startEv = 0;
  private seq = 0;
  /** game time at the last update: tells a game that ended in front of the camera from a jump to the end */
  private seenT = 0;
  /**
   * The champions that have been in each live fight. The engine's own count (f.size) goes up on every join, so a pair
   * that pulled out and came back made a 2v2 look like a fight of six.
   */
  private took = new Map<number, Set<number>>();

  constructor(private e: Engine, speed = DEFAULT_SPEED) {
    this.gps = this.target = speed;
  }

  /** Fights with both teams still in them that are big enough to set the pace. */
  private scan(): Cand[] {
    const e = this.e;
    const out: Cand[] = [];
    for (const [id, f] of e.fights) {
      let set = this.took.get(id);
      if (!set) this.took.set(id, (set = new Set()));
      let sides = 0;
      for (const u of e.units) if (u.alive && u.fightId === id) { set.add(u.i); sides |= 1 << u.side; }
      if (sides !== 3) continue;
      // everyone who took part counts, so a 3v3 does not stop being a teamfight when two have died
      const n = set.size;
      if (n < PACE.skirmish) continue;
      let tier: Tier = "skirmish";
      if (n >= PACE.teamfight) {
        const positioning = Fight.phaseOf(e, id, 0) === "position" && Fight.phaseOf(e, id, 1) === "position";
        tier = positioning || e.t - Math.max(f.last, f.start) > PACE.lull ? "setup" : "teamfight";
      }
      out.push({ id, n, tier, x: f.x, y: f.y });
    }
    for (const id of this.took.keys()) if (!e.fights.has(id)) this.took.delete(id);
    return out;
  }

  private speedOf(tier: Tier, speed: number): number {
    return tier === "teamfight" ? 1 : tier === "setup" ? Math.min(speed, PACE.setupSpeed) : tier === "skirmish" ? Math.min(speed, PACE.skirmishSpeed) : speed;
  }

  /** Stay on (or move to) this fight. */
  private take(c: Cand) {
    this.focus = c.id;
    this.size = c.n;
    this.spot = { x: c.x, y: c.y };
    this.tailFrom = -1;
    for (const i of this.took.get(c.id) ?? []) this.members.add(i);
  }

  /** A new fight comes into focus: its result is counted from here. */
  private begin(c: Cand) {
    this.startEv = this.e.events.length;
    this.members.clear();
    this.take(c);
  }

  /** The camera leaves the focused fight. `report`: hand its result over (not when the fight is still going on). */
  private leave(report: boolean) {
    const e = this.e;
    if (report) {
      // only what happened in this fight: deaths of the champions who were in it, objectives taken around it.
      // (The team kill counters and all events since the start would also count a solo kill in another lane and a
      // baron taken across the map.)
      const kills: [number, number] = [0, 0];
      const taken: FightResult["taken"] = [];
      const here = (ev: { x?: number; y?: number }) => !this.spot || ev.x === undefined || ev.y === undefined || Math.hypot(ev.x - this.spot.x, ev.y - this.spot.y) < 3500;
      for (const ev of e.events.slice(this.startEv)) {
        if (!here(ev)) continue;
        // every kill makes exactly one of these three events (multi-kill, shutdown and ace lines come on top)
        if ((ev.type === "kill" || ev.type === "first_blood" || ev.type === "solo") && ev.victim !== undefined && this.members.has(ev.victim)) kills[ev.side]++;
        // "T1, 화염 드래곤 처치 (2스택)" -> "화염 드래곤 처치"
        else if (OBJ_EVENTS.has(ev.type)) taken.push({ side: ev.side, text: ev.text.replace(/^[^,]+,\s*/, "").replace(/\s*\(.*\)$/, "").replace(/!$/, "") });
      }
      this.result = { seq: ++this.seq, kills, taken, x: this.spot?.x ?? 0, y: this.spot?.y ?? 0 };
    }
    this.focus = 0;
    this.size = 0;
    this.tailFrom = -1;
    this.members.clear();
  }

  /**
   * Once per frame, before the engine steps (and once more when the game has just ended): works out the pace and the
   * camera focus, and returns how many game seconds this real second should cover. `slowmo` off = always the chosen
   * speed, never a close-up.
   */
  update(dtMs: number, speed: number, slowmo: boolean): number {
    const e = this.e;
    if (!slowmo || e.over) {
      // the fight that ended the game still gets its result; a jump to the end ("끝까지") does not, and neither does
      // switching the option off in the middle of a fight
      if (this.focus) this.leave(slowmo && e.over && e.t - this.seenT < 3);
      this.seenT = e.t;
      this.tier = "quiet";
      this.target = speed;
      this.gps = ease(this.gps, speed, dtMs / PACE.rampUp);
      return this.gps;
    }
    this.seenT = e.t;
    const cands = this.scan();
    const big = cands.filter((c) => c.n >= PACE.teamfight).sort((a, b) => b.n - a.n);
    let tier: Tier = cands.length ? "skirmish" : "quiet";
    let extra = false;
    if (this.focus) {
      let cur = cands.find((c) => c.id === this.focus && c.n >= PACE.teamfight) ?? null;
      if (!cur) {
        // the fight took a new id (two fights merged) or flared up again right there: stay with it
        cur = big.find((c) => {
          let shared = 0;
          for (const u of e.units) if (u.fightId === c.id && this.members.has(u.i)) shared++;
          return shared * 2 >= Math.min(this.members.size, 4) || (this.spot !== null && Math.hypot(c.x - this.spot.x, c.y - this.spot.y) < 2200);
        }) ?? null;
      }
      if (cur && big[0] && big[0].id !== cur.id && big[0].n >= cur.n + 3) {
        // a clearly bigger fight somewhere else takes over (the one left behind is still going: no result for it)
        this.begin(big[0]);
        tier = big[0].tier;
      } else if (cur) {
        this.take(cur);
        tier = cur.tier;
      } else if (big[0]) {
        // the fight is over and another teamfight has opened elsewhere: go there now, not after the tail
        this.leave(true);
        this.begin(big[0]);
        tier = big[0].tier;
      } else {
        if (this.tailFrom < 0) this.tailFrom = e.t;
        const gone = e.t - this.tailFrom;
        tier = "tail";
        if (gone >= PACE.tail) {
          // both teams still standing there: the next round is likely, so the camera waits a little
          const near = [0, 0];
          if (this.spot) for (const u of e.units) if (u.alive && u.recallEnd === undefined && Math.hypot(u.x - this.spot.x, u.y - this.spot.y) < 1500) near[u.side]++;
          if (near[0] >= 2 && near[1] >= 2 && gone < PACE.tailMax) extra = true;
          else {
            this.leave(true);
            tier = cands.length ? "skirmish" : "quiet";
          }
        }
      }
    } else if (big[0]) {
      this.begin(big[0]);
      tier = big[0].tier;
    }
    this.tier = tier;
    this.target = tier === "tail" ? (extra ? Math.min(speed, PACE.setupSpeed) : 1) : this.speedOf(tier, speed);
    if (this.target < this.gps) {
      if (this.gps > PACE.brakeFrom) this.gps = Math.max(this.target, PACE.brakeFrom);
      this.gps = ease(this.gps, this.target, dtMs / PACE.rampDown);
    } else this.gps = ease(this.gps, this.target, dtMs / PACE.rampUp);
    return this.gps;
  }

  /**
   * After an engine step in a fast frame: true when a fight worth slowing down for has just begun. The caller stops
   * stepping for this frame, so the engage and the first kills are not skipped over at 32x or 64x.
   */
  brake(speed: number, slowmo: boolean): boolean {
    if (!slowmo || this.gps <= PACE.brakeFrom) return false;
    let want = speed;
    for (const c of this.scan()) want = Math.min(want, this.speedOf(c.tier, speed));
    if (want >= this.gps) return false;
    this.gps = Math.max(want, PACE.brakeFrom);
    return true;
  }
}
