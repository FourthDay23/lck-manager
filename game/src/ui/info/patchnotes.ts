// Patch notes shown on the start screen (ui/info/InfoTabs.tsx), newest first.
// Version: a big update raises the middle number (0.4.2 -> 0.5.0), a small one the last (0.5.0 -> 0.5.1).
// Each line is a short noun phrase that fits on one line: "스킬 아이콘 개선", "교전 시 벽을 뚫는 버그 해결".
// Each line has a kind, shown as a small card in front of it:
//   UPD 업데이트 (new feature, content, screen)   FIX 수정 (change or tuning of what existed)   BUG 버그 픽스 (something was broken)
// Within a version the lines go UPD, then FIX, then BUG (the owner's rule). Write them in that order here;
// the screen sorts them the same way anyway (sortedItems), keeping the written order inside a kind.
// Dates are the days the work was actually done (git history).

export type PatchKind = "UPD" | "FIX" | "BUG";
export type PatchItem = [PatchKind, string];

export interface PatchNote {
  version: string;
  date: string; // YYYY-MM-DD
  title: string;
  items: PatchItem[];
}

/** Display order of the kinds, also the legend order. */
export const PATCH_KIND_ORDER: PatchKind[] = ["UPD", "FIX", "BUG"];
export const PATCH_KIND_LABEL: Record<PatchKind, string> = { UPD: "업데이트", FIX: "수정", BUG: "버그 픽스" };

/** A version's lines in display order: UPD, FIX, BUG (stable inside a kind). */
export function sortedItems(n: PatchNote): PatchItem[] {
  return n.items
    .map((it, i) => [it, i] as const)
    .sort((a, b) => PATCH_KIND_ORDER.indexOf(a[0][0]) - PATCH_KIND_ORDER.indexOf(b[0][0]) || a[1] - b[1])
    .map(([it]) => it);
}

