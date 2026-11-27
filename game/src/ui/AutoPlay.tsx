// Auto-advance: days pass one at a time on a timer. It waits while an event, alert, cutscene or the day's match
// needs the player and goes on by itself once that is handled. It ends at the chosen target, on a notice the
// player must not walk past (core/game.ts autoHalt), or when stopped.
import { useEffect, useRef, useState } from "preact/hooks";
import { store, useStore } from "../store";
import { autoDone, autoMark, autoStep, autoTargetInfo, userSeriesToday } from "../core/game";
import type { AutoHalt, AutoMark, AutoTarget } from "../core/game";
import type { GameState } from "../core/types";
import { fmtDate } from "../core/format";
import { autosave } from "./App";
import { tutorialHolds } from "./Tutorial";
import "./autoplay.css";

const TARGETS: AutoTarget[] = ["free", "match", "window", "phase"];
/** Milliseconds per day (×1, ×2): slow enough to read what each day brought. */
const SPEED = [900, 450];
/** Screens a day may pass on. Anything else (the match, the code match) waits until the player leaves it. */
const CALM = new Set(["home", "schedule", "meta", "roster", "market", "trade", "teams", "staff", "finance", "news", "trophies", "settings"]);

type Wait = "event" | "alert" | "cutscene" | "modal" | "tutorial" | "match" | "screen" | "hidden";
const WAIT_TEXT: Record<Wait, string> = {
  event: "이벤트에서 고르면 이어서 진행합니다",
  alert: "알림을 처리하면 이어서 진행합니다",
  cutscene: "연출을 넘기면 이어서 진행합니다",
  modal: "열린 창을 닫으면 이어서 진행합니다",
  tutorial: "안내를 닫으면 이어서 진행합니다",
  match: "오늘 경기를 마치면 이어서 진행합니다",
  screen: "이 화면에서 나가면 이어서 진행합니다",
  hidden: "게임 창이 가려져 있어 기다립니다",
};
const WAIT_SHORT: Record<Wait, string> = {
  event: "이벤트 대기", alert: "알림 대기", cutscene: "연출 대기", modal: "창 닫으면 계속",
  tutorial: "안내 대기", match: "경기 후 계속", screen: "화면 나가면 계속", hidden: "대기",
};
/** Where to look after a halt. */
const HALT_GO: Partial<Record<AutoHalt["kind"], [string, string, string?]>> = {
  payday: ["재정 화면", "finance"],
  debt: ["재정 화면", "finance"],
  contract: ["선수단", "roster"],
  offer: ["받은 제안", "market", "offers"],
  bid: ["이적시장", "market"],
  season: ["홈 알림", "home"],
};

interface LogLine { day: number; text: string; mine: boolean; more: number }
interface End { kind: "halt" | "done"; text: string; halt?: AutoHalt["kind"] }

function loadPrefs(): { target: AutoTarget; fast: boolean } {
  try {
    const o = JSON.parse(localStorage.getItem("lck.auto") ?? "{}");
    return { target: TARGETS.includes(o.target) ? o.target : "free", fast: !!o.fast };
  } catch {
    return { target: "free", fast: false };
  }
}
function savePrefs() {
  try {
    localStorage.setItem("lck.auto", JSON.stringify({ target: auto.target, fast: auto.fast }));
  } catch { /* private mode: the choice just is not kept */ }
}

const prefs = loadPrefs();
/** The run (one at a time). The topbar and the feed read it on every store bump. */
export const auto = {
  on: false,
  target: prefs.target,
  fast: prefs.fast,
  from: null as AutoMark | null,
  wait: null as Wait | null,
  end: null as End | null,
  log: [] as LogLine[],
  /** The series the run already took the player to: they may step out of it, and are not pulled back. */
  ledTo: null as string | null,
  /** The save the run belongs to: loading another one (or going back to the title) ends it. */
  save: null as GameState | null,
};
let timer: number | undefined;
// dev hot reload: the old copy of this module must not keep advancing days
import.meta.hot?.dispose(() => clearTimeout(timer));

export function startAuto(target: AutoTarget) {
  const s = store.s;
  if (!s || s.over) return;
  Object.assign(auto, { on: true, target, from: autoMark(s), wait: null, end: null, log: [], ledTo: null, save: s });
  savePrefs();
  schedule(150);
  store.bump();
}

