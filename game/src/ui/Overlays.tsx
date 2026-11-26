import { useEffect, useRef } from "preact/hooks";
import { S, store, useStore } from "../store";
import { resolveEvent } from "../core/game";
import { acceptSale, acceptTradeOffer } from "../core/market";
import { ovr } from "../core/player";
import { Avatar, Modal, Ovr, TeamLogo, TrophyArt } from "./components";
import { autosave } from "./App";
import { ROLE_KO } from "../data/types";
import "./alerts.css";

export function EventModal() {
  const s = S();
  const ev = s.events[0];
  if (!ev) return null;
  const p = ev.player ? s.players[ev.player] : null;
  return (
    <Modal onClose={() => {}}>
      <h2>{ev.title}</h2>
      <div class="row" style={{ alignItems: "flex-start", gap: 14 }}>
        {p && <div class="col center"><Avatar pid={p.id} size={72} /><b>{p.name}</b><Ovr v={ovr(p)} /><span class="muted">사기 {Math.round(p.morale)}</span></div>}
        <div style={{ flex: 1 }}>
          <div class="speech">{ev.body}</div>
          {ev.options.map((o, i) => (
            <button class="btn qbtn" onClick={() => { resolveEvent(s, ev.id, i); autosave(); store.bump(); }}>
              <b>{o.label}</b> <span class="muted">— {o.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
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
        <div class="row" style={{ justifyContent: "center", marginTop: 14 }}>
          {trade && <button class="btn primary" onClick={() => { const ok = acceptTradeOffer(s, trade); store.say(ok ? "트레이드 성사" : "조건이 바뀌어 무산됐습니다"); drop(); }}>수락</button>}
          {sale && <button class="btn primary" onClick={() => { acceptSale(s, sale.id); store.say("판매 완료"); drop(); }}>판매</button>}
          <button class="btn danger" onClick={() => {
            if (trade) s.tradeOffers = s.tradeOffers.filter((o) => o !== trade);
            if (sale) s.saleOffers = s.saleOffers.filter((o) => o !== sale);
            drop();
          }}>거절</button>
          <button class="btn" onClick={() => { drop(); store.go("market", "offers"); }}>나중에 (이적시장에서 보기)</button>
        </div>
        {alerts.length > 1 && <div class="dim" style={{ fontSize: 11, marginTop: 8 }}>다음 알림 {alerts.length - 1}건</div>}
      </div>
    </div>
  );
}
