"""Build game/public/data/matchups.json: champion matchups (same-role opponents) and team-composition counters
measured on real LCK games.

  python -I scripts/build_matchups.py [--tau 0.05] [--cv 5]

Sources
  * Leaguepedia ScoreboardPlayers, LCK 2025 + 2026 (data/cargo_cache/game_sp_lck_{2025,2026}.json): champion,
    role, side, team and result of every player. 2025 games weigh 0.6 (older patches), 2026 games 1.0, like the
    player ratings in build_game_data.py.
  * LCK 2026 Riot timelines (data/games_lck_2026.json index -> data/raw/*.json.gz, 502 games): every player's total
    gold at 14:00. Roles come from the participant order (Top, Jungle, Mid, Bot, Support per team); teamPosition is
    garbage in tournament games.

Model (one regularised fit, Newton steps on dense numpy matrices)
  win   logit P(side 1 wins) = b0 + T[team-year 1] - T[team-year 2]
                               + sum over roles ( C[role, champ 1] - C[role, champ 2] + U[role, champ 1 vs champ 2] )
                               + comp counters (engage > poke > peel > engage, see COMP below)
  gold  gold14[side 1, role] - gold14[side 2, role] = g0[role] + gT[team-year 1] - gT[team-year 2]
                               + G[role, champ 1] - G[role, champ 2] + U[role, champ 1 vs champ 2] / slope
  * T, C (team and champion strength) and gT, G (team and champion gold, e.g. tanks earn less) take the
    confounders out: a champion strong teams like to pick, or one that is strong against everybody, is not a
    matchup. U is what is left: how champion 1 does against champion 2 beyond both champions' and both teams'
    usual results. U is shared by the two likelihoods; `slope` turns a 14-minute gold lead into win logit (fitted on
    the same 502 games, team gold difference -> result).
  * Gaussian priors (ridge) on every block. The matchup prior sd (TAU_U) maximises the Laplace evidence over a grid
    (type-II maximum likelihood), so the data decides how big matchups are; `--tau` overrides it. On LCK 2025-26 the
    evidence peaks at 0.05 (flat from 0.02 to 0.08) and 5-fold cross validation prefers 0.02 or less: once champion
    and team strength are out, LCK matchups are small (the largest about 2%p). Pros rarely play a lane they think
    they lose, so the games say little about hard counters.
  * Pairs that never met in LCK get no entry (the game treats them as even).

Output (champion ids as in champions.json, pair key "a|b" with a < b, numbers from a's point of view)
  roles[role]["a|b"] = [m, n, wins_a, gold14_a, n_gold]
     m        matchup in win logit (posterior mean of U); a's win chance vs an even game = logistic(m)
     n        LCK games of the pair (2025 + 2026), wins_a games a won
     gold14_a mean raw 14:00 gold lead of a in that lane (2026 timelines, null without one), n_gold their count
  comp     {keys, mean, sd, w}: z-scored team average of champions.json style engage / poke / peel and the logit
           weights of the three counter products (engage vs poke, poke vs peel, peel vs engage)
  counterItems[mr|armor|antiheal] = {feature: ap|ad|heal, base[role], slope[role], rates[role][0..5], items[role],
           byClass[class]}: how often LCK 2026 players had a magic resist / armor / Grievous Wounds legendary among
           their first four, by the number of enemy AP / AD / healer (style.sustain >= 7) champions (a logistic fit per
           role, so the rates are monotone and extend to counts LCK never had); items are the role's and each champion
           class's (first Data Dragon tag) most bought ones of that kind. The engine turns its LCK build toward them
           (matchup.ts counterPath).
  goldSlope, goldSigma, tau, games, ...
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "game" / "public" / "data" / "matchups.json"
ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"]
YEAR_W = {"2025": 0.6, "2026": 1.0}
GOLD_MINUTE = 14
# prior sd of each block (win logit / gold)
TAU_T, TAU_C, TAU_COMP = 0.5, 0.3, 0.3
TAU_GT, TAU_G = 400.0, 400.0
TAU_U_GRID = [0.01, 0.02, 0.035, 0.05, 0.065, 0.08, 0.12, 0.16]
COMP_KEYS = ["engage", "poke", "peel"]


def champion_lookup():
    data = json.loads((ROOT / "game" / "public" / "data" / "champions.json").read_text(encoding="utf-8"))
    lookup, champs = {}, {}
    for c in data["champions"]:
        champs[c["id"]] = c
        for name in (c["id"], c["nameEn"]):
            lookup[re.sub(r"[^a-z]", "", name.lower())] = c["id"]
    lookup.update({"wukong": "MonkeyKing", "nunuwillump": "Nunu", "renataglasc": "Renata"})
    return (lambda name: lookup.get(re.sub(r"[^a-z]", "", (name or "").lower()))), champs


def load_games(cid):
    """LCK games: {gid: {year, w, teams[2], win1, champs[side][role]}} from the Cargo scoreboards."""
    games: dict[str, dict] = {}
    unknown = Counter()
    for year in ("2025", "2026"):
        rows = json.loads((DATA / "cargo_cache" / f"game_sp_lck_{year}.json").read_text(encoding="utf-8"))
        for r in rows:
            g = games.setdefault(r["GameId"], {"year": year, "w": YEAR_W[year], "teams": [None, None], "win1": None,
                                               "champs": [{}, {}]})
            side = int(r["Side"]) - 1
            c = cid(r["Champion"])
            if not c:
                unknown[r["Champion"]] += 1
                continue
            g["teams"][side] = f'{r["Team"]}|{year}'
            g["champs"][side][r["Role"]] = c
            if r["Win"] in ("Yes", "1", "True"):
                g["win1"] = 1 if side == 0 else 0
            elif g["win1"] is None and r["Win"] in ("No", "0", "False"):
                g["win1"] = 0 if side == 0 else 1
    if unknown:
        print("unknown champion names:", unknown.most_common(8))
    ok = {k: g for k, g in games.items()
          if g["win1"] is not None and all(g["teams"]) and all(len(g["champs"][s]) == 5 for s in (0, 1))}
    print(f"LCK games: {len(games)} read, {len(ok)} complete "
          f"({sum(1 for g in ok.values() if g['year'] == '2025')} from 2025, {sum(1 for g in ok.values() if g['year'] == '2026')} from 2026)")
    return ok


def load_gold(cid, games):
    """Attach gold14[side][role] to the 2026 games that have a Riot timeline."""
    index = json.loads((DATA / "games_lck_2026.json").read_text(encoding="utf-8"))
    hit = 0
    for e in index["games"]:
        g = games.get(e["game_id"])
        raw_path = DATA / "raw" / f'{e["rpgid"]}.json.gz'
        if not g or not raw_path.exists():
            continue
        raw = json.load(gzip.open(raw_path, "rt", encoding="utf-8"))
        frames = raw.get("timeline", {}).get("frames", [])
        if len(frames) <= GOLD_MINUTE + 1:
            continue
        pf = frames[GOLD_MINUTE]["participantFrames"]
        names = {p["participantId"]: cid(p["championName"]) for p in raw["data"]["participants"]}
        gold = [{}, {}]
        good = True
        for side in (0, 1):
            for i, role in enumerate(ROLES):
                pid = side * 5 + i + 1
                # the participant order is Top..Support per team; check it against the Leaguepedia roster
                if names.get(pid) != g["champs"][side].get(role):
                    good = False
                gold[side][role] = pf[str(pid)]["totalGold"]
        if good:
            g["gold"] = gold
            hit += 1
    print(f"timelines with gold at {GOLD_MINUTE}:00: {hit}")


def gold_slope(games):
    """Win logit per gold of team gold lead at 14:00, with each team-year's strength in the fit (ridge, sd TAU_T):
    without it strong teams, which both lead at 14:00 and win, make the gold lead look worth more than it is."""
    rows = [g for g in games.values() if "gold" in g]
    teams = sorted({t for g in rows for t in g["teams"]})
    ti = {t: i for i, t in enumerate(teams)}
    n = 2 + len(teams)  # side term, gold slope (per 1,000), teams
    X = np.zeros((len(rows), n))
    y = np.array([g["win1"] for g in rows], float)
    for k, g in enumerate(rows):
        X[k, 0] = 1
        X[k, 1] = sum(g["gold"][0][r] - g["gold"][1][r] for r in ROLES) / 1000
        X[k, 2 + ti[g["teams"][0]]] += 1
        X[k, 2 + ti[g["teams"][1]]] -= 1
    prec = np.array([1e-4, 1e-4] + [1 / TAU_T ** 2] * len(teams))
    th = np.zeros(n)
    for _ in range(50):
        p = 1 / (1 + np.exp(-(X @ th)))
        grad = X.T @ (p - y) + prec * th
        H = (X.T * (p * (1 - p))) @ X + np.diag(prec)
        step = np.linalg.solve(H, grad)
        th -= step
        if np.max(np.abs(step)) < 1e-10:
            break
    return float(th[1]) / 1000, float(th[0])


def comp_features(champs, games):
    raw = {}
    for gid, g in games.items():
        raw[gid] = [[sum(champs[g["champs"][s][r]]["style"].get(k, 5) for r in ROLES) / 5 for k in COMP_KEYS] for s in (0, 1)]
    allv = np.array([v for pair in raw.values() for v in pair])
    mean, sd = allv.mean(axis=0), allv.std(axis=0)
    z = {gid: [(np.array(v[s]) - mean) / sd for s in (0, 1)] for gid, v in raw.items()}
    return z, mean, sd


def counter_terms(a, b):
    """Antisymmetric products for side a vs side b: engage vs poke, poke vs peel, peel vs engage."""
    E, P, D = 0, 1, 2
    return np.array([a[E] * b[P] - b[E] * a[P], a[P] * b[D] - b[P] * a[D], a[D] * b[E] - b[D] * a[E]])


# items whose passive applies Grievous Wounds in the engine (game/src/match/itemfx.ts: 3033, 3165, 3075, 6609)
GW_ITEMS = {3033, 3165, 3075, 6609}
HEALER = 7  # champions.json style.sustain at or above this counts as a healer / sustain threat
COUNTER_SLOPE_SD = 1.0  # prior sd of the per-enemy logit slope of a counter item


def counter_items(champs, games):
    """How often LCK players buy a magic resist / armor / anti-heal legendary among their first four, by how many AP /
    AD / healer champions the enemy has (2026 timelines). Rates per role and bucket are shrunk to the role's rate."""
    items = json.loads((ROOT / "game" / "public" / "data" / "items.json").read_text(encoding="utf-8"))
    leg = {int(k): v for k, v in items["items"].items() if v["kind"] == "legendary"}
    cats = {
        "mr": ("ap", lambda i: (leg[i]["stats"].get("mr") or 0) > 0),
        "armor": ("ad", lambda i: (leg[i]["stats"].get("armor") or 0) > 0),
        "antiheal": ("heal", lambda i: i in GW_ITEMS),
    }
    index = json.loads((DATA / "games_lck_2026.json").read_text(encoding="utf-8"))
    obs = []  # (role, {feature: count}, first four legendaries, champion class)
    for e in index["games"]:
        g = games.get(e["game_id"])
        raw_path = DATA / "raw" / f'{e["rpgid"]}.json.gz'
        # only games whose participant order matched the roster (load_gold), so purchases land on the right player
        if not g or "gold" not in g or not raw_path.exists():
            continue
        raw = json.load(gzip.open(raw_path, "rt", encoding="utf-8"))
        bought = defaultdict(list)
        for fr in raw["timeline"]["frames"]:
            for ev in fr["events"]:
                i = ev.get("itemId")
                if ev.get("type") == "ITEM_PURCHASED" and i in leg and i not in bought[ev["participantId"]]:
                    bought[ev["participantId"]].append(i)
        for side in (0, 1):
            foes = [champs[g["champs"][1 - side][r]] for r in ROLES]
            feat = {"ap": sum(1 for c in foes if c["damage"] == "AP"),
                    "ad": sum(1 for c in foes if c["damage"] == "AD"),
                    "heal": sum(1 for c in foes if c["style"].get("sustain", 5) >= HEALER)}
            for i, r in enumerate(ROLES):
                cls = champs[g["champs"][side][r]]["tags"][0]
                obs.append((r, feat, bought[side * 5 + i + 1][:4], cls))
    out = {}
    for cat, (feature, is_cat) in cats.items():
        rates, base, slope, pick, by_class = {}, {}, {}, {}, {}
        for r in ROLES:
            sel = [o for o in obs if o[0] == r]
            x = np.array([o[1][feature] for o in sel], float)
            y = np.array([1.0 if any(is_cat(i) for i in o[2]) else 0.0 for o in sel])
            # logistic in the enemy count with a weak prior on the slope: smooth and monotone, and it carries on past
            # the counts LCK never had (no team fielded 5 AP or 2+ healers)
            a, b = math.log((y.mean() + 1e-3) / (1 - y.mean() + 1e-3)), 0.0
            for _ in range(50):
                p = 1 / (1 + np.exp(-(a + b * x)))
                w = p * (1 - p)
                g_ = np.array([np.sum(p - y), np.sum((p - y) * x) + b / COUNTER_SLOPE_SD ** 2])
                H = np.array([[w.sum() + 1e-6, (w * x).sum()], [(w * x).sum(), (w * x * x).sum() + 1 / COUNTER_SLOPE_SD ** 2]])
                st = np.linalg.solve(H, g_)
                a, b = a - st[0], b - st[1]
                if np.max(np.abs(st)) < 1e-9:
                    break
            rates[r] = [round(float(1 / (1 + math.exp(-(a + b * k)))), 4) for k in range(6)]
            base[r], slope[r] = round(float(y.mean()), 4), round(float(b), 4)
            cnt = Counter(i for o in sel for i in o[2] if is_cat(i))
            pick[r] = [i for i, _ in cnt.most_common(3)]
            print(f"  {cat:8s} {r:7s} base {y.mean():.2f} slope {b:+.2f} by enemy {feature} 0-5: "
                  f"{' '.join(f'{v:.2f}' for v in rates[r])} items {[leg[i]['name'] for i in pick[r]]}")
        # what each champion class buys of that kind in that role (so a marksman does not get a tank item, nor a mid
        # mage a support item), and per class over all roles as the fallback
        by_rc = {}
        for cls in sorted({o[3] for o in obs}):
            cnt = Counter(i for o in obs if o[3] == cls for i in o[2] if is_cat(i))
            by_class[cls] = [i for i, n in cnt.most_common(3) if n >= 3]
            for r in ROLES:
                cnt = Counter(i for o in obs if o[3] == cls and o[0] == r for i in o[2] if is_cat(i))
                lst = [i for i, n in cnt.most_common(3) if n >= 2]
                if lst:
                    by_rc.setdefault(r, {})[cls] = lst
        print(f"  {cat:8s} by class: " + "; ".join(f"{c} {[leg[i]['name'] for i in v]}" for c, v in by_class.items()))
        print(f"  {cat:8s} by role+class: " + "; ".join(f"{r}/{c} {[leg[i]['name'] for i in v]}" for r, d in by_rc.items() for c, v in d.items()))
        out[cat] = {"feature": feature, "base": base, "slope": slope, "rates": rates, "items": pick, "byClass": by_class,
                    "byRoleClass": by_rc}
    out["healer"] = HEALER
    return out


