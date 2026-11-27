"""Collect 3D renders of Summoner's Rift objects as references for icon drawing.

  python scripts/fetch_map_object_refs.py

Source: the League of Legends Wiki (wiki.leagueoflegends.com/en-us), whose "Render" files are cut-out
pictures of the in-game 3D models on a transparent background. The wiki's MediaWiki API gives each
file's original URL; images are served from the same host with no Cloudflare challenge. One request
per second, original files only (no thumbnails).

Only the current Summoner's Rift look is collected: event-map skins (Arcane, URF, ARAM, ...), old
models ("Render old") and removed variants (Voidborn camps) are left out on purpose. Atakhan was
removed in 26.1 but is kept for reference.

Output: every image in one folder, data/map_object_refs/<n>_<category>_<name>.png (the number keeps the
categories in order when sorted by name), plus manifest.json, README.md and _sheet.png (every image on one
contact sheet; the underscore keeps it apart from the renders).
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "map_object_refs"
WIKI = "https://wiki.leagueoflegends.com/en-us/"
API = WIKI + "api.php"
HEADERS = {"User-Agent": "LoLSim-research/1.0 (personal non-commercial fan project; reference images)"}
GAP = 1.0  # seconds between requests
SHEET = "_sheet.png"

# file name prefix per category: everything lands in one folder, sorted by category
PREFIX = {"1_jungle": "1_jungle", "2_dragons": "2_dragon", "3_epic": "3_epic", "4_minions": "4_minion",
          "5_structures": "5"}

ORDER, CHAOS = "파랑 진영 모양", "빨강 진영 모양"
GLOW_B, GLOW_R = "파란 빛", "빨간 빛"
PLATE_OB, PLATE_OR = "포탑 방패: 파랑 진영, 파란 빛", "포탑 방패: 파랑 진영, 빨간 빛"
PLATE_CB, PLATE_CR = "포탑 방패: 빨강 진영, 파란 빛", "포탑 방패: 빨강 진영, 빨간 빛"

# category -> subject -> (Korean label, [(wiki file name, local name, variant label)])
SUBJECTS = {
    "1_jungle": {
        "blue_sentinel": ("블루(푸른 파수꾼)", [("Blue Sentinel Render.png", "blue_sentinel", "")]),
        "red_brambleback": ("레드(붉은 덩굴정령)", [("Red Brambleback Render.png", "red_brambleback", "")]),
        "gromp": ("두꺼비(그롬프)", [("Gromp Render.png", "gromp", "")]),
        "krug": ("돌거북(크룩)", [("Ancient Krug Render.png", "ancient_krug", "고대 크룩(큰 놈)"),
                                ("Krug Render.png", "krug", "크룩(중간)"),
                                ("Mini Krug Render.png", "mini_krug", "작은 크룩")]),
        "murkwolf": ("늑대(어스름 늑대)", [("Greater Murk Wolf Render.png", "greater_murk_wolf", "큰 어스름 늑대"),
                                       ("Murk Wolf Render.png", "murk_wolf", "어스름 늑대(꼬마)")]),
        "raptor": ("칼날부리", [("Crimson Raptor Render.png", "crimson_raptor", "붉은 칼날부리(큰 놈)"),
                             ("Raptor Render.png", "raptor", "칼날부리(꼬마)")]),
        "scuttle_crab": ("바위게(협곡 바위게)", [("Rift Scuttler Render.png", "rift_scuttler", "")]),
    },
    "2_dragons": {
        "dragon_generic": ("드래곤(공통)", [("Dragon Render.png", "base", "원소 드래곤 기본형"),
                                          ("Dragon All Render.png", "all", "드래곤 전체 모음")]),
        "infernal": ("화염 드래곤", [("Infernal Drake Render.png", "infernal", "")]),
        "ocean": ("바다 드래곤", [("Ocean Drake Render.png", "ocean", "")]),
        "mountain": ("대지 드래곤", [("Mountain Drake Render.png", "mountain", "")]),
        "cloud": ("바람 드래곤", [("Cloud Drake Render.png", "cloud", "")]),
        "hextech": ("마법공학 드래곤", [("Hextech Drake Render.png", "hextech", "")]),
        "chemtech": ("화학공학 드래곤", [("Chemtech Drake Render.png", "chemtech", "")]),
        "elder": ("장로 드래곤", [("Elder Dragon Render.png", "elder", "")]),
    },
    "3_epic": {
        # the three forms share one model; they differ only in small details around the head and in colour
        "baron": ("내셔 남작(바론)", [("Hunting Baron Nashor Render.png", "baron_hunting", "사냥꾼 바론(기본)"),
                                   ("All-Seeing Baron Nashor Render.png", "baron_all_seeing", "모든 것을 보는 바론"),
                                   ("Territorial Baron Nashor Render.png", "baron_territorial", "영역 바론")]),
        "rift_herald": ("협곡의 전령", [("Rift Herald Render.png", "rift_herald", "")]),
        "void_grubs": ("공허 유충", [("Voidgrub Render.png", "voidgrub", "공허 유충"),
                                 ("Voidmite Render.png", "voidmite", "공허 진드기(유충이 낳는 것)")]),
        "atakhan": ("아타칸 (26.1에서 삭제, 참고용)", [("Voracious Atakhan Render.png", "atakhan_voracious", "탐식 아타칸"),
                                                ("Thornbound Atakhan Render.png", "atakhan_thornbound", "파멸 아타칸")]),
    },
    "4_minions": {
        "melee": ("근거리 미니언", [("Order Minion Melee Render.png", "melee_order", "파랑 팀"),
                                 ("Chaos Minion Melee Render.png", "melee_chaos", "빨강 팀")]),
        "ranged": ("원거리(마법사) 미니언", [("Order Minion Caster Render.png", "ranged_order", "파랑 팀"),
                                       ("Chaos Minion Caster Render.png", "ranged_chaos", "빨강 팀")]),
        "siege": ("공성 미니언(대포)", [("Order Minion Siege Render.png", "siege_order", "파랑 팀"),
                                    ("Chaos Minion Siege Render.png", "siege_chaos", "빨강 팀")]),
        "super": ("슈퍼 미니언", [("Order Minion Super Render.png", "super_order", "파랑 팀"),
                               ("Chaos Minion Super Render.png", "super_chaos", "빨강 팀")]),
    },
    "5_structures": {
        "turret": ("포탑", [("Order Turret Blue Render.png", "turret_order_blue", f"{ORDER}, {GLOW_B}"),
                           ("Order Turret Red Render.png", "turret_order_red", f"{ORDER}, {GLOW_R}"),
                           ("Chaos Turret Blue Render.png", "turret_chaos_blue", f"{CHAOS}, {GLOW_B}"),
                           ("Chaos Turret Red Render.png", "turret_chaos_red", f"{CHAOS}, {GLOW_R}"),
                           ("Order Turret Shield Blue Render.png", "turret_plating_order_blue", PLATE_OB),
                           ("Order Turret Shield Red Render.png", "turret_plating_order_red", PLATE_OR),
                           ("Chaos Turret Shield Blue Render.png", "turret_plating_chaos_blue", PLATE_CB),
                           ("Chaos Turret Shield Red Render.png", "turret_plating_chaos_red", PLATE_CR)]),
        "inhibitor": ("억제기", [("Order Inhibitor Blue Render.png", "inhibitor_order_blue", f"{ORDER}, {GLOW_B}"),
                              ("Order Inhibitor Red Render.png", "inhibitor_order_red", f"{ORDER}, {GLOW_R}"),
                              ("Chaos Inhibitor Blue Render.png", "inhibitor_chaos_blue", f"{CHAOS}, {GLOW_B}"),
                              ("Chaos Inhibitor Red Render.png", "inhibitor_chaos_red", f"{CHAOS}, {GLOW_R}")]),
        "nexus": ("넥서스", [("Order Nexus Blue Render.png", "nexus_order_blue", f"{ORDER}, {GLOW_B}"),
                           ("Order Nexus Red Render.png", "nexus_order_red", f"{ORDER}, {GLOW_R}"),
                           ("Chaos Nexus Blue Render.png", "nexus_chaos_blue", f"{CHAOS}, {GLOW_B}"),
                           ("Chaos Nexus Red Render.png", "nexus_chaos_red", f"{CHAOS}, {GLOW_R}")]),
    },
}


class Wiki:
    def __init__(self) -> None:
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.last = 0.0

    def get(self, url: str, **params) -> requests.Response:
        for attempt in range(4):
            wait = self.last + GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                response = self.session.get(url, params=params or None, timeout=60)
            except requests.RequestException as error:
                print(f"  retry {attempt + 1} {url}: {error}")
                self.last = time.time() + 2 ** attempt
                continue
            self.last = time.time()
            if response.status_code in (429, 500, 502, 503, 504):
                print(f"  retry {attempt + 1} {url}: HTTP {response.status_code}")
                self.last += 2 ** attempt * 3
                continue
            return response
        raise RuntimeError(f"gave up on {url}")

    def file_info(self, names: list[str]) -> dict[str, dict]:
        """wiki file name -> imageinfo (url, descriptionurl, size, sha1), following redirects."""
        info = {}
        for i in range(0, len(names), 50):
            batch = names[i:i + 50]
            data = self.get(API, action="query", format="json", formatversion="2", redirects="1",
                            titles="|".join("File:" + n for n in batch), prop="imageinfo",
                            iiprop="url|size|sha1|timestamp|mime").json()
            alias = {r["to"]: r["from"] for r in data["query"].get("redirects", [])}
            alias.update({n["to"]: n["from"] for n in data["query"].get("normalized", [])})
            for page in data["query"]["pages"]:
                title = page["title"]
                while title in alias:
                    title = alias[title]
                name = title.split(":", 1)[1]
                if page.get("imageinfo"):
                    info[name] = page["imageinfo"][0]
        return info


def label_font(size: int):
    path = Path("C:/Windows/Fonts/malgun.ttf")
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default()


def checker(w: int, h: int, step: int = 12) -> Image.Image:
    tile = Image.new("RGBA", (w, h), (92, 98, 116, 255))
    d = ImageDraw.Draw(tile)
    for y in range(0, h, step):
        for x in range((y // step % 2) * step, w, step * 2):
            d.rectangle([x, y, x + step - 1, y + step - 1], fill=(108, 114, 134, 255))
    return tile


def contact_sheet(items: list[dict], title: str, out: Path) -> None:
    cell, cols, pad, text_h = 230, 6, 16, 58
    cols = min(cols, max(1, len(items)))
    rows = -(-len(items) // cols)
    sheet = Image.new("RGB", (pad * 2 + cols * cell, pad * 2 + 44 + rows * (cell + text_h)), (20, 24, 38))
    d = ImageDraw.Draw(sheet)
    d.text((pad, pad), title, font=label_font(20), fill=(235, 236, 244))
    f, fb = label_font(12), label_font(13)
    for i, it in enumerate(items):
        x = pad + (i % cols) * cell
        y = pad + 44 + (i // cols) * (cell + text_h)
        img = Image.open(OUT / it["local"]).convert("RGBA")
        box = img.getchannel("A").getbbox()
        if box:
            img = img.crop(box)
        img.thumbnail((cell - 16, cell - 16), Image.LANCZOS)
        tile = checker(cell - 6, cell - 6)
        tile.alpha_composite(img, ((tile.width - img.width) // 2, (tile.height - img.height) // 2))
        sheet.paste(tile.convert("RGB"), (x + 3, y + 3))
        for dy, text, font, colour in [(0, it["label"], fb, (242, 193, 78)), (18, it["variant"], f, (225, 228, 238)),
                                       (35, f"{it['file']} · {it['size'][0]}×{it['size'][1]}", f, (150, 156, 180))]:
            while text and d.textlength(text, font=font) > cell - 8 and len(text) > 4:
                text = text[:-2] + "…"
            d.text((x + 3, y + cell + dy), text, font=font, fill=colour)
    sheet.save(out)


def main() -> None:
    wiki = Wiki()
    wanted = [(cat, subj, label, wiki_name, local, variant)
              for cat, subjects in SUBJECTS.items()
              for subj, (label, files) in subjects.items()
              for wiki_name, local, variant in files]
    info = wiki.file_info([w[3] for w in wanted])
    OUT.mkdir(parents=True, exist_ok=True)
    # files saved under an earlier layout or name: reuse them instead of downloading again
    old_manifest = OUT / "manifest.json"
    earlier = {it["wiki_file"]: OUT / it["local"] for it in json.loads(old_manifest.read_text(encoding="utf-8"))} \
        if old_manifest.exists() else {}
    done, missing = [], []
    for cat, subj, label, wiki_name, local, variant in wanted:
        meta = info.get(wiki_name)
        if not meta:
            missing.append(wiki_name)
            print(f"  missing on the wiki: {wiki_name}")
            continue
        ext = Path(meta["url"].split("?")[0]).suffix.lower() or ".png"
        target = OUT / f"{PREFIX[cat]}_{local}{ext}"
        previous = earlier.get(wiki_name)
        if not target.exists() and previous and previous.exists() and previous != target:
            previous.replace(target)
        fresh = target.exists() and hashlib.sha1(target.read_bytes()).hexdigest() == meta.get("sha1")
        if not fresh:
            response = wiki.get(meta["url"])
            body = response.content
            if not response.ok or (body[:4] != b"\x89PNG" and body[:3] != b"\xff\xd8\xff"):
                missing.append(wiki_name)
                print(f"  failed {meta['url']}: HTTP {response.status_code}")
                continue
            target.write_bytes(body)
        with Image.open(target) as img:
            size = img.size
        done.append({"category": cat, "subject": subj, "label": label, "variant": variant,
                     "file": target.name, "local": str(target.relative_to(OUT)).replace("\\", "/"),
                     "size": size, "wiki_file": wiki_name, "url": meta["url"], "page": meta.get("descriptionurl"),
                     "uploaded": meta.get("timestamp")})
        print(f"  {target.name} {size[0]}x{size[1]}")
    (OUT / "manifest.json").write_text(json.dumps(done, ensure_ascii=False, indent=1), encoding="utf-8")

    # leftovers of the earlier per-category folders: their sheets, then the folders once empty
    for cat in SUBJECTS:
        folder = OUT / cat
        if folder.is_dir():
            (folder / "_sheet.png").unlink(missing_ok=True)
            for sub in sorted(folder.rglob("*"), reverse=True):
                if sub.is_dir() and not any(sub.iterdir()):
                    sub.rmdir()
            if not any(folder.iterdir()):
                folder.rmdir()
            else:
                print(f"  kept {folder}: it still holds files this script does not know")
    (OUT / "sheet.png").unlink(missing_ok=True)
    contact_sheet(done, "소환사의 협곡 오브젝트 3D 렌더 (LoL 위키 wiki.leagueoflegends.com)", OUT / SHEET)

    lines = [
        "# 소환사의 협곡 오브젝트 3D 렌더",
        "",
        "ChatGPT에게 아이콘을 맡길 때 참고로 줄, 게임 속 3D 모델을 잘라 낸 그림이다. 배경은 투명하다.",
        "",
        f"- 그림은 모두 이 폴더 하나에 있다. 파일 이름 앞 숫자가 분류다(1 정글, 2 드래곤, 3 에픽, 4 미니언, 5 구조물). "
        f"`{SHEET}`는 전체를 한 장에 모은 미리보기라 렌더가 아니다.",
        "- 출처: LoL 위키(`wiki.leagueoflegends.com/en-us`)의 `... Render.png` 원본 파일. 파일마다 위키 문서 주소와 원본 URL은 `manifest.json`에 있다.",
        "- 지금 소환사의 협곡 모습만 넣었다. 이벤트 맵 모습(아케인, URF, 칼바람 등), 옛 모델(`Render old`), 삭제된 공허 변형 정글몹은 뺐다.",
        "- 아타칸은 26.1 패치에서 삭제됐다. 참고용으로만 넣었다.",
        "- 바론 세 모습(사냥꾼, 모든 것을 보는, 영역)은 모델이 같고 머리 주변 장식과 색만 조금 다르다.",
        "- 포탑, 억제기, 넥서스는 두 가지로 나뉜다.",
        "  - `order`/`chaos`: 건물 모양. order는 파랑 진영(왼쪽 아래), chaos는 빨강 진영(오른쪽 위) 건물이다.",
        "  - `blue`/`red`: 수정 빛 색. 게임에서는 내 편이 파랑, 상대가 빨강으로 보인다. 중계·관전 화면에서는 파랑 팀이 파랑, 빨강 팀이 빨강이라 `order_blue`와 `chaos_red`가 기본 모습이다.",
        "  - `turret_plating_`: 포탑 방패(골드 방패). 14분 전까지 포탑 앞에 붙는 판이다.",
        "- 미니언은 `_order`가 파랑 팀, `_chaos`가 빨강 팀이다.",
        "- 그림 저작권은 Riot Games에 있고, 위키 내용은 CC BY-SA 3.0이다. 개인 프로젝트 참고용으로만 쓴다.",
        "- 다시 받기: `python scripts/fetch_map_object_refs.py` (이미 받은 파일은 SHA-1이 같으면 건너뛴다)",
        "",
        "| 파일 | 대상 | 모습 |",
        "|---|---|---|",
    ]
    for it in done:
        lines.append(f"| `{it['file']}` | {it['label']} | {it['variant']} |")
    lines += ["", f"총 {len(done)}장."]
    if missing:
        lines += ["", "위키에서 못 받은 파일: " + ", ".join(f"`{m}`" for m in missing)]
    (OUT / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(done)} images (planned {len(wanted)}, missing {len(missing)})")
    for cat in SUBJECTS:
        print(f"  {cat}: {sum(1 for it in done if it['category'] == cat)}")


if __name__ == "__main__":
    main()
