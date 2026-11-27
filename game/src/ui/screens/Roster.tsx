import { S, store, D } from "../../store";
import { ROLES, ROLE_KO, ATTR_KEYS, ATTR_KO } from "../../data/types";
import type { Role } from "../../data/types";
import { age, ovr, traitWord } from "../../core/player";
import { money } from "../../core/format";
import type { TrainFocus } from "../../core/types";
import { Avatar, ChampIcon, Ovr, PName, RoleTag } from "../components";
import { autosave } from "../App";
import { META_LABEL, metaTier } from "../../core/meta";
import { ACADEMY_MAX, LCK_MIN_SALARY, callUp, canCallUp, canSendDown, sendDown } from "../../core/academy";
import { INTENSITY, restRecovery, trainPlanOf } from "../../core/training";
import type { Intensity } from "../../core/training";
import { fatigueLoss, starterFatigue } from "../../core/quick";
import type { Player } from "../../core/types";
import "../fatigue.css";

/** Word and color class for a fatigue value. */
export function fatigueWord(f: number): [string, string] {
  if (f >= 75) return ["한계", "f-limit"];
  if (f >= 55) return ["지침", "f-tired"];
  if (f >= 35) return ["보통", "f-ok"];
  return ["좋음", "f-good"];
}

const BAR_COLOR: Record<string, string> = { "f-good": "#5ad07a", "f-ok": "#f2c14e", "f-tired": "#ffb13b", "f-limit": "#ff5a5a" };

export function FatigueBar({ v, autoRestAt }: { v: number; autoRestAt?: number | null }) {
  const [word, cls] = fatigueWord(v);
  return (
    <span class="fbar" title="피로: 0 좋음 · 35 보통 · 55 지침(훈련 효율 80%) · 75 한계(훈련 효율 50%)">
      <span class="track">
        <i style={{ width: `${Math.min(100, v)}%`, background: BAR_COLOR[cls] }} />
        {autoRestAt != null && <b style={{ left: `${autoRestAt}%` }} />}
      </span>
      <span class={`n ${cls}`}>{Math.round(v)}</span>
      <span class={`w ${cls}`}>{word}</span>
    </span>
  );
}

/** Players sent to rest by the bulk button remember what they were training, so "복귀" can restore it. */
type Resting = Player & { restFrom?: TrainFocus };

