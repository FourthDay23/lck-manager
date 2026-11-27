# 소환사의 협곡 오브젝트 3D 렌더

ChatGPT에게 아이콘을 맡길 때 참고로 줄, 게임 속 3D 모델을 잘라 낸 그림이다. 배경은 투명하다.

- 그림은 모두 이 폴더 하나에 있다. 파일 이름 앞 숫자가 분류다(1 정글, 2 드래곤, 3 에픽, 4 미니언, 5 구조물). `_sheet.png`는 전체를 한 장에 모은 미리보기라 렌더가 아니다.
- 출처: LoL 위키(`wiki.leagueoflegends.com/en-us`)의 `... Render.png` 원본 파일. 파일마다 위키 문서 주소와 원본 URL은 `manifest.json`에 있다.
- 지금 소환사의 협곡 모습만 넣었다. 이벤트 맵 모습(아케인, URF, 칼바람 등), 옛 모델(`Render old`), 삭제된 공허 변형 정글몹은 뺐다.
- 아타칸은 26.1 패치에서 삭제됐다. 참고용으로만 넣었다.
- 바론 세 모습(사냥꾼, 모든 것을 보는, 영역)은 모델이 같고 머리 주변 장식과 색만 조금 다르다.
- 포탑, 억제기, 넥서스는 두 가지로 나뉜다.
  - `order`/`chaos`: 건물 모양. order는 파랑 진영(왼쪽 아래), chaos는 빨강 진영(오른쪽 위) 건물이다.
  - `blue`/`red`: 수정 빛 색. 게임에서는 내 편이 파랑, 상대가 빨강으로 보인다. 중계·관전 화면에서는 파랑 팀이 파랑, 빨강 팀이 빨강이라 `order_blue`와 `chaos_red`가 기본 모습이다.
  - `turret_plating_`: 포탑 방패(골드 방패). 14분 전까지 포탑 앞에 붙는 판이다.
- 미니언은 `_order`가 파랑 팀, `_chaos`가 빨강 팀이다.
- 그림 저작권은 Riot Games에 있고, 위키 내용은 CC BY-SA 3.0이다. 개인 프로젝트 참고용으로만 쓴다.
- 다시 받기: `python scripts/fetch_map_object_refs.py` (이미 받은 파일은 SHA-1이 같으면 건너뛴다)

| 파일 | 대상 | 모습 |
|---|---|---|
| `1_jungle_blue_sentinel.png` | 블루(푸른 파수꾼) |  |
| `1_jungle_red_brambleback.png` | 레드(붉은 덩굴정령) |  |
| `1_jungle_gromp.png` | 두꺼비(그롬프) |  |
| `1_jungle_ancient_krug.png` | 돌거북(크룩) | 고대 크룩(큰 놈) |
| `1_jungle_krug.png` | 돌거북(크룩) | 크룩(중간) |
| `1_jungle_mini_krug.png` | 돌거북(크룩) | 작은 크룩 |
| `1_jungle_greater_murk_wolf.png` | 늑대(어스름 늑대) | 큰 어스름 늑대 |
| `1_jungle_murk_wolf.png` | 늑대(어스름 늑대) | 어스름 늑대(꼬마) |
| `1_jungle_crimson_raptor.png` | 칼날부리 | 붉은 칼날부리(큰 놈) |
| `1_jungle_raptor.png` | 칼날부리 | 칼날부리(꼬마) |
| `1_jungle_rift_scuttler.png` | 바위게(협곡 바위게) |  |
| `2_dragon_base.png` | 드래곤(공통) | 원소 드래곤 기본형 |
| `2_dragon_all.png` | 드래곤(공통) | 드래곤 전체 모음 |
| `2_dragon_infernal.png` | 화염 드래곤 |  |
| `2_dragon_ocean.png` | 바다 드래곤 |  |
| `2_dragon_mountain.png` | 대지 드래곤 |  |
| `2_dragon_cloud.png` | 바람 드래곤 |  |
| `2_dragon_hextech.png` | 마법공학 드래곤 |  |
| `2_dragon_chemtech.png` | 화학공학 드래곤 |  |
| `2_dragon_elder.png` | 장로 드래곤 |  |
| `3_epic_baron_hunting.png` | 내셔 남작(바론) | 사냥꾼 바론(기본) |
| `3_epic_baron_all_seeing.png` | 내셔 남작(바론) | 모든 것을 보는 바론 |
| `3_epic_baron_territorial.png` | 내셔 남작(바론) | 영역 바론 |
| `3_epic_rift_herald.png` | 협곡의 전령 |  |
| `3_epic_voidgrub.png` | 공허 유충 | 공허 유충 |
| `3_epic_voidmite.png` | 공허 유충 | 공허 진드기(유충이 낳는 것) |
| `3_epic_atakhan_voracious.png` | 아타칸 (26.1에서 삭제, 참고용) | 탐식 아타칸 |
| `3_epic_atakhan_thornbound.png` | 아타칸 (26.1에서 삭제, 참고용) | 파멸 아타칸 |
| `4_minion_melee_order.png` | 근거리 미니언 | 파랑 팀 |
| `4_minion_melee_chaos.png` | 근거리 미니언 | 빨강 팀 |
| `4_minion_ranged_order.png` | 원거리(마법사) 미니언 | 파랑 팀 |
| `4_minion_ranged_chaos.png` | 원거리(마법사) 미니언 | 빨강 팀 |
| `4_minion_siege_order.png` | 공성 미니언(대포) | 파랑 팀 |
| `4_minion_siege_chaos.png` | 공성 미니언(대포) | 빨강 팀 |
| `4_minion_super_order.png` | 슈퍼 미니언 | 파랑 팀 |
| `4_minion_super_chaos.png` | 슈퍼 미니언 | 빨강 팀 |
| `5_turret_order_blue.png` | 포탑 | 파랑 진영 모양, 파란 빛 |
| `5_turret_order_red.png` | 포탑 | 파랑 진영 모양, 빨간 빛 |
| `5_turret_chaos_blue.png` | 포탑 | 빨강 진영 모양, 파란 빛 |
| `5_turret_chaos_red.png` | 포탑 | 빨강 진영 모양, 빨간 빛 |
| `5_turret_plating_order_blue.png` | 포탑 | 포탑 방패: 파랑 진영, 파란 빛 |
| `5_turret_plating_order_red.png` | 포탑 | 포탑 방패: 파랑 진영, 빨간 빛 |
| `5_turret_plating_chaos_blue.png` | 포탑 | 포탑 방패: 빨강 진영, 파란 빛 |
| `5_turret_plating_chaos_red.png` | 포탑 | 포탑 방패: 빨강 진영, 빨간 빛 |
| `5_inhibitor_order_blue.png` | 억제기 | 파랑 진영 모양, 파란 빛 |
| `5_inhibitor_order_red.png` | 억제기 | 파랑 진영 모양, 빨간 빛 |
| `5_inhibitor_chaos_blue.png` | 억제기 | 빨강 진영 모양, 파란 빛 |
| `5_inhibitor_chaos_red.png` | 억제기 | 빨강 진영 모양, 빨간 빛 |
| `5_nexus_order_blue.png` | 넥서스 | 파랑 진영 모양, 파란 빛 |
| `5_nexus_order_red.png` | 넥서스 | 파랑 진영 모양, 빨간 빛 |
| `5_nexus_chaos_blue.png` | 넥서스 | 빨강 진영 모양, 파란 빛 |
| `5_nexus_chaos_red.png` | 넥서스 | 빨강 진영 모양, 빨간 빛 |

총 52장.
