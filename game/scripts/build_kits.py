"""Build src/match/kits.gen.ts: per-champion spell behaviour for the teamfight AI.

Run from anywhere:  python -I scripts/build_kits.py   (add --dump <Id,...> to print kits for review)

Sources (all cached under LoLSim/data/kits_cache, downloaded once, sequentially):
  1. Data Dragon full champion JSON (local LoLSim/data/ddragon/<ver>/championFull_en_US.json when present,
     otherwise per-champion files from ddragon.leagueoflegends.com) -> spell text, cooldowns, ranges.
  2. Meraki Analytics champions.json -> effect descriptions with explicit CC durations, targeting, cast times,
     missile speeds, damage / shield / heal attributes.
  3. LCK 2026 timelines (LoLSim/data/raw/*.json.gz) -> dmgShare [AA, Q, W, E, R] from victimDamageReceived.
  4. OVERRIDES below: hand corrections for the most-picked champions (LoL knowledge), applied last.

The output is deterministic (sorted, no timestamps). champions.json is read-only here: `shape` is always the
champions.json `vfx` because the renderer draws by it.
"""
from __future__ import annotations

import collections
import glob
import gzip
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

GAME = Path(__file__).resolve().parent.parent
LOLSIM = GAME.parent
DATA = LOLSIM / "data"
CACHE = DATA / "kits_cache"
CHAMPS_JSON = GAME / "public" / "data" / "champions.json"
OUT = GAME / "src" / "match" / "kits.gen.ts"
RAW_GLOB = str(DATA / "raw" / "*.json.gz")
MERAKI_URL = "https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json"
DD_URL = "https://ddragon.leagueoflegends.com/cdn/{ver}/data/en_US/champion/{cid}.json"
UA = {"User-Agent": "lolsim-kits-builder/1.0"}

MIN_GAMES = 8          # dmgShare only for champions with at least this many pro games
PRO_BLEND = 0.6        # weight of the pro damage split vs. the kit prior when distributing dmg
KEYS = "QWER"

CC_TYPES = ("stun", "root", "knockup", "knockback", "pull", "slow", "charm", "taunt", "fear",
            "sleep", "suppress", "silence", "polymorph", "blind", "ground", "arena")
SAVES = ("relocate", "invuln", "revive")
ALLY_BUFFS = ("as", "ms", "ad", "dr", "stasis")
REQUIRES = ("airborne", "mark")
USES = ("engage", "poke", "burst", "dps", "cc", "peel", "shield", "heal", "buff", "escape", "gapclose",
        "zone", "execute", "waveclear", "summon", "stealth", "global")
ROLES = ("frontline", "diver", "assassin", "skirmisher", "backline", "artillery", "enchanter")
TARGETS = ("enemy", "ally", "self", "area", "direction")
BUFFS = ("as", "ms", "ad", "dr", "untargetable", "stealth")
# when a spell has several CC effects, keep the one that matters most for a fight
CC_PRIORITY = ("suppress", "knockup", "pull", "stun", "charm", "taunt", "fear", "sleep", "knockback",
               "polymorph", "root", "arena", "silence", "ground", "blind", "slow")
CC_DEFAULT_DUR = {"stun": 1.0, "root": 1.25, "knockup": 0.75, "knockback": 0.5, "pull": 0.5, "slow": 1.5,
                  "charm": 1.4, "taunt": 1.25, "fear": 1.25, "sleep": 1.5, "suppress": 1.75, "silence": 1.25,
                  "polymorph": 1.25, "blind": 1.5, "ground": 1.5, "arena": 3.0}

