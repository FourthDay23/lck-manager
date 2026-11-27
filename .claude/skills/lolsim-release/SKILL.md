---
name: lolsim-release
description: LoLSim 메인 세션이 사용자의 최종 컨펌을 받은 작업을 main에 병합하고, 웹 패치노트를 쓰고, 사이트(lck-manager.kro.kr)에 배포하는 절차. 사용자가 컨펌 대기 작업을 "컨펌", "좋아 올려", "배포해", "반영해" 등으로 승인했을 때 쓴다.
---

# LoLSim 컨펌 후 배포 (메인 세션 전용)

`orch` = `python -X utf8 $HOME/.claude/hooks/lolsim_orch.py`. 규약 본문은 `CLAUDE.md` 5~6절. 모든 명령은 메인 폴더에서 실행한다.

## 0. 컨펌 범위

- 사용자가 승인한 작업 ID만 배포한다. 어느 작업인지 애매하면 묻는다. 컨펌 없이는 절대 배포하지 않는다.
- 승인된 작업마다 `orch set Txx --status approved`. 각 작업에 커밋이 기록돼 있어야 한다(`orch show Txx`의 `commit`; 없으면 `--commit <SHA>`). 배포가 끝나면 `orch released`가 배포본에 그 커밋이 들어 있는 작업만 완료로 바꾸고, 나머지는 '배포 대기'로 남긴다.

## 1. 병합

- `git status --short`로 메인 폴더 상태를 본다. 기존 세션의 미커밋 변경이 있을 수 있는데, 건드리지 않는다(stash·checkout·reset 금지).
- 작업마다 `git merge --no-ff <branch> -m "Txx <제목> 병합"`
- 충돌이 나면 경우에 따라 처리한다.
  - import 줄 같은 단순 충돌은 메인이 해결한다.
  - 로직이 부딪히면 `git merge --abort`. 그 작업 세션에 `[LoLSim Txx] main 기준으로 rebase해서 다시 푸시해 줘`를 보내고 `orch set Txx --status running`.
- 메인 폴더의 미커밋 파일과 겹쳐서 git이 병합을 거부하면, 그 파일을 가진 기존 세션의 마무리를 먼저 받거나 사용자에게 알린다.

## 2. 배포에 실릴 것 확인

- `orch board`의 사이트 커밋(live)을 기준으로 `git log --oneline <live 커밋>..main`을 본다.
- 승인 안 된 커밋이 섞여 있으면(기존 세션의 커밋 등) 목록을 사용자에게 보여 주고, 함께 배포해도 되는지 먼저 묻는다.

## 3. 패치노트 (e)

- `game/src/ui/info/patchnotes.ts`의 `PATCH_NOTES` 맨 앞에 새 항목을 넣는다.
  - `version`: 새 시스템·새 화면이 있으면 가운데 자리를 올리고(0.6.1 → 0.7.0), 수정·개선뿐이면 끝자리를 올린다(0.6.1 → 0.6.2).
  - `date`: 오늘(YYYY-MM-DD)
  - `title`: 대표 기능
  - `items`: 각 작업의 패치노트 초안(`orch show Txx`의 `patch`)을 파일 머리 주석 문체(한 줄 명사구)로 다듬어 합친다.
- 그 파일에 다른 세션의 미커밋 변경이 있으면 직접 커밋하지 말고 그 세션과 조율한다.
- `git add game/src/ui/info/patchnotes.ts`, `git commit -m "패치노트 vX.Y.Z"`

## 4. 검증 빌드 → 푸시 → 배포 (d)

1. `sh game/deploy/release.sh main --build-only`: 커밋된 main만 꺼낸 깨끗한 사본에서 tsc와 빌드를 확인한다. 실패하면 멈추고 원인 작업으로 돌려보낸다.
2. `git push origin main`
3. `sh game/deploy/release.sh`: 깨끗한 사본에서 빌드해서 dft-oracle에 올린다. 2분이 넘을 수 있으니 background로 실행한다. 성공하면 `orch released`가 자동으로 불려서 사이트 버전을 기록하고, `approved` 작업을 `done`으로 바꾼다.
4. 사이트 확인: https://lck-manager.kro.kr 시작 화면 하단의 `v…`가 새 버전인지, 새 기능이 보이는지 본다(내장 브라우저 `get_page_text` 또는 스크린샷).

## 5. 보고와 정리

- 사용자에게 알린다: 새 버전, 포함된 작업(한 줄씩), 사이트 링크, 패치노트 항목.
- 끝난 작업 세션은 아카이브를 제안한다. 아카이브하면 앱이 그 워크트리를 지운다. 사용자가 동의한 세션만:
  1. `orch cleanup Txx`: 워크트리 안의 연결을 해제한다. 연결이 있는 채로 지우면 원본이 같이 지워진다.
  2. `archive_session`
- 병합된 브랜치는 원격에 남겨도 된다. 지우려면 사용자에게 먼저 묻는다.
