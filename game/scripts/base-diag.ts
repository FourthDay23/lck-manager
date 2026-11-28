// Fights and pushes in front of a nexus (inside a base) in engine games, same rosters, drafts and seeds as
// calibrate.ts: who fights, who stands by, how a push into the base goes and how long the game takes to end once a
// base is open. LCK 2026 for comparison (scripts/lck_late.py, lck_turrets.py): the game ends a median 0.7 min after
// the first inhibitor and 3.1 min after the first inhibitor turret; 1.63 inhibitors and 2.08 nexus turrets a game.
// Run: MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/base-diag.ts [games=40] [rosterSeed=3]
//      node scripts/par.mjs base-diag.ts 60 3            (in parallel, same report)
//      node scripts/ab.mjs base-diag.ts 60 3 --base HEAD  (paired before / after; every number below is a metric)
//   LOG=3     print every push into a base of game 3 second by second (who is where, doing what)
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { Engine, ENGINE_FLAGS, applySimTune } from "../src/match/engine";
import type { Unit } from "../src/match/engine";
import { newDraft, autoDraft } from "../src/match/draft";
import { Rng } from "../src/core/rng";
import { ROLES } from "../src/data/types";
import * as Minions from "../src/match/minions";
import * as Macro from "../src/match/macro";
import { FOUNTAIN, NEXUS } from "../src/match/map";
import { par } from "./lib/par";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"), j("matchups.json"));
const N = Number(process.argv[3] ?? 40);
const rosterSeed = Number(process.argv[4] ?? 3);
applySimTune(process.env.SIM_TUNE);
Minions.applyWaveTune?.(process.env.WAVE_TUNE);
(Macro as { applyBaseTune?: (s: string | undefined) => void }).applyBaseTune?.(process.env.BASE_TUNE);
for (const fl of (process.env.FLAGS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) (ENGINE_FLAGS as Record<string, boolean>)[fl.replace(/^-/, "")] = !fl.startsWith("-");
const LOG = process.env.LOG ? Number(process.env.LOG) : -1;

const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "test", seed: 7 });
s.user = "__nobody__";
const rr = new Rng(rosterSeed);
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
const rng = new Rng(11);
const DT = 0.25;
const BASE = 2600; // this close to a nexus is "in front of the nexus"
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const qt = (v: number[], p: number) => { const x = [...v].sort((a, b) => a - b); return x.length ? x[Math.min(x.length - 1, Math.round(p * (x.length - 1)))] : NaN; };

/** what one game adds up to: plain numbers (also the metrics of scripts/ab.mjs) and two lists for the medians */
interface Rec {
  len: number; kills: number; won: number;
  /** minutes from the first inhibitor turret / the first inhibitor to the end (-1: none fell) */
  afterBaseTurret: number; afterInhib: number; inhibs: number; nexusTurrets: number;
  /** fights with their middle within BASE of a nexus, and their sizes and kills */
  baseFights: number; bfDef: number; bfAtt: number; bfKillsDef: number; bfKillsAtt: number; bfSecs: number;
  /** champion-seconds next to a base fight (1500) without being in a fight: defenders / attackers */
  bfIdleDef: number; bfIdleAtt: number;
  /** base fights that start within 10 s of the last one ending at that base */
  refights: number;
  /** pushes (an attacker inside BASE, until none for 8 s): all, with 3+ attackers, those that end the game */
  pushes: number; pushes3: number; ended3: number; reenter: number;
  /** attacker-seconds inside the base: fighting / at a structure / neither; defender-seconds in the base during a push */
  attFight: number; attHit: number; attIdle: number; defFight: number; defIdle: number; defFountain: number;
  /** defender-seconds in the base during a push while the nexus or a nexus turret is being hit, not fighting */
  defWatch: number;
  /** defender deaths inside the base: all, and those within 15 s of walking out of the fountain alone */
  defDeaths: number; trickle: number; attDeaths: number;
  /** a living defender further than 4000 from its nexus while 3+ attackers are inside its base (seconds) */
  defAway: number;
  /** enemy minions hitting a nexus turret or the nexus with a living defender in the base and no enemy champion there (seconds) */
  minionsUnanswered: number;
  pushLens: number[]; push3Lens: number[];
  /** pushes with 3+ attackers by the champions alive (attackers minus defenders) when the third walked in: <=0, 1, 2, 3+; and those that ended the game */
  p3Adv: number[]; e3Adv: number[];
}

