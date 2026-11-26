"""Build game/public/data/champions.json from Data Dragon + Leaguepedia pro stats.

  python scripts/fetch_ddragon.py 16.23.1      # once
  python scripts/fetch_game_data.py            # once (pro picks/bans; optional, roles fall back to tags)
  python scripts/build_champions.py [--version 16.23.1] [--dump]

Each spell gets a VFX archetype from a keyword heuristic over the English description, then the
OVERRIDES table below fixes the signature skills of the champions pros actually play. --dump prints
every spell's final classification so the table can be checked by eye.
"""

from __future__ import annotations

import argparse
import colorsys
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cargo_cache"
OUT = ROOT / "game" / "public" / "data" / "champions.json"
ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
VFX = {"line", "circle", "cone", "dash", "blink", "target", "self", "shield", "heal", "zone", "global",
       "summon", "knockup", "wall", "stealth"}

# Leaguepedia champion names that differ from Data Dragon ids after stripping punctuation.
NAME_ALIASES = {"wukong": "MonkeyKing", "nunuwillump": "Nunu", "renataglasc": "Renata"}

CC_WORDS = r"stun|root|snare|knock|airborne|slow|charm|taunt|fear|flee|suppress|silence|pull|sleep|drowsy|polymorph|ground|immobiliz|tether|pulls|displace"
DEFAULT_SIZE = {"circle": 250, "zone": 300, "cone": 420, "knockup": 220, "wall": 350, "summon": 150, "heal": 0,
                "shield": 0, "self": 0, "stealth": 0, "dash": 0, "blink": 0, "target": 0, "global": 0, "line": 0}
DEFAULT_WIDTH = 80