class Layout:
    def __init__(self, games):
        self.teams = sorted({t for g in games.values() for t in g["teams"]})
        self.rc = sorted({(r, g["champs"][s][r]) for g in games.values() for s in (0, 1) for r in ROLES})
        self.pairs = sorted({(r,) + tuple(sorted((g["champs"][0][r], g["champs"][1][r])))
                             for g in games.values() for r in ROLES if g["champs"][0][r] != g["champs"][1][r]})
        i = 0
        self.b0 = i; i += 1
        self.T = {t: i + k for k, t in enumerate(self.teams)}; i += len(self.teams)
        self.C = {x: i + k for k, x in enumerate(self.rc)}; i += len(self.rc)
        self.U = {x: i + k for k, x in enumerate(self.pairs)}; i += len(self.pairs)
        self.comp = i; i += 3
        self.g0 = {r: i + k for k, r in enumerate(ROLES)}; i += 5
        self.gT = {t: i + k for k, t in enumerate(self.teams)}; i += len(self.teams)
        self.G = {x: i + k for k, x in enumerate(self.rc)}; i += len(self.rc)
        self.n = i

    def prior_prec(self, tau_u):
        p = np.zeros(self.n)
        p[self.b0] = 1e-4
        for v in self.T.values(): p[v] = 1 / TAU_T ** 2
        for v in self.C.values(): p[v] = 1 / TAU_C ** 2
        for v in self.U.values(): p[v] = 1 / tau_u ** 2
        p[self.comp:self.comp + 3] = 1 / TAU_COMP ** 2
        for v in self.g0.values(): p[v] = 1e-8
        for v in self.gT.values(): p[v] = 1 / TAU_GT ** 2
        for v in self.G.values(): p[v] = 1 / TAU_G ** 2
        return p


