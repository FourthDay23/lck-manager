// Parallel runner for measurement scripts: splits a script's games over several worker processes and prints the
// script's own report, identical to a single run with the same arguments (same seeds = same games).
//
//   node scripts/par.mjs calibrate.ts 200 3                 # workers picked from the idle cores
//   node scripts/par.mjs calibrate.ts 200 3 --jobs 6
//   SIM_TUNE=siegePush:2.2 node scripts/par.mjs calibrate.ts 200 3
//
// Options (anything else goes to the script):
//   --jobs N   worker processes (default: idle cores now - 1, and no more than the cores other measurement runs
//              leave; also env PAR_JOBS)
//   --keep     keep the scratch folder with each piece's results
//
// The script must use scripts/lib/par.ts (par.game around each game, par.end after the loop); see that file.
// Workers are stopped by their own PID when this process ends or is interrupted (never by name or pattern);
// their PIDs are listed in <scratch>/pids.txt.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { GAME_DIR, autoJobs, runShards, runTs, scratch, scriptPath, isParAware, fmtSec } from "./lib/par-run.mjs";

const argv = process.argv.slice(2);
let jobs = Number(process.env.PAR_JOBS) || 0, keep = false;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--jobs") jobs = Number(argv[++i]);
  else if (argv[i].startsWith("--jobs=")) jobs = Number(argv[i].slice(7));
  else if (argv[i] === "--keep") keep = true;
  else rest.push(argv[i]);
}
if (!rest.length) {
  console.error("usage: node scripts/par.mjs <script.ts> [script args...] [--jobs N] [--keep]");
  process.exit(2);
}
const log = (m) => process.stderr.write(m + "\n");
const script = scriptPath(GAME_DIR, rest[0]);
const args = rest.slice(1);
if (!isParAware(GAME_DIR, script)) {
  log(`par: ${script} does not use scripts/lib/par.ts, so it cannot be split; running it as one process`);
  process.exit(await runTs({ script, args, stdout: "inherit" }));
}
if (!jobs) jobs = await autoJobs(log);
// never more workers than games, when the first number argument is the game count (as in every script here)
const games = Number(args.find((a) => /^\d+$/.test(a)));
if (games > 0) jobs = Math.min(jobs, games);

const dir = scratch();
log(`par: ${script} ${args.join(" ")} in ${jobs} worker(s), scratch ${dir}`);
const t0 = Date.now();
let res;
try {
  res = await runShards({ script, args, jobs, dir });
} catch (err) {
  log(String(err.message ?? err));
  process.exit(1);
}
const t1 = Date.now();
const code = await runTs({ script, args, stdout: "inherit", tag: "[report] ", pidFile: join(dir, "pids.txt"), env: { PAR_MERGE: res.files.join(";") } });
const ms = Object.values(res.records).map((r) => r.ms);
const avg = ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length) / 1000;
log(`par: ${ms.length} games in ${fmtSec((Date.now() - t0) / 1000)} (pieces ${fmtSec((t1 - t0) / 1000)}, report ${fmtSec((Date.now() - t1) / 1000)}; ${avg.toFixed(2)} s per game inside a worker)`);
if (!keep) rmSync(dir, { recursive: true, force: true });
process.exit(code);