# ---------------------------------------------------------------------------------------------
# Manual overrides. Format per champion: "Q:<vfx>[+<also>][,r=<radius>][,w=<width>][,cc][,nocc][,p=<1-3>]; W:...; ..."
# Only the fields written here replace the heuristic. "also" is a second archetype for the renderer
# (e.g. a dash that ends in a knock-up). Written from the live kits as of the 2025-2026 seasons.
# ---------------------------------------------------------------------------------------------
OVERRIDES = {
    # --- top ---
    "Aatrox": "Q:cone+knockup,r=300,cc,p=3; W:line,w=80,cc; E:dash; R:self,p=3",
    "Ambessa": "Q:cone,r=350,p=2; W:shield; E:circle,r=300,cc; R:dash+knockup,cc,p=3",
    "Gnar": "Q:line,w=60,cc; W:self; E:dash; R:circle+wall,r=420,cc,p=3",
    "Jax": "Q:dash,p=2; W:self; E:circle,r=300,cc; R:self,p=3",
    "KSante": "Q:line,w=90,cc; W:dash+knockup,cc; E:dash+shield; R:dash,cc,p=3",
    "Rumble": "Q:cone,r=350; W:shield; E:line,w=60,cc; R:zone,r=200,w=200,cc,p=3",
    "Renekton": "Q:circle,r=325,nocc; W:target,cc; E:dash; R:self,p=2",
    "Sion": "Q:cone+knockup,r=500,cc,p=3; W:shield; E:line,w=80,cc; R:dash+knockup,cc,p=3",
    "Gwen": "Q:cone,r=300,p=2; W:zone,r=480,nocc; E:dash; R:line,w=60,cc,p=3",
    "Jayce": "Q:line,w=70; W:circle,r=285; E:target,cc; R:self,p=1",
    "Camille": "Q:self; W:cone,r=600,cc; E:dash,cc; R:zone,r=350,cc,p=3",
    "Ornn": "Q:line+wall,w=70,cc; W:cone,r=500,nocc; E:dash+knockup,cc; R:line+knockup,w=200,cc,p=3",
    "Kennen": "Q:line,w=50; W:circle,r=750; E:dash; R:zone,r=550,cc,p=3",
    "Poppy": "Q:line,w=100,cc; W:zone,r=400,cc; E:dash,cc; R:line+knockup,w=100,cc,p=3",
    "Yorick": "Q:target; W:wall,r=300,cc; E:cone,r=300,cc; R:summon,p=2",
    "Gragas": "Q:circle,r=300,cc; W:self; E:dash+knockup,cc; R:circle,r=400,cc,p=3",
    "Gangplank": "Q:target,p=2; W:heal; E:summon,r=350,cc; R:global,r=600,cc,p=3",
    "Fiora": "Q:dash; W:self,cc; E:self; R:heal,r=500,p=3",
    "Aurora": "Q:line,w=80; W:dash+stealth; E:cone,r=500,cc; R:zone+wall,r=450,cc,p=3",
    "Kled": "Q:line,w=60,cc; W:self; E:dash; R:dash+knockup,cc,p=3",
    "Mordekaiser": "Q:line,w=160; W:shield; E:line,w=100,cc; R:target,p=3",
    "Sett": "Q:self; W:cone,r=700,p=3; E:circle,r=450,cc; R:dash+knockup,cc,p=3",
    "Malphite": "Q:target,cc; W:self; E:circle,r=400,cc; R:dash+knockup,r=325,cc,p=3",
    "Yone": "Q:line+knockup,w=80,cc; W:cone,r=600; E:dash; R:line+knockup,w=180,cc,p=3",
    "Irelia": "Q:dash; W:cone,r=500; E:line,w=80,cc; R:line+wall,w=200,cc,p=3",
    "Riven": "Q:dash+knockup,cc; W:circle,r=250,cc; E:dash+shield; R:cone,r=900,p=3",
    "Darius": "Q:circle,r=425; W:self,cc; E:cone,r=535,cc; R:target,p=3",
    "Volibear": "Q:dash,cc; W:target; E:circle,r=325,cc; R:blink+circle,r=500,cc,p=3",
    "Chogath": "Q:circle+knockup,r=250,cc; W:cone,r=650,cc; E:self; R:target,p=3",
    "Shen": "Q:dash; W:zone,r=350; E:dash,cc; R:global+shield,p=3",
    "Trundle": "Q:self; W:zone,r=750; E:wall,r=200,cc; R:target,p=3",
    "DrMundo": "Q:line,w=60,cc; W:circle,r=325; E:self; R:heal,p=2",
    "Garen": "Q:dash,cc; W:shield; E:circle,r=325,nocc; R:target,p=3",
    "Kayle": "Q:line,w=75,cc; W:heal; E:self; R:shield+circle,r=550,p=3",
    "Teemo": "Q:target,cc; W:self; E:self; R:summon,r=200,cc",
    "Urgot": "Q:circle,r=215,cc; W:self; E:dash+knockup,cc; R:line,w=80,cc,p=3",
    "Zac": "Q:line,w=120,cc; W:circle,r=350; E:dash+knockup,cc,p=3; R:knockup,r=300,cc,p=3",
    "Akshan": "Q:line,w=60; W:stealth; E:dash; R:target,p=3",
    "Vladimir": "Q:target; W:zone,r=350,cc; E:circle,r=600; R:zone,r=375,p=3",
    "Tryndamere": "Q:heal; W:circle,r=850,cc; E:dash; R:self,p=3",
    "Nasus": "Q:self; W:target,cc; E:zone,r=400; R:self,p=3",
    "Singed": "Q:zone,r=150; W:zone,r=265,cc; E:target+knockup,cc; R:self,p=2",
    "Kayn": "Q:dash; W:line,w=200,cc; E:stealth; R:blink,p=3",
    # --- jungle ---
    "Vi": "Q:dash+knockup,cc; W:self; E:cone,r=600; R:dash+knockup,cc,p=3",
    "XinZhao": "Q:self,cc; W:cone,r=900,cc; E:dash,cc; R:circle,r=450,cc,p=3",
    "MonkeyKing": "Q:self; W:stealth+summon; E:dash; R:knockup,r=325,cc,p=3",
    "Pantheon": "Q:line,w=80; W:dash,cc; E:shield+cone,r=400; R:global+circle,r=700,cc,p=3",
    "Skarner": "Q:line,w=150; W:shield; E:dash,cc; R:cone,r=625,cc,p=3",
    "Sejuani": "Q:dash+knockup,cc; W:cone,r=600,cc; E:target,cc; R:line+circle,w=120,r=400,cc,p=3",
    "Maokai": "Q:circle,r=350,cc; W:dash,cc; E:summon,r=250,cc; R:line+wall,w=200,cc,p=3",
    "LeeSin": "Q:line+dash,w=60; W:dash+shield; E:circle,r=350,cc; R:target,cc,p=3",
    "Nidalee": "Q:line,w=40,p=2; W:summon,r=100; E:heal; R:self",
    "Kindred": "Q:dash; W:zone,r=500; E:target,cc; R:zone+heal,r=500,p=3",
    "Viego": "Q:line,w=80; W:dash,cc; E:stealth+zone,r=300; R:blink+circle,r=300,cc,p=3",
    "JarvanIV": "Q:line,w=70; W:shield,cc; E:summon,r=180; R:dash+wall,r=350,cc,p=3",
    "Nocturne": "Q:line,w=60; W:shield; E:target,cc; R:global+dash,cc,p=3",
    "Elise": "Q:target; W:summon; E:line,w=55,cc; R:self",
    "Graves": "Q:line,w=40,p=2; W:circle,r=250,cc; E:dash; R:line+cone,w=100,p=3",
    "RekSai": "Q:self; W:knockup,r=160,cc; E:dash; R:dash,p=3",
    "Ivern": "Q:line+dash,w=80,cc; W:zone,r=500; E:shield; R:summon,p=2",
    "Diana": "Q:line,w=50; W:shield; E:dash; R:circle,r=475,cc,p=3",
    "Talon": "Q:dash; W:cone,r=650,cc; E:dash; R:stealth+circle,r=550,p=3",
    "Lillia": "Q:circle,r=485; W:circle,r=250; E:line,w=120,cc; R:circle,cc,r=600,p=3",
    "Brand": "Q:line,w=60,cc; W:circle,r=260; E:target; R:target,p=3",
    "Qiyana": "Q:line,w=100; W:dash; E:dash; R:line+wall,w=280,cc,p=3",
    "Khazix": "Q:target,p=2; W:line,w=70,cc; E:dash; R:stealth,p=2",
    "Taliyah": "Q:line,w=100; W:knockup,r=225,cc; E:zone,r=300,cc; R:wall+global,w=120,cc,p=3",
    "Karthus": "Q:circle,r=160,p=2; W:wall,r=500,cc; E:zone,r=550; R:global,p=3",
    "Hecarim": "Q:circle,r=375; W:zone,r=525; E:dash,cc; R:dash,cc,p=3",
    "Belveth": "Q:dash; W:line+knockup,w=200,cc; E:circle,r=500; R:zone,r=500,p=3",
    "Rammus": "Q:dash+knockup,cc; W:self; E:target,cc; R:circle+knockup,r=300,cc,p=3",
    "Amumu": "Q:line+dash,w=80,cc; W:zone,r=300; E:circle,r=350; R:circle,r=550,cc,p=3",
    "Warwick": "Q:dash; W:self; E:circle,r=375,cc; R:dash,cc,p=3",
    "Zyra": "Q:line+summon,w=400; W:summon; E:line,w=70,cc; R:circle+knockup,r=500,cc,p=3",
    "Shyvana": "Q:self; W:zone,r=325; E:line,w=60; R:dash+knockup,cc,p=3",
    "Udyr": "Q:self; W:shield; E:self,cc; R:zone,r=370",
    "Briar": "Q:dash,cc; W:dash; E:line,w=200,cc; R:global+dash,cc,p=3",
    "Naafiri": "Q:line,w=70; W:dash,cc; E:dash; R:self,p=2",
    "Nunu": "Q:target+heal; W:dash+knockup,cc; E:circle,r=225,cc; R:zone,r=650,cc,p=3",
    "Fiddlesticks": "Q:target,cc; W:zone,r=575; E:circle,r=350,cc; R:blink+zone,r=600,p=3",
    # --- mid ---
    "Azir": "Q:line,w=70,cc; W:summon,r=320; E:dash+shield; R:wall,w=600,cc,p=3",
    "Orianna": "Q:line,w=80; W:circle,r=225,cc; E:shield; R:circle,r=415,cc,p=3",
    "Ahri": "Q:line,w=100; W:self; E:line,w=60,cc; R:dash,p=3",
    "Syndra": "Q:circle,r=210; W:circle,r=225,cc; E:cone,r=700,cc; R:target,p=3",
    "Sylas": "Q:line,w=180,cc; W:dash+heal; E:dash+line,w=60,cc; R:target,p=3",
    "Akali": "Q:cone,r=500; W:stealth+zone,r=350; E:line+dash,w=70; R:dash,p=3",
    "Hwei": "Q:line,w=80,p=2; W:shield; E:line,w=120,cc; R:circle,r=500,cc,p=3",
    "Viktor": "Q:target+shield; W:zone,r=300,cc; E:line,w=80; R:zone,r=325,p=3",
    "Corki": "Q:circle,r=250; W:dash; E:cone,r=600; R:line,w=40",
    "Galio": "Q:line+zone,w=150; W:shield+circle,r=350,cc; E:dash+knockup,cc; R:global+knockup,r=500,cc,p=3",
    "Annie": "Q:target,cc; W:cone,r=600; E:shield; R:summon+circle,r=290,cc,p=3",
    "Tristana": "Q:self; W:dash,cc; E:target,p=2; R:target,cc,p=3",
    "Cassiopeia": "Q:circle,r=200; W:zone,r=400,cc; E:target,p=2; R:cone,r=850,cc,p=3",
    "Leblanc": "Q:target; W:dash+circle,r=260; E:line,w=55,cc; R:self,p=3",
    "Ryze": "Q:line,w=55,p=2; W:target,cc; E:target; R:blink+zone,r=475,p=3",
    "Smolder": "Q:target; W:line,w=80,cc; E:dash; R:global+line,w=300,p=3",
    "Zoe": "Q:line,w=70,p=3; W:self; E:line,w=50,cc; R:blink",
    "TwistedFate": "Q:cone,r=1450; W:target,cc; E:self; R:global+blink,p=2",
    "Mel": "Q:circle,r=260; W:shield; E:line,w=80,cc; R:global,p=3",
    "Ziggs": "Q:circle,r=240; W:circle,r=325,cc; E:zone,r=325,cc; R:global+circle,r=525,p=3",
    "Vex": "Q:line,w=180,cc; W:shield+circle,r=475,cc; E:circle,r=300,cc; R:line+dash,w=130,p=3",
    "Anivia": "Q:line,w=110,cc; W:wall,w=400,cc; E:target,p=2; R:zone,r=400,cc,p=3",
    "Lissandra": "Q:line,w=75,cc; W:circle,r=450,cc; E:line+blink,w=125; R:circle,r=550,cc,p=3",
    "Neeko": "Q:circle,r=225; W:summon+stealth; E:line,w=70,cc; R:circle+knockup,r=600,cc,p=3",
    "Yasuo": "Q:line+knockup,w=50,cc; W:wall,w=350; E:dash; R:blink+knockup,cc,p=3",
    "Zed": "Q:line,w=50; W:summon; E:circle,r=290,cc; R:blink,p=3",
    "Katarina": "Q:target; W:self; E:blink; R:circle,r=550,p=3",
    "Kassadin": "Q:target+shield; W:self; E:cone,r=600,cc; R:blink",
    "Swain": "Q:cone,r=725; W:circle,r=300,cc; E:line,w=85,cc; R:zone+heal,r=650,p=3",
    "Malzahar": "Q:wall,w=400,cc; W:summon; E:target; R:target,cc,p=3",
    "Veigar": "Q:line,w=70; W:circle,r=240; E:wall,r=375,cc; R:target,p=3",
    "Xerath": "Q:line,w=100; W:circle,r=275,cc; E:line,w=60,cc; R:global+circle,r=200,p=3",
    "Lux": "Q:line,w=70,cc; W:line+shield,w=110; E:circle,r=310,cc; R:line,w=150,p=3",
    "Velkoz": "Q:line,w=55,cc; W:line,w=90; E:knockup,r=235,cc; R:line,w=100,p=3",
    "AurelionSol": "Q:line,w=200; W:dash; E:zone,r=275,cc; R:circle+knockup,r=275,cc,p=3",
    "Ekko": "Q:line,w=60,cc; W:circle,r=375,cc; E:dash; R:blink+circle,r=375,p=3",
    "Fizz": "Q:dash; W:self; E:blink,cc; R:line+knockup,w=100,cc,p=3",
    # --- bot ---
    "Kaisa": "Q:target,p=2; W:line,w=100; E:self+stealth; R:dash+shield,p=2",
    "Ezreal": "Q:line,w=60,p=2; W:line,w=80; E:blink; R:global,w=160,p=3",
    "Varus": "Q:line,w=70,p=2; W:self; E:circle,r=300,cc; R:line,w=120,cc,p=3",
    "Jinx": "Q:self; W:line,w=60,cc; E:summon,r=120,cc; R:global,w=140,p=3",
    "Xayah": "Q:line,w=50; W:self; E:line,cc; R:cone+self,r=900,p=3",
    "Zeri": "Q:line,w=40; W:line,w=40,cc; E:dash; R:circle,r=825,p=3",
    "Aphelios": "Q:line,w=60,p=2; W:self; E:self; R:line+circle,w=125,r=400,p=3",
    "Caitlyn": "Q:line,w=90; W:summon,cc; E:line+dash,w=70,cc; R:target,p=3",
    "Ashe": "Q:self; W:cone,r=1200,cc; E:global,w=40; R:global,w=130,cc,p=3",
    "Sivir": "Q:line,w=90; W:self; E:shield; R:self,p=2",
    "Kalista": "Q:line,w=40; W:summon; E:target,cc,p=2; R:target+knockup,cc,p=3",
    "Lucian": "Q:line,w=60; W:line,w=55; E:dash; R:line,w=110,p=3",
    "Jhin": "Q:target; W:line,w=45,cc; E:summon,r=140,cc; R:cone+line,r=3500,cc,p=3",
    "MissFortune": "Q:target; W:self; E:zone,r=400,cc; R:cone,r=1450,p=3",
    "Senna": "Q:line+heal,w=80; W:line,w=60,cc; E:stealth+zone,r=400; R:global+shield,w=180,p=3",
    "Draven": "Q:self; W:self; E:line,w=130,cc; R:global,w=160,p=3",
    "Yunara": "Q:self; W:line,w=120,cc; E:dash; R:self,p=3",
    "KogMaw": "Q:line,w=70; W:self; E:line,w=120,cc; R:circle,r=240,p=2",
    "Twitch": "Q:stealth; W:circle,r=280,cc; E:target,p=2; R:line,w=60,p=3",
    "Nilah": "Q:line,w=150; W:self; E:dash; R:circle,r=450,cc,p=3",
    "Samira": "Q:line,w=60; W:self; E:dash; R:circle,r=600,p=3",
    "Vayne": "Q:dash; W:self; E:target,cc; R:self+stealth,p=3",
    # --- support ---
    "Rell": "Q:line,w=120; W:dash+knockup,cc; E:self; R:circle,r=400,cc,p=3",
    "Rakan": "Q:line+heal,w=80; W:dash+knockup,r=250,cc; E:dash+shield; R:dash,cc,p=3",
    "Nautilus": "Q:line+dash,w=90,cc; W:shield; E:circle,r=475,cc; R:target+knockup,cc,p=3",
    "Alistar": "Q:knockup,r=365,cc; W:dash,cc; E:circle,r=350,cc; R:self,p=2",
    "Braum": "Q:line,w=60,cc; W:dash; E:wall,w=300; R:line+knockup,w=230,cc,p=3",
    "Leona": "Q:self,cc; W:shield; E:line+dash,w=70,cc; R:circle,r=325,cc,p=3",
    "Renata": "Q:line,w=70,cc; W:shield; E:line+shield,w=120,cc; R:wall,w=600,cc,p=3",
    "Bard": "Q:line,w=60,cc; W:heal; E:wall,w=150; R:zone,r=350,cc,p=3",
    "Thresh": "Q:line+dash,w=70,cc; W:shield; E:line,w=110,cc; R:wall,r=450,cc,p=3",
    "Lulu": "Q:line,w=60,cc; W:target,cc; E:shield; R:knockup,r=400,cc,p=3",
    "Milio": "Q:line,w=60,cc; W:heal,r=400; E:shield; R:heal,r=700,p=3",
    "Karma": "Q:line,w=60,cc; W:target,cc; E:shield; R:self",
    "Seraphine": "Q:circle,r=350; W:shield+heal,r=800; E:line,w=70,cc; R:line,w=160,cc,p=3",
    "Pyke": "Q:line+dash,w=70,cc; W:stealth; E:dash,cc; R:circle,r=250,p=3",
    "Blitzcrank": "Q:line+dash,w=70,cc; W:self; E:self,cc; R:circle,r=600,cc,p=2",
    "Taric": "Q:heal,r=350; W:shield; E:line,w=140,cc; R:shield+circle,r=400,p=3",
    "Janna": "Q:line,w=120,cc; W:target,cc; E:shield; R:heal+circle,r=725,cc,p=3",
    "Nami": "Q:knockup,r=200,cc; W:heal; E:self; R:line+knockup,w=250,cc,p=3",
    "Yuumi": "Q:line,w=50,cc; W:self; E:heal; R:line,w=200,cc,p=3",
    "Soraka": "Q:circle,r=265,cc; W:heal; E:zone,r=260,cc; R:global+heal,p=3",
    "Sona": "Q:target; W:heal+shield; E:self; R:line,w=140,cc,p=3",
    "Zilean": "Q:circle,r=150,cc; W:self; E:target,cc; R:shield",
    "Morgana": "Q:line,w=70,cc; W:zone,r=275; E:shield; R:circle,r=625,cc,p=3",
    "TahmKench": "Q:line,w=70,cc; W:blink+knockup,r=275,cc; E:shield; R:target,cc,p=3",
    # --- newer champions (kits read from the 16.23.1 descriptions) ---
    "Olaf": "Q:line,w=90,cc; W:shield; E:target,p=2; R:self,p=2",
    "Zaahen": "Q:self+knockup,cc,p=2; W:line,w=80,cc; E:dash+circle,r=250; R:knockup+heal,r=300,cc,p=3",
    "Locke": "Q:line,w=60; W:self; E:blink+dash; R:line,w=120,p=3",
}