function FatiguePanel() {
  const s = S();
  const me = s.teams[s.user];
  const plan = trainPlanOf(me);
  const avg = starterFatigue(s, s.user);
  const pen = fatigueLoss(avg);
  const [avgWord, avgCls] = fatigueWord(avg);
  const roster = [...me.roster, ...(me.academy ?? [])].map((id) => s.players[id]).filter(Boolean) as Resting[];
  const tired = roster.filter((p) => p.fatigue >= 70);
  const resting = roster.filter((p) => p.train === "rest");
  const setPlan = (next: Partial<typeof plan>) => {
    me.trainPlan = { ...plan, ...next };
    autosave();
    store.bump();
  };
  // bulk rest remembers each player's training (restFrom); restoring puts back exactly that and leaves players
  // who were resting by hand alone
  const sendToRest = (who: Resting[]) => {
    for (const p of who) {
      if (p.train === "rest") continue;
      p.restFrom = p.train;
      p.train = "rest";
    }
    autosave();
    store.bump();
  };
  const restTired = () => sendToRest(tired);
  const bulk = roster.filter((p) => p.restFrom !== undefined);
  const working = roster.filter((p) => p.train !== "rest");
  const restore = () => {
    for (const p of bulk) {
      p.train = p.restFrom!;
      delete p.restFrom;
    }
    autosave();
    store.bump();
  };
  const recover = Math.round(restRecovery(me));
  return (
    <div class="frame pad fatigue-panel">
      <h2>피로 관리</h2>
      <div class="stat-line">
        <span>주전 평균 피로 <span class={`big ${avgCls}`}>{Math.round(avg)}</span> <span class={avgCls}>{avgWord}</span></span>
        <span>경기력 영향 {pen > 0 ? <b class="neg">−{pen.toFixed(1)}</b> : <b class="pos">없음</b>} <span class="dim" style={{ fontSize: 11 }}>(전력 기준, 1이 OVR 1)</span></span>
        <span class="muted">피로 70 이상 {tired.length}명 · 휴식 중 {resting.length}명</span>
      </div>
      <div class="row" style={{ alignItems: "flex-start" }}>
        <span style={{ width: 70, paddingTop: 6 }}>훈련 강도</span>
        {(Object.keys(INTENSITY) as Intensity[]).map((k) => (
          <span class="opt">
            <button class={`btn small ${plan.intensity === k ? "on" : ""}`} onClick={() => setPlan({ intensity: k })}>{INTENSITY[k].label}</button>
            <small>경험치 ×{INTENSITY[k].xp} · 피로 +{INTENSITY[k].fatigue}/일</small>
          </span>
        ))}
      </div>
      <div class="row" style={{ alignItems: "flex-start" }}>
        <span style={{ width: 70, paddingTop: 6 }}>자동 휴식</span>
        {([null, 65, 75, 85] as (number | null)[]).map((v) => (
          <button class={`btn small ${plan.autoRestAt === v ? "on" : ""}`} onClick={() => setPlan({ autoRestAt: v })}>{v === null ? "끔" : `피로 ${v} 이상`}</button>
        ))}
        <span class="dim" style={{ fontSize: 11, paddingTop: 6 }}>그 값을 넘은 선수는 그날 훈련 대신 쉽니다. 훈련 설정은 그대로 둡니다.</span>
      </div>
      <div class="row">
        {bulk.length > 0 ? (
          <button class="btn small on" onClick={restore} title="일괄 휴식으로 바꾼 선수만 각자 하던 훈련으로 돌아갑니다. 직접 휴식으로 둔 선수는 그대로입니다.">
            휴식 전 설정으로 되돌리기 ({bulk.length}명)
          </button>
        ) : (
          <button class="btn small" disabled={!working.length} onClick={() => sendToRest(working)} title="지금 훈련 설정을 기억해 두고 모두 휴식으로 바꿉니다. 같은 자리의 버튼으로 되돌립니다.">
            전원 휴식 ({working.length}명)
          </button>
        )}
        <button class="btn small" disabled={!tired.some((p) => p.train !== "rest")} onClick={restTired}>피로 70 이상만 휴식 ({tired.filter((p) => p.train !== "rest").length}명)</button>
        {bulk.length > 0 && <span class="muted" style={{ fontSize: 11 }}>일괄 휴식 중: {bulk.map((p) => p.name).join(", ")}</span>}
      </div>
      <ul>
        <li>오르는 것: 훈련하는 날마다 강도에 따라 +{INTENSITY.light.fatigue} / +{INTENSITY.normal.fatigue} / +{INTENSITY.hard.fatigue}. 시리즈를 치르면 주전 +8.</li>
        <li>내리는 것: 쉬는 날 하루 −{recover} (훈련을 '휴식'으로 두거나 자동 휴식). 월요일은 모두 쉽니다. 숙소 시설 1레벨마다 회복 +12% (지금 Lv{me.facilities.housing}).</li>
        <li>손해: 피로 55를 넘으면 훈련 효율 80%, 75를 넘으면 50%. 주전 평균이 40을 넘으면 12마다 경기력 −1 (평균 70이면 −2.5, 승률 약 13%p 손해).</li>
        <li>강하게 훈련하면 빨리 크지만 시즌 중에는 자동 휴식을 켜 두는 편이 안전합니다.</li>
      </ul>
    </div>
  );
}

const FOCUS: [TrainFocus, string][] = [
  ["champ", "챔피언 연습"], ...ATTR_KEYS.map((k) => [k, ATTR_KO[k]] as [TrainFocus, string]), ["rest", "휴식"],
];

export function potWord(gap: number, analysis: number, id: string): string {
  // coarse hint; a better analyst narrows it
  const noise = ((id.length * 7) % 5) - 2;
  const g = gap + (analysis < 60 ? noise : 0);
  if (g >= 10) return "매우 높음";
  if (g >= 6) return "높음";
  if (g >= 3) return "보통";
  if (g >= 1) return "낮음";
  return "완성형";
}

