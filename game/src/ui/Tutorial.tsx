// The tutorial: a dimmed screen with a lit "hole" over the part being explained and a box with the step,
// Back / Next / Skip. Steps can switch screens first. Layout idea from VCT Manager's guided tour (spotlight + step box
// + progress); the steps are this game's own.
// The tour comes in parts. The intro starts with every new game (and when a save that has not finished it is
// opened); the others start by themselves when the player gets there: after the first signing, after the head
// coach, once a head coach and five starters are signed, on the match screens (screens call tutSpot), after the
// first series, at the first event, and when the window opens again after the LCK Cup.
// A first run (a new game) is hands-on: some steps are the player's to do ("until"): the lit part takes clicks and the
// step ends when the game gets there, some screens hold their filters (tutLock), the first series stops for the
// set-break talk and the day after it brings a good event. Lines marked `first` are said in a first run only. Started
// again from Settings ("replay"), the tour only explains: no first-run lines, the hands-on steps show with Next.
// What was seen is kept in the save (GameState.tut), so each career gets each part once.
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { store, useStore } from "../store";
import type { GameState, Series } from "../core/types";
import type { Role } from "../data/types";
import { ROLES } from "../data/types";
import { comp } from "../core/schedule";
import { windowOpen } from "../core/market";
import { evState } from "../core/evmemo";
import { autosave } from "./App";
import { appH, appW, toLocal } from "./scale";
import "./tutorial.css";

/** Places the screens report (tutSpot), and what the player's steps wait for. */
export type Spot =
  | "series" | "draft" | "ban" | "pick" | "loadout" | "match" | "setbreak"
  | "signed" | "coach" | "series-done" | "goods"
  | "market" | "player" | "nego" | "staffnego" | "event" | "chosen" | "result" | "finance";

/** Filters a screen holds while a hands-on step is on (Market, Staff). */
export interface TutLock {
  marketRole?: Role;
  marketTab?: "fa";
  staffRole?: "hc";
}

type Text = string | ((s: GameState) => string);

interface Step {
  /** screen to open before showing the step */
  screen?: string;
  /** what to light up: a CSS selector, optionally the first match whose text starts with `text` (then its frame) */
  sel?: string;
  text?: string;
  /** light the whole of a long panel (a window with buttons at the bottom), not only its top */
  full?: boolean;
  title: string;
  body: Text;
  /** said after the body in a first run only (<처음>) */
  first?: string;
  /** said instead of the body in a first run */
  firstBody?: string;
  /** the whole step is for a first run only */
  firstOnly?: boolean;
  /** left out when this holds as the tour gets to it */
  skip?: (s: GameState, first: boolean) => boolean;
  /** the player does this one: the lit part takes clicks, there is no Next, and the step ends at this spot */
  until?: Spot;
  /** ...or as soon as this holds (`modal`: the window open, store.modal) */
  done?: (s: GameState, modal: string | undefined) => boolean;
  /** `until`, `done` and `lock` hold in a first run only; a replay shows the step with Next */
  hands?: boolean;
  /** a step the player does that may not be possible (money): Next is offered too */
  canNext?: boolean;
  lock?: TutLock;
  /** shown over the event windows (which hold the tour otherwise) */
  over?: boolean;
  /** first run: runs when the step comes up */
  arm?: (s: GameState) => void;
}

const tut = (k: string) => `[data-tut="${k}"]`;
const hasHC = (s: GameState) => s.teams[s.user].staff.some((id) => s.staff[id]?.role === "Head Coach");
/** the user's series under way today won its last game */
const lastGameWon = (s: GameState) =>
  s.series.find((x) => !x.done && x.day === s.day && (x.a === s.user || x.b === s.user) && x.games.length > 0)?.games.at(-1)?.winner === s.user;
const sir = (s: GameState) => (s.managerName && s.managerName !== "단장" ? `${s.managerName} 단장님` : "단장님");

