// Camp and pit spots against the nav mask: is each one walkable, how far is the nearest wall, how far would it be
// snapped. Then the walking distance of a full clear from the fountain for both sides and both orders (the two
// sides should come out about equal: the jungle is a half turn of itself).
// Run (Git Bash): MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/camp-check.ts
import * as Nav from "../src/match/nav";
import { BARON_PIT, CAMPS, DRAGON_PIT, FOUNTAIN, GRUBS_PIT, GRUB_SPOTS, HERALD_PIT, SCUTTLE } from "../src/match/map";
import type { Vec } from "../src/match/map";

const clearance = (p: Vec) => {
  for (let r = 30; r <= 900; r += 30) for (let a = 0; a < 24; a++) {
    const q = { x: p.x + Math.cos((a / 24) * Math.PI * 2) * r, y: p.y + Math.sin((a / 24) * Math.PI * 2) * r };
    if (!Nav.walkable(q)) return r;
  }
  return 900;
};
const pts: [string, Vec][] = [];
CAMPS.forEach((list, side) => list.forEach((c) => pts.push([`${side ? "red " : "blue"} ${c.kind}`, c.pos])));
SCUTTLE.forEach((p, i) => pts.push([`scuttle ${i}`, p]));
pts.push(["dragon", DRAGON_PIT], ["baron", BARON_PIT], ["herald", HERALD_PIT], ["grubs", GRUBS_PIT]);
GRUB_SPOTS.forEach((p, i) => pts.push([`grub ${i}`, p]));
let bad = 0;
for (const [name, p] of pts) {
  const w = Nav.walkable(p);
  if (!w) bad++;
  const q = Nav.nearestWalkable(p);
  console.log(`${name.padEnd(14)} (${p.x}, ${p.y})  walkable ${w ? "yes" : "NO "}  wall at ${String(clearance(p)).padStart(3)}u  snap ${Math.hypot(q.x - p.x, q.y - p.y).toFixed(0)}u`);
}
// full-clear walking distance from the fountain, both orders
for (const side of [0, 1] as const) {
  for (const order of [["blue", "gromp", "wolves", "raptors", "red", "krugs"], ["red", "krugs", "raptors", "wolves", "blue", "gromp"]]) {
    let at: Vec = FOUNTAIN[side], len = 0, first = 0;
    for (const k of order) {
      const c = CAMPS[side].find((x) => x.kind === k)!;
      const d = Nav.pathLength(at, c.pos);
      if (!first) first = d;
      len += d;
      at = c.pos;
    }
    console.log(`side ${side} ${order[0]}-start: fountain->first ${first.toFixed(0)}u, full clear ${len.toFixed(0)}u, between camps ${(len - first).toFixed(0)}u`);
  }
}
if (bad) {
  console.log(`FAIL: ${bad} spot(s) not on open ground`);
  process.exitCode = 1;
} else console.log("camp-check OK");
