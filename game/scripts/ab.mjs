// Paired before/after comparison of a measurement script, with fewer games for the same certainty.
//
// A and B play the very same games (same rosters, drafts as far as the code allows, engine seeds), so each
// game's B - A difference leaves out most of the luck that two separate 200-game runs carry (common random
// numbers). The report gives each number's mean on both sides, the paired difference with its 95% interval,
// and how many games two separate runs would need for an interval that narrow.
//
//   # this folder (B) against the code at a git ref (A), e.g. your branch against main:
//   node scripts/ab.mjs calibrate.ts 200 3 --base main
//   # the same code with different knobs:
//   node scripts/ab.mjs calibrate.ts 200 3 --a "SIM_TUNE=siegePush:2.0" --b "SIM_TUNE=siegePush:2.4"
//   # stop as soon as the kills and length differences are known to +-0.5 kills / +-0.3 min:
//   node scripts/ab.mjs calibrate.ts 200 3 --base main --until kills:0.5,length:0.3
//
// Options (anything else goes to the script; its game count is the most games played):
//   --base REF        A = the code at git ref REF (src/ and data from REF; the script and scripts/lib from this
//                     folder, so both sides measure the same way). Exported once per commit under
//                     <main folder>/.claude/worktrees/_ab-cache/<sha> (reused next time).
//   --a "K=V ..."     environment for side A only; --b "K=V ..." for side B only
//   --until m:p,...   stop when every listed metric's 95% interval is +-p or narrower (checked after each round)
//   --min N           play at least N games before stopping early (default 24)
//   --round N         games per round (default: 3 per worker with --until, else all games in one round)
//   --jobs N          workers in all, split between A and B (default: idle cores, as scripts/par.mjs)
//   --json FILE       write every game's metrics for A and B
//   --metrics a,b     only report these metrics
//
// Metrics: for scripts whose par.game returns engineSnap(e) (calibrate.ts) the usual game numbers (length, kills,
// dragons, barons, ... blue_win); otherwise every top-level number / true-false the script's par.game returns.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GAME_DIR, autoJobs, runShards, scratch, scriptPath, isParAware, fmtSec } from "./lib/par-run.mjs";

const argv = process.argv.slice(2);
const opt = { base: "", a: "", b: "", until: "", min: 24, round: 0, jobs: Number(process.env.PAR_JOBS) || 0, json: "", metrics: "" };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--(base|a|b|until|min|round|jobs|json|metrics)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { rest.push(argv[i]); continue; }
  const v = m[2] ?? argv[++i] ?? "";
  opt[m[1]] = typeof opt[m[1]] === "number" ? Number(v) : v;
}
const log = (m) => process.stderr.write(m + "\n");
if (!rest.length || (!opt.base && !opt.a && !opt.b)) {
  log("usage: node scripts/ab.mjs <script.ts> [script args...] (--base REF | --a \"K=V\" --b \"K=V\") [--until metric:pm,...] [--min N] [--jobs N]");
  process.exit(2);
}
const script = scriptPath(GAME_DIR, rest[0]);
const args = rest.slice(1);
if (!isParAware(GAME_DIR, script)) { log(`ab: ${script} does not use scripts/lib/par.ts (par.game / par.end)`); process.exit(2); }
const N = Number(args.find((a) => /^\d+$/.test(a)));
if (!(N > 0)) { log("ab: the script's game count must be the first number argument"); process.exit(2); }
const envOf = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((kv) => {
  if (kv.indexOf("=") <= 0) { log(`ab: "${kv}" in --a / --b is not K=V`); process.exit(2); }
  return [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)];
}));
const until = opt.until.split(",").filter(Boolean).map((x) => { const [k, p] = x.split(":"); return { k, p: Number(p) }; });

