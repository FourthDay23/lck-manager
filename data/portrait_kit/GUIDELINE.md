# LoLSim 선수·감코 픽셀 초상화 키트 — 작업 지침

이 폴더 하나로 작업이 끝나게 만들었다. **이 문서를 처음부터 끝까지 읽고, 적힌 순서대로 작업해 줘.**
결과물은 게임(LoLSim, LCK e스포츠 매니저 게임)에 그대로 들어간다. 그래서 규격 숫자와 파일 이름은 바꾸면 안 된다.

## 0. 요약

- 선수와 감독·코치 289명의 **얼굴 레이어**(64×64 픽셀아트, 얼굴과 목만)와 **옷 템플릿** 5장을 만든다.
- 게임은 배경 → 얼굴 → 옷 순서로 겹쳐 그린다. 옷은 소속팀 색으로 다시 칠한다. 그래서 이적하거나 FA가 되면 옷만 바뀐다. 얼굴에 옷을 그리면 안 되는 이유가 이거다.
- 그림을 그리는 건 이미지 생성(너의 이미지 도구 또는 OpenAI API)이 하고, 크기·정렬·검사는 `tools/portrait_layers.py`가 한다.
- 생성할 그림은 총 64장이다: 스타일 기준 1장, 옷 템플릿 5장, 팀별 얼굴 격자 58장. 목록은 `prompts/jobs.json`에 있다.

## 1. 폴더 구성

| 경로 | 내용 |
|---|---|
| `GUIDELINE.md` | 이 문서 |
| `spec/LAYER_SPEC.md` | 레이어 규격과 게임이 색을 바꾸는 규칙(참고용) |
| `prompts/jobs.json` | **생성할 그림 목록.** 항목마다 `id`, `step`(1~3), `prompt`(그대로 쓸 프롬프트), `attachments`(참고 이미지, 순서대로), `output`(저장 경로), `size` |
| `prompts/prompts.md` | 같은 프롬프트를 사람이 읽기 좋게 정리한 문서, 한 명 다시 그리기와 고칠 때 쓰는 말 |
| `prompts/batches.json` | 얼굴 격자의 칸마다 누가 들어가는지(`people[i]`는 i+1번째 칸), 얼굴 파일 이름(`face`) |
| `reference/<리그>/<NN_팀>/` | 참고 사진 289장(384px)과 팀 시트 `00_sheet.png`, 36팀 |
| `data/teams.json` | 팀 id → 이름, 팀 색. 미리보기에서 쓴다 |
| `tools/portrait_layers.py` | 손질 스크립트: 자르기, 64×64로 줄이기, 배경 지우기, 정렬, 검사, 미리보기 |
| `tools/generate_with_openai_api.py` | (선택) OpenAI API로 jobs.json을 차례로 생성 |
| `tools/requirements.txt` | 파이썬 패키지 |
| `work/` | **네가 저장하는 곳**: `style_ref.png`, `raw_templates/`, `generated/`, `retakes/` |
| `output/` | 스크립트가 만드는 결과물 |

## 2. 최종 결과물과 완료 조건

- `output/faces/`: 얼굴 레이어 289장(`p_<id>.png`는 선수, `s_<id>.png`는 감코), `index.json`(id → 파일), `faces_report.json`
- `output/templates/`: `jersey_a.png`, `jersey_b.png`, `jersey_c.png`, `suit.png`, `hoodie.png`
- `output/preview.png`: 겹쳐 그린 확인용 그림
- `output/check_report.json`: 검사 결과
- 완료 조건: `python tools/portrait_layers.py --kit . check`가 `problems 0`을 출력한다. 끝내 못 고친 사람이 있으면 그 목록과 이유를 보고에 적는다.

## 3. 그림 규격 (요약, 바꾸지 말 것)

- 모든 그림은 64×64 픽셀아트를 8배로 키운 것이다(픽셀 1개 = 8×8 블록, 칸 하나 = 512×512). 안티에일리어싱이나 그라데이션은 쓰지 않는다.
- 배경은 **마젠타 `#FF00FF` 단색**이다. 스크립트가 이 색을 투명으로 바꾼다. 그림 안에는 분홍이나 보라를 쓰지 않는다.
- 얼굴 레이어: 완전 정면이고 얼굴과 목만 그린다. 어깨, 옷, 헤드셋은 그리지 않는다.
  - 64×64 좌표로 목 중심 x=32, 턱 끝 y=40, 목은 y=54 근처까지다. 512px 칸에서는 x=256, y=320이다.
  - 개성(머리 모양, 안경, 얼굴형, 눈매, 수염, 피부톤)은 참고 사진대로 살린다. 우스꽝스럽게 만들지 않는다.
- 옷 템플릿: 상반신 옷만 그리고, 옷깃 윗선은 y=46(칸에서는 368)이다. 목 자리는 마젠타로 비운다. **아래 키 색만** 쓴다(정장만 고정색 4개를 더 쓴다).

| 키 색 | 뜻 |
|---|---|
| `#FF0000` | main |
| `#990000` | main_dark |
| `#FF8080` | main_light |
| `#00FF00` | sub |
| `#009900` | sub_dark |
| `#0000FF` | accent |
| `#000000` | outline |

- 글자, 숫자, 로고, 스폰서, 워터마크는 어떤 그림에도 넣지 않는다.
- 정확한 문구는 jobs.json의 `prompt`에 다 들어 있으니 **프롬프트를 고쳐 쓰지 말고 그대로 써.**

## 4. 작업 순서

### 4-1. 준비
```
pip install -r tools/requirements.txt
python tools/portrait_layers.py --kit . selftest
```
selftest가 `PASS`를 출력해야 한다. 이 명령은 가짜 그림으로 손질 과정을 점검한다.

