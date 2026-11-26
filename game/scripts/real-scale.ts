// How decisive is team strength in REAL LCK games, on the game's teamPower scale?
// Fits real outcomes ~ logistic(dPower / scale + blueBias) on LCK 2026 and 2025 games, where dPower is the gap in
// mean (OVR + role fit) of the five players who actually played that game (players.json ratings as the game uses them).
// Caveat: the ratings were built partly from these same results (win rate is one input), so the fit errs toward
// "too decisive"; out of sample the scale would be at least this large.
// Run: node scripts/run-ts.mjs scripts/real-scale.ts [path to LoLSim/data]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { POWER_SCALE } from "../src/core/quick";
import { ovr } from "../src/core/player";
import { Rng } from "../src/core/rng";

const dir = "data";
const j = (f: string) => {
  const p = `public/${dir}/${f}`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
const root = (process.argv[3] ?? "C:/Users/Jang/Desktop/LoLSim/data").replace(/\\/g, "/");

// Leaguepedia team name -> game team id (renamed clubs folded together)
const NAME: Record<string, string> = {};
for (const tid of s.lck) NAME[s.teams[tid].name] = tid;
const alias: Record<string, string> = {
  BRION: "BRO", "OKSavingsBank BRION": "BRO", "HANJIN BRION": "BRO", DRX: "KRX", "Kiwoom DRX": "KRX",
  "DN Freecs": "DNS", "DN SOOPers": "DNS", "BNK FEARX": "BFX",
};
const tidOf = (name: string) => NAME[name] ?? alias[name] ?? null;

type G = { dp: number; y: number };
function fit(xs: G[]) {
  let k = 0.1, b = 0;
  for (let it = 0; it < 100; it++) {
    let gk = 0, gb = 0, hkk = 0, hkb = 0, hbb = 0;
    for (const { dp, y } of xs) {
      const q = 1 / (1 + Math.exp(-(k * dp + b)));
      const w = q * (1 - q);
      gk += (y - q) * dp; gb += y - q;
      hkk += w * dp * dp; hkb += w * dp; hbb += w;
    }
    const det = hkk * hbb - hkb * hkb;
    k += (hbb * gk - hkb * gb) / det;
    b += (hkk * gb - hkb * gk) / det;
  }
  let hkk = 0, hkb = 0, hbb = 0;
  for (const { dp } of xs) {
    const q = 1 / (1 + Math.exp(-(k * dp + b)));
    const w = q * (1 - q);
    hkk += w * dp * dp; hkb += w * dp; hbb += w;
  }
  return { k, b, seK: Math.sqrt(hbb / (hkk * hbb - hkb * hkb)) };
}
function report(label: string, xs: G[]) {
  const f = fit(xs);
  const rng = new Rng(42);
  const scales: number[] = [];
  for (let r = 0; r < 2000; r++) {
    const bs: G[] = [];
    for (let i = 0; i < xs.length; i++) bs.push(xs[rng.int(0, xs.length - 1)]);
    const ff = fit(bs);
    scales.push(ff.k > 0 ? 1 / ff.k : 99);
  }
  scales.sort((a, b) => a - b);
  const q = (p: number) => scales[Math.floor(p * scales.length)];
  const sd = Math.sqrt(xs.reduce((a, x) => a + x.dp * x.dp, 0) / xs.length);
  const blue = (xs.reduce((a, x) => a + x.y, 0) / xs.length) * 100;
  console.log(`${label.padEnd(26)} n=${xs.length} sd(gap) ${sd.toFixed(1)} blue ${blue.toFixed(1)}% | scale ${(1 / f.k).toFixed(2)} (Fisher +-1sd ${(1 / (f.k + f.seK)).toFixed(1)}..${(1 / Math.max(1e-6, f.k - f.seK)).toFixed(1)}, bootstrap 90% ${q(0.05).toFixed(1)}..${q(0.95).toFixed(1)}) | blue bias ${f.b.toFixed(2)} logit`);
}

const missing: Record<string, number> = {};
const ROLE_ORDER = ["Top", "Jungle", "Mid", "Bot", "Support"];
const roleGapRows: { gaps: number[]; y: number }[] = [];
const rating = (r: { player: string; role: string }) => {
  const p = s.players[r.player];
  return p ? ovr(p) + (p.role === r.role ? 0 : -8) : null;
};
const lineupPower = (roster: { player: string; role: string }[]) => {
  let sum = 0, n = 0;
  for (const r of roster) {
    const v = rating(r);
    if (v === null) { missing[r.player] = (missing[r.player] ?? 0) + 1; continue; }
    sum += v;
    n++;
  }
  return n >= 4 ? sum / n : null;
};
const addRoleGaps = (blue: { player: string; role: string }[], red: { player: string; role: string }[], y: number) => {
  const gaps = ROLE_ORDER.map((role) => {
    const b = blue.find((x) => x.role === role), r = red.find((x) => x.role === role);
    const vb = b ? rating(b) : null, vr = r ? rating(r) : null;
    return vb === null || vr === null ? NaN : vb - vr;
  });
  if (gaps.every((g) => Number.isFinite(g))) roleGapRows.push({ gaps, y });
};

// ---- 2026: games_lck_2026.json ----
const g26 = JSON.parse(readFileSync(`${root}/games_lck_2026.json`, "utf8")).games as {
  blue: string; red: string; winner_side: number; roster: { player: string; role: string; side: number }[];
}[];
const r26: G[] = [];
const byTeam: { a: string; b: string; dp: number; y: number }[] = [];
for (const g of g26) {
  const pb = lineupPower(g.roster.filter((x) => x.side === 1)), pr = lineupPower(g.roster.filter((x) => x.side === 2));
  if (pb === null || pr === null) continue;
  const y = g.winner_side === 1 ? 1 : 0;
  r26.push({ dp: pb - pr, y });
  addRoleGaps(g.roster.filter((x) => x.side === 1), g.roster.filter((x) => x.side === 2), y);
  const a = tidOf(g.blue), b = tidOf(g.red);
  if (a && b) byTeam.push({ a, b, dp: pb - pr, y });
}
// ---- 2025: ScoreboardPlayers cache (ratings weight 2025 games at 0.6) ----
const r25: G[] = [];
const sp25 = `${root}/cargo_cache/game_sp_lck_2025.json`;
if (existsSync(sp25)) {
  const rows = JSON.parse(readFileSync(sp25, "utf8")) as { GameId: string; Link: string; Role: string; Side: string; Win: string }[];
  const games = new Map<string, { blue: { player: string; role: string }[]; red: { player: string; role: string }[]; y: number }>();
  for (const r of rows) {
    const g = games.get(r.GameId) ?? { blue: [], red: [], y: -1 };
    (r.Side === "1" ? g.blue : g.red).push({ player: r.Link, role: r.Role });
    if (r.Side === "1") g.y = r.Win === "Yes" ? 1 : 0;
    games.set(r.GameId, g);
  }
  for (const g of games.values()) {
    const pb = lineupPower(g.blue), pr = lineupPower(g.red);
    if (g.y >= 0 && pb !== null && pr !== null) r25.push({ dp: pb - pr, y: g.y });
    if (g.y >= 0) addRoleGaps(g.blue, g.red, g.y);
  }
}
const both = [...r26, ...r25];
console.log(`formula now: POWER_SCALE ${POWER_SCALE}`);
report("2026", r26);
report("2025", r25);
report("2025+2026", both);
for (const cap of [6, 10, 14]) report(`2025+2026 |gap|<${cap}`, both.filter((x) => Math.abs(x.dp) < cap));
report("2026 without GEN games", byTeam.filter((x) => x.a !== "GEN" && x.b !== "GEN"));

// profile log-likelihood (blue bias refit at each scale): drop from the best; under 1.92 = inside a 95% interval
const prof = (xs: G[], sc: number) => {
  let b = 0;
  for (let it = 0; it < 50; it++) {
    let g = 0, h = 0;
    for (const { dp, y } of xs) { const q = 1 / (1 + Math.exp(-(dp / sc + b))); g += y - q; h += q * (1 - q); }
    b += g / h;
  }
  let ll = 0;
  for (const { dp, y } of xs) { const q = 1 / (1 + Math.exp(-(dp / sc + b))); ll += y ? Math.log(q) : Math.log(1 - q); }
  return ll;
};
const grid = [4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 13, 15];
console.log("profile log-likelihood drop by scale:");
for (const [label, xs] of [["2026", r26], ["2025", r25], ["both", both], ["both |gap|<10", both.filter((x) => Math.abs(x.dp) < 10)]] as [string, G[]][]) {
  const lls = grid.map((sc) => prof(xs, sc));
  const best = Math.max(...lls);
  console.log(`  ${label.padEnd(14)} ` + grid.map((sc, i) => `${sc}:${(best - lls[i]).toFixed(1)}`).join(" "));
}

// folded buckets: how often the stronger lineup won, by gap (both seasons)
const pct = (gap: number, sc: number) => (100 / (1 + Math.exp(-gap / sc))).toFixed(0);
console.log("stronger lineup's real win rate by gap:");
for (const [lo, hi] of [[0, 2], [2, 4], [4, 6], [6, 9], [9, 13], [13, 18], [18, 99]]) {
  const xs = both.filter((x) => Math.abs(x.dp) >= lo && Math.abs(x.dp) < hi);
  if (!xs.length) continue;
  const m = xs.reduce((a, x) => a + Math.abs(x.dp), 0) / xs.length;
  const wr = xs.reduce((a, x) => a + (x.dp >= 0 ? x.y : 1 - x.y), 0) / xs.length;
  const se = Math.sqrt((wr * (1 - wr)) / xs.length);
  console.log(`  gap ${lo}-${hi}: n=${xs.length} mean ${m.toFixed(1)} real ${(wr * 100).toFixed(0)}% +-${(se * 100).toFixed(0)} | logistic @4.5 ${pct(m, 4.5)}% @6.5 ${pct(m, 6.5)}% @9.5 ${pct(m, 9.5)}% @11 ${pct(m, 11)}%`);
}

// season spread: 2026 per-team win rates vs what each scale predicts for the same games (+ binomial noise)
const real: Record<string, [number, number]> = {};
for (const { a, b, y } of byTeam) for (const [t, w] of [[a, y], [b, 1 - y]] as [string, number][]) {
  real[t] = real[t] ?? [0, 0];
  real[t][0] += w;
  real[t][1]++;
}
// only teams with mapped 2026 games (a renamed team missing from the alias table would have none)
const teams = s.lck.filter((t) => (real[t]?.[1] ?? 0) > 0);
const sdOf = (arr: number[]) => { const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); };
const realWr = teams.map((t) => real[t][0] / real[t][1]);
console.log(`real 2026 team win rates (sd ${(sdOf(realWr) * 100).toFixed(1)}pp): ${teams.map((t, i) => `${t} ${(realWr[i] * 100).toFixed(0)}`).join(" ")}`);
for (const sc of [4.5, 6.5, 8, 9.5, 11, 13]) {
  const exp: Record<string, [number, number]> = {};
  for (const { a, b, dp } of byTeam) {
    const p = 1 / (1 + Math.exp(-dp / sc));
    for (const [t, w] of [[a, p], [b, 1 - p]] as [string, number][]) {
      exp[t] = exp[t] ?? [0, 0];
      exp[t][0] += w;
      exp[t][1]++;
    }
  }
  const e = teams.map((t) => exp[t][0] / exp[t][1]);
  const noise = Math.sqrt(teams.reduce((a, t, i) => a + (e[i] * (1 - e[i])) / exp[t][1], 0) / teams.length);
  console.log(`  scale ${String(sc).padEnd(4)} expected sd ${(Math.sqrt(sdOf(e) ** 2 + noise ** 2) * 100).toFixed(1)}pp: ${teams.map((t, i) => `${t} ${(e[i] * 100).toFixed(0)}`).join(" ")}`);
}