export function RosterScreen() {
  const s = S();
  const d = D();
  const me = s.teams[s.user];
  const players = me.roster.map((id) => s.players[id]).filter(Boolean).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || ovr(b) - ovr(a));
  const analysis = Math.max(40, ...me.staff.map((id) => s.staff[id]?.attrs.analysis ?? 40));
  const setLineup = (r: Role, pid: string) => {
    for (const k of ROLES) if (me.lineup[k] === pid) me.lineup[k] = null;
    me.lineup[r] = pid || null;
    autosave();
    store.bump();
  };
  const setTrain = (pid: string, f: TrainFocus) => {
    s.players[pid].train = f;
    // a hand-picked setting is the new "before": the bulk restore must not overwrite it
    delete (s.players[pid] as Resting).restFrom;
    store.bump();
  };
  const setChamp = (pid: string, c: string) => {
    s.players[pid].trainChamp = c;
    store.bump();
  };
  return (
    <div>
      <h1>선수단</h1>
      <div class="frame pad">
        <h2>주전 라인업</h2>
        <div class="row" style={{ alignItems: "stretch" }}>
          {ROLES.map((r) => {
            const pid = me.lineup[r];
            const p = pid ? s.players[pid] : null;
            return (
              <div class="frame dark pad" style={{ width: 180 }}>
                <div class="muted">{ROLE_KO[r]}</div>
                {p ? (
                  <div class="row" style={{ gap: 6 }}>
                    <Avatar pid={p.id} size={36} />
                    <div><PName pid={p.id} /><div><Ovr v={ovr(p)} /> {p.role !== r && <span class="tag red">포지션 다름</span>}</div></div>
                  </div>
                ) : <div class="neg">비어 있음</div>}
                <select value={pid ?? ""} onChange={(e) => setLineup(r, (e.target as HTMLSelectElement).value)} style={{ width: "100%", marginTop: 6 }}>
                  <option value="">- 비움 -</option>
                  {players.filter((x) => !x.scandal).map((x) => <option value={x.id}>{x.name} ({ROLE_KO[x.role]} {ovr(x)})</option>)}
                </select>
              </div>
            );
          })}
        </div>
        <div class="muted" style={{ marginTop: 6 }}>팀 합 {Math.round(me.synergy)} · 새 선수가 들어오면 팀 합이 떨어지고, 경기와 스크림을 하며 오릅니다.</div>
      </div>
      <FatiguePanel />
      <div class="frame pad">
        <h2>선수 ({players.length}/10)</h2>
        <table class="t">
          <thead>
            <tr><th>선수</th><th>포지션</th><th class="num">OVR</th><th>성장 여력</th><th class="num">나이</th><th>성향</th><th>계약</th><th class="num">연봉</th><th class="num">사기</th><th>피로</th><th>훈련</th><th>연습 챔피언</th></tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const champs = Object.entries(p.mastery).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) => c);
              const metaPicks = Object.keys(s.meta?.tiers ?? {}).filter((c) => s.meta!.tiers[c] !== "N" && (d.champ.get(c)?.roles[p.role] ?? 0) >= 0.35);
              const pool = [...new Set([...(p.trainChamp ? [p.trainChamp] : []), ...metaPicks, ...champs, ...d.champions.filter((c) => (c.roles[p.role] ?? 0) > 0.3).sort((a, b) => b.pro.presence - a.pro.presence).slice(0, 20).map((c) => c.id)])];
              if (!p.trainChamp && pool.length) p.trainChamp = pool[0];
              return (
                <tr>
                  <td><div class="row" style={{ gap: 6 }}><Avatar pid={p.id} size={24} /><PName pid={p.id} />{p.listed && <span class="tag gold">이적 목록</span>}{p.scandal && <span class={`tag ${!p.outWhy || p.outWhy === "징계" || p.outWhy === "부상" ? "red" : ""}`}>{p.outWhy ?? "징계"} {p.scandal}일</span>}{(p.restDays ?? 0) > 0 && <span class="tag">휴식 {p.restDays}일</span>}{p.retireAfter && <span class="tag">시즌 뒤 은퇴</span>}{p.unpaid > 0 && <span class="tag red">체불 {p.unpaid}개월</span>}</div></td>
                  <td><RoleTag r={p.role} /></td>
                  <td class="num"><Ovr v={ovr(p)} /></td>
                  <td class="muted">{potWord(p.pot - ovr(p), analysis, p.id)}</td>
                  <td class="num">{age(p, s.season)}</td>
                  <td class="muted">{traitWord(p)}</td>
                  <td>{p.contract ? `${p.contract.until}년까지` : "-"}{p.contract && p.contract.until <= s.season && <span class="tag red">만료 예정</span>}</td>
                  <td class="num">{money(p.contract?.salary ?? 0)}</td>
                  <td class="num" style={{ color: p.morale < 40 ? "var(--red)" : undefined }}>{Math.round(p.morale)}</td>
                  <td>
                    <FatigueBar v={p.fatigue} autoRestAt={trainPlanOf(me).autoRestAt} />
                    {trainPlanOf(me).autoRestAt !== null && p.fatigue >= trainPlanOf(me).autoRestAt! && p.train !== "rest" && <span class="tag autorest">내일 자동 휴식</span>}
                  </td>
                  <td>
                    <select value={p.train} onChange={(e) => setTrain(p.id, (e.target as HTMLSelectElement).value as TrainFocus)}>
                      {FOCUS.map(([k, l]) => <option value={k}>{l}</option>)}
                    </select>
                  </td>
                  <td>
                    <div class="row" style={{ gap: 4 }}>
                      <ChampIcon id={p.trainChamp} size={22} />
                      <select value={p.trainChamp ?? ""} onChange={(e) => setChamp(p.id, (e.target as HTMLSelectElement).value)} style={{ maxWidth: 110 }}>
                        {pool.map((c) => <option value={c}>{metaTier(s, c) ? `[${META_LABEL[metaTier(s, c)!]}] ` : ""}{d.champ.get(c)?.name ?? c} {p.mastery[c] ? `(${Math.round(p.mastery[c])})` : ""}</option>)}
                      </select>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div class="muted" style={{ fontSize: 11, marginTop: 6 }}>
          훈련: 고른 능력치에 경험치가 쌓여 100마다 +1 오릅니다(잠재력 한도까지). 챔피언 연습은 그 챔피언 숙련도를 올리고 챔프폭에도 경험치를 조금 줍니다. 피로 관리는 위의 "피로 관리"에서 합니다.
        </div>
        <div class="row" style={{ marginTop: 6 }}>
          <span class="muted">1군 선수를 2군으로:</span>
          {players.filter((p) => !Object.values(me.lineup).includes(p.id)).map((p) => {
            const ok = canSendDown(s, p);
            return (
              <button class="btn small" disabled={!ok.ok} title={ok.msg ?? "계약은 그대로, 사기가 떨어집니다"} onClick={() => { if (sendDown(s, p)) { autosave(); store.bump(); } }}>
                {p.name} ↓
              </button>
            );
          })}
          <span class="dim" style={{ fontSize: 11 }}>주전이 아닌 선수만. OVR 82 이상·명성 60 이상은 거부합니다.</span>
        </div>
      </div>
      <AcademyPanel />
    </div>
  );
}