# ----------------------------------------------------------------------------------------------------------
# Hand overrides (top ~90 champions by LCK picks + notable others). Applied after the heuristics.
#   role: FightRole.  Per spell, space-separated tokens:
#   u=a,b,c        uses, most important first          t=enemy|ally|self|area|direction
#   cc=type:dur    crowd control (cc=- removes)         dash=len:target|direction|ally[:w]  (w = over walls; dash=- removes)
#   d=x            damage prior weight (0 = no damage)  s=x  shield/heal amount (0 removes)
#   dl=x delay s   ss=1|0 skillshot   r= range   rad= radius   wd= width   cd= cooldown
#   mt=n           minTargets (AoE ults)             buff=kind:dur (buff=- removes)
#   save=relocate|invuln|revive:dur[:radius]         ally=as|ms|ad|dr|stasis:dur:radius (0 = one ally)
#   req=airborne|mark  (the CC only lands on a target already in that state)
#   dcap=x         cap per-cast dmg (auras / channels); the excess fight damage goes to the other spells
# Fight-relevant reach: global ults that move the caster are capped to ~1500 u dashes (fight.ts engages from range).
# ----------------------------------------------------------------------------------------------------------
OVERRIDES: dict[str, tuple[str | None, dict[str, str]]] = {
    # --- top 100 by LCK picks (hand-checked spell by spell) ---------------------------------------------
    "XinZhao": ("diver", {
        "Q": "u=dps,cc t=self cc=knockup:0.75 r=175 buff=-",
        "W": "u=poke,dps,cc t=direction r=900 cc=slow:1.5 dl=0.5 ss=1",
        "E": "u=engage,gapclose,dps,cc t=enemy dash=650:target cc=slow:0.5 ss=0 dl=0.2 rad=225",
        "R": "u=dps,cc,peel,buff t=self cc=knockback:0.5 buff=dr:4 mt=1 rad=450 dl=0.35"}),
    "Rumble": ("skirmisher", {
        "Q": "u=dps,waveclear t=direction r=600 rad=350 dl=0 ss=0",
        "W": "u=shield,buff t=self s=2 buff=ms:1.5 cc=- d=0",
        "E": "u=poke,dps,cc t=direction cc=slow:2 ss=1 r=850 cd=6",
        "R": "u=zone,dps,cc t=direction cc=slow:1.5 mt=2 r=1700 dl=0.6 ss=1"}),
    "Ryze": ("backline", {
        "Q": "u=dps,poke t=direction r=1000 dl=0.3 ss=1",
        "W": "u=cc,peel,dps t=enemy cc=root:1.0 r=615 ss=0 req=mark",
        "E": "u=dps,waveclear t=enemy rad=350 ss=0",
        "R": "u=escape t=area dash=- d=0 cc=- dl=2.0 ss=0 buff=- mt=1 r=3000"}),
    "Ezreal": ("backline", {
        "Q": "u=poke,dps t=direction dl=0.45",
        "W": "u=poke,dps t=direction dl=0.5",
        "E": "u=escape,gapclose,dps t=direction dash=475:direction:w ss=0 dl=0.25",
        "R": "u=poke,global,dps t=direction dl=1.6 mt=1"}),
    "Ambessa": ("diver", {
        "Q": "u=dps,burst t=direction dash=- cc=- r=350 ss=1 dl=0.35",
        "W": "u=shield,dps,buff t=self s=2 dash=- buff=dr:0.75 rad=325",
        "E": "u=gapclose,dps,cc t=self dash=300:direction cc=slow:1.0 rad=325",
        "R": "u=engage,burst,cc,gapclose t=direction dash=1250:target:w cc=suppress:1.0 ss=0 dl=0.5 s=0"}),
    "Jhin": ("backline", {
        "Q": "u=dps,waveclear t=enemy r=550",
        "W": "u=poke,cc t=direction cc=root:1.5 r=2500 dl=0.75 ss=1 req=mark",
        "E": "u=zone,cc,dps t=area cc=slow:2.0 r=750 cd=12",
        "R": "u=poke,execute,dps,cc t=direction cc=slow:0.5 r=3500 dl=1.0 mt=1"}),
    "Pantheon": ("diver", {
        "Q": "u=poke,dps,execute t=direction r=1100 ss=1 cc=- dl=0.4",
        "W": "u=engage,cc,gapclose t=enemy cc=stun:1.0 dash=600:target:w ss=0",
        "E": "u=peel,buff,dps t=direction buff=dr:1.5 s=0 rad=400",
        "R": "u=engage,gapclose,dps t=area dash=1500:direction:w cc=slow:1.0 dl=2.0 ss=1 mt=1 r=1500"}),
    "Jayce": ("artillery", {
        "Q": "u=poke,dps t=direction r=1050 ss=1 dash=- cc=- dl=0.45",
        "W": "u=dps,buff t=self buff=as:3",
        "E": "u=peel,cc,dps t=enemy cc=knockback:0.6 r=240 ss=0",
        "R": "u=buff,dps t=self cd=6"}),
    "JarvanIV": ("diver", {
        "Q": "u=engage,cc,gapclose,dps t=direction dash=770:direction:w cc=knockup:0.75 ss=1 dl=0.4",
        "W": "u=shield,cc,peel t=self cc=slow:2.0 s=1 rad=600 d=0",
        "E": "u=dps,buff t=area r=860 rad=180",
        "R": "u=engage,cc,gapclose,zone,burst t=enemy dash=650:target:w cc=arena:3.5 ss=0 rad=350 mt=1"}),
    "MonkeyKing": ("diver", {
        "Q": "u=dps t=self buff=- r=300",
        "W": "u=escape,stealth t=self dash=300:direction ss=0 buff=stealth:1.0",
        "E": "u=engage,gapclose,dps t=enemy dash=650:target ss=0",
        "R": "u=engage,cc,dps t=self cc=knockup:0.6 rad=325 mt=2 dl=0"}),
    "Taliyah": ("backline", {
        "Q": "u=dps,poke,waveclear t=direction r=1000 cc=- ss=1 dl=0.3",
        "W": "u=cc,engage,peel t=area cc=knockup:0.75 dl=0.8 rad=225 d=0",
        "E": "u=zone,dps,cc t=direction cc=stun:0.75 rad=300 req=mark",
        "R": "u=engage,gapclose,zone t=direction dash=1500:direction:w cc=- d=0 r=1500 dl=1.0 ss=0 mt=1"}),
    "Azir": ("backline", {
        "Q": "u=dps,poke,cc t=area dash=- cc=slow:1.0 r=740 rad=250 dl=0.35",
        "W": "u=dps,summon,zone t=area rad=320 r=525 buff=- cd=4",
        "E": "u=gapclose,escape,cc,shield t=area dash=1100:direction cc=knockup:0.5 s=1 ss=0",
        "R": "u=engage,peel,cc t=direction cc=knockback:0.75 dash=- wd=600 r=250 mt=1 dl=0.25"}),
    "Alistar": ("frontline", {
        "Q": "u=engage,cc,peel t=self cc=knockup:1.0 rad=365 dl=0.25",
        "W": "u=engage,peel,cc,gapclose t=enemy cc=knockback:0.75 dash=650:target ss=0",
        "E": "u=dps,cc t=self cc=stun:1.0 rad=350",
        "R": "u=buff t=self buff=dr:7 d=0"}),
    "Corki": ("backline", {
        "Q": "u=poke,dps,waveclear t=area",
        "W": "u=escape,gapclose,dps,zone t=direction dash=600:direction ss=0",
        "E": "u=dps t=direction r=600",
        "R": "u=poke,dps t=direction r=1300 cd=2"}),
    "Vi": ("diver", {
        "Q": "u=engage,gapclose,cc,dps t=direction dash=725:direction cc=knockback:0.5 ss=1 dl=0.6 r=725",
        "W": "u=dps t=self dash=- buff=- cd=4",
        "E": "u=dps,waveclear t=direction cd=6",
        "R": "u=engage,cc,burst,gapclose t=enemy dash=800:target cc=knockup:1.3 ss=0 dl=0.5"}),
    "Aurora": ("backline", {
        "Q": "u=poke,dps t=direction ss=1 r=900",
        "W": "u=escape,gapclose,stealth t=direction dash=400:direction:w buff=stealth:1.5 d=0",
        "E": "u=dps,peel,cc,escape t=direction cc=slow:1.0 dash=250:direction",
        "R": "u=engage,zone,dps,cc t=direction dash=300:direction:w cc=slow:1.75 mt=2 r=700 rad=450 buff=-"}),
    "Nautilus": ("frontline", {
        "Q": "u=engage,cc,gapclose,dps t=direction cc=pull:0.6 dash=1100:direction ss=1 r=1100",
        "W": "u=shield,dps t=self s=2",
        "E": "u=dps,cc,peel t=self cc=slow:1.5 rad=475",
        "R": "u=engage,cc,burst t=enemy cc=knockup:1.25 ss=0 r=825 dl=0.5"}),
    "Ahri": ("assassin", {
        "Q": "u=poke,dps,waveclear t=direction r=970 cc=-",
        "W": "u=dps,burst t=self buff=ms:1.5 cc=- rad=700",
        "E": "u=cc,burst,poke t=direction cc=charm:1.5",
        "R": "u=gapclose,escape,burst t=direction dash=500:direction ss=0"}),
    "KSante": ("frontline", {
        "Q": "u=dps,cc t=direction cc=slow:1.0 r=465",
        "W": "u=engage,cc,gapclose,peel t=direction cc=stun:1.0 dash=500:direction buff=dr:1",
        "E": "u=gapclose,shield,escape,peel t=direction dash=400:direction s=1",
        "R": "u=engage,peel,cc,buff,burst t=enemy cc=knockback:0.75 dash=350:target:w buff=ad:8 ss=0"}),
    "Rakan": ("diver", {
        "Q": "u=dps,heal t=direction s=1",
        "W": "u=engage,cc,gapclose t=area cc=knockup:1.0 dash=600:direction:w dl=0.5 rad=250",
        "E": "u=shield,escape,peel t=ally dash=700:ally:w cc=- s=1.5 d=0",
        "R": "u=engage,cc,buff t=self cc=charm:1.25 buff=ms:4 dash=- mt=2 dl=0"}),
    "Lucian": ("backline", {
        "Q": "u=dps,burst t=enemy r=500 ss=0",
        "W": "u=dps t=direction r=900",
        "E": "u=gapclose,escape t=direction dash=425:direction",
        "R": "u=dps,burst t=direction r=1200 ss=1 dl=0.3"}),
    "Neeko": ("backline", {
        "Q": "u=dps,poke,waveclear",
        "W": "u=escape,summon,stealth t=direction buff=stealth:0.5",
        "E": "u=cc,poke,dps cc=root:1.5",
        "R": "u=engage,cc,dps t=self cc=stun:1.25 dash=- rad=600 dl=1.25 mt=2 ss=0"}),
    "Sion": ("frontline", {
        "Q": "u=engage,cc,dps t=direction cc=knockup:1.0 r=750 rad=300 dl=1.2 ss=1",
        "W": "u=shield,dps t=self s=2 rad=550",
        "E": "u=poke,cc,dps t=direction cc=slow:2.5 r=800",
        "R": "u=engage,cc,gapclose t=direction dash=1500:direction cc=knockup:1.0 r=1500 dl=1.2 mt=1"}),
    "Rell": ("frontline", {
        "Q": "u=cc,peel,dps t=direction cc=stun:0.65 r=600",
        "W": "u=engage,cc,gapclose,shield t=area cc=knockup:1.0 dash=450:direction:w s=2 dl=0.6",
        "E": "u=gapclose,buff,dps t=self buff=ms:3 dash=- ally=ms:3:0",
        "R": "u=engage,cc,zone,dps t=self cc=pull:1.0 rad=400 mt=2 dl=0.25"}),
    "Varus": ("backline", {
        "Q": "u=poke,dps t=direction r=1500 cc=- ss=1 dl=1.0",
        "W": "u=dps,buff t=self cd=40 buff=-",
        "E": "u=poke,dps,cc,zone t=area cc=slow:1.5",
        "R": "u=engage,cc,peel t=direction cc=root:2.0 r=1370 dl=0.6 mt=1"}),
    "Orianna": ("backline", {
        "Q": "u=poke,dps,waveclear t=area dash=- r=825 rad=175 dl=0.45",
        "W": "u=dps,cc t=area cc=slow:2.0 rad=225 ally=ms:2:225",
        "E": "u=shield,peel t=ally s=2 dash=- r=1100",
        "R": "u=engage,cc,dps t=area cc=pull:0.75 rad=415 dl=0.5 mt=3 ss=1"}),
    "Gnar": ("frontline", {
        "Q": "u=poke,dps,cc t=direction cc=slow:2.0 dash=- r=1100",
        "W": "u=cc,dps t=direction cc=stun:1.25 r=550 ss=1",
        "E": "u=gapclose,escape t=direction dash=475:direction:w cc=slow:0.5",
        "R": "u=engage,cc,dps t=self cc=stun:1.25 rad=475 dl=0.25 ss=0 mt=2"}),
    "Gwen": ("skirmisher", {
        "Q": "u=dps,burst t=direction r=450",
        "W": "u=buff,zone,peel t=self buff=untargetable:2.0 d=0",
        "E": "u=gapclose,dps,buff t=direction dash=350:direction buff=as:4",
        "R": "u=poke,dps,cc t=direction cc=slow:1.5 r=1200 ss=1"}),
    "Renekton": ("diver", {
        "Q": "u=dps,heal,waveclear t=self s=1",
        "W": "u=cc,burst t=enemy cc=stun:1.0 r=175",
        "E": "u=gapclose,escape,dps t=direction dash=450:direction",
        "R": "u=buff,zone,dps t=self buff=dr:15 mt=1 s=0 dcap=0.8"}),
    "Yunara": ("backline", {
        "Q": "u=dps,buff t=self buff=as:5 cd=8",
        "W": "u=poke,dps,cc t=direction cc=slow:1.5",
        "E": "u=escape,buff t=self buff=ms:2 dash=300:direction d=0",
        "R": "u=buff,dps t=self buff=as:15 dash=- d=0"}),
    "Annie": ("backline", {
        "Q": "u=burst,dps t=enemy cc=-",
        "W": "u=dps,waveclear t=direction",
        "E": "u=shield,peel t=ally s=1.5 d=0.3 ally=ms:1.5:0",
        "R": "u=engage,cc,burst,summon t=area cc=stun:1.5 mt=2 rad=290 dl=0.25"}),
    "Viktor": ("backline", {
        "Q": "u=dps,shield t=enemy s=1",
        "W": "u=zone,cc,peel t=area cc=stun:1.5 d=0 dl=1.0",
        "E": "u=poke,dps,waveclear t=direction r=1025",
        "R": "u=dps,zone t=area mt=2"}),
    "Bard": ("enchanter", {
        "Q": "u=cc,peel,engage,poke t=direction cc=stun:1.4 r=950 dl=0.4",
        "W": "u=heal t=ally s=1 d=0",
        "E": "u=escape,gapclose t=direction dash=900:direction:w d=0 ss=0",
        "R": "u=engage,cc,peel,zone t=area cc=stun:2.5 mt=2 r=3400 rad=350 dl=1.0 buff=- d=0 ally=stasis:2.5:350"}),
    "Galio": ("frontline", {
        "Q": "u=poke,dps,waveclear t=area r=825",
        "W": "u=engage,cc,peel,buff t=self cc=taunt:1.25 buff=dr:2 rad=350 s=0",
        "E": "u=engage,cc,gapclose t=direction dash=650:direction cc=knockup:0.75 ss=1",
        "R": "u=engage,cc,shield t=ally dash=1500:ally:w cc=knockup:0.75 mt=2 dl=2.75 s=2 r=1500 rad=500"}),
    "Kaisa": ("backline", {
        "Q": "u=burst,dps t=self rad=600 r=600",
        "W": "u=poke,dps t=direction r=3000 ss=1 dl=0.9",
        "E": "u=buff,escape t=self buff=as:4",
        "R": "u=gapclose,shield,escape t=enemy dash=1500:target:w s=1.5 ss=0"}),
    "Ashe": ("backline", {
        "Q": "u=dps,buff t=self buff=as:4",
        "W": "u=poke,dps,cc t=direction cc=slow:2.0 r=1200",
        "E": "u=global t=area d=0 dash=- ss=0 cd=90",
        "R": "u=engage,cc,global t=direction cc=stun:2.0 r=2500 dl=1.2 ss=1 mt=1"}),
    "Lulu": ("enchanter", {
        "Q": "u=poke,cc,dps t=direction cc=slow:2.0",
        "W": "u=peel,cc,buff t=enemy cc=polymorph:1.4 d=0 ally=as:4:0",
        "E": "u=shield,peel t=ally s=2 dash=-",
        "R": "u=peel,heal,cc t=ally cc=knockup:1.0 s=3 rad=400 dl=0 mt=1"}),
    "Nocturne": ("diver", {
        "Q": "u=dps,poke t=direction",
        "W": "u=buff,shield t=self buff=as:5 s=1",
        "E": "u=cc,peel t=enemy cc=fear:1.5 dl=2.0",
        "R": "u=engage,gapclose,burst t=enemy dash=1500:target:w cc=- r=1500 dl=1.0 ss=0"}),
    "Poppy": ("frontline", {
        "Q": "u=dps,cc,zone t=direction cc=slow:1.5 s=0",
        "W": "u=peel,buff,zone t=self cc=ground:2.5 dash=- buff=ms:2",
        "E": "u=engage,cc,gapclose t=enemy cc=stun:1.6 dash=475:target",
        "R": "u=peel,cc,engage t=direction cc=knockback:1.0 r=500 dl=0.5 mt=1 buff=-"}),
    "Leona": ("frontline", {
        "Q": "u=cc,engage t=enemy cc=stun:1.0 r=175",
        "W": "u=buff,dps t=self buff=dr:3 s=0 rad=450",
        "E": "u=engage,cc,gapclose t=direction cc=root:0.5 dash=875:direction ss=1 dl=0.4",
        "R": "u=engage,cc,dps t=area cc=stun:1.75 mt=2 r=1200 rad=325 dl=0.63"}),
    "MissFortune": ("backline", {
        "Q": "u=dps,burst t=enemy",
        "W": "u=buff t=self buff=as:4 d=0",
        "E": "u=zone,cc,dps,poke t=area cc=slow:1.5 r=1000 rad=400",
        "R": "u=dps,zone t=direction mt=3 r=1450 rad=1450 ss=1 dl=0.3"}),
    "Naafiri": ("assassin", {
        "Q": "u=poke,burst t=direction dash=- s=0 r=900",
        "W": "u=buff,gapclose t=self buff=untargetable:0.5 dash=- cc=- d=0",
        "E": "u=gapclose,escape,burst t=direction dash=350:direction buff=-",
        "R": "u=engage,burst,gapclose t=enemy dash=900:target s=1 cc=- ss=0"}),
    "LeeSin": ("diver", {
        "Q": "u=engage,gapclose,dps,poke t=direction dash=1100:target:w ss=1 cc=-",
        "W": "u=shield,escape,peel t=ally dash=700:ally:w cc=- s=1.5 d=0",
        "E": "u=dps,cc t=self cc=slow:2.0 buff=-",
        "R": "u=engage,peel,cc,burst t=enemy cc=knockback:1.0 r=375 mt=1"}),
    "Braum": ("frontline", {
        "Q": "u=poke,cc,dps t=direction cc=slow:2.0",
        "W": "u=peel,escape t=ally dash=650:ally s=1 d=0 ally=dr:3:0",
        "E": "u=peel,buff t=self buff=dr:4 s=0 r=300 d=0 ss=0",
        "R": "u=engage,cc,peel t=direction cc=knockup:1.25 mt=2 dash=- r=1250 wd=230 dl=0.5"}),
    "Sivir": ("backline", {
        "Q": "u=poke,dps,waveclear t=direction",
        "W": "u=dps,waveclear t=self buff=-",
        "E": "u=shield t=self s=1 buff=-",
        "R": "u=engage,buff,escape t=self buff=ms:4 d=0 ally=ms:4:1000"}),
    "Karma": ("enchanter", {
        "Q": "u=poke,dps,cc t=direction cc=slow:1.5",
        "W": "u=cc,peel,dps t=enemy cc=root:1.6 dl=2.0",
        "E": "u=shield,peel,buff t=ally s=2 d=0 ally=ms:1.5:0",
        "R": "u=buff t=self cc=- cd=40"}),
    "Skarner": ("frontline", {
        "Q": "u=dps,poke t=self",
        "W": "u=shield,cc,dps t=self cc=slow:1.5 s=2",
        "E": "u=engage,cc,gapclose t=direction dash=1000:direction:w cc=stun:1.0 ss=1",
        "R": "u=engage,cc,peel t=direction cc=suppress:1.5 r=625 mt=1 dl=0.5"}),
    "Xayah": ("backline", {
        "Q": "u=dps,poke t=direction r=1100",
        "W": "u=buff,dps t=self buff=as:4",
        "E": "u=cc,dps,peel t=self cc=root:1.25 req=mark",
        "R": "u=escape,dps,buff t=direction buff=untargetable:1.5 dash=250:direction mt=1"}),
    "Trundle": ("skirmisher", {
        "Q": "u=dps t=self cc=- buff=-",
        "W": "u=buff,zone t=area buff=as:5 d=0",
        "E": "u=peel,cc,zone t=area cc=knockback:0.5 d=0",
        "R": "u=burst,buff t=enemy buff=dr:4"}),
    "Yone": ("diver", {
        "Q": "u=dps,cc,gapclose t=direction cc=knockup:0.75 dash=450:direction",
        "W": "u=dps,shield t=direction s=1",
        "E": "u=gapclose,escape,burst t=direction dash=300:direction buff=- r=300",
        "R": "u=engage,cc,gapclose,dps t=direction cc=knockup:0.75 dash=1000:direction:w mt=2 ss=1 dl=0.75"}),
    "Yorick": ("skirmisher", {
        "Q": "u=dps,heal t=self s=1",
        "W": "u=engage,cc,peel t=area cc=arena:2.0 d=0 s=0",
        "E": "u=dps,cc,poke t=area cc=slow:1.5 dash=-",
        "R": "u=summon,dps t=area"}),
    "Caitlyn": ("backline", {
        "Q": "u=poke,dps,waveclear t=direction",
        "W": "u=zone,cc,peel t=area cc=root:1.5 buff=- cd=10",
        "E": "u=escape,cc,peel t=direction cc=slow:1.0 dash=390:direction",
        "R": "u=execute,burst,poke t=enemy dl=1.5 r=3500"}),
    "Sejuani": ("frontline", {
        "Q": "u=engage,cc,gapclose t=direction cc=knockup:0.5 dash=650:direction",
        "W": "u=dps,cc t=direction cc=slow:1.0",
        "E": "u=cc,peel t=enemy cc=stun:1.0 cd=10 req=mark",
        "R": "u=engage,cc t=direction cc=stun:1.25 mt=2 r=1300 ss=1 dl=0.6"}),
    "Renata": ("enchanter", {
        "Q": "u=cc,peel,engage t=direction cc=root:1.0",
        "W": "u=heal,peel,buff t=ally s=3 d=0 save=invuln:3 ally=as:3:0",
        "E": "u=shield,cc,dps t=direction cc=slow:1.0 s=1",
        "R": "u=engage,cc,peel t=direction cc=taunt:1.75 mt=2 r=2000 dl=1.2"}),
    "Kalista": ("backline", {
        "Q": "u=poke,dps t=direction dash=-",
        "W": "u=summon t=area d=0",
        "E": "u=dps,execute,cc t=self cc=slow:2.0 r=1100",
        "R": "u=peel,engage,cc t=ally cc=knockup:1.0 dash=- buff=- d=0 r=1100 mt=1 save=relocate:4"}),
    "Jax": ("skirmisher", {
        "Q": "u=gapclose,engage,dps t=enemy dash=700:target:w",
        "W": "u=dps,burst t=self dash=-",
        "E": "u=cc,peel,buff t=self cc=stun:1.0 buff=dr:2",
        "R": "u=buff,dps t=self buff=dr:8 mt=1"}),
    "Seraphine": ("enchanter", {
        "Q": "u=poke,dps,waveclear",
        "W": "u=shield,heal,peel t=ally s=2 rad=800 ally=ms:2:800",
        "E": "u=cc,peel,poke t=direction cc=root:1.0 req=mark",
        "R": "u=engage,cc,peel t=direction cc=charm:1.5 mt=2 r=1300 dl=0.5"}),
    "Cassiopeia": ("backline", {
        "Q": "u=poke,dps,waveclear",
        "W": "u=zone,cc,peel t=area cc=ground:2.0",
        "E": "u=dps,burst t=enemy s=0 cd=1.5",
        "R": "u=engage,cc,peel t=direction cc=stun:1.5 mt=2 r=825 dl=0.5"}),
    "Milio": ("enchanter", {
        "Q": "u=peel,cc,poke t=direction cc=knockback:0.5",
        "W": "u=heal,buff t=ally s=1.5 d=0",
        "E": "u=shield,peel,buff t=ally s=2 cd=15 d=0 ally=ms:2:0",
        "R": "u=heal,peel t=ally s=3 rad=700 d=0"}),
    "Aatrox": ("skirmisher", {
        "Q": "u=dps,cc t=direction cc=knockup:0.5 r=650 dl=0.6",
        "W": "u=cc,dps,peel t=direction cc=pull:0.5 dl=0.4",
        "E": "u=gapclose,escape t=direction dash=300:direction r=300",
        "R": "u=buff,dps t=self buff=ad:10 cc=- mt=1 s=2 d=0 rad=0"}),
    "Anivia": ("backline", {
        "Q": "u=cc,poke,dps t=direction cc=stun:1.3 dash=-",
        "W": "u=peel,zone t=area cc=- d=0",
        "E": "u=burst,dps t=enemy",
        "R": "u=zone,dps,cc,waveclear t=area cc=slow:1.5 mt=2 cd=4"}),
    "Sylas": ("diver", {
        "Q": "u=dps,poke,cc t=area cc=slow:1.5",
        "W": "u=gapclose,burst,heal t=enemy dash=400:target s=1",
        "E": "u=engage,cc,gapclose t=direction cc=knockup:0.5 dash=800:direction",
        "R": "u=burst,engage t=enemy d=1"}),
    "Akali": ("assassin", {
        "Q": "u=burst,dps,poke t=direction cc=-",
        "W": "u=stealth,escape,zone t=self dash=- buff=stealth:4 d=0",
        "E": "u=gapclose,poke,burst t=direction dash=650:direction",
        "R": "u=gapclose,execute,burst t=enemy dash=675:target"}),
    "Ziggs": ("artillery", {
        "Q": "u=poke,dps,waveclear",
        "W": "u=escape,peel,cc t=area cc=knockback:0.5 dash=400:direction",
        "E": "u=zone,cc,dps t=area cc=slow:1.5",
        "R": "u=poke,dps,global t=area mt=2 dl=1.2"}),
    "Zeri": ("backline", {
        "Q": "u=dps t=direction r=825 cd=1.5",
        "W": "u=poke,cc,dps t=direction cc=slow:1.5",
        "E": "u=escape,gapclose t=direction dash=300:direction:w r=300",
        "R": "u=dps,buff t=self buff=as:5 mt=1 rad=825"}),
    "Camille": ("diver", {
        "Q": "u=dps,burst t=self",
        "W": "u=dps,poke,cc t=direction cc=slow:2.0",
        "E": "u=engage,cc,gapclose t=direction cc=stun:0.75 dash=800:direction:w",
        "R": "u=engage,cc,zone,burst t=enemy cc=knockback:0.5 dash=475:target:w buff=untargetable:0.5 mt=1"}),
    "Shen": ("frontline", {
        "Q": "u=dps,cc t=self cc=slow:1.5 dash=-",
        "W": "u=peel,zone t=self s=1.5 d=0",
        "E": "u=engage,cc,gapclose,peel t=direction cc=taunt:1.5 dash=600:direction ss=1",
        "R": "u=shield,peel,global t=ally s=3 dash=1500:ally:w dl=3.0 r=25000"}),
    "Maokai": ("frontline", {
        "Q": "u=peel,cc,dps t=direction cc=knockback:0.5",
        "W": "u=engage,cc,gapclose t=enemy cc=root:1.2 dash=525:target:w",
        "E": "u=zone,poke,cc,dps t=area cc=slow:2.0",
        "R": "u=engage,cc,peel t=direction cc=root:1.5 mt=2 r=3000 dl=1.5"}),
    "Nidalee": ("assassin", {
        "Q": "u=poke,burst,execute t=direction dash=- r=1500",
        "W": "u=gapclose,escape,dps t=direction dash=375:direction:w",
        "E": "u=heal,dps t=ally s=1.5",
        "R": "u=buff t=self d=0"}),
    "Olaf": ("diver", {
        "Q": "u=poke,cc,dps t=direction cc=slow:1.5",
        "W": "u=buff,shield t=self buff=as:4 s=1",
        "E": "u=burst,dps t=enemy",
        "R": "u=engage,buff t=self buff=ms:3 d=0"}),
    "Syndra": ("backline", {
        "Q": "u=poke,dps",
        "W": "u=dps,cc t=area cc=slow:1.5",
        "E": "u=cc,peel,engage t=direction cc=stun:1.25",
        "R": "u=burst,execute t=enemy"}),
    "Elise": ("assassin", {
        "Q": "u=burst,gapclose,execute t=enemy dash=475:target",
        "W": "u=dps,poke t=area buff=-",
        "E": "u=cc,engage,poke t=direction cc=stun:1.8 buff=-",
        "R": "u=buff t=self d=0"}),
    "Ornn": ("frontline", {
        "Q": "u=poke,cc,dps t=direction cc=slow:2.0",
        "W": "u=dps,buff t=direction r=500 cc=- buff=dr:0.75",
        "E": "u=engage,cc,gapclose t=direction cc=knockup:1.0 dash=650:direction",
        "R": "u=engage,cc,peel t=direction cc=knockup:1.0 mt=2 r=2500 dl=1.5 dash=-"}),
    "TwistedFate": ("backline", {
        "Q": "u=poke,dps,waveclear t=direction r=1450",
        "W": "u=cc,burst,peel t=enemy cc=stun:1.6 r=600",
        "E": "u=dps,buff t=self buff=as:3",
        "R": "u=gapclose,escape t=area dash=1500:direction:w dl=1.5 d=0 r=1500"}),
    "Nami": ("enchanter", {
        "Q": "u=cc,engage,peel t=area cc=knockup:1.5 dl=0.95",
        "W": "u=heal,dps t=ally s=1.5",
        "E": "u=buff,cc t=ally cc=slow:1.0 ally=ad:6:0",
        "R": "u=engage,cc,peel t=direction cc=knockup:1.0 mt=2"}),
    "Zaahen": ("diver", {
        "Q": "u=dps,cc,heal t=self cc=knockup:0.75 s=1 r=175",
        "W": "u=cc,engage,dps t=direction cc=pull:0.75 r=850 ss=1 dl=0.4",
        "E": "u=gapclose,dps,escape t=direction dash=400:direction r=400",
        "R": "u=engage,dps,heal,buff t=area cc=- buff=dr:1 s=1 mt=1 dash=500:direction:w"}),
    "Senna": ("backline", {
        "Q": "u=dps,heal,poke t=enemy s=1.5",
        "W": "u=cc,peel,poke t=direction cc=root:1.5",
        "E": "u=stealth,escape,buff t=self buff=stealth:3",
        "R": "u=poke,shield,global,dps t=direction s=2"}),
    "Viego": ("skirmisher", {
        "Q": "u=dps t=direction",
        "W": "u=cc,gapclose,engage t=direction cc=stun:1.0 dash=300:direction ss=1",
        "E": "u=stealth,buff t=self buff=stealth:3",
        "R": "u=execute,burst,gapclose t=area dash=500:direction:w cc=knockback:0.5"}),
    "Aphelios": ("backline", {
        "Q": "u=dps,poke,cc t=direction cc=root:1.0 buff=- req=mark",
        "W": "u=buff t=self cd=3",
        "E": "u=buff t=self d=0",
        "R": "u=dps,burst t=direction cc=- mt=2"}),
    "Mel": ("backline", {
        "Q": "u=poke,dps",
        "W": "u=shield,peel,buff t=self s=1.5 ally=ms:2:400",
        "E": "u=cc,poke,dps t=direction cc=root:1.5",
        "R": "u=execute,burst,global t=self"}),
    "Lillia": ("skirmisher", {
        "E": "u=poke,cc,dps cc=slow:1.5",
        "R": "u=engage,cc t=self cc=sleep:1.5 dl=1.5 mt=2 d=0.5"}),
    "Jinx": ("backline", {
        "Q": "u=buff t=self buff=as:4 cd=3 d=0",
        "W": "u=poke,cc,dps t=direction cc=slow:2.0",
        "E": "u=peel,zone,cc t=area cc=root:1.5",
        "R": "u=execute,poke,global t=direction mt=1"}),
    "Kennen": ("diver", {
        "Q": "u=poke,dps t=direction",
        "W": "u=dps,cc t=self",
        "E": "u=gapclose,escape,buff t=self buff=ms:2 dash=-",
        "R": "u=engage,cc,dps t=self cc=stun:1.0 mt=3 rad=550"}),
    "Gragas": ("frontline", {
        "Q": "u=poke,dps,cc t=area cc=slow:2.0",
        "W": "u=buff,dps t=self buff=dr:2.5",
        "E": "u=engage,cc,gapclose t=direction cc=stun:1.0 dash=600:direction",
        "R": "u=engage,peel,cc t=area cc=knockback:0.75 mt=1 r=1000 dl=0.6"}),
    "Vayne": ("backline", {
        "Q": "u=dps,escape,gapclose t=direction dash=300:direction",
        "W": "u=dps t=self",
        "E": "u=peel,cc t=enemy cc=stun:1.5",
        "R": "u=buff,dps t=self buff=ad:8 d=0"}),
    "Blitzcrank": ("frontline", {
        "Q": "u=engage,cc t=direction cc=pull:0.65 dash=- r=1079",
        "W": "u=buff,gapclose t=self buff=ms:3 cc=- d=0",
        "E": "u=cc,peel t=self cc=knockup:1.0",
        "R": "u=dps,cc t=self cc=silence:0.5 mt=2"}),
    "Tristana": ("backline", {
        "Q": "u=buff,dps t=self buff=as:7 d=0",
        "W": "u=escape,gapclose,dps t=area dash=900:direction:w cc=slow:1.0",
        "E": "u=burst,dps t=enemy cc=-",
        "R": "u=peel,cc,burst t=enemy cc=knockback:0.75"}),
    "RekSai": ("diver", {
        "Q": "u=dps t=self",
        "W": "u=engage,cc t=self cc=knockup:1.0 r=175",
        "E": "u=gapclose,escape,dps t=direction dash=750:direction:w",
        "R": "u=execute,burst,gapclose t=enemy dash=1500:target:w"}),
    "Chogath": ("frontline", {
        "Q": "u=cc,engage,dps t=area cc=knockup:1.0 dl=1.0",
        "W": "u=cc,peel,dps t=direction cc=silence:1.8",
        "E": "u=dps t=self cc=slow:1.0",
        "R": "u=execute,burst t=enemy s=0"}),
    "Hwei": ("artillery", {
        "Q": "u=poke,dps t=direction r=1200 ss=1 cc=-",
        "W": "u=shield,buff t=ally s=1",
        "E": "u=cc,peel,engage t=direction cc=root:1.0 dash=- r=1100 ss=1",
        "R": "u=dps,cc t=direction cc=slow:1.5 mt=2"}),
    "Thresh": ("frontline", {
        "Q": "u=engage,cc,gapclose t=direction cc=stun:1.5 dash=1075:direction ss=1",
        "W": "u=shield,peel,escape t=ally s=1.5 dash=- d=0 save=relocate:1",
        "E": "u=peel,cc,dps t=direction cc=knockback:0.5",
        "R": "u=zone,cc,peel t=self cc=slow:2.0 mt=1"}),
    "Pyke": ("assassin", {
        "Q": "u=engage,cc t=direction cc=pull:0.5 dash=-",
        "W": "u=stealth,gapclose t=self buff=stealth:5 d=0",
        "E": "u=cc,engage,gapclose t=direction cc=stun:1.25 dash=550:direction",
        "R": "u=execute,burst t=area mt=1"}),
    "Yuumi": ("enchanter", {
        "Q": "u=poke,cc,dps t=direction cc=slow:1.5",
        "W": "u=buff,shield t=ally buff=untargetable:5 d=0 s=1",
        "E": "u=heal,buff t=ally s=2 d=0 ally=ms:2:0",
        "R": "u=cc,peel,zone t=direction cc=root:1.75 mt=2"}),
    "Zyra": ("backline", {
        "E": "u=cc,poke,dps t=direction cc=root:1.5",
        "R": "u=engage,cc,dps t=area cc=knockup:1.0 mt=2 dl=2.0"}),
    "Leblanc": ("assassin", {
        "W": "u=gapclose,burst,escape t=area dash=600:direction:w",
        "E": "u=cc,burst t=direction cc=root:1.5 dl=1.5"}),
    "Qiyana": ("assassin", {
        "E": "u=gapclose,burst t=enemy dash=550:target",
        "R": "u=engage,cc,burst t=direction cc=stun:1.0 mt=2 r=875"}),
    "Lux": ("artillery", {
        "Q": "u=cc,poke,dps t=direction cc=root:2.0",
        "W": "u=shield,peel t=ally s=1.5 d=0",
        "E": "u=poke,zone,cc,dps cc=slow:1.0",
        "R": "u=poke,burst,execute t=direction r=3400 dl=1.0 mt=1"}),
    "DrMundo": ("frontline", {
        "Q": "u=poke,cc,dps t=direction cc=slow:2.0",
        "R": "u=buff,heal t=self buff=ms:10 s=2 d=0"}),
    "Locke": ("assassin", {
        "Q": "u=poke,dps,cc t=direction cc=slow:1.5",
        "W": "u=buff,gapclose t=self buff=as:5 d=0",
        "E": "u=gapclose,burst t=area dash=425:direction:w",
        "R": "u=execute,burst,cc t=area cc=slow:1.5 mt=1"}),
    "Smolder": ("backline", {
        "E": "u=escape,gapclose t=direction dash=600:direction:w d=0.5",
        "R": "u=poke,dps,cc t=direction cc=slow:1.5 mt=2"}),
    "TahmKench": ("frontline", {
        "W": "u=engage,gapclose,cc t=area dash=1000:direction:w cc=knockup:1.0",
        "R": "u=peel,cc,engage t=enemy cc=suppress:2.5 save=relocate:2.5"}),
    "Lissandra": ("backline", {
        "W": "u=cc,peel t=self cc=root:1.2",
        "E": "u=gapclose,escape t=direction dash=1050:direction",
        "R": "u=engage,cc,peel t=enemy cc=stun:1.5 mt=1"}),
    "Zed": ("assassin", {
        "W": "u=gapclose,escape,burst t=direction dash=650:direction:w",
        "R": "u=burst,gapclose,execute t=enemy dash=625:target:w buff=untargetable:1.0"}),
    # --- lower pick rate: role + the spells that decide fights (AoE ults, saves, engages) -------------
    "Kled": ("diver", {"R": "u=engage,gapclose t=area dash=1500:direction r=1500 dl=1.0 mt=1"}),
    "Draven": ("backline", {"Q": "u=dps,buff t=self buff=ad:5", "R": "u=poke,execute,global t=direction mt=1"}),
    "Gangplank": ("skirmisher", {"E": "cd=6", "R": "u=zone,dps,cc,global t=area cc=slow:1.5 mt=2"}),
    "KogMaw": ("backline", {"W": "u=buff,dps t=self buff=as:8"}),
    "Kindred": ("backline", {"R": "u=peel,zone t=self buff=- save=invuln:4:500 d=0 mt=1"}),
    "Ivern": ("enchanter", {
        "Q": "u=engage,cc,gapclose t=direction cc=root:1.5",
        "W": "cd=10",
        "E": "u=shield,peel,cc t=ally s=2 cc=slow:1.5",
        "R": "u=summon,dps,cc t=area cc=knockup:0.75 d=0.5"}),
    "Malphite": ("frontline", {
        "Q": "u=poke,cc,dps t=enemy cc=slow:2.0",
        "W": "u=dps,buff t=self buff=dr:5",
        "E": "u=dps t=self cc=-",
        "R": "u=engage,cc,gapclose t=area cc=knockup:1.5 dash=1000:direction mt=3 dl=0.2"}),
    "Morgana": ("enchanter", {
        "Q": "u=cc,poke,dps t=direction cc=root:2.5",
        "E": "u=shield,peel t=ally s=2 d=0",
        "R": "u=engage,cc t=self cc=stun:1.5 mt=2 dl=3.0"}),
    "Soraka": ("enchanter", {
        "W": "u=heal t=ally s=2 d=0",
        "E": "u=zone,cc,peel t=area cc=root:1.5",
        "R": "u=heal,global t=ally s=3 d=0"}),
    "Fiora": ("skirmisher", {
        "W": "u=peel,cc,buff t=direction cc=stun:1.5 buff=untargetable:0.75",
        "R": "u=burst,heal t=enemy s=2"}),
    "Khazix": ("assassin", {
        "Q": "u=burst,execute t=enemy",
        "E": "u=gapclose,escape t=area dash=700:direction:w",
        "R": "u=stealth,buff t=self buff=stealth:1.25 d=0"}),
    "Sett": ("diver", {
        "W": "u=dps,shield t=direction s=2",
        "E": "u=cc,engage t=self cc=stun:1.0",
        "R": "u=engage,cc,burst t=enemy cc=suppress:1.0 dash=400:target:w mt=1"}),
    "Hecarim": ("diver", {
        "E": "u=engage,cc,gapclose t=self cc=knockback:0.5 buff=ms:3",
        "R": "u=engage,cc,gapclose t=direction cc=fear:1.0 dash=1000:direction mt=2"}),
    "Irelia": ("diver", {
        "Q": "u=gapclose,dps,heal t=enemy dash=600:target",
        "E": "u=cc,engage t=area cc=stun:1.0",
        "R": "u=engage,cc,dps t=direction cc=slow:1.5 mt=2"}),
    "Mordekaiser": ("skirmisher", {
        "E": "u=cc,engage,dps t=direction cc=pull:0.5",
        "R": "u=engage,burst t=enemy cc=- d=0 mt=1"}),
    "Taric": ("enchanter", {
        "Q": "u=heal t=ally s=1.5 d=0",
        "W": "u=shield,buff t=ally s=1.5 d=0",
        "E": "u=cc,peel,engage t=direction cc=stun:1.25 dl=1.0",
        "R": "u=peel,buff t=self buff=- save=invuln:2.5:400 dl=2.5 d=0"}),
    "Vex": ("backline", {
        "W": "u=peel,shield,cc t=self s=1 cc=fear:1.0 req=mark",
        "E": "u=poke,cc,dps cc=slow:1.5",
        "R": "u=gapclose,burst,engage t=direction dash=1000:target"}),
    "AurelionSol": ("artillery", {
        "E": "u=zone,cc,dps t=area cc=pull:0.5",
        "R": "u=engage,cc,dps t=area cc=knockup:1.0 mt=2"}),
    "Diana": ("diver", {
        "E": "u=gapclose,engage,burst t=enemy dash=825:target",
        "R": "u=engage,cc,burst t=self cc=pull:0.5 mt=2 rad=475"}),
    "Fiddlesticks": ("diver", {
        "Q": "u=cc,peel t=enemy cc=fear:1.5",
        "E": "u=cc,dps t=area cc=silence:1.25",
        "R": "u=engage,dps,burst t=area cc=- dash=800:direction:w mt=3 dl=1.5"}),
    "Janna": ("enchanter", {
        "Q": "u=peel,cc t=direction cc=knockup:0.75 dl=0.8",
        "E": "u=shield,peel t=ally s=2 d=0 ally=ad:4:0",
        "R": "u=peel,heal,cc t=self cc=knockback:0.5 s=3 d=0 mt=1"}),
    "Karthus": ("backline", {
        "Q": "cd=1.5",
        "W": "u=zone,cc,peel t=area cc=slow:2.0 d=0",
        "E": "cd=3",
        "R": "u=global,burst,execute t=self mt=1 dl=3.0"}),
    "Malzahar": ("backline", {"R": "u=cc,burst,engage t=enemy cc=suppress:2.5"}),
    "Nasus": ("skirmisher", {"W": "u=cc,peel t=enemy cc=slow:2.5 d=0", "R": "u=buff,dps t=self buff=dr:8 mt=1"}),
    "Rammus": ("frontline", {
        "Q": "u=engage,gapclose,cc t=direction dash=800:direction cc=knockback:0.5 buff=ms:4",
        "E": "u=cc,peel t=enemy cc=taunt:1.5",
        "R": "u=engage,cc,dps t=area cc=knockup:0.75 mt=2"}),
    "Swain": ("frontline", {"E": "u=cc,engage t=direction cc=root:1.5", "R": "u=dps,heal,zone t=self s=2 mt=1"}),
    "Tryndamere": ("skirmisher", {"W": "u=cc t=self cc=slow:2.5 d=0", "R": "u=buff t=self buff=dr:5 d=0"}),
    "Xerath": ("artillery", {
        "Q": "u=poke,dps t=direction r=1450 dl=1.0",
        "E": "u=cc,poke,peel t=direction cc=stun:1.5",
        "R": "u=poke,execute,burst t=area r=5000 mt=1 dl=0.6"}),
    "Yasuo": ("diver", {
        "W": "u=peel,buff t=direction d=0",
        "E": "cd=2",
        "R": "u=engage,cc,burst t=enemy cc=knockup:1.0 dash=1400:target:w mt=1 req=airborne"}),
    "Zac": ("frontline", {
        "E": "u=engage,cc,gapclose t=area cc=knockup:1.0 dash=1000:direction:w dl=1.0",
        "R": "u=engage,cc,peel t=self cc=knockback:1.0 mt=2"}),
    "Zilean": ("enchanter", {
        "Q": "u=cc,poke,dps t=area cc=stun:1.1",
        "E": "u=buff,cc,peel t=enemy cc=slow:2.5 d=0 ally=ms:2.5:0",
        "R": "u=heal,peel t=ally s=3 d=0 buff=- save=revive:5"}),
    "Amumu": ("frontline", {
        "Q": "u=engage,cc,gapclose t=direction cc=stun:1.0 dash=1100:direction",
        "W": "cd=3",
        "R": "u=engage,cc t=self cc=stun:1.5 mt=3 rad=550"}),
    "Brand": ("backline", {"Q": "u=poke,cc,dps cc=stun:1.5 req=mark", "R": "u=dps,burst mt=2"}),
    "Ekko": ("assassin", {"R": "u=escape,heal,burst t=self dash=- s=2 mt=1"}),
    "Nilah": ("diver", {"E": "cd=8", "R": "u=engage,cc,dps t=self cc=pull:0.5 mt=2"}),
    "Sona": ("enchanter", {
        "W": "u=heal,shield t=ally s=1.5 d=0",
        "E": "u=buff,escape t=self buff=ms:3 d=0 ally=ms:3:400",
        "R": "u=engage,cc,peel t=direction cc=stun:1.5 mt=2"}),
    "Talon": ("assassin", {"R": "u=burst,stealth,gapclose t=self buff=stealth:2.5"}),
    "Twitch": ("backline", {"Q": "u=stealth,buff t=self buff=stealth:5 d=0", "R": "u=dps,buff t=self buff=ad:6 mt=1"}),
    "Urgot": ("skirmisher", {"R": "u=execute,burst,cc t=direction cc=suppress:1.5 mt=1"}),
    "Veigar": ("backline", {"E": "u=zone,cc,peel t=area cc=stun:1.5", "R": "u=burst,execute t=enemy"}),
    "Vladimir": ("skirmisher", {"W": "u=escape,buff t=self buff=untargetable:2.0", "R": "u=dps,burst t=area mt=2"}),
    "Darius": ("skirmisher", {"E": "u=cc,engage t=direction cc=pull:0.5", "R": "u=execute,burst,gapclose t=enemy cc=- dash=460:target:w"}),
    "Fizz": ("assassin", {
        "E": "u=escape,gapclose t=area buff=untargetable:0.75 dash=400:direction",
        "R": "u=engage,cc,burst t=direction cc=knockup:1.0 mt=1"}),
    "Garen": ("skirmisher", {"R": "u=execute,burst t=enemy"}),
    "Kayle": ("backline", {"W": "ally=ms:2:0", "R": "u=peel,buff t=ally buff=- d=1 save=invuln:2.5"}),
    "Katarina": ("assassin", {"R": "u=dps,burst t=self mt=2"}),
    "Samira": ("backline", {"R": "u=dps,burst t=self mt=2"}),
    "Warwick": ("diver", {"R": "u=engage,cc,gapclose t=direction cc=suppress:1.5 dash=900:direction"}),
    "Volibear": ("diver", {"R": "u=engage,gapclose,cc t=area dash=700:direction:w cc=slow:1.0"}),
    "Nunu": ("frontline", {"R": "u=zone,cc,dps t=self cc=slow:2.5 mt=2 dl=3.0"}),
    "MasterYi": ("skirmisher", {"Q": "u=gapclose,dps,buff t=enemy buff=untargetable:0.75"}),
    "Graves": ("skirmisher", {"R": "u=burst,dps,escape t=direction mt=1"}),
    "Kayn": ("diver", {
        "E": "u=gapclose,escape,heal t=self cc=- buff=ms:3 dash=-",
        "R": "u=burst,execute,buff t=enemy buff=untargetable:2.5 dash=550:target"}),
    "Briar": ("diver", {
        "Q": "u=engage,cc,gapclose t=enemy cc=stun:1.0 dash=475:target:w",
        "W": "u=gapclose,dps,buff t=area cc=- dash=350:direction buff=as:4",
        "E": "u=peel,cc,dps t=direction cc=knockback:0.5 s=1",
        "R": "u=engage,gapclose,cc t=direction cc=fear:1.25 dash=1500:target:w r=1500 dl=1.5"}),
    "Akshan": ("backline", {"E": "u=gapclose,escape,dps t=direction cc=- dash=800:direction", "R": "u=execute,burst t=enemy dl=2.0"}),
    "Belveth": ("skirmisher", {"E": "u=dps,buff t=self cc=- buff=dr:1.5", "R": "u=buff,dps t=self cc=- dash=- d=1 cd=60"}),
    "Illaoi": ("skirmisher", {
        "W": "u=dps,gapclose t=enemy cc=- dash=-",
        "E": "u=cc,poke t=direction cc=pull:0.5 d=0.5",
        "R": "u=dps,zone,summon t=self cc=- dash=- mt=2"}),
    "Quinn": ("backline", {
        "E": "u=gapclose,peel,cc t=enemy cc=knockback:0.5 dash=675:target",
        "R": "u=buff,global t=self cc=- mt=1 d=0 buff=ms:5"}),
    "Riven": ("skirmisher", {
        "Q": "u=gapclose,dps,cc t=direction cc=knockup:0.75 dash=250:direction",
        "R": "u=execute,burst,buff t=direction buff=ad:15 mt=1"}),
    "Rengar": ("assassin", {"Q": "u=burst,dps t=self", "R": "u=stealth,gapclose,buff t=self dash=- buff=stealth:4 rad=0 d=0"}),
    "Shaco": ("assassin", {
        "E": "u=burst,execute,cc t=enemy cc=slow:2.0 s=0",
        "R": "u=summon,escape,dps t=self dash=- cc=- buff=untargetable:0.25"}),
    "Singed": ("frontline", {"Q": "cd=3", "E": "u=cc,peel,engage t=enemy cc=knockback:0.75", "R": "u=buff t=self buff=ms:10 d=0"}),
    "Teemo": ("backline", {"R": "u=zone,cc,dps t=area cc=slow:2.0 cd=30"}),
    "Velkoz": ("artillery", {"W": "cd=4", "R": "u=poke,dps t=direction r=1575 dl=0.3 mt=1"}),
    "Zoe": ("artillery", {
        "W": "cd=6",
        "E": "u=cc,poke t=direction cc=sleep:2.0 dl=1.0",
        "R": "u=gapclose,escape t=area dash=575:direction:w d=0"}),
    "Evelynn": ("assassin", {"R": "u=execute,burst,escape t=direction dash=700:direction buff=untargetable:0.5 mt=1"}),
    "Kassadin": ("assassin", {"R": "u=gapclose,escape,burst t=area dash=500:direction:w cd=5"}),
    "Shyvana": ("skirmisher", {"R": "u=engage,cc,gapclose,buff t=area cc=fear:1.0 dash=1000:direction:w s=0 mt=1"}),
    "Heimerdinger": ("backline", {
        "Q": "u=summon,zone,dps t=area d=2 cd=8",
        "E": "u=cc,poke,dps t=area cc=stun:1.5",
        "R": "u=buff,dps t=self cc=- d=1"}),
}
# champions whose whole kit (all four spells) was hand-checked; the rest only had role + key spells corrected
FULL_CHECK_MIN_SPELLS = 4


