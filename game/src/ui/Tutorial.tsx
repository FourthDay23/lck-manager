// First-game tutorial: a dimmed screen with a lit "hole" over the part being explained and a box with the step,
// Back / Next / Skip. Steps can switch screens first. Layout idea from VCT Manager's guided tour (spotlight + step box
// + progress); the steps are this game's own.
// The tour comes in parts. The intro starts with every new game (and when a save that has not finished it is
// opened); the others start by themselves when the player first gets there: "go" once a head coach and five
// starters are signed, the rest on the match screens (screens call tutSpot). Some steps are the player's to do
// ("until"): the lit button takes clicks and the step ends when the game reaches that spot. What was seen is kept in
// the save (GameState.tut), so each career gets the whole tour once; Settings shows it all again.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { store, useStore } from "../store";
import type { GameState } from "../core/types";
import { ROLES } from "../data/types";
import { autosave } from "./App";
import "./tutorial.css";

/** Places the match screens report (tutSpot). */
export type Spot = "series" | "draft" | "ban" | "pick" | "loadout" | "match";

interface Step {
  /** screen to open before showing the step */
  screen?: string;
  /** what to light up: a CSS selector, optionally the first match whose text starts with `text` (then its frame) */
  sel?: string;
  text?: string;
  title: string;
  body: string;
  /** the player does this one: the lit part takes clicks, there is no Next, and the step ends at this spot */
  until?: Spot;
}

const tut = (k: string) => `[data-tut="${k}"]`;