const recs: Rec[] = [];
for (let g = 0; g < N; g++) {
  const a = s.lck[rng.int(0, s.lck.length - 1)];
  let b = s.lck[rng.int(0, s.lck.length - 1)];
  while (b === a) b = s.lck[rng.int(0, s.lck.length - 1)];
  const d = newDraft(a, b, []);
  autoDraft(s, data, d, rng);
  const rec = par.game(g, (): Rec => {
    const e = new Engine({ s, data, blue: a, red: b, picks: { blue: d.picks.blue, red: d.picks.red }, seed: 1000 + g });
    const R: Rec = {
      len: 0, kills: 0, won: 0, afterBaseTurret: -1, afterInhib: -1, inhibs: 0, nexusTurrets: 0,
      baseFights: 0, bfDef: 0, bfAtt: 0, bfKillsDef: 0, bfKillsAtt: 0, bfSecs: 0, bfIdleDef: 0, bfIdleAtt: 0, refights: 0,
      pushes: 0, pushes3: 0, ended3: 0, reenter: 0, attFight: 0, attHit: 0, attIdle: 0, defFight: 0, defIdle: 0, defFountain: 0, defWatch: 0,
      defDeaths: 0, trickle: 0, attDeaths: 0, defAway: 0, minionsUnanswered: 0, pushLens: [], push3Lens: [], p3Adv: [0, 0, 0, 0], e3Adv: [0, 0, 0, 0],
    };
    const live = new Map<number, { base: -1 | 0 | 1; max: [number, number] }>();
    const lastFightEnd = [-99, -99];
    const cur: ({ start: number; max: number; adv: number } | null)[] = [null, null];
    const lastSeen = [-99, -99];
    const wasIn = e.units.map(() => false);
    const leftFountain = e.units.map(() => -99);
    const inFountain = e.units.map(() => true);
    let firstBaseTurret = -1, firstInhib = -1;
    const tw0 = e.turrets.map(() => true);
    const kill0 = e.kill.bind(e);
    e.kill = (src: Unit | null, v: Unit) => {
      const fid = v.fightId;
      const lf = fid ? live.get(fid) : undefined;
      if (lf && lf.base >= 0) { if (v.side === lf.base) R.bfKillsAtt++; else R.bfKillsDef++; }
      for (const sd of [0, 1] as const) {
        if (d2(v, NEXUS[sd]) > BASE + 900) continue;
        if (v.side === sd) {
          R.defDeaths++;
          // walked out of the fountain within the last 15 s with no teammate next to it: one by one into the enemy
          if (e.t - leftFountain[v.i] < 15 && !e.units.some((o) => o !== v && o.alive && o.side === sd && d2(o, v) < 900)) R.trickle++;
        } else if (cur[sd]) R.attDeaths++;
      }
      kill0(src, v);
    };
    while (!e.over && e.t < 3600) {
      const nx0 = [e.nexus[0], e.nexus[1]];
      const nt0 = e.turrets.map((t) => t.hp);
      e.step();
      e.turrets.forEach((t, i) => {
        if (tw0[i] && !t.alive) {
          tw0[i] = false;
          if (t.tier === 3 && firstBaseTurret < 0) firstBaseTurret = e.t;
          if (t.tier === 4) R.nexusTurrets++;
        } else if (!tw0[i] && t.alive) tw0[i] = true;
      });
      e.units.forEach((u, i) => {
        const inF = !u.alive || d2(u, FOUNTAIN[u.side]) < 1200;
        if (inFountain[i] && !inF) leftFountain[i] = e.t;
        inFountain[i] = inF;
      });
      // fights
      for (const [id, f] of e.fights) {
        const mem = e.units.filter((u) => u.alive && u.fightId === id);
        if (!mem.length) continue;
        let lf = live.get(id);
        if (!lf) {
          const base = d2(f, NEXUS[0]) < BASE ? 0 : d2(f, NEXUS[1]) < BASE ? 1 : -1;
          lf = { base, max: [0, 0] };
          live.set(id, lf);
          if (base >= 0) { R.baseFights++; if (e.t - lastFightEnd[base] < 10) R.refights++; }
        }
        if (lf.base < 0) continue;
        R.bfSecs += DT;
        for (const sd of [0, 1]) lf.max[sd] = Math.max(lf.max[sd], mem.filter((u) => u.side === sd).length);
        for (const u of e.units) {
          if (!u.alive || u.fightId || u.recallEnd !== undefined || d2(u, f) > 1500) continue;
          if (u.side === lf.base) R.bfIdleDef += DT;
          else R.bfIdleAtt += DT;
        }
      }
      for (const [id, lf] of live) {
        if (e.fights.has(id)) continue;
        live.delete(id);
        if (lf.base >= 0) { lastFightEnd[lf.base] = e.t; R.bfDef += lf.max[lf.base]; R.bfAtt += lf.max[1 - lf.base]; }
      }
      // pushes into a base
      for (const sd of [0, 1] as const) {
        const att = e.units.filter((u) => u.alive && u.side !== sd && d2(u, NEXUS[sd]) < BASE);
        const def = e.units.filter((u) => u.alive && u.side === sd && d2(u, NEXUS[sd]) < BASE + 900);
        let p = cur[sd];
        if (att.length) {
          lastSeen[sd] = e.t;
          if (!p) p = cur[sd] = { start: e.t, max: 0, adv: -9 };
        }
        for (const u of e.units) {
          if (u.side === sd) continue;
          const inside = u.alive && d2(u, NEXUS[sd]) < BASE;
          if (p && inside && !wasIn[u.i] && e.t - p.start > 2) R.reenter++;
          wasIn[u.i] = inside;
        }
        // minions on the nexus turrets or the nexus with a defender home and no enemy champion in the base
        const struck = e.nexus[sd] < nx0[sd] - 1e-6 || e.turrets.some((t, i) => t.side === sd && t.lane === "nexus" && t.hp < nt0[i] - 1e-6);
        if (!att.length && struck && def.length) R.minionsUnanswered += DT;
        if (!p) continue;
        p.max = Math.max(p.max, att.length);
        if (p.max >= 3 && p.adv === -9) p.adv = e.units.filter((u) => u.alive && u.side !== sd).length - e.units.filter((u) => u.alive && u.side === sd).length;
        const hitting = (u: Unit) => !u.fightId && (e.turrets.some((t) => t.alive && t.side === sd && d2(t.pos, u) < 750) || e.inhibs.some((x) => x.alive && x.side === sd && d2(x.pos, u) < 700) || d2(u, NEXUS[sd]) < 900);
        for (const u of att) { if (u.fightId) R.attFight += DT; else if (hitting(u)) R.attHit += DT; else R.attIdle += DT; }
        for (const u of def) {
          if (u.fightId) R.defFight += DT;
          else { R.defIdle += DT; if (struck) R.defWatch += DT; }
          if (d2(u, FOUNTAIN[sd]) < 1200) R.defFountain += DT;
        }
        if (att.length >= 3) for (const u of e.units) if (u.alive && u.side === sd && d2(u, NEXUS[sd]) > 4000) R.defAway += DT;
        if ((g === LOG || process.env.LOGALL) && att.length >= 2 && Math.round(e.t * 4) % 4 === 0) {
          const tag = (u: Unit) => `${u.name.slice(0, 6)}:${u.fightId ? "F" + u.fightId : u.task}${Math.round((u.hp / u.maxHp) * 100)}`;
          console.log(`  g${g} ${clock(e.t)} ${sd ? "red" : "blue"} base | att ${att.map(tag).join(" ")} | def ${def.map(tag).join(" ")} | nexus ${Math.round(e.nexus[sd])} nt ${e.turrets.filter((t) => t.side === sd && t.lane === "nexus").map((t) => (t.alive ? Math.round(t.hp) : "x")).join("/")} | minions ${Minions.list(e).filter((m) => m.side !== sd && d2(m, NEXUS[sd]) < BASE).length} | ${Macro.planLabel(e, (1 - sd) as 0 | 1)} / ${Macro.planLabel(e, sd)}`);
        }
        if (e.over || e.t - lastSeen[sd] > 8) {
          const len = e.t - p.start;
          R.pushes++;
          R.pushLens.push(len);
          if (p.max >= 3) {
            R.pushes3++; R.push3Lens.push(len);
            const k = Math.max(0, Math.min(3, p.adv));
            R.p3Adv[k]++;
            if (e.over && e.winner !== sd) { R.ended3++; R.e3Adv[k]++; }
            if (g === LOG || process.env.LOGALL) console.log(`  g${g} PUSH ${clock(p.start)}-${clock(e.t)} into ${sd ? "red" : "blue"} base: adv ${p.adv}, max ${p.max} attackers, ${e.over && e.winner !== sd ? "ENDED the game" : "failed"}`);
          }
          cur[sd] = null;
        }
      }
      if (firstInhib < 0 && e.inhibs.some((x) => !x.alive)) firstInhib = e.t;
    }
    R.len = e.t / 60;
    R.kills = e.kills[0] + e.kills[1];
    R.won = e.winner === 0 ? 1 : 0;
    R.inhibs = e.events.filter((x) => x.type === "inhib").length;
    R.afterBaseTurret = firstBaseTurret < 0 ? -1 : (e.t - firstBaseTurret) / 60;
    R.afterInhib = firstInhib < 0 ? -1 : (e.t - firstInhib) / 60;
    return R;
  });
  if (!rec) continue;
  recs.push(rec);
}
par.end();