export function stopAuto() {
  clearTimeout(timer);
  timer = undefined;
  if (!auto.on) return;
  auto.on = false;
  auto.wait = null;
  store.bump();
}

function finish(e: End) {
  auto.end = e;
  stopAuto();
  // an arrival fades by itself; a halt stays until closed
  if (e.kind === "done") setTimeout(() => { if (auto.end === e) { auto.end = null; store.bump(); } }, 7000);
}

function schedule(ms: number) {
  clearTimeout(timer);
  timer = window.setTimeout(tick, ms);
}

/** What the player has to deal with before another day can pass (null: nothing). */
function waitingFor(s: GameState): Wait | null {
  const scr = store.screen.name;
  if (scr === "series" && userSeriesToday(s)) return "match";
  if (!CALM.has(scr)) return "screen";
  // the same order App shows them in
  if (s.events.length || s.ev?.result?.title) return "event";
  if (s.alerts?.length) return "alert";
  if (s.cutscenes.length) return "cutscene";
  if (store.modal) return "modal";
  // a tour step that waits for the player to act (e.g. "go to the match") is left on screen: the run gets there
  if (tutorialHolds()) return "tutorial";
  if (document.hidden) return "hidden";
  return null;
}

function hold(w: Wait) {
  if (auto.wait !== w) {
    auto.wait = w;
    store.bump();
  }
  schedule(250);
}

function tick() {
  timer = undefined;
  if (!auto.on) return;
  const s = store.s, data = store.data;
  if (!s || !data || s !== auto.save) return stopAuto();
  if (s.over) return finish({ kind: "halt", halt: "over", text: "게임 오버" });
  const w = waitingFor(s);
  const sr = userSeriesToday(s);
  if (sr) {
    // match day: events of the morning first, then the match (taken there once: the player may step out)
    if (w && w !== "match") return hold(w);
    const done = autoDone(s, auto.target, auto.from!);
    if (done) {
      finish({ kind: "done", text: done });
      if (store.screen.name !== "series") store.go("series");
      return;
    }
    if (auto.ledTo !== sr.id) {
      auto.ledTo = sr.id;
      store.go("series");
    }
    return hold("match");
  }
  if (w) return hold(w);
  if (auto.wait) {
    // just handled: let the player see where things stand for a moment before the next day
    auto.wait = null;
    store.bump();
    return schedule(delay());
  }
  const day = s.day, news = s.news[0]?.id, mail = s.inbox[0]?.id;
  const { halt } = autoStep(s, data);
  note(s, day, news, mail);
  autosave();
  if (halt) return finish({ kind: "halt", halt: halt.kind, text: halt.text });
  // the match target ends on the match day itself, above (after the morning's events)
  const done = auto.target === "match" ? null : autoDone(s, auto.target, auto.from!);
  if (done) return finish({ kind: "done", text: done });
  store.bump();
  schedule(delay());
}

function delay() {
  return SPEED[auto.fast ? 1 : 0];
}

/** One line for the day that just passed: a notice for us first, then our news, the day's results, the league's news. */
function note(s: GameState, day: number, newsTop: string | undefined, mailTop: string | undefined) {
  const mail: string[] = [];
  for (const m of s.inbox) { if (m.id === mailTop || m.day < day) break; mail.push(m.text); }
  const mine: string[] = [], other: string[] = [];
  for (const n of s.news) { if (n.id === newsTop || n.day < day) break; (n.mine ? mine : other).push(n.title); }
  const games = s.series.filter((x) => x.day === day && x.done && x.a && x.b);
  const results = games.length ? [games.map((x) => `${s.teams[x.a!].short} ${x.wa}:${x.wb} ${s.teams[x.b!].short}`).join(" · ")] : [];
  const all = [...mail, ...mine, ...results, ...other];
  auto.log.unshift({ day, text: all[0] ?? "조용한 하루", mine: mail.length + mine.length > 0, more: Math.max(0, all.length - 1) });
  if (auto.log.length > 5) auto.log.length = 5;
}