const PARTS: Record<string, Step[]> = {
  intro: [
    {
      screen: "home", title: "단장 취임을 축하드립니다!",
      body: (s) => `${sir(s)}, ${s.teams[s.user].name}의 새로운 단장으로 부임하신 것을 축하드립니다! 아직 처음이셔서 낯서실 수 있으니, 제가 옆에서 도와드리겠습니다.`,
    },
    {
      screen: "home", sel: ".topbar .stat", text: "날짜", title: "1부 · 일정",
      body: "구단의 다음 일정을 확인할 수 있습니다.",
      first: "현재 Faker(T1)와 ShowMaker(DK)를 뺀 모든 선수와 감독이 FA인 상태로 시즌이 시작했습니다. 1월 14일 LCK 컵 개막 전까지 감독과 주전 5명을 갖춰야 합니다.",
    },
    { screen: "home", sel: ".topbar .stat", text: "자금", title: "1부 · 자금", body: "구단이 쓸 수 있는 돈입니다. 계약금과 이적료는 계약하는 순간 빠지고, 수익금은 매달 1일에 들어옵니다. 마이너스가 되면 게임이 오버되니 주의하세요!" },
    { screen: "home", sel: ".main h2", text: "할 일", title: "1부 · 할 일", body: "지금 꼭 해야 할 일을 여기서 확인할 수 있습니다.", first: "우선 주전 선수들을 영입해 볼까요?" },
    { firstOnly: true, sel: tut("todo-market"), until: "market", done: () => store.screen.name === "market", title: "1부 · 할 일", body: "할 일 패널의 '이적시장' 버튼을 눌러 보세요." },
    {
      screen: "market", sel: ".main table", hands: true, until: "player", done: (_s, m) => m === "player", lock: { marketRole: "Top", marketTab: "fa" },
      title: "1부 · 선수 찾기",
      body: "FA와 영입할 수 있는 선수 목록입니다. 포지션과 능력치, 요구 연봉을 보고 신중히 선택하세요. 선호도가 낮은 구단은 같은 조건에서 선수가 다른 팀을 고릅니다.",
      first: "우선 탑 포지션의 선수를 한 명 영입해 볼까요?",
    },
    {
      sel: tut("player-sign"), hands: true, until: "nego", done: (_s, m) => m === "nego",
      title: "1부 · 선수 영입",
      body: "선수를 누르면 선수의 능력치와 챔피언 숙련도를 확인할 수 있습니다. 신중히 선택하세요!\n그럼 선수와 협상을 시작해 볼까요?",
    },
    { sel: ".modal", title: "1부 · 협상", body: "선수를 누르면 협상이 시작됩니다. 면담에서 선수 성향에 맞는 답을 고르면 요구액이 내려갑니다. 그다음 연봉, 기간, 계약금, 주전 보장을 정해 제안합니다. 계약금은 서명할 때 한 번만 주는 돈으로, 월 급여를 늘리지 않고 요구액을 맞출 때 씁니다. 만약 선수를 만족시키지 못한다면 협상을 거절할 수도 있습니다." },
  ],
  // after the first signing (a replay goes on from the intro)
  signed: [
    { firstOnly: true, screen: "roster", sel: ".main h2", text: "주전 라인업", title: "1부 · 선수단", body: "첫 번째 선수를 영입하신 것을 축하드립니다!\n이곳에서 현재 영입한 선수들을 확인할 수 있습니다.\n만약 주전 자리가 공석인 상태로 경기를 시작할 경우, 2군 선수가 자동으로 콜업되니 주의하세요!" },
    { screen: "staff", sel: ".main h2", text: "감독 · 코치 목록", skip: (s, f) => f && hasHC(s), title: "1부 · 감독 영입", body: "이제 감독을 구할 차례입니다. 감독이 없으면 밴픽에서 추천을 거의 받지 못하고 팀 전력도 깎입니다. 감독과 코치의 밴픽 · 분석 능력이 높을수록 전력이 강해집니다." },
    {
      firstOnly: true, screen: "staff", sel: ".main h2", text: "감독 · 코치 목록", skip: hasHC, until: "staffnego", done: (_s, m) => m === "staffnego", lock: { staffRole: "hc" },
      title: "1부 · 감독 선임",
      body: "감독만 보이도록 목록을 골라 두었습니다. 밴픽 · 육성 · 동기부여 · 분석 능력과 명성, 우승 횟수, 요구 연봉을 비교해 보고 마음에 드는 감독의 '선임 협상'을 눌러 보세요.",
    },
    { sel: ".modal", skip: (s, f) => f && hasHC(s), title: "1부 · 감독 협상", body: "감독 선임도 선수 영입처럼 면담 3문항을 거친 뒤 연봉, 기간, 계약금을 정해 제안합니다. 감독마다 드러나지 않는 최저 연봉이 있어서, 너무 낮게 부르면 인내심이 떨어지고 결국 협상을 거부합니다. 합의하면 바로 팀에 합류합니다." },
  ],
  // after the head coach is hired (a replay goes on from "signed")
  coach: [
    { sel: ".topbar .stat", text: "월 급여", title: "1부 · 월 급여", body: "선수와 스태프 연봉 합계를 12로 나눈 돈이 매달 25일에 나갑니다. 고정 수입보다 크면 구단이 적자가 되니 주의하세요!" },
    {
      sel: ".topbar .stat", text: "이적시장", title: "1부 · 이적시장 기간",
      body: "이적시장이 열려 있을 때만 FA 영입과 이적을 할 수 있습니다. 1년에 세 번 열립니다.\n· 스토브리그: 11월 14일 ~ 1월 13일\n· LCK 컵이 끝난 뒤: 3월 초 ~ 3월 31일\n· MSI 개막 ~ 정규 시즌 3라운드 전: 6월 24일 ~ 8월 4일\n마우스를 올리면 다음 개장이나 마감까지 남은 날이 나옵니다.",
      first: "지금은 스토브리그라 열려 있습니다.",
    },
    { firstOnly: true, skip: (s) => readyForMatch(s), title: "1부 · 남은 준비", body: "이제 주전 다섯 명을 모두 채워 주세요. 감독과 주전 다섯 명이 갖춰지면 첫 경기로 가는 길을 안내해 드리겠습니다." },
  ],
  // once a head coach and five starters are signed (see readyForMatch)
  go: [
    { sel: ".topbar .btn.primary", until: "series", title: "2부 · 경기하러 가기", body: "축하드립니다 단장님! 드디어 감독과 주전 다섯 명이 모두 갖춰졌습니다. 드디어 첫 번째 경기를 진행할 시간입니다. '다음 경기까지 ▶'를 누르면 다음 경기 날까지 시간이 흐르고 경기 화면으로 넘어갑니다." },
  ],
  series: [
    { sel: tut("series-prep"), title: "2부 · 세트 준비", body: "진영 선택권이 있으면 블루(먼저 픽)와 레드(마지막 픽) 중에 고릅니다. 작전은 교전을 얼마나 거는지, 운영 방식은 감독의 경기 계획입니다. 밴픽 없이 결과만 보려면 '이 세트 결과만 보기'나 '시리즈 끝까지 결과만'을 누르세요." },
    { sel: tut("series-draft"), until: "draft", title: "2부 · 밴픽 시작", body: "'밴픽 시작'을 눌러 밴픽 화면으로 가 보세요." },
  ],
  // the first time it is our turn to ban
  ban: [
    { sel: tut("draft-head"), title: "밴픽 · 순서", body: "블루와 레드가 번갈아 고릅니다. 밴 3개씩 → 픽 3개씩 → 밴 2개씩 → 픽 2개씩 순서입니다. 여기에 지금 단계(빨간 '밴' · 금색 '픽')와 누구 차례인지, 몇 번째인지 나옵니다. 단계가 바뀌면 화면 가운데에 크게 알려 주고, 차례인 팀의 판에는 '밴 차례' · '픽 차례' 표시가 붙습니다." },
    { sel: tut("draft-grid"), title: "밴픽 · 챔피언 목록", body: "왼쪽 위 S · A 표시는 이번 패치에서 강한 챔피언, '너프'는 약해진 챔피언입니다. 초록 테두리는 감독이 이번 차례에 추천하는 챔피언입니다. 흐린 챔피언은 이미 밴 · 픽됐거나, 이번 시리즈에서 이미 써서(F, 피어리스) 고를 수 없습니다." },
    { sel: tut("draft-sug"), title: "밴픽 · 감독 추천", body: "감독이 이번 차례에 고를 만한 챔피언과 그 이유를 보여 줍니다. 누르면 그 챔피언이 후보로 올라갑니다(확정은 아래 버튼). 감독의 밴픽 능력이 높을수록 추천이 많고 정확합니다." },
    { sel: tut("draft-filter"), title: "밴픽 · 찾기", body: "포지션 버튼과 검색으로 목록을 좁힐 수 있습니다. '추천대로'를 누르면 감독이 고를 챔피언이 후보로 올라갑니다." },
    { sel: tut("draft-confirm"), title: "밴픽 · 확정", body: "챔피언을 누르면 먼저 후보로만 올라가고, 이 버튼을 눌러야 확정됩니다(Enter도 됨). 확정 전에는 다른 챔피언을 눌러 바꿀 수 있습니다. 버튼은 밴 차례에 빨간 '밴하기', 픽 차례에 금색 '선택하기'로 바뀝니다. 이제 밴할 챔피언을 골라 확정해 보세요." },
  ],
  // the first time it is our turn to pick
  pick: [
    { sel: tut("draft-mine"), title: "픽 · 넣을 자리", body: "우리 팀 판입니다. 금색 테두리가 이번 픽이 들어갈 자리이고, 다른 빈 자리를 누르면 그 포지션으로 바꿉니다. 고른 챔피언 아래에는 그 선수의 숙련도가 나옵니다." },
    { sel: tut("draft-grid"), title: "픽 · 선수의 선호 챔피언", body: "픽 차례에는 챔피언 아이콘 왼쪽 아래에 금색 숫자로 지금 자리 선수의 숙련도가 나옵니다. 선수가 많이 다뤄 본 선호 챔피언일수록 숫자가 높고, 숙련도가 높을수록 경기에서 잘 다룹니다. 숫자가 없는 챔피언은 그 선수가 프로 경기에서 써 본 적이 없는 챔피언입니다." },
    { sel: tut("draft-sug"), title: "픽 · 추천 픽", body: "픽 차례의 감독 추천은 어느 포지션에 넣을지와 이유(선수 숙련도, 프로 메타 출현율, 티어)를 같이 보여 줍니다. 추천을 누르면 그 포지션의 후보로 올라가고, 금색 '선택하기'를 눌러야 들어갑니다. 목록의 초록 테두리도 같은 추천입니다." },
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
  // first run: the set-break talk after the first game of a series that goes on (tutBreakDue)
  setbreak: [
    {
      firstOnly: true, sel: tut("series-break"), title: "3부 · 이벤트",
      body: (s) => "경기 중에도 이벤트가 생깁니다. 세트가 끝나고 시리즈가 이어질 때, 대기실에서 선수들에게 어떤 말을 할지 고를 수 있습니다. 고른 말에 따라 남은 세트 동안 선수들의 사기나 팀 합이 오르거나 내립니다.\n선택지 아래에는 일어날 수 있는 일이 적혀 있습니다. '~할 거예요'는 거의 확실한 일, '~할 수도 있어요'는 그럴 수도 있는 일입니다."
        + (lastGameWon(s) ? "\n보통은 세트를 내주고 끌려갈 때만 대기실에 들르지만, 이번에는 처음이라 보여 드립니다." : ""),
    },
    { firstOnly: true, sel: tut("series-break"), until: "setbreak", done: (s) => !!s.ev?.setBreak, title: "3부 · 이벤트", body: "선수들에게 할 말을 하나 골라 보세요." },
  ],
  // back home after the first series: move the clock on (a first run brings a good event the next day)
  after: [
    {
      sel: ".topbar .btn", text: "다음 날", hands: true, until: "event", done: (s) => s.events.length > 0,
      arm: (s) => { evState(s).tutPos = true; autosave(); },
      title: "3부 · 이벤트 [2]",
      body: "경기를 마쳤으면 다시 시간을 보내며 다음 일정을 진행합니다. 시간이 흐르다 보면 구단에 여러 가지 일이 생기는데, 이것을 이벤트라고 합니다.",
      firstBody: "첫 경기를 치르셨습니다, 수고하셨습니다! 이제 다음 일정을 진행해 볼까요? '다음 날'을 눌러 하루를 보내 보세요.",
    },
  ],
  // the first event window after that (over the window)
  event: [
    {
      over: true, full: true, sel: ".modal", title: "3부 · 이벤트 [2]",
      body: "구단에 이벤트가 생겼습니다. 시간을 보내다 보면 선수, 팬, 스폰서, 다른 구단과 얽힌 일이 생기고, 그때마다 어떻게 대응할지 골라야 합니다. 선택지 아래에는 일어날 수 있는 일이 적혀 있고, 돈이 드는 선택지는 금액이 함께 나옵니다.",
      first: "이번에는 좋은 소식이네요!",
    },
    {
      over: true, full: true, sel: ".modal", until: "chosen", done: (s) => !!s.ev?.result?.title || !s.events.length,
      title: "3부 · 이벤트 [2]",
      body: "하지만 늘 좋은 일만 생기지는 않습니다. 선수의 부상이나 불만, 구설수 같은 부정적인 이벤트도 생기고, 무엇을 고르느냐에 따라 결과가 달라집니다. 이제 선택지를 하나 골라 보세요.",
    },
    {
      over: true, full: true, sel: ".modal", skip: (s) => !s.ev?.result?.title, until: "result", done: (s) => !s.ev?.result?.title,
      title: "3부 · 이벤트 결과",
      body: "고른 선택지의 결과입니다. 선수 사기, 팬 수, 자금 같은 것이 바뀌고, 어떤 선택은 선수의 이벤트 기록에 남아 나중에 다른 이벤트로 이어지기도 합니다. 확인했으면 '확인'을 눌러 주세요.",
    },
  ],
  // right after the event part: money besides the monthly income, hands-on goods
  finance: [
    {
      firstOnly: true, sel: ".side .nav", text: "재정", until: "finance", done: () => store.screen.name === "finance",
      title: "4부 · 재정과 굿즈",
      body: "구단의 돈은 매달 들어오는 스폰서 · 분배금만으로 버는 것이 아닙니다. 경기에서 이기면 승리 수당이, 대회 성적에 따라 상금이 들어오고, 굿즈를 만들어 팔아 추가 수입을 얻을 수도 있습니다. 직접 한번 해 볼까요? 왼쪽 메뉴의 '재정 · 굿즈'를 눌러 보세요.",
    },
    { screen: "finance", sel: ".main .grid3", title: "4부 · 재정과 굿즈", body: "재정 · 굿즈 화면입니다. 위쪽에서 지금 자금과 매달 1일에 들어오는 고정 수입(스폰서, 리그 분배금, 방송 · 콘텐츠), 매달 나가는 지출을 볼 수 있습니다. 승리 수당, 상금, 굿즈 판매 수익은 고정 수입과 따로 들어옵니다." },
    { screen: "finance", sel: tut("goods"), title: "4부 · 굿즈 종류", body: "굿즈를 만들면 6주 동안 팔립니다. 먼저 위쪽 버튼으로 종류를 고릅니다. 포토카드 팩은 싸고 많이 팔리지만 남는 돈이 적고, 유니폼과 피규어는 대표 선수를 골라야 하며 그 선수의 인기에 따라 판매가 크게 달라집니다." },
    { screen: "finance", sel: tut("goods"), title: "4부 · 굿즈 수량", body: "수량을 고르면 아래에 제작비와 6주 동안 팔릴 것으로 보이는 개수, 예상 매출이 나옵니다. 예상치는 팬 수, 명성, 대표 선수 인기, 최근 성적으로 계산합니다. 다 팔지 못하고 남은 재고는 그대로 손해이니, 예상 판매량보다 조금 적게 만드는 것이 안전합니다." },
    {
      firstOnly: true, screen: "finance", sel: tut("goods"), full: true, until: "goods", canNext: true,
      title: "4부 · 굿즈 제작",
      body: "이제 직접 만들어 볼까요? 종류와 수량을 정하고 '제작'을 눌러 보세요. 제작비는 누르는 순간 자금에서 빠집니다. 자금이 모자라면 '다음'을 눌러 넘어가도 됩니다.",
    },
    { screen: "finance", sel: tut("goods"), title: "4부 · 판매 현황", body: "만든 굿즈는 1주마다 팔리고, 판매 수익은 그때그때 자금에 들어옵니다. 아래 판매 현황에서 팔린 개수와 매출을 확인할 수 있습니다. 성적이 좋고 팬이 많을수록 잘 팔리고, 동시에 세 종류까지 팔 수 있습니다." },
    { title: "기초 완료", body: "이제 구단 운영의 기초는 모두 익히셨습니다! 선수단과 감독, 경기, 이벤트, 재정까지 잘 챙겨서 LCK 정상에 올라 보세요. 튜토리얼은 저장 · 설정 화면에서 언제든 다시 볼 수 있습니다.\n행운을 빕니다, 단장님." },
  ],
  // the window open again after the LCK Cup
  trade: [
    { firstOnly: true, sel: ".topbar .stat", text: "이적시장", title: "5부 · 이적시장 재개장", body: "LCK 컵이 끝나고 이적시장이 다시 열렸습니다! 열려 있는 동안 FA 영입은 물론 다른 구단 선수의 이적과 트레이드도 할 수 있습니다. 부족한 포지션을 보강할 기회입니다." },
    { screen: "trade", sel: ".main .tabs", title: "5부 · 트레이드", body: "트레이드는 다른 LCK 구단과 선수를 맞바꾸는 것입니다. 먼저 위에서 상대 구단을 고릅니다." },
    { screen: "trade", sel: ".main .grid2", title: "5부 · 트레이드", body: "왼쪽에서 우리가 내줄 선수를, 오른쪽에서 데려올 선수를 고릅니다. 여러 명을 함께 고를 수 있고, 선수들의 계약은 그대로 넘어갑니다." },
    { screen: "trade", sel: tut("trade-send"), title: "5부 · 트레이드 제안", body: "가치가 모자라면 현금을 얹을 수 있습니다. '상대 반응 예상'을 보고 '제안하기'를 누르면, 상대 구단이 받는 선수의 가치(나이, 능력치, 남은 계약, 주전 여부)와 포지션 공백을 따져 수락하거나 거절합니다. 다른 구단이 먼저 트레이드를 제안해 오기도 하니, 이적시장의 '받은 제안'도 확인해 보세요." },
  ],
};

/** Parts that start at a spot the screens report (tutSpot), the first time. */
const SPOT_PARTS: Spot[] = ["series", "ban", "pick", "loadout", "match", "setbreak"];
/** Spots kept in the save, so the part waiting for them starts even if something else was on screen then. */
const FLAGS: Spot[] = ["signed", "coach", "series-done"];

// in the save's list: a part by its name, a spot by "@<spot>", a one-time tip as "tip:<key>", OFF once the player
// skipped, V2 for a save on this tour (a save that finished the older one has seen it and gets none of the new
// parts), REPLAY once started again from Settings
const OFF = "off";
const V2 = "v2";
const REPLAY = "replay";
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

type Mode = "first" | "replay" | "old";
function mode(): Mode {
  const r = record();
  if (!r) return "old";
  if (r.includes(REPLAY)) return "replay";
  return r.includes(V2) ? "first" : "old";
}
const isFirst = () => mode() === "first";
/** in this run of the tour */
const shown = (st: Step, first: boolean) => !st.firstOnly || first;
/** the player does it (the lit part takes clicks, no Next unless canNext) */
const acts = (st: Step, first: boolean) => !!st.until && (!st.hands || first);

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
  store.tut = { part, i: -1 };
  go(0);
}

