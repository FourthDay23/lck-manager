// The thank-you card shown when a player leaves the user's club (released, sold, traded, contract over, retired,
// military service). market.ts removeFromTeam queues it; joinTeam / releasePlayer then say how he left.
import type { Cutscene, Farewell, GameState, Player } from "./types";

/** What he did with the user's club, read from the box scores of our series and the club's trophies. */
export function farewellOf(s: GameState, p: Player): Farewell {
  const us = s.teams[s.user];
  // his last spell with us starts at the last "입단" line for our club (joinTeam writes it); players who were here
  // when the career began have none, so their first game for us stands in
  let since = 0;
  for (const h of p.history) {
    const m = /^(\d+): (.+) 입단$/.exec(h);
    if (m && m[2] === us.name) since = Number(m[1]);
  }
  const line = { g: 0, w: 0, k: 0, d: 0, a: 0, mvp: 0 };
  const champs = new Map<string, number>();
  let first = Infinity;
  for (const sr of s.series) {
    if (sr.a !== s.user && sr.b !== s.user) continue;
    if (since && sr.season < since) continue;
    for (const g of sr.games) {
      const b = g.box?.[p.id];
      if (!b) continue;
      // the box has both sides: count only games he played on our side (his champion is among our picks)
      const ours = g.blue === s.user ? g.picks.blue : g.red === s.user ? g.picks.red : null;
      if (!ours || !ours.includes(b.champ)) continue;
      line.g++;
      if (g.winner === s.user) line.w++;
      line.k += b.k;
      line.d += b.d;
      line.a += b.a;
      if (g.mvp === p.id) line.mvp++;
      champs.set(b.champ, (champs.get(b.champ) ?? 0) + 1);
      first = Math.min(first, sr.season);
    }
  }
  if (!since) since = Number.isFinite(first) ? first : s.season;
  const champ = [...champs].sort((x, y) => y[1] - x[1])[0]?.[0];
  const titles = s.trophies
    .filter((t) => t.season >= since && t.roster.some((r) => r.name === p.name))
    .map((t) => ({ comp: t.comp, name: t.name }));
  return { how: "release", since, until: Math.max(since, s.season), ...line, champ, titles };
}

/** Queue the card for a player who is leaving our main roster (not the 2군), before he is taken off it. */
export function queueFarewell(s: GameState, p: Player): Cutscene | undefined {
  if (!p.team || p.team !== s.user || p.academy || !s.teams[s.user]?.roster.includes(p.id)) return undefined;
  const c: Cutscene = { kind: "farewell", title: `Thank you, ${p.name}`, player: p.id, team: s.user, farewell: farewellOf(s, p) };
  s.cutscenes.push(c);
  return c;
}

/** How a release reason reads on the card (core/market.ts releasePlayer callers). */
export function farewellHow(reason: string): Pick<Farewell, "how" | "why"> {
  if (reason === "은퇴") return { how: "retire" };
  if (reason === "입대") return { how: "military" };
  if (reason === "계약 만료") return { how: "expire" };
  return { how: "release", why: reason };
}
