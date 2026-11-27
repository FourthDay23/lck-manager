// Do AI drafts use the LCK matchups (match/matchup.ts) like real drafts: counter-pick when the opponent of a role is
// already known, play it safe when it is not? For each role the side that picks it later should come out ahead.
// Compares AI drafts that know the matchups with drafts that do not (same seeds), scored on the same table.
// Run: node scripts/run-ts.mjs scripts/draft-matchup-check.ts [drafts]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { aiStep, currentStep, draftWinProb, newDraft } from "../src/match/draft";
import type { DraftState } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import type { Role } from "../src/data/types";
import { draftEdge, edge, pctPoints } from "../src/match/matchup";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
const blind = { ...data, matchups: null };
const s = newGame(data, { team: "T1", difficulty: "normal", manager: "t", seed: 5 });
s.user = "__nobody__";
const N = Number(process.argv[3] ?? 300);

function run(aware: boolean) {
  let later = 0, n = 0, notable = 0, laterWins = 0, total = 0, swing = 0;
  for (let g = 0; g < N; g++) {
    const rng = new Rng(77 + g);
    const a = s.lck[g % s.lck.length], b = s.lck[(g * 3 + 1) % s.lck.length];
    if (a === b) continue;
    const d: DraftState = newDraft(a, b, []);
    const at: Record<"blue" | "red", Partial<Record<Role, number>>> = { blue: {}, red: {} };
    while (currentStep(d)) {
      const [side] = currentStep(d)!;
      const before = { ...d.picks[side] };
      aiStep(s, aware ? data : blind, d, rng);
      for (const r of ROLES) if (d.picks[side][r] && !before[r]) at[side][r] = d.step;
    }
    for (const r of ROLES) {
      const late: "blue" | "red" = (at.blue[r] ?? 0) > (at.red[r] ?? 0) ? "blue" : "red";
      const early = late === "blue" ? "red" : "blue";
      const m = edge(data, r, d.picks[late][r], d.picks[early][r]);
      later += m; n++;
      if (Math.abs(pctPoints(m)) >= 0.25) { notable++; if (m > 0) laterWins++; }
    }
    total += Math.abs(draftEdge(data, d.picks.blue, d.picks.red));
    swing += Math.abs(draftWinProb(s, data, d) - draftWinProb(s, blind, d));
  }
  console.log(`${aware ? "AI knows matchups " : "AI ignores them   "}: later picker's lane matchup ${(later / n).toFixed(4)} logit `
    + `(${pctPoints(later / n).toFixed(2)}%p); notable lanes ${(notable / n * 100).toFixed(0)}%, `
    + `later picker ahead in ${(laterWins / Math.max(1, notable) * 100).toFixed(0)}% of them; |team matchup total| `
    + `${pctPoints(total / N).toFixed(2)}%p; matchups move the predicted win chance by ${(swing / N * 100).toFixed(2)}%p`);
}
run(false);
run(true);
