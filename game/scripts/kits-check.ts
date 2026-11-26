// Sanity check for the generated champion kits: every champion in champions.json gets a kit through kitFor(),
// shapes follow champions.json, fields are in range. Prints a spot-check table.
// Run: node scripts/run-ts.mjs scripts/kits-check.ts [Id,Id,...]
import { readFileSync } from "node:fs";
import type { ChampionData } from "../src/data/types";
import { kitFor, hasGeneratedKit } from "../src/match/kits";
import { KITS_META } from "../src/match/kits.gen";
import type { SpellKit } from "../src/match/kit-types";

const champs: ChampionData[] = JSON.parse(readFileSync("public/data/champions.json", "utf8")).champions;
const CC = new Set(["stun", "root", "knockup", "knockback", "pull", "slow", "charm", "taunt", "fear", "sleep", "suppress", "silence", "polymorph", "blind", "ground", "arena"]);
const SAVE = new Set(["relocate", "invuln", "revive"]);
const ALLY = new Set(["as", "ms", "ad", "dr", "stasis"]);
const problems: string[] = [];
let generated = 0;
for (const c of champs) {
  const kit = kitFor(c);
  if (hasGeneratedKit(c.id)) generated++;
  if (kit.spells.length !== c.spells.length) problems.push(`${c.id}: ${kit.spells.length} spells`);
  kit.spells.forEach((s, i) => {
    const sp = c.spells[i];
    const tag = `${c.id} ${s.key}`;
    if (s.key !== sp.key || s.slot !== i) problems.push(`${tag}: key/slot mismatch`);
    if (s.shape !== sp.vfx) problems.push(`${tag}: shape ${s.shape} != vfx ${sp.vfx}`);
    if (!s.uses.length) problems.push(`${tag}: no uses`);
    if (!(s.cd > 0)) problems.push(`${tag}: cd ${s.cd}`);
    if (!(s.range > 0)) problems.push(`${tag}: range ${s.range}`);
    if (s.dmg < 0 || s.dmg > 8) problems.push(`${tag}: dmg ${s.dmg}`);
    if (s.cc && (!CC.has(s.cc.type) || !(s.cc.dur > 0) || s.cc.dur > 4)) problems.push(`${tag}: cc ${JSON.stringify(s.cc)}`);
    if (s.dash && !(s.dash.len > 0)) problems.push(`${tag}: dash ${JSON.stringify(s.dash)}`);
    if (s.minTargets !== undefined && (s.minTargets < 2 || s.minTargets > 5)) problems.push(`${tag}: minTargets ${s.minTargets}`);
    if ((s.uses.includes("shield") || s.uses.includes("heal")) && !s.support) problems.push(`${tag}: shield/heal use without support`);
    if (s.save && (!SAVE.has(s.save.kind) || !(s.save.dur > 0) || (s.save.radius ?? 0) < 0)) problems.push(`${tag}: save ${JSON.stringify(s.save)}`);
    if (s.allyBuff && (!ALLY.has(s.allyBuff.kind) || !(s.allyBuff.dur > 0) || !(s.allyBuff.radius >= 0))) problems.push(`${tag}: allyBuff ${JSON.stringify(s.allyBuff)}`);
    if (s.requires && (s.requires !== "airborne" && s.requires !== "mark")) problems.push(`${tag}: requires ${s.requires}`);
    if (s.requires && !s.cc) problems.push(`${tag}: requires without cc`);
  });
  if (kit.dmgShare && Math.abs(kit.dmgShare.reduce((a, b) => a + b, 0) - 1) > 0.01) problems.push(`${c.id}: dmgShare sums to ${kit.dmgShare.reduce((a, b) => a + b, 0)}`);
}
console.log(`kits: ${generated}/${champs.length} generated (patch ${KITS_META.version}, ${KITS_META.proGames} pro games, dmgShare >= ${KITS_META.minGames} games)`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n  ${problems.join("\n  ")}` : "no problems");

const fmt = (s: SpellKit) =>
  [
    `${s.key} ${s.shape.padEnd(7)} ${s.uses.join(",").padEnd(26)} ${s.target.padEnd(9)} d=${s.dmg}`,
    s.cc ? `cc=${s.cc.type}:${s.cc.dur}` : "",
    s.dash ? `dash=${s.dash.len}->${s.dash.to}${s.dash.overWalls ? "(walls)" : ""}` : "",
    s.support ? `sup=${s.support}` : "",
    s.minTargets ? `min=${s.minTargets}` : "",
    s.selfBuff ? `buff=${s.selfBuff.kind}:${s.selfBuff.dur}` : "",
    s.save ? `save=${s.save.kind}:${s.save.dur}${s.save.radius ? `/r${s.save.radius}` : ""}` : "",
    s.allyBuff ? `ally=${s.allyBuff.kind}:${s.allyBuff.dur}/r${s.allyBuff.radius}` : "",
    s.requires ? `req=${s.requires}` : "",
  ].filter(Boolean).join(" ");
const spot = (process.argv[3] ?? "Orianna,Rell,Azir,Kalista,JarvanIV,Leona,Ahri,Gnar,Rumble,Varus").split(",");
for (const id of spot) {
  const c = champs.find((x) => x.id === id);
  if (!c) continue;
  const k = kitFor(c);
  console.log(`\n${c.name} (${id}) [${k.role}]${k.dmgShare ? ` games=${k.games} share AA/Q/W/E/R=${k.dmgShare.join("/")}` : ""}`);
  for (const s of k.spells) console.log("  " + fmt(s));
}
if (problems.length) process.exitCode = 1;