# ----------------------------------------------------------------------------------------------------------
# loading / caching
# ----------------------------------------------------------------------------------------------------------
def fetch_json(url: str, dest: Path) -> object | None:
    if dest.exists():
        return json.loads(dest.read_text(encoding="utf-8"))
    try:
        time.sleep(0.25)
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:  # network down / site unreachable -> heuristics only
        print(f"  ! could not fetch {url}: {exc}")
        return None


def load_ddragon(version: str, ids: list[str]) -> tuple[dict, str]:
    local = DATA / "ddragon" / version / "championFull_en_US.json"
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8"))["data"], f"local {local.name}"
    out, got = {}, 0
    for cid in ids:
        js = fetch_json(DD_URL.format(ver=version, cid=cid), CACHE / "ddragon" / version / f"{cid}.json")
        if js:
            out[cid] = js["data"][cid]
            got += 1
    return out, f"ddragon.leagueoflegends.com ({got}/{len(ids)} champions)"


def strip(text: str) -> str:
    text = re.sub(r"<br\s*/?>", " ", text or "")
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"%i:[A-Za-z]+%", "", text)
    return re.sub(r"\s+", " ", text).strip()


def num(value) -> float | None:
    if value is None:
        return None
    m = re.search(r"\d+(?:\.\d+)?", str(value))
    return float(m.group()) if m else None