export const PATCH_NOTES: PatchNote[] = [
  {
    version: "0.8.0",
    date: "2026-11-27",
    title: "챔피언 상성",
    items: [
      ["UPD", "LCK 실측 챔피언 상성 반영"],
      ["UPD", "밴픽 화면 상성 표시 추가"],
      ["UPD", "상대 조합 맞춤 상황템 도입"],
      ["UPD", "이적시장 개장·마감까지 남은 날 표시"],
      ["FIX", "라인전 맞상대 상성 반영"],
      ["FIX", "드래곤 처치 배너 한 줄 표시"],
      ["FIX", "승리 배너 승리 팀 이름 표시"],
      ["FIX", "스코어바 오브젝트 타이머 하나만 표시"],
    ],
  },
  {
    version: "0.7.1",
    date: "2026-11-27",
    title: "안내 창 다듬기",
    items: [
      ["UPD", "패치노트 항목 분류 카드 추가"],
      ["FIX", "안내 문서 단어 단위 줄바꿈 적용"],
      ["FIX", "안내 창 가로 폭 확대"],
    ],
  },
  {
    version: "0.7.0",
    date: "2026-11-27",
    title: "킬 배너와 밴픽 확정",
    items: [
      ["UPD", "경기 킬 배너 추가"],
      ["UPD", "퍼스트 블러드·멀티킬 배너 연출 추가"],
      ["UPD", "고배속 연속 킬 묶음 표시"],
      ["UPD", "밴·픽 단계별 색상 표시"],
      ["UPD", "밴픽 단계 전환 배너 추가"],
      ["UPD", "밴하기·선택하기 확정 버튼 도입"],
      ["UPD", "밴픽 확정 튜토리얼 안내 추가"],
      ["UPD", "화면 배율 설정 추가"],
      ["FIX", "100% 미만 배율의 픽셀 글꼴 깨짐 방지"],
      ["FIX", "시작 화면 창 높이 맞춤 적용"],
      ["FIX", "경기 화면 맵 크기 창 맞춤 적용"],
      ["FIX", "밴픽 챔피언 목록 창 높이 맞춤 적용"],
      ["FIX", "스크롤바 픽셀 스타일 변경"],
      ["BUG", "긴 감독 추천 글로 화면이 넓어지는 문제 해결"],
      ["BUG", "픽 자리 테두리 아래변 가림 해결"],
      ["BUG", "배율 변경 시 튜토리얼 강조 위치 어긋남 해결"],
    ],
  },
  {
    version: "0.6.1",
    date: "2026-11-27",
    title: "안내 탭 추가",
    items: [
      ["UPD", "시작 화면 하단 안내 탭 추가"],
      ["UPD", "서비스 안내·패치노트 게시"],
      ["UPD", "개인정보처리방침·이용약관 게시"],
    ],
  },
  {
    version: "0.6.0",
    date: "2026-11-27",
    title: "소환사 주문",
    items: [
      ["UPD", "선수 칸 소환사 주문 아이콘 추가"],
      ["UPD", "소환사 주문 재사용 대기시간 표시"],
      ["UPD", "맵 위 소환사 주문 사용 표시 추가"],
      ["UPD", "점화·탈진·회복 대상 표시 추가"],
      ["UPD", "순간이동 추가"],
      ["UPD", "유체화 추가"],
      ["UPD", "점멸 이니시 추가"],
      ["BUG", "점멸이 없는 챔피언의 점멸 사용 버그 해결"],
    ],
  },
  {
    version: "0.5.0",
    date: "2026-11-27",
    title: "선택지 이벤트",
    items: [
      ["UPD", "선택지 이벤트 시스템 도입"],
      ["UPD", "무작위 이벤트 36종 추가"],
      ["UPD", "사기 저하 이벤트 4종 추가"],
      ["UPD", "선택에 따른 후속 이벤트 11종 추가"],
      ["UPD", "세트 사이 대기실 이벤트 추가"],
      ["UPD", "약속 이행 여부 기록 반영"],
      ["UPD", "확률 기반 선택지 결과 안내"],
      ["FIX", "복귀 주전의 원래 포지션 복원"],
      ["FIX", "경기 당일 결원 자동 충원"],
    ],
  },
  {
    version: "0.4.2",
    date: "2026-11-27",
    title: "게임 오버와 튜토리얼 정비",
    items: [
      ["UPD", "밴픽·룬·관전 화면 튜토리얼 추가"],
      ["UPD", "자금 마이너스 시 게임 오버 도입"],
      ["UPD", "상단 자금 칸 위험 경고 추가"],
      ["UPD", "급여일 자금 부족 경고 추가"],
      ["FIX", "세이브별 튜토리얼 진행 기록"],
    ],
  },
  {
    version: "0.4.1",
    date: "2026-11-27",
    title: "성장 수치 보정",
    items: [
      ["FIX", "CS·레벨·골드 실제 LCK 기준 보정"],
      ["FIX", "리젠 시간 기반 정글 동선 개선"],
      ["FIX", "서포터 CS·골드 반영"],
      ["FIX", "라인전 이후 갱킹 조건 조정"],
      ["FIX", "킬 수·경기 시간 재보정"],
    ],
  },
  {
    version: "0.4.0",
    date: "2026-11-27",
    title: "경기 화면 개편",
    items: [
      ["UPD", "전체 맵 고정 카메라 도입"],
      ["UPD", "한타 확대 연출 추가"],
      ["UPD", "미니맵 교전·사망 위치 표시"],
      ["UPD", "라인전 이후 맞라이너 견제 추가"],
      ["FIX", "실제 배율 기준 4~64배속 적용"],
      ["FIX", "겹친 챔피언 아이콘 분산 표시"],
      ["FIX", "중계 자막 교체 주기 개선"],
      ["FIX", "교전 밖 유닛 대상 포탑 사격 적용"],
      ["FIX", "갱킹 실패 시 포기·재시도 적용"],
      ["FIX", "협곡의 전령 보관 후 사용 적용"],
    ],
  },
  {
    version: "0.3.2",
    date: "2026-11-27",
    title: "감독·코치 오류 수정",
    items: [
      ["BUG", "같은 감독·코치 중복 선임 버그 해결"],
      ["BUG", "기존 세이브의 중복 감독·코치 정리"],
      ["BUG", "계약 종료 감독의 감독 역할 복원"],
      ["BUG", "EWC 안내 반복 표시 버그 해결"],
    ],
  },
  {
    version: "0.3.1",
    date: "2026-11-27",
    title: "경기 데이터 표시",
    items: [
      ["UPD", "제작 중인 아이템의 보유 재료 표시"],
      ["UPD", "선수별 실시간 데이터 그래프 추가"],
      ["UPD", "결과 화면 선수별 기록 그래프 추가"],
      ["UPD", "감독·코치 협상 금액 조절 버튼 추가"],
      ["UPD", "트레이드 현금 조절 버튼 추가"],
    ],
  },
  {
    version: "0.3.0",
    date: "2026-11-26",
    title: "아이템·룬과 실제 스탯 전투",
    items: [
      ["UPD", "LCK 경기 통계 기반 아이템·룬 빌드 도입"],
      ["UPD", "골드 기반 귀환·구매 도입"],
      ["UPD", "킬 골드·제압골·오브젝트 현상금 반영"],
      ["UPD", "레벨·아이템 기반 실제 스탯 전투 도입"],
      ["UPD", "아이템 고유 효과·핵심 룬·패시브 반영"],
      ["UPD", "밴픽 이후 룬·빌드 선택 화면 추가"],
      ["UPD", "사건 직전 컷 전환 중계 카메라 도입"],
      ["UPD", "첫 플레이 튜토리얼 추가"],
      ["UPD", "선수 협상 금액 조절 버튼 추가"],
      ["UPD", "국제 대회 진출 안내 화면 추가"],
      ["UPD", "선수단 일괄 휴식 기능 추가"],
      ["UPD", "오브젝트 등장·처치 알림 추가"],
      ["UPD", "선수 줄 핵심 룬 배지 추가"],
      ["FIX", "실제 LCK 경기 기준 엔진 재보정"],
      ["FIX", "감독 추천 챔피언 즉시 픽 적용"],
      ["BUG", "선수 상세 화면 정렬 어긋남 해결"],
    ],
  },
  {
    version: "0.2.2",
    date: "2026-11-26",
    title: "중계 스코어바",
    items: [
      ["UPD", "LCK 중계풍 상단 스코어바 도입"],
      ["UPD", "다음 오브젝트 타이머 표시"],
      ["UPD", "용 스택·버프 남은 시간 표시"],
      ["UPD", "코드 대전 화면 스코어바 적용"],
      ["FIX", "스코어바 아이콘 원본 이미지 교체"],
    ],
  },
  {
    version: "0.2.1",
    date: "2026-11-26",
    title: "스킬 연출",
    items: [
      ["UPD", "대표 스킬 48종 전용 연출 추가"],
      ["UPD", "한타 실시간 진행 추가"],
      ["FIX", "유닛 이동 끊김 현상 개선"],
    ],
  },
  {
    version: "0.2.0",
    date: "2026-11-26",
    title: "경기 엔진 개편",
    items: [
      ["UPD", "지형 기반 길찾기 도입"],
      ["UPD", "팀 단위 운영 AI 도입"],
      ["UPD", "감독 운영 방식 6종 추가"],
      ["UPD", "챔피언별 실제 스킬 기반 한타 도입"],
      ["UPD", "스킬 명중·빗나감 표시 추가"],
      ["FIX", "스킬 이펙트 표현 개선"],
      ["BUG", "교전 시 벽을 뚫는 버그 해결"],
      ["BUG", "혼자 오브젝트를 처치하는 문제 해결"],
    ],
  },
  {
    version: "0.1.1",
    date: "2026-11-26",
    title: "협상 개선",
    items: [
      ["UPD", "감독·코치 선임 협상 추가"],
      ["FIX", "계약 조건 변경 시 요구액 환산"],
      ["FIX", "게임 내 문구 문체 통일"],
      ["BUG", "역제안 금액이 오르는 버그 해결"],
      ["BUG", "낮은 제안이 유리한 문제 해결"],
      ["BUG", "역제안 이후 협상 중단 버그 해결"],
      ["BUG", "경쟁 구단 입찰 미반영 문제 해결"],
    ],
  },
  {
    version: "0.1.0",
    date: "2026-11-26",
    title: "대회와 운영 확장",
    items: [
      ["UPD", "EWC 선발전·본선 일정 추가"],
      ["UPD", "2군 선수 콜업 추가"],
      ["UPD", "패치별 게임 내 메타 추가"],
      ["UPD", "다른 기기와 겨루는 코드 대전 추가"],
      ["UPD", "선수 선호도가 낮은 구단 4곳 지정"],
      ["UPD", "트레이드·이적 제안 알림창 추가"],
      ["UPD", "경기 중계 자막 추가"],
      ["UPD", "선수 피로 관리 추가"],
      ["UPD", "해외 팀 소속 LCK 출신 선수 탭 추가"],
      ["UPD", "구단별 난이도 표기"],
      ["FIX", "시작 화면 개편"],
      ["FIX", "어두운 팀 로고 가독성 개선"],
    ],
  },
  {
    version: "0.0.1",
    date: "2026-11-26",
    title: "첫 빌드",
    items: [
      ["UPD", "LCK·LCK CL 20개 구단 수록"],
      ["UPD", "실제 선수·감독·코치 데이터 수록"],
      ["UPD", "챔피언 173종 수록"],
      ["UPD", "이적시장·선수 협상·트레이드 도입"],
      ["UPD", "급여·수입 재정 시스템 도입"],
      ["UPD", "하루 단위 시즌 진행"],
      ["UPD", "초 단위 경기 시뮬레이션 엔진 제작"],
      ["UPD", "픽셀 그래픽 경기 중계 화면 제작"],
      ["UPD", "홈·로스터·트로피·감독·코치 화면 제작"],
      ["UPD", "게임 저장 기능 제작"],
    ],
  },
];

export const CURRENT_VERSION = PATCH_NOTES[0].version;