/**
 * Start the tour: with a new game or an opened save, unless this save has seen the intro or turned the tour off;
 * from Settings (`force`), always, as a replay, with every part and tip of this save shown again.
 */
export function startTutorial(force = false) {
  const r = record();
  if (!r) return;
  if (force) {
    r.length = 0;
    r.push(V2, REPLAY);
    autosave();
  } else if (r.includes("intro") || r.includes(OFF)) {
    store.tut = null;
    return;
  } else if (!r.includes(V2)) {
    r.push(V2);
    autosave();
  }
  begin("intro");
}

/** This part is over (finished or skipped). */
function endPart(skip: boolean) {
  const t = store.tut;
  store.tut = null;
  if (t) mark(t.part);
  if (skip) {
    mark(OFF);
    // the good event asked for the next day belongs to the tour
    if (store.s?.ev?.tutPos) store.s.ev.tutPos = undefined;
  }
  store.bump();
}

/** Show step i of the running part, or the next one this run shows (the one before, going `back`). */
function go(i: number, back = false) {
  const t = store.tut;
  const s = store.s;
  if (!t || !s) return;
  const steps = PARTS[t.part];
  const first = isFirst();
  while (i >= 0 && i < steps.length && (!shown(steps[i], first) || steps[i].skip?.(s, first))) i += back ? -1 : 1;
  if (i < 0) return;
  if (i >= steps.length) return endPart(false);
  // a step the player did may have opened a window: going back, it is done again from there
  if (back) store.modal = null;
  store.tut = { part: t.part, i };
  const st = steps[i];
  if (first) st.arm?.(s);
  if (st.screen && store.screen.name !== st.screen) {
    store.modal = null;
    store.screen = { name: st.screen };
  }
  store.bump();
}

