# 게임 데이터 (2026-11-26 생성)

LCK 매니저 게임이 읽는 데이터. 아래 스크립트를 다시 돌리면 같은 파일이 다시 생성된다(작업 폴더 `Desktop\LoLSim`).

```
python scripts/fetch_ddragon.py 16.23.1     # Data Dragon 챔피언 JSON(ko_KR, en_US)과 초상화
python scripts/fetch_game_data.py           # Leaguepedia Cargo 조회. 결과는 data/cargo_cache/game_*.json에 캐시
python scripts/build_champions.py           # champions.json
python scripts/build_meta.py                # meta.json (draft는 data/draft_rules.json에서 읽음)
python scripts/build_game_data.py --sanity  # players.json, staff.json, teams.json, logos/(T1, NS)
python scripts/update_team_logos.py --tones # logos/ 8팀(data/logo_inbox/의 Leaguepedia 사본) + teams.json logo 필드
copy data/heatmaps/role_minute_grid.json game/public/data/heatmap.json
```

## 출처
- **Leaguepedia** (lol.fandom.com, api.php Cargo)
  - ScoreboardPlayers, ScoreboardGames: LCK 2025·2026, LCK CL 2025·2026, 국제전 2025·2026(First Stand, MSI, Worlds, EWC)
  - PicksAndBansS7: LCK 2025·2026 밴
  - TournamentRosters, RosterChanges: 로스터, 감독·코치 구분
  - PlayerRedirects·Players: 본명, 국적, 생일
  - Teams: 약칭
- **Riot 타임라인**: Leaguepedia `V5 data:*/Timeline`. LCK 2026 502경기, `data/raw`. gd15·솔킬·meta.json 계산에 씀.
- **Riot Data Dragon 16.23.1**: 챔피언, 스킬 이름·아이콘·쿨다운·사거리, 초상화.
  - 초상화 URL: `https://ddragon.leagueoflegends.com/cdn/16.23.1/img/champion/<id>.png`
  - 스킬 아이콘 URL: `.../img/spell/<icon>`
- **팀 로고**: 모두 256px 정사각형 투명 PNG다.
  - KT, DNS, BRO, BFX, KRX, DK, GEN, HLE: Leaguepedia의 `<팀>logo square.png` 판(2026-11-26 기준 최신).
    - Leaguepedia 이미지 서버(static.wikia.nocookie.net)는 스크립트 요청에 Cloudflare 챌린지를 띄운다. 그래서 사람이 브라우저로 저장한 1000px 사본(`data/logo_inbox/`)을 `scripts/update_team_logos.py`가 잘라 맞췄다.
    - KRX는 사용자가 따로 준 SVG(남색 사선 띠와 자홍 줄무늬)를 렌더링했다.
  - T1(Wikimedia Commons), NS(영어 위키백과): `build_game_data.py`가 받는다.
