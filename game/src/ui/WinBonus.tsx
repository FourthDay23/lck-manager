// 승리 수당 on screen: what a series pays before it is settled, the "+n" chip under the top bar's cash once it is
// paid, and the season's list on the finance screen. Amounts come from core/economy.ts (the same function pays them).
import { S, store } from "../store";
import { fmtDate, money, monthKey } from "../core/format";
import { comp } from "../core/schedule";
import { stageName } from "../core/game";
import { seriesWinBonus, winBonusLog, winBonusRule } from "../core/economy";
import type { GameState, Series } from "../core/types";
import { COMP_NAME } from "../core/types";
import type { Engine } from "../match/engine";
import type { SeriesInfo } from "./Scorebar";
import "./winbonus.css";

export interface PayLine { label: string; amount: number; note?: string }

// ---------- what a finished series will pay (shown before 마치고 돌아가기 settles it) ----------
/** Mirrors finishSeries: the win bonus, and the final's prize money (completeComp, champion and runner-up). */
export function seriesPayout(s: GameState, sr: Series): PayLine[] {
  const won = (sr.wa > sr.wb ? sr.a : sr.b) === s.user;
  const out: PayLine[] = [];
  if (won) out.push({ label: "승리 수당", amount: seriesWinBonus(sr), note: `${winBonusRule(sr)} · 시리즈를 이길 때 한 번` });
  if (sr.stage === "F") {
    const c = comp(s, sr.comp, sr.season);
    const prize = c && !c.done ? c.prize[won ? 0 : 1] ?? 0 : 0;
    if (prize) out.push({ label: won ? "우승 상금" : "준우승 상금", amount: prize, note: c!.name });
  }
  return out;
}

export function SeriesPayout({ sr }: { sr: Series }) {
  const s = S();
  const won = (sr.wa > sr.wb ? sr.a : sr.b) === s.user;
  const lines = seriesPayout(s, sr);
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const cash = s.teams[s.user].cash;
  return (
    <div class={`payout ${won ? "win" : "lose"}`}>
      {lines.map((l) => (
        <div class="payout-line">
          <div class="payout-label">{l.label}{l.note && <small>{l.note}</small>}</div>
          <b class="payout-amt">+{money(l.amount)}</b>
        </div>
      ))}
      {!won && <div class="payout-line none"><div class="payout-label">승리 수당 없음<small>이겼다면 +{money(seriesWinBonus(sr))}</small></div></div>}
      {total > 0 && <div class="payout-foot">마치고 돌아가면 자금 {moneyExact(cash)} → <b class="gold">{moneyExact(cash + total)}</b></div>}
    </div>
  );
}

/**
 * Cash to the 만원, e.g. "43억 4,212만": money() rounds 10억+ to 0.1억, so a 400만 bonus would not show in it.
 * Used for the top bar's cash tooltip and the payout box.
 */
export function moneyExact(v: number): string {
  const a = Math.abs(Math.round(v));
  const eok = Math.floor(a / 10000), man = a % 10000;
  const body = eok ? `${eok.toLocaleString("ko-KR")}억${man ? ` ${man.toLocaleString("ko-KR")}만` : ""}` : `${man.toLocaleString("ko-KR")}만`;
  return `${v < 0 ? "-" : ""}${body}`;
}

/** One line for the set-up panel: what winning this series pays, and that single games pay nothing. */
export function WinStake({ sr }: { sr: Series }) {
  return (
    <div class="win-stake">
      이 시리즈를 이기면 승리 수당 <b class="gold">{money(seriesWinBonus(sr))}</b>
      <span class="dim"> · {winBonusRule(sr)} · 세트 승리에는 따로 나오지 않습니다</span>
    </div>
  );
}

/** End-of-game screen: a won game that takes the series shows the bonus; one that does not says what is left. */
export function MatchStake({ e, userSide, series, bonus }: { e: Engine; userSide: 0 | 1; series?: SeriesInfo; bonus?: number }) {
  const s = S();
  if (!bonus || !series || e.winner !== userSide) return null;
  const i = series.teams.indexOf(s.user);
  if (i < 0) return null;
  // series.wins is the score before this game (the game is recorded on 결과 확인)
  const left = Math.ceil(series.bo / 2) - (series.wins[i] + 1);
  if (left <= 0) return <div class="match-stake won">시리즈 승리 · 승리 수당 <b>+{money(bonus)}</b></div>;
  return <div class="match-stake">시리즈 승리까지 {left}세트 · 이기면 승리 수당 <b class="gold" style={{ fontSize: 16 }}>{money(bonus)}</b></div>;
}