def parse_override(text: str) -> dict[str, dict]:
    result = {}
    for part in filter(None, (p.strip() for p in text.split(";"))):
        key, spec = part.split(":", 1)
        fields = [f.strip() for f in spec.split(",") if f.strip()]
        entry: dict = {"cc": False}  # a hand-written spell is cc only when written so
        head = fields[0]
        vfx, _, also = head.partition("+")
        assert vfx in VFX, (key, vfx)
        entry["vfx"] = vfx
        if also:
            assert also in VFX, (key, also)
            entry["also"] = also
        for f in fields[1:]:
            if f == "cc":
                entry["cc"] = True
            elif f == "nocc":
                entry["cc"] = False
            elif f.startswith("r="):
                entry["radius"] = int(f[2:])
            elif f.startswith("w="):
                entry["width"] = int(f[2:])
            elif f.startswith("p="):
                entry["power"] = int(f[2:])
            else:
                raise ValueError(f"bad override field {f!r} in {text!r}")
        result[key.strip()] = entry
    return result


def strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text or "")


def classify(spell_en: dict, slot: str) -> dict:
    desc = strip_tags(spell_en["description"]).lower()
    tip = strip_tags(spell_en.get("tooltip", "")).lower()
    text = desc + " " + tip
    rng = max(spell_en.get("range") or [0])
    has = lambda pattern: re.search(pattern, desc) is not None  # noqa: E731
    vfx = None
    if rng >= 5000 and has(r"missile|fires|launch|barrage|rocket|arrow|straight line|across the map|anywhere|global"):
        vfx = "global"
    elif has(r"all enemy champions|every enemy champion|anywhere on the map|across the map|any allied champion|all allied champions"):
        vfx = "global"
    elif has(r"creates? (a|an) (impassable )?(wall|terrain|pillar|arena)|impassable"):
        vfx = "wall"
    elif has(r"invisib|camouflag|stealth"):
        vfx = "stealth"
    elif has(r"blinks?|teleports?"):
        vfx = "blink"
    elif has(r"\b(dash|dashes|lunges?|leaps?|jumps?|charges? (forward|at|toward)|vaults?|rolls? (a short|forward)|tumbles?)\b"):
        vfx = "dash"
    elif has(r"knock(s|ing)? (up|back|aside)|airborne"):
        vfx = "knockup"
    elif has(r"summons?|turret|clone|spawns?|places? a (trap|ward|mushroom)|plants?"):
        vfx = "summon"
    elif has(r"\bshield"):
        vfx = "shield"
    elif has(r"\bheal|restores? health|regenerat"):
        vfx = "heal"
    elif has(r"\bcone\b|in front of (him|her|them|it)"):
        vfx = "cone"
    elif has(r"\b(zone|field|pool|storm|ring|over time in an area|lingering|creates? an? area)\b"):
        vfx = "zone"
    elif has(r"\b(line|skillshot|missile|bolt|fires|throws|hurls|launches|shoots|projectile|spear|in a direction)\b"):
        vfx = "line"
    elif has(r"\b(area|around (him|her|them|it|himself|herself|themself|itself)|nearby enemies|explod|smash|slam|location)\b"):
        vfx = "circle"
    elif has(r"\b(target|an enemy|the enemy|enemy champion)\b"):
        vfx = "target"
    else:
        vfx = "self"
    cc = re.search(CC_WORDS, text) is not None
    power = 3 if slot == "R" else (2 if re.search(r"damage", desc) else 1)
    entry = {"vfx": vfx, "cc": cc, "power": power}
    if vfx in ("circle", "zone", "cone", "knockup", "wall", "summon") and DEFAULT_SIZE[vfx]:
        entry["radius"] = DEFAULT_SIZE[vfx] + (150 if slot == "R" and vfx in ("circle", "zone") else 0)
    if vfx in ("line", "global"):
        entry["width"] = 120 if slot == "R" else DEFAULT_WIDTH
    return entry