/** game/ folder holding the code at ref, exported once per commit next to the worktrees (shares their node_modules). */
function exportRef(ref) {
  const git = (...a) => execFileSync("git", a, { cwd: GAME_DIR, encoding: "utf8" }).trim();
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
  const main = dirname(resolve(GAME_DIR, git("rev-parse", "--git-common-dir")));
  const root = join(main, ".claude", "worktrees", "_ab-cache", sha.slice(0, 12));
  const dir = join(root, "game");
  // "complete" is written last, so an export cut short (Ctrl-C, full disk) is redone, never reused
  if (!existsSync(join(root, "complete"))) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const tar = join(root, "src.tar");
    // paths from the repository root (git archive reads them relative to the folder it runs in)
    execFileSync("git", ["archive", "--format=tar", "-o", tar, sha, "game/src", "game/public/data", "game/scripts", "game/vite.config.ts", "game/package.json", "game/tsconfig.json"], { cwd: git("rev-parse", "--show-toplevel") });
    execFileSync("tar", ["-xf", "src.tar"], { cwd: root });
    rmSync(tar, { force: true });
    writeFileSync(join(root, "complete"), sha + "\n");
  }
  // the measuring side is this folder's: the script itself, scripts/lib, run-ts.mjs
  cpSync(join(GAME_DIR, script), join(dir, script));
  cpSync(join(GAME_DIR, "scripts", "lib"), join(dir, "scripts", "lib"), { recursive: true });
  cpSync(join(GAME_DIR, "scripts", "run-ts.mjs"), join(dir, "scripts", "run-ts.mjs"));
  return { dir, sha };
}

// ---- metrics of one game ----
const ENGINE_METRICS = {
  length: (e) => e.t / 60,
  kills: (e) => e.kills[0] + e.kills[1],
  dragons: (e) => e.dragons[0].length + e.dragons[1].length,
  barons: (e) => e.barons[0] + e.barons[1],
  heralds: (e) => e.heralds[0] + e.heralds[1],
  grubs: (e) => e.grubs[0] + e.grubs[1],
  towers: (e) => e.towers[0] + e.towers[1],
  soul: (e) => (e.soul !== null ? 1 : 0),
  first_blood: (e) => (e.events.find((x) => x.type === "first_blood")?.t ?? e.t) / 60,
  first_turret: (e) => (e.events.find((x) => x.type === "first_turret")?.t ?? e.t) / 60,
  solo: (e) => e.events.filter((x) => x.type === "solo").length,
  doubles: (e) => e.events.filter((x) => x.type === "double").length,
  multis: (e) => e.events.filter((x) => ["triple", "quadra", "penta"].includes(x.type)).length,
  aces: (e) => e.events.filter((x) => x.type === "ace").length,
  steals: (e) => e.events.filter((x) => x.type === "steal").length,
  elder: (e) => e.events.filter((x) => x.type === "elder").length,
  blue_win: (e) => (e.winner === 0 ? 1 : 0),
};
function metricsOf(v) {
  if (v && typeof v === "object" && Array.isArray(v.events) && Array.isArray(v.kills) && typeof v.t === "number")
    return Object.fromEntries(Object.entries(ENGINE_METRICS).map(([k, f]) => [k, f(v)]));
  const o = {};
  for (const [k, x] of Object.entries(v ?? {})) if (typeof x === "number" || typeof x === "boolean") o[k] = Number(x);
  return o;
}

// ---- statistics ----
/** two-sided 95% Student t quantile (Cornish-Fisher style expansion around z) */
function t95(df) {
  const z = 1.959964;
  if (df <= 0) return Infinity;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const vr = (xs) => { const m = mean(xs); return xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1); };
function compare(A, B, key) {
  const a = A.map((m) => m[key]), b = B.map((m) => m[key]);
  const n = a.length;
  const d = b.map((x, i) => x - a[i]);
  const md = mean(d), sePair = Math.sqrt(vr(d) / n), seInd = Math.sqrt(vr(a) / n + vr(b) / n);
  const pm = t95(n - 1) * sePair;
  // games two independent runs (different seeds) would each need for an interval this narrow
  const nInd = sePair > 0 ? Math.ceil(n * (seInd / sePair) ** 2) : Infinity;
  return { key, n, a: mean(a), b: mean(b), d: md, pm, pmInd: t95(2 * n - 2) * seInd, nInd };
}

