"""Leaguepedia profile photos for coaches and the players lolesports.com has no photo for, saved by hand.

Leaguepedia's image host (static.wikia.nocookie.net) answers scripts with a Cloudflare challenge, so this
script never downloads an image. It works in two steps:

  python scripts/leaguepedia_photo_gallery.py
      api.php (Cargo PlayerImages + imageinfo) -> pick each person's newest profile photo and write
      data/leaguepedia_gallery/gallery.html, a page that shows them all with the game id on every image.
      Open it in a normal browser and save it with Ctrl+S as "Webpage, Complete" into data/leaguepedia_gallery/.

  python scripts/leaguepedia_photo_gallery.py --import data/leaguepedia_gallery/gallery_saved.html
      reads the saved page, maps every <img data-id> to the file the browser stored next to it, and copies the
      photos into data/staff_photos/ and data/player_photos/ (manifests updated, source "leaguepedia").
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_leaguepedia import api_get, cargo_all  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "game" / "public" / "data"
OUT = ROOT / "data" / "leaguepedia_gallery"
CACHE = ROOT / "data" / "cargo_cache" / "game_photo_images.json"
PLAYER_DIR = ROOT / "data" / "player_photos"
STAFF_DIR = ROOT / "data" / "staff_photos"
WIDTH = 384


# Loads the gallery images two at a time, 400 ms apart, and retries a refused one after 3 s, 8 s, 20 s and 40 s.
# A photo that still fails is listed with a link to its file page.
LOADER_JS = """
const imgs = [...document.querySelectorAll('img[data-src]')];
const status = document.getElementById('status'), failedBox = document.getElementById('failed');
const again = document.getElementById('again');
const WAITS = [3000, 8000, 20000, 40000];
let queue = imgs.slice(), active = 0;
function report() {
  const ok = imgs.filter(i => i.dataset.state === 'ok').length;
  const bad = imgs.filter(i => i.dataset.state === 'bad');
  const busy = imgs.length - ok - bad.length;
  status.textContent = `불러옴 ${ok} / ${imgs.length}` + (busy ? ` · 진행 중 ${busy}` : '') + (bad.length ? ` · 실패 ${bad.length}` : '');
  failedBox.innerHTML = bad.map(i => `<a href="${i.dataset.page}" target="_blank">${i.alt}</a>`).join('');
  again.hidden = !(bad.length && !busy);
  if (ok === imgs.length) status.textContent += '  → 이제 Ctrl+S로 저장하면 돼';
}
function load(img) {
  active++;
  const tries = +(img.dataset.tries || 0);
  img.onload = () => { img.dataset.state = 'ok'; img.closest('figure').className = 'ok'; active--; report(); next(); };
  img.onerror = () => {
    active--;
    if (tries < WAITS.length) {
      img.dataset.tries = tries + 1;
      setTimeout(() => { queue.push(img); next(); }, WAITS[tries]);
    } else { img.dataset.state = 'bad'; img.closest('figure').className = 'bad'; }
    report(); next();
  };
  img.removeAttribute('src');
  img.src = img.dataset.src;
}
// at most two requests in flight, a new one started no sooner than 400 ms after the last
let lastStart = 0, timer = null;
function next() {
  if (timer || active >= 2 || !queue.length) return;
  const wait = Math.max(0, lastStart + 400 - Date.now());
  timer = setTimeout(() => { timer = null; if (active >= 2 || !queue.length) return; lastStart = Date.now(); load(queue.shift()); next(); }, wait);
}
again.onclick = () => {
  imgs.filter(i => i.dataset.state === 'bad').forEach(i => { delete i.dataset.state; i.dataset.tries = 0; i.closest('figure').className = ''; i.removeAttribute('src'); queue.push(i); });
  report(); next();
};
report(); next();
"""


def year_of(row: dict) -> int:
    # the file name carries the season ("HLE Homme 2026 Split 1.png"); SortDate can lag a year behind it
    for text in (row.get("File") or "", row.get("Tournament") or "", row.get("SortDate") or ""):
        m = re.search(r"(20\d\d)", text)
        if m:
            return int(m.group(1))
    return 0


def split_rank(name: str) -> int:
    """Within one year: later split / playoffs / worlds photos sort after earlier ones."""
    n = name.lower()
    keys = ("split 1", "spring", "cup", "split 2", "summer", "split 3", "season", "msi", "worlds")
    return max((i for i, key in enumerate(keys) if key in n), default=-1)


def people() -> list[dict]:
    staff = json.loads((DATA / "staff.json").read_text(encoding="utf-8"))["staff"]
    players = {p["id"]: p for p in json.loads((DATA / "players.json").read_text(encoding="utf-8"))["players"]}
    pman = json.loads((PLAYER_DIR / "manifest.json").read_text(encoding="utf-8"))
    out = [{"kind": "staff", "id": s["id"], "name": s["name"], "team": s["lastTeam"]} for s in staff]
    for pid, v in pman.items():  # players lolesports had no photo for (now Liquipedia or nothing)
        if pid in players and (v.get("source") == "liquipedia" or not v.get("photo")):
            out.append({"kind": "player", "id": pid, "name": players[pid]["name"], "team": players[pid]["lastTeam"]})
    return out


def build() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    who = people()
    if CACHE.exists():
        rows = json.loads(CACHE.read_text(encoding="utf-8"))
    else:
        links = sorted({p["id"] for p in who})
        rows = []
        for i in range(0, len(links), 30):
            where = "PI.Link IN (" + ",".join("'" + x.replace("'", "''") + "'" for x in links[i:i + 30]) + ")"
            rows += cargo_all("PlayerImages=PI", "PI.FileName=File,PI.Link=Link,PI.Team=Team,PI.Tournament=Tournament,"
                              "PI.ImageType=Type,PI.SortDate=SortDate", where)
        CACHE.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    by = {}
    for r in rows:
        by.setdefault(r["Link"].lower(), []).append(r)
    chosen = {}
    for p in who:
        imgs = by.get(p["id"].lower(), [])
        if imgs:
            imgs.sort(key=lambda r: (year_of(r), r.get("SortDate") or "", split_rank(r["File"] + " " + (r.get("Tournament") or ""))))
            chosen[p["id"]] = imgs[-1]
    files = sorted({r["File"] for r in chosen.values()})
    urls = {}
    for i in range(0, len(files), 50):
        q = api_get({"action": "query", "formatversion": 2, "prop": "imageinfo", "iiprop": "url", "iiurlwidth": WIDTH,
                     "titles": "|".join("File:" + f for f in files[i:i + 50])})["query"]
        alias = {n["from"]: n["to"] for n in q.get("normalized", [])}
        alias.update({n["from"]: n["to"] for n in q.get("redirects", [])})
        pages = {pg["title"]: pg for pg in q.get("pages", [])}
        for f in files[i:i + 50]:
            t = "File:" + f
            t = alias.get(alias.get(t, t), alias.get(t, t))
            ii = (pages.get(t, {}).get("imageinfo") or [{}])[0]
            urls[f] = {"thumb": ii.get("thumburl") or ii.get("url"), "page": ii.get("descriptionurl")}
    wanted = []
    cards = []
    for p in who:
        r = chosen.get(p["id"])
        u = urls.get(r["File"], {}) if r else {}
        wanted.append({**p, "file": r["File"] if r else None, "year": year_of(r) if r else None,
                       "thumb": u.get("thumb"), "page": u.get("page")})
        if r and u.get("thumb"):
            # data-src, not src: the script below loads them a few at a time (101 at once got part of them refused)
            cards.append(f'<figure><img data-src="{html.escape(u["thumb"])}" data-id="{html.escape(p["id"])}" '
                         f'data-kind="{p["kind"]}" data-page="{html.escape(u.get("page") or "")}" '
                         f'alt="{html.escape(p["name"])}" referrerpolicy="no-referrer">'
                         f'<figcaption><b>{html.escape(p["name"])}</b><br>{"감코" if p["kind"] == "staff" else "선수"} · '
                         f'{html.escape(p["team"] or "")}<br><small>{html.escape(r["File"])}</small></figcaption></figure>')
    (OUT / "wanted.json").write_text(json.dumps(wanted, ensure_ascii=False, indent=1), encoding="utf-8")
    page = f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>Leaguepedia 프로필 사진 {len(cards)}장</title>
<style>
body{{background:#141826;color:#e8eaf2;font-family:'Malgun Gothic',sans-serif;margin:24px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}}
figure{{margin:0;background:#1f2438;border-radius:8px;padding:8px}}
img{{width:100%;aspect-ratio:1;object-fit:cover;object-position:top;background:#2a3050;border-radius:4px}}
figcaption{{font-size:12px;line-height:1.35;margin-top:6px}} small{{color:#8b92aa;word-break:break-all}}
.note{{background:#22304f;padding:12px 16px;border-radius:8px;margin-bottom:16px;line-height:1.6}}
#status{{font-size:18px;font-weight:bold}} #failed a{{color:#ffb4b4;margin-right:10px}}
figure.bad{{outline:2px solid #e05555}} figure.ok{{outline:1px solid #3b7a4b}}
button{{font:inherit;padding:4px 12px;margin-left:8px}}
</style></head><body>
<div class="note"><b>Leaguepedia 프로필 사진 {len(cards)}장</b> (감코 {sum(1 for w in wanted if w['kind']=='staff' and w['thumb'])}명, 선수 {sum(1 for w in wanted if w['kind']=='player' and w['thumb'])}명)<br>
<span id="status">불러오는 중…</span><button id="again" hidden>실패한 것 다시 불러오기</button><br>
<span id="failed"></span><br>
사진이 <b>모두</b> 보이면(빨간 테두리가 없으면) <b>Ctrl+S</b>를 누르고 형식을 <b>"웹페이지, 전체"</b>로 골라 이 폴더에 <b>gallery_saved.html</b> 이름으로 저장해 줘.<br>
출처: Leaguepedia (lol.fandom.com), 사진은 파일마다 저작권·라이선스가 다름.</div>
<div class="grid">{''.join(cards)}</div>
<script>{LOADER_JS}</script></body></html>"""
    (OUT / "gallery.html").write_text(page, encoding="utf-8")
    print(f"{OUT / 'gallery.html'}: {len(cards)} photos "
          f"(coaches {sum(1 for w in wanted if w['kind']=='staff' and w['thumb'])}/{sum(1 for w in wanted if w['kind']=='staff')}, "
          f"players {sum(1 for w in wanted if w['kind']=='player' and w['thumb'])}/{sum(1 for w in wanted if w['kind']=='player')})")
    for w in wanted:
        if not w["thumb"]:
            print(f"  no Leaguepedia photo: {w['kind']:<6} {w['id']}")


