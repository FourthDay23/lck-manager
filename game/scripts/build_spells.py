"""Build src/match/spells.gen.ts: real LoL numbers for the fight engine (owner: combat-stats session).

Run from anywhere:  python -I scripts/build_spells.py   (add --dump <Id,...> to print champions for review)

Sources (read-only, already cached by the other builders):
  - LoLSim/data/kits_cache/meraki_champions.json: base stats + growth per level, attack speed and its ratio, crit
    damage; per spell and rank: damage / shield / heal values with their scalings (AP, AD, bonus AD, health, armor,
    target health), damage type, cooldown.
  - LoLSim/data/ddragon/<ver>/item_en_US.json: item effects that are not plain stats in items.json (armor / magic
    penetration %, crit damage, AP amplification, life steal, omnivamp, heal and shield power).
  - game/public/data/items.json: which items the game uses (only those get extras).

Output (deterministic, sorted):
  CHAMP_STATS[id]  = { hp:[base, perLevel], ad, ar, mr, mana: same; as: base attack speed, asr: attack speed ratio,
                       asg: attack speed % per level, crit: crit damage % (175), ms }
  SPELLS[id][slot] = { t: damage type of the spell, d: damage parts, h: shield/heal parts, cd: cooldown per rank }
     part = [mult, type, terms]; term = [key, values per rank, per?]   (see TERM KEYS below)
  ITEM_EXTRAS[itemId] = { apen, mpenPct, critDmg, apAmp, ls, ov, hsp }  (percent numbers)

How the damage of a spell is picked: per Meraki effect, the damage attribute that is largest at a mid-game reference
(the same rule as build_kits.py damage_estimate: "total ..." wins when present, minion / monster / reduction lines
are skipped), summed over the effects of the spell. "per tick" / "per second" lines count 3 times (a fight's worth).
Recasts (Lee Sin Q, Riven R ...) add their entries; form swaps (Jayce, Nidalee, Elise ...) take the strongest entry.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

GAME = Path(__file__).resolve().parent.parent
LOLSIM = GAME.parent
DATA = LOLSIM / "data"
MERAKI = DATA / "kits_cache" / "meraki_champions.json"
DD_DIR = DATA / "ddragon"
CHAMPS_JSON = GAME / "public" / "data" / "champions.json"
ITEMS_JSON = GAME / "public" / "data" / "items.json"
OUT = GAME / "src" / "match" / "spells.gen.ts"

KEYS = ["Q", "W", "E", "R"]
# entries under one key that are cast one after another in a single use (their damage adds up)
RECAST = {
    ("LeeSin", "Q"), ("LeeSin", "E"), ("Ambessa", "Q"), ("Camille", "E"), ("Renekton", "E"), ("Sylas", "E"),
    ("Riven", "R"), ("Swain", "R"), ("Briar", "W"), ("Rell", "W"), ("Skarner", "Q"),
    ("Quinn", "R"), ("TahmKench", "R"), ("Yorick", "Q"),
}
# damage parts of one spell are summed (separate hits: out and back, initial and detonation ...) except where the
# parts are alternatives of one hit (hand-checked against the --dump of all multi-part spells, 2026-11-26):
#   "max" = only the largest part, [i, ...] = only these parts (indices into the parsed list)
PART_PICK: dict[tuple[str, str], str | list[int]] = {
    ("Anivia", "R"): "max",        # per tick vs fully formed storm
    ("AurelionSol", "Q"): [0],     # the second line is a stardust-scaled bonus, not a second hit
    ("AurelionSol", "R"): "max",   # Falling Star vs The Skies Descend
    ("Evelynn", "Q"): [1],         # spike / empowered / total lines
    ("Fizz", "R"): [1],            # small / medium / large shark: medium
    ("Kennen", "R"): "max",        # per bolt vs total
    ("Gwen", "R"): "max",          # per needle vs total
    ("Hwei", "Q"): "max",
    ("Hwei", "R"): "max",          # per tick vs total
    ("Viktor", "R"): "max",        # initial vs total storm
    ("Renekton", "E"): [0, 1],     # Slice + Dice (the third is the Fury-empowered Dice)
    ("Qiyana", "Q"): "max",
    ("Neeko", "Q"): "max",         # first bloom vs total
    ("Briar", "E"): [0, 1],        # charge midpoint; the wall bonus is a variant
}
TICK_MULT = 3.0

# Spells the parser cannot read (pets, empowered attacks, stored damage, executes) or that deal no damage in LoL
# although the kit gives them a damage weight. Values from Meraki's text (2026-11-26 hand check); [] = no damage.
def _r(*v):
    return list(v)


SPELL_OVERRIDES: dict[tuple[str, str], dict] = {
    ("Darius", "E"): {"d": []}, ("Ekko", "W"): {"d": []}, ("Rammus", "W"): {"d": []}, ("Rammus", "E"): {"d": []},
    ("Nilah", "W"): {"d": []}, ("Xayah", "W"): {"d": []}, ("AurelionSol", "W"): {"d": []}, ("Heimerdinger", "R"): {"d": []},
    ("Jayce", "R"): {"d": []}, ("Karma", "R"): {"d": []}, ("Mel", "W"): {"d": []}, ("TahmKench", "E"): {"d": []},
    ("MonkeyKing", "W"): {"d": []}, ("Illaoi", "E"): {"d": []}, ("Aphelios", "W"): {"d": []},
    ("Tryndamere", "Q"): {"d": []}, ("Twitch", "R"): {"d": []},
    ("Blitzcrank", "E"): {"d": [[1.0, "p", [["ad", _r(100)], ["ap", _r(25)]]]]},
    ("Fiora", "E"): {"d": [[1.0, "p", [["ad", _r(160, 170, 180, 190, 200)]]]]},
    # four Vitals: 3 % (+ 4.5 % per 100 bonus AD) of maximum health each, true; then the healing zone
    ("Fiora", "R"): {"d": [[1.0, "t", [["tmhp", _r(12, 12, 12), [["bad", 18]]]]]],
                     "h": [[1.0, "h", [["flat", _r(187, 250, 312)], ["bad", _r(150, 150, 150)]]]]},
    # three turrets shooting through a fight
    ("Heimerdinger", "Q"): {"d": [[1.0, "m", [["flat", _r(90, 120, 150, 180, 210)], ["ap", _r(45, 45, 45, 45, 45)]]]]},
    ("Illaoi", "Q"): {"d": [[1.0, "p", [["flat", _r(30, 50, 70, 90, 110)], ["ad", _r(120, 120, 120, 120, 120)]]]]},
    ("Ivern", "R"): {"d": [[1.0, "m", [["flat", _r(150, 250, 350)], ["ap", _r(60, 60, 60)]]]]},
    ("Kassadin", "W"): {"d": [[1.0, "m", [["flat", _r(50, 75, 100, 125, 150)], ["ap", _r(80, 80, 80, 80, 80)]]]]},
    ("Maokai", "Q"): {"d": [[1.0, "m", [["flat", _r(65, 110, 155, 200, 245)], ["tmhp", _r(2, 2.5, 3, 3.5, 4)], ["ap", _r(40, 40, 40, 40, 40)]]]]},
    # execute threshold 250 : 550 by level (+ 80 % bonus AD): counted as 60 % of it in true damage
    ("Pyke", "R"): {"d": [[0.6, "t", [["flat", _r(300, 420, 520)], ["bad", _r(80, 80, 80)]]]]},
    # the box fires about 4 times before it dies
    ("Shaco", "W"): {"d": [[4.0, "m", [["flat", _r(25, 40, 55, 70, 85)], ["ap", _r(18, 18, 18, 18, 18)]]]]},
    ("Smolder", "E"): {"d": [[1.0, "p", [["flat", _r(50, 75, 100, 125, 150)], ["ad", _r(150, 150, 150, 150, 150)]]]]},
    # a stolen ultimate: an average one
    ("Sylas", "R"): {"d": [[1.0, "m", [["flat", _r(200, 300, 400)], ["ap", _r(70, 70, 70)]]]]},
    # Soul Unbound repeats 25-35 % of what Yone dealt in Spirit Form (about his AD x 4 in that window)
    ("Yone", "E"): {"d": [[1.0, "t", [["ad", _r(100, 110, 120, 130, 140)]]]]},
    ("Yorick", "R"): {"d": [[1.0, "m", [["flat", _r(150, 250, 350)], ["ad", _r(50, 50, 50)]]]]},
    # Calibrum Q as the average weapon ability; Moonlight Vigil
    ("Aphelios", "Q"): {"d": [[1.0, "p", [["flat", _r(60, 85, 110, 135, 160)], ["bad", _r(42, 45, 48, 51, 54)], ["ap", _r(100, 100, 100, 100, 100)]]]]},
    ("Aphelios", "R"): {"d": [[1.0, "p", [["flat", _r(125, 175, 225)], ["bad", _r(20, 20, 20)], ["ap", _r(100, 100, 100)]]]]},
}

# reference stats for choosing the largest attribute (rank 3 / ult rank 2)
REF = {"flat": 1.0, "ap": 1.5, "bad": 1.0, "ad": 1.8, "tmhp": 25.0, "tchp": 20.0, "tmiss": 8.0, "tbhp": 8.0,
       "bhp": 10.0, "mhp": 25.0, "ar": 1.0, "bar": 0.6, "mr": 0.6, "bmr": 0.4, "mmana": 10.0, "bmana": 2.0,
       "mmiss": 8.0}

DMG_SKIP = re.compile(r"reduction|reduced|minion|monster|structure|turret|non-champion|minimum|increased|per stack|"
                      r"capped|amplification|penetration|cap\b|threshold|attack damage|ability power")
SUP_HIT = re.compile(r"shield|heal")
SUP_SKIP = re.compile(r"reduction|reduced|cost|duration|cooldown|increased|amplif|power|ratio|minion|monster|"
                      r"non-champion|threshold|per stack|decay|bonus .*speed")
PER_RE = re.compile(r"\(\+\s*([\d.]+)%\s*per 100 (ap|bonus ad|ad|bonus armor|bonus magic resistance|bonus health)\)")
PER_KEY = {"ap": "ap", "bonus ad": "bad", "ad": "ad", "bonus armor": "bar", "bonus magic resistance": "bmr",
           "bonus health": "bhp"}


def unit_key(raw: str) -> tuple[str | None, list[list]]:
    """Meraki unit string -> (term key, nested per-100 scalings). None = not modelled."""
    u = " ".join((raw or "").lower().split())
    nested = [[PER_KEY[k], float(v)] for v, k in PER_RE.findall(u)]
    base = PER_RE.sub("", u).replace("  ", " ").strip()
    if base == "":
        return "flat", nested
    if base in ("% ap",) or re.fullmatch(r"% of \w+'s ap", base):
        return "ap", nested
    if base in ("% bonus ad",):
        return "bad", nested
    if base in ("% ad",):
        return "ad", nested
    m = re.fullmatch(r"% per 100 (ap|bonus ad|ad)", base)
    if m:
        return "per:" + PER_KEY[m.group(1)], nested
    if "target" in base:
        if "maximum health" in base:
            return "tmhp", nested
        if "current health" in base:
            return "tchp", nested
        if "missing health" in base:
            return "tmiss", nested
        if "bonus health" in base:
            return "tbhp", nested
        return None, nested
    if base in ("% bonus health", "% of his bonus health", "% of her bonus health"):
        return "bhp", nested
    if re.fullmatch(r"% (of (his|her|\w+'s) )?maximum health", base) or base == "% of maximum health":
        return "mhp", nested
    if re.fullmatch(r"% (of (his|her) )?missing health", base) or base == "% of missing health":
        return "mmiss", nested
    if base == "% bonus armor":
        return "bar", nested
    if base == "% armor":
        return "ar", nested
    if base == "% bonus magic resistance":
        return "bmr", nested
    if base == "% magic resistance":
        return "mr", nested
    if base == "% maximum mana":
        return "mmana", nested
    if base == "% bonus mana":
        return "bmana", nested
    return None, nested


def num_list(vals) -> list[float]:
    return [float(v) for v in vals if isinstance(v, (int, float))]


def terms_of(lv: dict, skipped: list[str], tag: str) -> list[list]:
    """Leveling attribute -> [[key, values, per], ...]; '% per 100 X' modifiers attach to the previous term."""
    out: list[list] = []
    for mod in lv.get("modifiers") or []:
        vals = num_list(mod.get("values") or [])
        if not vals:
            continue
        key, nested = unit_key((mod.get("units") or [""])[0] or "")
        if key is None:
            skipped.append(f"{tag}: {(mod.get('units') or [''])[0]!r}")
            continue
        if key.startswith("per:"):
            if out:
                # a per-100 scaling of the previous percentage (rank values are constant in practice)
                prev = out[-1]
                if len(prev) < 3:
                    prev.append([])
                prev[2].append([key[4:], vals[0]])
            continue
        if all(v == 0 for v in vals) and not nested:
            continue
        t = [key, [round(v, 4) for v in vals]]
        if nested:
            t.append(nested)
        out.append(t)
    return out


def ref_value(terms: list[list], is_ult: bool) -> float:
    total = 0.0
    for t in terms:
        vals = t[1]
        v = vals[min(len(vals) - 1, 1 if is_ult else 2)]
        total += v * REF.get(t[0], 0.5)
        for pk, pv in (t[2] if len(t) > 2 else []):
            total += pv * REF.get(t[0], 0.5) * 1.0
    return total


def tick_mult(name: str) -> float:
    n = name.lower()
    return TICK_MULT if ("per tick" in n or "per second" in n or "per hit" in n or "per bullet" in n or "per bolt" in n) else 1.0


def dtype_of(name: str, ability_type: str | None, adaptive: str | None) -> str:
    n = name.lower()
    if "true" in n:
        return "t"
    if "mixed" in n:
        return "x"
    if "physical" in n:
        return "p"
    if "magic" in n:
        return "m"
    at = ability_type or ""
    if at.startswith("PHYSICAL"):
        return "p"
    if at.startswith("MAGIC"):
        return "m"
    if at.startswith("TRUE"):
        return "t"
    if at.startswith("MIXED"):
        return "x"
    return "p" if (adaptive or "").startswith("PHYSICAL") else "m"


def shape_of(terms: list[list]) -> list[float] | None:
    """Rank values of the first term (flat when present): two parts with proportional shapes describe one hit."""
    for t in terms:
        if t[0] == "flat":
            return t[1]
    return terms[0][1] if terms else None


def same_hit(a: list[list], b: list[list]) -> bool:
    """b restates a (a splash at 80 %, "total mixed damage" = magic + its true part, a max-health variant ...)."""
    sa, sb = shape_of(a), shape_of(b)
    if not sa or not sb or len(sa) != len(sb):
        return False
    ratios = [y / x for x, y in zip(sa, sb) if x]
    if not ratios or any(x == 0 and y != 0 for x, y in zip(sa, sb)):
        return False
    lo, hi = min(ratios), max(ratios)
    return hi <= lo * 1.03 + 1e-9 and 0.3 <= lo <= 2.5


def parse_entry(ab: dict, is_ult: bool, adaptive: str | None, skipped: list[str], tag: str) -> tuple[list, list, float, float]:
    """One Meraki ability entry -> (damage parts, support parts, ref damage, ref support)."""
    dparts: list[tuple[float, list]] = []
    hparts: list[tuple[float, list]] = []
    for e in ab.get("effects") or []:
        levels = e.get("leveling") or []
        names = [lv["attribute"] for lv in levels]
        has_total = any("total" in n.lower() and "damage" in n.lower() for n in names)
        by_name = {lv["attribute"].lower(): lv for lv in levels}
        best_d = best_h = None
        for lv in levels:
            n = lv["attribute"].lower()
            if "damage" in n and not DMG_SKIP.search(n) and not (has_total and "total" not in n):
                ts = terms_of(lv, skipped, f"{tag} {lv['attribute']}")
                if ts:
                    mult = tick_mult(n)
                    dt = dtype_of(lv["attribute"], ab.get("damageType"), adaptive)
                    r = ref_value(ts, is_ult) * mult
                    # "maximum X" with a matching "minimum X" (missing-health / charge scaling): use the midpoint
                    lo = by_name.get("minimum" + n[len("maximum"):]) if n.startswith("maximum") else None
                    if lo is not None:
                        lts = terms_of(lo, skipped, f"{tag} {lo['attribute']}")
                        if lts:
                            r = (r + ref_value(lts, is_ult) * mult) / 2
                            cand = [[mult * 0.5, dt, ts], [mult * 0.5, dt, lts]]
                        else:
                            cand = [[mult, dt, ts]]
                    else:
                        cand = [[mult, dt, ts]]
                    if best_d is None or r > best_d[0]:
                        best_d = (r, cand)
            elif SUP_HIT.search(n) and not SUP_SKIP.search(n) and "damage" not in n:
                ts = terms_of(lv, skipped, f"{tag} {lv['attribute']}")
                if ts:
                    mult = tick_mult(n)
                    r = ref_value(ts, is_ult) * mult
                    if best_h is None or r > best_h[0]:
                        best_h = (r, [[mult, "s" if "shield" in n else "h", ts]])
        for best, parts in ((best_d, dparts), (best_h, hparts)):
            if not best:
                continue
            r, cand = best
            # a later effect that restates an earlier hit replaces it only when larger (main target vs splash)
            dup = next((i for i, (_, ps) in enumerate(parts) if same_hit(ps[0][2], cand[0][2])), None)
            if dup is None:
                parts.append((r, cand))
            elif r > parts[dup][0]:
                parts[dup] = (r, cand)
    d = [p for _, ps in dparts for p in ps]
    h = [p for _, ps in hparts for p in ps]
    return d, h, sum(r for r, _ in dparts), sum(r for r, _ in hparts)


def cooldowns(ab: dict) -> list[float] | None:
    cd = ab.get("cooldown") or {}
    mods = cd.get("modifiers") or []
    if mods:
        vals = num_list(mods[0].get("values") or [])
        if vals and max(vals) > 0:
            return [round(v, 2) for v in vals]
    rr = ab.get("rechargeRate")
    if isinstance(rr, list):
        vals = num_list(rr)
        if vals and max(vals) > 0:
            return [round(v, 2) for v in vals]
    return None


def champ_stats(st: dict) -> dict:
    def pair(k: str) -> list[float]:
        s = st.get(k) or {}
        return [round(float(s.get("flat") or 0), 3), round(float(s.get("perLevel") or 0), 3)]
    a = st.get("attackSpeed") or {}
    return {
        "hp": pair("health"), "ad": pair("attackDamage"), "ar": pair("armor"), "mr": pair("magicResistance"),
        "mana": pair("mana"),
        "as": round(float(a.get("flat") or 0.625), 4),
        "asr": round(float((st.get("attackSpeedRatio") or {}).get("flat") or a.get("flat") or 0.625), 4),
        "asg": round(float(a.get("perLevel") or 0), 3),
        "crit": round(float((st.get("criticalStrikeDamage") or {}).get("flat") or 175), 1),
        "ms": round(float((st.get("movespeed") or {}).get("flat") or 335), 1),
    }


ITEM_PATTERNS = {
    "apen": re.compile(r"([\d.]+)%\s*Armor Penetration", re.I),
    "mpenPct": re.compile(r"([\d.]+)%\s*Magic Penetration", re.I),
    "critDmg": re.compile(r"([\d.]+)%\s*Critical Strike Damage", re.I),
    "ls": re.compile(r"([\d.]+)%\s*Life Steal", re.I),
    "ov": re.compile(r"([\d.]+)%\s*Omnivamp", re.I),
    "hsp": re.compile(r"([\d.]+)%\s*Heal and Shield Power", re.I),
}
AP_AMP = re.compile(r"Ability Power by ([\d.]+)%", re.I)


def item_extras(version: str, used: set[str]) -> dict:
    path = DD_DIR / version / "item_en_US.json"
    if not path.exists():
        cands = sorted(DD_DIR.glob("*/item_en_US.json"))
        if not cands:
            return {}
        path = cands[-1]
    dd = json.loads(path.read_text(encoding="utf8"))["data"]
    out = {}
    for iid in sorted(used, key=lambda x: int(x)):
        d = dd.get(iid)
        if not d:
            continue
        desc = d.get("description") or ""
        m = re.search(r"<stats>(.*?)</stats>", desc, re.S)
        stats = re.sub(r"<[^>]+>", " ", m.group(1)) if m else ""
        ex = {}
        for k, pat in ITEM_PATTERNS.items():
            mm = pat.search(stats)
            if mm:
                ex[k] = float(mm.group(1))
        mm = AP_AMP.search(re.sub(r"<[^>]+>", " ", desc))
        if mm:
            ex["apAmp"] = float(mm.group(1))
        if ex:
            out[iid] = ex
    return out


# Champions newer than the Meraki data: their spells from CommunityDragon game data (data/cdragon/<id>.bin.json,
# downloaded 2026-11-26, game data of 2026-11-25), read by hand from the DataValues / mSpellCalculations
# (rank values are indices 1..5 of the 7-entry arrays, 1..3 for R).
CDRAGON_SPELLS: dict[str, list[dict]] = {
    "Zaahen": [
        # Q: empowered attack (15..75 + 20..40 % bonus AD) and recast (30..150 + same), heals 5..9 % max health
        {"t": "p", "d": [[1.0, "p", [["flat", _r(45, 90, 135, 180, 225)], ["bad", _r(40, 50, 60, 70, 80)]]]],
         "h": [[1.0, "h", [["mhp", _r(5, 6, 7, 8, 9)]]]], "cd": _r(10, 9, 8, 7, 6)},
        # W: stab 40..120 + 50 % bonus AD, then pull 30..110 + 30 % bonus AD
        {"t": "p", "d": [[1.0, "p", [["flat", _r(70, 110, 150, 190, 230)], ["bad", _r(80, 80, 80, 80, 80)]]]], "h": [],
         "cd": _r(16, 15, 14, 13, 12)},
        # E: 40..120 + 50 % bonus AD; the edge x1.5 and 4..6 % max health magic (counted as half the time)
        {"t": "x", "d": [[1.0, "p", [["flat", _r(50, 75, 100, 125, 150)], ["bad", _r(62.5, 62.5, 62.5, 62.5, 62.5)]]],
                         [0.5, "m", [["tmhp", _r(4, 4.5, 5, 5.5, 6)]]]], "h": [], "cd": _r(10, 9.5, 9, 8.5, 8)},
        # R: 250 / 400 / 550 + 200 % bonus AD (its 10..30 % armor penetration is in passives.ts)
        {"t": "p", "d": [[1.0, "p", [["flat", _r(250, 400, 550)], ["bad", _r(200, 200, 200)]]]], "h": [], "cd": _r(110, 95, 80)},
    ],
    "Locke": [
        # Q: nail 40..72 + 20 % AP, its mark 15..43 + 25..35 % AP when consumed
        {"t": "m", "d": [[1.0, "m", [["flat", _r(55, 70, 85, 100, 115)], ["ap", _r(45, 47.5, 50, 52.5, 55)]]]], "h": [],
         "cd": _r(10, 9, 8, 7, 6)},
        # W: soul ignition, recast 80..240 + 50 % AP; restores 60..180 + 60 % AP
        {"t": "m", "d": [[1.0, "m", [["flat", _r(80, 120, 160, 200, 240)], ["ap", _r(50, 50, 50, 50, 50)]]]],
         "h": [[1.0, "h", [["flat", _r(60, 90, 120, 150, 180)], ["ap", _r(60, 60, 60, 60, 60)]]]], "cd": _r(20, 18, 16, 14, 12)},
        # E: arrival 40..100 + 50 % AP, then the dash 40..120 + 40 % AP
        {"t": "m", "d": [[1.0, "m", [["flat", _r(80, 115, 150, 185, 220)], ["ap", _r(90, 90, 90, 90, 90)]]]], "h": [], "cd": None},
        # R: 150 / 225 / 300 + 60 % AP; executes under 10..12 % max health (counted as 5 % max health true)
        {"t": "x", "d": [[1.0, "m", [["flat", _r(150, 225, 300)], ["ap", _r(60, 60, 60)]]], [1.0, "t", [["tmhp", _r(5, 5.5, 6)]]]],
         "h": [], "cd": _r(120, 100, 80)},
    ],
}


def cdragon_stats(cid: str) -> dict | None:
    """Base stats from CommunityDragon's CharacterRecords/Root (Data Dragon has 0 AD growth for the newest ones)."""
    path = DATA / "cdragon" / f"{cid.lower()}.bin.json"
    if not path.exists():
        return None
    root = json.loads(path.read_text(encoding="utf8")).get(f"Characters/{cid}/CharacterRecords/Root") or {}

    def g(k: str) -> float:
        v = root.get(k + "Modifiable", root.get(k))
        v = v.get("baseValue") if isinstance(v, dict) else v
        return round(float(v or 0), 3)

    return {
        "hp": [g("baseHP"), g("hpPerLevel")], "ad": [g("baseDamage"), g("damagePerLevel")],
        "ar": [g("baseArmor"), g("armorPerLevel")], "mr": [g("baseMR"), g("mrPerLevel")],
        "mana": [0.0, 0.0], "as": g("attackSpeed"), "asr": g("attackSpeedRatio") or g("attackSpeed"),
        "asg": g("attackSpeedPerLevel"), "crit": 175.0, "ms": g("baseMoveSpeed"),
    }


