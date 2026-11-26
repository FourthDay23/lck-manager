// Every change to the user's cash goes through earn/spend so the monthly ledger shows it.
import { monthKey } from "./format";
import type { GameState, LedgerMonth } from "./types";

export function ledger(s: GameState): LedgerMonth {
  const m = monthKey(s.day);
  let l = s.ledger.find((x) => x.month === m);
  if (!l) {
    l = { month: m, income: {}, expense: {} };
    s.ledger.unshift(l);
    if (s.ledger.length > 36) s.ledger.length = 36;
  }
  return l;
}

export function earn(s: GameState, key: string, amount: number) {
  if (!amount) return;
  s.teams[s.user].cash += amount;
  const l = ledger(s);
  l.income[key] = (l.income[key] ?? 0) + amount;
}

export function spend(s: GameState, key: string, amount: number) {
  if (!amount) return;
  s.teams[s.user].cash -= amount;
  const l = ledger(s);
  l.expense[key] = (l.expense[key] ?? 0) + amount;
}

/** Cash move for any team: goes through the ledger when it is the user's. */
export function teamCash(s: GameState, teamId: string, key: string, amount: number) {
  if (teamId === s.user) {
    if (amount >= 0) earn(s, key, amount);
    else spend(s, key, -amount);
  } else if (s.teams[teamId]) s.teams[teamId].cash += amount;
}

/** Monthly wage bill of the user's club (players + staff), 만원. */
export function monthlyWages(s: GameState): number {
  const t = s.teams[s.user];
  let sum = 0;
  for (const id of [...t.roster, ...(t.academy ?? [])]) sum += s.players[id]?.contract?.salary ?? 0;
  for (const id of t.staff) sum += s.staff[id]?.contract?.salary ?? 0;
  return Math.round(sum / 12);
}
