// First-game tutorial: a dimmed screen with a lit "hole" over the part being explained and a box with the step,
// Back / Next / Skip. Steps can switch screens first. Shown once per browser (localStorage), again from Settings.
// Layout idea from VCT Manager's guided tour (spotlight + step box + progress); the steps are this game's own.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { store, useStore } from "../store";
import "./tutorial.css";

const DONE_KEY = "lckm_tut_done";

interface Step {
  /** screen to open before showing the step */
  screen?: string;
  /** what to light up: a CSS selector, optionally the first match whose text starts with `text` (then its frame) */
  sel?: string;
  text?: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  { screen: "home", title: "단장 취임을 축하합니다", body: "Faker(T1)와 ShowMaker(DK)를 뺀 모든 선수와 감독이 FA인 상태로 시즌이 시작합니다. 1월 14일 LCK 컵 개막 전까지 감독과 주전 5명을 갖춰야 합니다. 이 안내는 2분 정도면 끝나고, 저장 · 설정 화면에서 언제든 다시 볼 수 있습니다." },
  { screen: "home", sel: ".topbar .stat", text: "자금", title: "1부 · 자금", body: "구단이 쓸 수 있는 돈입니다. 계약금과 이적료는 계약하는 순간 빠지고, 스폰서 · 방송 · 리그 분배금은 매달 1일에 들어옵니다. 마이너스가 되지 않게 관리하세요." },
  { screen: "home", sel: ".topbar .stat", text: "월 급여", title: "1부 · 월 급여", body: "선수와 스태프 연봉 합계를 12로 나눈 돈이 매달 25일에 나갑니다. 고정 수입보다 크면 승리 수당, 상금, 굿즈 판매로 메워야 합니다." },
  { screen: "home", sel: ".topbar .stat", text: "이적시장", title: "1부 · 이적시장 기간", body: "이적시장이 열려 있을 때만 FA 영입과 이적을 할 수 있습니다. 지금은 스토브리그라 열려 있습니다." },
  { screen: "home", sel: ".topbar .btn.primary", title: "1부 · 시간 진행", body: "다음 날, 1주, 다음 경기까지 중에서 골라 시간을 보냅니다. 큰 제안이나 사건이 생기면 자동 진행이 멈추고 알려 줍니다. 경기가 있는 날에는 이 자리에 '오늘 경기 하러 가기'가 나옵니다." },
  { screen: "home", sel: ".side", title: "1부 · 메뉴", body: "왼쪽 메뉴로 각 화면을 오갑니다. 이적시장과 뉴스 옆의 표시는 새 제안과 읽지 않은 소식입니다." },
  { screen: "home", sel: ".main h2", text: "할 일", title: "1부 · 할 일", body: "지금 꼭 해야 할 일이 여기 모입니다. 감독이 없거나 주전 자리가 비어 있으면 여기서 먼저 알려 줍니다." },
  { screen: "staff", sel: ".main h2", text: "감독 · 코치 목록", title: "2부 · 감독 영입", body: "가장 먼저 감독을 구하세요. 감독이 없으면 밴픽에서 추천을 거의 받지 못하고 팀 전력도 깎입니다. 감독과 코치의 밴픽 · 분석 능력이 높을수록 전력에 더해집니다." },
  { screen: "market", sel: ".main table", title: "2부 · 선수 찾기", body: "FA와 영입할 수 있는 선수 목록입니다. 포지션과 능력치, 요구 연봉을 보고 고르세요. 선호도가 낮은 구단은 같은 조건이면 선수가 다른 팀을 고릅니다. 해외 리그에서 뛰는 LCK 출신 선수도 탭에서 찾을 수 있습니다." },
  { screen: "market", sel: ".main table", title: "2부 · 협상", body: "선수를 누르면 협상이 시작됩니다. 면담에서 선수 성향에 맞는 답을 고르면 요구액이 내려갑니다. 그다음 연봉, 기간, 계약금, 주전 보장을 정해 제안합니다. 계약금은 서명할 때 한 번만 주는 돈으로, 월 급여를 늘리지 않고 요구액을 맞출 때 씁니다." },
  { screen: "roster", sel: ".main h2", text: "주전 라인업", title: "2부 · 주전 라인업", body: "경기에 나갈 다섯 명을 정합니다. 자기 포지션이 아닌 자리에 세우면 능력치가 크게 깎입니다. 사람이 모자라면 2군 선수를 콜업할 수 있습니다." },
  { screen: "roster", sel: ".fatigue-panel", title: "2부 · 피로 관리", body: "훈련은 능력치를 올리지만 피로가 쌓입니다. 피로가 높으면 경기력이 떨어지니, 훈련 강도와 자동 휴식 기준을 정해 두세요." },
  { screen: "meta", sel: ".main h2", text: "포지션별 티어", title: "3부 · 메타", body: "패치마다 강한 챔피언이 바뀝니다. S · A티어 챔피언을 잡으면 그 선수의 능력치가 오르고, 너프된 챔피언은 깎입니다. 선수의 메타 챔피언 숙련도도 여기서 봅니다." },
  { screen: "schedule", sel: ".main h1", text: "일정", title: "3부 · 일정과 순위", body: "LCK 컵, 정규 시즌, MSI, EWC, 월즈까지 시즌 일정과 순위를 봅니다. 끝난 경기를 누르면 세트 기록이 나옵니다." },
  { screen: "home", title: "3부 · 경기 날", body: "경기 날에는 밴픽부터 합니다. 감독 추천을 참고해 밴과 픽을 고르고, 밴픽이 끝나면 선수별 룬과 빌드를 LCK 통계와 함께 고릅니다. 경기는 직접 관전하거나(배속 · 카메라 선택) 결과만 볼 수 있습니다." },
  { screen: "settings", sel: ".main h2", text: "세이브 파일", title: "3부 · 저장", body: "게임은 자동으로 저장됩니다. 다른 기기나 다른 주소로 옮길 때는 세이브 파일로 내보내 열면 됩니다. 이 화면에서 튜토리얼을 다시 볼 수도 있습니다." },
  { screen: "home", title: "준비 끝", body: "이제 감독을 영입하고, 주전 다섯 명과 계약한 뒤 '다음 경기까지'로 개막을 기다리면 됩니다. 행운을 빕니다, 단장님." },
];

