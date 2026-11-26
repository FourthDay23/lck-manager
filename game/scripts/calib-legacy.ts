// calibrate.ts with the older class-and-gold combat formulas (real numbers off), for before/after comparisons.
// Run: node scripts/run-ts.mjs scripts/calib-legacy.ts [games] [rosterSeed]   (same arguments as calibrate.ts)
import { STATS_FLAGS } from "../src/match/stats";

STATS_FLAGS.real = false;
await import("./calibrate");