// which roles' rating gaps carry the result? logistic regression on the five per-role gaps (+ blue intercept)
{
  const K = 6;
  const X = roleGapRows.map((r) => [...r.gaps, 1]);
  let w = new Array(K).fill(0);
  let H: number[][] = [];
  for (let it = 0; it < 40; it++) {
    const g = new Array(K).fill(0);
    H = Array.from({ length: K }, () => new Array(K).fill(0));
    X.forEach((x, n) => {
      const q = 1 / (1 + Math.exp(-x.reduce((a, v, i) => a + v * w[i], 0)));
      for (let i = 0; i < K; i++) {
        g[i] += (roleGapRows[n].y - q) * x[i];
        for (let k = 0; k < K; k++) H[i][k] += q * (1 - q) * x[i] * x[k];
      }
    });
    w = w.map((v, i) => v + solve(H, g)[i]);
  }
  const se = w.map((_, i) => Math.sqrt(solve(H, w.map((__, k) => (k === i ? 1 : 0)))[i]));
  console.log(`per-role logistic fit, n=${X.length} (logit per OVR point of that role's gap):`);
  ["Top", "Jungle", "Mid", "Bot", "Support", "blue"].forEach((nm, i) => console.log(`  ${nm.padEnd(8)} ${w[i].toFixed(3)} +-${se[i].toFixed(3)}`));
}
function solve(A0: number[][], b0: number[]): number[] {
  const n = b0.length;
  const A = A0.map((r, i) => [...r, b0[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r, i) => r[n] / r[i]);
}
if (Object.keys(missing).length) console.log("players not in players.json:", Object.entries(missing).map(([k, v]) => `${k}:${v}`).join(" "));