- **2026 규칙**
  - [Riot 2026 시즌 게임플레이 프리뷰](https://www.leagueoflegends.com/news/dev/dev-2026-season-one-gameplay-preview/)
  - [LoL Esports 2026 시즌 안내](https://lolesports.com/ko-KR/news/season-start-2026-lol-esports)
  - [한국경제 기사](https://www.hankyung.com/article/202601091682i)
  - [GosuGamers 기사](https://www.gosugamers.net/lol/news/77812-lol-esports-2026-introduces-new-draft-rule-first-selection-and-a-bo5-heavy-first-stand)

## 파일별 내용과 계산 방법

### champions.json (173명)
- `roles`
  - LCK와 LCK CL 2025~2026 프로 픽을 포지션별 비율로 나눈 값이다.
  - 픽이 3회 미만이면 Data Dragon 태그로 만든 사전값과 섞는다.
- `pro`: LCK 2025~2026에서 센 값이다.
  - picks, wins: ScoreboardPlayers
  - bans: PicksAndBansS7
  - presence: (픽+밴) / LCK 경기 수(1,057)
- `damage`: Data Dragon의 attack/magic 점수로 정하고, 주요 챔피언은 직접 지정했다.
- `color`: 초상화에서 채도 높은 색상 구간 중 가장 넓은 것의 평균색이다. VFX 틴트용.
- `style`: 0~10. 스킬 분류·태그·info로 계산한다. 주요 프로 챔피언 60여 명은 `build_champions.py`의 `STYLE_OVERRIDES`로 직접 정했다.
- `spells[].vfx` 분류 방법
  - 먼저 영어 설명의 키워드로 자동 분류한다.
  - 그다음 `OVERRIDES` 표(166명)에 적힌 스킬은 그 값으로 덮어쓴다. 프로 픽 상위 70명은 모두 표에 들어 있다.
  - 추가 필드 `also`: 두 번째 연출. 예: 말파이트 R = `dash` + `knockup`.
  - `radius`/`width`: 게임 좌표 단위.
  - `range`: Data Dragon 사거리. 25000은 자기 자신 대상이거나 전역 스킬이다.
  - `cd`: 1레벨 쿨다운.
  - `cc`: 직접 지정한 스킬은 적힌 대로이고, 나머지는 설명에 군중제어 단어가 있는지로 정했다.
  - `power`: 1~3.
- `passive.icon`: 추가 필드.

### players.json (156명: 1군 87, 2군 69)
- **범위**: LCK 2025·2026에 한 경기라도 뛰면 `tier` 1이다. LCK CL 2025·2026만 뛰었으면 `tier` 2다.
- **경기 점수**
  - 한 경기 점수 = 같은 리그·같은 포지션 안에서 낸 지표 z점수의 가중합이다.
  - 지표: 분당 딜·골드·CS·시야, 킬관여, log(1+KDA), 승패.
  - 포지션별 가중치는 `ROLE_WEIGHTS`에 있다.
- **성과(perf)**
  - 1군은 LCK 경기로만, 2군은 LCK CL 경기로만 계산한다. 주 포지션 경기만 쓴다.
  - 2026 경기는 1.0, 2025 경기는 0.6의 가중치를 준다.
  - 표본이 적으면 n/(n+15)로 줄인다.
- **OVR**
  - 1군: 64 + 12·perf + 6·출전량 + 우승(2025~26) + 국제전 경기 수 + 큰 무대 경력(2025 이전 롤드컵 우승, 최대 6.5)
  - 2군: 55 + 10·perf + 5·출전량
  - 출전량 = min(1, 경기 수/120)
  - 계산 뒤 다시 늘린다.
    - 1군: 100경기 이상 뛴 선수의 중앙값을 77, 1위를 95로 맞춘다.
    - 2군: 80경기 이상의 중앙값을 62, 1위를 71로 맞춘다. 중앙값 아래는 절반 기울기로 늘린다.
  - 최종 범위: 1군 64~95, 2군 50~71.
- **attrs**: 능력치 6종. 아래 지표의 z점수를 OVR 둘레의 개인 특성으로 펼쳐 보인 값이다. 6개 평균은 OVR 근처다.
  - laning: CS·골드·gd15
  - teamfight: 킬관여·딜·KDA
  - macro: 승률·시야·골드
  - mechanics: 딜·KDA·킬·솔킬
  - consistency: 경기 점수 편차와 데스
  - pool: 쓴 챔피언 수
- **stats**
  - 주 포지션·주 리그 경기의 평균이다.
  - `gd15`: 2026 LCK 타임라인에서 같은 포지션 상대와 15분 골드 차이. 2026 LCK 경기가 없으면 null.
  - `soloKills`: 2026 LCK에서 어시스트 없이 같은 포지션 상대를 잡은 수.
  - `ratedGames`: 추가 필드.
- **fame**: 아래를 합친 값이다. 2군은 0.6배를 곱한다.
  - LCK 경기 수, 국제전 경기 수
  - 2025~26 우승
  - 2025 이전 주요 우승(`LEGACY` 표에 직접 입력)
  - OVR
- **추가 필드**
  - `titles2526`: 그 선수가 실제로 뛴 대회의 우승
  - `lckGames`
  - `rosterOnly`: 로스터에만 있고 경기가 없는 선수. 지금은 0명.
- 상위 5명(포지션별)
  - Top: Kiin 92, Zeus 91, Doran 86, Siwoo 79, Kingen 77
  - Jungle: Canyon 93, Oner 89, Kanavi 84, Peanut 82, Lucid 79
  - Mid: Chovy 95, Faker 92, Zeka 89, ShowMaker 80, Bdd 76
  - Bot: Ruler 95, Gumayusi 93, Viper 89, Peyz 84, Smash 82
  - Support: Duro 93, Keria 91, Delight 88, Career 82, Kellin 77

### staff.json (62명: 감독 24, 코치 38)
- TournamentRosters에서 선수가 아닌 사람 중, RosterChanges의 마지막 합류 역할이 코치 계열인 사람만 넣었다.
  - Head Coach와 Interim Head Coach는 `Head Coach`로 묶었다.
  - 나머지 코치 직함(Assistant Coach 등)은 `Coach`로 묶었다.
  - 원래 직함은 `roleDetail`에 남겼다.
  - Leaguepedia 로스터에 Strategic Coach와 Analyst로 올라간 사람이 없어서 이 둘은 0명이다.
- `record`: 그 사람이 로스터에 있던 대회에서 팀이 거둔 세트 승패다.
- `titles`: 2025~26 우승. 국제전은 그해 같은 팀 LCK 로스터에 있었으면 센다.
- `fame`: 1군 여부, 우승, 승률, 감독 여부, `LEGACY` 표로 계산한다.

### teams.json (LCK 10팀 + LCK CL 10팀)
- `lastRoster`/`lastStaff`: 2026 마지막 대회 로스터. LCK는 플레이오프, 플레이인, 3~4라운드 순으로 찾는다.
- `lastRosterRoles`: 추가 필드. 그 대회에서 등록된 포지션이다.
  - 키움 DRX 챌린저스는 주 포지션이 정글인 Vincenzo가 원딜로 등록돼 있다(실제 데이터).
- `titles`
  - 2025~26 우승은 경기 기록에서 계산했다.
    - LCK: 플레이오프 우승팀
    - 국제전: 결승 마지막 세트의 승자
  - 그 이전 우승은 `TITLES_BEFORE_2025`에 직접 입력했다. 같은 조직으로 이어진 기록만 셌다.
    - 포함: SKT→T1, DAMWON→DK, 롱주/킹존→DRX, KT Arrows→KT
    - 제외: 삼성 시절은 젠지에, ROX 시절은 한화생명에 넣지 않았다.
  - 추가 키: `cup`(LCK컵), `firstStand`, `ewc`.
  - Leaguepedia TournamentResults는 2025 이전 롤드컵과 OGN 시절 기록이 대부분 빠져 있어서 쓰지 않았다.
- `eventWinners`: 추가 필드. 2025~26 대회별 우승팀.
  - 2026 롤드컵: BLG(결승에서 젠지 3:1)
  - MSI 2026: 한화생명
  - EWC 2026: DK
- `logo`: 20팀 모두 있다. 아카데미는 모기업 로고를 같이 쓴다.
  - 어두운 UI(`#111`) 위에서 보이는 정도: 명암비 2 미만 픽셀 비율이 0.5 이상이면 dark, 0.15 이하면 light다.
    - mostly dark(밝은 판을 깔아야 보임): DK, BRO, KRX(남색 띠), BFX(검은 원 안쪽. 노란 테두리 덕에 윤곽은 보임)
    - mixed: HLE(진회색 날개가 묻힘), NS
    - mostly light: KT, DNS, GEN, T1
- `colors`: `[주색, 보조색]`. 게임은 주색을 메뉴 강조 막대, 컷신 줄무늬, 선수 아바타 주색으로 쓴다.
  - DNS, BRO, KRX는 2026 로고에서 뽑았다.
    - DNS: `#0a51f1`/`#101828`
    - BRO: `#004c29`/`#f0f0f0`
    - KRX: `#d40881`/`#001c58`. KRX는 남색이 로고의 대부분이지만 어두운 UI에서 안 보여서 자홍을 주색으로 두었다.
  - BRO 주색은 메뉴 배경 `#222842`와의 명암비가 1.4라 강조 막대가 거의 안 보인다. DK의 `#000000`처럼 게임 쪽에서 밝혀 써야 한다.
- `wealth`(1~5), `fans`: 게임용 추정값이다. 실측값이 아니다.

### meta.json
- **measured**: LCK 2026 타임라인 502경기에서 직접 잰 값이다.
  - 게임 길이: 평균 32:13
  - 퍼스트 블러드: 평균 5:06
  - 첫 포탑
  - 분당 킬
  - 솔킬률(포지션별, 선수 1명·1경기 기준)
    - `soloKillRate`: 어시스트 없는 킬
    - `soloKillLane`: 그중 같은 포지션 상대를 잡은 킬
  - 멀티킬·에이스 빈도
  - 드래곤 종류 비율
  - 영혼 획득률 0.456
- **objectives**: 웹 출처와 데이터 최저 처치 시각을 함께 적었다.
  - 드래곤: 5:00, 리젠 5:00
  - 공허 유충: 8:00에 3마리 한 번
  - 전령: 15:00
  - 바론: 20:00(26.1에서 25분 → 20분), 리젠 6:00
  - 장로: 영혼 이후, 리젠 6:00
  - 아타칸: 26.1에서 삭제(`removed: true`). 502경기에 처치 기록 0건.
- **camps**
  - 리젠: 버프 5:00, 소형 캠프 2:15, 바위게 2:30
  - 첫 등장: 2026 프리뷰의 "35초 당김"을 적용해 0:55, 바위게 2:55
  - 데이터 확인: 정글러 정글 CS가 1:00에 0, 2:00에 평균 11.2
  - 칼날부리·돌거북이 다른 캠프보다 몇 초 늦게 나오는지는 확인 못 했다.
- **draft**: `data/draft_rules.json`에서 읽는다.
  - 20단계 대회 밴픽 순서. 2026부터 `B`는 선픽 팀, `R`은 후픽 팀이다(첫 번째 선택권으로 진영과 픽 순서가 분리됨).
  - 첫 번째 선택권: 1세트는 상위 시드, 이후는 직전 세트 패자가 갖는다.
  - 하드 피어리스 설명.
  - 5세트에 피어리스가 초기화되는지는 2025 LCK 운영 기준으로 적었다. 2026 규정집 원문은 읽지 않았다.
- **patch26**: 경기 엔진에 쓸 만한 26.1 변경점.

### intl.json (해외 팀, `scripts/build_intl.py`)
- **대상**: MSI 2026이나 Worlds 2026(플레이인 포함)에 나간 LCK 외 팀.
- **로스터**: 팀이 마지막으로 나간 대회에서 포지션별로 가장 많이 뛴 선수 5명.
- **능력치 척도**
  - 2025~2026 국제전(First Stand, MSI, Worlds, EWC) 전체 경기를 같은 포지션끼리 z점수로 비교해 성과 점수를 낸다. 그래서 지역이 달라도 한 척도에 올라간다.
  - 국제전과 players.json에 모두 있는 LCK 선수(국제전 8경기 이상)로 OVR 환산식을 맞췄다. 평균과 표준편차를 맞추는 방식이다. 회귀식을 쓰면 상위 선수가 가운데로 끌려와서 쓰지 않았다.
  - 환산식은 `calibration`에 있다.
- **LCK에서 이적한 선수**(예: Viper → BLG, kyeahoo → KC): players.json의 OVR과 능력치를 그대로 쓰고 `inPlayersJson: true`를 붙였다.
- **주력 챔피언**: 국제전 경기만으로 셌다. 해외 리그 국내 경기 기록은 받지 않았다.
- **`strength`**: 로스터 평균 OVR + 10 × (국제전 승률 − 0.5)를 60~95로 자른 값이다. 국제전 승률은 2025 경기 0.6, 2026 경기 1.0으로 가중했다.
- **로고**: 영어 위키백과 팀 문서에서 받았다. 못 찾으면 null이고, `colors`는 지역 기본색을 쓴다.
- **추가 필드**: `intlWinRate`, `events`, 선수별 `realName`·`birth`·`intlGames`.

### heatmap.json
`data/heatmaps/role_minute_grid.json`을 그대로 복사했다. 포지션×분(1~45)별 500유닛 칸(30×30) 생존 선수 표본 수이고, 자기 진영 시점이다.