# ----------------------------------------------------------------------------------------------------------
# pro damage split
# ----------------------------------------------------------------------------------------------------------
GENERIC_SPELLS = {"burning", "elderdragonbuff", "heraldleapattack"}


def pro_damage(ids: set[str]) -> tuple[dict[str, list[float]], collections.Counter, int, dict]:
    """[AA, Q, W, E, R] damage totals per champion from victimDamageReceived of CHAMPION_KILL events.

    Slots: 0..3 = Q..R, 4/5 = summoners, 6..15 = items, 63 = passive, 46..80 = basic/crit attack variants,
    -1 / 3144 = other. AA bucket = basic attacks + passive procs. The `name` field and participantId each
    disagree with the spell owner in ~1% of rows, so a (slot, spellName) owner is learned from rows where they
    agree and used to attribute the rest. Slot-0 rows with an empty spellName are rune/item procs (excluded);
    empty names on slots 1..3 are real spell damage (Azir soldiers, Kalista W, Vi W ...).
    """
    files = sorted(glob.glob(RAW_GLOB))
    games: collections.Counter = collections.Counter()
    rows: list[tuple[frozenset, str, str | None, int, str, int]] = []
    for path in files:
        d = json.load(gzip.open(path, "rt", encoding="utf-8"))
        pc = {p["participantId"]: p["championName"] for p in d["data"]["participants"]}
        in_game = frozenset(pc.values())
        for ch in in_game:
            games[ch] += 1
        for frame in d["timeline"]["frames"]:
            for ev in frame["events"]:
                if ev.get("type") != "CHAMPION_KILL":
                    continue
                for r in ev.get("victimDamageReceived", []):
                    if r.get("type") != "OTHER":
                        continue
                    total = r["physicalDamage"] + r["magicDamage"] + r["trueDamage"]
                    if total <= 0:
                        continue
                    rows.append((in_game, r.get("name") or "", pc.get(r["participantId"]), r["spellSlot"],
                                 r.get("spellName") or "", total))
    owner_votes: dict[tuple[int, str], collections.Counter] = collections.defaultdict(collections.Counter)
    for in_game, name, pch, slot, spell, _ in rows:
        if spell and name == pch:
            owner_votes[(slot, spell)][name] += 1
    owner = {}
    for key, votes in owner_votes.items():
        top, n = votes.most_common(1)[0]
        if n >= 3 and n >= 0.8 * sum(votes.values()) and key[1] not in GENERIC_SPELLS \
                and not key[1].startswith(("srx_", "sru_", "s5_")):
            owner[key] = top
    dmg: dict[str, list[float]] = collections.defaultdict(lambda: [0.0] * 5)
    stats = collections.Counter()
    for in_game, name, pch, slot, spell, total in rows:
        if 0 <= slot <= 3:
            bucket = slot + 1
        elif slot == 63 or 46 <= slot <= 80:
            bucket = 0
        else:
            stats["skipped_other_slot"] += 1
            continue
        if spell:
            ch = owner.get((slot, spell))
            if ch is None or ch not in in_game:
                stats["skipped_unowned"] += 1
                continue
        else:
            if slot == 0 or name != pch:
                stats["skipped_empty"] += 1
                continue
            ch = name
        if ch not in ids:
            continue
        dmg[ch][bucket] += total
        stats["used"] += 1
    return dict(dmg), games, len(files), dict(stats)


