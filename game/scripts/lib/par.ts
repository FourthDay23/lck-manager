// Shared helper that lets a measurement script run in pieces (scripts/par.mjs) or as paired A/B runs (scripts/ab.mjs).
//
// A script wraps the expensive part of each game in par.game(g, ...) and calls par.end() after its loop:
//
//   for (let g = 0; g < N; g++) {
//     ...draft (anything that moves a shared Rng stays outside, so every piece replays it the same way)...
//     const e = par.game(g, () => { const e = new Engine(...); e.runToEnd(); return engineSnap(e); });
//     if (!e) continue; // a game another piece plays
//     ...add e's numbers to the totals, exactly as before...
//   }
//   par.end();
//   ...report...
//
// Run on its own (node scripts/run-ts.mjs ...) nothing changes: par.game just calls the function.
// Under par.mjs each worker process (PAR_SHARD=i/k) plays only games with g % k == i, writes what the function
// returned to PAR_OUT and exits at par.end(). A last process (PAR_MERGE) then runs the same script with every
// game's saved result in place of playing it, so the totals are added in the same order and the report is
// byte-for-byte the one a single process prints. The function must return plain data (JSON): numbers, strings,
// arrays, plain objects. engineSnap(e) keeps an Engine's own data fields (not its GameData, Rng or scratch state).
// Limits: what runs outside par.game must not depend on the games (a later draft may not read an earlier game's
// result), and every worker still walks the whole loop (the drafts of all N games: cheap next to the engine).
import { readFileSync, writeFileSync } from "node:fs";

type Rec = { v: unknown; ms: number };

const shardEnv = process.env.PAR_SHARD ?? "";
const mergeEnv = process.env.PAR_MERGE ?? "";
const [shardI, shardK] = shardEnv ? shardEnv.split("/").map(Number) : [0, 1];
const range = (process.env.PAR_RANGE ?? "").split("-").filter(Boolean).map(Number);
const lo = range[0] ?? 0, hi = range[1] ?? Infinity;
const out: Record<number, Rec> = {};
let merged: Record<number, Rec> | null = null;

// numbers JSON cannot hold (NaN, Infinity, -0) are kept as {"$n": "..."} so a saved result reads back identical
const enc = (_k: string, v: unknown) => (typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0)) ? { $n: Object.is(v, -0) ? "-0" : String(v) } : v instanceof Map ? { $map: [...v.entries()] } : v instanceof Set ? { $set: [...v] } : v);
const dec = (_k: string, v: unknown) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.$n === "string" && Object.keys(o).length === 1) return o.$n === "-0" ? -0 : Number(o.$n);
    if (Array.isArray(o.$map) && Object.keys(o).length === 1) return new Map(o.$map as [unknown, unknown][]);
    if (Array.isArray(o.$set) && Object.keys(o).length === 1) return new Set(o.$set as unknown[]);
  }
  return v;
};

function loadMerge(): Record<number, Rec> {
  const all: Record<number, Rec> = {};
  for (const f of mergeEnv.split(";").filter(Boolean)) Object.assign(all, JSON.parse(readFileSync(f, "utf8"), dec).records);
  return all;
}

/** Read access to a saved result that names the missing field, instead of a silent undefined. */
function guard<T>(v: T, g: number): T {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return new Proxy(v as object, {
    get(o, k, r) {
      if (typeof k === "string" && !(k in o) && k !== "then" && k !== "toJSON") throw new Error(`par: game ${g} result has no field "${k}" (add it to what par.game returns / engineSnap keeps)`);
      return Reflect.get(o, k, r);
    },
  }) as T;
}

export const par = {
  /** "solo" (plain run), "shard" (a par.mjs worker) or "merge" (the par.mjs report run) */
  mode: (mergeEnv ? "merge" : shardEnv ? "shard" : "solo") as "solo" | "shard" | "merge",
  /** Play game g (run) here, or skip it (undefined: another piece plays it), or read it back from the pieces. */
  game<T>(g: number, run: () => T): T | undefined {
    if (par.mode === "merge") {
      merged ??= loadMerge();
      const r = merged[g];
      if (!r) throw new Error(`par: no saved result for game ${g}`);
      return guard(r.v as T, g);
    }
    if (par.mode === "shard" && (g % shardK !== shardI || g < lo || g >= hi)) return undefined;
    const t0 = performance.now();
    const v = run();
    if (par.mode === "shard") out[g] = { v: JSON.parse(JSON.stringify(v, enc)), ms: performance.now() - t0 };
    return v;
  },
  /** After the game loop: a worker saves its games and stops here (its totals are partial, so no report). */
  end() {
    if (par.mode !== "shard") return;
    writeFileSync(process.env.PAR_OUT!, JSON.stringify({ shard: shardEnv, records: out }, enc));
    process.exit(0);
  },
};

/** Engine fields that are not results of the game: shared data, the random stream, per-module scratch state, draw-only fx. */
const SKIP = new Set(["data", "meta", "rng", "mods", "fx", "fights"]);

/** An Engine's own data fields as plain data (what scripts read after runToEnd: t, winner, kills, events, units...). */
export function engineSnap<E extends object>(e: E): E {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (SKIP.has(k) || typeof v === "function") continue;
    o[k] = v;
  }
  return o as E;
}