const n = recs.length;
const sum = (f: (r: Rec) => number) => recs.reduce((x, r) => x + f(r), 0);
const per = (f: (r: Rec) => number, k = 2) => (sum(f) / n).toFixed(k);
const pct = (a: number, b: number) => `${((a / (b || 1)) * 100).toFixed(0)}%`;
const lens = recs.map((r) => r.len);
console.log(`games ${n}, roster seed ${rosterSeed}, minions ${ENGINE_FLAGS.minions ? "on" : "off"} | length ${per((r) => r.len, 1)} min (25 / 50 / 75 / 90 %: ${[0.25, 0.5, 0.75, 0.9].map((q) => qt(lens, q).toFixed(1)).join(" / ")}, over 38 min ${pct(lens.filter((x) => x > 38).length, n)}; LCK 32.2, 28.4 / 31.3 / 35.6 / 39.4, 14%: scripts/lck_late.py), kills ${per((r) => r.kills, 1)}`);
console.log(`end of the game: ${qt(recs.filter((r) => r.afterBaseTurret >= 0).map((r) => r.afterBaseTurret), 0.5).toFixed(1)} min after the first inhibitor turret (median; LCK 3.1), ${qt(recs.filter((r) => r.afterInhib >= 0).map((r) => r.afterInhib), 0.5).toFixed(1)} min after the first inhibitor (LCK 0.7) | inhibitors ${per((r) => r.inhibs)} (LCK 1.63), nexus turrets ${per((r) => r.nexusTurrets)} (LCK 2.08)`);
const bf = sum((r) => r.baseFights);
console.log(`base fights ${per((r) => r.baseFights, 1)} a game | defenders ${(sum((r) => r.bfDef) / (bf || 1)).toFixed(2)} vs attackers ${(sum((r) => r.bfAtt) / (bf || 1)).toFixed(2)} | kills by defenders ${(sum((r) => r.bfKillsDef) / (bf || 1)).toFixed(2)}, by attackers ${(sum((r) => r.bfKillsAtt) / (bf || 1)).toFixed(2)} a fight | standing within 1500 and not fighting: defenders ${(sum((r) => r.bfIdleDef) / (sum((r) => r.bfSecs) || 1)).toFixed(2)} a second, attackers ${(sum((r) => r.bfIdleAtt) / (sum((r) => r.bfSecs) || 1)).toFixed(2)} | a new fight within 10 s of the last ${pct(sum((r) => r.refights), bf)}`);
const all = recs.flatMap((r) => r.pushLens), big = recs.flatMap((r) => r.push3Lens);
console.log(`pushes into a base ${per((r) => r.pushes, 1)} a game (length median ${qt(all, 0.5).toFixed(0)} s) | with 3+ attackers ${per((r) => r.pushes3, 1)} a game, length median ${qt(big, 0.5).toFixed(0)} s, end the game ${pct(sum((r) => r.ended3), sum((r) => r.pushes3))} | attackers re-entering ${(sum((r) => r.reenter) / (sum((r) => r.pushes) || 1)).toFixed(1)} times a push`);
console.log(`  3+ pushes by champions alive when the third attacker walked in (attackers - defenders): ${[0, 1, 2, 3].map((k) => `${k === 0 ? "<=0" : k === 3 ? "3+" : k}: ${(sum((r) => r.p3Adv[k]) / n).toFixed(2)} a game, end ${pct(sum((r) => r.e3Adv[k]), sum((r) => r.p3Adv[k]))}`).join(" | ")}`);
const at = sum((r) => r.attFight + r.attHit + r.attIdle), df = sum((r) => r.defFight + r.defIdle);
console.log(`  attackers' time inside: fighting ${pct(sum((r) => r.attFight), at)}, at a structure ${pct(sum((r) => r.attHit), at)}, neither ${pct(sum((r) => r.attIdle), at)} | defenders' time in the base during a push: fighting ${pct(sum((r) => r.defFight), df)}, not fighting ${pct(sum((r) => r.defIdle), df)} (while the nexus or its turrets are being hit ${pct(sum((r) => r.defWatch), df)}), in the fountain ${pct(sum((r) => r.defFountain), df)}`);
console.log(`  deaths inside a base a game: defenders ${per((r) => r.defDeaths)} (walked out of the fountain alone and died within 15 s: ${per((r) => r.trickle)}), attackers ${per((r) => r.attDeaths)} | a living defender away from its base (4000+) while 3+ attackers are in it: ${per((r) => r.defAway, 1)} champion-seconds a game | minions on the nexus turrets with a defender home and no enemy champion: ${per((r) => r.minionsUnanswered, 1)} s a game`);
