// 코드 대전: paste roster codes made on other devices and play them against each other on this one.
import { useState } from "preact/hooks";
import { store, D } from "../../store";
import { buildExhibition, codeOvr, codeSummary, exportTeamCode, parseTeamCode } from "../../core/share";
import type { TeamCode } from "../../core/share";
import type { GameRecord } from "../../core/types";
import { ROLES, ROLE_KO } from "../../data/types";
import { Rng } from "../../core/rng";
import { autoDraft, lineupOf, newDraft } from "../../match/draft";
import type { DraftState } from "../../match/draft";
import type { Engine, Tactic } from "../../match/engine";
import { DraftView, GameResult, MatchView, StrategyPicker, makeEngine, recordFromEngine } from "./Series";
import type { Strategy } from "../../match/strategy";
import { TeamLogo } from "../components";
import type { SeriesInfo } from "../Scorebar";

interface ExLive {
  bo: 1 | 3 | 5;
  control: 0 | 1 | null; // index of the code the player drafts for (0 = A, 1 = B), null = watch only
  games: GameRecord[];
  wins: [number, number];
  phase: "pre" | "draft" | "match" | "post" | "done";
  blue: "EXA" | "EXB";
  draft: DraftState | null;
  engine: Engine | null;
  tactic: Tactic;
  /** the coach's game plan for the controlled side */
  strategy: Strategy;
  last?: GameRecord;
  seed: number;
}
let ex: ExLive | null = null;

function CodeBox({ label, value, onChange, parsed }: { label: string; value: string; onChange: (v: string) => void; parsed: ReturnType<typeof parseTeamCode> | null }) {
  return (
    <div class="col">
      <b>{label}</b>
      <textarea value={value} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} rows={4} placeholder="LCKM1-..." style={{ width: "100%", background: "#0d0f17", color: "var(--text)", border: 0, padding: 6, fontFamily: "Galmuri9, monospace", fontSize: 11 }} />
      {parsed && (parsed.ok ? (
        <div class="pos" style={{ fontSize: 12 }}>{parsed.code.name} (만든 사람 {parsed.code.manager || "이름 없음"}, {parsed.code.season} 시즌) · 평균 OVR {codeOvr(parsed.code)}<br /><span class="muted">{codeSummary(parsed.code)}</span></div>
      ) : <div class="neg" style={{ fontSize: 12 }}>{parsed.msg}</div>)}
    </div>
  );
}

