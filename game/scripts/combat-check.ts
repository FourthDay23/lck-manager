// Real-number combat check: N auto-drafted engine games; per champion, damage to champions per minute and where it
// came from (basic attacks / spells / effects: items, runes, summoner spells, passives / damage over time), next to
// the 2026 LCK games (scripts/real-dmg.json from build_combat_ref.py: damage to champions per minute) and the pro
// basic-attack share (kits.gen.ts dmgShare). Also single hits against the victim's max health.
// Run (Git Bash): GAMES=12 MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/combat-check.ts
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { kitFor } from "../src/match/kits";
import * as Procs from "../src/match/procs";
import type { Kind } from "../src/match/procs";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"));
const real = JSON.parse(readFileSync("scripts/real-dmg.json", "utf8")) as { champions: Record<string, { games: number; perMin: number }> };
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "t", seed: 7 });
const pool = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => ovr(b) - ovr(a));
for (const r of ROLES) {
  const byRole = pool.filter((p) => p.role === r);
  for (const tid of s.lck) {
    if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
    const p = byRole.shift();
    if (p) joinTeam(s, p, tid, 10000, 2);
  }
}
for (const tid of s.lck) autoLineup(s, s.teams[tid]);

const GAMES = Number(process.env.GAMES ?? 12);
const KINDS: Kind[] = ["aa", "spell", "proc", "dot", "raw"];
const byChamp = new Map<string, { k: Record<Kind, number>; min: number; n: number }>();
const byRole = new Map<string, { k: Record<Kind, number>; min: number }>();
let minutes = 0, kills = 0, bigHits = 0, oneShots = 0, spellHits = 0;
const hitFrac: number[] = [];
let cur: Engine | null = null;
const allDmg = new Map<string, number>();
Procs.setDealtTap((src, v, amount, kind) => {
  if (!src || !cur || src.side === v.side) return;
  const r = byChamp.get(src.champ.id) ?? { k: { aa: 0, spell: 0, proc: 0, dot: 0, raw: 0 }, min: 0, n: 0 };
  r.k[kind] += amount;
  byChamp.set(src.champ.id, r);
  const rr = byRole.get(src.role) ?? { k: { aa: 0, spell: 0, proc: 0, dot: 0, raw: 0 }, min: 0 };
  rr.k[kind] += amount;
  byRole.set(src.role, rr);
  if (kind === "spell") {
    spellHits++;
    const f = amount / Math.max(1, v.maxHp);
    hitFrac.push(f);
    if (f >= 0.5) bigHits++;
    if (f >= 1) oneShots++;
  }
});

const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const seed = 5100 + g * 61;
  const a = s.lck[g % 10], b = s.lck[(g + 3) % 10];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, new Rng(seed));
  const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed });
  cur = e;
  // all champion damage, including what does not pass fight.ts hurt() (engine.laneDuels pokes)
  const dmg0 = e.damage.bind(e);
  e.damage = (src, v, amount) => {
    if (src && v.alive && src.side !== v.side) allDmg.set(src.champ.id, (allDmg.get(src.champ.id) ?? 0) + Math.min(amount, v.hp + v.shield));
    return dmg0(src, v, amount);
  };
  while (!e.over && e.t < 60 * 60) e.step();
  const m = e.t / 60;
  minutes += m;
  kills += e.kills[0] + e.kills[1];
  for (const u of e.units) {
    const r = byChamp.get(u.champ.id) ?? { k: { aa: 0, spell: 0, proc: 0, dot: 0, raw: 0 }, min: 0, n: 0 };
    r.min += m;
    r.n++;
    byChamp.set(u.champ.id, r);
    const rr = byRole.get(u.role) ?? { k: { aa: 0, spell: 0, proc: 0, dot: 0, raw: 0 }, min: 0 };
    rr.min += m;
    byRole.set(u.role, rr);
  }
}
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
const tot = (k: Record<Kind, number>) => KINDS.reduce((a, x) => a + k[x], 0) || 1;
hitFrac.sort((a, b) => a - b);
const q = (p: number) => hitFrac[Math.floor(p * (hitFrac.length - 1))] ?? 0;
console.log(`games ${GAMES} (${((Date.now() - t0) / 1000 / GAMES).toFixed(1)} s each), ${(minutes / GAMES).toFixed(1)} min, ${(kills / GAMES).toFixed(1)} kills/game`);
console.log(`spell hits on champions ${spellHits}: size vs victim max hp median ${pct(q(0.5))} p90 ${pct(q(0.9))} p99 ${pct(q(0.99))}; >= 50 %: ${(100 * bigHits / Math.max(1, spellHits)).toFixed(1)}%, >= 100 %: ${oneShots}`);
console.log("\nby role: damage to champions per minute, and its split  aa / spell / effects (proc + dot)");
for (const r of ROLES) {
  const x = byRole.get(r);
  if (!x) continue;
  const t = tot(x.k);
  console.log(`  ${r.padEnd(8)} ${Math.round(t / x.min).toString().padStart(4)}/min   ${pct(x.k.aa / t)} ${pct(x.k.spell / t)} ${pct((x.k.proc + x.k.dot) / t)}`);
}
console.log("\nchampion      games  sim/min  real/min  ratio   sim aa / spell / effects / lane   pro aa (+on-hit effects count as aa there)");
let ratioSum = 0, ratioN = 0, aaGap = 0, aaN = 0;
const rows = [...byChamp.entries()].filter(([, r]) => r.n >= 2).sort((a, b) => b[1].n - a[1].n);
for (const [id, r] of rows) {
  const tFight = tot(r.k);
  const t = Math.max(tFight, allDmg.get(id) ?? 0);
  const lane = Math.max(0, t - tFight);
  const simMin = t / Math.max(1, r.min);
  const rl = real.champions[id];
  const ratio = rl ? simMin / rl.perMin : NaN;
  if (rl && rl.games >= 5) { ratioSum += Math.log(ratio); ratioN++; }
  const pro = kitFor(data.champ.get(id)!).dmgShare;
  if (pro) { aaGap += Math.abs(r.k.aa / tFight - pro[0]); aaN++; }
  console.log(`${id.padEnd(13)} ${String(r.n).padStart(4)}  ${Math.round(simMin).toString().padStart(6)}  ${rl ? Math.round(rl.perMin).toString().padStart(7) : "      -"}  ${rl ? ratio.toFixed(2).padStart(5) : "    -"}   ${pct(r.k.aa / t)} ${pct(r.k.spell / t)} ${pct((r.k.proc + r.k.dot) / t)} ${pct(lane / t)}          ${pro ? pct(pro[0]) : "  -"}`);
}
console.log(`\ngeometric mean sim/real damage per minute over ${ratioN} champions with >= 5 real games: ${Math.exp(ratioSum / Math.max(1, ratioN)).toFixed(2)}`);
console.log(`mean |basic attack share - pro| over ${aaN} champions: ${(100 * aaGap / Math.max(1, aaN)).toFixed(1)} pt`);