def design(L: Layout, games, gids, comp_z, slope):
    """Win rows (X, y, w) and gold rows (Z, d) for the listed games, as sparse matrices."""
    xr, xc, xv, y, w = [], [], [], [], []
    zr, zc, zv, d = [], [], [], []
    for gid in gids:
        g = games[gid]
        i = len(y)
        cells = [(L.b0, 1.0), (L.T[g["teams"][0]], 1.0), (L.T[g["teams"][1]], -1.0)]
        for r in ROLES:
            c1, c2 = g["champs"][0][r], g["champs"][1][r]
            cells += [(L.C[(r, c1)], 1.0), (L.C[(r, c2)], -1.0)]
            if c1 != c2:
                a, b = sorted((c1, c2))
                cells.append((L.U[(r, a, b)], 1.0 if c1 == a else -1.0))
        for k, v in enumerate(counter_terms(comp_z[gid][0], comp_z[gid][1])):
            cells.append((L.comp + k, float(v)))
        for col, v in cells:
            xr.append(i); xc.append(col); xv.append(v)
        y.append(g["win1"]); w.append(g["w"])
        if "gold" in g:
            for r in ROLES:
                c1, c2 = g["champs"][0][r], g["champs"][1][r]
                j = len(d)
                cells = [(L.g0[r], 1.0), (L.gT[g["teams"][0]], 1.0), (L.gT[g["teams"][1]], -1.0),
                         (L.G[(r, c1)], 1.0), (L.G[(r, c2)], -1.0)]
                if c1 != c2:
                    a, b = sorted((c1, c2))
                    cells.append((L.U[(r, a, b)], (1.0 if c1 == a else -1.0) / slope))
                for col, v in cells:
                    zr.append(j); zc.append(col); zv.append(v)
                d.append(g["gold"][0][r] - g["gold"][1][r])
    X = sp.csr_matrix((xv, (xr, xc)), shape=(len(y), L.n))
    Z = sp.csr_matrix((zv, (zr, zc)), shape=(len(d), L.n))
    return X, np.array(y, float), np.array(w, float), Z, np.array(d, float)


