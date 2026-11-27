// Process side of scripts/lib/par.ts, shared by scripts/par.mjs and scripts/ab.mjs: how many workers fit on this PC,
// starting the worker processes, and stopping only the processes this run started.
import { spawn, execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GAME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Share of CPU time that was idle over ms milliseconds, across all cores. */
export async function cpuIdle(ms = 1000) {
  const a = cpus();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpus();
  let idle = 0, total = 0;
  b.forEach((c, i) => {
    for (const k of Object.keys(c.times)) total += c.times[k] - a[i].times[k];
    idle += c.times.idle - a[i].times.idle;
  });
  return total ? idle / total : 0;
}

/** Other measurement processes running now (node ... run-ts.mjs ...), not counting this run's own. */
export function otherRuns(own = new Set()) {
  try {
    if (process.platform === "win32") {
      const ps = "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
      const txt = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
      return txt.split(/\r?\n/).filter((l) => /run-ts\.mjs/.test(l) && !own.has(Number(l.split("\t")[0]))).length;
    }
    const txt = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    return txt.split("\n").filter((l) => /node .*run-ts\.mjs/.test(l) && !own.has(Number(l.trim().split(/\s+/)[0]))).length;
  } catch {
    return 0;
  }
}

/**
 * Workers to start: the cores that are idle now, minus one for the desktop, and never more than the cores
 * the other measurement runs leave (each holds about one core). At least 1.
 */
export async function autoJobs(log = () => {}) {
  const n = cpus().length;
  // the process listing first: PowerShell's own start-up would count as busy inside the idle sample
  const others = otherRuns();
  const idle = await cpuIdle(1000);
  const byIdle = Math.floor(idle * n) - 1;
  const byOthers = n - others - 1;
  const jobs = Math.max(1, Math.min(byIdle, byOthers));
  log(`par: ${n} cores, ${(idle * 100).toFixed(0)}% idle, ${others} other measurement run(s) -> ${jobs} worker(s)`);
  return jobs;
}

const children = new Set();
function killOwn() {
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode) continue;
    try {
      // only this PID and the processes it started (/T); never by name or pattern
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch { /* already gone */ }
  }
}
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on("exit", killOwn);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { killOwn(); process.exit(130); });
}

/** Run one node process on run-ts.mjs (in gameDir) and resolve with its exit code; stderr lines get a prefix. */
export function runTs({ gameDir = GAME_DIR, script, args = [], env = {}, stdout = "ignore", tag = "", pidFile }) {
  hookExit();
  return new Promise((res) => {
    const c = spawn(process.execPath, [join(gameDir, "scripts/run-ts.mjs"), script, ...args], {
      cwd: gameDir,
      env: { ...process.env, MSYS_NO_PATHCONV: "1", ...env },
      stdio: ["ignore", stdout === "inherit" ? "inherit" : "pipe", "pipe"],
      windowsHide: true,
    });
    children.add(c);
    if (pidFile) writeFileSync(pidFile, `${c.pid}\n`, { flag: "a" });
    let err = "";
    if (c.stdout) c.stdout.on("data", () => {});
    c.stderr.on("data", (d) => {
      err += d;
      const lines = err.split(/\r?\n/);
      err = lines.pop();
      for (const l of lines) if (l.trim()) process.stderr.write(`${tag}${l}\n`);
    });
    c.on("close", (code) => {
      if (err.trim()) process.stderr.write(`${tag}${err}\n`);
      children.delete(c);
      res(code ?? 1);
    });
  });
}

/** A fresh scratch folder for one run's pieces. */
export function scratch(prefix = "lolsim-par-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Play games of script in `jobs` worker processes (PAR_SHARD=i/jobs), each playing g % jobs == i within
 * range [lo, hi). Resolves with { files, records: { g: { v, ms } }, seconds }. Throws when a worker fails.
 */
export async function runShards({ gameDir = GAME_DIR, script, args, jobs, env = {}, range, dir, tag = "" }) {
  dir ??= scratch();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const pidFile = join(dir, "pids.txt");
  const t0 = Date.now();
  const files = [];
  const runs = [];
  for (let i = 0; i < jobs; i++) {
    const file = join(dir, `piece-${i}.json`);
    files.push(file);
    rmSync(file, { force: true });
    runs.push(runTs({ gameDir, script, args, tag: `${tag}[${i}] `, pidFile, env: { ...env, PAR_SHARD: `${i}/${jobs}`, PAR_OUT: file, ...(range ? { PAR_RANGE: `${range[0]}-${range[1]}` } : {}) } }));
  }
  const codes = await Promise.all(runs);
  const bad = codes.map((c, i) => [c, i]).filter(([c, i]) => c !== 0 || !existsSync(files[i]));
  if (bad.length) {
    const noFile = bad.some(([c]) => c === 0);
    throw new Error(`par: piece(s) ${bad.map(([, i]) => i).join(",")} failed` + (noFile ? ` (exit 0 but no result file: does ${script} call par.game / par.end from scripts/lib/par.ts?)` : ""));
  }
  const records = {};
  for (const f of files) Object.assign(records, JSON.parse(readFileSync(f, "utf8"), dec).records);
  return { files, records, seconds: (Date.now() - t0) / 1000 };
}

/** Reviver for the pieces' files: undoes scripts/lib/par.ts's encoding of NaN / Infinity / -0, Map and Set. */
function dec(_k, v) {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1) {
    if (typeof v.$n === "string") return v.$n === "-0" ? -0 : Number(v.$n);
    if (Array.isArray(v.$map)) return new Map(v.$map);
    if (Array.isArray(v.$set)) return new Set(v.$set);
  }
  return v;
}

/** Resolve "calibrate.ts" / "scripts/calibrate.ts" to the path run-ts.mjs wants (relative to the game folder). */
export function scriptPath(gameDir, s) {
  const cands = [s, `scripts/${s}`, `scripts/${s}.ts`].map((x) => x.replace(/\\/g, "/"));
  for (const c of cands) if (existsSync(join(gameDir, c))) return c;
  throw new Error(`par: no script ${s} under ${gameDir}`);
}

/** Does the script use scripts/lib/par.ts? (otherwise every worker would play every game) */
export function isParAware(gameDir, script) {
  return /from\s+["']\.\/lib\/par["']/.test(readFileSync(join(gameDir, script), "utf8"));
}

export const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(1)}s`);