def dominant_color(image_path: Path) -> str:
    from PIL import Image
    image = Image.open(image_path).convert("RGB").resize((48, 48))
    bins: dict[int, list] = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    for r, g, b in image.get_flattened_data():
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s < 0.35 or v < 0.3:
            continue
        weight = s * v
        slot = bins[int(h * 18) % 18]
        slot[0] += weight
        slot[1] += r * weight
        slot[2] += g * weight
        slot[3] += b * weight
    if not bins:
        pixels = list(image.get_flattened_data())
        r, g, b = (sum(p[i] for p in pixels) // len(pixels) for i in range(3))
        return f"#{r:02x}{g:02x}{b:02x}"
    weight, r, g, b = max(bins.values(), key=lambda slot: slot[0])
    r, g, b = r / weight, g / weight, b / weight
    # push toward a readable, saturated tint
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    r, g, b = colorsys.hsv_to_rgb(h, max(s, 0.55), max(v, 0.75))
    return "#{:02x}{:02x}{:02x}".format(int(r * 255), int(g * 255), int(b * 255))


def norm_name(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.lower())


def load_pro_stats(id_by_norm: dict[str, str]):
    """Return picks/wins per champion (LCK 2025-26), role counts (LCK + CL 2025-26), bans and game count."""
    picks, wins, bans = Counter(), Counter(), Counter()
    role_counts: dict[str, Counter] = defaultdict(Counter)
    lck_games: set[str] = set()
    unknown = Counter()

    def to_id(name: str) -> str | None:
        key = norm_name(name)
        champ = id_by_norm.get(key) or NAME_ALIASES.get(key)
        if not champ:
            unknown[name] += 1
        return champ

    for league in ("lck", "cl"):
        for year in ("2025", "2026"):
            path = CACHE / f"game_sp_{league}_{year}.json"
            if not path.exists():
                print(f"  (missing {path.name}; pro stats will be partial)")
                continue
            for row in json.loads(path.read_text(encoding="utf-8")):
                champ = to_id(row.get("Champion") or "")
                if not champ:
                    continue
                if row.get("Role") in ROLES:
                    role_counts[champ][row["Role"]] += 1
                if league == "lck":
                    lck_games.add(row["GameId"])
                    picks[champ] += 1
                    wins[champ] += row.get("Win") == "Yes"
    pb_path = CACHE / "game_pb_lck.json"
    if pb_path.exists():
        for row in json.loads(pb_path.read_text(encoding="utf-8")):
            for key, value in row.items():
                if key.startswith("T") and "B" in key and value and value.lower() not in ("none", "loss of ban"):
                    champ = to_id(value)
                    if champ:
                        bans[champ] += 1
    if unknown:
        print("  unmatched champion names:", dict(unknown.most_common(10)))
    return picks, wins, bans, role_counts, len(lck_games)


TAG_ROLE_PRIOR = {
    "Marksman": {"Bot": 0.8, "Mid": 0.15, "Top": 0.05},
    "Support": {"Support": 0.85, "Mid": 0.1, "Top": 0.05},
    "Mage": {"Mid": 0.7, "Support": 0.15, "Bot": 0.1, "Top": 0.05},
    "Assassin": {"Mid": 0.55, "Jungle": 0.4, "Top": 0.05},
    "Fighter": {"Top": 0.6, "Jungle": 0.35, "Mid": 0.05},
    "Tank": {"Top": 0.45, "Jungle": 0.3, "Support": 0.25},
}


def role_share(champ_full: dict, counts: Counter) -> dict[str, float]:
    total = sum(counts.values())
    prior: Counter = Counter()
    tags = champ_full["tags"]
    for i, tag in enumerate(tags):
        for role, share in TAG_ROLE_PRIOR.get(tag, {}).items():
            prior[role] += share * (1.0 if i == 0 else 0.5)
    prior_total = sum(prior.values()) or 1.0
    if total >= 3:
        shares = {r: counts[r] / total for r in ROLES}
    else:
        blend = total / 3
        shares = {r: blend * (counts[r] / total if total else 0) + (1 - blend) * prior[r] / prior_total for r in ROLES}
    s = sum(shares.values()) or 1.0
    return {r: round(shares[r] / s, 3) for r in ROLES}


def damage_type(champ: dict, champ_id: str) -> str:
    overrides = {"Kaisa": "Mixed", "Corki": "Mixed", "Ezreal": "AD", "Katarina": "AP", "Kayle": "Mixed", "Shyvana": "Mixed",
                 "Jax": "Mixed", "Gwen": "AP", "KSante": "AD", "Varus": "AD", "Kogmaw": "Mixed", "KogMaw": "Mixed",
                 "Rumble": "AP", "Sylas": "AP", "Akali": "AP", "Kennen": "AP", "Gragas": "AP", "Diana": "AP", "Lillia": "AP",
                 "Elise": "AP", "Nidalee": "AP", "Belveth": "AD", "Ornn": "Mixed", "Sejuani": "AP", "Maokai": "AP",
                 "Rell": "AP", "Nautilus": "Mixed", "Alistar": "AP", "Leona": "AP", "Braum": "AP", "Poppy": "AD",
                 "Sion": "AD", "Malphite": "AP", "Zac": "AP", "Chogath": "AP", "Shen": "Mixed", "Skarner": "Mixed",
                 "Vi": "AD", "XinZhao": "AD", "MonkeyKing": "AD", "JarvanIV": "AD", "Galio": "AP", "Ambessa": "AD",
                 "Aatrox": "AD", "Renekton": "AD", "Gnar": "AD", "Camille": "AD", "Fiora": "AD", "Yorick": "AD",
                 "Gangplank": "AD", "Mordekaiser": "AP", "Sett": "AD", "Yone": "AD", "Yasuo": "AD", "Irelia": "AD",
                 "Teemo": "AP", "Kindred": "AD", "Graves": "AD", "Hecarim": "AD", "Udyr": "Mixed", "Trundle": "AD",
                 "Volibear": "Mixed", "Warwick": "Mixed", "Rammus": "AP", "Amumu": "AP", "Nunu": "AP", "Viego": "AD",
                 "Briar": "AD", "Pyke": "AD", "Senna": "AD", "Taric": "AP", "Thresh": "AP", "Blitzcrank": "AP",
                 "Rakan": "AP", "Bard": "AP", "Renata": "AP", "Tristana": "AD", "Smolder": "AD", "Aurora": "AP"}
    if champ_id in overrides:
        return overrides[champ_id]
    attack, magic = champ["info"]["attack"], champ["info"]["magic"]
    if magic - attack >= 3:
        return "AP"
    if attack - magic >= 3:
        return "AD"
    return "Mixed"


STYLE_OVERRIDES = {
    # early, scaling, engage, peel, poke, waveclear, split, burst, sustain
    "Azir": dict(early=4, scaling=9, engage=6, peel=6, poke=5, waveclear=8, split=2, burst=5, sustain=2),
    "Orianna": dict(early=4, scaling=8, engage=5, peel=7, poke=6, waveclear=8, split=1, burst=7, sustain=2),
    "Kassadin": dict(early=1, scaling=10, engage=3, peel=1, poke=2, waveclear=6, split=6, burst=9, sustain=3),
    "Kayle": dict(early=1, scaling=10, engage=0, peel=3, poke=3, waveclear=8, split=7, burst=4, sustain=3),
    "Jinx": dict(early=3, scaling=9, engage=0, peel=1, poke=4, waveclear=8, split=3, burst=5, sustain=1),
    "Aphelios": dict(early=3, scaling=9, engage=1, peel=2, poke=5, waveclear=8, split=1, burst=7, sustain=4),
    "Kaisa": dict(early=4, scaling=8, engage=4, peel=1, poke=3, waveclear=7, split=3, burst=8, sustain=1),
    "Ezreal": dict(early=6, scaling=6, engage=1, peel=2, poke=9, waveclear=5, split=3, burst=6, sustain=2),
    "Varus": dict(early=6, scaling=6, engage=5, peel=4, poke=9, waveclear=7, split=1, burst=7, sustain=1),
    "Draven": dict(early=9, scaling=5, engage=1, peel=1, poke=2, waveclear=6, split=2, burst=8, sustain=2),
    "Lucian": dict(early=8, scaling=4, engage=2, peel=1, poke=3, waveclear=6, split=3, burst=7, sustain=1),
    "Smolder": dict(early=2, scaling=10, engage=1, peel=2, poke=6, waveclear=8, split=2, burst=5, sustain=3),
    "Zeri": dict(early=3, scaling=8, engage=2, peel=1, poke=3, waveclear=7, split=3, burst=4, sustain=2),
    "Renekton": dict(early=9, scaling=3, engage=6, peel=2, poke=1, waveclear=6, split=6, burst=7, sustain=5),
    "Jax": dict(early=6, scaling=8, engage=6, peel=2, poke=0, waveclear=6, split=9, burst=6, sustain=3),
    "Fiora": dict(early=6, scaling=8, engage=3, peel=1, poke=0, waveclear=5, split=10, burst=6, sustain=7),
    "Camille": dict(early=5, scaling=7, engage=8, peel=2, poke=0, waveclear=5, split=9, burst=8, sustain=3),
    "KSante": dict(early=5, scaling=6, engage=8, peel=8, poke=1, waveclear=5, split=5, burst=4, sustain=4),
    "Ornn": dict(early=5, scaling=8, engage=9, peel=6, poke=1, waveclear=5, split=3, burst=3, sustain=3),
    "Rumble": dict(early=7, scaling=6, engage=5, peel=4, poke=4, waveclear=8, split=4, burst=7, sustain=1),
    "Gnar": dict(early=5, scaling=6, engage=8, peel=5, poke=5, waveclear=6, split=5, burst=4, sustain=2),
    "LeeSin": dict(early=9, scaling=3, engage=7, peel=5, poke=1, waveclear=4, split=3, burst=7, sustain=3),
    "Nidalee": dict(early=9, scaling=3, engage=2, peel=1, poke=8, waveclear=6, split=4, burst=8, sustain=4),
    "Sejuani": dict(early=5, scaling=6, engage=9, peel=6, poke=0, waveclear=4, split=1, burst=3, sustain=2),
    "Maokai": dict(early=5, scaling=6, engage=8, peel=7, poke=2, waveclear=5, split=2, burst=2, sustain=4),
    "Vi": dict(early=7, scaling=5, engage=8, peel=3, poke=0, waveclear=4, split=3, burst=7, sustain=2),
    "XinZhao": dict(early=8, scaling=4, engage=7, peel=4, poke=0, waveclear=4, split=3, burst=6, sustain=4),
    "JarvanIV": dict(early=8, scaling=4, engage=9, peel=3, poke=1, waveclear=4, split=2, burst=6, sustain=1),
    "Viego": dict(early=6, scaling=7, engage=4, peel=1, poke=0, waveclear=5, split=4, burst=7, sustain=6),
    "Rell": dict(early=6, scaling=5, engage=10, peel=6, poke=0, waveclear=1, split=0, burst=3, sustain=1),
    "Nautilus": dict(early=7, scaling=4, engage=9, peel=6, poke=1, waveclear=2, split=0, burst=4, sustain=1),
    "Alistar": dict(early=6, scaling=5, engage=9, peel=8, poke=0, waveclear=1, split=0, burst=2, sustain=4),
    "Rakan": dict(early=5, scaling=5, engage=9, peel=6, poke=1, waveclear=1, split=0, burst=3, sustain=3),
    "Leona": dict(early=8, scaling=4, engage=10, peel=4, poke=0, waveclear=1, split=0, burst=3, sustain=2),
    "Lulu": dict(early=5, scaling=7, engage=1, peel=10, poke=4, waveclear=2, split=0, burst=1, sustain=4),
    "Janna": dict(early=4, scaling=6, engage=1, peel=10, poke=3, waveclear=1, split=0, burst=1, sustain=5),
    "Milio": dict(early=4, scaling=7, engage=1, peel=9, poke=3, waveclear=1, split=0, burst=1, sustain=8),
    "Braum": dict(early=6, scaling=5, engage=5, peel=10, poke=1, waveclear=1, split=0, burst=1, sustain=2),
    "Karma": dict(early=8, scaling=4, engage=4, peel=7, poke=8, waveclear=4, split=0, burst=4, sustain=4),
    "Ryze": dict(early=4, scaling=8, engage=4, peel=3, poke=3, waveclear=8, split=6, burst=6, sustain=3),
    "Galio": dict(early=5, scaling=6, engage=8, peel=8, poke=3, waveclear=7, split=2, burst=6, sustain=2),
    "Corki": dict(early=4, scaling=8, engage=1, peel=1, poke=8, waveclear=8, split=4, burst=6, sustain=1),
    "Yone": dict(early=5, scaling=8, engage=8, peel=1, poke=2, waveclear=7, split=7, burst=8, sustain=3),
    "Sylas": dict(early=6, scaling=6, engage=6, peel=3, poke=2, waveclear=5, split=4, burst=7, sustain=6),
    "Taliyah": dict(early=6, scaling=6, engage=6, peel=5, poke=5, waveclear=9, split=3, burst=6, sustain=1),
    "Ahri": dict(early=6, scaling=6, engage=5, peel=4, poke=5, waveclear=7, split=3, burst=8, sustain=3),
    "Syndra": dict(early=6, scaling=7, engage=3, peel=5, poke=6, waveclear=8, split=1, burst=9, sustain=1),
    "Viktor": dict(early=4, scaling=8, engage=2, peel=5, poke=7, waveclear=9, split=2, burst=7, sustain=2),
    "Hwei": dict(early=4, scaling=8, engage=4, peel=5, poke=9, waveclear=9, split=1, burst=7, sustain=1),
    "Aurora": dict(early=6, scaling=6, engage=5, peel=3, poke=5, waveclear=7, split=6, burst=8, sustain=2),
    "Gangplank": dict(early=3, scaling=9, engage=2, peel=2, poke=7, waveclear=8, split=6, burst=9, sustain=4),
    "Kalista": dict(early=8, scaling=4, engage=5, peel=4, poke=3, waveclear=7, split=2, burst=6, sustain=2),
    "Senna": dict(early=4, scaling=9, engage=2, peel=5, poke=8, waveclear=4, split=1, burst=5, sustain=6),
    "Ashe": dict(early=4, scaling=6, engage=7, peel=6, poke=6, waveclear=6, split=1, burst=4, sustain=1),
    "Sivir": dict(early=3, scaling=7, engage=6, peel=3, poke=4, waveclear=10, split=2, burst=3, sustain=2),
    "Xayah": dict(early=5, scaling=7, engage=1, peel=5, poke=3, waveclear=8, split=2, burst=6, sustain=1),
    "Caitlyn": dict(early=8, scaling=5, engage=1, peel=4, poke=8, waveclear=6, split=4, burst=5, sustain=1),
    "Jhin": dict(early=5, scaling=6, engage=3, peel=3, poke=8, waveclear=6, split=1, burst=8, sustain=1),
}


def style_for(champ: dict, champ_id: str, spells: list[dict], damage: str, ranged: bool) -> dict:
    if champ_id in STYLE_OVERRIDES:
        return STYLE_OVERRIDES[champ_id]
    tags = set(champ["tags"])
    info = champ["info"]
    vfx = [s["vfx"] for s in spells] + [s.get("also") for s in spells if s.get("also")]
    cc = sum(1 for s in spells if s["cc"])
    clamp = lambda x: max(0, min(10, round(x)))  # noqa: E731
    engage = 1 + 2 * vfx.count("dash") + 2 * vfx.count("knockup") + 1.5 * vfx.count("blink") + cc + (2 if "Tank" in tags else 0)
    peel = 1 + cc + 2 * vfx.count("shield") + 1.5 * vfx.count("heal") + (2 if "Support" in tags else 0) + (1 if "Tank" in tags else 0)
    poke = (3 if ranged else 0) + 1.5 * vfx.count("line") + vfx.count("global") + (2 if "Mage" in tags or "Marksman" in tags else 0)
    waveclear = 2 + 1.5 * (vfx.count("circle") + vfx.count("zone") + vfx.count("cone")) + (2 if "Mage" in tags else 0) + (1 if "Marksman" in tags else 0)
    split = (4 if "Fighter" in tags else 1) + (1 if "Assassin" in tags else 0) + (1 if not ranged else 0) - (3 if "Support" in tags else 0)
    burst = (info["attack"] + info["magic"]) / 2 + (3 if "Assassin" in tags else 0) - (2 if "Tank" in tags or "Support" in tags else 0)
    sustain = 1 + 2 * vfx.count("heal") + (1 if "Fighter" in tags else 0)
    early = 5 + (2 if "Assassin" in tags else 0) + (1 if "Fighter" in tags else 0) - (2 if "Marksman" in tags else 0) - info["difficulty"] / 5
    scaling = 5 + (3 if "Marksman" in tags else 0) + (1 if "Mage" in tags else 0) - (2 if "Assassin" in tags else 0) + (1 if "Tank" in tags else 0)
    return {"early": clamp(early), "scaling": clamp(scaling), "engage": clamp(engage), "peel": clamp(peel), "poke": clamp(poke),
            "waveclear": clamp(waveclear), "split": clamp(split), "burst": clamp(burst), "sustain": clamp(sustain)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="16.23.1")
    parser.add_argument("--dump", action="store_true")
    args = parser.parse_args()
    base = ROOT / "data" / "ddragon" / args.version
    ko = json.loads((base / "championFull_ko_KR.json").read_text(encoding="utf-8"))["data"]
    en = json.loads((base / "championFull_en_US.json").read_text(encoding="utf-8"))["data"]

    id_by_norm = {norm_name(c["name"]): cid for cid, c in en.items()}
    id_by_norm.update({norm_name(cid): cid for cid in en})
    picks, wins, bans, role_counts, lck_games = load_pro_stats(id_by_norm)
    overrides = {cid: parse_override(text) for cid, text in OVERRIDES.items() if text}
    missing = [cid for cid in overrides if cid not in en]
    if missing:
        raise SystemExit(f"override ids not in Data Dragon: {missing}")

    champions = []
    for cid in sorted(en, key=lambda c: en[c]["name"]):
        e, k = en[cid], ko[cid]
        spells = []
        for slot, spell_en, spell_ko in zip("QWER", e["spells"], k["spells"]):
            entry = classify(spell_en, slot)
            entry.update(overrides.get(cid, {}).get(slot, {}))
            if entry["vfx"] in ("circle", "zone", "cone", "knockup", "wall", "summon") and "radius" not in entry:
                entry["radius"] = DEFAULT_SIZE[entry["vfx"]]
            if entry["vfx"] in ("line", "global") and "width" not in entry:
                entry["width"] = DEFAULT_WIDTH
            rng = max(spell_en.get("range") or [0])
            spell = {"key": slot, "name": spell_ko["name"], "icon": spell_ko["image"]["full"],
                     "cd": round(float(spell_en["cooldown"][0]), 1), "range": int(rng) if rng < 20000 else 25000,
                     "vfx": entry["vfx"]}
            if entry.get("also"):
                spell["also"] = entry["also"]
            for field in ("radius", "width"):
                if field in entry:
                    spell[field] = entry[field]
            spell["cc"] = bool(entry["cc"])
            spell["power"] = int(entry["power"])
            spells.append(spell)
        ranged = e["stats"]["attackrange"] > 250
        damage = damage_type(e, cid)
        n_picks = picks[cid]
        champions.append({
            "id": cid, "name": k["name"], "nameEn": e["name"], "tags": e["tags"],
            "roles": role_share(e, role_counts[cid]),
            "damage": damage, "ranged": ranged,
            "attackRange": int(e["stats"]["attackrange"]), "moveSpeed": int(e["stats"]["movespeed"]),
            "color": dominant_color(base / "img" / f"{cid}.png"),
            "style": style_for(e, cid, spells, damage, ranged),
            "pro": {"picks": n_picks, "bans": bans[cid], "wins": wins[cid],
                    "presence": round((n_picks + bans[cid]) / lck_games, 3) if lck_games else 0},
            "spells": spells,
            "passive": {"name": k["passive"]["name"], "icon": k["passive"]["image"]["full"]},
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"version": args.version, "champions": champions}, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"{len(champions)} champions -> {OUT} (LCK games counted: {lck_games}, overrides: {len(overrides)})")
    vfx_counter = Counter(s["vfx"] for c in champions for s in c["spells"])
    print("vfx mix:", dict(vfx_counter.most_common()))
    top = sorted(champions, key=lambda c: -(c["pro"]["picks"] + c["pro"]["bans"]))
    top_ids = [c["id"] for c in top[:70]]
    not_overridden = [cid for cid in top_ids if cid not in overrides]
    print("top-70 pro champions without overrides:", not_overridden)
    if args.dump:
        for c in top[:200] if lck_games else champions:
            mark = "*" if c["id"] in overrides else " "
            line = " | ".join(f"{s['key']}:{s['vfx']}{'+' + s['also'] if s.get('also') else ''}{' cc' if s['cc'] else ''}" for s in c["spells"])
            print(f"{mark} {c['id']:<13} {c['pro']['picks']:>4}p {c['pro']['bans']:>4}b  {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
