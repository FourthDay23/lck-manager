// Item power of every champion in its main role against the engine's old formula (gold - 500) / 3000, after a full
// shop at a given engine gold. A short purchase path used to drop to 0.5 per gold once it ran out.
//   node scripts/run-ts.mjs scripts/items-power-check.ts [gold]
import { readFileSync } from "node:fs";
import { buildPath, champItems, ITEM_TUNE, ROLE_GOLD_SCALE } from "../src/match/items";
import type { ItemData } from "../src/match/items";
import type { Role } from "../src/data/types";

const items: ItemData = JSON.parse(readFileSync("public/data/items.json", "utf8"));
const champs: { id: string; roles: Record<Role, number> }[] = JSON.parse(readFileSync("public/data/champions.json", "utf8")).champions;
const GOLDS = [Number(process.argv[3] ?? 12000), 15000, 18000];
const rows: [string, number[]][] = [];
for (const c of champs) {
  const role = (Object.entries(c.roles).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Mid") as Role;
  const ci = champItems(items, c.id, role);
  if (!ci) continue;
  const path = buildPath(items, ci, 0, items.roleDefaults[role]);
  const cum = [0];
  for (const id of path) cum.push(cum[cum.length - 1] + (items.items[String(id)]?.cost ?? 3000));
  const ratios = GOLDS.map((g) => {
    const scale = ROLE_GOLD_SCALE[role];
    const budget = (g - 500) * scale;
    let owned = 0;
    while (owned < path.length && cum[owned + 1] <= budget) owned++;
    const done = cum[owned], full = owned >= path.length;
    const power = (done * ITEM_TUNE.finished + (budget - done) * (full ? ITEM_TUNE.beyond : ITEM_TUNE.parts)) / 3000 / scale;
    return power / ((g - 500) / 3000);
  });
  rows.push([`${c.id}/${role}(${path.length})`, ratios]);
}
rows.sort((a, b) => a[1][0] - b[1][0]);
const fmt = (r: [string, number[]]) => `${r[0]} ${r[1].map((x) => x.toFixed(2)).join(" / ")}`;
console.log(`item power / old formula at engine gold ${GOLDS.join(" / ")} (path length in brackets)`);
console.log("lowest:", rows.slice(0, 8).map(fmt).join(" | "));
console.log("highest:", rows.slice(-4).map(fmt).join(" | "));
const mean = (k: number) => rows.reduce((a, r) => a + r[1][k], 0) / rows.length;
console.log(`mean ${GOLDS.map((_, k) => mean(k).toFixed(2)).join(" / ")}, champions ${rows.length}`);