function AcademyPanel() {
  const s = S();
  const me = s.teams[s.user];
  const ac = (me.academy ?? []).map((id) => s.players[id]).filter(Boolean).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || ovr(b) - ovr(a));
  return (
    <div class="frame pad">
      <h2>2군 ({ac.length}/{ACADEMY_MAX})</h2>
      <div class="muted" style={{ marginBottom: 6 }}>
        LCK CL 로스터입니다. 연봉이 싸고(월급에 포함), 훈련 효율은 1군의 70%입니다. 콜업하면 1군 로스터(최대 10명)로 올라가고 연봉이 LCK 최저 {money(LCK_MIN_SALARY)}으로 오릅니다. 경기 날 주전 자리가 비면 그 포지션 2군 선수가 자동으로 콜업됩니다.
      </div>
      <table class="t">
        <thead><tr><th>선수</th><th>포지션</th><th class="num">OVR</th><th>성장 여력</th><th class="num">나이</th><th>계약</th><th class="num">연봉</th><th class="num">사기</th><th></th></tr></thead>
        <tbody>
          {ac.map((p) => {
            const ok = canCallUp(s, p);
            return (
              <tr>
                <td><div class="row" style={{ gap: 6 }}><Avatar pid={p.id} size={22} /><PName pid={p.id} />{p.origin === "gen" && <span class="tag">가상 신인</span>}</div></td>
                <td><RoleTag r={p.role} /></td>
                <td class="num"><Ovr v={ovr(p)} /></td>
                <td class="muted">{potWord(p.pot - ovr(p), 60, p.id)}</td>
                <td class="num">{age(p, s.season)}</td>
                <td>{p.contract ? `${p.contract.until}년까지` : "-"}</td>
                <td class="num">{money(p.contract?.salary ?? 0)}</td>
                <td class="num">{Math.round(p.morale)}</td>
                <td class="right"><button class="btn small primary" disabled={!ok.ok} title={ok.msg} onClick={() => { if (callUp(s, p)) { autosave(); store.bump(); } }}>콜업</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!ac.length && <div class="muted">2군 선수가 없습니다.</div>}
    </div>
  );
}
