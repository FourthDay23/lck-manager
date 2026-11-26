import { useState } from "preact/hooks";
import { store, D } from "../../store";
import { migrateSave, newGame } from "../../core/game";
import { inbox } from "../../core/news";
import type { Difficulty } from "../../core/types";
import { loadGame, readSaveFile, saveGame, slotMeta } from "../../core/save";
import { money } from "../../core/format";
import { autosave } from "../App";
import { teamDifficulty } from "../../core/player";
import { LogoBox } from "../components";
import { startTutorial } from "../Tutorial";
import "../start.css";

const LEVEL_CLASS = ["", "d1", "d2", "d3", "d4"];

export function StartScreen() {
  const d = D();
  const lck = d.teams.filter((t) => t.tier === 1);
  const [team, setTeam] = useState<string | null>(null);
  const [diff, setDiff] = useState<Difficulty>("normal");
  const [name, setName] = useState("");
  const [slot, setSlot] = useState(() => ([1, 2, 3].find((n) => !slotMeta(n)) ?? 1));
  const sel = team ? lck.find((t) => t.id === team) ?? null : null;
  const startCash = sel ? { easy: 1.4, normal: 1, hard: 0.7 }[diff] * (80000 + sel.wealth * 30000) : 0;
  const saves = [1, 2, 3].map((n) => ({ n, m: slotMeta(n) })).filter((x) => x.m);
  const start = () => {
    if (!sel) return;
    if (slotMeta(slot) && !confirm(`슬롯 ${slot}에 저장된 게임을 새 게임으로 덮어씁니다.`)) return;
    store.slot = slot;
    store.s = newGame(d, { team: sel.id, difficulty: diff, manager: name.trim() || "단장" });
    store.screen = { name: "home" };
    autosave();
    store.bump();
    startTutorial(); // first new game on this browser only
  };
  const load = async (n: number) => {
    const s = await loadGame(n);
    if (!s) return store.say("빈 슬롯입니다");
    for (const note of migrateSave(s, d)) inbox(s, note);
    store.slot = n;
    store.s = s;
    store.screen = { name: "home" };
    store.bump();
  };
  const openFile = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const r = await readSaveFile(f);
    if ("error" in r) return store.say(r.error);
    for (const note of migrateSave(r.s, d)) inbox(r.s, note);
    store.slot = slot;
    store.s = r.s;
    await saveGame(r.s, slot);
    store.screen = { name: "home" };
    store.bump();
  };
  return (
    <div class="start">
      <div class="center" style={{ marginBottom: 14 }}>
        <div class="title-logo">LCK MANAGER</div>
        <div class="muted">나만의 LOL 프로게임단 육성하기</div>
      </div>
      <div class="start-tools">
        {saves.map(({ n, m }) => (
          <button class="btn small" onClick={() => load(n)} title={`슬롯 ${n}`}>이어하기 · {m!.label}</button>
        ))}
        <label class="btn small" style={{ cursor: "pointer" }}>
          세이브 파일 열기
          <input type="file" accept=".lckm,text/plain" style={{ display: "none" }} onChange={openFile} />
        </label>
        <button class="btn small" onClick={() => store.go("exhibition")}>코드 대전</button>
      </div>
      <div class={`start-body ${sel ? "picked" : ""}`}>
        <div class="frame pad">
          <h2 class="start-title">구단을 선택하세요</h2>
          <div class="muted start-sub">새로운 역사를 써내려갈 당신의 팀을 골라주세요</div>
          <div class="team-grid">
            {lck.map((t) => {
              const df = teamDifficulty(t);
              return (
                <div class={`tcard frame dark ${team === t.id ? "sel" : ""}`} onClick={() => setTeam(t.id)}>
                  <LogoBox logo={t.logo} colors={t.colors} short={t.short} size={46} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{t.name}</b>
                    <div class="muted" style={{ fontSize: 11 }}>자금력 {"■".repeat(t.wealth)}{"□".repeat(5 - t.wealth)} · LCK 우승 {t.titles.lck} · 월즈 {t.titles.worlds}</div>
                    <div style={{ marginTop: 3 }} title={df.why}>
                      <span class={`diff-badge ${LEVEL_CLASS[df.level]}`}>난이도 {"★".repeat(df.level)}{"☆".repeat(4 - df.level)} {df.label}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div class="dim center" style={{ fontSize: 11, marginTop: 8 }}>
            난이도에 따라 자금력과 선수들의 구단 선호도가 다릅니다.
            <br />
            Faker(T1), ShowMaker(DK) 선수는 각 구단에 고정됩니다.
          </div>
        </div>
        {sel && (
          <div class="frame pad newgame">
            <div class="row" style={{ gap: 10 }}>
              <LogoBox logo={sel.logo} colors={sel.colors} short={sel.short} size={56} />
              <div>
                <h2 style={{ margin: 0 }}>{sel.name}</h2>
                <span class={`diff-badge ${LEVEL_CLASS[teamDifficulty(sel).level]}`}>난이도 {teamDifficulty(sel).label}</span>
                <div class="muted" style={{ fontSize: 11 }}>{teamDifficulty(sel).why}</div>
              </div>
            </div>
            <h3 style={{ marginTop: 12 }}>새 게임</h3>
            <div class="col">
              <label class="muted">단장 이름</label>
              <input type="text" value={name} placeholder="단장" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
              <label class="muted">게임 난이도</label>
              <div class="row">
                {(["easy", "normal", "hard"] as Difficulty[]).map((x) => (
                  <button class={`btn small ${diff === x ? "on" : ""}`} onClick={() => setDiff(x)}>{x === "easy" ? "쉬움" : x === "normal" ? "보통" : "어려움"}</button>
                ))}
              </div>
              <div class="muted" style={{ fontSize: 11 }}>
                {diff === "hard" ? "수입 ×0.8, 시작 자금 ×0.7, 선수 요구 연봉 +8%, AI 전력 보정 +1.5" : diff === "easy" ? "수입 ×1.25, 시작 자금 ×1.4, 요구 연봉 -8%" : "기본 수입. 스폰서만으로는 주전 다섯 명 연봉을 다 감당하기 어렵습니다."}
              </div>
              <label class="muted">저장 슬롯</label>
              <div class="row">{[1, 2, 3].map((n) => <button class={`btn small ${slot === n ? "on" : ""}`} onClick={() => setSlot(n)}>{n}{slotMeta(n) ? " (사용 중)" : ""}</button>)}</div>
              <div class="muted" style={{ fontSize: 11, marginTop: 4 }}>시작 조건: Faker(T1), ShowMaker(Dplus Kia)를 뺀 모든 선수와 감독이 FA입니다. 1월 14일 LCK 컵 개막 전까지 로스터를 꾸려야 합니다.</div>
              <div class="sp" />
              <div>시작 자금 <b class="gold">{money(Math.round(startCash))}</b></div>
              <button class="btn primary" onClick={start}>이 팀으로 시작</button>
            </div>
          </div>
        )}
      </div>
      {typeof location !== "undefined" && location.protocol === "http:" && !["localhost", "127.0.0.1"].includes(location.hostname) && (
        <div class="frame pad" style={{ boxShadow: "0 0 0 2px #6e4a14", marginTop: 10 }}>
          <b style={{ color: "var(--warn)" }}>보안 연결(https) 준비 중</b>
          <div class="muted" style={{ fontSize: 12 }}>이 주소는 아직 http입니다. https가 열리면 브라우저가 다른 주소로 보고 여기 저장한 슬롯이 보이지 않습니다. 그때는 저장 · 설정 화면의 "세이브 파일로 내보내기"로 옮기면 됩니다.</div>
        </div>
      )}
      <div class="dim center" style={{ fontSize: 11, padding: 10 }}>
        데이터 출처: Leaguepedia, Riot Data Dragon, CommunityDragon(경기 화면 아이콘). 이 게임은 Riot Games가 보증하거나 후원하지 않습니다. 게임 속 뉴스와 사건은 가상입니다.
        <br />
        © 2026 LCK MANAGER. 구단·대회 명칭과 로고의 권리는 각 권리자에게 있습니다.
      </div>
    </div>
  );
}
