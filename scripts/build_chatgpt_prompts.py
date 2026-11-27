"""Write ready-to-paste ChatGPT prompts for layered pixel portraits (face layer per person + outfit templates).

  python scripts/build_chatgpt_prompts.py

Output:
  data/team_photos/chatgpt_prompts.md     how to use, the shared specs, every prompt to paste
  data/team_photos/chatgpt_batches.json   which person sits in which cell of which batch grid (read by
                                          scripts/portrait_layers.py to cut the grids into face layers)
The numbers in the prompts (canvas, chin line, neck, collar, key colours) come from scripts/portrait_layers.py,
which also checks and aligns what ChatGPT returns.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_photo_sheet import manifests, photo_of  # noqa: E402
from build_portrait_sheet import groups  # noqa: E402
from export_team_photos import ROLE_FILE, SECTION_DIR, safe  # noqa: E402
from portrait_layers import (CELL, CENTER_X, CHIN_Y, COLLAR_TOP_Y, KEYS, NECK_BOTTOM_Y, SCALE,  # noqa: E402
                             SUIT_FIXED, TEMPLATES)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "team_photos" / "chatgpt_prompts.md"
BATCH_FILE = ROOT / "data" / "team_photos" / "chatgpt_batches.json"
ROLE_KO = {"Top": "탑", "Jungle": "정글", "Mid": "미드", "Bot": "원딜", "Support": "서포터",
           "Head Coach": "감독", "Coach": "코치", "Strategic Coach": "전략 코치", "Analyst": "분석관"}
BATCH = 6
S = SCALE
NECK_L, NECK_R = (CENTER_X - 4) * S, (CENTER_X + 4) * S   # 8-block neck, 224..288

FACE_STYLE = f"""[얼굴 레이어 규격]
- 512×512 칸 하나에 한 사람. 64×64 픽셀아트를 8배로 키운 것처럼 8×8 블록 단위로만 칠해. 안티에일리어싱, 그라데이션, 블러, 노이즈 없이.
- 그리는 범위는 머리카락, 얼굴, 귀, 안경·수염 같은 얼굴 소품, 그리고 목까지야. 어깨, 옷, 옷깃, 목걸이, 헤드셋, 마이크는 그리지 마. 옷은 나중에 따로 입혀.
- 배경은 마젠타 #FF00FF 단색. 그림 안에는 마젠타와 비슷한 색(분홍, 보라)을 쓰지 마.
- 완전 정면. 고개를 돌리거나 기울이지 마.
- 위치 고정: 목의 가로 중심은 x={CENTER_X * S}. 턱 끝(목이 시작하는 줄)은 y={CHIN_Y * S}. 목은 폭 {NECK_R - NECK_L}px(x={NECK_L}~{NECK_R})로 곧게 내려와서 y={(NECK_BOTTOM_Y + 1) * S} 근처에서 수평으로 끊어.
- 크기 고정: 귀를 뺀 얼굴 폭은 약 192px. 정수리는 머리숱에 따라 y=56~112 사이.
- 칸 하나에 20색 이하. 외곽선은 1블록(8px) 두께의 어두운 색. 빛은 왼쪽 위에서.
- 첨부 사진 속 사람의 개성을 그대로 살려 줘: 머리 모양(앞머리, 가르마, 길이, 색), 안경 유무와 테 모양, 얼굴형, 눈매와 눈썹, 표정, 수염, 피부톤. 그 사람을 알아보게 하는 특징 하나는 조금 강조하되 우스꽝스럽게 만들지는 마.
- 그림 안에 이름, 글자, 숫자, 워터마크는 넣지 마. 모든 사람을 같은 화풍과 같은 크기로."""

KEY_LINES = "\n".join(f"  · {label}: {KEYS[key]}" for key, label in (
    ("main", "주색"), ("main_dark", "주색 그림자"), ("main_light", "주색 하이라이트"), ("sub", "보조색"),
    ("sub_dark", "보조색 그림자"), ("accent", "포인트색"), ("outline", "외곽선")))
TEMPLATE_STYLE = f"""[옷 템플릿 규격]
- 512×512 칸 한 장. 64×64 픽셀아트를 8배로 키운 것처럼 8×8 블록 단위로만 칠해. 안티에일리어싱, 그라데이션, 블러 없이.
- 배경은 마젠타 #FF00FF 단색.
- 상반신 옷만 그려: 어깨와 가슴이고, 칸 아래 끝까지 채워. 머리, 얼굴, 목, 피부는 그리지 마.
- 옷깃 윗선은 y={COLLAR_TOP_Y * S}. 목이 들어갈 자리(x={NECK_L}~{NECK_R}, y={COLLAR_TOP_Y * S}~{(COLLAR_TOP_Y + 4) * S})는 마젠타로 비워 둬. 어깨는 x=48~464까지.
- 색은 아래 키 색만 정확한 값 그대로 써. 게임이 이 색을 팀 색으로 바꿔 칠해:
{KEY_LINES}
- 로고, 글자, 숫자, 스폰서는 넣지 마. 정면이고, 빛은 왼쪽 위에서.
- 첨부한 얼굴 레이어(style_ref)의 목 위치와 폭에 옷깃이 딱 맞게 그려."""


def team_names() -> dict[str, str]:
    data = ROOT / "game" / "public" / "data"
    names = {t["id"]: t["name"] for t in json.loads((data / "teams.json").read_text(encoding="utf-8"))["teams"]}
    names.update({t["id"]: t["name"] for t in json.loads((data / "intl.json").read_text(encoding="utf-8"))["teams"]})
    return names


REPO_PATHS = {
    "ref": "data/team_photos/",                      # reference photos: <ref><folder>/<photo>
    "style": "style_ref.png",                        # the approved face from step 1
    "raw": "data/portrait_layers/raw_templates/",    # ChatGPT outfit drawings
    "gen": "data/portrait_layers/generated/",        # ChatGPT face grids
    "retakes": "data/portrait_layers/retakes/",      # one-person redraws, named like the face file
    "cmd": "python scripts/portrait_layers.py",
    "report": "data/portrait_layers/faces/faces_report.json",
}


def main() -> None:
    text, batches, jobs = build(REPO_PATHS)
    OUT.write_text(text, encoding="utf-8")
    BATCH_FILE.write_text(json.dumps(batches, ensure_ascii=False, indent=1), encoding="utf-8")
    (BATCH_FILE.parent / "chatgpt_jobs.json").write_text(json.dumps(jobs, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{OUT}: {len(batches)} batches, {sum(len(b['people']) for b in batches)} faces, {len(jobs)} jobs; {BATCH_FILE}")


def build(paths: dict) -> tuple[str, list, list]:
    """The prompt document, the batch list and the generation jobs, with every path relative to `paths` (repo or kit).

    A job is one image to generate: {"id", "step", "prompt", "attachments" (in order), "output", "size"}.
    """
    manifest, sman = manifests()
    names = team_names()
    jobs: list[dict] = []

    def fenced(job_id: str, step: int, prompt: list[str], attachments: list[str], output: str, size: str) -> list[str]:
        jobs.append({"id": job_id, "step": step, "prompt": "\n".join(prompt), "attachments": attachments,
                     "output": output, "size": size})
        return ["```", *prompt, "```", ""]
    L = [
        "# ChatGPT 선수·감코 픽셀 초상화 프롬프트 (얼굴 레이어 + 옷 템플릿)",
        "",
        "게임은 **배경 → 얼굴 레이어 → 옷 템플릿(지금 소속팀 색으로 칠함)** 순서로 겹쳐 그려. 그래서 이적하거나, FA가 되거나, 새 구단이 생겨도 옷만 바뀌고 얼굴을 다시 그릴 필요가 없어.",
        "",
        "## 순서",
        f"1. **얼굴 스타일 확정** (1단계): Faker 사진 한 장으로 얼굴 레이어를 뽑아. 마음에 드는 결과를 `{paths['style']}`로 저장해.",
        f"2. **옷 템플릿 5장** (2단계): 각 프롬프트에 `{paths['style']}`를 첨부해서 뽑아. 결과는 `{paths['raw']}<이름>.png`로 저장해.",
        f"3. **팀별 얼굴** (3단계): 배치마다 적힌 사진을 순서대로 첨부하고, 마지막에 `{paths['style']}`를 붙여. 결과 격자(1536×1024)는 `{paths['gen']}<팀폴더>/batch<N>.png`로 저장해.",
        "4. **손질** (아래 명령): 격자를 잘라 64×64 레이어로 만들고, 턱 위치를 맞추고, 겹친 미리보기를 만들고, 빠진 게 없는지 검사해.",
        "",
        "```",
        f"{paths['cmd']} templates",
        f"{paths['cmd']} faces",
        f"{paths['cmd']} preview",
        f"{paths['cmd']} check",
        "```",
        "",
        "- 같은 채팅에서 계속 이어 가면 화풍이 덜 흔들려. 채팅을 새로 열면 규격 블록과 style_ref를 꼭 다시 넣어.",
        "- ChatGPT가 좌표를 정확히 지키진 못해. 손질 스크립트가 8px 격자를 찾아 64×64로 줄이고, 마젠타 배경을 지우고, 목 위치로 정렬해.",
        f"- `{paths['report']}`에서 note가 ok가 아닌 사람과 check가 알려 준 문제만 4단계로 다시 뽑으면 돼.",
        "",
        "참고: 실제 인물을 바탕으로 한 그림이라, 게임을 공개 배포하면 초상권·퍼블리시티권 문제가 생길 수 있어. 개인 프로젝트 안에서 쓰는 걸 전제로 했어.",
        "",
        "## 규격",
        "",
        "```",
        FACE_STYLE,
        "```",
        "",
        "```",
        TEMPLATE_STYLE,
        "```",
        "",
        "## 1단계: 얼굴 스타일 확정 (Faker)",
        "",
        f"첨부: `{paths['ref']}1_LCK/01_T1/03_Mid_Faker.png` · 저장: `{paths['style']}`",
        "",
        *fenced("style_ref", 1, [
            "첨부한 사진은 LoL 프로게이머 Faker야. 내가 만드는 e스포츠 매니저 게임에 쓸 '얼굴 레이어'를 이 사람을 참고해서 그려 줘.",
            "게임에서는 이 얼굴 위에 옷을 따로 겹쳐 입히니까, 얼굴과 목만 그리고 옷은 그리지 마.",
            "",
            FACE_STYLE,
            "",
            "결과는 512×512 한 장. 이 그림이 앞으로 모든 얼굴 레이어의 스타일 기준(style_ref)이 될 거야.",
        ], [f"{paths['ref']}1_LCK/01_T1/03_Mid_Faker.png"], paths["style"], "1024x1024"),
        "## 2단계: 옷 템플릿 5장",
        "",
        f"모두 첨부: `{paths['style']}`(1단계 결과). 저장 위치: `{paths['raw']}`",
        "",
    ]
    for name, (title, desc, fixed) in TEMPLATES.items():
        extra = ""
        if fixed:
            extra = "\n- 이 템플릿에만 쓰는 고정색: " + ", ".join(f"{k} {v}" for k, v in fixed.items()) + \
                    " (셔츠 흰색과 그림자, 재킷과 재킷 그림자). 이 색은 팀이 바뀌어도 그대로야."
        L += [
            f"### {title} → `{paths['raw']}{name}.png`",
            "",
            *fenced(f"template_{name}", 2, [
                f"첨부한 이미지는 내 게임의 얼굴 레이어(style_ref)야. 같은 화풍으로, 이 얼굴 아래에 겹쳐 입힐 '{title}' 옷 템플릿을 그려 줘.",
                "",
                TEMPLATE_STYLE + extra,
                "",
                f"디자인: {desc}",
                "결과는 512×512 한 장.",
            ], [paths["style"]], f"{paths['raw']}{name}.png", "1024x1024"),
        ]
    L += ["## 3단계: 팀별 얼굴 배치", ""]
    batches_json = []
    section = None
    counts = {}
    n_batches = 0
    for g in groups():
        sec = SECTION_DIR.get(g["section"], "4_OTHER")
        counts[sec] = counts.get(sec, 0) + 1
        team_id = next((c["team"] for c in g["cells"] if c["team"]), "OTHER")
        folder = f"{sec}/{counts[sec]:02d}_{safe(team_id)}"
        if g["section"] != section:
            section = g["section"]
            L += [f"### {section}", ""]
        team_name = names.get(team_id, g["title"])
        files, seen = [], {}
        for i, c in enumerate(g["cells"], 1):
            role = c["role"] if c["kind"] == "player" else ROLE_FILE.get(c["role"], safe(c["role"]))
            if photo_of(c, manifest, sman)[0] is None:
                continue
            key = (c["kind"], c["name"].lower())
            if key in seen:  # staff.json lists kkOma / KkOma (and two more pairs) twice: one face for both ids
                seen[key]["alsoIds"].append(c["id"])
                continue
            person = {"id": c["id"], "alsoIds": [], "kind": c["kind"], "name": c["name"], "role": c["role"],
                      "photo": f"{i:02d}_{role}_{safe(c['name'])}.png",
                      "face": f"{'p' if c['kind'] == 'player' else 's'}_{safe(c['id'])}.png"}
            seen[key] = person
            files.append(person)
        k = -(-len(files) // BATCH)
        sizes = [len(files) // k + (1 if i < len(files) % k else 0) for i in range(k)]
        L += [f"#### {team_name} — 참고 사진 폴더 `{paths['ref']}{folder}/`", ""]
        start = 0
        for b, size in enumerate(sizes, 1):
            batch = files[start:start + size]
            start += size
            n_batches += 1
            batches_json.append({"folder": folder, "team": team_id, "batch": b, "people": batch})
            kinds = {p["kind"] for p in batch}
            who = "선수" if kinds == {"player"} else "감독·코치" if kinds == {"staff"} else "선수와 감독·코치"
            roster = "\n".join(f"{n}. {p['name']} — {ROLE_KO.get(p['role'], p['role'])}" for n, p in enumerate(batch, 1))
            L += [
                f"배치 {b} ({len(batch)}명) · 첨부 순서: " + ", ".join(f"`{p['photo']}`" for p in batch) + f", `{paths['style']}`"
                f" · 저장: `{paths['gen']}{folder}/batch{b}.png`",
                "",
                *fenced(f"{folder}/batch{b}", 3, [
                    f"첨부한 사진 {len(batch)}장은 LoL e스포츠 팀 {team_name}의 {who}야. 첨부 순서대로 아래 사람들이고, 마지막 첨부 이미지는 화풍 기준(style_ref)이야.",
                    roster,
                    "",
                    "style_ref와 똑같은 화풍, 똑같은 얼굴 크기와 목 위치로 한 사람씩 얼굴 레이어를 그려 줘. 얼굴과 목만 그리고 옷은 그리지 마.",
                    "",
                    FACE_STYLE,
                    "",
                    "결과는 1536×1024 이미지 한 장으로 줘. 512×512 칸 6개짜리 3열×2행 격자이고, 왼쪽 위부터 오른쪽으로 첨부 순서대로 채워. "
                    "칸 사이에 간격이나 테두리는 두지 말고, 칸마다 위 위치 규격을 똑같이 지켜. 남는 칸은 마젠타 #FF00FF로 비워 둬.",
                ], [f"{paths['ref']}{folder}/{p['photo']}" for p in batch] + [paths["style"]],
                    f"{paths['gen']}{folder}/batch{b}.png", "1536x1024"),
            ]
    L += [
        "## 4단계: 한 명만 다시 뽑기",
        "",
        f"첨부: 그 사람 사진 1장 + `{paths['style']}`. 결과 512×512 한 장은 `{paths['retakes']}<얼굴 파일 이름>`으로 저장해. "
        "얼굴 파일 이름은 batches.json의 `face` 값이야(예: `p_Faker.png`). 다음에 faces를 돌리면 격자 칸 대신 이 그림을 써.",
        "",
        "```",
        "첨부한 첫 사진은 {팀 이름}의 {닉네임}({포지션 또는 감독/코치})이야. 두 번째 이미지(style_ref)와 똑같은 화풍, 똑같은 얼굴 크기와 목 위치로 이 사람의 얼굴 레이어를 다시 그려 줘. 얼굴과 목만 그리고 옷은 그리지 마.",
        "",
        FACE_STYLE,
        "",
        "결과는 512×512 한 장.",
        "```",
        "",
        "## 고칠 때 붙이는 말",
        "",
        "- 닮지 않았을 때: `사진과 덜 닮았어. 머리 모양과 앞머리 방향, 안경테 모양을 사진에 더 가깝게 맞춰 줘.`",
        "- 옷이나 어깨가 그려졌을 때: `어깨와 옷은 빼고 목까지만 그려 줘. 목 아래는 마젠타 배경이야.`",
        "- 크기나 위치가 다를 때: `style_ref와 얼굴 크기, 턱 위치, 목 폭이 달라. style_ref에 맞춰 다시 그려 줘.`",
        "- 고개가 돌아갔을 때: `완전 정면으로 다시 그려 줘.`",
        "- 픽셀이 뭉개질 때: `픽셀 경계가 흐려졌어. 8×8 블록이 딱 떨어지게, 안티에일리어싱 없이 다시.`",
        "- 배경이 마젠타가 아닐 때: `배경을 #FF00FF 단색으로 다시 칠해 줘.`",
        "- 옷 템플릿 색이 틀릴 때: `키 색 7개(#FF0000, #990000, #FF8080, #00FF00, #009900, #0000FF, #000000) 말고 다른 색은 쓰지 마.`",
        "",
        f"얼굴 배치 {n_batches}개, {sum(len(b['people']) for b in batches_json)}명.",
    ]
    return "\n".join(L), batches_json, jobs


if __name__ == "__main__":
    main()
