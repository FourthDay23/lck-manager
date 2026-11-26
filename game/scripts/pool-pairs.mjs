// Pool calib-pairs.ts outputs: per-file and pooled logistic fit win ~ sigmoid(a*logit(p)+b), with Fisher SE.
// Usage: node pool.mjs <dir> <prefix>   e.g. node pool.mjs outA pairs_0.75_
import { readdirSync, readFileSync } from "node:fs";
const [dir, prefix] = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
function fit(rows) {
  let a = 1, b = 0;
  const xs = rows.map((r) => { const p = Math.min(0.995, Math.max(0.005, r.p)); return [Math.log(p / (1 - p)), r.win]; });
  for (let it = 0; it < 60; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const [x, y] of xs) {
      const q = 1 / (1 + Math.exp(-(a * x + b)));
      const w = q * (1 - q);
      ga += (y - q) * x; gb += y - q; haa += w * x * x; hab += w * x; hbb += w;
    }
    const det = haa * hbb - hab * hab;
    a += (hbb * ga - hab * gb) / det;
    b += (haa * gb - hab * ga) / det;
  }
  let haa = 0, hab = 0, hbb = 0;
  for (const [x] of xs) { const q = 1 / (1 + Math.exp(-(a * x + b))); const w = q * (1 - q); haa += w * x * x; hab += w * x; hbb += w; }
  const det = haa * hbb - hab * hab;
  return { a, b, seA: Math.sqrt(hbb / det), seB: Math.sqrt(haa / det) };
}
const all = [];
const m = (rows, k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
for (const f of files) {
  const rows = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  all.push(...rows);
  const r = fit(rows);
  console.log(`${f}: n=${rows.length} slope ${r.a.toFixed(2)} +-${r.seA.toFixed(2)} bias ${r.b.toFixed(2)} +-${r.seB.toFixed(2)} blue ${(m(rows, "win") * 100).toFixed(1)}% | len ${(m(rows, "len") / 60).toFixed(1)} kills ${m(rows, "kills").toFixed(1)} drag ${m(rows, "drag").toFixed(2)} baron ${m(rows, "barons").toFixed(2)}`);
}
const r = fit(all);
console.log(`POOLED n=${all.length} slope ${r.a.toFixed(2)} +-${r.seA.toFixed(2)} bias ${r.b.toFixed(2)} +-${r.seB.toFixed(2)} blue ${(m(all, "win") * 100).toFixed(1)}% | len ${(m(all, "len") / 60).toFixed(1)} kills ${m(all, "kills").toFixed(1)} drag ${m(all, "drag").toFixed(2)} baron ${m(all, "barons").toFixed(2)}`);
const buckets = [0, 1, 2, 3, 4].map(() => ({ n: 0, w: 0, p: 0 }));
for (const x of all) { const k = Math.min(4, Math.floor(x.p * 5)); buckets[k].n++; buckets[k].w += x.win; buckets[k].p += x.p; }
for (const [i, bk] of buckets.entries()) if (bk.n) console.log(`  p ${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}: mean p ${(bk.p / bk.n).toFixed(2)} engine ${(bk.w / bk.n).toFixed(2)} (n=${bk.n})`);