### 4-2. 1단계: 스타일 기준(`step` 1, job `style_ref`)
- `attachments`(Faker 사진)를 참고 이미지로 넣고 `prompt`로 생성해서 `work/style_ref.png`에 저장한다.
- **여기서 멈추고 사용자에게 style_ref를 보여 줘서 확인을 받는다.** 사용자가 처음부터 "확인 없이 끝까지"라고 했으면 그대로 계속한다.
- style_ref는 이후 모든 그림의 화풍 기준이다. 마음에 안 들면 이 단계에서 다시 뽑는다.

### 4-3. 2단계: 옷 템플릿 5장(`step` 2)
- 다섯 job 모두 `work/style_ref.png`를 첨부하고, 결과를 `work/raw_templates/<이름>.png`에 저장한다.
- 다 되면 `python tools/portrait_layers.py --kit . templates`를 실행한다. 이 명령이 키 색에 딱 맞춘 64×64 템플릿을 `output/templates/`에 만든다.

### 4-4. 3단계: 팀별 얼굴 격자 58장(`step` 3)
- jobs.json 순서대로 진행한다. `attachments`를 **적힌 순서대로** 넣는다. 사람 사진들이 먼저고 마지막이 style_ref다.
- 결과는 `output` 경로에 저장한다(`work/generated/<리그>/<팀>/batch<N>.png`). 결과는 1536×1024 이미지로, 512 칸이 3열×2행이다. 칸 순서가 곧 사람 순서다.
- 화풍이 흔들리지 않게 **10장마다** 아래 명령으로 중간 점검한다. 문제가 몰려 있으면 프롬프트를 바꾸지 말고 style_ref를 다시 첨부해서 다시 뽑는다.
```
python tools/portrait_layers.py --kit . faces
python tools/portrait_layers.py --kit . check
```

### 중간 저장 (대화가 끊겨도 이어서 하려면)
- 채팅 환경은 대화가 끝나면 작업 파일이 사라질 수 있다. 그래서 **1·2단계가 끝났을 때, 그리고 얼굴 격자 10장마다** `work/` 폴더를 `work_progress.zip`으로 묶어서 사용자가 내려받게 줘.
- 다음 대화에서 사용자가 키트 zip과 `work_progress.zip`을 같이 올리면, `work/`를 그 내용으로 채운다. 이미 있는 결과는 다시 만들지 말고, jobs.json에서 `output` 파일이 없는 job부터 이어서 한다.

### 4-5. 손질, 검사, 다시 뽑기
```
python tools/portrait_layers.py --kit . templates
python tools/portrait_layers.py --kit . faces
python tools/portrait_layers.py --kit . preview
python tools/portrait_layers.py --kit . check
```
- `output/check_report.json`과 `faces_report.json`(`note`가 `ok`가 아닌 사람)에 나온 사람만 다시 뽑는다.
- 한 명만 다시 뽑을 때는 prompts.md의 '4단계' 프롬프트를 쓴다. 그 사람 사진과 style_ref를 첨부하고, 결과를 `work/retakes/<face 파일 이름>`으로 저장한다(예: `work/retakes/p_Faker.png`). 다음에 faces를 돌리면 격자 대신 이 그림을 쓴다.
- 눈으로도 확인한다. `output/preview.png`에서 얼굴과 옷이 겹치는 자리가 맞는지, 닮았는지 본다.

### 4-6. 넘겨주기
- `output/` 폴더 전체와 `work/style_ref.png`를 묶어서 `portrait_output.zip` 하나로 준다.
- 보고에 적을 것:
  - 생성한 그림 수
  - 다시 뽑은 사람과 이유
  - check 결과(`problems` 수)
  - 못 만든 사람과 이유(예: 이미지 도구가 생성을 거절함)

## 5. 이미지 생성 방법 (둘 중 하나)

- **A. 너의 이미지 생성 기능**: job마다 `prompt`를 그대로 쓰고, `attachments`의 파일을 그 순서대로 참고 이미지로 넣는다. 결과를 `output` 경로에 저장한다.
- **B. OpenAI API**: `OPENAI_API_KEY`가 환경변수에 있을 때만 쓴다. 키는 파일이나 출력에 쓰지 않는다.
```
python tools/generate_with_openai_api.py --kit . --dry-run
python tools/generate_with_openai_api.py --kit . --step 1
python tools/generate_with_openai_api.py --kit . --step 2
python tools/generate_with_openai_api.py --kit . --step 3
python tools/generate_with_openai_api.py --kit . --only "<job id>" --force
```
이미 있는 결과는 건너뛴다. style_ref가 아직 없으면 2·3단계 job은 '기다림'으로 표시된다.

## 6. 지켜야 할 것

- 규격 숫자, 파일 이름, 폴더 구조를 바꾸지 않는다. 게임과 `index.json`이 이 이름으로 찾는다.
- jobs.json의 프롬프트를 임의로 줄이거나 바꾸지 않는다. 고칠 때는 prompts.md의 '고칠 때 붙이는 말'을 덧붙인다.
- 참고 사진은 비슷하게 그리기 위한 자료일 뿐이다. 결과물은 픽셀아트 그림이어야 하고, 사진을 그대로 붙이거나 가공하지 않는다.
- `reference/` 사진은 저작권이 Riot·각 팀·각 촬영자에게 있다. 키트 밖으로 퍼뜨리지 않는다. 실제 인물이 바탕이라 공개 배포에는 초상권 문제가 있을 수 있다(사용자의 개인 프로젝트용).
- 생성이 거절되거나 막힌 job은 건너뛰고 기록해 둔다. 마지막에 한꺼번에 보고한다.

## 7. 화면 색 참고

게임 UI 배경은 `#141826`이다. 미리보기도 이 색 위에 그린다.