# ----------------------------------------------------------------------------------------------------------
# text heuristics
# ----------------------------------------------------------------------------------------------------------
CC_PATTERNS = [
    ("suppress", r"\bsuppress(?:es|ed|ing|ion)?\b"),
    ("knockup", r"\bknock(?:s|ing|ed)?\s+(?:\w+\s+){0,3}?(?:up|airborne)\b|\bairborne\b|\bknock(?:s|ing|ed)?[- ]?up\b|\bknockup\b"),
    ("knockback", r"\bknock(?:s|ing|ed)?\s+(?:\w+\s+){0,3}?(?:back|away|aside)\b|\bknockback\b|\bdisplac\w+\b"),
    ("pull", r"\bpull(?:s|ing|ed)?\b(?![^.]{0,30}\b(?:herself|himself|itself)\b)|\bdrag(?:s|ging|ged)?\b"),
    ("stun", r"\bstun(?:s|ned|ning)?\b"),
    ("charm", r"\bcharm(?:s|ed|ing)?\b"),
    ("taunt", r"\btaunt(?:s|ed|ing)?\b"),
    ("fear", r"\bfear(?:s|ed|ing)?\b|\bflee(?:s|ing)?\b|\bterrif\w+\b"),
    ("sleep", r"\bdrows\w+\b|\basleep\b|\bsleep\b"),
    ("polymorph", r"\bpolymorph\w*\b"),
    ("root", r"\broot(?:s|ed|ing)?\b|\bsnare\w*\b"),
    ("silence", r"\bsilenc\w+\b"),
    ("ground", r"\bground(?:s|ed|ing)?\b(?!\s*(?:area|zone|for\b))"),
    ("blind", r"\bblind\w*\b|\bnearsight\w*\b"),
    ("slow", r"\bslow(?:s|ed|ing)?\b|\bcrippl\w+\b"),
]
CC_NEGATIVE = re.compile(r"immun|cleans|remov|unstoppable|ignor|tenacity|reduc\w+ the duration|"
                         r"against (?:\w+ ){0,2}(?:stunned|rooted|immobilized|slowed|airborne)|"
                         r"(?:is|are|while) (?:stunned|rooted|slowed|airborne|immobilized)|instead of being|"
                         r"cannot be|can't be|break free|resist|knocked down by|crowd control during|"
                         r"\b(?:becom\w*|gets?|being|by any)\s+(?:\w+,?\s+){0,4}(?:immobiliz\w*|grounded|polymorph\w*|silenced|stunned|rooted)|"
                         r"(?:roots?|taunt\w*|stuns?)\s+(?:herself|himself|itself)|self-(?:taunt|root|stun)", re.I)
