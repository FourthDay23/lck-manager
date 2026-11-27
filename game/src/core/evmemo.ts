// Event memory helpers with no game-system imports, so market.ts and the UI can read them without import cycles.
import type { EvMemo, EvState, GameState, Player } from "./types";

export function newEvState(day: number): EvState {
  return { week: { start: weekStartOf(day), n: 0 }, recent: [], cd: {}, lastMorale: -99, queue: [], promises: [], memo: {} };
}

export function evState(s: GameState): EvState {
  if (!s.ev) s.ev = newEvState(s.day);
  return s.ev;
}

/** Monday of the week the day falls in (day 0 = 2026-11-27, a Friday). */
export function weekStartOf(day: number): number {
  // weekday(day) = (day + 5) % 7 with 0 = Sunday, so days since Monday = (day + 4) % 7
  return day - (((day + 4) % 7) + 7) % 7;
}

export function memoOf(s: GameState, key: string): EvMemo[] {
  return s.ev?.memo[key] ?? [];
}

export function addMemo(s: GameState, key: string, m: EvMemo) {
  const ev = evState(s);
  const list = (ev.memo[key] ??= []);
  list.push(m);
  // keep 30: the plain log lines ("기록") go first so a promise or a grudge is not pushed out by them
  while (list.length > 30) {
    const i = list.findIndex((x) => x.tag === "기록");
    list.splice(i >= 0 ? i : 0, 1);
  }
}

/** Has this tag within the last `days` days (and, if given, about this other person). */
export function hasMemo(s: GameState, key: string, tag: string, days = 9999, other?: string): boolean {
  return memoOf(s, key).some((m) => m.tag === tag && s.day - m.day <= days && (other === undefined || m.other === other));
}

export function countMemo(s: GameState, key: string, tag: string, days = 9999): number {
  return memoOf(s, key).filter((m) => m.tag === tag && s.day - m.day <= days).length;
}

export function dropMemo(s: GameState, key: string, tag: string) {
  const list = s.ev?.memo[key];
  if (list) s.ev!.memo[key] = list.filter((m) => m.tag !== tag);
}

/** Renewal ask multiplier from the player's memory: a broken promise, an early or promised raise. */
export function eventAskMul(s: GameState, p: Player): number {
  let mul = 1;
  if (hasMemo(s, p.id, "배신", 365)) mul *= 1.1;
  if (hasMemo(s, p.id, "조기재계약", 60)) mul *= 1.05;
  if (hasMemo(s, p.id, "반영약속", 365)) mul *= 1.05;
  return mul;
}

/** "징계", "부상", "휴가" or "휴식" while he is out. */
export function outLabel(p: Player): string {
  return p.outWhy ?? "징계";
}
