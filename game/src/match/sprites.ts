// Map sprites of the match view: jungle camps, epic monsters and structures (public/assets/map, made by
// scripts/build_map_sprites.py from the owner's pixel art). Every file is already the size it is drawn at, in two
// sizes: <name>.png for the whole map and <name>_2x.png for close-ups. The renderer puts them on whole canvas pixels
// without scaling, so a sprite pixel is a canvas pixel and stays square at any map size or screen scale.

/** Dragon types as the engine names them -> the element in the file names (same as the scoreboard's icons). */
const ELEMENT: Record<string, string> = {
  화염: "fire", 대지: "earth", 바다: "water", 바람: "air", 화학공학: "chemtech", 마법공학: "hextech", 장로: "elder",
};
/**
 * Sprite of a dragon of this type ("장로" for the elder dragon); "" for a type the table does not know, which the
 * renderer draws as its stand-in disc rather than as a dragon of some other element.
 */
export const drakeSprite = (type: string | undefined) => (ELEMENT[type ?? ""] ? `drake_${ELEMENT[type!]}` : "");

export interface MapSprite {
  /** the sprite; null until the file has loaded (or if it never does) */
  on: CanvasImageSource | null;
  /** the same sprite dimmed and greyed: a camp that was cleared, a monster that is not up yet */
  off: CanvasImageSource | null;
  w: number;
  h: number;
}

const cache = new Map<string, MapSprite>();

/** Grey, darker and a little see-through, the outline kept: reads as "not there now" next to the live sprite. */
function dimmed(img: HTMLImageElement): CanvasImageSource | null {
  try {
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const c = cv.getContext("2d")!;
    c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, cv.width, cv.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      if (!p[i + 3]) continue;
      const l = p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11;
      // toward a slate grey, at 70 % of the brightness
      p[i] = (l * 0.85 + p[i] * 0.15) * 0.62 + 18;
      p[i + 1] = (l * 0.85 + p[i + 1] * 0.15) * 0.62 + 20;
      p[i + 2] = (l * 0.85 + p[i + 2] * 0.15) * 0.62 + 26;
      p[i + 3] = p[i + 3] * 0.8;
    }
    c.putImageData(d, 0, 0);
    return cv;
  } catch {
    return null; // a canvas the page may not read (should not happen for same-origin files): the live sprite is used, see-through
  }
}

/** The sprite `name` at the whole-map size, or the close-up size when `big`. Starts loading on the first call. */
export function mapSprite(name: string, big: boolean): MapSprite {
  const key = big ? `${name}_2x` : name;
  let s = cache.get(key);
  if (!s) {
    s = { on: null, off: null, w: 0, h: 0 };
    cache.set(key, s);
    const sp = s;
    const img = new Image();
    img.onload = () => {
      sp.w = img.naturalWidth;
      sp.h = img.naturalHeight;
      sp.off = dimmed(img);
      sp.on = img;
    };
    // a file that did not arrive (the connection dropped) is asked for again later, not on every frame
    img.onerror = () => { setTimeout(() => { if (cache.get(key) === sp) cache.delete(key); }, 15000); };
    img.src = `assets/map/${key}.png`;
  }
  return s;
}

/** Every sprite the map can show, so they are loaded before the first one is needed. */
export function preloadMapSprites() {
  const names = ["baron", "herald", "grub", "camp_buff", "camp_small"];
  for (const el of Object.values(ELEMENT)) names.push(`drake_${el}`);
  for (const kind of ["turret", "inhibitor", "nexus"]) for (const side of ["blue", "red"]) names.push(`${kind}_${side}`, `${kind}_${side}_destroyed`);
  for (const n of names) { mapSprite(n, false); mapSprite(n, true); }
}
