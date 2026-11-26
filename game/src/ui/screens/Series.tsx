import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { S, D, store } from "../../store";
import { closeUserSeries, stageName, userSeriesToday } from "../../core/game";
import type { GameRecord, Series } from "../../core/types";
import { COMP_NAME } from "../../core/types";
import { ROLES, ROLE_KO, STYLE_KO } from "../../data/types";
import type { ChampionData, Role } from "../../data/types";
import { Rng } from "../../core/rng";
import { fmtClock, oddsWord } from "../../core/format";
import {
  COMP_KEYS, DRAFT_ORDER, aiStep, applyStep, autoDraft, coachSuggestions, compProfile, currentStep, draftWinProb,
  lineupOf, mastery, newDraft, openRoles, unavailable,
} from "../../match/draft";
import type { DraftState, Side } from "../../match/draft";
import { Engine, ENGINE_FLAGS } from "../../match/engine";
import { planLabel } from "../../match/macro";
import type { GameEvent, ObjKey, Tactic } from "../../match/engine";
import { OBJ_KO } from "../../match/engine";
import { STRATEGIES, STRATEGY_DESC, STRATEGY_KO } from "../../match/strategy";
import type { Strategy } from "../../match/strategy";
import { CAPTION_MS, MatchRenderer } from "../../match/render";
import "../caption.css";
import "../draft.css";
import { ItemStrip, LoadoutPicker, RuneBadge } from "../Loadout";
import { Scorebar } from "../Scorebar";
import type { SeriesInfo } from "../Scorebar";
import { standings } from "../../core/schedule";
import type { CamMode } from "../../match/render";
import { ChampIcon, TeamLogo, Bar } from "../components";
import { autosave } from "../App";
import { seriesWinProb } from "../../core/quick";
import { META_LABEL, metaTier } from "../../core/meta";

interface Live {
  srId: string;
  phase: "pre" | "draft" | "match" | "post" | "done";
  blue: string;
  red: string;
  draft: DraftState | null;
  engine: Engine | null;
  tactic: Tactic;
  /** the coach's game plan for the next game (운영 방식) */
  strategy: Strategy;
  last?: GameRecord;
  skipAll?: boolean;
}
let live: Live | null = null;
/** the last game plan the user picked, so the next series starts from it */
let lastStrategy: Strategy = "balanced";

function fearlessOf(sr: Series): string[] {
  return sr.games.flatMap((g) => [...g.picks.blue, ...g.picks.red]);
}

export function recordFromEngine(e: Engine, d: DraftState): GameRecord {
  const box: GameRecord["box"] = {};
  for (const u of e.units) if (u.pid) box[u.pid] = { k: u.k, d: u.d, a: u.a, cs: Math.round(u.cs), champ: u.champ.id };
  const win = e.winner ?? 0;
  const mvpU = e.units.filter((u) => u.side === win).sort((a, b) => (b.k * 3 + b.a * 1.5 - b.d + b.dmg / 3000) - (a.k * 3 + a.a * 1.5 - a.d + a.dmg / 3000))[0];
  return {
    blue: d.blue, red: d.red, winner: win === 0 ? d.blue : d.red, duration: Math.round(e.t), kills: [e.kills[0], e.kills[1]],
    gold: [e.gold(0), e.gold(1)],
    picks: { blue: ROLES.map((r) => d.picks.blue[r]!), red: ROLES.map((r) => d.picks.red[r]!) },
    bans: { blue: d.bans.blue, red: d.bans.red }, mvp: mvpU?.pid || null, box,
  };
}

export function makeEngine(d: DraftState, tactic: Tactic, userSide: 0 | 1 | null, seed: number, strategy?: Strategy): Engine {
  const s = S();
  const t: [Tactic, Tactic] = ["standard", "standard"];
  if (userSide !== null) t[userSide] = tactic;
  // the user's side plays the plan the coach picked; the AI side picks its own from roster and draft
  const st: [Strategy | null, Strategy | null] = [null, null];
  if (userSide !== null && strategy) st[userSide] = strategy;
  return new Engine({ s, data: D(), blue: d.blue, red: d.red, picks: { blue: d.picks.blue, red: d.picks.red }, seed, tactic: t, strategy: st, loadout: [d.loadout?.blue, d.loadout?.red] });
}

/** Pre-game picker for the coach's game plan. */
export function StrategyPicker({ value, onPick }: { value: Strategy; onPick: (st: Strategy) => void }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div class="row" style={{ flexWrap: "wrap" }}>
        <span>운영 방식:</span>
        {STRATEGIES.map((st) => <button class={`btn small ${value === st ? "on" : ""}`} title={STRATEGY_DESC[st]} onClick={() => onPick(st)}>{STRATEGY_KO[st]}</button>)}
      </div>
      <div class="muted" style={{ fontSize: 11 }}>{STRATEGY_DESC[value]} 경기 전에 정하며, 경기 중에는 바꿀 수 없습니다.</div>
    </div>
  );
}