const PARTS: Record<string, Step[]> = {
  intro: [
    { screen: "home", title: "단장 취임을 축하합니다!", body: "Faker(T1)와 ShowMaker(DK)를 뺀 모든 선수와 감독이 FA인 상태로 시즌이 시작했습니다. 1월 14일 LCK 컵 개막 전까지 감독과 주전 5명을 갖춰야 합니다.\n튜토리얼은 2분 정도면 끝나고, 저장 · 설정 화면에서 언제든 다시 볼 수 있습니다." },
    { screen: "home", sel: ".topbar .stat", text: "자금", title: "1부 · 자금", body: "구단이 쓸 수 있는 돈입니다. 계약금과 이적료는 계약하는 순간 빠지고, 수익금은 매달 1일에 들어옵니다. 마이너스가 되면 게임이 오버되니 주의하세요!" },
    { screen: "home", sel: ".topbar .stat", text: "월 급여", title: "1부 · 월 급여", body: "선수와 스태프 연봉 합계를 12로 나눈 돈이 매달 25일에 나갑니다. 고정 수입보다 크면 승리 수당, 상금, 굿즈 판매로 메워야 합니다." },
    { screen: "home", sel: ".topbar .stat", text: "이적시장", title: "1부 · 이적시장 기간", body: "이적시장이 열려 있을 때만 FA 영입과 이적을 할 수 있습니다. 1년에 세 번 열립니다.\n· 스토브리그: 11월 14일 ~ 1월 13일\n· LCK 컵이 끝난 뒤: 3월 초 ~ 3월 31일\n· MSI 개막 ~ 정규 시즌 3라운드 전: 6월 24일 ~ 8월 4일\n지금은 스토브리그라 열려 있습니다." },
    { screen: "home", sel: ".topbar .btn.primary", title: "1부 · 시간 진행", body: "다음 날, 1주, 다음 경기까지 중에서 골라 시간을 보냅니다. 큰 제안이나 사건이 생기면 알림이 옵니다." },
    { screen: "home", sel: ".side", title: "1부 · 메뉴", body: "왼쪽 메뉴로 각 화면을 오갑니다. 이적시장과 뉴스 옆의 표시는 새 제안과 읽지 않은 소식입니다." },
    { screen: "home", sel: ".main h2", text: "할 일", title: "1부 · 할 일", body: "지금 꼭 해야 할 일을 여기서 확인할 수 있습니다." },
    { screen: "staff", sel: ".main h2", text: "감독 · 코치 목록", title: "2부 · 감독 영입", body: "가장 먼저 감독을 구하세요. 감독이 없으면 밴픽에서 추천을 거의 받지 못하고 팀 전력도 깎입니다. 감독과 코치의 밴픽 · 분석 능력이 높을수록 전력이 강해집니다." },
    { screen: "market", sel: ".main table", title: "2부 · 선수 찾기", body: "FA와 영입할 수 있는 선수 목록입니다. 포지션과 능력치, 요구 연봉을 보고 신중히 선택하세요. 선호도가 낮은 구단은 같은 조건에서 선수가 다른 팀을 고릅니다." },
    { screen: "market", sel: ".main table", title: "2부 · 협상", body: "선수를 누르면 협상이 시작됩니다. 면담에서 선수 성향에 맞는 답을 고르면 요구액이 내려갑니다. 그다음 연봉, 기간, 계약금, 주전 보장을 정해 제안합니다. 계약금은 서명할 때 한 번만 주는 돈으로, 월 급여를 늘리지 않고 요구액을 맞출 때 씁니다." },
    { screen: "roster", sel: ".main h2", text: "주전 라인업", title: "2부 · 주전 라인업", body: "경기에 나갈 다섯 명을 정합니다. 자기 포지션이 아닌 자리에 세우면 능력치가 크게 깎입니다. 사람이 모자라면 2군 선수를 콜업할 수 있습니다." },
    { screen: "roster", sel: ".fatigue-panel", title: "2부 · 피로 관리", body: "훈련은 능력치를 올리지만 피로가 쌓입니다. 피로가 높으면 경기력이 떨어지니, 훈련 강도와 자동 휴식 기준을 정해 두세요." },
    { screen: "meta", sel: ".main h2", text: "포지션별 티어", title: "3부 · 메타", body: "패치마다 강한 챔피언이 바뀝니다. S · A티어 챔피언을 잡으면 그 선수의 능력치가 오르고, 너프된 챔피언은 깎입니다. 선수의 메타 챔피언 숙련도도 여기서 확인할 수 있습니다." },
    { screen: "schedule", sel: ".main h1", text: "일정", title: "3부 · 일정과 순위", body: "LCK 컵, 정규 시즌, MSI, EWC, 월즈까지 시즌 일정과 순위를 확인합니다. 끝난 경기를 누르면 세트 기록이 나옵니다." },
    { screen: "settings", sel: ".main h2", text: "세이브 파일", title: "3부 · 저장", body: "게임은 자동으로 저장됩니다. 다른 기기나 다른 주소로 옮길 때는 세이브 파일로 내보내 열면 됩니다. 이 화면에서 튜토리얼을 다시 볼 수도 있습니다." },
    { screen: "home", title: "준비 끝", body: "이제 감독을 영입하고 주전 다섯 명과 계약하세요. 다 갖추면 경기하러 가는 길을 이어서 안내합니다. 행운을 빕니다, 단장님." },
  ],
  // once a head coach and five starters are signed (see readyForMatch)
  go: [
    { sel: ".topbar .btn.primary", until: "series", title: "경기하러 가기", body: "감독과 주전 다섯 명이 모두 갖춰졌습니다. '다음 경기까지 ▶'를 누르면 다음 경기 날까지 시간이 흐르고 경기 화면으로 넘어갑니다. 중간에 제안이나 사건이 생기면 멈추니, 처리한 뒤 다시 누르세요. 경기 날에는 이 자리에 '오늘 경기 하러 가기'가 나옵니다." },
  ],
  series: [
    { title: "경기 날", body: "경기는 밴픽부터 시작합니다. 감독 추천을 참고해 밴과 픽을 고르고, 밴픽이 끝나면 선수별 룬과 빌드를 선택할 수 있습니다. 경기는 직접 관전하거나 결과만 볼 수 있습니다." },
    { sel: tut("series-prep"), title: "세트 준비", body: "진영 선택권이 있으면 블루(먼저 픽)와 레드(마지막 픽) 중에 고릅니다. 작전은 교전을 얼마나 거는지, 운영 방식은 감독의 경기 계획입니다. 밴픽 없이 결과만 보려면 '이 세트 결과만 보기'나 '시리즈 끝까지 결과만'을 누르세요." },
    { sel: tut("series-draft"), until: "draft", title: "밴픽 시작", body: "'밴픽 시작'을 눌러 밴픽 화면으로 가 보세요." },
  ],
  // the first time it is our turn to ban
  ban: [
    { sel: tut("draft-head"), title: "밴픽 · 순서", body: "블루와 레드가 번갈아 고릅니다. 밴 3개씩 → 픽 3개씩 → 밴 2개씩 → 픽 2개씩 순서입니다. 여기에 지금 누구 차례인지, 몇 번째인지 나오고, 차례인 팀의 판은 테두리가 빛납니다." },
    { sel: tut("draft-grid"), title: "밴픽 · 챔피언 목록", body: "왼쪽 위 S · A 표시는 이번 패치에서 강한 챔피언, '너프'는 약해진 챔피언입니다. 초록 테두리는 감독이 이번 차례에 추천하는 챔피언입니다. 흐린 챔피언은 이미 밴 · 픽됐거나, 이번 시리즈에서 이미 써서(F, 피어리스) 고를 수 없습니다." },
    { sel: tut("draft-sug"), title: "밴픽 · 감독 추천", body: "감독이 이번 차례에 고를 만한 챔피언과 그 이유를 보여 줍니다. 누르면 바로 그 챔피언을 고릅니다. 감독의 밴픽 능력이 높을수록 추천이 많고 정확합니다." },
    { sel: tut("draft-filter"), title: "밴픽 · 찾기", body: "포지션 버튼과 검색으로 목록을 좁힐 수 있습니다. '추천대로'를 누르면 감독 추천대로 이번 차례를 바로 진행합니다. 이제 밴할 챔피언을 직접 눌러 보세요." },
  ],
  // the first time it is our turn to pick
  pick: [
    { sel: tut("draft-mine"), title: "픽 · 넣을 자리", body: "우리 팀 판입니다. 금색 테두리가 이번 픽이 들어갈 자리이고, 다른 빈 자리를 누르면 그 포지션으로 바꿉니다. 고른 챔피언 아래에는 그 선수의 숙련도가 나옵니다." },
    { sel: tut("draft-grid"), title: "픽 · 선수의 선호 챔피언", body: "픽 차례에는 챔피언 아이콘 왼쪽 아래에 금색 숫자로 지금 자리 선수의 숙련도가 나옵니다. 선수가 많이 다뤄 본 선호 챔피언일수록 숫자가 높고, 숙련도가 높을수록 경기에서 잘 다룹니다. 숫자가 없는 챔피언은 그 선수가 프로 경기에서 써 본 적이 없는 챔피언입니다." },
    { sel: tut("draft-sug"), title: "픽 · 추천 픽", body: "픽 차례의 감독 추천은 어느 포지션에 넣을지와 이유(선수 숙련도, 프로 메타 출현율, 티어)를 같이 보여 줍니다. 추천을 누르면 그 포지션에 바로 들어갑니다. 목록의 초록 테두리도 같은 추천입니다." },
  ],
  // the draft is over: runes, builds, then the game
  loadout: [
    { sel: tut("draft-comp"), title: "룬 · 빌드 · 조합 비교", body: "밴픽이 끝났습니다. 두 팀 조합의 AD · AP 수와 초반 · 후반 · 이니시 · 보호 · 포킹 · 폭딜 성향을 막대로 비교합니다." },
    { sel: ".loadout", title: "룬 · 빌드 · 고르기", body: "선수마다 핵심 룬과 아이템 빌드를 고릅니다. 이 챔피언이 LCK에서 많이 쓴 세 가지가 판수와 승률과 함께 나오고, +%p는 그 챔피언 평균보다 승률이 높은 정도입니다(표본이 적으면 줄여서 보여 줍니다). 그대로 두면 가장 많이 쓴 첫 번째로 나갑니다." },
    { sel: tut("draft-go"), title: "룬 · 빌드 · 경기 시작", body: "예상 승률을 확인하고 '경기 시작'을 누르면 경기를 직접 관전하고, '결과만 보기'를 누르면 바로 결과로 넘어갑니다." },
  ],
  // the first game watched (the game waits while this is on)
  match: [
    { sel: tut("match-ctrl"), title: "관전 · 화면 조작", body: "카메라(중계 · 전체 · 라인별), 일시정지, 배속을 고릅니다. '중계'는 평소 전체 맵을 보여 주다가 6명 이상 붙는 한타 때만 확대합니다. 배속 숫자는 실제 경기 대비 빠르기입니다(8x = 8배). '한타 실시간'을 켜 두면 6명 이상 한타는 실제 속도로, 4~5명 교전은 최대 4배속으로 보여 줍니다. '끝까지'는 결과까지 바로 넘깁니다." },
    { sel: tut("match-tactic"), title: "관전 · 작전", body: "경기 중에도 공격적 · 표준 · 안정적 작전을 바꿀 수 있습니다. 운영 방식은 경기 전에 정한 그대로 갑니다." },
    { sel: tut("match-team"), title: "관전 · 선수 현황", body: "선수를 누르면 카메라가 그 선수를 따라갑니다. 초상화의 작은 원은 고른 룬, 오른쪽은 아이템입니다(작은 칸은 다음 아이템 재료). 튜토리얼을 닫으면 경기가 이어집니다." },
  ],
};

