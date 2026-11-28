---
name: lolsim-finish
description: LoLSim 작업 세션이 맡은 작업(Txx)을 끝낼 때의 완료 절차. 검사, 필요하면 code-review, 자기 브랜치에 커밋·GitHub 푸시, 스크린샷·영상·로컬 데모 제작, 요약·패치노트 초안 등록 순서로 한다. 작업 세션에서 구현과 자체 검증이 끝났을 때 쓴다.
---

# LoLSim 작업 완료 절차 (작업 세션 전용)

`orch` = `python -X utf8 $HOME/.claude/hooks/lolsim_orch.py`. 작업 ID는 프롬프트의 `[LoLSim Txx]`다. 규약 본문은 `CLAUDE.md` 4절.
메인 폴더는 건드리지 않는다. 예외는 `demos/Txx/` 하나다.

## 0. 검사

- `npm --prefix game run check`(tsc)를 돌린다. 작업과 관련된 검증 스크립트(`game/scripts/*-check.ts` 등)가 있으면 그것도 돌린다. Git Bash가 경로를 망가뜨리면 PowerShell에서 실행한다.
- 실패하면 고칠 때까지 다음 단계로 가지 않는다.
- 엔진·밸런스 수치를 확인하는 측정은 `CLAUDE.md` 3-1절대로 한다.
  - 자기 변경 확인은 짝 비교로 짧게 한다: `node scripts/ab.mjs calibrate.ts 200 3 --base main --until kills:1,length:0.5`.
  - 200판 이상 큰 보정은 하지 않는다. 필요한 보정 명령은 요약에 적어 병합 뒤 통합 보정으로 넘긴다.
  - 2분 넘는 측정은 `node scripts/par.mjs …`로 백그라운드에서 돌린다.
  - 끊을 때는 자기가 띄운 PID만 끊는다. 이름이나 패턴으로 끊지 않는다.
  - 엔진을 결과가 바뀌면 안 되는 방식으로 고쳤으면(속도, 리팩터) `scripts/engine-same.ts` 해시가 전과 같아야 한다.

## a. 코드 리뷰 (복잡하거나 큰 작업)

다음 중 하나라도 해당하면 한다.
- 엔진·시뮬(`game/src/match/`)을 고쳤다
- 세이브 구조나 `core` 상태를 고쳤다
- 파일 3개 이상 또는 150줄 이상 바꿨다
- 새 시스템을 만들었다

순서:
1. `orch set Txx --status review`
2. `code-review` 스킬을 `high`로 돌린다. 대상은 커밋 전 변경 전체, 이미 커밋했으면 이 브랜치.
3. 확인된 지적은 고치고 0번 검사를 다시 한다. 고치지 않은 지적은 이유를 요약에 적는다.

## b. 커밋·푸시

1. `git status`로 내 작업 변경만 있는지 확인한다. 데모 파일, `.vite/`, `.claude/launch.json`은 커밋하지 않는다(ignore돼 있다).
2. 커밋 메시지는 저장소 관례대로 한국어 한 줄로 쓴다(`git log --oneline -8` 참고). 예: `킬 배너: 연속 킬 병합, 64배속 밀림 해결`
3. `git push -u origin HEAD`. 실패하면 `orch set Txx --status blocked --note "푸시 실패: …"`.
4. main에 직접 커밋하거나 병합하지 않는다. 병합은 메인 세션이 컨펌 뒤에 한다.

## c. 데모 (실제로 어떻게 보이는지)

`orch demodir Txx`가 데모 폴더(`<메인 폴더>/demos/Txx/`)를 만들고 경로를 알려 준다.

- **화면이 바뀐 작업**: 데모 서버를 `preview_start`(name `lck-Txx`, `orch setup`이 만든 것)로 띄워 바뀐 화면을 직접 확인한다. 그다음 Playwright로 파일을 남긴다.

  ```python
  # <데모 폴더>/capture.py 로 저장하고: python -X utf8 capture.py
  from playwright.sync_api import sync_playwright
  URL, OUT = "http://localhost:53xx/", r"<데모 폴더>"
  with sync_playwright() as p:
      b = p.chromium.launch()
      ctx = b.new_context(viewport={"width": 1366, "height": 768}, record_video_dir=OUT)  # 영상이 필요 없으면 record_video_dir 빼기
      page = ctx.new_page()
      page.goto(URL); page.wait_for_load_state("networkidle")
      # … 바뀐 화면까지 클릭해서 이동 (DEV 빌드에는 window.__store가 있다) …
      page.screenshot(path=fr"{OUT}\01-무엇.png")
      ctx.close(); b.close()   # 영상은 ctx.close() 때 .webm으로 저장된다
  ```

  - 움직임이 중요한 기능(애니메이션, 경기 진행)은 영상을 남긴다. 변환: `ffmpeg -y -i <파일>.webm -pix_fmt yuv420p 02-무엇.mp4` 후 webm은 지운다.
  - 파일 이름은 `01-설명.png`, `02-설명.mp4`처럼 순서와 내용을 담는다. 바뀌기 전과 비교가 필요하면 지금 사이트(https://lck-manager.kro.kr, 바뀌기 전 상태)에서 같은 화면을 찍어 `00-전.png`로 남긴다.
- **화면에 안 보이는 작업**(엔진 수치, 데이터): 전/후 비교표를 README에 쓴다(보정 스크립트 출력, 지표).
- **`README.md`**(데모 폴더):

  ```
  # Txx <제목>
  무엇이 바뀌었나: 2~4줄
  파일: 01-… 무엇을 보여 주는지
  직접 보기: npm --prefix "<워크트리>/game" run dev -- --port 53xx 후 http://localhost:53xx → (클릭 경로)
  확인 못 한 것: …
  ```

## 등록하고 끝내기

```
orch set Txx --status confirm --commit <짧은 SHA> --demo "demos/Txx" \
  --summary "어떻게 했는지 1~2줄" \
  --patch-title "패치노트 제목" --patch "줄1|줄2|줄3"
```

- 패치노트 줄은 `game/src/ui/info/patchnotes.ts` 머리 주석 문체를 따른다. 한 줄짜리 명사구다. 예: "킬 배너 추가", "교전 시 벽을 뚫는 버그 해결"
- 마지막 메시지는 5줄 이내로 쓴다: 한 일, 검증 결과, 데모 경로, 확인 못 한 것. 메인 세션에 `SendMessage`로 따로 보고하지 않는다(턴이 끝나면 앱이 알린다).
- 큰 결정이나 함정을 발견했으면 wiki-memory로 위키에 남긴다.