def fit(L, X, y, w, Z, d, sigma, prec, iters=25):
    """Newton steps; the Gaussian part (Z) is constant, so its Hessian is built once."""
    th = np.zeros(L.n)
    ZtZ = (Z.T @ Z) / sigma ** 2
    Ztd = (Z.T @ d) / sigma ** 2
    P = sp.diags(prec)
    H = None
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ th)))
        grad = X.T @ (w * (p - y)) + ZtZ @ th - Ztd + prec * th
        H = (X.T @ sp.diags(w * p * (1 - p)) @ X + ZtZ + P).tocsc()
        step = spla.spsolve(H, grad)
        th -= step
        if np.max(np.abs(step)) < 1e-6:
            break
    return th, H


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tau", type=float, default=0.0, help="matchup prior sd in win logit (default: evidence maximum)")
    ap.add_argument("--cv", type=int, default=0, help="also print k-fold cross validation scores")
    args = ap.parse_args()

    cid, champs = champion_lookup()
    games = load_games(cid)
    load_gold(cid, games)
    slope, side_logit = gold_slope(games)
    print(f"gold slope: {slope * 1000:.3f} win logit per 1,000 team gold at {GOLD_MINUTE}:00 (side term {side_logit:+.3f})")
    comp_z, comp_mean, comp_sd = comp_features(champs, games)
    L = Layout(games)
    gids = sorted(games)
    print(f"parameters {L.n}: teams {len(L.teams)}, role-champions {len(L.rc)}, pairs {len(L.pairs)}")

    # sigma of the lane gold residual: fit once with a guess, then use the residual sd
    X, y, w, Z, d = design(L, games, gids, comp_z, slope)
    sigma = 750.0
    for _ in range(2):
        th, _ = fit(L, X, y, w, Z, d, sigma, L.prior_prec(0.1))
        sigma = float(np.sqrt(np.mean((Z @ th - d) ** 2)))
    print(f"lane gold residual sd: {sigma:.0f}")

    # the matchup prior sd: Laplace evidence over a grid (type-II maximum likelihood) unless --tau is given
    evidence = {}
    for tau in TAU_U_GRID:
        prec = L.prior_prec(tau)
        th, H = fit(L, X, y, w, Z, d, sigma, prec)
        p = np.clip(1 / (1 + np.exp(-(X @ th))), 1e-12, 1 - 1e-12)
        ll = float(np.sum(w * (y * np.log(p) + (1 - y) * np.log(1 - p)))) - float(np.sum((Z @ th - d) ** 2)) / (2 * sigma ** 2)
        lp = -0.5 * float(np.sum(prec * th * th)) + 0.5 * float(np.sum(np.log(prec)))
        evidence[tau] = ll + lp - 0.5 * np.linalg.slogdet(H.toarray())[1]
        print(f"  tau_u {tau:.3f}: log evidence {evidence[tau]:.2f}", flush=True)
    if args.cv:
        # optional check: k-fold cross validation over games (held-out win deviance + gold error / sigma^2)
        order = np.random.default_rng(7).permutation(len(gids))
        folds = [set(order[k::args.cv].tolist()) for k in range(args.cv)]
        for tau in TAU_U_GRID:
            score = 0.0
            for f in folds:
                tr = [gids[i] for i in range(len(gids)) if i not in f]
                te = [gids[i] for i in f]
                Xa, ya, wa, Za, da = design(L, games, tr, comp_z, slope)
                th, _ = fit(L, Xa, ya, wa, Za, da, sigma, L.prior_prec(tau))
                Xb, yb, wb, Zb, db = design(L, games, te, comp_z, slope)
                p = np.clip(1 / (1 + np.exp(-(Xb @ th))), 1e-9, 1 - 1e-9)
                score += float(-2 * np.sum(wb * (yb * np.log(p) + (1 - yb) * np.log(1 - p))))
                score += float(np.sum((Zb @ th - db) ** 2) / sigma ** 2)
            print(f"  cv tau_u {tau:.3f}: held-out score {score:.1f}", flush=True)
    tau_u = args.tau if args.tau else max(evidence, key=evidence.get)
    print(f"matchup prior sd: {tau_u}" + (" (--tau)" if args.tau else " (evidence maximum)"))

    th, H = fit(L, X, y, w, Z, d, sigma, L.prior_prec(tau_u))
    post_sd = np.sqrt(np.diag(np.linalg.inv(H.toarray())))

    # raw records for the screens
    rec = defaultdict(lambda: [0, 0, 0.0, 0])  # n, wins_a, gold sum, n gold
    for g in games.values():
        for r in ROLES:
            c1, c2 = g["champs"][0][r], g["champs"][1][r]
            if c1 == c2:
                continue
            a, b = sorted((c1, c2))
            s_a = 0 if c1 == a else 1
            x = rec[(r, a, b)]
            x[0] += 1
            x[1] += 1 if g["win1"] == (1 if s_a == 0 else 0) else 0
            if "gold" in g:
                x[2] += g["gold"][s_a][r] - g["gold"][1 - s_a][r]
                x[3] += 1

    roles = {r: {} for r in ROLES}
    for key, idx in L.U.items():
        r, a, b = key
        n, wa, gs, ng = rec[key]
        roles[r][f"{a}|{b}"] = [round(float(th[idx]), 4), n, wa, round(gs / ng) if ng else None, ng]
    comp_w = th[L.comp:L.comp + 3]

    ms = np.array([th[i] for i in L.U.values()])
    print(f"pairs {len(ms)}: |m| > 0.05: {int(np.sum(np.abs(ms) > 0.05))}, > 0.1: {int(np.sum(np.abs(ms) > 0.1))}, "
          f"> 0.2: {int(np.sum(np.abs(ms) > 0.2))}; max {np.max(np.abs(ms)):.3f}")
    top = sorted(L.U.items(), key=lambda kv: -abs(th[kv[1]]))[:12]
    for (r, a, b), i in top:
        n, wa, gs, ng = rec[(r, a, b)]
        m = th[i]
        who, vs = (a, b) if m > 0 else (b, a)
        print(f"  {r:7s} {champs[who]['name']} > {champs[vs]['name']}: {abs(m):.3f} logit "
              f"(+{(1 / (1 + math.exp(-abs(m))) - 0.5) * 100:.1f}%p, sd {post_sd[i]:.3f}), LCK {n} games, "
              f"{a} {wa}-{n - wa}, gold14 {('%+d' % round(gs / ng)) if ng else '-'} ({ng})")
    print("comp counter weights (engage>poke, poke>peel, peel>engage):",
          ", ".join(f"{v:+.3f} (sd {post_sd[L.comp + k]:.3f})" for k, v in enumerate(comp_w)))
    print("counter items (first four legendaries, LCK 2026):")
    counters = counter_items(champs, games)

    out = {
        "source": "LCK 2025-26 (Leaguepedia ScoreboardPlayers) + LCK 2026 Riot timelines; scripts/build_matchups.py",
        "games": len(games),
        "goldGames": sum(1 for g in games.values() if "gold" in g),
        "goldMinute": GOLD_MINUTE,
        "goldSlope": slope,
        "goldSigma": round(sigma),
        "tau": tau_u,
        "tauEvidence": {f"{k:g}": round(float(v), 2) for k, v in evidence.items()},
        "roles": roles,
        "comp": {"keys": COMP_KEYS, "mean": [round(float(v), 4) for v in comp_mean],
                 "sd": [round(float(v), 4) for v in comp_sd], "w": [round(float(v), 4) for v in comp_w]},
        "counterItems": counters,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