const TIP_PREFIX = "lckm_tip_";

/**
 * A one-time tip in the tutorial's look, the first time the player reaches a spot (e.g. the signing bonus in the
 * contract form). Seen tips are remembered per browser; restarting the tutorial from Settings shows them again.
 * Skipped while the tour itself is running.
 */
export function tipOnce(tip: NonNullable<typeof store.tip>) {
  if (store.tut !== null || store.tip) return;
  try { if (localStorage.getItem(TIP_PREFIX + tip.key)) return; } catch { /* show it */ }
  store.tip = tip;
  store.bump();
}

function closeTip() {
  if (store.tip) {
    try { localStorage.setItem(TIP_PREFIX + store.tip.key, "1"); } catch { /* ignore */ }
  }
  store.tip = null;
  store.bump();
}

/** Start the tour (from a new game: only the first time on this browser; from Settings: always). */
export function startTutorial(force = false) {
  if (!force) {
    try { if (localStorage.getItem(DONE_KEY)) return; } catch { /* private mode: show it */ }
  } else {
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(TIP_PREFIX)) localStorage.removeItem(k); } catch { /* ignore */ }
  }
  store.tip = null;
  store.tut = 0;
  if (STEPS[0].screen) store.screen = { name: STEPS[0].screen };
  store.bump();
}

function endTutorial() {
  store.tut = null;
  try { localStorage.setItem(DONE_KEY, "1"); } catch { /* ignore */ }
  store.go("home");
}

function go(i: number) {
  if (i < 0) i = 0;
  if (i >= STEPS.length) return endTutorial();
  store.tut = i;
  const sc = STEPS[i].screen;
  if (sc && store.screen.name !== sc) store.screen = { name: sc };
  store.close(); // also bumps
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

/** Dim everything around the lit rectangle with four panels (a huge box-shadow is not drawn reliably everywhere). */
function Hole({ r }: { r: DOMRect }) {
  const L = r.left - 6, T = r.top - 6, R = r.right + 6, B = r.bottom + 6;
  return (
    <>
      <div class="tut-shade" style={{ left: 0, top: 0, width: "100%", height: Math.max(0, T) }} />
      <div class="tut-shade" style={{ left: 0, top: B, width: "100%", bottom: 0 }} />
      <div class="tut-shade" style={{ left: 0, top: T, width: Math.max(0, L), height: B - T }} />
      <div class="tut-shade" style={{ left: R, top: T, right: 0, height: B - T }} />
      <div class="tut-hole" style={{ left: L, top: T, width: R - L, height: B - T }} />
    </>
  );
}

export function TutorialLayer() {
  const st = useStore();
  const i = st.tut;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, setTick] = useState(0);
  // the tour step, or a one-time tip (tips never show during the tour)
  const step: Step | null = i !== null ? STEPS[i] : st.tip;
  const key = i !== null ? `t${i}` : st.tip ? `p${st.tip.key}` : "";
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
  }, [key, st.screen.name]);
  useEffect(() => {
    if (!step) return;
    const onResize = () => { const el = locate(step); setRect(el ? clip(el.getBoundingClientRect()) : null); };
    addEventListener("resize", onResize);
    addEventListener("scroll", onResize, true);
    return () => { removeEventListener("resize", onResize); removeEventListener("scroll", onResize, true); };
  }, [key]);
  if (!step || !st.s) return null;
  // let cutscenes, event choices and big alerts go first (they sit under this layer otherwise)
  if (st.s.cutscenes.length || st.s.events.length || (st.s.alerts?.length ?? 0) > 0) return null;
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
  if (i === null) {
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
  const last = i === STEPS.length - 1;
  return (
    <div class="tut-layer">
      <div class="tut-block" />
      {rect ? <Hole r={rect} /> : <div class="tut-dim" />}
      <div class="tut-box frame" style={{ width: W, ...box }}>
        <div class="tut-step">{i + 1} / {STEPS.length}</div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div class="tut-bar"><i style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} /></div>
        <div class="row" style={{ gap: 6 }}>
          <button class="btn small" onClick={endTutorial}>건너뛰기</button>
          <span class="grow" style={{ flex: 1 }} />
          {i > 0 && <button class="btn small" onClick={() => go(i - 1)}>이전</button>}
          <button class="btn small primary" onClick={() => go(i + 1)}>{last ? "시작하기" : "다음"}</button>
        </div>
      </div>
    </div>
  );
}
