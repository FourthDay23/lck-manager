// Money is kept in 만원 (10,000 KRW) everywhere.

export function money(v: number): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(Math.round(v));
  if (a >= 10000) {
    const eok = a / 10000;
    return `${sign}${eok >= 100 ? Math.round(eok) : eok.toFixed(eok >= 10 ? 1 : 2).replace(/\.?0+$/, "")}억`;
  }
  return `${sign}${a.toLocaleString("ko-KR")}만`;
}

export const START_DATE = Date.UTC(2026, 10, 27); // 2026-11-27, day 0
const DAY_MS = 86400000;

export function dateOf(day: number): Date {
  return new Date(START_DATE + day * DAY_MS);
}
export function dayOfDate(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - START_DATE) / DAY_MS);
}
const WD = ["일", "월", "화", "수", "목", "금", "토"];
export function fmtDate(day: number, withYear = true): string {
  const d = dateOf(day);
  const s = `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WD[d.getUTCDay()]})`;
  return withYear ? `${d.getUTCFullYear()}년 ${s}` : s;
}
export function fmtShort(day: number): string {
  const d = dateOf(day);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
export function weekday(day: number): number {
  return dateOf(day).getUTCDay();
}
export function monthKey(day: number): string {
  const d = dateOf(day);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function dayOfMonth(day: number): number {
  return dateOf(day).getUTCDate();
}
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
/**
 * Attach the right Korean particle to a word: 이/가, 을/를, 과/와, (으)로, 은/는.
 * Hangul uses the final consonant. Latin names use how the last letter is read (L, M, N end in a consonant sound,
 * as in BRION), digits likewise (T1 = 티원 → 이).
 */
export function josa(word: string, pair: "이가" | "을를" | "과와" | "으로" | "은는"): string {
  const w = word.replace(/[)\]'"]+$/, "");
  const ch = w.charCodeAt(w.length - 1);
  let batchim = false, rieul = false;
  if (ch >= 0xac00 && ch <= 0xd7a3) {
    const jong = (ch - 0xac00) % 28;
    batchim = jong > 0;
    rieul = jong === 8;
  } else if (/[0-9]$/.test(w)) {
    batchim = /[013678]$/.test(w);
    rieul = /[178]$/.test(w);
  } else if (/[lmnLMN]$/.test(w)) {
    batchim = true;
    rieul = /[lL]$/.test(w);
  }
  if (pair === "으로") return word + (batchim && !rieul ? "으로" : "로");
  const [a, b] = pair === "이가" ? ["이", "가"] : pair === "을를" ? ["을", "를"] : pair === "과와" ? ["과", "와"] : ["은", "는"];
  return word + (batchim ? a : b);
}

/** Verbal probability band, the way 1in8b shows odds instead of numbers. */
export function oddsWord(p: number): string {
  if (p >= 0.85) return "확실한 편";
  if (p >= 0.65) return "높은 편";
  if (p >= 0.45) return "반반";
  if (p >= 0.25) return "낮은 편";
  return "희박";
}
