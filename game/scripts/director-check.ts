// Broadcast camera check without a browser: runs real engine games through MatchRenderer with a stub canvas at a
// given playback speed and measures, for every fight of 3+ champions, whether its spot was already on screen when it
// started (the camera got there first), how long before, and how often the camera cuts.
//   node scripts/run-ts.mjs scripts/director-check.ts [games] [speed]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";

// ---- browser stubs: a 2D context that ignores every call, and images that never load ----
const noop = () => undefined;
const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop: noop }) : noop), set: () => true });
(globalThis as Record<string, unknown>).Image = class { src = ""; complete = false; naturalWidth = 0; crossOrigin = ""; };
const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
const { MatchRenderer } = await import("../src/match/render");

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"));
const N = Number(process.argv[3] ?? 6);
const SPEED = Number(process.argv[4] ?? 2);
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
s.user = "__nobody__";
const rr = new Rng(3);
const pool = rr.shuffle(Object.values(s.players).filter((p) => !p.team && p.origin === "real"));
for (const r of ROLES) {
  const byRole = pool.filter((p) => p.role === r);
  for (const tid of s.lck) {
    if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
    const p = byRole.shift();
    if (p) joinTeam(s, p, tid, 10000, 2);
  }
}
for (const tid of s.lck) autoLineup(s, s.teams[tid]);

const rng = new Rng(21);
const reasons: Record<string, number> = {};
const labelFrames: Record<string, number> = {};
let laneFrames = 0;
let fights = 0, onScreen = 0, ahead = 0, aheadSum = 0, cuts = 0, minutes = 0;
for (let g = 0; g < N; g++) {
  const [a, b] = rng.shuffle([...s.lck]).slice(0, 2);
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const e = new Engine({ s, data, blue: a, red: b, picks: d.picks, seed: 1000 + g });
  const r = new MatchRenderer(canvas, e, data.ddVersion, null);
  let now = 0;
  const frame = 1000 / 60;
  const gps = 8 * SPEED;
  let acc = 0;
  const seenFight = new Set<number>();
  // how long (game s) each spot has been inside the view, sampled per frame
  let lastCam = { ...r.cam };
  while (!e.over && e.t < 3600) {
    now += frame;
    acc += (frame / 1000) * gps;
    while (acc >= 0.25 && !e.over) { e.step(); acc -= 0.25; }
    const prevShot = r.shotId, prevSince = r.shotSince, prevLabel = r.shotLabel;
    r.draw(now);
    if (e.t > 120 && e.t < 840) { laneFrames++; const l = r.shotLabel; const k = l.endsWith("직전") ? "about to clash" : l.endsWith("라인전") ? "lane tour" : l || "none"; labelFrames[k] = (labelFrames[k] ?? 0) + 1; }
    if (Math.hypot(r.cam.x - lastCam.x, r.cam.y - lastCam.y) > 300 || Math.abs(r.cam.size - lastCam.size) > 400) {
      cuts++;
      const why = r.shotSince !== prevSince ? "new shot" : r.shotId !== prevShot ? "renamed shot" : r.shotId ? "re-frame in shot" : r.shotLabel !== prevLabel ? "fallback change" : "linger/other";
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    lastCam = { ...r.cam };
    for (const [id, f] of e.fights) {
      if (seenFight.has(id)) continue;
      const m = e.units.filter((u) => u.alive && u.fightId === id);
      if (m.length < 3) continue;
      seenFight.add(id);
      fights++;
      const cx = m.reduce((q, u) => q + u.x, 0) / m.length, cy = m.reduce((q, u) => q + u.y, 0) / m.length;
      const half = r.cam.size / 2 * 0.9;
      const inView = Math.abs(cx - r.cam.x) < half && Math.abs(cy - r.cam.y) < half && r.cam.size < 12000;
      if (inView) onScreen++;
      // the camera got there before the fight: the current shot started earlier than this fight
      if (inView && r.shotSinceT < e.t - 0.5) { ahead++; aheadSum += e.t - r.shotSinceT; }
      void f;
    }
  }
  minutes += e.t / 60;
}
console.log(`speed ${SPEED}x, ${N} games, ${minutes.toFixed(0)} game minutes`);
console.log(`fights of 3+: ${fights}; on screen when they started: ${onScreen} (${Math.round((onScreen / Math.max(1, fights)) * 100)}%)`);
console.log(`camera already there before the start: ${ahead} (${Math.round((ahead / Math.max(1, fights)) * 100)}%), on average ${(aheadSum / Math.max(1, ahead)).toFixed(1)} game s before`);
console.log(`camera cuts: ${cuts}, ${(cuts / minutes).toFixed(1)} per game minute, ${(cuts / (minutes * 60 / (8 * SPEED))).toFixed(2)} per real second`);
console.log("cut reasons", reasons);
console.log("2-14 min, share of frames by shot:", Object.entries(labelFrames).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${Math.round((v / laneFrames) * 100)}%`).join(", "));
