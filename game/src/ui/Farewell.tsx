// The thank-you card for a player leaving the user's club (core/farewell.ts queues it as a "farewell" cutscene,
// Overlays.tsx CutsceneLayer shows it). A commemorative card in the club's colour over a dark arena whose crowd
// holds up light sticks in that colour: who he was, how long he stayed, what he did for us, where he goes.
import { useEffect, useRef } from "preact/hooks";
import { D, S } from "../store";
import { ROLE_KO } from "../data/types";
import type { Cutscene, Farewell } from "../core/types";
import { avatarUrl, ChampIcon, TeamLogo, TrophyArt } from "./components";
import { useOnScreen } from "./onScreen";
import "./farewell.css";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- colour ----------
function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: [number, number, number]) {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const hex = (c: [number, number, number]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** The club colour that reads on the dark card: its first colour, else its second, lifted toward white until bright enough. */
export function clubAccent(colors: [string, string]): string {
  const pick = colors.map(rgb).find((c) => luminance(c) > 0.04) ?? rgb("#f2c14e");
  let c = pick;
  for (let i = 0; i < 8 && luminance(c) < 0.16; i++) c = c.map((v) => v + (255 - v) * 0.18) as [number, number, number];
  return hex(c);
}
const rgba = (h: string, a: number) => `rgba(${rgb(h).join(", ")}, ${a})`;

// ---------- words ----------
const HOW: Record<Farewell["how"], { tag: string; msg: string }> = {
  transfer: { tag: "이적", msg: "어디서든 당신의 플레이를 응원하겠습니다." },
  release: { tag: "방출", msg: "함께해 준 모든 순간에 감사합니다." },
  expire: { tag: "계약 만료", msg: "다음 무대에서도 빛나길 바랍니다." },
  retire: { tag: "현역 은퇴", msg: "선수로서 보낸 모든 날, 정말 수고 많았습니다." },
  military: { tag: "군 입대", msg: "건강하게 다녀오세요. 기다리겠습니다." },
};

function yearsLine(f: Farewell): string {
  if (f.until <= f.since) return `${f.since} 시즌을 함께`;
  return `${f.since} – ${f.until} · ${f.until - f.since + 1}시즌을 함께`;
}

// ---------- the crowd ----------
/** Rows of pixel light sticks in the club colour swaying at the bottom of the screen (still under reduced motion). */
function LightSticks({ color }: { color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const g = cv.getContext("2d")!;
    const PX = 3; // one canvas pixel = 3 CSS px
    let W = 0, H = 0, raf = 0;
    type Stick = { x: number; row: number; ph: number; sp: number; white: boolean };
    let sticks: Stick[] = [];
    // far to near: height of the light above the bottom, light size, brightness, sway, spacing (canvas pixels)
    const ROWS = [
      { y: 30, s: 1, a: 0.16, amp: 0.6, gap: 3 },
      { y: 24, s: 1, a: 0.28, amp: 0.8, gap: 4 },
      { y: 17, s: 2, a: 0.45, amp: 1, gap: 5 },
      { y: 10, s: 2, a: 0.7, amp: 1.4, gap: 6 },
      { y: 4, s: 3, a: 1, amp: 2, gap: 8 },
    ];
    const size = () => {
      W = Math.max(40, Math.ceil(cv.clientWidth / PX));
      H = Math.max(20, Math.ceil(cv.clientHeight / PX));
      cv.width = W;
      cv.height = H;
      sticks = [];
      ROWS.forEach((r, row) => {
        for (let x = (row * 5) % r.gap; x < W; x += r.gap + ((x * 7 + row) % 2)) {
          sticks.push({ x, row, ph: (x * 0.37 + row * 1.3) % 6.28, sp: 0.0014 + ((x * 13 + row) % 7) * 0.00012, white: (x * 31 + row * 7) % 11 === 0 });
        }
      });
    };
    const draw = (t: number) => {
      g.clearRect(0, 0, W, H);
      for (const s of sticks) {
        const r = ROWS[s.row];
        const sway = Math.round(Math.sin(t * s.sp + s.ph) * r.amp);
        const bob = Math.round((Math.sin(t * s.sp * 1.7 + s.ph) + 1) * 0.5);
        const hx = s.x + sway, hy = H - r.y - r.s - bob;
        g.fillStyle = s.white ? "#ffffff" : color;
        g.globalAlpha = r.a * 0.22;
        g.fillRect(hx - 1, hy - 1, r.s + 2, r.s + 2); // glow
        g.globalAlpha = r.a;
        g.fillRect(hx, hy, r.s, r.s); // light
        g.globalAlpha = Math.min(1, r.a + 0.2);
        g.fillStyle = "#262b40";
        g.fillRect(hx + (r.s > 1 ? 1 : 0), hy + r.s, 1, r.s + 2); // handle
      }
      g.globalAlpha = 1;
    };
    size();
    const still = reducedMotion();
    const tick = (t: number) => {
      draw(t);
      if (!still) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // measured by an observer, not once: the layer is resized to the visible screen (useOnScreen) only after this
    // effect has run, and again when a phone turns or zooms
    const onResize = () => {
      if (Math.ceil(cv.clientWidth / PX) === W && Math.ceil(cv.clientHeight / PX) === H) return;
      size();
      if (still) draw(0);
    };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    ro?.observe(cv);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [color]);
  return <canvas ref={ref} class="fw-crowd px" aria-hidden="true" />;
}

// ---------- the card ----------
export function FarewellCard({ c, next }: { c: Cutscene; next: () => void }) {
  const s = S();
  const f = c.farewell!;
  const p = s.players[c.player!];
  const club = s.teams[c.team ?? s.user];
  const accent = clubAccent(club.colors);
  const how = HOW[f.how] ?? HOW.release;
  const to = f.how === "transfer" && f.to ? s.teams[f.to] : null;
  const champ = f.champ ? D().champ.get(f.champ) : undefined;
  const bg = useOnScreen();

  // Enter / Space / Esc go on too; the layer takes focus so the keys reach it
  useEffect(() => bg.current?.focus({ preventScroll: true }), []);
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || !["Enter", " ", "Escape"].includes(e.key)) return;
    e.preventDefault();
    next();
  };

  const stats: { k: string; v: string }[] = f.g
    ? [
        { k: "경기", v: String(f.g) },
        { k: "승률", v: `${Math.round((f.w / f.g) * 100)}%` },
        { k: "KDA", v: ((f.k + f.a) / Math.max(1, f.d)).toFixed(1) },
        { k: "MVP", v: String(f.mvp) },
      ]
    : [];

  return (
    <div
      ref={bg}
      class="fw"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={c.title}
      style={{ "--acc": accent, "--g1": rgba(accent, 0.1), "--g2": rgba(accent, 0.06), "--g3": rgba(accent, 0.03), "--c2": club.colors[1] } as Record<string, string>}
      onClick={next}
      onKeyDown={onKey}
    >
      <div class="fw-sky" />
      <LightSticks color={accent} />
      <div class="fw-card">
        <div class="fw-top">
          <TeamLogo id={club.id} size={22} />
          <span class="fw-club">{club.name}</span>
          <span class="fw-tag">{how.tag}{f.how === "release" && f.why ? ` · ${f.why}` : ""}</span>
        </div>

        <div class="fw-hero">
          <div class="fw-portrait">
            <div class="fw-stripes" />
            {/* in our colours one last time, whatever shirt he has on now */}
            <img class="avatar" src={avatarUrl(p.id, club.colors[0], club.colors[1], true)} width={128} height={128} alt="" />
            <span class="fw-role">{ROLE_KO[p.role]}</span>
          </div>
          <div class="fw-words">
            <div class="fw-thanks">Thank you,</div>
            <div class="fw-name">{p.name}</div>
            {p.realName && p.realName !== p.name && <div class="fw-real">{p.realName}</div>}
            <div class="fw-years">{yearsLine(f)}</div>
          </div>
        </div>

        <p class="fw-msg">
          <span>{how.msg}</span>
          <span class="fw-sign">— {club.short}</span>
        </p>

        {stats.length ? (
          <div class="fw-stats">
            {stats.map((x, i) => (
              <div class="fw-stat" style={{ "--i": i } as Record<string, number>}>
                <b>{x.v}</b>
                <span>{x.k}</span>
              </div>
            ))}
            {champ && (
              <div class="fw-stat champ" style={{ "--i": stats.length } as Record<string, number>} title={champ.name}>
                <ChampIcon id={champ.id} size={28} />
                <span>{champ.name}</span>
              </div>
            )}
          </div>
        ) : (
          <div class="fw-none">우리 팀에서 뛴 공식 경기는 없습니다</div>
        )}

        {f.titles.length > 0 && (
          <ul class="fw-titles" aria-label="함께한 우승">
            {f.titles.map((t) => (
              <li>
                <TrophyArt comp={t.comp} scale={2} />
                <span>{t.name}{t.comp === "REG" ? "" : " 우승"}</span>
              </li>
            ))}
          </ul>
        )}

        {to && (
          <div class="fw-dest">
            <span class="fw-dest-k">새 팀</span>
            <span class="fw-arrow" aria-hidden="true">▶</span>
            <TeamLogo id={to.id} size={20} />
            <span>{to.name}</span>
          </div>
        )}
      </div>
      <div class="fw-hint">클릭해서 계속</div>
    </div>
  );
}