/** Topbar: start (with the target menu) or, while running, what it is heading for and the stop button. */
export function AutoControls() {
  const st = useStore();
  const s = st.s!;
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    addEventListener("pointerdown", off, true);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", off, true); removeEventListener("keydown", esc); };
  }, [menu]);
  if (auto.on) {
    const info = autoTargetInfo(s, auto.target);
    const left = info.day !== null ? info.day - s.day : 0;
    return (
      <div class="auto-ctl">
        <div class="stat auto-stat" title={auto.wait ? WAIT_TEXT[auto.wait] : `하루씩 넘기는 중 (${delay() / 1000}초에 하루)`}>
          <span>자동 진행 · {info.label}{left > 0 ? ` D-${left}` : ""}</span>
          {auto.wait ? <b class="hold">{WAIT_SHORT[auto.wait]}</b> : <b class="run"><i class="auto-dot" />진행 중</b>}
        </div>
        <button class="btn small" title="하루 넘기는 간격" onClick={() => { auto.fast = !auto.fast; savePrefs(); store.bump(); }}>{auto.fast ? "×2" : "×1"}</button>
        <button class="btn danger" onClick={stopAuto}>■ 멈춤</button>
      </div>
    );
  }
  const cur = autoTargetInfo(s, auto.target);
  return (
    <div class="auto-ctl" ref={box}>
      <button class="btn auto-go" onClick={() => { setMenu(false); startAuto(auto.target); }} title={`목표: ${cur.label}. 이벤트와 경기에서 기다렸다가, 처리하면 이어서 갑니다.`}>
        자동 진행 ▶▶
      </button>
      <button class={`btn auto-pick ${menu ? "on" : ""}`} onClick={() => setMenu(!menu)} title="자동 진행 목표 고르기">▾</button>
      {menu && (
        <div class="auto-menu frame">
          <div class="auto-menu-h">어디까지 진행할까요?</div>
          {TARGETS.map((t) => {
            const i = autoTargetInfo(s, t);
            const left = i.day !== null ? i.day - s.day : null;
            const when = t === "free" ? "멈춤 버튼을 누를 때까지" : i.day === null ? "남은 일정 없음" : left! <= 0 ? "오늘" : `${fmtDate(i.day, false)} · ${left}일 뒤`;
            return (
              <button class={`auto-opt ${t === auto.target ? "on" : ""}`} disabled={t !== "free" && i.day === null} onClick={() => { setMenu(false); startAuto(t); }}>
                <b>{i.label}</b>
                <span class="muted">{when}</span>
              </button>
            );
          })}
          <div class="auto-menu-f">
            이벤트 · 제안 · 경기에서는 기다렸다가 처리하면 이어서 갑니다. 급여일 자금 부족, 계약 만료, 제안 · 입찰 마감, 시즌 종료 알림에서는 멈춥니다.
          </div>
        </div>
      )}
    </div>
  );
}

/** Bottom right while running: the days going by, what it waits for, and why it ended. */
export function AutoFeed() {
  const st = useStore();
  const s = st.s;
  if (!s || s.over || (!auto.on && !auto.end) || !CALM.has(st.screen.name)) return null;
  const info = autoTargetInfo(s, auto.target);
  const end = auto.end;
  const go = end?.halt ? HALT_GO[end.halt] : undefined;
  const close = () => { auto.end = null; store.bump(); };
  return (
    <div class="auto-feed frame">
      <div class="auto-head">
        <b>자동 진행</b>
        <span class="muted">{auto.on ? `목표: ${info.label}` : end?.kind === "halt" ? "멈춤" : "도착"}</span>
        <span class="grow" />
        {!auto.on && <button class="btn small" onClick={close}>닫기</button>}
      </div>
      {end && (
        <div class={`auto-end ${end.kind}`}>
          <div>{end.text}</div>
          {go && <button class="btn small" onClick={() => { close(); store.go(go[1], go[2]); }}>{go[0]}</button>}
        </div>
      )}
      {auto.on && auto.wait && <div class="auto-wait">{WAIT_TEXT[auto.wait]}</div>}
      {auto.log.map((l, i) => (
        <div key={l.day} class={`auto-line ${l.mine ? "mine" : ""} ${i === 0 && auto.on ? "new" : ""}`} title={l.text}>
          <span class="dim">{fmtDate(l.day, false)}</span> <span class="t">{l.text}</span>
          {l.more > 0 && <span class="dim"> 외 {l.more}</span>}
        </div>
      ))}
    </div>
  );
}
