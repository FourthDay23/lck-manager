// Real-stat check (stats.ts + spells.gen.ts): play one engine game and print each champion's LoL stats at a few
// minutes, basic attack and spell damage after the enemy carry's armor / magic resist, next to the engine's current
// numbers. Run (Git Bash): MSYS_NO_PATHCONV=1 node scripts/run-ts.mjs scripts/stats-check.ts
//   MINS=15,25  minutes to stop at;  PICKS=blueTop,Jg,Mid,Bot,Sup/redTop,...  champion ids
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { newGame } from "../src/core/game";
import { joinTeam, autoLineup } from "../src/core/market";
import { ovr } from "../src/core/player";
import { Engine } from "../src/match/engine";
import { ROLES } from "../src/data/types";
import type { Role } from "../src/data/types";
import * as Stats from "../src/match/stats";
import * as Items from "../src/match/items";

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

const [bp, rp] = (process.env.PICKS ?? "Malphite,LeeSin,Syndra,Jinx,Thresh/Darius,Vi,Zed,Ezreal,Lulu").split("/").map((x) => x.split(","));
const side = (ids: string[]) => Object.fromEntries(ROLES.map((r, i) => [r, ids[i]])) as Partial<Record<Role, string>>;
const e = new Engine({ s, data, blue: s.lck[0], red: s.lck[3], picks: { blue: side(bp), red: side(rp) }, seed: 4242 });
const mins = (process.env.MINS ?? "15,25").split(",").map(Number);
const r0 = (n: number) => Math.round(n);

for (const m of mins) {
  while (!e.over && e.t < m * 60) e.step();
  console.log(`\n===== ${(e.t / 60).toFixed(1)} min =====`);
  for (const u of e.units) {
    const st = Stats.stats(e, u);
    const foeCarry = e.units.find((x) => x.side !== u.side && x.role === "Bot")!;
    const foeTank = e.units.find((x) => x.side !== u.side && x.role === "Top")!;
    const its = Items.unitItems(e, u);
    const names = its ? its.items.map((id) => its.data.items[String(id)]?.name ?? id).join(", ") : "";
    const aa = Stats.aaRaw(e, u);
    console.log(
      `${u.side ? "R" : "B"} ${u.champ.id.padEnd(9)} L${String(u.level).padStart(2)} HP ${r0(st.hp)} AD ${r0(st.ad)} AP ${r0(st.ap)} AS ${st.as.toFixed(2)} crit ${r0(st.crit * 100)}% ` +
        `AR ${r0(st.ar)} MR ${r0(st.mr)} haste ${st.haste} leth ${st.leth} apen ${r0(st.apen * 100)}% mpen ${st.mpen}/${r0(st.mpenPct * 100)}%  [${names}]`,
    );
    const spells = [0, 1, 2, 3].map((k) => {
      const key = "QWER"[k];
      const rank = Stats.rankOf(u, k);
      if (!Stats.hasDamage(u, k)) {
        const sup = Stats.supportAmount(e, u, k);
        return `${key}${rank}:${sup ? `shield/heal ${r0(sup)}` : "-"}`;
      }
      const raw = Stats.spellRaw(e, u, k, foeCarry);
      const net = Stats.mitigate(e, u, foeCarry, raw);
      const cd = Stats.cooldown(e, u, k);
      return `${key}${rank}:${r0(raw.p + raw.m + raw.t)}→${r0(net)}${cd ? `/${cd.toFixed(1)}s` : ""}`;
    });
    console.log(
      `      AA ${r0(aa)}/s raw → ${r0(aa * Stats.armorMul(e, u, foeCarry))} vs carry, ${r0(aa * Stats.armorMul(e, u, foeTank))} vs top   (engine now ${r0(e.aaDps(u))}/s, HP ${r0(e.maxHp(u))})   ` +
        `spells vs ${foeCarry.champ.id} (HP ${r0(Stats.stats(e, foeCarry).hp)}): ${spells.join("  ")}`,
    );
  }
}