// in the save's list: a part by its name, a one-time tip as "tip:<key>", and OFF once the player skipped
const OFF = "off";
const TIP = (k: string) => `tip:${k}`;

/** The career's tutorial record (the code-match screen has its own throwaway state and no tour). */
function record(): string[] | null {
  const s = store.s;
  if (!s || store.override) return null;
  return (s.tut ??= []);
}
function seen(key: string): boolean {
  return record()?.includes(key) ?? true;
}
function mark(key: string) {
  const r = record();
  if (r && !r.includes(key)) {
    r.push(key);
    autosave();
  }
}

/**
 * A one-time tip in the tutorial's look, the first time the player reaches a spot (e.g. the signing bonus in the
 * contract form). Seen tips are kept in the save; restarting the tutorial from Settings shows them again.
 * Skipped while the tour itself is running.
 */
export function tipOnce(tip: NonNullable<typeof store.tip>) {
  if (store.tut !== null || store.tip || seen(TIP(tip.key))) return;
  store.tip = tip;
  store.bump();
}

function closeTip() {
  if (store.tip) mark(TIP(store.tip.key));
  store.tip = null;
  store.bump();
}

function begin(part: string) {
  store.tip = null;
  store.tut = { part, i: 0 };
  const sc = PARTS[part][0].screen;
  if (sc && store.screen.name !== sc) store.screen = { name: sc };
  store.bump();
}

