import { useEffect, useRef, useState } from "preact/hooks";
import { S, store, useStore } from "../store";
import { resolveEvent } from "../core/game";
import { eventInfo } from "../core/events";
import { acceptSale, acceptTradeOffer } from "../core/market";
import { ovr } from "../core/player";
import { Avatar, Ovr, TeamLogo, TrophyArt } from "./components";
import { autosave } from "./App";
import { useOnScreen } from "./onScreen";
import { FarewellCard } from "./Farewell";
import { ROLE_KO } from "../data/types";
import { money } from "../core/format";
import "./alerts.css";
import "./event.css";

// ---------- choice events (core/events.ts) ----------
// A small pixel stage lit in the event's colour (red: trouble, gold: good news) with the players involved standing on
// it, a dialogue box whose text types out, and the options with a ▶ cursor. The result card lists what changed, each
// change marked good or bad.

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The kicker over the title: what kind of event this is. */
function kickerOf(info: ReturnType<typeof eventInfo>): string {
  if (!info) return "구단 소식";
  if (info.cls === "morale") return "사기 저하";
  if (info.cls === "after") return "지난 선택 그 후";
  return info.pol === "pos" ? "좋은 소식" : "돌발 상황";
}

/** Option hints are worded by chance (core/events.ts): "~할 거예요" 70%+, "~할 수도 있어요" 20-69%; a fixed note ends with a full stop. */
function hintKind(h: string): "sure" | "maybe" | "note" {
  const t = h.trim();
  if (/[.!?]$/.test(t)) return "note";
  return /수도 있어요$/.test(t) ? "maybe" : "sure";
}

