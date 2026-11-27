# 초상화 레이어 규격 (얼굴 + 옷 템플릿)

선수와 감코 초상화를 **얼굴 레이어**와 **옷 템플릿** 두 장으로 나눈다. 게임은 아래 순서로 겹쳐 그린다.

1. 배경 `#141826`
2. 얼굴 레이어
3. 옷 템플릿: 지금 소속팀 색으로 다시 칠한 것

그래서 이적하거나, FA가 되거나, 새 구단이 생기면 옷만 바뀐다. 얼굴은 사람마다 한 장으로 고정이다.

만드는 과정은 `data/team_photos/chatgpt_prompts.md`에 있다. ChatGPT 결과를 손질하는 건 `scripts/portrait_layers.py`가 한다.

## 파일

| 경로 | 내용 |
|---|---|
| `faces/<p_ 또는 s_><id>.png` | 얼굴 레이어. 64×64 RGBA이고 배경은 투명이다. `p_`는 선수, `s_`는 감코. |
| `faces/index.json` | 사람 id → 얼굴 파일 대응표. id는 players.json, staff.json의 id이고, 해외 선수는 `intl:<팀>:<id>`다. |
| `faces/faces_report.json` | 사람마다 어느 격자의 몇 번째 칸에서 왔는지, 정렬하면서 남긴 메모. |
| `templates/jersey_a.png`, `jersey_b.png`, `jersey_c.png` | 선수 유니폼 3종: 기본, 사선 띠, 가슴 띠. 64×64 RGBA이고 키 색으로만 칠해져 있다. |
| `templates/suit.png` | 감독·코치 정장. 재킷과 셔츠는 고정색이고, 넥타이와 배지만 키 색이다. |
| `templates/hoodie.png` | FA·신인 후드티. |
| `preview.png` | 확인용 그림. 소속팀, 다른 팀으로 이적, FA를 나란히 놓았다. |

## 위치 기준 (64×64 좌표)

- 얼굴 레이어: 목의 가로 중심은 x=32, 턱 끝(목이 시작하는 줄)은 y=40이다. 목은 최소 y=54까지 내려온다.
- 옷 템플릿: 옷깃 윗선은 y=46이다. 옷깃이 목 아래쪽을 덮어서 이음새가 보이지 않는다.
- 두 레이어 모두 크기가 같아서 (0,0)에 그대로 겹쳐 그리면 된다. 화면에서는 정수배로 키우고 `image-rendering: pixelated`를 쓴다.

## 옷 색 바꾸기 (`portrait_layers.team_palette`와 같은 규칙)

템플릿의 키 색을 팀 `colors` `[c0, c1]`로 바꾼다.

| 키 색 | 바꿀 색 |
|---|---|
| `#FF0000` 주색 | c0 |
| `#990000` 주색 그림자 | c0와 검정을 40% 섞은 색 |
| `#FF8080` 주색 하이라이트 | c0와 흰색을 45% 섞은 색 |
| `#00FF00` 보조색 | c1. 단, c0와의 명암비가 1.4 미만이면 포인트색으로 대신한다(예: TL). |
| `#009900` 보조색 그림자 | 보조색과 검정을 40% 섞은 색 |
| `#0000FF` 포인트색 | c0가 어두우면(상대휘도 0.3 미만) `#F0F0F0`, 아니면 `#101010` |
| `#000000` 외곽선 | `#0B0D14` |

- 정장의 고정색 4개(`#FFFFFF`, `#C8C8C8`, `#2A2D3A`, `#1A1C26`)는 바꾸지 않는다.
- 어떤 옷을 입힐지:
  - 소속팀이 있는 선수는 유니폼이다. 무늬는 팀마다 `jersey_for(팀id)`로 정한 기본값(crc32 % 3)을 쓰거나, 게임이 팀별로 따로 정해도 된다.
  - 감코는 `suit`다.
  - 팀이 없는 선수(FA·신인)는 `hoodie`이고, 색은 FA 기본색 `#3a4262` / `#1b1f2e`를 쓴다.
  - 팀이 없는 감코는 `suit`에 FA 기본색을 칠한다.
- 얼굴 파일이 없는 사람(게임이 만든 신인 등)은 지금 쓰는 12×12 생성 아바타를 그대로 쓴다.

## 다시 만들기

```powershell
python scripts/portrait_layers.py templates
python scripts/portrait_layers.py faces
python scripts/portrait_layers.py preview
python scripts/portrait_layers.py selftest
```

`selftest`는 일부러 어긋나게 만든 가짜 ChatGPT 그림으로 전체 과정을 돌려 본다. 확인하는 건 세 가지다.

- 격자 위치 찾기
- 마젠타 배경 지우기
- 턱과 목 정렬, 키 색 맞추기
