// Same seeds, same games? Plays the calibrate.ts games (same rosters, drafts, engine seeds) and prints, per game, a
// hash of the whole engine state every simulated minute and at the end (units, events, objectives, every own field
// but the shared data, the random stream's state included), plus the CPU time of the game. Run it before and after
// an engine speed-up: the hash lines must match exactly, the times show the gain.
// Run: node scripts/run-ts.mjs scripts/engine-same.ts [games=6] [rosterSeed=3] [> before.txt]
//      HEADLESS=0 keeps the draw-only effects (Engine.fx) as a browser game has them
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import { par } from "./lib/par";
import { DRAW } from "../src/match/engine";
// no screen: skip the draw-only effects list (results stay the same; HEADLESS=0 keeps it)
if (process.env.HEADLESS !== "0" && DRAW) DRAW.fx = false; // (DRAW is missing in code from before it, scripts/ab.mjs --base)

const dir = "data";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
const N = Number(process.argv[3] ?? 6);
const rosterSeed = Number(process.argv[4] ?? 3);
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
s.user = "__nobody__";
const rr = new Rng(rosterSeed);
const pool = rr.shuffle(Object.values(s.players).filter((p) => !p.team && p.origin === "real"));
for (const r of ROLES) {
  const byRole = pool.filter((p) => p.role === r);
  for (const tid of s.lck) {
    if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
    const p = byRole.shift();
    if (p) joinTeam(s, p, tid, 10000, 2);
  }
}
for (const tid of s.lck) autoLineup(s, s.teams[tid]);
const rng = new Rng(11);

// every own field but shared data and draw-only effects; Map / Set as entries; numbers exactly (17 digits)
const SKIP = new Set(["data", "meta", "fx", "fxSeq"]);
function hashOf(e: Engine): string {
  const h = createHash("sha1");
  const seen = new WeakSet<object>();
  const rep = (k: string, v: unknown) => {
    if (typeof v === "number") return Object.is(v, -0) ? "-0" : Number.isFinite(v) ? v : String(v);
    if (v instanceof Map) return { $map: [...v.entries()] };
    if (v instanceof Set) return { $set: [...v] };
    if (v && typeof v === "object") {
      if (seen.has(v)) return "$ref";
      seen.add(v);
    }
    return v;
  };
  for (const [k, v] of Object.entries(e)) {
    if (SKIP.has(k) || typeof v === "function") continue;
    h.update(k + "=" + JSON.stringify(v, rep) + ";");
  }
  return h.digest("hex").slice(0, 16);
}

let cpu = 0;
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const r = par.game(g, () => {
    const c0 = process.cpuUsage();
    const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
    const mins: string[] = [];
    let hashMs = 0;
    while (!e.over && e.t < 60 * 60) {
      e.step();
      if (e.t % 60 === 0) {
        const h0 = process.cpuUsage();
        mins.push(hashOf(e));
        { const h = process.cpuUsage(h0); hashMs += (h.user + h.system) / 1000; } // CPU time, like the game
      }
    }
    e.runToEnd();
    const end = hashOf(e);
    const c = process.cpuUsage(c0);
    return { mins: createHash("sha1").update(mins.join(",")).digest("hex").slice(0, 16), end, t: e.t, winner: e.winner, kills: e.kills.join("-"), cpu: (c.user + c.system) / 1e6 - hashMs / 1000 };
  });
  if (!r) continue;
  cpu += r.cpu;
  console.log(`game ${g}: end ${r.end} minutes ${r.mins}  ${(r.t / 60).toFixed(1)} min winner ${r.winner} kills ${r.kills}`);
  process.stderr.write(`game ${g}: ${r.cpu.toFixed(2)} s cpu\n`);
}
par.end();
process.stderr.write(`${N} games, ${(cpu / N).toFixed(2)} s cpu per game\n`);
