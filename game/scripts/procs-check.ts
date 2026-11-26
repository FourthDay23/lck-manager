// Combat-effect check (procs.ts with items, runes, summoners, passives) without the fight module: play one engine
// game to MIN minutes, then let each blue champion duel the red one in the same role for SECS seconds, calling the
// hooks the way fight.ts will (attacks every step, a spell every few seconds, tick), and print what each effect
// added. Run (Git Bash): MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/procs-check.ts   (MIN=20 SECS=8 PICKS=…)
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine } from "../src/match/engine";
import type { Unit } from "../src/match/engine";
import { ROLES } from "../src/data/types";
import type { Role } from "../src/data/types";
import * as Stats from "../src/match/stats";
import * as Procs from "../src/match/procs";
import type { Kind } from "../src/match/procs";
import { summonersOf } from "../src/match/summoners";
import { setCCHook } from "../src/match/procs-lib";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"), j("items.json"));
const s = newGame(data, { team: data.teams[0].id, difficulty: "normal", manager: "t", seed: 7 });
const pool = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => ovr(b) - ovr(a));
for (const r of ROLES) {
  const byRole = pool.filter((p) => p.role === r);
  for (const tid of s.lck) {
    if (s.teams[tid].roster.some((id) => s.players[id].role === r)) continue;
    const p = byRole.shift();
    if (p) joinTeam(s, p, tid, 10000, 2);
  }
}
for (const tid of s.lck) autoLineup(s, s.teams[tid]);

const [bp, rp] = (process.env.PICKS ?? "Aatrox,XinZhao,Ahri,Jinx,Nautilus/KSante,Vi,Syndra,Kaisa,Braum").split("/").map((x) => x.split(","));
const side = (ids: string[]) => Object.fromEntries(ROLES.map((r, i) => [r, ids[i]])) as Partial<Record<Role, string>>;
const e = new Engine({ s, data, blue: s.lck[0], red: s.lck[3], picks: { blue: side(bp), red: side(rp) }, seed: 4242 });
const MIN = Number(process.env.MIN ?? 20), SECS = Number(process.env.SECS ?? 8);
while (!e.over && e.t < MIN * 60) e.step();

// what each champion carries
for (const u of e.units) {
  console.log(`${u.side ? "R" : "B"} ${u.champ.id.padEnd(9)} L${u.level} [${summonersOf(u).join("+")}] effects: ${Procs.effectsOf(e, u).join(", ")}`);
}

// duels
const tally = new Map<number, Record<Kind, number>>();
const add = (u: Unit | null, kind: Kind, a: number) => {
  if (!u) return;
  const r = tally.get(u.i) ?? { aa: 0, spell: 0, proc: 0, dot: 0, raw: 0 };
  r[kind] += a;
  tally.set(u.i, r);
};
let errors = 0;
const deal: Procs.Deal = (src, v, amount, kind) => {
  if (!v.alive || amount <= 0) return;
  const a = Procs.incoming(e, src, v, amount, kind, deal);
  if (a <= 0) return;
  if (a >= v.hp + v.shield && Procs.onLethal(e, v, src, deal)) return;
  e.damage(src, v, a);
  add(src, kind, a);
  Procs.onDealt(e, src, v, a, kind, deal);
};
setCCHook((_e, _src, v, _type, dur) => { v.stunUntil = Math.max(v.stunUntil, e.t + dur * (1 - Procs.tenacity(e, v))); });
const DT = 0.25;
const pairs = ROLES.map((r) => [e.units.find((u) => u.side === 0 && u.role === r)!, e.units.find((u) => u.side === 1 && u.role === r)!]);
for (const [a, b] of pairs) {
  for (const u of [a, b]) { u.alive = true; u.hp = u.maxHp; u.shield = 0; u.stunUntil = 0; u.fightId = 1; u.x = 7000; u.y = 7000; }
  b.x += 300;
}
const t0 = e.t;
try {
  while (e.t < t0 + SECS) {
    for (const [a, b] of pairs) {
      for (const [u, v] of [[a, b], [b, a]] as const) {
        if (!u.alive || !v.alive || e.t < u.stunUntil) continue;
        const aa = Stats.aaRaw(e, u) * Stats.armorMul(e, u, v) * DT;
        deal(u, v, aa, "aa");
        Procs.onAttack(e, u, v, Stats.stats(e, u).as * DT, deal);
        // one spell every 2 s, rotating Q W E (R once)
        const step = Math.round((e.t - t0) / DT);
        if (step % 8 === 0) {
          const k = step === 8 ? 3 : (step / 8) % 3;
          Procs.onCast(e, u, k, deal);
          if (Stats.hasDamage(u, k) && !Procs.spellShield(e, v)) {
            deal(u, v, Stats.mitigate(e, u, v, Stats.spellRaw(e, u, k, v)), "spell");
            Procs.onSpellHit(e, u, v, k, deal);
          }
        }
      }
    }
    Procs.tick(e, DT, deal);
    e.t += DT;
  }
} catch (err) {
  errors++;
  console.error("ERROR", err);
}
console.log(`\nduels ${SECS}s at ${MIN} min (damage dealt by kind; proc+dot = effects)`);
for (const [a, b] of pairs) {
  for (const u of [a, b]) {
    const r = tally.get(u.i) ?? { aa: 0, spell: 0, proc: 0, dot: 0, raw: 0 };
    const tot = r.aa + r.spell + r.proc + r.dot || 1;
    console.log(`${u.side ? "R" : "B"} ${u.champ.id.padEnd(9)} hp ${Math.round(u.hp)}/${Math.round(u.maxHp)}${u.alive ? "" : " (dead)"}  aa ${Math.round(r.aa)} spell ${Math.round(r.spell)} proc ${Math.round(r.proc)} dot ${Math.round(r.dot)}  effects ${Math.round(100 * (r.proc + r.dot) / tot)}%`);
  }
}
if (errors) process.exitCode = 1;
