// Who the choice events land on: plays whole seasons headless (random allowed option each time) and counts, per
// player, the events naming them (ModalEvent.player / .other), by kind (random, low morale, aftermath).
// Run: node scripts/run-ts.mjs scripts/event-targets.ts [teams=T1,GEN,HLE,DK,KT,BRO] [seeds=1,2,3] [days=365]
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, newGame, resolveEvent, userSeriesToday } from "../src/core/game";
import { playQuickSeries } from "../src/core/quick";
import { ovr } from "../src/core/player";
import { Rng } from "../src/core/rng";
import { EVENT_DEFS } from "../src/core/events";

const dir = existsSync("public/data/players.json") ? "data" : "data-sample";
const j = (f: string) => (existsSync(`public/${dir}/${f}`) ? JSON.parse(readFileSync(`public/${dir}/${f}`, "utf8")) : null);
const data = assembleData(dir, j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const teams = (process.argv[3] ?? "T1,GEN,HLE,DK,KT,BRO").split(",");
const seeds = (process.argv[4] ?? "1,2,3").split(",").map(Number);
const days = Number(process.argv[5] ?? 365);
const cls = new Map(EVENT_DEFS.map((d) => [d.id, d.cls]));

type Row = { name: string; n: number; rnd: number; mor: number; aft: number; startDays: number; days: number; defs: Record<string, number> };
const agg = { runs: 0, events: 0, named: 0, top1: 0, top2: 0, starterEv: 0, benchEv: 0, starterDays: 0, benchDays: 0, players: 0, zeroStarters: 0, starters: 0 };
const byDefTop: Record<string, number> = {};
const out: string[] = [];
for (const team of teams) for (const seed of seeds) {
  const s = newGame(data, { team, difficulty: "normal", manager: "t", seed });
  const rng = new Rng(seed * 977 + 13);
  const rows = new Map<string, Row>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { name: s.players[id]?.name ?? id, n: 0, rnd: 0, mor: 0, aft: 0, startDays: 0, days: 0, defs: {} }));
    return r;
  };
  const start = s.day;
  let events = 0;
  for (let guard = 0; s.day < start + days && guard < 20000; guard++) {
    const d0 = s.day;
    autoAdvance(s, data, "day");
    // exposure: days each player spent on the team, and as a starter
    if (s.day > d0) {
      const t = s.teams[s.user];
      const st = new Set(Object.values(t.lineup));
      for (const id of t.roster) {
        const r = row(id);
        r.days++;
        if (st.has(id)) r.startDays++;
      }
    }
    while (s.events.length) {
      const ev = s.events[0];
      events++;
      const k = ev.def ? cls.get(ev.def) : undefined;
      for (const id of new Set([ev.player, ev.other].filter((x): x is string => !!x))) {
        const r = row(id);
        r.n++;
        if (k === "random") r.rnd++;
        else if (k === "morale") r.mor++;
        else r.aft++;
        const key = ev.def ?? ev.kind;
        r.defs[key] = (r.defs[key] ?? 0) + 1;
      }
      const ok = ev.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
      resolveEvent(s, ev.id, ok.length ? rng.pick(ok) : 0);
      if (s.events[0] === ev) s.events.shift();
      if (s.ev) s.ev.result = undefined;
    }
    s.alerts = [];
    s.cutscenes.length = 0;
    s.tradeOffers = [];
    s.saleOffers = [];
    const sr = userSeriesToday(s);
    if (sr) {
      playQuickSeries(s, data, sr, rng);
      closeUserSeries(s, data, sr);
    }
    if (s.over) break;
  }
  const list = [...rows.entries()].filter(([, r]) => r.days > 0).sort((a, b) => b[1].n - a[1].n);
  const named = list.reduce((a, [, r]) => a + r.n, 0);
  agg.runs++;
  agg.events += events;
  agg.named += named;
  agg.players += list.length;
  agg.top1 += (list[0]?.[1].n ?? 0) / Math.max(1, named);
  agg.top2 += ((list[0]?.[1].n ?? 0) + (list[1]?.[1].n ?? 0)) / Math.max(1, named);
  for (const [, r] of list) {
    // split each player's events by the share of days he started (exposure-weighted)
    const sf = r.startDays / r.days;
    agg.starterEv += r.n * sf;
    agg.benchEv += r.n * (1 - sf);
    agg.starterDays += r.startDays;
    agg.benchDays += r.days - r.startDays;
    if (sf > 0.5) {
      agg.starters++;
      if (r.n === 0) agg.zeroStarters++;
    }
  }
  if (list[0]) for (const [d, v] of Object.entries(list[0][1].defs)) byDefTop[d] = (byDefTop[d] ?? 0) + v;
  const fmt = ([id, r]: [string, Row]) => {
    const p = s.players[id];
    const st = r.startDays / Math.max(1, r.days);
    const who = `${r.name}(${p ? p.role : "?"}${st > 0.5 ? "·주전" : "·벤치"} ovr${p ? Math.round(ovr(p)) : "?"} 명성${p ? Math.round(p.fame) : "?"} 사기${p ? Math.round(p.morale) : "?"})`;
    const defs = Object.entries(r.defs).sort((a, b) => b[1] - a[1]).map(([d, v]) => `${d}×${v}`).join(" ");
    return `  ${who} ${r.n} [무작위${r.rnd} 사기${r.mor} 후폭풍${r.aft}] ${defs}`;
  };
  out.push(`${team} seed${seed}: 이벤트 ${events}, 선수 지목 ${named}, 1위 몫 ${(((list[0]?.[1].n ?? 0) / Math.max(1, named)) * 100).toFixed(0)}%`);
  for (const x of list.slice(0, 4)) out.push(fmt(x));
  out.push(`  0회: ${list.filter(([, r]) => r.n === 0).map(([, r]) => `${r.name}${r.startDays / r.days > 0.5 ? "(주전)" : ""}`).join(", ") || "-"}`);
}
for (const r of out) console.log(r);
console.log("");
console.log("=== 요약 ===");
console.log(`판 ${agg.runs} · 판당 이벤트 ${(agg.events / agg.runs).toFixed(1)} · 판당 선수 지목 ${(agg.named / agg.runs).toFixed(1)} · 판당 선수 ${(agg.players / agg.runs).toFixed(1)}`);
console.log(`가장 많이 걸린 선수 1명의 몫 평균 ${((agg.top1 / agg.runs) * 100).toFixed(1)}% · 상위 2명 ${((agg.top2 / agg.runs) * 100).toFixed(1)}%`);
const sRate = (agg.starterEv / Math.max(1, agg.starterDays)) * 30;
const bRate = (agg.benchEv / Math.max(1, agg.benchDays)) * 30;
console.log(`30일당 1인 지목: 주전 ${sRate.toFixed(2)} · 벤치 ${bRate.toFixed(2)} (벤치/주전 ${(bRate / Math.max(1e-9, sRate)).toFixed(2)}배, 설계는 0.5배)`);
console.log(`한 번도 안 걸린 주전 ${agg.zeroStarters}/${agg.starters}`);
console.log(`1위 선수에게 간 이벤트 종류: ${Object.entries(byDefTop).sort((a, b) => b[1] - a[1]).map(([d, v]) => `${d}×${v}`).join(" ")}`);
