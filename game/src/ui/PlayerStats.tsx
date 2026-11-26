// Per-player numbers as bar charts: live during a match (MatchView, where the objective timers used to be; those live
// on in the scoreboard) and after it (GameResult). Tabs pick the measure; both teams side by side, bars scaled to the
// highest of the ten.
import { useRef, useState } from "preact/hooks";
import type { Engine } from "../match/engine";
import type { GameRecord } from "../core/types";
import { ROLES } from "../data/types";
import { S } from "../store";
import { ChampIcon } from "./components";
import "./playerstats.css";

type Tab = "gold" | "dmg" | "dps" | "cs" | "kp" | "kda";
interface Row { side: 0 | 1; name: string; champ: string; value: number; sub?: string }

const k1 = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
function fmt(tab: Tab, v: number): string {
  if (tab === "gold" || tab === "dmg") return k1(v);
  if (tab === "dps") return v.toFixed(0);
  if (tab === "kp") return `${Math.round(v * 100)}%`;
  if (tab === "kda") return v.toFixed(1);
  return `${Math.round(v)}`;
}

function Tabs({ tabs, tab, set }: { tabs: [Tab, string][]; tab: Tab; set: (t: Tab) => void }) {
  return (
    <div class="row ps-tabs">
      {tabs.map(([k, l]) => <button class={`btn small ${tab === k ? "on" : ""}`} onClick={() => set(k)}>{l}</button>)}
    </div>
  );
}

function Bars({ rows, tab }: { rows: Row[]; tab: Tab }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div class="ps-grid">
      {([0, 1] as const).map((side) => (
        <div class="ps-col">
          {rows.filter((r) => r.side === side).map((r) => (
            <div class="ps-row" title={r.sub}>
              <ChampIcon id={r.champ} size={22} />
              <span class="ps-name">{r.name}</span>
              <div class="ps-bar"><i class={side ? "red" : "blue"} style={{ width: `${Math.max(0, (r.value / max) * 100)}%` }} /></div>
              <b class="ps-val">{fmt(tab, r.value)}</b>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const LIVE_TABS: [Tab, string][] = [["gold", "골드"], ["dmg", "가한 피해"], ["dps", "DPS (최근 10초)"], ["cs", "CS"], ["kp", "킬 관여"]];
const DPS_WINDOW = 10;

/** During a match. Damage is what each champion has dealt to champions (engine `dmg`); DPS is its last 10 game seconds. */
export function LivePlayerStats({ e }: { e: Engine }) {
  const [tab, setTab] = useState<Tab>("gold");
  // damage samples once per game second, for the recent-DPS window (reset when a new game's engine comes in)
  const hist = useRef<{ eng: Engine | null; s: { t: number; dmg: number[] }[] }>({ eng: null, s: [] });
  const h = hist.current;
  if (h.eng !== e) { h.eng = e; h.s = []; }
  if (!h.s.length || e.t - h.s[h.s.length - 1].t >= 1) {
    h.s.push({ t: e.t, dmg: e.units.map((u) => u.dmg) });
    if (h.s.length > DPS_WINDOW * 4) h.s.shift();
  }
  const past = [...h.s].reverse().find((x) => e.t - x.t >= DPS_WINDOW) ?? h.s[0];
  const span = Math.max(1, e.t - past.t);
  const rows: Row[] = e.units.map((u, i) => ({
    side: u.side,
    name: u.name,
    champ: u.champ.id,
    value:
      tab === "gold" ? u.gold :
      tab === "dmg" ? u.dmg :
      tab === "dps" ? Math.max(0, (u.dmg - (past.dmg[i] ?? 0)) / span) :
      tab === "cs" ? u.cs :
      (u.k + u.a) / Math.max(1, e.kills[u.side]),
    sub: `${u.k}/${u.d}/${u.a} · Lv${u.level}`,
  }));
  return (
    <div class="player-stats">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>선수별 데이터</h3>
        <span class="muted" style={{ fontSize: 11 }}>
          골드 <b style={{ color: "var(--blue)" }}>{k1(e.gold(0))}</b> : <b style={{ color: "var(--red)" }}>{k1(e.gold(1))}</b>
        </span>
      </div>
      <Tabs tabs={LIVE_TABS} tab={tab} set={setTab} />
      <Bars rows={rows} tab={tab} />
      {tab === "dps" && <div class="muted" style={{ fontSize: 10 }}>최근 {DPS_WINDOW}게임초 동안 챔피언에게 준 피해 ÷ 시간</div>}
    </div>
  );
}

/** After a game, from its record. Games simulated without the match engine (other teams' games) have no gold or
 *  damage, so those tabs only appear when the record has them. */
export function RecordStats({ g }: { g: GameRecord }) {
  const s = S();
  const box = g.box ?? {};
  const hasEcon = Object.values(box).some((b) => b.gold !== undefined && b.dmg !== undefined);
  const tabs: [Tab, string][] = [
    ...(hasEcon ? ([["gold", "골드"], ["dmg", "가한 피해"], ["dps", "평균 DPS"]] as [Tab, string][]) : []),
    ["cs", "CS"], ["kp", "킬 관여"], ["kda", "KDA"],
  ];
  const [tab, setTab] = useState<Tab>(tabs[0][0]);
  const cur = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];
  const rows: Row[] = [];
  ([[g.blue, g.picks.blue, 0], [g.red, g.picks.red, 1]] as [string, string[], 0 | 1][]).forEach(([team, champs, side]) => {
    ROLES.forEach((r, i) => {
      const pid = s.teams[team]?.lineup[r];
      const b = pid ? box[pid] : undefined;
      if (!b) return;
      rows.push({
        side,
        name: s.players[pid!]?.name ?? "-",
        champ: b.champ ?? champs[i],
        value:
          cur === "gold" ? b.gold ?? 0 :
          cur === "dmg" ? b.dmg ?? 0 :
          cur === "dps" ? (b.dmg ?? 0) / Math.max(1, g.duration) :
          cur === "cs" ? b.cs :
          cur === "kp" ? (b.k + b.a) / Math.max(1, g.kills[side]) :
          (b.k + b.a) / Math.max(1, b.d),
        sub: `${b.k}/${b.d}/${b.a}`,
      });
    });
  });
  if (!rows.length) return null;
  return (
    <div class="player-stats" style={{ marginTop: 8 }}>
      <h3 style={{ margin: "0 0 4px" }}>선수별 데이터</h3>
      <Tabs tabs={tabs} tab={cur} set={setTab} />
      <Bars rows={rows} tab={cur} />
      {cur === "dps" && <div class="muted" style={{ fontSize: 10 }}>경기 전체 동안 챔피언에게 준 피해 ÷ 경기 시간(초)</div>}
    </div>
  );
}