def main() -> int:
    dump = None
    if "--dump" in sys.argv:
        dump = set(sys.argv[sys.argv.index("--dump") + 1].split(","))
    meraki = json.loads(MERAKI.read_text(encoding="utf8"))
    champs = json.loads(CHAMPS_JSON.read_text(encoding="utf8"))
    items = json.loads(ITEMS_JSON.read_text(encoding="utf8"))
    ids = [c["id"] for c in champs["champions"]]
    stats, spells, skipped, missing, nodmg = {}, {}, [], [], []
    dd_full = None
    for cid in sorted(ids):
        c = meraki.get(cid)
        if not c:
            # base stats from Data Dragon (no spell numbers there: the engine keeps the old formula for spells)
            if dd_full is None:
                p = sorted(DD_DIR.glob("*/championFull_en_US.json"))
                dd_full = json.loads(p[-1].read_text(encoding="utf8"))["data"] if p else {}
            s = (dd_full.get(cid) or {}).get("stats")
            if s:
                stats[cid] = {
                    "hp": [s["hp"], s["hpperlevel"]], "ad": [s["attackdamage"], s["attackdamageperlevel"]],
                    "ar": [s["armor"], s["armorperlevel"]], "mr": [s["spellblock"], s["spellblockperlevel"]],
                    "mana": [s.get("mp", 0), s.get("mpperlevel", 0)], "as": s["attackspeed"], "asr": s["attackspeed"],
                    "asg": s["attackspeedperlevel"], "crit": 175.0, "ms": s["movespeed"],
                }
            if cid in CDRAGON_SPELLS:
                spells[cid] = CDRAGON_SPELLS[cid]
                cs = cdragon_stats(cid)
                if cs:
                    if cid in stats:
                        cs["mana"] = stats[cid]["mana"]
                    stats[cid] = cs
            else:
                missing.append(cid)
            continue
        stats[cid] = champ_stats(c.get("stats") or {})
        adaptive = c.get("adaptiveType")
        row = []
        for k in KEYS:
            entries = (c.get("abilities") or {}).get(k) or []
            is_ult = k == "R"
            parsed = [parse_entry(ab, is_ult, adaptive, skipped, f"{cid} {k}") for ab in entries]
            if not parsed:
                row.append({"t": None, "d": [], "h": [], "cd": None})
                continue
            if (cid, k) in RECAST:
                d = [p for x in parsed for p in x[0]]
                h = [p for x in parsed for p in x[1]]
                cd = cooldowns(entries[0])
            else:
                best = max(range(len(parsed)), key=lambda i: (parsed[i][2], parsed[i][3], -i))
                d, h = parsed[best][0], parsed[best][1]
                cd = cooldowns(entries[best]) or cooldowns(entries[0])
            pick = PART_PICK.get((cid, k))
            if pick == "max" and d:
                # keep the largest hit (a min/max midpoint pair counts as one hit)
                groups, i = [], 0
                while i < len(d):
                    n = 2 if d[i][0] == 0.5 and i + 1 < len(d) and d[i + 1][0] == 0.5 else 1
                    groups.append(d[i:i + n])
                    i += n
                d = max(groups, key=lambda g: sum(ref_value(p[2], is_ult) * p[0] for p in g))
            elif isinstance(pick, list):
                d = [d[i] for i in pick if i < len(d)]
            ov = SPELL_OVERRIDES.get((cid, k))
            if ov is not None:
                d = ov["d"]
                h = ov.get("h", h)
            types = sorted({p[1] for p in d})
            row.append({"t": types[0] if len(types) == 1 else ("x" if types else None), "d": d, "h": h, "cd": cd,
                        **({"none": True} if ov is not None and not ov["d"] else {})})
            if not d and not h:
                nodmg.append(f"{cid} {k}")
        spells[cid] = row
        if dump and cid in dump:
            print(cid, json.dumps(stats[cid]))
            for k, s in zip(KEYS, row):
                print("  ", k, json.dumps(s))
    used = set(items.get("items", {}).keys())
    extras = item_extras(items.get("version") or champs.get("version") or "16.23.1", used)

    lines = [
        "// GENERATED by scripts/build_spells.py from Meraki champion data + Data Dragon item text.",
        "// Do not edit by hand: re-run `python -I scripts/build_spells.py`. Read by src/match/stats.ts.",
        "",
        "/** [base, growth per level]: stat at level n = base + growth * (n - 1) * (0.7025 + 0.0175 * (n - 1)) */",
        "export type Grow = [number, number];",
        "export interface ChampStats { hp: Grow; ad: Grow; ar: Grow; mr: Grow; mana: Grow; as: number; asr: number; asg: number; crit: number; ms: number }",
        "/** [key, value per rank, per-100 scalings of a percentage: [stat key, % per 100 of it]] */",
        "export type Term = [string, number[]] | [string, number[], [string, number][]];",
        "/** [times it lands in a fight, damage type p/m/t/x (shield s / heal h for support parts), terms] */",
        "export type Part = [number, string, Term[]];",
        "/** none: deals no damage in LoL although the kit gives it a damage weight (the engine then deals none) */",
        "export interface SpellStat { t: string | null; d: Part[]; h: Part[]; cd: number[] | null; none?: boolean }",
        "export interface ItemExtra { apen?: number; mpenPct?: number; critDmg?: number; apAmp?: number; ls?: number; ov?: number; hsp?: number }",
        "",
        f"export const SPELL_META = {{ source: \"meraki+ddragon\", champions: {len(stats)} }} as const;",
        "",
        "export const CHAMP_STATS: Record<string, ChampStats> = {",
    ]
    for cid in sorted(stats):
        lines.append(f"  {json.dumps(cid)}: {json.dumps(stats[cid], separators=(',', ':'))},")
    lines.append("};")
    lines.append("")
    lines.append("export const SPELLS: Record<string, SpellStat[]> = {")
    for cid in sorted(spells):
        lines.append(f"  {json.dumps(cid)}: {json.dumps(spells[cid], separators=(',', ':'), ensure_ascii=False)},")
    lines.append("};")
    lines.append("")
    lines.append("export const ITEM_EXTRAS: Record<string, ItemExtra> = {")
    for iid in sorted(extras, key=int):
        lines.append(f"  {json.dumps(iid)}: {json.dumps(extras[iid], separators=(',', ':'))},")
    lines.append("};")
    lines.append("")
    OUT.write_text("\n".join(lines), encoding="utf8", newline="\n")
    print(f"wrote {OUT.relative_to(GAME)}: {len(stats)} champions, {len(extras)} item extras")
    if missing:
        print(f"not in Meraki (engine falls back to the old formula): {', '.join(missing)}")
    print(f"spells with neither damage nor shield/heal data: {len(nodmg)}")
    uniq = sorted(set(s.split(': ', 1)[1] for s in skipped))
    print(f"unmodelled scaling units ({len(skipped)} uses): {', '.join(uniq[:40])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
