// Korean name search with initial consonants (초성): "ㄹㅅ" finds 리 신, "ㄱㄹㅇ" finds 갈리오, and the two mix
// ("리ㅅ"). Spaces and case are ignored on both sides, so it serves English names too ("leesin" = Lee Sin).

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const SYL_FIRST = 0xac00, SYL_LAST = 0xd7a3;

/** a plain consonant typed also finds its tense pair (ㅅ finds 쓰레쉬); a tense one only itself */
const TENSE: Record<string, string> = { ㄱ: "ㄲ", ㄷ: "ㄸ", ㅂ: "ㅃ", ㅅ: "ㅆ", ㅈ: "ㅉ" };

/** the initial consonant of a Hangul syllable, or the character itself */
function initial(ch: string): string {
  const c = ch.charCodeAt(0);
  return c >= SYL_FIRST && c <= SYL_LAST ? CHO[Math.floor((c - SYL_FIRST) / 588)] : ch;
}
function initialMatch(qc: string, tc: string): boolean {
  if (!CHO.includes(qc)) return false;
  const i = initial(tc);
  return i === qc || TENSE[qc] === i;
}

/** A syllable with no final consonant, typed last, may still be getting one: "가" (on the way to "갈") matches 갈. */
function openPrefix(qc: string, tc: string): boolean {
  const a = qc.charCodeAt(0) - SYL_FIRST, b = tc.charCodeAt(0) - SYL_FIRST;
  if (a < 0 || b < 0 || a > SYL_LAST - SYL_FIRST || b > SYL_LAST - SYL_FIRST || a % 28 !== 0) return false;
  return Math.floor(a / 28) === Math.floor(b / 28);
}

/** How well `query` finds `text`, where a lone initial consonant in the query stands for any syllable that starts with
 *  it (case and spaces ignored): 0 the whole name (ㄹㅅ = 리 신), 1 its start (ㄹㅅ = 리산드라), 2 inside it
 *  (ㄹㅅ = 알리스타), -1 not at all. For sorting search results best first. */
export function searchRank(text: string, query: string): number {
  const t = [...text.replace(/\s+/g, "").toLowerCase()];
  const q = [...query.replace(/\s+/g, "").toLowerCase()];
  if (!q.length) return 0;
  for (let i = 0; i + q.length <= t.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length && ok; j++) {
      const qc = q[j], tc = t[i + j];
      ok = qc === tc || initialMatch(qc, tc) || (j === q.length - 1 && openPrefix(qc, tc));
    }
    if (ok) return i > 0 ? 2 : q.length === t.length ? 0 : 1;
  }
  return -1;
}