/**
 * The screens call this when the player gets somewhere (from an effect or a click). A step waiting for this spot
 * ends; with no part running, the part named after the spot starts the first time. Not in code matches.
 */
export function tutSpot(spot: Spot) {
  if (store.override || !store.s) return;
  if (FLAGS.includes(spot) && mode() !== "old") mark(`@${spot}`);
  const t = store.tut;
  if (t) {
    const st = PARTS[t.part][t.i];
    if (st.until !== spot || !acts(st, isFirst())) return; // a part on screen goes first
    go(t.i + 1);
    if (store.tut) return;
  }
  if (!SPOT_PARTS.includes(spot) || store.tip || seen(spot) || seen(OFF)) return;
  const first = isFirst();
  if (!PARTS[spot].some((st) => shown(st, first))) return;
  begin(spot);
}

/** The filters the screen on show holds for the step the player is doing (first run). */
export function tutLock(): TutLock | null {
  const t = store.tut;
  if (!t) return null;
  const st = PARTS[t.part][t.i];
  return st.lock && acts(st, isFirst()) ? st.lock : null;
}

/** First run: the set-break talk also comes after a won game, once, so the event part can show it. */
export function tutBreakDue(s: GameState, sr: Series): boolean {
  const r = record();
  if (!r || s !== store.s || !isFirst() || seen("setbreak") || seen(OFF) || s.ev?.setBreak?.sr === sr.id) return false;
  // one series only (kept as "sb:<series>"), even if the part could not show then
  const key = `sb:${sr.id}`;
  if (r.includes(key)) return true;
  if (r.some((k) => k.startsWith("sb:"))) return false;
  mark(key);
  return true;
}

