// Where the drawn minion wave sits when the engine stops it in front of a standing turret.
// For each lane turret: the stop parameter (turret u -/+ 0.02), drawn with the old segment-index sampling and with
// the arc-length lanePoint the renderer now uses, and whether that point is on the attacker's side of the turret.
//   node scripts/run-ts.mjs scripts/wave-check.ts
import { LANE_PATH, lanePoint, laneU, TURRETS } from "../src/match/map";
import type { Vec } from "../src/match/map";

function oldPt(lane: "top" | "mid" | "bot", u: number): Vec {
  const pts = LANE_PATH[lane];
  const n = pts.length - 1;
  const t = Math.max(0, Math.min(0.9999, u)) * n;
  const i = Math.floor(t);
  const a = pts[i], b = pts[i + 1];
  return { x: a.x + (b.x - a.x) * (t - i), y: a.y + (b.y - a.y) * (t - i) };
}

let badOld = 0, badNew = 0, n = 0;
for (const td of TURRETS) {
  if (td.lane === "nexus") continue;
  const lane = td.lane as "top" | "mid" | "bot";
  const tu = laneU(lane, td.pos);
  // the attacking wave stops 0.02 before the turret, on the attacker's side
  const stop = td.side === 1 ? tu - 0.02 : tu + 0.02;
  for (const [name, f] of [["old", oldPt], ["new", lanePoint]] as const) {
    const p = f(lane, stop);
    const pu = laneU(lane, p);
    const past = td.side === 1 ? pu > tu : pu < tu;
    const d = Math.round(Math.hypot(p.x - td.pos.x, p.y - td.pos.y));
    if (name === "old" && past) badOld++;
    if (name === "new" && past) badNew++;
    if (name === "old") n++;
    console.log(`${td.side ? "red " : "blue"} ${lane} T${td.tier} ${name}: wave ${d}u from turret${past ? "  PAST THE TURRET" : ""}`);
  }
}
console.log(`waves drawn past a standing turret: old ${badOld}/${n}, new ${badNew}/${n}`);