DASH_PATTERN = re.compile(
    r"\b(dash(?:es|ing)?|leap(?:s|ing)?|lunge(?:s|ing)?|blink(?:s|ing)?|teleport(?:s|ing)?|jump(?:s|ing)?|"
    r"charg(?:es|ing) (?:forward|towards?|to|at|in)|vault(?:s|ing)?|hop(?:s|ping)?|rush(?:es|ing)? (?:forward|towards?|to)|"
    r"surg(?:es|ing) (?:forward|towards?|to)|propel(?:s|ling)? (?:himself|herself|itself)|"
    r"launch(?:es|ing)? (?:himself|herself|itself)|flies|fly(?:ing)? (?:to|towards?)|flip(?:s|ping)?|roll(?:s|ing)? (?:to|in)|"
    r"pulls? (?:himself|herself|itself))\b", re.I)
DASH_NEGATIVE = re.compile(r"enem(?:y|ies)[^.]{0,30}dash|dashing enem|prevent|interrupt|stops? |attempting to|"
                           r"movement abilit|if (?:the target|they|an enemy) (?:dash|blink)|ally dash|"
                           r"cannot (?:dash|blink|jump)", re.I)
OVERWALL = re.compile(r"blink|teleport|leap|jump|vault|flies|fly|hop|over (?:walls|terrain)|through terrain", re.I)
# a dash verb whose subject is an object the champion commands (Orianna's ball, Azir's soldiers, Ashe's hawk...)
DASH_OBJECT = re.compile(r"\b(?:command\w*|sends?|throws?|hurls?|fires?|launch(?:es)?|summons?|ball|soldiers?|hawk|"
                         r"tibbers|daisy|clone|shadow|spirit|sentinel|voidling|wolf|minions?|daggers?|blade|glaive|"
                         r"missile|projectile|bolt|orb|seed|mine|bomb|spear|axe|boomerang|disc|tentacle|plant|"
                         r"statue|pix|beam|wave|chain|hook|grenade|trap|packmates?|feathers?|rocks?|boulder)\b", re.I)
STEALTH = re.compile(r"\b(?:becom\w*|turns?|is|gains?|enters?)\s+(?:\w+\s+){0,2}(?:invisib\w*|camouflag\w*)|\bstealth\b", re.I)
UNTARGETABLE = re.compile(r"\b(?:becom\w*|turns?|goes|is|while)\s+(?:\w+\s+){0,2}untargetable\b|\b(?:enters?|in|into) stasis\b", re.I)
EXECUTE = re.compile(r"execut\w*|below \d+% (?:of their )?(?:maximum )?health|low[- ]health enemies", re.I)
SECONDS = re.compile(r"(?:for|over|lasting)\s+(?:up to\s+)?(\d+(?:\.\d+)?)(?:\s*/\s*\d+(?:\.\d+)?)*\s*seconds?", re.I)
UNITS = re.compile(r"(\d{3,4})\s*units", re.I)


def sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+|\s+(?=(?:Active|Passive|Recast|Second Cast|Empowered|Third Cast)\s*:)", text) if s]


def parse_cc(texts: list[str], attrs: dict[str, list[float]], is_ult: bool) -> dict | None:
    found: dict[str, float | None] = {}
    for text in texts:
        for sent in sentences(text):
            for cc_type, pat in CC_PATTERNS:
                for m in re.finditer(pat, sent, re.I):
                    window = sent[max(0, m.start() - 60): m.end() + 40]
                    if CC_NEGATIVE.search(window):
                        continue
                    if cc_type == "slow" and re.search(r"slow(?:s|ed)? (?:down|the decay)|slower", window, re.I):
                        continue
                    if cc_type == "ground" and not re.search(r"\bground(?:s|ed|ing) (?:them|enemies|the target|targets)\b|\bgrounded\b", sent, re.I):
                        continue
                    dur = None
                    after = re.split(r"[;:]|, (?:and|then|but|while)\b| and (?:deals|gains|grants|heals)", sent[m.start(): m.start() + 100])[0]
                    dm = SECONDS.search(after)
                    if dm:
                        dur = float(dm.group(1))
                    if cc_type not in found or (found[cc_type] is None and dur is not None):
                        found[cc_type] = dur
    if not found:
        return None
    # attribute-based durations (Meraki leveling tables)
    for attr, vals in attrs.items():
        a = attr.lower()
        if "duration" not in a or not vals:
            continue
        v = vals[min(len(vals) - 1, 1 if is_ult else 2)]
        for cc_type, key in (("root", "root"), ("stun", "stun"), ("fear", "fear"), ("silence", "silence"),
                             ("knockup", "knock"), ("knockup", "airborne"), ("taunt", "taunt"),
                             ("blind", "blind"), ("slow", "slow")):
            if key in a and cc_type in found and 0 < v <= 4:
                found[cc_type] = v
        if a in ("disable duration", "stun duration") and 0 < v <= 4:
            for cc_type in ("stun", "charm", "sleep", "suppress", "polymorph"):
                if cc_type in found and found[cc_type] is None:
                    found[cc_type] = v
    best = min(found, key=CC_PRIORITY.index)
    dur = found[best]
    if dur is None or dur > 4:
        dur = CC_DEFAULT_DUR[best] + (0.25 if is_ult and best not in ("slow", "knockback", "pull") else 0)
    if best in ("knockup", "knockback", "pull"):
        dur = min(dur, 1.75)
    return {"type": best, "dur": round(dur, 2)}


def dash_subject_ok(sent: str, start: int, names: list[str]) -> bool:
    """True when the dash verb at `start` is done by the champion, not by an object it commands."""
    pre = re.sub(r"^(?:\w+(?: \w+)?\s*:\s*)", "", sent[:start])
    if not pre.strip():
        return True
    subj = None
    for pat in names + [r"\bhe\b", r"\bshe\b", r"\bthey\b", r"\bhimself\b", r"\bherself\b"]:
        for m in re.finditer(pat, pre, re.I):
            if subj is None or m.end() > subj:
                subj = m.end()
    if subj is None:
        return False
    return not DASH_OBJECT.search(pre[subj:])


def parse_dash(texts: list[str], spell_range: float, targeting: str, affects: str, names: list[str]) -> dict | None:
    for text in texts:
        for sent in sentences(text):
            m = DASH_PATTERN.search(sent)
            if not m:
                continue
            if DASH_NEGATIVE.search(sent):
                continue
            if not dash_subject_ok(sent, m.start(), names):
                continue
            um = UNITS.search(sent)
            length = float(um.group(1)) if um else (spell_range if 150 <= spell_range <= 1500 else 450)
            length = max(150.0, min(length, 1200.0))
            to = "direction"
            if "unit" in targeting.lower():
                to = "target"
            if re.search(r"\ball(?:y|ied)\b", sent, re.I) and not re.search(r"\benem", sent, re.I):
                to = "ally"
            return {"len": round(length), "to": to, "overWalls": bool(OVERWALL.search(m.group(1)) or OVERWALL.search(sent))}
    return None


def meraki_attrs(effects: list[dict]) -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    for e in effects:
        for lv in e.get("leveling", []):
            mods = lv.get("modifiers") or []
            if not mods:
                continue
            vals = mods[0].get("values") or []
            units = (mods[0].get("units") or [""])
            if units and units[0] not in ("", None):
                # first modifier is a ratio, not a flat value; keep it under a separate key
                out.setdefault(lv["attribute"] + " %", [float(v) for v in vals if isinstance(v, (int, float))])
                continue
            out.setdefault(lv["attribute"], [float(v) for v in vals if isinstance(v, (int, float))])
    return out


def damage_estimate(effects: list[dict], is_ult: bool) -> float:
    """Rough magnitude of a spell's damage at mid game (rank 3 / ult rank 2, 150 AP or 100 bonus AD)."""
    best = 0.0
    for e in effects:
        per_effect = 0.0
        levels = e.get("leveling", [])
        names = [lv["attribute"] for lv in levels]
        has_total = any("total" in n.lower() and "damage" in n.lower() for n in names)
        for lv in levels:
            n = lv["attribute"].lower()
            if "damage" not in n or any(x in n for x in ("reduction", "reduced", "minion", "monster", "structure",
                                                           "turret", "non-champion", "minimum", "increased",
                                                           "per stack", "capped", "amplification", "penetration")):
                continue
            if has_total and "total" not in n:
                continue
            value = 0.0
            for mod in lv.get("modifiers", []):
                vals = [v for v in mod.get("values", []) if isinstance(v, (int, float))]
                if not vals:
                    continue
                v = vals[min(len(vals) - 1, 1 if is_ult else 2)]
                unit = (mod.get("units") or [""])[0] or ""
                u = unit.lower()
                if not u:
                    value += v
                elif "% ap" in u:
                    value += v * 1.5
                elif "bonus ad" in u:
                    value += v * 1.0
                elif "% ad" in u:
                    value += v * 1.8
                elif "health" in u:
                    value += v * 25
                elif "%" in u:
                    value += v * 0.5
            if "per tick" in n or "per second" in n or "per hit" in n or "per bullet" in n:
                value *= 3
            per_effect = max(per_effect, value)
        best += per_effect
    return best


# ----------------------------------------------------------------------------------------------------------
# role heuristic
# ----------------------------------------------------------------------------------------------------------
def guess_role(c: dict) -> str:
    tags, st = c["tags"], c["style"]
    first = tags[0]
    shapes = [s["vfx"] for s in c["spells"]] + [s.get("also") for s in c["spells"] if s.get("also")]
    mobile = shapes.count("dash") + shapes.count("blink")
    if first == "Tank":
        return "frontline"
    if first == "Support":
        if "Tank" in tags:
            return "frontline"
        if st["peel"] >= 6 or shapes.count("shield") + shapes.count("heal") >= 1:
            return "enchanter"
        return "backline"
    if first == "Assassin":
        return "assassin"
    if first == "Marksman":
        return "backline"
    if first == "Mage":
        if "Assassin" in tags and mobile:
            return "assassin"
        if "Tank" in tags:
            return "frontline"
        if st["poke"] >= 8 and c["attackRange"] >= 525:
            return "artillery"
        return "backline"
    if first == "Fighter":
        if "Tank" in tags and st["engage"] >= 7:
            return "diver"
        if "Assassin" in tags and mobile:
            return "diver" if st["engage"] >= 6 else "skirmisher"
        if mobile and st["engage"] >= 7:
            return "diver"
        return "skirmisher"
    return "skirmisher"