/** Text that types out once per event (about 0.7 s at most); a click shows it all. The rest is laid out but hidden so nothing moves. */
function useTyped(text: string): [string, string, () => void] {
  const chars = Array.from(text); // by code point, so a typed-out emoji is never cut in half
  const len = chars.length;
  const [n, setN] = useState(() => (reducedMotion() ? len : 0));
  useEffect(() => {
    if (n >= len) return;
    const dur = Math.min(700, len * 22);
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(len, Math.ceil(((now - t0) / dur) * len));
      setN(k);
      if (k < len) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return [chars.slice(0, n).join(""), chars.slice(n).join(""), () => setN(len)];
}

function moraleClass(v: number) {
  return v < 40 ? "lo" : v < 60 ? "mid" : "hi";
}

function CastMember({ pid }: { pid: string }) {
  const p = S().players[pid];
  if (!p) return null;
  const m = Math.round(p.morale);
  return (
    <div class="evd-fig">
      <div class="evd-fig-art"><Avatar pid={p.id} size={84} bare /></div>
      <div class="evd-plate">
        <div class="evd-plate-top"><b>{p.name}</b><Ovr v={ovr(p)} /></div>
        <div class="evd-plate-sub">
          <span>{ROLE_KO[p.role]}</span>
          <span class={`evd-mor ${moraleClass(m)}`} title="사기">사기 {m}</span>
        </div>
      </div>
    </div>
  );
}

export function EventModal() {
  const s = S();
  const ev = s.events[0];
  if (!ev) return null;
  // keyed by event so the typing and the entrance start over for the next one
  return <EventCard key={ev.id} />;
}

function EventCard() {
  const s = S();
  const ev = s.events[0];
  const info = eventInfo(ev.def);
  const tone = info ? info.pol : "neu";
  const [shown, rest, finish] = useTyped(ev.body);
  const cash = s.teams[s.user].cash;
  const cast = [ev.player, ev.other].filter((id): id is string => !!id && !!s.players[id]);
  const waiting = s.events.length - 1;
  const bg = useOnScreen();

  // The dialog itself takes focus (not an option, so a stray Enter does not choose); ↑↓ then move between the options
  // and Enter / Space choose, as on any button.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const at = document.activeElement;
      if (at && at !== document.body && !box.current?.contains(at)) return;
      const btns = [...document.querySelectorAll<HTMLButtonElement>(".evd-opt:not(:disabled)")];
      if (!btns.length) return;
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const down = e.key === "ArrowDown";
      const j = i < 0 ? (down ? 0 : btns.length - 1) : (i + (down ? 1 : -1) + btns.length) % btns.length;
      btns[j].focus();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (i: number) => {
    resolveEvent(s, ev.id, i);
    autosave();
    store.bump();
  };

  return (
    <div class="evd-bg" ref={bg}>
      <div ref={box} tabIndex={-1} class={`evd frame ${tone}`} role="dialog" aria-modal="true" aria-labelledby="evd-title">
        <div class="evd-stage">
          <div class="evd-floor" />
          <div class="evd-caption">
            <div class="evd-tags">
              <span class="evd-kicker">{kickerOf(info)}</span>
              {info?.matchDay && <span class="evd-tag">경기 날 아침</span>}
              {waiting > 0 && <span class="evd-wait">다음 {waiting}건</span>}
            </div>
            <h1 id="evd-title" class="evd-title">{ev.title}</h1>
          </div>
          <div class="evd-cast">
            {cast.length ? cast.map((id) => <CastMember pid={id} />) : (
              <div class="evd-fig">
                <div class="evd-fig-art team"><TeamLogo id={s.user} size={72} /></div>
                <div class="evd-plate"><div class="evd-plate-top"><b>{s.teams[s.user].short}</b></div><div class="evd-plate-sub"><span>구단 전체</span></div></div>
              </div>
            )}
          </div>
        </div>

        <div class={`evd-say ${rest ? "" : "done"}`} onClick={finish}>
          <span class="evd-sr">{ev.body}</span>
          <span aria-hidden="true">{shown}<span class="evd-rest">{rest}</span></span>
        </div>

        <div class="evd-ask">어떻게 할까요?</div>
        <div class="evd-opts">
          {ev.options.map((o, i) => {
            const short = o.cost !== undefined && o.cost > cash;
            return (
              // ev-opt stays as a hook for demo / test scripts that click the first option
              <button class="evd-opt ev-opt" style={{ "--i": i } as Record<string, number>} disabled={o.disabled} onClick={() => choose(i)}>
                <span class="evd-cur" aria-hidden="true">▶</span>
                <span class="evd-opt-main">
                  <span class="evd-opt-label">{o.label}</span>
                  <span class="evd-hints">
                    {ev.def
                      ? (o.hints ?? []).map((h) => <span class={`evd-hint ${hintKind(h)}`}>{h}</span>)
                      : o.desc && <span class="evd-hint note">{o.desc}</span>}
                    {short && <span class="evd-hint lock">자금이 모자랍니다</span>}
                  </span>
                </span>
                <span class="evd-side">
                  {o.disabled && !short && <span class="evd-lock">선택 불가</span>}
                  {o.cost ? <span class={`evd-cost ${short ? "short" : ""}`}>-{money(o.cost)}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** A result line "Ruler 사기 +8" / "자금 -4,000만" / "팬 +2% (+1,234명)" split into what changed and by how much; fatigue going up is the bad way. */
const DELTA = /^(.*\S)\s([+-][\d,.]+(?:억|만|%)?)(\s*\(.*\))?$/;
function parseLine(l: string): { text: string; val?: string; extra?: string; good?: boolean } {
  const m = DELTA.exec(l);
  if (!m) return { text: l };
  const [, label, val, extra] = m;
  const up = val.startsWith("+");
  return { text: label, val, extra: extra?.trim(), good: /피로$/.test(label) ? !up : up };
}

/** What the last choice did. Shown until confirmed; may open a follow-up screen (renewal talk). */
export function EventResultModal() {
  const r = S().ev?.result;
  if (!r || !r.title) return null;
  return <ResultCard key={r.title} />;
}

function ResultCard() {
  const s = S();
  const r = s.ev!.result!;
  const ok = useRef<HTMLButtonElement>(null);
  const bg = useOnScreen();
  // only confirms what already happened, so Enter may close it; not while a cutscene (a farewell card for a player this
  // choice let go) is over it, whose layer takes the keys
  useEffect(() => { if (!s.cutscenes.length) ok.current?.focus({ preventScroll: true }); }, []);
  const done = () => {
    s.ev!.result = undefined;
    autosave();
    store.bump();
    if (r.open) store.open("nego", r.open.pid, r.open.mode);
  };
  const cut = r.title.indexOf(" — ");
  const evTitle = cut >= 0 ? r.title.slice(0, cut) : "";
  const choice = cut >= 0 ? r.title.slice(cut + 3) : r.title;
  const rows = r.lines.map(parseLine);
  const good = rows.filter((x) => x.good === true).length;
  const bad = rows.filter((x) => x.good === false).length;
  const tone = good > bad ? "good" : bad > good ? "bad" : "mixed";
  return (
    <div class="evd-bg" ref={bg} onClick={(e) => { if (e.target === e.currentTarget) done(); }}>
      <div class={`evd evd-res frame ${tone}`} role="dialog" aria-modal="true" aria-labelledby="evd-res-title">
        <div class="evd-res-head">
          <div class="evd-res-kicker">{evTitle ? `${evTitle} · 결과` : "결과"}</div>
          <h1 id="evd-res-title" class="evd-res-choice"><span class="evd-cur on" aria-hidden="true">▶</span>{choice}</h1>
        </div>
        <ul class="evd-ledger">
          {rows.map((x, i) => (
            <li class={x.val ? "" : "plain"} style={{ "--i": i } as Record<string, number>}>
              <span class="evd-led-text">{x.text}{x.extra && <span class="evd-led-extra"> {x.extra}</span>}</span>
              {x.val && <span class={`evd-delta ${x.good ? "up" : "down"}`}>{x.val}</span>}
            </li>
          ))}
        </ul>
        <div class="evd-res-foot">
          <button ref={ok} class="btn primary" onClick={done}>{r.open ? "확인 (재계약 협상으로)" : "확인"}</button>
        </div>
      </div>
    </div>
  );
}

/** Pixel confetti / fireworks on a canvas behind the cutscene text. */
function Sparks({ colors, fireworks }: { colors: string[]; fireworks: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const W = (cv.width = 320), H = (cv.height = 180);
    const g = cv.getContext("2d")!;
    type P = { x: number; y: number; vx: number; vy: number; c: string; life: number };
    const ps: P[] = [];
    let raf = 0;
    let t = 0;
    const tick = () => {
      t++;
      if (fireworks && t % 28 === 1) {
        const cx = 40 + Math.random() * (W - 80), cy = 30 + Math.random() * 70;
        const c = colors[Math.floor(Math.random() * colors.length)];
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2, sp = 0.8 + Math.random() * 1.6;
          ps.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, c, life: 60 + Math.random() * 30 });
        }
      }
      if (!fireworks && t % 2 === 0) {
        for (let i = 0; i < 3; i++) ps.push({ x: Math.random() * W, y: -2, vx: (Math.random() - 0.5) * 0.6, vy: 0.6 + Math.random() * 1.2, c: colors[Math.floor(Math.random() * colors.length)], life: 200 });
      }
      g.clearRect(0, 0, W, H);
      for (const p of ps) {
        p.x += p.vx; p.y += p.vy; p.vy += fireworks ? 0.025 : 0.005; p.life--;
        g.fillStyle = p.c;
        g.globalAlpha = Math.max(0, Math.min(1, p.life / 30));
        g.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
      }
      g.globalAlpha = 1;
      for (let i = ps.length - 1; i >= 0; i--) if (ps[i].life <= 0 || ps[i].y > H + 4) ps.splice(i, 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} class="px" />;
}

export function CutsceneLayer() {
  const st = useStore();
  const s = st.s;
  if (!s || !s.cutscenes.length || st.screen.name === "series") return null;
  const c = s.cutscenes[0];
  const t = c.team ? s.teams[c.team] : s.teams[s.user];
  const p = c.player ? s.players[c.player] : null;
  const next = () => {
    s.cutscenes.shift();
    autosave();
    store.bump();
  };
  // a player leaving the club: its own card (ui/Farewell.tsx), keyed so each one starts its entrance over
  if (c.kind === "farewell") {
    if (c.farewell && p) return <FarewellCard key={s.cutscenes.length + p.id} c={c} next={next} />;
    // nothing to show (a broken entry): skip it once rather than fall into the welcome layout
    queueMicrotask(() => { if (s.cutscenes[0] === c) next(); });
    return null;
  }
  const c1 = t.colors[0] === "#000000" ? "#f2c14e" : t.colors[0];
  return (
    <div class="cut" style={{ "--c1": c1, "--c2": t.colors[1] } as Record<string, string>} onClick={next}>
      <div class="stripes" />
      <div class="bg" />
      <Sparks colors={[c1, "#ffffff", "#f2c14e", t.colors[1]]} fireworks={c.kind === "title" || c.kind === "qualify"} />
      <div class="inner">
        {c.kind === "qualify" ? (
          <>
            <div style={{ marginBottom: 8 }}><TrophyArt comp={c.trophy ?? "CUP"} scale={10} /></div>
            <div class="sub" style={{ letterSpacing: 4 }}>LCK REPRESENTATIVE</div>
            <div class="big" style={{ color: "#f2c14e" }}>QUALIFIED</div>
            <div class="big" style={{ fontSize: 30 }}>{c.title}</div>
            <div class="row" style={{ justifyContent: "center", marginTop: 6 }}><TeamLogo id={t.id} size={44} /><b style={{ fontSize: 20 }}>{t.name}</b></div>
            <div class="sub">{c.sub}</div>
            <div class="sub">{c.lines?.join(" · ")}</div>
          </>
        ) : c.kind === "title" ? (
          <>
            <div style={{ marginBottom: 10 }}><TrophyArt comp={c.trophy ?? "PO"} scale={14} /></div>
            <div class="big" style={{ color: "#f2c14e" }}>CHAMPIONS</div>
            <div class="big" style={{ fontSize: 28 }}>{c.title}</div>
            <div class="row" style={{ justifyContent: "center", marginTop: 6 }}><TeamLogo id={t.id} size={40} /><b style={{ fontSize: 18 }}>{t.name}</b></div>
            <div class="sub">{c.sub}</div>
            <div class="sub">{c.lines?.join(" · ")}</div>
          </>
        ) : (
          <>
            <div class="row" style={{ justifyContent: "center" }}><TeamLogo id={t.id} size={44} /><span class="muted" style={{ fontSize: 14 }}>{c.kind === "renew" ? "CONTRACT EXTENSION" : c.kind === "trade" ? "TRADE" : "OFFICIAL"}</span></div>
            <div class="big" style={{ color: c1 }}>{c.kind === "renew" ? "STAY TOGETHER" : c.kind === "trade" ? "NEW FACE" : "WELCOME"}</div>
            {p && (
              <div class="pcard frame" style={{ boxShadow: `0 0 0 2px ${c1}, 0 0 0 4px #000` }}>
                <Avatar pid={p.id} size={120} />
                <div style={{ fontFamily: "Galmuri14", fontSize: 22 }}>{p.name}</div>
                <div class="muted">{p.realName}</div>
                <div><Ovr v={ovr(p)} /> {ROLE_KO[p.role]}</div>
              </div>
            )}
            <div class="sub">{c.title}</div>
            <div class="sub">{c.sub}</div>
          </>
        )}
      </div>
      <div class="hint">클릭해서 계속</div>
    </div>
  );
}

/** Trade offers and transfer bids: a big pop-up so they are not missed. One at a time. */
export function AlertLayer() {
  const s = S();
  const alerts = s.alerts ?? [];
  if (!alerts.length) return null;
  const a = alerts[0];
  const drop = () => {
    s.alerts = (s.alerts ?? []).filter((x) => x.id !== a.id);
    autosave();
    store.bump();
  };
  const trade = a.kind === "trade" ? s.tradeOffers.find((o) => o.id === a.ref) : undefined;
  const sale = a.kind === "sale" ? s.saleOffers.find((o) => o.id === a.ref) : undefined;
  // the offer expired or was already answered elsewhere
  if ((a.kind === "trade" && !trade) || (a.kind === "sale" && !sale)) {
    queueMicrotask(drop);
    return null;
  }
  const from = trade?.from ?? sale?.team;
  const side = (ids: string[], label: string) => (
    <div class="col center" style={{ gap: 4 }}>
      <span class="muted" style={{ fontSize: 12 }}>{label}</span>
      {ids.map((id) => s.players[id]).filter(Boolean).map((p) => (
        <div class="col center" style={{ gap: 0 }}>
          <Avatar pid={p.id} size={64} />
          <b>{p.name}</b>
          <span><Ovr v={ovr(p)} /> {ROLE_KO[p.role]}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div class="alert-bg">
      <div class="alert-card frame">
        <div class="alert-kicker">{a.kind === "trade" ? "TRADE OFFER" : a.kind === "sale" ? "TRANSFER BID" : "NOTICE"}</div>
        <div class="row" style={{ justifyContent: "center", gap: 10 }}>
          {from && <TeamLogo id={from} size={56} />}
          <h1 style={{ margin: 0 }}>{a.title}</h1>
        </div>
        <div class="muted" style={{ margin: "6px 0 12px" }}>{a.body}</div>
        {trade && (
          <div class="row" style={{ justifyContent: "center", gap: 36 }}>
            {side(trade.give, "받는 선수")}
            <div style={{ fontFamily: "Galmuri14", fontSize: 30 }}>⇄</div>
            {side(trade.want, "보내는 선수")}
          </div>
        )}
        {sale && <div class="row" style={{ justifyContent: "center" }}>{side([sale.player], "팔 선수")}</div>}
        {a.kind === "info" ? (
          // a plain notice (e.g. payday will put cash below zero)
          <div class="row" style={{ justifyContent: "center", marginTop: 14 }}>
            <button class="btn primary" onClick={drop}>확인</button>
            <button class="btn" onClick={() => { drop(); store.go("finance"); }}>재정 화면</button>
          </div>
        ) : <div class="row" style={{ justifyContent: "center", marginTop: 14 }}>
          {trade && <button class="btn primary" onClick={() => { const ok = acceptTradeOffer(s, trade); store.say(ok ? "트레이드 성사" : "조건이 바뀌어 무산됐습니다"); drop(); }}>수락</button>}
          {sale && <button class="btn primary" onClick={() => { acceptSale(s, sale.id); store.say("판매 완료"); drop(); }}>판매</button>}
          <button class="btn danger" onClick={() => {
            if (trade) s.tradeOffers = s.tradeOffers.filter((o) => o !== trade);
            if (sale) s.saleOffers = s.saleOffers.filter((o) => o !== sale);
            drop();
          }}>거절</button>
          <button class="btn" onClick={() => { drop(); store.go("market", "offers"); }}>나중에 (이적시장에서 보기)</button>
        </div>}
        {alerts.length > 1 && <div class="dim" style={{ fontSize: 11, marginTop: 8 }}>다음 알림 {alerts.length - 1}건</div>}
      </div>
    </div>
  );
}
