// After a full paired run (scripts/ab.mjs ... --json FILE): from how many games on would the paired comparison have
// given the full run's conclusion? For each metric: the full run's B - A, and the first game count from which the
// paired 95% interval keeps excluding 0 on that side (or keeps including 0 when the full run shows no clear
// difference), next to the games two separate runs would need for the full run's paired precision.
//   node scripts/ab-converge.mjs FILE [metric,...]
import { readFileSync } from "node:fs";

const [file, only] = process.argv.slice(2);
const j = JSON.parse(readFileSync(file, "utf8"));
const A = j.A_metrics, B = j.B_metrics;
const keys = only ? only.split(",") : Object.keys(A[0]);
const N = A.length;
const t95 = (df) => { const z = 1.959964; return df <= 0 ? Infinity : z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3); };
function at(k, n) {
  const d = [], a = [], b = [];
  for (let i = 0; i < n; i++) { a.push(A[i][k]); b.push(B[i][k]); d.push(B[i][k] - A[i][k]); }
  const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
  const v = (x) => { const m = mean(x); return x.reduce((p, q) => p + (q - m) ** 2, 0) / Math.max(1, x.length - 1); };
  const md = mean(d), pm = t95(n - 1) * Math.sqrt(v(d) / n), pmInd = t95(2 * n - 2) * Math.sqrt(v(a) / n + v(b) / n);
  return { md, pm, pmInd, verdict: md - pm > 0 ? 1 : md + pm < 0 ? -1 : 0, verdictInd: md - pmInd > 0 ? 1 : md + pmInd < 0 ? -1 : 0 };
}
const word = (v) => (v > 0 ? "B higher" : v < 0 ? "B lower" : "no clear difference");
console.log(`${j.script} ${j.args.join(" ")}: ${N} paired games`);
console.log(`A = ${j.A}`);
console.log(`B = ${j.B}`);
console.log(`${"metric".padEnd(13)} ${"B-A".padStart(8)} ${"+-paired".padStart(9)}  ${"full-run verdict".padEnd(20)} ${"paired from".padStart(11)}  ${"2 runs from".padStart(11)}`);
for (const k of keys) {
  const full = at(k, N);
  // first n from which every later n gives the full run's verdict
  const firstStable = (pick) => { let from = null; for (let n = N; n >= 5; n--) { if (pick(at(k, n)) === pick(full)) from = n; else break; } return from; };
  const fp = firstStable((r) => r.verdict), fi = firstStable((r) => r.verdictInd);
  const f = (x) => x.toFixed(Math.abs(x) >= 100 ? 0 : 2);
  console.log(`${k.padEnd(13)} ${((full.md >= 0 ? "+" : "") + f(full.md)).padStart(8)} ${("+-" + f(full.pm)).padStart(9)}  ${word(full.verdict).padEnd(20)} ${String(fp ?? "-").padStart(11)}  ${String(fi ?? "-").padStart(11)}${fi !== null && word(full.verdictInd) !== word(full.verdict) ? ` (2 runs at ${N}: ${word(full.verdictInd)})` : ""}`);
}
