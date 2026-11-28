// Staff portraits: the same 12x12 pixel format as a player's (components.tsx avatarUrl), drawn from the coach's id,
// so every save, old ones included, has them. The face is fixed by the id; the clothes take his club's colors:
// a head coach wears a dark suit with a tie in the team color, a coach the team jacket over a white shirt.
import { hash32 } from "../core/rng";
import { S } from "../store";
import { SKIN } from "./components";

/** More grey than the players' palette: coaches are older. */
const HAIR = ["#1b1b1f", "#2b1d14", "#3b2a1d", "#14141a", "#5a3a20", "#6e6e78", "#a0a0a8", "#c9c9cf"];
const SUIT = "#2e3347", LAPEL = "#424964", SHIRT = "#e8ecf5";

/** relative luminance of a #rrggbb color (anything else counts as bright, so it is used as it is) */
function lum(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 1;
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

const cache = new Map<string, string>();

/** Deterministic 12x12 pixel portrait of a coach. `head`: the head coach's suit. `bare`: no background square. */
export function staffAvatarUrl(id: string, c1: string, c2: string, head: boolean, bare = false): string {
  const key = `${id}|${c1}|${c2}|${head ? 1 : 0}|${bare ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = 12; cv.height = 12;
  const g = cv.getContext("2d")!;
  // prefixed like staffPersona, so a coach never shares a face with a player of the same id
  const h = hash32("staff:" + id);
  const skin = SKIN[h % SKIN.length], hair = HAIR[(h >> 4) % HAIR.length];
  const style = (h >> 8) % 4;
  if (!bare) { g.fillStyle = "#141826"; g.fillRect(0, 0, 12, 12); }
  if (head) {
    // dark suit, white collar, a tie in the team color (a near-black color would vanish on the suit)
    const tie = lum(c1) >= 0.03 ? c1 : lum(c2) >= 0.03 ? c2 : "#f2c14e";
    g.fillStyle = SUIT; g.fillRect(1, 9, 10, 3);
    g.fillStyle = LAPEL; g.fillRect(4, 10, 1, 1); g.fillRect(7, 10, 1, 1);
    g.fillStyle = SHIRT; g.fillRect(4, 9, 1, 1); g.fillRect(7, 9, 1, 1);
    g.fillStyle = tie; g.fillRect(5, 9, 2, 3);
  } else {
    // team jacket open over a white shirt
    g.fillStyle = c1; g.fillRect(1, 9, 10, 3);
    g.fillStyle = SHIRT; g.fillRect(4, 9, 4, 1); g.fillRect(5, 10, 2, 1);
    g.fillStyle = c2; g.fillRect(5, 11, 2, 1);
  }
  g.fillStyle = skin; g.fillRect(3, 3, 6, 6);
  g.fillStyle = hair;
  if (style === 2) {
    // bald on top, hair left on the sides
    g.fillStyle = skin; g.fillRect(4, 2, 4, 1);
    g.fillStyle = hair; g.fillRect(2, 3, 1, 3); g.fillRect(9, 3, 1, 3);
  } else {
    g.fillRect(3, 2, 6, 2);
    if (style === 0) { g.fillRect(2, 3, 1, 2); g.fillRect(9, 3, 1, 2); }
    if (style === 1) { g.fillRect(3, 4, 2, 1); }
    if (style === 3) { g.fillRect(4, 1, 4, 1); }
  }
  g.fillStyle = "#101014"; g.fillRect(4, 5, 1, 1); g.fillRect(7, 5, 1, 1);
  if ((h >> 12) % 2 === 0) { g.fillStyle = "#222"; g.fillRect(3, 5, 6, 1); g.fillStyle = "#88c"; g.fillRect(4, 5, 1, 1); g.fillRect(7, 5, 1, 1); }
  const beard = (h >> 14) % 4;
  if (beard === 0) {
    // full beard around the mouth
    g.fillStyle = hair; g.fillRect(3, 7, 1, 1); g.fillRect(8, 7, 1, 1); g.fillRect(4, 8, 4, 1);
    g.fillStyle = "#b56a5a"; g.fillRect(5, 7, 2, 1);
  } else if (beard === 1) {
    // moustache
    g.fillStyle = hair; g.fillRect(4, 7, 4, 1);
  } else {
    g.fillStyle = "#b56a5a"; g.fillRect(5, 7, 2, 1);
  }
  const url = cv.toDataURL();
  cache.set(key, url);
  return url;
}

/** A coach's portrait in his club's colors (free agents in grey), like `Avatar` for a player. `inline`: sits in a line of text. */
export function StaffAvatar({ sid, size = 36, bare, inline }: { sid: string; size?: number; bare?: boolean; inline?: boolean }) {
  const s = S();
  const st = s.staff[sid];
  const t = st?.team ? s.teams[st.team] : null;
  // a free agent's grey is a shade lighter than a player's, so his tie still shows on the dark suit
  const url = staffAvatarUrl(sid, t?.colors[0] ?? "#5b6486", t?.colors[1] ?? "#1b1f2e", st?.role === "Head Coach", bare);
  return <img class="avatar" src={url} width={size} height={size} alt="" style={inline ? { verticalAlign: "middle", margin: "0 3px" } : undefined} />;
}