# ----------------------------------------------------------------------------------------------------------
# per-spell kit
# ----------------------------------------------------------------------------------------------------------
def build_spell(c: dict, i: int, sp: dict, dd_spell: dict | None, mer_forms: list[dict] | None, role: str) -> dict:
    key = sp["key"]
    is_ult = key == "R"
    shape = sp["vfx"]
    also = sp.get("also")
    texts: list[str] = []
    attrs: dict[str, list[float]] = {}
    targeting, affects, cast, speed, projectile = "", "", 0.0, None, ""
    mer_range = mer_radius = mer_width = None
    dmg_est = 0.0
    mer_cd = None
    if mer_forms:
        f0 = mer_forms[0]
        targeting = str(f0.get("targeting") or "")
        affects = str(f0.get("affects") or "")
        cast = num(f0.get("castTime")) or 0.0
        speed = num(f0.get("speed"))
        projectile = str(f0.get("projectile") or "")
        mer_range = None if str(f0.get("targetRange")).lower() == "global" else num(f0.get("targetRange"))
        mer_radius = num(f0.get("effectRadius"))
        mer_width = num(f0.get("width"))
        cdv = ((f0.get("cooldown") or {}).get("modifiers") or [{}])[0].get("values") or []
        mer_cd = cdv[0] if cdv else None
        for form in mer_forms:
            for e in form.get("effects", []):
                texts.append(strip(e.get("description", "")))
            for k, v in meraki_attrs(form.get("effects", [])).items():
                attrs.setdefault(k, v)
        dmg_est = damage_estimate(f0.get("effects", []), is_ult)
    if dd_spell:
        texts.append(strip(dd_spell.get("tooltip", "")))
        texts.append(strip(dd_spell.get("description", "")))
    alltext = " ".join(texts)
    lower_attrs = {k.lower(): v for k, v in attrs.items()}

    rng = float(sp.get("range") or 0)
    is_global = shape == "global" or also == "global"
    if not is_global and (rng in (0, 1, 20, 25000) or rng > 4000):
        rng = mer_range or float(sp.get("radius") or 0) or (450 if shape in ("dash", "blink") else 300)
    radius = float(sp.get("radius") or 0)
    if not radius and mer_radius and shape not in ("target", "line", "dash", "blink"):
        radius = mer_radius
    width = sp.get("width")

    cc = parse_cc(texts, attrs, is_ult)
    if cc is None and sp.get("cc"):
        cc = {"type": "knockup" if "knockup" in (shape, also) else "stun", "dur": 1.25 if is_ult else 0.75}
    names = [re.escape(c["nameEn"]), re.escape(c["nameEn"].split()[0]), re.escape(c["id"])]
    dash = parse_dash(texts, rng, targeting, affects, names)
    if dash is None and (shape in ("dash", "blink") or also in ("dash", "blink")):
        dash = {"len": round(max(250, min(rng or 450, 800))), "to": "target" if "unit" in targeting.lower() else "direction",
                "overWalls": "blink" in (shape, also)}

    has_damage = dmg_est > 0 or bool(re.search(r"\b(?:physical|magic|true|mixed) damage\b", alltext, re.I))
    shield_amt = max((v[min(len(v) - 1, 2)] for k, v in lower_attrs.items() if "shield" in k and v), default=0)
    heal_amt = max((v[min(len(v) - 1, 2)] for k, v in lower_attrs.items()
                    if ("heal" in k or "restor" in k) and "mana" not in k and v), default=0)
    support_kind = None
    if shape in ("shield", "heal") or also in ("shield", "heal") or shield_amt or heal_amt:
        support_kind = "heal" if (shape == "heal" or also == "heal" or (heal_amt and not shield_amt)) else "shield"
    ally_target = bool(re.search(r"\ball(?:y|ies|ied champion)\b", affects + " " + alltext[:400], re.I)) and \
        bool(re.search(r"allies", affects, re.I) or re.search(r"(?:target|an|nearby|allied) (?:ally|allies|champion)", alltext, re.I))

    # target
    tl = targeting.lower()
    if support_kind and ally_target and (not has_damage or shape in ("shield", "heal")):
        target = "ally"
    elif shape in ("shield", "heal") and not has_damage:
        target = "ally" if ally_target else "self"
    elif tl.startswith("unit"):
        target = "ally" if (affects.lower().startswith("allies") or (support_kind and ally_target and not has_damage)) else "enemy"
    elif tl.startswith(("direction", "vector")):
        target = "direction"
    elif tl.startswith("location"):
        target = "area"
    elif tl.startswith(("auto", "proximity", "passive")):
        target = "self"
    else:
        target = {"line": "direction", "cone": "direction", "dash": "direction", "blink": "direction",
                  "target": "enemy", "self": "self", "stealth": "self", "shield": "ally", "heal": "ally"}.get(shape, "area")

    skillshot = tl.startswith(("direction", "location", "vector")) and shape not in ("self", "shield", "heal", "stealth", "target")
    if not targeting:
        skillshot = shape in ("line", "cone", "circle", "global", "wall", "knockup") and target in ("direction", "area")
    if dash and not cc and not has_damage:
        skillshot = False

    delay = cast if cast <= 1.5 else 0.25
    if skillshot and speed and projectile.upper() == "TRUE":
        delay += min(1.2, (min(rng, 1600) * 0.7) / speed)
    elif skillshot and shape in ("circle", "knockup", "zone") and not dash:
        delay += 0.5
    elif dash:
        delay += 0.2
    delay = round(min(delay, 1.8), 2)

    cd = float(sp.get("cd") or 0)
    if cd <= 0.5 and mer_cd:
        cd = float(mer_cd)
    if cd <= 0:
        cd = 4.0 if not is_ult else 60.0

    # self buffs
    buff = None
    dur_m = SECONDS.search(alltext)
    bdur = float(dur_m.group(1)) if dur_m else 3.0
    bdur = min(bdur, 8.0)
    um = UNTARGETABLE.search(alltext)
    if um and target in ("self", "direction", "area") and dash_subject_ok(alltext, um.start(), names + [r"\bit\b"]):
        buff = {"kind": "untargetable", "dur": min(bdur, 2.5)}
    elif shape == "stealth" or also == "stealth" or (STEALTH.search(alltext) and target == "self"):
        buff = {"kind": "stealth", "dur": min(bdur, 4.0)}
    elif target == "self" and any("attack speed" in k for k in lower_attrs):
        buff = {"kind": "as", "dur": bdur}
    elif target == "self" and any("damage reduction" in k for k in lower_attrs):
        buff = {"kind": "dr", "dur": min(bdur, 4.0)}
    elif target == "self" and any("bonus attack damage" in k for k in lower_attrs):
        buff = {"kind": "ad", "dur": bdur}
    elif target == "self" and any("movement speed" in k for k in lower_attrs) and not has_damage:
        buff = {"kind": "ms", "dur": bdur}

    aoe = radius >= 150 or shape in ("cone", "circle", "zone", "knockup", "wall") or (shape == "line" and is_ult and (width or 0) >= 120)

    # uses
    uses: list[str] = []
    hard = cc is not None and cc["type"] != "slow"
    if support_kind and (target == "ally" or not has_damage):
        uses.append(support_kind)
    if dash:
        if hard and target != "ally":
            uses += ["engage", "cc", "gapclose"]
        elif dash["to"] == "target" and target == "enemy" and role in ("frontline", "diver"):
            uses += ["engage", "gapclose"]
        elif dash["to"] == "ally":
            uses += ["escape", "peel"] if role == "enchanter" else ["escape"]
        elif role in ("backline", "artillery", "enchanter"):
            uses += ["escape", "gapclose"]
        else:
            uses += ["gapclose", "escape"]
    elif hard:
        if is_ult and aoe and role in ("frontline", "diver", "skirmisher"):
            uses += ["engage", "cc"]
        elif role in ("frontline", "diver") and (rng >= 700 or is_ult):
            uses += ["engage", "cc"]
        elif role == "enchanter":
            uses += ["peel", "cc"]
        else:
            uses += ["cc", "peel"] if rng <= 500 else ["cc"]
    if has_damage:
        if rng >= 900 and skillshot and not dash:
            uses.append("poke")
        if EXECUTE.search(alltext) or (is_ult and re.search(r"missing health", alltext, re.I)):
            uses.append("execute")
        if is_ult and not aoe:
            uses.append("burst")
        elif aoe:
            uses.append("dps")
            if not is_ult:
                uses.append("waveclear")
        else:
            uses.append("burst" if role == "assassin" else "dps")
    if cc and cc["type"] == "slow":
        uses.append("cc")
    if support_kind and support_kind not in uses:
        uses.append(support_kind)
    if shape == "zone" or also == "zone":
        uses.append("zone")
    if shape == "summon" or also == "summon":
        uses.append("summon")
    if buff and buff["kind"] == "stealth":
        uses.append("stealth")
    if is_global:
        uses.append("global")
    if buff and buff["kind"] != "stealth":
        uses.append("buff")
    seen: list[str] = []
    for u in uses:
        if u not in seen:
            seen.append(u)
    uses = seen or (["buff"] if target == "self" else ["dps"])

    support = 0.0
    if support_kind:
        support = float(sp.get("power") or 1) if shape in ("shield", "heal") or also in ("shield", "heal") else 1.0

    min_targets = None
    if is_ult and aoe and not dash and target != "ally" and not buff and \
            ((hard and radius >= 200) or (has_damage and radius >= 300 and target in ("area", "direction"))):
        min_targets = 2

    kit = {
        "key": key, "slot": i, "uses": uses, "target": target, "shape": shape,
        "range": round(rng), "radius": round(radius),
    }
    if width:
        kit["width"] = round(float(width))
    if cc:
        kit["cc"] = cc
    if dash:
        kit["dash"] = dash
    kit["_prior"] = float(sp.get("power") or 1) if has_damage else 0.0
    kit["_est"] = dmg_est
    kit["dmg"] = 0.0
    if support:
        kit["support"] = support
    kit["delay"] = delay
    kit["skillshot"] = bool(skillshot)
    kit["cd"] = round(cd, 2)
    if min_targets:
        kit["minTargets"] = min_targets
    if buff:
        kit["selfBuff"] = {"kind": buff["kind"], "dur": round(buff["dur"], 2)}
    return kit


def apply_override(kit: dict, spec: str, cid: str) -> None:
    for tok in spec.split():
        k, _, v = tok.partition("=")
        if k == "u":
            uses = [u for u in v.split(",") if u]
            bad = [u for u in uses if u not in USES]
            assert not bad, (cid, kit["key"], bad)
            kit["uses"] = uses
        elif k == "t":
            assert v in TARGETS, (cid, v)
            kit["target"] = v
        elif k == "cc":
            if v == "-":
                kit.pop("cc", None)
            else:
                t, _, d = v.partition(":")
                assert t in CC_TYPES, (cid, t)
                kit["cc"] = {"type": t, "dur": float(d) if d else CC_DEFAULT_DUR[t]}
        elif k == "dash":
            if v == "-":
                kit.pop("dash", None)
            else:
                parts = v.split(":")
                to = parts[1] if len(parts) > 1 else "direction"
                assert to in ("target", "direction", "ally"), (cid, to)
                kit["dash"] = {"len": float(parts[0]), "to": to, "overWalls": len(parts) > 2 and parts[2] == "w"}
        elif k == "d":
            kit["_prior"] = float(v)
            kit["_forced"] = True
        elif k == "dcap":
            kit["_dcap"] = float(v)
        elif k == "s":
            if float(v) <= 0:
                kit.pop("support", None)
            else:
                kit["support"] = float(v)
        elif k == "dl":
            kit["delay"] = float(v)
        elif k == "ss":
            kit["skillshot"] = v == "1"
        elif k == "r":
            kit["range"] = float(v)
        elif k == "rad":
            kit["radius"] = float(v)
        elif k == "wd":
            kit["width"] = float(v)
        elif k == "cd":
            kit["cd"] = float(v)
        elif k == "mt":
            if int(v) <= 1:
                kit.pop("minTargets", None)
            else:
                kit["minTargets"] = int(v)
        elif k == "buff":
            if v == "-":
                kit.pop("selfBuff", None)
            else:
                b, _, d = v.partition(":")
                assert b in BUFFS, (cid, b)
                kit["selfBuff"] = {"kind": b, "dur": float(d) if d else 3.0}
        elif k == "save":
            parts = v.split(":")
            assert parts[0] in SAVES and len(parts) in (2, 3), (cid, tok)
            kit["save"] = {"kind": parts[0], "dur": float(parts[1])}
            if len(parts) == 3:
                kit["save"]["radius"] = round(float(parts[2]))
        elif k == "ally":
            parts = v.split(":")
            assert parts[0] in ALLY_BUFFS and len(parts) == 3, (cid, tok)
            kit["allyBuff"] = {"kind": parts[0], "dur": float(parts[1]), "radius": round(float(parts[2]))}
        elif k == "req":
            assert v in REQUIRES, (cid, tok)
            kit["requires"] = v
        else:
            raise AssertionError(f"{cid} {kit['key']}: unknown override token {tok}")


