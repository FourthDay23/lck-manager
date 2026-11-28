---
name: lolsim-dispatch
description: LoLSim 메인 세션(오케스트레이터)이 사용자 명령을 작업으로 나눠, 비슷한 작업 세션이 있으면 그 세션에 전달하고 없으면 새 작업 세션(워크트리)을 여는 절차. LoLSim 메인 세션에서 사용자가 기능 추가·수정·버그·데이터·화면 작업 등 무언가를 시킬 때마다 쓴다.
---

# LoLSim 명령 분배 (메인 세션 전용)

`orch` = `python -X utf8 $HOME/.claude/hooks/lolsim_orch.py`. 규약 본문은 저장소 `CLAUDE.md` 1~2절.

## 1. 쪼개기

- 결과물 하나 + 파일 묶음 하나 = 작업 하나. 서로의 결과가 필요한 일은 한 작업으로 묶거나 한 세션에 순서대로 준다.
- 질문 답, 현황, 간단한 조회는 메인이 직접 하고 끝낸다. 코드를 고치는 일은 아무리 작아도 작업 세션으로 보낸다.
- "다 반영해"는 전부 반영하라는 뜻이다. 빼거나 미루는 건 사용자에게 분명히 말한다.

## 2. 비슷한 세션 찾기

```
orch board --json        # tasks[].id / title / area / status / session
```

`list_sessions`로 그 세션이 살아 있는지도 확인한다. 후보는 status가 `queued`·`running`·`review`·`blocked`·`confirm`·`legacy`인 작업의 세션이다.
같은 기능이거나 `area`(파일·화면 영역)가 겹치면 비슷한 것으로 본다.

## 3a. 비슷한 세션이 있으면: 그 세션에 전달

- 같은 기능의 수정이나 추가(컨펌 대기 중인 것을 고치는 경우 포함)면 같은 ID를 쓴다.
  `orch set Txx --status running --note "추가 요청: …"`
- 같은 영역의 다른 기능이면 새 ID를 그 세션에 붙인다.
  `orch add "제목" --area "영역" --session <local_id> --name <이름>`
- 그 세션이 이미 진행 중 1개와 대기 1개를 들고 있으면 3b로 간다. 새 작업이 크고 파일이 겹치지 않을 때도 3b로 간다.
- 기존 세션(`legacy`)에는 새 기능을 보내지 않는다. 그 세션이 하던 작업의 수정만 보낸다.
- `SendMessage`(to = 그 세션의 `local_…` id):

  ```
  [LoLSim Txx] <한 줄 요약>
  <요청 내용: 사용자 말 그대로 + 필요한 맥락>
  완료 기준: …
  ```

## 3b. 없으면: 새 작업 세션

1. `orch add "제목" --area "<영역: 예) 밴픽 화면 DraftView·draft.css>"`로 ID를 받는다.
2. `start_session`을 다음 값으로 부른다.
   - initiation `"user_asked"`(사용자가 규약으로 지시한 분배), context `"fresh"`, `use_worktree: true`
   - `branch_name`: `txx-<짧은-영문>`, `name`: 같은 값, title: `Txx <제목>`
   - `background`(80자 이상): 프로젝트 한 줄(LCK 매니저 웹게임, `game/`은 Preact+Vite+TS, 사이트 lck-manager.kro.kr), 이 작업이 왜 필요한지, 다른 진행 중 작업과의 경계
   - `prompt`(브리프):

     ```
     [LoLSim Txx] <제목>

     너는 LoLSim 작업 세션이다. 이 작업 하나만 맡는다. 규약: 저장소 CLAUDE.md(특히 2~4절).
     먼저 `python -X utf8 $HOME/.claude/hooks/lolsim_orch.py setup Txx`를 실행한다(data/가 필요하면 --with-data).

     할 일: …(사용자 요청 그대로 + 구체화)
     범위: …(고칠 파일·화면·함수, 건드리지 말 것)
     완료 기준: …(어떻게 검증하는지까지)
     참고: …(위키 노트, 관련 커밋, 다른 작업 세션과의 경계)

     끝나면 /lolsim-finish. 진행 보고 메시지는 보내지 말고 상태는 orch set으로만 남긴다.
     사용자 결정이 필요하면 `orch set Txx --status blocked --note "질문"` 후 메인 세션에 SendMessage 한 번.
     ```
3. 돌아온 세션 id를 등록한다: `orch set Txx --session <local_id> --name <이름>`

### effort (2026-11-28 사용자 지시)

- 작업 세션은 항상 effort `xhigh`로 돌린다. `start_session`은 메인 세션보다 높은 effort를 줄 수 없어서, 메인이 medium이면 새 세션도 medium으로 열린다.
- 그래서 세션을 연 직후 `set_session_effort`(`xhigh`)를 부른다. 기존 세션에 일을 다시 보낼 때도 effort를 확인한다.

### 모델 지정 (사용자가 "[Fable]"처럼 모델을 정했을 때)

- `start_session`의 `model`은 메인 세션보다 비싼 모델(Opus 메인에서 Fable)을 무시하고, 메인과 같은 모델로 연다(2026-11-27 확인).
- 그래서 이렇게 연다.
  1. 브리프 맨 위에 "이번 첫 턴에는 `orch setup Txx`만 하고 '준비 끝' 한 줄로 끝낸다. '시작' 메시지를 받으면 본 작업"을 넣어서 연다.
  2. 곧바로 `set_session_model`(`claude-fable-5-2`)로 바꾼다. 다음 턴부터 적용된다.
  3. `SendMessage`로 `[LoLSim Txx] 시작`을 보낸다.
  4. `get_session`의 `model`로 확인한다.
- 본 작업 브리프를 첫 턴에 넣어 이미 돌기 시작했으면 `stop_session`으로 멈추고, 모델을 바꾼 뒤 "이어서 진행"을 보낸다.

## 4. 사용자에게 보고

작업마다 한 줄씩 쓰고, 끝에 현황판(`orch board`)을 붙인다.

- `T08 킬 배너 색 조정 → [기존 세션 제목](#local_…)에 전달`
- `T09 선수 상세 그래프 → 새 세션 [T09 선수 상세 그래프](#local_…)`

나중에 작업 세션이 턴을 끝냈다는 알림이 오면 `orch show Txx`로 상태를 본다. 사용자에게는 완료(`confirm`: 요약, 데모 파일 `SendUserFile`, 컨펌 질문), 결정 필요(`blocked`: 질문), 실패만 전한다.