/**
 * Start the tour: with a new game or an opened save, unless this save has seen the intro or turned the tour off;
 * from Settings (`force`), always, with every part and tip of this save shown again.
 */
export function startTutorial(force = false) {
  const r = record();
  if (!r) return;
  if (force) {
    r.length = 0;
    autosave();
  } else if (r.includes("intro") || r.includes(OFF)) {
    store.tut = null;
    return;
  }
  begin("intro");
}

/** This part is over (finished or skipped). */
function endPart(skip: boolean) {
  const t = store.tut;
  store.tut = null;
  if (t) mark(t.part);
  if (skip) mark(OFF);
  if (t?.part === "intro") store.go("home");
  else store.bump();
}

function go(i: number) {
  const t = store.tut;
  if (!t) return;
  const steps = PARTS[t.part];
  if (i < 0) i = 0;
  if (i >= steps.length) return endPart(false);
  store.tut = { part: t.part, i };
  const sc = steps[i].screen;
  if (sc && store.screen.name !== sc) store.screen = { name: sc };
  store.close(); // also bumps
}

/**
 * The match screens call this when the player gets somewhere (from an effect). A step waiting for this spot ends;
 * with no part running, the part named after the spot starts the first time. Not in code matches.
 */
export function tutSpot(spot: Spot) {
  if (store.override || !store.s) return;
  const t = store.tut;
  if (t) {
    if (PARTS[t.part][t.i].until !== spot) return; // a part on screen goes first
    go(t.i + 1);
    if (store.tut) return;
  }
  if (store.tip || !PARTS[spot] || seen(spot) || seen(OFF)) return;
  begin(spot);
}