export function SeriesScreen() {
  const s = S();
  const sr = userSeriesToday(s) ?? (live ? s.series.find((x) => x.id === live!.srId) : undefined);
  const [, setV] = useState(0);
  const bump = () => setV((v) => v + 1);
  if (!sr) {
    return (
      <div class="frame pad">
        <h2>오늘은 우리 경기가 없습니다</h2>
        <button class="btn" onClick={() => store.go("home")}>홈으로</button>
      </div>
    );
  }
  if (!live || live.srId !== sr.id) live = { srId: sr.id, phase: "pre", blue: sr.a!, red: sr.b!, draft: null, engine: null, tactic: "standard", strategy: lastStrategy };
  const L = live;
  const need = Math.ceil(sr.bo / 2);
  const over = sr.wa >= need || sr.wb >= need;
  const opp = sr.a === s.user ? sr.b! : sr.a!;
  const userSide: 0 | 1 = L.blue === s.user ? 0 : 1;
  const seedBase = (s.seed ^ (sr.day * 131) ^ (sr.games.length * 7919)) >>> 0;

  const startDraft = () => {
    L.draft = newDraft(L.blue, L.red, fearlessOf(sr));
    L.phase = "draft";
    bump();
  };
  const quickGame = () => {
    const d = newDraft(L.blue, L.red, fearlessOf(sr));
    autoDraft(s, D(), d, new Rng(seedBase));
    L.draft = d;
    const e = makeEngine(d, L.tactic, userSide, seedBase + 1, L.strategy);
    e.runToEnd();
    finishGame(e, d);
  };
  const finishGame = (e: Engine, d: DraftState) => {
    const rec = recordFromEngine(e, d);
    sr.games.push(rec);
    if (rec.winner === sr.a) sr.wa++;
    else sr.wb++;
    L.last = rec;
    L.engine = null;
    // loser of the game has first selection next game and takes blue side (AI) or chooses (user)
    const loser = rec.winner === sr.a ? sr.b! : sr.a!;
    if (loser !== s.user) {
      L.blue = loser;
      L.red = loser === sr.a ? sr.b! : sr.a!;
    }
    const doneNow = sr.wa >= need || sr.wb >= need;
    L.phase = doneNow ? "done" : "post";
    if (L.skipAll && !doneNow) {
      L.phase = "pre";
      quickGame();
      return;
    }
    autosave();
    bump();
  };
  const finishSeries = () => {
    closeUserSeries(s, D(), sr);
    live = null;
    autosave();
    store.go("home");
  };

  const header = (
    <div class="frame pad score" style={{ marginBottom: 8 }}>
      <div class="row" style={{ justifyContent: "flex-end" }}><b style={{ fontSize: 16 }}>{s.teams[sr.a!].name}</b><TeamLogo id={sr.a} size={44} /></div>
      <div class="center">
        <div class="muted">{COMP_NAME[sr.comp]} · {stageName(sr.stage)} · Bo{sr.bo}</div>
        <div class="k">{sr.wa} : {sr.wb}</div>
        <div class="muted" style={{ fontSize: 11 }}>{fearlessOf(sr).length ? `피어리스: 이번 시리즈에서 쓴 챔피언 ${fearlessOf(sr).length}개 사용 불가` : "하드 피어리스 드래프트"}</div>
      </div>
      <div class="row"><TeamLogo id={sr.b} size={44} /><b style={{ fontSize: 16 }}>{s.teams[sr.b!].name}</b></div>
    </div>
  );

  if (L.phase === "draft" && L.draft) return <div>{header}<DraftView d={L.draft} userSide={userSide === 0 ? "blue" : "red"} onDone={(go) => { if (go === "skip") { const e = makeEngine(L.draft!, L.tactic, userSide, seedBase + 1, L.strategy); e.runToEnd(); finishGame(e, L.draft!); } else { L.engine = makeEngine(L.draft!, L.tactic, userSide, seedBase + 1, L.strategy); L.phase = "match"; bump(); } }} /></div>;
  if (L.phase === "match" && L.engine && L.draft) {
    // the broadcast scorebar carries the series (pips, label), so the series header is not shown during the game
    const sub: Record<string, string> = {};
    const reg = sr.comp === "REG" || sr.comp === "REG2";
    const tbl = reg ? standings(s, sr.comp === "REG2" ? ["REG", "REG2"] : [sr.comp], sr.season) : [];
    for (const id of [sr.a!, sr.b!]) {
      const i = tbl.findIndex((x) => x.team === id);
      sub[id] = i >= 0 ? `LCK ${i + 1}위 · ${tbl[i].w}승 ${tbl[i].l}패` : s.teams[id].region;
    }
    const fl = fearlessOf(sr).length;
    const series: SeriesInfo = {
      teams: [sr.a!, sr.b!], wins: [sr.wa, sr.wb], bo: sr.bo, sub,
      label: `${COMP_NAME[sr.comp]} · ${stageName(sr.stage)}`,
      game: `${sr.games.length + 1}세트 · Bo${sr.bo}`,
      note: fl ? `피어리스: 챔피언 ${fl}개 사용 불가` : "하드 피어리스 드래프트",
    };
    return <div><MatchView e={L.engine} userSide={userSide} series={series} tactic={L.tactic} setTactic={(t) => { L.tactic = t; L.engine!.tactic[userSide] = t; }} onEnd={() => finishGame(L.engine!, L.draft!)} /></div>;
  }

  const pWin = seriesWinProb(0.5, sr.bo);
  return (
    <div>
      {header}
      {(L.phase === "post" || L.phase === "done") && L.last && <GameResult g={L.last} />}
      {L.phase === "done" ? (
        <div class="frame pad center">
          <h1 class={sr.wa > sr.wb === (sr.a === s.user) ? "gold" : "neg"}>{(sr.wa > sr.wb) === (sr.a === s.user) ? "시리즈 승리" : "시리즈 패배"}</h1>
          <button class="btn primary" onClick={finishSeries}>마치고 돌아가기</button>
        </div>
      ) : (
        <div class="grid2">
          <div class="frame pad">
            <h2>{sr.games.length + 1}세트 준비</h2>
            <div class="row">
              <span>진영:</span>
              <b style={{ color: "var(--blue)" }}>블루 {s.teams[L.blue].short}</b> / <b style={{ color: "var(--red)" }}>레드 {s.teams[L.red].short}</b>
            </div>
            {(sr.games.length === 0 ? sr.a === s.user : sr.games[sr.games.length - 1].winner !== s.user) && (
              <div class="row">
                <span class="muted">우리가 진영 선택권을 가졌습니다:</span>
                <button class={`btn small ${L.blue === s.user ? "on" : ""}`} onClick={() => { L.blue = s.user; L.red = opp; bump(); }}>블루 (먼저 픽)</button>
                <button class={`btn small ${L.red === s.user ? "on" : ""}`} onClick={() => { L.red = s.user; L.blue = opp; bump(); }}>레드 (마지막 픽)</button>
              </div>
            )}
            <div class="row" style={{ marginTop: 6 }}>
              <span>작전:</span>
              {(["aggressive", "standard", "safe"] as Tactic[]).map((t) => <button class={`btn small ${L.tactic === t ? "on" : ""}`} onClick={() => { L.tactic = t; bump(); }}>{t === "aggressive" ? "공격적" : t === "standard" ? "표준" : "안정적"}</button>)}
            </div>
            <div class="muted" style={{ fontSize: 11 }}>공격적: 교전·오브젝트 싸움을 자주 겁니다. 안정적: 불리한 싸움을 피합니다. 경기 중에도 바꿀 수 있습니다.</div>
            <StrategyPicker value={L.strategy} onPick={(st) => { L.strategy = st; lastStrategy = st; bump(); }} />
            <div class="row" style={{ marginTop: 10 }}>
              <button class="btn primary" onClick={startDraft}>밴픽 시작</button>
              <button class="btn" onClick={quickGame}>이 세트 결과만 보기</button>
              <button class="btn" onClick={() => { L.skipAll = true; quickGame(); }}>시리즈 끝까지 결과만</button>
            </div>
          </div>
          <div class="frame pad">
            <h2>양 팀 라인업</h2>
            {ROLES.map((r) => {
              const a = lineupOf(s, L.blue)[r], b = lineupOf(s, L.red)[r];
              return (
                <div class="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ width: 120 }}>{a?.name ?? "-"}</span>
                  <span class="tag">{ROLE_KO[r]}</span>
                  <span style={{ width: 120, textAlign: "right" }}>{b?.name ?? "-"}</span>
                </div>
              );
            })}
            <div class="muted" style={{ marginTop: 6 }}>라인업은 선수단 화면에서 바꿉니다. <button class="btn small" onClick={() => store.go("roster")}>선수단</button></div>
            <div class="dim" style={{ fontSize: 11 }}>{pWin ? "" : ""}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function GameResult({ g }: { g: GameRecord }) {
  const s = S();
  const rows = (team: string, champs: string[]) => ROLES.map((r, i) => {
    const pid = s.teams[team].lineup[r];
    const b = pid ? g.box?.[pid] : undefined;
    return (
      <tr>
        <td><ChampIcon id={champs[i]} size={26} /></td>
        <td>{pid ? s.players[pid].name : "-"} {g.mvp === pid && <span class="tag gold">MVP</span>}</td>
        <td class="num">{b ? `${b.k}/${b.d}/${b.a}` : ""}</td>
        <td class="num muted">{b?.cs}</td>
      </tr>
    );
  });
  return (
    <div class="frame pad">
      <h2>{s.teams[g.winner].name} 승리 · {Math.floor(g.duration / 60)}분 · {g.kills[0]} : {g.kills[1]}</h2>
      <div class="grid2">
        <table class="t"><thead><tr><th colSpan={4} style={{ color: "var(--blue)" }}>블루 {s.teams[g.blue].name} · 골드 {(g.gold[0] / 1000).toFixed(1)}k</th></tr></thead><tbody>{rows(g.blue, g.picks.blue)}</tbody></table>
        <table class="t"><thead><tr><th colSpan={4} style={{ color: "var(--red)" }}>레드 {s.teams[g.red].name} · 골드 {(g.gold[1] / 1000).toFixed(1)}k</th></tr></thead><tbody>{rows(g.red, g.picks.red)}</tbody></table>
      </div>
    </div>
  );
}

// ---------------- draft ----------------
export function DraftView({ d, userSide, onDone, auto }: { d: DraftState; userSide: Side; onDone: (mode: "watch" | "skip") => void; auto?: boolean }) {
  const s = S();
  const data = D();
  const [, setV] = useState(0);
  const bump = () => setV((v) => v + 1);
  const [roleF, setRoleF] = useState<Role | "">("");
  const [q, setQ] = useState("");
  const [selRole, setSelRole] = useState<Role | null>(null);
  const rng = useMemo(() => new Rng((s.seed ^ d.step * 977 ^ s.day) >>> 0), [d]);
  const st = currentStep(d);
  const myTurn = !!st && !auto && st[0] === userSide;
  // AI steps play out with a short delay so the draft can be followed
  useEffect(() => {
    if (!st || myTurn) return;
    const id = setTimeout(() => { aiStep(s, data, d, rng); bump(); }, 550);
    return () => clearTimeout(id);
  });
  const blocked = unavailable(d);
  const myTeam = userSide === "blue" ? d.blue : d.red;
  const lu = lineupOf(s, myTeam);
  const open = openRoles(d, userSide);
  const role = selRole && open.includes(selRole) ? selRole : open[0];
  const sug = useMemo(() => (st && myTurn ? coachSuggestions(s, data, d, userSide, rng) : { coach: null, items: [] }), [d.step, myTurn]);
  const sugIds = new Set(sug.items.map((x) => x.champ.id));
  let list = data.champions;
  if (roleF) list = list.filter((c) => (c.roles[roleF] ?? 0) >= 0.1);
  if (q) list = list.filter((c) => c.name.includes(q) || c.nameEn.toLowerCase().includes(q.toLowerCase()));
  const tierRank = (id: string) => { const t = metaTier(s, id); return t === "S" ? 0 : t === "A" ? 1 : t === "N" ? 3 : 2; };
  const shown = [...list].sort((a, b) => tierRank(a.id) - tierRank(b.id) || b.pro.presence - a.pro.presence || a.name.localeCompare(b.name, "ko"));
  /** `forRole`: a coach suggestion names the slot it is for (an open one), which wins over the selected slot */
  const choose = (c: ChampionData, forRole?: Role | null) => {
    if (!st || !myTurn || blocked.has(c.id)) return;
    if (st[1] === "pick") {
      let r = forRole && open.includes(forRole) ? forRole : role;
      if ((c.roles[r] ?? 0) < 0.03) {
        const best = open.slice().sort((x, y) => (c.roles[y] ?? 0) - (c.roles[x] ?? 0))[0];
        if (best && (c.roles[best] ?? 0) >= 0.03) r = best;
      }
      applyStep(d, c.id, r);
    } else applyStep(d, c.id);
    setSelRole(null);
    bump();
  };
  const side = (sd: Side) => {
    const team = sd === "blue" ? d.blue : d.red;
    const lup = lineupOf(s, team);
    const active = st && st[0] === sd;
    return (
      <div class="frame pad" style={{ boxShadow: active ? `0 0 0 2px ${sd === "blue" ? "var(--blue)" : "var(--red)"}` : undefined }}>
        <div class="row" style={{ justifyContent: "space-between" }}>
          <div class="row"><TeamLogo id={team} size={26} /><b style={{ color: sd === "blue" ? "var(--blue)" : "var(--red)" }}>{s.teams[team].short}</b></div>
          <span class="muted" style={{ fontSize: 11 }}>{sd === "blue" ? "블루" : "레드"}</span>
        </div>
        <div class="banrow" style={{ margin: "6px 0" }}>
          {[0, 1, 2, 3, 4].map((i) => <div class={`b ${d.bans[sd][i] ? "" : "empty"}`}>{d.bans[sd][i] && <ChampIcon id={d.bans[sd][i]} size={30} />}</div>)}
        </div>
        {ROLES.map((r) => {
          const c = d.picks[sd][r];
          const p = lup[r];
          const isMine = sd === userSide;
          const selectable = isMine && myTurn && st?.[1] === "pick" && !c;
          return (
            <div class={`slot frame dark ${c ? "" : "empty"} ${selectable && role === r ? "active" : ""}`} style={{ cursor: selectable ? "pointer" : "default" }} onClick={() => selectable && setSelRole(r)}>
              {c ? <ChampIcon id={c} size={44} /> : <span style={{ width: 44, height: 44, background: "#0b0d14", display: "inline-block" }} />}
              <div>
                <div class="muted" style={{ fontSize: 11 }}>{ROLE_KO[r]}</div>
                <b>{p?.name ?? "-"}</b>
                <div style={{ fontSize: 11 }}>{c ? `${data.champ.get(c)?.name} · 숙련 ${Math.round(mastery(p, data.champ.get(c)!))}` : selectable && role === r ? "← 이 자리에 픽" : ""}</div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };
  const done = !st;
  const prob = done ? draftWinProb(s, data, d) : 0;
  const userProb = userSide === "blue" ? prob : 1 - prob;
  return (
    <div class="grid3" style={{ gridTemplateColumns: "250px 1fr 250px" }}>
      {side("blue")}
      <div class="frame pad">
        {!done ? (
          <>
            <div class="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>
                <span style={{ color: st![0] === "blue" ? "var(--blue)" : "var(--red)" }}>{st![0] === "blue" ? "블루" : "레드"}</span>{" "}
                {st![1] === "ban" ? "밴" : "픽"} <span class="muted" style={{ fontSize: 12 }}>({d.step + 1}/{DRAFT_ORDER.length})</span>
              </h2>
              <span class={myTurn ? "gold" : "muted"}>{myTurn ? (st![1] === "pick" ? `우리 차례: ${ROLE_KO[role]} 픽` : "우리 차례: 밴") : "상대가 고르는 중..."}</span>
            </div>
            <div class="row" style={{ margin: "6px 0" }}>
              <button class={`btn small ${roleF === "" ? "on" : ""}`} onClick={() => setRoleF("")}>전체</button>
              {ROLES.map((r) => <button class={`btn small ${roleF === r ? "on" : ""}`} onClick={() => setRoleF(r)}>{ROLE_KO[r]}</button>)}
              <input type="text" placeholder="챔피언 검색" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ width: 120 }} />
              {myTurn && <button class="btn small" onClick={() => { aiStep(s, data, d, rng); bump(); }}>추천대로</button>}
            </div>
            <div class="cgrid">
              {shown.map((c) => {
                const off = blocked.has(c.id);
                const fear = d.fearless.has(c.id);
                const p = myTurn && st![1] === "pick" ? lu[role] : undefined;
                const m = p ? p.mastery[c.id] : undefined;
                return (
                  <div class={`cbox ${off ? "off" : ""} ${fear ? "fear" : ""} ${sugIds.has(c.id) && !off ? "sug" : ""}`} onClick={() => choose(c)} title={`${c.name} · 출현율 ${Math.round(c.pro.presence * 100)}%`}>
                    <ChampIcon id={c.id} size={52} />
                    {m !== undefined && !off && <span class="m">{Math.round(m)}</span>}
                    {metaTier(s, c.id) && <span class={`tier t${metaTier(s, c.id)}`}>{META_LABEL[metaTier(s, c.id)!]}</span>}
                    {c.name}
                  </div>
                );
              })}
            </div>
            {/* always the same height and one line, so the board does not jump between turns */}
            <div class="frame dark pad sug-panel">
              <h3>{!myTurn ? "감독 추천" : sug.coach ? `감독 ${sug.coach}의 추천` : "감독이 없어 추천이 거의 없습니다"}{myTurn ? ` (${sug.items.length}개)` : ""}</h3>
              <div class="sug-row">
                {myTurn ? sug.items.map((x) => (
                  <div class="sug-item" title={`${x.champ.name} · ${x.role ? ROLE_KO[x.role] + " · " : ""}${x.why}`} onClick={() => choose(x.champ, x.role)}>
                    <ChampIcon id={x.champ.id} size={28} />
                    <span>{x.champ.name}<br /><span class="muted">{x.role ? ROLE_KO[x.role] + " · " : ""}{x.why}</span></span>
                  </div>
                )) : <span class="muted" style={{ fontSize: 11 }}>상대 차례에는 추천이 없습니다.</span>}
              </div>
            </div>
          </>
        ) : (
          <>
            <h2>밴픽 완료</h2>
            <CompCompare d={d} />
            {!auto && <LoadoutPicker d={d} side={userSide} onChange={bump} />}
            <div class="center" style={{ margin: "10px 0" }}>
              우리 예상 승률 <b class="gold" style={{ fontSize: 20 }}>{Math.round(userProb * 100)}%</b> <span class="muted">({oddsWord(userProb)})</span>
            </div>
            <div class="row" style={{ justifyContent: "center" }}>
              <button class="btn primary" onClick={() => onDone("watch")}>경기 시작</button>
              <button class="btn" onClick={() => onDone("skip")}>결과만 보기</button>
            </div>
          </>
        )}
      </div>
      {side("red")}
    </div>
  );
}

function CompCompare({ d }: { d: DraftState }) {
  const data = D();
  const a = compProfile(data, d.picks.blue), b = compProfile(data, d.picks.red);
  return (
    <div>
      <div class="row" style={{ justifyContent: "space-between" }}><span style={{ color: "var(--blue)" }}>블루 AD {a.ad} · AP {a.ap}</span><span style={{ color: "var(--red)" }}>레드 AD {b.ad} · AP {b.ap}</span></div>
      {COMP_KEYS.map((k) => (
        <div class="row" style={{ gap: 6 }}>
          <div style={{ flex: 1, transform: "scaleX(-1)" }}><Bar v={a.prof[k]} max={10} color="#4aa3ff" /></div>
          <span style={{ width: 60, textAlign: "center", fontSize: 12 }}>{STYLE_KO[k]}</span>
          <div style={{ flex: 1 }}><Bar v={b.prof[k]} max={10} color="#ff5a5a" /></div>
        </div>
      ))}
    </div>
  );
}

// ---------------- match ----------------
const SPEEDS = [1, 2, 4, 8, 16];
/** Game seconds a teamfight keeps running in real time after it ends, so the last kills and spells play out. */
const REAL_AFTER = 2;
/** objectives taken: shown as banners like kills, whether or not the engine marks them big */
const OBJ_TAKEN = new Set<GameEvent["type"]>(["dragon", "soul", "elder", "grubs", "herald", "baron"]);

const BIG_ICON: Partial<Record<GameEvent["type"], string>> = {
  first_blood: "퍼스트 블러드", solo: "솔로 킬", double: "더블 킬", triple: "트리플 킬", quadra: "쿼드라 킬", penta: "펜타 킬",
  ace: "에이스", steal: "스틸!", baron: "바론", soul: "드래곤의 영혼", elder: "장로 드래곤", inhib: "억제기", first_turret: "첫 포탑", nexus: "승리",
};

export function MatchView({ e, userSide, series, tactic, setTactic, onEnd }: { e: Engine; userSide: 0 | 1; series?: SeriesInfo; tactic: Tactic; setTactic: (t: Tactic) => void; onEnd: () => void }) {
  const s = S();
  const data = D();
  const canvas = useRef<HTMLCanvasElement>(null);
  const rend = useRef<MatchRenderer | null>(null);
  const [speed, setSpeed] = useState(2);
  const [paused, setPaused] = useState(false);
  const [cam, setCam] = useState<CamMode>("auto");
  const [slowmo, setSlowmo] = useState(true);
  const [tac, setTac] = useState(tactic);
  const [, setTick] = useState(0);
  const [banners, setBanners] = useState<{ id: number; ev: GameEvent; spawn?: boolean }[]>([]);
  const evSeen = useRef(0);
  /** objectives alive at the last UI tick: a change to alive is a spawn banner (also covers the elder dragon) */
  const objAlive = useRef<Partial<Record<ObjKey, boolean>>>({});
  const st = useRef({ speed, paused, slowmo });
  st.current = { speed, paused, slowmo };
  /** true while a teamfight is playing in real time (set by the match loop) */
  const realTime = useRef(false);
  useEffect(() => {
    const r = new MatchRenderer(canvas.current!, e, data.ddVersion, userSide);
    rend.current = r;
    let last = performance.now();
    let acc = 0;
    let raf = 0;
    let uiT = 0;
    // a teamfight (what the broadcast calls 한타): one fight with four or more champions from both teams.
    // While one is on, and for a moment after so the kills land, the game runs in real time: 1 s of game per 1 s.
    const teamfight = () => {
      for (const id of e.fights.keys()) {
        let n = 0, sides = 0;
        for (const u of e.units) if (u.alive && u.fightId === id) { n++; sides |= 1 << u.side; }
        if (n >= 4 && sides === 3) return true;
      }
      return false;
    };
    let realUntil = -1;
    const loop = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (!st.current.paused && !e.over) {
        let gps = 8 * st.current.speed; // game seconds per real second; 1x = 8
        if (st.current.slowmo && teamfight()) realUntil = e.t + REAL_AFTER;
        realTime.current = st.current.slowmo && e.t < realUntil;
        if (realTime.current) gps = 1;
        acc += (dt / 1000) * gps;
        let steps = 0;
        while (acc >= 0.25 && steps < 400) {
          r.beforeStep();
          e.step();
          acc -= 0.25;
          steps++;
          // a teamfight that starts in the middle of a fast frame: the rest of this frame already runs in real time,
          // so the engage and the first kills are not fast-forwarded
          if (!realTime.current && st.current.slowmo && teamfight()) {
            realUntil = e.t + REAL_AFTER;
            realTime.current = true;
            acc /= gps; // the leftover real time, now at 1 game second per second
            gps = 1;
          }
        }
        r.lerp = Math.min(1, acc / 0.25);
      }
      r.draw(now);
      if (now - uiT > 200) {
        uiT = now;
        setTick((x) => x + 1);
        const evs = e.events;
        const add: { id: number; ev: GameEvent; spawn?: boolean }[] = [];
        // objectives that just spawned (the engine has no event for every one of them, e.g. the elder dragon)
        for (const k of Object.keys(e.obj) as ObjKey[]) {
          const o = e.obj[k];
          const was = objAlive.current[k];
          objAlive.current[k] = o.alive;
          if (o.alive && was === false && e.t > 1) {
            const name = k === "dragon" && o.type ? `${o.type} 드래곤` : OBJ_KO[k];
            add.push({ id: now + add.length, ev: { t: e.t, type: "info", side: 0, text: `${name} 등장`, big: false }, spawn: true });
          }
        }
        if (evs.length > evSeen.current) {
          // big plays, and every objective taken (like kills)
          const fresh = evs.slice(evSeen.current).filter((x) => x.big || OBJ_TAKEN.has(x.type));
          evSeen.current = evs.length;
          for (const ev of fresh.slice(-2)) add.push({ id: now + 10 + add.length, ev });
        }
        if (add.length) setBanners((b) => [...b, ...add].slice(-3));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [e]);
  useEffect(() => {
    if (!banners.length) return;
    const id = setTimeout(() => setBanners((b) => b.slice(1)), 2700);
    return () => clearTimeout(id);
  }, [banners]);
  useEffect(() => { if (rend.current) rend.current.mode = cam; }, [cam]);
  const skipToEnd = () => {
    e.runToEnd();
    rend.current?.syncFx();
    if (rend.current) rend.current.lerp = 1; // the jump to the end is not something to glide through
    setTick((x) => x + 1);
  };
  const team = (side: 0 | 1) => (
    <div class="frame pad" style={{ padding: 6 }}>
      <div class="row" style={{ justifyContent: "space-between" }}>
        <span class="row" style={{ gap: 4 }}><TeamLogo id={e.teamIds[side]} size={20} /><b style={{ color: side ? "var(--red)" : "var(--blue)" }}>{s.teams[e.teamIds[side]].short}</b></span>
        <span class="muted" style={{ fontSize: 11 }}>{(e.gold(side) / 1000).toFixed(1)}k</span>
      </div>
      {e.units.filter((u) => u.side === side).map((u) => (
        <div class={`pl ${u.alive ? "" : "dead"}`} style={{ cursor: "pointer" }} onClick={() => { if (rend.current) { rend.current.followIdx = u.i; setCam("follow"); } }}>
          <div class="pl-face"><ChampIcon id={u.champ.id} size={38} /><RuneBadge e={e} u={u} /></div>
          <div>
            <div class="nm"><b style={{ fontSize: 12 }}>{u.name}</b><span class="muted" style={{ fontSize: 11 }}>Lv{u.level}</span></div>
            <div style={{ fontSize: 11 }}>{u.k}/{u.d}/{u.a} · CS {Math.round(u.cs)}{!u.alive && <span class="neg"> · {Math.ceil(u.respawnAt - e.t)}초</span>}</div>
            <div class="hp"><i style={{ width: `${(u.hp / u.maxHp) * 100}%`, background: side ? "#ff6b6b" : "#5ad07a" }} /></div>
          </div>
          <ItemStrip e={e} u={u} />
        </div>
      ))}
    </div>
  );
  const timers = e.timers();
  const campTimers = e.camps.filter((c) => !c.alive && c.spawnAt - e.t < 300 && (c.kind === "blue" || c.kind === "red" || c.kind === "scuttle"));
  return (
    <div>
      <Scorebar e={e} series={series} />
      <div class="match">
        {team(0)}
        <div>
          <div class="frame board">
            <canvas ref={canvas} class="px" />
            <div class="live-tag"><i />{cam === "auto" ? `LIVE · ${rend.current?.shotLabel ?? ""}` : "LIVE"}</div>
            {realTime.current && !paused && !e.over && <div class="live-tag" style={{ top: 34, color: "#ffd36b" }}>한타 · 실제 속도</div>}
            {(() => {
              // why the broadcast camera just cut here (auto camera only)
              const c = cam === "auto" ? rend.current?.cut : null;
              if (!c || performance.now() - c.at > CAPTION_MS) return null;
              return <div class="cut-caption" key={c.at}><span>{c.text}</span></div>;
            })()}
            <div class="banner-wrap">
              {banners.map(({ id, ev, spawn }) => {
                const a = ev.actor !== undefined ? e.units[ev.actor] : null;
                const v = ev.victim !== undefined ? e.units[ev.victim] : null;
                const mega = ["penta", "quadra", "ace", "steal", "nexus", "soul"].includes(ev.type);
                if (spawn) {
                  return (
                    <div key={id} class="banner obj-spawn">
                      <span class="obj-tag">등장</span>
                      <span>{ev.text.replace(/ 등장$/, "")}</span>
                    </div>
                  );
                }
                if (OBJ_TAKEN.has(ev.type)) {
                  // "T1, 화염 드래곤 처치 (2스택)" -> team, then what was taken
                  const what = ev.text.replace(/^[^,]+,\s*/, "").replace(/!$/, "");
                  return (
                    <div key={id} class={`banner ${ev.side ? "red" : "blue"} ${mega ? "mega" : ""}`}>
                      {a && <ChampIcon id={a.champ.id} size={32} />}
                      <span class="obj-team">{e.names[ev.side]}</span>
                      <span>{what}</span>
                    </div>
                  );
                }
                return (
                  <div key={id} class={`banner ${ev.side ? "red" : "blue"} ${mega ? "mega" : ""}`}>
                    {a && <ChampIcon id={a.champ.id} size={32} />}
                    <span>{BIG_ICON[ev.type] ?? ""}</span>
                    {v && <><span class="muted">→</span><ChampIcon id={v.champ.id} size={32} /></>}
                  </div>
                );
              })}
            </div>
            {e.over && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", background: "rgba(5,6,12,0.6)" }}>
                <div class="title-logo" style={{ fontSize: 40, color: e.winner === userSide ? "#f2c14e" : "#ff6b6b" }}>{e.winner === userSide ? "VICTORY" : "DEFEAT"}</div>
                <button class="btn primary" onClick={onEnd}>결과 확인</button>
              </div>
            )}
          </div>
          <div class="row" style={{ justifyContent: "center", marginTop: 6 }}>
            {([["auto", "중계"], ["all", "전체"], ["top", "탑"], ["jungle", "정글"], ["mid", "미드"], ["bot", "바텀"]] as [CamMode, string][]).map(([k, l]) => (
              <button class={`btn small ${cam === k ? "on" : ""}`} onClick={() => { if (k === "jungle" && rend.current) rend.current.followIdx = e.units.find((u) => u.side === userSide && u.role === "Jungle")!.i; setCam(k); }}>{l}</button>
            ))}
            <span style={{ width: 10 }} />
            <button class="btn small" onClick={() => setPaused(!paused)}>{paused ? "▶" : "❚❚"}</button>
            {SPEEDS.map((x) => <button class={`btn small ${speed === x ? "on" : ""}`} title={`실제 경기 시간의 ${8 * x}배 빠르기 (귀환 8초가 ${(8 / (8 * x)).toFixed(x >= 4 ? 2 : 1)}초)`} onClick={() => setSpeed(x)}>{x}x</button>)}
            <button class={`btn small ${slowmo ? "on" : ""}`} onClick={() => setSlowmo(!slowmo)} title="양 팀 4명 이상이 붙는 한타는 고른 배속과 상관없이 실제 게임 속도(게임 1초 = 실제 1초)로 보여 줍니다. 끝난 뒤 2초까지.">한타 실시간</button>
            <button class="btn small" onClick={skipToEnd}>끝까지</button>
            <span class="muted" style={{ fontSize: 10 }}>{speed}x = 실제의 {8 * speed}배</span>
          </div>
          <div class="row" style={{ justifyContent: "center" }}>
            <span class="muted">작전</span>
            {(["aggressive", "standard", "safe"] as Tactic[]).map((t) => <button class={`btn small ${tac === t ? "on" : ""}`} onClick={() => { setTac(t); setTactic(t); }}>{t === "aggressive" ? "공격적" : t === "standard" ? "표준" : "안정적"}</button>)}
          </div>
          <div class="row muted" style={{ justifyContent: "center", fontSize: 11 }}>
            운영: <b style={{ color: "var(--blue)" }}>{STRATEGY_KO[e.strategy[0]]}</b> vs <b style={{ color: "var(--red)" }}>{STRATEGY_KO[e.strategy[1]]}</b>
            {ENGINE_FLAGS.macro && <span style={{ marginLeft: 8 }}><span style={{ color: "var(--blue)" }}>{planLabel(e, 0) || "-"}</span> · <span style={{ color: "var(--red)" }}>{planLabel(e, 1) || "-"}</span></span>}
          </div>
        </div>
        {team(1)}
      </div>
      <div class="grid2" style={{ marginTop: 6 }}>
        <div class="frame pad">
          <h3>오브젝트 타이머</h3>
          <div class="timers">
            {timers.map((t) => (
              <span class={`tm ${t.alive ? "up" : ""}`}>
                {t.label} {t.alive ? "등장" : t.at === null ? "—" : t.at > e.t ? fmtClock(t.at - e.t) : ""}
              </span>
            ))}
          </div>
          <h3 style={{ marginTop: 6 }}>정글 리젠</h3>
          <div class="timers">
            {campTimers.length ? campTimers.map((c) => <span class="tm">{c.side === 0 ? "블루팀" : "레드팀"} {c.kind === "blue" ? "블루" : c.kind === "red" ? "레드" : "바위게"} {fmtClock(c.spawnAt - e.t)}</span>) : <span class="muted" style={{ fontSize: 11 }}>모두 살아 있음 (맵을 확대하면 캠프마다 남은 시간이 보입니다)</span>}
          </div>
        </div>
        <div class="frame pad">
          <h3>경기 기록</h3>
          <div class="feed">
            {[...e.events].reverse().slice(0, 40).map((ev) => (
              <div style={{ color: ev.big ? (ev.side ? "#ff9a9a" : "#9ad0ff") : undefined }}><span class="dim">{fmtClock(ev.t)}</span> {ev.text}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
