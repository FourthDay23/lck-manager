// Summarise a V8 CPU profile (node --cpu-prof) by function: self time and total (inclusive) time, heaviest first.
//   node --cpu-prof --cpu-prof-dir=prof scripts/run-ts.mjs scripts/calibrate.ts 3 3
//   node scripts/prof-top.mjs prof/<file>.cpuprofile [rows=30] [filter=src/match]
import { readFileSync } from "node:fs";

const [file, rowsArg, filter = ""] = process.argv.slice(2);
const rows = Number(rowsArg ?? 30);
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const dt = new Map();
for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
const total = [...dt.values()].reduce((a, b) => a + b, 0);
const key = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.replace(/^.*\/(src|scripts)\//, "$1/")}:${n.callFrame.lineNumber + 1}`;
const self = new Map(), incl = new Map();
for (const [id, t] of dt) {
  const n = byId.get(id);
  self.set(key(n), (self.get(key(n)) ?? 0) + t);
  // inclusive: each function once per stack (recursion counted once)
  const seen = new Set();
  for (let x = id; x !== undefined; x = parent.get(x)) {
    const k = key(byId.get(x));
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + t);
  }
}
const show = (m, title) => {
  console.log(`${title} (of ${(total / 1e6).toFixed(1)} s sampled)`);
  for (const [k, t] of [...m].filter(([k]) => k.includes(filter)).sort((a, b) => b[1] - a[1]).slice(0, rows)) console.log(`  ${((t / total) * 100).toFixed(1).padStart(5)}%  ${(t / 1e6).toFixed(2).padStart(6)} s  ${k}`);
};
show(self, "self time");
show(incl, "total time");