/** A head coach and five starters: time to play. Only in a career that has not played a game yet. */
function readyForMatch(s: GameState): boolean {
  const me = s.teams[s.user];
  if (!hasHC(s)) return false;
  if (!ROLES.every((r) => me.lineup[r])) return false;
  return !s.series.some((sr) => (sr.a === s.user || sr.b === s.user) && sr.games.length > 0);
}

/** Parts that start by themselves, first match first: [part, when]. All need the intro seen. */
const AUTO: [string, (s: GameState, m: Mode) => boolean][] = [
  ["signed", (_s, m) => (m === "first" ? seen("@signed") : true)],
  ["coach", (_s, m) => (m === "first" ? seen("@coach") : seen("signed"))],
  ["go", (s) => readyForMatch(s)],
  ["after", () => seen("@series-done")],
  ["finance", () => seen("event")],
  ["trade", (s) => windowOpen(s) && !!comp(s, "CUP")?.done],
];

/** Light up at most the top 45% of the screen of a long panel (`full`: all of it), inside the viewport, so the step box fits below it. */
function clip(screenRect: DOMRect, full?: boolean): DOMRect {
  // measured in screen pixels; the lit box is placed in the app's CSS pixels (they differ under the screen zoom)
  const r = toLocal(screenRect);
  const H = appH(), W = appW();
  const top = Math.max(8, r.top);
  const bottom = Math.min(r.bottom, full ? H : top + H * 0.45, H - 8);
  const left = Math.max(8, r.left), right = Math.min(r.right, W - 8);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

function locate(st: { sel?: string; text?: string }): HTMLElement | null {
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

const BOX_W = 340, BOX_H = 250;

/** Where the step box goes: beside the lit part, else below or above it, else in the widest free strip at the edge. */
function boxPlace(rect: DOMRect | null): Record<string, string | number> {
  if (!rect) return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  const vw = appW(), vh = appH(), W = BOX_W;
  const y0 = Math.max(10, Math.min(vh - BOX_H - 10, rect.top));
  if (rect.right + 16 + W <= vw - 10) return { left: rect.right + 16, top: y0 };
  if (rect.left - 16 - W >= 10) return { left: rect.left - W - 16, top: y0 };
  const x = Math.min(vw - W - 10, Math.max(10, rect.left + 12));
  if (rect.bottom + 14 + BOX_H <= vh) return { left: x, top: rect.bottom + 14 };
  if (rect.top - 14 - BOX_H >= 0) return { left: x, top: rect.top - BOX_H - 14 };
  // a big window: the corner or side strip that covers the least of it (the box takes clicks, so it must not sit
  // on the buttons of a window the player is to use)
  const side = Math.max(rect.left, vw - rect.right) - 20;
  const w = Math.max(200, Math.min(W, side));
  const cands: Record<string, number>[] = [
    { left: Math.max(10, rect.left - w - 10), top: 10, width: w },
    { left: Math.max(10, rect.left - w - 10), top: vh - BOX_H - 10, width: w },
    { left: Math.min(vw - w - 10, rect.right + 10), top: 10, width: w },
    { left: Math.min(vw - w - 10, rect.right + 10), top: vh - BOX_H - 10, width: w },
    { left: 10, top: 10, width: W },
    { left: vw - W - 10, top: 10, width: W },
    { left: 10, top: vh - BOX_H - 10, width: W },
    { left: vw - W - 10, top: vh - BOX_H - 10, width: W },
  ];
  const cover = (b: Record<string, number>) =>
    Math.max(0, Math.min(b.left + b.width, rect.right) - Math.max(b.left, rect.left)) * Math.max(0, Math.min(b.top + BOX_H, rect.bottom) - Math.max(b.top, rect.top));
  return cands.reduce((a, b) => (cover(b) < cover(a) ? b : a));
}

export function TutorialLayer() {
  const st = useStore();
  const t = st.tut;
  const s = st.s;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, setTick] = useState(0);
  // the tour step, or a one-time tip (tips never show during the tour)
  const steps = t ? PARTS[t.part] : null;
  const step: Step | null = t ? steps![t.i] ?? null : null;
  const spot = step ?? st.tip;
  const key = t ? `${t.part}${t.i}` : st.tip ? `p${st.tip.key}` : "";
  const first = isFirst();
  // cutscenes, and outside the match screens event windows and alerts, go first (a step may be shown over events)
  const events = !!s && st.screen.name !== "series" && (s.events.length > 0 || !!s.ev?.result?.title);
  const alerts = !!s && st.screen.name !== "series" && (s.alerts?.length ?? 0) > 0;
  const scene = !!s && s.cutscenes.length > 0;
  const busy = scene || ((events || alerts) && !step?.over);
  useEffect(() => {
    if (!s || store.override || scene) return;
    // a step the player does ends as soon as the game is there
    if (t) {
      if (!step) endPart(false); // a part that changed under a running tour (an update)
      else if (acts(step, first) && step.done?.(s, st.modal?.kind)) go(t.i + 1);
      return;
    }
    // parts that start by themselves (outside the match screens, with nothing else open)
    if (st.tip || st.modal || st.screen.name === "series" || st.screen.name === "exhibition") return;
    const m = mode();
    if (m === "old" || !seen("intro") || seen(OFF)) return;
    if (events) {
      if (s.events.length > 0 && !s.ev?.result?.title && seen("after") && !seen("event")) begin("event");
      return;
    }
    if (alerts) return;
    for (const [part, when] of AUTO) {
      if (seen(part) || !when(s, m)) continue;
      if (!PARTS[part].some((x) => shown(x, m === "first") && !x.skip?.(s, m === "first"))) {
        mark(part); // nothing of it in this run: as seen
        continue;
      }
      begin(part);
      return;
    }
  });
  // measure after the screen for this step has rendered, and again on resize / scroll
  useLayoutEffect(() => {
    if (!spot) return;
    let raf = 0;
    const full = step?.full;
    const measure = () => {
      const el = locate(spot);
      if (el) {
        const r0 = el.getBoundingClientRect();
        // long panels (lists, tables): bring their top into view; short ones: center them if off screen
        if (!full && r0.height > innerHeight * 0.45) el.scrollIntoView({ block: "start" });
        else if (r0.top < 0 || r0.bottom > innerHeight * (full ? 1 : 0.7)) el.scrollIntoView({ block: full ? "nearest" : "center" });
      }
      setRect(el ? clip(el.getBoundingClientRect(), full) : null);
    };
    // a timer, not requestAnimationFrame: it also runs in a background tab, after the new screen has rendered
    raf = window.setTimeout(measure, 40);
    const again = () => setTick((x) => x + 1);
    addEventListener("resize", again);
    return () => { clearTimeout(raf); removeEventListener("resize", again); };
  }, [key, st.screen.name, st.modal?.kind, busy]);
  useEffect(() => {
    if (!spot) return;
    const onResize = () => { const el = locate(spot); setRect(el ? clip(el.getBoundingClientRect(), step?.full) : null); };
    addEventListener("resize", onResize);
    addEventListener("scroll", onResize, true);
    return () => { removeEventListener("resize", onResize); removeEventListener("scroll", onResize, true); };
  }, [key]);
  if (!spot || !s) return null;
  if (busy) return null;
  const box = { width: BOX_W, ...boxPlace(rect) };
  if (!t || !step) {
    // one-time tip: same look, a single button
    const tip = st.tip!;
    return (
      <div class="tut-layer">
        <div class="tut-block" />
        {rect ? <Hole r={rect} /> : <div class="tut-dim" />}
        <div class="tut-box frame" style={box}>
          <div class="tut-step">도움말 · 처음 한 번만 보입니다</div>
          <h3>{tip.title}</h3>
          <p>{tip.body}</p>
          <div class="row" style={{ justifyContent: "flex-end" }}>
            <button class="btn small primary" onClick={closeTip}>확인</button>
          </div>
        </div>
      </div>
    );
  }
  const i = t.i;
  const run = steps!.map((x, k) => ({ x, k })).filter(({ x }) => shown(x, first));
  const n = run.length;
  const at = run.findIndex(({ k }) => k === i) + 1;
  // Back, unless the step before is one the player did that would end again at once (going back closes the window)
  const before = run.filter(({ k }) => k < i).at(-1)?.x;
  const prev = !!before && !(acts(before, first) && before.done?.(s, undefined));
  const act = acts(step, first);
  const b0 = first && step.firstBody ? step.firstBody : step.body;
  const text = (typeof b0 === "function" ? b0(s) : b0) + (first && step.first ? `\n${step.first}` : "");
  const next = <button class="btn small primary" onClick={() => go(i + 1)}>{at >= n ? "확인" : "다음"}</button>;
  return (
    <div class="tut-layer">
      {/* a step the player does: only the lit part takes clicks (if it is not on screen, nothing is held back) */}
      {!act && <div class="tut-block" />}
      {rect ? <Hole r={rect} act={act} /> : !act && <div class="tut-dim" />}
      <div class="tut-box frame" style={box}>
        {n > 1 && <div class="tut-step">{at} / {n}</div>}
        <h3>{step.title}</h3>
        <p>{text}</p>
        {n > 1 && <div class="tut-bar"><i style={{ width: `${(at / n) * 100}%` }} /></div>}
        <div class="row" style={{ gap: 6 }}>
          <button class="btn small" title="남은 튜토리얼을 모두 끕니다. 저장 · 설정에서 다시 볼 수 있습니다." onClick={() => endPart(true)}>건너뛰기</button>
          <span class="grow" style={{ flex: 1 }} />
          {prev && <button class="btn small" onClick={() => go(i - 1, true)}>이전</button>}
          {act ? (
            <>
              <span class="gold" style={{ fontSize: 12 }}>빛나는 곳을 누르세요</span>
              {step.canNext && next}
            </>
          ) : next}
        </div>
      </div>
    </div>
  );
}