def import_saved(saved: Path) -> None:
    from PIL import Image
    text = saved.read_text(encoding="utf-8", errors="replace")
    wanted = {w["id"]: w for w in json.loads((OUT / "wanted.json").read_text(encoding="utf-8"))}
    pman = json.loads((PLAYER_DIR / "manifest.json").read_text(encoding="utf-8"))
    sman_path = STAFF_DIR / "manifest.json"
    sman = json.loads(sman_path.read_text(encoding="utf-8")) if sman_path.exists() else {}
    STAFF_DIR.mkdir(parents=True, exist_ok=True)
    done = missing = 0
    for tag in re.findall(r"<img\b[^>]*>", text):
        src = re.search(r'\ssrc="([^"]+)"', tag)
        pid = re.search(r'\sdata-id="([^"]+)"', tag)
        kind = re.search(r'\sdata-kind="([^"]+)"', tag)
        if not (src and pid and kind):
            continue
        pid, kind = html.unescape(pid.group(1)), kind.group(1)
        local = (saved.parent / unquote(html.unescape(src.group(1)))).resolve()
        if src.group(1).startswith("http") or not local.exists():
            missing += 1
            print(f"  not saved: {pid}")
            continue
        image = Image.open(local).convert("RGBA")
        if image.width > WIDTH:
            image = image.resize((WIDTH, round(image.height * WIDTH / image.width)), Image.LANCZOS)
        folder, man = (STAFF_DIR, sman) if kind == "staff" else (PLAYER_DIR, pman)
        stem = re.sub(r"[^A-Za-z0-9._-]+", "_", pid).strip("_")
        if pid != pid.lower() and any(k.lower() == pid.lower() and k != pid for k in wanted):  # kkOma / KkOma
            stem += "_" + "".join(c for c in pid if c.isupper())[:3]
        target = folder / f"lp_{stem}.png"
        image.save(target)
        w = wanted.get(pid, {})
        old = man.get(pid, {})
        man[pid] = {"name": w.get("name", pid), "photo": target.name, "source": "leaguepedia", "file": w.get("file"),
                    "filePage": w.get("page"), "year": w.get("year"),
                    "previous": {k: old.get(k) for k in ("photo", "source", "why") if old.get(k)}}
        done += 1
    sman_path.write_text(json.dumps(sman, ensure_ascii=False, indent=1), encoding="utf-8")
    (PLAYER_DIR / "manifest.json").write_text(json.dumps(pman, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"imported {done}, not in the saved page {missing}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--import", dest="saved", type=Path, help="the page saved as 'Webpage, Complete'")
    a = ap.parse_args()
    import_saved(a.saved) if a.saved else build()