FIGHT_WINDOW = 12.0    # seconds: a spell is cast max(1, FIGHT_WINDOW / cd) times in a teamfight


def casts(cd: float) -> float:
    return max(1.0, FIGHT_WINDOW / max(cd, 1.5))


def distribute_damage(c: dict, spells: list[dict], share: list[float] | None) -> None:
    """Per-cast dmg weights.

    Calibration: the damage a champion deals over one fight window, sum(dmg * casts(cd)), equals what the
    champions.json power values would deal with the same cooldowns (the stub's damage scale), so moving weight
    between a 1.5 s spell and a 120 s ultimate does not change how hard the champion hits overall.
    Split: fight-window damage per spell = (1 - PRO_BLEND) * kit prior + PRO_BLEND * pro dmgShare (Q..R part).
    """
    n = [casts(s["cd"]) for s in spells]
    prior = [max(0.0, s["_prior"]) * k for s, k in zip(spells, n)]
    if sum(prior) <= 0:
        prior = [k if ("dps" in s["uses"] or "burst" in s["uses"]) else 0.0 for s, k in zip(spells, n)]
    psum = sum(prior) or 1.0
    weights = [p / psum for p in prior]
    if share:
        spell_share = share[1:5]
        ssum = sum(spell_share)
        if ssum > 0:
            pro = [x / ssum for x in spell_share]
            weights = [(1 - PRO_BLEND) * w + PRO_BLEND * p for w, p in zip(weights, pro)]
    for idx, s in enumerate(spells):
        if s.get("_forced") and s["_prior"] <= 0:
            weights[idx] = 0.0
        elif not share and prior[idx] <= 0:
            weights[idx] = 0.0
    # the stub dealt power-weighted damage with every non-shield/heal spell; count only the ones that really deal
    # damage (form swaps / traps with 1-3 s cooldowns would otherwise inflate the total)
    stub = [float(sp.get("power") or 1) if sp["vfx"] not in ("shield", "heal") else 0.0 for sp in c["spells"]]
    fight_total = sum(p * k for p, k, w in zip(stub, n, weights) if w > 0)
    # half of the stub's phantom damage on non-damaging spells (Bard R, Taliyah R ...) is kept, counted as one cast
    fight_total += 0.5 * sum(p for p, w in zip(stub, weights) if w <= 0)
    if fight_total <= 0:
        fight_total = sum(float(sp.get("power") or 1) * k for sp, k, w in zip(c["spells"], n, weights) if w > 0) or 3.0
    wsum = sum(weights) or 1.0
    dmgs = [fight_total * (w / wsum) / k for w, k in zip(weights, n)]
    # keep the per-champion sum roughly comparable to the champions.json power sum
    psum_all = max(sum(stub), 1.0)
    tot = sum(dmgs)
    if tot > 0:
        scale = min(max(tot, 0.5 * psum_all), 1.5 * psum_all) / tot
        dmgs = [d * scale for d in dmgs]
    # dcap: damage that really lands over a long aura / channel is capped per cast; the excess fight-window
    # damage moves to the champion's other damaging spells
    capped = [i for i, s in enumerate(spells) if "_dcap" in s and dmgs[i] > s["_dcap"]]
    if capped:
        excess = sum((dmgs[i] - spells[i]["_dcap"]) * n[i] for i in capped)
        for i in capped:
            dmgs[i] = spells[i]["_dcap"]
        others = [i for i in range(len(spells)) if i not in capped and dmgs[i] > 0 and "_dcap" not in spells[i]]
        base = sum(dmgs[i] * n[i] for i in others)
        for i in others:
            dmgs[i] += excess * (dmgs[i] * n[i] / base) / n[i]
    for s, dmg in zip(spells, dmgs):
        s["dmg"] = round(dmg, 1) if dmg >= 0.05 else 0.0


# ----------------------------------------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------------------------------------
def main() -> int:
    args = sys.argv[1:]
    dump = []
    if "--dump" in args:
        dump = args[args.index("--dump") + 1].split(",")
    CACHE.mkdir(parents=True, exist_ok=True)
    cj = json.loads(CHAMPS_JSON.read_text(encoding="utf-8"))
    version = cj["version"]
    champs = sorted(cj["champions"], key=lambda c: c["id"])
    ids = [c["id"] for c in champs]
    print(f"champions.json {version}: {len(champs)} champions")

    dd, dd_src = load_ddragon(version, ids)
    print(f"Data Dragon: {dd_src}")
    meraki = fetch_json(MERAKI_URL, CACHE / "meraki_champions.json") or {}
    print(f"Meraki: {len(meraki)} champions" + ("" if meraki else " (unreachable -> heuristics + overrides only)"))

    t0 = time.time()
    pro, games, nfiles, stats = pro_damage(set(ids))
    print(f"pro timelines: {nfiles} games, {stats.get('used', 0)} champion damage rows used; skipped "
          f"{stats.get('skipped_other_slot', 0)} summoner/item/other-slot, {stats.get('skipped_unowned', 0)} rune/item/dragon procs, "
          f"{stats.get('skipped_empty', 0)} unnamed slot-0 or source-mismatch rows ({time.time() - t0:.1f}s)")

    unknown_over = [k for k in OVERRIDES if k not in ids]
    assert not unknown_over, f"overrides for unknown champions: {unknown_over}"

    kits = {}
    for c in champs:
        cid = c["id"]
        role_over, spell_over = OVERRIDES.get(cid, (None, {}))
        role = role_over or guess_role(c)
        assert role in ROLES, (cid, role)
        dd_spells = (dd.get(cid) or {}).get("spells") or [None] * 4
        mer = (meraki.get(cid) or {}).get("abilities") or {}
        spells = []
        for i, sp in enumerate(c["spells"]):
            kit = build_spell(c, i, sp, dd_spells[i] if i < len(dd_spells) else None, mer.get(sp["key"]), role)
            if sp["key"] in spell_over:
                apply_override(kit, spell_over[sp["key"]], cid)
            spells.append(kit)
        share = None
        g = games.get(cid, 0)
        tot = pro.get(cid)
        if g >= MIN_GAMES and tot and sum(tot) > 0:
            share = [round(x / sum(tot), 3) for x in tot]
        distribute_damage(c, spells, share)
        for s in spells:
            for k in [k for k in s if k.startswith("_")]:
                del s[k]
            if "dash" in s:
                s["dash"]["len"] = round(s["dash"]["len"])
            for k in ("range", "radius", "width"):
                if k in s:
                    s[k] = round(s[k])
        entry = {"id": cid, "role": role, "spells": spells}
        if share:
            # make the rounded shares sum to exactly 1
            share[share.index(max(share))] = round(share[share.index(max(share))] + 1 - sum(share), 3)
            entry["dmgShare"] = share
            entry["games"] = g
        kits[cid] = entry

    # coverage
    n = len(kits)
    with_cc = sum(1 for k in kits.values() if any("cc" in s for s in k["spells"]))
    with_hard = sum(1 for k in kits.values() if any("cc" in s and s["cc"]["type"] != "slow" for s in k["spells"]))
    with_dash = sum(1 for k in kits.values() if any("dash" in s for s in k["spells"]))
    aoe_ults = [k["id"] for k in kits.values() if k["spells"][3].get("minTargets")]
    with_share = [k for k in kits.values() if "dmgShare" in k]
    share_games = sum(k["games"] for k in with_share)
    all_games = sum(games.get(i, 0) for i in ids)
    full = sum(1 for _, sp in OVERRIDES.values() if len(sp) >= FULL_CHECK_MIN_SPELLS)
    top70 = sorted(champs, key=lambda c: -c["pro"]["picks"])[:70]
    top70_full = sum(1 for c in top70 if len(OVERRIDES.get(c["id"], (None, {}))[1]) >= FULL_CHECK_MIN_SPELLS)
    mt3 = sorted(k["id"] for k in kits.values() if k["spells"][3].get("minTargets", 0) >= 3)
    print(f"coverage: {with_cc}/{n} champions with >=1 CC spell ({with_hard} with hard CC), "
          f"{with_dash}/{n} with a dash/blink, {len(aoe_ults)} AoE ults with minTargets (>=3: {', '.join(mt3)})")
    def with_field(field: str) -> list[str]:
        return sorted(f"{k['id']} {s['key']}" for k in kits.values() for s in k["spells"] if field in s)
    print(f"saves: {', '.join(with_field('save'))}")
    print(f"ally buffs: {', '.join(with_field('allyBuff'))}")
    arena = sorted(k["id"] + " " + s["key"] for k in kits.values() for s in k["spells"]
                   if s.get("cc", {}).get("type") == "arena")
    print(f"requires: {', '.join(with_field('requires'))}; arena: {', '.join(arena)}")
    print(f"overrides: {len(OVERRIDES)} champions ({full} with all 4 spells hand-checked; top-70 by picks: {top70_full}/70), "
          f"rest role + key spells; {n - len(OVERRIDES)} heuristic only")
    print(f"dmgShare: {len(with_share)}/{n} champions (>= {MIN_GAMES} games), covering {share_games}/{all_games} "
          f"champion-games of {nfiles} pro games")
    roles = collections.Counter(k["role"] for k in kits.values())
    print("roles:", dict(sorted(roles.items())))
    ratios = []
    by_id = {c["id"]: c for c in champs}
    for cid, k in kits.items():
        pw = sum(float(s.get("power") or 1) for s in by_id[cid]["spells"] if s["vfx"] not in ("shield", "heal"))
        ratios.append((sum(s["dmg"] for s in k["spells"]) / max(pw, 1.0), cid))
    ratios.sort()
    mid = ratios[len(ratios) // 2][0]
    print(f"calibration: sum(dmg)/sum(power) median {mid:.2f}, range {ratios[0][0]:.2f} ({ratios[0][1]}) .. "
          f"{ratios[-1][0]:.2f} ({ratios[-1][1]}); split by fight-window damage (casts = max(1, {FIGHT_WINDOW:g}/cd)), "
          f"sum clamped to 0.5..1.5x power")

    lines = [
        "// GENERATED by scripts/build_kits.py from champions.json + Data Dragon + Meraki + LCK 2026 timelines.",
        "// Do not edit by hand: change OVERRIDES in the script and re-run `python -I scripts/build_kits.py`.",
        'import type { ChampionKit } from "./kit-types";',
        "",
        f'export const KITS_META = {{ version: "{version}", proGames: {nfiles}, minGames: {MIN_GAMES} }} as const;',
        "",
        "export const KITS: Record<string, ChampionKit> = {",
    ]
    for cid in sorted(kits):
        lines.append(f"  {json.dumps(cid)}: {json.dumps(kits[cid], ensure_ascii=False, separators=(',', ':'))},")
    lines.append("};")
    lines.append("")
    OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(GAME)} ({OUT.stat().st_size // 1024} KB)")

    for cid in dump:
        k = kits.get(cid)
        if not k:
            print("no kit", cid)
            continue
        print(f"== {cid} [{k['role']}] games={k.get('games')} share={k.get('dmgShare')}")
        for s in k["spells"]:
            extra = []
            if "cc" in s:
                extra.append(f"cc={s['cc']['type']}:{s['cc']['dur']}")
            if "dash" in s:
                d = s["dash"]
                extra.append(f"dash={d['len']}:{d['to']}{':w' if d['overWalls'] else ''}")
            if "support" in s:
                extra.append(f"s={s['support']}")
            if "minTargets" in s:
                extra.append(f"mt={s['minTargets']}")
            if "selfBuff" in s:
                extra.append(f"buff={s['selfBuff']['kind']}:{s['selfBuff']['dur']}")
            if "save" in s:
                extra.append(f"save={s['save']['kind']}:{s['save']['dur']}:{s['save'].get('radius', 0)}")
            if "allyBuff" in s:
                extra.append(f"ally={s['allyBuff']['kind']}:{s['allyBuff']['dur']}:{s['allyBuff']['radius']}")
            if "requires" in s:
                extra.append(f"req={s['requires']}")
            print(f"  {s['key']} {s['shape']:<7} u={','.join(s['uses']):<28} t={s['target']:<9} r={s['range']} rad={s['radius']} "
                  f"d={s['dmg']} dl={s['delay']} ss={int(s['skillshot'])} cd={s['cd']} {' '.join(extra)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