export function ExhibitionScreen() {
  const [, setV] = useState(0);
  const bump = () => setV((v) => v + 1);
  const career = store.s;
  const [myCode, setMyCode] = useState("");
  const [useMine, setUseMine] = useState(!!career);
  const [codeA, setCodeA] = useState("");
  const [codeB, setCodeB] = useState("");
  const [bo, setBo] = useState<1 | 3 | 5>(3);
  const [control, setControl] = useState<0 | 1 | null>(career ? 0 : null);
  const parsedA = useMine ? null : codeA.trim() ? parseTeamCode(codeA) : null;
  const parsedB = codeB.trim() ? parseTeamCode(codeB) : null;
  const leave = () => {
    ex = null;
    store.exState = null;
    store.override = null;
    store.go(career ? "home" : "start");
  };

  if (!store.exState || !ex) {
    const aCode: TeamCode | null = useMine && career ? parseTeamCode(exportTeamCode(career, career.user)).ok ? (parseTeamCode(exportTeamCode(career, career.user)) as { ok: true; code: TeamCode }).code : null : parsedA?.ok ? parsedA.code : null;
    const bCode = parsedB?.ok ? parsedB.code : null;
    const start = () => {
      if (!aCode || !bCode) return;
      const seed = (Date.now() & 0x7fffffff) >>> 0;
      store.exState = buildExhibition(D(), [aCode, bCode], career?.meta, seed);
      ex = { bo, control, games: [], wins: [0, 0], phase: "pre", blue: "EXA", draft: null, engine: null, tactic: "standard", strategy: "balanced", seed };
      store.bump();
    };
    return (
      <div style={{ maxWidth: 1000 }}>
        <div class="row" style={{ justifyContent: "space-between" }}><h1>코드 대전</h1>{!career && <button class="btn small" onClick={leave}>시작 화면</button>}</div>
        <div class="muted" style={{ marginBottom: 8 }}>
          다른 기기에서 꾸린 팀을 코드로 받아 이 기기에서 경기를 붙입니다. 인터넷 연결이나 기기 연결은 필요 없습니다. 코드를 메신저 등으로 보내 붙여넣으면 됩니다.
          경기 결과는 커리어 세이브에 남지 않습니다.
        </div>
        {career && (
          <div class="frame pad">
            <h2>내 팀 코드 만들기</h2>
            <div class="muted" style={{ fontSize: 12 }}>{career.teams[career.user].name}의 주전 5명과 후보 최대 3명, 능력치, 챔피언 숙련도, 감독, 팀 합이 들어갑니다.</div>
            <div class="row">
              <button class="btn primary" onClick={() => setMyCode(exportTeamCode(career, career.user))}>코드 만들기</button>
              {myCode && <button class="btn" onClick={() => { navigator.clipboard?.writeText(myCode).then(() => store.say("코드를 복사했습니다"), () => store.say("직접 선택해서 복사해 주세요")); }}>복사</button>}
              {myCode && <span class="muted">{myCode.length}자</span>}
            </div>
            {myCode && <textarea readOnly value={myCode} rows={3} style={{ width: "100%", background: "#0d0f17", color: "var(--text)", border: 0, padding: 6, fontSize: 11 }} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />}
          </div>
        )}
        <div class="frame pad">
          <h2>대전 만들기</h2>
          <div class="grid2">
            <div class="col">
              {career && (
                <div class="row">
                  <button class={`btn small ${useMine ? "on" : ""}`} onClick={() => setUseMine(true)}>A팀 = 내 팀 ({career.teams[career.user].short})</button>
                  <button class={`btn small ${!useMine ? "on" : ""}`} onClick={() => setUseMine(false)}>A팀 = 코드</button>
                </div>
              )}
              {useMine && career ? <div class="pos">A팀: {career.teams[career.user].name} (지금 커리어 로스터)</div> : <CodeBox label="A팀 코드" value={codeA} onChange={setCodeA} parsed={parsedA} />}
            </div>
            <CodeBox label="B팀 코드" value={codeB} onChange={setCodeB} parsed={parsedB} />
          </div>
          <div class="row" style={{ marginTop: 8 }}>
            <span>경기 방식</span>
            {([1, 3, 5] as const).map((n) => <button class={`btn small ${bo === n ? "on" : ""}`} onClick={() => setBo(n)}>Bo{n}</button>)}
            <span style={{ width: 12 }} />
            <span>밴픽 조작</span>
            <button class={`btn small ${control === 0 ? "on" : ""}`} onClick={() => setControl(0)}>A팀</button>
            <button class={`btn small ${control === 1 ? "on" : ""}`} onClick={() => setControl(1)}>B팀</button>
            <button class={`btn small ${control === null ? "on" : ""}`} onClick={() => setControl(null)}>둘 다 자동 (관전)</button>
          </div>
          <div class="muted" style={{ fontSize: 11 }}>메타는 {career?.meta ? `이 기기 커리어의 현재 패치(${career.meta.patch})` : "대전마다 새로 정해지는 패치"}를 씁니다. 난이도 보정 없이 양쪽을 똑같이 계산합니다. 하드 피어리스가 적용됩니다.</div>
          <button class="btn primary" style={{ marginTop: 8 }} disabled={!aCode || !bCode} onClick={start}>대전 시작</button>
        </div>
      </div>
    );
  }

  // ---- the series ----
  const s = store.exState;
  const L = ex;
  const need = Math.ceil(L.bo / 2);
  const red: "EXA" | "EXB" = L.blue === "EXA" ? "EXB" : "EXA";
  const controlledId = L.control === null ? null : L.control === 0 ? "EXA" : "EXB";
  const userSide: 0 | 1 = controlledId === red ? 1 : 0;
  const fearless = L.games.flatMap((g) => [...g.picks.blue, ...g.picks.red]);
  const seed = (L.seed + L.games.length * 7919) >>> 0;
  const finishGame = (e: Engine, d: DraftState) => {
    const rec = recordFromEngine(e, d);
    L.games.push(rec);
    if (rec.winner === "EXA") L.wins[0]++;
    else L.wins[1]++;
    L.last = rec;
    L.engine = null;
    // the loser takes blue side next game
    L.blue = rec.winner === "EXA" ? "EXB" : "EXA";
    L.phase = L.wins[0] >= need || L.wins[1] >= need ? "done" : "post";
    bump();
  };
  const startDraft = () => {
    L.draft = newDraft(L.blue, red, fearless);
    L.phase = "draft";
    bump();
  };
  const quick = () => {
    const d = newDraft(L.blue, red, fearless);
    autoDraft(s, D(), d, new Rng(seed));
    L.draft = d;
    const e = makeEngine(d, L.tactic, controlledId ? userSide : null, seed + 1, L.strategy);
    e.runToEnd();
    finishGame(e, d);
  };
  const header = (
    <div class="frame pad score" style={{ marginBottom: 8 }}>
      <div class="row" style={{ justifyContent: "flex-end" }}><b style={{ fontSize: 16 }}>{s.teams.EXA.name}</b><TeamLogo id="EXA" size={44} /></div>
      <div class="center">
        <div class="muted">코드 대전 · Bo{L.bo}</div>
        <div class="k">{L.wins[0]} : {L.wins[1]}</div>
        <div class="muted" style={{ fontSize: 11 }}>패치 {s.meta?.patch} · 피어리스 잠금 {fearless.length}개</div>
      </div>
      <div class="row"><TeamLogo id="EXB" size={44} /><b style={{ fontSize: 16 }}>{s.teams.EXB.name}</b></div>
    </div>
  );
  if (L.phase === "draft" && L.draft) {
    return (
      <div>
        {header}
        <DraftView d={L.draft} userSide={userSide === 0 ? "blue" : "red"} auto={controlledId === null} onDone={(go) => {
          const e = makeEngine(L.draft!, L.tactic, controlledId ? userSide : null, seed + 1, L.strategy);
          if (go === "skip") { e.runToEnd(); finishGame(e, L.draft!); }
          else { L.engine = e; L.phase = "match"; bump(); }
        }} />
      </div>
    );
  }
  if (L.phase === "match" && L.engine && L.draft) {
    const series: SeriesInfo = {
      teams: ["EXA", "EXB"], wins: L.wins, bo: L.bo,
      label: "코드 대전",
      game: `${L.games.length + 1}세트 · Bo${L.bo}`,
      note: `패치 ${s.meta?.patch} · 피어리스 잠금 ${fearless.length}개`,
      sub: { EXA: s.teams.EXA.name, EXB: s.teams.EXB.name },
    };
    return <div><MatchView e={L.engine} userSide={userSide} series={series} tactic={L.tactic} setTactic={(t) => { L.tactic = t; if (controlledId) L.engine!.tactic[userSide] = t; }} onEnd={() => finishGame(L.engine!, L.draft!)} /></div>;
  }
  return (
    <div>
      {header}
      {L.last && <GameResult g={L.last} />}
      {L.phase === "done" ? (
        <div class="frame pad center">
          <h1 class="gold">{L.wins[0] > L.wins[1] ? s.teams.EXA.name : s.teams.EXB.name} 승리</h1>
          <div class="row" style={{ justifyContent: "center" }}>
            <button class="btn primary" onClick={() => { ex = { ...L, games: [], wins: [0, 0], phase: "pre", blue: "EXA", last: undefined, seed: L.seed + 101 }; bump(); }}>같은 팀으로 다시</button>
            <button class="btn" onClick={() => { ex = null; store.exState = null; store.override = null; store.bump(); }}>새 대전</button>
            <button class="btn" onClick={leave}>나가기</button>
          </div>
        </div>
      ) : (
        <div class="grid2">
          <div class="frame pad">
            <h2>{L.games.length + 1}세트</h2>
            <div>진영: <b style={{ color: "var(--blue)" }}>블루 {s.teams[L.blue].short}</b> / <b style={{ color: "var(--red)" }}>레드 {s.teams[red].short}</b></div>
            {controlledId && (
              <div class="row" style={{ marginTop: 6 }}>
                <span>작전:</span>
                {(["aggressive", "standard", "safe"] as Tactic[]).map((t) => <button class={`btn small ${L.tactic === t ? "on" : ""}`} onClick={() => { L.tactic = t; bump(); }}>{t === "aggressive" ? "공격적" : t === "standard" ? "표준" : "안정적"}</button>)}
              </div>
            )}
            {controlledId && <StrategyPicker value={L.strategy} onPick={(st) => { L.strategy = st; bump(); }} />}
            <div class="row" style={{ marginTop: 10 }}>
              <button class="btn primary" onClick={startDraft}>{controlledId ? "밴픽 시작" : "밴픽 보기"}</button>
              <button class="btn" onClick={quick}>이 세트 결과만</button>
              <button class="btn" onClick={leave}>그만두기</button>
            </div>
          </div>
          <div class="frame pad">
            <h2>라인업</h2>
            {ROLES.map((r) => {
              const a = lineupOf(s, "EXA")[r], b = lineupOf(s, "EXB")[r];
              return (
                <div class="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ width: 120 }}>{a?.name ?? "-"}</span>
                  <span class="tag">{ROLE_KO[r]}</span>
                  <span style={{ width: 120, textAlign: "right" }}>{b?.name ?? "-"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