// ---------- the "+n" chip under the top bar's cash ----------
let gain: { id: number; lines: PayLine[] } | null = null;
let gainSeq = 0;

/** This month's income by ledger key, read without creating the month (core/ledger.ts ledger() would). */
export function incomeNow(s: GameState): Record<string, number> {
  return { ...(s.ledger.find((x) => x.month === monthKey(s.day))?.income ?? {}) };
}

/** Shows what came in since `before` (incomeNow taken before a settlement) under the top bar's cash. */
export function showIncomeSince(s: GameState, before: Record<string, number>) {
  const now = incomeNow(s);
  const lines = Object.entries(now)
    .map(([label, v]) => ({ label, amount: v - (before[label] ?? 0) }))
    .filter((l) => l.amount > 0)
    .sort((a, b) => (a.label === "승리 수당" ? -1 : b.label === "승리 수당" ? 1 : b.amount - a.amount));
  if (!lines.length) return;
  const id = ++gainSeq;
  gain = { id, lines };
  store.bump();
  setTimeout(() => {
    if (gain?.id !== id) return;
    gain = null;
    store.bump();
  }, 6500);
}

export function CashGain() {
  if (!gain || !store.s) return null;
  const total = gain.lines.reduce((a, l) => a + l.amount, 0);
  return (
    <div class="cash-gain" key={gain.id} onClick={() => { gain = null; store.bump(); }}>
      <b class="cash-gain-total">+{money(total)}</b>
      {gain.lines.map((l) => <div class="cash-gain-line"><i>{l.label}</i> +{money(l.amount)}</div>)}
      <div class="cash-gain-line cash-gain-now"><i>자금</i> {moneyExact(store.s.teams[store.s.user].cash)}</div>
    </div>
  );
}

export function cashGainOn(): boolean {
  return !!gain;
}

// ---------- finance screen ----------
const RULES = [
  ["정규·스위스 라운드", money(400)],
  ["플레이오프·토너먼트", money(1200)],
  ["국제 대회 (MSI·EWC·월즈)", "×2"],
] as const;

export function WinBonusPanel() {
  const s = S();
  const log = winBonusLog(s);
  const total = log.reduce((a, x) => a + x.amount, 0);
  const month = s.ledger.find((x) => x.month === monthKey(s.day))?.income["승리 수당"] ?? 0;
  return (
    <div class="frame pad winbonus-panel">
      <div class="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2>승리 수당</h2>
        <div class="row" style={{ gap: 16 }}>
          <span>{s.season} 시즌 <b class={total ? "pos" : "muted"}>{total ? `+${money(total)}` : "0"}</b> <span class="muted">(시리즈 {log.length}승)</span></span>
          <span>이번 달 <b class={month ? "pos" : "muted"}>{month ? `+${money(month)}` : "0"}</b></span>
        </div>
      </div>
      <div class="row wb-rules">
        {RULES.map(([k, v]) => <span class="tag">{k} <b class="gold">{v}</b></span>)}
        <span class="muted" style={{ fontSize: 11 }}>시리즈를 이기면 그날 바로 들어오고, 세트 승리에는 따로 나오지 않습니다.</span>
      </div>
      {log.length ? (
        <div class="wb-list">
          <table class="t">
            <thead><tr><th>날짜</th><th>대회</th><th>상대</th><th class="num">스코어</th><th class="num">승리 수당</th></tr></thead>
            <tbody>
              {log.map(({ sr, amount }) => {
                const opp = sr.a === s.user ? sr.b! : sr.a!;
                const mine = sr.a === s.user ? sr.wa : sr.wb;
                const theirs = sr.a === s.user ? sr.wb : sr.wa;
                return (
                  <tr>
                    <td class="muted">{fmtDate(sr.day, false)}</td>
                    <td>{COMP_NAME[sr.comp]} · {stageName(sr.stage)}</td>
                    <td>{s.teams[opp]?.name ?? opp}</td>
                    <td class="num">{mine}:{theirs}</td>
                    <td class="num pos">+{money(amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div class="muted">이번 시즌에는 아직 이긴 시리즈가 없습니다.</div>}
    </div>
  );
}