/** A head coach and five starters: time to play. Only in a career that has not played a game yet. */
function readyForMatch(s: GameState): boolean {
  const me = s.teams[s.user];
  if (!me.staff.some((id) => s.staff[id]?.role === "Head Coach")) return false;
  if (!ROLES.every((r) => me.lineup[r])) return false;
  return !s.series.some((sr) => (sr.a === s.user || sr.b === s.user) && sr.games.length > 0);
}

/** Light up at most the top 45% of the screen of a long panel, inside the viewport, so the step box fits below it. */
function clip(r: DOMRect): DOMRect {
  const top = Math.max(8, r.top);
  const bottom = Math.min(r.bottom, top + innerHeight * 0.45, innerHeight - 8);
  const left = Math.max(8, r.left), right = Math.min(r.right, innerWidth - 8);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

function locate(st: Step): HTMLElement | null {
  if (!st.sel) return null;
  const all = [...document.querySelectorAll<HTMLElement>(st.sel)];
  const el = st.text ? all.find((x) => (x.textContent ?? "").trim().startsWith(st.text!)) : all[0];
  if (!el) return null;
  // a heading stands for its panel
  if (/^H[1-3]$/.test(el.tagName) && !(st.sel ?? "").includes("h1")) return (el.closest(".frame") as HTMLElement) ?? el.parentElement;
  return el;
}

/**
 * Dim everything around the lit rectangle with four panels (a huge box-shadow is not drawn reliably everywhere).
 * `act`: the player is to click the lit part, so the panels take the clicks around it and the hole lets them through.
 */
function Hole({ r, act }: { r: DOMRect; act?: boolean }) {
  const L = r.left - 6, T = r.top - 6, R = r.right + 6, B = r.bottom + 6;
  const c = `tut-shade${act ? " block" : ""}`;
  return (
    <>
      <div class={c} style={{ left: 0, top: 0, width: "100%", height: Math.max(0, T) }} />
      <div class={c} style={{ left: 0, top: B, width: "100%", bottom: 0 }} />
      <div class={c} style={{ left: 0, top: T, width: Math.max(0, L), height: B - T }} />
      <div class={c} style={{ left: R, top: T, right: 0, height: B - T }} />
      <div class={`tut-hole${act ? " act" : ""}`} style={{ left: L, top: T, width: R - L, height: B - T }} />
    </>
  );
}

export function TutorialLayer() {
  const st = useStore();
  const t = st.tut;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, setTick] = useState(0);
  // the tour step, or a one-time tip (tips never show during the tour)
  const steps = t ? PARTS[t.part] : null;
  const step: Step | null = t ? steps![t.i] : st.tip;
  const key = t ? `${t.part}${t.i}` : st.tip ? `p${st.tip.key}` : "";
  // the match screens' events and alerts wait while a match is on (App), so they do not hold the tour there
  const busy = !!st.s && (st.s.cutscenes.length > 0 || (st.screen.name !== "series" && (st.s.events.length > 0 || (st.s.alerts?.length ?? 0) > 0)));
  // "go" starts by itself once the team is ready to play (outside the match screens, with nothing else open)
  useEffect(() => {
    const s = st.s;
    if (!s || t || st.tip || st.modal || busy || store.override || st.screen.name === "series") return;
    if (!seen("intro") || seen("go") || seen(OFF) || !readyForMatch(s)) return;
    begin("go");
  });
  // measure after the screen for this step has rendered, and again on resize / scroll
  useLayoutEffect(() => {
    if (!step) return;
    let raf = 0;
    const measure = () => {
      const el = locate(step);
      if (el) {
        const r0 = el.getBoundingClientRect();
        // long panels (lists, tables): bring their top into view; short ones: center them if off screen
        if (r0.height > innerHeight * 0.45) el.scrollIntoView({ block: "start" });
        else if (r0.top < 0 || r0.bottom > innerHeight * 0.7) el.scrollIntoView({ block: "center" });
      }
      setRect(el ? clip(el.getBoundingClientRect()) : null);
    };
    // a timer, not requestAnimationFrame: it also runs in a background tab, after the new screen has rendered
    raf = window.setTimeout(measure, 40);
    const again = () => setTick((x) => x + 1);
    addEventListener("resize", again);
    return () => { clearTimeout(raf); removeEventListener("resize", again); };
  }, [key, st.screen.name, busy]);
  useEffect(() => {
    if (!step) return;
    const onResize = () => { const el = locate(step); setRect(el ? clip(el.getBoundingClientRect()) : null); };
    addEventListener("resize", onResize);
    addEventListener("scroll", onResize, true);
    return () => { removeEventListener("resize", onResize); removeEventListener("scroll", onResize, true); };
  }, [key]);
  if (!step || !st.s) return null;
  // let cutscenes, event choices and big alerts go first (they sit under this layer otherwise)
  if (busy) return null;
  const W = 340;
  let box: Record<string, string | number> = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  if (rect) {
    // beside the lit part when there is room, otherwise below it (or above when it sits low on the screen)
    let x = rect.right + 16, y = rect.top;
    if (x + W > innerWidth - 10) x = rect.left - W - 16;
    if (x < 10) {
      x = Math.min(innerWidth - W - 10, Math.max(10, rect.left + 12));
      y = rect.bottom + 14 + 230 <= innerHeight ? rect.bottom + 14 : rect.top - 244;
    }
    box = { left: x, top: Math.max(10, Math.min(innerHeight - 240, y)) };
  }
  if (!t) {
    // one-time tip: same look, a single button
    return (
      <div class="tut-layer">
        <div class="tut-block" />
        {rect ? <Hole r={rect} /> : <div class="tut-dim" />}
        <div class="tut-box frame" style={{ width: W, ...box }}>
          <div class="tut-step">도움말 · 처음 한 번만 보입니다</div>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          <div class="row" style={{ justifyContent: "flex-end" }}>
            <button class="btn small primary" onClick={closeTip}>확인</button>
          </div>
        </div>
      </div>
    );
  }
  const i = t.i, n = steps!.length;
  const last = i === n - 1;
  const act = !!step.until;
  return (
    <div class="tut-layer">
      {/* a step the player does: only the lit part takes clicks (if it is not on screen, nothing is held back) */}
      {!act && <div class="tut-block" />}
      {rect ? <Hole r={rect} act={act} /> : !act && <div class="tut-dim" />}
      <div class="tut-box frame" style={{ width: W, ...box }}>
        {n > 1 && <div class="tut-step">{i + 1} / {n}</div>}
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        {n > 1 && <div class="tut-bar"><i style={{ width: `${((i + 1) / n) * 100}%` }} /></div>}
        <div class="row" style={{ gap: 6 }}>
          <button class="btn small" title="남은 튜토리얼을 모두 끕니다. 저장 · 설정에서 다시 볼 수 있습니다." onClick={() => endPart(true)}>건너뛰기</button>
          <span class="grow" style={{ flex: 1 }} />
          {i > 0 && <button class="btn small" onClick={() => go(i - 1)}>이전</button>}
          {act ? <span class="gold" style={{ fontSize: 12 }}>빛나는 곳을 누르세요</span>
            : <button class="btn small primary" onClick={() => go(i + 1)}>{last ? (t.part === "intro" ? "시작하기" : "확인") : "다음"}</button>}
        </div>
      </div>
    </div>
  );
}