// ---- run ----
let jobs = opt.jobs || (await autoJobs(log));
jobs = Math.max(2, Math.min(jobs, 2 * N));
const per = Math.max(1, Math.floor(jobs / 2));
// rounds only matter when checking --until (each round restarts the workers, ~4 s each); otherwise one round
const roundSize = opt.round || (until.length ? per * 3 : N);
const A = { name: "A", dir: GAME_DIR, env: envOf(opt.a), label: opt.a || "this folder" };
const B = { name: "B", dir: GAME_DIR, env: envOf(opt.b), label: opt.b || "this folder" };
if (opt.base) {
  const x = exportRef(opt.base);
  A.dir = x.dir;
  A.label = `${opt.base} (${x.sha.slice(0, 9)})${opt.a ? " + " + opt.a : ""}`;
  B.label = `this folder${opt.b ? " + " + opt.b : ""}`;
}
log(`ab: ${script} ${args.join(" ")}  A = ${A.label}  B = ${B.label}  ${per}+${per} workers, ${roundSize} games per round`);
const recA = {}, recB = {};
const dir = scratch("lolsim-ab-");
const t0 = Date.now();
let hi = 0, stopped = "";
let rows = [];
while (hi < N) {
  const lo = hi;
  hi = Math.min(N, lo + roundSize);
  const run = (side) => runShards({ gameDir: side.dir, script, args, jobs: Math.min(per, hi - lo), env: side.env, range: [lo, hi], dir: join(dir, `${side.name}-${lo}`), tag: `${side.name}` });
  try {
    const [ra, rb] = await Promise.all([run(A), run(B)]);
    Object.assign(recA, ra.records);
    Object.assign(recB, rb.records);
  } catch (err) {
    log(String(err.message ?? err));
    process.exit(1);
  }
  const games = Object.keys(recA).map(Number).filter((g) => recB[g]).sort((x, y) => x - y);
  const MA = games.map((g) => metricsOf(recA[g].v)), MB = games.map((g) => metricsOf(recB[g].v));
  const keys = (opt.metrics ? opt.metrics.split(",") : Object.keys(MA[0] ?? {})).filter((k) => MA[0] && k in MA[0]);
  rows = games.length >= 2 ? keys.map((k) => compare(MA, MB, k)) : [];
  const unknown = until.filter((u) => MA[0] && !(u.k in MA[0]));
  if (unknown.length) { log(`ab: --until ${unknown.map((u) => u.k).join(",")}: no such metric (have: ${Object.keys(MA[0]).join(", ")})`); process.exit(2); }
  const watch = until.map((u) => ({ ...u, r: rows.find((r) => r.key === u.k) }));
  log(`ab: ${games.length}/${N} games, ${fmtSec((Date.now() - t0) / 1000)}` + (watch.length ? "  " + watch.map((w) => `${w.k} ${w.r ? (w.r.d >= 0 ? "+" : "") + w.r.d.toFixed(2) + " +-" + w.r.pm.toFixed(2) : "?"} (want +-${w.p})`).join(", ") : ""));
  if (opt.json) writeFileSync(opt.json, JSON.stringify({ script, args, A: A.label, B: B.label, games, A_metrics: MA, B_metrics: MB }));
  if (watch.length && games.length >= Math.min(opt.min, N) && watch.every((w) => w.r && w.r.pm <= w.p)) { stopped = `every --until interval reached after ${games.length} games`; break; }
}
rmSync(dir, { recursive: true, force: true });

const sig = (r) => (r.pm === 0 && r.d === 0 ? "same" : r.d - r.pm > 0 ? "B higher" : r.d + r.pm < 0 ? "B lower" : "no clear difference");
const n = rows[0]?.n ?? 0;
console.log(`${script} ${args.join(" ")}: ${n} paired games${stopped ? ` (stopped early: ${stopped})` : ""}, ${fmtSec((Date.now() - t0) / 1000)}`);
console.log(`A = ${A.label}`);
console.log(`B = ${B.label}`);
console.log(`${"metric".padEnd(13)} ${"A".padStart(8)} ${"B".padStart(8)} ${"B-A".padStart(8)}  ${"95% (paired)".padStart(12)}  ${"95% (2 runs)".padStart(12)}  ${"games 2 runs need".padStart(17)}  verdict`);
for (const r of rows) {
  const f = (x) => x.toFixed(Math.abs(x) >= 100 ? 0 : 2);
  console.log(`${r.key.padEnd(13)} ${f(r.a).padStart(8)} ${f(r.b).padStart(8)} ${((r.d >= 0 ? "+" : "") + f(r.d)).padStart(8)}  ${("+-" + f(r.pm)).padStart(12)}  ${("+-" + f(r.pmInd)).padStart(12)}  ${String(r.nInd === Infinity ? "-" : r.nInd).padStart(17)}  ${sig(r)}`);
}
