"""Write ready-to-paste ChatGPT image prompts for every team folder in data/team_photos/.

  python scripts/build_chatgpt_prompts.py

Output: data/team_photos/chatgpt_prompts.md
  - how to use, the shared style block, a style-lock prompt (one sample first),
  - one prompt per batch of at most 6 people (players and coaches in separate batches), listing the files to attach
    in order with handle, role and the team colors from teams.json / intl.json,
  - a one-person retake prompt and short fix phrases.
The batch grid is 3 x 2 cells of 512 px (a 1536 x 1024 image), so a later script can cut it back into one file each.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_photo_sheet import manifests, photo_of  # noqa: E402
from build_portrait_sheet import groups  # noqa: E402
from export_team_photos import ROLE_FILE, SECTION_DIR, safe  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "team_photos" / "chatgpt_prompts.md"
ROLE_KO = {"Top": "탑", "Jungle": "정글", "Mid": "미드", "Bot": "원딜", "Support": "서포터",
           "Head Coach": "감독", "Coach": "코치", "Strategic Coach": "전략 코치", "Analyst": "분석관"}
BATCH = 6

STYLE = """[공통 스타일]
- 64×64 픽셀아트 흉상 초상화(가슴 위). 픽셀 하나를 8×8 블록으로 키워서 512×512 칸에 그려.
- 안티에일리어싱, 그라데이션, 블러, 노이즈 없이 경계가 딱 떨어지는 픽셀로. 칸 하나에 24색 이하.
- 정면이나 살짝 3/4 각도. 얼굴이 칸 높이의 절반쯤이고, 정수리 위에 여백을 조금 둬.
- 배경은 단색 #141826. 인물 외곽선은 1픽셀 어두운 색.
- 첨부 사진 속 사람의 개성을 그대로 살려 줘: 머리 모양(앞머리, 가르마, 길이, 색), 안경 유무와 테 모양, 얼굴형, 눈매와 눈썹, 표정, 수염, 피부톤. 그 사람을 알아보게 하는 특징 하나는 조금 강조하되 우스꽝스럽게 만들지는 마.
- 옷은 사진 속 옷 종류를 따라가. 선수는 팀 유니폼, 감코는 사진 속 옷(정장 등)이야. 유니폼 색은 아래 팀 색으로 단순화해. 실제 로고, 스폰서, 글자는 넣지 말고 색 덩어리로만 표현해.
- 그림 안에 이름, 글자, 숫자, 워터마크는 넣지 마.
- 모든 사람을 같은 화풍, 같은 조명(왼쪽 위에서 오는 빛), 같은 크기와 구도로."""

GRID = ("결과는 1536×1024 이미지 한 장으로 줘. 512×512 칸 6개짜리 3열×2행 격자이고, "
        "왼쪽 위부터 오른쪽으로 첨부 순서대로 채워. 칸 사이에 간격이나 테두리는 두지 말고, 남는 칸은 배경색 #141826으로 비워 둬.")


def team_names() -> dict[str, str]:
    import json
    data = ROOT / "game" / "public" / "data"
    names = {t["id"]: t["name"] for t in json.loads((data / "teams.json").read_text(encoding="utf-8"))["teams"]}
    names.update({t["id"]: t["name"] for t in json.loads((data / "intl.json").read_text(encoding="utf-8"))["teams"]})
    return names


def main() -> None:
    manifest, sman = manifests()
    names = team_names()
    lines = [
        "# ChatGPT 선수·감코 픽셀 초상화 프롬프트",
        "",
        "`data/team_photos/` 사진을 참고로, 게임에 맞는 64×64 픽셀아트 초상화를 만드는 프롬프트야.",
        "",
        "## 쓰는 법",
        "1. **스타일 확정**: 새 채팅에서 아래 '1단계' 프롬프트에 `1_LCK/01_T1/03_Mid_Faker.png` 한 장만 첨부해서 보내. 마음에 들 때까지 다시 뽑고, 고른 결과를 `style_ref.png`로 저장해 둬.",
        "2. **팀별 생성**: '2단계'의 배치를 하나씩 보내. 배치마다 적힌 파일을 **적힌 순서대로** 첨부하고, 마지막에 `style_ref.png`를 붙여. 배치 하나에 최대 6명이고, 1536×1024 격자 한 장이 나와.",
        "3. 같은 채팅에서 계속 이어 가면 화풍이 덜 흔들려. 채팅이 길어져 새로 열 때는 '공통 스타일'과 `style_ref.png`를 꼭 다시 넣어.",
        "4. 결과 격자는 `data/team_photos/generated/<팀폴더>/batch<N>.png`로 저장해 줘. 칸을 잘라 사람별 파일로 나누는 건 스크립트로 하면 돼.",
        "5. 이상한 칸은 '3단계' 한 명 프롬프트로 다시 뽑아.",
        "",
        "참고: 실제 인물을 바탕으로 한 그림이라, 게임을 공개 배포하면 초상권·퍼블리시티권 문제가 생길 수 있어. 개인 프로젝트 안에서 쓰는 걸 전제로 했어.",
        "",
        "## 공통 스타일 (모든 프롬프트에 들어 있음)",
        "",
        "```",
        STYLE,
        "```",
        "",
        "## 1단계: 스타일 확정 (Faker 한 장)",
        "",
        "첨부: `1_LCK/01_T1/03_Mid_Faker.png`",
        "",
        "```",
        "첨부한 사진은 LoL 프로게이머 Faker(T1 미드)야. 내가 만드는 e스포츠 매니저 게임에 들어갈 선수 초상화를 이 사람을 참고해 그려 줘.",
        "",
        STYLE,
        "",
        "팀 색: 주색 #e2012d, 보조색 #101010.",
        "결과는 512×512 한 장. 이 그림이 앞으로 모든 선수·감코 그림의 스타일 기준이 될 거야.",
        "```",
        "",
        "## 2단계: 팀별 배치",
        "",
    ]
    section = None
    n_batches = 0
    counts = {}
    for g in groups():
        sec = SECTION_DIR.get(g["section"], "4_OTHER")
        counts[sec] = counts.get(sec, 0) + 1
        team_id = next((c["team"] for c in g["cells"] if c["team"]), "OTHER")
        folder = f"{sec}/{counts[sec]:02d}_{safe(team_id)}"
        if g["section"] != section:
            section = g["section"]
            lines += [f"### {section}", ""]
        c1, c2 = g["cells"][0]["colors"]
        team_name = names.get(team_id, g["title"])
        files, seen = [], set()
        for i, c in enumerate(g["cells"], 1):
            role = c["role"] if c["kind"] == "player" else ROLE_FILE.get(c["role"], safe(c["role"]))
            # staff.json lists kkOma / KkOma (and two more pairs) twice: draw such a person once
            if photo_of(c, manifest, sman)[0] is not None and (c["kind"], c["name"].lower()) not in seen:
                seen.add((c["kind"], c["name"].lower()))
                files.append((c, f"{i:02d}_{role}_{safe(c['name'])}.png"))
        # split the team (players first, then coaches) into the fewest batches of at most 6, sizes as even as possible
        k = -(-len(files) // BATCH)
        sizes = [len(files) // k + (1 if i < len(files) % k else 0) for i in range(k)]
        batches, start = [], 0
        for size in sizes:
            batch = files[start:start + size]
            start += size
            kinds = {c["kind"] for c, _ in batch}
            batches.append(("mixed" if len(kinds) > 1 else kinds.pop(), batch))
        lines += [f"#### {team_name} — `{folder}/`", ""]
        for b, (kind, batch) in enumerate(batches, 1):
            n_batches += 1
            who = {"player": "선수", "staff": "감독·코치", "mixed": "선수·감코"}[kind]
            roster = "\n".join(f"{k}. {c['name']} — {ROLE_KO.get(c['role'], c['role'])}" for k, (c, _) in enumerate(batch, 1))
            lines += [
                f"배치 {b} ({who} {len(batch)}명) · 첨부 순서: " + ", ".join(f"`{f}`" for _, f in batch) + ", `style_ref.png`",
                "",
                "```",
                f"첨부한 사진 {len(batch)}장은 LoL e스포츠 팀 {team_name}의 {who}야. 첨부 순서대로 아래 사람들이고, "
                f"마지막 첨부 이미지는 화풍 기준(style_ref)이야.",
                roster,
                "",
                "style_ref와 똑같은 화풍으로 한 사람씩 초상화를 그려 줘.",
                "",
                STYLE,
                "",
                f"팀 색: 주색 {c1}, 보조색 {c2}." + (" 감독·코치는 정장이면 정장 그대로 두고, 넥타이나 배지 같은 작은 부분에만 팀 색을 써." if kind != "player" else ""),
                GRID,
                "```",
                "",
            ]
    lines += [
        "## 3단계: 한 명만 다시 뽑기",
        "",
        "첨부: 그 사람 사진 1장 + `style_ref.png`",
        "",
        "```",
        "첨부한 첫 사진은 {팀 이름}의 {닉네임}({포지션 또는 감독/코치})이야. 두 번째 이미지(style_ref)와 똑같은 화풍으로 이 사람 초상화를 다시 그려 줘.",
        "",
        STYLE,
        "",
        "팀 색: 주색 {주색}, 보조색 {보조색}.",
        "결과는 512×512 한 장.",
        "```",
        "",
        "## 고칠 때 붙이는 말",
        "",
        "- 닮지 않았을 때: `사진과 덜 닮았어. 머리 모양과 앞머리 방향, 안경테 모양을 사진에 더 가깝게 맞춰 줘.`",
        "- 화풍이 흔들릴 때: `style_ref와 픽셀 크기, 외곽선 굵기, 색 수가 달라. style_ref에 맞춰 다시 그려 줘.`",
        "- 픽셀이 뭉개질 때: `픽셀 경계가 흐려졌어. 8×8 블록이 딱 떨어지게, 안티에일리어싱 없이 다시.`",
        "- 글자나 로고가 들어갔을 때: `옷의 글자와 로고를 빼고 단색 덩어리로만 그려 줘.`",
        "- 격자가 어긋날 때: `칸 크기를 정확히 512×512로, 3열×2행, 간격 없이 다시 배치해 줘.`",
        "",
        f"총 {n_batches}개 배치.",
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"{OUT}: {n_batches} batches")


if __name__ == "__main__":
    main()
